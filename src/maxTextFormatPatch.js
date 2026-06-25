// LR_MAX_TEXT_FORMAT_EARLY_START

function lrDetectMaxFormat(text) {
  const value = String(text || '');

  if (!value.trim()) return null;

  // HTML-режим MAX.
  if (/<\/?(b|strong|i|em|u|ins|s|strike|del|a|blockquote|h[1-6]|code|pre|mark)\b/i.test(value)) {
    return 'html';
  }

  // Markdown-режим MAX:
  // **жирный**, _курсив_, ~~зачеркнутый~~, ++подчеркнутый++,
  // ^^выделенный^^, `код`, [ссылка](url), # заголовок, > цитата.
  if (
    /(^|\n)\s{0,3}#{1,6}\s+\S/.test(value) ||
    /(^|\n)\s{0,3}>\s+\S/.test(value) ||
    /(^|\n)\s{0,3}([-*+]\s+|\d+\.\s+)\S/.test(value) ||
    /```[\s\S]*?```/.test(value) ||
    /`[^`\n]+`/.test(value) ||
    /\*\*[\s\S]+?\*\*/.test(value) ||
    /__[\s\S]+?__/.test(value) ||
    /(^|[^*])\*[^*\n]+?\*([^*]|$)/.test(value) ||
    /(^|[^_])_[^_\n]+?_([^_]|$)/.test(value) ||
    /~~[\s\S]+?~~/.test(value) ||
    /\+\+[\s\S]+?\+\+/.test(value) ||
    /\^\^[\s\S]+?\^\^/.test(value) ||
    /\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)/i.test(value) ||
    /\[[^\]\n]+\]\(max:\/\/user\/\d+\)/i.test(value)
  ) {
    return 'markdown';
  }

  return null;
}

function lrDecorateMessageBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;

  let changed = false;
  const next = { ...body };

  if (typeof next.text === 'string' && next.text.trim() && !next.format) {
    const format = lrDetectMaxFormat(next.text);

    if (format) {
      next.format = format;
      changed = true;
    }
  }

  if (next.message && typeof next.message === 'object' && !Array.isArray(next.message)) {
    const decorated = lrDecorateMessageBody(next.message);

    if (decorated !== next.message) {
      next.message = decorated;
      changed = true;
    }
  }

  return changed ? next : body;
}

function lrPatchFetchForMaxFormatting() {
  if (globalThis.__lrMaxFormatEarlyPatched) return;
  if (typeof globalThis.fetch !== 'function') return;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function lrFormattedFetch(input, init = {}) {
    try {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const method = String(init?.method || 'GET').toUpperCase();

      if (
        /\/messages(\?|$)/.test(url) &&
        ['POST', 'PUT', 'PATCH'].includes(method) &&
        typeof init?.body === 'string' &&
        init.body.trim().startsWith('{')
      ) {
        const parsed = JSON.parse(init.body);
        const decorated = lrDecorateMessageBody(parsed);

        if (decorated !== parsed) {
          init = {
            ...init,
            body: JSON.stringify(decorated)
          };

          console.log('[max-format-early]', JSON.stringify({
            format: decorated.format || decorated.message?.format || null,
            text_preview: String(decorated.text || decorated.message?.text || '').slice(0, 80)
          }));
        }
      }
    } catch (error) {
      console.log('[max-format-early] skipped:', error.message || error);
    }

    return originalFetch(input, init);
  };

  globalThis.__lrMaxFormatEarlyPatched = true;
}

lrPatchFetchForMaxFormatting();

// LR_MAX_TEXT_FORMAT_EARLY_END
