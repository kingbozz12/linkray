#!/usr/bin/env bash
set -euo pipefail

cd /opt/linkray

echo "============================================================"
echo "LINKRAY — V4: ID 000001/000002 + ПОЛНАЯ ОЧИСТКА ИСТОРИИ ANTIFRAUD"
echo "============================================================"

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/linkray-backups/final-users-antifraud-v4-$TS"
mkdir -p "$BACKUP_DIR"

echo "[1/7] Полный backup PostgreSQL..."
docker exec linkray-postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$BACKUP_DIR/linkray-before-antifraud-v4.dump"
echo "Backup: $BACKUP_DIR/linkray-before-antifraud-v4.dump"

PSQL='docker exec -i linkray-postgres sh -lc '\''psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'\'''

echo "[2/7] Проверяю двух реальных пользователей..."
TOTAL_USERS="$(docker exec linkray-postgres sh -lc \
  'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM public.lr_users;"' | tr -d '[:space:]')"
GOOD_USERS="$(docker exec linkray-postgres sh -lc \
  'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM public.lr_users WHERE profile_number IN (1,2);"' | tr -d '[:space:]')"

eval "$PSQL" <<'SQL'
\pset pager off
SELECT id, profile_number, max_user_id, private_chat_id, display_name,
       is_verified_linkray_user, registration_source
FROM public.lr_users
ORDER BY profile_number NULLS LAST, id;
SQL

if [ "$TOTAL_USERS" != "2" ] || [ "$GOOD_USERS" != "2" ]; then
  echo "ОТМЕНА: ожидались ровно 2 пользователя с profile_number 1 и 2."
  echo "Всего: $TOTAL_USERS; с номерами 1/2: $GOOD_USERS"
  echo "Ничего больше не изменено."
  exit 1
fi

echo "[3/7] Фиксирую счётчик: следующий профиль = 000003..."
eval "$PSQL" <<'SQL'
BEGIN;
UPDATE public.lr_profile_number_counter
SET last_value = 2,
    updated_at = now();
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lr_profile_number_counter) THEN
    INSERT INTO public.lr_profile_number_counter(id, last_value, updated_at)
    VALUES (1, 2, now());
  END IF;
END $$;
COMMIT;
SQL

echo "[4/7] Очищаю старую историю AntiFraud вместе со всеми FK-зависимостями..."
# Базовые исторические таблицы. Настройки/whitelist НЕ входят.
# Рекурсивно добавляем все ДОЧЕРНИЕ таблицы, которые ссылаются FK на историю,
# например lr_antifraud_alert_deliveries -> lr_antifraud_waves.
eval "$PSQL" <<'SQL'
DO $$
DECLARE
  base_tables text[] := ARRAY[
    'lr_antifraud_participant_snapshots',
    'lr_antifraud_removals',
    'lr_antifraud_signals',
    'lr_antifraud_scans',
    'lr_antifraud_events',
    'lr_antifraud_waves',
    'lr_antifraud_alert_deliveries'
  ];
  q text;
BEGIN
  WITH RECURSIVE roots AS (
    SELECT c.oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = ANY(base_tables)
      AND c.relkind IN ('r','p')
  ),
  deps(oid) AS (
    SELECT oid FROM roots
    UNION
    SELECT con.conrelid
    FROM pg_constraint con
    JOIN deps d ON d.oid = con.confrelid
    WHERE con.contype = 'f'
  ),
  names AS (
    SELECT DISTINCT format('%I.%I', n.nspname, c.relname) AS fq
    FROM deps d
    JOIN pg_class c ON c.oid = d.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  )
  SELECT string_agg(fq, ', ' ORDER BY fq) INTO q
  FROM names;

  IF q IS NULL OR q = '' THEN
    RAISE NOTICE 'Исторические AntiFraud таблицы не найдены.';
  ELSE
    RAISE NOTICE 'TRUNCATE: %', q;
    EXECUTE 'TRUNCATE TABLE ' || q || ' RESTART IDENTITY';
  END IF;
END $$;
SQL

echo "[5/7] Проверяю результат БД..."
eval "$PSQL" <<'SQL'
\pset pager off
SELECT id, profile_number, max_user_id, private_chat_id, display_name
FROM public.lr_users
ORDER BY profile_number, id;

SELECT * FROM public.lr_profile_number_counter;

SELECT
  CASE WHEN to_regclass('public.lr_antifraud_events') IS NOT NULL
       THEN (SELECT count(*) FROM public.lr_antifraud_events) ELSE 0 END AS events,
  CASE WHEN to_regclass('public.lr_antifraud_waves') IS NOT NULL
       THEN (SELECT count(*) FROM public.lr_antifraud_waves) ELSE 0 END AS waves,
  CASE WHEN to_regclass('public.lr_antifraud_scans') IS NOT NULL
       THEN (SELECT count(*) FROM public.lr_antifraud_scans) ELSE 0 END AS scans,
  CASE WHEN to_regclass('public.lr_antifraud_signals') IS NOT NULL
       THEN (SELECT count(*) FROM public.lr_antifraud_signals) ELSE 0 END AS signals,
  CASE WHEN to_regclass('public.lr_antifraud_removals') IS NOT NULL
       THEN (SELECT count(*) FROM public.lr_antifraud_removals) ELSE 0 END AS removals,
  CASE WHEN to_regclass('public.lr_antifraud_alert_deliveries') IS NOT NULL
       THEN (SELECT count(*) FROM public.lr_antifraud_alert_deliveries) ELSE 0 END AS alert_deliveries;
SQL

echo "[6/7] Проверяю и пересобираю сайт..."
node --check src/linkrayWebsiteRoutes.js
git diff --check
docker compose up -d --build app
sleep 4
docker compose ps app

echo "[7/7] Сохраняю подготовленный website route в GitHub..."
git add src/linkrayWebsiteRoutes.js
if ! git diff --cached --quiet; then
  git commit -m "Use public LinkRay profile number in website cabinet"
  git push
else
  echo "Изменений website route для коммита нет."
fi

echo
echo "============================================================"
echo "ГОТОВО"
echo "• Реальные пользователи: 000001 и 000002"
echo "• Следующий пользователь: 000003"
echo "• Старая история AntiFraud очищена"
echo "• FK-зависимая история AntiFraud тоже очищена"
echo "• whitelist и настройки AntiFraud не очищались"
echo "• Studio, аналитика каналов и автопостинг не менялись"
echo "• сайт пересобран с публичным profile_number"
echo "Backup: $BACKUP_DIR/linkray-before-antifraud-v4.dump"
echo "============================================================"
