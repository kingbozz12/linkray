/* LR_MAX_API2_AUTH_HEADER_ONLY_V1 */
/* LR_AGE_BUCKET_REACH_V81 */
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express from 'express';
import sharp from 'sharp';
import { query } from './db.js';
import { sendMaxMessage, answerCallback } from './maxClient.js';
import { getChannelMetricsReadiness } from './channelMetricsCollector.js'; import { installChannelAudienceReports, createAudienceReportLink } from './channelAudienceReports.js';

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

function getChatIdLegacyLinkRayV1(update) {
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

function getChatId(update) {
  const legacy = getChatIdLegacyLinkRayV1(update);
  if (legacy) return legacy;

  return (
    update?.message?.sender?.user_id ||
    update?.message?.sender?.id ||
    update?.sender?.user_id ||
    update?.sender?.id ||
    update?.user_id ||
    update?.userId ||
    update?.callback?.user?.user_id ||
    update?.callback?.user_id ||
    update?.body?.message?.sender?.user_id ||
    update?.body?.message?.sender?.id ||
    update?.body?.sender?.user_id ||
    update?.body?.sender?.id ||
    update?.body?.user_id ||
    update?.body?.userId ||
    null
  );
}


function getTextLegacyLinkRayV1(update) {
  return String(
    update?.message?.body?.text ||
    update?.message?.text ||
    update?.body?.text ||
    update?.text ||
    update?.message?.body?.mid ||
    ''
  );
}

function getText(update) {
  const legacy = String(
    getTextLegacyLinkRayV1(update) || ''
  ).trim();

  if (legacy) return legacy;

  const found = [];
  const seen = new WeakSet();

  function walk(value, depth = 0) {
    if (value === null || value === undefined || depth > 12) {
      return;
    }

    if (typeof value === 'string') {
      if (/https?:\/\/(?:www\.)?max\.ru\//i.test(value)) {
        found.push(value);
      }
      return;
    }

    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }

    for (const child of Object.values(value)) {
      walk(child, depth + 1);
    }
  }

  walk(update);
  return found.join('\n');
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
  /* LR_TRUTHFUL_VIEWS_ER_V80_2 */
  const needles = lrV16LinkNeedles(link);
  const likeNeedles = needles.map((x) => `%${x}%`);

  try {
    const exact = rows(await query(
      `SELECT *
       FROM public.lr_channel_analytics_snapshots
       WHERE link = ANY($1::text[])
         AND collection_source='max_api_collector_v1'
       ORDER BY captured_at DESC
       LIMIT 1`,
      [needles]
    ).catch(() => []))[0];

    if (exact) return exact;

    const byLike = rows(await query(
      `SELECT *
       FROM public.lr_channel_analytics_snapshots
       WHERE link ILIKE ANY($1::text[])
         AND collection_source='max_api_collector_v1'
       ORDER BY captured_at DESC
       LIMIT 1`,
      [likeNeedles]
    ).catch(() => []))[0];

    return byLike || {};
  } catch (error) {
    console.error(
      '[LR_TRUTHFUL_VIEWS_ER_V80_2_SNAPSHOT]',
      error?.message || error
    );

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
  /* LR_TRUTHFUL_VIEWS_ER_V80_2 */
  const snap = await lrV16LoadFromSnapshots(link);
  const channel = await lrV16LoadFromChannelsTable(link);

  /*
   * Название, аватар и резервное число подписчиков
   * разрешено брать из channels.
   *
   * Просмотры и ER берутся только из снимка
   * collection_source=max_api_collector_v1.
   */
  const title =
    lrV16Pick(channel, [
      'title',
      'name',
      'channel_title',
      'chat_title',
      'display_name',
      'channel_name',
      'chat_name',
    ])
    || lrV16Pick(snap, [
      'title',
      'name',
      'channel_title',
      'chat_title',
      'display_name',
      'channel_name',
      'chat_name',
    ]);

  const avatar =
    lrV16Pick(channel, [
      'avatar_url',
      'photo_url',
      'image_url',
      'icon_url',
      'picture_url',
      'avatar',
      'photo',
    ])
    || lrV16Pick(snap, [
      'avatar_url',
      'photo_url',
      'image_url',
      'icon_url',
      'picture_url',
      'avatar',
      'photo',
    ]);

  const snapshotSubscribers =
    lrV16PickNumber(snap, ['subscribers']);

  const channelSubscribers =
    lrV16PickNumber(channel, [
      'subscribers',
      'subscriber_count',
      'subscribers_count',
      'members',
      'members_count',
      'participants_count',
      'followers',
      'followers_count',
    ]);

  const out = {
    collection_source:
      String(snap?.collection_source || ''),

    subscribers:
      snapshotSubscribers > 0
        ? snapshotSubscribers
        : channelSubscribers,

    views24: num(snap?.views24),
    views48: num(snap?.views48),
    views72: num(snap?.views72),
    views_total: num(snap?.views24),

    posts24: num(snap?.posts24),
    posts48: num(snap?.posts48),
    posts72: num(snap?.posts72),

    er24: Number(snap?.er24 || 0),
    delta_day: num(snap?.delta_day),

    joined_24h: num(snap?.joined_24h),
    left_24h: num(snap?.left_24h),
    joined_7d: num(snap?.joined_7d),
    left_7d: num(snap?.left_7d),
  };

  if (title) out.title = title;
  if (avatar) out.avatar_url = avatar;

  console.log(
    '[LR_TRUTHFUL_VIEWS_ER_V80_2_SOURCE]',
    lrV16NormalizeLink(link),
    JSON.stringify({
      source: out.collection_source || 'none',
      subscribers: out.subscribers,
      averageViewsTotal: out.views_total,
      averageViews24: out.views24,
      averageViews48: out.views48,
      averageViews72: out.views72,
      posts24: out.posts24,
      er24: out.er24,
    })
  );

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
  /* LR_TRUTHFUL_VIEWS_ER_V80_2 */
  await ensureTables();

  const cleanLink = lrV16NormalizeLink(link);
  const channelKey = hash(cleanLink);

  if (
    extraRaw
    && typeof extraRaw === 'object'
    && (
      extraRaw.message
      || extraRaw.callback
      || extraRaw.update_id
      || extraRaw.recipient
      || extraRaw.body
    )
  ) {
    extraRaw = {};
  }

  const idx = Number(extraRaw?._lrIndex || 0);

  const known =
    await lrV16KnownChannelData(cleanLink);

  const lrV22ExtraRaw =
    lrV22SafeExtraRawForChannel(
      extraRaw,
      known,
      cleanLink
    );

  const preview =
    lrV19CleanPreviewAvatar(
      await lrV16FetchMaxPreview(cleanLink)
    );

  const fromMax =
    await callMaxForStats(cleanLink);

  /*
   * MAX preview/fromMax остаются только резервом
   * для названия, аватара и подписчиков.
   * Просмотры и ER из них не принимаются.
   */
  const rawMerged = {
    ...fromMax,
    ...preview,
    ...known,
    ...lrV22ExtraRaw,
  };

  const normalized =
    normalizeStats(cleanLink, rawMerged);

  const realTitle = lrV17PickRealTitle(
    known,
    lrV22ExtraRaw,
    fromMax,
    preview,
    normalized
  );

  const realAvatar = lrV17PickRealAvatar(
    known,
    lrV22ExtraRaw,
    fromMax,
    preview,
    normalized
  );

  normalized.title =
    realTitle
    || lrV16CleanTitle(
      normalized.title,
      cleanLink,
      idx
    );

  normalized.avatarUrl =
    realAvatar
    || normalized.avatarUrl
    || normalized.avatar_url
    || '';

  normalized.subscribers =
    lrV17PickPositiveNumber(
      known.subscribers,
      known.subscriber_count,
      known.members_count,
      fromMax.subscribers,
      fromMax.subscriber_count,
      preview.subscribers,
      normalized.subscribers
    );

  /*
   * Здесь специально нет PickPositiveNumber.
   * Реальный ноль нельзя заменять legacy-числом.
   */
  normalized.views24 = num(known.views24);
  normalized.views48 = num(known.views48);
  normalized.views72 = num(known.views72);
  normalized.viewsTotal = normalized.views24;

  normalized.posts24 = num(known.posts24);
  normalized.posts48 = num(known.posts48);
  normalized.posts72 = num(known.posts72);

  normalized.er24 = Number(known.er24 || 0);
  normalized.deltaDay = num(known.delta_day);

  const saved = rows(await query(`
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
      'render_v80_2'
    )
    RETURNING *
  `, [
    channelKey,
    cleanLink,
    normalized.title,
    normalized.avatarUrl || '',
    normalized.subscribers,

    normalized.views24,
    normalized.views48,
    normalized.views72,
    normalized.er24,
    normalized.deltaDay,

    JSON.stringify({
      source: 'render_v80_2',
      trustedSnapshot: known,
      preview,
      fromMaxMetadataOnly: {
        title:
          fromMax?.title
          || fromMax?.name
          || '',
        subscribers:
          fromMax?.subscribers
          || fromMax?.subscriber_count
          || 0,
      },
      extraRaw: lrV22ExtraRaw,
    }),

    normalized.viewsTotal,
    normalized.posts24,
    normalized.posts48,
    normalized.posts72,
  ]))[0];

  console.log(
    '[LR_TRUTHFUL_VIEWS_ER_V80_2_RESOLVED]',
    JSON.stringify({
      link: cleanLink,
      title: saved.title,
      subscribers: num(saved.subscribers),
      averageViewsTotal: num(saved.views_total),
      averageViews24: num(saved.views24),
      averageViews48: num(saved.views48),
      averageViews72: num(saved.views72),
      posts24: num(saved.posts24),
      er24: Number(saved.er24 || 0),
    })
  );

  return {
    key: channelKey,
    link: cleanLink,

    title: saved.title,

    avatarUrl:
      saved.avatar_url || '',

    avatar_url:
      saved.avatar_url || '',

    subscribers:
      num(saved.subscribers),

    viewsTotal:
      num(saved.views_total),

    views_total:
      num(saved.views_total),

    views24:
      num(saved.views24),

    views48:
      num(saved.views48),

    views72:
      num(saved.views72),

    posts24:
      num(saved.posts24),

    posts48:
      num(saved.posts48),

    posts72:
      num(saved.posts72),

    er24:
      Number(saved.er24 || 0),

    deltaDay:
      num(saved.delta_day),

    delta_day:
      num(saved.delta_day),
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
.row b{text-align:right;color:#168eea}.row em{font-style:normal;text-align:right;font-weight:900}.plus{color:#20c77b}.minus{color:#ff334d}
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
/* LR_ANALYTICS_V75_EDITOR_ALIAS */
const lrEditorSendV3 = (...args) => lrEditOrSendV3(...args);

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

  await sharp(Buffer.from(lrV82BrightNegativeSvg(svg)))
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
    ${lrMetricBoxV3(350, 330, 260, 118, 'За сутки', `${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}`, ch.deltaDay < 0 ? '#ff334d' : '#31f2cc')}
    ${lrMetricBoxV3(634, 330, 260, 118, 'Охват 24ч', fmt(ch.views24), '#31f2cc')}
    ${lrMetricBoxV3(918, 330, 282, 118, 'ER24', pct(ch.er24), '#27d9ff')}

    <text x="66" y="500" font-size="32" font-weight="900" fill="#fff">Динамика подписчиков</text>
    ${lrLineChartV3(subValues, subLabels, 66, 525, 690, 200, ch.deltaDay < 0 ? '#ff334d' : '#31f2cc')}

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
    ${lrLineChartV3(histValues, histLabels, 66, 410, 560, 300, totalDelta < 0 ? '#ff334d' : '#31f2cc')}

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
    ${lrMetricBoxV4(342, 262, 250, 96, 'За сутки', `${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}`, ch.deltaDay < 0 ? '#ff334d' : '#31f2cc')}
    ${lrMetricBoxV4(614, 262, 250, 96, 'Охват 24ч', fmt(ch.views24), '#31f2cc')}
    ${lrMetricBoxV4(886, 262, 300, 96, 'ER24', pct(ch.er24), '#27d9ff')}

    <text x="70" y="406" font-size="26" font-weight="1000" fill="#fff">Динамика подписчиков</text>
    ${lrLineChartCompactV4(subValues, subLabels, 70, 426, 610, 140, ch.deltaDay < 0 ? '#ff334d' : '#31f2cc')}

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
    ${lrLineChartCompactV4(histValues, histLabels, 70, 326, 590, 210, totalDelta < 0 ? '#ff334d' : '#31f2cc')}

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
    ${lrMetricBoxV4(342, 258, 250, 96, 'За сутки', `${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}`, ch.deltaDay < 0 ? '#ff334d' : '#31f2cc')}
    ${lrMetricBoxV4(614, 258, 250, 96, 'Охват 24ч', fmt(ch.views24), '#31f2cc')}
    ${lrMetricBoxV4(886, 258, 300, 96, 'ER24', pct(ch.er24), '#27d9ff')}

    <text x="70" y="398" font-size="25" font-weight="1000" fill="#fff">Динамика подписчиков</text>
    ${lrLineChartCompactV4(subValues, subLabels, 70, 418, 610, 138, ch.deltaDay < 0 ? '#ff334d' : '#31f2cc')}

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
    ${lrLineChartCompactV4(histValues, histLabels, 70, 322, 590, 208, totalDelta < 0 ? '#ff334d' : '#31f2cc')}

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
${lrMetricSvg(442, 340, 330, 145, 'Сегодня', `${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}`, ch.deltaDay < 0 ? '#ff334d' : '#27e6c7')}
${lrMetricSvg(800, 340, 330, 145, 'Охват 24ч', fmt(ch.views24), '#27e6c7')}
${lrMetricSvg(1158, 340, 350, 145, 'ER24', pct(ch.er24), '#24d9ff')}

<rect x="84" y="525" width="938" height="320" rx="30" fill="#f8fcff" stroke="#dcecf3" stroke-width="2"/>
<text x="128" y="580" font-size="31" font-weight="900" fill="#102033">Динамика подписчиков</text>
<text x="128" y="615" font-size="21" font-weight="900" fill="#6d7f90">реальный график по ежедневным замерам</text>
${lrChartSvg(subValues, subLabels, 128, 640, 850, 170, ch.deltaDay < 0 ? '#ff334d' : '#27e6c7')}

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
    ${lrLineChartCompactV4(histValues, histLabels, 70, 340, 590, 300, totalDelta < 0 ? '#ff334d' : '#31f2cc')}

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




/* LR_MULTI_AVATAR_CACHE_V27_START */
const lrV27AvatarMemo = new Map();

function lrV27NormLink(value) {
  return String(value || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

function lrV27NormTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lrV27GoodAvatarUrl(value) {
  const s = String(value || '').trim();
  return /^https?:\/\//i.test(s) && !s.includes('/s/img/og-logo.png');
}

async function lrV27GetCachedAvatar(ch) {
  const link =
    ch?.link ||
    ch?.url ||
    ch?.key ||
    ch?.channel_link ||
    ch?.public_link ||
    ch?.source_link ||
    '';

  const title =
    ch?.title ||
    ch?._lrTitle ||
    ch?.name ||
    ch?.channel_title ||
    ch?.channel_name ||
    '';

  const linkKey = lrV27NormLink(link);
  const titleKey = lrV27NormTitle(title);
  const memoKey = `${linkKey}|${titleKey}`;

  if (!linkKey && !titleKey) return '';
  if (lrV27AvatarMemo.has(memoKey)) return lrV27AvatarMemo.get(memoKey);

  try {
    const db = await import('./db.js');
    const result = await db.query(
      `SELECT avatar_url
         FROM public.lr_channel_avatar_cache
        WHERE ($1 <> '' AND link_norm=$1)
           OR ($2 <> '' AND title_norm=$2)
           OR ($3 <> '' AND link=$3)
        ORDER BY updated_at DESC
        LIMIT 1`,
      [linkKey, titleKey, String(link || '').trim()]
    );

    const rows = Array.isArray(result) ? result : (result?.rows || []);
    const avatar = String(rows?.[0]?.avatar_url || '').trim();

    if (lrV27GoodAvatarUrl(avatar)) {
      lrV27AvatarMemo.set(memoKey, avatar);
      return avatar;
    }
  } catch {}

  lrV27AvatarMemo.set(memoKey, '');
  return '';
}
/* LR_MULTI_AVATAR_CACHE_V27_END */


/* LR_AVATAR_CACHE_PARAM_V29_START */
const lrV29AvatarMemo = new Map();

function lrV29NormLink(value) {
  return String(value || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

function lrV29NormTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lrV29GoodAvatar(value) {
  const s = String(value || '').trim();
  return /^https?:\/\//i.test(s) && !s.includes('/s/img/og-logo.png');
}

async function lrV29FindAvatarForChannel(channel) {
  if (!channel || typeof channel !== 'object') return '';

  for (const key of ['avatar_url', 'avatarUrl', 'photo_url', 'image_url', 'picture_url', 'avatar', 'photo', 'image']) {
    const direct = String(channel[key] || '').trim();
    if (lrV29GoodAvatar(direct)) return direct;
  }

  const link = lrV29NormLink(
    channel.link ||
    channel.url ||
    channel.key ||
    channel.channel_link ||
    channel.public_link ||
    channel.source_link ||
    ''
  );

  const title = lrV29NormTitle(
    channel.title ||
    channel._lrTitle ||
    channel.name ||
    channel.channel_title ||
    channel.channel_name ||
    ''
  );

  const memoKey = `${link}|${title}`;
  if (!link && !title) return '';
  if (lrV29AvatarMemo.has(memoKey)) return lrV29AvatarMemo.get(memoKey);

  try {
    const db = await import('./db.js');

    const result = await db.query(
      `SELECT avatar_url
         FROM public.lr_channel_avatar_cache
        WHERE ($1 <> '' AND link_norm=$1)
           OR ($2 <> '' AND title_norm=$2)
           OR ($3 <> '' AND link=$3)
        ORDER BY updated_at DESC
        LIMIT 1`,
      [link, title, link]
    );

    const rows = Array.isArray(result) ? result : (result?.rows || []);
    const avatar = String(rows?.[0]?.avatar_url || '').trim();

    if (lrV29GoodAvatar(avatar)) {
      lrV29AvatarMemo.set(memoKey, avatar);
      return avatar;
    }
  } catch {}

  lrV29AvatarMemo.set(memoKey, '');
  return '';
}
/* LR_AVATAR_CACHE_PARAM_V29_END */

async function lrV14Avatar(ch, x, y, size = 42, idx = 0) {
  /* LR_AVATAR_LOOKUP_PARAM_V29_START */
  try {
    const lrV29Avatar = await lrV29FindAvatarForChannel(ch);
    if (lrV29Avatar && ch && typeof ch === 'object') {
      ch.avatar_url = lrV29Avatar;
      ch.avatarUrl = lrV29Avatar;
      ch.photo_url = lrV29Avatar;
      ch.image_url = lrV29Avatar;
      ch.avatar = lrV29Avatar;
    }
  } catch {}
  /* LR_AVATAR_LOOKUP_PARAM_V29_END */



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
${lrChartSvg(histValues, histLabels, 126, 620, 620, 170, totalDelta < 0 ? '#ff334d' : '#27e6c7')}

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

async function renderNetwork(...args) {
  /* LR_NETWORK_RENDERER_V32_START */
  const WIDTH = 1280;
  const HEIGHT = 900;
  const lrV39RealLogoData = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBAUEBAYFBQUGBgYHCQ4JCQgICRINDQoOFRIWFhUSFBQXGiEcFxgfGRQUHScdHyIjJSUlFhwpLCgkKyEkJST/2wBDAQYGBgkICREJCREkGBQYJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCT/wgARCAC0ALQDASIAAhEBAxEB/8QAGwAAAgMBAQEAAAAAAAAAAAAAAgMAAQQFBgf/xAAZAQADAQEBAAAAAAAAAAAAAAAAAQIDBAX/2gAMAwEAAhADEAAAAeGQl6XkEQkkZCUyRCcIiEpCOigshKQiEpCISkMhKGRCUBSRPx9iXsWRgSkzXrhL3KVEb3YH5rc3C/B7IhuVBg7Gkrzxb8GskQ3IZAUhypL8hY37OhwNES9edjl7V6JzJ5twnZ1cGbHpbbNvPONufpYSOLi97auPfR5uskQWg5Uk8jBD2NnQVCceRwa+j2t8Pnek8UGNfSdPlA5du951PazxycTVza5cPqkFD1crXIrnWF7o4Mk8gu56vQQoZox1Y2we54YerjPR0NOLl6fPl6nbjjz+P1X4R4zt4GbnS5W7lc+b246uU0/Nq2QIHjoFen1UxJ6VS62Q3fSflvp88vf1yH+cvQ4PKhVejw9blVSeRk068u/IkcM30mUa8rsytsCB46oHo9lEI3Yei830JjZ3fPueHoOH2O9lXl3+j25X4i/dtDz3HvA+d7M5KHRLEtaQmVMgQPKZ9CO7tNRDdLF0lraCkfQu94D0y5+P207Ifo/Nq8hBoPHr3x0WiTD9WDTmW1J5tkCI80pg9nZmZFqrOBdGliZNrebRPusHmTMdYr0jcxBPN0VqUvWl+KcailMgRLz1S+vsWt4S0Mi05GXTGiplNEiWkpjgysph4K0ZyxqzUHYWkcGI4NjfR2lUskBbSEDoqWs5BWQ20cjFIPthNtAiDsLEdhaRwYjhFJt2WUiV3ITJIiSQRXISZyCI5CbuQV3Ii7kSuSI//8QAKxAAAgICAQMDBAICAwAAAAAAAQIAAwQREgUQExQgIiEjMDIxMzRQQEFC/9oACAEBAAEFAv8AQ6mv+EoLH0/GA0rBeRBkWwZFs8pacKHhwiYVKn8iVfTz/QQQQQQQQTYsF2JwH4dxQKQXLsIIIoLSqoJGx6shWrasiCD6xeSm6lbV9+4mq15FiIAYtZi1KJ6hFlODflR+nZfTWp6tXaDVW4YtU2zxzs0vKPtV5VQPvRfIz2eRt6lLcm81geqjPulPRnc4+HTjQdsjAx8mW9IeiVV+JMvKNsVfvr/CvxN1fis9hM3wpEYzD+r9MXit+alEt6uQV6tasxep+SvJ6uKzV1LIvcnSW2PlP1PE8VVmMFXc3LfuUez9mtbdkaYP9oyBi4yVWZdmL06qhbK6669WWnCx3GSeNSuLMpsKx6M7q+rMbI/xtzcqb5kcT2Mq/sHZphtxuyrPJb02jgqgzqCs2Ph4vBWUJPCchrGXGTrtHGZNvOrKb7U3NzJ/u7GJ+vZpWxEtu434z/FbDGLWxXAmXkcFraw43qkVeuvuI/OzJt3OU3NzIPcxP1m4xl1YpijyTpmfwRXa0+qCiq+5b7rfXZNmLVdMirCxq7rrcrJqAW2xtvubm5efj2Mr/mbgPzy6/VhcNt1vXVPPyW3Kuuspxc3Ll1WZhsepZMSrNyiMdOlYqEJWDubm5uZH79jFPFz8WMBAYK6hPNBZWpppO6aFj/PKRR5PCsACzOyxm5Lvsgzc3Kxzsd+dnYwxvkIRFLIWssaVOFbCtAVWi6s6njWBc0tOp9Q4VhgirNzc3KjwRe5hiHvqET+D01juu0pPQY11leLjYpyOoApZcbHX6wTc3Bsm1hB7DDP3Hf8A9VXtUtOballGbVdHul2Q1zKIJubm4p8KLB7DCJ+pI2O3/etwrFsZYWawqsHbc3EAQbLsPcYRNlToP7NTUHbc3Bsn40zZcj8Opqc5xBhBHs3FVmnBVnlOgIB+LU1NTUDMs8k5rOazymF3aBYBAPy6mpqanGcZxgE1/oP/xAAlEQACAgAGAQQDAAAAAAAAAAAAAQIRAxIgITFREBMyQEEiMHH/2gAIAQMBAT8B+DZZsxqtbZfRDDlVtGXosTGq0UNbEYQy5mRde2IsdIxJxl9Hu4Eq00NfizD3UUPZCwHVnp5udkTeVOJN7l6GLoay0+h4yY8ZyWVE1sYzt5tc48NE4SlyyGFRS4o9KPRjbutKF452M+SWWRKCbsc83A0UVqQ4xfJ6KX3sPpFDWu/DGj+fovzsN/B//8QAIxEAAgIBBQACAwEAAAAAAAAAAAECEQMQEiExQRMgIjJRQP/aAAgBAgEBPwH6vV/ZlMlFEkh8dCy/0u+vtVDJX4bL95Mlx/YlKjbLHFSfonf0ivRdkp80icZsd9USnJcNGHGlK5dmbJ8lEOHq9F2fqrHK2ZMrp0QiPtTXpjXBtF0Ue6LsyxJ23+IsLumUmThthRHHSNolwUejErJQvs/GI8leHypdI2urkbShLgoYuSi6JQ9ROmQx2x8lE/5pQxOtGbjjV8D0rShOjvStG9aK1oo5Lelf4f/EADoQAAECAwUEBwYEBwAAAAAAAAEAAgMRIRIgMUFREBMiYQQwMlJxgaEjM0JicoJQgbHBJEBTktHh8f/aAAgBAQAGPwL8UkBMr2rwzliVSGXfUVwtY3wau2V2yuJrHeLVWGWfSV7J4fywKk4SPW24hst9SrMMWG+p6mzFFseoVthts9R1dp4m/Jv+VNxmblArTjh+QW8guFdMCpOErk8FvIMubR+3U7132hTNSdmCyCm71UmcZ5YIOjnds0zRidEcYkPMf6VmM3dn8wrTDTUVC4ZOOimaa1wW7hUGuqYB8IW9YKfENL8ssSp5ZDZ6Ky2CXLhg7vxop9Ijz5NXs4cjrnt9pDr3hQq10ePLxorUV9p2blJtGJoOytQcQi3LK8Bm+vltb9SiHUqyOKJopF7nHuw1M9GjS1mhEsvsnvYqRdXuMVlnRnD5nOwVqI4y55qyKN0UOWpmmvzG3nD/AEuhuqMsBQbYfinuznRWAauq9yoK6ovOAqgW9p+HIJ7iyVkyVqJ5BT+FGB0qRcascoZHe/ZD7dsjg6hRByuT0E7kM/MhCytpzsydlkDEhAyyU5TKtEzQk22TkFCjt7TXIN+afopcxcJ71bkTwueBTYmU5qmGKxQsk4qU5lGuCgjeth7w1JNZclaggsO8sGs1DhDElNbzQ8Z3IR+S5E8LjWZoNK3EQG3DoOfJcVPl08VJmHe1RaTQGh1W4Y7hnN7lCtg+yM2yKNq12rdkOrNTlOK+gbonSqGUnqvC5B+m44ai4yJCqdBkVxmwOanr8RxKrww8m5uXuX2Rg1SI3MPPVfwzAWDzJ8VJ3R3DwmuGFuhq5OiTtRncIcdV6lTuNb3WgXAURsrhmpt9o3JzV2Jcyqu3jz/aFNxtO1VU2AH7tgZaMjinQp2hKYJ2UUh7qH6qVxrdSnO1N0O2zaSFVxKmcM0ATMfC7Y5j5ydFkUGNwD5bN1CPE+k+SkP+3XxPtF4s1vPYTwKRqEYptzdWjkIs3cOrkXVbD9XovdiVM3JDFCGMGfrftZjG4EQ3E5q0Ikzoc1/Sf6FW4rrXJTPkNFW7a+N3Z5c+omFab+VyuzVVvbyJ5N1Vp2PUzCpQ6dVILi4n93RWnVPWScJrhPkVUXaAlcb/ACCkwWB6/wAhQqrWle79V7v1VGMHkquP4x//xAAoEAEAAgEDAgUFAQEAAAAAAAABABEhMUFREHEgYYGRsaHB0eHw8TD/2gAIAQEAAT8h6EIQhCEIQ6nQhCEIdToQhCEIQTs+0saj7Q6HQhCEIdCEIQ6A3JsQGfk2Gvbz9on0Yyfh05N3nxPI64uftMzxf8KjdhbJCHQ6HQhCEuBW16HwkUeh31H/AIqDUnYX6DEdW593oQhDoQ6YQMZsvt5xdongTNXQKk7lga3+P8iX5/B6hdAvYgMBXniLNNzTvB1HodGKgBXX3ee0UXchel++J1YEWWcqiNcuAw/aOIbH2jaNxmabfXd3JxbLZ+0nq9GBq6sFNZZwdiFkquE6/pDoOgIBjJwbue3guEuZk0cvBE2QxwExRkp1SFhuaJbfsSmwOSfLMAOXc+rNKOTn3dFTOh/QuJPYM3uTBgDOaeRLlq+d+8ej3uKCwKVchM4XqfJ4Llce4N8IpjmA5hOMPiMgXaHbvPToQe/+zEt538QNmANR8vzGaveHdh0o76hzpNCLus9kDHRpFnbnvMREmQL8mGHQM299fS+iykjVVB/GAQY8RWXMovOActS+HXHEPB8tzMKo2hZUowllZBCYr8w/szLJwNDiaPwso7dvvDyZ+Uw/tp1ir+ao2qlXS4o682+iKDNM8gPvi7M/EmBfwpwI5Y1GuIDGRQg7I0DLqbYrGjVFbL3+TpcvYT6S+jHMxNoD3kuXHHSdv1gwY8TIHJEFchNdVlg+TAF4QQYAcbzOTuTGaUmdCsN5XmhuG20ODglder9P5mXsUJg71UW561hyD5ly44vafMGEXYNWYhyK9athBdXgf7zj7GxVo+6aGEzljzKL7Ox3dk1wNFuHHGVLj++8u6qsZTj8QYScdlfaS4rWltl16COTS/mY3jXg+A/uYMvpy5LBjhMJ4mhMy5HeEmeC28s+2stLpu+lRYttg/hmpXbkmAiaNxAerSavm32ic+7EA5iSfoNwtx8wner+r+849lq58BVQIMvp42vMPkLU0QWldNNahQe6P8ieSvgwe8B041v1HeZDLr9h5QFJjt3QOVdVcuSuWLe0rdJpwl57vDzbvrpF85l8J0HF2DtBl9d+ZlPc6WSwN8mfUMzBAW8CAuX/AAZniukyjXWXb3DetTNOanRtuYA0PlG6ur4ByhXqs0QZfVss00+TMjTr4Dbi9ouwA0eYfk23cipLNtK5UW1DiuIChjhODiIJ2ONg8pd/wRV1KoLWAlh94l53PQMuMMEX/dPODBjGAsAlrliW9ow5n1WGe2jQuJwNwOgjrcY+AZLpYcIEUHqOgLuEDaN+EGLLSwS+pfQxDj5y4KjYIR0X1BYX/X0l8lrpJcvqOgWBTOB+q7REaSoECMEioPUqgVdiGpTa2d0V0shh0uX4EjDBYwvO5DQ76DNVCXCD0I+2E2MPfZuO61q9evHS5cvpfSowwyzrzXEs/DVOUeihx/VwD7ymDYcaHgsPBcvxV4jEHQkBCXLly5cv/jUqVAgQIQ/4f//aAAwDAQACAAMAAAAQ71h7XmLj9Q/AStinZbPyFkVwU/mRxeufrdCyU/i5e03lqfACiMmNl2fCkU8MtkOY13TQj70C4mnR6zTHinr9NZ37eSrZFPHMOXmG/hfqQtqD9k3ne9VZCb99SVs4iE+CO8pB9ihDff8A4YQww//EACMRAQEBAAIBBAIDAQAAAAAAAAEAERAhQTFRYXEg8IGRsdH/2gAIAQMBAT8QeHh/A4OEmevWW1hQoPgkWPA8M9Se8B6t39EZ9L98SPVQIUzxaM42y7d2LZIDIe38rhD9jvtd/wCv32xHsPMnRt0zjLMNnBluXxHR9tiIhM3cljej/b9/8izM21hh2eM6jZEXmTL8H6lM8f7wQUCOZ+/xfBIVNfwDqTe51ViTf+UfZNsHxekE7HmfQsss5jxbYDULR68MIPvsjfE82XDs5PBD5Lp7IWzjdjaC+EwMOpmFmEnCQw+S+d9QWA7Zdjh9zykkPByc/Wcd5aTtllnD+DM8vH//xAAkEQEBAAICAQQBBQAAAAAAAAABABEhEDFBUWFx0aEwkbHB8P/aAAgBAgEBPxBmZngzwZ4ZmEr7XkbvRSfQlNUIzEksTMdz3FgtDN3Z/qsnAx/FqJvM6hPh7e8RyScN5FtE0MwX+Lbgs+l+PmRhmxfiw16TcHhksWzixqG3xZPXM4i9wAOnzYtvcU8Qc/J92TP3be2DwOkxNmZBDqOOYITXb8Rqmcxiu/uxJHOOg8P2l5KfAWYZGGxOqzeQ7mOJlsAzwEsMzvkhLc7APDd10d/X3btcRr3ScBZHHaV6Q9rC68WJgywVyycEmJBIkDgTqcu2SeRJjDDzwYXvhixJY/SZ4//EACcQAQACAQMEAgMBAQEBAAAAAAEAESExQVEQYXGBkaGxwdHwIOHx/9oACAEBAAE/ECH/ACg/6gQ6CaJq6g6AhFCaunVFBBEG5NIbwmGiXlEQ6J8wOg/6AswehdR5gzTh4NrCRZr+lMHuYMtxxhijPM+W4jQfAP1N94Af1AlHb5nyQemXPCAKRZvh9sPpmuhpwnpnZ0EVQYsQcRdCiJUzDo9JF/qO7HZm1vf2PxM29V1ejTBpD0GXERpNGHznGB9xChHKr4PHch1FFBx1BqIEEQOyHb9RE2vBduxwdGyOpdczV2PLNMSOH/R/1Q6mljfwav8AJLe3Zc+B0ehBqhMB5kYYZbot2p1hTpsoEpzRqXdh66Bhr0Bilyglw6JpC39n2xNYWNVlnAK9i5oHtK/MqaTu2/Ut8HUX+/cHtRoDZ239A8wIV0QEfD5ue0XwlHB+L5niNOeIr3x8g+ZROLIP8mPmCaRQy7af1KxF5nDDNumOZwPB1uKOPs+JZy7A5CKSVGmfZ3fTLqXcGGEUakAafeC6/wAjKtQNoehEWXL7Skp/3MZ1mRWvWsEuDLxH234E3YAtfjb9EFGq03v7ZPVQ6QDL1vbhfTX3cZWzN74tN9kZ8QDFHsafb9Qh7JRV5rjtF6cPmGZSC9oopQdo+pEuDhzfR/XqDLgzCUNYxrSd8Lh7cygiDzPYL4r+TKAp+a/9SrIbVo5Wx21/MeMGgg9uXqHQgy5f3X7mdToICxpWy/D3KUs1TfYXR7XfaZdXo/MOrwZYzt84Tgf6pf8As5sBuvLGHISzrAlnbMxDYDcb/J9ysRm5Jdy91MnpzBhFyklzMM+2MuqC4wEwzOhW+r+4DAFzugD9+CXHd6EW3jTG7jQmBIZC/M/rSZZdTsFy51qMM23Drnal1YXIXhJcPo2fiXToci5f8jE3FMwOAjlL90FA2QONgmbg/hqBs5CIs6hAwwx74V3Ak8CvzU1Gu/I1BluZWS9envzD7Yjlc7zBGqlhaAPw/sIt2FDfAfuC7pN1mtnysVWUXlVpyt/EKdVuMhAQEyFYvllui8Dax/EBL05QgZcDg3ilR1O2zC+32QxzVA4un7JWDtU8L+QZGsugNJkhBWD+i/u4RRmNnOYfkOlgi2zGVkpD/vESrYu+Rf3GyFK24WMsygyqxcKhvVP5mV5CaHSGU7qo5twH2RZgcaicC6oova4JqrmyC7EyOa5Y2Uewcgsv5+kY5L9Sz9ERAj4rQ/LORS/MZ5rM+kQ6OJmC7nRUEdGdKjCUpHkWPlqDlWa2XT4p6WLRkpOwrRs25PEINEyGs8Je2h3YzIsrV44H+YbhAMXYHjXjMwFthguqHfg5XBNdGTAsLrUwxGiFsKKv/piJKgaa+h2wuu1rtP8AOJA2rY7E19gffV/MO+eU8p3IX+X0TvjwxdiR5Kf1LsyiLGOMvGYwVomYANQpSxMRg4UI+Ba+vMDtmBx7ZNDse2Hlet9sb93fQ2hhMQMx3cZYkUFAPCq7fCh2lz10QRKcRXY0BLbQ1AT6phobM3D5Lz8HuJOrgy4WwZW7WZeavhqw+LYUTlV5Yd/S0GDyzeat/PQJ0QFHAHg4fzFQ3oUM+NhuNU7mp4gZk3ATvWV2QSB911vI0IuJxabfkpwUd2NZhpSqODQ7CBWDwxHEjhjjiN6jFZRAi023jO6SpeTbQ4uoPIp2LmYcrHoGx/uCUgdHlOEQHsav1crXUejB9HUaIdZyL/ruSLZ0yJN1WL+JQNTnP9ogTmhIJ8i5xX+KfUEBe8WSy6FFmF9eorBCWYFM1B0MRQJWHYJ41L5utJkxD4/8P15jLe0teWHX2bg/kz6IqB1IxDrCSayJ2dPnSIoKDScShgZixCyFjh5SiECbSdviBAPgcjx3PuGoJwl2rSNeIJr/ACIUxii3tLvSTn8JOXY14gxlQoUA0ewMB7YNCbBsII64XyQG6wlSCDR//hHQdRn0KmzbeXA0KPDb+uoVSAQ2u31maouA1jjT5iljxkFxTj4qFh3GTJcX/YY+G6HjGPR7Yfz10zhdoCa36IgQnzmmYwpQmr6ru6EqqUdC4yyXXD6UPvtFgUPM/wCdCsloBUTO0tWnC9D1OxFzA7aj3/YEoeNkQUxKAQkfMJo0nL6rl4H3G522ux2OCCiKEe01jLZb5hCgffZhl8m3Hk/UZIRqOpBuBAdoN6Q9kIgiEjRGwWsDUl0G35e72ikdQv4OCVhHUGECg9El/TrjAA9LV4mZdT/BsxOvNmIBilMBvKx3zB8zV+QP5dCVIWAlfl/iV7SiYkGEEAgwio26F87HQAofJk+GHyMzfUP1JQGj+RNZznJ9wnsQfoIJtOxKoYYgwYRaDBgzWIRtG0e2NtodsOydidqAbSuV9BSEEEHQGGkINdaJUBKEBAgcQCA6CHQgwZc//9k=';

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normLink(value) {
    return String(value || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }

  function normTitle(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[«»"']/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function num(value) {
    const n = Number(String(value ?? 0).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function fmt(value) {
    const n = num(value);
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace('.', ',') + 'k';
    return String(Math.round(n));
  }

  function shortTitle(value, max = 25) {
    const text = String(value || 'Канал').replace(/^https?:\/\/max\.ru\//i, '').trim();
    return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
  }

  function goodAvatar(value) {
    const url = String(value || '').trim();
    if (!/^https?:\/\//i.test(url)) return false;
    if (url.includes('/s/img/og-logo.png')) return false;
    return true;
  }

  function directAvatar(ch) {
    for (const key of ['avatar_url', 'avatarUrl', 'photo_url', 'image_url', 'picture_url', 'avatar', 'photo', 'image']) {
      const value = String(ch?.[key] || '').trim();
      if (goodAvatar(value)) return value;
    }
    return '';
  }

  function extractRawInput() {
    for (const a of args) {
      if (Array.isArray(a)) return a;
      if (typeof a === 'string') {
        const links = a.match(/https?:\/\/max\.ru\/join\/[^\s]+/gi) || [];
        if (links.length) return links;
      }
      if (a && typeof a === 'object') {
        for (const key of ['channels', 'items', 'rows', 'data', 'all', 'visible', 'links']) {
          if (Array.isArray(a[key])) return a[key];
        }
      }
    }
    return [];
  }

  async function cachedAvatar(ch) {
    const direct = directAvatar(ch);
    if (direct) return direct;

    const link = normLink(ch?.link || ch?.url || ch?.key || ch?.channel_link || ch?.public_link || ch?.source_link || '');
    const title = normTitle(ch?.title || ch?.name || ch?.channel_title || ch?.channel_name || '');

    try {
      const db = await import('./db.js');
      const result = await db.query(
        `SELECT avatar_url
           FROM public.lr_channel_avatar_cache
          WHERE ($1 <> '' AND link_norm=$1)
             OR ($2 <> '' AND title_norm=$2)
             OR ($3 <> '' AND link=$3)
          ORDER BY updated_at DESC
          LIMIT 1`,
        [link, title, link]
      );

      const rows = Array.isArray(result) ? result : (result?.rows || []);
      const avatar = String(rows?.[0]?.avatar_url || '').trim();
      return goodAvatar(avatar) ? avatar : '';
    } catch {
      return '';
    }
  }

  async function dataImage(url) {
    if (!goodAvatar(url)) return '';

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(7000),
        headers: {
          'user-agent': 'Mozilla/5.0 LinkRayBot/1.0',
          'accept': 'image/png,image/jpeg,image/webp,image/*,*/*;q=0.8'
        }
      });

      if (!res.ok) return '';

      const type = String(res.headers.get('content-type') || 'image/png').split(';')[0] || 'image/png';
      const buffer = Buffer.from(await res.arrayBuffer());
      return `data:${type};base64,${buffer.toString('base64')}`;
    } catch {
      return '';
    }
  }

  async function brandLogo() {
    try {
      const fs = await import('node:fs/promises');
      const file = await fs.readFile('/app/public/brand/linkray-logo.svg');
      return `data:image/svg+xml;base64,${Buffer.from(file).toString('base64')}`;
    } catch {
      return '';
    }
  }

  function cleanChannel(item, idx) {
    if (typeof item === 'string') {
      return {
        link: normLink(item),
        title: item.replace(/^https?:\/\/max\.ru\//i, '').trim(),
        subscribers: 0,
        views24: 0,
        views48: 0,
        views72: 0,
        er24: 0
      };
    }

    const ch = item || {};
    const title =
      ch.title ||
      ch.name ||
      ch.channel_title ||
      ch.channel_name ||
      ch._lrTitle ||
      ch.link ||
      ch.url ||
      `Канал ${idx + 1}`;

    return {
      ...ch,
      title: String(title).replace(/^https?:\/\/max\.ru\//i, '').trim(),
      link: normLink(ch.link || ch.url || ch.key || ch.channel_link || ch.public_link || ch.source_link || ''),
      subscribers: num(ch.subscribers ?? ch.members ?? ch.subs ?? ch.pdp ?? 0),
      views24: num(ch.views24 ?? ch.views_24 ?? ch.views_day ?? 0),
      views48: num(ch.views48 ?? ch.views_48 ?? 0),
      views72: num(ch.views72 ?? ch.views_72 ?? 0),
      er24: num(ch.er24 ?? ch.er ?? 0)
    };
  }

  const rawInput = extractRawInput();
  const seen = new Set();
  const all = [];

  rawInput.forEach((item, idx) => {
    const ch = cleanChannel(item, idx);
    const key = ch.link || normTitle(ch.title) || String(idx);

    if (!seen.has(key)) {
      seen.add(key);
      all.push(ch);
    }
  });

  const visible = all.slice(0, 4);
  const totalSubs = all.reduce((sum, ch) => sum + num(ch.subscribers), 0);
  const total24 = all.reduce((sum, ch) => sum + num(ch.views24), 0);
  const total48 = all.reduce((sum, ch) => sum + num(ch.views48), 0);
  const total72 = all.reduce((sum, ch) => sum + num(ch.views72), 0);
  const er = totalSubs > 0 ? total24 / totalSubs * 100 : 0;

  const generatedAt = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).replace(',', '');

  const logo = await brandLogo();

  let rows = '';

  for (let i = 0; i < visible.length; i++) {
    const ch = visible[i];
    const y = 458 + i * 74;
    const avatarUrl = await cachedAvatar(ch);
    const avatarData = await dataImage(avatarUrl);

    let avatarSvg = '';

    if (avatarData) {
      const clip = `lrNetAv31_${i}`;
      avatarSvg = `
        <clipPath id="${clip}">
          <circle cx="492" cy="${y}" r="23"/>
        </clipPath>
        <circle cx="492" cy="${y}" r="26" fill="rgba(49,242,204,.18)" stroke="#32f3cf" stroke-width="3"/>
        <image href="${avatarData}" x="469" y="${y - 23}" width="46" height="46" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>
      `;
    } else {
      const letter = esc((ch.title || 'К')[0] || 'К').toUpperCase();
      avatarSvg = `
        <circle cx="492" cy="${y}" r="26" fill="rgba(49,242,204,.14)" stroke="#32f3cf" stroke-width="3"/>
        <text x="492" y="${y + 8}" text-anchor="middle" font-size="21" font-weight="900" fill="#eafffb">${letter}</text>
      `;
    }

    rows += `
      ${avatarSvg}
      <text x="530" y="${y + 9}" font-size="27" font-weight="900" fill="#ffffff">${esc(shortTitle(ch.title, 25))}</text>
      <text x="880" y="${y + 9}" text-anchor="middle" font-size="30" font-weight="1000" fill="#28d8ff">${fmt(ch.subscribers)}</text>
      <text x="1040" y="${y + 9}" text-anchor="middle" font-size="30" font-weight="1000" fill="#35f0ca">${fmt(ch.views24)}</text>
      ${i < visible.length - 1 ? `<line x1="470" y1="${y + 38}" x2="1125" y2="${y + 38}" stroke="rgba(255,255,255,.10)" stroke-width="1"/>` : ''}
    `;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#071a2c"/>
        <stop offset="45%" stop-color="#0b4f53"/>
        <stop offset="100%" stop-color="#16c58f"/>
      </linearGradient>
      <linearGradient id="card" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,.13)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,.06)"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#001827" flood-opacity=".32"/>
      </filter>
    </defs>

    <rect width="1280" height="900" fill="url(#bg)"/>
    <path d="M0 130 C260 70 440 190 680 115 C910 45 1080 105 1280 60" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="3"/>
    <path d="M0 755 C300 675 500 770 730 650 C925 545 1070 585 1280 515" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3"/>

    <text x="55" y="72" font-size="50" font-weight="1000" fill="#fff">Статистика сети каналов</text>
    <text x="56" y="112" font-size="22" font-weight="800" fill="rgba(255,255,255,.82)">LinkRay Analytics · сводка по всей сетке каналов</text>

    ${logo ? `<image href="${logo}" x="1015" y="26" width="76" height="76"/>` : `<circle cx="1053" cy="64" r="38" fill="rgba(49,242,204,.18)" stroke="#32f3cf" stroke-width="3"/>`}
    <text x="1112" y="82" font-size="38" font-weight="1000" fill="#ffffff">LinkRay</text>

    <rect x="55" y="155" rx="24" width="275" height="128" fill="url(#card)" stroke="rgba(125,255,231,.32)" filter="url(#shadow)"/>
    <text x="192" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Подписчики</text>
    <text x="192" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#25d9ff">${fmt(totalSubs)}</text>

    <rect x="352" y="155" rx="24" width="275" height="128" fill="url(#card)" stroke="rgba(125,255,231,.32)" filter="url(#shadow)"/>
    <text x="489" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Просмотры 24ч</text>
    <text x="489" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#35f0ca">${fmt(total24)}</text>

    <rect x="650" y="155" rx="24" width="275" height="128" fill="url(#card)" stroke="rgba(125,255,231,.32)" filter="url(#shadow)"/>
    <text x="787" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Общий ER</text>
    <text x="787" y="252" text-anchor="middle" font-size="52" font-weight="1000" fill="#27d9ff">${er.toFixed(2).replace('.', ',')}%</text>

    <rect x="948" y="155" rx="24" width="275" height="128" fill="url(#card)" stroke="rgba(125,255,231,.32)" filter="url(#shadow)"/>
    <text x="1085" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Каналов</text>
    <text x="1085" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#35f0ca">${fmt(all.length)}</text>

    <rect x="55" y="330" rx="26" width="305" height="300" fill="url(#card)" stroke="rgba(125,255,231,.32)" filter="url(#shadow)"/>
    <text x="90" y="390" font-size="35" font-weight="1000" fill="#ffffff">Просмотры</text>
    <text x="92" y="455" font-size="44" font-weight="1000" fill="#ffffff">24ч:</text>
    <text x="210" y="455" font-size="44" font-weight="1000" fill="#25d9ff">${fmt(total24)}</text>
    <text x="92" y="525" font-size="44" font-weight="1000" fill="#ffffff">48ч:</text>
    <text x="210" y="525" font-size="44" font-weight="1000" fill="#25d9ff">${fmt(total48)}</text>
    <text x="92" y="595" font-size="44" font-weight="1000" fill="#ffffff">72ч:</text>
    <text x="210" y="595" font-size="44" font-weight="1000" fill="#25d9ff">${fmt(total72)}</text>

    <rect x="390" y="330" rx="26" width="835" height="430" fill="url(#card)" stroke="rgba(125,255,231,.32)" filter="url(#shadow)"/>
    <text x="425" y="388" font-size="38" font-weight="1000" fill="#ffffff">Каналы</text>

    <text x="528" y="428" font-size="20" font-weight="900" fill="rgba(255,255,255,.62)">Канал</text>
    <text x="880" y="428" text-anchor="middle" font-size="20" font-weight="900" fill="rgba(255,255,255,.62)">ПДП</text>
    <text x="1040" y="428" text-anchor="middle" font-size="20" font-weight="900" fill="rgba(255,255,255,.62)">24ч</text>
    <line x1="470" y1="442" x2="1125" y2="442" stroke="rgba(255,255,255,.16)" stroke-width="1"/>

    ${rows}

    <text x="470" y="735" font-size="23" font-weight="1000" fill="#45ffd9">Суммы рассчитаны по всем каналам.</text>

    <text x="55" y="837" font-size="26" font-weight="1000" fill="#ffffff">Актуально на ${esc(generatedAt)} МСК</text>
    <text x="773" y="837" font-size="25" font-weight="900" fill="rgba(255,255,255,.82)">LinkRay — аналитика каналов MAX</text>
  </svg>`;

  console.log('[LR_NETWORK_RENDERER_V31]', JSON.stringify({
    count: all.length,
    visible: visible.map(v => ({ title: v.title, link: v.link }))
  }));

  try {
    const sharpMod = await import('sharp');
    const sharp = sharpMod.default || sharpMod;

    return await sharp(Buffer.from(lrV82BrightNegativeSvg(svg)))
      .png()
      .toBuffer();
  } catch (e) {
    console.error('[LR_NETWORK_RENDERER_V32_IMAGE_ERROR]', e?.message || e);
    return Buffer.from(svg);
  }

  /* LR_NETWORK_RENDERER_V32_END */
}


/* LR_VIEWS_RED_MENU_V82 */
function lrV82BrightNegativeSvg(svg) {
  return String(svg || '').replace(
    /<(text|tspan)\b([^>]*)>(\s*-\s*[\d\s.,%]+)\s*<\/\1>/gi,
    (full, tag, attrs, value) => {
      const cleanAttrs = String(attrs || '')
        .replace(/\sfill=(["']).*?\1/gi, '')
        .replace(/\sstroke=(["']).*?\1/gi, '')
        .replace(/\sstroke-width=(["']).*?\1/gi, '')
        .replace(/\spaint-order=(["']).*?\1/gi, '')
        .replace(/\sfont-weight=(["']).*?\1/gi, '');

      return `<${tag}${cleanAttrs} fill="#ff1744" stroke="#4a0010" stroke-width="0.9" paint-order="stroke" font-weight="1000">${value}</${tag}>`;
    }
  );
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

  await sharp(Buffer.from(lrV82BrightNegativeSvg(svg))).png().toFile(filePath);

  const publicUrl = `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/generated/channel-analytics/${fileName}`;

  return { filePath, publicUrl };
}

/* LR_ANALYTICS_NEW_MAIN_MESSAGE_V83_1 */
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
        ...lrMenuButtons([[lrCb('🏠 Главное меню', 'lrchan:main:new')]]),
      ],
    });
  } catch (error) {

      /* LR_RAW_MAX_IMAGE_UPLOAD_V33_CALL_START */
      try {
        const lrV33Candidate =
          (typeof imageBuffer !== 'undefined' && imageBuffer) ||
          (typeof pngBuffer !== 'undefined' && pngBuffer) ||
          (typeof cardBuffer !== 'undefined' && cardBuffer) ||
          (typeof buffer !== 'undefined' && buffer) ||
          (typeof png !== 'undefined' && png) ||
          (typeof image !== 'undefined' && image) ||
          (typeof img !== 'undefined' && img) ||
          (typeof card !== 'undefined' && card) ||
          (typeof result !== 'undefined' && result) ||
          null;

        const lrV33KnownTarget = {
          chatId:
            (typeof chatId !== 'undefined' && chatId) ||
            (typeof chat_id !== 'undefined' && chat_id) ||
            null,
          userId:
            (typeof userId !== 'undefined' && userId) ||
            (typeof user_id !== 'undefined' && user_id) ||
            null,
        };

        const lrV33FromUpdate =
          (typeof update !== 'undefined' && update) ? lrV33TargetFromUpdate(update) :
          (typeof ctx !== 'undefined' && ctx) ? lrV33TargetFromUpdate(ctx) :
          {};

        const lrV33Target = {
          chatId: lrV33KnownTarget.chatId || lrV33FromUpdate.chatId,
          userId: lrV33KnownTarget.userId || lrV33FromUpdate.userId,
        };

        const lrV33Caption = lrV44AnalyticsCaption((typeof channels !== 'undefined' && channels) || (typeof clean !== 'undefined' && clean) || (typeof all !== 'undefined' && all) || (typeof visible !== 'undefined' && visible) || (typeof list !== 'undefined' && list) || []);

        if (lrV33Candidate && (lrV33Target.chatId || lrV33Target.userId)) {
          await lrV33SendImageByRawMax(lrV33Target, lrV33Candidate, lrV33Caption);
          return true;
        }
      } catch (lrV33Err) {
        console.error('[LR_RAW_MAX_IMAGE_UPLOAD_V33_ERROR]', lrV33Err?.message || lrV33Err);
      }
      /* LR_RAW_MAX_IMAGE_UPLOAD_V33_CALL_END */
    console.error('[LinkRay channel analytics send image]', error.message || error);

    await sendMaxMessage({
      chatId,
      text: `${text}\n\n${image.publicUrl}`,
      format: 'html',
      attachments: lrMenuButtons([
        [lrCb('🏠 Главное меню', 'lrchan:main:new')],
      ]),
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


/* LR_CHANNEL_DATA_READY_WARNING_V1_START */
function lrChannelReadyAtMsk(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'после следующего успешного сбора';
  return date.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(',', '');
}

function lrChannelReadyTitleList(readiness) {
  const channels = Array.isArray(readiness?.channels) ? readiness.channels : [];
  return channels
    .filter((channel) => !channel.ready)
    .map((channel) => String(channel.title || 'Канал MAX').trim())
    .filter(Boolean)
    .slice(0, 6);
}

async function lrSendChannelDataNotReady(chatId, readiness, update = null) {
  const missing = Array.isArray(readiness?.missing) ? readiness.missing : [];
  const titles = lrChannelReadyTitleList(readiness);
  let text = '';

  if (missing.length) {
    text =
      '⚠️ Отчёт пока не может быть сформирован\n\n' +
      'Один или несколько каналов ещё не подключены к сбору аналитики либо бот не имеет прав администратора.\n\n' +
      'Таймер: не запущен.\n' +
      'Отсчёт начнётся автоматически после успешного подключения канала и первого замера.\n\n' +
      'Проверьте, что канал добавлен в LinkRay и бот назначен администратором.';
  } else {
    const countdown = String(readiness?.countdown || '00:10:00');
    const readyAt = lrChannelReadyAtMsk(readiness?.readyAt);
    const channelLine = titles.length
      ? `\nКаналы: ${titles.join(', ')}\n`
      : '\n';
    const reasonLine = readiness?.reason === 'collection_error'
      ? 'Последний сбор завершился ошибкой. LinkRay повторит попытку автоматически.\n\n'
      : '';

    text =
      '⚠️ Отчёт пока не может быть сформирован\n\n' +
      'LinkRay уже собирает исходные данные. Полный отчёт станет доступен после накопления минимум 24 часов данных с момента включения аналитики на канал. Подписки и отписки считаются сразу.\n' +
      channelLine +
      reasonLine +
      `⏳ До готовности: ${countdown}\n` +
      `Ориентировочно отчёт будет готов: ${readyAt} МСК.`;
  }

  const buttons = [
    [lrCb('🔄 Обновить таймер', 'lrchan:ready_refresh')],
    [lrCb('⬅️ В аналитику', 'lrchan:menu')],
  ];

  if (update && typeof lrEditOrSendV3 === 'function') {
    await lrEditOrSendV3(update, chatId, text, buttons);
    return;
  }

  await sendMaxMessage({
    chatId,
    text,
    format: 'html',
    attachments: lrMenuButtons(buttons),
  });
}
/* LR_CHANNEL_DATA_READY_WARNING_V1_END */

async function handleLinks(chatId, links, update = null) {
  await saveUserLinks(chatId, links);
  /* LR_CHANNEL_DATA_READY_CHECK_V1 */
  const readiness = await getChannelMetricsReadiness(links);
  if (!readiness.ready) {
    await lrSendChannelDataNotReady(chatId, readiness, update);
    return false;
  }

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
  /* LR_LEGACY_DAILY_READY_CHECK_V1 */
  const readiness = await getChannelMetricsReadiness(links);
  if (!readiness.ready) {
    await lrSendChannelDataNotReady(chatId, readiness, null);
    return;
  }

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
  await lrV73EnsureDailyChannelTable();
  const result = await query(`
    SELECT d.owner_chat_id, c.id, c.max_chat_id, c.title, c.link
    FROM public.lr_channel_analytics_daily_channels d
    JOIN public.channels c ON c.id = d.channel_id
    WHERE d.enabled = true AND c.is_active = true
    ORDER BY d.owner_chat_id, lower(coalesce(c.title, '')), c.id
  `).catch(() => []);

  const grouped = new Map();
  for (const row of rows(result)) {
    const owner = String(row.owner_chat_id);
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(row);
  }

  for (const [owner, channelRows] of grouped.entries()) {
    try {
      await lrV73SendDailyGroup(owner, channelRows);
    } catch (error) {
      console.error('[v73 daily] send failed', error?.stack || error);
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
    /^(main:analytics|analytics:menu|lrchan:menu|lrchan:links|lrchan:daily|lrchan:on|lrchan:off|lrchan:ready_refresh|main:menu)$/.test(String(s))
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
    '🖼 <b>Аналитика каналов</b> — отправьте ссылку канала или несколько ссылок, бот сделает PNG-карточку.\n\n' +
    '📆 <b>Ежедневный отчёт ПДП</b> — отчёт каждый день в 08:00 МСК: подписки, отписки и общий итог.\n' +
    '━━━━━━━━━━━━━━',
    [
      [lrCb('🖼 Аналитика каналов', 'lrchan:links')],
      [lrCb('📆📅 Ежедневный отчёт ПДП', 'lrchan:daily')],
      [lrCb(
          '👥 Подписки и отписки',
          'lr_audience:menu'
        )],
        [lrCb('⬅️ Главное меню', 'main:menu')],
    ]
  );
}

async function showAnalyticsLinkInput(chatId, keys, update = null) {
  await setAnalyticsModeForKeys(keys, 'await_links');

  await lrEditOrSendV3(update, chatId,
    '━━━━━━━━━━━━━━\n' +
    '🖼 <b>Аналитика каналов</b>\n\n' +
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
  const channels = await lrV73DailyChannelRows(chatId);
  const enabledCount = channels.filter((channel) => Boolean(channel.enabled)).length;
  const keyboard = [];

  for (const channel of channels) {
    keyboard.push([
      lrCb(
        `${channel.enabled ? '✅' : '➖'} ${lrV73ShortTitle(channel.title)}`,
        `lrchan:daily_toggle:${channel.id}`
      ),
    ]);
  }

  if (channels.length) {
    keyboard.push([
      lrCb('✅ Включить все', 'lrchan:daily_all:on'),
      lrCb('➖ Выключить все', 'lrchan:daily_all:off'),
    ]);
  }

  keyboard.push([lrCb('⬅️ В аналитику', 'lrchan:menu')]);

  await lrEditOrSendV3(
    update,
    chatId,
    '━━━━━━━━━━━━━━\n' +
      '📅 <b>Ежедневный отчёт ПДП</b>\n\n' +
      `Каналов подключено: <b>${channels.length}</b>\n` +
      `Отчёт включён: <b>${enabledCount}</b>\n\n` +
      'Нажмите на канал, чтобы включить или выключить отчёт отдельно.\n' +
      'Каждый день в 08:00 МСК бот пришлёт показатели только по отмеченным каналам.\n' +
      '━━━━━━━━━━━━━━',
    keyboard
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

  // Полное главное меню открывает центральный обработчик LinkRay.
  // Возвращаем false, чтобы аналитика не подменяла его резервным меню.
  if (payload === 'main:menu') return false;

  const text = getText(update);
  const links = lrLinksDeep(update, text);
  /* LR_CHANNEL_READY_REFRESH_V1 */
  if (payload === 'lrchan:ready_refresh') {
    const saved = await getAnalyticsSettingsForKeys(keys);
    const savedLinks = Array.isArray(saved?.links) ? saved.links : [];
    if (!savedLinks.length) {
      await showAnalyticsLinkInput(chatId, keys, update);
      return true;
    }
    await handleLinks(chatId, savedLinks, update);
    return true;
  }


  if (payload.startsWith('lrchan:daily_toggle:')) {
    const channelId = Number(payload.split(':').pop());
    if (Number.isFinite(channelId) && channelId > 0) {
      const channelRows = await lrV73DailyChannelRows(chatId);
      const current = channelRows.find((channel) => Number(channel.id) === channelId);
      await lrV73SetChannelDaily(chatId, channelId, !Boolean(current?.enabled));
    }
    await showDailyPdpMenu(chatId, keys, update);
    return true;
  }

  if (payload === 'lrchan:daily_all:on') {
    await lrV73SetAllDaily(chatId, true);
    await showDailyPdpMenu(chatId, keys, update);
    return true;
  }

  if (payload === 'lrchan:daily_all:off') {
    await lrV73SetAllDaily(chatId, false);
    await showDailyPdpMenu(chatId, keys, update);
    return true;
  }



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
    await lrV73SetAllDaily(chatId, true);
    await showDailyPdpMenu(chatId, keys, update);
    return true;
  }

  if (payload === 'lrchan:off') {
    await lrV73SetAllDaily(chatId, false);
    await showDailyPdpMenu(chatId, keys, update);
    return true;
  }

  if (lrIsAnalyticsText(text)) {
    await showAnalyticsMainMenu(chatId, keys, update);
    return true;
  }

  const settings = await getAnalyticsSettingsForKeys(keys);

  // Главное исправление:
  // если открыт режим "🖼 Аналитика каналов" или сообщение состоит только из MAX-ссылок,
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


/* LR_RAW_MAX_IMAGE_UPLOAD_V33_START */
function lrV33MaxToken() {
  return (
    process.env.MAX_BOT_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.MAX_TOKEN ||
    process.env.MAX_API_TOKEN ||
    process.env.BOT_API_TOKEN ||
    process.env.ACCESS_TOKEN ||
    process.env.TOKEN ||
    ''
  ).trim();
}

function lrV33ApiBase() {
  return (process.env.MAX_API_BASE || process.env.MAX_API_URL || 'https://platform-api2.max.ru')
    .replace(/\/+$/, '');
}

function lrV33TargetFromUpdate(update) {
  const chatId =
    update?.message?.recipient?.chat_id ||
    update?.message?.body?.recipient?.chat_id ||
    update?.message?.chat_id ||
    update?.chat_id ||
    update?.recipient?.chat_id ||
    update?.callback?.message?.recipient?.chat_id ||
    update?.callback?.chat_id ||
    null;

  const userId =
    update?.message?.sender?.user_id ||
    update?.message?.user_id ||
    update?.user_id ||
    update?.callback?.user?.user_id ||
    update?.callback?.user_id ||
    update?.callback?.message?.sender?.user_id ||
    null;

  return { chatId, userId };
}

function lrV33UrlToken(url) {
  try {
    const u = new URL(String(url || ''));
    return (
      u.searchParams.get('token') ||
      u.searchParams.get('file_token') ||
      u.searchParams.get('upload_token') ||
      ''
    );
  } catch {
    return '';
  }
}

async function lrV33ToPngBuffer(imageLike) {
  if (!imageLike) return null;

  if (Buffer.isBuffer(imageLike)) return imageLike;

  if (imageLike instanceof Uint8Array) {
    return Buffer.from(imageLike);
  }

  if (typeof imageLike === 'object') {
    if (Buffer.isBuffer(imageLike.buffer)) return imageLike.buffer;
    if (Buffer.isBuffer(imageLike.data)) return imageLike.data;
    if (Buffer.isBuffer(imageLike.png)) return imageLike.png;
    if (Buffer.isBuffer(imageLike.image)) return imageLike.image;
  }

  if (typeof imageLike === 'string') {
    const text = imageLike.trim();

    if (text.startsWith('data:image/')) {
      const base64 = text.split(',')[1] || '';
      if (base64) return Buffer.from(base64, 'base64');
    }

    if (text.startsWith('<svg') || text.includes('<svg')) {
      const sharpMod = await import('sharp');
      const sharp = sharpMod.default || sharpMod;
      return await sharp(Buffer.from(text)).png().toBuffer();
    }
  }

  return null;
}

async function lrV33UploadImageAndGetToken(pngBuffer) {
  const accessToken = lrV33MaxToken();

  if (!accessToken) {
    throw new Error('MAX token not found in env');
  }

  const api = lrV33ApiBase();

  const createUpload = await fetch(`${api}/uploads?type=image`, {
    method: 'POST',
    headers: {
      Authorization: accessToken,
    },
  });

  const createText = await createUpload.text();
  let createJson = {};

  try {
    createJson = JSON.parse(createText);
  } catch {}

  if (!createUpload.ok) {
    throw new Error(`create upload failed ${createUpload.status}: ${createText}`);
  }

  const uploadUrl = String(createJson.url || createJson.upload_url || createJson.href || '').trim();

  if (!uploadUrl) {
    throw new Error(`upload url not returned: ${createText}`);
  }

  const form = new FormData();
  form.append('data', new Blob([pngBuffer], { type: 'image/png' }), `linkray-analytics-${Date.now()}.png`);

  const upload = await fetch(uploadUrl, {
    method: 'POST',
    body: form,
  });

  const uploadText = await upload.text();
  let uploadJson = {};

  try {
    uploadJson = JSON.parse(uploadText);
  } catch {}

  if (!upload.ok) {
    throw new Error(`upload image failed ${upload.status}: ${uploadText}`);
  }

  function pickToken(obj) {
    if (!obj || typeof obj !== 'object') return '';

    if (typeof obj.token === 'string' && obj.token.trim()) return obj.token.trim();
    if (typeof obj.file_token === 'string' && obj.file_token.trim()) return obj.file_token.trim();
    if (typeof obj.upload_token === 'string' && obj.upload_token.trim()) return obj.upload_token.trim();

    for (const key of ['payload', 'retval', 'photo', 'image', 'file']) {
      const nested = pickToken(obj[key]);
      if (nested) return nested;
    }

    for (const key of ['photos', 'images', 'files', 'attachments']) {
      const bucket = obj[key];

      if (bucket && typeof bucket === 'object') {
        if (Array.isArray(bucket)) {
          for (const item of bucket) {
            const nested = pickToken(item);
            if (nested) return nested;
          }
        } else {
          for (const item of Object.values(bucket)) {
            const nested = pickToken(item);
            if (nested) return nested;
          }
        }
      }
    }

    return '';
  }

  const token =
    pickToken(uploadJson) ||
    pickToken(createJson) ||
    lrV33UrlToken(uploadUrl);


  if (!token) {
    throw new Error(`image token not returned: ${uploadText || createText}`);
  }

  return token;
}

async function lrV33SendImageByRawMax(target, imageLike, text = '') {
  const pngBuffer = await lrV33ToPngBuffer(imageLike);

  if (!pngBuffer || !pngBuffer.length) {
    throw new Error('PNG buffer is empty');
  }

  const accessToken = lrV33MaxToken();

  if (!accessToken) {
    throw new Error('MAX token not found in env');
  }

  const chatId = target?.chatId || target?.chat_id || null;
  const userId = target?.userId || target?.user_id || null;

  const query =
    chatId ? `chat_id=${encodeURIComponent(chatId)}` :
    userId ? `user_id=${encodeURIComponent(userId)}` :
    '';

  if (!query) {
    throw new Error('chat_id/user_id not found for image send');
  }

  const token = await lrV33UploadImageAndGetToken(pngBuffer);
  const api = lrV33ApiBase();

  const body = {
    text: text || '',
    format: 'html',
    attachments: [
      {
        type: 'image',
        payload: { token },
      },
    ],
  };

  const send = await fetch(`${api}/messages?${query}`, {
    method: 'POST',
    headers: {
      Authorization: accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const sendText = await send.text();

  if (!send.ok) {
    throw new Error(`send image message failed ${send.status}: ${sendText}`);
  }

  console.log('[LR_RAW_MAX_IMAGE_UPLOAD_V33] sent image by token');
  return true;
}
/* LR_RAW_MAX_IMAGE_UPLOAD_V33_END */


/* LR_DIRECT_PUBLIC_IMAGE_V34_START */
function lrV34MaxToken() {
  return (
    process.env.MAX_BOT_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.MAX_TOKEN ||
    process.env.MAX_API_TOKEN ||
    process.env.BOT_API_TOKEN ||
    process.env.ACCESS_TOKEN ||
    process.env.TOKEN ||
    ''
  ).trim();
}

function lrV34ApiBase() {
  return (process.env.MAX_API_BASE || process.env.MAX_API_URL || 'https://platform-api2.max.ru').replace(/\/+$/, '');
}

function lrV34PublicBase() {
  return (
    process.env.LINKRAY_PUBLIC_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.APP_PUBLIC_URL ||
    process.env.WEBAPP_URL ||
    process.env.BASE_URL ||
    'https://linkray.ru'
  ).replace(/\/+$/, '');
}

function lrV34TextFromUpdate(update) {
  return String(
    update?.message?.body?.text ||
    update?.message?.text ||
    update?.text ||
    update?.callback?.message?.body?.text ||
    update?.callback?.message?.text ||
    ''
  );
}

function lrV34TargetFromUpdate(update) {
  const chatId =
    update?.message?.recipient?.chat_id ||
    update?.message?.body?.recipient?.chat_id ||
    update?.message?.chat_id ||
    update?.chat_id ||
    update?.recipient?.chat_id ||
    update?.callback?.message?.recipient?.chat_id ||
    update?.callback?.message?.chat_id ||
    update?.callback?.chat_id ||
    null;

  const userId =
    update?.message?.sender?.user_id ||
    update?.message?.user_id ||
    update?.user_id ||
    update?.callback?.user?.user_id ||
    update?.callback?.user_id ||
    update?.callback?.message?.sender?.user_id ||
    null;

  return { chatId, userId };
}

function lrV34ExtractLinks(text) {
  const raw = String(text || '').match(/https?:\/\/max\.ru\/join\/[^\s<>"']+/gi) || [];
  const out = [];
  const seen = new Set();

  for (const item of raw) {
    const link = item.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!seen.has(link)) {
      seen.add(link);
      out.push(link);
    }
  }

  return out;
}

function lrV34NormLink(value) {
  return String(value || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

function lrV34NormTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lrV34GoodAvatar(value) {
  const s = String(value || '').trim();
  return /^https?:\/\//i.test(s) && !s.includes('/s/img/og-logo.png');
}

async function lrV34LoadChannelsByLinks(links) {
  const channels = [];

  for (let i = 0; i < links.length; i++) {
    const link = lrV34NormLink(links[i]);

    let ch = {
      link,
      title: `Канал ${i + 1}`,
      subscribers: 0,
      views24: 0,
      views48: 0,
      views72: 0,
      er24: 0,
    };

    try {
      const db = await import('./db.js');

      const cached = await db.query(
        `SELECT title, avatar_url
           FROM public.lr_channel_avatar_cache
          WHERE link_norm=$1 OR link=$1
          ORDER BY updated_at DESC
          LIMIT 1`,
        [link]
      );

      const cachedRows = Array.isArray(cached) ? cached : (cached?.rows || []);

      if (cachedRows[0]) {
        if (cachedRows[0].title && !String(cachedRows[0].title).startsWith('max.ru/join')) {
          ch.title = cachedRows[0].title;
        }

        if (lrV34GoodAvatar(cachedRows[0].avatar_url)) {
          ch.avatar_url = cachedRows[0].avatar_url;
        }
      }

      const snap = await db.query(
        `SELECT title, avatar_url, subscribers, views24, views48, views72, er24
           FROM public.lr_channel_analytics_snapshots
          WHERE link=$1
          ORDER BY captured_at DESC
          LIMIT 1`,
        [link]
      );

      const snapRows = Array.isArray(snap) ? snap : (snap?.rows || []);

      if (snapRows[0]) {
        const row = snapRows[0];

        if (row.title && !String(row.title).startsWith('max.ru/join')) ch.title = row.title;
        if (lrV34GoodAvatar(row.avatar_url)) ch.avatar_url = row.avatar_url;

        ch.subscribers = Number(row.subscribers || 0);
        ch.views24 = Number(row.views24 || 0);
        ch.views48 = Number(row.views48 || 0);
        ch.views72 = Number(row.views72 || 0);
        ch.er24 = Number(row.er24 || 0);
      }
    } catch {}

    channels.push(ch);
  }

  return channels;
}


/* LR_SAFE_NETWORK_CARD_V37_START */
async function lrV37RenderPrettyNetworkPng(channels = []) {
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default || sharpMod;

  const WIDTH = 1280;
  const HEIGHT = 900;

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function num(v) {
    const n = Number(String(v ?? 0).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function fmt(v) {
    const n = num(v);
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace('.', ',') + 'k';
    return String(Math.round(n));
  }

  function short(v, max = 26) {
    const text = String(v || 'Канал').trim();
    return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
  }

  function goodUrl(v) {
    const u = String(v || '').trim();
    return /^https?:\/\//i.test(u) && !u.includes('/s/img/og-logo.png');
  }

  async function dataPng(url, size = 52) {
    if (!goodUrl(url)) return '';

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(9000),
        headers: {
          'user-agent': 'Mozilla/5.0 LinkRayBot/1.0',
          'accept': 'image/png,image/jpeg,image/webp,image/*,*/*;q=0.8'
        }
      });

      if (!res.ok) return '';

      const input = Buffer.from(await res.arrayBuffer());
      const out = await sharp(input).resize(size, size, { fit: 'cover' }).png().toBuffer();

      return `data:image/png;base64,${out.toString('base64')}`;
    } catch {
      return '';
    }
  }

  async function logoData() {
    try {
      const fs = await import('node:fs/promises');

      for (const file of [
        '/app/public/brand/linkray-logo.png',
        '/app/public/brand/linkray-logo.jpg',
        '/app/public/brand/linkray-logo.svg',
        '/app/public/brand/logo.png',
      ]) {
        try {
          const buf = await fs.readFile(file);
          const ext = file.toLowerCase().endsWith('.svg') ? 'svg+xml' : file.toLowerCase().endsWith('.jpg') ? 'jpeg' : 'png';
          return `data:image/${ext};base64,${buf.toString('base64')}`;
        } catch {}
      }
    } catch {}

    return '';
  }

  const clean = [];
  const seen = new Set();

  for (let i = 0; i < channels.length; i++) {
    const raw = channels[i] || {};
    const title = String(raw.title || raw.name || raw.channel_title || raw.channel_name || `Канал ${i + 1}`)
      .replace(/^https?:\/\/max\.ru\//i, '')
      .trim();

    const link = String(raw.link || raw.url || raw.key || raw.channel_link || raw.public_link || '').trim();
    const key = link || title || String(i);

    if (seen.has(key)) continue;
    seen.add(key);

    clean.push({
      title,
      link,
      avatar: raw.avatar_url || raw.avatarUrl || raw.photo_url || raw.image_url || raw.avatar || raw.photo || raw.image || '',
      subscribers: num(raw.subscribers || raw.members || raw.subs || raw.pdp || 0),
      views24: num(raw.views24 || raw.views_24 || raw.views_day || 0),
      views48: num(raw.views48 || raw.views_48 || 0),
      views72: num(raw.views72 || raw.views_72 || 0),
    });
  }

  const visible = clean.slice(0, 4);

  const totalSubs = clean.reduce((a, c) => a + c.subscribers, 0);
  const total24 = clean.reduce((a, c) => a + c.views24, 0);
  const total48 = clean.reduce((a, c) => a + c.views48, 0);
  const total72 = clean.reduce((a, c) => a + c.views72, 0);
  const er = totalSubs > 0 ? total24 / totalSubs * 100 : 0;

  const now = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).replace(',', '');

  const logo = await logoData();

  let rows = '';

  for (let i = 0; i < visible.length; i++) {
    const ch = visible[i];
    const y = 452 + i * 74;
    const avatar = await dataPng(ch.avatar, 52);
    const letter = esc((ch.title || 'К')[0] || 'К').toUpperCase();

    rows += `
      <g>
        <circle cx="500" cy="${y}" r="28" fill="rgba(42,255,209,.14)" stroke="#33f1cf" stroke-width="3"/>
        ${
          avatar
            ? `<clipPath id="av37_${i}"><circle cx="500" cy="${y}" r="24"/></clipPath><image href="${avatar}" x="476" y="${y - 24}" width="48" height="48" preserveAspectRatio="xMidYMid slice" clip-path="url(#av37_${i})"/>`
            : `<text x="500" y="${y + 8}" text-anchor="middle" font-size="21" font-weight="900" fill="#ecfffb">${letter}</text>`
        }
        <text x="540" y="${y + 10}" font-size="26" font-weight="900" fill="#ffffff">${esc(short(ch.title, 17))}</text>
        <text x="920" y="${y + 10}" text-anchor="middle" font-size="29" font-weight="1000" fill="#28d8ff">${fmt(ch.subscribers)}</text>
        <text x="1065" y="${y + 10}" text-anchor="middle" font-size="29" font-weight="1000" fill="#38f0cb">${fmt(ch.views24)}</text>
        ${i < visible.length - 1 ? `<line x1="470" y1="${y + 38}" x2="1135" y2="${y + 38}" stroke="rgba(255,255,255,.10)" stroke-width="1"/>` : ''}
      </g>
    `;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#061525"/>
        <stop offset="45%" stop-color="#0b4f53"/>
        <stop offset="100%" stop-color="#13bf8e"/>
      </linearGradient>
      <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,.15)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,.06)"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#001827" flood-opacity=".33"/>
      </filter>
    </defs>

    <rect width="1280" height="900" fill="url(#bg)"/>
    <path d="M-40 125 C230 62 455 185 680 108 C910 30 1070 105 1320 58" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="3"/>
    <path d="M-20 750 C280 665 500 780 730 650 C930 538 1085 585 1320 500" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3"/>

    <text x="56" y="74" font-size="50" font-weight="1000" fill="#ffffff">Статистика сети каналов</text>
    <text x="58" y="113" font-size="22" font-weight="800" fill="rgba(255,255,255,.82)">LinkRay Analytics · сводка по всей сетке каналов</text>

    ${logo ? `<image href="${logo}" x="1013" y="24" width="82" height="82"/>` : `<circle cx="1054" cy="65" r="38" fill="rgba(49,242,204,.18)" stroke="#32f3cf" stroke-width="3"/>`}
    <text x="1115" y="84" font-size="38" font-weight="1000" fill="#ffffff">LinkRay</text>

    <rect x="55" y="155" rx="24" width="275" height="128" fill="url(#glass)" stroke="rgba(125,255,231,.34)" filter="url(#shadow)"/>
    <text x="192" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Подписчики</text>
    <text x="192" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#25d9ff">${fmt(totalSubs)}</text>

    <rect x="352" y="155" rx="24" width="275" height="128" fill="url(#glass)" stroke="rgba(125,255,231,.34)" filter="url(#shadow)"/>
    <text x="489" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Просмотры 24ч</text>
    <text x="489" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#35f0ca">${fmt(total24)}</text>

    <rect x="650" y="155" rx="24" width="275" height="128" fill="url(#glass)" stroke="rgba(125,255,231,.34)" filter="url(#shadow)"/>
    <text x="787" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Общий ER</text>
    <text x="787" y="252" text-anchor="middle" font-size="52" font-weight="1000" fill="#27d9ff">${er.toFixed(2).replace('.', ',')}%</text>

    <rect x="948" y="155" rx="24" width="275" height="128" fill="url(#glass)" stroke="rgba(125,255,231,.34)" filter="url(#shadow)"/>
    <text x="1085" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Каналов</text>
    <text x="1085" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#35f0ca">${fmt(clean.length)}</text>

    <rect x="55" y="330" rx="26" width="305" height="300" fill="url(#glass)" stroke="rgba(125,255,231,.34)" filter="url(#shadow)"/>
    <text x="90" y="390" font-size="35" font-weight="1000" fill="#ffffff">Просмотры</text>
    <text x="92" y="455" font-size="44" font-weight="1000" fill="#ffffff">24ч:</text>
    <text x="210" y="455" font-size="44" font-weight="1000" fill="#25d9ff">${fmt(total24)}</text>
    <text x="92" y="525" font-size="44" font-weight="1000" fill="#ffffff">48ч:</text>
    <text x="210" y="525" font-size="44" font-weight="1000" fill="#25d9ff">${fmt(total48)}</text>
    <text x="92" y="595" font-size="44" font-weight="1000" fill="#ffffff">72ч:</text>
    <text x="210" y="595" font-size="44" font-weight="1000" fill="#25d9ff">${fmt(total72)}</text>

    <rect x="390" y="330" rx="26" width="835" height="430" fill="url(#glass)" stroke="rgba(125,255,231,.34)" filter="url(#shadow)"/>
    <text x="425" y="388" font-size="38" font-weight="1000" fill="#ffffff">Каналы</text>

    <text x="540" y="428" font-size="20" font-weight="900" fill="rgba(255,255,255,.65)">Название</text>
    <text x="920" y="428" text-anchor="middle" font-size="20" font-weight="900" fill="rgba(255,255,255,.65)">ПДП</text>
    <text x="1065" y="428" text-anchor="middle" font-size="20" font-weight="900" fill="rgba(255,255,255,.65)">24ч</text>
    <line x1="470" y1="442" x2="1135" y2="442" stroke="rgba(255,255,255,.16)" stroke-width="1"/>

    ${rows}

    <text x="470" y="735" font-size="23" font-weight="1000" fill="#45ffd9">Суммы рассчитаны по всем каналам.</text>

    <text x="55" y="837" font-size="26" font-weight="1000" fill="#ffffff">Актуально на ${esc(now)} МСК</text>
    <text x="770" y="837" font-size="25" font-weight="900" fill="rgba(255,255,255,.82)">LinkRay — автопостинг, закупы и аналитика MAX</text>
  </svg>`;

  console.log('[LR_SAFE_NETWORK_CARD_V37]', JSON.stringify({
    count: clean.length,
    visible: visible.map(x => ({ title: x.title, avatar: Boolean(x.avatar) }))
  }));

  return await sharp(Buffer.from(lrV82BrightNegativeSvg(svg))).png().toBuffer();
}
/* LR_SAFE_NETWORK_CARD_V37_END */


/* LR_NETWORK_CARD_LAYOUT_V38_START */
async function lrV38RenderCleanNetworkPng(channels = []) {
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default || sharpMod;

  const WIDTH = 1280;
  const HEIGHT = 900;

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function num(v) {
    const n = Number(String(v ?? 0).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function fmt(v) {
    const n = num(v);
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace('.', ',') + 'k';
    return String(Math.round(n));
  }

  function short(v, max = 17) {
    const text = String(v || 'Канал').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
  }

  function goodUrl(v) {
    const u = String(v || '').trim();
    return /^https?:\/\//i.test(u) && !u.includes('/s/img/og-logo.png');
  }

  async function dataPng(url, size = 50) {
    if (!goodUrl(url)) return '';

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(9000),
        headers: {
          'user-agent': 'Mozilla/5.0 LinkRayBot/1.0',
          'accept': 'image/png,image/jpeg,image/webp,image/*,*/*;q=0.8'
        }
      });

      if (!res.ok) return '';

      const input = Buffer.from(await res.arrayBuffer());
      const out = await sharp(input)
        .resize(size, size, { fit: 'cover' })
        .png()
        .toBuffer();

      return `data:image/png;base64,${out.toString('base64')}`;
    } catch {
      return '';
    }
  }

  const clean = [];
  const seen = new Set();

  for (let i = 0; i < channels.length; i++) {
    const raw = channels[i] || {};

    const title = String(
      raw.title ||
      raw.name ||
      raw.channel_title ||
      raw.channel_name ||
      `Канал ${i + 1}`
    ).replace(/^https?:\/\/max\.ru\//i, '').replace(/\s+/g, ' ').trim();

    const link = String(raw.link || raw.url || raw.key || raw.channel_link || raw.public_link || '').trim();
    const key = link || title || String(i);

    if (seen.has(key)) continue;
    seen.add(key);

    clean.push({
      title,
      link,
      avatar: raw.avatar_url || raw.avatarUrl || raw.photo_url || raw.image_url || raw.picture_url || raw.avatar || raw.photo || raw.image || '',
      subscribers: num(raw.subscribers || raw.members || raw.subs || raw.pdp || 0),
      views24: num(raw.views24 || raw.views_24 || raw.views_day || 0),
      views48: num(raw.views48 || raw.views_48 || 0),
      views72: num(raw.views72 || raw.views_72 || 0),
    });
  }

  const visible = clean.slice(0, 4);

  const totalSubs = clean.reduce((a, c) => a + c.subscribers, 0);
  const total24 = clean.reduce((a, c) => a + c.views24, 0);
  const total48 = clean.reduce((a, c) => a + c.views48, 0);
  const total72 = clean.reduce((a, c) => a + c.views72, 0);
  const er = totalSubs > 0 ? total24 / totalSubs * 100 : 0;

  const now = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).replace(',', '');

  let rows = '';

  for (let i = 0; i < visible.length; i++) {
    const ch = visible[i];
    const y = 454 + i * 72;
    const av = await dataPng(ch.avatar, 50);
    const letter = esc((ch.title || 'К')[0] || 'К').toUpperCase();

    rows += `
      <g>
        <circle cx="497" cy="${y}" r="27" fill="rgba(46,255,212,.16)" stroke="#35f2cf" stroke-width="3"/>
        ${
          av
            ? `<clipPath id="av38_${i}"><circle cx="497" cy="${y}" r="23"/></clipPath><image href="${av}" x="474" y="${y - 23}" width="46" height="46" preserveAspectRatio="xMidYMid slice" clip-path="url(#av38_${i})"/>`
            : `<text x="497" y="${y + 8}" text-anchor="middle" font-size="20" font-weight="900" fill="#ecfffb">${letter}</text>`
        }

        <clipPath id="titleClip38_${i}">
          <rect x="535" y="${y - 26}" width="250" height="44" rx="0"/>
        </clipPath>

        <text x="535" y="${y + 8}" clip-path="url(#titleClip38_${i})" font-size="23" font-weight="900" fill="#ffffff">${esc(short(ch.title, 17))}</text>
        <text x="920" y="${y + 8}" text-anchor="middle" font-size="28" font-weight="1000" fill="#29d9ff">${fmt(ch.subscribers)}</text>
        <text x="1065" y="${y + 8}" text-anchor="middle" font-size="28" font-weight="1000" fill="#37f1ca">${fmt(ch.views24)}</text>

        ${i < visible.length - 1 ? `<line x1="470" y1="${y + 36}" x2="1130" y2="${y + 36}" stroke="rgba(255,255,255,.10)" stroke-width="1"/>` : ''}
      </g>
    `;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
      <style>
        text { font-family: DejaVu Sans, Arial, Helvetica, sans-serif; }
      </style>

      <linearGradient id="bg38" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#061525"/>
        <stop offset="46%" stop-color="#0b4c55"/>
        <stop offset="100%" stop-color="#12c18f"/>
      </linearGradient>

      <linearGradient id="glass38" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,.15)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,.06)"/>
      </linearGradient>

      <filter id="shadow38" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#001827" flood-opacity=".34"/>
      </filter>
    </defs>

    <rect width="1280" height="900" fill="url(#bg38)"/>
    <path d="M-40 126 C230 62 455 186 680 108 C910 30 1070 105 1320 58" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="3"/>
    <path d="M-20 750 C280 665 500 780 730 650 C930 538 1085 585 1320 500" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3"/>

    <text x="56" y="72" font-size="47" font-weight="1000" fill="#ffffff">Статистика сети каналов</text>
    <text x="58" y="112" font-size="22" font-weight="800" fill="rgba(255,255,255,.82)">LinkRay Analytics · сводка по всей сетке каналов</text>

    <clipPath id="lrLogoRealClip39">
      <circle cx="1039" cy="66" r="41"/>
    </clipPath>
    <circle cx="1039" cy="66" r="42" fill="rgba(38,242,204,.14)" stroke="#35f2cf" stroke-width="3"/>
    <image href="${lrV39RealLogoData}" x="997" y="24" width="84" height="84" preserveAspectRatio="xMidYMid slice" clip-path="url(#lrLogoRealClip39)"/>

    <text x="1104" y="82" font-size="37" font-weight="1000" fill="#ffffff">LinkRay</text>

    <rect x="55" y="155" rx="24" width="275" height="128" fill="url(#glass38)" stroke="rgba(125,255,231,.34)" filter="url(#shadow38)"/>
    <text x="192" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Подписчики</text>
    <text x="192" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#25d9ff">${fmt(totalSubs)}</text>

    <rect x="352" y="155" rx="24" width="275" height="128" fill="url(#glass38)" stroke="rgba(125,255,231,.34)" filter="url(#shadow38)"/>
    <text x="489" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Просмотры 24ч</text>
    <text x="489" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#35f0ca">${fmt(total24)}</text>

    <rect x="650" y="155" rx="24" width="275" height="128" fill="url(#glass38)" stroke="rgba(125,255,231,.34)" filter="url(#shadow38)"/>
    <text x="787" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Общий ER</text>
    <text x="787" y="252" text-anchor="middle" font-size="52" font-weight="1000" fill="#27d9ff">${er.toFixed(2).replace('.', ',')}%</text>

    <rect x="948" y="155" rx="24" width="275" height="128" fill="url(#glass38)" stroke="rgba(125,255,231,.34)" filter="url(#shadow38)"/>
    <text x="1085" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Каналов</text>
    <text x="1085" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#35f0ca">${fmt(clean.length)}</text>

    <rect x="55" y="330" rx="26" width="305" height="300" fill="url(#glass38)" stroke="rgba(125,255,231,.34)" filter="url(#shadow38)"/>
    <text x="90" y="388" font-size="34" font-weight="1000" fill="#ffffff">Просмотры</text>
    <text x="92" y="454" font-size="40" font-weight="1000" fill="#ffffff">24ч:</text>
    <text x="210" y="454" font-size="40" font-weight="1000" fill="#25d9ff">${fmt(total24)}</text>
    <text x="92" y="524" font-size="40" font-weight="1000" fill="#ffffff">48ч:</text>
    <text x="210" y="524" font-size="40" font-weight="1000" fill="#25d9ff">${fmt(total48)}</text>
    <text x="92" y="594" font-size="40" font-weight="1000" fill="#ffffff">72ч:</text>
    <text x="210" y="594" font-size="40" font-weight="1000" fill="#25d9ff">${fmt(total72)}</text>

    <rect x="390" y="330" rx="26" width="835" height="430" fill="url(#glass38)" stroke="rgba(125,255,231,.34)" filter="url(#shadow38)"/>
    <text x="425" y="388" font-size="36" font-weight="1000" fill="#ffffff">Каналы</text>

    <text x="535" y="428" font-size="19" font-weight="900" fill="rgba(255,255,255,.65)">Название</text>
    <text x="920" y="428" text-anchor="middle" font-size="19" font-weight="900" fill="rgba(255,255,255,.65)">ПДП</text>
    <text x="1065" y="428" text-anchor="middle" font-size="19" font-weight="900" fill="rgba(255,255,255,.65)">24ч</text>
    <line x1="470" y1="442" x2="1130" y2="442" stroke="rgba(255,255,255,.16)" stroke-width="1"/>

    ${rows}

    <text x="470" y="735" font-size="23" font-weight="1000" fill="#45ffd9">Суммы рассчитаны по всем каналам.</text>

    <text x="55" y="837" font-size="25" font-weight="1000" fill="#ffffff">Актуально на ${esc(now)} МСК</text>
    <text x="1224" y="837" text-anchor="end" font-size="23" font-weight="900" fill="rgba(255,255,255,.82)">LinkRay — аналитика каналов MAX</text>
  </svg>`;

  console.log('[LR_NETWORK_CARD_LAYOUT_V38]', JSON.stringify({
    count: clean.length,
    visible: visible.map(x => ({ title: x.title, avatar: Boolean(x.avatar) }))
  }));

  return await sharp(Buffer.from(lrV82BrightNegativeSvg(svg))).png().toBuffer();
}
/* LR_NETWORK_CARD_LAYOUT_V38_END */


/* LR_NETWORK_CARD_FINAL_V40_START */

/* LR_ANALYTICS_CAPTION_V44_START */
function lrV44AnalyticsCaption(channels = []) {
  function num(v) {
    const n = Number(String(v ?? 0).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function fmt(v) {
    const n = num(v);
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace('.', ',') + 'k';
    return String(Math.round(n));
  }

  function html(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function short(v, max = 34) {
    const t = String(v || 'Канал').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1).trim() + '…' : t;
  }

  function getNum(ch, keys) {
    for (const k of keys) {
      if (ch && ch[k] !== undefined && ch[k] !== null && ch[k] !== '') return num(ch[k]);
    }
    return 0;
  }

  const src = (Array.isArray(channels) && channels.length) ? channels : (Array.isArray(globalThis.__lrLastNetworkChannels) ? globalThis.__lrLastNetworkChannels : []);
  const list = [];
  const seen = new Set();

  for (let i = 0; i < src.length; i++) {
    const ch = src[i] || {};
    const title = String(
      ch.title ||
      ch.name ||
      ch.channel_title ||
      ch.channel_name ||
      `Канал ${i + 1}`
    ).replace(/^https?:\/\/max\.ru\//i, '').replace(/\s+/g, ' ').trim();

    const link = String(ch.link || ch.url || ch.key || ch.channel_link || ch.public_link || '').trim();
    const key = link || title || String(i);

    if (seen.has(key)) continue;
    seen.add(key);

    list.push({
      title,
      subscribers: getNum(ch, ['subscribers', 'members', 'subs', 'pdp', 'followers', 'count']),
      signed: getNum(ch, ['signed', 'joined', 'joined_today', 'subscribed_today', 'subs_today', 'plus_today', 'new_subscribers']),
      left: getNum(ch, ['left', 'unsubscribed', 'unsubscribed_today', 'unsubs_today', 'minus_today', 'lost_subscribers']),
      views24: getNum(ch, ['views24', 'views_24', 'views_day', 'viewsToday', 'views_today']),
      views48: getNum(ch, ['views48', 'views_48']),
      views72: getNum(ch, ['views72', 'views_72']),
    });
  }

  const totalSubs = list.reduce((a, c) => a + c.subscribers, 0);
  const signed = list.reduce((a, c) => a + c.signed, 0);
  const left = list.reduce((a, c) => a + c.left, 0);
  const net = signed - left;

  const views24 = list.reduce((a, c) => a + c.views24, 0);
  const views48 = list.reduce((a, c) => a + c.views48, 0);
  const views72 = list.reduce((a, c) => a + c.views72, 0);

  const er24 = totalSubs > 0 ? (views24 / totalSubs) * 100 : 0;

  const now = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).replace(',', '');

  const top = list
    .slice()
    .sort((a, b) => b.views24 - a.views24)
    .slice(0, 4);

  const rows = top.length
    ? top.map((ch, i) => `${i + 1}) ${html(short(ch.title))}: <b>${fmt(ch.views24)}</b> просмотров`).join('\n')
    : 'Пока нет каналов для отчёта.';

  return `📊 <b>LinkRay Analytics</b>
Сводка по сети: <b>${list.length}</b> каналов


👁 <b>Просмотры:</b>
├ 24 часа: <b>${fmt(views24)}</b>
├ 48 часов: <b>${fmt(views48)}</b>
└ 72 часа: <b>${fmt(views72)}</b>

📊 <b>Средний ER24:</b> ${er24.toFixed(2).replace('.', ',')}%

${rows}

🕘 <b>Сформировано:</b> ${html(now)} МСК
━━━━━━━━━━━━━━
✨ <a href="https://max.ru/se13353901_bot">LinkRay</a> — автопостинг и аналитика рекламных размещений в MAX`;
}
/* LR_ANALYTICS_CAPTION_V44_END */

async function lrV40RenderFinalNetworkPng(channels = []) {
  try { globalThis.__lrLastNetworkChannels = Array.isArray(channels) ? channels : []; } catch {}

  const sharpMod = await import('sharp');
  const sharp = sharpMod.default || sharpMod;
  const fs = await import('node:fs/promises');

  const WIDTH = 1280;
  const HEIGHT = 900;

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function num(v) {
    const n = Number(String(v ?? 0).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function fmt(v) {
    const n = num(v);
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace('.', ',') + 'k';
    return String(Math.round(n));
  }

  function short(v, max = 17) {
    const text = String(v || 'Канал').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max).trim() + '…' : text;
  }

  function goodUrl(v) {
    const u = String(v || '').trim();
    return /^https?:\/\//i.test(u) && !u.includes('/s/img/og-logo.png');
  }

  async function findCachedAvatar(ch) {
    const direct =
      ch.avatar_url ||
      ch.avatarUrl ||
      ch.photo_url ||
      ch.image_url ||
      ch.picture_url ||
      ch.avatar ||
      ch.photo ||
      ch.image ||
      '';

    if (goodUrl(direct)) return direct;

    try {
      const db = await import('./db.js');
      const link = String(ch.link || '').trim();
      const title = String(ch.title || '').trim();

      let rows = [];

      if (link) {
        const r = await db.query(
          `SELECT avatar_url
             FROM public.lr_channel_avatar_cache
            WHERE link_norm=$1 OR link=$1
            ORDER BY updated_at DESC
            LIMIT 1`,
          [link]
        );
        rows = Array.isArray(r) ? r : (r?.rows || []);
      }

      if (!rows.length && title) {
        const r = await db.query(
          `SELECT avatar_url
             FROM public.lr_channel_avatar_cache
            WHERE title=$1
            ORDER BY updated_at DESC
            LIMIT 1`,
          [title]
        );
        rows = Array.isArray(r) ? r : (r?.rows || []);
      }

      const url = String(rows?.[0]?.avatar_url || '').trim();
      if (goodUrl(url)) return url;
    } catch {}

    return '';
  }

  async function dataPng(url, size = 52) {
    if (!goodUrl(url)) return '';

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: {
          'user-agent': 'Mozilla/5.0 LinkRayBot/1.0',
          'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'referer': 'https://max.ru/',
        },
      });

      if (!res.ok) return '';

      const input = Buffer.from(await res.arrayBuffer());
      const out = await sharp(input)
        .resize(size, size, { fit: 'cover' })
        .png()
        .toBuffer();

      return `data:image/png;base64,${out.toString('base64')}`;
    } catch {
      return '';
    }
  }

  async function logoData() {
    try {
      const buf = await fs.readFile('/app/public/brand/linkray-logo-main.jpg');
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch {
      return '';
    }
  }

  const clean = [];
  const seen = new Set();

  for (let i = 0; i < channels.length; i++) {
    const raw = channels[i] || {};
    const title = String(
      raw.title ||
      raw.name ||
      raw.channel_title ||
      raw.channel_name ||
      `Канал ${i + 1}`
    ).replace(/^https?:\/\/max\.ru\//i, '').replace(/\s+/g, ' ').trim();

    const link = String(raw.link || raw.url || raw.key || raw.channel_link || raw.public_link || '').trim();
    const key = link || title || String(i);

    if (seen.has(key)) continue;
    seen.add(key);

    clean.push({
      ...raw,
      title,
      link,
      subscribers: num(raw.subscribers || raw.members || raw.subs || raw.pdp || 0),
      views24: num(raw.views24 || raw.views_24 || raw.views_day || 0),
      views48: num(raw.views48 || raw.views_48 || 0),
      views72: num(raw.views72 || raw.views_72 || 0),
    });
  }

  const visible = clean.slice(0, 4);

  const totalSubs = clean.reduce((a, c) => a + c.subscribers, 0);
  const total24 = clean.reduce((a, c) => a + c.views24, 0);
  const total48 = clean.reduce((a, c) => a + c.views48, 0);
  const total72 = clean.reduce((a, c) => a + c.views72, 0);
  const er = totalSubs > 0 ? total24 / totalSubs * 100 : 0;

  const now = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).replace(',', '');

  const logo = await logoData();

  let rows = '';

  for (let i = 0; i < visible.length; i++) {
    const ch = visible[i];
    const y = 455 + i * 72;
    const avatarUrl = await findCachedAvatar(ch);
    const av = await dataPng(avatarUrl, 52);
    const letter = esc((ch.title || 'К')[0] || 'К').toUpperCase();
    const title = esc(short(ch.title, 16));

    rows += `
      <g font-family="DejaVu Sans, Arial, Helvetica, sans-serif">
        <circle cx="495" cy="${y}" r="28" fill="rgba(46,255,212,.16)" stroke="#35f2cf" stroke-width="3"/>
        ${
          av
            ? `<clipPath id="av40_${i}"><circle cx="495" cy="${y}" r="24"/></clipPath><image href="${av}" x="471" y="${y - 24}" width="48" height="48" preserveAspectRatio="xMidYMid slice" clip-path="url(#av40_${i})"/>`
            : `<text x="495" y="${y + 8}" text-anchor="middle" font-size="20" font-weight="900" fill="#ecfffb">${letter}</text>`
        }

        <text x="535" y="${y + 8}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="24" font-weight="900" fill="#ffffff">${title}</text>

        <text x="900" y="${y + 8}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="29" font-weight="1000" fill="#29d9ff">${fmt(ch.subscribers)}</text>
        <text x="1055" y="${y + 8}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="29" font-weight="1000" fill="#37f1ca">${fmt(ch.views24)}</text>

        ${i < visible.length - 1 ? `<line x1="470" y1="${y + 36}" x2="1130" y2="${y + 36}" stroke="rgba(255,255,255,.10)" stroke-width="1"/>` : ''}
      </g>
    `;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">
    <defs>
      <linearGradient id="bg40" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#061525"/>
        <stop offset="46%" stop-color="#0b4c55"/>
        <stop offset="100%" stop-color="#12c18f"/>
      </linearGradient>
      <linearGradient id="glass40" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,.15)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,.06)"/>
      </linearGradient>
      <filter id="shadow40" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#001827" flood-opacity=".34"/>
      </filter>
      <clipPath id="logoClip40">
        <circle cx="1040" cy="66" r="41"/>
      </clipPath>
    </defs>

    <rect width="1280" height="900" fill="url(#bg40)"/>
    <path d="M-40 126 C230 62 455 186 680 108 C910 30 1070 105 1320 58" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="3"/>
    <path d="M-20 750 C280 665 500 780 730 650 C930 538 1085 585 1320 500" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3"/>

    <text x="56" y="72" font-size="47" font-weight="1000" fill="#ffffff">Статистика сети каналов</text>
    <text x="58" y="112" font-size="22" font-weight="800" fill="rgba(255,255,255,.82)">LinkRay Analytics · сводка по всей сетке каналов</text>

    <circle cx="1040" cy="66" r="42" fill="rgba(38,242,204,.14)" stroke="#35f2cf" stroke-width="3"/>
    ${logo ? `<image href="${logo}" x="998" y="24" width="84" height="84" preserveAspectRatio="xMidYMid slice" clip-path="url(#logoClip40)"/>` : ''}
    <text x="1104" y="82" font-size="37" font-weight="1000" fill="#ffffff">LinkRay</text>

    <rect x="55" y="155" rx="24" width="275" height="128" fill="url(#glass40)" stroke="rgba(125,255,231,.34)" filter="url(#shadow40)"/>
    <text x="192" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Подписчики</text>
    <text x="192" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#25d9ff">${fmt(totalSubs)}</text>

    <rect x="352" y="155" rx="24" width="275" height="128" fill="url(#glass40)" stroke="rgba(125,255,231,.34)" filter="url(#shadow40)"/>
    <text x="489" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Просмотры 24ч</text>
    <text x="489" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#35f0ca">${fmt(total24)}</text>

    <rect x="650" y="155" rx="24" width="275" height="128" fill="url(#glass40)" stroke="rgba(125,255,231,.34)" filter="url(#shadow40)"/>
    <text x="787" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Общий ER</text>
    <text x="787" y="252" text-anchor="middle" font-size="52" font-weight="1000" fill="#27d9ff">${er.toFixed(2).replace('.', ',')}%</text>

    <rect x="948" y="155" rx="24" width="275" height="128" fill="url(#glass40)" stroke="rgba(125,255,231,.34)" filter="url(#shadow40)"/>
    <text x="1085" y="196" text-anchor="middle" font-size="21" font-weight="900" fill="rgba(255,255,255,.78)">Каналов</text>
    <text x="1085" y="252" text-anchor="middle" font-size="56" font-weight="1000" fill="#35f0ca">${fmt(clean.length)}</text>

    <rect x="55" y="330" rx="26" width="305" height="300" fill="url(#glass40)" stroke="rgba(125,255,231,.34)" filter="url(#shadow40)"/>
    <text x="90" y="388" font-size="34" font-weight="1000" fill="#ffffff">Просмотры</text>
    <text x="92" y="454" font-size="40" font-weight="1000" fill="#ffffff">24ч:</text>
    <text x="210" y="454" font-size="40" font-weight="1000" fill="#25d9ff">${fmt(total24)}</text>
    <text x="92" y="524" font-size="40" font-weight="1000" fill="#ffffff">48ч:</text>
    <text x="210" y="524" font-size="40" font-weight="1000" fill="#25d9ff">${fmt(total48)}</text>
    <text x="92" y="594" font-size="40" font-weight="1000" fill="#ffffff">72ч:</text>
    <text x="210" y="594" font-size="40" font-weight="1000" fill="#25d9ff">${fmt(total72)}</text>

    <rect x="390" y="330" rx="26" width="835" height="430" fill="url(#glass40)" stroke="rgba(125,255,231,.34)" filter="url(#shadow40)"/>
    <text x="425" y="388" font-size="36" font-weight="1000" fill="#ffffff">Каналы</text>

    <text x="535" y="428" font-size="19" font-weight="900" fill="rgba(255,255,255,.65)">Канал</text>
    <text x="900" y="428" text-anchor="middle" font-size="19" font-weight="900" fill="rgba(255,255,255,.65)">ПДП</text>
    <text x="1055" y="428" text-anchor="middle" font-size="19" font-weight="900" fill="rgba(255,255,255,.65)">24ч</text>
    <line x1="470" y1="442" x2="1130" y2="442" stroke="rgba(255,255,255,.16)" stroke-width="1"/>

    ${rows}

    <text x="470" y="735" font-size="23" font-weight="1000" fill="#45ffd9">Суммы рассчитаны по всем каналам.</text>

    <text x="55" y="837" font-size="25" font-weight="1000" fill="#ffffff">Актуально на ${esc(now)} МСК</text>
    <text x="1224" y="837" text-anchor="end" font-size="23" font-weight="900" fill="rgba(255,255,255,.82)">LinkRay — аналитика каналов MAX</text>
  </svg>`;

  console.log('[LR_NETWORK_CARD_FINAL_V40]', JSON.stringify({
    count: clean.length,
    visible: visible.map(x => ({ title: x.title, link: x.link }))
  }));

  return await sharp(Buffer.from(lrV82BrightNegativeSvg(svg))).png().toBuffer();
}
/* LR_NETWORK_CARD_FINAL_V40_END */

async function lrV34RenderNetworkPng(channels) {
  return await lrV40RenderFinalNetworkPng(channels);
}

async function lrV34SavePublicPng(buffer) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const dir = path.join(process.cwd(), 'public', 'generated');
  await fs.mkdir(dir, { recursive: true });

  const name = `linkray-network-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  const file = path.join(dir, name);

  await fs.writeFile(file, buffer);

  return `${lrV34PublicBase()}/generated/${name}`;
}

async function lrV34SendMaxImageUrl(update, imageUrl) {
  const token = lrV34MaxToken();

  if (!token) throw new Error('MAX token not found');

  const target = lrV34TargetFromUpdate(update);
  const query =
    target.chatId ? `chat_id=${encodeURIComponent(target.chatId)}` :
    target.userId ? `user_id=${encodeURIComponent(target.userId)}` :
    '';

  if (!query) throw new Error('chat_id/user_id not found');

  const api = lrV34ApiBase();

  const body = {
    text: lrV44AnalyticsCaption((typeof channels !== 'undefined' && channels) || (typeof clean !== 'undefined' && clean) || (typeof all !== 'undefined' && all) || (typeof visible !== 'undefined' && visible) || (typeof list !== 'undefined' && list) || []),
    format: 'html',
    attachments: [
      {
        type: 'image',
        payload: {
          url: imageUrl,
        },
      },
    ],
  };

  const attempts = [
    {
      url:
        `${api}/messages?${query}`,
      headers: {
        Authorization: token,
        'Content-Type':
          'application/json',
      },
    },
  ];
  let last = '';

  for (const a of attempts) {
    const res = await fetch(a.url, {
      method: 'POST',
      headers: a.headers,
      body: JSON.stringify(body),
    });

    const txt = await res.text();
    last = `${res.status}: ${txt}`;

    if (res.ok) {
      console.log('[LR_DIRECT_PUBLIC_IMAGE_V34] sent image url', imageUrl);
      return true;
    }
  }

  throw new Error(`MAX image url send failed ${last}`);
}

async function lrV34TryDirectPublicNetworkCard(update) {
  const text = lrV34TextFromUpdate(update);
  const links = lrV34ExtractLinks(text);

  if (links.length < 2) return false;
  /* LR_DIRECT_MULTI_READY_CHECK_V1 */
  const readiness = await getChannelMetricsReadiness(links);
  if (!readiness.ready) {
    const target = typeof lrV34TargetFromUpdate === 'function'
      ? lrV34TargetFromUpdate(update)
      : { chatId: getChatId(update) };
    const chatId = target?.chatId || getChatId(update);
    if (chatId) await lrSendChannelDataNotReady(chatId, readiness, update);
    return true;
  }

  console.log('[LR_DIRECT_PUBLIC_IMAGE_V34] intercept multi links', links.join(' | '));

  const channels = await lrV34LoadChannelsByLinks(links);
  const png = await lrV34RenderNetworkPng(channels);
  const url = await lrV34SavePublicPng(png);

  await lrV34SendMaxImageUrl(update, url);

  return true;
}
/* LR_DIRECT_PUBLIC_IMAGE_V34_END */

export async function handleLinkRayChannelAnalyticsIncoming(update) {
  /* LR_ANALYTICS_PRIVATE_LINK_RESCUE_V1_START */
  try {
    const rescueChatId = getChatId(update);
    const rescueText = getText(update);
    const rescueLinks = typeof lrLinksDeep === 'function'
      ? lrLinksDeep(update, rescueText)
      : extractMaxLinks(rescueText);

    if (rescueChatId && rescueLinks.length) {
      const rescueKeys = typeof lrIdentityKeys === 'function'
        ? lrIdentityKeys(update, rescueChatId)
        : [String(rescueChatId)];

      const rescueSettings =
        await getAnalyticsSettingsForKeys(rescueKeys);

      if (rescueSettings?.mode === 'await_links') {
        const uniqueLinks = typeof lrV14UniqueLinks === 'function'
          ? lrV14UniqueLinks(rescueLinks)
          : [...new Set(rescueLinks)];

        await setAnalyticsModeForKeys(rescueKeys, '');

        console.log(
          '[LR_ANALYTICS_PRIVATE_LINK_RESCUE_V1]',
          JSON.stringify({
            chatId: String(rescueChatId),
            links: uniqueLinks,
          })
        );

        await handleLinks(
          rescueChatId,
          uniqueLinks,
          update
        );

        return true;
      }
    }
  } catch (rescueError) {
    console.error(
      '[LR_ANALYTICS_PRIVATE_LINK_RESCUE_V1]',
      rescueError?.stack ||
      rescueError?.message ||
      rescueError
    );
  }
  /* LR_ANALYTICS_PRIVATE_LINK_RESCUE_V1_END */


  /* LR_DIRECT_PUBLIC_IMAGE_V34_CALL_START */
  try {
    if (await lrV34TryDirectPublicNetworkCard(update)) {
      return true;
    }
  } catch (e) {
    console.error('[LR_DIRECT_PUBLIC_IMAGE_V34_ERROR]', e?.message || e);
  }
  /* LR_DIRECT_PUBLIC_IMAGE_V34_CALL_END */

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


/* LR_CHANNEL_ANALYTICS_V73_START */
async function lrV73EnsureDailyChannelTable() {
  await ensureTables();
  await query(`
    CREATE TABLE IF NOT EXISTS public.lr_channel_analytics_daily_channels (
      owner_chat_id text NOT NULL,
      channel_id bigint NOT NULL,
      enabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(owner_chat_id, channel_id)
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS lr_channel_analytics_daily_channels_enabled_idx
    ON public.lr_channel_analytics_daily_channels(enabled, owner_chat_id)
  `).catch(() => {});
}

async function lrV73SyncDailyChannels(ownerChatId) {
  await lrV73EnsureDailyChannelTable();
  await query(`
    INSERT INTO public.lr_channel_analytics_daily_channels
      (owner_chat_id, channel_id, enabled, updated_at)
    SELECT $1, c.id, false, now()
    FROM public.channels c
    WHERE c.is_active = true
    ON CONFLICT(owner_chat_id, channel_id) DO NOTHING
  `, [String(ownerChatId)]);
}

async function lrV73DailyChannelRows(ownerChatId) {
  await lrV73SyncDailyChannels(ownerChatId);
  const result = await query(`
    SELECT c.id, c.max_chat_id, c.title, c.link,
           coalesce(d.enabled, false) AS enabled
    FROM public.channels c
    LEFT JOIN public.lr_channel_analytics_daily_channels d
      ON d.owner_chat_id = $1 AND d.channel_id = c.id
    WHERE c.is_active = true
    ORDER BY lower(coalesce(c.title, '')), c.id
  `, [String(ownerChatId)]).catch(() => []);
  return rows(result);
}

async function lrV73SetChannelDaily(ownerChatId, channelId, enabled) {
  await lrV73EnsureDailyChannelTable();
  await query(`
    INSERT INTO public.lr_channel_analytics_daily_channels
      (owner_chat_id, channel_id, enabled, updated_at)
    VALUES($1, $2, $3, now())
    ON CONFLICT(owner_chat_id, channel_id)
    DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
  `, [String(ownerChatId), Number(channelId), Boolean(enabled)]);
}

async function lrV73SetAllDaily(ownerChatId, enabled) {
  await lrV73SyncDailyChannels(ownerChatId);
  await query(`
    UPDATE public.lr_channel_analytics_daily_channels
    SET enabled = $2, updated_at = now()
    WHERE owner_chat_id = $1
  `, [String(ownerChatId), Boolean(enabled)]);
}

function lrV73ShortTitle(value, limit = 31) {
  const text = String(value || 'Канал').trim() || 'Канал';
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

async function lrV73ResolveDailyChannel(row, index = 0) {
  const candidates = [row?.link, row?.max_chat_id, row?.id].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = await resolveChannel(String(candidate), {
        _lrIndex: index,
        id: row?.id,
        channel_id: row?.id,
        max_chat_id: row?.max_chat_id,
        title: row?.title,
        link: row?.link,
      });
      if (resolved) {
        resolved.title = resolved.title || row?.title || 'Канал';
        resolved.link = resolved.link || row?.link || '';
        return resolved;
      }
    } catch {}
  }
  return {
    title: row?.title || 'Канал',
    link: row?.link || '',
    subscribers: 0,
    views24: 0,
    views48: 0,
    views72: 0,
    er24: 0,
    delta_day: 0,
    delta_week: 0,
    delta_month: 0,
  };
}

/* LR_DAILY_PDP_TEXT_V74_START */

function lrV74Signed(value) {
  const number = num(value);
  if (number > 0) return `+${fmt(number)}`;
  return fmt(number);
}

function lrV74MskDateTime(value) {
  const date = value ? new Date(value) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return 'не определён';
  }

  return date.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).replace(',', '');
}

let lrV86LastDailyCleanupAt = 0;

async function lrV74EnsureDailyPdpReportTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS public.lr_channel_daily_pdp_reports (
      owner_chat_id text NOT NULL,
      channel_id bigint NOT NULL,
      report_date date NOT NULL,
      period_started_at timestamptz NOT NULL,
      period_finished_at timestamptz NOT NULL,
      joined_count integer NOT NULL DEFAULT 0,
      left_count integer NOT NULL DEFAULT 0,
      subscribers_total integer NOT NULL DEFAULT 0,
      sent_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_chat_id, channel_id, report_date)
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS lr_channel_daily_pdp_reports_date_idx
    ON public.lr_channel_daily_pdp_reports(report_date)
  `).catch(() => {});

  const now = Date.now();
  if (now - lrV86LastDailyCleanupAt >= 6 * 60 * 60_000) {
    lrV86LastDailyCleanupAt = now;

    await query(`
      DELETE FROM public.lr_channel_daily_pdp_reports
      WHERE report_date <
        ((now() AT TIME ZONE 'Europe/Moscow')::date - 7)
    `).catch((error) => {
      console.error(
        '[LR_SHORT_LIVED_AUDIENCE_LINKS_V86_CLEANUP]',
        error?.message || error
      );
    });
  }
}

async function lrV74DailyWindow() {
  const result = rows(await query(`
    SELECT
      (
        (
          date_trunc(
            'day',
            now() AT TIME ZONE 'Europe/Moscow'
          ) - interval '1 day'
        ) + interval '8 hours'
      ) AT TIME ZONE 'Europe/Moscow'
        AS period_start,

      (
        date_trunc(
          'day',
          now() AT TIME ZONE 'Europe/Moscow'
        ) + interval '8 hours'
      ) AT TIME ZONE 'Europe/Moscow'
        AS period_end,

      (
        now() AT TIME ZONE 'Europe/Moscow'
      )::date AS report_date
  `))[0];

  return {
    periodStart: result.period_start,
    periodEnd: result.period_end,
    reportDate: result.report_date,
  };
}

async function lrV74DailyPdpStats(
  ownerChatId,
  row,
  window,
  resolved
) {
  const dbChannelId = Number(row?.id);
  const maxChannelId = String(
    row?.max_chat_id ||
    row?.channel_id ||
    row?.id ||
    ''
  );

  const setting = rows(await query(`
    SELECT
      d.updated_at AS enabled_at,
      s.first_seen_at
    FROM public.lr_channel_analytics_daily_channels d
    LEFT JOIN public.lr_channel_metrics_state s
      ON s.channel_id=$3
    WHERE d.owner_chat_id=$1
      AND d.channel_id=$2
      AND d.enabled=true
    LIMIT 1
  `, [
    String(ownerChatId),
    dbChannelId,
    maxChannelId,
  ]).catch(() => []))[0] || {};

  const candidates = [
    window.periodStart,
    setting.enabled_at,
    setting.first_seen_at,
  ]
    .map((value) => value ? new Date(value) : null)
    .filter(
      (value) =>
        value &&
        !Number.isNaN(value.getTime())
    );

  const periodStart = candidates.length
    ? new Date(
        Math.max(...candidates.map((date) => date.getTime()))
      )
    : new Date(window.periodStart);

  const periodEnd = new Date(window.periodEnd);

  const movements = rows(await query(`
    SELECT
      COUNT(*) FILTER (
        WHERE event_type='joined'
      )::integer AS joined_count,

      COUNT(*) FILTER (
        WHERE event_type='left'
      )::integer AS left_count
    FROM public.lr_channel_member_events
    WHERE channel_id=$1
      AND occurred_at >= $2
      AND occurred_at < $3
  `, [
    maxChannelId,
    periodStart,
    periodEnd,
  ]).catch(() => []))[0] || {};

  const latestSnapshot = rows(await query(`
    SELECT subscribers
    FROM public.lr_channel_analytics_snapshots
    WHERE collection_source='max_api_collector_v1'
      AND (
        raw #>> '{chat,chat_id}'=$1
        OR raw #>> '{chat,id}'=$1
        OR raw #>> '{chat,chat,id}'=$1
        OR link=$2
      )
    ORDER BY captured_at DESC
    LIMIT 1
  `, [
    maxChannelId,
    String(row?.link || ''),
  ]).catch(() => []))[0] || {};

  const resolvedSubscribers = num(resolved?.subscribers);
  const snapshotSubscribers = num(
    latestSnapshot?.subscribers
  );

  return {
    dbChannelId,
    maxChannelId,
    title:
      resolved?.title ||
      row?.title ||
      'Канал MAX',

    joined: num(movements.joined_count),
    left: num(movements.left_count),

    subscribers:
      resolvedSubscribers > 0
        ? resolvedSubscribers
        : snapshotSubscribers,

    periodStart,
    periodEnd,
    reportDate: window.reportDate,
  };
}

async function lrV74ClaimDailyReport(
  ownerChatId,
  stats
) {
  const result = rows(await query(`
    INSERT INTO public.lr_channel_daily_pdp_reports (
      owner_chat_id,
      channel_id,
      report_date,
      period_started_at,
      period_finished_at,
      joined_count,
      left_count,
      subscribers_total,
      sent_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      now()
    )
    ON CONFLICT (
      owner_chat_id,
      channel_id,
      report_date
    ) DO NOTHING
    RETURNING 1
  `, [
    String(ownerChatId),
    stats.dbChannelId,
    stats.reportDate,
    stats.periodStart,
    stats.periodEnd,
    stats.joined,
    stats.left,
    stats.subscribers,
  ]));

  return result.length > 0;
}

async function lrV74ReleaseDailyReport(
  ownerChatId,
  stats
) {
  await query(`
    DELETE FROM public.lr_channel_daily_pdp_reports
    WHERE owner_chat_id=$1
      AND channel_id=$2
      AND report_date=$3
  `, [
    String(ownerChatId),
    stats.dbChannelId,
    stats.reportDate,
  ]).catch(() => {});
}

function lrV74DailyPdpText(stats) {
  const net = stats.joined - stats.left;
  const lines = [
    '📊 Ежедневный отчёт ПДП',
    '',
    `📢 ${esc(stats.title)}`,
    '',
    `👥 Всего подписчиков: ${fmt(stats.subscribers)}`,
    `➕ Подписались: ${fmt(stats.joined)}`,
    `➖ Отписались: ${fmt(stats.left)}`,
    `📈 Изменение: ${lrV74Signed(net)}`,
    '',
    `🕘 Период: ${lrV74MskDateTime(stats.periodStart)} — ` +
      `${lrV74MskDateTime(stats.periodEnd)} МСК`,
  ];

  return lines.join('\n');
}

async function lrV73SendDailyGroup(
  ownerChatId,
  sourceRows
) {
  await lrV74EnsureDailyPdpReportTable();

  const window = await lrV74DailyWindow();

  for (let index = 0; index < sourceRows.length; index += 1) {
    const row = sourceRows[index];

    let resolved = null;

    try {
      resolved = await lrV73ResolveDailyChannel(
        row,
        index
      );
    } catch (error) {
      console.error(
        '[v74 daily pdp resolve]',
        error?.message || error
      );
    }

    const stats = await lrV74DailyPdpStats(
      ownerChatId,
      row,
      window,
      resolved
    );

    const claimed = await lrV74ClaimDailyReport(
      ownerChatId,
      stats
    );

    if (!claimed) {
      console.log(
        '[v74 daily pdp] already sent',
        JSON.stringify({
          ownerChatId: String(ownerChatId),
          channelId: stats.dbChannelId,
          reportDate: stats.reportDate,
        })
      );

      continue;
    }

    try {
      const audienceUrl =
        createAudienceReportLink(
          String(ownerChatId),
          stats.maxChannelId,
          {
            from: stats.periodStart,
            to: stats.periodEnd,
            expiresDays: 2, /* LR_SHORT_LIVED_AUDIENCE_LINKS_V86 */
          }
        );

      await sendMaxMessage({
        chatId:
          String(ownerChatId),
        text:
          lrV74DailyPdpText(
            stats,
            audienceUrl
          ),
        format: 'html',
        attachments: lrMenuButtons([
          [
            {
              type: 'link',
              text: '🌐 Подписки и отписки за 24 часа',
              url: audienceUrl,
            },
          ],
          [
            lrCb(
              '🏠 Главное меню',
              'lrchan:main:new'
            ),
          ],
        ]) /* LR_DAILY_PDP_MAIN_MENU_V79_1 */,
      });

      console.log(
        '[v74 daily pdp] sent',
        JSON.stringify({
          ownerChatId: String(ownerChatId),
          channelId: stats.dbChannelId,
          title: stats.title,
          subscribers: stats.subscribers,
          joined: stats.joined,
          left: stats.left,
        })
      );
    } catch (error) {
      await lrV74ReleaseDailyReport(
        ownerChatId,
        stats
      );

      throw error;
    }
  }
}

/* LR_DAILY_PDP_TEXT_V74_END */
/* LR_CHANNEL_ANALYTICS_V73_END */



/* LINKRAY_WEBSITE_BOT_REPORT_EXPORT_V1_START */
async function lrWebsiteReportReadFile(candidate) {
  const value = String(candidate || '').trim();
  if (!value) return null;

  const paths = [
    value,
    value.startsWith('file://')
      ? new URL(value)
      : null,
    value.startsWith('/')
      ? value
      : path.resolve(process.cwd(), value),
    value.startsWith('/generated/')
      ? path.resolve(process.cwd(), 'public', value.slice(1))
      : null,
    value.startsWith('/public/')
      ? path.resolve(process.cwd(), value.slice(1))
      : null,
  ].filter(Boolean);

  for (const filePath of paths) {
    try {
      const data = await fs.readFile(filePath);
      if (data?.length) return data;
    } catch {}
  }

  return null;
}

async function lrWebsiteReportToPng(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) {
    return null;
  }

  if (Buffer.isBuffer(value)) {
    return value.length ? value : null;
  }

  if (value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    return buffer.length ? buffer : null;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;

    if (/^data:image\/png;base64,/i.test(text)) {
      const buffer = Buffer.from(
        text.replace(/^data:image\/png;base64,/i, ''),
        'base64',
      );
      return buffer.length ? buffer : null;
    }

    if (/^data:image\/svg\+xml;base64,/i.test(text)) {
      const svg = Buffer.from(
        text.replace(/^data:image\/svg\+xml;base64,/i, ''),
        'base64',
      );
      return sharp(svg).png().toBuffer();
    }

    if (/^<svg[\s>]/i.test(text)) {
      return sharp(Buffer.from(text)).png().toBuffer();
    }

    const file = await lrWebsiteReportReadFile(text);
    if (file) {
      if (
        file.subarray(0, 8).equals(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        )
      ) {
        return file;
      }

      return sharp(file).png().toBuffer();
    }

    return null;
  }

  if (typeof value === 'object') {
    const directKeys = [
      'buffer',
      'data',
      'png',
      'image',
      'content',
      'body',
      'output',
      'result',
      'svg',
      'filePath',
      'filepath',
      'file_path',
      'path',
      'filename',
      'url',
    ];

    for (const key of directKeys) {
      if (!(key in value)) continue;

      const converted = await lrWebsiteReportToPng(
        value[key],
        depth + 1,
      );

      if (converted?.length) return converted;
    }
  }

  return null;
}

export async function renderLinkRayWebsiteBotReport(input = {}) {
  const link = String(
    input?.link ||
    input?.public_link ||
    input?.channel_link ||
    input?.url ||
    input?.max_chat_id ||
    input?.chat_id ||
    '',
  ).trim();

  if (!link) {
    const error = new Error(
      'Для этого канала не сохранена MAX-ссылка.',
    );
    error.code = 'CHANNEL_LINK_MISSING';
    throw error;
  }

  const readiness = await getChannelMetricsReadiness([link]);

  if (!readiness?.ready) {
    const error = new Error(
      'Отчёт канала ещё не готов: аналитике необходимо накопить 24 часа данных.',
    );
    error.code = 'REPORT_NOT_READY';
    error.readiness = readiness;
    throw error;
  }

  const resolved = await resolveChannel(link, {
    ...input,
    _lrIndex: 0,
  });

  const rendered = await renderSingle(resolved);

  let buffer = await lrWebsiteReportToPng(rendered);

  if (
    !buffer &&
    typeof lrV33ToPngBuffer === 'function'
  ) {
    try {
      buffer = await lrV33ToPngBuffer(rendered);
    } catch (error) {
      console.error(
        '[LinkRay Website bot report converter]',
        error?.message || error,
      );
    }
  }

  buffer = await lrWebsiteReportToPng(buffer);

  if (!buffer?.length) {
    console.error(
      '[LinkRay Website bot report output]',
      JSON.stringify({
        type: typeof rendered,
        constructor:
          rendered?.constructor?.name || null,
        keys:
          rendered && typeof rendered === 'object'
            ? Object.keys(rendered).slice(0, 30)
            : [],
        preview:
          typeof rendered === 'string'
            ? rendered.slice(0, 180)
            : null,
      }),
    );

    const error = new Error(
      'Генератор бота создал отчёт в неподдерживаемом формате.',
    );
    error.code = 'BOT_REPORT_OUTPUT_UNSUPPORTED';
    throw error;
  }

  return buffer;
}
/* LINKRAY_WEBSITE_BOT_REPORT_EXPORT_V1_END */

export function mountLinkRayChannelAnalytics(app) {
  if (mounted) return;
  mounted = true;
  /* LR_AUDIENCE_REPORTS_ANALYTICS_V1 */
  installChannelAudienceReports(app);


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
        await lrV73SetAllDaily(chatId, true);
        await sendMaxMessage({
          chatId,
          text: '📅 Ежедневный отчёт ПДП включён.\nСводка будет приходить каждый день в 08:00 МСК.',
          format: 'html',
        });
        return res.json({ ok: true });
      }

      if (payload === 'lrchan:off') {
        await lrV73SetAllDaily(chatId, false);
        await sendMaxMessage({
          chatId,
          text: '⛔📅 Ежедневный отчёт ПДП отключена.',
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


/* LR_CHANNEL_ANALYTICS_V70_START */

// Карточка аналитики создаётся только после:
// 1) нажатия «🖼 Аналитика каналов»;
// 2) отправки одной или нескольких MAX-ссылок.
//
//📅 Ежедневный отчёт ПДП управляется отдельной кнопкой
// и отправляется существующим worker один раз в день.

export {
  startDailyWorker,
  startDailyWorker as startLinkRayChannelAnalyticsDailyWorker,
};

console.log(
  '[v70 channel analytics] restored: on-demand cards and separate daily PDP'
);

/* LR_CHANNEL_ANALYTICS_V70_END */


/* LR_CHANNEL_ANALYTICS_V71_START */
console.log(
  '[v71 channel analytics] single emojis; change-channels button removed'
);
/* LR_CHANNEL_ANALYTICS_V71_END */


/* LR_CHANNEL_ANALYTICS_V72_START */
console.log('[v72 channel analytics] all duplicate menu emojis collapsed');
/* LR_CHANNEL_ANALYTICS_V72_END */


/* LR_CHANNEL_ANALYTICS_V74_FIX_UNDEFINED_EDITOR */
console.log('[v74 channel analytics] undefined editor call fixed; duplicate emojis collapsed');


/* LR_CHANNEL_ANALYTICS_V75_FULL_READY */
console.log('[v75 channel analytics] menu, cards, per-channel daily settings and worker connected');
