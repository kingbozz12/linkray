(() => {
  'use strict';

  if (!location.pathname.startsWith('/cabinet')) return;

  const ENDPOINT = '/api/website/cabinet/overview';
  const BOT_URL = 'https://max.ru/se13353901_bot';

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');

  const firstValue = (...values) =>
    values.find((value) => value !== undefined && value !== null && value !== '');

  const numberValue = (...values) => {
    const selected = firstValue(...values);
    const number = Number(selected);
    return Number.isFinite(number) ? number : 0;
  };

  const formatNumber = (value) =>
    new Intl.NumberFormat('ru-RU').format(numberValue(value));

  const normalizePayload = (payload) => {
    const source = payload?.data && typeof payload.data === 'object'
      ? payload.data
      : payload || {};

    const profile =
      source.profile ||
      source.user ||
      source.account ||
      source.viewer ||
      {};

    const channelsCandidate =
      source.channels ||
      source.items ||
      source.channelList ||
      source.overview?.channels ||
      [];

    const channels = Array.isArray(channelsCandidate)
      ? channelsCandidate
      : Array.isArray(channelsCandidate?.items)
        ? channelsCandidate.items
        : [];

    const summary =
      source.summary ||
      source.analytics ||
      source.stats ||
      source.overview ||
      {};

    return { source, profile, channels, summary };
  };

  const channelName = (channel, index) =>
    firstValue(
      channel?.title,
      channel?.name,
      channel?.displayName,
      channel?.channelTitle,
      channel?.channel_name,
      `Канал ${index + 1}`
    );

  const channelSubscribers = (channel) =>
    numberValue(
      channel?.subscribers,
      channel?.subscriberCount,
      channel?.members,
      channel?.memberCount,
      channel?.audience,
      channel?.metrics?.subscribers,
      channel?.analytics?.subscribers
    );

  const channelViews24 = (channel) =>
    numberValue(
      channel?.views24,
      channel?.views_24,
      channel?.views24h,
      channel?.views,
      channel?.metrics?.views24,
      channel?.analytics?.views24
    );

  const channelGrowth24 = (channel) =>
    numberValue(
      channel?.growth24,
      channel?.net24,
      channel?.joined24,
      channel?.delta24,
      channel?.metrics?.growth24,
      channel?.analytics?.growth24
    );

  const antiFraudLabel = (channel) => {
    const enabled = firstValue(
      channel?.antifraudEnabled,
      channel?.antiFraudEnabled,
      channel?.antifraud?.enabled,
      channel?.antiFraud?.enabled
    );

    if (enabled === true || enabled === 1 || enabled === 'true') {
      return 'AntiFraud включён';
    }
    if (enabled === false || enabled === 0 || enabled === 'false') {
      return 'AntiFraud выключен';
    }
    return 'AntiFraud';
  };

  const findBottomNavigation = () => {
    const candidates = [...document.querySelectorAll('nav, footer, [class*="bottom"], [class*="tab"]')];
    return candidates.find((element) => {
      const text = String(element.textContent || '').toLowerCase();
      return text.includes('обзор') && text.includes('каналы');
    }) || null;
  };

  const hideOldLoader = () => {
    const nodes = [...document.querySelectorAll('div, section, main, p, span')];
    const label = nodes.find((node) =>
      String(node.textContent || '').trim().includes('Загружаем LinkRay')
    );

    if (label) {
      let parent = label;
      for (let index = 0; index < 4 && parent?.parentElement; index += 1) {
        const next = parent.parentElement;
        if (next === document.body) break;
        parent = next;
      }
      parent?.classList.add('lr-cabinet-old-loader-hidden');
    }
  };

  const ensureRoot = () => {
    let root = document.getElementById('lr-real-cabinet-root');
    if (root) return root;

    root = document.createElement('main');
    root.id = 'lr-real-cabinet-root';
    root.className = 'lr-real-cabinet-root';

    const nav = findBottomNavigation();
    if (nav?.parentNode) {
      nav.parentNode.insertBefore(root, nav);
    } else {
      document.body.appendChild(root);
    }

    return root;
  };

  const renderLoading = () => {
    const root = ensureRoot();
    root.innerHTML = `
      <section class="lr-cabinet-state-card">
        <img src="/assets/linkray-logo.webp" alt="LinkRay" class="lr-cabinet-state-logo">
        <h1>Загружаем кабинет</h1>
        <p>Получаем профиль, каналы и аналитику LinkRay…</p>
        <div class="lr-cabinet-spinner" aria-label="Загрузка"></div>
      </section>
    `;
  };

  const renderError = (message, status = 0) => {
    hideOldLoader();
    const root = ensureRoot();

    const expired = status === 401 || status === 403;
    root.innerHTML = `
      <section class="lr-cabinet-state-card lr-cabinet-error-card">
        <img src="/assets/linkray-logo.webp" alt="LinkRay" class="lr-cabinet-state-logo">
        <h1>${expired ? 'Нужно войти снова' : 'Кабинет не загрузился'}</h1>
        <p>${escapeHtml(message || 'Сервер не вернул данные кабинета.')}</p>
        <div class="lr-cabinet-error-actions">
          ${
            expired
              ? '<a href="/" class="lr-cabinet-primary-button">Войти снова</a>'
              : '<button type="button" id="lr-cabinet-retry" class="lr-cabinet-primary-button">Повторить</button>'
          }
          <a href="${BOT_URL}" target="_blank" rel="noopener noreferrer"
             class="lr-cabinet-secondary-button">Открыть LinkRay в MAX</a>
        </div>
      </section>
    `;

    document
      .getElementById('lr-cabinet-retry')
      ?.addEventListener('click', loadCabinet);
  };

  const renderOverview = (payload) => {
    hideOldLoader();

    const { source, profile, channels, summary } = normalizePayload(payload);
    const root = ensureRoot();

    const displayName = firstValue(
      profile.displayName,
      profile.display_name,
      profile.name,
      profile.firstName,
      profile.first_name,
      source.displayName,
      'Пользователь LinkRay'
    );

    const linkrayId = firstValue(
      profile.linkrayId,
      profile.linkray_id,
      profile.publicId,
      profile.public_id,
      source.linkrayId,
      source.linkray_id,
      profile.id
    );

    const totalSubscribers = channels.reduce(
      (sum, channel) => sum + channelSubscribers(channel),
      0
    );

    const totalViews24 = channels.reduce(
      (sum, channel) => sum + channelViews24(channel),
      0
    );

    const totalGrowth24 = channels.reduce(
      (sum, channel) => sum + channelGrowth24(channel),
      0
    );

    const summarySubscribers = numberValue(
      summary.totalSubscribers,
      summary.subscribers,
      summary.audience,
      totalSubscribers
    );

    const summaryViews = numberValue(
      summary.views24,
      summary.totalViews24,
      summary.views,
      totalViews24
    );

    const summaryGrowth = numberValue(
      summary.growth24,
      summary.net24,
      summary.delta24,
      totalGrowth24
    );

    const channelCards = channels.length
      ? channels.map((channel, index) => {
          const growth = channelGrowth24(channel);
          return `
            <article class="lr-cabinet-channel-card">
              <div class="lr-cabinet-channel-top">
                <div>
                  <h3>${escapeHtml(channelName(channel, index))}</h3>
                  <p>${escapeHtml(antiFraudLabel(channel))}</p>
                </div>
                <span class="lr-cabinet-channel-dot"></span>
              </div>
              <div class="lr-cabinet-channel-metrics">
                <div><strong>${formatNumber(channelSubscribers(channel))}</strong><span>подписчиков</span></div>
                <div><strong>${formatNumber(channelViews24(channel))}</strong><span>просмотров 24 ч</span></div>
                <div><strong class="${growth < 0 ? 'is-negative' : 'is-positive'}">${growth > 0 ? '+' : ''}${formatNumber(growth)}</strong><span>изменение 24 ч</span></div>
              </div>
            </article>
          `;
        }).join('')
      : `
        <section class="lr-cabinet-empty-card">
          <h3>Каналы пока не подключены</h3>
          <p>Добавь LinkRay администратором канала через бота MAX.</p>
          <a href="${BOT_URL}" target="_blank" rel="noopener noreferrer"
             class="lr-cabinet-primary-button">Открыть LinkRay в MAX</a>
        </section>
      `;

    root.innerHTML = `
      <header class="lr-cabinet-header">
        <div class="lr-cabinet-profile">
          <img src="/assets/linkray-logo.webp" alt="LinkRay">
          <div>
            <span>Личный кабинет</span>
            <h1>${escapeHtml(displayName)}</h1>
            ${linkrayId ? `<p>ID LinkRay: ${escapeHtml(String(linkrayId).padStart(6, '0'))}</p>` : ''}
          </div>
        </div>
        <button type="button" id="lr-cabinet-refresh" aria-label="Обновить">↻</button>
      </header>

      <section class="lr-cabinet-summary">
        <article><span>Каналы</span><strong>${formatNumber(channels.length)}</strong></article>
        <article><span>Подписчики</span><strong>${formatNumber(summarySubscribers)}</strong></article>
        <article><span>Просмотры 24 ч</span><strong>${formatNumber(summaryViews)}</strong></article>
        <article><span>Изменение 24 ч</span><strong class="${summaryGrowth < 0 ? 'is-negative' : 'is-positive'}">${summaryGrowth > 0 ? '+' : ''}${formatNumber(summaryGrowth)}</strong></article>
      </section>

      <section class="lr-cabinet-section-title">
        <div>
          <span>Мои каналы</span>
          <h2>Состояние каналов</h2>
        </div>
        <a href="${BOT_URL}" target="_blank" rel="noopener noreferrer">Studio в MAX</a>
      </section>

      <section class="lr-cabinet-channel-list">
        ${channelCards}
      </section>
    `;

    document
      .getElementById('lr-cabinet-refresh')
      ?.addEventListener('click', loadCabinet);
  };

  async function loadCabinet() {
    renderLoading();

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(ENDPOINT, {
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
        : { error: await response.text() };

      if (!response.ok || body?.ok === false) {
        throw Object.assign(
          new Error(
            body?.error ||
            body?.message ||
            `Ошибка API ${response.status}`
          ),
          { status: response.status }
        );
      }

      renderOverview(body);
    } catch (error) {
      const message =
        error?.name === 'AbortError'
          ? 'Сервер не ответил за 12 секунд.'
          : error?.message || 'Неизвестная ошибка загрузки.';

      renderError(message, Number(error?.status || 0));
    } finally {
      window.clearTimeout(timeout);
    }
  }

  const start = () => {
    hideOldLoader();
    loadCabinet();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
