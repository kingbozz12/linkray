import crypto from 'node:crypto';
import sharp from 'sharp';

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
    process.env.LR_PROOF_SYNC_INTERVAL_MS ||
    5 * 60_000
  )
);

const CHECKPOINTS = [1, 6, 12, 24, 48, 72];

let schemaPromise = null;
let syncTimer = null;
let syncBusy = false;
let installed = false;

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
  const parsed = Number(value);

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

function attr(value) {
  return esc(value)
    .replace(/'/g, '&#39;');
}

function plain(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|blockquote|h1|h2|h3)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function short(value, max = 45) {
  const text = plain(value);

  if (!text) {
    return 'Рекламное размещение';
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
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }
  ).format(num(value))} ₽`;
}

function percent(value) {
  return `${Math.max(
    0,
    Math.min(100, int(value))
  )}%`;
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

function safeJson(value, fallback = {}) {
  try {
    if (
      value === null ||
      value === undefined ||
      value === ''
    ) {
      return fallback;
    }

    if (typeof value === 'object') {
      return value;
    }

    return JSON.parse(value);
  } catch {
    return fallback;
  }
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
      '[LinkRay Proof SQL]',
      error?.message || error
    );

    return [];
  }
}

async function tableExists(tableName) {
  const result = await safeQuery(
    `SELECT to_regclass($1) AS name`,
    [`public.${tableName}`]
  );

  return Boolean(result[0]?.name);
}

async function tableColumns(tableName) {
  const result = await safeQuery(`
    SELECT column_name

    FROM information_schema.columns

    WHERE table_schema='public'
      AND table_name=$1
  `, [tableName]);

  return new Set(
    result.map(
      (item) => String(item.column_name)
    )
  );
}

function qident(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function deepNumber(
  value,
  preferredKeys = []
) {
  let best = null;
  const preferred = new Set(
    preferredKeys.map(
      (item) => item.toLowerCase()
    )
  );

  function parse(raw) {
    if (
      raw === null ||
      raw === undefined ||
      raw === ''
    ) {
      return null;
    }

    if (typeof raw === 'number') {
      return Number.isFinite(raw)
        ? raw
        : null;
    }

    if (typeof raw === 'string') {
      const normalized = raw
        .replace(/\s+/g, '')
        .replace(',', '.');

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
      for (const child of node) {
        walk(child);
      }

      return;
    }

    for (const [key, child] of Object.entries(node)) {
      if (preferred.has(key.toLowerCase())) {
        const parsed = parse(child);

        if (
          parsed !== null &&
          (best === null || parsed > best)
        ) {
          best = parsed;
        }
      }
    }

    for (const child of Object.values(node)) {
      if (
        child &&
        typeof child === 'object'
      ) {
        walk(child);
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
          'total_views',
          'totalViews',
          'reads',
          'impressions',
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
          'subscribers',
          'subscribers_count',
          'subscriber_count',
          'members_count',
          'participants_count',
          'participantsCount',
          'membersCount',
          'members',
        ]
      ),
      0
    )
  );
}

function extractJoined(value) {
  return Math.max(
    0,
    int(
      deepNumber(
        value,
        [
          'joined',
          'joined_24h',
          'joins',
          'subscriptions',
          'subscribed',
          'new_subscribers',
        ]
      ),
      0
    )
  );
}

function extractLeft(value) {
  return Math.max(
    0,
    int(
      deepNumber(
        value,
        [
          'left',
          'left_24h',
          'leaves',
          'unsubscriptions',
          'unsubscribed',
          'lost_subscribers',
        ]
      ),
      0
    )
  );
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

  const scalar = [
    update?.callback?.user_id,
    update?.callback?.userId,
    update?.message_callback?.user_id,
    update?.message_callback?.userId,
    update?.user_id,
    update?.userId,
    update?.body?.user_id,
    update?.body?.userId,
  ];

  for (const value of scalar) {
    const id = clean(value, 100);

    if (/^\d+$/.test(id)) {
      return id;
    }
  }

  return '';
}

function updateChatId(update) {
  const values = [
    update?.callback?.message?.recipient?.chat_id,
    update?.callback?.message?.recipient?.chatId,
    update?.message_callback?.message?.recipient?.chat_id,
    update?.message_callback?.message?.recipient?.chatId,
    update?.message?.recipient?.chat_id,
    update?.message?.recipient?.chatId,
    update?.chat_id,
    update?.chatId,
  ];

  for (const value of values) {
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
  const callbackId =
    updateCallbackId(update);

  const attachments =
    keyboard(buttonRows);

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
      purpose: 'linkray_proof_reports',
    });

    return;
  }

  if (chatId) {
    await sendMaxMessage({
      chatId,
      text,
      format: 'html',
      attachments,
      purpose: 'linkray_proof_reports',
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
        public.lr_proof_reports (
          id bigserial PRIMARY KEY,

          public_number bigserial UNIQUE,

          report_code text UNIQUE,

          source_post_id bigint UNIQUE,

          source_group_id text,

          owner_user_id bigint
            REFERENCES public.lr_users(id)
            ON DELETE SET NULL,

          channel_id bigint
            REFERENCES public.channels(id)
            ON DELETE SET NULL,

          max_chat_id text,
          max_message_id text,

          channel_title text,
          channel_link text,

          post_text text,

          published_at timestamptz,
          expected_finish_at timestamptz,
          completed_at timestamptz,
          deleted_at timestamptz,
          archived_at timestamptz,

          duration_hours integer
            NOT NULL DEFAULT 24,

          expected_min_views integer,
          agreed_cost numeric(14,2),
          cpm numeric(14,2),

          status text
            NOT NULL DEFAULT 'collecting',

          payment_status text
            NOT NULL DEFAULT 'unpaid',

          current_views integer
            NOT NULL DEFAULT 0,

          start_subscribers integer,
          current_subscribers integer,

          joined_count integer
            NOT NULL DEFAULT 0,

          left_count integer
            NOT NULL DEFAULT 0,

          net_subscribers integer
            NOT NULL DEFAULT 0,

          score integer
            NOT NULL DEFAULT 0,

          risk_score integer
            NOT NULL DEFAULT 0,

          conclusion text,

          conditions jsonb
            NOT NULL DEFAULT '{}'::jsonb,

          last_raw jsonb
            NOT NULL DEFAULT '{}'::jsonb,

          share_token text
            NOT NULL UNIQUE,

          last_sync_at timestamptz,

          created_at timestamptz
            NOT NULL DEFAULT now(),

          updated_at timestamptz
            NOT NULL DEFAULT now()
        )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
        lr_proof_reports_owner_status_idx
      ON public.lr_proof_reports(
        owner_user_id,
        status,
        updated_at DESC
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
        lr_proof_reports_channel_idx
      ON public.lr_proof_reports(
        channel_id,
        published_at DESC
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_proof_snapshots (
          id bigserial PRIMARY KEY,

          report_id bigint NOT NULL
            REFERENCES public.lr_proof_reports(id)
            ON DELETE CASCADE,

          checkpoint_hours integer NOT NULL,

          captured_at timestamptz
            NOT NULL DEFAULT now(),

          elapsed_minutes integer
            NOT NULL DEFAULT 0,

          views integer
            NOT NULL DEFAULT 0,

          subscribers integer,
          joined_count integer
            NOT NULL DEFAULT 0,

          left_count integer
            NOT NULL DEFAULT 0,

          source text
            NOT NULL DEFAULT 'max_api',

          raw jsonb
            NOT NULL DEFAULT '{}'::jsonb,

          UNIQUE (
            report_id,
            checkpoint_hours
          )
        )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
        lr_proof_snapshots_report_idx
      ON public.lr_proof_snapshots(
        report_id,
        checkpoint_hours
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_proof_sessions (
          max_user_id text PRIMARY KEY,

          state text
            NOT NULL DEFAULT 'idle',

          data jsonb
            NOT NULL DEFAULT '{}'::jsonb,

          updated_at timestamptz
            NOT NULL DEFAULT now()
        )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_proof_campaigns (
          id bigserial PRIMARY KEY,

          source_group_id text
            NOT NULL UNIQUE,

          title text,

          owner_user_id bigint
            REFERENCES public.lr_users(id)
            ON DELETE SET NULL,

          archived_at timestamptz,

          created_at timestamptz
            NOT NULL DEFAULT now(),

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

async function userChannelIds(userId) {
  if (!userId) {
    return [];
  }

  const result = await safeQuery(`
    SELECT DISTINCT channel_id

    FROM public.lr_user_channels

    WHERE user_id=$1
  `, [Number(userId)]);

  return result
    .map(
      (item) => Number(item.channel_id)
    )
    .filter(
      (item) =>
        Number.isFinite(item)
    );
}

async function setSession(
  maxUserId,
  state,
  data = {}
) {
  await ensureSchema();

  await query(`
    INSERT INTO public.lr_proof_sessions (
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
      SELECT
        state,
        data

      FROM public.lr_proof_sessions

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

function rawValue(raw, keys) {
  for (const key of keys) {
    const value = raw?.[key];

    if (
      value !== null &&
      value !== undefined &&
      value !== ''
    ) {
      return value;
    }
  }

  return null;
}

function rawDate(raw, keys) {
  const value = rawValue(raw, keys);

  if (!value) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function rawBool(raw, keys) {
  const value = rawValue(raw, keys);

  if (typeof value === 'boolean') {
    return value;
  }

  return [
    '1',
    'true',
    'yes',
    'on',
  ].includes(
    String(value ?? '')
      .trim()
      .toLowerCase()
  );
}

function newToken() {
  return crypto
    .randomBytes(20)
    .toString('hex');
}

async function ownerFromRaw(
  raw,
  channelId
) {
  const maxUserId = clean(
    rawValue(
      raw,
      [
        'created_by_max_user_id',
        'owner_max_user_id',
        'creator_max_user_id',
        'max_user_id',
        'user_id',
        'created_by',
      ]
    ),
    100
  );

  if (/^\d+$/.test(maxUserId)) {
    const direct = (
      await safeQuery(`
        SELECT id

        FROM public.lr_users

        WHERE max_user_id=$1
        LIMIT 1
      `, [maxUserId])
    )[0];

    if (direct?.id) {
      return Number(direct.id);
    }
  }

  const relation = (
    await safeQuery(`
      SELECT user_id

      FROM public.lr_user_channels

      WHERE channel_id=$1

      ORDER BY
        CASE
          WHEN role='owner'
          THEN 0
          ELSE 1
        END,
        user_id

      LIMIT 1
    `, [Number(channelId)])
  )[0];

  return relation?.user_id
    ? Number(relation.user_id)
    : null;
}

async function importAdPosts() {
  await ensureSchema();

  if (!await tableExists('scheduled_posts')) {
    return {
      imported: 0,
      found: 0,
    };
  }

  const result = await safeQuery(`
    WITH source AS (
      SELECT
        sp.id,
        to_jsonb(sp) AS raw,

        c.id AS channel_id,
        c.max_chat_id::text AS max_chat_id,
        c.title AS channel_title,
        c.link AS channel_link

      FROM public.scheduled_posts sp

      LEFT JOIN public.channels c
        ON c.id=sp.channel_id
    )

    SELECT *

    FROM source

    WHERE LOWER(
      COALESCE(
        raw->>'is_ad',
        raw->>'isAd',
        raw->>'advertising',
        raw->>'is_advertising',
        raw->>'promo',
        'false'
      )
    ) IN (
      'true',
      '1',
      'yes',
      'on'
    )

      AND (
        NULLIF(
          raw->>'published_at',
          ''
        ) IS NOT NULL

        OR LOWER(
          COALESCE(
            raw->>'status',
            ''
          )
        ) IN (
          'published',
          'sent',
          'done',
          'posted',
          'success'
        )
      )

      AND LOWER(
        COALESCE(
          raw->>'status',
          ''
        )
      ) NOT IN (
        'draft',
        'deleted',
        'cancelled',
        'canceled',
        'failed'
      )

    ORDER BY id
  `);

  let imported = 0;

  for (const item of result) {
    const raw = safeJson(item.raw, {});

    const publishedAt =
      rawDate(
        raw,
        [
          'published_at',
          'publish_at',
          'created_at',
        ]
      ) || new Date();

    const durationHours = Math.max(
      1,
      int(
        rawValue(
          raw,
          [
            'report_after_hours',
            'duration_hours',
            'placement_hours',
          ]
        ),
        24
      )
    );

    const expectedFinishAt =
      new Date(
        publishedAt.getTime() +
        durationHours * 3600_000
      );

    const ownerUserId =
      await ownerFromRaw(
        raw,
        item.channel_id
      );

    const sourceGroupId = clean(
      rawValue(
        raw,
        [
          'report_group_id',
          'campaign_id',
          'group_id',
        ]
      ) || String(item.id),
      200
    );

    const maxMessageId = clean(
      rawValue(
        raw,
        [
          'published_message_id',
          'message_id',
          'max_message_id',
          'publishedMessageId',
        ]
      ),
      300
    );

    const cpm = Math.max(
      0,
      num(
        rawValue(
          raw,
          [
            'cpm',
            'expected_cpm',
          ]
        ),
        0
      )
    );

    const agreedCost = Math.max(
      0,
      num(
        rawValue(
          raw,
          [
            'agreed_cost',
            'price',
            'cost',
            'budget',
          ]
        ),
        0
      )
    );

    const expectedMinViews = Math.max(
      0,
      int(
        rawValue(
          raw,
          [
            'expected_min_views',
            'min_views',
            'expected_views',
          ]
        ),
        0
      )
    );

    const postText = clean(
      rawValue(
        raw,
        [
          'text',
          'post_text',
          'caption',
        ]
      ),
      10000
    );

    const inserted = await safeQuery(`
      INSERT INTO public.lr_proof_reports (
        source_post_id,
        source_group_id,
        owner_user_id,
        channel_id,
        max_chat_id,
        max_message_id,
        channel_title,
        channel_link,
        post_text,
        published_at,
        expected_finish_at,
        duration_hours,
        expected_min_views,
        agreed_cost,
        cpm,
        share_token,
        last_raw,
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
        $9,
        $10,
        $11,
        $12,
        NULLIF($13, 0),
        NULLIF($14, 0),
        NULLIF($15, 0),
        $16,
        $17::jsonb,
        now(),
        now()
      )

      ON CONFLICT (source_post_id)
      DO UPDATE SET
        source_group_id=
          COALESCE(
            EXCLUDED.source_group_id,
            public.lr_proof_reports.source_group_id
          ),

        owner_user_id=
          COALESCE(
            public.lr_proof_reports.owner_user_id,
            EXCLUDED.owner_user_id
          ),

        channel_id=
          COALESCE(
            EXCLUDED.channel_id,
            public.lr_proof_reports.channel_id
          ),

        max_chat_id=
          COALESCE(
            NULLIF(EXCLUDED.max_chat_id, ''),
            public.lr_proof_reports.max_chat_id
          ),

        max_message_id=
          COALESCE(
            NULLIF(EXCLUDED.max_message_id, ''),
            public.lr_proof_reports.max_message_id
          ),

        channel_title=
          COALESCE(
            NULLIF(EXCLUDED.channel_title, ''),
            public.lr_proof_reports.channel_title
          ),

        channel_link=
          COALESCE(
            NULLIF(EXCLUDED.channel_link, ''),
            public.lr_proof_reports.channel_link
          ),

        post_text=
          COALESCE(
            NULLIF(EXCLUDED.post_text, ''),
            public.lr_proof_reports.post_text
          ),

        updated_at=now()

      RETURNING
        id,
        report_code
    `, [
      Number(item.id),
      sourceGroupId,
      ownerUserId,
      item.channel_id
        ? Number(item.channel_id)
        : null,
      clean(item.max_chat_id, 100) || null,
      maxMessageId || null,
      clean(item.channel_title, 500) || null,
      clean(item.channel_link, 2000) || null,
      postText || null,
      publishedAt.toISOString(),
      expectedFinishAt.toISOString(),
      durationHours,
      expectedMinViews,
      agreedCost,
      cpm,
      newToken(),
      JSON.stringify(raw),
    ]);

    const report = inserted[0];

    if (report?.id) {
      if (!report.report_code) {
        await query(`
          UPDATE public.lr_proof_reports

          SET
            report_code=
              'LR-RPT-' ||
              LPAD(
                public_number::text,
                6,
                '0'
              ),

            updated_at=now()

          WHERE id=$1
        `, [Number(report.id)]);
      }

      imported += 1;
    }

    if (sourceGroupId) {
      await query(`
        INSERT INTO public.lr_proof_campaigns (
          source_group_id,
          title,
          owner_user_id,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          now(),
          now()
        )

        ON CONFLICT (source_group_id)
        DO UPDATE SET
          owner_user_id=
            COALESCE(
              public.lr_proof_campaigns.owner_user_id,
              EXCLUDED.owner_user_id
            ),

          updated_at=now()
      `, [
        sourceGroupId,
        short(postText, 80),
        ownerUserId,
      ]);
    }
  }

  return {
    imported,
    found: result.length,
  };
}

async function latestMetricFromTable(
  tableName,
  channelId,
  maxChatId,
  before = null
) {
  if (!await tableExists(tableName)) {
    return null;
  }

  const columns =
    await tableColumns(tableName);

  const channelColumns = [
    'channel_id',
    'chat_id',
    'max_chat_id',
    'channelId',
    'chatId',
  ].filter(
    (column) => columns.has(column)
  );

  if (!channelColumns.length) {
    return null;
  }

  const timeColumn = [
    'captured_at',
    'collected_at',
    'snapshot_at',
    'created_at',
    'updated_at',
    'date',
  ].find(
    (column) => columns.has(column)
  );

  const ids = [
    String(channelId || ''),
    String(maxChatId || ''),
  ].filter(Boolean);

  if (!ids.length) {
    return null;
  }

  const where = channelColumns
    .map(
      (column) =>
        `${qident(column)}::text=ANY($1::text[])`
    )
    .join(' OR ');

  const params = [ids];
  let beforeWhere = '';

  if (before && timeColumn) {
    params.push(before);
    beforeWhere =
      ` AND ${qident(timeColumn)} <= $2`;
  }

  const order = timeColumn
    ? `ORDER BY ${qident(timeColumn)} DESC NULLS LAST`
    : '';

  const result = await safeQuery(`
    SELECT to_jsonb(source_row) AS raw

    FROM ${qident(tableName)} source_row

    WHERE (${where})
      ${beforeWhere}

    ${order}

    LIMIT 1
  `, params);

  return result[0]?.raw || null;
}

async function channelMetricSnapshot(
  report,
  before = null
) {
  const knownTables = [
    'lr_channel_analytics_snapshots',
    'lr_channel_metrics_snapshots',
    'lr_channel_metric_snapshots',
    'channel_metrics_snapshots',
    'channel_metrics_history',
    'lr_channel_analytics_history',
  ];

  for (const tableName of knownTables) {
    const raw =
      await latestMetricFromTable(
        tableName,
        report.channel_id,
        report.max_chat_id,
        before
      );

    if (raw) {
      return {
        subscribers:
          extractSubscribers(raw),

        joined:
          extractJoined(raw),

        left:
          extractLeft(raw),

        raw,
        source: tableName,
      };
    }
  }

  return null;
}

async function maxMessageMetrics(report) {
  if (!report.max_message_id) {
    return {
      views: report.current_views || 0,
      deleted: false,
      raw: {},
      source: 'stored',
    };
  }

  try {
    const response =
      await getMaxMessage(
        report.max_message_id,
        {
          chatId:
            report.max_chat_id ||
            report.channel_id,
        }
      );

    const message =
      Array.isArray(response?.messages)
        ? response.messages[0]
        : (
            response?.message ||
            response
          );

    return {
      views:
        extractViews(message || response),

      deleted: false,
      raw:
        message || response || {},

      source: 'max_message',
    };
  } catch (error) {
    const text = String(
      error?.message || error
    );

    const deleted =
      /\b404\b|not found|deleted/i
        .test(text);

    return {
      views:
        report.current_views || 0,

      deleted,

      raw: {
        error: text,
      },

      source: 'max_message_error',
    };
  }
}

async function maxChannelSubscribers(report) {
  if (!report.max_chat_id) {
    return {
      subscribers:
        report.current_subscribers ||
        report.start_subscribers ||
        0,

      raw: {},
      source: 'stored',
    };
  }

  try {
    const response =
      await getMaxChatInfo(
        report.max_chat_id
      );

    return {
      subscribers:
        extractSubscribers(response),

      raw: response || {},
      source: 'max_chat',
    };
  } catch (error) {
    return {
      subscribers:
        report.current_subscribers ||
        report.start_subscribers ||
        0,

      raw: {
        error:
          String(error?.message || error),
      },

      source: 'max_chat_error',
    };
  }
}

function elapsedHours(report) {
  const published =
    report.published_at
      ? new Date(report.published_at)
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

function progressValue(report) {
  const duration = Math.max(
    1,
    int(report.duration_hours, 24)
  );

  return Math.min(
    100,
    Math.round(
      elapsedHours(report) /
      duration *
      100
    )
  );
}

function progressBar(value) {
  const total = 12;
  const filled = Math.max(
    0,
    Math.min(
      total,
      Math.round(
        value / 100 * total
      )
    )
  );

  return (
    '█'.repeat(filled) +
    '░'.repeat(total - filled)
  );
}

function statusMeta(status) {
  const map = {
    collecting: [
      '🟡',
      'Собираются данные',
    ],

    active: [
      '🟢',
      'Размещение активно',
    ],

    completed: [
      '✅',
      'Условия выполнены',
    ],

    attention: [
      '⚠️',
      'Требует внимания',
    ],

    violated: [
      '❌',
      'Условия нарушены',
    ],

    archived: [
      '📁',
      'В архиве',
    ],
  };

  return map[status] || [
    '🟡',
    'Собираются данные',
  ];
}

function calculateRisk(snapshots) {
  if (snapshots.length < 3) {
    return 0;
  }

  const rates = [];

  for (
    let index = 1;
    index < snapshots.length;
    index += 1
  ) {
    const previous =
      snapshots[index - 1];

    const current =
      snapshots[index];

    const hours = Math.max(
      0.1,
      (
        num(current.elapsed_minutes) -
        num(previous.elapsed_minutes)
      ) / 60
    );

    const delta = Math.max(
      0,
      int(current.views) -
      int(previous.views)
    );

    rates.push(delta / hours);
  }

  if (rates.length < 2) {
    return 0;
  }

  const sorted = [...rates]
    .sort((a, b) => a - b);

  const median =
    sorted[
      Math.floor(sorted.length / 2)
    ] || 0;

  const peak =
    Math.max(...rates);

  if (
    median > 0 &&
    peak > median * 8
  ) {
    return 55;
  }

  if (
    median > 0 &&
    peak > median * 5
  ) {
    return 30;
  }

  if (
    median > 0 &&
    peak > median * 3
  ) {
    return 15;
  }

  return 0;
}

function evaluateReport(
  report,
  snapshots,
  deleted
) {
  const duration = Math.max(
    1,
    int(report.duration_hours, 24)
  );

  const elapsed =
    elapsedHours(report);

  const expectedViews =
    Math.max(
      0,
      int(report.expected_min_views)
    );

  const currentViews =
    Math.max(
      0,
      int(report.current_views)
    );

  const durationDone =
    elapsed >= duration;

  const viewsDone =
    expectedViews <= 0 ||
    currentViews >= expectedViews;

  const earlyDeleted =
    Boolean(deleted) &&
    !durationDone;

  const risk =
    calculateRisk(snapshots);

  let score = 100;

  if (earlyDeleted) {
    score -= 45;
  }

  if (
    expectedViews > 0 &&
    currentViews < expectedViews
  ) {
    const ratio =
      currentViews /
      Math.max(1, expectedViews);

    score -= Math.round(
      (1 - ratio) * 35
    );
  }

  score -= Math.round(
    risk * 0.35
  );

  if (
    !report.max_message_id
  ) {
    score -= 10;
  }

  score = Math.max(
    0,
    Math.min(100, score)
  );

  let status = 'active';

  if (report.archived_at) {
    status = 'archived';
  } else if (earlyDeleted) {
    status = 'violated';
  } else if (!durationDone) {
    status =
      report.max_message_id
        ? 'active'
        : 'collecting';
  } else if (viewsDone && risk < 40) {
    status = 'completed';
  } else {
    status = 'attention';
  }

  let conclusion = '';

  if (earlyDeleted) {
    conclusion =
      `Пост удалён раньше согласованного срока. ` +
      `Фактическое размещение — ${elapsed.toFixed(1)} ч. ` +
      `из ${duration} ч.`;
  } else if (
    durationDone &&
    viewsDone &&
    risk < 20
  ) {
    conclusion =
      'Условия размещения выполнены. ' +
      'Подозрительных скачков просмотров не обнаружено.';
  } else if (
    durationDone &&
    !viewsDone
  ) {
    conclusion =
      `Срок размещения выполнен, но минимальный объём просмотров ` +
      `не достигнут: ${fmt(currentViews)} из ${fmt(expectedViews)}.`;
  } else if (risk >= 40) {
    conclusion =
      'Обнаружен резкий нетипичный скачок просмотров. ' +
      'Размещение требует дополнительной проверки.';
  } else {
    conclusion =
      'Размещение активно. Данные обновляются, ' +
      'итоговая оценка будет сформирована после завершения срока.';
  }

  return {
    status,
    score,
    risk,
    conclusion,
  };
}

async function reportSnapshots(reportId) {
  return safeQuery(`
    SELECT *

    FROM public.lr_proof_snapshots

    WHERE report_id=$1

    ORDER BY checkpoint_hours
  `, [Number(reportId)]);
}

async function insertCheckpoints(
  report,
  metrics
) {
  const elapsed =
    elapsedHours(report);

  for (const checkpoint of CHECKPOINTS) {
    if (elapsed < checkpoint) {
      continue;
    }

    await query(`
      INSERT INTO public.lr_proof_snapshots (
        report_id,
        checkpoint_hours,
        captured_at,
        elapsed_minutes,
        views,
        subscribers,
        joined_count,
        left_count,
        source,
        raw
      )
      VALUES (
        $1,
        $2,
        now(),
        $3,
        $4,
        NULLIF($5, 0),
        $6,
        $7,
        $8,
        $9::jsonb
      )

      ON CONFLICT (
        report_id,
        checkpoint_hours
      )
      DO NOTHING
    `, [
      Number(report.id),
      checkpoint,
      Math.round(elapsed * 60),
      Math.max(0, int(metrics.views)),
      Math.max(0, int(metrics.subscribers)),
      Math.max(0, int(metrics.joined)),
      Math.max(0, int(metrics.left)),
      clean(metrics.source, 100),
      JSON.stringify(metrics.raw || {}),
    ]);
  }
}

async function syncReport(report) {
  const message =
    await maxMessageMetrics(report);

  const channel =
    await maxChannelSubscribers(report);

  const currentMetric =
    await channelMetricSnapshot(report);

  let startSubscribers =
    report.start_subscribers;

  if (
    !startSubscribers &&
    report.published_at
  ) {
    const initialMetric =
      await channelMetricSnapshot(
        report,
        report.published_at
      );

    startSubscribers =
      initialMetric?.subscribers ||
      currentMetric?.subscribers ||
      channel.subscribers ||
      null;
  }

  const currentSubscribers =
    currentMetric?.subscribers ||
    channel.subscribers ||
    report.current_subscribers ||
    startSubscribers ||
    null;

  const joined =
    currentMetric?.joined ||
    report.joined_count ||
    0;

  const left =
    currentMetric?.left ||
    report.left_count ||
    0;

  const net =
    currentSubscribers &&
    startSubscribers
      ? (
          currentSubscribers -
          startSubscribers
        )
      : (
          joined - left
        );

  const currentViews = Math.max(
    int(report.current_views),
    int(message.views)
  );

  await query(`
    UPDATE public.lr_proof_reports

    SET
      current_views=$2,
      start_subscribers=
        COALESCE(
          start_subscribers,
          NULLIF($3, 0)
        ),

      current_subscribers=
        NULLIF($4, 0),

      joined_count=$5,
      left_count=$6,
      net_subscribers=$7,

      deleted_at=CASE
        WHEN $8
        THEN COALESCE(deleted_at, now())
        ELSE deleted_at
      END,

      last_raw=
        COALESCE(last_raw, '{}'::jsonb)
        ||
        $9::jsonb,

      last_sync_at=now(),
      updated_at=now()

    WHERE id=$1
  `, [
    Number(report.id),
    currentViews,
    int(startSubscribers),
    int(currentSubscribers),
    int(joined),
    int(left),
    int(net),
    Boolean(message.deleted),
    JSON.stringify({
      max_message: message.raw,
      max_channel: channel.raw,
      channel_metric:
        currentMetric?.raw || {},
    }),
  ]);

  const updated = (
    await safeQuery(`
      SELECT *
      FROM public.lr_proof_reports
      WHERE id=$1
      LIMIT 1
    `, [Number(report.id)])
  )[0];

  const metrics = {
    views: currentViews,
    subscribers:
      currentSubscribers,

    joined,
    left,

    source:
      [
        message.source,
        currentMetric?.source,
        channel.source,
      ].filter(Boolean).join('+'),

    raw: {
      message:
        message.raw || {},

      channel:
        channel.raw || {},

      metrics:
        currentMetric?.raw || {},
    },
  };

  await insertCheckpoints(
    updated,
    metrics
  );

  const snapshots =
    await reportSnapshots(
      updated.id
    );

  const evaluation =
    evaluateReport(
      updated,
      snapshots,
      message.deleted
    );

  await query(`
    UPDATE public.lr_proof_reports

    SET
      status=$2,
      score=$3,
      risk_score=$4,
      conclusion=$5,

      completed_at=CASE
        WHEN $2 IN (
          'completed',
          'attention',
          'violated'
        )
        THEN COALESCE(completed_at, now())
        ELSE completed_at
      END,

      updated_at=now()

    WHERE id=$1
  `, [
    Number(updated.id),
    evaluation.status,
    evaluation.score,
    evaluation.risk,
    evaluation.conclusion,
  ]);

  return {
    ...updated,
    ...evaluation,
  };
}

async function syncReports(
  options = {}
) {
  if (syncBusy) {
    return {
      skipped: true,
      reason: 'already_running',
    };
  }

  syncBusy = true;

  try {
    await ensureSchema();

    const imported =
      await importAdPosts();

    const limit = Math.max(
      1,
      Math.min(
        100,
        int(options.limit, 30)
      )
    );

    const reports = await safeQuery(`
      SELECT *

      FROM public.lr_proof_reports

      WHERE archived_at IS NULL

        AND status IN (
          'collecting',
          'active',
          'attention'
        )

      ORDER BY
        published_at DESC NULLS LAST,
        id DESC

      LIMIT $1
    `, [limit]);

    let successful = 0;
    let failed = 0;

    for (const report of reports) {
      try {
        await syncReport(report);
        successful += 1;
      } catch (error) {
        failed += 1;

        console.error(
          '[LinkRay Proof sync report]',
          JSON.stringify({
            reportId: report.id,
            error:
              String(
                error?.message || error
              ),
          })
        );
      }
    }

    return {
      skipped: false,
      imported,
      total: reports.length,
      successful,
      failed,
    };
  } finally {
    syncBusy = false;
  }
}

async function accessContext(update) {
  const maxUserId =
    updateUserId(update);

  const user =
    await currentUser(maxUserId);

  const channelIds =
    await userChannelIds(
      user?.id
    );

  return {
    maxUserId,
    user,
    channelIds,
  };
}

function accessSql(
  context,
  alias = 'report'
) {
  const params = [];
  const parts = [];

  if (context.user?.id) {
    params.push(Number(context.user.id));

    parts.push(
      `${alias}.owner_user_id=$${params.length}`
    );
  }

  if (context.channelIds.length) {
    params.push(context.channelIds);

    parts.push(
      `${alias}.channel_id=ANY($${params.length}::bigint[])`
    );
  }

  if (!parts.length) {
    return {
      where: 'false',
      params,
    };
  }

  return {
    where:
      `(${parts.join(' OR ')})`,

    params,
  };
}

async function loadAccessibleReport(
  update,
  reportId
) {
  const context =
    await accessContext(update);

  const access =
    accessSql(context);

  return (
    await safeQuery(`
      SELECT *

      FROM public.lr_proof_reports report

      WHERE report.id=$1
        AND ${access.where}

      LIMIT 1
    `, [
      Number(reportId),
      ...access.params,
    ])
  )[0] || null;
}

function reportTitle(report) {
  return short(
    report.post_text,
    42
  );
}

function reportChannelHtml(report) {
  const title = esc(
    report.channel_title ||
    'Канал MAX'
  );

  const link =
    clean(
      report.channel_link,
      2000
    );

  return /^https:\/\/(?:[\w-]+\.)?max\.ru\//i
    .test(link)
      ? `<a href="${attr(link)}">${title}</a>`
      : `<b>${title}</b>`;
}

function reportPublicUrl(report) {
  return (
    `${PUBLIC_BASE_URL}/proof/` +
    encodeURIComponent(
      report.share_token
    )
  );
}

function reportCardUrl(report) {
  return (
    `${reportPublicUrl(report)}` +
    '/card.png'
  );
}

function remainingText(report) {
  const finish =
    report.expected_finish_at
      ? new Date(report.expected_finish_at)
      : null;

  if (
    !finish ||
    Number.isNaN(finish.getTime())
  ) {
    return '—';
  }

  const milliseconds =
    finish.getTime() -
    Date.now();

  if (milliseconds <= 0) {
    return 'завершено';
  }

  const totalMinutes =
    Math.ceil(
      milliseconds / 60_000
    );

  const hours =
    Math.floor(
      totalMinutes / 60
    );

  const minutes =
    totalMinutes % 60;

  return hours > 0
    ? `${hours} ч. ${minutes} мин.`
    : `${minutes} мин.`;
}

function actualCpm(report) {
  if (
    num(report.agreed_cost) > 0 &&
    num(report.current_views) > 0
  ) {
    return (
      num(report.agreed_cost) /
      num(report.current_views) *
      1000
    );
  }

  return num(report.cpm);
}

function estimatedCost(report) {
  if (num(report.agreed_cost) > 0) {
    return num(report.agreed_cost);
  }

  if (
    num(report.cpm) > 0 &&
    num(report.current_views) > 0
  ) {
    return (
      num(report.current_views) /
      1000 *
      num(report.cpm)
    );
  }

  return 0;
}

function reportDetailText(
  report,
  snapshots
) {
  const [icon, status] =
    statusMeta(report.status);

  const progress =
    progressValue(report);

  const checkpointLines =
    CHECKPOINTS.map(
      (checkpoint) => {
        const snapshot =
          snapshots.find(
            (item) =>
              int(item.checkpoint_hours) ===
              checkpoint
          );

        return snapshot
          ? `${checkpoint} ч. — <b>${fmt(snapshot.views)}</b> просмотров`
          : `${checkpoint} ч. — ожидается`;
      }
    );

  const expectedViews =
    int(report.expected_min_views);

  const viewsCondition =
    expectedViews > 0
      ? (
          int(report.current_views) >=
          expectedViews
            ? `✅ Минимум просмотров выполнен: ${fmt(report.current_views)} из ${fmt(expectedViews)}`
            : `⚠️ Минимум просмотров: ${fmt(report.current_views)} из ${fmt(expectedViews)}`
        )
      : 'ℹ️ Минимум просмотров не задан';

  const durationCondition =
    progress >= 100 &&
    !report.deleted_at
      ? `✅ Срок ${int(report.duration_hours, 24)} ч. выполнен`
      : report.deleted_at
        ? '❌ Пост удалён до завершения проверки'
        : `🟢 Размещение продолжается: ${remainingText(report)}`;

  const riskLabel =
    int(report.risk_score) >= 40
      ? 'высокий'
      : int(report.risk_score) >= 15
        ? 'средний'
        : 'низкий';

  return [
    `🧾 <b>LinkRay Proof · ${esc(
      report.report_code ||
      `LR-RPT-${report.id}`
    )}</b>`,
    '',
    reportChannelHtml(report),
    `Пост: <b>${esc(reportTitle(report))}</b>`,
    '',
    `${icon} Статус: <b>${status}</b>`,
    `Опубликован: ${moscowDate(report.published_at)}`,
    `Срок размещения: <b>${int(report.duration_hours, 24)} ч.</b>`,
    '',
    `Прогресс: <b>${progressBar(progress)} ${percent(progress)}</b>`,
    `Осталось: <b>${remainingText(report)}</b>`,
    '',
    `👁 Просмотры: <b>${fmt(report.current_views)}</b>`,
    `👥 Подписчиков до выхода: <b>${fmt(report.start_subscribers)}</b>`,
    `➕ Подписалось: <b>${fmt(report.joined_count)}</b>`,
    `➖ Отписалось: <b>${fmt(report.left_count)}</b>`,
    `📈 Чистый прирост: <b>${int(report.net_subscribers) >= 0 ? '+' : ''}${fmt(report.net_subscribers)}</b>`,
    '',
    `💰 Стоимость: <b>${money(estimatedCost(report))}</b>`,
    `📊 CPM: <b>${money(actualCpm(report))}</b>`,
    `🛡 Антифрод-риск: <b>${riskLabel} · ${percent(report.risk_score)}</b>`,
    `⭐ Оценка размещения: <b>${int(report.score)}/100</b>`,
    '',
    '<b>Контрольные замеры</b>',
    ...checkpointLines,
    '',
    '<b>Проверка условий</b>',
    durationCondition,
    viewsCondition,
    '',
    `<b>Заключение LinkRay</b>`,
    esc(
      report.conclusion ||
      'Данные ещё собираются.'
    ),
    '',
    '✅ Данные отчёта формируются автоматически и не редактируются вручную.',
  ].join('\n');
}

async function showReport(
  update,
  reportId,
  notice = ''
) {
  await syncReports({
    limit: 20,
  }).catch(() => {});

  const report =
    await loadAccessibleReport(
      update,
      reportId
    );

  if (!report) {
    await respond(
      update,
      '⚠️ Отчёт не найден или у вас нет доступа.',
      [[
        callbackButton(
          '⬅️ К отчётам',
          'reports:menu'
        ),
      ]]
    );

    return;
  }

  const snapshots =
    await reportSnapshots(
      report.id
    );

  const text = [
    notice,
    reportDetailText(
      report,
      snapshots
    ),
  ].filter(Boolean).join('\n\n');

  const buttons = [
    [
      linkButton(
        '🌐 Веб-отчёт',
        reportPublicUrl(report)
      ),

      linkButton(
        '🖼 PNG-карточка',
        reportCardUrl(report)
      ),
    ],
    [
      callbackButton(
        '⚖️ Условия',
        `proof:terms:${report.id}`
      ),

      callbackButton(
        '💳 Оплата',
        `proof:payment:${report.id}`
      ),
    ],
    [
      callbackButton(
        '🔄 Обновить',
        `proof:open:${report.id}`
      ),

      callbackButton(
        report.archived_at
          ? '📤 Вернуть из архива'
          : '🗂 В архив',

        `proof:archive:${report.id}`
      ),
    ],
    [
      callbackButton(
        '⬅️ К отчётам',
        'reports:menu'
      ),
    ],
  ];

  await respond(
    update,
    text,
    buttons
  );
}

async function listReports(
  update,
  mode
) {
  await syncReports({
    limit: 30,
  }).catch(() => {});

  const context =
    await accessContext(update);

  const access =
    accessSql(context);

  const statusWhere = {
    active:
      `report.archived_at IS NULL AND report.status IN ('collecting','active')`,

    ready:
      `report.archived_at IS NULL AND report.status='completed'`,

    attention:
      `report.archived_at IS NULL AND report.status IN ('attention','violated')`,

    archive:
      `report.archived_at IS NOT NULL`,
  }[mode] || 'true';

  const list = await safeQuery(`
    SELECT *

    FROM public.lr_proof_reports report

    WHERE ${access.where}
      AND ${statusWhere}

    ORDER BY
      report.updated_at DESC,
      report.id DESC

    LIMIT 20
  `, access.params);

  const titles = {
    active: '🟢 Активные размещения',
    ready: '✅ Готовые отчёты',
    attention: '⚠️ Требуют внимания',
    archive: '🗂 Архив отчётов',
  };

  const buttonRows = list.map(
    (report) => {
      const [icon] =
        statusMeta(report.status);

      return [
        callbackButton(
          `${icon} ${report.report_code || `LR-RPT-${report.id}`} · ${short(report.channel_title, 18)} · ${fmt(report.current_views)}`,
          `proof:open:${report.id}`
        ),
      ];
    }
  );

  if (!buttonRows.length) {
    buttonRows.push([
      callbackButton(
        'Отчётов пока нет',
        'noop'
      ),
    ]);
  }

  buttonRows.push([
    callbackButton(
      '⬅️ К отчётам',
      'reports:menu'
    ),
  ]);

  await respond(
    update,
    [
      `<b>${titles[mode] || 'Отчёты'}</b>`,
      '',
      `Найдено: <b>${list.length}</b>`,
      '',
      list.length
        ? 'Выберите отчёт.'
        : 'Подходящих отчётов пока нет.',
    ].join('\n'),
    buttonRows
  );
}

async function campaignList(update) {
  await importAdPosts();

  const context =
    await accessContext(update);

  const access =
    accessSql(context);

  const list = await safeQuery(`
    SELECT
      report.source_group_id,

      COALESCE(
        campaign.title,
        MAX(report.post_text),
        'Рекламная кампания'
      ) AS title,

      COUNT(*)::integer AS reports_count,

      SUM(report.current_views)::bigint
        AS total_views,

      SUM(report.net_subscribers)::bigint
        AS total_net,

      SUM(
        COALESCE(
          report.agreed_cost,
          (
            report.current_views::numeric /
            1000 *
            report.cpm
          ),
          0
        )
      ) AS total_cost,

      ROUND(
        AVG(report.score)
      )::integer AS score

    FROM public.lr_proof_reports report

    LEFT JOIN public.lr_proof_campaigns campaign
      ON campaign.source_group_id=
         report.source_group_id

    WHERE ${access.where}
      AND report.archived_at IS NULL

    GROUP BY
      report.source_group_id,
      campaign.title

    ORDER BY
      MAX(report.published_at) DESC

    LIMIT 20
  `, access.params);

  const buttons = list.map(
    (campaign) => [
      callbackButton(
        `📦 ${short(campaign.title, 25)} · ${int(campaign.reports_count)} кан.`,
        `proof:campaign:${encodeURIComponent(
          campaign.source_group_id
        )}`
      ),
    ]
  );

  if (!buttons.length) {
    buttons.push([
      callbackButton(
        'Кампаний пока нет',
        'noop'
      ),
    ]);
  }

  buttons.push([
    callbackButton(
      '⬅️ К отчётам',
      'reports:menu'
    ),
  ]);

  await respond(
    update,
    [
      '📦 <b>Рекламные кампании</b>',
      '',
      'Несколько размещений одного рекламного выхода объединяются автоматически.',
      '',
      `Кампаний: <b>${list.length}</b>`,
    ].join('\n'),
    buttons
  );
}

async function showCampaign(
  update,
  sourceGroupId
) {
  const context =
    await accessContext(update);

  const access =
    accessSql(context);

  const list = await safeQuery(`
    SELECT *

    FROM public.lr_proof_reports report

    WHERE ${access.where}
      AND report.source_group_id=$${access.params.length + 1}

    ORDER BY
      report.current_views DESC,
      report.id
  `, [
    ...access.params,
    sourceGroupId,
  ]);

  if (!list.length) {
    await respond(
      update,
      '⚠️ Кампания не найдена.',
      [[
        callbackButton(
          '⬅️ К кампаниям',
          'proof:campaigns'
        ),
      ]]
    );

    return;
  }

  const totalViews =
    list.reduce(
      (sum, item) =>
        sum + int(item.current_views),
      0
    );

  const totalNet =
    list.reduce(
      (sum, item) =>
        sum + int(item.net_subscribers),
      0
    );

  const totalCost =
    list.reduce(
      (sum, item) =>
        sum + estimatedCost(item),
      0
    );

  const avgScore =
    Math.round(
      list.reduce(
        (sum, item) =>
          sum + int(item.score),
        0
      ) /
      Math.max(1, list.length)
    );

  const ranked = list.map(
    (item, index) =>
      `${index + 1}. ${esc(short(item.channel_title, 28))} — ${fmt(item.current_views)} просмотров · ${int(item.net_subscribers) >= 0 ? '+' : ''}${fmt(item.net_subscribers)} ПДП`
  );

  const buttons = list.map(
    (item) => [
      callbackButton(
        `📊 ${short(item.channel_title, 28)}`,
        `proof:open:${item.id}`
      ),
    ]
  );

  buttons.push([
    callbackButton(
      '⬅️ К кампаниям',
      'proof:campaigns'
    ),
  ]);

  await respond(
    update,
    [
      `📦 <b>${esc(short(list[0].post_text, 60))}</b>`,
      '',
      `Каналов: <b>${list.length}</b>`,
      `Просмотры: <b>${fmt(totalViews)}</b>`,
      `Чистый прирост: <b>${totalNet >= 0 ? '+' : ''}${fmt(totalNet)}</b>`,
      `Бюджет: <b>${money(totalCost)}</b>`,
      `Средняя оценка: <b>${avgScore}/100</b>`,
      '',
      '<b>Рейтинг каналов</b>',
      ...ranked,
    ].join('\n'),
    buttons
  );
}

async function menu(update) {
  await syncReports({
    limit: 30,
  }).catch((error) => {
    console.error(
      '[LinkRay Proof menu sync]',
      error?.message || error
    );
  });

  const context =
    await accessContext(update);

  const access =
    accessSql(context);

  const stats = (
    await safeQuery(`
      SELECT
        COUNT(*) FILTER (
          WHERE report.archived_at IS NULL
            AND report.status IN (
              'collecting',
              'active'
            )
        )::integer AS active,

        COUNT(*) FILTER (
          WHERE report.archived_at IS NULL
            AND report.status='completed'
        )::integer AS ready,

        COUNT(*) FILTER (
          WHERE report.archived_at IS NULL
            AND report.status IN (
              'attention',
              'violated'
            )
        )::integer AS attention,

        COUNT(*) FILTER (
          WHERE report.archived_at IS NOT NULL
        )::integer AS archived,

        COUNT(
          DISTINCT report.source_group_id
        )::integer AS campaigns

      FROM public.lr_proof_reports report

      WHERE ${access.where}
    `, access.params)
  )[0] || {};

  await respond(
    update,
    [
      '📈 <b>Отчёты LinkRay</b>',
      '',
      '<b>LinkRay Proof — подтверждённые результаты размещений</b>',
      '',
      `🟢 Активных размещений: <b>${fmt(stats.active)}</b>`,
      `✅ Готовых отчётов: <b>${fmt(stats.ready)}</b>`,
      `⚠️ Требуют внимания: <b>${fmt(stats.attention)}</b>`,
      `📦 Рекламных кампаний: <b>${fmt(stats.campaigns)}</b>`,
      '',
      'Каждый рекламный выход получает уникальный паспорт, контрольные замеры и проверку условий.',
    ].join('\n'),
    [
      [
        callbackButton(
          '🟢 Активные',
          'proof:list:active'
        ),

        callbackButton(
          '✅ Готовые',
          'proof:list:ready'
        ),
      ],
      [
        callbackButton(
          '📦 Кампании',
          'proof:campaigns'
        ),

        callbackButton(
          '⚠️ Требуют внимания',
          'proof:list:attention'
        ),
      ],
      [
        callbackButton(
          '🗂 Архив',
          'proof:list:archive'
        ),

        callbackButton(
          '🔄 Обновить',
          'reports:menu'
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

async function termsPrompt(
  update,
  reportId
) {
  const report =
    await loadAccessibleReport(
      update,
      reportId
    );

  if (!report) {
    return;
  }

  const maxUserId =
    updateUserId(update);

  await setSession(
    maxUserId,
    'proof_terms_wait',
    {
      report_id:
        Number(report.id),
    }
  );

  await respond(
    update,
    [
      '⚖️ <b>Условия размещения</b>',
      '',
      'Отправьте три строки:',
      '',
      '<code>24</code> — срок размещения в часах',
      '<code>5000</code> — минимум просмотров',
      '<code>4000</code> — согласованная стоимость в рублях',
      '',
      'Пример:',
      '<code>24\n5000\n4000</code>',
    ].join('\n'),
    [[
      callbackButton(
        '❌ Отмена',
        `proof:open:${report.id}`
      ),
    ]]
  );
}

async function saveTerms(
  update,
  session
) {
  const maxUserId =
    updateUserId(update);

  const reportId =
    Number(
      session?.data?.report_id
    );

  const report =
    await loadAccessibleReport(
      update,
      reportId
    );

  if (!report) {
    await clearSession(maxUserId);
    return false;
  }

  const values = updateText(update)
    .split(/\r?\n/)
    .map(
      (item) =>
        item
          .replace(/\s+/g, '')
          .replace(',', '.')
    )
    .filter(Boolean)
    .map(Number);

  if (
    values.length < 3 ||
    !values
      .slice(0, 3)
      .every(
        (value) =>
          Number.isFinite(value) &&
          value >= 0
      )
  ) {
    await respond(
      update,
      [
        '⚠️ Не удалось распознать условия.',
        '',
        'Отправьте три числа отдельными строками:',
        '<code>24\n5000\n4000</code>',
      ].join('\n'),
      [[
        callbackButton(
          '❌ Отмена',
          `proof:open:${report.id}`
        ),
      ]]
    );

    return true;
  }

  const [
    durationHours,
    expectedMinViews,
    agreedCost,
  ] = values;

  const published =
    report.published_at
      ? new Date(report.published_at)
      : new Date();

  const finish =
    new Date(
      published.getTime() +
      Math.max(1, durationHours) *
      3600_000
    );

  await query(`
    UPDATE public.lr_proof_reports

    SET
      duration_hours=$2,
      expected_min_views=NULLIF($3, 0),
      agreed_cost=NULLIF($4, 0),
      expected_finish_at=$5,

      conditions=
        COALESCE(
          conditions,
          '{}'::jsonb
        ) ||
        jsonb_build_object(
          'duration_hours',
          $2,
          'expected_min_views',
          $3,
          'agreed_cost',
          $4,
          'updated_at',
          now()
        ),

      updated_at=now()

    WHERE id=$1
  `, [
    Number(report.id),
    Math.max(
      1,
      int(durationHours)
    ),
    Math.max(
      0,
      int(expectedMinViews)
    ),
    Math.max(
      0,
      num(agreedCost)
    ),
    finish.toISOString(),
  ]);

  await clearSession(maxUserId);

  await showReport(
    update,
    report.id,
    '✅ Условия размещения сохранены.'
  );

  return true;
}

async function archiveReport(
  update,
  reportId
) {
  const report =
    await loadAccessibleReport(
      update,
      reportId
    );

  if (!report) {
    return;
  }

  const archived =
    !report.archived_at;

  await query(`
    UPDATE public.lr_proof_reports

    SET
      archived_at=CASE
        WHEN $2
        THEN now()
        ELSE NULL
      END,

      status=CASE
        WHEN $2
        THEN 'archived'
        ELSE CASE
          WHEN completed_at IS NOT NULL
          THEN 'completed'
          ELSE 'active'
        END
      END,

      updated_at=now()

    WHERE id=$1
  `, [
    Number(report.id),
    archived,
  ]);

  await showReport(
    update,
    report.id,
    archived
      ? '✅ Отчёт перенесён в архив.'
      : '✅ Отчёт возвращён из архива.'
  );
}

async function cyclePayment(
  update,
  reportId
) {
  const report =
    await loadAccessibleReport(
      update,
      reportId
    );

  if (!report) {
    return;
  }

  const states = [
    'unpaid',
    'partial',
    'paid',
    'dispute',
  ];

  const currentIndex =
    states.indexOf(
      clean(report.payment_status, 30)
    );

  const next =
    states[
      (
        currentIndex + 1
      ) % states.length
    ];

  await query(`
    UPDATE public.lr_proof_reports

    SET
      payment_status=$2,
      updated_at=now()

    WHERE id=$1
  `, [
    Number(report.id),
    next,
  ]);

  const labels = {
    unpaid: 'не оплачено',
    partial: 'частично оплачено',
    paid: 'оплачено полностью',
    dispute: 'возник спор',
  };

  await showReport(
    update,
    report.id,
    `💳 Статус оплаты: <b>${labels[next]}</b>.`
  );
}

async function handleCallback(
  update,
  payload
) {
  if (payload === 'reports:menu') {
    await menu(update);
    return true;
  }

  if (
    payload.startsWith(
      'report:open:'
    )
  ) {
    const groupId =
      payload.slice(
        'report:open:'.length
      );

    const report = (
      await safeQuery(`
        SELECT id

        FROM public.lr_proof_reports

        WHERE source_group_id=$1
           OR source_post_id::text=$1

        ORDER BY id
        LIMIT 1
      `, [groupId])
    )[0];

    if (report?.id) {
      await showReport(
        update,
        report.id
      );
    } else {
      await menu(update);
    }

    return true;
  }

  let match =
    payload.match(
      /^proof:list:(active|ready|attention|archive)$/
    );

  if (match) {
    await listReports(
      update,
      match[1]
    );

    return true;
  }

  if (payload === 'proof:campaigns') {
    await campaignList(update);
    return true;
  }

  match =
    payload.match(
      /^proof:campaign:(.+)$/
    );

  if (match) {
    let groupId = match[1];

    try {
      groupId =
        decodeURIComponent(groupId);
    } catch {}

    await showCampaign(
      update,
      groupId
    );

    return true;
  }

  match =
    payload.match(
      /^proof:open:(\d+)$/
    );

  if (match) {
    await showReport(
      update,
      Number(match[1])
    );

    return true;
  }

  match =
    payload.match(
      /^proof:terms:(\d+)$/
    );

  if (match) {
    await termsPrompt(
      update,
      Number(match[1])
    );

    return true;
  }

  match =
    payload.match(
      /^proof:archive:(\d+)$/
    );

  if (match) {
    await archiveReport(
      update,
      Number(match[1])
    );

    return true;
  }

  match =
    payload.match(
      /^proof:payment:(\d+)$/
    );

  if (match) {
    await cyclePayment(
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
    'proof_terms_wait'
  ) {
    return saveTerms(
      update,
      session
    );
  }

  return false;
}

async function publicReport(token) {
  return (
    await safeQuery(`
      SELECT *

      FROM public.lr_proof_reports

      WHERE share_token=$1
      LIMIT 1
    `, [token])
  )[0] || null;
}

function publicHtml(
  report,
  snapshots
) {
  const [icon, status] =
    statusMeta(report.status);

  const progress =
    progressValue(report);

  const points =
    snapshots.map(
      (item) => ({
        x:
          int(item.checkpoint_hours),

        y:
          int(item.views),
      })
    );

  const maxViews = Math.max(
    1,
    ...points.map(
      (item) => item.y
    )
  );

  const chartPoints =
    points.map(
      (item) => {
        const x =
          30 +
          (
            item.x / 72
          ) * 840;

        const y =
          250 -
          (
            item.y /
            maxViews
          ) * 190;

        return `${x},${y}`;
      }
    ).join(' ');

  const checkpointRows =
    CHECKPOINTS.map(
      (checkpoint) => {
        const item =
          snapshots.find(
            (snapshot) =>
              int(
                snapshot.checkpoint_hours
              ) === checkpoint
          );

        return `
          <div class="checkpoint">
            <span>${checkpoint} ч.</span>
            <strong>${item ? fmt(item.views) : 'ожидается'}</strong>
          </div>
        `;
      }
    ).join('');

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(report.report_code)} · LinkRay Proof</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #071018;
      --card: rgba(18, 33, 45, .88);
      --line: rgba(255,255,255,.09);
      --text: #f4f8fb;
      --muted: #93a9b8;
      --accent: #37d6a3;
      --warn: #ffca61;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 85% 10%, rgba(55,214,163,.16), transparent 34%),
        radial-gradient(circle at 5% 90%, rgba(58,130,246,.16), transparent 35%),
        var(--bg);
      color: var(--text);
      font: 16px/1.45 Inter, system-ui, -apple-system, Segoe UI, sans-serif;
    }
    .wrap { width: min(1080px, calc(100% - 28px)); margin: 28px auto 60px; }
    .head, .card {
      border: 1px solid var(--line);
      background: var(--card);
      backdrop-filter: blur(18px);
      border-radius: 24px;
      box-shadow: 0 24px 70px rgba(0,0,0,.24);
    }
    .head { padding: 26px; display: flex; justify-content: space-between; gap: 20px; align-items: center; }
    .brand { font-size: 24px; font-weight: 800; letter-spacing: -.03em; }
    .brand span { color: var(--accent); }
    .proof { color: var(--muted); margin-top: 5px; }
    .status { padding: 10px 14px; border-radius: 999px; background: rgba(55,214,163,.11); border: 1px solid rgba(55,214,163,.26); white-space: nowrap; }
    .grid { display: grid; grid-template-columns: repeat(12,1fr); gap: 16px; margin-top: 16px; }
    .card { padding: 22px; }
    .main { grid-column: span 8; }
    .side { grid-column: span 4; }
    .full { grid-column: 1 / -1; }
    h1 { margin: 0 0 8px; font-size: clamp(25px,4vw,42px); line-height: 1.1; letter-spacing: -.04em; }
    h2 { margin: 0 0 18px; font-size: 20px; }
    .muted { color: var(--muted); }
    .channel { color: var(--accent); text-decoration: none; }
    .metrics { display: grid; grid-template-columns: repeat(2,1fr); gap: 12px; margin-top: 22px; }
    .metric { padding: 16px; border-radius: 17px; background: rgba(255,255,255,.035); border: 1px solid var(--line); }
    .metric span { display:block; color:var(--muted); font-size:13px; }
    .metric strong { display:block; margin-top:5px; font-size:25px; }
    .bar { height: 12px; border-radius: 999px; overflow:hidden; background:rgba(255,255,255,.07); margin: 12px 0 6px; }
    .bar i { display:block; height:100%; width:${progress}%; background:linear-gradient(90deg,#37d6a3,#4fb8ff); }
    .condition { padding: 13px 0; border-bottom: 1px solid var(--line); }
    .condition:last-child { border-bottom: 0; }
    .checkpoints { display:grid; grid-template-columns:repeat(6,1fr); gap:10px; }
    .checkpoint { padding:13px; border-radius:15px; background:rgba(255,255,255,.035); border:1px solid var(--line); }
    .checkpoint span, .checkpoint strong { display:block; }
    .checkpoint span { color:var(--muted); font-size:13px; }
    .checkpoint strong { margin-top:5px; }
    svg { width:100%; height:auto; overflow:visible; }
    footer { margin-top:20px; color:var(--muted); text-align:center; font-size:13px; }
    @media (max-width: 800px) {
      .head { align-items:flex-start; flex-direction:column; }
      .main,.side { grid-column:1/-1; }
      .checkpoints { grid-template-columns:repeat(2,1fr); }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="head">
      <div>
        <div class="brand">LinkRay <span>Proof</span></div>
        <div class="proof">${esc(report.report_code)} · подтверждённый паспорт размещения</div>
      </div>
      <div class="status">${icon} ${status}</div>
    </section>

    <section class="grid">
      <article class="card main">
        <a class="channel" href="${attr(report.channel_link || '#')}">${esc(report.channel_title || 'Канал MAX')}</a>
        <h1>${esc(reportTitle(report))}</h1>
        <div class="muted">Опубликовано ${moscowDate(report.published_at)}</div>

        <div class="bar"><i></i></div>
        <div class="muted">Размещение ${progress}% · ${esc(remainingText(report))}</div>

        <div class="metrics">
          <div class="metric"><span>Просмотры</span><strong>${fmt(report.current_views)}</strong></div>
          <div class="metric"><span>Чистый прирост</span><strong>${int(report.net_subscribers) >= 0 ? '+' : ''}${fmt(report.net_subscribers)}</strong></div>
          <div class="metric"><span>Стоимость</span><strong>${money(estimatedCost(report))}</strong></div>
          <div class="metric"><span>Оценка LinkRay</span><strong>${int(report.score)}/100</strong></div>
        </div>
      </article>

      <aside class="card side">
        <h2>Проверка условий</h2>
        <div class="condition">Срок: <strong>${int(report.duration_hours, 24)} ч.</strong></div>
        <div class="condition">Минимум просмотров: <strong>${report.expected_min_views ? fmt(report.expected_min_views) : 'не задан'}</strong></div>
        <div class="condition">CPM: <strong>${money(actualCpm(report))}</strong></div>
        <div class="condition">Антифрод-риск: <strong>${percent(report.risk_score)}</strong></div>
        <div class="condition">Оплата: <strong>${esc(report.payment_status)}</strong></div>
      </aside>

      <article class="card full">
        <h2>Динамика просмотров</h2>
        <svg viewBox="0 0 900 280" role="img" aria-label="График просмотров">
          <line x1="30" y1="250" x2="870" y2="250" stroke="rgba(255,255,255,.12)"/>
          <polyline points="${chartPoints}" fill="none" stroke="#37d6a3" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
          ${points.map((item) => {
            const x = 30 + (item.x / 72) * 840;
            const y = 250 - (item.y / maxViews) * 190;
            return `<circle cx="${x}" cy="${y}" r="6" fill="#071018" stroke="#37d6a3" stroke-width="4"><title>${item.x} ч. — ${fmt(item.y)} просмотров</title></circle>`;
          }).join('')}
        </svg>
        <div class="checkpoints">${checkpointRows}</div>
      </article>

      <article class="card full">
        <h2>Заключение LinkRay</h2>
        <div>${esc(report.conclusion || 'Данные ещё собираются.')}</div>
      </article>
    </section>

    <footer>
      Данные сформированы автоматически · ${moscowDate(report.updated_at)} ·
      <a class="channel" href="${attr(BOT_LINK)}">Перейти в LinkRay</a>
    </footer>
  </main>
</body>
</html>`;
}

function cardSvg(report) {
  const [icon, status] =
    statusMeta(report.status);

  const riskLabel =
    int(report.risk_score) >= 40
      ? 'Высокий'
      : int(report.risk_score) >= 15
        ? 'Средний'
        : 'Низкий';

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#071018"/>
        <stop offset="1" stop-color="#123243"/>
      </linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#37d6a3"/>
        <stop offset="1" stop-color="#50b8ff"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="630" rx="34" fill="url(#bg)"/>
    <circle cx="1080" cy="80" r="210" fill="#37d6a3" opacity=".08"/>
    <circle cx="90" cy="610" r="250" fill="#3983f5" opacity=".08"/>

    <text x="70" y="82" font-family="Arial,sans-serif" font-size="30" font-weight="700" fill="#f4f8fb">LinkRay <tspan fill="#37d6a3">Proof</tspan></text>
    <text x="70" y="120" font-family="Arial,sans-serif" font-size="18" fill="#93a9b8">${esc(report.report_code)}</text>

    <text x="70" y="194" font-family="Arial,sans-serif" font-size="22" fill="#37d6a3">${esc(short(report.channel_title, 48))}</text>
    <text x="70" y="245" font-family="Arial,sans-serif" font-size="37" font-weight="700" fill="#f4f8fb">${esc(short(report.post_text, 48))}</text>

    <rect x="70" y="285" width="1060" height="1" fill="#ffffff" opacity=".1"/>

    <text x="70" y="342" font-family="Arial,sans-serif" font-size="17" fill="#93a9b8">ПРОСМОТРЫ</text>
    <text x="70" y="397" font-family="Arial,sans-serif" font-size="46" font-weight="700" fill="#f4f8fb">${fmt(report.current_views)}</text>

    <text x="355" y="342" font-family="Arial,sans-serif" font-size="17" fill="#93a9b8">ЧИСТЫЙ ПРИРОСТ</text>
    <text x="355" y="397" font-family="Arial,sans-serif" font-size="46" font-weight="700" fill="#f4f8fb">${int(report.net_subscribers) >= 0 ? '+' : ''}${fmt(report.net_subscribers)}</text>

    <text x="690" y="342" font-family="Arial,sans-serif" font-size="17" fill="#93a9b8">CPM</text>
    <text x="690" y="397" font-family="Arial,sans-serif" font-size="46" font-weight="700" fill="#f4f8fb">${esc(money(actualCpm(report)))}</text>

    <text x="940" y="342" font-family="Arial,sans-serif" font-size="17" fill="#93a9b8">ОЦЕНКА</text>
    <text x="940" y="397" font-family="Arial,sans-serif" font-size="46" font-weight="700" fill="#f4f8fb">${int(report.score)}/100</text>

    <rect x="70" y="454" width="1060" height="94" rx="22" fill="#ffffff" opacity=".045"/>
    <text x="98" y="494" font-family="Arial,sans-serif" font-size="19" fill="#f4f8fb">${esc(icon)} ${esc(status)}</text>
    <text x="98" y="527" font-family="Arial,sans-serif" font-size="17" fill="#93a9b8">Антифрод: ${esc(riskLabel)} · Срок: ${int(report.duration_hours, 24)} ч. · Проверено LinkRay</text>

    <rect x="70" y="577" width="1060" height="8" rx="4" fill="#ffffff" opacity=".08"/>
    <rect x="70" y="577" width="${Math.round(1060 * progressValue(report) / 100)}" height="8" rx="4" fill="url(#accent)"/>
  </svg>`;
}

function mountPublicRoutes(app) {
  app.get(
    '/proof/:token',
    async (req, res) => {
      try {
        await ensureSchema();

        const report =
          await publicReport(
            clean(req.params.token, 100)
          );

        if (!report) {
          return res
            .status(404)
            .type('html')
            .send(
              '<h1>Отчёт не найден</h1>'
            );
        }

        const snapshots =
          await reportSnapshots(
            report.id
          );

        return res
          .type('html')
          .send(
            publicHtml(
              report,
              snapshots
            )
          );
      } catch (error) {
        console.error(
          '[LinkRay Proof public]',
          error?.stack ||
          error?.message ||
          error
        );

        return res
          .status(500)
          .type('html')
          .send(
            '<h1>Временная ошибка отчёта</h1>'
          );
      }
    }
  );

  app.get(
    '/proof/:token/card.png',
    async (req, res) => {
      try {
        await ensureSchema();

        const report =
          await publicReport(
            clean(req.params.token, 100)
          );

        if (!report) {
          return res
            .status(404)
            .send('Not found');
        }

        const png =
          await sharp(
            Buffer.from(
              cardSvg(report)
            )
          )
            .png()
            .toBuffer();

        res.setHeader(
          'Cache-Control',
          'public, max-age=300'
        );

        return res
          .type('png')
          .send(png);
      } catch (error) {
        console.error(
          '[LinkRay Proof PNG]',
          error?.stack ||
          error?.message ||
          error
        );

        return res
          .status(500)
          .send('PNG generation failed');
      }
    }
  );

  app.get(
    '/proof/:token/data.json',
    async (req, res) => {
      await ensureSchema();

      const report =
        await publicReport(
          clean(req.params.token, 100)
        );

      if (!report) {
        return res
          .status(404)
          .json({
            ok: false,
          });
      }

      const snapshots =
        await reportSnapshots(
          report.id
        );

      return res.json({
        ok: true,
        report,
        snapshots,
      });
    }
  );
}

export async function
linkRayProofSmokeTest() {
  await ensureSchema();

  const tables = await safeQuery(`
    SELECT
      to_regclass(
        'public.lr_proof_reports'
      ) AS reports,

      to_regclass(
        'public.lr_proof_snapshots'
      ) AS snapshots,

      to_regclass(
        'public.lr_proof_sessions'
      ) AS sessions,

      to_regclass(
        'public.lr_proof_campaigns'
      ) AS campaigns
  `);

  const imported =
    await importAdPosts();

  return {
    tables: tables[0] || {},
    imported,
    publicBaseUrl:
      PUBLIC_BASE_URL,
  };
}

export function
installLinkRayProofReports(app) {
  if (installed) {
    return;
  }

  installed = true;

  mountPublicRoutes(app);

  app.use(
    async function linkRayProofMiddleware(
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

        const session =
          await getSession(
            updateUserId(update)
          );

        if (
          payload &&
          (
            payload === 'reports:menu' ||
            payload.startsWith('proof:') ||
            payload.startsWith('report:open:')
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
                  'linkray_proof_callback',
              });
            }

            return;
          }
        }

        if (
          session.state ===
          'proof_terms_wait'
        ) {
          const handled =
            await handleMessage(update);

          if (handled) {
            if (!res.headersSent) {
              return res.json({
                ok: true,
                handled:
                  'linkray_proof_input',
              });
            }

            return;
          }
        }

        return next();
      } catch (error) {
        console.error(
          '[LinkRay Proof middleware]',
          error?.stack ||
          error?.message ||
          error
        );

        return next();
      }
    }
  );

  ensureSchema()
    .then(() => syncReports({
      limit: 30,
    }))
    .catch((error) => {
      console.error(
        '[LinkRay Proof startup]',
        error?.stack ||
        error?.message ||
        error
      );
    });

  if (!syncTimer) {
    syncTimer = setInterval(
      () => {
        syncReports({
          limit: 40,
        }).catch((error) => {
          console.error(
            '[LinkRay Proof interval]',
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
    '[LinkRay Proof] installed',
    JSON.stringify({
      intervalMs:
        SYNC_INTERVAL_MS,

      publicBaseUrl:
        PUBLIC_BASE_URL,
    })
  );
}

export {
  importAdPosts,
  syncReports,
};

