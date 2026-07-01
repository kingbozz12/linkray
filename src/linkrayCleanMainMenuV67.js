import { query } from './db.js';

const TAG = 'LR_CLEAN_MAIN_MENU_V67';

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

function updateType(update) {
  return String(update?.update_type || update?.type || '').toLowerCase();
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

function textOf(update) {
  return String(
    pick(update, ['message', 'body', 'text']) ||
    pick(update, ['message', 'text']) ||
    pick(update, ['body', 'text']) ||
    pick(update, ['text']) ||
    ''
  ).trim();
}

function callbackPayload(update) {
  const values = [
    pick(update, ['callback', 'payload']),
    pick(update, ['callback', 'data']),
    pick(update, ['callback', 'callback_data']),
    pick(update, ['callback', 'button', 'payload']),
    pick(update, ['callback', 'button', 'data']),
    pick(update, ['body', 'payload']),
    pick(update, ['payload']),
    pick(update, ['data']),
  ];

  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }

  return '';
}

function btn(text, payload) {
  return { type: 'callback', text, payload };
}

async function sendMessage(chatId, text, buttons = []) {
  const t = token();
  if (!t || !chatId || String(chatId).startsWith('-')) return false;

  const body = {
    text,
    format: 'html',
    notify: true
  };

  if (buttons.length) {
    body.attachments = [{
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
      body: JSON.stringify(body)
    });

    const txt = await res.text().catch(() => '');
    console.log(`[${TAG}] send`, JSON.stringify({
      ok: res.ok,
      http: res.status,
      text: txt.slice(0, 300)
    }));

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

function mainText() {
  return (
    `━━━━━━━━━━━━━━\n` +
    `⚡ <b>LinkRay</b>\n\n` +
    `🚀 <b>LinkRay Studio</b>\n` +
    `Создание постов, очередь публикаций и рекламные выходы.\n\n` +
    `📊 <b>Аналитика</b>\n` +
    `PNG-карточки каналов, графики, просмотры и ежедневный отчёт ПДП.\n\n` +
    `➕ <b>Добавить канал</b>\n` +
    `Подключение MAX-канала к LinkRay.\n\n` +
    `📈 <b>Отчёты</b>\n` +
    `Статистика размещений, просмотры и CPM.\n\n` +
    `🛡️ <b>Антифрод</b>\n` +
    `Проверка качества трафика и подозрительных скачков.\n\n` +
    `Выберите нужный раздел.\n` +
    `━━━━━━━━━━━━━━`
  );
}

function mainButtons() {
  return [
    [btn('🚀 LinkRay Studio', 'lr67:studio')],
    [btn('📊 Аналитика', 'main:analytics')],
    [btn('➕ Добавить канал', 'lr67:add')],
    [btn('📈 Отчёты', 'lr67:reports'), btn('🛡️ Антифрод', 'lr67:antifraud')]
  ];
}

async function showMain(chatId) {
  return sendMessage(chatId, mainText(), mainButtons());
}

async function showAdd(chatId) {
  return sendMessage(
    chatId,
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
    `━━━━━━━━━━━━━━`,
    [[btn('↩️ Главное меню', 'lr67:main')]]
  );
}

async function showStudio(chatId) {
  const channels = await getChannels();

  const text =
    `━━━━━━━━━━━━━━\n` +
    `🚀 <b>LinkRay Studio</b>\n\n` +
    `Создание постов, очередь публикаций и рекламные выходы.\n\n` +
    `📡 Подключено каналов: <b>${channels.length}</b>\n\n` +
    `Выберите действие.\n` +
    `━━━━━━━━━━━━━━`;

  const buttons = [
    [btn('📝 Создать пост', 'lr67:create_post')],
    [btn('📋 Посты', 'post:channels')],
    [btn('↩️ Главное меню', 'lr67:main')]
  ];

  return sendMessage(chatId, text, buttons);
}

async function showReports(chatId) {
  return sendMessage(
    chatId,
    `━━━━━━━━━━━━━━\n` +
    `📈 <b>Отчёты</b>\n\n` +
    `Здесь будут отчёты по рекламным размещениям, просмотрам, CPM и автоудалению.\n\n` +
    `Раздел подключён к главному меню.\n` +
    `━━━━━━━━━━━━━━`,
    [
      [btn('📊 Аналитика', 'main:analytics')],
      [btn('↩️ Главное меню', 'lr67:main')]
    ]
  );
}

async function showAntifraud(chatId) {
  return sendMessage(
    chatId,
    `━━━━━━━━━━━━━━\n` +
    `🛡️ <b>Антифрод</b>\n\n` +
    `Проверка качества трафика, подозрительных скачков просмотров и каналов с риском накрутки.\n\n` +
    `Раздел подключён к главному меню.\n` +
    `━━━━━━━━━━━━━━`,
    [
      [btn('📊 Смотреть аналитику', 'main:analytics')],
      [btn('↩️ Главное меню', 'lr67:main')]
    ]
  );
}

async function showCreatePostChannels(chatId) {
  const channels = await getChannels();

  if (!channels.length) {
    return sendMessage(
      chatId,
      `📡 <b>Каналы не подключены.</b>\n\n` +
      `Нажмите <b>➕ Добавить канал</b>, добавьте LinkRay администратором канала и перешлите любой пост из канала в личку бота.`,
      [
        [btn('➕ Добавить канал', 'lr67:add')],
        [btn('↩️ Главное меню', 'lr67:main')]
      ]
    );
  }

  const buttons = [];
  for (const ch of channels.slice(0, 12)) {
    const title = String(ch.title || `Канал ${ch.id}`);
    buttons.push([btn(`📡 ${title.length > 34 ? title.slice(0, 33) + '…' : title}`, `lr67:pick:${ch.id}`)]);
  }

  buttons.push([btn('🌐 Все каналы', 'lr67:pick:all')]);
  buttons.push([btn('↩️ Главное меню', 'lr67:main')]);

  return sendMessage(
    chatId,
    `📡 <b>Выберите канал для публикации.</b>\n\n` +
    `После выбора отправьте текст, фото, видео или пересланный пост.`,
    buttons
  );
}

async function showPicked(chatId, payload) {
  const channels = await getChannels();

  let selected = channels;

  if (payload !== 'all') {
    selected = channels.filter(c => String(c.id) === String(payload));
  }

  if (!selected.length) {
    return sendMessage(chatId, `⚠️ Канал не найден в базе.`, [[btn('↩️ Главное меню', 'lr67:main')]]);
  }

  const list = selected.map(c => `• ${esc(c.title || `Канал ${c.id}`)}`).join('\n');

  return sendMessage(
    chatId,
    `✅ <b>Канал выбран.</b>\n\n${list}\n\n` +
    `Теперь отправьте текст поста или перешлите готовый пост.`,
    [[btn('↩️ Главное меню', 'lr67:main')]]
  );
}

async function handleCallback(update, chatId, payload) {
  const p = String(payload || '').trim();

  console.log(`[${TAG}] callback`, JSON.stringify({ chatId, payload: p }));

  if (p === 'lr67:main') return showMain(chatId);
  if (p === 'lr67:add') return showAdd(chatId);
  if (p === 'lr67:studio') return showStudio(chatId);
  if (p === 'lr67:reports') return showReports(chatId);
  if (p === 'lr67:antifraud') return showAntifraud(chatId);
  if (p === 'lr67:create_post') return showCreatePostChannels(chatId);

  if (p.startsWith('lr67:pick:')) {
    return showPicked(chatId, p.replace('lr67:pick:', ''));
  }

  return false;
}

export function mountLinkRayCleanMainMenuV67(app) {
  app.use((req, res, next) => {
    const method = String(req?.method || '').toUpperCase();
    const url = String(req?.originalUrl || req?.url || '');

    if (!(method === 'POST' && url.includes('/webhook'))) return next();

    const update = req.body || {};
    const type = updateType(update);
    const chatId = chatIdOf(update);

    if (!chatId || String(chatId).startsWith('-')) return next();

    const text = textOf(update);
    const payload = callbackPayload(update);

    if (type === 'message_created' && text === '/start') {
      Promise.resolve(showMain(chatId))
        .then(() => res.status(200).json({ ok: true }))
        .catch(() => res.status(200).json({ ok: true }));
      return;
    }

    if (type.includes('callback') && String(payload || '').startsWith('lr67:')) {
      Promise.resolve(handleCallback(update, chatId, payload))
        .then(() => res.status(200).json({ ok: true }))
        .catch((e) => {
          console.log(`[${TAG}] callback error`, e?.stack || e?.message || e);
          res.status(200).json({ ok: true });
        });
      return;
    }

    next();
  });

  console.log(`[${TAG}] mounted`);
}
