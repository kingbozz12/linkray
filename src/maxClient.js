const MAX_API_URL = process.env.MAX_API_URL || 'https://platform-api.max.ru';

function getToken() {
  return (process.env.BOT_TOKEN || '').trim();
}

function authHeaders(json = false) {
  const token = getToken();

  if (!token) {
    throw new Error('BOT_TOKEN is empty inside container');
  }

  const headers = { Authorization: token };

  if (json) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

export function inlineKeyboard(buttonRows) {
  return [
    {
      type: 'inline_keyboard',
      payload: {
        buttons: buttonRows,
      },
    },
  ];
}

export function callbackButton(text, payload) {
  return {
    type: 'callback',
    text,
    payload,
  };
}

export function msgButton(text) {
  return {
    type: 'message',
    text,
  };
}

export function linkButton(text, url) {
  return {
    type: 'link',
    text,
    url,
  };
}

export async function answerCallback({
  callbackId,
  text,
  format = 'markdown',
  attachments = [],
  notification = null,
}) {
  const url = new URL(`${MAX_API_URL}/answers`);
  url.searchParams.set('callback_id', String(callbackId));

  const body = {};

  if (text !== undefined && text !== null) {
    body.message = {
      text,
      format,
      attachments,
    };
  }

  if (notification) {
    body.notification = notification;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`MAX callback answer error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

export async function getMaxChatInfo(chatId) {
  const response = await fetch(`${MAX_API_URL}/chats/${encodeURIComponent(String(chatId))}`, {
    method: 'GET',
    headers: authHeaders(),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`MAX get chat error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

export async function getMaxMessage(messageId) {
  const response = await fetch(`${MAX_API_URL}/messages/${encodeURIComponent(String(messageId))}`, {
    method: 'GET',
    headers: authHeaders(),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`MAX get message error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

export async function sendMaxMessage({ chatId, userId, text, format = 'markdown', attachments = [], notify = true }) {
  const token = getBotToken();

  const url = new URL(`${MAX_API_URL}/messages`);

  if (chatId) {
    url.searchParams.set('chat_id', String(chatId));
  } else if (userId) {
    url.searchParams.set('user_id', String(userId));
  } else {
    throw new Error('chatId or userId is required');
  }

  const baseBody = {
    text: text || '',
    format,
  };

  if (Array.isArray(attachments) && attachments.length) {
    baseBody.attachments = attachments;
  }

  // В некоторых версиях MAX API поле notify/channel_notify для каналов даёт:
  // 400 proto.payload / Errors.SendMessage.channel_notify.
  // Поэтому сначала пробуем с уведомлением, потом автоматически повторяем без него.
  const bodyWithNotify = { ...baseBody, notify: Boolean(notify) };

  async function postMessage(body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);

    return { response, data };
  }

  let { response, data } = await postMessage(bodyWithNotify);

  if (!response.ok) {
    const errorText = JSON.stringify(data || {});
    const shouldRetryWithoutNotify =
      response.status === 400 &&
      (
        errorText.includes('channel_notify') ||
        errorText.includes('proto.payload') ||
        errorText.includes('notify')
      );

    if (shouldRetryWithoutNotify) {
      console.warn('[maxClient] retry send without notify:', errorText);

      ({ response, data } = await postMessage(baseBody));
    }
  }

  if (!response.ok) {
    throw new Error(`MAX API error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}) {
  const url = new URL(`${MAX_API_URL}/messages`);

  if (chatId) {
    url.searchParams.set('chat_id', String(chatId));
  } else if (userId) {
    url.searchParams.set('user_id', String(userId));
  } else {
    throw new Error('chatId or userId is required');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      text,
      format,
      attachments,
      notify,
      ...(link ? { link } : {}),
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`MAX API error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}
