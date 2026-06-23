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
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'markdown'`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS markup jsonb NOT NULL DEFAULT '[]'::jsonb`);
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
    signatureFormatsByChannel: {},
    signatureMarkupByChannel: {},
    activeSignatureChannelId: null,
    isAd: false,
    cpm: null,

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
    signatureFormatsByChannel: source.signatureFormatsByChannel && typeof source.signatureFormatsByChannel === 'object' ? source.signatureFormatsByChannel : {},
    signatureMarkupByChannel: source.signatureMarkupByChannel && typeof source.signatureMarkupByChannel === 'object' ? source.signatureMarkupByChannel : {},
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
  if (draft?.content?.format === 'html') return 'html';

  const sigFormats = Object.values(draft?.signatureFormatsByChannel || {});
  if (sigFormats.includes('html')) return 'html';

  return 'markdown';
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



async function getChannelById(channelId) {
  const id = Number(channelId);

  if (!id) {
    return null;
  }

  const rows = await query(
    `
    SELECT *
    FROM channels
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function loadSharedSignatures(draft) {
  if (draft?.isAd) return draft;
  draft.signaturesByChannel = draft.signaturesByChannel || {};
  draft.signatureEnabledByChannel = draft.signatureEnabledByChannel || {};
  draft.signatureFormatsByChannel = draft.signatureFormatsByChannel || {};
  draft.signatureMarkupByChannel = draft.signatureMarkupByChannel || {};

  const ids = [...new Set((draft.channelIds || []).map(Number).filter(Boolean))];

  if (!ids.length) return draft;

  const rows = await query(
    `
    SELECT channel_id, text, format, markup, is_active
    FROM channel_signatures
    WHERE channel_id = ANY($1::int[])
    `,
    [ids]
  );

  for (const row of rows) {
    const id = String(row.channel_id);
    draft.signaturesByChannel[id] = row.text || '';
    draft.signatureEnabledByChannel[id] = row.is_active !== false;
    draft.signatureFormatsByChannel[id] = row.format || (lrLooksLikeHtml(row.text) ? 'html' : 'markdown');
    draft.signatureMarkupByChannel[id] = Array.isArray(row.markup) ? row.markup : [];
  }

  return draft;
}



function lrEscapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrNormalizeSignatureHtml(value) {
  let html = String(value || '');

  // Старый код мог сохранять ссылку и жирный в неверном порядке:
  // <a href="..."><b>текст</a></b>
  // Делаем валидно: <b><a href="...">текст</a></b>
  html = html.replace(/<a\s+href="([^"]+)"><b>([\s\S]*?)<\/a><\/b>/gi, '<b><a href="$1">$2</a></b>');
  html = html.replace(/<a\s+href="([^"]+)"><strong>([\s\S]*?)<\/a><\/strong>/gi, '<strong><a href="$1">$2</a></strong>');
  html = html.replace(/<a\s+href="([^"]+)"><i>([\s\S]*?)<\/a><\/i>/gi, '<i><a href="$1">$2</a></i>');
  html = html.replace(/<a\s+href="([^"]+)"><em>([\s\S]*?)<\/a><\/em>/gi, '<em><a href="$1">$2</a></em>');
  html = html.replace(/<a\s+href="([^"]+)"><u>([\s\S]*?)<\/a><\/u>/gi, '<u><a href="$1">$2</a></u>');

  return html;
}

function lrLooksLikeHtml(value) {
  return /<\/?(a|b|strong|i|em|u|s|strike|code|br)\b/i.test(String(value || ''));
}

async function saveSharedSignature(channelId, text, format = 'markdown', markup = []) {
  const updated = await query(
    `
    UPDATE channel_signatures
    SET
      owner_key = 'shared',
      title = 'Автоподпись',
      text = $2,
      format = $3,
      markup = $4::jsonb,
      is_active = true,
      updated_at = now()
    WHERE channel_id = $1
    RETURNING channel_id
    `,
    [
      Number(channelId),
      String(text || ''),
      format === 'html' ? 'html' : 'markdown',
      JSON.stringify(Array.isArray(markup) ? markup : []),
    ]
  );

  if (updated.length) return;

  await query(
    `
    INSERT INTO channel_signatures
      (channel_id, owner_key, title, text, format, markup, is_active, created_at, updated_at)
    VALUES
      ($1, 'shared', 'Автоподпись', $2, $3, $4::jsonb, true, now(), now())
    `,
    [
      Number(channelId),
      String(text || ''),
      format === 'html' ? 'html' : 'markdown',
      JSON.stringify(Array.isArray(markup) ? markup : []),
    ]
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
    [callbackButton('📡 Каналы', 'post:channels')],
    [callbackButton('📊 Отчёты', 'reports:menu'), callbackButton('🛡 Антифрод', 'antifraud:menu')],
  ]);
}


function kbPosting() {
  return inlineKeyboard([
    [callbackButton('🧩 Собрать пост', 'post:create')],
    [callbackButton('🗂 Посты', 'queue:menu')],
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
    [callbackButton(draft.autoDeleteMinutes ? `🗑 ${formatMinutes(draft.autoDeleteMinutes)}` : '🗑 Автоудаление', 'publish:auto_delete')],
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
    [callbackButton('🗂 Посты', 'queue:menu')],
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


function lrMskParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function lrUtcFromMsk(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 3, Number(minute), Number(second)));
}

function lrAddMskDays(parts, days) {
  const utc = lrUtcFromMsk(parts.year, parts.month, parts.day + Number(days || 0), 0, 0, 0);
  return lrMskParts(utc);
}

function lrParseScheduleInput(input, draft = {}) {
  const raw = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return null;

  const now = new Date();
  const nowMs = now.getTime();
  const nowMsk = lrMskParts(now);

  let m;

  // через 1 минуту / через 2 часа / через 3 дня
  m = raw.match(/^через\s+(\d+)\s*(мин|минута|минуту|минуты|минут|час|часа|часов|ч|день|дня|дней|д)$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    if (unit.startsWith('мин')) return new Date(nowMs + n * 60 * 1000);
    if (unit.startsWith('час') || unit === 'ч') return new Date(nowMs + n * 60 * 60 * 1000);
    return new Date(nowMs + n * 24 * 60 * 60 * 1000);
  }

  // 2026-06-23 18:30 или 2026-06-23T18:30
  m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ t]+(\d{1,2})[:\s](\d{2})(?::(\d{2}))?$/);
  if (m) {
    return lrUtcFromMsk(m[1], m[2], m[3], m[4], m[5], m[6] || 0);
  }

  // 23.06 18:30 или 23.06.2026 18:30
  m = raw.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2})[:\s](\d{2})(?::(\d{2}))?$/);
  if (m) {
    const year = m[3] || nowMsk.year;
    let candidate = lrUtcFromMsk(year, m[2], m[1], m[4], m[5], m[6] || 0);
    if (!m[3] && candidate.getTime() <= nowMs) {
      candidate = lrUtcFromMsk(Number(year) + 1, m[2], m[1], m[4], m[5], m[6] || 0);
    }
    return candidate;
  }

  let dayParts = null;
  let timePart = raw;

  if (raw.startsWith('завтра ')) {
    dayParts = lrAddMskDays(nowMsk, 1);
    timePart = raw.replace(/^завтра\s+/, '').trim();
  } else if (raw.startsWith('сегодня ')) {
    dayParts = nowMsk;
    timePart = raw.replace(/^сегодня\s+/, '').trim();
  } else if (draft?.scheduleDate) {
    const dm = String(draft.scheduleDate).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (dm) {
      dayParts = { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) };
    }
  }

  // 0235 / 2346 / 02 35 / 02:35 / 02:35:54
  m = timePart.match(/^(\d{1,2})[:\s](\d{2})(?::(\d{2}))?$/);
  if (!m && /^\d{3,4}$/.test(timePart)) {
    const padded = timePart.padStart(4, '0');
    m = [timePart, padded.slice(0, 2), padded.slice(2, 4), '0'];
  }

  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    const second = Number(m[3] || 0);

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
      return null;
    }

    if (!dayParts) dayParts = nowMsk;

    let candidate = lrUtcFromMsk(dayParts.year, dayParts.month, dayParts.day, hour, minute, second);

    // Если дата не выбрана явно и время уже прошло — ставим на завтра.
    const explicitDay =
      raw.startsWith('завтра ') ||
      raw.startsWith('сегодня ') ||
      Boolean(draft?.scheduleDate);

    if (!explicitDay && candidate.getTime() <= nowMs + 15 * 1000) {
      const tomorrow = lrAddMskDays(nowMsk, 1);
      candidate = lrUtcFromMsk(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, second);
    }

    return candidate;
  }

  return null;
}


function parsePublishTime(input, draft = {}) {
  return lrParseScheduleInput(input, draft);
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
  if (!draft.isAd && signature && enabled) parts.push(signature);
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


function lrDecodePreviewEntities(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function lrPlainPreview(value, max = 105) {
  const plain = lrDecodePreviewEntities(String(value || ''))
    .replace(/<a\s+[^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<\/?(b|strong|i|em|u|s|strike|code|span|div|p|br)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!plain) return 'пост без текста';
  return plain.length > max ? `${plain.slice(0, max)}...` : plain;
}

function lrChannelTitleSafe(channel) {
  return String(channel?.title || channel?.name || `Канал #${channel?.id || ''}`.trim())
    .replace(/[\[\]\n\r]/g, ' ')
    .trim();
}

function lrChannelLinkSafe(channel) {
  const link = channel?.link || channel?.url || channel?.invite_link || channel?.join_link || '';
  return /^https?:\/\//i.test(String(link)) ? String(link) : '';
}

function lrChannelMarkdownLine(channel) {
  const title = lrChannelTitleSafe(channel);
  const link = lrChannelLinkSafe(channel);
  return link ? `• [${title}](${link})` : `• ${title}`;
}

function lrScheduledWeekday(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    weekday: 'short',
  }).format(date);
}

function lrScheduledDate(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function lrScheduledTime(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function lrMinutesHuman(minutes) {
  const value = Number(minutes);
  if (!value) return 'нет';
  if (value % 1440 === 0) return `${value / 1440}д`;
  if (value % 60 === 0) return `${value / 60}ч`;
  return `${value} мин`;
}



function lrAdBotNotice() {
  return `✨ Рекламное размещение подготовлено через [LinkRay](https://max.ru/se13353901_bot) — автопостинг, очередь публикаций и рекламные отчёты для MAX.`;
}


async function textScheduled(draft, publishAt) {
  const date = new Date(publishAt);
  const channels = await getChannelsByIds(draft.channelIds || []);
  const channelsText = channels.length
    ? channels.map((channel) => lrChannelMarkdownLine(channel)).join('\n')
    : '• каналы не выбраны';

  const rawText =
    draft?.content?.text ||
    draft?.text ||
    draft?.caption ||
    '';

  const preview = lrPlainPreview(rawText, 105);
  const autoDelete = lrMinutesHuman(draft.autoDeleteMinutes);
  const report = draft.reportAfterHours ? `через ${draft.reportAfterHours}ч после публикации` : 'через 24ч после публикации';
  const ad = draft.isAd ? `да${draft.cpm ? ` · CPM ${draft.cpm} ₽` : ''}` : 'нет';
  const adNotice = draft.isAd ? lrAdBotNotice() : '';

  return `━━━━━━━━━━━━━━
✅ **Публикация запланирована**

📝 Сообщение «${preview}»

📅 **Статус:** отложено
🕒 **Публикация:** ${lrScheduledWeekday(date)} ${lrScheduledDate(date)} · ${lrScheduledTime(date)} МСК

📣 **Каналы:**
${channelsText}

🗑 **Автоудаление:** ${autoDelete}
📊 **Отчёт:** ${report}
💼 **Реклама:** ${ad}

${adNotice}
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
  await lr41ShowPosts(callbackId, 'all');
}



async function editQueueList(callbackId, mode = 'all', channelId = null) {
  await lr41ShowPosts(callbackId, mode, channelId);
}



async function editQueuePost(callbackId, key, id, sendPreview = true) {
  await lr41ShowPost(callbackId, key, id, sendPreview);
}



async function handleMessage(update) {
  const chatId = getChatId(update);

    // Не отвечаем на обычные сообщения в каналах.
    // Иначе меню бота может случайно уйти в канал после публикации/событий MAX.
    if (getUpdateType(update) === 'message_created' && Number(chatId) < 0) {
      return res.json({ ok: true, ignored: 'channel_message_created' });
    }

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
    try {
      const localCommandText = String(messageText || getMessageText(update) || '').trim().toLowerCase();

      if (
        localCommandText === '/start' ||
        localCommandText === 'start' ||
        localCommandText === 'старт' ||
        localCommandText === '/menu' ||
        localCommandText === 'меню'
      ) {
        await clearSession(key);
        await sendMainMenu(chatId);
        return;
      }

      const channelId = Number(session.data?.channelId || draft.channelIds?.[0]);

      console.log('[signature] wait hit', JSON.stringify({
        key,
        channelId,
        sessionState: session.state,
        messageText: String(messageText || '').slice(0, 80),
      }));

      await import('node:fs/promises')
        .then(({ writeFile }) => writeFile('/tmp/linkray_last_signature_update.json', JSON.stringify(update, null, 2)))
        .catch(() => {});

      if (!channelId) {
        await clearSession(key);
        await sendMaxMessage({
          chatId,
          text: `━━━━━━━━━━━━━━\n⚠️ **Канал не выбран**\n\nСначала выберите канал, потом создайте подпись.\n━━━━━━━━━━━━━━`,
          attachments: inlineKeyboard([
            [callbackButton('📡 Выбрать канал', 'editor:channels')],
            [callbackButton('🏠 В меню', 'main:home')],
          ]),
        });
        return;
      }

      const rawMarkup =
        (typeof firstMarkupFromKnownPaths === 'function' ? firstMarkupFromKnownPaths(update) : []) ||
        update.message?.body?.markup ||
        update.message?.markup ||
        update.body?.markup ||
        [];

      const rawText =
        getMessageText(update) ||
        update.message?.body?.text ||
        update.message?.text ||
        update.body?.text ||
        (typeof deepFindBestText === 'function' ? deepFindBestText(update.message || update) : '') ||
        '';

      let signatureText = String(rawText || '').trim();
      let signatureFormat = 'markdown';
      const signatureMarkup = Array.isArray(rawMarkup) ? rawMarkup : [];

      if (signatureMarkup.length && typeof applyMaxMarkupToHtml === 'function') {
        signatureText = applyMaxMarkupToHtml(signatureText, signatureMarkup).trim();
        signatureFormat = 'html';
      } else {
        signatureText = normalizeUserText(signatureText);
      }

      if (!signatureText) {
        await sendMaxMessage({
          chatId,
          text: `━━━━━━━━━━━━━━\n🏷 **Подпись пустая**\n\nОтправьте текст подписи ещё раз. Можно использовать ссылки и оформление MAX.\n━━━━━━━━━━━━━━`,
          attachments: inlineKeyboard([
            [callbackButton('⬅️ Назад', 'sig:menu')],
            [callbackButton('❌ Отмена', 'cancel')],
          ]),
        });
        return;
      }

      const id = String(channelId);

      draft.signaturesByChannel = draft.signaturesByChannel || {};
      draft.signatureEnabledByChannel = draft.signatureEnabledByChannel || {};
      draft.signatureFormatsByChannel = draft.signatureFormatsByChannel || {};
      draft.signatureMarkupByChannel = draft.signatureMarkupByChannel || {};

      draft.signaturesByChannel[id] = signatureText;
      draft.signatureEnabledByChannel[id] = true;
      draft.signatureFormatsByChannel[id] = signatureFormat;
      draft.signatureMarkupByChannel[id] = signatureMarkup;

      if (signatureFormat === 'html') {
        draft.content = draft.content || {};
        draft.content.format = 'html';
      }

      await saveSharedSignature(channelId, signatureText, signatureFormat, signatureMarkup);

      await setSession(key, 'post_editor', { draft });

      await sendMaxMessage({
        chatId,
        text: `━━━━━━━━━━━━━━\n✅ **Подпись сохранена**\n\nОна включена для выбранного канала. В посте подпись будет через пустую строку.\n━━━━━━━━━━━━━━`,
      });

      await sendStudio(chatId, key, draft, { preview: true });
      return;
    } catch (error) {
      console.error('[signature] fatal:', error);
      await sendMaxMessage({
        chatId,
        text: `━━━━━━━━━━━━━━\n⚠️ **Ошибка подписи**\n\n${String(error.message || error).slice(0, 600)}\n\nЯ сбросил шаг. Откройте редактор заново.\n━━━━━━━━━━━━━━`,
        attachments: inlineKeyboard([
          [callbackButton('🏠 В меню', 'main:home')],
        ]),
      }).catch(() => {});
      await clearSession(key).catch(() => {});
      return;
    }
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


function lr31BotUrl() {
  return 'https://max.ru/se13353901_bot';
}

function lr31Decode(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function lr31PlainPreview(value, max = 130) {
  const plain = lr31Decode(value)
    .replace(/<a\s+[^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<\/?(b|strong|i|em|u|s|strike|code|span|div|p|br)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!plain) return 'пост без текста';
  return plain.length > max ? `${plain.slice(0, max)}...` : plain;
}

function lr31ChannelTitle(channel) {
  return String(channel?.title || channel?.name || `Канал #${channel?.id || ''}`.trim())
    .replace(/[\[\]\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lr31ChannelUrl(channel) {
  const value = channel?.link || channel?.url || channel?.invite_link || channel?.join_link || '';
  return /^https?:\/\//i.test(String(value)) ? String(value) : '';
}

function lr31ChannelLine(channel) {
  const title = lr31ChannelTitle(channel);
  const url = lr31ChannelUrl(channel);
  return url ? `• [${title}](${url})` : `• ${title}`;
}

function lr31ChannelsList(channels) {
  if (!Array.isArray(channels) || !channels.length) return '• каналы не выбраны';
  return channels.map((channel) => lr31ChannelLine(channel)).join('\n');
}

function lr31PostPreviewFromDraft(draft) {
  return lr31PlainPreview(
    draft?.content?.text ||
    draft?.text ||
    draft?.caption ||
    draft?.preview_text ||
    '',
    145
  );
}

function lr31AfterPublishKeyboard() {
  return inlineKeyboard([
    [callbackButton('🧩 Собрать ещё пост', 'post:create')],
    [callbackButton('🗂 Посты', 'queue:menu')],
    [callbackButton('🏠 В меню', 'main:menu')],
  ]);
}

function lr31MainMenuText() {
  return `━━━━━━━━━━━━━━
🧬 **LinkRay**

Студия публикаций, очередь постов и рекламные отчёты для MAX.

Выберите действие.
━━━━━━━━━━━━━━`;
}

function lr31MainMenuKeyboard() {
  return inlineKeyboard([
    [callbackButton('🧬 LinkRay Studio', 'post:create')],
    [callbackButton('🗂 Посты', 'queue:menu'), callbackButton('📡 Каналы', 'post:channels')],
    [callbackButton('📊 Отчёты', 'reports:menu'), callbackButton('🛡 Антифрод', 'antifraud:menu')],
  ]);
}

function lr31PublishedAdText(draft, channels, ok, total) {
  const preview = lr31PostPreviewFromDraft(draft);
  const cpm = draft?.cpm ? `${draft.cpm} ₽` : 'не указан';
  const botUrl = lr31BotUrl();

  return `━━━━━━━━━━━━━━
✅ **Рекламный пост опубликован**

📝 Сообщение «${preview}»

📣 **Каналы:**
${lr31ChannelsList(channels)}

🚀 **Опубликовано:** ${ok} из ${total}
💼 **Тип:** рекламное размещение
💰 **CPM:** ${cpm}
📊 **Отчёт:** через 24ч после публикации

✨ Размещение подготовлено через [LinkRay](${botUrl}) — автопостинг, очередь публикаций и рекламные отчёты для MAX.
━━━━━━━━━━━━━━`;
}

function lr31PublishedNormalText(draft, channels, ok, total) {
  return `━━━━━━━━━━━━━━
✅ **Пост опубликован**

📣 **Каналы:**
${lr31ChannelsList(channels)}

🚀 **Опубликовано:** ${ok} из ${total}
━━━━━━━━━━━━━━`;
}

async function lr31SendMessageToChat(chatId, text, attachments = null) {
  return sendMaxMessage({
    chatId,
    text,
    format: 'markdown',
    attachments,
  });
}

async function lr31SendMenuAfterPublish(chatId) {
  return lr31SendMessageToChat(chatId, lr31MainMenuText(), lr31MainMenuKeyboard());
}

function lr31AdBotNotice() {
  return `✨ Рекламное размещение подготовлено через [LinkRay](${lr31BotUrl()}) — автопостинг, очередь публикаций и рекламные отчёты для MAX.`;
}


function lr32BotUrl() {
  return 'https://max.ru/se13353901_bot';
}

function lr32Decode(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function lr32StripHtml(value) {
  return lr32Decode(value)
    .replace(/<a\s+[^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<\/?(b|strong|i|em|u|s|strike|code|span|div|p|br)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lr32Preview(value, max = 130) {
  const plain = lr32StripHtml(value);
  if (!plain) return 'пост без текста';
  return plain.length > max ? `${plain.slice(0, max)}...` : plain;
}

function lr32SafeTitle(value) {
  return String(value || '')
    .replace(/[\[\]\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lr32ChannelTitle(channel) {
  return lr32SafeTitle(channel?.title || channel?.name || `Канал #${channel?.id || ''}`.trim());
}

function lr32ChannelUrl(channel) {
  const value = channel?.link || channel?.url || channel?.invite_link || channel?.join_link || channel?.channel_link || '';
  return /^https?:\/\//i.test(String(value)) ? String(value) : '';
}

function lr32ChannelLine(channel) {
  const title = lr32ChannelTitle(channel);
  const url = lr32ChannelUrl(channel);
  return url ? `• [${title}](${url})` : `• ${title}`;
}

function lr32ChannelsList(channels) {
  if (!Array.isArray(channels) || !channels.length) return '• каналы не выбраны';
  return channels.map((channel) => lr32ChannelLine(channel)).join('\n');
}

function lr32DraftText(draft) {
  return draft?.content?.text || draft?.text || draft?.caption || draft?.preview_text || '';
}

function lr32PostPreviewFromDraft(draft) {
  return lr32Preview(lr32DraftText(draft), 145);
}

function lr32MainMenuText() {
  return `━━━━━━━━━━━━━━
🧬 **LinkRay**

Студия публикаций, очередь постов и рекламные отчёты для MAX.

Выберите действие.
━━━━━━━━━━━━━━`;
}

function lr32MainMenuKeyboard() {
  return inlineKeyboard([
    [callbackButton('🧬 LinkRay Studio', 'main:posting')],
    [callbackButton('📡 Каналы', 'post:channels')],
    [callbackButton('📊 Отчёты', 'reports:menu'), callbackButton('🛡 Антифрод', 'antifraud:menu')],
      [callbackButton('🗂 Посты', 'queue:menu')],
]);
}


function lr32AfterPublishKeyboard() {
  return inlineKeyboard([
    [callbackButton('🧩 Собрать ещё пост', 'post:create')],
    [callbackButton('🗂 Посты', 'queue:menu')],
    [callbackButton('🏠 В меню', 'main:menu')],
  ]);
}

function lr32AdNotice() {
  return `✨ Размещение подготовлено через [LinkRay](${lr32BotUrl()}) — автопостинг, очередь публикаций и рекламные отчёты для MAX.`;
}

function lr32PublishedAdText(draft, channels, ok, total) {
  const preview = lr32PostPreviewFromDraft(draft);
  const cpm = draft?.cpm ? `${draft.cpm} ₽` : 'не указан';

  return `━━━━━━━━━━━━━━
✅ **Рекламный пост опубликован**

📝 Сообщение «${preview}»

📣 **Каналы:**
${lr32ChannelsList(channels)}

🚀 **Опубликовано:** ${ok} из ${total}
💼 **Тип:** рекламное размещение
💰 **CPM:** ${cpm}
📊 **Отчёт:** через 24ч после публикации

${lr32AdNotice()}
━━━━━━━━━━━━━━`;
}

function lr32PublishedNormalText(draft, channels, ok, total) {
  return `━━━━━━━━━━━━━━
✅ **Пост опубликован**

📣 **Каналы:**
${lr32ChannelsList(channels)}

🚀 **Опубликовано:** ${ok} из ${total}
━━━━━━━━━━━━━━`;
}

function lr32ScheduledAdText(draft, channels, publishAt) {
  const preview = lr32PostPreviewFromDraft(draft);
  const cpm = draft?.cpm ? `${draft.cpm} ₽` : 'не указан';
  const dateText = lr32FormatDateTime(publishAt);

  return `━━━━━━━━━━━━━━
✅ **Рекламная публикация запланирована**

📝 Сообщение «${preview}»

📅 **Статус:** отложено
🕒 **Публикация:** ${dateText}

📣 **Каналы:**
${lr32ChannelsList(channels)}

🗑 **Автоудаление:** ${draft?.deleteAfterMinutes ? lr32MinutesText(draft.deleteAfterMinutes) : 'нет'}
📊 **Отчёт:** через 24ч после публикации
💼 **Тип:** рекламное размещение
💰 **CPM:** ${cpm}

${lr32AdNotice()}
━━━━━━━━━━━━━━`;
}

async function lr32SendMessageToChat(chatId, text, attachments = null) {
  return sendMaxMessage({
    chatId,
    text,
    format: 'markdown',
    attachments,
  });
}

async function lr32SendMenuAfterPublish(chatId) {
  return lr32SendMessageToChat(chatId, lr32MainMenuText(), lr32MainMenuKeyboard());
}

async function lr32AfterScheduled(callbackId, key, draft, publishAt) {
  const channels = await getChannelsByIds(draft.channelIds || []);

  if (draft?.isAd) {
    const text = lr32ScheduledAdText(draft, channels, publishAt);
    try {
      await lr32SendMessageToChat(key, text, lr32AfterPublishKeyboard());
      await lr32SendMenuAfterPublish(key);
      await answerCallback({
        callbackId,
        text: '✅ Рекламная публикация запланирована. Карточку и меню отправил ниже.',
      });
    } catch (error) {
      console.error('[schedule] ad card/menu send failed:', error.message || error);
      await answerCallback({
        callbackId,
        text,
        attachments: lr32AfterPublishKeyboard(),
      });
    }
    return;
  }

  await lr32AfterScheduled(callbackId, key, draft, publishAt);
}

function lr32FormatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'время не определено';

  const weekdays = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');

  return `${weekdays[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} · ${hh}:${mm} МСК`;
}

function lr32MinutesText(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return 'нет';
  if (n % 1440 === 0) return `${n / 1440}д`;
  if (n % 60 === 0) return `${n / 60}ч`;
  return `${n} мин`;
}

function lr32RowAd(row) {
  const options = row?.options || row?.settings || {};
  return row?.is_ad === true ||
    row?.isAd === true ||
    options?.isAd === true ||
    options?.is_ad === true ||
    Number(row?.cpm || options?.cpm || 0) > 0;
}

function lr32RowCpm(row) {
  const options = row?.options || row?.settings || {};
  return row?.cpm || options?.cpm || null;
}

function lr32RowText(row) {
  return row?.text || row?.caption || row?.preview_text || row?.content_text || '';
}

function lr32RowDate(row) {
  return row?.publish_at || row?.publishAt || row?.published_at || row?.created_at || row?.updated_at;
}

function lr32RowStatus(row) {
  return String(row?.status || '').toLowerCase();
}

function lr32StatusText(row) {
  const status = lr32RowStatus(row);
  if (status === 'published') return 'опубликован';
  if (status === 'scheduled') return 'отложено';
  if (status === 'cancelled' || status === 'canceled') return 'отменено';
  if (status === 'failed') return 'ошибка';
  return status || 'неизвестно';
}

function lr32StatusIcon(row) {
  const status = lr32RowStatus(row);
  if (status === 'published') return '✅';
  if (status === 'scheduled') return '⏳';
  if (status === 'failed') return '⚠️';
  if (status === 'cancelled' || status === 'canceled') return '❌';
  return '📌';
}

function lr32PostButtonTitle(row) {
  const date = new Date(lr32RowDate(row));
  const hh = Number.isNaN(date.getTime()) ? '--:--' : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const ad = lr32RowAd(row) ? '💼 ' : '';
  const icon = lr32StatusIcon(row);
  const preview = lr32Preview(lr32RowText(row), 32);
  return `${ad}${icon} ${hh} · ${preview}`;
}

function lr32PostTextForSending(row) {
  return lr32Decode(lr32RowText(row));
}

function lr32ParseMaybeJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function lr32RowAttachments(row) {
  const value = row?.attachments || row?.media || row?.attachment;
  const parsed = lr32ParseMaybeJson(value, null);
  return parsed || null;
}

async function lr32ColumnExists(tableName, columnName) {
  const result = await query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return result.rows.length > 0;
}

async function lr32GetQueueRows(mode = 'all', channelId = null, limit = 10) {
  const conditions = [];
  const params = [];

  if (mode === 'scheduled') {
    conditions.push(`sp.status = 'scheduled'`);
  } else if (mode === 'published') {
    conditions.push(`sp.status = 'published'`);
  } else {
    conditions.push(`sp.status IN ('scheduled', 'published')`);
  }

  if (channelId) {
    params.push(Number(channelId));
    conditions.push(`sp.channel_id = $${params.length}`);
  }

  params.push(Number(limit));

  const sql = `
    SELECT
      sp.*,
      c.title AS channel_title,
      c.link AS channel_link,
      c.id AS channel_real_id
    FROM scheduled_posts sp
    LEFT JOIN channels c ON c.id = sp.channel_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY sp.publish_at ASC, sp.id ASC
    LIMIT $${params.length}
  `;

  const result = await query(sql, params);
  return result.rows;
}

async function lr32GetQueuePost(id) {
  const result = await query(
    `SELECT
       sp.*,
       c.title AS channel_title,
       c.link AS channel_link,
       c.id AS channel_real_id
     FROM scheduled_posts sp
     LEFT JOIN channels c ON c.id = sp.channel_id
     WHERE sp.id = $1
     LIMIT 1`,
    [Number(id)]
  );
  return result.rows[0] || null;
}

async function lr32GetQueueChannels() {
  const result = await query(
    `SELECT
       c.id,
       c.title,
       c.link,
       COUNT(sp.id)::int AS total_count,
       COUNT(sp.id) FILTER (WHERE sp.status = 'scheduled')::int AS scheduled_count,
       COUNT(sp.id) FILTER (WHERE sp.status = 'published')::int AS published_count
     FROM channels c
     LEFT JOIN scheduled_posts sp
       ON sp.channel_id = c.id
      AND sp.status IN ('scheduled', 'published')
     GROUP BY c.id, c.title, c.link
     ORDER BY total_count DESC, c.title ASC`
  );
  return result.rows;
}


function lr34PostButtonTitle(row) {
  const date = new Date(lr32RowDate(row));
  const hh = Number.isNaN(date.getTime()) ? '--:--' : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const ad = lr32RowAd(row) ? '💼 ' : '';
  const icon = lr32StatusIcon(row);
  const preview = lr32Preview(lr32RowText(row), 34);
  const del = row?.delete_after_minutes || row?.auto_delete_minutes || lr32ParseMaybeJson(row?.options, {})?.deleteAfterMinutes;
  const delText = del ? ` · 🗑 ${lr32MinutesText(del)}` : '';
  return `${ad}${icon} ${hh} · ${preview}${delText}`;
}


function lr35MonthName(date) {
  const months = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  return months[date.getMonth()] || '';
}

function lr35ShortDay(date) {
  const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  return days[date.getDay()] || '';
}

function lr35DateLine(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'дата не выбрана';
  return `${lr35ShortDay(date)} ${date.getDate()} ${lr35MonthName(date)} ${date.getFullYear()} г.`;
}

function lr35Time(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function lr35ReadablePreview(row, max = 42) {
  const text = lr32StripHtml(lr32RowText(row));
  if (!text) return 'пост без текста';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function lr35PostMainButton(row) {
  const date = new Date(lr32RowDate(row));
  const time = lr35Time(date);
  const ad = lr32RowAd(row) ? '💼 ' : '';
  const icon = lr32StatusIcon(row);
  const media = lr32RowAttachments(row) ? '🖼 ' : '';
  return `${ad}${icon} ${time} · ${media}${lr35ReadablePreview(row, 34)}`;
}

function lr35QueueTitle(mode, channel, rows) {
  const title = channel ? lr32ChannelTitle(channel) : 'Все каналы';
  const published = rows.filter((r) => lr32RowStatus(r) === 'published').length;
  const scheduled = rows.filter((r) => lr32RowStatus(r) === 'scheduled').length;
  const first = rows.length ? new Date(lr32RowDate(rows[0])) : new Date();

  let modeLabel = 'все посты';
  if (mode === 'scheduled') modeLabel = 'запланированные';
  if (mode === 'published') modeLabel = 'опубликованные';

  return `━━━━━━━━━━━━━━
🗂 **${title}**
📅 ${lr35DateLine(first)}

${scheduled ? `⏳ ${scheduled} запланировано\n` : ''}${published ? `✅ ${published} опубликовано\n` : ''}Фильтр: ${modeLabel}

Выберите пост или действие ниже.
━━━━━━━━━━━━━━`;
}

async function lr35EditPostsList(callbackId, mode = 'all', channelId = null) {
  let channel = null;
  if (channelId) {
    const channels = await getChannelsByIds([Number(channelId)]);
    channel = channels[0] || null;
  }

  const rowsData = await lr32GetQueueRows(mode, channelId, 12);
  const rows = [];

  for (const row of rowsData) {
    rows.push([
      callbackButton(lr35PostMainButton(row), `queue:post:${row.id}`),
      callbackButton('🗑', `queue:trash:${row.id}`),
    ]);
  }

  if (!rows.length) {
    rows.push([callbackButton('Постов пока нет', 'queue:noop')]);
  }

  rows.push([
    callbackButton('⏳ Запланированные', channelId ? `queue:channel:${channelId}:scheduled` : 'queue:scheduled'),
    callbackButton('🟢 Опубликованные', channelId ? `queue:channel:${channelId}:published` : 'queue:published'),
  ]);

  rows.push([callbackButton('📋 Все посты', channelId ? `queue:channel:${channelId}:all` : 'queue:all')]);
  rows.push([callbackButton('📡 По каналам', 'queue:channels')]);
  rows.push([callbackButton('📅 Календарь', channelId ? `queue:calendar:${channelId}` : 'queue:calendar')]);
  rows.push([callbackButton('⬅️ Назад', 'main:posting')]);

  await answerCallback({
    callbackId,
    text: lr35QueueTitle(mode, channel, rowsData),
    attachments: inlineKeyboard(rows),
  });
}

async function lr35EditPostsChannels(callbackId) {
  const channels = await lr32GetQueueChannels();
  const rows = [[callbackButton('🌐 Все каналы', 'queue:all')]];

  for (const channel of channels.slice(0, 12)) {
    const title = lr32ChannelTitle(channel);
    const scheduled = Number(channel.scheduled_count || 0);
    const published = Number(channel.published_count || 0);
    rows.push([callbackButton(`📡 ${title} · ⏳${scheduled} / ✅${published}`, `queue:channel:${channel.id}`)]);
  }

  rows.push([callbackButton('⬅️ К постам', 'queue:all')]);

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
📡 **Посты по каналам**

Выберите канал, чтобы посмотреть его запланированные и опубликованные посты.
━━━━━━━━━━━━━━`,
    attachments: inlineKeyboard(rows),
  });
}

async function lr35TrashConfirm(callbackId, id) {
  const post = await lr32GetQueuePost(id);
  if (!post) {
    await answerCallback({
      callbackId,
      text: 'Публикация не найдена.',
      attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'queue:all')]]),
    });
    return;
  }

  const status = lr32RowStatus(post);
  const actionText = status === 'published' ? 'удалить из канала' : 'отменить публикацию';
  const preview = lr35ReadablePreview(post, 100);

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
🗑 **Подтвердите действие**

Пост #${post.id}
«${preview}»

Действие: ${actionText}.
━━━━━━━━━━━━━━`,
    attachments: inlineKeyboard([
      [callbackButton('✅ Да, выполнить', `queue:delete:${post.id}`)],
      [callbackButton('⬅️ Назад к посту', `queue:post:${post.id}:nopreview`)],
      [callbackButton('📋 К постам', 'queue:all')],
    ]),
  });
}

async function lr35QueueDelete(callbackId, id) {
  const post = await lr32GetQueuePost(id);
  if (!post) {
    await answerCallback({
      callbackId,
      text: 'Публикация не найдена.',
      attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'queue:all')]]),
    });
    return;
  }

  const status = lr32RowStatus(post);
  const targetStatus = status === 'published' ? 'deleted' : 'cancelled';

  try {
    await query('UPDATE scheduled_posts SET status = $2, updated_at = now() WHERE id = $1', [Number(id), targetStatus]);
  } catch (error) {
    console.error('[posts] delete/cancel failed:', error.message || error);
    try {
      await query('UPDATE scheduled_posts SET error_message = $2, updated_at = now() WHERE id = $1', [Number(id), 'removed by user']);
    } catch (inner) {
      console.error('[posts] error_message update failed:', inner.message || inner);
    }
  }

  await answerCallback({
    callbackId,
    text: status === 'published'
      ? `✅ Пост #${id} убран из списка LinkRay.`
      : `✅ Запланированный пост #${id} отменён.`,
    attachments: inlineKeyboard([
      [callbackButton('📋 Все посты', 'queue:all')],
      [callbackButton('⬅️ В Studio', 'main:posting')],
    ]),
  });
}

async function lr32EditQueueMenu(callbackId) {
  await lr41ShowPosts(callbackId, 'all');
}





function lr32QueueHeader(mode, channel = null, rows = []) {
  const title = channel ? lr32ChannelTitle(channel) : 'Все каналы';
  const published = rows.filter((r) => lr32RowStatus(r) === 'published').length;
  const scheduled = rows.filter((r) => lr32RowStatus(r) === 'scheduled').length;

  let modeText = 'все посты';
  if (mode === 'scheduled') modeText = 'запланированные';
  if (mode === 'published') modeText = 'опубликованные';

  const firstDate = rows.length ? new Date(lr32RowDate(rows[0])) : null;
  const dayLine = firstDate && !Number.isNaN(firstDate.getTime())
    ? `📅 ${lr32FormatDateTime(firstDate).replace(' МСК', '')}`
    : '📅 публикаций пока нет';

  return `━━━━━━━━━━━━━━
🗂 **Посты · ${title}**

${dayLine}
Фильтр: ${modeText}
⏳ Запланировано: ${scheduled}
✅ Опубликовано: ${published}

Нажмите на пост, чтобы открыть управление.
━━━━━━━━━━━━━━`;
}


async function lr32EditQueueList(callbackId, mode = 'all', channelId = null) {
  await lr41ShowPosts(callbackId, mode, channelId);
}





async function lr32SendQueuePostPreview(chatId, post) {
  const text = lr32PostTextForSending(post);
  const attachments = lr32RowAttachments(post);
  if (!text && !attachments) return;

  try {
    await sendMaxMessage({
      chatId,
      text: text || ' ',
      format: post.format || post.content_format || 'html',
      attachments,
    });
  } catch (error) {
    console.error('[queue] preview send failed:', error.message || error);
  }
}

async function lr32EditQueuePost(callbackId, key, id, sendPreview = true) {
  await lr41ShowPost(callbackId, key, id, sendPreview);
}





async function lr32QueueAutoDeleteMenu(callbackId, id) {
  const rows = [
    [callbackButton('1ч', `queue:autodel_set:${id}:60`), callbackButton('2ч', `queue:autodel_set:${id}:120`), callbackButton('6ч', `queue:autodel_set:${id}:360`)],
    [callbackButton('24ч', `queue:autodel_set:${id}:1440`), callbackButton('48ч', `queue:autodel_set:${id}:2880`), callbackButton('72ч', `queue:autodel_set:${id}:4320`)],
    [callbackButton('🚫 Не удалять', `queue:autodel_set:${id}:none`)],
    [callbackButton('⬅️ К публикации', `queue:post:${id}`)],
  ];

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
🗑 **Автоудаление**

Выберите срок для публикации #${id}.
━━━━━━━━━━━━━━`,
    attachments: inlineKeyboard(rows),
  });
}

async function lr32QueueSetAutoDelete(callbackId, id, value) {
  const minutes = value === 'none' ? null : Number(value);

  if (await lr32ColumnExists('scheduled_posts', 'delete_after_minutes')) {
    await query('UPDATE scheduled_posts SET delete_after_minutes = $2, updated_at = now() WHERE id = $1', [Number(id), minutes]);
  } else if (await lr32ColumnExists('scheduled_posts', 'options')) {
    await query(
      `UPDATE scheduled_posts
       SET options = COALESCE(options, '{}'::jsonb) || $2::jsonb,
           updated_at = now()
       WHERE id = $1`,
      [Number(id), JSON.stringify({ deleteAfterMinutes: minutes })]
    );
  }

  await answerCallback({
    callbackId,
    text: `🗑 Автоудаление обновлено: ${lr32MinutesText(minutes)}.`,
    attachments: inlineKeyboard([[callbackButton('⬅️ К публикации', `queue:post:${id}`)]]),
  });
}

async function lr32QueueDelete(callbackId, id) {
  const post = await lr32GetQueuePost(id);
  if (!post) {
    await answerCallback({
      callbackId,
      text: 'Публикация не найдена.',
      attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'queue:all')]]),
    });
    return;
  }

  const status = lr32RowStatus(post);
  const targetStatus = status === 'published' ? 'deleted' : 'cancelled';

  try {
    await query('UPDATE scheduled_posts SET status = $2, updated_at = now() WHERE id = $1', [Number(id), targetStatus]);
  } catch (error) {
    console.error('[queue] delete/cancel status update failed:', error.message || error);
    await query('UPDATE scheduled_posts SET error_message = $2, updated_at = now() WHERE id = $1', [Number(id), 'removed from queue by user']);
  }

  await answerCallback({
    callbackId,
    text: status === 'published'
      ? `❌ Публикация #${id} убрана из очереди LinkRay. Если MAX message_id сохранён, физическое удаление добавим отдельным шагом.`
      : `❌ Публикация #${id} отменена.`,
    attachments: inlineKeyboard([[callbackButton('🗂 Посты', 'queue:all')]]),
  });
}

async function lr32QueueCalendar(callbackId, channelId = null) {
  const rowsData = await lr32GetQueueRows('all', channelId, 30);
  const byDate = new Map();

  for (const row of rowsData) {
    const d = new Date(lr32RowDate(row));
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDate.set(key, (byDate.get(key) || 0) + 1);
  }

  const lines = Array.from(byDate.entries())
    .slice(0, 12)
    .map(([date, count]) => `• ${date} — ${count}`)
    .join('\n') || 'Пока нет публикаций.';

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
📅 **Календарь очереди**

${lines}
━━━━━━━━━━━━━━`,
    attachments: inlineKeyboard([[callbackButton('⬅️ К постам', channelId ? `queue:channel:${channelId}` : 'queue:all')]]),
  });
}

async function lr32HandleQueueCallback(payload, callbackId, key) {
  return lr41HandlePostsPayload(payload, callbackId, key);
}



async function handleCallback(update) {

  const callbackId = getCallbackId(update);
  const payload = getCallbackPayload(update);
const key = getSessionKey(update);
  // LR44_CALLBACK_ROUTER_START
  if (await lr44HandleCallbackPayload(payload, callbackId, key)) return;
  // LR44_CALLBACK_ROUTER_END
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
      draft.signatureCurrentChannelId = channelId;

      await loadSharedSignatures(draft);

      const channel = await getChannelById(channelId);
      const channelKey = String(channelId);

      const sig = draft.signaturesByChannel?.[channelKey] || '';
      const enabled = draft.signatureEnabledByChannel?.[channelKey] !== false;
      const sigFormat =
        draft.signatureFormatsByChannel?.[channelKey] ||
        (lrLooksLikeHtml(sig) ? 'html' : 'markdown');

      await setSession(key, 'signature_channel', { draft });

      const rows = [
        [callbackButton(sig ? '✏️ Заменить подпись' : '➕ Создать подпись', 'sig:add')],
      ];

      if (sig) {
        rows.push([callbackButton(enabled ? '🚫 Выключить' : '✅ Включить', 'sig:toggle')]);
      }

      rows.push([callbackButton('⬅️ К подписям', 'sig:menu')]);

      if (!sig) {
        await answerCallback({
          callbackId,
          text: `━━━━━━━━━━━━━━
🏷 **${channelName(channel)}**

Статус: не создана

Создайте подпись для этого канала.
━━━━━━━━━━━━━━`,
          attachments: inlineKeyboard(rows),
        });
        return;
      }

      if (sigFormat === 'html' || lrLooksLikeHtml(sig)) {
        const htmlSignature = lrNormalizeSignatureHtml(sig);

        await answerCallback({
          callbackId,
          format: 'html',
          text: `━━━━━━━━━━━━━━
<b>🏷 ${lrEscapeHtml(channelName(channel))}</b>

Статус: ${enabled ? 'включена' : 'выключена'}

<b>Подпись:</b>
${htmlSignature}
━━━━━━━━━━━━━━`,
          attachments: inlineKeyboard(rows),
        });
        return;
      }

      await answerCallback({
        callbackId,
        text: `━━━━━━━━━━━━━━
🏷 **${channelName(channel)}**

Статус: ${enabled ? 'включена' : 'выключена'}

**Подпись:**
${sig}
━━━━━━━━━━━━━━`,
        attachments: inlineKeyboard(rows),
      });
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
  if (payload === 'publish:sound') {
    await answerCallback({
      callbackId,
      text: '🔔 Настройка звука убрана. Публикации отправляются без отдельного переключателя звука.',
    });
    return;
  }
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
    await lr32AfterScheduled(callbackId, key, draft, publishAt);
    return;
  }
  if (payload === 'publish:now') {
    const results = await publishNow(draft);
    const ok = results.filter((result) => result && result.ok).length;
    const total = results.length || (draft.channelIds || []).length || 0;
    const channels = await getChannelsByIds(draft.channelIds || []);

    await clearSession(key);

    const resultText = draft.isAd
      ? lr32PublishedAdText(draft, channels, ok, total)
      : lr32PublishedNormalText(draft, channels, ok, total);

    try {
      await lr32SendMessageToChat(key, resultText, lr32AfterPublishKeyboard());
      await lr32SendMenuAfterPublish(key);
      await answerCallback({
        callbackId,
        text: '✅ Готово. Карточку публикации и новое меню отправил ниже.',
      });
    } catch (error) {
      console.error('[publish] result/menu send failed:', error.message || error);
      await answerCallback({
        callbackId,
        text: resultText,
        attachments: lr32AfterPublishKeyboard(),
      });
    }

    return;
  }

  if (payload === 'queue:menu') { await editQueueMenu(callbackId); return; }
  if (payload === 'queue:all') { await editQueueList(callbackId); return; }
  if (payload.startsWith('queue:channel:')) { await editQueueList(callbackId, Number(payload.split(':')[2])); return; }
  if (payload.startsWith('queue:post:')) { await editQueuePost(callbackId, Number(payload.split(':')[2])); return; }
  if (payload.startsWith('queueedit:text:')) { const id = Number(payload.split(':')[2]); await setSession(key, `queue_edit_text:${id}`, {}); await answerCallback({ callbackId, text: `Отправьте новый текст для публикации #${id}.`, attachments: kbBackCancel('queue:all') }); return; }
  if (payload.startsWith('queueedit:time:')) { const id = Number(payload.split(':')[2]); await setSession(key, `queue_edit_time:${id}`, {}); await answerCallback({ callbackId, text: `Отправьте новое время для публикации #${id}.`, attachments: kbBackCancel('queue:all') }); return; }
  if (payload.startsWith('queue:cancel:')) { const id = Number(payload.split(':')[2]); await query('UPDATE scheduled_posts SET status = $2, updated_at = now() WHERE id = $1', [id, 'canceled']); await answerCallback({ callbackId, text: `🗑 Публикация #${id} отменена.`, attachments: inlineKeyboard([[callbackButton('🗂 Посты', 'queue:all')]]) }); return; }
  if (payload.startsWith('queue:now:')) {
    const id = Number(payload.split(':')[2]);
    await query('UPDATE scheduled_posts SET publish_at = now(), status = $2, updated_at = now() WHERE id = $1', [id, 'scheduled']);
    await answerCallback({ callbackId, text: `🚀 Публикация #${id} отправлена на ближайшую публикацию.`, attachments: inlineKeyboard([[callbackButton('🗂 Посты', 'queue:all')]]) });
    return;
  }

  await answerCallback({ callbackId, text: 'Команда пока не обработана.', attachments: kbMain() });
}



// ===== LinkRay v36 posts UI override START =====
function lr36Decode(v) {
  return String(v || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function lr36Plain(v) {
  return lr36Decode(v)
    .replace(/<a\s+[^>]*href=["'][^"']+["'][^>]*>(.*?)<\/a>/gis, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(b|strong|i|em|u|s|strike|span|p|div|code|pre)[^>]*>/gis, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function lr36Short(v, max = 38) {
  const s = lr36Plain(v).replace(/\s+/g, ' ').trim();
  if (!s) return 'пост без текста';
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
function lr36Json(v, fb = {}) { try { if (!v) return fb; return typeof v === 'object' ? v : JSON.parse(v); } catch { return fb; } }
function lr36Sp(r) { return r?.sp || r || {}; }
function lr36Ch(r) { return r?.ch || {}; }
function lr36Text(r) { const sp = lr36Sp(r); const o = lr36Json(sp.options, {}); return sp.text || sp.caption || o.text || o.caption || o.originalText || ''; }
function lr36DateValue(r) { const sp = lr36Sp(r); return sp.publish_at || sp.published_at || sp.created_at || new Date().toISOString(); }
function lr36Status(r) { return String(lr36Sp(r).status || '').toLowerCase(); }
function lr36IsAd(r) { const sp = lr36Sp(r); const o = lr36Json(sp.options, {}); return Boolean(sp.is_ad || sp.isAd || o.isAd || o.is_ad || sp.cpm || o.cpm); }
function lr36Cpm(r) { const sp = lr36Sp(r); const o = lr36Json(sp.options, {}); return sp.cpm || o.cpm || null; }
function lr36HasMedia(r) { const sp = lr36Sp(r); const o = lr36Json(sp.options, {}); return Boolean(sp.attachments || sp.media || sp.attachment || o.attachments || o.media); }
function lr36Icon(r) { const s = lr36Status(r); if (s === 'published') return '✅'; if (s === 'scheduled') return '⏳'; if (s === 'failed') return '⚠️'; if (s === 'cancelled' || s === 'canceled' || s === 'deleted') return '❌'; return '📝'; }
function lr36StatusText(r) { const s = lr36Status(r); if (s === 'published') return 'опубликован'; if (s === 'scheduled') return 'запланирован'; if (s === 'failed') return 'ошибка'; if (s === 'cancelled' || s === 'canceled') return 'отменён'; if (s === 'deleted') return 'удалён'; return s || 'неизвестно'; }
function lr36Date(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? new Date() : d; }
function lr36Time(d) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function lr36Day(d) { return ['вс','пн','вт','ср','чт','пт','сб'][d.getDay()]; }
function lr36Month(d) { return ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][d.getMonth()]; }
function lr36DateLine(d) { return `${lr36Day(d)} ${d.getDate()} ${lr36Month(d)} ${d.getFullYear()} г.`; }
function lr36Esc(v) { return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function lr36ChannelTitle(ch) { return ch.title || ch.name || `Канал #${ch.id || ch.channel_id || ''}`; }
function lr36ChannelLink(ch) { return ch.link || ch.url || ch.invite_link || ''; }
function lr36ChannelLine(ch) { const t = lr36Esc(lr36ChannelTitle(ch)); const l = lr36ChannelLink(ch); return l ? `• <a href="${l}">${t}</a>` : `• ${t}`; }

async function lr36GetPosts(mode = 'all', channelId = null, limit = 12) {
  const where = ["sp.status::text IN ('scheduled','published')"];
  const params = [];

  if (mode === 'scheduled') where.push("sp.status::text = 'scheduled'");
  if (mode === 'published') where.push("sp.status::text = 'published'");

  if (channelId) {
    params.push(Number(channelId));
    where.push(`sp.channel_id = $${params.length}`);
  }

  params.push(Number(limit));

  const result = await query(`
    SELECT to_jsonb(sp) AS sp, to_jsonb(c) AS ch
    FROM scheduled_posts sp
    LEFT JOIN channels c ON c.id = sp.channel_id
    WHERE ${where.join(' AND ')}
    ORDER BY sp.publish_at DESC NULLS LAST, sp.id DESC
    LIMIT $${params.length}
  `, params);

  return lr40Rows(result);
}

async function lr36GetOnePost(id) {
  const result = await query(`
    SELECT to_jsonb(sp) AS sp, to_jsonb(c) AS ch
    FROM scheduled_posts sp
    LEFT JOIN channels c ON c.id = sp.channel_id
    WHERE sp.id = $1
    LIMIT 1
  `, [Number(id)]);

  const rows = lr40Rows(result);
  return rows[0] || null;
}

async function lr36GetChannels() {
  return (await query(`
    SELECT to_jsonb(c) AS ch,
      COUNT(sp.id) FILTER (WHERE sp.status::text = 'scheduled') AS scheduled_count,
      COUNT(sp.id) FILTER (WHERE sp.status::text = 'published') AS published_count
    FROM channels c
    LEFT JOIN scheduled_posts sp ON sp.channel_id = c.id AND sp.status::text IN ('scheduled','published')
    GROUP BY c.id
    ORDER BY c.id
    LIMIT 20
  `)).rows;
}
function lr36PostButton(r) {
  const d = lr36Date(lr36DateValue(r));
  const ad = lr36IsAd(r) ? '💼 ' : '';
  const media = lr36HasMedia(r) ? '🖼 ' : '';
  return `${ad}${lr36Icon(r)} ${lr36Time(d)} · ${media}${lr36Short(lr36Text(r), 32)}`;
}
function lr36Header(mode, channel, rows) {
  const title = channel ? lr36ChannelTitle(channel) : 'Все каналы';
  const scheduled = rows.filter((r) => lr36Status(r) === 'scheduled').length;
  const published = rows.filter((r) => lr36Status(r) === 'published').length;
  const d = rows.length ? lr36Date(lr36DateValue(rows[0])) : new Date();
  let filter = 'все посты';
  if (mode === 'scheduled') filter = 'запланированные';
  if (mode === 'published') filter = 'опубликованные';
  return `━━━━━━━━━━━━━━\n🗂 <b>${lr36Esc(title)}</b>\n📅 ${lr36DateLine(d)}\n\n${scheduled ? `⏳ ${scheduled} запланировано\n` : ''}${published ? `✅ ${published} опубликовано\n` : ''}Фильтр: ${filter}\n\nНажмите на пост, чтобы открыть управление.\n━━━━━━━━━━━━━━`;
}

function lr40Rows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.data)) return result.data;
  return [];
}

async function lr36ShowPosts(callbackId, mode = 'all', channelId = null) {
  await lr41ShowPosts(callbackId, mode, channelId);
}

async function lr36ShowChannels(callbackId) {
  await lr41ShowChannels(callbackId);
}

async function lr36ShowPost(callbackId, key, id, sendPreview = true) {
  await lr41ShowPost(callbackId, key, id, sendPreview);
}


async function lr36TrashConfirm(callbackId, id) {
  const r = await lr36GetOnePost(id);
  if (!r) { await answerCallback({ callbackId, text: 'Пост не найден.', attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'queue:all')]]) }); return; }
  const action = lr36Status(r) === 'published' ? 'удалить из канала' : 'отменить публикацию';
  await answerCallback({ callbackId, text: `━━━━━━━━━━━━━━\n🗑 <b>Подтверждение</b>\n\nПост #${lr36Sp(r).id}\n«${lr36Esc(lr36Short(lr36Text(r), 100))}»\n\nНужно ${action}?\n━━━━━━━━━━━━━━`, format: 'html', attachments: inlineKeyboard([[callbackButton('✅ Да', `queue:delete:${lr36Sp(r).id}`)], [callbackButton('⬅️ Назад', `queue:post:${lr36Sp(r).id}:nopreview`)]]) });
}
async function lr36PickCancelStatus() {
  try {
    const vals = (await query(`SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = (SELECT udt_name FROM information_schema.columns WHERE table_name = 'scheduled_posts' AND column_name = 'status' LIMIT 1)`)).rows.map((r) => r.enumlabel);
    for (const v of ['cancelled', 'canceled', 'deleted', 'failed']) if (vals.includes(v)) return v;
  } catch (e) { console.error('[v36 posts] enum read failed:', e.message || e); }
  return 'failed';
}
async function lr36DeletePost(callbackId, id) {
  const status = await lr36PickCancelStatus();
  await query('UPDATE scheduled_posts SET status = $2, updated_at = now() WHERE id = $1', [Number(id), status]);
  await answerCallback({ callbackId, text: `✅ Пост #${id} убран из активного списка.`, attachments: inlineKeyboard([[callbackButton('📋 К постам', 'queue:all')], [callbackButton('⬅️ В Studio', 'main:posting')]]) });
}
async function lr36HandlePostsPayload(payload, callbackId, key) {
  return lr41HandlePostsPayload(payload, callbackId, key);
}

// ===== LinkRay v36 posts UI override END =====


// ===== LinkRay v41 posts UI START =====
function lr41Rows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.data)) return result.data;
  return [];
}

function lr41Json(value, fallback = {}) {
  try {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function lr41Sp(row) {
  return row?.sp || row || {};
}

function lr41Ch(row) {
  return row?.ch || {};
}

function lr41Decode(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function lr41Plain(value) {
  return lr41Decode(String(value || ''))
    .replace(/<a\s+[^>]*href=["'][^"']+["'][^>]*>(.*?)<\/a>/gis, '$1')
    .replace(/<\/?(b|strong|i|em|u|s|strike|span|p|div|code|pre)[^>]*>/gis, '')
    .replace(/<br\s*\/?>/gis, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function lr41Short(value, max = 38) {
  const clean = lr41Plain(value).replace(/\s+/g, ' ').trim();
  if (!clean) return 'пост без текста';
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function lr41HtmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lr41PostText(row) {
  const sp = lr41Sp(row);
  const opts = lr41Json(sp.options, {});
  return sp.text || sp.caption || opts.text || opts.caption || opts.originalText || '';
}

function lr41PostFormat(row) {
  const sp = lr41Sp(row);
  const opts = lr41Json(sp.options, {});
  return sp.format || opts.format || 'html';
}

function lr41PostAttachments(row) {
  const sp = lr41Sp(row);
  const opts = lr41Json(sp.options, {});
  return sp.attachments || sp.media || opts.attachments || opts.media || null;
}

function lr41PostDate(row) {
  const sp = lr41Sp(row);
  const value = sp.publish_at || sp.published_at || sp.created_at || new Date().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function lr41PostStatus(row) {
  return String(lr41Sp(row).status || '').toLowerCase();
}

function lr41IsAd(row) {
  const sp = lr41Sp(row);
  const opts = lr41Json(sp.options, {});
  return Boolean(sp.is_ad || sp.isAd || opts.isAd || opts.is_ad || opts.ad || sp.cpm || opts.cpm);
}

function lr41Cpm(row) {
  const sp = lr41Sp(row);
  const opts = lr41Json(sp.options, {});
  return sp.cpm || opts.cpm || null;
}

function lr41DeleteAfter(row) {
  const sp = lr41Sp(row);
  const opts = lr41Json(sp.options, {});
  return sp.delete_after_minutes || sp.auto_delete_minutes || opts.deleteAfterMinutes || opts.delete_after_minutes || null;
}

function lr41StatusIcon(row) {
  const s = lr41PostStatus(row);
  if (s === 'published') return '✅';
  if (s === 'scheduled') return '⏳';
  if (s === 'failed') return '⚠️';
  if (s === 'cancelled' || s === 'canceled' || s === 'deleted') return '❌';
  return '📝';
}

function lr41StatusText(row) {
  const s = lr41PostStatus(row);
  if (s === 'published') return 'опубликован';
  if (s === 'scheduled') return 'запланирован';
  if (s === 'failed') return 'ошибка';
  if (s === 'cancelled' || s === 'canceled') return 'отменён';
  if (s === 'deleted') return 'удалён';
  return s || 'неизвестно';
}

function lr41Time(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function lr41Day(d) {
  return ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getDay()] || '';
}

function lr41Month(d) {
  return ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][d.getMonth()] || '';
}

function lr41DateLine(d) {
  return `${lr41Day(d)} ${d.getDate()} ${lr41Month(d)} ${d.getFullYear()} г.`;
}

function lr41ChannelTitle(ch) {
  return ch?.title || ch?.name || `Канал #${ch?.id || ch?.channel_id || ''}`;
}

function lr41ChannelLink(ch) {
  return ch?.link || ch?.url || ch?.invite_link || '';
}

function lr41ChannelHtmlLine(ch) {
  const title = lr41HtmlEscape(lr41ChannelTitle(ch));
  const link = lr41ChannelLink(ch);
  return link ? `• <a href="${link}">${title}</a>` : `• ${title}`;
}

function lr41MinutesText(value) {
  if (!value) return 'нет';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'нет';
  if (n % 1440 === 0) return `${n / 1440}д`;
  if (n % 60 === 0) return `${n / 60}ч`;
  return `${n} мин`;
}

async function lr41GetPosts(mode = 'all', channelId = null, limit = 12) {
  const where = ["sp.status::text IN ('scheduled','published')"];
  const params = [];

  if (mode === 'scheduled') where.push("sp.status::text = 'scheduled'");
  if (mode === 'published') where.push("sp.status::text = 'published'");

  if (channelId) {
    params.push(Number(channelId));
    where.push(`sp.channel_id = $${params.length}`);
  }

  params.push(Number(limit));

  const result = await query(`
    SELECT to_jsonb(sp) AS sp, to_jsonb(c) AS ch
    FROM scheduled_posts sp
    LEFT JOIN channels c ON c.id = sp.channel_id
    WHERE ${where.join(' AND ')}
    ORDER BY sp.publish_at DESC NULLS LAST, sp.id DESC
    LIMIT $${params.length}
  `, params);

  return lr41Rows(result);
}

async function lr41GetOnePost(id) {
  const result = await query(`
    SELECT to_jsonb(sp) AS sp, to_jsonb(c) AS ch
    FROM scheduled_posts sp
    LEFT JOIN channels c ON c.id = sp.channel_id
    WHERE sp.id = $1
    LIMIT 1
  `, [Number(id)]);

  return lr41Rows(result)[0] || null;
}

async function lr41GetChannelsWithCounts() {
  const result = await query(`
    SELECT
      to_jsonb(c) AS ch,
      COUNT(sp.id) FILTER (WHERE sp.status::text = 'scheduled') AS scheduled_count,
      COUNT(sp.id) FILTER (WHERE sp.status::text = 'published') AS published_count
    FROM channels c
    LEFT JOIN scheduled_posts sp ON sp.channel_id = c.id AND sp.status::text IN ('scheduled','published')
    GROUP BY c.id
    ORDER BY c.id
    LIMIT 30
  `);

  return lr41Rows(result);
}

function lr41PostButton(row) {
  const d = lr41PostDate(row);
  const ad = lr41IsAd(row) ? '💼 ' : '';
  const media = lr41PostAttachments(row) ? '🖼 ' : '';
  return `${ad}${lr41StatusIcon(row)} ${lr41Time(d)} · ${media}${lr41Short(lr41PostText(row), 36)}`;
}

async function lr41ShowPosts(callbackId, mode = 'all', channelId = null) {
  const rowsData = await lr41GetPosts(mode, channelId, 12);
  let channel = null;

  if (channelId) {
    if (rowsData[0]) channel = lr41Ch(rowsData[0]);
    if (!channel || !channel.id) {
      try {
        const channels = await getChannelsByIds([Number(channelId)]);
        channel = channels?.[0] || null;
      } catch {}
    }
  }

  const rows = [];
  for (const row of rowsData) {
    const id = lr41Sp(row).id;
    rows.push([callbackButton(lr41PostButton(row), `queue:post:${id}`)]);
  }

  if (!rows.length) {
    rows.push([callbackButton('Постов пока нет', 'queue:noop')]);
  }

  rows.push([
    callbackButton('⏳ Запланированные', channelId ? `queue:channel:${channelId}:scheduled` : 'queue:scheduled'),
    callbackButton('🟢 Опубликованные', channelId ? `queue:channel:${channelId}:published` : 'queue:published'),
  ]);
  rows.push([callbackButton('📋 Все посты', channelId ? `queue:channel:${channelId}:all` : 'queue:all')]);
  rows.push([callbackButton('📡 По каналам', 'queue:channels')]);
  rows.push([callbackButton('⬅️ В Studio', 'main:posting')]);

  const title = channel ? lr41ChannelTitle(channel) : 'Все каналы';
  const scheduled = rowsData.filter((r) => lr41PostStatus(r) === 'scheduled').length;
  const published = rowsData.filter((r) => lr41PostStatus(r) === 'published').length;
  const modeText = mode === 'scheduled' ? 'запланированные' : mode === 'published' ? 'опубликованные' : 'все посты';

  const headerDate = rowsData.length ? lr41DateLine(lr41PostDate(rowsData[0])) : lr41DateLine(new Date());
  const emptyText = rowsData.length ? '' : '\nПостов пока нет.';

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
🗂 <b>${lr41HtmlEscape(title)}</b>
📅 ${headerDate}

⏳ Запланировано: ${scheduled}
✅ Опубликовано: ${published}
Фильтр: ${modeText}${emptyText}

Нажмите на пост, чтобы открыть управление.
━━━━━━━━━━━━━━`,
    format: 'html',
    attachments: inlineKeyboard(rows),
  });
}

async function lr41ShowChannels(callbackId) {
  const rowsData = await lr41GetChannelsWithCounts();
  const rows = [[callbackButton('🌐 Все каналы', 'queue:all')]];

  for (const row of rowsData) {
    const ch = row.ch || {};
    const scheduled = Number(row.scheduled_count || 0);
    const published = Number(row.published_count || 0);
    rows.push([callbackButton(`📡 ${lr41ChannelTitle(ch)} · ⏳${scheduled} / ✅${published}`, `queue:channel:${ch.id}`)]);
  }

  if (!rowsData.length) rows.push([callbackButton('Каналов пока нет', 'queue:noop')]);
  rows.push([callbackButton('⬅️ К постам', 'queue:all')]);

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
📡 <b>Посты по каналам</b>

Выберите канал.
━━━━━━━━━━━━━━`,
    format: 'html',
    attachments: inlineKeyboard(rows),
  });
}

async function lr41SendPostPreview(key, row) {
  const sp = lr41Sp(row);
  const text = lr41PostText(row);
  const format = lr41PostFormat(row);
  const attachments = lr41PostAttachments(row);

  // Сначала пробуем существующий просмотр проекта, если он есть.
  try {
    if (typeof lr32SendQueuePostPreview === 'function') {
      await lr32SendQueuePostPreview(key, sp);
      return;
    }
  } catch (error) {
    console.error('[v41 posts] old preview failed:', error.message || error);
  }

  // Фолбек: отправляем сам пост в чат пользователя без подписи "Так будет выглядеть".
  try {
    await sendMaxMessage({
      chatId: Number(key),
      text,
      format,
      attachments: attachments || undefined,
      notify: false,
    });
  } catch (error) {
    console.error('[v41 posts] preview send failed:', error.message || error);
  }
}

async function lr41ShowPost(callbackId, key, id, sendPreview = true) {
  const row = await lr41GetOnePost(id);

  if (!row) {
    await answerCallback({
      callbackId,
      text: 'Пост не найден.',
      attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'queue:all')]]),
    });
    return;
  }

  const locked = lr43IsOlderThan24h(row);

  // ВАЖНО: не редактируем старое сообщение списка в меню поста.
  // Сначала тихо отвечаем на callback, потом отправляем новые сообщения:
  // 1) сам пост-превью;
  // 2) отдельное меню управления под ним.
  await lr43AnswerCallbackSilently(callbackId);

  if (sendPreview) {
    await lr41SendPostPreview(key, row);
  }

  await lr43SendPostControlMenu(key, row, locked);
}


async function lr41PickRemovedStatus() {
  try {
    const rows = lr41Rows(await query(`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = (
        SELECT udt_name
        FROM information_schema.columns
        WHERE table_name = 'scheduled_posts' AND column_name = 'status'
        LIMIT 1
      )
    `)).map((r) => r.enumlabel);

    for (const value of ['deleted', 'cancelled', 'canceled', 'failed']) {
      if (rows.includes(value)) return value;
    }
  } catch (error) {
    console.error('[v41 posts] enum read failed:', error.message || error);
  }
  return 'failed';
}

async function lr41ConfirmDelete(callbackId, id) {
  const row = await lr41GetOnePost(id);
  if (!row) {
    await answerCallback({
      callbackId,
      text: 'Пост не найден.',
      attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'queue:all')]]),
    });
    return;
  }

  const action = lr41PostStatus(row) === 'published' ? 'удалить из канала' : 'удалить из очереди';

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
❌ <b>Подтвердите удаление</b>

Пост #${lr41Sp(row).id}
«${lr41HtmlEscape(lr41Short(lr41PostText(row), 100))}»

Действие: ${action}.
━━━━━━━━━━━━━━`,
    format: 'html',
    attachments: inlineKeyboard([
      [callbackButton('✅ Да, удалить', `queue:delete:${lr41Sp(row).id}`)],
      [callbackButton('⬅️ Назад к посту', `queue:post:${lr41Sp(row).id}:nopreview`)],
      [callbackButton('📋 К постам', 'queue:all')],
    ]),
  });
}

async function lr41DeletePost(callbackId, id) {
  const status = await lr41PickRemovedStatus();
  await query('UPDATE scheduled_posts SET status = $2, updated_at = now() WHERE id = $1', [Number(id), status]);

  await answerCallback({
    callbackId,
    text: `✅ Пост #${id} удалён из активного списка.`,
    attachments: inlineKeyboard([
      [callbackButton('📋 К постам', 'queue:all')],
      [callbackButton('⬅️ В Studio', 'main:posting')],
    ]),
  });
}

async function lr41QueueNow(callbackId, id) {
  await query("UPDATE scheduled_posts SET publish_at = now(), status = 'scheduled', updated_at = now() WHERE id = $1", [Number(id)]);
  await answerCallback({
    callbackId,
    text: `🚀 Пост #${id} отправлен на ближайшую публикацию.`,
    attachments: inlineKeyboard([
      [callbackButton('📋 К постам', 'queue:all')],
      [callbackButton('⬅️ В Studio', 'main:posting')],
    ]),
  });
}

async function lr41HandlePostsPayload(payload, callbackId, key) {
  if (!payload || !String(payload).startsWith('queue:')) return false;

  if (payload === 'queue:noop') return true;

  if (payload === 'queue:menu' || payload === 'queue:all') {
    await lr41ShowPosts(callbackId, 'all');
    return true;
  }

  if (payload === 'queue:scheduled') {
    await lr41ShowPosts(callbackId, 'scheduled');
    return true;
  }

  if (payload === 'queue:published') {
    await lr41ShowPosts(callbackId, 'published');
    return true;
  }

  if (payload === 'queue:channels') {
    await lr41ShowChannels(callbackId);
    return true;
  }

  if (payload.startsWith('queue:channel:')) {
    const parts = payload.split(':');
    const channelId = Number(parts[2]);
    const mode = parts[3] || 'all';
    await lr41ShowPosts(callbackId, mode, channelId);
    return true;
  }

  if (payload.startsWith('queue:post:')) {
    const parts = payload.split(':');
    const id = Number(parts[2]);
    const sendPreview = parts[3] !== 'nopreview';
    await lr41ShowPost(callbackId, key, id, sendPreview);
    return true;
  }

  if (payload.startsWith('queue:delete_confirm:')) {
    await lr41ConfirmDelete(callbackId, Number(payload.split(':')[2]));
    return true;
  }

  if (payload.startsWith('queue:delete:')) {
    await lr41DeletePost(callbackId, Number(payload.split(':')[2]));
    return true;
  }

  if (payload.startsWith('queue:now:')) {
    await lr41QueueNow(callbackId, Number(payload.split(':')[2]));
    return true;
  }

  // Для редактирования текста/времени отдаём управление старой рабочей логике.
  if (payload.startsWith('queue:edit:text:') || payload.startsWith('queue:edit:time:')) {
    return false;
  }

  await lr41ShowPosts(callbackId, 'all');
  return true;
}

// ===== LinkRay v43 post open order START =====
function lr43IsOlderThan24h(row) {
  const sp = lr41Sp(row);
  const status = lr41PostStatus(row);
  if (status !== 'published') return false;

  const base = sp.published_at || sp.publish_at || sp.updated_at || sp.created_at;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return false;

  return Date.now() - d.getTime() > 24 * 60 * 60 * 1000;
}

function lr43PostMenuText(row, locked) {
  const sp = lr41Sp(row);
  const ch = lr41Ch(row);
  const d = lr41PostDate(row);
  const isAd = lr41IsAd(row);
  const cpm = lr41Cpm(row);
  const deleteAfter = lr41DeleteAfter(row);

  if (locked) {
    return `━━━━━━━━━━━━━━
🔒 <b>Пост #${sp.id}</b>

↑ Пост находится над этим сообщением ↑

📣 <b>Канал:</b>
${lr41ChannelHtmlLine(ch)}

🕒 <b>Опубликован:</b> ${lr41Time(d)} · ${lr41DateLine(d)}
✅ <b>Статус:</b> опубликован

Редактирование недоступно: после публикации прошло больше 24 часов.
━━━━━━━━━━━━━━`;
  }

  return `━━━━━━━━━━━━━━
${isAd ? '💼 <b>Рекламный пост</b>' : '📄 <b>Пост</b>'} #${sp.id}

↑ Пост находится над этим сообщением ↑

📣 <b>Канал:</b>
${lr41ChannelHtmlLine(ch)}

🕒 <b>Время:</b> ${lr41Time(d)} · ${lr41DateLine(d)}
${lr41StatusIcon(row)} <b>Статус:</b> ${lr41StatusText(row)}
🗑 <b>Автоудаление:</b> ${lr41MinutesText(deleteAfter)}
${isAd ? `💰 <b>CPM:</b> ${cpm ? `${cpm} ₽` : 'не указан'}\n` : ''}
Выберите действие.
━━━━━━━━━━━━━━`;
}

function lr43PostMenuKeyboard(row, locked) {
  const sp = lr41Sp(row);
  const status = lr41PostStatus(row);

  if (locked) {
    return inlineKeyboard([
      [callbackButton('⬅️ К постам', 'queue:all')],
    ]);
  }

  const rows = [
    [callbackButton('✏️ Редактировать пост', `queue:edit:text:${sp.id}`)],
    [callbackButton('🕒 Изменить время', `queue:edit:time:${sp.id}`)],
    [callbackButton('🗑 Автоудаление', `queue:auto_delete:${sp.id}`)],
  ];

  if (status !== 'published') {
    rows.push([callbackButton('🚀 Опубликовать сейчас', `queue:now:${sp.id}`)]);
  }

  rows.push([
    callbackButton(status === 'published' ? '❌ Удалить из канала' : '❌ Удалить пост', `queue:delete_confirm:${sp.id}`),
  ]);

  rows.push([callbackButton('⬅️ К постам', 'queue:all')]);

  return inlineKeyboard(rows);
}

async function lr43AnswerCallbackSilently(callbackId) {
  try {
    await answerCallback({ callbackId, notification: 'Открываю пост...' });
    return;
  } catch (error) {
    try {
      await answerCallback({ callbackId, text: 'Открываю пост...' });
    } catch (inner) {
      console.error('[v43] callback ack failed:', inner.message || inner);
    }
  }
}

async function lr43SendPostControlMenu(key, row, locked) {
  await sendMaxMessage({
    chatId: Number(key),
    text: lr43PostMenuText(row, locked),
    format: 'html',
    attachments: lr43PostMenuKeyboard(row, locked),
    notify: false,
  });
}
// ===== LinkRay v43 post open order END =====

// ===== LinkRay v41 posts UI END =====


// ===== LinkRay v44 stable posts START =====

// ===== LinkRay v45 posts menu fix START =====
async function lr45PostCounts(channelId = null) {
  const where = ["sp.status::text IN ('scheduled','published')"];
  const params = [];

  if (channelId) {
    params.push(Number(channelId));
    where.push(`sp.channel_id = $${params.length}`);
  }

  const rows = lr44Rows(await query(`
    SELECT
      COUNT(*)::int AS all_count,
      COUNT(*) FILTER (WHERE sp.status::text = 'scheduled')::int AS scheduled_count,
      COUNT(*) FILTER (WHERE sp.status::text = 'published')::int AS published_count
    FROM scheduled_posts sp
    WHERE ${where.join(' AND ')}
  `, params));

  const row = rows[0] || {};
  return {
    all: Number(row.all_count || 0),
    scheduled: Number(row.scheduled_count || 0),
    published: Number(row.published_count || 0),
  };
}

function lr45FilterLabel(mode) {
  if (mode === 'scheduled') return 'отложенные';
  if (mode === 'published') return 'опубликованные';
  return 'все посты';
}

function lr45FilterButtons(mode, channelId = null) {
  const scheduledPayload = channelId ? `post:channel:${channelId}:scheduled` : 'post:scheduled';
  const publishedPayload = channelId ? `post:channel:${channelId}:published` : 'post:published';
  const allPayload = channelId ? `post:channel:${channelId}:all` : 'post:all';

  return [
    [
      callbackButton(mode === 'scheduled' ? '✅ Отложенные' : '⏳ Отложенные', scheduledPayload),
      callbackButton(mode === 'published' ? '✅ Опубликованные' : '🟢 Опубликованные', publishedPayload),
    ],
    [
      callbackButton(mode === 'all' ? '✅ Все посты' : '📋 Все посты', allPayload),
    ],
  ];
}
// ===== LinkRay v45 posts menu fix END =====
const LR44_BOT_LINK = 'https://max.ru/se13353901_bot';

function lr44Rows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.data)) return result.data;
  return [];
}

function lr44Json(value, fallback = {}) {
  try {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function lr44Escape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lr44Attr(value) {
  return lr44Escape(value).replace(/"/g, '&quot;');
}

function lr44Plain(value) {
  return String(value || '')
    .replace(/<a\s+[^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(b|strong|i|em|u|s|strike|code|pre|span|p|div|h1|h2|h3)[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function lr44Short(value, max = 42) {
  const s = lr44Plain(value).replace(/\s+/g, ' ').trim();
  if (!s) return 'пост без текста';
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function lr44Month(d) {
  return ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][d.getMonth()] || '';
}

function lr44Day(d) {
  return ['вс','пн','вт','ср','чт','пт','сб'][d.getDay()] || '';
}

function lr44Time(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function lr44Date(d) {
  return `${lr44Day(d)} ${d.getDate()} ${lr44Month(d)} ${d.getFullYear()} г.`;
}

function lr44DateTime(d) {
  return `${lr44Time(d)} · ${lr44Date(d)}`;
}

function lr44ValidDate(value) {
  const d = new Date(value || Date.now());
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function lr44PostDate(sp) {
  return lr44ValidDate(sp.published_at || sp.publish_at || sp.updated_at || sp.created_at);
}

function lr44IsPublished(sp) {
  return String(sp.status || '').toLowerCase() === 'published';
}

function lr44IsScheduled(sp) {
  return String(sp.status || '').toLowerCase() === 'scheduled';
}

function lr44StatusLabel(sp) {
  const status = String(sp.status || '').toLowerCase();
  if (status === 'published') return 'опубликован';
  if (status === 'scheduled') return 'запланирован';
  if (status === 'publishing') return 'публикуется';
  if (status === 'error') return 'ошибка';
  if (status === 'canceled' || status === 'cancelled') return 'отменён';
  return status || 'неизвестно';
}

function lr44StatusIcon(sp) {
  const status = String(sp.status || '').toLowerCase();
  if (status === 'published') return '✅';
  if (status === 'scheduled') return '⏳';
  if (status === 'error') return '⚠️';
  if (status === 'canceled' || status === 'cancelled') return '❌';
  return '📄';
}

function lr44IsAd(sp) {
  const draft = lr44Json(sp.draft, {});
  return Boolean(sp.is_ad || draft.isAd || draft.is_ad || sp.cpm || draft.cpm);
}

function lr44Cpm(sp) {
  const draft = lr44Json(sp.draft, {});
  return sp.cpm || draft.cpm || null;
}

function lr44AutoDelete(sp) {
  const draft = lr44Json(sp.draft, {});
  return sp.auto_delete_minutes || draft.autoDeleteMinutes || draft.auto_delete_minutes || null;
}

function lr44MinutesText(value) {
  if (!value) return 'нет';
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 'нет';
  if (n % 1440 === 0) return `${n / 1440}д`;
  if (n % 60 === 0) return `${n / 60}ч`;
  return `${n} мин`;
}

function lr44OlderThan24h(sp) {
  if (!lr44IsPublished(sp)) return false;
  const base = sp.published_at || sp.publish_at || sp.updated_at || sp.created_at;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() > 24 * 60 * 60 * 1000;
}

function lr44ChannelName(ch) {
  return ch?.title || ch?.name || `Канал #${ch?.id || ch?.channel_id || '?'}`;
}

function lr44ChannelLine(ch) {
  const title = lr44Escape(lr44ChannelName(ch));
  const link = ch?.link || ch?.url || ch?.invite_link || '';
  return link ? `• <a href="${lr44Attr(link)}">${title}</a>` : `• ${title}`;
}

function lr44MessageId(sp) {
  const draft = lr44Json(sp.draft, {});
  return sp.published_message_id || sp.message_id || sp.max_message_id || draft.published_message_id || draft.message_id || draft.max_message_id || null;
}

function lr44PostText(sp) {
  const draft = lr44Json(sp.draft, {});
  return sp.text || draft.text || draft.content?.text || '';
}

function lr44PostFormat(sp) {
  const draft = lr44Json(sp.draft, {});
  return sp.format || draft.format || draft.content?.format || 'html';
}

function lr44PostAttachments(sp) {
  const draft = lr44Json(sp.draft, {});
  const a = sp.attachments || draft.attachments || draft.content?.attachments || [];
  return Array.isArray(a) ? a : [];
}

function lr44PostButtons(sp) {
  const draft = lr44Json(sp.draft, {});
  const b = sp.buttons || draft.buttons || [];
  return Array.isArray(b) ? b : [];
}

function lr44IsInlineKeyboard(att) {
  return String(att?.type || '').toLowerCase() === 'inline_keyboard';
}

function lr44MediaOnly(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).filter((a) => a && !lr44IsInlineKeyboard(a));
}

function lr44ButtonAttachment(buttons = []) {
  if (!Array.isArray(buttons) || !buttons.length) return null;
  const rows = [];
  for (const row of buttons) {
    const items = Array.isArray(row) ? row : [row];
    const btnRow = [];
    for (const b of items) {
      const text = String(b?.text || b?.title || '').trim();
      const url = String(b?.url || b?.link || '').trim();
      if (text && /^https?:\/\//i.test(url)) btnRow.push(linkButton(text, url));
    }
    if (btnRow.length) rows.push(btnRow);
  }
  return rows.length ? inlineKeyboard(rows) : null;
}

function lr44FinalAttachments(media = [], buttons = []) {
  const out = [...lr44MediaOnly(media)];
  const kb = lr44ButtonAttachment(buttons);
  if (kb) out.push(kb);
  return out;
}

function lr44MakeEditorFromPost(row) {
  const sp = row.sp || row;
  const ch = row.ch || {};
  const draft = lr44Json(sp.draft, {});
  return {
    postId: Number(sp.id),
    channelId: Number(sp.channel_id || ch.id),
    channel: ch,
    status: String(sp.status || ''),
    publishedMessageId: lr44MessageId(sp),
    isAd: lr44IsAd(sp),
    cpm: lr44Cpm(sp),
    autoDeleteMinutes: lr44AutoDelete(sp),
    text: lr44PostText(sp),
    format: lr44PostFormat(sp),
    attachments: lr44PostAttachments(sp),
    buttons: lr44PostButtons(sp),
    signatureEnabled: false,
    signatureText: '',
    signatureFormat: 'html',
    signatureMarkup: [],
    originalDraft: draft,
  };
}

function lr44BuildEditorText(editor) {
  let text = String(editor.text || '');
  let format = editor.format || 'html';

  if (!editor.isAd && editor.signatureEnabled && String(editor.signatureText || '').trim()) {
    text = `${text}\n\n${editor.signatureText}`;
    if (editor.signatureFormat === 'html' || (typeof lrLooksLikeHtml === 'function' && lrLooksLikeHtml(editor.signatureText))) format = 'html';
  }

  return { text, format };
}

function lr44ParseButtonLines(input) {
  const rows = [];
  const lines = String(input || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);

  for (const line of lines) {
    const parts = line.split('|').map((x) => x.trim()).filter(Boolean);
    const row = [];
    for (const part of parts) {
      const m = part.match(/^(.+?)\s*(?:-|—|–)\s*(https?:\/\/\S+)$/i);
      if (!m) continue;
      row.push({ text: m[1].trim(), url: m[2].trim() });
    }
    if (row.length) rows.push(row);
  }

  return rows;
}

function lr44ParseDuration(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw || raw === 'нет' || raw === 'none' || raw === '0') return null;

  const hm = raw.match(/^(\d{1,3})\s*:\s*(\d{1,2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);

  const h = raw.match(/^(\d+(?:[.,]\d+)?)\s*(ч|час|часа|часов|h)$/i);
  if (h) return Math.round(Number(h[1].replace(',', '.')) * 60);

  const d = raw.match(/^(\d+(?:[.,]\d+)?)\s*(д|дн|день|дня|дней|d)$/i);
  if (d) return Math.round(Number(d[1].replace(',', '.')) * 1440);

  const m = raw.match(/^(\d+(?:[.,]\d+)?)\s*(мин|м|minute|minutes|min)?$/i);
  if (m) return Math.round(Number(m[1].replace(',', '.')));

  return null;
}

async function lr44GetPosts(mode = 'all', channelId = null, limit = 12) {
  const where = ["sp.status::text IN ('scheduled','published')"];
  const params = [];

  if (mode === 'scheduled') where.push("sp.status::text = 'scheduled'");
  if (mode === 'published') where.push("sp.status::text = 'published'");

  if (channelId) {
    params.push(Number(channelId));
    where.push(`sp.channel_id = $${params.length}`);
  }

  params.push(Number(limit));

  return lr44Rows(await query(`
    SELECT to_jsonb(sp) AS sp, to_jsonb(c) AS ch
    FROM scheduled_posts sp
    LEFT JOIN channels c ON c.id = sp.channel_id
    WHERE ${where.join(' AND ')}
    ORDER BY sp.publish_at DESC NULLS LAST, sp.id DESC
    LIMIT $${params.length}
  `, params));
}

async function lr44GetOnePost(id) {
  const rows = lr44Rows(await query(`
    SELECT to_jsonb(sp) AS sp, to_jsonb(c) AS ch
    FROM scheduled_posts sp
    LEFT JOIN channels c ON c.id = sp.channel_id
    WHERE sp.id = $1
    LIMIT 1
  `, [Number(id)]));
  return rows[0] || null;
}

async function lr44GetChannelsWithCounts() {
  return lr44Rows(await query(`
    SELECT
      to_jsonb(c) AS ch,
      COUNT(sp.id) FILTER (WHERE sp.status::text = 'scheduled') AS scheduled_count,
      COUNT(sp.id) FILTER (WHERE sp.status::text = 'published') AS published_count
    FROM channels c
    LEFT JOIN scheduled_posts sp ON sp.channel_id = c.id AND sp.status::text IN ('scheduled','published')
    GROUP BY c.id
    ORDER BY c.title ASC NULLS LAST, c.id ASC
    LIMIT 30
  `));
}

function lr44PostListButton(row) {
  const sp = row.sp || row;
  const d = lr44PostDate(sp);
  const ad = lr44IsAd(sp) ? '💼 ' : '';
  const media = lr44PostAttachments(sp).length ? '🖼 ' : '';
  return `${ad}${lr44StatusIcon(sp)} ${lr44Time(d)} · ${media}${lr44Short(lr44PostText(sp), 34)}`;
}

async function lr44ShowPosts(callbackId, mode = 'all', channelId = null) {
  mode = ['all', 'scheduled', 'published'].includes(String(mode)) ? String(mode) : 'all';

  const rowsData = await lr44GetPosts(mode, channelId, 12);
  const counts = await lr45PostCounts(channelId);

  let channel = rowsData[0]?.ch || null;

  if (channelId && (!channel || !channel.id)) {
    const rows = await getChannelsByIds([Number(channelId)]).catch(() => []);
    channel = rows[0] || null;
  }

  const buttons = [];

  for (const row of rowsData) {
    const sp = row.sp || row;

    // queue:post:id оставляем специально:
    // старые части бота уже знают queue:post, а v44/v45 тоже его перехватывают.
    buttons.push([callbackButton(lr44PostListButton(row), `queue:post:${sp.id}`)]);
  }

  if (!buttons.length) {
    buttons.push([callbackButton('Постов пока нет', 'post:noop')]);
  }

  for (const filterRow of lr45FilterButtons(mode, channelId)) {
    buttons.push(filterRow);
  }

  buttons.push([callbackButton('📡 По каналам', 'post:channels')]);
  buttons.push([callbackButton('⬅️ В Studio', 'main:posting')]);

  const title = channel ? lr44ChannelName(channel) : 'Все каналы';
  const dateLine = lr44Date(new Date());

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
🗂 <b>Посты</b>

📣 <b>${lr44Escape(title)}</b>
📅 ${dateLine}

Фильтр: <b>${lr45FilterLabel(mode)}</b>

📋 Всего: ${counts.all}
⏳ Запланировано: ${counts.scheduled}
✅ Опубликовано: ${counts.published}
👁 Показано: ${rowsData.length}${rowsData.length ? '' : '\n\nПостов пока нет.'}

Нажмите на пост, чтобы открыть управление.
━━━━━━━━━━━━━━`,
    format: 'html',
    attachments: inlineKeyboard(buttons),
  });
}


async function lr44ShowChannels(callbackId) {
  const rows = await lr44GetChannelsWithCounts();
  const buttons = [[callbackButton('🌐 Все каналы', 'post:all')]];

  for (const row of rows) {
    const ch = row.ch || {};
    buttons.push([callbackButton(`📡 ${lr44ChannelName(ch)} · ⏳${Number(row.scheduled_count || 0)} / ✅${Number(row.published_count || 0)}`, `post:channel:${ch.id}:all`)]);
  }

  if (!rows.length) buttons.push([callbackButton('Каналов пока нет', 'post:noop')]);
  buttons.push([callbackButton('⬅️ К постам', 'post:all')]);

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
📡 <b>Посты по каналам</b>

Выберите канал.
━━━━━━━━━━━━━━`,
    format: 'html',
    attachments: inlineKeyboard(buttons),
  });
}

async function lr44Ack(callbackId, text = 'Открываю...') {
  try {
    await answerCallback({ callbackId, notification: text });
  } catch {
    try { await answerCallback({ callbackId, text }); } catch {}
  }
}

async function lr44SendStoredPostPreview(key, row) {
  const sp = row.sp || row;
  await sendMaxMessage({
    chatId: Number(key),
    text: lr44PostText(sp),
    format: lr44PostFormat(sp),
    attachments: lr44FinalAttachments(lr44PostAttachments(sp), lr44PostButtons(sp)),
    notify: false,
  });
}

function lr44PostCardText(row) {
  const sp = row.sp || row;
  const ch = row.ch || {};
  const d = lr44PostDate(sp);
  const isAd = lr44IsAd(sp);
  const locked = lr44OlderThan24h(sp);

  if (locked) {
    return `━━━━━━━━━━━━━━
🔒 <b>Пост #${sp.id}</b>

↑ Пост находится над этим сообщением ↑

🕒 <b>Опубликован:</b> ${lr44DateTime(d)}
✅ <b>Статус:</b> опубликован
🗑 <b>Автоудаление:</b> ${lr44MinutesText(lr44AutoDelete(sp))}

<b>Канал:</b>
${lr44ChannelLine(ch)}

Редактирование недоступно: после публикации прошло больше 24 часов.
━━━━━━━━━━━━━━`;
  }

  if (lr44IsPublished(sp)) {
    return `━━━━━━━━━━━━━━
${isAd ? '💼 <b>Рекламный пост</b>' : '📄 <b>Пост</b>'} #${sp.id}

↑ Пост находится над этим сообщением ↑

🕒 <b>Опубликован:</b> ${lr44DateTime(d)}
✅ <b>Статус:</b> опубликован
🗑 <b>Автоудаление:</b> ${lr44MinutesText(lr44AutoDelete(sp))}
${isAd ? `💰 <b>CPM:</b> ${lr44Cpm(sp) || 'не указан'} ₽\n` : ''}
<b>Канал:</b>
${lr44ChannelLine(ch)}
━━━━━━━━━━━━━━`;
  }

  return `━━━━━━━━━━━━━━
${isAd ? '💼 <b>Рекламный пост</b>' : '📄 <b>Пост</b>'} #${sp.id}

↑ Пост находится над этим сообщением ↑

🕒 <b>Запланирован:</b> ${lr44DateTime(d)}
⏳ <b>Статус:</b> запланирован
🗑 <b>Автоудаление:</b> ${lr44MinutesText(lr44AutoDelete(sp))}
${isAd ? `💰 <b>CPM:</b> ${lr44Cpm(sp) || 'не указан'} ₽\n` : ''}
<b>Канал:</b>
${lr44ChannelLine(ch)}
━━━━━━━━━━━━━━`;
}

function lr44PostCardKeyboard(row) {
  const sp = row.sp || row;
  if (lr44OlderThan24h(sp)) {
    return inlineKeyboard([[callbackButton('⬅️ Назад', 'post:all')]]);
  }

  if (lr44IsPublished(sp)) {
    return inlineKeyboard([
      [callbackButton('✏️ Перейти в редактор', `post:editor:${sp.id}`)],
      [callbackButton(`🗑 Удаление: ${lr44MinutesText(lr44AutoDelete(sp))}`, `post:auto_delete:${sp.id}`)],
      [callbackButton('❌ Удалить из канала', `post:delete_confirm:${sp.id}`)],
      [callbackButton('⬅️ Назад', 'post:all')],
    ]);
  }

  return inlineKeyboard([
    [callbackButton('✏️ Перейти в редактор', `post:editor:${sp.id}`)],
    [callbackButton('🕒 Изменить время', `queue:edit:time:${sp.id}`)],
    [callbackButton(`🗑 Удаление: ${lr44MinutesText(lr44AutoDelete(sp))}`, `post:auto_delete:${sp.id}`)],
    [callbackButton('🚀 Опубликовать сейчас', `post:now:${sp.id}`)],
    [callbackButton('❌ Удалить пост', `post:delete_confirm:${sp.id}`)],
    [callbackButton('⬅️ Назад', 'post:all')],
  ]);
}

async function lr44OpenPost(callbackId, key, id) {
  const row = await lr44GetOnePost(id);

  if (!row) {
    await answerCallback({
      callbackId,
      text: 'Пост не найден.',
      attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'post:all')]]),
    });
    return;
  }

  await lr44Ack(callbackId, 'Открываю пост...');
  await lr44SendStoredPostPreview(key, row);
  await sendMaxMessage({
    chatId: Number(key),
    text: lr44PostCardText(row),
    format: 'html',
    attachments: lr44PostCardKeyboard(row),
    notify: false,
  });
}

function lr44EditorText(editor) {
  const hasButtons = Array.isArray(editor.buttons) && editor.buttons.length;
  const hasMedia = Array.isArray(editor.attachments) && lr44MediaOnly(editor.attachments).length;
  const sig = editor.isAd ? 'выключена для рекламы' : (editor.signatureEnabled ? 'включена' : 'выключена');

  return `━━━━━━━━━━━━━━
🧬 <b>Редактор LinkRay</b>

${editor.isAd ? '💼 Рекламный пост\n' : ''}Текст: ${String(editor.text || '').trim() ? 'есть' : 'нет'}
Медиа: ${hasMedia ? 'есть' : 'нет'}
Кнопки: ${hasButtons ? 'есть' : 'нет'}
Автоподпись: ${sig}
Удаление: ${lr44MinutesText(editor.autoDeleteMinutes)}

Настройте пост и нажмите «Сохранить пост».
━━━━━━━━━━━━━━`;
}

function lr44EditorKeyboard(editor) {
  return inlineKeyboard([
    [callbackButton('✏️ Изменить текст', 'post:edit_text'), callbackButton('🖼 Медиа', 'post:edit_media')],
    [callbackButton('🔘 Добавить кнопку', 'post:add_button'), callbackButton('🏷 Автоподпись', 'post:signature')],
    [callbackButton('🔗 Редактировать кнопки', 'post:buttons')],
    [callbackButton('💾 Сохранить пост', 'post:save')],
    [callbackButton('⬅️ Назад', `post:open:${editor.postId}`)],
  ]);
}

async function lr44ShowEditor(callbackId, key, id) {
  const row = await lr44GetOnePost(id);
  if (!row) {
    await answerCallback({ callbackId, text: 'Пост не найден.', attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'post:all')]]) });
    return;
  }

  const sp = row.sp || row;
  if (lr44OlderThan24h(sp)) {
    await answerCallback({
      callbackId,
      text: '🔒 Пост опубликован больше 24 часов назад. Редактирование недоступно.',
      attachments: inlineKeyboard([[callbackButton('⬅️ Назад', `post:open:${sp.id}`)]]),
    });
    return;
  }

  const editor = lr44MakeEditorFromPost(row);
  await setSession(key, 'lr44_editor', { editor });
  await answerCallback({
    callbackId,
    text: lr44EditorText(editor),
    format: 'html',
    attachments: lr44EditorKeyboard(editor),
  });
}

async function lr44GetEditor(key) {
  const session = await getSession(key);
  if (!String(session.state || '').startsWith('lr44_')) return null;
  return session.data?.editor || null;
}

async function lr44SetEditor(key, state, editor) {
  await setSession(key, state, { editor });
}

async function lr44RefreshEditorByCallback(callbackId, key, editor) {
  await answerCallback({
    callbackId,
    text: lr44EditorText(editor),
    format: 'html',
    attachments: lr44EditorKeyboard(editor),
  });
}

async function lr44Prompt(callbackId, key, state, editor, text) {
  await lr44SetEditor(key, state, editor);
  await answerCallback({
    callbackId,
    text,
    format: 'html',
    attachments: inlineKeyboard([[callbackButton('⬅️ Назад', 'post:editor_back')], [callbackButton('❌ Отмена', 'post:cancel_edit')]]),
  });
}

async function lr44ShowButtonsEditor(callbackId, key) {
  const editor = await lr44GetEditor(key);
  if (!editor) {
    await answerCallback({ callbackId, text: 'Редактор не найден.', attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'post:all')]]) });
    return;
  }

  const rows = [];
  (editor.buttons || []).forEach((row, rowIndex) => {
    (Array.isArray(row) ? row : [row]).forEach((b, colIndex) => {
      rows.push([callbackButton(`❌ ${b.text || b.title || 'кнопка'}`, `post:button_delete:${rowIndex}:${colIndex}`)]);
    });
  });

  if (!rows.length) rows.push([callbackButton('Кнопок пока нет', 'post:noop')]);
  rows.push([callbackButton('➕ Добавить кнопку', 'post:add_button')]);
  rows.push([callbackButton('⬅️ В редактор', 'post:editor_back')]);

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
🔗 <b>Кнопки поста</b>

Нажмите на кнопку, чтобы удалить её.
Формат добавления: <code>Название - https://site.ru</code>
━━━━━━━━━━━━━━`,
    format: 'html',
    attachments: inlineKeyboard(rows),
  });
}

async function lr44ShowSignature(callbackId, key) {
  const editor = await lr44GetEditor(key);
  if (!editor) return answerCallback({ callbackId, text: 'Редактор не найден.' });

  if (editor.isAd) {
    await answerCallback({
      callbackId,
      text: '💼 Для рекламного поста автоподпись не добавляется.',
      attachments: inlineKeyboard([[callbackButton('⬅️ В редактор', 'post:editor_back')]]),
    });
    return;
  }

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
🏷 <b>Автоподпись</b>

Статус: ${editor.signatureEnabled ? 'включена' : 'выключена'}

Можно отправить подпись обычным сообщением: ссылки, жирный, курсив и подчёркивание из MAX сохраняются.
━━━━━━━━━━━━━━`,
    format: 'html',
    attachments: inlineKeyboard([
      [callbackButton('✏️ Заменить подпись', 'post:signature_set')],
      [callbackButton(editor.signatureEnabled ? '🚫 Выключить' : '✅ Включить', 'post:signature_toggle')],
      [callbackButton('⬅️ В редактор', 'post:editor_back')],
    ]),
  });
}

async function lr44ShowAutoDelete(callbackId, key, postId = null) {
  const target = postId || 'editor';
  const rows = [
    [callbackButton('1ч', `post:auto_set:${target}:60`), callbackButton('2ч', `post:auto_set:${target}:120`), callbackButton('4ч', `post:auto_set:${target}:240`)],
    [callbackButton('8ч', `post:auto_set:${target}:480`), callbackButton('12ч', `post:auto_set:${target}:720`), callbackButton('24ч', `post:auto_set:${target}:1440`)],
    [callbackButton('48ч', `post:auto_set:${target}:2880`), callbackButton('72ч', `post:auto_set:${target}:4320`), callbackButton('7д', `post:auto_set:${target}:10080`)],
    [callbackButton('🚫 Не удалять', `post:auto_set:${target}:none`)],
    [callbackButton('✍️ Ввести вручную', `post:auto_manual:${target}`)],
    [callbackButton('⬅️ Назад', postId ? `post:open:${postId}` : 'post:editor_back')],
  ];

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
🗑 <b>Автоудаление</b>

Выберите срок или введите вручную.
━━━━━━━━━━━━━━`,
    format: 'html',
    attachments: inlineKeyboard(rows),
  });
}

async function lr44UpdatePostAutoDelete(postId, minutes) {
  await query(`
    UPDATE scheduled_posts
    SET auto_delete_minutes = $2, updated_at = now()
    WHERE id = $1
  `, [Number(postId), minutes === null ? null : Number(minutes)]);
}

async function lr44SetAutoDelete(callbackId, key, target, value) {
  const minutes = value === 'none' ? null : Number(value);

  if (target === 'editor') {
    const editor = await lr44GetEditor(key);
    if (!editor) return answerCallback({ callbackId, text: 'Редактор не найден.' });
    editor.autoDeleteMinutes = minutes;
    await lr44SetEditor(key, 'lr44_editor', editor);
    await lr44RefreshEditorByCallback(callbackId, key, editor);
    return;
  }

  await lr44UpdatePostAutoDelete(Number(target), minutes);
  await answerCallback({
    callbackId,
    text: `✅ Автоудаление обновлено: ${lr44MinutesText(minutes)}.`,
    attachments: inlineKeyboard([[callbackButton('⬅️ Назад к посту', `post:open:${target}`)], [callbackButton('📋 К постам', 'post:all')]]),
  });
}

function lr44ApiUrl() {
  return process.env.MAX_API_URL || process.env.MAX_BASE_URL || 'https://platform-api.max.ru';
}

function lr44Token() {
  return process.env.BOT_TOKEN || process.env.MAX_BOT_TOKEN || process.env.MAX_TOKEN || '';
}

function lr44Headers() {
  return {
    Authorization: lr44Token(),
    'Content-Type': 'application/json',
  };
}

async function lr44MaxEditMessage(messageId, body) {
  if (!messageId) throw new Error('published_message_id is empty');

  const url = new URL(`${lr44ApiUrl()}/messages`);
  url.searchParams.set('message_id', String(messageId));

  const response = await fetch(url, {
    method: 'PUT',
    headers: lr44Headers(),
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) {
    throw new Error(`MAX edit message failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function lr44MaxDeleteMessage(messageId) {
  if (!messageId) throw new Error('published_message_id is empty');

  const url = new URL(`${lr44ApiUrl()}/messages`);
  url.searchParams.set('message_id', String(messageId));

  const response = await fetch(url, {
    method: 'DELETE',
    headers: lr44Headers(),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) {
    throw new Error(`MAX delete message failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function lr44SaveEditor(callbackId, key) {
  const editor = await lr44GetEditor(key);
  if (!editor) {
    await answerCallback({ callbackId, text: 'Редактор не найден.', attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'post:all')]]) });
    return;
  }

  const row = await lr44GetOnePost(editor.postId);
  if (!row) {
    await answerCallback({ callbackId, text: 'Пост не найден.', attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'post:all')]]) });
    return;
  }

  const sp = row.sp || row;
  if (lr44OlderThan24h(sp)) {
    await answerCallback({ callbackId, text: '🔒 Редактирование недоступно: прошло больше 24 часов.', attachments: inlineKeyboard([[callbackButton('⬅️ Назад', `post:open:${sp.id}`)]]) });
    return;
  }

  const final = lr44BuildEditorText(editor);
  const finalAttachments = lr44FinalAttachments(editor.attachments, editor.buttons);
  const draft = {
    ...(editor.originalDraft || {}),
    lr44Edited: true,
    content: {
      text: editor.text,
      format: editor.format,
      attachments: lr44MediaOnly(editor.attachments),
    },
    buttons: editor.buttons,
    signatureEnabled: editor.signatureEnabled,
    signatureText: editor.signatureText,
    signatureFormat: editor.signatureFormat,
    autoDeleteMinutes: editor.autoDeleteMinutes,
    cpm: editor.cpm,
    isAd: editor.isAd,
  };

  await query(`
    UPDATE scheduled_posts
    SET text = $2,
        format = $3,
        attachments = $4::jsonb,
        buttons = $5::jsonb,
        draft = $6::jsonb,
        auto_delete_minutes = $7,
        updated_at = now()
    WHERE id = $1
  `, [
    editor.postId,
    final.text,
    final.format,
    JSON.stringify(lr44MediaOnly(editor.attachments)),
    JSON.stringify(editor.buttons || []),
    JSON.stringify(draft),
    editor.autoDeleteMinutes === null || editor.autoDeleteMinutes === undefined ? null : Number(editor.autoDeleteMinutes),
  ]);

  let maxUpdated = false;
  let warning = '';

  if (lr44IsPublished(sp)) {
    const mid = editor.publishedMessageId || lr44MessageId(sp);
    if (mid) {
      try {
        await lr44MaxEditMessage(mid, {
          text: final.text,
          format: final.format,
          attachments: finalAttachments,
        });
        maxUpdated = true;
      } catch (error) {
        warning = `\n\n⚠️ В базе сохранено, но MAX не обновил сообщение: ${lr44Escape(error.message || error)}`;
        console.error('[v44] edit published failed:', error.message || error);
      }
    } else {
      warning = '\n\n⚠️ В базе сохранено, но у поста нет published_message_id для изменения сообщения в канале.';
    }
  }

  await clearSession(key);

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
✅ <b>Пост сохранён</b>

${lr44IsPublished(sp) ? (maxUpdated ? 'Сообщение в канале обновлено.' : 'Изменения сохранены в базе.') : 'Изменения сохранены для очереди.'}${warning}
━━━━━━━━━━━━━━`,
    format: 'html',
    attachments: inlineKeyboard([
      [callbackButton('👁 Открыть пост', `post:open:${editor.postId}`)],
      [callbackButton('📋 К постам', 'post:all')],
    ]),
  });
}

async function lr44ConfirmDelete(callbackId, id) {
  const row = await lr44GetOnePost(id);
  if (!row) return answerCallback({ callbackId, text: 'Пост не найден.', attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'post:all')]]) });

  const sp = row.sp || row;
  const action = lr44IsPublished(sp) ? 'удалить из канала' : 'удалить из очереди';

  await answerCallback({
    callbackId,
    text: `━━━━━━━━━━━━━━
❌ <b>Подтвердите удаление</b>

Пост #${sp.id}
«${lr44Escape(lr44Short(lr44PostText(sp), 90))}»

Действие: ${action}.
━━━━━━━━━━━━━━`,
    format: 'html',
    attachments: inlineKeyboard([
      [callbackButton('✅ Да, удалить', `post:delete:${sp.id}`)],
      [callbackButton('⬅️ Назад', `post:open:${sp.id}`)],
    ]),
  });
}

async function lr44DeletePost(callbackId, id) {
  const row = await lr44GetOnePost(id);
  if (!row) return answerCallback({ callbackId, text: 'Пост не найден.', attachments: inlineKeyboard([[callbackButton('⬅️ К постам', 'post:all')]]) });

  const sp = row.sp || row;
  let warning = '';

  if (lr44IsPublished(sp)) {
    const mid = lr44MessageId(sp);
    if (mid) {
      try {
        await lr44MaxDeleteMessage(mid);
      } catch (error) {
        warning = `\n\n⚠️ MAX не удалил сообщение: ${lr44Escape(error.message || error)}`;
        console.error('[v44] delete published failed:', error.message || error);
      }
    } else {
      warning = '\n\n⚠️ У поста нет published_message_id, поэтому удалить сообщение из канала через API нельзя.';
    }
  }

  await query(`UPDATE scheduled_posts SET status = 'canceled', updated_at = now() WHERE id = $1`, [Number(id)]);

  await answerCallback({
    callbackId,
    text: `✅ Пост #${id} удалён из активного списка.${warning}`,
    format: 'html',
    attachments: inlineKeyboard([[callbackButton('📋 К постам', 'post:all')], [callbackButton('⬅️ В Studio', 'main:posting')]]),
  });
}

async function lr44PublishNow(callbackId, id) {
  await query(`UPDATE scheduled_posts SET publish_at = now(), status = 'scheduled', updated_at = now() WHERE id = $1`, [Number(id)]);
  await answerCallback({
    callbackId,
    text: `🚀 Пост #${id} отправлен на ближайшую публикацию.`,
    attachments: inlineKeyboard([[callbackButton('📋 К постам', 'post:all')]]),
  });
}

async function lr44HandleCallbackPayload(payload, callbackId, key) {
  const p = String(payload || '');
  if (!p.startsWith('post:') && !p.startsWith('queue:')) return false;

  if (p === 'post:noop' || p === 'queue:noop') return true;

  if (p === 'post:all' || p === 'queue:all' || p === 'queue:menu') {
    await lr44ShowPosts(callbackId, 'all');
    return true;
  }

  if (p === 'post:scheduled' || p === 'queue:scheduled') {
    await lr44ShowPosts(callbackId, 'scheduled');
    return true;
  }

  if (p === 'post:published' || p === 'queue:published') {
    await lr44ShowPosts(callbackId, 'published');
    return true;
  }

  if (p === 'post:channels' || p === 'queue:channels') {
    await lr44ShowChannels(callbackId);
    return true;
  }

  if (p.startsWith('post:channel:') || p.startsWith('queue:channel:')) {
    const parts = p.split(':');
    const id = Number(parts[2]);
    const mode = parts[3] || 'all';
    await lr44ShowPosts(callbackId, mode, id);
    return true;
  }

  if (p.startsWith('post:open:') || p.startsWith('queue:post:')) {
    const parts = p.split(':');
    const id = Number(parts[2]);
    if (!id) {
      await answerCallback({ callbackId, text: 'Не смог открыть пост: неверный ID.' });
      return true;
    }

    await lr44OpenPost(callbackId, key, id);
    return true;
  }

  if (p.startsWith('post:editor:')) {
    await lr44ShowEditor(callbackId, key, Number(p.split(':')[2]));
    return true;
  }

  if (p === 'post:editor_back') {
    const editor = await lr44GetEditor(key);
    if (!editor) return answerCallback({ callbackId, text: 'Редактор не найден.' }), true;
    await lr44SetEditor(key, 'lr44_editor', editor);
    await lr44RefreshEditorByCallback(callbackId, key, editor);
    return true;
  }

  if (p === 'post:cancel_edit') {
    await clearSession(key);
    await answerCallback({ callbackId, text: 'Редактирование отменено.', attachments: inlineKeyboard([[callbackButton('📋 К постам', 'post:all')]]) });
    return true;
  }

  if (p === 'post:edit_text') {
    const editor = await lr44GetEditor(key);
    if (!editor) return answerCallback({ callbackId, text: 'Редактор не найден.' }), true;
    await lr44Prompt(callbackId, key, 'lr44_wait_text', editor, `━━━━━━━━━━━━━━\n✏️ <b>Новый текст</b>\n\nОтправьте новый текст поста. Форматирование MAX сохранится.\n━━━━━━━━━━━━━━`);
    return true;
  }

  if (p === 'post:edit_media') {
    const editor = await lr44GetEditor(key);
    if (!editor) return answerCallback({ callbackId, text: 'Редактор не найден.' }), true;
    await lr44Prompt(callbackId, key, 'lr44_wait_media', editor, `━━━━━━━━━━━━━━\n🖼 <b>Медиа</b>\n\nОтправьте фото, видео или файл. Текст поста сохранится, если вы не добавите новую подпись к медиа.\n━━━━━━━━━━━━━━`);
    return true;
  }

  if (p === 'post:add_button') {
    const editor = await lr44GetEditor(key);
    if (!editor) return answerCallback({ callbackId, text: 'Редактор не найден.' }), true;
    await lr44Prompt(callbackId, key, 'lr44_wait_button', editor, `━━━━━━━━━━━━━━\n🔘 <b>Кнопка под постом</b>\n\nФормат:\n<code>Название - https://site.ru</code>\n\nНесколько кнопок в одной строке: через <code>|</code>.\nКаждая новая строка — новый ряд.\n━━━━━━━━━━━━━━`);
    return true;
  }

  if (p === 'post:signature') {
    await lr44ShowSignature(callbackId, key);
    return true;
  }

  if (p === 'post:signature_set') {
    const editor = await lr44GetEditor(key);
    if (!editor) return answerCallback({ callbackId, text: 'Редактор не найден.' }), true;
    await lr44Prompt(callbackId, key, 'lr44_wait_signature', editor, `━━━━━━━━━━━━━━\n🏷 <b>Новая автоподпись</b>\n\nОтправьте подпись. Ссылки, жирный, курсив и подчёркивание из MAX сохранятся.\n━━━━━━━━━━━━━━`);
    return true;
  }

  if (p === 'post:signature_toggle') {
    const editor = await lr44GetEditor(key);
    if (!editor) return answerCallback({ callbackId, text: 'Редактор не найден.' }), true;
    if (!editor.isAd) editor.signatureEnabled = !editor.signatureEnabled;
    await lr44SetEditor(key, 'lr44_editor', editor);
    await lr44ShowSignature(callbackId, key);
    return true;
  }

  if (p === 'post:buttons') {
    await lr44ShowButtonsEditor(callbackId, key);
    return true;
  }

  if (p.startsWith('post:button_delete:')) {
    const editor = await lr44GetEditor(key);
    if (!editor) return answerCallback({ callbackId, text: 'Редактор не найден.' }), true;
    const [, , rowIndexRaw, colIndexRaw] = p.split(':');
    const rowIndex = Number(rowIndexRaw);
    const colIndex = Number(colIndexRaw);
    const rows = Array.isArray(editor.buttons) ? editor.buttons : [];
    if (Array.isArray(rows[rowIndex])) rows[rowIndex].splice(colIndex, 1);
    editor.buttons = rows.map((r) => (Array.isArray(r) ? r.filter(Boolean) : [])).filter((r) => r.length);
    await lr44SetEditor(key, 'lr44_editor', editor);
    await lr44ShowButtonsEditor(callbackId, key);
    return true;
  }

  if (p === 'post:save') {
    await lr44SaveEditor(callbackId, key);
    return true;
  }

  if (p.startsWith('post:auto_delete:')) {
    await lr44ShowAutoDelete(callbackId, key, Number(p.split(':')[2]));
    return true;
  }

  if (p.startsWith('post:auto_manual:')) {
    const target = p.split(':')[2];
    if (target === 'editor') {
      const editor = await lr44GetEditor(key);
      if (!editor) return answerCallback({ callbackId, text: 'Редактор не найден.' }), true;
      await lr44Prompt(callbackId, key, 'lr44_wait_auto_delete', { ...editor, autoDeleteTarget: 'editor' }, `━━━━━━━━━━━━━━\n🗑 <b>Автоудаление</b>\n\nВведите срок: 48ч, 2д, 120 или 5:30.\n━━━━━━━━━━━━━━`);
    } else {
      await setSession(key, 'lr44_wait_auto_delete', { autoDeleteTarget: target });
      await answerCallback({ callbackId, text: 'Введите срок автоудаления: 48ч, 2д, 120 или 5:30.', attachments: inlineKeyboard([[callbackButton('⬅️ Назад', `post:open:${target}`)]]) });
    }
    return true;
  }

  if (p.startsWith('post:auto_set:')) {
    const parts = p.split(':');
    await lr44SetAutoDelete(callbackId, key, parts[2], parts[3]);
    return true;
  }

  if (p.startsWith('post:delete_confirm:')) {
    await lr44ConfirmDelete(callbackId, Number(p.split(':')[2]));
    return true;
  }

  if (p.startsWith('post:delete:')) {
    await lr44DeletePost(callbackId, Number(p.split(':')[2]));
    return true;
  }

  if (p.startsWith('post:now:')) {
    await lr44PublishNow(callbackId, Number(p.split(':')[2]));
    return true;
  }

  return false;
}

async function lr44HandleTextState(update, key) {
  const session = await getSession(key);
  const state = String(session.state || '');
  if (!state.startsWith('lr44_')) return false;

  const text = getMessageText(update);
  let editor = session.data?.editor || null;

  if (state === 'lr44_wait_auto_delete') {
    const minutes = lr44ParseDuration(text);
    const target = session.data?.autoDeleteTarget || editor?.autoDeleteTarget || 'editor';

    if (minutes === undefined) {
      await sendMaxMessage({ chatId: Number(key), text: 'Не понял срок. Пример: 48ч, 2д, 120 или 5:30.', notify: false });
      return true;
    }

    if (target === 'editor') {
      editor.autoDeleteMinutes = minutes;
      await lr44SetEditor(key, 'lr44_editor', editor);
      await sendMaxMessage({ chatId: Number(key), text: lr44EditorText(editor), format: 'html', attachments: lr44EditorKeyboard(editor), notify: false });
      return true;
    }

    await lr44UpdatePostAutoDelete(Number(target), minutes);
    await clearSession(key);
    await sendMaxMessage({ chatId: Number(key), text: `✅ Автоудаление обновлено: ${lr44MinutesText(minutes)}.`, attachments: inlineKeyboard([[callbackButton('👁 Открыть пост', `post:open:${target}`)], [callbackButton('📋 К постам', 'post:all')]]), notify: false });
    return true;
  }

  if (!editor) return false;

  if (state === 'lr44_wait_text') {
    const content = await extractContentWithHydration(update);
    editor.text = content.text || text;
    editor.format = content.format || ((typeof lrLooksLikeHtml === 'function' && lrLooksLikeHtml(editor.text)) ? 'html' : 'markdown');
    await lr44SetEditor(key, 'lr44_editor', editor);
    await sendMaxMessage({ chatId: Number(key), text: lr44EditorText(editor), format: 'html', attachments: lr44EditorKeyboard(editor), notify: false });
    return true;
  }

  if (state === 'lr44_wait_media') {
    const content = await extractContentWithHydration(update);
    if (Array.isArray(content.attachments) && content.attachments.length) {
      editor.attachments = content.attachments;
    }
    if (String(content.text || '').trim()) {
      editor.text = content.text;
      editor.format = content.format || editor.format;
    }
    await lr44SetEditor(key, 'lr44_editor', editor);
    await sendMaxMessage({ chatId: Number(key), text: lr44EditorText(editor), format: 'html', attachments: lr44EditorKeyboard(editor), notify: false });
    return true;
  }

  if (state === 'lr44_wait_button') {
    const parsed = lr44ParseButtonLines(text);
    if (!parsed.length) {
      await sendMaxMessage({ chatId: Number(key), text: 'Не понял кнопку. Формат: Название - https://site.ru', notify: false });
      return true;
    }
    editor.buttons = [...(Array.isArray(editor.buttons) ? editor.buttons : []), ...parsed];
    await lr44SetEditor(key, 'lr44_editor', editor);
    await sendMaxMessage({ chatId: Number(key), text: lr44EditorText(editor), format: 'html', attachments: lr44EditorKeyboard(editor), notify: false });
    return true;
  }

  if (state === 'lr44_wait_signature') {
    const content = await extractContentWithHydration(update);
    editor.signatureText = content.text || text;
    editor.signatureFormat = content.format || ((typeof lrLooksLikeHtml === 'function' && lrLooksLikeHtml(editor.signatureText)) ? 'html' : 'markdown');
    editor.signatureMarkup = content.markup || [];
    editor.signatureEnabled = true;
    await lr44SetEditor(key, 'lr44_editor', editor);
    await sendMaxMessage({ chatId: Number(key), text: lr44EditorText(editor), format: 'html', attachments: lr44EditorKeyboard(editor), notify: false });
    return true;
  }

  return false;
}
// ===== LinkRay v44 stable posts END =====

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
    // LR45_HARD_POST_CALLBACK_START
    const lr45CallbackId = getCallbackId(update);
    const lr45Payload = getCallbackPayload(update);
    if (lr45CallbackId && lr45Payload && (String(lr45Payload).startsWith('post:') || String(lr45Payload).startsWith('queue:'))) {
      console.log('[v45 hard callback]', JSON.stringify({ payload: lr45Payload, key }));
      if (await lr44HandleCallbackPayload(lr45Payload, lr45CallbackId, key)) {
        return res.json({ ok: true });
      }
    }
    // LR45_HARD_POST_CALLBACK_END
    // LR44_TEXT_STATE_ROUTER_START
    if (await lr44HandleTextState(update, key)) return res.json({ ok: true });
    // LR44_TEXT_STATE_ROUTER_END
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
