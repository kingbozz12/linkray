(() => {
  'use strict';

  const API = '/api/website';
  let challenge = '';
  let modal = null;
  let stepIdentifier = null;
  let stepCode = null;
  let identifierInput = null;
  let codeInput = null;
  let message = null;
  let submitIdentifier = null;
  let submitCode = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Ошибка ${response.status}`);
    }

    return data;
  }

  function setMessage(text, type = '') {
    if (!message) return;
    message.textContent = text || '';
    message.className = `lr-auth-message ${type}`.trim();
  }

  function setBusy(button, busy, busyText = 'Подождите…') {
    if (!button) return;
    if (busy) {
      button.dataset.oldText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.oldText || button.textContent;
      button.disabled = false;
    }
  }

  function openModal() {
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add('lr-auth-open');
    window.setTimeout(() => identifierInput?.focus(), 40);
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('lr-auth-open');
    setMessage('');
  }

  function showIdentifierStep() {
    challenge = '';
    stepIdentifier.hidden = false;
    stepCode.hidden = true;
    codeInput.value = '';
    setMessage('');
    window.setTimeout(() => identifierInput?.focus(), 30);
  }

  function showCodeStep(displayName) {
    stepIdentifier.hidden = true;
    stepCode.hidden = false;
    const label = stepCode.querySelector('[data-code-label]');
    if (label) {
      label.textContent = displayName
        ? `Код отправлен пользователю «${displayName}» в MAX`
        : 'Код отправлен сообщением от LinkRay в MAX';
    }
    setMessage('');
    window.setTimeout(() => codeInput?.focus(), 30);
  }

  function createUi() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <button class="lr-auth-fab" type="button" data-lr-login>
        <span class="lr-auth-fab-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0"/></svg>
        </span>
        <span data-lr-login-label>Личный кабинет</span>
      </button>

      <div class="lr-auth-modal" data-lr-auth-modal hidden>
        <button class="lr-auth-backdrop" type="button" aria-label="Закрыть"></button>
        <section class="lr-auth-card" role="dialog" aria-modal="true" aria-labelledby="lr-auth-title">
          <button class="lr-auth-close" type="button" aria-label="Закрыть">×</button>

          <div class="lr-auth-brand">
            <img src="/linkray-site/linkray-logo-exact.webp" alt="">
            <div>
              <strong>LinkRay</strong>
              <span>Личный кабинет</span>
            </div>
          </div>

          <div data-step-identifier>
            <h2 id="lr-auth-title">Вход в LinkRay</h2>
            <p>Введите ID из профиля LinkRay. Значения <b>1</b> и <b>000001</b> распознаются одинаково.</p>

            <form data-identifier-form>
              <label for="lr-auth-identifier">ID LinkRay или MAX ID</label>
              <input
                id="lr-auth-identifier"
                name="identifier"
                inputmode="numeric"
                autocomplete="username"
                placeholder="Например, 000001"
                required
              >
              <button class="lr-auth-primary" type="submit">Получить код в MAX</button>
            </form>
          </div>

          <div data-step-code hidden>
            <h2>Подтверждение входа</h2>
            <p data-code-label>Код отправлен сообщением от LinkRay в MAX</p>

            <form data-code-form>
              <label for="lr-auth-code">Шестизначный код</label>
              <input
                id="lr-auth-code"
                name="code"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                placeholder="000000"
                required
              >
              <button class="lr-auth-primary" type="submit">Войти в кабинет</button>
            </form>

            <button class="lr-auth-secondary" type="button" data-auth-back>Изменить ID</button>
          </div>

          <div class="lr-auth-message" role="status" aria-live="polite"></div>
          <small class="lr-auth-note">Код действует 10 минут. Он приходит только в личный чат с ботом LinkRay.</small>
        </section>
      </div>
    `;

    document.body.append(...wrapper.children);

    modal = document.querySelector('[data-lr-auth-modal]');
    stepIdentifier = modal.querySelector('[data-step-identifier]');
    stepCode = modal.querySelector('[data-step-code]');
    identifierInput = modal.querySelector('#lr-auth-identifier');
    codeInput = modal.querySelector('#lr-auth-code');
    message = modal.querySelector('.lr-auth-message');
    submitIdentifier = modal.querySelector('[data-identifier-form] button[type="submit"]');
    submitCode = modal.querySelector('[data-code-form] button[type="submit"]');

    document.querySelectorAll('[data-lr-login]').forEach((button) => {
      button.addEventListener('click', openModal);
    });

    modal.querySelector('.lr-auth-backdrop').addEventListener('click', closeModal);
    modal.querySelector('.lr-auth-close').addEventListener('click', closeModal);
    modal.querySelector('[data-auth-back]').addEventListener('click', showIdentifierStep);

    modal.querySelector('[data-identifier-form]').addEventListener('submit', async (event) => {
      event.preventDefault();
      setMessage('');
      setBusy(submitIdentifier, true, 'Отправляем код…');

      try {
        const data = await api('/auth/request-code', {
          method: 'POST',
          body: JSON.stringify({
            identifier: identifierInput.value,
          }),
        });

        challenge = data.challenge;
        showCodeStep(data.displayName);
      } catch (error) {
        setMessage(error.message, 'error');
      } finally {
        setBusy(submitIdentifier, false);
      }
    });

    modal.querySelector('[data-code-form]').addEventListener('submit', async (event) => {
      event.preventDefault();
      setMessage('');
      setBusy(submitCode, true, 'Проверяем код…');

      try {
        const data = await api('/auth/verify-code', {
          method: 'POST',
          body: JSON.stringify({
            challenge,
            code: codeInput.value,
          }),
        });

        setMessage('Вход выполнен. Открываем кабинет…', 'success');
        window.location.assign(data.redirect || '/cabinet');
      } catch (error) {
        setMessage(error.message, 'error');
      } finally {
        setBusy(submitCode, false);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !modal.hidden) closeModal();
    });
  }

  function attachExistingLoginElements() {
    const candidates = [
      ...document.querySelectorAll(
        'a, button, [role="button"], form'
      ),
    ];

    for (const element of candidates) {
      const text = `${element.textContent || ''} ${element.getAttribute?.('aria-label') || ''}`.trim();
      if (!/личн(ый|ого)\s+кабинет|войти\s+в\s+linkray|вход\s+в\s+linkray/i.test(text)) {
        continue;
      }

      if (element.matches('form')) {
        element.addEventListener('submit', (event) => {
          event.preventDefault();
          const input = element.querySelector('input');
          openModal();
          if (input?.value) identifierInput.value = input.value;
        });
      } else if (!element.hasAttribute('data-lr-login')) {
        element.addEventListener('click', (event) => {
          event.preventDefault();
          openModal();
        });
      }
    }
  }

  async function updateAuthState() {
    try {
      const session = await api('/auth/session', {
        method: 'GET',
        headers: {},
      });

      if (!session.authenticated) return;

      document.querySelectorAll('[data-lr-login-label]').forEach((label) => {
        label.textContent = 'Открыть кабинет';
      });

      document.querySelectorAll('[data-lr-login]').forEach((button) => {
        button.replaceWith(button.cloneNode(true));
      });

      document.querySelectorAll('[data-lr-login]').forEach((button) => {
        button.addEventListener('click', () => {
          window.location.assign('/cabinet');
        });
      });
    } catch {
      // Главная страница остаётся доступной, даже если проверка сессии временно не удалась.
    }
  }

  function init() {
    createUi();
    attachExistingLoginElements();
    updateAuthState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
