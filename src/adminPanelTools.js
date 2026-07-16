/* LR_ADMIN_TOOLS_USERS_DYNAMIC_VIEW_V2 */
/* LR_ADMIN_TOOLS_USERS_VIEW_FINAL_V1 */
/* LR_ADMIN_TOOLS_VERIFIED_USERS_VIEW_STAGE1_2 */
/* LR_SUPPORT_CENTER_INSTALL_V1 */
/* LR_ADMIN_BROADCAST_CANCEL_FULL_MENU_V1 */
/* LR_ADMIN_SEARCH_WAIT_GATE_FIX_V1 */
import { adminOperationsMainRows, handleAdminOperationsAction, handleAdminOperationsMessage } from './adminOperationsCenter.js';
/* LR_ADMIN_CHANNEL_LOG_TITLE_V5 */
/* LR_ADMIN_IDENTITY_AND_AUDIT_FIX_V4 */
import { installUserSupportCenter, addSupportAdminMenuRow } from './supportCenter.js';
import { query } from './db.js';
import {
  sendMaxMessage,
  answerCallback,
  callbackButton,
  inlineKeyboard,
} from './maxClient.js';
import {
  ensureTeamAccessSchema,
  syncChannelTeams,
} from './channelTeamAccess.js';

let installed = false;

const rows = (result) =>
  Array.isArray(result) ? result : (result?.rows || []);

const clean = (value, max = 1000) =>
  String(value ?? '').trim().slice(0, max);

const num = (value) =>
  Number.isFinite(Number(value)) ? Number(value) : 0;

const fmt = (value) =>
  new Intl.NumberFormat('ru-RU').format(num(value));

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function payload(update) {
  return clean(
    update?.callback?.payload ||
      update?.callback?.data ||
      update?.message_callback?.payload ||
      update?.payload ||
      '',
    500,
  );
}

function callbackId(update) {
  return clean(
    update?.callback?.callback_id ||
      update?.callback?.callbackId ||
      update?.callback?.id ||
      update?.message_callback?.callback_id ||
      '',
    500,
  );
}

function messageText(update) {
  return clean(
    update?.message?.body?.text ||
      update?.message?.text ||
      update?.body?.text ||
      update?.text ||
      '',
    100000,
  );
}

function humans(update) {
  return [
    update?.callback?.user,
    update?.message_callback?.user,
    update?.user,
    update?.message?.sender,
    update?.sender,
    update?.body?.user,
  ].filter((value) => value && typeof value === 'object');
}

function humanId(value) {
  const id = clean(
    value?.user_id || value?.userId || value?.id || '',
    100,
  );
  const username = clean(
    value?.username || value?.login || '',
    200,
  ).toLowerCase();

  if (
    !/^\d+$/.test(id) ||
    value?.is_bot === true ||
    value?.isBot === true ||
    username.endsWith('_bot')
  ) {
    return '';
  }

  return id;
}

function userId(update) {
  for (const person of humans(update)) {
    const id = humanId(person);
    if (id) return id;
  }

  for (const value of [
    update?.callback?.user_id,
    update?.callback?.userId,
    update?.message_callback?.user_id,
    update?.user_id,
    update?.userId,
  ]) {
    const id = clean(value, 100);
    if (/^\d+$/.test(id)) return id;
  }

  return '';
}

function content(update) {
  const body =
    update?.message?.body ||
    update?.body?.message?.body ||
    update?.body ||
    update?.message ||
    {};

  const result = {
    text: String(body?.text ?? update?.message?.text ?? update?.text ?? ''),
    format: clean(body?.format || update?.message?.format || 'html', 30) || 'html',
    attachments: Array.isArray(body?.attachments) ? body.attachments : [],
    markup: Array.isArray(body?.markup) ? body.markup : [],
  };

  return result.text.trim() || result.attachments.length ? result : null;
}

async function safe(sql, params = []) {
  try {
    return rows(await query(sql, params));
  } catch (error) {
    console.error('[admin tools sql]', error?.message || error);
    return [];
  }
}

async function tableExists(tableName) {
  const result = await safe('SELECT to_regclass($1) AS name', [
    `public.${tableName}`,
  ]);
  return Boolean(result[0]?.name);
}

async function isAdmin(maxUserId) {
  const result = await safe(
    `SELECT 1 FROM public.lr_admins
     WHERE max_user_id=$1 AND is_active=true LIMIT 1`,
    [String(maxUserId)],
  );
  return result.length > 0;
}

async function audit(adminId, action, targetId = null, details = {}) {
  await query(
    `INSERT INTO public.lr_admin_audit(
       admin_user_id, action, target_id, details
     ) VALUES($1,$2,$3,$4::jsonb)`,
    [
      String(adminId),
      String(action),
      targetId === null ? null : String(targetId),
      JSON.stringify(details),
    ],
  ).catch(() => {});
}

async function getSession(adminId) {
  return (
    await safe(
      `SELECT state,data FROM public.lr_admin_sessions
       WHERE admin_user_id=$1 LIMIT 1`,
      [String(adminId)],
    )
  )[0] || { state: 'idle', data: {} };
}

async function setSession(adminId, state, data = {}) {
  await query(
    `INSERT INTO public.lr_admin_sessions(
       admin_user_id,state,data,updated_at
     ) VALUES($1,$2,$3::jsonb,now())
     ON CONFLICT(admin_user_id) DO UPDATE SET
       state=EXCLUDED.state,
       data=EXCLUDED.data,
       updated_at=now()`,
    [String(adminId), String(state), JSON.stringify(data)],
  );
}

async function respond(update, user, body, buttonRows = [], note = '') {
  const id = callbackId(update);
  const attachments = buttonRows.length ? inlineKeyboard(buttonRows) : [];

  if (id) {
    try {
      await answerCallback({
        callbackId: id,
        text: body,
        format: 'html',
        attachments,
        notification: note,
      });
      return;
    } catch {}
  }

  await sendMaxMessage({
    userId: String(user),
    text: body,
    format: 'html',
    attachments,
    purpose: 'admin_panel_tools',
  });
}

function profileCode(user) {
  return `LR-${String(user?.profile_number || user?.id || 0).padStart(6, '0')}`;
}

function short(value, max = 24) {
  const text = clean(value || 'Без имени', 300);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function mention(maxUserId, name) {
  const id = clean(maxUserId, 100);
  const title = esc(name || 'Без имени');

  return /^\d+$/.test(id)
    ? `<a href="max://user/${id}">${title}</a>`
    : `<b>${title}</b>`;
}

function normalizeChannelLink(value) {
  let link = clean(value, 2000);
  if (!link) return '';

  if (/^(?:max\.ru|www\.max\.ru|i\.oneme\.ru)\//i.test(link)) {
    link = `https://${link}`;
  }

  if (/^http:\/\/(?:www\.)?max\.ru\//i.test(link)) {
    link = link.replace(/^http:/i, 'https:');
  }

  return /^https:\/\/(?:[a-z0-9-]+\.)?max\.ru\//i.test(link) ||
    /^https:\/\/i\.oneme\.ru\//i.test(link)
    ? link
    : '';
}

function channelTitle(channel) {
  const title = esc(
    channel?.title ||
    `Канал №${channel?.id || '—'}`,
  );

  const link =
    normalizeChannelLink(
      channel?.link,
    );

  return link
    ? `<a href="${link}">${title}</a>`
    : `<b>${title}</b>`;
}

async function dashboardStats() {
  const base = (
    await safe(`
      SELECT
        (SELECT COUNT(*) FROM public.lr_admin_users
          WHERE COALESCE(is_blocked,false)=false
            AND max_user_id ~ '^\\d+$'
            AND LOWER(COALESCE(display_name,''))<>'пользователь max'
        )::integer AS users,
        (SELECT COUNT(*) FROM public.lr_admin_users
          WHERE COALESCE(is_blocked,false)=false
            AND last_seen_at>=now()-interval '24 hours'
        )::integer AS active_today,
        (SELECT COUNT(*) FROM public.channels
          WHERE COALESCE(is_active,true)=true
        )::integer AS channels,
        (SELECT COUNT(*) FROM public.lr_broadcasts
          WHERE status IN('queued','running')
        )::integer AS broadcasts
    `)
  )[0] || {};

  let scheduled = 0;
  let failed = 0;
  if (await tableExists('scheduled_posts')) {
    const postStats = (
      await safe(`
        SELECT
          COUNT(*) FILTER (
            WHERE status::text IN ('scheduled','pending','queued','publishing')
          )::integer AS scheduled,
          COUNT(*) FILTER (
            WHERE status::text IN ('failed','error')
          )::integer AS failed
        FROM public.scheduled_posts
      `)
    )[0] || {};
    scheduled = num(postStats.scheduled);
    failed = num(postStats.failed);
  }

  let paid = 0;
  if (
    (await tableExists('lr_user_subscriptions')) &&
    (await tableExists('lr_tariffs'))
  ) {
    paid = num(
      (
        await safe(`
          SELECT COUNT(*)::integer AS value
          FROM public.lr_user_subscriptions subscription
          JOIN public.lr_tariffs tariff
            ON tariff.code=subscription.tariff_code
          WHERE subscription.status='active'
            AND COALESCE(tariff.is_free,false)=false
            AND (
              subscription.expires_at IS NULL
              OR subscription.expires_at>now()
            )
        `)
      )[0]?.value,
    );
  }

  return {
    users: num(base.users),
    activeToday: num(base.active_today),
    channels: num(base.channels),
    broadcasts: num(base.broadcasts),
    scheduled,
    failed,
    paid,
  };
}

async function showMenu(update, adminId) {
  const stats =
    await dashboardStats();

  await respond(
    update,
    adminId,
    [
      '🛠 <b>Админ-панель LinkRay</b>',
      '',
      `👥 Пользователей: <b>${fmt(stats.users)}</b>`,
      `🟢 Активны за сутки: <b>${fmt(stats.activeToday)}</b>`,
      `📢 Подключено каналов: <b>${fmt(stats.channels)}</b>`,
      '',
      `⏳ Запланировано постов: <b>${fmt(stats.scheduled)}</b>`,
      `❌ Ошибок публикации: <b>${fmt(stats.failed)}</b>`,
      `📨 Активных рассылок: <b>${fmt(stats.broadcasts)}</b>`,
      `💎 Платных подписок: <b>${fmt(stats.paid)}</b>`,
      '',
      'Выберите нужный раздел.',
    ].join('\n'),
    addSupportAdminMenuRow(adminOperationsMainRows()),
  );
}

async function loadUser(userDbId) {
  const user = (
    await safe(
      `SELECT * FROM public.lr_admin_users WHERE id=$1 LIMIT 1`,
      [Number(userDbId)],
    )
  )[0];

  if (!user) return null;

  const channels = await safe(
    `SELECT c.id,c.title,c.link,uc.role,uc.access_source,uc.last_verified_at
     FROM public.lr_user_channels uc
     JOIN public.channels c ON c.id=uc.channel_id
     WHERE uc.user_id=$1 AND COALESCE(c.is_active,true)=true
     ORDER BY c.title`,
    [Number(userDbId)],
  );

  let subscription = null;
  if (
    (await tableExists('lr_user_subscriptions')) &&
    (await tableExists('lr_tariffs'))
  ) {
    subscription = (
      await safe(
        `SELECT s.*,t.title AS tariff_title,t.is_free
         FROM public.lr_user_subscriptions s
         LEFT JOIN public.lr_tariffs t ON t.code=s.tariff_code
         WHERE s.user_id=$1 AND s.status='active'
           AND (s.expires_at IS NULL OR s.expires_at>now())
         ORDER BY s.id DESC LIMIT 1`,
        [Number(userDbId)],
      )
    )[0] || null;
  }

  return { ...user, channels, subscription };
}

async function showUsers(update, adminId) {
  const list = await safe(`
    SELECT
      u.id,u.profile_number,u.max_user_id,u.display_name,
      u.last_seen_at,u.is_blocked,
      COUNT(DISTINCT uc.channel_id)::integer AS channels
    FROM public.lr_admin_users u
    LEFT JOIN public.lr_user_channels uc ON uc.user_id=u.id
    WHERE u.max_user_id ~ '^\\d+$'
      AND COALESCE(u.raw_profile->>'is_bot','false')<>'true'
      AND LOWER(COALESCE(u.display_name,''))<>'пользователь max'
    GROUP BY u.id,u.profile_number,u.max_user_id,u.display_name,
             u.last_seen_at,u.is_blocked
    ORDER BY COALESCE(u.profile_number,u.id) DESC
    LIMIT 20
  `);

  const buttons = list.map((user) => [
    callbackButton(
      `${user.is_blocked ? '🔴' : '🟢'} ${profileCode(user)} · ${short(
        user.display_name,
        18,
      )} · ${fmt(user.channels)} кан.`,
      `admin:tool:user:${user.id}`,
    ),
  ]);
  buttons.push([callbackButton('⬅️ Назад', 'admin:menu')]);

  await respond(
    update,
    adminId,
    [
      '👥 <b>Пользователи LinkRay</b>',
      '',
      `Показано: <b>${fmt(list.length)}</b>`,
      '',
      list.length ? 'Выберите пользователя.' : 'Пользователей пока нет.',
    ].join('\n'),
    buttons,
  );
}

async function showUserCard(update, adminId, userDbId) {
  const user = await loadUser(userDbId);
  if (!user) return showUsers(update, adminId);

  const tariff = user.subscription?.tariff_title || 'Бесплатный';
  const access = user.subscription?.expires_at
    ? `до ${formatDate(user.subscription.expires_at)}`
    : 'без ограничений';

  await respond(
    update,
    adminId,
    [
      `👤 <b>${profileCode(user)}</b>`,
      '',
      `Имя: ${mention(user.max_user_id, user.display_name)}`,
      `MAX ID: <code>${esc(user.max_user_id)}</code>`,
      `Статус: <b>${user.is_blocked ? 'заблокирован' : 'активен'}</b>`,
      '',
      `Тариф: <b>${esc(tariff)}</b>`,
      `Доступ: <b>${esc(access)}</b>`,
      `Подключено каналов: <b>${fmt(user.channels.length)}</b>`,
      '',
      `Регистрация: ${formatDate(user.registered_at)}`,
      `Последняя активность: ${formatDate(user.last_seen_at)}`,
    ].join('\n'),
    [
      [
        callbackButton('✉️ Написать', `admin:tool:user:${user.id}:message`),
        callbackButton('📢 Каналы', `admin:tool:user:${user.id}:channels`),
      ],
      [
        callbackButton(
          user.is_blocked ? '✅ Разблокировать' : '🚫 Заблокировать',
          `admin:tool:user:${user.id}:${
            user.is_blocked ? 'unblock' : 'block:ask'
          }`,
        ),
      ],
      [callbackButton('⬅️ К пользователям', 'admin:users')],
    ],
  );
}

async function showUserChannels(update, adminId, userDbId) {
  const user = await loadUser(userDbId);
  if (!user) return showUsers(update, adminId);

  const lines = [
    `📢 <b>Каналы ${esc(user.display_name || profileCode(user))}</b>`,
    '',
  ];
  const buttons = [];

  for (const channel of user.channels) {
    const role =
      channel.role === 'owner'
        ? 'владелец'
        : channel.role === 'admin'
          ? 'администратор'
          : 'участник';
    lines.push(`• ${channelTitle(channel)} — ${role}`);
    buttons.push([
      callbackButton(
        `📢 ${short(channel.title, 27)}`,
        `admin:tool:channel:${channel.id}`,
      ),
    ]);
  }

  if (!user.channels.length) lines.push('Подключённых каналов нет.');
  buttons.push([
    callbackButton('⬅️ К пользователю', `admin:tool:user:${user.id}`),
  ]);

  await respond(update, adminId, lines.join('\n'), buttons);
}

async function askMessage(update, adminId, userDbId) {
  const user = await loadUser(userDbId);
  if (!user) return showUsers(update, adminId);

  await setSession(adminId, 'tool_user_message_wait', { user_id: user.id });
  await respond(
    update,
    adminId,
    [
      '✉️ <b>Личное сообщение</b>',
      '',
      `Получатель: ${mention(user.max_user_id, user.display_name)}`,
      '',
      'Отправьте следующим сообщением текст, изображение, видео или файл.',
    ].join('\n'),
    [[callbackButton('❌ Отмена', 'admin:tool:cancel')]],
  );
}

async function askBlock(update, adminId, userDbId) {
  const user = await loadUser(userDbId);
  if (!user) return showUsers(update, adminId);

  await respond(
    update,
    adminId,
    [
      '🚫 <b>Заблокировать пользователя?</b>',
      '',
      `${profileCode(user)} — ${esc(user.display_name)}`,
      '',
      'Профиль и каналы не удаляются.',
    ].join('\n'),
    [
      [
        callbackButton(
          '🚫 Заблокировать',
          `admin:tool:user:${user.id}:block`,
        ),
      ],
      [callbackButton('⬅️ Отмена', `admin:tool:user:${user.id}`)],
    ],
  );
}

async function setBlocked(update, adminId, userDbId, blocked) {
  const user = (
    await safe(
      `UPDATE public.lr_admin_users SET is_blocked=$2,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [Number(userDbId), Boolean(blocked)],
    )
  )[0];
  if (!user) return showUsers(update, adminId);

  await audit(
    adminId,
    blocked ? 'user_blocked' : 'user_unblocked',
    profileCode(user),
    { display_name: user.display_name, max_user_id: user.max_user_id },
  );
  await showUserCard(update, adminId, user.id);
}

async function showChannels(update, adminId) {
  await ensureTeamAccessSchema().catch(() => {});

  const list = await safe(`
    SELECT
      c.id,c.max_chat_id,c.title,c.link,
      COUNT(DISTINCT uc.user_id)::integer AS admins
    FROM public.channels c
    LEFT JOIN public.lr_user_channels uc ON uc.channel_id=c.id
    WHERE COALESCE(c.is_active,true)=true
    GROUP BY c.id,c.max_chat_id,c.title,c.link
    ORDER BY c.id DESC
    LIMIT 20
  `);

  const buttons = list.map((channel) => [
    callbackButton(
      `📢 ${short(channel.title, 23)} · ${fmt(channel.admins)} адм.`,
      `admin:tool:channel:${channel.id}`,
    ),
  ]);
  buttons.push([callbackButton('⬅️ Назад', 'admin:menu')]);

  await respond(
    update,
    adminId,
    [
      '📢 <b>Подключённые каналы</b>',
      '',
      `Показано: <b>${fmt(list.length)}</b>`,
      '',
      list.length ? 'Выберите канал.' : 'Каналов пока нет.',
    ].join('\n'),
    buttons,
  );
}

async function loadChannel(channelDbId) {
  await ensureTeamAccessSchema().catch(() => {});

  const channel = (
    await safe(`SELECT * FROM public.channels WHERE id=$1 LIMIT 1`, [
      Number(channelDbId),
    ])
  )[0];
  if (!channel) return null;

  const admins = await safe(
    `SELECT
       u.id,u.profile_number,u.max_user_id,u.display_name,u.is_blocked,
       uc.role,uc.access_source,uc.last_verified_at
     FROM public.lr_user_channels uc
     JOIN public.lr_admin_users u ON u.id=uc.user_id
     WHERE uc.channel_id=$1
     ORDER BY
       CASE WHEN uc.role='owner' THEN 0 WHEN uc.role='admin' THEN 1 ELSE 2 END,
       u.display_name`,
    [Number(channelDbId)],
  );

  let team = {};
  if (await tableExists('lr_channel_team_sync_state')) {
    team = (
      await safe(
        `SELECT * FROM public.lr_channel_team_sync_state
         WHERE channel_id=$1 LIMIT 1`,
        [Number(channelDbId)],
      )
    )[0] || {};
  }

  let metrics = {};
  if (await tableExists('lr_channel_metrics_state')) {
    metrics = (
      await safe(
        `SELECT * FROM public.lr_channel_metrics_state
         WHERE channel_id::text=$1 OR channel_id::text=$2
         ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [String(channel.id), String(channel.max_chat_id)],
      )
    )[0] || {};
  }

  let posts = { scheduled: 0, published: 0, failed: 0 };
  if (await tableExists('scheduled_posts')) {
    const value = (
      await safe(
        `SELECT
           COUNT(*) FILTER (
             WHERE status::text IN ('scheduled','pending','queued','publishing')
           )::integer AS scheduled,
           COUNT(*) FILTER (
             WHERE status::text IN ('published','sent','done','posted','success')
                OR published_at IS NOT NULL
                OR published_message_id IS NOT NULL
           )::integer AS published,
           COUNT(*) FILTER (
             WHERE status::text IN ('failed','error')
           )::integer AS failed
         FROM public.scheduled_posts WHERE channel_id=$1`,
        [Number(channelDbId)],
      )
    )[0] || {};
    posts = {
      scheduled: num(value.scheduled),
      published: num(value.published),
      failed: num(value.failed),
    };
  }

  return { ...channel, admins, team, metrics, posts };
}

async function showChannelCard(update, adminId, channelDbId) {
  const channel = await loadChannel(channelDbId);
  if (!channel) return showChannels(update, adminId);

  const rights = channel.team?.last_success_at
    ? 'проверены'
    : channel.team?.last_error
      ? 'ошибка проверки'
      : 'ещё не проверены';

  const dataReady = Boolean(
    channel.metrics?.ready_at &&
      new Date(channel.metrics.ready_at).getTime() <= Date.now() &&
      num(channel.metrics?.success_count) >= 2,
  );

  const lines = [
    `📢 ${channelTitle(channel)}`,
    '',
    `MAX ID: <code>${esc(channel.max_chat_id)}</code>`,
    `Статус: <b>${channel.is_active === false ? 'отключён' : 'активен'}</b>`,
    `Права LinkRay: <b>${rights}</b>`,
    `Администраторов MAX: <b>${fmt(channel.team?.admins_seen)}</b>`,
    `Пользователей LinkRay: <b>${fmt(channel.admins.length)}</b>`,
    '',
    `Данные аналитики: <b>${dataReady ? 'готовы' : 'собираются'}</b>`,
    `Успешных замеров: <b>${fmt(channel.metrics?.success_count)}</b>`,
    `Последний замер: ${formatDate(channel.metrics?.last_success_at)}`,
    '',
    `Отложено: <b>${fmt(channel.posts.scheduled)}</b>`,
    `Опубликовано: <b>${fmt(channel.posts.published)}</b>`,
    `Ошибок: <b>${fmt(channel.posts.failed)}</b>`,
  ];

  if (channel.team?.last_error) {
    lines.push('', `Ошибка прав: ${esc(clean(channel.team.last_error, 500))}`);
  }
  if (channel.metrics?.last_error) {
    lines.push(
      '',
      `Ошибка аналитики: ${esc(clean(channel.metrics.last_error, 500))}`,
    );
  }

  await respond(update, adminId, lines.join('\n'), [
    [
      callbackButton(
        '👥 Администраторы',
        `admin:tool:channel:${channel.id}:admins`,
      ),
      callbackButton(
        '📊 Аналитика',
        `admin:tool:channel:${channel.id}:analytics`,
      ),
    ],
    [
      callbackButton(
        '🔄 Проверить права',
        `admin:tool:channel:${channel.id}:sync`,
      ),
    ],
    [
      callbackButton(
        '🗑 Отключить канал',
        `admin:tool:channel:${channel.id}:disable:ask`,
      ),
    ],
    [callbackButton('⬅️ К каналам', 'admin:channels')],
  ]);
}

async function showChannelAdmins(update, adminId, channelDbId) {
  const channel = await loadChannel(channelDbId);
  if (!channel) return showChannels(update, adminId);

  const lines = [
    '👥 <b>Администраторы канала</b>',
    '',
    channelTitle(channel),
    '',
  ];
  const buttons = [];

  for (const user of channel.admins) {
    const role =
      user.role === 'owner'
        ? '👑 владелец'
        : user.role === 'admin'
          ? '🛠 администратор'
          : '👤 участник';
    lines.push(`• ${mention(user.max_user_id, user.display_name)} — ${role}`);
    buttons.push([
      callbackButton(
        `👤 ${profileCode(user)} · ${short(user.display_name, 19)}`,
        `admin:tool:user:${user.id}`,
      ),
    ]);
  }

  if (!channel.admins.length) {
    lines.push('Зарегистрированные администраторы не найдены.');
  }

  buttons.push([
    callbackButton(
      '🔄 Проверить права',
      `admin:tool:channel:${channel.id}:sync`,
    ),
  ]);
  buttons.push([
    callbackButton('⬅️ К каналу', `admin:tool:channel:${channel.id}`),
  ]);

  await respond(update, adminId, lines.join('\n'), buttons);
}

function waitText(readyAt) {
  if (!readyAt) return 'таймер не запущен';
  const milliseconds = new Date(readyAt).getTime() - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'готово';
  const totalMinutes = Math.ceil(milliseconds / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} ч. ${minutes} мин.` : `${minutes} мин.`;
}

async function showChannelAnalytics(update, adminId, channelDbId) {
  const channel = await loadChannel(channelDbId);
  if (!channel) return showChannels(update, adminId);

  const ready = Boolean(
    channel.metrics?.ready_at &&
      new Date(channel.metrics.ready_at).getTime() <= Date.now() &&
      num(channel.metrics?.success_count) >= 2,
  );

  await respond(
    update,
    adminId,
    [
      '📊 <b>Состояние аналитики</b>',
      '',
      channelTitle(channel),
      '',
      `Отчёт готов: <b>${ready ? 'да' : 'нет'}</b>`,
      `До готовности: <b>${
        ready ? 'готово' : waitText(channel.metrics?.ready_at)
      }</b>`,
      `Успешных замеров: <b>${fmt(channel.metrics?.success_count)}</b>`,
      `Первый запуск: ${formatDate(channel.metrics?.first_seen_at)}`,
      `Последний успешный замер: ${formatDate(
        channel.metrics?.last_success_at,
      )}`,
      `Последняя ошибка: ${
        channel.metrics?.last_error
          ? esc(clean(channel.metrics.last_error, 700))
          : 'нет'
      }`,
    ].join('\n'),
    [
      [
        callbackButton(
          '🔄 Обновить',
          `admin:tool:channel:${channel.id}:analytics`,
        ),
      ],
      [callbackButton('⬅️ К каналу', `admin:tool:channel:${channel.id}`)],
    ],
  );
}

async function syncRights(update, adminId, channelDbId) {
  const channel = await loadChannel(channelDbId);

  if (!channel) {
    return showChannels(update, adminId);
  }

  await respond(
    update,
    adminId,
    '🔄 Проверяю владельцев и администраторов канала в MAX…',
    [[
      callbackButton(
        '⬅️ Назад',
        `admin:tool:channel:${channel.id}`
      ),
    ]],
  );

  const result =
    await syncChannelTeams('admin_manual');

  await audit(
    adminId,
    'Проверены права администраторов канала',
    channel.title || `Канал №${channel.id}`,
    {
      channel_id: channel.id,
      max_chat_id: channel.max_chat_id,
      title: channel.title || null,
      link: channel.link || null,
      successful: result?.successful,
      failed: result?.failed,
    },
  );

  await showChannelCard(
    update,
    adminId,
    channel.id,
  );
}

async function askDisableChannel(update, adminId, channelDbId) {
  const channel = await loadChannel(channelDbId);
  if (!channel) return showChannels(update, adminId);

  await respond(
    update,
    adminId,
    [
      '🗑 <b>Отключить канал от LinkRay?</b>',
      '',
      channelTitle(channel),
      '',
      'Канал станет неактивным и исчезнет из рабочих меню.',
      'История и статистика останутся в базе.',
    ].join('\n'),
    [
      [
        callbackButton(
          '🗑 Отключить',
          `admin:tool:channel:${channel.id}:disable`,
        ),
      ],
      [callbackButton('⬅️ Отмена', `admin:tool:channel:${channel.id}`)],
    ],
  );
}

async function disableChannel(update, adminId, channelDbId) {
  const channel = (
    await safe(
      `UPDATE public.channels SET is_active=false,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [Number(channelDbId)],
    )
  )[0];
  if (!channel) return showChannels(update, adminId);

  await audit(adminId, 'channel_removed', channel.id, {
    title: channel.title,
    max_chat_id: channel.max_chat_id,
    mode: 'soft_disable',
  });

  await respond(
    update,
    adminId,
    [
      '✅ <b>Канал отключён</b>',
      '',
      esc(channel.title),
      '',
      'Данные и история сохранены в базе.',
    ].join('\n'),
    [[callbackButton('⬅️ К каналам', 'admin:channels')]],
  );
}

async function showSystem(update, adminId) {
  const stats = await dashboardStats();
  const memory = Math.round(process.memoryUsage().rss / 1024 / 1024);

  await respond(
    update,
    adminId,
    [
      '🖥 <b>Состояние LinkRay</b>',
      '',
      '🟢 Приложение работает',
      '🟢 PostgreSQL подключён',
      `${
        (await tableExists('lr_channel_team_sync_state')) ? '🟢' : '🟡'
      } Синхронизация администраторов`,
      `${(await tableExists('lr_channel_metrics_state')) ? '🟢' : '🟡'} Сбор аналитики`,
      '',
      `Время работы процесса: <b>${Math.floor(process.uptime() / 3600)} ч.</b>`,
      `Память процесса: <b>${fmt(memory)} МБ</b>`,
      '',
      `Пользователей: <b>${fmt(stats.users)}</b>`,
      `Каналов: <b>${fmt(stats.channels)}</b>`,
      `Очередь публикаций: <b>${fmt(stats.scheduled)}</b>`,
      `Ошибок публикации: <b>${fmt(stats.failed)}</b>`,
      `Активных рассылок: <b>${fmt(stats.broadcasts)}</b>`,
    ].join('\n'),
    [
      [callbackButton('🔄 Обновить', 'admin:system')],
      [callbackButton('📜 Журнал', 'admin:logs')],
      [callbackButton('⬅️ Назад', 'admin:menu')],
    ],
  );
}

async function showSubscriptions(update, adminId) {
  let stats = {};
  if (
    (await tableExists('lr_user_subscriptions')) &&
    (await tableExists('lr_tariffs'))
  ) {
    stats = (
      await safe(`
        SELECT
          COUNT(*) FILTER (
            WHERE s.status='active' AND COALESCE(t.is_free,false)=false
              AND (s.expires_at IS NULL OR s.expires_at>now())
          )::integer AS paid,
          COUNT(*) FILTER (
            WHERE s.status='active' AND COALESCE(t.is_free,false)=true
          )::integer AS free,
          COUNT(*) FILTER (
            WHERE s.status='active' AND COALESCE(t.is_free,false)=false
              AND s.expires_at>now()
              AND s.expires_at<=now()+interval '3 days'
          )::integer AS expiring,
          COUNT(*) FILTER (
            WHERE s.expires_at IS NOT NULL AND s.expires_at<=now()
          )::integer AS expired
        FROM public.lr_user_subscriptions s
        LEFT JOIN public.lr_tariffs t ON t.code=s.tariff_code
      `)
    )[0] || {};
  }

  let paidChannels = 0;
  if (await tableExists('lr_subscription_channels')) {
    paidChannels = num(
      (
        await safe(`
          SELECT COUNT(DISTINCT channel_id)::integer AS value
          FROM public.lr_subscription_channels
        `)
      )[0]?.value,
    );
  }

  await respond(
    update,
    adminId,
    [
      '💎 <b>Подписки LinkRay</b>',
      '',
      `Платных активных: <b>${fmt(stats.paid)}</b>`,
      `Бесплатных активных: <b>${fmt(stats.free)}</b>`,
      `Истекают за 3 дня: <b>${fmt(stats.expiring)}</b>`,
      `Просрочено: <b>${fmt(stats.expired)}</b>`,
      `Оплаченных каналов: <b>${fmt(paidChannels)}</b>`,
      '',
      'Сейчас бесплатный режим остаётся включён.',
    ].join('\n'),
    [
      [callbackButton('🔄 Обновить', 'admin:subscriptions')],
      [callbackButton('⬅️ Назад', 'admin:menu')],
    ],
  );
}

function isToolsAction(action) {
  return (
    action === 'admin:menu' ||
    action === 'admin:users' ||
    action === 'admin:channels' ||
    action === 'admin:system' ||
    action === 'admin:subscriptions' ||
    action === 'admin:session:cancel' ||
    action.startsWith('admin:tool:')
  );
}

async function handleAction(update, adminId, action) {
  /* LR_ADMIN_OPERATIONS_ACTION_HOOK_V1 */

  if (
    await handleAdminOperationsAction(
      update,
      adminId,
      action,
    )
  ) {
    return true;
  }

  if (action === 'admin:menu') return showMenu(update, adminId);
  if (action === 'admin:users') return showUsers(update, adminId);
  if (action === 'admin:channels') return showChannels(update, adminId);
  if (action === 'admin:system') return showSystem(update, adminId);
  if (action === 'admin:subscriptions') return showSubscriptions(update, adminId);

  if (
    action === 'admin:tool:cancel' ||
    action === 'admin:session:cancel'
  ) {
    await setSession(adminId, 'idle', {});
    return showMenu(update, adminId);
  }

  let match = action.match(/^admin:tool:user:(\d+):message$/);
  if (match) return askMessage(update, adminId, Number(match[1]));

  match = action.match(/^admin:tool:user:(\d+):channels$/);
  if (match) return showUserChannels(update, adminId, Number(match[1]));

  match = action.match(/^admin:tool:user:(\d+):block:ask$/);
  if (match) return askBlock(update, adminId, Number(match[1]));

  match = action.match(/^admin:tool:user:(\d+):block$/);
  if (match) return setBlocked(update, adminId, Number(match[1]), true);

  match = action.match(/^admin:tool:user:(\d+):unblock$/);
  if (match) return setBlocked(update, adminId, Number(match[1]), false);

  match = action.match(/^admin:tool:user:(\d+)$/);
  if (match) return showUserCard(update, adminId, Number(match[1]));

  match = action.match(/^admin:tool:channel:(\d+):admins$/);
  if (match) return showChannelAdmins(update, adminId, Number(match[1]));

  match = action.match(/^admin:tool:channel:(\d+):analytics$/);
  if (match) return showChannelAnalytics(update, adminId, Number(match[1]));

  match = action.match(/^admin:tool:channel:(\d+):sync$/);
  if (match) return syncRights(update, adminId, Number(match[1]));

  match = action.match(/^admin:tool:channel:(\d+):disable:ask$/);
  if (match) return askDisableChannel(update, adminId, Number(match[1]));

  match = action.match(/^admin:tool:channel:(\d+):disable$/);
  if (match) return disableChannel(update, adminId, Number(match[1]));

  match = action.match(/^admin:tool:channel:(\d+)$/);
  if (match) return showChannelCard(update, adminId, Number(match[1]));

  return false;
}

async function handleDirectMessage(update, adminId, session) {
  /* LR_ADMIN_OPERATIONS_MESSAGE_HOOK_V1 */

  if (
    await handleAdminOperationsMessage(
      update,
      adminId,
      session,
    )
  ) {
    return true;
  }

  const item = content(update);
  if (!item) return false;

  const target = (
    await safe(
      `SELECT id,profile_number,max_user_id,display_name,is_blocked FROM public.lr_admin_users WHERE id=$1 LIMIT 1`,
      [Number(session?.data?.user_id)],
    )
  )[0];

  if (!target) {
    await setSession(adminId, 'idle', {});
    await respond(
      update,
      adminId,
      '⚠️ Получатель не найден.',
      [[callbackButton('⬅️ В админ-панель', 'admin:menu')]],
    );
    return true;
  }

  if (target.is_blocked) {
    await respond(
      update,
      adminId,
      '⚠️ Пользователь заблокирован. Сначала разблокируйте его.',
      [[callbackButton('⬅️ К пользователю', `admin:tool:user:${target.id}`)]],
    );
    return true;
  }

  try {
    await sendMaxMessage({
      userId: String(target.max_user_id),
      text: item.text || '',
      format: item.format || 'html',
      attachments: item.attachments || [],
      markup: item.markup || [],
      purpose: 'admin_direct_message',
    });

    await setSession(adminId, 'idle', {});
    await audit(adminId, 'Пользователю отправлено личное сообщение', profileCode(target), {
      display_name: target.display_name,
      max_user_id: target.max_user_id,
    });

    await respond(
      update,
      adminId,
      [
        '✅ <b>Сообщение отправлено</b>',
        '',
        `Получатель: ${mention(target.max_user_id, target.display_name)}`,
      ].join('\n'),
      [[callbackButton('⬅️ К пользователю', `admin:tool:user:${target.id}`)]],
    );
  } catch (error) {
    await respond(
      update,
      adminId,
      [
        '❌ <b>Не удалось отправить сообщение</b>',
        '',
        esc(clean(error?.message || error, 700)),
      ].join('\n'),
      [
        [callbackButton('🔄 Повторить', `admin:tool:user:${target.id}:message`)],
        [callbackButton('⬅️ К пользователю', `admin:tool:user:${target.id}`)],
      ],
    );
  }

  return true;
}

export function installAdminPanelTools(app) {
  if (installed) return;
  installed = true;

  if (!app?.use) throw new Error('Express app is required');

  installUserSupportCenter(app);
  app.use(async function adminPanelToolsMiddleware(req, res, next) {
    try {
      if (req.method !== 'POST') return next();

      const update = req.body || {};
      const adminId = userId(update);
      if (!adminId) return next();

      const action = payload(update);
      const command = /^\/admin(?:\s|$)/i.test(messageText(update));
      const session = !action ? await getSession(adminId) : null;
      const directMessage =
      session?.state === 'tool_user_message_wait' ||
      session?.state === 'ops_search_wait';

      if (!command && !isToolsAction(action) && !directMessage) {
        return next();
      }

      if (!(await isAdmin(adminId))) {
        return next();
      }

      if (command) {
        await setSession(adminId, 'idle', {});
        await audit(adminId, 'admin_opened');
        await showMenu(update, adminId);
        return res.json({ ok: true, admin_tools: true });
      }

      if (isToolsAction(action)) {
        await handleAction(update, adminId, action);
        return res.json({ ok: true, admin_tools: true });
      }

      if (directMessage && (await handleDirectMessage(update, adminId, session))) {
        return res.json({ ok: true, admin_tools: true });
      }

      return next();
    } catch (error) {
      console.error('[admin tools middleware]', error?.stack || error?.message || error);
      return next();
    }
  });
}

