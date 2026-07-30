import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from './db.js';
import { sendMaxMessage } from './maxClient.js';

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

export function mountLinkRayWebsiteRoutes(app) {
  if (!app || typeof app.use !== 'function' || typeof app.get !== 'function') {
    throw new TypeError('LinkRay website requires an Express application');
  }

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

  app.get(
    '/api/website/cabinet/overview',
    requireSession(async (req, res) => {
      const session = req.linkraySession;

      const channelRows = await query(
        `
          SELECT
            to_jsonb(c) AS channel_data,
            uc.role,
            uc.access_source,
            uc.linked_at
          FROM public.lr_user_channels uc
          JOIN public.channels c ON c.id = uc.channel_id
          WHERE uc.user_id = $1
          ORDER BY
            COALESCE(c.is_active, true) DESC,
            c.title NULLS LAST,
            c.id
        `,
        [session.user_id]
      );

      const channels = channelRows.map(safeChannel);

      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        ok: true,
        user: {
          id: Number(session.user_id),
          linkrayId: String(session.user_id).padStart(6, '0'),
          maxUserId: String(session.max_user_id || ''),
          displayName: String(session.display_name || 'Пользователь LinkRay'),
        },
        summary: {
          channels: channels.length,
          activeChannels: channels.filter((channel) => channel.isActive).length,
          subscribers: channels.reduce(
            (total, channel) =>
              total + (Number.isFinite(channel.subscribers) ? channel.subscribers : 0),
            0
          ),
        },
        channels,
      });
    })
  );

  
// LINKRAY_REAL_CABINET_API_V1_START
const lrCabinetColumnsCache = new Map();

function lrCabinetRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

function lrCabinetFirst(result) {
  return lrCabinetRows(result)[0] ?? null;
}

function lrCabinetQuoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function lrCabinetPick(object, names, fallback = null) {
  if (!object || typeof object !== 'object') return fallback;

  for (const name of names) {
    const value = object[name];

    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return fallback;
}

function lrCabinetNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function lrCabinetBoolean(value, fallback = false) {
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

async function lrCabinetTableColumns(tableName) {
  if (lrCabinetColumnsCache.has(tableName)) {
    return lrCabinetColumnsCache.get(tableName);
  }

  const result = await query(
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName],
  );

  const columns = new Map(
    lrCabinetRows(result).map((row) => [
      String(row.column_name),
      String(row.data_type ?? ''),
    ]),
  );

  lrCabinetColumnsCache.set(tableName, columns);
  return columns;
}

function lrCabinetColumn(columns, names) {
  for (const name of names) {
    if (columns.has(name)) return name;
  }

  return null;
}

async function lrCabinetResolveSession(req) {
  const rawCookie = String(req.headers.cookie ?? '');

  const cookieValues = rawCookie
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=');
      return separator >= 0 ? entry.slice(separator + 1) : '';
    })
    .filter(Boolean)
    .map((value) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    });

  if (!cookieValues.length) return null;

  const { createHash } = await import('node:crypto');

  const hashes = [...new Set(
    cookieValues.map((value) =>
      createHash('sha256').update(String(value)).digest('hex'),
    ),
  )];

  if (!hashes.length) return null;

  const session = lrCabinetFirst(
    await query(
      `
        SELECT *
        FROM public.lr_web_sessions
        WHERE token_hash = ANY($1::text[])
          AND (expires_at IS NULL OR expires_at > NOW())
          AND revoked_at IS NULL
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 1
      `,
      [hashes],
    ),
  );

  if (!session) return null;

  try {
    await query(
      `
        UPDATE public.lr_web_sessions
        SET last_seen_at = NOW()
        WHERE id = $1
      `,
      [session.id],
    );
  } catch (error) {
    console.warn('[LinkRay cabinet] last_seen update failed:', error?.message);
  }

  return session;
}

async function lrCabinetLatestByChannel(tableName, channelId) {
  try {
    const columns = await lrCabinetTableColumns(tableName);
    if (!columns.size) return null;

    const channelColumn = lrCabinetColumn(columns, [
      'channel_id',
      'max_chat_id',
      'chat_id',
      'channel_chat_id',
      'max_channel_id',
    ]);

    if (!channelColumn) return null;

    const orderColumn = lrCabinetColumn(columns, [
      'snapshot_at',
      'captured_at',
      'measured_at',
      'updated_at',
      'created_at',
      'date',
      'id',
    ]);

    const orderSql = orderColumn
      ? `ORDER BY ${lrCabinetQuoteIdentifier(orderColumn)} DESC NULLS LAST`
      : '';

    return lrCabinetFirst(
      await query(
        `
          SELECT *
          FROM public.${lrCabinetQuoteIdentifier(tableName)}
          WHERE CAST(${lrCabinetQuoteIdentifier(channelColumn)} AS TEXT) = $1
          ${orderSql}
          LIMIT 1
        `,
        [String(channelId)],
      ),
    );
  } catch (error) {
    console.warn(
      `[LinkRay cabinet] ${tableName} lookup failed:`,
      error?.message,
    );
    return null;
  }
}

async function lrCabinetAntifraudEventCount(channelId) {
  try {
    const columns = await lrCabinetTableColumns('lr_antifraud_events');
    if (!columns.size) return 0;

    const channelColumn = lrCabinetColumn(columns, [
      'channel_id',
      'max_chat_id',
      'chat_id',
      'channel_chat_id',
    ]);

    if (!channelColumn) return 0;

    const timeColumn = lrCabinetColumn(columns, [
      'detected_at',
      'event_at',
      'created_at',
      'updated_at',
      'started_at',
    ]);

    const timeSql = timeColumn
      ? `AND ${lrCabinetQuoteIdentifier(timeColumn)} >= NOW() - INTERVAL '24 hours'`
      : '';

    const row = lrCabinetFirst(
      await query(
        `
          SELECT COUNT(*)::int AS count
          FROM public.lr_antifraud_events
          WHERE CAST(${lrCabinetQuoteIdentifier(channelColumn)} AS TEXT) = $1
          ${timeSql}
        `,
        [String(channelId)],
      ),
    );

    return lrCabinetNumber(row?.count);
  } catch (error) {
    console.warn(
      '[LinkRay cabinet] antifraud event count failed:',
      error?.message,
    );
    return 0;
  }
}

async function lrCabinetUserChannels(userId) {
  const columns = await lrCabinetTableColumns('lr_user_channels');

  if (!columns.size) return [];

  const userColumn = lrCabinetColumn(columns, [
    'user_id',
    'linkray_user_id',
    'owner_user_id',
    'admin_user_id',
  ]);

  if (!userColumn) return [];

  const orderColumn = lrCabinetColumn(columns, [
    'created_at',
    'added_at',
    'updated_at',
    'id',
  ]);

  const orderSql = orderColumn
    ? `ORDER BY ${lrCabinetQuoteIdentifier(orderColumn)} ASC NULLS LAST`
    : '';

  return lrCabinetRows(
    await query(
      `
        SELECT *
        FROM public.lr_user_channels
        WHERE ${lrCabinetQuoteIdentifier(userColumn)} = $1
        ${orderSql}
      `,
      [userId],
    ),
  );
}

function lrCabinetSafeAvatar(value) {
  const avatar = String(value ?? '').trim();

  if (
    avatar.startsWith('https://') ||
    avatar.startsWith('http://') ||
    avatar.startsWith('/')
  ) {
    return avatar;
  }

  return null;
}

app.get(
  '/api/website/cabinet/overview',
  applyWebsiteHeaders,
  asyncRoute(async (req, res) => {
    const session = await lrCabinetResolveSession(req);

    if (!session?.user_id) {
      return res.status(401).json({
        ok: false,
        error: 'Сессия истекла. Войдите заново.',
      });
    }

    const user =
      lrCabinetFirst(
        await query(
          `
            SELECT *
            FROM public.lr_users
            WHERE id = $1
            LIMIT 1
          `,
          [session.user_id],
        ),
      ) ??
      lrCabinetFirst(
        await query(
          `
            SELECT *
            FROM public.lr_real_users
            WHERE id = $1
            LIMIT 1
          `,
          [session.user_id],
        ),
      );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'Профиль LinkRay не найден.',
      });
    }

    const membershipRows = await lrCabinetUserChannels(session.user_id);
    const channels = [];

    for (const membership of membershipRows) {
      const channelId = lrCabinetPick(membership, [
        'channel_id',
        'max_chat_id',
        'chat_id',
        'channel_chat_id',
        'max_channel_id',
      ]);

      if (channelId === null || channelId === undefined) continue;

      const [
        analytics,
        metrics,
        settings,
        antifraud,
        avatarRow,
      ] = await Promise.all([
        lrCabinetLatestByChannel(
          'lr_channel_analytics_snapshots',
          channelId,
        ),
        lrCabinetLatestByChannel('lr_channel_metrics_state', channelId),
        lrCabinetLatestByChannel(
          'lr_channel_analytics_settings',
          channelId,
        ),
        lrCabinetLatestByChannel('lr_antifraud_channels', channelId),
        lrCabinetLatestByChannel('lr_channel_avatar_cache', channelId),
      ]);

      const combined = {
        ...settings,
        ...metrics,
        ...analytics,
        ...membership,
      };

      const title = String(
        lrCabinetPick(combined, [
          'channel_title',
          'title',
          'channel_name',
          'name',
          'display_name',
        ], `Канал ${channelId}`),
      );

      const subscribers = lrCabinetNumber(
        lrCabinetPick(combined, [
          'subscribers',
          'subscriber_count',
          'members',
          'member_count',
          'participants_count',
          'current_members',
          'total_members',
          'audience',
        ]),
      );

      const views24 = lrCabinetNumber(
        lrCabinetPick(combined, [
          'views24',
          'views_24',
          'views_24h',
          'views24h',
          'views_last_24h',
          'post_views_24h',
        ]),
      );

      const joined24 = lrCabinetNumber(
        lrCabinetPick(combined, [
          'joined24',
          'joined_24',
          'joined_24h',
          'subscribed_24h',
          'subscriptions_24h',
          'new_members_24h',
        ]),
      );

      const left24 = lrCabinetNumber(
        lrCabinetPick(combined, [
          'left24',
          'left_24',
          'left_24h',
          'unsubscribed_24h',
          'unsubscriptions_24h',
          'lost_members_24h',
        ]),
      );

      const storedEr = lrCabinetNumber(
        lrCabinetPick(combined, [
          'er',
          'er_percent',
          'engagement_rate',
          'engagement_rate_percent',
        ]),
        Number.NaN,
      );

      const er = Number.isFinite(storedEr)
        ? storedEr
        : subscribers > 0
          ? (views24 / subscribers) * 100
          : 0;

      const antifraudEnabled = lrCabinetBoolean(
        lrCabinetPick(antifraud, [
          'enabled',
          'is_enabled',
          'active',
          'is_active',
          'protection_enabled',
        ]),
      );

      const antifraudStatus = String(
        lrCabinetPick(antifraud, [
          'status',
          'state',
          'protection_status',
        ], antifraudEnabled ? 'Защита включена' : 'Защита выключена'),
      );

      const alertCount24 = await lrCabinetAntifraudEventCount(channelId);

      const avatar = lrCabinetSafeAvatar(
        lrCabinetPick(
          {
            ...avatarRow,
            ...combined,
          },
          [
            'avatar_url',
            'photo_url',
            'image_url',
            'avatar',
            'photo',
          ],
        ),
      );

      channels.push({
        id: String(channelId),
        title,
        avatar,
        role: String(
          lrCabinetPick(membership, [
            'role',
            'access_role',
            'member_role',
          ], 'Администратор'),
        ),
        subscribers,
        views24,
        joined24,
        left24,
        net24: joined24 - left24,
        er: Number(er.toFixed(2)),
        antifraudEnabled,
        antifraudStatus,
        alertCount24,
      });
    }

    const displayName = String(
      lrCabinetPick(user, [
        'display_name',
        'full_name',
        'name',
        'first_name',
        'username',
      ], 'Пользователь LinkRay'),
    );

    const rawLinkRayId = lrCabinetPick(user, [
      'linkray_id',
      'profile_number',
      'public_id',
      'number',
      'id',
    ], session.user_id);

    const numericLinkRayId = Number(rawLinkRayId);
    const linkrayId = Number.isFinite(numericLinkRayId)
      ? String(numericLinkRayId).padStart(6, '0')
      : String(rawLinkRayId);

    const totalSubscribers = channels.reduce(
      (sum, channel) => sum + channel.subscribers,
      0,
    );

    const totalViews24 = channels.reduce(
      (sum, channel) => sum + channel.views24,
      0,
    );

    const totalNet24 = channels.reduce(
      (sum, channel) => sum + channel.net24,
      0,
    );

    const protectedChannels = channels.filter(
      (channel) => channel.antifraudEnabled,
    ).length;

    const alerts24 = channels.reduce(
      (sum, channel) => sum + channel.alertCount24,
      0,
    );

    return res.json({
      ok: true,
      user: {
        id: String(user.id ?? session.user_id),
        linkrayId,
        displayName,
        maxUserId: String(
          lrCabinetPick(user, ['max_user_id', 'maxUserId'], ''),
        ),
      },
      summary: {
        channels: channels.length,
        subscribers: totalSubscribers,
        views24: totalViews24,
        net24: totalNet24,
        protectedChannels,
        alerts24,
      },
      channels,
      studioUrl: 'https://max.ru/se13353901_bot',
      updatedAt: new Date().toISOString(),
    });
  }),
);
// LINKRAY_REAL_CABINET_API_V1_END


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
