#!/usr/bin/env bash
set -euo pipefail

cd /opt/linkray

FILE="src/linkrayWebsiteRoutes.js"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/linkray-backups/public-profile-id-${STAMP}"

echo "============================================================"
echo "LinkRay — исправление публичного ID в веб-кабинете"
echo "Только сайт: $FILE"
echo "База данных НЕ изменяется"
echo "============================================================"

mkdir -p "$BACKUP_DIR"
cp -a "$FILE" "$BACKUP_DIR/"
echo "[1/7] Backup: $BACKUP_DIR"

echo "[2/7] Исправляю формирование linkrayId..."
python3 - <<'PY'
from pathlib import Path
import re
import sys

path = Path("src/linkrayWebsiteRoutes.js")
text = path.read_text(encoding="utf-8")

marker = "LINKRAY_PUBLIC_PROFILE_NUMBER_V1"
helper_name = "lrWebPublicProfileNumber"

if marker not in text:
    anchor = "function lrC5Async(handler) {"
    if anchor not in text:
        print("ERROR: не найден якорь function lrC5Async(handler) {")
        sys.exit(1)

    helper = '''
// LINKRAY_PUBLIC_PROFILE_NUMBER_V1
// Внешний ID LinkRay всегда берётся из lr_users.profile_number.
// lr_users.id остаётся только внутренним ключом БД.
async function lrWebPublicProfileNumber(internalUserId) {
  const internalId = Number(internalUserId);

  if (!Number.isFinite(internalId) || internalId <= 0) {
    throw new Error('Invalid internal LinkRay user id');
  }

  const result = await query(
    `
      SELECT profile_number
      FROM public.lr_users
      WHERE id = $1
      LIMIT 1
    `,
    [internalId],
  );

  const rows = Array.isArray(result)
    ? result
    : Array.isArray(result?.rows)
      ? result.rows
      : [];

  const profileNumber = Number(rows[0]?.profile_number);

  if (!Number.isFinite(profileNumber) || profileNumber <= 0) {
    throw new Error(
      `Public LinkRay profile_number not found for internal user id ${internalId}`,
    );
  }

  return profileNumber;
}

'''
    text = text.replace(anchor, helper + anchor, 1)

patterns = [
    (
        re.compile(
            r"linkrayId:\s*String\(\s*identity\.userId\s*\)"
            r"\.padStart\(\s*6\s*,\s*['\"]0['\"]\s*\)"
        ),
        "linkrayId: String(await lrWebPublicProfileNumber(identity.userId)).padStart(6, '0')",
        "identity.userId",
    ),
    (
        re.compile(
            r"linkrayId:\s*String\(\s*session\.user_id\s*\)"
            r"\.padStart\(\s*6\s*,\s*['\"]0['\"]\s*\)"
        ),
        "linkrayId: String(await lrWebPublicProfileNumber(session.user_id)).padStart(6, '0')",
        "session.user_id",
    ),
]

total = 0
for regex, replacement, label in patterns:
    text, count = regex.subn(replacement, text)
    total += count
    print(f"  {label}: заменено {count}")

if total == 0 and marker in text:
    print("  Похоже, исправление уже установлено.")
elif total == 0:
    print("ERROR: не найдено ни одного старого формирования linkrayId")
    sys.exit(1)

path.write_text(text, encoding="utf-8")
print(f"  Всего заменено: {total}")
PY

echo "[3/7] Проверяю, что внутренний ID больше не выдаётся как linkrayId..."
if grep -nE "linkrayId:[[:space:]]*String\((identity\.userId|session\.user_id)\)" "$FILE"; then
  echo "ERROR: остались старые места формирования публичного ID."
  exit 1
else
  echo "OK: старые выражения не найдены."
fi

echo "[4/7] Проверяю синтаксис..."
node --check "$FILE"
git diff --check
echo "ПРОВЕРКА OK"

echo "[5/7] Показываю только затронутый diff..."
git diff -- "$FILE"

echo "[6/7] Пересобираю только приложение..."
docker compose up -d --build app
sleep 3
docker compose ps app

echo
echo "Текущие profile_number в БД (только чтение):"
docker exec linkray-postgres sh -lc \
'psql -X -P pager=off -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id AS internal_id,
       profile_number,
       max_user_id,
       display_name,
       is_verified_linkray_user
FROM public.lr_users
ORDER BY profile_number NULLS LAST, id;
"' || true

echo "[7/7] Сохраняю исправление..."
git add "$FILE"
if git diff --cached --quiet; then
  echo "Изменений для commit нет."
else
  git commit -m "Fix website public LinkRay profile ID"
  git push
fi

echo
echo "============================================================"
echo "ГОТОВО"
echo "Веб-кабинет теперь должен показывать profile_number,"
echo "а не внутренний lr_users.id."
echo
echo "ВАЖНО: этот патч НЕ перенумеровывает пользователей и"
echo "НЕ удаляет данные AntiFraud. В конце выше показаны реальные"
echo "profile_number из БД — по ним можно безопасно сделать 000001/000002."
echo "Backup: $BACKUP_DIR"
echo "============================================================"
