import crypto from 'node:crypto';
import { query } from './db.js';

const BOT_LINK = 'https://max.ru/se13353901_bot';
const LOGO_WEBP_B64 = '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';

const logoBytes = Buffer.from(LOGO_WEBP_B64, 'base64');
const rows = (r) => Array.isArray(r) ? r : (r?.rows || []);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function safeJson(v, fallback = {}) {
  try {
    if (!v) return fallback;
    if (typeof v === 'object') return v;
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function stripHtml(v) {
  return String(v || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function linkify(text) {
  return esc(text || '')
    .replace(/(https?:\/\/[^\s<>"']+)/gi, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, '<br>');
}

function sanitizePostHtml(text, format = '') {
  const src = String(text || '');

  if (String(format || '').toLowerCase() !== 'html' && !/<\/?[a-z][\s\S]*>/i.test(src)) {
    return linkify(src);
  }

  return src
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<(?!\/?(a|b|strong|i|em|u|s|del|ins|br|p|div|span|blockquote|code|pre)\b)[^>]*>/gi, '')
    .replace(/<a\b([^>]*)>/gi, (m, attrs) => {
      const href = String(attrs || '').match(/href=["']([^"']+)["']/i)?.[1] || '';
      if (!/^https?:\/\//i.test(href)) return '<span>';
      return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">';
    })
    .replace(/\n/g, '<br>');
}

function ruDate(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }) + ' МСК';
  } catch {
    return String(value || '');
  }
}

function ruTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleTimeString('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function money(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  }).format(Number.isFinite(n) ? n : 0) + ' ₽';
}

function number(value) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(value || 0)));
}

function autoDeleteText(minutes) {
  const n = Number(minutes || 0);
  if (!Number.isFinite(n) || n <= 0) return 'не задано';
  if (n % 1440 === 0) return String(n / 1440) + ' дн.';
  if (n % 60 === 0) return String(n / 60) + ' ч.';
  return String(n) + ' мин.';
}

function getViews(snapshot) {
  const s = snapshot || {};
  const candidates = [
    s.maxViews,
    s.totalViews,
    s.views,
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

async function trySyncMaxViews(post) {
  if (!post?.published_message_id) return post;

  try {
    const mod = await import('./maxClient.js');
    const fn = mod.getMaxMessage || mod.default?.getMaxMessage;

    if (!fn) return post;

    const result = await fn(post.published_message_id);
    const msg = Array.isArray(result?.messages) ? result.messages[0] : (result?.message || result);
    const stat = msg?.stat || result?.stat || {};
    const views = Number(stat.views ?? stat.view_count ?? stat.views_count ?? stat.reads ?? stat.impressions);

    if (!Number.isFinite(views) || views < 0) return post;

    const snapshot = safeJson(post.report_snapshot, {});
    snapshot.views = Math.round(views);
    snapshot.totalViews = Math.round(views);
    snapshot.maxViews = Math.round(views);
    snapshot.maxStat = stat;
    snapshot.lastMaxSyncAt = new Date().toISOString();

    await query(
      `UPDATE scheduled_posts
       SET report_snapshot=$2::jsonb
       WHERE id=$1`,
      [post.id, JSON.stringify(snapshot)]
    ).catch(() => {});

    return { ...post, report_snapshot: snapshot };
  } catch (error) {
    console.error('[analytics max sync]', error.message || error);
    return post;
  }
}

function getMedia(attachments) {
  const data = safeJson(attachments, []);
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
      type = type || String(item.type || item.kind || '');

      for (const key of ['url', 'src', 'previewUrl', 'preview_url', 'thumbnailUrl', 'thumbnail_url', 'imageUrl', 'image_url', 'videoUrl', 'video_url']) {
        if (/^https?:\/\//i.test(String(item[key] || ''))) {
          url = String(item[key]);
          return;
        }
      }

      for (const value of Object.values(item)) scan(value);
    }
  };

  scan(data);

  if (!url) return null;

  return {
    url,
    kind: /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url) || /video/i.test(type) ? 'video' : 'image',
  };
}

function statusInfo(posts) {
  const first = posts[0] || {};
  const statuses = posts.map((p) => String(p.status || '').toLowerCase());

  if (statuses.some((s) => ['deleted', 'canceled', 'cancelled'].includes(s)) || first.auto_deleted_at) {
    return {
      key: 'deleted',
      icon: '🗑️',
      title: 'Удалён',
      text: first.auto_deleted_at ? 'Удалено: ' + ruDate(first.auto_deleted_at) : 'Пост удалён или отменён.',
    };
  }

  if (first.published_at || statuses.includes('published')) {
    return {
      key: 'published',
      icon: '✅',
      title: 'Опубликован',
      text: [
        first.published_at ? 'Опубликовано: ' + ruDate(first.published_at) : '',
        first.auto_delete_minutes ? 'Автоудаление: через ' + autoDeleteText(first.auto_delete_minutes) : '',
        'Последняя синхронизация MAX: ' + (ruTime(new Date()) || 'сейчас'),
      ].filter(Boolean).join('<br>'),
    };
  }

  if (first.publish_at) {
    return {
      key: 'scheduled',
      icon: '⏳',
      title: 'Запланирован',
      text: 'Публикация: ' + ruDate(first.publish_at),
    };
  }

  return {
    key: 'draft',
    icon: '📝',
    title: 'Черновик',
    text: 'Пост ещё не опубликован.',
  };
}

function titleFromText(text) {
  const clean = stripHtml(text).replace(/\s+/g, ' ').trim();
  return clean ? (clean.length > 86 ? clean.slice(0, 86) + '…' : clean) : 'Отчёт по рекламному размещению';
}

function distributeTimeline(total) {
  const v = Number(total || 0);

  return [
    { label: '1ч', value: Math.round(v * 0.16) },
    { label: '12ч', value: Math.round(v * 0.48) },
    { label: '24ч', value: Math.round(v * 0.72) },
    { label: '48ч', value: Math.round(v * 0.91) },
    { label: '72ч', value: Math.round(v) },
  ];
}

async function ensureViewPoints() {
  await query(`CREATE TABLE IF NOT EXISTS analytics_view_points (
    id bigserial PRIMARY KEY,
    campaign_id text NOT NULL,
    post_id integer,
    views integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_lr_view_points_campaign ON analytics_view_points(campaign_id, created_at)`).catch(() => {});
}

async function timelineFor(campaignId, postId, views) {
  await ensureViewPoints();

  const key = String(campaignId || postId || 'unknown');
  const v = Math.max(0, Math.round(Number(views || 0)));

  const last = rows(await query(
    `SELECT views FROM analytics_view_points
     WHERE campaign_id=$1
     ORDER BY created_at DESC
     LIMIT 1`,
    [key]
  ).catch(() => []))[0];

  if (!last || Number(last.views) !== v) {
    await query(
      `INSERT INTO analytics_view_points(campaign_id, post_id, views)
       VALUES($1,$2,$3)`,
      [key, Number(postId || 0) || null, v]
    ).catch(() => {});
  }

  const points = rows(await query(
    `SELECT views, created_at
     FROM analytics_view_points
     WHERE campaign_id=$1
     ORDER BY created_at ASC
     LIMIT 6`,
    [key]
  ).catch(() => []));

  if (points.length >= 3) {
    return points.map((p) => ({
      label: ruTime(p.created_at) || '',
      value: Number(p.views || 0),
    }));
  }

  return distributeTimeline(v);
}

async function collect(groupId) {
  const id = String(groupId || '').trim();

  let posts = rows(await query(
    `SELECT sp.*, c.title AS channel_title, c.link AS channel_link
     FROM scheduled_posts sp
     LEFT JOIN channels c ON c.id = sp.channel_id
     WHERE sp.id::text = $1
        OR COALESCE(sp.report_group_id, '') = $1
        OR COALESCE(sp.draft->>'campaignId', '') = $1
     ORDER BY sp.id ASC`,
    [id]
  ));

  posts = await Promise.all(posts.map(trySyncMaxViews));

  const first = posts[0] || {};
  const draft = safeJson(first.draft, {});
  const snapshot = safeJson(first.report_snapshot, {});
  const text = first.text || draft?.content?.text || '';
  const cpm = Number(first.cpm || snapshot.cpm || draft.cpm || 0);

  const channels = posts.map((post) => {
    const ps = safeJson(post.report_snapshot, {});
    const views = getViews(ps);
    return {
      id: post.id,
      title: post.channel_title || 'Канал',
      link: post.channel_link || '',
      views,
      cost: (views * cpm) / 1000,
      publishedAt: post.published_at || post.publish_at || '',
      status: String(post.status || ''),
    };
  });

  const totalViews = channels.reduce((sum, c) => sum + Number(c.views || 0), 0) || getViews(snapshot);
  const cost = (totalViews * cpm) / 1000;
  const maxChannel = [...channels].sort((a, b) => b.views - a.views)[0] || null;
  const campaignId = first.report_group_id || draft.campaignId || first.id || id;
  const timeline = await timelineFor(campaignId, first.id, totalViews);
  const forecastViews = totalViews ? Math.max(totalViews, Math.round(totalViews * 1.25)) : 0;
  const forecastCost = (forecastViews * cpm) / 1000;

  return {
    id,
    title: 'Отчёт по рекламному размещению',
    status: statusInfo(posts),
    postTitle: titleFromText(text),
    postHtml: sanitizePostHtml(text, first.format || draft?.content?.format),
    media: getMedia(first.attachments || draft?.content?.attachments),
    metrics: {
      views: totalViews,
      cpm,
      cost,
      channelsCount: channels.length,
      autoDelete: autoDeleteText(first.auto_delete_minutes),
      forecastViews,
      forecastCost,
      topChannel: maxChannel?.title || '—',
      topShare: totalViews && maxChannel ? Math.round((maxChannel.views / totalViews) * 100) : 0,
    },
    channels: channels.map((c) => ({
      ...c,
      share: totalViews ? Math.round((c.views / totalViews) * 100) : 0,
    })),
    timeline,
  };
}

function bars(timeline) {
  const list = Array.isArray(timeline) ? timeline : [];
  const max = Math.max(1, ...list.map((x) => Number(x.value || 0)));

  return list.map((x) => {
    const value = Number(x.value || 0);
    const h = Math.max(8, Math.round((value / max) * 100));
    return `<div class="bar" style="height:${h}%"><b>${number(value)}</b><span>${esc(x.label)}</span></div>`;
  }).join('');
}

function channelsHtml(channels) {
  if (!channels.length) {
    return '<div class="channel"><div class="ch-main"><div class="avatar">—</div><div><div class="ch-name">Каналы пока не найдены</div><div class="ch-time">после публикации появятся размещения</div></div></div></div>';
  }

  return channels.map((ch) => {
    const first = esc((ch.title || 'К').slice(0, 1));
    return `<div class="channel">
      <div class="ch-main">
        <div class="avatar">${first}</div>
        <div>
          <div class="ch-name">${esc(ch.title)}</div>
          <div class="ch-time">${esc(ruDate(ch.publishedAt) || 'время не задано')}</div>
        </div>
      </div>
      <div class="ch-metric"><b>${number(ch.views)}</b><span>просмотров</span></div>
      <div class="ch-metric"><b>${money(ch.cost)}</b><span>стоимость</span></div>
      <div class="ch-metric"><b>${number(ch.share)}%</b><span>доля охвата</span></div>
    </div>`;
  }).join('');
}

function page(data) {
  const mediaBlock = data.media
    ? `<div class="media">${data.media.kind === 'video'
        ? `<video controls muted playsinline src="${esc(data.media.url)}"></video>`
        : `<img src="${esc(data.media.url)}" alt="Медиа поста">`}</div>`
    : `<div class="media"><div class="media-inner">Медиа поста</div></div>`;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>LinkRay Analytics</title>
<style>
:root{--card:#ffffff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--blue:#2563eb;--mint:#27e0b2;--shadow:0 22px 70px rgba(2,8,23,.18);--soft:0 14px 42px rgba(15,23,42,.08)}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:radial-gradient(circle at 10% -8%,rgba(39,224,178,.30),transparent 32%),radial-gradient(circle at 92% -4%,rgba(78,164,255,.30),transparent 30%),linear-gradient(180deg,#f7fbff,#eef4ff 55%,#eaf2ff)}
a{color:inherit}.wrap{max-width:1180px;margin:0 auto;padding:16px 12px 46px}
.top-promo{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:12px;padding:12px 14px;border-radius:22px;background:linear-gradient(135deg,rgba(8,21,39,.95),rgba(13,55,79,.88));color:#fff;border:1px solid rgba(255,255,255,.12);box-shadow:var(--soft)}
.top-promo-main{display:flex;align-items:center;gap:10px;min-width:0}.top-promo img{width:38px;height:38px;border-radius:14px;object-fit:cover;flex:0 0 auto}.top-promo b{display:block;font-size:14px;line-height:1.12}.top-promo span{display:block;color:#cbe8f2;font-size:12px;margin-top:2px}.top-promo a{text-decoration:none;background:linear-gradient(135deg,var(--mint),#4ea4ff);color:#071527;border-radius:15px;padding:10px 13px;font-weight:1000;white-space:nowrap}
.hero{position:relative;overflow:hidden;min-height:420px;border-radius:36px;padding:24px;color:#fff;box-shadow:var(--shadow);background:linear-gradient(90deg,rgba(5,15,30,.91),rgba(9,36,64,.76),rgba(23,105,78,.60)),url("/analytics/logo.webp") center/cover no-repeat}
.hero:after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 18% 16%,rgba(39,224,178,.22),transparent 28%),radial-gradient(circle at 86% 8%,rgba(158,255,122,.14),transparent 24%),linear-gradient(180deg,transparent 45%,rgba(3,9,18,.36))}
.hero-grid{position:relative;z-index:2;display:grid;grid-template-columns:1fr 330px;gap:22px;align-items:stretch}.brand{display:flex;align-items:center;gap:14px;margin-bottom:36px}.logo{width:82px;height:82px;border-radius:28px;object-fit:cover;border:1px solid rgba(255,255,255,.25);box-shadow:0 18px 48px rgba(39,224,178,.22)}.brand-title{font-size:23px;font-weight:1000;letter-spacing:-.03em}.brand-sub{color:#cde7ef;font-weight:750;font-size:13px;margin-top:3px}
h1{margin:0 0 14px;font-size:clamp(38px,7vw,76px);line-height:.92;letter-spacing:-.07em;max-width:760px}.lead{margin:0;max-width:780px;color:#daf4fb;font-size:19px;line-height:1.55}
.status-card{display:flex;flex-direction:column;justify-content:space-between;gap:14px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.12);backdrop-filter:blur(18px);border-radius:28px;padding:18px}.status-icon{width:58px;height:58px;border-radius:20px;background:#fff;color:#071527;display:grid;place-items:center;font-size:29px}.status-title{font-size:24px;font-weight:1000;margin-top:12px}.status-text{color:#d6edf7;margin-top:8px;line-height:1.45}.copy-btn{border:0;background:#fff;color:#081527;border-radius:18px;padding:13px 15px;font-weight:1000;cursor:pointer}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}.card,.panel,.feature{background:rgba(255,255,255,.95);color:var(--ink);border:1px solid rgba(226,232,240,.95);border-radius:30px;box-shadow:var(--soft)}.card{padding:18px}.label{color:var(--muted);font-size:14px;font-weight:850}.value{font-size:36px;line-height:1;font-weight:1000;letter-spacing:-.055em;margin:10px 0 6px}.sub{color:#475569;font-size:13px;font-weight:800;line-height:1.35}
.forecast{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px}.forecast .card{background:linear-gradient(135deg,#fff,#f0fff8)}
.two{display:grid;grid-template-columns:1.04fr .96fr;gap:14px}.panel{padding:20px;margin:14px 0}.panel h2{margin:0 0 15px;font-size:29px;line-height:1.1;letter-spacing:-.04em}
.post{overflow:hidden;border:1px solid var(--line);border-radius:26px;background:#f8fbff}.media{height:232px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(78,164,255,.15),rgba(39,224,178,.14)),linear-gradient(45deg,#eef6ff,#f8fbff)}.media img,.media video{width:100%;max-height:520px;object-fit:contain;background:#081527}.media-inner{width:86%;height:72%;border-radius:24px;background:linear-gradient(135deg,#dcecff,#e8fff7);display:grid;place-items:center;color:#52627a;font-weight:900;padding:16px;text-align:center}.post-body{padding:18px}.post-title{font-size:24px;line-height:1.17;font-weight:1000;margin-bottom:13px}.post-text{font-size:16px;line-height:1.58;color:#263445}.post-text a{color:#1277ff;font-weight:900;text-decoration:underline;text-underline-offset:3px}
.timeline{height:278px;display:flex;align-items:end;gap:10px;padding:22px 12px 18px;border:1px solid var(--line);border-radius:26px;background:linear-gradient(to top,#e6edf7 1px,transparent 1px) 0 0/100% 25%,#fbfdff}.bar{flex:1;min-width:20px;min-height:10px;position:relative;border-radius:17px 17px 8px 8px;background:linear-gradient(180deg,var(--blue),var(--mint));box-shadow:0 12px 22px rgba(47,109,246,.18)}.bar b{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);font-size:12px;white-space:nowrap}.bar span{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);color:var(--muted);font-size:12px;font-weight:900}
.channels{display:grid;gap:10px}.channel{display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:12px;padding:14px;border:1px solid var(--line);border-radius:23px;background:#fbfdff}.ch-main{display:flex;align-items:center;gap:12px;min-width:0}.avatar{width:48px;height:48px;border-radius:17px;display:grid;place-items:center;font-weight:1000;color:#123879;background:linear-gradient(135deg,#dbeafe,#dcfce7)}.ch-name{font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ch-time{margin-top:2px;color:var(--muted);font-size:13px}.ch-metric{text-align:right}.ch-metric b{display:block;font-size:20px}.ch-metric span{color:var(--muted);font-size:12px;font-weight:850}
.features{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.feature{min-height:160px;background:linear-gradient(135deg,#fff,#f1f7ff);padding:16px}.feature-icon{width:44px;height:44px;border-radius:16px;display:grid;place-items:center;margin-bottom:12px;font-size:22px;background:linear-gradient(135deg,#dbeafe,#dcfce7)}.feature b{display:block;font-size:18px;margin-bottom:7px}.feature p{margin:0;color:#475569;line-height:1.45;font-size:14px}
.promo-bottom{margin-top:14px;display:flex;justify-content:space-between;align-items:center;gap:14px;padding:19px;border-radius:30px;color:#fff;background:linear-gradient(90deg,rgba(5,15,30,.88),rgba(10,39,68,.74),rgba(21,90,72,.66)),url("/analytics/logo.webp") center/cover no-repeat;box-shadow:var(--shadow)}.promo-bottom b{font-size:23px;letter-spacing:-.02em}.promo-bottom p{margin:6px 0 0;color:#d8f4fb;line-height:1.42}.promo-bottom a{background:#fff;color:#081527;text-decoration:none;padding:14px 17px;border-radius:18px;font-weight:1000;white-space:nowrap}.footer{text-align:center;color:#6f859d;font-size:13px;margin-top:16px}
@media(max-width:960px){.hero-grid,.two{grid-template-columns:1fr}.metrics,.features{grid-template-columns:repeat(2,1fr)}.forecast{grid-template-columns:1fr}.channel{grid-template-columns:1fr 1fr}.ch-main{grid-column:1/-1}}
@media(max-width:560px){.wrap{padding:10px 8px 32px}.top-promo,.promo-bottom{flex-direction:column;align-items:flex-start}.top-promo a,.promo-bottom a{width:100%;text-align:center}.hero,.panel,.card,.feature,.promo-bottom{border-radius:24px}.hero{padding:18px;min-height:auto}.brand{margin-bottom:26px}.status-card{min-height:250px}.metrics,.features{grid-template-columns:1fr}.panel{padding:16px}.panel h2{font-size:25px}.media{height:190px}.timeline{height:242px;gap:6px}.value{font-size:32px}}
</style>
<script>
setInterval(async function(){
  try {
    const r = await fetch(location.pathname + '?json=1&v=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    location.reload();
  } catch(e) {}
}, 60000);
</script>
</head>
<body>
<div class="wrap">
  <section class="top-promo">
    <div class="top-promo-main">
      <img src="/analytics/logo.webp" alt="LinkRay">
      <div><b>LinkRay — отчёты для рекламы в MAX</b><span>Автопостинг, закупы и прозрачная стоимость размещений.</span></div>
    </div>
    <a href="${BOT_LINK}" target="_blank" rel="noopener noreferrer">Открыть бота</a>
  </section>

  <section class="hero">
    <div class="hero-grid">
      <div>
        <div class="brand"><img class="logo" src="/analytics/logo.webp" alt="LinkRay"><div><div class="brand-title">LinkRay Analytics</div><div class="brand-sub">публичный отчёт для рекламодателя</div></div></div>
        <h1>${esc(data.title)}</h1>
        <p class="lead">Статус размещения, актуальный пост, просмотры MAX, CPM, стоимость, каналы и динамика размещения.</p>
      </div>
      <aside class="status-card">
        <div><div class="status-icon">${esc(data.status.icon)}</div><div class="status-title">${esc(data.status.title)}</div><div class="status-text">${data.status.text}</div></div>
        <button class="copy-btn" onclick="navigator.clipboard.writeText(location.href).then(()=>alert('Ссылка скопирована'))">Скопировать ссылку на отчёт</button>
      </aside>
    </div>
  </section>

  <section class="metrics">
    <div class="card"><div class="label">Просмотры MAX</div><div class="value">${number(data.metrics.views)}</div><div class="sub">суммарно по каналам</div></div>
    <div class="card"><div class="label">CPM</div><div class="value">${money(data.metrics.cpm)}</div><div class="sub">цена за 1000 просмотров</div></div>
    <div class="card"><div class="label">Стоимость</div><div class="value">${money(data.metrics.cost)}</div><div class="sub">${number(data.metrics.views)} × ${number(data.metrics.cpm)} / 1000</div></div>
    <div class="card"><div class="label">Каналы</div><div class="value">${number(data.metrics.channelsCount)}</div><div class="sub">размещения в MAX</div></div>
  </section>

  <section class="forecast">
    <div class="card"><div class="label">Лучший канал</div><div class="value" style="font-size:26px">${esc(data.metrics.topChannel)}</div><div class="sub">${number(data.metrics.topShare)}% всех просмотров</div></div>
    <div class="card"><div class="label">Прогноз до удаления</div><div class="value">${number(data.metrics.forecastViews)}</div><div class="sub">ожидаемые просмотры к концу</div></div>
    <div class="card"><div class="label">Прогноз стоимости</div><div class="value">${money(data.metrics.forecastCost)}</div><div class="sub">по текущему CPM</div></div>
  </section>

  <section class="two">
    <div class="panel">
      <h2>Пост</h2>
      <div class="post">${mediaBlock}<div class="post-body"><div class="post-title">${esc(data.postTitle)}</div><div class="post-text">${data.postHtml || 'Текст поста пока недоступен'}</div></div></div>
    </div>
    <div class="panel">
      <h2>Динамика просмотров</h2>
      <div class="timeline">${bars(data.timeline)}</div>
    </div>
  </section>

  <section class="panel"><h2>Размещения по каналам</h2><div class="channels">${channelsHtml(data.channels)}</div></section>

  <section class="features">
    <div class="feature"><div class="feature-icon">🎯</div><b>Один статус</b><p>Показывается текущее состояние и время следующего события.</p></div>
    <div class="feature"><div class="feature-icon">💸</div><b>CPM</b><p>Стоимость считается по формуле: просмотры × CPM / 1000.</p></div>
    <div class="feature"><div class="feature-icon">🧭</div><b>Доля охвата</b><p>Видно, какой канал дал основную часть просмотров.</p></div>
    <div class="feature"><div class="feature-icon">🔮</div><b>Прогноз</b><p>Прогноз просмотров и стоимости до автоудаления.</p></div>
  </section>

  <section class="promo-bottom"><div><b>LinkRay — отчёты и автопостинг для MAX</b><p>Публичный отчёт для рекламодателя: аккуратно, понятно и без лишних метрик.</p></div><a href="${BOT_LINK}" target="_blank" rel="noopener noreferrer">Открыть LinkRay</a></section>
  <div class="footer">LinkRay Analytics · отчёт обновляется автоматически</div>
</div>
</body>
</html>`;
}

export function mountLinkRayAnalyticsRoutes(app) {
  app.get('/analytics/logo.webp', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', 'image/webp');
    res.end(logoBytes);
  });

  app.get('/analytics/stats/:groupId', async (req, res) => {
    try {
      const data = await collect(req.params.groupId);
      res.setHeader('Cache-Control', 'no-store');

      if (String(req.query.json || '') === '1') {
        return res.json(data);
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(page(data));
    } catch (error) {
      console.error('[linkray analytics]', error.message || error);
      return res.status(500).send('LinkRay analytics error: ' + esc(error.message || error));
    }
  });

  app.get('/r/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '').trim();
      const link = rows(await query('SELECT target_url FROM analytics_links WHERE token=$1 LIMIT 1', [token]))[0];

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
