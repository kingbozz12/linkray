import { query } from './db.js';

const TAG = 'LR_CHANNEL_LIFECYCLE_EXACT_V56';

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

function pick(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[p];
  }
  return cur ?? null;
}

function dialogChatId(update) {
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
    pick(update, ['user_id']) ||
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

  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS max_chat_id text`).catch(() => {});
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS title text`).catch(() => {});
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS link text`).catch(() => {});
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_public boolean DEFAULT false`).catch(() => {});
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_channel boolean DEFAULT true`).catch(() => {});
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS owner_max_user_id text`).catch(() => {});
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS bot_added_at timestamptz DEFAULT now()`).catch(() => {});
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`).catch(() => {});
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()`).catch(() => {});
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS channels_max_chat_id_unique_idx ON channels(max_chat_id) WHERE max_chat_id IS NOT NULL`).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS lr_user_dialogs (
      user_id text PRIMARY KEY,
      chat_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS lr_channel_lifecycle_seen_v56 (
      fingerprint text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS lr_channel_webhook_raw_v56 (
      id serial PRIMARY KEY,
      update_type text,
      user_id text,
      dialog_chat_id text,
      raw jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(() => {});
}

async function rememberDialog(update) {
  const chatId = dialogChatId(update);
  const userId = senderUserId(update);

  if (!chatId || !userId) return;

  await ensureTables();

  await query(`
    INSERT INTO lr_user_dialogs(user_id, chat_id, updated_at)
    VALUES($1, $2, now())
    ON CONFLICT(user_id)
    DO UPDATE SET chat_id=EXCLUDED.chat_id, updated_at=now()
  `, [String(userId), String(chatId)]).catch(() => {});

  console.log(`[${TAG}] remembered dialog`, safeJson({ userId: String(userId), chatId: String(chatId) }));
}

async function latestDialog() {
  await ensureTables();

  const r = rows(await query(`
    SELECT user_id, chat_id
    FROM lr_user_dialogs
    ORDER BY updated_at DESC
    LIMIT 1
  `).catch(() => []));

  return r[0] || null;
}

async function sendApi(params, html) {
  const t = token();
  if (!t) return { ok: false, http: 0, text: 'no_token' };

  const url = `${apiBase()}/messages?${params}`;

  try {
    const res = await fetch(url, {
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

async function sendNotice(html) {
  const d = await latestDialog();

  if (!d) {
    console.log(`[${TAG}] notice skipped: no dialog`);
    return false;
  }

  let r = await sendApi(`chat_id=${encodeURIComponent(String(d.chat_id))}`, html);

  if (!r.ok && d.user_id) {
    r = await sendApi(`user_id=${encodeURIComponent(String(d.user_id))}`, html);
  }

  if (!r.ok) {
    console.log(`[${TAG}] notice failed`, safeJson({ http: r.http, text: String(r.text).slice(0, 800), dialog: d }));
    return false;
  }

  console.log(`[${TAG}] notice sent`, safeJson(d));
  return true;
}

async function maxGet(path) {
  const t = token();

  if (!t) {
    return { ok: false, http: 0, data: null, text: '', reason: 'no_token' };
  }

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

    return { ok: res.ok, http: res.status, data, text, reason: null };
  } catch (e) {
    return { ok: false, http: 0, data: null, text: '', reason: e?.message || String(e) };
  }
}

function chatTitle(chat) {
  const d = chat?.data || {};
  return d.title || d.chat?.title || d.result?.title || d.name || null;
}

function chatLink(chat) {
  const d = chat?.data || {};
  return d.link || d.chat?.link || d.result?.link || null;
}

function memberInfo(member) {
  const d = member?.data || {};
  const src = d.result || d.member || d;

  const permissions = Array.isArray(src.permissions) ? src.permissions.map(String) : [];

  const isAdmin =
    src.is_admin === true ||
    src.is_owner === true ||
    src.role === 'admin' ||
    src.role === 'administrator' ||
    src.role === 'creator';

  return {
    isAdmin,
    isOwner: src.is_owner === true || src.role === 'creator',
    permissions
  };
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

function eventFingerprint(update, action, chatId) {
  const base =
    update.update_id ||
    update.timestamp ||
    pick(update, ['message', 'body', 'mid']) ||
    pick(update, ['message', 'body', 'seq']) ||
    pick(update, ['body', 'mid']) ||
    JSON.stringify(update).slice(0, 1400);

  return `${action}:${chatId}:${String(base)}`;
}

async function firstTime(update, action, chatId) {
  await ensureTables();

  const fp = eventFingerprint(update, action, chatId);

  const r = rows(await query(`
    INSERT INTO lr_channel_lifecycle_seen_v56(fingerprint, created_at)
    VALUES($1, now())
    ON CONFLICT(fingerprint) DO NOTHING
    RETURNING fingerprint
  `, [fp]).catch(() => []));

  return !!r.length;
}

function findChannelEvents(update) {
  const out = [];
  const seen = new Set();
  const raw = JSON.stringify(update || {});
  const lower = raw.toLowerCase();

  const removeRoot =
    lower.includes('removed') ||
    lower.includes('left') ||
    lower.includes('kicked') ||
    lower.includes('delete') ||
    lower.includes('bot_removed') ||
    lower.includes('chat_member_removed') ||
    lower.includes('administrator_removed');

  function add(chatId, title, action) {
    const id = String(chatId || '').trim();

    if (!/^-?\d+$/.test(id)) return;
    if (!id.startsWith('-')) return;

    const key = `${action}:${id}`;

    if (seen.has(key)) return;

    seen.add(key);
    out.push({
      chatId: id,
      title: title || null,
      action
    });
  }

  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 10) return;

    const title =
      obj.title ||
      obj.name ||
      obj.chat_title ||
      obj.channel_title ||
      obj.chat?.title ||
      obj.channel?.title ||
      obj.recipient?.title ||
      null;

    const t = String(obj.update_type || obj.type || obj.event_type || obj.action || obj.status || '').toLowerCase();

    const remove =
      removeRoot ||
      t.includes('removed') ||
      t.includes('left') ||
      t.includes('kicked') ||
      t.includes('delete');

    const action = remove ? 'remove' : 'add';

    for (const k of ['chat_id', 'chatId', 'max_chat_id', 'channel_id', 'channelId']) {
      if (obj[k] !== undefined && obj[k] !== null) add(obj[k], title, action);
    }

    if (
      obj.id !== undefined &&
      obj.id !== null &&
      (
        obj.chat_type ||
        obj.type === 'chat' ||
        obj.type === 'channel' ||
        obj.is_channel ||
        obj.title ||
        obj.name
      )
    ) {
      add(obj.id, title, action);
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  }

  walk(update);
  return out;
}

async function saveRaw(update) {
  await ensureTables();

  const raw = JSON.stringify(update || {});
  const interesting =
    raw.includes('-') ||
    raw.toLowerCase().includes('channel') ||
    raw.toLowerCase().includes('member') ||
    raw.toLowerCase().includes('admin') ||
    raw.toLowerCase().includes('chat');

  if (!interesting) return;

  await query(`
    INSERT INTO lr_channel_webhook_raw_v56(update_type, user_id, dialog_chat_id, raw)
    VALUES($1, $2, $3, $4::jsonb)
  `, [
    String(update?.update_type || update?.type || ''),
    senderUserId(update) ? String(senderUserId(update)) : null,
    dialogChatId(update) ? String(dialogChatId(update)) : null,
    JSON.stringify(update || {})
  ]).catch(() => {});
}

async function upsertChannel(update, ev, access) {
  await ensureTables();

  const owner = senderUserId(update);
  const title = chatTitle(access.chat) || ev.title || `Канал ${ev.chatId}`;
  const link = chatLink(access.chat) || null;

  const r = rows(await query(`
    INSERT INTO channels(max_chat_id, title, link, is_public, is_channel, owner_max_user_id, bot_added_at, updated_at, created_at)
    VALUES($1, $2, $3, $4, true, $5, now(), now(), now())
    ON CONFLICT(max_chat_id)
    DO UPDATE SET
      title=COALESCE(EXCLUDED.title, channels.title),
      link=COALESCE(EXCLUDED.link, channels.link),
      is_public=EXCLUDED.is_public,
      is_channel=true,
      owner_max_user_id=COALESCE(EXCLUDED.owner_max_user_id, channels.owner_max_user_id),
      bot_added_at=COALESCE(channels.bot_added_at, now()),
      updated_at=now()
    RETURNING id, max_chat_id, title, link
  `, [
    String(ev.chatId),
    title,
    link,
    !!link,
    owner ? String(owner) : null
  ]));

  return r[0] || { id: null, max_chat_id: String(ev.chatId), title, link };
}

async function deleteLinkedByChannel(chatId) {
  const existing = rows(await query(
    `SELECT id, max_chat_id, title, link FROM channels WHERE max_chat_id=$1 LIMIT 1`,
    [String(chatId)]
  ).catch(() => []));

  const ch = existing[0] || { id: null, max_chat_id: String(chatId), title: `Канал ${chatId}` };

  if (ch.id) {
    await query(`DELETE FROM channels WHERE id=$1`, [Number(ch.id)]).catch(() => {});
  } else {
    await query(`DELETE FROM channels WHERE max_chat_id=$1`, [String(chatId)]).catch(() => {});
  }

  return ch;
}

async function handleLifecycle(update) {
  await rememberDialog(update);
  await saveRaw(update);

  const events = findChannelEvents(update);

  if (!events.length) {
    return null;
  }

  console.log(`[${TAG}] events`, safeJson(events));

  for (const ev of events) {
    if (!(await firstTime(update, ev.action, ev.chatId))) continue;

    if (ev.action === 'remove') {
      const deleted = await deleteLinkedByChannel(ev.chatId);

      await sendNotice(
        `🗑 <b>Канал отключён от LinkRay</b>\n\n` +
        `${esc(deleted.title || ev.title || ev.chatId)}\n\n` +
        `Канал удалён из базы LinkRay, меню публикаций, аналитики, ежедневных отчётов, антифрода и рекламных закупов.`
      );

      console.log(`[${TAG}] removed`, safeJson(deleted));
      continue;
    }

    const access = await botAccess(ev.chatId);

    if (!access.ok) {
      console.log(`[${TAG}] add skipped`, safeJson({
        chatId: ev.chatId,
        title: ev.title || null,
        reason: access.reason,
        chatHttp: access.chat?.http,
        memberHttp: access.member?.http,
        isAdmin: access.info?.isAdmin,
        permissions: access.info?.permissions || []
      }));
      continue;
    }

    const saved = await upsertChannel(update, ev, access);

    await sendNotice(
      `✅ <b>Канал подключён к LinkRay</b>\n\n` +
      `${esc(saved.title || ev.title || ev.chatId)}\n\n` +
      `Канал сохранён в базе LinkRay и будет использоваться для публикаций, отложенных постов, аналитики, ежедневных отчётов, антифрода и рекламных закупов.`
    );

    console.log(`[${TAG}] added`, safeJson(saved));
  }

  return true;
}

export function mountLinkRayLifecycleExactV56(app) {
  app.use((req, res, next) => {
    try {
      const method = String(req?.method || '').toUpperCase();
      const url = String(req?.originalUrl || req?.url || '');

      if (method === 'POST' && url.includes('/webhook')) {
        const update = req.body || {};

        setTimeout(() => {
          handleLifecycle(update).catch(e => {
            console.log(`[${TAG}] async error`, e?.stack || e?.message || e);
          });
        }, 1).unref?.();
      }
    } catch (e) {
      console.log(`[${TAG}] middleware error`, e?.stack || e?.message || e);
    }

    next();
  });

  console.log(`[${TAG}] mounted`);
}

export async function sendLifecycleTestNoticeV56() {
  await ensureTables();

  const ok = await sendNotice(
    `✅ <b>LinkRay уведомления работают</b>\n\n` +
    `Теперь при подключении канала уведомление должно приходить сразу.`
  );

  return { ok };
}
