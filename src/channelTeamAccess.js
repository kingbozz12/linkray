import { query } from './db.js';

const API_BASE = String(
  process.env.MAX_API_BASE ||
  process.env.MAX_API_BASE_URL ||
  process.env.MAX_PLATFORM_API ||
  'https://platform-api2.max.ru'
).replace(/\/+$/, '');

const ACCESS_TOKEN = String(
  process.env.MAX_TOKEN ||
  process.env.MAX_BOT_TOKEN ||
  process.env.MAX_ACCESS_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.ACCESS_TOKEN ||
  ''
).trim();

/*
 * Пока оплаты нет, весь LinkRay остаётся бесплатным.
 * После подключения платежей установим false.
 */
const FREE_ACCESS_ENABLED =
  String(
    process.env.LR_FREE_ACCESS_ENABLED ??
    'true'
  ).toLowerCase() !== 'false';

const SYNC_INTERVAL_MS = Math.max(
  60_000,
  Number(
    process.env.LR_TEAM_ACCESS_SYNC_MS ||
    5 * 60_000
  )
);

let schemaPromise = null;
let syncTimer = null;
let syncRunning = false;

function rows(result) {
  if (Array.isArray(result)) {
    return result;
  }

  return Array.isArray(result?.rows)
    ? result.rows
    : [];
}

function clean(value, max = 500) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function number(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function permissions(value) {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .map((item) => clean(item, 100))
          .filter(Boolean)
      ),
    ];
  }

  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([name]) => clean(name, 100))
      .filter(Boolean);
  }

  return [];
}

function normalizeAdmin(raw) {
  const user =
    raw?.user ||
    raw?.member ||
    raw?.profile ||
    raw ||
    {};

  const userId = clean(
    user?.user_id ||
    user?.userId ||
    user?.id ||
    raw?.user_id ||
    raw?.userId ||
    raw?.id,
    100
  );

  if (!/^\d+$/.test(userId)) {
    return null;
  }

  const isBot = Boolean(
    user?.is_bot ??
    user?.isBot ??
    raw?.is_bot ??
    raw?.isBot
  );

  const isOwner = Boolean(
    raw?.is_owner ??
    raw?.isOwner ??
    user?.is_owner ??
    user?.isOwner ??
    raw?.owner
  );

  return {
    userId,
    isBot,
    isOwner,
    role: isOwner ? 'owner' : 'admin',

    permissions: permissions(
      raw?.permissions ||
      user?.permissions ||
      raw?.rights ||
      user?.rights ||
      []
    ),
  };
}

export async function ensureTeamAccessSchema() {
  if (schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = (async () => {
    /*
     * Связь пользователей с каналами:
     * один канал может иметь много администраторов.
     */
    await query(`
      ALTER TABLE public.lr_user_channels
        ADD COLUMN IF NOT EXISTS
          access_source text
          NOT NULL DEFAULT 'legacy',

        ADD COLUMN IF NOT EXISTS
          role text
          NOT NULL DEFAULT 'member',

        ADD COLUMN IF NOT EXISTS
          permissions jsonb
          NOT NULL DEFAULT '[]'::jsonb,

        ADD COLUMN IF NOT EXISTS
          last_verified_at timestamptz
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
        lr_user_channels_verified_idx
      ON public.lr_user_channels(
        channel_id,
        last_verified_at DESC
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_channel_team_sync_state (
          channel_id integer PRIMARY KEY
            REFERENCES public.channels(id)
            ON DELETE CASCADE,

          max_chat_id text,

          last_attempt_at timestamptz,
          last_success_at timestamptz,

          admins_seen integer
            NOT NULL DEFAULT 0,

          registered_admins_linked integer
            NOT NULL DEFAULT 0,

          last_error text,

          updated_at timestamptz
            NOT NULL DEFAULT now()
        )
    `);

    /*
     * Настройки тарифов для общих подписок.
     */
    await query(`
      ALTER TABLE public.lr_tariffs
        ADD COLUMN IF NOT EXISTS
          channel_limit integer,

        ADD COLUMN IF NOT EXISTS
          team_access boolean
          NOT NULL DEFAULT true
    `);

    await query(`
      ALTER TABLE public.lr_user_subscriptions
        ADD COLUMN IF NOT EXISTS
          channel_selection_mode text
          NOT NULL DEFAULT 'auto'
    `);

    /*
     * Каналы, оплаченные конкретной подпиской.
     */
    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_subscription_channels (
          subscription_id bigint NOT NULL
            REFERENCES public.lr_user_subscriptions(id)
            ON DELETE CASCADE,

          channel_id integer NOT NULL
            REFERENCES public.channels(id)
            ON DELETE CASCADE,

          assigned_by_user_id bigint
            REFERENCES public.lr_users(id)
            ON DELETE SET NULL,

          source text
            NOT NULL DEFAULT 'payment',

          assigned_at timestamptz
            NOT NULL DEFAULT now(),

          updated_at timestamptz
            NOT NULL DEFAULT now(),

          PRIMARY KEY (
            subscription_id,
            channel_id
          )
        )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
        lr_subscription_channels_channel_idx
      ON public.lr_subscription_channels(
        channel_id
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_team_access_audit (
          id bigserial PRIMARY KEY,

          subscription_id bigint,
          channel_id integer,
          payer_user_id bigint,

          action text NOT NULL,

          details jsonb
            NOT NULL DEFAULT '{}'::jsonb,

          created_at timestamptz
            NOT NULL DEFAULT now()
        )
    `);

    await query(`
      UPDATE public.lr_tariffs
      SET
        channel_limit=NULL,
        team_access=true,
        updated_at=now()
      WHERE code='free'
    `);
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });

  return schemaPromise;
}

async function fetchChannelAdmins(maxChatId) {
  if (!ACCESS_TOKEN) {
    throw new Error(
      'Не найден токен MAX API'
    );
  }

  const collected = [];
  let marker = '';
  let page = 0;

  do {
    const url = new URL(
      `${API_BASE}/chats/${
        encodeURIComponent(maxChatId)
      }/members/admins`
    );

    if (marker) {
      url.searchParams.set(
        'marker',
        marker
      );
    }

    const response = await fetch(url, {
      method: 'GET',

      headers: {
        Authorization: ACCESS_TOKEN,
        Accept: 'application/json',
      },
    });

    const bodyText =
      await response.text();

    let data = {};

    try {
      data = bodyText
        ? JSON.parse(bodyText)
        : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      throw new Error(
        `MAX API ${response.status}: ` +
        `${clean(
          data?.message ||
          data?.error ||
          bodyText ||
          'ошибка получения администраторов',
          1000
        )}`
      );
    }

    const members =
      Array.isArray(data?.members)
        ? data.members
        : Array.isArray(
            data?.result?.members
          )
          ? data.result.members
          : [];

    collected.push(...members);

    const nextMarker = clean(
      data?.marker ??
      data?.next_marker ??
      data?.result?.marker ??
      data?.result?.next_marker,
      100
    );

    page += 1;

    if (
      !nextMarker ||
      nextMarker === marker ||
      page >= 100
    ) {
      marker = '';
    } else {
      marker = nextMarker;
    }
  } while (marker);

  const result = new Map();

  for (const raw of collected) {
    const admin = normalizeAdmin(raw);

    if (!admin || admin.isBot) {
      continue;
    }

    const previous =
      result.get(admin.userId);

    if (
      !previous ||
      admin.isOwner
    ) {
      result.set(
        admin.userId,
        admin
      );
    }
  }

  return [...result.values()];
}

async function syncOneChannel(channel) {
  const channelId = number(
    channel?.id
  );

  const maxChatId = clean(
    channel?.max_chat_id,
    100
  );

  if (
    !Number.isInteger(channelId) ||
    channelId <= 0
  ) {
    throw new Error(
      'Некорректный ID канала в базе'
    );
  }

  if (!/^-?\d+$/.test(maxChatId)) {
    throw new Error(
      'Некорректный MAX chat_id'
    );
  }

  const admins =
    await fetchChannelAdmins(
      maxChatId
    );

  const humanAdminIds =
    admins.map(
      (admin) => admin.userId
    );

  const registeredUsers =
    humanAdminIds.length
      ? rows(await query(`
          SELECT
            id,
            max_user_id,
            display_name
          FROM public.lr_users
          WHERE max_user_id=
            ANY($1::text[])
            AND COALESCE(
              is_blocked,
              false
            )=false
        `, [humanAdminIds]))
      : [];

  const userByMaxId = new Map(
    registeredUsers.map(
      (user) => [
        String(user.max_user_id),
        user,
      ]
    )
  );

  /*
   * Один и тот же канал добавляется
   * каждому зарегистрированному админу.
   */
  for (const admin of admins) {
    const user = userByMaxId.get(
      admin.userId
    );

    if (!user) {
      continue;
    }

    await query(`
      INSERT INTO public.lr_user_channels (
        user_id,
        channel_id,
        linked_at,
        access_source,
        role,
        permissions,
        last_verified_at
      )
      VALUES (
        $1,
        $2,
        now(),
        'max_admin_sync',
        $3,
        $4::jsonb,
        now()
      )
      ON CONFLICT (
        user_id,
        channel_id
      ) DO UPDATE SET
        access_source=CASE
          WHEN
            public.lr_user_channels
              .access_source='workspace'
          THEN 'workspace'
          ELSE 'max_admin_sync'
        END,

        role=EXCLUDED.role,
        permissions=EXCLUDED.permissions,
        last_verified_at=now()
    `, [
      number(user.id),
      channelId,
      admin.role,
      JSON.stringify(
        admin.permissions
      ),
    ]);
  }

  /*
   * Убираем устаревшие старые связи,
   * только если MAX вернул хотя бы
   * одного реального администратора.
   */
  if (humanAdminIds.length) {
    await query(`
      DELETE FROM public.lr_user_channels uc
      USING public.lr_users u
      WHERE uc.user_id=u.id
        AND uc.channel_id=$1

        AND COALESCE(
          uc.access_source,
          'legacy'
        ) IN (
          'legacy',
          'max_admin_sync'
        )

        AND NOT (
          u.max_user_id=
            ANY($2::text[])
        )
    `, [
      channelId,
      humanAdminIds,
    ]);
  }

  /*
   * Старое поле владельца оставляем
   * только для совместимости.
   */
  const owner = admins.find(
    (admin) =>
      admin.isOwner &&
      userByMaxId.has(admin.userId)
  );

  if (owner) {
    await query(`
      UPDATE public.channels
      SET
        owner_max_user_id=$2::bigint,
        updated_at=now()
      WHERE id=$1
    `, [
      channelId,
      owner.userId,
    ]).catch(() => {});
  }

  await query(`
    INSERT INTO
      public.lr_channel_team_sync_state (
        channel_id,
        max_chat_id,
        last_attempt_at,
        last_success_at,
        admins_seen,
        registered_admins_linked,
        last_error,
        updated_at
      )
    VALUES (
      $1,
      $2,
      now(),
      now(),
      $3,
      $4,
      NULL,
      now()
    )
    ON CONFLICT (channel_id) DO UPDATE SET
      max_chat_id=EXCLUDED.max_chat_id,
      last_attempt_at=now(),
      last_success_at=now(),
      admins_seen=
        EXCLUDED.admins_seen,
      registered_admins_linked=
        EXCLUDED.registered_admins_linked,
      last_error=NULL,
      updated_at=now()
  `, [
    channelId,
    maxChatId,
    admins.length,
    registeredUsers.length,
  ]);

  return {
    channelId,
    title: clean(
      channel?.title,
      300
    ),

    adminsSeen:
      admins.length,

    registeredAdminsLinked:
      registeredUsers.length,

    users:
      registeredUsers.map(
        (user) => ({
          name:
            clean(
              user.display_name,
              300
            ),

          maxUserId:
            String(
              user.max_user_id
            ),
        })
      ),
  };
}

export async function syncChannelTeams(
  reason = 'background'
) {
  if (syncRunning) {
    return {
      skipped: true,
      reason: 'already_running',
    };
  }

  syncRunning = true;

  try {
    await ensureTeamAccessSchema();

    const channels = rows(await query(`
      SELECT
        id,
        max_chat_id,
        title
      FROM public.channels
      WHERE COALESCE(
        is_active,
        true
      )=true
        AND max_chat_id IS NOT NULL
      ORDER BY id
    `));

    const result = {
      skipped: false,
      reason,
      total: channels.length,
      successful: 0,
      failed: 0,
      channels: [],
      errors: [],
    };

    for (const channel of channels) {
      try {
        const synced =
          await syncOneChannel(
            channel
          );

        result.successful += 1;
        result.channels.push(synced);
      } catch (error) {
        result.failed += 1;

        const message = clean(
          error?.message || error,
          2000
        );

        result.errors.push({
          channelId:
            number(channel.id),

          title:
            clean(channel.title, 300),

          error: message,
        });

        await query(`
          INSERT INTO
            public.lr_channel_team_sync_state (
              channel_id,
              max_chat_id,
              last_attempt_at,
              last_error,
              updated_at
            )
          VALUES (
            $1,
            $2,
            now(),
            $3,
            now()
          )
          ON CONFLICT (channel_id)
          DO UPDATE SET
            max_chat_id=
              EXCLUDED.max_chat_id,

            last_attempt_at=now(),
            last_error=
              EXCLUDED.last_error,

            updated_at=now()
        `, [
          number(channel.id),
          String(channel.max_chat_id),
          message,
        ]).catch(() => {});
      }
    }

    console.log(
      '[channel team sync]',
      JSON.stringify({
        reason,
        total: result.total,
        successful:
          result.successful,
        failed:
          result.failed,
      })
    );

    return result;
  } finally {
    syncRunning = false;
  }
}

/*
 * Назначает оплаченные каналы подписке.
 * Эту функцию вызовет обработчик успешного платежа.
 */
export async function assignSubscriptionChannels({
  subscriptionId,
  payerUserId,
  channelIds,
  source = 'payment',
}) {
  await ensureTeamAccessSchema();

  const safeSubscriptionId =
    number(subscriptionId);

  const safePayerUserId =
    number(payerUserId);

  const safeChannelIds = [
    ...new Set(
      (Array.isArray(channelIds)
        ? channelIds
        : []
      )
        .map((value) => number(value))
        .filter(
          (value) =>
            Number.isInteger(value) &&
            value > 0
        )
    ),
  ];

  if (
    !safeSubscriptionId ||
    !safePayerUserId
  ) {
    throw new Error(
      'Не указана подписка или плательщик'
    );
  }

  const subscription = rows(await query(`
    SELECT
      subscription.id,
      subscription.user_id,

      tariff.channel_limit,
      tariff.is_free,
      tariff.team_access

    FROM public.lr_user_subscriptions subscription

    JOIN public.lr_tariffs tariff
      ON tariff.code=
         subscription.tariff_code

    WHERE subscription.id=$1
      AND subscription.user_id=$2
      AND subscription.status='active'

      AND (
        subscription.expires_at IS NULL
        OR subscription.expires_at > now()
      )

    LIMIT 1
  `, [
    safeSubscriptionId,
    safePayerUserId,
  ]))[0];

  if (!subscription) {
    throw new Error(
      'Активная подписка не найдена'
    );
  }

  if (subscription.is_free) {
    throw new Error(
      'Бесплатный тариф не является оплатой канала'
    );
  }

  const channelLimit =
    subscription.channel_limit === null
      ? safeChannelIds.length
      : Math.max(
          0,
          number(
            subscription.channel_limit
          )
        );

  if (
    safeChannelIds.length >
    channelLimit
  ) {
    throw new Error(
      `Лимит каналов тарифа: ${channelLimit}`
    );
  }

  const allowedRows =
    safeChannelIds.length
      ? rows(await query(`
          SELECT channel_id
          FROM public.lr_user_channels
          WHERE user_id=$1
            AND channel_id=
              ANY($2::integer[])
        `, [
          safePayerUserId,
          safeChannelIds,
        ]))
      : [];

  const allowedIds =
    allowedRows.map(
      (row) => number(row.channel_id)
    );

  if (
    allowedIds.length !==
    safeChannelIds.length
  ) {
    throw new Error(
      'Плательщик не является администратором одного из каналов'
    );
  }

  /*
   * Удаление старого выбора и вставка нового
   * происходят одним атомарным SQL-запросом.
   */
  await query(`
    WITH subscription_update AS (
      UPDATE public.lr_user_subscriptions
      SET
        channel_selection_mode='manual',
        updated_at=now()
      WHERE id=$1
      RETURNING id
    ),

    removed AS (
      DELETE FROM public.lr_subscription_channels
      WHERE subscription_id=$1
      RETURNING channel_id
    )

    INSERT INTO public.lr_subscription_channels (
      subscription_id,
      channel_id,
      assigned_by_user_id,
      source,
      assigned_at,
      updated_at
    )
    SELECT
      $1,
      channel_id,
      $2,
      $3,
      now(),
      now()
    FROM unnest(
      $4::integer[]
    ) AS channel_id
  `, [
    safeSubscriptionId,
    safePayerUserId,
    clean(source, 50) || 'payment',
    allowedIds,
  ]);

  await query(`
    INSERT INTO public.lr_team_access_audit (
      subscription_id,
      payer_user_id,
      action,
      details
    )
    VALUES (
      $1,
      $2,
      'subscription_channels_assigned',
      $3::jsonb
    )
  `, [
    safeSubscriptionId,
    safePayerUserId,
    JSON.stringify({
      channel_ids: allowedIds,
      source:
        clean(source, 50) ||
        'payment',
    }),
  ]);

  return {
    subscriptionId:
      safeSubscriptionId,

    payerUserId:
      safePayerUserId,

    channelIds:
      allowedIds,
  };
}

/*
 * Готовая функция для будущего платёжного обработчика.
 * Бесплатная активная подписка пользователя
 * преобразуется в оплаченный тариф.
 */
export async function activatePaidSubscription({
  maxUserId,
  tariffCode,
  expiresAt,
  channelIds,
  paymentProvider = null,
  externalPaymentId = null,
}) {
  await ensureTeamAccessSchema();

  const safeMaxUserId =
    clean(maxUserId, 100);

  const safeTariffCode =
    clean(tariffCode, 100);

  if (!/^\d+$/.test(safeMaxUserId)) {
    throw new Error(
      'Некорректный MAX user ID'
    );
  }

  const user = rows(await query(`
    SELECT id
    FROM public.lr_users
    WHERE max_user_id=$1
      AND COALESCE(
        is_blocked,
        false
      )=false
    LIMIT 1
  `, [safeMaxUserId]))[0];

  if (!user) {
    throw new Error(
      'Пользователь LinkRay не найден'
    );
  }

  const tariff = rows(await query(`
    SELECT *
    FROM public.lr_tariffs
    WHERE code=$1
      AND COALESCE(
        is_active,
        true
      )=true
      AND COALESCE(
        is_free,
        false
      )=false
    LIMIT 1
  `, [safeTariffCode]))[0];

  if (!tariff) {
    throw new Error(
      'Платный тариф не найден'
    );
  }

  let subscription = rows(await query(`
    SELECT id
    FROM public.lr_user_subscriptions
    WHERE user_id=$1
      AND status='active'
    ORDER BY id DESC
    LIMIT 1
  `, [number(user.id)]))[0];

  if (subscription) {
    subscription = rows(await query(`
      UPDATE public.lr_user_subscriptions
      SET
        tariff_code=$2,
        status='active',
        starts_at=now(),
        expires_at=$3,
        auto_renew=false,
        payment_provider=$4,
        external_payment_id=$5,
        source='payment',
        updated_at=now()
      WHERE id=$1
      RETURNING id
    `, [
      number(subscription.id),
      safeTariffCode,
      expiresAt || null,
      paymentProvider,
      externalPaymentId,
    ]))[0];
  } else {
    subscription = rows(await query(`
      INSERT INTO public.lr_user_subscriptions (
        user_id,
        tariff_code,
        status,
        starts_at,
        expires_at,
        auto_renew,
        payment_provider,
        external_payment_id,
        source,
        updated_at
      )
      VALUES (
        $1,
        $2,
        'active',
        now(),
        $3,
        false,
        $4,
        $5,
        'payment',
        now()
      )
      RETURNING id
    `, [
      number(user.id),
      safeTariffCode,
      expiresAt || null,
      paymentProvider,
      externalPaymentId,
    ]))[0];
  }

  return assignSubscriptionChannels({
    subscriptionId:
      number(subscription.id),

    payerUserId:
      number(user.id),

    channelIds,
    source: 'payment',
  });
}

export async function resolveChannelTeamAccess({
  maxUserId,
  channelId,
}) {
  await ensureTeamAccessSchema();

  const safeMaxUserId =
    clean(maxUserId, 100);

  const safeChannelId =
    number(channelId);

  if (
    !/^\d+$/.test(safeMaxUserId) ||
    !safeChannelId
  ) {
    return {
      allowed: false,
      reason: 'invalid_user_or_channel',
    };
  }

  const user = rows(await query(`
    SELECT id
    FROM public.lr_users
    WHERE max_user_id=$1
      AND COALESCE(
        is_blocked,
        false
      )=false
    LIMIT 1
  `, [safeMaxUserId]))[0];

  if (!user) {
    return {
      allowed: false,
      reason: 'user_not_registered',
    };
  }

  const member = rows(await query(`
    SELECT 1
    FROM public.lr_user_channels
    WHERE user_id=$1
      AND channel_id=$2
    LIMIT 1
  `, [
    number(user.id),
    safeChannelId,
  ])).length > 0;

  if (!member) {
    return {
      allowed: false,
      reason: 'not_channel_admin',
    };
  }

  if (FREE_ACCESS_ENABLED) {
    return {
      allowed: true,
      shared: false,
      reason: 'free_period',
    };
  }

  const entitlement = rows(await query(`
    SELECT
      subscription.id
        AS subscription_id,

      subscription.expires_at,

      tariff.code
        AS tariff_code,

      tariff.title
        AS tariff_title,

      payer.id
        AS payer_user_id,

      payer.max_user_id
        AS payer_max_user_id,

      payer.display_name
        AS payer_name

    FROM public.lr_subscription_channels assignment

    JOIN public.lr_user_subscriptions subscription
      ON subscription.id=
         assignment.subscription_id

    JOIN public.lr_tariffs tariff
      ON tariff.code=
         subscription.tariff_code

    JOIN public.lr_users payer
      ON payer.id=
         subscription.user_id

    WHERE assignment.channel_id=$1

      AND subscription.status='active'

      AND (
        subscription.expires_at IS NULL
        OR subscription.expires_at > now()
      )

      AND COALESCE(
        tariff.is_free,
        false
      )=false

      AND COALESCE(
        tariff.is_active,
        true
      )=true

      AND (
        payer.id=$2
        OR COALESCE(
          tariff.team_access,
          true
        )=true
      )

    ORDER BY
      CASE
        WHEN payer.id=$2
          THEN 0
        ELSE 1
      END,

      subscription.id DESC

    LIMIT 1
  `, [
    safeChannelId,
    number(user.id),
  ]))[0];

  if (!entitlement) {
    return {
      allowed: false,
      reason: 'subscription_required',
    };
  }

  const shared =
    number(entitlement.payer_user_id) !==
    number(user.id);

  return {
    allowed: true,
    shared,

    reason: shared
      ? 'shared_subscription'
      : 'own_subscription',

    subscriptionId:
      number(
        entitlement.subscription_id
      ),

    tariffTitle:
      clean(
        entitlement.tariff_title,
        200
      ),

    expiresAt:
      entitlement.expires_at,

    payer: {
      userId:
        number(
          entitlement.payer_user_id
        ),

      maxUserId:
        clean(
          entitlement.payer_max_user_id,
          100
        ),

      name:
        clean(
          entitlement.payer_name,
          300
        ),
    },
  };
}

export async function getProfileTeamAccess(
  maxUserId
) {
  await ensureTeamAccessSchema();

  const safeMaxUserId =
    clean(maxUserId, 100);

  const user = rows(await query(`
    SELECT id
    FROM public.lr_users
    WHERE max_user_id=$1
    LIMIT 1
  `, [safeMaxUserId]))[0];

  if (!user) {
    return {
      freeMode:
        FREE_ACCESS_ENABLED,

      ownPaid: null,
      sharedChannels: [],
    };
  }

  const ownPaid = rows(await query(`
    SELECT
      subscription.id,
      subscription.expires_at,

      tariff.code,
      tariff.title,
      tariff.channel_limit,

      COUNT(
        assignment.channel_id
      )::integer
        AS assigned_channels

    FROM public.lr_user_subscriptions subscription

    JOIN public.lr_tariffs tariff
      ON tariff.code=
         subscription.tariff_code

    LEFT JOIN public.lr_subscription_channels assignment
      ON assignment.subscription_id=
         subscription.id

    WHERE subscription.user_id=$1
      AND subscription.status='active'

      AND (
        subscription.expires_at IS NULL
        OR subscription.expires_at > now()
      )

      AND COALESCE(
        tariff.is_free,
        false
      )=false

    GROUP BY
      subscription.id,
      subscription.expires_at,
      tariff.code,
      tariff.title,
      tariff.channel_limit

    ORDER BY subscription.id DESC
    LIMIT 1
  `, [number(user.id)]))[0] || null;

  const sharedRows = rows(await query(`
    SELECT
      channel.id AS channel_id,
      channel.title AS channel_title,

      tariff.title AS tariff_title,
      subscription.expires_at,

      payer.id AS payer_user_id,
      payer.display_name AS payer_name,
      payer.max_user_id AS payer_max_user_id,

      subscription.id AS subscription_id

    FROM public.lr_user_channels membership

    JOIN public.channels channel
      ON channel.id=
         membership.channel_id

    JOIN public.lr_subscription_channels assignment
      ON assignment.channel_id=
         channel.id

    JOIN public.lr_user_subscriptions subscription
      ON subscription.id=
         assignment.subscription_id

    JOIN public.lr_tariffs tariff
      ON tariff.code=
         subscription.tariff_code

    JOIN public.lr_users payer
      ON payer.id=
         subscription.user_id

    WHERE membership.user_id=$1
      AND payer.id<>$1

      AND subscription.status='active'

      AND (
        subscription.expires_at IS NULL
        OR subscription.expires_at > now()
      )

      AND COALESCE(
        tariff.is_free,
        false
      )=false

      AND COALESCE(
        tariff.team_access,
        true
      )=true

      AND COALESCE(
        channel.is_active,
        true
      )=true

    ORDER BY
      channel.id,
      subscription.id DESC
  `, [number(user.id)]));

  const uniqueShared = new Map();

  for (const item of sharedRows) {
    const channelId = number(
      item.channel_id
    );

    if (!uniqueShared.has(channelId)) {
      uniqueShared.set(
        channelId,
        item
      );
    }
  }

  return {
    freeMode:
      FREE_ACCESS_ENABLED,

    ownPaid:
      ownPaid
        ? {
            subscriptionId:
              number(ownPaid.id),

            tariffTitle:
              clean(
                ownPaid.title,
                200
              ),

            assignedChannels:
              number(
                ownPaid.assigned_channels
              ),

            channelLimit:
              ownPaid.channel_limit === null
                ? null
                : number(
                    ownPaid.channel_limit
                  ),

            expiresAt:
              ownPaid.expires_at,
          }
        : null,

    sharedChannels: [
      ...uniqueShared.values(),
    ].map((item) => ({
      channelId:
        number(item.channel_id),

      channelTitle:
        clean(
          item.channel_title,
          300
        ),

      tariffTitle:
        clean(
          item.tariff_title,
          200
        ),

      expiresAt:
        item.expires_at,

      payerName:
        clean(
          item.payer_name,
          300
        ),

      payerMaxUserId:
        clean(
          item.payer_max_user_id,
          100
        ),
    })),
  };
}

export function startChannelTeamAccess() {
  if (syncTimer) {
    return;
  }

  const run = async () => {
    try {
      await ensureTeamAccessSchema();
      await syncChannelTeams(
        'background'
      );
    } catch (error) {
      console.error(
        '[channel team access]',
        error?.stack ||
        error?.message ||
        error
      );
    }
  };

  setTimeout(run, 5_000)
    .unref?.();

  syncTimer = setInterval(
    run,
    SYNC_INTERVAL_MS
  );

  syncTimer.unref?.();

  console.log(
    '[channel team access] started',
    JSON.stringify({
      freeAccess:
        FREE_ACCESS_ENABLED,

      intervalMs:
        SYNC_INTERVAL_MS,
    })
  );
}
