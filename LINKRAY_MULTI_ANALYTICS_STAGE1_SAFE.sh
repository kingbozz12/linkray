#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/linkray

FILE="src/linkrayChannelAnalytics.js"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/linkray-backups/multi-stage1-$STAMP"
mkdir -p "$BACKUP"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ОШИБКА: есть незавершённые изменения"
  git status --short
  exit 2
fi

git fetch origin main --quiet
git pull --ff-only origin main
cp -a "$FILE" "$BACKUP/"

rollback() {
  code=$?
  cp -f "$BACKUP/$(basename "$FILE")" "$FILE" || true
  docker compose up -d --build app >/dev/null 2>&1 || true
  echo "ОТКАТ выполнен: $BACKUP"
  exit "$code"
}
trap rollback ERR

python3 - "$FILE" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text(encoding="utf-8")
original = s

start_token = "async function lrV34SendMaxImageUrl("
end_token = "async function lrV34TryDirectPublicNetworkCard(update)"

start = s.find(start_token)
end = s.find(end_token, start + 1)

if start < 0 or end < 0 or end <= start:
    raise SystemExit("ОШИБКА: границы sender не найдены; файл не изменён")

sender = r'''async function lrV34SendMaxImageUrl(
  update,
  imageUrl,
  channels = [],
) {
  const token = lrV34MaxToken();
  if (!token) throw new Error('MAX token not found');

  const target = lrV34TargetFromUpdate(update);

  const query = target.chatId
    ? `chat_id=${encodeURIComponent(target.chatId)}`
    : target.userId
      ? `user_id=${encodeURIComponent(target.userId)}`
      : '';

  if (!query) throw new Error('chat_id/user_id not found');

  const api = lrV34ApiBase();

  const body = {
    text: lrV44AnalyticsCaption(channels),
    format: 'html',
    attachments: [
      {
        type: 'image',
        payload: {
          url: imageUrl,
        },
      },
      ...lrMenuButtons([
        [
          lrCb('🏠 Главное меню', 'main:menu'),
        ],
      ]),
    ],
  };

  const res = await fetch(`${api}/messages?${query}`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const txt = await res.text();

  if (!res.ok) {
    throw new Error(
      `MAX image url send failed ${res.status}: ${txt}`,
    );
  }

  console.log(
    '[LR_MULTI_STAGE1]',
    JSON.stringify({
      channels: channels.length,
      menuButton: true,
    }),
  );

  return true;
}

'''

s = s[:start] + sender + s[end:]

old_call = "await lrV34SendMaxImageUrl(update, url);"
new_call = "await lrV34SendMaxImageUrl(update, url, channels);"

if s.count(old_call) == 1:
    s = s.replace(old_call, new_call, 1)
elif s.count(new_call) != 1:
    raise SystemExit("ОШИБКА: вызов sender не найден; файл не изменён")

renderer_start = "async function lrV40RenderFinalNetworkPng(channels = []) {"
renderer_end = "/* LR_NETWORK_CARD_FINAL_V40_END */"

a1, a2 = original.find(renderer_start), original.find(renderer_end)
b1, b2 = s.find(renderer_start), s.find(renderer_end)

if min(a1, a2, b1, b2) < 0:
    raise SystemExit("ОШИБКА: не удалось проверить PNG-рендер")

if original[a1:a2] != s[b1:b2]:
    raise SystemExit("ОШИБКА: PNG-рендер был затронут; файл не сохранён")

for token in [
    "lrV44AnalyticsCaption(channels)",
    "lrCb('🏠 Главное меню', 'main:menu')",
    "lrV34SendMaxImageUrl(update, url, channels)",
    "payload === 'main:menu'",
    "async function showFallbackMainMenu",
]:
    if token not in s:
        raise SystemExit(f"ОШИБКА: не найден {token!r}")

p.write_text(s, encoding="utf-8")
print("OK: этап 1 применён")
PY

node --check "$FILE"
git diff --check

CHANGED="$(git diff --name-only | sort -u)"
if [[ "$CHANGED" != "$FILE" ]]; then
  echo "ОШИБКА: изменён не только $FILE"
  exit 1
fi

docker compose up -d --build app
sleep 12
docker exec linkray-app sh -lc "node --check /app/$FILE"

LOGS="$(docker compose logs --since=3m app 2>&1 || true)"
if printf '%s\n' "$LOGS" | grep -Eqi \
  "SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|Cannot find module|Identifier .* already been declared"
then
  printf '%s\n' "$LOGS" | tail -160
  exit 1
fi

trap - ERR
git add -- "$FILE"
git commit -m "Fix multi analytics caption and menu"
git push origin HEAD:main

echo "ГОТОВО: ЭТАП 1"
echo "• подпись получает реальные channels"
echo "• добавлена кнопка Главное меню"
echo "• PNG и аватары не менялись"
echo "Backup: $BACKUP"
