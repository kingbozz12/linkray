#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/linkray

echo "[1/8] Сверяю текущую версию GitHub"
git pull --ff-only

HTML="public/linkray-site/cabinet-stable.html"
[ -f "$HTML" ] || { echo "ОШИБКА: не найден $HTML"; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/linkray-backups/cabinet-notification-clear-v13-$STAMP"
mkdir -p "$BACKUP_DIR"

cp -a "$HTML" "$BACKUP_DIR/"

echo "[2/8] Определяю первый реально загружаемый JS кабинета"
TARGET_JS="$(python3 - <<'PY'
import re
from pathlib import Path

html = Path("public/linkray-site/cabinet-stable.html").read_text(encoding="utf-8")
scripts = re.findall(r'<script\b[^>]*\bsrc=["\']([^"\']+)["\'][^>]*>', html, flags=re.I)

preferred = (
    "cabinet-boot.js",
    "cabinet-stable.js",
    "cabinet-control-center.js",
)

for src in scripts:
    clean = src.split("?", 1)[0].split("#", 1)[0]
    name = clean.rsplit("/", 1)[-1]
    if name in preferred:
        path = Path("public/linkray-site") / name
        if path.exists():
            print(path.as_posix())
            raise SystemExit

raise SystemExit(2)
PY
)" || {
  echo "ОШИБКА: не удалось определить ранний JS кабинета."
  exit 1
}

echo "Выбран: $TARGET_JS"
cp -a "$TARGET_JS" "$BACKUP_DIR/"

echo "[3/8] Добавляю синхронизацию верхнего Центра событий с очищенной историей"
python3 - "$TARGET_JS" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
marker = "LINKRAY_CABINET_CENTER_CLEAR_SYNC_V13"

if marker in text:
    print("V13 уже установлен — повторно не добавляю.")
    raise SystemExit(0)

patch = r'''
/* LINKRAY_CABINET_CENTER_CLEAR_SYNC_V13
 * Верхний "Центр событий" больше не показывает те же уведомления,
 * которые пользователь уже очистил в "Уведомлениях кабинета".
 * Новое событие с новым содержимым/счётчиком снова появится.
 * Только сайт: бот, Studio, AntiFraud MAX и БД не меняются.
 */
(() => {
  'use strict';

  if (window.__LINKRAY_CABINET_CENTER_CLEAR_SYNC_V13__) return;
  window.__LINKRAY_CABINET_CENTER_CLEAR_SYNC_V13__ = true;

  const originalFetch = window.fetch.bind(window);
  const TTL_MS = 36 * 60 * 60 * 1000;

  let currentUserKey = 'anonymous';
  let lastRawCenterNotifications = [];
  let reloadScheduled = false;

  const asText = (value) => String(value ?? '').trim();

  const requestPath = (input) => {
    try {
      const raw =
        typeof input === 'string'
          ? input
          : input && typeof input.url === 'string'
            ? input.url
            : '';
      return new URL(raw, window.location.origin).pathname;
    } catch (_) {
      return '';
    }
  };

  const notificationFingerprint = (item) => {
    if (!item || typeof item !== 'object') return asText(item);

    const parts = [
      item.type,
      item.level,
      item.code,
      item.channelId,
      item.channel_id,
      item.title,
      item.text,
      item.message,
      item.reason,
    ].map(asText);

    if (parts.some(Boolean)) return JSON.stringify(parts);

    try {
      return JSON.stringify(item);
    } catch (_) {
      return asText(item);
    }
  };

  const storageKey = () =>
    `linkray.cabinet.center-dismissed.v13.${asText(currentUserKey) || 'anonymous'}`;

  const readDismissed = () => {
    const now = Date.now();
    let raw = {};

    try {
      raw = JSON.parse(localStorage.getItem(storageKey()) || '{}') || {};
    } catch (_) {
      raw = {};
    }

    const clean = {};
    for (const [key, value] of Object.entries(raw)) {
      const ts = Number(value || 0);
      if (Number.isFinite(ts) && now - ts <= TTL_MS) clean[key] = ts;
    }

    try {
      localStorage.setItem(storageKey(), JSON.stringify(clean));
    } catch (_) {}

    return clean;
  };

  const writeDismissed = (items) => {
    if (!Array.isArray(items) || !items.length) return;

    const saved = readDismissed();
    const now = Date.now();

    for (const item of items) {
      const fingerprint = notificationFingerprint(item);
      if (fingerprint) saved[fingerprint] = now;
    }

    try {
      localStorage.setItem(storageKey(), JSON.stringify(saved));
    } catch (_) {}
  };

  const filterDismissed = (items) => {
    if (!Array.isArray(items)) return items;

    const dismissed = readDismissed();

    return items.filter((item) => {
      const fingerprint = notificationFingerprint(item);
      return !fingerprint || !dismissed[fingerprint];
    });
  };

  const detectUser = (node) => {
    if (!node || typeof node !== 'object') return;

    const user = node.user;
    if (user && typeof user === 'object') {
      const id =
        user.id ??
        user.linkrayId ??
        user.linkray_id ??
        user.maxUserId ??
        user.max_user_id;

      if (id !== undefined && id !== null && asText(id)) {
        currentUserKey = asText(id);
      }
    }
  };

  const rewriteNotificationArrays = (node, seen = new WeakSet()) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    detectUser(node);

    if (Array.isArray(node.notifications)) {
      lastRawCenterNotifications = node.notifications.slice();
      node.notifications = filterDismissed(node.notifications);
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'notificationHistory') continue;
      if (value && typeof value === 'object') {
        rewriteNotificationArrays(value, seen);
      }
    }
  };

  const scheduleReload = () => {
    if (reloadScheduled) return;
    reloadScheduled = true;

    window.setTimeout(() => {
      try {
        window.location.reload();
      } catch (_) {}
    }, 180);
  };

  const maybeSyncAlreadyClearedHistory = (payload) => {
    if (!payload || typeof payload !== 'object') return;

    const history = payload.notificationHistory;

    /*
     * После прежней очистки история уже может быть пустой,
     * а старый динамический Центр событий ещё показывать карточки.
     * В таком состоянии считаем именно эти старые карточки очищенными.
     */
    if (
      Array.isArray(history) &&
      history.length === 0 &&
      lastRawCenterNotifications.length > 0
    ) {
      const visible = filterDismissed(lastRawCenterNotifications);

      if (visible.length > 0) {
        writeDismissed(visible);

        const onceKey =
          `linkray.cabinet.center-clear-autosync.v13.${asText(currentUserKey)}`;
        try {
          if (sessionStorage.getItem(onceKey) !== '1') {
            sessionStorage.setItem(onceKey, '1');
            scheduleReload();
          }
        } catch (_) {}
      }
    }
  };

  const rewriteJsonResponse = async (response) => {
    const contentType = asText(response.headers.get('content-type')).toLowerCase();
    if (!contentType.includes('application/json')) return response;

    let payload;
    try {
      payload = await response.clone().json();
    } catch (_) {
      return response;
    }

    detectUser(payload);
    rewriteNotificationArrays(payload);
    maybeSyncAlreadyClearedHistory(payload);

    const headers = new Headers(response.headers);
    headers.delete('content-length');

    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  window.fetch = async (...args) => {
    const path = requestPath(args[0]);
    const response = await originalFetch(...args);

    const isCabinetRead =
      path === '/api/website/cabinet/full' ||
      path === '/api/website/cabinet/overview' ||
      path === '/api/website/cabinet/operations';

    if (response.ok && isCabinetRead) {
      return rewriteJsonResponse(response);
    }

    if (
      response.ok &&
      path === '/api/website/cabinet/notifications/clear'
    ) {
      /*
       * Сначала сервер штатно очищает историю/БД.
       * Затем помечаем текущие карточки Центра событий как уже очищенные.
       */
      writeDismissed(lastRawCenterNotifications);
      scheduleReload();
    }

    return response;
  };
})();

'''

path.write_text(patch + "\n" + text, encoding="utf-8")
print(f"V13 добавлен в {path}")
PY

echo "[4/8] Обновляю cache-bust только выбранного JS"
python3 - "$HTML" "$TARGET_JS" <<'PY'
from pathlib import Path
import re
import sys

html_path = Path(sys.argv[1])
target_path = Path(sys.argv[2])
name = target_path.name

html = html_path.read_text(encoding="utf-8")
version = "20260807-center-clear-v13"

pattern = re.compile(
    rf'(<script\b[^>]*\bsrc=["\'][^"\']*{re.escape(name)})(?:\?[^"\']*)?(["\'][^>]*>)',
    re.I,
)

new_html, count = pattern.subn(rf'\1?v={version}\2', html, count=1)

if count != 1:
    raise SystemExit(f"Не удалось обновить cache-bust для {name}: найдено {count}")

html_path.write_text(new_html, encoding="utf-8")
print(f"Cache-bust обновлён: {name}?v={version}")
PY

echo "[5/8] Проверяю, что изменены только файлы кабинета"
git diff -- "$HTML" "$TARGET_JS"
echo
echo "Другие изменённые файлы:"
git status --short

echo "[6/8] Пересобираю только приложение"
SERVICE="$(docker compose config --services 2>/dev/null | grep -E '^(app|linkray-app)$' | head -n1 || true)"
if [ -n "$SERVICE" ]; then
  docker compose up -d --build "$SERVICE"
else
  docker compose up -d --build
fi

sleep 3

echo "[7/8] Проверяю запуск"
docker ps --format '{{.Names}} {{.Status}}' | grep -E '^linkray-app ' || true
printf 'Главная: '
curl -ksS -o /dev/null -w '%{http_code}\n' https://linkray.ru/
printf 'Кабинет: '
curl -ksS -o /dev/null -w '%{http_code}\n' https://linkray.ru/cabinet

echo "[8/8] Сохраняю изолированное исправление в GitHub"
git add "$HTML" "$TARGET_JS"
if git diff --cached --quiet; then
  echo "Изменений для коммита нет."
else
  git commit -m "Sync cabinet notification center with cleared history"
  git push origin HEAD:main
fi

echo
echo "============================================================"
echo "V13 ГОТОВ"
echo "• Очистка «Уведомлений кабинета» теперь очищает и верхний Центр событий."
echo "• Уже очищенная пустая история автоматически убирает старые карточки Центра."
echo "• Новые события с новым содержимым/счётчиком снова появятся."
echo "• База, Studio, автопостинг, добавление/удаление каналов и AntiFraud MAX не менялись."
echo "Резервная копия: $BACKUP_DIR"
echo "============================================================"
