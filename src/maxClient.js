
// LR_MAX_TEXT_FORMAT_START
function lrDetectMaxTextFormat(text) {
  const value = String(text || '');

  if (!value.trim()) return null;

  // HTML: <b>, <i>, <a href>, <blockquote>, <h1>, <code>, <pre> и т.д.
  if (/<\/?(b|strong|i|em|u|s|strike|del|a|blockquote|quote|h[1-6]|code|pre|br|p|ul|ol|li|span)\b/i.test(value)) {
    return 'html';
  }

  // Markdown: **жирный**, _курсив_, [ссылка](url), > цитата, # заголовок, списки, код.
  if (
    /(^|\n)\s{0,3}(#{1,6}\s+)/.test(value) ||
    /(^|\n)\s{0,3}>\s+/.test(value) ||
    /(^|\n)\s{0,3}([-*+]\s+|\d+\.\s+)/.test(value) ||
    /```[\s\S]*?```/.test(value) ||
    /`[^`\n]+`/.test(value) ||
    /\*\*[^*\n][\s\S]*?[^*\n]\*\*/.test(value) ||
    /__[^_\n][\s\S]*?[^_\n]__/.test(value) ||
    /(^|[^*])\*[^*\n][^*\n]*[^*\n]\*([^*]|$)/.test(value) ||
    /(^|[^_])_[^_\n][^_\n]*[^_\n]_([^_]|$)/.test(value) ||
    /\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)/i.test(value)
  ) {
    return 'markdown';
  }

  return null;
}

function lrDecorateMaxTextPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  let changed = false;
  const next = { ...payload };

  if (typeof next.text === 'string' && next.text.trim() && !next.format) {
    const format = lrDetectMaxTextFormat(next.text);
    if (format) {
      next.format = format;
      changed = true;
    }
  }

  if (next.message && typeof next.message === 'object' && !Array.isArray(next.message)) {
    const decorated = lrDecorateMaxTextPayload(next.message);
    if (decorated !== next.message) {
      next.message = decorated;
      changed = true;
    }
  }

  return changed ? next : payload;
}

function lrPatchMaxTextFormatFetch() {
  if (globalThis.__lrMaxTextFormatFetchPatched) return;
  if (typeof globalThis.fetch !== 'function') return;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function lrMaxTextFormatFetch(input, init = {}) {
    try {
      const url = typeof input === 'string'
        ? input
        : String(input?.url || '');

      const method = String(init?.method || 'GET').toUpperCase();

      if (
        /\/messages(\?|$)/.test(url) &&
        (method === 'POST' || method === 'PUT' || method === 'PATCH') &&
        typeof init?.body === 'string' &&
        init.body.trim().startsWith('{')
      ) {
        const parsed = JSON.parse(init.body);
        const decorated = lrDecorateMaxTextPayload(parsed);

        if (decorated !== parsed) {
          init = {
            ...init,
            body: JSON.stringify(decorated),
          };

          console.log('[max-text-format] enabled:', JSON.stringify({
            url: url.replace(/access_token=[^&]+/g, 'access_token=***'),
            format: decorated.format || decorated.message?.format || null,
          }));
        }
      }
    } catch (error) {
      console.log('[max-text-format] skipped:', error.message || error);
    }

    return originalFetch(input, init);
  };

  globalThis.__lrMaxTextFormatFetchPatched = true;
}

lrPatchMaxTextFormatFetch();
// LR_MAX_TEXT_FORMAT_END



// LR_DISABLE_LINK_PREVIEW_START
function lrNoPreviewPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  const patched = { ...payload };

  // В MAX: false = не генерировать preview ссылок.
  patched.disable_link_preview = true;
  patched.disableLinkPreview = true;

  if (patched.message && typeof patched.message === 'object' && !Array.isArray(patched.message)) {
    patched.message = {
      ...patched.message,
      disable_link_preview: true,
      disableLinkPreview: true,
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


// LR_FORCE_MAX_FORMAT_START
function lrLooksLikeHtml(text) {
  return /<\/?(b|strong|i|em|u|ins|s|strike|del|a|blockquote|h[1-6]|code|pre|mark)\b/i.test(String(text || ''));
}

function lrLooksLikeMarkdown(text) {
  const value = String(text || '');

  return (
    /(^|\n)\s{0,3}#{1,6}\s+\S/.test(value) ||
    /(^|\n)\s{0,3}>\s+\S/.test(value) ||
    /(^|\n)\s{0,3}([-*+]\s+|\d+\.\s+)\S/.test(value) ||
    /```[\s\S]*?```/.test(value) ||
    /`[^`\n]+`/.test(value) ||
    /\*\*[\s\S]+?\*\*/.test(value) ||
    /__[\s\S]+?__/.test(value) ||
    /~~[\s\S]+?~~/.test(value) ||
    /\+\+[\s\S]+?\+\+/.test(value) ||
    /\^\^[\s\S]+?\^\^/.test(value) ||
    /\[[^\]\n]+\]\((https?:\/\/[^)\s]+|max:\/\/user\/\d+)\)/i.test(value)
  );
}

function lrForceMaxFormat(text, current = 'html') {
  const value = String(text || '');

  if (lrLooksLikeHtml(value)) return 'html';
  if (lrLooksLikeMarkdown(value)) return 'markdown';

  return current || 'html';
}
// LR_FORCE_MAX_FORMAT_END



// LR_HARD_FORCE_MAX_FORMAT_START
function lrHardLooksHtml(text) {
  return /<\/?(b|strong|i|em|u|ins|s|strike|del|a|blockquote|h[1-6]|code|pre|mark)\b/i.test(String(text || ''));
}

function lrHardLooksMarkdown(text) {
  const value = String(text || '');

  return (
    /(^|\n)\s{0,3}#{1,6}\s+\S/.test(value) ||
    /(^|\n)\s{0,3}>\s+\S/.test(value) ||
    /```[\s\S]*?```/.test(value) ||
    /`[^`\n]+`/.test(value) ||
    /\*\*[\s\S]+?\*\*/.test(value) ||
    /__[\s\S]+?__/.test(value) ||
    /~~[\s\S]+?~~/.test(value) ||
    /\+\+[\s\S]+?\+\+/.test(value) ||
    /\^\^[\s\S]+?\^\^/.test(value) ||
    /\[[^\]\n]+\]\((https?:\/\/[^)\s]+|max:\/\/user\/\d+)\)/i.test(value)
  );
}

function lrHardFormat(text, fallback = 'html') {
  const value = String(text || '');
  if (lrHardLooksHtml(value)) return 'html';
  if (lrHardLooksMarkdown(value)) return 'markdown';
  return fallback || 'html';
}
// LR_HARD_FORCE_MAX_FORMAT_END



// LR_SAFE_OUTGOING_FORMAT_START
function lrSafeOutgoingFormat(text, fallback = 'html') {
  const value = String(text || '');

  if (!value.trim()) return fallback || 'html';

  // Если пользователь сам ввёл HTML — отправляем как html.
  if (/<\/?(b|strong|i|em|u|ins|s|strike|del|a|blockquote|h[1-6]|code|pre|mark)\b/i.test(value)) {
    return 'html';
  }

  // Если текст похож на MAX Markdown — отправляем как markdown.
  if (
    /(^|\n)\s{0,3}#{1,6}\s+\S/.test(value) ||
    /(^|\n)\s{0,3}>\s+\S/.test(value) ||
    /\*\*[\s\S]+?\*\*/.test(value) ||
    /__[\s\S]+?__/.test(value) ||
    /~~[\s\S]+?~~/.test(value) ||
    /\+\+[\s\S]+?\+\+/.test(value) ||
    /\^\^[\s\S]+?\^\^/.test(value) ||
    /`[^`\n]+`/.test(value) ||
    /```[\s\S]*?```/.test(value) ||
    /\[[^\]\n]+\]\s*\((https?:\/\/[^)\s]+|max:\/\/user\/\d+)\)/i.test(value)
  ) {
    return 'markdown';
  }

  return fallback || 'html';
}
// LR_SAFE_OUTGOING_FORMAT_END



// LR_MIXED_MARKUP_TO_MARKDOWN_START
function lrStripInlineHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function lrNormalizeMixedMarkupToMarkdown(text) {
  let value = String(text || '');

  // HTML-ссылка внутри markdown-текста -> markdown-ссылка.
  value = value.replace(
    /<a\b[^>]*href=(["'])(https?:\/\/[^"']+|max:\/\/user\/\d+)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_, __, url, label) => `[${lrStripInlineHtml(label).trim() || url}](${url})`
  );

  // Если MAX прислал ссылку как:
  // [Ссылка]
  // (https://...)
  value = value.replace(
    /\[([^\]\n]+)\]\s*\n\s*\((https?:\/\/[^)\s]+|max:\/\/user\/\d+)\)/gi,
    '[$1]($2)'
  );

  // Остальные HTML-теги, если вдруг смешались с markdown.
  value = value
    .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, x) => `# ${lrStripInlineHtml(x).trim()}`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, x) => {
      return lrStripInlineHtml(x).split('\n').map(line => line.trim() ? `> ${line}` : '>').join('\n');
    })
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/(b|strong)>/gi, (_, __, x) => `**${lrStripInlineHtml(x)}**`)
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/(i|em)>/gi, (_, __, x) => `_${lrStripInlineHtml(x)}_`)
    .replace(/<(u|ins)\b[^>]*>([\s\S]*?)<\/(u|ins)>/gi, (_, __, x) => `++${lrStripInlineHtml(x)}++`)
    .replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/(s|strike|del)>/gi, (_, __, x) => `~${lrStripInlineHtml(x)}~`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, x) => '`' + lrStripInlineHtml(x).replace(/`/g, 'ʼ') + '`')
    .replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi, (_, x) => `^^${lrStripInlineHtml(x)}^^`);

  return value;
}

function lrLooksMarkdownAfterNormalize(text) {
  const value = String(text || '');

  return (
    /(^|\n)\s{0,3}#{1,6}\s+\S/.test(value) ||
    /(^|\n)\s{0,3}>\s+\S/.test(value) ||
    /\*\*[\s\S]+?\*\*/.test(value) ||
    /__[\s\S]+?__/.test(value) ||
    /~[^~\n][\s\S]*?[^~\n]~/.test(value) ||
    /\+\+[\s\S]+?\+\+/.test(value) ||
    /\^\^[\s\S]+?\^\^/.test(value) ||
    /`[^`\n]+`/.test(value) ||
    /```[\s\S]*?```/.test(value) ||
    /\[[^\]\n]+\]\((https?:\/\/[^)\s]+|max:\/\/user\/\d+)\)/i.test(value)
  );
}

function lrOutgoingTextAndFormat(text, fallback = 'html') {
  const normalized = lrNormalizeMixedMarkupToMarkdown(text);

  if (lrLooksMarkdownAfterNormalize(normalized)) {
    return { text: normalized, format: 'markdown' };
  }

  return { text: String(text || ''), format: fallback || 'html' };
}
// LR_MIXED_MARKUP_TO_MARKDOWN_END



// LR_CLEAN_LINK_LABELS_START
function lrCleanLinkLabelMarkdown(label) {
  return String(label || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/\+\+/g, '')
    .replace(/~~/g, '')
    .replace(/\^\^/g, '')
    .replace(/`/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function lrCleanAllMarkdownLinkLabels(text) {
  return String(text || '').replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|max:\/\/user\/\d+)\)/gi,
    (_, label, url) => `[${lrCleanLinkLabelMarkdown(label) || url}](${url})`
  );
}
// LR_CLEAN_LINK_LABELS_END


async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) {
    throw new Error(`MAX API error ${response.status}: ${JSON.stringify(lrNoPreviewPayload(data))}`);
  }
  return data;
}

export async function sendMaxMessage({ chatId, userId, text = '', format = 'html', markup = [], attachments = [] }) {
  const url = new URL(`${MAX_API_URL}/messages`);
  if (chatId) url.searchParams.set('chat_id', String(chatId));
  else if (userId) url.searchParams.set('user_id', String(userId));
  else throw new Error('chatId or userId is required');

  const normalizedOutgoing = lrOutgoingTextAndFormat(text, format || 'html');
  const outgoingText = lrCleanAllMarkdownLinkLabels(normalizedOutgoing.text);
  const outgoingFormat = normalizedOutgoing.format;
  const body = {
    text: outgoingText,
    format: outgoingFormat,
    attachments: cleanAttachments(attachments),
  };

  console.log('[max-send-format]', JSON.stringify({
    format: body.format,
    text_preview: outgoingText.slice(0, 120)
  }));

  return fetchJson(url, { method: 'POST', headers: headers(true), body: JSON.stringify(lrNoPreviewPayload(body)) });
}

export async function answerCallback({ callbackId, text = '', format = 'html', attachments = [], notification = '' }) {
  const url = new URL(`${MAX_API_URL}/answers`);
  url.searchParams.set('callback_id', String(callbackId));

  const clean = cleanAttachments(attachments);
  const attempts = [];
  if (notification) attempts.push({ notification: String(notification) });
  attempts.push({ message: { text: String(text || ''), format: lrSafeOutgoingFormat(String(text || ''), format || 'html'), attachments: clean } });
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

export async function editMaxMessage(messageId, { text = '', format = 'html', markup = [], attachments = [] } = {}) {
  const url = new URL(`${MAX_API_URL}/messages`);
  url.searchParams.set('message_id', String(messageId));
  return fetchJson(url, {
    method: 'PUT',
    headers: headers(true),
    body: JSON.stringify(lrNoPreviewPayload({
      text: lrCleanAllMarkdownLinkLabels(lrOutgoingTextAndFormat(text, format || 'html').text),
      format: lrOutgoingTextAndFormat(text, format || 'html').format,
      attachments: cleanAttachments(attachments)
    })),
  });
}

export async function deleteMaxMessage(messageId) {
  const url = new URL(`${MAX_API_URL}/messages`);
  url.searchParams.set('message_id', String(messageId));
  return fetchJson(url, { method: 'DELETE', headers: headers(false) });
}
