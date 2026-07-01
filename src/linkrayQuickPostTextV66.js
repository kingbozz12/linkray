import { query } from './db.js';

const TAG = 'LR_QUICK_POST_TEXT_V66';

function rows(r) {
  return Array.isArray(r) ? r : (r?.rows || []);
}

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function token() {
  return (
    process.env.MAX_TOKEN ||
    process.env.MAX_BOT_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.ACCESS_TOKEN ||
    process.env.MAX_ACCESS_TOKEN ||
    process.env.ONEME_TOKEN ||
    ''
  ).trim();
}

function apiBase() {
  return (
    process.env.MAX_API_BASE ||
    process.env.MAX_API_URL ||
    process.env.PLATFORM_API_URL ||
    'https://platform-api2.max.ru'
  ).replace(/\/+$/, '');
}

function pick(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[k];
  }
  return cur ?? null;
}

function chatIdOf(update) {
  return (
    pick(update, ['message', 'recipient', 'chat_id']) ||
    pick(update, ['message', 'chat_id']) ||
    pick(update, ['recipient', 'chat_id']) ||
    pick(update, ['chat_id']) ||
    null
  );
}

function textOf(update) {
  const direct =
    pick(update, ['message', 'body', 'text']) ||
    pick(update, ['message', 'text']) ||
    pick(update, ['body', 'text']) ||
    pick(update, ['text']);

  if (typeof direct === 'string') return direct;

  const stack = [update];
  const seen = new Set();

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);

    if (typeof cur.text === 'string' && cur.text.trim()) return cur.text;
    if (cur.body && typeof cur.body.text === 'string' && cur.body.text.trim()) return cur.body.text;

    for (const v of Object.values(cur)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }

  return '';
}

function isForwarded(update) {
  const raw = JSON.stringify(update || {}).toLowerCase();
  return raw.includes('forward') || raw.includes('source_message') || raw.includes('original_message') || raw.includes('sender_chat');
}

function short(v, n = 34) {
  const s = String(v || '').trim() || 'Канал';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function btn(text, payload) {
  return { type: 'callback', text, payload };
}

async function sendMessage(chatId, text, buttons = []) {
  const t = token();
  if (!t || !chatId) return false;

  const payload = {
    text,
    format: 'html',
    notify: true
  };

  if (buttons.length) {
    payload.attachments = [{
      type: 'inline_keyboard',
      payload: { buttons }
    }];
  }

  try {
    const res = await fetch(`${apiBase()}/messages?chat_id=${encodeURIComponent(String(chatId))}`, {
      method: 'POST',
      headers: {
        Authorization: t,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const body = await res.text().catch(() => '');
    console.log(`[${TAG}] send`, JSON.stringify({ ok: res.ok, http: res.status, body: body.slice(0, 400) }));
    return res.ok;
  } catch (e) {
    console.log(`[${TAG}] send error`, e?.message || e);
    return false;
  }
}

async function getChannels() {
  return rows(await query(`
    SELECT id,title,max_chat_id,link
    FROM channels
    WHERE max_chat_id IS NOT NULL
    ORDER BY title ASC NULLS LAST, id ASC
    LIMIT 80
  `).catch(() => []));
}

export function mountLinkRayQuickPostTextV66(app) {
  app.use((req, res, next) => {
    const method = String(req?.method || '').toUpperCase();
    const url = String(req?.originalUrl || req?.url || '');

    if (!(method === 'POST' && url.includes('/webhook'))) return next();

    const update = req.body || {};
    const type = String(update?.update_type || update?.type || '').toLowerCase();

    if (type && type !== 'message_created') return next();

    const chatId = chatIdOf(update);
    if (!chatId || String(chatId).startsWith('-')) return next();

    if (isForwarded(update)) return next();

    const text = textOf(update).trim();

    if (!text || text.startsWith('/')) return next();

    Promise.resolve()
      .then(async () => {
        const channels = await getChannels();

        console.log(`[${TAG}] private text`, JSON.stringify({
          chatId: String(chatId),
          text: text.slice(0, 80),
          channels: channels.length
        }));

        if (!channels.length) return next();

        const buttons = [];

        for (const ch of channels.slice(0, 12)) {
          buttons.push([btn(`📡 ${short(ch.title)}`, `post:q66:${ch.id}`)]);
        }

        buttons.push([btn('🌐 Все каналы', 'post:q66:all')]);
        buttons.push([btn('❌ Отмена', 'post:q66:cancel')]);

        await sendMessage(
          chatId,
          `📡 <b>Пост принят.</b> Теперь выберите канал для публикации.`,
          buttons
        );

        return res.status(200).json({ ok: true });
      })
      .catch((e) => {
        console.log(`[${TAG}] error`, e?.stack || e?.message || e);
        return next();
      });
  });

  console.log(`[${TAG}] mounted`);
}
