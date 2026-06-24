import { query } from './db.js';
import { sendMaxMessage, deleteMaxMessage, getMaxMessage, inlineKeyboard, linkButton } from './maxClient.js';

let started = false;

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.SITE_URL || process.env.WEBAPP_URL || 'https://linkray.ru').replace(/\/$/, '');
const BOT_LINK = process.env.BOT_LINK || 'https://max.ru/se13353901_bot';

function safeJson(value, fallback = []) {
  try {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function reportUrl(groupId) {
  return `${PUBLIC_BASE_URL}/analytics/stats/${encodeURIComponent(String(groupId || ''))}`;
}

function escapeHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plain(v) {
  return String(v || '')
    .replace(/<a\s+[^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')
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

function short(v, max = 64) {
  const s = plain(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function formatAutoDelete(minutes) {
  if (!minutes) return 'без удаления';
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return 'без удаления';
  if (n % 1440 === 0) return `${n / 1440}д`;
  if (n % 60 === 0) return `${n / 60}ч`;
  return `${n} мин`;
}

function normalizeAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const type = String(a.type || a.attachment_type || a.attachmentType || '').toLowerCase();
  const p = a.payload && typeof a.payload === 'object' ? a.payload : {};

  if (type === 'inline_keyboard') return a;
  if (type.includes('image') || type.includes('photo')) {
    if (p.token) return { type: 'image', payload: { token: p.token } };
    if (a.token) return { type: 'image', payload: { token: a.token } };
    if (Array.isArray(p.photos)) return { type: 'image', payload: { photos: p.photos } };
  }
  if (type.includes('video')) {
    if (p.token) return { type: 'video', payload: { token: p.token } };
    if (a.token) return { type: 'video', payload: { token: a.token } };
  }
  if (type.includes('file')) {
    if (p.token) return { type: 'file', payload: { token: p.token } };
    if (a.token) return { type: 'file', payload: { token: a.token } };
  }
  return null;
}

function normalizeAttachments(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const n = normalizeAttachment(item);
    if (!n) continue;
    const k = JSON.stringify(n);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function callbackLinkButton(text, url) {
  return { type: 'link', text: String(text), url: String(url) };
}

function keyboardAttachmentFromButtons(buttons = []) {
  const rows = [];
  for (const row of buttons || []) {
    const out = [];
    const items = Array.isArray(row) ? row : [row];
    for (const b of items) {
      const text = String(b?.text || b?.title || '').trim();
      const url = String(b?.url || b?.link || '').trim();
      if (text && /^https?:\/\//i.test(url)) out.push(linkButton(text, url));
    }
    if (out.length) rows.push(out);
  }
  return rows.length ? inlineKeyboard(rows)[0] : null;
}

function finalAttachments(post) {
  const out = normalizeAttachments(safeJson(post.attachments, []));
  const kb = keyboardAttachmentFromButtons(safeJson(post.buttons, []));
  if (kb) out.push(kb);
  return out;
}

function extractMessageId(res) {
  return res?.message?.body?.mid || res?.message?.id || res?.message_id || res?.messageId || res?.id || res?.mid || null;
}

function findNumberByKeys(obj, keys) {
  const seen = new Set();
  const wanted = new Set(keys.map((k) => String(k).toLowerCase()));
  const scan = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = scan(item);
        if (found !== null) return found;
      }
      return null;
    }
    for (const [k, val] of Object.entries(v)) {
      if (wanted.has(String(k).toLowerCase())) {
        const n = Number(val);
        if (Number.isFinite(n)) return n;
      }
    }
    for (const val of Object.values(v)) {
      const found = scan(val);
      if (found !== null) return found;
    }
    return null;
  };
  return scan(obj);
}

async function getViewsForPost(post) {
  if (!post.published_message_id) return null;
  try {
    const data = await getMaxMessage(post.published_message_id, { chatId: post.max_chat_id });
    return findNumberByKeys(data, ['views', 'view_count', 'views_count', 'viewCount', 'seen', 'reach']);
  } catch (error) {
    console.error('[autopost] get views failed:', post.id, error.message || error);
    return null;
  }
}

async function publishDue() {
  const posts = await query(`
    SELECT sp.*, c.max_chat_id, c.title AS channel_title
    FROM scheduled_posts sp
    JOIN channels c ON c.id = sp.channel_id
    WHERE sp.status::text = 'scheduled' AND sp.publish_at <= now()
    ORDER BY sp.publish_at ASC, sp.id ASC
    LIMIT 10
  `);

  for (const post of posts) {
    try {
      await query(`UPDATE scheduled_posts SET status='publishing', updated_at=now() WHERE id=$1 AND status::text='scheduled'`, [post.id]);

      const sent = await sendMaxMessage({
        chatId: post.max_chat_id,
        text: post.text || '',
        format: post.format || 'html',
        attachments: finalAttachments(post),
      });

      await query(`
        UPDATE scheduled_posts
        SET status='published', published_at=now(), published_message_id=$2, error_message=NULL, updated_at=now()
        WHERE id=$1
      `, [post.id, extractMessageId(sent)]);

      console.log('[autopost] published', JSON.stringify({ id: post.id, channel: post.channel_title }));
    } catch (error) {
      console.error('[autopost] publish failed:', post.id, error.message || error);
      await query(`UPDATE scheduled_posts SET status='error', error_message=$2, updated_at=now() WHERE id=$1`, [post.id, String(error.message || error)]).catch(() => {});
    }
  }
}

async function deleteExpired() {
  const posts = await query(`
    SELECT id, published_message_id, auto_delete_minutes
    FROM scheduled_posts
    WHERE status::text='published'
      AND auto_deleted_at IS NULL
      AND published_message_id IS NOT NULL
      AND auto_delete_minutes IS NOT NULL
      AND auto_delete_minutes > 0
      AND published_at IS NOT NULL
      AND published_at + (auto_delete_minutes || ' minutes')::interval <= now()
    ORDER BY published_at ASC
    LIMIT 20
  `);

  for (const post of posts) {
    try {
      await deleteMaxMessage(post.published_message_id);
      await query(`UPDATE scheduled_posts SET status='canceled', auto_deleted_at=now(), auto_delete_error_message=NULL, updated_at=now() WHERE id=$1`, [post.id]);
      console.log('[autopost] auto deleted', JSON.stringify({ id: post.id, afterMinutes: post.auto_delete_minutes }));
    } catch (error) {
      console.error('[autopost] auto delete failed:', post.id, error.message || error);
      await query(`UPDATE scheduled_posts SET auto_delete_error_message=$2, updated_at=now() WHERE id=$1`, [post.id, String(error.message || error)]).catch(() => {});
    }
  }
}


async function getClicksForGroup(groupId) {
  try {
    const rows = await query(
      `SELECT
         COUNT(*)::int AS total_clicks,
         COUNT(DISTINCT fingerprint)::int AS unique_clicks
       FROM analytics_clicks
       WHERE campaign_id = $1`,
      [String(groupId)]
    );

    return {
      totalClicks: Number(rows[0]?.total_clicks || 0),
      uniqueClicks: Number(rows[0]?.unique_clicks || 0),
    };
  } catch (e) {
    console.error('[autopost] clicks unavailable:', e.message || e);
    return { totalClicks: 0, uniqueClicks: 0 };
  }
}

async function sendDueReports() {
  const groups = await query(`
    SELECT
      COALESCE(report_group_id, id::text) AS group_id,
      created_by_max_user_id,
      MIN(text) AS text,
      MIN(published_at) AS published_at,
      MAX(report_after_hours) AS report_after_hours,
      MAX(cpm) AS cpm,
      MAX(auto_delete_minutes) AS auto_delete_minutes,
      COUNT(*)::int AS post_count
    FROM scheduled_posts
    WHERE status::text='published'
      AND is_ad=true
      AND report_sent_at IS NULL
      AND published_at IS NOT NULL
      AND published_at + (COALESCE(report_after_hours, 24) || ' hours')::interval <= now()
    GROUP BY COALESCE(report_group_id, id::text), created_by_max_user_id
    ORDER BY MIN(published_at) ASC
    LIMIT 5
  `);

  for (const group of groups) {
    try {
      const posts = await query(
        `SELECT sp.*, c.max_chat_id, c.title AS channel_title, c.link AS channel_link
         FROM scheduled_posts sp
         LEFT JOIN channels c ON c.id = sp.channel_id
         WHERE COALESCE(sp.report_group_id, sp.id::text) = $1
           AND sp.created_by_max_user_id = $2
         ORDER BY sp.id ASC`,
        [group.group_id, group.created_by_max_user_id]
      );

      let totalViews = 0;
      let knownViews = 0;
      const snapshotPosts = [];
      const lines = [];

      for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        const views = await getViewsForPost(p);

        if (views !== null) {
          totalViews += views;
          knownViews += 1;
        }

        snapshotPosts.push({
          id: p.id,
          channel: p.channel_title || 'Канал',
          link: p.channel_link || null,
          views,
        });

        const channel = p.channel_link
          ? `<a href="${p.channel_link}">${escapeHtml(p.channel_title || 'Канал')}</a>`
          : escapeHtml(p.channel_title || 'Канал');

        lines.push(`${i + 1}) <b>Канал:</b> ${channel}
👀 <b>Просмотры:</b> ${views === null ? 'пока недоступны' : views}`);
      }

      const clicks = await getClicksForGroup(group.group_id);
      const cpm = Number(group.cpm || 0);
      const cost = cpm && knownViews ? Math.round((totalViews / 1000) * cpm) : null;
      const url = reportUrl(group.group_id);
      const title = short(group.text || 'Рекламный пост', 80);
      const published = group.published_at ? new Date(group.published_at) : new Date();

      const reportText = `━━━━━━━━━━━━━━
📊 <b>Сводный отчёт LinkRay</b>
«${escapeHtml(title)}»

<b>Опубликовано:</b> ${published.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit'
      })} МСК

👀 <b>Общие просмотры:</b> ${knownViews ? totalViews : 'пока недоступны'}
🔗 <b>Уникальные клики:</b> ${clicks.uniqueClicks}
🧲 <b>Все клики:</b> ${clicks.totalClicks}
⏱ <b>Подсчёт:</b> ${group.report_after_hours || 24}ч
🗑 <b>Удаление:</b> ${formatAutoDelete(group.auto_delete_minutes)}
📣 <b>Каналы:</b> ${posts.length}
${cost !== null ? `💰 <b>Стоимость по CPM:</b> ${cost} ₽\n` : ''}
━━━━━━━━━━━━━━
📌 <b>Публикации:</b>

${lines.join('\n\n')}

🌐 <b>Красивый отчёт:</b>
<a href="${url}">${url}</a>

━━━━━━━━━━━━━━
✨ <a href="${BOT_LINK}">LinkRay</a> — отчёты по рекламным размещениям в MAX`;

      const snapshot = {
        groupId: group.group_id,
        title,
        totalViews: knownViews ? totalViews : null,
        knownViews,
        clicks,
        cpm: group.cpm,
        cost,
        autoDeleteMinutes: group.auto_delete_minutes,
        reportUrl: url,
        posts: snapshotPosts,
        sentAt: new Date().toISOString(),
      };

      const owner = String(group.created_by_max_user_id || '').trim();
      const sent = await sendMaxMessage({
        chatId: Number(owner),
        text: reportText,
        format: 'html',
        attachments: inlineKeyboard([[linkButton('📊 Открыть красивый отчёт', url)]])
      });

      await query(
        `UPDATE scheduled_posts
         SET report_sent_at=now(),
             report_message_id=$3,
             report_error_message=NULL,
             report_snapshot=$4::jsonb,
             updated_at=now()
         WHERE COALESCE(report_group_id, id::text) = $1
           AND created_by_max_user_id = $2`,
        [group.group_id, group.created_by_max_user_id, extractMessageId(sent), JSON.stringify(snapshot)]
      );

      console.log('[autopost] report sent', JSON.stringify({
        group: group.group_id,
        posts: posts.length,
        clicks,
      }));
    } catch (error) {
      console.error('[autopost] report failed:', group.group_id, error.message || error);

      await query(
        `UPDATE scheduled_posts
         SET report_error_message=$3, updated_at=now()
         WHERE COALESCE(report_group_id, id::text) = $1
           AND created_by_max_user_id = $2`,
        [group.group_id, group.created_by_max_user_id, String(error.message || error)]
      ).catch(() => {});
    }
  }
}

export async function startAutopostWorker() {
  if (started) return;
  started = true;
  console.log('[autopost] worker started');

  const tick = async () => {
    try {
      await publishDue();
      await deleteExpired();
      await sendDueReports();
    } catch (error) {
      console.error('[autopost] worker tick failed:', error.message || error);
    }
  };

  await tick();
  setInterval(tick, Number(process.env.AUTOPOST_INTERVAL_MS || 15000));
}

