const TAG = 'LR_ADD_CHANNEL_INSTRUCTION_V65';

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
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[key];
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

function collectStrings(obj, out = [], depth = 0) {
  if (depth > 14 || obj == null) return out;

  if (typeof obj === 'string') {
    out.push(obj);
    return out;
  }

  if (Array.isArray(obj)) {
    for (const x of obj) collectStrings(x, out, depth + 1);
    return out;
  }

  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) collectStrings(v, out, depth + 1);
  }

  return out;
}

function isAddChannelCallback(update) {
  const type = String(update?.update_type || update?.type || '').toLowerCase();
  if (!type.includes('callback')) return false;

  const joined = collectStrings(update).join(' ').toLowerCase();

  return (
    joined.includes('add_channel') ||
    joined.includes('add-channel') ||
    joined.includes('channel:add') ||
    joined.includes('channels:add') ||
    joined.includes('main:add_channel') ||
    joined.includes('studio:add_channel') ||
    joined.includes('добавить канал')
  );
}

async function sendInstruction(chatId) {
  const t = token();
  if (!t || !chatId) return false;

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
    console.log(`[${TAG}] sent`, JSON.stringify({ ok: res.ok, http: res.status, body: body.slice(0, 400) }));
    return res.ok;
  } catch (e) {
    console.log(`[${TAG}] error`, e?.message || e);
    return false;
  }
}

export function mountLinkRayAddChannelInstructionV65(app) {
  app.use((req, res, next) => {
    const method = String(req?.method || '').toUpperCase();
    const url = String(req?.originalUrl || req?.url || '');

    if (!(method === 'POST' && url.includes('/webhook'))) return next();

    const update = req.body || {};

    if (!isAddChannelCallback(update)) return next();

    const chatId = chatIdOf(update);

    Promise.resolve(sendInstruction(chatId))
      .then(() => res.status(200).json({ ok: true }))
      .catch(() => res.status(200).json({ ok: true }));
  });

  console.log(`[${TAG}] mounted`);
}
