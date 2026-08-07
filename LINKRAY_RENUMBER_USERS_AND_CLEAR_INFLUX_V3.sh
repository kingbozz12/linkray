#!/usr/bin/env bash
set -euo pipefail

cd /opt/linkray

PG_CONTAINER="${PG_CONTAINER:-linkray-postgres}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/linkray-backups/profile-renumber-antifraud-clean-$TS"
mkdir -p "$BACKUP_DIR"

echo "============================================================"
echo "LINKRAY — ПЕРЕНУМЕРАЦИЯ ПРОФИЛЕЙ + ПОЛНАЯ ОЧИСТКА ИСТОРИИ НАПЛЫВОВ"
echo "Останутся только два реальных пользователя:"
echo "  000001 — текущий profile_number=1"
echo "  000002 — текущий profile_number=461"
echo "Следующий новый пользователь получит 000003"
echo "============================================================"
echo

echo "[1/7] Полный backup PostgreSQL"
docker exec "$PG_CONTAINER" sh -lc 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "$BACKUP_DIR/linkray-before-renumber-clean.dump"
echo "Backup: $BACKUP_DIR/linkray-before-renumber-clean.dump"
echo

echo "[2/7] Проверяю исходных пользователей"
docker exec "$PG_CONTAINER" sh -lc '
psql -X -v ON_ERROR_STOP=1 -P pager=off -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'"'"'SQL'"'"'
SELECT id, profile_number, max_user_id, private_chat_id, display_name,
       is_verified_linkray_user, registration_source
FROM public.lr_users
ORDER BY profile_number NULLS LAST, id;

DO $$
DECLARE
  c1 integer;
  c461 integer;
BEGIN
  SELECT count(*) INTO c1 FROM public.lr_users WHERE profile_number = 1;
  SELECT count(*) INTO c461 FROM public.lr_users WHERE profile_number = 461;

  IF c1 <> 1 OR c461 <> 1 THEN
    RAISE EXCEPTION
      '"'"'ОСТАНОВКА: ожидаю ровно profile_number=1 и profile_number=461. Найдено: 1=%, 461=%'"'"',
      c1, c461;
  END IF;
END $$;
SQL
'
echo

echo "[3/7] Оставляю только двух реальных пользователей"
docker exec "$PG_CONTAINER" sh -lc '
psql -X -v ON_ERROR_STOP=1 -P pager=off -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'"'"'SQL'"'"'
BEGIN;

CREATE TEMP TABLE _lr_keep_users AS
SELECT id, profile_number, max_user_id
FROM public.lr_users
WHERE profile_number IN (1, 461);

CREATE TEMP TABLE _lr_delete_users AS
SELECT id
FROM public.lr_users
WHERE profile_number NOT IN (1, 461)
   OR profile_number IS NULL;

-- Удаляем строки из таблиц с прямым одиночным FK на lr_users.id
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT
      c.conrelid::regclass AS child_table,
      a.attname AS child_column
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = c.conkey[1]
    WHERE c.contype = '"'"'f'"'"'
      AND c.confrelid = '"'"'public.lr_users'"'"'::regclass
      AND array_length(c.conkey, 1) = 1
  LOOP
    EXECUTE format(
      '"'"'DELETE FROM %s WHERE %I IN (SELECT id FROM _lr_delete_users)'"'"',
      r.child_table,
      r.child_column
    );
  END LOOP;
END $$;

DELETE FROM public.lr_users
WHERE id IN (SELECT id FROM _lr_delete_users);

-- Дополнительный реестр реальных пользователей: оставляем MAX ID только этих двух.
DO $$
BEGIN
  IF to_regclass('"'"'public.lr_real_users'"'"') IS NOT NULL THEN
    DELETE FROM public.lr_real_users
    WHERE max_user_id::text NOT IN (
      SELECT max_user_id::text
      FROM public.lr_users
      WHERE profile_number IN (1, 461)
        AND max_user_id IS NOT NULL
    );
  END IF;
END $$;

COMMIT;
SQL
'
echo

echo "[4/7] Перенумеровываю публичный ID 000461 -> 000002"
docker exec "$PG_CONTAINER" sh -lc '
psql -X -v ON_ERROR_STOP=1 -P pager=off -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'"'"'SQL'"'"'
BEGIN;

-- После удаления остальных профилей номер 2 свободен.
UPDATE public.lr_users
SET profile_number = 2,
    updated_at = NOW()
WHERE profile_number = 461;

-- Следующий реальный пользователь должен получить 3.
UPDATE public.lr_profile_number_counter
SET last_value = 2,
    updated_at = NOW()
WHERE id = 1;

COMMIT;
SQL
'
echo

echo "[5/7] Полностью очищаю историю AntiFraud/наплывов"
docker exec "$PG_CONTAINER" sh -lc '
psql -X -v ON_ERROR_STOP=1 -P pager=off -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'"'"'SQL'"'"'
BEGIN;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    '"'"'lr_antifraud_removals'"'"',
    '"'"'lr_antifraud_participant_snapshots'"'"',
    '"'"'lr_antifraud_signals'"'"',
    '"'"'lr_antifraud_scans'"'"',
    '"'"'lr_antifraud_events'"'"',
    '"'"'lr_antifraud_waves'"'"'
  ]
  LOOP
    IF to_regclass('"'"'public.'"'"' || t) IS NOT NULL THEN
      EXECUTE format('"'"'TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE'"'"', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
SQL
'
echo

echo "[6/7] Финальная проверка"
docker exec "$PG_CONTAINER" sh -lc '
psql -X -v ON_ERROR_STOP=1 -P pager=off -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'"'"'SQL'"'"'
SELECT id, profile_number, max_user_id, private_chat_id, display_name,
       is_verified_linkray_user, registration_source
FROM public.lr_users
ORDER BY profile_number, id;

SELECT * FROM public.lr_profile_number_counter;

SELECT
  (SELECT count(*) FROM public.lr_users) AS users_total,
  CASE WHEN to_regclass('"'"'public.lr_real_users'"'"') IS NULL
       THEN NULL ELSE (SELECT count(*) FROM public.lr_real_users) END AS real_users_registry,
  CASE WHEN to_regclass('"'"'public.lr_antifraud_events'"'"') IS NULL
       THEN NULL ELSE (SELECT count(*) FROM public.lr_antifraud_events) END AS antifraud_events,
  CASE WHEN to_regclass('"'"'public.lr_antifraud_waves'"'"') IS NULL
       THEN NULL ELSE (SELECT count(*) FROM public.lr_antifraud_waves) END AS antifraud_waves,
  CASE WHEN to_regclass('"'"'public.lr_antifraud_signals'"'"') IS NULL
       THEN NULL ELSE (SELECT count(*) FROM public.lr_antifraud_signals) END AS antifraud_signals,
  CASE WHEN to_regclass('"'"'public.lr_antifraud_scans'"'"') IS NULL
       THEN NULL ELSE (SELECT count(*) FROM public.lr_antifraud_scans) END AS antifraud_scans;
SQL
'
echo

echo "[7/7] Проверяю приложение"
docker compose ps app || true

echo
echo "============================================================"
echo "ГОТОВО"
echo "Публичные LinkRay ID теперь идут заново по порядку:"
echo "  000001"
echo "  000002"
echo "Следующий пользователь: 000003"
echo
echo "ВАЖНО:"
echo "  старый ID 000461 больше не используется;"
echo "  второй пользователь входит на сайте по 000002;"
echo "  внутренний PostgreSQL id может оставаться 296 — это нормально,"
echo "  он не должен отображаться пользователю."
echo
echo "История старых наплывов AntiFraud полностью очищена."
echo "Настройки включения AntiFraud по каналам НЕ удалялись."
echo "Backup: $BACKUP_DIR/linkray-before-renumber-clean.dump"
echo "============================================================"
