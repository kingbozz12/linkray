(() => {
  'use strict';

  const API = '/api/website/cabinet/full';
  const BOT_URL = 'https://max.ru/se13353901_bot';
  const root = document.getElementById('lr-cabinet');

  const state = {
    payload: null,
    tab: 'overview',
    openChannelId: null,
    periods: new Map(),
    noticesExpanded: false,
  };

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');

  const numberOrNull = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const formatNumber = (value) => {
    const parsed = numberOrNull(value);
    return parsed === null ? '—' : new Intl.NumberFormat('ru-RU').format(parsed);
  };

  const formatSigned = (value) => {
    const parsed = numberOrNull(value);
    if (parsed === null) return '—';
    return `${parsed > 0 ? '+' : ''}${formatNumber(parsed)}`;
  };

  const formatPercent = (value) => {
    const parsed = numberOrNull(value);
    return parsed === null ? '—' : `${parsed.toFixed(1).replace('.0', '')}%`;
  };

  const formatDate = (value, withTime = true) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';

    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: withTime ? undefined : 'numeric',
      hour: withTime ? '2-digit' : undefined,
      minute: withTime ? '2-digit' : undefined,
    }).format(date);
  };

  const statusLabel = (status) => ({
    scheduled: 'Запланирован',
    publishing: 'Публикуется',
    published: 'Опубликован',
    error: 'Ошибка',
    deleted: 'Удалён',
    canceled: 'Отменён',
  }[status] || 'Без статуса');

  const loading = () => {
    root.innerHTML = `
      <section class="state-card">
        <img class="state-logo"
             src="/linkray-site/linkray-logo-exact.webp"
             alt="LinkRay"
             onerror="this.src='/linkray-site/icon-192.png'">
        <h1>Загружаем кабинет</h1>
        <p>Получаем каналы, аналитику и события.</p>
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
              ? '<a class="primary full-width" href="/">Войти снова</a>'
              : '<button class="primary full-width" type="button" data-action="retry">Повторить</button>'
          }
          <a class="secondary full-width"
             href="${BOT_URL}"
             target="_blank"
             rel="noopener noreferrer">
            Открыть LinkRay в MAX
          </a>
        </div>
      </section>
    `;
  };

  const metricClass = (value) => {
    const parsed = numberOrNull(value);
    if (parsed === null) return 'muted';
    return parsed < 0 ? 'negative' : 'positive';
  };

  const notificationHtml = (notice) => `
    <article class="notice ${escapeHtml(notice.level || 'info')}">
      <span class="notice-dot"></span>
      <div>
        <strong>${escapeHtml(notice.title || 'Уведомление')}</strong>
        <p>${escapeHtml(notice.text || '')}</p>
      </div>
    </article>
  `;


  /* LINKRAY_POST_PREVIEW_PNG_V1 */
  function postPlainText(value) {
    const source = String(value ?? '');

    if (!source.trim()) return '';

    const prepared = source
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, '\n')
      .replace(/<(?:p|div|li|blockquote|h[1-6])(?:\s[^>]*)?>/gi, '');

    const parser = new DOMParser();
    const documentValue = parser.parseFromString(
      `<body>${prepared}</body>`,
      'text/html',
    );

    return String(documentValue.body.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200d\uFEFF]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const postHtml = (post) => {
    const date =
      post.status === 'scheduled'
        ? post.publishAt
        : post.publishedAt || post.createdAt;

    const preview =
      postPlainText(post.text) ||
      'Публикация без текста';

    return `
      <article class="post-row">
        <div class="post-content">
          <strong class="post-channel-title">
            ${post.isAd ? '💼 ' : ''}
            ${escapeHtml(post.channelTitle || 'Канал')}
          </strong>

          <p class="post-preview-text">
            ${escapeHtml(preview)}
          </p>
        </div>

        <div class="post-side">
          <span class="status-pill status-${escapeHtml(post.status)}">
            ${escapeHtml(statusLabel(post.status))}
          </span>

          <time class="post-date"
                datetime="${escapeHtml(date || '')}">
            ${escapeHtml(formatDate(date))}
          </time>
        </div>
      </article>
    `;
  };


  const summaryMetric = (label, value, className = '') => `
    <article class="metric">
      <span>${escapeHtml(label)}</span>
      <strong class="${className}">${escapeHtml(value)}</strong>
    </article>
  `;

  function overviewHtml(payload) {
    const notices = Array.isArray(payload.notifications)
      ? payload.notifications
      : [];

    const visibleNotices = state.noticesExpanded
      ? notices
      : notices.slice(0, 5);

    const upcoming = (payload.posts || [])
      .filter((post) =>
        ['scheduled', 'publishing', 'error'].includes(post.status),
      )
      .slice(0, 8);

    const subscription = payload.profile?.subscription || {};

    return `
      <section class="tab-view" data-view="overview">
        <section class="summary">
          ${summaryMetric('Каналы', formatNumber(payload.summary?.channels))}
          ${summaryMetric('Подписчики', formatNumber(payload.summary?.subscribers))}
          ${summaryMetric('Просмотры 24 ч', formatNumber(payload.summary?.views24))}
          ${summaryMetric(
            'Изменение за сутки',
            formatSigned(payload.summary?.deltaDay),
            metricClass(payload.summary?.deltaDay),
          )}
        </section>

        <div class="section-head">
          <div>
            <span class="eyebrow">Центр событий</span>
            <h2>Уведомления</h2>
            <p>${formatNumber(notices.length)} важных событий</p>
          </div>
        </div>

        <section class="panel">
          <div class="notice-list">
            ${
              visibleNotices.length
                ? visibleNotices.map(notificationHtml).join('')
                : `
                  <article class="notice">
                    <span class="notice-dot"></span>
                    <div>
                      <strong>Всё работает штатно</strong>
                      <p>Новых предупреждений нет.</p>
                    </div>
                  </article>
                `
            }
          </div>

          ${
            notices.length > 5
              ? `
                <button class="secondary full-width"
                        type="button"
                        data-action="toggle-notices"
                        style="width:100%;margin-top:10px">
                  ${state.noticesExpanded ? 'Свернуть' : 'Показать все'}
                </button>
              `
              : ''
          }
        </section>

        <div class="section-head">
          <div>
            <span class="eyebrow">Studio</span>
            <h2>Ближайшие публикации</h2>
            <p>Редактирование остаётся в MAX</p>
          </div>
          <a href="${BOT_URL}" target="_blank" rel="noopener noreferrer">
            Открыть Studio
          </a>
        </div>

        <section class="panel">
          <div class="post-list">
            ${
              upcoming.length
                ? upcoming.map(postHtml).join('')
                : `
                  <article class="post-row">
                    <div>
                      <strong>Нет ближайших публикаций</strong>
                      <p>Запланированные посты появятся здесь.</p>
                    </div>
                  </article>
                `
            }
          </div>
        </section>

        <div class="section-head">
          <div>
            <span class="eyebrow">Профиль</span>
            <h2>Аккаунт и тариф</h2>
          </div>
        </div>

        <section class="panel">
          <div class="profile-list">
            <article class="profile-row">
              <span>ID LinkRay</span>
              <strong>${escapeHtml(payload.user?.linkrayId || '—')}</strong>
            </article>

            <article class="profile-row">
              <span>Подключено каналов</span>
              <strong>${formatNumber(payload.user?.connectedChannels)}</strong>
            </article>

            <article class="profile-row">
              <span>Тариф</span>
              <strong>${escapeHtml(subscription.name || 'Бесплатный')}</strong>
            </article>

            <article class="profile-row">
              <span>Статус</span>
              <strong>${escapeHtml(subscription.status || 'active')}</strong>
            </article>

            <article class="profile-row">
              <span>Действует до</span>
              <strong>${escapeHtml(formatDate(subscription.endsAt, false))}</strong>
            </article>
          </div>
        </section>
      </section>
    `;
  }

  function chartData(channel, period) {
    if (period === '24h') {
      return Array.isArray(channel.history24h)
        ? channel.history24h
        : [];
    }

    const history = Array.isArray(channel.history30d)
      ? channel.history30d
      : [];

    return period === '7d' ? history.slice(-7) : history.slice(-30);
  }


  /* LINKRAY_PROFESSIONAL_CHARTS_V1 */
  function chartTimestamp(point, index) {
    const raw = point?.capturedAt || point?.date;
    const time = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(time) ? time : index;
  }

  function chartDateLabel(time, period) {
    const date = new Date(time);
    if (Number.isNaN(date.getTime())) return '';

    return new Intl.DateTimeFormat('ru-RU', {
      day: period === '24h' ? undefined : '2-digit',
      month: period === '24h' ? undefined : '2-digit',
      hour: period === '24h' ? '2-digit' : undefined,
      minute: period === '24h' ? '2-digit' : undefined,
    }).format(date);
  }

  function chartAxisNumber(value) {
    const absolute = Math.abs(value);

    if (absolute >= 1000000) {
      return `${(value / 1000000).toFixed(1).replace('.0', '')} млн`;
    }

    if (absolute >= 10000) {
      return `${(value / 1000).toFixed(1).replace('.0', '')} тыс.`;
    }

    return new Intl.NumberFormat('ru-RU', {
      maximumFractionDigits: absolute < 10 ? 1 : 0,
    }).format(value);
  }

  function chartNiceStep(range, targetTicks = 4) {
    const safeRange = Math.max(Number(range) || 0, 1);
    const rough = safeRange / Math.max(1, targetTicks - 1);
    const power = 10 ** Math.floor(Math.log10(rough));
    const fraction = rough / power;

    const niceFraction =
      fraction <= 1
        ? 1
        : fraction <= 2
          ? 2
          : fraction <= 5
            ? 5
            : 10;

    return niceFraction * power;
  }

  function chartHash(value) {
    let hash = 0;
    const text = String(value);

    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }

    return Math.abs(hash);
  }

  function professionalChart(
    sourcePoints,
    field,
    kind,
    period,
    channelId,
  ) {
    const prepared = (Array.isArray(sourcePoints) ? sourcePoints : [])
      .map((point, index) => ({
        point,
        value: numberOrNull(point?.[field]),
        time: chartTimestamp(point, index),
        sourceIndex: index,
      }))
      .filter((item) => item.value !== null)
      .sort((left, right) => {
        if (left.time !== right.time) return left.time - right.time;
        return left.sourceIndex - right.sourceIndex;
      });

    const deduplicated = [];

    for (const item of prepared) {
      const previous = deduplicated[deduplicated.length - 1];

      if (previous && previous.time === item.time) {
        deduplicated[deduplicated.length - 1] = item;
      } else {
        deduplicated.push(item);
      }
    }

    if (deduplicated.length < 2) {
      return `
        <div class="lr-chart-empty">
          <span class="lr-chart-empty-icon">↝</span>
          <strong>Недостаточно данных</strong>
          <small>
            Для графика нужны минимум две разные точки наблюдения.
          </small>
        </div>
      `;
    }

    const values = deduplicated.map((item) => item.value);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const rawRange = Math.max(rawMax - rawMin, 1);

    const minimumVisualRange = Math.max(
      kind === 'subscribers' ? Math.abs(rawMax) * 0.006 : 0,
      rawRange * 1.5,
      kind === 'subscribers' ? 10 : 5,
    );

    const centeredMin = (rawMin + rawMax - minimumVisualRange) / 2;
    const centeredMax = (rawMin + rawMax + minimumVisualRange) / 2;
    const step = chartNiceStep(centeredMax - centeredMin, 5);

    let axisMin = Math.floor(centeredMin / step) * step;
    let axisMax = Math.ceil(centeredMax / step) * step;

    if (axisMax <= axisMin) {
      axisMax = axisMin + step;
    }

    const width = 420;
    const height = 232;
    const plotLeft = 58;
    const plotRight = 16;
    const plotTop = 18;
    const plotBottom = 42;
    const plotWidth = width - plotLeft - plotRight;
    const plotHeight = height - plotTop - plotBottom;

    const firstTime = deduplicated[0].time;
    const lastTime = deduplicated[deduplicated.length - 1].time;
    const timeRange = Math.max(lastTime - firstTime, 1);
    const valueRange = Math.max(axisMax - axisMin, 1);

    const coordinates = deduplicated.map((item, index) => {
      const timeRatio =
        Number.isFinite(item.time) && lastTime !== firstTime
          ? (item.time - firstTime) / timeRange
          : index / Math.max(1, deduplicated.length - 1);

      const x = plotLeft + timeRatio * plotWidth;
      const y =
        plotTop +
        ((axisMax - item.value) / valueRange) * plotHeight;

      return {
        ...item,
        x,
        y,
      };
    });

    const linePath = coordinates
      .map(
        (item, index) =>
          `${index === 0 ? 'M' : 'L'} ${item.x.toFixed(2)} ${item.y.toFixed(2)}`,
      )
      .join(' ');

    const areaPath = [
      linePath,
      `L ${coordinates[coordinates.length - 1].x.toFixed(2)} ${(plotTop + plotHeight).toFixed(2)}`,
      `L ${coordinates[0].x.toFixed(2)} ${(plotTop + plotHeight).toFixed(2)}`,
      'Z',
    ].join(' ');

    const gridCount = 4;
    const grid = Array.from({ length: gridCount + 1 }, (_, index) => {
      const ratio = index / gridCount;
      const y = plotTop + ratio * plotHeight;
      const value = axisMax - ratio * valueRange;

      return `
        <line class="lr-chart-grid-line"
              x1="${plotLeft}"
              y1="${y.toFixed(2)}"
              x2="${width - plotRight}"
              y2="${y.toFixed(2)}"/>
        <text class="lr-chart-y-label"
              x="${plotLeft - 9}"
              y="${(y + 3).toFixed(2)}"
              text-anchor="end">
          ${escapeHtml(chartAxisNumber(value))}
        </text>
      `;
    }).join('');

    const labelIndexes = [
      0,
      Math.round((coordinates.length - 1) / 2),
      coordinates.length - 1,
    ].filter((value, index, array) => array.indexOf(value) === index);

    const xLabels = labelIndexes.map((index, labelIndex) => {
      const item = coordinates[index];
      const anchor =
        labelIndex === 0
          ? 'start'
          : labelIndex === labelIndexes.length - 1
            ? 'end'
            : 'middle';

      return `
        <text class="lr-chart-x-label"
              x="${item.x.toFixed(2)}"
              y="${height - 13}"
              text-anchor="${anchor}">
          ${escapeHtml(chartDateLabel(item.time, period))}
        </text>
      `;
    }).join('');

    const showAllPoints = coordinates.length <= 14;
    const points = coordinates.map((item, index) => {
      const last = index === coordinates.length - 1;

      if (!showAllPoints && !last) return '';

      return `
        ${last ? `
          <circle class="lr-chart-last-halo"
                  cx="${item.x.toFixed(2)}"
                  cy="${item.y.toFixed(2)}"
                  r="9"/>
        ` : ''}
        <circle class="lr-chart-point ${last ? 'is-last' : ''}"
                cx="${item.x.toFixed(2)}"
                cy="${item.y.toFixed(2)}"
                r="${last ? 4.5 : 3}">
          <title>
            ${escapeHtml(chartDateLabel(item.time, period))}: ${escapeHtml(formatNumber(item.value))}
          </title>
        </circle>
      `;
    }).join('');

    const firstValue = coordinates[0].value;
    const lastValue = coordinates[coordinates.length - 1].value;
    const change = lastValue - firstValue;
    const changeClass =
      change > 0 ? 'positive' : change < 0 ? 'negative' : 'muted';

    const uid = `lr-${kind}-${chartHash(
      `${channelId}-${period}-${firstTime}-${lastTime}-${field}`,
    )}`;

    const strokeClass =
      kind === 'subscribers'
        ? 'lr-chart-line-subscribers'
        : 'lr-chart-line-views';

    const gradientStart =
      kind === 'subscribers'
        ? 'rgba(89,221,160,.30)'
        : 'rgba(115,183,255,.28)';

    const gradientEnd =
      kind === 'subscribers'
        ? 'rgba(89,221,160,0)'
        : 'rgba(115,183,255,0)';

    return `
      <div class="lr-professional-chart">
        <div class="lr-chart-summary">
          <div>
            <span>Текущее значение</span>
            <strong>${escapeHtml(formatNumber(lastValue))}</strong>
          </div>

          <div>
            <span>Изменение за период</span>
            <strong class="${changeClass}">
              ${escapeHtml(formatSigned(change))}
            </strong>
          </div>
        </div>

        <svg class="lr-chart-svg"
             viewBox="0 0 ${width} ${height}"
             role="img"
             aria-label="График ${kind === 'subscribers' ? 'подписчиков' : 'просмотров'}">
          <defs>
            <linearGradient id="${uid}"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1">
              <stop offset="0%" stop-color="${gradientStart}"/>
              <stop offset="100%" stop-color="${gradientEnd}"/>
            </linearGradient>
          </defs>

          ${grid}

          <path class="lr-chart-area"
                d="${areaPath}"
                fill="url(#${uid})"/>

          <path class="${strokeClass}"
                d="${linePath}"/>

          ${points}
          ${xLabels}
        </svg>
      </div>
    `;
  }


  function channelPostRows(channel) {
    const posts = Array.isArray(channel.posts)
      ? channel.posts.slice(0, 5)
      : [];

    if (!posts.length) {
      return `
        <article class="post-row">
          <div>
            <strong>Публикаций пока нет</strong>
            <p>Новые посты появятся после работы Studio.</p>
          </div>
        </article>
      `;
    }

    return posts.map(postHtml).join('');
  }

  function channelDetailHtml(channel) {
    const period = state.periods.get(channel.id) || '7d';
    const points = chartData(channel, period);
    const metrics = channel.metrics || {};
    const anti = channel.antifraud || {};

    return `
      <div class="channel-details">
        ${
          !channel.analyticsEnabled
            ? `
              <section class="panel"
                       style="margin-bottom:12px">
                <div class="panel-title">
                  <h3>Аналитика канала отключена</h3>
                </div>
                <p class="muted"
                   style="margin:0;font-size:12px;line-height:1.5">
                  Сбор подписчиков, просмотров, прироста и ER для этого
                  канала сейчас не выполняется. Включить функцию можно
                  в разделе аналитики LinkRay в MAX.
                </p>
              </section>
            `
            : ''
        }

        <section class="detail-grid">
          <article class="detail-item">
            <span>Просмотры 48 ч</span>
            <strong>${formatNumber(metrics.views48)}</strong>
          </article>

          <article class="detail-item">
            <span>Просмотры 72 ч</span>
            <strong>${formatNumber(metrics.views72)}</strong>
          </article>

          <article class="detail-item">
            <span>ER за 24 ч</span>
            <strong>${formatPercent(metrics.er24)}</strong>
          </article>

          <article class="detail-item">
            <span>Администраторы</span>
            <strong>${formatNumber(channel.teamCount)}</strong>
          </article>

          <article class="detail-item">
            <span>Подписки за 24 ч</span>
            <strong class="positive">${formatNumber(metrics.joined24h)}</strong>
          </article>

          <article class="detail-item">
            <span>Отписки за 24 ч</span>
            <strong class="negative">${formatNumber(metrics.left24h)}</strong>
          </article>

          <article class="detail-item">
            <span>Обновлено</span>
            <strong>${escapeHtml(formatDate(metrics.capturedAt))}</strong>
          </article>

          <article class="detail-item">
            <span>Доступ бота</span>
            <strong class="${channel.botAccess ? 'positive' : 'negative'}">
              ${channel.botAccess ? 'Есть' : 'Нет'}
            </strong>
          </article>
        </section>

        ${
          channel.analyticsEnabled
            ? `
              <section class="chart-card">
                <div class="chart-head">
                  <strong>Подписчики</strong>
                  <div class="periods">
                    ${['24h', '7d', '30d'].map((item) => `
                      <button type="button"
                              class="${period === item ? 'active' : ''}"
                              data-action="period"
                              data-channel-id="${escapeHtml(channel.id)}"
                              data-period="${item}">
                        ${item === '24h' ? '24 ч' : item === '7d' ? '7 дн' : '30 дн'}
                      </button>
                    `).join('')}
                  </div>
                </div>
                ${professionalChart(points, 'subscribers', 'subscribers', period, channel.id)}
              </section>

              <section class="chart-card">
                <div class="chart-head">
                  <strong>Просмотры за 24 часа</strong>
                </div>
                ${professionalChart(points, 'views24', 'views', period, channel.id)}
              </section>
            `
            : ''
        }

        <section class="detail-section">
          <h4>AntiFraud</h4>
          <div class="antifraud-row">
            <div>
              <strong>${escapeHtml(anti.label || 'Нет данных')}</strong>
              <p>
                Событий за 24 ч: ${formatNumber(anti.events24h)} ·
                ПДП до наплыва: ${formatNumber(anti.pdpBefore)}
              </p>
            </div>
            <span class="risk-pill risk-${escapeHtml(anti.level || 'safe')}">
              ${anti.enabled ? 'Защита включена' : 'Защита выключена'}
            </span>
          </div>
        </section>

        <section class="detail-section">
          <h4>Последние публикации</h4>
          <div class="post-list">${channelPostRows(channel)}</div>
        </section>

        <div class="actions">
          <button type="button"
                  class="secondary"
                  data-action="download-png"
                  data-channel-id="${escapeHtml(channel.id)}">
            Скачать PNG
          </button>

          <button type="button"
                  class="secondary"
                  data-action="download-csv"
                  data-channel-id="${escapeHtml(channel.id)}">
            Скачать CSV
          </button>

          <a class="primary full-width"
             href="${BOT_URL}"
             target="_blank"
             rel="noopener noreferrer">
            Открыть канал в LinkRay MAX
          </a>
        </div>
      </div>
    `;
  }

  function channelCardHtml(channel) {
    const open = state.openChannelId === channel.id;
    const metrics = channel.metrics || {};
    /* LINKRAY_ANALYTICS_ENABLED_STATUS_V1 */
    const readyText = !channel.analyticsEnabled
      ? 'Аналитика канала отключена'
      : channel.analyticsReady
        ? channel.full24hReady
          ? `Обновлено ${formatDate(metrics.capturedAt)}`
          : 'Накапливается полный период 24 часа'
        : 'Данные аналитики собираются';

    return `
      <article class="channel-card ${open ? 'open' : ''}">
        <button type="button"
                class="channel-summary"
                data-action="toggle-channel"
                data-channel-id="${escapeHtml(channel.id)}">
          <div class="channel-top">
            <div class="channel-title">
              <h3>${escapeHtml(channel.title || `Канал ${channel.id}`)}</h3>
              <p>${escapeHtml(readyText)}</p>
            </div>
            <span class="channel-chevron">⌄</span>
          </div>

          <div class="channel-metrics">
            <div>
              <strong>${formatNumber(metrics.subscribers)}</strong>
              <span>подписчиков</span>
            </div>

            <div>
              <strong>${formatNumber(metrics.views24)}</strong>
              <span>просмотров 24 ч</span>
            </div>

            <div>
              <strong class="${metricClass(metrics.deltaDay)}">
                ${formatSigned(metrics.deltaDay)}
              </strong>
              <span>изменение за сутки</span>
            </div>
          </div>
        </button>

        ${open ? channelDetailHtml(channel) : ''}
      </article>
    `;
  }

  function channelsHtml(payload) {
    const channels = Array.isArray(payload.channels)
      ? payload.channels
      : [];

    return `
      <section class="tab-view" data-view="channels">
        <div class="section-head">
          <div>
            <span class="eyebrow">Аналитика каналов</span>
            <h2>Мои каналы</h2>
            <p>
              Аналитика включена для
              ${formatNumber(payload.summary?.analyticsEnabledChannels)}
              из ${formatNumber(payload.summary?.channels)} ·
              данные готовы для
              ${formatNumber(payload.summary?.analyticsReadyChannels)}
            </p>
          </div>
          <a href="${BOT_URL}" target="_blank" rel="noopener noreferrer">
            Studio в MAX
          </a>
        </div>

        <section class="channel-list">
          ${
            channels.length
              ? channels.map(channelCardHtml).join('')
              : `
                <section class="empty-card">
                  <h2>Подключённых каналов пока нет</h2>
                  <p>
                    Добавь LinkRay администратором канала и перешли
                    боту любой пост из этого канала.
                  </p>
                  <div class="actions">
                    <a class="primary full-width"
                       href="${BOT_URL}"
                       target="_blank"
                       rel="noopener noreferrer">
                      Открыть LinkRay в MAX
                    </a>
                  </div>
                </section>
              `
          }
        </section>
      </section>
    `;
  }

  function render() {
    const payload = state.payload;
    if (!payload) return;

    root.innerHTML = `
      <header class="header">
        <div class="profile">
          <img src="/linkray-site/linkray-logo-exact.webp"
               alt="LinkRay"
               onerror="this.src='/linkray-site/icon-192.png'">

          <div class="profile-copy">
            <span class="eyebrow">Личный кабинет</span>
            <h1>${escapeHtml(payload.user?.displayName || 'Пользователь LinkRay')}</h1>
            <p>
              ID ${escapeHtml(payload.user?.linkrayId || '—')} ·
              обновлено ${escapeHtml(formatDate(payload.updatedAt))}
            </p>
          </div>
        </div>

        <button type="button"
                class="icon-button"
                data-action="refresh"
                aria-label="Обновить">
          ↻
        </button>
      </header>

      ${state.tab === 'overview' ? overviewHtml(payload) : channelsHtml(payload)}
    `;

    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.classList.toggle(
        'active',
        button.getAttribute('data-tab') === state.tab,
      );
    });
  }

  function findChannel(id) {
    return (state.payload?.channels || []).find(
      (channel) => String(channel.id) === String(id),
    );
  }

  function downloadBlob(filename, type, content) {
    const blob = content instanceof Blob
      ? content
      : new Blob([content], { type });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCsv(channel) {
    const rows = Array.isArray(channel.history30d)
      ? channel.history30d
      : [];

    const lines = [
      [
        'date',
        'subscribers',
        'views24',
        'deltaDay',
        'er24',
      ].join(';'),
      ...rows.map((row) => [
        row.date || '',
        row.subscribers ?? '',
        row.views24 ?? '',
        row.deltaDay ?? '',
        row.er24 ?? '',
      ].join(';')),
    ];

    downloadBlob(
      `linkray-${channel.id}-analytics.csv`,
      'text/csv;charset=utf-8',
      '\uFEFF' + lines.join('\n'),
    );
  }


  function reportRoundRect(ctx, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);

    ctx.beginPath();
    ctx.moveTo(x + safeRadius, y);
    ctx.lineTo(x + width - safeRadius, y);
    ctx.quadraticCurveTo(
      x + width,
      y,
      x + width,
      y + safeRadius,
    );
    ctx.lineTo(x + width, y + height - safeRadius);
    ctx.quadraticCurveTo(
      x + width,
      y + height,
      x + width - safeRadius,
      y + height,
    );
    ctx.lineTo(x + safeRadius, y + height);
    ctx.quadraticCurveTo(
      x,
      y + height,
      x,
      y + height - safeRadius,
    );
    ctx.lineTo(x, y + safeRadius);
    ctx.quadraticCurveTo(x, y, x + safeRadius, y);
    ctx.closePath();
  }

  function reportTextLines(ctx, text, maxWidth, maxLines = 2) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;

      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line) lines.push(line);
      line = word;

      if (lines.length >= maxLines - 1) break;
    }

    if (line && lines.length < maxLines) {
      lines.push(line);
    }

    if (words.length && lines.length === maxLines) {
      const joined = lines.join(' ');
      const original = words.join(' ');

      if (joined.length < original.length) {
        let last = lines[lines.length - 1];

        while (
          last.length > 1 &&
          ctx.measureText(`${last}…`).width > maxWidth
        ) {
          last = last.slice(0, -1);
        }

        lines[lines.length - 1] = `${last.trim()}…`;
      }
    }

    return lines;
  }

  function reportPointTime(point, index) {
    const raw = point?.capturedAt || point?.date;
    const time = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(time) ? time : index;
  }

  function reportMedian(values) {
    if (!values.length) return 0;

    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function prepareReportPoints(
    sourcePoints,
    field,
    positiveOnly = false,
  ) {
    const prepared = (Array.isArray(sourcePoints) ? sourcePoints : [])
      .map((point, index) => ({
        point,
        value: numberOrNull(point?.[field]),
        time: reportPointTime(point, index),
        sourceIndex: index,
      }))
      .filter((item) => {
        if (item.value === null) return false;
        if (positiveOnly && item.value <= 0) return false;
        return true;
      })
      .sort((left, right) => {
        if (left.time !== right.time) return left.time - right.time;
        return left.sourceIndex - right.sourceIndex;
      });

    const deduplicated = [];

    for (const item of prepared) {
      const previous = deduplicated[deduplicated.length - 1];

      if (previous && previous.time === item.time) {
        deduplicated[deduplicated.length - 1] = item;
      } else {
        deduplicated.push(item);
      }
    }

    if (deduplicated.length >= 5) {
      const followingValues = deduplicated
        .slice(1, Math.min(6, deduplicated.length))
        .map((item) => item.value);

      const followingMedian = reportMedian(followingValues);
      const first = deduplicated[0].value;
      const difference = Math.abs(first - followingMedian);
      const threshold = Math.max(
        positiveOnly ? 100 : 30,
        Math.abs(followingMedian) * 0.18,
      );

      if (difference > threshold) {
        deduplicated.shift();
      }
    }

    return deduplicated;
  }

  function reportNiceStep(range, targetTicks = 5) {
    const safeRange = Math.max(Number(range) || 0, 1);
    const rough = safeRange / Math.max(1, targetTicks - 1);
    const power = 10 ** Math.floor(Math.log10(rough));
    const fraction = rough / power;

    const niceFraction =
      fraction <= 1
        ? 1
        : fraction <= 2
          ? 2
          : fraction <= 5
            ? 5
            : 10;

    return niceFraction * power;
  }

  function reportAxisNumber(value) {
    const absolute = Math.abs(value);

    if (absolute >= 1000000) {
      return `${(value / 1000000).toFixed(1).replace('.0', '')} млн`;
    }

    if (absolute >= 10000) {
      return `${(value / 1000).toFixed(1).replace('.0', '')} тыс.`;
    }

    return new Intl.NumberFormat('ru-RU', {
      maximumFractionDigits: absolute < 10 ? 1 : 0,
    }).format(value);
  }

  function reportDateLabel(time) {
    const date = new Date(time);

    if (Number.isNaN(date.getTime())) return '';

    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
    }).format(date);
  }

  function drawReportMetric(
    ctx,
    x,
    y,
    width,
    label,
    value,
    accent = '#f3f8fb',
  ) {
    reportRoundRect(ctx, x, y, width, 118, 22);
    ctx.fillStyle = '#0c2939';
    ctx.fill();

    ctx.fillStyle = '#8da3b5';
    ctx.font = '26px sans-serif';
    ctx.fillText(label, x + 26, y + 40);

    ctx.fillStyle = accent;
    ctx.font = '700 44px sans-serif';
    ctx.fillText(value, x + 26, y + 91);
  }

  function drawReportChart(
    ctx,
    {
      sourcePoints,
      field,
      title,
      x,
      y,
      width,
      height,
      color,
      positiveOnly = false,
    },
  ) {
    reportRoundRect(ctx, x, y, width, height, 26);
    ctx.fillStyle = '#092230';
    ctx.fill();

    ctx.fillStyle = '#f3f8fb';
    ctx.font = '700 30px sans-serif';
    ctx.fillText(title, x + 34, y + 48);

    const points = prepareReportPoints(
      sourcePoints,
      field,
      positiveOnly,
    );

    if (points.length < 2) {
      ctx.fillStyle = '#8da3b5';
      ctx.font = '26px sans-serif';
      ctx.fillText(
        'Недостаточно данных для графика',
        x + 34,
        y + height / 2,
      );
      return;
    }

    const values = points.map((point) => point.value);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const rawRange = Math.max(rawMax - rawMin, 1);

    const minimumVisualRange = Math.max(
      positiveOnly ? Math.abs(rawMax) * 0.006 : 0,
      rawRange * 1.5,
      positiveOnly ? 10 : 5,
    );

    const centeredMin =
      (rawMin + rawMax - minimumVisualRange) / 2;
    const centeredMax =
      (rawMin + rawMax + minimumVisualRange) / 2;

    const step = reportNiceStep(
      centeredMax - centeredMin,
      5,
    );

    let axisMin = Math.floor(centeredMin / step) * step;
    let axisMax = Math.ceil(centeredMax / step) * step;

    if (axisMax <= axisMin) {
      axisMax = axisMin + step;
    }

    const plotLeft = x + 90;
    const plotRight = x + width - 32;
    const plotTop = y + 84;
    const plotBottom = y + height - 58;
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;
    const valueRange = Math.max(axisMax - axisMin, 1);

    const firstTime = points[0].time;
    const lastTime = points[points.length - 1].time;
    const timeRange = Math.max(lastTime - firstTime, 1);

    const coordinates = points.map((point, index) => {
      const ratio =
        lastTime !== firstTime
          ? (point.time - firstTime) / timeRange
          : index / Math.max(1, points.length - 1);

      return {
        ...point,
        x: plotLeft + ratio * plotWidth,
        y:
          plotTop +
          ((axisMax - point.value) / valueRange) *
            plotHeight,
      };
    });

    for (let index = 0; index <= 4; index += 1) {
      const ratio = index / 4;
      const lineY = plotTop + ratio * plotHeight;
      const value = axisMax - ratio * valueRange;

      ctx.strokeStyle = 'rgba(144,170,188,.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotLeft, lineY);
      ctx.lineTo(plotRight, lineY);
      ctx.stroke();

      ctx.fillStyle = '#7890a2';
      ctx.font = '19px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(
        reportAxisNumber(value),
        plotLeft - 14,
        lineY + 6,
      );
    }

    const gradient = ctx.createLinearGradient(
      0,
      plotTop,
      0,
      plotBottom,
    );
    gradient.addColorStop(0, `${color}55`);
    gradient.addColorStop(1, `${color}00`);

    ctx.beginPath();
    coordinates.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.lineTo(
      coordinates[coordinates.length - 1].x,
      plotBottom,
    );
    ctx.lineTo(coordinates[0].x, plotBottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    coordinates.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    const showAllPoints = coordinates.length <= 14;

    coordinates.forEach((point, index) => {
      const last = index === coordinates.length - 1;

      if (!showAllPoints && !last) return;

      if (last) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 13, 0, Math.PI * 2);
        ctx.fillStyle = `${color}35`;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(
        point.x,
        point.y,
        last ? 6 : 4,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = last ? '#f4fbf8' : '#092230';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
    });

    const labelIndexes = [
      0,
      Math.round((coordinates.length - 1) / 2),
      coordinates.length - 1,
    ].filter(
      (value, index, array) =>
        array.indexOf(value) === index,
    );

    ctx.font = '19px sans-serif';
    ctx.fillStyle = '#7890a2';

    labelIndexes.forEach((pointIndex, labelIndex) => {
      const point = coordinates[pointIndex];

      ctx.textAlign =
        labelIndex === 0
          ? 'left'
          : labelIndex === labelIndexes.length - 1
            ? 'right'
            : 'center';

      ctx.fillText(
        reportDateLabel(point.time),
        point.x,
        plotBottom + 34,
      );
    });

    const current = coordinates[coordinates.length - 1].value;
    const change = current - coordinates[0].value;

    ctx.textAlign = 'right';
    ctx.fillStyle = '#8da3b5';
    ctx.font = '21px sans-serif';
    ctx.fillText(
      `Сейчас ${formatNumber(current)} · за период ${formatSigned(change)}`,
      plotRight,
      y + 48,
    );

    ctx.textAlign = 'left';
  }

  function downloadPng(channel) {
    const canvas = document.createElement('canvas');
    canvas.width = 1400;
    canvas.height = 1260;

    const ctx = canvas.getContext('2d');
    const metrics = channel.metrics || {};
    const history = Array.isArray(channel.history30d)
      ? channel.history30d
      : [];

    const background = ctx.createLinearGradient(
      0,
      0,
      0,
      canvas.height,
    );
    background.addColorStop(0, '#071b28');
    background.addColorStop(1, '#03101a');

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#59dda0';
    ctx.font = '700 30px sans-serif';
    ctx.fillText('LINKRAY · ОТЧЁТ КАНАЛА', 72, 70);

    ctx.fillStyle = '#f3f8fb';
    ctx.font = '700 54px sans-serif';

    const titleLines = reportTextLines(
      ctx,
      channel.title || `Канал ${channel.id}`,
      1240,
      2,
    );

    titleLines.forEach((line, index) => {
      ctx.fillText(line, 72, 142 + index * 62);
    });

    const titleBottom =
      142 + Math.max(0, titleLines.length - 1) * 62;

    ctx.fillStyle = '#8da3b5';
    ctx.font = '26px sans-serif';
    ctx.fillText(
      `Обновлено: ${formatDate(metrics.capturedAt)}`,
      72,
      titleBottom + 48,
    );

    const cardsY = titleBottom + 88;
    const cardWidth = 610;
    const gap = 36;

    drawReportMetric(
      ctx,
      72,
      cardsY,
      cardWidth,
      'Подписчики',
      formatNumber(metrics.subscribers),
    );

    drawReportMetric(
      ctx,
      72 + cardWidth + gap,
      cardsY,
      cardWidth,
      'Просмотры за 24 часа',
      formatNumber(metrics.views24),
    );

    drawReportMetric(
      ctx,
      72,
      cardsY + 138,
      cardWidth,
      'Изменение за сутки',
      formatSigned(metrics.deltaDay),
      Number(metrics.deltaDay || 0) < 0
        ? '#ff91a5'
        : '#59dda0',
    );

    drawReportMetric(
      ctx,
      72 + cardWidth + gap,
      cardsY + 138,
      cardWidth,
      'ER за 24 часа',
      formatPercent(metrics.er24),
    );

    const firstChartY = cardsY + 306;

    drawReportChart(ctx, {
      sourcePoints: history,
      field: 'subscribers',
      title: 'Подписчики за 30 дней',
      x: 72,
      y: firstChartY,
      width: 1256,
      height: 320,
      color: '#59dda0',
      positiveOnly: true,
    });

    drawReportChart(ctx, {
      sourcePoints: history,
      field: 'views24',
      title: 'Просмотры за 24 часа',
      x: 72,
      y: firstChartY + 346,
      width: 1256,
      height: 320,
      color: '#73b7ff',
      positiveOnly: false,
    });

    ctx.fillStyle = '#8da3b5';
    ctx.font = '24px sans-serif';
    ctx.fillText(
      `AntiFraud: ${channel.antifraud?.label || 'нет данных'}`,
      72,
      1215,
    );

    ctx.textAlign = 'right';
    ctx.fillText(
      `Сформировано ${formatDate(new Date().toISOString())}`,
      1328,
      1215,
    );
    ctx.textAlign = 'left';

    canvas.toBlob((blob) => {
      if (!blob) return;

      downloadBlob(
        `linkray-${channel.id}-report.png`,
        'image/png',
        blob,
      );
    }, 'image/png');
  }


  async function load() {
    loading();

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);

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

      state.payload = body;
      render();
    } catch (error) {
      errorScreen(
        error?.name === 'AbortError'
          ? 'Сервер не ответил за 15 секунд.'
          : error?.message || 'Неизвестная ошибка загрузки.',
        Number(error?.status || 0),
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');

    if (tab) {
      state.tab = tab.getAttribute('data-tab') || 'overview';
      state.openChannelId = null;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const actionElement = event.target.closest('[data-action]');
    if (!actionElement) return;

    const action = actionElement.getAttribute('data-action');

    if (action === 'retry' || action === 'refresh') {
      load();
      return;
    }

    if (action === 'toggle-notices') {
      state.noticesExpanded = !state.noticesExpanded;
      render();
      return;
    }

    if (action === 'toggle-channel') {
      const id = actionElement.getAttribute('data-channel-id');
      state.openChannelId =
        state.openChannelId === id ? null : id;
      render();
      return;
    }

    if (action === 'period') {
      const id = actionElement.getAttribute('data-channel-id');
      const period = actionElement.getAttribute('data-period') || '7d';
      state.periods.set(id, period);
      state.openChannelId = id;
      render();
      return;
    }

    if (action === 'download-csv') {
      const channel = findChannel(
        actionElement.getAttribute('data-channel-id'),
      );
      if (channel) downloadCsv(channel);
      return;
    }

    if (action === 'download-png') {
      const channel = findChannel(
        actionElement.getAttribute('data-channel-id'),
      );
      if (channel) downloadPng(channel);
    }
  });

  load();
})();
