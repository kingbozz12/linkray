import fs from 'node:fs/promises';
import { query } from './db.js';

const TAG = 'LR_CHANNEL_AUTODISCOVER_V62';

let scanRunning = false;

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
    pick(update, ['user', 'user_id']) ||
    pick(update, ['sender', 'user_id']) ||
    pick(update, ['user_id']) ||
    null
  );
}

function eventChatId(update) {
  return (
    pick(update, ['chat_id']) ||
    pick(update, ['message', 'recipient', 'chat_id']) ||
    pick(update, ['message', 'chat_id']) ||
    pick(update, ['recipient', 'chat_id']) ||
    pick(update, ['chat', 'chat_id']) ||
    pick(update, ['channel', 'chat_id']) ||
    null
  );
}

function eventTitle(update) {
  return (
    pick(update, ['title']) ||
    pick(update, ['chat', 'title']) ||
    pick(update, ['channel', 'title']) ||
    pick(update, ['recipient', 'title']) ||
    pick(update, ['message', 'recipient', 'title']) ||
    pick(update, ['message', 'chat', 'title']) ||
    null
  );
}

function eventType(update) {
  return String(update?.update_type || update?.type || '').toLowerCase();
}

function isNegativeChatId(v) {
  return /^-\d+$/.test(String(v || '').trim());
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
  ]) {
    await query(sql).catch(() => {});
  }

  await query(`
    CREATE TABLE IF NOT EXISTS lr_user_dialogs (
      user_id text PRIMARY KEY,
      chat_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS lr_channel_notice_seen_v62 (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS lr_channel_seen_v62 (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(() => {});
}

async function rememberPrivateDialog(update) {
  const chatId = privateChatId(update);
  const userId = senderUserId(update);

  if (!chatId || !userId) return;

  if (String(chatId).startsWith('-')) {
    console.log(`[${TAG}] skip channel as private dialog`, safeJson({ userId, chatId }));
    return;
  }

  await ensureTables();

  await query(`
    INSERT INTO lr_user_dialogs(user_id, chat_id, updated_at)
    VALUES($1, $2, now())
    ON CONFLICT(user_id)
    DO UPDATE SET chat_id=EXCLUDED.chat_id, updated_at=now()
  `, [String(userId), String(chatId)]).catch(e => {
    console.log(`[${TAG}] remember private failed`, e?.message || e);
  });
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

async function sendPrivateNotice(html) {
  const d = await latestPrivateDialog();

  if (!d) {
    console.log(`[${TAG}] notice skipped: no private dialog`);
    return false;
  }

  if (String(d.chat_id || '').startsWith('-')) {
    console.log(`[${TAG}] notice blocked: channel target`, safeJson(d));
    return false;
  }

  let r = await sendApi(`chat_id=${encodeURIComponent(String(d.chat_id))}`, html);

  if (!r.ok && d.user_id) {
    r = await sendApi(`user_id=${encodeURIComponent(String(d.user_id))}`, html);
  }

  if (!r.ok) {
    console.log(`[${TAG}] notice failed`, safeJson({
      http: r.http,
      text: String(r.text || '').slice(0, 700),
      dialog: d
    }));
    return false;
  }

  console.log(`[${TAG}] notice sent`, safeJson(d));
  return true;
}

async function seenOnce(key) {
  await ensureTables();

  const r = rows(await query(`
    INSERT INTO lr_channel_notice_seen_v62(key, created_at)
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

function chatData(res) {
  const d = res?.data || {};
  return d.chat || d.result || d;
}

function chatTitle(res, fallback = null) {
  const c = chatData(res);
  return c.title || c.name || fallback || null;
}

function chatLink(res) {
  const c = chatData(res);
  return c.link || null;
}

function chatStatus(res) {
  const c = chatData(res);
  return c.status || null;
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
    permissions.includes('edit');

  return { isAdmin, permissions };
}

async function botAccess(chatId) {
  const chat = await maxGet(`/chats/${encodeURIComponent(String(chatId))}`);
  const member = await maxGet(`/chats/${encodeURIComponent(String(chatId))}/members/me`);
  const info = memberInfo(member);
  const status = chatStatus(chat);

  return {
    ok: chat.ok && member.ok && info.isAdmin && status !== 'removed' && status !== 'left' && status !== 'closed',
    chat,
    member,
    info,
    status,
    reason: chat.ok
      ? (member.ok ? (info.isAdmin ? `active_${status || 'unknown'}` : 'bot_not_admin') : `member_http_${member.http}`)
      : `chat_http_${chat.http}`
  };
}

async function upsertChannel(chatId, title, link, ownerUserId = null) {
  await ensureTables();

  const existing = rows(await query(`
    SELECT id
    FROM channels
    WHERE max_chat_id=$1
    ORDER BY id ASC
    LIMIT 1
  `, [String(chatId)]).catch(() => []));

  if (existing[0]?.id) {
    const r = rows(await query(`
      UPDATE channels
      SET
        title=COALESCE($2, title),
        link=COALESCE($3, link),
        is_public=$4,
        is_channel=true,
        owner_max_user_id=COALESCE($5, owner_max_user_id),
        updated_at=now()
      WHERE id=$1
      RETURNING id, max_chat_id, title, link
    `, [
      Number(existing[0].id),
      title,
      link,
      !!link,
      ownerUserId ? String(ownerUserId) : null
    ]).catch(() => []));

    return r[0] || null;
  }

  const r = rows(await query(`
    INSERT INTO channels(max_chat_id, title, link, is_public, is_channel, owner_max_user_id, bot_added_at, updated_at, created_at)
    VALUES($1, $2, $3, $4, true, $5, now(), now(), now())
    RETURNING id, max_chat_id, title, link
  `, [
    String(chatId),
    title || `Канал ${chatId}`,
    link,
    !!link,
    ownerUserId ? String(ownerUserId) : null
  ]).catch(e => {
    console.log(`[${TAG}] insert channel failed`, e?.message || e);
    return [];
  }));

  return r[0] || null;
}

async function deleteChannel(chatId, title = null, reason = 'bot_removed') {
  await ensureTables();

  const old = rows(await query(`
    SELECT id, max_chat_id, title, link
    FROM channels
    WHERE max_chat_id=$1
    ORDER BY id ASC
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
    await sendPrivateNotice(
      `🗑 <b>Канал отключён от LinkRay</b>\n\n` +
      `${esc(ch.title || title || `Канал ${chatId}`)}\n\n` +
      `Канал удалён из базы LinkRay, меню публикаций, аналитики, ежедневных отчётов, антифрода и рекламных закупов.`
    );
  }

  console.log(`[${TAG}] CHANNEL_REMOVED`, safeJson({
    chatId: String(chatId),
    title: ch.title || title,
    reason
  }));
}

async function addChannelByChatId(chatId, titleFallback = null, ownerUserId = null, source = 'unknown') {
  if (!isNegativeChatId(chatId)) return null;

  const access = await botAccess(chatId);

  if (!access.ok) {
    console.log(`[${TAG}] add skipped`, safeJson({
      chatId: String(chatId),
      titleFallback,
      reason: access.reason,
      chatHttp: access.chat?.http,
      memberHttp: access.member?.http,
      status: access.status,
      permissions: access.info?.permissions || []
    }));

    const existing = rows(await query(
      `SELECT id, title FROM channels WHERE max_chat_id=$1 LIMIT 1`,
      [String(chatId)]
    ).catch(() => []));

    if (existing[0]) {
      await deleteChannel(chatId, existing[0].title, access.reason || 'bot_not_admin');
    }

    return null;
  }

  const title = chatTitle(access.chat, titleFallback) || `Канал ${chatId}`;
  const link = chatLink(access.chat);

  const saved = await upsertChannel(chatId, title, link, ownerUserId);

  if (saved && await seenOnce(`added:${chatId}`)) {
    await sendPrivateNotice(
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

async function handleUpdate(update) {
  await rememberPrivateDialog(update);

  const t = eventType(update);
  const chatId = eventChatId(update);
  const isChannel = isNegativeChatId(chatId);
  const title = eventTitle(update);
  const owner = senderUserId(update);

  if (!isChannel) return { handled: false };

  console.log(`[${TAG}] channel update`, safeJson({
    updateType: t,
    chatId: String(chatId),
    title: title || null
  }));

  if (t === 'bot_removed') {
    await deleteChannel(chatId, title, 'bot_removed');
    return { handled: true, stop: true };
  }

  if (t === 'bot_added' || t === 'message_created' || t === 'message_edited' || !t) {
    await addChannelByChatId(chatId, title, owner, t || 'channel_webhook');
    return { handled: true, stop: true };
  }

  return { handled: true, stop: true };
}

async function scanKnownChannels() {
  if (scanRunning) return;

  scanRunning = true;

  try {
    await ensureTables();

    const channels = rows(await query(`
      SELECT id, max_chat_id, title, link
      FROM channels
      WHERE max_chat_id IS NOT NULL
      ORDER BY id ASC
    `).catch(() => []));

    let checked = 0;
    let removed = 0;

    for (const ch of channels) {
      if (!isNegativeChatId(ch.max_chat_id)) continue;

      checked += 1;

      const access = await botAccess(ch.max_chat_id);

      if (!access.ok) {
        removed += 1;
        await deleteChannel(ch.max_chat_id, ch.title, access.reason || 'bot_not_admin');
      }
    }

    if (removed) {
      console.log(`[${TAG}] scan done`, safeJson({ checked, removed }));
    }
  } catch (e) {
    console.log(`[${TAG}] scan error`, e?.stack || e?.message || e);
  } finally {
    scanRunning = false;
  }
}

export async function recoverChannelsFromFileV62(filePath = '/tmp/linkray_logs_for_recover_v62.txt') {
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');

  const ids = new Set();
  for (const m of text.matchAll(/-\d{10,}/g)) {
    ids.add(m[0]);
  }

  const out = [];

  for (const id of ids) {
    const saved = await addChannelByChatId(id, null, null, 'logs_recover');
    if (saved) out.push(saved);
  }

  console.log(`[${TAG}] recover done`, safeJson({
    candidates: ids.size,
    saved: out.length,
    channels: out.map(x => ({ id: x.id, max_chat_id: x.max_chat_id, title: x.title }))
  }));

  return out;
}

export async function setMaxSubscriptionsV62() {
  const t = token();

  if (!t) {
    console.log(`[${TAG}] subscription skipped: no token`);
    return { ok: false, error: 'no_token' };
  }

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
  let data = null;

  try { data = text ? JSON.parse(text) : null; }
  catch { data = { raw: text }; }

  const result = { ok: res.ok, http: res.status, body, data };
  console.log(`[${TAG}] subscriptions`, safeJson(result));
  return result;
}

export function mountLinkRayChannelAutoDiscoverV62(app) {
  app.use((req, res, next) => {
    const method = String(req?.method || '').toUpperCase();
    const url = String(req?.originalUrl || req?.url || '');

    if (!(method === 'POST' && url.includes('/webhook'))) {
      return next();
    }

    Promise.resolve()
      .then(() => handleUpdate(req.body || {}))
      .then((r) => {
        if (r?.stop) {
          return res.status(200).json({ ok: true });
        }

        return next();
      })
      .catch((e) => {
        console.log(`[${TAG}] webhook error`, e?.stack || e?.message || e);
        return next();
      });
  });

  setTimeout(() => scanKnownChannels(), 5000).unref?.();
  setInterval(() => scanKnownChannels(), 15000).unref?.();

  console.log(`[${TAG}] mounted`);
}
