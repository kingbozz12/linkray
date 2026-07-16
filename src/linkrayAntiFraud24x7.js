import { createLinkRayAntifraudBaselineV3 } from './linkrayAntifraudBaselineV3.js';
import { createLinkRayCohortEngine } from './linkrayAntifraudCohortEngineV2.js';
// LinkRay AntiFraud 24/7 v1
// Separate channel-protection module. Does not modify autoposting or Studio.

const MODULE_VERSION = '3.4.1';
const DEFAULT_OWNER_ID = '405954311';
const MAX_API_URL = String(
  process.env.MAX_API_URL ||
  process.env.MAX_BASE_URL ||
  process.env.MAX_API_BASE ||
  'https://platform-api2.max.ru'
).replace(/\/+$/, '');

function apiToken() {
  return String(
    process.env.MAX_TOKEN ||
    process.env.MAX_BOT_TOKEN ||
    process.env.MAX_ACCESS_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.ACCESS_TOKEN ||
    process.env.API_TOKEN ||
    process.env.TOKEN ||
    ''
  );
}

function ownerId() {
  return String(
    process.env.LR_OWNER_USER_ID ||
    process.env.OWNER_USER_ID ||
    process.env.ADMIN_USER_ID ||
    process.env.LR_OWNER_CHAT_ID ||
    process.env.OWNER_CHAT_ID ||
    process.env.ADMIN_CHAT_ID ||
    DEFAULT_OWNER_ID
  );
}

function rows(value) {
  return Array.isArray(value) ? value : (value?.rows || []);
}

function text(value, max = 4000) {
  const out = String(value ?? '').trim();
  if (!out) return '';
  return out.slice(0, max);
}

function idText(value) {
  const out = text(value, 120);
  if (!out || ['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(out.toLowerCase())) return '';
  return out;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function json(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((v) => text(v, 500)).filter(Boolean))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateType(update) {
  return text(
    update?.update_type ||
    update?.type ||
    update?.event_type ||
    update?.event ||
    update?.body?.update_type ||
    update?.body?.type ||
    '',
    100
  ).toLowerCase();
}

function callbackPayload(update) {
  return text(
    update?.payload ||
    update?.callback?.payload ||
    update?.message_callback?.payload ||
    update?.body?.payload ||
    update?.body?.callback?.payload ||
    update?.message?.payload ||
    '',
    500
  );
}

function callbackId(update) {
  return idText(
    update?.callback_id ||
    update?.callbackId ||
    update?.callback?.callback_id ||
    update?.callback?.id ||
    update?.message_callback?.callback_id ||
    update?.message_callback?.id ||
    update?.body?.callback_id ||
    update?.body?.callbackId ||
    update?.body?.callback?.callback_id ||
    update?.body?.callback?.id ||
    ''
  );
}

/* LR_ANTIFRAUD_RESCORE_SAME_MESSAGE_V9_START */
function messageId(update) {
  return idText(
    update?._edit_message_id ||
    update?.message_id ||
    update?.messageId ||
    update?.mid ||
    update?.message?.body?.mid ||
    update?.message?.mid ||
    update?.callback?.message?.body?.mid ||
    update?.callback?.message?.mid ||
    update?.message_callback?.message?.body?.mid ||
    update?.message_callback?.message?.mid ||
    update?.body?.message_id ||
    update?.body?.messageId ||
    update?.body?.mid ||
    update?.body?.message?.body?.mid ||
    update?.body?.message?.mid ||
    update?.body?.callback?.message?.body?.mid ||
    update?.body?.callback?.message?.mid ||
    ''
  );
}
/* LR_ANTIFRAUD_RESCORE_SAME_MESSAGE_V9_END */

function chatId(update) {
  return idText(
    update?.chat_id ||
    update?.chatId ||
    update?.chat?.id ||
    update?.recipient?.chat_id ||
    update?.message?.recipient?.chat_id ||
    update?.message?.recipient?.id ||
    update?.body?.chat_id ||
    update?.body?.chatId ||
    update?.body?.message?.recipient?.chat_id ||
    update?.body?.message?.recipient?.id ||
    ''
  );
}

function actorId(update) {
  return idText(
    update?.user_id ||
    update?.userId ||
    update?.sender?.user_id ||
    update?.sender?.id ||
    update?.callback?.user?.user_id ||
    update?.callback?.user?.id ||
    update?.message_callback?.user?.user_id ||
    update?.message_callback?.user?.id ||
    update?.message?.sender?.user_id ||
    update?.message?.sender?.id ||
    update?.body?.user_id ||
    update?.body?.userId ||
    update?.body?.sender?.user_id ||
    update?.body?.sender?.id ||
    update?.body?.message?.sender?.user_id ||
    update?.body?.message?.sender?.id ||
    ''
  );
}

function eventTimestamp(update) {
  const rawValue = update?.timestamp || update?.created_at || update?.body?.timestamp || Date.now();
  const numeric = Number(rawValue);
  if (Number.isFinite(numeric)) {
    if (numeric > 10_000_000_000) return new Date(numeric);
    if (numeric > 1_000_000_000) return new Date(numeric * 1000);
  }
  const parsed = new Date(rawValue);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function isoDateOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  let parsed;
  if (Number.isFinite(numeric)) {
    parsed = new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
  } else {
    parsed = new Date(value);
  }
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function eventUser(update) {
  const candidate =
    update?.user ||
    update?.member ||
    update?.chat_member ||
    update?.body?.user ||
    update?.body?.member ||
    update?.body?.chat_member ||
    update?.message?.user ||
    {};

  const userId = idText(
    candidate?.user_id ||
    candidate?.id ||
    update?.target_user_id ||
    update?.removed_user_id ||
    update?.user_id ||
    update?.userId ||
    update?.user_ids?.[0] ||
    update?.body?.target_user_id ||
    update?.body?.removed_user_id ||
    update?.body?.user_id ||
    update?.body?.userId ||
    update?.body?.user_ids?.[0] ||
    ''
  );

  const firstName = text(candidate?.first_name || candidate?.firstName || candidate?.name || '', 250);
  const lastName = text(candidate?.last_name || candidate?.lastName || '', 250);
  const displayName = text(`${firstName} ${lastName}`.trim() || candidate?.display_name || candidate?.username || `MAX ID ${userId}`, 500);
  const username = text(candidate?.username || candidate?.login || candidate?.handle || '', 250).replace(/^@/, '');
  const avatarUrl = text(
    candidate?.avatar_url ||
    candidate?.avatarUrl ||
    candidate?.photo_url ||
    candidate?.photoUrl ||
    candidate?.photo?.url ||
    candidate?.avatar ||
    '',
    1500
  );
  const lastActivity = candidate?.last_activity_time || candidate?.lastActivityTime || candidate?.last_seen || null;
  const isBot = Boolean(candidate?.is_bot ?? candidate?.isBot ?? candidate?.bot);
  const isAdmin = Boolean(candidate?.is_admin ?? candidate?.isAdmin ?? candidate?.admin);
  const isOwner = Boolean(candidate?.is_owner ?? candidate?.isOwner ?? candidate?.owner);

  return {
    userId,
    firstName,
    lastName,
    displayName,
    username,
    avatarUrl,
    lastActivity,
    isBot,
    isAdmin,
    isOwner,
    raw: candidate,
  };
}

function normalizeName(value) {
  return text(value, 500)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '')
    .replace(/\d+$/g, '');
}

function profileUrl(username) {
  const clean = text(username, 250).replace(/^@/, '');
  return clean ? `https://max.ru/${encodeURIComponent(clean)}` : '';
}


/* LR_ANTIFRAUD_CLICKABLE_PROFILES_V1_START */

/**
 * Штатное упоминание пользователя MAX.
 * Открывает профиль по user_id даже без username.
 */
function userMention(userId, displayName) {
  const safeId = idText(userId);
  const safeName = esc(
    displayName || (safeId ? `MAX ID ${safeId}` : 'Пользователь MAX')
  );

  if (!/^\d+$/.test(safeId)) return safeName;

  return `<a href="max://user/${safeId}">${safeName}</a>`;
}

/* LR_ANTIFRAUD_CLICKABLE_PROFILES_V1_END */

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(num(seconds)));
  if (s < 60) return `${s} сек`;
  if (s < 3600) return `${Math.floor(s / 60)} мин ${s % 60} сек`;
  return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
}

async function maxFetch(path, { method = 'GET', query = {}, body = null } = {}) {
  const token = apiToken();
  if (!token) throw new Error('MAX token not found');
  const url = new URL(`${MAX_API_URL}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = { Authorization: token };
  if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text().catch(() => '');
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
  if (!response.ok || data?.success === false) {
    const error = new Error(`MAX API ${method} ${url.pathname} ${response.status}: ${raw.slice(0, 500)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data || { success: true };
}


async function getMaxMember(maxChatId, userId) {
  const data = await maxFetch(
    `/chats/${encodeURIComponent(String(maxChatId))}/members`,
    {
      query: {
        user_ids: [String(userId)],
      },
    }
  );

  return (
    data?.members ||
    data?.chat?.members ||
    []
  )[0] || null;
}

async function getMaxParticipantCount(maxChatId) {
  const data = await maxFetch(`/chats/${encodeURIComponent(String(maxChatId))}`);
  const source = data?.chat || data || {};
  const candidates = [
    source.participants_count,
    source.members_count,
    source.subscribers_count,
    source.participant_count,
    source.membersCount,
    source.subscribersCount,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

async function removeMaxMember(maxChatId, userId) {
  return maxFetch(`/chats/${encodeURIComponent(String(maxChatId))}/members`, {
    method: 'DELETE',
    query: { user_id: String(userId), block: 'false' },
  });
}

function riskLabel(score, eligible = false) {
  if (eligible || score >= 85) return '🚨 высокий';
  if (score >= 55) return '⚠️ средний';
  return '✅ низкий';
}

function waveLevel(row) {
  const high = num(row?.high_count);
  const medium = num(row?.medium_count);
  const joined = num(row?.joined_count);
  if (high >= 5 || (joined >= 20 && high >= 3)) return 'высокий';
  if (high >= 1 || medium >= 5) return 'средний';
  return 'низкий';
}

export async function installLinkRayAntiFraud({
  query,
  callbackButton,
  linkButton,
  inlineKeyboard,
  answerCallback,
  sendMaxMessage,
  getChannels,
  logger = console,
} = {}) {
  if (typeof query !== 'function') throw new Error('AntiFraud requires query()');
  if (typeof callbackButton !== 'function') throw new Error('AntiFraud requires callbackButton()');
  if (typeof inlineKeyboard !== 'function') throw new Error('AntiFraud requires inlineKeyboard()');
  if (typeof answerCallback !== 'function') throw new Error('AntiFraud requires answerCallback()');
  if (typeof sendMaxMessage !== 'function') throw new Error('AntiFraud requires sendMaxMessage()');

  const log = (...args) => logger?.log?.('[LinkRay AntiFraud]', ...args);
  const warn = (...args) => logger?.warn?.('[LinkRay AntiFraud]', ...args);
  const error = (...args) => logger?.error?.('[LinkRay AntiFraud]', ...args);
  /* LR_ANTIFRAUD_COHORT_V2_START */
  let cohortEngine = null;
  /* LR_ANTIFRAUD_BASELINE_COUNTRY_V3_START */
  let baselineV3 = null;
  /* LR_ANTIFRAUD_BASELINE_COUNTRY_V3_END */
  /* LR_ANTIFRAUD_COHORT_V2_END */

  async function ensureSchema() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS lr_antifraud_channels (
        channel_id bigint PRIMARY KEY,
        max_chat_id text NOT NULL UNIQUE,
        title text,
        enabled boolean NOT NULL DEFAULT false,
        enabled_at timestamptz,
        disabled_at timestamptz,
        learning_started_at timestamptz,
        last_event_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS lr_antifraud_waves (
        id bigserial PRIMARY KEY,
        channel_id bigint NOT NULL,
        max_chat_id text NOT NULL,
        started_at timestamptz NOT NULL,
        last_event_at timestamptz NOT NULL,
        ended_at timestamptz,
        status text NOT NULL DEFAULT 'detected',
        participants_before integer,
        participants_after integer,
        joined_count integer NOT NULL DEFAULT 0,
        removed_count integer NOT NULL DEFAULT 0,
        high_count integer NOT NULL DEFAULT 0,
        medium_count integer NOT NULL DEFAULT 0,
        normal_count integer NOT NULL DEFAULT 0,
        max_bot_count integer NOT NULL DEFAULT 0,
        eligible_count integer NOT NULL DEFAULT 0,
        baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
        alert_sent boolean NOT NULL DEFAULT false,
        ignored_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS lr_antifraud_waves_channel_time_idx
       ON lr_antifraud_waves(channel_id, started_at DESC)`,
      `CREATE TABLE IF NOT EXISTS lr_antifraud_events (
        id bigserial PRIMARY KEY,
        event_key text NOT NULL UNIQUE,
        channel_id bigint NOT NULL,
        max_chat_id text NOT NULL,
        wave_id bigint REFERENCES lr_antifraud_waves(id) ON DELETE SET NULL,
        event_type text NOT NULL,
        event_at timestamptz NOT NULL,
        user_id text NOT NULL,
        first_name text,
        last_name text,
        display_name text,
        normalized_name text,
        username text,
        avatar_url text,
        is_bot boolean NOT NULL DEFAULT false,
        is_admin boolean NOT NULL DEFAULT false,
        is_owner boolean NOT NULL DEFAULT false,
        last_activity_time timestamptz,
        risk_score integer NOT NULL DEFAULT 0,
        risk_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
        strong_signals integer NOT NULL DEFAULT 0,
        removal_eligible boolean NOT NULL DEFAULT false,
        left_at timestamptz,
        raw jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS lr_antifraud_events_channel_time_idx
       ON lr_antifraud_events(channel_id, event_at DESC)`,
      `CREATE INDEX IF NOT EXISTS lr_antifraud_events_wave_risk_idx
       ON lr_antifraud_events(wave_id, removal_eligible DESC, risk_score DESC)`,
      `CREATE TABLE IF NOT EXISTS lr_antifraud_whitelist (
        channel_id bigint NOT NULL,
        user_id text NOT NULL,
        display_name text,
        added_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(channel_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS lr_antifraud_actions (
        id bigserial PRIMARY KEY,
        action_token text NOT NULL UNIQUE,
        wave_id bigint NOT NULL,
        channel_id bigint NOT NULL,
        action_type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        requested_by text,
        expires_at timestamptz NOT NULL,
        completed_at timestamptz,
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS lr_antifraud_removals (
        id bigserial PRIMARY KEY,
        action_id bigint REFERENCES lr_antifraud_actions(id) ON DELETE SET NULL,
        wave_id bigint NOT NULL,
        channel_id bigint NOT NULL,
        max_chat_id text NOT NULL,
        user_id text NOT NULL,
        display_name text,
        risk_score integer NOT NULL,
        status text NOT NULL,
        error text,
        removed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    ];
    for (const statement of statements) await query(statement);
  }

  async function channelList() {
    try {
      if (typeof getChannels === 'function') {
        const result = await getChannels();
        if (Array.isArray(result)) return result;
      }
    } catch (e) {
      warn('getChannels failed:', e?.message || e);
    }
    return rows(await query(`
      SELECT id, max_chat_id, title, link, is_active, updated_at
      FROM channels
      WHERE COALESCE(is_active, true)=true
      ORDER BY COALESCE(updated_at, bot_added_at, now()) DESC, id DESC
    `));
  }

  async function syncChannels() {
    const channels = await channelList();
    for (const channel of channels) {
      const internalId = num(channel?.id);
      const maxChatId = idText(channel?.max_chat_id || channel?.chat_id || channel?.channel_id);
      if (!internalId || !maxChatId) continue;
      await query(`
        INSERT INTO lr_antifraud_channels(channel_id, max_chat_id, title, updated_at)
        VALUES($1,$2,$3,now())
        ON CONFLICT(channel_id) DO UPDATE SET
          max_chat_id=EXCLUDED.max_chat_id,
          title=EXCLUDED.title,
          updated_at=now()
      `, [internalId, maxChatId, text(channel?.title || channel?.name || `Канал ${internalId}`, 500)]);
    }
    return channels;
  }

  async function configByMaxChatId(maxChatId) {
    const result = rows(await query(`
      SELECT af.*, c.title AS current_title, c.is_active
      FROM lr_antifraud_channels af
      LEFT JOIN channels c ON c.id=af.channel_id
      WHERE af.max_chat_id=$1
        AND COALESCE(c.is_active, true)=true
      LIMIT 1
    `, [String(maxChatId)]));
    return result[0] || null;
  }

  async function configByChannelId(channelId) {
    const result = rows(await query(`
      SELECT af.*, c.title AS current_title, c.is_active
      FROM lr_antifraud_channels af
      LEFT JOIN channels c ON c.id=af.channel_id
      WHERE af.channel_id=$1
      LIMIT 1
    `, [channelId]));
    return result[0] || null;
  }

  async function isWhitelisted(channelId, userId) {
    const result = rows(await query(`
      SELECT 1 FROM lr_antifraud_whitelist
      WHERE channel_id=$1 AND user_id=$2
      LIMIT 1
    `, [channelId, String(userId)]));
    return Boolean(result[0]);
  }

  async function recentCounts(channelId) {
    const result = rows(await query(`
      SELECT
        count(*) FILTER (WHERE event_at >= now() - interval '1 minute')::int AS c1,
        count(*) FILTER (WHERE event_at >= now() - interval '5 minutes')::int AS c5,
        count(*) FILTER (WHERE event_at >= now() - interval '15 minutes')::int AS c15,
        count(*) FILTER (WHERE event_at >= now() - interval '60 minutes')::int AS c60
      FROM lr_antifraud_events
      WHERE channel_id=$1 AND event_type='join'
    `, [channelId]));
    return result[0] || { c1: 0, c5: 0, c15: 0, c60: 0 };
  }

  async function baseline(channelId, enabledAt) {
    const enabled = enabledAt ? new Date(enabledAt) : new Date();
    const learningHours = Math.max(0, (Date.now() - enabled.getTime()) / 3_600_000);
    const result = rows(await query(`
      WITH bounds AS (
        SELECT GREATEST($2::timestamptz, now() - interval '7 days') AS started,
               now() - interval '60 minutes' AS finished
      ), buckets AS (
        SELECT gs AS bucket_start,
               count(e.id)::int AS joins
        FROM bounds b
        CROSS JOIN LATERAL generate_series(
          date_trunc('minute', b.started),
          date_trunc('minute', b.finished),
          interval '5 minutes'
        ) gs
        LEFT JOIN lr_antifraud_events e
          ON e.channel_id=$1
         AND e.event_type='join'
         AND e.event_at >= gs
         AND e.event_at < gs + interval '5 minutes'
        GROUP BY gs
      )
      SELECT
        count(*)::int AS bucket_count,
        COALESCE(avg(joins),0)::numeric AS avg5,
        COALESCE(stddev_pop(joins),0)::numeric AS std5,
        COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY joins),0)::numeric AS median5,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY joins),0)::numeric AS p95_5
      FROM buckets
    `, [channelId, enabled.toISOString()]));
    const row = result[0] || {};
    return {
      learningHours,
      bucketCount: num(row.bucket_count),
      avg5: num(row.avg5),
      std5: num(row.std5),
      median5: num(row.median5),
      p95_5: num(row.p95_5),
    };
  }

  function anomalyDecision(counts, base) {
    const c1 = num(counts.c1);
    const c5 = num(counts.c5);
    const c15 = num(counts.c15);
    const learned = base.learningHours >= 12 && base.bucketCount >= 24;

    const threshold5 = learned
      ? Math.max(8, Math.ceil(base.p95_5 + 4), Math.ceil(base.avg5 * 5 + 3), Math.ceil(base.avg5 + base.std5 * 5 + 3))
      : 12;
    const expected1 = learned ? Math.max(0.05, base.avg5 / 5) : 0.25;
    const threshold1 = learned ? Math.max(5, Math.ceil(expected1 * 8 + 2)) : 6;
    const threshold15 = Math.max(15, threshold5 * 2);
    const anomalous = c1 >= threshold1 || c5 >= threshold5 || c15 >= threshold15;
    const ratio = c5 / Math.max(1, base.avg5 || 1);

    return {
      anomalous,
      learned,
      threshold1,
      threshold5,
      threshold15,
      ratio,
      counts: { c1, c5, c15, c60: num(counts.c60) },
      base,
    };
  }

  async function openWave(channelId) {
    const result = rows(await query(`
      SELECT * FROM lr_antifraud_waves
      WHERE channel_id=$1
        AND status IN ('detected','review')
        AND last_event_at >= now() - interval '20 minutes'
      ORDER BY id DESC
      LIMIT 1
    `, [channelId]));
    return result[0] || null;
  }

  async function createWave(config, decision) {
    let participants = null;
    try { participants = await getMaxParticipantCount(config.max_chat_id); }
    catch (e) { warn('participants count failed:', e?.message || e); }

    const before = participants === null
      ? null
      : Math.max(0, participants - num(decision.counts.c5));

    const result = rows(await query(`
      INSERT INTO lr_antifraud_waves(
        channel_id,max_chat_id,started_at,last_event_at,status,
        participants_before,participants_after,baseline,updated_at
      )
      VALUES(
        $1,$2,now() - interval '5 minutes',now(),'detected',
        $3,$4,$5::jsonb,now()
      )
      RETURNING *
    `, [
      config.channel_id,
      config.max_chat_id,
      before,
      participants,
      JSON.stringify(decision),
    ]));
    return result[0];
  }

  async function scoreJoin({ config, user, eventAt, wave, decision }) {
    if (await isWhitelisted(config.channel_id, user.userId)) {
      return { score: 0, reasons: ['Пользователь находится в белом списке'], strongSignals: 0, eligible: false };
    }

    let score = 0;
    let strongSignals = 0;
    let identitySignals = 0;
    const reasons = [];

    if (user.isAdmin || user.isOwner) {
      return { score: 0, reasons: ['Администратор или владелец канала'], strongSignals: 0, eligible: false };
    }

    const prior = rows(await query(`
      SELECT user_id,event_at,normalized_name,is_bot
      FROM lr_antifraud_events
      WHERE channel_id=$1
        AND event_type='join'
        AND event_at < $2
        AND event_at >= $2::timestamptz - interval '15 minutes'
      ORDER BY event_at DESC
      LIMIT 30
    `, [config.channel_id, eventAt.toISOString()]));

    const previous = prior[0];
    if (previous?.event_at) {
      const intervalMs = Math.max(0, eventAt.getTime() - new Date(previous.event_at).getTime());
      if (intervalMs <= 1000) {
        score += 28; strongSignals += 1;
        reasons.push(`Вступление через ${Math.max(0.1, intervalMs / 1000).toFixed(1)} сек после предыдущего`);
      } else if (intervalMs <= 3000) {
        score += 18; strongSignals += 1;
        reasons.push(`Вступление через ${(intervalMs / 1000).toFixed(1)} сек после предыдущего`);
      } else if (intervalMs <= 10_000) {
        score += 7;
        reasons.push('Очень плотная серия вступлений');
      }
    }

    let flowSignal = false;
    if (decision.counts.c1 >= decision.threshold1) {
      score += 20;
      flowSignal = true;
      reasons.push(`${decision.counts.c1} вступлений за минуту`);
    }
    if (decision.counts.c5 >= decision.threshold5) {
      score += 20;
      flowSignal = true;
      reasons.push(`${decision.counts.c5} вступлений за 5 минут при пороге ${decision.threshold5}`);
    }
    if (flowSignal) strongSignals += 1; // One correlated traffic signal, not two independent signals.
    if (decision.ratio >= 5) {
      score += 10;
      reasons.push(`Поток выше нормы примерно в ${decision.ratio.toFixed(1)} раза`);
    }

    const currentId = /^\d+$/.test(user.userId) ? BigInt(user.userId) : null;
    if (currentId !== null) {
      let nearest = null;
      for (const item of prior.slice(0, 20)) {
        if (!/^\d+$/.test(String(item.user_id || ''))) continue;
        const diff = currentId > BigInt(item.user_id)
          ? currentId - BigInt(item.user_id)
          : BigInt(item.user_id) - currentId;
        if (nearest === null || diff < nearest) nearest = diff;
      }
      if (nearest !== null && nearest <= 3n) {
        score += 30; strongSignals += 1; identitySignals += 1;
        reasons.push(`MAX ID почти последовательный: расстояние ${nearest.toString()}`);
      } else if (nearest !== null && nearest <= 20n) {
        score += 18; strongSignals += 1; identitySignals += 1;
        reasons.push(`MAX ID находится в плотной последовательности: расстояние ${nearest.toString()}`);
      }
    }

    const normalized = normalizeName(user.displayName);
    if (normalized) {
      const sameName = prior.filter((item) => item.normalized_name === normalized).length;
      if (sameName >= 3) {
        score += 25; strongSignals += 1; identitySignals += 1;
        reasons.push(`Одинаковый шаблон имени найден у ${sameName + 1} участников`);
      } else if (sameName >= 1) {
        score += 8;
        reasons.push('Имя повторяется внутри наплыва');
      }
    }

    if (user.isBot) {
      score += 45;
      reasons.push('Профиль помечен MAX как бот');
      // is_bot alone is not enough for automatic eligibility.
    }
    if (!user.username) {
      score += 3;
      reasons.push('Нет публичного username — только слабый признак');
    }
    if (!user.avatarUrl) {
      score += 2;
      reasons.push('Нет аватара — только слабый признак');
    }

    score = clamp(Math.round(score), 0, 100);
    const eligible = Boolean(
      wave &&
      score >= 90 &&
      strongSignals >= 2 &&
      identitySignals >= 1 &&
      !user.isAdmin &&
      !user.isOwner
    );

    return { score, reasons: uniqueStrings(reasons), strongSignals, eligible };
  }

  async function backfillWave(config, wave, decision) {
    const recent = rows(await query(`
      SELECT *
      FROM lr_antifraud_events
      WHERE channel_id=$1
        AND event_type='join'
        AND event_at >= $2
        AND event_at <= now()
        AND (wave_id IS NULL OR wave_id=$3)
      ORDER BY event_at ASC,id ASC
    `, [config.channel_id, wave.started_at, wave.id]));

    for (const item of recent) {
      const user = {
        userId: String(item.user_id || ''),
        firstName: item.first_name || '',
        lastName: item.last_name || '',
        displayName: item.display_name || `MAX ID ${item.user_id}`,
        username: item.username || '',
        avatarUrl: item.avatar_url || '',
        lastActivity: item.last_activity_time || null,
        isBot: Boolean(item.is_bot),
        isAdmin: Boolean(item.is_admin),
        isOwner: Boolean(item.is_owner),
      };
      const eventAt = new Date(item.event_at);
      if (!user.userId || Number.isNaN(eventAt.getTime())) continue;
      const risk = await scoreJoin({ config, user, eventAt, wave, decision });
      await query(`
        UPDATE lr_antifraud_events SET
          wave_id=$2,
          risk_score=$3,
          risk_reasons=$4::jsonb,
          strong_signals=$5,
          removal_eligible=$6,
          updated_at=now()
        WHERE id=$1
      `, [item.id, wave.id, risk.score, JSON.stringify(risk.reasons), risk.strongSignals, risk.eligible]);
    }

    let participantCount = null;
    try { participantCount = await getMaxParticipantCount(config.max_chat_id); }
    catch (e) { warn('participant backfill refresh failed:', e?.message || e); }
    return refreshWave(wave.id, participantCount);
  }

  async function refreshWave(waveId, participantCount = null) {
    const result = rows(await query(`
      WITH stats AS (
        SELECT
          count(*) FILTER (WHERE event_type='join')::int AS joined_count,
          count(*) FILTER (WHERE event_type='leave')::int AS removed_count,
          count(*) FILTER (WHERE event_type='join' AND risk_score >= 85)::int AS high_count,
          count(*) FILTER (WHERE event_type='join' AND risk_score >= 55 AND risk_score < 85)::int AS medium_count,
          count(*) FILTER (WHERE event_type='join' AND risk_score < 55)::int AS normal_count,
          count(*) FILTER (WHERE event_type='join' AND is_bot=true)::int AS max_bot_count,
          count(*) FILTER (WHERE event_type='join' AND removal_eligible=true)::int AS eligible_count,
          max(event_at) AS last_event_at
        FROM lr_antifraud_events
        WHERE wave_id=$1
      )
      UPDATE lr_antifraud_waves w SET
        joined_count=COALESCE(s.joined_count,0),
        removed_count=COALESCE(s.removed_count,0),
        high_count=COALESCE(s.high_count,0),
        medium_count=COALESCE(s.medium_count,0),
        normal_count=COALESCE(s.normal_count,0),
        max_bot_count=COALESCE(s.max_bot_count,0),
        eligible_count=COALESCE(s.eligible_count,0),
        last_event_at=COALESCE(s.last_event_at,w.last_event_at),
        participants_after=COALESCE($2,w.participants_after,
          CASE WHEN w.participants_before IS NULL THEN NULL
               ELSE w.participants_before + COALESCE(s.joined_count,0) - COALESCE(s.removed_count,0)
          END),
        updated_at=now()
      FROM stats s
      WHERE w.id=$1
      RETURNING w.*
    `, [waveId, participantCount]));
    return result[0] || null;
  }

  
  /* LR_ANTIFRAUD_USER_ALERTS_V3_START */

  let alertDeliverySchemaPromise = null;

  function ensureAlertDeliverySchema() {
    if (alertDeliverySchemaPromise) return alertDeliverySchemaPromise;

    alertDeliverySchemaPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS public.lr_antifraud_alert_deliveries (
          wave_id bigint NOT NULL
            REFERENCES public.lr_antifraud_waves(id)
            ON DELETE CASCADE,
          channel_id bigint NOT NULL,
          user_id text NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          attempts integer NOT NULL DEFAULT 0,
          last_error text,
          sent_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (wave_id, user_id)
        )
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS
          lr_antifraud_alert_deliveries_status_idx
        ON public.lr_antifraud_alert_deliveries(
          status,
          updated_at DESC
        )
      `);
    })().catch((schemaError) => {
      alertDeliverySchemaPromise = null;
      throw schemaError;
    });

    return alertDeliverySchemaPromise;
  }

  async function channelAlertRecipients(channelId) {
    const linked = rows(await query(`
      SELECT DISTINCT u.max_user_id::text AS user_id
      FROM public.lr_users u
      JOIN public.lr_user_channels uc
        ON uc.user_id=u.id
      JOIN public.channels c
        ON c.id=uc.channel_id
      WHERE uc.channel_id=$1
        AND u.max_user_id IS NOT NULL
        AND length(trim(u.max_user_id::text))>0
        AND COALESCE(c.is_active, true)=true
      ORDER BY user_id
    `, [channelId]));

    const recipients = uniqueStrings(
      linked.map((item) => item.user_id)
    );

    if (recipients.length) return recipients;

    /*
     * Безопасный резерв: если старая запись канала ещё не связана с
     * lr_user_channels, уведомление не теряется и приходит владельцу
     * LinkRay для диагностики. После нормальной связи канала основной
     * получатель — пользователь канала.
     */
    const fallback = idText(ownerId());
    return fallback ? [fallback] : [];
  }

  async function claimAlertDelivery(waveId, channelId, userId) {
    const claimed = rows(await query(`
      INSERT INTO public.lr_antifraud_alert_deliveries(
        wave_id,
        channel_id,
        user_id,
        status,
        attempts,
        updated_at
      )
      VALUES($1,$2,$3,'pending',1,now())
      ON CONFLICT(wave_id,user_id)
      DO UPDATE SET
        status='pending',
        attempts=lr_antifraud_alert_deliveries.attempts+1,
        last_error=NULL,
        updated_at=now()
      WHERE lr_antifraud_alert_deliveries.status<>'sent'
      RETURNING *
    `, [waveId, channelId, String(userId)]));

    return Boolean(claimed[0]);
  }

  async function finishAlertDelivery(
    waveId,
    userId,
    status,
    lastError = null
  ) {
    await query(`
      UPDATE public.lr_antifraud_alert_deliveries
      SET
        status=$3,
        last_error=$4,
        sent_at=CASE WHEN $3='sent' THEN now() ELSE sent_at END,
        updated_at=now()
      WHERE wave_id=$1
        AND user_id=$2
    `, [
      waveId,
      String(userId),
      status,
      lastError ? text(lastError, 1500) : null,
    ]);
  }

  function unsafeWaveDecision(wave) {
    const joined = num(wave?.joined_count);
    const high = num(wave?.high_count);
    const medium = num(wave?.medium_count);
    const eligible = num(wave?.eligible_count);
    const baselineData = json(wave?.baseline, {});
    const ratio = num(baselineData?.ratio);

    const unsafe = Boolean(
      joined >= 8 &&
      (
        high >= 3 ||
        medium >= 6 ||
        eligible >= 1 ||
        ratio >= 5
      )
    );

    return {
      unsafe,
      joined,
      high,
      medium,
      eligible,
      ratio,
    };
  }

  function unsafeAlertButtons(wave) {
    const buttons = [
      [
        callbackButton(
          '🔎 Открыть наплыв',
          `fraud:wave:${wave.id}`
        ),
      ],
    ];

    if (num(wave.high_count) > 0) {
      buttons.push([
        callbackButton(
          `🚨 Высокий риск — ${num(wave.high_count)}`,
          `fraud:list:${wave.id}:high:0`
        ),
      ]);
    }

    if (num(wave.medium_count) > 0) {
      buttons.push([
        callbackButton(
          `⚠️ Средний риск — ${num(wave.medium_count)}`,
          `fraud:list:${wave.id}:medium:0`
        ),
      ]);
    }

    if (num(wave.eligible_count) > 0) {
      buttons.push([
        callbackButton(
          `🧹 Проверить очистку — ${num(wave.eligible_count)}`,
          `fraud:remove_prompt:${wave.id}`
        ),
      ]);
    }

    return buttons;
  }

  async function notifyWave(wave) {
    if (!wave || wave.status === 'ignored') return;

    const decision = unsafeWaveDecision(wave);
    if (!decision.unsafe) return;

    await ensureAlertDeliverySchema();

    const channel = await configByChannelId(wave.channel_id);
    const recipients = await channelAlertRecipients(wave.channel_id);
    const level = waveLevel(wave);

    if (!recipients.length) {
      warn(
        `unsafe wave ${wave.id}: no alert recipients for channel `
        + `${wave.channel_id}`
      );
      return;
    }

    const textBody =
      `━━━━━━━━━━━━━━\n` +
      `🚨 LinkRay обнаружил небезопасный наплыв\n\n` +
      `Канал: ${esc(
        channel?.current_title ||
        channel?.title ||
        wave.max_chat_id
      )}\n` +
      `Начало: ${formatDate(wave.started_at)}\n\n` +
      `ПДП до наплыва: ${
        wave.participants_before ?? 'уточняется'
      }\n` +
      `ПДП сейчас: ${
        wave.participants_after ?? 'уточняется'
      }\n` +
      `Пришло: +${decision.joined}\n\n` +
      `🚨 Высокий риск: ${decision.high}\n` +
      `⚠️ Средний риск: ${decision.medium}\n` +
      `✅ Вероятно живые: ${num(wave.normal_count)}\n` +
      `🤖 Боты MAX: ${num(wave.max_bot_count)}\n` +
      `🧹 Можно проверить для очистки: ${decision.eligible}\n\n` +
      `Уровень угрозы: ${level}\n` +
      `Никто не удалён автоматически.\n` +
      `Откройте наплыв и проверьте участников.\n` +
      `━━━━━━━━━━━━━━`;

    const attachments = inlineKeyboard(
      unsafeAlertButtons(wave)
    );

    let delivered = 0;
    let failed = 0;

    for (const recipient of recipients) {
      const claimed = await claimAlertDelivery(
        wave.id,
        wave.channel_id,
        recipient
      );

      if (!claimed) continue;

      try {
        await sendMaxMessage({
          userId: recipient,
          text: textBody,
          format: 'html',
          attachments,
          purpose: 'antifraud_unsafe_wave_alert',
        });

        await finishAlertDelivery(
          wave.id,
          recipient,
          'sent'
        );
        delivered += 1;
      } catch (sendError) {
        const message = text(
          sendError?.message || sendError,
          1500
        );

        await finishAlertDelivery(
          wave.id,
          recipient,
          'failed',
          message
        );

        failed += 1;
        error(
          `unsafe wave ${wave.id}: alert to `
          + `${recipient} failed: ${message}`
        );
      }
    }

    if (delivered > 0) {
      await query(`
        UPDATE public.lr_antifraud_waves
        SET
          alert_sent=true,
          updated_at=now()
        WHERE id=$1
      `, [wave.id]);

      log(
        `unsafe wave ${wave.id}: delivered to `
        + `${delivered} channel user(s)`
      );
    }

    if (failed > 0) {
      warn(
        `unsafe wave ${wave.id}: ${failed} delivery failure(s); `
        + `they will be retried`
      );
    }
  }

  async function maybeNotify(wave) {
    if (!wave || wave.status === 'ignored') return;

    const decision = unsafeWaveDecision(wave);
    if (!decision.unsafe) return;

    /*
     * alert_sent больше не блокирует отправку. Старые версии могли
     * поставить этот флаг после отправки глобальному ownerId().
     * Таблица доставок гарантирует одно сообщение на пользователя
     * и позволяет безопасно повторять неудачные попытки.
     */
    await notifyWave(wave);
  }

  async function replayRecentUnsafeAlerts() {
    await ensureAlertDeliverySchema();

    const recentWaves = rows(await query(`
      SELECT *
      FROM public.lr_antifraud_waves
      WHERE status<>'ignored'
        AND started_at>=now()-interval '24 hours'
      ORDER BY started_at DESC
      LIMIT 100
    `));

    for (const wave of recentWaves) {
      try {
        await maybeNotify(wave);
      } catch (replayError) {
        error(
          `unsafe wave ${wave.id}: replay failed:`,
          replayError?.stack ||
          replayError?.message ||
          replayError
        );
      }
    }
  }

  /* LR_ANTIFRAUD_USER_ALERTS_V3_END */

async function recordJoin(update) {
    const maxChatId = chatId(update);
    const user = eventUser(update);
    if (!maxChatId || !user.userId) return;
    const config = await configByMaxChatId(maxChatId);
    if (!config?.enabled) return;

    const eventAt = eventTimestamp(update);
    const eventKey = `join:${maxChatId}:${user.userId}:${eventAt.getTime()}`;
    const inserted = rows(await query(`
      INSERT INTO lr_antifraud_events(
        event_key,channel_id,max_chat_id,event_type,event_at,user_id,
        first_name,last_name,display_name,normalized_name,username,avatar_url,
        is_bot,is_admin,is_owner,last_activity_time,raw,updated_at
      )
      VALUES($1,$2,$3,'join',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,now())
      ON CONFLICT(event_key) DO NOTHING
      RETURNING *
    `, [
      eventKey,
      config.channel_id,
      maxChatId,
      eventAt.toISOString(),
      user.userId,
      user.firstName,
      user.lastName,
      user.displayName,
      normalizeName(user.displayName),
      user.username || null,
      user.avatarUrl || null,
      user.isBot,
      user.isAdmin,
      user.isOwner,
      isoDateOrNull(user.lastActivity),
      JSON.stringify(update || {}),
    ]));
    if (!inserted[0]) return;

    await query(`UPDATE lr_antifraud_channels SET last_event_at=$2, updated_at=now() WHERE channel_id=$1`, [config.channel_id, eventAt.toISOString()]);

    const counts = await recentCounts(config.channel_id);
    const base = await baseline(config.channel_id, config.enabled_at || config.learning_started_at || config.updated_at);
    const decision = anomalyDecision(counts, base);
    let wave = await openWave(config.channel_id);
    let createdNow = false;
    if (!wave && decision.anomalous) {
      wave = await createWave(config, decision);
      createdNow = Boolean(wave);
    }

    if (!wave) return;
    if (createdNow) {
      wave = await backfillWave(config, wave, decision);
      await maybeNotify(wave);
      return;
    }

    const risk = await scoreJoin({ config, user, eventAt, wave, decision });
    await query(`
      UPDATE lr_antifraud_events SET
        wave_id=$2,
        risk_score=$3,
        risk_reasons=$4::jsonb,
        strong_signals=$5,
        removal_eligible=$6,
        updated_at=now()
      WHERE id=$1
    `, [inserted[0].id, wave.id, risk.score, JSON.stringify(risk.reasons), risk.strongSignals, risk.eligible]);

    let participantCount = null;
    const currentJoined = num(wave.joined_count) + 1;
    if (currentJoined === 1 || currentJoined % 5 === 0) {
      try { participantCount = await getMaxParticipantCount(maxChatId); }
      catch (e) { warn('participant refresh failed:', e?.message || e); }
    }
    wave = await refreshWave(wave.id, participantCount);
    await maybeNotify(wave);
  }

  async function recordLeave(update) {
    const maxChatId = chatId(update);
    const user = eventUser(update);
    if (!maxChatId || !user.userId) return;
    const config = await configByMaxChatId(maxChatId);
    if (!config?.enabled) return;
    const eventAt = eventTimestamp(update);
    const eventKey = `leave:${maxChatId}:${user.userId}:${eventAt.getTime()}`;
    const wave = await openWave(config.channel_id);

    await query(`
      INSERT INTO lr_antifraud_events(
        event_key,channel_id,max_chat_id,wave_id,event_type,event_at,user_id,
        first_name,last_name,display_name,normalized_name,username,avatar_url,
        is_bot,is_admin,is_owner,raw,updated_at
      )
      VALUES($1,$2,$3,$4,'leave',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,now())
      ON CONFLICT(event_key) DO NOTHING
    `, [
      eventKey,
      config.channel_id,
      maxChatId,
      wave?.id || null,
      eventAt.toISOString(),
      user.userId,
      user.firstName,
      user.lastName,
      user.displayName,
      normalizeName(user.displayName),
      user.username || null,
      user.avatarUrl || null,
      user.isBot,
      user.isAdmin,
      user.isOwner,
      JSON.stringify(update || {}),
    ]);

    await query(`
      UPDATE lr_antifraud_events SET left_at=$3, updated_at=now()
      WHERE id=(
        SELECT id FROM lr_antifraud_events
        WHERE channel_id=$1 AND user_id=$2 AND event_type='join' AND left_at IS NULL
        ORDER BY event_at DESC LIMIT 1
      )
    `, [config.channel_id, user.userId, eventAt.toISOString()]);

    if (wave) await refreshWave(wave.id);
  }

  async function closeStaleWaves() {
    const stale = rows(await query(`
      UPDATE lr_antifraud_waves
      SET status=CASE WHEN status='review' THEN status ELSE 'closed' END,
          ended_at=COALESCE(ended_at,last_event_at),
          updated_at=now()
      WHERE status='detected'
        AND last_event_at < now() - interval '12 minutes'
      RETURNING id
    `));
    if (stale.length) log('closed stale waves:', stale.map((x) => x.id).join(','));
    await query(`DELETE FROM lr_antifraud_actions WHERE expires_at < now() - interval '1 day'`).catch(() => {});
  }

  function actorAllowed(update) {
    const actor = actorId(update) || chatId(update);
    return Boolean(actor && actor === ownerId());
  }

  
async function render(update, body, buttons = [], notification = '') {
    const cbId = callbackId(update);
    const actor = actorId(update) || ownerId();
    const attachments = buttons?.length
      ? inlineKeyboard(buttons)
      : [];

    const editMessageId = idText(
      update?._edit_message_id
    );

    if (editMessageId) {
      return maxFetch('/messages', {
        method: 'PUT',
        query: {
          message_id: editMessageId,
        },
        body: {
          text: body,
          format: 'html',
          attachments,
          notify: false,
        },
      });
    }

    if (cbId) {
      return answerCallback({
        callbackId: cbId,
        text: body,
        format: 'html',
        attachments,
        notification,
      });
    }

    if (update?._do_not_send_new_message) {
      log(
        'render skipped new message: original message id unavailable'
      );
      return {
        success: false,
        skipped: true,
      };
    }

    return sendMaxMessage({
      userId: actor,
      text: body,
      format: 'html',
      attachments,
      purpose: 'antifraud_menu',
    });
  }

  async function showMenu(update) {
    await syncChannels();
    const list = rows(await query(`
      SELECT af.*,
        COALESCE(c.title,af.title,af.max_chat_id) AS display_title,
        COALESCE((
          SELECT count(*) FROM lr_antifraud_events e
          WHERE e.channel_id=af.channel_id
            AND e.event_type='join'
            AND e.risk_score>=55
            AND e.event_at>=now()-interval '24 hours'
        ),0)::int AS suspicious_24h,
        COALESCE((
          SELECT count(*) FROM lr_antifraud_waves w
          WHERE w.channel_id=af.channel_id
            AND w.started_at>=now()-interval '24 hours'
        ),0)::int AS waves_24h
      FROM lr_antifraud_channels af
      LEFT JOIN channels c ON c.id=af.channel_id
      WHERE COALESCE(c.is_active,true)=true
      ORDER BY display_title ASC
    `));

    const buttons = [];
    for (const channel of list.slice(0, 15)) {
      const status = channel.enabled ? '🟢' : '🔴';
      const suffix = channel.enabled && num(channel.suspicious_24h) > 0 ? ` · ⚠️ ${num(channel.suspicious_24h)}` : '';
      buttons.push([callbackButton(`${status} ${text(channel.display_title, 45)}${suffix}`, `fraud:channel:${channel.channel_id}`)]);
    }
    if (list.length) {
      buttons.push([
        callbackButton('✅ Включить для всех', 'fraud:enable_all'),
        callbackButton('⛔ Выключить для всех', 'fraud:disable_all'),
      ]);
    }
    buttons.push([callbackButton('⬅️ В меню', 'main:menu')]);

    const enabled = list.filter((x) => x.enabled).length;
    return render(update,
      `━━━━━━━━━━━━━━\n🛡 <b>LinkRay AntiFraud 24/7</b>\n\n` +
      `Защита включается отдельно для каждого канала и работает постоянно.\n` +
      `Система сначала фиксирует наплыв, затем оценивает только участников этой волны.\n\n` +
      `<b>Подключено каналов:</b> ${list.length}\n` +
      `<b>Защищено:</b> ${enabled}\n\n` +
      `Автоматического удаления нет: очистка доступна только после проверки и двойного подтверждения.\n━━━━━━━━━━━━━━`,
      buttons
    );
  }

  async function showChannel(update, channelId) {
    const channel = await configByChannelId(channelId);
    if (!channel) return showUserMenu(update);
    const stats = rows(await query(`
      SELECT
        count(*) FILTER (WHERE event_type='join' AND event_at>=now()-interval '24 hours')::int AS joins24,
        count(*) FILTER (WHERE event_type='leave' AND event_at>=now()-interval '24 hours')::int AS leaves24,
        count(*) FILTER (WHERE event_type='join' AND risk_score>=55 AND event_at>=now()-interval '24 hours')::int AS suspicious24,
        count(*) FILTER (WHERE event_type='join' AND removal_eligible=true AND event_at>=now()-interval '24 hours')::int AS eligible24
      FROM lr_antifraud_events WHERE channel_id=$1
    `, [channelId]))[0] || {};
    const lastWave = rows(await query(`
      SELECT * FROM lr_antifraud_waves WHERE channel_id=$1 ORDER BY started_at DESC LIMIT 1
    `, [channelId]))[0];

    const buttons = [
      [callbackButton(channel.enabled ? '⛔ Выключить защиту' : '✅ Включить защиту', `fraud:toggle:${channelId}`)],
      [callbackButton('📋 История наплывов', `fraud:waves:${channelId}:0`)],
    ];
    if (lastWave) buttons.push([callbackButton('🔎 Последний наплыв', `fraud:wave:${lastWave.id}`)]);
    buttons.push([callbackButton('⬅️ К каналам', 'fraud:menu')]);

    return render(update,
      `━━━━━━━━━━━━━━\n🛡 <b>${esc(channel.current_title || channel.title || channel.max_chat_id)}</b>\n\n` +
      `<b>Защита:</b> ${channel.enabled ? '🟢 включена 24/7' : '🔴 выключена'}\n` +
      `<b>Наблюдение с:</b> ${channel.enabled_at ? formatDate(channel.enabled_at) : '—'}\n\n` +
      `<b>За последние 24 часа</b>\n` +
      `Подписались: +${num(stats.joins24)}\n` +
      `Отписались: -${num(stats.leaves24)}\n` +
      `Подозрительных: ${num(stats.suspicious24)}\n` +
      `Допущено к безопасной очистке: ${num(stats.eligible24)}\n\n` +
      `В первые часы используются строгие безопасные пороги. Затем LinkRay изучает нормальный темп именно этого канала.\n━━━━━━━━━━━━━━`,
      buttons
    );
  }

  async function toggleChannel(update, channelId) {
    const channel = await configByChannelId(channelId);
    if (!channel) return showUserMenu(update);
    const next = !channel.enabled;
    await query(`
      UPDATE lr_antifraud_channels SET
        enabled=$2,
        enabled_at=CASE WHEN $2 THEN now() ELSE enabled_at END,
        learning_started_at=CASE WHEN $2 THEN now() ELSE learning_started_at END,
        disabled_at=CASE WHEN $2 THEN NULL ELSE now() END,
        updated_at=now()
      WHERE channel_id=$1
    `, [channelId, next]);
    return showChannel(update, channelId);
  }

  async function setAll(enabled) {
    await syncChannels();
    await query(`
      UPDATE lr_antifraud_channels SET
        enabled=$1,
        enabled_at=CASE WHEN $1 AND enabled=false THEN now() ELSE enabled_at END,
        learning_started_at=CASE WHEN $1 AND enabled=false THEN now() ELSE learning_started_at END,
        disabled_at=CASE WHEN $1 THEN NULL ELSE now() END,
        updated_at=now()
    `, [enabled]);
  }

  async function showWaves(update, channelId, page = 0) {
    const channel = await configByChannelId(channelId);
    if (!channel) return showUserMenu(update);
    const limit = 8;
    const list = rows(await query(`
      SELECT * FROM lr_antifraud_waves
      WHERE channel_id=$1
      ORDER BY started_at DESC
      LIMIT $2 OFFSET $3
    `, [channelId, limit + 1, page * limit]));
    const hasNext = list.length > limit;
    const visible = list.slice(0, limit);
    const buttons = visible.map((wave) => [callbackButton(
      `${waveLevel(wave) === 'высокий' ? '🚨' : waveLevel(wave) === 'средний' ? '⚠️' : '✅'} ${formatDate(wave.started_at)} · +${num(wave.joined_count)}`,
      `fraud:wave:${wave.id}`
    )]);
    const nav = [];
    if (page > 0) nav.push(callbackButton('⬅️', `fraud:waves:${channelId}:${page - 1}`));
    if (hasNext) nav.push(callbackButton('➡️', `fraud:waves:${channelId}:${page + 1}`));
    if (nav.length) buttons.push(nav);
    buttons.push([callbackButton('⬅️ К каналу', `fraud:channel:${channelId}`)]);

    return render(update,
      `━━━━━━━━━━━━━━\n📋 <b>История наплывов</b>\n\n` +
      `<b>Канал:</b> ${esc(channel.current_title || channel.title || channel.max_chat_id)}\n` +
      `<b>Страница:</b> ${page + 1}\n\n` +
      (visible.length ? 'Выберите обнаруженный период.' : 'Обнаруженных наплывов пока нет.') +
      `\n━━━━━━━━━━━━━━`,
      buttons
    );
  }

  async function waveById(waveId) {
    return rows(await query(`SELECT * FROM lr_antifraud_waves WHERE id=$1 LIMIT 1`, [waveId]))[0] || null;
  }

  async function showWave(update, waveId) {
    const wave = await waveById(waveId);

    if (!wave) return showUserMenu(update);

    const channel = await configByChannelId(wave.channel_id);
    const summary = json(wave.cohort_summary, {});
    const elapsed = (
      new Date(wave.ended_at || wave.last_event_at).getTime() -
      new Date(wave.started_at).getTime()
    ) / 1000;

    const probable = num(wave.probable_bot_count);
    const eligible = num(wave.eligible_count);
    const review = num(wave.review_count);
    const joined = num(wave.joined_count);
    const official = num(
      wave.official_bot_count ?? wave.max_bot_count
    );
    const confidence = Math.round(
      num(wave.cohort_confidence) * 100
    );

    const buttons = [
      [
        callbackButton(
          `🤖 Вероятные боты — ${probable}`,
          `fraud:list:${wave.id}:bots:0`
        ),
      ],
    ];

    if (probable > 0) {
      buttons.push([
        callbackButton(
          `🧹 Очистить вероятных — ${probable}`,
          `fraud:cleanup_prompt:${wave.id}:probable`
        ),
      ]);
    }

    if (joined > 0) {
      buttons.push([
        callbackButton(
          `🌊 Очистить весь наплыв — ${joined}`,
          `fraud:cleanup_prompt:${wave.id}:wave`
        ),
      ]);
    }

    if (eligible > 0) {
      buttons.push([
        callbackButton(
          `🛡 Безопасная очистка — ${eligible}`,
          `fraud:cleanup_prompt:${wave.id}:safe`
        ),
      ]);
    }

    buttons.push([
      callbackButton(
        `⚠️ Требуют проверки — ${review}`,
        `fraud:list:${wave.id}:review:0`
      ),
    ]);

    buttons.push([
      callbackButton(
        `✅ Вероятно живые — ${num(wave.normal_count)}`,
        `fraud:list:${wave.id}:human:0`
      ),
    ]);

    if (official > 0) {
      buttons.push([
        callbackButton(
          `🧩 Боты MAX — ${official}`,
          `fraud:list:${wave.id}:official:0`
        ),
      ]);
    }

    buttons.push([
      callbackButton(
        '🔄 Пересчитать наплыв',
        `fraud:rescore:${wave.id}`
      ),
    ]);

    if (wave.status !== 'ignored') {
      buttons.push([
        callbackButton(
          '🚫 Игнорировать наплыв',
          `fraud:ignore:${wave.id}`
        ),
      ]);
    }

    buttons.push([
      callbackButton(
        '⬅️ К истории',
        `fraud:waves:${wave.channel_id}:0`
      ),
    ]);

    return render(
      update,
      `━━━━━━━━━━━━━━\n` +
      `🛡 Проверка наплыва\n\n` +
      `Канал: ${esc(
        channel?.current_title ||
        channel?.title ||
        wave.max_chat_id
      )}\n` +
      `Период: ${formatDate(wave.started_at)} — ` +
      `${formatDate(wave.ended_at || wave.last_event_at)}\n` +
      `Длительность: ${formatDuration(elapsed)}\n\n` +
      `ПДП до наплыва: ${
        wave.participants_before ?? 'уточняется'
      }\n` +
      `ПДП после: ${
        wave.participants_after ?? 'уточняется'
      }\n` +
      `Общий приток: +${joined}\n` +
      `Ушли во время волны: -${num(wave.removed_count)}\n\n` +
      `🤖 Вероятные боты: ${probable}\n` +
      `🛡 Безопасные кандидаты: ${eligible}\n` +
      `⚠️ Требуют ручной проверки: ${review}\n` +
      `✅ Вероятно живые: ${num(wave.normal_count)}\n` +
      `🧩 Официальные боты MAX: ${official}\n\n` +
      `Уверенность алгоритма: ${confidence}%\n` +
      `Медианный интервал: ` +
      `${num(summary.median_gap_seconds).toFixed(1)} сек\n` +
      `Плотность машинной серии: ` +
      `${Math.round(num(summary.dense_share) * 100)}%\n\n` +
      `Безопасная очистка использует строгие пороги. ` +
      `Очистка вероятных и всего наплыва запускается ` +
      `только вручную после отдельного подтверждения.\n\n` +
      `Перед удалением LinkRay повторно проверяет каждого ` +
      `участника и не удаляет владельцев, администраторов, ` +
      `белый список и уже вышедших.\n` +
      `━━━━━━━━━━━━━━`,
      buttons
    );
  }
  function riskFilter(category) {
    if (category === 'bots') {
      return `bot_class IN (
        'official_max_bot',
        'high_confidence_bot',
        'likely_bot'
      )`;
    }

    if (category === 'eligible') return `removal_eligible=true`;

    if (category === 'review') {
      return `removal_eligible=false
        AND bot_class IN ('likely_bot','suspicious')`;
    }

    if (category === 'human') return `bot_class='likely_human'`;
    if (category === 'official') return `bot_class='official_max_bot'`;

    if (category === 'high') return `bot_probability>=85`;
    if (category === 'medium') {
      return `bot_probability>=55 AND bot_probability<85`;
    }
    if (category === 'normal') return `bot_probability<55`;

    return `true`;
  }
  async function showRiskList(update, waveId, category, page = 0) {
    const wave = await waveById(waveId);
    if (!wave) return showUserMenu(update);

    const limit = 5;
    const list = rows(await query(`
      SELECT *
      FROM lr_antifraud_events
      WHERE wave_id=$1
        AND event_type='join'
        AND ${riskFilter(category)}
      ORDER BY
        removal_eligible DESC,
        bot_probability DESC,
        event_at ASC
      LIMIT $2 OFFSET $3
    `, [waveId, limit + 1, page * limit]));

    const visible = list.slice(0, limit);
    const hasNext = list.length > limit;

    const markerFor = (item) => {
      if (item.removal_eligible) return '🚨';
      if (item.bot_class === 'official_max_bot') return '🧩';
      if (
        item.bot_class === 'high_confidence_bot' ||
        item.bot_class === 'likely_bot'
      ) return '🤖';
      if (item.bot_class === 'suspicious') return '⚠️';
      return '✅';
    };

    const lines = visible.map((item, index) => (
      `${index + 1 + page * limit}. ` +
      `${markerFor(item)} ` +
      `${userMention(item.user_id, item.display_name || `MAX ID ${item.user_id}`)}\n` +
      `MAX ID: ${esc(item.user_id)} · ` +
      `вероятность ${num(item.bot_probability)}/100` +
      `${item.is_bot ? ' · официальный бот MAX' : ''}`
    ));

    const buttons = visible.map((item) => [
      callbackButton(
        `${markerFor(item)} ` +
        `${text(item.display_name || item.user_id, 30)} · ` +
        `${num(item.bot_probability)}`,
        `fraud:member:${waveId}:${item.id}`
      ),
    ]);

    const nav = [];

    if (page > 0) {
      nav.push(
        callbackButton(
          '⬅️',
          `fraud:list:${waveId}:${category}:${page - 1}`
        )
      );
    }

    if (hasNext) {
      nav.push(
        callbackButton(
          '➡️',
          `fraud:list:${waveId}:${category}:${page + 1}`
        )
      );
    }

    if (nav.length) buttons.push(nav);

    buttons.push([
      callbackButton(
        '⬅️ К наплыву',
        `fraud:wave:${waveId}`
      ),
    ]);

    const labels = {
      bots: 'Вероятные боты',
      eligible: 'Проверка перед удалением',
      review: 'Требуют ручной проверки',
      human: 'Вероятно живые',
      official: 'Официальные боты MAX',
      high: 'Высокая вероятность',
      medium: 'Средняя вероятность',
      normal: 'Вероятно живые',
    };

    return render(
      update,
      `━━━━━━━━━━━━━━\n` +
      `${category === 'bots' ? '🤖' : category === 'eligible' ? '🚨' : '🔎'} ` +
      `${labels[category] || 'Участники наплыва'}\n\n` +
      (
        lines.length
          ? lines.join('\n\n')
          : 'В этой категории никого нет.'
      ) +
      `\n\nНажмите на имя, чтобы открыть профиль MAX.\n━━━━━━━━━━━━━━`,
      buttons
    );
  }
  
  

/* LR_ANTIFRAUD_NO_MANUAL_COUNTRY_V8_START */
async function showMember(update, waveId, eventId) {
    const item = rows(await query(`
      SELECT *
      FROM lr_antifraud_events
      WHERE id=$1
        AND wave_id=$2
        AND event_type='join'
      LIMIT 1
    `, [eventId, waveId]))[0];

    if (!item) return showWave(update, waveId);

    const reasons = Array.isArray(item.risk_reasons)
      ? item.risk_reasons
      : json(item.risk_reasons, []);

    const buttons = [];
    const url = profileUrl(item.username);

    if (url) {
      if (typeof linkButton === 'function') {
        buttons.push([
          linkButton('🔗 Открыть профиль MAX', url),
        ]);
      } else {
        buttons.push([{
          type: 'link',
          text: '🔗 Открыть профиль MAX',
          url,
        }]);
      }
    }

    buttons.push([
      callbackButton(
        '✅ Это живой — в белый список',
        `fraud:whitelist:${waveId}:${eventId}`
      ),
    ]);

    


    buttons.push([
      callbackButton(
        '⬅️ К вероятным ботам',
        `fraud:list:${waveId}:bots:0`
      ),
    ]);

    const labels = {
      official_max_bot: 'официальный бот MAX',
      high_confidence_bot: 'бот с высокой уверенностью',
      likely_bot: 'вероятный бот',
      suspicious: 'требует проверки',
      likely_human: 'вероятно живой',
      unknown: 'не определён',
    };

    return render(
      update,
      `━━━━━━━━━━━━━━\n` +
      `🔎 ${userMention(item.user_id, item.display_name || `MAX ID ${item.user_id}`)}\n\n` +
      `Нажмите на имя выше, чтобы открыть профиль MAX.\n\n` +
      `MAX ID: ${esc(item.user_id)}\n` +
      `Username: ${item.username ? `@${esc(item.username)}` : 'нет'}\n` +
      `Вступил: ${formatDate(item.event_at)}\n` +
      `Класс: ${labels[item.bot_class] || labels.unknown}\n` +
      `Вероятность бота: ${num(item.bot_probability)}/100\n` +
      `Независимых сильных признаков: ` +
      `${num(item.cohort_strong_signals ?? item.strong_signals)}\n`
      +
      `Официальный бот MAX: ${item.is_bot ? 'да' : 'нет'}\n` +
      `Допущен к проверке удаления: ` +
      `${item.removal_eligible ? 'да' : 'нет'}\n\n` +
      `Причины оценки\n` +
      (
        reasons.length
          ? reasons.map((reason) => `• ${esc(reason)}`).join('\n')
          : '• Сильных признаков не найдено'
      ) +
      `\n\nАватар не участвует в решении об удалении. ` +
      `Отсутствие username или активности само по себе недостаточно.\n` +
      `━━━━━━━━━━━━━━`,
      buttons
    );
  }
/* LR_ANTIFRAUD_NO_MANUAL_COUNTRY_V8_END */
  async function whitelistMember(update, waveId, eventId) {
    const item = rows(await query(`SELECT * FROM lr_antifraud_events WHERE id=$1 AND wave_id=$2 LIMIT 1`, [eventId, waveId]))[0];
    if (!item) return showWave(update, waveId);
    await query(`
      INSERT INTO lr_antifraud_whitelist(channel_id,user_id,display_name,added_at)
      VALUES($1,$2,$3,now())
      ON CONFLICT(channel_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,added_at=now()
    `, [item.channel_id, item.user_id, item.display_name]);
    await query(`
      UPDATE lr_antifraud_events SET risk_score=0,risk_reasons='["Белый список"]'::jsonb,
        strong_signals=0,removal_eligible=false,updated_at=now()
      WHERE channel_id=$1 AND user_id=$2
    `, [item.channel_id, item.user_id]);
    await refreshWave(waveId);
    return showMember(update, waveId, eventId);
  }

  async function ignoreWave(update, waveId) {
    const wave = await waveById(waveId);
    if (!wave) return showUserMenu(update);
    await query(`UPDATE lr_antifraud_waves SET status='ignored',ignored_at=now(),updated_at=now() WHERE id=$1`, [waveId]);
    return showWave(update, waveId);
  }

  /* LR_ANTIFRAUD_CLEANUP_MODES_V3_START */

  function cleanupMode(mode) {
    if (mode === 'safe') {
      return {
        key: 'safe',
        actionType: 'remove_high_confidence_bots',
        title: 'Безопасная очистка',
        button: '🛡 Подтвердить безопасную очистку',
        warning:
          'Будут удалены только кандидаты, прошедшие строгие пороги.',
      };
    }

    if (mode === 'wave') {
      return {
        key: 'wave',
        actionType: 'remove_entire_wave',
        title: 'Очистить весь наплыв',
        button: '🌊 Подтвердить очистку наплыва',
        warning:
          'Будут удалены все доступные участники этой волны. ' +
          'В наплыве могут находиться живые люди.',
      };
    }

    return {
      key: 'probable',
      actionType: 'remove_probable_bots',
      title: 'Очистить вероятных ботов',
      button: '🧹 Подтвердить очистку ботов',
      warning:
        'Будут удалены профили, которые алгоритм отнёс ' +
        'к вероятным ботам. Это ручное решение владельца канала.',
    };
  }

  async function cleanupCandidates(waveId, mode = 'safe') {
    const selectedMode = cleanupMode(mode);

    let modeFilter = `
      e.removal_eligible=true
      AND e.bot_probability>=92
      AND e.cohort_strong_signals>=3
      AND e.bot_class IN (
        'official_max_bot',
        'high_confidence_bot'
      )
    `;

    if (selectedMode.key === 'probable') {
      modeFilter = `
        e.bot_probability>=80
        AND e.bot_class IN (
          'official_max_bot',
          'high_confidence_bot',
          'likely_bot'
        )
      `;
    }

    if (selectedMode.key === 'wave') {
      modeFilter = `true`;
    }

    return rows(await query(`
      SELECT e.*
      FROM lr_antifraud_events e
      LEFT JOIN lr_antifraud_whitelist w
        ON w.channel_id=e.channel_id
       AND w.user_id=e.user_id
      WHERE e.wave_id=$1
        AND e.event_type='join'
        AND (${modeFilter})
        AND e.is_admin=false
        AND e.is_owner=false
        AND e.left_at IS NULL
        AND w.user_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.lr_users owner_user
          JOIN public.lr_user_channels owner_channel
            ON owner_channel.user_id=owner_user.id
          WHERE owner_channel.channel_id=e.channel_id
            AND owner_user.max_user_id::text=e.user_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM lr_antifraud_removals r
          WHERE r.wave_id=e.wave_id
            AND r.user_id=e.user_id
            AND r.status='removed'
        )
      ORDER BY
        e.removal_eligible DESC,
        e.bot_probability DESC,
        e.event_at ASC
    `, [waveId]));
  }

  async function eligibleCandidates(waveId) {
    return cleanupCandidates(waveId, 'safe');
  }

  
async function cleanupPrompt(update, waveId, mode = 'safe') {
    const wave = await waveById(waveId);

    if (!wave) return showUserMenu(update);

    const selectedMode = cleanupMode(mode);
    const candidates = await cleanupCandidates(
      waveId,
      selectedMode.key
    );

    const candidateIds = uniqueStrings(
      candidates.map((candidate) => String(candidate.user_id))
    ).slice(0, 1000);

    const token =
      `${Date.now().toString(36)}` +
      `${Math.random().toString(36).slice(2, 10)}`;

    const action = rows(await query(`
      INSERT INTO lr_antifraud_actions(
        action_token,
        wave_id,
        channel_id,
        action_type,
        status,
        requested_by,
        expires_at,
        result
      )
      VALUES(
        $1,$2,$3,$4,
        'pending',
        $5,
        now()+interval '30 minutes',
        $6::jsonb
      )
      RETURNING *
    `, [
      token,
      waveId,
      wave.channel_id,
      selectedMode.actionType,
      actorId(update) || ownerId(),
      JSON.stringify({
        cleanup_mode: selectedMode.key,
        candidate_count: candidates.length,
        candidate_user_ids: candidateIds,
        wave_updated_at: wave.updated_at || null,
      }),
    ]))[0];

    if (!action) {
      throw new Error('Failed to create AntiFraud cleanup action');
    }

    const expectedAfter =
      wave.participants_after === null ||
      wave.participants_after === undefined
        ? 'уточняется'
        : Math.max(
            0,
            num(wave.participants_after) - candidates.length
          );

    const listCategory =
      selectedMode.key === 'safe'
        ? 'eligible'
        : selectedMode.key === 'probable'
          ? 'bots'
          : 'all';

    const buttons = [
      [
        callbackButton(
          `🔎 Посмотреть кандидатов — ${candidates.length}`,
          `fraud:list:${waveId}:${listCategory}:0`
        ),
      ],
    ];

    if (candidates.length > 0) {
      buttons.push([
        callbackButton(
          selectedMode.button,
          `fraud:remove_confirm:${action.action_token}`
        ),
      ]);
    }

    buttons.push([
      callbackButton(
        '⬅️ Отмена',
        `fraud:wave:${waveId}`
      ),
    ]);

    return render(
      update,
      `━━━━━━━━━━━━━━\n` +
      `${selectedMode.key === 'wave' ? '🌊' : '🧹'} ` +
      `${selectedMode.title}\n\n` +
      `Кандидатов: ${candidates.length}\n` +
      `Вероятных ботов в волне: ` +
      `${num(wave.probable_bot_count)}\n` +
      `Всего вступили в волну: ${num(wave.joined_count)}\n` +
      `Уверенность алгоритма: ` +
      `${Math.round(num(wave.cohort_confidence) * 100)}%\n\n` +
      `ПДП до наплыва: ${
        wave.participants_before ?? 'уточняется'
      }\n` +
      `ПДП сейчас: ${
        wave.participants_after ?? 'уточняется'
      }\n` +
      `Ожидаемый ПДП после: ${expectedAfter}\n\n` +
      `⚠️ ${selectedMode.warning}\n\n` +
      `После подтверждения очистка запустится в фоне. ` +
      `LinkRay повторно проверит каждого участника через MAX, ` +
      `не удалит владельцев, администраторов, белый список, ` +
      `пользователей LinkRay и уже вышедших.\n\n` +
      `Право удаления и фактический ответ MAX будут проверены ` +
      `непосредственно перед первой очисткой.\n` +
      `━━━━━━━━━━━━━━`,
      buttons
    );
  }

  async function removalPrompt(update, waveId) {
    return cleanupPrompt(update, waveId, 'safe');
  }

  /* LR_ANTIFRAUD_CLEANUP_MODES_V3_END */
  function memberFlags(member) {
    return {
      isAdmin: Boolean(member?.is_admin ?? member?.isAdmin ?? member?.admin),
      isOwner: Boolean(member?.is_owner ?? member?.isOwner ?? member?.owner),
    };
  }

  
  /* LR_ANTIFRAUD_STABLE_WORKERS_V7_START */

  const runningRemovalActions = new Set();

  function backgroundUpdateForUser(userId) {
    const target = idText(userId) || ownerId();

    return {
      user_id: String(target),
      chat_id: String(target),
      payload: '',
    };
  }

  function actionModeFromType(actionType) {
    return {
      remove_high_confidence_bots: 'safe',
      remove_probable_bots: 'probable',
      remove_entire_wave: 'wave',
    }[actionType] || 'safe';
  }

  function maxErrorStatus(errorValue) {
    const direct = Number(errorValue?.status);
    if (Number.isFinite(direct)) return direct;

    const match = String(
      errorValue?.message || errorValue || ''
    ).match(/\b(400|401|403|404|405|409|429|500|502|503|504)\b/);

    return match ? Number(match[1]) : 0;
  }

  function shortMaxError(errorValue) {
    const status = maxErrorStatus(errorValue);

    if (status === 401) {
      return 'MAX отклонил токен бота.';
    }

    if (status === 403 || status === 405) {
      return (
        'MAX не разрешил боту удалить подписчика. ' +
        'Проверьте право add_remove_members. ' +
        'Для некоторых каналов платформа ограничивает удаление ' +
        'подписчиков через токен бота.'
      );
    }

    if (status === 404) {
      return 'Участник уже отсутствует в канале.';
    }

    if (status === 429) {
      return 'MAX временно ограничил частоту запросов.';
    }

    if (status >= 500) {
      return 'Временная ошибка MAX API.';
    }

    return text(
      errorValue?.message || errorValue || 'Неизвестная ошибка MAX',
      500
    );
  }

  function isPermissionFailure(errorValue) {
    return [401, 403, 405].includes(
      maxErrorStatus(errorValue)
    );
  }

  async function removeMaxMemberWithRetry(maxChatId, userId) {
    const delays = [0, 800, 1800, 3500];
    let lastError = null;

    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) {
        await sleep(delays[attempt]);
      }

      try {
        return await removeMaxMember(maxChatId, userId);
      } catch (removeError) {
        lastError = removeError;
        const status = maxErrorStatus(removeError);

        if (
          ![429, 500, 502, 503, 504].includes(status) ||
          attempt === delays.length - 1
        ) {
          throw removeError;
        }
      }
    }

    throw lastError || new Error('MAX removal failed');
  }

  async function writeRemovalRecord(
    action,
    candidate,
    status,
    errorText = ''
  ) {
    await query(`
      INSERT INTO lr_antifraud_removals(
        action_id,
        wave_id,
        channel_id,
        max_chat_id,
        user_id,
        display_name,
        risk_score,
        status,
        error,
        removed_at
      )
      VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        CASE WHEN $8='removed' THEN now() ELSE NULL END
      )
    `, [
      action.id,
      action.wave_id,
      candidate.channel_id,
      candidate.max_chat_id,
      candidate.user_id,
      candidate.display_name,
      num(
        candidate.bot_probability ??
        candidate.risk_score
      ),
      status,
      errorText || null,
    ]);
  }

  async function saveRemovalProgress(actionId, result) {
    await query(`
      UPDATE lr_antifraud_actions
      SET result=$2::jsonb
      WHERE id=$1
    `, [
      actionId,
      JSON.stringify(result),
    ]).catch(() => {});
  }

  
async function runRemovalAction(actionId, deliveryUpdate) {
    /* LR_ANTIFRAUD_CLEANUP_PROGRESS_V11_START */
    if (runningRemovalActions.has(actionId)) return;

    runningRemovalActions.add(actionId);

    try {
      const action = rows(await query(`
        SELECT *
        FROM lr_antifraud_actions
        WHERE id=$1
          AND status='running'
        LIMIT 1
      `, [actionId]))[0];

      if (!action) return;

      const wave = await waveById(action.wave_id);

      if (!wave) {
        throw new Error('AntiFraud wave not found');
      }

      const actionResult = json(action.result, {});
      const actionMode = actionModeFromType(action.action_type);
      const snapshotIds = new Set(
        uniqueStrings(actionResult.candidate_user_ids || [])
      );

      let candidates = await cleanupCandidates(
        action.wave_id,
        actionMode
      );

      if (snapshotIds.size) {
        candidates = candidates.filter(
          (candidate) => snapshotIds.has(
            String(candidate.user_id)
          )
        );
      }

      const selected = candidates.slice(0, 1000);

      const result = {
        ...actionResult,
        mode: actionMode,
        requested: candidates.length,
        processed: 0,
        removed: 0,
        skipped: 0,
        failed: 0,
        platform_denied: false,
        rate_limited: false,
        started_at: new Date().toISOString(),
        errors: [],
      };

      const modeTitle = {
        safe: 'Безопасная очистка',
        probable: 'Очистка вероятных ботов',
        wave: 'Очистка всего наплыва',
      }[actionMode] || 'Очистка';

      const updateProgress = async (
        statusText = 'Очистка выполняется'
      ) => {
        if (!deliveryUpdate?._edit_message_id) return;

        const total = Math.max(0, num(result.requested));
        const processed = Math.min(
          total || num(result.processed),
          num(result.processed)
        );
        const percent = total > 0
          ? Math.min(
              100,
              Math.round(processed / total * 100)
            )
          : 100;

        const cells = 12;
        const filled = Math.min(
          cells,
          Math.round(percent / 100 * cells)
        );
        const progressBar =
          '█'.repeat(filled) +
          '░'.repeat(cells - filled);

        await render(
          deliveryUpdate,
          `━━━━━━━━━━━━━━\n` +
          `🧹 ${modeTitle}\n\n` +
          `${statusText}\n\n` +
          `Кандидатов: ${total}\n` +
          `Проверено: ${processed}/${total}\n` +
          `Удалено: ${num(result.removed)}\n` +
          `Безопасно пропущено: ${num(result.skipped)}\n` +
          `Ошибок MAX API: ${num(result.failed)}\n\n` +
          `${progressBar} ${percent}%\n\n` +
          `Не запускайте очистку повторно — ` +
          `текущий процесс уже работает.\n` +
          `━━━━━━━━━━━━━━`,
          []
        ).catch((progressError) => {
          warn(
            `removal action ${action.id}: ` +
            `progress update failed:`,
            progressError?.message || progressError
          );
        });
      };

      await updateProgress('Очистка началась');

      try {
        if (cohortEngine) {
          result.capability =
            await cohortEngine.checkRemovalCapability(
              wave.max_chat_id
            );
        }
      } catch (capabilityError) {
        result.capability = {
          known: false,
          error: shortMaxError(capabilityError),
        };
      }

      for (const candidate of selected) {
        let removalStatus = 'failed';
        let removalError = '';

        try {
          if (
            await isWhitelisted(
              candidate.channel_id,
              candidate.user_id
            )
          ) {
            removalStatus = 'skipped_whitelist';
            result.skipped += 1;
          } else {
            const liveMember = await getMaxMember(
              candidate.max_chat_id || wave.max_chat_id,
              candidate.user_id
            );

            if (!liveMember) {
              removalStatus = 'skipped_absent';
              result.skipped += 1;
            } else {
              const flags = memberFlags(liveMember);

              const linkedOwner = rows(await query(`
                SELECT 1
                FROM public.lr_users owner_user
                JOIN public.lr_user_channels owner_channel
                  ON owner_channel.user_id=owner_user.id
                WHERE owner_channel.channel_id=$1
                  AND owner_user.max_user_id::text=$2
                LIMIT 1
              `, [
                candidate.channel_id,
                String(candidate.user_id),
              ]));

              if (
                flags.isAdmin ||
                flags.isOwner ||
                linkedOwner[0]
              ) {
                removalStatus = 'skipped_protected';
                result.skipped += 1;
              } else {
                await removeMaxMemberWithRetry(
                  candidate.max_chat_id || wave.max_chat_id,
                  candidate.user_id
                );

                removalStatus = 'removed';
                result.removed += 1;
              }
            }
          }
        } catch (removeError) {
          const status = maxErrorStatus(removeError);
          removalError = shortMaxError(removeError);

          if (status === 404) {
            removalStatus = 'skipped_absent';
            result.skipped += 1;
          } else {
            removalStatus = 'failed';
            result.failed += 1;

            result.errors.push({
              user_id: String(candidate.user_id),
              status,
              error: removalError,
            });

            if (isPermissionFailure(removeError)) {
              result.platform_denied = true;
            }

            if (status === 429) {
              result.rate_limited = true;
            }
          }
        }

        result.processed += 1;

        await writeRemovalRecord(
          action,
          candidate,
          removalStatus,
          removalError
        );

        const shouldUpdateProgress =
          result.processed === 1 ||
          result.processed % 10 === 0 ||
          result.processed === selected.length ||
          result.platform_denied ||
          result.rate_limited;

        if (
          result.processed % 10 === 0 ||
          result.platform_denied ||
          result.rate_limited
        ) {
          await saveRemovalProgress(action.id, result);
        }

        if (shouldUpdateProgress) {
          await updateProgress('Очистка выполняется');
        }

        if (
          result.platform_denied ||
          result.rate_limited
        ) {
          break;
        }

        await sleep(350);
      }

      let participants = null;

      try {
        participants = await getMaxParticipantCount(
          wave.max_chat_id
        );
      } catch (participantError) {
        result.participant_count_error =
          shortMaxError(participantError);
      }

      const updatedWave = await refreshWave(
        wave.id,
        participants
      );

      result.completed_at = new Date().toISOString();

      const finalStatus =
        result.platform_denied
          ? 'failed'
          : 'completed';

      await query(`
        UPDATE lr_antifraud_actions
        SET
          status=$2,
          completed_at=now(),
          result=$3::jsonb
        WHERE id=$1
      `, [
        action.id,
        finalStatus,
        JSON.stringify(result),
      ]);

      const platformText = result.platform_denied
        ? (
            `\n\n⛔ MAX отклонил удаление через токен бота.\n` +
            `Проверьте право add_remove_members ` +
            `у LinkRay в этом канале.`
          )
        : '';

      const rateText = result.rate_limited
        ? (
            `\n\n⚠️ MAX временно ограничил частоту запросов.\n` +
            `Повторный запуск продолжит очистку оставшихся.`
          )
        : '';

      await render(
        deliveryUpdate,
        `━━━━━━━━━━━━━━\n` +
        `${result.platform_denied ? '⚠️' : '✅'} ` +
        `${modeTitle} завершена\n\n` +
        `Найдено кандидатов: ${result.requested}\n` +
        `Проверено: ${result.processed}\n` +
        `Удалено: ${result.removed}\n` +
        `Безопасно пропущено: ${result.skipped}\n` +
        `Ошибок MAX API: ${result.failed}\n` +
        (
          result.requested > result.processed
            ? `Осталось: ${
                result.requested - result.processed
              }\n`
            : ''
        ) +
        `\nПДП до наплыва: ${
          updatedWave?.participants_before ?? 'уточняется'
        }\n` +
        `ПДП после очистки: ${
          updatedWave?.participants_after ?? 'уточняется'
        }` +
        platformText +
        rateText +
        `\n━━━━━━━━━━━━━━`,
        [
          [
            callbackButton(
              '🔎 Открыть наплыв',
              `fraud:wave:${wave.id}`
            ),
          ],
          [
            callbackButton(
              '⬅️ К каналам',
              'fraud:menu'
            ),
          ],
        ]
      );
    } catch (workerError) {
      error(
        `removal action ${actionId} failed:`,
        workerError?.stack ||
        workerError?.message ||
        workerError
      );

      await query(`
        UPDATE lr_antifraud_actions
        SET
          status='failed',
          completed_at=now(),
          result=
            COALESCE(result, '{}'::jsonb) ||
            jsonb_build_object(
              'worker_error',
              $2,
              'completed_at',
              now()::text
            )
        WHERE id=$1
      `, [
        actionId,
        text(
          workerError?.message || workerError,
          1000
        ),
      ]).catch(() => {});

      await render(
        deliveryUpdate,
        `━━━━━━━━━━━━━━\n` +
        `⚠️ Очистка остановлена\n\n` +
        `Причина записана в журнал AntiFraud.\n` +
        `Сохранённые данные и кандидаты не удалены.\n` +
        `━━━━━━━━━━━━━━`,
        [[
          callbackButton(
            '⬅️ К каналам',
            'fraud:menu'
          ),
        ]]
      ).catch(() => {});
    } finally {
      runningRemovalActions.delete(actionId);
    }
    /* LR_ANTIFRAUD_CLEANUP_PROGRESS_V11_END */
  }

  /* LR_ANTIFRAUD_STABLE_WORKERS_V7_END */

  

async function executeRemoval(update, actionToken) {
    const safeToken = text(actionToken, 200);
    const actor =
      actorId(update) ||
      chatId(update) ||
      ownerId();
    const originalMessageId = messageId(update);

    await render(
      update,
      `━━━━━━━━━━━━━━\n` +
      `🧹 Очистка началась\n\n` +
      `Подготавливаю список кандидатов и проверяю доступ.\n` +
      `Прогресс будет обновляться в этой карточке.\n\n` +
      `Не нажимайте кнопку повторно.\n` +
      `━━━━━━━━━━━━━━`,
      [],
      'Очистка началась'
    );

    const deliveryUpdate = originalMessageId
      ? {
          ...backgroundUpdateForUser(actor),
          _edit_message_id: originalMessageId,
          _do_not_send_new_message: true,
        }
      : backgroundUpdateForUser(actor);

    const timer = setTimeout(async () => {
      try {
        const action = rows(await query(`
          SELECT *
          FROM lr_antifraud_actions
          WHERE action_token=$1::text
          LIMIT 1
        `, [safeToken]))[0];

        if (!action) {
          await render(
            deliveryUpdate,
            `━━━━━━━━━━━━━━\n` +
            `⚠️ Подтверждение очистки не найдено\n\n` +
            `Откройте карточку наплыва и создайте ` +
            `подтверждение заново.\n` +
            `━━━━━━━━━━━━━━`,
            [[
              callbackButton('⬅️ К каналам', 'fraud:menu'),
            ]]
          );
          return;
        }

        if (
          String(action.requested_by || ownerId()) !==
          String(actor)
        ) {
          await render(
            deliveryUpdate,
            `━━━━━━━━━━━━━━\n` +
            `⛔ Подтверждение создано другим пользователем\n\n` +
            `Участники не удалялись.\n` +
            `━━━━━━━━━━━━━━`,
            [[
              callbackButton('⬅️ К каналам', 'fraud:menu'),
            ]]
          );
          return;
        }

        const allowed = await userCanManageChannel(
          {
            user_id: String(actor),
            chat_id: String(actor),
          },
          action.channel_id
        );

        if (!allowed) {
          await render(
            deliveryUpdate,
            `━━━━━━━━━━━━━━\n` +
            `⛔ Нет доступа к очистке этого канала\n\n` +
            `Участники не удалялись.\n` +
            `━━━━━━━━━━━━━━`,
            [[
              callbackButton(
                '⬅️ К моим каналам',
                'fraud:menu'
              ),
            ]]
          );
          return;
        }

        if (action.status === 'running') {
          if (runningRemovalActions.has(action.id)) {
            await render(
              deliveryUpdate,
              `━━━━━━━━━━━━━━\n` +
              `🧹 Очистка уже выполняется\n\n` +
              `Текущий процесс продолжает работу.\n` +
              `Не запускайте его повторно.\n` +
              `━━━━━━━━━━━━━━`,
              []
            );
            return;
          }

          await runRemovalAction(
            action.id,
            deliveryUpdate
          );
          return;
        }

        if (action.status === 'completed') {
          await render(
            deliveryUpdate,
            `━━━━━━━━━━━━━━\n` +
            `✅ Эта очистка уже завершена\n\n` +
            `Откройте наплыв для актуальных показателей.\n` +
            `━━━━━━━━━━━━━━`,
            [[
              callbackButton(
                '🔎 Открыть наплыв',
                `fraud:wave:${action.wave_id}`
              ),
            ]]
          );
          return;
        }

        if (
          action.status !== 'pending' ||
          new Date(action.expires_at).getTime() <= Date.now()
        ) {
          await render(
            deliveryUpdate,
            `━━━━━━━━━━━━━━\n` +
            `⚠️ Подтверждение устарело\n\n` +
            `Участники не удалялись. ` +
            `Откройте очистку заново.\n` +
            `━━━━━━━━━━━━━━`,
            [[
              callbackButton(
                '⬅️ К наплыву',
                `fraud:wave:${action.wave_id}`
              ),
            ]]
          );
          return;
        }

        const started = rows(await query(`
          UPDATE lr_antifraud_actions
          SET
            status='running',
            result=
              COALESCE(result, '{}'::jsonb) ||
              jsonb_build_object(
                'started_at',
                now()::text
              )
          WHERE id=$1
            AND status='pending'
            AND expires_at>now()
          RETURNING *
        `, [action.id]))[0];

        if (!started) {
          await render(
            deliveryUpdate,
            `━━━━━━━━━━━━━━\n` +
            `⚠️ Не удалось запустить очистку\n\n` +
            `Состояние подтверждения изменилось. ` +
            `Откройте очистку заново.\n` +
            `━━━━━━━━━━━━━━`,
            [[
              callbackButton(
                '⬅️ К наплыву',
                `fraud:wave:${action.wave_id}`
              ),
            ]]
          );
          return;
        }

        await runRemovalAction(
          started.id,
          deliveryUpdate
        );
      } catch (launchError) {
        error(
          'cleanup progress launch failed:',
          launchError?.stack ||
          launchError?.message ||
          launchError
        );

        await render(
          deliveryUpdate,
          `━━━━━━━━━━━━━━\n` +
          `⚠️ Не удалось запустить очистку\n\n` +
          `Участники не были удалены автоматически.\n` +
          `Причина записана в журнал AntiFraud.\n` +
          `━━━━━━━━━━━━━━`,
          [[
            callbackButton('⬅️ К каналам', 'fraud:menu'),
          ]]
        ).catch(() => {});
      }
    }, 0);

    timer.unref?.();
    return true;
  }
  /* LR_ANTIFRAUD_PER_USER_ACCESS_V2_START */

  async function userChannelRows(update) {
    const maxUserId = actorId(update);
    if (!maxUserId) return [];

    await syncChannels();

    return rows(await query(`
      SELECT DISTINCT
        c.id,
        c.max_chat_id,
        c.title,
        c.link,
        c.is_active,
        COALESCE(af.enabled, false) AS enabled,
        af.enabled_at,
        af.disabled_at,
        af.last_event_at
      FROM public.lr_users u
      JOIN public.lr_user_channels uc
        ON uc.user_id=u.id
      JOIN public.channels c
        ON c.id=uc.channel_id
      LEFT JOIN public.lr_antifraud_channels af
        ON af.channel_id=c.id
      WHERE u.max_user_id::text=$1
        AND COALESCE(c.is_active, true)=true

      UNION

      SELECT DISTINCT
        c.id,
        c.max_chat_id,
        c.title,
        c.link,
        c.is_active,
        COALESCE(af.enabled, false) AS enabled,
        af.enabled_at,
        af.disabled_at,
        af.last_event_at
      FROM public.channels c
      LEFT JOIN public.lr_antifraud_channels af
        ON af.channel_id=c.id
      WHERE c.owner_max_user_id::text=$1
        AND COALESCE(c.is_active, true)=true

      ORDER BY title, id
    `, [String(maxUserId)]));
  }

  async function userCanManageChannel(update, channelId) {
    const maxUserId = actorId(update);
    const safeChannelId = num(channelId);

    if (!maxUserId || !safeChannelId) return false;

    const access = rows(await query(`
      SELECT 1 AS allowed
      FROM (
        SELECT uc.channel_id
        FROM public.lr_users u
        JOIN public.lr_user_channels uc
          ON uc.user_id=u.id
        WHERE u.max_user_id::text=$1
          AND uc.channel_id=$2

        UNION

        SELECT c.id AS channel_id
        FROM public.channels c
        WHERE c.id=$2
          AND c.owner_max_user_id::text=$1
      ) permitted
      LIMIT 1
    `, [String(maxUserId), safeChannelId]));

    return Boolean(access[0]);
  }

  async function callbackChannelForAccess(parts) {
    const action = parts[1] || '';

    if (['channel', 'toggle', 'waves',
      'country'
    ].includes(action)) {
      return num(parts[2]);
    }

    if ([
      'wave',
      'list',
      'member',
      'whitelist',
      'ignore',
      'remove_prompt', 'cleanup_prompt', 'rescore',
    ].includes(action)) {
      const waveId = num(parts[2]);
      if (!waveId) return 0;

      const wave = rows(await query(`
        SELECT channel_id
        FROM public.lr_antifraud_waves
        WHERE id=$1
        LIMIT 1
      `, [waveId]))[0];

      return num(wave?.channel_id);
    }

    if (action === 'remove_confirm') {
      const token = text(parts[2], 200);
      if (!token) return 0;

      const pendingAction = rows(await query(`
        SELECT channel_id
        FROM public.lr_antifraud_actions
        WHERE action_token=$1
        LIMIT 1
      `, [token]))[0];

      return num(pendingAction?.channel_id);
    }

    return 0;
  }

  async function showUserMenu(update) {
    const maxUserId = actorId(update);

    if (!maxUserId) {
      return render(
        update,
        '⚠️ Не удалось определить пользователя MAX.',
        [[callbackButton('⬅️ Назад', 'main:menu')]]
      );
    }

    const channels = await userChannelRows(update);
    const enabledCount = channels.filter(
      (channel) => Boolean(channel.enabled)
    ).length;

    const buttons = channels.map((channel) => [
      callbackButton(
        `${channel.enabled ? '●' : '○'} ${text(
          channel.title || `Канал ${channel.id}`,
          38
        )}`,
        `fraud:channel:${channel.id}`
      ),
    ]);

    if (channels.length) {
      buttons.push([
        callbackButton('✅ Включить все', 'fraud:enable_all'),
        callbackButton('⏸ Выключить все', 'fraud:disable_all'),
      ]);
    }

    buttons.push([
      callbackButton('⬅️ Назад', 'main:menu'),
    ]);

    const body = channels.length
      ? (
          `━━━━━━━━━━━━━━\n` +
          `🛡 AntiFraud LinkRay\n\n` +
          `Защита подключённых каналов работает 24/7.\n` +
          `Выберите канал для настройки.\n\n` +
          `Подключено: ${channels.length}\n` +
          `Под защитой: ${enabledCount}\n` +
          `Выключено: ${channels.length - enabledCount}\n\n` +
          `● защита включена   ○ защита выключена\n` +
          `━━━━━━━━━━━━━━`
        )
      : (
          `━━━━━━━━━━━━━━\n` +
          `🛡 AntiFraud LinkRay\n\n` +
          `Нет подключённых каналов.\n\n` +
          `Добавьте канал и оставьте LinkRay администратором.\n` +
          `━━━━━━━━━━━━━━`
        );

    return render(update, body, buttons);
  }

  async function setUserChannels(update, enabled) {
    const maxUserId = actorId(update);
    if (!maxUserId) return 0;

    await syncChannels();

    const changed = rows(await query(`
      UPDATE public.lr_antifraud_channels af
      SET
        enabled=$2,
        enabled_at=CASE
          WHEN $2=true THEN COALESCE(af.enabled_at, now())
          ELSE af.enabled_at
        END,
        learning_started_at=CASE
          WHEN $2=true THEN COALESCE(af.learning_started_at, now())
          ELSE af.learning_started_at
        END,
        disabled_at=CASE
          WHEN $2=true THEN NULL
          ELSE now()
        END,
        updated_at=now()
      FROM (
        SELECT DISTINCT uc.channel_id
        FROM public.lr_users u
        JOIN public.lr_user_channels uc
          ON uc.user_id=u.id
        WHERE u.max_user_id::text=$1

        UNION

        SELECT c.id AS channel_id
        FROM public.channels c
        WHERE c.owner_max_user_id::text=$1
      ) permitted
      WHERE af.channel_id=permitted.channel_id
      RETURNING af.channel_id
    `, [String(maxUserId), Boolean(enabled)]));

    return changed.length;
  }

  async function denyForeignChannel(update) {
    return render(
      update,
      '⛔ У вас нет доступа к этому каналу.',
      [[callbackButton('⬅️ К моим каналам', 'fraud:menu')]]
    );
  }

  /* LR_ANTIFRAUD_PER_USER_ACCESS_V2_END */


/* LR_ANTIFRAUD_ASYNC_RESCORE_V6_START */

  const runningWaveRescores = new Set();

  function callbackFreeUpdate(update) {
    const actor = (
      actorId(update) ||
      chatId(update) ||
      ownerId()
    );

    return {
      user_id: String(actor),
      chat_id: String(actor),
      payload: '',
    };
  }

  

async function startWaveRescore(update, waveId) {
    const safeWaveId = num(waveId);

    if (!safeWaveId) {
      return showUserMenu(update);
    }

    if (runningWaveRescores.has(safeWaveId)) {
      return render(
        update,
        `━━━━━━━━━━━━━━\n` +
        `🔄 Пересчёт уже выполняется\n\n` +
        `Текущая карточка обновится автоматически.\n` +
        `Повторный процесс не запущен.\n` +
        `━━━━━━━━━━━━━━`,
        [[
          callbackButton(
            '⬅️ Открыть сохранённую карточку',
            `fraud:wave:${safeWaveId}`
          ),
        ]],
        'Пересчёт уже запущен'
      );
    }

    runningWaveRescores.add(safeWaveId);

    const originalMessageId = messageId(update);

    try {
      await render(
        update,
        `━━━━━━━━━━━━━━\n` +
        `🔄 Пересчитываю наплыв\n\n` +
        `Обновляю ПДП и повторно анализирую участников.\n` +
        `Карточка обновится здесь же после завершения.\n\n` +
        `Не нажимайте кнопку повторно.\n` +
        `━━━━━━━━━━━━━━`,
        [[
          callbackButton(
            '⬅️ Показать сохранённые данные',
            `fraud:wave:${safeWaveId}`
          ),
        ]],
        'Пересчёт запущен'
      );
    } catch (startError) {
      runningWaveRescores.delete(safeWaveId);
      throw startError;
    }

    const editUpdate = {
      ...backgroundUpdateForUser(
        actorId(update) ||
        chatId(update) ||
        ownerId()
      ),
      _edit_message_id: originalMessageId,
      _do_not_send_new_message: true,
    };

    const timer = setTimeout(async () => {
      const failures = [];

      try {
        if (baselineV3) {
          try {
            await baselineV3.fixWave(safeWaveId);
          } catch (baselineError) {
            failures.push(
              `ПДП: ${text(
                baselineError?.message || baselineError,
                300
              )}`
            );

            error(
              `wave ${safeWaveId}: baseline failed:`,
              baselineError?.stack ||
              baselineError?.message ||
              baselineError
            );
          }
        }

        if (cohortEngine) {
          try {
            await cohortEngine.rescoreWave(
              safeWaveId,
              { enrich: true }
            );
          } catch (cohortError) {
            failures.push(
              `анализ участников: ${text(
                cohortError?.message || cohortError,
                300
              )}`
            );

            error(
              `wave ${safeWaveId}: cohort failed:`,
              cohortError?.stack ||
              cohortError?.message ||
              cohortError
            );
          }
        }

        await showWave(editUpdate, safeWaveId);

        if (failures.length) {
          warn(
            `wave ${safeWaveId}: rescore completed with ` +
            `${failures.length} partial failure(s): ` +
            failures.join(' | ')
          );
        } else {
          log(
            `wave ${safeWaveId}: rescore completed in same message`
          );
        }
      } catch (deliveryError) {
        error(
          `wave ${safeWaveId}: same-message update failed:`,
          deliveryError?.stack ||
          deliveryError?.message ||
          deliveryError
        );
      } finally {
        runningWaveRescores.delete(safeWaveId);
      }
    }, 0);

    timer.unref?.();
    return true;
  }

  /* LR_ANTIFRAUD_ASYNC_RESCORE_V6_END */

  async function handleCallback(update) {
    const payload = callbackPayload(update);
    if (!payload.startsWith('fraud:')) return false;


    const parts = payload.split(':');
    const action = parts[1] || '';

    if (action === 'menu') {
      await showUserMenu(update);
      return true;
    }

    if (action === 'enable_all') {
      await setUserChannels(update, true);
      await showUserMenu(update);
      return true;
    }

    if (action === 'disable_all') {
      await setUserChannels(update, false);
      await showUserMenu(update);
      return true;
    }

    if (action === 'remove_confirm') { await executeRemoval(update, parts.slice(2).join(':')); return true; } const protectedChannelId = await callbackChannelForAccess(parts);
    if (
      protectedChannelId &&
      !(await userCanManageChannel(update, protectedChannelId))
    ) {
      await denyForeignChannel(update);
      return true;
    }

    if (action === 'menu') await showUserMenu(update);
    else if (action === 'channel') await showChannel(update, num(parts[2]));
    else if (action === 'toggle') await toggleChannel(update, num(parts[2]));
    else if (action === 'enable_all') { await setAll(true); await showUserMenu(update); }
    else if (action === 'disable_all') { await setAll(false); await showUserMenu(update); }
    else if (action === 'waves') await showWaves(update, num(parts[2]), num(parts[3]));
    else if (action === 'wave') await showWave(update, num(parts[2]));
    else if (action === 'list') await showRiskList(update, num(parts[2]), parts[3] || 'high', num(parts[4]));
    else if (action === 'member') await showMember(update, num(parts[2]), num(parts[3]));
    else if (action === 'whitelist') await whitelistMember(update, num(parts[2]), num(parts[3]));
    else if (action === 'ignore') await ignoreWave(update, num(parts[2]));
    else if (action === 'country') await showMember(update, num(parts[2]), num(parts[3])); else if (action === 'rescore') await startWaveRescore(update, num(parts[2])); else if (action === 'cleanup_prompt') await cleanupPrompt(update, num(parts[2]), parts[3] || 'probable'); else if (action === 'remove_prompt') await removalPrompt(update, num(parts[2]));
    else if (action === 'remove_confirm') await executeRemoval(update, parts[2]);
    else await showUserMenu(update);
    return true;
  }

  function handleEvent(update) {
    const type = updateType(update);
    if (type === 'user_added') {
      recordJoin(update).catch((e) => error('user_added failed:', e?.stack || e?.message || e));
    } else if (type === 'user_removed') {
      recordLeave(update).catch((e) => error('user_removed failed:', e?.stack || e?.message || e));
    } else if (type === 'bot_removed') {
      const maxChatId = chatId(update);
      if (maxChatId) {
        query(`UPDATE lr_antifraud_channels SET enabled=false,disabled_at=now(),updated_at=now() WHERE max_chat_id=$1`, [maxChatId])
          .catch((e) => error('bot_removed disable failed:', e?.message || e));
      }
    }
  }

  async function handleHttpUpdate(update) {
    const payload = callbackPayload(update);
    if (payload.startsWith('fraud:')) {
      await handleCallback(update);
      return { handled: true, reason: 'antifraud_callback' };
    }
    handleEvent(update);
    return { handled: false };
  }

  await ensureSchema();
  cohortEngine = createLinkRayCohortEngine({
    query,
    maxFetch,
    logger,
    refreshWave,
    onWaveScored: async (wave) => {
      if (wave) await maybeNotify(wave);
    },
  });
  await cohortEngine.ensureSchema();
  baselineV3 = createLinkRayAntifraudBaselineV3({
    query,
    maxFetch,
    logger,
  });
  await baselineV3.ensureSchema(); await ensureAlertDeliverySchema(); await syncChannels(); await cohortEngine.start();
  await baselineV3.start(); setTimeout(() => replayRecentUnsafeAlerts().catch((e) => error('unsafe alert replay failed:', e?.stack || e?.message || e)), 8_000).unref?.();
  const timer = setInterval(() => closeStaleWaves().catch((e) => error('sweeper failed:', e?.message || e)), 60_000);
  timer.unref?.();
  setTimeout(() => closeStaleWaves().catch(() => {}), 5_000).unref?.();
  log(`installed v${MODULE_VERSION}; owner=${ownerId()}`);

  return {
    version: MODULE_VERSION,
    handleHttpUpdate,
    handleCallback,
    handleEvent,
    ensureSchema,
    syncChannels,
    closeStaleWaves,
  };
}
