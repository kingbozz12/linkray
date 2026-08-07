// LinkRay clean MAX client with native MAX markup passthrough

const MAX_API_URL = process.env.MAX_API_URL || process.env.MAX_BASE_URL || 'https://platform-api2.max.ru';

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

  function apply(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;

    obj.disable_link_preview = true;
    obj.disableLinkPreview = true;
    obj.disable_web_page_preview = true;
    obj.disableWebPagePreview = true;
    obj.link_preview = false;
    obj.linkPreview = false;

    if (Array.isArray(obj.attachments)) {
      obj.attachments = obj.attachments.filter((att) => {
        const type = String(att?.type || att?.kind || '').toLowerCase();
        return !(
          type === 'link_preview' ||
          type === 'rich_link' ||
          type === 'preview' ||
          type.includes('link_preview') ||
          type.includes('rich_link')
        );
      });
    }

    return obj;
  }

  apply(patched);

  if (patched.message && typeof patched.message === 'object' && !Array.isArray(patched.message)) {
    patched.message = { ...patched.message };
    apply(patched.message);
  }

  if (patched.body && typeof patched.body === 'object' && !Array.isArray(patched.body)) {
    patched.body = { ...patched.body };
    apply(patched.body);
  }

  if (patched.payload && typeof patched.payload === 'object' && !Array.isArray(patched.payload)) {
    patched.payload = { ...patched.payload };
    apply(patched.payload);

    if (patched.payload.message && typeof patched.payload.message === 'object' && !Array.isArray(patched.payload.message)) {
      patched.payload.message = { ...patched.payload.message };
      apply(patched.payload.message);
    }
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


function lrStripServicePreviewsV3(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;

  const text = String(body.text || '');

  const isServiceMessage =
    text.includes('━━━━━━━━━━━━━━') ||
    text.includes('LinkRay') ||
    text.includes('К выпуску') ||
    text.includes('CPM установлен') ||
    text.includes('Рекламный пост опубликован') ||
    text.includes('Страница отчёта') ||
    text.includes('Ссылка наблюдателя') ||
    text.includes('Редактор LinkRay') ||
    text.includes('Автоудаление') ||
    text.includes('Открыть отчёт');

  if (!isServiceMessage) return body;

  const cleaned = { ...body };

  cleaned.text = String(cleaned.text || '')
    .replace(/<a\b[^>]*href=["'][^"']+["'][^>]*>(.*?)<\/a>/gis, '$1')
    .replace(/https?:\/\/linkray\.ru\/analytics\/stats\/[^\s<]+/gi, 'LinkRay Analytics')
    .replace(/https?:\/\/max\.ru\/[^\s<]+/gi, 'канал');

  if (Array.isArray(cleaned.markup)) {
    cleaned.markup = cleaned.markup.filter((m) => {
      const type = String(m?.type || m?.kind || '').toLowerCase();
      return !m?.url && !m?.href && !type.includes('link');
    });
  }

  return cleaned;
}


/* LR_SUMMARY_REPORT_NEW_MAIN_MENU_V893_MAXCLIENT_START */
function lrV893SummaryReportAttachments(text, attachments = []) {
  const current = cleanAttachments(attachments);

  const plain = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const isSummaryReport =
    /Итоговая\s+стоимость\s*:/i.test(plain) &&
    /Публикации\s*:/i.test(plain) &&
    /Ссылка\s+на\s+отч[её]т\s*:/i.test(plain);

  if (!isSummaryReport) {
    return current;
  }

  const menuButton = {
    type: 'callback',
    text: '🏠 Главное меню',
    payload: 'main:menu:new',
  };

  let keyboardFound = false;
  let menuButtonFound = false;

  const patched = current.map((attachment) => {
    if (
      !attachment ||
      typeof attachment !== 'object' ||
      Array.isArray(attachment) ||
      String(attachment.type || '') !== 'inline_keyboard'
    ) {
      return attachment;
    }

    const buttons = attachment?.payload?.buttons;
    if (!Array.isArray(buttons)) {
      return attachment;
    }

    keyboardFound = true;

    const alreadyPresent = buttons.some((row) =>
      Array.isArray(row) &&
      row.some(
        (button) =>
          String(button?.payload || '') === 'main:menu:new'
      )
    );

    if (alreadyPresent) {
      menuButtonFound = true;
      return attachment;
    }

    if (menuButtonFound) {
      return attachment;
    }

    menuButtonFound = true;

    return {
      ...attachment,
      payload: {
        ...(attachment.payload || {}),
        buttons: [
          ...buttons,
          [menuButton],
        ],
      },
    };
  });

  if (!keyboardFound) {
    patched.push({
      type: 'inline_keyboard',
      payload: {
        buttons: [[menuButton]],
      },
    });

    menuButtonFound = true;
  }

  if (menuButtonFound) {
    console.log(
      '[LR_SUMMARY_REPORT_NEW_MAIN_MENU_V893] main menu button attached'
    );
  }

  return patched;
}
/* LR_SUMMARY_REPORT_NEW_MAIN_MENU_V893_MAXCLIENT_END */

function buildMessageBody({ text = '', format = 'html', attachments = [], markup = [] } = {}) {
  const body = {
    text: String(text || ''),
    format: format || 'html',
    attachments: lrV893SummaryReportAttachments(text, attachments)
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


/* LR_REPORT_NO_CLICKS_V59_MAXCLIENT_START */
function lrV59TextFromOutgoingPayload(value) {
  const out = [];
  const seen = new WeakSet();
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const key of ['text','caption','message','body','notification','title','description']) {
      const v = node[key];
      if (typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object') walk(v);
    }
    if (Array.isArray(node)) for (const v of node) walk(v);
  };
  walk(value);
  return out.join('\n');
}
function lrV59ShouldDropClickReport(payload) {
  const text = lrV59TextFromOutgoingPayload(payload).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const isReport = /Сводн(?:ый|ой)\s+отч[её]т|Публикации\s*:|Просмотры\s+за\s+24ч|Общие\s+просмотры/i.test(text);
  const hasClicks = /Уникальные\s+клики|Все\s+клики|Переходы\s+по\s+ссылкам|Красивый\s+отч[её]т\s*:|Все\s+переходы/i.test(text);
  return Boolean(isReport && hasClicks);
}
/* LR_REPORT_NO_CLICKS_V59_MAXCLIENT_END */
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


/* LR_CHANNEL_SEND_GUARD_V1 */
const LR_CHANNEL_GUARD_CACHE = new Map();

function lrGuardRows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function lrGuardText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lrLooksLikeServiceMessage(text = '') {
  const t = lrGuardText(text);

  if (!t) return false;

  const patterns = [
    /LinkRay/i,
    /Сводный\s+отч[её]т/i,
    /Ссылка\s+на\s+отч[её]т/i,
    /Страница\s+отч[её]та/i,
    /analytics\/stats/i,
    /Главное\s+меню/i,
    /Отслеживание\s+просмотров/i,
    /Просмотры\s+за\s+24ч/i,
    /Итоговая\s+стоимость/i,
    /Публикации\s*:/i,
    /Подсч[её]т\s*:\s*24ч/i,
    /CPM\s*:/i,
    /CPM\s+установлен/i,
    /Рекламный\s+пост\s+опубликован/i,
    /К\s+выпуску/i,
    /Редактор\s+LinkRay/i,
    /Автоудаление/i,
    /Перейти\s+в\s+бота/i,
    /Скопировать/i,
    /данные\s+обновляются/i,
    /Смотреть\s+график/i,
    /отч[её]т\s+по\s+рекламному\s+посту/i,
    /автопостинг\s+и\s+аналитика/i,
  ];

  return patterns.some((rx) => rx.test(t));
}

async function lrKnownChannelChat(chatId) {
  const id = String(chatId || '').trim();

  if (!id) return false;

  const cached = LR_CHANNEL_GUARD_CACHE.get(id);

  if (cached && cached.until > Date.now()) return cached.value;

  let value = false;

  try {
    const db = await import('./db.js');

    if (typeof db.query !== 'function') {
      LR_CHANNEL_GUARD_CACHE.set(id, { value: false, until: Date.now() + 30000 });
      return false;
    }

    const colsResult = await db.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='channels'`
    ).catch(() => []);

    const cols = new Set(lrGuardRows(colsResult).map((r) => String(r.column_name)));

    if (!cols.size || !cols.has('id')) {
      LR_CHANNEL_GUARD_CACHE.set(id, { value: false, until: Date.now() + 30000 });
      return false;
    }

    const candidates = [
      'id',
      'chat_id',
      'channel_id',
      'max_chat_id',
      'max_channel_id',
      'max_id',
      'external_id',
      'peer_id',
      'username',
      'handle',
    ].filter((col) => cols.has(col));

    const where = candidates.map((col) => `"${col}"::text=$1`).join(' OR ');

    const found = await db.query(
      `SELECT 1 FROM channels WHERE ${where} LIMIT 1`,
      [id]
    ).catch(() => []);

    value = lrGuardRows(found).length > 0;
  } catch (error) {
    console.error('[LR_CHANNEL_GUARD] db check failed:', error.message || error);
    value = false;
  }

  LR_CHANNEL_GUARD_CACHE.set(id, { value, until: Date.now() + 30000 });
  return value;
}

async function lrAssertChannelSendAllowed({
  chatId,
  userId,
  text,
  purpose,
  allowChannelService,
  allowChannelPost,
  bypassChannelGuard,
} = {}) {
  if (bypassChannelGuard) return;

  if (!chatId || userId) return;

  const isChannel = await lrKnownChannelChat(chatId);

  if (!isChannel) return;

  const service = lrLooksLikeServiceMessage(text);

  if (service && !allowChannelService) {
    const preview = lrGuardText(text).slice(0, 220);

    console.error('[LR_CHANNEL_GUARD_BLOCKED]', JSON.stringify({
      chatId: String(chatId),
      purpose: String(purpose || ''),
      preview,
    }));

    throw new Error('LR_CHANNEL_GUARD_BLOCKED: service/admin message cannot be sent to channel');
  }

  if (!allowChannelPost && !service) {
    console.log('[LR_CHANNEL_GUARD_ALLOWED_POST]', JSON.stringify({
      chatId: String(chatId),
      purpose: String(purpose || 'post'),
      preview: lrGuardText(text).slice(0, 120),
    }));
  }
}


export async function sendMaxMessage({
  chatId,
  userId,
  text = '',
  format = 'html',
  attachments = [],
  markup = [],
  purpose = '',
  allowChannelService = false,
  allowChannelPost = false,
  bypassChannelGuard = false,
} = {}) { if (typeof lrV59ShouldDropClickReport === 'function' && lrV59ShouldDropClickReport({ chatId, userId, text, format, attachments, markup })) { console.log('[v59 report] dropped duplicate 24h click report', JSON.stringify({ chatId: String(chatId || ''), userId: String(userId || ''), preview: String(text || '').slice(0, 180) })); return { success: true, ok: true, skipped: 'lr_v59_duplicate_click_report' }; }
  const url = new URL(`${MAX_API_URL}/messages`);

  if (chatId) {
    url.searchParams.set('chat_id', String(chatId));
  } else if (userId) {
    url.searchParams.set('user_id', String(userId));
  } else {
    throw new Error('chatId or userId is required');
  }

    // LINKRAY_DISABLE_LINK_PREVIEW_QUERY_V2
  // В POST /messages MAX принимает disable_link_preview как query-параметр.
  url.searchParams.set('disable_link_preview', 'true');

await lrAssertChannelSendAllowed({
    chatId,
    userId,
    text,
    purpose,
    allowChannelService,
    allowChannelPost,
    bypassChannelGuard,
  });

  const body = buildMessageBody({ text, format, attachments, markup });

  return fetchJson(url, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify(lrNoPreviewPayload(body)),
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
