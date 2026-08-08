#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/linkray

FILE="src/linkrayChannelAnalytics.js"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/linkray-backups/multi-analytics-v47-$STAMP"
mkdir -p "$BACKUP"

echo "[1/8] Обновляю main и делаю backup"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ОШИБКА: есть незавершённые изменения:"
  git status --short
  exit 2
fi
git fetch origin main --quiet
git pull --ff-only origin main
cp -a "$FILE" "$BACKUP/"

rollback() {
  code=$?
  echo
  echo "[ОТКАТ] Возвращаю прежнюю аналитику"
  cp -f "$BACKUP/$(basename "$FILE")" "$FILE" || true
  docker compose up -d --build app >/dev/null 2>&1 || true
  echo "Откат выполнен: $BACKUP"
  exit "$code"
}
trap rollback ERR

echo "[2/8] Применяю V47 к фактическому маршруту нескольких ссылок"

python3 - "$FILE" <<'PY'
from pathlib import Path
import re, sys

p = Path(sys.argv[1])
s = p.read_text(encoding="utf-8")

def sub_once(pattern, replacement, label):
    global s
    s2, count = re.subn(pattern, lambda _m: replacement, s, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"ОШИБКА: {label}: заменено {count} блоков")
    s = s2

# 1) Несколько ссылок получают тот же resolveChannel, что одиночный отчёт.
loader = r'''
async function lrV34LoadChannelsByLinks(links) {
  const channels = [];

  for (let i = 0; i < links.length; i++) {
    const link = lrV34NormLink(links[i]);
    const resolved = await resolveChannel(link, { _lrIndex: i });

    channels.push({
      ...resolved,
      link,
      title:
        resolved?.title ||
        resolved?.name ||
        resolved?.channel_title ||
        resolved?.channel_name ||
        `Канал ${i + 1}`,
      avatar_url:
        resolved?.avatar_url ||
        resolved?.avatarUrl ||
        resolved?.photo_url ||
        resolved?.image_url ||
        resolved?.icon_url ||
        resolved?.picture_url ||
        resolved?.avatar ||
        resolved?.photo ||
        '',
      subscribers: Number(resolved?.subscribers || 0),
      views24: Number(resolved?.views24 || 0),
      views48: Number(resolved?.views48 || 0),
      views72: Number(resolved?.views72 || 0),
      er24: Number(resolved?.er24 || 0),
      delta_day: Number(resolved?.delta_day || resolved?.deltaDay || 0),
      joined_24h: Number(resolved?.joined_24h || resolved?.joined24h || 0),
      left_24h: Number(resolved?.left_24h || resolved?.left24h || 0),
    });
  }

  return lrV19DedupeNetworkAvatars(channels);
}

'''.lstrip()

sub_once(
    r'async function lrV34LoadChannelsByLinks\(links\)\s*\{[\s\S]*?(?=/\* LR_SAFE_NETWORK_CARD_V37_START \*/)',
    loader,
    "loader",
)

# 2) Подпись получает channels напрямую.
caption = r'''/* LR_ANALYTICS_CAPTION_V44_START */
/* LR_MULTI_ANALYTICS_CAPTION_V47 */
function lrV44AnalyticsCaption(channels = []) {
  const n = (v) => {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
  };

  const fmt = (v) =>
    Math.round(n(v)).toLocaleString('ru-RU');

  const list = Array.isArray(channels) ? channels : [];

  const subscribers = list.reduce(
    (sum, ch) => sum + n(ch?.subscribers), 0
  );
  const views24 = list.reduce(
    (sum, ch) => sum + n(ch?.views24), 0
  );
  const views48 = list.reduce(
    (sum, ch) => sum + n(ch?.views48), 0
  );
  const views72 = list.reduce(
    (sum, ch) => sum + n(ch?.views72), 0
  );
  const delta = list.reduce(
    (sum, ch) =>
      sum +
      n(
        ch?.delta_day ??
        ch?.deltaDay ??
        (
          n(ch?.joined_24h ?? ch?.joined24h) -
          n(ch?.left_24h ?? ch?.left24h)
        )
      ),
    0
  );

  const er24 =
    subscribers > 0
      ? (views24 / subscribers) * 100
      : 0;

  const now = new Date()
    .toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(',', '');

  return (
    '📊 <b>LinkRay Analytics</b>\n' +
    `<b>Сводка по сети:</b> ${fmt(list.length)} каналов\n\n` +
    `👥 <b>Подписчики:</b> ${fmt(subscribers)}\n` +
    `📈 <b>За сутки:</b> ${delta > 0 ? '+' : ''}${fmt(delta)}\n\n` +
    '👁 <b>Просмотры:</b>\n' +
    `├ 24 часа: <b>${fmt(views24)}</b>\n` +
    `├ 48 часов: <b>${fmt(views48)}</b>\n` +
    `└ 72 часа: <b>${fmt(views72)}</b>\n\n` +
    `📊 <b>Средний ER24:</b> ${er24.toFixed(2).replace('.', ',')}%\n` +
    `🕘 <b>Сформировано:</b> ${now} МСК\n` +
    '━━━━━━━━━━━━━━\n' +
    '✨ <a href="https://max.ru/se13353901_bot">LinkRay</a> — ' +
    'автопостинг и аналитика рекламных размещений в MAX'
  );
}
/* LR_ANALYTICS_CAPTION_V44_END */'''

sub_once(
    r'/\* LR_ANALYTICS_CAPTION_V44_START \*/[\s\S]*?/\* LR_ANALYTICS_CAPTION_V44_END \*/',
    caption,
    "caption",
)

# 3) Новый сетевой дизайн: вместо тесной таблицы — 2x2 карточки каналов.
renderer = r'''
async function lrV40RenderFinalNetworkPng(channels = []) {
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default || sharpMod;
  const fs = await import('node:fs/promises');

  const W = 1280;
  const H = 920;

  const esc = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const n = (v) => {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
  };

  const fmt = (v) =>
    Math.round(n(v)).toLocaleString('ru-RU');

  const compact = (v) => {
    const x = n(v);
    if (Math.abs(x) >= 1000000) {
      return (x / 1000000)
        .toFixed(Math.abs(x) >= 10000000 ? 0 : 1)
        .replace('.', ',') + 'M';
    }
    if (Math.abs(x) >= 1000) {
      return (x / 1000)
        .toFixed(Math.abs(x) >= 10000 ? 0 : 1)
        .replace('.', ',') + 'k';
    }
    return String(Math.round(x));
  };

  const short = (v, max = 34) => {
    const t = String(v || 'Канал').replace(/\s+/g, ' ').trim();
    return t.length > max
      ? t.slice(0, max - 1).trim() + '…'
      : t;
  };

  const avatarUrl = (ch) =>
    String(
      ch?.avatar_url ||
      ch?.avatarUrl ||
      ch?.photo_url ||
      ch?.image_url ||
      ch?.icon_url ||
      ch?.picture_url ||
      ch?.avatar ||
      ch?.photo ||
      ''
    ).trim();

  const goodUrl = (url) => {
    const u = String(url || '').trim();
    const low = u.toLowerCase();
    return (
      /^https?:\/\//i.test(u) &&
      !low.includes('/s/img/og-logo.png') &&
      !low.includes('favicon') &&
      !low.includes('app-icon')
    );
  };

  async function imageData(url, size = 76) {
    if (!goodUrl(url)) return '';
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: {
          'user-agent': 'Mozilla/5.0 LinkRayBot/1.0',
          'accept': 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
          'referer': 'https://max.ru/',
        },
      });
      if (!res.ok) return '';
      const input = Buffer.from(await res.arrayBuffer());
      const out = await sharp(input)
        .resize(size, size, { fit: 'cover', position: 'centre' })
        .png()
        .toBuffer();
      return `data:image/png;base64,${out.toString('base64')}`;
    } catch {
      return '';
    }
  }

  async function logoData() {
    const candidates = [
      '/app/public/brand/linkray-logo-main.jpg',
      '/app/public/linkray-site/linkray-logo-exact.webp',
      '/app/public/assets/linkray-logo.webp',
    ];

    for (const file of candidates) {
      try {
        const input = await fs.readFile(file);
        const out = await sharp(input)
          .resize(92, 92, { fit: 'cover', position: 'centre' })
          .png()
          .toBuffer();
        return `data:image/png;base64,${out.toString('base64')}`;
      } catch {}
    }
    return '';
  }

  const clean = [];
  const seen = new Set();

  for (let i = 0; i < channels.length; i++) {
    const raw = channels[i] || {};
    const title = String(
      raw.title ||
      raw.name ||
      raw.channel_title ||
      raw.channel_name ||
      `Канал ${i + 1}`
    ).replace(/\s+/g, ' ').trim();

    const link = String(raw.link || '').trim();
    const key = link || title || String(i);
    if (seen.has(key)) continue;
    seen.add(key);

    clean.push({
      ...raw,
      title,
      link,
      subscribers: n(raw.subscribers),
      views24: n(raw.views24),
      views48: n(raw.views48),
      views72: n(raw.views72),
      er24: n(raw.er24),
      deltaDay: n(raw.delta_day ?? raw.deltaDay),
    });
  }

  const totalSubscribers = clean.reduce(
    (sum, ch) => sum + ch.subscribers, 0
  );
  const total24 = clean.reduce(
    (sum, ch) => sum + ch.views24, 0
  );
  const total48 = clean.reduce(
    (sum, ch) => sum + ch.views48, 0
  );
  const total72 = clean.reduce(
    (sum, ch) => sum + ch.views72, 0
  );
  const totalDelta = clean.reduce(
    (sum, ch) => sum + ch.deltaDay, 0
  );
  const totalEr =
    totalSubscribers > 0
      ? (total24 / totalSubscribers) * 100
      : 0;

  const visible = clean.slice(0, 4);
  const logo = await logoData();

  const now = new Date()
    .toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(',', '');

  let clipDefs = '';
  let channelCards = '';

  const positions = [
    [58, 438],
    [650, 438],
    [58, 620],
    [650, 620],
  ];

  for (let i = 0; i < visible.length; i++) {
    const ch = visible[i];
    const [x, y] = positions[i];
    const av = await imageData(avatarUrl(ch), 80);
    const clipId = `lrNetV47Avatar${i}`;
    const rowEr =
      ch.er24 > 0
        ? ch.er24
        : (
            ch.subscribers > 0
              ? (ch.views24 / ch.subscribers) * 100
              : 0
          );

    let avatarSvg = '';
    if (av) {
      clipDefs += `
        <clipPath id="${clipId}">
          <circle cx="${x + 60}" cy="${y + 59}" r="38"/>
        </clipPath>`;
      avatarSvg = `
        <circle cx="${x + 60}" cy="${y + 59}" r="40"
                fill="#0a3540"
                stroke="#49e7c7" stroke-width="2"/>
        <image href="${av}"
               x="${x + 22}" y="${y + 21}"
               width="76" height="76"
               preserveAspectRatio="xMidYMid slice"
               clip-path="url(#${clipId})"/>`;
    } else {
      const letter = esc(
        (String(ch.title || 'К').trim()[0] || 'К').toUpperCase()
      );
      avatarSvg = `
        <circle cx="${x + 60}" cy="${y + 59}" r="40"
                fill="url(#avatarFallback${i})"
                stroke="#49e7c7" stroke-width="2"/>
        <text x="${x + 60}" y="${y + 69}"
              text-anchor="middle"
              class="avatarLetter">${letter}</text>`;
    }

    channelCards += `
      <g>
        <rect x="${x}" y="${y}" width="572" height="156" rx="24"
              fill="#0a3440" fill-opacity=".74"
              stroke="#84ead5" stroke-opacity=".14"/>
        ${avatarSvg}

        <text x="${x + 120}" y="${y + 48}"
              class="channelTitle">${esc(short(ch.title))}</text>

        <text x="${x + 120}" y="${y + 86}"
              class="channelLabel">ПДП</text>
        <text x="${x + 178}" y="${y + 86}"
              class="channelValue">${fmt(ch.subscribers)}</text>

        <text x="${x + 300}" y="${y + 86}"
              class="channelLabel">24 ч</text>
        <text x="${x + 365}" y="${y + 86}"
              class="channelValue cyan">${fmt(ch.views24)}</text>

        <text x="${x + 120}" y="${y + 124}"
              class="channelLabel">ER24</text>
        <text x="${x + 184}" y="${y + 124}"
              class="channelValue green">${rowEr.toFixed(2).replace('.', ',')}%</text>
      </g>`;
  }

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg"
       width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="bg47" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#073a45"/>
        <stop offset="52%" stop-color="#07535a"/>
        <stop offset="100%" stop-color="#0a9b70"/>
      </linearGradient>

      <linearGradient id="summary47" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#154b58"/>
        <stop offset="100%" stop-color="#17705f"/>
      </linearGradient>

      <radialGradient id="glow47" cx="90%" cy="88%" r="68%">
        <stop offset="0%" stop-color="#30ffad" stop-opacity=".22"/>
        <stop offset="100%" stop-color="#30ffad" stop-opacity="0"/>
      </radialGradient>

      <linearGradient id="avatarFallback0" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#29e5ff"/>
        <stop offset="100%" stop-color="#1474e8"/>
      </linearGradient>
      <linearGradient id="avatarFallback1" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#4df0c6"/>
        <stop offset="100%" stop-color="#0a9874"/>
      </linearGradient>
      <linearGradient id="avatarFallback2" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#9b8eff"/>
        <stop offset="100%" stop-color="#4d55ca"/>
      </linearGradient>
      <linearGradient id="avatarFallback3" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ffd96b"/>
        <stop offset="100%" stop-color="#e77c2a"/>
      </linearGradient>

      <clipPath id="logoClip47">
        <circle cx="1165" cy="78" r="43"/>
      </clipPath>

      ${clipDefs}
    </defs>

    <style>
      text { font-family: "DejaVu Sans", Arial, sans-serif; }
      .title { fill:#f5ffff; font-size:43px; font-weight:800; }
      .subtitle { fill:#a8d5d4; font-size:18px; font-weight:500; }
      .metricLabel { fill:#b7d7d5; font-size:17px; font-weight:600; }
      .metricValue { fill:#40edc0; font-size:36px; font-weight:900; }
      .metricValue.blue { fill:#42ddff; }
      .viewsLabel { fill:#a9ccca; font-size:16px; font-weight:600; }
      .viewsValue { fill:#eafcfa; font-size:24px; font-weight:800; }
      .sectionTitle { fill:#f5ffff; font-size:26px; font-weight:800; }
      .channelTitle { fill:#f5ffff; font-size:20px; font-weight:800; }
      .channelLabel { fill:#90b5b6; font-size:15px; font-weight:700; }
      .channelValue { fill:#e8f8f5; font-size:19px; font-weight:800; }
      .channelValue.cyan { fill:#46dff7; }
      .channelValue.green { fill:#70edb7; }
      .avatarLetter { fill:#fff; font-size:24px; font-weight:900; }
      .footer { fill:#c5e4df; font-size:16px; font-weight:600; }
      .footerMuted { fill:#91bdb9; font-size:14px; }
    </style>

    <rect width="${W}" height="${H}" rx="34" fill="url(#bg47)"/>
    <rect width="${W}" height="${H}" rx="34" fill="url(#glow47)"/>

    <text x="58" y="72" class="title">Статистика сети каналов</text>
    <text x="60" y="105" class="subtitle">LinkRay Analytics · сводка по выбранным каналам</text>

    ${
      logo
        ? `
          <circle cx="1165" cy="78" r="46"
                  fill="#ffffff" fill-opacity=".10"
                  stroke="#8affdf" stroke-opacity=".32"
                  stroke-width="2"/>
          <image href="${logo}" x="1122" y="35"
                 width="86" height="86"
                 preserveAspectRatio="xMidYMid slice"
                 clip-path="url(#logoClip47)"/>`
        : ''
    }

    <g>
      <rect x="58" y="143" width="274" height="112" rx="22"
            fill="url(#summary47)" stroke="#8df1dc" stroke-opacity=".14"/>
      <text x="82" y="179" class="metricLabel">Подписчики</text>
      <text x="82" y="229" class="metricValue blue">${compact(totalSubscribers)}</text>
    </g>

    <g>
      <rect x="354" y="143" width="274" height="112" rx="22"
            fill="url(#summary47)" stroke="#8df1dc" stroke-opacity=".14"/>
      <text x="378" y="179" class="metricLabel">Просмотры 24 ч</text>
      <text x="378" y="229" class="metricValue">${compact(total24)}</text>
    </g>

    <g>
      <rect x="650" y="143" width="274" height="112" rx="22"
            fill="url(#summary47)" stroke="#8df1dc" stroke-opacity=".14"/>
      <text x="674" y="179" class="metricLabel">Средний ER24</text>
      <text x="674" y="229" class="metricValue blue">${totalEr.toFixed(2).replace('.', ',')}%</text>
    </g>

    <g>
      <rect x="946" y="143" width="274" height="112" rx="22"
            fill="url(#summary47)" stroke="#8df1dc" stroke-opacity=".14"/>
      <text x="970" y="179" class="metricLabel">Каналов</text>
      <text x="970" y="229" class="metricValue">${fmt(clean.length)}</text>
    </g>

    <rect x="58" y="284" width="1162" height="112" rx="24"
          fill="#092f3a" fill-opacity=".70"
          stroke="#8cebd6" stroke-opacity=".13"/>

    <text x="82" y="324" class="sectionTitle">Просмотры по сети</text>

    <text x="82" y="370" class="viewsLabel">24 часа</text>
    <text x="183" y="370" class="viewsValue">${fmt(total24)}</text>

    <text x="348" y="370" class="viewsLabel">48 часов</text>
    <text x="449" y="370" class="viewsValue">${fmt(total48)}</text>

    <text x="614" y="370" class="viewsLabel">72 часа</text>
    <text x="715" y="370" class="viewsValue">${fmt(total72)}</text>

    <text x="880" y="370" class="viewsLabel">За сутки</text>
    <text x="974" y="370" class="viewsValue">${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)}</text>

    ${channelCards}

    ${
      clean.length > 4
        ? `<text x="60" y="809" class="footerMuted">Показано 4 из ${fmt(clean.length)} каналов. Общие показатели рассчитаны по всем выбранным каналам.</text>`
        : `<text x="60" y="809" class="footerMuted">Общие показатели рассчитаны по всем выбранным каналам.</text>`
    }

    <line x1="58" y1="840" x2="1220" y2="840"
          stroke="#bcebe3" stroke-opacity=".17"/>

    <text x="58" y="879" class="footer">Актуально на ${esc(now)} МСК</text>
    <text x="1220" y="879" text-anchor="end" class="footer">LinkRay — аналитика каналов MAX</text>

    <text x="58" y="906" class="footerMuted">Данные собираются после подключения LinkRay к каналу</text>
  </svg>`;

  console.log(
    '[LR_NETWORK_CARD_V47]',
    JSON.stringify({
      channels: clean.length,
      views24: total24,
      views48: total48,
      views72: total72,
      visibleAvatars: visible.filter((ch) => goodUrl(avatarUrl(ch))).length,
    })
  );

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

'''.lstrip()

sub_once(
    r'async function lrV40RenderFinalNetworkPng\(channels = \[\]\)\s*\{[\s\S]*?(?=/\* LR_NETWORK_CARD_FINAL_V40_END \*/)',
    renderer,
    "renderer",
)

# 4) Direct sender: реальные channels + inline keyboard.
sender = r'''
async function lrV34SendMaxImageUrl(
  update,
  imageUrl,
  channels = [],
) {
  const token = lrV34MaxToken();
  if (!token) throw new Error('MAX token not found');

  const target = lrV34TargetFromUpdate(update);
  const targetQuery = target.chatId
    ? `chat_id=${encodeURIComponent(target.chatId)}`
    : target.userId
      ? `user_id=${encodeURIComponent(target.userId)}`
      : '';

  if (!targetQuery) {
    throw new Error('chat_id/user_id not found');
  }

  const api = lrV34ApiBase();

  const body = {
    text: lrV44AnalyticsCaption(channels),
    format: 'html',
    attachments: [
      {
        type: 'image',
        payload: { url: imageUrl },
      },
      ...lrMenuButtons([
        [lrCb('🏠 Главное меню', 'main:menu')],
      ]),
    ],
  };

  const res = await fetch(`${api}/messages?${targetQuery}`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error(
      `MAX image url send failed ${res.status}: ${responseText}`
    );
  }

  console.log(
    '[LR_DIRECT_PUBLIC_IMAGE_V47]',
    JSON.stringify({
      channels: channels.length,
      mainMenuButton: true,
      imageUrl,
    })
  );

  return true;
}

'''.lstrip()

sub_once(
    r'async function lrV34SendMaxImageUrl\(update,\s*imageUrl\)\s*\{[\s\S]*?(?=async function lrV34TryDirectPublicNetworkCard)',
    sender,
    "sender",
)

old_call = "await lrV34SendMaxImageUrl(update, url);"
if s.count(old_call) != 1:
    raise SystemExit(
        f"ОШИБКА: вызов sender найден {s.count(old_call)} раз"
    )
s = s.replace(
    old_call,
    "await lrV34SendMaxImageUrl(update, url, channels);",
    1,
)

# Финальные проверки прямо по получившемуся JS.
required = [
    "LR_MULTI_ANALYTICS_CAPTION_V47",
    "[LR_NETWORK_CARD_V47]",
    "[LR_DIRECT_PUBLIC_IMAGE_V47]",
    "lrV34SendMaxImageUrl(update, url, channels)",
    "lrCb('🏠 Главное меню', 'main:menu')",
    "const resolved = await resolveChannel(link, { _lrIndex: i });",
]

for needle in required:
    if needle not in s:
        raise SystemExit(f"ОШИБКА: после патча нет: {needle}")

p.write_text(s, encoding="utf-8")
print("OK: V47 применён к реальному маршруту нескольких ссылок")
PY

echo "[3/8] Проверяю JS"
node --check "$FILE"
git diff --check

echo "[4/8] Проверяю изолированность"
CHANGED="$(git diff --name-only | sort -u)"
printf '%s\n' "$CHANGED"
[[ "$CHANGED" == "$FILE" ]]

echo "[5/8] Пересобираю app"
docker compose up -d --build app
sleep 14
docker compose ps --status running --services | grep -qx app

echo "[6/8] Проверяю код внутри контейнера"
docker exec linkray-app sh -lc \
  "node --check /app/$FILE && \
   grep -Fq '[LR_NETWORK_CARD_V47]' /app/$FILE && \
   grep -Fq '[LR_DIRECT_PUBLIC_IMAGE_V47]' /app/$FILE && \
   grep -Fq \"lrCb('🏠 Главное меню', 'main:menu')\" /app/$FILE"

echo "[7/8] Проверяю логи"
LOGS="$(docker compose logs --since=4m app 2>&1 || true)"
if printf '%s\n' "$LOGS" | grep -Eqi \
  "SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|Cannot find module|Identifier .* already been declared"
then
  printf '%s\n' "$LOGS" | tail -220
  exit 1
fi

echo "[8/8] Коммит и push"
trap - ERR
git add -- "$FILE"
git commit -m "Fix multi-channel analytics card V47"
git push origin HEAD:main

echo
echo "============================================================"
echo "V47 ГОТОВ"
echo "• сводная карточка 2x2 без наложения текста"
echo "• реальные аватары из resolveChannel"
echo "• реальные 24/48/72 и ER"
echo "• подпись больше не получает пустой массив"
echo "• кнопка 🏠 Главное меню под отчётом"
echo "• main:menu открывает отдельное новое сообщение"
echo "• одиночная аналитика не менялась"
echo "============================================================"
