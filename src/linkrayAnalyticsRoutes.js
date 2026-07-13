/*
  LINKRAY_ANALYTICS_V4_FINAL
  Финальный мобильный отчёт: пост, просмотры, CPM, каналы, аватарки MAX, сортировки, переход в бота.
*/

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRAND_DIR = path.resolve(__dirname, '../public/brand');
const LOGO_FILE = path.join(BRAND_DIR, 'linkray-logo.webp');
const BOT_LINK = process.env.BOT_LINK || 'https://max.ru/se13353901_bot';

let minuteSyncStarted = false;

function rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function safeJson(value, fallback = {}) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(value) {
  return esc(value).replace(/'/g, '&#39;');
}

function number(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('ru-RU').format(Number.isFinite(n) ? Math.round(n) : 0);
}

function money(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0) + ' ₽';
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|blockquote|h1|h2|h3)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizePostHtml(text, format = '') {
  const raw = String(text || '').trim();
  if (!raw) return 'Текст поста пока недоступен.';

  let html = raw;
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(raw);

  if (String(format || '').toLowerCase() !== 'html' && !looksHtml) {
    html = esc(raw).replace(/\n/g, '<br>');
  }

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<(?!\/?(a|b|strong|i|em|u|s|del|ins|br|p|div|span|blockquote|code|pre)\b)[^>]*>/gi, '')
    .replace(/<a\b([^>]*)>/gi, (_m, attrs) => {
      const href = String(attrs || '').match(/href=["']([^"']+)["']/i)?.[1] || '';
      if (!/^https?:\/\//i.test(href)) return '';
      return '<a href="' + attr(href) + '" target="_blank" rel="noopener">';
    });
}

function ruShortDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).replace('.', '');
  } catch {
    return '—';
  }
}


/* LR_REPORT_STATUS_V65_START */
function ruStatusDate(value) {
  if (!value) return 'Дата и время ещё не назначены.';

  try {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return 'Дата и время ещё не назначены.';
    }

    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);

    const get = (type) =>
      parts.find((part) => part.type === type)?.value || '';

    return `${get('day')} ${get('month')} ${get('year')} в ${get('hour')}:${get('minute')} МСК`;
  } catch {
    return 'Дата и время ещё не назначены.';
  }
}

function autoDeleteText(minutes) {
  const n = Number(minutes || 0);
  if (!Number.isFinite(n) || n <= 0) return 'не задано';
  if (n % 1440 === 0) return String(n / 1440) + ' дн.';
  if (n % 60 === 0) return String(n / 60) + ' ч.';
  return String(n) + ' мин.';
}

/* MAX_AVATAR_PRIORITY_V7 */
function firstUrlDeep(value) {
  let found = '';

  const preferredKeys = [
    'avatar_url', 'avatarUrl',
    'photo_url', 'photoUrl',
    'picture_url', 'pictureUrl',
    'image_url', 'imageUrl',
    'icon_url', 'iconUrl',
    'avatar', 'photo', 'picture', 'image', 'icon',
    'thumbnail_url', 'thumbnailUrl',
    'preview_url', 'previewUrl',
    'url', 'src'
  ];

  const pickString = (v) => {
    const text = String(v || '').trim();
    if (/^https?:\/\//i.test(text)) return text;
    return '';
  };

  const scanPreferred = (item) => {
    if (!item || found) return;
    if (typeof item === 'string') {
      const u = pickString(item);
      if (u) found = u;
      return;
    }
    if (Array.isArray(item)) {
      for (const x of item) scanPreferred(x);
      return;
    }
    if (typeof item === 'object') {
      for (const key of preferredKeys) {
        const u = pickString(item[key]);
        if (u) {
          found = u;
          return;
        }
      }
      for (const key of preferredKeys) {
        const v = item[key];
        if (v && typeof v === 'object') scanPreferred(v);
      }
      for (const v of Object.values(item)) scanPreferred(v);
    }
  };

  scanPreferred(value);
  return found;
}

function getViews(snapshot) {
  const s = snapshot || {};
  const candidates = [
    s.maxViews,
    s.totalViews,
    s.views,
    s.view_count,
    s.views_count,
    s.reads,
    s.impressions,
    s.stat?.views,
    s.stat?.view_count,
    s.stat?.views_count,
    s.maxStat?.views,
    s.maxStat?.view_count,
    s.maxStat?.views_count,
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }

  return 0;
}

async function tableColumns(table) {
  const result = await query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name=$1`,
    [table]
  ).catch(() => []);

  return new Set(rows(result).map((r) => String(r.column_name)));
}

async function ensureAnalyticsTables() {
  await query(`CREATE TABLE IF NOT EXISTS analytics_view_points (
    id bigserial PRIMARY KEY,
    campaign_id text NOT NULL,
    post_id text,
    channel_id text,
    views integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});

  await query(`ALTER TABLE analytics_view_points ADD COLUMN IF NOT EXISTS post_id text`).catch(() => {});
  await query(`ALTER TABLE analytics_view_points ADD COLUMN IF NOT EXISTS channel_id text`).catch(() => {});
  await query(`ALTER TABLE analytics_view_points ADD COLUMN IF NOT EXISTS views integer DEFAULT 0`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_lr_view_points_campaign ON analytics_view_points(campaign_id, created_at)`).catch(() => {});
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS avatar_url text`).catch(() => {});
}

async function trySyncMaxViews(post) {
  if (!post?.published_message_id) return post;

  try {
    const mod = await import('./maxClient.js');
    const fn =
      mod.getMaxMessage ||
      mod.getMessage ||
      mod.getMessageInfo ||
      mod.default?.getMaxMessage ||
      mod.default?.getMessage;

    if (!fn) return post;

    const result = await fn(post.published_message_id, { chatId: post.channel_id || post.chat_id });
    const message = Array.isArray(result?.messages) ? result.messages[0] : (result?.message || result);
    const stat = message?.stat || result?.stat || message?.statistics || result?.statistics || {};

    const views = Number(
      stat.views ??
      stat.view_count ??
      stat.views_count ??
      stat.reads ??
      stat.impressions ??
      message?.views ??
      result?.views
    );

    if (!Number.isFinite(views) || views < 0) return post;

    const snapshot = safeJson(post.report_snapshot, {});
    snapshot.views = Math.round(views);
    snapshot.totalViews = Math.round(views);
    snapshot.maxViews = Math.round(views);
    snapshot.maxStat = stat;
    snapshot.lastMaxSyncAt = new Date().toISOString();

    await query(
      `UPDATE scheduled_posts SET report_snapshot=$2::jsonb WHERE id=$1`,
      [post.id, JSON.stringify(snapshot)]
    ).catch(() => {});

    return { ...post, report_snapshot: snapshot };
  } catch (error) {
    console.error('[linkray analytics max sync]', error.message || error);
    return post;
  }
}


function channelIdentifiers(row) {
  const keys = [
    'id',
    'chat_id',
    'chatId',
    'channel_id',
    'channelId',
    'max_chat_id',
    'maxChatId',
    'max_channel_id',
    'maxChannelId',
    'max_id',
    'maxId',
    'external_id',
    'externalId',
    'peer_id',
    'peerId',
    'username',
    'handle',
    'link'
  ];

  const out = [];

  for (const key of keys) {
    const value = row && row[key];

    if (value === null || value === undefined || value === '') continue;

    const text = String(value).trim();

    if (!text) continue;

    out.push(text);

    if (text.startsWith('@')) out.push(text.slice(1));
    if (text.includes('/')) {
      const last = text.split('/').filter(Boolean).pop();
      if (last) out.push(last);
    }
  }

  return [...new Set(out.filter(Boolean))];
}

function maxChatInfoFunctions(mod) {
  return [
    mod.getMaxChatInfo,
    mod.getChatInfo,
    mod.getMaxChat,
    mod.getChat,
    mod.fetchChat,
    mod.fetchMaxChat,
    mod.default?.getMaxChatInfo,
    mod.default?.getChatInfo,
    mod.default?.getMaxChat,
    mod.default?.getChat,
  ].filter((fn) => typeof fn === 'function');
}

async function callMaxChatInfo(identifier) {
  if (!identifier) return null;

  let mod;

  try {
    mod = await import('./maxClient.js');
  } catch (error) {
    console.error('[linkray analytics maxClient import]', error.message || error);
    return null;
  }

  const functions = maxChatInfoFunctions(mod);

  if (!functions.length) {
    console.error('[linkray analytics avatars] maxClient has no chat info function');
    return null;
  }

  const argsList = [
    [identifier],
    [{ chatId: identifier }],
    [{ chat_id: identifier }],
    [{ id: identifier }],
    [{ channelId: identifier }],
    [{ channel_id: identifier }],
  ];

  for (const fn of functions) {
    for (const args of argsList) {
      try {
        const data = await fn(...args);
        if (data) return data;
      } catch {}
    }
  }

  return null;
}

async function saveChannelAvatar(row, url) {
  if (!url) return;

  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS avatar_url text`).catch(() => {});

  const cols = await tableColumns('channels').catch(() => new Set());
  const ids = channelIdentifiers(row);

  if (!ids.length) return;

  const where = [`id::text = ANY($2)`];

  for (const col of [
    'chat_id',
    'channel_id',
    'max_chat_id',
    'max_channel_id',
    'max_id',
    'external_id',
    'peer_id',
    'username',
    'handle',
    'link',
  ]) {
    if (cols.has(col)) where.push(`"${col}"::text = ANY($2)`);
  }

  await query(
    `UPDATE channels SET avatar_url=$1 WHERE ${where.join(' OR ')}`,
    [url, ids]
  ).catch((error) => {
    console.error('[linkray analytics save avatar]', error.message || error);
  });
}

async function trySyncChannelAvatar(channel) {
  const row = typeof channel === 'object' && channel !== null
    ? channel
    : {
        id: channel,
        chat_id: channel,
        channel_id: channel,
        max_chat_id: channel,
        external_id: channel,
      };

  const identifiers = channelIdentifiers(row);

  for (const identifier of identifiers) {
    const data = await callMaxChatInfo(identifier);
    const url = firstUrlDeep(data);

    if (url) {
      await saveChannelAvatar(row, url);
      return url;
    }
  }

  return '';
}

async function loadChannels(posts) {
  const ids = [
    ...new Set(
      posts
        .map((p) => p.channel_id || p.chat_id || p.channelId || p.chatId)
        .filter((x) => x !== null && x !== undefined && x !== '')
        .map(String)
    )
  ];

  if (!ids.length) return new Map();

  await ensureAnalyticsTables();

  const cols = await tableColumns('channels');

  if (!cols.size || !cols.has('id')) return new Map();

  const q = (col) => `"${col}"::text`;

  const titleExpr = cols.has('title')
    ? q('title')
    : cols.has('name')
      ? q('name')
      : cols.has('channel_title')
        ? q('channel_title')
        : cols.has('chat_title')
          ? q('chat_title')
          : `'Канал'::text`;

  const linkExpr = cols.has('link')
    ? q('link')
    : cols.has('public_link')
      ? q('public_link')
      : cols.has('invite_link')
        ? q('invite_link')
        : cols.has('channel_link')
          ? q('channel_link')
          : cols.has('url')
            ? q('url')
            : cols.has('username')
              ? q('username')
              : cols.has('handle')
                ? q('handle')
                : `''::text`;

  const avatarExpr = cols.has('avatar_url')
    ? q('avatar_url')
    : cols.has('photo_url')
      ? q('photo_url')
      : cols.has('image_url')
        ? q('image_url')
        : cols.has('icon_url')
          ? q('icon_url')
          : cols.has('picture')
            ? q('picture')
            : `''::text`;

  const metaExpr = cols.has('meta')
    ? `"meta"`
    : cols.has('data')
      ? `"data"`
      : cols.has('payload')
        ? `"payload"`
        : cols.has('raw')
          ? `"raw"`
          : `NULL::jsonb`;

  const candidateColumns = [
    'chat_id',
    'channel_id',
    'max_chat_id',
    'max_channel_id',
    'max_id',
    'external_id',
    'peer_id',
    'username',
    'handle',
  ].filter((col) => cols.has(col));

  const candidateSelect = candidateColumns
    .map((col) => `, "${col}"::text AS "${col}"`)
    .join('');

  const whereParts = [`id::text = ANY($1)`];

  for (const col of candidateColumns) {
    whereParts.push(`"${col}"::text = ANY($1)`);
  }

  const result = await query(
    `SELECT id::text AS id,
            ${titleExpr} AS title,
            ${linkExpr} AS link,
            ${avatarExpr} AS avatar,
            ${metaExpr} AS meta
            ${candidateSelect}
       FROM channels
      WHERE ${whereParts.join(' OR ')}`,
    [ids]
  ).catch((error) => {
    console.error('[linkray analytics channels]', error.message || error);
    return [];
  });

  const map = new Map();

  for (const row of rows(result)) {
    const meta = safeJson(row.meta, null);
    let avatar = row.avatar || firstUrlDeep(meta) || '';

    if (!avatar) {
      avatar = await trySyncChannelAvatar(row);
    }

    const item = {
      title: row.title || 'Канал',
      link: row.link || '',
      avatar,
    };

    for (const key of channelIdentifiers(row)) {
      map.set(String(key), item);
    }

    map.set(String(row.id), item);
  }

  for (const id of ids) {
    if (map.has(String(id))) continue;

    const avatar = await trySyncChannelAvatar(id);

    map.set(String(id), {
      title: 'Канал',
      link: '',
      avatar,
    });
  }

  return map;
}


function getMedia(post, draft) {
  const sources = [
    safeJson(post.attachments, post.attachments || []),
    safeJson(draft?.content?.attachments, draft?.content?.attachments || []),
    safeJson(draft?.attachments, draft?.attachments || []),
    safeJson(draft?.media, draft?.media || []),
    safeJson(draft?.content?.media, draft?.content?.media || []),
  ];

  let url = '';
  let type = '';

  const scan = (item) => {
    if (!item || url) return;

    if (typeof item === 'string') {
      if (/^https?:\/\//i.test(item)) url = item;
      return;
    }

    if (Array.isArray(item)) {
      for (const x of item) scan(x);
      return;
    }

    if (typeof item === 'object') {
      type = type || String(item.type || item.kind || item.media_type || '');

      for (const key of [
        'url', 'src', 'previewUrl', 'preview_url', 'thumbnailUrl', 'thumbnail_url',
        'imageUrl', 'image_url', 'videoUrl', 'video_url', 'fileUrl', 'file_url',
      ]) {
        const value = String(item[key] || '');
        if (/^https?:\/\//i.test(value)) {
          url = value;
          return;
        }
      }

      for (const value of Object.values(item)) scan(value);
    }
  };

  for (const source of sources) scan(source);

  if (!url) return null;

  return {
    url,
    kind: /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url) || /video/i.test(type) ? 'video' : 'image',
  };
}

function postTitle(text) {
  const clean = stripHtml(text);
  if (!clean) return 'Рекламный пост';
  return clean.length > 82 ? clean.slice(0, 82) + '…' : clean;
}

function statusInfo(post) {
  const status = String(post?.status || '').trim().toLowerCase();

  const deletedAt =
    post?.auto_deleted_at ||
    post?.deleted_at ||
    post?.removed_at ||
    post?.deletedAt ||
    null;

  const publishedAt =
    post?.published_at ||
    post?.publishedAt ||
    null;

  const publishAt =
    post?.publish_at ||
    post?.publishAt ||
    post?.scheduled_at ||
    post?.scheduledAt ||
    null;

  const isDeleted =
    Boolean(deletedAt) ||
    ['deleted', 'removed', 'canceled', 'cancelled', 'auto_deleted'].includes(status);

  const isPublished =
    Boolean(publishedAt) ||
    ['published', 'sent', 'posted', 'done'].includes(status);

  if (isDeleted) {
    return {
      title: 'Пост удалён',
      text: ruStatusDate(
        deletedAt ||
        post?.updated_at ||
        publishedAt ||
        publishAt ||
        post?.created_at
      ),
      good: false,
    };
  }

  if (isPublished) {
    return {
      title: 'Пост опубликован',
      text: ruStatusDate(
        publishedAt ||
        publishAt ||
        post?.updated_at ||
        post?.created_at
      ),
      good: true,
    };
  }

  return {
    title: 'Пост выйдет',
    text: ruStatusDate(
      publishAt ||
      post?.created_at ||
      null
    ),
    good: false,
  };
}

function livedHours(post) {
  const startRaw = post?.published_at || post?.publish_at || post?.created_at;
  const start = startRaw ? new Date(startRaw).getTime() : Date.now();

  const explicitEnd = post?.auto_deleted_at || post?.deleted_at || post?.removed_at;
  let end = explicitEnd ? new Date(explicitEnd).getTime() : Date.now();

  const autoMinutes = Number(post?.auto_delete_minutes || 0);
  if (autoMinutes > 0 && Number.isFinite(start)) {
    end = Math.min(end, start + autoMinutes * 60000);
  }

  const hours = Math.floor(Math.max(0, end - start) / 3600000);
  return Math.max(24, hours || 24);
}

function availableRanges(hours) {
  if (hours >= 72) return [24, 48, 72];
  if (hours >= 48) return [24, 48];
  return [24];
}

async function savePoint(campaignId, postId, channelId, views) {
  await ensureAnalyticsTables();

  const key = String(campaignId || postId || 'unknown');
  const v = Math.max(0, Math.round(Number(views || 0)));

  const last = rows(await query(
    `SELECT views, created_at
       FROM analytics_view_points
      WHERE campaign_id=$1
      ORDER BY created_at DESC
      LIMIT 1`,
    [key]
  ).catch(() => []))[0];

  const lastMs = last?.created_at ? new Date(last.created_at).getTime() : 0;

  if (!last || Number(last.views) !== v || Date.now() - lastMs >= 55000) {
    await query(
      `INSERT INTO analytics_view_points(campaign_id, post_id, channel_id, views)
       VALUES($1,$2,$3,$4)`,
      [key, String(postId || ''), String(channelId || ''), v]
    ).catch(() => {});
  }
}

async function timelineFor(campaignId, rangeHours, totalViews, firstPost) {
  await ensureAnalyticsTables();

  const key = String(campaignId || firstPost?.id || 'unknown');
  const startRaw = firstPost?.published_at || firstPost?.publish_at || firstPost?.created_at;
  const start = startRaw ? new Date(startRaw) : new Date(Date.now() - rangeHours * 3600000);
  const end = new Date(start.getTime() + rangeHours * 3600000);

  const points = rows(await query(
    `SELECT views, created_at
       FROM analytics_view_points
      WHERE campaign_id=$1
        AND created_at >= $2
        AND created_at <= $3
      ORDER BY created_at ASC`,
    [key, start.toISOString(), end.toISOString()]
  ).catch(() => []))
    .map((p) => ({
      views: Math.max(0, Math.round(Number(p.views || 0))),
      ts: new Date(p.created_at).getTime(),
    }))
    .filter((p) => Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);

  const labels = rangeHours === 24
    ? [1, 3, 6, 9, 12, 18, 24]
    : rangeHours === 48
      ? [1, 6, 12, 18, 24, 36, 48]
      : [1, 6, 12, 24, 36, 48, 60, 72];

  const total = Math.max(0, Math.round(Number(totalViews || 0)));
  const nowTs = Date.now();
  const currentTs = Math.min(nowTs, end.getTime());

  let lastKnown = 0;

  return labels.map((hour, index) => {
    const target = start.getTime() + hour * 3600000;
    const before = points.filter((p) => p.ts <= target).pop();

    let views = lastKnown;

    if (before) {
      views = Math.max(lastKnown, before.views);
    }

    // Без фейкового роста: до первой реальной точки показываем 0.
    // На последней точке всегда показываем текущий итог.
    if (target >= currentTs || index === labels.length - 1) {
      views = Math.max(views, total);
    }

    lastKnown = Math.max(lastKnown, views);

    return [hour + 'ч', Math.max(0, Math.round(views))];
  });
}


/* LR_REAL_MAX_VIEWS_V64_START
   Реальные просмотры рекламных постов:
   - GET /messages/{messageId} через platform-api2.max.ru;
   - отдельные минутные точки по каналам и общий итог;
   - график строится только из фактически полученных значений;
   - старые смешанные точки помечаются legacy и в новый график не попадают.
*/
let lrV64NoTokenLogged = false;

function lrV64ApiBase() {
  return String(
    process.env.MAX_API_URL ||
    process.env.MAX_BASE_URL ||
    process.env.MAX_PLATFORM_API ||
    'https://platform-api2.max.ru'
  )
    .replace('://platform-api.max.ru', '://platform-api2.max.ru')
    .replace(/\/+$/, '');
}

function lrV64Token() {
  return String(
    process.env.BOT_TOKEN ||
    process.env.MAX_BOT_TOKEN ||
    process.env.MAX_TOKEN ||
    process.env.MAX_ACCESS_TOKEN ||
    process.env.ACCESS_TOKEN ||
    ''
  ).trim();
}

function lrV64MessageId(value) {
  if (value === null || value === undefined) return '';

  if (typeof value === 'object') {
    for (const key of [
      'mid',
      'message_id',
      'messageId',
      'published_message_id',
      'publishedMessageId',
      'id'
    ]) {
      const found = lrV64MessageId(value[key]);
      if (found) return found;
    }
    for (const nested of Object.values(value)) {
      const found = lrV64MessageId(nested);
      if (found) return found;
    }
    return '';
  }

  let text = String(value).trim();
  if (!text || text === '[object Object]') return '';

  if ((text.startsWith('{') && text.endsWith('}')) ||
      (text.startsWith('[') && text.endsWith(']'))) {
    try {
      return lrV64MessageId(JSON.parse(text));
    } catch {}
  }

  try {
    const u = new URL(text);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    if (/^[a-zA-Z0-9_-]+$/.test(last)) return last;
  } catch {}

  const labelled = text.match(
    /(?:mid|message[_-]?id|published[_-]?message[_-]?id)\s*["'=:\s]+\s*([a-zA-Z0-9_-]+)/i
  );
  if (labelled?.[1]) return labelled[1];

  if (/^[a-zA-Z0-9_-]+$/.test(text)) return text;
  return '';
}

function lrV64ViewsFromMessage(message) {
  const roots = [
    message?.stat,
    message?.statistics,
    message?.message?.stat,
    message?.message?.statistics,
    Array.isArray(message?.messages) ? message.messages[0]?.stat : null,
    Array.isArray(message?.messages) ? message.messages[0]?.statistics : null
  ].filter(Boolean);

  const keys = [
    'views',
    'view_count',
    'views_count',
    'viewCount',
    'viewsCount',
    'reach',
    'reach_count',
    'reachCount',
    'impressions',
    'reads'
  ];

  for (const root of roots) {
    for (const key of keys) {
      const n = Number(root?.[key]);
      if (Number.isFinite(n) && n >= 0) return Math.round(n);
    }
  }

  return null;
}

async function lrV64FetchMaxMessage(mid) {
  const token = lrV64Token();
  if (!token) {
    if (!lrV64NoTokenLogged) {
      lrV64NoTokenLogged = true;
      console.error('[v64 real views] BOT_TOKEN/MAX_TOKEN not found');
    }
    return null;
  }

  const base = lrV64ApiBase();
  const urls = [
    `${base}/messages/${encodeURIComponent(mid)}`,
    `${base}/messages?message_ids=${encodeURIComponent(mid)}`
  ];

  let lastError = '';
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: token }
      });
      const raw = await response.text();
      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = { raw };
      }

      if (!response.ok || data?.success === false) {
        lastError = `HTTP ${response.status}: ${raw.slice(0, 500)}`;
        continue;
      }

      if (Array.isArray(data?.messages)) {
        return data.messages.find((item) =>
          lrV64MessageId(item) === mid ||
          lrV64MessageId(item?.body) === mid
        ) || data.messages[0] || data;
      }

      return data?.message || data;
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  throw new Error(lastError || 'MAX message request failed');
}

async function lrV64EnsureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS analytics_view_points (
      id bigserial PRIMARY KEY,
      campaign_id text NOT NULL,
      post_id text,
      channel_id text,
      views integer NOT NULL DEFAULT 0,
      point_kind text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`
    ALTER TABLE analytics_view_points
    ADD COLUMN IF NOT EXISTS point_kind text
  `).catch(() => {});

  await query(`
    UPDATE analytics_view_points
    SET point_kind='legacy'
    WHERE point_kind IS NULL
  `).catch(() => {});

  await query(`
    ALTER TABLE analytics_view_points
    ALTER COLUMN point_kind SET DEFAULT 'total'
  `).catch(() => {});

  await query(`
    CREATE INDEX IF NOT EXISTS idx_lr_view_points_real
    ON analytics_view_points(campaign_id, point_kind, channel_id, created_at)
  `).catch(() => {});
}

async function lrV64SyncMaxViews(post) {
  const mid = lrV64MessageId(
    post?.published_message_id ||
    post?.max_message_id ||
    post?.message_id ||
    post?.publishedMessageId
  );

  if (!mid) {
    console.error('[v64 real views] message id not found', JSON.stringify({
      postId: post?.id || null,
      published_message_id: post?.published_message_id || null
    }));
    return post;
  }

  try {
    const message = await lrV64FetchMaxMessage(mid);
    const views = lrV64ViewsFromMessage(message);

    if (!Number.isFinite(views) || views < 0) {
      console.error('[v64 real views] stat.views not found', JSON.stringify({
        postId: post?.id || null,
        mid,
        stat: message?.stat || message?.statistics || null
      }));
      return post;
    }

    const snapshot = safeJson(post?.report_snapshot, {});
    snapshot.views = views;
    snapshot.totalViews = views;
    snapshot.maxViews = views;
    snapshot.maxStat = message?.stat || message?.statistics || {};
    snapshot.lastMaxSyncAt = new Date().toISOString();
    snapshot.lastViewSource = 'MAX GET /messages/{messageId}';

    await query(
      `UPDATE scheduled_posts
       SET report_snapshot=$2::jsonb
       WHERE id=$1`,
      [post.id, JSON.stringify(snapshot)]
    );

    console.log('[v64 real views] synced', JSON.stringify({
      postId: post.id,
      mid,
      channelId: post.channel_id || null,
      views
    }));

    return { ...post, report_snapshot: snapshot };
  } catch (error) {
    console.error('[v64 real views] MAX sync failed', JSON.stringify({
      postId: post?.id || null,
      mid,
      error: error?.message || String(error)
    }));
    return post;
  }
}

async function lrV64SavePoint(
  campaignId,
  postId,
  channelId,
  views,
  pointKind = 'total'
) {
  await lrV64EnsureTables();

  const campaign = String(campaignId || postId || 'unknown');
  const post = String(postId || '');
  const channel = String(channelId || '');
  const kind = String(pointKind || 'total');
  const value = Math.max(0, Math.round(Number(views || 0)));

  const last = rows(await query(
    `SELECT views, created_at
     FROM analytics_view_points
     WHERE campaign_id=$1
       AND point_kind=$2
       AND COALESCE(channel_id, '')=$3
     ORDER BY created_at DESC
     LIMIT 1`,
    [campaign, kind, channel]
  ).catch(() => []))[0];

  const lastMs = last?.created_at
    ? new Date(last.created_at).getTime()
    : 0;

  if (
    !last ||
    Number(last.views) !== value ||
    Date.now() - lastMs >= 55000
  ) {
    await query(
      `INSERT INTO analytics_view_points
       (campaign_id, post_id, channel_id, views, point_kind)
       VALUES($1,$2,$3,$4,$5)`,
      [campaign, post, channel, value, kind]
    );
  }
}

function lrV64PointLabel(startMs, ts) {
  const minutes = Math.max(0, Math.round((ts - startMs) / 60000));
  if (minutes === 0) return '0м';
  if (minutes < 60) return `${minutes}м`;

  const hours = minutes / 60;
  if (Math.abs(hours - Math.round(hours)) < 0.01) {
    return `${Math.round(hours)}ч`;
  }
  return `${hours.toFixed(1).replace('.', ',')}ч`;
}

async function lrV64TimelineFor(
  campaignId,
  rangeHours,
  totalViews,
  firstPost
) {
  await lrV64EnsureTables();

  const campaign = String(campaignId || firstPost?.id || 'unknown');
  const startRaw =
    firstPost?.published_at ||
    firstPost?.publish_at ||
    firstPost?.created_at;

  const startMs = startRaw
    ? new Date(startRaw).getTime()
    : Date.now();

  const rangeEndMs = startMs + Number(rangeHours || 24) * 3600000;
  const currentMs = Math.min(Date.now(), rangeEndMs);

  const rawPoints = rows(await query(
    `SELECT views, created_at
     FROM analytics_view_points
     WHERE campaign_id=$1
       AND point_kind='total'
       AND created_at >= $2
       AND created_at <= $3
     ORDER BY created_at ASC`,
    [
      campaign,
      new Date(startMs).toISOString(),
      new Date(rangeEndMs).toISOString()
    ]
  ).catch(() => []));

  const points = rawPoints
    .map((item) => ({
      ts: new Date(item.created_at).getTime(),
      views: Math.max(0, Math.round(Number(item.views || 0)))
    }))
    .filter((item) =>
      Number.isFinite(item.ts) &&
      item.ts >= startMs &&
      item.ts <= currentMs
    )
    .sort((a, b) => a.ts - b.ts);

  const measured = [{ ts: startMs, views: 0 }];

  for (const point of points) {
    const prev = measured[measured.length - 1];
    const value = Math.max(prev?.views || 0, point.views);
    if (prev && Math.abs(point.ts - prev.ts) < 30000) {
      prev.views = Math.max(prev.views, value);
    } else {
      measured.push({ ts: point.ts, views: value });
    }
  }

  const currentTotal = Math.max(
    measured[measured.length - 1]?.views || 0,
    Math.round(Number(totalViews || 0))
  );

  if (currentMs >= startMs) {
    const last = measured[measured.length - 1];
    if (!last || Math.abs(currentMs - last.ts) >= 30000) {
      measured.push({ ts: currentMs, views: currentTotal });
    } else {
      last.views = Math.max(last.views, currentTotal);
    }
  }

  const MAX_POINTS = 20;
  let selected = measured;

  if (measured.length > MAX_POINTS) {
    const picked = [measured[0]];
    const step = (measured.length - 1) / (MAX_POINTS - 1);
    for (let i = 1; i < MAX_POINTS - 1; i += 1) {
      picked.push(measured[Math.round(i * step)]);
    }
    picked.push(measured[measured.length - 1]);

    const seen = new Set();
    selected = picked.filter((point) => {
      const key = `${point.ts}:${point.views}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return selected.map((point, index) => {
    const label = index === selected.length - 1 && point.ts === currentMs
      ? 'Сейчас'
      : lrV64PointLabel(startMs, point.ts);
    return [label, point.views];
  });
}

async function lrV64SyncPublishedViews() {
  try {
    await lrV64EnsureTables();

    const posts = rows(await query(
      `SELECT *
       FROM scheduled_posts
       WHERE published_message_id IS NOT NULL
         AND (status='published' OR published_at IS NOT NULL)
         AND COALESCE(published_at, publish_at, created_at)
             >= now() - interval '8 days'
         AND COALESCE(status::text, '') NOT IN
             ('deleted','canceled','cancelled')
       ORDER BY COALESCE(published_at, publish_at, created_at) DESC
       LIMIT 150`
    ).catch(() => []));

    const campaigns = new Map();

    for (const post of posts) {
      const draft = safeJson(post?.draft, {});
      const campaignId = String(
        post?.report_group_id ||
        draft?.campaignId ||
        post?.id
      );

      if (!campaigns.has(campaignId)) {
        campaigns.set(campaignId, []);
      }
      campaigns.get(campaignId).push(post);
    }

    for (const [campaignId, campaignPosts] of campaigns.entries()) {
      let total = 0;
      let firstPostId = campaignPosts[0]?.id || '';

      for (const post of campaignPosts) {
        const updated = await lrV64SyncMaxViews(post);
        const views = getViews(safeJson(updated?.report_snapshot, {}));
        total += Math.max(0, Number(views || 0));

        await lrV64SavePoint(
          campaignId,
          updated?.id || post.id,
          updated?.channel_id || post.channel_id || '',
          views,
          'channel'
        );

        if (typeof trySyncChannelAvatar === 'function') {
          await trySyncChannelAvatar(
            updated?.channel_id || post.channel_id
          ).catch(() => {});
        }
      }

      await lrV64SavePoint(
        campaignId,
        firstPostId,
        '__total__',
        total,
        'total'
      );
    }

    console.log('[v64 real views] minute sweep done', JSON.stringify({
      posts: posts.length,
      campaigns: campaigns.size
    }));
  } catch (error) {
    console.error(
      '[v64 real views] minute sweep failed',
      error?.stack || error?.message || error
    );
  }
}
/* LR_REAL_MAX_VIEWS_V64_END */

function fallbackData(id) {
  return {
    id,
    botLink: BOT_LINK,
    reportLink: '/analytics/stats/' + encodeURIComponent(id || ''),
    title: 'Отчёт по рекламному посту',
    postTitle: 'Рекламный пост',
    postHtml: 'Данные публикации ещё загружаются.',
    media: null,
    status: {
      title: 'Пост выйдет',
      text: 'Дата и время ещё не назначены.',
      good: false,
    },
    publishedAt: null,
    autoDeleteText: 'не задано',
    metrics: {
      views: 0,
      cpm: 0,
      cost: 0,
      channelsCount: 0,
      lifeHours: 24,
    },
    ranges: {
      '24': [
        ['1ч', 0],
        ['3ч', 0],
        ['6ч', 0],
        ['9ч', 0],
        ['12ч', 0],
        ['18ч', 0],
        ['24ч', 0],
      ],
    },
    channels: [],
  };
}

async function trackerFallbackData(id) {
  const base = fallbackData(id);

  try {
    const tracker = rows(await query(
      `SELECT *
       FROM ad_post_trackers
       WHERE id::text = $1
          OR COALESCE(token, '') = $1
          OR COALESCE(post_id, '') = $1
          OR COALESCE(schedule_ref, '') = $1
       ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
       LIMIT 1`,
      [String(id || '')]
    ).catch((error) => {
      console.error('[v66 report status] tracker query failed', error?.message || error);
      return [];
    }))[0];

    if (!tracker) return base;

    const token = String(tracker.token || id || '');
    const draft = safeJson(tracker.draft_json, {});

    const trackerChannels = rows(await query(
      `SELECT *
       FROM ad_post_tracker_channels
       WHERE COALESCE(token, '') = $1
       ORDER BY created_at ASC NULLS LAST`,
      [token]
    ).catch((error) => {
      console.error('[v66 report status] tracker channels query failed', error?.message || error);
      return [];
    }));

    let channelIds = safeJson(tracker.channel_ids, []);
    if (!Array.isArray(channelIds)) {
      if (channelIds && typeof channelIds === 'object') {
        channelIds = Object.values(channelIds).filter(Boolean);
      } else if (channelIds) {
        channelIds = [channelIds];
      } else {
        channelIds = [];
      }
    }

    const rawChannels = trackerChannels.length
      ? trackerChannels
      : channelIds.map((channelId) => ({
          channel_id: channelId,
          channel_title: 'Канал',
          views: 0,
          published_at: tracker.published_at,
          deleted_at: tracker.deleted_at,
          status: tracker.status,
        }));

    const cpm = Math.max(0, Number(tracker.cpm || draft?.cpm || 0));

    const channels = rawChannels.map((channel, index) => {
      const views = Math.max(0, Number(channel.views || 0));
      const title = String(channel.channel_title || channel.title || 'Канал');

      return {
        id: channel.channel_id || index + 1,
        title,
        link: channel.message_url || '',
        avatar: '',
        letter: title.trim().slice(0, 1).toUpperCase() || 'К',
        time: ruShortDate(
          channel.published_at ||
          tracker.published_at ||
          tracker.publish_at
        ),
        views,
        cost: (views * cpm) / 1000,
        share: 0,
        originalIndex: index,
      };
    });

    const trackerViews = Math.max(0, Number(tracker.views || 0));
    const summedViews = channels.reduce(
      (sum, channel) => sum + Math.max(0, Number(channel.views || 0)),
      0
    );
    const totalViews = Math.max(trackerViews, summedViews);

    const channelsFinal = channels.map((channel) => ({
      ...channel,
      share: totalViews
        ? Math.round((Number(channel.views || 0) / totalViews) * 100)
        : 0,
    }));

    const text =
      tracker.post_text ||
      trackerChannels[0]?.post_text ||
      draft?.content?.text ||
      draft?.text ||
      draft?.caption ||
      '';

    const image =
      tracker.post_image_url ||
      trackerChannels[0]?.post_image_url ||
      draft?.post_image_url ||
      draft?.image_url ||
      draft?.imageUrl ||
      '';

    const autoDeleteMinutes = Number(
      tracker.auto_delete_minutes ??
      draft?.autoDeleteMinutes ??
      draft?.auto_delete_minutes ??
      draft?.deleteAfterMinutes ??
      0
    );

    const syntheticPost = {
      id: tracker.id,
      status: tracker.status,
      publish_at: tracker.publish_at,
      published_at:
        tracker.published_at ||
        trackerChannels.find((row) => row.published_at)?.published_at ||
        null,
      deleted_at:
        tracker.deleted_at ||
        trackerChannels.find((row) => row.deleted_at)?.deleted_at ||
        null,
      created_at: tracker.created_at,
      updated_at: tracker.updated_at,
      auto_delete_minutes: autoDeleteMinutes,
    };

    const lifeHours = livedHours(syntheticPost);
    const ranges = {};

    for (const range of availableRanges(lifeHours)) {
      ranges[String(range)] = await timelineFor(
        token || tracker.id || id,
        range,
        totalViews,
        syntheticPost
      );
    }

    console.log('[v66 report status] tracker fallback used', JSON.stringify({
      id,
      trackerId: tracker.id || null,
      token: tracker.token || null,
      status: syntheticPost.status || null,
      publishAt: syntheticPost.publish_at || null,
      publishedAt: syntheticPost.published_at || null,
      deletedAt: syntheticPost.deleted_at || null,
      channels: channelsFinal.length,
    }));

    return {
      ...base,
      postTitle: postTitle(text),
      postHtml: sanitizePostHtml(text, 'html'),
      media: image ? { url: image, kind: 'image' } : null,
      status: statusInfo(syntheticPost),
      publishedAt:
        syntheticPost.deleted_at ||
        syntheticPost.published_at ||
        syntheticPost.publish_at ||
        syntheticPost.created_at ||
        null,
      autoDeleteText: autoDeleteText(autoDeleteMinutes),
      metrics: {
        views: totalViews,
        cpm,
        cost: (totalViews * cpm) / 1000,
        channelsCount: channelsFinal.length || channelIds.length,
        lifeHours,
      },
      ranges,
      channels: channelsFinal,
    };
  } catch (error) {
    console.error(
      '[v66 report status] fallback failed',
      error?.stack || error?.message || error
    );
    return base;
  }
}

async function collect(groupId) {
  await ensureAnalyticsTables();

  const id = String(groupId || '').trim();

  let posts = rows(await query(
    `SELECT *
       FROM scheduled_posts
      WHERE id::text = $1
         OR COALESCE(report_group_id, '') = $1
         OR COALESCE(draft->>'campaignId', '') = $1
      ORDER BY id ASC`,
    [id]
  ));

  if (!posts.length) return await trackerFallbackData(id);

  posts = await Promise.all(posts.map(lrV64SyncMaxViews));

  const first = posts[0] || {};
  const draft = safeJson(first.draft, {});
  const campaignId = first.report_group_id || draft.campaignId || first.id || id;

  const channelMap = await loadChannels(posts);

  const text =
    first.text ||
    draft?.content?.text ||
    draft?.text ||
    draft?.caption ||
    '';

  const format =
    first.format ||
    draft?.content?.format ||
    draft?.format ||
    'html';

  const cpm = Number(first.cpm || safeJson(first.report_snapshot, {}).cpm || draft.cpm || 0);

  const channels = posts.map((post, idx) => {
    const snapshot = safeJson(post.report_snapshot, {});
    const views = getViews(snapshot);
    const ch = channelMap.get(String(post.channel_id)) || {};
    const cost = (views * cpm) / 1000;

    return {
      id: post.channel_id || post.id || idx + 1,
      title: ch.title || 'Канал',
      link: ch.link || '',
      avatar: ch.avatar || '',
      letter: String(ch.title || 'К').trim().slice(0, 1).toUpperCase(),
      time: ruShortDate(post.published_at || post.publish_at),
      views,
      cost,
      originalIndex: idx,
    };
  });

  const totalViews = channels.reduce((sum, c) => sum + Number(c.views || 0), 0) || getViews(safeJson(first.report_snapshot, {}));
  const cost = (totalViews * cpm) / 1000;

  const channelsFinal = channels.map((ch) => {
    const share = totalViews ? Math.round((ch.views / totalViews) * 100) : 0;
    return {
      ...ch,
      share,
    };
  });

  await lrV64SavePoint(campaignId, first.id, '__total__', totalViews, 'total');

  const lifeHours = livedHours(first);
  const ranges = {};

  for (const r of availableRanges(lifeHours)) {
    ranges[String(r)] = await lrV64TimelineFor(campaignId, r, totalViews, first);
  }

  return {
    id,
    botLink: BOT_LINK,
    reportLink: '/analytics/stats/' + encodeURIComponent(id),
    title: 'Отчёт по рекламному посту',
    postTitle: postTitle(text),
    postHtml: sanitizePostHtml(text, format),
    media: getMedia(first, draft),
    status: statusInfo(first),
    publishedAt: first.published_at || first.publish_at || first.created_at,
    autoDeleteText: autoDeleteText(first.auto_delete_minutes),
    metrics: {
      views: totalViews,
      cpm,
      cost,
      channelsCount: channelsFinal.length,
      lifeHours,
    },
    ranges,
    channels: channelsFinal,
  };
}

function mediaHtml(data) {
  if (data.media?.url && data.media.kind === 'video') {
    return '<video controls preload="metadata" src="' + attr(data.media.url) + '"></video>';
  }

  if (data.media?.url) {
    return '<img src="' + attr(data.media.url) + '" alt="Медиа поста">';
  }

  return '<img src="/brand/linkray-logo.webp?v=4" alt="">';
}

function page(data) {
  const state = JSON.stringify(data).replace(/</g, '\\u003c');
  const statusClass = data.status?.good ? 'card good' : 'card blue';
  const published = ruShortDate(data.publishedAt);
  const botLink = attr(data.botLink || BOT_LINK);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<meta name="theme-color" content="#061625">
<link rel="icon" type="image/webp" href="/brand/linkray-logo.webp?v=4">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.webp?v=4">
<meta property="og:title" content="LinkRay Analytics">
<meta property="og:image" content="/brand/linkray-logo.webp?v=4">
<title>LinkRay Analytics</title>
<style>
:root{--dark:#061625;--dark2:#0b2337;--ink:#071527;--muted:#63748a;--soft:#f4f8fc;--card:#ffffff;--line:rgba(15,23,42,.10);--green:#39e79c;--cyan:#24d9ff;--blue:#377dff;--shadow:0 18px 46px rgba(6,22,37,.13);--deep:0 28px 80px rgba(4,17,31,.30);--safe-top:env(safe-area-inset-top);--safe-bottom:env(safe-area-inset-bottom)}
*{box-sizing:border-box;min-width:0;-webkit-tap-highlight-color:transparent}html,body{margin:0;width:100%;min-height:100%;overflow-x:hidden}
body{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:radial-gradient(circle at 4% -10%,rgba(36,217,255,.34),transparent 280px),radial-gradient(circle at 105% 0%,rgba(57,231,156,.30),transparent 310px),linear-gradient(180deg,#061625 0,#0b2337 310px,#f5f9fd 311px,#fbfdff 100%)}
button,a{font:inherit}button{border:0;cursor:pointer}a{color:inherit;text-decoration:none}.app{width:100%;max-width:540px;margin:0 auto;padding:calc(10px + var(--safe-top)) 10px calc(104px + var(--safe-bottom))}
.topbar{position:sticky;top:0;z-index:40;margin:calc(-10px - var(--safe-top)) -10px 10px;padding:calc(10px + var(--safe-top)) 10px 10px;display:flex;align-items:center;gap:10px;background:rgba(6,22,37,.88);border-bottom:1px solid rgba(255,255,255,.08);backdrop-filter:blur(18px)}
.brand{display:flex;align-items:center;gap:10px;color:#fff;min-width:0;flex:1}.brand-logo{width:48px;height:48px;border-radius:18px;overflow:hidden;flex:0 0 auto;background:#071827;border:1px solid rgba(255,255,255,.18);box-shadow:0 14px 34px rgba(36,217,255,.22)}.brand-logo img{width:100%;height:100%;object-fit:cover;display:block}
.brand b{display:block;font-size:17px;line-height:1.05;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.035em}.brand span{display:block;margin-top:4px;color:rgba(255,255,255,.72);font-size:12px;font-weight:760}
.top-actions{display:flex;gap:8px}.icon-btn{width:46px;height:46px;border-radius:18px;display:grid;place-items:center;color:#fff;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.12);font-size:20px;font-weight:1000}.icon-btn.primary{color:#061525;background:linear-gradient(135deg,var(--green),var(--cyan));border:0}
.hero{position:relative;overflow:hidden;border-radius:34px;padding:16px;color:#fff;background:radial-gradient(circle at 88% 8%,rgba(112,255,151,.24),transparent 245px),radial-gradient(circle at 6% 90%,rgba(55,125,255,.30),transparent 235px),linear-gradient(135deg,#071827 0%,#0d2e48 55%,#12826d 100%);border:1px solid rgba(255,255,255,.16);box-shadow:var(--deep)}
.hero:before{content:"";position:absolute;inset:-80px -130px auto auto;width:280px;height:280px;border-radius:50%;background:radial-gradient(circle,rgba(57,231,156,.24),transparent 66%)}.hero-inner{position:relative;z-index:2}.status-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:8px;padding:8px 11px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.18);font-size:12px;font-weight:950;white-space:nowrap}.pill i{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 0 7px rgba(57,231,156,.14)}.pill.dim{color:rgba(255,255,255,.84);background:rgba(255,255,255,.08)}
h1{margin:16px 0 9px;font-size:clamp(34px,10.2vw,50px);line-height:.92;letter-spacing:-.07em}.lead{margin:0;color:rgba(255,255,255,.84);font-size:14px;line-height:1.44;font-weight:780}
.logo-stage{margin-top:16px;border-radius:30px;overflow:hidden;min-height:202px;background:linear-gradient(135deg,rgba(36,217,255,.13),rgba(57,231,156,.18));border:1px solid rgba(255,255,255,.14);display:grid;place-items:center}.logo-stage img{width:100%;height:100%;object-fit:cover;display:block}
.hero-metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.hero-metric{padding:14px;border-radius:22px;background:rgba(255,255,255,.17);border:1px solid rgba(255,255,255,.20);backdrop-filter:blur(8px)}.hero-metric span{display:block;color:rgba(255,255,255,.82);font-size:12px;font-weight:950}.hero-metric b{display:block;margin-top:8px;color:#fff;font-size:26px;line-height:1;font-weight:1000;letter-spacing:-.045em;white-space:nowrap}
.hero-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.btn{min-height:50px;border-radius:20px;padding:11px 12px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;font-weight:1000;text-align:center;white-space:nowrap}.btn.main{grid-column:1/-1;color:#061525;background:linear-gradient(135deg,var(--green),var(--cyan));box-shadow:0 16px 34px rgba(36,217,255,.25)}.btn.ghost{color:#fff;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.18)}.btn.bot{color:#061525;background:#fff;box-shadow:0 14px 32px rgba(255,255,255,.13)}
.overview{display:grid;gap:10px;margin-top:12px}.card,.panel{background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow)}.card{border-radius:25px;padding:15px}.card.good{background:linear-gradient(135deg,rgba(57,231,156,.16),#fff)}.card.blue{background:linear-gradient(135deg,rgba(36,217,255,.13),#fff)}
.label{display:block;color:var(--muted);font-size:12px;font-weight:950}.value{margin-top:7px;font-size:28px;line-height:1;font-weight:1000;letter-spacing:-.045em}.note{margin-top:8px;color:var(--muted);font-size:13px;line-height:1.35;font-weight:760}.audit-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.audit{padding:12px;border-radius:19px;background:#f8fbff;border:1px solid #e4eef9}.audit b{display:block;font-size:21px;line-height:1}.audit span{display:block;margin-top:5px;color:var(--muted);font-size:11px;font-weight:850}
.panel{margin-top:12px;border-radius:29px;overflow:hidden}.panel-head{padding:16px 14px 0}.panel-title{display:flex;align-items:center;justify-content:space-between;gap:10px}h2{margin:0;font-size:23px;line-height:1.05;letter-spacing:-.04em}.sub{margin:7px 0 0;color:var(--muted);font-size:13px;line-height:1.42;font-weight:750}.tiny-link{padding:8px 10px;border-radius:999px;background:#edf6ff;color:#173551;font-size:11px;font-weight:950;white-space:nowrap}
.post-wrap{display:grid;gap:12px;padding:14px}.media{min-height:190px;border-radius:24px;overflow:hidden;display:grid;place-items:center;position:relative;background:linear-gradient(135deg,rgba(36,217,255,.18),rgba(57,231,156,.12));border:1px solid #e2edf8}.media img,.media video{width:100%;height:100%;max-height:380px;object-fit:cover;display:block}.media:after{content:"POST";position:absolute;left:12px;bottom:12px;padding:7px 10px;border-radius:999px;color:#fff;background:rgba(7,24,39,.60);font-size:10px;font-weight:1000;letter-spacing:.14em}.post-text{padding:15px;border-radius:24px;background:#f8fbff;border:1px solid #e6eef8}.post-text h3{margin:0 0 8px;font-size:20px;line-height:1.13;letter-spacing:-.03em}.post-body{margin:0;color:#42526a;font-size:14px;line-height:1.47;font-weight:720}.badges{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.badge{padding:8px 10px;border-radius:999px;background:#fff;border:1px solid #e1ebf6;color:#506176;font-size:11.5px;font-weight:950}
.segmented{display:flex;gap:4px;margin-top:12px;padding:4px;border-radius:999px;background:#eaf4ff;border:1px solid #dcebf9;overflow:auto}.segmented button{flex:1 0 auto;min-height:38px;padding:8px 12px;border-radius:999px;background:transparent;color:#607086;font-size:12px;font-weight:1000}.segmented button.active{background:#fff!important;color:var(--ink)!important;box-shadow:0 9px 22px rgba(15,23,42,.10), inset 0 0 0 2px rgba(36,217,255,.18)!important}
.chart-pad{padding:14px}.chart-card{position:relative;border-radius:24px;background:linear-gradient(180deg,#fbfdff,#f2f8ff);border:1px solid #e4effa;padding:8px;overflow:hidden;touch-action:none}svg.chart{display:block;width:100%;height:auto}.axis{stroke:#dce7f4;stroke-width:1}.line{fill:none;stroke:url(#lineGrad);stroke-width:7;stroke-linecap:round;stroke-linejoin:round}.area{fill:url(#areaGrad)}.dot-main{fill:#fff;stroke:#22d7ff;stroke-width:5}.chart-label{fill:#6b7b92;font-size:13px;font-weight:850}.chart-value{fill:#071827;font-size:13px;font-weight:1000}.hover-line{stroke:rgba(13,24,40,.28);stroke-width:2;stroke-dasharray:5 5}.hover-dot{fill:#061525;stroke:#fff;stroke-width:4}.tooltip{position:absolute;min-width:140px;padding:10px;border-radius:16px;background:rgba(8,22,38,.94);color:#fff;box-shadow:0 16px 36px rgba(5,18,35,.25);transform:translate(-50%,-100%);pointer-events:none;opacity:0;transition:opacity .12s ease;font-size:11.5px;z-index:5}.tooltip.show{opacity:1}.tooltip b{display:block;font-size:13px;margin-bottom:5px}.tooltip span{display:block;color:rgba(255,255,255,.78);font-weight:750}
.channels{display:grid;gap:10px;padding:14px}.channel{width:100%;padding:13px;border-radius:24px;background:#fbfdff;border:1px solid #e4edf8;text-align:left;display:grid;gap:11px}.channel-top{display:flex;gap:10px;align-items:center}.avatar-wrap{position:relative;width:44px;height:44px;flex:0 0 auto}.avatar{width:44px;height:44px;border-radius:16px;overflow:hidden;display:grid;place-items:center;font-weight:1000;color:#07334d;background:linear-gradient(135deg,rgba(36,217,255,.24),rgba(57,231,156,.22))}.avatar img{width:100%;height:100%;object-fit:cover;display:block}.rank{position:absolute;right:-5px;bottom:-5px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;display:grid;place-items:center;color:#061525;background:linear-gradient(135deg,#39e79c,#24d9ff);border:2px solid #fff;font-size:10px;font-weight:1000;box-shadow:0 6px 14px rgba(6,22,37,.16)}.channel b{display:block;font-size:15px;line-height:1.18;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.channel small{display:block;margin-top:3px;color:var(--muted);font-size:11px;font-weight:760}.channel-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}.mini{padding:10px;border-radius:16px;background:#fff;border:1px solid #e6eef8}.mini b{font-size:18px}.mini span{display:block;margin-top:4px;color:var(--muted);font-size:10.5px;font-weight:900}
.info-grid{display:grid;gap:10px;padding:14px}.info-item{display:grid;grid-template-columns:42px 1fr;gap:10px;align-items:start;padding:13px;border-radius:23px;background:#fbfdff;border:1px solid #e6eef8}.info-icon{width:42px;height:42px;border-radius:16px;display:grid;place-items:center;background:linear-gradient(135deg,rgba(36,217,255,.18),rgba(57,231,156,.16));font-size:19px}.info-item b{display:block;font-size:14.5px;line-height:1.2}.info-item span{display:block;margin-top:4px;color:var(--muted);font-size:12.5px;line-height:1.38;font-weight:730}
.dock{position:fixed;left:10px;right:10px;bottom:calc(8px + var(--safe-bottom));z-index:50;max-width:520px;margin:auto;display:flex;gap:7px;padding:7px;border-radius:26px;background:rgba(9,24,40,.86);box-shadow:0 22px 64px rgba(5,18,35,.35);backdrop-filter:blur(18px)}.dock a,.dock button{flex:1;min-height:50px;border-radius:19px;display:grid;place-items:center;color:#fff;background:rgba(255,255,255,.08);font-size:12px;font-weight:1000;text-align:center}.dock .primary{color:#061525;background:linear-gradient(135deg,var(--green),var(--cyan))}
.btn,.icon-btn,.segmented button,.channel,.dock a,.dock button,.tiny-link,.close{transition:transform .12s ease, box-shadow .12s ease, filter .12s ease, opacity .12s ease, background .12s ease;user-select:none}.btn:active,.icon-btn:active,.segmented button:active,.channel:active,.dock a:active,.dock button:active,.tiny-link:active,.close:active,.pressed{transform:scale(.965);filter:brightness(1.08)}.channel.is-sorted{animation:sortPop .26s ease both}@keyframes sortPop{0%{transform:translateY(4px);opacity:.78}100%{transform:translateY(0);opacity:1}}
.toast{position:fixed;left:50%;bottom:calc(86px + var(--safe-bottom));z-index:80;transform:translateX(-50%) translateY(18px);opacity:0;pointer-events:none;padding:11px 14px;border-radius:999px;background:rgba(8,22,38,.94);color:#fff;font-size:12px;font-weight:950;box-shadow:0 18px 50px rgba(5,18,35,.25);transition:.18s;white-space:nowrap}.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.modal{position:fixed;inset:0;z-index:70;display:none;align-items:flex-end;background:rgba(4,16,30,.58);backdrop-filter:blur(10px)}.modal.show{display:flex}.modal-card{width:100%;max-height:min(82vh,720px);overflow:auto;border-radius:30px 30px 0 0;background:#fff;padding-bottom:var(--safe-bottom);box-shadow:0 -24px 70px rgba(0,0,0,.25)}.modal-head{position:sticky;top:0;background:#fff;z-index:2;padding:15px 14px 0;display:flex;justify-content:space-between;gap:12px;align-items:center}.modal-head h3{margin:0;font-size:22px;letter-spacing:-.04em}.close{width:42px;height:42px;border-radius:16px;background:#eef5ff;color:var(--ink);font-size:22px;font-weight:1000}.modal-body{padding:12px 14px 18px;color:#405066;font-size:14px;line-height:1.48}.modal-list{display:grid;gap:8px;margin-top:12px}.modal-list div{display:flex;justify-content:space-between;gap:12px;padding:12px;border-radius:17px;background:#f8fbff;border:1px solid #e6eef8}.modal-list span{color:var(--muted);font-size:12px;font-weight:850}.modal-list b{text-align:right;font-size:13px;color:var(--ink)}
@media(max-width:370px){.app{padding-left:8px;padding-right:8px}.topbar{margin-left:-8px;margin-right:-8px;padding-left:8px;padding-right:8px}h1{font-size:31px}.hero-metric b{font-size:21px}.btn{font-size:12px}.brand b{font-size:15px}.logo-stage{min-height:170px}}

/* LOGO_FIX_CSS_V5 */
.brand-logo img,
.logo-stage img,
.media img{display:block;background:transparent}
.logo-stage img,
.media img{object-fit:cover}
.brand-logo img{object-fit:cover}


/* LOGO_DOCKER_PUBLIC_FIX_V6 */
.brand-logo img,
.logo-stage img,
.media img{
  display:block;
  background:transparent;
}
.brand-logo img{
  width:100%;
  height:100%;
  object-fit:cover;
}
.logo-stage img,
.media img{
  width:100%;
  height:100%;
  object-fit:cover;
}


/* NO_FACT_CPM_UI_V7 */
.hero-metric-pay{
  grid-column:1/-1;
}
.top-actions{
  justify-content:flex-end;
}


/* NO_FACT_CPM_UI_V8 */
.hero-metric-pay{
  grid-column:1/-1;
}
.top-actions{
  justify-content:flex-end;
}


/* CHART_CLEAR_HINT_V2 */
.chart-card::after{
  content:"Реальные замеры MAX";
  position:absolute;
  left:12px;
  top:12px;
  padding:7px 10px;
  border-radius:999px;
  background:rgba(255,255,255,.76);
  color:#607086;
  font-size:10.5px;
  font-weight:1000;
  backdrop-filter:blur(10px);
}


/* LR_REAL_VIEWS_V64_CSS */
.lr-independent-note{
  width:calc(100% - 20px);
  max-width:520px;
  margin:14px auto calc(92px + var(--safe-bottom));
  padding:14px 16px;
  border-radius:22px;
  background:rgba(255,255,255,.82);
  border:1px solid rgba(15,23,42,.10);
  box-shadow:0 14px 38px rgba(6,22,37,.10);
  color:#66758a;
  font-size:12px;
  line-height:1.45;
  font-weight:760;
  text-align:center;
  backdrop-filter:blur(14px);
}
.lr-independent-note b{color:#24364b}

</style>
</head>
<body>
<main class="app">
  <header class="topbar">
    <a class="brand" href="#top">
      <div class="brand-logo"><img src="/brand/linkray-logo.webp?v=4" alt=""></div>
      <div><b>LinkRay Analytics</b><span>отчёт по рекламному посту</span></div>
    </a>
    <div class="top-actions">
      <button class="icon-btn" data-action="refresh" aria-label="Обновить">↻</button>
    </div>
  </header>

  <section class="hero" id="top">
    <div class="hero-inner">
      <div class="status-line">
        <span class="pill"><i></i> Данные обновляются</span>
        <span class="pill dim">каждую минуту</span>
      </div>
      <h1>${esc(data.title)}</h1>
      <p class="lead">Результаты размещения в MAX: просмотры, CPM, сумма к оплате, динамика по времени и вклад каждого канала.</p>

      <div class="hero-metrics">
        <div class="hero-metric"><span>Просмотры</span><b>${number(data.metrics.views)}</b></div>
        <div class="hero-metric"><span>CPM</span><b>${money(data.metrics.cpm)}</b></div>
        <div class="hero-metric hero-metric-pay"><span>К оплате</span><b>${money(data.metrics.cost)}</b></div>
      </div>

      <div class="hero-actions">
        <button class="btn main" data-action="scroll-chart">📊 Смотреть график</button>
        <button class="btn ghost" data-action="copy">🔗 Скопировать</button>
        <a class="btn bot" href="${botLink}" target="_blank" rel="noopener">💬 Перейти в бота</a>
      </div>

      <div class="logo-stage"><img src="/brand/linkray-logo.webp?v=4" alt=""></div>
    </div>
  </section>

  <section class="overview">
    <article class="${statusClass}">
      <span class="label">Статус публикации</span>
      <div class="value">${esc(data.status.title)}</div>
      <div class="note">${esc(data.status.text)}</div>
      <div class="audit-grid">
        <div class="audit"><b>${number(data.metrics.channelsCount)}</b><span>канала</span></div>
        <div class="audit"><b>${esc(data.autoDeleteText)}</b><span>автоудаление</span></div>
      </div>
    </article>
    <article class="card blue">
      <span class="label">Публикация</span>
      <div class="value">${esc(published)}</div>
      <div class="note">Отчёт фиксирует просмотры за время нахождения поста в каналах и показывает итоговую сумму по заданному CPM.</div>
    </article>
  </section>

  <section class="panel" id="post">
    <div class="panel-head">
      <div class="panel-title"><h2>Пост</h2><a class="tiny-link" href="${botLink}" target="_blank" rel="noopener">открыть бота</a></div>
      <p class="sub">Исходный рекламный пост, по которому собран отчёт.</p>
    </div>
    <div class="post-wrap">
      <div class="media">${mediaHtml(data)}</div>
      <div class="post-text">
        <h3>${esc(data.postTitle)}</h3>
        <div class="post-body">${data.postHtml}</div>
        <div class="badges">
          <span class="badge">💼 рекламный пост</span><span class="badge">CPM ${money(data.metrics.cpm)}</span><span class="badge">${number(data.metrics.channelsCount)} канала</span><span class="badge">${esc(data.autoDeleteText)}</span>
        </div>
      </div>
    </div>
  </section>

  <section class="panel" id="chart">
    <div class="panel-head">
      <div class="panel-title"><h2>Аналитика по времени</h2></div>
      <p class="sub">График строится по реальным замерам статистики сообщения MAX. Нажмите на точку, чтобы увидеть просмотры.</p>
      <div class="segmented" id="ranges"></div>
    </div>
    <div class="chart-pad">
      <div class="chart-card" id="chartCard">
        <div class="tooltip" id="tooltip"></div>
        <svg class="chart" id="chartSvg" viewBox="0 0 760 320">
          <defs>
            <linearGradient id="lineGrad" x1="0" x2="1"><stop stop-color="#377dff"/><stop offset=".55" stop-color="#24d9ff"/><stop offset="1" stop-color="#39e79c"/></linearGradient>
            <linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#24d9ff" stop-opacity=".25"/><stop offset="1" stop-color="#39e79c" stop-opacity="0"/></linearGradient>
          </defs>
          <g id="grid"></g><polygon id="area" class="area"></polygon><polyline id="line" class="line"></polyline><g id="dots"></g><g id="hover"></g><g id="labels"></g>
        </svg>
      </div>
    </div>
  </section>

  <section class="panel" id="channels">
    <div class="panel-head">
      <div class="panel-title"><h2>Каналы</h2></div>
      <p class="sub">Распределение просмотров и стоимости по каждому каналу.</p>
      <div class="segmented" id="filters">
        <button class="active" data-filter="all">Все</button>
        <button data-filter="views">По просмотрам</button>
        <button data-filter="cost">По сумме</button>
      </div>
    </div>
    <div class="channels" id="channelList"></div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <div class="panel-title"><h2>Сводка отчёта</h2></div>
      <p class="sub">Основные данные рекламного размещения.</p>
    </div>
    <div class="info-grid">
      <div class="info-item"><div class="info-icon">📈</div><div><b>Динамика просмотров</b><span>График показывает рост просмотров за доступный период.</span></div></div>
      <div class="info-item"><div class="info-icon">💰</div><div><b>Расчёт по CPM</b><span>Сумма считается по указанной цене за 1000 просмотров.</span></div></div>
      <div class="info-item"><div class="info-icon">📡</div><div><b>Разбивка по каналам</b><span>Каждый канал отображается отдельно с просмотрами, долей и суммой.</span></div></div>
      <div class="info-item"><div class="info-icon">💬</div><div><b>LinkRay</b><span>Новые публикации, закупы и отчёты можно создать в боте.</span></div></div>
    </div>
  </section>

  <nav class="dock">
    <a href="#chart">График</a>
    <a href="#channels">Каналы</a>
    <a class="primary" href="${botLink}" target="_blank" rel="noopener">В бота</a>
  </nav>
</main>

<div class="toast" id="toast">Готово</div>
<div class="modal" id="modal">
  <div class="modal-card">
    <div class="modal-head"><h3 id="modalTitle">Детали</h3><button class="close" data-action="close-modal">×</button></div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<script id="report-data" type="application/json">${state}</script>
<script>
const report=JSON.parse(document.getElementById('report-data').textContent);
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
let activeRange=Number(Object.keys(report.ranges||{}).sort((a,b)=>Number(a)-Number(b)).pop()||24);
let currentPoints=[];
function num(v){return new Intl.NumberFormat('ru-RU').format(Math.round(Number(v)||0))}
function rub(v){return num(v)+' ₽'}
function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('show');clearTimeout(window.__t);window.__t=setTimeout(()=>el.classList.remove('show'),2000)}
function openModal(title,html){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modal').classList.add('show');document.body.style.overflow='hidden'}
function closeModal(){$('#modal').classList.remove('show');document.body.style.overflow=''}
function drawRangeButtons(){
  const keys=Object.keys(report.ranges||{}).sort((a,b)=>Number(a)-Number(b));
  $('#ranges').innerHTML=keys.map(k=>'<button data-range="'+k+'" class="'+(Number(k)===activeRange?'active':'')+'">'+k+'ч</button>').join('');
  $$('#ranges button').forEach(btn=>btn.onclick=()=>{$$('#ranges button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');drawChart(btn.dataset.range)});
}
function drawChart(range=activeRange){
  activeRange=Number(range);
  const data=(report.ranges&&report.ranges[String(activeRange)])||[];
  const width=760,height=320,pad={left:58,right:30,top:42,bottom:54};
  const iw=width-pad.left-pad.right, ih=height-pad.top-pad.bottom, rawMax=Math.max(...data.map(x=>Number(x[1])||0),1),maxViews=Math.max(4,Math.ceil(rawMax*1.15)),baseY=pad.top+ih;
  const points=data.map((item,index)=>({label:item[0],views:item[1],x:pad.left+(data.length===1?iw/2:iw*index/(data.length-1)),y:pad.top+ih-(item[1]/maxViews)*ih}));
  currentPoints=points;
  $('#grid').innerHTML=[0,.25,.5,.75,1].map(t=>{const y=pad.top+ih-ih*t,value=Math.round(maxViews*t);return '<line class="axis" x1="'+pad.left+'" y1="'+y+'" x2="'+(width-pad.right)+'" y2="'+y+'"></line><text class="chart-label" x="18" y="'+(y+4)+'">'+num(value)+'</text>'}).join('');
  const line=points.map(p=>p.x+','+p.y).join(' ');
  $('#line').setAttribute('points',line);$('#area').setAttribute('points',pad.left+','+baseY+' '+line+' '+(width-pad.right)+','+baseY);
  $('#dots').innerHTML=points.map((p,i)=>{const show=i===0||i===points.length-1||i===Math.floor(points.length/2);return '<circle class="dot-main" cx="'+p.x+'" cy="'+p.y+'" r="6"></circle>'+(show?'<text class="chart-value" x="'+Math.max(56,p.x-18)+'" y="'+Math.max(18,p.y-14)+'">'+num(p.views)+'</text>':'')}).join('');
  $('#labels').innerHTML=points.map((p,i)=>{const show=window.innerWidth>380||i%2===0||i===points.length-1;return show?'<text class="chart-label" x="'+(p.x-10)+'" y="'+(height-18)+'">'+p.label+'</text>':''}).join('');
  showPoint(points[points.length-1],false);
}
function clientPoint(e){const svg=$('#chartSvg'),rect=svg.getBoundingClientRect(),clientX=e.touches&&e.touches[0]?e.touches[0].clientX:e.clientX,clientY=e.touches&&e.touches[0]?e.touches[0].clientY:e.clientY;return{x:(clientX-rect.left)/rect.width*760,y:(clientY-rect.top)/rect.height*320,clientX,clientY}}
function nearest(x){return currentPoints.reduce((best,p)=>Math.abs(p.x-x)<Math.abs(best.x-x)?p:best,currentPoints[0])}
function showPoint(point,showToast=true,clientX=null,clientY=null){
  if(!point)return;
  $('#hover').innerHTML='<line class="hover-line" x1="'+point.x+'" y1="42" x2="'+point.x+'" y2="266"></line><circle class="hover-dot" cx="'+point.x+'" cy="'+point.y+'" r="7"></circle>';
  const chart=$('#chartCard'),tip=$('#tooltip'),svg=$('#chartSvg'),svgRect=svg.getBoundingClientRect(),chartRect=chart.getBoundingClientRect();
  const left=clientX===null?((point.x/760)*svgRect.width+(svgRect.left-chartRect.left)):(clientX-chartRect.left),top=clientY===null?((point.y/320)*svgRect.height+(svgRect.top-chartRect.top)):(clientY-chartRect.top);
  tip.innerHTML='<b>'+point.label+'</b><span>Просмотры: '+num(point.views)+'</span>';tip.style.left=Math.min(Math.max(left,84),chartRect.width-84)+'px';tip.style.top=Math.max(top-10,64)+'px';tip.classList.add('show');
  if(showToast)toast(point.label+' · просмотры: '+num(point.views));
}
function handleChart(e){e.preventDefault();const p=clientPoint(e);showPoint(nearest(p.x),true,p.clientX,p.clientY)}
function escapeAttr(value){
  return String(value || '')
    .replace(/&/g,'&amp;')
    .replace(/"/g,'&quot;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

function avatar(ch){
  const url = String(ch && ch.avatar ? ch.avatar : '').trim();

  if(url){
    return '<img src="' + escapeAttr(url) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
  }

  return String((ch && ch.title) || 'К').slice(0,1);
}


function renderChannels(filter='all'){
  const original=(report.channels||[]).map((ch,index)=>({...ch,originalIndex:index}));
  let arr=[...original], modeText='порядок публикации';
  if(filter==='views'){arr.sort((a,b)=>(b.views-a.views)||(a.originalIndex-b.originalIndex));modeText='сначала больше просмотров'}
  if(filter==='cost'){arr.sort((a,b)=>(b.cost-a.cost)||(b.views-a.views)||(a.originalIndex-b.originalIndex));modeText='сначала больше сумма'}
  $('#channelList').innerHTML=arr.map((ch,index)=>'<button class="channel is-sorted" data-id="'+ch.id+'" style="animation-delay:'+(index*35)+'ms"><div class="channel-top"><div class="avatar-wrap"><div class="avatar">'+avatar(ch)+'</div><span class="rank">'+(index+1)+'</span></div><div><b>'+ch.title+'</b><small>'+ch.time+' · '+modeText+'</small></div></div><div class="channel-stats"><div class="mini"><b>'+num(ch.views)+'</b><span>просмотров · '+(ch.share||0)+'%</span></div><div class="mini"><b>'+rub(ch.cost)+'</b><span>к оплате</span></div></div></button>').join('');
  $$('[data-id]').forEach(btn=>btn.onclick=()=>openChannel(btn.dataset.id));
  if(filter==='all')toast('Показан общий список каналов');if(filter==='views')toast('Сортировка по просмотрам');if(filter==='cost')toast('Сортировка по сумме');
}
function openChannel(id){const ch=(report.channels||[]).find(x=>String(x.id)===String(id));if(!ch)return;openModal(ch.title,'<p>Данные по размещению в канале.</p><div class="modal-list"><div><span>Просмотры</span><b>'+num(ch.views)+'</b></div><div><span>Доля от результата</span><b>'+(ch.share||0)+'%</b></div><div><span>Сумма</span><b>'+rub(ch.cost)+'</b></div><div><span>Публикация</span><b>'+ch.time+'</b></div></div>')}
async function copyLink(){try{await navigator.clipboard.writeText(location.href);toast('Ссылка скопирована')}catch{openModal('Ссылка отчёта','<p>'+location.href+'</p>')}}
function share(){if(navigator.share){navigator.share({title:'LinkRay Analytics',text:'Отчёт по рекламному посту MAX',url:location.href}).catch(()=>copyLink())}else copyLink()}
function refreshPage(){location.href=location.pathname+'?v='+Date.now()}
function action(type){if(type==='refresh')return refreshPage();if(type==='share')return share();if(type==='copy')return copyLink();if(type==='scroll-chart')return $('#chart').scrollIntoView({behavior:'smooth'});if(type==='close-modal')return closeModal()}
$$('[data-action]').forEach(el=>el.onclick=()=>action(el.dataset.action));
document.getElementById('filters').addEventListener('click',(e)=>{const btn=e.target.closest('button[data-filter]');if(!btn)return;document.querySelectorAll('#filters button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');renderChannels(btn.dataset.filter)});
document.addEventListener('pointerdown',(e)=>{const el=e.target.closest('.btn,.icon-btn,.segmented button,.channel,.dock a,.dock button,.tiny-link,.close');if(el)el.classList.add('pressed')});
document.addEventListener('pointerup',()=>document.querySelectorAll('.pressed').forEach(el=>el.classList.remove('pressed')));
document.addEventListener('pointercancel',()=>document.querySelectorAll('.pressed').forEach(el=>el.classList.remove('pressed')));
$('#modal').onclick=e=>{if(e.target.id==='modal')closeModal()};
$('#chartCard').addEventListener('click',handleChart);$('#chartCard').addEventListener('touchstart',handleChart,{passive:false});$('#chartCard').addEventListener('touchmove',handleChart,{passive:false});
window.addEventListener('resize',()=>drawChart(activeRange));
drawRangeButtons();drawChart(activeRange);renderChannels();
setInterval(refreshPage,60000);
</script>

<!-- LR_REAL_VIEWS_V64_FOOTER -->
<div class="lr-independent-note">
  <b>LinkRay Analytics</b> — независимый сервис аналитики рекламных
  размещений. Он не является официальным продуктом или подразделением
  ООО «MAX».
</div>
<script>
(() => {
  const EVERY_MS = 60000;
  let lastReload = Date.now();

  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastReload < EVERY_MS - 1000) return;
    lastReload = Date.now();
    window.location.reload();
  }, 5000);

  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      Date.now() - lastReload >= EVERY_MS
    ) {
      lastReload = Date.now();
      window.location.reload();
    }
  });
})();
</script>

</body>
</html>`;
}

export async function renderLinkRayAnalyticsRequest(req, res) {
  try {
    const data = await collect(req.params.groupId);

    res.setHeader('Cache-Control', 'no-store');

    if (String(req.query.json || '') === '1') {
      return res.json(data);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(page(data));
  } catch (error) {
    console.error('[linkray analytics render]', error.stack || error);
    const data = fallbackData(req.params.groupId);

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(page(data));
  }
}

async function syncPublishedViews() {
  try {
    const posts = rows(await query(
      `SELECT *
         FROM scheduled_posts
        WHERE published_message_id IS NOT NULL
          AND (status='published' OR published_at IS NOT NULL)
        ORDER BY COALESCE(published_at, publish_at, created_at) DESC
        LIMIT 150`
    ).catch(() => []));

    for (const post of posts) {
      const updated = await trySyncMaxViews(post);
      const snapshot = safeJson(updated.report_snapshot, {});
      const campaignId = updated.report_group_id || safeJson(updated.draft, {}).campaignId || updated.id;
      await savePoint(campaignId, updated.id, updated.channel_id, getViews(snapshot));
      await trySyncChannelAvatar(updated.channel_id);
    }
  } catch (error) {
    console.error('[linkray analytics minute sync]', error.message || error);
  }
}

function startMinuteSync() {
  if (minuteSyncStarted) return;
  minuteSyncStarted = true;
  setTimeout(lrV64SyncPublishedViews, 5000).unref?.();
  setInterval(lrV64SyncPublishedViews, 60000).unref?.();
}

export function mountLinkRayAnalyticsRoutes(app) {
  startMinuteSync();

  app.use('/brand', express.static(BRAND_DIR, {
    maxAge: '30d',
    etag: true,
  }));

  const sendLogo = (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('webp');
    return res.sendFile(LOGO_FILE);
  };

  app.get('/favicon.ico', sendLogo);
  app.get('/favicon.webp', sendLogo);
  app.get('/apple-touch-icon.webp', sendLogo);
  app.get('/analytics/logo.webp', sendLogo);
  app.get('/api/linkray/brand', (req, res) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'linkray.ru';
    const logo = proto + '://' + host + '/brand/linkray-logo.webp?v=4';
    return res.json({ ok: true, name: 'LinkRay', title: 'LinkRay', logo, favicon: logo });
  });

  app.get('/analytics/stats/:groupId', renderLinkRayAnalyticsRequest);

  app.get('/r/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '').trim();
      const link = rows(await query('SELECT target_url FROM analytics_links WHERE token=$1 LIMIT 1', [token]).catch(() => []))[0];

      if (!link?.target_url) {
        return res.status(404).send('LinkRay: ссылка не найдена');
      }

      return res.redirect(302, link.target_url);
    } catch (error) {
      console.error('[linkray redirect]', error.message || error);
      return res.status(500).send('LinkRay redirect error');
    }
  });
}

/* LR_REPORT_STATUS_V65_END */

/* LR_REPORT_STATUS_V66 */
