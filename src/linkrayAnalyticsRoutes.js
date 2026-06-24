import crypto from 'node:crypto';
import { query } from './db.js';
import { getMaxMessage } from './maxClient.js';

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.SITE_URL || process.env.WEBAPP_URL || 'https://linkray.ru').replace(/\/$/, '');
const BOT_LINK = 'https://max.ru/se13353901_bot';

const rows = (r) => Array.isArray(r) ? r : (r?.rows || []);
const sha = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex');

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
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
    .replace(/<a\b[^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')
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

function shortText(v, n = 120) {
  const s = stripHtml(v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : (s || 'Рекламный пост');
}

function linkifyPlain(text) {
  return esc(text || '').replace(/(https?:\/\/[^\s<>"']+)/gi, (url) => {
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>';
  }).replace(/\n/g, '<br>');
}

function sanitizeHtml(html) {
  let out = String(html || '');

  out = out
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '');

  out = out.replace(/<(?!\/?(a|b|strong|i|em|u|s|del|ins|br|p|div|span|blockquote|code|pre)\b)[^>]*>/gi, '');

  out = out.replace(/<a\b([^>]*)>/gi, (m, attrs) => {
    const href = String(attrs || '').match(/href=["']([^"']+)["']/i)?.[1] || '';
    if (!/^https?:\/\//i.test(href) && !/^max:\/\//i.test(href)) return '<span>';
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">';
  });

  return out.trim() ? out.replace(/\n/g, '<br>') : '';
}

function postHtml(post, draft, snap) {
  const text = post.text || draft?.content?.text || snap.title || '';
  const format = String(post.format || draft?.content?.format || '').toLowerCase();

  if (format === 'html' || /<\/?[a-z][\s\S]*>/i.test(String(text))) {
    return sanitizeHtml(text);
  }

  return linkifyPlain(text);
}

function autoDeleteText(minutes) {
  const n = Number(minutes || 0);
  if (!Number.isFinite(n) || n <= 0) return 'без удаления';
  if (n % 1440 === 0) return String(n / 1440) + 'д';
  if (n % 60 === 0) return String(n / 60) + 'ч';
  return String(n) + ' мин';
}

function flattenButtons(v) {
  const data = safeJson(v, []);
  const out = [];

  const scanButton = (b) => {
    const title = String(b?.text || b?.title || b?.label || '').trim();
    const url = String(b?.url || b?.link || '').trim();
    if (title) out.push({ title, url });
  };

  if (Array.isArray(data)) {
    for (const row of data) {
      if (Array.isArray(row)) {
        for (const b of row) scanButton(b);
      } else {
        scanButton(row);
      }
    }
  }

  return out;
}

function mediaInfo(v) {
  const data = safeJson(v, []);
  let count = 0;
  let token = '';
  let url = '';
  let type = '';

  const isUrl = (x) => /^https?:\/\//i.test(String(x || ''));

  const scan = (item) => {
    if (!item) return;

    if (typeof item === 'string') {
      if (isUrl(item) && !url) url = item;
      return;
    }

    if (Array.isArray(item)) {
      count += item.length;
      for (const x of item) scan(x);
      return;
    }

    if (typeof item === 'object') {
      count += 1;
      type = type || String(item.type || item.kind || '');

      if (item.payload?.token && !token) token = String(item.payload.token);
      if (item.token && !token) token = String(item.token);

      const keys = [
        'url', 'src', 'link', 'href',
        'downloadUrl', 'download_url',
        'previewUrl', 'preview_url',
        'thumbnailUrl', 'thumbnail_url',
        'fileUrl', 'file_url',
        'imageUrl', 'image_url',
        'videoUrl', 'video_url',
      ];

      for (const key of keys) {
        if (isUrl(item[key]) && !url) url = String(item[key]);
      }

      for (const x of Object.values(item)) scan(x);
    }
  };

  scan(data);

  let kind = 'image';
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url) || /video/i.test(type)) kind = 'video';

  return { count: url ? count : 0, token: url ? token : '', url, type, kind };
}

function reportStatus(posts) {
  if (!posts.length) return 'scheduled';

  const statuses = posts.map((p) => String(p.status || '').toLowerCase());

  if (statuses.some((s) => ['deleted', 'canceled', 'cancelled'].includes(s))) return 'deleted';
  if (posts.some((p) => p.auto_deleted_at)) return 'deleted';

  const published = posts.find((p) => p.published_at);

  if (published) {
    const publishedAt = new Date(published.published_at).getTime();
    const autoMin = Number(published.auto_delete_minutes || 0);
    const reportHours = Number(published.report_after_hours || 24);

    if (autoMin > 0 && Date.now() >= publishedAt + autoMin * 60000) return 'ended';
    if (reportHours > 0 && Date.now() >= publishedAt + reportHours * 3600000) return 'ended';

    return 'published';
  }

  return statuses.includes('published') ? 'published' : 'scheduled';
}


function lrDateRu(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) + ' МСК';
  } catch {
    return String(value || '');
  }
}

function lrStatusInfo(posts) {
  const first = posts?.[0] || {};
  const status = reportStatus(posts);

  if (status === 'scheduled') {
    return {
      key: 'scheduled',
      icon: '⏳',
      title: 'Отложен',
      text: first.publish_at
        ? 'Публикация запланирована на ' + lrDateRu(first.publish_at)
        : 'Пост находится в расписании.'
    };
  }

  if (status === 'published') {
    return {
      key: 'published',
      icon: '✅',
      title: 'Опубликован',
      text: [
        first.published_at ? 'Опубликован: ' + lrDateRu(first.published_at) : '',
        'Автоудаление: ' + autoDeleteText(first.auto_delete_minutes),
        Number(first.report_after_hours || 24) ? 'Отчёт: через ' + Number(first.report_after_hours || 24) + 'ч' : ''
      ].filter(Boolean).join(' · ')
    };
  }

  if (status === 'ended') {
    return {
      key: 'ended',
      icon: '🏁',
      title: 'Реклама закончилась',
      text: 'Период рекламного отчёта завершён. Данные остаются доступными рекламодателю.'
    };
  }

  if (status === 'deleted') {
    return {
      key: 'deleted',
      icon: '🗑️',
      title: 'Удалён',
      text: first.auto_deleted_at
        ? 'Пост удалён: ' + lrDateRu(first.auto_deleted_at)
        : 'Пост удалён или отменён.'
    };
  }

  return {
    key: status || 'unknown',
    icon: '📌',
    title: 'Статус',
    text: 'Актуальный статус обновляется автоматически.'
  };
}

async function lrBuildViewChart(campaignId, postId, views) {
  await query(`CREATE TABLE IF NOT EXISTS analytics_view_points (
    id bigserial PRIMARY KEY,
    campaign_id text NOT NULL,
    post_id integer,
    views integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});

  await query(`CREATE INDEX IF NOT EXISTS idx_lr_view_points_campaign
               ON analytics_view_points(campaign_id, created_at)`).catch(() => {});

  const campaign = String(campaignId || postId || 'unknown');
  const v = Math.max(0, Math.round(Number(views || 0)));

  const last = rows(await query(
    `SELECT views FROM analytics_view_points
     WHERE campaign_id=$1
     ORDER BY created_at DESC
     LIMIT 1`,
    [campaign]
  ).catch(() => []))[0];

  if (!last || Number(last.views) !== v) {
    await query(
      `INSERT INTO analytics_view_points(campaign_id, post_id, views)
       VALUES($1,$2,$3)`,
      [campaign, Number(postId || 0) || null, v]
    ).catch(() => {});
  }

  const points = rows(await query(
    `SELECT views, created_at
     FROM analytics_view_points
     WHERE campaign_id=$1
     ORDER BY created_at ASC
     LIMIT 80`,
    [campaign]
  ).catch(() => []));

  const values = points.map((x) => Number(x.views || 0));
  const labels = points.map((x) => {
    try {
      return new Date(x.created_at).toLocaleTimeString('ru-RU', {
        timeZone: 'Europe/Moscow',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return '';
    }
  });

  return { values, labels };
}

function fingerprint(req, token) {
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '')
    .split(',')[0]
    .trim();

  const ua = String(req.headers['user-agent'] || '');

  return {
    fingerprint: sha(token + '|' + ip + '|' + ua).slice(0, 48),
    ipHash: sha(ip).slice(0, 32),
    userAgent: ua.slice(0, 420),
  };
}

function isPreviewRequest(req) {
  const method = String(req.method || '').toUpperCase();
  const ua = String(req.headers['user-agent'] || '').toLowerCase();

  if (method === 'HEAD') return true;

  return /bot|crawler|spider|preview|linkcheck|telegram|whatsapp|vkshare|slurp/.test(ua);
}


function lrExtractMaxViewsFromMessage(result) {
  const msg = Array.isArray(result?.messages) ? result.messages[0] : (result?.message || result);
  const stat = msg?.stat || result?.stat || result?.message?.stat || {};

  const candidates = [
    stat.views,
    stat.view_count,
    stat.views_count,
    stat.viewsCount,
    stat.read_count,
    stat.reads,
    stat.impressions,
    stat.impressions_count,
    stat.impressionsCount,
    stat.reach,
    stat.total,
    stat.count,
  ];

  for (const value of candidates) {
    const n = Number(value);

    if (Number.isFinite(n) && n >= 0) {
      return {
        views: Math.round(n),
        stat,
        url: msg?.url || result?.url || '',
      };
    }
  }

  return {
    views: null,
    stat,
    url: msg?.url || result?.url || '',
  };
}

async function lrRefreshPublishedViewsFromMax(posts) {
  const out = [];

  for (const post of posts || []) {
    const copy = { ...post };

    if (!copy.published_message_id) {
      out.push(copy);
      continue;
    }

    try {
      const maxMessage = await getMaxMessage(copy.published_message_id);
      const info = lrExtractMaxViewsFromMessage(maxMessage);

      if (info.views !== null) {
        const snapshot = safeJson(copy.report_snapshot, {});

        snapshot.views = info.views;
        snapshot.totalViews = info.views;
        snapshot.maxViews = info.views;
        snapshot.maxStat = info.stat || snapshot.maxStat || {};
        snapshot.lastMaxSyncAt = new Date().toISOString();

        if (info.url) snapshot.postUrl = info.url;

        copy.report_snapshot = snapshot;

        await query(
          `UPDATE scheduled_posts
           SET report_snapshot=$2::jsonb, updated_at=COALESCE(updated_at, now())
           WHERE id=$1`,
          [copy.id, JSON.stringify(snapshot)]
        ).catch(() => {});
      }
    } catch (error) {
      console.error('[analytics max views] failed', JSON.stringify({
        postId: copy.id,
        messageId: copy.published_message_id,
        error: String(error?.message || error),
      }));
    }

    out.push(copy);
  }

  return out;
}


async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS analytics_links (
    token text PRIMARY KEY,
    campaign_id text NOT NULL,
    post_id integer,
    channel_id integer,
    label text,
    target_url text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

  await query(`ALTER TABLE analytics_links ADD COLUMN IF NOT EXISTS kind text`);

  await query(`CREATE TABLE IF NOT EXISTS analytics_clicks (
    id bigserial PRIMARY KEY,
    token text NOT NULL REFERENCES analytics_links(token) ON DELETE CASCADE,
    campaign_id text NOT NULL,
    post_id integer,
    channel_id integer,
    fingerprint text NOT NULL,
    ip_hash text,
    user_agent text,
    clicked_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(token, fingerprint)
  )`);

  await query(`CREATE TABLE IF NOT EXISTS analytics_click_events (
    id bigserial PRIMARY KEY,
    token text NOT NULL REFERENCES analytics_links(token) ON DELETE CASCADE,
    campaign_id text NOT NULL,
    post_id integer,
    channel_id integer,
    fingerprint text,
    ip_hash text,
    user_agent text,
    clicked_at timestamptz NOT NULL DEFAULT now()
  )`);

  await query(`CREATE INDEX IF NOT EXISTS idx_lr_analytics_links_campaign ON analytics_links(campaign_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_lr_analytics_clicks_campaign ON analytics_clicks(campaign_id, clicked_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_lr_analytics_events_campaign ON analytics_click_events(campaign_id, clicked_at)`);
  await query(`DELETE FROM analytics_clicks a
               USING analytics_clicks b
               WHERE a.id > b.id
                 AND a.token = b.token
                 AND a.fingerprint = b.fingerprint`).catch(() => {});
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_lr_clicks_token_fingerprint
               ON analytics_clicks(token, fingerprint)`).catch(() => {});
  await query(`UPDATE analytics_links SET kind='button'
               WHERE kind IS NULL AND COALESCE(label, '') <> ''`).catch(() => {});

  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_group_id text`).catch(() => {});
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_snapshot jsonb`).catch(() => {});
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS auto_deleted_at timestamptz`).catch(() => {});
}

async function collect(groupId) {
  await ensureSchema();

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

  if (posts.length) {
    posts = await lrRefreshPublishedViewsFromMax(posts);
  }

  const campaignIds = new Set([id]);

  for (const p of posts) {
    campaignIds.add(String(p.id));
    if (p.report_group_id) campaignIds.add(String(p.report_group_id));

    const d = safeJson(p.draft, {});
    if (d.campaignId) campaignIds.add(String(d.campaignId));
  }

  const ids = Array.from(campaignIds);

  const links = rows(await query(
    `SELECT l.token, l.campaign_id, l.post_id, l.channel_id, l.label, l.target_url, l.kind,
            COUNT(DISTINCT c.fingerprint)::int AS unique_clicks,
            COUNT(e.id)::int AS total_clicks
     FROM analytics_links l
     LEFT JOIN analytics_clicks c ON c.token = l.token
     LEFT JOIN analytics_click_events e ON e.token = l.token
     WHERE (l.campaign_id = ANY($1::text[]) OR l.post_id = ANY($2::int[]))
       AND l.kind = 'button'
     GROUP BY l.token
     ORDER BY l.created_at ASC`,
    [ids, posts.map((p) => Number(p.id || 0)).filter(Boolean)]
  ));

  if (!posts.length && links.length) {
    const postIds = links.map((l) => Number(l.post_id || 0)).filter(Boolean);

    if (postIds.length) {
      posts = rows(await query(
        `SELECT sp.*, c.title AS channel_title, c.link AS channel_link
         FROM scheduled_posts sp
         LEFT JOIN channels c ON c.id = sp.channel_id
         WHERE sp.id = ANY($1::int[])
         ORDER BY sp.id ASC`,
        [postIds]
      ));
    }
  }

  const first = posts[0] || {};
  const draft = safeJson(first.draft, {});
  const snap = safeJson(first.report_snapshot, {});
  const attachments = first.attachments || draft?.content?.attachments || [];

  const buttonMap = new Map();

  for (const b of flattenButtons(first.buttons || draft.buttons)) {
    buttonMap.set(b.title, { title: b.title, targetUrl: b.url, unique: 0, total: 0 });
  }

  for (const l of links) {
    const title = String(l.label || 'Кнопка');
    const current = buttonMap.get(title) || { title, targetUrl: l.target_url || '', unique: 0, total: 0 };

    current.unique += Number(l.unique_clicks || 0);
    current.total += Number(l.total_clicks || 0);

    if (!current.targetUrl) current.targetUrl = l.target_url || '';

    buttonMap.set(title, current);
  }

  const buttons = Array.from(buttonMap.values());

  const channels = posts.map((p) => {
    const ps = safeJson(p.report_snapshot, {});
    const views = Number(ps.views ?? ps.totalViews ?? 0);
    const clicks = links
      .filter((l) => Number(l.channel_id || 0) === Number(p.channel_id || 0))
      .reduce((sum, l) => sum + Number(l.unique_clicks || 0), 0);

    const cpm = Number(p.cpm || first.cpm || snap.cpm || 0);

    return {
      id: p.id,
      name: p.channel_title || 'Канал',
      link: p.channel_link || '',
      status: p.status || '',
      views,
      clicks,
      ctr: views ? Number(((clicks / views) * 100).toFixed(2)) : 0,
      cost: Math.round((views / 1000) * cpm),
    };
  });

  const totalViews = channels.reduce((sum, c) => sum + Number(c.views || 0), 0) || Number(snap.totalViews || 0);
  const uniqueClicks = buttons.reduce((sum, b) => sum + Number(b.unique || 0), 0);
  const totalClicks = buttons.reduce((sum, b) => sum + Number(b.total || 0), 0);
  const cpm = Number(first.cpm || snap.cpm || 0);
  const cost = Math.round((totalViews / 1000) * cpm);

  const history = [];

  if (first.publish_at) history.push({ time: new Date(first.publish_at).toLocaleString('ru-RU'), event: 'Отложен пост', detail: 'Пост поставлен в расписание' });
  if (first.published_at) history.push({ time: new Date(first.published_at).toLocaleString('ru-RU'), event: 'Опубликован', detail: 'Начался подсчёт просмотров MAX и кликов кнопок' });
  if (first.updated_at) history.push({ time: new Date(first.updated_at).toLocaleString('ru-RU'), event: 'Обновлён', detail: 'Отчёт показывает актуальный текст, кнопки, CPM и удаление' });
  if (first.auto_deleted_at) history.push({ time: new Date(first.auto_deleted_at).toLocaleString('ru-RU'), event: 'Удалён', detail: 'Пост удалён по автоудалению' });

  const text = first.text || draft?.content?.text || snap.title || '';


  const reportKey = String(first.report_group_id || draft?.campaignId || first.id || id);
  const liveChart = await lrBuildViewChart(reportKey, first.id, totalViews);
  const liveStatusInfo = lrStatusInfo(posts);

  return {
    id,
    status: reportStatus(posts),
    statusInfo: liveStatusInfo,
    title: shortText(text),
    post: {
      title: shortText(text),
      text: stripHtml(text),
      html: postHtml(first, draft, snap),
      media: mediaInfo(attachments),
      buttons,
    },
    metrics: {
      views: totalViews,
      uniqueClicks,
      totalClicks,
      repeatClicks: Math.max(0, totalClicks - uniqueClicks),
      ctr: totalViews ? Number(((uniqueClicks / totalViews) * 100).toFixed(2)) : 0,
      cpm,
      cost,
      autoDelete: autoDeleteText(first.auto_delete_minutes),
      updatedAt: new Date().toISOString(),
    },
    channels,
    buttons,
    history,
    chart: liveChart,
  };
}

function jsonForHtml(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function page(data) {
  const payload = jsonForHtml(data);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>LinkRay Analytics</title>
<style>
:root{--bg:#06111f;--panel:#142334;--panel2:#1b2b3e;--line:rgba(215,238,255,.18);--text:#effcff;--muted:#9fb8c9;--green:#69f6bd;--blue:#69a9ff;--red:#ff5c7a;--yellow:#ffd166}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:radial-gradient(circle at 15% -5%,rgba(105,246,189,.24),transparent 32%),radial-gradient(circle at 88% 1%,rgba(105,169,255,.25),transparent 34%),linear-gradient(135deg,#04101d,#091829 45%,#11172c);color:var(--text);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
body{overflow-x:hidden}
a{color:var(--green)}
button{font:inherit}
.wrap{max-width:1180px;margin:0 auto;padding:16px 12px 48px}
.hero,.panel{border:1px solid var(--line);background:linear-gradient(135deg,rgba(255,255,255,.105),rgba(255,255,255,.052));box-shadow:0 28px 90px rgba(0,0,0,.28);border-radius:30px}
.hero{padding:22px;margin-bottom:14px;position:relative;overflow:hidden}
.hero:before{content:"";position:absolute;right:-110px;top:-120px;width:310px;height:310px;border-radius:999px;background:radial-gradient(circle,rgba(105,246,189,.34),rgba(105,169,255,.13),transparent 70%)}
.brand{display:flex;align-items:center;gap:14px;position:relative;z-index:2}
.logoSvg{width:74px;height:74px;border-radius:22px;box-shadow:0 16px 45px rgba(105,246,189,.25);flex:0 0 auto}
.brand h1{font-size:clamp(30px,6vw,54px);line-height:1;margin:0 0 7px;font-weight:950}
.brand p{margin:0;color:var(--muted);font-size:16px;line-height:1.35}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0;position:relative;z-index:2}
.action{border:1px solid rgba(105,246,189,.28);background:rgba(105,246,189,.13);color:var(--text);border-radius:999px;padding:11px 14px;font-weight:900;cursor:pointer}
.action.blue{border-color:rgba(105,169,255,.30);background:rgba(105,169,255,.14)}
.lead{position:relative;z-index:2;color:#c8d8e2;font-size:18px;line-height:1.6;max-width:900px}
.promo{position:relative;z-index:2;margin:18px 0;border:1px solid rgba(105,246,189,.30);background:linear-gradient(135deg,rgba(105,246,189,.16),rgba(105,169,255,.10));border-radius:26px;padding:16px;display:grid;grid-template-columns:auto 1fr auto;gap:15px;align-items:center}
.promo .miniLogo{width:62px;height:62px;border-radius:20px;flex:0 0 auto}
.promo-title{font-size:19px;font-weight:950;line-height:1.18}
.promo-text{color:#c4d8e5;line-height:1.45;margin-top:6px}
.promo-btn{display:flex;align-items:center;justify-content:center;min-width:178px;text-decoration:none;color:#04101d;background:linear-gradient(135deg,var(--green),var(--blue));font-weight:950;border-radius:18px;padding:13px 17px}
.tabs{display:flex;gap:10px;flex-wrap:wrap;position:relative;z-index:2}
.tab{border:1px solid var(--line);background:rgba(255,255,255,.075);color:var(--text);border-radius:17px;padding:11px 16px;font-weight:900;cursor:pointer}
.tab.active{border-color:rgba(105,246,189,.38);background:rgba(105,246,189,.15)}
.states{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}
.state{border:1px solid var(--line);background:rgba(255,255,255,.055);border-radius:18px;padding:12px;font-weight:900;color:#dceff8;display:flex;align-items:center;gap:9px}
.dot{width:12px;height:12px;border-radius:999px;background:var(--muted);box-shadow:0 0 16px currentColor}
.state.active .dot{background:var(--green)}
.state.done .dot{background:var(--blue)}
.state.deleted .dot{background:var(--red)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}
.stat{border:1px solid var(--line);border-radius:24px;background:rgba(255,255,255,.07);padding:16px;overflow:hidden;position:relative}
.stat:after{content:"";position:absolute;right:-25px;bottom:-30px;width:88px;height:88px;border-radius:999px;background:rgba(105,246,189,.08)}
.label{color:var(--muted);font-weight:850}
.value{font-size:32px;font-weight:950;margin:6px 0 3px}
.sub{color:#a6ffe3;font-weight:850;font-size:13px}
.view{display:none}
.view.active{display:block}
.panel{padding:18px;margin:14px 0}
.panel h2{margin:0 0 14px;font-size:27px}
.grid2{display:grid;grid-template-columns:1.06fr .94fr;gap:14px}
.postBox{border:1px solid var(--line);background:rgba(0,0,0,.18);border-radius:24px;overflow:hidden}
.mediaBox{display:none}
.mediaBox.show{display:flex;min-height:92px;align-items:center;justify-content:center;padding:18px;text-align:center;background:linear-gradient(135deg,rgba(105,246,189,.14),rgba(105,169,255,.12));color:#dff7ff}
.mediaBox img,.mediaBox video{width:100%;max-height:520px;object-fit:contain;background:#071421}
.postBody{padding:17px}
.postTitle{font-weight:950;font-size:24px;line-height:1.15;margin-bottom:12px}
.postText{font-size:17px;line-height:1.5;color:#dff2fa;white-space:normal;overflow-wrap:anywhere}
.postText a{color:#8cffd7;font-weight:900;text-decoration:underline;text-underline-offset:3px}
.postBtns{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px}
.postBtn{border:1px solid rgba(105,246,189,.30);background:linear-gradient(135deg,rgba(105,246,189,.20),rgba(105,169,255,.17));color:var(--text);border-radius:15px;padding:10px 13px;font-weight:900}
.quick{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.quick .stat{min-height:116px}
.chart{height:240px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(to top,rgba(255,255,255,.05) 1px,transparent 1px) 0 0/100% 25%,rgba(0,0,0,.13);display:flex;align-items:end;gap:8px;padding:18px 14px 12px}
.bar{flex:1;min-width:12px;border-radius:13px 13px 6px 6px;background:linear-gradient(180deg,var(--green),var(--blue));position:relative;transition:.2s}
.bar span{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);font-size:11px;color:#cfe9f4;margin-bottom:5px}
.periods{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.period{border:1px solid var(--line);background:rgba(255,255,255,.065);color:var(--text);border-radius:16px;padding:10px 14px;font-weight:900;cursor:pointer}
.period.active{background:rgba(105,246,189,.14);border-color:rgba(105,246,189,.36)}
.channelRows{display:grid;gap:10px}
.channelRow{display:grid;grid-template-columns:2fr repeat(4,1fr);gap:10px;align-items:center;border:1px solid var(--line);border-radius:20px;padding:14px;background:rgba(255,255,255,.055)}
.avatar{width:42px;height:42px;border-radius:15px;background:linear-gradient(135deg,var(--green),var(--blue));display:grid;place-items:center;color:#06111f;font-weight:950}
.chName{display:flex;align-items:center;gap:10px;font-weight:950;line-height:1.15}
.cellLabel{display:none;color:var(--muted);font-size:12px;font-weight:800}
.metric b{display:block;font-size:18px}
.metric span{color:var(--muted);font-size:12px;font-weight:800}
table{width:100%;border-collapse:collapse}
th,td{padding:12px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted)}
.notice,.insight{border:1px solid var(--line);background:rgba(255,255,255,.06);border-radius:18px;padding:14px;line-height:1.5;color:#dceff8}
.insights{display:grid;gap:10px}
.footer{text-align:center;color:var(--muted);font-size:13px;margin-top:18px}
@media(max-width:900px){
.wrap{padding:10px 8px 30px}
.hero,.panel{border-radius:25px;padding:15px}
.brand{align-items:flex-start}
.logoSvg{width:64px;height:64px;border-radius:20px}
.promo{grid-template-columns:auto 1fr}
.promo-btn{grid-column:1/-1;width:100%}
.states,.stats{grid-template-columns:repeat(2,1fr)}
.grid2{grid-template-columns:1fr}
.quick{grid-template-columns:1fr 1fr}
.channelRow{grid-template-columns:1fr 1fr}
.chName{grid-column:1/-1}
.cellLabel{display:block}
.value{font-size:27px}
.panel h2{font-size:24px}
}
@media(max-width:430px){
.stats,.states,.quick{grid-template-columns:1fr}
.channelRow{grid-template-columns:1fr 1fr}
.hero .lead{font-size:16px}
.postTitle{font-size:21px}
.postText{font-size:16px}
}
</style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <div class="brand">
      <svg class="logoSvg" viewBox="0 0 512 512" aria-label="LinkRay">
        <defs><linearGradient id="g1" x1="0" x2="1" y1="1" y2="0"><stop offset="0" stop-color="#102b65"/><stop offset=".55" stop-color="#20d6c1"/><stop offset="1" stop-color="#7cff9f"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
        <rect width="512" height="512" rx="130" fill="url(#g1)"/><circle cx="256" cy="256" r="205" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="12"/><path d="M256 98l121 49v83c0 82-49 145-121 180-72-35-121-98-121-180v-83z" fill="#e9ffff" stroke="#0e3976" stroke-width="13"/><path d="M128 307c87-6 165-50 238-142" fill="none" stroke="#66f2b5" stroke-width="31" stroke-linecap="round" filter="url(#glow)"/><path d="M304 145l72 11-8 72" fill="none" stroke="#66f2b5" stroke-width="31" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/><circle cx="256" cy="256" r="48" fill="none" stroke="#0e3976" stroke-width="18"/><rect x="220" y="310" width="72" height="60" rx="15" fill="#0e3976"/>
      </svg>
      <div>
        <h1>LinkRay Analytics</h1>
        <p>Живой отчёт рекламного размещения в MAX</p>
      </div>
    </div>

    <div class="actions">
      <button class="action" id="copyBtn">🔗 Скопировать отчёт</button>
      <button class="action blue" id="refreshBtn">🔄 Обновить</button>
    </div>

    <div class="lead">Отчёт обновляется автоматически: статус поста, текст, кнопки, время удаления, просмотры MAX, клики кнопок и CPM берутся из актуальных данных.</div>

    <div class="promo">
      <svg class="miniLogo" viewBox="0 0 512 512" aria-label="LinkRay"><rect width="512" height="512" rx="130" fill="url(#g1)"/><circle cx="256" cy="256" r="205" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="12"/><path d="M256 98l121 49v83c0 82-49 145-121 180-72-35-121-98-121-180v-83z" fill="#e9ffff" stroke="#0e3976" stroke-width="13"/><path d="M128 307c87-6 165-50 238-142" fill="none" stroke="#66f2b5" stroke-width="31" stroke-linecap="round"/><path d="M304 145l72 11-8 72" fill="none" stroke="#66f2b5" stroke-width="31" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div>
        <div class="promo-title">🚀 LinkRay — живые отчёты для рекламодателей в MAX</div>
        <div class="promo-text">Постинг, закупы, просмотры MAX, уникальные клики по кнопкам, CPM, автоудаление и история размещения — в одном красивом отчёте.</div>
      </div>
      <a class="promo-btn" href="${BOT_LINK}" target="_blank" rel="noopener noreferrer">Открыть LinkRay</a>
    </div>

    <div class="tabs">
      <button class="tab active" data-view="overview">Обзор</button>
      <button class="tab" data-view="channels">Каналы</button>
      <button class="tab" data-view="buttons">Кнопки</button>
      <button class="tab" data-view="cpm">CPM</button>
      <button class="tab" data-view="history">История</button>
      <button class="tab" data-view="insights">Выводы</button>
    </div>

    <div class="states" id="states"></div>
  </section>

  <div class="stats" id="stats"></div>

  <main id="overview" class="view active">
    <div class="grid2">
      <section class="panel">
        <h2>📝 Актуальная версия поста</h2>
        <div class="postBox">
          <div class="mediaBox" id="mediaBox"></div>
          <div class="postBody">
            <div class="postTitle" id="postTitle"></div>
            <div class="postText" id="postText"></div>
            <div class="postBtns" id="postBtns"></div>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>⚡ Быстрые показатели</h2>
        <div class="quick" id="quick"></div>
      </section>
    </div>

    <section class="panel">
      <h2>📈 Динамика просмотров MAX</h2>
      <div class="periods">
        <button class="period active" data-period="h1">1 час</button>
        <button class="period" data-period="h24">24 часа</button>
        <button class="period" data-period="h48">48 часов</button>
      </div>
      <div class="chart" id="chart"></div>
    </section>
  </main>

  <main id="channels" class="view">
    <section class="panel">
      <h2>📌 Публикации по каналам</h2>
      <div class="channelRows" id="channelRows"></div>
    </section>
  </main>

  <main id="buttons" class="view">
    <section class="panel">
      <h2>🔘 Клики только по кнопкам</h2>
      <div class="notice">Ссылки в тексте поста не считаются кликами. Уникальный клик: один человек по одной кнопке засчитывается один раз.</div>
      <table>
        <thead><tr><th>Кнопка</th><th>Уникальные</th><th>Все нажатия</th><th>Повторы</th><th>Доля</th></tr></thead>
        <tbody id="buttonRows"></tbody>
      </table>
    </section>
  </main>

  <main id="cpm" class="view">
    <section class="panel">
      <h2>💰 CPM и стоимость</h2>
      <div class="quick" id="cpmRows"></div>
      <div class="notice">Формула: стоимость = просмотры MAX / 1000 × CPM. Клики показывают эффективность, но цену считаем по просмотрам.</div>
    </section>
  </main>

  <main id="history" class="view">
    <section class="panel">
      <h2>🕓 История размещения</h2>
      <table>
        <thead><tr><th>Время</th><th>Событие</th><th>Детали</th></tr></thead>
        <tbody id="historyRows"></tbody>
      </table>
    </section>
  </main>

  <main id="insights" class="view">
    <section class="panel">
      <h2>🧠 Выводы LinkRay</h2>
      <div class="insights" id="insightRows"></div>
    </section>
  </main>

  <div class="footer">LinkRay Analytics · автообновление каждые 15 секунд</div>
</div>

<script type="application/json" id="report-data">${payload}</script>
<script>
(function(){
  var REPORT = JSON.parse(document.getElementById('report-data').textContent || '{}');
  var PERIOD = 'h1';
  var fmt = new Intl.NumberFormat('ru-RU');

  function byId(id){ return document.getElementById(id); }
  function safe(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function n(v){ v = Number(v || 0); return Number.isFinite(v) ? v : 0; }

  function statusLabel(s){
    if(s === 'scheduled') return '⏳ Отложен';
    if(s === 'published') return '✅ Опубликован';
    if(s === 'ended') return '🏁 Закончилась';
    if(s === 'deleted') return '🗑️ Удалён';
    return '📌 Статус';
  }

  function renderStates(){
    var info = REPORT.statusInfo || {};
    var cls = 'state active ' + safe(info.key || REPORT.status || '');
    byId('states').innerHTML =
      '<div class="' + cls + '" style="grid-column:1/-1">' +
      '<span class="dot"></span>' +
      '<div><b>' + safe((info.icon || '📌') + ' ' + (info.title || statusLabel(REPORT.status))) + '</b>' +
      '<div style="color:#9fb8c9;font-size:14px;line-height:1.35;margin-top:4px">' + safe(info.text || '') + '</div>' +
      '</div></div>';
  }

function renderStats(){
    var m = REPORT.metrics || {};
    byId('stats').innerHTML =
      '<div class="stat"><div class="label">Просмотры MAX</div><div class="value">' + fmt.format(n(m.views)) + '</div><div class="sub">из каналов</div></div>' +
      '<div class="stat"><div class="label">Уникальные клики кнопок</div><div class="value">' + fmt.format(n(m.uniqueClicks)) + '</div><div class="sub">1 человек = 1 клик</div></div>' +
      '<div class="stat"><div class="label">CTR по кнопкам</div><div class="value">' + n(m.ctr).toFixed(2) + '%</div><div class="sub">клики / просмотры</div></div>' +
      '<div class="stat"><div class="label">Стоимость по CPM</div><div class="value">' + fmt.format(n(m.cost)) + '₽</div><div class="sub">CPM ' + fmt.format(n(m.cpm)) + '₽</div></div>';
  }

  function renderPost(){
    var p = REPORT.post || {};
    byId('postTitle').textContent = p.title || 'Рекламный пост';
    byId('postText').innerHTML = p.html || safe(p.text || 'Текст поста пока недоступен').replace(/\\n/g,'<br>');

    var media = p.media || {};
    var box = byId('mediaBox');
    box.className = 'mediaBox';
    box.innerHTML = '';

    if(media.url){
      box.className = 'mediaBox show';
      if(media.kind === 'video'){
        var video = document.createElement('video');
        video.src = media.url;
        video.controls = true;
        video.muted = true;
        video.playsInline = true;
        box.appendChild(video);
      } else {
        var img = document.createElement('img');
        img.src = media.url;
        img.alt = 'Медиа поста';
        box.appendChild(img);
      }
    } else if(n(media.count) > 0 || media.token){
      box.className = 'mediaBox show';
      box.innerHTML = '<div>🖼️ Медиа поста есть в MAX<br><small>Старый пост хранит token вложения. Для браузерного показа нужен отдельный preview/proxy.</small></div>';
    }

    byId('postBtns').innerHTML = (p.buttons || []).map(function(b){
      return '<button class="postBtn" type="button">' + safe(b.title || 'Кнопка') + '</button>';
    }).join('');
  }

  function renderQuick(){
    var m = REPORT.metrics || {};
    byId('quick').innerHTML =
      '<div class="stat"><div class="label">Статус</div><div class="value" style="font-size:22px">' + statusLabel(REPORT.status) + '</div><div class="sub">живой</div></div>' +
      '<div class="stat"><div class="label">Автоудаление</div><div class="value" style="font-size:22px">' + safe(m.autoDelete || '—') + '</div><div class="sub">актуально</div></div>' +
      '<div class="stat"><div class="label">Повторы кликов</div><div class="value">' + fmt.format(n(m.repeatClicks)) + '</div><div class="sub">не входят в уникальные</div></div>' +
      '<div class="stat"><div class="label">Все нажатия</div><div class="value">' + fmt.format(n(m.totalClicks)) + '</div><div class="sub">сырые события</div></div>';
  }

  function renderChart(){
    var chart = REPORT.chart || {};
    var arr = Array.isArray(chart.values) ? chart.values : [];
    var labels = Array.isArray(chart.labels) ? chart.labels : [];
    var box = byId('chart');

    if (arr.length < 2 || new Set(arr.map(function(x){ return Number(x || 0); })).size < 2) {
      box.innerHTML = '<div style="width:100%;align-self:center;text-align:center;color:#9fb8c9;font-weight:850;line-height:1.45">📈 Динамика появится, когда MAX отдаст несколько обновлений просмотров.<br>Сейчас недостаточно точек для честного графика.</div>';
      return;
    }

    var max = Math.max.apply(null, arr.concat([1]));
    box.innerHTML = arr.map(function(v, i){
      var h = Math.max(8, Math.round(n(v) / max * 100));
      var label = labels[i] || '';
      return '<div class="bar" style="height:' + h + '%"><span>' + fmt.format(n(v)) + '<br><small>' + safe(label) + '</small></span></div>';
    }).join('');
  }

function renderChannels(){
    byId('channelRows').innerHTML = (REPORT.channels || []).map(function(c){
      var first = (c.name || 'К').slice(0,1);
      return '<div class="channelRow">' +
        '<div class="chName"><div class="avatar">' + safe(first) + '</div><div>' + safe(c.name || 'Канал') + '</div></div>' +
        '<div class="metric"><span class="cellLabel">Просмотры</span><b>' + fmt.format(n(c.views)) + '</b></div>' +
        '<div class="metric"><span class="cellLabel">Клики</span><b>' + fmt.format(n(c.clicks)) + '</b></div>' +
        '<div class="metric"><span class="cellLabel">CTR</span><b>' + n(c.ctr).toFixed(2) + '%</b></div>' +
        '<div class="metric"><span class="cellLabel">Стоимость</span><b>' + fmt.format(n(c.cost)) + '₽</b></div>' +
      '</div>';
    }).join('') || '<div class="notice">Каналов для отчёта пока нет.</div>';
  }

  function renderButtons(){
    var buttons = REPORT.buttons || [];
    var totalUnique = buttons.reduce(function(sum,b){ return sum + n(b.unique); }, 0);

    byId('buttonRows').innerHTML = buttons.map(function(b){
      var repeat = Math.max(0, n(b.total) - n(b.unique));
      var share = totalUnique ? (n(b.unique) / totalUnique * 100).toFixed(1) : '0.0';
      return '<tr><td><b>' + safe(b.title || 'Кнопка') + '</b></td><td>' + fmt.format(n(b.unique)) + '</td><td>' + fmt.format(n(b.total)) + '</td><td>' + fmt.format(repeat) + '</td><td>' + share + '%</td></tr>';
    }).join('') || '<tr><td colspan="5">Кликов по кнопкам пока нет.</td></tr>';
  }

  function renderCpm(){
    var m = REPORT.metrics || {};
    byId('cpmRows').innerHTML =
      '<div class="stat"><div class="label">Просмотры MAX</div><div class="value">' + fmt.format(n(m.views)) + '</div></div>' +
      '<div class="stat"><div class="label">CPM</div><div class="value">' + fmt.format(n(m.cpm)) + '₽</div></div>' +
      '<div class="stat"><div class="label">Стоимость</div><div class="value">' + fmt.format(n(m.cost)) + '₽</div></div>' +
      '<div class="stat"><div class="label">CTR кнопок</div><div class="value">' + n(m.ctr).toFixed(2) + '%</div></div>';
  }

  function renderHistory(){
    byId('historyRows').innerHTML = (REPORT.history || []).map(function(h){
      return '<tr><td><b>' + safe(h.time || '') + '</b></td><td>' + safe(h.event || '') + '</td><td>' + safe(h.detail || '') + '</td></tr>';
    }).join('') || '<tr><td colspan="3">История пока пустая.</td></tr>';
  }

  function renderInsights(){
    var channels = (REPORT.channels || []).slice().filter(function(c){ return n(c.views) > 0; });
    var best = channels.slice().sort(function(a,b){ return n(b.ctr) - n(a.ctr); })[0];
    var worst = channels.slice().sort(function(a,b){ return n(a.ctr) - n(b.ctr); })[0];

    byId('insightRows').innerHTML =
      '<div class="insight">🔥 Лучший канал по CTR: <b>' + safe(best ? best.name : 'пока нет данных') + '</b>.</div>' +
      '<div class="insight">⚠️ Самый слабый отклик: <b>' + safe(worst ? worst.name : 'пока нет данных') + '</b>.</div>' +
      '<div class="insight">🛡️ Уникальные клики считаются строго: один человек по одной кнопке — один клик.</div>' +
      '<div class="insight">♻️ Если пост редактируется, отчёт берёт актуальные текст, кнопки, CPM, автоудаление и статус.</div>';
  }

  function renderAll(){
    renderStates();
    renderStats();
    renderPost();
    renderQuick();
    renderChart();
    renderChannels();
    renderButtons();
    renderCpm();
    renderHistory();
    renderInsights();
  }

  function showView(id){
    document.querySelectorAll('.tab').forEach(function(btn){
      btn.classList.toggle('active', btn.getAttribute('data-view') === id);
    });
    document.querySelectorAll('.view').forEach(function(view){
      view.classList.toggle('active', view.id === id);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.querySelectorAll('.tab').forEach(function(btn){
    btn.addEventListener('click', function(){ showView(btn.getAttribute('data-view')); });
  });

  document.querySelectorAll('.period').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.period').forEach(function(x){ x.classList.remove('active'); });
      btn.classList.add('active');
      PERIOD = btn.getAttribute('data-period');
      renderChart();
    });
  });

  byId('copyBtn').addEventListener('click', function(){
    try { navigator.clipboard.writeText(location.href); alert('Ссылка скопирована'); } catch(e) { alert(location.href); }
  });

  byId('refreshBtn').addEventListener('click', function(){
    location.href = location.pathname + '?v=' + Date.now();
  });

  renderAll();
  // LR_LIVE_REFRESH_START
  setInterval(async function(){
    try {
      var r = await fetch(location.pathname + '?json=1&v=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      REPORT = await r.json();
      renderAll();
    } catch(e) {}
  }, 15000);
  // LR_LIVE_REFRESH_END

})();
</script>
</body>
</html>`;
}

export function mountLinkRayAnalyticsRoutes(app) {
  app.get('/r/:token', async (req, res) => {
    try {
      await ensureSchema();

      const token = String(req.params.token || '').trim();
      const link = rows(await query('SELECT * FROM analytics_links WHERE token=$1 LIMIT 1', [token]))[0];

      if (!link) return res.status(404).send('LinkRay: ссылка не найдена');

      const preview = isPreviewRequest(req);

      console.log('[analytics redirect]', JSON.stringify({
        token,
        campaignId: link.campaign_id,
        postId: link.post_id,
        channelId: link.channel_id,
        kind: link.kind,
        preview,
        ua: String(req.headers['user-agent'] || '').slice(0, 160)
      }));

      if (!preview) {
        const f = fingerprint(req, token);

        await query(
          `INSERT INTO analytics_click_events(token,campaign_id,post_id,channel_id,fingerprint,ip_hash,user_agent,clicked_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,now())`,
          [token, link.campaign_id, link.post_id, link.channel_id, f.fingerprint, f.ipHash, f.userAgent]
        );

        await query(
          `INSERT INTO analytics_clicks(token,campaign_id,post_id,channel_id,fingerprint,ip_hash,user_agent,clicked_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,now())
           ON CONFLICT(token, fingerprint) DO NOTHING`,
          [token, link.campaign_id, link.post_id, link.channel_id, f.fingerprint, f.ipHash, f.userAgent]
        );

        console.log('[analytics click counted]', JSON.stringify({
          token,
          campaignId: link.campaign_id,
          postId: link.post_id,
          fingerprint: f.fingerprint
        }));
      }

      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.redirect(302, link.target_url);
    } catch (error) {
      console.error('[linkray analytics redirect]', error.message || error);
      return res.status(500).send('LinkRay redirect error');
    }
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
      console.error('[linkray analytics page]', error.message || error);
      return res.status(500).send('LinkRay report error: ' + esc(error.message || error));
    }
  });
}
