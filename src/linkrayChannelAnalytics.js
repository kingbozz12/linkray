import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express from 'express';
import sharp from 'sharp';
import { query } from './db.js';
import { sendMaxMessage } from './maxClient.js';

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
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace('.', ',') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',') + 'k';
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
    const result = await query(
      `
      SELECT *
      FROM channels
      WHERE link=$1
         OR public_link=$1
         OR invite_link=$1
         OR url=$1
      LIMIT 1
      `,
      [link]
    ).catch(() => []);

    const row = rows(result)[0];

    return row || {};
  } catch {
    return {};
  }
}

async function resolveChannel(link) {
  await ensureTables();

  const channelKey = hash(link);
  const known = await loadFromKnownChannels(link);
  const fromMax = await callMaxForStats(link);

  const normalized = normalizeStats(link, {
    ...known,
    ...fromMax,
  });

  const prev = rows(await query(
    `
    SELECT subscribers
    FROM public.lr_channel_analytics_snapshots
    WHERE channel_key=$1
    ORDER BY captured_at DESC
    LIMIT 1
    `,
    [channelKey]
  ).catch(() => []))[0];

  const deltaDay = normalized.subscribers - num(prev?.subscribers);

  const saved = rows(await query(
    `
    INSERT INTO public.lr_channel_analytics_snapshots
      (channel_key, link, title, avatar_url, subscribers, views24, views48, views72, er24, delta_day, raw)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    RETURNING *
    `,
    [
      channelKey,
      link,
      normalized.title,
      normalized.avatarUrl,
      normalized.subscribers,
      normalized.views24,
      normalized.views48,
      normalized.views72,
      normalized.er24,
      deltaDay,
      JSON.stringify(normalized.raw || {}),
    ]
  ))[0];

  return {
    key: channelKey,
    link,
    title: saved.title,
    avatarUrl: saved.avatar_url || '',
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
    <text x="${first[0] + 4}" y="${Math.max(18, first[1] - 10)}" fill="#111827" font-size="18" font-weight="1000">${fmt(first[2])}</text>
    <text x="${Math.max(22, last[0] - 92)}" y="${Math.max(18, last[1] - 10)}" fill="#111827" font-size="18" font-weight="1000">${fmt(last[2])}</text>
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
      <text x="${x + barW / 2}" y="${Math.max(18, y - 8)}" text-anchor="middle" fill="#111827" font-size="19" font-weight="1000">${fmt(v)}</text>
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
.av{width:42px;height:42px;border-radius:50%;overflow:hidden;display:grid;place-items:center;flex:0 0 auto;color:#fff;font-weight:1000;background:radial-gradient(circle at 30% 25%,#ffe08a,#b8751d 42%,#291a0d 100%)}
.av img{width:100%;height:100%;object-fit:cover}
.title{min-width:0}
.title b{display:block;font-size:21px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.03em}
.title span{display:block;font-size:12px;color:#758397;font-weight:850;margin-top:2px}
.lr{font-size:15px;font-weight:1000;color:#5b62ff;white-space:nowrap}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
.metric{min-height:86px;border:1px solid #e5edf6;border-radius:14px;background:#fff;padding:12px;text-align:center}
.metric .k{font-size:11px;text-transform:uppercase;color:#8793a3;font-weight:1000;line-height:1.12}
.metric .v{margin-top:8px;font-size:30px;line-height:1;font-weight:1000;letter-spacing:-.06em;color:#168eea}
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
.row b{text-align:right;color:#168eea}.row em{font-style:normal;text-align:right;font-weight:1000}.plus{color:#20c77b}.minus{color:#d9635d}
.txt{display:grid;grid-template-columns:1fr auto;gap:14px;color:#fff;align-items:end}
.cap{font-size:24px;line-height:1.24}
.cap .red{color:#d9635d;font-weight:1000;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px}
.cap b{font-weight:1000}
.foot{border-left:4px solid rgba(255,255,255,.85);background:rgba(255,255,255,.12);border-radius:6px;padding:9px 12px;color:#fff;font-size:17px;line-height:1.25;min-width:310px}
.foot .red{color:#d9635d;text-decoration:underline;font-weight:1000}
.time{text-align:right;color:rgba(255,255,255,.55);font-size:13px;font-weight:800;margin-top:6px}
</style>
</head>
<body>${body}</body>
</html>`;
}

async function renderSingle(ch) {
  const avatar = await inlineAvatar(ch.avatarUrl, ch.title);
  const history = await historyFor(ch.key, 'subscribers');

  const subValues = history.length ? history.map((x) => x.value) : [ch.subscribers];
  const subLabels = history.length ? history.map((x) => x.label) : [todayMsk()];

  const html = htmlWrap(`
<div class="card">
  <div class="inner">
    <div class="sheet">
      <div class="top">
        <div class="left">
          ${avatar}
          <div class="title">
            <b>${esc(ch.title)}</b>
            <span>данные MAX · ${esc(nowMskHuman())}</span>
          </div>
        </div>
        <div class="lr">LinkRay Analytics</div>
      </div>

      <div class="metrics">
        <div class="metric"><div class="k">Подписчики</div><div class="v">${fmt(ch.subscribers)}</div></div>
        <div class="metric ${ch.deltaDay < 0 ? 'red' : 'green'}"><div class="k">Сегодня</div><div class="v">${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}</div></div>
        <div class="metric green"><div class="k">Охват 24ч</div><div class="v">${fmt(ch.views24)}</div></div>
        <div class="metric"><div class="k">ER24</div><div class="v">${pct(ch.er24)}</div></div>
      </div>

      <div class="grid">
        <div class="panel">
          <div class="ph"><b>Динамика подписчиков</b><span>по дням</span></div>
          <div class="chart">${chartSvg(subValues, subLabels)}</div>
        </div>
        <div class="panel">
          <div class="ph"><b>Охваты поста</b><span>MAX</span></div>
          <div class="chart">${barSvg([ch.views24, ch.views48, ch.views72], ['24ч','48ч','72ч'])}</div>
        </div>
      </div>
    </div>

    <div class="txt">
      <div class="cap">
        <span class="red">${esc(ch.title)}</span><br>
        Подписчики: <b>${fmt(ch.subscribers)}</b> | ER24: <b>${pct(ch.er24)}</b> · Охват: <b>${fmt(ch.views24)} / ${fmt(ch.views48)} / ${fmt(ch.views72)}</b>
      </div>
      <div>
        <div class="foot"><span class="red">LinkRay</span> — аналитика каналов и рекламных размещений в MAX</div>
        <div class="time">${esc(nowMskHuman().slice(-5))}</div>
      </div>
    </div>
  </div>
</div>`);

  return renderPng(html, `single-${ch.key}`);
}

async function renderNetwork(channels) {
  const totalSubs = channels.reduce((sum, ch) => sum + ch.subscribers, 0);
  const total24 = channels.reduce((sum, ch) => sum + ch.views24, 0);
  const total48 = channels.reduce((sum, ch) => sum + ch.views48, 0);
  const total72 = channels.reduce((sum, ch) => sum + ch.views72, 0);
  const totalDelta = channels.reduce((sum, ch) => sum + ch.deltaDay, 0);
  const er24 = totalSubs ? (total24 / totalSubs) * 100 : 0;

  const history = await networkHistory(channels);
  const histValues = history.length ? history.map((x) => x.value) : [totalSubs];
  const histLabels = history.length ? history.map((x) => x.label) : [todayMsk()];

  const sorted = [...channels].sort((a, b) => b.views24 - a.views24).slice(0, 4);

  const rowHtml = [];
  for (const ch of sorted) {
    const avatar = await inlineAvatar(ch.avatarUrl, ch.title);
    rowHtml.push(`
      <div class="row">
        ${avatar}
        <span class="name">${esc(short(ch.title, 34))}</span>
        <b>${fmt(ch.views24)}</b>
        <em class="${ch.deltaDay < 0 ? 'minus' : 'plus'}">${ch.deltaDay > 0 ? '+' : ''}${fmt(ch.deltaDay)}</em>
      </div>
    `);
  }

  const html = htmlWrap(`
<div class="card">
  <div class="inner">
    <div class="sheet">
      <div class="top" style="justify-content:center;text-align:center">
        <div class="title">
          <b style="font-size:24px">Статистика по всей сетке каналов</b>
          <span>LinkRay Analytics · ${channels.length} каналов · ${esc(nowMskHuman())}</span>
        </div>
      </div>

      <div class="metrics">
        <div class="metric"><div class="k">Подписчики</div><div class="v">${fmt(totalSubs)}</div></div>
        <div class="metric green"><div class="k">Просмотры 24ч</div><div class="v">${fmt(total24)}</div></div>
        <div class="metric"><div class="k">Общий ER</div><div class="v">${pct(er24)}</div></div>
        <div class="metric ${totalDelta < 0 ? 'red' : 'green'}"><div class="k">Сегодня</div><div class="v">${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)}</div></div>
      </div>

      <div class="grid net">
        <div class="panel">
          <div class="ph"><b>Общие подписчики сети</b><span>по дням</span></div>
          <div class="chart">${chartSvg(histValues, histLabels)}</div>
        </div>

        <div class="panel">
          <div class="ph"><b>Каналы</b><span>охват 24ч</span></div>
          <div class="rows">${rowHtml.join('')}</div>
        </div>
      </div>
    </div>

    <div class="txt">
      <div class="cap">
        👥 Всего подписчиков в <b>${channels.length} каналах:</b> <b>${fmt(totalSubs)}</b><br>
        👁 Просмотры: <b>24ч ${fmt(total24)}</b> · <b>48ч ${fmt(total48)}</b> · <b>72ч ${fmt(total72)}</b>
      </div>
      <div>
        <div class="foot"><span class="red">LinkRay</span> — сводная аналитика каналов MAX</div>
        <div class="time">${esc(nowMskHuman().slice(-5))}</div>
      </div>
    </div>
  </div>
</div>`);

  return renderPng(html, `network-${hash(channels.map((c) => c.key).join('-'))}`);
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

async function handleLinks(chatId, links) {
  await saveUserLinks(chatId, links);

  const channels = [];

  for (const link of links) {
    const ch = await resolveChannel(link);
    channels.push(ch);
  }

  const image = channels.length === 1
    ? await renderSingle(channels[0])
    : await renderNetwork(channels);

  const caption = channels.length === 1
    ? `📊 <b>LinkRay Analytics</b>\n${esc(channels[0].title)}`
    : `📊 <b>LinkRay Analytics</b>\nСводка по ${channels.length} каналам`;

  await sendImage(chatId, image, caption);

  await sendMaxMessage({
    chatId,
    text:
      '━━━━━━━━━━━━━━\n' +
      '⚙️ <b>Ежедневная аналитика</b>\n\n' +
      'Бот может присылать сводку каждый день в 08:00 МСК по этим каналам.\n' +
      '━━━━━━━━━━━━━━',
    format: 'html',
    attachments: [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [{ type: 'callback', text: '✅ Включить 08:00', payload: 'lrchan:on' }],
            [{ type: 'callback', text: '⛔ Отключить', payload: 'lrchan:off' }],
          ],
        },
      },
    ],
  });
}

async function sendDailyForRow(row) {
  const chatId = String(row.chat_id);
  const links = Array.isArray(row.links) ? row.links : [];

  if (!links.length) return;

  const channels = [];

  for (const link of links) {
    channels.push(await resolveChannel(link));
  }

  const totalSubs = channels.reduce((sum, ch) => sum + ch.subscribers, 0);
  const totalDelta = channels.reduce((sum, ch) => sum + ch.deltaDay, 0);
  const signed = channels.reduce((sum, ch) => sum + Math.max(0, ch.deltaDay), 0);
  const lost = channels.reduce((sum, ch) => sum + Math.abs(Math.min(0, ch.deltaDay)), 0);

  const image = channels.length === 1
    ? await renderSingle(channels[0])
    : await renderNetwork(channels);

  const lines = channels
    .map((ch, i) => {
      const d = ch.deltaDay > 0 ? `+${fmt(ch.deltaDay)}` : fmt(ch.deltaDay);
      return `${i + 1}) ${esc(short(ch.title, 34))}: <b>${fmt(ch.subscribers)}</b> (${d})`;
    })
    .join('\n');

  const text =
    '━━━━━━━━━━━━━━\n' +
    '🌅 <b>Утренняя аналитика LinkRay</b>\n\n' +
    `👥 Всего подписчиков: <b>${fmt(totalSubs)}</b>\n` +
    `✅ Подписалось: <b>${fmt(signed)}</b>\n` +
    `❌ Отписалось: <b>${fmt(lost)}</b>\n` +
    `📊 Итог за сутки: <b>${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)}</b>\n\n` +
    lines +
    '\n━━━━━━━━━━━━━━';

  await sendImage(chatId, image, text);
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
      const payload = getPayload(update);
      const chatId = getChatId(update);

      if (!chatId) return next();

      if (payload === 'lrchan:on') {
        await setDaily(chatId, true);
        await sendMaxMessage({
          chatId,
          text: '✅ Ежедневная аналитика включена.\nСводка будет приходить каждый день в 08:00 МСК.',
          format: 'html',
        });
        return res.json({ ok: true });
      }

      if (payload === 'lrchan:off') {
        await setDaily(chatId, false);
        await sendMaxMessage({
          chatId,
          text: '⛔ Ежедневная аналитика отключена.',
          format: 'html',
        });
        return res.json({ ok: true });
      }

      const text = getText(update);
      const links = extractMaxLinks(text);

      if (!links.length) return next();
      if (!isOnlyAnalyticsLinks(text, links)) return next();

      await handleLinks(chatId, links);

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

  await handleLinks(target, [
    'https://max.ru/join/test-channel-one',
    'https://max.ru/join/test-channel-two',
  ]);

  return true;
}
