#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/linkray

VERSION="20260730-session-resend-1"
MIGRATION="migrations/20260730_fix_lr_web_sessions_columns.sql"

echo "[1/7] Определяю точные поля таблицы lr_web_sessions"
python3 - <<'PY'
from pathlib import Path
import re

source_path = Path("src/linkrayWebsiteRoutes.js")
source = source_path.read_text(encoding="utf-8")

match = re.search(
    r'INSERT\s+INTO\s+(?:public\.)?lr_web_sessions\s*\((.*?)\)\s*VALUES',
    source,
    flags=re.I | re.S,
)

if not match:
    raise SystemExit("Не найден INSERT INTO public.lr_web_sessions в текущем коде")

columns = [
    item.strip().strip('"')
    for item in match.group(1).split(",")
    if item.strip()
]

type_map = {
    "id": "BIGSERIAL",
    "user_id": "BIGINT",
    "linkray_user_id": "BIGINT",
    "max_user_id": "BIGINT",
    "session_hash": "TEXT",
    "token_hash": "TEXT",
    "csrf_hash": "TEXT",
    "challenge_hash": "TEXT",
    "created_ip": "TEXT",
    "requested_ip": "TEXT",
    "ip_address": "TEXT",
    "user_agent": "TEXT",
    "device_name": "TEXT",
    "expires_at": "TIMESTAMPTZ",
    "created_at": "TIMESTAMPTZ DEFAULT NOW()",
    "updated_at": "TIMESTAMPTZ DEFAULT NOW()",
    "last_seen_at": "TIMESTAMPTZ",
    "revoked_at": "TIMESTAMPTZ",
    "used_at": "TIMESTAMPTZ",
    "is_revoked": "BOOLEAN DEFAULT FALSE",
}

def sql_type(column: str) -> str:
    if column in type_map:
        return type_map[column]
    if column.endswith("_at"):
        return "TIMESTAMPTZ"
    if column.endswith("_id"):
        return "BIGINT"
    if column.startswith("is_") or column.startswith("has_"):
        return "BOOLEAN DEFAULT FALSE"
    return "TEXT"

lines = [
    "-- Generated from the current INSERT INTO public.lr_web_sessions statement.",
]

for column in columns:
    if column == "id":
        continue
    lines.append(
        f'ALTER TABLE public.lr_web_sessions '
        f'ADD COLUMN IF NOT EXISTS "{column}" {sql_type(column)};'
    )

# Поля, которые используются при чтении/закрытии сессий и могли не входить в INSERT.
for column, definition in (
    ("created_ip", "TEXT"),
    ("user_agent", "TEXT"),
    ("created_at", "TIMESTAMPTZ DEFAULT NOW()"),
    ("expires_at", "TIMESTAMPTZ"),
    ("last_seen_at", "TIMESTAMPTZ"),
    ("revoked_at", "TIMESTAMPTZ"),
):
    lines.append(
        f'ALTER TABLE public.lr_web_sessions '
        f'ADD COLUMN IF NOT EXISTS "{column}" {definition};'
    )

# Индексы создаём только после добавления колонок.
if "session_hash" in columns:
    lines.append(
        "CREATE INDEX IF NOT EXISTS idx_lr_web_sessions_session_hash "
        "ON public.lr_web_sessions (session_hash);"
    )
if "token_hash" in columns:
    lines.append(
        "CREATE INDEX IF NOT EXISTS idx_lr_web_sessions_token_hash "
        "ON public.lr_web_sessions (token_hash);"
    )
if "user_id" in columns:
    lines.append(
        "CREATE INDEX IF NOT EXISTS idx_lr_web_sessions_user_id "
        "ON public.lr_web_sessions (user_id);"
    )

migration = Path("migrations/20260730_fix_lr_web_sessions_columns.sql")
migration.parent.mkdir(parents=True, exist_ok=True)
migration.write_text("\n".join(dict.fromkeys(lines)) + "\n", encoding="utf-8")

print("Поля из текущего INSERT:", ", ".join(columns))
print("Миграция:", migration)
PY

echo "[2/7] Применяю миграцию PostgreSQL"
docker exec -i linkray-postgres sh -lc \
  'psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-linkray}" -d "${POSTGRES_DB:-linkray}"' \
  < "$MIGRATION"

echo "[3/7] Добавляю кнопку запроса нового кода"
python3 - <<'PY'
from pathlib import Path

app_path = Path("public/linkray-site/app.js")
app = app_path.read_text(encoding="utf-8")
marker = "LINKRAY_REQUEST_NEW_CODE_V1"

if marker not in app:
    app += r'''

/* LINKRAY_REQUEST_NEW_CODE_V1 */
(() => {
  const STORAGE_KEY = 'linkrayWebsiteLoginIdentifier';

  const normalize = (value) =>
    String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input && typeof input.url === 'string'
          ? input.url
          : '';

    if (url.includes('/api/website/auth/request-code')) {
      try {
        const body =
          typeof init.body === 'string'
            ? JSON.parse(init.body)
            : init.body || {};

        const identifier =
          body.id ??
          body.identifier ??
          body.linkrayId ??
          body.linkray_id ??
          body.maxUserId ??
          body.max_user_id;

        if (identifier !== undefined && identifier !== null) {
          sessionStorage.setItem(STORAGE_KEY, String(identifier).trim());
        }
      } catch (_) {
        // Не мешаем штатному запросу входа.
      }
    }

    return originalFetch(input, init);
  };

  const findButton = (textPart) =>
    [...document.querySelectorAll('button, a')].find((element) =>
      normalize(element.textContent).includes(normalize(textPart))
    );

  const requestAgainThroughExistingFlow = () => {
    const savedIdentifier = sessionStorage.getItem(STORAGE_KEY) || '';

    const changeIdButton = findButton('изменить id');
    if (!changeIdButton) return;

    changeIdButton.click();

    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;

      const input =
        document.querySelector(
          'input[name="identifier"], input[name="id"], input[name="linkrayId"]'
        ) ||
        [...document.querySelectorAll('input')].find((element) => {
          const placeholder = normalize(element.placeholder);
          return (
            placeholder.includes('linkray') ||
            placeholder.includes('max id') ||
            element.type === 'text'
          );
        });

      const requestButton =
        findButton('получить код') ||
        findButton('получить код в max');

      if (input && requestButton) {
        window.clearInterval(timer);

        if (savedIdentifier) {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value'
          )?.set;

          if (nativeSetter) {
            nativeSetter.call(input, savedIdentifier);
          } else {
            input.value = savedIdentifier;
          }

          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        requestButton.click();
        return;
      }

      if (attempts >= 30) {
        window.clearInterval(timer);
      }
    }, 100);
  };

  const addRequestButton = () => {
    const title = [...document.querySelectorAll('h1, h2, h3')].find((element) =>
      normalize(element.textContent).includes('подтверждение входа')
    );

    if (!title) return;

    const modal =
      title.closest('.modal-card, .auth-card, .login-card, form, section, div');

    if (!modal || modal.querySelector('[data-linkray-request-new-code]')) {
      return;
    }

    const changeIdButton = [...modal.querySelectorAll('button, a')].find(
      (element) => normalize(element.textContent).includes('изменить id')
    );

    if (!changeIdButton) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'linkray-request-new-code-button';
    button.setAttribute('data-linkray-request-new-code', '');
    button.textContent = 'Запросить новый код';
    button.addEventListener('click', requestAgainThroughExistingFlow);

    changeIdButton.insertAdjacentElement('beforebegin', button);
  };

  const replaceMisleadingErrors = () => {
    [...document.querySelectorAll('div, p, span')].forEach((element) => {
      const text = normalize(element.textContent);

      if (
        text === 'код истёк. запросите новый код.' ||
        text === 'код истек. запросите новый код.'
      ) {
        element.textContent =
          'Код неверен, истёк или был заменён новым.';
      }
    });
  };

  const refresh = () => {
    addRequestButton();
    replaceMisleadingErrors();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }

  new MutationObserver(refresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
'''
    app_path.write_text(app, encoding="utf-8")
    print("Кнопка запроса нового кода добавлена")
else:
    print("Кнопка запроса нового кода уже присутствует")
PY

echo "[4/7] Добавляю оформление кнопки"
python3 - <<'PY'
from pathlib import Path

css_path = Path("public/linkray-site/styles.css")
css = css_path.read_text(encoding="utf-8")
marker = "LINKRAY_REQUEST_NEW_CODE_STYLES_V1"

if marker not in css:
    css += r'''

/* LINKRAY_REQUEST_NEW_CODE_STYLES_V1 */
.linkray-request-new-code-button {
  width: 100%;
  min-height: 54px;
  margin: 12px 0 0;
  padding: 0 18px;
  border: 1px solid rgba(110, 231, 168, .24);
  border-radius: 16px;
  background: rgba(110, 231, 168, .08);
  color: #bff5d8;
  font: inherit;
  font-weight: 780;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.linkray-request-new-code-button:active {
  transform: translateY(1px);
}

@media (max-width: 700px) {
  .linkray-request-new-code-button {
    min-height: 52px;
    font-size: 15px;
  }
}
'''
    css_path.write_text(css, encoding="utf-8")
    print("Стили добавлены")
else:
    print("Стили уже присутствуют")
PY

echo "[5/7] Обновляю версии ресурсов против кэша"
python3 - <<'PY'
from pathlib import Path
import re

version = "20260730-session-resend-1"

for file in Path("public/linkray-site").rglob("*.html"):
    text = file.read_text(encoding="utf-8")
    text = re.sub(
        r'(?P<path>(?:\.\./)?styles\.css)(?:\?v=[^"\']*)?',
        rf'\g<path>?v={version}',
        text,
    )
    text = re.sub(
        r'(?P<path>(?:\.\./)?app\.js)(?:\?v=[^"\']*)?',
        rf'\g<path>?v={version}',
        text,
    )
    file.write_text(text, encoding="utf-8")
PY

echo "[6/7] Сохраняю в GitHub и пересобираю приложение"
git add -A -- \
  "$MIGRATION" \
  public/linkray-site/app.js \
  public/linkray-site/styles.css \
  public/linkray-site/index.html \
  public/linkray-site/pages

if ! git diff --cached --quiet; then
  git commit -m "Fix website session schema and add resend code"
  git push origin HEAD:main
fi

docker compose up -d --build app
sleep 15

echo "[7/7] Проверяю без создания нового кода"
echo "Главная: $(curl -sS -o /dev/null -w '%{http_code}' https://linkray.ru/)"
echo "CSS: $(curl -sS -o /dev/null -w '%{http_code}' 'https://linkray.ru/styles.css?v=20260730-session-resend-1')"
echo "JavaScript: $(curl -sS -o /dev/null -w '%{http_code}' 'https://linkray.ru/app.js?v=20260730-session-resend-1')"

echo "Поля lr_web_sessions:"
docker exec -i linkray-postgres sh -lc \
  'psql -At -U "${POSTGRES_USER:-linkray}" -d "${POSTGRES_DB:-linkray}" -c "
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = '\''public'\''
      AND table_name = '\''lr_web_sessions'\''
    ORDER BY ordinal_position;
  "' | tr '\n' ' '
echo

echo
echo "============================================================"
echo "СЕССИЯ И КНОПКА НОВОГО КОДА ИСПРАВЛЕНЫ"
echo "Скрипт НЕ запрашивал тестовый код"
echo "Теперь запроси один новый код на сайте и введи последнее сообщение из MAX"
echo "============================================================"
