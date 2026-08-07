#!/usr/bin/env bash
set -euo pipefail
cd /opt/linkray

PGC="$(docker ps --format '{{.Names}}' | grep -m1 '^linkray-postgres$' || true)"
APP="$(docker ps --format '{{.Names}}' | grep -m1 '^linkray-app$' || true)"
[ -n "$PGC" ] || { echo "ERROR: linkray-postgres не найден"; exit 1; }
[ -n "$APP" ] || { echo "ERROR: linkray-app не найден"; exit 1; }

DB_USER="$(docker inspect "$PGC" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_USER=//p' | head -n1)"
DB_NAME="$(docker inspect "$PGC" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_DB=//p' | head -n1)"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-postgres}"

TOKEN="$(docker inspect "$APP" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n -E 's/^(BOT_TOKEN|MAX_BOT_TOKEN|MAX_TOKEN)=//p' | head -n1)"
[ -n "$TOKEN" ] || { echo "ERROR: BOT_TOKEN/MAX_BOT_TOKEN/MAX_TOKEN не найден"; exit 1; }

PSQL=(docker exec -i "$PGC" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -P pager=off)

echo "============================================================"
echo "LINKRAY — ПРОВЕРКА ФАКТИЧЕСКИ ОТПРАВЛЕННЫХ СООБЩЕНИЙ MAX"
echo "НИЧЕГО НЕ МЕНЯЕТСЯ"
echo "============================================================"

echo
echo "=== 1. ПРОБЛЕМНЫЙ ПОСТ И СОСЕДНИЕ ПУБЛИКАЦИИ ==="

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

"${PSQL[@]}" -At -F $'\t' -c "
WITH bad AS (
  SELECT id, publish_at, report_group_id
  FROM scheduled_posts
  WHERE text ILIKE '%Не бойтесь кого-нибудь потерять%'
     OR text ILIKE '%Не бойтесь кого нибудь потерять%'
  ORDER BY id DESC
  LIMIT 1
)
SELECT
  sp.id,
  COALESCE(sp.channel_id::text,''),
  COALESCE(c.max_chat_id::text,''),
  COALESCE(sp.published_message_id,''),
  COALESCE(sp.status::text,''),
  COALESCE(sp.publish_at::text,''),
  left(regexp_replace(COALESCE(sp.text,''), E'[\\n\\r]+', ' ', 'g'), 100),
  COALESCE(jsonb_array_length(sp.attachments),0)::text,
  COALESCE(sp.report_group_id,'')
FROM scheduled_posts sp
LEFT JOIN channels c ON c.id=sp.channel_id
CROSS JOIN bad b
WHERE
  (b.report_group_id IS NOT NULL AND sp.report_group_id=b.report_group_id)
  OR
  (sp.publish_at BETWEEN b.publish_at - interval '2 minutes'
                     AND b.publish_at + interval '2 minutes')
ORDER BY sp.id;
" > "$TMP"

printf "%-6s %-10s %-16s %-10s %-24s %-4s %s\n" "ID" "CHANNEL" "CHAT" "STATUS" "PUBLISH_AT" "ATT" "TEXT"
while IFS=$'\t' read -r id cid chat mid status pub text att group; do
  printf "%-6s %-10s %-16s %-10s %-24s %-4s %s\n" "$id" "$cid" "$chat" "$status" "$pub" "$att" "$text"
done < "$TMP"

echo
echo "=== 2. ЧТО ФАКТИЧЕСКИ СОХРАНИЛ MAX В ОПУБЛИКОВАННЫХ СООБЩЕНИЯХ ==="
while IFS=$'\t' read -r id cid chat mid status pub text att group; do
  [ -n "$mid" ] || continue
  echo
  echo "--- scheduled_posts id=$id channel_id=$cid message_id=$mid ---"
  RESP="$(curl -sS --max-time 15 \
    -H "Authorization: $TOKEN" \
    "https://platform-api2.max.ru/messages/$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$mid")?chat_id=$chat" \
    || true)"
  printf '%s' "$RESP" | python3 -c '
import json,sys
raw=sys.stdin.read()
try:
    d=json.loads(raw)
except Exception:
    print("MAX_RESPONSE_NOT_JSON:", raw[:1200])
    raise SystemExit
m=d.get("message") if isinstance(d,dict) and isinstance(d.get("message"),dict) else d
body=m.get("body") if isinstance(m,dict) and isinstance(m.get("body"),dict) else m
atts=[]
if isinstance(body,dict):
    atts=body.get("attachments") or []
elif isinstance(m,dict):
    atts=m.get("attachments") or []
print("text:", str((body or {}).get("text",""))[:260] if isinstance(body,dict) else "")
print("attachments_count:", len(atts) if isinstance(atts,list) else "n/a")
if isinstance(atts,list):
    for i,a in enumerate(atts,1):
        if not isinstance(a,dict): 
            print(" ",i,type(a).__name__); continue
        p=a.get("payload") if isinstance(a.get("payload"),dict) else {}
        print(" ", i, "type=", a.get("type"),
              "payload_keys=", sorted(p.keys()),
              "token=", bool(p.get("token")),
              "url=", bool(p.get("url")),
              "photo_id=", p.get("photo_id"))
print("raw_success:", d.get("success") if isinstance(d,dict) else None)
'
done < "$TMP"

echo
echo "=== 3. ЛОГИ AUTPOST ЗА СЕГОДНЯ ==="
docker logs "$APP" --since 12h 2>&1 \
  | grep -E '\[autopost\]|\[max-send-format\]|MAX API error' \
  | tail -n 220 || true

echo
echo "=== 4. ПРОВЕРКА disable_link_preview В ТЕКУЩЕМ КОДЕ ==="
grep -nE 'disable_link_preview|sendMaxMessage|new URL.*messages' src/maxClient.js | head -n 80 || true

echo
echo "============================================================"
echo "ГОТОВО. НИЧЕГО НЕ ИЗМЕНЕНО."
echo "Пришли скрины разделов 2 и 3."
echo "============================================================"
