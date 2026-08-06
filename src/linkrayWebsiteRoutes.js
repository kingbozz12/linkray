import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from './db.js';
import { sendMaxMessage } from './maxClient.js';

// LINKRAY_CABINET_SUITE_V5_IMPORT
import { query as lrCabinetQuery } from './db.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const siteRoot = path.resolve(__dirname, '../public/linkray-site');

const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_COOKIE = 'lr_web_session';
const requestBuckets = new Map();

let authSchemaPromise = null;

function applyWebsiteHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
}

function sendSiteFile(res, filename, cacheControl = 'no-cache') {
  res.setHeader('Cache-Control', cacheControl);
  return res.sendFile(path.join(siteRoot, filename));
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function normalizeIdentifier(value) {
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/\D+/g, '');
  if (!digits) return '';
  return digits.replace(/^0+(?=\d)/, '') || '0';
}

function normalizeCode(value) {
  return String(value ?? '').replace(/\D+/g, '').slice(0, 6);
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || String(req.socket?.remoteAddress || '').slice(0, 120);
}

function rateLimit(req, res, next) {
  const key = clientIp(req) || 'unknown';
  const now = Date.now();
  const current = requestBuckets.get(key) || { startedAt: now, count: 0 };

  if (now - current.startedAt > 10 * 60 * 1000) {
    current.startedAt = now;
    current.count = 0;
  }

  current.count += 1;
  requestBuckets.set(key, current);

  if (current.count > 12) {
    return res.status(429).json({
      ok: false,
      error: 'Слишком много попыток. Повторите через несколько минут.',
    });
  }

  next();
}

async function ensureAuthSchema() {
  if (!authSchemaPromise) {
    authSchemaPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS public.lr_web_login_codes (
          id bigserial PRIMARY KEY,
          user_id bigint NOT NULL,
          challenge_hash text NOT NULL UNIQUE,
          code_hash text NOT NULL,
          requested_ip text,
          attempts integer NOT NULL DEFAULT 0,
          expires_at timestamptz NOT NULL,
          used_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS lr_web_login_codes_user_idx
        ON public.lr_web_login_codes(user_id, created_at DESC)
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS public.lr_web_sessions (
          id bigserial PRIMARY KEY,
          user_id bigint NOT NULL,
          token_hash text NOT NULL UNIQUE,
          created_ip text,
          user_agent text,
          expires_at timestamptz NOT NULL,
          revoked_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          last_seen_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS lr_web_sessions_user_idx
        ON public.lr_web_sessions(user_id, expires_at DESC)
      `);
    })().catch((error) => {
      authSchemaPromise = null;
      throw error;
    });
  }

  return authSchemaPromise;
}

async function findLinkRayUser(identifier) {
  const normalized = normalizeIdentifier(identifier);
  if (!normalized) return null;

  const rows = await query(
    `
      SELECT
        id,
        max_user_id,
        display_name,
        COALESCE(is_blocked, false) AS is_blocked
      FROM public.lr_users
      WHERE id::text = $1
         OR max_user_id::text = $1
      ORDER BY
        CASE WHEN id::text = $1 THEN 0 ELSE 1 END,
        id
      LIMIT 1
    `,
    [normalized]
  );

  return rows[0] || null;
}

function setSessionCookie(req, res, token) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const secure = req.secure || forwardedProto === 'https';

  res.cookie(LOGIN_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(req, res) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const secure = req.secure || forwardedProto === 'https';

  res.clearCookie(LOGIN_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  });
}

async function getSession(req) {
  await ensureAuthSchema();

  const token = parseCookies(req)[LOGIN_COOKIE];
  if (!token) return null;

  const rows = await query(
    `
      SELECT
        s.id AS session_id,
        s.user_id,
        u.max_user_id,
        u.display_name,
        COALESCE(u.is_blocked, false) AS is_blocked
      FROM public.lr_web_sessions s
      JOIN public.lr_users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      LIMIT 1
    `,
    [sha256(token)]
  );

  const session = rows[0] || null;
  if (!session || session.is_blocked) return null;

  query(
    `
      UPDATE public.lr_web_sessions
      SET last_seen_at = now()
      WHERE id = $1
    `,
    [session.session_id]
  ).catch(() => {});

  return session;
}

function requireSession(handler) {
  return asyncRoute(async (req, res, next) => {
    const session = await getSession(req);
    if (!session) {
      return res.status(401).json({
        ok: false,
        authenticated: false,
        error: 'Требуется вход в LinkRay.',
      });
    }

    req.linkraySession = session;
    return handler(req, res, next);
  });
}

function pickNumber(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function safeChannel(row) {
  const channel = row.channel_data || {};
  return {
    id: Number(channel.id || 0),
    title: String(channel.title || channel.name || 'Канал LinkRay'),
    maxChatId: channel.max_chat_id ? String(channel.max_chat_id) : '',
    role: String(row.role || 'member'),
    accessSource: String(row.access_source || ''),
    isActive: channel.is_active !== false,
    subscribers: pickNumber(channel, [
      'subscribers_count',
      'subscriber_count',
      'members_count',
      'member_count',
      'subscribers',
      'audience_total',
    ]),
    avatarUrl: String(
      channel.avatar_url ||
      channel.photo_url ||
      channel.image_url ||
      channel.icon_url ||
      ''
    ),
  };
}


// LINKRAY_CABINET_SUITE_V5_MODULE_START
const LR_CABINET_BOT_URL = 'https://max.ru/se13353901_bot';

function lrC5Rows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function lrC5Pick(object, names, fallback = null) {
  if (!object || typeof object !== 'object') return fallback;

  for (const name of names) {
    const value = object[name];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return fallback;
}

function lrC5Number(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lrC5Bool(value, fallback = false) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;

  const normalized = String(value ?? '').trim().toLowerCase();

  if (['true', 'yes', 'on', 'enabled', 'active', 'safe'].includes(normalized)) {
    return true;
  }

  if (['false', 'no', 'off', 'disabled', 'inactive'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function lrC5Text(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function lrC5Ident(value) {
  const name = String(value ?? '').trim();

  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Недопустимый SQL-идентификатор: ${name}`);
  }

  return `"${name.replaceAll('"', '""')}"`;
}

async function lrC5SafeQuery(sql, params = [], label = 'query') {
  try {
    return lrC5Rows(await lrCabinetQuery(sql, params));
  } catch (error) {
    console.error(
      `[LinkRay Cabinet ${label}]`,
      error?.message || error,
    );
    return [];
  }
}

async function lrC5TableExists(table) {
  const rows = await lrC5SafeQuery(
    `SELECT to_regclass($1) AS relation`,
    [`public.${table}`],
    `table:${table}`,
  );

  return Boolean(rows[0]?.relation);
}

async function lrC5Columns(table) {
  if (!(await lrC5TableExists(table))) return new Set();

  const rows = await lrC5SafeQuery(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name=$1
    `,
    [table],
    `columns:${table}`,
  );

  return new Set(rows.map((row) => String(row.column_name)));
}

function lrC5Column(columns, candidates) {
  return candidates.find((name) => columns.has(name)) || null;
}

function lrC5ParseCookies(req) {
  const result = {};
  const raw = String(req.headers.cookie ?? '');

  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;

    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();

    if (!name) continue;

    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      result[name] = rawValue;
    }
  }

  return result;
}

async function lrC5Hash(value) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(String(value)).digest('hex');
}

async function lrC5Session(req) {
  const sessionColumns = await lrC5Columns('lr_web_sessions');
  if (!sessionColumns.size) return null;

  const hashColumn = lrC5Column(
    sessionColumns,
    ['token_hash', 'session_hash', 'challenge_hash'],
  );

  if (!hashColumn) return null;

  const cookies = lrC5ParseCookies(req);
  const preferredNames = [
    'lr_web_session',
    'linkray_session',
    'lr_session',
    'session',
  ];

  const candidates = [];

  for (const name of preferredNames) {
    if (cookies[name]) candidates.push(cookies[name]);
  }

  for (const value of Object.values(cookies)) {
    if (value && !candidates.includes(value)) {
      candidates.push(value);
    }
  }

  const where = [`s.${lrC5Ident(hashColumn)}=$1`];

  if (sessionColumns.has('expires_at')) {
    where.push(`s."expires_at">NOW()`);
  }

  if (sessionColumns.has('revoked_at')) {
    where.push(`s."revoked_at" IS NULL`);
  }

  for (const token of candidates.slice(0, 12)) {
    const tokenHash = await lrC5Hash(token);

    const rows = await lrC5SafeQuery(
      `
        SELECT to_jsonb(s) AS session
        FROM public.lr_web_sessions s
        WHERE ${where.join(' AND ')}
        ORDER BY ${
          sessionColumns.has('created_at')
            ? 's."created_at" DESC'
            : 's."id" DESC'
        }
        LIMIT 1
      `,
      [tokenHash],
      'session',
    );

    const session = rows[0]?.session;
    if (!session) continue;

    const userId = lrC5Pick(session, ['user_id', 'lr_user_id']);
    if (userId === null || userId === undefined) continue;

    const userColumns = await lrC5Columns('lr_users');
    let user = {};

    if (userColumns.size) {
      const userIdColumn = lrC5Column(
        userColumns,
        ['id', 'user_id', 'lr_user_id'],
      );

      if (userIdColumn) {
        const userRows = await lrC5SafeQuery(
          `
            SELECT to_jsonb(u) AS user
            FROM public.lr_users u
            WHERE CAST(u.${lrC5Ident(userIdColumn)} AS TEXT)=$1
            LIMIT 1
          `,
          [String(userId)],
          'user',
        );

        user = userRows[0]?.user || {};
      }
    }

    if (sessionColumns.has('last_seen_at')) {
      const idColumn = lrC5Column(sessionColumns, ['id']);
      if (idColumn && session[idColumn] !== undefined) {
        lrC5SafeQuery(
          `
            UPDATE public.lr_web_sessions
            SET "last_seen_at"=NOW()
            WHERE ${lrC5Ident(idColumn)}=$1
          `,
          [session[idColumn]],
          'session-touch',
        );
      }
    }

    return {
      session,
      user,
      userId: String(userId),
      maxUserId: lrC5Text(
        lrC5Pick(user, ['max_user_id', 'maxUserId'], ''),
      ),
      displayName: lrC5Text(
        lrC5Pick(
          user,
          [
            'display_name',
            'name',
            'first_name',
            'username',
          ],
          `Пользователь ${userId}`,
        ),
      ),
    };
  }

  return null;
}

function lrC5NormalizeKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

function lrC5Keys(object) {
  const values = [
    lrC5Pick(object, ['id']),
    lrC5Pick(object, ['channel_id']),
    lrC5Pick(object, ['max_chat_id']),
    lrC5Pick(object, ['chat_id']),
    lrC5Pick(object, ['max_channel_id']),
    lrC5Pick(object, ['link']),
    lrC5Pick(object, ['public_link']),
    lrC5Pick(object, ['channel_link']),
    lrC5Pick(object, ['url']),
    lrC5Pick(object, ['channel_key']),
  ];

  return new Set(
    values
      .map(lrC5NormalizeKey)
      .filter(Boolean),
  );
}

function lrC5Intersects(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function lrC5Time(object) {
  const value = lrC5Pick(
    object,
    [
      'captured_at',
      'occurred_at',
      'created_at',
      'updated_at',
      'publish_at',
      'published_at',
      'detected_at',
      'started_at',
      'last_seen_at',
    ],
  );

  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

async function lrC5JsonRows(
  table,
  {
    limit = 5000,
    orderCandidates = [
      'captured_at',
      'occurred_at',
      'created_at',
      'updated_at',
      'id',
    ],
    whereSql = '',
    params = [],
  } = {},
) {
  const columns = await lrC5Columns(table);
  if (!columns.size) return [];

  const orderColumn =
    lrC5Column(columns, orderCandidates) ||
    lrC5Column(columns, ['id']);

  const orderSql = orderColumn
    ? `ORDER BY t.${lrC5Ident(orderColumn)} DESC NULLS LAST`
    : '';

  const rows = await lrC5SafeQuery(
    `
      SELECT to_jsonb(t) AS row
      FROM public.${lrC5Ident(table)} t
      ${whereSql}
      ${orderSql}
      LIMIT ${Math.max(1, Math.min(Number(limit) || 1000, 20000))}
    `,
    params,
    `rows:${table}`,
  );

  return rows.map((item) => item.row || {}).filter(Boolean);
}

async function lrC5LoadChannels(identity) {
  const channelColumns = await lrC5Columns('channels');
  if (!channelColumns.size) return [];

  const channelIdColumn = lrC5Column(
    channelColumns,
    ['id', 'channel_id'],
  );

  if (!channelIdColumn) return [];

  const userChannelColumns = await lrC5Columns('lr_user_channels');

  if (userChannelColumns.size) {
    const ucUserColumn = lrC5Column(
      userChannelColumns,
      ['user_id', 'lr_user_id', 'owner_user_id'],
    );
    const ucChannelColumn = lrC5Column(
      userChannelColumns,
      ['channel_id', 'channel_internal_id'],
    );

    if (ucUserColumn && ucChannelColumn) {
      const identities = [
        identity.userId,
        identity.maxUserId,
      ].filter(Boolean);

      const rows = await lrC5SafeQuery(
        `
          SELECT
            to_jsonb(c) AS channel,
            to_jsonb(uc) AS membership
          FROM public.lr_user_channels uc
          JOIN public.channels c
            ON CAST(c.${lrC5Ident(channelIdColumn)} AS TEXT)
             = CAST(uc.${lrC5Ident(ucChannelColumn)} AS TEXT)
          WHERE CAST(uc.${lrC5Ident(ucUserColumn)} AS TEXT)
                = ANY($1::text[])
          ORDER BY c.${lrC5Ident(channelIdColumn)} ASC
        `,
        [identities],
        'user-channels',
      );

      if (rows.length) {
        return rows
          .map((row) => ({
            raw: row.channel || {},
            membership: row.membership || {},
          }))
          .filter(({ raw }) => raw && typeof raw === 'object');
      }
    }
  }

  const directUserColumn = lrC5Column(
    channelColumns,
    [
      'user_id',
      'owner_user_id',
      'created_by_user_id',
      'admin_user_id',
      'max_user_id',
      'owner_max_user_id',
      'created_by_max_user_id',
    ],
  );

  if (!directUserColumn) return [];

  const identities = [
    identity.userId,
    identity.maxUserId,
  ].filter(Boolean);

  const rows = await lrC5SafeQuery(
    `
      SELECT to_jsonb(c) AS channel
      FROM public.channels c
      WHERE CAST(c.${lrC5Ident(directUserColumn)} AS TEXT)
            = ANY($1::text[])
      ORDER BY c.${lrC5Ident(channelIdColumn)} ASC
    `,
    [identities],
    'direct-channels',
  );

  return rows.map((row) => ({
    raw: row.channel || {},
    membership: {},
  }));
}

function lrC5ActiveChannel(channel) {
  const active = lrC5Pick(
    channel,
    ['is_active', 'active', 'enabled'],
    true,
  );

  return lrC5Bool(active, true);
}

function lrC5SnapshotSourceScore(snapshot) {
  return lrC5Text(snapshot.collection_source) === 'max_api_collector_v1'
    ? 1
    : 0;
}

function lrC5MatchingRows(channelKeys, rows) {
  return rows
    .filter((row) => lrC5Intersects(channelKeys, lrC5Keys(row)))
    .sort((a, b) => {
      const sourceDiff =
        lrC5SnapshotSourceScore(b) -
        lrC5SnapshotSourceScore(a);

      if (sourceDiff) return sourceDiff;
      return lrC5Time(b) - lrC5Time(a);
    });
}

function lrC5DailyHistory(rows, days = 30) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const daily = new Map();

  for (const row of rows) {
    const time = lrC5Time(row);
    if (!time || time < since) continue;

    const day = new Date(time).toISOString().slice(0, 10);
    if (!daily.has(day)) {
      daily.set(day, row);
    }
  }

  return [...daily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, row]) => ({
      date,
      capturedAt: lrC5Pick(row, ['captured_at']),
      subscribers: lrC5Number(row.subscribers),
      views24: lrC5Number(row.views24),
      deltaDay: lrC5Number(row.delta_day),
      er24: lrC5Number(row.er24),
    }));
}

function lrC5HourlyHistory(rows) {
  const since = Date.now() - 24 * 60 * 60 * 1000;

  return rows
    .filter((row) => lrC5Time(row) >= since)
    .slice(0, 48)
    .reverse()
    .map((row) => ({
      capturedAt: lrC5Pick(row, ['captured_at']),
      subscribers: lrC5Number(row.subscribers),
      views24: lrC5Number(row.views24),
      deltaDay: lrC5Number(row.delta_day),
      er24: lrC5Number(row.er24),
    }));
}

function lrC5Risk(config, events) {
  const explicit = lrC5Text(
    lrC5Pick(
      config,
      [
        'risk_level',
        'risk',
        'status',
        'safety_status',
      ],
      '',
    ),
  ).toLowerCase();

  const score = lrC5Number(
    lrC5Pick(config, ['risk_score', 'score']),
  );

  if (
    explicit.includes('high') ||
    explicit.includes('danger') ||
    explicit.includes('unsafe') ||
    explicit.includes('высок')
  ) {
    return { level: 'high', label: 'Высокий риск', score };
  }

  if (
    explicit.includes('medium') ||
    explicit.includes('warn') ||
    explicit.includes('attention') ||
    explicit.includes('сред')
  ) {
    return { level: 'medium', label: 'Требует внимания', score };
  }

  if (score !== null && score >= 70) {
    return { level: 'high', label: 'Высокий риск', score };
  }

  if (score !== null && score >= 30) {
    return { level: 'medium', label: 'Требует внимания', score };
  }

  const recentSince = Date.now() - 24 * 60 * 60 * 1000;
  const recentEvents = events.filter(
    (event) => lrC5Time(event) >= recentSince,
  ).length;

  if (recentEvents >= 5) {
    return { level: 'high', label: 'Высокий риск', score };
  }

  if (recentEvents > 0) {
    return { level: 'medium', label: 'Есть события', score };
  }

  return { level: 'safe', label: 'Угроз не обнаружено', score };
}

function lrC5PostStatus(row) {
  const status = lrC5Text(
    lrC5Pick(row, ['status', 'state'], 'unknown'),
  ).toLowerCase();

  if (status === 'scheduled') return 'scheduled';
  if (status === 'published') return 'published';
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'canceled' || status === 'deleted') return 'deleted';
  if (status === 'publishing') return 'publishing';

  return status || 'unknown';
}

function lrC5Post(row, channelMap) {
  const channelId = lrC5Text(
    lrC5Pick(row, ['channel_id', 'channelId']),
  );

  const channel = channelMap.get(channelId);

  return {
    id: lrC5Text(lrC5Pick(row, ['id', 'post_id'])),
    channelId,
    channelTitle: channel?.title || lrC5Text(
      lrC5Pick(row, ['channel_title']),
      'Канал',
    ),
    status: lrC5PostStatus(row),
    text: lrC5Text(
      lrC5Pick(row, ['text', 'caption', 'content']),
    ).slice(0, 220),
    publishAt: lrC5Pick(row, ['publish_at', 'scheduled_at']),
    publishedAt: lrC5Pick(row, ['published_at']),
    createdAt: lrC5Pick(row, ['created_at']),
    isAd: lrC5Bool(lrC5Pick(row, ['is_ad', 'advertising']), false),
    cpm: lrC5Number(lrC5Pick(row, ['cpm'])),
    error: lrC5Text(
      lrC5Pick(row, ['error_message', 'last_error']),
    ).slice(0, 300),
  };
}

async function lrC5Subscription(identity) {
  const columns = await lrC5Columns('lr_user_subscriptions');

  if (!columns.size) {
    return {
      name: 'Бесплатный',
      status: 'active',
      endsAt: null,
      channelLimit: null,
    };
  }

  const userColumn = lrC5Column(
    columns,
    ['user_id', 'lr_user_id', 'max_user_id'],
  );

  if (!userColumn) {
    return {
      name: 'Бесплатный',
      status: 'active',
      endsAt: null,
      channelLimit: null,
    };
  }

  const identities = [
    identity.userId,
    identity.maxUserId,
  ].filter(Boolean);

  const orderColumn = lrC5Column(
    columns,
    ['expires_at', 'ends_at', 'created_at', 'id'],
  );

  const rows = await lrC5SafeQuery(
    `
      SELECT to_jsonb(s) AS subscription
      FROM public.lr_user_subscriptions s
      WHERE CAST(s.${lrC5Ident(userColumn)} AS TEXT)
            = ANY($1::text[])
      ${
        orderColumn
          ? `ORDER BY s.${lrC5Ident(orderColumn)} DESC NULLS LAST`
          : ''
      }
      LIMIT 1
    `,
    [identities],
    'subscription',
  );

  const subscription = rows[0]?.subscription || {};
  let tariff = {};

  const tariffId = lrC5Pick(
    subscription,
    ['tariff_id', 'plan_id'],
  );

  if (
    tariffId !== undefined &&
    tariffId !== null &&
    await lrC5TableExists('lr_tariffs')
  ) {
    const tariffColumns = await lrC5Columns('lr_tariffs');
    const tariffIdColumn = lrC5Column(
      tariffColumns,
      ['id', 'tariff_id'],
    );

    if (tariffIdColumn) {
      const tariffRows = await lrC5SafeQuery(
        `
          SELECT to_jsonb(t) AS tariff
          FROM public.lr_tariffs t
          WHERE CAST(t.${lrC5Ident(tariffIdColumn)} AS TEXT)=$1
          LIMIT 1
        `,
        [String(tariffId)],
        'tariff',
      );

      tariff = tariffRows[0]?.tariff || {};
    }
  }

  return {
    name: lrC5Text(
      lrC5Pick(
        tariff,
        ['name', 'title'],
        lrC5Pick(
          subscription,
          ['plan_name', 'tariff_name'],
          'Бесплатный',
        ),
      ),
    ),
    status: lrC5Text(
      lrC5Pick(subscription, ['status'], 'active'),
    ),
    startsAt: lrC5Pick(
      subscription,
      ['starts_at', 'started_at', 'created_at'],
    ),
    endsAt: lrC5Pick(
      subscription,
      ['expires_at', 'ends_at', 'end_at'],
    ),
    channelLimit: lrC5Number(
      lrC5Pick(
        tariff,
        ['channel_limit', 'channels_limit', 'max_channels'],
      ),
    ),
  };
}

async function lrC5TeamCounts(channelIds) {
  const columns = await lrC5Columns('lr_user_channels');
  if (!columns.size || !channelIds.length) return new Map();

  const channelColumn = lrC5Column(
    columns,
    ['channel_id', 'channel_internal_id'],
  );

  if (!channelColumn) return new Map();

  const rows = await lrC5SafeQuery(
    `
      SELECT
        CAST(${lrC5Ident(channelColumn)} AS TEXT) AS channel_id,
        COUNT(*)::int AS team_count
      FROM public.lr_user_channels
      WHERE CAST(${lrC5Ident(channelColumn)} AS TEXT)
            = ANY($1::text[])
      GROUP BY ${lrC5Ident(channelColumn)}
    `,
    [channelIds],
    'team-counts',
  );

  return new Map(
    rows.map((row) => [
      String(row.channel_id),
      Number(row.team_count || 0),
    ]),
  );
}

async function lrC5CabinetPayload(req) {
  const identity = await lrC5Session(req);

  if (!identity) {
    const error = new Error(
      'Сессия входа закончилась. Войдите заново.',
    );
    error.statusCode = 401;
    throw error;
  }

  const channelMemberships = (
    await lrC5LoadChannels(identity)
  ).filter(({ raw }) => lrC5ActiveChannel(raw));

  const snapshotColumns = await lrC5Columns(
    'lr_channel_analytics_snapshots',
  );

  const snapshotRows = await lrC5JsonRows(
    'lr_channel_analytics_snapshots',
    {
      limit: 12000,
      orderCandidates: ['captured_at', 'id'],
      whereSql: snapshotColumns.has('captured_at')
        ? `WHERE t."captured_at" >= NOW() - INTERVAL '32 days'`
        : '',
    },
  );

  const stateRows = await lrC5JsonRows(
    'lr_channel_metrics_state',
    {
      limit: 3000,
      orderCandidates: ['updated_at', 'last_success_at'],
    },
  );

  const antifraudRows = await lrC5JsonRows(
    'lr_antifraud_channels',
    {
      limit: 3000,
      orderCandidates: ['updated_at', 'id'],
    },
  );

  const antifraudEvents = await lrC5JsonRows(
    'lr_antifraud_events',
    {
      limit: 5000,
      orderCandidates: ['occurred_at', 'created_at', 'id'],
    },
  );

  const antifraudWaves = await lrC5JsonRows(
    'lr_antifraud_waves',
    {
      limit: 3000,
      orderCandidates: ['detected_at', 'created_at', 'id'],
    },
  );

  const baseChannels = channelMemberships.map(
    ({ raw, membership }) => {
      const id = lrC5Text(
        lrC5Pick(raw, ['id', 'channel_id']),
      );

      return {
        id,
        raw,
        membership,
        keys: lrC5Keys(raw),
        title: lrC5Text(
          lrC5Pick(
            raw,
            ['title', 'name', 'channel_title', 'display_name'],
            `Канал ${id}`,
          ),
        ),
      };
    },
  );

  const channelIds = baseChannels
    .map((channel) => channel.id)
    .filter(Boolean);

  const teamCounts = await lrC5TeamCounts(channelIds);

  const channelMap = new Map(
    baseChannels.map((channel) => [
      channel.id,
      channel,
    ]),
  );

  let scheduledRows = [];

  if (channelIds.length) {
    const scheduledColumns = await lrC5Columns('scheduled_posts');

    if (scheduledColumns.size) {
      const channelColumn = lrC5Column(
        scheduledColumns,
        ['channel_id'],
      );

      const orderColumn = lrC5Column(
        scheduledColumns,
        ['publish_at', 'created_at', 'id'],
      );

      if (channelColumn) {
        scheduledRows = await lrC5JsonRows(
          'scheduled_posts',
          {
            limit: 500,
            orderCandidates: [
              orderColumn || 'publish_at',
              'created_at',
              'id',
            ],
            whereSql:
              `WHERE CAST(t.${lrC5Ident(channelColumn)} AS TEXT)`
              + ` = ANY($1::text[])`,
            params: [channelIds],
          },
        );
      }
    }
  }

  const posts = scheduledRows
    .map((row) => lrC5Post(row, channelMap))
    .sort((a, b) => {
      const left = new Date(
        a.publishAt || a.publishedAt || a.createdAt || 0,
      ).getTime();

      const right = new Date(
        b.publishAt || b.publishedAt || b.createdAt || 0,
      ).getTime();

      return right - left;
    });

  const channels = baseChannels.map((base) => {
    const matchingSnapshots = lrC5MatchingRows(
      base.keys,
      snapshotRows,
    );

    const latest = matchingSnapshots[0] || null;

    const matchingStates = lrC5MatchingRows(
      base.keys,
      stateRows,
    );

    const state = matchingStates[0] || {};

    const matchingConfigs = lrC5MatchingRows(
      base.keys,
      antifraudRows,
    );

    const antifraudConfig = matchingConfigs[0] || {};

    const events = [
      ...lrC5MatchingRows(base.keys, antifraudEvents),
      ...lrC5MatchingRows(base.keys, antifraudWaves),
    ].sort((a, b) => lrC5Time(b) - lrC5Time(a));

    const risk = lrC5Risk(antifraudConfig, events);

    const channelPosts = posts.filter(
      (post) => post.channelId === base.id,
    );

    const firstSeen = lrC5Pick(
      state,
      ['first_seen_at', 'first_success_at'],
    );

    const firstSeenTime = firstSeen
      ? new Date(firstSeen).getTime()
      : 0;

    const baselineComplete = lrC5Bool(
      lrC5Pick(state, ['baseline_complete']),
      firstSeenTime > 0 &&
        Date.now() - firstSeenTime >= 24 * 60 * 60 * 1000,
    );

    const analyticsReady = Boolean(latest);
    const full24hReady = analyticsReady && baselineComplete;

    return {
      id: base.id,
      maxChatId: lrC5Text(
        lrC5Pick(
          base.raw,
          ['max_chat_id', 'chat_id', 'max_channel_id'],
        ),
      ),
      title: base.title,
      link: lrC5Text(
        lrC5Pick(
          base.raw,
          ['link', 'public_link', 'channel_link', 'url'],
        ),
      ),
      role: lrC5Text(
        lrC5Pick(
          base.membership,
          ['role', 'access_role', 'member_role'],
          'Администратор',
        ),
      ),
      teamCount: teamCounts.get(base.id) || 1,
      botAccess: lrC5Bool(
        lrC5Pick(
          base.raw,
          [
            'bot_is_admin',
            'is_bot_admin',
            'bot_admin',
            'has_access',
          ],
          true,
        ),
        true,
      ),
      analyticsReady,
      full24hReady,
      metrics: latest
        ? {
            subscribers: lrC5Number(latest.subscribers),
            views24: lrC5Number(latest.views24),
            views48: lrC5Number(latest.views48),
            views72: lrC5Number(latest.views72),
            viewsTotal: lrC5Number(latest.views_total),
            er24: lrC5Number(latest.er24),
            deltaDay: lrC5Number(latest.delta_day),
            joined24h: lrC5Number(latest.joined_24h),
            left24h: lrC5Number(latest.left_24h),
            capturedAt: lrC5Pick(latest, ['captured_at']),
            source: lrC5Text(
              lrC5Pick(latest, ['collection_source']),
            ),
          }
        : null,
      history24h: lrC5HourlyHistory(matchingSnapshots),
      history30d: lrC5DailyHistory(matchingSnapshots, 30),
      collector: {
        baselineComplete,
        readyAt: lrC5Pick(state, ['ready_at']),
        lastSuccessAt: lrC5Pick(
          state,
          ['last_success_at', 'last_collect_at'],
        ),
        lastError: lrC5Text(
          lrC5Pick(state, ['last_error']),
        ),
      },
      antifraud: {
        enabled: lrC5Bool(
          lrC5Pick(
            antifraudConfig,
            ['enabled', 'is_enabled', 'active', 'is_active'],
            false,
          ),
          false,
        ),
        level: risk.level,
        label: risk.label,
        score: risk.score,
        events24h: events.filter(
          (event) =>
            lrC5Time(event) >=
            Date.now() - 24 * 60 * 60 * 1000,
        ).length,
        totalEvents: events.length,
        lastEventAt: events[0]
          ? new Date(lrC5Time(events[0])).toISOString()
          : null,
        pdpBefore: lrC5Number(
          lrC5Pick(
            events[0] || {},
            [
              'pdp_before',
              'baseline_pdp',
              'members_before',
              'subscriber_count_before',
            ],
          ),
        ),
      },
      posts: channelPosts.slice(0, 12),
    };
  });

  const subscription = await lrC5Subscription(identity);

  const notifications = [];

  for (const channel of channels) {
    if (!channel.botAccess) {
      notifications.push({
        type: 'access',
        level: 'high',
        title: `${channel.title}: нет доступа`,
        text: 'Бот больше не является администратором канала.',
        channelId: channel.id,
      });
    }

    if (!channel.analyticsReady) {
      notifications.push({
        type: 'analytics',
        level: 'info',
        title: `${channel.title}: данные собираются`,
        text: 'Первый снимок аналитики ещё не получен.',
        channelId: channel.id,
      });
    } else if (!channel.full24hReady) {
      notifications.push({
        type: 'analytics',
        level: 'info',
        title: `${channel.title}: накапливаются 24 часа`,
        text: 'Текущие показатели доступны, полный период ещё не завершён.',
        channelId: channel.id,
      });
    }

    if (channel.collector.lastError) {
      notifications.push({
        type: 'collector',
        level: 'medium',
        title: `${channel.title}: ошибка сбора`,
        text: channel.collector.lastError,
        channelId: channel.id,
      });
    }

    if (channel.antifraud.level === 'high') {
      notifications.push({
        type: 'antifraud',
        level: 'high',
        title: `${channel.title}: высокий риск`,
        text: `AntiFraud обнаружил событий за 24 часа: ${channel.antifraud.events24h}.`,
        channelId: channel.id,
      });
    } else if (channel.antifraud.events24h > 0) {
      notifications.push({
        type: 'antifraud',
        level: 'medium',
        title: `${channel.title}: новые события AntiFraud`,
        text: `Событий за 24 часа: ${channel.antifraud.events24h}.`,
        channelId: channel.id,
      });
    }
  }

  for (const post of posts.filter(
    (post) => post.status === 'error',
  ).slice(0, 10)) {
    notifications.push({
      type: 'post',
      level: 'high',
      title: `${post.channelTitle}: ошибка публикации`,
      text: post.error || 'Публикация завершилась ошибкой.',
      channelId: post.channelId,
    });
  }

  if (subscription.endsAt) {
    const endTime = new Date(subscription.endsAt).getTime();
    const daysLeft = Math.ceil(
      (endTime - Date.now()) / (24 * 60 * 60 * 1000),
    );

    if (Number.isFinite(daysLeft) && daysLeft >= 0 && daysLeft <= 7) {
      notifications.push({
        type: 'subscription',
        level: 'medium',
        title: 'Заканчивается подписка',
        text: `До окончания тарифа осталось дней: ${daysLeft}.`,
      });
    }
  }

  const readyChannels = channels.filter(
    (channel) => channel.metrics,
  );

  const sum = (field) =>
    readyChannels.reduce(
      (total, channel) =>
        total + Number(channel.metrics?.[field] ?? 0),
      0,
    );

  const summary = {
    channels: channels.length,
    analyticsReadyChannels: readyChannels.length,
    subscribers:
      readyChannels.length > 0
        ? sum('subscribers')
        : null,
    views24:
      readyChannels.length > 0
        ? sum('views24')
        : null,
    deltaDay:
      readyChannels.length > 0
        ? sum('deltaDay')
        : null,
    antifraudAlerts: channels.reduce(
      (total, channel) =>
        total + Number(channel.antifraud.events24h || 0),
      0,
    ),
    scheduledPosts: posts.filter(
      (post) => post.status === 'scheduled',
    ).length,
  };

  return {
    ok: true,
    version: 'cabinet-suite-v5',
    user: {
      id: identity.userId,
      linkrayId: String(identity.userId).padStart(6, '0'),
      maxUserId: identity.maxUserId,
      displayName: identity.displayName,
      connectedChannels: channels.length,
    },
    profile: {
      subscription,
      botUrl: LR_CABINET_BOT_URL,
    },
    summary,
    channels,
    notifications: notifications.slice(0, 40),
    posts: posts.slice(0, 40),
    updatedAt: new Date().toISOString(),
  };
}

function lrC5Async(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function lrC5FullHandler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const payload = await lrC5CabinetPayload(req);
    return res.json(payload);
  } catch (error) {
    const status = Number(error?.statusCode || 500);

    console.error(
      '[LinkRay Cabinet API]',
      error?.message || error,
    );

    return res.status(status).json({
      ok: false,
      error:
        status === 401
          ? 'Сессия входа закончилась. Войдите заново.'
          : 'Не удалось загрузить данные кабинета.',
    });
  }
}
// LINKRAY_CABINET_SUITE_V5_MODULE_END


export function mountLinkRayWebsiteRoutes(app) {
  if (!app || typeof app.use !== 'function' || typeof app.get !== 'function') {
    throw new TypeError('LinkRay website requires an Express application');
  }

  
  
// LINKRAY_ACCURATE_CHANNEL_METRICS_V2_START
function lrAccurateRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

function lrAccurateFirst(result) {
  return lrAccurateRows(result)[0] ?? null;
}

function lrAccuratePick(object, names, fallback = null) {
  if (!object || typeof object !== 'object') return fallback;

  for (const name of names) {
    const value = object[name];

    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return fallback;
}

function lrAccurateNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lrAccurateBoolean(value, fallback = false) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;

  const normalized = String(value ?? '').trim().toLowerCase();

  if (['true', 'yes', 'on', 'enabled', 'active'].includes(normalized)) {
    return true;
  }

  if (['false', 'no', 'off', 'disabled', 'inactive'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function lrAccurateParseCookies(req) {
  const result = {};
  const source = String(req.headers.cookie ?? '');

  for (const part of source.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;

    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();

    if (!name) continue;

    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      result[name] = rawValue;
    }
  }

  return result;
}

async function lrAccurateSession(req) {
  const cookies = lrAccurateParseCookies(req);
  const token = String(cookies.lr_web_session ?? '').trim();

  if (!token) return null;

  const { createHash } = await import('node:crypto');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const session = lrAccurateFirst(
    await query(
      `
        SELECT
          s.id AS session_id,
          s.user_id,
          u.max_user_id,
          u.display_name
        FROM public.lr_web_sessions s
        JOIN public.lr_users u
          ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > NOW()
          AND s.revoked_at IS NULL
          AND COALESCE(u.is_blocked, FALSE) = FALSE
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT 1
      `,
      [tokenHash],
    ),
  );

  if (!session) return null;

  query(
    `
      UPDATE public.lr_web_sessions
      SET last_seen_at = NOW()
      WHERE id = $1
    `,
    [session.session_id],
  ).catch(() => {});

  return session;
}

function lrAccurateCleanUrl(value) {
  const url = String(value ?? '').trim();

  if (
    url.startsWith('https://') ||
    url.startsWith('http://') ||
    url.startsWith('/')
  ) {
    return url;
  }

  return null;
}

function lrAccurateSnapshotMatches(snapshot, identifiers) {
  const values = [
    snapshot?.channel_key,
    snapshot?.link,
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);

  return values.some((value) => identifiers.has(value));
}


  // LINKRAY_CABINET_SUITE_V5_ROUTES_START
  app.get(
    ['/cabinet', '/cabinet/'],
    applyWebsiteHeaders,
    (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return sendSiteFile(
        res,
        'cabinet-stable.html',
        'no-store, no-cache, must-revalidate',
      );
    },
  );

  app.get(
    '/api/website/cabinet/full',
    applyWebsiteHeaders,
    lrC5Async(lrC5FullHandler),
  );

  app.get(
    '/api/website/cabinet/overview',
    applyWebsiteHeaders,
    lrC5Async(lrC5FullHandler),
  );
  // LINKRAY_CABINET_SUITE_V5_ROUTES_END

app.get(
  '/api/website/cabinet/overview',
  applyWebsiteHeaders,
  asyncRoute(async (req, res) => {
    const session = await lrAccurateSession(req);

    if (!session?.user_id) {
      return res.status(401).json({
        ok: false,
        error: 'Сессия входа закончилась. Войдите заново.',
      });
    }

    const membershipRows = lrAccurateRows(
      await query(
        `
          SELECT
            to_jsonb(c) AS channel,
            to_jsonb(uc) AS membership
          FROM public.lr_user_channels uc
          JOIN public.channels c
            ON c.id = uc.channel_id
          WHERE uc.user_id = $1
          ORDER BY c.id ASC
        `,
        [session.user_id],
      ),
    );

    const baseChannels = membershipRows
      .map((row) => {
        const channel = row.channel ?? {};
        const membership = row.membership ?? {};

        if (channel.is_active === false) return null;

        const id = lrAccuratePick(channel, ['id']);
        if (id === null || id === undefined) return null;

        const maxChatId = String(
          lrAccuratePick(channel, [
            'max_chat_id',
            'chat_id',
            'channel_id',
          ], ''),
        ).trim();

        const link = String(
          lrAccuratePick(channel, [
            'link',
            'public_link',
            'channel_link',
            'url',
          ], ''),
        ).trim();

        const identifiers = new Set(
          [
            String(id),
            maxChatId,
            link,
          ].filter(Boolean),
        );

        return {
          raw: channel,
          membership,
          id: String(id),
          maxChatId,
          link,
          identifiers,
        };
      })
      .filter(Boolean);

    const allIdentifiers = [
      ...new Set(
        baseChannels.flatMap((channel) => [...channel.identifiers]),
      ),
    ];

    const snapshots = allIdentifiers.length
      ? lrAccurateRows(
          await query(
            `
              SELECT
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
                captured_at
              FROM public.lr_channel_analytics_snapshots
              WHERE CAST(channel_key AS TEXT) = ANY($1::text[])
                 OR COALESCE(CAST(link AS TEXT), '') = ANY($1::text[])
              ORDER BY captured_at DESC NULLS LAST
            `,
            [allIdentifiers],
          ),
        )
      : [];

    const channelIds = baseChannels
      .map((channel) => Number(channel.id))
      .filter((value) => Number.isInteger(value) && value > 0);

    const antifraudRows = channelIds.length
      ? lrAccurateRows(
          await query(
            `
              SELECT to_jsonb(a) AS antifraud
              FROM public.lr_antifraud_channels a
              WHERE a.channel_id = ANY($1::bigint[])
            `,
            [channelIds],
          ).catch(() => []),
        )
      : [];

    const antifraudById = new Map(
      antifraudRows.map((row) => {
        const antifraud = row.antifraud ?? {};
        return [String(antifraud.channel_id), antifraud];
      }),
    );

    const channels = baseChannels.map((base) => {
      const snapshot =
        snapshots.find((item) =>
          lrAccurateSnapshotMatches(item, base.identifiers),
        ) ?? null;

      const analyticsReady = Boolean(snapshot?.captured_at);

      const subscribers = analyticsReady
        ? lrAccurateNumberOrNull(snapshot.subscribers)
        : null;

      const views24 = analyticsReady
        ? lrAccurateNumberOrNull(snapshot.views24)
        : null;

      const views48 = analyticsReady
        ? lrAccurateNumberOrNull(snapshot.views48)
        : null;

      const views72 = analyticsReady
        ? lrAccurateNumberOrNull(snapshot.views72)
        : null;

      const er24 = analyticsReady
        ? lrAccurateNumberOrNull(snapshot.er24)
        : null;

      const deltaDay = analyticsReady
        ? lrAccurateNumberOrNull(snapshot.delta_day)
        : null;

      const antifraud = antifraudById.get(base.id) ?? {};

      return {
        id: base.id,
        maxChatId: base.maxChatId,
        link: base.link || null,
        title: String(
          lrAccuratePick(
            {
              ...snapshot,
              ...base.raw,
            },
            [
              'title',
              'name',
              'channel_title',
              'display_name',
            ],
            `Канал ${base.id}`,
          ),
        ),
        avatar: lrAccurateCleanUrl(
          lrAccuratePick(
            {
              ...snapshot,
              ...base.raw,
            },
            [
              'avatar_url',
              'photo_url',
              'image_url',
              'avatar',
            ],
          ),
        ),
        role: String(
          lrAccuratePick(
            base.membership,
            ['role', 'access_role', 'member_role'],
            'Администратор',
          ),
        ),
        analyticsReady,
        subscribers,
        views24,
        views48,
        views72,
        er24,
        deltaDay,
        capturedAt: snapshot?.captured_at ?? null,
        antifraudEnabled: lrAccurateBoolean(
          lrAccuratePick(
            antifraud,
            [
              'enabled',
              'is_enabled',
              'active',
              'is_active',
            ],
          ),
        ),
      };
    });

    const readyChannels = channels.filter(
      (channel) => channel.analyticsReady,
    );

    const sumNullable = (field) =>
      readyChannels.reduce(
        (sum, channel) => sum + Number(channel[field] ?? 0),
        0,
      );

    return res.json({
      ok: true,
      user: {
        id: String(session.user_id),
        linkrayId: String(session.user_id).padStart(6, '0'),
        displayName: String(
          session.display_name || `Пользователь ${session.user_id}`,
        ),
        maxUserId: String(session.max_user_id ?? ''),
      },
      summary: {
        channels: channels.length,
        analyticsReadyChannels: readyChannels.length,
        subscribers:
          readyChannels.length > 0
            ? sumNullable('subscribers')
            : null,
        views24:
          readyChannels.length > 0
            ? sumNullable('views24')
            : null,
        deltaDay:
          readyChannels.length > 0
            ? sumNullable('deltaDay')
            : null,
      },
      channels,
      metricsSource: 'lr_channel_analytics_snapshots',
      updatedAt: new Date().toISOString(),
    });
  }),
);
// LINKRAY_ACCURATE_CHANNEL_METRICS_V2_END

// LINKRAY_STABLE_CABINET_ROUTE_START
  app.get(['/cabinet', '/cabinet/'], applyWebsiteHeaders, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.sendFile(
      path.resolve(process.cwd(), 'public/linkray-site/cabinet-stable.html')
    );
  });
  // LINKRAY_STABLE_CABINET_ROUTE_END

app.use('/linkray-site', applyWebsiteHeaders);
  app.use(
    '/linkray-site',
    express.static(siteRoot, {
      fallthrough: false,
      index: false,
      maxAge: '7d',
      setHeaders(res, filename) {
        if (filename.endsWith('.html') || filename.endsWith('.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

  app.use('/api/website', express.json({ limit: '32kb' }));

  app.post(
    '/api/website/auth/request-code',
    rateLimit,
    asyncRoute(async (req, res) => {
      await ensureAuthSchema();

      const identifier =
        req.body?.identifier ??
        req.body?.linkrayId ??
        req.body?.linkray_id ??
        
        req.body?.id ??
        req.body?.maxUserId ??
        req.body?.max_user_id;

      const normalized = normalizeIdentifier(identifier);
      if (!normalized) {
        return res.status(400).json({
          ok: false,
          error: 'Введите ID LinkRay или MAX ID.',
        });
      }

      const user = await findLinkRayUser(normalized);
      if (!user || user.is_blocked || !user.max_user_id) {
        return res.status(404).json({
          ok: false,
          error: 'Пользователь LinkRay с таким ID не найден.',
        });
      }

      await query(
        `
          UPDATE public.lr_web_login_codes
          SET used_at = COALESCE(used_at, now())
          WHERE user_id = $1
            AND used_at IS NULL
        `,
        [user.id]
      );

      const challenge = randomToken(24);
      const code = randomCode();

      await query(
        `
          INSERT INTO public.lr_web_login_codes (
            user_id,
            challenge_hash,
            code_hash,
            requested_ip,
            expires_at
          )
          VALUES ($1, $2, $3, $4, now() + interval '10 minutes')
        `,
        [
          user.id,
          sha256(challenge),
          sha256(`${code}:${challenge}`),
          clientIp(req),
        ]
      );

      try {
        await sendMaxMessage({
          userId: String(user.max_user_id),
          format: 'html',
          purpose: 'website_auth',
          text:
            '🔐 <b>Вход в личный кабинет LinkRay</b>\n\n' +
            `Код подтверждения: <b>${code}</b>\n\n` +
            'Код действует 10 минут. Никому его не сообщайте.',
        });
      } catch (error) {
        await query(
          `
            UPDATE public.lr_web_login_codes
            SET used_at = now()
            WHERE challenge_hash = $1
          `,
          [sha256(challenge)]
        ).catch(() => {});

        console.error(
          '[LinkRay Website Auth] code delivery failed',
          error?.stack || error?.message || error
        );

        return res.status(502).json({
          ok: false,
          error:
            'Не удалось отправить код в MAX. Сначала откройте бот LinkRay и нажмите /start.',
        });
      }

      return res.json({
        ok: true,
        challenge,
        expiresIn: Math.floor(LOGIN_CODE_TTL_MS / 1000),
        displayName: String(user.display_name || 'Пользователь LinkRay'),
      });
    })
  );

  app.post(
    '/api/website/auth/verify-code',
    rateLimit,
    asyncRoute(async (req, res) => {
      await ensureAuthSchema();

      const challenge = String(req.body?.challenge || '').trim();
      const code = normalizeCode(req.body?.code);

      if (!challenge || code.length !== 6) {
        return res.status(400).json({
          ok: false,
          error: 'Введите шестизначный код из сообщения LinkRay.',
        });
      }

      const rows = await query(
        `
          SELECT id, user_id, code_hash, attempts
          FROM public.lr_web_login_codes
          WHERE challenge_hash = $1
            AND used_at IS NULL
            AND expires_at > now()
          LIMIT 1
        `,
        [sha256(challenge)]
      );

      const login = rows[0] || null;
      if (!login) {
        return res.status(400).json({
          ok: false,
          error: 'Код истёк. Запросите новый код.',
        });
      }

      if (Number(login.attempts || 0) >= 5) {
        await query(
          `
            UPDATE public.lr_web_login_codes
            SET used_at = now()
            WHERE id = $1
          `,
          [login.id]
        );

        return res.status(429).json({
          ok: false,
          error: 'Слишком много неверных попыток. Запросите новый код.',
        });
      }

      const expected = sha256(`${code}:${challenge}`);
      const valid =
        expected.length === String(login.code_hash).length &&
        crypto.timingSafeEqual(
          Buffer.from(expected),
          Buffer.from(String(login.code_hash))
        );

      if (!valid) {
        await query(
          `
            UPDATE public.lr_web_login_codes
            SET attempts = attempts + 1
            WHERE id = $1
          `,
          [login.id]
        );

        return res.status(400).json({
          ok: false,
          error: 'Неверный код подтверждения.',
        });
      }

      const token = randomToken(32);

      await query(
        `
          UPDATE public.lr_web_login_codes
          SET used_at = now()
          WHERE id = $1
        `,
        [login.id]
      );

      await query(
        `
          INSERT INTO public.lr_web_sessions (
            user_id,
            token_hash,
            created_ip,
            user_agent,
            expires_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            now() + interval '30 days'
          )
        `,
        [
          login.user_id,
          sha256(token),
          clientIp(req),
          String(req.headers['user-agent'] || '').slice(0, 500),
        ]
      );

      setSessionCookie(req, res, token);

      return res.json({
        ok: true,
        authenticated: true,
        redirect: '/cabinet',
      });
    })
  );

  app.get(
    '/api/website/auth/session',
    asyncRoute(async (req, res) => {
      const session = await getSession(req);
      res.setHeader('Cache-Control', 'no-store');

      if (!session) {
        return res.json({
          ok: true,
          authenticated: false,
        });
      }

      return res.json({
        ok: true,
        authenticated: true,
        user: {
          id: Number(session.user_id),
          linkrayId: String(session.user_id).padStart(6, '0'),
          maxUserId: String(session.max_user_id || ''),
          displayName: String(session.display_name || 'Пользователь LinkRay'),
        },
      });
    })
  );

  app.post(
    '/api/website/auth/logout',
    asyncRoute(async (req, res) => {
      await ensureAuthSchema();

      const token = parseCookies(req)[LOGIN_COOKIE];
      if (token) {
        await query(
          `
            UPDATE public.lr_web_sessions
            SET revoked_at = now()
            WHERE token_hash = $1
              AND revoked_at IS NULL
          `,
          [sha256(token)]
        ).catch(() => {});
      }

      clearSessionCookie(req, res);
      return res.json({ ok: true });
    })
  );


app.get('/cabinet', applyWebsiteHeaders, (_req, res) => {
    sendSiteFile(res, 'cabinet.html');
  });

  app.get('/', applyWebsiteHeaders, (_req, res) => {
    sendSiteFile(res, 'index.html');
  });

  app.get('/robots.txt', applyWebsiteHeaders, (_req, res) => {
    sendSiteFile(res, 'robots.txt', 'public, max-age=3600');
  });

  app.get('/sitemap.xml', applyWebsiteHeaders, (_req, res) => {
    sendSiteFile(res, 'sitemap.xml', 'public, max-age=3600');
  });

  app.get('/site.webmanifest', applyWebsiteHeaders, (_req, res) => {
    sendSiteFile(res, 'site.webmanifest', 'public, max-age=86400');
  });

  app.get('/go-bot', (_req, res) => {
    const target = String(
      process.env.LINKRAY_BOT_URL ||
      process.env.MAX_BOT_URL ||
      'https://max.ru'
    ).trim();

    res.redirect(302, target);
  });

  app.get('/api/website/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      service: 'linkray-website',
      version: 'auth-v1',
      authentication: true,
    });
  });

  app.use((error, req, res, next) => {
    if (!String(req.path || '').startsWith('/api/website/')) {
      return next(error);
    }

    console.error(
      '[LinkRay Website API]',
      error?.stack || error?.message || error
    );

    if (res.headersSent) return next(error);

    return res.status(500).json({
      ok: false,
      error: 'Внутренняя ошибка LinkRay. Повторите попытку.',
    });
  });

  console.log('[LinkRay Website] auth-v1 routes mounted');
}
