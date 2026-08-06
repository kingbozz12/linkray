(() => {
  'use strict';

  const API = '/api/website/cabinet/operations';
  const root = document.getElementById('lr-cabinet');

  if (!root) return;

  const state = {
    data: null,
    error: '',
    loading: true,
    renderTimer: null,
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
    return parsed === null
      ? '—'
      : new Intl.NumberFormat('ru-RU').format(parsed);
  };

  const formatMoney = (value) => {
    const parsed = numberOrNull(value);
    return parsed === null
      ? '—'
      : `${new Intl.NumberFormat('ru-RU', {
          maximumFractionDigits: 2,
        }).format(parsed)} ₽`;
  };

  const formatSigned = (value) => {
    const parsed = numberOrNull(value);
    if (parsed === null) return '—';
    return `${parsed > 0 ? '+' : ''}${formatNumber(parsed)}`;
  };

  const formatPercent = (value) => {
    const parsed = numberOrNull(value);
    return parsed === null
      ? '—'
      : `${parsed.toFixed(1).replace('.0', '')}%`;
  };

  const formatDate = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';

    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const shortDevice = (value) => {
    const text = String(value || 'Неизвестное устройство');

    if (/Android/i.test(text)) return 'Android · мобильный браузер';
    if (/iPhone|iPad/i.test(text)) return 'iPhone/iPad · Safari';
    if (/Windows/i.test(text)) return 'Windows · браузер';
    if (/Macintosh|Mac OS/i.test(text)) return 'macOS · браузер';
    if (/Linux/i.test(text)) return 'Linux · браузер';

    return text.length > 65 ? `${text.slice(0, 62)}…` : text;
  };

  const levelLabel = (level) => ({
    ok: 'Работает',
    warning: 'Внимание',
    critical: 'Проблема',
    off: 'Отключено',
  }[level] || 'Статус');

  const postJson = async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok || body?.ok === false) {
      throw new Error(body?.error || `Ошибка ${response.status}`);
    }

    return body;
  };

  async function load() {
    state.loading = true;
    state.error = '';
    scheduleRender();

    try {
      const response = await fetch(API, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
        },
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || `Ошибка ${response.status}`);
      }

      state.data = body;
    } catch (error) {
      state.error = error?.message || 'Не удалось загрузить данные.';
    } finally {
      state.loading = false;
      scheduleRender();
    }
  }

  const metricCard = (label, value, className = '') => `
    <article class="lr-ops-metric">
      <span>${escapeHtml(label)}</span>
      <strong class="${className}">${escapeHtml(value)}</strong>
    </article>
  `;

  function healthHtml() {
    const rows = state.data?.channelHealth || [];

    return `
      <section class="lr-ops-root" data-lr-ops-root="channels">
        <div class="section-head lr-ops-heading">
          <div>
            <span class="eyebrow">Контроль состояния</span>
            <h2>Здоровье каналов</h2>
            <p>Доступ бота, аналитика, обновления и AntiFraud</p>
          </div>
          <button class="secondary" type="button" data-lr-action="refresh">
            Обновить
          </button>
        </div>

        <section class="lr-ops-health-grid">
          ${
            rows.length
              ? rows.map((row) => `
                <article class="lr-ops-health-card is-${escapeHtml(row.level)}">
                  <div class="lr-ops-health-top">
                    <strong>${escapeHtml(row.title)}</strong>
                    <span>${escapeHtml(levelLabel(row.level))}</span>
                  </div>
                  <ul>
                    ${(row.issues || []).map((issue) =>
                      `<li>${escapeHtml(issue)}</li>`,
                    ).join('')}
                  </ul>
                  <div class="lr-ops-health-meta">
                    <span>Последнее обновление</span>
                    <b>${escapeHtml(formatDate(row.lastSuccessAt))}</b>
                  </div>
                </article>
              `).join('')
              : '<div class="lr-ops-empty">Нет подключённых каналов.</div>'
          }
        </section>

        ${comparisonHtml()}
      </section>
    `;
  }

  function comparisonHtml() {
    const rows = state.data?.comparison || [];

    return `
      <details class="lr-ops-panel lr-ops-details" open>
        <summary>
          <span>
            <strong>Сравнение каналов</strong>
            <small>Подписчики, просмотры, ER и прирост</small>
          </span>
          <i>⌄</i>
        </summary>

        <div class="lr-ops-table-wrap">
          <table class="lr-ops-table">
            <thead>
              <tr>
                <th>Канал</th>
                <th>Место</th>
                <th>Подписчики</th>
                <th>Просмотры</th>
                <th>Прирост</th>
                <th>Подписки</th>
                <th>Отписки</th>
                <th>ER</th>
              </tr>
            </thead>
            <tbody>
              ${
                rows.length
                  ? rows.map((row) => `
                    <tr>
                      <td><strong>${escapeHtml(row.title)}</strong></td>
                      <td>${row.growthRank ? `#${row.growthRank}` : '—'}</td>
                      <td>${formatNumber(row.subscribers)}</td>
                      <td>${formatNumber(row.views24)}</td>
                      <td class="${Number(row.deltaDay || 0) < 0 ? 'negative' : 'positive'}">
                        ${formatSigned(row.deltaDay)}
                      </td>
                      <td class="positive">${formatNumber(row.joined24h)}</td>
                      <td class="negative">${formatNumber(row.left24h)}</td>
                      <td>${formatPercent(row.er24)}</td>
                    </tr>
                  `).join('')
                  : '<tr><td colspan="8">Данных для сравнения пока нет.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </details>
    `;
  }

  function purchasesHtml() {
    const purchases = state.data?.purchases || {};
    const summary = purchases.summary || {};
    const rows = purchases.rows || [];

    return `
      <section class="lr-ops-root" data-lr-ops-root="purchases">
        <div class="section-head lr-ops-heading">
          <div>
            <span class="eyebrow">Реклама</span>
            <h2>Закупы</h2>
            <p>Расходы и результат размещений за 24/48/72 часа</p>
          </div>
        </div>

        <section class="lr-ops-summary">
          ${metricCard('Размещений', formatNumber(summary.count))}
          ${metricCard('Расходы', formatMoney(summary.totalAmount))}
          ${metricCard('Средний CPM', formatMoney(summary.averageCpm))}
          ${metricCard('Получено подписчиков', formatNumber(summary.subscribers), 'positive')}
          ${metricCard('Цена подписчика', formatMoney(summary.costPerSubscriber))}
        </section>

        <section class="lr-ops-panel">
          <div class="lr-ops-table-wrap">
            <table class="lr-ops-table">
              <thead>
                <tr>
                  <th>Канал</th>
                  <th>Статус</th>
                  <th>Сумма</th>
                  <th>CPM</th>
                  <th>24 ч</th>
                  <th>48 ч</th>
                  <th>72 ч</th>
                  <th>Подписчики</th>
                  <th>Цена ПДП</th>
                </tr>
              </thead>
              <tbody>
                ${
                  rows.length
                    ? rows.slice(0, 20).map((row) => `
                      <tr>
                        <td>
                          <strong>${escapeHtml(row.channelTitle)}</strong>
                          <small>${escapeHtml(formatDate(row.createdAt))}</small>
                        </td>
                        <td>${escapeHtml(row.status)}</td>
                        <td>${formatMoney(row.amount)}</td>
                        <td>${formatMoney(row.cpm)}</td>
                        <td>${formatNumber(row.views24)}</td>
                        <td>${formatNumber(row.views48)}</td>
                        <td>${formatNumber(row.views72)}</td>
                        <td class="positive">${formatNumber(row.subscribers)}</td>
                        <td>${formatMoney(row.costPerSubscriber)}</td>
                      </tr>
                    `).join('')
                    : '<tr><td colspan="9">Закупов пока нет или данные ещё не собраны.</td></tr>'
                }
              </tbody>
            </table>
          </div>
        </section>
      </section>
    `;
  }

  function notificationHistoryHtml() {
    const history = state.data?.notificationHistory || {};
    const rows = history.rows || [];

    return `
      <section class="lr-ops-root" data-lr-ops-root="notifications">
        <div class="section-head lr-ops-heading">
          <div>
            <span class="eyebrow">История</span>
            <h2>Уведомления кабинета</h2>
            <p>Непрочитано: ${formatNumber(history.unread)}</p>
          </div>
          <div class="lr-ops-inline-actions">
            <button class="secondary" type="button" data-lr-action="read-notifications">
              Прочитать всё
            </button>
            <button class="secondary" type="button" data-lr-action="clear-notifications">
              Очистить прочитанные
            </button>
          </div>
        </div>

        <section class="lr-ops-panel">
          <div class="lr-ops-notice-list">
            ${
              rows.length
                ? rows.slice(0, 30).map((row) => `
                  <article class="lr-ops-notice is-${escapeHtml(row.level)} ${row.read ? 'is-read' : 'is-unread'}">
                    <span></span>
                    <div>
                      <strong>${escapeHtml(row.title)}</strong>
                      <p>${escapeHtml(row.text)}</p>
                      <small>${escapeHtml(formatDate(row.lastSeenAt || row.createdAt))}</small>
                    </div>
                  </article>
                `).join('')
                : '<div class="lr-ops-empty">История уведомлений пуста.</div>'
            }
          </div>
        </section>
      </section>
    `;
  }

  function reportsHtml() {
    const rows = state.data?.reports || [];

    return `
      <section class="lr-ops-root" data-lr-ops-root="reports">
        <div class="section-head lr-ops-heading">
          <div>
            <span class="eyebrow">Аналитика</span>
            <h2>Архив отчётов</h2>
            <p>Ежедневные снимки показателей каналов</p>
          </div>
        </div>

        <section class="lr-ops-panel">
          <div class="lr-ops-report-list">
            ${
              rows.length
                ? rows.slice(0, 30).map((row) => `
                  <article class="lr-ops-report-row">
                    <div>
                      <strong>${escapeHtml(row.channelTitle)}</strong>
                      <p>
                        ${escapeHtml(row.periodLabel)} ·
                        ${escapeHtml(formatDate(row.generatedAt))}
                      </p>
                      <small>
                        Подписчики ${formatNumber(row.metrics?.subscribers)} ·
                        Просмотры ${formatNumber(row.metrics?.views24)} ·
                        Изменение ${formatSigned(row.metrics?.deltaDay)}
                      </small>
                    </div>
                    ${
                      row.downloadUrl
                        ? `
                          <button type="button"
                                  class="secondary"
                                  data-lr-action="download-report"
                                  data-url="${escapeHtml(row.downloadUrl)}"
                                  data-channel-id="${escapeHtml(row.channelId)}">
                            Скачать
                          </button>
                        `
                        : '<span class="lr-ops-archive-badge">Архив</span>'
                    }
                  </article>
                `).join('')
                : '<div class="lr-ops-empty">Архив появится после сбора аналитики.</div>'
            }
          </div>
        </section>
      </section>
    `;
  }

  function securityHtml() {
    const security = state.data?.security || {};
    const sessions = security.sessions || {};
    const rows = sessions.rows || [];
    const subscription = security.subscription || {};

    return `
      <section class="lr-ops-root" data-lr-ops-root="security">
        <div class="section-head lr-ops-heading">
          <div>
            <span class="eyebrow">Безопасность</span>
            <h2>Профиль и активные сессии</h2>
            <p>Активных входов: ${formatNumber(sessions.active)}</p>
          </div>
          <button class="secondary" type="button" data-lr-action="revoke-others">
            Выйти на других устройствах
          </button>
        </div>

        <section class="lr-ops-panel">
          <div class="lr-ops-security-summary">
            <div>
              <span>Тариф</span>
              <strong>${escapeHtml(subscription.name || 'Бесплатный')}</strong>
            </div>
            <div>
              <span>Действует до</span>
              <strong>${escapeHtml(formatDate(subscription.endsAt))}</strong>
            </div>
          </div>

          <div class="lr-ops-session-list">
            ${
              rows.length
                ? rows.map((row) => `
                  <article class="lr-ops-session ${row.current ? 'is-current' : ''}">
                    <div>
                      <strong>
                        ${escapeHtml(shortDevice(row.userAgent))}
                        ${row.current ? '<em>Текущая</em>' : ''}
                      </strong>
                      <p>
                        IP: ${escapeHtml(row.ip)} ·
                        активность ${escapeHtml(formatDate(row.lastSeenAt))}
                      </p>
                      <small>Вход: ${escapeHtml(formatDate(row.createdAt))}</small>
                    </div>
                    ${
                      row.canRevoke
                        ? `
                          <button type="button"
                                  class="secondary"
                                  data-lr-action="revoke-session"
                                  data-session-id="${escapeHtml(row.id)}">
                            Завершить
                          </button>
                        `
                        : ''
                    }
                  </article>
                `).join('')
                : '<div class="lr-ops-empty">Список активных сессий недоступен.</div>'
            }
          </div>
        </section>
      </section>
    `;
  }

  function statusHtml() {
    if (state.loading) {
      return `
        <section class="lr-ops-root lr-ops-panel lr-ops-status" data-lr-ops-root="status">
          <span class="lr-ops-spinner"></span>
          <p>Загружаем расширенные данные кабинета…</p>
        </section>
      `;
    }

    if (state.error) {
      return `
        <section class="lr-ops-root lr-ops-panel lr-ops-status" data-lr-ops-root="status">
          <p>${escapeHtml(state.error)}</p>
          <button type="button" class="secondary" data-lr-action="refresh">
            Повторить
          </button>
        </section>
      `;
    }

    return '';
  }

  function renderExtras() {
    observer.disconnect();

    root.querySelectorAll('[data-lr-ops-root]').forEach((element) => {
      element.remove();
    });

    const view = root.querySelector('.tab-view');

    if (!view) {
      observer.observe(root, { childList: true, subtree: true });
      return;
    }

    if (state.loading || state.error) {
      view.insertAdjacentHTML('beforeend', statusHtml());
      observer.observe(root, { childList: true, subtree: true });
      return;
    }

    if (view.getAttribute('data-view') === 'channels') {
      const channelList = view.querySelector('.channel-list');

      if (channelList) {
        channelList.insertAdjacentHTML('beforebegin', healthHtml());
      } else {
        view.insertAdjacentHTML('beforeend', healthHtml());
      }
    } else {
      view.insertAdjacentHTML(
        'beforeend',
        purchasesHtml()
          + notificationHistoryHtml()
          + reportsHtml()
          + securityHtml(),
      );
    }

    observer.observe(root, { childList: true, subtree: true });
  }

  function scheduleRender() {
    window.clearTimeout(state.renderTimer);
    state.renderTimer = window.setTimeout(renderExtras, 30);
  }

  async function downloadReport(button) {
    const url = button.getAttribute('data-url');
    const channelId = button.getAttribute('data-channel-id') || 'channel';

    if (!url) return;

    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Создаём…';

    try {
      const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'image/png, application/json',
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        const type = response.headers.get('content-type') || '';
        const body = type.includes('application/json')
          ? await response.json()
          : { error: (await response.text()).slice(0, 300) };

        throw new Error(body?.error || `Ошибка ${response.status}`);
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `linkray-report-${channelId}.png`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
    } catch (error) {
      window.alert(error?.message || 'Не удалось скачать отчёт.');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-lr-action]');
    if (!button) return;

    const action = button.getAttribute('data-lr-action');

    try {
      if (action === 'refresh') {
        await load();
        return;
      }

      if (action === 'read-notifications') {
        await postJson('/api/website/cabinet/notifications/read');
        await load();
        return;
      }

      if (action === 'clear-notifications') {
        await postJson('/api/website/cabinet/notifications/clear');
        await load();
        return;
      }

      if (action === 'revoke-session') {
        if (!window.confirm('Завершить выбранную сессию?')) return;

        const id = button.getAttribute('data-session-id');
        await postJson(
          `/api/website/cabinet/sessions/${encodeURIComponent(id)}/revoke`,
        );
        await load();
        return;
      }

      if (action === 'revoke-others') {
        if (!window.confirm('Завершить вход на всех других устройствах?')) {
          return;
        }

        await postJson('/api/website/cabinet/sessions/revoke-others');
        await load();
        return;
      }

      if (action === 'download-report') {
        await downloadReport(button);
      }
    } catch (error) {
      window.alert(error?.message || 'Операция не выполнена.');
    }
  });

  const observer = new MutationObserver(scheduleRender);
  observer.observe(root, { childList: true, subtree: true });

  load();
})();
