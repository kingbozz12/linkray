#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/linkray

FILE="src/linkrayChannelAnalytics.js"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/linkray-backups/multi-analytics-v48-safe-$STAMP"

echo "[1/9] Проверяю репозиторий"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ОШИБКА: в репозитории есть незавершённые изменения."
  git status --short
  exit 2
fi

git fetch origin main --quiet
git pull --ff-only origin main

test -f "$FILE"
mkdir -p "$BACKUP_DIR"
cp -a "$FILE" "$BACKUP_DIR/"

rollback() {
  code=$?
  echo
  echo "[ОТКАТ] Возвращаю исходную аналитику..."
  cp -f "$BACKUP_DIR/$(basename "$FILE")" "$FILE" || true
  docker compose up -d --build app >/dev/null 2>&1 || true
  echo "[ОТКАТ] Выполнен. Backup: $BACKUP_DIR"
  exit "$code"
}
trap rollback ERR

echo "[2/9] Применяю V48 только к четырём существующим участкам"

python3 - "$FILE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
src = path.read_text(encoding="utf-8")
original = src

def replace_range(text, start_token, end_token, replacement, label):
    start = text.find(start_token)
    if start < 0:
        raise SystemExit(f"ОШИБКА: не найден старт {label}: {start_token}")

    end = text.find(end_token, start + len(start_token))
    if end < 0:
        raise SystemExit(f"ОШИБКА: не найден конец {label}: {end_token}")

    if end <= start:
        raise SystemExit(f"ОШИБКА: неверные границы {label}")

    return text[:start] + replacement.rstrip() + "\n\n" + text[end:]

# ------------------------------------------------------------------
# 1) Загрузка нескольких каналов:
# используем существующий resolveChannel — ту же цепочку реальных данных,
# что уже используется одиночной аналитикой.
# ------------------------------------------------------------------
loader = r'''
async function lrV34LoadChannelsByLinks(links) {
  const channels = [];

  for (let i = 0; i < links.length; i++) {
    const link = lrV34NormLink(links[i]);

    let resolved = null;

    try {
      resolved = await resolveChannel(link, {
        _lrIndex: i,
      });
    } catch (error) {
      console.error(
        '[LR_MULTI_V48_RESOLVE]',
        link,
        error?.message || error,
      );
    }

    const ch = resolved || {
      link,
      title: `Канал ${i + 1}`,
      subscribers: 0,
      views24: 0,
      views48: 0,
      views72: 0,
      er24: 0,
      delta_day: 0,
      joined_24h: 0,
      left_24h: 0,
    };

    channels.push({
      ...ch,
      link,
      title:
        ch?.title ||
        ch?.name ||
        ch?.channel_title ||
        ch?.channel_name ||
        `Канал ${i + 1}`,
      avatar_url:
        ch?.avatar_url ||
        ch?.avatarUrl ||
        ch?.photo_url ||
        ch?.image_url ||
        ch?.icon_url ||
        ch?.picture_url ||
        ch?.avatar ||
        ch?.photo ||
        '',
      subscribers: Number(ch?.subscribers || 0),
      views24: Number(ch?.views24 || 0),
      views48: Number(ch?.views48 || 0),
      views72: Number(ch?.views72 || 0),
      er24: Number(ch?.er24 || 0),
      delta_day: Number(ch?.delta_day || ch?.deltaDay || 0),
      joined_24h: Number(ch?.joined_24h || ch?.joined24h || 0),
      left_24h: Number(ch?.left_24h || ch?.left24h || 0),

      // Совместимость с существующей подписью/старыми местами.
      signed: Number(ch?.joined_24h || ch?.joined24h || 0),
      left: Number(ch?.left_24h || ch?.left24h || 0),
    });
  }

  return lrV19DedupeNetworkAvatars(channels);
}
'''

src = replace_range(
    src,
    "async function lrV34LoadChannelsByLinks(links) {",
    "/* LR_SAFE_NETWORK_CARD_V37_START */",
    loader,
    "lrV34LoadChannelsByLinks",
)

# ------------------------------------------------------------------
# 2) Подпись сводного отчёта:
# никаких globalThis — только массив, который реально создал отчёт.
# ------------------------------------------------------------------
caption = r'''
function lrV44AnalyticsCaption(channels = []) {
  function n(value) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function fmt(value) {
    return Math.round(n(value)).toLocaleString('ru-RU');
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
    (sum, ch) => {
      const explicit = ch?.delta_day ?? ch?.deltaDay;

      if (
        explicit !== undefined &&
        explicit !== null &&
        explicit !== ''
      ) {
        return sum + n(explicit);
      }

      return (
        sum +
        n(ch?.joined_24h ?? ch?.joined24h ?? ch?.signed) -
        n(ch?.left_24h ?? ch?.left24h ?? ch?.left)
      );
    },
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
    `🕘 <b>Сформировано:</b> ${now} МСК\n` +
    '━━━━━━━━━━━━━━\n' +
    '✨ <a href="https://max.ru/se13353901_bot">LinkRay</a> — ' +
    'автопостинг и аналитика рекламных размещений в MAX'
  );
}
'''

src = replace_range(
    src,
    "function lrV44AnalyticsCaption(channels = []) {",
    "/* LR_ANALYTICS_CAPTION_V44_END */",
    caption,
    "lrV44AnalyticsCaption",
)

# ------------------------------------------------------------------
# 3) Существующая PNG-функция: новый безопасный 2x2 layout.
# Подпись выше НЕ затрагивается.
# ------------------------------------------------------------------
renderer = r'''
async function lrV40RenderFinalNetworkPng(channels = []) {
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default || sharpMod;
  const fsMod = await import('node:fs/promises');
  const fs = fsMod.default || fsMod;

  const WIDTH = 1280;
  const HEIGHT = 960;

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function n(value) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function fmt(value) {
    return Math.round(n(value)).toLocaleString('ru-RU');
  }

  function compact(value) {
    const x = Math.round(n(value));

    if (Math.abs(x) >= 1000000) {
      return (
        (x / 1000000)
          .toFixed(Math.abs(x) >= 10000000 ? 0 : 1)
          .replace('.', ',') + 'M'
      );
    }

    if (Math.abs(x) >= 1000) {
      return (
        (x / 1000)
          .toFixed(Math.abs(x) >= 10000 ? 0 : 1)
          .replace('.', ',') + 'k'
      );
    }

    return String(x);
  }

  function short(value, max = 30) {
    const text = String(value || 'Канал')
      .replace(/\s+/g, ' ')
      .trim();

    return text.length > max
      ? text.slice(0, max - 1).trim() + '…'
      : text;
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
    const value = String(url || '').trim();

    if (!/^https?:\/\//i.test(value)) return false;

    const low = value.toLowerCase();

    return (
      !low.includes('/s/img/og-logo.png') &&
      !low.includes('favicon') &&
      !low.includes('app-icon')
    );
  }

  async function imageData(url, size = 80) {
    if (!goodUrl(url)) return '';

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: {
          'user-agent': 'Mozilla/5.0 LinkRayBot/1.0',
          'accept':
            'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
          'referer': 'https://max.ru/',
        },
      });

      if (!response.ok) return '';

      const input = Buffer.from(
        await response.arrayBuffer(),
      );

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
      raw?.title ||
      raw?.name ||
      raw?.channel_title ||
      raw?.channel_name ||
      `Канал ${i + 1}`
    )
      .replace(/\s+/g, ' ')
      .trim();

    const link = String(
      raw?.link ||
      raw?.url ||
      raw?.key ||
      ''
    ).trim();

    const key = link || title || String(i);

    if (seen.has(key)) continue;
    seen.add(key);

    clean.push({
      ...raw,
      title,
      link,
      avatar: avatarUrl(raw),
      subscribers: n(raw?.subscribers),
      views24: n(raw?.views24),
      views48: n(raw?.views48),
      views72: n(raw?.views72),
      er24: n(raw?.er24),
      deltaDay: n(raw?.delta_day ?? raw?.deltaDay),
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

  const cardPositions = [
    [430, 336],
    [824, 336],
    [430, 570],
    [824, 570],
  ];

  let cards = '';
  let defs = '';

  for (let i = 0; i < visible.length; i++) {
    const ch = visible[i];
    const [x, y] = cardPositions[i];

    const avatar = await imageData(
      ch.avatar,
      84,
    );

    const avatarX = x + 36;
    const avatarY = y + 31;
    const avatarR = 37;
    const clipId = `lrV48AvatarClip_${i}`;

    let avatarSvg = '';

    if (avatar) {
      defs += `
        <clipPath id="${clipId}">
          <circle
            cx="${avatarX + avatarR}"
            cy="${avatarY + avatarR}"
            r="${avatarR}"
          />
        </clipPath>
      `;

      avatarSvg = `
        <circle
          cx="${avatarX + avatarR}"
          cy="${avatarY + avatarR}"
          r="${avatarR + 2}"
          fill="#0b3a46"
          stroke="#4ce6c0"
          stroke-width="2"
        />
        <image
          href="${avatar}"
          x="${avatarX}"
          y="${avatarY}"
          width="${avatarR * 2}"
          height="${avatarR * 2}"
          preserveAspectRatio="xMidYMid slice"
          clip-path="url(#${clipId})"
        />
      `;
    } else {
      const letter = esc(
        (String(ch.title || 'К').trim()[0] || 'К')
          .toUpperCase(),
      );

      avatarSvg = `
        <circle
          cx="${avatarX + avatarR}"
          cy="${avatarY + avatarR}"
          r="${avatarR + 2}"
          fill="url(#fallback${i})"
          stroke="#4ce6c0"
          stroke-width="2"
        />
        <text
          x="${avatarX + avatarR}"
          y="${avatarY + avatarR + 10}"
          text-anchor="middle"
          class="avatar-letter"
        >${letter}</text>
      `;
    }

    const er =
      ch.er24 > 0
        ? ch.er24
        : (
            ch.subscribers > 0
              ? (ch.views24 / ch.subscribers) * 100
              : 0
          );

    cards += `
      <g>
        <rect
          x="${x}"
          y="${y}"
          width="366"
          height="206"
          rx="27"
          fill="#0b3541"
          fill-opacity=".76"
          stroke="#9bf2dd"
          stroke-opacity=".14"
        />

        ${avatarSvg}

        <text
          x="${x + 128}"
          y="${y + 61}"
          class="channel-title"
        >${esc(short(ch.title, 25))}</text>

        <line
          x1="${x + 28}"
          y1="${y + 124}"
          x2="${x + 338}"
          y2="${y + 124}"
          stroke="#b4e8df"
          stroke-opacity=".12"
        />

        <text
          x="${x + 31}"
          y="${y + 153}"
          class="small-label"
        >ПДП</text>
        <text
          x="${x + 31}"
          y="${y + 185}"
          class="small-value"
        >${compact(ch.subscribers)}</text>

        <text
          x="${x + 151}"
          y="${y + 153}"
          class="small-label"
        >24 часа</text>
        <text
          x="${x + 151}"
          y="${y + 185}"
          class="small-value cyan"
        >${compact(ch.views24)}</text>

        <text
          x="${x + 273}"
          y="${y + 153}"
          class="small-label"
        >ER24</text>
        <text
          x="${x + 273}"
          y="${y + 185}"
          class="small-value green"
        >${er.toFixed(1).replace('.', ',')}%</text>
      </g>
    `;
  }

  const svg = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="${WIDTH}"
    height="${HEIGHT}"
    viewBox="0 0 ${WIDTH} ${HEIGHT}"
  >
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#063b46"/>
        <stop offset="52%" stop-color="#07545c"/>
        <stop offset="100%" stop-color="#079b70"/>
      </linearGradient>

      <radialGradient id="glow" cx="88%" cy="88%" r="78%">
        <stop
          offset="0%"
          stop-color="#3affb9"
          stop-opacity=".24"
        />
        <stop
          offset="100%"
          stop-color="#3affb9"
          stop-opacity="0"
        />
      </radialGradient>

      <linearGradient id="metric" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#154f5b"/>
        <stop offset="100%" stop-color="#137761"/>
      </linearGradient>

      <linearGradient id="fallback0" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#24e2ff"/>
        <stop offset="100%" stop-color="#1970e5"/>
      </linearGradient>
      <linearGradient id="fallback1" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#4cf0c8"/>
        <stop offset="100%" stop-color="#0a9975"/>
      </linearGradient>
      <linearGradient id="fallback2" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#9c8cff"/>
        <stop offset="100%" stop-color="#4c55c9"/>
      </linearGradient>
      <linearGradient id="fallback3" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ffd769"/>
        <stop offset="100%" stop-color="#e67527"/>
      </linearGradient>

      <clipPath id="logoClip">
        <circle cx="1162" cy="78" r="44"/>
      </clipPath>

      ${defs}
    </defs>

    <style>
      text {
        font-family:
          "DejaVu Sans",
          Arial,
          sans-serif;
      }

      .title {
        fill: #f5ffff;
        font-size: 44px;
        font-weight: 800;
      }

      .subtitle {
        fill: #abd8d6;
        font-size: 18px;
        font-weight: 500;
      }

      .metric-label {
        fill: #b9d9d8;
        font-size: 17px;
        font-weight: 600;
      }

      .metric-value {
        fill: #42eac0;
        font-size: 37px;
        font-weight: 900;
      }

      .metric-value.cyan {
        fill: #43dbff;
      }

      .panel-title {
        fill: #f5ffff;
        font-size: 29px;
        font-weight: 800;
      }

      .views-label {
        fill: #d8eeee;
        font-size: 23px;
        font-weight: 700;
      }

      .views-value {
        fill: #47e1fb;
        font-size: 28px;
        font-weight: 900;
      }

      .channel-title {
        fill: #f5ffff;
        font-size: 19px;
        font-weight: 800;
      }

      .small-label {
        fill: #91bdbb;
        font-size: 14px;
        font-weight: 700;
      }

      .small-value {
        fill: #eefafa;
        font-size: 23px;
        font-weight: 900;
      }

      .small-value.cyan {
        fill: #48def8;
      }

      .small-value.green {
        fill: #71efb8;
      }

      .avatar-letter {
        fill: #ffffff;
        font-size: 28px;
        font-weight: 900;
      }

      .footer {
        fill: #c9e8e2;
        font-size: 16px;
        font-weight: 600;
      }

      .footer-muted {
        fill: #96c2bd;
        font-size: 14px;
      }
    </style>

    <rect
      width="${WIDTH}"
      height="${HEIGHT}"
      rx="36"
      fill="url(#bg)"
    />

    <rect
      width="${WIDTH}"
      height="${HEIGHT}"
      rx="36"
      fill="url(#glow)"
    />

    <text x="61" y="71" class="title">
      Статистика сети каналов
    </text>

    <text x="63" y="105" class="subtitle">
      LinkRay Analytics · сводка по выбранным каналам
    </text>

    ${
      logo
        ? `
          <circle
            cx="1162"
            cy="78"
            r="47"
            fill="#ffffff"
            fill-opacity=".10"
            stroke="#91ffe2"
            stroke-opacity=".32"
            stroke-width="2"
          />
          <image
            href="${logo}"
            x="1118"
            y="34"
            width="88"
            height="88"
            preserveAspectRatio="xMidYMid slice"
            clip-path="url(#logoClip)"
          />
        `
        : `
          <text
            x="1207"
            y="87"
            text-anchor="end"
            class="panel-title"
          >LinkRay</text>
        `
    }

    <g>
      <rect
        x="61"
        y="144"
        width="271"
        height="120"
        rx="23"
        fill="url(#metric)"
        stroke="#95f5df"
        stroke-opacity=".14"
      />
      <text x="86" y="183" class="metric-label">
        Подписчики
      </text>
      <text x="86" y="237" class="metric-value cyan">
        ${compact(totalSubscribers)}
      </text>
    </g>

    <g>
      <rect
        x="354"
        y="144"
        width="271"
        height="120"
        rx="23"
        fill="url(#metric)"
        stroke="#95f5df"
        stroke-opacity=".14"
      />
      <text x="379" y="183" class="metric-label">
        Просмотры 24 ч
      </text>
      <text x="379" y="237" class="metric-value">
        ${compact(total24)}
      </text>
    </g>

    <g>
      <rect
        x="647"
        y="144"
        width="271"
        height="120"
        rx="23"
        fill="url(#metric)"
        stroke="#95f5df"
        stroke-opacity=".14"
      />
      <text x="672" y="183" class="metric-label">
        Средний ER24
      </text>
      <text x="672" y="237" class="metric-value cyan">
        ${totalEr.toFixed(2).replace('.', ',')}%
      </text>
    </g>

    <g>
      <rect
        x="940"
        y="144"
        width="271"
        height="120"
        rx="23"
        fill="url(#metric)"
        stroke="#95f5df"
        stroke-opacity=".14"
      />
      <text x="965" y="183" class="metric-label">
        Каналов
      </text>
      <text x="965" y="237" class="metric-value">
        ${fmt(clean.length)}
      </text>
    </g>

    <rect
      x="61"
      y="305"
      width="340"
      height="471"
      rx="28"
      fill="#092f3a"
      fill-opacity=".72"
      stroke="#91ead6"
      stroke-opacity=".14"
    />

    <text x="91" y="357" class="panel-title">
      Просмотры
    </text>

    <text x="91" y="425" class="views-label">
      24 часа
    </text>
    <text
      x="366"
      y="425"
      text-anchor="end"
      class="views-value"
    >${compact(total24)}</text>

    <line
      x1="91"
      y1="451"
      x2="366"
      y2="451"
      stroke="#b4e4dd"
      stroke-opacity=".12"
    />

    <text x="91" y="511" class="views-label">
      48 часов
    </text>
    <text
      x="366"
      y="511"
      text-anchor="end"
      class="views-value"
    >${compact(total48)}</text>

    <line
      x1="91"
      y1="537"
      x2="366"
      y2="537"
      stroke="#b4e4dd"
      stroke-opacity=".12"
    />

    <text x="91" y="597" class="views-label">
      72 часа
    </text>
    <text
      x="366"
      y="597"
      text-anchor="end"
      class="views-value"
    >${compact(total72)}</text>

    <line
      x1="91"
      y1="638"
      x2="366"
      y2="638"
      stroke="#b4e4dd"
      stroke-opacity=".12"
    />

    <text x="91" y="691" class="metric-label">
      Изменение за сутки
    </text>

    <text x="91" y="744" class="metric-value">
      ${totalDelta > 0 ? '+' : ''}${fmt(totalDelta)}
    </text>

    ${cards}

    <line
      x1="61"
      y1="834"
      x2="1211"
      y2="834"
      stroke="#c1eee6"
      stroke-opacity=".17"
    />

    <text x="61" y="877" class="footer">
      Актуально на ${esc(now)} МСК
    </text>

    <text
      x="1211"
      y="877"
      text-anchor="end"
      class="footer"
    >
      LinkRay — аналитика каналов MAX
    </text>

    <text x="61" y="913" class="footer-muted">
      ${
        clean.length > 4
          ? `На карточке показано 4 из ${fmt(clean.length)} каналов · общие суммы по всем.`
          : 'Общие суммы рассчитаны по всем выбранным каналам.'
      }
    </text>
  </svg>`;

  console.log(
    '[LR_NETWORK_CARD_V48]',
    JSON.stringify({
      channels: clean.length,
      visible: visible.length,
      avatars: visible.filter(
        (ch) => goodUrl(ch.avatar),
      ).length,
      total24,
      total48,
      total72,
    }),
  );

  return await sharp(
    Buffer.from(svg),
  ).png().toBuffer();
}
'''

src = replace_range(
    src,
    "async function lrV40RenderFinalNetworkPng(channels = []) {",
    "/* LR_NETWORK_CARD_FINAL_V40_END */",
    renderer,
    "lrV40RenderFinalNetworkPng",
)

# ------------------------------------------------------------------
# 4) Sender: реальный channels + кнопка меню под отчётом.
# ------------------------------------------------------------------
sender = r'''
async function lrV34SendMaxImageUrl(
  update,
  imageUrl,
  channels = [],
) {
  const token = lrV34MaxToken();

  if (!token) {
    throw new Error('MAX token not found');
  }

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
        [
          lrCb(
            '🏠 Главное меню',
            'main:menu',
          ),
        ],
      ]),
    ],
  };

  const response = await fetch(
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

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `MAX image url send failed ${response.status}: ${responseText}`,
    );
  }

  console.log(
    '[LR_DIRECT_PUBLIC_IMAGE_V48]',
    JSON.stringify({
      channels: Array.isArray(channels)
        ? channels.length
        : 0,
      imageUrl,
      mainMenuButton: true,
    }),
  );

  return true;
}
'''

src = replace_range(
    src,
    "async function lrV34SendMaxImageUrl(",
    "async function lrV34TryDirectPublicNetworkCard(update)",
    sender,
    "lrV34SendMaxImageUrl",
)

old_call = "await lrV34SendMaxImageUrl(update, url);"
new_call = "await lrV34SendMaxImageUrl(update, url, channels);"

old_count = src.count(old_call)
new_count = src.count(new_call)

if old_count == 1 and new_count == 0:
    src = src.replace(
        old_call,
        new_call,
        1,
    )
elif old_count == 0 and new_count == 1:
    pass
else:
    raise SystemExit(
        f"ОШИБКА: sender-call: old={old_count}, new={new_count}; файл не сохранён"
    )

# ------------------------------------------------------------------
# Финальные структурные проверки ДО записи.
# ------------------------------------------------------------------
required = [
    "async function lrV34LoadChannelsByLinks(links) {",
    "await resolveChannel(link, {",
    "function lrV44AnalyticsCaption(channels = []) {",
    "async function lrV40RenderFinalNetworkPng(channels = []) {",
    "[LR_NETWORK_CARD_V48]",
    "async function lrV34SendMaxImageUrl(",
    "lrV44AnalyticsCaption(channels)",
    "lrCb(",
    "'🏠 Главное меню'",
    "'main:menu'",
    "await lrV34SendMaxImageUrl(update, url, channels);",
]

for token in required:
    if token not in src:
        raise SystemExit(
            f"ОШИБКА: итоговая проверка не нашла: {token}"
        )

for token in [
    "async function lrV34LoadChannelsByLinks(links) {",
    "function lrV44AnalyticsCaption(channels = []) {",
    "async function lrV40RenderFinalNetworkPng(channels = []) {",
    "async function lrV34SendMaxImageUrl(",
]:
    if src.count(token) != 1:
        raise SystemExit(
            f"ОШИБКА: {token} встречается {src.count(token)} раз"
        )

if src == original:
    raise SystemExit("ОШИБКА: изменений нет")

path.write_text(src, encoding="utf-8")

print("OK: V48 записан в один файл.")
PY

echo "[3/9] Проверяю JavaScript и diff"

node --check "$FILE"
git diff --check

python3 - "$FILE" <<'PY'
from pathlib import Path
import sys

s = Path(sys.argv[1]).read_text(encoding="utf-8")

checks = {
    "V48 renderer": "[LR_NETWORK_CARD_V48]" in s,
    "channels in sender": "lrV44AnalyticsCaption(channels)" in s,
    "channels passed": "lrV34SendMaxImageUrl(update, url, channels)" in s,
    "main menu": "'🏠 Главное меню'" in s and "'main:menu'" in s,
    "resolveChannel": "await resolveChannel(link, {" in s,
}

failed = [
    name
    for name, ok in checks.items()
    if not ok
]

if failed:
    raise SystemExit(
        "ОШИБКА итоговой проверки: " + ", ".join(failed)
    )

print("OK:", ", ".join(checks))
PY

echo "[4/9] Проверяю изолированность"

CHANGED="$(git diff --name-only | sort -u)"
printf '%s\n' "$CHANGED"

if [[ "$CHANGED" != "$FILE" ]]; then
  echo "ОШИБКА: изменён не только $FILE"
  exit 1
fi

echo "[5/9] Пересобираю только app"

docker compose up -d --build app
sleep 14

if ! docker compose ps --status running --services | grep -qx app; then
  echo "ОШИБКА: app не запущен"
  exit 1
fi

echo "[6/9] Проверяю код внутри контейнера"

docker exec linkray-app sh -lc \
  "node --check /app/$FILE"

docker exec linkray-app sh -lc \
  "grep -Fq '[LR_NETWORK_CARD_V48]' /app/$FILE"

echo "[7/9] Проверяю стартовые логи"

LOGS="$(
  docker compose logs --since=4m app 2>&1 || true
)"

if printf '%s\n' "$LOGS" | grep -Eqi \
  "SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|Cannot find module|Identifier .* already been declared"
then
  printf '%s\n' "$LOGS" | tail -220
  echo "ОШИБКА: критическая ошибка после сборки"
  exit 1
fi

echo "[8/9] Сохраняю только исправленную аналитику в GitHub"

trap - ERR

git add -- "$FILE"

if ! git diff --cached --quiet; then
  git commit -m "Fix multi-channel analytics safely"
  git push origin HEAD:main
else
  echo "Изменения уже применены"
fi

echo "[9/9] Готово"

echo
echo "============================================================"
echo "LINKRAY MULTI ANALYTICS V48 SAFE"
echo
echo "• изменён только src/linkrayChannelAnalytics.js"
echo "• несколько ссылок используют существующий resolveChannel"
echo "• реальные аватары передаются в карточку"
echo "• карточка перестроена в аккуратные 2×2 блоки"
echo "• основной логотип LinkRay сохранён"
echo "• подпись получает реальные channels, без global fallback"
echo "• 24 / 48 / 72 и ER в подписи больше не должны быть нулевыми"
echo "• добавлена кнопка 🏠 Главное меню"
echo "• callback остаётся существующим main:menu"
echo "• одиночная аналитика / Studio / AntiFraud / закупы / БД не менялись"
echo
echo "Backup: $BACKUP_DIR"
echo "============================================================"
