import { query } from './db.js';

const BOT_LINK = process.env.BOT_LINK || 'https://max.ru/se13353901_bot';
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.BASE_URL ||
  process.env.SITE_URL ||
  'https://linkray.ru';

let started = false;

function rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(value) {
  return esc(value).replace(/'/g, '&#39;');
}

function plain(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|blockquote|h1|h2|h3)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function short(value, max = 46) {
  const text = plain(value);
  if (!text) return 'рекламный пост';
  return text.length > max ? text.slice(0, max).trim() + '…' : text;
}

function safeJson(value, fallback = {}) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function number(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('ru-RU').format(Number.isFinite(n) ? Math.round(n) : 0);
}

function money0(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0) + '₽';
}

function money2(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0) + '₽';
}

function moscowDate(value) {
  try {
    const d = value ? new Date(value) : new Date();
    const parts = d.toLocaleDateString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: 'numeric',
      month: 'long',
      weekday: 'short',
    });
    const time = d.toLocaleTimeString('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${parts} ${time}`;
  } catch {
    return '—';
  }
}

async function tableColumns(table) {
  const result = await query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name=$1`,
    [table]
  ).catch(() => []);

  return new Set(rows(result).map((r) => String(r.column_name)));
}

function qident(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

async function ensureColumns() {
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_24h_sent_at timestamptz`).catch(() => {});
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_24h_views integer`).catch(() => {});
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_24h_cost numeric`).catch(() => {});
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_24h_snapshot jsonb`).catch(() => {});
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return 0;
}

function snapshotViews(snapshot) {
  const s = safeJson(snapshot, {});
  return firstNumber(
    s.views24h,
    s.views_24h,
    s.maxViews24h,
    s.totalViews24h,
    s.views,
    s.maxViews,
    s.totalViews,
    s.view_count,
    s.views_count,
    s.stat?.views,
    s.stat?.view_count,
    s.maxStat?.views,
    s.maxStat?.view_count
  );
}

async function getViewsFromMax(post) {
  const messageId =
    post.published_message_id ||
    post.message_id ||
    post.max_message_id ||
    post.publishedMessageId ||
    '';

  if (!messageId) return 0;

  try {
    const mod = await import('./maxClient.js');

    const fn =
      mod.getMaxMessage ||
      mod.getMessage ||
      mod.getMessageInfo ||
      mod.fetchMessage ||
      mod.default?.getMaxMessage ||
      mod.default?.getMessage;

    if (!fn) return 0;

    const chatId =
      post.channel_id ||
      post.chat_id ||
      post.max_chat_id ||
      post.channelId ||
      post.chatId ||
      '';

    const attempts = [
      [messageId, { chatId }],
      [{ messageId, chatId }],
      [{ id: messageId, chatId }],
      [chatId, messageId],
      [messageId],
    ];

    for (const args of attempts) {
      try {
        const result = await fn(...args);
        const message = Array.isArray(result?.messages)
          ? result.messages[0]
          : (result?.message || result);

        const stat = message?.stat || result?.stat || message?.statistics || result?.statistics || {};

        const views = firstNumber(
          stat.views,
          stat.view_count,
          stat.views_count,
          stat.reads,
          stat.impressions,
          message?.views,
          message?.view_count,
          result?.views,
          result?.view_count
        );

        if (views > 0) return views;
      } catch {}
    }

    return 0;
  } catch (error) {
    console.error('[LinkRay 24h report max views]', error.message || error);
    return 0;
  }
}

async function loadChannelMap(posts) {
  const ids = [
    ...new Set(
      posts
        .map((p) => p.channel_id || p.chat_id || p.max_chat_id || p.channelId || p.chatId)
        .filter((x) => x !== null && x !== undefined && x !== '')
        .map(String)
    )
  ];

  const map = new Map();

  if (!ids.length) return map;

  const cols = await tableColumns('channels');
  if (!cols.size || !cols.has('id')) return map;

  const titleExpr = cols.has('title')
    ? `"title"::text`
    : cols.has('name')
      ? `"name"::text`
      : cols.has('channel_title')
        ? `"channel_title"::text`
        : `'Канал'::text`;

  const linkExpr = cols.has('link')
    ? `"link"::text`
    : cols.has('public_link')
      ? `"public_link"::text`
      : cols.has('invite_link')
        ? `"invite_link"::text`
        : cols.has('url')
          ? `"url"::text`
          : `''::text`;

  const candidateColumns = [
    'chat_id',
    'channel_id',
    'max_chat_id',
    'max_channel_id',
    'max_id',
    'external_id',
    'peer_id',
    'username',
    'handle',
  ].filter((col) => cols.has(col));

  const where = [`id::text = ANY($1)`];
  for (const col of candidateColumns) where.push(`${qident(col)}::text = ANY($1)`);

  const result = await query(
    `SELECT id::text AS id,
            ${titleExpr} AS title,
            ${linkExpr} AS link
       FROM channels
      WHERE ${where.join(' OR ')}`,
    [ids]
  ).catch((error) => {
    console.error('[LinkRay 24h report channels]', error.message || error);
    return [];
  });

  for (const row of rows(result)) {
    map.set(String(row.id), {
      title: row.title || 'Канал',
      link: row.link || '',
    });
  }

  return map;
}

function reportLink(groupId) {
  return `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/analytics/stats/${encodeURIComponent(groupId)}`;
}

function channelTitleHtml(channel) {
  const title = esc(channel.title || 'Канал');

  if (channel.link && /^https?:\/\//i.test(channel.link)) {
    return `<a href="${attr(channel.link)}">${title}</a>`;
  }

  return title;
}

function render24hReport(data) {
  const title = esc(short(data.title, 42));
  const published = esc(moscowDate(data.publishedAt));

  const channelLines = data.channels.map((channel, index) => {
    return `${index + 1}) <b>Канал:</b> ${channelTitleHtml(channel)}
👀 <b>Просмотры:</b> ${number(channel.views)}`;
  }).join('\n\n');

  return `📊 <b>Сводный отчёт по просмотрам</b> «${title}»

<b>Опубликовано:</b> ${published} (МСК)

👀 <b>Просмотры за 24ч:</b> ${number(data.totalViews24h)}
⏱ <b>Подсчёт:</b> 24ч
📣 <b>Каналы:</b> ${number(data.channels.length)}

💰 <b>CPM:</b> ${money0(data.cpm)}
💵 <b>Итоговая стоимость:</b> ${money2(data.cost)}
━━━━━━━━━━━━━━
📌 <b>Публикации:</b>

${channelLines || 'Публикаций пока нет'}

🔗 <b>Ссылка на отчёт:</b>
${esc(data.reportUrl)}
━━━━━━━━━━━━━━
✨ <a href="${attr(BOT_LINK)}">LinkRay</a> — автопостинг и аналитика рекламных размещений в MAX`;
}

async function sendMaxReport(chatId, text) {
  if (!chatId) return false;

  const mod = await import('./maxClient.js');

  const fn =
    mod.sendMaxMessage ||
    mod.sendMessage ||
    mod.sendText ||
    mod.default?.sendMaxMessage ||
    mod.default?.sendMessage;

  if (!fn) {
    console.error('[LinkRay 24h report] no send function in maxClient');
    return false;
  }

  const attempts = [
    [{ chatId, text, format: 'html' }],
    [{ chat_id: chatId, text, format: 'html' }],
    [chatId, text, { format: 'html' }],
    [chatId, text],
  ];

  for (const args of attempts) {
    try {
      await fn(...args);
      return true;
    } catch {}
  }

  return false;
}

function recipientFromPost(post) {
  const keys = [
    'report_chat_id',
    'owner_chat_id',
    'creator_chat_id',
    'created_by_chat_id',
    'user_chat_id',
    'admin_chat_id',
    'manager_chat_id',
    'buyer_chat_id',
  ];

  for (const key of keys) {
    const value = post[key];
    if (value !== null && value !== undefined && value !== '') return String(value);
  }

  return (
    process.env.REPORT_CHAT_ID ||
    process.env.REPORT_TEST_CHAT_ID ||
    process.env.ADMIN_CHAT_ID ||
    process.env.BOT_OWNER_ID ||
    ''
  );
}

async function findLatestUserChatId() {
  const env =
    process.env.REPORT_TEST_CHAT_ID ||
    process.env.REPORT_CHAT_ID ||
    process.env.ADMIN_CHAT_ID ||
    process.env.BOT_OWNER_ID ||
    '';

  if (env) return String(env);

  const cols = rows(await query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND column_name = ANY($1)`,
    [[
      'chat_id',
      'user_chat_id',
      'owner_chat_id',
      'creator_chat_id',
      'admin_chat_id',
      'manager_chat_id'
    ]]
  ).catch(() => []));

  const blocked = /(channel|scheduled|post|analytics|click|view|point|link)/i;
  const preferred = /(session|user|profile|admin|account|state)/i;

  cols.sort((a, b) => {
    const ap = preferred.test(a.table_name) ? 0 : 1;
    const bp = preferred.test(b.table_name) ? 0 : 1;
    return ap - bp;
  });

  for (const item of cols) {
    const table = String(item.table_name);
    const col = String(item.column_name);

    if (blocked.test(table)) continue;

    const tableCols = await tableColumns(table);
    const order = ['updated_at', 'last_seen_at', 'created_at', 'id']
      .filter((x) => tableCols.has(x))
      .map((x) => `${qident(x)} DESC NULLS LAST`)
      .join(', ');

    const result = await query(
      `SELECT ${qident(col)}::text AS chat_id
         FROM ${qident(table)}
        WHERE ${qident(col)} IS NOT NULL
          AND ${qident(col)}::text <> ''
        ${order ? `ORDER BY ${order}` : ''}
        LIMIT 5`
    ).catch(() => []);

    for (const row of rows(result)) {
      const id = String(row.chat_id || '').trim();
      if (id) return id;
    }
  }

  return '';
}

async function buildGroupReport(groupPosts, forcedGroupId = '') {
  const first = groupPosts[0] || {};
  const groupId = forcedGroupId || String(first.lr_group_id || first.report_group_id || first.campaign_id || first.id || 'report');
  const channelMap = await loadChannelMap(groupPosts);

  const title = first.text || safeJson(first.report_snapshot, {}).title || 'рекламный пост';
  const cpm = Number(first.cpm || safeJson(first.report_snapshot, {}).cpm || 0);
  const publishedAt = first.published_at || first.publish_at || first.created_at || new Date().toISOString();

  const channels = [];

  for (const post of groupPosts) {
    const current = await getViewsFromMax(post);
    const fallback = snapshotViews(post.report_snapshot);
    const views24h = current || fallback || 0;

    const channelId = String(post.channel_id || post.chat_id || post.max_chat_id || '');
    const info = channelMap.get(channelId) || {
      title: post.channel_title || post.title || 'Канал',
      link: post.channel_link || '',
    };

    channels.push({
      id: channelId,
      title: info.title || 'Канал',
      link: info.link || '',
      views: views24h,
    });
  }

  channels.sort((a, b) => b.views - a.views);

  const totalViews24h = channels.reduce((sum, c) => sum + Number(c.views || 0), 0);
  const cost = cpm > 0 ? (totalViews24h / 1000) * cpm : 0;

  return {
    groupId,
    title,
    cpm,
    publishedAt,
    totalViews24h,
    cost,
    channels,
    reportUrl: reportLink(groupId),
  };
}

async function markGroupSent(groupId, data) {
  await ensureColumns();

  const cols = await tableColumns('scheduled_posts');
  const groupExpr = cols.has('report_group_id')
    ? `COALESCE(report_group_id, id::text)`
    : `id::text`;

  await query(
    `UPDATE scheduled_posts
        SET report_24h_sent_at=now(),
            report_24h_views=$2,
            report_24h_cost=$3,
            report_24h_snapshot=$4::jsonb
      WHERE ${groupExpr}=$1`,
    [
      String(groupId),
      Math.round(Number(data.totalViews24h || 0)),
      Number(data.cost || 0),
      JSON.stringify(data),
    ]
  ).catch((error) => {
    console.error('[LinkRay 24h report mark sent]', error.message || error);
  });
}

async function dueGroups() {
  await ensureColumns();

  const cols = await tableColumns('scheduled_posts');

  const groupExpr = cols.has('report_group_id')
    ? `COALESCE(report_group_id, id::text)`
    : `id::text`;

  const publishedExpr = cols.has('published_at')
    ? `published_at`
    : cols.has('publish_at')
      ? `publish_at`
      : `created_at`;

  const isAdExpr = cols.has('is_ad')
    ? `COALESCE(is_ad,false)=true`
    : `true`;

  const statusExpr = cols.has('status')
    ? `AND COALESCE(status,'') NOT IN ('deleted','canceled','cancelled','draft')`
    : ``;

  const result = await query(
    `SELECT *, ${groupExpr} AS lr_group_id
       FROM scheduled_posts
      WHERE ${isAdExpr}
        AND ${publishedExpr} IS NOT NULL
        AND ${publishedExpr} <= now() - interval '24 hours'
        AND report_24h_sent_at IS NULL
        ${statusExpr}
      ORDER BY ${groupExpr}, id ASC
      LIMIT 100`
  ).catch((error) => {
    console.error('[LinkRay 24h report due]', error.message || error);
    return [];
  });

  const map = new Map();

  for (const post of rows(result)) {
    const key = String(post.lr_group_id || post.report_group_id || post.id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(post);
  }

  return map;
}

export async function sendDue24hReports() {
  const groups = await dueGroups();

  for (const [groupId, posts] of groups.entries()) {
    const data = await buildGroupReport(posts, groupId);
    const text = render24hReport(data);
    const target = recipientFromPost(posts[0]);

    if (!target) {
      console.error('[LinkRay 24h report] no recipient for group', groupId);
      continue;
    }

    const ok = await sendMaxReport(target, text);

    if (ok) {
      await markGroupSent(groupId, data);
      console.log('[LinkRay 24h report] sent', groupId, 'to', target);
    } else {
      console.error('[LinkRay 24h report] send failed', groupId, 'to', target);
    }
  }
}

export async function sendTest24hReport(chatId = '') {
  const target = chatId || await findLatestUserChatId();

  const data = {
    groupId: 'test-24h-report',
    title: '3 признака, что он уже думает о тебе',
    cpm: 1000,
    publishedAt: new Date(Date.now() - 24 * 3600000).toISOString(),
    totalViews24h: 1551,
    cost: 1551,
    reportUrl: reportLink('test-24h-report'),
    channels: [
      { title: 'Восточная мудрость | Дзен...', link: '', views: 419 },
      { title: 'Королева Себя | Психологи...', link: '', views: 392 },
      { title: 'Психология Женской Силы', link: '', views: 385 },
      { title: 'Психология Любви | Отноше...', link: '', views: 355 },
    ],
  };

  const text = render24hReport(data);

  if (!target) {
    console.log('NO_CHAT_ID_FOR_TEST_REPORT');
    console.log(text.replace(/<[^>]+>/g, ''));
    return false;
  }

  const ok = await sendMaxReport(target, text);
  console.log(ok ? `TEST_24H_REPORT_SENT_TO_${target}` : `TEST_24H_REPORT_SEND_FAILED_${target}`);
  return ok;
}

export function mountLinkRay24hReports() {
  if (started) return;
  started = true;

  setTimeout(() => sendDue24hReports().catch((e) => console.error('[LinkRay 24h report boot]', e)), 15000);
  setInterval(() => sendDue24hReports().catch((e) => console.error('[LinkRay 24h report interval]', e)), 60000);

  console.log('[LinkRay 24h report] mounted');
}
