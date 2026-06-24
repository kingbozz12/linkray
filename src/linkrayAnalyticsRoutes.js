import crypto from 'node:crypto';
import { query } from './db.js';

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.SITE_URL || process.env.WEBAPP_URL || 'https://linkray.ru').replace(/\/$/, '');

const LOGO_DATA_URI = 'data:image/webp;base64,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';

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(v) {
  return escapeHtml(v).replace(/'/g, '&#39;');
}

function plain(v) {
  return String(v || '')
    .replace(/<a\b[^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(b|strong|i|em|u|s|strike|code|pre|span|p|div|h1|h2|h3)[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function short(v, max = 110) {
  const s = plain(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function safeJson(value, fallback = {}) {
  try {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function formatAutoDelete(minutes) {
  if (!minutes) return 'без удаления';
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return 'без удаления';
  if (n % 1440 === 0) return `${n / 1440}д`;
  if (n % 60 === 0) return `${n / 60}ч`;
  return `${n} мин`;
}

async function ensureAnalyticsSchema() {
  await query(`CREATE TABLE IF NOT EXISTS analytics_links (
    token text PRIMARY KEY,
    campaign_id text NOT NULL,
    post_id integer,
    channel_id integer,
    label text,
    target_url text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

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

  await query(`CREATE INDEX IF NOT EXISTS idx_lr_clicks_campaign ON analytics_clicks(campaign_id, clicked_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_lr_links_campaign ON analytics_links(campaign_id)`);
}

function fingerprint(req, token) {
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '').split(',')[0].trim();
  const ua = String(req.headers['user-agent'] || '');
  return {
    ipHash: sha256Hex(ip).slice(0, 32),
    userAgent: ua.slice(0, 420),
    fingerprint: sha256Hex(`${token}|${ip}|${ua}`).slice(0, 48),
  };
}

export function mountLinkRayAnalyticsRoutes(app) {
  app.get('/r/:token', async (req, res) => {
    try {
      await ensureAnalyticsSchema();

      const token = String(req.params.token || '').trim();
      const rows = await query('SELECT * FROM analytics_links WHERE token=$1 LIMIT 1', [token]);
      const link = rows[0];

      if (!link) return res.status(404).send('LinkRay: ссылка не найдена');

      const fp = fingerprint(req, token);

      await query(
        `INSERT INTO analytics_clicks(token,campaign_id,post_id,channel_id,fingerprint,ip_hash,user_agent,clicked_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT(token, fingerprint) DO NOTHING`,
        [token, link.campaign_id, link.post_id, link.channel_id, fp.fingerprint, fp.ipHash, fp.userAgent]
      );

      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, link.target_url);
    } catch (e) {
      console.error('[linkray analytics redirect]', e.message || e);
      res.status(500).send('LinkRay redirect error');
    }
  });

  app.get('/analytics/stats/:groupId', async (req, res) => {
    try {
      await ensureAnalyticsSchema();

      const groupId = String(req.params.groupId || '').trim();

      const posts = await query(
        `SELECT sp.*, c.title AS channel_title, c.link AS channel_link
         FROM scheduled_posts sp
         LEFT JOIN channels c ON c.id = sp.channel_id
         WHERE COALESCE(sp.report_group_id, sp.id::text) = $1
         ORDER BY sp.id ASC`,
        [groupId]
      );

      const links = await query(
        `SELECT l.*,
                COUNT(c.id)::int AS total_clicks,
                COUNT(DISTINCT c.fingerprint)::int AS unique_clicks
         FROM analytics_links l
         LEFT JOIN analytics_clicks c ON c.token = l.token
         WHERE l.campaign_id = $1
         GROUP BY l.token
         ORDER BY l.created_at ASC`,
        [groupId]
      );

      const first = posts[0] || {};
      const snap = safeJson(first.report_snapshot, {});
      const postText = first.text || snap.title || 'Рекламный пост';
      const title = escapeHtml(short(postText, 95));

      const totalViews = Number(snap.totalViews || 0);
      const totalClicks = links.reduce((a, l) => a + Number(l.total_clicks || 0), 0);
      const uniqueClicks = links.reduce((a, l) => a + Number(l.unique_clicks || 0), 0);
      const ctr = totalViews ? ((uniqueClicks / totalViews) * 100).toFixed(2) : '—';
      const cpm = Number(first.cpm || snap.cpm || 0);
      const cost = totalViews && cpm ? Math.round((totalViews / 1000) * cpm) : null;

      const channelRows = posts.map((p, i) => {
        const channel = escapeHtml(p.channel_title || 'Канал');
        const rowSnap = safeJson(p.report_snapshot, {});
        const views = rowSnap.views ?? '—';

        return `<tr>
          <td>${i + 1}</td>
          <td>${p.channel_link ? `<a href="${attr(p.channel_link)}">${channel}</a>` : channel}</td>
          <td>${escapeHtml(p.status || '')}</td>
          <td>${escapeHtml(String(views))}</td>
          <td>${escapeHtml(formatAutoDelete(p.auto_delete_minutes))}</td>
        </tr>`;
      }).join('');

      const linkRows = links.map((l, i) => {
        return `<tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(l.label || 'ссылка')}</td>
          <td>${Number(l.unique_clicks || 0)}</td>
          <td>${Number(l.total_clicks || 0)}</td>
          <td><a href="${attr(l.target_url)}" target="_blank" rel="noopener">цель</a></td>
        </tr>`;
      }).join('');

      const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>LinkRay Analytics</title>
<style>
:root{
  --bg:#06131f;--card:rgba(255,255,255,.09);--card2:rgba(255,255,255,.14);
  --text:#eaffff;--muted:#9fb7c8;--green:#67f3b7;--blue:#68a8ff;--line:rgba(255,255,255,.16)
}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--text);background:
radial-gradient(circle at 20% 0%,rgba(103,243,183,.28),transparent 32%),
radial-gradient(circle at 80% 10%,rgba(104,168,255,.25),transparent 32%),
linear-gradient(135deg,#06131f,#0b1728 50%,#111a2c)}
.wrap{max-width:1140px;margin:0 auto;padding:18px 12px 42px}
.hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:30px;padding:24px;background:linear-gradient(135deg,rgba(255,255,255,.13),rgba(255,255,255,.055));box-shadow:0 24px 90px rgba(0,0,0,.32)}
.top{display:flex;gap:18px;align-items:center}
.logo{width:92px;height:92px;border-radius:28px;object-fit:cover;box-shadow:0 16px 45px rgba(103,243,183,.28)}
.badge{display:inline-flex;gap:8px;align-items:center;padding:9px 13px;border-radius:999px;background:rgba(103,243,183,.13);border:1px solid rgba(103,243,183,.24);color:#b9ffe0;font-weight:800}
h1{font-size:clamp(29px,5.2vw,56px);line-height:1.02;margin:18px 0 8px}
.sub{color:var(--muted);line-height:1.55;font-size:16px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}
.stat{border:1px solid var(--line);border-radius:22px;background:var(--card);padding:16px}
.k{color:var(--muted);font-size:13px}.v{font-size:28px;font-weight:900;margin-top:6px}
.panel{border:1px solid var(--line);border-radius:24px;background:rgba(255,255,255,.075);padding:18px;margin-top:14px}
h2{margin:0 0 12px;font-size:20px}
.preview{white-space:pre-wrap;color:#defbff;line-height:1.48;background:rgba(0,0,0,.20);border-radius:18px;padding:14px;max-height:280px;overflow:auto}
table{width:100%;border-collapse:collapse}
td,th{border-bottom:1px solid var(--line);padding:12px 10px;text-align:left;font-size:14px}
th{color:var(--muted);font-weight:750}
a{color:#78ffd0;text-decoration:none}a:hover{text-decoration:underline}
.footer{color:var(--muted);font-size:13px;text-align:center;margin-top:18px}
@media(max-width:760px){.wrap{padding:10px 8px 30px}.hero{border-radius:22px;padding:16px}.top{align-items:flex-start}.logo{width:70px;height:70px;border-radius:21px}.grid{grid-template-columns:repeat(2,1fr)}.stat{padding:13px}.v{font-size:23px}td,th{font-size:13px;padding:10px 6px}}
</style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <div class="top">
      <img class="logo" src="${LOGO_DATA_URI}" alt="LinkRay">
      <div>
        <div class="badge">🧬 LinkRay Analytics</div>
        <div class="sub">Красивый сводный отчёт по рекламному размещению в MAX</div>
      </div>
    </div>
    <h1>${title}</h1>
    <p class="sub">Пост, каналы, просмотры, уникальные клики, все переходы, CTR, CPM и автоудаление собраны в одном адаптивном отчёте.</p>
    <div class="grid">
      <div class="stat"><div class="k">Публикации</div><div class="v">${posts.length}</div></div>
      <div class="stat"><div class="k">Просмотры</div><div class="v">${totalViews || '—'}</div></div>
      <div class="stat"><div class="k">Уникальные клики</div><div class="v">${uniqueClicks}</div></div>
      <div class="stat"><div class="k">CTR</div><div class="v">${ctr}${ctr === '—' ? '' : '%'}</div></div>
    </div>
  </section>

  <section class="panel">
    <h2>📝 Пост</h2>
    <div class="preview">${escapeHtml(plain(postText)) || 'Текст поста недоступен'}</div>
  </section>

  <section class="panel">
    <h2>📊 Итоги</h2>
    <div class="grid">
      <div class="stat"><div class="k">Все клики</div><div class="v">${totalClicks}</div></div>
      <div class="stat"><div class="k">CPM</div><div class="v">${cpm || '—'}</div></div>
      <div class="stat"><div class="k">Стоимость</div><div class="v">${cost === null ? '—' : `${cost} ₽`}</div></div>
      <div class="stat"><div class="k">Автоудаление</div><div class="v">${escapeHtml(formatAutoDelete(first.auto_delete_minutes))}</div></div>
    </div>
  </section>

  <section class="panel">
    <h2>📌 Публикации по каналам</h2>
    <table>
      <thead><tr><th>#</th><th>Канал</th><th>Статус</th><th>Просмотры</th><th>Удаление</th></tr></thead>
      <tbody>${channelRows || '<tr><td colspan="5">Публикаций пока нет</td></tr>'}</tbody>
    </table>
  </section>

  <section class="panel">
    <h2>🔗 Переходы по ссылкам и кнопкам</h2>
    <table>
      <thead><tr><th>#</th><th>Элемент</th><th>Уникальные</th><th>Все</th><th>Цель</th></tr></thead>
      <tbody>${linkRows || '<tr><td colspan="5">Переходов пока нет</td></tr>'}</tbody>
    </table>
  </section>

  <div class="footer">Сформировано LinkRay · ${escapeHtml(new Date().toLocaleString('ru-RU'))}</div>
</div>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } catch (e) {
      console.error('[linkray analytics page]', e.message || e);
      res.status(500).send(`LinkRay report error: ${escapeHtml(e.message || e)}`);
    }
  });
}
