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

  const first = (...values) =>
    values.find((value) => value !== undefined && value !== null && value !== '');

  const number = (...values) => {
    const value = first(...values);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const format = (value) => new Intl.NumberFormat('ru-RU').format(number(value));

  const normalize = (payload) => {
    const source =
      payload?.data && typeof payload.data === 'object'
        ? payload.data
        : payload || {};

    const profile =
      source.profile || source.user || source.account || source.viewer || {};

    const rawChannels =
      source.channels ||
      source.channelList ||
      source.items ||
      source.overview?.channels ||
      [];

    const channels = Array.isArray(rawChannels)
      ? rawChannels
      : Array.isArray(rawChannels?.items)
        ? rawChannels.items
        : [];

    const summary =
      source.summary || source.analytics || source.stats || source.overview || {};

    return { source, profile, channels, summary };
  };

  const channelName = (channel, index) =>
    first(
      channel?.title,
      channel?.name,
      channel?.displayName,
      channel?.display_name,
      channel?.channelTitle,
      channel?.channel_name,
      `Канал ${index + 1}`
    );

  const subscribers = (channel) =>
    number(
      channel?.subscribers,
      channel?.subscriberCount,
      channel?.subscriber_count,
      channel?.members,
      channel?.memberCount,
      channel?.member_count,
      channel?.audience,
      channel?.metrics?.subscribers,
      channel?.analytics?.subscribers
    );

  const views24 = (channel) =>
    number(
      channel?.views24,
      channel?.views_24,
      channel?.views24h,
      channel?.views_24h,
      channel?.metrics?.views24,
      channel?.analytics?.views24
    );

  const growth24 = (channel) =>
    number(
      channel?.growth24,
      channel?.growth_24,
      channel?.net24,
      channel?.net_24,
      channel?.delta24,
      channel?.joined24,
      channel?.metrics?.growth24,
      channel?.analytics?.growth24
    );

  const antifraud = (channel) => {
    const enabled = first(
      channel?.antifraudEnabled,
      channel?.antifraud_enabled,
      channel?.antiFraudEnabled,
      channel?.antifraud?.enabled,
      channel?.antiFraud?.enabled
    );
    if (enabled === true || enabled === 1 || enabled === 'true') return 'AntiFraud включён';
    if (enabled === false || enabled === 0 || enabled === 'false') return 'AntiFraud выключен';
    return 'Канал подключён';
  };

  function renderError(message, status) {
    const authError = status === 401 || status === 403;
    root.innerHTML = `
      <section class="state-card error-card">
        <img class="state-logo" src="/linkray-site/linkray-logo-exact.webp" alt="LinkRay"
             onerror="this.src='/linkray-site/icon-192.png'">
        <h1>${authError ? 'Сессия входа закончилась' : 'Не удалось загрузить кабинет'}</h1>
        <p>${escapeHtml(message || 'Сервер не вернул данные.')}</p>
        <div class="actions">
          ${
            authError
              ? '<a class="primary" href="/">Войти снова</a>'
              : '<button class="primary" type="button" id="retry-cabinet">Повторить</button>'
          }
          <a class="secondary" href="${BOT_URL}" target="_blank" rel="noopener noreferrer">
            Открыть LinkRay в MAX
          </a>
        </div>
      </section>
    `;
    document.getElementById('retry-cabinet')?.addEventListener('click', load);
  }

  function render(payload) {
    const { source, profile, channels, summary } = normalize(payload);

    const displayName = first(
      profile.displayName,
      profile.display_name,
      profile.name,
      profile.firstName,
      profile.first_name,
      source.displayName,
      source.display_name,
      'Пользователь LinkRay'
    );

    const publicId = first(
      profile.linkrayId,
      profile.linkray_id,
      profile.publicId,
      profile.public_id,
      source.linkrayId,
      source.linkray_id,
      profile.id
    );

    const summedSubscribers = channels.reduce((sum, channel) => sum + subscribers(channel), 0);
    const summedViews = channels.reduce((sum, channel) => sum + views24(channel), 0);
    const summedGrowth = channels.reduce((sum, channel) => sum + growth24(channel), 0);

    const totalSubscribers = number(
      summary.totalSubscribers,
      summary.total_subscribers,
      summary.subscribers,
      summary.audience,
      summedSubscribers
    );
    const totalViews = number(
      summary.views24,
      summary.views_24,
      summary.totalViews24,
      summary.total_views_24,
      summedViews
    );
    const totalGrowth = number(
      summary.growth24,
      summary.growth_24,
      summary.net24,
      summary.net_24,
      summary.delta24,
      summedGrowth
    );

    const cards = channels.length
      ? channels.map((channel, index) => {
          const growth = growth24(channel);
          return `
            <article class="channel-card">
              <div class="channel-top">
                <div class="channel-title">
                  <h3>${escapeHtml(channelName(channel, index))}</h3>
                  <p>${escapeHtml(antifraud(channel))}</p>
                </div>
                <span class="status-dot"></span>
              </div>
              <div class="channel-metrics">
                <div><strong>${format(subscribers(channel))}</strong><span>подписчиков</span></div>
                <div><strong>${format(views24(channel))}</strong><span>просмотров 24 ч</span></div>
                <div>
                  <strong class="${growth < 0 ? 'negative' : 'positive'}">
                    ${growth > 0 ? '+' : ''}${format(growth)}
                  </strong>
                  <span>изменение 24 ч</span>
                </div>
              </div>
            </article>
          `;
        }).join('')
      : `
        <section class="empty-card">
          <h2>Подключённых каналов пока нет</h2>
          <p>Добавь бота LinkRay администратором канала и перешли ему любой пост из этого канала.</p>
          <div class="actions">
            <a class="primary" href="${BOT_URL}" target="_blank" rel="noopener noreferrer">
              Открыть LinkRay в MAX
            </a>
          </div>
        </section>
      `;

    const idText =
      publicId !== undefined && publicId !== null && publicId !== ''
        ? `ID LinkRay: ${escapeHtml(String(publicId).padStart(6, '0'))}`
        : 'Личный кабинет';

    root.innerHTML = `
      <header class="header">
        <div class="profile">
          <img src="/linkray-site/linkray-logo-exact.webp" alt="LinkRay"
               onerror="this.src='/linkray-site/icon-192.png'">
          <div class="profile-copy">
            <span class="eyebrow">Личный кабинет</span>
            <h1>${escapeHtml(displayName)}</h1>
            <p>${idText}</p>
          </div>
        </div>
        <button type="button" class="icon-button" id="refresh-cabinet" aria-label="Обновить">↻</button>
      </header>

      <section class="summary overview-only">
        <article class="metric"><span>Каналы</span><strong>${format(channels.length)}</strong></article>
        <article class="metric"><span>Подписчики</span><strong>${format(totalSubscribers)}</strong></article>
        <article class="metric"><span>Просмотры 24 ч</span><strong>${format(totalViews)}</strong></article>
        <article class="metric">
          <span>Изменение 24 ч</span>
          <strong class="${totalGrowth < 0 ? 'negative' : 'positive'}">
            ${totalGrowth > 0 ? '+' : ''}${format(totalGrowth)}
          </strong>
        </article>
      </section>

      <section class="section-head">
        <div>
          <span class="eyebrow">Мои каналы</span>
          <h2>Состояние каналов</h2>
        </div>
        <a href="${BOT_URL}" target="_blank" rel="noopener noreferrer">Studio в MAX</a>
      </section>

      <section class="channel-list">${cards}</section>
    `;

    document.getElementById('refresh-cabinet')?.addEventListener('click', load);
  }

  async function load() {
    root.removeAttribute('data-view');
    root.innerHTML = `
      <section class="state-card">
        <img class="state-logo" src="/linkray-site/linkray-logo-exact.webp" alt="LinkRay"
             onerror="this.src='/linkray-site/icon-192.png'">
        <h1>Загружаем кабинет</h1>
        <p>Получаем профиль, каналы и аналитику.</p>
        <div class="spinner" aria-label="Загрузка"></div>
      </section>
    `;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(API, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache'
        },
        signal: controller.signal
      });

      const contentType = response.headers.get('content-type') || '';
      const body = contentType.includes('application/json')
        ? await response.json()
        : { error: (await response.text()).slice(0, 500) };

      if (!response.ok || body?.ok === false) {
        const error = new Error(body?.error || body?.message || `Ошибка API ${response.status}`);
        error.status = response.status;
        throw error;
      }

      render(body);
    } catch (error) {
      const message =
        error?.name === 'AbortError'
          ? 'Сервер не ответил за 12 секунд. Нажми «Повторить».'
          : error?.message || 'Неизвестная ошибка загрузки.';
      renderError(message, Number(error?.status || 0));
    } finally {
      window.clearTimeout(timeout);
    }
  }

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      const tab = button.getAttribute('data-tab');
      root.setAttribute('data-view', tab || 'overview');
      if (tab === 'channels') {
        document.querySelector('.section-head')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });

  load();
})();
