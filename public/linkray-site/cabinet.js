(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const loading = $('[data-loading]');
  const cabinet = $('[data-cabinet]');
  const toast = $('[data-toast]');

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('ru-RU').format(number);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api/website${path}`, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `Ошибка ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    window.setTimeout(() => {
      toast.hidden = true;
    }, 4200);
  }

  function initials(title) {
    const parts = String(title || 'LR').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'LR';
  }

  function channelHtml(channel) {
    const avatar = channel.avatarUrl
      ? `<img src="${escapeHtml(channel.avatarUrl)}" alt="">`
      : escapeHtml(initials(channel.title));

    const subscribers = Number.isFinite(Number(channel.subscribers))
      ? formatNumber(channel.subscribers)
      : 'Данные собираются';

    const role =
      channel.role === 'owner'
        ? 'Владелец'
        : channel.role === 'admin'
          ? 'Администратор'
          : 'Участник';

    return `
      <article class="channel-row">
        <div class="channel-avatar">${avatar}</div>
        <div>
          <b>${escapeHtml(channel.title)}</b>
          <small>MAX ID: ${escapeHtml(channel.maxChatId || '—')}</small>
        </div>
        <div class="channel-meta">
          <strong>${escapeHtml(subscribers)}</strong>
          <span>${escapeHtml(role)}</span>
        </div>
      </article>
    `;
  }

  function renderChannels(target, channels) {
    if (!channels.length) {
      target.innerHTML = `
        <div class="empty-state">
          <b>Каналы пока не подключены</b>
          Добавьте бота администратором канала и перешлите ему любой пост.
        </div>
      `;
      return;
    }

    target.innerHTML = channels.map(channelHtml).join('');
  }

  function render(data) {
    const user = data.user || {};
    const channels = Array.isArray(data.channels) ? data.channels : [];
    const summary = data.summary || {};

    $('[data-user-name]').textContent = user.displayName || 'Пользователь LinkRay';
    $('[data-user-id]').textContent = user.linkrayId || '000000';
    $('[data-user-letter]').textContent =
      String(user.displayName || 'Л').trim().charAt(0).toUpperCase() || 'Л';

    $('[data-summary-channels]').textContent = formatNumber(summary.channels || 0);
    $('[data-summary-active]').textContent = formatNumber(summary.activeChannels || 0);
    $('[data-summary-subscribers]').textContent =
      Number(summary.subscribers) > 0 ? formatNumber(summary.subscribers) : '—';

    renderChannels($('[data-overview-channels]'), channels.slice(0, 4));
    renderChannels($('[data-all-channels]'), channels);

    loading.hidden = true;
    cabinet.hidden = false;
  }

  function bindTabs() {
    $$('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.tab;
        $$('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
        $$('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab));
        $('[data-page-title]').textContent = tab === 'channels' ? 'Каналы' : 'Обзор';
      });
    });
  }

  async function init() {
    bindTabs();

    $('[data-logout]').addEventListener('click', async () => {
      try {
        await api('/auth/logout', {
          method: 'POST',
          body: '{}',
        });
      } finally {
        window.location.assign('/');
      }
    });

    try {
      const data = await api('/cabinet/overview', { method: 'GET', headers: {} });
      render(data);
    } catch (error) {
      if (error.status === 401) {
        window.location.replace('/');
        return;
      }

      loading.querySelector('strong').textContent = 'Не удалось загрузить кабинет';
      showToast(error.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
