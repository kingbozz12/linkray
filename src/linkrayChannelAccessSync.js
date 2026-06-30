import { query } from './db.js';

const TAG = 'LR_CHANNEL_ACCESS_SYNC_V50';

let running = false;
let lastRunAt = 0;

function rows(r) {
  return Array.isArray(r) ? r : (r?.rows || []);
}

function escHtml(v) {
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
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[p];
  }
  return cur ?? null;
}

function extractDialogChatId(update) {
  return (
    pick(update, ['message', 'recipient', 'chat_id']) ||
    pick(update, ['message', 'chat_id']) ||
    pick(update, ['recipient', 'chat_id']) ||
    pick(update, ['chat_id']) ||
    null
  );
}

function extractSenderUserId(update) {
  return (
    pick(update, ['message', 'sender', 'user_id']) ||
    pick(update, ['sender', 'user_id']) ||
    pick(update, ['user_id']) ||
    null
  );
}

async function ensureMetaTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS lr_user_dialogs (
      user_id text PRIMARY KEY,
      chat_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS lr_channel_sync_log (
      id serial PRIMARY KEY,
      channel_id integer,
      max_chat_id text,
      title text,
      status text,
      action text,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function rememberDialog(update) {
  const chatId = extractDialogChatId(update);
  const userId = extractSenderUserId(update);

  if (!chatId || !userId) return;

  await ensureMetaTables();

  await query(`
    INSERT INTO lr_user_dialogs(user_id, chat_id, updated_at)
    VALUES($1, $2, now())
    ON CONFLICT(user_id)
    DO UPDATE SET chat_id=EXCLUDED.chat_id, updated_at=now()
  `, [String(userId), String(chatId)]);

  console.log(`[${TAG}] remembered dialog`, JSON.stringify({ userId: String(userId), chatId: String(chatId) }));
}

async function ownerDialogChatId(channel) {
  await ensureMetaTables();

  const owner = channel.owner_max_user_id || channel.owner_user_id || channel.created_by_max_user_id || null;
  if (!owner) return null;

  const r = rows(await query(
    `SELECT chat_id FROM lr_user_dialogs WHERE user_id=$1 LIMIT 1`,
    [String(owner)]
  ));

  return r[0]?.chat_id || null;
}

async function sendNotice(chatId, html) {
  const t = token();
  if (!t || !chatId) return false;

  const url = `${apiBase()}/messages?chat_id=${encodeURIComponent(String(chatId))}`;

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

    if (!res.ok) {
      console.log(`[${TAG}] notice send failed`, res.status, text.slice(0, 500));
      return false;
    }

    console.log(`[${TAG}] notice sent`, String(chatId));
    return true;
  } catch (e) {
    console.log(`[${TAG}] notice error`, e?.message || e);
    return false;
  }
}

async function maxGetChat(maxChatId) {
  const t = token();
  if (!t) return { ok: false, skip: true, status: 0, data: null, error: 'NO_TOKEN' };

  const url = `${apiBase()}/chats/${encodeURIComponent(String(maxChatId))}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: t,
        Accept: 'application/json'
      },
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    let data = null;
    const text = await res.text().catch(() => '');

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    return { ok: res.ok, status: res.status, data, error: null };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e?.message || String(e) };
  }
}

function statusFromChatResponse(check) {
  const d = check?.data || {};
  return String(d.status || d.chat?.status || d.result?.status || '').toLowerCase();
}

function titleFromChatResponse(check) {
  const d = check?.data || {};
  return d.title || d.chat?.title || d.result?.title || null;
}

function linkFromChatResponse(check) {
  const d = check?.data || {};
  return d.link || d.chat?.link || d.result?.link || null;
}

function isPublicFromChatResponse(check) {
  const d = check?.data || {};
  const value = d.is_public ?? d.chat?.is_public ?? d.result?.is_public;
  return typeof value === 'boolean' ? value : null;
}

function avatarFromChatResponse(check) {
  const d = check?.data || {};
  const icon = d.icon || d.chat?.icon || d.result?.icon || null;

  if (!icon || typeof icon !== 'object') return null;

  return (
    icon.url ||
    icon.image_url ||
    icon.avatar_url ||
    icon.large ||
    icon.medium ||
    icon.small ||
    icon.payload?.url ||
    null
  );
}

function accessGone(check) {
  const st = statusFromChatResponse(check);

  if (['removed', 'left', 'closed'].includes(st)) return true;
  if ([403, 404, 410].includes(Number(check.status))) return true;

  return false;
}

async function getTableColumns(table) {
  const r = rows(await query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
  `, [table]));

  return new Set(r.map(x => x.column_name));
}

async function updateChannelFreshInfo(channel, check) {
  const cols = await getTableColumns('channels');
  const sets = [];
  const params = [];

  const title = titleFromChatResponse(check);
  const link = linkFromChatResponse(check);
  const isPublic = isPublicFromChatResponse(check);
  const avatar = avatarFromChatResponse(check);

  if (title && cols.has('title')) {
    params.push(title);
    sets.push(`title=$${params.length}`);
  }

  if (link && cols.has('link')) {
    params.push(link);
    sets.push(`link=$${params.length}`);
  }

  if (typeof isPublic === 'boolean' && cols.has('is_public')) {
    params.push(isPublic);
    sets.push(`is_public=$${params.length}`);
  }

  if (avatar && cols.has('avatar_url')) {
    params.push(avatar);
    sets.push(`avatar_url=$${params.length}`);
  }

  if (cols.has('updated_at')) {
    sets.push(`updated_at=now()`);
  }

  if (!sets.length) return;

  params.push(Number(channel.id));

  await query(
    `UPDATE channels SET ${sets.join(', ')} WHERE id=$${params.length}`,
    params
  );
}

async function deleteChannelEverywhere(channel, reason) {
  const id = Number(channel.id);
  const maxChatId = channel.max_chat_id ? String(channel.max_chat_id) : '';
  const title = channel.title || channel.link || channel.max_chat_id || `Канал ${channel.id}`;

  const tables = rows(await query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public'
      AND table_type='BASE TABLE'
    ORDER BY table_name
  `));

  let total = 0;

  for (const t of tables) {
    const table = t.table_name;
    if (table === 'channels') continue;

    const cols = await getTableColumns(table);
    const cond = [];
    const params = [];

    if (Number.isFinite(id) && cols.has('channel_id')) {
      params.push(id);
      cond.push(`channel_id=$${params.length}`);
    }

    if (maxChatId && cols.has('max_chat_id')) {
      params.push(maxChatId);
      cond.push(`max_chat_id::text=$${params.length}`);
    }

    if (maxChatId && cols.has('chat_id')) {
      params.push(maxChatId);
      cond.push(`chat_id::text=$${params.length}`);
    }

    if (!cond.length) continue;

    try {
      const r = await query(
        `DELETE FROM public."${table.replaceAll('"', '""')}" WHERE ${cond.join(' OR ')}`,
        params
      );

      const n = Number(r?.rowCount || 0);
      if (n) {
        total += n;
        console.log(`[${TAG}] deleted linked`, table, n);
      }
    } catch (e) {
      console.log(`[${TAG}] delete linked skip`, table, e?.message || e);
    }
  }

  try {
    const r = await query(`DELETE FROM channels WHERE id=$1`, [id]);
    total += Number(r?.rowCount || 0);
  } catch (e) {
    console.log(`[${TAG}] delete channel error`, e?.message || e);
  }

  await ensureMetaTables();

  await query(`
    INSERT INTO lr_channel_sync_log(channel_id, max_chat_id, title, status, action, reason)
    VALUES($1, $2, $3, $4, $5, $6)
  `, [id, maxChatId || null, title, 'removed', 'deleted', reason]);

  console.log(`[${TAG}] CHANNEL_REMOVED`, JSON.stringify({
    id,
    maxChatId,
    title,
    reason,
    deletedRows: total
  }));

  return { title, deletedRows: total };
}

async function channels() {
  return rows(await query(`
    SELECT *
    FROM channels
    ORDER BY id ASC
  `));
}

async function syncChannelsAccess({ reason = 'manual', notifyChatId = null, force = false } = {}) {
  const now = Date.now();

  if (running) return { skipped: 'running' };
  if (!force && now - lastRunAt < 30000) return { skipped: 'throttle' };

  running = true;
  lastRunAt = now;

  const result = {
    checked: 0,
    removed: 0,
    skipped: 0,
    errors: 0
  };

  try {
    const list = await channels();

    for (const ch of list) {
      const maxChatId = ch.max_chat_id || ch.chat_id || ch.channel_id || null;

      if (!maxChatId) {
        result.skipped++;
        continue;
      }

      const check = await maxGetChat(maxChatId);
      result.checked++;

      console.log(`[${TAG}] check`, JSON.stringify({
        id: ch.id,
        maxChatId: String(maxChatId),
        title: ch.title || null,
        http: check.status,
        ok: check.ok,
        status: statusFromChatResponse(check),
        error: check.error || null
      }));

      if (check.skip) {
        result.skipped++;
        continue;
      }

      if (check.status === 401) {
        console.log(`[${TAG}] skip delete: token unauthorized`);
        result.errors++;
        continue;
      }

      if (accessGone(check)) {
        const deleted = await deleteChannelEverywhere(ch, reason);
        result.removed++;

        const ownerChat = notifyChatId || await ownerDialogChatId(ch);

        if (ownerChat) {
          await sendNotice(
            ownerChat,
            `🗑 <b>Канал удалён из LinkRay</b>\n\n` +
            `${escHtml(deleted.title)}\n\n` +
            `Бот больше не имеет доступа к каналу, поэтому канал удалён из базы, меню публикаций, аналитики, отчётов, антифрода и рекламных закупов.`
          );
        }

        continue;
      }

      if (check.ok) {
        await updateChannelFreshInfo(ch, check);
      }
    }

    console.log(`[${TAG}] sync done`, JSON.stringify(result));
    return result;
  } catch (e) {
    console.log(`[${TAG}] sync fatal`, e?.stack || e?.message || e);
    result.errors++;
    return result;
  } finally {
    running = false;
  }
}

export function mountLinkRayChannelAccessSync(app) {
  app.use((req, res, next) => {
    try {
      const method = String(req?.method || '').toUpperCase();
      const url = String(req?.originalUrl || req?.url || '');

      if (method === 'POST' && url.includes('/webhook')) {
        const update = req?.body || {};

        rememberDialog(update).catch(e => {
          console.log(`[${TAG}] remember dialog error`, e?.message || e);
        });

        const chatId = extractDialogChatId(update);

        setTimeout(() => {
          syncChannelsAccess({
            reason: 'webhook',
            notifyChatId: chatId || null,
            force: false
          }).catch(e => console.log(`[${TAG}] webhook sync error`, e?.message || e));
        }, 50).unref?.();
      }
    } catch (e) {
      console.log(`[${TAG}] middleware error`, e?.message || e);
    }

    next();
  });

  setInterval(() => {
    syncChannelsAccess({
      reason: 'interval',
      notifyChatId: null,
      force: false
    }).catch(e => console.log(`[${TAG}] interval sync error`, e?.message || e));
  }, 30000).unref?.();

  setTimeout(() => {
    syncChannelsAccess({
      reason: 'startup',
      notifyChatId: null,
      force: true
    }).catch(e => console.log(`[${TAG}] startup sync error`, e?.message || e));
  }, 5000).unref?.();

  console.log(`[${TAG}] mounted`);
}
