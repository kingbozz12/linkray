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
            Скачать отчёт
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



  /*
   * LINKRAY_SAME_BOT_REPORT_FRONTEND_V1
   * Сайт больше не рисует PNG самостоятельно.
   * Он скачивает результат серверного renderSingle() из бота.
   */
  async function downloadPng(channel) {
    const channelId = String(channel?.id || '').trim();

    if (!channelId) {
      window.alert('Не удалось определить канал.');
      return;
    }

    const button = [
      ...document.querySelectorAll(
        '[data-action="download-png"]',
      ),
    ].find(
      (element) =>
        String(
          element.getAttribute('data-channel-id') || '',
        ) === channelId,
    );

    const originalText = button?.textContent || '';

    if (button) {
      button.disabled = true;
      button.textContent = 'Создаём отчёт…';
    }

    try {
      const response = await fetch(
        `/api/website/cabinet/channel/${encodeURIComponent(channelId)}/bot-report.png`,
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            Accept: 'image/png, application/json',
            'Cache-Control': 'no-cache',
          },
        },
      );

      if (!response.ok) {
        const contentType =
          response.headers.get('content-type') || '';

        let message = `Ошибка ${response.status}`;

        if (contentType.includes('application/json')) {
          const body = await response.json();
          message = body?.error || message;
        } else {
          const text = (await response.text()).trim();
          if (text) message = text.slice(0, 300);
        }

        throw new Error(message);
      }

      const blob = await response.blob();

      if (!blob.size) {
        throw new Error('Сервер вернул пустой отчёт.');
      }

      downloadBlob(
        `linkray-bot-report-${channelId}.png`,
        'image/png',
        blob,
      );
    } catch (error) {
      window.alert(
        error?.message ||
        'Не удалось скачать отчёт.',
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent =
          originalText || 'Скачать отчёт';
      }
    }
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
