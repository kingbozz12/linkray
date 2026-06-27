import './maxTextFormatPatch.js';
import * as lrCrypto from 'node:crypto';
import { mountLinkRayAnalyticsRoutes } from './linkrayAnalyticsRoutes.js';
import dotenv from 'dotenv';
dotenv.config();

import express from 'express'; import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { query } from './db.js';
import { startAutopostWorker } from './autopostWorker.js';

// LR_EDITOR_POST_FORMAT_START
function lrDetectEditorPostFormat(text) {
  const value = String(text || '');

  if (!value.trim()) return 'html';

  if (/<\/?(b|strong|i|em|u|ins|s|strike|del|a|blockquote|h[1-6]|code|pre|mark)\b/i.test(value)) {
    return 'html';
  }

  if (
    /(^|\n)\s{0,3}#{1,6}\s+\S/.test(value) ||
    /(^|\n)\s{0,3}>\s+\S/.test(value) ||
    /(^|\n)\s{0,3}([-*+]\s+|\d+\.\s+)\S/.test(value) ||
    /```[\s\S]*?```/.test(value) ||
    /`[^`\n]+`/.test(value) ||
    /\*\*[\s\S]+?\*\*/.test(value) ||
    /__[\s\S]+?__/.test(value) ||
    /~~[\s\S]+?~~/.test(value) ||
    /\+\+[\s\S]+?\+\+/.test(value) ||
    /\^\^[\s\S]+?\^\^/.test(value) ||
    /\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)/i.test(value) ||
    /\[[^\]\n]+\]\(max:\/\/user\/\d+\)/i.test(value)
  ) {
    return 'markdown';
  }

  return 'html';
}

function lrApplyEditorPostFormat(draft, content = {}) {
  if (!draft.content) draft.content = {};

  const text = String(draft.content.text || content.text || '');

  draft.content.format = content.format || lrDetectEditorPostFormat(text) || draft.content.format || 'html';

  return draft;
}
// LR_EDITOR_POST_FORMAT_END


import {
  sendMaxMessage,
  answerCallback,
  inlineKeyboard,
  callbackButton,
  linkButton,
  getMaxChatInfo,
  getMaxMessage,
  editMaxMessage,
  deleteMaxMessage,
} from './maxClient.js';
















// LR_AUTOSIG_FINAL_START
function lrAutoSigFinalDecode(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function lrAutoSigFinalEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrAutoSigFinalAttr(value) {
  return lrAutoSigFinalEsc(value).replace(/"/g, '&quot;');
}

function lrAutoSigFinalPlain(value) {
  return lrAutoSigFinalDecode(value)
    .replace(/<[^>]*>/g, '')
    .replace(/\*\*/g, '')
    .replace(/\+\+/g, '')
    .trim();
}

function lrAutoSigFinalType(mark) {
  return String(
    mark?.type ||
    mark?.kind ||
    mark?.style ||
    mark?.format ||
    mark?.markup_type ||
    mark?.markupType ||
    mark?.entity_type ||
    mark?.entityType ||
    ''
  ).toLowerCase();
}

function lrAutoSigFinalUrl(mark) {
  return String(
    mark?.url ||
    mark?.href ||
    mark?.link ||
    mark?.target_url ||
    mark?.targetUrl ||
    mark?.payload?.url ||
    mark?.payload?.href ||
    mark?.payload?.link ||
    ''
  ).trim();
}

function lrAutoSigFinalRange(mark, length) {
  let start = Number(mark?.from ?? mark?.start ?? mark?.offset ?? mark?.pos ?? mark?.range?.from ?? mark?.range?.start ?? 0);
  let end = Number(mark?.to ?? mark?.end ?? mark?.range?.to ?? mark?.range?.end ?? NaN);
  const len = Number(mark?.length ?? mark?.len ?? mark?.range?.length ?? mark?.range?.len ?? NaN);

  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = Number.isFinite(len) ? start + len : start;

  start = Math.max(0, Math.min(length, start));
  end = Math.max(0, Math.min(length, end));

  if (end <= start) return null;
  return { start, end };
}

function lrAutoSigFinalTag(mark) {
  const type = lrAutoSigFinalType(mark);
  const url = lrAutoSigFinalUrl(mark);

  if ((type.includes('link') || type.includes('url')) && /^https?:\/\//i.test(url)) {
    return { open: `<a href="${lrAutoSigFinalAttr(url)}">`, close: '</a>', priority: 20 };
  }

  if (type.includes('strong') || type.includes('bold')) return { open: '<b>', close: '</b>', priority: 10 };
  if (type.includes('italic') || type.includes('emphasis') || type.includes('emphasized') || type === 'em') return { open: '<i>', close: '</i>', priority: 30 };
  if (type.includes('underline') || type.includes('underlined') || type.includes('ins')) return { open: '<u>', close: '</u>', priority: 40 };
  if (type.includes('strike') || type.includes('through') || type.includes('deleted') || type === 's' || type === 'del') return { open: '<s>', close: '</s>', priority: 50 };
  if (type.includes('mono') || type.includes('code')) return { open: '<code>', close: '</code>', priority: 60 };

  return null;
}

function lrAutoSigFinalMarkupToHtml(text, markup = []) {
  const source = String(text ?? '');
  const marks = Array.isArray(markup) ? markup : [];

  if (!source) return '';

  const opens = new Map();
  const closes = new Map();

  const add = (map, pos, item) => {
    if (!map.has(pos)) map.set(pos, []);
    map.get(pos).push(item);
  };

  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;

    const range = lrAutoSigFinalRange(mark, source.length);
    const tag = lrAutoSigFinalTag(mark);

    if (!range || !tag) continue;

    const item = { ...tag, start: range.start, end: range.end };
    add(opens, range.start, item);
    add(closes, range.end, item);
  }

  if (!opens.size && !closes.size) return lrAutoSigFinalMarkdownToHtml(source);

  for (const arr of opens.values()) arr.sort((a, b) => a.priority - b.priority);
  for (const arr of closes.values()) arr.sort((a, b) => b.priority - a.priority);

  let out = '';

  for (let i = 0; i <= source.length; i++) {
    for (const item of closes.get(i) || []) out += item.close;
    for (const item of opens.get(i) || []) out += item.open;
    if (i < source.length) out += lrAutoSigFinalEsc(source[i]);
  }

  return out.replace(/\*\*/g, '').replace(/\+\+/g, '').trim();
}

function lrAutoSigFinalMarkdownToHtml(value) {
  let text = lrAutoSigFinalDecode(value).trim();
  if (!text) return '';

  const keep = [];
  const save = (html) => {
    const key = `__LR_AUTOSIG_KEEP_${keep.length}__`;
    keep.push(html);
    return key;
  };

  text = text.replace(/\*\*\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)\*\*/g, (_, label, url) => {
    return save(`<b><a href="${lrAutoSigFinalAttr(url)}">${lrAutoSigFinalEsc(label)}</a></b>`);
  });

  text = text.replace(/\[\*\*([^\]]+?)\*\*\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
    return save(`<b><a href="${lrAutoSigFinalAttr(url)}">${lrAutoSigFinalEsc(label)}</a></b>`);
  });

  text = text.replace(/\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
    return save(`<a href="${lrAutoSigFinalAttr(url)}">${lrAutoSigFinalEsc(label)}</a>`);
  });

  text = lrAutoSigFinalEsc(text)
    .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
    .replace(/\+\+([\s\S]+?)\+\+/g, '<u>$1</u>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');

  keep.forEach((html, i) => {
    text = text.replaceAll(`__LR_AUTOSIG_KEEP_${i}__`, html);
  });

  return text.replace(/\*\*/g, '').replace(/\+\+/g, '').trim();
}

function lrAutoSigFinalHtmlToSafe(value) {
  let text = lrAutoSigFinalDecode(value).trim();
  if (!text) return '';

  const keep = [];
  const save = (html) => {
    const key = `__LR_AUTOSIG_HTML_${keep.length}__`;
    keep.push(html);
    return key;
  };

  text = text.replace(/<a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*><b>([\s\S]*?)<\/b><\/a>/gi, (_, q, url, label) => {
    return save(`<b><a href="${lrAutoSigFinalAttr(url)}">${lrAutoSigFinalEsc(lrAutoSigFinalPlain(label))}</a></b>`);
  });

  text = text.replace(/<b><a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a><\/b>/gi, (_, q, url, label) => {
    return save(`<b><a href="${lrAutoSigFinalAttr(url)}">${lrAutoSigFinalEsc(lrAutoSigFinalPlain(label))}</a></b>`);
  });

  text = text.replace(/<a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, q, url, label) => {
    return save(`<a href="${lrAutoSigFinalAttr(url)}">${lrAutoSigFinalEsc(lrAutoSigFinalPlain(label))}</a>`);
  });

  text = text
    .replace(/<\s*(b|strong)\s*>/gi, () => save('<b>'))
    .replace(/<\s*\/\s*(b|strong)\s*>/gi, () => save('</b>'))
    .replace(/<\s*(i|em)\s*>/gi, () => save('<i>'))
    .replace(/<\s*\/\s*(i|em)\s*>/gi, () => save('</i>'))
    .replace(/<\s*(u|ins)\s*>/gi, () => save('<u>'))
    .replace(/<\s*\/\s*(u|ins)\s*>/gi, () => save('</u>'))
    .replace(/<\s*(s|strike|del)\s*>/gi, () => save('<s>'))
    .replace(/<\s*\/\s*(s|strike|del)\s*>/gi, () => save('</s>'))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');

  text = lrAutoSigFinalEsc(text);

  keep.forEach((html, i) => {
    text = text.replaceAll(`__LR_AUTOSIG_HTML_${i}__`, html);
  });

  return text.replace(/\*\*/g, '').replace(/\+\+/g, '').trim();
}

function lrAutoSigFinalFindText(root) {
  const found = [];
  const seen = new WeakSet();

  const walk = (value, path = '', inheritedMarkup = []) => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    const localMarkup =
      (Array.isArray(value.markup) && value.markup) ||
      (Array.isArray(value.body?.markup) && value.body.markup) ||
      (Array.isArray(value.message?.body?.markup) && value.message.body.markup) ||
      (Array.isArray(value.content?.markup) && value.content.markup) ||
      inheritedMarkup ||
      [];

    const add = (textValue, markup, bonus = 0) => {
      const text = String(textValue ?? '').trim();
      if (!text) return;

      const low = path.toLowerCase();
      let score = text.length + bonus;

      if (low.includes('message')) score += 300;
      if (low.includes('body')) score += 300;
      if (low.includes('content')) score += 150;

      if (low.includes('preview')) score -= 500;
      if (low.includes('attachment')) score -= 500;
      if (low.includes('button')) score -= 500;
      if (low.includes('chat')) score -= 250;
      if (low.includes('sender')) score -= 250;
      if (low.includes('user')) score -= 250;

      found.push({
        text,
        markup: Array.isArray(markup) ? markup : [],
        format: String(value.format || value.body?.format || value.content?.format || '').toLowerCase(),
        score
      });
    };

    if (typeof value.message?.body?.text === 'string') add(value.message.body.text, value.message.body.markup || localMarkup, 800);
    if (typeof value.body?.text === 'string') add(value.body.text, value.body.markup || localMarkup, 750);
    if (typeof value.text === 'string') add(value.text, localMarkup, 650);
    if (typeof value.caption === 'string') add(value.caption, localMarkup, 550);
    if (typeof value.content?.text === 'string') add(value.content.text, value.content.markup || localMarkup, 450);
    if (typeof value.payload?.text === 'string') add(value.payload.text, value.payload.markup || localMarkup, 250);

    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object') walk(child, `${path}.${key}`, localMarkup);
    }
  };

  walk(root, 'root', []);

  found.sort((a, b) => b.score - a.score);
  return found[0] || { text: '', markup: [], format: '' };
}

function lrAutoSigFinalContent(updateOrContent) {
  const found = lrAutoSigFinalFindText(updateOrContent);
  const text = String(found.text || '').trim();
  const markup = Array.isArray(found.markup) ? found.markup : [];
  const format = String(found.format || '').toLowerCase();

  let html = '';

  if (markup.length) {
    html = lrAutoSigFinalMarkupToHtml(text, markup);
  } else if (format === 'html' || /(<|&lt;)\/?(a|b|strong|i|em|u|ins|s|strike|del|code)\b/i.test(text)) {
    html = lrAutoSigFinalHtmlToSafe(text);
  } else {
    html = lrAutoSigFinalMarkdownToHtml(text);
  }

  return {
    text: html,
    format: 'html',
    markup: [],
    attachments: []
  };
}

function lrAutoSigFinalPreview(sig) {
  if (!sig) return 'Подпись не создана.';
  const text = String(sig.text || '').trim();
  if (!text) return 'Подпись не создана.';
  return lrAutoSigFinalContent({ text, format: sig.format || 'html', markup: sig.markup || [] }).text || 'Подпись не создана.';
}
// LR_AUTOSIG_FINAL_END


// LR_SIG_INPUT_V14_START
function lrSigV14Decode(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function lrSigV14Esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrSigV14Attr(value) {
  return lrSigV14Esc(value).replace(/"/g, '&quot;');
}

function lrSigV14Type(mark) {
  return String(
    mark?.type ||
    mark?.kind ||
    mark?.style ||
    mark?.format ||
    mark?.markup_type ||
    mark?.markupType ||
    mark?.entity_type ||
    mark?.entityType ||
    ''
  ).toLowerCase();
}

function lrSigV14Url(mark) {
  return String(
    mark?.url ||
    mark?.href ||
    mark?.link ||
    mark?.target_url ||
    mark?.targetUrl ||
    mark?.payload?.url ||
    mark?.payload?.href ||
    mark?.payload?.link ||
    ''
  ).trim();
}

function lrSigV14Range(mark, textLength) {
  let start = Number(mark?.from ?? mark?.start ?? mark?.offset ?? mark?.pos ?? mark?.range?.from ?? mark?.range?.start ?? 0);
  let end = Number(mark?.to ?? mark?.end ?? mark?.range?.to ?? mark?.range?.end ?? NaN);
  const len = Number(mark?.length ?? mark?.len ?? mark?.range?.length ?? mark?.range?.len ?? NaN);

  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = Number.isFinite(len) ? start + len : start;

  start = Math.max(0, Math.min(textLength, start));
  end = Math.max(0, Math.min(textLength, end));

  if (end <= start) return null;
  return { start, end };
}

function lrSigV14Tag(mark) {
  const type = lrSigV14Type(mark);
  const url = lrSigV14Url(mark);

  if ((type.includes('link') || type.includes('url')) && /^https?:\/\//i.test(url)) {
    return { open: `<a href="${lrSigV14Attr(url)}">`, close: '</a>', priority: 20 };
  }

  if (type.includes('strong') || type.includes('bold')) return { open: '<b>', close: '</b>', priority: 10 };
  if (type.includes('italic') || type.includes('emphasis') || type.includes('emphasized') || type === 'em') return { open: '<i>', close: '</i>', priority: 30 };
  if (type.includes('underline') || type.includes('underlined') || type.includes('ins')) return { open: '<u>', close: '</u>', priority: 40 };
  if (type.includes('strike') || type.includes('through') || type.includes('deleted') || type === 's' || type === 'del') return { open: '<s>', close: '</s>', priority: 50 };
  if (type.includes('mono') || type.includes('code')) return { open: '<code>', close: '</code>', priority: 60 };

  return null;
}

function lrSigV14MarkupToHtml(text, markup = []) {
  const source = String(text ?? '');
  const marks = Array.isArray(markup) ? markup : [];

  if (!source) return '';

  const opens = new Map();
  const closes = new Map();

  const add = (map, pos, item) => {
    if (!map.has(pos)) map.set(pos, []);
    map.get(pos).push(item);
  };

  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;

    const range = lrSigV14Range(mark, source.length);
    const tag = lrSigV14Tag(mark);

    if (!range || !tag) continue;

    const item = { ...tag, start: range.start, end: range.end };
    add(opens, range.start, item);
    add(closes, range.end, item);
  }

  if (!opens.size && !closes.size) return lrSigV14MarkdownToHtml(source);

  for (const arr of opens.values()) arr.sort((a, b) => a.priority - b.priority);
  for (const arr of closes.values()) arr.sort((a, b) => b.priority - a.priority);

  let out = '';

  for (let i = 0; i <= source.length; i++) {
    for (const item of closes.get(i) || []) out += item.close;
    for (const item of opens.get(i) || []) out += item.open;
    if (i < source.length) out += lrSigV14Esc(source[i]);
  }

  return out.replace(/\*\*/g, '').replace(/\+\+/g, '').trim();
}

function lrSigV14HtmlToSafe(value) {
  let text = lrSigV14Decode(value).trim();
  if (!text) return '';

  const keep = [];
  const save = (html) => {
    const key = `__LR_SIG14_KEEP_${keep.length}__`;
    keep.push(html);
    return key;
  };

  text = text.replace(/<a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*><b>([\s\S]*?)<\/b><\/a>/gi, (_, q, url, label) => {
    return save(`<b><a href="${lrSigV14Attr(url)}">${lrSigV14Esc(lrSigV14Decode(label).replace(/<\/?[^>]+>/g, ''))}</a></b>`);
  });

  text = text.replace(/<b><a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a><\/b>/gi, (_, q, url, label) => {
    return save(`<b><a href="${lrSigV14Attr(url)}">${lrSigV14Esc(lrSigV14Decode(label).replace(/<\/?[^>]+>/g, ''))}</a></b>`);
  });

  text = text.replace(/<a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, q, url, label) => {
    const cleanLabel = lrSigV14Decode(label).replace(/<\/?[^>]+>/g, '').trim();
    return save(`<a href="${lrSigV14Attr(url)}">${lrSigV14Esc(cleanLabel)}</a>`);
  });

  text = text
    .replace(/<\s*(b|strong)\s*>/gi, () => save('<b>'))
    .replace(/<\s*\/\s*(b|strong)\s*>/gi, () => save('</b>'))
    .replace(/<\s*(i|em)\s*>/gi, () => save('<i>'))
    .replace(/<\s*\/\s*(i|em)\s*>/gi, () => save('</i>'))
    .replace(/<\s*(u|ins)\s*>/gi, () => save('<u>'))
    .replace(/<\s*\/\s*(u|ins)\s*>/gi, () => save('</u>'))
    .replace(/<\s*(s|strike|del)\s*>/gi, () => save('<s>'))
    .replace(/<\s*\/\s*(s|strike|del)\s*>/gi, () => save('</s>'))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');

  text = lrSigV14Esc(text);

  keep.forEach((html, i) => {
    text = text.replaceAll(`__LR_SIG14_KEEP_${i}__`, html);
  });

  return text.replace(/\*\*/g, '').replace(/\+\+/g, '').trim();
}

function lrSigV14MarkdownToHtml(value) {
  let text = lrSigV14Decode(value).trim();
  if (!text) return '';

  const keep = [];
  const save = (html) => {
    const key = `__LR_SIG14_MD_${keep.length}__`;
    keep.push(html);
    return key;
  };

  text = text.replace(/\*\*\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)\*\*/g, (_, label, url) => {
    return save(`<b><a href="${lrSigV14Attr(url)}">${lrSigV14Esc(label)}</a></b>`);
  });

  text = text.replace(/\[\*\*([^\]]+?)\*\*\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
    return save(`<b><a href="${lrSigV14Attr(url)}">${lrSigV14Esc(label)}</a></b>`);
  });

  text = text.replace(/\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
    return save(`<a href="${lrSigV14Attr(url)}">${lrSigV14Esc(label)}</a>`);
  });

  text = lrSigV14Esc(text)
    .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
    .replace(/\+\+([\s\S]+?)\+\+/g, '<u>$1</u>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');

  keep.forEach((html, i) => {
    text = text.replaceAll(`__LR_SIG14_MD_${i}__`, html);
  });

  return text.replace(/\*\*/g, '').replace(/\+\+/g, '').trim();
}

function lrSigV14FindText(root) {
  const found = [];
  const seen = new WeakSet();

  const walk = (v, path = '', inheritedMarkup = []) => {
    if (!v || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);

    const localMarkup =
      (Array.isArray(v.markup) && v.markup) ||
      (Array.isArray(v.body?.markup) && v.body.markup) ||
      (Array.isArray(v.message?.body?.markup) && v.message.body.markup) ||
      inheritedMarkup ||
      [];

    const add = (value, markup, bonus = 0) => {
      const text = String(value ?? '').trim();
      if (!text) return;

      const low = path.toLowerCase();
      let score = text.length + bonus;

      if (low.includes('message')) score += 300;
      if (low.includes('body')) score += 300;
      if (low.includes('content')) score += 120;

      if (low.includes('preview')) score -= 500;
      if (low.includes('attachment')) score -= 500;
      if (low.includes('button')) score -= 500;
      if (low.includes('chat')) score -= 250;
      if (low.includes('sender')) score -= 250;
      if (low.includes('user')) score -= 250;

      found.push({
        text,
        markup: Array.isArray(markup) ? markup : [],
        format: String(v.format || v.body?.format || v.content?.format || '').toLowerCase(),
        score
      });
    };

    if (typeof v.body?.text === 'string') add(v.body.text, v.body.markup || localMarkup, 700);
    if (typeof v.message?.body?.text === 'string') add(v.message.body.text, v.message.body.markup || localMarkup, 700);
    if (typeof v.text === 'string') add(v.text, localMarkup, 600);
    if (typeof v.caption === 'string') add(v.caption, localMarkup, 500);
    if (typeof v.content?.text === 'string') add(v.content.text, v.content.markup || localMarkup, 400);
    if (typeof v.payload?.text === 'string') add(v.payload.text, v.payload.markup || localMarkup, 300);

    for (const [k, child] of Object.entries(v)) {
      if (child && typeof child === 'object') walk(child, `${path}.${k}`, localMarkup);
    }
  };

  walk(root, 'root', []);

  found.sort((a, b) => b.score - a.score);
  return found[0] || { text: '', markup: [], format: '' };
}

function lrSigV14Content(updateOrContent) {
  const found = lrSigV14FindText(updateOrContent);
  const text = String(found.text || '').trim();
  const markup = Array.isArray(found.markup) ? found.markup : [];
  const format = String(found.format || '').toLowerCase();

  let html = '';

  if (markup.length) {
    html = lrSigV14MarkupToHtml(text, markup);
  } else if (format === 'html' || /(<|&lt;)\/?(a|b|strong|i|em|u|ins|s|strike|del|code)\b/i.test(text)) {
    html = lrSigV14HtmlToSafe(text);
  } else {
    html = lrSigV14MarkdownToHtml(text);
  }

  return {
    text: html,
    format: 'html',
    markup: [],
    attachments: []
  };
}

function lrSigV14Preview(sig) {
  if (!sig) return 'Подпись не создана.';
  return lrSigV14Content(sig).text || 'Подпись не создана.';
}
// LR_SIG_INPUT_V14_END


// LR_SIG_RICH_V13_START
globalThis.__lrSigRichV13 = (() => {
  const decode = (value) => String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const attr = (value) => esc(value).replace(/"/g, '&quot;');

  const cleanTail = (value) => String(value ?? '')
    .replace(/\*\*/g, '')
    .replace(/\+\+/g, '')
    .trim();

  const htmlToSafe = (value) => {
    let text = decode(value).trim();
    if (!text) return '';

    text = text.replace(/<a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*><b>([\s\S]*?)<\/b><\/a>/gi, (_, q, url, label) => {
      return `<b><a href="${attr(url)}">${esc(decode(label))}</a></b>`;
    });

    text = text.replace(/<b><a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a><\/b>/gi, (_, q, url, label) => {
      return `<b><a href="${attr(url)}">${esc(decode(label))}</a></b>`;
    });

    text = text.replace(/<a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, q, url, label) => {
      const inner = decode(label).replace(/<\/?b>/gi, '').trim();
      return `<a href="${attr(url)}">${esc(inner)}</a>`;
    });

    text = text
      .replace(/<strong>/gi, '<b>')
      .replace(/<\/strong>/gi, '</b>')
      .replace(/<em>/gi, '<i>')
      .replace(/<\/em>/gi, '</i>')
      .replace(/<ins>/gi, '<u>')
      .replace(/<\/ins>/gi, '</u>')
      .replace(/<strike>/gi, '<s>')
      .replace(/<\/strike>/gi, '</s>')
      .replace(/<del>/gi, '<s>')
      .replace(/<\/del>/gi, '</s>')
      .replace(/<br\s*\/?>/gi, '\n');

    const keep = [];
    text = text.replace(/<\/?(a|b|i|u|s|code)\b[^>]*>/gi, (m) => {
      const key = `__LR_KEEP_${keep.length}__`;
      keep.push(m);
      return key;
    });

    text = text.replace(/<[^>]*>/g, '');
    text = esc(text);

    keep.forEach((m, i) => {
      text = text.replaceAll(`__LR_KEEP_${i}__`, m);
    });

    return cleanTail(text);
  };

  const mdToHtml = (value) => {
    let text = decode(value).trim();
    if (!text) return '';

    const keep = [];
    const save = (html) => {
      const key = `__LR_MD_KEEP_${keep.length}__`;
      keep.push(html);
      return key;
    };

    text = text.replace(/\*\*\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)\*\*/g, (_, label, url) => {
      return save(`<b><a href="${attr(url)}">${esc(label)}</a></b>`);
    });

    text = text.replace(/\[\*\*([^\]]+?)\*\*\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
      return save(`<b><a href="${attr(url)}">${esc(label)}</a></b>`);
    });

    text = text.replace(/\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
      return save(`<a href="${attr(url)}">${esc(label)}</a>`);
    });

    text = esc(text)
      .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
      .replace(/\+\+([\s\S]+?)\+\+/g, '<u>$1</u>')
      .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');

    keep.forEach((html, i) => {
      text = text.replaceAll(`__LR_MD_KEEP_${i}__`, html);
    });

    return cleanTail(text);
  };

  const contentForSave = (content) => {
    const c = content && typeof content === 'object' ? content : { text: String(content ?? '') };
    const text = String(c.text ?? '');
    const format = String(c.format || '').toLowerCase();

    let html;
    if (format === 'html' || /(<|&lt;)\/?(a|b|strong|i|em|u|ins|s|strike|del|code)\b/i.test(text)) {
      html = htmlToSafe(text);
    } else {
      html = mdToHtml(text);
    }

    return {
      text: html,
      format: 'html',
      markup: [],
      attachments: []
    };
  };

  const preview = (sig) => {
    if (!sig) return 'Подпись не создана.';
    return contentForSave(sig).text || 'Подпись не создана.';
  };

  return { contentForSave, preview };
})();
// LR_SIG_RICH_V13_END


const app = express(); mountLinkRayAnalyticsRoutes(app);
app.use(express.json({ limit: '50mb' }));

// LR_CHANNEL_DB_SYNC_MIDDLEWARE_START
app.use(async (req, res, next) => {
  try {
    if (req.method === 'POST' && req.body && typeof req.body === 'object') {
      await __lrHandleChannelDbSyncUpdate(req.body);
    }
  } catch (error) {
    console.error('[channel db sync middleware]', error.message || error);
  }

  next();
});
// LR_CHANNEL_DB_SYNC_MIDDLEWARE_END


const PORT = Number(process.env.PORT || 3000);
const BOT_LINK = process.env.BOT_LINK || 'https://max.ru/se13353901_bot';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.SITE_URL || process.env.WEBAPP_URL || 'https://linkray.ru').replace(/\/$/, '');
const MSK_TZ = 'Europe/Moscow';
const MAX_PREVIEW_ATTACHMENTS = 8;

function nowIso() { return new Date().toISOString(); }
function log(scope, data) { console.log(`[${scope}]`, typeof data === 'string' ? data : JSON.stringify(data)); }
function safeJson(value, fallback = {}) { try { if (!value) return fallback; if (typeof value === 'object') return value; return JSON.parse(value); } catch { return fallback; } }
function rows(result) { return Array.isArray(result) ? result : (result?.rows || []); }
function escapeHtml(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attr(v) { return escapeHtml(v).replace(/"/g, '&quot;'); }
function plain(v) {
  return String(v || '')
    .replace(/<a\s+[^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(b|strong|i|em|u|s|strike|code|pre|span|p|div|h1|h2|h3)[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
function short(v, max = 48) { const s = plain(v).replace(/\s+/g, ' ').trim(); return s ? (s.length > max ? `${s.slice(0, max)}...` : s) : 'пост без текста'; }
function norm(v) { return String(v || '').replace(/[\uFE0F]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function includesText(a, b) { return norm(a).includes(norm(b)); }

async function ensureDb() {
  await query(`CREATE TABLE IF NOT EXISTS bot_sessions (user_id text PRIMARY KEY, state text NOT NULL DEFAULT 'idle', data jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now())`);
  await query(`CREATE TABLE IF NOT EXISTS channels (id serial PRIMARY KEY, max_chat_id text UNIQUE, title text, link text, is_public boolean DEFAULT false, is_channel boolean DEFAULT true, owner_max_user_id text, bot_added_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS max_chat_id text`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS title text`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS link text`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_public boolean DEFAULT false`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_channel boolean DEFAULT true`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS owner_max_user_id text`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS bot_added_at timestamptz DEFAULT now()`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`);

  await query(`CREATE TABLE IF NOT EXISTS scheduled_posts (id serial PRIMARY KEY, channel_id integer REFERENCES channels(id) ON DELETE SET NULL, text text NOT NULL DEFAULT '', format text NOT NULL DEFAULT 'html', publish_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'scheduled', notify boolean NOT NULL DEFAULT false, created_by_max_user_id text, error_message text, updated_at timestamptz NOT NULL DEFAULT now())`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS channel_id integer`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS text text`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS format text DEFAULT 'html'`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS publish_at timestamptz`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS status text DEFAULT 'scheduled'`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS notify boolean DEFAULT false`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS buttons jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS draft jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS is_ad boolean NOT NULL DEFAULT false`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS cpm numeric`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS auto_delete_minutes integer`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_after_hours integer NOT NULL DEFAULT 24`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS published_at timestamptz`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS published_message_id text`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_group_id text`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_sent_at timestamptz`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_message_id text`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_error_message text`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS report_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS auto_deleted_at timestamptz`);
  await query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS auto_delete_error_message text`);

  await query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scheduled_post_status') THEN ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'publishing'; ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'published'; ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'error'; ALTER TYPE scheduled_post_status ADD VALUE IF NOT EXISTS 'canceled'; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await query(`UPDATE scheduled_posts SET notify = false WHERE notify IS NULL`);
  await query(`UPDATE scheduled_posts SET text = '' WHERE text IS NULL`);
  await query(`UPDATE scheduled_posts SET format = 'html' WHERE format IS NULL`);
  await query(`UPDATE scheduled_posts SET publish_at = now() WHERE publish_at IS NULL`);
  await query(`ALTER TABLE scheduled_posts ALTER COLUMN notify SET DEFAULT false`);

  await query(`CREATE TABLE IF NOT EXISTS channel_signatures (id serial PRIMARY KEY, channel_id integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE, owner_key text NOT NULL DEFAULT 'global', title text NOT NULL DEFAULT 'Автоподпись', text text NOT NULL DEFAULT '', format text NOT NULL DEFAULT 'html', markup jsonb NOT NULL DEFAULT '[]'::jsonb, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS owner_key text DEFAULT 'global'`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Автоподпись'`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS text text NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'html'`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS markup jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_signatures_channel_owner ON channel_signatures(channel_id, owner_key)`);

  await query(`CREATE TABLE IF NOT EXISTS user_quick_times (owner_key text NOT NULL, time_text text NOT NULL, used_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_key, time_text))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_posts_publish ON scheduled_posts(status, publish_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_posts_channel ON scheduled_posts(channel_id, publish_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_posts_report ON scheduled_posts(is_ad, status, report_sent_at, published_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_scheduled_posts_delete ON scheduled_posts(status, auto_delete_minutes, published_at)`);

  await query(`CREATE TABLE IF NOT EXISTS analytics_links (
    token text PRIMARY KEY,
    campaign_id text NOT NULL,
    post_id integer,
    channel_id integer,
    label text,
    target_url text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS analytics_clicks (
    id bigserial PRIMARY KEY,
    token text NOT NULL REFERENCES analytics_links(token) ON DELETE CASCADE,
    campaign_id text NOT NULL,
    post_id integer,
    channel_id integer,
    fingerprint text NOT NULL,
    ip_hash text,
    user_agent text,
    clicked_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(token, fingerprint)
  )`);

  await query(`CREATE INDEX IF NOT EXISTS idx_analytics_clicks_campaign ON analytics_clicks(campaign_id, clicked_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_analytics_links_campaign ON analytics_links(campaign_id)`);
}

function getUpdateType(u) { return u.update_type || u.updateType || u.type || u.event_type || ''; }
function getChatId(u) { return u.chat_id || u.chatId || u.chat?.id || u.chat?.chat_id || u.message?.recipient?.chat_id || u.message?.recipient?.chatId || u.message?.chat_id || u.message?.chatId || u.message?.chat?.id || u.callback?.chat?.id || u.callback?.message?.recipient?.chat_id || null; }
function getUserId(u) { return u.user_id || u.userId || u.user?.id || u.message?.sender?.user_id || u.message?.sender?.userId || u.message?.sender?.id || u.callback?.user?.user_id || u.callback?.user?.id || null; }
function getSessionKey(u) { return String(getChatId(u) || getUserId(u) || 'unknown'); }
function getCallbackId(u) { return u.callback?.callback_id || u.callback?.callbackId || u.callback_id || u.callbackId || null; }
function getCallbackPayload(u) {
  const candidates = [u.callback?.payload, u.callback?.button?.payload, u.callback?.data, u.callback?.value, u.button?.payload, u.message?.body?.payload, u.message?.payload, u.payload, u.data];
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    if (typeof c === 'string') return c;
    if (typeof c === 'object') return c.payload || c.value || c.data || JSON.stringify(c);
  }
  return '';
}
function getMessageText(u) { return String(u.message?.body?.text || u.message?.text || u.body?.text || u.text || '').trim(); }
function getChatTitle(u) { return u.chat?.title || u.chat?.name || u.message?.chat?.title || u.message?.chat?.name || u.chat_title || u.chatTitle || null; }
function getChatLink(u) { return u.chat?.link || u.chat?.invite_link || u.chat?.inviteLink || u.message?.chat?.link || u.chat_link || u.chatLink || null; }

async function getSession(key) { const r = await query('SELECT state, data FROM bot_sessions WHERE user_id=$1', [String(key)]); return r[0] || { state: 'idle', data: {} }; }
async function setSession(key, state, data = {}) { await query(`INSERT INTO bot_sessions(user_id,state,data,updated_at) VALUES($1,$2,$3::jsonb,now()) ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,data=EXCLUDED.data,updated_at=now()`, [String(key), state, JSON.stringify(data)]); }
async function clearSession(key) { await setSession(key, 'idle', {}); }

function buttonRows(rows) { return inlineKeyboard(rows); }
async function cb(callbackId, text, rows = [], format = 'html') { return answerCallback({ callbackId, text, format, attachments: buttonRows(rows) }); }
async function msg(chatId, text, rows = [], format = 'html') { return sendMaxMessage({ chatId, text, format, attachments: rows.length ? buttonRows(rows) : [] }); }
async function cbOrMsg(callbackId, chatId, text, rows = [], format = 'html') {
  try {
    return await cb(callbackId, text, rows, format);
  } catch (error) {
    console.error('[callback fallback to message]', error.message || error);
    if (chatId) return msg(chatId, text, rows, format);
    throw error;
  }
}

function mskDate(date = new Date()) { return new Date(date.toLocaleString('en-US', { timeZone: MSK_TZ })); }
function dateKey(date = new Date()) { const d = mskDate(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function keyToDate(key) { const [y,m,d] = String(key || dateKey()).split('-').map(Number); return new Date(y, (m||1)-1, d||1); }
function shiftDay(key, n) { const d = keyToDate(key); d.setDate(d.getDate()+Number(n||0)); return dateKey(d); }
function monthName(d) { return ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][d.getMonth()] || ''; }
function dayName(d) { return ['вс','пн','вт','ср','чт','пт','сб'][d.getDay()] || ''; }
function timeText(d) { return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function dateText(d) { return `${dayName(d)} ${d.getDate()} ${monthName(d)} ${d.getFullYear()} г.`; }
function dateButtonText(d) { return `${d.getDate()} ${monthName(d)} ${d.getFullYear()}`; }
function dateTimeText(d) { return `${timeText(d)} · ${dateText(d)}`; }
function parseDbDate(v) { const d = new Date(v || Date.now()); return Number.isNaN(d.getTime()) ? new Date() : d; }
function formatAutoDelete(minutes) { if (!minutes) return 'без удаления'; const n = Number(minutes); if (!Number.isFinite(n) || n <= 0) return 'без удаления'; if (n % 1440 === 0) return `${n / 1440}д`; if (n % 60 === 0) return `${n / 60}ч`; return `${n} мин`; }
function autoDeleteRows(prefix = 'publish') { return [[callbackButton('24', `${prefix}:auto_set:1440`), callbackButton('48', `${prefix}:auto_set:2880`), callbackButton('72', `${prefix}:auto_set:4320`)],[callbackButton('Без удаления', `${prefix}:auto_set:0`)]]; }
function reportUrl(groupId) { return `${PUBLIC_BASE_URL}/analytics/stats/${encodeURIComponent(String(groupId || ''))}`; }
function rawDateKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function weekStart(date) { const d = keyToDate(rawDateKey(date)); const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); return d; }
function calendarTitle(dayKey) { const d = keyToDate(dayKey); return `${monthName(d)} ${d.getFullYear()} · ${dateText(d)}`; }
function calendarRows(baseKey, selectedKey = null) {
  const today = dateKey(new Date());
  const base = keyToDate(baseKey || today);
  const start = weekStart(base);
  const dayRow = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const k = rawDateKey(d);
    const isPast = k < today;
    const label = isPast ? '•' : (selectedKey === k ? `🔴 ${d.getDate()}` : String(d.getDate()));
    dayRow.push(callbackButton(label, isPast ? 'noop' : `schedule:day:${k}`));
  }
  const prev = new Date(start); prev.setDate(start.getDate() - 7);
  const next = new Date(start); next.setDate(start.getDate() + 7);
  return [
    [callbackButton('⬅️ Неделя', `schedule:week:${rawDateKey(prev)}`), callbackButton('Неделя ➡️', `schedule:week:${rawDateKey(next)}`)],
    dayRow,
    [callbackButton('⬅️ Назад', 'editor:next')],
  ];
}
function timeRowsForDay(dayKey) {
  return [
    [callbackButton('09:00', `schedule:time:${dayKey}:0900`), callbackButton('12:00', `schedule:time:${dayKey}:1200`), callbackButton('15:00', `schedule:time:${dayKey}:1500`)],
    [callbackButton('18:00', `schedule:time:${dayKey}:1800`), callbackButton('21:00', `schedule:time:${dayKey}:2100`), callbackButton('23:00', `schedule:time:${dayKey}:2300`)],
    [callbackButton('✍️ Ввести время', `schedule:manual_day:${dayKey}`)],
    [callbackButton('⬅️ К календарю', `schedule:week:${dayKey}`)],
  ];
}
function dateTimeFromDayTime(dayKey, hhmm) {
  const hh = String(hhmm).slice(0, 2);
  const mm = String(hhmm).slice(2, 4);
  return new Date(`${dayKey}T${hh}:${mm}:00+03:00`);
}
async function showScheduleCalendar(callbackId, key, dayKey = null) {
  const s = await getSession(key);
  await setSession(key, 'publish_menu', s.data || {});
  const baseKey = dayKey || dateKey(new Date());
  return cb(callbackId, `━━━━━━━━━━━━━━\n📅 <b>Календарь публикации</b>\n\n${calendarTitle(baseKey)}\n\nПрошедшие дни отмечены точкой. Выберите число для публикации.\n━━━━━━━━━━━━━━`, calendarRows(baseKey));
}
async function showScheduleTimes(callbackId, key, dayKey) {
  const s = await getSession(key);
  await setSession(key, 'publish_menu', s.data || {});
  return cb(callbackId, `━━━━━━━━━━━━━━\n🕒 <b>Время публикации</b>\n\n${dateText(keyToDate(dayKey))}\n\nВыберите время или введите вручную.\n━━━━━━━━━━━━━━`, timeRowsForDay(dayKey));
}
async function scheduleFromCallbackTime(callbackId, chatId, key, dayKey, hhmm) {
  const s = await getSession(key);
  const draft = safeDraft(s.data);
  const publishAt = dateTimeFromDayTime(dayKey, hhmm);
  if (publishAt.getTime() <= Date.now()) return cb(callbackId, 'Это время уже прошло. Выберите будущую дату и время.', calendarRows(dayKey));
  const ids = await scheduleDraft(draft, key, publishAt);
  await clearSession(key);
  await answerCallback({ callbackId, notification: 'Пост запланирован.' }).catch(() => {});
  return afterPlanned(chatId, draft, publishAt, ids);
}

function channelName(ch) { return ch?.title || ch?.name || `Канал #${ch?.id || '?'}`; }
function channelLine(ch) { const title = escapeHtml(channelName(ch)); const link = ch?.link || ch?.url || ch?.invite_link || ''; return link ? `• <a href="${attr(link)}">${title}</a>` : `• ${title}`; }
function channelsLines(channels) { return (channels || []).map(channelLine).join('\n') || '• канал не выбран'; }


async function maybeRegisterChannel(update) {
  const chatId = getChatId(update);
  const title = getChatTitle(update);
  if (!chatId || !title) return;
  const link = getChatLink(update);
  await query(`
    INSERT INTO channels(max_chat_id, title, link, is_public, is_channel, bot_added_at, updated_at)
    VALUES($1,$2,$3,$4,true,now(),now())
    ON CONFLICT(max_chat_id) DO UPDATE SET title=COALESCE(EXCLUDED.title, channels.title), link=COALESCE(EXCLUDED.link, channels.link), is_public=EXCLUDED.is_public, updated_at=now()
  `, [String(chatId), title, link || null, Boolean(link)]).catch((e) => console.error('[register channel]', e.message || e));
}

async function getChannels() { return query('SELECT id,max_chat_id,title,link,is_public FROM channels ORDER BY title ASC NULLS LAST, id ASC'); }
async function getChannel(id) { const r = await query('SELECT id,max_chat_id,title,link,is_public FROM channels WHERE id=$1', [Number(id)]); return r[0] || null; }
async function getChannelsByIds(ids) { const list = (ids || []).map(Number).filter(Boolean); if (!list.length) return []; return query('SELECT id,max_chat_id,title,link,is_public FROM channels WHERE id=ANY($1::int[]) ORDER BY title ASC NULLS LAST, id ASC', [list]); }
async function refreshChannelMeta(channel) {
  if (!channel?.max_chat_id) return channel;
  try {
    const info = await getMaxChatInfo(channel.max_chat_id);
    const title = info?.chat?.title || info?.title || info?.name || channel.title;
    const link = info?.chat?.link || info?.link || info?.invite_link || channel.link || null;
    const isPublic = Boolean(link);
    await query('UPDATE channels SET title=$2, link=$3, is_public=$4, updated_at=now() WHERE id=$1', [channel.id, title, link, isPublic]);
    return { ...channel, title, link, is_public: isPublic };
  } catch (e) {
    console.error('[channel meta]', e.message || e);
    return channel;
  }
}

function emptyDraft() { return { campaignId: `lr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`, channelIds: [], content: { text: '', format: 'html', attachments: [], markup: [], raw: null }, buttons: [], isAd: false, cpm: null, autoDeleteMinutes: null, reportAfterHours: 24, signatureEnabled: true, scheduleDate: null, previewMessageId: null }; }
function safeDraft(data) {
  const d = data?.draft || data || {};
  const base = emptyDraft();
  const draft = {
    ...base,
    ...d,
    campaignId: d.campaignId || d.reportGroupId || base.campaignId,
    content: {
      ...base.content,
      ...(d.content || {}),
      attachments: Array.isArray(d.content?.attachments) ? d.content.attachments : [],
    },
    buttons: Array.isArray(d.buttons) ? d.buttons : [],
    channelIds: Array.isArray(d.channelIds) ? d.channelIds.map(Number).filter(Boolean) : [],
  };
  return draft;
}
function hasContent(d) { return Boolean(String(d?.content?.text || '').trim() || (Array.isArray(d?.content?.attachments) && d.content.attachments.length)); }


function applyMarkupToHtml(text, markup = []) {
  const source = String(text || '');
  const marks = Array.isArray(markup) ? markup : [];

  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const attr = (v) => esc(v).replace(/"/g, '&quot;');

  const typeOf = (m) => String(
    m?.type ||
    m?.kind ||
    m?.style ||
    m?.format ||
    m?.markup_type ||
    m?.markupType ||
    m?.entity_type ||
    m?.entityType ||
    ''
  ).toLowerCase();

  const urlOf = (m) => String(
    m?.url ||
    m?.href ||
    m?.link ||
    m?.target_url ||
    m?.targetUrl ||
    m?.payload?.url ||
    m?.payload?.href ||
    m?.payload?.link ||
    ''
  ).trim();

  const rangeOf = (m) => {
    let start = Number(m?.from ?? m?.start ?? m?.offset ?? m?.pos ?? m?.range?.from ?? m?.range?.start ?? 0);
    let end = Number(m?.to ?? m?.end ?? m?.range?.to ?? m?.range?.end ?? NaN);
    const len = Number(m?.length ?? m?.len ?? m?.range?.length ?? m?.range?.len ?? NaN);

    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = Number.isFinite(len) ? start + len : start;

    start = Math.max(0, Math.min(source.length, start));
    end = Math.max(0, Math.min(source.length, end));

    if (end <= start) return null;
    return { start, end };
  };

  const tagOf = (m) => {
    const t = typeOf(m);
    const url = urlOf(m);

    if ((t.includes('link') || t.includes('url')) && /^https?:\/\//i.test(url)) {
      return { open: `<a href="${attr(url)}">`, close: '</a>', priority: 70 };
    }

    if (t.includes('strong') || t.includes('bold')) return { open: '<b>', close: '</b>', priority: 10 };
    if (t.includes('italic') || t.includes('emphasis') || t.includes('emphasized') || t === 'em') return { open: '<i>', close: '</i>', priority: 20 };
    if (t.includes('underline') || t.includes('underlined') || t.includes('ins')) return { open: '<u>', close: '</u>', priority: 30 };
    if (t.includes('strike') || t.includes('through') || t.includes('deleted') || t === 's' || t === 'del') return { open: '<s>', close: '</s>', priority: 40 };
    if (t.includes('mono') || t.includes('code')) return { open: '<code>', close: '</code>', priority: 50 };
    if (t.includes('heading') || t.includes('header') || t.includes('title') || /^h[1-6]$/.test(t)) return { open: '<b>', close: '</b>', priority: 5 };
    if (t.includes('quote') || t.includes('blockquote') || t.includes('quotation') || t.includes('cite')) return { open: '<blockquote>', close: '</blockquote>', priority: 6 };

    return null;
  };

  const opens = new Map();
  const closes = new Map();

  const add = (map, pos, item) => {
    if (!map.has(pos)) map.set(pos, []);
    map.get(pos).push(item);
  };

  for (const m of marks) {
    if (!m || typeof m !== 'object') continue;

    const range = rangeOf(m);
    const tag = tagOf(m);

    if (!range || !tag) continue;

    const item = { ...tag, start: range.start, end: range.end };
    add(opens, range.start, item);
    add(closes, range.end, item);
  }

  if (!opens.size && !closes.size) return esc(source);

  for (const arr of opens.values()) arr.sort((a, b) => a.priority - b.priority);
  for (const arr of closes.values()) arr.sort((a, b) => b.priority - a.priority);

  let out = '';

  for (let i = 0; i <= source.length; i++) {
    for (const item of closes.get(i) || []) out += item.close;
    for (const item of opens.get(i) || []) out += item.open;
    if (i < source.length) out += esc(source[i]);
  }

  return out
    .replace(/<\/blockquote>\s*<blockquote>/g, '\n')
    .trim();
}
function contentTextCandidates(v, found = [], seen = new Set(), path = '') {
  if (!v || typeof v !== 'object' || seen.has(v)) return found;
  seen.add(v);

  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) contentTextCandidates(v[i], found, seen, `${path}.${i}`);
    return found;
  }

  const localMarkup =
    (Array.isArray(v.markup) && v.markup) ||
    (Array.isArray(v.body?.markup) && v.body.markup) ||
    (Array.isArray(v.message?.body?.markup) && v.message.body.markup) ||
    [];

  const addCandidate = (value, markup = localMarkup, scoreBonus = 0) => {
    const txt = String(value || '').trim();
    if (!txt) return;
    const lowPath = String(path).toLowerCase();
    let score = plain(txt).length + scoreBonus;
    if (lowPath.includes('forward') || lowPath.includes('link') || lowPath.includes('message') || lowPath.includes('body') || lowPath.includes('content')) score += 200;
    if (lowPath.includes('chat') || lowPath.includes('sender') || lowPath.includes('user') || lowPath.includes('button')) score -= 200;
    found.push({ text: txt, markup: Array.isArray(markup) ? markup : [], score });
  };

  if (typeof v.body?.text === 'string') addCandidate(v.body.text, v.body.markup || localMarkup, 250);
  if (typeof v.text === 'string') addCandidate(v.text, localMarkup, 200);
  if (typeof v.caption === 'string') addCandidate(v.caption, localMarkup, 200);
  if (typeof v.payload?.text === 'string') addCandidate(v.payload.text, v.payload.markup || localMarkup, 150);
  if (typeof v.content?.text === 'string') addCandidate(v.content.text, v.content.markup || localMarkup, 150);

  for (const [k, child] of Object.entries(v)) {
    if (child && typeof child === 'object') contentTextCandidates(child, found, seen, `${path}.${k}`);
  }
  return found;
}

function bestContentCandidate(u) {
  const candidates = contentTextCandidates(u?.message || u);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || { text: '', markup: [], score: 0 };
}

function firstText(u) {
  return String(bestContentCandidate(u).text || '').trim();
}

function firstMarkup(u) {
  const best = bestContentCandidate(u);
  if (Array.isArray(best.markup) && best.markup.length) return best.markup;

  const found = [];
  const seen = new Set();
  const scan = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) scan(x); return; }
    if (Array.isArray(v.markup) && v.markup.length) found.push(v.markup);
    if (Array.isArray(v.body?.markup) && v.body.markup.length) found.push(v.body.markup);
    if (Array.isArray(v.payload?.markup) && v.payload.markup.length) found.push(v.payload.markup);
    for (const child of Object.values(v)) if (child && typeof child === 'object') scan(child);
  };
  scan(u?.message || u);
  return found[0] || [];
}

function looksLikeAttachment(v) { if (!v || typeof v !== 'object') return false; const t = String(v.type || v.attachment_type || v.attachmentType || '').toLowerCase(); return ['image','photo','video','file','audio','sticker'].some(x => t.includes(x)); }
function collectAttachments(v, found = [], seen = new Set()) {
  if (!v || typeof v !== 'object' || found.length >= MAX_PREVIEW_ATTACHMENTS || seen.has(v)) return found;
  seen.add(v);
  if (Array.isArray(v)) {
    for (const x of v) collectAttachments(x, found, seen);
    return found.slice(0, MAX_PREVIEW_ATTACHMENTS);
  }
  if (looksLikeAttachment(v)) {
    const t = String(v.type || v.attachment_type || v.attachmentType || '').toLowerCase();
    if (t !== 'inline_keyboard' && !t.includes('keyboard')) found.push(v);
  }
  for (const child of Object.values(v)) {
    if (child && typeof child === 'object') collectAttachments(child, found, seen);
  }
  return found.slice(0, MAX_PREVIEW_ATTACHMENTS);
}

function normalizeAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const type = String(a.type || a.attachment_type || a.attachmentType || '').toLowerCase();
  const p = a.payload && typeof a.payload === 'object' ? a.payload : {};
  if (type === 'inline_keyboard') return a;
  if (type.includes('image') || type.includes('photo')) { if (p.token) return { type: 'image', payload: { token: p.token } }; if (a.token) return { type: 'image', payload: { token: a.token } }; if (Array.isArray(p.photos)) return { type: 'image', payload: { photos: p.photos } }; }
  if (type.includes('video')) { if (p.token) return { type: 'video', payload: { token: p.token } }; if (a.token) return { type: 'video', payload: { token: a.token } }; }
  if (type.includes('file')) { if (p.token) return { type: 'file', payload: { token: p.token } }; if (a.token) return { type: 'file', payload: { token: a.token } }; }
  return null;
}
function normalizeAttachments(list = []) { const out = []; const seen = new Set(); for (const a of list || []) { const n = normalizeAttachment(a); if (!n) continue; const k = JSON.stringify(n); if (seen.has(k)) continue; seen.add(k); out.push(n); } return out; }






// LR_NATIVE_MAX_MARKUP_START
function lrMarkupType(mark) {
  return String(
    mark?.type ||
    mark?.kind ||
    mark?.style ||
    mark?.format ||
    mark?.markup_type ||
    mark?.markupType ||
    mark?.entity_type ||
    mark?.entityType ||
    mark?.block_type ||
    mark?.blockType ||
    ''
  ).toLowerCase();
}

function lrMarkupStart(mark) {
  const n = Number(
    mark?.from ??
    mark?.start ??
    mark?.offset ??
    mark?.position ??
    mark?.index ??
    0
  );

  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function lrMarkupEnd(mark, textLength) {
  const start = lrMarkupStart(mark);

  const directEnd = Number(mark?.to ?? mark?.end);

  if (Number.isFinite(directEnd)) {
    return Math.max(start, Math.min(textLength, directEnd));
  }

  const len = Number(mark?.length ?? mark?.len ?? mark?.size ?? 0);

  if (Number.isFinite(len) && len > 0) {
    return Math.max(start, Math.min(textLength, start + len));
  }

  return start;
}

function lrMarkupUrl(mark) {
  return String(
    mark?.url ||
    mark?.href ||
    mark?.link ||
    mark?.payload?.url ||
    mark?.payload?.href ||
    mark?.payload?.link ||
    ''
  );
}

function lrApplyBlockMarkdown(type, part) {
  const clean = String(part || '');

  if (!clean) return clean;

  if (type.includes('quote') || type.includes('blockquote') || type.includes('quotation') || type.includes('quoted') || type.includes('cite') || type.includes('quotation') || type.includes('quoted')) {
    return clean
      .split('\n')
      .map((line) => line.trim() ? `> ${line}` : '>')
      .join('\n');
  }

  if (type.includes('heading') || type.includes('header') || type.includes('title') || /^h[1-6]$/.test(type)) {
    return clean
      .split('\n')
      .map((line) => line.trim() ? `# ${line}` : line)
      .join('\n');
  }

  return clean;
}

function lrApplyInlineMarkdown(type, part, mark) {
  const value = String(part || '');
  const url = lrMarkupUrl(mark);

  if (!value) return value;

  if (type.includes('bold') || type.includes('strong')) return `**${value}**`;
  if (type.includes('italic') || type.includes('emphasis') || type.includes('emphasiz') || type === 'em') return `_${value}_`;
  if (type.includes('underline') || type === 'ins') return `++${value}++`;
  if (type.includes('strike') || type.includes('strikethrough') || type.includes('deleted') || type === 'del' || type === 's') return `~~${value}~~`;
  if (type.includes('mono') || type.includes('inline_code') || type === 'code') return '`' + value.replace(/`/g, 'ʼ') + '`';
  if (type.includes('mark') || type.includes('highlight')) return `^^${value}^^`;
  if ((type.includes('link') || type.includes('url')) && url) return `[${value}](${url})`;

  return value;
}

function lrMaxMarkupToMarkdown(text, markup = []) {
  const source = String(text || '');

  if (!source) return '';

  const list = Array.isArray(markup) ? markup : [];

  if (!list.length) return source;

  const normalized = [];

  for (const mark of list) {
    const type = lrMarkupType(mark);
    const start = lrMarkupStart(mark);
    const end = lrMarkupEnd(mark, source.length);

    if (!type || end <= start || start >= source.length) continue;

    normalized.push({ mark, type, start, end });
  }

  if (!normalized.length) return source;

  // Сначала применяем самые поздние диапазоны, чтобы индексы не съехали.
  normalized.sort((a, b) => {
    if (b.start !== a.start) return b.start - a.start;
    return a.end - b.end;
  });

  let result = source;

  for (const item of normalized) {
    const before = result.slice(0, item.start);
    const part = result.slice(item.start, item.end);
    const after = result.slice(item.end);

    let replaced = part;

    if (
      item.type.includes('quote') ||
      item.type.includes('blockquote') ||
      item.type.includes('quotation') ||
      item.type.includes('quoted') ||
      item.type.includes('cite') ||
      item.type.includes('quotation') ||
      item.type.includes('quoted') ||
      item.type.includes('heading') ||
      item.type.includes('header') ||
      item.type.includes('title') ||
      /^h[1-6]$/.test(item.type)
    ) {
      replaced = lrApplyBlockMarkdown(item.type, part);
    } else {
      replaced = lrApplyInlineMarkdown(item.type, part, item.mark);
    }

    result = before + replaced + after;
  }

  return result;
}

function lrDebugMarkupTypes(markup = []) {
  try {
    const types = [...new Set((Array.isArray(markup) ? markup : []).map(lrMarkupType).filter(Boolean))];

    if (types.length) {
      console.log('[native-max-markup] types:', JSON.stringify(types));
    }
  } catch {}
}
// LR_NATIVE_MAX_MARKUP_END



// LR_DEEP_NATIVE_MARKUP_START
function lrDeepNativeMarkupType(mark) {
  return String(
    mark?.type ||
    mark?.kind ||
    mark?.style ||
    mark?.format ||
    mark?.markup_type ||
    mark?.markupType ||
    mark?.entity_type ||
    mark?.entityType ||
    mark?.block_type ||
    mark?.blockType ||
    ''
  ).toLowerCase();
}

function lrLooksLikeNativeMarkupItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;

  const type = lrDeepNativeMarkupType(item);

  if (!type) return false;

  const hasRange =
    item.from !== undefined ||
    item.start !== undefined ||
    item.offset !== undefined ||
    item.position !== undefined ||
    item.index !== undefined ||
    item.to !== undefined ||
    item.end !== undefined ||
    item.length !== undefined ||
    item.len !== undefined ||
    item.size !== undefined;

  const supported =
    type.includes('heading') ||
    type.includes('header') ||
    type.includes('title') ||
    type.includes('strong') ||
    type.includes('bold') ||
    type.includes('emphas') ||
    type.includes('italic') ||
    type.includes('underline') ||
    type.includes('mono') ||
    type.includes('code') ||
    type.includes('strike') ||
    type.includes('through') ||
    type.includes('link') ||
    type.includes('url') ||
    type.includes('quote') ||
    type.includes('blockquote') ||
    type.includes('quotation') ||
    type.includes('quoted') ||
    type.includes('cite') ||
    /^h[1-6]$/.test(type);

  return supported && hasRange;
}

function lrCollectNativeMarkupDeep(root) {
  const out = [];
  const seen = new WeakSet();

  function walk(value) {
    if (!value || typeof value !== 'object') return;

    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        if (lrLooksLikeNativeMarkupItem(item)) out.push(item);
        walk(item);
      }
      return;
    }

    for (const key of Object.keys(value)) {
      const child = value[key];

      if (
        key === 'markup' ||
        key === 'markups' ||
        key === 'entities' ||
        key === 'text_entities' ||
        key === 'textEntities' ||
        key === 'formatting' ||
        key === 'formats' ||
        key === 'blocks' ||
        key === 'spans'
      ) {
        walk(child);
      } else if (child && typeof child === 'object') {
        walk(child);
      }
    }
  }

  walk(root);

  const uniq = [];
  const keys = new Set();

  for (const item of out) {
    const key = JSON.stringify([
      lrDeepNativeMarkupType(item),
      item.from ?? item.start ?? item.offset ?? item.position ?? item.index ?? 0,
      item.to ?? item.end ?? item.length ?? item.len ?? item.size ?? 0,
      item.url ?? item.href ?? item.link ?? item?.payload?.url ?? ''
    ]);

    if (keys.has(key)) continue;
    keys.add(key);
    uniq.push(item);
  }

  return uniq;
}
// LR_DEEP_NATIVE_MARKUP_END


async function hydrateContent(u) {
  const best = globalThis.__lrRichV7.bestContent(u);
  const rawText = String(best?.text || '').trim();
  const markup = Array.isArray(best?.markup) ? best.markup : [];
  const attachments = globalThis.__lrRichV7.attachments(u);

  const content = globalThis.__lrRichV7.content({
    text: rawText,
    format: markup.length ? 'native' : 'html',
    markup,
    attachments
  });

  return {
    text: content.text,
    format: 'html',
    markup: [],
    attachments,
    raw: null
  };
}


function parseButtonsInput(input) {
  const rows = [];
  for (const line of String(input || '').split(/\n+/).map(x=>x.trim()).filter(Boolean)) {
    const row = [];
    for (const part of line.split('|').map(x=>x.trim()).filter(Boolean)) {
      const m = part.match(/^(.+?)\s*(?:-|—|–)\s*(https?:\/\/\S+)$/i);
      if (m) row.push({ text: m[1].trim(), url: m[2].trim() });
    }
    if (row.length) rows.push(row);
  }
  return rows;
}
function keyboardAttachmentFromButtons(buttons = []) {
  const rows = [];
  for (const r of buttons || []) {
    const row = [];
    for (const b of (Array.isArray(r) ? r : [r])) if (b?.text && /^https?:\/\//i.test(b?.url || '')) row.push(linkButton(b.text, b.url));
    if (row.length) rows.push(row);
  }
  return rows.length ? inlineKeyboard(rows)[0] : null;
}
function finalAttachments(draft) { const out = normalizeAttachments(draft?.content?.attachments || []); const kb = keyboardAttachmentFromButtons(draft?.buttons || []); if (kb) out.push(kb); return out; }
async function loadSignature(channelId, ownerKey = 'shared') { const r = await query('SELECT * FROM channel_signatures WHERE channel_id=$1 AND owner_key=$2 AND is_active=true ORDER BY updated_at DESC LIMIT 1', [Number(channelId), String(ownerKey)]); return r[0] || null; }
async function saveSignature(channelId, content, ownerKey = 'shared') {
  await query(`INSERT INTO channel_signatures(channel_id, owner_key, title, text, format, markup, is_active, updated_at) VALUES($1,$2,'Автоподпись',$3,$4,$5::jsonb,true,now()) ON CONFLICT(channel_id, owner_key) DO UPDATE SET text=EXCLUDED.text, format=EXCLUDED.format, markup=EXCLUDED.markup, is_active=true, updated_at=now()`, [Number(channelId), ownerKey, content.text || '', content.format || 'html', JSON.stringify(content.markup || [])]);
}
async function setSignatureActive(channelId, active, ownerKey = 'shared') { await query('UPDATE channel_signatures SET is_active=$3, updated_at=now() WHERE channel_id=$1 AND owner_key=$2', [Number(channelId), ownerKey, Boolean(active)]); }


// LR_SIGNATURE_FORMAT_SAFE_START
function lrDecodeBasicHtmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function lrStripTags(value) {
  return lrDecodeBasicHtmlEntities(String(value || '').replace(/<[^>]*>/g, ''));
}

function lrSignatureToMarkdown(value) {
  let text = String(value || '');

  text = text
    .replace(/<a\b[^>]*href=(["'])(https?:\/\/[^"']+|max:\/\/user\/\d+)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, url, label) => `[${lrStripTags(label).trim() || url}](${url})`)
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/(b|strong)>/gi, (_, __, inner) => `**${lrStripTags(inner)}**`)
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/(i|em)>/gi, (_, __, inner) => `_${lrStripTags(inner)}_`)
    .replace(/<(u|ins)\b[^>]*>([\s\S]*?)<\/(u|ins)>/gi, (_, __, inner) => `++${lrStripTags(inner)}++`)
    .replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/(s|strike|del)>/gi, (_, __, inner) => `~~${lrStripTags(inner)}~~`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => '`' + lrStripTags(inner).replace(/`/g, 'ʼ') + '`')
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => lrStripTags(inner).split('\n').map(line => line.trim() ? `> ${line}` : '>').join('\n'))
    .replace(/<br\s*\/?>/gi, '\n');

  // Убираем любые оставшиеся хвосты HTML, включая сломанный </b>.
  text = lrStripTags(text);

  return lrCleanMarkdownLinkLabels(text.trim());
}


function lrCleanMarkdownLinkLabels(value) {
  return String(value || '').replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|max:\/\/user\/\d+)\)/gi,
    (_, label, url) => {
      const clean = String(label || '')
        .replace(/\*\*/g, '')
        .replace(/__/g, '')
        .replace(/\+\+/g, '')
        .replace(/~~/g, '')
        .replace(/\^\^/g, '')
        .replace(/`/g, '')
        .trim();

      return `[${clean || url}](${url})`;
    }
  );
}

function lrSignatureForPostFormat(value, format = 'html') {
  const html = globalThis.__lrAutosignOnlySafe.display({ text: value, format: 'html', markup: [] });
  if (String(format || 'html').toLowerCase() === 'markdown') {
    return html
      .replace(/<a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, url, label) => `[${String(label || '').replace(/<[^>]*>/g, '').trim() || url}](${url})`)
      .replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**')
      .replace(/<i>([\s\S]*?)<\/i>/gi, '_$1_')
      .replace(/<u>([\s\S]*?)<\/u>/gi, '++$1++')
      .replace(/<s>([\s\S]*?)<\/s>/gi, '~~$1~~')
      .replace(/<[^>]*>/g, '')
      .trim();
  }
  return html;
}
// LR_SIGNATURE_FORMAT_SAFE_END




// LR_AUTOSIG_HTML_V8_START
function lrSigV8Decode(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function lrSigV8Esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrSigV8Attr(value) {
  return lrSigV8Esc(value).replace(/"/g, '&quot;');
}

function lrSigV8CleanHtml(value) {
  let text = lrSigV8Decode(value).trim();
  if (!text) return '';

  const saved = [];

  const save = (html) => {
    const key = `__LR_SIG_V8_${saved.length}__`;
    saved.push(html);
    return key;
  };

  text = text.replace(/<a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, url, label) => {
    const inner = lrSigV8CleanHtml(label);
    return save(`<a href="${lrSigV8Attr(url)}">${inner}</a>`);
  });

  text = text
    .replace(/<\s*(b|strong)\s*>/gi, save('<b>'))
    .replace(/<\s*\/\s*(b|strong)\s*>/gi, save('</b>'))
    .replace(/<\s*(i|em)\s*>/gi, save('<i>'))
    .replace(/<\s*\/\s*(i|em)\s*>/gi, save('</i>'))
    .replace(/<\s*(u|ins)\s*>/gi, save('<u>'))
    .replace(/<\s*\/\s*(u|ins)\s*>/gi, save('</u>'))
    .replace(/<\s*(s|strike|del)\s*>/gi, save('<s>'))
    .replace(/<\s*\/\s*(s|strike|del)\s*>/gi, save('</s>'))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');

  text = lrSigV8Esc(text);

  saved.forEach((html, i) => {
    text = text.replaceAll(`__LR_SIG_V8_${i}__`, html);
  });

  return text.trim();
}

function lrSigV8MarkdownToHtml(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';

  const saved = [];

  const save = (html) => {
    const key = `__LR_SIG_MD_V8_${saved.length}__`;
    saved.push(html);
    return key;
  };

  text = text.replace(/\*\*\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)\*\*/g, (_, label, url) => {
    return save(`<a href="${lrSigV8Attr(url)}"><b>${lrSigV8Esc(label)}</b></a>`);
  });

  text = text.replace(/\[\*\*([^\]]+?)\*\*\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
    return save(`<a href="${lrSigV8Attr(url)}"><b>${lrSigV8Esc(label)}</b></a>`);
  });

  text = text.replace(/\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
    return save(`<a href="${lrSigV8Attr(url)}">${lrSigV8Esc(label)}</a>`);
  });

  text = lrSigV8Esc(text);

  text = text
    .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+?)__/g, '<b>$1</b>')
    .replace(/\+\+([\s\S]+?)\+\+/g, '<u>$1</u>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^\w])_([^_\n]+?)_/g, '$1<i>$2</i>');

  saved.forEach((html, i) => {
    text = text.replaceAll(`__LR_SIG_MD_V8_${i}__`, html);
  });

  return text.trim();
}

function lrSigV8SignatureHtml(sigOrText) {
  if (!sigOrText) return '';

  const text = typeof sigOrText === 'object'
    ? String(sigOrText.text || '')
    : String(sigOrText || '');

  const format = typeof sigOrText === 'object'
    ? String(sigOrText.format || 'html').toLowerCase()
    : 'html';

  const markup = typeof sigOrText === 'object' && Array.isArray(sigOrText.markup)
    ? sigOrText.markup
    : [];

  if (!text.trim()) return '';

  if (markup.length) return applyMarkupToHtml(text, markup);
  if (format === 'html' || /<\/?(a|b|strong|i|em|u|ins|s|strike|del|code|blockquote)\b/i.test(lrSigV8Decode(text))) {
    return lrSigV8CleanHtml(text);
  }

  return lrSigV8MarkdownToHtml(text);
}


function lrSigV8SignaturePreview(sig) {
  return globalThis.__lrSigSaveSafeV11.preview(sig);
}
function signatureNoPreviewHtml(value) {
  return lrSigV8SignatureHtml(value);
}
// LR_AUTOSIG_HTML_V8_END

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function trackingToken(campaignId, channelId, url, label = '') {
  return sha256Hex(`${campaignId}|${channelId}|${url}|${label}`).slice(0, 18);
}

async function ensureAnalyticsLink({ campaignId, postId = null, channelId = null, targetUrl, label = '' }) {
  const token = trackingToken(campaignId, channelId, targetUrl, label);

  await query(
    `INSERT INTO analytics_links(token,campaign_id,post_id,channel_id,label,target_url,created_at)
     VALUES($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT(token) DO UPDATE SET
       campaign_id=EXCLUDED.campaign_id,
       post_id=COALESCE(EXCLUDED.post_id, analytics_links.post_id),
       channel_id=EXCLUDED.channel_id,
       label=EXCLUDED.label,
       target_url=EXCLUDED.target_url`,
    [token, String(campaignId), postId, channelId ? Number(channelId) : null, String(label || ''), String(targetUrl)]
  );

  return `${PUBLIC_BASE_URL}/r/${token}`;
}

async function rewriteAdHtmlLinks(draft, channelId, html) {
  let text = String(html || '');
  if (!draft?.isAd) return text;

  const campaignId = draft.campaignId || draft.reportGroupId || `lr-${Date.now()}`;

  const anchors = [];
  text = text.replace(/<a\b([^>]*?)href=(["'])(https?:\/\/[^"']+)\2([^>]*)>([\s\S]*?)<\/a>/gi, (full, before, quote, url, after, label) => {
    const marker = `___LR_ANCHOR_${anchors.length}___`;
    anchors.push({ marker, before, quote, url, after, label });
    return marker;
  });

  for (const a of anchors) {
    const tracked = await ensureAnalyticsLink({
      campaignId,
      postId: draft.postId || null,
      channelId,
      targetUrl: a.url,
      label: plain(a.label || 'ссылка'),
    });

    text = text.replace(
      a.marker,
      `<a${a.before}href="${attr(tracked)}"${a.after}>${a.label}</a>`
    );
  }

  text = await replaceBareAdUrls(draft, channelId, text);

  return text;
}

async function replaceBareAdUrls(draft, channelId, html) {
  const campaignId = draft.campaignId || draft.reportGroupId || `lr-${Date.now()}`;
  const pieces = [];
  let text = String(html || '');

  text = text.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/gi, (full, prefix, url) => {
    const cleanUrl = String(url).replace(/[),.;]+$/g, '');
    const tail = String(url).slice(cleanUrl.length);
    const marker = `___LR_URL_${pieces.length}___`;
    pieces.push({ marker, prefix, url: cleanUrl, tail });
    return `${prefix}${marker}${tail}`;
  });

  for (const item of pieces) {
    const tracked = await ensureAnalyticsLink({
      campaignId,
      postId: draft.postId || null,
      channelId,
      targetUrl: item.url,
      label: 'ссылка',
    });

    text = text.replace(item.marker, `<a href="${attr(tracked)}">ссылка</a>`);
  }

  return text;
}

function reqFingerprint(req, token) {
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '';
  const ua = req.headers['user-agent'] || '';
  return {
    ipHash: sha256Hex(String(ip).split(',')[0].trim()).slice(0, 32),
    userAgent: String(ua).slice(0, 400),
    fingerprint: sha256Hex(`${token}|${String(ip).split(',')[0].trim()}|${ua}`).slice(0, 40),
  };
}


const LR_PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.SITE_URL || process.env.WEBAPP_URL || 'https://linkray.ru').replace(/\/$/, '');

function lrSha256(value) {
  return lrCrypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function lrTrackingToken(campaignId, channelId, url, label = '') {
  return lrSha256(`${campaignId}|${channelId}|${url}|${label}`).slice(0, 18);
}

async function lrEnsureButtonAnalyticsLink({ campaignId, postId = null, channelId = null, targetUrl, label = '' }) {
  const token = lrTrackingToken(campaignId, channelId, targetUrl, label);

  await query(`CREATE TABLE IF NOT EXISTS analytics_links (
    token text PRIMARY KEY,
    campaign_id text NOT NULL,
    post_id integer,
    channel_id integer,
    label text,
    target_url text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

  await query(`ALTER TABLE analytics_links ADD COLUMN IF NOT EXISTS kind text`);

  await query(
    `INSERT INTO analytics_links(token,campaign_id,post_id,channel_id,label,target_url,kind,created_at)
     VALUES($1,$2,$3,$4,$5,$6,'button',now())
     ON CONFLICT(token) DO UPDATE SET
       campaign_id=EXCLUDED.campaign_id,
       post_id=COALESCE(EXCLUDED.post_id, analytics_links.post_id),
       channel_id=EXCLUDED.channel_id,
       label=EXCLUDED.label,
       target_url=EXCLUDED.target_url,
       kind='button'`,
    [token, String(campaignId), postId, channelId ? Number(channelId) : null, String(label || 'Кнопка'), String(targetUrl)]
  );

  return `${LR_PUBLIC_BASE_URL}/r/${token}`;
}


async function trackedButtonsForDraft(draft, channelId) {
  const originalRows = Array.isArray(draft?.buttons) ? draft.buttons : [];

  if (!draft?.isAd || !originalRows.length) {
    return originalRows;
  }

  await query(`CREATE TABLE IF NOT EXISTS analytics_links (
    token text PRIMARY KEY,
    campaign_id text NOT NULL,
    post_id integer,
    channel_id integer,
    label text,
    target_url text NOT NULL,
    kind text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});

  await query(`CREATE TABLE IF NOT EXISTS analytics_clicks (
    id bigserial PRIMARY KEY,
    token text NOT NULL REFERENCES analytics_links(token) ON DELETE CASCADE,
    campaign_id text NOT NULL,
    post_id integer,
    channel_id integer,
    fingerprint text NOT NULL,
    ip_hash text,
    user_agent text,
    clicked_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});

  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_lr_clicks_token_fingerprint
               ON analytics_clicks(token, fingerprint)`).catch(() => {});

  await query(`CREATE TABLE IF NOT EXISTS analytics_click_events (
    id bigserial PRIMARY KEY,
    token text NOT NULL REFERENCES analytics_links(token) ON DELETE CASCADE,
    campaign_id text NOT NULL,
    post_id integer,
    channel_id integer,
    fingerprint text,
    ip_hash text,
    user_agent text,
    clicked_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});

  const base = String(
    process.env.PUBLIC_BASE_URL ||
    process.env.SITE_URL ||
    process.env.WEBAPP_URL ||
    'https://linkray.ru'
  ).replace(/\/$/, '');

  const postId = Number(draft.postId || draft.id || 0) || null;

  const campaignId = String(
    postId ||
    draft.campaignId ||
    draft.reportGroupId ||
    lrCrypto.randomUUID()
  );

  draft.campaignId = campaignId;
  draft.reportGroupId = campaignId;
  const chId = Number(channelId || draft.channelIds?.[0] || 0) || null;

  const normalizeButton = (button, rowIndex, buttonIndex) => {
    const b = { ...(button || {}) };

    const title = String(
      b.title ||
      b.text ||
      b.label ||
      `Кнопка ${buttonIndex + 1}`
    ).trim();

    const targetUrl = String(
      b.originalUrl ||
      b.targetUrl ||
      b.url ||
      b.link ||
      b.href ||
      ''
    ).trim();

    if (!/^https?:\/\//i.test(targetUrl)) {
      return b;
    }

    if (targetUrl.includes('/r/') && targetUrl.includes('linkray.ru')) {
      return b;
    }

    const token = lrCrypto
      .createHash('sha256')
      .update([campaignId, postId || '', chId || '', rowIndex, buttonIndex, title, targetUrl].join('|'))
      .digest('base64url')
      .slice(0, 28);

    const trackedUrl = `${base}/r/${token}`;

    b.title = title;
    b.text = b.text || title;
    b.label = b.label || title;
    b.originalUrl = targetUrl;
    b.targetUrl = targetUrl;
    b.url = trackedUrl;
    b.link = trackedUrl;
    b.href = trackedUrl;

    return {
      button: b,
      analytics: {
        token,
        campaignId,
        postId,
        channelId: chId,
        label: title,
        targetUrl,
      }
    };
  };

  const out = [];
  const analytics = [];

  for (let rowIndex = 0; rowIndex < originalRows.length; rowIndex += 1) {
    const row = originalRows[rowIndex];

    if (Array.isArray(row)) {
      const newRow = [];

      for (let buttonIndex = 0; buttonIndex < row.length; buttonIndex += 1) {
        const result = normalizeButton(row[buttonIndex], rowIndex, buttonIndex);
        newRow.push(result.button || result);

        if (result.analytics) analytics.push(result.analytics);
      }

      out.push(newRow);
    } else {
      const result = normalizeButton(row, rowIndex, 0);
      out.push(result.button || result);

      if (result.analytics) analytics.push(result.analytics);
    }
  }

  for (const item of analytics) {
    await query(
      `INSERT INTO analytics_links(token,campaign_id,post_id,channel_id,label,target_url,kind)
       VALUES($1,$2,$3,$4,$5,$6,'button')
       ON CONFLICT(token) DO UPDATE SET
         campaign_id=EXCLUDED.campaign_id,
         post_id=EXCLUDED.post_id,
         channel_id=EXCLUDED.channel_id,
         label=EXCLUDED.label,
         target_url=EXCLUDED.target_url,
         kind='button'`,
      [item.token, item.campaignId, item.postId, item.channelId, item.label, item.targetUrl]
    );
  }

  draft.buttons = out;

  return out;
}



async function composePostForChannel(draft, channelId) {
  let text = String(draft.content?.text || '');

  if (draft.isAd) {
    if (!draft.campaignId) {
      draft.campaignId = draft.reportGroupId || `lr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    }

    const buttons = await trackedButtonsForDraft(draft, channelId);

    return {
      text,
      format: 'html',
      attachments: finalAttachments({ ...draft, buttons }),
    };
  }

  if (!draft.isAd && draft.signatureEnabled !== false && typeof loadSignature === 'function') {
    const sig = await loadSignature(channelId);

    if (sig?.text) {
      const cleanSignature = typeof signatureNoPreviewHtml === 'function'
        ? globalThis.__lrRichV7.signatureForPost(sig.text, ((typeof format !== 'undefined' && format) || (typeof content !== 'undefined' && content?.format) || (typeof draft !== 'undefined' && draft?.content?.format) || 'html'))
        : sig.text;

      text = `${text}\n\n${cleanSignature}`;
    }
  }

  return {
    text,
    format: 'html',
    attachments: finalAttachments(draft),
  };
}
function makeDraftFromPost(row) { return { ...emptyDraft(), channelIds: [Number(row.channel_id)], content: { text: row.text || '', format: row.format || 'html', attachments: safeJson(row.attachments, []), markup: [], raw: null }, buttons: safeJson(row.buttons, []), isAd: Boolean(row.is_ad), cpm: row.cpm ? Number(row.cpm) : null, autoDeleteMinutes: row.auto_delete_minutes || null, reportAfterHours: row.report_after_hours || 24, signatureEnabled: !row.is_ad, postId: Number(row.id), publishedMessageId: row.published_message_id || null, status: row.status || 'scheduled' }; }

function mainMenuRows() { return [[callbackButton('🧬 LinkRay Studio', 'main:posting')],[callbackButton('🔗 Добавить канал', 'post:add_channel')],[callbackButton('📊 Отчёты', 'reports:menu'), callbackButton('🛡 Антифрод', 'fraud:menu')]]; }
async function showMainCallback(callbackId) { await cb(callbackId, `━━━━━━━━━━━━━━\n🛡 <b>LinkRay</b>\n\nСтудия публикаций, очередь постов и рекламные отчёты для MAX.\n\nВыберите действие.\n━━━━━━━━━━━━━━`, mainMenuRows()); }
async function sendMain(chatId) { await msg(chatId, `━━━━━━━━━━━━━━\n🛡 <b>LinkRay</b>\n\nСтудия публикаций, очередь постов и рекламные отчёты для MAX.\n\nВыберите действие.\n━━━━━━━━━━━━━━`, mainMenuRows()); }
function studioRows() { return [[callbackButton('🧩 Собрать пост', 'post:create')],[callbackButton('🗂 Посты', 'post:all')],[callbackButton('🏷 Автоподписи', 'sig:menu')],[callbackButton('🔗 Добавить канал', 'post:add_channel')],[callbackButton('⬅️ В меню', 'main:menu')]]; }
async function showStudio(callbackId) { await cb(callbackId, `━━━━━━━━━━━━━━\n🧬 <b>LinkRay Studio</b>\n\nСобирайте посты, планируйте публикации и управляйте рекламными размещениями.\n━━━━━━━━━━━━━━`, studioRows()); }
async function sendStudio(chatId) { await msg(chatId, `━━━━━━━━━━━━━━\n🧬 <b>LinkRay Studio</b>\n\nВыберите действие.\n━━━━━━━━━━━━━━`, studioRows()); }

async function showChannelSelect(callbackId, key, draft, multi = false) {
  const channels = await getChannels();
  if (!channels.length) {
    await cb(callbackId, `━━━━━━━━━━━━━━\n🔗 <b>Подключить канал</b>\n\n1. Откройте канал в MAX.\n2. Добавьте LinkRay в администраторы.\n3. Выдайте право публикации.\n4. Вернитесь и откройте «Каналы».\n━━━━━━━━━━━━━━`, [[callbackButton('🔗 Добавить канал', 'post:add_channel')],[callbackButton('⬅️ В Studio', 'main:posting')]]);
    return;
  }
  const rows = [];
  for (const ch of channels) {
    const selected = draft.channelIds.includes(Number(ch.id));
    rows.push([callbackButton(`${selected ? '✅' : '📡'} ${channelName(ch)}`, multi ? `post:toggle:${ch.id}` : `post:single:${ch.id}`)]);
  }
  rows.push([callbackButton('🧩 Выбрать несколько', 'post:multi'), callbackButton('🌐 Все каналы', 'post:all_channels')]);
  if (multi) rows.push([callbackButton('➡️ Далее', 'post:channels_next')]);
  rows.push([callbackButton('🔗 Добавить канал', 'post:add_channel')],[callbackButton('⬅️ Назад', 'main:posting'), callbackButton('❌ Отмена', 'post:cancel')]);
  await setSession(key, multi ? 'select_channels_multi' : 'select_channels', { draft });
  await cb(callbackId, `━━━━━━━━━━━━━━\n📡 <b>Куда выпустить пост?</b>\n\n${hasContent(draft) ? 'Материал уже принят. Выберите канал.' : 'Выберите канал, затем отправьте пост.'}\n━━━━━━━━━━━━━━`, rows);
}
async function askContent(callbackId, key, draft) { await setSession(key, 'wait_post_content', { draft }); const channels = await getChannelsByIds(draft.channelIds); await cb(callbackId, `━━━━━━━━━━━━━━\n📨 <b>Отправьте пост</b>\n\nКаналы:\n${channelsLines(channels)}\n\nМожно отправить текст, фото, видео, файл или пересланный пост.\n━━━━━━━━━━━━━━`, [[callbackButton('⬅️ К каналам', 'post:change_channels')],[callbackButton('❌ Отмена', 'post:cancel')]]); }
function editorMenuRows(draft) {
  const rows = [
    [callbackButton('✏️ Изменить текст', 'editor:text'), callbackButton('🖼 Медиа', 'editor:media')],
    [callbackButton('🔘 Добавить кнопку', 'editor:button'), callbackButton('🏷 Автоподпись', 'editor:signature')],
    [callbackButton(draft.isAd ? '✅ Рекламный пост' : '💼 Рекламный пост', 'editor:ad')],
  ];
  if (draft.isAd) rows.push([callbackButton(draft.cpm ? `💰 CPM ${draft.cpm} ₽` : '💰 CPM не указан', 'editor:cpm')]);
  rows.push(
    [callbackButton(draft.postId ? '💾 Сохранить пост' : '➡️ Далее', draft.postId ? 'editor:save' : 'editor:next')],
    [callbackButton('⬅️ Назад', 'post:change_channels'), callbackButton('❌ Отмена', 'post:cancel')],
  );
  return rows;
}

function editorMenuText() {
  return `━━━━━━━━━━━━━━
🧬 <b>Редактор LinkRay</b>

Пост-превью находится выше.
При изменении текста, медиа, кнопок или автоподписи превью будет обновляться.

Настройте оформление.
━━━━━━━━━━━━━━`;
}

async function showEditor(callbackId, key, draft) {
  if (hasContent(draft) && Number(key)) {
    const mid = await sendDraftPreview(Number(key), draft);
    if (mid) draft.previewMessageId = mid;
  }
  await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });
  await cb(callbackId, editorMenuText(), editorMenuRows(draft));
}

async function sendDraftPreview(chatId, draft) {
  try {
    const content = await composePostForChannel(draft, draft.channelIds[0]);
    if (draft.previewMessageId) {
      try { await editMaxMessage(draft.previewMessageId, content); return draft.previewMessageId; }
      catch (editError) { console.error('[preview edit failed, sending new]', editError.message || editError); }
    }
    const sent = await sendMaxMessage({ chatId, ...content });
    return extractMessageId(sent);
  } catch (e) {
    console.error('[preview]', e.message || e);
    await msg(chatId, `⚠️ Не удалось вывести превью: ${escapeHtml(e.message || e)}\n\n${escapeHtml(short(draft.content.text, 900))}`, [], 'html');
    return null;
  }
}


function parseDuration(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw || raw === 'нет' || raw === 'без' || raw === '0' || raw === 'без удаления') return null;

  const hm = raw.match(/^(\d{1,3})\s*:\s*(\d{1,2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);

  const h = raw.match(/^(\d+(?:[.,]\d+)?)\s*(ч|час|часа|часов|h)$/);
  if (h) return Math.round(Number(h[1].replace(',', '.')) * 60);

  const d = raw.match(/^(\d+(?:[.,]\d+)?)\s*(д|дн|день|дня|дней|d)$/);
  if (d) return Math.round(Number(d[1].replace(',', '.')) * 1440);

  const n = raw.match(/^(\d+)$/);
  if (n) {
    const value = Number(n[1]);
    if (value >= 1 && value <= 72) return value * 60;
    return value;
  }

  return undefined;
}
function parseSchedule(input) {
  const raw = String(input || '').trim().toLowerCase(); const now = mskDate(new Date());
  let m = raw.match(/^через\s+(\d+)\s*(мин|минут|минуту|минуты)$/); if (m) { const d = new Date(); d.setMinutes(d.getMinutes()+Number(m[1])); return d; }
  m = raw.match(/^через\s+(\d+)\s*(ч|час|часа|часов)$/); if (m) { const d = new Date(); d.setHours(d.getHours()+Number(m[1])); return d; }
  m = raw.match(/^завтра\s+(\d{1,2})[:\s](\d{2})$/); if (m) { const d = new Date(now); d.setDate(d.getDate()+1); d.setHours(Number(m[1]), Number(m[2]), 0, 0); return d; }
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/); if (m) return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  m = raw.match(/^(\d{1,2})[:\s](\d{2})$/); if (m) { const d = new Date(now); d.setHours(Number(m[1]), Number(m[2]), 0, 0); if (d.getTime() <= now.getTime()) d.setDate(d.getDate()+1); return d; }
  m = raw.match(/^(\d{2})(\d{2})$/); if (m) { const d = new Date(now); d.setHours(Number(m[1]), Number(m[2]), 0, 0); if (d.getTime() <= now.getTime()) d.setDate(d.getDate()+1); return d; }
  return null;
}
async function showPublishMenu(callbackId, key, draft) {
  await setSession(key, 'publish_menu', { draft });
  const channels = await getChannelsByIds(draft.channelIds);
  const rows = [
    ...autoDeleteRows('publish'),
    [callbackButton('📅 Календарь', 'schedule:calendar'), callbackButton('✍️ Ввести время', 'schedule:manual')],
    [callbackButton('⚡ Опубликовать сейчас', 'publish:now')],
    [callbackButton('⬅️ В редактор', 'editor:back'), callbackButton('❌ Отмена', 'post:cancel')],
  ];
  await cb(callbackId, `━━━━━━━━━━━━━━
🚀 <b>К выпуску</b>

📡 Каналы:
${channelsLines(channels)}

🗑 Автоудаление: ${formatAutoDelete(draft.autoDeleteMinutes)}
${draft.isAd ? `💼 Реклама: да · CPM ${draft.cpm || 'не указан'} ₽
📊 Отчёт: через 24ч` : 'Реклама: нет'}

Выберите срок автоудаления кнопками или способ публикации.
━━━━━━━━━━━━━━`, rows);
}
async function scheduleDraft(draft, key, publishAt) {
  if (!draft.campaignId) draft.campaignId = `lr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  if (draft.isAd && !draft.autoDeleteMinutes) draft.autoDeleteMinutes = 2880;
  const ids = [];
  for (const channelId of draft.channelIds) {
    const content = await composePostForChannel(draft, channelId);
    const r = await query(`INSERT INTO scheduled_posts(channel_id,text,format,publish_at,status,notify,created_by_max_user_id,attachments,buttons,draft,is_ad,cpm,auto_delete_minutes,report_after_hours,report_group_id,updated_at) VALUES($1,$2,$3,$4,'scheduled',false,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,now()) RETURNING id`, [channelId, content.text, content.format, publishAt, String(key), JSON.stringify(normalizeAttachments(draft.content.attachments)), JSON.stringify(draft.buttons || []), JSON.stringify(draft), Boolean(draft.isAd), draft.cpm, draft.autoDeleteMinutes, draft.reportAfterHours || 24, draft.campaignId]);
    ids.push(r[0].id);
  }
  return ids;
}
function extractMessageId(res) { return res?.message?.body?.mid || res?.message?.id || res?.message_id || res?.messageId || res?.id || res?.mid || null; }
async function publishDraftNow(draft, key) {
  if (!draft.campaignId) draft.campaignId = `lr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  if (draft.isAd && !draft.autoDeleteMinutes) draft.autoDeleteMinutes = 2880;
  const results = [];
  for (const channel of await getChannelsByIds(draft.channelIds)) {
    try {
      const content = await composePostForChannel(draft, channel.id);
      const sent = await sendMaxMessage({ chatId: channel.max_chat_id, ...content });
      const messageId = extractMessageId(sent);
      const r = await query(`INSERT INTO scheduled_posts(channel_id,text,format,publish_at,status,notify,created_by_max_user_id,attachments,buttons,draft,is_ad,cpm,auto_delete_minutes,report_after_hours,report_group_id,published_at,published_message_id,updated_at) VALUES($1,$2,$3,now(),'published',false,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,now(),$13,now()) RETURNING id`, [channel.id, content.text, content.format, String(key), JSON.stringify(normalizeAttachments(draft.content.attachments)), JSON.stringify(draft.buttons || []), JSON.stringify(draft), Boolean(draft.isAd), draft.cpm, draft.autoDeleteMinutes, draft.reportAfterHours || 24, draft.campaignId, messageId]);
      results.push({ ok: true, channel, id: r[0].id, messageId });
    } catch (e) {
      console.error('[publish now]', e.message || e);
      results.push({ ok: false, channel, error: e.message || String(e) });
    }
  }
  return results;
}
async function afterPlanned(chatId, draft, publishAt, ids) {
  const channels = await getChannelsByIds(draft.channelIds);
  const d = parseDbDate(publishAt);
  if (draft.isAd) {
    await msg(chatId, `━━━━━━━━━━━━━━
✅ <b>Рекламный пост запланирован</b>

📝 Сообщение «${escapeHtml(short(draft.content.text, 80))}»
📅 ${dateText(d)}
🕒 ${timeText(d)} МСК

📣 Каналы:
${channelsLines(channels)}

💼 CPM: ${draft.cpm || 'не указан'} ₽
🗑 Автоудаление: ${formatAutoDelete(draft.autoDeleteMinutes)}
📊 Отчёт: через 24ч
🔗 Страница отчёта: <a href="${reportUrl(draft.campaignId)}">LinkRay Analytics</a>

Пост добавлен в очередь <a href="${BOT_LINK}">LinkRay</a>.
━━━━━━━━━━━━━━`, [[callbackButton('🧩 Собрать ещё пост', 'post:create')],[callbackButton('🗂 Посты', 'post:all')],[callbackButton('🏠 В меню', 'main:menu')]]);
  } else {
    await msg(chatId, `━━━━━━━━━━━━━━
✅ <b>Публикация запланирована</b>

📅 ${dateText(d)}
🕒 ${timeText(d)} МСК

📣 Каналы:
${channelsLines(channels)}

🗑 Автоудаление: ${formatAutoDelete(draft.autoDeleteMinutes)}
Пост добавлен в очередь.
━━━━━━━━━━━━━━`, [[callbackButton('🧩 Собрать ещё пост', 'post:create')],[callbackButton('🗂 Посты', 'post:all')],[callbackButton('🏠 В меню', 'main:menu')]]);
  }
  await sendMain(chatId);
}
async function afterPublished(chatId, draft, results) {
  if (draft.isAd) {
    await msg(chatId, `━━━━━━━━━━━━━━
✅ <b>Рекламный пост опубликован</b>

Каналов: ${results.filter(r=>r.ok).length}/${results.length}
💼 CPM: ${draft.cpm || 'не указан'} ₽
🗑 Автоудаление: ${formatAutoDelete(draft.autoDeleteMinutes)}
📊 Отчёт придёт через 24ч
🔗 Страница отчёта: <a href="${reportUrl(draft.campaignId)}">LinkRay Analytics</a>
━━━━━━━━━━━━━━`, [[callbackButton('📊 Открыть отчёт', `report:open:${draft.campaignId}`)],[callbackButton('🗂 Посты','post:all')],[callbackButton('🏠 В меню','main:menu')]]);
  } else {
    await msg(chatId, `✅ Пост опубликован.
Успешно: ${results.filter(r=>r.ok).length}/${results.length}`, [[callbackButton('🗂 Посты','post:all')],[callbackButton('🏠 В меню','main:menu')]]);
  }
  await sendMain(chatId);
}

async function postsForDay(mode = 'all', day = null, channelId = null) {
  const safeDay = day || dateKey();
  const where = [
    "sp.status::text IN ('scheduled','published')",
    `(sp.publish_at AT TIME ZONE '${MSK_TZ}')::date = $1::date`,
  ];
  const params = [safeDay];
  if (mode === 'scheduled') where.push("sp.status::text = 'scheduled'");
  if (mode === 'published') where.push("sp.status::text = 'published'");
  if (channelId) { params.push(Number(channelId)); where.push(`sp.channel_id = $${params.length}`); }
  return query(`SELECT sp.*, c.title AS channel_title, c.link AS channel_link, c.max_chat_id FROM scheduled_posts sp LEFT JOIN channels c ON c.id = sp.channel_id WHERE ${where.join(' AND ')} ORDER BY sp.publish_at ASC NULLS LAST, sp.id ASC`, params);
}

async function countsForDay(day, channelId = null) {
  const safeDay = day || dateKey();
  const where = [
    "sp.status::text IN ('scheduled','published')",
    `(sp.publish_at AT TIME ZONE '${MSK_TZ}')::date = $1::date`,
  ];
  const params = [safeDay];
  if (channelId) { params.push(Number(channelId)); where.push(`sp.channel_id = $${params.length}`); }
  const r = await query(`SELECT COUNT(*)::int AS all_count, COUNT(*) FILTER (WHERE sp.status::text = 'scheduled')::int AS scheduled_count, COUNT(*) FILTER (WHERE sp.status::text = 'published')::int AS published_count FROM scheduled_posts sp WHERE ${where.join(' AND ')}`, params);
  return { all: Number(r[0]?.all_count || 0), scheduled: Number(r[0]?.scheduled_count || 0), published: Number(r[0]?.published_count || 0) };
}

async function defaultPostDay(mode = 'all') {
  const where = ["status::text IN ('scheduled','published')", "publish_at IS NOT NULL"];
  if (mode === 'scheduled') where.push("status::text = 'scheduled'");
  if (mode === 'published') where.push("status::text = 'published'");
  const r = await query(`SELECT (publish_at AT TIME ZONE '${MSK_TZ}')::date::text AS day_key FROM scheduled_posts WHERE ${where.join(' AND ')} ORDER BY publish_at DESC NULLS LAST, id DESC LIMIT 1`);
  return r[0]?.day_key || dateKey();
}

function filterPayload(mode, day, channelId = 0) { return `post:filter:${mode}:${day}:${channelId || 0}`; }
function postButtonText(p) { const icon = p.status === 'published' ? '📌' : '⏳'; const ad = p.is_ad ? '💼 ' : ''; const media = safeJson(p.attachments, []).length ? '🖼 ' : ''; return `${ad}${icon} ${timeText(parseDbDate(p.publish_at))} · ${media}${short(p.text, 34)}`; }
async function buildPostsView(mode = 'all', day = null, channelId = null) {
  const safeMode = ['all','scheduled','published'].includes(mode) ? mode : 'all';
  const safeDay = day || await defaultPostDay(safeMode);
  const posts = await postsForDay(safeMode, safeDay, channelId);
  const counts = await countsForDay(safeDay, channelId);
  const rows = posts.map(p => [callbackButton(postButtonText(p), `post:open:${p.id}`)]);
  if (!rows.length) rows.push([callbackButton('Постов в этот день нет', 'noop')]);
  rows.push([callbackButton(safeMode==='scheduled'?'🔴 Отложенные':'⏳ Отложенные', filterPayload('scheduled', safeDay, channelId)), callbackButton(safeMode==='published'?'🔴 Опубликованные':'Опубликованные', filterPayload('published', safeDay, channelId))]);
  rows.push([callbackButton(safeMode==='all'?'🔴 Все посты':'📋 Все посты', filterPayload('all', safeDay, channelId))]);
  rows.push([callbackButton('⬅️ День', filterPayload(safeMode, shiftDay(safeDay,-1), channelId)), callbackButton(`📅 ${dateButtonText(keyToDate(safeDay))}`, 'noop'), callbackButton('День ➡️', filterPayload(safeMode, shiftDay(safeDay,1), channelId))]);
  rows.push([callbackButton('📡 По каналам', 'post:channels')],[callbackButton('⬅️ В Studio', 'main:posting')]);

  const title = channelId ? escapeHtml(channelName(await getChannel(channelId))) : 'Все каналы';
  const text = `━━━━━━━━━━━━━━
🗂 <b>Посты</b>

📣 <b>${title}</b>
📅 ${dateText(keyToDate(safeDay))}

Фильтр: <b>${safeMode === 'scheduled' ? 'отложенные' : safeMode === 'published' ? 'опубликованные' : 'все посты'}</b>

📋 Всего за день: ${counts.all}
⏳ Отложено: ${counts.scheduled}
📌 Опубликовано: ${counts.published}
👁 Показано: ${posts.length}${posts.length ? '' : '\n\nПостов в этот день нет. Листайте дни стрелками ниже.'}

Нажмите на пост, чтобы открыть управление.
━━━━━━━━━━━━━━`;

  return { text, rows, safeMode, safeDay, posts, counts };
}
async function showPosts(callbackId, mode = 'all', day = null, channelId = null, chatId = null) {
  const view = await buildPostsView(mode, day, channelId);
  return cbOrMsg(callbackId, chatId, view.text, view.rows);
}
async function sendPosts(chatId, mode = 'all', day = null, channelId = null) {
  const view = await buildPostsView(mode, day, channelId);
  return msg(chatId, view.text, view.rows);
}
async function showPostChannels(callbackId, chatId = null) { const channels = await getChannels(); const day = await defaultPostDay('all'); const rows = [[callbackButton('🌐 Все каналы', filterPayload('all', day, 0))]]; for (const c of channels) rows.push([callbackButton(`📡 ${channelName(c)}`, filterPayload('all', day, c.id))]); rows.push([callbackButton('⬅️ К постам', filterPayload('all', day, 0))]); await cbOrMsg(callbackId, chatId, `━━━━━━━━━━━━━━\n📡 <b>Посты по каналам</b>\n\nВыберите канал.\n━━━━━━━━━━━━━━`, rows); }
async function getPost(id) { const r = await query(`SELECT sp.*, c.title AS channel_title, c.link AS channel_link, c.max_chat_id FROM scheduled_posts sp LEFT JOIN channels c ON c.id=sp.channel_id WHERE sp.id=$1`, [Number(id)]); return r[0] || null; }
function postChannelObj(p) { return { id: p.channel_id, title: p.channel_title, link: p.channel_link, max_chat_id: p.max_chat_id }; }
function postPreviewDraft(p) { return { ...emptyDraft(), channelIds: [p.channel_id], content: { text: p.text || '', format: p.format || 'html', attachments: safeJson(p.attachments, []), markup: [] }, buttons: safeJson(p.buttons, []), isAd: Boolean(p.is_ad), cpm: p.cpm ? Number(p.cpm) : null, autoDeleteMinutes: p.auto_delete_minutes, reportAfterHours: p.report_after_hours || 24, signatureEnabled: false }; }
function olderThan24(p) { return p.status === 'published' && Date.now() - parseDbDate(p.published_at || p.publish_at).getTime() > 24*60*60*1000; }
function postMenuText(p) { const d = parseDbDate(p.published_at || p.publish_at); const ch = postChannelObj(p); if (olderThan24(p)) return `━━━━━━━━━━━━━━\n🔒 <b>Пост #${p.id}</b>\n\n↑ Пост находится над этим сообщением ↑\n\n🕒 <b>Опубликован:</b> ${dateTimeText(d)}\n📌 <b>Статус:</b> опубликован\n🗑 <b>Автоудаление:</b> ${formatAutoDelete(p.auto_delete_minutes)}\n\n<b>Канал:</b>\n${channelLine(ch)}\n\nРедактирование недоступно: прошло больше 24 часов.\n━━━━━━━━━━━━━━`; if (p.status === 'published') return `━━━━━━━━━━━━━━\n${p.is_ad ? '💼 <b>Рекламный пост</b>' : '📄 <b>Пост</b>'} #${p.id}\n\n↑ Пост находится над этим сообщением ↑\n\n🕒 <b>Опубликован:</b> ${dateTimeText(d)}\n📌 <b>Статус:</b> опубликован\n🗑 <b>Автоудаление:</b> ${formatAutoDelete(p.auto_delete_minutes)}\n${p.is_ad ? `💰 <b>CPM:</b> ${p.cpm || 'не указан'} ₽\n` : ''}\n<b>Канал:</b>\n${channelLine(ch)}\n━━━━━━━━━━━━━━`; return `━━━━━━━━━━━━━━\n${p.is_ad ? '💼 <b>Рекламный пост</b>' : '📄 <b>Пост</b>'} #${p.id}\n\n↑ Пост находится над этим сообщением ↑\n\n🕒 <b>Время:</b> ${dateTimeText(d)}\n⏳ <b>Статус:</b> ожидает публикации\n🗑 <b>Автоудаление:</b> ${formatAutoDelete(p.auto_delete_minutes)}\n\nПост будет опубликован в канал:\n${channelLine(ch)}\n━━━━━━━━━━━━━━`; }
function postMenuRows(p) {
  const back = filterPayload(p.status === 'published' ? 'published' : 'scheduled', dateKey(parseDbDate(p.publish_at)), p.channel_id);
  if (olderThan24(p)) return [[callbackButton('⬅️ Назад', back)]];
  if (p.status === 'published') return [
    [callbackButton('✏️ Перейти в редактор', `post:editor:${p.id}`)],
    [callbackButton(`🗑 Удаление: ${formatAutoDelete(p.auto_delete_minutes)}`, `post:auto:${p.id}`)],
    [callbackButton('❌ Удалить из канала', `post:delete_confirm:${p.id}`)],
    [callbackButton('⬅️ Назад', back)],
  ];
  return [
    [callbackButton('✏️ Перейти в редактор', `post:editor:${p.id}`)],
    [callbackButton('↪️ Изменить время', `post:time:${p.id}`)],
    [callbackButton(`🗑 Удаление: ${formatAutoDelete(p.auto_delete_minutes)}`, `post:auto:${p.id}`)],
    [callbackButton('🚀 Опубликовать сейчас', `post:now:${p.id}`)],
    [callbackButton('❌ Удалить', `post:delete_confirm:${p.id}`)],
    [callbackButton('⬅️ Назад', back)],
  ];
}
function postAutoRows(postId) { return [[callbackButton('24', `post:auto_set:${postId}:1440`), callbackButton('48', `post:auto_set:${postId}:2880`), callbackButton('72', `post:auto_set:${postId}:4320`)],[callbackButton('Без удаления', `post:auto_set:${postId}:0`)],[callbackButton('✍️ Ввести вручную', `post:auto_manual:${postId}`)],[callbackButton('⬅️ Назад', `post:open:${postId}`)]]; }

async function openPost(callbackId, chatId, id) { const p = await getPost(id); if (!p) { await cb(callbackId, 'Пост не найден.', [[callbackButton('⬅️ К постам','post:all')]]); return; } await answerCallback({ callbackId, notification: 'Открываю пост...' }).catch(()=>{}); try { const d = postPreviewDraft(p); await sendMaxMessage({ chatId, text: p.text || '', format: p.format || 'html', attachments: finalAttachments(d) }); await msg(chatId, postMenuText(p), postMenuRows(p)); } catch (e) { console.error('[open post]', e.message || e); await cb(callbackId, `${postMenuText(p)}\n\n⚠️ Пост не удалось вывести отдельно: ${escapeHtml(e.message || e)}`, postMenuRows(p)); } }
async function editExisting(callbackId, key, id) { const p = await getPost(id); if (!p) return cb(callbackId, 'Пост не найден.', [[callbackButton('⬅️ К постам','post:all')]]); if (olderThan24(p)) return cb(callbackId, '🔒 Редактирование недоступно: прошло больше 24 часов.', [[callbackButton('⬅️ Назад', `post:open:${id}`)]]); const draft = makeDraftFromPost(p); await showEditor(callbackId, key, draft); }
async function saveExisting(callbackId, key, draft) { const post = await getPost(draft.postId); if (!post) return cb(callbackId, 'Пост не найден.', [[callbackButton('⬅️ К постам','post:all')]]); const content = await composePostForChannel(draft, draft.channelIds[0]); await query(`UPDATE scheduled_posts SET text=$2, format=$3, attachments=$4::jsonb, buttons=$5::jsonb, draft=$6::jsonb, is_ad=$7, cpm=$8, auto_delete_minutes=$9, report_after_hours=$10, updated_at=now() WHERE id=$1`, [draft.postId, content.text, content.format, JSON.stringify(normalizeAttachments(draft.content.attachments)), JSON.stringify(draft.buttons || []), JSON.stringify(draft), Boolean(draft.isAd), draft.cpm, draft.autoDeleteMinutes, draft.reportAfterHours || 24]); let warn = ''; if (post.status === 'published' && post.published_message_id) { try { await editMaxMessage(post.published_message_id, content); } catch(e) { warn = `\n\n⚠️ В базе сохранено, но MAX не обновил сообщение: ${escapeHtml(e.message || e)}`; } } await clearSession(key); await cb(callbackId, `━━━━━━━━━━━━━━\n✅ <b>Пост сохранён</b>${warn}\n━━━━━━━━━━━━━━`, [[callbackButton('👁 Открыть пост', `post:open:${draft.postId}`)],[callbackButton('🗂 Посты','post:all')]]); }

async function handleCallback(update) {
  __lrStartChannelDbSyncTimer();
  __lrStartChannelDbSyncTimer();
  if (await __lrShouldIgnoreInboundChannelUpdate(update)) return;
  const callbackId = getCallbackId(update); const payload = getCallbackPayload(update); const key = getSessionKey(update); const chatId = Number(getChatId(update) || key);
  await __lrRememberPrivateChatId(chatId);
  await __lrNotifyNewChannels(chatId);

  await __lrRememberPrivateChatId(chatId);
  await __lrNotifyNewChannels(chatId);

  log('callback', { payload, key });
  if (!callbackId) return;
  if (payload === 'noop') return;
  if (payload === 'main:menu') return showMainCallback(callbackId);
  if (payload === 'main:posting') return showStudio(callbackId);
  if (payload === 'post:add_channel') return showChannels(callbackId, chatId);
  if (payload === 'reports:menu') return cb(callbackId, '📊 Отчёты скоро будут здесь.', [[callbackButton('⬅️ В меню','main:menu')]]);
  if (payload === 'fraud:menu') return cb(callbackId, '🛡 Антифрод скоро будет здесь.', [[callbackButton('⬅️ В меню','main:menu')]]);
  if (payload === 'post:cancel') { await clearSession(key); return cb(callbackId, '❌ Действие отменено.', [[callbackButton('🏠 В меню','main:menu')]]); }
  if (payload === 'post:create') { const draft = emptyDraft(); return showChannelSelect(callbackId, key, draft, false); }
  if (payload === 'post:multi') { const s = await getSession(key); return showChannelSelect(callbackId, key, safeDraft(s.data), true); }
  if (payload.startsWith('post:toggle:')) { const id = Number(payload.split(':')[2]); const s = await getSession(key); const draft = safeDraft(s.data); const set = new Set(draft.channelIds); set.has(id) ? set.delete(id) : set.add(id); draft.channelIds = [...set]; return showChannelSelect(callbackId, key, draft, true); }
  if (payload.startsWith('post:single:')) { const id = Number(payload.split(':')[2]); const s = await getSession(key); const draft = safeDraft(s.data); draft.channelIds = [id]; if (hasContent(draft)) { await answerCallback({ callbackId, notification: 'Открываю редактор...' }).catch(()=>{}); return sendEditorAsNew(chatId, key, draft); } return askContent(callbackId, key, draft); }
  if (payload === 'post:all_channels') { const s = await getSession(key); const draft = safeDraft(s.data); draft.channelIds = (await getChannels()).map(c=>Number(c.id)); if (hasContent(draft)) { await answerCallback({ callbackId, notification: 'Открываю редактор...' }).catch(()=>{}); return sendEditorAsNew(chatId, key, draft); } return askContent(callbackId, key, draft); }
  if (payload === 'post:channels_next') { const s = await getSession(key); const draft = safeDraft(s.data); if (!draft.channelIds.length) return cb(callbackId, 'Выберите хотя бы один канал.', [[callbackButton('⬅️ Назад','post:multi')]]); if (hasContent(draft)) { await answerCallback({ callbackId, notification: 'Открываю редактор...' }).catch(()=>{}); return sendEditorAsNew(chatId, key, draft); } return askContent(callbackId, key, draft); }
  if (payload === 'post:change_channels') { const s = await getSession(key); return showChannelSelect(callbackId, key, safeDraft(s.data), false); }
  if (payload === 'post:add_channel') return cb(callbackId, `━━━━━━━━━━━━━━\n🔗 <b>Подключить канал</b>\n\n1. Откройте канал в MAX.\n2. Добавьте LinkRay в администраторы.\n3. Выдайте право публикации.\n4. Вернитесь и нажмите «Мои каналы».\n━━━━━━━━━━━━━━`, [[callbackButton('🔗 Добавить канал', 'post:add_channel')],[callbackButton('⬅️ Назад','post:create')]]);
  if (payload === 'editor:text') { const s = await getSession(key); await setSession(key, 'wait_edit_text', s.data); return cb(callbackId, '✏️ Отправьте новый текст поста. Форматирование MAX сохранится.', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:media') { const s = await getSession(key); await setSession(key, 'wait_edit_media', s.data); return cb(callbackId, '🖼 Отправьте новое фото, видео или файл.', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:button') { const s = await getSession(key); await setSession(key, 'wait_button', s.data); return cb(callbackId, '🔘 Формат кнопки:\n<code>Название - https://site.ru</code>\nНесколько в строке через |', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:signature') { const s = await getSession(key); const draft = safeDraft(s.data); if (draft.isAd) return cb(callbackId, '💼 Для рекламного поста автоподпись не добавляется.', [[callbackButton('⬅️ В редактор','editor:back')]]); const channelId = draft.channelIds[0]; const sig = channelId ? await loadSignature(channelId) : null; const rows = [[callbackButton('✏️ Заменить подпись','sig:add')],[callbackButton(sig?.is_active ? '🚫 Выключить' : '✅ Включить', 'sig:toggle')],[callbackButton('⬅️ В редактор','editor:back')]]; return cb(callbackId, `━━━━━━━━━━━━━━\n🏷 <b>Автоподпись</b>\n\nСтатус: ${sig?.is_active ? 'включена' : 'выключена'}\n\n${sig?.text ? globalThis.__lrSigSaveSafeV11.preview(sig) : 'Подпись не создана.'}\n━━━━━━━━━━━━━━`, rows); }
  if (payload === 'sig:add') { const s = await getSession(key); await setSession(key, 'wait_signature', s.data); return cb(callbackId, '🏷 Отправьте подпись. Ссылки, жирный, курсив и подчёркивание MAX сохранятся.', [[callbackButton('⬅️ Назад','editor:signature')]]); }
  if (payload === 'sig:toggle') { const s = await getSession(key); const draft = safeDraft(s.data); if (draft.channelIds[0]) await setSignatureActive(draft.channelIds[0], true); return showEditor(callbackId, key, draft); }
  if (payload === 'editor:ad') { const s = await getSession(key); const draft = safeDraft(s.data); draft.isAd = !draft.isAd; if (draft.isAd) { draft.signatureEnabled = false; draft.reportAfterHours = 24; if (!draft.autoDeleteMinutes) draft.autoDeleteMinutes = 2880; } return showEditor(callbackId, key, draft); }
  if (payload === 'editor:cpm') { const s = await getSession(key); await setSession(key, 'wait_cpm', s.data); return cb(callbackId, '💰 Введите цену за 1000 просмотров.', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:back') { const s = await getSession(key); return showEditor(callbackId, key, safeDraft(s.data)); }
  if (payload === 'editor:next') { const s = await getSession(key); return showPublishMenu(callbackId, key, safeDraft(s.data)); }
  if (payload === 'editor:save') { const s = await getSession(key); return saveExisting(callbackId, key, safeDraft(s.data)); }
  if (payload === 'publish:auto_delete') { const s = await getSession(key); return showPublishMenu(callbackId, key, safeDraft(s.data)); }
  if (payload.startsWith('publish:auto_set:')) { const session = await getSession(key); const draft = safeDraft(session.data); const v = Number(payload.split(':')[2] || 0) || null; draft.autoDeleteMinutes = v; await setSession(key, 'publish_menu', { draft }); return showPublishMenu(callbackId, key, draft); }
  if (payload === 'schedule:manual') { const s = await getSession(key); await setSession(key, 'wait_schedule_time', s.data); return cb(callbackId, '🕒 Введите время: 18:30, 0235, завтра 18:30, через 1 минуту или 2026-06-23 18:30.', [[callbackButton('⬅️ Назад','editor:next')]]); }
  if (payload === 'schedule:calendar') return showScheduleCalendar(callbackId, key, dateKey(new Date()));
  if (payload.startsWith('schedule:week:')) return showScheduleCalendar(callbackId, key, payload.split(':')[2]);
  if (payload.startsWith('schedule:day:')) return showScheduleTimes(callbackId, key, payload.split(':')[2]);
  if (payload.startsWith('schedule:time:')) { const [, , dayKey, hhmm] = payload.split(':'); return scheduleFromCallbackTime(callbackId, chatId, key, dayKey, hhmm); }
  if (payload.startsWith('schedule:manual_day:')) { const dayKey = payload.split(':')[2]; const s = await getSession(key); await setSession(key, 'wait_schedule_time', s.data); return cb(callbackId, `🕒 Введите время для ${dateText(keyToDate(dayKey))}: ${dayKey} 18:30`, [[callbackButton('⬅️ К календарю', `schedule:week:${dayKey}`)]]); }
  if (payload === 'publish:now') { const s = await getSession(key); const draft = safeDraft(s.data); const results = await publishDraftNow(draft, key); await clearSession(key); await answerCallback({ callbackId, notification: 'Публикация выполнена.' }).catch(()=>{}); return afterPublished(chatId, draft, results); }
  if (payload === 'post:all') {
    return showPosts(callbackId, 'all', await defaultPostDay('all'), null, chatId);
  }
  if (payload === 'post:channels') return showPostChannels(callbackId, chatId);
  if (payload.startsWith('post:filter:')) {
    const [, , mode, day, channel] = payload.split(':');
    return showPosts(callbackId, mode, day, Number(channel) || null, chatId);
  }
  if (payload.startsWith('post:open:')) return openPost(callbackId, chatId, Number(payload.split(':')[2]));
  if (payload.startsWith('post:editor:')) return editExisting(callbackId, key, Number(payload.split(':')[2]));
  if (payload.startsWith('post:auto:')) { const id = Number(payload.split(':')[2]); return cb(callbackId, '🗑 <b>Автоудаление</b>\n\nВыберите срок. Числа — часы.', postAutoRows(id)); }
  if (payload.startsWith('post:auto_set:')) { const [, , idRaw, minutesRaw] = payload.split(':'); const id = Number(idRaw); const v = Number(minutesRaw || 0) || null; await query('UPDATE scheduled_posts SET auto_delete_minutes=$2, updated_at=now() WHERE id=$1', [id, v]); return cb(callbackId, `✅ Автоудаление: ${formatAutoDelete(v)}`, [[callbackButton('👁 Открыть пост', `post:open:${id}`)]]); }
  if (payload.startsWith('post:auto_manual:')) { await setSession(key, 'wait_post_auto_delete', { postId: Number(payload.split(':')[2]) }); return cb(callbackId, '🗑 Введите срок автоудаления числом от 1 до 72, либо 0. Например: 24, 48, 72.', [[callbackButton('⬅️ Назад', `post:open:${payload.split(':')[2]}`)]]); }
  if (payload.startsWith('post:time:')) { await setSession(key, 'wait_post_time', { postId: Number(payload.split(':')[2]) }); return cb(callbackId, '🕒 Введите новое время публикации.', [[callbackButton('⬅️ Назад', `post:open:${payload.split(':')[2]}`)]]); }
  if (payload.startsWith('post:now:')) { const p = await getPost(Number(payload.split(':')[2])); if (!p) return cb(callbackId, 'Пост не найден.', [[callbackButton('🗂 Посты','post:all')]]); const draft = makeDraftFromPost(p); const results = await publishDraftNow(draft, key); await query(`UPDATE scheduled_posts SET status='canceled', updated_at=now() WHERE id=$1`, [p.id]); await answerCallback({ callbackId, notification: 'Отправлено на публикацию.' }).catch(()=>{}); return afterPublished(chatId, draft, results); }
  if (payload.startsWith('post:delete_confirm:')) { const id = Number(payload.split(':')[2]); return cb(callbackId, `❌ Удалить пост #${id}?`, [[callbackButton('✅ Да, удалить', `post:delete:${id}`)],[callbackButton('⬅️ Назад', `post:open:${id}`)]]); }
  if (payload.startsWith('post:delete:')) { const id = Number(payload.split(':')[2]); const p = await getPost(id); if (p?.status === 'published' && p.published_message_id) await deleteMaxMessage(p.published_message_id).catch(e=>console.error('[delete max]', e.message || e)); await query(`UPDATE scheduled_posts SET status='canceled', updated_at=now() WHERE id=$1`, [id]); return cb(callbackId, `✅ Пост #${id} удалён.`, [[callbackButton('🗂 Посты','post:all')]]); }
  if (payload.startsWith('report:open:')) { const gid = payload.split(':').slice(2).join(':'); return cb(callbackId, `📊 <b>LinkRay Analytics</b>\n\nОтчёт: <a href="${reportUrl(gid)}">открыть красивую страницу</a>`, [[linkButton('📊 Открыть отчёт', reportUrl(gid))],[callbackButton('🏠 В меню','main:menu')]]); }
  
if (payload === 'sig:menu') return showSignaturesMenu(callbackId);

  // LR_AUTOSIGN_CHANNEL_CLICK_FIX_START
  if (payload.startsWith('sig:channel:')) {
    const channelId = Number(String(payload).split(':').pop());
    const channel = (await getChannels()).find((c) => Number(c.id) === channelId);

    if (!channel || !channelId) {
      return cb(callbackId, '⚠️ Канал не найден.', [
        [callbackButton('⬅️ Автоподписи', 'sig:menu')],
        [callbackButton('⬅️ В Studio', 'main:posting')]
      ]);
    }

    const sig = await loadSignature(channelId);
    const isActive = sig ? sig.is_active !== false : true;

    const signatureText = lrSigV14Preview(sig);

    return cb(
      callbackId,
      `━━━━━━━━━━━━━━\n🏷 <b>Автоподпись</b>\n\nКанал:\n${channelName(channel)}\n\nСтатус: ${isActive ? 'включена' : 'выключена'}\n\n${signatureText}\n━━━━━━━━━━━━━━`,
      [
        [callbackButton('✏️ Заменить подпись', `sig:add_channel:${channelId}`)],
        [callbackButton(isActive ? '🚫 Выключить' : '✅ Включить', `sig:toggle_channel:${channelId}`)],
        [callbackButton('⬅️ Автоподписи', 'sig:menu')],
        [callbackButton('⬅️ В Studio', 'main:posting')]
      ]
    );
  }

  if (payload.startsWith('sig:toggle_channel:')) {
    const channelId = Number(String(payload).split(':').pop());
    if (!channelId) {
      return cb(callbackId, '⚠️ Канал не найден.', [[callbackButton('⬅️ Автоподписи', 'sig:menu')]]);
    }

    const sig = await loadSignature(channelId);
    const nextActive = !(sig ? sig.is_active !== false : true);
    await setSignatureActive(channelId, nextActive);

    const channel = (await getChannels()).find((c) => Number(c.id) === channelId);
    const newSig = await loadSignature(channelId);
    const signatureText = lrSigV14Preview(newSig);

    return cb(
      callbackId,
      `━━━━━━━━━━━━━━\n🏷 <b>Автоподпись</b>\n\nКанал:\n${channel ? channelName(channel) : channelId}\n\nСтатус: ${nextActive ? 'включена' : 'выключена'}\n\n${signatureText}\n━━━━━━━━━━━━━━`,
      [
        [callbackButton('✏️ Заменить подпись', `sig:add_channel:${channelId}`)],
        [callbackButton(nextActive ? '🚫 Выключить' : '✅ Включить', `sig:toggle_channel:${channelId}`)],
        [callbackButton('⬅️ Автоподписи', 'sig:menu')],
        [callbackButton('⬅️ В Studio', 'main:posting')]
      ]
    );
  }

  if (payload.startsWith('sig:add_channel:')) {
    const channelId = Number(String(payload).split(':').pop());
    if (!channelId) {
      return cb(callbackId, '⚠️ Канал не найден.', [[callbackButton('⬅️ Автоподписи', 'sig:menu')]]);
    }

    const draft = { ...emptyDraft(), channelIds: [channelId], signatureEnabled: true };
    await setSession(key, 'wait_signature', { draft });

    return cb(callbackId, '🏷 Отправьте подпись. Ссылки, жирный, курсив и подчёркивание MAX сохранятся.', [
      [callbackButton('⬅️ Назад', `sig:channel:${channelId}`)]
    ]);
  }
  // LR_AUTOSIGN_CHANNEL_CLICK_FIX_END


// LR_SIG_CHANNEL_HANDLERS_V8_START
if (payload.startsWith('sig:channel:')) {
  const channelId = Number(payload.split(':')[2]);
  const channel = await getChannel(channelId).catch(() => null);
  const sig = channelId ? await loadSignature(channelId) : null;

  const draft = emptyDraft();
  draft.channelIds = [channelId].filter(Boolean);
  await setSession(key, 'edit_draft', { draft });

  const rows = [
    [callbackButton('✏️ Заменить подпись', `sig:add_channel:${channelId}`)],
    [callbackButton('⬅️ Автоподписи', 'sig:menu')],
    [callbackButton('⬅️ В Studio', 'main:posting')]
  ];

  return cb(callbackId, `━━━━━━━━━━━━━━
🏷 <b>Автоподпись</b>

Канал:
${channel ? escapeHtml(channelName(channel)) : `#${channelId}`}

Статус: ${sig ? 'включена' : 'не создана'}

${globalThis.__lrSigRichV13.preview(sig)}
━━━━━━━━━━━━━━`, rows, 'html');
}

if (payload.startsWith('sig:add_channel:')) {
  const channelId = Number(payload.split(':')[2]);
  const draft = emptyDraft();
  draft.channelIds = [channelId].filter(Boolean);

  await setSession(key, 'wait_signature', { draft });

  return cb(callbackId, `🏷 Отправьте подпись.

Можно отправить:
<b>жирный текст</b>
<a href="https://max.ru">текст с ссылкой</a>
или выделить текст через меню MAX.

После сохранения подпись будет добавляться к посту без карточки канала снизу.`, [
    [callbackButton('⬅️ Назад', `sig:channel:${channelId}`)]
  ], 'html');
}
// LR_SIG_CHANNEL_HANDLERS_V8_END

  await cb(callbackId, 'Команда пока не обработана.', [[callbackButton('🏠 В меню','main:menu')]]);
}

async function showChannels(callbackId) {
  return cb(callbackId, `━━━━━━━━━━━━
🔗 <b>Добавить канал</b>

1. Откройте канал в MAX.
2. Добавьте LinkRay в администраторы.
3. Выдайте право публикации.
4. Канал автоматически сохранится в базе LinkRay.

После добавления бот пришлёт сообщение:
✅ Канал добавлен в LinkRay
━━━━━━━━━━━━`, [
    [callbackButton('🔗 Добавить канал', 'post:add_channel')],
    [callbackButton('⬅️ В меню', 'main:menu')]
  ]);
}
async function showSignaturesMenu(callbackId) { const channels = await getChannels(); const rows = channels.map(c => [callbackButton(`🏷 ${channelName(c)}`, `sig:channel:${c.id}`)]); rows.push([callbackButton('⬅️ В Studio','main:posting')]); await cb(callbackId, `━━━━━━━━━━━━━━\n🏷 <b>Автоподписи</b>\n\nВыберите канал.\n━━━━━━━━━━━━━━`, rows); }


// LR_CHANNEL_INBOUND_GUARD_START
const __lrChannelGuardCache = {
  ready: false,
  cols: [],
};

function __lrGuardRows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function __lrLooksLikeChannelUpdate(update) {
  const values = [
    update?.chat?.type,
    update?.message?.recipient?.type,
    update?.message?.chat?.type,
    update?.recipient?.type,
    update?.body?.recipient?.type,
    update?.chat_type,
    update?.chatType,
  ].map((x) => String(x || '').toLowerCase());

  return values.includes('channel');
}

async function __lrGetChannelColumns() {
  if (__lrChannelGuardCache.ready) return __lrChannelGuardCache.cols;

  try {
    const result = await query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='channels'"
    );

    __lrChannelGuardCache.cols = __lrGuardRows(result).map((r) => String(r.column_name || ''));
  } catch (error) {
    console.error('[channel guard] columns error:', error.message || error);
    __lrChannelGuardCache.cols = [];
  }

  __lrChannelGuardCache.ready = true;
  return __lrChannelGuardCache.cols;
}

async function __lrIsKnownChannelChat(chatId) {
  if (!chatId) return false;

  try {
    const cols = await __lrGetChannelColumns();
    const candidates = [
      'id',
      'channel_id',
      'chat_id',
      'max_chat_id',
      'channel_chat_id',
      'external_chat_id',
      'max_id',
    ].filter((col) => cols.includes(col));

    if (!candidates.length) return false;

    const where = candidates.map((col, i) => `${col}::text = $${i + 1}`).join(' OR ');
    const args = candidates.map(() => String(chatId));

    const result = await query(`SELECT 1 FROM channels WHERE ${where} LIMIT 1`, args);

    return __lrGuardRows(result).length > 0;
  } catch (error) {
    console.error('[channel guard] lookup error:', error.message || error);
    return false;
  }
}

async function __lrShouldIgnoreInboundChannelUpdate(update) {
  const chatId = getChatId(update);

  if (!chatId) return false;

  const knownChannel = await __lrIsKnownChannelChat(chatId);
  const looksChannel = __lrLooksLikeChannelUpdate(update);

  if (knownChannel || looksChannel) {
    console.log('[channel guard] ignored inbound channel update', JSON.stringify({
      type: update?.type || '',
      chatId: String(chatId),
      knownChannel,
      looksChannel,
    }));

    return true;
  }

  return false;
}
// LR_CHANNEL_INBOUND_GUARD_END








// LR_CHANNEL_DB_SYNC_START
let __lrChannelDbSyncStarted = false;

function __lrDbRows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

async function __lrEnsureChannelDbSyncTables() {
  await query(`CREATE TABLE IF NOT EXISTS lr_bot_state (
    key text PRIMARY KEY,
    value text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});

  await query(`CREATE TABLE IF NOT EXISTS lr_channel_seen_state (
    channel_key text PRIMARY KEY,
    channel_name text,
    seen_at timestamptz NOT NULL DEFAULT now(),
    notified_at timestamptz
  )`).catch(() => {});
}

function __lrChannelKeyFromRow(c) {
  return String(
    c?.id ??
    c?.channel_id ??
    c?.chat_id ??
    c?.max_id ??
    c?.max_chat_id ??
    c?.external_chat_id ??
    c?.title ??
    c?.name ??
    ''
  ).trim();
}

function __lrChannelTitleFromRow(c) {
  try {
    return String(channelName(c) || c?.title || c?.name || 'Канал')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return String(c?.title || c?.name || 'Канал')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

async function __lrRememberPrivateChatId(chatId) {
  if (!chatId) return;

  await __lrEnsureChannelDbSyncTables();

  await query(
    `INSERT INTO lr_bot_state(key, value, updated_at)
     VALUES('last_private_chat_id', $1, now())
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [String(chatId)]
  ).catch(() => {});
}

async function __lrGetLastPrivateChatId() {
  await __lrEnsureChannelDbSyncTables();

  const result = await query(
    `SELECT value FROM lr_bot_state WHERE key='last_private_chat_id' LIMIT 1`
  ).catch(() => []);

  return __lrDbRows(result)[0]?.value || '';
}

async function __lrKnownChannelColumns() {
  const result = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='channels'`
  ).catch(() => []);

  return __lrDbRows(result).map((r) => String(r.column_name || ''));
}

function __lrCollectChannelIds(update) {
  const found = new Set();

  function walk(value, parentKey = '') {
    if (value === null || value === undefined) return;

    if (typeof value === 'string' || typeof value === 'number') {
      const raw = String(value).trim();
      const ctx = String(parentKey || '').toLowerCase();

      if (!raw) return;

      if (
        /chat|channel|max/.test(ctx) &&
        !/user|owner|author|sender/.test(ctx) &&
        (raw.length >= 2)
      ) {
        found.add(raw);
      }

      return;
    }

    if (Array.isArray(value)) {
      for (const x of value) walk(x, parentKey);
      return;
    }

    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        const key = String(k || '').toLowerCase();
        const nextParent = parentKey ? `${parentKey}.${key}` : key;

        if (
          (key === 'id' || key.endsWith('_id') || key.includes('chat') || key.includes('channel') || key.includes('max')) &&
          !key.includes('user') &&
          !key.includes('owner') &&
          !key.includes('author') &&
          !key.includes('sender')
        ) {
          walk(v, nextParent);
        } else if (typeof v === 'object') {
          walk(v, nextParent);
        }
      }
    }
  }

  walk(update);

  return [...found].filter((x) => x && x !== '0');
}

function __lrIsChannelRemoveUpdate(update) {
  const type = String(update?.type || update?.update_type || update?.event_type || '').toLowerCase();

  if (!type) return false;

  if (
    type === 'message_created' ||
    type === 'message_callback' ||
    type === 'message_edited' ||
    type === 'message_removed' ||
    type === 'message_deleted'
  ) {
    return false;
  }

  const body = JSON.stringify(update || {}).toLowerCase();

  const typeHit =
    type.includes('bot_removed') ||
    type.includes('bot_deleted') ||
    type.includes('bot_left') ||
    type.includes('bot_kicked') ||
    type.includes('chat_member') ||
    type.includes('member_removed') ||
    type.includes('channel_removed') ||
    type.includes('channel_deleted') ||
    type.includes('chat_removed') ||
    type.includes('chat_deleted');

  const statusHit =
    body.includes('"status":"removed"') ||
    body.includes('"status":"left"') ||
    body.includes('"status":"kicked"') ||
    body.includes('"status":"deleted"') ||
    body.includes('"new_status":"removed"') ||
    body.includes('"new_status":"left"') ||
    body.includes('"new_status":"kicked"');

  const hasContext =
    body.includes('channel') ||
    body.includes('chat') ||
    body.includes('member') ||
    body.includes('bot');

  return (typeHit || statusHit) && hasContext;
}

async function __lrDeleteChannelByUpdate(update) {
  if (!__lrIsChannelRemoveUpdate(update)) return false;

  const ids = __lrCollectChannelIds(update);

  if (!ids.length) {
    console.log('[channel db sync] remove update without ids', JSON.stringify({
      type: update?.type || update?.update_type || update?.event_type || '',
    }));
    return false;
  }

  const allCols = await __lrKnownChannelColumns();

  const cols = [
    'id',
    'channel_id',
    'chat_id',
    'max_id',
    'max_chat_id',
    'external_chat_id',
    'channel_chat_id'
  ].filter((col) => allCols.includes(col));

  if (!cols.length) {
    console.log('[channel db sync] no known id columns in channels table');
    return false;
  }

  const where = cols.map((col) => `${col}::text = ANY($1::text[])`).join(' OR ');

  const deletedResult = await query(
    `DELETE FROM channels WHERE ${where} RETURNING *`,
    [ids]
  ).catch((error) => {
    console.error('[channel db sync] delete failed:', error.message || error);
    return [];
  });

  const deleted = __lrDbRows(deletedResult);

  if (!deleted.length) {
    console.log('[channel db sync] remove update matched no channels', JSON.stringify({
      type: update?.type || update?.update_type || update?.event_type || '',
      ids,
    }));
    return false;
  }

  await __lrEnsureChannelDbSyncTables();

  for (const ch of deleted) {
    const key = __lrChannelKeyFromRow(ch);
    if (key) {
      await query(
        `DELETE FROM lr_channel_seen_state WHERE channel_key=$1`,
        [key]
      ).catch(() => {});
    }
  }

  const chatId = await __lrGetLastPrivateChatId();
  const names = deleted.map(__lrChannelTitleFromRow).join('\n');

  if (chatId) {
    await sendMessage(chatId, {
      text: `🗑️ <b>Канал удалён из LinkRay</b>\n\n${names}\n\nБот больше не администратор этого канала, поэтому канал удалён из базы.`,
      buttons: [
        [callbackButton('🔗 Добавить канал', 'post:add_channel')],
        [callbackButton('⬅️ В меню', 'main:menu')]
      ]
    }).catch((error) => {
      console.error('[channel db sync] notify delete failed:', error.message || error);
    });
  }

  console.log('[channel db sync] deleted channels after bot removal', JSON.stringify({
    ids,
    deleted: deleted.map((x) => __lrChannelKeyFromRow(x)),
  }));

  return true;
}

async function __lrInitSeenChannelsIfNeeded(channels) {
  await __lrEnsureChannelDbSyncTables();

  const result = await query(
    `SELECT value FROM lr_bot_state WHERE key='channel_seen_initialized' LIMIT 1`
  ).catch(() => []);

  if (__lrDbRows(result)[0]?.value === '1') return true;

  for (const c of channels) {
    const key = __lrChannelKeyFromRow(c);
    if (!key) continue;

    await query(
      `INSERT INTO lr_channel_seen_state(channel_key, channel_name, notified_at)
       VALUES($1,$2,now())
       ON CONFLICT(channel_key) DO NOTHING`,
      [key, __lrChannelTitleFromRow(c)]
    ).catch(() => {});
  }

  await query(
    `INSERT INTO lr_bot_state(key, value, updated_at)
     VALUES('channel_seen_initialized','1',now())
     ON CONFLICT(key) DO UPDATE SET value='1', updated_at=now()`
  ).catch(() => {});

  return false;
}

async function __lrNotifyNewChannels(targetChatId = '') {
  try {
    await __lrEnsureChannelDbSyncTables();

    const channels = await getChannels();

    const initialized = await __lrInitSeenChannelsIfNeeded(channels);

    if (!initialized) return;

    const chatId = String(targetChatId || await __lrGetLastPrivateChatId() || '').trim();

    if (!chatId) return;

    for (const c of channels) {
      const key = __lrChannelKeyFromRow(c);
      const title = __lrChannelTitleFromRow(c);

      if (!key) continue;

      const exists = __lrDbRows(await query(
        `SELECT 1 FROM lr_channel_seen_state WHERE channel_key=$1 LIMIT 1`,
        [key]
      ).catch(() => []));

      if (exists.length) continue;

      await query(
        `INSERT INTO lr_channel_seen_state(channel_key, channel_name, notified_at)
         VALUES($1,$2,now())
         ON CONFLICT(channel_key) DO NOTHING`,
        [key, title]
      ).catch(() => {});

      await sendMessage(chatId, {
        text: `✅ <b>Канал добавлен в LinkRay</b>\n\n${title}\n\nКанал сохранён в базе и будет доступен для публикаций.`,
        buttons: [
          [callbackButton('🔗 Добавить ещё канал', 'post:add_channel')],
          [callbackButton('⬅️ В меню', 'main:menu')]
        ]
      }).catch((error) => {
        console.error('[channel db sync] notify add failed:', error.message || error);
      });
    }
  } catch (error) {
    console.error('[channel db sync] notify new failed:', error.message || error);
  }
}

async function __lrHandleChannelDbSyncUpdate(update) {
  try {
    await __lrDeleteChannelByUpdate(update);
  } catch (error) {
    console.error('[channel db sync] update failed:', error.message || error);
  }
}

function __lrStartChannelDbSyncTimer() {
  if (__lrChannelDbSyncStarted) return;

  __lrChannelDbSyncStarted = true;

  setInterval(() => {
    __lrNotifyNewChannels().catch((error) => {
      console.error('[channel db sync timer]', error.message || error);
    });
  }, 30000);
}
// LR_CHANNEL_DB_SYNC_END


async function handleMessage(update) {
  __lrStartChannelDbSyncTimer();
  __lrStartChannelDbSyncTimer();
  if (await __lrShouldIgnoreInboundChannelUpdate(update)) return;
  const chatId = Number(getChatId(update));
  await __lrRememberPrivateChatId(chatId);
  await __lrNotifyNewChannels(chatId);

  await __lrRememberPrivateChatId(chatId);
  await __lrNotifyNewChannels(chatId);
 const key = getSessionKey(update); const text = getMessageText(update); const n = norm(text); log('message', { chatId, key, text: text.slice(0,80) });
  await writeFile('/tmp/linkray_last_update.json', JSON.stringify(update, null, 2)).catch(()=>{});
  if (['/start','start','/menu','меню','начать'].includes(n) || String(getUpdateType(update) || '').toLowerCase().includes('bot_started')) { await clearSession(key); return sendMain(chatId); }
  const session = await getSession(key); const draft = safeDraft(session.data);
  if (session.state === 'wait_post_content') { const content = await hydrateContent(update); draft.content = { ...draft.content, ...content }; lrApplyEditorPostFormat(draft, content); draft.previewMessageId = null; const mid = await sendDraftPreview(chatId, draft); if (mid) draft.previewMessageId = mid; await setSession(key, 'edit_draft', { draft }); return msg(chatId, editorMenuText(), editorMenuRows(draft)); }
  if (session.state === 'wait_edit_text') { const content = await hydrateContent(update); draft.content.text = content.text || text; lrApplyEditorPostFormat(draft, content); draft.previewMessageId = null; await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft }); return sendEditorAsNew(chatId, key, draft); }
  if (session.state === 'wait_edit_media') { const content = await hydrateContent(update); if (content.attachments.length) draft.content.attachments = content.attachments; if (content.text) draft.content.text = content.text; lrApplyEditorPostFormat(draft, content); draft.previewMessageId = null; await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft }); return sendEditorAsNew(chatId, key, draft); }
  if (session.state === 'wait_button') {
    const parsed = parseButtonsInput(text);

    console.log('[wait_button fixed preview] input', JSON.stringify({
      key,
      text,
      parsedRows: parsed.length,
    }));

    if (!parsed.length) {
      await setSession(key, 'wait_button', { draft });

      return msg(
        chatId,
        `Не понял кнопку.

Формат:
Название - https://site.ru

Пример:
Тест - https://max.ru/join/...`
      );
    }

    draft.buttons = [...(draft.buttons || []), ...parsed];

    draft.previewMessageId = null; // LR_REFRESH_PREVIEW_AFTER_BUTTON_ADD

    await setSession(
      key,
      draft.postId ? 'edit_existing' : 'edit_draft',
      { draft }
    );

    console.log('[wait_button fixed preview] added', JSON.stringify({
      key,
      added: parsed.length,
      total: draft.buttons.length,
      signatureEnabled: draft.signatureEnabled !== false,
      channels: draft.channelIds?.length || 0,
    }));

    // После добавления кнопки заново отправляем пост-превью сверху,
    // уже с кнопкой и автоподписью, потом меню редактора.
    if (typeof sendEditorAsNew === 'function') {
      return sendEditorAsNew(chatId, key, draft);
    }

    return sendEditorAsNew(chatId, key, draft);
  }
  if (session.state === 'wait_signature') {
    const content = lrAutoSigFinalContent(update);
    const channelId = draft.channelIds[0];

    if (!channelId) {
      await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });
      return msg(chatId, '⚠️ Сначала выберите канал для автоподписи.');
    }

    if (!String(content.text || '').trim()) {
      return msg(chatId, '⚠️ Подпись пустая. Отправьте текст, ссылку или жирный текст-ссылку.');
    }

    try {
      await saveSignature(channelId, content);
    } catch (error) {
      console.error('[signature save final]', error.message || error);
      await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });
      return msg(chatId, `⚠️ Не удалось сохранить автоподпись:
${error.message || error}`);
    }

    await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });
    return sendStudioEditorMessage(chatId, draft);
  }

  if (session.state === 'wait_cpm') { const cpm = Number(String(text).replace(',', '.').replace(/[^0-9.]/g,'')); if (!Number.isFinite(cpm) || cpm <= 0) return msg(chatId, 'Введите число, например 1000.'); draft.cpm = cpm; draft.isAd = true; draft.signatureEnabled = false; draft.autoDeleteMinutes ||= 2880; await setSession(key, 'edit_draft', { draft }); return sendStudioEditorMessage(chatId, draft); }
  if (session.state === 'wait_auto_delete') { const v = parseDuration(text); if (v === undefined) return msg(chatId, 'Не понял срок. Введите число от 1 до 72 часов или 0.'); draft.autoDeleteMinutes = v; await setSession(key, 'publish_menu', { draft }); return msg(chatId, `✅ Автоудаление: ${formatAutoDelete(v)}`, [[callbackButton('➡️ К выпуску','editor:next')]]); }
  if (session.state === 'wait_schedule_time') { const publishAt = parseSchedule(text); if (!publishAt) return msg(chatId, 'Не понял время. Пример: 18:30, 0235, завтра 18:30, через 1 минуту.'); const ids = await scheduleDraft(draft, key, publishAt); await clearSession(key); return afterPlanned(chatId, draft, publishAt, ids); }
  if (session.state === 'wait_post_auto_delete') { const v = parseDuration(text); if (v === undefined) return msg(chatId, 'Не понял срок. Введите число от 1 до 72 часов или 0.'); await query('UPDATE scheduled_posts SET auto_delete_minutes=$2, updated_at=now() WHERE id=$1', [session.data.postId, v]); await clearSession(key); return msg(chatId, `✅ Автоудаление: ${formatAutoDelete(v)}`, [[callbackButton('👁 Открыть пост', `post:open:${session.data.postId}`)]]); }
  if (session.state === 'wait_post_time') { const publishAt = parseSchedule(text); if (!publishAt) return msg(chatId, 'Не понял время.'); await query(`UPDATE scheduled_posts SET publish_at=$2, updated_at=now() WHERE id=$1`, [session.data.postId, publishAt]); await clearSession(key); return msg(chatId, '✅ Время обновлено.', [[callbackButton('👁 Открыть пост', `post:open:${session.data.postId}`)]]); }
  const content = await hydrateContent(update); if (content.text || content.attachments.length) { const d = emptyDraft(); d.content = { ...d.content, ...content }; await setSession(key, 'select_channels', { draft: d }); const channels = await getChannels(); const rs = channels.map(c => [callbackButton(`📡 ${channelName(c)}`, `post:single:${c.id}`)]); rs.push([callbackButton('🌐 Все каналы','post:all_channels')],[callbackButton('❌ Отмена','post:cancel')]); return msg(chatId, '📡 Пост принят. Теперь выберите канал для публикации.', rs); }
  return msg(chatId, 'Команда не найдена. Нажмите /start.');
}
async function sendStudioEditorMessage(chatId, draft) {
  const mid = await sendDraftPreview(chatId, draft);
  if (mid) draft.previewMessageId = mid;
  return msg(chatId, editorMenuText(), editorMenuRows(draft));
}
async function sendEditorAsNew(chatId, key, draft) {
  const mid = await sendDraftPreview(chatId, draft);
  if (mid) draft.previewMessageId = mid;
  await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });
  return msg(chatId, editorMenuText(), editorMenuRows(draft));
}



app.get('/r/:token', async (req, res) => {
  const token = String(req.params.token || '').trim();

  try {
    const links = await query('SELECT * FROM analytics_links WHERE token=$1 LIMIT 1', [token]);
    const link = links[0];

    if (!link) {
      return res.status(404).send('LinkRay: ссылка не найдена');
    }

    const fp = reqFingerprint(req, token);

    await query(
      `INSERT INTO analytics_clicks(token,campaign_id,post_id,channel_id,fingerprint,ip_hash,user_agent,clicked_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT(token, fingerprint) DO NOTHING`,
      [token, link.campaign_id, link.post_id, link.channel_id, fp.fingerprint, fp.ipHash, fp.userAgent]
    );

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.redirect(302, link.target_url);
  } catch (e) {
    console.error('[analytics redirect]', e.message || e);
    res.status(500).send('LinkRay redirect error');
  }
});

app.get('/analytics/stats/:groupId', async (req, res) => {
  try {
    const groupId = String(req.params.groupId || '');

    const posts = await query(
      `SELECT sp.*, c.title AS channel_title, c.link AS channel_link
       FROM scheduled_posts sp
       LEFT JOIN channels c ON c.id = sp.channel_id
       WHERE COALESCE(sp.report_group_id, sp.id::text) = $1
       ORDER BY sp.id ASC`,
      [groupId]
    );

    const links = await query(
      `SELECT l.*,
              COUNT(c.id)::int AS total_clicks,
              COUNT(DISTINCT c.fingerprint)::int AS unique_clicks
       FROM analytics_links l
       LEFT JOIN analytics_clicks c ON c.token = l.token
       WHERE l.campaign_id = $1
       GROUP BY l.token
       ORDER BY l.created_at ASC`,
      [groupId]
    );

    const snapshot = safeJson(posts[0]?.report_snapshot, {});
    const title = escapeHtml(short(posts[0]?.text || snapshot.title || 'Рекламный пост', 120));
    const textPreview = escapeHtml(plain(posts[0]?.text || snapshot.title || ''));
    const totalViews = Number(snapshot.totalViews || 0);
    const uniqueClicks = links.reduce((sum, l) => sum + Number(l.unique_clicks || 0), 0);
    const totalClicks = links.reduce((sum, l) => sum + Number(l.total_clicks || 0), 0);
    const cpm = Number(posts[0]?.cpm || snapshot.cpm || 0);
    const cost = totalViews && cpm ? Math.round((totalViews / 1000) * cpm) : null;

    const channelRows = posts.map((p, i) => {
      const channel = escapeHtml(p.channel_title || 'Канал');
      const status = escapeHtml(String(p.status || ''));
      const views = escapeHtml(String(safeJson(p.report_snapshot, {}).views || '—'));
      const ad = p.is_ad ? '💼' : '';
      return `<tr>
        <td>${i + 1}</td>
        <td>${ad} ${p.channel_link ? `<a href="${attr(p.channel_link)}">${channel}</a>` : channel}</td>
        <td>${status}</td>
        <td>${views}</td>
        <td>${escapeHtml(formatAutoDelete(p.auto_delete_minutes))}</td>
      </tr>`;
    }).join('');

    const linkRows = links.map((l, i) => {
      const label = escapeHtml(l.label || 'ссылка');
      const target = escapeHtml(l.target_url || '');
      return `<tr>
        <td>${i + 1}</td>
        <td>${label}</td>
        <td>${Number(l.unique_clicks || 0)}</td>
        <td>${Number(l.total_clicks || 0)}</td>
        <td><a href="${attr(l.target_url)}" target="_blank" rel="noopener">открыть</a></td>
      </tr>`;
    }).join('');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>LinkRay — сводный отчёт</title>
<style>
:root{--bg:#07131f;--card:rgba(255,255,255,.09);--card2:rgba(255,255,255,.14);--text:#ecfeff;--muted:#9fb7c8;--accent:#62f0b7;--accent2:#5aa7ff;--danger:#ff5d7d;--line:rgba(255,255,255,.14)}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:
radial-gradient(circle at 15% 0%,rgba(98,240,183,.28),transparent 28%),
radial-gradient(circle at 80% 10%,rgba(90,167,255,.24),transparent 32%),
linear-gradient(135deg,#07131f,#0b1728 48%,#101827);color:var(--text)}
.wrap{max-width:1120px;margin:0 auto;padding:22px 14px 46px}
.hero{border:1px solid var(--line);border-radius:28px;padding:22px;background:linear-gradient(135deg,rgba(255,255,255,.13),rgba(255,255,255,.05));box-shadow:0 22px 80px rgba(0,0,0,.28);overflow:hidden;position:relative}
.hero:after{content:"";position:absolute;right:-80px;top:-80px;width:230px;height:230px;border-radius:999px;background:rgba(98,240,183,.22);filter:blur(6px)}
.brand{display:flex;align-items:center;gap:14px;position:relative;z-index:2}
.logo{width:62px;height:62px;border-radius:22px;background:linear-gradient(135deg,#56f2b4,#4a94ff);display:grid;place-items:center;box-shadow:0 12px 36px rgba(98,240,183,.25);font-weight:900;color:#06111f}
.logo span{font-size:24px}
h1{font-size:clamp(28px,5vw,54px);line-height:1.02;margin:18px 0 8px}
.sub{color:var(--muted);font-size:16px;line-height:1.5;max-width:760px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}
.stat{border:1px solid var(--line);border-radius:22px;background:var(--card);padding:16px}
.stat .k{color:var(--muted);font-size:13px}.stat .v{font-size:28px;font-weight:850;margin-top:6px}
.panel{border:1px solid var(--line);border-radius:24px;background:rgba(255,255,255,.07);padding:18px;margin-top:14px}
h2{margin:0 0 12px;font-size:20px}
.preview{white-space:pre-wrap;color:#d9f7ff;line-height:1.45;background:rgba(0,0,0,.18);border-radius:18px;padding:14px;max-height:260px;overflow:auto}
table{width:100%;border-collapse:collapse;overflow:hidden;border-radius:16px}
td,th{border-bottom:1px solid var(--line);padding:12px 10px;text-align:left;font-size:14px}
th{color:var(--muted);font-weight:650}
a{color:#78ffd0;text-decoration:none}a:hover{text-decoration:underline}
.badge{display:inline-flex;gap:7px;align-items:center;padding:9px 12px;border-radius:999px;background:rgba(98,240,183,.12);border:1px solid rgba(98,240,183,.22);color:#a9ffd9;font-weight:700}
.footer{color:var(--muted);font-size:13px;margin-top:18px;text-align:center}
@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}.hero{border-radius:22px;padding:18px}.stat .v{font-size:23px}td,th{font-size:13px;padding:10px 7px}.wrap{padding:12px 10px 32px}}
</style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <div class="brand">
      <div class="logo"><span>LR</span></div>
      <div>
        <div class="badge">🧬 LinkRay Analytics</div>
        <div class="sub">Сводный отчёт по рекламному размещению в MAX</div>
      </div>
    </div>
    <h1>${title}</h1>
    <div class="grid">
      <div class="stat"><div class="k">Публикаций</div><div class="v">${posts.length}</div></div>
      <div class="stat"><div class="k">Просмотры</div><div class="v">${totalViews || '—'}</div></div>
      <div class="stat"><div class="k">Просмотры MAX</div><div class="v">${uniqueClicks}</div></div>
    </div>
  </section>

  <section class="panel">
    <h2>📝 Пост</h2>
    <div class="preview">${textPreview || 'Текст поста недоступен'}</div>
  </section>

  <section class="panel">
    <h2>📊 Итоги</h2>
    <div class="grid">
      <div class="stat"><div class="k">Служебные данные</div><div class="v">${totalClicks}</div></div>
      <div class="stat"><div class="k">CPM</div><div class="v">${cpm || '—'}</div></div>
      <div class="stat"><div class="k">Стоимость</div><div class="v">${cost === null ? '—' : `${cost} ₽`}</div></div>
      <div class="stat"><div class="k">Автоудаление</div><div class="v">${escapeHtml(formatAutoDelete(posts[0]?.auto_delete_minutes))}</div></div>
    </div>
  </section>

  <section class="panel">
    <h2>📌 Публикации по каналам</h2>
    <table><thead><tr><th>#</th><th>Канал</th><th>Статус</th><th>Просмотры</th><th>Удаление</th></tr></thead><tbody>${channelRows || '<tr><td colspan="5">Публикаций пока нет</td></tr>'}</tbody></table>
  </section>

  <section class="panel">
    <h2>🔗 Переходы по ссылкам и кнопкам</h2>
    <table><thead><tr><th>#</th><th>Элемент</th><th>Уникальные</th><th>Все</th><th>Цель</th></tr></thead><tbody>${linkRows || '<tr><td colspan="5">Переходов пока нет</td></tr>'}</tbody></table>
  </section>

  <div class="footer">Сформировано LinkRay · ${escapeHtml(new Date().toLocaleString('ru-RU'))}</div>
</div>
</body>
</html>`);
  } catch (e) {
    res.status(500).send(`Report error: ${escapeHtml(e.message || e)}`);
  }
});

app.get('/health', async (_req, res) => { try { await query('SELECT 1'); res.json({ ok: true, service: 'linkray-bot', db: true, time: nowIso() }); } catch(e) { res.status(500).json({ ok:false, error: e.message }); } });
app.post('/webhook', async (req, res) => {
  const incomingSecret = req.header('X-Max-Bot-Api-Secret');
  if (process.env.WEBHOOK_SECRET && incomingSecret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ ok: false });
  res.json({ ok: true });
  try {
    const update = req.body || {}; const type = getUpdateType(update); log('webhook', { type, chatId: getChatId(update), key: getSessionKey(update) }); await maybeRegisterChannel(update);
    if (type.includes('callback') || getCallbackId(update)) await handleCallback(update); else await handleMessage(update);
  } catch(e) { console.error('[webhook] processing error:', e); }
});

await ensureDb();
startAutopostWorker().catch(e => console.error('[autopost start]', e));
app.listen(PORT, () => console.log(`LinkRay bot started on port ${PORT}`));
