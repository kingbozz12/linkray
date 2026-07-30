#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/linkray

VERSION="20260730-mobile-clean-1"

echo "[1/6] Исправляю приём ID из формы"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("src/linkrayWebsiteRoutes.js")
s = p.read_text(encoding="utf-8")

# Текущая мобильная форма отправляет поле id.
# Сервер должен принимать его вместе с identifier/linkrayId/maxUserId.
if "req.body?.id ??" not in s:
    patterns = [
        (
            r"(req\.body\?\.linkray_id\s*\?\?\s*)",
            r"\1\n        req.body?.id ??\n        ",
        ),
        (
            r"(req\.body\?\.linkrayId\s*\?\?\s*)",
            r"\1\n        req.body?.id ??\n        ",
        ),
    ]

    changed = False
    for pattern, replacement in patterns:
        updated, count = re.subn(pattern, replacement, s, count=1)
        if count:
            s = updated
            changed = True
            break

    if not changed:
        raise SystemExit("Не найден блок identifier в linkrayWebsiteRoutes.js")

    p.write_text(s, encoding="utf-8")
    print("Добавлена поддержка req.body.id")
else:
    print("Поддержка req.body.id уже есть")
PY

echo "[2/6] Добавляю аккуратные мобильные действия"
python3 - <<'PY'
from pathlib import Path

app = Path("public/linkray-site/app.js")
text = app.read_text(encoding="utf-8")

marker = "LINKRAY_MOBILE_CLEAN_ACTIONS_V1"
if marker not in text:
    text += r'''

/* LINKRAY_MOBILE_CLEAN_ACTIONS_V1 */
(() => {
  const normalizeText = (value) =>
    String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

  const isNamedAction = (element) => {
    const text = normalizeText(element.textContent);
    return (
      text === 'начать работу' ||
      text === 'начать работу →' ||
      text === 'открыть linkray в max' ||
      text === 'личный кабинет'
    );
  };

  const buildCleanMobileActions = () => {
    if (document.querySelector('[data-lr-mobile-clean-actions]')) return;

    const allActions = [...document.querySelectorAll('a, button')];
    const oldActions = allActions.filter(isNamedAction);

    const cabinetTrigger =
      oldActions.find((element) =>
        normalizeText(element.textContent).includes('личный кабинет')
      ) ||
      document.querySelector('[data-login]');

    oldActions.forEach((element) => {
      element.classList.add('lr-mobile-old-action');
    });

    document
      .querySelectorAll('.lr-max-bot-button')
      .forEach((element) => element.classList.add('lr-mobile-old-action'));

    const heading = document.querySelector('main h1, .hero h1, h1');
    const hero =
      heading?.closest('section') ||
      document.querySelector('.hero') ||
      document.querySelector('main');

    if (!hero) return;

    const panel = document.createElement('div');
    panel.className = 'lr-mobile-clean-actions';
    panel.setAttribute('data-lr-mobile-clean-actions', '');

    const maxLink = document.createElement('a');
    maxLink.className = 'lr-mobile-clean-actions__max';
    maxLink.href = 'https://max.ru/se13353901_bot';
    maxLink.target = '_blank';
    maxLink.rel = 'noopener noreferrer';
    maxLink.innerHTML =
      '<span aria-hidden="true">➤</span><span>Открыть в MAX</span>';

    const cabinetButton = document.createElement('button');
    cabinetButton.type = 'button';
    cabinetButton.className = 'lr-mobile-clean-actions__cabinet';
    cabinetButton.innerHTML =
      '<span aria-hidden="true">◎</span><span>Личный кабинет</span>';

    cabinetButton.addEventListener('click', () => {
      if (cabinetTrigger) {
        cabinetTrigger.click();
        return;
      }

      const fallback = document.querySelector('[data-login]');
      if (fallback) {
        fallback.click();
        return;
      }

      window.location.href = '/cabinet';
    });

    panel.append(maxLink, cabinetButton);

    const lead =
      hero.querySelector('.lead') ||
      [...hero.querySelectorAll('p')].find((element) =>
        normalizeText(element.textContent).includes('linkray помогает')
      );

    if (lead?.parentNode) {
      lead.insertAdjacentElement('afterend', panel);
    } else if (heading?.parentNode) {
      heading.insertAdjacentElement('afterend', panel);
    } else {
      hero.prepend(panel);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildCleanMobileActions);
  } else {
    buildCleanMobileActions();
  }
})();
'''
    app.write_text(text, encoding="utf-8")
    print("Мобильная логика добавлена")
else:
    print("Мобильная логика уже добавлена")
PY

echo "[3/6] Добавляю мобильные стили"
python3 - <<'PY'
from pathlib import Path

css = Path("public/linkray-site/styles.css")
text = css.read_text(encoding="utf-8")

marker = "LINKRAY_MOBILE_CLEAN_ACTIONS_STYLES_V1"
if marker not in text:
    text += r'''

/* LINKRAY_MOBILE_CLEAN_ACTIONS_STYLES_V1 */
.lr-mobile-clean-actions {
  display: none;
}

@media (max-width: 700px) {
  .lr-mobile-old-action,
  .lr-max-bot-button {
    display: none !important;
  }

  .lr-mobile-clean-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, .72fr);
    gap: 10px;
    width: 100%;
    margin: 26px 0 20px;
  }

  .lr-mobile-clean-actions > a,
  .lr-mobile-clean-actions > button {
    min-width: 0;
    min-height: 54px;
    border-radius: 16px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px solid rgba(255, 255, 255, .11);
    font: inherit;
    font-size: 14px;
    font-weight: 820;
    line-height: 1.15;
    text-align: center;
    text-decoration: none;
    -webkit-tap-highlight-color: transparent;
  }

  .lr-mobile-clean-actions__max {
    background: linear-gradient(135deg, #6ee7a8, #37c98a);
    color: #052116;
    box-shadow: 0 14px 34px rgba(55, 201, 138, .22);
  }

  .lr-mobile-clean-actions__cabinet {
    background: rgba(255, 255, 255, .045);
    color: #f1f7fa;
    cursor: pointer;
  }

  .lr-mobile-clean-actions > * span:first-child {
    flex: 0 0 auto;
    font-size: 17px;
  }

  .lr-mobile-clean-actions > * span:last-child {
    min-width: 0;
  }

  /* Убираем пустые промежутки от старых мобильных панелей. */
  .hero-actions:has(.lr-mobile-old-action),
  .mobile-actions:has(.lr-mobile-old-action),
  .mobile-cta:has(.lr-mobile-old-action),
  .mobile-bottom-actions:has(.lr-mobile-old-action) {
    display: none !important;
  }

  body {
    padding-bottom: env(safe-area-inset-bottom);
  }
}

@media (max-width: 410px) {
  .lr-mobile-clean-actions {
    grid-template-columns: 1fr;
  }

  .lr-mobile-clean-actions > a,
  .lr-mobile-clean-actions > button {
    min-height: 52px;
  }
}
'''
    css.write_text(text, encoding="utf-8")
    print("Мобильные стили добавлены")
else:
    print("Мобильные стили уже добавлены")
PY

echo "[4/6] Обновляю версии CSS и JavaScript против старого кэша"
python3 - <<'PY'
from pathlib import Path
import re

version = "20260730-mobile-clean-1"

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

print("Версии ресурсов обновлены")
PY

echo "[5/6] Сохраняю в GitHub и пересобираю приложение"
git add -A -- src/linkrayWebsiteRoutes.js public/linkray-site
if ! git diff --cached --quiet; then
  git commit -m "Fix website login ID and clean mobile actions"
  git push origin HEAD:main
fi

docker compose up -d --build app
sleep 15

echo "[6/6] Проверяю вход через поле id"
echo "Главная: $(curl -sS -o /dev/null -w '%{http_code}' https://linkray.ru/)"
echo "CSS: $(curl -sS -o /dev/null -w '%{http_code}' 'https://linkray.ru/styles.css?v=20260730-mobile-clean-1')"
echo "JavaScript: $(curl -sS -o /dev/null -w '%{http_code}' 'https://linkray.ru/app.js?v=20260730-mobile-clean-1')"
echo "Авторизация через id=1:"
curl -sS -X POST http://127.0.0.1:3000/api/website/auth/request-code \
  -H 'Content-Type: application/json' \
  --data '{"id":"1"}'
echo

echo
echo "=================================================="
echo "МОБИЛЬНАЯ ВЕРСИЯ И ВХОД LINKRAY ИСПРАВЛЕНЫ"
echo "Ожидаемый ответ авторизации: ok:true"
echo "Последний отправленный код действует 10 минут"
echo "=================================================="
