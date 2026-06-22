import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { writeFile } from 'node:fs/promises';
import { query } from './db.js';
import { startAutopostWorker } from './autopostWorker.js';
import {
  sendMaxMessage,
  answerCallback,
  inlineKeyboard,
  callbackButton,
  linkButton,
  getMaxChatInfo,
  getMaxMessage,
} from './maxClient.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

const MSK_TZ = 'Europe/Moscow';
const MAX_PREVIEW_ATTACHMENTS = 8;

async function ensureDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      user_id text PRIMARY KEY,
      state text NOT NULL DEFAULT 'idle',
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS title text`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS link text`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_public boolean DEFAULT false`);

  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS buttons jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS draft jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS is_ad boolean NOT NULL DEFAULT false`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS cpm numeric`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS auto_delete_minutes integer`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_after_hours integer NOT NULL DEFAULT 24`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS published_at timestamptz`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS published_message_id text`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

  await query(`
    CREATE TABLE IF NOT EXISTS channel_signatures (
      id serial PRIMARY KEY,
      channel_id integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      owner_key text NOT NULL,
      title text NOT NULL DEFAULT 'Автоподпись',
      text text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS owner_key text`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Автоподпись'`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await query(`UPDATE channel_signatures SET owner_key = 'global' WHERE owner_key IS NULL`);
  await query(`ALTER TABLE channel_signatures ALTER COLUMN owner_key SET NOT NULL`);

  await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_posts_publish ON scheduled_posts(status, publish_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_posts_channel ON scheduled_posts(channel_id, publish_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_channel_signatures_channel_owner ON channel_signatures(channel_id, owner_key)`);

  await query(`
    CREATE TABLE IF NOT EXISTS user_quick_times (
      owner_key text NOT NULL,
      time_text text NOT NULL,
      used_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_key, time_text)
    )
  `);


  await query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scheduled_post_status') THEN
        ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'publishing';
        ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'published';
        ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'error';
        ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'canceled';
      END IF;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END $$;
  `);
}

function norm(text) {
  return String(text || '')
    .replace(/[\uFE0F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function includesText(text, needle) {
  return norm(text).includes(norm(needle));
}

function normalizeUserText(text) {
  return String(text || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .trim();
}

function getUpdateType(update) {
  return update.update_type || update.updateType || update.type || update.event_type || '';
}

function getChatId(update) {
  return (
    update.chat_id ||
    update.chatId ||
    update.chat?.chat_id ||
    update.chat?.chatId ||
    update.chat?.id ||
    update.message?.recipient?.chat_id ||
    update.message?.recipient?.chatId ||
    update.message?.chat_id ||
    update.message?.chatId ||
    update.message?.chat?.chat_id ||
    update.message?.chat?.chatId ||
    update.message?.chat?.id ||
    update.callback?.chat?.chat_id ||
    update.callback?.chat?.chatId ||
    update.callback?.chat?.id ||
    null
  );
}

function getRawUserId(update) {
  return (
    update.user_id ||
    update.userId ||
    update.user?.user_id ||
    update.user?.userId ||
    update.user?.id ||
    update.message?.sender?.user_id ||
    update.message?.sender?.userId ||
    update.message?.sender?.id ||
    update.message?.sender_id ||
    update.message?.senderId ||
    update.callback?.user?.user_id ||
    update.callback?.user?.userId ||
    update.callback?.user?.id ||
    null
  );
}

function getSessionKey(update) {
  return String(getChatId(update) || getRawUserId(update) || 'unknown');
}

function getCallbackId(update) {
  return update.callback?.callback_id || update.callback?.callbackId || update.callback_id || update.callbackId || null;
}

function getCallbackPayload(update) {
  const candidates = [
    update.callback?.payload,
    update.callback?.button?.payload,
    update.callback?.data,
    update.callback?.value,
    update.button?.payload,
    update.button?.data,
    update.message?.body?.payload,
    update.message?.body?.button?.payload,
    update.message?.payload,
    update.payload,
    update.data,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    if (typeof candidate === 'string') return candidate;
    if (typeof candidate === 'object') {
      if (typeof candidate.payload === 'string') return candidate.payload;
      if (typeof candidate.value === 'string') return candidate.value;
      if (typeof candidate.data === 'string') return candidate.data;
      return JSON.stringify(candidate);
    }
  }

  return '';
}

function getMessageText(update) {
  return String(
    update.message?.body?.text ||
    update.message?.text ||
    update.body?.text ||
    update.text ||
    ''
  ).trim();
}

function getChatTitle(update) {
  return (
    update.chat?.title ||
    update.chat?.name ||
    update.message?.chat?.title ||
    update.message?.chat?.name ||
    update.chat_title ||
    update.chatTitle ||
    null
  );
}

function getChatLink(update) {
  return (
    update.chat?.link ||
    update.chat?.invite_link ||
    update.chat?.inviteLink ||
    update.message?.chat?.link ||
    update.chat_link ||
    update.chatLink ||
    null
  );
}

function looksLikeAttachment(value) {
  if (!value || typeof value !== 'object') return false;
  const type = String(value.type || value.attachment_type || value.attachmentType || '').toLowerCase();
  if (!type) return false;

  const allowed = ['image', 'photo', 'video', 'file', 'audio', 'sticker', 'contact', 'location', 'share', 'link', 'card', 'message', 'forward', 'forwarded', 'post', 'story'];
  return allowed.some((item) => type.includes(item));
}

function deepCollectAttachments(value, found = [], seen = new Set()) {
  if (!value || found.length >= MAX_PREVIEW_ATTACHMENTS) return found;

  if (typeof value !== 'object') return found;
  if (seen.has(value)) return found;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      deepCollectAttachments(item, found, seen);
      if (found.length >= MAX_PREVIEW_ATTACHMENTS) break;
    }
    return found;
  }

  if (looksLikeAttachment(value) && found.length < MAX_PREVIEW_ATTACHMENTS) {
    found.push(value);
  }

  const arrayKeys = ['attachments', 'media', 'photos', 'images', 'videos', 'files', 'items', 'messages', 'attachments_payload'];
  for (const key of arrayKeys) {
    if (Array.isArray(value[key])) {
      for (const attachment of value[key]) {
        deepCollectAttachments(attachment, found, seen);
        if (found.length >= MAX_PREVIEW_ATTACHMENTS) break;
      }
    }
  }

  const likelyNested = [
    value.body,
    value.message,
    value.forwarded,
    value.forwarded_message,
    value.forwardedMessage,
    value.original_message,
    value.originalMessage,
    value.shared_message,
    value.sharedMessage,
    value.payload,
    value.content,
    value.post,
    value.source,
    value.preview,
    value.link,
    value.attachment,
    value.attached_message,
    value.attachedMessage,
    value.post_message,
    value.postMessage,
    value.external_message,
    value.externalMessage,
  ];

  for (const child of likelyNested) {
    deepCollectAttachments(child, found, seen);
    if (found.length >= MAX_PREVIEW_ATTACHMENTS) break;
  }

  return found;
}


function firstMarkupFromKnownPaths(update) {
  const candidates = [
    update.message?.body?.markup,
    update.message?.markup,
    update.message?.link?.message?.body?.markup,
    update.message?.link?.message?.markup,
    update.message?.forwarded_message?.body?.markup,
    update.message?.forwarded_message?.markup,
    update.message?.forwardedMessage?.body?.markup,
    update.message?.forwardedMessage?.markup,
    update.message?.forwarded?.body?.markup,
    update.message?.forwarded?.markup,
    update.message?.original_message?.body?.markup,
    update.message?.originalMessage?.body?.markup,
    update.message?.shared_message?.body?.markup,
    update.message?.sharedMessage?.body?.markup,
    update.message?.attached_message?.body?.markup,
    update.message?.attachedMessage?.body?.markup,
    update.message?.post_message?.body?.markup,
    update.message?.postMessage?.body?.markup,
    update.body?.markup,
    update.markup,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }

  return [];
}

function applyMaxMarkupToMarkdown(text, markup = []) {
  return applyMaxMarkupToHtml(text, markup);
}

function firstTextFromKnownPaths(update) {
  const candidates = [
    update.message?.body?.text,
    update.message?.text,
    update.message?.link?.message?.body?.text,
    update.message?.link?.message?.text,
    update.message?.link?.message?.content?.text,
    update.message?.forwarded_message?.body?.text,
    update.message?.forwarded_message?.text,
    update.message?.forwardedMessage?.body?.text,
    update.message?.forwardedMessage?.text,
    update.message?.forwarded?.body?.text,
    update.message?.forwarded?.text,
    update.message?.original_message?.body?.text,
    update.message?.originalMessage?.body?.text,
    update.message?.shared_message?.body?.text,
    update.message?.sharedMessage?.body?.text,
    update.message?.attached_message?.body?.text,
    update.message?.attachedMessage?.body?.text,
    update.message?.post_message?.body?.text,
    update.message?.postMessage?.body?.text,
    update.body?.text,
    update.text,
  ];

  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }

  return '';
}

function isUsefulTextCandidate(key, value) {
  const text = String(value || '').trim();
  if (text.length < 4) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^[a-z0-9_:\-.]{12,}$/i.test(text) && !/[а-яё]/i.test(text)) return false;

  const badKeys = ['id', 'mid', 'url', 'avatar', 'thumbnail', 'token', 'callback', 'payload', 'type'];
  if (badKeys.includes(String(key || '').toLowerCase())) return false;

  return true;
}

function scoreTextCandidate(key, text) {
  let score = String(text || '').trim().length;
  const lowerKey = String(key || '').toLowerCase();

  if (['text', 'caption', 'title', 'description'].includes(lowerKey)) score += 1000;
  if (/[а-яё]/i.test(text)) score += 150;
  if (String(text).includes('\n')) score += 100;
  if (String(text).split(/\s+/).length > 5) score += 100;

  return score;
}

function deepFindBestText(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);

  let best = '';
  let bestScore = 0;

  function offer(key, candidate) {
    if (!isUsefulTextCandidate(key, candidate)) return;
    const text = String(candidate).trim();
    const score = scoreTextCandidate(key, text);
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }

  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === 'string') {
      offer(key, candidate);
    }
  }

  for (const candidate of [
    value.body,
    value.message,
    value.forwarded,
    value.forwarded_message,
    value.forwardedMessage,
    value.original_message,
    value.originalMessage,
    value.shared_message,
    value.sharedMessage,
    value.payload,
    value.content,
    value.post,
    value.source,
    value.preview,
    value.link,
    value.attachment,
    value.attached_message,
    value.attachedMessage,
    value.post_message,
    value.postMessage,
    value.external_message,
    value.externalMessage,
  ]) {
    const result = deepFindBestText(candidate, seen);
    offer('text', result);
  }

  for (const key of ['attachments', 'media', 'photos', 'images', 'videos', 'files', 'items']) {
    if (Array.isArray(value[key])) {
      for (const item of value[key]) {
        const result = deepFindBestText(item, seen);
        offer('text', result);
      }
    }
  }

  return best;
}

function detectForwarded(update) {
  const msg = update.message || update;
  return Boolean(
    msg.forwarded ||
    msg.forwarded_message ||
    msg.forwardedMessage ||
    msg.original_message ||
    msg.originalMessage ||
    msg.shared_message ||
    msg.sharedMessage ||
    msg.link ||
    msg.message_link ||
    msg.attached_message ||
    msg.attachedMessage ||
    msg.post_message ||
    msg.postMessage ||
    msg.external_message ||
    msg.externalMessage
  );
}

function extractContent(update) {
  const knownText = firstTextFromKnownPaths(update);
  const deepText = deepFindBestText(update.message || update);
  const rawText = (knownText || deepText || '').trim();
  const markup = firstMarkupFromKnownPaths(update);
  const text = markup.length ? applyMaxMarkupToHtml(rawText, markup).trim() : rawText;
  const attachments = deepCollectAttachments(update.message || update).filter(Boolean);
  const isForwarded = detectForwarded(update);
  const forwardMid = findForwardMid(update.message || update);

  return {
    text,
    markup,
    format: markup.length ? 'html' : 'markdown',
    attachments,
    kind: isForwarded ? 'forwarded' : attachments.length ? 'media' : 'text',
    raw: update.message || null,
    forwardMid,
    exactForward: false,
    sourceNote: isForwarded && !text && !attachments.length && !forwardMid
      ? 'MAX не передал содержимое пересланного поста в webhook. Raw payload сохранён на сервере.'
      : '',
  };
}

function collectMessageIds(value, found = [], seen = new Set()) {
  if (!value || typeof value !== 'object') return found;
  if (seen.has(value)) return found;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectMessageIds(item, found, seen);
    return found;
  }

  for (const key of ['message_id', 'messageId', 'mid', 'id']) {
    const candidate = value[key];
    if (candidate && typeof candidate !== 'object') {
      const id = String(candidate).trim();
      if (id && id.length >= 6 && !found.includes(id)) found.push(id);
    }
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectMessageIds(child, found, seen);
  }

  return found.slice(0, 10);
}


function findForwardMid(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (value.link && typeof value.link === 'object') {
    const type = String(value.link.type || '').toLowerCase();
    const mid = value.link.mid || value.link.message_id || value.link.messageId || value.link.id || value.link.message?.mid || value.link.message?.id;
    if ((type === 'forward' || type.includes('forward')) && mid) return String(mid);
  }

  const directType = String(value.type || '').toLowerCase();
  const directMid = value.mid || value.message_id || value.messageId;
  if ((directType === 'forward' || directType.includes('forward')) && directMid) return String(directMid);

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const result = findForwardMid(child, seen);
      if (result) return result;
    }
  }

  return null;
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

function isDraftModified(draft) {
  return Boolean(
    (Array.isArray(draft.buttons) && draft.buttons.length) ||
    draft.isAd ||
    draft.cpm ||
    Object.values(draft.signaturesByChannel || {}).some((value) => normalizeUserText(value).trim())
  );
}

function mergeContent(primary, secondary) {
  const merged = { ...primary };

  if (!normalizeUserText(merged.text).trim() && normalizeUserText(secondary?.text).trim()) {
    merged.text = normalizeUserText(secondary.text);
  }

  const attachments = [];
  const seen = new Set();
  for (const attachment of [...(primary.attachments || []), ...(secondary?.attachments || [])]) {
    const key = JSON.stringify(attachment).slice(0, 500);
    if (!seen.has(key)) {
      seen.add(key);
      attachments.push(attachment);
    }
  }
  merged.attachments = attachments.slice(0, MAX_PREVIEW_ATTACHMENTS);

  if (secondary?.kind === 'forwarded') merged.kind = 'forwarded';
  if (!merged.raw && secondary?.raw) merged.raw = secondary.raw;
  if (!merged.forwardMid && secondary?.forwardMid) merged.forwardMid = secondary.forwardMid;
  if (merged.exactForward === undefined && secondary?.exactForward !== undefined) merged.exactForward = secondary.exactForward;
  if (!merged.sourceNote && secondary?.sourceNote) merged.sourceNote = secondary.sourceNote;

  return merged;
}

async function extractContentWithHydration(update) {
  let content = extractContent(update);

  const needsHydration = content.kind === 'forwarded' && (!normalizeUserText(content.text).trim() || !content.attachments.length);
  if (!needsHydration) return content;

  const ids = collectMessageIds(update.message || update);
  for (const id of ids) {
    try {
      const full = await getMaxMessage(id);
      await writeFile(`/tmp/linkray_message_${id}.json`, JSON.stringify(full, null, 2)).catch(() => {});
      const hydrated = extractContent(full?.message ? full : { message: full });
      content = mergeContent(content, hydrated);
      if (normalizeUserText(content.text).trim() && content.attachments.length) break;
    } catch (error) {
      console.error('[hydrate message] failed:', id, error.message || error);
    }
  }

  if (content.kind === 'forwarded' && (!normalizeUserText(content.text).trim() || !content.attachments.length)) {
    content.sourceNote = 'MAX прислал пересланный пост не полностью. Raw payload сохранён в /tmp/linkray_last_update.json.';
  }

  return content;
}

function emptyDraft() {
  return {
    channelIds: [],
    content: {
      text: '',
      attachments: [],
      kind: 'text',
      raw: null,
      markup: [],
      sourceNote: '',
      format: 'markdown',
      forwardMid: null,
      exactForward: false,
    },
    buttons: [],
    signaturesByChannel: {},
    signatureEnabledByChannel: {},
    activeSignatureChannelId: null,
    isAd: false,
    cpm: null,
    notify: true,
    autoDeleteMinutes: null,
    reportAfterHours: 24,
    scheduleDate: null,
    calendarYear: null,
    calendarMonth: null,
    lastTime: null,
  };
}

function safeDraft(data) {
  const source = data?.draft || data || {};
  const base = emptyDraft();

  return {
    ...base,
    ...source,
    content: {
      ...base.content,
      ...(source.content || {}),
      attachments: Array.isArray(source.content?.attachments) ? source.content.attachments : [],
      markup: Array.isArray(source.content?.markup) ? source.content.markup : [],
    },
    buttons: Array.isArray(source.buttons) ? source.buttons : [],
    channelIds: Array.isArray(source.channelIds) ? source.channelIds.map(Number).filter(Boolean) : [],
    signaturesByChannel: source.signaturesByChannel && typeof source.signaturesByChannel === 'object' ? source.signaturesByChannel : {},
    signatureEnabledByChannel: source.signatureEnabledByChannel && typeof source.signatureEnabledByChannel === 'object' ? source.signatureEnabledByChannel : {},
  };
}


function hasDraftContent(draft) {
  return Boolean(
    normalizeUserText(draft?.content?.text).trim() ||
    (Array.isArray(draft?.content?.attachments) && draft.content.attachments.length) ||
    draft?.content?.kind === 'forwarded'
  );
}

async function getSession(key) {
  const rows = await query('SELECT state, data FROM bot_sessions WHERE user_id = $1', [String(key)]);
  if (!rows.length) return { state: 'idle', data: {} };
  return { state: rows[0].state || 'idle', data: rows[0].data || {} };
}

async function setSession(key, state, data = {}) {
  await query(
    `
    INSERT INTO bot_sessions (user_id, state, data, updated_at)
    VALUES ($1, $2, $3::jsonb, now())
    ON CONFLICT (user_id)
    DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data, updated_at = now()
    `,
    [String(key), state, JSON.stringify(data)]
  );
}

async function clearSession(key) {
  await setSession(key, 'idle', {});
}

async function getChannels() {
  return query(`
    SELECT id, max_chat_id, title, link, is_public
    FROM channels
    ORDER BY title ASC NULLS LAST, id ASC
  `);
}

async function getChannel(id) {
  const rows = await query(
    `SELECT id, max_chat_id, title, link, is_public FROM channels WHERE id = $1`,
    [Number(id)]
  );
  return rows[0] || null;
}

async function getChannelsByIds(ids) {
  const list = (ids || []).map(Number).filter(Boolean);
  if (!list.length) return [];
  return query(
    `
    SELECT id, max_chat_id, title, link, is_public
    FROM channels
    WHERE id = ANY($1::int[])
    ORDER BY title ASC NULLS LAST, id ASC
    `,
    [list]
  );
}

function channelName(channel) {
  return channel?.title || `Канал #${channel?.id || '?'}`;
}

function escapeMarkdownLinkText(text) {
  return String(text || '').replace(/[\[\]\n\r]/g, ' ').trim();
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function htmlAttrEscape(value) {
  return htmlEscape(value).replace(/"/g, '&quot;');
}

function applyMaxMarkupToHtml(text, markup = []) {
  const source = String(text || '');
  const marks = Array.isArray(markup) ? markup : [];
  const opens = new Map();
  const closes = new Map();

  function addOpen(pos, tag) {
    if (!opens.has(pos)) opens.set(pos, []);
    opens.get(pos).push(tag);
  }

  function addClose(pos, tag) {
    if (!closes.has(pos)) closes.set(pos, []);
    closes.get(pos).push(tag);
  }

  for (const item of marks) {
    const from = Number(item.from);
    const length = Number(item.length);
    if (!Number.isFinite(from) || !Number.isFinite(length) || length <= 0) continue;
    if (from < 0 || from >= source.length) continue;

    const end = Math.min(source.length, from + length);
    const type = String(item.type || '').toLowerCase();

    let open = '';
    let close = '';

    if ((type === 'link' || type === 'url') && item.url) {
      open = `<a href="${htmlAttrEscape(item.url)}">`;
      close = '</a>';
    } else if (type === 'strong' || type === 'bold') {
      open = '<b>';
      close = '</b>';
    } else if (type === 'emphasized' || type === 'italic') {
      open = '<i>';
      close = '</i>';
    } else if (type === 'strikethrough' || type === 'strike') {
      open = '<s>';
      close = '</s>';
    } else if (type === 'underline' || type === 'underlined') {
      open = '<u>';
      close = '</u>';
    } else if (type === 'code' || type === 'monospace') {
      open = '<code>';
      close = '</code>';
    } else if (type === 'header') {
      open = '<h1>';
      close = '</h1>';
    }

    if (!open || !close) continue;

    addOpen(from, { tag: open, length });
    addClose(end, { tag: close, length });
  }

  let out = '';

  for (let i = 0; i <= source.length; i += 1) {
    if (closes.has(i)) {
      const list = closes.get(i).sort((a, b) => a.length - b.length);
      for (const item of list) out += item.tag;
    }

    if (opens.has(i)) {
      const list = opens.get(i).sort((a, b) => b.length - a.length);
      for (const item of list) out += item.tag;
    }

    if (i < source.length) out += htmlEscape(source[i]);
  }

  return out;
}

function draftFormat(draft) {
  return draft?.content?.format === 'html' ? 'html' : 'markdown';
}

function channelTextLink(channel) {
  // В тексте показываем только название.
  // Кликабельность делаем отдельными link-кнопками, чтобы MAX не вставлял большую карточку предпросмотра канала.
  return channelName(channel);
}

function channelsPlainList(channels) {
  if (!channels.length) return '• канал не выбран';
  return channels.map((channel) => `• ${channelTextLink(channel)}`).join('\n');
}

function channelLinkRows(channels) {
  return channels
    .filter((channel) => channel.link)
    .map((channel) => [linkButton(`🔗 ${channelName(channel)}`, channel.link)]);
}

async function loadSharedSignatures(draft) {
  const ids = (draft.channelIds || []).map(Number).filter(Boolean);
  if (!ids.length) return draft;

  const rows = await query(
    `
    SELECT DISTINCT ON (channel_id) channel_id, text, is_active
    FROM channel_signatures
    WHERE channel_id = ANY($1::int[])
      AND owner_key = 'shared'
    ORDER BY channel_id, updated_at DESC, id DESC
    `,
    [ids]
  );

  for (const row of rows) {
    const key = String(row.channel_id);
    if (!draft.signaturesByChannel[key] && row.text) {
      draft.signaturesByChannel[key] = row.text;
    }
    if (draft.signatureEnabledByChannel[key] === undefined) {
      draft.signatureEnabledByChannel[key] = row.is_active !== false;
    }
  }

  return draft;
}

async function saveSharedSignature(channelId, text) {
  await query(
    `
    UPDATE channel_signatures
    SET is_active = false, updated_at = now()
    WHERE channel_id = $1 AND owner_key = 'shared'
    `,
    [Number(channelId)]
  );

  await query(
    `
    INSERT INTO channel_signatures (channel_id, owner_key, title, text, is_active, updated_at)
    VALUES ($1, 'shared', 'Автоподпись', $2, true, now())
    `,
    [Number(channelId), text]
  );
}

async function setSharedSignatureActive(channelId, active) {
  await query(
    `
    UPDATE channel_signatures
    SET is_active = $2, updated_at = now()
    WHERE channel_id = $1 AND owner_key = 'shared'
    `,
    [Number(channelId), active]
  );
}

async function refreshChannelMeta(channel) {
  try {
    const info = await getMaxChatInfo(channel.max_chat_id);
    const title = info?.title || info?.name || info?.chat?.title || info?.chat?.name || channel.title || null;
    const link = info?.link || info?.invite_link || info?.inviteLink || info?.chat?.link || channel.link || null;
    const isPublic = Boolean(info?.is_public ?? info?.isPublic ?? link);

    await query(
      'UPDATE channels SET title = COALESCE($2, title), link = $3, is_public = $4 WHERE id = $1',
      [channel.id, title, link, isPublic]
    );
  } catch (error) {
    console.error('[refresh channel] failed:', channel.max_chat_id, error.message || error);
  }
}

async function refreshAllChannelsMeta() {
  const channels = await getChannels();
  for (const channel of channels) await refreshChannelMeta(channel);
}

function buttonRowsForChannels(channels, prefix, selectedIds = []) {
  const selected = new Set(selectedIds.map(Number));
  const rows = [];
  for (let i = 0; i < channels.length; i += 2) {
    const row = [];
    const one = channels[i];
    row.push(callbackButton(`${selected.has(Number(one.id)) ? '✅' : '📡'} ${channelName(one)}`, `${prefix}:${one.id}`));
    const two = channels[i + 1];
    if (two) row.push(callbackButton(`${selected.has(Number(two.id)) ? '✅' : '📡'} ${channelName(two)}`, `${prefix}:${two.id}`));
    rows.push(row);
  }
  return rows;
}

function kbMain() {
  return inlineKeyboard([
    [callbackButton('🧬 LinkRay Studio', 'main:posting')],
    [callbackButton('📅 Очередь', 'queue:menu'), callbackButton('📡 Каналы', 'post:channels')],
    [callbackButton('📊 Отчёты', 'main:stub'), callbackButton('🛡 Антифрод', 'main:stub')],
    [callbackButton('💼 Реклама', 'main:stub'), callbackButton('⚙️ Профиль', 'main:stub')],
  ]);
}

function kbPosting() {
  return inlineKeyboard([
    [callbackButton('🧩 Собрать пост', 'post:create')],
    [callbackButton('📅 Очередь публикаций', 'queue:menu')],
    [callbackButton('📡 Мои каналы', 'post:channels'), callbackButton('➕ Подключить канал', 'post:add_channel')],
    [callbackButton('🏠 Главное меню', 'main:menu')],
  ]);
}

function kbBackCancel(backPayload = 'post:back') {
  return inlineKeyboard([
    [callbackButton('⬅️ Назад', backPayload), callbackButton('❌ Отмена', 'post:cancel')],
  ]);
}

function kbChannelSelect(channels, selectedIds = [], multi = false) {
  const rows = buttonRowsForChannels(channels, multi ? 'post:toggle' : 'post:single', selectedIds);
  if (multi) rows.push([callbackButton('➡️ Продолжить', 'post:multi_next')]);
  else rows.push([callbackButton('🧩 Несколько каналов', 'post:multi')]);
  rows.push([callbackButton('🌐 Все каналы', 'post:all')]);
  rows.push([callbackButton('➕ Подключить канал', 'post:add_channel')]);
  rows.push([callbackButton('⬅️ Назад', 'post:back'), callbackButton('❌ Отмена', 'post:cancel')]);
  return inlineKeyboard(rows);
}

function kbEditor(draft) {
  const rows = [
    [callbackButton('✏️ Текст', 'editor:text'), callbackButton('🖼 Медиа', 'editor:media')],
    [callbackButton('🔘 Кнопки', 'editor:button'), callbackButton('🏷 Подписи', 'sig:menu')],
    [callbackButton(draft.isAd ? '✅ Реклама включена' : '💼 Рекламный пост', 'editor:ad')],
  ];

  if (draft.isAd) {
    rows.push([callbackButton(draft.cpm ? `💰 CPM: ${draft.cpm} ₽` : '💰 Указать CPM', 'editor:cpm')]);
  }

  rows.push([callbackButton('➡️ К выпуску', 'editor:next')]);
  rows.push([callbackButton('🔁 Каналы', 'editor:channels'), callbackButton('❌ Отмена', 'post:cancel')]);
  return inlineKeyboard(rows);
}

function kbPublish(draft) {
  return inlineKeyboard([
    [callbackButton(draft.autoDeleteMinutes ? `🗑 ${formatMinutes(draft.autoDeleteMinutes)}` : '🗑 Автоудаление', 'publish:auto_delete'), callbackButton(draft.notify ? '🔔 Звук: вкл' : '🔕 Звук: выкл', 'publish:sound')],
    [callbackButton('📆 Календарь', 'schedule:calendar'), callbackButton('✍️ Ввести время', 'schedule:manual')],
    [callbackButton('⚡ Опубликовать сейчас', 'publish:now')],
    [callbackButton('⬅️ В Studio', 'publish:back'), callbackButton('❌ Отмена', 'post:cancel')],
  ]);
}

function kbAutoDelete() {
  return inlineKeyboard([
    [callbackButton('1ч', 'autodel:60'), callbackButton('2ч', 'autodel:120'), callbackButton('4ч', 'autodel:240')],
    [callbackButton('8ч', 'autodel:480'), callbackButton('12ч', 'autodel:720'), callbackButton('24ч', 'autodel:1440')],
    [callbackButton('48ч', 'autodel:2880'), callbackButton('7д', 'autodel:10080'), callbackButton('30д', 'autodel:43200')],
    [callbackButton('🚫 Не удалять', 'autodel:none')],
    [callbackButton('⬅️ Назад', 'autodel:back')],
  ]);
}

function kbFinal() {
  return inlineKeyboard([
    [callbackButton('🧩 Собрать ещё пост', 'post:create')],
    [callbackButton('📅 Очередь публикаций', 'queue:menu')],
    [callbackButton('🏠 В меню', 'main:menu')],
  ]);
}

function formatMinutes(minutes) {
  const n = Number(minutes);
  if (!n) return 'нет';
  if (n % 1440 === 0) return `${n / 1440}д`;
  if (n % 60 === 0) return `${n / 60}ч`;
  return `${n}м`;
}

function previewText(text, max = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'текст не найден';
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function mskParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: MSK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour), minute: Number(map.minute) };
}

function dateFromMsk(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, 0, 0));
}

function formatMsk(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: MSK_TZ,
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function parseTimeParts(text) {
  const raw = String(text || '').trim().toLowerCase();
  let m = raw.match(/^(\d{1,2})[:\s]?(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function parsePublishTime(text, draft = emptyDraft()) {
  const raw = String(text || '').trim().toLowerCase();
  const now = new Date();
  let m = raw.match(/^через\s+(\d+)\s*(м|мин|минут|минуту|минуты)$/);
  if (m) return new Date(now.getTime() + Number(m[1]) * 60 * 1000);
  m = raw.match(/^через\s+(\d+)\s*(ч|час|часа|часов)$/);
  if (m) return new Date(now.getTime() + Number(m[1]) * 60 * 60 * 1000);
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (m) return dateFromMsk(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));

  const time = parseTimeParts(raw);
  if (time) {
    if (draft.scheduleDate) {
      const [year, month, day] = draft.scheduleDate.split('-').map(Number);
      return dateFromMsk(year, month, day, time.hour, time.minute);
    }
    const p = mskParts(now);
    let d = dateFromMsk(p.year, p.month, p.day, time.hour, time.minute);
    if (d.getTime() <= now.getTime()) d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    return d;
  }

  return null;
}

function parseCpm(text) {
  const value = Number(String(text || '').replace(/[^\d.,]/g, '').replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function parsePostButton(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/^(.+?)\s*[-—]\s*(.+)$/);
  if (!m) return null;
  let url = m[2].trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return { text: m[1].trim().slice(0, 64), url };
}

function parseDateKey(date) {
  const p = mskParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function kbCalendar(year, month) {
  const today = mskParts();
  const rows = [];
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  const monthTitle = new Intl.DateTimeFormat('ru-RU', {
    timeZone: MSK_TZ,
    month: 'long',
    year: 'numeric',
  }).format(dateFromMsk(year, month, 1, 12, 0));

  rows.push([
    callbackButton('‹', `cal:month:${prevYear}-${String(prevMonth).padStart(2, '0')}`),
    callbackButton(monthTitle, 'cal:noop'),
    callbackButton('›', `cal:month:${nextYear}-${String(nextMonth).padStart(2, '0')}`),
  ]);

  const total = daysInMonth(year, month);
  let row = [];

  for (let day = 1; day <= total; day += 1) {
    const past = year < today.year || (year === today.year && month < today.month) || (year === today.year && month === today.month && day < today.day);
    const label = day === today.day && month === today.month && year === today.year ? `Сегодня · ${day}` : String(day);
    const payload = past ? 'cal:noop' : `cal:day:${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    row.push(callbackButton(past ? '·' : label, payload));

    if (row.length === 4) {
      rows.push(row);
      row = [];
    }
  }

  if (row.length) rows.push(row);

  rows.push([callbackButton('✍️ Ввести время', 'schedule:manual')]);
  rows.push([callbackButton('⬅️ Назад', 'schedule:back')]);
  return inlineKeyboard(rows);
}

function buildTimeRows(times = []) {
  const rows = [];
  const clean = [...new Set((times || []).filter(Boolean))].slice(0, 6);

  for (let i = 0; i < clean.length; i += 2) {
    const row = [callbackButton(`🕘 ${clean[i]}`, `time:quick:${clean[i]}`)];
    if (clean[i + 1]) row.push(callbackButton(`🕘 ${clean[i + 1]}`, `time:quick:${clean[i + 1]}`));
    rows.push(row);
  }

  rows.push([callbackButton('✍️ Ввести время', 'schedule:manual')]);
  rows.push([callbackButton('⬅️ Календарь', 'schedule:calendar')]);
  return rows;
}

function kbTimeAfterDate(times = []) {
  return inlineKeyboard(buildTimeRows(times));
}

function buildPostTextForChannel(draft, channelId) {
  const parts = [];
  if (draft.content?.text) parts.push(draft.content.text);
  const signature = draft.signaturesByChannel?.[String(channelId)];
  const enabled = draft.signatureEnabledByChannel?.[String(channelId)] !== false;
  if (signature && enabled) parts.push(signature);
  return parts.join('\n\n').trim() || ' ';
}

function buildPreviewText(draft) {
  const firstChannelId = draft.channelIds[0];
  return buildPostTextForChannel(draft, firstChannelId);
}

function buildPostAttachments(draft) {
  const attachments = [];
  if (Array.isArray(draft.content?.attachments)) {
    attachments.push(...normalizeAttachmentsForSend(draft.content.attachments).slice(0, MAX_PREVIEW_ATTACHMENTS));
  }
  if (Array.isArray(draft.buttons) && draft.buttons.length) {
    attachments.push(...inlineKeyboard(draft.buttons.map((button) => [linkButton(button.text, button.url)])));
  }
  return attachments;
}

function formatKind(kind) {
  if (kind === 'forwarded') return 'пересланный пост';
  if (kind === 'media') return 'медиа';
  return 'текст';
}

async function renderStudioText(draft) {
  const channels = await getChannelsByIds(draft.channelIds);
  const channelLine = channels.length
    ? channels.map((channel) => channelName(channel)).join(', ')
    : 'канал выберем перед выпуском';

  const sourceHint = draft.content?.sourceNote
    ? '\n\n⚠️ MAX прислал пересланный пост не полностью. Raw payload сохранён на сервере.'
    : '';

  return `━━━━━━━━━━━━━━
🧬 **Редактор LinkRay**

📡 ${channelLine}${sourceHint}
━━━━━━━━━━━━━━`;
}
async function renderPublishText(draft) {
  const channels = await getChannelsByIds(draft.channelIds);
  const ad = draft.isAd ? `да${draft.cpm ? ` · CPM ${draft.cpm} ₽` : ' · CPM не указан'}` : 'нет';
  return `━━━━━━━━━━━━━━\n🚀 **К выпуску**\n\n📡 Каналы:\n${channelsPlainList(channels)}\n\n🔔 Звук: ${draft.notify ? 'включён' : 'выключен'}\n🗑 Автоудаление: ${draft.autoDeleteMinutes ? formatMinutes(draft.autoDeleteMinutes) : 'нет'}\n💼 Реклама: ${ad}\n📊 Отчёт: через ${draft.reportAfterHours || 24}ч\n\nВыберите способ публикации.\n━━━━━━━━━━━━━━`;
}

async function sendMainMenu(chatId) {
  await sendMaxMessage({ chatId, text: `━━━━━━━━━━━━━━\n🧬 **LinkRay**\n\nСтудия публикаций, очередь постов и рекламные отчёты для MAX.\n\nВыберите действие.\n━━━━━━━━━━━━━━`, attachments: kbMain() });
}

async function editMainMenu(callbackId) {
  await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n🧬 **LinkRay**\n\nСтудия публикаций, очередь постов и рекламные отчёты для MAX.\n\nВыберите действие.\n━━━━━━━━━━━━━━`, attachments: kbMain() });
}

async function editPosting(callbackId, key) {
  await setSession(key, 'posting_menu', {});
  await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n🧬 **LinkRay Studio**\n\nСоберите пост, выберите каналы, настройте подписи, кнопки, рекламу и время выхода.\n━━━━━━━━━━━━━━`, attachments: kbPosting() });
}

async function sendPosting(chatId, key) {
  await setSession(key, 'posting_menu', {});
  await sendMaxMessage({ chatId, text: `━━━━━━━━━━━━━━\n🧬 **LinkRay Studio**\n\nСоберите пост, выберите каналы, настройте подписи, кнопки, рекламу и время выхода.\n━━━━━━━━━━━━━━`, attachments: kbPosting() });
}

async function editChannelSelect(callbackId, key, draft, multi = false) {
  await refreshAllChannelsMeta();
  const channels = await getChannels();
  if (!channels.length) {
    await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n📡 **Каналы не подключены**\n\nДобавьте LinkRay в администраторы канала и выдайте право публикации.\n━━━━━━━━━━━━━━`, attachments: inlineKeyboard([[callbackButton('➕ Как подключить канал', 'post:add_channel')], [callbackButton('⬅️ Назад', 'post:back')]]) });
    return;
  }
  await setSession(key, multi ? 'select_channels_multi' : 'select_channel', { draft });
  await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n📡 **Куда выпустить пост**\n\nВыберите канал. Уже добавленный материал и настройки сохранятся при смене канала.\n━━━━━━━━━━━━━━`, attachments: kbChannelSelect(channels, draft.channelIds, multi) });
}


async function sendChannelSelect(chatId, key, draft, multi = false) {
  await refreshAllChannelsMeta();
  const channels = await getChannels();

  if (!channels.length) {
    await sendMaxMessage({
      chatId,
      text: `━━━━━━━━━━━━━━\n📡 **Каналы не подключены**\n\nДобавьте LinkRay в администраторы канала и выдайте право публикации.\n━━━━━━━━━━━━━━`,
      attachments: inlineKeyboard([[callbackButton('➕ Как подключить канал', 'post:add_channel')], [callbackButton('⬅️ Назад', 'post:back')]]),
    });
    return;
  }

  await setSession(key, multi ? 'select_channels_multi' : 'select_channel', { draft });
  await sendMaxMessage({
    chatId,
    text: `━━━━━━━━━━━━━━\n📡 **Куда выпустить пост**\n\nВыберите канал. Материал и настройки сохранятся.\n━━━━━━━━━━━━━━`,
    attachments: kbChannelSelect(channels, draft.channelIds, multi),
  });
}

async function editWaitContent(callbackId, key, draft) {
  const channels = await getChannelsByIds(draft.channelIds);
  await setSession(key, 'wait_post_content', { draft });
  const rows = [
    ...channelLinkRows(channels),
    [callbackButton('⬅️ Назад', 'post:back')],
    [callbackButton('❌ Отмена', 'post:cancel')],
  ];

  await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n📨 **Пришлите материал**\n\nКаналы:\n${channelsPlainList(channels)}\n\nМожно отправить текст, фото, видео, файл или пересланный пост.\n━━━━━━━━━━━━━━`, attachments: inlineKeyboard(rows) });
}

async function sendPreview(chatId, draft) {
  // Показываем материал как обычный пост LinkRay, без системной плашки MAX «Переслано».
  const text = buildPreviewText(draft);
  const attachments = buildPostAttachments(draft);
  const hasText = normalizeUserText(text).trim() && normalizeUserText(text).trim() !== ' ';
  const hasAttachments = attachments.length > 0;

  if (!hasText && !hasAttachments) return;

  try {
    await sendMaxMessage({ chatId, text, format: draftFormat(draft), attachments, notify: false });
  } catch (error) {
    console.error('[preview] failed with attachments:', error.message || error);
    try {
      await sendMaxMessage({ chatId, text, format: draftFormat(draft), attachments: [], notify: false });
    } catch (fallbackError) {
      console.error('[preview] failed without attachments:', fallbackError.message || fallbackError);
    }
  }
}
async function sendStudio(chatId, key, draft, options = {}) {
  await setSession(key, 'post_editor', { draft });
  if (options.preview) {
    await sendPreview(chatId, draft);
  }
  await sendMaxMessage({ chatId, text: await renderStudioText(draft), attachments: kbEditor(draft) });
}

async function editStudio(callbackId, key, draft) {
  await setSession(key, 'post_editor', { draft });
  await answerCallback({ callbackId, text: await renderStudioText(draft), attachments: kbEditor(draft) });
}

async function editPublish(callbackId, key, draft) {
  await setSession(key, 'publish_settings', { draft });
  await answerCallback({ callbackId, text: await renderPublishText(draft), attachments: kbPublish(draft) });
}

async function editPrompt(callbackId, key, state, draft, text, back = 'post:back') {
  await setSession(key, state, { draft });
  await answerCallback({ callbackId, text, attachments: kbBackCancel(back) });
}

async function sendPrompt(chatId, key, state, draft, text, back = 'post:back') {
  await setSession(key, state, { draft });
  await sendMaxMessage({ chatId, text, attachments: kbBackCancel(back) });
}


function timeLabelFromDate(date) {
  const p = mskParts(date);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

async function getQuickTimes(key) {
  const rows = await query(
    `SELECT time_text FROM user_quick_times WHERE owner_key = $1 ORDER BY used_at DESC LIMIT 6`,
    [String(key)]
  );
  return rows.map((row) => row.time_text);
}

async function saveQuickTime(key, timeText) {
  if (!/^\d{2}:\d{2}$/.test(String(timeText || ''))) return;
  await query(
    `
    INSERT INTO user_quick_times (owner_key, time_text, used_at)
    VALUES ($1, $2, now())
    ON CONFLICT (owner_key, time_text)
    DO UPDATE SET used_at = now()
    `,
    [String(key), String(timeText)]
  );
}

async function publishNow(draft) {
  const channels = await getChannelsByIds(draft.channelIds);
  const results = [];
  for (const channel of channels) {
    try {
      await sendMaxMessage({ chatId: channel.max_chat_id, text: buildPostTextForChannel(draft, channel.id), format: draftFormat(draft), attachments: buildPostAttachments(draft), notify: draft.notify });
      results.push({ channel, ok: true });
    } catch (error) {
      console.error('[publish] failed:', channel.max_chat_id, error.message || error);
      results.push({ channel, ok: false, error: error.message });
    }
  }
  return results;
}

async function scheduleDraft(draft, key, publishAt) {
  const channels = await getChannelsByIds(draft.channelIds);
  for (const channel of channels) {
    await query(
      `
      INSERT INTO scheduled_posts (
        channel_id, text, format, publish_at, notify, created_by_max_user_id,
        attachments, buttons, draft, is_ad, cpm, auto_delete_minutes, report_after_hours, status, updated_at
      )
      VALUES ($1, $2, $13, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, 'scheduled', now())
      `,
      [
        channel.id,
        buildPostTextForChannel(draft, channel.id),
        publishAt.toISOString(),
        draft.notify,
        String(key),
        JSON.stringify(normalizeAttachmentsForSend(draft.content?.attachments || [])),
        JSON.stringify(draft.buttons || []),
        JSON.stringify(draft),
        draft.isAd,
        draft.cpm,
        draft.autoDeleteMinutes,
        draft.reportAfterHours || 24,
        draftFormat(draft),
      ]
    );
  }
}

async function textScheduled(draft, publishAt) {
  const channels = await getChannelsByIds(draft.channelIds);
  const ad = draft.isAd ? `да${draft.cpm ? ` · CPM ${draft.cpm} ₽` : ''}` : 'нет';
  const title = previewText(buildPreviewText(draft), 70);

  return `━━━━━━━━━━━━━━
✅ **Публикация запланирована**

📝 Сообщение «${title}»

📅 **Статус:** отложено
🕒 **Публикация:** ${formatMsk(publishAt)} МСК

📣 **Каналы:**
${channelsPlainList(channels)}

🗑 **Автоудаление:** ${draft.autoDeleteMinutes ? formatMinutes(draft.autoDeleteMinutes) : 'нет'}
📊 **Отчёт:** через ${draft.reportAfterHours || 24}ч после публикации
💼 **Реклама:** ${ad}

Пост добавлен в очередь LinkRay.
━━━━━━━━━━━━━━`;
}
async function getQueueRows(channelId = null) {
  const params = [];
  let whereChannel = '';
  if (channelId) {
    params.push(Number(channelId));
    whereChannel = `AND sp.channel_id = $${params.length}`;
  }
  return query(
    `
    SELECT sp.id, sp.channel_id, sp.text, sp.publish_at, sp.status, sp.notify, sp.is_ad, sp.cpm, sp.auto_delete_minutes,
           c.title AS channel_title, c.link AS channel_link
    FROM scheduled_posts sp
    JOIN channels c ON c.id = sp.channel_id
    WHERE COALESCE(sp.status, 'scheduled') IN ('scheduled', 'error')
      AND sp.publish_at >= now() - interval '1 hour'
      ${whereChannel}
    ORDER BY sp.publish_at ASC, sp.id ASC
    LIMIT 30
    `,
    params
  );
}

async function editQueueMenu(callbackId) {
  const channels = await getChannels();
  const rows = [[callbackButton('🌐 Все каналы', 'queue:all')]];
  rows.push(...buttonRowsForChannels(channels, 'queue:channel'));
  rows.push([callbackButton('⬅️ В Studio', 'main:posting')]);
  await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n📅 **Очередь публикаций**\n\nВыберите канал, чтобы посмотреть отложенные посты.\n━━━━━━━━━━━━━━`, attachments: inlineKeyboard(rows) });
}

async function editQueueList(callbackId, channelId = null) {
  const rows = await getQueueRows(channelId);
  if (!rows.length) {
    await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n📅 **Очередь пуста**\n\nДля выбранного режима нет отложенных публикаций.\n━━━━━━━━━━━━━━`, attachments: inlineKeyboard([[callbackButton('⬅️ Назад', 'queue:menu')], [callbackButton('🧩 Собрать пост', 'post:create')]]) });
    return;
  }
  const text = rows.map((row, index) => `${index + 1}. ${row.channel_title || 'Канал'}\n   ${formatMsk(new Date(row.publish_at))}\n   ${previewText(row.text, 80)}`).join('\n\n');
  const buttons = rows.slice(0, 12).map((row, index) => [callbackButton(`${index + 1}. ${row.channel_title || 'Канал'} · ${formatMsk(new Date(row.publish_at)).slice(0, 17)}`, `queue:post:${row.id}`)]);
  buttons.push([callbackButton('⬅️ К каналам', 'queue:menu')]);
  await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n📅 **Очередь публикаций**\n\n${text}\n━━━━━━━━━━━━━━`, attachments: inlineKeyboard(buttons) });
}

async function editQueuePost(callbackId, postId) {
  const rows = await query(
    `
    SELECT sp.*, c.title AS channel_title, c.link AS channel_link
    FROM scheduled_posts sp
    JOIN channels c ON c.id = sp.channel_id
    WHERE sp.id = $1
    `,
    [Number(postId)]
  );
  const post = rows[0];
  if (!post) {
    await answerCallback({ callbackId, text: 'Пост не найден.', attachments: inlineKeyboard([[callbackButton('⬅️ Назад', 'queue:menu')]]) });
    return;
  }
  const ad = post.is_ad ? `да${post.cpm ? ` · CPM ${post.cpm} ₽` : ''}` : 'нет';
  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━\n🧾 **Публикация #${post.id}**\n\n📡 Канал: ${post.channel_title || 'Канал'}\n🕒 Время: ${formatMsk(new Date(post.publish_at))}\n⏳ Статус: ${post.status || 'scheduled'}\n🗑 Автоудаление: ${post.auto_delete_minutes ? formatMinutes(post.auto_delete_minutes) : 'нет'}\n💼 Реклама: ${ad}\n\nТекст:\n${previewText(post.text, 500)}\n━━━━━━━━━━━━━━`,
    attachments: inlineKeyboard([
      [callbackButton('✏️ Изменить текст', `queueedit:text:${post.id}`), callbackButton('🕒 Изменить время', `queueedit:time:${post.id}`)],
      [callbackButton('🚀 Опубликовать сейчас', `queue:now:${post.id}`)],
      [callbackButton('🗑 Отменить публикацию', `queue:cancel:${post.id}`)],
      [callbackButton('⬅️ К очереди', 'queue:all')],
    ]),
  });
}

async function handleMessage(update) {
  const chatId = getChatId(update);
  const key = getSessionKey(update);
  const text = normalizeUserText(getMessageText(update));

  console.log('[message]', JSON.stringify({ chatId, key, text }));
  await writeFile('/tmp/linkray_last_update.json', JSON.stringify(update, null, 2)).catch(() => {});

  if (!chatId || !key) return;

  const session = await getSession(key);
  const draft = safeDraft(session.data);

  if (session.state === 'wait_post_content') {
    draft.content = await extractContentWithHydration(update);
    draft.content.text = normalizeUserText(draft.content.text);
    await sendStudio(chatId, key, draft, { preview: true });
    return;
  }

  if (session.state === 'edit_text') {
    draft.content.exactForward = false;
    draft.content.text = text;
    await sendStudio(chatId, key, draft, { preview: true });
    return;
  }

  if (session.state === 'add_media') {
    const content = await extractContentWithHydration(update);
    if (!content.attachments.length) {
      await sendPrompt(chatId, key, 'add_media', draft, `━━━━━━━━━━━━━━\n🖼 **Медиа**\n\nОтправьте фото, видео или файл.\n━━━━━━━━━━━━━━`);
      return;
    }
    draft.content.exactForward = false;
    draft.content.forwardMid = null;
    draft.content.attachments = content.attachments;
    draft.content.kind = 'media';
    if (content.text) draft.content.text = content.text;
    await sendStudio(chatId, key, draft, { preview: true });
    return;
  }

  if (session.state === 'add_button') {
    const button = parsePostButton(text);
    if (!button) {
      await sendPrompt(chatId, key, 'add_button', draft, `━━━━━━━━━━━━━━\n🔘 **Кнопка под пост**\n\nФормат:\nНазвание кнопки - ссылка\n\nПример:\nОткрыть канал - https://example.com\n━━━━━━━━━━━━━━`);
      return;
    }
    draft.content.exactForward = false;
    draft.buttons.push(button);
    await sendStudio(chatId, key, draft, { preview: true });
    return;
  }

  if (session.state === 'wait_signature') {
    const channelId = String(draft.activeSignatureChannelId || draft.channelIds[0]);
    if (!channelId) {
      await sendStudio(chatId, key, draft);
      return;
    }
    draft.content.exactForward = false;
    draft.signaturesByChannel[channelId] = text;
    draft.signatureEnabledByChannel[channelId] = true;
    try {
      await saveSharedSignature(Number(channelId), text);
    } catch (error) {
      console.error('[signature] save failed:', error.message || error);
    }
    await sendStudio(chatId, key, draft, { preview: true });
    return;
  }

  if (session.state === 'wait_cpm') {
    const cpm = parseCpm(text);
    if (!cpm) {
      await sendPrompt(chatId, key, 'wait_cpm', draft, `━━━━━━━━━━━━━━\n💰 **CPM**\n\nВведите число, например: 1000\n━━━━━━━━━━━━━━`);
      return;
    }
    draft.isAd = true;
    draft.cpm = cpm;
    await sendStudio(chatId, key, draft, { preview: false });
    return;
  }

  if (session.state === 'wait_schedule_time') {
    const publishAt = parsePublishTime(text, draft);
    if (!publishAt) {
      await sendPrompt(chatId, key, 'wait_schedule_time', draft, `━━━━━━━━━━━━━━\n🕒 **Время публикации**\n\nНе понял время.\n\nПримеры:\n18:30\n0235\nчерез 1 минуту\n2026-06-23 18:30\n━━━━━━━━━━━━━━`, 'schedule:back');
      return;
    }
    draft.lastTime = timeLabelFromDate(publishAt);
    await saveQuickTime(key, draft.lastTime);
    await scheduleDraft(draft, key, publishAt);
    await clearSession(key);
    await sendMaxMessage({ chatId, text: await textScheduled(draft, publishAt), attachments: kbFinal() });
    return;
  }

  if (session.state?.startsWith('queue_edit_text:')) {
    const id = Number(session.state.split(':')[1]);
    await query('UPDATE scheduled_posts SET text = $2, updated_at = now() WHERE id = $1', [id, text]);
    await clearSession(key);
    await sendMaxMessage({ chatId, text: `✅ Текст публикации #${id} обновлён.`, attachments: inlineKeyboard([[callbackButton('📅 Открыть очередь', 'queue:all')]]) });
    return;
  }

  if (session.state?.startsWith('queue_edit_time:')) {
    const id = Number(session.state.split(':')[1]);
    const publishAt = parsePublishTime(text, draft);
    if (!publishAt) {
      await sendPrompt(chatId, key, session.state, draft, `Не понял время. Пример: 18:30 или 2026-06-23 18:30`, 'queue:all');
      return;
    }
    await query('UPDATE scheduled_posts SET publish_at = $2, status = $3, updated_at = now() WHERE id = $1', [id, publishAt.toISOString(), 'scheduled']);
    await saveQuickTime(key, timeLabelFromDate(publishAt));
    await clearSession(key);
    await sendMaxMessage({ chatId, text: `✅ Время публикации #${id} изменено на ${formatMsk(publishAt)} МСК.`, attachments: inlineKeyboard([[callbackButton('📅 Открыть очередь', 'queue:all')]]) });
    return;
  }

  if (text === '/start' || norm(text) === 'меню') {
    await clearSession(key);
    await sendMainMenu(chatId);
    return;
  }

  if (includesText(text, 'постинг') || includesText(text, 'публикации')) {
    await sendPosting(chatId, key);
    return;
  }

  const incomingContent = await extractContentWithHydration(update);
  if (incomingContent.text || incomingContent.attachments.length || incomingContent.kind === 'forwarded') {
    const newDraft = emptyDraft();
    newDraft.content = incomingContent;
    newDraft.content.text = normalizeUserText(newDraft.content.text);
    await setSession(key, 'select_channel', { draft: newDraft });
    await sendPreview(chatId, newDraft);
    await sendChannelSelect(chatId, key, newDraft, false);
    return;
  }

  await sendMaxMessage({ chatId, text: `━━━━━━━━━━━━━━
Команда не распознана. Откройте меню ниже.
━━━━━━━━━━━━━━`, attachments: kbMain() });
}

async function handleCallback(update) {
  const callbackId = getCallbackId(update);
  const payload = getCallbackPayload(update);
  const key = getSessionKey(update);

  console.log('[callback]', JSON.stringify({ callbackId, key, payload }));
  await writeFile('/tmp/linkray_last_callback.json', JSON.stringify(update, null, 2)).catch(() => {});
  if (!callbackId || !key) return;

  const session = await getSession(key);
  let draft = safeDraft(session.data);

  if (payload === 'main:menu') { await clearSession(key); await editMainMenu(callbackId); return; }
  if (payload === 'main:posting') { await editPosting(callbackId, key); return; }
  if (payload === 'main:stub') { await answerCallback({ callbackId, text: 'Раздел готовится. Сейчас активна студия публикаций.', attachments: kbMain() }); return; }

  if (payload === 'post:cancel') { await clearSession(key); await answerCallback({ callbackId, text: '❌ Действие отменено.', attachments: kbPosting() }); return; }
  if (payload === 'post:back') { await editPosting(callbackId, key); return; }

  if (payload === 'post:create') { draft = emptyDraft(); await editChannelSelect(callbackId, key, draft, false); return; }
  if (payload === 'post:multi') { await editChannelSelect(callbackId, key, draft, true); return; }
  if (payload.startsWith('post:toggle:')) {
    const id = Number(payload.split(':')[2]);
    const set = new Set(draft.channelIds.map(Number));
    if (set.has(id)) set.delete(id); else set.add(id);
    draft.channelIds = [...set];
    await editChannelSelect(callbackId, key, draft, true);
    return;
  }
  if (payload === 'post:multi_next') { if (!draft.channelIds.length) await editChannelSelect(callbackId, key, draft, true); else { await loadSharedSignatures(draft); if (hasDraftContent(draft)) await editStudio(callbackId, key, draft); else await editWaitContent(callbackId, key, draft); } return; }
  if (payload === 'post:all') { const channels = await getChannels(); draft.channelIds = channels.map((c) => Number(c.id)); await loadSharedSignatures(draft); if (hasDraftContent(draft)) await editStudio(callbackId, key, draft); else await editWaitContent(callbackId, key, draft); return; }
  if (payload.startsWith('post:single:')) { draft.channelIds = [Number(payload.split(':')[2])]; await loadSharedSignatures(draft); if (hasDraftContent(draft)) await editStudio(callbackId, key, draft); else await editWaitContent(callbackId, key, draft); return; }
  if (payload === 'post:add_channel') {
    await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n➕ **Подключить канал**\n\n1. Откройте канал в MAX\n2. Добавьте LinkRay в администраторы\n3. Выдайте право публикации\n4. Вернитесь и откройте «Мои каналы»\n━━━━━━━━━━━━━━`, attachments: inlineKeyboard([[callbackButton('📡 Мои каналы', 'post:channels')], [callbackButton('⬅️ Назад', 'main:posting')]]) });
    return;
  }
  if (payload === 'post:channels') {
    await refreshAllChannelsMeta();
    const channels = await getChannels();
    const linkRows = channelLinkRows(channels);
    await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n📡 **Мои каналы**\n\n${channelsPlainList(channels)}\n━━━━━━━━━━━━━━`, attachments: inlineKeyboard([...linkRows, [callbackButton('🧩 Собрать пост', 'post:create')], [callbackButton('⬅️ Назад', 'main:posting')]]) });
    return;
  }

  if (payload === 'editor:text') { await editPrompt(callbackId, key, 'edit_text', draft, `━━━━━━━━━━━━━━\n✏️ **Текст**\n\nОтправьте новый текст поста.\n━━━━━━━━━━━━━━`); return; }
  if (payload === 'editor:media') { await editPrompt(callbackId, key, 'add_media', draft, `━━━━━━━━━━━━━━\n🖼 **Медиа**\n\nОтправьте фото, видео или файл.\n━━━━━━━━━━━━━━`); return; }
  if (payload === 'editor:button') { await editPrompt(callbackId, key, 'add_button', draft, `━━━━━━━━━━━━━━\n🔘 **Кнопка под пост**\n\nФормат:\nНазвание кнопки - ссылка\n━━━━━━━━━━━━━━`); return; }
  if (payload === 'editor:channels') { await editChannelSelect(callbackId, key, draft, false); return; }
  if (payload === 'editor:ad') { draft.isAd = !draft.isAd; if (!draft.isAd) draft.cpm = null; await editStudio(callbackId, key, draft); return; }
  if (payload === 'editor:cpm') { await editPrompt(callbackId, key, 'wait_cpm', draft, `━━━━━━━━━━━━━━\n💰 **CPM**\n\nВведите цену за 1000 просмотров.\n━━━━━━━━━━━━━━`); return; }
  if (payload === 'editor:next') { if (!draft.channelIds.length) await editChannelSelect(callbackId, key, draft, false); else { await loadSharedSignatures(draft); await editPublish(callbackId, key, draft); } return; }

  if (payload === 'sig:menu') {
    if (!draft.channelIds.length) { await editChannelSelect(callbackId, key, draft, false); return; }
    const channels = await getChannelsByIds(draft.channelIds);
    const rows = channels.map((channel) => [callbackButton(`🏷 ${channelName(channel)}`, `sig:channel:${channel.id}`)]);
    rows.push([callbackButton('⬅️ В Studio', 'sig:back')]);
    await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n🏷 **Подписи по каналам**\n\nВыберите канал. Для каждого канала хранится своя подпись.\n━━━━━━━━━━━━━━`, attachments: inlineKeyboard(rows) });
    return;
  }
  if (payload === 'sig:back') { await editStudio(callbackId, key, draft); return; }
  if (payload.startsWith('sig:channel:')) {
    const channelId = Number(payload.split(':')[2]);
    draft.activeSignatureChannelId = channelId;
    const channel = await getChannel(channelId);
    const sig = draft.signaturesByChannel[String(channelId)];
    const enabled = draft.signatureEnabledByChannel[String(channelId)] !== false;
    await setSession(key, 'signature_channel', { draft });
    await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n🏷 **${channelName(channel)}**\n\nСтатус: ${sig ? (enabled ? 'включена' : 'выключена') : 'не создана'}\n\n${sig ? `Текст:\n${sig}` : 'Создайте подпись для этого канала.'}\n━━━━━━━━━━━━━━`, attachments: inlineKeyboard([[callbackButton(sig ? '✏️ Заменить подпись' : '➕ Создать подпись', 'sig:add')], [callbackButton(enabled ? '🚫 Выключить' : '✅ Включить', 'sig:toggle')], [callbackButton('⬅️ К подписям', 'sig:menu')]]) });
    return;
  }
  if (payload === 'sig:add') { await editPrompt(callbackId, key, 'wait_signature', draft, `━━━━━━━━━━━━━━\n🏷 **Новая подпись**\n\nОтправьте текст подписи. Она сразу включится для выбранного канала.\n━━━━━━━━━━━━━━`, 'sig:menu'); return; }
  if (payload === 'sig:toggle') {
    const channelId = String(draft.activeSignatureChannelId || draft.channelIds[0]);
    draft.signatureEnabledByChannel[channelId] = draft.signatureEnabledByChannel[channelId] === false;
    await setSharedSignatureActive(Number(channelId), draft.signatureEnabledByChannel[channelId] !== false).catch((error) => console.error('[signature] toggle save failed:', error.message || error));
    await editStudio(callbackId, key, draft);
    return;
  }

  if (payload === 'publish:back') { await editStudio(callbackId, key, draft); return; }
  if (payload === 'publish:sound') { draft.notify = !draft.notify; await editPublish(callbackId, key, draft); return; }
  if (payload === 'publish:auto_delete') { await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n🗑 **Автоудаление**\n\nВыберите срок.\n━━━━━━━━━━━━━━`, attachments: kbAutoDelete() }); return; }
  if (payload.startsWith('autodel:')) {
    const value = payload.split(':')[1];
    if (value === 'back') { await editPublish(callbackId, key, draft); return; }
    draft.autoDeleteMinutes = value === 'none' ? null : Number(value);
    await editPublish(callbackId, key, draft);
    return;
  }
  if (payload === 'schedule:calendar') {
    const p = mskParts();
    draft.calendarYear = draft.calendarYear || p.year;
    draft.calendarMonth = draft.calendarMonth || p.month;
    await setSession(key, 'calendar', { draft });
    await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n📆 **Календарь выпуска**\n\nВыберите дату публикации.\n━━━━━━━━━━━━━━`, attachments: kbCalendar(draft.calendarYear, draft.calendarMonth) });
    return;
  }
  if (payload.startsWith('cal:month:')) {
    const [, , monthPart] = payload.split(':');
    const [rawYear, rawMonth] = monthPart.split('-').map(Number);
    draft.calendarYear = rawYear;
    draft.calendarMonth = rawMonth;
    await setSession(key, 'calendar', { draft });
    await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n📆 **Календарь выпуска**\n\nВыберите дату публикации.\n━━━━━━━━━━━━━━`, attachments: kbCalendar(draft.calendarYear, draft.calendarMonth) });
    return;
  }
  if (payload.startsWith('cal:day:')) {
    draft.scheduleDate = payload.replace('cal:day:', '');
    await setSession(key, 'calendar_time', { draft });
    const quickTimes = await getQuickTimes(key);
    const hint = quickTimes.length ? 'Можно выбрать время, которое вы уже использовали, или ввести новое.' : 'Вы ещё не выбирали время. Введите его вручную, и оно появится здесь в следующий раз.';
    await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n🕒 **Дата выбрана**\n\nДата: ${draft.scheduleDate}\n${hint}\n━━━━━━━━━━━━━━`, attachments: kbTimeAfterDate(quickTimes) });
    return;
  }
  if (payload === 'cal:noop') return;
  if (payload === 'schedule:manual') { await editPrompt(callbackId, key, 'wait_schedule_time', draft, `━━━━━━━━━━━━━━\n🕒 **Время выпуска**\n\nВведите время: 18:30, 0235, через 1 минуту или 2026-06-23 18:30.\n━━━━━━━━━━━━━━`, 'schedule:back'); return; }
  if (payload === 'schedule:back') { await editPublish(callbackId, key, draft); return; }
  if (payload.startsWith('time:quick:')) {
    const time = payload.replace('time:quick:', '');
    const publishAt = parsePublishTime(time, draft);
    await saveQuickTime(key, time);
    await scheduleDraft(draft, key, publishAt);
    await clearSession(key);
    await answerCallback({ callbackId, text: await textScheduled(draft, publishAt), attachments: kbFinal() });
    return;
  }
  if (payload === 'publish:now') {
    const results = await publishNow(draft);
    const ok = results.filter((r) => r.ok).length;
    const channels = await getChannelsByIds(draft.channelIds);
    await clearSession(key);
    await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n✅ **Пост опубликован**\n\n📡 Каналы:\n${channelsPlainList(channels)}\n\nОпубликовано: ${ok} из ${results.length}\n━━━━━━━━━━━━━━`, attachments: kbFinal() });
    return;
  }

  if (payload === 'queue:menu') { await editQueueMenu(callbackId); return; }
  if (payload === 'queue:all') { await editQueueList(callbackId); return; }
  if (payload.startsWith('queue:channel:')) { await editQueueList(callbackId, Number(payload.split(':')[2])); return; }
  if (payload.startsWith('queue:post:')) { await editQueuePost(callbackId, Number(payload.split(':')[2])); return; }
  if (payload.startsWith('queueedit:text:')) { const id = Number(payload.split(':')[2]); await setSession(key, `queue_edit_text:${id}`, {}); await answerCallback({ callbackId, text: `Отправьте новый текст для публикации #${id}.`, attachments: kbBackCancel('queue:all') }); return; }
  if (payload.startsWith('queueedit:time:')) { const id = Number(payload.split(':')[2]); await setSession(key, `queue_edit_time:${id}`, {}); await answerCallback({ callbackId, text: `Отправьте новое время для публикации #${id}.`, attachments: kbBackCancel('queue:all') }); return; }
  if (payload.startsWith('queue:cancel:')) { const id = Number(payload.split(':')[2]); await query('UPDATE scheduled_posts SET status = $2, updated_at = now() WHERE id = $1', [id, 'canceled']); await answerCallback({ callbackId, text: `🗑 Публикация #${id} отменена.`, attachments: inlineKeyboard([[callbackButton('📅 Очередь', 'queue:all')]]) }); return; }
  if (payload.startsWith('queue:now:')) {
    const id = Number(payload.split(':')[2]);
    await query('UPDATE scheduled_posts SET publish_at = now(), status = $2, updated_at = now() WHERE id = $1', [id, 'scheduled']);
    await answerCallback({ callbackId, text: `🚀 Публикация #${id} отправлена на ближайшую публикацию.`, attachments: inlineKeyboard([[callbackButton('📅 Очередь', 'queue:all')]]) });
    return;
  }

  await answerCallback({ callbackId, text: 'Команда пока не обработана.', attachments: kbMain() });
}

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1 AS ok');
    res.json({ ok: true, service: 'linkray-bot', db: true, time: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, db: false, error: error.message });
  }
});

app.post('/webhook', async (req, res) => {
  const incomingSecret = req.header('X-Max-Bot-Api-Secret');
  if (process.env.WEBHOOK_SECRET && incomingSecret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ ok: false });
  res.json({ ok: true });

  try {
    const update = req.body;
    const updateType = getUpdateType(update);
    const chatId = getChatId(update);
    const key = getSessionKey(update);
    console.log('[webhook]', JSON.stringify({ updateType, chatId, key }));

    if (updateType === 'bot_added' && chatId) {
      const apiChat = await getMaxChatInfo(chatId).catch((error) => { console.error('[bot_added get chat] failed:', error.message || error); return null; });
      const title = getChatTitle(update) || apiChat?.title || apiChat?.name || apiChat?.chat?.title || apiChat?.chat?.name || null;
      const link = getChatLink(update) || apiChat?.link || apiChat?.invite_link || apiChat?.inviteLink || apiChat?.chat?.link || null;
      const isPublic = Boolean(apiChat?.is_public ?? apiChat?.isPublic ?? link);
      await query(
        `
        INSERT INTO channels (max_chat_id, owner_max_user_id, title, link, is_public, is_channel, bot_added_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (max_chat_id)
        DO UPDATE SET owner_max_user_id = EXCLUDED.owner_max_user_id, title = COALESCE(EXCLUDED.title, channels.title), link = EXCLUDED.link, is_public = EXCLUDED.is_public, is_channel = EXCLUDED.is_channel, bot_added_at = now()
        `,
        [chatId, getRawUserId(update), title, link, isPublic, update.is_channel ?? true]
      );
      return;
    }

    if (updateType === 'bot_started') { if (chatId) await sendMainMenu(chatId); return; }
    if (updateType === 'message_callback' || updateType === 'callback' || updateType.includes('callback') || getCallbackPayload(update)) { await handleCallback(update); return; }
    if (updateType === 'message_created') { await handleMessage(update); return; }
  } catch (error) {
    console.error('[webhook] processing error:', error);
  }
});

const port = Number(process.env.PORT || 3000);

ensureDb()
  .then(() => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`LinkRay bot started on port ${port}`);
      startAutopostWorker();
    });
  })
  .catch((error) => {
    console.error('[startup] failed:', error);
    process.exit(1);
  });
