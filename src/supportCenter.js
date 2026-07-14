/* LR_SUPPORT_ADMIN_CLEAR_DATABASE_V1 */
import { query } from './db.js';
import {
  sendMaxMessage,
  answerCallback,
  callbackButton,
  inlineKeyboard,
} from './maxClient.js';

let installed = false;
let schemaPromise = null;

const rows = (result) =>
  Array.isArray(result) ? result : (result?.rows || []);

const clean = (value, max = 4000) =>
  String(value ?? '').trim().slice(0, max);

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const stripHtml = (value) =>
  String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const short = (value, max = 90) => {
  const text = stripHtml(value) || 'Сообщение с вложением';
  return text.length > max
    ? `${text.slice(0, Math.max(1, max - 1))}…`
    : text;
};

const ticketCode = (ticket) =>
  `SUP-${String(ticket?.id || 0).padStart(6, '0')}`;

const profileCode = (user) =>
  `LR-${String(user?.profile_number || user?.id || 0).padStart(6, '0')}`;

const statusMeta = (status) => {
  const map = {
    new: ['🆕', 'новое'],
    in_progress: ['🟡', 'в работе'],
    closed: ['✅', 'закрыто'],
  };
  return map[String(status || '')] || ['⚪', 'неизвестно'];
};

const categoryText = (category) =>
  String(category || '') === 'suggestion'
    ? 'Предложение'
    : 'Вопрос';

const formatDate = (value) => {
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
};

function payload(update) {
  return clean(
    update?.callback?.payload ||
      update?.callback?.data ||
      update?.message_callback?.payload ||
      update?.message_callback?.data ||
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
      update?.message_callback?.callbackId ||
      '',
    500,
  );
}

function humanCandidates(update) {
  return [
    update?.callback?.user,
    update?.message_callback?.user,
    update?.message_callback?.callback?.user,
    update?.user,
    update?.message?.sender,
    update?.sender,
    update?.body?.user,
    update?.message?.body?.user,
  ].filter((value) => value && typeof value === 'object');
}

function candidateId(candidate) {
  const id = clean(
    candidate?.user_id ||
      candidate?.userId ||
      candidate?.id ||
      '',
    100,
  );
  const login = clean(
    candidate?.username ||
      candidate?.login ||
      '',
    200,
  ).toLowerCase();
  if (
    !/^\d+$/.test(id) ||
    candidate?.is_bot === true ||
    candidate?.isBot === true ||
    login.endsWith('_bot')
  ) {
    return '';
  }
  return id;
}

function userId(update) {
  for (const candidate of humanCandidates(update)) {
    const id = candidateId(candidate);
    if (id) return id;
  }
  for (const value of [
    update?.callback?.user_id,
    update?.callback?.userId,
    update?.message_callback?.user_id,
    update?.message_callback?.userId,
    update?.user_id,
    update?.userId,
    update?.body?.user_id,
    update?.body?.userId,
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
    text: String(
      body?.text ??
      update?.message?.text ??
      update?.text ??
      '',
    ),
    format:
      clean(
        body?.format ||
        update?.message?.format ||
        'html',
        30,
      ) || 'html',
    attachments: Array.isArray(body?.attachments)
      ? body.attachments
      : [],
    markup: Array.isArray(body?.markup)
      ? body.markup
      : [],
  };
  return result.text.trim() || result.attachments.length
    ? result
    : null;
}

function keyboard(buttonRows = []) {
  if (!buttonRows.length) return [];
  const value = inlineKeyboard(buttonRows);
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function combineAttachments(media = [], buttonRows = []) {
  return [
    ...(Array.isArray(media) ? media : []),
    ...keyboard(buttonRows),
  ];
}

async function respond(
  update,
  targetUserId,
  text,
  buttonRows = [],
  media = [],
  note = '',
) {
  const id = callbackId(update);
  const attachments = combineAttachments(media, buttonRows);
  if (id && !media.length) {
    try {
      await answerCallback({
        callbackId: id,
        text,
        format: 'html',
        attachments,
        notification: note,
      });
      return;
    } catch {}
  }
  await sendMaxMessage({
    userId: String(targetUserId),
    text,
    format: 'html',
    attachments,
    purpose: 'linkray_support',
  });
}

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS public.lr_support_tickets (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL
          REFERENCES public.lr_users(id) ON DELETE CASCADE,
        max_user_id text NOT NULL,
        category text NOT NULL DEFAULT 'question',
        subject text NOT NULL DEFAULT 'Вопрос / предложение',
        status text NOT NULL DEFAULT 'new',
        assigned_admin_id text,
        unread_for_admin boolean NOT NULL DEFAULT true,
        unread_for_user boolean NOT NULL DEFAULT false,
        last_message_preview text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_user_message_at timestamptz,
        last_admin_message_at timestamptz,
        closed_at timestamptz
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS public.lr_support_messages (
        id bigserial PRIMARY KEY,
        ticket_id bigint NOT NULL
          REFERENCES public.lr_support_tickets(id) ON DELETE CASCADE,
        sender_type text NOT NULL,
        sender_max_user_id text NOT NULL,
        text text NOT NULL DEFAULT '',
        format text NOT NULL DEFAULT 'html',
        attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
        markup jsonb NOT NULL DEFAULT '[]'::jsonb,
        delivered boolean NOT NULL DEFAULT true,
        delivery_error text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS public.lr_support_sessions (
        max_user_id text PRIMARY KEY,
        state text NOT NULL DEFAULT 'idle',
        ticket_id bigint,
        category text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS lr_support_tickets_status_idx
      ON public.lr_support_tickets(status, updated_at DESC)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS lr_support_tickets_user_idx
      ON public.lr_support_tickets(user_id, updated_at DESC)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS lr_support_messages_ticket_idx
      ON public.lr_support_messages(ticket_id, created_at)
    `);
  })();
  return schemaPromise;
}

async function getUser(maxUserId) {
  return rows(await query(`
    SELECT
      u.*,
      (
        SELECT COUNT(DISTINCT uc.channel_id)::integer
        FROM public.lr_user_channels uc
        WHERE uc.user_id=u.id
      ) AS channels_count
    FROM public.lr_users u
    WHERE u.max_user_id=$1
    LIMIT 1
  `, [String(maxUserId)]))[0] || null;
}

async function isAdmin(maxUserId) {
  const found = rows(await query(`
    SELECT 1
    FROM public.lr_admins
    WHERE max_user_id=$1
      AND is_active=true
    LIMIT 1
  `, [String(maxUserId)]));
  return found.length > 0;
}

async function activeAdminIds() {
  return rows(await query(`
    SELECT max_user_id
    FROM public.lr_admins
    WHERE is_active=true
      AND max_user_id ~ '^\\d+$'
    ORDER BY
      CASE WHEN role='owner' THEN 0 ELSE 1 END,
      created_at
  `)).map((row) => String(row.max_user_id));
}

async function getSession(maxUserId) {
  return rows(await query(`
    SELECT state,ticket_id,category
    FROM public.lr_support_sessions
    WHERE max_user_id=$1
    LIMIT 1
  `, [String(maxUserId)]))[0] || {
    state: 'idle',
    ticket_id: null,
    category: null,
  };
}

async function setSession(
  maxUserId,
  state,
  ticketId = null,
  category = null,
) {
  await query(`
    INSERT INTO public.lr_support_sessions(
      max_user_id,state,ticket_id,category,updated_at
    ) VALUES($1,$2,$3,$4,now())
    ON CONFLICT(max_user_id) DO UPDATE SET
      state=EXCLUDED.state,
      ticket_id=EXCLUDED.ticket_id,
      category=EXCLUDED.category,
      updated_at=now()
  `, [
    String(maxUserId),
    String(state),
    ticketId ? Number(ticketId) : null,
    category ? String(category) : null,
  ]);
}

async function clearSession(maxUserId) {
  await query(`
    DELETE FROM public.lr_support_sessions
    WHERE max_user_id=$1
  `, [String(maxUserId)]);
}

async function audit(
  adminId,
  action,
  ticket,
  details = {},
) {
  await query(`
    INSERT INTO public.lr_admin_audit(
      admin_user_id,action,target_id,details
    ) VALUES($1,$2,$3,$4::jsonb)
  `, [
    String(adminId),
    String(action),
    ticketCode(ticket),
    JSON.stringify(details),
  ]).catch(() => {});
}

async function loadTicket(ticketId) {
  return rows(await query(`
    SELECT
      t.*,
      u.profile_number,
      u.display_name,
      u.private_chat_id,
      u.is_blocked,
      (
        SELECT COUNT(DISTINCT uc.channel_id)::integer
        FROM public.lr_user_channels uc
        WHERE uc.user_id=u.id
      ) AS channels_count
    FROM public.lr_support_tickets t
    JOIN public.lr_users u ON u.id=t.user_id
    WHERE t.id=$1
    LIMIT 1
  `, [Number(ticketId)]))[0] || null;
}

async function loadMessages(ticketId, limit = 12) {
  const list = rows(await query(`
    SELECT *
    FROM public.lr_support_messages
    WHERE ticket_id=$1
    ORDER BY created_at DESC,id DESC
    LIMIT $2
  `, [Number(ticketId), Number(limit)]));
  return list.reverse();
}

function historyText(messages) {
  if (!messages.length) return ['История пока пуста.'];
  const output = [];
  for (const message of messages) {
    const sender =
      message.sender_type === 'admin'
        ? '🛠 Поддержка'
        : '👤 Пользователь';
    const text = short(message.text, 500);
    const attachments =
      Array.isArray(message.attachments)
        ? message.attachments
        : [];
    output.push(
      `${sender} · ${formatDate(message.created_at)}`,
    );
    if (text) output.push(esc(text));
    if (attachments.length) {
      output.push(`📎 Вложений: ${attachments.length}`);
    }
    output.push('');
  }
  return output;
}

async function showUserHome(update, maxUserId) {
  const user = await getUser(maxUserId);
  if (!user) {
    await respond(
      update,
      maxUserId,
      [
        '⚠️ <b>Профиль не найден</b>',
        '',
        'Сначала откройте профиль LinkRay через главное меню.',
      ].join('\n'),
      [[callbackButton('⬅️ Главное меню', 'main:menu')]],
    );
    return;
  }
  const stats = rows(await query(`
    SELECT
      COUNT(*)::integer AS total,
      COUNT(*) FILTER (WHERE status='new')::integer AS new_count,
      COUNT(*) FILTER (WHERE status='in_progress')::integer AS progress_count,
      COUNT(*) FILTER (WHERE unread_for_user=true)::integer AS unread_count
    FROM public.lr_support_tickets
    WHERE user_id=$1
  `, [Number(user.id)]))[0] || {};
  await respond(
    update,
    maxUserId,
    [
      '🎫 <b>Вопросы / предложения</b>',
      '',
      'Здесь можно задать вопрос по LinkRay, сообщить о проблеме или предложить новую функцию.',
      '',
      `Всего обращений: <b>${Number(stats.total || 0)}</b>`,
      `Ожидают ответа: <b>${Number(stats.new_count || 0)}</b>`,
      `В работе: <b>${Number(stats.progress_count || 0)}</b>`,
      `Новых ответов: <b>${Number(stats.unread_count || 0)}</b>`,
    ].join('\n'),
    [
      [
        callbackButton('❓ Задать вопрос', 'support:new:question'),
        callbackButton('💡 Предложение', 'support:new:suggestion'),
      ],
      [callbackButton('📨 Мои обращения', 'support:mine')],
      [callbackButton('⬅️ В профиль', 'main:profile')],
    ],
  );
}

async function askUserMessage(
  update,
  maxUserId,
  category,
  ticketId = null,
) {
  const state = ticketId ? 'user_reply' : 'user_new';
  await setSession(maxUserId, state, ticketId, category);
  await respond(
    update,
    maxUserId,
    [
      ticketId
        ? `✍️ <b>Дополнить ${ticketCode({ id: ticketId })}</b>`
        : `✍️ <b>${categoryText(category)}</b>`,
      '',
      'Отправьте следующим сообщением текст, изображение, видео или файл.',
      '',
      'Сообщение будет сохранено в истории обращения и передано администратору LinkRay.',
    ].join('\n'),
    [[callbackButton('❌ Отмена', 'support:cancel')]],
  );
}

async function showUserTickets(update, maxUserId) {
  const user = await getUser(maxUserId);
  if (!user) return showUserHome(update, maxUserId);
  const tickets = rows(await query(`
    SELECT *
    FROM public.lr_support_tickets
    WHERE user_id=$1
    ORDER BY updated_at DESC,id DESC
    LIMIT 15
  `, [Number(user.id)]));
  const buttons = tickets.map((ticket) => {
    const [emoji, label] = statusMeta(ticket.status);
    const unread = ticket.unread_for_user ? ' 🔴' : '';
    return [
      callbackButton(
        `${emoji} ${ticketCode(ticket)} · ${label}${unread}`,
        `support:user:ticket:${ticket.id}`,
      ),
    ];
  });
  buttons.push([
    callbackButton('➕ Новое обращение', 'support:new:question'),
  ]);
  buttons.push([
    callbackButton('⬅️ Назад', 'support:open'),
  ]);
  await respond(
    update,
    maxUserId,
    [
      '📨 <b>Мои обращения</b>',
      '',
      tickets.length
        ? 'Выберите обращение.'
        : 'Обращений пока нет.',
    ].join('\n'),
    buttons,
  );
}

async function showUserTicket(update, maxUserId, ticketId) {
  const user = await getUser(maxUserId);
  const ticket = await loadTicket(ticketId);
  if (!user || !ticket || Number(ticket.user_id) !== Number(user.id)) {
    return showUserTickets(update, maxUserId);
  }
  await query(`
    UPDATE public.lr_support_tickets
    SET unread_for_user=false
    WHERE id=$1
  `, [Number(ticket.id)]);
  const messages = await loadMessages(ticket.id, 10);
  const [emoji, status] = statusMeta(ticket.status);
  const buttons = [];
  if (ticket.status !== 'closed') {
    buttons.push([
      callbackButton(
        '✍️ Дополнить',
        `support:user:reply:${ticket.id}`,
      ),
      callbackButton(
        '✅ Закрыть',
        `support:user:close:${ticket.id}`,
      ),
    ]);
  }
  buttons.push([
    callbackButton('⬅️ К обращениям', 'support:mine'),
  ]);
  await respond(
    update,
    maxUserId,
    [
      `🎫 <b>${ticketCode(ticket)}</b>`,
      '',
      `Тип: <b>${categoryText(ticket.category)}</b>`,
      `Статус: ${emoji} <b>${status}</b>`,
      `Создано: ${formatDate(ticket.created_at)}`,
      '',
      '━━━━━━━━━━━━',
      ...historyText(messages),
    ].join('\n'),
    buttons,
  );
}

async function insertMessage(
  ticket,
  senderType,
  senderMaxUserId,
  item,
  delivered = true,
  deliveryError = null,
) {
  const message = rows(await query(`
    INSERT INTO public.lr_support_messages(
      ticket_id,sender_type,sender_max_user_id,
      text,format,attachments,markup,
      delivered,delivery_error,created_at
    ) VALUES(
      $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,now()
    )
    RETURNING *
  `, [
    Number(ticket.id),
    String(senderType),
    String(senderMaxUserId),
    item?.text || '',
    item?.format || 'html',
    JSON.stringify(item?.attachments || []),
    JSON.stringify(item?.markup || []),
    Boolean(delivered),
    deliveryError ? clean(deliveryError, 1000) : null,
  ]))[0];
  return message;
}

async function createTicket(user, category, item) {
  const ticket = rows(await query(`
    INSERT INTO public.lr_support_tickets(
      user_id,max_user_id,category,subject,status,
      unread_for_admin,unread_for_user,
      last_message_preview,last_user_message_at,
      created_at,updated_at
    ) VALUES(
      $1,$2,$3,$4,'new',true,false,$5,now(),now(),now()
    )
    RETURNING *
  `, [
    Number(user.id),
    String(user.max_user_id),
    String(category || 'question'),
    categoryText(category),
    short(item?.text, 200),
  ]))[0];
  await insertMessage(
    ticket,
    'user',
    user.max_user_id,
    item,
  );
  return ticket;
}

async function notifyAdmins(ticket, item, isReply = false) {
  const admins = await activeAdminIds();
  const user = await getUser(ticket.max_user_id);
  const text = [
    isReply
      ? '💬 <b>Новое сообщение в обращении</b>'
      : '🆕 <b>Новое обращение в поддержку</b>',
    '',
    `Обращение: <b>${ticketCode(ticket)}</b>`,
    `Тип: <b>${categoryText(ticket.category)}</b>`,
    `Пользователь: <a href="max://user/${esc(ticket.max_user_id)}">${esc(user?.display_name || 'Пользователь MAX')}</a>`,
    `Профиль: <b>${profileCode(user)}</b>`,
    `Каналов: <b>${Number(user?.channels_count || 0)}</b>`,
    '',
    `Сообщение: ${esc(short(item?.text, 900))}`,
    item?.attachments?.length
      ? `📎 Вложений: <b>${item.attachments.length}</b>`
      : '',
  ].filter(Boolean).join('\n');
  const buttons = [
    [
      callbackButton(
        '🎫 Открыть обращение',
        `support:admin:ticket:${ticket.id}`,
      ),
    ],
  ];
  if (ticket.status === 'new') {
    buttons.push([
      callbackButton(
        '▶️ Взять в работу',
        `support:admin:take:${ticket.id}`,
      ),
      callbackButton(
        '✉️ Ответить',
        `support:admin:reply:${ticket.id}`,
      ),
    ]);
  }
  for (const adminId of admins) {
    await sendMaxMessage({
      userId: adminId,
      text,
      format: 'html',
      attachments: combineAttachments(
        item?.attachments || [],
        buttons,
      ),
      purpose: 'support_admin_notification',
    }).catch((error) => {
      console.error(
        '[support notify admin]',
        adminId,
        error?.message || error,
      );
    });
  }
}

async function handleUserInput(maxUserId, session, item) {
  const user = await getUser(maxUserId);
  if (!user || user.is_blocked) {
    await clearSession(maxUserId);
    await sendMaxMessage({
      userId: String(maxUserId),
      text: '⚠️ Не удалось создать обращение.',
      format: 'html',
      purpose: 'linkray_support',
    });
    return true;
  }
  if (session.state === 'user_new') {
    const ticket = await createTicket(
      user,
      session.category || 'question',
      item,
    );
    await clearSession(maxUserId);
    await notifyAdmins(ticket, item, false);
    await sendMaxMessage({
      userId: String(maxUserId),
      text: [
        '✅ <b>Обращение отправлено</b>',
        '',
        `Номер: <b>${ticketCode(ticket)}</b>`,
        'Статус: 🆕 <b>новое</b>',
        '',
        'Администратор получит уведомление. Ответ появится в этом чате и сохранится в истории обращения.',
      ].join('\n'),
      format: 'html',
      attachments: keyboard([
        [
          callbackButton(
            '🎫 Открыть обращение',
            `support:user:ticket:${ticket.id}`,
          ),
        ],
        [callbackButton('⬅️ В профиль', 'main:profile')],
      ]),
      purpose: 'linkray_support',
    });
    return true;
  }
  if (session.state === 'user_reply') {
    const ticket = await loadTicket(session.ticket_id);
    if (
      !ticket ||
      Number(ticket.user_id) !== Number(user.id) ||
      ticket.status === 'closed'
    ) {
      await clearSession(maxUserId);
      await showUserTickets({}, maxUserId);
      return true;
    }
    await insertMessage(
      ticket,
      'user',
      maxUserId,
      item,
    );
    const updated = rows(await query(`
      UPDATE public.lr_support_tickets
      SET
        unread_for_admin=true,
        unread_for_user=false,
        last_message_preview=$2,
        last_user_message_at=now(),
        updated_at=now()
      WHERE id=$1
      RETURNING *
    `, [
      Number(ticket.id),
      short(item.text, 200),
    ]))[0] || ticket;
    await clearSession(maxUserId);
    await notifyAdmins(updated, item, true);
    await sendMaxMessage({
      userId: String(maxUserId),
      text: [
        '✅ <b>Сообщение добавлено</b>',
        '',
        `Обращение: <b>${ticketCode(updated)}</b>`,
        'Администратор получил уведомление.',
      ].join('\n'),
      format: 'html',
      attachments: keyboard([
        [
          callbackButton(
            '🎫 Открыть обращение',
            `support:user:ticket:${updated.id}`,
          ),
        ],
      ]),
      purpose: 'linkray_support',
    });
    return true;
  }
  return false;
}

async function adminStats() {
  return rows(await query(`
    SELECT
      COUNT(*) FILTER (WHERE status='new')::integer AS new_count,
      COUNT(*) FILTER (WHERE status='in_progress')::integer AS progress_count,
      COUNT(*) FILTER (
        WHERE status='closed'
          AND closed_at >= date_trunc('day',now())
      )::integer AS closed_today,
      COUNT(*) FILTER (WHERE unread_for_admin=true)::integer AS unread_count,
      COUNT(*)::integer AS total
    FROM public.lr_support_tickets
  `))[0] || {};
}

async function supportDeleteStats(mode = 'all') {
  const closedOnly = mode === 'closed';
  const result = rows(await query(`
    SELECT
      COUNT(DISTINCT t.id)::integer AS tickets,
      COUNT(m.id)::integer AS messages
    FROM public.lr_support_tickets t
    LEFT JOIN public.lr_support_messages m
      ON m.ticket_id=t.id
    ${closedOnly ? "WHERE t.status='closed'" : ''}
  `))[0] || {};
  return {
    tickets: Number(result.tickets || 0),
    messages: Number(result.messages || 0),
  };
}

async function showSupportClearConfirm(
  update,
  adminId,
  mode,
  finalStep = false,
) {
  const closedOnly = mode === 'closed';
  const stats = await supportDeleteStats(mode);
  const title = closedOnly
    ? 'Очистить закрытые обращения'
    : 'Очистить всю базу поддержки';
  const warning = closedOnly
    ? 'Будут удалены только обращения со статусом «закрыто» и вся их переписка.'
    : 'Будут удалены вопросы, предложения, вся переписка и активные сессии поддержки. Восстановить данные нельзя.';
  const buttons = [];
  if (closedOnly) {
    buttons.push([
      callbackButton(
        '✅ Удалить закрытые',
        'support:admin:clear:closed:run',
      ),
    ]);
  } else if (!finalStep) {
    buttons.push([
      callbackButton(
        '⚠️ Продолжить',
        'support:admin:clear:all:confirm2',
      ),
    ]);
  } else {
    buttons.push([
      callbackButton(
        '🗑 Удалить без восстановления',
        'support:admin:clear:all:run',
      ),
    ]);
  }
  buttons.push([
    callbackButton('❌ Отмена', 'support:admin:list:new'),
  ]);
  await respond(
    update,
    adminId,
    [
      `🗑 <b>${title}</b>`,
      '',
      `Обращений: <b>${stats.tickets}</b>`,
      `Сообщений: <b>${stats.messages}</b>`,
      '',
      warning,
      !closedOnly && !finalStep
        ? 'Для полной очистки потребуется ещё одно подтверждение.'
        : '<b>Подтвердите удаление.</b>',
    ].join('\n'),
    buttons,
  );
}

async function clearSupportDatabase(
  update,
  adminId,
  mode = 'all',
) {
  const closedOnly = mode === 'closed';
  const deleted = rows(await query(`
    WITH doomed AS MATERIALIZED (
      SELECT id
      FROM public.lr_support_tickets
      ${closedOnly ? "WHERE status='closed'" : ''}
    ),
    stats AS MATERIALIZED (
      SELECT
        (SELECT COUNT(*) FROM doomed)::integer AS tickets,
        (
          SELECT COUNT(*)
          FROM public.lr_support_messages
          WHERE ticket_id IN (SELECT id FROM doomed)
        )::integer AS messages
    ),
    deleted_sessions AS (
      DELETE FROM public.lr_support_sessions
      ${closedOnly
        ? 'WHERE ticket_id IN (SELECT id FROM doomed)'
        : ''}
      RETURNING 1
    ),
    deleted_tickets AS (
      DELETE FROM public.lr_support_tickets
      WHERE id IN (SELECT id FROM doomed)
      RETURNING id
    )
    SELECT
      stats.tickets,
      stats.messages,
      (SELECT COUNT(*) FROM deleted_sessions)::integer AS sessions
    FROM stats
  `))[0] || {};
  const tickets = Number(deleted.tickets || 0);
  const messages = Number(deleted.messages || 0);
  const sessions = Number(deleted.sessions || 0);
  const action = closedOnly
    ? 'Закрытые обращения поддержки удалены'
    : 'База вопросов и предложений очищена';
  if (tickets > 0 || sessions > 0) {
    await query(`
      INSERT INTO public.lr_admin_audit(
        admin_user_id,action,target_id,details
      ) VALUES($1,$2,$3,$4::jsonb)
    `, [
      String(adminId),
      action,
      'Поддержка',
      JSON.stringify({
        mode: closedOnly ? 'closed' : 'all',
        deleted_tickets: tickets,
        deleted_messages: messages,
        deleted_sessions: sessions,
      }),
    ]).catch(() => {});
  }
  await respond(
    update,
    adminId,
    [
      '✅ <b>База поддержки очищена</b>',
      '',
      `Удалено обращений: <b>${tickets}</b>`,
      `Удалено сообщений: <b>${messages}</b>`,
      `Сброшено сессий: <b>${sessions}</b>`,
      '',
      closedOnly
        ? 'Новые обращения и обращения в работе сохранены.'
        : 'Вопросы и предложения удалены полностью.',
    ].join('\n'),
    [
      [callbackButton('🎫 К поддержке', 'support:admin:list:new')],
      [callbackButton('⬅️ В админ-панель', 'admin:menu')],
    ],
  );
}

async function showAdminList(
  update,
  adminId,
  filter = 'new',
) {
  const allowed = new Set([
    'new',
    'in_progress',
    'closed',
    'all',
  ]);
  const mode = allowed.has(filter) ? filter : 'new';
  const where = mode === 'all' ? '' : 'WHERE t.status=$1';
  const params = mode === 'all' ? [] : [mode];
  const tickets = rows(await query(`
    SELECT
      t.*,
      u.profile_number,
      u.display_name
    FROM public.lr_support_tickets t
    JOIN public.lr_users u ON u.id=t.user_id
    ${where}
    ORDER BY
      t.unread_for_admin DESC,
      t.updated_at DESC,
      t.id DESC
    LIMIT 20
  `, params));
  const stats = await adminStats();
  const buttons = tickets.map((ticket) => {
    const [emoji] = statusMeta(ticket.status);
    const unread = ticket.unread_for_admin ? ' 🔴' : '';
    return [
      callbackButton(
        `${emoji} ${ticketCode(ticket)} · ${short(ticket.display_name, 18)}${unread}`,
        `support:admin:ticket:${ticket.id}`,
      ),
    ];
  });
  buttons.push([
    callbackButton(
      `🆕 Новые ${Number(stats.new_count || 0)}`,
      'support:admin:list:new',
    ),
    callbackButton(
      `🟡 В работе ${Number(stats.progress_count || 0)}`,
      'support:admin:list:in_progress',
    ),
  ]);
  buttons.push([
    callbackButton('✅ Закрытые', 'support:admin:list:closed'),
    callbackButton('📋 Все', 'support:admin:list:all'),
  ]);
  buttons.push([
    callbackButton(
      '🧹 Очистить закрытые',
      'support:admin:clear:closed:confirm',
    ),
    callbackButton(
      '🗑 Очистить всё',
      'support:admin:clear:all:confirm',
    ),
  ]);
  buttons.push([
    callbackButton('⬅️ В админ-панель', 'admin:menu'),
  ]);
  await respond(
    update,
    adminId,
    [
      '🎫 <b>Поддержка пользователей</b>',
      '',
      `Новых: <b>${Number(stats.new_count || 0)}</b>`,
      `В работе: <b>${Number(stats.progress_count || 0)}</b>`,
      `Непрочитанных: <b>${Number(stats.unread_count || 0)}</b>`,
      `Закрыто сегодня: <b>${Number(stats.closed_today || 0)}</b>`,
      `Всего в базе: <b>${Number(stats.total || 0)}</b>`,
      '',
      tickets.length
        ? 'Выберите обращение.'
        : 'В этом разделе обращений нет.',
    ].join('\n'),
    buttons,
  );
}

async function showAdminTicket(update, adminId, ticketId) {
  const ticket = await loadTicket(ticketId);
  if (!ticket) return showAdminList(update, adminId, 'new');
  await query(`
    UPDATE public.lr_support_tickets
    SET unread_for_admin=false
    WHERE id=$1
  `, [Number(ticket.id)]);
  const messages = await loadMessages(ticket.id, 12);
  const [emoji, status] = statusMeta(ticket.status);
  const userLink = /^\d+$/.test(String(ticket.max_user_id))
    ? `<a href="max://user/${ticket.max_user_id}">${esc(ticket.display_name || 'Пользователь MAX')}</a>`
    : esc(ticket.display_name || 'Пользователь MAX');
  const buttons = [];
  if (ticket.status === 'new') {
    buttons.push([
      callbackButton(
        '▶️ Взять в работу',
        `support:admin:take:${ticket.id}`,
      ),
    ]);
  }
  if (ticket.status !== 'closed') {
    buttons.push([
      callbackButton(
        '✉️ Ответить',
        `support:admin:reply:${ticket.id}`,
      ),
      callbackButton(
        '✅ Закрыть',
        `support:admin:close:${ticket.id}`,
      ),
    ]);
  } else {
    buttons.push([
      callbackButton(
        '↩️ Вернуть в работу',
        `support:admin:reopen:${ticket.id}`,
      ),
    ]);
  }
  buttons.push([
    callbackButton('⬅️ К обращениям', 'support:admin:list:new'),
  ]);
  await respond(
    update,
    adminId,
    [
      `🎫 <b>${ticketCode(ticket)}</b>`,
      '',
      `Пользователь: ${userLink}`,
      `Профиль: <b>${profileCode(ticket)}</b>`,
      `MAX ID: <code>${esc(ticket.max_user_id)}</code>`,
      `Каналов: <b>${Number(ticket.channels_count || 0)}</b>`,
      `Тип: <b>${categoryText(ticket.category)}</b>`,
      `Статус: ${emoji} <b>${status}</b>`,
      `Создано: ${formatDate(ticket.created_at)}`,
      ticket.assigned_admin_id
        ? `Ответственный MAX ID: <code>${esc(ticket.assigned_admin_id)}</code>`
        : 'Ответственный: не назначен',
      '',
      '━━━━━━━━━━━━',
      ...historyText(messages),
    ].join('\n'),
    buttons,
  );
}

async function setTicketStatus(
  update,
  adminId,
  ticketId,
  status,
) {
  const ticket = await loadTicket(ticketId);
  if (!ticket) return showAdminList(update, adminId, 'new');
  const updated = rows(await query(`
    UPDATE public.lr_support_tickets
    SET
      status=$2,
      assigned_admin_id=CASE
        WHEN $2='in_progress' THEN $3
        ELSE assigned_admin_id
      END,
      closed_at=CASE
        WHEN $2='closed' THEN now()
        ELSE NULL
      END,
      unread_for_admin=false,
      updated_at=now()
    WHERE id=$1
    RETURNING *
  `, [
    Number(ticket.id),
    String(status),
    String(adminId),
  ]))[0] || ticket;
  const action =
    status === 'closed'
      ? 'Обращение поддержки закрыто'
      : status === 'new'
        ? 'Обращение поддержки возвращено в новые'
        : 'Обращение поддержки взято в работу';
  await audit(adminId, action, updated, {
    user_max_id: ticket.max_user_id,
    status,
  });
  const [, statusLabel] = statusMeta(status);
  await sendMaxMessage({
    userId: String(ticket.max_user_id),
    text: [
      `🎫 <b>${ticketCode(ticket)}</b>`,
      '',
      `Статус обращения изменён: <b>${statusLabel}</b>.`,
    ].join('\n'),
    format: 'html',
    attachments: keyboard([
      [
        callbackButton(
          'Открыть обращение',
          `support:user:ticket:${ticket.id}`,
        ),
      ],
    ]),
    purpose: 'linkray_support',
  }).catch(() => {});
  await showAdminTicket(update, adminId, ticket.id);
}

async function askAdminReply(update, adminId, ticketId) {
  const ticket = await loadTicket(ticketId);
  if (!ticket) return showAdminList(update, adminId, 'new');
  await setSession(adminId, 'admin_reply', ticket.id, null);
  await respond(
    update,
    adminId,
    [
      '✉️ <b>Ответ пользователю</b>',
      '',
      `Обращение: <b>${ticketCode(ticket)}</b>`,
      `Получатель: <a href="max://user/${esc(ticket.max_user_id)}">${esc(ticket.display_name || 'Пользователь MAX')}</a>`,
      '',
      'Отправьте следующим сообщением текст, изображение, видео или файл.',
    ].join('\n'),
    [[callbackButton('❌ Отмена', 'support:cancel')]],
  );
}

async function handleAdminReply(adminId, session, item) {
  const ticket = await loadTicket(session.ticket_id);
  if (!ticket) {
    await clearSession(adminId);
    await sendMaxMessage({
      userId: String(adminId),
      text: '⚠️ Обращение не найдено.',
      format: 'html',
      purpose: 'linkray_support_admin',
    });
    return true;
  }
  const message = await insertMessage(
    ticket,
    'admin',
    adminId,
    item,
    false,
  );
  let delivered = true;
  let deliveryError = null;
  try {
    await sendMaxMessage({
      userId: String(ticket.max_user_id),
      text: [
        '💬 <b>Ответ поддержки LinkRay</b>',
        '',
        `Обращение: <b>${ticketCode(ticket)}</b>`,
        '',
        item.text
          ? item.text
          : 'Ответ содержит вложение.',
      ].join('\n'),
      format: item.format || 'html',
      attachments: combineAttachments(
        item.attachments || [],
        [[
          callbackButton(
            '🎫 Открыть обращение',
            `support:user:ticket:${ticket.id}`,
          ),
        ]],
      ),
      markup: [],
      purpose: 'linkray_support_reply',
    });
  } catch (error) {
    delivered = false;
    deliveryError = clean(error?.message || error, 1000);
  }
  await query(`
    UPDATE public.lr_support_messages
    SET delivered=$2,delivery_error=$3
    WHERE id=$1
  `, [
    Number(message.id),
    Boolean(delivered),
    deliveryError,
  ]);
  await query(`
    UPDATE public.lr_support_tickets
    SET
      status='in_progress',
      assigned_admin_id=$2,
      unread_for_user=true,
      unread_for_admin=false,
      last_message_preview=$3,
      last_admin_message_at=now(),
      updated_at=now()
    WHERE id=$1
  `, [
    Number(ticket.id),
    String(adminId),
    short(item.text, 200),
  ]);
  await clearSession(adminId);
  await audit(
    adminId,
    'Пользователю отправлен ответ поддержки',
    ticket,
    {
      user_max_id: ticket.max_user_id,
      delivered,
      delivery_error: deliveryError,
    },
  );
  await sendMaxMessage({
    userId: String(adminId),
    text: delivered
      ? [
          '✅ <b>Ответ отправлен</b>',
          '',
          `Обращение: <b>${ticketCode(ticket)}</b>`,
          `Получатель: ${esc(ticket.display_name || 'Пользователь MAX')}`,
        ].join('\n')
      : [
          '❌ <b>Ответ сохранён, но не доставлен</b>',
          '',
          `Обращение: <b>${ticketCode(ticket)}</b>`,
          `Ошибка: ${esc(deliveryError || 'неизвестно')}`,
        ].join('\n'),
    format: 'html',
    attachments: keyboard([
      [
        callbackButton(
          '🎫 Открыть обращение',
          `support:admin:ticket:${ticket.id}`,
        ),
      ],
    ]),
    purpose: 'linkray_support_admin',
  });
  return true;
}

async function closeUserTicket(update, maxUserId, ticketId) {
  const user = await getUser(maxUserId);
  const ticket = await loadTicket(ticketId);
  if (!user || !ticket || Number(ticket.user_id) !== Number(user.id)) {
    return showUserTickets(update, maxUserId);
  }
  await query(`
    UPDATE public.lr_support_tickets
    SET
      status='closed',
      closed_at=now(),
      unread_for_admin=true,
      unread_for_user=false,
      updated_at=now()
    WHERE id=$1
  `, [Number(ticket.id)]);
  await notifyAdmins(
    { ...ticket, status: 'closed' },
    {
      text: 'Пользователь закрыл обращение.',
      attachments: [],
    },
    true,
  );
  await showUserTicket(update, maxUserId, ticket.id);
}

async function handleAction(update, maxUserId, action) {
  if (action === 'support:open') {
    await clearSession(maxUserId);
    return showUserHome(update, maxUserId);
  }
  if (action === 'support:new:question') {
    return askUserMessage(update, maxUserId, 'question');
  }
  if (action === 'support:new:suggestion') {
    return askUserMessage(update, maxUserId, 'suggestion');
  }
  if (action === 'support:mine') {
    await clearSession(maxUserId);
    return showUserTickets(update, maxUserId);
  }
  if (action === 'support:cancel') {
    const currentSession = await getSession(maxUserId);
    await clearSession(maxUserId);
    if (
      currentSession.state === 'admin_reply' &&
      await isAdmin(maxUserId)
    ) {
      return showAdminList(update, maxUserId, 'new');
    }
    return showUserHome(update, maxUserId);
  }
  let match = action.match(/^support:user:ticket:(\d+)$/);
  if (match) {
    return showUserTicket(update, maxUserId, Number(match[1]));
  }
  match = action.match(/^support:user:reply:(\d+)$/);
  if (match) {
    const ticket = await loadTicket(Number(match[1]));
    return askUserMessage(
      update,
      maxUserId,
      ticket?.category || 'question',
      Number(match[1]),
    );
  }
  match = action.match(/^support:user:close:(\d+)$/);
  if (match) {
    return closeUserTicket(update, maxUserId, Number(match[1]));
  }
  if (!action.startsWith('support:admin:')) return false;
  if (!(await isAdmin(maxUserId))) return false;
  if (action === 'support:admin:clear:closed:confirm') {
    return showSupportClearConfirm(update, maxUserId, 'closed', true);
  }
  if (action === 'support:admin:clear:closed:run') {
    return clearSupportDatabase(update, maxUserId, 'closed');
  }
  if (action === 'support:admin:clear:all:confirm') {
    return showSupportClearConfirm(update, maxUserId, 'all', false);
  }
  if (action === 'support:admin:clear:all:confirm2') {
    return showSupportClearConfirm(update, maxUserId, 'all', true);
  }
  if (action === 'support:admin:clear:all:run') {
    return clearSupportDatabase(update, maxUserId, 'all');
  }
  match = action.match(/^support:admin:list(?::(new|in_progress|closed|all))?$/);
  if (match) {
    await clearSession(maxUserId);
    return showAdminList(update, maxUserId, match[1] || 'new');
  }
  match = action.match(/^support:admin:ticket:(\d+)$/);
  if (match) {
    await clearSession(maxUserId);
    return showAdminTicket(update, maxUserId, Number(match[1]));
  }
  match = action.match(/^support:admin:take:(\d+)$/);
  if (match) {
    return setTicketStatus(
      update,
      maxUserId,
      Number(match[1]),
      'in_progress',
    );
  }
  match = action.match(/^support:admin:reply:(\d+)$/);
  if (match) {
    return askAdminReply(update, maxUserId, Number(match[1]));
  }
  match = action.match(/^support:admin:close:(\d+)$/);
  if (match) {
    return setTicketStatus(
      update,
      maxUserId,
      Number(match[1]),
      'closed',
    );
  }
  match = action.match(/^support:admin:reopen:(\d+)$/);
  if (match) {
    return setTicketStatus(
      update,
      maxUserId,
      Number(match[1]),
      'in_progress',
    );
  }
  return false;
}

export function addSupportAdminMenuRow(sourceRows = []) {
  const output = Array.isArray(sourceRows)
    ? sourceRows.map((row) =>
        Array.isArray(row) ? [...row] : row,
      )
    : [];
  const serialized = JSON.stringify(output);
  if (serialized.includes('support:admin:list')) {
    return output;
  }
  const supportRow = [
    callbackButton(
      '🎫 Поддержка',
      'support:admin:list:new',
    ),
  ];
  const index = Math.max(0, output.length - 1);
  output.splice(index, 0, supportRow);
  return output;
}

export async function supportCenterSmokeTest() {
  await ensureSchema();
  const stats = rows(await query(`
    SELECT
      (SELECT COUNT(*) FROM public.lr_support_tickets)::integer AS tickets,
      (SELECT COUNT(*) FROM public.lr_support_messages)::integer AS messages,
      (SELECT COUNT(*) FROM public.lr_support_sessions)::integer AS sessions
  `))[0] || {};
  return {
    ok: true,
    tickets: Number(stats.tickets || 0),
    messages: Number(stats.messages || 0),
    sessions: Number(stats.sessions || 0),
  };
}

export function installUserSupportCenter(app) {
  if (installed) return;
  installed = true;
  if (!app?.use) {
    throw new Error('Express app is required');
  }
  app.use(async function userSupportCenterMiddleware(
    req,
    res,
    next,
  ) {
    try {
      if (req.method !== 'POST') return next();
      const update = req.body || {};
      const maxUserId = userId(update);
      if (!maxUserId) return next();
      const action = payload(update);
      await ensureSchema();
      if (action.startsWith('support:')) {
        const handled = await handleAction(
          update,
          maxUserId,
          action,
        );
        if (handled !== false) {
          return res.json({
            ok: true,
            support_center: true,
          });
        }
        return next();
      }
      const session = await getSession(maxUserId);
      if (![
        'user_new',
        'user_reply',
        'admin_reply',
      ].includes(session.state)) {
        return next();
      }
      const item = content(update);
      if (!item) return next();
      const handled =
        session.state === 'admin_reply'
          ? await handleAdminReply(
              maxUserId,
              session,
              item,
            )
          : await handleUserInput(
              maxUserId,
              session,
              item,
            );
      if (handled) {
        return res.json({
          ok: true,
          support_center: true,
        });
      }
      return next();
    } catch (error) {
      console.error(
        '[support center middleware]',
        error?.stack || error?.message || error,
      );
      return next();
    }
  });
}

