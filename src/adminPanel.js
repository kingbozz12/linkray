import { query } from './db.js';
import { sendMaxMessage, answerCallback, callbackButton, inlineKeyboard } from './maxClient.js';

let installed = false;
let schemaReady = null;
let workerBusy = false;
let workerTimer = null;
const adminCache = new Map();

const R = (r) => Array.isArray(r) ? r : (r?.rows || []);
const S = (v, n = 1000) => String(v ?? '').trim().slice(0, n);
const N = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const F = (v) => new Intl.NumberFormat('ru-RU').format(N(v));
const H = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const D = (v) => {
  const d = v ? new Date(v) : null;
  return !d || Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const kb = (rows = []) => inlineKeyboard(rows);

function payload(u) {
  return S(u?.callback?.payload || u?.callback?.data || u?.message_callback?.payload || u?.payload || '', 500);
}
function callbackId(u) {
  return S(u?.callback?.callback_id || u?.callback?.callbackId || u?.callback?.id || u?.message_callback?.callback_id || '', 500);
}
function text(u) {
  return S(u?.message?.body?.text || u?.message?.text || u?.body?.text || u?.text || '', 100000);
}
function humans(u) {
  return [u?.callback?.user, u?.message_callback?.user, u?.user, u?.message?.sender, u?.sender, u?.body?.user]
    .filter((x) => x && typeof x === 'object');
}
function humanId(x) {
  const id = S(x?.user_id || x?.userId || x?.id || '', 100);
  const login = S(x?.username || x?.login || '', 200).toLowerCase();
  if (!/^\d+$/.test(id) || x?.is_bot === true || x?.isBot === true || login.endsWith('_bot')) return '';
  return id;
}
function userId(u) {
  for (const x of humans(u)) {
    const id = humanId(x);
    if (id) return id;
  }
  for (const x of [u?.callback?.user_id, u?.callback?.userId, u?.message_callback?.user_id, u?.user_id, u?.userId]) {
    const id = S(x, 100);
    if (/^\d+$/.test(id)) return id;
  }
  return '';
}
function userBox(u, id) {
  return humans(u).find((x) => humanId(x) === id) || {};
}
function content(u) {
  const b = u?.message?.body || u?.body?.message?.body || u?.body || u?.message || {};
  const c = {
    text: String(b?.text ?? u?.message?.text ?? u?.text ?? ''),
    format: S(b?.format || u?.message?.format || 'html', 30) || 'html',
    attachments: Array.isArray(b?.attachments) ? b.attachments : [],
    markup: Array.isArray(b?.markup) ? b.markup : [],
  };
  return c.text.trim() || c.attachments.length ? c : null;
}
function envAdmins() {
  return [...new Set([
    process.env.LR_ADMIN_MAX_IDS, process.env.ADMIN_MAX_IDS, process.env.LR_OWNER_MAX_ID,
    process.env.OWNER_MAX_ID, process.env.LR_OWNER_CHAT_ID, process.env.OWNER_CHAT_ID, process.env.ADMIN_CHAT_ID,
  ].filter(Boolean).join(',').split(/[\s,;]+/))].filter((x) => /^\d+$/.test(x));
}

async function schema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS public.lr_users (
      id bigserial PRIMARY KEY, max_user_id text NOT NULL UNIQUE, private_chat_id text, first_name text,
      last_name text, display_name text, username text, language_code text, is_blocked boolean NOT NULL DEFAULT false,
      registered_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
      updates_count bigint NOT NULL DEFAULT 1, raw_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await query(`CREATE TABLE IF NOT EXISTS public.lr_user_channels (
      user_id bigint NOT NULL REFERENCES public.lr_users(id) ON DELETE CASCADE,
      channel_id integer NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
      linked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,channel_id))`);
    await query(`CREATE TABLE IF NOT EXISTS public.lr_admins (
      max_user_id text PRIMARY KEY, role text NOT NULL DEFAULT 'admin', is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await query(`CREATE TABLE IF NOT EXISTS public.lr_admin_sessions (
      admin_user_id text PRIMARY KEY, state text NOT NULL DEFAULT 'idle', data jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await query(`CREATE TABLE IF NOT EXISTS public.lr_admin_audit (
      id bigserial PRIMARY KEY, admin_user_id text NOT NULL, action text NOT NULL, target_id text,
      details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
    await query(`CREATE TABLE IF NOT EXISTS public.lr_broadcasts (
      id bigserial PRIMARY KEY, admin_user_id text NOT NULL, status text NOT NULL DEFAULT 'draft', body jsonb NOT NULL,
      total_count integer NOT NULL DEFAULT 0, sent_count integer NOT NULL DEFAULT 0, failed_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz,
      cancelled_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`);
    await query(`CREATE TABLE IF NOT EXISTS public.lr_broadcast_recipients (
      broadcast_id bigint NOT NULL REFERENCES public.lr_broadcasts(id) ON DELETE CASCADE,
      user_id bigint NOT NULL REFERENCES public.lr_users(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text, sent_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (broadcast_id, user_id))`);
    await query(`CREATE INDEX IF NOT EXISTS lr_broadcast_queue_idx
      ON public.lr_broadcast_recipients(broadcast_id,status,next_attempt_at)`);
    for (const id of envAdmins()) {
      await query(`INSERT INTO public.lr_admins(max_user_id,role,is_active,updated_at)
        VALUES($1,'owner',true,now()) ON CONFLICT(max_user_id) DO UPDATE SET is_active=true,updated_at=now()`, [id]);
    }
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

async function audit(adminId, action, targetId = null, details = {}) {
  await query(`INSERT INTO public.lr_admin_audit(admin_user_id,action,target_id,details)
    VALUES($1,$2,$3,$4::jsonb)`, [adminId, action, targetId ? String(targetId) : null, JSON.stringify(details)]).catch(() => {});
}
async function touchUser(u, id) {
  const x = userBox(u, id);
  const first = S(x?.first_name || x?.firstName || '', 200);
  const last = S(x?.last_name || x?.lastName || '', 200);
  const name = S(x?.display_name || x?.displayName || x?.name || [first, last].filter(Boolean).join(' ') || 'Пользователь MAX', 300);
  const out = R(await query(`INSERT INTO public.lr_users(
      max_user_id,private_chat_id,first_name,last_name,display_name,last_seen_at,updates_count,raw_profile,updated_at)
    VALUES($1,$1,$2,$3,$4,now(),1,$5::jsonb,now())
    ON CONFLICT(max_user_id) DO UPDATE SET
      first_name=COALESCE(NULLIF(EXCLUDED.first_name,''),lr_users.first_name),
      last_name=COALESCE(NULLIF(EXCLUDED.last_name,''),lr_users.last_name),
      display_name=CASE WHEN EXCLUDED.display_name<>'Пользователь MAX' THEN EXCLUDED.display_name ELSE lr_users.display_name END,
      last_seen_at=now(),updates_count=lr_users.updates_count+1,updated_at=now()
    RETURNING *`, [id, first || null, last || null, name, JSON.stringify({ user_id: id, is_bot: false })]));
  return out[0] || null;
}
async function bootstrap(u, id) {
  await schema();
  await touchUser(u, id).catch(() => null);
  if (R(await query(`SELECT 1 FROM public.lr_admins WHERE is_active=true LIMIT 1`)).length) return;
  const people = R(await query(`SELECT id,max_user_id FROM public.lr_users
    WHERE COALESCE(is_blocked,false)=false AND max_user_id ~ '^\\d+$'
      AND COALESCE(raw_profile->>'is_bot','false')<>'true'
      AND LOWER(COALESCE(username,'')) NOT LIKE '%\\_bot' ESCAPE '\\'
      AND LOWER(COALESCE(display_name,'')) NOT LIKE 'linkray%'
    ORDER BY registered_at,id LIMIT 2`));
  if (people.length === 1 && String(people[0].max_user_id) === id) {
    await query(`INSERT INTO public.lr_admins(max_user_id,role,is_active)
      VALUES($1,'owner',true) ON CONFLICT(max_user_id) DO UPDATE SET role='owner',is_active=true`, [id]);
    adminCache.set(id, { ok: true, until: Date.now() + 60000 });
    await audit(id, 'admin_bootstrap');
  }
}
async function admin(id) {
  const c = adminCache.get(id);
  if (c && c.until > Date.now()) return c.ok;
  await schema();
  const ok = R(await query(`SELECT 1 FROM public.lr_admins WHERE max_user_id=$1 AND is_active=true LIMIT 1`, [id])).length > 0;
  adminCache.set(id, { ok, until: Date.now() + 60000 });
  return ok;
}
async function respond(u, id, body, rows = [], note = '') {
  const cid = callbackId(u);
  const attachments = rows.length ? kb(rows) : [];
  if (cid) {
    try {
      await answerCallback({ callbackId: cid, text: body, format: 'html', attachments, notification: note });
      return;
    } catch {}
  }
  await sendMaxMessage({ userId: id, text: body, format: 'html', attachments, purpose: 'admin_panel' });
}
async function sendAdmin(id, body, rows = []) {
  await sendMaxMessage({ userId: id, text: body, format: 'html', attachments: rows.length ? kb(rows) : [], purpose: 'admin_panel' });
}
async function setSession(id, state, data = {}) {
  await query(`INSERT INTO public.lr_admin_sessions(admin_user_id,state,data,updated_at)
    VALUES($1,$2,$3::jsonb,now()) ON CONFLICT(admin_user_id) DO UPDATE SET state=EXCLUDED.state,data=EXCLUDED.data,updated_at=now()`,
    [id, state, JSON.stringify(data)]);
}
async function session(id) {
  return R(await query(`SELECT state,data FROM public.lr_admin_sessions WHERE admin_user_id=$1 LIMIT 1`, [id]))[0] || { state: 'idle', data: {} };
}

const mainRows = () => [
  [callbackButton('🔄 Обновить', 'admin:menu')],
  [callbackButton('📣 Рассылка', 'admin:broadcasts'), callbackButton('👥 Пользователи', 'admin:users')],
  [callbackButton('📢 Каналы', 'admin:channels'), callbackButton('📜 Журнал', 'admin:logs')],
  [callbackButton('⬅️ Главное меню', 'main:menu')],
];
async function menu(u, id) {
  const s = R(await query(`SELECT
    (SELECT COUNT(*) FROM public.lr_users WHERE COALESCE(is_blocked,false)=false AND max_user_id ~ '^\\d+$')::int users,
    (SELECT COUNT(*) FROM public.lr_users WHERE registered_at>=now()-interval '1 day')::int new_users,
    (SELECT COUNT(*) FROM public.channels WHERE COALESCE(is_active,true)=true)::int channels,
    (SELECT COUNT(*) FROM public.lr_broadcasts WHERE status IN('queued','running'))::int active_broadcasts`))[0] || {};
  await respond(u, id, [
    '🛠 <b>Админ-панель LinkRay</b>', '',
    `👥 Пользователей: <b>${F(s.users)}</b>`,
    `🆕 За 24 часа: <b>+${F(s.new_users)}</b>`,
    `📢 Подключено каналов: <b>${F(s.channels)}</b>`,
    `📨 Активных рассылок: <b>${F(s.active_broadcasts)}</b>`, '', 'Выберите раздел.',
  ].join('\n'), mainRows());
}
async function broadcasts(u, id) {
  const list = R(await query(`SELECT * FROM public.lr_broadcasts ORDER BY id DESC LIMIT 8`));
  const lines = ['📣 <b>Рассылки</b>', ''];
  if (!list.length) lines.push('Рассылок ещё не было.');
  for (const x of list) lines.push(`<b>№${x.id}</b> · ${H(x.status)} · ${F(x.sent_count)}/${F(x.total_count)} · ошибок ${F(x.failed_count)}`);
  const buttons = [[callbackButton('➕ Создать рассылку', 'admin:broadcast:new')]];
  for (const x of list.slice(0, 6)) buttons.push([callbackButton(`📨 №${x.id}`, `admin:broadcast:${x.id}`)]);
  buttons.push([callbackButton('⬅️ Назад', 'admin:menu')]);
  await respond(u, id, lines.join('\n'), buttons);
}
async function startBroadcast(u, id) {
  await setSession(id, 'broadcast_wait', {});
  await audit(id, 'broadcast_draft_started');
  await respond(u, id, '📣 <b>Новая рассылка</b>\n\nОтправьте следующим сообщением текст, изображение, видео, файл или пересланное сообщение.\n\nПеред запуском появится предпросмотр.',
    [[callbackButton('❌ Отмена', 'admin:session:cancel')]]);
}
async function preview(id, c) {
  await sendMaxMessage({ userId: id, text: c.text || '', format: c.format || 'html', attachments: c.attachments || [], markup: c.markup || [], purpose: 'admin_broadcast_preview' });
  await sendAdmin(id, '👁 <b>Предпросмотр рассылки</b>\n\nПодтвердите запуск или измените сообщение.', [
    [callbackButton('✅ Начать рассылку', 'admin:broadcast:confirm')],
    [callbackButton('✏️ Изменить', 'admin:broadcast:edit')],
    [callbackButton('❌ Отмена', 'admin:session:cancel')],
  ]);
}
async function confirmBroadcast(u, id) {
  const s = await session(id);
  const c = s?.data?.content;
  if (!c) return respond(u, id, '⚠️ Черновик не найден.', [[callbackButton('⬅️ Назад', 'admin:broadcasts')]]);
  const b = R(await query(`INSERT INTO public.lr_broadcasts(admin_user_id,status,body)
    VALUES($1,'queued',$2::jsonb) RETURNING *`, [id, JSON.stringify(c)]))[0];
  await query(`INSERT INTO public.lr_broadcast_recipients(broadcast_id,user_id)
    SELECT $1,u.id FROM public.lr_users u
    WHERE COALESCE(u.is_blocked,false)=false AND u.max_user_id ~ '^\\d+$'
      AND COALESCE(u.raw_profile->>'is_bot','false')<>'true'
      AND LOWER(COALESCE(u.username,'')) NOT LIKE '%\\_bot' ESCAPE '\\'
    ON CONFLICT DO NOTHING`, [b.id]);
  const total = N(R(await query(`SELECT COUNT(*)::int count FROM public.lr_broadcast_recipients WHERE broadcast_id=$1`, [b.id]))[0]?.count);
  await query(`UPDATE public.lr_broadcasts SET total_count=$2,updated_at=now() WHERE id=$1`, [b.id, total]);
  await setSession(id, 'idle', {});
  await audit(id, 'broadcast_started', b.id, { total });
  await respond(u, id, `📤 <b>Рассылка №${b.id} запущена</b>\n\nПолучателей: <b>${F(total)}</b>\nОтправка продолжится после перезапуска бота.`, [
    [callbackButton('📊 Статус', `admin:broadcast:${b.id}`)], [callbackButton('⬅️ К рассылкам', 'admin:broadcasts')],
  ]);
  void work();
}
async function broadcastCard(u, id, bid) {
  const b = R(await query(`SELECT * FROM public.lr_broadcasts WHERE id=$1`, [bid]))[0];
  if (!b) return respond(u, id, 'Рассылка не найдена.', [[callbackButton('⬅️ Назад', 'admin:broadcasts')]]);
  const buttons = [[callbackButton('🔄 Обновить', `admin:broadcast:${bid}`)]];
  if (['queued', 'running'].includes(b.status)) buttons.push([callbackButton('⛔ Остановить', `admin:broadcast:cancel:${bid}`)]);
  buttons.push([callbackButton('⬅️ Назад', 'admin:broadcasts')]);
  await respond(u, id, `📨 <b>Рассылка №${b.id}</b>\n\nСтатус: <b>${H(b.status)}</b>\nПолучателей: <b>${F(b.total_count)}</b>\nОтправлено: <b>${F(b.sent_count)}</b>\nОшибок: <b>${F(b.failed_count)}</b>\nСоздана: <b>${D(b.created_at)}</b>`, buttons);
}
async function cancelBroadcast(u, id, bid) {
  await query(`UPDATE public.lr_broadcasts SET status='cancelled',cancelled_at=now(),updated_at=now()
    WHERE id=$1 AND status IN('queued','running')`, [bid]);
  await query(`UPDATE public.lr_broadcast_recipients SET status='cancelled',updated_at=now()
    WHERE broadcast_id=$1 AND status='pending'`, [bid]);
  await audit(id, 'broadcast_cancelled', bid);
  await broadcastCard(u, id, bid);
}
async function users(u, id) {
  const list = R(await query(`SELECT u.id,u.display_name,u.registered_at,u.last_seen_at,u.is_blocked,
    COUNT(DISTINCT uc.channel_id)::int channels FROM public.lr_users u
    LEFT JOIN public.lr_user_channels uc ON uc.user_id=u.id
    WHERE u.max_user_id ~ '^\\d+$' AND COALESCE(u.raw_profile->>'is_bot','false')<>'true'
    GROUP BY u.id ORDER BY u.id DESC LIMIT 15`));
  const lines = ['👥 <b>Последние пользователи</b>', ''];
  for (const x of list) lines.push(`${x.is_blocked ? '🔴' : '🟢'} <b>LR-${String(x.id).padStart(6, '0')}</b> — ${H(x.display_name || 'Пользователь MAX')} · каналов ${F(x.channels)} · ${D(x.last_seen_at)}`);
  if (!list.length) lines.push('Пользователей пока нет.');
  await respond(u, id, lines.join('\n'), [[callbackButton('⬅️ Назад', 'admin:menu')]]);
}
/* LR_ADMIN_CLICKABLE_CHANNELS_V2 */
async function channels(u, id) {
  const escapeText = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const escapeAttribute = (value) =>
    escapeText(value)
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const normalizeChannelLink = (value) => {
    let link = S(value, 2000);

    if (!link) return '';

    if (
      /^(?:max\.ru|www\.max\.ru|i\.oneme\.ru)\//i
        .test(link)
    ) {
      link = `https://${link}`;
    }

    if (
      /^http:\/\/(?:www\.)?max\.ru\//i.test(link)
    ) {
      link = link.replace(/^http:/i, 'https:');
    }

    const allowed =
      /^https:\/\/(?:[a-z0-9-]+\.)?max\.ru\//i
        .test(link) ||
      /^https:\/\/i\.oneme\.ru\//i.test(link);

    return allowed ? link : '';
  };

  const apiToken = S(
    process.env.MAX_TOKEN ||
    process.env.MAX_BOT_TOKEN ||
    process.env.MAX_ACCESS_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.ACCESS_TOKEN ||
    '',
    4000
  );

  const apiBase = String(
    process.env.MAX_API_BASE ||
    process.env.MAX_API_BASE_URL ||
    process.env.MAX_PLATFORM_API ||
    'https://platform-api2.max.ru'
  ).replace(/\/+$/, '');

  async function restoreChannelLink(channel) {
    const storedLink = normalizeChannelLink(
      channel?.link
    );

    if (storedLink) {
      return storedLink;
    }

    const maxChatId = S(
      channel?.max_chat_id,
      100
    );

    if (
      !apiToken ||
      !/^-?\d+$/.test(maxChatId)
    ) {
      return '';
    }

    try {
      const response = await fetch(
        `${apiBase}/chats/${
          encodeURIComponent(maxChatId)
        }`,
        {
          method: 'GET',
          headers: {
            Authorization: apiToken,
          },
        }
      );

      if (!response.ok) {
        console.error(
          '[LR admin channel link]',
          JSON.stringify({
            channelId: channel?.id,
            maxChatId,
            status: response.status,
          })
        );

        return '';
      }

      const data = await response.json();

      const chat =
        data?.chat ||
        data?.result?.chat ||
        data?.result ||
        data ||
        {};

      const fetchedLink = normalizeChannelLink(
        chat?.link ||
        chat?.invite_link ||
        chat?.inviteLink ||
        chat?.public_link ||
        chat?.publicLink ||
        chat?.chat?.link ||
        ''
      );

      if (!fetchedLink) {
        return '';
      }

      await query(`
        UPDATE public.channels
        SET
          link=$2,
          updated_at=now()
        WHERE id=$1
      `, [
        channel.id,
        fetchedLink,
      ]).catch((error) => {
        console.error(
          '[LR admin save channel link]',
          error?.message || error
        );
      });

      return fetchedLink;
    } catch (error) {
      console.error(
        '[LR admin fetch channel link]',
        error?.message || error
      );

      return '';
    }
  }

  const list = R(await query(`
    SELECT
      c.id,
      c.max_chat_id,
      c.title,
      c.link,

      owner.display_name AS owner_name,
      owner.max_user_id AS owner_max_user_id

    FROM public.channels c

    LEFT JOIN LATERAL (
      SELECT
        u.display_name,
        u.max_user_id

      FROM public.lr_users u

      WHERE
        u.max_user_id::text =
          c.owner_max_user_id::text

        OR EXISTS (
          SELECT 1
          FROM public.lr_user_channels uc
          WHERE uc.user_id=u.id
            AND uc.channel_id=c.id
        )

      ORDER BY
        CASE
          WHEN u.max_user_id::text =
               c.owner_max_user_id::text
          THEN 0
          ELSE 1
        END,
        u.id

      LIMIT 1
    ) owner ON true

    WHERE COALESCE(c.is_active, true)=true

    ORDER BY
      c.id DESC

    LIMIT 15
  `));

  const lines = [
    '📢 <b>Последние подключённые каналы</b>',
    '',
  ];

  for (const channel of list) {
    const title = escapeText(
      channel.title ||
      `Канал №${channel.id}`
    );

    const channelLink =
      await restoreChannelLink(channel);

    const channelText = channelLink
      ? `<a href="${escapeAttribute(
          channelLink
        )}"><b>${title}</b></a>`
      : `<b>${title}</b>`;

    const ownerName = escapeText(
      channel.owner_name ||
      'не определён'
    );

    const ownerId = S(
      channel.owner_max_user_id,
      100
    );

    const ownerText =
      /^\d+$/.test(ownerId)
        ? `<a href="max://user/${ownerId}">` +
          `${ownerName}</a>`
        : ownerName;

    lines.push(
      `• ${channelText}\n` +
      `  Владелец: ${ownerText}`
    );
  }

  if (!list.length) {
    lines.push('Каналов пока нет.');
  }

  await respond(
    u,
    id,
    lines.join('\n'),
    [[
      callbackButton(
        '⬅️ Назад',
        'admin:menu'
      )
    ]]
  );
}

async function logs(u, id) {
  const list = R(await query(`SELECT * FROM public.lr_admin_audit ORDER BY id DESC LIMIT 15`));
  const lines = ['📜 <b>Журнал действий</b>', ''];
  for (const x of list) lines.push(`${D(x.created_at)} — <b>${H(x.action)}</b>${x.target_id ? ` · ${H(x.target_id)}` : ''}`);
  if (!list.length) lines.push('Действий пока нет.');
  await respond(u, id, lines.join('\n'), [[callbackButton('🔄 Обновить', 'admin:logs')], [callbackButton('⬅️ Назад', 'admin:menu')]]);
}

async function handleAction(u, id, p) {
  if (p === 'admin:menu') return menu(u, id);
  if (p === 'admin:broadcasts') return broadcasts(u, id);
  if (p === 'admin:broadcast:new') return startBroadcast(u, id);
  if (p === 'admin:broadcast:edit') { await setSession(id, 'broadcast_wait', {}); return respond(u, id, '✏️ Отправьте новый материал.', [[callbackButton('❌ Отмена', 'admin:session:cancel')]]); }
  if (p === 'admin:broadcast:confirm') return confirmBroadcast(u, id);
  if (p === 'admin:session:cancel') { await setSession(id, 'idle', {}); return menu(u, id); }
  if (p === 'admin:users') return users(u, id);
  if (p === 'admin:channels') return channels(u, id);
  if (p === 'admin:logs') return logs(u, id);
  let m = p.match(/^admin:broadcast:(\d+)$/);
  if (m) return broadcastCard(u, id, Number(m[1]));
  m = p.match(/^admin:broadcast:cancel:(\d+)$/);
  if (m) return cancelBroadcast(u, id, Number(m[1]));
  return menu(u, id);
}

async function recount(bid) {
  const c = R(await query(`SELECT COUNT(*)::int total,
    COUNT(*) FILTER(WHERE status='sent')::int sent,
    COUNT(*) FILTER(WHERE status='failed')::int failed,
    COUNT(*) FILTER(WHERE status IN('pending','sending'))::int left
    FROM public.lr_broadcast_recipients WHERE broadcast_id=$1`, [bid]))[0] || {};
  await query(`UPDATE public.lr_broadcasts SET total_count=$2,sent_count=$3,failed_count=$4,
    status=CASE WHEN status='cancelled' THEN status WHEN $5=0 THEN 'completed' ELSE 'running' END,
    completed_at=CASE WHEN status<>'cancelled' AND $5=0 THEN COALESCE(completed_at,now()) ELSE completed_at END,
    updated_at=now() WHERE id=$1`, [bid, N(c.total), N(c.sent), N(c.failed), N(c.left)]);
}
async function work() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    await schema();
    const b = R(await query(`SELECT * FROM public.lr_broadcasts WHERE status IN('queued','running') ORDER BY id LIMIT 1`))[0];
    if (!b) return;
    await query(`UPDATE public.lr_broadcasts SET status='running',started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1`, [b.id]);
    const rec = R(await query(`SELECT r.user_id,r.attempts,u.max_user_id FROM public.lr_broadcast_recipients r
      JOIN public.lr_users u ON u.id=r.user_id WHERE r.broadcast_id=$1 AND r.status='pending'
      AND r.next_attempt_at<=now() AND COALESCE(u.is_blocked,false)=false ORDER BY r.user_id LIMIT 8`, [b.id]));
    if (!rec.length) { await recount(b.id); return; }
    for (const x of rec) {
      const status = R(await query(`SELECT status FROM public.lr_broadcasts WHERE id=$1`, [b.id]))[0]?.status;
      if (status === 'cancelled') break;
      await query(`UPDATE public.lr_broadcast_recipients SET status='sending',updated_at=now() WHERE broadcast_id=$1 AND user_id=$2`, [b.id, x.user_id]);
      try {
        const c = b.body || {};
        await sendMaxMessage({ userId: String(x.max_user_id), text: c.text || '', format: c.format || 'html', attachments: c.attachments || [], markup: c.markup || [], purpose: `admin_broadcast_${b.id}` });
        await query(`UPDATE public.lr_broadcast_recipients SET status='sent',attempts=attempts+1,sent_at=now(),last_error=NULL,updated_at=now()
          WHERE broadcast_id=$1 AND user_id=$2`, [b.id, x.user_id]);
      } catch (e) {
        const tries = N(x.attempts) + 1;
        await query(`UPDATE public.lr_broadcast_recipients SET status=$3,attempts=$4,
          next_attempt_at=now()+($5*interval '1 minute'),last_error=$6,updated_at=now()
          WHERE broadcast_id=$1 AND user_id=$2`, [b.id, x.user_id, tries >= 3 ? 'failed' : 'pending', tries, Math.max(1, tries), S(e?.message || e, 2000)]);
      }
      await sleep(500);
    }
    await recount(b.id);
  } catch (e) {
    console.error('[LR admin worker]', e?.stack || e?.message || e);
  } finally {
    workerBusy = false;
  }
}
function startWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => void work(), 1500);
  workerTimer.unref?.();
  void work();
}

export function installLinkRayAdminPanel(app) {
  if (installed) return;
  installed = true;
  if (!app?.use) throw new Error('Express app is required');
  void schema().then(startWorker).catch((e) => console.error('[LR admin schema]', e?.message || e));
  app.use(async function linkRayAdminPanel(req, res, next) {
    try {
      if (req.method !== 'POST') return next();
      const u = req.body || {};
      const id = userId(u);
      if (!id) return next();
      const p = payload(u);
      const cmd = /^\/admin(?:\s|$)/i.test(text(u));
      const action = p.startsWith('admin:');
      let allowed = await admin(id);
      if (!allowed && cmd) { await bootstrap(u, id); allowed = await admin(id); }
      if (!allowed) {
        if (action && callbackId(u)) {
          await answerCallback({ callbackId: callbackId(u), notification: 'Недоступно' }).catch(() => {});
          return res.json({ ok: true });
        }
        return next();
      }
      await touchUser(u, id).catch(() => null);
      if (cmd) { await setSession(id, 'idle', {}); await audit(id, 'admin_opened'); await menu(u, id); return res.json({ ok: true }); }
      if (action) { await handleAction(u, id, p); return res.json({ ok: true }); }
      const s = await session(id);
      if (s.state === 'broadcast_wait') {
        const c = content(u);
        if (c) { await setSession(id, 'broadcast_preview', { content: c }); await audit(id, 'broadcast_draft_received'); await preview(id, c); return res.json({ ok: true }); }
      }
      return next();
    } catch (e) {
      console.error('[LR admin middleware]', e?.stack || e?.message || e);
      return next();
    }
  });
}
