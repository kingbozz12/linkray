#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/linkray

F1="src/autopostWorker.js"
F2="src/maxClient.js"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/linkray-backups/autopost-media-preview-v2-$STAMP"

echo "============================================================"
echo "LINKRAY — SCHEDULED IMAGE + LINK PREVIEW FIX V2"
echo "Точечно: $F1 + $F2"
echo "============================================================"

[ -f "$F1" ] || { echo "ERROR: нет $F1"; exit 1; }
[ -f "$F2" ] || { echo "ERROR: нет $F2"; exit 1; }

mkdir -p "$BACKUP"
cp "$F1" "$BACKUP/autopostWorker.js"
cp "$F2" "$BACKUP/maxClient.js"
echo "Backup: $BACKUP"

rollback() {
  code=$?
  if [ "$code" -ne 0 ]; then
    echo
    echo "[ОТКАТ] Ошибка. Возвращаю только два изменяемых файла."
    cp "$BACKUP/autopostWorker.js" "$F1" || true
    cp "$BACKUP/maxClient.js" "$F2" || true
    docker compose up -d --build >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap rollback ERR

python3 - <<'PY'
from pathlib import Path
import re, sys

worker_path = Path("src/autopostWorker.js")
client_path = Path("src/maxClient.js")
w = worker_path.read_text(encoding="utf-8")
m = client_path.read_text(encoding="utf-8")

# ------------------------------------------------------------------
# 1. AUTPOST: изображение. В актуальном коде normalizeAttachment()
#    игнорирует payload.url и берёт token. Для отложенных постов
#    предпочитаем сохранённый URL; token остаётся fallback.
# ------------------------------------------------------------------
worker_marker = "LINKRAY_SCHEDULED_IMAGE_URL_V2"
if worker_marker not in w:
    start = w.find("function normalizeAttachment(a)")
    end = w.find("function normalizeAttachments", start)
    if start < 0 or end < 0:
        raise SystemExit("ERROR: не найден normalizeAttachment() в autopostWorker.js")

    chunk = w[start:end]
    pattern = re.compile(
        r"""if\s*\(type\.includes\('image'\)\s*\|\|\s*type\.includes\('photo'\)\)\s*\{\s*
            if\s*\(p\.token\)\s*return\s*\{\s*type:\s*'image',\s*payload:\s*\{\s*token:\s*p\.token\s*\}\s*\};\s*
            if\s*\(a\.token\)\s*return\s*\{\s*type:\s*'image',\s*payload:\s*\{\s*token:\s*a\.token\s*\}\s*\};\s*
            if\s*\(Array\.isArray\(p\.photos\)\)\s*return\s*\{\s*type:\s*'image',\s*payload:\s*\{\s*photos:\s*p\.photos\s*\}\s*\};\s*
        \}""",
        re.X | re.S,
    )

    replacement = """if (type.includes('image') || type.includes('photo')) {
    // LINKRAY_SCHEDULED_IMAGE_URL_V2
    // Для отложенной картинки используем сохранённый URL, если он есть.
    // MAX поддерживает attachments.payload.url для image.
    // Старый token остаётся запасным вариантом.
    const directUrl = String(p.url || a.url || '').trim();
    if (/^https?:\\/\\//i.test(directUrl)) {
      return { type: 'image', payload: { url: directUrl } };
    }
    if (p.token) return { type: 'image', payload: { token: p.token } };
    if (a.token) return { type: 'image', payload: { token: a.token } };
    if (Array.isArray(p.photos)) return { type: 'image', payload: { photos: p.photos } };
  }"""

    chunk2, n = pattern.subn(replacement, chunk, count=1)
    if n != 1:
        print("ERROR: актуальный image-блок normalizeAttachment не совпал.")
        print("Ничего не записано.")
        sys.exit(21)
    w = w[:start] + chunk2 + w[end:]

# ------------------------------------------------------------------
# 2. MAX: disable_link_preview по документации — query-параметр POST /messages.
#    В предыдущем V1 искалась слишком жёсткая текстовая последовательность.
#    Здесь патчим непосредственно внутри актуальной sendMaxMessage().
# ------------------------------------------------------------------
client_marker = "LINKRAY_DISABLE_LINK_PREVIEW_QUERY_V2"
if client_marker not in m:
    start = m.find("export async function sendMaxMessage")
    end = m.find("export async function answerCallback", start)
    if start < 0 or end < 0:
        raise SystemExit("ERROR: не найден sendMaxMessage() в maxClient.js")

    chunk = m[start:end]
    anchor = "await lrAssertChannelSendAllowed({"
    pos = chunk.find(anchor)
    if pos < 0:
        print("ERROR: в sendMaxMessage не найден lrAssertChannelSendAllowed.")
        print("Ничего не записано.")
        sys.exit(22)

    insert = (
        "  // LINKRAY_DISABLE_LINK_PREVIEW_QUERY_V2\n"
        "  // В POST /messages MAX принимает disable_link_preview как query-параметр.\n"
        "  url.searchParams.set('disable_link_preview', 'true');\n"
        "\n"
    )
    chunk = chunk[:pos] + insert + chunk[pos:]
    m = m[:start] + chunk + m[end:]

worker_path.write_text(w, encoding="utf-8")
client_path.write_text(m, encoding="utf-8")

print("OK: V2 внесён по фактической структуре текущего кода.")
PY

echo
echo "[1/6] Синтаксис"
node --check "$F1"
node --check "$F2"
git diff --check -- "$F1" "$F2"

echo
echo "[2/6] Контроль точек"
grep -n "LINKRAY_SCHEDULED_IMAGE_URL_V2" "$F1"
grep -n "LINKRAY_DISABLE_LINK_PREVIEW_QUERY_V2" "$F2"
grep -n "disable_link_preview.*true" "$F2" | tail -n 5

echo
echo "[3/6] Diff только этих файлов"
git diff -- "$F1" "$F2"

echo
echo "[4/6] Сборка"
docker compose up -d --build

echo
echo "[5/6] Проверка запуска"
sleep 4
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'NAMES|linkray-app|linkray-postgres|linkray-redis' || true
docker logs linkray-app --since 2m 2>&1 | tail -n 80 || true

echo
echo "[6/6] GitHub — только два файла"
git add "$F1" "$F2"
if git diff --cached --quiet; then
  echo "Изменений для коммита нет."
else
  git commit -m "Fix scheduled image URL and MAX link preview query"
  git push
fi

trap - ERR

echo
echo "============================================================"
echo "V2 ГОТОВ"
echo "• image: payload.url -> token fallback"
echo "• POST /messages: disable_link_preview=true в URL query"
echo "• Studio/аналитика/AntiFraud/БД не менялись"
echo "• тестовые посты автоматически НЕ отправлялись"
echo "============================================================"
