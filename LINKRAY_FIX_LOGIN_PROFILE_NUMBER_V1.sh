#!/usr/bin/env bash
set -euo pipefail

cd /opt/linkray

FILE="src/linkrayWebsiteRoutes.js"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/linkray-backups/login-profile-number-$STAMP"
mkdir -p "$BACKUP_DIR"
cp "$FILE" "$BACKUP_DIR/linkrayWebsiteRoutes.js"

echo "============================================================"
echo "LINKRAY — FIX WEBSITE LOGIN BY PROFILE_NUMBER"
echo "Исправляется только вход на сайт по LinkRay ID"
echo "============================================================"

PG_CONTAINER="linkray-postgres"
PGUSER="$(docker exec "$PG_CONTAINER" sh -lc 'printf "%s" "${POSTGRES_USER:-postgres}"')"
PGDB="$(docker exec "$PG_CONTAINER" sh -lc 'printf "%s" "${POSTGRES_DB:-postgres}"')"

echo "[1/7] Проверяю ID 000461 в lr_users.profile_number"
ROW="$(docker exec -i "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -At -P pager=off \
  -c "SELECT id::text || '|' || COALESCE(max_user_id::text,'') || '|' || COALESCE(profile_number::text,'') || '|' || COALESCE(display_name,'') FROM public.lr_users WHERE profile_number=461 LIMIT 1;")"

if [ -z "$ROW" ]; then
  echo "ОШИБКА: profile_number=461 в public.lr_users не найден."
  echo "Код НЕ изменён."
  exit 2
fi

echo "Найден пользователь: $ROW"

echo "[2/7] Исправляю lookup авторизации"
python3 - <<'PY'
from pathlib import Path

p = Path("src/linkrayWebsiteRoutes.js")
s = p.read_text(encoding="utf-8")

marker = "LINKRAY_WEBSITE_PROFILE_NUMBER_LOGIN_V1"
if marker in s:
    print("Патч уже установлен.")
else:
    needle = "OR max_user_id::text = $1"
    pos = s.find(needle)
    if pos < 0:
        raise SystemExit("ERROR: не найдена строка auth lookup: OR max_user_id::text = $1")

    # Защита: меняем только ранний lookup авторизации, а не другие запросы.
    if pos > 12000:
        raise SystemExit(f"ERROR: найденная точка слишком далеко в файле: {pos}")

    replacement = (
        "OR max_user_id::text = $1\n"
        "        -- LINKRAY_WEBSITE_PROFILE_NUMBER_LOGIN_V1\n"
        "        OR profile_number::text = COALESCE(NULLIF(ltrim($1, '0'), ''), '0')"
    )
    s = s[:pos] + s[pos:].replace(needle, replacement, 1)
    p.write_text(s, encoding="utf-8")
    print("Lookup дополнен lr_users.profile_number.")
PY

echo "[3/7] Проверяю, что изменение только точечное"
git diff -- "$FILE"

echo "[4/7] Проверяю JavaScript"
if ! node --check "$FILE"; then
  cp "$BACKUP_DIR/linkrayWebsiteRoutes.js" "$FILE"
  echo "[ОТКАТ] Ошибка синтаксиса. Исходный файл восстановлен."
  exit 3
fi

echo "[5/7] Пересобираю только приложение"
if ! docker compose up -d --build app; then
  cp "$BACKUP_DIR/linkrayWebsiteRoutes.js" "$FILE"
  docker compose up -d --build app || true
  echo "[ОТКАТ] Ошибка запуска. Исходный файл восстановлен."
  exit 4
fi

sleep 3

echo "[6/7] Проверяю запуск"
docker compose ps app
docker logs --since 30s linkray-app 2>&1 | tail -n 80

echo "[7/7] Сохраняю исправление в GitHub"
git add "$FILE"
if ! git diff --cached --quiet; then
  git commit -m "Fix website login by LinkRay profile number"
  git push
else
  echo "Новых изменений для commit нет."
fi

echo
echo "============================================================"
echo "ГОТОВО"
echo "000461 теперь ищется по lr_users.profile_number."
echo "Тестовый код автоматически НЕ запрашивался."
echo "Открой linkray.ru и снова введи 000461."
echo "Backup: $BACKUP_DIR"
echo "============================================================"
