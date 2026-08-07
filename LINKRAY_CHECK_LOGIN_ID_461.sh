#!/usr/bin/env bash
set -u
cd /opt/linkray || exit 1

echo "============================================================"
echo "LINKRAY — ПРОВЕРКА ВХОДА ID 000461"
echo "ТОЛЬКО ЧТЕНИЕ: база и код НЕ меняются"
echo "============================================================"
echo

echo "=== 1. ТЕКУЩАЯ ВЕРСИЯ ==="
git rev-parse --short HEAD 2>/dev/null || true
git status --short 2>/dev/null || true
echo

echo "=== 2. ЛОГИКА WEBSITE AUTH ==="
if [ -f src/linkrayWebsiteRoutes.js ]; then
  grep -nE "request-code|verify-code|linkrayId|linkray_id|maxUserId|max_user_id|Пользователь LinkRay" src/linkrayWebsiteRoutes.js | head -n 120 || true
else
  echo "src/linkrayWebsiteRoutes.js не найден"
fi
echo

PG_CONTAINER="linkray-postgres"
if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  echo "ОШИБКА: контейнер $PG_CONTAINER не запущен."
  exit 1
fi

PGUSER="$(docker exec "$PG_CONTAINER" sh -lc 'printf "%s" "${POSTGRES_USER:-postgres}"' 2>/dev/null)"
PGDB="$(docker exec "$PG_CONTAINER" sh -lc 'printf "%s" "${POSTGRES_DB:-postgres}"' 2>/dev/null)"

echo "=== 3. ИЩУ ТАБЛИЦЫ/КОЛОНКИ ПОЛЬЗОВАТЕЛЕЙ ==="
docker exec -i "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -P pager=off <<'SQL'
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema='public'
  AND (
    lower(column_name) IN (
      'id','user_id','lr_user_id','linkray_id',
      'max_user_id','maxuserid','max_id','chat_id',
      'display_name','first_name','username'
    )
    OR lower(table_name) LIKE '%user%'
    OR lower(table_name) LIKE '%profile%'
  )
ORDER BY table_name, ordinal_position;
SQL

echo
echo "=== 4. ИЩУ ЗНАЧЕНИЕ 461 / 000461 В ПОДХОДЯЩИХ ПОЛЯХ ==="
docker exec -i "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -At -P pager=off <<'SQL' > /tmp/lr461_columns.txt
SELECT quote_ident(table_name) || '|' || quote_ident(column_name)
FROM information_schema.columns
WHERE table_schema='public'
  AND lower(column_name) IN (
    'id','user_id','lr_user_id','linkray_id',
    'max_user_id','maxuserid','max_id','chat_id'
  )
ORDER BY table_name, ordinal_position;
SQL

found=0
while IFS='|' read -r tbl col; do
  [ -n "${tbl:-}" ] || continue
  out="$(
    docker exec -i "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -At -P pager=off       -c "SELECT row_to_json(t)::text FROM (SELECT * FROM public.${tbl} WHERE CAST(${col} AS text) IN ('461','000461') LIMIT 5) t;"       2>/dev/null || true
  )"
  if [ -n "$out" ]; then
    found=1
    echo
    echo "--- ${tbl}.${col} ---"
    echo "$out"
  fi
done < /tmp/lr461_columns.txt
rm -f /tmp/lr461_columns.txt

if [ "$found" -eq 0 ]; then
  echo
  echo "СОВПАДЕНИЙ 461/000461 В типовых ID-полях НЕ НАЙДЕНО."
fi

echo
echo "=== 5. ПОСЛЕДНИЕ WEBSITE AUTH ОШИБКИ ==="
docker logs --since 30m linkray-app 2>&1   | grep -Ei "website|auth|request-code|verify-code|login|Пользователь LinkRay|not found|не найден|error"   | tail -n 120 || true

echo
echo "============================================================"
echo "ПРОВЕРКА ЗАВЕРШЕНА. НИЧЕГО НЕ ИЗМЕНЕНО."
echo "Пришли скриншот блоков 4 и 5."
echo "============================================================"
