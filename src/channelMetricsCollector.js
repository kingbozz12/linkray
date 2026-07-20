import crypto from 'node:crypto';
import { query } from './db.js'; import { captureAudienceIdentity } from './channelAudienceReports.js';

const API_BASE = (
  process.env.MAX_API_URL ||
  process.env.MAX_BASE_URL ||
  'https://platform-api2.max.ru'
).replace(/\/+$/, '');

const COLLECT_INTERVAL_MS = Math.max(
  5 * 60_000,
  Number(process.env.LR_CHANNEL_METRICS_INTERVAL_MS || 10 * 60_000)
);
const MEMBER_SCAN_INTERVAL_MS = Math.max(
  30 * 60_000,
  Number(process.env.LR_CHANNEL_MEMBER_SCAN_INTERVAL_MS || 60 * 60_000)
);
const REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.LR_MAX_REQUEST_TIMEOUT_MS || 20_000)
);
const MAX_MEMBER_SCAN = Math.max(
  1_000,
  Number(process.env.LR_CHANNEL_MEMBER_SCAN_MAX || 100_000)
);
const METRICS_RETENTION_DAYS = Math.max(
  30,
  Number(process.env.LR_CHANNEL_METRICS_RETENTION_DAYS || 180)
);

const ANALYTICS_WARMUP_MS = Math.max(
  10 * 60_000,
  Number(process.env.LR_CHANNEL_ANALYTICS_WARMUP_MS || 24 * 60 * 60_000)
);

let installed = false;
let collectorTimer = null;
let collectionRunning = false;
let tablesEnsured = false;

function rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function token() {
  return (
    process.env.BOT_TOKEN ||
    process.env.MAX_BOT_TOKEN ||
    process.env.MAX_TOKEN ||
    ''
  );
}

function clean(value) {
  return String(value ?? '').trim();
}

function int(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function first(source, names, fallback = '') {
  for (const name of names) {
    const value = source?.[name];
    if (value !== undefined && value !== null && clean(value) !== '') {
      return value;
    }
  }
  return fallback;
}

function unixMs(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 10_000_000_000 ? Math.round(number * 1000) : Math.round(number);
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function channelKey(link, channelId) {
  return crypto
    .createHash('sha1')
    .update(String(link || channelId))
    .digest('hex')
    .slice(0, 18);
}

function normalizeLink(value) {
  return clean(value)
    .replace(/^http:\/\//i, 'https://')
    .replace(/^https:\/\/www\./i, 'https://')
    .replace(/[?#].*$/, '')
    .replace(/[.,;!?]+$/, '')
    .replace(/\/+$/, '');
}

function linkIdentity(value) {
  const normalized = normalizeLink(value).toLowerCase();
  const path = normalized.replace(/^https:\/\/max\.ru\//i, '');
  const join = path.replace(/^join\//i, '');
  return { normalized, path, join };
}

function linksMatch(left, right) {
  const a = linkIdentity(left);
  const b = linkIdentity(right);
  if (!a.normalized || !b.normalized) return false;
  return (
    a.normalized === b.normalized ||
    (a.join && b.join && a.join === b.join) ||
    (a.path && b.path && a.path === b.path)
  );
}

function memberHash(channelId, userId) {
  const salt =
    process.env.LR_ANALYTICS_HASH_SALT ||
    process.env.MAX_WEBHOOK_SECRET ||
    token() ||
    'linkray-channel-analytics';
  return sha(`${salt}:${channelId}:${userId}`);
}

function deepNumber(source, candidateKeys) {
  const keys = new Set(candidateKeys.map((key) => key.toLowerCase()));
  let best = 0;

  function visit(node, parentKey = '') {
    if (node === null || node === undefined) return;

    if (typeof node === 'number' || typeof node === 'string') {
      if (keys.has(parentKey.toLowerCase())) {
        const value = Number(String(node).replace(/\s+/g, '').replace(',', '.'));
        if (Number.isFinite(value)) best = Math.max(best, Math.round(value));
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) visit(item, parentKey);
      return;
    }

    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (keys.has(key.toLowerCase())) {
          const parsed = Number(String(value).replace(/\s+/g, '').replace(',', '.'));
          if (Number.isFinite(parsed)) best = Math.max(best, Math.round(parsed));
        }
      }
      for (const [key, value] of Object.entries(node)) visit(value, key);
    }
  }

  visit(source);
  return best;
}

async function maxGet(pathname, params = {}) {
  if (!token()) throw new Error('MAX bot token is not configured');

  const url = new URL(`${API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: token(),
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.success === false) {
        throw new Error(
          `MAX API ${response.status}: ${JSON.stringify(body || {})}`.slice(0, 700)
        );
      }
      return body || {};
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 700));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('MAX API request failed');
}

async function ensureTables() {
  if (tablesEnsured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS public.lr_channel_member_events (
      id bigserial PRIMARY KEY,
      event_key text NOT NULL UNIQUE,
      channel_id text NOT NULL,
      event_type text NOT NULL CHECK (event_type IN ('joined', 'left')),
      user_hash text,
      source text NOT NULL DEFAULT 'webhook',
      occurred_at timestamptz NOT NULL,
      raw jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_lr_channel_member_events_channel_time
    ON public.lr_channel_member_events(channel_id, occurred_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS public.lr_channel_members_current (
      channel_id text NOT NULL,
      user_hash text NOT NULL,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(channel_id, user_hash)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS public.lr_channel_post_metrics (
      channel_id text NOT NULL,
      message_id text NOT NULL,
      published_at timestamptz NOT NULL,
      views integer NOT NULL DEFAULT 0,
      url text,
      raw_stat jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_checked_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(channel_id, message_id)
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_lr_channel_post_metrics_channel_published
    ON public.lr_channel_post_metrics(channel_id, published_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS public.lr_channel_metrics_state (
      channel_id text PRIMARY KEY,
      channel_title text,
      channel_link text,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      first_success_at timestamptz,
      ready_at timestamptz,
      success_count integer NOT NULL DEFAULT 0,
      baseline_complete boolean NOT NULL DEFAULT false,
      last_collect_at timestamptz,
      last_member_scan_at timestamptz,
      last_success_at timestamptz,
      last_error text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`
    ALTER TABLE public.lr_channel_metrics_state
      ADD COLUMN IF NOT EXISTS channel_title text,
      ADD COLUMN IF NOT EXISTS channel_link text,
      ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS first_success_at timestamptz,
      ADD COLUMN IF NOT EXISTS ready_at timestamptz,
      ADD COLUMN IF NOT EXISTS success_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS baseline_complete boolean NOT NULL DEFAULT false
  `);

  await query(`
    ALTER TABLE public.lr_channel_analytics_snapshots
      ADD COLUMN IF NOT EXISTS joined_24h integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS left_24h integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS joined_7d integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS left_7d integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS views_total integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS posts24 integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS posts48 integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS posts72 integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS collection_source text NOT NULL DEFAULT 'legacy'
  `).catch(async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS public.lr_channel_analytics_snapshots (
        id bigserial PRIMARY KEY,
        channel_key text NOT NULL,
        link text NOT NULL,
        title text NOT NULL DEFAULT 'Канал MAX',
        avatar_url text,
        subscribers integer NOT NULL DEFAULT 0,
        views24 integer NOT NULL DEFAULT 0,
        views48 integer NOT NULL DEFAULT 0,
        views72 integer NOT NULL DEFAULT 0,
        er24 numeric NOT NULL DEFAULT 0,
        delta_day integer NOT NULL DEFAULT 0,
        raw jsonb NOT NULL DEFAULT '{}'::jsonb,
        captured_at timestamptz NOT NULL DEFAULT now(),
        joined_24h integer NOT NULL DEFAULT 0,
        left_24h integer NOT NULL DEFAULT 0,
        joined_7d integer NOT NULL DEFAULT 0,
        left_7d integer NOT NULL DEFAULT 0,
        views_total integer NOT NULL DEFAULT 0,
        posts24 integer NOT NULL DEFAULT 0,
        posts48 integer NOT NULL DEFAULT 0,
        posts72 integer NOT NULL DEFAULT 0,
        collection_source text NOT NULL DEFAULT 'collector_v1'
      )
    `);
  });

  await query(`
    CREATE INDEX IF NOT EXISTS idx_lr_channel_analytics_snapshots_key_time
    ON public.lr_channel_analytics_snapshots(channel_key, captured_at DESC)
  `);

  tablesEnsured = true;
}

function normalizeChannelRow(data) {
  const row = data && typeof data === 'object' ? data : {};
  const channelId = clean(first(row, [
    'chat_id',
    'channel_id',
    'max_chat_id',
    'max_channel_id',
    'max_id',
    'external_id',
    'peer_id',
    'id',
  ]));

  if (!channelId || !/^-?\d+$/.test(channelId)) return null;

  const status = clean(first(row, ['status', 'state', 'channel_status'])).toLowerCase();
  if (['removed', 'deleted', 'left', 'disabled', 'inactive'].includes(status)) return null;
  if (row.is_active === false || row.active === false || row.enabled === false) return null;

  return {
    channelId,
    title: clean(first(row, [
      'title',
      'name',
      'channel_title',
      'chat_title',
      'display_name',
      'channel_name',
    ], 'Канал MAX')),
    link: clean(first(row, [
      'link',
      'public_link',
      'invite_link',
      'url',
      'channel_link',
      'join_link',
      'max_link',
    ])),
    avatarUrl: clean(first(row, [
      'avatar_url',
      'photo_url',
      'image_url',
      'icon_url',
      'picture_url',
      'avatar',
      'photo',
    ])),
    enabledAt: clean(first(row, [
      '_analytics_enabled_at',
      'analytics_enabled_at',
    ])),
    raw: row,
  };
}

async function loadChannels() {
  const tableExists = rows(await query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema='public'
      AND table_name='channels'
    LIMIT 1
  `)).length > 0;

  if (!tableExists) return [];

  const enabledTableExists = rows(await query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema='public'
      AND table_name='lr_channel_analytics_daily_channels'
    LIMIT 1
  `).catch(() => [])).length > 0;

  if (!enabledTableExists) return [];

  const result = await query(`
    SELECT
      to_jsonb(c) || jsonb_build_object(
        '_analytics_enabled_at',
        (
          SELECT MIN(d.updated_at)
          FROM public.lr_channel_analytics_daily_channels d
          WHERE (d.channel_id::text=c.id::text OR d.channel_id::text=c.max_chat_id::text)
            AND d.enabled=true
        )
      ) AS data
    FROM public.channels c
    WHERE c.is_active=true
      AND EXISTS (
        SELECT 1
        FROM public.lr_channel_analytics_daily_channels d
        WHERE (d.channel_id::text=c.id::text OR d.channel_id::text=c.max_chat_id::text)
          AND d.enabled=true
      )
  `);

  const seen = new Set();
  const channels = [];

  for (const row of rows(result)) {
    const channel = normalizeChannelRow(row.data || row);
    if (!channel || seen.has(channel.channelId)) continue;

    seen.add(channel.channelId);
    channels.push(channel);
  }

  return channels;
}

function messageId(message) {
  return clean(
    message?.body?.mid ||
    message?.body?.message_id ||
    message?.message_id ||
    message?.id ||
    message?.mid
  );
}

function messageViews(message) {
  /* LR_EXACT_MESSAGE_VIEWS_V80_3_1 */

  /*
   * Официальный MessageStat MAX содержит поле views.
   * Нельзя выбирать максимум среди users/reach/participants:
   * это другие показатели и они завышают просмотры.
   */
  const raw = message?.stat?.views;

  if (
    raw === undefined
    || raw === null
    || raw === ''
  ) {
    return null;
  }

  const parsed = Number(
    String(raw)
      .replace(/\s+/g, '')
      .replace(',', '.')
  );

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.round(parsed);
}

async function fetchMessageWindow(channelId, newerMs, olderMs, depth = 0) {
  const params = {
    chat_id: channelId,
    from: newerMs,
    to: olderMs,
    count: 100,
  };

  let body = await maxGet('/messages', params);
  let messages = Array.isArray(body?.messages) ? body.messages : [];

  if (!messages.length && depth === 0) {
    body = await maxGet('/messages', {
      ...params,
      from: Math.floor(newerMs / 1000),
      to: Math.floor(olderMs / 1000),
    });
    messages = Array.isArray(body?.messages) ? body.messages : [];
  }

  const range = newerMs - olderMs;
  if (messages.length >= 100 && depth < 10 && range > 15 * 60_000) {
    const middle = olderMs + Math.floor(range / 2);
    const [newerHalf, olderHalf] = await Promise.all([
      fetchMessageWindow(channelId, newerMs, middle, depth + 1),
      fetchMessageWindow(channelId, middle - 1, olderMs, depth + 1),
    ]);
    return [...newerHalf, ...olderHalf];
  }

  return messages;
}

async function fetchRecentMessages(channelId) {
  const now = Date.now();
  const older = now - 72 * 60 * 60_000;
  const messages = await fetchMessageWindow(channelId, now, older);
  const unique = new Map();

  for (const message of messages) {
    const id = messageId(message);
    if (!id) continue;
    unique.set(id, message);
  }

  return [...unique.values()];
}

async function savePostMetrics(channelId, messages) {
  /* LR_EXACT_MESSAGE_VIEWS_V80_3_1 */

  for (const message of messages) {
    const id = messageId(message);

    const publishedMs = unixMs(
      message?.timestamp
      || message?.created_at
      || message?.date
    );

    const views = messageViews(message);

    /*
     * В расчёт попадают только реальные посты канала,
     * для которых MAX вернул MessageStat.views.
     */
    if (!id || !publishedMs || views === null) {
      continue;
    }

    await query(`
      INSERT INTO public.lr_channel_post_metrics (
        channel_id,
        message_id,
        published_at,
        views,
        url,
        raw_stat,
        last_checked_at
      )
      VALUES (
        $1,
        $2,
        to_timestamp($3 / 1000.0),
        $4,
        $5,
        $6::jsonb,
        now()
      )
      ON CONFLICT (channel_id, message_id)
      DO UPDATE SET
        /*
         * Не используем GREATEST.
         * Если раньше reach/users ошибочно попали в views,
         * точный ответ MAX должен иметь право уменьшить число.
         */
        views = EXCLUDED.views,
        published_at = EXCLUDED.published_at,
        url = COALESCE(
          NULLIF(EXCLUDED.url, ''),
          public.lr_channel_post_metrics.url
        ),
        raw_stat = EXCLUDED.raw_stat,
        last_checked_at = now()
    `, [
      channelId,
      id,
      publishedMs,
      views,
      clean(message?.url),
      JSON.stringify(message?.stat),
    ]);
  }
}

async function postSummary(channelId) {
  /* LR_EXACT_MESSAGE_VIEWS_V80_3_1 */

  const result = rows(await query(`
    WITH exact_metrics AS (
      SELECT
        views,
        published_at
      FROM public.lr_channel_post_metrics
      WHERE channel_id=$1
        AND raw_stat ? 'views'
        AND published_at >= COALESCE(
          (
            SELECT first_seen_at
            FROM public.lr_channel_metrics_state
            WHERE channel_id=$1
          ),
          now()
        )
    ),
    calculated AS (
      SELECT
        COALESCE(
          ROUND(
            AVG(views) FILTER (
              WHERE published_at >= now() - interval '24 hours'
            )
          ),
          0
        )::bigint AS exact24,

        COALESCE(
          ROUND(
            AVG(views) FILTER (
              WHERE published_at >= now() - interval '48 hours'
            )
          ),
          0
        )::bigint AS exact48,

        COALESCE(
          ROUND(
            AVG(views) FILTER (
              WHERE published_at >= now() - interval '72 hours'
            )
          ),
          0
        )::bigint AS exact72,

        COUNT(*) FILTER (
          WHERE published_at >= now() - interval '24 hours'
        )::integer AS posts24,

        COUNT(*) FILTER (
          WHERE published_at >= now() - interval '48 hours'
        )::integer AS posts48,

        COUNT(*) FILTER (
          WHERE published_at >= now() - interval '72 hours'
        )::integer AS posts72

      FROM exact_metrics
    )
    SELECT
      /*
       * По требованию карточки «Всего» и «24 часа»
       * являются одним и тем же показателем.
       */
      exact24 AS views_total,
      exact24 AS views24,
      exact48 AS views48,
      exact72 AS views72,
      posts24,
      posts48,
      posts72
    FROM calculated
  `, [channelId]))[0] || {};

  return {
    viewsTotal: int(result.views_total),
    views24: int(result.views24),
    views48: int(result.views48),
    views72: int(result.views72),

    postsTotal: int(result.posts24),
    posts24: int(result.posts24),
    posts48: int(result.posts48),
    posts72: int(result.posts72),
  };
}

async function fetchAllMemberHashes(channelId) {
  const hashes = new Set();
  let marker = '';
  let page = 0;

  while (page < 2_000 && hashes.size < MAX_MEMBER_SCAN) {
    const body = await maxGet(`/chats/${encodeURIComponent(channelId)}/members`, {
      count: 100,
      marker,
    });
    const members = Array.isArray(body?.members) ? body.members : [];

    for (const member of members) {
      if (member?.is_bot) continue;
      const userId = clean(member?.user_id || member?.id);
      if (userId) hashes.add(memberHash(channelId, userId));
    }

    const nextMarker = clean(body?.marker);
    page += 1;
    if (!nextMarker || nextMarker === marker || !members.length) break;
    marker = nextMarker;
  }

  return hashes;
}

async function recordMemberEvent({
  channelId,
  eventType,
  userHash = '',
  source,
  occurredAt = new Date(),
  raw = {},
}) {
  if (userHash) {
    const duplicate = rows(await query(`
      SELECT 1
      FROM public.lr_channel_member_events
      WHERE channel_id=$1
        AND event_type=$2
        AND user_hash=$3
        AND occurred_at BETWEEN $4::timestamptz - interval '2 hours'
                            AND $4::timestamptz + interval '2 hours'
      LIMIT 1
    `, [channelId, eventType, userHash, occurredAt]))[0];
    if (duplicate) return;
  }

  const key = sha([
    channelId,
    eventType,
    userHash,
    source,
    new Date(occurredAt).toISOString(),
  ].join(':'));

  await query(`
    INSERT INTO public.lr_channel_member_events
      (event_key, channel_id, event_type, user_hash, source, occurred_at, raw)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (event_key) DO NOTHING
  `, [
    key,
    channelId,
    eventType,
    userHash || null,
    source,
    occurredAt,
    JSON.stringify(raw || {}),
  ]);
}

async function scanMembers(channelId) {
  const current = await fetchAllMemberHashes(channelId);
  const previousRows = rows(await query(`
    SELECT user_hash
    FROM public.lr_channel_members_current
    WHERE channel_id=$1
  `, [channelId]));
  const previous = new Set(previousRows.map((row) => clean(row.user_hash)).filter(Boolean));

  if (previous.size > 0) {
    const occurredAt = new Date();

    for (const hashValue of current) {
      if (!previous.has(hashValue)) {
        await recordMemberEvent({
          channelId,
          eventType: 'joined',
          userHash: hashValue,
          source: 'member_diff',
          occurredAt,
        });
      }
    }

    for (const hashValue of previous) {
      if (!current.has(hashValue)) {
        await recordMemberEvent({
          channelId,
          eventType: 'left',
          userHash: hashValue,
          source: 'member_diff',
          occurredAt,
        });
      }
    }
  }

  await query(`
    DELETE FROM public.lr_channel_members_current
    WHERE channel_id=$1
      AND NOT (user_hash = ANY($2::text[]))
  `, [channelId, [...current]]).catch(async () => {
    await query(`DELETE FROM public.lr_channel_members_current WHERE channel_id=$1`, [channelId]);
  });

  for (const hashValue of current) {
    await query(`
      INSERT INTO public.lr_channel_members_current
        (channel_id, user_hash, first_seen_at, last_seen_at)
      VALUES ($1, $2, now(), now())
      ON CONFLICT (channel_id, user_hash) DO UPDATE SET
        last_seen_at=now()
    `, [channelId, hashValue]);
  }

  return current.size;
}

async function memberEventSummary(channelId) {
  const result = rows(await query(`
    SELECT
      COUNT(*) FILTER (
        WHERE event_type='joined' AND occurred_at >= now() - interval '24 hours'
      )::integer AS joined_24h,
      COUNT(*) FILTER (
        WHERE event_type='left' AND occurred_at >= now() - interval '24 hours'
      )::integer AS left_24h,
      COUNT(*) FILTER (
        WHERE event_type='joined' AND occurred_at >= now() - interval '7 days'
      )::integer AS joined_7d,
      COUNT(*) FILTER (
        WHERE event_type='left' AND occurred_at >= now() - interval '7 days'
      )::integer AS left_7d
    FROM public.lr_channel_member_events
    WHERE channel_id=$1
      AND occurred_at >= COALESCE(
        (
          SELECT first_seen_at
          FROM public.lr_channel_metrics_state
          WHERE channel_id=$1
        ),
        now()
      )
  `, [channelId]))[0] || {};

  return {
    joined24: int(result.joined_24h),
    left24: int(result.left_24h),
    joined7d: int(result.joined_7d),
    left7d: int(result.left_7d),
  };
}

async function shouldScanMembers(channelId) {
  const state = rows(await query(`
    SELECT last_member_scan_at
    FROM public.lr_channel_metrics_state
    WHERE channel_id=$1
  `, [channelId]))[0];

  if (!state?.last_member_scan_at) return true;
  return Date.now() - new Date(state.last_member_scan_at).getTime() >= MEMBER_SCAN_INTERVAL_MS;
}

function chatAvatar(chatInfo, fallback = '') {
  return clean(
    chatInfo?.icon?.url ||
    chatInfo?.icon?.full_url ||
    chatInfo?.icon?.full_avatar_url ||
    chatInfo?.icon?.avatar_url ||
    chatInfo?.avatar_url ||
    fallback
  );
}

async function saveSnapshot(
  channel,
  chatInfo,
  posts,
  events,
  memberCountFromScan = null
) {
  /* LR_TRUTHFUL_VIEWS_ER_V80_2 */
  const subscribers = Math.max(
    0,
    int(
      chatInfo?.participants_count,
      memberCountFromScan ?? 0
    )
  );

  const snapshotKey = channelKey(
    clean(
      chatInfo?.link
      || channel.link
      || `max://chat/${channel.channelId}`
    ),
    channel.channelId
  );

  const previousDay = rows(await query(`
    SELECT subscribers
    FROM public.lr_channel_analytics_snapshots
    WHERE channel_key=$1
      AND collection_source='max_api_collector_v1'
      AND captured_at <= now() - interval '23 hours'
    ORDER BY captured_at DESC
    LIMIT 1
  `, [snapshotKey]).catch(() => []))[0];

  const latest = rows(await query(`
    SELECT subscribers
    FROM public.lr_channel_analytics_snapshots
    WHERE channel_key=$1
      AND collection_source='max_api_collector_v1'
    ORDER BY captured_at DESC
    LIMIT 1
  `, [snapshotKey]).catch(() => []))[0];

  const baseSubscribers =
    previousDay?.subscribers
    ?? latest?.subscribers
    ?? subscribers;

  const deltaDay =
    subscribers - int(baseSubscribers, subscribers);

  /*
   * ER24 = средние просмотры одного поста
   * из 24-часового окна / подписчики.
   * При отсутствии постов ER равен нулю.
   */
  const er24 =
    subscribers > 0 && posts.posts24 > 0
      ? (posts.views24 / subscribers) * 100
      : 0;

  const title = clean(
    chatInfo?.title
    || channel.title
    || 'Канал MAX'
  );

  const link = clean(
    chatInfo?.link
    || channel.link
    || `max://chat/${channel.channelId}`
  );

  const avatarUrl = chatAvatar(
    chatInfo,
    channel.avatarUrl
  );

  const raw = {
    source: 'max_api_collector_v1',
    views_semantics: 'average_views_per_post',
    chat: chatInfo,
    metrics: {
      subscribers,
      deltaDay,
      ...posts,
      ...events,
    },
    collected_at: new Date().toISOString(),
  };

  await query(`
    INSERT INTO public.lr_channel_analytics_snapshots (
      channel_key,
      link,
      title,
      avatar_url,
      subscribers,
      views24,
      views48,
      views72,
      er24,
      delta_day,
      raw,
      joined_24h,
      left_24h,
      joined_7d,
      left_7d,
      views_total,
      posts24,
      posts48,
      posts72,
      collection_source
    )
    VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,$9,$10,$11::jsonb,
      $12,$13,$14,$15,
      $16,$17,$18,$19,
      'max_api_collector_v1'
    )
  `, [
    snapshotKey,
    link,
    title,
    avatarUrl,
    subscribers,

    posts.views24,
    posts.views48,
    posts.views72,
    er24,
    deltaDay,
    JSON.stringify(raw),

    events.joined24,
    events.left24,
    events.joined7d,
    events.left7d,

    posts.viewsTotal,
    posts.posts24,
    posts.posts48,
    posts.posts72,
  ]);
}

async function ensureChannelState(channel) {
  const channelId = clean(channel?.channelId);
  if (!channelId) return;

  const enabledAtRaw =
    channel?.enabledAt ||
    channel?.raw?._analytics_enabled_at;

  const enabledAt =
    enabledAtRaw &&
    !Number.isNaN(new Date(enabledAtRaw).getTime())
      ? new Date(enabledAtRaw)
      : new Date();

  const readyAt = new Date(
    enabledAt.getTime() + ANALYTICS_WARMUP_MS
  );

  const previousState = rows(await query(`
    SELECT first_seen_at
    FROM public.lr_channel_metrics_state
    WHERE channel_id=$1
    LIMIT 1
  `, [channelId]).catch(() => []))[0];

  const restarted =
    previousState?.first_seen_at &&
    enabledAt.getTime() >
      new Date(previousState.first_seen_at).getTime();

  if (restarted) {
    await query(`
      DELETE FROM public.lr_channel_members_current
      WHERE channel_id=$1
    `, [channelId]).catch(() => {});
  }

  await query(`
    INSERT INTO public.lr_channel_metrics_state (
      channel_id,
      channel_title,
      channel_link,
      first_seen_at,
      ready_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (channel_id) DO UPDATE SET
      channel_title=COALESCE(
        NULLIF(EXCLUDED.channel_title, ''),
        public.lr_channel_metrics_state.channel_title
      ),
      channel_link=COALESCE(
        NULLIF(EXCLUDED.channel_link, ''),
        public.lr_channel_metrics_state.channel_link
      ),
      first_seen_at=CASE
        WHEN EXCLUDED.first_seen_at >
             public.lr_channel_metrics_state.first_seen_at
          THEN EXCLUDED.first_seen_at
        ELSE public.lr_channel_metrics_state.first_seen_at
      END,
      ready_at=CASE
        WHEN EXCLUDED.first_seen_at >
             public.lr_channel_metrics_state.first_seen_at
          THEN EXCLUDED.ready_at
        ELSE COALESCE(
          public.lr_channel_metrics_state.ready_at,
          EXCLUDED.ready_at
        )
      END,
      first_success_at=CASE
        WHEN EXCLUDED.first_seen_at >
             public.lr_channel_metrics_state.first_seen_at
          THEN NULL
        ELSE public.lr_channel_metrics_state.first_success_at
      END,
      success_count=CASE
        WHEN EXCLUDED.first_seen_at >
             public.lr_channel_metrics_state.first_seen_at
          THEN 0
        ELSE public.lr_channel_metrics_state.success_count
      END,
      baseline_complete=CASE
        WHEN EXCLUDED.first_seen_at >
             public.lr_channel_metrics_state.first_seen_at
          THEN false
        ELSE public.lr_channel_metrics_state.baseline_complete
      END,
      last_error=CASE
        WHEN EXCLUDED.first_seen_at >
             public.lr_channel_metrics_state.first_seen_at
          THEN NULL
        ELSE public.lr_channel_metrics_state.last_error
      END,
      updated_at=now()
  `, [
    channelId,
    clean(channel?.title),
    normalizeLink(channel?.link),
    enabledAt,
    readyAt,
  ]);
}

async function markCollectionSuccess(channel, {
  startedAt,
  memberScanAt = null,
  baselineComplete = false,
} = {}) {
  await ensureChannelState(channel);
  await query(`
    UPDATE public.lr_channel_metrics_state
    SET
      channel_title=COALESCE(NULLIF($2, ''), channel_title),
      channel_link=COALESCE(NULLIF($3, ''), channel_link),
      first_success_at=COALESCE(first_success_at, now()),
      ready_at=COALESCE(ready_at, now() + ($4::text || ' milliseconds')::interval),
      success_count=success_count + 1,
      baseline_complete=baseline_complete OR $5,
      last_collect_at=$6,
      last_member_scan_at=COALESCE($7, last_member_scan_at),
      last_success_at=now(),
      last_error=NULL,
      updated_at=now()
    WHERE channel_id=$1
  `, [
    clean(channel?.channelId),
    clean(channel?.title),
    normalizeLink(channel?.link),
    String(ANALYTICS_WARMUP_MS),
    Boolean(baselineComplete),
    startedAt || new Date(),
    memberScanAt,
  ]);
}

async function markCollectionFailure(channel, startedAt, errorMessage) {
  await ensureChannelState(channel);
  await query(`
    UPDATE public.lr_channel_metrics_state
    SET
      last_collect_at=$2,
      last_error=$3,
      updated_at=now()
    WHERE channel_id=$1
  `, [clean(channel?.channelId), startedAt || new Date(), clean(errorMessage).slice(0, 1000)]);
}

function countdownParts(milliseconds) {
  const total = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return { total, hours, minutes, seconds };
}

export function formatChannelMetricsCountdown(milliseconds) {
  const { hours, minutes, seconds } = countdownParts(milliseconds);
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function readinessRetryAt(state) {
  const now = Date.now();
  const warmupAt = state?.ready_at ? new Date(state.ready_at).getTime() : now + ANALYTICS_WARMUP_MS;
  const lastCollectAt = state?.last_collect_at
    ? new Date(state.last_collect_at).getTime()
    : now;
  let nextCollectionAt = lastCollectAt + COLLECT_INTERVAL_MS;
  if (nextCollectionAt <= now) nextCollectionAt = now + COLLECT_INTERVAL_MS;
  return new Date(Math.max(now + 1_000, warmupAt, nextCollectionAt));
}

/* LR_CHANNEL_SNAPSHOT_BY_CHAT_ID_V2 */
async function channelHasCollectorSnapshot(channel) {
  const normalized = normalizeLink(channel?.link);
  const id = clean(channel?.channelId);
  const key = channelKey(
    normalized || `max://chat/${id}`,
    id
  );

  const result = rows(await query(`
    SELECT 1
    FROM public.lr_channel_analytics_snapshots
    WHERE collection_source='max_api_collector_v1'
      AND (
        channel_key=$1
        OR link=$2
        OR raw #>> '{chat,chat_id}'=$3
        OR raw #>> '{chat,id}'=$3
        OR raw #>> '{chat,chat,id}'=$3
      )
    ORDER BY captured_at DESC
    LIMIT 1
  `, [key, normalized, id]).catch(() => []));

  return result.length > 0;
}

async function readinessForChannel(channel) {
  await ensureChannelState(channel);
  const state = rows(await query(`
    SELECT *
    FROM public.lr_channel_metrics_state
    WHERE channel_id=$1
    LIMIT 1
  `, [channel.channelId]))[0] || {};

  const hasSnapshot = await channelHasCollectorSnapshot(channel);
  const now = Date.now();
  const readyAtMs = state.ready_at
    ? new Date(state.ready_at).getTime()
    : now + ANALYTICS_WARMUP_MS;
  const enoughHistory = int(state.success_count) >= 2;
  const hasSuccess = Boolean(state.last_success_at);
  const ready = hasSuccess && hasSnapshot && enoughHistory && now >= readyAtMs;
  const retryAt = ready ? new Date(now) : readinessRetryAt(state);

  return {
    channelId: channel.channelId,
    title: channel.title || state.channel_title || 'Канал MAX',
    link: normalizeLink(channel.link || state.channel_link),
    ready,
    hasSnapshot,
    successCount: int(state.success_count),
    baselineComplete: Boolean(state.baseline_complete),
    firstSeenAt: state.first_seen_at || null,
    firstSuccessAt: state.first_success_at || null,
    lastSuccessAt: state.last_success_at || null,
    lastError: clean(state.last_error),
    readyAt: retryAt.toISOString(),
    waitMs: ready ? 0 : Math.max(0, retryAt.getTime() - now),
    reason: !hasSuccess
      ? (state.last_error ? 'collection_error' : 'collecting')
      : !hasSnapshot
        ? 'no_snapshot'
        : !enoughHistory || now < readyAtMs
          ? 'warming_up'
          : 'ready',
  };
}

export async function getChannelMetricsReadiness(links = []) {
  await ensureTables();
  const requested = [...new Set((Array.isArray(links) ? links : [links])
    .map(normalizeLink)
    .filter(Boolean))];
  const channels = await loadChannels();
  const matched = [];
  const missing = [];

  /* LR_CHANNEL_PRIVATE_LINK_MATCH_V2 */
  const usedChannelIds = new Set();

  for (const link of requested) {
    let channel = channels.find((item) =>
      !usedChannelIds.has(clean(item.channelId)) && (
        linksMatch(item.link, link) ||
        clean(item.channelId) === clean(link) ||
        clean(link).endsWith(`/${clean(item.channelId)}`)
      )
    );

    // Когда включён ровно один канал, он однозначно относится
    // к отправленной приватной join-ссылке.
    if (!channel && requested.length === 1 && channels.length === 1) {
      channel = {
        ...channels[0],
        link,
      };
    }

    if (channel) {
      usedChannelIds.add(clean(channel.channelId));
      matched.push(channel);
    } else {
      missing.push(link);
    }
  }

  if (matched.length) {
    void collectAllChannelMetrics().catch((error) => {
      console.error('[LR_CHANNEL_METRICS_READY_TRIGGER]', error?.message || error);
    });
  }

  const states = [];
  for (const channel of matched) {
    states.push(await readinessForChannel(channel));
  }

  const unready = states.filter((state) => !state.ready);
  const waitMs = unready.length
    ? Math.max(...unready.map((state) => int(state.waitMs)))
    : 0;
  const readyAt = unready.length
    ? new Date(Date.now() + waitMs).toISOString()
    : new Date().toISOString();

  return {
    ready: requested.length > 0 && missing.length === 0 && unready.length === 0,
    requested,
    channels: states,
    missing,
    waitMs,
    readyAt,
    countdown: formatChannelMetricsCountdown(waitMs),
    reason: missing.length
      ? 'not_connected'
      : unready.some((state) => state.reason === 'collection_error')
        ? 'collection_error'
        : unready.length
          ? 'warming_up'
          : 'ready',
  };
}

async function collectChannel(channel) {
  const startedAt = new Date();
  await ensureChannelState(channel);
  try {
    const chatInfo = await maxGet(`/chats/${encodeURIComponent(channel.channelId)}`);
    if (clean(chatInfo?.type).toLowerCase() !== 'channel') {
      return;
    }
    if (['removed', 'left', 'closed'].includes(clean(chatInfo?.status).toLowerCase())) {
      return;
    }

    const messages = await fetchRecentMessages(channel.channelId);
    await savePostMetrics(channel.channelId, messages);

    let scannedMemberCount = null;
    let scannedAt = null;
    if (await shouldScanMembers(channel.channelId)) {
      try {
        scannedMemberCount = await scanMembers(channel.channelId);
        scannedAt = new Date();
      } catch (error) {
        console.error(
          '[LR_CHANNEL_METRICS_MEMBER_SCAN]',
          channel.channelId,
          error?.message || error
        );
      }
    }

    const [posts, events] = await Promise.all([
      postSummary(channel.channelId),
      memberEventSummary(channel.channelId),
    ]);

    await saveSnapshot(channel, chatInfo, posts, events, scannedMemberCount);
    await markCollectionSuccess(channel, {
      startedAt,
      memberScanAt: scannedAt,
      baselineComplete: scannedMemberCount !== null,
    });

    console.log('[LR_CHANNEL_METRICS_OK]', JSON.stringify({
      channelId: channel.channelId,
      subscribers: int(chatInfo?.participants_count, scannedMemberCount || 0),
      views24: posts.views24,
      views48: posts.views48,
      views72: posts.views72,
      joined24: events.joined24,
      left24: events.left24,
      messages: messages.length,
    }));
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await markCollectionFailure(channel, startedAt, message).catch(() => {});
    console.error('[LR_CHANNEL_METRICS_ERROR]', channel.channelId, message);
  }
}

export async function collectAllChannelMetrics() {
  if (collectionRunning) return;
  collectionRunning = true;
  try {
    await ensureTables();
    const channels = await loadChannels();

    for (const channel of channels) {
      await collectChannel(channel);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    await query(`
      DELETE FROM public.lr_channel_member_events
      WHERE occurred_at < now() - ($1::text || ' days')::interval
    `, [String(METRICS_RETENTION_DAYS)]).catch(() => {});

    await query(`
      DELETE FROM public.lr_channel_analytics_snapshots
      WHERE captured_at < now() - ($1::text || ' days')::interval
    `, [String(METRICS_RETENTION_DAYS)]).catch(() => {});
  } finally {
    collectionRunning = false;
  }
}

async function isChannelMetricsEnabled(channelId) {
  const result = rows(await query(`
    SELECT 1
    FROM public.lr_channel_analytics_daily_channels d
    JOIN public.channels c
      ON (d.channel_id::text=c.id::text OR d.channel_id::text=c.max_chat_id::text)
    WHERE d.enabled=true
      AND c.is_active=true
      AND c.max_chat_id::text=$1
    LIMIT 1
  `, [String(channelId)]).catch(() => []));

  return result.length > 0;
}

function extractUpdates(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.updates)) return body.updates;
  if (Array.isArray(body?.data?.updates)) return body.data.updates;
  return body && typeof body === 'object' ? [body] : [];
}

export async function handleChannelMetricsUpdate(body) {
  await ensureTables();

  for (const update of extractUpdates(body)) {
    const type = clean(
      update?.update_type ||
      update?.type ||
      update?.event_type ||
      update?.body?.update_type
    ).toLowerCase();

    if (type !== 'user_added' && type !== 'user_removed') continue;

    const channelId = clean(
      update?.chat_id ||
      update?.chatId ||
      update?.chat?.id ||
      update?.body?.chat_id ||
      update?.message?.recipient?.chat_id
    );
    const user = update?.user || update?.body?.user || update?.member || {};
    const userId = clean(user?.user_id || user?.id || update?.user_id);
    if (!channelId || !/^-?\d+$/.test(channelId) || user?.is_bot) continue;
    if (!(await isChannelMetricsEnabled(channelId))) continue;

    const eventType = type === 'user_added' ? 'joined' : 'left';
    const occurredMs = unixMs(update?.timestamp || update?.event_time) || Date.now();

    await recordMemberEvent({
      channelId,
      eventType,
      userHash: userId ? memberHash(channelId, userId) : '',
      source: 'webhook',
      occurredAt: new Date(occurredMs),
      raw: update,
    });

    /* LR_AUDIENCE_IDENTITY_CAPTURE_V1 */
    await captureAudienceIdentity({
      update,
      channelId,
      eventType,
      occurredAt:
        new Date(occurredMs),
    }).catch((error) => {
      console.error(
        '[LR_AUDIENCE_IDENTITY_CAPTURE]',
        channelId,
        error?.stack ||
        error?.message ||
        error
      );
    });

  }
}

function middlewareLayerStack(app) {
  return app?._router?.stack || app?.router?.stack || [];
}

function moveMetricsMiddlewareBeforeWebhook(app, layer) {
  const stack = middlewareLayerStack(app);
  if (!stack.length || !layer) return;

  const ownIndex = stack.indexOf(layer);
  if (ownIndex < 0) return;
  stack.splice(ownIndex, 1);

  let targetIndex = stack.length;
  for (let index = 0; index < stack.length; index += 1) {
    const candidate = stack[index];
    const routePath = clean(candidate?.route?.path);
    const regexp = clean(candidate?.regexp);
    const name = clean(candidate?.name);
    if (
      /webhook/i.test(routePath) ||
      /webhook/i.test(regexp) ||
      /webhook/i.test(name)
    ) {
      targetIndex = index;
      break;
    }
  }

  stack.splice(targetIndex, 0, layer);
}

export function installChannelMetricsCollector(app) {
  if (installed) return;
  installed = true;

  ensureTables()
    .then(() => collectAllChannelMetrics())
    .catch((error) => {
      console.error('[LR_CHANNEL_METRICS_INIT]', error?.stack || error?.message || error);
    });

  collectorTimer = setInterval(() => {
    collectAllChannelMetrics().catch((error) => {
      console.error('[LR_CHANNEL_METRICS_TIMER]', error?.stack || error?.message || error);
    });
  }, COLLECT_INTERVAL_MS);
  collectorTimer.unref?.();

  if (app?.use) {
    const before = middlewareLayerStack(app).length;
    app.use(function lrChannelMetricsWebhook(req, _res, next) {
      try {
        const path = String(req?.path || req?.url || '');
        if (req?.method === 'POST' && /webhook/i.test(path)) {
          void handleChannelMetricsUpdate(req.body || {}).catch((error) => {
            console.error(
              '[LR_CHANNEL_METRICS_WEBHOOK]',
              error?.stack || error?.message || error
            );
          });
        }
      } catch (error) {
        console.error('[LR_CHANNEL_METRICS_MIDDLEWARE]', error?.message || error);
      }
      next();
    });

    const stack = middlewareLayerStack(app);
    const layer = stack[before] || stack[stack.length - 1];
    moveMetricsMiddlewareBeforeWebhook(app, layer);
  }

  console.log('[LR_CHANNEL_METRICS_INSTALLED]', JSON.stringify({
    apiBase: API_BASE,
    intervalMs: COLLECT_INTERVAL_MS,
    memberScanIntervalMs: MEMBER_SCAN_INTERVAL_MS,
    analyticsWarmupMs: ANALYTICS_WARMUP_MS,
  }));
}

export function stopChannelMetricsCollector() {
  if (collectorTimer) clearInterval(collectorTimer);
  collectorTimer = null;
  installed = false;
}
