(() => {
  'use strict';

  const API = '/api/website/cabinet/overview';
  const BOT_URL = 'https://max.ru/se13353901_bot';
  const root = document.getElementById('lr-cabinet');

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');

  const formatNumber = (value) => {
    if (value === undefined || value === null || value === '') return '—';

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '—';

    return new Intl.NumberFormat('ru-RU').format(parsed);
  };

  const signedNumber = (value) => {
    if (value === undefined || value === null || value === '') return '—';

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '—';

    return `${parsed > 0 ? '+' : ''}${formatNumber(parsed)}`;
  };

  const formattedDate = (value) => {
    if (!value) return null;

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const loading = () => {
    root.innerHTML = `
      <section class="state-card">
        <img class="state-logo"
             src="/linkray-site/linkray-logo-exact.webp"
             alt="LinkRay"
             onerror="this.src='/linkray-site/icon-192.png'">
        <h1>Загружаем кабинет</h1>
        <p>Получаем последние показатели каналов.</p>
        <div class="spinner" aria-label="Загрузка"></div>
      </section>
    `;
  };

  const errorScreen = (message, status) => {
    const authError = status === 401 || status === 403;

    root.innerHTML = `
      <section class="state-card error-card">
        <img class="state-logo"
             src="/linkray-site/linkray-logo-exact.webp"
             alt="LinkRay"
             onerror="this.src='/linkray-site/icon-192.png'">
        <h1>${authError ? 'Сессия входа закончилась' : 'Не удалось загрузить кабинет'}</h1>
        <p>${escapeHtml(message || 'Сервер не вернул данные.')}</p>
        <div class="actions">
          ${
            authError
              ? '<a class="primary" href="/">Войти снова</a>'
              : '<button class="primary" type="button" id="retry-cabinet">Повторить</button>'
          }
          <a class="secondary"
             href="${BOT_URL}"
             target="_blank"
             rel="noopener noreferrer">
            Открыть LinkRay в MAX
          </a>
        </div>
      </section>
    `;

    document.getElementById('retry-cabinet')?.addEventListener('click', load);
  };

  const channelCard = (channel) => {
    const ready = channel.analyticsReady === true;
    const capturedAt = formattedDate(channel.capturedAt);
    const delta = channel.deltaDay;
    const deltaClass =
      delta === null || delta === undefined
        ? ''
        : Number(delta) < 0
          ? 'negative'
          : 'positive';

    return `
      <article class="channel-card">
        <div class="channel-top">
          <div class="channel-title">
            <h3>${escapeHtml(channel.title || `Канал ${channel.id}`)}</h3>
            <p>
              ${
                ready
                  ? `Данные обновлены${capturedAt ? ` ${escapeHtml(capturedAt)}` : ''}`
                  : 'Данные аналитики ещё собираются'
              }
            </p>
          </div>
          <span class="status-dot"></span>
        </div>

        <div class="channel-metrics">
          <div>
            <strong>${ready ? formatNumber(channel.subscribers) : '—'}</strong>
            <span>подписчиков сейчас</span>
          </div>

          <div>
            <strong>${ready ? formatNumber(channel.views24) : '—'}</strong>
            <span>просмотров за 24 ч</span>
          </div>

          <div>
            <strong class="${deltaClass}">
              ${ready ? signedNumber(channel.deltaDay) : '—'}
            </strong>
            <span>изменение за сутки</span>
          </div>
        </div>

        ${
          ready
            ? `
              <div class="channel-metrics" style="margin-top:10px">
                <div>
                  <strong>${formatNumber(channel.views48)}</strong>
                  <span>просмотров за 48 ч</span>
                </div>
                <div>
                  <strong>${formatNumber(channel.views72)}</strong>
                  <span>просмотров за 72 ч</span>
                </div>
                <div>
                  <strong>${formatNumber(channel.er24)}%</strong>
                  <span>ER за 24 ч</span>
                </div>
              </div>
            `
            : ''
        }
      </article>
    `;
  };

  const render = (payload) => {
    const user = payload.user || {};
    const summary = payload.summary || {};
    const channels = Array.isArray(payload.channels) ? payload.channels : [];

    const readyCount = Number(summary.analyticsReadyChannels || 0);
    const totalCount = Number(summary.channels || channels.length || 0);

    const cards = channels.length
      ? channels.map(channelCard).join('')
      : `
        <section class="empty-card">
          <h2>Подключённых каналов пока нет</h2>
          <p>
            Добавь бота LinkRay администратором канала и перешли ему
            любой пост из этого канала.
          </p>
          <div class="actions">
            <a class="primary"
               href="${BOT_URL}"
               target="_blank"
               rel="noopener noreferrer">
              Открыть LinkRay в MAX
            </a>
          </div>
        </section>
      `;

    const deltaClass =
      summary.deltaDay === null || summary.deltaDay === undefined
        ? ''
        : Number(summary.deltaDay) < 0
          ? 'negative'
          : 'positive';

    root.innerHTML = `
      <header class="header">
        <div class="profile">
          <img src="/linkray-site/linkray-logo-exact.webp"
               alt="LinkRay"
               onerror="this.src='/linkray-site/icon-192.png'">
          <div class="profile-copy">
            <span class="eyebrow">Личный кабинет</span>
            <h1>${escapeHtml(user.displayName || 'Пользователь LinkRay')}</h1>
            <p>ID LinkRay: ${escapeHtml(user.linkrayId || '')}</p>
          </div>
        </div>

        <button type="button"
                class="icon-button"
                id="refresh-cabinet"
                aria-label="Обновить">
          ↻
        </button>
      </header>

      <section class="summary overview-only">
        <article class="metric">
          <span>Каналы</span>
          <strong>${formatNumber(totalCount)}</strong>
        </article>

        <article class="metric">
          <span>Подписчики</span>
          <strong>${formatNumber(summary.subscribers)}</strong>
        </article>

        <article class="metric">
          <span>Просмотры за 24 ч</span>
          <strong>${formatNumber(summary.views24)}</strong>
        </article>

        <article class="metric">
          <span>Изменение за сутки</span>
          <strong class="${deltaClass}">
            ${signedNumber(summary.deltaDay)}
          </strong>
        </article>
      </section>

      <section class="section-head">
        <div>
          <span class="eyebrow">Мои каналы</span>
          <h2>Показатели каналов</h2>
          <p style="margin:6px 0 0;color:#8da3b5;font-size:12px">
            Аналитика готова для ${formatNumber(readyCount)} из ${formatNumber(totalCount)}
          </p>
        </div>

        <a href="${BOT_URL}"
           target="_blank"
           rel="noopener noreferrer">
          Studio в MAX
        </a>
      </section>

      <section class="channel-list">${cards}</section>
    `;

    document.getElementById('refresh-cabinet')?.addEventListener('click', load);
  };

  async function load() {
    loading();

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(API, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
      });

      const contentType = response.headers.get('content-type') || '';
      const body = contentType.includes('application/json')
        ? await response.json()
        : { error: (await response.text()).slice(0, 500) };

      if (!response.ok || body?.ok === false) {
        const error = new Error(
          body?.error ||
          body?.message ||
          `Ошибка API ${response.status}`,
        );
        error.status = response.status;
        throw error;
      }

      render(body);
    } catch (error) {
      errorScreen(
        error?.name === 'AbortError'
          ? 'Сервер не ответил за 12 секунд.'
          : error?.message || 'Неизвестная ошибка загрузки.',
        Number(error?.status || 0),
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      document
        .querySelectorAll('[data-tab]')
        .forEach((item) => item.classList.remove('active'));

      button.classList.add('active');

      const tab = button.getAttribute('data-tab') || 'overview';
      root.setAttribute('data-view', tab);

      if (tab === 'channels') {
        document
          .querySelector('.section-head')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });

  load();
})();
