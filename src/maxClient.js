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

export async function sendMaxMessage({
  chatId,
  userId,
  text,
  format = 'markdown',
  attachments = [],
  notify = true,
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

    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`MAX API error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

export async function getMaxMessage(messageId, params = {}) {
  const token =
    process.env.BOT_TOKEN ||
    process.env.MAX_BOT_TOKEN ||
    process.env.MAX_TOKEN ||
    '';

  if (!token) {
    throw new Error('BOT_TOKEN is not configured');
  }

  const apiUrl =
    process.env.MAX_API_URL ||
    process.env.MAX_BASE_URL ||
    'https://platform-api.max.ru';

  const id =
    typeof messageId === 'object'
      ? (messageId.messageId || messageId.message_id || messageId.id || messageId.mid)
      : messageId;

  if (!id) {
    throw new Error('messageId is required');
  }

  const chatId =
    params.chatId ||
    params.chat_id ||
    (typeof messageId === 'object' ? (messageId.chatId || messageId.chat_id) : null);

  const urls = [];

  const directUrl = new URL(`${apiUrl}/messages/${encodeURIComponent(String(id))}`);
  if (chatId) directUrl.searchParams.set('chat_id', String(chatId));
  urls.push(directUrl);

  const queryUrl = new URL(`${apiUrl}/messages`);
  queryUrl.searchParams.set('message_id', String(id));
  if (chatId) queryUrl.searchParams.set('chat_id', String(chatId));
  urls.push(queryUrl);

  let lastError = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json().catch(() => null);

      if (response.ok) {
        return data;
      }

      lastError = new Error(`MAX API error ${response.status}: ${JSON.stringify(data)}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('MAX API error while reading message');
}

