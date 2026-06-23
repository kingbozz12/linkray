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
  editMaxMessage,
  deleteMaxMessage,
} from './maxClient.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = Number(process.env.PORT || 3000);
const BOT_LINK = process.env.BOT_LINK || 'https://max.ru/se13353901_bot';
const MSK_TZ = 'Europe/Moscow';
const MAX_PREVIEW_ATTACHMENTS = 8;

function nowIso() { return new Date().toISOString(); }
function log(scope, data) { console.log(`[${scope}]`, typeof data === 'string' ? data : JSON.stringify(data)); }
function safeJson(value, fallback = {}) { try { if (!value) return fallback; if (typeof value === 'object') return value; return JSON.parse(value); } catch { return fallback; } }
function rows(result) { return Array.isArray(result) ? result : (result?.rows || []); }
function escapeHtml(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attr(v) { return escapeHtml(v).replace(/"/g, '&quot;'); }
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
function short(v, max = 48) { const s = plain(v).replace(/\s+/g, ' ').trim(); return s ? (s.length > max ? `${s.slice(0, max)}...` : s) : 'пост без текста'; }
function norm(v) { return String(v || '').replace(/[\uFE0F]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function includesText(a, b) { return norm(a).includes(norm(b)); }

async function ensureDb() {
  await query(`CREATE TABLE IF NOT EXISTS bot_sessions (user_id text PRIMARY KEY, state text NOT NULL DEFAULT 'idle', data jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now())`);
  await query(`CREATE TABLE IF NOT EXISTS channels (id serial PRIMARY KEY, max_chat_id text UNIQUE, title text, link text, is_public boolean DEFAULT false, is_channel boolean DEFAULT true, owner_max_user_id text, bot_added_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS max_chat_id text`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS title text`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS link text`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_public boolean DEFAULT false`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_channel boolean DEFAULT true`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS owner_max_user_id text`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS bot_added_at timestamptz DEFAULT now()`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`);

  await query(`CREATE TABLE IF NOT EXISTS scheduled_posts (id serial PRIMARY KEY, channel_id integer REFERENCES channels(id) ON DELETE SET NULL, text text NOT NULL DEFAULT '', format text NOT NULL DEFAULT 'html', publish_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'scheduled', notify boolean NOT NULL DEFAULT false, created_by_max_user_id text, error_message text, updated_at timestamptz NOT NULL DEFAULT now())`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS channel_id integer`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS text text`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS format text DEFAULT 'html'`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS publish_at timestamptz`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS status text DEFAULT 'scheduled'`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS notify boolean DEFAULT false`);
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

  await query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scheduled_post_status') THEN ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'publishing'; ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'published'; ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'error'; ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'canceled'; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await query(`UPDATE scheduled_posts SET notify = false WHERE notify IS NULL`);
  await query(`UPDATE scheduled_posts SET text = '' WHERE text IS NULL`);
  await query(`UPDATE scheduled_posts SET format = 'html' WHERE format IS NULL`);
  await query(`UPDATE scheduled_posts SET publish_at = now() WHERE publish_at IS NULL`);
  await query(`ALTER TABLE scheduled_posts ALTER COLUMN notify SET DEFAULT false`);

  await query(`CREATE TABLE IF NOT EXISTS channel_signatures (id serial PRIMARY KEY, channel_id integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE, owner_key text NOT NULL DEFAULT 'global', title text NOT NULL DEFAULT 'Автоподпись', text text NOT NULL DEFAULT '', format text NOT NULL DEFAULT 'html', markup jsonb NOT NULL DEFAULT '[]'::jsonb, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS owner_key text DEFAULT 'global'`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Автоподпись'`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS text text NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'html'`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS markup jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_signatures_channel_owner ON channel_signatures(channel_id, owner_key)`);

  await query(`CREATE TABLE IF NOT EXISTS user_quick_times (owner_key text NOT NULL, time_text text NOT NULL, used_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_key, time_text))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_posts_publish ON scheduled_posts(status, publish_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_posts_channel ON scheduled_posts(channel_id, publish_at)`);
}

function getUpdateType(u) { return u.update_type || u.updateType || u.type || u.event_type || ''; }
function getChatId(u) { return u.chat_id || u.chatId || u.chat?.id || u.chat?.chat_id || u.message?.recipient?.chat_id || u.message?.recipient?.chatId || u.message?.chat_id || u.message?.chatId || u.message?.chat?.id || u.callback?.chat?.id || u.callback?.message?.recipient?.chat_id || null; }
function getUserId(u) { return u.user_id || u.userId || u.user?.id || u.message?.sender?.user_id || u.message?.sender?.userId || u.message?.sender?.id || u.callback?.user?.user_id || u.callback?.user?.id || null; }
function getSessionKey(u) { return String(getChatId(u) || getUserId(u) || 'unknown'); }
function getCallbackId(u) { return u.callback?.callback_id || u.callback?.callbackId || u.callback_id || u.callbackId || null; }
function getCallbackPayload(u) {
  const candidates = [u.callback?.payload, u.callback?.button?.payload, u.callback?.data, u.callback?.value, u.button?.payload, u.message?.body?.payload, u.message?.payload, u.payload, u.data];
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    if (typeof c === 'string') return c;
    if (typeof c === 'object') return c.payload || c.value || c.data || JSON.stringify(c);
  }
  return '';
}
function getMessageText(u) { return String(u.message?.body?.text || u.message?.text || u.body?.text || u.text || '').trim(); }
function getChatTitle(u) { return u.chat?.title || u.chat?.name || u.message?.chat?.title || u.message?.chat?.name || u.chat_title || u.chatTitle || null; }
function getChatLink(u) { return u.chat?.link || u.chat?.invite_link || u.chat?.inviteLink || u.message?.chat?.link || u.chat_link || u.chatLink || null; }

async function getSession(key) { const r = await query('SELECT state, data FROM bot_sessions WHERE user_id=$1', [String(key)]); return r[0] || { state: 'idle', data: {} }; }
async function setSession(key, state, data = {}) { await query(`INSERT INTO bot_sessions(user_id,state,data,updated_at) VALUES($1,$2,$3::jsonb,now()) ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,data=EXCLUDED.data,updated_at=now()`, [String(key), state, JSON.stringify(data)]); }
async function clearSession(key) { await setSession(key, 'idle', {}); }

function buttonRows(rows) { return inlineKeyboard(rows); }
async function cb(callbackId, text, rows = [], format = 'html') { return answerCallback({ callbackId, text, format, attachments: buttonRows(rows) }); }
async function msg(chatId, text, rows = [], format = 'html') { return sendMaxMessage({ chatId, text, format, attachments: rows.length ? buttonRows(rows) : [] }); }
async function cbOrMsg(callbackId, chatId, text, rows = [], format = 'html') {
  try {
    return await cb(callbackId, text, rows, format);
  } catch (error) {
    console.error('[callback fallback to message]', error.message || error);
    if (chatId) return msg(chatId, text, rows, format);
    throw error;
  }
}

function mskDate(date = new Date()) { return new Date(date.toLocaleString('en-US', { timeZone: MSK_TZ })); }
function dateKey(date = new Date()) { const d = mskDate(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function keyToDate(key) { const [y,m,d] = String(key || dateKey()).split('-').map(Number); return new Date(y, (m||1)-1, d||1); }
function shiftDay(key, n) { const d = keyToDate(key); d.setDate(d.getDate()+Number(n||0)); return dateKey(d); }
function monthName(d) { return ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][d.getMonth()] || ''; }
function dayName(d) { return ['вс','пн','вт','ср','чт','пт','сб'][d.getDay()] || ''; }
function timeText(d) { return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function dateText(d) { return `${dayName(d)} ${d.getDate()} ${monthName(d)} ${d.getFullYear()} г.`; }
function dateTimeText(d) { return `${timeText(d)} · ${dateText(d)}`; }
function parseDbDate(v) { const d = new Date(v || Date.now()); return Number.isNaN(d.getTime()) ? new Date() : d; }

function channelName(ch) { return ch?.title || ch?.name || `Канал #${ch?.id || '?'}`; }
function channelLine(ch) { const title = escapeHtml(channelName(ch)); const link = ch?.link || ch?.url || ch?.invite_link || ''; return link ? `• <a href="${attr(link)}">${title}</a>` : `• ${title}`; }
function channelsLines(channels) { return (channels || []).map(channelLine).join('\n') || '• канал не выбран'; }


async function maybeRegisterChannel(update) {
  const chatId = getChatId(update);
  const title = getChatTitle(update);
  if (!chatId || !title) return;
  const link = getChatLink(update);
  await query(`
    INSERT INTO channels(max_chat_id, title, link, is_public, is_channel, bot_added_at, updated_at)
    VALUES($1,$2,$3,$4,true,now(),now())
    ON CONFLICT(max_chat_id) DO UPDATE SET title=COALESCE(EXCLUDED.title, channels.title), link=COALESCE(EXCLUDED.link, channels.link), is_public=EXCLUDED.is_public, updated_at=now()
  `, [String(chatId), title, link || null, Boolean(link)]).catch((e) => console.error('[register channel]', e.message || e));
}

async function getChannels() { return query('SELECT id,max_chat_id,title,link,is_public FROM channels ORDER BY title ASC NULLS LAST, id ASC'); }
async function getChannel(id) { const r = await query('SELECT id,max_chat_id,title,link,is_public FROM channels WHERE id=$1', [Number(id)]); return r[0] || null; }
async function getChannelsByIds(ids) { const list = (ids || []).map(Number).filter(Boolean); if (!list.length) return []; return query('SELECT id,max_chat_id,title,link,is_public FROM channels WHERE id=ANY($1::int[]) ORDER BY title ASC NULLS LAST, id ASC', [list]); }
async function refreshChannelMeta(channel) {
  if (!channel?.max_chat_id) return channel;
  try {
    const info = await getMaxChatInfo(channel.max_chat_id);
    const title = info?.chat?.title || info?.title || info?.name || channel.title;
    const link = info?.chat?.link || info?.link || info?.invite_link || channel.link || null;
    const isPublic = Boolean(link);
    await query('UPDATE channels SET title=$2, link=$3, is_public=$4, updated_at=now() WHERE id=$1', [channel.id, title, link, isPublic]);
    return { ...channel, title, link, is_public: isPublic };
  } catch (e) {
    console.error('[channel meta]', e.message || e);
    return channel;
  }
}

function emptyDraft() { return { channelIds: [], content: { text: '', format: 'html', attachments: [], markup: [], raw: null }, buttons: [], isAd: false, cpm: null, autoDeleteMinutes: null, reportAfterHours: 24, signatureEnabled: true, scheduleDate: null }; }
function safeDraft(data) { const d = data?.draft || data || {}; const base = emptyDraft(); return { ...base, ...d, content: { ...base.content, ...(d.content || {}), attachments: Array.isArray(d.content?.attachments) ? d.content.attachments : [] }, buttons: Array.isArray(d.buttons) ? d.buttons : [], channelIds: Array.isArray(d.channelIds) ? d.channelIds.map(Number).filter(Boolean) : [] }; }
function hasContent(d) { return Boolean(String(d?.content?.text || '').trim() || (Array.isArray(d?.content?.attachments) && d.content.attachments.length)); }

function applyMarkupToHtml(text, markup = []) {
  const source = String(text || '');
  const marks = Array.isArray(markup) ? markup : [];
  const opens = new Map(); const closes = new Map();
  const add = (map, pos, tag, len) => { if (!map.has(pos)) map.set(pos, []); map.get(pos).push({ tag, len }); };
  for (const m of marks) {
    const from = Number(m.from); const len = Number(m.length);
    if (!Number.isFinite(from) || !Number.isFinite(len) || len <= 0 || from < 0 || from >= source.length) continue;
    const end = Math.min(source.length, from + len); const type = String(m.type || '').toLowerCase();
    let open = '', close = '';
    if ((type === 'link' || type === 'url') && m.url) { open = `<a href="${attr(m.url)}">`; close = '</a>'; }
    else if (['strong','bold'].includes(type)) { open = '<b>'; close = '</b>'; }
    else if (['emphasized','italic','em'].includes(type)) { open = '<i>'; close = '</i>'; }
    else if (['underline','underlined'].includes(type)) { open = '<u>'; close = '</u>'; }
    else if (['strikethrough','strike'].includes(type)) { open = '<s>'; close = '</s>'; }
    else if (['code','monospace'].includes(type)) { open = '<code>'; close = '</code>'; }
    if (open) { add(opens, from, open, len); add(closes, end, close, len); }
  }
  let out = '';
  for (let i = 0; i <= source.length; i++) {
    if (closes.has(i)) for (const x of closes.get(i).sort((a,b)=>a.len-b.len)) out += x.tag;
    if (opens.has(i)) for (const x of opens.get(i).sort((a,b)=>b.len-a.len)) out += x.tag;
    if (i < source.length) out += escapeHtml(source[i]);
  }
  return out;
}
function firstText(u) { return String(u.message?.body?.text || u.message?.text || u.message?.link?.message?.body?.text || u.message?.forwarded_message?.body?.text || u.message?.forwardedMessage?.body?.text || u.body?.text || u.text || '').trim(); }
function firstMarkup(u) { const c = [u.message?.body?.markup, u.message?.markup, u.message?.link?.message?.body?.markup, u.message?.forwarded_message?.body?.markup, u.message?.forwardedMessage?.body?.markup, u.body?.markup, u.markup]; return c.find(x => Array.isArray(x) && x.length) || []; }
function looksLikeAttachment(v) { if (!v || typeof v !== 'object') return false; const t = String(v.type || v.attachment_type || v.attachmentType || '').toLowerCase(); return ['image','photo','video','file','audio','sticker'].some(x => t.includes(x)); }
function collectAttachments(v, found = [], seen = new Set()) {
  if (!v || typeof v !== 'object' || found.length >= MAX_PREVIEW_ATTACHMENTS || seen.has(v)) return found;
  seen.add(v);
  if (Array.isArray(v)) { for (const x of v) collectAttachments(x, found, seen); return found; }
  if (looksLikeAttachment(v)) found.push(v);
  for (const k of ['attachments','media','photos','images','videos','files','items']) if (Array.isArray(v[k])) collectAttachments(v[k], found, seen);
  for (const child of [v.body,v.message,v.forwarded,v.forwarded_message,v.forwardedMessage,v.link,v.content,v.payload,v.post]) collectAttachments(child, found, seen);
  return found.slice(0, MAX_PREVIEW_ATTACHMENTS);
}
function normalizeAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const type = String(a.type || a.attachment_type || a.attachmentType || '').toLowerCase();
  const p = a.payload && typeof a.payload === 'object' ? a.payload : {};
  if (type === 'inline_keyboard') return a;
  if (type.includes('image') || type.includes('photo')) { if (p.token) return { type: 'image', payload: { token: p.token } }; if (a.token) return { type: 'image', payload: { token: a.token } }; if (Array.isArray(p.photos)) return { type: 'image', payload: { photos: p.photos } }; }
  if (type.includes('video')) { if (p.token) return { type: 'video', payload: { token: p.token } }; if (a.token) return { type: 'video', payload: { token: a.token } }; }
  if (type.includes('file')) { if (p.token) return { type: 'file', payload: { token: p.token } }; if (a.token) return { type: 'file', payload: { token: a.token } }; }
  return null;
}
function normalizeAttachments(list = []) { const out = []; const seen = new Set(); for (const a of list || []) { const n = normalizeAttachment(a); if (!n) continue; const k = JSON.stringify(n); if (seen.has(k)) continue; seen.add(k); out.push(n); } return out; }
async function hydrateContent(u) {
  let text = firstText(u); const markup = firstMarkup(u);
  const attachments = normalizeAttachments(collectAttachments(u.message || u));
  if (markup.length && text) text = applyMarkupToHtml(text, markup);
  return { text, format: 'html', markup, attachments, raw: u.message || u };
}

function parseButtonsInput(input) {
  const rows = [];
  for (const line of String(input || '').split(/\n+/).map(x=>x.trim()).filter(Boolean)) {
    const row = [];
    for (const part of line.split('|').map(x=>x.trim()).filter(Boolean)) {
      const m = part.match(/^(.+?)\s*(?:-|—|–)\s*(https?:\/\/\S+)$/i);
      if (m) row.push({ text: m[1].trim(), url: m[2].trim() });
    }
    if (row.length) rows.push(row);
  }
  return rows;
}
function keyboardAttachmentFromButtons(buttons = []) {
  const rows = [];
  for (const r of buttons || []) {
    const row = [];
    for (const b of (Array.isArray(r) ? r : [r])) if (b?.text && /^https?:\/\//i.test(b?.url || '')) row.push(linkButton(b.text, b.url));
    if (row.length) rows.push(row);
  }
  return rows.length ? inlineKeyboard(rows)[0] : null;
}
function finalAttachments(draft) { const out = normalizeAttachments(draft?.content?.attachments || []); const kb = keyboardAttachmentFromButtons(draft?.buttons || []); if (kb) out.push(kb); return out; }
async function loadSignature(channelId, ownerKey = 'shared') { const r = await query('SELECT * FROM channel_signatures WHERE channel_id=$1 AND owner_key=$2 AND is_active=true ORDER BY updated_at DESC LIMIT 1', [Number(channelId), String(ownerKey)]); return r[0] || null; }
async function saveSignature(channelId, content, ownerKey = 'shared') {
  await query(`INSERT INTO channel_signatures(channel_id, owner_key, title, text, format, markup, is_active, updated_at) VALUES($1,$2,'Автоподпись',$3,$4,$5::jsonb,true,now()) ON CONFLICT(channel_id, owner_key) DO UPDATE SET text=EXCLUDED.text, format=EXCLUDED.format, markup=EXCLUDED.markup, is_active=true, updated_at=now()`, [Number(channelId), ownerKey, content.text || '', content.format || 'html', JSON.stringify(content.markup || [])]);
}
async function setSignatureActive(channelId, active, ownerKey = 'shared') { await query('UPDATE channel_signatures SET is_active=$3, updated_at=now() WHERE channel_id=$1 AND owner_key=$2', [Number(channelId), ownerKey, Boolean(active)]); }
async function composePostForChannel(draft, channelId) {
  let text = String(draft.content?.text || '');
  if (!draft.isAd && draft.signatureEnabled !== false) {
    const sig = await loadSignature(channelId);
    if (sig?.text) text = `${text}\n\n${sig.text}`;
  }
  return { text, format: 'html', attachments: finalAttachments(draft) };
}
function makeDraftFromPost(row) { return { ...emptyDraft(), channelIds: [Number(row.channel_id)], content: { text: row.text || '', format: row.format || 'html', attachments: safeJson(row.attachments, []), markup: [], raw: null }, buttons: safeJson(row.buttons, []), isAd: Boolean(row.is_ad), cpm: row.cpm ? Number(row.cpm) : null, autoDeleteMinutes: row.auto_delete_minutes || null, reportAfterHours: row.report_after_hours || 24, signatureEnabled: !row.is_ad, postId: Number(row.id), publishedMessageId: row.published_message_id || null, status: row.status || 'scheduled' }; }

function mainMenuRows() { return [[callbackButton('🧬 LinkRay Studio', 'main:posting')],[callbackButton('📡 Каналы', 'channels:list')],[callbackButton('📊 Отчёты', 'reports:menu'), callbackButton('🛡 Антифрод', 'fraud:menu')]]; }
async function showMainCallback(callbackId) { await cb(callbackId, `━━━━━━━━━━━━━━\n🛡 <b>LinkRay</b>\n\nСтудия публикаций, очередь постов и рекламные отчёты для MAX.\n\nВыберите действие.\n━━━━━━━━━━━━━━`, mainMenuRows()); }
async function sendMain(chatId) { await msg(chatId, `━━━━━━━━━━━━━━\n🛡 <b>LinkRay</b>\n\nСтудия публикаций, очередь постов и рекламные отчёты для MAX.\n\nВыберите действие.\n━━━━━━━━━━━━━━`, mainMenuRows()); }
function studioRows() { return [[callbackButton('🧩 Собрать пост', 'post:create')],[callbackButton('🗂 Посты', 'post:all')],[callbackButton('🏷 Автоподписи', 'sig:menu')],[callbackButton('📡 Каналы', 'channels:list')],[callbackButton('⬅️ В меню', 'main:menu')]]; }
async function showStudio(callbackId) { await cb(callbackId, `━━━━━━━━━━━━━━\n🧬 <b>LinkRay Studio</b>\n\nСобирайте посты, планируйте публикации и управляйте рекламными размещениями.\n━━━━━━━━━━━━━━`, studioRows()); }
async function sendStudio(chatId) { await msg(chatId, `━━━━━━━━━━━━━━\n🧬 <b>LinkRay Studio</b>\n\nВыберите действие.\n━━━━━━━━━━━━━━`, studioRows()); }

async function showChannelSelect(callbackId, key, draft, multi = false) {
  const channels = await getChannels();
  if (!channels.length) {
    await cb(callbackId, `━━━━━━━━━━━━━━\n🔗 <b>Подключить канал</b>\n\n1. Откройте канал в MAX.\n2. Добавьте LinkRay в администраторы.\n3. Выдайте право публикации.\n4. Вернитесь и откройте «Каналы».\n━━━━━━━━━━━━━━`, [[callbackButton('📡 Мои каналы', 'channels:list')],[callbackButton('⬅️ В Studio', 'main:posting')]]);
    return;
  }
  const rows = [];
  for (const ch of channels) {
    const selected = draft.channelIds.includes(Number(ch.id));
    rows.push([callbackButton(`${selected ? '✅' : '📡'} ${channelName(ch)}`, multi ? `post:toggle:${ch.id}` : `post:single:${ch.id}`)]);
  }
  rows.push([callbackButton('🧩 Выбрать несколько', 'post:multi'), callbackButton('🌐 Все каналы', 'post:all_channels')]);
  if (multi) rows.push([callbackButton('➡️ Далее', 'post:channels_next')]);
  rows.push([callbackButton('🔗 Добавить канал', 'post:add_channel')],[callbackButton('⬅️ Назад', 'main:posting'), callbackButton('❌ Отмена', 'post:cancel')]);
  await setSession(key, multi ? 'select_channels_multi' : 'select_channels', { draft });
  await cb(callbackId, `━━━━━━━━━━━━━━\n📡 <b>Куда выпустить пост?</b>\n\n${hasContent(draft) ? 'Материал уже принят. Выберите канал.' : 'Выберите канал, затем отправьте пост.'}\n━━━━━━━━━━━━━━`, rows);
}
async function askContent(callbackId, key, draft) { await setSession(key, 'wait_post_content', { draft }); const channels = await getChannelsByIds(draft.channelIds); await cb(callbackId, `━━━━━━━━━━━━━━\n📨 <b>Отправьте пост</b>\n\nКаналы:\n${channelsLines(channels)}\n\nМожно отправить текст, фото, видео, файл или пересланный пост.\n━━━━━━━━━━━━━━`, [[callbackButton('⬅️ К каналам', 'post:change_channels')],[callbackButton('❌ Отмена', 'post:cancel')]]); }
async function showEditor(callbackId, key, draft) {
  await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });
  const text = `━━━━━━━━━━━━━━\n🧬 <b>Редактор LinkRay</b>\n\nТекст: ${String(draft.content.text || '').trim() ? 'есть' : 'нет'}\nМедиа: ${(draft.content.attachments || []).length ? 'есть' : 'нет'}\nКнопки: ${(draft.buttons || []).length ? 'есть' : 'нет'}\n${draft.isAd ? '💼 Реклама: да' : 'Реклама: нет'}${draft.cpm ? ` · CPM ${draft.cpm} ₽` : ''}\nАвтоподпись: ${draft.isAd ? 'выключена для рекламы' : (draft.signatureEnabled === false ? 'выключена' : 'включена')}\n\nНастройте оформление.\n━━━━━━━━━━━━━━`;
  const rows = [[callbackButton('✏️ Изменить текст', 'editor:text'), callbackButton('🖼 Медиа', 'editor:media')],[callbackButton('🔘 Добавить кнопку', 'editor:button'), callbackButton('🏷 Автоподпись', 'editor:signature')],[callbackButton(draft.isAd ? '✅ Рекламный пост' : '💼 Рекламный пост', 'editor:ad')]];
  if (draft.isAd) rows.push([callbackButton(draft.cpm ? `💰 CPM ${draft.cpm} ₽` : '💰 CPM не указан', 'editor:cpm')]);
  rows.push([callbackButton(draft.postId ? '💾 Сохранить пост' : '➡️ Далее', draft.postId ? 'editor:save' : 'editor:next')],[callbackButton('⬅️ Назад', 'post:change_channels'), callbackButton('❌ Отмена', 'post:cancel')]);
  await cb(callbackId, text, rows);
}
async function sendDraftPreview(chatId, draft) { try { const content = await composePostForChannel(draft, draft.channelIds[0]); await sendMaxMessage({ chatId, ...content }); } catch (e) { console.error('[preview]', e.message || e); await msg(chatId, `⚠️ Не удалось вывести превью: ${escapeHtml(e.message || e)}\n\n${escapeHtml(short(draft.content.text, 900))}`, [], 'html'); } }

function parseDuration(input) { const raw = String(input || '').trim().toLowerCase(); if (!raw || raw === 'нет' || raw === '0') return null; const h = raw.match(/^(\d+(?:[.,]\d+)?)\s*(ч|час|часа|часов|h)$/); if (h) return Math.round(Number(h[1].replace(',','.'))*60); const d = raw.match(/^(\d+(?:[.,]\d+)?)\s*(д|дн|день|дня|дней|d)$/); if (d) return Math.round(Number(d[1].replace(',','.'))*1440); const hm = raw.match(/^(\d{1,3})\s*:\s*(\d{1,2})$/); if (hm) return Number(hm[1])*60+Number(hm[2]); const n = raw.match(/^(\d+)$/); if (n) return Number(n[1]); return undefined; }
function parseSchedule(input) {
  const raw = String(input || '').trim().toLowerCase(); const now = mskDate(new Date());
  let m = raw.match(/^через\s+(\d+)\s*(мин|минут|минуту|минуты)$/); if (m) { const d = new Date(); d.setMinutes(d.getMinutes()+Number(m[1])); return d; }
  m = raw.match(/^через\s+(\d+)\s*(ч|час|часа|часов)$/); if (m) { const d = new Date(); d.setHours(d.getHours()+Number(m[1])); return d; }
  m = raw.match(/^завтра\s+(\d{1,2})[:\s](\d{2})$/); if (m) { const d = new Date(now); d.setDate(d.getDate()+1); d.setHours(Number(m[1]), Number(m[2]), 0, 0); return d; }
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/); if (m) return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  m = raw.match(/^(\d{1,2})[:\s](\d{2})$/); if (m) { const d = new Date(now); d.setHours(Number(m[1]), Number(m[2]), 0, 0); if (d.getTime() <= now.getTime()) d.setDate(d.getDate()+1); return d; }
  m = raw.match(/^(\d{2})(\d{2})$/); if (m) { const d = new Date(now); d.setHours(Number(m[1]), Number(m[2]), 0, 0); if (d.getTime() <= now.getTime()) d.setDate(d.getDate()+1); return d; }
  return null;
}
async function showPublishMenu(callbackId, key, draft) { await setSession(key, 'publish_menu', { draft }); const channels = await getChannelsByIds(draft.channelIds); await cb(callbackId, `━━━━━━━━━━━━━━\n🚀 <b>К выпуску</b>\n\n📡 Каналы:\n${channelsLines(channels)}\n\n🗑 Автоудаление: ${draft.autoDeleteMinutes ? `${Math.round(draft.autoDeleteMinutes/60)}ч` : 'нет'}\n${draft.isAd ? `💼 Реклама: да · CPM ${draft.cpm || 'не указан'} ₽\n📊 Отчёт: через 24ч` : 'Реклама: нет'}\n\nВыберите способ публикации.\n━━━━━━━━━━━━━━`, [[callbackButton('🗑 Автоудаление', 'publish:auto_delete')],[callbackButton('📅 Календарь', 'schedule:calendar'), callbackButton('✍️ Ввести время', 'schedule:manual')],[callbackButton('⚡ Опубликовать сейчас', 'publish:now')],[callbackButton('⬅️ В Studio', 'editor:back'), callbackButton('❌ Отмена', 'post:cancel')]]); }
async function scheduleDraft(draft, key, publishAt) {
  const ids = [];
  for (const channelId of draft.channelIds) {
    const content = await composePostForChannel(draft, channelId);
    const r = await query(`INSERT INTO scheduled_posts(channel_id,text,format,publish_at,status,notify,created_by_max_user_id,attachments,buttons,draft,is_ad,cpm,auto_delete_minutes,report_after_hours,updated_at) VALUES($1,$2,$3,$4,'scheduled',false,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,now()) RETURNING id`, [channelId, content.text, content.format, publishAt, String(key), JSON.stringify(normalizeAttachments(draft.content.attachments)), JSON.stringify(draft.buttons || []), JSON.stringify(draft), Boolean(draft.isAd), draft.cpm, draft.autoDeleteMinutes, draft.reportAfterHours || 24]);
    ids.push(r[0].id);
  }
  return ids;
}
function extractMessageId(res) { return res?.message?.body?.mid || res?.message?.id || res?.message_id || res?.messageId || res?.id || res?.mid || null; }
async function publishDraftNow(draft, key) {
  const results = [];
  for (const channel of await getChannelsByIds(draft.channelIds)) {
    try {
      const content = await composePostForChannel(draft, channel.id);
      const sent = await sendMaxMessage({ chatId: channel.max_chat_id, ...content });
      const messageId = extractMessageId(sent);
      const r = await query(`INSERT INTO scheduled_posts(channel_id,text,format,publish_at,status,notify,created_by_max_user_id,attachments,buttons,draft,is_ad,cpm,auto_delete_minutes,report_after_hours,published_at,published_message_id,updated_at) VALUES($1,$2,$3,now(),'published',false,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,now(),$12,now()) RETURNING id`, [channel.id, content.text, content.format, String(key), JSON.stringify(normalizeAttachments(draft.content.attachments)), JSON.stringify(draft.buttons || []), JSON.stringify(draft), Boolean(draft.isAd), draft.cpm, draft.autoDeleteMinutes, draft.reportAfterHours || 24, messageId]);
      results.push({ ok: true, channel, id: r[0].id });
    } catch (e) { console.error('[publish now]', e.message || e); results.push({ ok: false, channel, error: e.message || String(e) }); }
  }
  return results;
}
async function afterPlanned(chatId, draft, publishAt, ids) { const channels = await getChannelsByIds(draft.channelIds); const d = parseDbDate(publishAt); if (draft.isAd) await msg(chatId, `━━━━━━━━━━━━━━\n✅ <b>Рекламный пост запланирован</b>\n\n📝 Сообщение «${escapeHtml(short(draft.content.text, 80))}»\n📅 ${dateText(d)}\n🕒 ${timeText(d)} МСК\n\n📣 Каналы:\n${channelsLines(channels)}\n\n💼 CPM: ${draft.cpm || 'не указан'} ₽\n🗑 Автоудаление: ${draft.autoDeleteMinutes ? `${Math.round(draft.autoDeleteMinutes/60)}ч` : 'нет'}\n📊 Отчёт: через 24ч\n\nПост добавлен в очередь <a href="${BOT_LINK}">LinkRay</a>.\n━━━━━━━━━━━━━━`, [[callbackButton('🧩 Собрать ещё пост', 'post:create')],[callbackButton('🗂 Посты', 'post:all')],[callbackButton('🏠 В меню', 'main:menu')]]); else await msg(chatId, `━━━━━━━━━━━━━━\n✅ <b>Публикация запланирована</b>\n\n📅 ${dateText(d)}\n🕒 ${timeText(d)} МСК\n\n📣 Каналы:\n${channelsLines(channels)}\n\nПост добавлен в очередь.\n━━━━━━━━━━━━━━`, [[callbackButton('🧩 Собрать ещё пост', 'post:create')],[callbackButton('🗂 Посты', 'post:all')],[callbackButton('🏠 В меню', 'main:menu')]]); await sendMain(chatId); }
async function afterPublished(chatId, draft, results) { const ok = results.filter(x=>x.ok); const channels = ok.map(x=>x.channel); if (draft.isAd) await msg(chatId, `━━━━━━━━━━━━━━\n✅ <b>Рекламный пост опубликован</b>\n\n📣 Каналы:\n${channelsLines(channels)}\n\nОпубликовано: ${ok.length} из ${results.length}\n💼 CPM: ${draft.cpm || 'не указан'} ₽\n📊 Отчёт будет готов через 24ч.\n\nРазмещение выполнено через <a href="${BOT_LINK}">LinkRay</a>.\n━━━━━━━━━━━━━━`, [[callbackButton('🗂 Посты', 'post:all')],[callbackButton('🏠 В меню', 'main:menu')]]); else await msg(chatId, `━━━━━━━━━━━━━━\n✅ <b>Пост опубликован</b>\n\n📣 Каналы:\n${channelsLines(channels)}\n\nОпубликовано: ${ok.length} из ${results.length}\n━━━━━━━━━━━━━━`, [[callbackButton('🧩 Собрать ещё пост', 'post:create')],[callbackButton('🗂 Посты', 'post:all')],[callbackButton('🏠 В меню', 'main:menu')]]); await sendMain(chatId); }

async function postsForDay(mode = 'all', day = null, channelId = null) {
  const safeDay = day || dateKey(); const where = [`sp.status IN ('scheduled','published')`, `(sp.publish_at AT TIME ZONE '${MSK_TZ}')::date = $1::date`]; const params = [safeDay];
  if (mode === 'scheduled') where.push(`sp.status='scheduled'`); if (mode === 'published') where.push(`sp.status='published'`);
  if (channelId) { params.push(Number(channelId)); where.push(`sp.channel_id=$${params.length}`); }
  return query(`SELECT sp.*, c.title AS channel_title, c.link AS channel_link, c.max_chat_id FROM scheduled_posts sp LEFT JOIN channels c ON c.id=sp.channel_id WHERE ${where.join(' AND ')} ORDER BY sp.publish_at ASC, sp.id ASC`, params);
}
async function countsForDay(day, channelId = null) { const where = [`sp.status IN ('scheduled','published')`, `(sp.publish_at AT TIME ZONE '${MSK_TZ}')::date = $1::date`]; const params = [day]; if (channelId) { params.push(Number(channelId)); where.push(`sp.channel_id=$${params.length}`); } const r = await query(`SELECT COUNT(*)::int all_count, COUNT(*) FILTER(WHERE status='scheduled')::int scheduled_count, COUNT(*) FILTER(WHERE status='published')::int published_count FROM scheduled_posts sp WHERE ${where.join(' AND ')}`, params); return { all: Number(r[0]?.all_count || 0), scheduled: Number(r[0]?.scheduled_count || 0), published: Number(r[0]?.published_count || 0) }; }
async function defaultPostDay(mode = 'all') { const where = [`status IN ('scheduled','published')`]; if (mode === 'scheduled') where.push(`status='scheduled'`); if (mode === 'published') where.push(`status='published'`); const r = await query(`SELECT (publish_at AT TIME ZONE '${MSK_TZ}')::date::text day FROM scheduled_posts WHERE ${where.join(' AND ')} ORDER BY publish_at DESC LIMIT 1`); return r[0]?.day || dateKey(); }
function filterPayload(mode, day, channelId = 0) { return `post:filter:${mode}:${day}:${channelId || 0}`; }
function postButtonText(p) { const icon = p.status === 'published' ? '📌' : '⏳'; const ad = p.is_ad ? '💼 ' : ''; const media = safeJson(p.attachments, []).length ? '🖼 ' : ''; return `${ad}${icon} ${timeText(parseDbDate(p.publish_at))} · ${media}${short(p.text, 34)}`; }
async function buildPostsView(mode = 'all', day = null, channelId = null) {
  const safeMode = ['all','scheduled','published'].includes(mode) ? mode : 'all';
  const safeDay = day || await defaultPostDay(safeMode);
  const posts = await postsForDay(safeMode, safeDay, channelId);
  const counts = await countsForDay(safeDay, channelId);
  const rows = posts.map(p => [callbackButton(postButtonText(p), `post:open:${p.id}`)]);
  if (!rows.length) rows.push([callbackButton('Постов в этот день нет', 'noop')]);
  rows.push([callbackButton(safeMode==='scheduled'?'🔴 Отложенные':'⏳ Отложенные', filterPayload('scheduled', safeDay, channelId)), callbackButton(safeMode==='published'?'🔴 Опубликованные':'Опубликованные', filterPayload('published', safeDay, channelId))]);
  rows.push([callbackButton(safeMode==='all'?'🔴 Все посты':'📋 Все посты', filterPayload('all', safeDay, channelId))]);
  rows.push([callbackButton('⬅️ День', filterPayload(safeMode, shiftDay(safeDay,-1), channelId)), callbackButton(`📅 ${dateText(keyToDate(safeDay)).replace(' г.','')}`, 'noop'), callbackButton('День ➡️', filterPayload(safeMode, shiftDay(safeDay,1), channelId))]);
  rows.push([callbackButton('📡 По каналам', 'post:channels')],[callbackButton('⬅️ В Studio', 'main:posting')]);

  const title = channelId ? escapeHtml(channelName(await getChannel(channelId))) : 'Все каналы';
  const text = `━━━━━━━━━━━━━━
🗂 <b>Посты</b>

📣 <b>${title}</b>
📅 ${dateText(keyToDate(safeDay))}

Фильтр: <b>${safeMode === 'scheduled' ? 'отложенные' : safeMode === 'published' ? 'опубликованные' : 'все посты'}</b>

📋 Всего за день: ${counts.all}
⏳ Отложено: ${counts.scheduled}
📌 Опубликовано: ${counts.published}
👁 Показано: ${posts.length}${posts.length ? '' : '\n\nПостов в этот день нет. Листайте дни стрелками ниже.'}

Нажмите на пост, чтобы открыть управление.
━━━━━━━━━━━━━━`;

  return { text, rows, safeMode, safeDay, posts, counts };
}
async function showPosts(callbackId, mode = 'all', day = null, channelId = null, chatId = null) {
  const view = await buildPostsView(mode, day, channelId);
  return cbOrMsg(callbackId, chatId, view.text, view.rows);
}
async function sendPosts(chatId, mode = 'all', day = null, channelId = null) {
  const view = await buildPostsView(mode, day, channelId);
  return msg(chatId, view.text, view.rows);
}
async function showPostChannels(callbackId, chatId = null) { const channels = await getChannels(); const day = await defaultPostDay('all'); const rows = [[callbackButton('🌐 Все каналы', filterPayload('all', day, 0))]]; for (const c of channels) rows.push([callbackButton(`📡 ${channelName(c)}`, filterPayload('all', day, c.id))]); rows.push([callbackButton('⬅️ К постам', filterPayload('all', day, 0))]); await cbOrMsg(callbackId, chatId, `━━━━━━━━━━━━━━\n📡 <b>Посты по каналам</b>\n\nВыберите канал.\n━━━━━━━━━━━━━━`, rows); }
async function getPost(id) { const r = await query(`SELECT sp.*, c.title AS channel_title, c.link AS channel_link, c.max_chat_id FROM scheduled_posts sp LEFT JOIN channels c ON c.id=sp.channel_id WHERE sp.id=$1`, [Number(id)]); return r[0] || null; }
function postChannelObj(p) { return { id: p.channel_id, title: p.channel_title, link: p.channel_link, max_chat_id: p.max_chat_id }; }
function postPreviewDraft(p) { return { ...emptyDraft(), channelIds: [p.channel_id], content: { text: p.text || '', format: p.format || 'html', attachments: safeJson(p.attachments, []), markup: [] }, buttons: safeJson(p.buttons, []), isAd: Boolean(p.is_ad), cpm: p.cpm ? Number(p.cpm) : null, autoDeleteMinutes: p.auto_delete_minutes, reportAfterHours: p.report_after_hours || 24, signatureEnabled: false }; }
function olderThan24(p) { return p.status === 'published' && Date.now() - parseDbDate(p.published_at || p.publish_at).getTime() > 24*60*60*1000; }
function postMenuText(p) { const d = parseDbDate(p.published_at || p.publish_at); const ch = postChannelObj(p); if (olderThan24(p)) return `━━━━━━━━━━━━━━\n🔒 <b>Пост #${p.id}</b>\n\n↑ Пост находится над этим сообщением ↑\n\n🕒 <b>Опубликован:</b> ${dateTimeText(d)}\n📌 <b>Статус:</b> опубликован\n🗑 <b>Автоудаление:</b> ${p.auto_delete_minutes ? Math.round(p.auto_delete_minutes/60)+'ч' : 'нет'}\n\n<b>Канал:</b>\n${channelLine(ch)}\n\nРедактирование недоступно: прошло больше 24 часов.\n━━━━━━━━━━━━━━`; if (p.status === 'published') return `━━━━━━━━━━━━━━\n${p.is_ad ? '💼 <b>Рекламный пост</b>' : '📄 <b>Пост</b>'} #${p.id}\n\n↑ Пост находится над этим сообщением ↑\n\n🕒 <b>Опубликован:</b> ${dateTimeText(d)}\n📌 <b>Статус:</b> опубликован\n🗑 <b>Автоудаление:</b> ${p.auto_delete_minutes ? Math.round(p.auto_delete_minutes/60)+'ч' : 'нет'}\n${p.is_ad ? `💰 <b>CPM:</b> ${p.cpm || 'не указан'} ₽\n` : ''}\n<b>Канал:</b>\n${channelLine(ch)}\n━━━━━━━━━━━━━━`; return `━━━━━━━━━━━━━━\n${p.is_ad ? '💼 <b>Рекламный пост</b>' : '📄 <b>Пост</b>'} #${p.id}\n\n↑ Пост находится над этим сообщением ↑\n\n🕒 <b>Время:</b> ${dateTimeText(d)}\n⏳ <b>Статус:</b> ожидает публикации\n🗑 <b>Автоудаление:</b> ${p.auto_delete_minutes ? Math.round(p.auto_delete_minutes/60)+'ч' : 'нет'}\n\nПост будет опубликован в канал:\n${channelLine(ch)}\n━━━━━━━━━━━━━━`; }
function postMenuRows(p) { const back = filterPayload(p.status === 'published' ? 'published' : 'scheduled', dateKey(parseDbDate(p.publish_at)), p.channel_id); if (olderThan24(p)) return [[callbackButton('⬅️ Назад', back)]]; if (p.status === 'published') return [[callbackButton('✏️ Перейти в редактор', `post:editor:${p.id}`)],[callbackButton(`🗑 Удаление: ${p.auto_delete_minutes ? Math.round(p.auto_delete_minutes/60)+'ч' : 'нет'}`, `post:auto:${p.id}`)],[callbackButton('❌ Удалить из канала', `post:delete_confirm:${p.id}`)],[callbackButton('⬅️ Назад', back)]]; return [[callbackButton('✏️ Перейти в редактор', `post:editor:${p.id}`)],[callbackButton('↪️ Изменить время', `post:time:${p.id}`)],[callbackButton(`🗑 Удаление: ${p.auto_delete_minutes ? Math.round(p.auto_delete_minutes/60)+'ч' : 'нет'}`, `post:auto:${p.id}`)],[callbackButton('🚀 Опубликовать сейчас', `post:now:${p.id}`)],[callbackButton('❌ Удалить', `post:delete_confirm:${p.id}`)],[callbackButton('⬅️ Назад', back)]]; }
async function openPost(callbackId, chatId, id) { const p = await getPost(id); if (!p) { await cb(callbackId, 'Пост не найден.', [[callbackButton('⬅️ К постам','post:all')]]); return; } await answerCallback({ callbackId, notification: 'Открываю пост...' }).catch(()=>{}); try { const d = postPreviewDraft(p); await sendMaxMessage({ chatId, text: p.text || '', format: p.format || 'html', attachments: finalAttachments(d) }); await msg(chatId, postMenuText(p), postMenuRows(p)); } catch (e) { console.error('[open post]', e.message || e); await cb(callbackId, `${postMenuText(p)}\n\n⚠️ Пост не удалось вывести отдельно: ${escapeHtml(e.message || e)}`, postMenuRows(p)); } }
async function editExisting(callbackId, key, id) { const p = await getPost(id); if (!p) return cb(callbackId, 'Пост не найден.', [[callbackButton('⬅️ К постам','post:all')]]); if (olderThan24(p)) return cb(callbackId, '🔒 Редактирование недоступно: прошло больше 24 часов.', [[callbackButton('⬅️ Назад', `post:open:${id}`)]]); const draft = makeDraftFromPost(p); await showEditor(callbackId, key, draft); }
async function saveExisting(callbackId, key, draft) { const post = await getPost(draft.postId); if (!post) return cb(callbackId, 'Пост не найден.', [[callbackButton('⬅️ К постам','post:all')]]); const content = await composePostForChannel(draft, draft.channelIds[0]); await query(`UPDATE scheduled_posts SET text=$2, format=$3, attachments=$4::jsonb, buttons=$5::jsonb, draft=$6::jsonb, is_ad=$7, cpm=$8, auto_delete_minutes=$9, report_after_hours=$10, updated_at=now() WHERE id=$1`, [draft.postId, content.text, content.format, JSON.stringify(normalizeAttachments(draft.content.attachments)), JSON.stringify(draft.buttons || []), JSON.stringify(draft), Boolean(draft.isAd), draft.cpm, draft.autoDeleteMinutes, draft.reportAfterHours || 24]); let warn = ''; if (post.status === 'published' && post.published_message_id) { try { await editMaxMessage(post.published_message_id, content); } catch(e) { warn = `\n\n⚠️ В базе сохранено, но MAX не обновил сообщение: ${escapeHtml(e.message || e)}`; } } await clearSession(key); await cb(callbackId, `━━━━━━━━━━━━━━\n✅ <b>Пост сохранён</b>${warn}\n━━━━━━━━━━━━━━`, [[callbackButton('👁 Открыть пост', `post:open:${draft.postId}`)],[callbackButton('🗂 Посты','post:all')]]); }

async function handleCallback(update) {
  const callbackId = getCallbackId(update); const payload = getCallbackPayload(update); const key = getSessionKey(update); const chatId = Number(getChatId(update) || key);
  log('callback', { payload, key });
  if (!callbackId) return;
  if (payload === 'noop') return;
  if (payload === 'main:menu') return showMainCallback(callbackId);
  if (payload === 'main:posting') return showStudio(callbackId);
  if (payload === 'channels:list') return showChannels(callbackId);
  if (payload === 'reports:menu') return cb(callbackId, '📊 Отчёты скоро будут здесь.', [[callbackButton('⬅️ В меню','main:menu')]]);
  if (payload === 'fraud:menu') return cb(callbackId, '🛡 Антифрод скоро будет здесь.', [[callbackButton('⬅️ В меню','main:menu')]]);
  if (payload === 'post:cancel') { await clearSession(key); return cb(callbackId, '❌ Действие отменено.', [[callbackButton('🏠 В меню','main:menu')]]); }
  if (payload === 'post:create') { const draft = emptyDraft(); return showChannelSelect(callbackId, key, draft, false); }
  if (payload === 'post:multi') { const s = await getSession(key); return showChannelSelect(callbackId, key, safeDraft(s.data), true); }
  if (payload.startsWith('post:toggle:')) { const id = Number(payload.split(':')[2]); const s = await getSession(key); const draft = safeDraft(s.data); const set = new Set(draft.channelIds); set.has(id) ? set.delete(id) : set.add(id); draft.channelIds = [...set]; return showChannelSelect(callbackId, key, draft, true); }
  if (payload.startsWith('post:single:')) { const id = Number(payload.split(':')[2]); const s = await getSession(key); const draft = safeDraft(s.data); draft.channelIds = [id]; return hasContent(draft) ? showEditor(callbackId, key, draft) : askContent(callbackId, key, draft); }
  if (payload === 'post:all_channels') { const s = await getSession(key); const draft = safeDraft(s.data); draft.channelIds = (await getChannels()).map(c=>Number(c.id)); return hasContent(draft) ? showEditor(callbackId, key, draft) : askContent(callbackId, key, draft); }
  if (payload === 'post:channels_next') { const s = await getSession(key); const draft = safeDraft(s.data); if (!draft.channelIds.length) return cb(callbackId, 'Выберите хотя бы один канал.', [[callbackButton('⬅️ Назад','post:multi')]]); return hasContent(draft) ? showEditor(callbackId, key, draft) : askContent(callbackId, key, draft); }
  if (payload === 'post:change_channels') { const s = await getSession(key); return showChannelSelect(callbackId, key, safeDraft(s.data), false); }
  if (payload === 'post:add_channel') return cb(callbackId, `━━━━━━━━━━━━━━\n🔗 <b>Подключить канал</b>\n\n1. Откройте канал в MAX.\n2. Добавьте LinkRay в администраторы.\n3. Выдайте право публикации.\n4. Вернитесь и нажмите «Мои каналы».\n━━━━━━━━━━━━━━`, [[callbackButton('📡 Мои каналы','channels:list')],[callbackButton('⬅️ Назад','post:create')]]);
  if (payload === 'editor:text') { const s = await getSession(key); await setSession(key, 'wait_edit_text', s.data); return cb(callbackId, '✏️ Отправьте новый текст поста. Форматирование MAX сохранится.', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:media') { const s = await getSession(key); await setSession(key, 'wait_edit_media', s.data); return cb(callbackId, '🖼 Отправьте новое фото, видео или файл.', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:button') { const s = await getSession(key); await setSession(key, 'wait_button', s.data); return cb(callbackId, '🔘 Формат кнопки:\n<code>Название - https://site.ru</code>\nНесколько в строке через |', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:signature') { const s = await getSession(key); const draft = safeDraft(s.data); if (draft.isAd) return cb(callbackId, '💼 Для рекламного поста автоподпись не добавляется.', [[callbackButton('⬅️ В редактор','editor:back')]]); const channelId = draft.channelIds[0]; const sig = channelId ? await loadSignature(channelId) : null; const rows = [[callbackButton('✏️ Заменить подпись','sig:add')],[callbackButton(sig?.is_active ? '🚫 Выключить' : '✅ Включить', 'sig:toggle')],[callbackButton('⬅️ В редактор','editor:back')]]; return cb(callbackId, `━━━━━━━━━━━━━━\n🏷 <b>Автоподпись</b>\n\nСтатус: ${sig?.is_active ? 'включена' : 'выключена'}\n\n${sig?.text ? sig.text : 'Подпись не создана.'}\n━━━━━━━━━━━━━━`, rows); }
  if (payload === 'sig:add') { const s = await getSession(key); await setSession(key, 'wait_signature', s.data); return cb(callbackId, '🏷 Отправьте подпись. Ссылки, жирный, курсив и подчёркивание MAX сохранятся.', [[callbackButton('⬅️ Назад','editor:signature')]]); }
  if (payload === 'sig:toggle') { const s = await getSession(key); const draft = safeDraft(s.data); if (draft.channelIds[0]) await setSignatureActive(draft.channelIds[0], true); return showEditor(callbackId, key, draft); }
  if (payload === 'editor:ad') { const s = await getSession(key); const draft = safeDraft(s.data); draft.isAd = !draft.isAd; if (draft.isAd) { draft.signatureEnabled = false; draft.reportAfterHours = 24; if (!draft.autoDeleteMinutes) draft.autoDeleteMinutes = 2880; } return showEditor(callbackId, key, draft); }
  if (payload === 'editor:cpm') { const s = await getSession(key); await setSession(key, 'wait_cpm', s.data); return cb(callbackId, '💰 Введите цену за 1000 просмотров.', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:back') { const s = await getSession(key); return showEditor(callbackId, key, safeDraft(s.data)); }
  if (payload === 'editor:next') { const s = await getSession(key); return showPublishMenu(callbackId, key, safeDraft(s.data)); }
  if (payload === 'editor:save') { const s = await getSession(key); return saveExisting(callbackId, key, safeDraft(s.data)); }
  if (payload === 'publish:auto_delete') { const s = await getSession(key); await setSession(key, 'wait_auto_delete', s.data); return cb(callbackId, '🗑 Введите срок: 48ч, 2д, 120 или 5:30. Для отключения: 0.', [[callbackButton('⬅️ Назад','editor:next')]]); }
  if (payload === 'schedule:manual') { const s = await getSession(key); await setSession(key, 'wait_schedule_time', s.data); return cb(callbackId, '🕒 Введите время: 18:30, 0235, завтра 18:30, через 1 минуту или 2026-06-23 18:30.', [[callbackButton('⬅️ Назад','editor:next')]]); }
  if (payload === 'schedule:calendar') { const s = await getSession(key); await setSession(key, 'wait_schedule_time', s.data); return cb(callbackId, '📅 Пока календарь в ручном режиме. Введите дату и время: 2026-06-23 18:30.', [[callbackButton('⬅️ Назад','editor:next')]]); }
  if (payload === 'publish:now') { const s = await getSession(key); const draft = safeDraft(s.data); const results = await publishDraftNow(draft, key); await clearSession(key); await answerCallback({ callbackId, notification: 'Публикация выполнена.' }).catch(()=>{}); return afterPublished(chatId, draft, results); }
  if (payload === 'post:all') {
    await answerCallback({ callbackId, notification: 'Открываю посты...' }).catch(()=>{});
    return sendPosts(chatId, 'all', await defaultPostDay('all'));
  }
  if (payload === 'post:channels') return showPostChannels(callbackId, chatId);
  if (payload.startsWith('post:filter:')) {
    const [, , mode, day, channel] = payload.split(':');
    return showPosts(callbackId, mode, day, Number(channel) || null, chatId);
  }
  if (payload.startsWith('post:open:')) return openPost(callbackId, chatId, Number(payload.split(':')[2]));
  if (payload.startsWith('post:editor:')) return editExisting(callbackId, key, Number(payload.split(':')[2]));
  if (payload.startsWith('post:auto:')) { await setSession(key, 'wait_post_auto_delete', { postId: Number(payload.split(':')[2]) }); return cb(callbackId, '🗑 Введите новый срок автоудаления: 48ч, 2д, 120 или 0.', [[callbackButton('⬅️ Назад', `post:open:${payload.split(':')[2]}`)]]); }
  if (payload.startsWith('post:time:')) { await setSession(key, 'wait_post_time', { postId: Number(payload.split(':')[2]) }); return cb(callbackId, '🕒 Введите новое время публикации.', [[callbackButton('⬅️ Назад', `post:open:${payload.split(':')[2]}`)]]); }
  if (payload.startsWith('post:now:')) { const p = await getPost(Number(payload.split(':')[2])); if (!p) return cb(callbackId, 'Пост не найден.', [[callbackButton('🗂 Посты','post:all')]]); const draft = makeDraftFromPost(p); const results = await publishDraftNow(draft, key); await query(`UPDATE scheduled_posts SET status='canceled', updated_at=now() WHERE id=$1`, [p.id]); await answerCallback({ callbackId, notification: 'Отправлено на публикацию.' }).catch(()=>{}); return afterPublished(chatId, draft, results); }
  if (payload.startsWith('post:delete_confirm:')) { const id = Number(payload.split(':')[2]); return cb(callbackId, `❌ Удалить пост #${id}?`, [[callbackButton('✅ Да, удалить', `post:delete:${id}`)],[callbackButton('⬅️ Назад', `post:open:${id}`)]]); }
  if (payload.startsWith('post:delete:')) { const id = Number(payload.split(':')[2]); const p = await getPost(id); if (p?.status === 'published' && p.published_message_id) await deleteMaxMessage(p.published_message_id).catch(e=>console.error('[delete max]', e.message || e)); await query(`UPDATE scheduled_posts SET status='canceled', updated_at=now() WHERE id=$1`, [id]); return cb(callbackId, `✅ Пост #${id} удалён.`, [[callbackButton('🗂 Посты','post:all')]]); }
  if (payload === 'sig:menu') return showSignaturesMenu(callbackId);
  await cb(callbackId, 'Команда пока не обработана.', [[callbackButton('🏠 В меню','main:menu')]]);
}

async function showChannels(callbackId) { const channels = await getChannels(); const rows = channels.map(c => [callbackButton(`📡 ${channelName(c)}`, `channels:refresh:${c.id}`)]); rows.push([callbackButton('🔗 Как добавить канал','post:add_channel')],[callbackButton('⬅️ В меню','main:menu')]); await cb(callbackId, `━━━━━━━━━━━━━━\n📡 <b>Мои каналы</b>\n\n${channels.length ? channels.map((c,i)=>`${i+1}. ${channelLine(c).replace('• ','')}`).join('\n') : 'Каналы пока не найдены.'}\n━━━━━━━━━━━━━━`, rows); }
async function showSignaturesMenu(callbackId) { const channels = await getChannels(); const rows = channels.map(c => [callbackButton(`🏷 ${channelName(c)}`, `sig:channel:${c.id}`)]); rows.push([callbackButton('⬅️ В Studio','main:posting')]); await cb(callbackId, `━━━━━━━━━━━━━━\n🏷 <b>Автоподписи</b>\n\nВыберите канал.\n━━━━━━━━━━━━━━`, rows); }

async function handleMessage(update) {
  const chatId = Number(getChatId(update)); const key = getSessionKey(update); const text = getMessageText(update); const n = norm(text); log('message', { chatId, key, text: text.slice(0,80) });
  await writeFile('/tmp/linkray_last_update.json', JSON.stringify(update, null, 2)).catch(()=>{});
  if (['/start','start','/menu','меню'].includes(n)) { await clearSession(key); return sendMain(chatId); }
  const session = await getSession(key); const draft = safeDraft(session.data);
  if (session.state === 'wait_post_content') { const content = await hydrateContent(update); draft.content = { ...draft.content, ...content }; await setSession(key, 'edit_draft', { draft }); await sendDraftPreview(chatId, draft); return msg(chatId, `🧬 Настройте оформление поста.`, [[callbackButton('✏️ Изменить текст','editor:text'), callbackButton('🖼 Медиа','editor:media')],[callbackButton('🔘 Добавить кнопку','editor:button'), callbackButton('🏷 Автоподпись','editor:signature')],[callbackButton('➡️ Далее','editor:next')],[callbackButton('❌ Отмена','post:cancel')]]); }
  if (session.state === 'wait_edit_text') { const content = await hydrateContent(update); draft.content.text = content.text || text; draft.content.format = 'html'; await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft }); return sendStudioEditorMessage(chatId, draft); }
  if (session.state === 'wait_edit_media') { const content = await hydrateContent(update); if (content.attachments.length) draft.content.attachments = content.attachments; if (content.text) draft.content.text = content.text; await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft }); return sendStudioEditorMessage(chatId, draft); }
  if (session.state === 'wait_button') { const parsed = parseButtonsInput(text); if (!parsed.length) return msg(chatId, 'Не понял кнопку. Формат: Название - https://site.ru'); draft.buttons = [...(draft.buttons || []), ...parsed]; await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft }); return sendStudioEditorMessage(chatId, draft); }
  if (session.state === 'wait_signature') { const content = await hydrateContent(update); const channelId = draft.channelIds[0]; if (channelId) await saveSignature(channelId, content); await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft }); return sendStudioEditorMessage(chatId, draft); }
  if (session.state === 'wait_cpm') { const cpm = Number(String(text).replace(',', '.').replace(/[^0-9.]/g,'')); if (!Number.isFinite(cpm) || cpm <= 0) return msg(chatId, 'Введите число, например 1000.'); draft.cpm = cpm; draft.isAd = true; draft.signatureEnabled = false; draft.autoDeleteMinutes ||= 2880; await setSession(key, 'edit_draft', { draft }); return sendStudioEditorMessage(chatId, draft); }
  if (session.state === 'wait_auto_delete') { const v = parseDuration(text); if (v === undefined) return msg(chatId, 'Не понял срок. Пример: 48ч, 2д, 120 или 0.'); draft.autoDeleteMinutes = v; await setSession(key, 'publish_menu', { draft }); return msg(chatId, '✅ Автоудаление обновлено.', [[callbackButton('➡️ К выпуску','editor:next')]]); }
  if (session.state === 'wait_schedule_time') { const publishAt = parseSchedule(text); if (!publishAt) return msg(chatId, 'Не понял время. Пример: 18:30, 0235, завтра 18:30, через 1 минуту.'); const ids = await scheduleDraft(draft, key, publishAt); await clearSession(key); return afterPlanned(chatId, draft, publishAt, ids); }
  if (session.state === 'wait_post_auto_delete') { const v = parseDuration(text); if (v === undefined) return msg(chatId, 'Не понял срок.'); await query('UPDATE scheduled_posts SET auto_delete_minutes=$2, updated_at=now() WHERE id=$1', [session.data.postId, v]); await clearSession(key); return msg(chatId, '✅ Автоудаление обновлено.', [[callbackButton('👁 Открыть пост', `post:open:${session.data.postId}`)]]); }
  if (session.state === 'wait_post_time') { const publishAt = parseSchedule(text); if (!publishAt) return msg(chatId, 'Не понял время.'); await query(`UPDATE scheduled_posts SET publish_at=$2, updated_at=now() WHERE id=$1`, [session.data.postId, publishAt]); await clearSession(key); return msg(chatId, '✅ Время обновлено.', [[callbackButton('👁 Открыть пост', `post:open:${session.data.postId}`)]]); }
  const content = await hydrateContent(update); if (content.text || content.attachments.length) { const d = emptyDraft(); d.content = { ...d.content, ...content }; await setSession(key, 'select_channels', { draft: d }); const channels = await getChannels(); const rs = channels.map(c => [callbackButton(`📡 ${channelName(c)}`, `post:single:${c.id}`)]); rs.push([callbackButton('🌐 Все каналы','post:all_channels')],[callbackButton('❌ Отмена','post:cancel')]); return msg(chatId, '📡 Пост принят. Теперь выберите канал для публикации.', rs); }
  return msg(chatId, 'Команда не найдена. Нажмите /start.');
}
async function sendStudioEditorMessage(chatId, draft) { await msg(chatId, `━━━━━━━━━━━━━━\n🧬 <b>Редактор LinkRay</b>\n\nИзменения приняты.\n━━━━━━━━━━━━━━`, [[callbackButton('✏️ Изменить текст','editor:text'), callbackButton('🖼 Медиа','editor:media')],[callbackButton('🔘 Добавить кнопку','editor:button'), callbackButton('🏷 Автоподпись','editor:signature')],[callbackButton(draft.postId ? '💾 Сохранить пост' : '➡️ Далее', draft.postId ? 'editor:save' : 'editor:next')]]); }

app.get('/health', async (_req, res) => { try { await query('SELECT 1'); res.json({ ok: true, service: 'linkray-bot', db: true, time: nowIso() }); } catch(e) { res.status(500).json({ ok:false, error: e.message }); } });
app.post('/webhook', async (req, res) => {
  const incomingSecret = req.header('X-Max-Bot-Api-Secret');
  if (process.env.WEBHOOK_SECRET && incomingSecret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ ok: false });
  res.json({ ok: true });
  try {
    const update = req.body || {}; const type = getUpdateType(update); log('webhook', { type, chatId: getChatId(update), key: getSessionKey(update) }); await maybeRegisterChannel(update);
    if (type.includes('callback') || getCallbackId(update)) await handleCallback(update); else await handleMessage(update);
  } catch(e) { console.error('[webhook] processing error:', e); }
});

await ensureDb();
startAutopostWorker().catch(e => console.error('[autopost start]', e));
app.listen(PORT, () => console.log(`LinkRay bot started on port ${PORT}`));
