#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/linkray

echo "[1/7] Ищу таблицу кодов входа"
python3 - <<'PY'
from pathlib import Path
import re

src = Path("src/linkrayWebsiteRoutes.js")
text = src.read_text(encoding="utf-8")

tables = set()
for match in re.finditer(r"\bused_at\b", text, flags=re.I):
    chunk = text[max(0, match.start()-1800):min(len(text), match.end()+1800)]
    for pattern in (
        r'\bFROM\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?',
        r'\bUPDATE\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?',
        r'\bINSERT\s+INTO\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?',
        r'\bDELETE\s+FROM\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?',
    ):
        tables.update(re.findall(pattern, chunk, flags=re.I))

ignored = {
    "select", "where", "set", "returning", "values",
    "information_schema", "columns", "public"
}
tables = {
    t for t in tables
    if t.lower() not in ignored
    and any(k in t.lower() for k in ("website", "auth", "login", "code", "otp", "session"))
}

sql = [
    r'''DO $linkray$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    GROUP BY table_name
    HAVING
      (
        bool_or(column_name IN ('code', 'code_hash', 'otp', 'otp_hash', 'token', 'token_hash'))
        AND bool_or(column_name IN ('expires_at', 'expires_at_ms', 'created_at'))
      )
      AND (
        table_name ILIKE '%website%'
        OR table_name ILIKE '%auth%'
        OR table_name ILIKE '%login%'
        OR table_name ILIKE '%code%'
        OR table_name ILIKE '%otp%'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL',
      r.table_name
    );
    RAISE NOTICE 'LinkRay: added/checked used_at in %', r.table_name;
  END LOOP;
END
$linkray$;'''
]

for table in sorted(tables):
    sql.append(
        f'ALTER TABLE IF EXISTS public."{table}" '
        f'ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL;'
    )

Path("/tmp/linkray_used_at_fix.sql").write_text("\n".join(sql) + "\n", encoding="utf-8")
print("Найдены таблицы из исходника:", ", ".join(sorted(tables)) or "используется автоопределение")
PY

echo "[2/7] Исправляю структуру PostgreSQL"
docker exec -i linkray-postgres sh -lc \
  'psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-linkray}" -d "${POSTGRES_DB:-linkray}"' \
  < /tmp/linkray_used_at_fix.sql

mkdir -p migrations
cp /tmp/linkray_used_at_fix.sql migrations/20260730_linkray_website_auth_used_at.sql

echo "[3/7] Восстанавливаю файлы логотипа"
python3 - <<'PY'
from pathlib import Path
import shutil

root = Path("public/linkray-site")
candidates = [
    root / "assets/linkray-logo.webp",
    root / "assets/logo.webp",
    root / "linkray-logo.webp",
    root / "assets/icon-512.png",
    root / "assets/icon-192.png",
]

source = next((p for p in candidates if p.exists() and p.stat().st_size > 0), None)
if source is None:
    found = [
        p for p in root.rglob("*")
        if p.is_file()
        and p.suffix.lower() in {".webp", ".png", ".jpg", ".jpeg"}
        and ("logo" in p.name.lower() or "icon-512" in p.name.lower())
        and p.stat().st_size > 0
    ]
    source = found[0] if found else None

if source is None:
    raise SystemExit("Не найден исходный логотип LinkRay")

targets = [
    root / "linkray-logo-exact.webp",
    root / "assets/linkray-logo-exact.webp",
]

for target in targets:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)

print("Логотип восстановлен из:", source)
PY

echo "[4/7] Добавляю кнопку перехода в MAX"
python3 - <<'PY'
from pathlib import Path

root = Path("public/linkray-site")
index = root / "index.html"
css = root / "styles.css"

html = index.read_text(encoding="utf-8")
button_marker = "LINKRAY_MAX_BOT_BUTTON"

if button_marker not in html:
    button = '''
<!-- LINKRAY_MAX_BOT_BUTTON -->
<a class="lr-max-bot-button"
   href="https://max.ru/se13353901_bot"
   target="_blank"
   rel="noopener noreferrer"
   aria-label="Открыть бота LinkRay в MAX">
  <span class="lr-max-bot-button__icon" aria-hidden="true">➤</span>
  <span>Открыть LinkRay в MAX</span>
</a>
'''
    html = html.replace("</body>", button + "\n</body>")
    index.write_text(html, encoding="utf-8")

styles = css.read_text(encoding="utf-8")
css_marker = "LINKRAY_MAX_BOT_BUTTON_STYLES"

if css_marker not in styles:
    styles += r'''

/* LINKRAY_MAX_BOT_BUTTON_STYLES */
.lr-max-bot-button {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 95;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 54px;
  padding: 0 19px;
  border: 1px solid rgba(110, 231, 168, .32);
  border-radius: 17px;
  background: linear-gradient(135deg, #6ee7a8, #37c98a);
  color: #052116;
  font-weight: 850;
  text-decoration: none;
  box-shadow: 0 18px 42px rgba(55, 201, 138, .28);
  -webkit-tap-highlight-color: transparent;
}
.lr-max-bot-button:hover {
  transform: translateY(-2px);
}
.lr-max-bot-button__icon {
  font-size: 20px;
  line-height: 1;
}
@media (max-width: 700px) {
  .lr-max-bot-button {
    left: 12px;
    right: 12px;
    bottom: calc(82px + env(safe-area-inset-bottom));
    width: auto;
    min-height: 56px;
  }
}
'''
    css.write_text(styles, encoding="utf-8")

print("Кнопка MAX добавлена")
PY

echo "[5/7] Сохраняю изменения в GitHub"
git add -A -- public/linkray-site migrations/20260730_linkray_website_auth_used_at.sql
if ! git diff --cached --quiet -- public/linkray-site migrations/20260730_linkray_website_auth_used_at.sql; then
  git commit -m "Fix website login schema, logo and MAX bot link"
  git push origin HEAD:main
else
  echo "Файлы сайта уже актуальны"
fi

echo "[6/7] Пересобираю только приложение"
docker compose up -d --build app
sleep 15

echo "[7/7] Проверяю сайт и отправляю код пользователю 000001"
printf "Главная: "
curl -sS -o /dev/null -w "%{http_code}\n" https://linkray.ru/

printf "CSS: "
curl -sS -o /dev/null -w "%{http_code}\n" https://linkray.ru/styles.css

printf "Логотип: "
curl -sS -o /dev/null -w "%{http_code}\n" https://linkray.ru/linkray-logo-exact.webp

echo "Ответ авторизации:"
curl -sS -X POST http://127.0.0.1:3000/api/website/auth/request-code \
  -H 'Content-Type: application/json' \
  --data '{"id":"000001","linkrayId":"000001","identifier":"000001","userId":"000001"}'
echo

echo
echo "============================================================"
echo "ФИКС LINKRAY ЗАВЕРШЁН"
echo "Код входа отправлен пользователю 000001 в MAX, если API ответил ok:true"
echo "На сайте добавлена кнопка: https://max.ru/se13353901_bot"
echo "============================================================"
