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

const SYNC_INTERVAL_MS = Math.max(
  60_000,
  Number(
    process.env.LR_CHANNEL_ACCESS_SYNC_MS ||
    5 * 60_000
  )
);

let timer = null;
let startupTimer = null;
let syncRunning = false;

function rows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

function clean(value, max = 500) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function normalizePermissions(value) {
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

  const permissions = normalizePermissions(
    raw?.permissions ||
    user?.permissions ||
    raw?.rights ||
    user?.rights ||
    []
  );

  return {
    userId,
    isBot,
    isOwner,
    role: isOwner ? 'owner' : 'admin',
    permissions,
  };
}

async function ensureSchema() {
  await query(`
    ALTER TABLE public.lr_user_channels
      ADD COLUMN IF NOT EXISTS access_source text
        NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS role text
        NOT NULL DEFAULT 'member',
      ADD COLUMN IF NOT EXISTS permissions jsonb
        NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS last_verified_at timestamptz
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
      public.lr_channel_access_sync_state (
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
}

async function fetchAdmins(maxChatId) {
  if (!ACCESS_TOKEN) {
    throw new Error(
      'MAX API token is not configured'
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
      url.searchParams.set('marker', marker);
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: ACCESS_TOKEN,
        Accept: 'application/json',
      },
    });

    const bodyText = await response.text();
    let data = {};

    try {
      data = bodyText
        ? JSON.parse(bodyText)
        : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      const apiMessage = clean(
        data?.message ||
        data?.error ||
        bodyText ||
        `HTTP ${response.status}`,
        1000
      );

      throw new Error(
        `MAX admins request failed for ` +
        `${maxChatId}: ` +
        `${response.status} ${apiMessage}`
      );
    }

    const members = Array.isArray(data?.members)
      ? data.members
      : Array.isArray(data?.result?.members)
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

  const byUserId = new Map();

  for (const raw of collected) {
    const admin = normalizeAdmin(raw);

    if (!admin || admin.isBot) {
      continue;
    }

    const previous = byUserId.get(
      admin.userId
    );

    if (!previous || admin.isOwner) {
      byUserId.set(
        admin.userId,
        admin
      );
    }
  }

  return [...byUserId.values()];
}

async function recordFailure(channel, error) {
  const message = clean(
    error?.message || error,
    2000
  );

  await query(`
    INSERT INTO
      public.lr_channel_access_sync_state (
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
    ON CONFLICT (channel_id) DO UPDATE SET
      max_chat_id=EXCLUDED.max_chat_id,
      last_attempt_at=now(),
      last_error=EXCLUDED.last_error,
      updated_at=now()
  `, [
    channel.id,
    String(channel.max_chat_id),
    message,
  ]).catch(() => {});
}

export async function syncChannelAccess(
  channel
) {
  const channelId = Number(channel?.id);

  const maxChatId = clean(
    channel?.max_chat_id,
    100
  );

  if (
    !Number.isInteger(channelId) ||
    channelId <= 0
  ) {
    throw new Error(
      'Invalid internal channel id'
    );
  }

  if (!/^-?\d+$/.test(maxChatId)) {
    throw new Error(
      `Invalid MAX chat id for channel ${channelId}`
    );
  }

  const admins = await fetchAdmins(
    maxChatId
  );

  const adminIds = admins.map(
    (admin) => admin.userId
  );

  /*
   * В связь добавляются только пользователи,
   * которые уже зарегистрировались в LinkRay.
   */
  const registeredUsers = adminIds.length
    ? rows(await query(`
        SELECT
          id,
          max_user_id,
          display_name
        FROM public.lr_users
        WHERE max_user_id=ANY($1::text[])
          AND COALESCE(
            is_blocked,
            false
          )=false
      `, [adminIds]))
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
   * Добавляем каждому зарегистрированному
   * владельцу или администратору канал.
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
      Number(user.id),
      channelId,
      admin.role,
      JSON.stringify(
        admin.permissions
      ),
    ]);
  }

  /*
   * Удаляем старые ошибочные связи,
   * если человек больше не является
   * администратором канала в MAX.
   *
   * Будущие связи рабочего пространства
   * с источником workspace не удаляются.
   */
  await query(`
    DELETE FROM public.lr_user_channels uc
    USING public.lr_users u
    WHERE uc.user_id=u.id
      AND uc.channel_id=$1
      AND COALESCE(
        uc.access_source,
        'legacy'
      )<>'workspace'
      AND NOT (
        u.max_user_id=
          ANY($2::text[])
      )
  `, [
    channelId,
    adminIds,
  ]);

  /*
   * Техническое поле владельца оставляем
   * для совместимости со старым кодом.
   */
  const registeredOwner = admins.find(
    (admin) =>
      admin.isOwner &&
      userByMaxId.has(admin.userId)
  );

  if (registeredOwner) {
    await query(`
      UPDATE public.channels
      SET
        owner_max_user_id=$2::bigint,
        updated_at=now()
      WHERE id=$1
    `, [
      channelId,
      registeredOwner.userId,
    ]).catch((error) => {
      console.error(
        '[channel access sync] ' +
        'owner update failed',
        error?.message || error
      );
    });
  }

  await query(`
    INSERT INTO
      public.lr_channel_access_sync_state (
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
    maxChatId,
    title: clean(
      channel?.title,
      300
    ),

    adminsSeen: admins.length,

    registeredAdminsLinked:
      registeredUsers.length,

    linkedUsers:
      registeredUsers.map((user) => ({
        id: Number(user.id),

        maxUserId:
          String(user.max_user_id),

        name: clean(
          user.display_name,
          300
        ),

        role:
          admins.find(
            (admin) =>
              admin.userId ===
              String(user.max_user_id)
          )?.role || 'admin',
      })),
  };
}

export async function syncAllChannelAccess(
  options = {}
) {
  if (syncRunning) {
    return {
      skipped: true,
      reason: 'already_running',
      total: 0,
      successful: 0,
      failed: 0,
      channels: [],
      errors: [],
    };
  }

  syncRunning = true;

  try {
    await ensureSchema();

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

      reason: clean(
        options?.reason ||
        'scheduled',
        100
      ),

      total: channels.length,
      successful: 0,
      failed: 0,
      channels: [],
      errors: [],
    };

    for (const channel of channels) {
      try {
        const synced =
          await syncChannelAccess(
            channel
          );

        result.successful += 1;
        result.channels.push(synced);
      } catch (error) {
        result.failed += 1;

        result.errors.push({
          channelId:
            Number(channel.id),

          title:
            clean(channel.title, 300),

          error:
            clean(
              error?.message || error,
              2000
            ),
        });

        await recordFailure(
          channel,
          error
        );

        console.error(
          '[channel access sync] ' +
          'channel failed',
          JSON.stringify(
            result.errors.at(-1)
          )
        );
      }
    }

    console.log(
      '[channel access sync] complete',
      JSON.stringify({
        reason: result.reason,
        total: result.total,
        successful:
          result.successful,
        failed: result.failed,
      })
    );

    return result;
  } finally {
    syncRunning = false;
  }
}

export function startChannelAccessSync() {
  if (timer || startupTimer) {
    return;
  }

  const run = () => {
    syncAllChannelAccess({
      reason: 'background',
    }).catch((error) => {
      console.error(
        '[channel access sync] ' +
        'background failed',
        error?.stack ||
        error?.message ||
        error
      );
    });
  };

  startupTimer = setTimeout(() => {
    startupTimer = null;
    run();
  }, 5_000);

  startupTimer.unref?.();

  timer = setInterval(
    run,
    SYNC_INTERVAL_MS
  );

  timer.unref?.();

  console.log(
    '[channel access sync] started',
    JSON.stringify({
      intervalMs:
        SYNC_INTERVAL_MS,
    })
  );
}

export function stopChannelAccessSync() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
