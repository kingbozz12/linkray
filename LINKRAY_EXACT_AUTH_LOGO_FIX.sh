#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/linkray

echo "[1/6] Определяю точную таблицу авторизации"

python3 - <<'PY'
from pathlib import Path
import re

src = Path("src/linkrayWebsiteRoutes.js")
text = src.read_text(encoding="utf-8")

# Ищем SQL-фрагменты, где используется used_at.
candidates = set()
for m in re.finditer(r"\bused_at\b", text, flags=re.I):
    chunk = text[max(0, m.start()-2500):min(len(text), m.end()+2500)]

    for pat in (
        r'\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)',
        r'\bUPDATE\s+([A-Za-z_][A-Za-z0-9_]*)',
        r'\bINSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)',
        r'\bDELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)',
    ):
        candidates.update(re.findall(pat, chunk, flags=re.I))

    # Поддержка таблиц, заданных переменной внутри template literal.
    for var in re.findall(
        r'\b(?:FROM|UPDATE|INTO)\s+\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}',
        chunk,
        flags=re.I,
    ):
        decl = re.search(
            rf'\b(?:const|let|var)\s+{re.escape(var)}\s*=\s*[\'"`]([A-Za-z_][A-Za-z0-9_]*)[\'"`]',
            text,
        )
        if decl:
            candidates.add(decl.group(1))

ignored = {
    "select", "where", "set", "values", "returning",
    "and", "or", "limit", "order", "by"
}
candidates = sorted(x for x in candidates if x.lower() not in ignored)

sql = [
r'''DO $fix$
DECLARE r record;
BEGIN
  -- Точная таблица определяется по набору колонок авторизации.
  FOR r IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    GROUP BY table_name
    HAVING
      bool_or(column_name IN (
        'expires_at','expires_at_ms','code_expires_at','created_at'
      ))
      AND bool_or(column_name IN (
        'code','code_hash','code_digest',
        'otp','otp_hash','otp_digest',
        'token','token_hash',
        'attempts','identifier'
      ))
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL',
      r.table_name
    );
    RAISE NOTICE 'checked used_at in %', r.table_name;
  END LOOP;
END
$fix$;'''
]

for table in candidates:
    sql.append(
        f'ALTER TABLE IF EXISTS public."{table}" '
        'ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL;'
    )

Path("/tmp/linkray_exact_used_at.sql").write_text(
    "\n".join(sql) + "\n",
    encoding="utf-8",
)
print("Кандидаты из исходника:", ", ".join(candidates) or "не найдены — используется определение по колонкам")
PY

echo "[2/6] Применяю исправление PostgreSQL"
docker exec -i linkray-postgres sh -lc \
  'psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-linkray}" -d "${POSTGRES_DB:-linkray}"' \
  < /tmp/linkray_exact_used_at.sql

mkdir -p migrations
cp /tmp/linkray_exact_used_at.sql migrations/20260730_linkray_auth_used_at_exact.sql

echo "[3/6] Исправляю путь логотипа"
python3 - <<'PY'
from pathlib import Path
import shutil

root = Path("public/linkray-site")
asset = root / "assets/linkray-logo.webp"

if not asset.exists():
    alternatives = [
        root / "assets/icon-512.png",
        root / "assets/icon-192.png",
        root / "assets/logo.webp",
    ]
    source = next((p for p in alternatives if p.exists()), None)
    if source is None:
        raise SystemExit("Не найден файл логотипа")
    asset.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, asset)

for base in (Path("src"), root):
    for file in base.rglob("*"):
        if not file.is_file() or file.suffix.lower() not in {".js",".html",".css"}:
            continue
        text = file.read_text(encoding="utf-8")
        updated = text.replace(
            "/linkray-logo-exact.webp",
            "/assets/linkray-logo.webp",
        ).replace(
            "linkray-logo-exact.webp",
            "assets/linkray-logo.webp",
        )
        if updated != text:
            file.write_text(updated, encoding="utf-8")

print("Логотип подключён:", asset)
PY

echo "[4/6] Сохраняю исправления"
git add -A -- src public/linkray-site migrations/20260730_linkray_auth_used_at_exact.sql
if ! git diff --cached --quiet; then
  git commit -m "Fix exact website auth table and logo path"
  git push origin HEAD:main
fi

echo "[5/6] Пересобираю приложение"
docker compose up -d --build app
sleep 15

echo "[6/6] Проверяю"
echo "Главная: $(curl -sS -o /dev/null -w '%{http_code}' https://linkray.ru/)"
echo "CSS: $(curl -sS -o /dev/null -w '%{http_code}' https://linkray.ru/styles.css)"
echo "Логотип: $(curl -sS -o /dev/null -w '%{http_code}' https://linkray.ru/assets/linkray-logo.webp)"
echo "Авторизация:"
curl -sS -X POST http://127.0.0.1:3000/api/website/auth/request-code \
  -H 'Content-Type: application/json' \
  --data '{"id":"000001","linkrayId":"000001","identifier":"000001","userId":"000001"}'
echo

echo
echo "=============================================="
echo "ТОЧНЫЙ ФИКС LINKRAY ЗАВЕРШЁН"
echo "Нормальный результат: логотип 200 и ok:true"
echo "=============================================="
