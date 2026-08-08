#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/linkray

FILE="src/linkrayChannelAnalytics.js"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/linkray-backups/multi-analytics-v46-$STAMP"
mkdir -p "$BACKUP"

echo "[1/8] Сверяю актуальный main"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ОШИБКА: есть незавершённые изменения:"
  git status --short
  exit 2
fi

git fetch origin main --quiet
git pull --ff-only origin main

test -f "$FILE"
cp -a "$FILE" "$BACKUP/"

rollback() {
  code=$?
  echo
  echo "[ОТКАТ] Возвращаю прежний $FILE"
  cp -f "$BACKUP/$(basename "$FILE")" "$FILE" || true
  docker compose up -d --build app >/dev/null 2>&1 || true
  echo "Откат выполнен. Копия: $BACKUP"
  exit "$code"
}
trap rollback ERR

echo "[2/8] Исправляю загрузку данных, карточку, подпись и кнопку"

python3 - "$FILE" <<'PY'
from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
s = p.read_text(encoding="utf-8")

loader_re = re.compile(
    r'async function lrV34LoadChannelsByLinks\(links\)\s*\{[\s\S]*?'
    r'(?=/\* LR_SAFE_NETWORK_CARD_V37_START \*/)'
)

if not loader_re.search(s):
    raise SystemExit("Не найден lrV34LoadChannelsByLinks")

loader = r'''
async function lrV34LoadChannelsByLinks(links) {
  const channels = [];

  for (let i = 0; i < links.length; i++) {
    const link = lrV34NormLink(links[i]);

    const resolved = await resolveChannel(link, {
      _lrIndex: i,
    });

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

s = loader_re.sub(loader, s, count=1)

cap_start = "/* LR_ANALYTICS_CAPTION_V44_START */"
cap_end = "/* LR_ANALYTICS_CAPTION_V44_END */"

if cap_start not in s or cap_end not in s:
    raise SystemExit("Не найден LR_ANALYTICS_CAPTION_V44")

caption = r'''
/* LR_ANALYTICS_CAPTION_V44_START */
/* LR_MULTI_ANALYTICS_CAPTION_V46 */
function lrV44AnalyticsCaption(channels = []) {
  function n(v) {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
  }

  function fmt(v) {
    return Math.round(n(v)).toLocaleString('ru-RU');
  }

  function html(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const list = Array.isArray(channels) ? channels : [];

  const totalSubscribers = list.reduce(
    (sum, ch) => sum + n(ch?.subscribers),
    0,
  );

  const total24 = list.reduce(
    (sum, ch) => sum + n(ch?.views24),
    0,
  );

  const total48 = list.reduce(
    (sum, ch) => sum + n(ch?.views48),
    0,
  );

  const total72 = list.reduce(
    (sum, ch) => sum + n(ch?.views72),
    0,
  );

  const totalDelta = list.reduce(
    (sum, ch) =>
      sum +
      n(
        ch?.delta_day ??
        ch?.deltaDay ??
        (
          n(ch?.joined_24h ?? ch?.joined24h) -
          n(ch?.left_24h ?? ch?.left24h)
        ),
      ),
    0,
  );

  const er24 =
    totalSubscribers > 0
      ? (total24 / totalSubscribers) * 100
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
    `👥 <b>Подписчики:</b> ${fmt(totalSubscribers)}\n` +
    `📈 <b>За сутки:</b> ${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)}\n\n` +
    '👁 <b>Просмотры:</b>\n' +
    `├ 24 часа: <b>${fmt(total24)}</b>\n` +
    `├ 48 часов: <b>${fmt(total48)}</b>\n` +
    `└ 72 часа: <b>${fmt(total72)}</b>\n\n` +
    `📊 <b>Средний ER24:</b> ${er24.toFixed(2).replace('.', ',')}%\n` +
    `🕘 <b>Сформировано:</b> ${html(now)} МСК\n` +
    '━━━━━━━━━━━━━━\n' +
    '✨ <a href="https://max.ru/se13353901_bot">LinkRay</a> — ' +
    'автопостинг и аналитика рекламных размещений в MAX'
  );
}
/* LR_ANALYTICS_CAPTION_V44_END */
'''.strip()

s = re.sub(
    rf'{re.escape(cap_start)}[\s\S]*?{re.escape(cap_end)}',
    caption,
    s,
    count=1,
)

png_start = "/* LR_NETWORK_CARD_FINAL_V40_START */"
png_end = "/* LR_NETWORK_CARD_FINAL_V40_END */"

if png_start not in s or png_end not in s:
    raise SystemExit("Не найден LR_NETWORK_CARD_FINAL_V40")

renderer = r'''
/* LR_NETWORK_CARD_FINAL_V40_START */
/* LR_NETWORK_CARD_PREMIUM_V46 */
async function lrV40RenderFinalNetworkPng(channels = []) {
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default || sharpMod;
  const fs = await import('node:fs/promises');

  const W = 1280;
  const H = 900;

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function n(v) {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
  }

  function fmt(v) {
    const x = Math.round(n(v));

    if (Math.abs(x) >= 1000000) {
      return (x / 1000000)
        .toFixed(x >= 10000000 ? 0 : 1)
        .replace('.', ',') + 'M';
    }

    if (Math.abs(x) >= 1000) {
      return (x / 1000)
        .toFixed(x >= 10000 ? 0 : 1)
        .replace('.', ',') + 'k';
    }

    return String(x);
  }

  function short(v, max = 31) {
    const t = String(v || 'Канал')
      .replace(/\s+/g, ' ')
      .trim();

    return t.length > max
      ? t.slice(0, max - 1).trim() + '…'
      : t;
  }

  function avatarUrl(ch) {
    return String(
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
  }

  function goodUrl(url) {
    const u = String(url || '').trim().toLowerCase();

    return (
      /^https?:\/\//i.test(u) &&
      !u.includes('/s/img/og-logo.png') &&
      !u.includes('favicon') &&
      !u.includes('app-icon')
    );
  }

  async function toPngData(url, size = 72) {
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

      const output = await sharp(input)
        .resize(size, size, {
          fit: 'cover',
          position: 'centre',
        })
        .png()
        .toBuffer();

      return `data:image/png;base64,${output.toString('base64')}`;
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

        const output = await sharp(input)
          .resize(94, 94, {
            fit: 'cover',
            position: 'centre',
          })
          .png()
          .toBuffer();

        return `data:image/png;base64,${output.toString('base64')}`;
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
    )
      .replace(/\s+/g, ' ')
      .trim();

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

  const visible = clean.slice(0, 4);

  const totalSubscribers = clean.reduce(
    (sum, ch) => sum + ch.subscribers,
    0,
  );

  const total24 = clean.reduce(
    (sum, ch) => sum + ch.views24,
    0,
  );

  const total48 = clean.reduce(
    (sum, ch) => sum + ch.views48,
    0,
  );

  const total72 = clean.reduce(
    (sum, ch) => sum + ch.views72,
    0,
  );

  const totalDelta = clean.reduce(
    (sum, ch) => sum + ch.deltaDay,
    0,
  );

  const totalEr =
    totalSubscribers > 0
      ? (total24 / totalSubscribers) * 100
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

  const logo = await logoData();

  let rowsSvg = '';
  let clipDefs = '';

  for (let i = 0; i < visible.length; i++) {
    const ch = visible[i];
    const y = 455 + i * 79;
    const cx = 492;
    const cy = y + 31;
    const r = 29;

    const avatar = await toPngData(
      avatarUrl(ch),
      72,
    );

    const clipId = `lrNetAvatar46_${i}`;
    let avatarSvg = '';

    if (avatar) {
      clipDefs += `
        <clipPath id="${clipId}">
          <circle cx="${cx}" cy="${cy}" r="${r}"/>
        </clipPath>`;

      avatarSvg = `
        <circle cx="${cx}" cy="${cy}" r="${r + 2}"
                fill="#0c3b47"
                stroke="#39e8c2"
                stroke-width="2"/>
        <image href="${avatar}"
               x="${cx - r}"
               y="${cy - r}"
               width="${r * 2}"
               height="${r * 2}"
               preserveAspectRatio="xMidYMid slice"
               clip-path="url(#${clipId})"/>`;
    } else {
      const letter = esc(
        (String(ch.title || 'К').trim()[0] || 'К').toUpperCase(),
      );

      avatarSvg = `
        <circle cx="${cx}" cy="${cy}" r="${r + 2}"
                fill="url(#avatarFallback${i})"
                stroke="#39e8c2"
                stroke-width="2"/>
        <text x="${cx}" y="${cy + 8}"
              text-anchor="middle"
              class="avatar-letter">${letter}</text>`;
    }

    const rowEr =
      ch.er24 > 0
        ? ch.er24
        : (
            ch.subscribers > 0
              ? (ch.views24 / ch.subscribers) * 100
              : 0
          );

    rowsSvg += `
      <g>
        <rect x="447" y="${y - 7}"
              width="761" height="69" rx="18"
              fill="#0a3440"
              fill-opacity=".72"
              stroke="#80ead1"
              stroke-opacity=".11"/>
        ${avatarSvg}
        <text x="538" y="${y + 25}"
              class="channel-name">${esc(short(ch.title))}</text>
        <text x="953" y="${y + 25}"
              text-anchor="end"
              class="channel-num">${fmt(ch.subscribers)}</text>
        <text x="1091" y="${y + 25}"
              text-anchor="end"
              class="channel-views">${fmt(ch.views24)}</text>
        <text x="1178" y="${y + 25}"
              text-anchor="end"
              class="channel-er">${rowEr.toFixed(1).replace('.', ',')}%</text>
      </g>`;
  }

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg"
       width="${W}" height="${H}"
       viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="bg46" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#073d47"/>
        <stop offset="52%" stop-color="#07545a"/>
        <stop offset="100%" stop-color="#0a9c70"/>
      </linearGradient>

      <linearGradient id="card46" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#164f5b"/>
        <stop offset="100%" stop-color="#157663"/>
      </linearGradient>

      <radialGradient id="glow46" cx="86%" cy="82%" r="70%">
        <stop offset="0%" stop-color="#35ffb5" stop-opacity=".25"/>
        <stop offset="100%" stop-color="#35ffb5" stop-opacity="0"/>
      </radialGradient>

      <linearGradient id="avatarFallback0" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#28e8ff"/>
        <stop offset="100%" stop-color="#1376e8"/>
      </linearGradient>

      <linearGradient id="avatarFallback1" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#4bf3c7"/>
        <stop offset="100%" stop-color="#0b9f79"/>
      </linearGradient>

      <linearGradient id="avatarFallback2" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#9a8dff"/>
        <stop offset="100%" stop-color="#4a54c8"/>
      </linearGradient>

      <linearGradient id="avatarFallback3" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ffd86b"/>
        <stop offset="100%" stop-color="#e87929"/>
      </linearGradient>

      <clipPath id="logoClip46">
        <circle cx="1161" cy="79" r="43"/>
      </clipPath>

      ${clipDefs}
    </defs>

    <style>
      text { font-family: "DejaVu Sans", Arial, sans-serif; }
      .title { fill: #f5ffff; font-size: 43px; font-weight: 800; }
      .subtitle { fill: #a7d6d5; font-size: 18px; font-weight: 500; }
      .metric-label { fill: #badada; font-size: 17px; font-weight: 600; }
      .metric-value { fill: #43edc2; font-size: 37px; font-weight: 900; }
      .metric-value.blue { fill: #42dcff; }
      .panel-title { fill: #f5ffff; font-size: 27px; font-weight: 800; }
      .views-label { fill: #d7eeee; font-size: 24px; font-weight: 700; }
      .views-value { fill: #49e4ff; font-size: 30px; font-weight: 900; }
      .table-head { fill: #8ebcbd; font-size: 15px; font-weight: 800; }
      .channel-name { fill: #f5ffff; font-size: 20px; font-weight: 700; }
      .channel-num { fill: #dcf4f0; font-size: 20px; font-weight: 800; }
      .channel-views { fill: #48e3fa; font-size: 20px; font-weight: 800; }
      .channel-er { fill: #72eeb9; font-size: 17px; font-weight: 800; }
      .avatar-letter { fill: #fff; font-size: 22px; font-weight: 900; }
      .footer { fill: #c8e8e1; font-size: 16px; font-weight: 600; }
      .footer-muted { fill: #93c0bb; font-size: 14px; }
    </style>

    <rect width="${W}" height="${H}" rx="34" fill="url(#bg46)"/>
    <rect width="${W}" height="${H}" rx="34" fill="url(#glow46)"/>

    <text x="61" y="72" class="title">Статистика сети каналов</text>
    <text x="63" y="105" class="subtitle">LinkRay Analytics · сводка по выбранным каналам</text>

    ${
      logo
        ? `
          <circle cx="1161" cy="79" r="46"
                  fill="#ffffff" fill-opacity=".10"
                  stroke="#87ffe0" stroke-opacity=".30"
                  stroke-width="2"/>
          <image href="${logo}"
                 x="1118" y="36"
                 width="86" height="86"
                 preserveAspectRatio="xMidYMid slice"
                 clip-path="url(#logoClip46)"/>`
        : `
          <text x="1205" y="87"
                text-anchor="end"
                class="panel-title">LinkRay</text>`
    }

    <g>
      <rect x="61" y="146" width="271" height="119" rx="22"
            fill="url(#card46)" stroke="#8ff7df" stroke-opacity=".14"/>
      <text x="85" y="183" class="metric-label">Подписчики</text>
      <text x="85" y="236" class="metric-value blue">${fmt(totalSubscribers)}</text>
    </g>

    <g>
      <rect x="354" y="146" width="271" height="119" rx="22"
            fill="url(#card46)" stroke="#8ff7df" stroke-opacity=".14"/>
      <text x="378" y="183" class="metric-label">Просмотры 24 ч</text>
      <text x="378" y="236" class="metric-value">${fmt(total24)}</text>
    </g>

    <g>
      <rect x="647" y="146" width="271" height="119" rx="22"
            fill="url(#card46)" stroke="#8ff7df" stroke-opacity=".14"/>
      <text x="671" y="183" class="metric-label">Средний ER24</text>
      <text x="671" y="236" class="metric-value blue">${totalEr.toFixed(2).replace('.', ',')}%</text>
    </g>

    <g>
      <rect x="940" y="146" width="271" height="119" rx="22"
            fill="url(#card46)" stroke="#8ff7df" stroke-opacity=".14"/>
      <text x="964" y="183" class="metric-label">Каналов</text>
      <text x="964" y="236" class="metric-value">${fmt(clean.length)}</text>
    </g>

    <rect x="61" y="303" width="340" height="450" rx="26"
          fill="#092e39" fill-opacity=".70"
          stroke="#89efd7" stroke-opacity=".13"/>

    <text x="91" y="354" class="panel-title">Просмотры</text>

    <text x="91" y="421" class="views-label">24 часа</text>
    <text x="366" y="421" text-anchor="end" class="views-value">${fmt(total24)}</text>

    <line x1="91" y1="445" x2="366" y2="445"
          stroke="#a6dbd4" stroke-opacity=".13"/>

    <text x="91" y="506" class="views-label">48 часов</text>
    <text x="366" y="506" text-anchor="end" class="views-value">${fmt(total48)}</text>

    <line x1="91" y1="530" x2="366" y2="530"
          stroke="#a6dbd4" stroke-opacity=".13"/>

    <text x="91" y="591" class="views-label">72 часа</text>
    <text x="366" y="591" text-anchor="end" class="views-value">${fmt(total72)}</text>

    <line x1="91" y1="627" x2="366" y2="627"
          stroke="#a6dbd4" stroke-opacity=".13"/>

    <text x="91" y="676" class="metric-label">Изменение за сутки</text>
    <text x="91" y="725" class="metric-value">${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)}</text>

    <rect x="423" y="303" width="788" height="450" rx="26"
          fill="#092e39" fill-opacity=".66"
          stroke="#89efd7" stroke-opacity=".13"/>

    <text x="454" y="354" class="panel-title">Каналы</text>

    <text x="538" y="407" class="table-head">КАНАЛ</text>
    <text x="953" y="407" text-anchor="end" class="table-head">ПДП</text>
    <text x="1091" y="407" text-anchor="end" class="table-head">24 Ч</text>
    <text x="1178" y="407" text-anchor="end" class="table-head">ER</text>

    ${rowsSvg}

    <text x="454" y="731" class="footer-muted">
      ${
        clean.length > 4
          ? `Показано 4 из ${fmt(clean.length)} каналов · суммы рассчитаны по всем.`
          : 'Суммы рассчитаны по всем выбранным каналам.'
      }
    </text>

    <line x1="61" y1="804" x2="1211" y2="804"
          stroke="#bdeee5" stroke-opacity=".17"/>

    <text x="61" y="845" class="footer">Актуально на ${esc(now)} МСК</text>
    <text x="1211" y="845" text-anchor="end" class="footer">LinkRay — аналитика каналов MAX</text>
    <text x="61" y="875" class="footer-muted">Данные собираются после подключения LinkRay к каналу</text>
  </svg>`;

  console.log(
    '[LR_NETWORK_CARD_PREMIUM_V46]',
    JSON.stringify({
      channels: clean.length,
      views24: total24,
      views48: total48,
      views72: total72,
      avatars: visible.filter((ch) => goodUrl(avatarUrl(ch))).length,
    }),
  );

  return await sharp(Buffer.from(svg)).png().toBuffer();
}
/* LR_NETWORK_CARD_FINAL_V40_END */
'''.strip()

s = re.sub(
    rf'{re.escape(png_start)}[\s\S]*?{re.escape(png_end)}',
    renderer,
    s,
    count=1,
)

sender_re = re.compile(
    r'async function lrV34SendMaxImageUrl\(update,\s*imageUrl\)\s*\{[\s\S]*?'
    r'(?=async function lrV34TryDirectPublicNetworkCard)',
)

if not sender_re.search(s):
    raise SystemExit("Не найден lrV34SendMaxImageUrl")

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
        payload: {
          url: imageUrl,
        },
      },
      ...lrMenuButtons([
        [lrCb('🏠 Главное меню', 'main:menu')],
      ]),
    ],
  };

  const res = await fetch(
    `${api}/messages?${targetQuery}`,
    {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error(
      `MAX image url send failed ${res.status}: ${responseText}`,
    );
  }

  console.log(
    '[LR_DIRECT_PUBLIC_IMAGE_V46]',
    JSON.stringify({
      channels: channels.length,
      imageUrl,
      mainMenuButton: true,
    }),
  );

  return true;
}

'''.lstrip()

s = sender_re.sub(sender, s, count=1)

old_call = "await lrV34SendMaxImageUrl(update, url);"

if s.count(old_call) != 1:
    raise SystemExit(
        "Не найден единственный вызов lrV34SendMaxImageUrl(update, url)"
    )

s = s.replace(
    old_call,
    "await lrV34SendMaxImageUrl(update, url, channels);",
    1,
)

if "payload === 'main:menu'" not in s:
    raise SystemExit("Не найден существующий обработчик main:menu")

if "async function showFallbackMainMenu" not in s:
    raise SystemExit("Не найден showFallbackMainMenu")

p.write_text(s, encoding="utf-8")
print("V46 применён.")
PY

echo "[3/8] Проверяю синтаксис"
node --check "$FILE"
git diff --check

grep -q "LR_MULTI_ANALYTICS_CAPTION_V46" "$FILE"
grep -q "LR_NETWORK_CARD_PREMIUM_V46" "$FILE"
grep -q "LR_DIRECT_PUBLIC_IMAGE_V46" "$FILE"
grep -q "lrV34SendMaxImageUrl(update, url, channels)" "$FILE"

echo "[4/8] Проверяю, что изменена только аналитика"

CHANGED="$(git diff --name-only | sort -u)"
printf '%s\n' "$CHANGED"

if [[ "$CHANGED" != "$FILE" ]]; then
  echo "ОШИБКА: обнаружены посторонние изменения"
  exit 1
fi

echo "[5/8] Пересобираю приложение"

docker compose up -d --build app
sleep 14

if ! docker compose ps --status running --services | grep -qx app; then
  echo "ОШИБКА: app не запущен"
  exit 1
fi

docker exec linkray-app sh -lc \
  "node --check /app/$FILE && grep -q LR_NETWORK_CARD_PREMIUM_V46 /app/$FILE"

echo "[6/8] Проверяю логи"

LOGS="$(docker compose logs --since=4m app 2>&1 || true)"

if printf '%s\n' "$LOGS" | grep -Eqi \
  "SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|Cannot find module|Identifier .* already been declared"
then
  printf '%s\n' "$LOGS" | tail -220
  echo "ОШИБКА: критическая ошибка в логах"
  exit 1
fi

echo "[7/8] Сохраняю только это исправление в GitHub"

trap - ERR

git add -- "$FILE"

if ! git diff --cached --quiet; then
  git commit -m "Fix multi-channel analytics report"
  git push origin HEAD:main
else
  echo "Изменения уже применены"
fi

echo "[8/8] Готово"

echo
echo "============================================================"
echo "СВОДНАЯ АНАЛИТИКА V46 ГОТОВА"
echo
echo "• несколько ссылок используют тот же resolveChannel, что одиночный отчёт"
echo "• реальные аватары каналов передаются в PNG"
echo "• новый аккуратный сетевой дизайн без наложения текста"
echo "• тот же основной логотип LinkRay"
echo "• реальные 24 / 48 / 72 часа в картинке и подписи"
echo "• исправлено «0 каналов / 0 просмотров / 0 ER»"
echo "• кнопка 🏠 Главное меню находится под отчётом"
echo "• main:menu открывает отдельное новое сообщение"
echo "• одиночная аналитика не изменялась"
echo "• Studio / автопостинг / AntiFraud / закупы / БД не изменялись"
echo
echo "Backup: $BACKUP"
echo "============================================================"
