import { query } from './db.js';
import { sendMaxMessage, inlineKeyboard, linkButton } from './maxClient.js';

let workerStarted = false;

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}


function normalizeAttachmentForSend(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const typeRaw = String(attachment.type || attachment.attachment_type || attachment.attachmentType || '').toLowerCase();
  const payload = attachment.payload && typeof attachment.payload === 'object' ? attachment.payload : {};

  if (typeRaw === 'inline_keyboard') return attachment;
  if (typeRaw === 'image' || typeRaw === 'photo') {
    if (payload.token) return { type: 'image', payload: { token: payload.token } };
    if (attachment.token) return { type: 'image', payload: { token: attachment.token } };
    if (Array.isArray(payload.photos)) return { type: 'image', payload: { photos: payload.photos } };
    return null;
  }
  if (['video', 'audio', 'file'].includes(typeRaw)) {
    if (payload.token) return { type: typeRaw, payload: { token: payload.token } };
    if (attachment.token) return { type: typeRaw, payload: { token: attachment.token } };
    return null;
  }
  if (typeRaw === 'sticker') {
    const code = payload.code || attachment.code;
    return code ? { type: 'sticker', payload: { code } } : null;
  }
  return null;
}

function normalizeAttachmentsForSend(attachments = []) {
  const result = [];
  const seen = new Set();
  for (const attachment of attachments || []) {
    const normalized = normalizeAttachmentForSend(attachment);
    if (!normalized) continue;
    const key = JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function safeObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isDraftModified(draft) {
  return Boolean(
    (Array.isArray(draft.buttons) && draft.buttons.length) ||
    draft.isAd ||
    draft.cpm ||
    Object.values(draft.signaturesByChannel || {}).some((value) => String(value || '').trim())
  );
}

function buildPostAttachments(row) {
  const attachments = [];
  const savedAttachments = safeArray(row.attachments);
  const buttons = safeArray(row.buttons);

  if (savedAttachments.length) {
    attachments.push(...normalizeAttachmentsForSend(savedAttachments));
  }

  if (buttons.length) {
    const rows = buttons
      .filter((button) => button && button.text && button.url)
      .map((button) => [linkButton(button.text, button.url)]);

    if (rows.length) {
      attachments.push(...inlineKeyboard(rows));
    }
  }

  return attachments;
}

async function publishDuePosts() {
  const rows = await query(
    `
    SELECT sp.*, c.max_chat_id, c.title AS channel_title
    FROM scheduled_posts sp
    JOIN channels c ON c.id = sp.channel_id
    WHERE COALESCE(sp.status, 'scheduled') IN ('scheduled')
      AND sp.publish_at <= now()
    ORDER BY sp.publish_at ASC, sp.id ASC
    LIMIT 20
    `
  );

  for (const row of rows) {
    const locked = await query(
      `
      UPDATE scheduled_posts
      SET status = 'publishing', updated_at = now()
      WHERE id = $1 AND COALESCE(status, 'scheduled') IN ('scheduled')
      RETURNING id
      `,
      [row.id]
    );

    if (!locked.length) {
      continue;
    }

    try {
      const result = await sendMaxMessage({
        chatId: row.max_chat_id,
        text: row.text || ' ',
        format: row.format || 'markdown',
        attachments: buildPostAttachments(row),
        notify: row.notify !== false,
      });

      const messageId =
        result?.message?.id ||
        result?.message_id ||
        result?.id ||
        null;

      await query(
        `
        UPDATE scheduled_posts
        SET status = 'published',
            published_at = now(),
            published_message_id = $2,
            error_message = NULL,
            updated_at = now()
        WHERE id = $1
        `,
        [row.id, messageId]
      );

      console.log('[autopost] published', JSON.stringify({ id: row.id, channel: row.channel_title }));
    } catch (error) {
      console.error('[autopost] publish failed:', row.id, error.message || error);

      await query(
        `
        UPDATE scheduled_posts
        SET status = 'error',
            error_message = $2,
            updated_at = now()
        WHERE id = $1
        `,
        [row.id, String(error.message || error).slice(0, 1000)]
      );
    }
  }
}

export function startAutopostWorker() {
  if (workerStarted) return;
  workerStarted = true;

  console.log('[autopost] worker started');

  setInterval(() => {
    publishDuePosts().catch((error) => {
      console.error('[autopost] worker error:', error.message || error);
    });
  }, Number(process.env.AUTOPOST_INTERVAL_MS || 10000));
}
