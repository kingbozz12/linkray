
// LR_DISABLE_LINK_PREVIEW_START
function lrNoPreviewPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  const patched = { ...payload };

  patched.disable_link_preview = false;
  patched.disableLinkPreview = false;

  if (patched.message && typeof patched.message === 'object' && !Array.isArray(patched.message)) {
    patched.message = {
      ...patched.message,
      disable_link_preview: false,
      disableLinkPreview: false,
    };
  }

  return patched;
}
// LR_DISABLE_LINK_PREVIEW_END

const MAX_API_URL = process.env.MAX_API_URL || process.env.MAX_BASE_URL || 'https://platform-api.max.ru';

function token() {
  return process.env.BOT_TOKEN || process.env.MAX_BOT_TOKEN || process.env.MAX_TOKEN || '';
}

function headers(json = true) {
  const h = { Authorization: token() };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function cleanAttachments(attachments = []) {
  const out = [];
  const seen = new Set();
  for (const item of attachments || []) {
    if (!item) continue;
    if (Array.isArray(item)) {
      for (const nested of cleanAttachments(item)) out.push(nested);
      continue;
    }
    if (typeof item !== 'object') continue;
    const key = JSON.stringify(lrNoPreviewPayload(item));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function callbackButton(text, payload) {
  return { type: 'callback', text: String(text), payload: String(payload) };
}

export function linkButton(text, url) {
  return { type: 'link', text: String(text), url: String(url) };
}

export function inlineKeyboard(rows = []) {
  return [{ type: 'inline_keyboard', payload: { buttons: rows } }];
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) {
    throw new Error(`MAX API error ${response.status}: ${JSON.stringify(lrNoPreviewPayload(data))}`);
  }
  return data;
}

export async function sendMaxMessage({ chatId, userId, text = '', format = 'html', attachments = [] }) {
  const url = new URL(`${MAX_API_URL}/messages`);
  if (chatId) url.searchParams.set('chat_id', String(chatId));
  else if (userId) url.searchParams.set('user_id', String(userId));
  else throw new Error('chatId or userId is required');

  const body = {
    text: String(text || ''),
    format: format || 'html',
    attachments: cleanAttachments(attachments),
  };

  return fetchJson(url, { method: 'POST', headers: headers(true), body: JSON.stringify(lrNoPreviewPayload(body)) });
}

export async function answerCallback({ callbackId, text = '', format = 'html', attachments = [], notification = '' }) {
  const url = new URL(`${MAX_API_URL}/answers`);
  url.searchParams.set('callback_id', String(callbackId));

  const clean = cleanAttachments(attachments);
  const attempts = [];
  if (notification) attempts.push({ notification: String(notification) });
  attempts.push({ message: { text: String(text || ''), format: format || 'html', attachments: clean } });
  attempts.push({ text: String(text || ''), format: format || 'html', attachments: clean });

  let lastError = null;
  for (const body of attempts) {
    try {
      return await fetchJson(url, { method: 'POST', headers: headers(true), body: JSON.stringify(lrNoPreviewPayload(body)) });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('answerCallback failed');
}

export async function getMaxChatInfo(chatId) {
  const url = new URL(`${MAX_API_URL}/chats/${encodeURIComponent(String(chatId))}`);
  return fetchJson(url, { method: 'GET', headers: headers(false) });
}

export async function getMaxMessage(messageId, params = {}) {
  const id = typeof messageId === 'object' ? (messageId.message_id || messageId.messageId || messageId.id || messageId.mid) : messageId;
  if (!id) throw new Error('message id is required');

  const urls = [];
  const chatId = params.chatId || params.chat_id || (typeof messageId === 'object' ? (messageId.chatId || messageId.chat_id) : null);

  const direct = new URL(`${MAX_API_URL}/messages/${encodeURIComponent(String(id))}`);
  if (chatId) direct.searchParams.set('chat_id', String(chatId));
  urls.push(direct);

  const queryUrl = new URL(`${MAX_API_URL}/messages`);
  queryUrl.searchParams.set('message_id', String(id));
  if (chatId) queryUrl.searchParams.set('chat_id', String(chatId));
  urls.push(queryUrl);

  let lastError = null;
  for (const url of urls) {
    try {
      return await fetchJson(url, { method: 'GET', headers: headers(false) });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('MAX API error while reading message');
}

export async function editMaxMessage(messageId, { text = '', format = 'html', attachments = [] } = {}) {
  const url = new URL(`${MAX_API_URL}/messages`);
  url.searchParams.set('message_id', String(messageId));
  return fetchJson(url, {
    method: 'PUT',
    headers: headers(true),
    body: JSON.stringify(lrNoPreviewPayload({ text: String(text || ''), format: format || 'html', attachments: cleanAttachments(attachments) })),
  });
}

export async function deleteMaxMessage(messageId) {
  const url = new URL(`${MAX_API_URL}/messages`);
  url.searchParams.set('message_id', String(messageId));
  return fetchJson(url, { method: 'DELETE', headers: headers(false) });
}
