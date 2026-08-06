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

  const postHtml = (post) => {
    const date =
      post.status === 'scheduled'
        ? post.publishAt
        : post.publishedAt || post.createdAt;

    return `
      <article class="post-row">
        <div>
          <strong>
            ${post.isAd ? '💼 ' : ''}
            ${escapeHtml(post.channelTitle || 'Канал')}
          </strong>
          <p>${escapeHtml(post.text || 'Публикация без текста')}</p>
        </div>
        <div>
          <span class="status-pill status-${escapeHtml(post.status)}">
            ${escapeHtml(statusLabel(post.status))}
          </span>
          <div class="post-meta">${escapeHtml(formatDate(date))}</div>
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

  function svgChart(points, field, cssClass) {
    const values = points
      .map((point) => numberOrNull(point[field]))
      .filter((value) => value !== null);

    if (values.length < 2) {
      return '<div class="chart-empty">Недостаточно точек для графика</div>';
    }

    const width = 320;
    const height = 120;
    const left = 8;
    const right = 8;
    const top = 13;
    const bottom = 20;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(1, max - min);

    const coords = values.map((value, index) => {
      const x =
        left +
        (index / Math.max(1, values.length - 1)) *
          (width - left - right);

      const y =
        top +
        ((max - value) / range) *
          (height - top - bottom);

      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    return `
      <svg class="chart"
           viewBox="0 0 ${width} ${height}"
           role="img"
           aria-label="График">
        <line x1="${left}" y1="${height - bottom}"
              x2="${width - right}" y2="${height - bottom}"
              stroke="rgba(255,255,255,.08)"/>
        <text class="chart-label" x="${left}" y="9">${escapeHtml(formatNumber(max))}</text>
        <text class="chart-label" x="${left}" y="${height - 5}">${escapeHtml(formatNumber(min))}</text>
        <polyline class="${cssClass}" points="${coords.join(' ')}"/>
      </svg>
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
                ${svgChart(points, 'subscribers', 'chart-line-subscribers')}
              </section>

              <section class="chart-card">
                <div class="chart-head">
                  <strong>Просмотры за 24 часа</strong>
                </div>
                ${svgChart(points, 'views24', 'chart-line-views')}
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

  function drawReportGraph(ctx, points, field, x, y, width, height, stroke) {
    const values = points
      .map((point) => numberOrNull(point[field]))
      .filter((value) => value !== null);

    if (values.length < 2) {
      ctx.fillStyle = '#8da3b5';
      ctx.font = '28px sans-serif';
      ctx.fillText('Недостаточно данных', x, y + height / 2);
      return;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(1, max - min);

    ctx.beginPath();

    values.forEach((value, index) => {
      const px = x + (index / Math.max(1, values.length - 1)) * width;
      const py = y + ((max - value) / range) * height;

      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });

    ctx.strokeStyle = stroke;
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function downloadPng(channel) {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 900;

    const ctx = canvas.getContext('2d');
    const metrics = channel.metrics || {};
    const points = Array.isArray(channel.history30d)
      ? channel.history30d
      : [];

    const gradient = ctx.createLinearGradient(0, 0, 0, 900);
    gradient.addColorStop(0, '#071b28');
    gradient.addColorStop(1, '#04101b');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1200, 900);

    ctx.fillStyle = '#59dda0';
    ctx.font = '700 30px sans-serif';
    ctx.fillText('LINKRAY · ОТЧЁТ КАНАЛА', 70, 75);

    ctx.fillStyle = '#f3f8fb';
    ctx.font = '700 52px sans-serif';
    ctx.fillText(channel.title || `Канал ${channel.id}`, 70, 145);

    ctx.fillStyle = '#8da3b5';
    ctx.font = '26px sans-serif';
    ctx.fillText(`Обновлено: ${formatDate(metrics.capturedAt)}`, 70, 188);

    const cards = [
      ['Подписчики', formatNumber(metrics.subscribers)],
      ['Просмотры 24 ч', formatNumber(metrics.views24)],
      ['Изменение', formatSigned(metrics.deltaDay)],
      ['ER 24 ч', formatPercent(metrics.er24)],
    ];

    cards.forEach(([label, value], index) => {
      const x = 70 + (index % 2) * 535;
      const y = 235 + Math.floor(index / 2) * 145;

      ctx.fillStyle = '#0c2939';
      ctx.fillRect(x, y, 495, 115);

      ctx.fillStyle = '#8da3b5';
      ctx.font = '24px sans-serif';
      ctx.fillText(label, x + 25, y + 38);

      ctx.fillStyle = '#f3f8fb';
      ctx.font = '700 42px sans-serif';
      ctx.fillText(value, x + 25, y + 88);
    });

    ctx.fillStyle = '#f3f8fb';
    ctx.font = '700 30px sans-serif';
    ctx.fillText('Подписчики за 30 дней', 70, 560);

    drawReportGraph(
      ctx,
      points,
      'subscribers',
      70,
      600,
      1060,
      190,
      '#59dda0',
    );

    ctx.fillStyle = '#8da3b5';
    ctx.font = '24px sans-serif';
    ctx.fillText(
      `AntiFraud: ${channel.antifraud?.label || 'нет данных'}`,
      70,
      850,
    );

    canvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(
          `linkray-${channel.id}-report.png`,
          'image/png',
          blob,
        );
      }
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
