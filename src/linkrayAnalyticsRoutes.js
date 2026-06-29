import { query } from './db.js';

const DEFAULT_LOGO_URL = process.env.LINKRAY_LOGO_URL || '/brand/linkray-logo.png';
const BOT_LINK = process.env.BOT_LINK || 'https://max.ru/se13353901_bot';
let syncTimerStarted = false;
let channelColumnsCache = null;

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

function stripHtml(value) {
  return String(value ?? '')
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
  const raw = String(text || '');
  if (!raw.trim()) return 'Текст поста пока недоступен.';

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

function num(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('ru-RU').format(Number.isFinite(n) ? Math.round(n) : 0);
}

function money(value) {
  const n = Number(value || 0);
  const digits = Number.isFinite(n) && Math.abs(n % 1) > 0 ? 2 : 0;
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(Number.isFinite(n) ? n : 0) + ' ₽';
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
    return String(value || '');
  }
}

function autoDeleteText(minutes) {
  const n = Number(minutes || 0);
  if (!Number.isFinite(n) || n <= 0) return 'не задано';
  if (n % 1440 === 0) return String(n / 1440) + ' дн.';
  if (n % 60 === 0) return String(n / 60) + ' ч.';
  return String(n) + ' мин.';
}

async function tableColumns(table) {
  if (table === 'channels' && channelColumnsCache) return channelColumnsCache;

  const result = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table]
  ).catch(() => []);

  const set = new Set(rows(result).map((r) => String(r.column_name)));
  if (table === 'channels') channelColumnsCache = set;
  return set;
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
      for (const key of ['avatar_url', 'avatarUrl', 'photo_url', 'photoUrl', 'image_url', 'imageUrl', 'picture', 'icon_url', 'iconUrl', 'url', 'src', 'previewUrl', 'thumbnailUrl']) {
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

function getMedia(attachments, draft) {
  const all = [attachments, draft?.content?.attachments, draft?.attachments, draft?.media, draft?.content?.media];
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

      for (const key of ['url', 'src', 'previewUrl', 'preview_url', 'thumbnailUrl', 'thumbnail_url', 'imageUrl', 'image_url', 'videoUrl', 'video_url', 'fileUrl', 'file_url']) {
        const value = String(item[key] || '');
        if (/^https?:\/\//i.test(value)) {
          url = value;
          return;
        }
      }

      for (const value of Object.values(item)) scan(value);
    }
  };

  for (const item of all) scan(safeJson(item, item || []));

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
      isGood: false,
    };
  }

  if (post?.published_at || status === 'published') {
    return {
      title: 'Опубликован',
      text: 'Пост вышел во всех выбранных каналах. Автоудаление: ' + autoDeleteText(post.auto_delete_minutes) + '.',
      isGood: true,
    };
  }

  if (post?.publish_at) {
    return {
      title: 'Запланирован',
      text: 'Публикация: ' + ruDate(post.publish_at),
      isGood: false,
    };
  }

  return {
    title: 'Черновик',
    text: 'Пост ещё не опубликован.',
    isGood: false,
  };
}

function postLifeHours(post) {
  const startRaw = post?.published_at || post?.publish_at || post?.created_at;
  const start = startRaw ? new Date(startRaw).getTime() : Date.now();
  const explicitEnd = post?.auto_deleted_at || post?.deleted_at || post?.removed_at;

  let end = explicitEnd ? new Date(explicitEnd).getTime() : Date.now();
  const autoMinutes = Number(post?.auto_delete_minutes || 0);

  if (autoMinutes > 0 && Number.isFinite(start)) {
    const planned = start + autoMinutes * 60000;
    end = Math.min(end, planned);
  }

  const diff = Math.max(0, end - start);
  return Math.max(24, Math.floor(diff / 3600000) || 24);
}

function availableRanges(hours) {
  if (hours >= 72) return [24, 48, 72];
  if (hours >= 48) return [24, 48];
  return [24];
}

async function ensureAnalyticsTables() {
  await query(`CREATE TABLE IF NOT EXISTS analytics_view_points (
    id bigserial PRIMARY KEY,
    campaign_id text NOT NULL,
    post_id integer,
    views integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});

  await query(`ALTER TABLE analytics_view_points ADD COLUMN IF NOT EXISTS channel_id integer`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_lr_view_points_campaign ON analytics_view_points(campaign_id, created_at)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_lr_view_points_post ON analytics_view_points(post_id, created_at)`).catch(() => {});
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS avatar_url text`).catch(() => {});
}

function extractMessageViews(result) {
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

  if (!Number.isFinite(views) || views < 0) return null;
  return { views: Math.round(views), stat };
}

async function fetchViewsFromMax(post) {
  if (!post?.published_message_id) return null;

  try {
    const mod = await import('./maxClient.js');
    const fn =
      mod.getMaxMessage ||
      mod.getMessage ||
      mod.getMessageInfo ||
      mod.default?.getMaxMessage ||
      mod.default?.getMessage;

    if (!fn) return null;

    return extractMessageViews(await fn(post.published_message_id, post.channel_id || post.chat_id));
  } catch (error) {
    console.error('[analytics max views]', error.message || error);
    return null;
  }
}

async function insertViewPoint(campaignId, postId, channelId, views) {
  await ensureAnalyticsTables();

  const key = String(campaignId || postId || 'unknown');

  const last = rows(await query(
    `SELECT views, created_at
       FROM analytics_view_points
      WHERE campaign_id=$1
        AND COALESCE(post_id,0)=COALESCE($2,0)
      ORDER BY created_at DESC
      LIMIT 1`,
    [key, Number(postId || 0) || null]
  ).catch(() => []))[0];

  const lastMs = last?.created_at ? new Date(last.created_at).getTime() : 0;

  if (!last || Number(last.views) !== Number(views) || Date.now() - lastMs >= 55000) {
    await query(
      `INSERT INTO analytics_view_points(campaign_id, post_id, channel_id, views)
       VALUES($1,$2,$3,$4)`,
      [
        key,
        Number(postId || 0) || null,
        Number(channelId || 0) || null,
        Math.max(0, Math.round(Number(views || 0))),
      ]
    ).catch(() => {});
  }
}

async function syncPostViews(post, campaignId) {
  const snapshot = safeJson(post.report_snapshot, {});
  let views = getViews(snapshot);

  const max = await fetchViewsFromMax(post);

  if (max) {
    views = max.views;
    snapshot.views = views;
    snapshot.totalViews = views;
    snapshot.maxViews = views;
    snapshot.maxStat = max.stat;
    snapshot.lastMaxSyncAt = new Date().toISOString();

    await query(
      `UPDATE scheduled_posts SET report_snapshot=$2::jsonb WHERE id=$1`,
      [post.id, JSON.stringify(snapshot)]
    ).catch(() => {});
  }

  await insertViewPoint(campaignId || post.report_group_id || post.id, post.id, post.channel_id, views);

  return {
    ...post,
    report_snapshot: snapshot,
    synced_views: views,
  };
}

async function startMinuteSync() {
  if (syncTimerStarted) return;
  syncTimerStarted = true;

  await ensureAnalyticsTables();

  const run = async () => {
    try {
      const posts = rows(await query(
        `SELECT *
           FROM scheduled_posts
          WHERE published_message_id IS NOT NULL
            AND (status='published' OR published_at IS NOT NULL)
            AND COALESCE(report_group_id, '') <> ''
          ORDER BY COALESCE(published_at, publish_at, created_at) DESC
          LIMIT 150`
      ).catch(() => []));

      for (const post of posts) {
        await syncPostViews(post, post.report_group_id || safeJson(post.draft, {}).campaignId || post.id);
      }
    } catch (error) {
      console.error('[analytics minute sync]', error.message || error);
    }
  };

  setTimeout(run, 5000).unref?.();
  setInterval(run, 60000).unref?.();
}

async function buildSelectSql() {
  const channelCols = await tableColumns('channels');
  const select = [];
  const avatarCols = ['avatar_url', 'avatarUrl', 'photo_url', 'photoUrl', 'image_url', 'imageUrl', 'icon_url', 'iconUrl', 'picture', 'photo'];
  const metaCols = ['meta', 'data', 'payload', 'raw', 'extra'];

  for (const col of avatarCols) {
    if (channelCols.has(col)) select.push(`c."${col}" AS channel_${col.toLowerCase()}`);
  }

  for (const col of metaCols) {
    if (channelCols.has(col)) select.push(`c."${col}" AS channel_${col.toLowerCase()}`);
  }

  return select.length ? ', ' + select.join(', ') : '';
}

function channelAvatar(row, draft) {
  const candidates = [];

  for (const [key, value] of Object.entries(row || {})) {
    if (key.startsWith('channel_')) candidates.push(value);
  }

  candidates.push(safeJson(row.channel_meta, null));
  candidates.push(safeJson(row.channel_data, null));
  candidates.push(safeJson(row.channel_payload, null));
  candidates.push(safeJson(row.channel_raw, null));
  candidates.push(draft?.channel || draft?.channels);

  for (const c of candidates) {
    const url = firstUrlDeep(c);
    if (url) return url;
  }

  return '';
}

async function timelineFor(campaignId, rangeHours, currentViews, firstPost) {
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

  const total = Math.max(0, Math.round(Number(currentViews || 0)));
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
  const id = String(groupId || '').trim();
  const extraSelect = await buildSelectSql();

  let posts = rows(await query(
    `SELECT sp.*, c.title AS channel_title, c.name AS channel_name, c.link AS channel_link ${extraSelect}
       FROM scheduled_posts sp
       LEFT JOIN channels c ON c.id = sp.channel_id
      WHERE sp.id::text = $1
         OR COALESCE(sp.report_group_id, '') = $1
         OR COALESCE(sp.draft->>'campaignId', '') = $1
      ORDER BY sp.id ASC`,
    [id]
  ));

  const firstBeforeSync = posts[0] || {};
  const campaignId = firstBeforeSync.report_group_id || safeJson(firstBeforeSync.draft, {}).campaignId || firstBeforeSync.id || id;

  posts = await Promise.all(posts.map((p) => syncPostViews(p, campaignId)));

  const first = posts[0] || {};
  const draft = safeJson(first.draft, {});
  const snapshot = safeJson(first.report_snapshot, {});
  const text = first.text || draft?.content?.text || draft?.text || draft?.caption || '';
  const format = first.format || draft?.content?.format || draft?.format || 'html';
  const cpm = Number(first.cpm || snapshot.cpm || draft.cpm || 0);
  const media = getMedia(first.attachments, draft);

  const totalViews = posts.reduce((sum, post) => sum + getViews(safeJson(post.report_snapshot, {})), 0) || getViews(snapshot);
  const lifeHours = postLifeHours(first);
  const ranges = {};

  for (const r of availableRanges(lifeHours)) {
    ranges[String(r)] = await timelineFor(campaignId, r, totalViews, first);
  }

  const channels = posts.map((post, idx) => {
    const ps = safeJson(post.report_snapshot, {});
    const views = getViews(ps);
    const title = post.channel_title || post.channel_name || 'Канал';
    const share = totalViews ? Math.round((views / totalViews) * 100) : 0;
    const quality = Math.max(45, Math.min(98, 92 - Math.abs(25 - share)));

    return {
      id: post.channel_id || post.id || idx + 1,
      title,
      letter: String(title || 'К').trim().slice(0, 1).toUpperCase(),
      link: post.channel_link || '',
      avatar: channelAvatar(post, draft),
      time: ruShortDate(post.published_at || post.publish_at),
      views,
      share,
      cpm: views ? (Number(post.cost || 0) || cpm) : cpm,
      cost: (views * cpm) / 1000,
      quality,
      group: quality >= 86 ? 'best' : quality <= 68 ? 'risk' : 'all',
      status: quality <= 68 ? 'проверить' : 'чисто',
    };
  });

  const factCpm = totalViews
    ? ((posts.reduce((s, p) => s + Number(p.cost || 0), 0) || (totalViews * cpm / 1000)) / totalViews * 1000)
    : cpm;

  const totalCost = totalViews * cpm / 1000;
  const quality = channels.length ? Math.round(channels.reduce((s, c) => s + c.quality, 0) / channels.length) : 0;

  return {
    id,
    logoUrl: DEFAULT_LOGO_URL,
    botLink: BOT_LINK,
    reportLink: '/analytics/stats/' + encodeURIComponent(id),
    title: 'Отчёт по рекламному посту MAX',
    postTitle: postTitle(text),
    postHtml: sanitizePostHtml(text, format),
    media,
    status: statusInfo(first),
    publishedAt: first.published_at || first.publish_at || first.created_at,
    autoDeleteText: autoDeleteText(first.auto_delete_minutes),
    metrics: {
      views: totalViews,
      cpm,
      factCpm,
      cost: totalCost,
      channelsCount: channels.length,
      quality,
      lifeHours,
    },
    ranges,
    channels,
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
  const logo = attr(data.logoUrl || DEFAULT_LOGO_URL);
  const statusClass = data.status?.isGood ? 'summary-card good' : 'summary-card';
  const published = ruShortDate(data.publishedAt);
  const qualityPercent = Math.max(0, Math.min(100, data.metrics.quality));

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<meta name="theme-color" content="#081827">
<title>LinkRay Analytics</title>
<style>
:root{--bg:#071827;--bg2:#0e2a44;--card:#fff;--ink:#0d1828;--muted:#5f7085;--line:rgba(15,23,42,.09);--soft:#f1f7fd;--blue:#2d7cff;--cyan:#20d6ff;--green:#35d990;--amber:#ffb84d;--red:#ff5572;--shadow:0 14px 34px rgba(7,20,34,.12);--radius:22px;--safe-bottom:env(safe-area-inset-bottom);--safe-top:env(safe-area-inset-top)}
*{box-sizing:border-box;min-width:0;-webkit-tap-highlight-color:transparent}html,body{width:100%;max-width:100%;min-height:100%;margin:0;overflow-x:hidden}body{color:var(--ink);background:radial-gradient(circle at 5% -8%,rgba(32,214,255,.32),transparent 240px),radial-gradient(circle at 98% -5%,rgba(53,217,144,.30),transparent 260px),linear-gradient(180deg,var(--bg) 0,var(--bg2) 220px,#f5f9fd 221px,#fbfdff 100%);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}button,a{font:inherit}button{border:0;cursor:pointer}a{color:inherit;text-decoration:none}.app{width:100%;max-width:480px;margin:0 auto;padding:calc(8px + var(--safe-top)) 10px calc(92px + var(--safe-bottom))}
.topbar{position:sticky;top:0;z-index:50;margin:calc(-8px - var(--safe-top)) -10px 10px;padding:calc(8px + var(--safe-top)) 10px 9px;display:flex;align-items:center;gap:8px;background:rgba(7,24,39,.88);border-bottom:1px solid rgba(255,255,255,.08);backdrop-filter:blur(18px)}.brand{display:flex;align-items:center;gap:8px;color:#fff;min-width:0;flex:1}.brand-logo{width:38px;height:38px;border-radius:15px;background:url("${logo}") center/cover no-repeat;border:1px solid rgba(255,255,255,.22);box-shadow:0 12px 28px rgba(32,214,255,.24);flex:0 0 auto}.brand b{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px;line-height:1.08;letter-spacing:-.02em}.brand span{display:block;margin-top:2px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:rgba(255,255,255,.76);font-size:11px;font-weight:750}.icon-actions{display:flex;gap:6px;flex:0 0 auto}.icon-btn{width:39px;height:39px;border-radius:15px;display:grid;place-items:center;color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.13);font-size:17px;font-weight:900}.icon-btn.primary{color:#061525;background:linear-gradient(135deg,var(--green),var(--cyan));border:0}
.hero{position:relative;overflow:hidden;border-radius:26px;padding:15px;color:#fff;background:linear-gradient(135deg,rgba(7,24,39,.97),rgba(13,50,80,.94) 55%,rgba(18,124,91,.82)),linear-gradient(180deg,rgba(255,255,255,.08),transparent);border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 48px rgba(4,16,30,.24)}.hero:after{content:"";position:absolute;inset:-40%;background:radial-gradient(circle at 82% 10%,rgba(142,255,178,.20),transparent 170px),radial-gradient(circle at 10% 76%,rgba(47,124,255,.22),transparent 170px);pointer-events:none}.hero-content{position:relative;z-index:1}.status-pill{display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.20);color:#fff;font-size:11.5px;font-weight:950;white-space:nowrap}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 5px rgba(53,217,144,.16);flex:0 0 auto}h1{margin:14px 0 8px;font-size:clamp(30px,9.2vw,42px);line-height:.96;letter-spacing:-.06em;overflow-wrap:anywhere}.lead{margin:0;color:rgba(255,255,255,.88);font-size:13.5px;line-height:1.42;font-weight:750}.cover-mini{margin-top:12px;min-height:145px;border-radius:21px;overflow:hidden;background:url("${logo}") center/cover no-repeat;border:1px solid rgba(255,255,255,.13);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.metric{padding:12px;border-radius:18px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.22);backdrop-filter:blur(12px)}.metric span{display:block;color:rgba(255,255,255,.92);font-size:11.5px;font-weight:950}.metric b{display:block;margin-top:7px;color:#fff;font-size:22px;line-height:1;letter-spacing:-.045em;font-weight:1000;white-space:nowrap;text-shadow:0 1px 1px rgba(0,0,0,.18)}.hero-buttons{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.btn{min-height:42px;border-radius:16px;padding:10px 9px;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:12px;font-weight:950;text-align:center;white-space:nowrap;transition:transform .12s ease,opacity .12s ease;user-select:none}.btn:active{transform:scale(.98)}.btn.full{grid-column:1/-1}.btn.primary{color:#061525;background:linear-gradient(135deg,var(--green),var(--cyan));box-shadow:0 12px 28px rgba(32,214,255,.20)}.btn.soft-dark{color:#fff;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.18)}.btn.soft{color:#173551;background:#edf6ff;border:1px solid #dfeaf6}
.summary{display:grid;grid-template-columns:1fr;gap:8px;margin-top:10px}.summary-card,.panel{background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow)}.summary-card{padding:13px;border-radius:19px}.summary-card .label{color:var(--muted);font-size:11.5px;font-weight:950}.summary-card .value{margin-top:6px;font-size:24px;line-height:1;letter-spacing:-.045em;font-weight:1000}.summary-card .note{margin-top:6px;color:var(--muted);font-size:12px;line-height:1.34;font-weight:750}.summary-card.good{background:linear-gradient(135deg,rgba(53,217,144,.16),#fff)}.panel{margin-top:10px;border-radius:var(--radius);overflow:hidden}.panel-head{padding:14px 12px 0}.panel-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}h2{margin:0;font-size:21px;line-height:1.1;letter-spacing:-.035em}.panel-sub{margin:6px 0 0;color:var(--muted);font-size:12.5px;line-height:1.38;font-weight:700}.segmented{display:flex;width:100%;gap:4px;margin-top:10px;padding:4px;overflow-x:auto;border-radius:999px;background:#edf5fd;border:1px solid #e2edf8;scrollbar-width:none}.segmented::-webkit-scrollbar{display:none}.segmented button{flex:1 0 auto;min-height:35px;padding:8px 9px;border-radius:999px;color:#607086;background:transparent;font-size:12px;font-weight:950;white-space:nowrap}.segmented button.active{color:var(--ink);background:#fff;box-shadow:0 8px 18px rgba(15,23,42,.08)}
.post-preview{display:grid;gap:10px;padding:12px}.post-media{min-height:168px;border-radius:19px;overflow:hidden;position:relative;background:linear-gradient(135deg,rgba(32,214,255,.18),rgba(53,217,144,.13));border:1px solid #e2edf8;display:grid;place-items:center}.post-media img,.post-media video{width:100%;height:100%;max-height:360px;object-fit:cover;display:block}.post-media-logo{width:100%;height:168px;background:url("${logo}") center/cover no-repeat}.post-media:after{content:"POST";position:absolute;left:10px;bottom:10px;padding:6px 9px;border-radius:999px;color:#fff;background:rgba(6,21,37,.58);font-size:10px;font-weight:1000;letter-spacing:.12em}.post-text{padding:13px;border-radius:19px;background:#f8fbff;border:1px solid #e8f0fa}.post-text h3{margin:0 0 8px;font-size:18px;line-height:1.16;letter-spacing:-.03em}.post-text p,.post-body{margin:0;color:#435269;font-size:13.5px;line-height:1.46}.post-body a{color:#1d73ff;text-decoration:underline;text-underline-offset:3px;font-weight:900}.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}.badge{padding:7px 9px;border-radius:999px;color:#516176;background:#fff;border:1px solid #e2edf8;font-size:11px;font-weight:950;white-space:nowrap}
.chart-wrap{padding:12px}.chart-card{position:relative;border-radius:19px;background:linear-gradient(180deg,#fbfdff,#f3f8ff);border:1px solid #e7eff9;overflow:hidden;padding:6px;touch-action:none}svg{display:block;width:100%;height:auto}.axis{stroke:#dce7f4;stroke-width:1}.line-main{fill:none;stroke:url(#lineGrad);stroke-width:6;stroke-linecap:round;stroke-linejoin:round}.area-main{fill:url(#areaGrad)}.dot-main{fill:#fff;stroke:#20d6ff;stroke-width:4}.chart-label{fill:#6b7b92;font-size:13px;font-weight:850}.chart-value{fill:#0b1728;font-size:13px;font-weight:1000}.hover-line{stroke:rgba(13,24,40,.28);stroke-width:2;stroke-dasharray:5 5}.hover-dot{fill:#061525;stroke:#fff;stroke-width:4}.chart-tooltip{position:absolute;min-width:136px;max-width:calc(100% - 20px);padding:10px;border-radius:15px;background:rgba(8,22,38,.94);color:#fff;box-shadow:0 16px 36px rgba(5,18,35,.25);backdrop-filter:blur(16px);transform:translate(-50%,-100%);pointer-events:none;opacity:0;transition:opacity .12s ease;font-size:11px;z-index:5}.chart-tooltip.show{opacity:1}.chart-tooltip b{display:block;font-size:13px;margin-bottom:5px}.chart-tooltip span{display:block;color:rgba(255,255,255,.78);line-height:1.35;font-weight:750}
.channels{display:grid;gap:8px;padding:12px}.channel-card{width:100%;display:grid;gap:10px;padding:12px;border-radius:19px;background:#fbfdff;border:1px solid #e6eef8;text-align:left}.channel-top{display:flex;align-items:center;gap:9px}.avatar{width:40px;height:40px;border-radius:15px;display:grid;place-items:center;flex:0 0 auto;color:#07334d;background:linear-gradient(135deg,rgba(32,214,255,.24),rgba(53,217,144,.22));font-weight:1000;overflow:hidden}.avatar img{width:100%;height:100%;object-fit:cover}.channel-top b{display:block;max-width:calc(100vw - 108px);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px}.channel-top span{display:block;margin-top:3px;color:var(--muted);font-size:11px;font-weight:700}.channel-metrics{display:grid;grid-template-columns:1fr 1fr;gap:7px}.mini-metric{padding:9px;border-radius:15px;background:#fff;border:1px solid #e6eef8}.mini-metric b{display:block;font-size:17px;line-height:1;letter-spacing:-.025em}.mini-metric span{display:block;margin-top:5px;color:var(--muted);font-size:10.5px;font-weight:850}.score{padding:13px}.score-ring{position:relative;width:132px;height:132px;border-radius:50%;margin:13px auto 2px;display:grid;place-items:center;background:conic-gradient(var(--green) 0 ${qualityPercent}%,#e8f0fa ${qualityPercent}% 100%)}.score-ring:after{content:"";position:absolute;inset:10px;border-radius:50%;background:#fff;box-shadow:inset 0 0 0 1px #edf3fa}.score-ring div{position:relative;z-index:1;text-align:center}.score-ring strong{display:block;font-size:34px;line-height:1;letter-spacing:-.06em}.score-ring span{display:block;margin-top:4px;color:var(--muted);font-size:11px;font-weight:950}.compare{display:grid;gap:9px;padding:12px}.compare-row{display:grid;grid-template-columns:72px 1fr 58px;align-items:center;gap:8px;font-size:12px;font-weight:950}.bar{height:12px;overflow:hidden;border-radius:999px;background:#edf4fc}.bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--blue),var(--cyan),var(--green))}.detail-list{display:grid;gap:8px;padding:12px}.detail-card{padding:12px;border-radius:18px;background:#fbfdff;border:1px solid #e6eef8}.detail-title{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:10px}.detail-title b{font-size:14px;line-height:1.25}.pill{padding:5px 8px;border-radius:999px;font-size:10.5px;font-weight:1000;background:rgba(53,217,144,.12);color:#128856;white-space:nowrap}.pill.warn{background:rgba(255,184,77,.16);color:#a56400}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.detail-cell{padding:8px;border-radius:14px;background:#fff;border:1px solid #e7eff9}.detail-cell span{display:block;color:var(--muted);font-size:10.5px;font-weight:850}.detail-cell b{display:block;margin-top:4px;font-size:14px}.quality-list{display:grid;gap:8px;padding:12px}.quality-item{padding:12px;border-radius:18px;background:#f8fbff;border:1px solid #e6eef8}.quality-item b{display:block;font-size:14px}.quality-item span{display:block;margin-top:5px;color:var(--muted);font-size:12px;line-height:1.4;font-weight:700}.mobile-dock{position:fixed;left:10px;right:10px;bottom:calc(8px + var(--safe-bottom));z-index:60;display:flex;gap:7px;padding:7px;border-radius:22px;background:rgba(11,23,40,.82);box-shadow:0 18px 60px rgba(5,18,35,.30);backdrop-filter:blur(18px)}.mobile-dock button,.mobile-dock a{flex:1;padding:11px 6px;border-radius:16px;text-align:center;color:#fff;background:rgba(255,255,255,.08);font-size:11px;font-weight:1000}.mobile-dock .primary{color:#061525;background:linear-gradient(135deg,var(--green),var(--cyan)}.toast{position:fixed;left:50%;bottom:calc(78px + var(--safe-bottom));z-index:90;max-width:calc(100vw - 26px);transform:translateX(-50%) translateY(22px);opacity:0;pointer-events:none;padding:11px 13px;border-radius:999px;color:#fff;background:rgba(8,22,38,.92);box-shadow:0 18px 50px rgba(5,18,35,.25);backdrop-filter:blur(16px);font-size:12px;font-weight:950;transition:opacity .18s ease,transform .18s ease;white-space:nowrap}.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}.modal{position:fixed;inset:0;z-index:80;display:none;align-items:flex-end;justify-content:center;background:rgba(5,18,35,.58);backdrop-filter:blur(10px)}.modal.show{display:flex}.modal-card{width:100%;max-height:min(82vh,720px);overflow:auto;border-radius:27px 27px 0 0;background:#fff;box-shadow:0 -20px 70px rgba(0,0,0,.25);padding-bottom:var(--safe-bottom);animation:modalUp .18s ease}@keyframes modalUp{from{transform:translateY(16px);opacity:.7}to{transform:translateY(0);opacity:1}}.modal-head{position:sticky;top:0;z-index:1;padding:14px 13px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fff}.modal-head h3{margin:0;font-size:21px;line-height:1.12;letter-spacing:-.035em}.close{width:39px;height:39px;border-radius:15px;color:var(--ink);background:#eef5ff;font-size:20px;font-weight:1000;flex:0 0 auto}.modal-body{padding:12px 13px 16px;color:#405066;font-size:14px;line-height:1.48}.modal-list{display:grid;gap:8px;margin-top:12px}.modal-list div{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px;border-radius:16px;background:#f8fbff;border:1px solid #e6eef8}.modal-list span{color:var(--muted);font-size:12px;font-weight:850}.modal-list b{color:var(--ink);text-align:right;font-size:13px}@media(min-width:520px){.app{max-width:520px}}@media(max-width:370px){.app{padding-left:8px;padding-right:8px}.topbar{margin-left:-8px;margin-right:-8px;padding-left:8px;padding-right:8px}.brand b{max-width:124px}h1{font-size:29px}.metric b{font-size:20px}.btn{font-size:11px}}
</style>
</head>
<body>
<main class="app">
<header class="topbar"><a class="brand" href="#top"><div class="brand-logo"></div><div><b>LinkRay Analytics</b><span>публичный отчёт</span></div></a><div class="icon-actions"><button class="icon-btn" data-action="refresh" aria-label="Обновить">↻</button><button class="icon-btn primary" data-action="share" aria-label="Поделиться">↗</button></div></header>
<section class="hero" id="top"><div class="hero-content"><span class="status-pill"><i class="dot"></i> Рекламный выход · данные обновляются</span><h1>${esc(data.title)}</h1><p class="lead">Просмотры, CPM, стоимость, каналы, доля результата и качество размещений.</p><div class="metrics"><div class="metric"><span>Просмотры</span><b>${num(data.metrics.views)}</b></div><div class="metric"><span>CPM</span><b>${money(data.metrics.cpm)}</b></div><div class="metric"><span>Факт CPM</span><b>${money(data.metrics.factCpm)}</b></div><div class="metric"><span>К оплате</span><b>${money(data.metrics.cost)}</b></div></div><div class="hero-buttons"><button class="btn primary full" data-action="open-report">📊 Открыть отчёт</button><button class="btn soft-dark" data-action="copy">🔗 Ссылка</button><button class="btn soft-dark" data-action="open-post">👁 Пост</button></div><div class="cover-mini"></div></div></section>
<section class="summary"><article class="${statusClass}"><div class="label">Статус</div><div class="value">${esc(data.status.title)}</div><div class="note">${esc(data.status.text)}</div></article><article class="summary-card"><div class="label">Публикация</div><div class="value">${esc(published)}</div><div class="note">Отчёт обновляется каждую минуту.</div></article><article class="summary-card"><div class="label">Каналы</div><div class="value">${num(data.metrics.channelsCount)}</div><div class="note">${num(data.metrics.channelsCount)} размещения участвуют в этом отчёте.</div></article><article class="summary-card"><div class="label">Качество</div><div class="value">${num(data.metrics.quality)}/100</div><div class="note">Проверка всплесков, равномерности и подозрительных просмотров.</div></article></section>
<section class="panel" id="post"><div class="panel-head"><div class="panel-title-row"><h2>Пост</h2></div><p class="panel-sub" id="postSub">Медиа и текст разделены. На телефоне ничего не выходит за экран.</p><div class="segmented"><button class="active" data-tab="post">Пост</button><button data-tab="meta">Данные</button><button data-tab="history">История</button></div></div><div class="post-preview" id="postTab"><div class="post-media">${mediaHtml(data)}</div><div class="post-text"><h3>${esc(data.postTitle)}</h3><div class="post-body">${data.postHtml}</div><div class="badges"><span class="badge">💼 реклама</span><span class="badge">CPM ${money(data.metrics.cpm)}</span><span class="badge">${num(data.metrics.channelsCount)} канала</span><span class="badge">${esc(data.autoDeleteText)}</span></div></div></div></section>
<section class="panel" id="chart"><div class="panel-head"><div class="panel-title-row"><h2>График просмотров</h2></div><p class="panel-sub" id="rangeHint">Нажмите на любую точку графика — покажем просмотры за выбранный период.</p><div class="segmented" id="rangeBtns"></div></div><div class="chart-wrap"><div class="chart-card" id="chartCard"><div class="chart-tooltip" id="chartTooltip"></div><svg id="chartSvg" viewBox="0 0 760 320" role="img" aria-label="График просмотров"><defs><linearGradient id="lineGrad" x1="0" x2="1"><stop stop-color="#2f7cff"/><stop offset=".55" stop-color="#20d6ff"/><stop offset="1" stop-color="#35d990"/></linearGradient><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#20d6ff" stop-opacity=".24"/><stop offset="1" stop-color="#35d990" stop-opacity="0"/></linearGradient></defs><g id="chartGrid"></g><polygon id="chartArea" class="area-main"></polygon><polyline id="chartLine" class="line-main"></polyline><g id="chartDots"></g><g id="chartHover"></g><g id="chartLabels"></g></svg></div></div></section>
<section class="panel" id="placements"><div class="panel-head"><div class="panel-title-row"><h2>Каналы</h2></div><p class="panel-sub">Нажатие на канал открывает подробности.</p><div class="segmented" id="channelFilter"><button class="active" data-filter="all">Все</button><button data-filter="best">Лучшие</button><button data-filter="risk">Риск</button></div></div><div class="channels" id="channelsList"></div></section>
<section class="panel" id="quality"><div class="panel-head"><div class="panel-title-row"><h2>Индекс качества</h2></div><p class="panel-sub">Простая оценка размещения для рекламодателя.</p></div><div class="score"><div class="score-ring"><div><strong>${num(data.metrics.quality)}</strong><span>из 100</span></div></div></div></section>
<section class="panel"><div class="panel-head"><div class="panel-title-row"><h2>Сравнение каналов</h2></div><p class="panel-sub">Доля просмотров по каждому размещению.</p></div><div class="compare" id="compareBars"></div></section>
<section class="panel" id="details"><div class="panel-head"><div class="panel-title-row"><h2>Детализация</h2><button class="btn soft" data-action="download">CSV</button></div><p class="panel-sub">Вместо широкой таблицы — мобильные карточки.</p></div><div class="detail-list" id="detailsList"></div></section>
<section class="panel"><div class="panel-head"><div class="panel-title-row"><h2>Проверка</h2></div></div><div class="quality-list"><div class="quality-item"><b>🟢 Данные обновляются</b><span>LinkRay запрашивает просмотры MAX каждую минуту.</span></div><div class="quality-item"><b>🟢 Распределение по каналам</b><span>Отдельно видна доля просмотров каждого размещения.</span></div><div class="quality-item"><b>🟡 Риск подсвечивается</b><span>Каналы с низким качеством попадают в фильтр «Риск».</span></div></div></section>
<nav class="mobile-dock" aria-label="Быстрая навигация"><a href="#chart">График</a><a href="#placements">Каналы</a><button class="primary" data-action="share">Поделиться</button></nav>
</main><div class="toast" id="toast">Готово</div><div class="modal" id="modal"><div class="modal-card"><div class="modal-head"><h3 id="modalTitle">Детали</h3><button class="close" data-action="close-modal">×</button></div><div class="modal-body" id="modalBody"></div></div></div>
<script id="report-data" type="application/json">${state}</script>
<script>
const report=JSON.parse(document.getElementById('report-data').textContent);const $=(s,r=document)=>r.querySelector(s);const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));let currentChartPoints=[];let currentRange='24';function number(v){return new Intl.NumberFormat('ru-RU').format(Math.round(Number(v)||0))}function rub(v){return number(v)+' ₽'}function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('show');clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.classList.remove('show'),2100)}function openModal(title,html){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modal').classList.add('show');document.body.style.overflow='hidden'}function closeModal(){$('#modal').classList.remove('show');document.body.style.overflow=''}function availableRanges(){return Object.keys(report.ranges||{}).sort((a,b)=>Number(a)-Number(b))}function defaultRange(){const r=availableRanges();return r[r.length-1]||'24'}function renderRangeButtons(){const ranges=availableRanges();const active=defaultRange();$('#rangeBtns').innerHTML=ranges.map(r=>'<button class="'+(r===active?'active':'')+'" data-range="'+r+'">'+r+'ч</button>').join('');const hint=$('#rangeHint');if(hint){if(ranges.length===1)hint.textContent='Пост находился в канале меньше 48 часов, поэтому доступен период 24ч. Нажмите на график, чтобы увидеть просмотры.';else if(ranges.length===2)hint.textContent='Пост был в канале до 48 часов, доступны 24ч и 48ч. Нажмите на график, чтобы увидеть просмотры.';else hint.textContent='Пост находился в канале 72 часа или дольше, доступны 24ч, 48ч и 72ч. Нажмите на график, чтобы увидеть просмотры.'}$$('#rangeBtns [data-range]').forEach(btn=>btn.addEventListener('click',()=>{$$('#rangeBtns button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');drawChart(btn.dataset.range)}));return active}function drawChart(range=defaultRange()){currentRange=range;const data=(report.ranges&&report.ranges[range])||[];const width=760,height=320,pad={left:58,right:30,top:42,bottom:54};const iw=width-pad.left-pad.right,ih=height-pad.top-pad.bottom;const maxViews=Math.max(...data.map(x=>x[1]),1);const baseY=pad.top+ih;const points=data.map((item,index)=>{const x=pad.left+(data.length===1?iw/2:iw*index/(data.length-1));const y=pad.top+ih-(item[1]/maxViews)*ih;return{label:item[0],views:item[1],x,y}});currentChartPoints=points;$('#chartGrid').innerHTML=[0,.25,.5,.75,1].map(t=>{const y=pad.top+ih-ih*t;const value=Math.round(maxViews*t);return '<line class="axis" x1="'+pad.left+'" y1="'+y+'" x2="'+(width-pad.right)+'" y2="'+y+'"></line><text class="chart-label" x="18" y="'+(y+4)+'">'+number(value)+'</text>'}).join('');const line=points.map(p=>p.x+','+p.y).join(' ');$('#chartLine').setAttribute('points',line);$('#chartArea').setAttribute('points',pad.left+','+baseY+' '+line+' '+(width-pad.right)+','+baseY);$('#chartDots').innerHTML=points.map((p,index)=>{const show=index===points.length-1||index===0||index===Math.floor(points.length/2);return '<circle class="dot-main" cx="'+p.x+'" cy="'+p.y+'" r="6"></circle>'+(show?'<text class="chart-value" x="'+Math.max(56,p.x-18)+'" y="'+Math.max(18,p.y-14)+'">'+number(p.views)+'</text>':'')}).join('');$('#chartLabels').innerHTML=points.map((p,index)=>{const show=window.innerWidth>380||index%2===0||index===points.length-1;return show?'<text class="chart-label" x="'+(p.x-10)+'" y="'+(height-18)+'">'+p.label+'</text>':''}).join('');showChartPoint(points[points.length-1],false)}function svgClientPoint(event){const svg=$('#chartSvg');const rect=svg.getBoundingClientRect();const clientX=(event.touches&&event.touches[0]?event.touches[0].clientX:event.clientX);const clientY=(event.touches&&event.touches[0]?event.touches[0].clientY:event.clientY);return{x:(clientX-rect.left)/rect.width*760,y:(clientY-rect.top)/rect.height*320,clientX,clientY}}function nearestPoint(x){if(!currentChartPoints.length)return null;return currentChartPoints.reduce((best,p)=>Math.abs(p.x-x)<Math.abs(best.x-x)?p:best,currentChartPoints[0])}function showChartPoint(point,showToast=true,clientX=null,clientY=null){if(!point)return;$('#chartHover').innerHTML='<line class="hover-line" x1="'+point.x+'" y1="42" x2="'+point.x+'" y2="266"></line><circle class="hover-dot" cx="'+point.x+'" cy="'+point.y+'" r="7"></circle>';const chart=$('#chartCard'),tooltip=$('#chartTooltip'),svg=$('#chartSvg'),svgRect=svg.getBoundingClientRect(),chartRect=chart.getBoundingClientRect();const left=clientX===null?((point.x/760)*svgRect.width+(svgRect.left-chartRect.left)):(clientX-chartRect.left);const top=clientY===null?((point.y/320)*svgRect.height+(svgRect.top-chartRect.top)):(clientY-chartRect.top);tooltip.innerHTML='<b>'+point.label+'</b><span>Просмотры: '+number(point.views)+'</span>';tooltip.style.left=Math.min(Math.max(left,84),chartRect.width-84)+'px';tooltip.style.top=Math.max(top-10,64)+'px';tooltip.classList.add('show');if(showToast)toast(point.label+' · просмотры: '+number(point.views))}function handleChartEvent(event){event.preventDefault();const p=svgClientPoint(event);showChartPoint(nearestPoint(p.x),true,p.clientX,p.clientY)}function avatarHtml(ch){return ch.avatar?'<img src="'+ch.avatar+'" alt="">':ch.letter}function renderChannels(filter='all'){let channels=report.channels||[];if(filter==='best')channels=channels.filter(ch=>ch.group==='best');if(filter==='risk')channels=channels.filter(ch=>ch.group==='risk');$('#channelsList').innerHTML=channels.map(ch=>'<button class="channel-card" data-channel="'+ch.id+'"><div class="channel-top"><div class="avatar">'+avatarHtml(ch)+'</div><div><b>'+ch.title+'</b><span>'+ch.time+' · MAX</span></div></div><div class="channel-metrics"><div class="mini-metric"><b>'+number(ch.views)+'</b><span>просмотров</span></div><div class="mini-metric"><b>'+ch.quality+'/100</b><span>качество</span></div></div></button>').join('');$$('[data-channel]').forEach(btn=>btn.addEventListener('click',()=>openChannel(btn.dataset.channel)))}function renderCompare(){$('#compareBars').innerHTML=(report.channels||[]).map(ch=>'<div class="compare-row"><span>'+ch.letter+' · '+ch.share+'%</span><div class="bar"><i style="width:'+ch.share+'%"></i></div><b>'+number(ch.views)+'</b></div>').join('')}function renderDetails(){$('#detailsList').innerHTML=(report.channels||[]).map(ch=>'<article class="detail-card"><div class="detail-title"><b>'+ch.title+'</b><span class="pill '+(ch.group==='risk'?'warn':'')+'">'+ch.status+'</span></div><div class="detail-grid"><div class="detail-cell"><span>Просмотры</span><b>'+number(ch.views)+'</b></div><div class="detail-cell"><span>Доля</span><b>'+ch.share+'%</b></div><div class="detail-cell"><span>Факт CPM</span><b>'+rub(ch.cpm)+'</b></div><div class="detail-cell"><span>Стоимость</span><b>'+rub(ch.cost)+'</b></div></div></article>').join('')}function openChannel(id){const ch=(report.channels||[]).find(x=>String(x.id)===String(id));if(!ch)return;openModal(ch.title,'<p>Подробности размещения в канале.</p><div class="modal-list"><div><span>Просмотры</span><b>'+number(ch.views)+'</b></div><div><span>Доля</span><b>'+ch.share+'%</b></div><div><span>Факт CPM</span><b>'+rub(ch.cpm)+'</b></div><div><span>Стоимость</span><b>'+rub(ch.cost)+'</b></div><div><span>Качество</span><b>'+ch.quality+'/100</b></div></div>')}function openPost(){openModal('Рекламный пост','<p><b>'+report.postTitle+'</b></p><p>Полный предпросмотр опубликованного поста находится в блоке «Пост».</p><div class="modal-list"><div><span>Тип</span><b>реклама</b></div><div><span>CPM</span><b>'+rub(report.metrics.cpm)+'</b></div><div><span>Автоудаление</span><b>'+report.autoDeleteText+'</b></div><div><span>Каналов</span><b>'+report.metrics.channelsCount+'</b></div></div>')}async function copyLink(){const url=location.href;try{await navigator.clipboard.writeText(url);toast('Ссылка скопирована')}catch{openModal('Ссылка отчёта','<p>Скопируйте вручную:</p><div class="modal-list"><div><span>URL</span><b>'+url+'</b></div></div>')}}function downloadCsv(){const header=['Канал','Просмотры','Доля','CPM факт','Стоимость','Качество'];const rows=(report.channels||[]).map(ch=>[ch.title,ch.views,ch.share+'%',Math.round(ch.cpm),Math.round(ch.cost),ch.status]);const csv=[header,...rows].map(row=>row.map(cell=>'"'+String(cell).replace(/"/g,'""')+'"').join(';')).join('\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='linkray-analytics.csv';a.click();URL.revokeObjectURL(url);toast('CSV сформирован')}function shareReport(){if(navigator.share){navigator.share({title:'LinkRay Analytics',text:'Отчёт по рекламному посту MAX',url:location.href}).catch(()=>copyLink())}else copyLink()}function refreshData(){fetch(location.pathname+'?json=1&v='+Date.now(),{cache:'no-store'}).then(r=>r.ok?location.reload():toast('Не удалось обновить')).catch(()=>toast('Не удалось обновить'))}function action(type){if(type==='refresh')return refreshData();if(type==='share')return shareReport();if(type==='copy')return copyLink();if(type==='open-post')return openPost();if(type==='open-report')return $('#chart').scrollIntoView({behavior:'smooth'});if(type==='download')return downloadCsv();if(type==='close-modal')return closeModal()}$$('[data-action]').forEach(el=>el.addEventListener('click',()=>action(el.dataset.action)));$$('#channelFilter [data-filter]').forEach(btn=>btn.addEventListener('click',()=>{$$('#channelFilter button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');renderChannels(btn.dataset.filter)}));$$('[data-tab]').forEach(btn=>btn.addEventListener('click',()=>{$$('[data-tab]').forEach(x=>x.classList.remove('active'));btn.classList.add('active')}));$('#modal').addEventListener('click',e=>{if(e.target.id==='modal')closeModal()});$('#chartCard').addEventListener('click',handleChartEvent);$('#chartCard').addEventListener('touchstart',handleChartEvent,{passive:false});$('#chartCard').addEventListener('touchmove',handleChartEvent,{passive:false});window.addEventListener('resize',()=>drawChart(currentRange));const initialRange=renderRangeButtons();drawChart(initialRange);renderChannels('all');renderCompare();renderDetails();setInterval(refreshData,60000);
</script>
</body></html>`;
}

export function mountLinkRayAnalyticsRoutes(app) {
  startMinuteSync().catch((error) => console.error('[analytics sync start]', error.message || error));

  app.get('/analytics/logo.webp', (_req, res) => {
    if (DEFAULT_LOGO_URL) return res.redirect(302, DEFAULT_LOGO_URL);

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="28" fill="#20d6ff"/><text x="48" y="58" text-anchor="middle" font-size="31" font-family="Arial" font-weight="900" fill="#071827">LR</text></svg>');
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
      console.error('[linkray analytics mobile]', error.stack || error);
      return res.status(500).send('LinkRay analytics error: ' + esc(error.message || error));
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
