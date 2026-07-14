/* LR_PURCHASES_PRIVATE_LINK_FIX_V1 */
import crypto from 'node:crypto';

import { query } from './db.js';
import {
  answerCallback,
  callbackButton,
  getMaxChatInfo,
  getMaxMessage,
  inlineKeyboard,
  linkButton,
  sendMaxMessage,
} from './maxClient.js';

const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL ||
  process.env.BASE_URL ||
  process.env.SITE_URL ||
  'https://linkray.ru'
).replace(/\/+$/, '');

const BOT_LINK =
  process.env.BOT_LINK ||
  'https://max.ru/se13353901_bot';

const SYNC_INTERVAL_MS = Math.max(
  60_000,
  Number(
    process.env.LR_PURCHASE_SYNC_INTERVAL_MS ||
    5 * 60_000
  )
);

const CHECKPOINTS = [1, 6, 12, 24, 48, 72];

let installed = false;
let schemaPromise = null;
let syncTimer = null;
let syncBusy = false;

function rows(result) {
  return Array.isArray(result)
    ? result
    : (result?.rows || []);
}

function clean(value, max = 1000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function num(value, fallback = 0) {
  const parsed = Number(
    String(value ?? '')
      .replace(/\s+/g, '')
      .replace(',', '.')
  );

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function int(value, fallback = 0) {
  return Math.round(num(value, fallback));
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function short(value, max = 46) {
  const text = clean(
    String(value ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
    max + 10
  );

  if (!text) {
    return 'Рекламный пост';
  }

  return text.length > max
    ? `${text.slice(0, max - 1).trim()}…`
    : text;
}

function fmt(value) {
  return new Intl.NumberFormat(
    'ru-RU'
  ).format(int(value));
}

function money(value) {
  return `${new Intl.NumberFormat(
    'ru-RU',
    {
      maximumFractionDigits: 2,
    }
  ).format(num(value))} ₽`;
}

function moscowDate(value) {
  const date = value
    ? new Date(value)
    : null;

  if (
    !date ||
    Number.isNaN(date.getTime())
  ) {
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
    }
  ).format(date);
}

function updatePayload(update) {
  return clean(
    update?.callback?.payload ||
    update?.callback?.data ||
    update?.message_callback?.payload ||
    update?.message_callback?.callback?.payload ||
    update?.payload ||
    '',
    500
  );
}

function updateCallbackId(update) {
  return clean(
    update?.callback?.callback_id ||
    update?.callback?.callbackId ||
    update?.callback?.id ||
    update?.message_callback?.callback_id ||
    update?.message_callback?.callbackId ||
    '',
    500
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
    update?.callback?.message?.sender,
  ].filter(
    (item) =>
      item &&
      typeof item === 'object'
  );
}

function candidateUserId(candidate) {
  return clean(
    candidate?.user_id ||
    candidate?.userId ||
    candidate?.id ||
    '',
    100
  );
}

function updateUserId(update) {
  for (const candidate of humanCandidates(update)) {
    const id = candidateUserId(candidate);

    if (
      /^\d+$/.test(id) &&
      candidate?.is_bot !== true &&
      candidate?.isBot !== true
    ) {
      return id;
    }
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

    if (/^\d+$/.test(id)) {
      return id;
    }
  }

  return '';
}

function updateChatId(update) {
  for (const value of [
    update?.callback?.message?.recipient?.chat_id,
    update?.callback?.message?.recipient?.chatId,
    update?.message_callback?.message?.recipient?.chat_id,
    update?.message_callback?.message?.recipient?.chatId,
    update?.message?.recipient?.chat_id,
    update?.message?.recipient?.chatId,
    update?.chat_id,
    update?.chatId,
  ]) {
    const id = clean(value, 100);

    if (id && !id.startsWith('-')) {
      return id;
    }
  }

  return updateUserId(update);
}

function updateText(update) {
  return clean(
    update?.message?.body?.text ||
    update?.message?.text ||
    update?.body?.text ||
    update?.text ||
    '',
    5000
  );
}

function keyboard(buttonRows) {
  return inlineKeyboard(buttonRows);
}

async function respond(
  update,
  text,
  buttonRows = []
) {
  const attachments =
    keyboard(buttonRows);

  const callbackId =
    updateCallbackId(update);

  if (callbackId) {
    await answerCallback({
      callbackId,
      text,
      format: 'html',
      attachments,
    });

    return;
  }

  const userId = updateUserId(update);
  const chatId = updateChatId(update);

  if (userId) {
    await sendMaxMessage({
      userId,
      text,
      format: 'html',
      attachments,
      purpose: 'linkray_purchases',
    });

    return;
  }

  if (chatId) {
    await sendMaxMessage({
      chatId,
      text,
      format: 'html',
      attachments,
      purpose: 'linkray_purchases',
    });
  }
}

async function ensureSchema() {
  if (schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_purchases (
          id bigserial PRIMARY KEY,

          public_number bigserial UNIQUE,
          purchase_code text UNIQUE,

          owner_user_id bigint NOT NULL
            REFERENCES public.lr_users(id)
            ON DELETE CASCADE,

          target_channel_id bigint
            REFERENCES public.channels(id)
            ON DELETE SET NULL,

          target_max_chat_id text,
          target_title text,
          target_link text,

          source_chat_id text,
          source_title text,
          source_link text,
          source_icon_url text,

          source_subscribers_start integer,
          source_subscribers_current integer,

          source_post_mid text UNIQUE,
          source_post_url text,
          source_post_text text,

          budget numeric(14,2)
            NOT NULL DEFAULT 0,

          duration_hours integer
            NOT NULL DEFAULT 24,

          status text
            NOT NULL DEFAULT 'awaiting_post',

          payment_status text
            NOT NULL DEFAULT 'unpaid',

          planned_at timestamptz,
          published_at timestamptz,
          expected_finish_at timestamptz,
          completed_at timestamptz,
          deleted_at timestamptz,
          archived_at timestamptz,

          current_views integer
            NOT NULL DEFAULT 0,

          tracking_clicks integer
            NOT NULL DEFAULT 0,

          target_subscribers_start integer,
          target_subscribers_current integer,

          target_subscribers_net integer
            NOT NULL DEFAULT 0,

          cpm numeric(14,2),
          cost_per_click numeric(14,2),
          cost_per_subscriber numeric(14,2),

          tracking_token text
            NOT NULL UNIQUE,

          access_mode text
            NOT NULL DEFAULT 'forwarded_post',

          last_error text,

          last_raw jsonb
            NOT NULL DEFAULT '{}'::jsonb,

          last_sync_at timestamptz,

          created_at timestamptz
            NOT NULL DEFAULT now(),

          updated_at timestamptz
            NOT NULL DEFAULT now()
        )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
        lr_purchases_owner_status_idx
      ON public.lr_purchases(
        owner_user_id,
        status,
        updated_at DESC
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
        lr_purchases_source_post_idx
      ON public.lr_purchases(
        source_post_mid
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_purchase_snapshots (
          id bigserial PRIMARY KEY,

          purchase_id bigint NOT NULL
            REFERENCES public.lr_purchases(id)
            ON DELETE CASCADE,

          checkpoint_hours integer NOT NULL,

          captured_at timestamptz
            NOT NULL DEFAULT now(),

          elapsed_minutes integer
            NOT NULL DEFAULT 0,

          views integer
            NOT NULL DEFAULT 0,

          clicks integer
            NOT NULL DEFAULT 0,

          target_subscribers integer,

          target_subscribers_net integer
            NOT NULL DEFAULT 0,

          raw jsonb
            NOT NULL DEFAULT '{}'::jsonb,

          UNIQUE (
            purchase_id,
            checkpoint_hours
          )
        )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_purchase_sessions (
          max_user_id text PRIMARY KEY,

          state text
            NOT NULL DEFAULT 'idle',

          data jsonb
            NOT NULL DEFAULT '{}'::jsonb,

          updated_at timestamptz
            NOT NULL DEFAULT now()
        )
    `);
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });

  return schemaPromise;
}

async function safeQuery(
  sql,
  params = []
) {
  try {
    return rows(
      await query(sql, params)
    );
  } catch (error) {
    console.error(
      '[LinkRay Purchases SQL]',
      error?.message || error
    );

    return [];
  }
}

async function currentUser(maxUserId) {
  if (!maxUserId) {
    return null;
  }

  return (
    await safeQuery(`
      SELECT *

      FROM public.lr_users

      WHERE max_user_id=$1
        AND COALESCE(is_blocked, false)=false

      LIMIT 1
    `, [maxUserId])
  )[0] || null;
}

async function userChannels(userId) {
  if (!userId) {
    return [];
  }

  return safeQuery(`
    SELECT DISTINCT
      channel.id,
      channel.title,
      channel.link,
      channel.max_chat_id::text AS max_chat_id

    FROM public.lr_user_channels relation

    JOIN public.channels channel
      ON channel.id=relation.channel_id

    WHERE relation.user_id=$1
      AND COALESCE(channel.is_active, true)=true

    ORDER BY
      channel.title NULLS LAST,
      channel.id
  `, [Number(userId)]);
}

async function setSession(
  maxUserId,
  state,
  data = {}
) {
  await ensureSchema();

  await query(`
    INSERT INTO public.lr_purchase_sessions (
      max_user_id,
      state,
      data,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3::jsonb,
      now()
    )

    ON CONFLICT (max_user_id)
    DO UPDATE SET
      state=EXCLUDED.state,
      data=EXCLUDED.data,
      updated_at=now()
  `, [
    maxUserId,
    state,
    JSON.stringify(data),
  ]);
}

async function getSession(maxUserId) {
  await ensureSchema();

  return (
    await safeQuery(`
      SELECT state, data

      FROM public.lr_purchase_sessions

      WHERE max_user_id=$1

      LIMIT 1
    `, [maxUserId])
  )[0] || {
    state: 'idle',
    data: {},
  };
}

async function clearSession(maxUserId) {
  if (!maxUserId) {
    return;
  }

  await setSession(
    maxUserId,
    'idle',
    {}
  );
}

function newToken() {
  return crypto
    .randomBytes(20)
    .toString('hex');
}

function parseChannelLink(value) {
  const text = clean(value, 4000)
    .replace(/\u00a0/g, ' ')
    .trim();

  const match = text.match(
    /(?:https?:\/\/)?(?:www\.)?max\.ru\/((?:join\/)?[A-Za-z0-9_.~-]+)/i
  );

  if (!match) {
    return null;
  }

  const path = String(match[1] || '')
    .replace(/^\/+|\/+$/g, '');

  if (!path) {
    return null;
  }

  const privateMatch =
    path.match(
      /^join\/([A-Za-z0-9_.~-]+)$/i
    );

  if (privateMatch) {
    const token =
      privateMatch[1];

    return {
      link:
        `https://max.ru/join/${token}`,
      alias: null,
      accessMode: 'private_invite',
    };
  }

  if (
    path.toLowerCase() === 'join'
  ) {
    return null;
  }

  return {
    link:
      `https://max.ru/${path}`,
    alias: path,
    accessMode: 'public',
  };
}

function firstNumber(value) {
  const match = String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .match(/\d+(?:[.,]\d+)?/);

  if (!match) {
    return null;
  }

  const result = num(match[0], NaN);

  return Number.isFinite(result)
    ? result
    : null;
}

function deepNumber(
  value,
  names
) {
  const wanted = new Set(
    names.map(
      (item) =>
        String(item).toLowerCase()
    )
  );

  let best = null;

  function parse(input) {
    if (typeof input === 'number') {
      return Number.isFinite(input)
        ? input
        : null;
    }

    if (typeof input === 'string') {
      const normalized =
        input.trim().replace(',', '.');

      if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
        return null;
      }

      const parsed = Number(normalized);

      return Number.isFinite(parsed)
        ? parsed
        : null;
    }

    return null;
  }

  function walk(node) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }

      return;
    }

    for (const [key, item] of Object.entries(node)) {
      if (wanted.has(key.toLowerCase())) {
        const parsed = parse(item);

        if (
          parsed !== null &&
          (best === null || parsed > best)
        ) {
          best = parsed;
        }
      }
    }

    for (const item of Object.values(node)) {
      if (
        item &&
        typeof item === 'object'
      ) {
        walk(item);
      }
    }
  }

  walk(value);

  return best;
}

function extractViews(value) {
  return Math.max(
    0,
    int(
      deepNumber(
        value,
        [
          'views',
          'view_count',
          'views_count',
          'viewCount',
          'viewsCount',
        ]
      ),
      0
    )
  );
}

function extractSubscribers(value) {
  return Math.max(
    0,
    int(
      deepNumber(
        value,
        [
          'participants_count',
          'participantsCount',
          'subscribers',
          'subscribers_count',
          'subscriber_count',
          'members_count',
          'membersCount',
        ]
      ),
      0
    )
  );
}

function deepFirst(
  value,
  names
) {
  const wanted = new Set(
    names.map(
      (item) =>
        String(item).toLowerCase()
    )
  );

  let result = null;

  function walk(node) {
    if (
      result !== null ||
      !node ||
      typeof node !== 'object'
    ) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);

        if (result !== null) {
          return;
        }
      }

      return;
    }

    for (const [key, item] of Object.entries(node)) {
      if (
        wanted.has(key.toLowerCase()) &&
        item !== null &&
        item !== undefined &&
        item !== ''
      ) {
        result = item;
        return;
      }
    }

    for (const item of Object.values(node)) {
      if (
        item &&
        typeof item === 'object'
      ) {
        walk(item);

        if (result !== null) {
          return;
        }
      }
    }
  }

  walk(value);

  return result;
}

function forwardedPost(update) {
  const linked =
    update?.message?.link ||
    update?.message?.body?.link ||
    update?.link ||
    null;

  if (!linked || typeof linked !== 'object') {
    return null;
  }

  const original =
    linked?.message ||
    linked?.linked_message ||
    linked;

  const mid = clean(
    original?.body?.mid ||
    original?.mid ||
    linked?.message_id ||
    linked?.messageId ||
    deepFirst(
      original,
      [
        'mid',
        'message_id',
        'messageId',
      ]
    ) ||
    '',
    300
  );

  const chatId = clean(
    linked?.chat_id ||
    linked?.chatId ||
    original?.recipient?.chat_id ||
    original?.recipient?.chatId ||
    deepFirst(
      linked,
      [
        'chat_id',
        'chatId',
      ]
    ) ||
    '',
    100
  );

  if (!mid) {
    return null;
  }

  return {
    mid,
    chatId: chatId || null,
    message: original,
    linked,
  };
}

function normalizeMessageResponse(response) {
  if (Array.isArray(response?.messages)) {
    return response.messages[0] || null;
  }

  return (
    response?.message ||
    response ||
    null
  );
}

function timestampDate(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  const milliseconds =
    parsed < 10_000_000_000
      ? parsed * 1000
      : parsed;

  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function channelIconUrl(info) {
  return clean(
    info?.icon?.url ||
    info?.icon?.small_url ||
    info?.icon?.large_url ||
    '',
    2000
  );
}

function trackingUrl(purchase) {
  return `${PUBLIC_BASE_URL}/buy/${purchase.tracking_token}`;
}

function statusMeta(status) {
  const map = {
    awaiting_post: [
      '🟡',
      'Ожидается рекламный пост',
    ],
    active: [
      '🟢',
      'Реклама размещена',
    ],
    completed: [
      '✅',
      'Закуп завершён',
    ],
    attention: [
      '⚠️',
      'Требует внимания',
    ],
    archived: [
      '🗂',
      'В архиве',
    ],
  };

  return map[status] || [
    '📌',
    status || 'неизвестно',
  ];
}

function paymentMeta(status) {
  const map = {
    unpaid: '🔴 Не оплачено',
    paid: '✅ Оплачено',
    dispute: '⚠️ Спор',
  };

  return map[status] || status;
}

function elapsedHours(purchase) {
  const published =
    purchase.published_at
      ? new Date(purchase.published_at)
      : null;

  if (
    !published ||
    Number.isNaN(
      published.getTime()
    )
  ) {
    return 0;
  }

  return Math.max(
    0,
    (
      Date.now() -
      published.getTime()
    ) / 3600_000
  );
}

function progress(purchase) {
  const duration = Math.max(
    1,
    int(purchase.duration_hours, 24)
  );

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        elapsedHours(purchase) /
        duration *
        100
      )
    )
  );
}

function progressBar(value) {
  const width = 12;
  const filled = Math.max(
    0,
    Math.min(
      width,
      Math.round(
        value / 100 * width
      )
    )
  );

  return (
    '█'.repeat(filled) +
    '░'.repeat(width - filled)
  );
}

async function getTargetChannel(
  userId,
  channelId
) {
  return (
    await safeQuery(`
      SELECT DISTINCT
        channel.id,
        channel.title,
        channel.link,
        channel.max_chat_id::text AS max_chat_id

      FROM public.lr_user_channels relation

      JOIN public.channels channel
        ON channel.id=relation.channel_id

      WHERE relation.user_id=$1
        AND channel.id=$2
        AND COALESCE(channel.is_active, true)=true

      LIMIT 1
    `, [
      Number(userId),
      Number(channelId),
    ])
  )[0] || null;
}

async function loadPurchase(
  update,
  purchaseId
) {
  const user =
    await currentUser(
      updateUserId(update)
    );

  if (!user) {
    return null;
  }

  return (
    await safeQuery(`
      SELECT *

      FROM public.lr_purchases

      WHERE id=$1
        AND owner_user_id=$2

      LIMIT 1
    `, [
      Number(purchaseId),
      Number(user.id),
    ])
  )[0] || null;
}

async function createPurchase(
  update,
  session,
  durationHours
) {
  const maxUserId =
    updateUserId(update);

  const user =
    await currentUser(maxUserId);

  if (!user) {
    await clearSession(maxUserId);
    return false;
  }

  const data =
    session?.data || {};

  const target =
    await getTargetChannel(
      user.id,
      data.target_channel_id
    );

  if (!target) {
    await clearSession(maxUserId);

    await respond(
      update,
      '⚠️ Продвигаемый канал не найден. Создайте закуп заново.',
      [[
        callbackButton(
          '⬅️ К закупам',
          'reports:menu'
        ),
      ]]
    );

    return true;
  }

  let targetSubscribers = 0;

  if (target.max_chat_id) {
    try {
      targetSubscribers =
        extractSubscribers(
          await getMaxChatInfo(
            target.max_chat_id
          )
        );
    } catch {}
  }

  const inserted = rows(
    await query(`
      INSERT INTO public.lr_purchases (
        owner_user_id,
        target_channel_id,
        target_max_chat_id,
        target_title,
        target_link,
        source_link,
        budget,
        duration_hours,
        status,
        target_subscribers_start,
        target_subscribers_current,
        tracking_token,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        'awaiting_post',
        NULLIF($9, 0),
        NULLIF($9, 0),
        $10,
        now(),
        now()
      )
      RETURNING *
    `, [
      Number(user.id),
      Number(target.id),
      clean(target.max_chat_id, 100) || null,
      clean(target.title, 500) || 'Канал',
      clean(target.link, 2000) || null,
      clean(data.source_link, 2000),
      Math.max(0, num(data.budget)),
      Math.max(1, int(durationHours, 24)),
      targetSubscribers,
      newToken(),
    ])
  )[0];

  await query(`
    UPDATE public.lr_purchases

    SET
      purchase_code=
        'LR-BUY-' ||
        LPAD(
          public_number::text,
          6,
          '0'
        ),
      updated_at=now()

    WHERE id=$1
  `, [Number(inserted.id)]);

  await setSession(
    maxUserId,
    'buy_wait_post',
    {
      purchase_id:
        Number(inserted.id),
    }
  );

  const purchase = (
    await safeQuery(`
      SELECT *

      FROM public.lr_purchases

      WHERE id=$1
    `, [Number(inserted.id)])
  )[0];

  await respond(
    update,
    [
      '✅ <b>Закуп сформирован</b>',
      '',
      `🧾 ${esc(purchase.purchase_code)}`,
      `📢 Продвигаем: <b>${esc(purchase.target_title)}</b>`,
      `💰 Бюджет: <b>${money(purchase.budget)}</b>`,
      `⏳ Срок размещения: <b>${int(purchase.duration_hours)} ч.</b>`,
      '',
      '<b>Ссылка для рекламного поста:</b>',
      esc(trackingUrl(purchase)),
      '',
      'Она ведёт в ваш канал и считает переходы.',
      '',
      'Когда реклама выйдет, <b>перешлите опубликованный пост сюда</b>. LinkRay привяжет исходный канал и начнёт автоматически собирать просмотры.',
    ].join('\n'),
    [
      [
        linkButton(
          '🔗 Проверить ссылку',
          trackingUrl(purchase)
        ),
      ],
      [
        callbackButton(
          '❌ Закрыть ожидание',
          'buy:cancel'
        ),
      ],
    ]
  );

  return true;
}

async function attachForwardedPost(
  update,
  session
) {
  const maxUserId =
    updateUserId(update);

  const purchaseId =
    Number(
      session?.data?.purchase_id
    );

  const purchase =
    await loadPurchase(
      update,
      purchaseId
    );

  if (!purchase) {
    await clearSession(maxUserId);
    return false;
  }

  const forwarded =
    forwardedPost(update);

  if (!forwarded) {
    await respond(
      update,
      [
        '⚠️ Нужен именно <b>пересланный пост из рекламного канала</b>.',
        '',
        'Откройте опубликованную рекламу в канале, нажмите «Переслать» и отправьте её LinkRay.',
      ].join('\n'),
      [[
        callbackButton(
          '❌ Закрыть ожидание',
          'buy:cancel'
        ),
      ]]
    );

    return true;
  }

  let fetched = null;
  let fetchError = '';

  try {
    fetched =
      normalizeMessageResponse(
        await getMaxMessage(
          forwarded.mid,
          {
            chatId:
              forwarded.chatId ||
              undefined,
          }
        )
      );
  } catch (error) {
    fetchError = clean(
      error?.message || error,
      1000
    );
  }

  if (!fetched) {
    await setSession(
      maxUserId,
      'buy_wait_post',
      {
        purchase_id:
          Number(purchase.id),
      }
    );

    await respond(
      update,
      [
        '⚠️ <b>MAX не разрешил получить данные этого поста.</b>',
        '',
        'LinkRay видит пересылку, но API не отдаёт текущую статистику. Попросите владельца рекламного канала добавить LinkRay администратором, затем перешлите пост ещё раз.',
        fetchError
          ? `\nТехническая причина: ${esc(fetchError)}`
          : '',
      ].join('\n'),
      [[
        callbackButton(
          '❌ Закрыть ожидание',
          'buy:cancel'
        ),
      ]]
    );

    return true;
  }

  const chatId = clean(
    forwarded.chatId ||
    fetched?.recipient?.chat_id ||
    fetched?.recipient?.chatId ||
    '',
    100
  );

  let channelInfo = null;

  if (chatId) {
    try {
      channelInfo =
        await getMaxChatInfo(chatId);
    } catch {}
  }

  const sourceTitle = clean(
    channelInfo?.title ||
    forwarded?.linked?.sender?.name ||
    forwarded?.linked?.sender?.first_name ||
    'Рекламный канал',
    500
  );

  const sourceLink = clean(
    channelInfo?.link ||
    fetched?.url?.replace(
      /\/[^/]+$/,
      ''
    ) ||
    purchase.source_link ||
    '',
    2000
  );

  const sourcePostUrl = clean(
    fetched?.url ||
    forwarded?.message?.url ||
    '',
    2000
  );

  const published =
    timestampDate(
      fetched?.timestamp ||
      forwarded?.message?.timestamp ||
      Date.now()
    ) || new Date();

  const expectedFinish =
    new Date(
      published.getTime() +
      Math.max(
        1,
        int(
          purchase.duration_hours,
          24
        )
      ) * 3600_000
    );

  const postText = clean(
    fetched?.body?.text ||
    forwarded?.message?.body?.text ||
    '',
    10000
  );

  const views =
    extractViews(fetched);

  const sourceSubscribers =
    extractSubscribers(channelInfo);

  const targetAtStart =
    await targetMetrics(purchase);

  const targetSubscribersStart =
    int(
      targetAtStart.subscribers ||
      purchase.target_subscribers_current ||
      purchase.target_subscribers_start
    );

  await query(`
    UPDATE public.lr_purchases

    SET
      source_chat_id=
        NULLIF($2, ''),

      source_title=
        NULLIF($3, ''),

      source_link=
        COALESCE(
          NULLIF($4, ''),
          source_link
        ),

      source_icon_url=
        NULLIF($5, ''),

      source_subscribers_start=
        NULLIF($6, 0),

      source_subscribers_current=
        NULLIF($6, 0),

      source_post_mid=$7,

      source_post_url=
        NULLIF($8, ''),

      source_post_text=
        NULLIF($9, ''),

      published_at=$10,
      expected_finish_at=$11,

      current_views=$12,

      target_subscribers_start=
        NULLIF($13, 0),

      target_subscribers_current=
        NULLIF($13, 0),

      target_subscribers_net=0,

      status='active',
      last_error=NULL,

      last_raw=$14::jsonb,
      last_sync_at=now(),
      updated_at=now()

    WHERE id=$1
  `, [
    Number(purchase.id),
    chatId,
    sourceTitle,
    sourceLink,
    channelIconUrl(channelInfo),
    sourceSubscribers,
    forwarded.mid,
    sourcePostUrl,
    postText,
    published.toISOString(),
    expectedFinish.toISOString(),
    views,
    targetSubscribersStart,
    JSON.stringify({
      message: fetched,
      sourceChannel: channelInfo,
      targetChannel: targetAtStart.raw,
    }),
  ]);

  await clearSession(maxUserId);

  await showPurchase(
    update,
    purchase.id,
    '✅ Рекламный пост привязан. Автоматический сбор данных запущен.'
  );

  return true;
}

async function messageMetrics(purchase) {
  if (!purchase.source_post_mid) {
    return {
      ok: false,
      views:
        int(purchase.current_views),
      error: 'post_not_attached',
      deleted: false,
      raw: {},
    };
  }

  try {
    const response =
      await getMaxMessage(
        purchase.source_post_mid,
        {
          chatId:
            purchase.source_chat_id ||
            undefined,
        }
      );

    const message =
      normalizeMessageResponse(response);

    return {
      ok: Boolean(message),
      views:
        extractViews(
          message || response
        ),
      error: '',
      deleted: false,
      raw:
        message || response || {},
      url:
        clean(
          message?.url ||
          response?.url ||
          '',
          2000
        ),
    };
  } catch (error) {
    const text = clean(
      error?.message || error,
      1000
    );

    return {
      ok: false,
      views:
        int(purchase.current_views),
      error: text,
      deleted:
        /\b404\b|not found|deleted|удален/i
          .test(text),
      raw: {
        error: text,
      },
    };
  }
}

async function targetMetrics(purchase) {
  if (!purchase.target_max_chat_id) {
    return {
      subscribers:
        int(
          purchase.target_subscribers_current ||
          purchase.target_subscribers_start
        ),
      raw: {},
    };
  }

  try {
    const info =
      await getMaxChatInfo(
        purchase.target_max_chat_id
      );

    return {
      subscribers:
        extractSubscribers(info),
      raw: info || {},
    };
  } catch (error) {
    return {
      subscribers:
        int(
          purchase.target_subscribers_current ||
          purchase.target_subscribers_start
        ),
      raw: {
        error:
          clean(
            error?.message || error,
            1000
          ),
      },
    };
  }
}

async function sourceChannelMetrics(purchase) {
  if (!purchase.source_chat_id) {
    return {
      subscribers:
        int(
          purchase.source_subscribers_current ||
          purchase.source_subscribers_start
        ),
      raw: {},
    };
  }

  try {
    const info =
      await getMaxChatInfo(
        purchase.source_chat_id
      );

    return {
      subscribers:
        extractSubscribers(info),
      title:
        clean(info?.title, 500),
      link:
        clean(info?.link, 2000),
      icon:
        channelIconUrl(info),
      raw: info || {},
    };
  } catch (error) {
    return {
      subscribers:
        int(
          purchase.source_subscribers_current ||
          purchase.source_subscribers_start
        ),
      raw: {
        error:
          clean(
            error?.message || error,
            1000
          ),
      },
    };
  }
}

async function captureCheckpoints(
  purchase,
  elapsed,
  values,
  raw
) {
  const checkpoints = Array.from(
    new Set([
      ...CHECKPOINTS,
      Math.max(
        1,
        int(
          purchase.duration_hours,
          24
        )
      ),
    ])
  ).sort(
    (a, b) => a - b
  );

  for (const checkpoint of checkpoints) {
    if (elapsed + 0.05 < checkpoint) {
      continue;
    }

    await query(`
      INSERT INTO public.lr_purchase_snapshots (
        purchase_id,
        checkpoint_hours,
        elapsed_minutes,
        views,
        clicks,
        target_subscribers,
        target_subscribers_net,
        raw
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        NULLIF($6, 0),
        $7,
        $8::jsonb
      )

      ON CONFLICT (
        purchase_id,
        checkpoint_hours
      )
      DO NOTHING
    `, [
      Number(purchase.id),
      checkpoint,
      Math.max(
        0,
        Math.round(elapsed * 60)
      ),
      int(values.views),
      int(values.clicks),
      int(values.targetSubscribers),
      int(values.netSubscribers),
      JSON.stringify(raw || {}),
    ]);
  }
}

async function syncPurchase(
  purchaseId
) {
  await ensureSchema();

  const purchase = (
    await safeQuery(`
      SELECT *

      FROM public.lr_purchases

      WHERE id=$1

      LIMIT 1
    `, [Number(purchaseId)])
  )[0];

  if (
    !purchase ||
    ![
      'active',
      'attention',
    ].includes(
      clean(purchase.status, 30)
    )
  ) {
    return purchase || null;
  }

  const message =
    await messageMetrics(purchase);

  const target =
    await targetMetrics(purchase);

  const source =
    await sourceChannelMetrics(purchase);

  const baseline =
    int(
      purchase.target_subscribers_start ||
      target.subscribers
    );

  const targetSubscribers =
    int(
      target.subscribers ||
      purchase.target_subscribers_current ||
      baseline
    );

  const netSubscribers =
    targetSubscribers - baseline;

  const views = Math.max(
    int(purchase.current_views),
    int(message.views)
  );

  const clicks =
    int(purchase.tracking_clicks);

  const budget =
    Math.max(
      0,
      num(purchase.budget)
    );

  const cpm =
    views > 0
      ? budget / views * 1000
      : null;

  const costPerClick =
    clicks > 0
      ? budget / clicks
      : null;

  const costPerSubscriber =
    netSubscribers > 0
      ? budget / netSubscribers
      : null;

  const elapsed =
    elapsedHours(purchase);

  const duration =
    Math.max(
      1,
      int(
        purchase.duration_hours,
        24
      )
    );

  let status = 'active';
  let completedAt = null;
  let deletedAt =
    purchase.deleted_at || null;

  if (message.deleted) {
    deletedAt =
      deletedAt ||
      new Date().toISOString();

    status =
      elapsed + 0.1 < duration
        ? 'attention'
        : 'completed';

    if (elapsed >= duration) {
      completedAt =
        purchase.completed_at ||
        new Date().toISOString();
    }
  } else if (elapsed >= duration) {
    status = 'completed';
    completedAt =
      purchase.completed_at ||
      new Date().toISOString();
  } else if (!message.ok) {
    status = 'attention';
  }

  await query(`
    UPDATE public.lr_purchases

    SET
      source_title=
        COALESCE(
          NULLIF($2, ''),
          source_title
        ),

      source_link=
        COALESCE(
          NULLIF($3, ''),
          source_link
        ),

      source_icon_url=
        COALESCE(
          NULLIF($4, ''),
          source_icon_url
        ),

      source_subscribers_current=
        NULLIF($5, 0),

      source_post_url=
        COALESCE(
          NULLIF($6, ''),
          source_post_url
        ),

      current_views=$7,

      target_subscribers_start=
        COALESCE(
          target_subscribers_start,
          NULLIF($8, 0)
        ),

      target_subscribers_current=
        NULLIF($9, 0),

      target_subscribers_net=$10,

      cpm=$11,
      cost_per_click=$12,
      cost_per_subscriber=$13,

      status=$14,
      completed_at=$15,
      deleted_at=$16,

      last_error=
        NULLIF($17, ''),

      last_raw=$18::jsonb,
      last_sync_at=now(),
      updated_at=now()

    WHERE id=$1
  `, [
    Number(purchase.id),
    source.title || '',
    source.link || '',
    source.icon || '',
    int(
      source.subscribers ||
      purchase.source_subscribers_current
    ),
    message.url || '',
    views,
    baseline,
    targetSubscribers,
    netSubscribers,
    cpm,
    costPerClick,
    costPerSubscriber,
    status,
    completedAt,
    deletedAt,
    message.error || '',
    JSON.stringify({
      message: message.raw,
      target: target.raw,
      source: source.raw,
    }),
  ]);

  await captureCheckpoints(
    purchase,
    elapsed,
    {
      views,
      clicks,
      targetSubscribers,
      netSubscribers,
    },
    {
      message: message.raw,
      target: target.raw,
      source: source.raw,
    }
  );

  return (
    await safeQuery(`
      SELECT *

      FROM public.lr_purchases

      WHERE id=$1
    `, [Number(purchase.id)])
  )[0] || null;
}

async function syncPurchases({
  limit = 40,
} = {}) {
  if (syncBusy) {
    return {
      skipped: true,
    };
  }

  syncBusy = true;

  try {
    await ensureSchema();

    const active =
      await safeQuery(`
        SELECT id

        FROM public.lr_purchases

        WHERE archived_at IS NULL
          AND status IN (
            'active',
            'attention'
          )

        ORDER BY
          COALESCE(
            last_sync_at,
            created_at
          ) ASC

        LIMIT $1
      `, [Math.max(1, int(limit, 40))]);

    let synced = 0;

    for (const item of active) {
      await syncPurchase(item.id);
      synced += 1;
    }

    return {
      synced,
      found: active.length,
    };
  } finally {
    syncBusy = false;
  }
}

async function purchaseSnapshots(
  purchaseId
) {
  return safeQuery(`
    SELECT *

    FROM public.lr_purchase_snapshots

    WHERE purchase_id=$1

    ORDER BY checkpoint_hours
  `, [Number(purchaseId)]);
}

function filterSql(filter) {
  const map = {
    waiting:
      `status='awaiting_post'
       AND archived_at IS NULL`,

    active:
      `status='active'
       AND archived_at IS NULL`,

    completed:
      `status='completed'
       AND archived_at IS NULL`,

    attention:
      `status='attention'
       AND archived_at IS NULL`,

    all:
      `archived_at IS NULL`,

    archive:
      `archived_at IS NOT NULL`,
  };

  return map[filter] || map.all;
}

async function menu(update) {
  await ensureSchema();

  const user =
    await currentUser(
      updateUserId(update)
    );

  if (!user) {
    await respond(
      update,
      '⚠️ Профиль LinkRay не найден. Нажмите /start.',
      [[
        callbackButton(
          '⬅️ Главное меню',
          'main:menu'
        ),
      ]]
    );

    return;
  }

  await syncPurchases({
    limit: 20,
  }).catch(() => {});

  const stats = (
    await safeQuery(`
      SELECT
        COUNT(*) FILTER (
          WHERE status='awaiting_post'
            AND archived_at IS NULL
        )::int AS waiting,

        COUNT(*) FILTER (
          WHERE status='active'
            AND archived_at IS NULL
        )::int AS active,

        COUNT(*) FILTER (
          WHERE status='completed'
            AND archived_at IS NULL
        )::int AS completed,

        COUNT(*) FILTER (
          WHERE status='attention'
            AND archived_at IS NULL
        )::int AS attention,

        COALESCE(
          SUM(budget) FILTER (
            WHERE archived_at IS NULL
          ),
          0
        ) AS budget,

        COALESCE(
          SUM(current_views) FILTER (
            WHERE archived_at IS NULL
          ),
          0
        )::bigint AS views,

        COALESCE(
          SUM(target_subscribers_net) FILTER (
            WHERE archived_at IS NULL
          ),
          0
        )::bigint AS subscribers

      FROM public.lr_purchases

      WHERE owner_user_id=$1
    `, [Number(user.id)])
  )[0] || {};

  await respond(
    update,
    [
      '🚀 <b>Закупы LinkRay</b>',
      '',
      `🟡 Ожидают пост: <b>${fmt(stats.waiting)}</b>`,
      `🟢 Активные: <b>${fmt(stats.active)}</b>`,
      `✅ Завершённые: <b>${fmt(stats.completed)}</b>`,
      `⚠️ Требуют внимания: <b>${fmt(stats.attention)}</b>`,
      '',
      `💰 Общий бюджет: <b>${money(stats.budget)}</b>`,
      `👁 Просмотры: <b>${fmt(stats.views)}</b>`,
      `👥 Прирост продвигаемых каналов: <b>${int(stats.subscribers) >= 0 ? '+' : ''}${fmt(stats.subscribers)}</b>`,
      '',
      'Создайте закуп, получите отслеживаемую ссылку и после выхода рекламы перешлите пост LinkRay.',
    ].join('\n'),
    [
      [
        callbackButton(
          '➕ Новый закуп',
          'buy:new'
        ),
      ],
      [
        callbackButton(
          '🟡 Ожидают пост',
          'buy:list:waiting'
        ),

        callbackButton(
          '🟢 Активные',
          'buy:list:active'
        ),
      ],
      [
        callbackButton(
          '✅ Завершённые',
          'buy:list:completed'
        ),

        callbackButton(
          '⚠️ Проблемные',
          'buy:list:attention'
        ),
      ],
      [
        callbackButton(
          '📚 Все закупы',
          'buy:list:all'
        ),

        callbackButton(
          '🗂 Архив',
          'buy:list:archive'
        ),
      ],
      [
        callbackButton(
          '⬅️ Главное меню',
          'main:menu'
        ),
      ],
    ]
  );
}

async function startPurchase(update) {
  const maxUserId =
    updateUserId(update);

  const user =
    await currentUser(maxUserId);

  if (!user) {
    await respond(
      update,
      '⚠️ Профиль LinkRay не найден. Нажмите /start.'
    );

    return;
  }

  const channels =
    await userChannels(user.id);

  if (!channels.length) {
    await respond(
      update,
      [
        '⚠️ Сначала подключите канал, который будете продвигать.',
        '',
        'LinkRay должен видеть его подписчиков до и после закупа.',
      ].join('\n'),
      [[
        callbackButton(
          '➕ Добавить канал',
          'channel:add'
        ),
      ], [
        callbackButton(
          '⬅️ К закупам',
          'reports:menu'
        ),
      ]]
    );

    return;
  }

  await setSession(
    maxUserId,
    'buy_pick_target',
    {}
  );

  const buttons =
    channels.slice(0, 15).map(
      (channel) => [
        callbackButton(
          `📢 ${short(channel.title, 36)}`,
          `buy:target:${channel.id}`
        ),
      ]
    );

  buttons.push([
    callbackButton(
      '❌ Отмена',
      'buy:cancel'
    ),
  ]);

  await respond(
    update,
    [
      '➕ <b>Новый закуп</b>',
      '',
      'Какой ваш канал будет продвигаться?',
    ].join('\n'),
    buttons
  );
}

async function chooseTarget(
  update,
  channelId
) {
  const maxUserId =
    updateUserId(update);

  const user =
    await currentUser(maxUserId);

  const channel =
    user
      ? await getTargetChannel(
          user.id,
          channelId
        )
      : null;

  if (!channel) {
    await respond(
      update,
      '⚠️ Канал не найден.',
      [[
        callbackButton(
          '⬅️ К закупам',
          'reports:menu'
        ),
      ]]
    );

    return;
  }

  await setSession(
    maxUserId,
    'buy_wait_source',
    {
      target_channel_id:
        Number(channel.id),
    }
  );

  await respond(
    update,
    [
      '📣 <b>Рекламный канал</b>',
      '',
      `Продвигаем: <b>${esc(channel.title || 'Канал')}</b>`,
      '',
      'Отправьте ссылку на канал, в котором покупаете рекламу. Поддерживаются публичная ссылка и приватное приглашение.',
      '',
      'Примеры:\nhttps://max.ru/channel_name\nhttps://max.ru/join/КОД_ПРИГЛАШЕНИЯ',
    ].join('\n'),
    [[
      callbackButton(
        '❌ Отмена',
        'buy:cancel'
      ),
    ]]
  );
}

async function saveSourceLink(
  update,
  session
) {
  const parsed =
    parseChannelLink(
      updateText(update)
    );

  if (!parsed) {
    await respond(
      update,
      [
        '⚠️ Ссылка не распознана.',
        '',
        'Отправьте ссылку одного из видов:',
        'https://max.ru/channel_name',
        'https://max.ru/join/КОД_ПРИГЛАШЕНИЯ',
      ].join('\n'),
      [[
        callbackButton(
          '❌ Отмена',
          'buy:cancel'
        ),
      ]]
    );

    return true;
  }

  await setSession(
    updateUserId(update),
    'buy_wait_budget',
    {
      ...session.data,
      source_link: parsed.link,
      source_alias: parsed.alias,
      source_access_mode:
        parsed.accessMode,
    }
  );

  await respond(
    update,
    [
      '💰 <b>Стоимость рекламы</b>',
      '',
      'Отправьте сумму закупа в рублях.',
      '',
      'Пример: 4000',
    ].join('\n'),
    [[
      callbackButton(
        '❌ Отмена',
        'buy:cancel'
      ),
    ]]
  );

  return true;
}

async function saveBudget(
  update,
  session
) {
  const budget =
    firstNumber(
      updateText(update)
    );

  if (
    budget === null ||
    budget < 0 ||
    budget > 1_000_000_000
  ) {
    await respond(
      update,
      '⚠️ Отправьте корректную сумму одним числом.',
      [[
        callbackButton(
          '❌ Отмена',
          'buy:cancel'
        ),
      ]]
    );

    return true;
  }

  await setSession(
    updateUserId(update),
    'buy_pick_duration',
    {
      ...session.data,
      budget,
    }
  );

  await respond(
    update,
    [
      '⏳ <b>Срок размещения</b>',
      '',
      'Сколько часов рекламный пост должен находиться в канале?',
    ].join('\n'),
    [
      [
        callbackButton(
          '24 часа',
          'buy:duration:24'
        ),

        callbackButton(
          '48 часов',
          'buy:duration:48'
        ),
      ],
      [
        callbackButton(
          '72 часа',
          'buy:duration:72'
        ),
      ],
      [
        callbackButton(
          '❌ Отмена',
          'buy:cancel'
        ),
      ],
    ]
  );

  return true;
}

async function listPurchases(
  update,
  filter
) {
  const user =
    await currentUser(
      updateUserId(update)
    );

  if (!user) {
    await menu(update);
    return;
  }

  const result =
    await safeQuery(`
      SELECT *

      FROM public.lr_purchases

      WHERE owner_user_id=$1
        AND ${filterSql(filter)}

      ORDER BY
        COALESCE(
          published_at,
          created_at
        ) DESC,
        id DESC

      LIMIT 30
    `, [Number(user.id)]);

  const labels = {
    waiting: '🟡 Ожидают рекламный пост',
    active: '🟢 Активные закупы',
    completed: '✅ Завершённые закупы',
    attention: '⚠️ Требуют внимания',
    all: '📚 Все закупы',
    archive: '🗂 Архив закупов',
  };

  const buttons = result.map(
    (purchase) => {
      const [icon] =
        statusMeta(purchase.status);

      return [
        callbackButton(
          `${icon} ${purchase.purchase_code || `LR-BUY-${purchase.id}`} · ${short(purchase.source_title || purchase.source_link, 25)}`,
          `buy:open:${purchase.id}`
        ),
      ];
    }
  );

  buttons.push([
    callbackButton(
      '⬅️ К закупам',
      'reports:menu'
    ),
  ]);

  await respond(
    update,
    [
      `<b>${labels[filter] || labels.all}</b>`,
      '',
      `Найдено: <b>${fmt(result.length)}</b>`,
      '',
      result.length
        ? 'Выберите закуп.'
        : 'Здесь пока пусто.',
    ].join('\n'),
    buttons
  );
}

function metricLine(
  label,
  value
) {
  return `${label}: <b>${value}</b>`;
}

function purchaseText(
  purchase,
  snapshots
) {
  const [icon, status] =
    statusMeta(purchase.status);

  const net =
    int(
      purchase.target_subscribers_net
    );

  const p = progress(purchase);

  const checkpointText =
    snapshots.length
      ? snapshots.map(
          (snapshot) =>
            `${int(snapshot.checkpoint_hours)} ч. — ${fmt(snapshot.views)} просмотров`
        ).join('\n')
      : 'Замеры ещё не сформированы.';

  const sourceLink =
    purchase.source_link
      ? `<a href="${esc(purchase.source_link)}">${esc(purchase.source_title || 'Рекламный канал')}</a>`
      : esc(
          purchase.source_title ||
          'Рекламный канал'
        );

  const targetLink =
    purchase.target_link
      ? `<a href="${esc(purchase.target_link)}">${esc(purchase.target_title || 'Продвигаемый канал')}</a>`
      : esc(
          purchase.target_title ||
          'Продвигаемый канал'
        );

  return [
    `${icon} <b>${esc(purchase.purchase_code || `LR-BUY-${purchase.id}`)}</b>`,
    status,
    '',
    `📣 Реклама куплена в: ${sourceLink}`,
    `📢 Продвигается: ${targetLink}`,
    '',
    purchase.published_at
      ? metricLine(
          '🕒 Опубликовано',
          moscowDate(
            purchase.published_at
          )
        )
      : '🕒 Пост ещё не привязан',

    metricLine(
      '⏳ Срок',
      `${int(purchase.duration_hours, 24)} ч.`
    ),

    purchase.published_at
      ? `${progressBar(p)} ${p}%`
      : '',

    '',
    metricLine(
      '👁 Просмотры поста',
      fmt(purchase.current_views)
    ),

    metricLine(
      '🔗 Переходы',
      fmt(purchase.tracking_clicks)
    ),

    metricLine(
      '👥 Аудитория рекламного канала',
      purchase.source_subscribers_current
        ? fmt(
            purchase.source_subscribers_current
          )
        : '—'
    ),

    metricLine(
      '📈 Прирост продвигаемого канала',
      `${net >= 0 ? '+' : ''}${fmt(net)}`
    ),

    '',
    metricLine(
      '💰 Бюджет',
      money(purchase.budget)
    ),

    metricLine(
      '📊 Фактический CPM',
      purchase.cpm !== null
        ? money(purchase.cpm)
        : '—'
    ),

    metricLine(
      '🖱 Цена перехода',
      purchase.cost_per_click !== null
        ? money(
            purchase.cost_per_click
          )
        : '—'
    ),

    metricLine(
      '👤 Цена подписчика',
      purchase.cost_per_subscriber !== null
        ? money(
            purchase.cost_per_subscriber
          )
        : '—'
    ),

    metricLine(
      '💳 Оплата',
      paymentMeta(
        purchase.payment_status
      )
    ),

    '',
    '<b>Контрольные замеры</b>',
    checkpointText,

    purchase.deleted_at
      ? `\n⚠️ Пост перестал быть доступен: ${moscowDate(purchase.deleted_at)}`
      : '',

    purchase.last_error
      ? `\n⚠️ Последняя ошибка MAX: ${esc(purchase.last_error)}`
      : '',

    '',
    'Прирост подписчиков считается по изменению аудитории вашего подключённого канала за время закупа. При нескольких одновременных закупах он является оценочным.',
  ].filter(Boolean).join('\n');
}

async function showPurchase(
  update,
  purchaseId,
  notice = ''
) {
  await syncPurchase(
    purchaseId
  ).catch(() => {});

  const purchase =
    await loadPurchase(
      update,
      purchaseId
    );

  if (!purchase) {
    await respond(
      update,
      '⚠️ Закуп не найден или у вас нет доступа.',
      [[
        callbackButton(
          '⬅️ К закупам',
          'reports:menu'
        ),
      ]]
    );

    return;
  }

  const snapshots =
    await purchaseSnapshots(
      purchase.id
    );

  const buttons = [];

  if (
    purchase.status ===
    'awaiting_post'
  ) {
    buttons.push([
      callbackButton(
        '📎 Привязать рекламный пост',
        `buy:attach:${purchase.id}`
      ),
    ]);
  }

  const links = [];

  if (purchase.source_post_url) {
    links.push(
      linkButton(
        '🔗 Открыть пост',
        purchase.source_post_url
      )
    );
  }

  links.push(
    linkButton(
      '📣 Ссылка для рекламы',
      trackingUrl(purchase)
    )
  );

  if (links.length) {
    buttons.push(links);
  }

  buttons.push([
    callbackButton(
      '🔄 Обновить',
      `buy:refresh:${purchase.id}`
    ),

    callbackButton(
      '💳 Оплата',
      `buy:payment:${purchase.id}`
    ),
  ]);

  buttons.push([
    callbackButton(
      purchase.archived_at
        ? '📤 Вернуть'
        : '🗂 В архив',

      `buy:archive:${purchase.id}`
    ),
  ]);

  buttons.push([
    callbackButton(
      '⬅️ К закупам',
      'reports:menu'
    ),
  ]);

  await respond(
    update,
    [
      notice,
      purchaseText(
        purchase,
        snapshots
      ),
    ].filter(Boolean).join('\n\n'),
    buttons
  );
}

async function beginAttach(
  update,
  purchaseId
) {
  const purchase =
    await loadPurchase(
      update,
      purchaseId
    );

  if (!purchase) {
    await menu(update);
    return;
  }

  await setSession(
    updateUserId(update),
    'buy_wait_post',
    {
      purchase_id:
        Number(purchase.id),
    }
  );

  await respond(
    update,
    [
      '📎 <b>Привязка рекламного поста</b>',
      '',
      'Перешлите сюда опубликованный пост из канала, в котором купили рекламу.',
      '',
      'LinkRay получит исходный канал, ссылку на пост, дату публикации и просмотры.',
    ].join('\n'),
    [[
      callbackButton(
        '❌ Отмена',
        'buy:cancel'
      ),
    ]]
  );
}

async function cyclePayment(
  update,
  purchaseId
) {
  const purchase =
    await loadPurchase(
      update,
      purchaseId
    );

  if (!purchase) {
    await menu(update);
    return;
  }

  const states = [
    'unpaid',
    'paid',
    'dispute',
  ];

  const index =
    states.indexOf(
      clean(
        purchase.payment_status,
        30
      )
    );

  const next =
    states[
      (
        index + 1
      ) % states.length
    ];

  await query(`
    UPDATE public.lr_purchases

    SET
      payment_status=$2,
      updated_at=now()

    WHERE id=$1
  `, [
    Number(purchase.id),
    next,
  ]);

  await showPurchase(
    update,
    purchase.id,
    `💳 Статус изменён: <b>${paymentMeta(next)}</b>.`
  );
}

async function archivePurchase(
  update,
  purchaseId
) {
  const purchase =
    await loadPurchase(
      update,
      purchaseId
    );

  if (!purchase) {
    await menu(update);
    return;
  }

  const archive =
    !purchase.archived_at;

  await query(`
    UPDATE public.lr_purchases

    SET
      archived_at=
        CASE
          WHEN $2::boolean
          THEN now()
          ELSE NULL
        END,

      status=
        CASE
          WHEN $2::boolean
          THEN 'archived'
          WHEN source_post_mid IS NULL
          THEN 'awaiting_post'
          WHEN completed_at IS NOT NULL
          THEN 'completed'
          ELSE 'active'
        END,

      updated_at=now()

    WHERE id=$1
  `, [
    Number(purchase.id),
    archive,
  ]);

  await showPurchase(
    update,
    purchase.id,
    archive
      ? '✅ Закуп перенесён в архив.'
      : '✅ Закуп возвращён из архива.'
  );
}

async function handleCallback(
  update,
  payload
) {
  if (payload === 'reports:menu') {
    await clearSession(
      updateUserId(update)
    );

    await menu(update);
    return true;
  }

  if (payload === 'buy:new') {
    await startPurchase(update);
    return true;
  }

  if (payload === 'buy:cancel') {
    await clearSession(
      updateUserId(update)
    );

    await menu(update);
    return true;
  }

  let match =
    payload.match(
      /^buy:target:(\d+)$/
    );

  if (match) {
    await chooseTarget(
      update,
      Number(match[1])
    );

    return true;
  }

  match =
    payload.match(
      /^buy:duration:(24|48|72)$/
    );

  if (match) {
    const session =
      await getSession(
        updateUserId(update)
      );

    if (
      session.state !==
      'buy_pick_duration'
    ) {
      await startPurchase(update);
      return true;
    }

    return createPurchase(
      update,
      session,
      Number(match[1])
    );
  }

  match =
    payload.match(
      /^buy:list:(waiting|active|completed|attention|all|archive)$/
    );

  if (match) {
    await listPurchases(
      update,
      match[1]
    );

    return true;
  }

  match =
    payload.match(
      /^buy:(?:open|refresh):(\d+)$/
    );

  if (match) {
    await showPurchase(
      update,
      Number(match[1])
    );

    return true;
  }

  match =
    payload.match(
      /^buy:attach:(\d+)$/
    );

  if (match) {
    await beginAttach(
      update,
      Number(match[1])
    );

    return true;
  }

  match =
    payload.match(
      /^buy:payment:(\d+)$/
    );

  if (match) {
    await cyclePayment(
      update,
      Number(match[1])
    );

    return true;
  }

  match =
    payload.match(
      /^buy:archive:(\d+)$/
    );

  if (match) {
    await archivePurchase(
      update,
      Number(match[1])
    );

    return true;
  }

  return false;
}

async function handleMessage(update) {
  const maxUserId =
    updateUserId(update);

  if (!maxUserId) {
    return false;
  }

  const session =
    await getSession(maxUserId);

  if (
    session.state ===
    'buy_wait_source'
  ) {
    return saveSourceLink(
      update,
      session
    );
  }

  if (
    session.state ===
    'buy_wait_budget'
  ) {
    return saveBudget(
      update,
      session
    );
  }

  if (
    session.state ===
    'buy_wait_post'
  ) {
    return attachForwardedPost(
      update,
      session
    );
  }

  return false;
}

function mountRoutes(app) {
  app.get(
    '/buy/:token',
    async (req, res) => {
      try {
        await ensureSchema();

        const token =
          clean(
            req.params.token,
            100
          );

        const purchase = (
          await safeQuery(`
            UPDATE public.lr_purchases

            SET
              tracking_clicks=
                tracking_clicks + 1,
              updated_at=now()

            WHERE tracking_token=$1

            RETURNING target_link
          `, [token])
        )[0];

        if (!purchase) {
          return res
            .status(404)
            .type('html')
            .send(
              '<h1>Ссылка LinkRay не найдена</h1>'
            );
        }

        const target =
          clean(
            purchase.target_link,
            2000
          ) || BOT_LINK;

        return res.redirect(
          302,
          target
        );
      } catch (error) {
        console.error(
          '[LinkRay Purchase redirect]',
          error?.stack ||
          error?.message ||
          error
        );

        return res.redirect(
          302,
          BOT_LINK
        );
      }
    }
  );
}

export async function
linkRayPurchasesSmokeTest() {
  await ensureSchema();

  const tables = (
    await safeQuery(`
      SELECT
        to_regclass(
          'public.lr_purchases'
        ) AS purchases,

        to_regclass(
          'public.lr_purchase_snapshots'
        ) AS snapshots,

        to_regclass(
          'public.lr_purchase_sessions'
        ) AS sessions
    `)
  )[0] || {};

  return {
    tables,
    publicBaseUrl:
      PUBLIC_BASE_URL,
    syncIntervalMs:
      SYNC_INTERVAL_MS,
  };
}

export function
installLinkRayPurchases(app) {
  if (installed) {
    return;
  }

  installed = true;

  mountRoutes(app);

  app.use(
    async function linkRayPurchasesMiddleware(
      req,
      res,
      next
    ) {
      try {
        const path = String(
          req.path ||
          req.url ||
          ''
        );

        if (
          req.method !== 'POST' ||
          !/\/webhook(?:$|\?)/.test(path)
        ) {
          return next();
        }

        const update =
          req.body || {};

        const payload =
          updatePayload(update);

        const maxUserId =
          updateUserId(update);

        const session =
          maxUserId
            ? await getSession(maxUserId)
            : {
                state: 'idle',
              };

        if (
          payload &&
          (
            payload === 'reports:menu' ||
            payload.startsWith('buy:')
          )
        ) {
          const handled =
            await handleCallback(
              update,
              payload
            );

          if (handled) {
            if (!res.headersSent) {
              return res.json({
                ok: true,
                handled:
                  'linkray_purchase_callback',
              });
            }

            return;
          }
        }

        if (
          [
            'buy_wait_source',
            'buy_wait_budget',
            'buy_wait_post',
          ].includes(
            session.state
          )
        ) {
          const handled =
            await handleMessage(update);

          if (handled) {
            if (!res.headersSent) {
              return res.json({
                ok: true,
                handled:
                  'linkray_purchase_input',
              });
            }

            return;
          }
        }

        return next();
      } catch (error) {
        console.error(
          '[LinkRay Purchases middleware]',
          error?.stack ||
          error?.message ||
          error
        );

        return next();
      }
    }
  );

  ensureSchema()
    .then(() =>
      syncPurchases({
        limit: 30,
      })
    )
    .catch((error) => {
      console.error(
        '[LinkRay Purchases startup]',
        error?.stack ||
        error?.message ||
        error
      );
    });

  if (!syncTimer) {
    syncTimer = setInterval(
      () => {
        syncPurchases({
          limit: 50,
        }).catch((error) => {
          console.error(
            '[LinkRay Purchases interval]',
            error?.stack ||
            error?.message ||
            error
          );
        });
      },
      SYNC_INTERVAL_MS
    );

    syncTimer.unref?.();
  }

  console.log(
    '[LinkRay Purchases] installed',
    JSON.stringify({
      intervalMs:
        SYNC_INTERVAL_MS,
      publicBaseUrl:
        PUBLIC_BASE_URL,
    })
  );
}

export {
  syncPurchase,
  syncPurchases,
};

