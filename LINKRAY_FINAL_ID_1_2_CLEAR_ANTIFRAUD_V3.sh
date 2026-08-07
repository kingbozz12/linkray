#!/usr/bin/env bash
set -euo pipefail

cd /opt/linkray

echo "============================================================"
echo "LINKRAY — ФИНАЛЬНАЯ НОРМАЛИЗАЦИЯ ID 1/2 + ОЧИСТКА ANTIFRAUD"
echo "Только БД AntiFraud + счётчик ID + деплой уже подготовленного website route"
echo "============================================================"

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/linkray-backups/final-users-antifraud-$TS"
mkdir -p "$BACKUP_DIR"

echo "[1/7] Полный backup PostgreSQL..."
docker exec linkray-postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$BACKUP_DIR/linkray-before-final-cleanup.dump"
echo "Backup: $BACKUP_DIR/linkray-before-final-cleanup.dump"

PSQL='docker exec -i linkray-postgres sh -lc '\''psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'\'''

echo "[2/7] Проверяю пользователей..."
eval "$PSQL" <<'SQL'
\pset pager off
SELECT id, profile_number, max_user_id, private_chat_id, display_name,
       is_verified_linkray_user, registration_source
FROM public.lr_users
ORDER BY profile_number NULLS LAST, id;
SQL

TOTAL_USERS="$(docker exec linkray-postgres sh -lc \
  'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM public.lr_users;"' \
  | tr -d '[:space:]')"

GOOD_USERS="$(docker exec linkray-postgres sh -lc \
  'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM public.lr_users WHERE profile_number IN (1,2);"' \
  | tr -d '[:space:]')"

if [ "$TOTAL_USERS" != "2" ] || [ "$GOOD_USERS" != "2" ]; then
  echo "ОТМЕНА: сейчас должны быть ровно 2 пользователя с profile_number 1 и 2."
  echo "Всего lr_users: $TOTAL_USERS; с номерами 1/2: $GOOD_USERS"
  echo "Ничего не изменено."
  exit 1
fi

echo "[3/7] Синхронизирую счётчик: следующий пользователь = 000003..."
eval "$PSQL" <<'SQL'
BEGIN;

UPDATE public.lr_profile_number_counter
SET last_value = 2,
    updated_at = now();

-- Если по какой-то причине строки счётчика нет — создаём только при понятной схеме.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lr_profile_number_counter) THEN
    INSERT INTO public.lr_profile_number_counter(id, last_value, updated_at)
    VALUES (1, 2, now());
  END IF;
END $$;

COMMIT;
SQL

echo "[4/7] Полностью очищаю старую историю AntiFraud..."
# ВАЖНО: настройки AntiFraud, whitelist, каналы, аналитика и пользователи не трогаются.
# TRUNCATE выполняется одним списком БЕЗ CASCADE. Если есть внешняя зависимость —
# PostgreSQL остановит операцию, а не удалит что-то постороннее.
eval "$PSQL" <<'SQL'
DO $$
DECLARE
    wanted text[] := ARRAY[
        'lr_antifraud_participant_snapshots',
        'lr_antifraud_removals',
        'lr_antifraud_signals',
        'lr_antifraud_scans',
        'lr_antifraud_events',
        'lr_antifraud_waves'
    ];
    t text;
    q text := '';
BEGIN
    FOREACH t IN ARRAY wanted
    LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            q := q || CASE WHEN q = '' THEN '' ELSE ', ' END || format('public.%I', t);
        END IF;
    END LOOP;

    IF q <> '' THEN
        EXECUTE 'TRUNCATE TABLE ' || q || ' RESTART IDENTITY';
    END IF;
END $$;
SQL

echo "[5/7] Проверяю итог БД..."
eval "$PSQL" <<'SQL'
\pset pager off

SELECT id, profile_number, max_user_id, private_chat_id, display_name,
       is_verified_linkray_user, registration_source
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
       THEN (SELECT count(*) FROM public.lr_antifraud_removals) ELSE 0 END AS removals;
SQL

echo "[6/7] Проверяю и деплою website route..."
node --check src/linkrayWebsiteRoutes.js
git diff --check

docker compose up -d --build app
sleep 4
docker compose ps app

echo "[7/7] Сохраняю website route в GitHub, если он ещё не сохранён..."
git add src/linkrayWebsiteRoutes.js
if ! git diff --cached --quiet; then
  git commit -m "Use public LinkRay profile number in website cabinet"
  git push
else
  echo "Website route уже сохранён или изменений нет."
fi

echo
echo "============================================================"
echo "ГОТОВО"
echo "• В базе осталось ровно 2 пользователя"
echo "• Их публичные ID: 000001 и 000002"
echo "• Следующий реальный пользователь получит 000003"
echo "• Старая история AntiFraud очищена"
echo "• Настройки AntiFraud и whitelist сохранены"
echo "• Аналитика каналов, Studio и автопостинг не изменялись"
echo "• Website route пересобран"
echo "Backup: $BACKUP_DIR/linkray-before-final-cleanup.dump"
echo "============================================================"
