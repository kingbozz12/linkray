import { query } from './db.js';
import {
  answerCallback,
  callbackButton,
  inlineKeyboard,
  sendMaxMessage,
} from './maxClient.js';

const SCAN_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.LR_AF_SCAN_INTERVAL_MS || 5 * 60_000),
);
const CHANNEL_WINDOW_HOURS = Math.max(
  1,
  Number(process.env.LR_AF_CHANNEL_WINDOW_HOURS || 24),
);
const CLICKS_JOIN_GAP_SECONDS = Math.max(
  1,
  Number(process.env.LR_AF_CLICK_JOIN_SECONDS || 2),
);
const MAX_JOINS_PER_SECOND = Math.max(
  1,
  Number(process.env.LR_AF_MAX_JOINS_PER_SECOND || 5),
);
const MAX_JOINS_PER_MINUTE = Math.max(
  1,
  Number(process.env.LR_AF_MAX_JOINS_PER_MINUTE || 50),
);
const SEQUENTIAL_ID_RUN = Math.max(
  3,
  Number(process.env.LR_AF_SEQUENTIAL_ID_RUN || 10),
);
const SEQUENTIAL_WINDOW_MINUTES = Math.max(
  1,
  Number(process.env.LR_AF_SEQUENTIAL_WINDOW_MINUTES || 10),
);
const NIGHT_SURGE_15M = Math.max(
  2,
  Number(process.env.LR_AF_NIGHT_SURGE_15M || 20),
);
const NIGHT_START_HOUR = 1;
const NIGHT_END_HOUR = 5;

const SIGNAL_SCORES = Object.freeze({
  click_join_under_2s: 35,
  sequential_numeric_ids: 45,
  joins_over_5_per_second: 60,
  joins_over_50_per_minute: 70,
  night_surge_without_ad: 35,
});

let schemaPromise = null;
let workerTimer = null;
let workerBusy = false;
let tableCache = new Map();

function rows(result) {
  return Array.isArray(result)
    ? result
    : (result?.rows || []);
}

function clean(value, max = 1000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function int(value, fallback = 0) {
  return Math.round(num(value, fallback));
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(value) {
  return new Intl.NumberFormat('ru-RU').format(int(value));
}

function iso(value) {
  const date = value instanceof Date
    ? value
    : new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : null;
}

function toDate(value, fallback = null) {
  const date = value instanceof Date
    ? value
    : new Date(value);
  return Number.isFinite(date.getTime())
    ? date
    : fallback;
}

function moscowParts(value) {
  const date = toDate(value, new Date());
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    },
  ).formatToParts(date);

  return Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
}

function moscowDate(value) {
  return new Intl.DateTimeFormat(
    'ru-RU',
    {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    },
  ).format(toDate(value, new Date()));
}

function payloadOf(update = {}) {
  return clean(
    update?.callback?.payload ||
    update?.callback?.body?.payload ||
    update?.callback?.button?.payload ||
    update?.callback?.data ||
    update?.callback_payload ||
    update?.message_callback?.payload ||
    update?.payload ||
    update?.data ||
    update?.message?.callback?.payload ||
    '',
    500,
  );
}

function callbackIdOf(update = {}) {
  return clean(
    update?.callback?.callback_id ||
    update?.callback?.callbackId ||
    update?.callback?.id ||
    update?.callback_id ||
    update?.callbackId ||
    update?.message_callback?.callback_id ||
    update?.message?.callback?.callback_id ||
    '',
    300,
  );
}

function chatIdOf(update = {}) {
  return clean(
    update?.message?.recipient?.chat_id ||
    update?.message?.chat_id ||
    update?.chat_id ||
    update?.callback?.message?.recipient?.chat_id ||
    update?.callback?.message?.chat_id ||
    update?.callback?.chat_id ||
    update?.recipient?.chat_id ||
    update?.user?.user_id ||
    update?.callback?.user_id ||
    '',
    100,
  );
}

function userIdOf(update = {}) {
  return clean(
    update?.message?.sender?.user_id ||
    update?.message?.sender?.id ||
    update?.sender?.user_id ||
    update?.sender?.id ||
    update?.callback?.user?.user_id ||
    update?.callback?.user?.id ||
    update?.callback?.sender?.user_id ||
    update?.callback?.sender?.id ||
    update?.user_id ||
    '',
    100,
  );
}

function quoteIdentifier(name) {
  const value = clean(name, 120);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

async function safeQuery(sql, params = []) {
  try {
    return await query(sql, params);
  } catch (error) {
    console.error(
      '[LinkRay AntiFraud query]',
      error?.message || error,
    );
    return { rows: [] };
  }
}

async function tableExists(name) {
  const key = `table:${name}`;
  if (tableCache.has(key)) {
    return tableCache.get(key);
  }

  const result = rows(
    await safeQuery(
      `SELECT to_regclass($1) IS NOT NULL AS exists`,
      [`public.${name}`],
    ),
  )[0];
  const exists = Boolean(result?.exists);
  tableCache.set(key, exists);
  return exists;
}

async function tableColumns(name) {
  const key = `columns:${name}`;
  if (tableCache.has(key)) {
    return tableCache.get(key);
  }

  const values = rows(
    await safeQuery(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name=$1`,
      [name],
    ),
  ).map((row) => String(row.column_name));

  tableCache.set(key, values);
  return values;
}

function firstColumn(columns, candidates) {
  return candidates.find((candidate) => columns.includes(candidate)) || null;
}

async function ensureSchema() {
  if (schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS
      public.lr_antifraud_scans (
        id bigserial PRIMARY KEY,
        channel_id text NOT NULL,
        db_channel_id bigint,
        proof_report_id bigint,
        owner_user_id text,
        mode text NOT NULL DEFAULT 'channel_24h',
        window_from timestamptz NOT NULL,
        window_to timestamptz NOT NULL,
        joined_count integer NOT NULL DEFAULT 0,
        suspicious_join_count integer NOT NULL DEFAULT 0,
        risk_score integer NOT NULL DEFAULT 0,
        risk_level text NOT NULL DEFAULT 'low',
        signal_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
        attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
        evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
      lr_antifraud_scans_channel_idx
      ON public.lr_antifraud_scans (
        channel_id,
        created_at DESC
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
      lr_antifraud_scans_report_idx
      ON public.lr_antifraud_scans (
        proof_report_id,
        created_at DESC
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
      public.lr_antifraud_signals (
        id bigserial PRIMARY KEY,
        scan_id bigint NOT NULL
          REFERENCES public.lr_antifraud_scans(id)
          ON DELETE CASCADE,
        channel_id text NOT NULL,
        proof_report_id bigint,
        signal_type text NOT NULL,
        severity text NOT NULL,
        occurred_at timestamptz NOT NULL,
        score integer NOT NULL DEFAULT 0,
        max_user_id text,
        event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
      lr_antifraud_signals_channel_idx
      ON public.lr_antifraud_signals (
        channel_id,
        occurred_at DESC
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
      lr_antifraud_signals_scan_idx
      ON public.lr_antifraud_signals (
        scan_id,
        signal_type
      )
    `);

    if (await tableExists('lr_channel_member_events')) {
      await query(`
        ALTER TABLE public.lr_channel_member_events
        ADD COLUMN IF NOT EXISTS
          antifraud_score integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS
          antifraud_flags jsonb NOT NULL DEFAULT '[]'::jsonb
      `);
    }

    if (await tableExists('lr_channel_memberships')) {
      await query(`
        ALTER TABLE public.lr_channel_memberships
        ADD COLUMN IF NOT EXISTS
          antifraud_score integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS
          antifraud_flags jsonb NOT NULL DEFAULT '[]'::jsonb
      `);
    }

    tableCache = new Map();
    return true;
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });

  return schemaPromise;
}

async function allActiveChannels() {
  if (!(await tableExists('channels'))) {
    return [];
  }

  return rows(
    await safeQuery(`
      SELECT to_jsonb(c) AS raw
      FROM public.channels c
      WHERE COALESCE(
        (to_jsonb(c)->>'is_active')::boolean,
        true
      ) = true
      ORDER BY c.id
    `),
  ).map(({ raw }) => normalizeChannel(raw));
}

function normalizeChannel(raw = {}) {
  const channelId = clean(
    raw.max_chat_id ||
    raw.channel_id ||
    raw.chat_id ||
    raw.max_channel_id ||
    raw.id,
    120,
  );

  return {
    dbId: int(raw.id, 0),
    channelId,
    title: clean(
      raw.title || raw.name || raw.channel_title || 'Канал MAX',
      160,
    ),
    link: clean(
      raw.link || raw.url || raw.invite_link || '',
      500,
    ),
    ownerUserId: clean(
      raw.owner_user_id ||
      raw.owner_max_user_id ||
      raw.user_id ||
      raw.max_user_id ||
      raw.owner_id ||
      '',
      100,
    ),
    raw,
  };
}

async function channelsForUser(maxUserId) {
  await ensureSchema();
  const userId = clean(maxUserId, 100);
  if (!userId) {
    return [];
  }

  if (
    await tableExists('lr_channel_analytics_daily_channels') &&
    await tableExists('channels')
  ) {
    const result = rows(
      await safeQuery(`
        SELECT to_jsonb(c) AS raw
        FROM public.lr_channel_analytics_daily_channels d
        JOIN public.channels c
          ON c.id=d.channel_id
        WHERE d.owner_chat_id::text=$1
          AND COALESCE(
            (to_jsonb(c)->>'is_active')::boolean,
            true
          )=true
        ORDER BY lower(COALESCE(c.title, '')), c.id
      `, [userId]),
    );

    if (result.length) {
      return result.map(({ raw }) => normalizeChannel(raw));
    }
  }

  if (
    await tableExists('lr_users') &&
    await tableExists('lr_user_channels') &&
    await tableExists('channels')
  ) {
    const result = rows(
      await safeQuery(`
        SELECT to_jsonb(c) AS raw
        FROM public.lr_users u
        JOIN public.lr_user_channels uc
          ON uc.user_id=u.id
        JOIN public.channels c
          ON c.id=uc.channel_id
        WHERE u.max_user_id::text=$1
          AND COALESCE(
            (to_jsonb(uc)->>'is_active')::boolean,
            true
          )=true
          AND COALESCE(
            (to_jsonb(c)->>'is_active')::boolean,
            true
          )=true
        ORDER BY c.id
      `, [userId]),
    );

    if (result.length) {
      return result.map(({ raw }) => normalizeChannel(raw));
    }
  }

  const all = await allActiveChannels();
  return all.filter((channel) => {
    const raw = channel.raw || {};
    return [
      raw.owner_user_id,
      raw.owner_max_user_id,
      raw.user_id,
      raw.max_user_id,
      raw.owner_id,
      raw.created_by,
    ].some((value) => clean(value, 100) === userId);
  });
}

async function channelForUser(maxUserId, dbChannelId) {
  const channels = await channelsForUser(maxUserId);
  return channels.find(
    (channel) => channel.dbId === int(dbChannelId),
  ) || null;
}

function eventIdentity(event = {}) {
  return clean(
    event.max_user_id ||
    event.user_id ||
    event.user_hash ||
    event.id,
    160,
  );
}

function normalizeJoinEvent(raw = {}) {
  const occurredAt = toDate(
    raw.occurred_at || raw.joined_at || raw.created_at,
  );
  if (!occurredAt) {
    return null;
  }

  return {
    id: int(raw.id, 0),
    channelId: clean(raw.channel_id, 120),
    occurredAt,
    maxUserId: clean(raw.max_user_id || raw.user_id || '', 120),
    userHash: clean(raw.user_hash || '', 200),
    displayName: clean(
      raw.display_name || raw.first_name || 'Пользователь MAX',
      160,
    ),
    isBot: Boolean(raw.is_bot),
    raw,
  };
}

async function loadJoinEvents(channel, from, to) {
  if (!(await tableExists('lr_channel_member_events'))) {
    return [];
  }

  const aliases = [
    channel.channelId,
    String(channel.dbId || ''),
    clean(channel.raw?.channel_id, 120),
    clean(channel.raw?.max_chat_id, 120),
  ].filter(Boolean);

  const result = rows(
    await safeQuery(`
      SELECT to_jsonb(e) AS raw
      FROM public.lr_channel_member_events e
      WHERE e.event_type='joined'
        AND e.channel_id::text = ANY($1::text[])
        AND e.occurred_at >= $2::timestamptz
        AND e.occurred_at <= $3::timestamptz
      ORDER BY e.occurred_at, e.id
    `, [aliases, iso(from), iso(to)]),
  );

  return result
    .map(({ raw }) => normalizeJoinEvent(raw))
    .filter(Boolean);
}

function secondKey(date) {
  return date.toISOString().slice(0, 19);
}

function minuteKey(date) {
  return date.toISOString().slice(0, 16);
}

function signal({
  type,
  occurredAt,
  events = [],
  payload = {},
  score = SIGNAL_SCORES[type] || 0,
  severity = 'medium',
}) {
  return {
    type,
    occurredAt: toDate(occurredAt, new Date()),
    events,
    payload,
    score,
    severity,
  };
}

function detectRateSignals(events) {
  const bySecond = new Map();
  const byMinute = new Map();

  for (const event of events) {
    const sec = secondKey(event.occurredAt);
    const minute = minuteKey(event.occurredAt);
    bySecond.set(sec, [...(bySecond.get(sec) || []), event]);
    byMinute.set(minute, [...(byMinute.get(minute) || []), event]);
  }

  const found = [];

  for (const [key, bucket] of bySecond) {
    if (bucket.length > MAX_JOINS_PER_SECOND) {
      found.push(signal({
        type: 'joins_over_5_per_second',
        occurredAt: bucket[0].occurredAt,
        events: bucket,
        payload: {
          second: key,
          joins: bucket.length,
          threshold: MAX_JOINS_PER_SECOND,
        },
        severity: 'critical',
      }));
    }
  }

  for (const [key, bucket] of byMinute) {
    if (bucket.length > MAX_JOINS_PER_MINUTE) {
      found.push(signal({
        type: 'joins_over_50_per_minute',
        occurredAt: bucket[0].occurredAt,
        events: bucket,
        payload: {
          minute: key,
          joins: bucket.length,
          threshold: MAX_JOINS_PER_MINUTE,
        },
        severity: 'critical',
      }));
    }
  }

  return found;
}

function numericId(event) {
  const value = clean(event.maxUserId, 120);
  return /^\d+$/.test(value)
    ? BigInt(value)
    : null;
}

function detectSequentialSignals(events) {
  const sorted = events
    .filter((event) => numericId(event) !== null)
    .sort((a, b) => a.occurredAt - b.occurredAt);
  const found = [];
  const used = new Set();
  const windowMs = SEQUENTIAL_WINDOW_MINUTES * 60_000;

  for (let start = 0; start < sorted.length; start += 1) {
    const windowEnd = sorted[start].occurredAt.getTime() + windowMs;
    const windowEvents = [];

    for (let index = start; index < sorted.length; index += 1) {
      if (sorted[index].occurredAt.getTime() > windowEnd) {
        break;
      }
      windowEvents.push(sorted[index]);
    }

    if (windowEvents.length < SEQUENTIAL_ID_RUN) {
      continue;
    }

    const byId = new Map();
    for (const event of windowEvents) {
      byId.set(numericId(event).toString(), event);
    }

    const ids = [...byId.keys()]
      .map((value) => BigInt(value))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    let run = [ids[0]];
    for (let index = 1; index < ids.length; index += 1) {
      if (ids[index] - ids[index - 1] === 1n) {
        run.push(ids[index]);
      } else {
        run = [ids[index]];
      }

      if (run.length >= SEQUENTIAL_ID_RUN) {
        const key = `${run[0]}:${run[run.length - 1]}`;
        if (!used.has(key)) {
          used.add(key);
          const runEvents = run
            .map((id) => byId.get(id.toString()))
            .filter(Boolean);
          found.push(signal({
            type: 'sequential_numeric_ids',
            occurredAt: runEvents[0].occurredAt,
            events: runEvents,
            payload: {
              first_id: run[0].toString(),
              last_id: run[run.length - 1].toString(),
              run_length: run.length,
              window_minutes: SEQUENTIAL_WINDOW_MINUTES,
            },
            severity: 'high',
          }));
        }
        break;
      }
    }
  }

  return found;
}

async function recentPlannedAd(channel, at) {
  const time = iso(at);
  const aliases = [
    channel.channelId,
    String(channel.dbId || ''),
  ].filter(Boolean);

  if (await tableExists('lr_proof_reports')) {
    const report = rows(
      await safeQuery(`
        SELECT to_jsonb(r) AS raw
        FROM public.lr_proof_reports r
        WHERE r.channel_id::text = ANY($1::text[])
          AND r.published_at <= $2::timestamptz
          AND COALESCE(
            r.expected_finish_at,
            r.published_at +
              make_interval(hours => COALESCE(r.duration_hours, 24))
          ) >= $2::timestamptz
        ORDER BY r.published_at DESC
        LIMIT 1
      `, [aliases, time]),
    )[0]?.raw;

    if (report) {
      return {
        type: 'proof_report',
        id: int(report.id),
        code: clean(report.report_code, 100),
        title: clean(report.post_title || report.post_preview || '', 300),
        source: clean(
          report.source_channel_title ||
          report.source_group_id ||
          report.channel_title ||
          '',
          200,
        ),
        publishedAt: report.published_at,
      };
    }
  }

  if (await tableExists('scheduled_posts')) {
    const post = rows(
      await safeQuery(`
        SELECT to_jsonb(p) AS raw
        FROM public.scheduled_posts p
        WHERE COALESCE(
          to_jsonb(p)->>'channel_id',
          to_jsonb(p)->>'max_chat_id',
          ''
        ) = ANY($1::text[])
          AND lower(COALESCE(
            to_jsonb(p)->>'is_ad',
            to_jsonb(p)->>'ad',
            'false'
          )) IN ('true','1','yes')
          AND COALESCE(
            NULLIF(to_jsonb(p)->>'published_at','')::timestamptz,
            NULLIF(to_jsonb(p)->>'publish_at','')::timestamptz
          ) BETWEEN
            $2::timestamptz - interval '24 hours'
            AND $2::timestamptz
        ORDER BY COALESCE(
          NULLIF(to_jsonb(p)->>'published_at','')::timestamptz,
          NULLIF(to_jsonb(p)->>'publish_at','')::timestamptz
        ) DESC
        LIMIT 1
      `, [aliases, time]),
    )[0]?.raw;

    if (post) {
      return {
        type: 'scheduled_post',
        id: int(post.id),
        code: '',
        title: clean(post.text || post.preview_text || '', 300),
        source: clean(
          post.source_channel_title ||
          post.source_group_id ||
          '',
          200,
        ),
        publishedAt: post.published_at || post.publish_at,
      };
    }
  }

  return null;
}

function nightBucketKey(event) {
  const parts = moscowParts(event.occurredAt);
  const hour = int(parts.hour);
  const minute = int(parts.minute);
  const bucketMinute = Math.floor(minute / 15) * 15;
  return {
    key: `${parts.year}-${parts.month}-${parts.day} ${String(hour).padStart(2, '0')}:${String(bucketMinute).padStart(2, '0')}`,
    hour,
  };
}

async function detectNightSignals(events, channel) {
  const buckets = new Map();

  for (const event of events) {
    const { key, hour } = nightBucketKey(event);
    if (hour < NIGHT_START_HOUR || hour >= NIGHT_END_HOUR) {
      continue;
    }
    buckets.set(key, [...(buckets.get(key) || []), event]);
  }

  const found = [];
  for (const [key, bucket] of buckets) {
    if (bucket.length < NIGHT_SURGE_15M) {
      continue;
    }

    const planned = await recentPlannedAd(channel, bucket[0].occurredAt);
    if (planned) {
      continue;
    }

    found.push(signal({
      type: 'night_surge_without_ad',
      occurredAt: bucket[0].occurredAt,
      events: bucket,
      payload: {
        moscow_bucket: key,
        joins: bucket.length,
        threshold_15m: NIGHT_SURGE_15M,
        planned_ad_found: false,
      },
      severity: 'high',
    }));
  }

  return found;
}

function extractClickTime(raw, timeColumn) {
  return toDate(
    raw[timeColumn] ||
    raw.clicked_at ||
    raw.occurred_at ||
    raw.created_at ||
    raw.timestamp,
  );
}

async function loadClicks(channel, from, to) {
  const candidates = [
    'ad_click_events',
    'analytics_click_events',
    'lr_click_events',
  ];

  for (const table of candidates) {
    if (!(await tableExists(table))) {
      continue;
    }

    const columns = await tableColumns(table);
    const timeColumn = firstColumn(
      columns,
      ['clicked_at', 'occurred_at', 'created_at', 'event_at', 'timestamp'],
    );
    if (!timeColumn) {
      continue;
    }

    const result = rows(
      await safeQuery(
        `SELECT to_jsonb(c) AS raw
           FROM public.${quoteIdentifier(table)} c
          WHERE c.${quoteIdentifier(timeColumn)} >= $1::timestamptz
            AND c.${quoteIdentifier(timeColumn)} <= $2::timestamptz
          ORDER BY c.${quoteIdentifier(timeColumn)}`,
        [iso(from), iso(to)],
      ),
    );

    const aliases = new Set([
      channel.channelId,
      String(channel.dbId || ''),
    ].filter(Boolean));

    return result
      .map(({ raw }) => {
        const clickedAt = extractClickTime(raw, timeColumn);
        if (!clickedAt) {
          return null;
        }

        const clickChannel = clean(
          raw.target_channel_id ||
          raw.destination_channel_id ||
          raw.channel_id ||
          raw.chat_id ||
          raw.max_chat_id ||
          '',
          120,
        );

        if (clickChannel && !aliases.has(clickChannel)) {
          return null;
        }

        return {
          table,
          clickedAt,
          userId: clean(
            raw.max_user_id ||
            raw.user_id ||
            raw.visitor_user_id ||
            '',
            120,
          ),
          channelId: clickChannel,
          postId: clean(
            raw.post_id ||
            raw.source_post_id ||
            raw.report_id ||
            raw.group_id ||
            '',
            120,
          ),
          raw,
        };
      })
      .filter(Boolean);
  }

  return [];
}

async function detectClickJoinSignals(events, channel, from, to) {
  const clicks = await loadClicks(channel, from, to);
  if (!clicks.length || !events.length) {
    return [];
  }

  const found = [];
  const usedClicks = new Set();
  const maxGapMs = CLICKS_JOIN_GAP_SECONDS * 1000;

  for (const event of events) {
    const exact = clicks
      .map((click, index) => ({ click, index }))
      .filter(({ click, index }) => {
        if (usedClicks.has(index)) {
          return false;
        }
        const gap = event.occurredAt - click.clickedAt;
        return gap >= 0 &&
          gap <= maxGapMs &&
          click.userId &&
          event.maxUserId &&
          click.userId === event.maxUserId;
      })
      .sort((a, b) => b.click.clickedAt - a.click.clickedAt)[0];

    const temporal = exact || clicks
      .map((click, index) => ({ click, index }))
      .filter(({ click, index }) => {
        if (usedClicks.has(index)) {
          return false;
        }
        const gap = event.occurredAt - click.clickedAt;
        return gap >= 0 && gap <= maxGapMs;
      })
      .sort((a, b) => b.click.clickedAt - a.click.clickedAt)[0];

    if (!temporal) {
      continue;
    }

    usedClicks.add(temporal.index);
    const gapMs = event.occurredAt - temporal.click.clickedAt;
    found.push(signal({
      type: 'click_join_under_2s',
      occurredAt: event.occurredAt,
      events: [event],
      payload: {
        gap_ms: gapMs,
        gap_seconds: Number((gapMs / 1000).toFixed(3)),
        confidence: exact ? 'exact_user' : 'temporal',
        click_table: temporal.click.table,
        click_post_id: temporal.click.postId || null,
      },
      severity: exact ? 'high' : 'medium',
      score: exact
        ? SIGNAL_SCORES.click_join_under_2s
        : Math.max(20, SIGNAL_SCORES.click_join_under_2s - 10),
    }));
  }

  return found;
}

function riskLevel(score) {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}

function riskIcon(level) {
  if (level === 'critical') return '🔴';
  if (level === 'high') return '🟠';
  if (level === 'medium') return '🟡';
  return '🟢';
}

function riskLabel(level) {
  if (level === 'critical') return 'Критический риск';
  if (level === 'high') return 'Высокий риск';
  if (level === 'medium') return 'Нужна проверка';
  return 'Риск не выявлен';
}

function scoreSignals(signals) {
  const byType = new Map();
  for (const item of signals) {
    const current = byType.get(item.type) || 0;
    byType.set(item.type, Math.max(current, int(item.score)));
  }

  let score = [...byType.values()].reduce((sum, value) => sum + value, 0);
  if (signals.length > byType.size) {
    score += Math.min(10, (signals.length - byType.size) * 2);
  }
  return Math.min(100, score);
}

function signalCounts(signals) {
  const counts = {};
  for (const item of signals) {
    counts[item.type] = (counts[item.type] || 0) + 1;
  }
  return counts;
}

function suspiciousEvents(signals) {
  const map = new Map();
  for (const item of signals) {
    for (const event of item.events || []) {
      const key = event.id || eventIdentity(event);
      if (key) {
        map.set(String(key), event);
      }
    }
  }
  return [...map.values()];
}

async function latestAttribution(channel, to, proofReport = null) {
  if (proofReport) {
    return {
      type: 'proof_report',
      proof_report_id: int(proofReport.id),
      report_code: clean(proofReport.report_code, 100),
      post: clean(
        proofReport.post_title ||
        proofReport.post_preview ||
        '',
        300,
      ),
      source_channel: clean(
        proofReport.source_channel_title ||
        proofReport.source_group_id ||
        '',
        200,
      ),
      published_at: proofReport.published_at || null,
    };
  }

  const ad = await recentPlannedAd(channel, to);
  if (!ad) {
    return {
      type: 'unattributed',
      note: 'Источник не определён: нет связанного рекламного размещения.',
    };
  }

  return {
    type: ad.type,
    id: ad.id || null,
    report_code: ad.code || null,
    post: ad.title || null,
    source_channel: ad.source || null,
    published_at: ad.publishedAt || null,
  };
}

async function markEvents(signals) {
  if (!(await tableExists('lr_channel_member_events'))) {
    return;
  }

  const byEvent = new Map();
  for (const item of signals) {
    for (const event of item.events || []) {
      if (!event.id) continue;
      const current = byEvent.get(event.id) || {
        score: 0,
        flags: [],
      };
      current.score = Math.max(current.score, int(item.score));
      current.flags.push(item.type);
      byEvent.set(event.id, current);
    }
  }

  for (const [eventId, value] of byEvent) {
    await safeQuery(`
      UPDATE public.lr_channel_member_events
      SET
        antifraud_score=$2,
        antifraud_flags=$3::jsonb
      WHERE id=$1
    `, [
      eventId,
      Math.min(100, value.score),
      JSON.stringify([...new Set(value.flags)]),
    ]);
  }
}

async function storeScan({
  channel,
  proofReport,
  ownerUserId,
  mode,
  from,
  to,
  events,
  signals,
  attribution,
}) {
  const score = scoreSignals(signals);
  const level = riskLevel(score);
  const counts = signalCounts(signals);
  const suspicious = suspiciousEvents(signals);

  const scan = rows(
    await query(`
      INSERT INTO public.lr_antifraud_scans (
        channel_id,
        db_channel_id,
        proof_report_id,
        owner_user_id,
        mode,
        window_from,
        window_to,
        joined_count,
        suspicious_join_count,
        risk_score,
        risk_level,
        signal_counts,
        attribution,
        evidence
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,
        $12::jsonb,$13::jsonb,$14::jsonb
      )
      RETURNING *
    `, [
      channel.channelId,
      channel.dbId || null,
      proofReport?.id || null,
      clean(ownerUserId, 100) || null,
      mode,
      iso(from),
      iso(to),
      events.length,
      suspicious.length,
      score,
      level,
      JSON.stringify(counts),
      JSON.stringify(attribution || {}),
      JSON.stringify({
        thresholds: {
          click_join_seconds: CLICKS_JOIN_GAP_SECONDS,
          joins_per_second: MAX_JOINS_PER_SECOND,
          joins_per_minute: MAX_JOINS_PER_MINUTE,
          sequential_id_run: SEQUENTIAL_ID_RUN,
          sequential_window_minutes: SEQUENTIAL_WINDOW_MINUTES,
          night_surge_15m: NIGHT_SURGE_15M,
          night_hours_moscow: '01:00–05:00',
        },
        avatars_used_as_criterion: false,
      }),
    ]),
  )[0];

  for (const item of signals) {
    const identities = (item.events || [])
      .map((event) => eventIdentity(event))
      .filter(Boolean);
    const eventIds = (item.events || [])
      .map((event) => event.id)
      .filter(Boolean);

    await query(`
      INSERT INTO public.lr_antifraud_signals (
        scan_id,
        channel_id,
        proof_report_id,
        signal_type,
        severity,
        occurred_at,
        score,
        max_user_id,
        event_ids,
        payload
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9::jsonb,$10::jsonb
      )
    `, [
      scan.id,
      channel.channelId,
      proofReport?.id || null,
      item.type,
      item.severity,
      iso(item.occurredAt),
      int(item.score),
      identities[0] || null,
      JSON.stringify(eventIds),
      JSON.stringify({
        ...item.payload,
        affected_users: identities.slice(0, 100),
        affected_count: identities.length,
      }),
    ]);
  }

  await markEvents(signals);

  if (proofReport?.id && await tableExists('lr_proof_reports')) {
    await safeQuery(`
      UPDATE public.lr_proof_reports
      SET
        risk_score=GREATEST(
          COALESCE(risk_score, 0),
          $2
        ),
        conditions=jsonb_set(
          COALESCE(conditions, '{}'::jsonb),
          '{join_antifraud}',
          $3::jsonb,
          true
        ),
        updated_at=now()
      WHERE id=$1
    `, [
      proofReport.id,
      score,
      JSON.stringify({
        score,
        level,
        signal_counts: counts,
        suspicious_join_count: suspicious.length,
        checked_at: new Date().toISOString(),
      }),
    ]);
  }

  return scan;
}

async function scanChannel({
  channel,
  from,
  to,
  mode = 'channel_24h',
  proofReport = null,
  ownerUserId = '',
}) {
  await ensureSchema();

  const events = await loadJoinEvents(channel, from, to);
  const signals = [
    ...detectRateSignals(events),
    ...detectSequentialSignals(events),
    ...await detectNightSignals(events, channel),
    ...await detectClickJoinSignals(events, channel, from, to),
  ];
  const attribution = await latestAttribution(
    channel,
    to,
    proofReport,
  );

  return storeScan({
    channel,
    proofReport,
    ownerUserId,
    mode,
    from,
    to,
    events,
    signals,
    attribution,
  });
}

async function proofReportsForScan() {
  if (!(await tableExists('lr_proof_reports'))) {
    return [];
  }

  return rows(
    await safeQuery(`
      SELECT to_jsonb(r) AS raw
      FROM public.lr_proof_reports r
      WHERE r.published_at IS NOT NULL
        AND r.published_at >= now() - interval '8 days'
        AND COALESCE(r.status, '') NOT IN ('deleted', 'cancelled')
      ORDER BY r.published_at DESC
      LIMIT 300
    `),
  ).map(({ raw }) => raw);
}

async function runAllScans() {
  if (workerBusy) {
    return false;
  }
  workerBusy = true;

  try {
    await ensureSchema();
    const now = new Date();
    const channels = await allActiveChannels();

    for (const channel of channels) {
      const from = new Date(
        now.getTime() - CHANNEL_WINDOW_HOURS * 60 * 60_000,
      );
      await scanChannel({
        channel,
        from,
        to: now,
        mode: 'channel_24h',
        ownerUserId: channel.ownerUserId,
      });
    }

    const reports = await proofReportsForScan();
    for (const report of reports) {
      const channel = channels.find((candidate) =>
        [
          candidate.channelId,
          String(candidate.dbId || ''),
        ].includes(clean(report.channel_id, 120)),
      );
      if (!channel) {
        continue;
      }

      const from = toDate(report.published_at);
      if (!from) {
        continue;
      }
      const configuredEnd = toDate(
        report.expected_finish_at,
        new Date(
          from.getTime() + int(report.duration_hours, 24) * 60 * 60_000,
        ),
      );
      const to = configuredEnd < now
        ? configuredEnd
        : now;

      await scanChannel({
        channel,
        from,
        to,
        mode: 'proof_report',
        proofReport: report,
        ownerUserId: report.owner_user_id || channel.ownerUserId,
      });
    }

    await safeQuery(`
      DELETE FROM public.lr_antifraud_scans
      WHERE created_at < now() - interval '90 days'
    `);

    console.log(
      '[LinkRay AntiFraud] scan complete',
      JSON.stringify({
        channels: channels.length,
        reports: reports.length,
      }),
    );
    return true;
  } catch (error) {
    console.error(
      '[LinkRay AntiFraud worker]',
      error?.stack || error?.message || error,
    );
    return false;
  } finally {
    workerBusy = false;
  }
}

export function startLinkRayAntiFraudWorker() {
  if (workerTimer || globalThis.__linkRayAntiFraudWorkerStarted) {
    return false;
  }

  globalThis.__linkRayAntiFraudWorkerStarted = true;
  setTimeout(() => {
    runAllScans().catch((error) => {
      console.error('[LinkRay AntiFraud first scan]', error);
    });
  }, 10_000).unref?.();

  workerTimer = setInterval(() => {
    runAllScans().catch((error) => {
      console.error('[LinkRay AntiFraud interval]', error);
    });
  }, SCAN_INTERVAL_MS);
  workerTimer.unref?.();

  console.log(
    '[LinkRay AntiFraud] worker started',
    JSON.stringify({ interval_ms: SCAN_INTERVAL_MS }),
  );
  return true;
}

async function latestScan(channelId, mode = 'channel_24h') {
  return rows(
    await safeQuery(`
      SELECT *
      FROM public.lr_antifraud_scans
      WHERE channel_id=$1
        AND mode=$2
      ORDER BY created_at DESC
      LIMIT 1
    `, [channelId, mode]),
  )[0] || null;
}

async function respond(update, text, buttons) {
  const callbackId = callbackIdOf(update);
  if (callbackId) {
    try {
      await answerCallback({
        callbackId,
        text,
        format: 'html',
        attachments: inlineKeyboard(buttons),
      });
      return true;
    } catch (error) {
      console.error(
        '[LinkRay AntiFraud callback]',
        error?.message || error,
      );
    }
  }

  const chatId = chatIdOf(update) || userIdOf(update);
  if (!chatId) {
    return false;
  }
  return sendMaxMessage({
    chatId,
    text,
    format: 'html',
    attachments: inlineKeyboard(buttons),
  });
}

function signalLabel(type) {
  const labels = {
    click_join_under_2s: 'Клик → подписка быстрее 2 секунд',
    sequential_numeric_ids: 'Серия последовательных MAX ID',
    joins_over_5_per_second: 'Более 5 подписок за секунду',
    joins_over_50_per_minute: 'Более 50 подписок за минуту',
    night_surge_without_ad: 'Ночной всплеск без рекламы',
  };
  return labels[type] || type;
}

function countsText(counts = {}) {
  const entries = Object.entries(counts);
  if (!entries.length) {
    return '• подозрительные сигналы не обнаружены';
  }
  return entries
    .map(([type, count]) => `• ${esc(signalLabel(type))}: <b>${fmt(count)}</b>`)
    .join('\n');
}

async function showMenu(update, maxUserId) {
  const channels = await channelsForUser(maxUserId);
  const buttons = [];
  const lines = [
    '━━━━━━━━━━━━━━',
    '🛡 <b>Антифрод LinkRay</b>',
    '',
    'Проверка качества трафика после рекламных размещений.',
    'Аватары не используются как признак накрутки.',
    '',
  ];

  if (!channels.length) {
    lines.push('Подключённые каналы не найдены.');
  } else {
    for (const channel of channels) {
      const scan = await latestScan(channel.channelId);
      const level = scan?.risk_level || 'low';
      lines.push(
        `${riskIcon(level)} ${esc(channel.title)} — <b>${int(scan?.risk_score, 0)}/100</b>`,
      );
      buttons.push([
        callbackButton(
          `${riskIcon(level)} ${channel.title.slice(0, 34)}`,
          `fraud:channel:${channel.dbId}`,
        ),
      ]);
    }
  }

  lines.push('', 'Выберите канал.', '━━━━━━━━━━━━━━');
  buttons.push([
    callbackButton('⬅️ В меню', 'main:menu'),
  ]);

  await respond(update, lines.join('\n'), buttons);
}

async function showChannel(update, maxUserId, dbChannelId, notice = '') {
  const channel = await channelForUser(maxUserId, dbChannelId);
  if (!channel) {
    await showMenu(update, maxUserId);
    return;
  }

  let scan = await latestScan(channel.channelId);
  if (!scan) {
    scan = await scanChannel({
      channel,
      from: new Date(Date.now() - CHANNEL_WINDOW_HOURS * 60 * 60_000),
      to: new Date(),
      ownerUserId: maxUserId,
    });
  }

  const level = scan.risk_level || riskLevel(scan.risk_score);
  const attribution = scan.attribution || {};
  const lines = [
    '━━━━━━━━━━━━━━',
    `${riskIcon(level)} <b>${esc(channel.title)}</b>`,
    '',
  ];

  if (notice) {
    lines.push(esc(notice), '');
  }

  lines.push(
    `Оценка риска: <b>${int(scan.risk_score)}/100</b>`,
    `Статус: <b>${riskLabel(level)}</b>`,
    `Подписок за период: <b>${fmt(scan.joined_count)}</b>`,
    `Затронуто подозрением: <b>${fmt(scan.suspicious_join_count)}</b>`,
    '',
    '<b>Сигналы</b>',
    countsText(scan.signal_counts || {}),
    '',
    '<b>Связь с рекламой</b>',
  );

  if (attribution.type === 'unattributed') {
    lines.push('• источник не определён');
  } else {
    lines.push(
      `• отчёт: <b>${esc(attribution.report_code || attribution.id || 'размещение')}</b>`,
      `• пост: ${esc(attribution.post || 'не указан')}`,
      `• источник: ${esc(attribution.source_channel || 'не определён')}`,
    );
  }

  lines.push(
    '',
    `Период: ${moscowDate(scan.window_from)} — ${moscowDate(scan.window_to)} МСК`,
    `Проверено: ${moscowDate(scan.created_at)} МСК`,
    '━━━━━━━━━━━━━━',
  );

  await respond(update, lines.join('\n'), [
    [
      callbackButton('🔄 Пересчитать', `fraud:scan:${channel.dbId}`),
    ],
    [
      callbackButton('📋 События', `fraud:events:${channel.dbId}`),
      callbackButton('📈 7 дней', `fraud:week:${channel.dbId}`),
    ],
    [
      callbackButton('⬅️ К каналам', 'fraud:menu'),
    ],
  ]);
}

async function showEvents(update, maxUserId, dbChannelId) {
  const channel = await channelForUser(maxUserId, dbChannelId);
  if (!channel) {
    await showMenu(update, maxUserId);
    return;
  }

  const events = rows(
    await safeQuery(`
      SELECT s.*
      FROM public.lr_antifraud_signals s
      WHERE s.channel_id=$1
      ORDER BY s.occurred_at DESC, s.id DESC
      LIMIT 12
    `, [channel.channelId]),
  );

  const lines = [
    '━━━━━━━━━━━━━━',
    `📋 <b>Сигналы — ${esc(channel.title)}</b>`,
    '',
  ];

  if (!events.length) {
    lines.push('Подозрительных событий не найдено.');
  } else {
    for (const item of events) {
      const payload = item.payload || {};
      lines.push(
        `• <b>${esc(signalLabel(item.signal_type))}</b>`,
        `  ${moscowDate(item.occurred_at)} МСК · +${int(item.score)} риска`,
        `  затронуто: ${fmt(payload.affected_count || 0)}`,
      );
    }
  }

  lines.push('', '━━━━━━━━━━━━━━');
  await respond(update, lines.join('\n'), [
    [
      callbackButton('⬅️ К каналу', `fraud:channel:${channel.dbId}`),
    ],
  ]);
}

async function showWeek(update, maxUserId, dbChannelId) {
  const channel = await channelForUser(maxUserId, dbChannelId);
  if (!channel) {
    await showMenu(update, maxUserId);
    return;
  }

  const points = rows(
    await safeQuery(`
      SELECT DISTINCT ON (date_trunc('day', created_at AT TIME ZONE 'Europe/Moscow'))
        date_trunc('day', created_at AT TIME ZONE 'Europe/Moscow') AS day,
        risk_score,
        risk_level,
        joined_count,
        suspicious_join_count,
        created_at
      FROM public.lr_antifraud_scans
      WHERE channel_id=$1
        AND mode='channel_24h'
        AND created_at >= now() - interval '7 days'
      ORDER BY
        date_trunc('day', created_at AT TIME ZONE 'Europe/Moscow') DESC,
        created_at DESC
    `, [channel.channelId]),
  );

  const lines = [
    '━━━━━━━━━━━━━━',
    `📈 <b>Антифрод за 7 дней — ${esc(channel.title)}</b>`,
    '',
  ];

  if (!points.length) {
    lines.push('История ещё не накоплена.');
  } else {
    for (const point of points) {
      lines.push(
        `${riskIcon(point.risk_level)} ${moscowDate(point.day).slice(0, 10)} — ` +
        `<b>${int(point.risk_score)}/100</b>, ` +
        `подписок ${fmt(point.joined_count)}, ` +
        `подозрительных ${fmt(point.suspicious_join_count)}`,
      );
    }
  }

  lines.push('', '━━━━━━━━━━━━━━');
  await respond(update, lines.join('\n'), [
    [
      callbackButton('⬅️ К каналу', `fraud:channel:${channel.dbId}`),
    ],
  ]);
}

export async function handleLinkRayAntiFraudIncoming(update = {}) {
  const rawPayload = payloadOf(update);
  if (
    !rawPayload.startsWith('fraud:') &&
    !rawPayload.startsWith('antifraud:')
  ) {
    return false;
  }

  await ensureSchema();
  const normalized = rawPayload.replace(/^antifraud:/, 'fraud:');
  const maxUserId =
    chatIdOf(update) ||
    userIdOf(update);
  if (!maxUserId) {
    return false;
  }

  if (normalized === 'fraud:menu') {
    await showMenu(update, maxUserId);
    return true;
  }

  const parts = normalized.split(':');
  const action = parts[1];
  const dbChannelId = int(parts[2]);

  if (!dbChannelId) {
    await showMenu(update, maxUserId);
    return true;
  }

  if (action === 'channel') {
    await showChannel(update, maxUserId, dbChannelId);
    return true;
  }

  if (action === 'scan') {
    const channel = await channelForUser(maxUserId, dbChannelId);
    if (!channel) {
      await showMenu(update, maxUserId);
      return true;
    }

    await scanChannel({
      channel,
      from: new Date(Date.now() - CHANNEL_WINDOW_HOURS * 60 * 60_000),
      to: new Date(),
      ownerUserId: maxUserId,
    });
    await showChannel(
      update,
      maxUserId,
      dbChannelId,
      '✅ Проверка обновлена.',
    );
    return true;
  }

  if (action === 'events') {
    await showEvents(update, maxUserId, dbChannelId);
    return true;
  }

  if (action === 'week') {
    await showWeek(update, maxUserId, dbChannelId);
    return true;
  }

  await showMenu(update, maxUserId);
  return true;
}

export async function linkRayAntiFraudSmokeTest({ database = false } = {}) {
  const base = new Date('2026-07-15T00:00:00.000Z');
  const rateEvents = Array.from({ length: 51 }, (_, index) => ({
    id: index + 1,
    maxUserId: String(9000 + index),
    userHash: `u-${index}`,
    occurredAt: new Date(base.getTime() + Math.min(index, 5) * 100),
  }));
  const sequentialEvents = Array.from({ length: 10 }, (_, index) => ({
    id: 100 + index,
    maxUserId: String(500000 + index),
    userHash: `seq-${index}`,
    occurredAt: new Date(base.getTime() + index * 1000),
  }));

  const rate = detectRateSignals(rateEvents);
  const sequential = detectSequentialSignals(sequentialEvents);

  if (database) {
    await ensureSchema();
  }

  const result = {
    ok:
      rate.some((item) => item.type === 'joins_over_5_per_second') &&
      rate.some((item) => item.type === 'joins_over_50_per_minute') &&
      sequential.some((item) => item.type === 'sequential_numeric_ids'),
    detectors: {
      joins_per_second: rate.some(
        (item) => item.type === 'joins_over_5_per_second',
      ),
      joins_per_minute: rate.some(
        (item) => item.type === 'joins_over_50_per_minute',
      ),
      sequential_ids: sequential.some(
        (item) => item.type === 'sequential_numeric_ids',
      ),
      avatars_used_as_criterion: false,
    },
    database_checked: Boolean(database),
  };

  return result;
}

export { runAllScans as runLinkRayAntiFraudScanNow };
