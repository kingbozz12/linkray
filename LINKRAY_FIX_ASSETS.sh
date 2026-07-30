#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/linkray

python3 - <<'PY'
from pathlib import Path
import re

root = Path("/opt/linkray")
src = root / "src"

candidates = []
for p in src.rglob("*.js"):
    try:
        text = p.read_text(encoding="utf-8")
    except Exception:
        continue
    if "app." in text and ("linkrayWebsiteRoutes" in text or "/api/website" in text or "app.listen" in text):
        candidates.append((p, text))

if not candidates:
    raise SystemExit("Не найден основной файл Express")

target = None
for p, text in candidates:
    if "linkrayWebsiteRoutes" in text or "/api/website" in text:
        target = (p, text)
        break
if target is None:
    target = candidates[0]

p, text = target
marker = "LINKRAY_STATIC_SITE_MIDDLEWARE"

if marker not in text:
    line = (
        "\n// LINKRAY_STATIC_SITE_MIDDLEWARE\n"
        "app.use(express.static(`${process.cwd()}/public/linkray-site`, "
        "{ index: false, maxAge: '1h', extensions: ['html'] }));\n\n"
    )

    patterns = [
        r"(?=app\.get\(\s*['\"]\/['\"])",
        r"(?=app\.use\(\s*['\"]\/api\/website['\"])",
        r"(?=app\.listen\()",
    ]

    inserted = False
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            text = text[:match.start()] + line + text[match.start():]
            inserted = True
            break

    if not inserted:
        raise SystemExit(f"Не найдено место вставки в {p}")

    p.write_text(text, encoding="utf-8")
    print(f"Исправлен файл: {p}")
else:
    print(f"Маршрут статики уже добавлен: {p}")
PY

git add src public/linkray-site
if ! git diff --cached --quiet; then
  git commit -m "Fix LinkRay website static assets"
  git push origin HEAD:main
fi

docker compose up -d --build app
sleep 15

curl -fsSI http://127.0.0.1:3000/styles.css | grep -q "200"
curl -fsSI http://127.0.0.1:3000/app.js | grep -q "200"
curl -fsSI http://127.0.0.1:3000/assets/linkray-logo.webp | grep -q "200"
curl -fsSI https://linkray.ru/styles.css | grep -q "200"

echo
echo "============================================"
echo "СТИЛИ И ФАЙЛЫ САЙТА LINKRAY ПОДКЛЮЧЕНЫ"
echo "Открой linkray.ru в режиме инкогнито"
echo "============================================"
