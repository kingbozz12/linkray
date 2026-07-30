import crypto from 'node:crypto';
import express from 'express';
import { query } from './db.js';
import { sendMaxMessage } from './maxClient.js';

const SESSION_COOKIE = 'lr_web_session';
const SESSION_DAYS = Math.max(1, Number(process.env.LR_WEB_SESSION_DAYS || 30));
const CODE_TTL_MINUTES = Math.max(3, Number(process.env.LR_WEB_CODE_TTL_MINUTES || 10));
const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL || process.env.BASE_URL || process.env.SITE_URL || 'https://linkray.ru'
).replace(/\/+$/, '');
let schemaReady = null;

function rows(result) {
  return Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function secret() {
  const value = clean(
    process.env.LR_WEB_SECRET ||
    process.env.BOT_TOKEN ||
    process.env.MAX_BOT_TOKEN ||
    process.env.MAX_TOKEN,
    2000
  );
  if (!value) {
    throw new Error('LR_WEB_SECRET or BOT_TOKEN is required for website authentication');
  }
  return value;
}

function hmac(value) {
  return crypto.createHmac('sha256', secret()).update(String(value)).digest('hex');
}

function parseCookies(req) {
  const source = String(req.headers.cookie || '');
  const out = {};
  for (const part of source.split(';')) {
    const pos = part.indexOf('=');
    if (pos < 0) continue;
    const key = part.slice(0, pos).trim();
    const value = part.slice(pos + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); }
    catch { out[key] = value; }
  }
  return out;
}

function clientIp(req) {
  return clean(
    String(req.headers['x-forwarded-for'] || '').split(',')[0] ||
    req.socket?.remoteAddress ||
    '',
    200
  );
}

function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

function sameOrigin(req) {
  const origin = clean(req.headers.origin, 500);
  if (!origin) return true;
  try {
    const allowed = new URL(PUBLIC_BASE_URL);
    const actual = new URL(origin);
    return actual.host === allowed.host && actual.protocol === allowed.protocol;
  } catch {
    return false;
  }
}

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS public.lr_web_login_codes (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL,
        code_hash text NOT NULL,
        request_ip_hash text,
        attempts integer NOT NULL DEFAULT 0,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS lr_web_login_codes_user_time_idx
      ON public.lr_web_login_codes(user_id, created_at DESC)
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS public.lr_web_sessions (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL,
        token_hash text NOT NULL UNIQUE,
        ip_hash text,
        user_agent text,
        expires_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS lr_web_sessions_user_idx
      ON public.lr_web_sessions(user_id, expires_at DESC)
    `);
    await query(`DELETE FROM public.lr_web_login_codes WHERE expires_at < now() - interval '1 day'`).catch(() => {});
    await query(`DELETE FROM public.lr_web_sessions WHERE expires_at < now()`).catch(() => {});
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function findUser(login) {
  const value = clean(login, 120).replace(/^LR-/i, '');
  if (!/^\d+$/.test(value)) return null;
  const result = rows(await query(`
    SELECT id, max_user_id, display_name, is_blocked
    FROM public.lr_users
    WHERE (id::text=$1 OR max_user_id::text=$1)
      AND COALESCE(is_blocked, false)=false
    ORDER BY CASE WHEN id::text=$1 THEN 0 ELSE 1 END
    LIMIT 1
  `, [value]));
  return result[0] || null;
}

async function sessionUser(req) {
  await ensureSchema();
  const token = clean(parseCookies(req)[SESSION_COOKIE], 300);
  if (!token) return null;
  const tokenHash = sha(token);
  const result = rows(await query(`
    SELECT s.id AS session_id, s.user_id, u.max_user_id, u.display_name
    FROM public.lr_web_sessions s
    JOIN public.lr_users u ON u.id=s.user_id
    WHERE s.token_hash=$1
      AND s.expires_at > now()
      AND COALESCE(u.is_blocked, false)=false
    LIMIT 1
  `, [tokenHash]));
  const user = result[0] || null;
  if (user) {
    query(`UPDATE public.lr_web_sessions SET last_seen_at=now() WHERE id=$1`, [user.session_id]).catch(() => {});
  }
  return user;
}

function requireAuth(handler) {
  return async (req, res) => {
    try {
      const user = await sessionUser(req);
      if (!user) {
        clearSessionCookie(res);
        return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', message: 'Войдите в LinkRay' });
      }
      req.linkrayWebUser = user;
      return await handler(req, res);
    } catch (error) {
      console.error('[LinkRay Web Cabinet]', error?.stack || error?.message || error);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: 'Ошибка сервера LinkRay' });
    }
  };
}

function pick(object, names, fallback = '') {
  if (!object || typeof object !== 'object') return fallback;
  for (const name of names) {
    const value = object[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return fallback;
}

function plainText(value, max = 160) {
  const text = String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, max);
}

function normalizeStatus(value) {
  const status = clean(value, 80).toLowerCase();
  const map = {
    pending: 'Запланирован', scheduled: 'Запланирован', queued: 'В очереди',
    published: 'Опубликован', sent: 'Опубликован', done: 'Опубликован',
    deleted: 'Удалён', cancelled: 'Отменён', canceled: 'Отменён', failed: 'Ошибка', error: 'Ошибка'
  };
  return map[status] || (status ? status : 'Неизвестно');
}

async function loadChannels(userId) {
  const result = rows(await query(`
    SELECT to_jsonb(c) AS channel, uc.role, uc.permissions, uc.last_verified_at
    FROM public.lr_user_channels uc
    JOIN public.channels c ON c.id=uc.channel_id
    WHERE uc.user_id=$1
      AND COALESCE(c.is_active, true)=true
    ORDER BY COALESCE(c.updated_at, c.bot_added_at, now()) DESC, c.id DESC
  `, [userId]));

  const channels = result.map((row) => {
    const c = row.channel || {};
    return {
      id: num(c.id),
      title: clean(pick(c, ['title', 'name', 'channel_title'], `Канал ${c.id}`), 300),
      maxChatId: clean(pick(c, ['max_chat_id', 'chat_id', 'channel_id'], ''), 120),
      link: clean(pick(c, ['link', 'public_link', 'channel_link', 'url'], ''), 1000),
      avatarUrl: clean(pick(c, ['avatar_url', 'photo_url', 'image_url', 'avatar'], ''), 2000),
      role: clean(row.role || 'admin', 80),
      permissions: Array.isArray(row.permissions) ? row.permissions : [],
      lastVerifiedAt: row.last_verified_at || null,
      raw: c,
    };
  }).filter((channel) => channel.id > 0);

  if (!channels.length) return [];

  const ids = channels.map((channel) => channel.id);
  const antifraudRows = rows(await query(`
    SELECT channel_id, enabled, enabled_at, disabled_at, last_event_at, learning_started_at
    FROM public.lr_antifraud_channels
    WHERE channel_id=ANY($1::bigint[])
  `, [ids]).catch(() => []));
  const antifraudById = new Map(antifraudRows.map((row) => [num(row.channel_id), row]));

  const identifiers = [...new Set(channels.flatMap((channel) => [
    String(channel.id), channel.maxChatId, channel.link
  ]).filter(Boolean))];
  const snapshots = identifiers.length ? rows(await query(`
    SELECT DISTINCT ON (channel_key)
      channel_key, link, title, avatar_url, subscribers, views24, views48, views72,
      er24, delta_day, captured_at
    FROM public.lr_channel_analytics_snapshots
    WHERE channel_key=ANY($1::text[]) OR link=ANY($1::text[])
    ORDER BY channel_key, captured_at DESC
  `, [identifiers]).catch(() => [])) : [];

  for (const channel of channels) {
    const candidate = snapshots.find((snapshot) => {
      const values = [snapshot.channel_key, snapshot.link].map((v) => clean(v, 1000));
      return values.includes(String(channel.id)) ||
        (channel.maxChatId && values.includes(channel.maxChatId)) ||
        (channel.link && values.includes(channel.link));
    });
    const af = antifraudById.get(channel.id) || {};
    channel.analytics = candidate ? {
      subscribers: num(candidate.subscribers),
      views24: num(candidate.views24),
      views48: num(candidate.views48),
      views72: num(candidate.views72),
      er24: Number(candidate.er24 || 0),
      deltaDay: num(candidate.delta_day),
      capturedAt: candidate.captured_at || null,
    } : null;
    if (!channel.avatarUrl && candidate?.avatar_url) channel.avatarUrl = clean(candidate.avatar_url, 2000);
    channel.antifraud = {
      enabled: Boolean(af.enabled),
      enabledAt: af.enabled_at || null,
      disabledAt: af.disabled_at || null,
      lastEventAt: af.last_event_at || null,
      learningStartedAt: af.learning_started_at || null,
    };
    delete channel.raw;
  }
  return channels;
}

async function loadPosts(userId) {
  const result = rows(await query(`
    SELECT to_jsonb(p) AS post, c.title AS channel_title
    FROM public.scheduled_posts p
    JOIN public.lr_user_channels uc ON uc.channel_id=p.channel_id AND uc.user_id=$1
    LEFT JOIN public.channels c ON c.id=p.channel_id
    ORDER BY COALESCE(p.publish_at, p.published_at, p.created_at, p.updated_at) DESC NULLS LAST, p.id DESC
    LIMIT 60
  `, [userId]).catch(() => []));

  return result.map((row) => {
    const p = row.post || {};
    const content = p.content && typeof p.content === 'object' ? p.content : {};
    const raw = p.raw && typeof p.raw === 'object' ? p.raw : {};
    const text = pick(p, ['title', 'text', 'caption', 'post_text'], '') ||
      pick(content, ['title', 'text', 'caption'], '') ||
      pick(raw, ['title', 'text', 'caption'], 'Публикация LinkRay');
    const date = pick(p, ['publish_at', 'published_at', 'created_at', 'updated_at'], null);
    return {
      id: String(p.id ?? ''),
      channelId: num(p.channel_id),
      channelTitle: clean(row.channel_title || 'Канал MAX', 300),
      title: plainText(text || 'Публикация LinkRay', 120),
      status: normalizeStatus(p.status),
      statusRaw: clean(p.status, 80),
      date,
      isAd: Boolean(p.is_ad || p.isAd || p.cpm),
      cpm: p.cpm === null || p.cpm === undefined ? null : num(p.cpm),
    };
  });
}

async function loadAnalytics(channels) {
  const identifiers = [...new Set(channels.flatMap((channel) => [
    String(channel.id), channel.maxChatId, channel.link
  ]).filter(Boolean))];
  if (!identifiers.length) return { days: [], subscribers: 0, views24: 0, deltaDay: 0, er24: 0 };

  const daily = rows(await query(`
    WITH per_channel_day AS (
      SELECT channel_key, date_trunc('day', captured_at) AS day,
             max(subscribers)::bigint AS subscribers,
             max(views24)::bigint AS views24,
             max(delta_day)::bigint AS delta_day,
             max(er24)::numeric AS er24
      FROM public.lr_channel_analytics_snapshots
      WHERE channel_key=ANY($1::text[]) OR link=ANY($1::text[])
      GROUP BY channel_key, date_trunc('day', captured_at)
    )
    SELECT day,
           sum(subscribers)::bigint AS subscribers,
           sum(views24)::bigint AS views24,
           sum(delta_day)::bigint AS delta_day,
           avg(er24)::numeric AS er24
    FROM per_channel_day
    GROUP BY day
    ORDER BY day DESC
    LIMIT 30
  `, [identifiers]).catch(() => []));

  const days = daily.reverse().map((row) => ({
    day: row.day,
    subscribers: num(row.subscribers),
    views24: num(row.views24),
    deltaDay: num(row.delta_day),
    er24: Number(row.er24 || 0),
  }));
  const latest = days.at(-1) || {};
  return {
    days,
    subscribers: num(latest.subscribers),
    views24: num(latest.views24),
    deltaDay: num(latest.deltaDay),
    er24: Number(latest.er24 || 0),
  };
}

async function loadAntifraud(userId) {
  const channels = rows(await query(`
    SELECT c.id AS channel_id, COALESCE(af.max_chat_id, c.max_chat_id::text) AS max_chat_id, COALESCE(c.title, af.title, 'Канал MAX') AS title,
           af.enabled, af.enabled_at, af.disabled_at, af.learning_started_at, af.last_event_at,
           latest.id AS wave_id, latest.status AS wave_status, latest.started_at,
           latest.joined_count, latest.removed_count, latest.high_count, latest.medium_count,
           latest.normal_count, latest.eligible_count, latest.participants_before, latest.participants_after
    FROM public.lr_user_channels uc
    JOIN public.channels c ON c.id=uc.channel_id
    LEFT JOIN public.lr_antifraud_channels af ON af.channel_id=c.id
    LEFT JOIN LATERAL (
      SELECT * FROM public.lr_antifraud_waves w
      WHERE w.channel_id=c.id
      ORDER BY w.started_at DESC, w.id DESC
      LIMIT 1
    ) latest ON true
    WHERE uc.user_id=$1 AND COALESCE(c.is_active, true)=true
    ORDER BY c.title, c.id
  `, [userId]).catch(() => []));

  const channelIds = channels.map((row) => num(row.channel_id)).filter(Boolean);
  let events24 = 0;
  if (channelIds.length) {
    const countRows = rows(await query(`
      SELECT count(*)::bigint AS total
      FROM public.lr_antifraud_events
      WHERE channel_id=ANY($1::bigint[]) AND event_at >= now() - interval '24 hours'
    `, [channelIds]).catch(() => []));
    events24 = num(countRows[0]?.total);
  }

  const items = channels.map((row) => ({
    channelId: num(row.channel_id),
    maxChatId: clean(row.max_chat_id, 120),
    title: clean(row.title, 300),
    enabled: Boolean(row.enabled),
    enabledAt: row.enabled_at || null,
    disabledAt: row.disabled_at || null,
    learningStartedAt: row.learning_started_at || null,
    lastEventAt: row.last_event_at || null,
    latestWave: row.wave_id ? {
      id: String(row.wave_id), status: clean(row.wave_status, 80), startedAt: row.started_at,
      joined: num(row.joined_count), removed: num(row.removed_count), high: num(row.high_count),
      medium: num(row.medium_count), normal: num(row.normal_count), eligible: num(row.eligible_count),
      participantsBefore: row.participants_before === null ? null : num(row.participants_before),
      participantsAfter: row.participants_after === null ? null : num(row.participants_after),
    } : null,
  }));

  return {
    channels: items,
    protectedChannels: items.filter((item) => item.enabled).length,
    events24,
    currentRisk: items.some((item) => num(item.latestWave?.high) > 0) ? 'Высокий' :
      items.some((item) => num(item.latestWave?.medium) > 0) ? 'Средний' : 'Низкий',
  };
}

async function buildDashboard(user) {
  const channels = await loadChannels(user.user_id);
  const [posts, analytics, antifraud] = await Promise.all([
    loadPosts(user.user_id),
    loadAnalytics(channels),
    loadAntifraud(user.user_id),
  ]);
  const scheduled = posts.filter((post) => ['pending', 'scheduled', 'queued'].includes(post.statusRaw.toLowerCase())).length;
  return {
    user: {
      id: num(user.user_id),
      maxUserId: clean(user.max_user_id, 120),
      displayName: clean(user.display_name || `Пользователь ${user.user_id}`, 300),
    },
    overview: {
      channels: channels.length,
      subscribers: channels.reduce((sum, channel) => sum + num(channel.analytics?.subscribers), 0),
      deltaDay: channels.reduce((sum, channel) => sum + num(channel.analytics?.deltaDay), 0),
      views24: channels.reduce((sum, channel) => sum + num(channel.analytics?.views24), 0),
      scheduled,
    },
    channels,
    posts,
    analytics,
    antifraud,
    generatedAt: new Date().toISOString(),
  };
}

export function installLinkRayWebCabinet(app) {
  if (!app || typeof app.use !== 'function') throw new TypeError('Express app is required');
  if (app.__linkrayWebCabinetInstalled) return;
  app.__linkrayWebCabinetInstalled = true;

  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      return res.status(403).json({ ok: false, error: 'BAD_ORIGIN', message: 'Запрос отклонён' });
    }
    next();
  });

  router.get('/health', async (_req, res) => {
    try {
      await ensureSchema();
      res.json({ ok: true, service: 'linkray-web-cabinet', version: 'production-v1' });
    } catch (error) {
      res.status(500).json({ ok: false, error: clean(error?.message || error, 500) });
    }
  });

  router.post('/auth/request-code', async (req, res) => {
    try {
      await ensureSchema();
      const login = clean(req.body?.login, 120);
      const user = await findUser(login);
      if (!user) {
        return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND', message: 'Аккаунт LinkRay не найден' });
      }
      const ipHash = sha(`${secret()}:${clientIp(req)}`);
      const rateRows = rows(await query(`
        SELECT
          count(*) FILTER (WHERE request_ip_hash=$1 AND created_at > now()-interval '10 minutes')::int AS by_ip,
          count(*) FILTER (WHERE user_id=$2 AND created_at > now()-interval '5 minutes')::int AS by_user
        FROM public.lr_web_login_codes
      `, [ipHash, user.id]));
      if (num(rateRows[0]?.by_ip) >= 10 || num(rateRows[0]?.by_user) >= 4) {
        return res.status(429).json({ ok: false, error: 'RATE_LIMIT', message: 'Слишком много запросов. Повторите позже' });
      }
      const code = String(crypto.randomInt(100000, 1000000));
      const codeHash = hmac(`${user.id}:${code}`);
      await query(`
        INSERT INTO public.lr_web_login_codes(user_id, code_hash, request_ip_hash, expires_at)
        VALUES($1,$2,$3,now()+($4::text || ' minutes')::interval)
      `, [user.id, codeHash, ipHash, String(CODE_TTL_MINUTES)]);
      await sendMaxMessage({
        userId: String(user.max_user_id),
        purpose: 'web_login_code',
        text:
          `🔐 <b>Вход в LinkRay</b>\n\n` +
          `Код подтверждения: <b>${code}</b>\n` +
          `Он действует ${CODE_TTL_MINUTES} минут.\n\n` +
          `Если вы не запрашивали вход на linkray.ru, просто проигнорируйте это сообщение.`,
        format: 'html',
      });
      return res.json({ ok: true, expiresIn: CODE_TTL_MINUTES * 60, maskedUser: `LinkRay ID ${user.id}` });
    } catch (error) {
      console.error('[LinkRay Web Auth request]', error?.stack || error?.message || error);
      return res.status(500).json({ ok: false, error: 'SEND_FAILED', message: 'Не удалось отправить код в MAX' });
    }
  });

  router.post('/auth/verify', async (req, res) => {
    try {
      await ensureSchema();
      const login = clean(req.body?.login, 120);
      const code = clean(req.body?.code, 20);
      const user = await findUser(login);
      if (!user || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ ok: false, error: 'INVALID_CODE', message: 'Неверный код' });
      }
      const codes = rows(await query(`
        SELECT id, code_hash, attempts
        FROM public.lr_web_login_codes
        WHERE user_id=$1 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1
      `, [user.id]));
      const record = codes[0];
      if (!record || num(record.attempts) >= 6) {
        return res.status(400).json({ ok: false, error: 'CODE_EXPIRED', message: 'Код истёк. Запросите новый' });
      }
      const valid = crypto.timingSafeEqual(
        Buffer.from(String(record.code_hash)),
        Buffer.from(hmac(`${user.id}:${code}`))
      );
      if (!valid) {
        await query(`UPDATE public.lr_web_login_codes SET attempts=attempts+1 WHERE id=$1`, [record.id]);
        return res.status(400).json({ ok: false, error: 'INVALID_CODE', message: 'Неверный код' });
      }
      await query(`UPDATE public.lr_web_login_codes SET consumed_at=now() WHERE id=$1`, [record.id]);
      const token = crypto.randomBytes(32).toString('base64url');
      await query(`
        INSERT INTO public.lr_web_sessions(user_id, token_hash, ip_hash, user_agent, expires_at)
        VALUES($1,$2,$3,$4,now()+($5::text || ' days')::interval)
      `, [
        user.id,
        sha(token),
        sha(`${secret()}:${clientIp(req)}`),
        clean(req.headers['user-agent'], 1000),
        String(SESSION_DAYS),
      ]);
      setSessionCookie(res, token);
      return res.json({ ok: true, user: { id: num(user.id), displayName: clean(user.display_name, 300) } });
    } catch (error) {
      console.error('[LinkRay Web Auth verify]', error?.stack || error?.message || error);
      return res.status(500).json({ ok: false, error: 'VERIFY_FAILED', message: 'Не удалось выполнить вход' });
    }
  });

  router.get('/session', async (req, res) => {
    try {
      const user = await sessionUser(req);
      if (!user) return res.json({ ok: true, authenticated: false });
      return res.json({
        ok: true,
        authenticated: true,
        user: { id: num(user.user_id), maxUserId: clean(user.max_user_id, 120), displayName: clean(user.display_name, 300) },
      });
    } catch (error) {
      return res.status(500).json({ ok: false, authenticated: false, message: 'Ошибка проверки входа' });
    }
  });

  router.post('/logout', async (req, res) => {
    try {
      const token = clean(parseCookies(req)[SESSION_COOKIE], 300);
      if (token) await query(`DELETE FROM public.lr_web_sessions WHERE token_hash=$1`, [sha(token)]).catch(() => {});
      clearSessionCookie(res);
      return res.json({ ok: true });
    } catch {
      clearSessionCookie(res);
      return res.json({ ok: true });
    }
  });

  router.get('/dashboard', requireAuth(async (req, res) => {
    const data = await buildDashboard(req.linkrayWebUser);
    return res.json({ ok: true, data });
  }));

  router.post('/antifraud/:channelId/toggle', requireAuth(async (req, res) => {
    const channelId = Number(req.params.channelId);
    const enabled = Boolean(req.body?.enabled);
    if (!Number.isInteger(channelId) || channelId <= 0) {
      return res.status(400).json({ ok: false, error: 'BAD_CHANNEL', message: 'Некорректный канал' });
    }
    const access = rows(await query(`
      SELECT c.id, c.max_chat_id, c.title
      FROM public.lr_user_channels uc
      JOIN public.channels c ON c.id=uc.channel_id
      WHERE uc.user_id=$1 AND c.id=$2 AND COALESCE(c.is_active, true)=true
      LIMIT 1
    `, [req.linkrayWebUser.user_id, channelId]))[0];
    if (!access) return res.status(403).json({ ok: false, error: 'NO_ACCESS', message: 'Нет доступа к каналу' });
    if (!clean(access.max_chat_id, 120)) {
      return res.status(400).json({ ok: false, error: 'NO_MAX_CHAT', message: 'У канала нет MAX ID' });
    }
    await query(`
      INSERT INTO public.lr_antifraud_channels(
        channel_id, max_chat_id, title, enabled, enabled_at, disabled_at,
        learning_started_at, created_at, updated_at
      )
      VALUES(
        $1,$2,$3,$4,
        CASE WHEN $4 THEN now() ELSE NULL END,
        CASE WHEN $4 THEN NULL ELSE now() END,
        CASE WHEN $4 THEN now() ELSE NULL END,
        now(),now()
      )
      ON CONFLICT(channel_id) DO UPDATE SET
        max_chat_id=EXCLUDED.max_chat_id,
        title=EXCLUDED.title,
        enabled=EXCLUDED.enabled,
        enabled_at=CASE WHEN EXCLUDED.enabled THEN COALESCE(lr_antifraud_channels.enabled_at, now()) ELSE lr_antifraud_channels.enabled_at END,
        disabled_at=CASE WHEN EXCLUDED.enabled THEN NULL ELSE now() END,
        learning_started_at=CASE WHEN EXCLUDED.enabled THEN COALESCE(lr_antifraud_channels.learning_started_at, now()) ELSE lr_antifraud_channels.learning_started_at END,
        updated_at=now()
    `, [channelId, String(access.max_chat_id), clean(access.title || `Канал ${channelId}`, 300), enabled]);
    return res.json({ ok: true, channelId, enabled });
  }));

  app.use('/api/web', router);
  ensureSchema().catch((error) => console.error('[LinkRay Web Cabinet schema]', error?.stack || error?.message || error));
  console.log('[LinkRay Web Cabinet] production-v1 mounted');
}
