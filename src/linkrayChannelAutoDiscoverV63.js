import { query } from './db.js';

const TAG = 'LR_CHANNEL_AUTODISCOVER_V63';

function rows(r) {
  return Array.isArray(r) ? r : (r?.rows || []);
}

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return '{}'; }
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

function webhookUrl() {
  return (
    process.env.MAX_WEBHOOK_URL ||
    process.env.WEBHOOK_URL ||
    'https://api.linkray.ru/webhook'
  ).trim();
}

function pick(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[p];
  }
  return cur ?? null;
}

function privateChatId(update) {
  return (
    pick(update, ['message', 'recipient', 'chat_id']) ||
    pick(update, ['message', 'chat_id']) ||
    pick(update, ['recipient', 'chat_id']) ||
    pick(update, ['chat_id']) ||
    null
  );
}

function senderUserId(update) {
  return (
    pick(update, ['message', 'sender', 'user_id']) ||
    pick(update, ['sender', 'user_id']) ||
    pick(update, ['user', 'user_id']) ||
    pick(update, ['user_id']) ||
    null
  );
}

function updateText(update) {
  return String(
    pick(update, ['message', 'body', 'text']) ||
    pick(update, ['message', 'text']) ||
    pick(update, ['body', 'text']) ||
    pick(update, ['text']) ||
    ''
  );
}

function updateType(update) {
  return String(update?.update_type || update?.type || '').toLowerCase();
}

function isNegativeId(v) {
  return /^-\d{8,}$/.test(String(v || '').trim());
}

function collectNegativeIds(obj, out = new Set(), depth = 0) {
  if (depth > 14 || obj == null) return out;

  if (typeof obj === 'string') {
    for (const m of obj.matchAll(/-\d{8,}/g)) out.add(m[0]);
    return out;
  }

  if (typeof obj === 'number') {
    if (obj < 0) out.add(String(obj));
    return out;
  }

  if (Array.isArray(obj)) {
    for (const x of obj) collectNegativeIds(x, out, depth + 1);
    return out;
  }

  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) collectNegativeIds(v, out, depth + 1);
  }

  return out;
}

function firstTitle(obj) {
  return (
    pick(obj, ['chat', 'title']) ||
    pick(obj, ['channel', 'title']) ||
    pick(obj, ['recipient', 'title']) ||
    pick(obj, ['message', 'recipient', 'title']) ||
    pick(obj, ['message', 'chat', 'title']) ||
    pick(obj, ['title']) ||
    pick(obj, ['name']) ||
    null
  );
}

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS channels (
      id serial PRIMARY KEY,
      max_chat_id text UNIQUE,
      title text,
      link text,
      is_public boolean DEFAULT false,
      is_channel boolean DEFAULT true,
      owner_max_user_id text,
      bot_added_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now()
    )
  `).catch(() => {});

  for (const sql of [
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS max_chat_id text`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS title text`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS link text`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_public boolean DEFAULT false`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_channel boolean DEFAULT true`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS owner_max_user_id text`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS bot_added_at timestamptz DEFAULT now()`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`,
    `ALTER TABLE channels ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()`
  ]) await query(sql).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS lr_user_dialogs (
      user_id text PRIMARY KEY,
      chat_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS lr_channel_notice_seen_v63 (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(() => {});
}

async function rememberPrivateDialog(update) {
  const chatId = privateChatId(update);
  const userId = senderUserId(update);

  if (!chatId || !userId) return;
  if (String(chatId).startsWith('-')) return;

  await ensureTables();

  await query(`
    INSERT INTO lr_user_dialogs(user_id, chat_id, updated_at)
    VALUES($1, $2, now())
    ON CONFLICT(user_id)
    DO UPDATE SET chat_id=EXCLUDED.chat_id, updated_at=now()
  `, [String(userId), String(chatId)]).catch(() => {});
}

async function latestPrivateDialog() {
  await ensureTables();

  const r = rows(await query(`
    SELECT user_id, chat_id
    FROM lr_user_dialogs
    WHERE chat_id IS NOT NULL
      AND chat_id NOT LIKE '-%'
    ORDER BY updated_at DESC
    LIMIT 1
  `).catch(() => []));

  return r[0] || null;
}

async function sendApi(params, html) {
  const t = token();
  if (!t) return { ok: false, http: 0, text: 'no_token' };

  try {
    const res = await fetch(`${apiBase()}/messages?${params}`, {
      method: 'POST',
      headers: {
        Authorization: t,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: html,
        format: 'html',
        notify: true
      })
    });

    const text = await res.text().catch(() => '');
    return { ok: res.ok, http: res.status, text };
  } catch (e) {
    return { ok: false, http: 0, text: e?.message || String(e) };
  }
}

async function sendPrivate(html) {
  const d = await latestPrivateDialog();

  if (!d || String(d.chat_id || '').startsWith('-')) {
    console.log(`[${TAG}] private notice skipped`, safeJson(d || {}));
    return false;
  }

  let r = await sendApi(`chat_id=${encodeURIComponent(String(d.chat_id))}`, html);

  if (!r.ok && d.user_id) {
    r = await sendApi(`user_id=${encodeURIComponent(String(d.user_id))}`, html);
  }

  if (!r.ok) {
    console.log(`[${TAG}] private notice failed`, safeJson({
      http: r.http,
      text: String(r.text || '').slice(0, 500)
    }));
    return false;
  }

  console.log(`[${TAG}] private notice sent`, safeJson(d));
  return true;
}

async function seenOnce(key) {
  await ensureTables();

  const r = rows(await query(`
    INSERT INTO lr_channel_notice_seen_v63(key, created_at)
    VALUES($1, now())
    ON CONFLICT(key) DO NOTHING
    RETURNING key
  `, [String(key)]).catch(() => []));

  return !!r.length;
}

async function maxGet(path) {
  const t = token();
  if (!t) return { ok: false, http: 0, data: null, text: 'no_token' };

  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'GET',
      headers: {
        Authorization: t,
        Accept: 'application/json'
      }
    });

    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; }
    catch { data = { raw: text }; }

    return { ok: res.ok, http: res.status, data, text };
  } catch (e) {
    return { ok: false, http: 0, data: null, text: e?.message || String(e) };
  }
}

function chatPayload(res) {
  const d = res?.data || {};
  return d.chat || d.result || d;
}

function chatTitle(res, fallback) {
  const c = chatPayload(res);
  return c.title || c.name || fallback || null;
}

function chatLink(res) {
  const c = chatPayload(res);
  return c.link || null;
}

function memberInfo(res) {
  const d = res?.data || {};
  const m = d.member || d.result || d;
  const permissions = Array.isArray(m.permissions) ? m.permissions.map(String) : [];

  const isAdmin =
    m.is_admin === true ||
    m.is_owner === true ||
    m.role === 'admin' ||
    m.role === 'administrator' ||
    m.role === 'creator' ||
    permissions.includes('write') ||
    permissions.includes('delete') ||
    permissions.includes('edit') ||
    permissions.includes('read_all_messages');

  return { isAdmin, permissions };
}

async function botAccess(chatId) {
  const chat = await maxGet(`/chats/${encodeURIComponent(String(chatId))}`);
  const member = await maxGet(`/chats/${encodeURIComponent(String(chatId))}/members/me`);
  const info = memberInfo(member);

  return {
    ok: chat.ok && member.ok && info.isAdmin,
    chat,
    member,
    info,
    reason: chat.ok ? (member.ok ? (info.isAdmin ? 'active_admin' : 'bot_not_admin') : `member_http_${member.http}`) : `chat_http_${chat.http}`
  };
}

async function upsertChannel(chatId, title, link, ownerUserId) {
  await ensureTables();

  const old = rows(await query(`
    SELECT id
    FROM channels
    WHERE max_chat_id=$1
    ORDER BY id ASC
    LIMIT 1
  `, [String(chatId)]).catch(() => []));

  if (old[0]?.id) {
    const r = rows(await query(`
      UPDATE channels
      SET title=COALESCE($2,title),
          link=COALESCE($3,link),
          is_public=$4,
          is_channel=true,
          owner_max_user_id=COALESCE($5,owner_max_user_id),
          updated_at=now()
      WHERE id=$1
      RETURNING id,max_chat_id,title,link
    `, [
      Number(old[0].id),
      title,
      link,
      !!link,
      ownerUserId ? String(ownerUserId) : null
    ]).catch(() => []));

    return r[0] || null;
  }

  const r = rows(await query(`
    INSERT INTO channels(max_chat_id,title,link,is_public,is_channel,owner_max_user_id,bot_added_at,updated_at,created_at)
    VALUES($1,$2,$3,$4,true,$5,now(),now(),now())
    RETURNING id,max_chat_id,title,link
  `, [
    String(chatId),
    title || `Канал ${chatId}`,
    link,
    !!link,
    ownerUserId ? String(ownerUserId) : null
  ]).catch(e => {
    console.log(`[${TAG}] insert failed`, e?.message || e);
    return [];
  }));

  return r[0] || null;
}

async function deleteChannel(chatId, title, reason) {
  await ensureTables();

  const old = rows(await query(`
    SELECT id,max_chat_id,title,link
    FROM channels
    WHERE max_chat_id=$1
    LIMIT 1
  `, [String(chatId)]).catch(() => []));

  const ch = old[0] || { id: null, max_chat_id: String(chatId), title: title || `Канал ${chatId}` };

  if (ch.id) {
    const id = Number(ch.id);

    for (const table of [
      'channel_signatures',
      'channel_saved_times',
      'lr_channel_daily_stats',
      'lr_channel_view_snapshots',
      'lr_channel_sync_seen',
      'lr_channel_sync_seen_v56'
    ]) {
      await query(`DELETE FROM ${table} WHERE channel_id=$1`, [id]).catch(() => {});
    }

    await query(`UPDATE scheduled_posts SET channel_id=NULL WHERE channel_id=$1`, [id]).catch(() => {});
    await query(`DELETE FROM channels WHERE id=$1`, [id]).catch(() => {});
  } else {
    await query(`DELETE FROM channels WHERE max_chat_id=$1`, [String(chatId)]).catch(() => {});
  }

  if (await seenOnce(`removed:${chatId}:${reason}`)) {
    await sendPrivate(
      `🗑 <b>Канал отключён от LinkRay</b>\n\n` +
      `${esc(ch.title || title || `Канал ${chatId}`)}\n\n` +
      `Канал удалён из базы LinkRay, меню публикаций, аналитики, ежедневных отчётов, антифрода и рекламных закупов.`
    );
  }

  console.log(`[${TAG}] CHANNEL_REMOVED`, safeJson({ chatId, title: ch.title || title, reason }));
}

async function addChannel(chatId, titleFallback, ownerUserId, source) {
  if (!isNegativeId(chatId)) return null;

  const access = await botAccess(chatId);

  if (!access.ok) {
    console.log(`[${TAG}] add skipped`, safeJson({
      chatId: String(chatId),
      source,
      reason: access.reason,
      chatHttp: access.chat?.http,
      memberHttp: access.member?.http,
      permissions: access.info?.permissions || []
    }));

    const old = rows(await query(`SELECT id,title FROM channels WHERE max_chat_id=$1 LIMIT 1`, [String(chatId)]).catch(() => []));
    if (old[0]) await deleteChannel(chatId, old[0].title, access.reason || 'bot_not_admin');

    return null;
  }

  const title = chatTitle(access.chat, titleFallback) || `Канал ${chatId}`;
  const link = chatLink(access.chat);
  const saved = await upsertChannel(chatId, title, link, ownerUserId);

  if (saved && await seenOnce(`added:${chatId}`)) {
    await sendPrivate(
      `✅ <b>Канал подключён к LinkRay</b>\n\n` +
      `${esc(saved.title || title)}\n\n` +
      `Канал сохранён в базе LinkRay и будет использоваться для публикаций, отложенных постов, аналитики, ежедневных отчётов, антифрода и рекламных закупов.`
    );
  }

  console.log(`[${TAG}] CHANNEL_ADDED`, safeJson({
    source,
    id: saved?.id || null,
    chatId: String(chatId),
    title: saved?.title || title,
    link: saved?.link || link || null
  }));

  return saved;
}

async function channelCount() {
  await ensureTables();

  const r = rows(await query(`SELECT count(*)::int AS n FROM channels`).catch(() => []));
  return Number(r[0]?.n || 0);
}

async function setSubscriptions() {
  const t = token();
  if (!t) return;

  const body = {
    url: webhookUrl(),
    update_types: [
      'message_created',
      'message_callback',
      'bot_started',
      'bot_added',
      'bot_removed',
      'chat_title_changed'
    ]
  };

  try {
    const res = await fetch(`${apiBase()}/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: t,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    });

    const text = await res.text().catch(() => '');
    console.log(`[${TAG}] subscriptions`, safeJson({ http: res.status, ok: res.ok, body, text: text.slice(0, 800) }));
  } catch (e) {
    console.log(`[${TAG}] subscriptions failed`, e?.message || e);
  }
}

async function handle(update) {
  await rememberPrivateDialog(update);

  const ids = [...collectNegativeIds(update)];
  const t = updateType(update);
  const title = firstTitle(update);
  const owner = senderUserId(update);

  console.log(`[${TAG}] webhook`, safeJson({
    type: t,
    ids,
    title: title || null,
    text: updateText(update).slice(0, 80)
  }));

  if (ids.length) {
    for (const id of ids) {
      if (t === 'bot_removed') await deleteChannel(id, title, 'bot_removed');
      else await addChannel(id, title, owner, t || 'raw_webhook');
    }

    return { stop: true };
  }

  const chatId = privateChatId(update);
  const isPrivate = chatId && !String(chatId).startsWith('-');
  const text = updateText(update).trim();

  if (isPrivate && text && !text.startsWith('/') && await channelCount() === 0) {
    await sendPrivate(
      `📡 <b>Каналы не подключены</b>\n\n` +
      `Я принял сообщение, но публиковать пока некуда.\n\n` +
      `Добавь бота админом в канал, потом отправь любой тестовый пост <b>в самом канале</b>. После этого канал появится в меню создания поста.`
    );

    return { stop: true };
  }

  return { stop: false };
}

export function mountLinkRayChannelAutoDiscoverV63(app) {
  app.use((req, res, next) => {
    const method = String(req?.method || '').toUpperCase();
    const url = String(req?.originalUrl || req?.url || '');

    if (!(method === 'POST' && url.includes('/webhook'))) return next();

    Promise.resolve()
      .then(() => handle(req.body || {}))
      .then((r) => {
        if (r?.stop) return res.status(200).json({ ok: true });
        return next();
      })
      .catch((e) => {
        console.log(`[${TAG}] error`, e?.stack || e?.message || e);
        return next();
      });
  });

  setTimeout(() => setSubscriptions(), 2000).unref?.();

  console.log(`[${TAG}] mounted`);
}
