#!/usr/bin/env bash
set -euo pipefail

cd /opt/linkray

PGC="$(docker ps --format '{{.Names}}' | grep -m1 '^linkray-postgres$' || true)"
if [ -z "$PGC" ]; then
  PGC="$(docker ps --format '{{.Names}}' | grep -m1 'postgres' || true)"
fi
if [ -z "$PGC" ]; then
  echo "ERROR: контейнер PostgreSQL не найден"
  exit 1
fi

DB_USER="$(docker inspect "$PGC" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_USER=//p' | head -n1)"
DB_NAME="$(docker inspect "$PGC" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_DB=//p' | head -n1)"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-postgres}"

PSQL=(docker exec -i "$PGC" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -P pager=off)

echo "============================================================"
echo "LINKRAY — ПРОВЕРКА ОТЛОЖЕННОГО ПОСТА БЕЗ ИЗМЕНЕНИЙ"
echo "База/код НЕ изменяются"
echo "============================================================"

echo
echo "=== 1. СХЕМА scheduled_posts ==="
"${PSQL[@]}" -c "
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='scheduled_posts'
ORDER BY ordinal_position;
"

echo
echo "=== 2. ИЩУ ПРОБЛЕМНЫЙ ПОСТ ПО ТЕКСТУ «Не бойтесь...» ==="
"${PSQL[@]}" -c "
WITH r AS (
  SELECT to_jsonb(s) AS j
  FROM public.scheduled_posts s
)
SELECT jsonb_pretty(
  jsonb_build_object(
    'id', j->'id',
    'channel_id', COALESCE(j->'channel_id', j->'channelId'),
    'status', j->'status',
    'publish_at', COALESCE(j->'publish_at', j->'scheduled_at', j->'publishAt'),
    'published_at', COALESCE(j->'published_at', j->'sent_at'),
    'text', COALESCE(
      j->'text',
      j->'caption',
      j#>'{content,text}',
      j#>'{draft,text}',
      j#>'{draft,content,text}'
    ),
    'attachments', j->'attachments',
    'content_attachments', j#>'{content,attachments}',
    'draft_attachments', COALESCE(
      j#>'{draft,attachments}',
      j#>'{draft,content,attachments}'
    ),
    'disable_link_preview', COALESCE(
      j->'disable_link_preview',
      j#>'{content,disable_link_preview}',
      j#>'{draft,disable_link_preview}',
      j#>'{draft,content,disable_link_preview}'
    ),
    'raw_row', j
  )
) AS problem_post
FROM r
WHERE j::text ILIKE '%Не бойтесь кого-нибудь потерять%'
   OR j::text ILIKE '%Не бойтесь кого нибудь потерять%'
LIMIT 5;
"

echo
echo "=== 3. ПОСЛЕДНИЕ 8 ОТЛОЖЕННЫХ ПОСТОВ — СРАВНЕНИЕ MEDIA ==="
"${PSQL[@]}" -c "
WITH r AS (
  SELECT to_jsonb(s) AS j
  FROM public.scheduled_posts s
),
n AS (
  SELECT
    j,
    COALESCE(
      NULLIF(j->>'created_at',''),
      NULLIF(j->>'publish_at',''),
      NULLIF(j->>'scheduled_at',''),
      NULLIF(j->>'updated_at',''),
      ''
    ) AS sort_key
  FROM r
)
SELECT jsonb_pretty(
  jsonb_build_object(
    'id', j->'id',
    'channel_id', COALESCE(j->'channel_id', j->'channelId'),
    'status', j->'status',
    'publish_at', COALESCE(j->'publish_at', j->'scheduled_at', j->'publishAt'),
    'text_preview', left(COALESCE(
      j->>'text',
      j->>'caption',
      j#>>'{content,text}',
      j#>>'{draft,text}',
      j#>>'{draft,content,text}',
      ''
    ), 110),
    'attachments', j->'attachments',
    'content_attachments', j#>'{content,attachments}',
    'draft_attachments', COALESCE(
      j#>'{draft,attachments}',
      j#>'{draft,content,attachments}'
    ),
    'disable_link_preview', COALESCE(
      j->'disable_link_preview',
      j#>'{content,disable_link_preview}',
      j#>'{draft,disable_link_preview}',
      j#>'{draft,content,disable_link_preview}'
    )
  )
) AS recent_post
FROM n
ORDER BY sort_key DESC
LIMIT 8;
"

echo
echo "=== 4. ТЕКУЩАЯ ЛОГИКА ПУБЛИКАЦИИ — ТОЛЬКО ЧТЕНИЕ ==="
grep -RniE --exclude-dir=node_modules --exclude-dir=.git \
  'finalAttachments|attachments.*scheduled|disable_link_preview|link_preview|sendMessage|scheduled_posts' \
  src/autopostWorker.js src/maxClient.js src/index.js 2>/dev/null | head -n 180 || true

echo
echo "============================================================"
echo "ПРОВЕРКА ЗАВЕРШЕНА. НИЧЕГО НЕ ИЗМЕНЕНО."
echo "Пришли скриншоты разделов 2, 3 и 4."
echo "============================================================"
