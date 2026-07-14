import { createHash } from 'node:crypto';

import { query } from './db.js';

import {
  sendMaxMessage,
  answerCallback,
  callbackButton,
  inlineKeyboard,
} from './maxClient.js';

const rows = (result) =>
  Array.isArray(result)
    ? result
    : (result?.rows || []);

const clean = (value, max = 4000) =>
  String(value ?? '')
    .trim()
    .slice(0, max);

const num = (value) =>
  Number.isFinite(Number(value))
    ? Number(value)
    : 0;

const fmt = (value) =>
  new Intl.NumberFormat('ru-RU')
    .format(num(value));

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const short = (value, max = 34) => {
  const text = clean(value || 'Без названия', 500);

  return text.length > max
    ? `${text.slice(0, Math.max(1, max - 1))}…`
    : text;
};

const formatDate = (value) => {
  const date = value ? new Date(value) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat(
    'ru-RU',
    {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    },
  ).format(date);
};

const callbackId = (update) =>
  clean(
    update?.callback?.callback_id ||
    update?.callback?.callbackId ||
    update?.callback?.id ||
    update?.message_callback?.callback_id ||
    update?.message_callback?.callbackId ||
    '',
    500,
  );

const messageText = (update) =>
  clean(
    update?.message?.body?.text ||
    update?.message?.text ||
    update?.body?.message?.body?.text ||
    update?.body?.text ||
    update?.text ||
    '',
    5000,
  );

async function safe(sql, params = []) {
  try {
    return rows(
      await query(sql, params),
    );
  } catch (error) {
    console.error(
      '[admin operations sql]',
      error?.message || error,
    );

    return [];
  }
}

async function tableExists(tableName) {
  const result = await safe(
    'SELECT to_regclass($1) AS name',
    [`public.${tableName}`],
  );

  return Boolean(result[0]?.name);
}

async function tableColumns(tableName) {
  const result = await safe(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name=$1`,
    [String(tableName)],
  );

  return new Set(
    result.map((row) =>
      String(row.column_name),
    ),
  );
}

function ident(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function isAdmin(maxUserId) {
  const result = await safe(
    `SELECT 1
     FROM public.lr_admins
     WHERE max_user_id=$1
       AND is_active=true
     LIMIT 1`,
    [String(maxUserId)],
  );

  return result.length > 0;
}

async function setSession(
  adminId,
  state,
  data = {},
) {
  await query(
    `INSERT INTO public.lr_admin_sessions(
       admin_user_id,
       state,
       data,
       updated_at
     )
     VALUES($1,$2,$3::jsonb,now())
     ON CONFLICT(admin_user_id)
     DO UPDATE SET
       state=EXCLUDED.state,
       data=EXCLUDED.data,
       updated_at=now()`,
    [
      String(adminId),
      String(state),
      JSON.stringify(data),
    ],
  );
}

async function audit(
  adminId,
  action,
  targetId = null,
  details = {},
) {
  await query(
    `INSERT INTO public.lr_admin_audit(
       admin_user_id,
       action,
       target_id,
       details
     )
     VALUES($1,$2,$3,$4::jsonb)`,
    [
      String(adminId),
      String(action),
      targetId === null
        ? null
        : String(targetId),
      JSON.stringify(details),
    ],
  ).catch(() => {});
}

async function respond(
  update,
  adminId,
  text,
  buttonRows = [],
  notification = '',
) {
  const id = callbackId(update);
  const attachments = buttonRows.length
    ? inlineKeyboard(buttonRows)
    : [];

  if (id) {
    try {
      await answerCallback({
        callbackId: id,
        text,
        format: 'html',
        attachments,
        notification,
      });

      return;
    } catch (error) {
      console.error(
        '[admin operations callback]',
        error?.message || error,
      );
    }
  }

  await sendMaxMessage({
    userId: String(adminId),
    text,
    format: 'html',
    attachments,
    purpose: 'admin_operations_center',
  });
}

function profileCode(user) {
  return `LR-${String(
    user?.profile_number ||
    user?.id ||
    0,
  ).padStart(6, '0')}`;
}

function normalizeChannelLink(value) {
  let link = clean(value, 2000);

  if (!link) {
    return '';
  }

  if (
    /^(?:max\.ru|www\.max\.ru|i\.oneme\.ru)\//i
      .test(link)
  ) {
    link = `https://${link}`;
  }

  if (
    /^http:\/\/(?:www\.)?max\.ru\//i
      .test(link)
  ) {
    link = link.replace(
      /^http:/i,
      'https:',
    );
  }

  return (
    /^https:\/\/(?:[a-z0-9-]+\.)?max\.ru\//i
      .test(link) ||
    /^https:\/\/i\.oneme\.ru\//i
      .test(link)
  )
    ? link
    : '';
}

function channelTitle(channel) {
  const title = esc(
    channel?.title ||
    `Канал №${channel?.id || '—'}`,
  );

  const link =
    normalizeChannelLink(channel?.link);

  return link
    ? `<a href="${esc(link)}">${title}</a>`
    : `<b>${title}</b>`;
}

function fingerprint(...parts) {
  return createHash('sha256')
    .update(
      parts
        .map((part) => String(part ?? ''))
        .join('\u001f'),
    )
    .digest('hex');
}

function categoryMeta(category) {
  const value = String(category || '');

  const map = {
    publication:
      ['📝', 'Публикация'],
    analytics:
      ['📊', 'Аналитика'],
    rights:
      ['🔐', 'Права канала'],
    broadcast:
      ['📨', 'Рассылка'],
    system:
      ['🖥', 'Система'],
  };

  return map[value] || ['⚠️', 'Другая ошибка'];
}

export function adminOperationsMainRows() {
  return [
    [
      callbackButton(
        '🔄 Обновить',
        'admin:menu',
      ),
    ],
    [
      callbackButton(
        '📨 Рассылки',
        'admin:broadcasts',
      ),
      callbackButton(
        '👥 Пользователи',
        'admin:users',
      ),
    ],
    [
      callbackButton(
        '📢 Каналы',
        'admin:channels',
      ),
      callbackButton(
        '🔎 Поиск',
        'admin:tool:ops:search',
      ),
    ],
    [
      callbackButton(
        '🩺 Диагностика',
        'admin:tool:ops:diagnostics',
      ),
      callbackButton(
        '⚠️ Центр ошибок',
        'admin:tool:ops:errors',
      ),
    ],
    [
      callbackButton(
        '💎 Подписки',
        'admin:subscriptions',
      ),
      callbackButton(
        '📜 Журнал',
        'admin:logs',
      ),
    ],
    [
      callbackButton(
        '⬅️ Главное меню',
        'main:menu',
      ),
    ],
  ];
}

export async function ensureAdminOperationsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS public.lr_admin_errors (
      id bigserial PRIMARY KEY,
      fingerprint text NOT NULL UNIQUE,
      category text NOT NULL,
      source_table text,
      source_id text,
      channel_id integer,
      user_id bigint,
      title text NOT NULL,
      message text,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'open',
      occurrences integer NOT NULL DEFAULT 1,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      resolved_by text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS
      lr_admin_errors_status_last_seen_idx
    ON public.lr_admin_errors(
      status,
      last_seen_at DESC
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS
      lr_admin_errors_channel_idx
    ON public.lr_admin_errors(
      channel_id,
      status
    )
  `);
}

async function upsertOperationalError({
  category,
  sourceTable,
  sourceId,
  channelId = null,
  userId = null,
  title,
  message,
  details = {},
}) {
  const key = fingerprint(
    category,
    sourceTable,
    sourceId,
    channelId,
    message,
  );

  await query(
    `INSERT INTO public.lr_admin_errors(
       fingerprint,
       category,
       source_table,
       source_id,
       channel_id,
       user_id,
       title,
       message,
       details,
       status,
       first_seen_at,
       last_seen_at,
       updated_at
     )
     VALUES(
       $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,
       'open',now(),now(),now()
     )
     ON CONFLICT(fingerprint)
     DO UPDATE SET
       category=EXCLUDED.category,
       source_table=EXCLUDED.source_table,
       source_id=EXCLUDED.source_id,
       channel_id=EXCLUDED.channel_id,
       user_id=EXCLUDED.user_id,
       title=EXCLUDED.title,
       message=EXCLUDED.message,
       details=EXCLUDED.details,
       status='open',
       occurrences=
         public.lr_admin_errors.occurrences +
         CASE
           WHEN public.lr_admin_errors.last_seen_at
                < now() - interval '5 minutes'
           THEN 1
           ELSE 0
         END,
       last_seen_at=now(),
       resolved_at=NULL,
       resolved_by=NULL,
       updated_at=now()`,
    [
      key,
      category,
      sourceTable,
      String(sourceId ?? ''),
      channelId === null
        ? null
        : Number(channelId),
      userId === null
        ? null
        : Number(userId),
      clean(title, 500),
      clean(message, 4000),
      JSON.stringify(details),
    ],
  );
}

async function loadChannelMap() {
  const channels = await safe(`
    SELECT
      id,
      max_chat_id,
      title,
      link
    FROM public.channels
  `);

  const map = new Map();

  for (const channel of channels) {
    map.set(
      String(channel.id),
      channel,
    );

    if (channel.max_chat_id !== null) {
      map.set(
        String(channel.max_chat_id),
        channel,
      );
    }
  }

  return map;
}

async function scanFailedPosts(
  channelMap,
  scannedCategories,
) {
  if (
    !(await tableExists('scheduled_posts'))
  ) {
    return;
  }

  const columns =
    await tableColumns('scheduled_posts');

  if (
    !columns.has('id') ||
    !columns.has('status')
  ) {
    return;
  }

  const errorColumn = [
    'error_message',
    'last_error',
    'error',
  ].find((name) => columns.has(name));

  const channelExpression =
    columns.has('channel_id')
      ? 'channel_id::text'
      : 'NULL::text';

  const errorExpression =
    errorColumn
      ? `${ident(errorColumn)}::text`
      : 'NULL::text';

  const eventExpression = [
    'updated_at',
    'published_at',
    'created_at',
  ].find((name) => columns.has(name));

  const eventSql =
    eventExpression
      ? `${ident(eventExpression)}`
      : 'now()';

  const condition = errorColumn
    ? `status::text IN ('failed','error')
       OR NULLIF(BTRIM(${ident(errorColumn)}::text),'') IS NOT NULL`
    : `status::text IN ('failed','error')`;

  const failed = await safe(`
    SELECT
      id::text AS source_id,
      ${channelExpression} AS channel_ref,
      status::text AS state,
      ${errorExpression} AS error_text,
      ${eventSql} AS event_at
    FROM public.scheduled_posts
    WHERE ${condition}
    ORDER BY ${eventSql} DESC NULLS LAST
    LIMIT 150
  `);

  scannedCategories.add('publication');

  for (const item of failed) {
    const channel =
      channelMap.get(
        String(item.channel_ref || ''),
      );

    const message =
      clean(
        item.error_text ||
        `Статус публикации: ${item.state}`,
        4000,
      );

    await upsertOperationalError({
      category: 'publication',
      sourceTable: 'scheduled_posts',
      sourceId: item.source_id,
      channelId: channel?.id || null,
      title: channel
        ? `Ошибка публикации · ${channel.title}`
        : `Ошибка публикации №${item.source_id}`,
      message,
      details: {
        status: item.state,
        event_at: item.event_at,
        channel_ref: item.channel_ref,
      },
    });
  }
}

async function scanChannelStateErrors(
  tableName,
  category,
  titlePrefix,
  channelMap,
  scannedCategories,
) {
  if (!(await tableExists(tableName))) {
    return;
  }

  const columns =
    await tableColumns(tableName);

  if (
    !columns.has('channel_id') ||
    !columns.has('last_error')
  ) {
    return;
  }

  const eventColumn = [
    'updated_at',
    'last_success_at',
    'first_seen_at',
  ].find((name) => columns.has(name));

  const eventSql = eventColumn
    ? ident(eventColumn)
    : 'now()';

  const items = await safe(`
    SELECT
      channel_id::text AS channel_ref,
      last_error::text AS error_text,
      ${eventSql} AS event_at
    FROM public.${ident(tableName)}
    WHERE NULLIF(BTRIM(last_error::text),'') IS NOT NULL
    ORDER BY ${eventSql} DESC NULLS LAST
    LIMIT 150
  `);

  scannedCategories.add(category);

  for (const item of items) {
    const channel =
      channelMap.get(
        String(item.channel_ref || ''),
      );

    await upsertOperationalError({
      category,
      sourceTable: tableName,
      sourceId: item.channel_ref,
      channelId: channel?.id || null,
      title: channel
        ? `${titlePrefix} · ${channel.title}`
        : `${titlePrefix} · ${item.channel_ref}`,
      message: item.error_text,
      details: {
        event_at: item.event_at,
        channel_ref: item.channel_ref,
      },
    });
  }
}

async function scanBroadcastErrors(
  scannedCategories,
) {
  if (!(await tableExists('lr_broadcasts'))) {
    return;
  }

  const columns =
    await tableColumns('lr_broadcasts');

  if (
    !columns.has('id') ||
    !columns.has('status')
  ) {
    return;
  }

  const errorColumn = [
    'error_message',
    'last_error',
    'error',
  ].find((name) => columns.has(name));

  const eventColumn = [
    'updated_at',
    'finished_at',
    'created_at',
  ].find((name) => columns.has(name));

  const eventSql = eventColumn
    ? ident(eventColumn)
    : 'now()';

  const errorSql = errorColumn
    ? `${ident(errorColumn)}::text`
    : 'NULL::text';

  const condition = errorColumn
    ? `status::text IN ('failed','error')
       OR NULLIF(BTRIM(${ident(errorColumn)}::text),'') IS NOT NULL`
    : `status::text IN ('failed','error')`;

  const items = await safe(`
    SELECT
      id::text AS source_id,
      status::text AS state,
      ${errorSql} AS error_text,
      ${eventSql} AS event_at
    FROM public.lr_broadcasts
    WHERE ${condition}
    ORDER BY ${eventSql} DESC NULLS LAST
    LIMIT 100
  `);

  scannedCategories.add('broadcast');

  for (const item of items) {
    await upsertOperationalError({
      category: 'broadcast',
      sourceTable: 'lr_broadcasts',
      sourceId: item.source_id,
      title:
        `Ошибка рассылки №${item.source_id}`,
      message:
        item.error_text ||
        `Статус рассылки: ${item.state}`,
      details: {
        status: item.state,
        event_at: item.event_at,
      },
    });
  }
}

export async function syncAdminOperationalErrors() {
  await ensureAdminOperationsSchema();

  const scanStarted =
    new Date().toISOString();

  const scannedCategories =
    new Set();

  const channelMap =
    await loadChannelMap();

  await scanFailedPosts(
    channelMap,
    scannedCategories,
  );

  await scanChannelStateErrors(
    'lr_channel_metrics_state',
    'analytics',
    'Ошибка аналитики',
    channelMap,
    scannedCategories,
  );

  await scanChannelStateErrors(
    'lr_channel_team_sync_state',
    'rights',
    'Ошибка проверки прав',
    channelMap,
    scannedCategories,
  );

  await scanBroadcastErrors(
    scannedCategories,
  );

  const categories =
    [...scannedCategories];

  if (categories.length) {
    await query(
      `UPDATE public.lr_admin_errors
       SET
         status='resolved',
         resolved_at=COALESCE(
           resolved_at,
           now()
         ),
         resolved_by=COALESCE(
           resolved_by,
           'system'
         ),
         details=
           details ||
           '{"auto_resolved":true}'::jsonb,
         updated_at=now()
       WHERE status='open'
         AND category=ANY($1::text[])
         AND last_seen_at < $2::timestamptz`,
      [
        categories,
        scanStarted,
      ],
    );
  }

  return {
    scannedCategories: categories,
  };
}

async function beginSearch(
  update,
  adminId,
) {
  await setSession(
    adminId,
    'ops_search_wait',
    {},
  );

  await respond(
    update,
    adminId,
    [
      '🔎 <b>Поиск в LinkRay</b>',
      '',
      'Отправьте одним сообщением:',
      '• имя пользователя;',
      '• LR-ID, например <code>LR-000002</code>;',
      '• MAX ID пользователя;',
      '• название или ссылку канала;',
      '• MAX ID или внутренний ID канала.',
    ].join('\n'),
    [
      [
        callbackButton(
          '❌ Отмена',
          'admin:tool:ops:cancel',
        ),
      ],
    ],
  );
}

async function searchUsers(term) {
  const search =
    `%${term.replace(/[%_]/g, '\\$&')}%`;

  const clauses = [
    `u.display_name ILIKE $1 ESCAPE '\\'`,
  ];

  const params = [search];

  const lrMatch =
    term.match(/^LR[-\s]*0*(\d+)$/i);

  if (lrMatch) {
    params.push(
      Number(lrMatch[1]),
    );

    clauses.push(
      `u.profile_number=$${params.length}`,
    );
  }

  if (/^\d+$/.test(term)) {
    params.push(term);

    clauses.push(
      `u.max_user_id=$${params.length}`,
    );

    const profileNumber =
      Number(term);

    if (
      Number.isSafeInteger(profileNumber)
    ) {
      params.push(profileNumber);

      clauses.push(
        `u.profile_number=$${params.length}`,
      );
    }
  }

  return safe(
    `SELECT
       u.id,
       u.profile_number,
       u.max_user_id,
       u.display_name,
       u.is_blocked,
       u.last_seen_at,
       COUNT(
         DISTINCT uc.channel_id
       )::integer AS channels
     FROM public.lr_users u
     LEFT JOIN public.lr_user_channels uc
       ON uc.user_id=u.id
     WHERE
       u.max_user_id ~ '^\\d+$'
       AND COALESCE(
         u.raw_profile->>'is_bot',
         'false'
       )<>'true'
       AND LOWER(
         COALESCE(
           u.display_name,
           ''
         )
       )<>'пользователь max'
       AND (${clauses.join(' OR ')})
     GROUP BY
       u.id,
       u.profile_number,
       u.max_user_id,
       u.display_name,
       u.is_blocked,
       u.last_seen_at
     ORDER BY
       COALESCE(
         u.profile_number,
         u.id
       )
     LIMIT 10`,
    params,
  );
}

async function searchChannels(term) {
  const search =
    `%${term.replace(/[%_]/g, '\\$&')}%`;

  const clauses = [
    `c.title ILIKE $1 ESCAPE '\\'`,
    `COALESCE(c.link,'') ILIKE $1 ESCAPE '\\'`,
  ];

  const params = [search];

  if (/^-?\d+$/.test(term)) {
    params.push(term);

    clauses.push(
      `c.id::text=$${params.length}`,
    );

    params.push(term);

    clauses.push(
      `c.max_chat_id::text=$${params.length}`,
    );
  }

  return safe(
    `SELECT
       c.id,
       c.max_chat_id,
       c.title,
       c.link,
       c.is_active,
       COUNT(
         DISTINCT uc.user_id
       )::integer AS admins
     FROM public.channels c
     LEFT JOIN public.lr_user_channels uc
       ON uc.channel_id=c.id
     WHERE ${clauses.join(' OR ')}
     GROUP BY
       c.id,
       c.max_chat_id,
       c.title,
       c.link,
       c.is_active
     ORDER BY
       COALESCE(c.is_active,true) DESC,
       c.updated_at DESC NULLS LAST,
       c.id DESC
     LIMIT 10`,
    params,
  );
}

async function showSearchResults(
  update,
  adminId,
  term,
) {
  const normalized =
    clean(term, 500);

  const [
    users,
    channels,
  ] = await Promise.all([
    searchUsers(normalized),
    searchChannels(normalized),
  ]);

  const lines = [
    '🔎 <b>Результаты поиска</b>',
    '',
    `Запрос: <code>${esc(normalized)}</code>`,
    '',
    `Пользователей: <b>${fmt(users.length)}</b>`,
    `Каналов: <b>${fmt(channels.length)}</b>`,
  ];

  const buttons = [];

  for (const user of users) {
    buttons.push([
      callbackButton(
        `${user.is_blocked ? '🔴' : '🟢'} ${profileCode(user)} · ${short(user.display_name, 20)}`,
        `admin:tool:user:${user.id}`,
      ),
    ]);
  }

  for (const channel of channels) {
    buttons.push([
      callbackButton(
        `${channel.is_active === false ? '⚫' : '📢'} ${short(channel.title, 25)}`,
        `admin:tool:ops:channel:${channel.id}`,
      ),
    ]);
  }

  if (
    !users.length &&
    !channels.length
  ) {
    lines.push(
      '',
      'Совпадений не найдено.',
    );
  }

  buttons.push([
    callbackButton(
      '🔎 Новый поиск',
      'admin:tool:ops:search',
    ),
  ]);

  buttons.push([
    callbackButton(
      '⬅️ В админ-панель',
      'admin:menu',
    ),
  ]);

  await respond(
    update,
    adminId,
    lines.join('\n'),
    buttons,
  );
}

async function loadActiveChannels() {
  const channels = await safe(`
    SELECT
      id,
      max_chat_id,
      title,
      link,
      is_active,
      updated_at
    FROM public.channels
    WHERE COALESCE(is_active,true)=true
    ORDER BY id DESC
    LIMIT 500
  `);

  const adminCounts = new Map(
    (
      await safe(`
        SELECT
          channel_id,
          COUNT(
            DISTINCT user_id
          )::integer AS value
        FROM public.lr_user_channels
        GROUP BY channel_id
      `)
    ).map((row) => [
      String(row.channel_id),
      num(row.value),
    ]),
  );

  const metrics = new Map();

  if (
    await tableExists(
      'lr_channel_metrics_state',
    )
  ) {
    const values = await safe(`
      SELECT *
      FROM public.lr_channel_metrics_state
    `);

    for (const value of values) {
      metrics.set(
        String(value.channel_id),
        value,
      );
    }
  }

  const teams = new Map();

  if (
    await tableExists(
      'lr_channel_team_sync_state',
    )
  ) {
    const values = await safe(`
      SELECT *
      FROM public.lr_channel_team_sync_state
    `);

    for (const value of values) {
      teams.set(
        String(value.channel_id),
        value,
      );
    }
  }

  const failedPosts = new Map();

  if (
    await tableExists('scheduled_posts')
  ) {
    const columns =
      await tableColumns('scheduled_posts');

    if (
      columns.has('channel_id') &&
      columns.has('status')
    ) {
      const values = await safe(`
        SELECT
          channel_id,
          COUNT(*) FILTER(
            WHERE status::text IN(
              'failed',
              'error'
            )
          )::integer AS failed,
          COUNT(*) FILTER(
            WHERE status::text IN(
              'scheduled',
              'pending',
              'queued',
              'publishing'
            )
          )::integer AS pending
        FROM public.scheduled_posts
        GROUP BY channel_id
      `);

      for (const value of values) {
        failedPosts.set(
          String(value.channel_id),
          {
            failed: num(value.failed),
            pending: num(value.pending),
          },
        );
      }
    }
  }

  return channels.map((channel) => {
    const metricsTracked =
      metrics.has(String(channel.id)) ||
      metrics.has(
        String(channel.max_chat_id),
      );

    const metricsState =
      metrics.get(String(channel.id)) ||
      metrics.get(
        String(channel.max_chat_id),
      ) ||
      {};

    const teamState =
      teams.get(String(channel.id)) ||
      teams.get(
        String(channel.max_chat_id),
      ) ||
      {};

    return {
      ...channel,
      admins:
        adminCounts.get(
          String(channel.id),
        ) || 0,
      metricsTracked,
      metrics: metricsState,
      team: teamState,
      posts:
        failedPosts.get(
          String(channel.id),
        ) || {
          failed: 0,
          pending: 0,
        },
    };
  });
}

function channelProblems(channel) {
  const problems = [];

  if (!channel.admins) {
    problems.push(
      'нет зарегистрированных администраторов',
    );
  }

  if (channel.team?.last_error) {
    problems.push(
      'ошибка проверки прав',
    );
  } else if (
    !channel.team?.last_success_at
  ) {
    problems.push(
      'права ещё не проверены',
    );
  }

  if (channel.metrics?.last_error) {
    problems.push(
      'ошибка сбора аналитики',
    );
  }

  if (
    channel.metricsTracked &&
    !channel.metrics?.first_seen_at &&
    !channel.metrics?.ready_at
  ) {
    problems.push(
      'таймер аналитики не запущен',
    );
  }

  if (
    channel.metrics?.last_success_at
  ) {
    const age =
      Date.now() -
      new Date(
        channel.metrics.last_success_at,
      ).getTime();

    if (
      Number.isFinite(age) &&
      age > 2 * 60 * 60 * 1000
    ) {
      problems.push(
        'аналитика не обновлялась больше 2 часов',
      );
    }
  }

  if (num(channel.posts?.failed) > 0) {
    problems.push(
      `ошибок публикации: ${fmt(channel.posts.failed)}`,
    );
  }

  return problems;
}

async function collectDiagnostics() {
  const dbStarted = Date.now();

  await query('SELECT 1');

  const dbLatency =
    Date.now() - dbStarted;

  await syncAdminOperationalErrors();

  const channels =
    await loadActiveChannels();

  const problemChannels =
    channels
      .map((channel) => ({
        ...channel,
        problems:
          channelProblems(channel),
      }))
      .filter(
        (channel) =>
          channel.problems.length,
      );

  const userStats = (
    await safe(`
      SELECT
        COUNT(*) FILTER(
          WHERE COALESCE(
            is_blocked,
            false
          )=false
        )::integer AS active,
        COUNT(*) FILTER(
          WHERE last_seen_at >=
            now() - interval '24 hours'
        )::integer AS active_today,
        MAX(last_seen_at)
          AS last_activity
      FROM public.lr_users
      WHERE max_user_id ~ '^\\d+$'
    `)
  )[0] || {};

  const errorStats = (
    await safe(`
      SELECT
        COUNT(*) FILTER(
          WHERE status='open'
        )::integer AS open,
        COUNT(*) FILTER(
          WHERE status='resolved'
        )::integer AS resolved
      FROM public.lr_admin_errors
    `)
  )[0] || {};

  let broadcastStats = {
    running: 0,
    failed: 0,
  };

  if (
    await tableExists('lr_broadcasts')
  ) {
    broadcastStats = (
      await safe(`
        SELECT
          COUNT(*) FILTER(
            WHERE status IN(
              'queued',
              'running'
            )
          )::integer AS running,
          COUNT(*) FILTER(
            WHERE status IN(
              'failed',
              'error'
            )
          )::integer AS failed
        FROM public.lr_broadcasts
      `)
    )[0] || broadcastStats;
  }

  const totals = {
    rightsErrors:
      channels.filter(
        (channel) =>
          channel.team?.last_error,
      ).length,
    analyticsErrors:
      channels.filter(
        (channel) =>
          channel.metrics?.last_error,
      ).length,
    timersMissing:
      channels.filter(
        (channel) =>
          channel.metricsTracked &&
          !channel.metrics?.first_seen_at &&
          !channel.metrics?.ready_at,
      ).length,
    noAdmins:
      channels.filter(
        (channel) =>
          !channel.admins,
      ).length,
    failedPosts:
      channels.reduce(
        (sum, channel) =>
          sum +
          num(channel.posts?.failed),
        0,
      ),
    pendingPosts:
      channels.reduce(
        (sum, channel) =>
          sum +
          num(channel.posts?.pending),
        0,
      ),
  };

  return {
    dbLatency,
    memoryMb:
      Math.round(
        process.memoryUsage().rss /
        1024 /
        1024,
      ),
    uptimeHours:
      Math.floor(
        process.uptime() / 3600,
      ),
    channels,
    problemChannels,
    users: num(userStats.active),
    activeToday:
      num(userStats.active_today),
    lastActivity:
      userStats.last_activity,
    openErrors:
      num(errorStats.open),
    resolvedErrors:
      num(errorStats.resolved),
    broadcastsRunning:
      num(broadcastStats.running),
    broadcastsFailed:
      num(broadcastStats.failed),
    ...totals,
  };
}

async function showDiagnostics(
  update,
  adminId,
) {
  const data =
    await collectDiagnostics();

  const critical =
    data.openErrors > 0 ||
    data.failedPosts > 0 ||
    data.rightsErrors > 0 ||
    data.analyticsErrors > 0;

  const warning =
    data.timersMissing > 0 ||
    data.noAdmins > 0;

  const status = critical
    ? '🔴 Требуется внимание'
    : warning
      ? '🟡 Есть предупреждения'
      : '🟢 Всё работает нормально';

  const lines = [
    '🩺 <b>Диагностика LinkRay</b>',
    '',
    `Общий статус: <b>${status}</b>`,
    '',
    '🖥 <b>Система</b>',
    `Приложение: <b>работает</b>`,
    `PostgreSQL: <b>${fmt(data.dbLatency)} мс</b>`,
    `Время работы: <b>${fmt(data.uptimeHours)} ч.</b>`,
    `Память процесса: <b>${fmt(data.memoryMb)} МБ</b>`,
    '',
    '👥 <b>Пользователи</b>',
    `Всего активных: <b>${fmt(data.users)}</b>`,
    `Активны за сутки: <b>${fmt(data.activeToday)}</b>`,
    `Последняя активность: ${formatDate(data.lastActivity)}`,
    '',
    '📢 <b>Каналы и публикации</b>',
    `Активных каналов: <b>${fmt(data.channels.length)}</b>`,
    `Проблемных каналов: <b>${fmt(data.problemChannels.length)}</b>`,
    `Без администраторов: <b>${fmt(data.noAdmins)}</b>`,
    `Таймер не запущен: <b>${fmt(data.timersMissing)}</b>`,
    `Ошибки прав: <b>${fmt(data.rightsErrors)}</b>`,
    `Ошибки аналитики: <b>${fmt(data.analyticsErrors)}</b>`,
    `Ошибки публикаций: <b>${fmt(data.failedPosts)}</b>`,
    `В очереди публикаций: <b>${fmt(data.pendingPosts)}</b>`,
    '',
    '⚠️ <b>Центр ошибок</b>',
    `Открытых: <b>${fmt(data.openErrors)}</b>`,
    `Решённых: <b>${fmt(data.resolvedErrors)}</b>`,
    `Активных рассылок: <b>${fmt(data.broadcastsRunning)}</b>`,
    `Ошибок рассылок: <b>${fmt(data.broadcastsFailed)}</b>`,
  ];

  const buttons =
    data.problemChannels
      .slice(0, 7)
      .map((channel) => [
        callbackButton(
          `⚠️ ${short(channel.title, 27)}`,
          `admin:tool:ops:channel:${channel.id}`,
        ),
      ]);

  buttons.push([
    callbackButton(
      '⚠️ Центр ошибок',
      'admin:tool:ops:errors',
    ),
    callbackButton(
      '🔄 Обновить',
      'admin:tool:ops:diagnostics',
    ),
  ]);

  buttons.push([
    callbackButton(
      '⬅️ В админ-панель',
      'admin:menu',
    ),
  ]);

  await respond(
    update,
    adminId,
    lines.join('\n'),
    buttons,
  );
}

async function loadChannelDiagnostic(
  channelId,
) {
  const channels =
    await loadActiveChannels();

  let channel =
    channels.find(
      (item) =>
        Number(item.id) ===
        Number(channelId),
    );

  if (!channel) {
    const base = (
      await safe(
        `SELECT *
         FROM public.channels
         WHERE id=$1
         LIMIT 1`,
        [Number(channelId)],
      )
    )[0];

    if (!base) {
      return null;
    }

    channel = {
      ...base,
      admins: 0,
      metrics: {},
      team: {},
      posts: {
        failed: 0,
        pending: 0,
      },
    };
  }

  return {
    ...channel,
    problems:
      channelProblems(channel),
  };
}

async function showChannelDiagnostics(
  update,
  adminId,
  channelId,
) {
  const channel =
    await loadChannelDiagnostic(channelId);

  if (!channel) {
    await respond(
      update,
      adminId,
      '⚠️ Канал не найден.',
      [
        [
          callbackButton(
            '⬅️ К диагностике',
            'admin:tool:ops:diagnostics',
          ),
        ],
      ],
    );

    return;
  }

  const ready = Boolean(
    channel.metrics?.ready_at &&
    new Date(
      channel.metrics.ready_at,
    ).getTime() <= Date.now() &&
    num(
      channel.metrics?.success_count,
    ) >= 2,
  );

  const lines = [
    '🩺 <b>Диагностика канала</b>',
    '',
    channelTitle(channel),
    '',
    `Статус канала: <b>${channel.is_active === false ? 'отключён' : 'активен'}</b>`,
    `Пользователей LinkRay: <b>${fmt(channel.admins)}</b>`,
    '',
    '🔐 <b>Права и команда</b>',
    `Последняя успешная проверка: ${formatDate(channel.team?.last_success_at)}`,
    `Администраторов MAX: <b>${fmt(channel.team?.admins_seen)}</b>`,
    `Ошибка: ${channel.team?.last_error ? esc(channel.team.last_error) : 'нет'}`,
    '',
    '📊 <b>Аналитика</b>',
    `Отчёт готов: <b>${ready ? 'да' : 'нет'}</b>`,
    `Первый запуск: ${formatDate(channel.metrics?.first_seen_at)}`,
    `Готовность отчёта: ${formatDate(channel.metrics?.ready_at)}`,
    `Успешных замеров: <b>${fmt(channel.metrics?.success_count)}</b>`,
    `Последний замер: ${formatDate(channel.metrics?.last_success_at)}`,
    `Ошибка: ${channel.metrics?.last_error ? esc(channel.metrics.last_error) : 'нет'}`,
    '',
    '📝 <b>Публикации</b>',
    `В очереди: <b>${fmt(channel.posts?.pending)}</b>`,
    `Ошибок: <b>${fmt(channel.posts?.failed)}</b>`,
    '',
    `Итог: <b>${channel.problems.length ? 'требуется внимание' : 'проблем не найдено'}</b>`,
  ];

  if (channel.problems.length) {
    lines.push(
      '',
      'Обнаружено:',
      ...channel.problems.map(
        (problem) =>
          `• ${esc(problem)}`,
      ),
    );
  }

  await respond(
    update,
    adminId,
    lines.join('\n'),
    [
      [
        callbackButton(
          '🔐 Проверить права',
          `admin:tool:channel:${channel.id}:sync`,
        ),
        callbackButton(
          '📊 Аналитика',
          `admin:tool:channel:${channel.id}:analytics`,
        ),
      ],
      [
        callbackButton(
          '📢 Карточка канала',
          `admin:tool:channel:${channel.id}`,
        ),
        callbackButton(
          '⚠️ Ошибки',
          'admin:tool:ops:errors',
        ),
      ],
      [
        callbackButton(
          '⬅️ К диагностике',
          'admin:tool:ops:diagnostics',
        ),
      ],
    ],
  );
}

async function errorCounts() {
  return (
    await safe(`
      SELECT
        COUNT(*) FILTER(
          WHERE status='open'
        )::integer AS open,
        COUNT(*) FILTER(
          WHERE status='resolved'
        )::integer AS resolved
      FROM public.lr_admin_errors
    `)
  )[0] || {
    open: 0,
    resolved: 0,
  };
}

async function showErrors(
  update,
  adminId,
  status = 'open',
) {
  await syncAdminOperationalErrors();

  const state =
    status === 'resolved'
      ? 'resolved'
      : 'open';

  const counts =
    await errorCounts();

  const list = await safe(
    `SELECT
       error.*,
       channel.title AS channel_title,
       channel.link AS channel_link
     FROM public.lr_admin_errors error
     LEFT JOIN public.channels channel
       ON channel.id=error.channel_id
     WHERE error.status=$1
     ORDER BY
       error.last_seen_at DESC,
       error.id DESC
     LIMIT 15`,
    [state],
  );

  const lines = [
    '⚠️ <b>Центр ошибок LinkRay</b>',
    '',
    `Открытых: <b>${fmt(counts.open)}</b>`,
    `Решённых: <b>${fmt(counts.resolved)}</b>`,
    '',
    state === 'open'
      ? 'Текущие проблемы:'
      : 'Решённые проблемы:',
  ];

  const buttons = [];

  for (const error of list) {
    const [emoji] =
      categoryMeta(error.category);

    buttons.push([
      callbackButton(
        `${emoji} ${short(error.title, 29)}`,
        `admin:tool:ops:error:${error.id}`,
      ),
    ]);
  }

  if (!list.length) {
    lines.push(
      '',
      state === 'open'
        ? '🟢 Открытых ошибок нет.'
        : 'Решённых ошибок пока нет.',
    );
  }

  buttons.push([
    callbackButton(
      state === 'open'
        ? '✅ Решённые'
        : '⚠️ Открытые',
      state === 'open'
        ? 'admin:tool:ops:errors:resolved'
        : 'admin:tool:ops:errors',
    ),
    callbackButton(
      '🔄 Обновить',
      state === 'open'
        ? 'admin:tool:ops:errors'
        : 'admin:tool:ops:errors:resolved',
    ),
  ]);

  buttons.push([
    callbackButton(
      '⬅️ В админ-панель',
      'admin:menu',
    ),
  ]);

  await respond(
    update,
    adminId,
    lines.join('\n'),
    buttons,
  );
}

async function loadError(errorId) {
  return (
    await safe(
      `SELECT
         error.*,
         channel.title AS channel_title,
         channel.link AS channel_link
       FROM public.lr_admin_errors error
       LEFT JOIN public.channels channel
         ON channel.id=error.channel_id
       WHERE error.id=$1
       LIMIT 1`,
      [Number(errorId)],
    )
  )[0] || null;
}

async function showErrorCard(
  update,
  adminId,
  errorId,
) {
  const error =
    await loadError(errorId);

  if (!error) {
    await showErrors(
      update,
      adminId,
      'open',
    );

    return;
  }

  const [
    emoji,
    categoryTitle,
  ] = categoryMeta(error.category);

  const lines = [
    `${emoji} <b>${esc(error.title)}</b>`,
    '',
    `Категория: <b>${esc(categoryTitle)}</b>`,
    `Статус: <b>${error.status === 'resolved' ? 'решена' : 'открыта'}</b>`,
    `Повторений: <b>${fmt(error.occurrences)}</b>`,
    `Впервые: ${formatDate(error.first_seen_at)}`,
    `Последний раз: ${formatDate(error.last_seen_at)}`,
  ];

  if (error.channel_title) {
    lines.push(
      `Канал: ${channelTitle({
        id: error.channel_id,
        title: error.channel_title,
        link: error.channel_link,
      })}`,
    );
  }

  if (error.source_table) {
    lines.push(
      `Источник: <code>${esc(error.source_table)}:${esc(error.source_id)}</code>`,
    );
  }

  lines.push(
    '',
    '<b>Описание</b>',
    esc(
      error.message ||
      'Описание отсутствует.',
    ),
  );

  const buttons = [];

  if (error.channel_id) {
    buttons.push([
      callbackButton(
        '🩺 Диагностика канала',
        `admin:tool:ops:channel:${error.channel_id}`,
      ),
      callbackButton(
        '📢 Карточка канала',
        `admin:tool:channel:${error.channel_id}`,
      ),
    ]);
  }

  buttons.push([
    callbackButton(
      error.status === 'resolved'
        ? '↩️ Вернуть в открытые'
        : '✅ Пометить решённой',
      error.status === 'resolved'
        ? `admin:tool:ops:error:${error.id}:reopen`
        : `admin:tool:ops:error:${error.id}:resolve`,
    ),
  ]);

  buttons.push([
    callbackButton(
      '⬅️ К ошибкам',
      error.status === 'resolved'
        ? 'admin:tool:ops:errors:resolved'
        : 'admin:tool:ops:errors',
    ),
  ]);

  await respond(
    update,
    adminId,
    lines.join('\n'),
    buttons,
  );
}

async function setErrorStatus(
  update,
  adminId,
  errorId,
  status,
) {
  const resolved =
    status === 'resolved';

  const error = (
    await safe(
      `UPDATE public.lr_admin_errors
       SET
         status=$2,
         resolved_at=
           CASE
             WHEN $2='resolved'
             THEN now()
             ELSE NULL
           END,
         resolved_by=
           CASE
             WHEN $2='resolved'
             THEN $3
             ELSE NULL
           END,
         updated_at=now()
       WHERE id=$1
       RETURNING *`,
      [
        Number(errorId),
        resolved
          ? 'resolved'
          : 'open',
        String(adminId),
      ],
    )
  )[0];

  await showErrorCard(
    update,
    adminId,
    errorId,
  );
}

export async function handleAdminOperationsAction(
  update,
  adminId,
  action,
) {
  const value =
    clean(action, 500);

  if (
    !value.startsWith(
      'admin:tool:ops:',
    )
  ) {
    return false;
  }

  if (
    !(await isAdmin(adminId))
  ) {
    return true;
  }

  await ensureAdminOperationsSchema();

  if (
    value ===
    'admin:tool:ops:search'
  ) {
    await beginSearch(
      update,
      adminId,
    );

    return true;
  }

  if (
    value ===
    'admin:tool:ops:cancel'
  ) {
    await setSession(
      adminId,
      'idle',
      {},
    );

    await respond(
      update,
      adminId,
      '✅ Действие отменено.',
      [
        [
          callbackButton(
            '⬅️ В админ-панель',
            'admin:menu',
          ),
        ],
      ],
    );

    return true;
  }

  if (
    value ===
    'admin:tool:ops:diagnostics'
  ) {
    await showDiagnostics(
      update,
      adminId,
    );

    return true;
  }

  if (
    value ===
    'admin:tool:ops:errors'
  ) {
    await showErrors(
      update,
      adminId,
      'open',
    );

    return true;
  }

  if (
    value ===
    'admin:tool:ops:errors:resolved'
  ) {
    await showErrors(
      update,
      adminId,
      'resolved',
    );

    return true;
  }

  let match = value.match(
    /^admin:tool:ops:channel:(\d+)$/,
  );

  if (match) {
    await showChannelDiagnostics(
      update,
      adminId,
      Number(match[1]),
    );

    return true;
  }

  match = value.match(
    /^admin:tool:ops:error:(\d+):resolve$/,
  );

  if (match) {
    await setErrorStatus(
      update,
      adminId,
      Number(match[1]),
      'resolved',
    );

    return true;
  }

  match = value.match(
    /^admin:tool:ops:error:(\d+):reopen$/,
  );

  if (match) {
    await setErrorStatus(
      update,
      adminId,
      Number(match[1]),
      'open',
    );

    return true;
  }

  match = value.match(
    /^admin:tool:ops:error:(\d+)$/,
  );

  if (match) {
    await showErrorCard(
      update,
      adminId,
      Number(match[1]),
    );

    return true;
  }

  return false;
}

export async function handleAdminOperationsMessage(
  update,
  adminId,
  session,
) {
  if (
    session?.state !==
    'ops_search_wait'
  ) {
    return false;
  }

  if (
    !(await isAdmin(adminId))
  ) {
    return true;
  }

  const term =
    messageText(update);

  if (!term) {
    return false;
  }

  await setSession(
    adminId,
    'idle',
    {},
  );

  await showSearchResults(
    update,
    adminId,
    term,
  );

  return true;
}

export async function adminOperationsSmokeTest() {
  await ensureAdminOperationsSchema();

  const result = (
    await safe(`
      SELECT
        COUNT(*) FILTER(
          WHERE status='open'
        )::integer AS open_errors,
        COUNT(*) FILTER(
          WHERE status='resolved'
        )::integer AS resolved_errors
      FROM public.lr_admin_errors
    `)
  )[0] || {};

  return {
    ok: true,
    openErrors:
      num(result.open_errors),
    resolvedErrors:
      num(result.resolved_errors),
  };
}

