import { query } from './db.js';

const TAG = 'LR_CHANNEL_WATCHDOG_V57';
let running = false;

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
    CREATE TABLE IF NOT EXISTS lr_user_dialogs (
      user_id text PRIMARY KEY,
      chat_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS lr_watchdog_notice_seen_v57 (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
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
}

async function rememberDialog(update) {
  const chatId = dialogChatId(update);
  const userId = senderUserId(update);

  if (!chatId || !userId) return;

  // ВАЖНО: каналы в MAX имеют отрицательный chat_id.
  // Уведомления LinkRay можно слать только в личный диалог с пользователем.
  if (String(chatId).startsWith('-')) {
    console.log(`[${TAG}] skip channel as dialog`, safeJson({ userId: String(userId), chatId: String(chatId) }));
    return;
  }

  await ensureTables();

  await query(`
    INSERT INTO lr_user_dialogs(user_id, chat_id, updated_at)
    VALUES($1, $2, now())
    ON CONFLICT(user_id)
    DO UPDATE SET chat_id=EXCLUDED.chat_id, updated_at=now()
  `, [String(userId), String(chatId)]).catch(() => {});
}

async function latestDialog() {
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

  if (!t) {
    return { ok: false, http: 0, text: 'no_token' };
  }

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

async function sendNotice(html) {
  const d = await latestDialog();

  if (!d) {
    console.log(`[${TAG}] notice skipped: no private dialog`);
    return false;
  }

  if (String(d.chat_id || '').startsWith('-')) {
    console.log(`[${TAG}] notice blocked: channel chat target`, safeJson(d));
    return false;
  }

  let r = await sendApi(`chat_id=${encodeURIComponent(String(d.chat_id))}`, html);

  if (!r.ok && d.user_id) {
    r = await sendApi(`user_id=${encodeURIComponent(String(d.user_id))}`, html);
  }

  if (!r.ok) {
    console.log(`[${TAG}] notice failed`, safeJson({
      http: r.http,
      text: String(r.text).slice(0, 700),
      dialog: d
    }));
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

async function botAccess(maxChatId) {
  const chat = await maxGet(`/chats/${encodeURIComponent(String(maxChatId))}`);
  const member = await maxGet(`/chats/${encodeURIComponent(String(maxChatId))}/members/me`);
  const info = memberInfo(member);

  return {
    ok: chat.ok && member.ok && info.isAdmin,
    chat,
    member,
    info,
    reason: chat.ok ? (member.ok ? (info.isAdmin ? 'active_admin' : 'bot_not_admin') : `member_http_${member.http}`) : `chat_http_${chat.http}`
  };
}

async function seenOnce(key) {
  await ensureTables();

  const r = rows(await query(`
    INSERT INTO lr_watchdog_notice_seen_v57(key, created_at)
    VALUES($1, now())
    ON CONFLICT(key) DO NOTHING
    RETURNING key
  `, [String(key)]).catch(() => []));

  return !!r.length;
}

async function getChannels() {
  await ensureTables();

  return rows(await query(`
    SELECT id, max_chat_id, title, link, owner_max_user_id
    FROM channels
    WHERE max_chat_id IS NOT NULL
    ORDER BY id ASC
  `).catch(() => []));
}

async function deleteChannelFull(ch, reason) {
  const id = Number(ch.id);
  const maxChatId = String(ch.max_chat_id || '');

  if (id) {
    const tables = [
      'channel_signatures',
      'channel_saved_times',
      'lr_channel_sync_seen',
      'lr_channel_sync_seen_v56',
      'lr_channel_daily_stats',
      'lr_channel_view_snapshots',
      'lr_channel_avatar_cache'
    ];

    for (const t of tables) {
      await query(`DELETE FROM ${t} WHERE channel_id=$1`, [id]).catch(() => {});
    }

    await query(`UPDATE scheduled_posts SET channel_id=NULL WHERE channel_id=$1`, [id]).catch(() => {});
    await query(`DELETE FROM channels WHERE id=$1`, [id]).catch(() => {});
  } else if (maxChatId) {
    await query(`DELETE FROM channels WHERE max_chat_id=$1`, [maxChatId]).catch(() => {});
  }

  const key = `removed:${maxChatId}:${reason}`;
  if (await seenOnce(key)) {
    await sendNotice(
      `🗑 <b>Канал отключён от LinkRay</b>\n\n` +
      `${esc(ch.title || maxChatId)}\n\n` +
      `Причина: <b>${esc(reason)}</b>\n\n` +
      `Канал удалён из базы LinkRay, меню публикаций, аналитики, ежедневных отчётов, антифрода и рекламных закупов.`
    );
  }

  console.log(`[${TAG}] CHANNEL_REMOVED`, safeJson({
    id: ch.id,
    maxChatId,
    title: ch.title,
    reason
  }));
}

async function scanKnownChannels() {
  if (running) return;

  running = true;

  try {
    const channels = await getChannels();
    let checked = 0;
    let removed = 0;

    for (const ch of channels) {
      const maxChatId = ch.max_chat_id;
      if (!maxChatId) continue;

      checked += 1;

      const access = await botAccess(maxChatId);

      if (!access.ok) {
        removed += 1;
        await deleteChannelFull(ch, access.reason || 'bot_not_admin');
      }
    }

    if (removed) {
      console.log(`[${TAG}] scan done`, safeJson({ checked, removed }));
    }
  } catch (e) {
    console.log(`[${TAG}] scan error`, e?.stack || e?.message || e);
  } finally {
    running = false;
  }
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
    out.push({ chatId: id, title: title || null, action });
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

    const typeText = String(
      obj.update_type ||
      obj.type ||
      obj.event_type ||
      obj.action ||
      obj.status ||
      ''
    ).toLowerCase();

    const remove =
      removeRoot ||
      typeText.includes('removed') ||
      typeText.includes('left') ||
      typeText.includes('kicked') ||
      typeText.includes('delete');

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

async function upsertAddedChannel(update, ev, access) {
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
  ]).catch(() => []));

  return r[0] || { id: null, max_chat_id: String(ev.chatId), title, link };
}

async function handleWebhook(update) {
  try {
    await rememberDialog(update);

    const events = findChannelEvents(update);

    if (!events.length) return;

    console.log(`[${TAG}] webhook events`, safeJson(events));

    for (const ev of events) {
      if (ev.action === 'remove') {
        const ch = rows(await query(
          `SELECT id, max_chat_id, title, link FROM channels WHERE max_chat_id=$1 LIMIT 1`,
          [String(ev.chatId)]
        ).catch(() => []))[0] || { id: null, max_chat_id: String(ev.chatId), title: ev.title || `Канал ${ev.chatId}` };

        await deleteChannelFull(ch, 'bot_removed');
        continue;
      }

      const access = await botAccess(ev.chatId);

      if (!access.ok) {
        console.log(`[${TAG}] webhook add skipped`, safeJson({
          chatId: ev.chatId,
          title: ev.title || null,
          reason: access.reason
        }));
        continue;
      }

      const saved = await upsertAddedChannel(update, ev, access);
      const key = `added:${saved.max_chat_id}`;

      if (await seenOnce(key)) {
        await sendNotice(
          `✅ <b>Канал подключён к LinkRay</b>\n\n` +
          `${esc(saved.title || ev.title || ev.chatId)}\n\n` +
          `Канал сохранён в базе LinkRay и будет использоваться для публикаций, отложенных постов, аналитики, ежедневных отчётов, антифрода и рекламных закупов.`
        );
      }

      console.log(`[${TAG}] CHANNEL_ADDED`, safeJson(saved));
    }
  } catch (e) {
    console.log(`[${TAG}] webhook error`, e?.stack || e?.message || e);
  }
}

export function mountLinkRayChannelWatchdogV57(app) {
  app.use((req, res, next) => {
    try {
      const method = String(req?.method || '').toUpperCase();
      const url = String(req?.originalUrl || req?.url || '');

      if (method === 'POST' && url.includes('/webhook')) {
        const update = req.body || {};
        setTimeout(() => handleWebhook(update), 1).unref?.();
      }
    } catch (e) {
      console.log(`[${TAG}] middleware error`, e?.stack || e?.message || e);
    }

    next();
  });

  setTimeout(() => scanKnownChannels(), 3000).unref?.();
  setInterval(() => scanKnownChannels(), 15000).unref?.();

  console.log(`[${TAG}] mounted`);
}
