const TAG = 'LR_ADD_CHANNEL_INSTRUCTION_V66';

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
    pick(update, ['callback', 'message', 'recipient', 'chat_id']) ||
    pick(update, ['callback', 'message', 'chat_id']) ||
    pick(update, ['recipient', 'chat_id']) ||
    pick(update, ['chat_id']) ||
    null
  );
}

function actualCallbackPayload(update) {
  const values = [
    pick(update, ['callback', 'payload']),
    pick(update, ['callback', 'data']),
    pick(update, ['callback', 'callback_data']),
    pick(update, ['callback', 'button', 'payload']),
    pick(update, ['callback', 'button', 'data']),
    pick(update, ['message', 'body', 'payload']),
    pick(update, ['body', 'payload']),
    pick(update, ['payload']),
    pick(update, ['data']),
  ];

  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }

  return '';
}

function isExactAddChannel(update) {
  const type = String(update?.update_type || update?.type || '').toLowerCase();
  if (!type.includes('callback')) return false;

  const payload = actualCallbackPayload(update);
  const p = payload.toLowerCase();

  console.log(`[${TAG}] callback payload`, JSON.stringify({ payload }));

  // ВАЖНО: больше не смотрим весь текст сообщения/клавиатуры.
  // Только реальный payload нажатой кнопки.
  return (
    p === 'add_channel' ||
    p === 'channel:add' ||
    p === 'channels:add' ||
    p === 'main:add_channel' ||
    p === 'studio:add_channel' ||
    p === 'analytics:add_channel' ||
    p.includes('add_channel') ||
    p.includes('channel:add')
  );
}

async function sendInstruction(chatId) {
  const t = token();
  if (!t || !chatId || String(chatId).startsWith('-')) return false;

  const text =
    `━━━━━━━━━━━━━━\n` +
    `➕ <b>Добавить канал</b>\n\n` +
    `1. Добавьте LinkRay администратором MAX-канала.\n` +
    `2. Дайте права:\n` +
    `   • публикация сообщений\n` +
    `   • редактирование сообщений\n` +
    `   • удаление сообщений\n` +
    `   • чтение сообщений\n` +
    `   • изменение информации канала\n` +
    `3. Перешлите любой пост из этого канала сюда, в личку бота.\n\n` +
    `После пересылки LinkRay сам добавит канал в базу и покажет уведомление.\n` +
    `━━━━━━━━━━━━━━`;

  try {
    const res = await fetch(`${apiBase()}/messages?chat_id=${encodeURIComponent(String(chatId))}`, {
      method: 'POST',
      headers: {
        Authorization: t,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        format: 'html',
        notify: true
      })
    });

    const body = await res.text().catch(() => '');
    console.log(`[${TAG}] instruction sent`, JSON.stringify({
      ok: res.ok,
      http: res.status,
      body: body.slice(0, 400)
    }));

    return res.ok;
  } catch (e) {
    console.log(`[${TAG}] instruction error`, e?.message || e);
    return false;
  }
}

export function mountLinkRayAddChannelInstructionV66(app) {
  app.use((req, res, next) => {
    const method = String(req?.method || '').toUpperCase();
    const url = String(req?.originalUrl || req?.url || '');

    if (!(method === 'POST' && url.includes('/webhook'))) return next();

    const update = req.body || {};

    if (!isExactAddChannel(update)) return next();

    const chatId = chatIdOf(update);

    Promise.resolve(sendInstruction(chatId))
      .then(() => res.status(200).json({ ok: true }))
      .catch(() => res.status(200).json({ ok: true }));
  });

  console.log(`[${TAG}] mounted`);
}
