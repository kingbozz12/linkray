/* LR_AUDIENCE_NO_AVATAR_FRAUD_CRITERION_V1 */
/* LR_AUDIENCE_BOTS_AND_WEB_REPORT_FIX_V1 */
/* LR_AUDIENCE_STATIC_NAMES_PDP_LINK_V1 */
/* LR_AUDIENCE_PROFILE_BOT_FALLBACK_V1 */
/* LR_AUDIENCE_PROFILE_LINK_FAVICON_V3 */
import crypto from 'node:crypto';

import { query } from './db.js';
import {
  sendMaxMessage,
  answerCallback,
  callbackButton,
  linkButton,
  inlineKeyboard,
} from './maxClient.js';

const API_BASE = (
  process.env.MAX_API_URL ||
  process.env.MAX_BASE_URL ||
  'https://platform-api2.max.ru'
).replace(/\/+$/, '');

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ||
  process.env.BASE_URL ||
  process.env.SITE_URL ||
  'https://linkray.ru'
).replace(/\/+$/, '');

const SYNC_INTERVAL_MS = Math.max(
  60 * 60_000,
  Number(
    process.env.LR_AUDIENCE_SYNC_INTERVAL_MS ||
    6 * 60 * 60_000
  )
);

const MAX_SYNC_MEMBERS = Math.max(
  1_000,
  Number(
    process.env.LR_AUDIENCE_SYNC_MAX_MEMBERS ||
    100_000
  )
);

let installed = false;
let schemaPromise = null;
let syncTimer = null;

function rows(result) {
  return Array.isArray(result)
    ? result
    : (result?.rows || []);
}

function clean(value, max = 2_000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function int(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? Math.round(number)
    : fallback;
}

function unixMs(value) {
  const number = Number(value || 0);

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {
    return 0;
  }

  return number < 10_000_000_000
    ? Math.round(number * 1_000)
    : Math.round(number);
}

function token() {
  return (
    process.env.BOT_TOKEN ||
    process.env.MAX_BOT_TOKEN ||
    process.env.MAX_TOKEN ||
    ''
  );
}

function reportSecret() {
  return (
    process.env.LR_AUDIENCE_REPORT_SECRET ||
    process.env.MAX_WEBHOOK_SECRET ||
    process.env.WEBHOOK_SECRET ||
    token() ||
    'linkray-audience-report-secret'
  );
}

function sha(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex');
}

function memberHash(
  channelId,
  userId
) {
  const salt =
    process.env.LR_ANALYTICS_HASH_SALT ||
    process.env.MAX_WEBHOOK_SECRET ||
    token() ||
    'linkray-channel-analytics';

  return sha(
    `${salt}:${channelId}:${userId}`
  );
}

function base64UrlEncode(value) {
  return Buffer
    .from(String(value), 'utf8')
    .toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer
    .from(String(value), 'base64url')
    .toString('utf8');
}

function safeEqual(left, right) {
  const a = Buffer.from(
    String(left || ''),
    'utf8'
  );

  const b = Buffer.from(
    String(right || ''),
    'utf8'
  );

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

function signPayload(encoded) {
  return crypto
    .createHmac(
      'sha256',
      reportSecret()
    )
    .update(encoded)
    .digest('base64url');
}

function normalizeDate(
  value,
  fallback
) {
  const date = value
    ? new Date(value)
    : new Date(fallback);

  return Number.isNaN(date.getTime())
    ? new Date(fallback)
    : date;
}

function buildReportToken(
  ownerChatId,
  channelId,
  options = {}
) {
  const now = Date.now();

  const to = normalizeDate(
    options.to,
    now
  );

  const from = normalizeDate(
    options.from,
    to.getTime() -
      Math.max(
        1,
        int(options.hours, 24)
      ) *
      60 *
      60_000
  );

  const expiresAt =
    now +
    Math.max(
      1,
      int(options.expiresDays, 14)
    ) *
    24 *
    60 *
    60_000;

  const payload = {
    v: 1,
    o: clean(ownerChatId, 120),
    c: clean(channelId, 120),
    f: from.getTime(),
    t: to.getTime(),
    e: expiresAt,
  };

  const encoded =
    base64UrlEncode(
      JSON.stringify(payload)
    );

  return `${encoded}.${signPayload(encoded)}`;
}

function parseReportToken(value) {
  const parts =
    String(value || '').split('.');

  if (parts.length !== 2) {
    return null;
  }

  const [
    encoded,
    signature,
  ] = parts;

  if (
    !encoded ||
    !signature ||
    !safeEqual(
      signPayload(encoded),
      signature
    )
  ) {
    return null;
  }

  try {
    const payload =
      JSON.parse(
        base64UrlDecode(encoded)
      );

    if (
      payload?.v !== 1 ||
      !payload?.o ||
      !payload?.c ||
      !Number.isFinite(
        Number(payload?.f)
      ) ||
      !Number.isFinite(
        Number(payload?.t)
      ) ||
      !Number.isFinite(
        Number(payload?.e)
      ) ||
      Number(payload.e) < Date.now()
    ) {
      return null;
    }

    return {
      ownerChatId:
        clean(payload.o, 120),
      channelId:
        clean(payload.c, 120),
      from:
        new Date(Number(payload.f)),
      to:
        new Date(Number(payload.t)),
      expiresAt:
        new Date(Number(payload.e)),
    };
  } catch {
    return null;
  }
}

export function createAudienceReportLink(
  ownerChatId,
  channelId,
  options = {}
) {
  const reportToken =
    buildReportToken(
      ownerChatId,
      channelId,
      options
    );

  return (
    `${PUBLIC_BASE_URL}` +
    `/audience/${encodeURIComponent(reportToken)}`
  );
}

function displayName(user = {}) {
  const full = [
    clean(
      user?.first_name ||
      user?.firstName
    ),
    clean(
      user?.last_name ||
      user?.lastName
    ),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  return (
    full ||
    clean(user?.name) ||
    clean(user?.username) ||
    'Пользователь MAX'
  );
}

function audienceBotUsername() {
  return clean(
    process.env.MAX_BOT_USERNAME ||
    process.env.BOT_USERNAME ||
    process.env.MAX_BOT_NAME ||
    'se13353901_bot',
    200
  )
    .replace(/^@/, '')
    .trim();
}

function buildAudienceUserPayload(
  userId
) {
  const id =
    clean(userId, 80);

  if (
    !id ||
    !/^-?\d+$/.test(id)
  ) {
    return '';
  }

  const expires =
    Math.floor(
      Date.now() / 1_000
    ) +
    7 * 24 * 60 * 60;

  const expires36 =
    expires.toString(36);

  const body =
    `${id}_${expires36}`;

  const signature =
    signPayload(
      `audience-user:${body}`
    ).slice(0, 20);

  return (
    `audusr_${body}_${signature}`
  );
}

function parseAudienceUserPayload(
  value
) {
  const match =
    clean(value, 300).match(
      /^audusr_(-?\d+)_([0-9a-z]+)_([A-Za-z0-9_-]{20})$/
    );

  if (!match) {
    return null;
  }

  const [
    ,
    userId,
    expires36,
    signature,
  ] = match;

  const expires =
    Number.parseInt(
      expires36,
      36
    );

  if (
    !Number.isFinite(expires) ||
    expires <
      Math.floor(
        Date.now() / 1_000
      )
  ) {
    return null;
  }

  const body =
    `${userId}_${expires36}`;

  const expected =
    signPayload(
      `audience-user:${body}`
    ).slice(0, 20);

  if (
    !safeEqual(
      expected,
      signature
    )
  ) {
    return null;
  }

  return {
    userId,
    expires,
  };
}

function profileUrl(
  userId,
  username
) {
  const publicName =
    clean(username, 200)
      .replace(/^@/, '')
      .trim();

  if (publicName) {
    return (
      `https://max.ru/` +
      encodeURIComponent(
        publicName
      )
    );
  }

  const payload =
    buildAudienceUserPayload(
      userId
    );

  const botUsername =
    audienceBotUsername();

  if (
    payload &&
    botUsername
  ) {
    return (
      `https://max.ru/` +
      encodeURIComponent(
        botUsername
      ) +
      `?start=` +
      encodeURIComponent(
        payload
      )
    );
  }

  return '';
}

async function handleAudienceUserStart(
  update
) {
  const type =
    clean(
      update?.update_type ||
      update?.type,
      100
    );

  if (type !== 'bot_started') {
    return false;
  }

  const parsed =
    parseAudienceUserPayload(
      update?.payload ||
      update?.start_param ||
      update?.startParam
    );

  if (!parsed) {
    return false;
  }

  const chatId =
    getChatId(update);

  if (!chatId) {
    return false;
  }

  const result =
    await query(`
      SELECT
        display_name,
        first_name,
        last_name,
        username

      FROM
        public.lr_channel_member_profiles

      WHERE max_user_id=$1

      ORDER BY
        last_seen_at DESC,
        id DESC

      LIMIT 1
    `, [
      String(
        parsed.userId
      ),
    ]).catch(() => []);

  const profile =
    rows(result)[0] || {};

  const name =
    clean(
      profile.display_name,
      300
    ) ||
    [
      clean(
        profile.first_name,
        150
      ),
      clean(
        profile.last_name,
        150
      ),
    ]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    'Пользователь MAX';

  const mention =
    `<a href="max://user/${escapeHtml(
      parsed.userId
    )}">${escapeHtml(name)}</a>`;

  await sendMaxMessage({
    chatId,
    format: 'html',
    text: [
      '👤 <b>Профиль участника MAX</b>',
      '',
      mention,
      '',
      'Нажмите на имя выше — профиль откроется внутри MAX.',
    ].join('\n'),
  });

  return true;
}

async function ensureSchema() {
  if (schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS
      public.lr_channel_member_events (
        id bigserial PRIMARY KEY,
        event_key text NOT NULL UNIQUE,
        channel_id text NOT NULL,
        event_type text NOT NULL
          CHECK (
            event_type IN (
              'joined',
              'left'
            )
          ),
        user_hash text,
        source text NOT NULL
          DEFAULT 'webhook',
        occurred_at timestamptz
          NOT NULL,
        raw jsonb NOT NULL
          DEFAULT '{}'::jsonb,
        created_at timestamptz
          NOT NULL DEFAULT now()
      )
    `);

    await query(`
      ALTER TABLE
      public.lr_channel_member_events

      ADD COLUMN IF NOT EXISTS
        max_user_id text,

      ADD COLUMN IF NOT EXISTS
        first_name text,

      ADD COLUMN IF NOT EXISTS
        last_name text,

      ADD COLUMN IF NOT EXISTS
        display_name text,

      ADD COLUMN IF NOT EXISTS
        username text,

      ADD COLUMN IF NOT EXISTS
        avatar_url text,

      ADD COLUMN IF NOT EXISTS
        full_avatar_url text,

      ADD COLUMN IF NOT EXISTS
        joined_at timestamptz,

      ADD COLUMN IF NOT EXISTS
        left_at timestamptz,

      ADD COLUMN IF NOT EXISTS
        stay_seconds bigint,

      ADD COLUMN IF NOT EXISTS
        risk_score integer
          NOT NULL DEFAULT 0,

      ADD COLUMN IF NOT EXISTS
        risk_flags jsonb
          NOT NULL DEFAULT '[]'::jsonb
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
      lr_member_events_identity_idx

      ON public.lr_channel_member_events (
        channel_id,
        max_user_id,
        occurred_at DESC
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
      lr_member_events_risk_idx

      ON public.lr_channel_member_events (
        channel_id,
        risk_score DESC,
        occurred_at DESC
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
      public.lr_channel_member_profiles (
        channel_id text NOT NULL,
        max_user_id text NOT NULL,
        user_hash text NOT NULL,
        first_name text,
        last_name text,
        display_name text
          NOT NULL DEFAULT
          'Пользователь MAX',
        username text,
        avatar_url text,
        full_avatar_url text,
        join_time timestamptz,
        last_activity_time timestamptz,
        is_current boolean
          NOT NULL DEFAULT true,
        first_seen_at timestamptz
          NOT NULL DEFAULT now(),
        last_seen_at timestamptz
          NOT NULL DEFAULT now(),
        raw jsonb NOT NULL
          DEFAULT '{}'::jsonb,
        PRIMARY KEY (
          channel_id,
          max_user_id
        )
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
      lr_member_profiles_hash_idx

      ON public.lr_channel_member_profiles (
        channel_id,
        user_hash
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
      lr_member_profiles_name_idx

      ON public.lr_channel_member_profiles (
        channel_id,
        lower(display_name)
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
      public.lr_channel_memberships (
        id bigserial PRIMARY KEY,
        channel_id text NOT NULL,
        max_user_id text,
        user_hash text NOT NULL,
        joined_at timestamptz
          NOT NULL,
        left_at timestamptz,
        stay_seconds bigint,
        status text NOT NULL
          DEFAULT 'active'
          CHECK (
            status IN (
              'active',
              'left'
            )
          ),
        risk_score integer
          NOT NULL DEFAULT 0,
        risk_flags jsonb
          NOT NULL DEFAULT '[]'::jsonb,
        source text NOT NULL
          DEFAULT 'webhook',
        profile_snapshot jsonb
          NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz
          NOT NULL DEFAULT now(),
        updated_at timestamptz
          NOT NULL DEFAULT now()
      )
    `);

    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      lr_memberships_one_active_idx

      ON public.lr_channel_memberships (
        channel_id,
        user_hash
      )

      WHERE status='active'
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
      lr_memberships_period_idx

      ON public.lr_channel_memberships (
        channel_id,
        joined_at DESC,
        left_at DESC
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
      public.lr_audience_sync_state (
        channel_id text PRIMARY KEY,
        members_synced integer
          NOT NULL DEFAULT 0,
        last_started_at timestamptz,
        last_finished_at timestamptz,
        last_error text,
        updated_at timestamptz
          NOT NULL DEFAULT now()
      )
    `);
  await query(`
    ALTER TABLE
      public.lr_channel_member_profiles

    ADD COLUMN IF NOT EXISTS
      is_bot boolean
      NOT NULL DEFAULT false
  `);

  await query(`
    UPDATE
      public.lr_channel_member_profiles

    SET is_bot =
      CASE
        WHEN lower(
          COALESCE(
            raw->>'is_bot',
            raw->>'isBot',
            'false'
          )
        ) IN (
          'true',
          '1',
          'yes'
        )
        THEN true
        ELSE is_bot
      END
  `);

  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });

  return schemaPromise;
}

async function maxGet(
  pathname,
  params = {}
) {
  if (!token()) {
    throw new Error(
      'MAX bot token is not configured'
    );
  }

  const url = new URL(
    `${API_BASE}${pathname}`
  );

  for (
    const [key, value]
    of Object.entries(params)
  ) {
    if (
      value === undefined ||
      value === null ||
      value === ''
    ) {
      continue;
    }

    url.searchParams.set(
      key,
      String(value)
    );
  }

  const response = await fetch(
    url,
    {
      method: 'GET',
      headers: {
        Authorization: token(),
        Accept: 'application/json',
      },
      signal:
        AbortSignal.timeout(20_000),
    }
  );

  const body =
    await response
      .json()
      .catch(() => null);

  if (
    !response.ok ||
    body?.success === false
  ) {
    throw new Error(
      (
        `MAX API ${response.status}: ` +
        JSON.stringify(body || {})
      ).slice(0, 700)
    );
  }

  return body || {};
}

function normalizeMember(
  value = {},
  fallback = {}
) {
  const member = {
    ...fallback,
    ...value,
  };

  const userId = clean(
    member?.user_id ||
    member?.userId ||
    member?.id,
    120
  );

  if (!userId) {
    return null;
  }

  const joinedMs = unixMs(
    member?.join_time ||
    member?.joined_at
  );

  const activityMs = unixMs(
    member?.last_activity_time ||
    member?.last_access_time
  );

  return {
    userId,
    userHash: '',
    firstName: clean(
      member?.first_name ||
      member?.firstName,
      300
    ),
    lastName: clean(
      member?.last_name ||
      member?.lastName,
      300
    ),
    displayName:
      displayName(member),
    username: clean(
      member?.username,
      300
    ),
    avatarUrl: clean(
      member?.avatar_url ||
      member?.avatarUrl,
      2_000
    ),
    fullAvatarUrl: clean(
      member?.full_avatar_url ||
      member?.fullAvatarUrl,
      2_000
    ),
    joinTime:
      joinedMs
        ? new Date(joinedMs)
        : null,
    lastActivityTime:
      activityMs
        ? new Date(activityMs)
        : null,
    isBot:
      member?.is_bot === true ||
      member?.isBot === true,
    raw: member,
  };
}

async function fetchSingleMember(
  channelId,
  userId,
  fallback = {}
) {
  try {
    const body =
      await maxGet(
        `/chats/${
          encodeURIComponent(channelId)
        }/members`,
        {
          user_ids: userId,
        }
      );

    const members =
      Array.isArray(body?.members)
        ? body.members
        : [];

    const found =
      members.find(
        (item) =>
          clean(
            item?.user_id ||
            item?.id
          ) === String(userId)
      ) ||
      members[0];

    return normalizeMember(
      found || fallback,
      fallback
    );
  } catch {
    return normalizeMember(
      fallback,
      fallback
    );
  }
}

async function upsertProfile(
  channelId,
  member,
  isCurrent = true
) {
  const profile = {
    ...member,
    userHash:
      member.userHash ||
      memberHash(
        channelId,
        member.userId
      ),
  };

  await query(`
    INSERT INTO
    public.lr_channel_member_profiles (
      channel_id,
      max_user_id,
      user_hash,
      first_name,
      last_name,
      display_name,
      username,
      avatar_url,
      full_avatar_url,
      join_time,
      last_activity_time,
      is_current,
      first_seen_at,
      last_seen_at,
      raw
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,
      $10,$11,$12,
      now(),now(),$13::jsonb
    )

    ON CONFLICT (
      channel_id,
      max_user_id
    )
    DO UPDATE SET
      user_hash=EXCLUDED.user_hash,
      first_name=COALESCE(
        NULLIF(
          EXCLUDED.first_name,
          ''
        ),
        public.lr_channel_member_profiles
          .first_name
      ),
      last_name=COALESCE(
        NULLIF(
          EXCLUDED.last_name,
          ''
        ),
        public.lr_channel_member_profiles
          .last_name
      ),
      display_name=COALESCE(
        NULLIF(
          EXCLUDED.display_name,
          ''
        ),
        public.lr_channel_member_profiles
          .display_name
      ),
      username=COALESCE(
        NULLIF(
          EXCLUDED.username,
          ''
        ),
        public.lr_channel_member_profiles
          .username
      ),
      avatar_url=COALESCE(
        NULLIF(
          EXCLUDED.avatar_url,
          ''
        ),
        public.lr_channel_member_profiles
          .avatar_url
      ),
      full_avatar_url=COALESCE(
        NULLIF(
          EXCLUDED.full_avatar_url,
          ''
        ),
        public.lr_channel_member_profiles
          .full_avatar_url
      ),
      join_time=COALESCE(
        EXCLUDED.join_time,
        public.lr_channel_member_profiles
          .join_time
      ),
      last_activity_time=COALESCE(
        EXCLUDED.last_activity_time,
        public.lr_channel_member_profiles
          .last_activity_time
      ),
      is_current=EXCLUDED.is_current,
      last_seen_at=now(),
      raw=
        public.lr_channel_member_profiles
          .raw ||
        EXCLUDED.raw
  `, [
    channelId,
    profile.userId,
    profile.userHash,
    profile.firstName,
    profile.lastName,
    profile.displayName,
    profile.username,
    profile.avatarUrl,
    profile.fullAvatarUrl,
    profile.joinTime,
    profile.lastActivityTime,
    Boolean(isCurrent),
    JSON.stringify(profile.raw || {}),
  ]);

  await query(`
    UPDATE
      public.lr_channel_member_profiles

    SET
      is_bot=$3,
      last_seen_at=now()

    WHERE channel_id=$1
      AND max_user_id=$2
  `, [
    String(channelId),
    String(profile.userId),
    Boolean(profile.isBot),
  ]);

  return profile;
}

async function ensureActiveMembership(
  channelId,
  profile,
  joinedAt,
  source
) {
  const joined =
    profile.joinTime ||
    joinedAt ||
    new Date();

  await query(`
    INSERT INTO
    public.lr_channel_memberships (
      channel_id,
      max_user_id,
      user_hash,
      joined_at,
      status,
      source,
      profile_snapshot
    )

    SELECT
      $1,$2,$3,$4,
      'active',$5,$6::jsonb

    WHERE NOT EXISTS (
      SELECT 1
      FROM public.lr_channel_memberships
      WHERE channel_id=$1
        AND user_hash=$3
        AND status='active'
    )
  `, [
    channelId,
    profile.userId,
    profile.userHash,
    joined,
    source,
    JSON.stringify(profile.raw || {}),
  ]);
}

async function closeMembership(
  channelId,
  profile,
  leftAt
) {
  const updated = rows(
    await query(`
      UPDATE
      public.lr_channel_memberships

      SET
        max_user_id=COALESCE(
          max_user_id,
          $2
        ),
        left_at=$4,
        stay_seconds=GREATEST(
          0,
          EXTRACT(
            EPOCH FROM (
              $4::timestamptz -
              joined_at
            )
          )::bigint
        ),
        status='left',
        profile_snapshot=
          profile_snapshot ||
          $5::jsonb,
        updated_at=now()

      WHERE id=(
        SELECT id
        FROM public.lr_channel_memberships
        WHERE channel_id=$1
          AND user_hash=$3
          AND status='active'
        ORDER BY joined_at DESC
        LIMIT 1
      )

      RETURNING *
    `, [
      channelId,
      profile.userId,
      profile.userHash,
      leftAt,
      JSON.stringify(profile.raw || {}),
    ])
  )[0];

  if (updated) {
    return updated;
  }

  const lastJoin = rows(
    await query(`
      SELECT occurred_at
      FROM public.lr_channel_member_events
      WHERE channel_id=$1
        AND event_type='joined'
        AND user_hash=$2
        AND occurred_at <= $3
      ORDER BY occurred_at DESC
      LIMIT 1
    `, [
      channelId,
      profile.userHash,
      leftAt,
    ])
  )[0];

  const joinedAt =
    lastJoin?.occurred_at ||
    profile.joinTime ||
    leftAt;

  const inserted = rows(
    await query(`
      INSERT INTO
      public.lr_channel_memberships (
        channel_id,
        max_user_id,
        user_hash,
        joined_at,
        left_at,
        stay_seconds,
        status,
        source,
        profile_snapshot
      )
      VALUES (
        $1,$2,$3,$4,$5,
        GREATEST(
          0,
          EXTRACT(
            EPOCH FROM (
              $5::timestamptz -
              $4::timestamptz
            )
          )::bigint
        ),
        'left',
        'webhook_recovered',
        $6::jsonb
      )
      RETURNING *
    `, [
      channelId,
      profile.userId,
      profile.userHash,
      joinedAt,
      leftAt,
      JSON.stringify(profile.raw || {}),
    ])
  )[0];

  return inserted || null;
}

function calculateRisk({
  eventType,
  staySeconds,
  username,
  avatarUrl,
  repeatCount,
  burstCount,
}) {
  let score = 0;
  const flags = [];

  if (eventType === 'left') {
    if (
      Number.isFinite(staySeconds) &&
      staySeconds < 5 * 60
    ) {
      score += 70;
      flags.push(
        'left_under_5_minutes'
      );
    } else if (
      Number.isFinite(staySeconds) &&
      staySeconds < 60 * 60
    ) {
      score += 45;
      flags.push(
        'left_under_1_hour'
      );
    } else if (
      Number.isFinite(staySeconds) &&
      staySeconds < 24 * 60 * 60
    ) {
      score += 20;
      flags.push(
        'left_under_24_hours'
      );
    }
  }

  if (!username) {
    score += 8;
    flags.push('no_username');
  }
  /* Аватар не является признаком накрутки. */

  if (repeatCount >= 3) {
    score += 25;
    flags.push(
      'repeated_join_leave'
    );
  }

  if (burstCount >= 20) {
    score += 35;
    flags.push(
      'mass_join_wave'
    );
  } else if (burstCount >= 10) {
    score += 18;
    flags.push(
      'join_wave'
    );
  }

  return {
    score:
      Math.min(100, score),
    flags:
      [...new Set(flags)],
  };
}

async function attachIdentityToEvent(
  channelId,
  eventType,
  profile,
  occurredAt,
  membership
) {
  const values = [
    channelId,
    eventType,
    occurredAt,
    profile.userHash,
    profile.userId,
    profile.firstName,
    profile.lastName,
    profile.displayName,
    profile.username,
    profile.avatarUrl,
    profile.fullAvatarUrl,
    eventType === 'joined'
      ? membership?.joined_at ||
        occurredAt
      : membership?.joined_at ||
        profile.joinTime ||
        null,
    eventType === 'left'
      ? membership?.left_at ||
        occurredAt
      : null,
    membership?.stay_seconds ?? null,
  ];

  let event = rows(
    await query(`
      UPDATE
      public.lr_channel_member_events

      SET
        max_user_id=$5,
        first_name=$6,
        last_name=$7,
        display_name=$8,
        username=$9,
        avatar_url=$10,
        full_avatar_url=$11,
        joined_at=$12,
        left_at=$13,
        stay_seconds=$14,
        raw=
          raw ||
          jsonb_build_object(
            'audience_identity',
            true
          )

      WHERE id=(
        SELECT id
        FROM public.lr_channel_member_events
        WHERE channel_id=$1
          AND event_type=$2
          AND user_hash=$4
          AND occurred_at BETWEEN
            $3::timestamptz -
              interval '5 minutes'
            AND
            $3::timestamptz +
              interval '5 minutes'
        ORDER BY
          ABS(
            EXTRACT(
              EPOCH FROM (
                occurred_at -
                $3::timestamptz
              )
            )
          )
        LIMIT 1
      )

      RETURNING *
    `, values)
  )[0];

  if (!event) {
    const eventKey = sha([
      'audience',
      channelId,
      eventType,
      profile.userHash,
      new Date(occurredAt)
        .toISOString(),
    ].join(':'));

    event = rows(
      await query(`
        INSERT INTO
        public.lr_channel_member_events (
          event_key,
          channel_id,
          event_type,
          user_hash,
          source,
          occurred_at,
          raw,
          max_user_id,
          first_name,
          last_name,
          display_name,
          username,
          avatar_url,
          full_avatar_url,
          joined_at,
          left_at,
          stay_seconds
        )
        VALUES (
          $1,$2,$3,$4,
          'audience_webhook',
          $5,
          $6::jsonb,
          $7,$8,$9,$10,$11,$12,$13,
          $14,$15,$16
        )
        ON CONFLICT (event_key)
        DO UPDATE SET
          max_user_id=EXCLUDED.max_user_id,
          first_name=EXCLUDED.first_name,
          last_name=EXCLUDED.last_name,
          display_name=EXCLUDED.display_name,
          username=EXCLUDED.username,
          avatar_url=EXCLUDED.avatar_url,
          full_avatar_url=
            EXCLUDED.full_avatar_url,
          joined_at=EXCLUDED.joined_at,
          left_at=EXCLUDED.left_at,
          stay_seconds=
            EXCLUDED.stay_seconds
        RETURNING *
      `, [
        eventKey,
        channelId,
        eventType,
        profile.userHash,
        occurredAt,
        JSON.stringify({
          audience_identity: true,
          user: profile.raw || {},
        }),
        profile.userId,
        profile.firstName,
        profile.lastName,
        profile.displayName,
        profile.username,
        profile.avatarUrl,
        profile.fullAvatarUrl,
        eventType === 'joined'
          ? membership?.joined_at ||
            occurredAt
          : membership?.joined_at ||
            profile.joinTime ||
            null,
        eventType === 'left'
          ? membership?.left_at ||
            occurredAt
          : null,
        membership?.stay_seconds ?? null,
      ])
    )[0];
  }

  return event;
}

async function updateRisk(
  channelId,
  event,
  profile,
  membership
) {
  if (!event) {
    return;
  }

  const repeat = rows(
    await query(`
      SELECT COUNT(*)::integer AS count
      FROM public.lr_channel_member_events
      WHERE channel_id=$1
        AND user_hash=$2
        AND occurred_at >=
          now() - interval '7 days'
    `, [
      channelId,
      profile.userHash,
    ])
  )[0];

  const burst = rows(
    await query(`
      SELECT COUNT(*)::integer AS count
      FROM public.lr_channel_member_events
      WHERE channel_id=$1
        AND event_type='joined'
        AND occurred_at BETWEEN
          $2::timestamptz -
            interval '60 seconds'
          AND
          $2::timestamptz +
            interval '60 seconds'
    `, [
      channelId,
      event.occurred_at,
    ])
  )[0];

  const risk = calculateRisk({
    eventType:
      String(event.event_type),
    staySeconds:
      Number(
        membership?.stay_seconds ??
        event?.stay_seconds
      ),
    username:
      profile.username,
    avatarUrl:
      profile.avatarUrl ||
      profile.fullAvatarUrl,
    repeatCount:
      int(repeat?.count),
    burstCount:
      int(burst?.count),
  });

  await query(`
    UPDATE
    public.lr_channel_member_events

    SET
      risk_score=$2,
      risk_flags=$3::jsonb

    WHERE id=$1
  `, [
    event.id,
    risk.score,
    JSON.stringify(risk.flags),
  ]);

  if (membership?.id) {
    await query(`
      UPDATE
      public.lr_channel_memberships

      SET
        risk_score=$2,
        risk_flags=$3::jsonb,
        updated_at=now()

      WHERE id=$1
    `, [
      membership.id,
      risk.score,
      JSON.stringify(risk.flags),
    ]);
  }
}

export async function captureAudienceIdentity({
  update = {},
  channelId,
  eventType,
  occurredAt,
} = {}) {
  await ensureSchema();

  const sourceUser =
    update?.user ||
    update?.body?.user ||
    update?.member ||
    {};

  const userId = clean(
    sourceUser?.user_id ||
    sourceUser?.id ||
    update?.user_id,
    120
  );

  if (
    !channelId ||
    !userId ||
    sourceUser?.is_bot === true
  ) {
    return false;
  }

  const eventDate =
    occurredAt instanceof Date
      ? occurredAt
      : new Date(
          occurredAt ||
          Date.now()
        );

  const member =
    eventType === 'joined'
      ? await fetchSingleMember(
          String(channelId),
          userId,
          sourceUser
        )
      : normalizeMember(
          sourceUser,
          sourceUser
        );

  if (!member) {
    return false;
  }

  member.userHash =
    memberHash(
      String(channelId),
      member.userId
    );

  const profile =
    await upsertProfile(
      String(channelId),
      member,
      eventType === 'joined'
    );

  let membership = null;

  if (eventType === 'joined') {
    await ensureActiveMembership(
      String(channelId),
      profile,
      eventDate,
      'webhook'
    );

    membership = rows(
      await query(`
        SELECT *
        FROM public.lr_channel_memberships
        WHERE channel_id=$1
          AND user_hash=$2
          AND status='active'
        ORDER BY joined_at DESC
        LIMIT 1
      `, [
        String(channelId),
        profile.userHash,
      ])
    )[0] || null;
  } else {
    await query(`
      UPDATE
      public.lr_channel_member_profiles

      SET
        is_current=false,
        last_seen_at=now()

      WHERE channel_id=$1
        AND max_user_id=$2
    `, [
      String(channelId),
      profile.userId,
    ]);

    membership =
      await closeMembership(
        String(channelId),
        profile,
        eventDate
      );
  }

  const event =
    await attachIdentityToEvent(
      String(channelId),
      eventType,
      profile,
      eventDate,
      membership
    );

  await updateRisk(
    String(channelId),
    event,
    profile,
    membership
  );

  return true;
}

async function patchKnownEvents(
  channelId,
  profile
) {
  await query(`
    UPDATE
    public.lr_channel_member_events

    SET
      max_user_id=COALESCE(
        max_user_id,
        $3
      ),
      first_name=COALESCE(
        NULLIF(first_name, ''),
        $4
      ),
      last_name=COALESCE(
        NULLIF(last_name, ''),
        $5
      ),
      display_name=COALESCE(
        NULLIF(display_name, ''),
        $6
      ),
      username=COALESCE(
        NULLIF(username, ''),
        $7
      ),
      avatar_url=COALESCE(
        NULLIF(avatar_url, ''),
        $8
      ),
      full_avatar_url=COALESCE(
        NULLIF(full_avatar_url, ''),
        $9
      ),
      joined_at=COALESCE(
        joined_at,
        $10
      )

    WHERE channel_id=$1
      AND user_hash=$2
  `, [
    channelId,
    profile.userHash,
    profile.userId,
    profile.firstName,
    profile.lastName,
    profile.displayName,
    profile.username,
    profile.avatarUrl,
    profile.fullAvatarUrl,
    profile.joinTime,
  ]);
}


async function upsertMemberBatch(
  channelId,
  members
) {
  const profiles =
    members
      .map((member) => {
        const normalized =
          normalizeMember(member);

        if (!normalized) {
          return null;
        }

        normalized.userHash =
          memberHash(
            channelId,
            normalized.userId
          );

        return {
          max_user_id:
            normalized.userId,
          user_hash:
            normalized.userHash,
          first_name:
            normalized.firstName,
          last_name:
            normalized.lastName,
          display_name:
            normalized.displayName,
          username:
            normalized.username,
          avatar_url:
            normalized.avatarUrl,
          full_avatar_url:
            normalized.fullAvatarUrl,
          join_time:
            normalized.joinTime
              ? normalized.joinTime
                  .toISOString()
              : null,
          last_activity_time:
            normalized.lastActivityTime
              ? normalized
                  .lastActivityTime
                  .toISOString()
              : null,
          raw:
            normalized.raw || {},
        };
      })
      .filter(Boolean);

  if (!profiles.length) {
    return 0;
  }

  const json =
    JSON.stringify(profiles);

  await query(`
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset(
        $2::jsonb
      ) AS item (
        max_user_id text,
        user_hash text,
        first_name text,
        last_name text,
        display_name text,
        username text,
        avatar_url text,
        full_avatar_url text,
        join_time timestamptz,
        last_activity_time timestamptz,
        raw jsonb
      )
    )

    INSERT INTO
    public.lr_channel_member_profiles (
      channel_id,
      max_user_id,
      user_hash,
      first_name,
      last_name,
      display_name,
      username,
      avatar_url,
      full_avatar_url,
      join_time,
      last_activity_time,
      is_current,
      first_seen_at,
      last_seen_at,
      raw
    )

    SELECT
      $1,
      max_user_id,
      user_hash,
      first_name,
      last_name,
      COALESCE(
        NULLIF(
          display_name,
          ''
        ),
        'Пользователь MAX'
      ),
      username,
      avatar_url,
      full_avatar_url,
      join_time,
      last_activity_time,
      true,
      now(),
      now(),
      COALESCE(
        raw,
        '{}'::jsonb
      )

    FROM incoming

    ON CONFLICT (
      channel_id,
      max_user_id
    )
    DO UPDATE SET
      user_hash=EXCLUDED.user_hash,
      first_name=COALESCE(
        NULLIF(
          EXCLUDED.first_name,
          ''
        ),
        public.lr_channel_member_profiles
          .first_name
      ),
      last_name=COALESCE(
        NULLIF(
          EXCLUDED.last_name,
          ''
        ),
        public.lr_channel_member_profiles
          .last_name
      ),
      display_name=COALESCE(
        NULLIF(
          EXCLUDED.display_name,
          ''
        ),
        public.lr_channel_member_profiles
          .display_name
      ),
      username=COALESCE(
        NULLIF(
          EXCLUDED.username,
          ''
        ),
        public.lr_channel_member_profiles
          .username
      ),
      avatar_url=COALESCE(
        NULLIF(
          EXCLUDED.avatar_url,
          ''
        ),
        public.lr_channel_member_profiles
          .avatar_url
      ),
      full_avatar_url=COALESCE(
        NULLIF(
          EXCLUDED.full_avatar_url,
          ''
        ),
        public.lr_channel_member_profiles
          .full_avatar_url
      ),
      join_time=COALESCE(
        EXCLUDED.join_time,
        public.lr_channel_member_profiles
          .join_time
      ),
      last_activity_time=COALESCE(
        EXCLUDED.last_activity_time,
        public.lr_channel_member_profiles
          .last_activity_time
      ),
      is_current=true,
      last_seen_at=now(),
      raw=
        public.lr_channel_member_profiles
          .raw ||
        EXCLUDED.raw
  `, [
    channelId,
    json,
  ]);

  await query(`
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset(
        $2::jsonb
      ) AS item (
        max_user_id text,
        user_hash text,
        join_time timestamptz,
        raw jsonb
      )
    )

    INSERT INTO
    public.lr_channel_memberships (
      channel_id,
      max_user_id,
      user_hash,
      joined_at,
      status,
      source,
      profile_snapshot
    )

    SELECT
      $1,
      incoming.max_user_id,
      incoming.user_hash,
      COALESCE(
        incoming.join_time,
        now()
      ),
      'active',
      'member_sync',
      COALESCE(
        incoming.raw,
        '{}'::jsonb
      )

    FROM incoming

    WHERE NOT EXISTS (
      SELECT 1
      FROM
        public.lr_channel_memberships active

      WHERE
        active.channel_id=$1
        AND active.user_hash=
          incoming.user_hash
        AND active.status='active'
    )

    ON CONFLICT DO NOTHING
  `, [
    channelId,
    json,
  ]);

  await query(`
    UPDATE
    public.lr_channel_member_events event

    SET
      max_user_id=COALESCE(
        event.max_user_id,
        profile.max_user_id
      ),
      first_name=COALESCE(
        NULLIF(
          event.first_name,
          ''
        ),
        profile.first_name
      ),
      last_name=COALESCE(
        NULLIF(
          event.last_name,
          ''
        ),
        profile.last_name
      ),
      display_name=COALESCE(
        NULLIF(
          event.display_name,
          ''
        ),
        profile.display_name
      ),
      username=COALESCE(
        NULLIF(
          event.username,
          ''
        ),
        profile.username
      ),
      avatar_url=COALESCE(
        NULLIF(
          event.avatar_url,
          ''
        ),
        profile.avatar_url
      ),
      full_avatar_url=COALESCE(
        NULLIF(
          event.full_avatar_url,
          ''
        ),
        profile.full_avatar_url
      ),
      joined_at=COALESCE(
        event.joined_at,
        profile.join_time
      )

    FROM
      public.lr_channel_member_profiles profile

    WHERE
      event.channel_id=$1
      AND profile.channel_id=$1
      AND event.user_hash=
        profile.user_hash
      AND event.max_user_id IS NULL
  `, [channelId]);

  return profiles.length;
}

export async function syncAudienceChannelMembers(
  channelId
) {
  await ensureSchema();

  const id =
    clean(channelId, 120);

  if (
    !id ||
    !/^-?\d+$/.test(id)
  ) {
    throw new Error(
      'Некорректный ID канала'
    );
  }

  await query(`
    INSERT INTO
    public.lr_audience_sync_state (
      channel_id,
      last_started_at,
      last_error,
      updated_at
    )
    VALUES (
      $1,
      now(),
      NULL,
      now()
    )
    ON CONFLICT (channel_id)
    DO UPDATE SET
      last_started_at=now(),
      last_error=NULL,
      updated_at=now()
  `, [id]);

  let marker = '';
  let total = 0;
  let pages = 0;

  try {
    while (
      pages < 2_000 &&
      total < MAX_SYNC_MEMBERS
    ) {
      const body =
        await maxGet(
          `/chats/${
            encodeURIComponent(id)
          }/members`,
          {
            count: 100,
            marker,
          }
        );

      const members =
        Array.isArray(body?.members)
          ? body.members
          : [];

      const remaining =
        Math.max(
          0,
          MAX_SYNC_MEMBERS -
          total
        );

      const pageMembers =
        members.slice(
          0,
          remaining
        );

      total +=
        await upsertMemberBatch(
          id,
          pageMembers
        );

      const nextMarker =
        clean(body?.marker, 300);

      pages += 1;

      if (
        !nextMarker ||
        nextMarker === marker ||
        !members.length
      ) {
        break;
      }

      marker = nextMarker;
    }

    await query(`
      INSERT INTO
      public.lr_audience_sync_state (
        channel_id,
        members_synced,
        last_started_at,
        last_finished_at,
        last_error,
        updated_at
      )
      VALUES (
        $1,$2,now(),now(),NULL,now()
      )
      ON CONFLICT (channel_id)
      DO UPDATE SET
        members_synced=$2,
        last_finished_at=now(),
        last_error=NULL,
        updated_at=now()
    `, [
      id,
      total,
    ]);

    return {
      channelId: id,
      membersSynced: total,
      pages,
    };
  } catch (error) {
    await query(`
      INSERT INTO
      public.lr_audience_sync_state (
        channel_id,
        last_started_at,
        last_error,
        updated_at
      )
      VALUES (
        $1,
        now(),
        $2,
        now()
      )
      ON CONFLICT (channel_id)
      DO UPDATE SET
        last_error=$2,
        updated_at=now()
    `, [
      id,
      clean(
        error?.message || error,
        1_000
      ),
    ]);

    throw error;
  }
}

async function ownerChannels(
  ownerChatId
) {
  await ensureSchema();

  return rows(
    await query(`
      SELECT
        c.id AS db_channel_id,
        c.max_chat_id::text
          AS channel_id,
        c.title,
        c.link,
        d.updated_at
          AS analytics_enabled_at,
        s.last_finished_at
          AS audience_last_sync_at,
        s.members_synced

      FROM
        public.lr_channel_analytics_daily_channels d

      JOIN
        public.channels c
        ON c.id=d.channel_id

      LEFT JOIN
        public.lr_audience_sync_state s
        ON s.channel_id=
          c.max_chat_id::text

      WHERE
        d.owner_chat_id=$1
        AND d.enabled=true
        AND c.is_active=true

      ORDER BY
        lower(
          COALESCE(
            c.title,
            ''
          )
        ),
        c.id
    `, [
      String(ownerChatId),
    ])
  );
}

async function ownerChannel(
  ownerChatId,
  dbChannelId
) {
  return (
    rows(
      await query(`
        SELECT
          c.id AS db_channel_id,
          c.max_chat_id::text
            AS channel_id,
          c.title,
          c.link,
          d.updated_at
            AS analytics_enabled_at,
          s.last_finished_at
            AS audience_last_sync_at,
          s.members_synced

        FROM
          public.lr_channel_analytics_daily_channels d

        JOIN
          public.channels c
          ON c.id=d.channel_id

        LEFT JOIN
          public.lr_audience_sync_state s
          ON s.channel_id=
            c.max_chat_id::text

        WHERE
          d.owner_chat_id=$1
          AND d.enabled=true
          AND c.is_active=true
          AND c.id=$2

        LIMIT 1
      `, [
        String(ownerChatId),
        Number(dbChannelId),
      ])
    )[0] ||
    null
  );
}

async function tokenChannel(
  access
) {
  return (
    rows(
      await query(`
        SELECT
          c.id AS db_channel_id,
          c.max_chat_id::text
            AS channel_id,
          c.title,
          c.link

        FROM
          public.lr_channel_analytics_daily_channels d

        JOIN
          public.channels c
          ON c.id=d.channel_id

        WHERE
          d.owner_chat_id=$1
          AND d.enabled=true
          AND c.is_active=true
          AND c.max_chat_id::text=$2

        LIMIT 1
      `, [
        access.ownerChatId,
        access.channelId,
      ])
    )[0] ||
    null
  );
}

async function audienceSummary(
  channelId,
  from,
  to
) {
  const result = rows(
    await query(`
      SELECT
        COUNT(*) FILTER (
          WHERE event_type='joined'
        )::integer AS joined_count,

        COUNT(*) FILTER (
          WHERE event_type='left'
        )::integer AS left_count,

        COUNT(*) FILTER (
          WHERE event_type='left'
            AND COALESCE(
              stay_seconds,
              999999999
            ) < 3600
        )::integer AS quick_left_count,

        COUNT(*) FILTER (
          WHERE risk_score >= 50
        )::integer AS suspicious_count,

        COUNT(*) FILTER (
          WHERE max_user_id IS NULL
        )::integer AS anonymous_count,

        COALESCE(
          AVG(stay_seconds)
            FILTER (
              WHERE event_type='left'
                AND stay_seconds
                  IS NOT NULL
            ),
          0
        )::bigint AS average_stay_seconds

      FROM
        public.lr_channel_member_events

      WHERE
        channel_id=$1
        AND occurred_at >= $2
        AND occurred_at < $3
    `, [
      String(channelId),
      from,
      to,
    ])
  )[0] || {};

  const snapshot = rows(
    await query(`
      SELECT subscribers
      FROM
        public.lr_channel_analytics_snapshots

      WHERE
        collection_source=
          'max_api_collector_v1'
        AND (
          raw #>> '{chat,chat_id}'=$1
          OR raw #>> '{chat,id}'=$1
          OR raw #>> '{chat,chat,id}'=$1
        )

      ORDER BY captured_at DESC
      LIMIT 1
    `, [
      String(channelId),
    ]).catch(() => [])
  )[0] || {};

  const joined =
    int(result.joined_count);

  const left =
    int(result.left_count);

  return {
    joined,
    left,
    net:
      joined - left,
    quickLeft:
      int(
        result.quick_left_count
      ),
    suspicious:
      int(
        result.suspicious_count
      ),
    anonymous:
      int(
        result.anonymous_count
      ),
    averageStaySeconds:
      int(
        result.average_stay_seconds
      ),
    subscribers:
      int(snapshot.subscribers),
  };
}

function getPayload(update) {
  return clean(
    update?.callback?.payload ||
    update?.callback?.body?.payload ||
    update?.callback?.button?.payload ||
    update?.payload,
    500
  );
}

function getCallbackId(update) {
  return clean(
    update?.callback?.callback_id ||
    update?.callback?.callbackId ||
    update?.callback?.id ||
    update?.message_callback?.callback_id,
    500
  );
}

function getChatId(update) {
  return clean(
    update?.message?.recipient?.chat_id ||
    update?.message?.chat_id ||
    update?.callback?.message
      ?.recipient?.chat_id ||
    update?.callback?.message
      ?.chat_id ||
    update?.callback?.chat_id ||
    update?.chat_id ||
    update?.user?.user_id ||
    update?.message?.sender?.user_id ||
    update?.callback?.user_id,
    120
  );
}

function short(value, limit = 34) {
  const text =
    clean(value, 500) ||
    'Канал MAX';

  return text.length > limit
    ? `${text.slice(0, limit - 1)}…`
    : text;
}

function formatNumber(value) {
  return int(value)
    .toLocaleString('ru-RU');
}

function signedNumber(value) {
  const number = int(value);

  return number > 0
    ? `+${formatNumber(number)}`
    : formatNumber(number);
}

function formatDate(value) {
  const date =
    value instanceof Date
      ? value
      : new Date(value);

  if (
    Number.isNaN(date.getTime())
  ) {
    return '—';
  }

  return date.toLocaleString(
    'ru-RU',
    {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }
  ).replace(',', '');
}

function formatDuration(seconds) {
  const total =
    Math.max(
      0,
      int(seconds)
    );

  const days =
    Math.floor(
      total / 86_400
    );

  const hours =
    Math.floor(
      (total % 86_400) /
      3_600
    );

  const minutes =
    Math.floor(
      (total % 3_600) /
      60
    );

  if (days > 0) {
    return `${days} д. ${hours} ч.`;
  }

  if (hours > 0) {
    return `${hours} ч. ${minutes} мин.`;
  }

  return `${minutes} мин.`;
}

async function respond(
  update,
  chatId,
  text,
  buttonRows
) {
  const attachments =
    inlineKeyboard(buttonRows);

  const callbackId =
    getCallbackId(update);

  if (callbackId) {
    try {
      await answerCallback({
        callbackId,
        text,
        format: 'html',
        attachments,
      });

      return;
    } catch (error) {
      console.error(
        '[LR_AUDIENCE_CALLBACK]',
        error?.message || error
      );
    }
  }

  await sendMaxMessage({
    chatId,
    text,
    format: 'html',
    attachments,
  });
}

async function showChannelList(
  update,
  ownerChatId
) {
  const channels =
    await ownerChannels(
      ownerChatId
    );

  const keyboard =
    channels.map((channel) => [
      callbackButton(
        `📢 ${short(channel.title)}`,
        `lr_audience:channel:${
          channel.db_channel_id
        }`
      ),
    ]);

  keyboard.push([
    callbackButton(
      '⬅️ В аналитику',
      'lrchan:menu'
    ),
  ]);

  const text = channels.length
    ? [
        '━━━━━━━━━━━━━━',
        '👥 Подписки и отписки',
        '',
        `Каналов подключено: ${
          channels.length
        }`,
        '',
        'Выберите канал, чтобы посмотреть события за последние 24 часа.',
        '',
        'Имена, время входа, длительность нахождения и оценка риска собираются автоматически.',
        '━━━━━━━━━━━━━━',
      ].join('\n')
    : [
        '━━━━━━━━━━━━━━',
        '👥 Подписки и отписки',
        '',
        'Нет каналов с включённым сбором статистики.',
        '',
        'Включите канал в разделе «Ежедневный отчёт ПДП».',
        '━━━━━━━━━━━━━━',
      ].join('\n');

  await respond(
    update,
    ownerChatId,
    text,
    keyboard
  );
}

async function audienceProfileBreakdown(
  channelId,
  subscribers = 0
) {
  const item =
    rows(
      await query(`
        SELECT
          COUNT(*) FILTER (
            WHERE is_current=true
          )::bigint AS profile_count,

          COUNT(*) FILTER (
            WHERE
              is_current=true
              AND is_bot=false
          )::bigint AS human_profiles,

          COUNT(*) FILTER (
            WHERE
              is_current=true
              AND is_bot=true
          )::bigint AS bot_profiles

        FROM
          public.lr_channel_member_profiles

        WHERE channel_id=$1
      `, [
        String(channelId),
      ]).catch(() => [])
    )[0] || {};

  const profileCount =
    int(item.profile_count);

  const humanProfiles =
    int(item.human_profiles);

  const botProfiles =
    int(item.bot_profiles);

  return {
    profileCount,
    humanProfiles,
    botProfiles,
    unavailableProfiles:
      Math.max(
        0,
        int(subscribers) -
        profileCount
      ),
  };
}

async function showChannelSummary(
  update,
  ownerChatId,
  dbChannelId,
  notice = ''
) {
  const channel =
    await ownerChannel(
      ownerChatId,
      dbChannelId
    );

  if (!channel) {
    await respond(
      update,
      ownerChatId,
      '⚠️ Канал не найден или сбор статистики для него отключён.',
      [[
        callbackButton(
          '⬅️ К каналам',
          'lr_audience:menu'
        ),
      ]]
    );

    return;
  }

  const to = new Date();
  const from =
    new Date(
      to.getTime() -
      24 * 60 * 60_000
    );

  const summary =
    await audienceSummary(
      channel.channel_id,
      from,
      to
    );

  const profileBreakdown =
    await audienceProfileBreakdown(
      channel.channel_id,
      summary.subscribers
    );

  const url =
    createAudienceReportLink(
      ownerChatId,
      channel.channel_id,
      {
        from,
        to,
        expiresDays: 14,
      }
    );

  void syncAudienceChannelMembers(
    channel.channel_id
  ).catch((error) => {
    console.error(
      '[LR_AUDIENCE_SYNC_ON_OPEN]',
      channel.channel_id,
      error?.message || error
    );
  });

  const lines = [
    '━━━━━━━━━━━━━━',
    '👥 Аудитория за последние 24 часа',
    '',
    `📢 ${channel.title || 'Канал MAX'}`,
    '',
    `👥 Всего подписчиков: ${
      formatNumber(
        summary.subscribers
      )
    }`,
    `📇 Получено профилей: ${formatNumber(
      profileBreakdown.profileCount
    )}`,
    `👤 Обычных аккаунтов: ${formatNumber(
      profileBreakdown.humanProfiles
    )}`,
    `🤖 Официальных ботов MAX: ${formatNumber(
      profileBreakdown.botProfiles
    )}`,
    `❔ Профиль недоступен: ${formatNumber(
      profileBreakdown.unavailableProfiles
    )}`,
    `➕ Подписались: ${
      formatNumber(
        summary.joined
      )
    }`,
    `➖ Отписались: ${
      formatNumber(
        summary.left
      )
    }`,
    `📈 Изменение: ${
      signedNumber(
        summary.net
      )
    }`,
    '',
    `⚡ Ушли менее чем за час: ${
      formatNumber(
        summary.quickLeft
      )
    }`,
    `🛡 Событий с высоким риском: ${
      formatNumber(
        summary.suspicious
      )
    }`,
    `⏱ Среднее время до отписки: ${
      formatDuration(
        summary.averageStaySeconds
      )
    }`,
    '',
    `🌐 <a href="${escapeHtml(url)}">Отчёт ПДП</a>`,
        '',
    `Период: ${
      formatDate(from)
    } — ${
      formatDate(to)
    } МСК`,
  ];

  if (notice) {
    lines.splice(
      2,
      0,
      notice,
      ''
    );
  }

  lines.push(
    '━━━━━━━━━━━━━━'
  );

  await respond(
    update,
    ownerChatId,
    lines.join('\n'),
    [
      [
        linkButton(
          '🌐 Открыть подробный отчёт',
          url
        ),
      ],
      [
        callbackButton(
          '🔄 Обновить',
          `lr_audience:refresh:${
            channel.db_channel_id
          }`
        ),
        callbackButton(
          '🔄 Синхронизировать',
          `lr_audience:sync:${
            channel.db_channel_id
          }`
        ),
      ],
      [
        callbackButton(
          '⬅️ К каналам',
          'lr_audience:menu'
        ),
      ],
    ]
  );
}

async function handleAudienceCallback(
  update
) {
  const payload =
    getPayload(update);

  if (
    !payload.startsWith(
      'lr_audience:'
    )
  ) {
    return false;
  }

  const ownerChatId =
    getChatId(update);

  if (!ownerChatId) {
    return false;
  }

  if (
    payload ===
    'lr_audience:menu'
  ) {
    await showChannelList(
      update,
      ownerChatId
    );

    return true;
  }

  const [
    ,
    action,
    idText,
  ] = payload.split(':');

  const dbChannelId =
    Number(idText);

  if (
    !Number.isFinite(
      dbChannelId
    )
  ) {
    return false;
  }

  if (
    action === 'channel' ||
    action === 'refresh'
  ) {
    await showChannelSummary(
      update,
      ownerChatId,
      dbChannelId
    );

    return true;
  }

  if (action === 'sync') {
    const channel =
      await ownerChannel(
        ownerChatId,
        dbChannelId
      );

    if (!channel) {
      await showChannelList(
        update,
        ownerChatId
      );

      return true;
    }

    try {
      const result =
        await syncAudienceChannelMembers(
          channel.channel_id
        );

      await showChannelSummary(
        update,
        ownerChatId,
        dbChannelId,
        `✅ Синхронизировано профилей: ${
          formatNumber(
            result.membersSynced
          )
        }`
      );
    } catch (error) {
      await showChannelSummary(
        update,
        ownerChatId,
        dbChannelId,
        `⚠️ Синхронизация не завершена: ${
          clean(
            error?.message || error,
            300
          )
        }`
      );
    }

    return true;
  }

  return false;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function renderReportPage({
  channel,
  access,
  reportToken,
}) {
  const initial = {
    token: reportToken,
    channel: {
      id: channel.channel_id,
      title:
        channel.title ||
        'Канал MAX',
      link:
        channel.link || '',
    },
    period: {
      from:
        access.from.toISOString(),
      to:
        access.to.toISOString(),
    },
  };

  const title =
    escapeHtml(
      channel.title ||
      'Канал MAX'
    );

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1,viewport-fit=cover"
  >
  <meta
    name="robots"
    content="noindex,nofollow,noarchive"
  >
  <meta
    name="theme-color"
    content="#07101d"
  >
  <link
    rel="icon"
    type="image/png"
    href="/brand/favicon.png?v=20260715b"
  >
  <link
    rel="apple-touch-icon"
    href="/brand/apple-touch-icon.png?v=20260715b"
  >
  <title>${title} — Отчёт ПДП LinkRay</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07101d;
      --panel: rgba(15, 28, 47, .92);
      --panel-soft: rgba(25, 42, 67, .78);
      --line: rgba(156, 214, 255, .16);
      --text: #f4f8ff;
      --muted: #9cb0c9;
      --accent: #75e4b3;
      --accent-2: #72b9ff;
      --danger: #ff7d91;
      --warning: #ffd37d;
      --shadow: 0 18px 55px rgba(0, 0, 0, .28);
    }

    * {
      box-sizing: border-box;
    }

    html {
      min-height: 100%;
      background:
        radial-gradient(
          circle at 90% 0,
          rgba(67, 213, 159, .18),
          transparent 38%
        ),
        radial-gradient(
          circle at 0 20%,
          rgba(55, 121, 224, .22),
          transparent 40%
        ),
        var(--bg);
    }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background: transparent;
      font-family:
        Inter,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    button,
    input {
      font: inherit;
    }

    .shell {
      width: min(1180px, 100%);
      margin: 0 auto;
      padding:
        max(18px, env(safe-area-inset-top))
        16px
        max(34px, env(safe-area-inset-bottom));
    }

    .hero,
    .toolbar,
    .events-panel {
      border: 1px solid var(--line);
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }

    .hero {
      border-radius: 28px;
      padding: 22px;
    }

    .brand-row {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-logo {
      width: 58px;
      height: 58px;
      border-radius: 18px;
      object-fit: cover;
      box-shadow:
        0 10px 28px
        rgba(59, 207, 153, .22);
    }

    .eyebrow {
      color: var(--accent);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: .09em;
      text-transform: uppercase;
    }

    h1 {
      margin: 5px 0 0;
      font-size: clamp(22px, 5vw, 36px);
      line-height: 1.12;
    }

    .period {
      margin-top: 10px;
      color: var(--muted);
      line-height: 1.55;
    }

    .metrics {
      display: grid;
      grid-template-columns:
        repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 20px;
    }

    .metric {
      min-height: 105px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: var(--panel-soft);
    }

    .metric-label {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
    }

    .metric-value {
      margin-top: 7px;
      font-size: clamp(24px, 4.8vw, 34px);
      font-weight: 850;
      letter-spacing: -.03em;
    }

    .metric-value.positive {
      color: var(--accent);
    }

    .metric-value.negative {
      color: var(--danger);
    }

    .metric-value.warning {
      color: var(--warning);
    }

    .toolbar {
      margin-top: 16px;
      border-radius: 24px;
      padding: 14px;
    }

    .tabs {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: none;
    }

    .tabs::-webkit-scrollbar {
      display: none;
    }

    .tab {
      flex: 0 0 auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px 14px;
      color: var(--muted);
      background: rgba(255, 255, 255, .035);
      cursor: pointer;
      font-weight: 750;
    }

    .tab.active {
      color: #06131f;
      background: var(--accent);
      border-color: transparent;
    }

    .search-row {
      display: flex;
      gap: 10px;
      margin-top: 12px;
    }

    .search-row input {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 15px;
      padding: 12px 14px;
      color: var(--text);
      background: rgba(0, 0, 0, .18);
      outline: none;
    }

    .search-row input:focus {
      border-color: rgba(117, 228, 179, .6);
      box-shadow:
        0 0 0 3px
        rgba(117, 228, 179, .11);
    }

    .search-row button,
    .pager button {
      border: 0;
      border-radius: 15px;
      padding: 11px 16px;
      color: #06131f;
      background: var(--accent-2);
      cursor: pointer;
      font-weight: 800;
    }

    .events-panel {
      margin-top: 16px;
      border-radius: 24px;
      padding: 16px;
    }

    .events-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .events-title {
      font-size: 18px;
      font-weight: 850;
    }

    .events-count {
      color: var(--muted);
      font-size: 14px;
    }

    .events {
      display: grid;
      gap: 10px;
    }

    .event {
      display: grid;
      grid-template-columns: 50px minmax(0, 1fr);
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(255, 255, 255, .028);
    }

    .avatar {
      width: 50px;
      height: 50px;
      border-radius: 16px;
      object-fit: cover;
      background:
        linear-gradient(
          135deg,
          rgba(114, 185, 255, .35),
          rgba(117, 228, 179, .35)
        );
    }

    .avatar-fallback {
      display: grid;
      place-items: center;
      font-size: 22px;
      font-weight: 850;
    }

    .event-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .person-name {
      min-width: 0;
      overflow: hidden;
      color: var(--text);
      font-weight: 850;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: default;
      text-decoration: none;
      pointer-events: none;
    }

    .event-kind,
    .badge {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 12px;
      font-weight: 850;
    }

    .event-kind.joined {
      color: var(--accent);
      background: rgba(117, 228, 179, .11);
    }

    .event-kind.left {
      color: var(--danger);
      background: rgba(255, 125, 145, .11);
    }

    .meta,
    .details {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }

    .meta {
      margin-top: 4px;
    }

    .details {
      display: flex;
      flex-wrap: wrap;
      gap: 5px 14px;
      margin-top: 8px;
    }

    .badge.bot {
      color: #a8d8ff;
      background: rgba(114, 185, 255, .12);
    }

    .badge.risk {
      color: var(--warning);
      background: rgba(255, 211, 125, .12);
    }

    .empty,
    .error,
    .loading {
      padding: 36px 12px;
      color: var(--muted);
      text-align: center;
      line-height: 1.6;
    }

    .error {
      color: var(--danger);
    }

    .pager {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-top: 16px;
    }

    .pager button:disabled {
      opacity: .35;
      cursor: default;
    }

    .page-number {
      color: var(--muted);
      font-size: 14px;
    }

    .privacy {
      margin: 16px 3px 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
      text-align: center;
    }

    @media (max-width: 860px) {
      .metrics {
        grid-template-columns:
          repeat(2, minmax(0, 1fr));
      }
    }

    @media (max-width: 540px) {
      .shell {
        padding-left: 10px;
        padding-right: 10px;
      }

      .hero {
        padding: 17px;
        border-radius: 22px;
      }

      .metrics {
        gap: 8px;
      }

      .metric {
        min-height: 94px;
        padding: 13px;
        border-radius: 17px;
      }

      .search-row {
        flex-direction: column;
      }

      .search-row button {
        width: 100%;
      }

      .event {
        grid-template-columns: 44px minmax(0, 1fr);
        padding: 12px;
      }

      .avatar {
        width: 44px;
        height: 44px;
        border-radius: 14px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="brand-row">
        <img
          class="brand-logo"
          src="/brand/favicon.png?v=20260715b"
          alt="LinkRay"
        >
        <div>
          <div class="eyebrow">
            LinkRay · Отчёт ПДП
          </div>
          <h1 id="channel-title">
            ${title}
          </h1>
        </div>
      </div>

      <div
        class="period"
        id="period"
      ></div>

      <div
        class="metrics"
        id="metrics"
      >
        <div class="loading">
          Загружаем показатели…
        </div>
      </div>
    </section>

    <section class="toolbar">
      <div
        class="tabs"
        id="tabs"
      >
        <button
          class="tab active"
          data-tab="all"
        >
          Все
        </button>
        <button
          class="tab"
          data-tab="joined"
        >
          Подписались
        </button>
        <button
          class="tab"
          data-tab="left"
        >
          Отписались
        </button>
        <button
          class="tab"
          data-tab="risk"
        >
          Аномалии
        </button>
      </div>

      <form
        class="search-row"
        id="search-form"
      >
        <input
          id="search"
          type="search"
          autocomplete="off"
          placeholder="Имя, username или MAX ID"
        >
        <button type="submit">
          Найти
        </button>
      </form>
    </section>

    <section class="events-panel">
      <div class="events-head">
        <div class="events-title">
          События аудитории
        </div>
        <div
          class="events-count"
          id="events-count"
        ></div>
      </div>

      <div
        class="events"
        id="events"
      >
        <div class="loading">
          Загружаем список…
        </div>
      </div>

      <div
        class="pager"
        id="pager"
      ></div>
    </section>

    <div class="privacy">
      Приватный отчёт. Ссылка имеет ограниченный срок действия
      и не индексируется поисковыми системами.
    </div>
  </main>

  <script>
    const INITIAL = ${safeJson(initial)};

    const state = {
      tab: 'all',
      page: 1,
      limit: 50,
      search: '',
      loading: false,
    };

    const byId = (id) =>
      document.getElementById(id);

    const h = (value) =>
      String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const number = (value) =>
      new Intl.NumberFormat('ru-RU')
        .format(Number(value || 0));

    const dateTime = (value) => {
      if (!value) {
        return '—';
      }

      const date =
        new Date(value);

      if (
        Number.isNaN(
          date.getTime()
        )
      ) {
        return '—';
      }

      return new Intl.DateTimeFormat(
        'ru-RU',
        {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }
      ).format(date);
    };

    const duration = (seconds) => {
      const value =
        Math.max(
          0,
          Number(seconds || 0)
        );

      if (value < 60) {
        return Math.round(value) + ' сек.';
      }

      if (value < 3600) {
        return Math.floor(value / 60) + ' мин.';
      }

      if (value < 86400) {
        const hours =
          Math.floor(value / 3600);
        const minutes =
          Math.floor(
            (value % 3600) / 60
          );

        return (
          hours +
          ' ч. ' +
          minutes +
          ' мин.'
        );
      }

      const days =
        Math.floor(value / 86400);
      const hours =
        Math.floor(
          (value % 86400) / 3600
        );

      return (
        days +
        ' дн. ' +
        hours +
        ' ч.'
      );
    };

    const metric = (
      label,
      value,
      className
    ) =>
      '<div class="metric">' +
        '<div class="metric-label">' +
          h(label) +
        '</div>' +
        '<div class="metric-value ' +
          h(className || '') +
        '">' +
          h(value) +
        '</div>' +
      '</div>';

    const renderMetrics = (summary) => {
      const net =
        Number(summary.net || 0);

      byId('metrics').innerHTML = [
        metric(
          'Всего подписчиков',
          number(summary.subscribers),
          ''
        ),
        metric(
          'Подписались за период',
          '+' + number(summary.joined),
          'positive'
        ),
        metric(
          'Отписались за период',
          '−' + number(summary.left),
          'negative'
        ),
        metric(
          'Чистое изменение',
          (net >= 0 ? '+' : '') +
            number(net),
          net >= 0
            ? 'positive'
            : 'negative'
        ),
        metric(
          'Получено профилей',
          number(summary.profileCount),
          ''
        ),
        metric(
          'Обычных аккаунтов',
          number(summary.humanProfiles),
          ''
        ),
        metric(
          'Официальных ботов MAX',
          number(summary.botProfiles),
          'warning'
        ),
        metric(
          'Профиль недоступен',
          number(summary.unavailableProfiles),
          summary.unavailableProfiles > 0
            ? 'warning'
            : ''
        ),
      ].join('');
    };

    const avatarHtml = (item) => {
      const url =
        item.avatar_url ||
        item.full_avatar_url ||
        '';

      if (url) {
        return (
          '<img class="avatar" ' +
          'src="' + h(url) + '" ' +
          'alt="" loading="lazy" ' +
          'referrerpolicy="no-referrer">'
        );
      }

      const name =
        String(
          item.display_name ||
          'П'
        ).trim();

      return (
        '<div class="avatar avatar-fallback">' +
          h(
            name.slice(0, 1).toUpperCase()
          ) +
        '</div>'
      );
    };

    const eventHtml = (item) => {
      const joined =
        item.event_type === 'joined';

      const kind =
        joined
          ? 'Подписался'
          : 'Отписался';

      const name =
        item.display_name ||
        'Пользователь MAX';

      const username =
        item.username
          ? '@' +
            String(item.username)
              .replace(/^@/, '')
          : '';

      const badges = [];

      if (item.is_bot) {
        badges.push(
          '<span class="badge bot">' +
          '🤖 Бот MAX' +
          '</span>'
        );
      }

      if (
        Number(item.risk_score || 0) >= 50
      ) {
        badges.push(
          '<span class="badge risk">' +
          '⚠️ Риск ' +
          h(item.risk_score) +
          '%' +
          '</span>'
        );
      }

      const details = [
        '<span>Событие: ' +
          h(dateTime(item.occurred_at)) +
        '</span>',
        '<span>Подписался: ' +
          h(dateTime(item.joined_at)) +
        '</span>',
      ];

      if (!joined) {
        details.push(
          '<span>Отписался: ' +
            h(dateTime(item.left_at)) +
          '</span>'
        );
      }

      details.push(
        '<span>В канале: ' +
          h(duration(item.stay_seconds)) +
        '</span>'
      );

      if (item.max_user_id) {
        details.push(
          '<span>MAX ID: ' +
            h(item.max_user_id) +
          '</span>'
        );
      }

      return (
        '<article class="event">' +
          avatarHtml(item) +
          '<div>' +
            '<div class="event-top">' +
              '<div style="min-width:0">' +
                '<div class="person-name">' +
                  h(name) +
                '</div>' +
                '<div class="meta">' +
                  h(username) +
                '</div>' +
              '</div>' +
              '<span class="event-kind ' +
                (joined ? 'joined' : 'left') +
              '">' +
                h(kind) +
              '</span>' +
            '</div>' +
            (
              badges.length
                ? '<div class="details">' +
                    badges.join('') +
                  '</div>'
                : ''
            ) +
            '<div class="details">' +
              details.join('') +
            '</div>' +
          '</div>' +
        '</article>'
      );
    };

    const renderPager = (
      page,
      total,
      limit
    ) => {
      const pages =
        Math.max(
          1,
          Math.ceil(total / limit)
        );

      byId('pager').innerHTML =
        '<button id="prev" ' +
          (page <= 1 ? 'disabled' : '') +
        '>Назад</button>' +
        '<span class="page-number">' +
          'Страница ' +
          number(page) +
          ' из ' +
          number(pages) +
        '</span>' +
        '<button id="next" ' +
          (page >= pages ? 'disabled' : '') +
        '>Далее</button>';

      const prev =
        byId('prev');

      const next =
        byId('next');

      prev.addEventListener(
        'click',
        () => {
          if (state.page > 1) {
            state.page -= 1;
            load();
          }
        }
      );

      next.addEventListener(
        'click',
        () => {
          if (state.page < pages) {
            state.page += 1;
            load();
          }
        }
      );
    };

    async function load() {
      if (state.loading) {
        return;
      }

      state.loading = true;

      byId('events').innerHTML =
        '<div class="loading">' +
          'Загружаем события…' +
        '</div>';

      try {
        const params =
          new URLSearchParams({
            tab: state.tab,
            page: String(state.page),
            limit: String(state.limit),
            search: state.search,
          });

        const response =
          await fetch(
            '/api/audience/' +
            encodeURIComponent(
              INITIAL.token
            ) +
            '?' +
            params.toString(),
            {
              headers: {
                Accept: 'application/json',
              },
              cache: 'no-store',
            }
          );

        const data =
          await response.json();

        if (
          !response.ok ||
          !data?.ok
        ) {
          throw new Error(
            data?.error ||
            'Не удалось загрузить данные'
          );
        }

        byId('channel-title').textContent =
          data.channel?.title ||
          INITIAL.channel.title;

        byId('period').textContent =
          'Период: ' +
          dateTime(data.period?.from) +
          ' — ' +
          dateTime(data.period?.to) +
          ' МСК';

        renderMetrics(
          data.summary || {}
        );

        const items =
          Array.isArray(data.items)
            ? data.items
            : [];

        byId('events-count').textContent =
          'Найдено: ' +
          number(data.total);

        byId('events').innerHTML =
          items.length
            ? items
                .map(eventHtml)
                .join('')
            : '<div class="empty">' +
                'За выбранный период событий нет.' +
              '</div>';

        renderPager(
          Number(data.page || 1),
          Number(data.total || 0),
          Number(data.limit || state.limit)
        );
      } catch (error) {
        byId('events').innerHTML =
          '<div class="error">' +
            'Не удалось загрузить отчёт.<br>' +
            h(
              error?.message ||
              String(error)
            ) +
          '</div>';

        byId('metrics').innerHTML =
          '<div class="error">' +
            'Показатели временно недоступны.' +
          '</div>';
      } finally {
        state.loading = false;
      }
    }

    byId('tabs')
      .addEventListener(
        'click',
        (event) => {
          const button =
            event.target.closest(
              '[data-tab]'
            );

          if (!button) {
            return;
          }

          document
            .querySelectorAll(
              '[data-tab]'
            )
            .forEach((item) =>
              item.classList.toggle(
                'active',
                item === button
              )
            );

          state.tab =
            button.dataset.tab;

          state.page = 1;
          load();
        }
      );

    byId('search-form')
      .addEventListener(
        'submit',
        (event) => {
          event.preventDefault();

          state.search =
            byId('search')
              .value
              .trim();

          state.page = 1;
          load();
        }
      );

    load();
  </script>
</body>
</html>`;
}


function tabCondition(tab) {
  if (tab === 'joined') {
    return `e.event_type='joined'`;
  }

  if (tab === 'left') {
    return `e.event_type='left'`;
  }

  if (tab === 'risk') {
    return `e.risk_score >= 50`;
  }

  return 'TRUE';
}

async function listAudienceEvents({
  channelId,
  from,
  to,
  tab,
  search,
  page,
  limit,
}) {
  const condition =
    tabCondition(tab);

  const searchValue =
    clean(search, 300);

  const offset =
    (page - 1) * limit;

  const params = [
    String(channelId),
    from,
    to,
    searchValue,
    limit,
    offset,
  ];

  const baseWhere = `
    e.channel_id=$1
    AND e.occurred_at >= $2
    AND e.occurred_at < $3
    AND ${condition}
    AND (
      $4=''
      OR COALESCE(
        e.display_name,
        p.display_name,
        ''
      ) ILIKE '%' || $4 || '%'
      OR COALESCE(
        e.username,
        p.username,
        ''
      ) ILIKE '%' || $4 || '%'
      OR COALESCE(
        e.max_user_id,
        p.max_user_id,
        ''
      ) ILIKE '%' || $4 || '%'
    )
  `;

  const total = int(
    rows(
      await query(`
        SELECT COUNT(*)::bigint AS count

        FROM
          public.lr_channel_member_events e

        LEFT JOIN
          public.lr_channel_member_profiles p
          ON p.channel_id=e.channel_id
          AND (
            p.max_user_id=
              e.max_user_id
            OR (
              e.max_user_id IS NULL
              AND p.user_hash=
                e.user_hash
            )
          )

        WHERE ${baseWhere}
      `, params.slice(0, 4))
    )[0]?.count
  );

  const items = rows(
    await query(`
      SELECT
        e.id,
        e.event_type,
        e.occurred_at,
        COALESCE(
          e.max_user_id,
          p.max_user_id
        ) AS max_user_id,
        COALESCE(
          NULLIF(
            e.display_name,
            ''
          ),
          NULLIF(
            p.display_name,
            ''
          ),
          'Пользователь MAX'
        ) AS display_name,
        COALESCE(
          NULLIF(
            e.username,
            ''
          ),
          p.username
        ) AS username,
        COALESCE(
          NULLIF(
            e.avatar_url,
            ''
          ),
          p.avatar_url
        ) AS avatar_url,
        COALESCE(
          NULLIF(
            e.full_avatar_url,
            ''
          ),
          p.full_avatar_url
        ) AS full_avatar_url,
      COALESCE(
        p.is_bot,
        false
      ) AS is_bot,
        COALESCE(
          e.joined_at,
          membership.joined_at,
          p.join_time,
          CASE
            WHEN e.event_type='joined'
            THEN e.occurred_at
            ELSE NULL
          END
        ) AS joined_at,
        COALESCE(
          e.left_at,
          membership.left_at,
          CASE
            WHEN e.event_type='left'
            THEN e.occurred_at
            ELSE NULL
          END
        ) AS left_at,
        COALESCE(
          e.stay_seconds,
          membership.stay_seconds,
          CASE
            WHEN e.event_type='joined'
            THEN GREATEST(
              0,
              EXTRACT(
                EPOCH FROM (
                  LEAST(
                    now(),
                    $3::timestamptz
                  ) -
                  COALESCE(
                    e.joined_at,
                    p.join_time,
                    e.occurred_at
                  )
                )
              )::bigint
            )
            ELSE NULL
          END
        ) AS stay_seconds,
        e.risk_score,
        e.risk_flags

      FROM
        public.lr_channel_member_events e

      LEFT JOIN
        public.lr_channel_member_profiles p
        ON p.channel_id=e.channel_id
        AND (
          p.max_user_id=
            e.max_user_id
          OR (
            e.max_user_id IS NULL
            AND p.user_hash=
              e.user_hash
          )
        )

      LEFT JOIN LATERAL (
        SELECT
          m.joined_at,
          m.left_at,
          m.stay_seconds

        FROM
          public.lr_channel_memberships m

        WHERE
          m.channel_id=e.channel_id
          AND m.user_hash=e.user_hash
          AND m.joined_at <=
            e.occurred_at +
            interval '5 minutes'

        ORDER BY
          ABS(
            EXTRACT(
              EPOCH FROM (
                e.occurred_at -
                CASE
                  WHEN e.event_type='left'
                  THEN COALESCE(
                    m.left_at,
                    m.joined_at
                  )
                  ELSE m.joined_at
                END
              )
            )
          )

        LIMIT 1
      ) membership
      ON TRUE

      WHERE ${baseWhere}

      ORDER BY
        e.occurred_at DESC,
        e.id DESC

      LIMIT $5
      OFFSET $6
    `, params)
  ).map((item) => ({
    ...item,
    profile_url: '',
    risk_score:
      int(item.risk_score),
    stay_seconds:
      item.stay_seconds === null ||
      item.stay_seconds === undefined
        ? null
        : int(item.stay_seconds),
  }));

  return {
    total,
    items,
  };
}

async function handleReportPage(
  req,
  res
) {
  await ensureSchema();

  const reportToken =
    clean(req.params.token, 10_000);

  const access =
    parseReportToken(reportToken);

  if (!access) {
    res
      .status(403)
      .type('html')
      .send(
        '<h1>Ссылка недействительна или устарела</h1>'
      );

    return;
  }

  const channel =
    await tokenChannel(access);

  if (!channel) {
    res
      .status(403)
      .type('html')
      .send(
        '<h1>Доступ к каналу отключён</h1>'
      );

    return;
  }

  res.set({
    'Cache-Control':
      'private, no-store, max-age=0',
    Pragma:
      'no-cache',
    'X-Robots-Tag':
      'noindex, nofollow, noarchive',
    'Referrer-Policy':
      'no-referrer',
    'X-Content-Type-Options':
      'nosniff',
    'Content-Security-Policy':
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' https: data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
  });

  res
    .type('html')
    .send(
      renderReportPage({
        channel,
        access,
        reportToken,
      })
    );
}

async function handleReportApi(
  req,
  res
) {
  await ensureSchema();

  const access =
    parseReportToken(
      req.params.token
    );

  if (!access) {
    res
      .status(403)
      .json({
        ok: false,
        error:
          'invalid_or_expired_link',
      });

    return;
  }

  const channel =
    await tokenChannel(access);

  if (!channel) {
    res
      .status(403)
      .json({
        ok: false,
        error:
          'channel_access_disabled',
      });

    return;
  }

  const tab =
    ['all', 'joined', 'left', 'risk']
      .includes(
        String(req.query.tab)
      )
      ? String(req.query.tab)
      : 'all';

  const page =
    Math.max(
      1,
      int(req.query.page, 1)
    );

  const limit =
    Math.min(
      100,
      Math.max(
        10,
        int(req.query.limit, 50)
      )
    );

  const data =
    await listAudienceEvents({
      channelId:
        channel.channel_id,
      from:
        access.from,
      to:
        access.to,
      tab,
      search:
        req.query.search,
      page,
      limit,
    });

  const summary =
    await audienceSummary(
      channel.channel_id,
      access.from,
      access.to
    );

  const profileBreakdown =
    await audienceProfileBreakdown(
      channel.channel_id,
      summary.subscribers
    );

  res.set({
    'Cache-Control':
      'private, no-store, max-age=0',
    'X-Robots-Tag':
      'noindex, nofollow, noarchive',
  });

  res.json({
    ok: true,
    channel: {
      id:
        channel.channel_id,
      title:
        channel.title ||
        'Канал MAX',
      link:
        channel.link || '',
    },
    period: {
      from:
        access.from.toISOString(),
      to:
        access.to.toISOString(),
    },
    summary: {
      ...summary,
      ...profileBreakdown,
    },
    page,
    limit,
    total:
      data.total,
    items:
      data.items,
  });
}

async function syncAllEnabledChannels() {
  const channelRows = rows(
    await query(`
      SELECT DISTINCT
        c.max_chat_id::text
          AS channel_id

      FROM
        public.lr_channel_analytics_daily_channels d

      JOIN
        public.channels c
        ON c.id=d.channel_id

      WHERE
        d.enabled=true
        AND c.is_active=true
        AND c.max_chat_id IS NOT NULL
    `).catch(() => [])
  );

  for (const channel of channelRows) {
    try {
      await syncAudienceChannelMembers(
        channel.channel_id
      );
    } catch (error) {
      console.error(
        '[LR_AUDIENCE_PERIODIC_SYNC]',
        channel.channel_id,
        error?.message || error
      );
    }

    await new Promise(
      (resolve) =>
        setTimeout(resolve, 250)
    );
  }
}

function middlewareStack(app) {
  return (
    app?._router?.stack ||
    app?.router?.stack ||
    []
  );
}

function moveBeforeWebhook(
  app,
  layer
) {
  const stack =
    middlewareStack(app);

  if (
    !stack.length ||
    !layer
  ) {
    return;
  }

  const ownIndex =
    stack.indexOf(layer);

  if (ownIndex < 0) {
    return;
  }

  stack.splice(
    ownIndex,
    1
  );

  let targetIndex =
    stack.length;

  for (
    let index = 0;
    index < stack.length;
    index += 1
  ) {
    const candidate =
      stack[index];

    const path =
      clean(
        candidate?.route?.path
      );

    const regexp =
      clean(
        candidate?.regexp
      );

    const name =
      clean(
        candidate?.name
      );

    if (
      /webhook/i.test(path) ||
      /webhook/i.test(regexp) ||
      /webhook/i.test(name)
    ) {
      targetIndex = index;
      break;
    }
  }

  stack.splice(
    targetIndex,
    0,
    layer
  );
}

export function installChannelAudienceReports(
  app
) {
  if (installed) {
    return;
  }

  installed = true;

  void ensureSchema()
    .then(() => {
      setTimeout(() => {
        void syncAllEnabledChannels();
      }, 15_000).unref?.();
    })
    .catch((error) => {
      console.error(
        '[LR_AUDIENCE_INIT]',
        error?.stack ||
        error?.message ||
        error
      );
    });

  app.get(
    '/audience/:token',
    (req, res) => {
      void handleReportPage(
        req,
        res
      ).catch((error) => {
        console.error(
          '[LR_AUDIENCE_PAGE]',
          error?.stack ||
          error?.message ||
          error
        );

        if (!res.headersSent) {
          res
            .status(500)
            .send(
              'Не удалось сформировать отчёт'
            );
        }
      });
    }
  );

  app.get(
    '/api/audience/:token',
    (req, res) => {
      void handleReportApi(
        req,
        res
      ).catch((error) => {
        console.error(
          '[LR_AUDIENCE_API]',
          error?.stack ||
          error?.message ||
          error
        );

        if (!res.headersSent) {
          res
            .status(500)
            .json({
              ok: false,
              error:
                'audience_report_failed',
            });
        }
      });
    }
  );

  const before =
    middlewareStack(app).length;

  app.use(
    async function lrAudienceReportsMiddleware(
      req,
      res,
      next
    ) {
      try {
        if (req.method !== 'POST') {
          return next();
        }

        const update =
          req.body || {};

        const profileHandled =
          await handleAudienceUserStart(
            update
          );

        if (profileHandled) {
          if (!res.headersSent) {
            return res.json({
              ok: true,
              handled:
                'lr_audience_user_profile',
            });
          }

          return;
        }

        const handled =
          await handleAudienceCallback(
            update
          );

        if (handled) {
          if (!res.headersSent) {
            return res.json({
              ok: true,
              handled:
                'lr_audience_reports',
            });
          }

          return;
        }
      } catch (error) {
        console.error(
          '[LR_AUDIENCE_MIDDLEWARE]',
          error?.stack ||
          error?.message ||
          error
        );
      }

      return next();
    }
  );

  const stack =
    middlewareStack(app);

  const layer =
    stack[before] ||
    stack[stack.length - 1];

  moveBeforeWebhook(
    app,
    layer
  );

  syncTimer =
    setInterval(() => {
      void syncAllEnabledChannels();
    }, SYNC_INTERVAL_MS);

  syncTimer.unref?.();

  console.log(
    '[LR_AUDIENCE_REPORTS_INSTALLED]',
    JSON.stringify({
      apiBase: API_BASE,
      publicBaseUrl:
        PUBLIC_BASE_URL,
      syncIntervalMs:
        SYNC_INTERVAL_MS,
      maxSyncMembers:
        MAX_SYNC_MEMBERS,
    })
  );
}

export function audienceBotsAndPageSmokeTest() {
  const bot =
    normalizeMember({
      user_id: '777',
      first_name: 'Test',
      is_bot: true,
    });

  const html =
    renderReportPage({
      channel: {
        channel_id: '123',
        title: 'Тестовый канал',
        link: '',
      },
      access: {
        from:
          new Date(
            Date.now() -
            24 * 60 * 60_000
          ),
        to:
          new Date(),
      },
      reportToken:
        'test-token',
    });

  return {
    ok:
      Boolean(bot?.isBot) &&
      html.includes(
        'Отчёт ПДП LinkRay'
      ) &&
      html.includes(
        'class="person-name"'
      ) &&
      !html.includes(
        '<a class="person-name"'
      ),
    botAccepted:
      Boolean(bot?.isBot),
    staticNames:
      !html.includes(
        '<a class="person-name"'
      ),
    pageLength:
      html.length,
  };
}

export async function audienceReportsSmokeTest() {
  await ensureSchema();

  const testToken =
    buildReportToken(
      'test-owner',
      '123',
      {
        hours: 24,
        expiresDays: 1,
      }
    );

  const parsed =
    parseReportToken(testToken);

  if (
    !parsed ||
    parsed.ownerChatId !==
      'test-owner' ||
    parsed.channelId !==
      '123'
  ) {
    throw new Error(
      'Audience report token self-test failed'
    );
  }

  const tables = rows(
    await query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name IN (
          'lr_channel_member_profiles',
          'lr_channel_memberships',
          'lr_audience_sync_state'
        )
      ORDER BY table_name
    `)
  );

  return {
    ok: tables.length === 3,
    tables:
      tables.map(
        (row) => row.table_name
      ),
    token:
      true,
  };
}

