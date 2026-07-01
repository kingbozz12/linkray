// LinkRay clean MAX client with native MAX markup passthrough

const MAX_API_URL = process.env.MAX_API_URL || process.env.MAX_BASE_URL || 'https://platform-api.max.ru';

function token() {
  return process.env.BOT_TOKEN || process.env.MAX_BOT_TOKEN || process.env.MAX_TOKEN || '';
}

function headers(json = true) {
  const h = { Authorization: token() };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function lrNoPreviewPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  const patched = { ...payload };

  patched.disable_link_preview = false;
  patched.disableLinkPreview = false;

  if (patched.message && typeof patched.message === 'object' && !Array.isArray(patched.message)) {
    patched.message = {
      ...patched.message,
      disable_link_preview: false,
      disableLinkPreview: false
    };
  }

  return patched;
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

    const key = JSON.stringify(item);
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(item);
  }

  return out;
}

function cleanMarkup(markup = [], text = '') {
  const source = String(text || '');
  const max = source.length;
  const list = Array.isArray(markup) ? markup : [];
  const out = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const rawType = String(
      item.type ||
      item.kind ||
      item.style ||
      item.format ||
      item.markup_type ||
      item.markupType ||
      ''
    ).toLowerCase();

    if (!rawType) continue;

    let type =
      item.type ||
      item.kind ||
      item.style ||
      item.format ||
      item.markup_type ||
      item.markupType;

    if (rawType === 'bold') type = 'strong';
    if (rawType === 'italic' || rawType === 'em') type = 'emphasized';
    if (rawType === 'strike' || rawType === 's' || rawType === 'deleted') type = 'strikethrough';
    if (rawType === 'mono' || rawType === 'code' || rawType === 'pre') type = 'monospaced';

    if (
      rawType === 'heading' ||
      rawType === 'header' ||
      rawType === 'title' ||
      rawType === 'h1' ||
      rawType.includes('heading') ||
      rawType.includes('header')
    ) {
      type = 'heading';
    }

    if (
      rawType === 'quote' ||
      rawType === 'blockquote' ||
      rawType === 'citation' ||
      rawType === 'cite' ||
      rawType.includes('quote') ||
      rawType.includes('blockquote') ||
      rawType.includes('citation')
    ) {
      type = 'blockquote';
    }

    let from = Number(
      item.from ??
      item.start ??
      item.offset ??
      item.position ??
      item.index ??
      item.begin ??
      0
    );

    if (!Number.isFinite(from)) from = 0;
    from = Math.max(0, Math.min(max, from));

    let end = Number(item.to ?? item.end ?? item.stop);

    if (!Number.isFinite(end)) {
      const len = Number(item.length ?? item.len ?? item.size ?? item.count ?? 0);
      end = Number.isFinite(len) && len > 0 ? from + len : from;
    }

    end = Math.max(from, Math.min(max, end));

    const length = end - from;
    if (length <= 0) continue;

    const url = String(
      item.url ||
      item.href ||
      item.link ||
      item.payload?.url ||
      item.payload?.href ||
      item.payload?.link ||
      ''
    ).trim();

    const fixed = {
      from,
      length,
      type
    };

    if (url) fixed.url = url;

    const key = JSON.stringify(fixed);
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(fixed);
  }

  return out;
}

function buildMessageBody({ text = '', format = 'html', attachments = [], markup = [] } = {}) {
  const body = {
    text: String(text || ''),
    format: format || 'html',
    attachments: cleanAttachments(attachments)
  };

  const fixedMarkup = cleanMarkup(markup, body.text);
  if (fixedMarkup.length) {
    body.markup = fixedMarkup;
  }

  console.log('[max-send-format]', JSON.stringify({
    format: body.format,
    text_preview: body.text.slice(0, 240),
    markup_count: fixedMarkup.length,
    markup_types: fixedMarkup.map(x => x.type)
  }));

  return body;
}

export function callbackButton(text, payload) {
  return {
    type: 'callback',
    text: String(text),
    payload: String(payload)
  };
}

export function linkButton(text, url) {
  return {
    type: 'link',
    text: String(text),
    url: String(url)
  };
}

export function inlineKeyboard(rows = []) {
  return [
    {
      type: 'inline_keyboard',
      payload: {
        buttons: rows
      }
    }
  ];
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);

  if (!response.ok || data?.success === false) {
    throw new Error(`MAX API error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

export async function sendMaxMessage({
  chatId,
  userId,
  text = '',
  format = 'html',
  attachments = [],
  markup = []
}) {
  const url = new URL(`${MAX_API_URL}/messages`);

  if (chatId) url.searchParams.set('chat_id', String(chatId));
  else if (userId) url.searchParams.set('user_id', String(userId));
  else throw new Error('chatId or userId is required');

  const body = buildMessageBody({ text, format, attachments, markup });

  return fetchJson(url, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify(lrNoPreviewPayload(body))
  });
}

export async function answerCallback({
  callbackId,
  text = '',
  format = 'html',
  attachments = [],
  markup = [],
  notification = ''
}) {
  const url = new URL(`${MAX_API_URL}/answers`);
  url.searchParams.set('callback_id', String(callbackId));

  const message = buildMessageBody({ text, format, attachments, markup });

  const attempts = [];

  if (notification) {
    attempts.push({ notification: String(notification) });
  }

  attempts.push({ message });
  attempts.push(message);

  let lastError = null;

  for (const body of attempts) {
    try {
      return await fetchJson(url, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify(lrNoPreviewPayload(body))
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('answerCallback failed');
}

export async function getMaxChatInfo(chatId) {
  const url = new URL(`${MAX_API_URL}/chats/${encodeURIComponent(String(chatId))}`);

  return fetchJson(url, {
    method: 'GET',
    headers: headers(false)
  });
}

export async function getMaxMessage(messageId, params = {}) {
  const id = typeof messageId === 'object'
    ? (messageId.message_id || messageId.messageId || messageId.id || messageId.mid)
    : messageId;

  if (!id) throw new Error('message id is required');

  const urls = [];

  const chatId =
    params.chatId ||
    params.chat_id ||
    (
      typeof messageId === 'object'
        ? (messageId.chatId || messageId.chat_id)
        : null
    );

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
      return await fetchJson(url, {
        method: 'GET',
        headers: headers(false)
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('MAX API error while reading message');
}

export async function editMaxMessage(
  messageId,
  {
    text = '',
    format = 'html',
    attachments = [],
    markup = []
  } = {}
) {
  const url = new URL(`${MAX_API_URL}/messages`);
  url.searchParams.set('message_id', String(messageId));

  const body = buildMessageBody({ text, format, attachments, markup });

  return fetchJson(url, {
    method: 'PUT',
    headers: headers(true),
    body: JSON.stringify(lrNoPreviewPayload(body))
  });
}

export async function deleteMaxMessage(messageId) {
  const url = new URL(`${MAX_API_URL}/messages`);
  url.searchParams.set('message_id', String(messageId));

  return fetchJson(url, {
    method: 'DELETE',
    headers: headers(false)
  });
}
