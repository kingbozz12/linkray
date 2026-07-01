import { query } from './db.js';

const TAG = 'LR_QUICK_POST_TEXT_V65';

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
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[key];
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
  );
}

function isForwarded(update) {
  const raw = JSON.stringify(update || {}).toLowerCase();

  return (
    raw.includes('forward') ||
    raw.includes('forwarded') ||
    raw.includes('source_message') ||
    raw.includes('original_message') ||
    raw.includes('sender_chat') ||
    raw.includes('from_chat')
  );
}

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS lr_quick_post_text_v65 (
      id serial PRIMARY KEY,
      chat_id text NOT NULL,
      text text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(() => {});
}

async function sendMessage(chatId, text, buttons = []) {
  const t = token();
  if (!t) return false;

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

function btn(text, payload) {
  return { type: 'callback', text, payload };
}

async function getChannels() {
  const r = rows(await query(`
    SELECT id,title,link,max_chat_id
    FROM channels
    WHERE max_chat_id IS NOT NULL
    ORDER BY title ASC NULLS LAST, id ASC
    LIMIT 60
  `).catch(() => []));

  return r;
}

function shortTitle(v, n = 34) {
  const s = String(v || '').trim() || 'Канал';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function handleText(update) {
  const type = updateType(update);
  if (type && type !== 'message_created') return { stop: false };

  const chatId = chatIdOf(update);
  if (!chatId || String(chatId).startsWith('-')) return { stop: false };

  if (isForwarded(update)) return { stop: false };

  const text = textOf(update).trim();
  if (!text || text.startsWith('/')) return { stop: false };

  await ensureTables();

  const channels = await getChannels();
  if (!channels.length) return { stop: false };

  const saved = rows(await query(`
    INSERT INTO lr_quick_post_text_v65(chat_id,text,created_at)
    VALUES($1,$2,now())
    RETURNING id
  `, [String(chatId), text]).catch(() => []));

  const draftId = saved[0]?.id;
  if (!draftId) return { stop: false };

  const buttons = [];

  for (const ch of channels.slice(0, 12)) {
    buttons.push([btn(`📡 ${shortTitle(ch.title)}`, `lrq65:${draftId}:${ch.id}`)]);
  }

  buttons.push([btn('🌐 Все каналы', `lrq65:${draftId}:all`)]);
  buttons.push([btn('❌ Отмена', `lrq65:${draftId}:cancel`)]);

  await sendMessage(
    chatId,
    `📡 <b>Пост принят.</b> Теперь выберите канал для публикации.`,
    buttons
  );

  console.log(`[${TAG}] quick post menu`, JSON.stringify({ chatId, draftId, channels: channels.length }));

  return { stop: true };
}

async function handleCallback(update) {
  const raw = JSON.stringify(update || '');
  const m = raw.match(/lrq65:(\d+):(all|cancel|\d+)/);

  if (!m) return { stop: false };

  const chatId = chatIdOf(update);
  const draftId = Number(m[1]);
  const target = m[2];

  if (!chatId || !draftId) return { stop: true };

  if (target === 'cancel') {
    await query(`DELETE FROM lr_quick_post_text_v65 WHERE id=$1`, [draftId]).catch(() => {});
    await sendMessage(chatId, `❌ Создание поста отменено.`);
    return { stop: true };
  }

  const draft = rows(await query(`
    SELECT id,text
    FROM lr_quick_post_text_v65
    WHERE id=$1
    LIMIT 1
  `, [draftId]).catch(() => []))[0];

  if (!draft) {
    await sendMessage(chatId, `⚠️ Черновик не найден. Отправьте текст поста заново.`);
    return { stop: true };
  }

  const channels = target === 'all'
    ? await getChannels()
    : rows(await query(`
        SELECT id,title,link,max_chat_id
        FROM channels
        WHERE id=$1
        LIMIT 1
      `, [Number(target)]).catch(() => []));

  if (!channels.length) {
    await sendMessage(chatId, `⚠️ Канал не найден в базе. Нажмите ➕ Добавить канал и подключите его заново.`);
    return { stop: true };
  }

  await query(`DELETE FROM lr_quick_post_text_v65 WHERE id=$1`, [draftId]).catch(() => {});

  const lines = channels.slice(0, 20).map(ch => `• ${esc(ch.title || ('Канал ' + ch.id))}`).join('\n');

  await sendMessage(
    chatId,
    `✅ <b>Канал выбран.</b>\n\n${lines}\n\n` +
    `Теперь откройте редактор публикации через <b>LinkRay Studio</b> → <b>Создать пост</b>.\n\n` +
    `Текст поста принят, но для полной публикации с расписанием, автоподписью, CPM и автоудалением используйте основной редактор.`
  );

  return { stop: true };
}

export function mountLinkRayQuickPostTextV65(app) {
  app.use((req, res, next) => {
    const method = String(req?.method || '').toUpperCase();
    const url = String(req?.originalUrl || req?.url || '');

    if (!(method === 'POST' && url.includes('/webhook'))) return next();

    const update = req.body || {};

    Promise.resolve(handleCallback(update))
      .then((r) => {
        if (r?.stop) return res.status(200).json({ ok: true });
        return handleText(update);
      })
      .then((r) => {
        if (r?.stop) return res.status(200).json({ ok: true });
        return next();
      })
      .catch((e) => {
        console.log(`[${TAG}] error`, e?.stack || e?.message || e);
        return next();
      });
  });

  console.log(`[${TAG}] mounted`);
}
