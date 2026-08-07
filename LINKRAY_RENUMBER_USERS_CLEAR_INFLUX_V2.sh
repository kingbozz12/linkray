#!/usr/bin/env bash
set -euo pipefail

cd /opt/linkray

echo "============================================================"
echo "LINKRAY — НОРМАЛИЗАЦИЯ ID 1/2 + ОЧИСТКА СТАРОЙ ИСТОРИИ ANTIFRAUD"
echo "Сохраняем только реальные профили 000001 и 000461 -> 000002"
echo "============================================================"

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/linkray-backups/users-renumber-$TS"
mkdir -p "$BACKUP_DIR"

echo "[1/8] Делаю полный backup PostgreSQL..."
docker exec linkray-postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$BACKUP_DIR/linkray-before-renumber.dump"
echo "Backup: $BACKUP_DIR/linkray-before-renumber.dump"

PSQL='docker exec -i linkray-postgres sh -lc '\''psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'\'''

echo "[2/8] Проверяю пользователей..."
eval "$PSQL" <<'SQL'
\pset pager off
SELECT id, profile_number, max_user_id, private_chat_id, display_name, username,
       is_verified_linkray_user, registration_source
FROM public.lr_users
ORDER BY profile_number NULLS LAST, id;
SQL

COUNT_KEEP="$(docker exec linkray-postgres sh -lc \
  'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM public.lr_users WHERE profile_number IN (1,461);"' \
  | tr -d '[:space:]')"

if [ "$COUNT_KEEP" != "2" ]; then
  echo "ОТМЕНА: ожидались ровно два реальных профиля profile_number=1 и 461, найдено: $COUNT_KEEP"
  echo "Ничего не изменено."
  exit 1
fi

echo "[3/8] Удаляю связи только для лишних lr_users и затем сами лишние записи..."
eval "$PSQL" <<'SQL'
BEGIN;

CREATE TEMP TABLE lr_keep_users AS
SELECT id
FROM public.lr_users
WHERE profile_number IN (1,461);

CREATE TEMP TABLE lr_drop_users AS
SELECT id
FROM public.lr_users
WHERE id NOT IN (SELECT id FROM lr_keep_users);

-- Сначала удаляем строки из таблиц с реальными FK на lr_users(id).
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT
            quote_ident(ns.nspname) AS schema_name,
            quote_ident(cl.relname) AS table_name,
            quote_ident(att.attname) AS column_name
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace
        JOIN pg_class refcl ON refcl.oid = con.confrelid
        JOIN pg_namespace refns ON refns.oid = refcl.relnamespace
        JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ck.attnum
        WHERE con.contype = 'f'
          AND refns.nspname = 'public'
          AND refcl.relname = 'lr_users'
          AND ns.nspname = 'public'
    LOOP
        EXECUTE format(
            'DELETE FROM %s.%s WHERE %s IN (SELECT id FROM lr_drop_users)',
            r.schema_name, r.table_name, r.column_name
        );
    END LOOP;
END $$;

-- Известные website-таблицы могут быть без FK, но user_id хранит внутренний lr_users.id.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'lr_web_login_codes',
        'lr_web_sessions'
    ]
    LOOP
        IF to_regclass('public.' || t) IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name=t AND column_name='user_id'
           )
        THEN
            EXECUTE format(
                'DELETE FROM public.%I WHERE user_id::text IN (SELECT id::text FROM lr_drop_users)',
                t
            );
        END IF;
    END LOOP;
END $$;

DELETE FROM public.lr_users
WHERE id IN (SELECT id FROM lr_drop_users);

-- Публичные номера: первый реальный пользователь = 1, второй = 2.
UPDATE public.lr_users
SET profile_number = 2,
    updated_at = now()
WHERE profile_number = 461;

UPDATE public.lr_users
SET profile_number = 1,
    updated_at = now()
WHERE profile_number = 1;

-- Счётчик публичных номеров: следующий новый реальный пользователь получит 3.
UPDATE public.lr_profile_number_counter
SET last_value = 2,
    updated_at = now();

COMMIT;
SQL

echo "[4/8] Полностью очищаю старую историю наплывов AntiFraud..."
# Чистим только журналы/историю. Настройки защиты и whitelist не трогаем.
eval "$PSQL" <<'SQL'
DO $$
DECLARE
    tables_to_clear text[] := ARRAY[
        'lr_antifraud_participant_snapshots',
        'lr_antifraud_removals',
        'lr_antifraud_signals',
        'lr_antifraud_scans',
        'lr_antifraud_events',
        'lr_antifraud_waves'
    ];
    t text;
BEGIN
    FOREACH t IN ARRAY tables_to_clear
    LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', t);
        END IF;
    END LOOP;
END $$;
SQL

echo "[5/8] Проверяю итог базы..."
eval "$PSQL" <<'SQL'
\pset pager off
SELECT id, profile_number, max_user_id, private_chat_id, display_name,
       is_verified_linkray_user, registration_source
FROM public.lr_users
ORDER BY profile_number, id;

SELECT * FROM public.lr_profile_number_counter;

SELECT
  (SELECT count(*) FROM public.lr_antifraud_events) AS events,
  (SELECT count(*) FROM public.lr_antifraud_waves) AS waves,
  (SELECT count(*) FROM public.lr_antifraud_scans) AS scans,
  (SELECT count(*) FROM public.lr_antifraud_signals) AS signals;
SQL

echo "[6/8] Проверяю website routes..."
node --check src/linkrayWebsiteRoutes.js
git diff --check

echo "[7/8] Пересобираю только приложение..."
docker compose up -d --build app
sleep 4
docker compose ps app

echo "[8/8] Сохраняю website-исправление в GitHub..."
git add src/linkrayWebsiteRoutes.js
if ! git diff --cached --quiet; then
  git commit -m "Use public LinkRay profile number in website cabinet"
  git push
else
  echo "Нет новых изменений website routes для commit."
fi

echo
echo "============================================================"
echo "ГОТОВО"
echo "• Публичные ID: 000001 и 000002"
echo "• Следующий реальный пользователь получит 000003"
echo "• Лишние lr_users удалены"
echo "• Старая история AntiFraud очищена"
echo "• Настройки AntiFraud и whitelist НЕ очищались"
echo "• Сайт пересобран"
echo "Backup: $BACKUP_DIR/linkray-before-renumber.dump"
echo "============================================================"
