
import crypto from 'node:crypto';
import { query } from './db.js';

const LINKRAY_BOT_LINK = 'https://max.ru/se13353901_bot';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.SITE_URL || process.env.WEBAPP_URL || 'https://linkray.ru').replace(/\/$/, '');
const LOGO = "data:image/webp;base64,UklGRpgMAABXRUJQVlA4IIwMAADQNACdASqgAKAAPpFEmkolo6IkpxXbkLASCUDfA09kLQ1+X/I0G92q+z6Qtu7zxfnUb8X6JvTMT+7pKiZOgz2twdgj4VaX2a15fvr4uCMDvBuorX/QNq4nqMcSos4rIVqNLn7YzgXsfGP8238o/qOphAD+JhkEiXJ+/7uwUa4yRo+v+Rg+1fQVsG6wFkRXJia10LEBPniIq/F4M6hnWRAAGDNNpxVhXxwQJlm/+6auZ1hLrvZKlG3Fr/RrFqwcOcPl1rtQTnDIQlHlQXjVplA8r8HzVb8UM54TEP+kX0r4Ylmf/LHKTuY9LztyKz4b1gnTr9huVCfj3zOrIcP/R+WbqA+vew+MMlFn5ok35aF2lNgY3LOH2hdESASwNxYrmzIxyNRQgibOF61I0Kpw2gqk2W1hgQ5yeTcE4XWB3+sUgqJs16P78+MtUx7fyRaAeu4B+0fR8ChZawKq6K/xOWid76G79xL80IHQ1hZHvhPRB+lRUVM7dkTe+AHY7S8bzrVP2Bv0F3uykKzNVvTwTqxy3/I9A2zR0bqII6DB7/eTnJ3v13i7hmx8jG3sg3C+Sm1+/6vbo/iMjdrVLx+cJd7IYJpFyT2iQtlMkEKDUyy6VEAd/pLh+vWjwgKZQ5eC7StKhKgY9PhxNCH+C3mPw1vJ7zL03x+/Vc+TOC4u5k44VjRImEYT4FFRhkPi/QAjQ7ZGcOOl+4ZzsvDBqGCIY+OjXfVd7Yf6BRbWP7M3jPpRN5eB8sX6kVwT6RV6gw2mc8MJaQTNv2T6sa1A3AA==";

const rows = (r) => Array.isArray(r) ? r : (r?.rows || []);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const sha = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex');

function safeJson(v, fallback = {}) {
  try {
    if (!v) return fallback;
    if (typeof v === 'object') return v;
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function plain(v) {
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

function short(v, n = 96) {
  const s = plain(v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '...' : (s || 'Рекламный пост');
}

function autoDeleteText(minutes) {
  const n = Number(minutes || 0);
  if (!Number.isFinite(n) || n <= 0) return 'без удаления';
  if (n % 1440 === 0) return `${n / 1440}д`;
  if (n % 60 === 0) return `${n / 60}ч`;
  return `${n} мин`;
}


function sanitizePostHtml(value) {
  let html = String(value || '');

  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '');

  html = html
    .replace(/<(?!\/?(a|b|strong|i|em|u|s|br|p|div|span)\b)[^>]*>/gi, '')
    .replace(/<a\b([^>]*)>/gi, (m, attrs) => {
      const href = String(attrs || '').match(/href=["']([^"']+)["']/i)?.[1] || '';
      if (!/^https?:\/\//i.test(href)) return '<span>';
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">`;
    });

  if (!html.trim()) return '';

  return html.replace(/\n/g, '<br>');
}

function extractMediaInfo(value) {
  const data = safeJson(value, []);
  let found = null;
  let count = 0;

  const isMediaUrl = (url) => /^https?:\/\//i.test(url);
  const kindOf = (url) => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url) ? 'video' : 'image';

  const scan = (item) => {
    if (found || item == null) return;

    if (typeof item === 'string') {
      if (isMediaUrl(item)) found = { url: item, kind: kindOf(item) };
      return;
    }

    if (Array.isArray(item)) {
      count += item.length;
      for (const x of item) scan(x);
      return;
    }

    if (typeof item === 'object') {
      count += 1;

      const keys = [
        'url',
        'src',
        'link',
        'downloadUrl',
        'download_url',
        'previewUrl',
        'preview_url',
        'thumbnailUrl',
        'thumbnail_url',
        'fileUrl',
        'file_url',
        'imageUrl',
        'image_url',
        'videoUrl',
        'video_url'
      ];

      for (const key of keys) {
        const url = item?.[key];
        if (typeof url === 'string' && isMediaUrl(url)) {
          found = { url, kind: kindOf(url) };
          return;
        }
      }

      for (const value of Object.values(item)) scan(value);
    }
  };

  scan(data);

  return found || { url: '', kind: '', count };
}

function flattenButtons(v) {
  const data = safeJson(v, []);
  const out = [];
  for (const row of Array.isArray(data) ? data : []) {
    for (const b of (Array.isArray(row) ? row : [row])) {
      const title = String(b?.text || b?.title || b?.label || '').trim();
      const url = String(b?.url || b?.link || '').trim();
      if (title) out.push({ title, url });
    }
  }
  return out;
}

function reportStatus(posts) {
  if (!posts.length) return 'scheduled';
  const statuses = posts.map((p) => String(p.status || '').toLowerCase());

  if (statuses.some((s) => ['canceled', 'cancelled', 'deleted', 'delete'].includes(s))) return 'deleted';
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

function fingerprint(req, token) {
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '')
    .split(',')[0]
    .trim();

  const ua = String(req.headers['user-agent'] || '');

  return {
    ipHash: sha(ip).slice(0, 32),
    userAgent: ua.slice(0, 420),
    fingerprint: sha(`${token}|${ip}|${ua}`).slice(0, 48),
  };
}

function isPreviewRequest(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  const method = String(req.method || '').toUpperCase();

  if (method === 'HEAD') return true;

  return /bot|crawler|spider|preview|linkcheck|telegrambot|whatsapp|slurp|vkshare/.test(ua);
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

  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_group_id text`).catch(() => {});
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_snapshot jsonb`).catch(() => {});
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS auto_deleted_at timestamptz`).catch(() => {});
}

async function collect(groupId) {
  await ensureSchema();

  let posts = rows(await query(
    `SELECT sp.*, c.title AS channel_title, c.link AS channel_link
     FROM scheduled_posts sp
     LEFT JOIN channels c ON c.id = sp.channel_id
     WHERE sp.id::text = $1
        OR COALESCE(sp.report_group_id, '') = $1
        OR COALESCE(sp.draft->>'campaignId', '') = $1
     ORDER BY sp.id ASC`,
    [String(groupId)]
  ));

  const campaignIds = new Set([String(groupId)]);
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
     WHERE l.campaign_id = ANY($1::text[])
       AND (l.kind = 'button' OR (l.kind IS NULL AND COALESCE(l.label, '') <> 'ссылка'))
     GROUP BY l.token
     ORDER BY l.created_at ASC`,
    [ids]
  ));

  if (!posts.length && links.length) {
    posts = rows(await query(
      `SELECT sp.*, c.title AS channel_title, c.link AS channel_link
       FROM scheduled_posts sp
       LEFT JOIN channels c ON c.id = sp.channel_id
       WHERE sp.id = ANY($1::int[])
       ORDER BY sp.id ASC`,
      [links.map((l) => Number(l.post_id || 0)).filter(Boolean)]
    ));
  }

  const first = posts[0] || {};
  const draft = safeJson(first.draft, {});
  const snap = safeJson(first.report_snapshot, {});

  const buttonMap = new Map();

  for (const l of links) {
    const title = String(l.label || 'Кнопка');
    const current = buttonMap.get(title) || { title, unique: 0, total: 0, targetUrl: l.target_url || '' };

    current.unique += Number(l.unique_clicks || 0);
    current.total += Number(l.total_clicks || 0);

    buttonMap.set(title, current);
  }

  for (const b of flattenButtons(first.buttons || draft.buttons)) {
    if (!buttonMap.has(b.title)) {
      buttonMap.set(b.title, { title: b.title, unique: 0, total: 0, targetUrl: b.url || '' });
    }
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
      buttonClicks: clicks,
      cost: Math.round((views / 1000) * cpm),
      autoDelete: autoDeleteText(p.auto_delete_minutes),
    };
  });

  const totalViews = channels.reduce((sum, c) => sum + Number(c.views || 0), 0) || Number(snap.totalViews || 0);
  const uniqueClicks = buttons.reduce((sum, b) => sum + Number(b.unique || 0), 0);
  const totalClicks = buttons.reduce((sum, b) => sum + Number(b.total || 0), 0);
  const cpm = Number(first.cpm || snap.cpm || 0);

  const history = [];

  if (first.publish_at) {
    history.push({
      time: new Date(first.publish_at).toLocaleString('ru-RU'),
      event: 'Отложен пост',
      detail: `CPM ${cpm || '—'}₽, удаление ${autoDeleteText(first.auto_delete_minutes)}`,
    });
  }

  if (first.published_at) {
    history.push({
      time: new Date(first.published_at).toLocaleString('ru-RU'),
      event: 'Опубликован',
      detail: 'Начался подсчёт просмотров MAX и кликов кнопок',
    });
  }

  if (first.updated_at) {
    history.push({
      time: new Date(first.updated_at).toLocaleString('ru-RU'),
      event: 'Обновлён',
      detail: 'Актуальная версия текста, кнопок, CPM и удаления',
    });
  }

  if (first.auto_deleted_at) {
    history.push({
      time: new Date(first.auto_deleted_at).toLocaleString('ru-RU'),
      event: 'Удалён',
      detail: 'Пост удалён по автоудалению',
    });
  }

  return {
    groupId: String(groupId),
    logo: LOGO,
    status: reportStatus(posts),
    title: short(first.text || draft?.content?.text || snap.title || 'Рекламный пост'),
    post: {
      title: short(first.text || draft?.content?.text || snap.title || 'Рекламный пост'),
      text: plain(first.text || draft?.content?.text || snap.title || ''),
      textHtml: sanitizePostHtml(first.text || draft?.content?.text || snap.title || ''),
      media: safeJson(first.attachments || draft?.content?.attachments, []).length ? 'Медиа поста сохранено' : 'Без медиа',
      mediaInfo: extractMediaInfo(first.attachments || draft?.content?.attachments || []),
      buttons,
    },
    metrics: {
      totalViews,
      uniqueClicks,
      totalButtonClicks: totalClicks,
      repeatedClicks: Math.max(0, totalClicks - uniqueClicks),
      ctr: totalViews ? Number(((uniqueClicks / totalViews) * 100).toFixed(2)) : 0,
      cpm,
      cost: Math.round((totalViews / 1000) * cpm),
      autoDelete: autoDeleteText(first.auto_delete_minutes),
      updatedAt: new Date().toISOString(),
    },
    channels,
    buttons,
    viewsByPeriod: snap.viewsByPeriod || {
      '1h': [0, Math.round(totalViews * .02), Math.round(totalViews * .04), Math.round(totalViews * .06), Math.round(totalViews * .08), Math.round(totalViews * .1)],
      '24h': [0, Math.round(totalViews * .08), Math.round(totalViews * .18), Math.round(totalViews * .33), Math.round(totalViews * .55), Math.round(totalViews * .75), totalViews],
      '48h': [0, Math.round(totalViews * .08), Math.round(totalViews * .18), Math.round(totalViews * .33), Math.round(totalViews * .55), Math.round(totalViews * .75), Math.round(totalViews * .9), totalViews],
    },
    history,
  };
}

function page(data) {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LinkRay Analytics</title>
<style>
:root{--bg0:#050f1c;--bg1:#081928;--line:rgba(255,255,255,.16);--text:#ecfeff;--muted:#9eb7c9;--green:#68f4b8;--blue:#69a9ff;--red:#ff5b7c;--orange:#ffb86b;--shadow:0 26px 90px rgba(0,0,0,.36)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--text);background:radial-gradient(circle at 18% -8%,rgba(104,244,184,.29),transparent 34%),radial-gradient(circle at 86% 4%,rgba(105,169,255,.25),transparent 34%),linear-gradient(135deg,var(--bg0),var(--bg1) 52%,#111a2e);overflow-x:hidden}
button{font:inherit}
.wrap{max-width:1180px;margin:0 auto;padding:18px 14px 50px}
.hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:34px;padding:24px;background:linear-gradient(135deg,rgba(255,255,255,.14),rgba(255,255,255,.055));box-shadow:var(--shadow)}
.hero:before{content:"";position:absolute;right:-110px;top:-130px;width:360px;height:360px;border-radius:999px;background:radial-gradient(circle,rgba(104,244,184,.38),rgba(105,169,255,.13),transparent 68%)}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;position:relative;z-index:2}
.brand{display:flex;align-items:center;gap:15px}
.logo{width:76px;height:76px;border-radius:24px;object-fit:cover;box-shadow:0 18px 44px rgba(104,244,184,.30);border:1px solid rgba(255,255,255,.25)}
.brand-title{font-weight:950;font-size:22px}
.brand-sub{color:var(--muted);font-size:14px;margin-top:3px}
.status{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(104,244,184,.23);background:rgba(104,244,184,.12);color:#c3ffe5;padding:9px 13px;border-radius:999px;font-weight:850;font-size:13px;white-space:nowrap;cursor:pointer}
.pill.blue{border-color:rgba(105,169,255,.26);background:rgba(105,169,255,.13);color:#d7e9ff}
h1{font-size:clamp(29px,5.4vw,56px);line-height:1.03;margin:23px 0 10px;position:relative;z-index:2;max-width:880px}
.lead{color:#bed3df;line-height:1.55;font-size:16px;max-width:880px;position:relative;z-index:2;margin:0 0 18px}

.promo-card{position:relative;z-index:2;margin:18px 0 14px;border:1px solid rgba(104,244,184,.28);border-radius:24px;padding:16px;background:linear-gradient(135deg,rgba(104,244,184,.18),rgba(105,169,255,.12));display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center}
.promo-logo{width:58px;height:58px;border-radius:18px;object-fit:cover;box-shadow:0 12px 34px rgba(104,244,184,.26);border:1px solid rgba(255,255,255,.22)}
.promo-title{font-size:18px;font-weight:950}
.promo-text{color:#bdd7e3;font-size:14px;line-height:1.45;margin-top:4px}
.promo-btn{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;color:#06131f;background:linear-gradient(135deg,#68f4b8,#69a9ff);font-weight:950;border-radius:16px;padding:12px 15px;box-shadow:0 14px 34px rgba(104,244,184,.20);white-space:nowrap}
.post-media img,.post-media video{width:100%;height:100%;object-fit:cover;border:0;display:block}
.post-media.has-media{padding:0;background:#081421}
.post-media.no-url{align-items:center;justify-content:center;text-align:center;color:#dff7ff;background:linear-gradient(135deg,rgba(104,244,184,.16),rgba(105,169,255,.13)),#102033}
.post-text a{color:#87f5d0;text-decoration:underline;text-underline-offset:3px;font-weight:850}
@media(max-width:720px){.promo-card{grid-template-columns:auto 1fr}.promo-btn{grid-column:1/-1;width:100%}}


.lr-promo{position:relative;z-index:2;margin:18px 0 14px;border:1px solid rgba(104,244,184,.30);border-radius:24px;padding:16px;background:linear-gradient(135deg,rgba(104,244,184,.18),rgba(105,169,255,.12));display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center}
.lr-promo-logo{width:64px;height:64px;border-radius:20px;object-fit:cover;box-shadow:0 12px 34px rgba(104,244,184,.26);border:1px solid rgba(255,255,255,.22)}
.lr-promo-title{font-size:18px;font-weight:950}
.lr-promo-text{color:#bdd7e3;font-size:14px;line-height:1.45;margin-top:4px}
.lr-promo-btn{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;color:#06131f;background:linear-gradient(135deg,#68f4b8,#69a9ff);font-weight:950;border-radius:16px;padding:12px 15px;box-shadow:0 14px 34px rgba(104,244,184,.20);white-space:nowrap}
.post-media{min-height:0;height:auto;max-height:none}
.post-media.has-media{height:auto;min-height:0;padding:0;background:#081421}
.post-media.has-media img,.post-media.has-media video{width:100%;max-height:520px;object-fit:contain;display:block;background:#071421}
.post-media.no-url{height:auto;min-height:96px;display:flex;align-items:center;justify-content:center;text-align:center;color:#dff7ff;background:linear-gradient(135deg,rgba(104,244,184,.16),rgba(105,169,255,.13)),#102033;padding:24px}
.post-media.empty{display:none}
.post-text a{color:#87f5d0;text-decoration:underline;text-underline-offset:3px;font-weight:850}
.post-text{font-size:16px;color:#d9edf7;line-height:1.48}
@media(max-width:720px){.lr-promo{grid-template-columns:auto 1fr}.lr-promo-btn{grid-column:1/-1;width:100%}}

.toolbar{display:flex;gap:10px;flex-wrap:wrap;position:relative;z-index:2;margin-top:16px}
.tab{border:1px solid var(--line);background:rgba(255,255,255,.08);color:var(--text);padding:11px 14px;border-radius:16px;font-weight:850;font-size:14px;cursor:pointer}
.tab.active{background:linear-gradient(135deg,rgba(104,244,184,.27),rgba(105,169,255,.18));border-color:rgba(104,244,184,.36)}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}
.stat{border:1px solid var(--line);border-radius:24px;padding:17px;background:linear-gradient(135deg,rgba(255,255,255,.10),rgba(255,255,255,.055));position:relative;overflow:hidden}
.stat:after{content:"";position:absolute;right:-28px;bottom:-32px;width:90px;height:90px;border-radius:999px;background:rgba(104,244,184,.09)}
.k{color:var(--muted);font-size:13px;font-weight:750}
.v{margin-top:7px;font-size:30px;font-weight:950;letter-spacing:-.5px}
.trend{margin-top:6px;color:#a8ffe0;font-size:13px;font-weight:850}
.layout{display:grid;grid-template-columns:1.08fr .92fr;gap:14px;margin-top:14px}
.panel{border:1px solid var(--line);border-radius:26px;padding:18px;background:rgba(255,255,255,.075);backdrop-filter:blur(12px);box-shadow:0 16px 50px rgba(0,0,0,.18)}
.panel h2{margin:0 0 13px;font-size:21px}
.view{display:none}
.view.active{display:block}
.post-card{border:1px solid rgba(255,255,255,.13);border-radius:22px;overflow:hidden;background:rgba(0,0,0,.22)}
.post-media{height:176px;background:linear-gradient(135deg,rgba(104,244,184,.22),rgba(105,169,255,.17)),linear-gradient(120deg,#1a3550,#0f1d2c);display:flex;align-items:flex-end;padding:14px;color:#eaffff;font-weight:900;font-size:18px}
.post-body{padding:16px}
.post-title{font-size:20px;font-weight:950;line-height:1.2;margin-bottom:10px}
.post-text{color:#cfe0ea;line-height:1.45;white-space:pre-line}
.post-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.post-btn{padding:10px 13px;border-radius:14px;color:var(--text);background:linear-gradient(135deg,rgba(104,244,184,.24),rgba(105,169,255,.20));border:1px solid rgba(104,244,184,.28);font-weight:850}
.state-row{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-top:10px}
.state{border:1px solid var(--line);border-radius:18px;padding:12px;background:rgba(255,255,255,.06);display:flex;gap:9px;align-items:center;color:#d9eef6;font-weight:850}
.dot{width:12px;height:12px;border-radius:999px;background:var(--muted);box-shadow:0 0 18px currentColor;flex:0 0 auto}
.state.active .dot{background:var(--green)}
.state.done .dot{background:var(--blue)}
.state.end .dot{background:var(--orange)}
.state.deleted .dot{background:var(--red)}
.mini-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.mini{border:1px solid var(--line);border-radius:20px;padding:14px;background:rgba(255,255,255,.06)}
.mini b{display:block;font-size:23px;margin-top:5px}
.chart{height:230px;border-radius:22px;border:1px solid var(--line);background:linear-gradient(to top,rgba(255,255,255,.05) 1px,transparent 1px) 0 0/100% 25%,rgba(0,0,0,.16);padding:18px 14px 12px;display:flex;align-items:end;gap:9px}
.bar{flex:1;min-width:12px;border-radius:13px 13px 6px 6px;background:linear-gradient(180deg,var(--green),var(--blue));position:relative}
.bar span{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);font-size:11px;color:#c8e7f0;margin-bottom:5px}
.channel-cards{display:grid;gap:10px}
.channel-card{display:grid;grid-template-columns:2fr repeat(4,minmax(78px,1fr));gap:10px;align-items:center;padding:14px;border:1px solid var(--line);border-radius:20px;background:rgba(255,255,255,.055)}
.channel{display:flex;align-items:center;gap:10px;min-width:0}
.avatar{width:38px;height:38px;border-radius:13px;background:linear-gradient(135deg,var(--green),var(--blue));display:grid;place-items:center;color:#06131f;font-weight:950;flex:0 0 auto}
.channel-name{font-weight:950;line-height:1.15;overflow:hidden;text-overflow:ellipsis}
.cell-label{display:none;color:var(--muted);font-size:12px;font-weight:850}
.metric strong{display:block;font-size:17px}
.metric span{color:var(--muted);font-size:12px;font-weight:800}
table{width:100%;border-collapse:collapse}
th,td{border-bottom:1px solid var(--line);padding:12px 10px;text-align:left;font-size:14px;vertical-align:middle}
th{color:var(--muted);font-weight:850}
td strong{font-weight:950}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.filter{padding:9px 11px;border-radius:13px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--text);cursor:pointer;font-weight:850}
.filter.active{border-color:rgba(104,244,184,.34);background:rgba(104,244,184,.14)}
.form{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
label{display:block;color:var(--muted);font-size:13px;font-weight:800;margin-bottom:6px}
input{width:100%;border:1px solid var(--line);background:rgba(0,0,0,.20);color:var(--text);border-radius:14px;padding:12px;outline:none;font-weight:800}
.notice{border:1px solid rgba(255,209,102,.28);background:rgba(255,209,102,.10);border-radius:18px;padding:13px;color:#ffe6a7;line-height:1.45}
.insights{display:grid;gap:10px}
.insight{border:1px solid var(--line);background:rgba(255,255,255,.06);border-radius:18px;padding:13px;color:#dceef6;line-height:1.4}
.footer{color:var(--muted);text-align:center;font-size:13px;margin-top:18px}
@media(max-width:900px){
.top{align-items:flex-start;flex-direction:column}
.grid{grid-template-columns:repeat(2,1fr)}
.layout{grid-template-columns:1fr}
.logo{width:66px;height:66px;border-radius:21px}
.hero{border-radius:24px;padding:17px}
.panel{border-radius:22px;padding:15px}
.v{font-size:25px}
.chart{height:190px;gap:6px}
.form{grid-template-columns:1fr}
.state-row{grid-template-columns:1fr 1fr}
.channel-card{grid-template-columns:1fr 1fr}
.channel{grid-column:1/-1}
.cell-label{display:block}
}
@media(max-width:420px){
.wrap{padding:9px 8px 28px}
.grid{gap:9px}
.stat{padding:13px;border-radius:19px}
.tab{padding:10px 12px}
.mini-grid{grid-template-columns:1fr}
.state-row{grid-template-columns:1fr}
.channel-card{grid-template-columns:1fr 1fr;gap:12px}
.metric strong{font-size:16px}
}
</style>
</head>
<body>
<div class="wrap">
<section class="hero">
<div class="top">
<div class="brand">
<img class="logo" id="logo" alt="LinkRay">
<div>
<div class="brand-title">LinkRay Analytics</div>
<div class="brand-sub">Живой отчёт рекламного размещения в MAX</div>
</div>
</div>
<div class="status">
<button class="pill" id="copyLinkBtn">🔗 Скопировать отчёт</button>
<button class="pill blue" id="refreshBtn">🔄 Обновить</button>
</div>
</div>
<h1 id="reportTitle"></h1>
<p class="lead">Отчёт обновляется автоматически: статус поста, текст, кнопки, время удаления, просмотры MAX, клики кнопок и CPM берутся из актуальных данных.</p>
<div class="toolbar">
<button class="tab active" data-view="overview">Обзор</button>
<button class="tab" data-view="channels">Каналы</button>
<button class="tab" data-view="buttons">Кнопки</button>
<button class="tab" data-view="cpm">CPM</button>
<button class="tab" data-view="history">История</button>
<button class="tab" data-view="recommendations">Выводы</button>
</div>
<div class="state-row" id="stateRow"></div>
<div class="grid" id="topStats"></div>
</section>

<main id="overview" class="view active">
<div class="layout">
<section class="panel">
<h2>📝 Актуальная версия поста</h2>
<div class="post-card">
<div class="post-media" id="postMedia"></div>
<div class="post-body">
<div class="post-title" id="postTitle"></div>
<div class="post-text" id="postText"></div>
<div class="post-btns" id="postButtons"></div>
</div>
</div>
</section>
<section class="panel">
<h2>⚡ Быстрые показатели</h2>
<div class="mini-grid" id="quickStats"></div>
</section>
</div>
<section class="panel">
<h2>📈 Динамика просмотров MAX</h2>
<div class="filters">
<button class="filter active" data-period="1h">1 час</button>
<button class="filter" data-period="24h">24 часа</button>
<button class="filter" data-period="48h">48 часов</button>
</div>
<div class="chart" id="chart"></div>
</section>
</main>

<main id="channels" class="view">
<section class="panel">
<h2>📌 Публикации по каналам</h2>
<div class="channel-cards" id="channelRows"></div>
</section>
</main>

<main id="buttons" class="view">
<section class="panel">
<h2>🔘 Клики только по кнопкам</h2>
<p class="lead">Ссылки в тексте не считаются. Уникальный клик: один пользователь по одной кнопке засчитывается один раз.</p>
<table>
<thead><tr><th>Кнопка</th><th>Уникальные</th><th>Все</th><th>Повторы</th><th>Доля</th></tr></thead>
<tbody id="buttonRows"></tbody>
</table>
</section>
</main>

<main id="cpm" class="view">
<section class="panel">
<h2>💰 Расчёт стоимости по CPM</h2>
<div class="form">
<div><label for="viewsInput">Просмотры MAX</label><input id="viewsInput" type="number" min="0"></div>
<div><label for="cpmInput">CPM, ₽</label><input id="cpmInput" type="number" min="0"></div>
<div><label for="priceInput">Стоимость, ₽</label><input id="priceInput" type="text" disabled></div>
</div>
<div style="height:12px"></div>
<div class="notice">Формула: <b>стоимость = просмотры MAX / 1000 × CPM</b>. Клики показывают эффективность, но цену считаем только по просмотрам.</div>
</section>
</main>

<main id="history" class="view">
<section class="panel">
<h2>🕓 Живая история отчёта</h2>
<table>
<thead><tr><th>Время</th><th>Событие</th><th>Что обновилось</th></tr></thead>
<tbody id="historyRows"></tbody>
</table>
</section>
</main>

<main id="recommendations" class="view">
<section class="panel">
<h2>🧠 Умные выводы LinkRay</h2>
<div class="insights" id="insights"></div>
</section>
</main>

<div class="footer">LinkRay Analytics · автообновление каждые 15 секунд</div>
</div>

<script>
let REPORT = ${payload};
let PERIOD = '1h';
const fmt = new Intl.NumberFormat('ru-RU');

function html(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function totalViews() { return Number(REPORT.metrics.totalViews || 0); }
function uniqueClicks() { return Number(REPORT.metrics.uniqueClicks || 0); }
function totalClicks() { return Number(REPORT.metrics.totalButtonClicks || 0); }
function cost() { return Number(REPORT.metrics.cost || 0); }
function ctr() { return Number(REPORT.metrics.ctr || 0).toFixed(2); }

function statusText(s) {
  return {
    scheduled: '⏳ Отложен пост',
    published: '✅ Опубликован',
    ended: '🏁 Реклама закончилась',
    deleted: '🗑️ Удалён',
  }[s] || '📌 Статус';
}

function renderState() {
  const states = [['scheduled','⏳ Отложен'],['published','✅ Опубликован'],['ended','🏁 Закончилась'],['deleted','🗑️ Удалён']];
  const order = states.map(x => x[0]);
  const idx = order.indexOf(REPORT.status);

  document.getElementById('stateRow').innerHTML = states.map(([key, label], i) => {
    const cls = key === REPORT.status ? 'active' : (i < idx ? 'done' : (key === 'ended' && REPORT.status === 'ended' ? 'end' : (key === 'deleted' && REPORT.status === 'deleted' ? 'deleted' : '')));
    return \`<div class="state \${cls}"><span class="dot"></span><span>\${label}</span></div>\`;
  }).join('');
}

function renderStats() {
  document.getElementById('topStats').innerHTML = \`
    <div class="stat"><div class="k">Просмотры MAX</div><div class="v">\${fmt.format(totalViews())}</div><div class="trend">из каналов</div></div>
    <div class="stat"><div class="k">Уникальные клики кнопок</div><div class="v">\${fmt.format(uniqueClicks())}</div><div class="trend">1 человек = 1 клик</div></div>
    <div class="stat"><div class="k">CTR по кнопкам</div><div class="v">\${ctr()}%</div><div class="trend">клики / просмотры</div></div>
    <div class="stat"><div class="k">Стоимость по CPM</div><div class="v">\${fmt.format(cost())}₽</div><div class="trend">CPM \${fmt.format(Number(REPORT.metrics.cpm || 0))}₽</div></div>
  \`;
}

function renderPost() {
  const logoEl = document.getElementById('logo');
  if (logoEl) logoEl.src = REPORT.logo;

  const promoLogo = document.getElementById('promoLogo');
  if (promoLogo) promoLogo.src = REPORT.logo;

  document.getElementById('reportTitle').textContent = REPORT.title || 'LinkRay Analytics';
  document.getElementById('postTitle').textContent = REPORT.post.title || 'Рекламный пост';

  const textBox = document.getElementById('postText');
  const postHtml = REPORT.post.textHtml || html(REPORT.post.text || '').replace(/\n/g, '<br>');
  textBox.innerHTML = postHtml || '<span style="color:#9eb7c9">Текст поста пока недоступен</span>';

  const mediaBox = document.getElementById('postMedia');
  const media = REPORT.post.mediaInfo || {};
  mediaBox.classList.remove('has-media', 'no-url', 'empty');
  mediaBox.innerHTML = '';

  if (media.url) {
    mediaBox.classList.add('has-media');

    if (media.kind === 'video') {
      const video = document.createElement('video');
      video.src = media.url;
      video.controls = true;
      video.muted = true;
      video.playsInline = true;
      video.onerror = () => {
        mediaBox.classList.remove('has-media');
        mediaBox.classList.add('no-url');
        mediaBox.innerHTML = '<div>🖼️ Медиа поста есть<br><small>MAX не отдал публичный доступ к файлу</small></div>';
      };
      mediaBox.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = media.url;
      img.alt = 'Медиа поста';
      img.onerror = () => {
        mediaBox.classList.remove('has-media');
        mediaBox.classList.add('no-url');
        mediaBox.innerHTML = '<div>🖼️ Медиа поста есть<br><small>MAX не отдал публичный доступ к файлу</small></div>';
      };
      mediaBox.appendChild(img);
    }
  } else if ((REPORT.post.media || '').toLowerCase().includes('медиа')) {
    mediaBox.classList.add('no-url');
    mediaBox.innerHTML = '<div>🖼️ Медиа поста есть<br><small>Пока нет публичной ссылки MAX для показа в веб-отчёте</small></div>';
  } else {
    mediaBox.classList.add('empty');
  }

  document.getElementById('postButtons').innerHTML = (REPORT.post.buttons || [])
    .map(b => '<button class="post-btn" type="button">' + html(b.title || 'Кнопка') + '</button>')
    .join('');
}

function renderQuick() {
  const repeat = Math.max(0, totalClicks() - uniqueClicks());

  document.getElementById('quickStats').innerHTML = \`
    <div class="mini"><span class="k">Статус</span><b>\${statusText(REPORT.status)}</b><span class="sub">обновляется</span></div>
    <div class="mini"><span class="k">Удаление</span><b>\${html(REPORT.metrics.autoDelete || '—')}</b><span class="sub">актуальное время</span></div>
    <div class="mini"><span class="k">Цена</span><b>\${fmt.format(cost())}₽</b><span class="sub">по CPM</span></div>
    <div class="mini"><span class="k">Повторы кликов</span><b>\${fmt.format(repeat)}</b><span class="sub">не входят в уникальные</span></div>
  \`;
}

function renderChart() {
  const arr = (REPORT.viewsByPeriod && REPORT.viewsByPeriod[PERIOD]) || [];
  const max = Math.max(...arr, 1);

  document.getElementById('chart').innerHTML = arr.map(v => {
    const h = Math.max(8, Math.round(Number(v) / max * 100));
    return \`<div class="bar" style="height:\${h}%"><span>\${fmt.format(Number(v))}</span></div>\`;
  }).join('');
}

function renderChannels() {
  document.getElementById('channelRows').innerHTML = (REPORT.channels || []).map(c => {
    const views = Number(c.views || 0);
    const clicks = Number(c.buttonClicks || 0);
    const channelCtr = views ? (clicks / views * 100).toFixed(2) : '0.00';

    return \`
      <div class="channel-card">
        <div class="channel"><div class="avatar">\${html((c.name || 'К')[0])}</div><div class="channel-name">\${html(c.name || 'Канал')}</div></div>
        <div class="metric"><span class="cell-label">Просмотры MAX</span><strong>\${fmt.format(views)}</strong></div>
        <div class="metric"><span class="cell-label">Клики кнопок</span><strong>\${fmt.format(clicks)}</strong></div>
        <div class="metric"><span class="cell-label">CTR</span><strong>\${channelCtr}%</strong></div>
        <div class="metric"><span class="cell-label">Стоимость</span><strong>\${fmt.format(Number(c.cost || 0))}₽</strong></div>
      </div>
    \`;
  }).join('');
}

function renderButtons() {
  const buttons = REPORT.buttons || [];
  const all = uniqueClicks();

  document.getElementById('buttonRows').innerHTML = buttons.map(b => {
    const u = Number(b.unique || 0);
    const t = Number(b.total || 0);
    const repeat = Math.max(0, t - u);
    const share = all ? (u / all * 100).toFixed(1) : '0.0';

    return \`<tr><td><strong>\${html(b.title || 'Кнопка')}</strong></td><td>\${fmt.format(u)}</td><td>\${fmt.format(t)}</td><td>\${fmt.format(repeat)}</td><td>\${share}%</td></tr>\`;
  }).join('') || '<tr><td colspan="5">Кликов по кнопкам пока нет</td></tr>';
}

function renderCpm() {
  const views = document.getElementById('viewsInput');
  const cpm = document.getElementById('cpmInput');
  const price = document.getElementById('priceInput');

  views.value = totalViews();
  cpm.value = Number(REPORT.metrics.cpm || 0);
  price.value = fmt.format(cost()) + ' ₽';

  const calc = () => {
    price.value = fmt.format(Math.round(Number(views.value || 0) / 1000 * Number(cpm.value || 0))) + ' ₽';
  };

  views.oninput = calc;
  cpm.oninput = calc;
}

function renderHistory() {
  document.getElementById('historyRows').innerHTML = (REPORT.history || []).map(h => \`<tr><td><strong>\${html(h.time || '')}</strong></td><td>\${html(h.event || '')}</td><td>\${html(h.detail || '')}</td></tr>\`).join('') || '<tr><td colspan="3">Истории пока нет</td></tr>';
}

function renderInsights() {
  const channels = (REPORT.channels || []).filter(c => Number(c.views || 0) > 0);
  const best = channels.slice().sort((a, b) => Number(b.buttonClicks || 0) / Number(b.views || 1) - Number(a.buttonClicks || 0) / Number(a.views || 1))[0];
  const worst = channels.slice().sort((a, b) => Number(a.buttonClicks || 0) / Number(a.views || 1) - Number(b.buttonClicks || 0) / Number(b.views || 1))[0];

  document.getElementById('insights').innerHTML = \`
    <div class="insight">🔥 Лучший канал по CTR кнопок: <b>\${best ? html(best.name) : '—'}</b>.</div>
    <div class="insight">⚠️ Самый слабый отклик: <b>\${worst ? html(worst.name) : '—'}</b>.</div>
    <div class="insight">🛡️ После отложения кликов должно быть 0. Клики появляются только после реального нажатия по кнопке.</div>
    <div class="insight">♻️ Если пост отредактирован, отчёт показывает новую версию текста, кнопок, ссылок, CPM и автоудаления.</div>
  \`;
}

function renderAll() {
  renderState();
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

function showView(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === id));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
}

async function refreshLive(silent = false) {
  try {
    const response = await fetch(location.pathname + '?json=1&ts=' + Date.now(), { cache: 'no-store' });
    REPORT = await response.json();
    renderAll();
    if (!silent) alert('Отчёт обновлён');
  } catch {
    if (!silent) alert('Не удалось обновить отчёт');
  }
}

document.querySelectorAll('.tab').forEach(btn => btn.onclick = () => showView(btn.dataset.view));
document.querySelectorAll('[data-period]').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('[data-period]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    PERIOD = btn.dataset.period;
    renderChart();
  };
});

document.getElementById('copyLinkBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); } catch {}
  alert('Ссылка отчёта скопирована');
};

document.getElementById('refreshBtn').onclick = () => refreshLive(false);

renderAll();
setInterval(() => refreshLive(true), 15000);
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

      if (!isPreviewRequest(req)) {
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
      }

      res.setHeader('Cache-Control', 'no-store');
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
      return res.status(500).send(`LinkRay report error: ${esc(error.message || error)}`);
    }
  });
}
