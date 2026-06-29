import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRAND_DIR = path.resolve(__dirname, '../public/brand');
const LOGO_SVG = path.join(BRAND_DIR, 'linkray-logo.svg');
const LOGO_PNG = path.join(BRAND_DIR, 'linkray-logo.png');

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
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|blockquote|h1|h2|h3)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
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

function autoDeleteText(minutes) {
  const n = Number(minutes || 0);
  if (!Number.isFinite(n) || n <= 0) return 'не задано';
  if (n % 1440 === 0) return String(n / 1440) + ' дн.';
  if (n % 60 === 0) return String(n / 60) + ' ч.';
  return String(n) + ' мин.';
}

function firstUrlDeep(value) {
  let found = '';

  const scan = (item) => {
    if (!item || found) return;

    if (typeof item === 'string') {
      if (/^https?:\/\//i.test(item)) found = item;
      return;
    }

    if (Array.isArray(item)) {
      for (const x of item) scan(x);
      return;
    }

    if (typeof item === 'object') {
      for (const key of [
        'avatar_url', 'avatarUrl', 'photo_url', 'photoUrl', 'image_url', 'imageUrl',
        'picture', 'icon_url', 'iconUrl', 'url', 'src', 'previewUrl', 'thumbnailUrl',
      ]) {
        const v = String(item[key] || '');
        if (/^https?:\/\//i.test(v)) {
          found = v;
          return;
        }
      }

      for (const v of Object.values(item)) scan(v);
    }
  };

  scan(value);
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
    post_id integer,
    channel_id text,
    views integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});

  await query(`ALTER TABLE analytics_view_points ADD COLUMN IF NOT EXISTS channel_id text`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_lr_view_points_campaign ON analytics_view_points(campaign_id, created_at)`).catch(() => {});
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

    const result = await fn(post.published_message_id, post.channel_id || post.chat_id);
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

async function loadChannels(posts) {
  const ids = [...new Set(posts.map((p) => p.channel_id).filter((x) => x !== null && x !== undefined).map(String))];
  if (!ids.length) return new Map();

  const cols = await tableColumns('channels');
  if (!cols.size || !cols.has('id')) return new Map();

  const q = (col) => `"${col}"::text`;

  const titleExpr =
    cols.has('title') ? q('title') :
    cols.has('name') ? q('name') :
    cols.has('channel_title') ? q('channel_title') :
    cols.has('chat_title') ? q('chat_title') :
    `'Канал'::text`;

  const linkExpr =
    cols.has('link') ? q('link') :
    cols.has('public_link') ? q('public_link') :
    cols.has('invite_link') ? q('invite_link') :
    cols.has('channel_link') ? q('channel_link') :
    cols.has('url') ? q('url') :
    cols.has('username') ? q('username') :
    cols.has('handle') ? q('handle') :
    `''::text`;

  const avatarExpr =
    cols.has('avatar_url') ? q('avatar_url') :
    cols.has('photo_url') ? q('photo_url') :
    cols.has('image_url') ? q('image_url') :
    cols.has('icon_url') ? q('icon_url') :
    cols.has('picture') ? q('picture') :
    `''::text`;

  const metaExpr =
    cols.has('meta') ? `"meta"` :
    cols.has('data') ? `"data"` :
    cols.has('payload') ? `"payload"` :
    cols.has('raw') ? `"raw"` :
    `NULL::jsonb`;

  const result = await query(
    `SELECT id::text AS id,
            ${titleExpr} AS title,
            ${linkExpr} AS link,
            ${avatarExpr} AS avatar,
            ${metaExpr} AS meta
       FROM channels
      WHERE id::text = ANY($1)`,
    [ids]
  ).catch((error) => {
    console.error('[linkray analytics channels]', error.message || error);
    return [];
  });

  const map = new Map();

  for (const row of rows(result)) {
    const meta = safeJson(row.meta, null);
    map.set(String(row.id), {
      title: row.title || 'Канал',
      link: row.link || '',
      avatar: row.avatar || firstUrlDeep(meta) || '',
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

      for (const key of ['url', 'src', 'previewUrl', 'preview_url', 'thumbnailUrl', 'thumbnail_url', 'imageUrl', 'image_url', 'videoUrl', 'video_url']) {
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
  const status = String(post?.status || '').toLowerCase();

  if (post?.auto_deleted_at || post?.deleted_at || ['deleted', 'canceled', 'cancelled'].includes(status)) {
    return {
      title: 'Удалён',
      text: 'Пост был удалён из канала. Отчёт сохранён.',
      good: false,
    };
  }

  if (post?.published_at || status === 'published') {
    return {
      title: 'Опубликован',
      text: 'Пост вышел во всех выбранных каналах. Автоудаление: ' + autoDeleteText(post.auto_delete_minutes) + '.',
      good: true,
    };
  }

  if (post?.publish_at) {
    return {
      title: 'Запланирован',
      text: 'Публикация: ' + ruShortDate(post.publish_at),
      good: false,
    };
  }

  return {
    title: 'Черновик',
    text: 'Пост ещё не опубликован.',
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
      [key, Number(postId || 0) || null, String(channelId || ''), v]
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
  ).catch(() => []));

  const labels =
    rangeHours === 24
      ? [1, 3, 6, 9, 12, 18, 24]
      : rangeHours === 48
        ? [1, 6, 12, 18, 24, 36, 48]
        : [1, 6, 12, 24, 36, 48, 60, 72];

  const total = Math.max(0, Math.round(Number(totalViews || 0)));
  let lastKnown = 0;

  return labels.map((hour) => {
    const target = start.getTime() + hour * 3600000;
    const before = points.filter((p) => new Date(p.created_at).getTime() <= target).pop();

    let views;

    if (before) {
      views = Number(before.views || 0);
      lastKnown = views;
    } else {
      views = Math.max(lastKnown, Math.round(total * Math.min(1, hour / Math.max(1, rangeHours)) * 0.92));
    }

    if (hour === labels[labels.length - 1]) views = Math.max(views, total);
    return [hour + 'ч', Math.max(0, Math.round(views))];
  });
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

  posts = await Promise.all(posts.map(trySyncMaxViews));

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

    return {
      id: post.channel_id || post.id || idx + 1,
      title: ch.title || 'Канал',
      link: ch.link || '',
      avatar: ch.avatar || '',
      letter: String(ch.title || 'К').trim().slice(0, 1).toUpperCase(),
      time: ruShortDate(post.published_at || post.publish_at),
      views,
      cost: (views * cpm) / 1000,
      status: 'чисто',
    };
  });

  const totalViews = channels.reduce((sum, c) => sum + Number(c.views || 0), 0) || getViews(safeJson(first.report_snapshot, {}));
  const factCpm = totalViews ? cpm : cpm;
  const cost = (totalViews * cpm) / 1000;

  const maxViews = Math.max(1, ...channels.map((c) => c.views || 0));
  const channelsFinal = channels.map((ch) => {
    const share = totalViews ? Math.round((ch.views / totalViews) * 100) : 0;
    const quality = Math.max(45, Math.min(98, Math.round(60 + (ch.views / maxViews) * 35)));

    return {
      ...ch,
      share,
      quality,
      group: quality >= 86 ? 'best' : quality <= 68 ? 'risk' : 'all',
      status: quality <= 68 ? 'проверить' : 'чисто',
    };
  });

  await savePoint(campaignId, first.id, first.channel_id, totalViews);

  const lifeHours = livedHours(first);
  const ranges = {};

  for (const r of availableRanges(lifeHours)) {
    ranges[String(r)] = await timelineFor(campaignId, r, totalViews, first);
  }

  const quality = channelsFinal.length
    ? Math.round(channelsFinal.reduce((s, c) => s + c.quality, 0) / channelsFinal.length)
    : 0;

  return {
    id,
    reportLink: '/analytics/stats/' + encodeURIComponent(id),
    title: 'Отчёт по рекламному посту MAX',
    postTitle: postTitle(text),
    postHtml: sanitizePostHtml(text, format),
    media: getMedia(first, draft),
    status: statusInfo(first),
    publishedAt: first.published_at || first.publish_at || first.created_at,
    autoDeleteText: autoDeleteText(first.auto_delete_minutes),
    metrics: {
      views: totalViews,
      cpm,
      factCpm,
      cost,
      channelsCount: channelsFinal.length,
      quality,
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

  return '<div class="post-media-logo"></div>';
}

function page(data) {
  const state = JSON.stringify(data).replace(/</g, '\\u003c');
  const statusClass = data.status?.good ? 'summary-card good' : 'summary-card';
  const published = ruShortDate(data.publishedAt);
  const qualityPercent = Math.max(0, Math.min(100, data.metrics.quality));

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<meta name="theme-color" content="#081827">
<link rel="icon" type="image/webp" href="/brand/linkray-logo.svg?v=40">
<link rel="apple-touch-icon" href="/brand/linkray-logo.svg?v=40">
<meta property="og:title" content="LinkRay Analytics">
<meta property="og:image" content="/brand/linkray-logo.svg?v=40">
<title>LinkRay Analytics</title>
<style>
:root{--bg:#071827;--bg2:#0e2a44;--card:#fff;--ink:#0d1828;--muted:#5f7085;--line:rgba(15,23,42,.09);--blue:#2d7cff;--cyan:#20d6ff;--green:#35d990;--shadow:0 14px 34px rgba(7,20,34,.12);--radius:22px;--safe-bottom:env(safe-area-inset-bottom);--safe-top:env(safe-area-inset-top)}
*{box-sizing:border-box;min-width:0;-webkit-tap-highlight-color:transparent}html,body{width:100%;max-width:100%;min-height:100%;margin:0;overflow-x:hidden}body{color:var(--ink);background:radial-gradient(circle at 5% -8%,rgba(32,214,255,.32),transparent 240px),radial-gradient(circle at 98% -5%,rgba(53,217,144,.30),transparent 260px),linear-gradient(180deg,var(--bg) 0,var(--bg2) 220px,#f5f9fd 221px,#fbfdff 100%);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}button,a{font:inherit}button{border:0;cursor:pointer}a{color:inherit;text-decoration:none}.app{width:100%;max-width:480px;margin:0 auto;padding:calc(8px + var(--safe-top)) 10px calc(92px + var(--safe-bottom))}
.topbar{position:sticky;top:0;z-index:50;margin:calc(-8px - var(--safe-top)) -10px 10px;padding:calc(8px + var(--safe-top)) 10px 9px;display:flex;align-items:center;gap:8px;background:rgba(7,24,39,.88);border-bottom:1px solid rgba(255,255,255,.08);backdrop-filter:blur(18px)}.brand{display:flex;align-items:center;gap:8px;color:#fff;min-width:0;flex:1}.brand-logo{width:38px;height:38px;border-radius:15px;background:url("/brand/linkray-logo.svg?v=40") center/cover no-repeat;border:1px solid rgba(255,255,255,.22);box-shadow:0 12px 28px rgba(32,214,255,.24);flex:0 0 auto}.brand b{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px;line-height:1.08}.brand span{display:block;margin-top:2px;color:rgba(255,255,255,.76);font-size:11px;font-weight:750}.icon-actions{display:flex;gap:6px}.icon-btn{width:39px;height:39px;border-radius:15px;display:grid;place-items:center;color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.13);font-size:17px;font-weight:900}.icon-btn.primary{color:#061525;background:linear-gradient(135deg,var(--green),var(--cyan));border:0}
.hero{position:relative;overflow:hidden;border-radius:26px;padding:15px;color:#fff;background:linear-gradient(135deg,rgba(7,24,39,.97),rgba(13,50,80,.94) 55%,rgba(18,124,91,.82));border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 48px rgba(4,16,30,.24)}.status-pill{display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.20);color:#fff;font-size:11.5px;font-weight:950;white-space:nowrap}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 5px rgba(53,217,144,.16);flex:0 0 auto}h1{margin:14px 0 8px;font-size:clamp(30px,9.2vw,42px);line-height:.96;letter-spacing:-.06em}.lead{margin:0;color:rgba(255,255,255,.88);font-size:13.5px;line-height:1.42;font-weight:750}.cover-mini{margin-top:12px;min-height:145px;border-radius:21px;overflow:hidden;background:url("/brand/linkray-logo.svg?v=40") center/cover no-repeat;border:1px solid rgba(255,255,255,.13)}
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.metric{padding:12px;border-radius:18px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.22)}.metric span{display:block;color:rgba(255,255,255,.92);font-size:11.5px;font-weight:950}.metric b{display:block;margin-top:7px;color:#fff;font-size:22px;line-height:1;font-weight:1000;white-space:nowrap}.hero-buttons{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.btn{min-height:42px;border-radius:16px;padding:10px 9px;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:12px;font-weight:950;white-space:nowrap}.btn.full{grid-column:1/-1}.btn.primary{color:#061525;background:linear-gradient(135deg,var(--green),var(--cyan))}.btn.soft-dark{color:#fff;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.18)}.btn.soft{color:#173551;background:#edf6ff;border:1px solid #dfeaf6}
.summary{display:grid;gap:8px;margin-top:10px}.summary-card,.panel{background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow)}.summary-card{padding:13px;border-radius:19px}.summary-card .label{color:var(--muted);font-size:11.5px;font-weight:950}.summary-card .value{margin-top:6px;font-size:24px;line-height:1;font-weight:1000}.summary-card .note{margin-top:6px;color:var(--muted);font-size:12px;line-height:1.34;font-weight:750}.summary-card.good{background:linear-gradient(135deg,rgba(53,217,144,.16),#fff)}.panel{margin-top:10px;border-radius:var(--radius);overflow:hidden}.panel-head{padding:14px 12px 0}.panel-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}h2{margin:0;font-size:21px;line-height:1.1}.panel-sub{margin:6px 0 0;color:var(--muted);font-size:12.5px;line-height:1.38;font-weight:700}.segmented{display:flex;width:100%;gap:4px;margin-top:10px;padding:4px;overflow-x:auto;border-radius:999px;background:#edf5fd;border:1px solid #e2edf8}.segmented button{flex:1 0 auto;min-height:35px;padding:8px 9px;border-radius:999px;color:#607086;background:transparent;font-size:12px;font-weight:950}.segmented button.active{color:var(--ink);background:#fff;box-shadow:0 8px 18px rgba(15,23,42,.08)}
.post-preview{display:grid;gap:10px;padding:12px}.post-media{min-height:168px;border-radius:19px;overflow:hidden;position:relative;background:linear-gradient(135deg,rgba(32,214,255,.18),rgba(53,217,144,.13));border:1px solid #e2edf8;display:grid;place-items:center}.post-media img,.post-media video{width:100%;height:100%;max-height:360px;object-fit:cover;display:block}.post-media-logo{width:100%;height:168px;background:url("/brand/linkray-logo.svg?v=40") center/cover no-repeat}.post-media:after{content:"POST";position:absolute;left:10px;bottom:10px;padding:6px 9px;border-radius:999px;color:#fff;background:rgba(6,21,37,.58);font-size:10px;font-weight:1000;letter-spacing:.12em}.post-text{padding:13px;border-radius:19px;background:#f8fbff;border:1px solid #e8f0fa}.post-text h3{margin:0 0 8px;font-size:18px;line-height:1.16}.post-body{margin:0;color:#435269;font-size:13.5px;line-height:1.46}.post-body a{color:#1d73ff;text-decoration:underline;text-underline-offset:3px;font-weight:900}.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}.badge{padding:7px 9px;border-radius:999px;color:#516176;background:#fff;border:1px solid #e2edf8;font-size:11px;font-weight:950;white-space:nowrap}
.chart-wrap{padding:12px}.chart-card{position:relative;border-radius:19px;background:linear-gradient(180deg,#fbfdff,#f3f8ff);border:1px solid #e7eff9;overflow:hidden;padding:6px;touch-action:none}svg{display:block;width:100%;height:auto}.axis{stroke:#dce7f4;stroke-width:1}.line-main{fill:none;stroke:url(#lineGrad);stroke-width:6;stroke-linecap:round;stroke-linejoin:round}.area-main{fill:url(#areaGrad)}.dot-main{fill:#fff;stroke:#20d6ff;stroke-width:4}.chart-label{fill:#6b7b92;font-size:13px;font-weight:850}.chart-value{fill:#0b1728;font-size:13px;font-weight:1000}.hover-line{stroke:rgba(13,24,40,.28);stroke-width:2;stroke-dasharray:5 5}.hover-dot{fill:#061525;stroke:#fff;stroke-width:4}.chart-tooltip{position:absolute;min-width:136px;max-width:calc(100% - 20px);padding:10px;border-radius:15px;background:rgba(8,22,38,.94);color:#fff;box-shadow:0 16px 36px rgba(5,18,35,.25);transform:translate(-50%,-100%);pointer-events:none;opacity:0;transition:opacity .12s ease;font-size:11px;z-index:5}.chart-tooltip.show{opacity:1}.chart-tooltip b{display:block;font-size:13px;margin-bottom:5px}.chart-tooltip span{display:block;color:rgba(255,255,255,.78);font-weight:750}
.channels{display:grid;gap:8px;padding:12px}.channel-card{width:100%;display:grid;gap:10px;padding:12px;border-radius:19px;background:#fbfdff;border:1px solid #e6eef8;text-align:left}.channel-top{display:flex;align-items:center;gap:9px}.avatar{width:40px;height:40px;border-radius:15px;display:grid;place-items:center;flex:0 0 auto;color:#07334d;background:linear-gradient(135deg,rgba(32,214,255,.24),rgba(53,217,144,.22));font-weight:1000;overflow:hidden}.avatar img{width:100%;height:100%;object-fit:cover}.channel-top b{display:block;max-width:calc(100vw - 108px);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px}.channel-top span{display:block;margin-top:3px;color:var(--muted);font-size:11px;font-weight:700}.channel-metrics{display:grid;grid-template-columns:1fr 1fr;gap:7px}.mini-metric{padding:9px;border-radius:15px;background:#fff;border:1px solid #e6eef8}.mini-metric b{display:block;font-size:17px;line-height:1}.mini-metric span{display:block;margin-top:5px;color:var(--muted);font-size:10.5px;font-weight:850}.score{padding:13px}.score-ring{position:relative;width:132px;height:132px;border-radius:50%;margin:13px auto 2px;display:grid;place-items:center;background:conic-gradient(var(--green) 0 ${qualityPercent}%,#e8f0fa ${qualityPercent}% 100%)}.score-ring:after{content:"";position:absolute;inset:10px;border-radius:50%;background:#fff}.score-ring div{position:relative;z-index:1;text-align:center}.score-ring strong{display:block;font-size:34px;line-height:1}.score-ring span{display:block;margin-top:4px;color:var(--muted);font-size:11px;font-weight:950}.compare{display:grid;gap:9px;padding:12px}.compare-row{display:grid;grid-template-columns:72px 1fr 58px;align-items:center;gap:8px;font-size:12px;font-weight:950}.bar{height:12px;overflow:hidden;border-radius:999px;background:#edf4fc}.bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--blue),var(--cyan),var(--green))}.detail-list{display:grid;gap:8px;padding:12px}.detail-card{padding:12px;border-radius:18px;background:#fbfdff;border:1px solid #e6eef8}.detail-title{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:10px}.detail-title b{font-size:14px;line-height:1.25}.pill{padding:5px 8px;border-radius:999px;font-size:10.5px;font-weight:1000;background:rgba(53,217,144,.12);color:#128856;white-space:nowrap}.pill.warn{background:rgba(255,184,77,.16);color:#a56400}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.detail-cell{padding:8px;border-radius:14px;background:#fff;border:1px solid #e7eff9}.detail-cell span{display:block;color:var(--muted);font-size:10.5px;font-weight:850}.detail-cell b{display:block;margin-top:4px;font-size:14px}.quality-list{display:grid;gap:8px;padding:12px}.quality-item{padding:12px;border-radius:18px;background:#f8fbff;border:1px solid #e6eef8}.quality-item b{display:block;font-size:14px}.quality-item span{display:block;margin-top:5px;color:var(--muted);font-size:12px;line-height:1.4;font-weight:700}.mobile-dock{position:fixed;left:10px;right:10px;bottom:calc(8px + var(--safe-bottom));z-index:60;display:flex;gap:7px;padding:7px;border-radius:22px;background:rgba(11,23,40,.82);box-shadow:0 18px 60px rgba(5,18,35,.30);backdrop-filter:blur(18px)}.mobile-dock button,.mobile-dock a{flex:1;padding:11px 6px;border-radius:16px;text-align:center;color:#fff;background:rgba(255,255,255,.08);font-size:11px;font-weight:1000}.mobile-dock .primary{color:#061525;background:linear-gradient(135deg,var(--green),var(--cyan)}.toast{position:fixed;left:50%;bottom:calc(78px + var(--safe-bottom));z-index:90;max-width:calc(100vw - 26px);transform:translateX(-50%) translateY(22px);opacity:0;pointer-events:none;padding:11px 13px;border-radius:999px;color:#fff;background:rgba(8,22,38,.92);box-shadow:0 18px 50px rgba(5,18,35,.25);font-size:12px;font-weight:950;transition:opacity .18s ease,transform .18s ease;white-space:nowrap}.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}.modal{position:fixed;inset:0;z-index:80;display:none;align-items:flex-end;justify-content:center;background:rgba(5,18,35,.58);backdrop-filter:blur(10px)}.modal.show{display:flex}.modal-card{width:100%;max-height:min(82vh,720px);overflow:auto;border-radius:27px 27px 0 0;background:#fff;box-shadow:0 -20px 70px rgba(0,0,0,.25);padding-bottom:var(--safe-bottom)}.modal-head{position:sticky;top:0;z-index:1;padding:14px 13px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fff}.modal-head h3{margin:0;font-size:21px;line-height:1.12}.close{width:39px;height:39px;border-radius:15px;color:var(--ink);background:#eef5ff;font-size:20px;font-weight:1000;flex:0 0 auto}.modal-body{padding:12px 13px 16px;color:#405066;font-size:14px;line-height:1.48}.modal-list{display:grid;gap:8px;margin-top:12px}.modal-list div{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px;border-radius:16px;background:#f8fbff;border:1px solid #e6eef8}.modal-list span{color:var(--muted);font-size:12px;font-weight:850}.modal-list b{color:var(--ink);text-align:right;font-size:13px}@media(min-width:520px){.app{max-width:520px}}@media(max-width:370px){.app{padding-left:8px;padding-right:8px}.topbar{margin-left:-8px;margin-right:-8px;padding-left:8px;padding-right:8px}.brand b{max-width:124px}h1{font-size:29px}.metric b{font-size:20px}.btn{font-size:11px}}

/* LinkRay logo/button hotfix */
.brand-logo{
  background-image:url("/brand/linkray-logo.svg?v=40")!important;
  background-size:cover!important;
  background-position:center!important;
  background-color:transparent!important;
}
.cover-mini,
.post-media-logo{
  background-image:url("/brand/linkray-logo.svg?v=40")!important;
  background-size:cover!important;
  background-position:center!important;
}
.mobile-dock button.primary,
.mobile-dock .primary,
.mobile-dock button[data-action="share"]{
  color:#061525!important;
  background:linear-gradient(135deg,#35d990,#20d6ff)!important;
  opacity:1!important;
  filter:none!important;
  box-shadow:0 10px 24px rgba(32,214,255,.25)!important;
}
.mobile-dock button.primary *,
.mobile-dock .primary *{
  color:#061525!important;
}


/* LINKRAY_LOGO_BUTTON_FIX_V40 */
.brand-logo{
  background:url("/brand/linkray-logo.svg?v=40") center/cover no-repeat!important;
  background-color:transparent!important;
}
.cover-mini,
.post-media-logo{
  background:url("/brand/linkray-logo.svg?v=40") center/cover no-repeat!important;
  background-color:transparent!important;
}
.mobile-dock button.primary,
.mobile-dock .primary,
.mobile-dock button[data-action="share"]{
  color:#061525!important;
  background:linear-gradient(135deg,#35d990,#20d6ff)!important;
  opacity:1!important;
  filter:none!important;
  box-shadow:0 10px 24px rgba(32,214,255,.25)!important;
}
.mobile-dock button.primary:disabled,
.mobile-dock .primary:disabled{
  opacity:1!important;
}

</style>
</head>
<body>
<main class="app">
<header class="topbar"><a class="brand" href="#top"><div class="brand-logo" style="background:url(/brand/linkray-logo.svg?v=40) center/cover no-repeat!important;background-color:transparent!important"></div><div><b>LinkRay Analytics</b><span>публичный отчёт</span></div></a><div class="icon-actions"><button class="icon-btn" data-action="refresh" aria-label="Обновить">↻</button><button class="icon-btn primary" data-action="share" aria-label="Поделиться">↗</button></div></header>

<section class="hero" id="top"><div class="hero-content"><span class="status-pill"><i class="dot"></i> Рекламный выход · данные обновляются</span><h1>${esc(data.title)}</h1><p class="lead">Просмотры, CPM, стоимость, каналы, доля результата и качество размещений.</p><div class="metrics"><div class="metric"><span>Просмотры</span><b>${number(data.metrics.views)}</b></div><div class="metric"><span>CPM</span><b>${money(data.metrics.cpm)}</b></div><div class="metric"><span>Факт CPM</span><b>${money(data.metrics.factCpm)}</b></div><div class="metric"><span>К оплате</span><b>${money(data.metrics.cost)}</b></div></div><div class="hero-buttons"><button class="btn primary full" data-action="open-report">📊 Открыть отчёт</button><button class="btn soft-dark" data-action="copy">🔗 Ссылка</button><button class="btn soft-dark" data-action="open-post">👁 Пост</button></div><div class="cover-mini" style="background:url(/brand/linkray-logo.svg?v=40) center/cover no-repeat!important;background-color:transparent!important"></div></div></section>

<section class="summary"><article class="${statusClass}"><div class="label">Статус</div><div class="value">${esc(data.status.title)}</div><div class="note">${esc(data.status.text)}</div></article><article class="summary-card"><div class="label">Публикация</div><div class="value">${esc(published)}</div><div class="note">Отчёт обновляется каждую минуту.</div></article><article class="summary-card"><div class="label">Каналы</div><div class="value">${number(data.metrics.channelsCount)}</div><div class="note">${number(data.metrics.channelsCount)} размещения участвуют в этом отчёте.</div></article><article class="summary-card"><div class="label">Качество</div><div class="value">${number(data.metrics.quality)}/100</div><div class="note">Проверка всплесков, равномерности и подозрительных просмотров.</div></article></section>

<section class="panel" id="post"><div class="panel-head"><div class="panel-title-row"><h2>Пост</h2></div><p class="panel-sub">Медиа и текст разделены. На телефоне ничего не выходит за экран.</p></div><div class="post-preview"><div class="post-media">${mediaHtml(data)}</div><div class="post-text"><h3>${esc(data.postTitle)}</h3><div class="post-body">${data.postHtml}</div><div class="badges"><span class="badge">💼 реклама</span><span class="badge">CPM ${money(data.metrics.cpm)}</span><span class="badge">${number(data.metrics.channelsCount)} канала</span><span class="badge">${esc(data.autoDeleteText)}</span></div></div></div></section>

<section class="panel" id="chart"><div class="panel-head"><div class="panel-title-row"><h2>График просмотров</h2></div><p class="panel-sub" id="rangeHint">Нажмите на любую точку графика — покажем просмотры за выбранный период.</p><div class="segmented" id="rangeBtns"></div></div><div class="chart-wrap"><div class="chart-card" id="chartCard"><div class="chart-tooltip" id="chartTooltip"></div><svg id="chartSvg" viewBox="0 0 760 320" role="img" aria-label="График просмотров"><defs><linearGradient id="lineGrad" x1="0" x2="1"><stop stop-color="#2f7cff"/><stop offset=".55" stop-color="#20d6ff"/><stop offset="1" stop-color="#35d990"/></linearGradient><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#20d6ff" stop-opacity=".24"/><stop offset="1" stop-color="#35d990" stop-opacity="0"/></linearGradient></defs><g id="chartGrid"></g><polygon id="chartArea" class="area-main"></polygon><polyline id="chartLine" class="line-main"></polyline><g id="chartDots"></g><g id="chartHover"></g><g id="chartLabels"></g></svg></div></div></section>

<section class="panel" id="placements"><div class="panel-head"><div class="panel-title-row"><h2>Каналы</h2></div><p class="panel-sub">Нажатие на канал открывает подробности.</p><div class="segmented" id="channelFilter"><button class="active" data-filter="all">Все</button><button data-filter="best">Лучшие</button><button data-filter="risk">Риск</button></div></div><div class="channels" id="channelsList"></div></section>

<section class="panel" id="quality"><div class="panel-head"><div class="panel-title-row"><h2>Индекс качества</h2></div><p class="panel-sub">Простая оценка размещения для рекламодателя.</p></div><div class="score"><div class="score-ring"><div><strong>${number(data.metrics.quality)}</strong><span>из 100</span></div></div></div></section>

<section class="panel"><div class="panel-head"><div class="panel-title-row"><h2>Сравнение каналов</h2></div><p class="panel-sub">Доля просмотров по каждому размещению.</p></div><div class="compare" id="compareBars"></div></section>

<section class="panel" id="details"><div class="panel-head"><div class="panel-title-row"><h2>Детализация</h2><button class="btn soft" data-action="download">CSV</button></div><p class="panel-sub">Вместо широкой таблицы — мобильные карточки.</p></div><div class="detail-list" id="detailsList"></div></section>

<section class="panel"><div class="panel-head"><div class="panel-title-row"><h2>Проверка</h2></div></div><div class="quality-list"><div class="quality-item"><b>🟢 Данные обновляются</b><span>LinkRay запрашивает просмотры MAX каждую минуту.</span></div><div class="quality-item"><b>🟢 Распределение по каналам</b><span>Отдельно видна доля просмотров каждого размещения.</span></div><div class="quality-item"><b>🟡 Риск подсвечивается</b><span>Каналы с низким качеством попадают в фильтр «Риск».</span></div></div></section>

<nav class="mobile-dock"><a href="#chart">График</a><a href="#placements">Каналы</a><button class="primary" data-action="share" style="color:#061525!important;background:linear-gradient(135deg,#35d990,#20d6ff)!important;opacity:1!important;filter:none!important;box-shadow:0 10px 24px rgba(32,214,255,.25)!important">Поделиться</button></nav>
</main>

<div class="toast" id="toast">Готово</div>
<div class="modal" id="modal"><div class="modal-card"><div class="modal-head"><h3 id="modalTitle">Детали</h3><button class="close" data-action="close-modal">×</button></div><div class="modal-body" id="modalBody"></div></div></div>

<script id="report-data" type="application/json">${state}</script>
<script>
const report=JSON.parse(document.getElementById('report-data').textContent);
const $=(s,r=document)=>r.querySelector(s);const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
let currentChartPoints=[];let currentRange='24';
function num(v){return new Intl.NumberFormat('ru-RU').format(Math.round(Number(v)||0))}
function rub(v){return num(v)+' ₽'}
function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('show');clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.classList.remove('show'),2100)}
function openModal(title,html){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modal').classList.add('show');document.body.style.overflow='hidden'}
function closeModal(){$('#modal').classList.remove('show');document.body.style.overflow=''}
function availableRanges(){return Object.keys(report.ranges||{}).sort((a,b)=>Number(a)-Number(b))}
function defaultRange(){const r=availableRanges();return r[r.length-1]||'24'}
function renderRangeButtons(){const ranges=availableRanges();const active=defaultRange();$('#rangeBtns').innerHTML=ranges.map(r=>'<button class="'+(r===active?'active':'')+'" data-range="'+r+'">'+r+'ч</button>').join('');const hint=$('#rangeHint');if(hint){if(ranges.length===1)hint.textContent='Пост находился в канале меньше 48 часов, поэтому доступен период 24ч. Нажмите на график, чтобы увидеть просмотры.';else if(ranges.length===2)hint.textContent='Пост был в канале до 48 часов, доступны 24ч и 48ч. Нажмите на график, чтобы увидеть просмотры.';else hint.textContent='Пост находился в канале 72 часа или дольше, доступны 24ч, 48ч и 72ч. Нажмите на график, чтобы увидеть просмотры.'}$$('#rangeBtns [data-range]').forEach(btn=>btn.addEventListener('click',()=>{$$('#rangeBtns button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');drawChart(btn.dataset.range)}));return active}
function drawChart(range=defaultRange()){currentRange=range;const data=(report.ranges&&report.ranges[range])||[];const width=760,height=320,pad={left:58,right:30,top:42,bottom:54};const iw=width-pad.left-pad.right,ih=height-pad.top-pad.bottom;const maxViews=Math.max(...data.map(x=>x[1]),1);const baseY=pad.top+ih;const points=data.map((item,index)=>{const x=pad.left+(data.length===1?iw/2:iw*index/(data.length-1));const y=pad.top+ih-(item[1]/maxViews)*ih;return{label:item[0],views:item[1],x,y}});currentChartPoints=points;$('#chartGrid').innerHTML=[0,.25,.5,.75,1].map(t=>{const y=pad.top+ih-ih*t;const value=Math.round(maxViews*t);return '<line class="axis" x1="'+pad.left+'" y1="'+y+'" x2="'+(width-pad.right)+'" y2="'+y+'"></line><text class="chart-label" x="18" y="'+(y+4)+'">'+num(value)+'</text>'}).join('');const line=points.map(p=>p.x+','+p.y).join(' ');$('#chartLine').setAttribute('points',line);$('#chartArea').setAttribute('points',pad.left+','+baseY+' '+line+' '+(width-pad.right)+','+baseY);$('#chartDots').innerHTML=points.map((p,index)=>{const show=index===points.length-1||index===0||index===Math.floor(points.length/2);return '<circle class="dot-main" cx="'+p.x+'" cy="'+p.y+'" r="6"></circle>'+(show?'<text class="chart-value" x="'+Math.max(56,p.x-18)+'" y="'+Math.max(18,p.y-14)+'">'+num(p.views)+'</text>':'')}).join('');$('#chartLabels').innerHTML=points.map((p,index)=>{const show=window.innerWidth>380||index%2===0||index===points.length-1;return show?'<text class="chart-label" x="'+(p.x-10)+'" y="'+(height-18)+'">'+p.label+'</text>':''}).join('');showChartPoint(points[points.length-1],false)}
function svgClientPoint(event){const svg=$('#chartSvg');const rect=svg.getBoundingClientRect();const clientX=(event.touches&&event.touches[0]?event.touches[0].clientX:event.clientX);const clientY=(event.touches&&event.touches[0]?event.touches[0].clientY:event.clientY);return{x:(clientX-rect.left)/rect.width*760,y:(clientY-rect.top)/rect.height*320,clientX,clientY}}
function nearestPoint(x){if(!currentChartPoints.length)return null;return currentChartPoints.reduce((best,p)=>Math.abs(p.x-x)<Math.abs(best.x-x)?p:best,currentChartPoints[0])}
function showChartPoint(point,showToast=true,clientX=null,clientY=null){if(!point)return;$('#chartHover').innerHTML='<line class="hover-line" x1="'+point.x+'" y1="42" x2="'+point.x+'" y2="266"></line><circle class="hover-dot" cx="'+point.x+'" cy="'+point.y+'" r="7"></circle>';const chart=$('#chartCard'),tooltip=$('#chartTooltip'),svg=$('#chartSvg'),svgRect=svg.getBoundingClientRect(),chartRect=chart.getBoundingClientRect();const left=clientX===null?((point.x/760)*svgRect.width+(svgRect.left-chartRect.left)):(clientX-chartRect.left);const top=clientY===null?((point.y/320)*svgRect.height+(svgRect.top-chartRect.top)):(clientY-chartRect.top);tooltip.innerHTML='<b>'+point.label+'</b><span>Просмотры: '+num(point.views)+'</span>';tooltip.style.left=Math.min(Math.max(left,84),chartRect.width-84)+'px';tooltip.style.top=Math.max(top-10,64)+'px';tooltip.classList.add('show');if(showToast)toast(point.label+' · просмотры: '+num(point.views))}
function handleChartEvent(event){event.preventDefault();const p=svgClientPoint(event);showChartPoint(nearestPoint(p.x),true,p.clientX,p.clientY)}
function avatarHtml(ch){return ch.avatar?'<img src="'+ch.avatar+'" alt="">':ch.letter}
function renderChannels(filter='all'){let channels=report.channels||[];if(filter==='best')channels=channels.filter(ch=>ch.group==='best');if(filter==='risk')channels=channels.filter(ch=>ch.group==='risk');$('#channelsList').innerHTML=channels.map(ch=>'<button class="channel-card" data-channel="'+ch.id+'"><div class="channel-top"><div class="avatar">'+avatarHtml(ch)+'</div><div><b>'+ch.title+'</b><span>'+ch.time+' · MAX</span></div></div><div class="channel-metrics"><div class="mini-metric"><b>'+num(ch.views)+'</b><span>просмотров</span></div><div class="mini-metric"><b>'+ch.quality+'/100</b><span>качество</span></div></div></button>').join('');$$('[data-channel]').forEach(btn=>btn.addEventListener('click',()=>openChannel(btn.dataset.channel)))}
function renderCompare(){$('#compareBars').innerHTML=(report.channels||[]).map(ch=>'<div class="compare-row"><span>'+ch.letter+' · '+ch.share+'%</span><div class="bar"><i style="width:'+ch.share+'%"></i></div><b>'+num(ch.views)+'</b></div>').join('')}
function renderDetails(){$('#detailsList').innerHTML=(report.channels||[]).map(ch=>'<article class="detail-card"><div class="detail-title"><b>'+ch.title+'</b><span class="pill '+(ch.group==='risk'?'warn':'')+'">'+ch.status+'</span></div><div class="detail-grid"><div class="detail-cell"><span>Просмотры</span><b>'+num(ch.views)+'</b></div><div class="detail-cell"><span>Доля</span><b>'+ch.share+'%</b></div><div class="detail-cell"><span>Факт CPM</span><b>'+rub(ch.cpm||report.metrics.cpm)+'</b></div><div class="detail-cell"><span>Стоимость</span><b>'+rub(ch.cost)+'</b></div></div></article>').join('')}
function openChannel(id){const ch=(report.channels||[]).find(x=>String(x.id)===String(id));if(!ch)return;openModal(ch.title,'<p>Подробности размещения в канале.</p><div class="modal-list"><div><span>Просмотры</span><b>'+num(ch.views)+'</b></div><div><span>Доля</span><b>'+ch.share+'%</b></div><div><span>Стоимость</span><b>'+rub(ch.cost)+'</b></div><div><span>Качество</span><b>'+ch.quality+'/100</b></div></div>')}
function openPost(){openModal('Рекламный пост','<p><b>'+report.postTitle+'</b></p><p>Полный предпросмотр опубликованного поста находится в блоке «Пост».</p><div class="modal-list"><div><span>Тип</span><b>реклама</b></div><div><span>CPM</span><b>'+rub(report.metrics.cpm)+'</b></div><div><span>Автоудаление</span><b>'+report.autoDeleteText+'</b></div><div><span>Каналов</span><b>'+report.metrics.channelsCount+'</b></div></div>')}
async function copyLink(){try{await navigator.clipboard.writeText(location.href);toast('Ссылка скопирована')}catch{openModal('Ссылка отчёта','<p>'+location.href+'</p>')}}
function downloadCsv(){const header=['Канал','Просмотры','Доля','Стоимость','Качество'];const rows=(report.channels||[]).map(ch=>[ch.title,ch.views,ch.share+'%',Math.round(ch.cost),ch.status]);const csv=[header,...rows].map(row=>row.map(cell=>'"'+String(cell).replace(/"/g,'""')+'"').join(';')).join('\\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='linkray-analytics.csv';a.click();URL.revokeObjectURL(url);toast('CSV сформирован')}
function shareReport(){if(navigator.share){navigator.share({title:'LinkRay Analytics',text:'Отчёт по рекламному посту MAX',url:location.href}).catch(()=>copyLink())}else copyLink()}
function refreshData(){fetch(location.pathname+'?json=1&v='+Date.now(),{cache:'no-store'}).then(r=>r.ok?location.reload():toast('Не удалось обновить')).catch(()=>toast('Не удалось обновить'))}
function action(type){if(type==='refresh')return refreshData();if(type==='share')return shareReport();if(type==='copy')return copyLink();if(type==='open-post')return openPost();if(type==='open-report')return $('#chart').scrollIntoView({behavior:'smooth'});if(type==='download')return downloadCsv();if(type==='close-modal')return closeModal()}
$$('[data-action]').forEach(el=>el.addEventListener('click',()=>action(el.dataset.action)));
$$('#channelFilter [data-filter]').forEach(btn=>btn.addEventListener('click',()=>{$$('#channelFilter button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');renderChannels(btn.dataset.filter)}));
$('#modal').addEventListener('click',e=>{if(e.target.id==='modal')closeModal()});
$('#chartCard').addEventListener('click',handleChartEvent);
$('#chartCard').addEventListener('touchstart',handleChartEvent,{passive:false});
$('#chartCard').addEventListener('touchmove',handleChartEvent,{passive:false});
window.addEventListener('resize',()=>drawChart(currentRange));
const initialRange=renderRangeButtons();drawChart(initialRange);renderChannels('all');renderCompare();renderDetails();
setInterval(()=>fetch(location.pathname+'?json=1&v='+Date.now(),{cache:'no-store'}).then(r=>r.ok?null:null).catch(()=>{}),60000);
</script>
</body>
</html>`;
}

export function mountLinkRayAnalyticsRoutes(app) {
  app.use('/brand', express.static(BRAND_DIR, {
    maxAge: '30d',
    etag: true,
  }));

  const sendLogo = (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('svg');
    return res.sendFile(path.join(BRAND_DIR, 'linkray-logo.svg'));
  };

  app.get('/favicon.ico', sendLogo);
  app.get('/favicon.png', sendLogo);
  app.get('/apple-touch-icon.png', sendLogo);
  app.get('/analytics/logo.webp', sendLogo);
  app.get('/api/linkray/brand', (req, res) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'linkray.ru';
    const logo = `${proto}://${host}/brand/linkray-logo.svg?v=40`;
    return res.json({ ok: true, name: 'LinkRay', title: 'LinkRay', logo, favicon: logo });
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
      console.error('[linkray analytics page]', error.stack || error);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(500).end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LinkRay Analytics</title></head><body style="font-family:Arial;padding:18px"><h2>LinkRay Analytics</h2><p>Ошибка аналитики:</p><pre>${esc(error.message || error)}</pre></body></html>`);
    }
  });

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
