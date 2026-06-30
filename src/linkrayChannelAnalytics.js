import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express from 'express';
import sharp from 'sharp';
import { query } from './db.js';
import { sendMaxMessage, answerCallback } from './maxClient.js';

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.BASE_URL ||
  process.env.SITE_URL ||
  'https://linkray.ru';

const BOT_LINK = process.env.BOT_LINK || 'https://max.ru/se13353901_bot';
const OUT_DIR = path.resolve(process.cwd(), 'public', 'generated', 'channel-analytics');

let mounted = false;
let dailyStarted = false;
let lastDailyKey = '';

function rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
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

function plain(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function short(value, max = 58) {
  const text = plain(value);
  if (!text) return 'Канал MAX';
  return text.length > max ? text.slice(0, max).trim() + '…' : text;
}

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function fmt(value) {
  return num(value).toLocaleString('ru-RU');
}

function compact(value) {
  const n = num(value);
  if (n >= 900000) return (n / 900000).toFixed(n >= 9000000 ? 0 : 1).replace('.', ',') + 'M';
  if (n >= 900) return (n / 900).toFixed(n >= 9000 ? 0 : 1).replace('.', ',') + 'k';
  return String(n);
}

function pct(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0%';
  return `${n.toFixed(2).replace('.', ',')}%`;
}

function todayMsk() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  return d.toISOString().slice(0, 10);
}

function nowMskHuman() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function mskHourMinute() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  return { hour: d.getHours(), minute: d.getMinutes(), key: d.toISOString().slice(0, 10) };
}

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 18);
}

function getChatId(update) {
  return (
    update?.message?.recipient?.chat_id ||
    update?.message?.chat_id ||
    update?.message?.chat?.id ||
    update?.chat_id ||
    update?.callback?.message?.recipient?.chat_id ||
    update?.callback?.message?.chat_id ||
    update?.callback?.chat_id ||
    update?.recipient?.chat_id ||
    null
  );
}

function getText(update) {
  return String(
    update?.message?.body?.text ||
    update?.message?.text ||
    update?.body?.text ||
    update?.text ||
    update?.message?.body?.mid ||
    ''
  );
}

function getPayload(update) {
  return String(
    update?.callback?.payload ||
    update?.callback?.body?.payload ||
    update?.callback?.button?.payload ||
    update?.payload ||
    ''
  );
}

function extractMaxLinks(text) {
  const found = String(text || '').match(/https?:\/\/(?:www\.)?max\.ru\/[^\s<>"')]+/gi) || [];
  return [...new Set(found.map((x) => x.replace(/[.,;!?]+$/g, '')))];
}

function isOnlyAnalyticsLinks(text, links) {
  let t = String(text || '').trim();

  if (/^\/?(analytics|аналитика|стата|статистика)\b/i.test(t)) return true;

  for (const link of links) {
    t = t.replace(link, ' ');
  }

  t = t.replace(/[\s,;]+/g, '').trim();

  return !t;
}

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS public.lr_channel_analytics_settings (
      chat_id text PRIMARY KEY,
      daily_enabled boolean NOT NULL DEFAULT false,
      links jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

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
      captured_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_lr_channel_analytics_snapshots_key_time
    ON public.lr_channel_analytics_snapshots(channel_key, captured_at DESC)
  `);
}

function deepNumberByKey(obj, keys) {
  let best = 0;
  const exact = new Set(keys.map((x) => String(x).toLowerCase()));

  function asNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
    if (typeof value === 'string') {
      const t = value.replace(/\s+/g, '').replace(',', '.');
      if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
      const n = Number(t);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    return null;
  }

  function walk(node, key = '') {
    if (node === null || node === undefined) return;

    if (typeof node === 'number' || typeof node === 'string') {
      const n = asNumber(node);
      if (n !== null && exact.has(String(key).toLowerCase())) {
        best = Math.max(best, n);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }

    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (exact.has(String(k).toLowerCase())) {
          const n = asNumber(v);
          if (n !== null) best = Math.max(best, n);
        }
      }
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  }

  walk(obj);

  return best;
}

function deepStringByKey(obj, keys) {
  const exact = new Set(keys.map((x) => String(x).toLowerCase()));
  let value = '';

  function walk(node, key = '') {
    if (value) return;
    if (node === null || node === undefined) return;

    if (typeof node === 'string' && exact.has(String(key).toLowerCase()) && node.trim()) {
      value = node.trim();
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }

    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  }

  walk(obj);

  return value;
}

function normalizeStats(link, raw = {}) {
  const title =
    deepStringByKey(raw, ['title', 'name', 'chat_title', 'channel_title', 'display_name']) ||
    link.replace(/^https?:\/\//, '').slice(0, 46);

  const avatarUrl =
    deepStringByKey(raw, ['avatar_url', 'photo_url', 'image_url', 'icon_url', 'picture_url', 'avatar', 'photo']) ||
    '';

  const subscribers = deepNumberByKey(raw, [
    'subscribers',
    'subscriber_count',
    'members',
    'members_count',
    'participants_count',
    'participants',
    'followers',
    'followers_count',
  ]);

  const views24 = deepNumberByKey(raw, [
    'views24',
    'views_24',
    'views24h',
    'views_24h',
    'views_day',
    'views_last_day',
    'views',
    'view_count',
  ]);

  const views48 = deepNumberByKey(raw, ['views48', 'views_48', 'views48h', 'views_48h']);
  const views72 = deepNumberByKey(raw, ['views72', 'views_72', 'views72h', 'views_72h']);

  const er24Raw = deepNumberByKey(raw, ['er24', 'er_24', 'er24h', 'er_24h', 'engagement_rate']);
  const er24 = er24Raw || (subscribers > 0 ? (views24 / subscribers) * 100 : 0);

  return {
    link,
    title,
    avatarUrl,
    subscribers,
    views24,
    views48: views48 || views24,
    views72: views72 || views48 || views24,
    er24,
    raw,
  };
}

async function callMaxForStats(link) {
  try {
    const mod = await import('./maxClient.js');

    const fns = [
      mod.getChannelAnalytics,
      mod.getChannelStats,
      mod.getChannelInfo,
      mod.getChatInfo,
      mod.getChat,
      mod.resolveChannel,
      mod.resolveChat,
      mod.default?.getChannelAnalytics,
      mod.default?.getChannelStats,
      mod.default?.getChannelInfo,
      mod.default?.getChatInfo,
      mod.default?.getChat,
      mod.default?.resolveChannel,
      mod.default?.resolveChat,
    ].filter((fn) => typeof fn === 'function');

    for (const fn of fns) {
      const attempts = [
        [link],
        [{ link }],
        [{ url: link }],
        [{ channel_link: link }],
      ];

      for (const args of attempts) {
        try {
          const raw = await fn(...args);
          if (raw && typeof raw === 'object') {
            return raw;
          }
        } catch {}
      }
    }
  } catch (error) {
    console.error('[LinkRay channel analytics max]', error.message || error);
  }

  return {};
}

async function loadFromKnownChannels(link) {
  try {
    const colsResult = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='channels'`
    ).catch(() => []);

    const cols = new Set(rows(colsResult).map((r) => String(r.column_name)));

    if (!cols.size) return {};

    const linkCols = ['link', 'public_link', 'invite_link', 'url', 'channel_link', 'join_link', 'username', 'handle']
      .filter((col) => cols.has(col));

    if (!linkCols.length) return {};

    const titleCols = ['title', 'name', 'channel_title', 'chat_title', 'display_name']
      .filter((col) => cols.has(col));

    const avatarCols = ['avatar_url', 'photo_url', 'image_url', 'icon_url', 'picture_url', 'avatar', 'photo']
      .filter((col) => cols.has(col));

    const idCols = ['id', 'chat_id', 'channel_id', 'max_chat_id', 'max_channel_id', 'max_id', 'external_id']
      .filter((col) => cols.has(col));

    const selectCols = [...new Set([...linkCols, ...titleCols, ...avatarCols, ...idCols])]
      .map((col) => `"${col}"`)
      .join(', ');

    const where = linkCols.map((col) => `"${col}"::text=$1`).join(' OR ');

    const result = await query(
      `SELECT ${selectCols} FROM public.channels WHERE ${where} LIMIT 1`,
      [link]
    ).catch(() => []);

    return rows(result)[0] || {};
  } catch {
    return {};
  }
}


/* LR_REAL_CHANNEL_DATA_V16_START */
function lrV16DecodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lrV16NormalizeLink(link) {
  return String(link || '')
    .trim()
    .replace(/[.,;!?]+$/g, '')
    .replace(/^http:\/\//i, 'https://')
    .replace(/^https:\/\/www\./i, 'https://')
    .replace(/\/+$/g, '');
}

function lrV16LinkNeedles(link) {
  const full = lrV16NormalizeLink(link);
  const path = full.replace(/^https:\/\/max\.ru\//i, '');
  const join = path.replace(/^join\//i, '');
  const shortJoin = join.slice(0, 18);

  return [...new Set([full, path, join, shortJoin].filter(Boolean))];
}

function lrV16Meta(html, key) {
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${safeKey}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${safeKey}["'][^>]*>`, 'i'),
  ];

  for (const pattern of patterns) {
    const m = String(html || '').match(pattern);
    if (m?.[1]) return lrV16DecodeHtml(m[1]);
  }

  return '';
}

function lrV16NumberFromText(text) {
  const raw = String(text || '').replace(/\u00a0/g, ' ');
  const m = raw.match(/([\d\s.,]{1,16})\s*(?:подписчик|подписчика|подписчиков|участник|участника|участников|followers|members)/i);
  if (!m) return 0;

  const n = Number(String(m[1]).replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

async function lrV16FetchMaxPreview(link) {
  const cleanLink = lrV16NormalizeLink(link);

  try {
    const response = await fetch(cleanLink, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'user-agent': 'Mozilla/5.0 LinkRayBot/1.0 (+https://linkray.ru)',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ru,en;q=0.8',
      },
    });

    if (!response.ok) return {};

    const html = await response.text();

    const title =
      lrV16Meta(html, 'og:title') ||
      lrV16Meta(html, 'twitter:title') ||
      (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ? lrV16DecodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)[1]) : '');

    const description =
      lrV16Meta(html, 'og:description') ||
      lrV16Meta(html, 'twitter:description') ||
      lrV16Meta(html, 'description');

    const avatar =
      lrV16Meta(html, 'og:image') ||
      lrV16Meta(html, 'twitter:image') ||
      lrV16Meta(html, 'image');

    const subscribers = lrV16NumberFromText(`${title} ${description} ${html.slice(0, 25000)}`);

    const out = {};
    if (title && !/^MAX\s+is\s+a\s+fast/i.test(title)) out.title = title;
    if (avatar) out.avatar_url = avatar;
    if (description) out.description = description;
    if (subscribers > 0) out.subscribers = subscribers;

    if (Object.keys(out).length) {
      console.log('[LR_REAL_PREVIEW_V16]', cleanLink, JSON.stringify({
        title: out.title || '',
        avatar: !!out.avatar_url,
        subscribers: out.subscribers || 0,
      }));
    }

    return out;
  } catch (error) {
    console.error('[LR_REAL_PREVIEW_V16_ERROR]', cleanLink, error.message || error);
    return {};
  }
}

function lrV16Pick(row, names) {
  if (!row || typeof row !== 'object') return '';
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') {
      return row[name];
    }
  }
  return '';
}

function lrV16PickNumber(row, names) {
  const value = lrV16Pick(row, names);
  return num(value);
}

async function lrV16LoadFromSnapshots(link) {
  const needles = lrV16LinkNeedles(link);
  const likeNeedles = needles.map((x) => `%${x}%`);

  try {
    const exact = rows(await query(
      `SELECT *
         FROM public.lr_channel_analytics_snapshots
        WHERE link = ANY($1::text[])
        ORDER BY captured_at DESC
        LIMIT 1`,
      [needles]
    ).catch(() => []))[0];

    if (exact) return exact;

    const byLike = rows(await query(
      `SELECT *
         FROM public.lr_channel_analytics_snapshots
        WHERE link ILIKE ANY($1::text[])
        ORDER BY captured_at DESC
        LIMIT 1`,
      [likeNeedles]
    ).catch(() => []))[0];

    return byLike || {};
  } catch {
    return {};
  }
}

async function lrV16LoadFromChannelsTable(link) {
  const needles = lrV16LinkNeedles(link);
  const likeNeedles = needles.map((x) => `%${x}%`);

  try {
    const colsResult = await query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='channels'`
    ).catch(() => []);

    const cols = rows(colsResult);
    if (!cols.length) return {};

    const colNames = cols.map((r) => String(r.column_name));
    const colSet = new Set(colNames);

    const preferredLinkCols = [
      'link', 'public_link', 'invite_link', 'url', 'channel_link',
      'join_link', 'max_link', 'chat_link', 'username', 'handle',
      'chat_id', 'channel_id', 'max_chat_id', 'max_channel_id',
      'external_id', 'id'
    ].filter((c) => colSet.has(c));

    const textCols = cols
      .filter((r) => /char|text|json/i.test(String(r.data_type)))
      .map((r) => String(r.column_name));

    const searchCols = [...new Set([...preferredLinkCols, ...textCols])].slice(0, 40);
    if (!searchCols.length) return {};

    const exactWhere = searchCols.map((c) => `"${c}"::text = ANY($1::text[])`).join(' OR ');
    const likeWhere = searchCols.map((c) => `"${c}"::text ILIKE ANY($1::text[])`).join(' OR ');

    const exact = rows(await query(
      `SELECT * FROM public.channels WHERE ${exactWhere} LIMIT 1`,
      [needles]
    ).catch(() => []))[0];

    if (exact) return exact;

    const byLike = rows(await query(
      `SELECT * FROM public.channels WHERE ${likeWhere} LIMIT 1`,
      [likeNeedles]
    ).catch(() => []))[0];

    return byLike || {};
  } catch (error) {
    console.error('[LR_CHANNEL_DB_V16_ERROR]', error.message || error);
    return {};
  }
}

async function lrV16KnownChannelData(link) {
  const snap = await lrV16LoadFromSnapshots(link);
  const channel = await lrV16LoadFromChannelsTable(link);

  const merged = { ...snap, ...channel };

  const title = lrV16Pick(merged, [
    'title', 'name', 'channel_title', 'chat_title', 'display_name',
    'channel_name', 'chat_name'
  ]);

  const avatar = lrV16Pick(merged, [
    'avatar_url', 'photo_url', 'image_url', 'icon_url',
    'picture_url', 'avatar', 'photo'
  ]);

  const subscribers = lrV16PickNumber(merged, [
    'subscribers', 'subscriber_count', 'subscribers_count',
    'members', 'members_count', 'participants_count',
    'followers', 'followers_count'
  ]);

  const views24 = lrV16PickNumber(merged, [
    'views24', 'views_24', 'views24h', 'views_24h',
    'views_day', 'views_last_day', 'views', 'view_count'
  ]);

  const views48 = lrV16PickNumber(merged, [
    'views48', 'views_48', 'views48h', 'views_48h'
  ]);

  const views72 = lrV16PickNumber(merged, [
    'views72', 'views_72', 'views72h', 'views_72h'
  ]);

  const er24 = Number(lrV16Pick(merged, [
    'er24', 'er_24', 'er24h', 'er_24h', 'engagement_rate'
  ]) || 0);

  const out = {};

  if (title) out.title = title;
  if (avatar) out.avatar_url = avatar;
  if (subscribers > 0) out.subscribers = subscribers;
  if (views24 > 0) out.views24 = views24;
  if (views48 > 0) out.views48 = views48;
  if (views72 > 0) out.views72 = views72;
  if (er24 > 0) out.er24 = er24;

  if (Object.keys(out).length) {
    console.log('[LR_KNOWN_CHANNEL_V16]', lrV16NormalizeLink(link), JSON.stringify({
      title: out.title || '',
      avatar: !!out.avatar_url,
      subscribers: out.subscribers || 0,
      views24: out.views24 || 0,
    }));
  }

  return out;
}

function lrV16CleanTitle(title, link, idx = 0) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();

  if (!text) return `Канал ${idx + 1}`;
  if (/^https?:\/\//i.test(text)) return `Канал ${idx + 1}`;
  if (/^max\.ru/i.test(text)) return `Канал ${idx + 1}`;
  if (/^join\//i.test(text)) return `Канал ${idx + 1}`;
  if (/^MAX\s+is\s+a\s+fast/i.test(text)) return `Канал ${idx + 1}`;

  return text;
}
/* LR_REAL_CHANNEL_DATA_V16_END */


/* LR_RESOLVE_PRIORITY_V17_START */
function lrV17IsBadTitle(title) {
  const t = String(title || '').trim();
  return (
    !t ||
    /^https?:\/\//i.test(t) ||
    /^max\.ru/i.test(t) ||
    /^join\//i.test(t) ||
    /^MAX\s+[-–]\s+/i.test(t) ||
    /^MAX\s+is\s+a\s+fast/i.test(t) ||
    /быстрое и легкое приложение/i.test(t)
  );
}

function lrV17PickRealTitle(...items) {
  for (const item of items) {
    const title = String(item?.title || item?.name || item?.channel_title || item?.channel_name || '').replace(/\s+/g, ' ').trim();
    if (!lrV17IsBadTitle(title)) return title;
  }
  return '';
}

function lrV17PickRealAvatar(...items) {
  for (const item of items) {
    const avatar = String(
      item?.avatar_url ||
      item?.avatarUrl ||
      item?.photo_url ||
      item?.image_url ||
      item?.icon_url ||
      item?.picture_url ||
      item?.avatar ||
      item?.photo ||
      ''
    ).trim();

    if (!avatar) continue;

    // Не берём служебные картинки MAX-приложения вместо аватарки канала.
    const low = avatar.toLowerCase();
    if (low.includes('max-app') || low.includes('app-icon') || low.includes('favicon')) continue;

    return avatar;
  }

  return '';
}

function lrV17PickPositiveNumber(...values) {
  for (const value of values) {
    const n = num(value);
    if (n > 0) return n;
  }
  return 0;
}
/* LR_RESOLVE_PRIORITY_V17_END */


/* LR_AVATAR_DEDUPE_V19_START */
function lrV19AvatarUrl(ch) {
  return String(
    ch?.avatar_url ||
    ch?.avatarUrl ||
    ch?.photo_url ||
    ch?.image_url ||
    ch?.icon_url ||
    ch?.picture_url ||
    ch?.avatar ||
    ch?.photo ||
    ''
  ).trim();
}

function lrV19IsBadPreviewTitle(title) {
  const t = String(title || '').trim();
  return (
    !t ||
    /^MAX\s+[-–]\s+/i.test(t) ||
    /^MAX\s+is\s+a\s+fast/i.test(t) ||
    /быстрое и легкое приложение/i.test(t) ||
    /communication and everyday tasks/i.test(t)
  );
}

function lrV19CleanPreviewAvatar(preview) {
  if (!preview || typeof preview !== 'object') return preview;

  if (lrV19IsBadPreviewTitle(preview.title)) {
    delete preview.avatar_url;
    delete preview.avatarUrl;
    delete preview.photo_url;
    delete preview.image_url;
    delete preview.icon_url;
    delete preview.picture_url;
    delete preview.avatar;
    delete preview.photo;
  }

  return preview;
}

function lrV19DropAvatar(ch) {
  if (!ch || typeof ch !== 'object') return ch;
  ch.avatar_url = '';
  ch.avatarUrl = '';
  ch.photo_url = '';
  ch.image_url = '';
  ch.icon_url = '';
  ch.picture_url = '';
  ch.avatar = '';
  ch.photo = '';
  return ch;
}

function lrV19DedupeNetworkAvatars(channels) {
  const map = new Map();

  for (const ch of channels || []) {
    const url = lrV19AvatarUrl(ch);
    if (!url) continue;
    const key = url.toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ch);
  }

  for (const group of map.values()) {
    if (group.length <= 1) continue;

    const titles = new Set(group.map((x) => String(x.title || x._lrTitle || '').trim()).filter(Boolean));
    const links = new Set(group.map((x) => String(x.link || x.key || '').trim()).filter(Boolean));

    // Одна и та же картинка на разных каналах — это почти всегда аватар первого MAX-превью.
    if (titles.size > 1 || links.size > 1) {
      for (let i = 1; i < group.length; i++) lrV19DropAvatar(group[i]);
    }
  }

  return channels;
}

function lrV19AvatarFallback(ch, x, y, size, idx) {
  const title = String(ch?.title || ch?._lrTitle || `Канал ${idx + 1}`).trim();
  const letter = lrV14Esc((title[0] || String(idx + 1)).toUpperCase());
  const colors = [
    ['#26e8ff', '#0b6fff'],
    ['#31f2cc', '#098f76'],
    ['#8e7cff', '#2830a8'],
    ['#ffd166', '#f97316'],
    ['#ff6b9a', '#9b1b5a'],
  ];
  const pair = colors[idx % colors.length];

  return `
    <defs>
      <linearGradient id="lrAvFallback${idx}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${pair[0]}"/>
        <stop offset="100%" stop-color="${pair[1]}"/>
      </linearGradient>
    </defs>
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="url(#lrAvFallback${idx})" stroke="#31f2cc" stroke-width="3"/>
    <text x="${x + size / 2}" y="${y + size / 2 + 8}" text-anchor="middle" font-size="20" font-weight="1000" fill="#ffffff">${letter}</text>
  `;
}
/* LR_AVATAR_DEDUPE_V19_END */


/* LR_SAFE_AVATAR_PRIORITY_V22_START */
function lrV22NormText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lrV22SafeExtraRawForChannel(extraRaw, known, cleanLink) {
  if (!extraRaw || typeof extraRaw !== 'object') return {};

  const extraTitle = lrV22NormText(
    extraRaw.title ||
    extraRaw.name ||
    extraRaw.channel_title ||
    extraRaw.channel_name ||
    ''
  );

  const knownTitle = lrV22NormText(
    known?.title ||
    known?.name ||
    known?.channel_title ||
    known?.channel_name ||
    ''
  );

  if (extraTitle && knownTitle && extraTitle === knownTitle) {
    return extraRaw;
  }

  const raw = JSON.stringify(extraRaw || {}).toLowerCase();
  const link = String(cleanLink || '').toLowerCase();
  const tail = link.split('/join/').pop() || '';

  if (link && raw.includes(link)) return extraRaw;
  if (tail && tail.length > 12 && raw.includes(tail)) return extraRaw;

  // Если превью не совпало с текущей ссылкой — это превью первого канала.
  // Его нельзя применять к другим каналам.
  return {};
}
/* LR_SAFE_AVATAR_PRIORITY_V22_END */

async function resolveChannel(link, extraRaw = {}) {
  await ensureTables();

  const cleanLink = lrV16NormalizeLink(link);
  const channelKey = hash(cleanLink);

  if (
    extraRaw &&
    typeof extraRaw === 'object' &&
    (extraRaw.message || extraRaw.callback || extraRaw.update_id || extraRaw.recipient || extraRaw.body)
  ) {
    extraRaw = {};
  }

  const idx = Number(extraRaw?._lrIndex || 0);

  const known = await lrV16KnownChannelData(cleanLink);
  const lrV22ExtraRaw = lrV22SafeExtraRawForChannel(extraRaw, known, cleanLink);
  const preview = lrV19CleanPreviewAvatar(await lrV16FetchMaxPreview(cleanLink));
  const fromMax = await callMaxForStats(cleanLink);

  // ВАЖНО:
  // known — это база LinkRay / сохранённые каналы, она главнее.
  // preview MAX часто отдаёт общий заголовок приложения или первое превью.
  const rawMerged = {
    ...fromMax,
    ...preview,
    ...known,
    ...lrV22ExtraRaw,
  };

  const normalized = normalizeStats(cleanLink, rawMerged);

  const realTitle = lrV17PickRealTitle(known, lrV22ExtraRaw, fromMax, preview, normalized);
  const realAvatar = lrV17PickRealAvatar(known, lrV22ExtraRaw, fromMax, preview, normalized);

  normalized.title = realTitle || lrV16CleanTitle(normalized.title, cleanLink, idx);
  normalized.avatarUrl = realAvatar || normalized.avatarUrl || normalized.avatar_url || '';

  normalized.subscribers = lrV17PickPositiveNumber(
    known.subscribers,
    known.subscriber_count,
    known.members_count,
    fromMax.subscribers,
    fromMax.subscriber_count,
    preview.subscribers,
    normalized.subscribers
  );

  normalized.views24 = lrV17PickPositiveNumber(
    known.views24,
    known.views_24,
    known.views24h,
    fromMax.views24,
    fromMax.views_24,
    normalized.views24
  );

  normalized.views48 = lrV17PickPositiveNumber(
    known.views48,
    known.views_48,
    fromMax.views48,
    fromMax.views_48,
    normalized.views48,
    normalized.views24
  );

  normalized.views72 = lrV17PickPositiveNumber(
    known.views72,
    known.views_72,
    fromMax.views72,
    fromMax.views_72,
    normalized.views72,
    normalized.views48,
    normalized.views24
  );

  const prev = rows(await query(
    ` SELECT subscribers
        FROM public.lr_channel_analytics_snapshots
       WHERE channel_key=$1
       ORDER BY captured_at DESC
       LIMIT 1 `,
    [channelKey]
  ).catch(() => []))[0];

  const deltaDay = normalized.subscribers - num(prev?.subscribers);

  const saved = rows(await query(
    ` INSERT INTO public.lr_channel_analytics_snapshots
        (channel_key, link, title, avatar_url, subscribers, views24, views48, views72, er24, delta_day, raw)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      RETURNING * `,
    [
      channelKey,
      cleanLink,
      normalized.title,
      normalized.avatarUrl || '',
      normalized.subscribers,
      normalized.views24,
      normalized.views48,
      normalized.views72,
      normalized.er24 || 0,
      deltaDay,
      JSON.stringify({ known, preview, fromMax, extraRaw: lrV22ExtraRaw } || {}),
    ]
  ))[0];

  console.log('[LR_CHANNEL_RESOLVED_V17]', JSON.stringify({
    link: cleanLink,
    title: saved.title,
    avatar: !!saved.avatar_url,
    subscribers: num(saved.subscribers),
    views24: num(saved.views24),
  }));

  return {
    key: channelKey,
    link: cleanLink,
    title: saved.title,
    avatarUrl: saved.avatar_url || '',
    avatar_url: saved.avatar_url || '',
    subscribers: num(saved.subscribers),
    views24: num(saved.views24),
    views48: num(saved.views48),
    views72: num(saved.views72),
    er24: Number(saved.er24 || 0),
    deltaDay: num(saved.delta_day),
  };
}

async function historyFor(channelKey, field = 'subscribers') {
  const result = await query(
    `
    SELECT DISTINCT ON (to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD'))
      to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'DD.MM') AS label,
      subscribers,
      views24,
      views48,
      views72,
      captured_at
    FROM public.lr_channel_analytics_snapshots
    WHERE channel_key=$1
    ORDER BY to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD'), captured_at DESC
    LIMIT 14
    `,
    [channelKey]
  ).catch(() => []);

  const arr = rows(result).map((r) => ({
    label: r.label,
    value: num(r[field]),
  }));

  return arr.length >= 2 ? arr : [];
}

async function networkHistory(channels) {
  const keys = channels.map((c) => c.key);
  if (!keys.length) return [];

  const result = await query(
    `
    SELECT day, SUM(subscribers)::int AS subscribers
    FROM (
      SELECT DISTINCT ON (channel_key, to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD'))
        channel_key,
        to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'DD.MM') AS day,
        subscribers,
        captured_at
      FROM public.lr_channel_analytics_snapshots
      WHERE channel_key = ANY($1::text[])
      ORDER BY channel_key, to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD'), captured_at DESC
    ) x
    GROUP BY day
    ORDER BY day ASC
    LIMIT 14
    `,
    [keys]
  ).catch(() => []);

  const arr = rows(result).map((r) => ({
    label: r.day,
    value: num(r.subscribers),
  }));

  return arr.length >= 2 ? arr : [];
}

async function inlineAvatar(url, fallbackText, cls = '') {
  if (!url || !/^https?:\/\//i.test(url)) {
    return `<div class="av ${cls}">${esc(String(fallbackText || 'К').slice(0, 1).toUpperCase())}</div>`;
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(String(response.status));
    const type = response.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await response.arrayBuffer());
    const data = `data:${type};base64,${buf.toString('base64')}`;
    return `<div class="av ${cls}"><img src="${attr(data)}"/></div>`;
  } catch {
    return `<div class="av ${cls}">${esc(String(fallbackText || 'К').slice(0, 1).toUpperCase())}</div>`;
  }
}

function chartSvg(values, labels, options = {}) {
  const width = 560;
  const height = options.height || 170;
  const pad = 18;

  const nums = values.map(num);
  const min = Math.min(...nums, 0);
  const max = Math.max(...nums, 1);
  const span = Math.max(1, max - min);

  const pts = nums.map((v, i) => {
    const x = pad + (width - pad * 2) * (i / Math.max(1, nums.length - 1));
    const y = pad + (height - pad * 2) * (1 - ((v - min) / span));
    return [x, y, v, labels[i] || ''];
  });

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L ${width - pad},${height - pad} L ${pad},${height - pad} Z`;
  const circles = pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="5.5"/>`).join('');

  const first = pts[0] || [pad, height - pad, 0];
  const last = pts[pts.length - 1] || [width - pad, height - pad, 0];

  return `
  <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="line${hash(JSON.stringify(values))}" x1="0" x2="1">
        <stop stop-color="#4a8dff"/>
        <stop offset=".55" stop-color="#24d9ff"/>
        <stop offset="1" stop-color="#31d986"/>
      </linearGradient>
    </defs>
    <g stroke="#e6edf6" stroke-width="1">
      <line x1="${pad}" y1="${pad}" x2="${width - pad}" y2="${pad}"/>
      <line x1="${pad}" y1="${height / 2}" x2="${width - pad}" y2="${height / 2}"/>
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"/>
    </g>
    <path d="${area}" fill="rgba(36,217,255,.13)"/>
    <path d="${d}" fill="none" stroke="#24bff2" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <g fill="#fff" stroke="#31d986" stroke-width="4">${circles}</g>
    <text x="${first[0] + 4}" y="${Math.max(18, first[1] - 10)}" fill="#111827" font-size="18" font-weight="900">${fmt(first[2])}</text>
    <text x="${Math.max(22, last[0] - 92)}" y="${Math.max(18, last[1] - 10)}" fill="#111827" font-size="18" font-weight="900">${fmt(last[2])}</text>
  </svg>`;
}

function barSvg(values, labels) {
  const width = 560;
  const height = 170;
  const pad = 22;
  const nums = values.map(num);
  const max = Math.max(...nums, 1);
  const gap = (width - pad * 2) / nums.length;
  const barW = gap * 0.56;

  const colors = ['#24d9ff', '#4a8dff', '#31d986'];

  const bars = nums.map((v, i) => {
    const bh = (height - pad * 2) * (v / max);
    const x = pad + gap * i + gap * 0.22;
    const y = height - pad - bh;

    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="13" fill="${colors[i % colors.length]}"/>
      <text x="${x + barW / 2}" y="${Math.max(18, y - 8)}" text-anchor="middle" fill="#111827" font-size="19" font-weight="900">${fmt(v)}</text>
      <text x="${x + barW / 2}" y="${height - 4}" text-anchor="middle" fill="#758397" font-size="15" font-weight="900">${esc(labels[i] || '')}</text>
    `;
  }).join('');

  return `
  <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <g stroke="#e6edf6" stroke-width="1">
      <line x1="${pad}" y1="${pad}" x2="${width - pad}" y2="${pad}"/>
      <line x1="${pad}" y1="${height / 2}" x2="${width - pad}" y2="${height / 2}"/>
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"/>
    </g>
    ${bars}
  </svg>`;
}

function htmlWrap(body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
*{box-sizing:border-box}
body{margin:0;width:1080px;height:675px;background:#292627;font-family:Inter,Arial,sans-serif;color:#111827}
.card{width:1080px;height:675px;position:relative;overflow:hidden;background:
radial-gradient(circle at 0 0,rgba(34,217,255,.13),transparent 270px),
radial-gradient(circle at 100% 0,rgba(32,199,123,.11),transparent 300px),
linear-gradient(180deg,#292627,#373033)}
.card:before{content:"";position:absolute;inset:0;background:
linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),
linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:38px 38px}
.inner{position:absolute;inset:18px;z-index:2;display:grid;grid-template-rows:auto 1fr auto;gap:12px}
.sheet{background:#fff;border-radius:20px;padding:18px;box-shadow:0 16px 42px rgba(0,0,0,.20);border:1px solid rgba(0,0,0,.06);overflow:hidden}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
.left{display:flex;align-items:center;gap:10px;min-width:0}
.av{width:42px;height:42px;border-radius:50%;overflow:hidden;display:grid;place-items:center;flex:0 0 auto;color:#fff;font-weight:900;background:radial-gradient(circle at 30% 25%,#ffe08a,#b8751d 42%,#291a0d 100%)}
.av img{width:100%;height:100%;object-fit:cover}
.title{min-width:0}
.title b{display:block;font-size:21px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.03em}
.title span{display:block;font-size:12px;color:#758397;font-weight:850;margin-top:2px}
.lr{font-size:15px;font-weight:900;color:#5b62ff;white-space:nowrap}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
.metric{min-height:86px;border:1px solid #e5edf6;border-radius:14px;background:#fff;padding:12px;text-align:center}
.metric .k{font-size:11px;text-transform:uppercase;color:#8793a3;font-weight:900;line-height:1.12}
.metric .v{margin-top:8px;font-size:30px;line-height:1;font-weight:900;letter-spacing:-.06em;color:#168eea}
.metric.green .v{color:#20c77b}.metric.red .v{color:#d9635d}
.grid{display:grid;grid-template-columns:1.25fr .75fr;gap:12px}
.grid.net{grid-template-columns:1fr 1fr}
.panel{border:1px solid #e5edf6;border-radius:16px;background:#f7fbff;padding:13px;min-height:245px;overflow:hidden}
.ph{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.ph b{font-size:15px;color:#4c5d73}.ph span{font-size:11px;color:#7c8898;font-weight:900;background:#fff;border:1px solid #e6edf6;border-radius:999px;padding:5px 8px}
.chart{height:180px}
.rows{display:grid;gap:8px}
.row{display:grid;grid-template-columns:42px 1fr 70px 56px;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid #e9f0f7}
.row:last-child{border-bottom:0}
.row .name{font-weight:950;color:#263447;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row b{text-align:right;color:#168eea}.row em{font-style:normal;text-align:right;font-weight:900}.plus{color:#20c77b}.minus{color:#d9635d}
.txt{display:grid;grid-template-columns:1fr auto;gap:14px;color:#fff;align-items:end}
.cap{font-size:24px;line-height:1.24}
.cap .red{color:#d9635d;font-weight:900;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px}
.cap b{font-weight:900}
.foot{border-left:4px solid rgba(255,255,255,.85);background:rgba(255,255,255,.12);border-radius:6px;padding:9px 12px;color:#fff;font-size:17px;line-height:1.25;min-width:310px}
.foot .red{color:#d9635d;text-decoration:underline;font-weight:900}
.time{text-align:right;color:rgba(255,255,255,.55);font-size:13px;font-weight:800;margin-top:6px}
</style>
</head>
<body>${body}</body>
</html>`;
}




/* LR_ANALYTICS_CARDS_V2 */
const LR_CARD_W = 1280;
const LR_CARD_H = 900;

function lrCardEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lrCardShort(value, max = 46) {
  const text = plain(value || 'Канал MAX');
  return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
}

function lrCardClip(value, max = 64) {
  const text = plain(value || '');
  return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
}

function lrCardMoney(value) {
  return fmt(value);
}

async function lrBrandLogoDataUrl(size = 128) {
  const candidates = [
    path.resolve(process.cwd(), 'public', 'brand', 'linkray-logo.webp'),
    path.resolve(process.cwd(), 'public', 'brand', 'linkray-logo.png'),
    path.resolve(process.cwd(), 'public', 'brand', 'linkray-logo.jpg'),
    path.resolve(process.cwd(), 'public', 'brand', 'linkray-logo.svg'),
  ];

  for (const file of candidates) {
    try {
      const buf = await fs.readFile(file);

      if (file.endsWith('.svg')) {
        return `data:image/svg+xml;base64,${buf.toString('base64')}`;
      }

      const png = await sharp(buf)
        .resize(size, size, { fit: 'cover' })
        .png()
        .toBuffer();

      return `data:image/png;base64,${png.toString('base64')}`;
    } catch {}
  }

  return '';
}

async function lrImageUrlToPngDataUrl(url, size = 80) {
  if (!url || !/^https?:\/\//i.test(String(url))) return '';

  try {
    const response = await fetch(String(url), { signal: AbortSignal.timeout(7000) });

    if (!response.ok) return '';

    const buf = Buffer.from(await response.arrayBuffer());
    const png = await sharp(buf)
      .resize(size, size, { fit: 'cover' })
      .png()
      .toBuffer();

    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return '';
  }
}

async function lrSvgAvatar(ch, x, y, size, idx = 0) {
  const avatarUrl = ch.avatarUrl || ch.avatar_url || ch.photo_url || ch.image_url || '';
  const data = await lrImageUrlToPngDataUrl(avatarUrl, size);
  const id = `av_${hash(`${ch.key || ch.link || ch.title || ''}_${x}_${y}_${size}`)}`;

  if (data) {
    return `
      <clipPath id="${id}">
        <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/>
      </clipPath>
      <image href="${data}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>
      <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 - 1}" fill="none" stroke="rgba(255,255,255,.58)" stroke-width="2"/>
    `;
  }

  const letter = lrCardEsc(String(ch.title || 'К').trim().slice(0, 1).toUpperCase() || 'К');
  const palettes = [
    ['#13294b', '#246bfe', '#36e4d2'],
    ['#271650', '#8659ff', '#3bf0ff'],
    ['#3c2510', '#d59a34', '#ffe089'],
    ['#341a27', '#ff6aa2', '#62e9d2'],
    ['#113128', '#23c882', '#d9fff5'],
  ];
  const p = palettes[idx % palettes.length];
  const gid = `g_${id}`;

  return `
    <defs>
      <radialGradient id="${gid}" cx="30%" cy="20%" r="80%">
        <stop offset="0%" stop-color="${p[2]}"/>
        <stop offset="48%" stop-color="${p[1]}"/>
        <stop offset="100%" stop-color="${p[0]}"/>
      </radialGradient>
    </defs>
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="url(#${gid})"/>
    <text x="${x + size / 2}" y="${y + size / 2 + size * 0.14}" text-anchor="middle" font-size="${Math.round(size * 0.42)}" font-weight="900" fill="#fff">${letter}</text>
  `;
}

function lrMetricSvg(x, y, w, h, label, value, color = '#27e6c7') {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="rgba(255,255,255,.105)" stroke="rgba(128,245,232,.34)" stroke-width="2"/>
    <text x="${x + w / 2}" y="${y + 38}" text-anchor="middle" font-size="22" font-weight="900" fill="#c5d9e4">${lrCardEsc(label)}</text>
    <text x="${x + w / 2}" y="${y + h - 42}" text-anchor="middle" font-size="52" font-weight="900" fill="${color}">${lrCardEsc(value)}</text>
  `;
}

function lrChartSvg(values, labels, x, y, w, h, color = '#27e6c7') {
  let nums = values.map(num).filter((v) => Number.isFinite(v));

  if (!nums.length) nums = [0, 0];
  if (nums.length === 1) nums = [nums[0], nums[0]];

  let min = Math.min(...nums);
  let max = Math.max(...nums);

  if (min === max) {
    min = Math.max(0, min - 1);
    max = max + 1;
  }

  const span = Math.max(1, max - min);
  const padX = 32;
  const padY = 26;

  const pts = nums.map((v, i) => {
    const px = x + padX + (w - padX * 2) * (i / Math.max(1, nums.length - 1));
    const py = y + padY + (h - padY * 2) * (1 - ((v - min) / span));
    return [px, py, v, labels[i] || ''];
  });

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L ${x + w - padX},${y + h - padY} L ${x + padX},${y + h - padY} Z`;

  const grid = [0, 1, 2, 3, 4].map((i) => {
    const yy = y + padY + (h - padY * 2) * (i / 4);
    return `<line x1="${x + padX}" y1="${yy}" x2="${x + w - padX}" y2="${yy}" stroke="rgba(120,150,170,.24)" stroke-width="1"/>`;
  }).join('');

  const dots = pts.map((p, i) => {
    const show = i === 0 || i === pts.length - 1 || i % Math.ceil(pts.length / 5) === 0;
    return `
      <circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="8" fill="#061726" stroke="${color}" stroke-width="4"/>
      ${show ? `<text x="${p[0].toFixed(1)}" y="${Math.max(y + 22, p[1] - 18).toFixed(1)}" text-anchor="middle" font-size="18" font-weight="900" fill="${color}">${fmt(p[2])}</text>` : ''}
    `;
  }).join('');

  const labelEvery = Math.max(1, Math.ceil(pts.length / 6));
  const axisLabels = pts.map((p, i) => {
    if (i % labelEvery !== 0 && i !== pts.length - 1) return '';
    return `<text x="${p[0].toFixed(1)}" y="${y + h - 3}" text-anchor="middle" font-size="16" font-weight="900" fill="#7f96a6">${lrCardEsc(p[3])}</text>`;
  }).join('');

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="#f6fbff" stroke="#d9eaf2" stroke-width="2"/>
    ${grid}
    <path d="${area}" fill="rgba(39,230,199,.16)"/>
    <path d="${d}" fill="none" stroke="rgba(39,230,199,.22)" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    ${axisLabels}
  `;
}

function lrBarsSvg(values, labels, x, y, w, h) {
  const nums = values.map(num);
  const max = Math.max(...nums, 1);
  const pad = 28;
  const gap = (w - pad * 2) / Math.max(1, nums.length);
  const barW = Math.max(38, gap * 0.44);
  const colors = ['#24d9ff', '#27e6c7', '#4a8dff'];

  const bars = nums.map((v, i) => {
    const bh = (h - pad * 2 - 28) * (v / max);
    const bx = x + pad + gap * i + (gap - barW) / 2;
    const by = y + h - pad - 28 - bh;

    return `
      <rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="12" fill="${colors[i % colors.length]}"/>
      <text x="${bx + barW / 2}" y="${Math.max(y + 34, by - 10)}" text-anchor="middle" font-size="20" font-weight="900" fill="#0b1b2b">${fmt(v)}</text>
      <text x="${bx + barW / 2}" y="${y + h - 14}" text-anchor="middle" font-size="17" font-weight="900" fill="#76899a">${lrCardEsc(labels[i] || '')}</text>
    `;
  }).join('');

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="#f6fbff" stroke="#d9eaf2" stroke-width="2"/>
    <line x1="${x + pad}" y1="${y + h - pad - 28}" x2="${x + w - pad}" y2="${y + h - pad - 28}" stroke="#dbe8ef" stroke-width="2"/>
    ${bars}
  `;
}

function lrBaseSvgStart() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${LR_CARD_W}" height="${LR_CARD_H}" viewBox="0 0 ${LR_CARD_W} ${LR_CARD_H}">
  <defs>
    <linearGradient id="lrBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#061726"/>
      <stop offset="46%" stop-color="#0b2940"/>
      <stop offset="100%" stop-color="#0e835f"/>
    </linearGradient>
    <radialGradient id="lrGlow" cx="85%" cy="8%" r="72%">
      <stop offset="0%" stop-color="rgba(76,255,184,.40)"/>
      <stop offset="56%" stop-color="rgba(38,230,199,.10)"/>
      <stop offset="100%" stop-color="rgba(38,230,199,0)"/>
    </radialGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000" flood-opacity=".28"/>
    </filter>
    <style>
      text { font-family: DejaVu Sans, Noto Sans, Arial, sans-serif; }
      .white { fill: #ffffff; }
      .muted { fill: #c4d9e4; }
      .dark { fill: #102033; }
    </style>
  </defs>

  <rect width="${LR_CARD_W}" height="${LR_CARD_H}" fill="url(#lrBg)"/>
  <rect width="${LR_CARD_W}" height="${LR_CARD_H}" fill="url(#lrGlow)"/>
  <path d="M0 160 C230 80 370 230 580 125 C820 2 1030 165 1280 45" fill="none" stroke="rgba(255,255,255,.055)" stroke-width="3"/>
  <path d="M0 815 C300 700 500 830 730 720 C970 602 1180 720 1280 620" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="3"/>
  `;
}

async function lrHeaderSvg(label) {
  const logo = await lrBrandLogoDataUrl(116);

  return `
    ${logo ? `<image href="${logo}" x="52" y="42" width="116" height="116" preserveAspectRatio="xMidYMid slice"/>` : ''}
    <text x="188" y="86" font-size="42" font-weight="900" fill="#fff">LinkRay Analytics</text>
    <text x="190" y="124" font-size="24" font-weight="900" fill="#c4d9e4">аналитика каналов и размещений MAX</text>
    <rect x="1188" y="58" width="356" height="70" rx="26" fill="rgba(255,255,255,.12)" stroke="rgba(111,255,229,.44)" stroke-width="2"/>
    <text x="1366" y="101" font-size="29" font-weight="900" text-anchor="middle" fill="#34e7c6">${lrCardEsc(label)}</text>
  `;
}

function lrFooterSvg() {
  return `
    <rect x="58" y="920" width="1484" height="42" rx="18" fill="rgba(255,255,255,.10)" stroke="rgba(255,255,255,.12)" stroke-width="1"/>
    <text x="88" y="948" font-size="22" font-weight="900" fill="#d6edf2">Данные собираются LinkRay с момента добавления бота администратором в канал</text>
    <text x="1512" y="948" font-size="22" font-weight="900" text-anchor="end" fill="#d6edf2">Дата формирования отчёта: ${lrCardEsc(nowMskHuman())} МСК</text>
  `;
}


/* LR_ANALYTICS_EDIT_AND_SAFE_PNG_V3_START */
function lrGetCallbackIdV3(update) {
  return (
    update?.callback?.callback_id ||
    update?.callback?.id ||
    update?.callback_id ||
    update?.callbackId ||
    update?.message_callback?.callback_id ||
    update?.message_callback?.id ||
    null
  );
}

async function lrEditOrSendV3(update, chatId, text, buttons = []) {
  const callbackId = lrGetCallbackIdV3(update);
  const attachments = lrMenuButtons(buttons);

  if (callbackId) {
    try {
      await answerCallback({
        callbackId,
        text,
        format: 'html',
        attachments,
      });
      return;
    } catch (error) {
      console.error('[LinkRay analytics edit callback failed]', error?.message || error);
    }
  }

  return sendMaxMessage({
    chatId,
    text,
    format: 'html',
    attachments,
  });
}

function lrSvgEscV3(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lrSvgShortV3(value, max = 42) {
  const text = String(value || 'Канал MAX').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
}

function lrSvgWrapV3(value, max = 34, limit = 2) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
    if (lines.length >= limit) break;
  }

  if (line && lines.length < limit) lines.push(line);
  if (!lines.length) lines.push('Канал MAX');

  return lines.map((x, i) => {
    if (i === limit - 1 && words.join(' ').length > lines.join(' ').length) {
      return lrSvgShortV3(x, max);
    }
    return x;
  });
}

async function lrSafeAvatarV3(ch, x, y, size, idx = 0) {
  const url = ch.avatarUrl || ch.avatar_url || ch.photo_url || ch.image_url || '';
  const data = await lrImageUrlToPngDataUrl(url, size).catch(() => '');

  if (data) {
    const clip = `clip_${hash(String(ch.key || ch.link || ch.title || '') + x + y + size)}`;
    return `
      <clipPath id="${clip}"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath>
      <image href="${data}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>
      <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 - 1}" fill="none" stroke="#7ef8e1" stroke-width="3"/>
    `;
  }

  const palettes = [
    ['#11356b', '#22d5ff'],
    ['#25125c', '#8662ff'],
    ['#10382b', '#26e7a5'],
    ['#512138', '#ff72a6'],
  ];
  const p = palettes[idx % palettes.length];
  const gid = `grad_${hash(String(ch.key || ch.link || ch.title || '') + idx)}`;
  const letter = lrSvgEscV3(String(ch.title || 'К').trim().slice(0, 1).toUpperCase() || 'К');

  return `
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${p[1]}"/>
        <stop offset="100%" stop-color="${p[0]}"/>
      </linearGradient>
    </defs>
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="url(#${gid})"/>
    <text x="${x + size / 2}" y="${y + size / 2 + size * 0.14}" text-anchor="middle" font-size="${Math.round(size * 0.44)}" font-weight="900" fill="#fff">${letter}</text>
  `;
}

function lrMetricBoxV3(x, y, w, h, label, value, color = '#31f2cc') {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="rgba(255,255,255,.12)" stroke="rgba(126,248,225,.38)" stroke-width="2"/>
    <text x="${x + w / 2}" y="${y + 36}" text-anchor="middle" font-size="21" font-weight="900" fill="#cde8ef">${lrSvgEscV3(label)}</text>
    <text x="${x + w / 2}" y="${y + 100}" text-anchor="middle" font-size="50" font-weight="900" fill="${color}">${lrSvgEscV3(value)}</text>
  `;
}

function lrLineChartV3(values, labels, x, y, w, h, color = '#31f2cc') {
  let nums = values.map(num).filter((v) => Number.isFinite(v));
  if (!nums.length) nums = [0, 0];
  if (nums.length === 1) nums = [nums[0], nums[0]];

  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) {
    min = Math.max(0, min - 1);
    max += 1;
  }

  const padX = 34;
  const padY = 30;
  const span = Math.max(1, max - min);

  const pts = nums.map((v, i) => {
    const px = x + padX + (w - padX * 2) * (i / Math.max(1, nums.length - 1));
    const py = y + padY + (h - padY * 2 - 22) * (1 - ((v - min) / span));
    return [px, py, v, labels[i] || ''];
  });

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L ${x + w - padX},${y + h - padY - 22} L ${x + padX},${y + h - padY - 22} Z`;

  const grid = [0, 1, 2, 3].map((i) => {
    const yy = y + padY + (h - padY * 2 - 22) * (i / 3);
    return `<line x1="${x + padX}" y1="${yy}" x2="${x + w - padX}" y2="${yy}" stroke="rgba(118,154,170,.25)" stroke-width="1"/>`;
  }).join('');

  const dots = pts.map((p, i) => {
    const show = i === 0 || i === pts.length - 1 || i % Math.ceil(pts.length / 4) === 0;
    return `
      <circle cx="${p[0]}" cy="${p[1]}" r="7" fill="#071a28" stroke="${color}" stroke-width="4"/>
      ${show ? `<text x="${p[0]}" y="${Math.max(y + 24, p[1] - 14)}" text-anchor="middle" font-size="18" font-weight="900" fill="${color}">${fmt(p[2])}</text>` : ''}
    `;
  }).join('');

  const labelEvery = Math.max(1, Math.ceil(pts.length / 5));
  const axis = pts.map((p, i) => {
    if (i % labelEvery !== 0 && i !== pts.length - 1) return '';
    return `<text x="${p[0]}" y="${y + h - 8}" text-anchor="middle" font-size="16" font-weight="800" fill="#8ba1ae">${lrSvgEscV3(p[3])}</text>`;
  }).join('');

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="#f7fcff" stroke="#d7edf5" stroke-width="2"/>
    ${grid}
    <path d="${area}" fill="rgba(49,242,204,.17)"/>
    <path d="${d}" fill="none" stroke="rgba(49,242,204,.22)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    ${axis}
  `;
}

function lrBarsV3(values, labels, x, y, w, h) {
  const nums = values.map(num);
  const max = Math.max(...nums, 1);
  const gap = w / nums.length;
  const barW = Math.min(72, gap * 0.48);
  const colors = ['#27d9ff', '#31f2cc', '#4d8dff'];

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="#f7fcff" stroke="#d7edf5" stroke-width="2"/>
    ${nums.map((v, i) => {
      const bh = Math.max(8, (h - 68) * (v / max));
      const bx = x + gap * i + (gap - barW) / 2;
      const by = y + h - 38 - bh;
      return `
        <rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="12" fill="${colors[i % colors.length]}"/>
        <text x="${bx + barW / 2}" y="${Math.max(y + 34, by - 10)}" text-anchor="middle" font-size="19" font-weight="900" fill="#102033">${fmt(v)}</text>
        <text x="${bx + barW / 2}" y="${y + h - 14}" text-anchor="middle" font-size="16" font-weight="900" fill="#7e93a2">${lrSvgEscV3(labels[i] || '')}</text>
      `;
    }).join('')}
  `;
}

function lrSvgShellV3(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900" viewBox="0 0 1280 900">
    <defs>
      <linearGradient id="bgV3" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#051525"/>
        <stop offset="46%" stop-color="#0b2d43"/>
        <stop offset="100%" stop-color="#0d8e69"/>
      </linearGradient>
      <radialGradient id="glowV3" cx="84%" cy="10%" r="70%">
        <stop offset="0%" stop-color="rgba(95,255,188,.44)"/>
        <stop offset="65%" stop-color="rgba(49,242,204,.12)"/>
        <stop offset="100%" stop-color="rgba(49,242,204,0)"/>
      </radialGradient>
      <filter id="shadowV3" x="-10%" y="-10%" width="120%" height="130%">
        <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000" flood-opacity=".30"/>
      </filter>
      <style>
        text { font-family: DejaVu Sans, Arial, sans-serif; }
      </style>
    </defs>
    <rect width="1280" height="900" fill="url(#bgV3)"/>
    <rect width="1280" height="900" fill="url(#glowV3)"/>
    <path d="M-40 150 C220 70 420 215 640 110 C900 -15 1110 145 1320 50" fill="none" stroke="rgba(255,255,255,.055)" stroke-width="3"/>
    <path d="M-30 835 C260 708 510 850 740 730 C980 610 1200 715 1320 620" fill="none" stroke="rgba(255,255,255,.050)" stroke-width="3"/>
    ${inner}
  </svg>`;
}

async function lrSafeSaveSvgPngV3(svg, name) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const fileName = `${name}-${Date.now()}.png`;
  const filePath = path.join(OUT_DIR, fileName);

  await sharp(Buffer.from(svg))
    .png()
    .toFile(filePath);

  return {
    filePath,
    publicUrl: `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/generated/channel-analytics/${fileName}`,
  };
}

async function lrSafeRenderSingleV3(ch) {
  const history = await historyFor(ch.key, 'subscribers');
  const subValues = history.length ? history.map((x) => x.value) : [ch.subscribers, ch.subscribers];
  const subLabels = history.length ? history.map((x) => x.label) : ['старт', 'сейчас'];
  const avatar = await lrSafeAvatarV3(ch, 66, 172, 76, 0);
  const titleLines = lrSvgWrapV3(ch.title, 48, 2);

  const inner = `
    <text x="46" y="78" font-size="54" font-weight="900" fill="#ffffff">LinkRay Analytics</text>
    <text x="48" y="118" font-size="25" font-weight="900" fill="#cde8ef">карточка канала · реальные данные после подключения бота</text>
    <rect x="980" y="48" width="240" height="70" rx="26" fill="rgba(255,255,255,.14)" stroke="rgba(126,248,225,.44)" stroke-width="2"/>
    <text x="1100" y="99" text-anchor="middle" font-size="28" font-weight="900" fill="#31f2cc">1 КАНАЛ</text>

    <rect x="34" y="150" width="1212" height="650" rx="44" fill="rgba(255,255,255,.115)" stroke="rgba(126,248,225,.30)" stroke-width="2" filter="url(#shadowV3)"/>

    ${avatar}
    <text x="160" y="207" font-size="42" font-weight="900" fill="#fff">${lrSvgEscV3(titleLines[0])}</text>
    ${titleLines[1] ? `<text x="160" y="248" font-size="42" font-weight="900" fill="#fff">${lrSvgEscV3(titleLines[1])}</text>` : ''}
    <text x="162" y="286" font-size="24" font-weight="900" fill="#cde8ef">MAX-канал · отчёт сформирован LinkRay</text>

    ${lrMetricBoxV3(66, 330, 260, 118, 'Подписчики', fmt(ch.subscribers), '#27d9ff')}
    ${lrMetricBoxV3(350, 330, 260, 118, 'За сутки', `${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}`, ch.deltaDay < 0 ? '#ff7280' : '#31f2cc')}
    ${lrMetricBoxV3(634, 330, 260, 118, 'Охват 24ч', fmt(ch.views24), '#31f2cc')}
    ${lrMetricBoxV3(918, 330, 282, 118, 'ER24', pct(ch.er24), '#27d9ff')}

    <text x="66" y="500" font-size="32" font-weight="900" fill="#fff">Динамика подписчиков</text>
    ${lrLineChartV3(subValues, subLabels, 66, 525, 690, 200, ch.deltaDay < 0 ? '#ff7280' : '#31f2cc')}

    <text x="800" y="500" font-size="32" font-weight="900" fill="#fff">Охваты</text>
    ${lrBarsV3([ch.views24, ch.views48, ch.views72], ['24ч', '48ч', '72ч'], 800, 525, 400, 200)}

    <text x="82" y="850" font-size="25" font-weight="900" fill="#fff">Просмотры: 24ч — ${fmt(ch.views24)} · 48ч — ${fmt(ch.views48)} · 72ч — ${fmt(ch.views72)}</text>
    <text x="82" y="944" font-size="22" font-weight="900" fill="#d8f2f4">Данные собираются LinkRay с момента добавления бота администратором в канал</text>
    <text x="1518" y="944" text-anchor="end" font-size="22" font-weight="900" fill="#d8f2f4">Дата формирования отчёта: ${lrSvgEscV3(nowMskHuman())} МСК</text>
  `;

  return lrSafeSaveSvgPngV3(lrSvgShellV3(inner), `lr-single-${ch.key}`);
}

async function lrSafeRenderNetworkV3(channels) {
  const totalSubs = channels.reduce((s, ch) => s + num(ch.subscribers), 0);
  const total24 = channels.reduce((s, ch) => s + num(ch.views24), 0);
  const total48 = channels.reduce((s, ch) => s + num(ch.views48), 0);
  const total72 = channels.reduce((s, ch) => s + num(ch.views72), 0);
  const totalDelta = channels.reduce((s, ch) => s + num(ch.deltaDay), 0);
  const er24 = totalSubs ? (total24 / totalSubs) * 100 : 0;
  const history = await networkHistory(channels);
  const histValues = history.length ? history.map((x) => x.value) : [totalSubs, totalSubs];
  const histLabels = history.length ? history.map((x) => x.label) : ['старт', 'сейчас'];

  const sorted = channels.slice().sort((a, b) => num(b.views24) - num(a.views24)).slice(0, 5);
  const rowSvg = [];

  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i];
    const y = 566 + i * 40;
    const av = await lrSafeAvatarV3(ch, 692, y - 27, 32, i);
    rowSvg.push(`
      ${av}
      <text x="736" y="${y}" font-size="24" font-weight="900" fill="#102033">${lrSvgEscV3(lrSvgShortV3(ch.title, 24))}</text>
      <text x="1010" y="${y}" text-anchor="middle" font-size="25" font-weight="900" fill="#168eea">${fmt(ch.subscribers)}</text>
      <text x="1140" y="${y}" text-anchor="middle" font-size="25" font-weight="900" fill="#168eea">${fmt(ch.views24)}</text>
    `);
  }

  const inner = `
    <text x="46" y="78" font-size="54" font-weight="900" fill="#ffffff">Статистика сети каналов</text>
    <text x="48" y="118" font-size="25" font-weight="900" fill="#cde8ef">LinkRay Analytics · сводка по ${channels.length} каналам</text>
    <rect x="970" y="48" width="250" height="70" rx="26" fill="rgba(255,255,255,.14)" stroke="rgba(126,248,225,.44)" stroke-width="2"/>
    <text x="1095" y="99" text-anchor="middle" font-size="28" font-weight="900" fill="#31f2cc">СЕТКА</text>

    <rect x="34" y="150" width="1212" height="650" rx="44" fill="rgba(255,255,255,.115)" stroke="rgba(126,248,225,.30)" stroke-width="2" filter="url(#shadowV3)"/>

    ${lrMetricBoxV3(66, 200, 260, 118, 'Подписчики', fmt(totalSubs), '#27d9ff')}
    ${lrMetricBoxV3(350, 200, 260, 118, 'Просмотры 24ч', fmt(total24), '#31f2cc')}
    ${lrMetricBoxV3(634, 200, 260, 118, 'Средний ER', pct(er24), '#27d9ff')}
    ${lrMetricBoxV3(918, 200, 282, 118, 'Каналов', String(channels.length), '#31f2cc')}

    <text x="66" y="385" font-size="32" font-weight="900" fill="#fff">График подписчиков</text>
    ${lrLineChartV3(histValues, histLabels, 66, 410, 560, 300, totalDelta < 0 ? '#ff7280' : '#31f2cc')}

    <rect x="660" y="410" width="540" height="300" rx="26" fill="#f7fcff" stroke="#d7edf5" stroke-width="2"/>
    <text x="696" y="455" font-size="31" font-weight="900" fill="#102033">Каналы</text>
    <text x="730" y="502" font-size="18" font-weight="900" fill="#7d8e9d">Название</text>
    <text x="1010" y="502" text-anchor="middle" font-size="18" font-weight="900" fill="#7d8e9d">ПДП</text>
    <text x="1140" y="502" text-anchor="middle" font-size="18" font-weight="900" fill="#7d8e9d">24ч</text>
    <line x1="690" y1="520" x2="1168" y2="520" stroke="#dcebf2" stroke-width="2"/>
    ${rowSvg.join('')}

    <text x="82" y="850" font-size="25" font-weight="900" fill="#fff">Всего подписчиков: ${fmt(totalSubs)} · Итог за сутки: ${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)}</text>
    <text x="82" y="884" font-size="25" font-weight="900" fill="#fff">Просмотры: 24ч — ${fmt(total24)} · 48ч — ${fmt(total48)} · 72ч — ${fmt(total72)}</text>
    <text x="82" y="944" font-size="22" font-weight="900" fill="#d8f2f4">Данные собираются LinkRay с момента добавления бота администратором в канал</text>
    <text x="1518" y="944" text-anchor="end" font-size="22" font-weight="900" fill="#d8f2f4">Дата формирования отчёта: ${lrSvgEscV3(nowMskHuman())} МСК</text>
  `;

  return lrSafeSaveSvgPngV3(lrSvgShellV3(inner), `lr-network-${hash(channels.map((x) => x.key).join('-'))}`);
}
/* LR_ANALYTICS_EDIT_AND_SAFE_PNG_V3_END */


/* LR_COMPACT_ANALYTICS_CARD_V4_START */
function lrSvgShellV4(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs>
      <linearGradient id="lrBgV4" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#061426"/>
        <stop offset="45%" stop-color="#0b3147"/>
        <stop offset="100%" stop-color="#12a06f"/>
      </linearGradient>
      <radialGradient id="lrGlowV4" cx="86%" cy="12%" r="72%">
        <stop offset="0%" stop-color="#65ffc0" stop-opacity=".45"/>
        <stop offset="64%" stop-color="#31f2cc" stop-opacity=".12"/>
        <stop offset="100%" stop-color="#31f2cc" stop-opacity="0"/>
      </radialGradient>
      <filter id="lrShadowV4" x="-10%" y="-10%" width="120%" height="130%">
        <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#00111b" flood-opacity=".34"/>
      </filter>
      <style>
        text { font-family: DejaVu Sans, Arial, sans-serif; }
      </style>
    </defs>
    <rect width="1280" height="720" fill="url(#lrBgV4)"/>
    <rect width="1280" height="720" fill="url(#lrGlowV4)"/>
    <path d="M-40 150 C220 70 420 215 640 110 C900 -15 1060 145 1320 50" fill="none" stroke="rgba(255,255,255,.065)" stroke-width="3"/>
    <path d="M-30 610 C260 500 510 620 740 520 C980 410 1110 520 1320 430" fill="none" stroke="rgba(255,255,255,.055)" stroke-width="3"/>
    ${inner}
  </svg>`;
}

function lrMetricBoxV4(x, y, w, h, label, value, color = '#31f2cc') {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="rgba(255,255,255,.13)" stroke="rgba(126,248,225,.34)" stroke-width="2"/>
    <text x="${x + w / 2}" y="${y + 31}" text-anchor="middle" font-size="17" font-weight="900" fill="#d7eef2">${lrSvgEscV3(label)}</text>
    <text x="${x + w / 2}" y="${y + 83}" text-anchor="middle" font-size="38" font-weight="1000" fill="${color}">${lrSvgEscV3(value)}</text>
  `;
}

function lrMiniLogoV4(x, y) {
  return `
    <circle cx="${x + 26}" cy="${y + 26}" r="26" fill="rgba(49,242,204,.18)" stroke="#7ef8e1" stroke-width="2"/>
    <path d="M${x + 14} ${y + 34} L${x + 30} ${y + 18} L${x + 34} ${y + 28} L${x + 45} ${y + 15}" fill="none" stroke="#31f2cc" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M${x + 42} ${y + 15} L${x + 47} ${y + 15} L${x + 47} ${y + 20}" fill="none" stroke="#31f2cc" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  `;
}

function lrLineChartCompactV4(values, labels, x, y, w, h, color = '#31f2cc') {
  let nums = values.map(num).filter((v) => Number.isFinite(v));
  if (!nums.length) nums = [0, 0];
  if (nums.length === 1) nums = [nums[0], nums[0]];

  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) {
    min = Math.max(0, min - 1);
    max += 1;
  }

  const padX = 28;
  const padY = 24;
  const span = Math.max(1, max - min);

  const pts = nums.map((v, i) => {
    const px = x + padX + (w - padX * 2) * (i / Math.max(1, nums.length - 1));
    const py = y + padY + (h - padY * 2 - 22) * (1 - ((v - min) / span));
    return [px, py, v, labels[i] || ''];
  });

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L ${x + w - padX},${y + h - padY - 22} L ${x + padX},${y + h - padY - 22} Z`;

  const grid = [0, 1, 2].map((i) => {
    const yy = y + padY + (h - padY * 2 - 22) * (i / 2);
    return `<line x1="${x + padX}" y1="${yy}" x2="${x + w - padX}" y2="${yy}" stroke="rgba(118,154,170,.22)" stroke-width="1"/>`;
  }).join('');

  const dots = pts.map((p, i) => {
    const show = i === 0 || i === pts.length - 1;
    return `
      <circle cx="${p[0]}" cy="${p[1]}" r="6" fill="#071a28" stroke="${color}" stroke-width="4"/>
      ${show ? `<text x="${p[0]}" y="${Math.max(y + 23, p[1] - 12)}" text-anchor="middle" font-size="16" font-weight="900" fill="${color}">${fmt(p[2])}</text>` : ''}
    `;
  }).join('');

  const axis = pts.map((p, i) => {
    if (i !== 0 && i !== pts.length - 1) return '';
    return `<text x="${p[0]}" y="${y + h - 7}" text-anchor="middle" font-size="14" font-weight="900" fill="#7d93a0">${lrSvgEscV3(p[3])}</text>`;
  }).join('');

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="#f7fcff" stroke="#d7edf5" stroke-width="2"/>
    ${grid}
    <path d="${area}" fill="rgba(49,242,204,.16)"/>
    <path d="${d}" fill="none" stroke="rgba(49,242,204,.20)" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    ${axis}
  `;
}

function lrBarsCompactV4(values, labels, x, y, w, h) {
  const nums = values.map(num);
  const max = Math.max(...nums, 1);
  const gap = w / nums.length;
  const barW = Math.min(64, gap * .46);
  const colors = ['#27d9ff', '#31f2cc', '#4d8dff'];

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="#f7fcff" stroke="#d7edf5" stroke-width="2"/>
    ${nums.map((v, i) => {
      const bh = Math.max(8, (h - 56) * (v / max));
      const bx = x + gap * i + (gap - barW) / 2;
      const by = y + h - 32 - bh;
      return `
        <rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="11" fill="${colors[i % colors.length]}"/>
        <text x="${bx + barW / 2}" y="${Math.max(y + 28, by - 9)}" text-anchor="middle" font-size="16" font-weight="900" fill="#102033">${fmt(v)}</text>
        <text x="${bx + barW / 2}" y="${y + h - 10}" text-anchor="middle" font-size="14" font-weight="900" fill="#7e93a2">${lrSvgEscV3(labels[i] || '')}</text>
      `;
    }).join('')}
  `;
}

async function lrSafeRenderSingleV4(ch) {
  const history = await historyFor(ch.key, 'subscribers');
  const subValues = history.length ? history.map((x) => x.value) : [ch.subscribers, ch.subscribers];
  const subLabels = history.length ? history.map((x) => x.label) : ['старт', 'сейчас'];
  const avatar = await lrSafeAvatarV3(ch, 76, 136, 72, 0);
  const titleLines = lrSvgWrapV3(ch.title, 42, 2);
  const dateText = lrSvgEscV3(nowMskHuman());

  const inner = `
    <text x="52" y="64" font-size="40" font-weight="1000" fill="#ffffff">LinkRay Analytics</text>
    <text x="54" y="96" font-size="18" font-weight="900" fill="#d5edf2">карточка канала · реальные данные после подключения бота</text>

    <rect x="1000" y="38" width="218" height="56" rx="22" fill="rgba(255,255,255,.14)" stroke="rgba(126,248,225,.44)" stroke-width="2"/>
    <text x="1109" y="73" text-anchor="middle" font-size="22" font-weight="1000" fill="#31f2cc">1 КАНАЛ</text>

    ${lrMiniLogoV4(892, 40)}
    <text x="952" y="72" font-size="22" font-weight="1000" fill="#d9fbf6">LinkRay</text>

    <rect x="34" y="118" width="1212" height="492" rx="38" fill="rgba(255,255,255,.115)" stroke="rgba(126,248,225,.30)" stroke-width="2" filter="url(#lrShadowV4)"/>

    ${avatar}
    <text x="168" y="164" font-size="30" font-weight="1000" fill="#fff">${lrSvgEscV3(titleLines[0])}</text>
    ${titleLines[1] ? `<text x="168" y="199" font-size="30" font-weight="1000" fill="#fff">${lrSvgEscV3(titleLines[1])}</text>` : ''}
    <text x="170" y="229" font-size="18" font-weight="900" fill="#d1edf1">MAX-канал · отчёт сформирован LinkRay</text>

    ${lrMetricBoxV4(70, 262, 250, 96, 'Подписчики', fmt(ch.subscribers), '#27d9ff')}
    ${lrMetricBoxV4(342, 262, 250, 96, 'За сутки', `${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}`, ch.deltaDay < 0 ? '#ff7280' : '#31f2cc')}
    ${lrMetricBoxV4(614, 262, 250, 96, 'Охват 24ч', fmt(ch.views24), '#31f2cc')}
    ${lrMetricBoxV4(886, 262, 300, 96, 'ER24', pct(ch.er24), '#27d9ff')}

    <text x="70" y="406" font-size="26" font-weight="1000" fill="#fff">Динамика подписчиков</text>
    ${lrLineChartCompactV4(subValues, subLabels, 70, 426, 610, 140, ch.deltaDay < 0 ? '#ff7280' : '#31f2cc')}

    <text x="724" y="406" font-size="26" font-weight="1000" fill="#fff">Охваты</text>
    ${lrBarsCompactV4([ch.views24, ch.views48, ch.views72], ['24ч', '48ч', '72ч'], 724, 426, 462, 140)}

    <text x="70" y="648" font-size="22" font-weight="1000" fill="#ffffff">Просмотры: 24ч — ${fmt(ch.views24)} · 48ч — ${fmt(ch.views48)} · 72ч — ${fmt(ch.views72)}</text>
    <text x="70" y="682" font-size="18" font-weight="900" fill="#d8f2f4">Данные собираются LinkRay с момента добавления бота в канал</text>
    <text x="1210" y="682" text-anchor="end" font-size="18" font-weight="900" fill="#d8f2f4">Дата формирования: ${dateText} МСК</text>
  `;

  return lrSafeSaveSvgPngV3(lrSvgShellV4(inner), `lr-single-v4-${ch.key}`);
}

async function lrSafeRenderNetworkV4(channels) {
  const totalSubs = channels.reduce((s, ch) => s + num(ch.subscribers), 0);
  const total24 = channels.reduce((s, ch) => s + num(ch.views24), 0);
  const total48 = channels.reduce((s, ch) => s + num(ch.views48), 0);
  const total72 = channels.reduce((s, ch) => s + num(ch.views72), 0);
  const totalDelta = channels.reduce((s, ch) => s + num(ch.deltaDay), 0);
  const er24 = totalSubs ? (total24 / totalSubs) * 100 : 0;
  const history = await networkHistory(channels);
  const histValues = history.length ? history.map((x) => x.value) : [totalSubs, totalSubs];
  const histLabels = history.length ? history.map((x) => x.label) : ['старт', 'сейчас'];
  const sorted = channels.slice().sort((a, b) => num(b.views24) - num(a.views24)).slice(0, 4);
  const dateText = lrSvgEscV3(nowMskHuman());

  const rows = [];
  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i];
    const y = 433 + i * 42;
    const av = await lrSafeAvatarV3(ch, 718, y - 25, 32, i);
    rows.push(`
      ${av}
      <text x="762" y="${y}" font-size="21" font-weight="1000" fill="#102033">${lrSvgEscV3(lrSvgShortV3(ch.title, 24))}</text>
      <text x="1040" y="${y}" text-anchor="middle" font-size="22" font-weight="1000" fill="#168eea">${fmt(ch.subscribers)}</text>
      <text x="1158" y="${y}" text-anchor="middle" font-size="22" font-weight="1000" fill="#168eea">${fmt(ch.views24)}</text>
    `);
  }

  const inner = `
    <text x="52" y="64" font-size="40" font-weight="1000" fill="#ffffff">Статистика сети каналов</text>
    <text x="54" y="96" font-size="18" font-weight="900" fill="#d5edf2">LinkRay Analytics · сводка по ${channels.length} каналам</text>

    ${logoSvg}
    <text x="1084" y="72" font-size="24" font-weight="1000" fill="#d9fbf6">LinkRay</text>

    <rect x="34" y="118" width="1212" height="492" rx="38" fill="rgba(255,255,255,.115)" stroke="rgba(126,248,225,.30)" stroke-width="2" filter="url(#lrShadowV4)"/>

    ${lrMetricBoxV4(70, 154, 250, 96, 'Подписчики', fmt(totalSubs), '#27d9ff')}
    ${lrMetricBoxV4(342, 154, 250, 96, 'Просмотры 24ч', fmt(total24), '#31f2cc')}
    ${lrMetricBoxV4(614, 154, 250, 96, 'Средний ER', pct(er24), '#27d9ff')}
    ${lrMetricBoxV4(886, 154, 300, 96, 'Каналов', String(channels.length), '#31f2cc')}

    <text x="70" y="306" font-size="26" font-weight="1000" fill="#fff">График подписчиков</text>
    ${lrLineChartCompactV4(histValues, histLabels, 70, 326, 590, 210, totalDelta < 0 ? '#ff7280' : '#31f2cc')}

    <rect x="696" y="326" width="490" height="210" rx="22" fill="#f7fcff" stroke="#d7edf5" stroke-width="2"/>
    <text x="724" y="365" font-size="25" font-weight="1000" fill="#102033">Топ каналов</text>
    <text x="762" y="395" font-size="15" font-weight="1000" fill="#7d8e9d">Название</text>
    <text x="1040" y="395" text-anchor="middle" font-size="15" font-weight="1000" fill="#7d8e9d">ПДП</text>
    <text x="1158" y="395" text-anchor="middle" font-size="15" font-weight="1000" fill="#7d8e9d">24ч</text>
    <line x1="718" y1="405" x2="1168" y2="405" stroke="#dcebf2" stroke-width="2"/>
    ${rows.join('')}

    <text x="70" y="648" font-size="22" font-weight="1000" fill="#ffffff">Подписчики: ${fmt(totalSubs)} · Итог за сутки: ${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)}</text>
    <text x="70" y="682" font-size="18" font-weight="900" fill="#d8f2f4">Охваты: 24ч — ${fmt(total24)} · 48ч — ${fmt(total48)} · 72ч — ${fmt(total72)}</text>
    <text x="1210" y="682" text-anchor="end" font-size="18" font-weight="900" fill="#d8f2f4">Дата формирования: ${dateText} МСК</text>
  `;

  return lrSafeSaveSvgPngV3(lrSvgShellV4(inner), `lr-network-v4-${hash(channels.map((x) => x.key).join('-'))}`);
}
/* LR_COMPACT_ANALYTICS_CARD_V4_END */


/* LR_ANALYTICS_CARD_FOOTER_V5_START */

/* LR_REAL_LOGO_CARD_V6_START */
let __lrBrandLogoDataUrlV6 = '';

async function lrBrandLogoDataUrlV6(size = 76) {
  if (__lrBrandLogoDataUrlV6) return __lrBrandLogoDataUrlV6;

  const candidates = [
    'public/brand/linkray-logo.webp',
    '/app/public/brand/linkray-logo.webp',
    'public/brand/linkray-logo.png',
    '/app/public/brand/linkray-logo.png',
    'public/brand/linkray-logo.jpg',
    '/app/public/brand/linkray-logo.jpg',
    'public/brand/linkray-card-logo.jpg',
    '/app/public/brand/linkray-card-logo.jpg',
  ];

  for (const file of candidates) {
    try {
      const buf = await fs.readFile(file);
      const png = await sharp(buf)
        .resize(size, size, { fit: 'cover', position: 'centre' })
        .png()
        .toBuffer();

      __lrBrandLogoDataUrlV6 = `data:image/png;base64,${png.toString('base64')}`;
      return __lrBrandLogoDataUrlV6;
    } catch (_) {}
  }

  return '';
}

async function lrBrandLogoImageV6(x, y, size = 76) {
  const data = await lrBrandLogoDataUrlV6(size);

  if (!data) {
    return lrMiniLogoV4(x, y);
  }

  const clip = `lrRealLogoClip${x}_${y}_${size}`;
  return `
    <defs>
      <clipPath id="${clip}">
        <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/>
      </clipPath>
    </defs>
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 + 4}" fill="rgba(49,242,204,.14)" stroke="rgba(126,248,225,.65)" stroke-width="3"/>
    <image href="${data}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>
  `;
}
/* LR_REAL_LOGO_CARD_V6_END */

async function lrSafeRenderSingleV5(ch) {
  const history = await historyFor(ch.key, 'subscribers');
  const subValues = history.length ? history.map((x) => x.value) : [ch.subscribers, ch.subscribers];
  const subLabels = history.length ? history.map((x) => x.label) : ['старт', 'сейчас'];
  const avatar = await lrSafeAvatarV3(ch, 72, 132, 74, 0);
  const titleLines = lrSvgWrapV3(ch.title, 36, 2);
  const dateText = lrSvgEscV3(nowMskHuman());
  const logoSvg = await lrBrandLogoImageV6(900, 36, 68);

  const inner = `
    <text x="52" y="64" font-size="40" font-weight="1000" fill="#ffffff">LinkRay Analytics</text>
    <text x="54" y="96" font-size="18" font-weight="900" fill="#d5edf2">карточка канала · реальные данные после подключения бота</text>

    ${logoSvg}
    <text x="982" y="72" font-size="23" font-weight="1000" fill="#d9fbf6">LinkRay</text>
    <rect x="1080" y="38" width="145" height="56" rx="22" fill="rgba(255,255,255,.14)" stroke="rgba(126,248,225,.44)" stroke-width="2"/>
    <text x="1152" y="73" text-anchor="middle" font-size="21" font-weight="1000" fill="#31f2cc">1 КАНАЛ</text>

    <rect x="34" y="118" width="1212" height="486" rx="38" fill="rgba(255,255,255,.115)" stroke="rgba(126,248,225,.30)" stroke-width="2" filter="url(#lrShadowV4)"/>

    ${avatar}
    <text x="166" y="160" font-size="29" font-weight="1000" fill="#fff">${lrSvgEscV3(titleLines[0])}</text>
    ${titleLines[1] ? `<text x="166" y="194" font-size="29" font-weight="1000" fill="#fff">${lrSvgEscV3(titleLines[1])}</text>` : ''}
    <text x="168" y="224" font-size="18" font-weight="900" fill="#d1edf1">MAX-канал · отчёт сформирован LinkRay</text>

    ${lrMetricBoxV4(70, 258, 250, 96, 'Подписчики', fmt(ch.subscribers), '#27d9ff')}
    ${lrMetricBoxV4(342, 258, 250, 96, 'За сутки', `${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}`, ch.deltaDay < 0 ? '#ff7280' : '#31f2cc')}
    ${lrMetricBoxV4(614, 258, 250, 96, 'Охват 24ч', fmt(ch.views24), '#31f2cc')}
    ${lrMetricBoxV4(886, 258, 300, 96, 'ER24', pct(ch.er24), '#27d9ff')}

    <text x="70" y="398" font-size="25" font-weight="1000" fill="#fff">Динамика подписчиков</text>
    ${lrLineChartCompactV4(subValues, subLabels, 70, 418, 610, 138, ch.deltaDay < 0 ? '#ff7280' : '#31f2cc')}

    <text x="724" y="398" font-size="25" font-weight="1000" fill="#fff">Охваты</text>
    ${lrBarsCompactV4([ch.views24, ch.views48, ch.views72], ['24ч', '48ч', '72ч'], 724, 418, 462, 138)}

    <text x="70" y="638" font-size="21" font-weight="1000" fill="#ffffff">Просмотры: 24ч — ${fmt(ch.views24)} · 48ч — ${fmt(ch.views48)} · 72ч — ${fmt(ch.views72)}</text>
    <text x="70" y="671" font-size="17" font-weight="900" fill="#d8f2f4">Сбор данных начинается после добавления бота в канал</text>
    <text x="1210" y="704" text-anchor="end" font-size="17" font-weight="900" fill="#d8f2f4">Дата формирования: ${dateText} МСК</text>
  `;

  return lrSafeSaveSvgPngV3(lrSvgShellV4(inner), `lr-single-v5-${ch.key}`);
}

async function lrSafeRenderNetworkV5(channels) {
  const totalSubs = channels.reduce((s, ch) => s + num(ch.subscribers), 0);
  const total24 = channels.reduce((s, ch) => s + num(ch.views24), 0);
  const total48 = channels.reduce((s, ch) => s + num(ch.views48), 0);
  const total72 = channels.reduce((s, ch) => s + num(ch.views72), 0);
  const totalDelta = channels.reduce((s, ch) => s + num(ch.deltaDay), 0);
  const er24 = totalSubs ? (total24 / totalSubs) * 100 : 0;
  const history = await networkHistory(channels);
  const histValues = history.length ? history.map((x) => x.value) : [totalSubs, totalSubs];
  const histLabels = history.length ? history.map((x) => x.label) : ['старт', 'сейчас'];
  const sorted = channels.slice().sort((a, b) => num(b.views24) - num(a.views24)).slice(0, 4);
  const dateText = lrSvgEscV3(nowMskHuman());
  const logoSvg = await lrBrandLogoImageV6(1006, 36, 68);

  const rows = [];
  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i];
    const y = 428 + i * 40;
    const av = await lrSafeAvatarV3(ch, 718, y - 25, 32, i);
    rows.push(`
      ${av}
      <text x="762" y="${y}" font-size="20" font-weight="1000" fill="#102033">${lrSvgEscV3(lrSvgShortV3(ch.title, 24))}</text>
      <text x="1040" y="${y}" text-anchor="middle" font-size="21" font-weight="1000" fill="#168eea">${fmt(ch.subscribers)}</text>
      <text x="1158" y="${y}" text-anchor="middle" font-size="21" font-weight="1000" fill="#168eea">${fmt(ch.views24)}</text>
    `);
  }

  const inner = `
    <text x="52" y="64" font-size="40" font-weight="1000" fill="#ffffff">Статистика сети каналов</text>
    <text x="54" y="96" font-size="18" font-weight="900" fill="#d5edf2">LinkRay Analytics · сводка по ${channels.length} каналам</text>

    ${logoSvg}
    <text x="1084" y="72" font-size="24" font-weight="1000" fill="#d9fbf6">LinkRay</text>

    <rect x="34" y="118" width="1212" height="486" rx="38" fill="rgba(255,255,255,.115)" stroke="rgba(126,248,225,.30)" stroke-width="2" filter="url(#lrShadowV4)"/>

    ${lrMetricBoxV4(70, 154, 250, 96, 'Подписчики', fmt(totalSubs), '#27d9ff')}
    ${lrMetricBoxV4(342, 154, 250, 96, 'Просмотры 24ч', fmt(total24), '#31f2cc')}
    ${lrMetricBoxV4(614, 154, 250, 96, 'Средний ER', pct(er24), '#27d9ff')}
    ${lrMetricBoxV4(886, 154, 300, 96, 'Каналов', String(channels.length), '#31f2cc')}

    <text x="70" y="302" font-size="25" font-weight="1000" fill="#fff">График подписчиков</text>
    ${lrLineChartCompactV4(histValues, histLabels, 70, 322, 590, 208, totalDelta < 0 ? '#ff7280' : '#31f2cc')}

    <rect x="696" y="322" width="490" height="208" rx="22" fill="#f7fcff" stroke="#d7edf5" stroke-width="2"/>
    <text x="724" y="360" font-size="24" font-weight="1000" fill="#102033">Топ каналов</text>
    <text x="762" y="390" font-size="15" font-weight="1000" fill="#7d8e9d">Название</text>
    <text x="1040" y="390" text-anchor="middle" font-size="15" font-weight="1000" fill="#7d8e9d">ПДП</text>
    <text x="1158" y="390" text-anchor="middle" font-size="15" font-weight="1000" fill="#7d8e9d">24ч</text>
    <line x1="718" y1="400" x2="1168" y2="400" stroke="#dcebf2" stroke-width="2"/>
    ${rows.join('')}

    <text x="70" y="638" font-size="21" font-weight="1000" fill="#ffffff">Подписчики: ${fmt(totalSubs)} · Итог за сутки: ${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)}</text>
    <text x="70" y="671" font-size="17" font-weight="900" fill="#d8f2f4">Охваты: 24ч — ${fmt(total24)} · 48ч — ${fmt(total48)} · 72ч — ${fmt(total72)}</text>
    <text x="1210" y="704" text-anchor="end" font-size="17" font-weight="900" fill="#d8f2f4">Дата формирования: ${dateText} МСК</text>
  `;

  return lrSafeSaveSvgPngV3(lrSvgShellV4(inner), `lr-network-v5-${hash(channels.map((x) => x.key).join('-'))}`);
}
/* LR_ANALYTICS_CARD_FOOTER_V5_END */


/* LR_SINGLE_CHANNEL_INFO_CARD_V8_START */
function lrEscV8(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lrShortV8(value, max = 55) {
  const text = String(value || 'Канал MAX').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
}

function lrWrapV8(value, max = 45, limit = 2) {
  const words = String(value || 'Канал MAX').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }

    if (lines.length >= limit) break;
  }

  if (line && lines.length < limit) lines.push(line);
  if (!lines.length) lines.push('Канал MAX');

  return lines.slice(0, limit).map((x, i) => {
    if (i === limit - 1 && words.join(' ').length > lines.join(' ').length) {
      return lrShortV8(x, max);
    }
    return x;
  });
}

function lrSignV8(value) {
  const n = num(value);
  if (n > 0) return `+${fmt(n)}`;
  if (n < 0) return `-${fmt(Math.abs(n))}`;
  return '0';
}

function lrDeltaColorV8(value) {
  const n = num(value);
  if (n > 0) return '#28c76f';
  if (n < 0) return '#ea5455';
  return '#7b8796';
}

function lrTodayLabelV8() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
  });
}

async function lrImageDataV8(url, size = 72) {
  if (!url || !/^https?:\/\//i.test(String(url))) return '';

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4500) });
    if (!res.ok) return '';

    const buf = Buffer.from(await res.arrayBuffer());
    const png = await sharp(buf)
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();

    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return '';
  }
}

async function lrLocalLogoDataV8(size = 70) {
  const candidates = [
    'public/brand/linkray-logo.webp',
    '/app/public/brand/linkray-logo.webp',
    'public/brand/linkray-logo.png',
    '/app/public/brand/linkray-logo.png',
    'public/brand/linkray-card-logo.jpg',
    '/app/public/brand/linkray-card-logo.jpg',
  ];

  for (const file of candidates) {
    try {
      const buf = await fs.readFile(file);
      const png = await sharp(buf)
        .resize(size, size, { fit: 'cover', position: 'centre' })
        .png()
        .toBuffer();

      return `data:image/png;base64,${png.toString('base64')}`;
    } catch {}
  }

  return '';
}

async function lrAvatarSvgV8(ch, x, y, size = 64) {
  const data = await lrImageDataV8(ch.avatarUrl || ch.avatar_url || ch.photo_url || ch.image_url || '', size);
  const clip = `lrAvV8_${hash(String(ch.key || ch.link || ch.title || '') + x + y + size)}`;

  if (data) {
    return `
      <clipPath id="${clip}"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath>
      <image href="${data}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>
      <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 - 1}" fill="none" stroke="#31f2cc" stroke-width="3"/>
    `;
  }

  const letter = lrEscV8(String(ch.title || 'К').trim().slice(0, 1).toUpperCase() || 'К');

  return `
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="#0b91d8"/>
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 - 1}" fill="none" stroke="#31f2cc" stroke-width="3"/>
    <text x="${x + size / 2}" y="${y + size / 2 + size * .14}" text-anchor="middle" font-size="${Math.round(size * .45)}" font-weight="1000" fill="#fff">${letter}</text>
  `;
}

async function lrLogoSvgV8(x, y, size = 64) {
  const data = await lrLocalLogoDataV8(size);
  const clip = `lrLogoV8_${size}`;

  if (data) {
    return `
      <clipPath id="${clip}"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath>
      <image href="${data}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>
    `;
  }

  return `
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="#16d6c8"/>
    <text x="${x + size / 2}" y="${y + size / 2 + 8}" text-anchor="middle" font-size="28" font-weight="1000" fill="#fff">LR</text>
  `;
}

async function lrHistoryRowsV8(channelKey, currentSubscribers, fallbackDelta) {
  const result = await query(`
    WITH daily AS (
      SELECT
        to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day_key,
        to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'DD.MM') AS label,
        subscribers,
        captured_at,
        row_number() OVER (
          PARTITION BY to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD')
          ORDER BY captured_at DESC
        ) AS rn
      FROM public.lr_channel_analytics_snapshots
      WHERE channel_key=$1
    )
    SELECT day_key, label, subscribers
    FROM daily
    WHERE rn=1
    ORDER BY day_key ASC
    LIMIT 31
  `, [channelKey]).catch(() => []);

  const arr = rows(result).map((r) => ({
    label: String(r.label || ''),
    subscribers: num(r.subscribers),
    delta: 0,
  })).filter((r) => r.label);

  if (!arr.length) {
    arr.push({
      label: lrTodayLabelV8(),
      subscribers: num(currentSubscribers),
      delta: num(fallbackDelta),
    });
  }

  for (let i = 0; i < arr.length; i++) {
    if (i === 0) {
      arr[i].delta = arr.length === 1 ? num(fallbackDelta) : 0;
    } else {
      arr[i].delta = num(arr[i].subscribers) - num(arr[i - 1].subscribers);
    }
  }

  return arr;
}

function lrCardShellV8(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900" viewBox="0 0 1280 900">
    <defs>
      <linearGradient id="lrLightBgV8" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#f5f8fb"/>
        <stop offset="55%" stop-color="#eef5f7"/>
        <stop offset="100%" stop-color="#e8fbf5"/>
      </linearGradient>
      <linearGradient id="lrAccentV8" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0b8cff"/>
        <stop offset="100%" stop-color="#31f2cc"/>
      </linearGradient>
      <filter id="lrShadowV8" x="-10%" y="-10%" width="120%" height="130%">
        <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#0b2740" flood-opacity=".13"/>
      </filter>
      <style>
        text { font-family: DejaVu Sans, Arial, sans-serif; }
      </style>
    </defs>
    <rect width="1280" height="900" fill="url(#lrLightBgV8)"/>
    <circle cx="1110" cy="60" r="260" fill="#31f2cc" opacity=".08"/>
    <circle cx="90" cy="860" r="260" fill="#0b8cff" opacity=".06"/>
    ${inner}
  </svg>`;
}

function lrInfoCardV8(x, y, w, h, title, rowsHtml) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="#ffffff" stroke="#dde9ee" stroke-width="2" filter="url(#lrShadowV8)"/>
    <text x="${x + 26}" y="${y + 52}" font-size="25" font-weight="1000" fill="#637181">${lrEscV8(title)}</text>
    ${rowsHtml}
  `;
}

function lrLineChartSingleV8(points, x, y, w, h) {
  let arr = points.slice(-10);
  if (!arr.length) arr = [{ label: lrTodayLabelV8(), subscribers: 0 }];

  let values = arr.map((p) => num(p.subscribers));
  if (values.length === 1) {
    arr = [
      { label: 'старт', subscribers: values[0] },
      { label: arr[0].label, subscribers: values[0] },
    ];
    values = arr.map((p) => num(p.subscribers));
  }

  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min = Math.max(0, min - 1);
    max += 1;
  }

  const padL = 82;
  const padR = 45;
  const padT = 58;
  const padB = 54;
  const span = Math.max(1, max - min);

  const coords = arr.map((p, i) => {
    const px = x + padL + (w - padL - padR) * (i / Math.max(1, arr.length - 1));
    const py = y + padT + (h - padT - padB) * (1 - ((num(p.subscribers) - min) / span));
    return [px, py, num(p.subscribers), p.label];
  });

  const d = coords.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L ${x + w - padR},${y + h - padB} L ${x + padL},${y + h - padB} Z`;

  const grid = [0, 1, 2, 3].map((i) => {
    const yy = y + padT + (h - padT - padB) * (i / 3);
    return `<line x1="${x + padL}" y1="${yy}" x2="${x + w - padR}" y2="${yy}" stroke="#e5edf2" stroke-width="1"/>`;
  }).join('');

  const dots = coords.map((p, i) => {
    const show = i === 0 || i === coords.length - 1 || coords.length <= 6 || i % 2 === 0;
    return `
      <circle cx="${p[0]}" cy="${p[1]}" r="7" fill="#ffffff" stroke="#25c978" stroke-width="4"/>
      ${show ? `<text x="${p[0]}" y="${Math.max(y + 42, p[1] - 14)}" text-anchor="middle" font-size="18" font-weight="1000" fill="#25c978">${fmt(p[2])}</text>` : ''}
      <text x="${p[0]}" y="${y + h - 18}" text-anchor="middle" font-size="16" font-weight="800" fill="#7b8796">${lrEscV8(p[3])}</text>
    `;
  }).join('');

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="#ffffff" stroke="#dde9ee" stroke-width="2" filter="url(#lrShadowV8)"/>
    <circle cx="${x + w / 2 - 75}" cy="${y + 44}" r="9" fill="#25c978"/>
    <text x="${x + w / 2 - 50}" y="${y + 52}" font-size="24" font-weight="1000" fill="#283342">Подписчики</text>
    ${grid}
    <path d="${area}" fill="#25c978" opacity=".12"/>
    <path d="${d}" fill="none" stroke="#25c978" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  `;
}

function lrDayRowV8(x, y, label, subscribers, delta) {
  return `
    <text x="${x}" y="${y}" font-size="22" font-weight="800" fill="#111827">${lrEscV8(label)}</text>
    <text x="${x + 125}" y="${y}" font-size="22" font-weight="1000" fill="#2f80ed">${fmt(subscribers)}</text>
    <text x="${x + 270}" y="${y}" font-size="22" font-weight="1000" fill="${lrDeltaColorV8(delta)}">${lrSignV8(delta)}</text>
  `;
}

async function lrSafeRenderSingleV8(ch) {
  const history = await lrHistoryRowsV8(ch.key, ch.subscribers, ch.deltaDay);
  const last = history[history.length - 1] || { subscribers: ch.subscribers, delta: ch.deltaDay };

  const todayDelta = num(last.delta);
  const weekBase = history.length > 7 ? history[history.length - 8].subscribers : history[0].subscribers;
  const monthBase = history.length > 30 ? history[history.length - 31].subscribers : history[0].subscribers;

  const weekDelta = num(last.subscribers) - num(weekBase);
  const monthDelta = num(last.subscribers) - num(monthBase);

  const viewsPost = Math.max(num(ch.views24), num(ch.views48), num(ch.views72));
  const avatarSvg = await lrAvatarSvgV8(ch, 36, 28, 62);
  const logoSvg = await lrLogoSvgV8(1070, 26, 64);
  const title = lrWrapV8(ch.title, 45, 2);
  const last10 = history.slice(-10).reverse();

  const dayRows = [];
  for (let i = 0; i < 10; i++) {
    const r = last10[i] || { label: '—', subscribers: 0, delta: 0 };
    dayRows.push(lrDayRowV8(888, 191 + i * 54, r.label, r.subscribers, r.delta));
  }

  const inner = `
    ${avatarSvg}
    <text x="116" y="59" font-size="32" font-weight="1000" fill="#05070a">${lrEscV8(title[0])}</text>
    ${title[1] ? `<text x="116" y="96" font-size="32" font-weight="1000" fill="#05070a">${lrEscV8(title[1])}</text>` : ''}

    ${logoSvg}
    <text x="1146" y="66" font-size="32" font-weight="1000" fill="#2f80ed">LinkRay</text>

    ${lrInfoCardV8(32, 126, 405, 222, 'Подписчиков', `
      <text x="385" y="180" text-anchor="end" font-size="42" font-weight="1000" fill="#2f80ed">${fmt(ch.subscribers)}</text>
      <text x="58" y="226" font-size="25" font-weight="800" fill="#6b7280">Сегодня</text>
      <text x="385" y="226" text-anchor="end" font-size="34" font-weight="1000" fill="${lrDeltaColorV8(todayDelta)}">${lrSignV8(todayDelta)}</text>
      <text x="58" y="276" font-size="25" font-weight="800" fill="#6b7280">За неделю</text>
      <text x="385" y="276" text-anchor="end" font-size="34" font-weight="1000" fill="${lrDeltaColorV8(weekDelta)}">${lrSignV8(weekDelta)}</text>
      <text x="58" y="326" font-size="25" font-weight="800" fill="#6b7280">За месяц</text>
      <text x="385" y="326" text-anchor="end" font-size="34" font-weight="1000" fill="${lrDeltaColorV8(monthDelta)}">${lrSignV8(monthDelta)}</text>
    `)}

    ${lrInfoCardV8(455, 126, 405, 222, 'Просмотров на пост', `
      <text x="806" y="180" text-anchor="end" font-size="42" font-weight="1000" fill="#2f80ed">${fmt(viewsPost)}</text>
      <text x="481" y="226" font-size="25" font-weight="800" fill="#6b7280">Просмотров за 24ч</text>
      <text x="806" y="226" text-anchor="end" font-size="34" font-weight="1000" fill="#25c978">${fmt(ch.views24)}</text>
      <text x="481" y="276" font-size="25" font-weight="800" fill="#6b7280">Просмотров за 48ч</text>
      <text x="806" y="276" text-anchor="end" font-size="34" font-weight="1000" fill="#25c978">${fmt(ch.views48)}</text>
      <text x="481" y="326" font-size="25" font-weight="800" fill="#6b7280">ER24</text>
      <text x="806" y="326" text-anchor="end" font-size="34" font-weight="1000" fill="#2f80ed">${pct(ch.er24)}</text>
    `)}

    <rect x="880" y="126" width="368" height="592" rx="22" fill="#ffffff" stroke="#dde9ee" stroke-width="2" filter="url(#lrShadowV8)"/>
    <text x="910" y="174" font-size="25" font-weight="1000" fill="#283342">День</text>
    <text x="1015" y="174" font-size="25" font-weight="1000" fill="#283342">ПДП</text>
    <text x="1155" y="174" font-size="25" font-weight="1000" fill="#283342">Прирост</text>
    <line x1="906" y1="188" x2="1220" y2="188" stroke="#e5edf2" stroke-width="2"/>
    ${dayRows.join('')}

    ${lrLineChartSingleV8(history, 32, 374, 828, 344)}

    <text x="36" y="786" font-size="24" font-weight="1000" fill="#111827">LinkRay Analytics — данные канала после подключения бота</text>
    <text x="1248" y="850" text-anchor="end" font-size="23" font-weight="900" fill="#6b7280">Дата формирования отчёта: ${lrEscV8(nowMskHuman())} МСК</text>
  `;

  return lrSafeSaveSvgPngV3(lrCardShellV8(inner), `lr-single-info-v8-${ch.key}`);
}
/* LR_SINGLE_CHANNEL_INFO_CARD_V8_END */


/* LR_SINGLE_CHANNEL_DARK_CARD_V9_START */
function lrEscV9(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lrShortV9(value, max = 52) {
  const text = String(value || 'Канал MAX').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
}

function lrWrapV9(value, max = 39, limit = 2) {
  const text = String(value || 'Канал MAX').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
    if (lines.length >= limit) break;
  }

  if (line && lines.length < limit) lines.push(line);
  if (!lines.length) lines.push('Канал MAX');

  return lines.slice(0, limit).map((x) => lrShortV9(x, max));
}

function lrSignV9(value) {
  const n = num(value);
  if (n > 0) return `+${fmt(n)}`;
  if (n < 0) return `-${fmt(Math.abs(n))}`;
  return '0';
}

function lrDeltaColorV9(value) {
  const n = num(value);
  if (n > 0) return '#38f29b';
  if (n < 0) return '#ff6377';
  return '#a8b6c6';
}

function lrTodayLabelV9() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
  });
}

async function lrDataImageV9(url, size = 80) {
  if (!url || !/^https?:\/\//i.test(String(url))) return '';

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4500) });
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    const png = await sharp(buf)
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();

    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return '';
  }
}

async function lrLocalLogoDataV9(size = 74) {
  const candidates = [
    'public/brand/linkray-logo.webp',
    '/app/public/brand/linkray-logo.webp',
    'public/brand/linkray-logo.png',
    '/app/public/brand/linkray-logo.png',
    'public/brand/linkray-card-logo.jpg',
    '/app/public/brand/linkray-card-logo.jpg',
  ];

  for (const file of candidates) {
    try {
      const buf = await fs.readFile(file);
      const png = await sharp(buf)
        .resize(size, size, { fit: 'cover', position: 'centre' })
        .png()
        .toBuffer();

      return `data:image/png;base64,${png.toString('base64')}`;
    } catch {}
  }

  return '';
}

async function lrAvatarV9(ch, x, y, size = 72) {
  const url = ch.avatarUrl || ch.avatar_url || ch.photo_url || ch.image_url || '';
  const data = await lrDataImageV9(url, size);
  const clip = `lrAvV9_${hash(String(ch.key || ch.link || ch.title || '') + x + y + size)}`;
  const letter = lrEscV9(String(ch.title || 'К').trim().slice(0, 1).toUpperCase() || 'К');

  if (data) {
    return `
      <defs><clipPath id="${clip}"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath></defs>
      <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 + 4}" fill="rgba(49,242,204,.18)" stroke="rgba(49,242,204,.72)" stroke-width="3"/>
      <image href="${data}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>
    `;
  }

  return `
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 + 4}" fill="rgba(49,242,204,.18)" stroke="rgba(49,242,204,.72)" stroke-width="3"/>
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="#0b8cff"/>
    <text x="${x + size / 2}" y="${y + size / 2 + 12}" text-anchor="middle" font-size="34" font-weight="1000" fill="#fff">${letter}</text>
  `;
}

async function lrLogoV9(x, y, size = 74) {
  const data = await lrLocalLogoDataV9(size);
  const clip = `lrLogoV9_${size}`;

  if (data) {
    return `
      <defs><clipPath id="${clip}"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath></defs>
      <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 + 5}" fill="rgba(49,242,204,.14)" stroke="rgba(49,242,204,.60)" stroke-width="3"/>
      <image href="${data}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>
    `;
  }

  return `
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="#31f2cc"/>
    <text x="${x + size / 2}" y="${y + size / 2 + 10}" text-anchor="middle" font-size="28" font-weight="1000" fill="#061625">LR</text>
  `;
}

async function lrHistoryRowsV9(channelKey, currentSubscribers, fallbackDelta) {
  const result = await query(`
    WITH daily AS (
      SELECT
        to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day_key,
        to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'DD.MM') AS label,
        subscribers,
        captured_at,
        row_number() OVER (
          PARTITION BY to_char(captured_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD')
          ORDER BY captured_at DESC
        ) AS rn
      FROM public.lr_channel_analytics_snapshots
      WHERE channel_key=$1
    )
    SELECT day_key, label, subscribers
    FROM daily
    WHERE rn=1
    ORDER BY day_key ASC
    LIMIT 31
  `, [channelKey]).catch(() => []);

  const arr = rows(result).map((r) => ({
    label: String(r.label || ''),
    subscribers: num(r.subscribers),
    delta: 0,
  })).filter((r) => r.label);

  if (!arr.length) {
    arr.push({
      label: lrTodayLabelV9(),
      subscribers: num(currentSubscribers),
      delta: num(fallbackDelta),
    });
  }

  for (let i = 0; i < arr.length; i++) {
    if (i === 0) {
      arr[i].delta = arr.length === 1 ? num(fallbackDelta) : 0;
    } else {
      arr[i].delta = num(arr[i].subscribers) - num(arr[i - 1].subscribers);
    }
  }

  return arr;
}

function lrCardShellV9(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900" viewBox="0 0 1280 900">
    <defs>
      <linearGradient id="lrBgV9" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#061625"/>
        <stop offset="45%" stop-color="#082b3c"/>
        <stop offset="100%" stop-color="#0db77b"/>
      </linearGradient>
      <radialGradient id="lrGlowV9" cx="86%" cy="4%" r="78%">
        <stop offset="0%" stop-color="#72ffc8" stop-opacity=".34"/>
        <stop offset="62%" stop-color="#31f2cc" stop-opacity=".10"/>
        <stop offset="100%" stop-color="#31f2cc" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="lrCardV9" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,.16)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,.08)"/>
      </linearGradient>
      <linearGradient id="lrLineV9" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#27d9ff"/>
        <stop offset="100%" stop-color="#31f2cc"/>
      </linearGradient>
      <filter id="lrShadowV9" x="-10%" y="-10%" width="120%" height="130%">
        <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#00111b" flood-opacity=".30"/>
      </filter>
      <style>
        text { font-family: DejaVu Sans, Arial, sans-serif; }
      </style>
    </defs>

    <rect width="1280" height="900" fill="url(#lrBgV9)"/>
    <rect width="1280" height="900" fill="url(#lrGlowV9)"/>
    <path d="M-80 170 C220 75 420 210 650 105 C890 -5 1060 135 1350 48" fill="none" stroke="rgba(255,255,255,.075)" stroke-width="3"/>
    <path d="M-60 795 C260 650 505 770 740 650 C980 530 1100 650 1340 560" fill="none" stroke="rgba(255,255,255,.055)" stroke-width="3"/>
    ${inner}
  </svg>`;
}

function lrGlassCardV9(x, y, w, h) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="28" fill="url(#lrCardV9)" stroke="rgba(126,248,225,.30)" stroke-width="2" filter="url(#lrShadowV9)"/>`;
}

function lrStatRowV9(x, y, label, value, color = '#e9fbff', size = 30) {
  return `
    <text x="${x}" y="${y}" font-size="24" font-weight="900" fill="#b9cbd7">${lrEscV9(label)}</text>
    <text x="${x + 312}" y="${y}" text-anchor="end" font-size="${size}" font-weight="1000" fill="${color}">${lrEscV9(value)}</text>
  `;
}

function lrDaysTableV9(rowsData) {
  const rowsSvg = [];

  for (let i = 0; i < 10; i++) {
    const r = rowsData[i] || { label: '—', subscribers: 0, delta: 0 };
    const y = 218 + i * 47;
    rowsSvg.push(`
      <text x="910" y="${y}" font-size="21" font-weight="900" fill="#e9fbff">${lrEscV9(r.label)}</text>
      <text x="1032" y="${y}" text-anchor="middle" font-size="21" font-weight="1000" fill="#27d9ff">${fmt(r.subscribers)}</text>
      <text x="1162" y="${y}" text-anchor="middle" font-size="21" font-weight="1000" fill="${lrDeltaColorV9(r.delta)}">${lrSignV9(r.delta)}</text>
      ${i < 9 ? `<line x1="902" y1="${y + 14}" x2="1195" y2="${y + 14}" stroke="rgba(255,255,255,.08)" stroke-width="1"/>` : ''}
    `);
  }

  return `
    ${lrGlassCardV9(878, 132, 348, 596)}
    <text x="910" y="184" font-size="24" font-weight="1000" fill="#ffffff">День</text>
    <text x="1032" y="184" text-anchor="middle" font-size="24" font-weight="1000" fill="#ffffff">ПДП</text>
    <text x="1162" y="184" text-anchor="middle" font-size="24" font-weight="1000" fill="#ffffff">Прирост</text>
    <line x1="902" y1="195" x2="1195" y2="195" stroke="rgba(126,248,225,.24)" stroke-width="2"/>
    ${rowsSvg.join('')}
  `;
}

function lrLineChartV9(points, x, y, w, h) {
  let arr = points.slice(-10);
  if (!arr.length) arr = [{ label: lrTodayLabelV9(), subscribers: 0 }];

  let values = arr.map((p) => num(p.subscribers));

  if (values.length === 1) {
    arr = [
      { label: 'старт', subscribers: values[0] },
      { label: arr[0].label, subscribers: values[0] },
    ];
    values = arr.map((p) => num(p.subscribers));
  }

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    min = Math.max(0, min - 1);
    max += 1;
  }

  const padL = 62;
  const padR = 34;
  const padT = 64;
  const padB = 50;
  const span = Math.max(1, max - min);

  const coords = arr.map((p, i) => {
    const px = x + padL + (w - padL - padR) * (i / Math.max(1, arr.length - 1));
    const py = y + padT + (h - padT - padB) * (1 - ((num(p.subscribers) - min) / span));
    return [px, py, num(p.subscribers), p.label];
  });

  const d = coords.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L ${x + w - padR},${y + h - padB} L ${x + padL},${y + h - padB} Z`;

  const grid = [0, 1, 2, 3].map((i) => {
    const yy = y + padT + (h - padT - padB) * (i / 3);
    return `<line x1="${x + padL}" y1="${yy}" x2="${x + w - padR}" y2="${yy}" stroke="rgba(255,255,255,.10)" stroke-width="1"/>`;
  }).join('');

  const dots = coords.map((p, i) => {
    const showLabel = i === 0 || i === coords.length - 1 || coords.length <= 6 || i % 2 === 0;
    return `
      <circle cx="${p[0]}" cy="${p[1]}" r="7" fill="#061625" stroke="#31f2cc" stroke-width="4"/>
      ${showLabel ? `<text x="${p[0]}" y="${Math.max(y + 42, p[1] - 13)}" text-anchor="middle" font-size="17" font-weight="1000" fill="#31f2cc">${fmt(p[2])}</text>` : ''}
      <text x="${p[0]}" y="${y + h - 18}" text-anchor="middle" font-size="15" font-weight="900" fill="#a7bdc9">${lrEscV9(p[3])}</text>
    `;
  }).join('');

  return `
    ${lrGlassCardV9(x, y, w, h)}
    <circle cx="${x + w / 2 - 86}" cy="${y + 42}" r="8" fill="#31f2cc"/>
    <text x="${x + w / 2 - 62}" y="${y + 51}" font-size="24" font-weight="1000" fill="#ffffff">Подписчики</text>
    ${grid}
    <path d="${area}" fill="#31f2cc" opacity=".13"/>
    <path d="${d}" fill="none" stroke="rgba(49,242,204,.20)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="url(#lrLineV9)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  `;
}

async function lrSafeRenderSingleV9(ch) {
  const history = await lrHistoryRowsV9(ch.key, ch.subscribers, ch.deltaDay);
  const last = history[history.length - 1] || { subscribers: ch.subscribers, delta: ch.deltaDay };

  const todayDelta = num(last.delta);
  const weekBase = history.length > 7 ? history[history.length - 8].subscribers : history[0].subscribers;
  const monthBase = history.length > 30 ? history[history.length - 31].subscribers : history[0].subscribers;
  const weekDelta = num(last.subscribers) - num(weekBase);
  const monthDelta = num(last.subscribers) - num(monthBase);

  const viewsPost = Math.max(num(ch.views24), num(ch.views48), num(ch.views72));
  const titleLines = lrWrapV9(ch.title, 42, 2);
  const avatarSvg = await lrAvatarV9(ch, 42, 34, 72);
  const logoSvg = await lrLogoV9(1010, 34, 70);
  const last10 = history.slice(-10).reverse();

  const inner = `
    ${avatarSvg}
    <text x="136" y="63" font-size="34" font-weight="1000" fill="#ffffff">${lrEscV9(titleLines[0])}</text>
    ${titleLines[1] ? `<text x="136" y="101" font-size="34" font-weight="1000" fill="#ffffff">${lrEscV9(titleLines[1])}</text>` : ''}
    ${logoSvg}
    <text x="1098" y="78" font-size="33" font-weight="1000" fill="#d9fbf6">LinkRay</text>

    ${lrGlassCardV9(36, 132, 396, 240)}
    <text x="68" y="178" font-size="26" font-weight="1000" fill="#ffffff">Подписчиков</text>
    ${lrStatRowV9(68, 228, 'Всего', fmt(ch.subscribers), '#27d9ff', 36)}
    ${lrStatRowV9(68, 277, 'Сегодня', lrSignV9(todayDelta), lrDeltaColorV9(todayDelta), 32)}
    ${lrStatRowV9(68, 326, 'За неделю', lrSignV9(weekDelta), lrDeltaColorV9(weekDelta), 32)}
    ${lrStatRowV9(68, 358, 'За месяц', lrSignV9(monthDelta), lrDeltaColorV9(monthDelta), 32)}

    ${lrGlassCardV9(456, 132, 396, 240)}
    <text x="488" y="178" font-size="26" font-weight="1000" fill="#ffffff">Просмотров на пост</text>
    ${lrStatRowV9(488, 228, 'Всего', fmt(viewsPost), '#27d9ff', 36)}
    ${lrStatRowV9(488, 277, 'За 24ч', fmt(ch.views24), '#31f2cc', 32)}
    ${lrStatRowV9(488, 326, 'За 48ч', fmt(ch.views48), '#31f2cc', 32)}
    ${lrStatRowV9(488, 358, 'ER24', pct(ch.er24), '#27d9ff', 32)}

    ${lrDaysTableV9(last10)}

    ${lrLineChartV9(history, 36, 406, 816, 322)}

    <text x="42" y="800" font-size="23" font-weight="1000" fill="#ffffff">LinkRay Analytics — данные собираются после подключения бота к каналу</text>
    <text x="1218" y="850" text-anchor="end" font-size="22" font-weight="900" fill="#cde9ef">Дата формирования отчёта: ${lrEscV9(nowMskHuman())} МСК</text>
  `;

  return lrSafeSaveSvgPngV3(lrCardShellV9(inner), `lr-single-dark-v9-${ch.key}`);
}
/* LR_SINGLE_CHANNEL_DARK_CARD_V9_END */

async function renderSingleSvg(ch) {
  const avatar = await lrSvgAvatar(ch, 84, 214, 92, 1);
  const history = await historyFor(ch.key, 'subscribers');
  const subValues = history.length ? history.map((x) => x.value) : [ch.subscribers, ch.subscribers];
  const subLabels = history.length ? history.map((x) => x.label) : ['сейчас', 'сейчас'];

  const title = lrCardClip(ch.title, 64);

  const svg = `
${lrBaseSvgStart()}
${await lrHeaderSvg('1 КАНАЛ')}

<rect x="40" y="175" width="1520" height="720" rx="44" fill="rgba(255,255,255,.105)" stroke="rgba(111,255,229,.28)" stroke-width="2" filter="url(#shadow)"/>

${avatar}
<text x="200" y="252" font-size="42" font-weight="900" fill="#fff">${lrCardEsc(title)}</text>
<text x="202" y="292" font-size="24" font-weight="900" fill="#c4d9e4">карточка канала · данные LinkRay</text>

${lrMetricSvg(84, 340, 330, 145, 'Подписчики', fmt(ch.subscribers), '#24d9ff')}
${lrMetricSvg(442, 340, 330, 145, 'Сегодня', `${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}`, ch.deltaDay < 0 ? '#ff7280' : '#27e6c7')}
${lrMetricSvg(800, 340, 330, 145, 'Охват 24ч', fmt(ch.views24), '#27e6c7')}
${lrMetricSvg(1158, 340, 350, 145, 'ER24', pct(ch.er24), '#24d9ff')}

<rect x="84" y="525" width="938" height="320" rx="30" fill="#f8fcff" stroke="#dcecf3" stroke-width="2"/>
<text x="128" y="580" font-size="31" font-weight="900" fill="#102033">Динамика подписчиков</text>
<text x="128" y="615" font-size="21" font-weight="900" fill="#6d7f90">реальный график по ежедневным замерам</text>
${lrChartSvg(subValues, subLabels, 128, 640, 850, 170, ch.deltaDay < 0 ? '#ff7280' : '#27e6c7')}

<rect x="1050" y="525" width="458" height="320" rx="30" fill="#f8fcff" stroke="#dcecf3" stroke-width="2"/>
<text x="1092" y="580" font-size="31" font-weight="900" fill="#102033">Охваты поста</text>
<text x="1092" y="615" font-size="21" font-weight="900" fill="#6d7f90">последние замеры MAX</text>
${lrBarsSvg([ch.views24, ch.views48, ch.views72], ['24ч', '48ч', '72ч'], 1090, 638, 378, 160)}

<text x="88" y="878" font-size="25" font-weight="900" fill="#fff">Просмотры: 24ч — ${fmt(ch.views24)} · 48ч — ${fmt(ch.views48)} · 72ч — ${fmt(ch.views72)}  |  ER24 — ${pct(ch.er24)}</text>

${lrFooterSvg()}
</svg>`;

  return saveSvgPng(svg, `single-${ch.key}`);
}


/* LR_NETWORK_15_CHANNELS_V7_START */
function lrSvgShellNetworkV7(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900" viewBox="0 0 1280 900">
    <defs>
      <linearGradient id="lrNetBgV7" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#061426"/>
        <stop offset="44%" stop-color="#0b3147"/>
        <stop offset="100%" stop-color="#12a06f"/>
      </linearGradient>
      <radialGradient id="lrNetGlowV7" cx="86%" cy="12%" r="72%">
        <stop offset="0%" stop-color="#65ffc0" stop-opacity=".45"/>
        <stop offset="64%" stop-color="#31f2cc" stop-opacity=".12"/>
        <stop offset="100%" stop-color="#31f2cc" stop-opacity="0"/>
      </radialGradient>
      <filter id="lrNetShadowV7" x="-10%" y="-10%" width="120%" height="130%">
        <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#00111b" flood-opacity=".34"/>
      </filter>
      <style>
        text { font-family: DejaVu Sans, Arial, sans-serif; }
      </style>
    </defs>
    <rect width="1280" height="900" fill="url(#lrNetBgV7)"/>
    <rect width="1280" height="900" fill="url(#lrNetGlowV7)"/>
    <path d="M-40 150 C220 70 420 215 640 110 C900 -15 1060 145 1320 50" fill="none" stroke="rgba(255,255,255,.065)" stroke-width="3"/>
    <path d="M-30 760 C260 630 510 760 740 640 C980 520 1110 650 1320 560" fill="none" stroke="rgba(255,255,255,.055)" stroke-width="3"/>
    ${inner}
  </svg>`;
}

function lrMetricBoxNetV7(x, y, w, h, label, value, color = '#31f2cc') {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="rgba(255,255,255,.13)" stroke="rgba(126,248,225,.34)" stroke-width="2"/>
    <text x="${x + w / 2}" y="${y + 31}" text-anchor="middle" font-size="17" font-weight="900" fill="#d7eef2">${lrSvgEscV3(label)}</text>
    <text x="${x + w / 2}" y="${y + 82}" text-anchor="middle" font-size="38" font-weight="1000" fill="${color}">${lrSvgEscV3(value)}</text>
  `;
}

async function lrSafeRenderNetworkV7(channels) {
  const totalSubs = channels.reduce((s, ch) => s + num(ch.subscribers), 0);
  const total24 = channels.reduce((s, ch) => s + num(ch.views24), 0);
  const total48 = channels.reduce((s, ch) => s + num(ch.views48), 0);
  const total72 = channels.reduce((s, ch) => s + num(ch.views72), 0);
  const totalDelta = channels.reduce((s, ch) => s + num(ch.deltaDay), 0);
  const er24 = totalSubs ? (total24 / totalSubs) * 100 : 0;

  const history = await networkHistory(channels);
  const histValues = history.length ? history.map((x) => x.value) : [totalSubs, totalSubs];
  const histLabels = history.length ? history.map((x) => x.label) : ['старт', 'сейчас'];

  const sorted = channels
    .slice()
    .sort((a, b) => num(b.views24) - num(a.views24))
    .slice(0, 15);

  const dateText = lrSvgEscV3(nowMskHuman());
  const logoSvg = await lrBrandLogoImageV6(1000, 42, 70);

  const rows = [];
  for (let i = 0; i < sorted.length; i++) {
    rows.push(await lrNetworkRowV7(sorted[i], 696, 386 + i * 30, i));
  }

  const moreCount = Math.max(0, channels.length - 15);
  const moreText = moreCount > 0
    ? `<text x="1182" y="846" text-anchor="end" font-size="18" font-weight="1000" fill="#31f2cc">+ ещё ${moreCount} каналов</text>`
    : '';

  const inner = `
    <text x="52" y="68" font-size="42" font-weight="1000" fill="#ffffff">Статистика сети каналов</text>
    <text x="54" y="101" font-size="19" font-weight="900" fill="#d5edf2">LinkRay Analytics · сводка по ${channels.length} каналам</text>

    ${logoSvg}
    <text x="1086" y="78" font-size="26" font-weight="1000" fill="#d9fbf6">LinkRay</text>

    <rect x="34" y="124" width="1212" height="638" rx="38" fill="rgba(255,255,255,.115)" stroke="rgba(126,248,225,.30)" stroke-width="2" filter="url(#lrNetShadowV7)"/>

    ${lrMetricBoxNetV7(70, 160, 250, 96, 'Подписчики', fmt(totalSubs), '#27d9ff')}
    ${lrMetricBoxNetV7(342, 160, 250, 96, 'Просмотры 24ч', fmt(total24), '#31f2cc')}
    ${lrMetricBoxNetV7(614, 160, 250, 96, 'Средний ER', pct(er24), '#27d9ff')}
    ${lrMetricBoxNetV7(886, 160, 300, 96, 'Каналов', String(channels.length), '#31f2cc')}

    <text x="70" y="314" font-size="27" font-weight="1000" fill="#fff">График подписчиков</text>
    ${lrLineChartCompactV4(histValues, histLabels, 70, 340, 590, 300, totalDelta < 0 ? '#ff7280' : '#31f2cc')}

    <rect x="682" y="308" width="520" height="402" rx="24" fill="#f7fcff" stroke="#d7edf5" stroke-width="2"/>
    <text x="712" y="350" font-size="27" font-weight="1000" fill="#102033">Каналы сети</text>
    <text x="742" y="374" font-size="14" font-weight="1000" fill="#7d8e9d">Название</text>
    <text x="1051" y="374" text-anchor="middle" font-size="14" font-weight="1000" fill="#7d8e9d">ПДП</text>
    <text x="1154" y="374" text-anchor="middle" font-size="14" font-weight="1000" fill="#7d8e9d">24ч</text>
    <line x1="696" y1="379" x2="1182" y2="379" stroke="#dcebf2" stroke-width="2"/>
    ${rows.join('')}

    <text x="70" y="805" font-size="23" font-weight="1000" fill="#ffffff">Подписчики: ${fmt(totalSubs)} · Итог за сутки: ${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)}</text>
    <text x="70" y="837" font-size="18" font-weight="900" fill="#d8f2f4">Охваты: 24ч — ${fmt(total24)} · 48ч — ${fmt(total48)} · 72ч — ${fmt(total72)}</text>
    ${moreText}
    <text x="1210" y="875" text-anchor="end" font-size="18" font-weight="900" fill="#d8f2f4">Дата формирования: ${dateText} МСК</text>
  `;

  return lrSafeSaveSvgPngV3(lrSvgShellNetworkV7(inner), `lr-network-v7-${hash(channels.map((x) => x.key).join('-'))}`);
}
/* LR_NETWORK_15_CHANNELS_V7_END */












/* LR_NETWORK_FIXED_V14_START */
function lrV14Esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lrV14NormalizeLink(link) {
  return String(link || '')
    .trim()
    .replace(/[.,;!?]+$/g, '')
    .replace(/^http:\/\//i, 'https://')
    .replace(/^https:\/\/www\./i, 'https://')
    .replace(/\/+$/g, '');
}

function lrV14UniqueLinks(list) {
  const out = [];
  const seen = new Set();

  for (const raw of Array.isArray(list) ? list : []) {
    const link = lrV14NormalizeLink(raw);
    if (!/^https:\/\/max\.ru\//i.test(link)) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    out.push(link);
  }

  return out;
}

function lrV14LinksFromText(text) {
  const matches = String(text || '').match(/https?:\/\/(?:www\.)?max\.ru\/[^\s<>"')\]}]+/gi) || [];
  return lrV14UniqueLinks(matches);
}

function lrV14DirectText(update, text = '') {
  return [
    text,
    update?.message?.body?.text,
    update?.message?.text,
    update?.body?.text,
    update?.text,
    update?.message?.caption,
    update?.caption,
  ].filter(Boolean).map(String).join('\n');
}

function lrV14LinksDeep(update) {
  const found = [];

  function walk(node, depth = 0) {
    if (depth > 8 || node === null || node === undefined) return;

    if (typeof node === 'string' || typeof node === 'number') {
      found.push(...lrV14LinksFromText(String(node)));
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    if (typeof node === 'object') {
      for (const value of Object.values(node)) walk(value, depth + 1);
    }
  }

  walk(update);
  return lrV14UniqueLinks(found);
}

function lrV14ForceLinks(update, links) {
  const direct = lrV14LinksFromText(lrV14DirectText(update, typeof getText === 'function' ? getText(update) : ''));
  const deep = lrV14LinksDeep(update);
  const arg = lrV14UniqueLinks(links);

  if (direct.length >= 2) return direct;
  return lrV14UniqueLinks([...direct, ...arg, ...deep]);
}

function lrV14Short(value, max = 20) {
  const text = String(value || 'MAX-канал').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max).trim() + '…';
}

function lrV14Compact(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  const v = Math.round(n);
  if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 0 : 1).replace('.', ',') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace('.', ',') + 'k';
  return String(v);
}

function lrV14Metric(x, y, w, label, value, color = '#27d9ff') {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="118" rx="24" fill="rgba(255,255,255,.115)" stroke="rgba(126,248,225,.30)" stroke-width="2" filter="url(#lrV14Shadow)"/>
    <text x="${x + w / 2}" y="${y + 36}" text-anchor="middle" font-size="20" font-weight="1000" fill="#d6edf2">${lrV14Esc(label)}</text>
    <text x="${x + w / 2}" y="${y + 88}" text-anchor="middle" font-size="48" font-weight="1000" fill="${color}">${lrV14Esc(value)}</text>
  `;
}

function lrV14Views(x, y, total24, total48, total72) {
  return `
    <rect x="${x}" y="${y}" width="300" height="300" rx="28" fill="rgba(255,255,255,.115)" stroke="rgba(126,248,225,.30)" stroke-width="2" filter="url(#lrV14Shadow)"/>
    <text x="${x + 34}" y="${y + 58}" font-size="33" font-weight="1000" fill="#ffffff">Просмотры</text>

    <text x="${x + 38}" y="${y + 126}" font-size="38" font-weight="1000" fill="#ffffff">24ч:</text>
    <text x="${x + 158}" y="${y + 126}" font-size="40" font-weight="1000" fill="#27d9ff">${lrV14Esc(fmt(total24))}</text>

    <text x="${x + 38}" y="${y + 198}" font-size="38" font-weight="1000" fill="#ffffff">48ч:</text>
    <text x="${x + 158}" y="${y + 198}" font-size="40" font-weight="1000" fill="#27d9ff">${lrV14Esc(fmt(total48))}</text>

    <text x="${x + 38}" y="${y + 270}" font-size="38" font-weight="1000" fill="#ffffff">72ч:</text>
    <text x="${x + 158}" y="${y + 270}" font-size="40" font-weight="1000" fill="#27d9ff">${lrV14Esc(fmt(total72))}</text>
  `;
}

async function lrV14Logo(x, y, size = 74) {
  if (typeof lrLogoV9 === 'function') return await lrLogoV9(x, y, size);
  if (typeof lrBrandLogoImageV6 === 'function') return await lrBrandLogoImageV6(x, y, size);

  return `
    <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="#31f2cc"/>
    <text x="${x + size / 2}" y="${y + size / 2 + 10}" text-anchor="middle" font-size="28" font-weight="1000" fill="#061625">LR</text>
  `;
}


/* LR_MULTI_AVATAR_CACHE_V26_START */
const lrV26AvatarMemo = new Map();

function lrV26NormLink(value) {
  return String(value || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

function lrV26GoodAvatarUrl(value) {
  const s = String(value || '').trim();
  return /^https?:\/\//i.test(s) && !s.includes('/s/img/og-logo.png');
}

async function lrV26GetCachedAvatar(link) {
  const key = lrV26NormLink(link);
  if (!key) return '';

  if (lrV26AvatarMemo.has(key)) return lrV26AvatarMemo.get(key);

  try {
    const db = await import('./db.js');
    const result = await db.query(
      `SELECT avatar_url
         FROM public.lr_channel_avatar_cache
        WHERE link_norm=$1 OR link=$2
        ORDER BY updated_at DESC
        LIMIT 1`,
      [key, String(link || '').trim()]
    );

    const rows = Array.isArray(result) ? result : (result?.rows || []);
    const avatar = String(rows?.[0]?.avatar_url || '').trim();

    if (lrV26GoodAvatarUrl(avatar)) {
      lrV26AvatarMemo.set(key, avatar);
      return avatar;
    }
  } catch {}

  lrV26AvatarMemo.set(key, '');
  return '';
}
/* LR_MULTI_AVATAR_CACHE_V26_END */

async function lrV14Avatar(ch, x, y, size = 42, idx = 0) {
  /* LR_MULTI_AVATAR_LOOKUP_V26_START */
  try {
    const linkForAvatar =
      ch?.link ||
      ch?.url ||
      ch?.key ||
      ch?.channel_link ||
      ch?.public_link ||
      ch?.source_link ||
      '';

    const cachedAvatar = await lrV26GetCachedAvatar(linkForAvatar);

    if (cachedAvatar) {
      ch.avatar_url = cachedAvatar;
      ch.avatarUrl = cachedAvatar;
      ch.photo_url = cachedAvatar;
      ch.image_url = cachedAvatar;
      ch.avatar = cachedAvatar;
    }
  } catch {}
  /* LR_MULTI_AVATAR_LOOKUP_V26_END */

  const url = lrV19AvatarUrl(ch);

  if (url && /^https?:\/\//i.test(url)) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: {
          'user-agent': 'Mozilla/5.0 LinkRayBot/1.0',
          'accept': 'image/*,*/*;q=0.8',
        },
      });

      if (response.ok) {
        const type = response.headers.get('content-type') || 'image/jpeg';
        const buf = Buffer.from(await response.arrayBuffer());
        const data = `data:${type};base64,${buf.toString('base64')}`;
        const clipId = `lrAvClip${idx}_${hash(url).replace(/[^a-z0-9]/gi, '')}`;

        return `
          <defs>
            <clipPath id="${clipId}">
              <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 - 2}"/>
            </clipPath>
          </defs>
          <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="rgba(49,242,204,.22)" stroke="#31f2cc" stroke-width="3"/>
          <image href="${data}" x="${x + 3}" y="${y + 3}" width="${size - 6}" height="${size - 6}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>
        `;
      }
    } catch {}
  }

  return lrV19AvatarFallback(ch, x, y, size, idx);
}

function lrV14Slug(link, idx) {
  return `Канал ${idx + 1}`;
}


/* LR_NETWORK_ROW_LAYOUT_V18_START */
function lrV18CleanNetworkTitle(value, idx = 0) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();

  if (!text || /^https?:\/\//i.test(text) || /^max\.ru/i.test(text) || /^join\//i.test(text)) {
    return `Канал ${idx + 1}`;
  }

  if (text.includes('|')) {
    const first = text.split('|')[0].trim();
    if (first.length >= 8) text = first;
  }

  if (text.length > 22) text = text.slice(0, 22).trim() + '…';
  return text;
}
/* LR_NETWORK_ROW_LAYOUT_V18_END */

async function lrV14Row(ch, x, y, idx) {
  const avatar = await lrV14Avatar(ch, x, y - 31, 42, idx);
  const titleRaw = ch._lrTitle || ch.title || lrV14Slug(ch.link || ch.key, idx);
  const cleanTitle = lrV18CleanNetworkTitle(titleRaw, idx);
  const title = lrV14Esc(cleanTitle);
  const clipId = `lrNetTitleClip${idx}`;

  return `
    <g>
      <clipPath id="${clipId}">
        <rect x="${x + 58}" y="${y - 34}" width="360" height="48" rx="3"/>
      </clipPath>

      ${avatar}

      <text
        x="${x + 58}"
        y="${y}"
        clip-path="url(#${clipId})"
        font-size="24"
        font-weight="1000"
        fill="#ffffff"
      >${title}</text>

      <text
        x="${x + 520}"
        y="${y}"
        text-anchor="end"
        font-size="25"
        font-weight="1000"
        fill="#27d9ff"
      >${lrV14Esc(fmt(ch.subscribers))}</text>

      <text
        x="${x + 650}"
        y="${y}"
        text-anchor="end"
        font-size="25"
        font-weight="1000"
        fill="#31f2cc"
      >${lrV14Esc(fmt(ch.views24))}</text>

      ${idx < 3 ? `<line x1="${x}" y1="${y + 24}" x2="${x + 662}" y2="${y + 24}" stroke="rgba(255,255,255,.09)" stroke-width="1"/>` : ''}
    </g>
  `;
}

function lrV14Shell(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900" viewBox="0 0 1280 900">
    <defs>
      <linearGradient id="lrV14Bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#061625"/>
        <stop offset="48%" stop-color="#082b3c"/>
        <stop offset="100%" stop-color="#0db77b"/>
      </linearGradient>
      <radialGradient id="lrV14Glow" cx="88%" cy="5%" r="82%">
        <stop offset="0%" stop-color="#72ffc8" stop-opacity=".34"/>
        <stop offset="62%" stop-color="#31f2cc" stop-opacity=".10"/>
        <stop offset="100%" stop-color="#31f2cc" stop-opacity="0"/>
      </radialGradient>
      <filter id="lrV14Shadow" x="-10%" y="-10%" width="120%" height="130%">
        <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#00111b" flood-opacity=".30"/>
      </filter>
      <style>
        text { font-family: DejaVu Sans, Arial, sans-serif; }
      </style>
    </defs>

    <rect width="1280" height="900" fill="url(#lrV14Bg)"/>
    <rect width="1280" height="900" fill="url(#lrV14Glow)"/>
    <path d="M-80 168 C220 76 420 210 650 106 C890 -4 1060 136 1350 50" fill="none" stroke="rgba(255,255,255,.075)" stroke-width="3"/>
    <path d="M-60 792 C260 650 505 770 740 650 C980 530 1100 650 1340 560" fill="none" stroke="rgba(255,255,255,.055)" stroke-width="3"/>
    ${inner}
  </svg>`;
}

async function lrSafeRenderNetworkV14(channels) {
  const all = [];
  const seen = new Set();

  for (const ch of Array.isArray(channels) ? channels : []) {
    const key = lrV14NormalizeLink(ch?.link || ch?.key || ch?.title || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    all.push(ch);
  }

  const titleCounts = new Map();
  for (const ch of all) {
    const t = String(ch.title || '').trim();
    if (!t) continue;
    titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
  }

  for (let i = 0; i < all.length; i++) {
    const t = String(all[i].title || '').trim();
    if (!t || titleCounts.get(t) > 1) {
      all[i]._lrTitle = `Канал ${i + 1}`;
    }
  }

  const totalSubs = all.reduce((sum, ch) => sum + num(ch.subscribers), 0);
  const total24 = all.reduce((sum, ch) => sum + num(ch.views24), 0);
  const total48 = all.reduce((sum, ch) => sum + num(ch.views48), 0);
  const total72 = all.reduce((sum, ch) => sum + num(ch.views72), 0);
  const er24 = totalSubs ? (total24 / totalSubs) * 100 : 0;

  const visible = all.slice().sort((a, b) => num(b.views24) - num(a.views24)).slice(0, 4);
  lrV19DedupeNetworkAvatars(visible);
  const logo = await lrV14Logo(1018, 34, 74);

  const rows = [];
  for (let i = 0; i < visible.length; i++) {
    rows.push(await lrV14Row(visible[i], 470, 470 + i * 74, i));
  }

  const note = all.length > 4
    ? `Показано 4 из ${all.length}. Суммы рассчитаны по всем каналам.`
    : `Суммы рассчитаны по всем каналам.`;

  const inner = `
    <text x="54" y="74" font-size="49" font-weight="1000" fill="#ffffff">Статистика сети каналов</text>
    <text x="56" y="112" font-size="21" font-weight="900" fill="#d5edf2">LinkRay Analytics · сводка по всей сетке каналов</text>

    ${logo}
    <text x="1114" y="83" font-size="34" font-weight="1000" fill="#d9fbf6">LinkRay</text>

    ${lrV14Metric(54, 156, 274, 'Подписчики', lrV14Compact(totalSubs), '#27d9ff')}
    ${lrV14Metric(352, 156, 274, 'Просмотры 24ч', lrV14Compact(total24), '#31f2cc')}
    ${lrV14Metric(650, 156, 274, 'Общий ER', pct(er24), '#27d9ff')}
    ${lrV14Metric(948, 156, 274, 'Каналов', String(all.length), '#31f2cc')}

    ${lrV14Views(54, 330, total24, total48, total72)}

    <rect x="390" y="330" width="832" height="430" rx="28" fill="rgba(255,255,255,.115)" stroke="rgba(126,248,225,.28)" stroke-width="2" filter="url(#lrV14Shadow)"/>
    <text x="424" y="388" font-size="35" font-weight="1000" fill="#ffffff">Каналы</text>

    <text x="528" y="428" font-size="18" font-weight="1000" fill="#a9c2ce">Канал</text>
    <text x="990" y="428" text-anchor="end" font-size="18" font-weight="1000" fill="#a9c2ce">ПДП</text>
    <text x="1120" y="428" text-anchor="end" font-size="18" font-weight="1000" fill="#a9c2ce">24ч</text>
    <line x1="470" y1="442" x2="1132" y2="442" stroke="rgba(126,248,225,.20)" stroke-width="2"/>

    ${rows.join('')}

    <text x="470" y="735" font-size="21" font-weight="1000" fill="#31f2cc">${lrV14Esc(note)}</text>

    <text x="54" y="838" font-size="25" font-weight="1000" fill="#ffffff">Актуально на ${lrV14Esc(nowMskHuman())} МСК</text>
    <text x="1218" y="838" text-anchor="end" font-size="22" font-weight="900" fill="#cde9ef">LinkRay — аналитика каналов MAX</text>
  `;

  return lrSafeSaveSvgPngV3(lrV14Shell(inner), `lr-network-v14-${Date.now()}-${hash(all.map((x) => x.link || x.key || x.title).join('-'))}`);
}
/* LR_NETWORK_FIXED_V14_END */

async function renderNetworkSvg(channels) {
  const totalSubs = channels.reduce((sum, ch) => sum + ch.subscribers, 0);
  const total24 = channels.reduce((sum, ch) => sum + ch.views24, 0);
  const total48 = channels.reduce((sum, ch) => sum + ch.views48, 0);
  const total72 = channels.reduce((sum, ch) => sum + ch.views72, 0);
  const totalDelta = channels.reduce((sum, ch) => sum + ch.deltaDay, 0);
  const er24 = totalSubs ? (total24 / totalSubs) * 100 : 0;
  const history = await networkHistory(channels);
  const histValues = history.length ? history.map((x) => x.value) : [totalSubs, totalSubs];
  const histLabels = history.length ? history.map((x) => x.label) : ['сейчас', 'сейчас'];
  const sorted = [...channels].sort((a, b) => b.views24 - a.views24).slice(0, 5);

  const rows = [];
  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i];
    const y = 624 + i * 45;
    const av = await lrSvgAvatar(ch, 835, y - 22, 36, i);
    rows.push(`
      ${av}
      <text x="885" y="${y}" font-size="23" font-weight="900" fill="#102033">${lrCardEsc(lrCardShort(ch.title, 34))}</text>
      <text x="1245" y="${y}" font-size="25" font-weight="900" text-anchor="middle" fill="#168eea">${fmt(ch.subscribers)}</text>
      <text x="1454" y="${y}" font-size="25" font-weight="900" text-anchor="middle" fill="#168eea">${fmt(ch.views24)}</text>
    `);
  }

  const svg = `
${lrBaseSvgStart()}
${await lrHeaderSvg('СЕТКА КАНАЛОВ')}

<rect x="40" y="175" width="1520" height="720" rx="44" fill="rgba(255,255,255,.105)" stroke="rgba(111,255,229,.28)" stroke-width="2" filter="url(#shadow)"/>

<text x="84" y="238" font-size="52" font-weight="900" fill="#fff">Статистика по всей сетке каналов</text>
<text x="86" y="278" font-size="25" font-weight="900" fill="#c4d9e4">сводка по ${channels.length} каналам · только накопленные данные LinkRay</text>

${lrMetricSvg(84, 320, 330, 145, 'Подписчики', fmt(totalSubs), '#24d9ff')}
${lrMetricSvg(442, 320, 330, 145, 'Просмотры 24ч', fmt(total24), '#27e6c7')}
${lrMetricSvg(800, 320, 330, 145, 'Средний ER', pct(er24), '#24d9ff')}
${lrMetricSvg(1158, 320, 350, 145, 'Каналов', String(channels.length), '#27e6c7')}

<rect x="84" y="505" width="704" height="340" rx="30" fill="#f8fcff" stroke="#dcecf3" stroke-width="2"/>
<text x="126" y="560" font-size="31" font-weight="900" fill="#102033">Общий график подписчиков</text>
<text x="126" y="595" font-size="21" font-weight="900" fill="#6d7f90">рост и падение по всем каналам</text>
${lrChartSvg(histValues, histLabels, 126, 620, 620, 170, totalDelta < 0 ? '#ff7280' : '#27e6c7')}

<rect x="814" y="505" width="694" height="340" rx="30" fill="#f8fcff" stroke="#dcecf3" stroke-width="2"/>
<text x="852" y="560" font-size="31" font-weight="900" fill="#102033">Каналы</text>
<text x="852" y="595" font-size="20" font-weight="900" fill="#6d7f90">аватарки подтягиваются из MAX/данных канала</text>
<text x="885" y="623" font-size="18" font-weight="900" fill="#7c8d9e">Название</text>
<text x="1245" y="623" font-size="18" font-weight="900" text-anchor="middle" fill="#7c8d9e">ПДП</text>
<text x="1454" y="623" font-size="18" font-weight="900" text-anchor="middle" fill="#7c8d9e">24ч</text>
${rows.join('')}

<text x="88" y="878" font-size="25" font-weight="900" fill="#fff">Всего подписчиков: ${fmt(totalSubs)}  |  Просмотры: 24ч — ${fmt(total24)} · 48ч — ${fmt(total48)} · 72ч — ${fmt(total72)}</text>

${lrFooterSvg()}
</svg>`;

  return saveSvgPng(svg, `network-${hash(channels.map((c) => c.key).join('-'))}`);
}

function lrAnalyticsCaptionSingle(ch) {
  return (
    '━━━━━━━━━━━━━━\n' +
    '📊 <b>LinkRay Analytics</b>\n' +
    `${esc(ch.title)}\n\n` +
    `👥 <b>Подписчики:</b> ${fmt(ch.subscribers)}\n` +
    `📈 <b>За сутки:</b> ${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}\n\n` +
    '👁 <b>Просмотры:</b>\n' +
    `├ 24 часа: <b>${fmt(ch.views24)}</b>\n` +
    `├ 48 часов: <b>${fmt(ch.views48)}</b>\n` +
    `└ 72 часа: <b>${fmt(ch.views72)}</b>\n\n` +
    `📊 <b>ER24:</b> ${pct(ch.er24)}\n` +
    `🕒 <b>Сформировано:</b> ${esc(nowMskHuman())} МСК\n` +
    '━━━━━━━━━━━━━━\n' +
    `✨ <a href="${BOT_LINK}">LinkRay</a> — автопостинг и аналитика рекламных размещений в MAX`
  );
}

function lrAnalyticsCaptionNetwork(channels) {
  const totalSubs = channels.reduce((sum, ch) => sum + ch.subscribers, 0);
  const total24 = channels.reduce((sum, ch) => sum + ch.views24, 0);
  const total48 = channels.reduce((sum, ch) => sum + ch.views48, 0);
  const total72 = channels.reduce((sum, ch) => sum + ch.views72, 0);
  const signed = channels.reduce((sum, ch) => sum + Math.max(0, ch.deltaDay), 0);
  const lost = channels.reduce((sum, ch) => sum + Math.abs(Math.min(0, ch.deltaDay)), 0);
  const delta = channels.reduce((sum, ch) => sum + ch.deltaDay, 0);
  const er24 = totalSubs ? (total24 / totalSubs) * 100 : 0;

  const list = channels
    .slice()
    .sort((a, b) => b.views24 - a.views24)
    .slice(0, 5)
    .map((ch, i) => `${i + 1}) ${esc(lrCardShort(ch.title, 34))}: <b>${fmt(ch.views24)}</b> просмотров`)
    .join('\n');

  return (
    '━━━━━━━━━━━━━━\n' +
    '📊 <b>LinkRay Analytics</b>\n' +
    `Сводка по сети: <b>${channels.length}</b> каналов\n\n` +
    `👥 <b>Всего подписчиков:</b> ${fmt(totalSubs)}\n` +
    `✅ <b>Подписалось:</b> ${fmt(signed)}\n` +
    `➖ <b>Отписалось:</b> ${fmt(lost)}\n` +
    `📈 <b>Итог за сутки:</b> ${delta > 0 ? '+' : ''}${fmt(delta)}\n\n` +
    '👁 <b>Просмотры:</b>\n' +
    `├ 24 часа: <b>${fmt(total24)}</b>\n` +
    `├ 48 часов: <b>${fmt(total48)}</b>\n` +
    `└ 72 часа: <b>${fmt(total72)}</b>\n\n` +
    `📊 <b>Средний ER24:</b> ${pct(er24)}\n\n` +
    `${list}\n\n` +
    `🕒 <b>Сформировано:</b> ${esc(nowMskHuman())} МСК\n` +
    '━━━━━━━━━━━━━━\n' +
    `✨ <a href="${BOT_LINK}">LinkRay</a> — автопостинг и аналитика рекламных размещений в MAX`
  );
}

function lrDeepObjects(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) lrDeepObjects(item, out);
    return out;
  }
  out.push(node);
  for (const value of Object.values(node)) lrDeepObjects(value, out);
  return out;
}

function lrDeepPickString(obj, keys) {
  const set = new Set(keys.map((x) => String(x).toLowerCase()));

  for (const item of lrDeepObjects(obj)) {
    for (const [k, v] of Object.entries(item)) {
      if (!set.has(String(k).toLowerCase())) continue;
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }

  return '';
}

function lrExtractPreviewMap(update, links) {
  const map = new Map();

  for (const link of links) {
    map.set(link, {});
  }

  for (const obj of lrDeepObjects(update)) {
    const strings = Object.values(obj).filter((v) => typeof v === 'string');
    const joined = strings.join(' ');

    for (const link of links) {
      if (!joined.includes(link)) continue;

      const title =
        lrDeepPickString(obj, ['title', 'name', 'chat_title', 'channel_title', 'display_name']) ||
        '';

      const desc =
        lrDeepPickString(obj, ['description', 'subtitle', 'caption', 'text']) ||
        '';

      const avatar =
        lrDeepPickString(obj, ['avatar_url', 'photo_url', 'image_url', 'icon_url', 'picture_url', 'thumbnail_url', 'preview_url', 'avatar', 'photo', 'image']) ||
        '';

      const prev = map.get(link) || {};

      map.set(link, {
        ...prev,
        title: title && !title.includes('http') ? title : prev.title,
        name: title && !title.includes('http') ? title : prev.name,
        description: desc && !desc.includes('http') ? desc : prev.description,
        avatar_url: /^https?:\/\//i.test(avatar) ? avatar : prev.avatar_url,
        image_url: /^https?:\/\//i.test(avatar) ? avatar : prev.image_url,
      });
    }
  }

  return map;
}
/* LR_ANALYTICS_CARDS_V2_END */

async function renderSingle(ch) {
  return lrSafeRenderSingleV9(ch);
}

async function renderNetwork(channels) {
  return lrSafeRenderNetworkV14(channels);
}

async function renderPng(html, name) {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const fileName = `${name}-${Date.now()}.png`;
  const filePath = path.join(OUT_DIR, fileName);

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="675">
    <foreignObject width="1080" height="675">
      ${html.replace('<!doctype html>', '').replace(/<html[^>]*>|<\/html>|<head[\s\S]*?<\/head>|<body>|<\/body>/g, '')}
    </foreignObject>
  </svg>`;

  await sharp(Buffer.from(svg)).png().toFile(filePath);

  const publicUrl = `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/generated/channel-analytics/${fileName}`;

  return { filePath, publicUrl };
}

async function sendImage(chatId, image, caption) {
  const text = caption || 'LinkRay Analytics';

  try {
    await sendMaxMessage({
      chatId,
      text,
      format: 'html',
      attachments: [
        {
          type: 'image',
          payload: {
            url: image.publicUrl,
          },
        },
      ],
    });
  } catch (error) {
    console.error('[LinkRay channel analytics send image]', error.message || error);

    await sendMaxMessage({
      chatId,
      text: `${text}\n\n${image.publicUrl}`,
      format: 'html',
    });
  }
}

async function saveUserLinks(chatId, links) {
  await ensureTables();

  await query(
    `
    INSERT INTO public.lr_channel_analytics_settings(chat_id, links, updated_at)
    VALUES($1, $2::jsonb, now())
    ON CONFLICT(chat_id)
    DO UPDATE SET links=$2::jsonb, updated_at=now()
    `,
    [String(chatId), JSON.stringify(links)]
  );
}

async function setDaily(chatId, enabled) {
  await ensureTables();

  await query(
    `
    INSERT INTO public.lr_channel_analytics_settings(chat_id, daily_enabled, updated_at)
    VALUES($1, $2, now())
    ON CONFLICT(chat_id)
    DO UPDATE SET daily_enabled=$2, updated_at=now()
    `,
    [String(chatId), Boolean(enabled)]
  );
}

async function handleLinks(chatId, links, update = null) {
  await saveUserLinks(chatId, links);

  const previewMap = lrExtractPreviewMap(update || {}, links);
  const channels = [];

  for (const link of links) {
    const ch = await resolveChannel(link, previewMap.get(link) || {});
    channels.push(ch);
  }

  const image = channels.length === 1
    ? await renderSingle(channels[0])
    : await renderNetwork(channels);

  const caption = channels.length === 1
    ? lrAnalyticsCaptionSingle(channels[0])
    : lrAnalyticsCaptionNetwork(channels);

  await sendImage(chatId, image, caption);
}

async function sendDailyForRow(row) {
  const chatId = String(row.chat_id);
  const links = Array.isArray(row.links) ? row.links : [];

  if (!links.length) return;

  const channels = [];

  for (const link of links) {
    channels.push(await resolveChannel(link, { _lrIndex: channels.length }));
  }

  const image = channels.length === 1
    ? await renderSingle(channels[0])
    : await renderNetwork(channels);

  const caption = channels.length === 1
    ? lrAnalyticsCaptionSingle(channels[0])
    : lrAnalyticsCaptionNetwork(channels);

  await sendImage(chatId, image, caption);
}

async function runDailyWorkerOnce() {
  await ensureTables();

  const result = await query(
    `
    SELECT *
    FROM public.lr_channel_analytics_settings
    WHERE daily_enabled=true
      AND jsonb_array_length(links) > 0
    `
  ).catch(() => []);

  for (const row of rows(result)) {
    try {
      await sendDailyForRow(row);
    } catch (error) {
      console.error('[LinkRay channel analytics daily]', error.message || error);
    }
  }
}

function startDailyWorker() {
  if (dailyStarted) return;
  dailyStarted = true;

  setInterval(async () => {
    const t = mskHourMinute();

    if (t.hour !== 8 || t.minute > 3) return;
    if (lastDailyKey === t.key) return;

    lastDailyKey = t.key;

    await runDailyWorkerOnce();
  }, 60_000);

  console.log('[LinkRay channel analytics] daily worker mounted');
}








/* LR_ANALYTICS_LINK_ROUTE_V4 */
function lrMenuButtons(rows) {
  return [{
    type: 'inline_keyboard',
    payload: { buttons: rows },
  }];
}

function lrCb(text, payload) {
  return { type: 'callback', text, payload };
}

function lrNormText(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s:/._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function lrDeepStrings(value, out = []) {
  if (value === null || value === undefined) return out;

  if (typeof value === 'string') {
    out.push(value);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) lrDeepStrings(item, out);
    return out;
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value)) lrDeepStrings(item, out);
  }

  return out;
}

function lrPayloadDeep(update) {
  const direct = getPayload(update);

  if (direct) return direct;

  const strings = lrDeepStrings(update);

  return strings.find((s) =>
    /^(main:analytics|analytics:menu|lrchan:menu|lrchan:links|lrchan:daily|lrchan:on|lrchan:off|main:menu)$/.test(String(s))
  ) || '';
}

function lrLinksDeep(update, text) {
  const links = new Set(extractMaxLinks(text));

  for (const s of lrDeepStrings(update)) {
    for (const link of extractMaxLinks(s)) links.add(link);
  }

  return [...links];
}

function lrOnlyMaxLinksText(text, links) {
  let t = String(text || '').trim();

  if (!links.length) return false;

  for (const link of links) {
    t = t.replaceAll(link, ' ');
  }

  t = t
    .replace(/https?:\/\/max\.ru\/?\.{0,3}/gi, ' ')
    .replace(/[,;|\n\r\t\s]+/g, ' ')
    .trim();

  return !t;
}


function lrIsStartText(text) {
  const raw = String(text || '').trim().toLowerCase();

  return (
    raw === '/start' ||
    raw.startsWith('/start ') ||
    raw === 'start' ||
    raw === 'старт' ||
    raw === 'главное меню' ||
    raw === 'меню'
  );
}

function lrIsAnalyticsText(text) {
  const t = lrNormText(text);

  return (
    t === 'аналитика' ||
    t === 'linkray analytics' ||
    t === 'статистика' ||
    t === 'стата' ||
    t === 'аналитика каналов'
  );
}

function lrIdentityKeys(update, chatId) {
  const values = [
    chatId,
    update?.message?.recipient?.chat_id,
    update?.message?.chat_id,
    update?.message?.chat?.id,
    update?.callback?.message?.recipient?.chat_id,
    update?.callback?.message?.chat_id,
    update?.callback?.chat_id,
    update?.message?.sender?.user_id,
    update?.message?.sender?.id,
    update?.sender?.user_id,
    update?.sender?.id,
    update?.callback?.user_id,
    update?.callback?.sender?.user_id,
    update?.user_id,
  ];

  return [...new Set(values.filter(Boolean).map((x) => String(x)))];
}

async function ensureAnalyticsMenuTables() {
  await ensureTables();

  await query(`
    ALTER TABLE public.lr_channel_analytics_settings
    ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT ''
  `).catch(() => {});
}

async function setAnalyticsModeForKeys(keys, mode) {
  await ensureAnalyticsMenuTables();

  for (const key of keys) {
    await query(
      `
      INSERT INTO public.lr_channel_analytics_settings(chat_id, mode, updated_at)
      VALUES($1, $2, now())
      ON CONFLICT(chat_id)
      DO UPDATE SET mode=$2, updated_at=now()
      `,
      [String(key), String(mode || '')]
    ).catch(() => {});
  }
}

async function getAnalyticsSettingsForKeys(keys) {
  await ensureAnalyticsMenuTables();

  for (const key of keys) {
    const result = await query(
      `SELECT *
         FROM public.lr_channel_analytics_settings
        WHERE chat_id=$1
        LIMIT 1`,
      [String(key)]
    ).catch(() => []);

    const row = rows(result)[0];

    if (row) {
      let links = [];

      try {
        links = Array.isArray(row.links) ? row.links : JSON.parse(row.links || '[]');
      } catch {
        links = [];
      }

      return {
        dailyEnabled: Boolean(row.daily_enabled),
        links,
        mode: String(row.mode || ''),
      };
    }
  }

  return {
    dailyEnabled: false,
    links: [],
    mode: '',
  };
}

async function showAnalyticsMainMenu(chatId, keys, update = null) {
  await setAnalyticsModeForKeys(keys, '');

  await lrEditOrSendV3(update, chatId,
    '━━━━━━━━━━━━━━\n' +
    '📊 <b>LinkRay Analytics</b>\n\n' +
    'Выберите раздел:\n\n' +
    '🖼 <b>Картинка по ссылке</b> — отправьте ссылку канала или несколько ссылок, бот сделает PNG-карточку.\n\n' +
    '📆 <b>Ежедневный отчёт ПДП</b> — отчёт каждый день в 08:00 МСК: подписки, отписки и общий итог.\n' +
    '━━━━━━━━━━━━━━',
    [
      [lrCb('🖼 Картинка по ссылке', 'lrchan:links')],
      [lrCb('📆 Ежедневный отчёт ПДП', 'lrchan:daily')],
      [lrCb('⬅️ Главное меню', 'main:menu')],
    ]
  );
}

async function showAnalyticsLinkInput(chatId, keys, update = null) {
  await setAnalyticsModeForKeys(keys, 'await_links');

  await lrEditOrSendV3(update, chatId,
    '━━━━━━━━━━━━━━\n' +
    '🖼 <b>Картинка аналитики</b>\n\n' +
    'Отправьте ссылку MAX-канала.\n\n' +
    'Можно отправить несколько ссылок сразу — каждую с новой строки.\n' +
    'Тогда бот сделает сводную карточку сети каналов.\n' +
    '━━━━━━━━━━━━━━',
    [
      [lrCb('⬅️ В аналитику', 'lrchan:menu')],
      [lrCb('⬅️ Главное меню', 'main:menu')],
    ]
  );
}

async function showDailyPdpMenu(chatId, keys, update = null) {
  const settings = await getAnalyticsSettingsForKeys(keys);
  const status = settings.dailyEnabled ? 'включён' : 'выключен';
  const icon = settings.dailyEnabled ? '✅' : '⛔';

  await lrEditOrSendV3(update, chatId,
    '━━━━━━━━━━━━━━\n' +
    '📆 <b>Ежедневный отчёт ПДП</b>\n\n' +
    `${icon} Сейчас отчёт: <b>${status}</b>\n` +
    `📌 Каналов сохранено: <b>${settings.links.length}</b>\n\n` +
    'Каждый день в 08:00 МСК бот будет присылать:\n' +
    '✅ сколько подписалось;\n' +
    '➖ сколько отписалось;\n' +
    '📈 общий итог за сутки;\n' +
    '🖼 карточку LinkRay Analytics.\n' +
    '━━━━━━━━━━━━━━',
    [
      [lrCb('✅ Включить отчёт', 'lrchan:on'), lrCb('⛔ Отключить отчёт', 'lrchan:off')],
      [lrCb('🖼 Изменить каналы', 'lrchan:links')],
      [lrCb('⬅️ В аналитику', 'lrchan:menu')],
    ]
  );
}

async function showFallbackMainMenu(chatId, keys) {
  await setAnalyticsModeForKeys(keys, '');

  await sendMaxMessage({
    chatId,
    text:
      '━━━━━━━━━━━━━━\n' +
      '⚡ <b>LinkRay</b>\n\n' +
      'Главное меню.\n' +
      '━━━━━━━━━━━━━━',
    format: 'html',
    attachments: lrMenuButtons([
      [lrCb('🚀 LinkRay Studio', 'main:posting')],
      [lrCb(' Аналитика', 'main:analytics')],
      [lrCb('➕ Добавить канал', 'post:add_channel')],
      [lrCb('📈 Отчёты', 'reports:menu'), lrCb('🛡 Антифрод', 'fraud:menu')],
    ]),
  });
}

async function handleAnalyticsMenu(update) {
  const chatId = getChatId(update);
  if (!chatId) return false;

  const keys = lrIdentityKeys(update, chatId);
  const payload = lrPayloadDeep(update);
  const text = getText(update);
  const links = lrLinksDeep(update, text);


  if (lrIsStartText(text) || payload === 'main:menu' || payload === 'start' || payload === '/start') {
    await showFallbackMainMenu(chatId, keys);
    return true;
  }



  if (payload === 'main:analytics' || payload === 'analytics:menu' || payload === 'lrchan:menu') {
    await showAnalyticsMainMenu(chatId, keys, update);
    return true;
  }

  if (payload === 'lrchan:links') {
    await showAnalyticsLinkInput(chatId, keys, update);
    return true;
  }

  if (payload === 'lrchan:daily' || payload === 'lrchan:notifications') {
    await showDailyPdpMenu(chatId, keys, update);
    return true;
  }

  if (payload === 'lrchan:on') {
    await setDaily(chatId, true);
    await showDailyPdpMenu(chatId, keys, update);
    return true;
  }

  if (payload === 'lrchan:off') {
    await setDaily(chatId, false);
    await showDailyPdpMenu(chatId, keys, update);
    return true;
  }

  if (lrIsAnalyticsText(text)) {
    await showAnalyticsMainMenu(chatId, keys, update);
    return true;
  }

  const settings = await getAnalyticsSettingsForKeys(keys);

  // Главное исправление:
  // если открыт режим "Картинка по ссылке" или сообщение состоит только из MAX-ссылок,
  // ссылки забирает аналитика и не отдаёт их в старый сценарий создания поста.
  if (links.length && (settings.mode === 'await_links' || lrOnlyMaxLinksText(text, links))) {
    await setAnalyticsModeForKeys(keys, '');
    console.log('[LR_LINKS_V14]', lrV14UniqueLinks(links).join(' | '));
      await handleLinks(chatId, lrV14UniqueLinks(links), update);
    return true;
  }

  if (settings.mode === 'await_links') {
    await sendMaxMessage({
      chatId,
      text:
        '⚠️ Не вижу ссылку MAX-канала.\n\n' +
        'Отправьте одну или несколько ссылок вида https://max.ru/...',
      format: 'html',
      attachments: lrMenuButtons([
        [lrCb('⬅️ В аналитику', 'lrchan:menu')],
      ]),
    });
    return true;
  }

  return false;
}

export async function handleLinkRayChannelAnalyticsIncoming(update) {
  try {
    const handled = await handleAnalyticsMenu(update);

    if (handled) {
      console.log('[LinkRay channel analytics] handled update before main webhook');
    }

    return handled;
  } catch (error) {
    console.error('[LinkRay channel analytics incoming]', error?.stack || error);

    try {
      const chatId = getChatId(update);
      const text = getText(update);
      const links = lrV14ForceLinks(update, lrV14LinksFromText(text));
      const payload = typeof lrPayloadDeep === 'function' ? lrPayloadDeep(update) : getPayload(update);

      if (chatId && (links.length || String(payload || '').startsWith('lrchan') || payload === 'main:analytics')) {
        await sendMaxMessage({
          chatId,
          text:
            '⚠️ В аналитике произошла ошибка при создании картинки.\n' +
            'Ссылка не будет отправлена в публикацию. Попробуйте ещё раз через пару секунд.',
          format: 'html',
        });

        return true;
      }
    } catch {}

    return false;
  }
}
/* LR_ANALYTICS_LINK_ROUTE_V4_END */

export function mountLinkRayChannelAnalytics(app) {
  if (mounted) return;
  mounted = true;

  fs.mkdir(OUT_DIR, { recursive: true }).catch(() => {});

  app.use('/generated/channel-analytics', express.static(OUT_DIR, {
    maxAge: '30d',
    immutable: true,
  }));

  
  



  app.use(async function lrChannelAnalyticsMiddleware(req, res, next) {
    try {
      if (req.method !== 'POST') return next();

      const update = req.body || {};
      const handledByMenu = await handleLinkRayChannelAnalyticsIncoming(update);
      if (handledByMenu) return res.json({ ok: true });
      const payload = getPayload(update);
      const chatId = getChatId(update);

      if (!chatId) return next();

      if (payload === 'lrchan:on') {
        await setDaily(chatId, true);
        await sendMaxMessage({
          chatId,
          text: ' Ежедневный отчёт ПДП включена.\nСводка будет приходить каждый день в 08:00 МСК.',
          format: 'html',
        });
        return res.json({ ok: true });
      }

      if (payload === 'lrchan:off') {
        await setDaily(chatId, false);
        await sendMaxMessage({
          chatId,
          text: '⛔ Ежедневный отчёт ПДП отключена.',
          format: 'html',
        });
        return res.json({ ok: true });
      }

      const text = getText(update);
      const links = lrV14ForceLinks(update, lrV14LinksFromText(text));

      if (!links.length) return next();
      if (!isOnlyAnalyticsLinks(text, links)) return next();

      console.log('[LR_LINKS_V14]', lrV14UniqueLinks(links).join(' | '));
      await handleLinks(chatId, lrV14UniqueLinks(links), update);

      return res.json({ ok: true });
    } catch (error) {
      console.error('[LinkRay channel analytics middleware]', error.stack || error);

      return next();
    }
  });

  startDailyWorker();

  console.log('[LinkRay channel analytics] mounted');
}

export async function sendTestChannelAnalytics(chatId) {
  const target = chatId || process.env.REPORT_TEST_CHAT_ID || process.env.ADMIN_CHAT_ID || process.env.BOT_OWNER_ID;

  if (!target) {
    console.log('NO_CHAT_ID_FOR_CHANNEL_ANALYTICS_TEST');
    return false;
  }

  await handleLinks(target, lrV11UniqueLinks([
    'https://max.ru/join/test-channel-one',
    'https://max.ru/join/test-channel-two',
  ]));

  return true;
}
