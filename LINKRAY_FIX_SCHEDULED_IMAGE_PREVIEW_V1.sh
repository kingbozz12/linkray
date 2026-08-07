#!/usr/bin/env bash
set -euo pipefail
cd /opt/linkray

echo "============================================================"
echo "LINKRAY — FIX SCHEDULED IMAGE + LINK PREVIEW"
echo "Только src/autopostWorker.js и src/maxClient.js"
echo "============================================================"

F1="src/autopostWorker.js"
F2="src/maxClient.js"

[ -f "$F1" ] || { echo "ERROR: $F1 не найден"; exit 1; }
[ -f "$F2" ] || { echo "ERROR: $F2 не найден"; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/linkray-backups/autopost-media-preview-$STAMP"
mkdir -p "$BACKUP"
cp "$F1" "$BACKUP/"
cp "$F2" "$BACKUP/"
echo "Backup: $BACKUP"

python3 - <<'PY'
from pathlib import Path
import re, sys

worker = Path("src/autopostWorker.js")
maxc = Path("src/maxClient.js")

w = worker.read_text(encoding="utf-8")
m = maxc.read_text(encoding="utf-8")

# 1) Scheduled images: the DB stores both payload.url and payload.token.
# For images, MAX officially supports direct URL. Prefer it so forwarded/old
# attachment tokens are not the only source used at publish time.
marker_w = "LINKRAY_SCHEDULED_IMAGE_URL_V1"
if marker_w not in w:
    old = """if (type.includes('image') || type.includes('photo')) {
    if (p.token) return { type: 'image', payload: { token: p.token } };
    if (a.token) return { type: 'image', payload: { token: a.token } };
    if (Array.isArray(p.photos)) return { type: 'image', payload: { photos: p.photos } };
  }"""
    new = """if (type.includes('image') || type.includes('photo')) {
    // LINKRAY_SCHEDULED_IMAGE_URL_V1
    // Scheduled/forwarded posts may contain a reusable public image URL plus
    // a token originating from an incoming MAX message. For images MAX
    // supports payload.url directly, so prefer the stored URL and keep token
    // as a fallback when URL is absent.
    const directUrl = String(p.url || a.url || '').trim();
    if (/^https?:\\/\\//i.test(directUrl)) {
      return { type: 'image', payload: { url: directUrl } };
    }
    if (p.token) return { type: 'image', payload: { token: p.token } };
    if (a.token) return { type: 'image', payload: { token: a.token } };
    if (Array.isArray(p.photos)) return { type: 'image', payload: { photos: p.photos } };
  }"""
    if old not in w:
        print("ERROR: не найден точный блок normalizeAttachment(image) в autopostWorker.js")
        sys.exit(2)
    w = w.replace(old, new, 1)

# 2) MAX disable_link_preview is a POST /messages QUERY parameter, not a body field.
marker_m = "LINKRAY_DISABLE_LINK_PREVIEW_QUERY_V1"
if marker_m not in m:
    needle = """  } else {
    throw new Error('chatId or userId is required');
  }
  await lrAssertChannelSendAllowed({"""
    replacement = """  } else {
    throw new Error('chatId or userId is required');
  }
  // LINKRAY_DISABLE_LINK_PREVIEW_QUERY_V1
  // MAX API expects disable_link_preview in POST /messages query params.
  url.searchParams.set('disable_link_preview', 'true');
  await lrAssertChannelSendAllowed({"""
    if needle not in m:
        print("ERROR: не найдена точка sendMaxMessage для query-параметра")
        sys.exit(3)
    m = m.replace(needle, replacement, 1)

worker.write_text(w, encoding="utf-8")
maxc.write_text(m, encoding="utf-8")
print("OK: точечные изменения внесены")
PY

echo
echo "[1/5] Проверяю синтаксис"
node --check "$F1"
node --check "$F2"
git diff --check -- "$F1" "$F2"

echo
echo "[2/5] Показываю только затронутый diff"
git diff -- "$F1" "$F2"

echo
echo "[3/5] Пересобираю контейнеры"
docker compose up -d --build

echo
echo "[4/5] Проверяю запуск"
sleep 3
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'NAMES|linkray-app|linkray-postgres|linkray-redis' || true
docker logs linkray-app --since 2m 2>&1 | tail -n 80 || true

echo
echo "[5/5] Сохраняю только эти 2 файла в GitHub"
git add "$F1" "$F2"
if git diff --cached --quiet; then
  echo "Изменения уже присутствуют — коммит не нужен."
else
  git commit -m "Fix scheduled image delivery and disable link previews"
  git push
fi

echo
echo "============================================================"
echo "ГОТОВО"
echo "- отложенные изображения: URL -> token fallback"
echo "- preview ссылок: disable_link_preview=true в query POST /messages"
echo "- другие локально изменённые файлы НЕ добавлялись в коммит"
echo "- никаких тестовых постов автоматически не отправлялось"
echo "============================================================"
