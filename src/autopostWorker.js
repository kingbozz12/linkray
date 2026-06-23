import { query } from './db.js';
import { sendMaxMessage, deleteMaxMessage } from './maxClient.js';

let started = false;

function safeJson(value, fallback = []) {
  try {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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

function linkButton(text, url) {
  return { type: 'link', text: String(text), url: String(url) };
}

function inlineKeyboard(rows = []) {
  return [{ type: 'inline_keyboard', payload: { buttons: rows } }];
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

async function publishDue() {
  const posts = await query(`
    SELECT sp.*, c.max_chat_id, c.title AS channel_title
    FROM scheduled_posts sp
    JOIN channels c ON c.id = sp.channel_id
    WHERE sp.status = 'scheduled' AND sp.publish_at <= now()
    ORDER BY sp.publish_at ASC, sp.id ASC
    LIMIT 10
  `);

  for (const post of posts) {
    try {
      await query(`UPDATE scheduled_posts SET status='publishing', updated_at=now() WHERE id=$1 AND status='scheduled'`, [post.id]);

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
    WHERE status='published'
      AND published_message_id IS NOT NULL
      AND auto_delete_minutes IS NOT NULL
      AND auto_delete_minutes > 0
      AND published_at IS NOT NULL
      AND published_at + (auto_delete_minutes || ' minutes')::interval <= now()
    LIMIT 10
  `);

  for (const post of posts) {
    try {
      await deleteMaxMessage(post.published_message_id);
      await query(`UPDATE scheduled_posts SET status='canceled', updated_at=now() WHERE id=$1`, [post.id]);
      console.log('[autopost] auto deleted', post.id);
    } catch (error) {
      console.error('[autopost] auto delete failed:', post.id, error.message || error);
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
    } catch (error) {
      console.error('[autopost] worker tick failed:', error.message || error);
    }
  };

  await tick();
  setInterval(tick, Number(process.env.AUTOPOST_INTERVAL_MS || 15000));
}
