#!/usr/bin/env bash
set -euo pipefail

cd /opt/linkray

KEEP_OWNER_MAX_ID="405954311"
KEEP_PROFILE_1="1"
KEEP_PROFILE_2="461"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/linkray-backups/users-cleanup-${STAMP}"
mkdir -p "$BACKUP_DIR"

DB_CONTAINER="linkray-postgres"

psql_cmd() {
  docker exec -i "$DB_CONTAINER" sh -lc 'psql -X -P pager=off -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

echo "=============================================================="
echo "LINKRAY — ОЧИСТКА ЛОЖНЫХ ПОЛЬЗОВАТЕЛЕЙ + СТАРЫХ НАПЛЫВОВ"
echo "Сохраняются только публичные ID 000001 и 000461"
echo "=============================================================="
echo

echo "[1/9] Полная резервная копия PostgreSQL"
docker exec "$DB_CONTAINER" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$BACKUP_DIR/linkray-before-users-cleanup.dump"
echo "Backup: $BACKUP_DIR/linkray-before-users-cleanup.dump"
echo

echo "[2/9] Проверяю двух реальных пользователей"
KEEP_CHECK="$(psql_cmd -At <<SQL
SELECT COUNT(*)
FROM public.lr_users
WHERE profile_number IN (${KEEP_PROFILE_1}, ${KEEP_PROFILE_2});
SQL
)"
if [ "$KEEP_CHECK" != "2" ]; then
  echo "ОТМЕНА: в lr_users не найдено ровно две записи profile_number=1 и 461."
  echo "Ничего не удалено."
  exit 1
fi

OWNER_CHECK="$(psql_cmd -At <<SQL
SELECT COUNT(*)
FROM public.lr_users
WHERE profile_number=${KEEP_PROFILE_1}
  AND max_user_id::text='${KEEP_OWNER_MAX_ID}';
SQL
)"
if [ "$OWNER_CHECK" != "1" ]; then
  echo "ОТМЕНА: profile_number=1 не совпал с владельцем MAX ${KEEP_OWNER_MAX_ID}."
  echo "Ничего не удалено."
  exit 1
fi

psql_cmd <<SQL
SELECT id, profile_number, max_user_id, private_chat_id, display_name, username,
       is_verified_linkray_user, registration_source
FROM public.lr_users
WHERE profile_number IN (${KEEP_PROFILE_1}, ${KEEP_PROFILE_2})
ORDER BY profile_number;
SQL
echo

echo "[3/9] Сохраняю снимок удаляемых lr_users"
psql_cmd <<SQL > "$BACKUP_DIR/deleted_lr_users.txt"
SELECT *
FROM public.lr_users
WHERE profile_number NOT IN (${KEEP_PROFILE_1}, ${KEEP_PROFILE_2})
ORDER BY id;
SQL
echo "Снимок: $BACKUP_DIR/deleted_lr_users.txt"
echo

echo "[4/9] Удаляю ложных пользователей безопасной транзакцией"
psql_cmd <<'SQL'
BEGIN;

CREATE TEMP TABLE _lr_delete_users ON COMMIT DROP AS
SELECT id, max_user_id
FROM public.lr_users
WHERE profile_number NOT IN (1,461);

DO $$
DECLARE
  r record;
  sql_text text;
BEGIN
  FOR r IN
    SELECT
      n.nspname AS child_schema,
      c.relname AS child_table,
      a.attname AS child_column,
      pa.attname AS parent_column
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class pc ON pc.oid = con.confrelid
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY ck(attnum, ord) ON true
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY pk(attnum, ord) ON pk.ord = ck.ord
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ck.attnum
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = pk.attnum
    WHERE con.contype='f'
      AND pn.nspname='public'
      AND pc.relname='lr_users'
  LOOP
    IF r.parent_column = 'id' THEN
      sql_text := format(
        'DELETE FROM %I.%I c USING _lr_delete_users d WHERE c.%I = d.id',
        r.child_schema, r.child_table, r.child_column
      );
    ELSIF r.parent_column = 'max_user_id' THEN
      sql_text := format(
        'DELETE FROM %I.%I c USING _lr_delete_users d WHERE c.%I::text = d.max_user_id::text',
        r.child_schema, r.child_table, r.child_column
      );
    ELSE
      CONTINUE;
    END IF;

    RAISE NOTICE 'cleanup FK: %', sql_text;
    EXECUTE sql_text;
  END LOOP;
END $$;

DELETE FROM public.lr_users
WHERE profile_number NOT IN (1,461);

DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM public.lr_users;
  IF n <> 2 THEN
    RAISE EXCEPTION 'После очистки lr_users должно быть 2 записи, получено %', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.lr_users WHERE profile_number=1
  ) OR NOT EXISTS (
    SELECT 1 FROM public.lr_users WHERE profile_number=461
  ) THEN
    RAISE EXCEPTION 'Не сохранён один из обязательных ID 1/461';
  END IF;
END $$;

COMMIT;
SQL
echo

echo "[5/9] Очищаю ИСТОРИЮ прошлых AntiFraud-наплывов"
echo "Конфигурация включения AntiFraud и текущие каналы НЕ удаляются."
psql_cmd <<'SQL'
DO $$
DECLARE
  tables text[];
  q text;
BEGIN
  SELECT array_agg(format('%I.%I', table_schema, table_name) ORDER BY table_name)
  INTO tables
  FROM information_schema.tables
  WHERE table_schema='public'
    AND table_name IN (
      'lr_antifraud_participant_snapshots',
      'lr_antifraud_removals',
      'lr_antifraud_scans',
      'lr_antifraud_signals',
      'lr_antifraud_events',
      'lr_antifraud_waves'
    );

  IF tables IS NULL OR array_length(tables,1) IS NULL THEN
    RAISE NOTICE 'AntiFraud history tables not found — skip';
    RETURN;
  END IF;

  q := 'TRUNCATE TABLE ' || array_to_string(tables, ', ') || ' RESTART IDENTITY';
  RAISE NOTICE '%', q;
  EXECUTE q;
END $$;
SQL
echo

echo "[6/9] Проверяю результат базы"
psql_cmd <<'SQL'
SELECT id, profile_number, max_user_id, private_chat_id, display_name, username
FROM public.lr_users
ORDER BY profile_number;

SELECT 'lr_users' AS table_name, COUNT(*) AS rows FROM public.lr_users
UNION ALL
SELECT 'lr_antifraud_events', COUNT(*) FROM public.lr_antifraud_events
UNION ALL
SELECT 'lr_antifraud_waves', COUNT(*) FROM public.lr_antifraud_waves;
SQL
echo

echo "[7/9] Исправляю отображение LinkRay ID в личном кабинете"
cp -a src/linkrayWebsiteRoutes.js "$BACKUP_DIR/linkrayWebsiteRoutes.js.before"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("src/linkrayWebsiteRoutes.js")
s = p.read_text(encoding="utf-8")
orig = s
marker = "// LINKRAY_PUBLIC_PROFILE_NUMBER_V1"

if marker not in s:
    fn = s.find("async function lrC5CabinetPayload")
    if fn < 0:
        raise SystemExit("Не найден lrC5CabinetPayload — код НЕ изменён.")

    needle = "const identity = await lrC5Session(req);"
    idx = s.find(needle, fn)
    if idx < 0:
        raise SystemExit("Не найден identity внутри lrC5CabinetPayload — код НЕ изменён.")

    insert_at = idx + len(needle)
    block = r'''

  // LINKRAY_PUBLIC_PROFILE_NUMBER_V1
  // Публичный ID LinkRay = lr_users.profile_number.
  // Внутренний PK lr_users.id пользователю не показываем.
  try {
    const lrPublicIdResult = await query(
      `SELECT profile_number
         FROM public.lr_users
        WHERE id = $1
           OR max_user_id::text = $2
        ORDER BY CASE WHEN max_user_id::text = $2 THEN 0 ELSE 1 END
        LIMIT 1`,
      [identity.userId, String(identity.maxUserId || '')],
    );
    const lrPublicIdRow =
      Array.isArray(lrPublicIdResult?.rows)
        ? lrPublicIdResult.rows[0]
        : Array.isArray(lrPublicIdResult)
          ? lrPublicIdResult[0]
          : null;

    if (lrPublicIdRow?.profile_number != null) {
      identity.profileNumber = Number(lrPublicIdRow.profile_number);
    }
  } catch (error) {
    console.error('[LinkRay Website] public profile number lookup failed', error?.message || error);
  }
'''
    s = s[:insert_at] + block + s[insert_at:]

s = re.sub(
    r"linkrayId:\s*String\(identity\.userId\)\.padStart\(6,\s*['\"]0['\"]\)",
    "linkrayId: String(identity.profileNumber ?? identity.userId).padStart(6, '0')",
    s,
)
s = re.sub(
    r"profileNumber:\s*identity\.userId\b",
    "profileNumber: identity.profileNumber ?? identity.userId",
    s,
)

if s == orig:
    raise SystemExit("Не удалось найти безопасную точку изменения кабинета.")

p.write_text(s, encoding="utf-8")
PY

node --check src/linkrayWebsiteRoutes.js
echo

echo "[8/9] Показываю только наш diff и пересобираю"
git diff -- src/linkrayWebsiteRoutes.js
docker compose up -d --build app
sleep 3
docker compose ps
echo

echo "[9/9] Сохраняю исправление в GitHub"
git add src/linkrayWebsiteRoutes.js
if ! git diff --cached --quiet; then
  git commit -m "Fix public LinkRay IDs and clean ghost users"
  git push
else
  echo "Код уже содержал исправление — нового commit нет."
fi

echo
echo "=============================================================="
echo "ГОТОВО"
echo "В базе должны остаться только LinkRay ID 000001 и 000461."
echo "Старая история AntiFraud очищена."
echo "Текущие настройки AntiFraud и каналы не тронуты."
echo "Кабинет теперь должен показывать profile_number, а не внутренний id."
echo "Backup: $BACKUP_DIR"
echo "=============================================================="
