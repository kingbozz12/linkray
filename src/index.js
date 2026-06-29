
import './maxTextFormatPatch.js';
import * as lrCrypto from 'node:crypto';
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

const app = express();


// LINKRAY_24H_REPORT_START
import('./linkray24hReport.js')
  .then((mod) => {
    if (typeof mod.mountLinkRay24hReports === 'function') {
      mod.mountLinkRay24hReports();
    }
  })
  .catch((error) => console.error('[LinkRay 24h report mount]', error?.stack || error));
// LINKRAY_24H_REPORT_END

// LINKRAY_BRAND_STATIC_START
app.use('/brand', express.static('public/brand', { maxAge: '1h', fallthrough: true }));
// LINKRAY_BRAND_STATIC_END

// LINKRAY_PREEMPT_ANALYTICS_START
app.get('/analytics/stats/:groupId', async (req, res, next) => {
  try {
    const mod = await import('./linkrayAnalyticsRoutes.js');

    if (typeof mod.renderLinkRayAnalyticsRequest === 'function') {
      return mod.renderLinkRayAnalyticsRequest(req, res, next);
    }

    return next();
  } catch (error) {
    console.error('[linkray analytics preempt]', error?.stack || error);
    return next(error);
  }
});
// LINKRAY_PREEMPT_ANALYTICS_END

app.use(express.json({ limit: '50mb' }));

/* LR_FINAL_CAL_CPM_V2_START */
app.use(async function lrFinalCalCpmV2(req, res, next) {
  try {
    if (req.method !== 'POST') return next();

    const update = req.body || {};
    const payload = String(getCallbackPayload(update) || '');
    const callbackId = getCallbackId(update);
    const chatId = Number(getChatId(update) || 0);
    const key = getSessionKey(update);

    if (!key) return next();

    const esc = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const moscowNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));

    const dateKey = (d) => {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    const monthKey = (d = moscowNow()) => {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };

    const todayKey = () => dateKey(moscowNow());

    const monthDate = (mk) => {
      const m = String(mk || monthKey()).match(/^(\d{4})-(\d{2})$/);
      if (!m) return moscowNow();
      return new Date(Number(m[1]), Number(m[2]) - 1, 1);
    };

    const humanMonth = (mk) => {
      const d = monthDate(mk);
      return d.toLocaleDateString('ru-RU', {
        month: 'long',
        year: 'numeric',
        timeZone: 'Europe/Moscow',
      });
    };

    const humanDay = (dk) => {
      const [y, m, d] = String(dk || '').split('-').map(Number);
      const dt = new Date(Date.UTC(y || 2026, (m || 1) - 1, d || 1, 12, 0, 0));
      return dt.toLocaleDateString('ru-RU', {
        weekday: 'short',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Europe/Moscow',
      });
    };

    const normalizeTime = (input) => {
      const raw = String(input || '').trim();
      let m = raw.match(/^(\d{1,2})[:.\s](\d{2})$/);
      if (!m) m = raw.match(/^(\d{1,2})(\d{2})$/);
      if (!m) return null;

      const h = Number(m[1]);
      const min = Number(m[2]);

      if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
      if (h < 0 || h > 23 || min < 0 || min > 59) return null;

      return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    };

    const compactTime = (value) => {
      const t = normalizeTime(value);
      return t ? t.replace(':', '') : '';
    };

    const dateFromDayTime = (day, time) => {
      const clean = String(time || '').replace(/\D/g, '').padStart(4, '0').slice(0, 4);
      return new Date(`${day}T${clean.slice(0, 2)}:${clean.slice(2, 4)}:00+03:00`);
    };

    const getDraft = async () => {
      const session = await getSession(key);
      const data = session && session.data ? session.data : {};
      const raw = data.draft ? data.draft : data;

      try {
        return typeof safeDraft === 'function' ? safeDraft(raw) : (raw || {});
      } catch {
        return raw || {};
      }
    };

    const hasDraftContent = (draft) => {
      try {
        if (typeof hasContent === 'function') return Boolean(hasContent(draft));
      } catch {}

      return Boolean(
        String(draft?.content?.text || draft?.text || draft?.caption || '').trim() ||
        (Array.isArray(draft?.content?.attachments) && draft.content.attachments.length) ||
        (Array.isArray(draft?.attachments) && draft.attachments.length) ||
        draft?.photo ||
        draft?.video ||
        draft?.media
      );
    };

    const channelIds = (draft) => {
      if (!draft || typeof draft !== 'object') return [];
      if (Array.isArray(draft.channelIds)) return draft.channelIds.map(Number).filter(Boolean);
      if (Array.isArray(draft.channel_ids)) return draft.channel_ids.map(Number).filter(Boolean);
      if (Array.isArray(draft.channels)) return draft.channels.map(x => Number(x?.id || x?.channel_id || x)).filter(Boolean);
      if (draft.channelId) return [Number(draft.channelId)].filter(Boolean);
      if (draft.channel_id) return [Number(draft.channel_id)].filter(Boolean);
      return [];
    };

    const answer = async (text, rows = []) => {
      const cleanRows = Array.isArray(rows)
        ? rows.map(r => Array.isArray(r) ? r.filter(Boolean) : []).filter(r => r.length)
        : [];

      if (callbackId && typeof cb === 'function') {
        return cb(callbackId, String(text || 'LinkRay'), cleanRows, 'html');
      }

      if (callbackId && typeof answerCallback === 'function') {
        return answerCallback({
          callbackId,
          text: String(text || 'LinkRay'),
          format: 'html',
          attachments: cleanRows.length ? inlineKeyboard(cleanRows) : [],
        });
      }

      if (chatId && typeof sendMaxMessage === 'function') {
        return sendMaxMessage({
          chatId,
          text: String(text || 'LinkRay'),
          format: 'html',
          attachments: cleanRows.length ? inlineKeyboard(cleanRows) : [],
        });
      }
    };

    const extractMonth = (value) => {
      const p = String(value || '');
      let m = p.match(/(?:month|cal_month|calendar_month):(\d{4}-\d{2})/i);
      if (m) return m[1];

      m = p.match(/(\d{4})-(\d{2})(?!-\d{2})/);
      return m ? `${m[1]}-${m[2]}` : null;
    };

    const extractDay = (value) => {
      const m = String(value || '').match(/(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };

    const renderMonth = async (mk = monthKey()) => {
      const base = monthDate(mk);
      const year = base.getFullYear();
      const month = base.getMonth();

      const first = new Date(year, month, 1);
      const last = new Date(year, month + 1, 0);

      let startWeekday = first.getDay();
      if (startWeekday === 0) startWeekday = 7;

      const prev = monthKey(new Date(year, month - 1, 1));
      const nextM = monthKey(new Date(year, month + 1, 1));
      const today = todayKey();

      const rows = [
        [
          callbackButton('⬅️', `lr_cal2:month:${prev}`),
          callbackButton(` ${humanMonth(monthKey(base))} `, 'lr_cal2:noop'),
          callbackButton('➡️', `lr_cal2:month:${nextM}`),
        ],
        [
          callbackButton('Пн', 'lr_cal2:noop'),
          callbackButton('Вт', 'lr_cal2:noop'),
          callbackButton('Ср', 'lr_cal2:noop'),
          callbackButton('Чт', 'lr_cal2:noop'),
          callbackButton('Пт', 'lr_cal2:noop'),
          callbackButton('Сб', 'lr_cal2:noop'),
          callbackButton('Вс', 'lr_cal2:noop'),
        ],
      ];

      let row = [];

      for (let i = 1; i < startWeekday; i++) {
        row.push(callbackButton(' ', 'lr_cal2:noop'));
      }

      for (let day = 1; day <= last.getDate(); day++) {
        const dk = dateKey(new Date(year, month, day));
        const isPast = dk < today;
        const label = dk === today ? `•${day}•` : String(day);

        row.push(callbackButton(isPast ? '·' : label, isPast ? 'lr_cal2:noop' : `lr_cal2:day:${dk}`));

        if (row.length === 7) {
          rows.push(row);
          row = [];
        }
      }

      if (row.length) {
        while (row.length < 7) row.push(callbackButton(' ', 'lr_cal2:noop'));
        rows.push(row);
      }

      rows.push([callbackButton('⬅️ К выпуску', 'editor:next')]);

      return answer(
        `━━━━━━━━━━━━━━\n📅 <b>Календарь публикации</b>\n\nВыберите день публикации.\n━━━━━━━━━━━━━━`,
        rows
      );
    };

    const renderDay = async (day) => {
      const times = ['09:00', '12:00', '15:00', '18:00', '21:00', '23:00'];

      const rows = [];
      for (let i = 0; i < times.length; i += 3) {
        rows.push(times.slice(i, i + 3).map(t => callbackButton(t, `lr_cal2:pick:${day}:${compactTime(t)}`)));
      }

      rows.push([callbackButton('✍️ Ввести время', `lr_cal2:manual:${day}`)]);
      rows.push([callbackButton('⬅️ К месяцу', `lr_cal2:month:${String(day).slice(0, 7)}`)]);

      return answer(
        `━━━━━━━━━━━━━━\n🕒 <b>Время публикации</b>\n\n${esc(humanDay(day))}\n\nВыберите время или введите вручную.\n━━━━━━━━━━━━━━`,
        rows
      );
    };

    const scheduleAt = async (day, time) => {
      const nice = normalizeTime(time);
      const publishAt = dateFromDayTime(day, nice);

      if (!nice || !publishAt || Number.isNaN(publishAt.getTime())) {
        return answer('⚠️ Не удалось разобрать время.', [
          [callbackButton('⬅️ Назад к дате', `lr_cal2:day:${day}`)],
        ]);
      }

      if (publishAt.getTime() <= Date.now()) {
        return answer(`⚠️ Это время уже прошло: ${esc(nice)}.`, [
          [callbackButton('⬅️ Назад к дате', `lr_cal2:day:${day}`)],
        ]);
      }

      const draft = await getDraft();

      if (!channelIds(draft).length) {
        return answer('⚠️ Сначала выберите канал.', [
          [callbackButton('⬅️ В редактор', 'editor:back')],
        ]);
      }

      if (!hasDraftContent(draft)) {
        return answer('⚠️ Пост пустой. Сначала добавьте текст или медиа.', [
          [callbackButton('⬅️ В редактор', 'editor:back')],
        ]);
      }

      const ids = await scheduleDraft(draft, key, publishAt);
      await clearSession(key);

      if (typeof afterPlanned === 'function') {
        await afterPlanned(chatId, draft, publishAt, ids);
      } else {
        await answer(
          `━━━━━━━━━━━━━━\n✅ <b>Пост отложен</b>\n\nПубликация: ${esc(humanDay(day))}, ${esc(nice)} МСК\n━━━━━━━━━━━━━━`,
          [
            [callbackButton('Посты', 'post:all')],
            [callbackButton('LinkRay Studio', 'main:posting')],
          ]
        );
      }

      return null;
    };

    const isCalendarPayload =
      payload === 'schedule:calendar' ||
      payload === 'calendar' ||
      payload === 'lr_cal2:noop' ||
      payload.startsWith('schedule:week:') ||
      payload.startsWith('schedule:day:') ||
      payload.startsWith('schedule:time:') ||
      payload.startsWith('lr_clean_cal:month:') ||
      payload.startsWith('lr_clean_cal:day:') ||
      payload.startsWith('lr_cal2:');

    if (isCalendarPayload) {
      if (payload === 'lr_cal2:noop') {
        if (callbackId && typeof answerCallback === 'function') {
          try {
            await answerCallback({ callbackId, notification: 'Выберите дату' });
          } catch {}
        }
        return res.json({ ok: true });
      }

      if (payload.startsWith('lr_cal2:pick:')) {
        const parts = payload.split(':');
        await scheduleAt(parts[2], parts[3]);
        return res.json({ ok: true });
      }

      if (payload.startsWith('schedule:time:')) {
        const parts = payload.split(':');
        await scheduleAt(parts[2], parts[3]);
        return res.json({ ok: true });
      }

      if (payload.startsWith('lr_cal2:manual:')) {
        const day = payload.split(':')[2];
        const draft = await getDraft();

        await setSession(key, 'wait_schedule_time', { draft, dayKey: day });

        await answer(
          `━━━━━━━━━━━━━━\n✍️ <b>Введите время</b>\n\n${esc(humanDay(day))}\n\nФормат: 18:30 или 1830.\n━━━━━━━━━━━━━━`,
          [[callbackButton('⬅️ Назад к дате', `lr_cal2:day:${day}`)]]
        );

        return res.json({ ok: true });
      }

      const day = extractDay(payload);

      if (day && (payload.includes(':day:') || payload.startsWith('schedule:day:'))) {
        await renderDay(day);
        return res.json({ ok: true });
      }

      const mk = extractMonth(payload) || (day ? String(day).slice(0, 7) : monthKey());
      await renderMonth(mk);
      return res.json({ ok: true });
    }

    const isCpmPayload = (() => {
      const low = String(payload || '').toLowerCase().replace(/\s+/g, '');

      if (!low) return false;

      const exact = new Set([
        'cpm',
        'spm',
        'спм',
        'editor:cpm',
        'editor:spm',
        'editor:спм',
        'editor:ad',
        'editor:advert',
        'editor:adpost',
        'editor:toggle_ad',
        'editor:ad_toggle',
        'editor:is_ad',
        'post:cpm',
        'post:spm',
        'publish:cpm',
        'publish:spm',
        'ad:toggle',
        'cpm:toggle',
        'spm:toggle',
      ]);

      if (exact.has(low)) return true;

      return low.startsWith('editor:') && /(cpm|spm|спм|advert|adpost|реклам)/i.test(low);
    })();

    const messageIdOf = (value) => {
      if (!value) return null;
      if (typeof value === 'string' || typeof value === 'number') return String(value);
      return (
        value.message_id ||
        value.messageId ||
        value.id ||
        value.message?.message_id ||
        value.message?.id ||
        value.result?.message_id ||
        value.result?.id ||
        null
      );
    };

    if (isCpmPayload && chatId) {
      const draft = await getDraft();

      draft.isAd = true;
      draft.is_ad = true;
      draft.ad = true;
      draft.signatureEnabled = false;
      draft.signature = null;
      draft.signatureText = '';
      draft.reportAfterHours = 24;

      if (!draft.autoDeleteMinutes) draft.autoDeleteMinutes = 2880;
      if (!draft.campaignId) draft.campaignId = `lr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      draft.reportGroupId = draft.campaignId;

      const oldPreviewId =
        draft.previewMessageId ||
        draft.preview_message_id ||
        draft.previewId ||
        draft.preview_id ||
        null;

      if (oldPreviewId && typeof deleteMaxMessage === 'function') {
        try {
          await deleteMaxMessage(oldPreviewId);
        } catch (e) {
          console.error('[LR_FINAL_CAL_CPM_V2 delete preview]', e?.message || e);
        }
      }

      draft.previewMessageId = null;
      draft.preview_message_id = null;

      if (typeof sendDraftPreview === 'function' && hasDraftContent(draft)) {
        try {
          const previewResult = await sendDraftPreview(chatId, draft);
          const newPreviewId = messageIdOf(previewResult);

          if (newPreviewId) {
            draft.previewMessageId = newPreviewId;
            draft.preview_message_id = newPreviewId;
          }
        } catch (e) {
          console.error('[LR_FINAL_CAL_CPM_V2 preview]', e?.message || e);
        }
      }

      await setSession(key, 'wait_cpm', { draft });

      if (callbackId && typeof answerCallback === 'function') {
        try {
          await answerCallback({ callbackId, notification: 'Рекламный пост включён' });
        } catch {}
      }

      await sendMaxMessage({
        chatId,
        text: '━━━━━━━━━━━━━━\n📊 <b>CPM рекламного поста</b>\n\nВведите CPM числом, например: <b>1000</b>.\n\nАвтоподпись для рекламного поста отключена.\n━━━━━━━━━━━━━━',
        format: 'html',
        attachments: inlineKeyboard([
          [callbackButton('⬅️ Назад в редактор', 'editor:back')],
        ]),
      });

      return res.json({ ok: true });
    }

    return next();
  } catch (e) {
    console.error('[LR_FINAL_CAL_CPM_V2]', e?.stack || e);
    return next();
  }
});
/* LR_FINAL_CAL_CPM_V2_END */

/* LR_EDITOR_CORE_V1_START */
app.use(async function lrEditorCoreV1(req, res, next) {
  try {
    if (req.method !== 'POST') return next();

    const update = req.body || {};
    const payload = String(getCallbackPayload(update) || '');
    const callbackId = getCallbackId(update);
    const chatId = Number(getChatId(update) || 0);
    const key = getSessionKey(update);

    if (!key) return next();

    function rowsOf(result) {
      if (Array.isArray(result)) return result;
      if (result && Array.isArray(result.rows)) return result.rows;
      return [];
    }

    function esc(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function plain(value) {
      return String(value ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function short(value, max = 64) {
      const t = plain(value);
      if (!t) return 'пост без текста';
      return t.length > max ? t.slice(0, max).trim() + '…' : t;
    }

    function sessionDraft(session) {
      const data = session && session.data ? session.data : {};
      const raw = data.draft ? data.draft : data;

      try {
        return typeof safeDraft === 'function' ? safeDraft(raw) : (raw || {});
      } catch {
        return raw || {};
      }
    }

    function normalizeTime(input) {
      const raw = String(input || '').trim();
      let m = raw.match(/^(\d{1,2})[:.\s](\d{2})$/);
      if (!m) m = raw.match(/^(\d{1,2})(\d{2})$/);
      if (!m) return null;

      const h = Number(m[1]);
      const min = Number(m[2]);

      if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
      if (h < 0 || h > 23 || min < 0 || min > 59) return null;

      return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }

    function compactTime(value) {
      const t = normalizeTime(value);
      return t ? t.replace(':', '') : '';
    }

    function isAdDraft(draft) {
      return Boolean(
        draft &&
        (
          draft.isAd === true ||
          draft.is_ad === true ||
          draft.ad === true ||
          String(draft.type || '').toLowerCase() === 'ad' ||
          String(draft.postType || '').toLowerCase() === 'ad' ||
          draft.cpm
        )
      );
    }

    function forceAd(draft) {
      if (!draft || typeof draft !== 'object') draft = {};
      draft.isAd = true;
      draft.is_ad = true;
      draft.signatureEnabled = false;
      draft.signature = null;
      draft.signatureText = '';
      draft.reportAfterHours = 24;
      if (!draft.autoDeleteMinutes) draft.autoDeleteMinutes = 2880;
      if (!draft.campaignId) draft.campaignId = `lr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      draft.reportGroupId = draft.campaignId;
      return draft;
    }

    function channelIds(draft) {
      if (!draft || typeof draft !== 'object') return [];

      if (Array.isArray(draft.channelIds)) {
        return draft.channelIds.map(Number).filter(Boolean);
      }

      if (Array.isArray(draft.channel_ids)) {
        return draft.channel_ids.map(Number).filter(Boolean);
      }

      if (draft.channelId) return [Number(draft.channelId)].filter(Boolean);
      if (draft.channel_id) return [Number(draft.channel_id)].filter(Boolean);

      return [];
    }

    function hasDraftContent(draft) {
      try {
        if (typeof hasContent === 'function') return Boolean(hasContent(draft));
      } catch {}

      return Boolean(
        String(draft?.content?.text || draft?.text || '').trim() ||
        (Array.isArray(draft?.content?.attachments) && draft.content.attachments.length) ||
        (Array.isArray(draft?.attachments) && draft.attachments.length)
      );
    }

    function todayKey() {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function monthFromDay(dayKey) {
      return String(dayKey || todayKey()).slice(0, 7);
    }

    function dateFromDayTime(dayKey, hhmm) {
      const clean = String(hhmm || '').replace(/\D/g, '').padStart(4, '0').slice(0, 4);
      return new Date(`${dayKey}T${clean.slice(0, 2)}:${clean.slice(2)}:00+03:00`);
    }

    function humanDay(dayKey) {
      try {
        const [y, m, d] = String(dayKey).split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        return dt.toLocaleDateString('ru-RU', {
          weekday: 'short',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          timeZone: 'Europe/Moscow'
        });
      } catch {
        return String(dayKey || '');
      }
    }

    function humanMonth(monthKey) {
      try {
        const [y, m] = String(monthKey).split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
        return dt.toLocaleDateString('ru-RU', {
          month: 'long',
          year: 'numeric',
          timeZone: 'Europe/Moscow'
        });
      } catch {
        return String(monthKey || '');
      }
    }

    async function reply(text, rows = []) {
      const safeText = String(text || 'LinkRay');

      if (callbackId && typeof cb === 'function') {
        return cb(callbackId, safeText, rows);
      }

      if (chatId && typeof msg === 'function') {
        return msg(chatId, safeText, rows);
      }

      if (chatId && typeof sendMaxMessage === 'function') {
        return sendMaxMessage({
          chatId,
          text: safeText,
          format: 'html',
          attachments: rows && rows.length && typeof inlineKeyboard === 'function' ? inlineKeyboard(rows) : []
        });
      }

      return null;
    }

    async function notice(text) {
      if (!callbackId || typeof answerCallback !== 'function') return;
      try {
        await answerCallback({ callbackId, notification: String(text || '') });
      } catch {}
    }

    async function currentDraft() {
      const session = await getSession(key);
      const draft = sessionDraft(session);
      if (isAdDraft(draft)) forceAd(draft);
      return { session, draft, isAd: isAdDraft(draft), channelIds: channelIds(draft) };
    }

    async function ensureTimesTable() {
      await query(`
        CREATE TABLE IF NOT EXISTS public.channel_saved_times (
          id serial PRIMARY KEY,
          channel_id integer NOT NULL,
          time_text text NOT NULL,
          is_ad boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await query(`ALTER TABLE public.channel_saved_times ADD COLUMN IF NOT EXISTS is_ad boolean NOT NULL DEFAULT false`);
      await query(`ALTER TABLE public.channel_saved_times ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

      await query(`
        DO $$
        DECLARE
          cname text;
        BEGIN
          FOR cname IN
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = 'public.channel_saved_times'::regclass
              AND contype = 'u'
              AND pg_get_constraintdef(oid) ILIKE '%channel_id%'
              AND pg_get_constraintdef(oid) ILIKE '%time_text%'
          LOOP
            EXECUTE format('ALTER TABLE public.channel_saved_times DROP CONSTRAINT IF EXISTS %I', cname);
          END LOOP;
        END $$;
      `);

      await query(`DROP INDEX IF EXISTS public.idx_channel_saved_times_channel_time`);
      await query(`DROP INDEX IF EXISTS public.idx_channel_saved_times_channel_owner`);
      await query(`DROP INDEX IF EXISTS public.idx_channel_saved_times_channel_time_ad`);

      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_saved_times_channel_time_ad
        ON public.channel_saved_times(channel_id, time_text, is_ad)
      `);
    }

    async function loadTimes(ids, isAd) {
      await ensureTimesTable();
      if (!ids.length) return [];

      const result = await query(
        `SELECT DISTINCT time_text
         FROM public.channel_saved_times
         WHERE channel_id = ANY($1::int[])
           AND is_ad = $2
         ORDER BY time_text ASC`,
        [ids.map(Number), Boolean(isAd)]
      );

      return rowsOf(result)
        .map(r => normalizeTime(r.time_text))
        .filter(Boolean);
    }

    async function saveTime(ids, timeText, isAd) {
      await ensureTimesTable();

      for (const id of ids.map(Number).filter(Boolean)) {
        await query(
          `INSERT INTO public.channel_saved_times(channel_id, time_text, is_ad, updated_at)
           VALUES($1, $2, $3, now())
           ON CONFLICT(channel_id, time_text, is_ad)
           DO UPDATE SET updated_at = now()`,
          [id, timeText, Boolean(isAd)]
        );
      }
    }

    async function deleteTime(ids, timeText, isAd) {
      await ensureTimesTable();
      if (!ids.length) return;

      await query(
        `DELETE FROM public.channel_saved_times
         WHERE channel_id = ANY($1::int[])
           AND time_text = $2
           AND is_ad = $3`,
        [ids.map(Number), timeText, Boolean(isAd)]
      );
    }

    async function postsForDay(dayKey, ids, isAd) {
      try {
        const result = await query(
          `SELECT id,
                  text,
                  status,
                  is_ad,
                  to_char(publish_at AT TIME ZONE 'Europe/Moscow', 'HH24:MI') AS time_text
           FROM public.scheduled_posts
           WHERE publish_at >= $1::date
             AND publish_at < ($1::date + interval '1 day')
             AND COALESCE(is_ad,false) = $3
             AND ($2::int[] IS NULL OR channel_id = ANY($2::int[]))
           ORDER BY publish_at ASC, id ASC
           LIMIT 80`,
          [dayKey, ids.length ? ids.map(Number) : null, Boolean(isAd)]
        );

        return rowsOf(result).map(p => ({
          id: p.id,
          time: String(p.time_text || '').slice(0, 5),
          text: short(p.text || '', 52),
          status: String(p.status || 'scheduled')
        }));
      } catch (e) {
        console.error('[LR_EDITOR_CORE_V1 postsForDay]', e?.message || e);
        return [];
      }
    }

    async function showEditorClean(draft, msgText = '') {
      if (isAdDraft(draft)) forceAd(draft);

      if (chatId && draft.previewMessageId && typeof sendDraftPreview === 'function') {
        try {
          const mid = await sendDraftPreview(chatId, draft);
          if (mid) draft.previewMessageId = mid;
        } catch (e) {
          console.error('[LR_EDITOR_CORE_V1 preview edit]', e?.message || e);
        }
      }

      await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });

      if (msgText) await notice(msgText);

      if (callbackId && typeof showEditor === 'function') {
        return showEditor(callbackId, key, draft);
      }

      if (chatId && typeof sendStudioEditorMessage === 'function') {
        return sendStudioEditorMessage(chatId, draft);
      }

      return reply(
        typeof editorMenuText === 'function' ? editorMenuText() : 'Редактор LinkRay',
        typeof editorMenuRows === 'function' ? editorMenuRows(draft) : []
      );
    }

    async function showMonth(monthKey = null) {
      const ctx = await currentDraft();
      const isAd = ctx.isAd;
      const mk = monthKey || monthFromDay(todayKey());

      const [year, month] = mk.split('-').map(Number);
      const first = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
      const last = new Date(Date.UTC(year, month, 0, 12, 0, 0));

      let weekday = first.getUTCDay();
      if (weekday === 0) weekday = 7;

      const rows = [
        [
          callbackButton('Пн', 'lr_core:noop'),
          callbackButton('Вт', 'lr_core:noop'),
          callbackButton('Ср', 'lr_core:noop'),
          callbackButton('Чт', 'lr_core:noop'),
          callbackButton('Пт', 'lr_core:noop'),
          callbackButton('Сб', 'lr_core:noop'),
          callbackButton('Вс', 'lr_core:noop')
        ]
      ];

      let line = [];

      for (let i = 1; i < weekday; i++) {
        line.push(callbackButton('·', 'lr_core:noop'));
      }

      for (let day = 1; day <= last.getUTCDate(); day++) {
        const dayKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const label = dayKey === todayKey() ? `•${day}•` : String(day);

        line.push(callbackButton(label, `lr_core:day:${dayKey}`));

        if (line.length === 7) {
          rows.push(line);
          line = [];
        }
      }

      if (line.length) {
        while (line.length < 7) line.push(callbackButton('·', 'lr_core:noop'));
        rows.push(line);
      }

      const prev = new Date(Date.UTC(year, month - 2, 1, 12, 0, 0));
      const nextMonth = new Date(Date.UTC(year, month, 1, 12, 0, 0));

      const prevKey = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
      const nextKey = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}`;

      rows.push([
        callbackButton('⬅️', `lr_core:month:${prevKey}`),
        callbackButton('Сегодня', `lr_core:day:${todayKey()}`),
        callbackButton('➡️', `lr_core:month:${nextKey}`)
      ]);

      rows.push([callbackButton('⬅️ К выпуску', 'editor:next')]);

      return reply(
        `━━━━━━━━━━━━━━
${isAd ? '💼 Рекламный календарь' : '📅 Календарь'}

${esc(humanMonth(mk))}

Календарь идёт по неделям: 7 дней в ряд.
Выберите день публикации.
━━━━━━━━━━━━━━`,
        rows
      );
    }

    async function showDay(dayKey) {
      const ctx = await currentDraft();
      const saved = await loadTimes(ctx.channelIds, ctx.isAd);
      const posts = await postsForDay(dayKey, ctx.channelIds, ctx.isAd);
      const busy = new Set(posts.map(p => p.time).filter(Boolean));

      const visibleTimes = saved.filter(t => {
        if (busy.has(t)) return false;
        if (dateFromDayTime(dayKey, t).getTime() <= Date.now()) return false;
        return true;
      });

      const rows = [];

      for (let i = 0; i < visibleTimes.length; i += 3) {
        rows.push(
          visibleTimes.slice(i, i + 3).map(t =>
            callbackButton(`${ctx.isAd ? '💼' : '💾'} ${t}`, `lr_core:pick:${dayKey}:${compactTime(t)}`)
          )
        );
      }

      rows.push([
        callbackButton(
          ctx.isAd ? '💼 Рекламное время' : '💾 Сохранённое время',
          `lr_core:manage:${dayKey}`
        )
      ]);

      rows.push([callbackButton('⬅️ К месяцу', `lr_core:month:${monthFromDay(dayKey)}`)]);

      const postsText = posts.length
        ? posts.map(p => {
            const status =
              p.status === 'published' ? 'опубликован' :
              p.status === 'deleted' ? 'удалён' :
              'отложен';

            return `• ${esc(p.time)} — ${esc(p.text)} (${status})`;
          }).join('\n')
        : 'постов на этот день нет';

      const savedText = saved.length
        ? saved.map(t => `${ctx.isAd ? '💼' : '💾'} ${esc(t)}`).join(' ')
        : 'пока нет';

      return reply(
        `━━━━━━━━━━━━━━
📅 ${esc(humanDay(dayKey))}

<b>Посты на этот день:</b>
${postsText}

<b>${ctx.isAd ? 'Рекламное время' : 'Сохранённое время'}:</b>
${savedText}

Если время занято постом или уже прошло, кнопкой оно не показывается.
━━━━━━━━━━━━━━`,
        rows
      );
    }

    async function showManage(dayKey) {
      const ctx = await currentDraft();
      const saved = await loadTimes(ctx.channelIds, ctx.isAd);

      const rows = [
        [callbackButton('➕ Добавить время', `lr_core:add:${dayKey}`)]
      ];

      for (let i = 0; i < saved.length; i += 2) {
        rows.push(
          saved.slice(i, i + 2).map(t =>
            callbackButton(`🗑 ${t}`, `lr_core:del:${dayKey}:${compactTime(t)}`)
          )
        );
      }

      rows.push([callbackButton('⬅️ Назад к дате', `lr_core:day:${dayKey}`)]);

      return reply(
        `━━━━━━━━━━━━━━
${ctx.isAd ? '💼 Рекламное время' : '💾 Сохранённое время'}

Можно добавить или удалить время.

Обычное и рекламное время хранятся отдельно.

Сейчас:
${saved.length ? saved.map(t => `• ${esc(t)}`).join('\n') : 'времени пока нет'}
━━━━━━━━━━━━━━`,
        rows
      );
    }

    async function askAddTime(dayKey) {
      const ctx = await currentDraft();

      await setSession(key, 'lr_core_wait_time_v1', {
        draft: ctx.draft,
        isAd: ctx.isAd,
        dayKey
      });

      return reply(
        `━━━━━━━━━━━━━━
${ctx.isAd ? '💼 Введите рекламное время.' : '💾 Введите сохранённое время.'}

Пример: <b>18:30</b> или <b>1830</b>.

После добавления оно появится кнопкой в меню даты, если время свободно.
━━━━━━━━━━━━━━`,
        [[callbackButton('⬅️ Назад к дате', `lr_core:day:${dayKey}`)]]
      );
    }

    async function channelsText(ids) {
      try {
        const channels = await getChannelsByIds(ids);
        if (typeof channelsLines === 'function') return channelsLines(channels);

        return channels.map(ch => `• ${esc(ch.title || ch.name || ('Канал ' + ch.id))}`).join('\n');
      } catch {
        return ids.map(id => `• Канал #${id}`).join('\n');
      }
    }

    function publicBase() {
      return String(
        process.env.PUBLIC_BASE_URL ||
        process.env.SITE_URL ||
        process.env.WEBAPP_URL ||
        process.env.LINKRAY_PUBLIC_URL ||
        'https://linkray.ru'
      ).replace(/\/+$/, '');
    }

    async function scheduleAt(dayKey, rawTime) {
      const ctx = await currentDraft();
      const nice = normalizeTime(rawTime);

      if (!nice) {
        return reply(
          '⚠️ Некорректное время.',
          [[callbackButton('⬅️ К календарю', 'schedule:calendar')]]
        );
      }

      const publishAt = dateFromDayTime(dayKey, nice);

      if (publishAt.getTime() <= Date.now()) {
        await notice('Это время уже прошло');
        return showDay(dayKey);
      }

      if (!ctx.channelIds.length) {
        return reply(
          `━━━━━━━━━━━━━━
⚠️ Сначала выберите канал.
━━━━━━━━━━━━━━`,
          [[callbackButton('⬅️ В редактор', 'editor:back')]]
        );
      }

      if (!hasDraftContent(ctx.draft)) {
        return reply(
          `━━━━━━━━━━━━━━
⚠️ Пост пустой. Сначала добавьте текст или медиа.
━━━━━━━━━━━━━━`,
          [[callbackButton('⬅️ В редактор', 'editor:back')]]
        );
      }

      if (ctx.isAd) {
        forceAd(ctx.draft);

        if (!ctx.draft.cpm) {
          await setSession(key, ctx.draft.postId ? 'edit_existing' : 'edit_draft', { draft: ctx.draft });

          return reply(
            `━━━━━━━━━━━━━━
⚠️ Для рекламного поста сначала укажите CPM.
━━━━━━━━━━━━━━`,
            [
              [callbackButton('💰 Указать CPM', 'editor:cpm')],
              [callbackButton('⬅️ В редактор', 'editor:back')]
            ]
          );
        }

        ctx.draft.trackingUrl = `${publicBase()}/analytics/stats/${ctx.draft.campaignId}`;
        ctx.draft.analyticsUrl = ctx.draft.trackingUrl;
        ctx.draft.observerUrl = ctx.draft.trackingUrl;
      }

      let ids = [];

      try {
        ids = await scheduleDraft(ctx.draft, key, publishAt);
      } catch (e) {
        console.error('[LR_EDITOR_CORE_V1 scheduleDraft]', e?.stack || e);

        return reply(
          `⚠️ Ошибка планирования:\n${esc(e?.message || e)}`,
          [[callbackButton('⬅️ К календарю', 'schedule:calendar')]]
        );
      }

      await clearSession(key);

      const chLines = await channelsText(ctx.channelIds);

      if (ctx.isAd) {
        return reply(
          `━━━━━━━━━━━━━━
💼 <b>Рекламный пост отложен</b>

📝 Сообщение «${esc(short(ctx.draft.content?.text || '', 80))}»

📌 <b>Статус:</b> отложено
🕒 <b>Публикация:</b> ${esc(humanDay(dayKey))}, ${esc(nice)} МСК

📡 <b>Канал:</b>
${chLines}

💰 <b>CPM:</b> ${esc(ctx.draft.cpm)} ₽
🗑 <b>Автоудаление:</b> ${ctx.draft.autoDeleteMinutes ? Math.round(Number(ctx.draft.autoDeleteMinutes) / 60) + 'ч' : 'без удаления'}
📊 <b>Отчёт:</b> через 24ч после публикации

🔗 <b>Ссылка наблюдателя:</b>
<a href="${esc(ctx.draft.trackingUrl)}">${esc(ctx.draft.trackingUrl)}</a>

━━━━━━━━━━━━━━
🧬 <a href="https://max.ru/se13353901_bot">LinkRay</a> — постинг, рекламные выходы и аналитика в MAX`,
          [
            [callbackButton('📁 Посты', 'post:all')],
            [callbackButton('🧬 LinkRay Studio', 'main:posting')]
          ]
        );
      }

      return reply(
        `━━━━━━━━━━━━━━
✅ <b>Пост отложен</b>

🕒 <b>Публикация:</b> ${esc(humanDay(dayKey))}, ${esc(nice)} МСК

📡 <b>Канал:</b>
${chLines}

Пост добавлен в очередь.
━━━━━━━━━━━━━━`,
        [
          [callbackButton('📁 Посты', 'post:all')],
          [callbackButton('🧬 LinkRay Studio', 'main:posting')]
        ]
      );
    }

    
/* LR_CPM_PREVIEW_FINAL_V4_START */
async function lrCpmPreviewFinalV4(chatId, key, text, session) {
  const cpm = Number(String(text || '').replace(',', '.').replace(/[^0-9.]/g, ''));

  if (!Number.isFinite(cpm) || cpm <= 0) {
    await msg(chatId, '⚠️ Введите число, например 1000.');
    return;
  }

  const lrEsc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const draft = forceAd(sessionDraft(session));

  draft.cpm = cpm;
  draft.isAd = true;
  draft.is_ad = true;
  draft.ad = true;
  draft.signatureEnabled = false;
  draft.signature = null;
  draft.signatureText = '';
  draft.reportAfterHours = 24;

  if (!draft.autoDeleteMinutes) draft.autoDeleteMinutes = 2880;
  if (!draft.campaignId) draft.campaignId = `lr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  draft.reportGroupId = draft.campaignId;

  const oldPreviewId =
    draft.previewMessageId ||
    draft.preview_message_id ||
    draft.previewId ||
    draft.preview_id ||
    null;

  if (oldPreviewId && typeof deleteMaxMessage === 'function') {
    try {
      await deleteMaxMessage(oldPreviewId);
    } catch (e) {
      console.error('[LR_CPM_PREVIEW_FINAL_V4 delete old preview]', e?.message || e);
    }
  }

  draft.previewMessageId = null;
  draft.preview_message_id = null;
  draft.previewId = null;
  draft.preview_id = null;

  await setSession(key, 'publish_menu', { draft });

  await msg(chatId, `✅ CPM установлен: <b>${lrEsc(cpm)} ₽</b>`);

  let newPreviewId = null;

  if (typeof sendDraftPreview === 'function' && hasContent(draft)) {
    try {
      const result = await sendDraftPreview(chatId, draft);

      if (result) {
        if (typeof result === 'string' || typeof result === 'number') {
          newPreviewId = String(result);
        } else if (typeof extractMessageId === 'function') {
          newPreviewId = extractMessageId(result);
        } else {
          newPreviewId =
            result.message_id ||
            result.messageId ||
            result.id ||
            result.mid ||
            result.message?.id ||
            result.message?.message_id ||
            null;
        }
      }
    } catch (e) {
      console.error('[LR_CPM_PREVIEW_FINAL_V4 send new preview]', e?.message || e);
    }
  }

  if (newPreviewId) {
    draft.previewMessageId = newPreviewId;
    draft.preview_message_id = newPreviewId;
  }

  await setSession(key, 'publish_menu', { draft });

  let channelsText = '• канал выбран';

  try {
    const channels = await getChannelsByIds(channelIds(draft));
    channelsText = channelsLines(channels);
  } catch (e) {
    console.error('[LR_CPM_PREVIEW_FINAL_V4 channels]', e?.message || e);
  }

  const rows = [
    ...autoDeleteRows('publish'),
    [callbackButton('📅 Календарь', 'schedule:calendar')],
    [callbackButton('⚡ Опубликовать сейчас', 'publish:now')],
    [callbackButton('⬅️ В редактор', 'editor:back'), callbackButton('❌ Отмена', 'post:cancel')],
  ];

  await msg(
    chatId,
    `━━━━━━━━━━━━━━\n🚀 <b>К выпуску</b>\n\n📡 <b>Каналы:</b>\n${channelsText}\n\n🗑 Автоудаление: ${lrEsc(formatAutoDelete(draft.autoDeleteMinutes))}\n💼 Реклама: да · CPM ${lrEsc(cpm)} ₽\n📊 Отчёт: через 24ч\n\nВыберите срок автоудаления кнопками или способ публикации.\n━━━━━━━━━━━━━━`,
    rows,
    'html'
  );
}
/* LR_CPM_PREVIEW_FINAL_V4_END */

// ===== MESSAGE STATES =====
    if (!payload) {
      const text = String(getMessageText(update) || '').trim();
      if (!text) return next();

      const session = await getSession(key);
      const state = String(session?.state || '');

      if (state === 'lr_core_wait_cpm_v1' || state === 'wait_cpm') {
        await lrCpmPreviewFinalV4(chatId, key, text, session);
        return res.json({ ok: true });
      } const isWaitTime =
        state === 'lr_core_wait_time_v1' ||
        state === 'lr_clean_wait_add_saved_time_v1' ||
        state === 'lr_wait_calendar_saved_time' ||
        state === 'lr_wait_saved_time' ||
        state === 'lr_wait_ad_time' ||
        state === 'wait_saved_time' ||
        state === 'wait_ad_time';

      if (isWaitTime) {
        const nice = normalizeTime(text);
        const data = session?.data || {};
        const draft = sessionDraft(session);
        const ids = channelIds(draft);
        const isAd = Boolean(data.isAd || isAdDraft(draft));
        const dayKey = data.dayKey || todayKey();

        if (!nice) {
          await msg(
            chatId,
            '⚠️ Введите время в формате 18:30 или 1830.',
            [[callbackButton('⬅️ Назад к дате', `lr_core:day:${dayKey}`)]]
          );
          return res.json({ ok: true });
        }

        if (!ids.length) {
          await msg(
            chatId,
            '⚠️ Сначала выберите канал.',
            [[callbackButton('⬅️ В редактор', 'editor:back')]]
          );
          return res.json({ ok: true });
        }

        await saveTime(ids, nice, isAd);
        await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });

        await msg(
          chatId,
          `${isAd ? '✅ Рекламное время добавлено' : '✅ Сохранённое время добавлено'}:\n<b>${esc(nice)}</b>`
        );

        await showDay(dayKey);
        return res.json({ ok: true });
      }

      return next();
    }

    // ===== CALLBACK CORE =====
    if (payload === 'lr_core:noop' || payload === 'noop') {
      await notice('Выберите день');
      return res.json({ ok: true });
    }

    if (payload === 'editor:ad') {
      const ctx = await currentDraft();
      ctx.draft.isAd = !isAdDraft(ctx.draft);
      ctx.draft.is_ad = ctx.draft.isAd;

      if (ctx.draft.isAd) {
        forceAd(ctx.draft);
      } else {
        ctx.draft.isAd = false;
        ctx.draft.is_ad = false;
        ctx.draft.cpm = null;
      }

      await showEditorClean(
        ctx.draft,
        ctx.draft.isAd ? 'Рекламный пост включён. Автоподпись отключена.' : 'Рекламный режим выключен.'
      );

      return res.json({ ok: true });
    }

    if (payload === 'editor:signature') {
      const ctx = await currentDraft();

      if (ctx.isAd) {
        forceAd(ctx.draft);
        await setSession(key, ctx.draft.postId ? 'edit_existing' : 'edit_draft', { draft: ctx.draft });
        await showEditorClean(ctx.draft, 'У рекламного поста автоподпись отключена.');
        return res.json({ ok: true });
      }

      return next();
    }

    if (payload === 'editor:cpm') {
      const ctx = await currentDraft();
      forceAd(ctx.draft);

      await setSession(key, 'lr_core_wait_cpm_v1', { draft: ctx.draft });

      await reply(
        '💰 Введите цену за 1000 просмотров.',
        [[callbackButton('⬅️ Назад', 'editor:back')]]
      );

      return res.json({ ok: true });
    }

    if (
      payload === 'schedule:calendar' ||
      payload === 'calendar' ||
      payload === 'lr_cal:calendar' ||
      payload.startsWith('lr_core:month:') ||
      payload.startsWith('lr_clean_cal:month:') ||
      payload.startsWith('lr_cal:month:')
    ) {
      const m = payload.match(/(\d{4}-\d{2})/);
      await showMonth(m ? m[1] : monthFromDay(todayKey()));
      return res.json({ ok: true });
    }

    if (
      payload.startsWith('lr_core:day:') ||
      payload.startsWith('lr_clean_cal:day:') ||
      payload.startsWith('lr_cal:day:') ||
      payload.startsWith('schedule:day:')
    ) {
      const m = payload.match(/(\d{4}-\d{2}-\d{2})/);
      await showDay(m ? m[1] : todayKey());
      return res.json({ ok: true });
    }

    if (
      payload.startsWith('lr_core:manage:') ||
      payload.startsWith('lr_clean_cal:manage:') ||
      payload.startsWith('lr_cal:saved_time:')
    ) {
      const m = payload.match(/(\d{4}-\d{2}-\d{2})/);
      await showManage(m ? m[1] : todayKey());
      return res.json({ ok: true });
    }

    if (
      payload.startsWith('lr_core:add:') ||
      payload.startsWith('lr_clean_cal:add:') ||
      payload.startsWith('lr_cal:add_saved:') ||
      payload.startsWith('lr_cal:saved_add:')
    ) {
      const m = payload.match(/(\d{4}-\d{2}-\d{2})/);
      await askAddTime(m ? m[1] : todayKey());
      return res.json({ ok: true });
    }

    if (
      payload.startsWith('lr_core:del:') ||
      payload.startsWith('lr_clean_cal:del:') ||
      payload.startsWith('lr_cal:delete_saved:') ||
      payload.startsWith('lr_cal:del_saved:')
    ) {
      const m = payload.match(/(\d{4}-\d{2}-\d{2}):(\d{4})/);
      const dayKey = m ? m[1] : todayKey();
      const t = m ? normalizeTime(m[2]) : null;

      const ctx = await currentDraft();

      if (t) {
        await deleteTime(ctx.channelIds, t, ctx.isAd);
        await notice('Время удалено: ' + t);
      }

      await showManage(dayKey);
      return res.json({ ok: true });
    }

    if (
      payload.startsWith('lr_core:pick:') ||
      payload.startsWith('lr_clean_cal:pick:') ||
      payload.startsWith('lr_cal:pick:') ||
      payload.startsWith('schedule:time:')
    ) {
      const m = payload.match(/(\d{4}-\d{2}-\d{2}):(\d{4})/);

      if (!m) {
        await reply('⚠️ Не удалось прочитать выбранное время.', [[callbackButton('⬅️ К календарю', 'schedule:calendar')]]);
        return res.json({ ok: true });
      }

      await scheduleAt(m[1], m[2]);
      return res.json({ ok: true });
    }

    if (
      payload === 'schedule:manual' ||
      payload.startsWith('schedule:manual_day:') ||
      payload.startsWith('lr_cal:manual_day:') ||
      payload.startsWith('lr_clean_cal:manual_day:')
    ) {
      const m = payload.match(/(\d{4}-\d{2}-\d{2})/);
      await showManage(m ? m[1] : todayKey());
      return res.json({ ok: true });
    }

    return next();
  } catch (e) {
    console.error('[LR_EDITOR_CORE_V1]', e?.stack || e);

    try {
      const update = req.body || {};
      const callbackId = getCallbackId(update);

      if (callbackId && typeof cb === 'function') {
        await cb(
          callbackId,
          `⚠️ Ошибка ядра:\n${String(e?.message || e)}`,
          [[callbackButton('⬅️ В Studio', 'main:posting')]]
        );
        return res.json({ ok: true });
      }
    } catch {}

    return next();
  }
});
/* LR_EDITOR_CORE_V1_END */

/* LR_FULL_AD_ANALYTICS_V3_START */

function lrAnTokenV3() {
  const keys = ['MAX_TOKEN', 'MAX_BOT_TOKEN', 'MAX_ACCESS_TOKEN', 'BOT_TOKEN', 'ACCESS_TOKEN', 'API_TOKEN', 'TOKEN'];
  for (const k of keys) {
    if (process.env[k]) return String(process.env[k]);
  }

  try { if (typeof MAX_TOKEN !== 'undefined' && MAX_TOKEN) return String(MAX_TOKEN); } catch {}
  try { if (typeof BOT_TOKEN !== 'undefined' && BOT_TOKEN) return String(BOT_TOKEN); } catch {}
  try { if (typeof TOKEN !== 'undefined' && TOKEN) return String(TOKEN); } catch {}

  return '';
}

function lrAnApiBaseV3() {
  let base = '';
  try { if (typeof MAX_API_BASE !== 'undefined' && MAX_API_BASE) base = String(MAX_API_BASE); } catch {}

  if (!base) {
    base =
      process.env.MAX_API_BASE ||
      process.env.MAX_BASE_URL ||
      process.env.MAX_PLATFORM_API ||
      'https://platform-api2.max.ru';
  }

  return String(base).replace(/\/+$/, '');
}

function lrAnPublicBaseV3(req = null) {
  const env =
    process.env.LINKRAY_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    process.env.APP_PUBLIC_URL ||
    process.env.WEB_PUBLIC_URL ||
    process.env.BASE_URL ||
    '';

  if (env) return String(env).replace(/\/+$/, '');

  if (req) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    if (host) return `${proto}://${host}`.replace(/\/+$/, '');
  }

  return '';
}

function lrAnRowsV3(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

function lrAnHtmlV3(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function lrAnMoneyV3(v) {
  const n = Number(v || 0);
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function lrAnNumV3(v) {
  const n = Number(v || 0);
  return n.toLocaleString('ru-RU');
}

function lrAnParseJsonV3(v) {
  if (!v) return v;
  if (typeof v === 'object') return v;

  if (typeof v === 'string') {
    const t = v.trim();
    if (
      (t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']'))
    ) {
      try { return JSON.parse(t); } catch {}
    }
  }

  return v;
}

function lrAnDeepFindV3(obj, matcher, depth = 0) {
  if (!obj || depth > 8) return null;

  obj = lrAnParseJsonV3(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = lrAnDeepFindV3(item, matcher, depth + 1);
      if (found !== null && found !== undefined && found !== '') return found;
    }
    return null;
  }

  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      try {
        const direct = matcher(k, v, obj);
        if (direct !== null && direct !== undefined && direct !== '') return direct;
      } catch {}

      const nested = lrAnDeepFindV3(v, matcher, depth + 1);
      if (nested !== null && nested !== undefined && nested !== '') return nested;
    }
  }

  return null;
}

function lrAnFindTokenV3(obj) {
  const byKey = lrAnDeepFindV3(obj, (k, v) => {
    if (/^(trackingToken|trackerToken|analyticsToken|observerToken|token)$/i.test(k)) {
      const t = String(v || '').trim();
      if (/^[a-zA-Z0-9_-]{12,120}$/.test(t)) return t;
    }

    if (/^(trackingUrl|analyticsUrl|observerUrl|url)$/i.test(k)) {
      const m = String(v || '').match(/\/analytics\/stats\/([a-zA-Z0-9_-]{12,120})/);
      if (m) return m[1];
    }

    return null;
  });

  if (byKey) return byKey;

  const raw = typeof obj === 'string' ? obj : JSON.stringify(obj || {});
  const m = raw.match(/\/analytics\/stats\/([a-zA-Z0-9_-]{12,120})/);
  return m ? m[1] : '';
}

function lrAnFindMessageIdV3(obj) {
  return lrAnDeepFindV3(obj, (k, v) => {
    if (/^(message_id|messageId|mid|message_mid|post_message_id|published_message_id)$/i.test(k)) {
      const t = String(v || '').trim();
      if (/^[a-zA-Z0-9_-]{4,200}$/.test(t)) return t;
    }

    return null;
  });
}

function lrAnFindChannelIdV3(obj) {
  const v = lrAnDeepFindV3(obj, (k, value) => {
    if (/^(channel_id|channelId|chat_id|chatId|target_channel_id|targetChannelId)$/i.test(k)) {
      const n = Number(value);
      if (Number.isFinite(n) && n !== 0) return n;
    }
    return null;
  });

  return v ? Number(v) : null;
}

function lrAnFindViewsV3(message) {
  const stat = message?.stat || message?.stats || message?.statistics || {};
  const candidates = [
    stat.views,
    stat.view_count,
    stat.views_count,
    stat.viewers,
    stat.impressions,
    stat.impression_count,
    stat.read_count,
    stat.reads,
    message?.views,
    message?.view_count
  ];

  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }

  return null;
}

function lrAnFindMessageUrlV3(message) {
  return String(
    message?.url ||
    message?.link?.url ||
    message?.public_url ||
    message?.message_url ||
    ''
  ).trim();
}

function lrAnPlainTextV3(value, depth = 0) {
  if (!value || depth > 8) return '';

  value = lrAnParseJsonV3(value);

  if (typeof value === 'string') {
    let text = value
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

    return text;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const t = lrAnPlainTextV3(item, depth + 1);
      if (t) return t;
    }
    return '';
  }

  if (typeof value === 'object') {
    const direct =
      value.text ||
      value.caption ||
      value.title ||
      value.body?.text ||
      value.content?.text ||
      value.draft?.text ||
      value.draft?.content?.text ||
      value.message?.text ||
      value.message?.body?.text ||
      value.payload?.text ||
      value.data?.text ||
      '';

    const t = lrAnPlainTextV3(direct, depth + 1);
    if (t) return t;

    for (const k of ['content', 'draft', 'payload', 'message', 'body', 'data']) {
      const nested = lrAnPlainTextV3(value[k], depth + 1);
      if (nested) return nested;
    }
  }

  return '';
}

function lrAnFindImageV3(value, depth = 0) {
  if (!value || depth > 9) return '';

  value = lrAnParseJsonV3(value);

  if (typeof value === 'string') {
    const m = value.match(/https?:\/\/[^\s"'<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>]*)?/i);
    return m ? m[0] : '';
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = lrAnFindImageV3(item, depth + 1);
      if (found) return found;
    }
    return '';
  }

  if (typeof value === 'object') {
    const type = String(value.type || value.mime_type || value.mimeType || '').toLowerCase();
    const candidates = [
      value.url,
      value.src,
      value.image_url,
      value.imageUrl,
      value.photo_url,
      value.photoUrl,
      value.download_url,
      value.downloadUrl,
      value.payload?.url,
      value.payload?.src,
      value.payload?.image_url,
      value.payload?.photo_url,
      value.photo?.url,
      value.image?.url,
      value.preview?.url,
      value.thumbnail?.url
    ].filter(Boolean);

    for (const u of candidates) {
      const s = String(u);
      if (
        /^https?:\/\//i.test(s) &&
        (
          /\.(jpg|jpeg|png|webp)(\?|$)/i.test(s) ||
          type.includes('image') ||
          type.includes('photo')
        )
      ) {
        return s;
      }
    }

    for (const v of Object.values(value)) {
      const found = lrAnFindImageV3(v, depth + 1);
      if (found) return found;
    }
  }

  return '';
}

function lrAnCpmV3(tracker) {
  const fromTracker = Number(tracker?.cpm || 0);
  if (Number.isFinite(fromTracker) && fromTracker > 0) return fromTracker;

  const d = lrAnParseJsonV3(tracker?.draft_json || {});
  const raw = d?.cpm ?? d?.adCpm ?? d?.ad_cpm ?? d?.pricePerMille ?? d?.price_per_mille ?? 0;
  const n = Number(String(raw).replace(',', '.').replace(/[^\d.]/g, ''));

  return Number.isFinite(n) ? n : 0;
}

function lrAnAutoDeleteHoursV3(tracker) {
  const d = lrAnParseJsonV3(tracker?.draft_json || {});
  const raw =
    d?.autoDeleteHours ??
    d?.auto_delete_hours ??
    d?.deleteAfterHours ??
    d?.delete_after_hours ??
    d?.autoDelete ??
    d?.auto_delete ??
    null;

  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function lrAnDateRuV3(value) {
  if (!value) return 'не указано';

  try {
    return new Date(value).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) + ' МСК';
  } catch {
    return String(value);
  }
}

async function lrAnEnsureV3() {
  await query(`
    CREATE TABLE IF NOT EXISTS public.ad_post_trackers (
      id serial PRIMARY KEY,
      token text NOT NULL UNIQUE,
      post_id text,
      schedule_ref text,
      channel_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      cpm numeric DEFAULT 0,
      views bigint NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'planned',
      publish_at timestamptz,
      published_at timestamptz,
      deleted_at timestamptz,
      post_text text,
      post_image_url text,
      draft_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`ALTER TABLE public.ad_post_trackers ADD COLUMN IF NOT EXISTS published_at timestamptz`);
  await query(`ALTER TABLE public.ad_post_trackers ADD COLUMN IF NOT EXISTS deleted_at timestamptz`);
  await query(`ALTER TABLE public.ad_post_trackers ADD COLUMN IF NOT EXISTS post_text text`);
  await query(`ALTER TABLE public.ad_post_trackers ADD COLUMN IF NOT EXISTS post_image_url text`);

  await query(`
    CREATE TABLE IF NOT EXISTS public.ad_post_tracker_channels (
      id serial PRIMARY KEY,
      token text NOT NULL,
      channel_id bigint,
      channel_title text,
      message_id text,
      message_url text,
      status text NOT NULL DEFAULT 'planned',
      views bigint NOT NULL DEFAULT 0,
      last_stat jsonb,
      published_at timestamptz,
      deleted_at timestamptz,
      post_text text,
      post_image_url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_ad_post_tracker_channels_token ON public.ad_post_tracker_channels(token)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ad_post_tracker_channels_message ON public.ad_post_tracker_channels(message_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS public.ad_post_tracker_points (
      id bigserial PRIMARY KEY,
      token text NOT NULL,
      channel_id bigint,
      message_id text,
      views bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_ad_post_tracker_points_token_time ON public.ad_post_tracker_points(token, created_at)`);
}

async function lrAnUpsertChannelV3(data) {
  await lrAnEnsureV3();

  const token = String(data.token || '').trim();
  if (!token) return;

  const channelId = data.channel_id ? Number(data.channel_id) : null;
  const messageId = data.message_id ? String(data.message_id) : null;

  let existing = null;

  if (messageId) {
    const r = await query(
      `SELECT * FROM public.ad_post_tracker_channels WHERE token=$1 AND message_id=$2 LIMIT 1`,
      [token, messageId]
    );
    existing = lrAnRowsV3(r)[0] || null;
  }

  if (!existing && channelId) {
    const r = await query(
      `SELECT * FROM public.ad_post_tracker_channels WHERE token=$1 AND channel_id=$2 AND (message_id IS NULL OR message_id='') LIMIT 1`,
      [token, channelId]
    );
    existing = lrAnRowsV3(r)[0] || null;
  }

  if (existing) {
    await query(
      `UPDATE public.ad_post_tracker_channels
       SET channel_id = COALESCE($2, channel_id),
           channel_title = COALESCE(NULLIF($3,''), channel_title),
           message_id = COALESCE(NULLIF($4,''), message_id),
           message_url = COALESCE(NULLIF($5,''), message_url),
           status = COALESCE(NULLIF($6,''), status),
           views = GREATEST(COALESCE($7, views), views),
           last_stat = COALESCE($8::jsonb, last_stat),
           published_at = COALESCE($9, published_at),
           deleted_at = COALESCE($10, deleted_at),
           post_text = COALESCE(NULLIF($11,''), post_text),
           post_image_url = COALESCE(NULLIF($12,''), post_image_url),
           updated_at = now()
       WHERE id=$1`,
      [
        existing.id,
        channelId,
        data.channel_title || '',
        messageId || '',
        data.message_url || '',
        data.status || '',
        Number(data.views || 0),
        data.last_stat ? JSON.stringify(data.last_stat) : null,
        data.published_at || null,
        data.deleted_at || null,
        data.post_text || '',
        data.post_image_url || ''
      ]
    );
  } else {
    await query(
      `INSERT INTO public.ad_post_tracker_channels(
         token, channel_id, channel_title, message_id, message_url,
         status, views, last_stat, published_at, deleted_at, post_text, post_image_url
       )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
      [
        token,
        channelId,
        data.channel_title || '',
        messageId,
        data.message_url || '',
        data.status || 'planned',
        Number(data.views || 0),
        data.last_stat ? JSON.stringify(data.last_stat) : null,
        data.published_at || null,
        data.deleted_at || null,
        data.post_text || '',
        data.post_image_url || ''
      ]
    );
  }
}

async function lrAnCreateRowsFromTrackerV3(tracker) {
  const token = String(tracker.token || '');
  const draft = lrAnParseJsonV3(tracker.draft_json || {});
  const channelIds = Array.isArray(tracker.channel_ids)
    ? tracker.channel_ids
    : lrAnParseJsonV3(tracker.channel_ids || []);

  const ids = Array.isArray(channelIds) ? channelIds.map(Number).filter(Boolean) : [];
  const postText = tracker.post_text || lrAnPlainTextV3(draft);
  const imageUrl = tracker.post_image_url || lrAnFindImageV3(draft);

  for (const chId of ids) {
    await lrAnUpsertChannelV3({
      token,
      channel_id: chId,
      status: tracker.status || 'planned',
      published_at: tracker.published_at || null,
      deleted_at: tracker.deleted_at || null,
      post_text: postText,
      post_image_url: imageUrl
    });
  }
}

async function lrAnGetMaxMessagesV3(messageIds) {
  const ids = [...new Set((messageIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];

  const token = lrAnTokenV3();
  if (!token) {
    console.error('[LR_FULL_AD_ANALYTICS_V3] MAX token not found');
    return [];
  }

  const base = lrAnApiBaseV3();

  try {
    const url = `${base}/messages?message_ids=${encodeURIComponent(ids.join(','))}`;
    const r = await fetch(url, { headers: { Authorization: token } });
    const raw = await r.text();

    if (!r.ok) {
      console.error('[LR_FULL_AD_ANALYTICS_V3 GET /messages]', r.status, raw.slice(0, 600));
      return [];
    }

    const data = JSON.parse(raw || '{}');

    if (Array.isArray(data.messages)) return data.messages;
    if (Array.isArray(data)) return data;
    if (data.message) return [data.message];

    return [];
  } catch (e) {
    console.error('[LR_FULL_AD_ANALYTICS_V3 messages fetch]', e?.message || e);
    return [];
  }
}

async function lrAnScanDbForBindingsV3(token) {
  await lrAnEnsureV3();

  const tablesResult = await query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public'
      AND table_type='BASE TABLE'
      AND table_name NOT IN ('ad_post_tracker_points')
    ORDER BY table_name
  `);

  const tables = lrAnRowsV3(tablesResult).map(r => r.table_name);

  for (const table of tables) {
    try {
      const qt = '"' + String(table).replaceAll('"', '""') + '"';

      const r = await query(
        `SELECT to_jsonb(t) AS j
         FROM public.${qt} t
         WHERE to_jsonb(t)::text ILIKE $1
         ORDER BY 1 DESC
         LIMIT 50`,
        [`%${token}%`]
      );

      for (const row of lrAnRowsV3(r)) {
        const j = row.j || {};
        const foundToken = lrAnFindTokenV3(j);
        if (foundToken !== token) continue;

        const messageId = lrAnFindMessageIdV3(j);
        const channelId = lrAnFindChannelIdV3(j);
        const statusText = String(j.status || j.state || j.post_status || '').toLowerCase();
        const status =
          statusText.includes('delete') || statusText.includes('удал') ? 'deleted' :
          statusText.includes('publish') || statusText.includes('опублик') ? 'published' :
          'planned';

        await lrAnUpsertChannelV3({
          token,
          channel_id: channelId,
          channel_title: j.channel_title || j.channelName || j.channel_name || '',
          message_id: messageId,
          message_url: j.message_url || j.url || j.post_url || '',
          status,
          published_at: j.published_at || j.publish_at || null,
          deleted_at: j.deleted_at || null,
          post_text: lrAnPlainTextV3(j),
          post_image_url: lrAnFindImageV3(j)
        });
      }
    } catch (e) {
      console.error('[LR_FULL_AD_ANALYTICS_V3 scan table]', table, e?.message || e);
    }
  }
}

async function lrAnPollOneTrackerV3(tracker) {
  const token = String(tracker.token || '');
  if (!token) return;

  await lrAnCreateRowsFromTrackerV3(tracker);

  const chResult = await query(
    `SELECT *
     FROM public.ad_post_tracker_channels
     WHERE token=$1
     ORDER BY id ASC`,
    [token]
  );

  let channels = lrAnRowsV3(chResult);

  if (!channels.some(c => c.message_id)) {
    await lrAnScanDbForBindingsV3(token);

    const again = await query(
      `SELECT *
       FROM public.ad_post_tracker_channels
       WHERE token=$1
       ORDER BY id ASC`,
      [token]
    );
    channels = lrAnRowsV3(again);
  }

  const ids = channels.map(c => c.message_id).filter(Boolean);
  const messages = await lrAnGetMaxMessagesV3(ids);

  for (const message of messages) {
    const mid = String(
      message.message_id ||
      message.messageId ||
      message.mid ||
      message.id ||
      ''
    );

    if (!mid) continue;

    const views = lrAnFindViewsV3(message);
    const channelId = lrAnFindChannelIdV3(message);
    const postText = lrAnPlainTextV3(message);
    const imageUrl = lrAnFindImageV3(message);
    const messageUrl = lrAnFindMessageUrlV3(message);

    const matched = channels.find(c => String(c.message_id) === mid);
    const prevViews = Number(matched?.views || 0);
    const finalViews = views === null ? prevViews : Math.max(prevViews, views);

    await lrAnUpsertChannelV3({
      token,
      channel_id: channelId || matched?.channel_id || null,
      channel_title: matched?.channel_title || '',
      message_id: mid,
      message_url: messageUrl || matched?.message_url || '',
      status: 'published',
      views: finalViews,
      last_stat: message.stat || {},
      published_at: matched?.published_at || tracker.published_at || tracker.publish_at || new Date(),
      post_text: postText || matched?.post_text || '',
      post_image_url: imageUrl || matched?.post_image_url || ''
    });

    await query(
      `INSERT INTO public.ad_post_tracker_points(token, channel_id, message_id, views)
       VALUES($1,$2,$3,$4)`,
      [token, channelId || matched?.channel_id || null, mid, finalViews]
    );
  }

  const agg = await query(
    `SELECT
       COALESCE(SUM(views),0)::bigint AS views,
       COUNT(*)::int AS channels_count,
       MAX(published_at) AS published_at,
       MAX(deleted_at) AS deleted_at,
       BOOL_OR(status='published') AS has_published,
       BOOL_OR(status='deleted') AS has_deleted,
       MAX(NULLIF(post_text,'')) AS post_text,
       MAX(NULLIF(post_image_url,'')) AS post_image_url
     FROM public.ad_post_tracker_channels
     WHERE token=$1`,
    [token]
  );

  const a = lrAnRowsV3(agg)[0] || {};
  const status =
    a.has_deleted ? 'deleted' :
    a.has_published ? 'published' :
    (tracker.publish_at && new Date(tracker.publish_at).getTime() <= Date.now() ? 'published' : 'planned');

  await query(
    `UPDATE public.ad_post_trackers
     SET views=$2,
         status=$3,
         published_at=COALESCE(published_at,$4),
         deleted_at=COALESCE(deleted_at,$5),
         post_text=COALESCE(NULLIF(post_text,''), NULLIF($6,'')),
         post_image_url=COALESCE(NULLIF(post_image_url,''), NULLIF($7,'')),
         updated_at=now()
     WHERE token=$1`,
    [
      token,
      Number(a.views || 0),
      status,
      a.published_at || null,
      a.deleted_at || null,
      a.post_text || '',
      a.post_image_url || ''
    ]
  );
}

let lrAnPollBusyV3 = false;

async function lrAnPollAllV3() {
  if (lrAnPollBusyV3) return;
  lrAnPollBusyV3 = true;

  try {
    await lrAnEnsureV3();

    const result = await query(
      `SELECT *
       FROM public.ad_post_trackers
       WHERE created_at > now() - interval '45 days'
         AND (status IS NULL OR status <> 'deleted' OR updated_at > now() - interval '7 days')
       ORDER BY created_at DESC
       LIMIT 200`
    );

    for (const tracker of lrAnRowsV3(result)) {
      try {
        await lrAnPollOneTrackerV3(tracker);
      } catch (e) {
        console.error('[LR_FULL_AD_ANALYTICS_V3 poll tracker]', tracker?.token, e?.message || e);
      }
    }
  } catch (e) {
    console.error('[LR_FULL_AD_ANALYTICS_V3 poll all]', e?.stack || e);
  } finally {
    lrAnPollBusyV3 = false;
  }
}

function lrAnStatusTitleV3(tracker) {
  const status = String(tracker.status || 'planned');

  if (status === 'deleted') {
    return `Удалён: ${lrAnDateRuV3(tracker.deleted_at)}`;
  }

  if (status === 'published') {
    return `Опубликован: ${lrAnDateRuV3(tracker.published_at || tracker.publish_at)}`;
  }

  return `Отложен на ${lrAnDateRuV3(tracker.publish_at)}`;
}

function lrAnBuildSvgChartV3(points) {
  const arr = (points || []).map(p => ({
    label: p.label,
    views: Number(p.views || 0)
  }));

  if (!arr.length) {
    arr.push({ label: 'сейчас', views: 0 });
  }

  const max = Math.max(1, ...arr.map(p => p.views));
  const width = 720;
  const height = 220;
  const pad = 34;

  const step = arr.length <= 1 ? 0 : (width - pad * 2) / (arr.length - 1);

  const coords = arr.map((p, i) => {
    const x = pad + step * i;
    const y = height - pad - ((height - pad * 2) * p.views / max);
    return [x, y];
  });

  const path = coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
  const dots = coords.map((c, i) => `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="4"><title>${lrAnHtmlV3(arr[i].label)}: ${lrAnNumV3(arr[i].views)}</title></circle>`).join('');

  return `
<svg viewBox="0 0 ${width} ${height}" class="chart" role="img">
  <line x1="${pad}" y1="${height-pad}" x2="${width-pad}" y2="${height-pad}" />
  <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height-pad}" />
  <path d="${path}" fill="none" stroke-width="4" />
  ${dots}
</svg>`;
}

async function lrAnLoadReportV3(token) {
  await lrAnEnsureV3();

  const trackerResult = await query(
    `SELECT *
     FROM public.ad_post_trackers
     WHERE token=$1
     LIMIT 1`,
    [token]
  );

  const tracker = lrAnRowsV3(trackerResult)[0] || null;
  if (!tracker) return null;

  await lrAnPollOneTrackerV3(tracker);

  const freshResult = await query(
    `SELECT *
     FROM public.ad_post_trackers
     WHERE token=$1
     LIMIT 1`,
    [token]
  );

  const fresh = lrAnRowsV3(freshResult)[0] || tracker;

  const channelResult = await query(
    `SELECT *
     FROM public.ad_post_tracker_channels
     WHERE token=$1
     ORDER BY views DESC, id ASC`,
    [token]
  );

  const channels = lrAnRowsV3(channelResult);

  const pointsResult = await query(
    `SELECT
       to_char(date_trunc('hour', created_at AT TIME ZONE 'Europe/Moscow'), 'DD.MM HH24:MI') AS label,
       MAX(views)::bigint AS views
     FROM public.ad_post_tracker_points
     WHERE token=$1
     GROUP BY 1, date_trunc('hour', created_at AT TIME ZONE 'Europe/Moscow')
     ORDER BY date_trunc('hour', created_at AT TIME ZONE 'Europe/Moscow') ASC
     LIMIT 48`,
    [token]
  );

  const points = lrAnRowsV3(pointsResult);

  return { tracker: fresh, channels, points };
}

function lrAnForecastV3(tracker, channels, points) {
  const views = Number(tracker.views || 0);
  const autoHours = lrAnAutoDeleteHoursV3(tracker);

  if (!autoHours || !tracker.published_at) {
    return {
      forecastViews: views,
      forecastText: 'без автоудаления'
    };
  }

  const start = new Date(tracker.published_at).getTime();
  const end = start + autoHours * 3600000;
  const now = Date.now();

  if (now >= end) {
    return {
      forecastViews: views,
      forecastText: `${lrAnNumV3(views)} просмотров`
    };
  }

  const elapsedHours = Math.max(0.25, (now - start) / 3600000);
  const leftHours = Math.max(0, (end - now) / 3600000);
  const perHour = views / elapsedHours;
  const forecast = Math.round(views + perHour * leftHours);

  return {
    forecastViews: forecast,
    forecastText: `${lrAnNumV3(forecast)} просмотров`
  };
}

app.get('/analytics/stats/:token.json', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();

    if (!/^[a-zA-Z0-9_-]{12,120}$/.test(token)) {
      return res.status(404).json({ ok: false });
    }

    const report = await lrAnLoadReportV3(token);
    if (!report) return res.status(404).json({ ok: false });

    return res.json({ ok: true, ...report });
  } catch (e) {
    console.error('[LR_FULL_AD_ANALYTICS_V3 json]', e?.stack || e);
    return res.status(500).json({ ok: false });
  }
});

app.get('/analytics/stats/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();

    if (!/^[a-zA-Z0-9_-]{12,120}$/.test(token)) {
      return res.status(404).send('LinkRay: отчёт не найден');
    }

    const report = await lrAnLoadReportV3(token);
    if (!report) return res.status(404).send('LinkRay: отчёт не найден');

    const tracker = report.tracker;
    const channels = report.channels || [];
    const points = report.points || [];

    const cpm = lrAnCpmV3(tracker);
    const views = Number(tracker.views || 0);
    const cost = views * cpm / 1000;
    const best = channels.length ? channels[0] : null;
    const forecast = lrAnForecastV3(tracker, channels, points);
    const forecastCost = forecast.forecastViews * cpm / 1000;

    const postText = tracker.post_text || channels.find(c => c.post_text)?.post_text || lrAnPlainTextV3(tracker.draft_json) || 'Текст поста пока не найден';
    const imageUrl = tracker.post_image_url || channels.find(c => c.post_image_url)?.post_image_url || lrAnFindImageV3(tracker.draft_json);

    const statusTop = lrAnStatusTitleV3(tracker);
    const chart = lrAnBuildSvgChartV3(points);

    const placements = channels.length
      ? channels.map(ch => {
          const title = ch.channel_title || (ch.channel_id ? `Канал ${ch.channel_id}` : 'Канал');
          const chCost = Number(ch.views || 0) * cpm / 1000;
          const url = ch.message_url ? `<a href="${lrAnHtmlV3(ch.message_url)}" target="_blank">открыть пост</a>` : '';
          return `
            <tr>
              <td>${lrAnHtmlV3(title)}</td>
              <td>${lrAnHtmlV3(ch.status || 'planned')}</td>
              <td>${lrAnNumV3(ch.views)}</td>
              <td>${lrAnMoneyV3(chCost)} ₽</td>
              <td>${url}</td>
            </tr>`;
        }).join('')
      : `<tr><td colspan="5">Размещения пока не привязаны к опубликованным сообщениям MAX</td></tr>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    return res.end(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>LinkRay — аналитика рекламы</title>
  <style>
    :root{--bg:#070b12;--card:#111827;--card2:#172033;--line:rgba(255,255,255,.09);--text:#eef6ff;--muted:#9fb1c8;--accent:#67e8f9;--green:#4ade80;--red:#fb7185;--gold:#facc15}
    *{box-sizing:border-box}
    body{margin:0;background:radial-gradient(circle at top,#152033 0,#070b12 52%,#04060a 100%);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .wrap{max-width:980px;margin:0 auto;padding:22px 14px 44px}
    .top{background:linear-gradient(135deg,rgba(103,232,249,.18),rgba(250,204,21,.12));border:1px solid var(--line);border-radius:24px;padding:18px;margin-bottom:14px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
    .brand{font-size:30px;font-weight:900;margin-bottom:8px}
    .status{display:inline-flex;gap:8px;align-items:center;background:rgba(255,255,255,.08);border:1px solid var(--line);border-radius:999px;padding:9px 13px;font-weight:800}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}
    .box,.card{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:22px;padding:16px}
    .label{color:var(--muted);font-size:13px;margin-bottom:6px}
    .value{font-size:24px;font-weight:900;line-height:1.15}
    .wide{grid-column:1/-1}
    .post{display:grid;grid-template-columns:260px 1fr;gap:14px;align-items:start}
    .post img{width:100%;border-radius:18px;border:1px solid var(--line);display:block}
    .post-text{white-space:pre-wrap;line-height:1.45;color:#eaf2ff}
    .chart{width:100%;height:auto}
    .chart line{stroke:rgba(255,255,255,.18)}
    .chart path{stroke:var(--accent)}
    .chart circle{fill:var(--gold)}
    table{width:100%;border-collapse:collapse;overflow:hidden;border-radius:18px}
    th,td{padding:12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
    th{color:var(--muted);font-size:13px;font-weight:700}
    a{color:#7dd3fc;text-decoration:none}
    .footer{color:var(--muted);font-size:13px;line-height:1.45;margin-top:14px}
    @media(max-width:760px){.grid{grid-template-columns:1fr 1fr}.post{grid-template-columns:1fr}.brand{font-size:25px}}
    @media(max-width:460px){.grid{grid-template-columns:1fr}.value{font-size:22px}}
  </style>
</head>
<body>
  <div class="wrap">
    <section class="top">
      <div class="brand">🧬 LinkRay Analytics</div>
      <div class="status">💼 ${lrAnHtmlV3(statusTop)}</div>
      <div class="footer">Данные обновляются автоматически раз в минуту. Просмотры берутся из статистики поста MAX.</div>
    </section>

    <section class="grid">
      <div class="box">
        <div class="label">Просмотры MAX</div>
        <div class="value">${lrAnNumV3(views)}</div>
      </div>
      <div class="box">
        <div class="label">CPM</div>
        <div class="value">${lrAnMoneyV3(cpm)} ₽</div>
      </div>
      <div class="box">
        <div class="label">Стоимость</div>
        <div class="value">${lrAnMoneyV3(cost)} ₽</div>
      </div>
      <div class="box">
        <div class="label">Каналы</div>
        <div class="value">${lrAnNumV3(channels.length)}</div>
      </div>
      <div class="box">
        <div class="label">Лучший канал</div>
        <div class="value">${lrAnHtmlV3(best ? (best.channel_title || ('Канал ' + best.channel_id)) : 'нет данных')}</div>
      </div>
      <div class="box">
        <div class="label">Прогноз до удаления</div>
        <div class="value">${lrAnHtmlV3(forecast.forecastText)}</div>
      </div>
      <div class="box">
        <div class="label">Ожидаемая стоимость</div>
        <div class="value">${lrAnMoneyV3(forecastCost)} ₽</div>
      </div>
      <div class="box">
        <div class="label">Формула</div>
        <div class="value" style="font-size:16px">просмотры × CPM / 1000</div>
      </div>
    </section>

    <section class="card">
      <h2>📌 Пост</h2>
      <div class="post">
        ${imageUrl ? `<img src="${lrAnHtmlV3(imageUrl)}" alt="Картинка поста">` : `<div class="box"><div class="label">Картинка</div><div class="value" style="font-size:18px">медиа не найдено</div></div>`}
        <div class="post-text">${lrAnHtmlV3(postText)}</div>
      </div>
    </section>

    <section class="card" style="margin-top:14px">
      <h2>📈 Динамика просмотров</h2>
      ${chart}
    </section>

    <section class="card" style="margin-top:14px">
      <h2>📡 Размещения по каналам</h2>
      <table>
        <thead>
          <tr>
            <th>Канал</th>
            <th>Статус</th>
            <th>Просмотры</th>
            <th>Стоимость</th>
            <th>Пост</th>
          </tr>
        </thead>
        <tbody>${placements}</tbody>
      </table>
    </section>

    <div class="footer">
      Если у размещения пока нет message_id, LinkRay будет пытаться привязать его из базы и обновит отчёт после следующего опроса.
    </div>
  </div>
</body>
</html>`);
  } catch (e) {
    console.error('[LR_FULL_AD_ANALYTICS_V3 route]', e?.stack || e);
    return res.status(500).send('LinkRay: ошибка аналитики');
  }
});

setTimeout(() => {
  lrAnPollAllV3().catch(e => console.error('[LR_FULL_AD_ANALYTICS_V3 first poll]', e?.message || e));
}, 15000);

setInterval(() => {
  lrAnPollAllV3().catch(e => console.error('[LR_FULL_AD_ANALYTICS_V3 interval]', e?.message || e));
}, 60000);

setTimeout(() => {
  const names = [
    'sendMaxMessage',
    'sendMessage',
    'sendToChannel',
    'sendPostToChannel',
    'publishToChannel',
    'publishPost',
    'sendChannelPost',
    'maxSendMessage',
    'postToChannel'
  ];

  function bindFromArgsAndResult(name, args, result) {
    try {
      const token = lrAnFindTokenV3(args) || lrAnFindTokenV3(result);
      if (!token) return;

      const messageId = lrAnFindMessageIdV3(result) || lrAnFindMessageIdV3(args);
      const channelId = lrAnFindChannelIdV3(result) || lrAnFindChannelIdV3(args);
      const text = lrAnPlainTextV3(result) || lrAnPlainTextV3(args);
      const image = lrAnFindImageV3(result) || lrAnFindImageV3(args);
      const url = lrAnFindMessageUrlV3(result);

      lrAnUpsertChannelV3({
        token,
        channel_id: channelId,
        message_id: messageId,
        message_url: url,
        status: messageId ? 'published' : 'planned',
        published_at: messageId ? new Date() : null,
        post_text: text,
        post_image_url: image
      }).catch(e => console.error('[LR_FULL_AD_ANALYTICS_V3 bind async]', name, e?.message || e));
    } catch (e) {
      console.error('[LR_FULL_AD_ANALYTICS_V3 bind]', name, e?.message || e);
    }
  }

  for (const name of names) {
    try {
      const fn = eval(name);

      if (typeof fn !== 'function') continue;
      if (fn.__lrAnalyticsWrappedV3) continue;

      const wrapped = async function(...args) {
        const result = await fn.apply(this, args);
        bindFromArgsAndResult(name, args, result);
        return result;
      };

      wrapped.__lrAnalyticsWrappedV3 = true;

      try {
        eval(`${name} = wrapped`);
        console.log('[LR_FULL_AD_ANALYTICS_V3] wrapped', name);
      } catch {}
    } catch {}
  }
}, 2000);

/* LR_FULL_AD_ANALYTICS_V3_END */

/* LR_CLEAN_CALENDAR_SPLIT_TIME_V1_START */
app.use(async function lrCleanCalendarSplitTimeV1(req, res, next) {
  try {
    if (req.method !== 'POST') return next();

    const update = req.body || {};
    const payload = String(getCallbackPayload(update) || '');
    const callbackId = getCallbackId(update);
    const chatId = Number(getChatId(update) || 0);
    const key = getSessionKey(update);

    if (!key) return next();

    /* LR_CALENDAR_ANSWER_PAYLOAD_FIX_V2_START */
    function lrCalendarTokenV2() {
      const envKeys = [
        'MAX_TOKEN',
        'MAX_BOT_TOKEN',
        'MAX_ACCESS_TOKEN',
        'BOT_TOKEN',
        'ACCESS_TOKEN',
        'API_TOKEN',
        'TOKEN'
      ];

      for (const k of envKeys) {
        if (process.env[k]) return String(process.env[k]);
      }

      try {
        if (typeof MAX_TOKEN !== 'undefined' && MAX_TOKEN) return String(MAX_TOKEN);
      } catch {}

      try {
        if (typeof BOT_TOKEN !== 'undefined' && BOT_TOKEN) return String(BOT_TOKEN);
      } catch {}

      try {
        if (typeof TOKEN !== 'undefined' && TOKEN) return String(TOKEN);
      } catch {}

      try {
        if (typeof API_TOKEN !== 'undefined' && API_TOKEN) return String(API_TOKEN);
      } catch {}

      return '';
    }

    function lrCalendarApiBaseV2() {
      let base = '';

      try {
        if (typeof MAX_API_BASE !== 'undefined' && MAX_API_BASE) base = String(MAX_API_BASE);
      } catch {}

      if (!base) {
        base =
          process.env.MAX_API_BASE ||
          process.env.MAX_BASE_URL ||
          process.env.MAX_PLATFORM_API ||
          'https://platform-api2.max.ru';
      }

      return String(base).replace(/\/+$/, '');
    }

    function lrCalendarCleanRowsV2(rows) {
      if (!Array.isArray(rows)) return [];

      return rows
        .map(row => {
          if (!Array.isArray(row)) return [];

          return row.filter(btn => {
            if (!btn || typeof btn !== 'object') return false;

            const text = String(btn.text || btn.label || '').trim();
            return Boolean(text);
          });
        })
        .filter(row => row.length > 0);
    }

    async function lrCalendarAnswer(text, rows = []) {
      const safeText = String(text ?? '').trim() || ' ';
      const safeRows = lrCalendarCleanRowsV2(rows);

      const body = {
        message: {
          text: safeText,
          format: 'html',
          attachments: []
        }
      };

      if (safeRows.length) {
        body.message.attachments.push({
          type: 'inline_keyboard',
          payload: {
            buttons: safeRows
          }
        });
      }

      const token = lrCalendarTokenV2();
      const base = lrCalendarApiBaseV2();

      if (callbackId && token && typeof fetch === 'function') {
        try {
          const r = await fetch(`${base}/answers?callback_id=${encodeURIComponent(callbackId)}`, {
            method: 'POST',
            headers: {
              Authorization: token,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
          });

          if (r.ok) return;

          const raw = await r.text().catch(() => '');
          console.error('[LR_CALENDAR_ANSWER_PAYLOAD_FIX_V2 direct failed]', r.status, raw.slice(0, 800));
        } catch (e) {
          console.error('[LR_CALENDAR_ANSWER_PAYLOAD_FIX_V2 direct error]', e?.message || e);
        }
      }

      if (callbackId && typeof cb === 'function') {
        try {
          return await cb(callbackId, safeText, safeRows);
        } catch (e) {
          console.error('[LR_CALENDAR_ANSWER_PAYLOAD_FIX_V2 cb fallback failed]', e?.message || e);
        }
      }

      if (chatId && typeof msg === 'function') {
        return await msg(chatId, safeText, safeRows);
      }

      throw new Error('Не удалось ответить календарём: нет callbackId/chatId или токена');
    }
    /* LR_CALENDAR_ANSWER_PAYLOAD_FIX_V2_END */

    function esc(v) {
      try {
        return escapeHtml(v);
      } catch {
        return String(v ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;');
      }
    }

    function rowsOf(result) {
      if (Array.isArray(result)) return result;
      if (result && Array.isArray(result.rows)) return result.rows;
      return [];
    }

    function textOfUpdate() {
      try {
        return String(getMessageText(update) || '').trim();
      } catch {
        return '';
      }
    }

    function draftFromSession(session) {
      const data = session && session.data ? session.data : {};
      const raw = data.draft ? data.draft : data;

      try {
        return typeof safeDraft === 'function' ? safeDraft(raw) : raw;
      } catch {
        return raw || {};
      }
    }

    function isAdDraft(draft, session = null) {
      const state = String(session?.state || '').toLowerCase();

      if (
        state.includes('cpm') ||
        state.includes('ad_') ||
        state.includes('advert') ||
        state.includes('реклам')
      ) {
        return true;
      }

      if (!draft || typeof draft !== 'object') return false;

      if (draft.isAd === true) return true;
      if (draft.is_ad === true) return true;
      if (draft.ad === true) return true;
      if (draft.isAdvertising === true) return true;
      if (draft.adPost === true) return true;

      if (String(draft.type || '').toLowerCase() === 'ad') return true;
      if (String(draft.postType || '').toLowerCase() === 'ad') return true;

      if (draft.cpm !== undefined && draft.cpm !== null && String(draft.cpm).trim() !== '') return true;

      return false;
    }

    function channelIdsOf(draft) {
      if (!draft || typeof draft !== 'object') return [];

      if (Array.isArray(draft.channelIds)) return draft.channelIds.map(Number).filter(Boolean);
      if (Array.isArray(draft.channel_ids)) return draft.channel_ids.map(Number).filter(Boolean);
      if (Array.isArray(draft.channels)) {
        return draft.channels.map(x => Number(x?.id || x?.channel_id || x)).filter(Boolean);
      }

      if (draft.channelId) return [Number(draft.channelId)].filter(Boolean);
      if (draft.channel_id) return [Number(draft.channel_id)].filter(Boolean);

      return [];
    }

    function normalizeTime(input) {
      const raw = String(input || '').trim();

      let m = raw.match(/^(\d{1,2})[:.\s](\d{2})$/);
      if (!m) m = raw.match(/^(\d{1,2})(\d{2})$/);

      if (!m) return null;

      const hh = Number(m[1]);
      const mm = Number(m[2]);

      if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

      return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }

    function compactTime(hhmm) {
      return String(hhmm || '').replace(/[^0-9]/g, '').padStart(4, '0').slice(0, 4);
    }

    function dateFromDayTime(dayKey, hhmm) {
      const clean = compactTime(hhmm);

      try {
        if (typeof dateTimeFromDayTime === 'function') {
          return dateTimeFromDayTime(dayKey, clean);
        }
      } catch {}

      const parts = String(dayKey || '').split('-').map(Number);
      const y = parts[0] || new Date().getFullYear();
      const m = parts[1] || (new Date().getMonth() + 1);
      const d = parts[2] || new Date().getDate();

      return new Date(
        `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${clean.slice(0, 2)}:${clean.slice(2, 4)}:00+03:00`
      );
    }

    function dayKeyFromDate(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    function dayTitle(dayKey) {
      const [y, m, d] = String(dayKey).split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

      try {
        return dt.toLocaleDateString('ru-RU', {
          weekday: 'short',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          timeZone: 'Europe/Moscow'
        });
      } catch {
        return dayKey;
      }
    }

    function monthTitle(year, monthIndex) {
      const dt = new Date(Date.UTC(year, monthIndex, 1, 12, 0, 0));

      try {
        return dt.toLocaleDateString('ru-RU', {
          month: 'long',
          year: 'numeric',
          timeZone: 'Europe/Moscow'
        });
      } catch {
        return `${monthIndex + 1}.${year}`;
      }
    }

    function extractDayFromPayload(value) {
      const p = String(value || '');
      const m = p.match(/(\d{4}-\d{2}-\d{2})/);
      if (!m) return null;

      if (
        p.includes('cal') ||
        p.includes('calendar') ||
        p.includes('date') ||
        p.includes('day') ||
        p.includes('schedule')
      ) {
        return m[1];
      }

      return null;
    }

    function extractMonthFromPayload(value) {
      const p = String(value || '');
      const m = p.match(/(\d{4})-(\d{2})/);

      if (!m) return null;

      return {
        year: Number(m[1]),
        month: Number(m[2]) - 1
      };
    }

    function hasPostContent(draft) {
      if (!draft || typeof draft !== 'object') return false;

      const content = draft.content || {};
      const text = String(content.text || draft.text || draft.caption || '').trim();

      if (text) return true;
      if (Array.isArray(content.attachments) && content.attachments.length) return true;
      if (Array.isArray(draft.attachments) && draft.attachments.length) return true;
      if (draft.photo || draft.video || draft.media) return true;

      try {
        if (typeof hasContent === 'function') return Boolean(hasContent(draft));
      } catch {}

      return false;
    }

    function parseMaybeJson(value) {
      if (typeof value !== 'string') return value;

      const t = value.trim();
      if (!t) return value;

      if (
        (t.startsWith('{') && t.endsWith('}')) ||
        (t.startsWith('[') && t.endsWith(']'))
      ) {
        try {
          return JSON.parse(t);
        } catch {}
      }

      return value;
    }

    function previewText(value, depth = 0) {
      if (value === null || value === undefined || depth > 6) return '';

      value = parseMaybeJson(value);

      if (typeof value === 'string') {
        let text = value
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();

        if (text.length > 60) text = text.slice(0, 60).trim() + '…';
        return text;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          const t = previewText(item, depth + 1);
          if (t) return t;
        }
        return '';
      }

      if (typeof value === 'object') {
        const direct =
          value.text ||
          value.caption ||
          value.title ||
          value.body?.text ||
          value.content?.text ||
          value.draft?.text ||
          value.draft?.content?.text ||
          value.message?.text ||
          value.message?.body?.text ||
          value.payload?.text ||
          value.data?.text ||
          '';

        const t = previewText(direct, depth + 1);
        if (t) return t;

        const keys = ['content', 'draft', 'payload', 'message', 'body', 'data'];
        for (const k of keys) {
          if (value[k]) {
            const nested = previewText(value[k], depth + 1);
            if (nested) return nested;
          }
        }

        const raw = JSON.stringify(value);
        if (/photo|video|image|attachment|media/i.test(raw)) return 'медиа';
      }

      return '';
    }

    function quoteIdent(name) {
      return '"' + String(name).replaceAll('"', '""') + '"';
    }

    async function ensureSavedTimesTable() {
      await query(`
        CREATE TABLE IF NOT EXISTS public.channel_saved_times (
          id serial PRIMARY KEY,
          channel_id integer NOT NULL,
          time_text text NOT NULL,
          is_ad boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await query(`ALTER TABLE public.channel_saved_times ADD COLUMN IF NOT EXISTS is_ad boolean NOT NULL DEFAULT false`);
      await query(`ALTER TABLE public.channel_saved_times ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

      await query(`
        DO $$
        DECLARE
          con_name text;
        BEGIN
          FOR con_name IN
            SELECT c.conname
            FROM pg_constraint c
            WHERE c.conrelid = 'public.channel_saved_times'::regclass
              AND c.contype = 'u'
              AND pg_get_constraintdef(c.oid) LIKE '%channel_id%'
              AND pg_get_constraintdef(c.oid) LIKE '%time_text%'
              AND pg_get_constraintdef(c.oid) NOT LIKE '%is_ad%'
          LOOP
            EXECUTE 'ALTER TABLE public.channel_saved_times DROP CONSTRAINT ' || quote_ident(con_name);
          END LOOP;
        END $$;
      `);

      await query(`DROP INDEX IF EXISTS public.idx_channel_saved_times_channel_time`);
      await query(`DROP INDEX IF EXISTS public.idx_channel_saved_times_channel_owner`);
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_saved_times_channel_time_ad
        ON public.channel_saved_times(channel_id, time_text, is_ad)
      `);
    }

    async function loadSavedTimes(channelIds, isAd) {
      await ensureSavedTimesTable();

      if (!channelIds.length) return [];

      const result = await query(
        `SELECT DISTINCT time_text
         FROM public.channel_saved_times
         WHERE channel_id = ANY($1::int[])
           AND is_ad = $2
         ORDER BY time_text ASC`,
        [channelIds, Boolean(isAd)]
      );

      return rowsOf(result)
        .map(r => normalizeTime(r.time_text))
        .filter(Boolean);
    }

    async function saveTime(channelIds, hhmm, isAd) {
      await ensureSavedTimesTable();

      for (const channelId of channelIds) {
        await query(
          `INSERT INTO public.channel_saved_times(channel_id, time_text, is_ad, updated_at)
           VALUES($1, $2, $3, now())
           ON CONFLICT(channel_id, time_text, is_ad)
           DO UPDATE SET updated_at = now()`,
          [channelId, hhmm, Boolean(isAd)]
        );
      }
    }

    async function deleteTime(channelIds, hhmm, isAd) {
      await ensureSavedTimesTable();

      if (!channelIds.length) return;

      await query(
        `DELETE FROM public.channel_saved_times
         WHERE channel_id = ANY($1::int[])
           AND time_text = $2
           AND is_ad = $3`,
        [channelIds, hhmm, Boolean(isAd)]
      );
    }

    async function tableExists(tableName) {
      const result = await query(`SELECT to_regclass($1) AS name`, [`public.${tableName}`]);
      return Boolean(rowsOf(result)[0]?.name);
    }

    async function tableColumns(tableName) {
      const result = await query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1`,
        [tableName]
      );

      return rowsOf(result).map(r => r.column_name);
    }

    async function candidatePostTables() {
      const result = await query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND (
            table_name ILIKE '%post%' OR
            table_name ILIKE '%queue%' OR
            table_name ILIKE '%schedule%' OR
            table_name ILIKE '%publish%'
          )
        ORDER BY table_name
      `);

      const names = rowsOf(result).map(r => r.table_name);

      for (const fixed of ['scheduled_posts', 'posts', 'published_posts', 'post_queue']) {
        if (!names.includes(fixed) && await tableExists(fixed)) names.unshift(fixed);
      }

      return [...new Set(names)];
    }

    async function postsForDay(dayKey, channelIds) {
      const tables = await candidatePostTables();
      const all = [];
      const seen = new Set();

      const timeColumns = [
        'publish_at',
        'published_at',
        'scheduled_at',
        'planned_at',
        'run_at',
        'send_at',
        'post_at',
        'created_at',
        'updated_at'
      ];

      for (const table of tables) {
        try {
          const cols = await tableColumns(table);
          const timeCol = timeColumns.find(c => cols.includes(c));

          if (!timeCol) continue;

          const qt = quoteIdent(table);
          const qc = quoteIdent(timeCol);

          const result = await query(
            `SELECT to_jsonb(t) AS j, ${qc} AS post_time
             FROM public.${qt} t
             WHERE ((${qc})::timestamptz AT TIME ZONE 'Europe/Moscow')::date = $1::date
             ORDER BY ${qc} ASC
             LIMIT 80`,
            [dayKey]
          );

          for (const row of rowsOf(result)) {
            const j = row.j || {};
            const raw = JSON.stringify(j);
            const id = `${table}:${j.id || j.post_id || j.message_id || raw.slice(0, 100)}`;

            if (seen.has(id)) continue;
            seen.add(id);

            const rowChannel = Number(
              j.channel_id ||
              j.channelId ||
              j.target_channel_id ||
              j.targetChannelId ||
              0
            );

            if (channelIds.length && rowChannel && !channelIds.includes(rowChannel)) continue;

            const d = new Date(row.post_time || j[timeCol]);
            const time = Number.isNaN(d.getTime())
              ? ''
              : d.toLocaleTimeString('ru-RU', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                  timeZone: 'Europe/Moscow'
                });

            if (!time) continue;

            all.push({
              time,
              text: previewText(j) || 'пост без текста'
            });
          }
        } catch (e) {
          console.error('[LR_CLEAN_CALENDAR_SPLIT_TIME_V1 posts]', table, e?.message || e);
        }
      }

      all.sort((a, b) => String(a.time).localeCompare(String(b.time)));

      return all.slice(0, 30);
    }

    function timeIsPast(dayKey, hhmm) {
      const d = dateFromDayTime(dayKey, hhmm);
      return !d || Number.isNaN(d.getTime()) || d.getTime() <= Date.now();
    }

    function timeOccupied(posts, hhmm) {
      const t = String(hhmm || '').slice(0, 5);
      return posts.some(p => String(p.time || '').slice(0, 5) === t);
    }

    async function currentDraftContext() {
      const session = await getSession(key);
      const draft = draftFromSession(session);
      const isAd = isAdDraft(draft, session);
      const channelIds = channelIdsOf(draft);

      return { session, draft, isAd, channelIds };
    }

    async function renderMonth(year = null, monthIndex = null) {
      const now = new Date();

      if (year === null || monthIndex === null) {
        year = now.getFullYear();
        monthIndex = now.getMonth();
      }

      const title = monthTitle(year, monthIndex);
      const first = new Date(year, monthIndex, 1);
      const last = new Date(year, monthIndex + 1, 0);
      const todayKey = dayKeyFromDate(now);

      let startWeekday = first.getDay();
      if (startWeekday === 0) startWeekday = 7;

      const rows = [];
      rows.push([
        callbackButton('Пн', 'noop'),
        callbackButton('Вт', 'noop'),
        callbackButton('Ср', 'noop'),
        callbackButton('Чт', 'noop'),
        callbackButton('Пт', 'noop'),
        callbackButton('Сб', 'noop'),
        callbackButton('Вс', 'noop')
      ]);

      let row = [];

      for (let i = 1; i < startWeekday; i++) {
        row.push(callbackButton(' ', 'noop'));
      }

      for (let day = 1; day <= last.getDate(); day++) {
        const d = new Date(year, monthIndex, day);
        const dk = dayKeyFromDate(d);
        const label = dk === todayKey ? `•${day}•` : String(day);

        row.push(callbackButton(label, `lr_clean_cal:day:${dk}`));

        if (row.length === 7) {
          rows.push(row);
          row = [];
        }
      }

      if (row.length) {
        while (row.length < 7) row.push(callbackButton(' ', 'noop'));
        rows.push(row);
      }

      const prev = new Date(year, monthIndex - 1, 1);
      const nextM = new Date(year, monthIndex + 1, 1);

      rows.push([
        callbackButton('⬅️', `lr_clean_cal:month:${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`),
        callbackButton('📅 Сегодня', `lr_clean_cal:day:${todayKey}`),
        callbackButton('➡️', `lr_clean_cal:month:${nextM.getFullYear()}-${String(nextM.getMonth() + 1).padStart(2, '0')}`)
      ]);
      rows.push([callbackButton('⬅️ К выпуску', 'editor:next')]);

      return lrCalendarAnswer(
        `━━━━━━━━━━━━━━
📅 <b>${esc(title)}</b>

Выберите день публикации.
━━━━━━━━━━━━━━`,
        rows
      );
    }

    async function renderDay(dayKey) {
      const { draft, isAd, channelIds } = await currentDraftContext();

      const savedTimes = await loadSavedTimes(channelIds, isAd);
      const posts = await postsForDay(dayKey, channelIds);

      const visibleTimes = savedTimes.filter(t => {
        if (timeIsPast(dayKey, t)) return false;
        if (timeOccupied(posts, t)) return false;
        return true;
      });

      const icon = isAd ? '💼' : '💾';
      const timeTitle = isAd ? 'Рекламное время' : 'Сохранённое время';

      const postLines = posts.length
        ? posts.map(p => `• <b>${esc(p.time)}</b> — ${esc(p.text)}`).join('\n')
        : 'Постов на этот день пока нет';

      const savedLines = savedTimes.length
        ? savedTimes.map(t => `${icon} ${esc(t)}`).join('  ')
        : 'пока нет';

      const text =
`━━━━━━━━━━━━━━
📅 <b>${esc(dayTitle(dayKey))}</b>

<b>Посты на этот день:</b>
${postLines}

<b>${esc(timeTitle)}:</b>
${savedLines}

Свободные времена показаны кнопками ниже.
Если время занято постом или прошло, оно не показывается кнопкой.
━━━━━━━━━━━━━━`;

      const rows = [];

      for (let i = 0; i < visibleTimes.length; i += 3) {
        rows.push(
          visibleTimes.slice(i, i + 3).map(t =>
            callbackButton(`${icon} ${t}`, `lr_clean_cal:pick:${dayKey}:${compactTime(t)}`)
          )
        );
      }

      rows.push([callbackButton(`${icon} ${timeTitle}`, `lr_clean_cal:manage:${dayKey}`)]);
      rows.push([callbackButton('⬅️ К месяцу', `lr_clean_cal:month:${dayKey.slice(0, 7)}`)]);

      return lrCalendarAnswer( text, rows);
    }

    async function renderManage(dayKey) {
      const { isAd, channelIds } = await currentDraftContext();

      const savedTimes = await loadSavedTimes(channelIds, isAd);

      const icon = isAd ? '💼' : '💾';
      const timeTitle = isAd ? 'Рекламное время' : 'Сохранённое время';

      const text =
`━━━━━━━━━━━━━━
${icon} <b>${esc(timeTitle)}</b>

Здесь можно добавить или удалить время для канала.
Обычное и рекламное время хранятся отдельно.

Сейчас:
${savedTimes.length ? savedTimes.map(t => `${icon} ${esc(t)}`).join('\n') : 'времени пока нет'}
━━━━━━━━━━━━━━`;

      const rows = [];
      rows.push([callbackButton('➕ Добавить время', `lr_clean_cal:add:${dayKey}`)]);

      for (let i = 0; i < savedTimes.length; i += 2) {
        rows.push(
          savedTimes.slice(i, i + 2).map(t =>
            callbackButton(`🗑 ${t}`, `lr_clean_cal:del:${dayKey}:${compactTime(t)}`)
          )
        );
      }

      rows.push([callbackButton('⬅️ Назад к дате', `lr_clean_cal:day:${dayKey}`)]);

      return lrCalendarAnswer( text, rows);
    }

    async function askAddTime(dayKey) {
      const { draft, isAd } = await currentDraftContext();

      await setSession(key, 'lr_clean_wait_add_saved_time_v1', {
        draft,
        isAd,
        dayKey
      });

      const icon = isAd ? '💼' : '💾';
      const timeTitle = isAd ? 'рекламное время' : 'сохранённое время';

      return lrCalendarAnswer(
        `━━━━━━━━━━━━━━
${icon} Введите ${esc(timeTitle)}.

Пример: <b>18:30</b> или <b>1830</b>.

После добавления оно появится кнопкой в меню даты, если время свободно.
━━━━━━━━━━━━━━`,
        [[callbackButton('⬅️ Назад к дате', `lr_clean_cal:day:${dayKey}`)]]
      );
    }

    /* LR_AD_SCHEDULED_CONFIRM_STYLE_V2_HELPERS_START */
    function lrAdConfirmPreviewTextV2(draft) {
      try {
        const raw =
          draft?.content?.text ||
          draft?.text ||
          draft?.caption ||
          draft?.message?.text ||
          draft?.body?.text ||
          draft?.draft?.content?.text ||
          '';

        let text = String(raw || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();

        if (!text) {
          const rawJson = JSON.stringify(draft || {});
          if (/photo|video|image|attachment|media/i.test(rawJson)) {
            text = 'медиа-пост';
          }
        }

        if (!text) text = 'пост без текста';
        if (text.length > 54) text = text.slice(0, 54).trim() + '…';

        return text;
      } catch {
        return 'пост без текста';
      }
    }

    function lrAdConfirmAutoDeleteTextV2(draft) {
      const raw =
        draft?.autoDeleteHours ??
        draft?.auto_delete_hours ??
        draft?.deleteAfterHours ??
        draft?.delete_after_hours ??
        draft?.autoDelete ??
        draft?.auto_delete ??
        draft?.removeAfter ??
        draft?.remove_after ??
        null;

      if (raw === null || raw === undefined || raw === false || raw === 0 || raw === '0' || raw === '') {
        return 'без удаления';
      }

      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return `${n}ч`;

      return String(raw);
    }

    function lrAdConfirmCpmTextV2(draft) {
      const raw =
        draft?.cpm ??
        draft?.adCpm ??
        draft?.ad_cpm ??
        draft?.pricePerMille ??
        draft?.price_per_mille ??
        '';

      const text = String(raw ?? '').trim();
      if (!text) return 'не указан';

      return `${text} ₽ за 1000 просмотров`;
    }

    function lrAdConfirmChannelLinesV2(channels) {
      try {
        if (typeof channelsLines === 'function') {
          const value = channelsLines(channels);
          if (String(value || '').trim()) return value;
        }
      } catch {}

      if (!Array.isArray(channels) || !channels.length) return '• канал не найден';

      return channels.map(ch => {
        const title = ch?.title || ch?.name || ch?.channel_name || ch?.id || 'канал';
        const url = ch?.url || ch?.link || ch?.invite_link || ch?.join_link || '';

        if (url) return `• <a href="${esc(url)}">${esc(title)}</a>`;
        return `• ${esc(title)}`;
      }).join('\n');
    }

    function lrAdConfirmDateLineV2(dayKey, nice) {
      return `${dayTitle(dayKey)}, ${nice} МСК`;
    }

    function lrAdScheduledConfirmTextV2(draft, channels, dayKey, nice) {
      const preview = lrAdConfirmPreviewTextV2(draft);
      const cpm = lrAdConfirmCpmTextV2(draft);
      const autoDelete = lrAdConfirmAutoDeleteTextV2(draft);
      const channelLines = lrAdConfirmChannelLinesV2(channels);
      const dateLine = lrAdConfirmDateLineV2(dayKey, nice);

      return `━━━━━━━━━━━━━━
💼 <b>Рекламный пост отложен</b>

📝 Сообщение «${esc(preview)}»

📌 <b>Статус:</b> отложено
🕒 <b>Публикация:</b> ${esc(dateLine)}

📡 <b>Канал:</b>
${channelLines}

💰 <b>CPM:</b> ${esc(cpm)}
🗑 <b>Автоудаление:</b> ${esc(autoDelete)}
📊 <b>Отчёт:</b> через 24ч после публикации

━━━━━━━━━━━━━━
🧬 <a href="https://max.ru/se13353901_bot">LinkRay</a> — автопостинг, рекламные выходы и отчёты для MAX`;
    }

    function lrNormalScheduledConfirmTextV2(channels, dayKey, nice) {
      const channelLines = lrAdConfirmChannelLinesV2(channels);
      const dateLine = lrAdConfirmDateLineV2(dayKey, nice);

      return `━━━━━━━━━━━━━━
✅ <b>Пост отложен</b>

📌 <b>Статус:</b> отложено
🕒 <b>Публикация:</b> ${esc(dateLine)}

📡 <b>Канал:</b>
${channelLines}

Пост добавлен в очередь.
━━━━━━━━━━━━━━`;
    }
    /* LR_AD_SCHEDULED_CONFIRM_STYLE_V2_HELPERS_END */

    

    async function scheduleAt(dayKey, hhmm) {
      const nice = normalizeTime(hhmm);
      const publishAt = dateFromDayTime(dayKey, nice);

      if (!nice || !publishAt || Number.isNaN(publishAt.getTime())) {
        return lrCalendarAnswer( '⚠️ Не удалось разобрать время.', [
          [callbackButton('⬅️ Назад к дате', `lr_clean_cal:day:${dayKey}`)]
        ]);
      }

      if (publishAt.getTime() <= Date.now()) {
        return lrCalendarAnswer( `⚠️ Это время уже прошло: ${esc(nice)}.`, [
          [callbackButton('⬅️ Назад к дате', `lr_clean_cal:day:${dayKey}`)]
        ]);
      }

      const { draft, isAd, channelIds } = await currentDraftContext();

      if (!channelIds.length) {
        return lrCalendarAnswer( '⚠️ Сначала выберите канал.', [
          [callbackButton('⬅️ В редактор', 'editor:back')]
        ]);
      }

      if (!hasPostContent(draft)) {
        return lrCalendarAnswer( '⚠️ Пост пустой. Сначала добавьте текст или медиа.', [
          [callbackButton('⬅️ В редактор', 'editor:back')]
        ]);
      }

      try {
        if (callbackId && typeof answerCallback === 'function') {
          await answerCallback({ callbackId, notification: `Время выбрано: ${nice}` });
        }
      } catch {}

      const lrTracker = isAd ? await lrCreateAdTrackerV2(draft, channelIds, publishAt) : null;
      await scheduleDraft(draft, key, publishAt);
      await clearSession(key);

      const channels = await getChannelsByIds(channelIds);

      let text = isAd
        ? lrAdScheduledConfirmTextV2(draft, channels, dayKey, nice)
        : lrNormalScheduledConfirmTextV2(channels, dayKey, nice);
      if (isAd) text += lrTrackerLineV2(draft?.trackingUrl || draft?.analyticsUrl || draft?.observerUrl || '');

      return lrCalendarAnswer( text, [
        [callbackButton('📂 Посты', 'post:all')],
        [callbackButton('🧬 LinkRay Studio', 'main:posting')]
      ]);
    }

    if (!payload) {
      const text = textOfUpdate();
      if (!text) return next();

      const session = await getSession(key);
      const state = String(session?.state || '');

      if (state !== 'lr_clean_wait_add_saved_time_v1') return next();

      const nice = normalizeTime(text);
      const data = session.data || {};
      const draft = data.draft || {};
      const dayKey = data.dayKey;
      const isAd = Boolean(data.isAd);
      const channelIds = channelIdsOf(draft);

      if (!nice) {
        await msg(chatId, '⚠️ Введите время в формате <b>18:30</b> или <b>1830</b>.', [
          [callbackButton('⬅️ Назад к дате', `lr_clean_cal:day:${dayKey}`)]
        ]);
        return res.json({ ok: true });
      }

      if (!channelIds.length) {
        await msg(chatId, '⚠️ Сначала выберите канал.', [
          [callbackButton('⬅️ В редактор', 'editor:back')]
        ]);
        return res.json({ ok: true });
      }

      await saveTime(channelIds, nice, isAd);
      await setSession(key, 'publish_menu', { draft });

      const icon = isAd ? '💼' : '✅';
      const title = isAd ? 'Рекламное время добавлено' : 'Сохранённое время добавлено';

      await msg(
        chatId,
        `${icon} <b>${esc(title)}:</b>\n${esc(nice)}`,
        [[callbackButton('⬅️ Назад к дате', `lr_clean_cal:day:${dayKey}`)]]
      );

      return res.json({ ok: true });
    }

    if (payload === 'noop') {
      if (callbackId && typeof answerCallback === 'function') {
        try {
          await answerCallback({ callbackId, notification: 'Выберите дату' });
        } catch {}
      }
      return res.json({ ok: true });
    }

    if (
      payload === 'schedule:calendar' ||
      payload === 'calendar' ||
      payload.startsWith('lr_clean_cal:month:')
    ) {
      const m = extractMonthFromPayload(payload);
      await renderMonth(m?.year ?? null, m?.month ?? null);
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_clean_cal:pick:')) {
      const parts = payload.split(':');
      const dayKey = parts[2];
      const hhmm = parts[3];

      await scheduleAt(dayKey, hhmm);
      return res.json({ ok: true });
    }

    if (payload.startsWith('schedule:time:')) {
      const parts = payload.split(':');
      const dayKey = parts[2];
      const hhmm = parts[3];

      await scheduleAt(dayKey, hhmm);
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_clean_cal:manage:')) {
      const dayKey = payload.split(':')[2];

      await renderManage(dayKey);
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_clean_cal:add:')) {
      const dayKey = payload.split(':')[2];

      await askAddTime(dayKey);
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_clean_cal:del:')) {
      const parts = payload.split(':');
      const dayKey = parts[2];
      const hhmm = normalizeTime(parts[3] || '');

      const { isAd, channelIds } = await currentDraftContext();

      if (hhmm) {
        await deleteTime(channelIds, hhmm, isAd);
      }

      await renderManage(dayKey);
      return res.json({ ok: true });
    }

    const dayFromAnyPayload = extractDayFromPayload(payload);
    if (dayFromAnyPayload) {
      await renderDay(dayFromAnyPayload);
      return res.json({ ok: true });
    }

    return next();
  } catch (e) {
    console.error('[LR_CLEAN_CALENDAR_SPLIT_TIME_V1]', e?.stack || e);

    try {
      const callbackId = getCallbackId(req.body || {});
      if (callbackId) {
        await lrCalendarAnswer( `⚠️ Ошибка календаря:\n${escapeHtml(e?.message || e)}`, [
          [callbackButton('⬅️ К календарю', 'schedule:calendar')]
        ]);
        return res.json({ ok: true });
      }
    } catch {}

    return next();
  }
});
/* LR_CLEAN_CALENDAR_SPLIT_TIME_V1_END */

/* LR_POST_EDITOR_ORDER_FINAL_START */
app.use(async function lrPostEditorOrderFinal(req, res, next) {
  try {
    if (req.method !== 'POST') return next();

    const update = req.body || {};
    const payload = String(getCallbackPayload(update) || '');
    const callbackId = getCallbackId(update);
    const chatId = Number(getChatId(update) || 0);
    const key = getSessionKey(update);

    if (!payload || !chatId || !key) return next();

    const low = payload.toLowerCase();

    const isPostEditor =
      payload.startsWith('post:edit:') ||
      payload.startsWith('post:editor:') ||
      payload.startsWith('post:to_editor:') ||
      payload.startsWith('post:open_editor:') ||
      payload.startsWith('published:edit:') ||
      payload.startsWith('scheduled:edit:') ||
      (
        payload.startsWith('post:') &&
        /\d/.test(payload) &&
        /(edit|editor|редакт)/i.test(payload)
      );

    if (!isPostEditor) return next();

    const nums = payload.match(/\d+/g) || [];
    const postId = Number(nums[nums.length - 1] || 0);

    if (!postId) return next();

    const rows = await query(
      `SELECT *
       FROM scheduled_posts
       WHERE id = $1
       LIMIT 1`,
      [postId]
    );

    const row = rows?.[0];

    if (!row) {
      if (callbackId && typeof answerCallback === 'function') {
        try {
          await answerCallback({ callbackId, notification: 'Пост не найден' });
        } catch {}
      }
      return res.json({ ok: true });
    }

    const draft = makeDraftFromPost(row);
    draft.postId = Number(row.id);
    draft.id = Number(row.id);
    draft.status = row.status || draft.status || 'scheduled';
    draft.publishedMessageId = row.published_message_id || draft.publishedMessageId || null;
    draft.previewMessageId = null;

    await setSession(key, 'edit_existing', { draft });

    if (callbackId && typeof answerCallback === 'function') {
      try {
        await answerCallback({ callbackId, notification: 'Открываю редактор' });
      } catch {}
    }

    try {
      await sendDraftPreview(chatId, draft);
    } catch (previewError) {
      console.error('[LR_POST_EDITOR_ORDER_FINAL preview]', previewError?.message || previewError);
    }

    await sendMaxMessage({
      chatId,
      text: editorMenuText(),
      format: 'html',
      attachments: inlineKeyboard(editorMenuRows(draft))
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('[LR_POST_EDITOR_ORDER_FINAL]', e?.stack || e);
    return next();
  }
});
/* LR_POST_EDITOR_ORDER_FINAL_END */

/* LR_BUTTONS_CLEAN_FINAL_START */
app.use(async function lrButtonsCleanFinal(req, res, next) {
  try {
    if (req.method !== 'POST') return next();

    const update = req.body || {};
    const payload = String(getCallbackPayload(update) || '');
    const callbackId = getCallbackId(update);
    const chatId = Number(getChatId(update) || 0);
    const key = getSessionKey(update);

    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function getDraft(session) {
      const data = session?.data || {};
      const raw = data.draft ? data.draft : data;
      try {
        return typeof safeDraft === 'function' ? safeDraft(raw) : raw;
      } catch {
        return raw || {};
      }
    }

    function cleanButton(b) {
      const text = String(b?.text || b?.title || b?.label || '').trim();
      const url = String(b?.url || b?.link || b?.href || '').trim();

      if (!text || !/^https?:\/\//i.test(url)) return null;
      if (/^(⚠️|формат кнопки|добавить кнопку|отправьте|можно отправить|сейчас|кнопки поста)/i.test(text)) return null;

      return { text, url };
    }

    function cleanButtons(buttons) {
      const out = [];
      const seen = new Set();

      for (const b of Array.isArray(buttons) ? buttons : []) {
        const item = cleanButton(b);
        if (!item) continue;

        const id = item.text + '|' + item.url;
        if (seen.has(id)) continue;
        seen.add(id);

        out.push(item);
      }

      return out;
    }

    function shortText(v, n = 28) {
      const s = String(v || '').replace(/\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n) + '...' : s;
    }

    function buttonMenuRows(draft) {
      const buttons = cleanButtons(draft.buttons);
      const rows = [];

      buttons.forEach((b, i) => {
        rows.push([callbackButton(`❌ Удалить ${i + 1}. ${shortText(b.text)}`, `lr_buttons_final:remove:${i}`)]);
      });

      if (buttons.length) {
        rows.push([callbackButton('🧹 Удалить все кнопки', 'lr_buttons_final:clear')]);
      }

      rows.push([callbackButton('⬅️ Назад', 'lr_buttons_final:back')]);
      return rows;
    }

    function buttonMenuText(draft, notice = '') {
      const buttons = cleanButtons(draft.buttons);

      const current = buttons.length
        ? buttons.map((b, i) => `${i + 1}. ${esc(b.text)} — ${esc(b.url)}`).join('\n')
        : 'Кнопок пока нет.';

      return (
        (notice ? notice + '\n\n' : '') +
        '━━━━━━━━━━━━━━\n' +
        '🔘 <b>Кнопки поста</b>\n\n' +
        '<b>Сейчас:</b>\n' +
        current +
        '\n\n' +
        '<b>Добавить кнопку:</b>\n' +
        'Отправьте сообщением:\n' +
        '<b>Название - https://site.ru</b>\n\n' +
        'Можно отправить несколько кнопок, каждую с новой строки или через <b>|</b>.\n' +
        'В названии поддерживается обычный текст и жирный.\n' +
        '━━━━━━━━━━━━━━'
      );
    }

    async function showButtonMenu(draft, notice = '') {
      draft.buttons = cleanButtons(draft.buttons);
      await setSession(key, 'wait_button', { draft });

      await sendMaxMessage({
        chatId,
        text: buttonMenuText(draft, notice),
        format: 'html',
        attachments: inlineKeyboard(buttonMenuRows(draft))
      });
    }

    async function showEditor(draft, notice = '') {
      draft.buttons = cleanButtons(draft.buttons);

      await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });

      try {
        draft.previewMessageId = null;
        if (typeof hasContent !== 'function' || hasContent(draft)) {
          const mid = await sendDraftPreview(chatId, draft);
          if (mid) draft.previewMessageId = mid;
        }
      } catch (e) {
        console.error('[LR_BUTTONS_CLEAN_FINAL preview]', e?.message || e);
      }

      await sendMaxMessage({
        chatId,
        text: (notice ? notice + '\n\n' : '') + editorMenuText(),
        format: 'html',
        attachments: inlineKeyboard(editorMenuRows(draft))
      });
    }

    function parseButtons(text) {
      const raw = String(text || '').replace(/\r/g, '\n').trim();

      if (!raw) return { ok: false, error: '⚠️ Формат кнопки:\n<b>Название - https://site.ru</b>' };

      if (/^(⚠️|формат кнопки|добавить кнопку|отправьте|можно отправить|сейчас|кнопки поста)/i.test(raw)) {
        return { ok: false, error: '⚠️ Это подсказка, а не кнопка.\n\nОтправь так:\n<b>Название - https://site.ru</b>' };
      }

      const parts = raw.split(/\n|\|/g).map(x => x.trim()).filter(Boolean);
      const buttons = [];

      for (const line of parts) {
        const m =
          line.match(/^(.*?)\s*[-–—]\s*(https?:\/\/\S+)$/i) ||
          line.match(/^(.*?)\s+(https?:\/\/\S+)$/i);

        if (!m) return { ok: false, error: '⚠️ Формат кнопки:\n<b>Название - https://site.ru</b>' };

        const text = String(m[1] || '').trim();
        const url = String(m[2] || '').trim();

        if (!text || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: '⚠️ Формат кнопки:\n<b>Название - https://site.ru</b>' };
        }

        buttons.push({ text, url });
      }

      return { ok: true, buttons };
    }

    const session = await getSession(key);
    const state = session?.state || '';
    const draft = getDraft(session);

    if (payload === 'editor:button') {
      await showButtonMenu(draft);
      return res.json({ ok: true });
    }

    if (payload === 'lr_buttons_final:back') {
      await showEditor(draft);
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_buttons_final:remove:') || payload.startsWith('lr_btn:remove:') || payload.startsWith('lr_btn_clean:remove:') || payload.startsWith('lr_btn_stable:remove:')) {
      const index = Number(payload.split(':').pop());
      const buttons = cleanButtons(draft.buttons);

      if (Number.isInteger(index) && index >= 0 && index < buttons.length) {
        buttons.splice(index, 1);
      }

      draft.buttons = buttons;

      if (callbackId) {
        try {
          await answerCallback({ callbackId, notification: 'Кнопка удалена' });
        } catch {}
      }

      await showEditor(draft, '✅ Кнопка удалена.');
      return res.json({ ok: true });
    }

    if (payload === 'lr_buttons_final:clear' || payload === 'lr_btn:clear' || payload === 'lr_btn_clean:clear' || payload === 'lr_btn_stable:clear') {
      draft.buttons = [];

      if (callbackId) {
        try {
          await answerCallback({ callbackId, notification: 'Кнопки удалены' });
        } catch {}
      }

      await showEditor(draft, '✅ Все кнопки удалены.');
      return res.json({ ok: true });
    }

    if (state === 'wait_button') {
      const text = getMessageText(update);
      if (!text) return next();

      const parsed = parseButtons(text);

      if (!parsed.ok) {
        await showButtonMenu(draft, parsed.error);
        return res.json({ ok: true });
      }

      draft.buttons = cleanButtons([...(draft.buttons || []), ...parsed.buttons]);

      await showEditor(draft, '✅ Кнопка добавлена.');
      return res.json({ ok: true });
    }

    return next();
  } catch (e) {
    console.error('[LR_BUTTONS_CLEAN_FINAL]', e?.stack || e);
    return next();
  }
});
/* LR_BUTTONS_CLEAN_FINAL_END */

/* LR_BUTTON_PREVIEW_REFRESH_V7_START */
app.use(async function lrButtonPreviewRefreshV7(req, res, next) {
  try {
    if (req.method !== 'POST') return next();

    const update = req.body || {};
    const payload = getCallbackPayload(update);
    const callbackId = getCallbackId(update);
    const chatId = Number(getChatId(update) || 0);
    const key = getSessionKey(update);

    function lrEsc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function lrPlain(v) {
      try {
        return typeof plain === 'function' ? plain(v) : String(v || '');
      } catch {
        return String(v || '');
      }
    }

    function lrShort(v, max = 40) {
      const s = lrPlain(v || '').replace(/\s+/g, ' ').trim();
      return s.length > max ? s.slice(0, max) + '...' : (s || 'кнопка');
    }

    function lrDraftFromSession(session) {
      const data = session && session.data ? session.data : {};
      const raw = data.draft ? data.draft : data;

      try {
        return typeof safeDraft === 'function' ? safeDraft(raw) : raw;
      } catch {
        return raw || {};
      }
    }

    function lrMessageMarkup(u) {
      const m =
        (u.message && u.message.body && u.message.body.markup) ||
        (u.message && u.message.markup) ||
        (u.body && u.body.markup) ||
        u.markup ||
        [];

      return Array.isArray(m) ? m : [];
    }

    function lrOverlap(aStart, aLen, bStart, bLen) {
      const a1 = Number(aStart) || 0;
      const a2 = a1 + (Number(aLen) || 0);
      const b1 = Number(bStart) || 0;
      const b2 = b1 + (Number(bLen) || 0);
      return a1 < b2 && b1 < a2;
    }

    function lrParseButtonLine(fullText, line) {
      const raw = String(line || '').trim();
      const urlMatch = raw.match(/https?:\/\/[^\s<>"']+/i);

      if (!urlMatch) return null;

      const url = urlMatch[0].trim();
      let title = raw.slice(0, urlMatch.index).trim();

      title = title.replace(/[-–—|:]+$/g, '').trim();

      if (!title) return null;

      return {
        text: title,
        url: url,
        titleFrom: fullText.indexOf(title),
        titleLength: title.length
      };
    }

    function lrParseButtonsInput(fullText) {
      const raw = String(fullText || '').replace(/\r/g, '\n').trim();
      const parts = raw.split(/\n|\|/g).map(x => x.trim()).filter(Boolean);
      const out = [];

      for (let i = 0; i < parts.length; i++) {
        let line = parts[i];

        if (!/https?:\/\//i.test(line) && i + 1 < parts.length && /https?:\/\//i.test(parts[i + 1])) {
          line = line + ' ' + parts[i + 1];
          i++;
        }

        const parsed = lrParseButtonLine(raw, line);

        if (!parsed) {
          return {
            ok: false,
            error: '⚠️ Формат кнопки:\n<b>Название - https://site.ru</b>'
          };
        }

        out.push(parsed);
      }

      if (!out.length) {
        return {
          ok: false,
          error: '⚠️ Формат кнопки:\n<b>Название - https://site.ru</b>'
        };
      }

      return { ok: true, buttons: out };
    }

    function lrValidateButtonMarkup(fullText, parsedButtons, markup) {
      for (const item of parsedButtons) {
        const unsupported = markup.find(m => {
          const type = String(m.type || m.kind || '').toLowerCase();

          if (!lrOverlap(m.from || 0, m.length || 0, item.titleFrom, item.titleLength)) return false;

          if (type === 'strong' || type === 'bold') return false;

          return true;
        });

        if (unsupported) {
          return '⚠️ Формат не поддерживается.\n\nВ названии кнопки можно использовать обычный текст или жирный. Остальные форматы для кнопок не сохраняются.';
        }
      }

      return null;
    }

    async function lrAck(text) {
      if (!callbackId) return;

      try {
        await answerCallback({
          callbackId: callbackId,
          notification: lrPlain(text || 'Готово').slice(0, 120)
        });
      } catch (e) {
        console.error('[LR_BUTTON_PREVIEW_REFRESH_V7 ack]', e.message || e);
      }
    }

    async function lrSendEditorBelowPreview(draft, notice) {
      if (!chatId) return;

      const oldPreviewId = draft.previewMessageId || null;

      /*
        Важно: после ввода/удаления кнопки отправляем новое превью прямо над новым редактором.
        Иначе старое превью редактируется выше по истории, а под новым редактором его не видно.
      */
      draft.previewMessageId = null;

      if (typeof hasContent !== 'function' || hasContent(draft)) {
        try {
          const mid = await sendDraftPreview(chatId, draft);
          if (mid) draft.previewMessageId = mid;
          else draft.previewMessageId = oldPreviewId;
        } catch (e) {
          console.error('[LR_BUTTON_PREVIEW_REFRESH_V7 preview]', e.message || e);
          draft.previewMessageId = oldPreviewId;
        }
      }

      await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });

      const text =
        (notice ? notice + '\n\n' : '') +
        editorMenuText();

      await sendMaxMessage({
        chatId: chatId,
        text: text,
        format: 'html',
        attachments: inlineKeyboard(editorMenuRows(draft))
      });
    }

    function lrButtonsListText(draft) {
      const buttons = Array.isArray(draft.buttons) ? draft.buttons : [];

      if (!buttons.length) return 'Кнопок пока нет.';

      return buttons
        .map((b, i) => `${i + 1}. ${lrEsc(lrShort(b.text || b.title || 'кнопка', 32))} — ${lrEsc(b.url || '')}`)
        .join('\n');
    }

    function lrButtonPromptRows(draft) {
      const rows = [];
      const buttons = Array.isArray(draft.buttons) ? draft.buttons : [];

      buttons.forEach((b, i) => {
        rows.push([
          callbackButton(`❌ Удалить ${i + 1}. ${lrShort(b.text || b.title || 'кнопка', 18)}`, `lr_btn:remove:${i}`)
        ]);
      });

      if (buttons.length) {
        rows.push([callbackButton('🧹 Удалить все кнопки', 'lr_btn:clear')]);
      }

      rows.push([callbackButton('⬅️ Назад', 'editor:back')]);

      return rows;
    }

    async function lrShowButtonPrompt() {
      const session = await getSession(key);
      const draft = lrDraftFromSession(session);

      await setSession(key, 'wait_button', { draft });

      const text =
        '━━━━━━━━━━━━━━\n' +
        '🔘 <b>Кнопки поста</b>\n\n' +
        '<b>Сейчас:</b>\n' +
        lrButtonsListText(draft) +
        '\n\n' +
        '<b>Добавить кнопку:</b>\n' +
        'Отправьте сообщением:\n' +
        '<b>Название - https://site.ru</b>\n\n' +
        'Можно отправить несколько кнопок, каждую с новой строки или через <b>|</b>.\n' +
        'В названии поддерживается обычный текст и жирный.\n' +
        '━━━━━━━━━━━━━━';

      if (callbackId) {
        return answerCallback({
          callbackId: callbackId,
          text: text,
          format: 'html',
          attachments: inlineKeyboard(lrButtonPromptRows(draft))
        });
      }

      return sendMaxMessage({
        chatId: chatId,
        text: text,
        format: 'html',
        attachments: inlineKeyboard(lrButtonPromptRows(draft))
      });
    }

    async function lrRemoveButton(index) {
      const session = await getSession(key);
      const draft = lrDraftFromSession(session);
      const buttons = Array.isArray(draft.buttons) ? draft.buttons : [];

      if (index < 0 || index >= buttons.length) {
        await lrAck('Кнопка не найдена');
        return;
      }

      buttons.splice(index, 1);
      draft.buttons = buttons;

      await lrAck('Кнопка удалена');
      await lrSendEditorBelowPreview(draft, '✅ Кнопка удалена.');
    }

    async function lrClearButtons() {
      const session = await getSession(key);
      const draft = lrDraftFromSession(session);

      draft.buttons = [];

      await lrAck('Кнопки удалены');
      await lrSendEditorBelowPreview(draft, '✅ Все кнопки удалены.');
    }

    async function lrHandleButtonInputMessage() {
      const session = await getSession(key);
      if (!session || session.state !== 'wait_button') return false;

      const draft = lrDraftFromSession(session);
      const fullText = getMessageText(update);

      if (!fullText) return false;

      const parsed = lrParseButtonsInput(fullText);

      if (!parsed.ok) {
        await sendMaxMessage({
          chatId: chatId,
          text: parsed.error,
          format: 'html',
          attachments: inlineKeyboard(lrButtonPromptRows(draft))
        });
        return true;
      }

      const markupError = lrValidateButtonMarkup(fullText, parsed.buttons, lrMessageMarkup(update));

      if (markupError) {
        await sendMaxMessage({
          chatId: chatId,
          text: markupError,
          format: 'html',
          attachments: inlineKeyboard(lrButtonPromptRows(draft))
        });
        return true;
      }

      draft.buttons = [].concat(draft.buttons || [], parsed.buttons.map(b => ({
        text: b.text,
        url: b.url
      })));

      console.log('[LR_BUTTON_PREVIEW_REFRESH_V7 added]', JSON.stringify({
        key,
        added: parsed.buttons.length,
        total: draft.buttons.length,
        previewMessageId: draft.previewMessageId || null
      }));

      await lrSendEditorBelowPreview(draft, '✅ Кнопка добавлена.');
      return true;
    }

    if (await lrHandleButtonInputMessage()) {
      return res.json({ ok: true });
    }

    if (!payload) return next();

    if (payload === 'editor:button') {
      await lrShowButtonPrompt();
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_btn:remove:')) {
      const index = Number(payload.split(':')[2]);
      await lrRemoveButton(index);
      return res.json({ ok: true });
    }

    if (payload === 'lr_btn:clear') {
      await lrClearButtons();
      return res.json({ ok: true });
    }

    return next();
  } catch (error) {
    console.error('[LR_BUTTON_PREVIEW_REFRESH_V7]', error && error.stack ? error.stack : error);
    return next();
  }
});
/* LR_BUTTON_PREVIEW_REFRESH_V7_END */

/* LR_CALENDAR_SCHEDULE_BUTTON_V6_START */
app.use(async function lrCalendarScheduleButtonV7(req, res, next) {
  try {
    if (req.method !== 'POST') return next();

    const update = req.body || {};
    const payload = String(getCallbackPayload(update) || '');
    const callbackId = getCallbackId(update);
    const chatId = Number(getChatId(update) || 0);
    const key = getSessionKey(update);

    function lrRows(result) {
      return Array.isArray(result) ? result : ((result && result.rows) ? result.rows : []);
    }

    function lrEsc(v) {
      try {
        return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '');
      } catch {
        return String(v ?? '');
      }
    }

    function lrShort(v, max = 58) {
      let text = '';
      try {
        text = typeof plain === 'function' ? plain(v || '') : String(v || '');
      } catch {
        text = String(v || '');
      }

      text = text.replace(/\s+/g, ' ').trim();
      if (!text) return 'пост без текста';
      return text.length > max ? text.slice(0, max) + '…' : text;
    }

    function lrChunk(list, size) {
      const out = [];
      for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
      return out;
    }

    function lrCleanHhmm(raw) {
      return String(raw || '').replace(/[^0-9]/g, '').padStart(4, '0').slice(0, 4);
    }

    function lrNiceTime(raw) {
      const clean = lrCleanHhmm(raw);
      return clean.slice(0, 2) + ':' + clean.slice(2, 4);
    }

    function lrNormalizeTime(raw) {
      const text = String(raw || '').trim();
      let m = text.match(/^(\d{1,2})[:.\s](\d{2})$/);
      if (!m) m = text.match(/^(\d{1,2})(\d{2})$/);
      if (!m) return null;

      const hh = Number(m[1]);
      const mm = Number(m[2]);

      if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

      return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }

    function lrDraftFromSession(session) {
      const data = session && session.data ? session.data : {};
      const raw = data.draft ? data.draft : data;

      try {
        return typeof safeDraft === 'function' ? safeDraft(raw) : raw;
      } catch {
        return raw || {};
      }
    }

    function lrChannelIdsFromDraft(draft) {
      if (!draft) return [];
      if (Array.isArray(draft.channelIds)) return draft.channelIds.map(Number).filter(Boolean);
      if (draft.channelId) return [Number(draft.channelId)].filter(Boolean);
      return [];
    }

    function lrEnsureDraftShape(draft) {
      if (!draft || typeof draft !== 'object') draft = {};
      if (!draft.content || typeof draft.content !== 'object') draft.content = {};
      if (!Array.isArray(draft.content.attachments)) draft.content.attachments = [];
      if (!Array.isArray(draft.buttons)) draft.buttons = [];
      return draft;
    }

    async function lrCb(text, rows) {
      const attachments = rows && rows.length ? inlineKeyboard(rows) : [];

      if (callbackId) {
        return answerCallback({
          callbackId,
          text,
          format: 'html',
          attachments
        });
      }

      if (chatId) {
        return sendMaxMessage({
          chatId,
          text,
          format: 'html',
          attachments
        });
      }
    }

    async function lrAck(text) {
      if (!callbackId) return;
      try {
        await answerCallback({
          callbackId,
          notification: text
        });
      } catch {}
    }

    async function lrEnsureSavedTimesTable() {
      await query(
        `CREATE TABLE IF NOT EXISTS channel_saved_times (
          id serial PRIMARY KEY,
          channel_id integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          time_text text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(channel_id, time_text)
        )`
      );
    }

    async function lrSavedTimes(channelIds) {
      await lrEnsureSavedTimesTable();

      if (!channelIds.length) return [];

      const r = await query(
        `SELECT DISTINCT time_text
         FROM channel_saved_times
         WHERE channel_id = ANY($1::int[])
         ORDER BY time_text ASC`,
        [channelIds]
      );

      return lrRows(r).map(x => String(x.time_text || '').trim()).filter(Boolean);
    }

    async function lrBusyPosts(dayKey, channelIds) {
      if (!channelIds.length) return [];

      const r = await query(
        `SELECT
            to_char(publish_at AT TIME ZONE 'Europe/Moscow', 'HH24:MI') AS time_text,
            status,
            COALESCE(
              NULLIF(text, ''),
              NULLIF(draft #>> '{content,text}', ''),
              NULLIF(draft ->> 'text', ''),
              'пост без текста'
            ) AS post_text
         FROM scheduled_posts
         WHERE channel_id = ANY($1::int[])
           AND status::text IN ('scheduled','publishing','published')
           AND publish_at >= $2::timestamptz
           AND publish_at < ($2::timestamptz + interval '1 day')
         ORDER BY publish_at ASC
         LIMIT 50`,
        [channelIds, dayKey + 'T00:00:00+03:00']
      );

      return lrRows(r).map(x => ({
        time: String(x.time_text || '').trim(),
        text: lrShort(x.post_text || '', 65),
        status: String(x.status || '')
      })).filter(x => x.time);
    }

    async function lrBusyTimes(dayKey, channelIds) {
      const posts = await lrBusyPosts(dayKey, channelIds);
      return new Set(posts.map(x => x.time));
    }

    function lrDateTime(dayKey, hhmm) {
      const clean = lrCleanHhmm(hhmm);
      return dateTimeFromDayTime(dayKey, clean);
    }

    async function lrFreeSavedTimes(dayKey, channelIds) {
      const saved = await lrSavedTimes(channelIds);
      const busy = await lrBusyTimes(dayKey, channelIds);
      const now = Date.now();

      return saved.filter(t => {
        if (busy.has(t)) return false;
        return lrDateTime(dayKey, t).getTime() > now;
      });
    }

    function lrMonthName(idx) {
      return ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'][idx] || '';
    }

    function lrMonthKeyFromDay(dayKey) {
      const d = keyToDate(dayKey || dateKey(new Date()));
      return String(d.getFullYear()).padStart(4, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }

    function lrShiftMonth(monthKey, diff) {
      const parts = String(monthKey || lrMonthKeyFromDay(dateKey(new Date()))).split('-');
      const y = Number(parts[0]) || new Date().getFullYear();
      const m = Number(parts[1]) || 1;
      const d = new Date(y, m - 1 + diff, 1);
      return String(d.getFullYear()).padStart(4, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }

    function lrMonthRows(monthKey, selectedDay) {
      const parts = String(monthKey || lrMonthKeyFromDay(dateKey(new Date()))).split('-');
      const year = Number(parts[0]) || new Date().getFullYear();
      const month = (Number(parts[1]) || 1) - 1;
      const today = dateKey(new Date());

      const first = new Date(year, month, 1);
      const last = new Date(year, month + 1, 0);
      const start = new Date(first);
      const offset = (first.getDay() || 7) - 1;
      start.setDate(first.getDate() - offset);

      const rows = [];

      rows.push([
        callbackButton('⬅️ ' + lrMonthName(new Date(year, month - 1, 1).getMonth()), 'lr_cal:month:' + lrShiftMonth(monthKey, -1) + ':0'),
        callbackButton(lrMonthName(month) + ' ' + year, 'noop'),
        callbackButton(lrMonthName(new Date(year, month + 1, 1).getMonth()) + ' ➡️', 'lr_cal:month:' + lrShiftMonth(monthKey, 1) + ':0')
      ]);

      rows.push([
        callbackButton('ПН', 'noop'),
        callbackButton('ВТ', 'noop'),
        callbackButton('СР', 'noop'),
        callbackButton('ЧТ', 'noop'),
        callbackButton('ПТ', 'noop'),
        callbackButton('СБ', 'noop'),
        callbackButton('ВС', 'noop')
      ]);

      for (let w = 0; w < 6; w++) {
        const row = [];

        for (let i = 0; i < 7; i++) {
          const d = new Date(start);
          d.setDate(start.getDate() + w * 7 + i);

          const dayKey = rawDateKey(d);
          const inMonth = d.getMonth() === month;
          const past = dayKey < today;

          let label = inMonth ? String(d.getDate()) : '·';
          if (selectedDay && selectedDay === dayKey) label = '✅ ' + label;
          if (past) label = '•';

          row.push(callbackButton(label, (!inMonth || past) ? 'noop' : 'lr_cal:day:' + dayKey));
        }

        rows.push(row);

        const weekEnd = new Date(start);
        weekEnd.setDate(start.getDate() + w * 7 + 6);
        if (weekEnd > last && w >= 4) break;
      }

      rows.push([callbackButton('⬅️ Назад', 'editor:next')]);

      return rows;
    }

    async function lrShowMonth(monthKey, selectedDay) {
      const parts = String(monthKey || lrMonthKeyFromDay(dateKey(new Date()))).split('-');
      const year = Number(parts[0]) || new Date().getFullYear();
      const month = (Number(parts[1]) || 1) - 1;

      return lrCb(
        `━━━━━━━━━━━━━━
📅 <b>Календарь публикации</b>

${lrEsc(lrMonthName(month) + ' ' + year)}

Дни идут по неделям: 7 дней в ряд.
Выберите дату публикации.
━━━━━━━━━━━━━━`,
        lrMonthRows(monthKey, selectedDay || null)
      );
    }

    async function lrShowDay(dayKey) {
      const session = await getSession(key);
      const draft = lrEnsureDraftShape(lrDraftFromSession(session));
      const channelIds = lrChannelIdsFromDraft(draft);

      const freeTimes = await lrFreeSavedTimes(dayKey, channelIds);
      const posts = await lrBusyPosts(dayKey, channelIds);

      const rows = [];

      for (const group of lrChunk(freeTimes, 3)) {
        rows.push(group.map(t => callbackButton('💾 ' + t, 'lr_cal:pick:' + dayKey + ':' + lrCleanHhmm(t))));
      }

      rows.push([callbackButton('💾 Сохранённое время', 'lr_cal:saved_time:' + dayKey)]);
      rows.push([callbackButton('✍️ Ввести время вручную', 'lr_cal:manual_day:' + dayKey)]);
      rows.push([callbackButton('⬅️ К месяцу', 'lr_cal:month:' + lrMonthKeyFromDay(dayKey) + ':' + dayKey)]);

      const postsText = posts.length
        ? posts.map(p => {
            const status = p.status === 'published' ? 'опубликован' : 'запланирован';
            return '• ' + lrEsc(p.time) + ' — ' + lrEsc(p.text) + ' (' + status + ')';
          }).join('\n')
        : 'Постов на этот день пока нет.';

      const freeHint = freeTimes.length
        ? 'Свободные сохранённые времена показаны кнопками ниже.'
        : 'Свободного сохранённого времени на этот день нет.';

      return lrCb(
        `━━━━━━━━━━━━━━
📅 <b>${lrEsc(dateText(keyToDate(dayKey)))}</b>

<b>Посты на этот день:</b>
${postsText}

${lrEsc(freeHint)}

Если время занято постом или уже прошло, кнопкой оно не показывается.
━━━━━━━━━━━━━━`,
        rows
      );
    }

    async function lrShowSavedManager(dayKey) {
      const session = await getSession(key);
      const draft = lrEnsureDraftShape(lrDraftFromSession(session));
      const channelIds = lrChannelIdsFromDraft(draft);
      const saved = await lrSavedTimes(channelIds);

      const rows = [];

      for (const group of lrChunk(saved, 2)) {
        rows.push(group.map(t => callbackButton('🗑 ' + t, 'lr_cal:delete_saved:' + dayKey + ':' + lrCleanHhmm(t))));
      }

      rows.push([callbackButton('➕ Добавить время', 'lr_cal:add_saved:' + dayKey)]);
      rows.push([callbackButton('⬅️ Назад к дате', 'lr_cal:day:' + dayKey)]);

      return lrCb(
        `━━━━━━━━━━━━━━
💾 <b>Сохранённое время</b>

${saved.length ? saved.map(t => '• ' + lrEsc(t)).join('\n') : 'Пока нет сохранённых времён.'}

Нажмите 🗑 рядом со временем, чтобы удалить его.
━━━━━━━━━━━━━━`,
        rows
      );
    }

    async function lrAskSavedTime(dayKey) {
      const session = await getSession(key);
      const draft = lrEnsureDraftShape(lrDraftFromSession(session));

      await setSession(key, 'lr_wait_saved_time_v7', { draft, dayKey });

      return lrCb(
        `━━━━━━━━━━━━━━
💾 Введите сохранённое время для канала.

Пример: <b>18:30</b> или <b>1830</b>.

Оно сохранится для канала и будет показываться кнопкой, если на выбранный день это время свободно.
━━━━━━━━━━━━━━`,
        [[callbackButton('⬅️ Назад к дате', 'lr_cal:day:' + dayKey)]]
      );
    }

    async function lrAskManualTime(dayKey) {
      const session = await getSession(key);
      const draft = lrEnsureDraftShape(lrDraftFromSession(session));

      await setSession(key, 'lr_wait_manual_calendar_time_v7', { draft, dayKey });

      return lrCb(
        `━━━━━━━━━━━━━━
✍️ Введите время публикации.

Дата:
<b>${lrEsc(dateText(keyToDate(dayKey)))}</b>

Пример: <b>18:30</b> или <b>1830</b>.
━━━━━━━━━━━━━━`,
        [[callbackButton('⬅️ Назад к дате', 'lr_cal:day:' + dayKey)]]
      );
    }

    async function lrDeleteSavedTime(dayKey, rawTime) {
      const session = await getSession(key);
      const draft = lrEnsureDraftShape(lrDraftFromSession(session));
      const channelIds = lrChannelIdsFromDraft(draft);
      const timeText = lrNiceTime(rawTime);

      await lrEnsureSavedTimesTable();

      if (channelIds.length) {
        await query(
          `DELETE FROM channel_saved_times
           WHERE channel_id = ANY($1::int[])
             AND time_text = $2`,
          [channelIds, timeText]
        );
      }

      await lrAck('Время удалено: ' + timeText);
      return lrShowSavedManager(dayKey);
    }

    async function lrFinalizeSchedule(dayKey, rawHhmm, sourceSession = null) {
      const clean = lrCleanHhmm(rawHhmm);
      const nice = lrNiceTime(clean);
      const publishAt = dateTimeFromDayTime(dayKey, clean);

      if (publishAt.getTime() <= Date.now()) {
        await lrAck('Это время уже прошло');
        return lrShowDay(dayKey);
      }

      const session = sourceSession || await getSession(key);
      const draft = lrEnsureDraftShape(lrDraftFromSession(session));

      if (!lrChannelIdsFromDraft(draft).length) {
        return lrCb(
          `━━━━━━━━━━━━━━
⚠️ Сначала выберите канал для поста.
━━━━━━━━━━━━━━`,
          [[callbackButton('⬅️ В редактор', 'editor:back')]]
        );
      }

      const hasBody =
        (typeof hasContent === 'function' && hasContent(draft)) ||
        String(draft?.content?.text || draft?.text || '').trim() ||
        (Array.isArray(draft?.content?.attachments) && draft.content.attachments.length);

      if (!hasBody) {
        return lrCb(
          `━━━━━━━━━━━━━━
⚠️ Пост пустой. Сначала добавьте текст или медиа.
━━━━━━━━━━━━━━`,
          [[callbackButton('⬅️ В редактор', 'editor:back')]]
        );
      }

      await lrAck('Планирую пост на ' + nice);

      await setSession(key, 'publish_menu', draft);

      const ids = await scheduleDraft(draft, key, publishAt);

      await clearSession(key);

      console.log('[LR_CALENDAR_SCHEDULE_BUTTON_V7 scheduled]', JSON.stringify({
        dayKey,
        time: nice,
        ids
      }));

      return afterPlanned(chatId, draft, publishAt, ids);
    }

    async function lrHandleSavedTimeMessage() {
      if (payload) return false;

      const session = await getSession(key);
      if (!session || !['lr_wait_saved_time_v7', 'lr_wait_saved_time_v6', 'lr_wait_saved_time_v5'].includes(session.state)) return false;

      const time = lrNormalizeTime(getMessageText(update));
      const dayKey = (session.data && session.data.dayKey) || dateKey(new Date());

      if (!time) {
        await sendMaxMessage({
          chatId,
          text: '⚠️ Введите время в формате <b>18:30</b> или <b>1830</b>.',
          format: 'html',
          attachments: inlineKeyboard([[callbackButton('⬅️ Назад к дате', 'lr_cal:day:' + dayKey)]])
        });

        return true;
      }

      const draft = lrEnsureDraftShape(lrDraftFromSession(session));
      const channelIds = lrChannelIdsFromDraft(draft);

      if (!channelIds.length) {
        await sendMaxMessage({
          chatId,
          text: '⚠️ Сначала выберите канал для поста.',
          format: 'html'
        });

        return true;
      }

      await lrEnsureSavedTimesTable();

      for (const channelId of channelIds) {
        await query(
          `INSERT INTO channel_saved_times(channel_id, time_text, updated_at)
           VALUES($1, $2, now())
           ON CONFLICT(channel_id, time_text)
           DO UPDATE SET updated_at = now()`,
          [channelId, time]
        );
      }

      await setSession(key, 'publish_menu', { draft });

      await sendMaxMessage({
        chatId,
        text: '✅ Сохранённое время добавлено:\n<b>' + lrEsc(time) + '</b>',
        format: 'html'
      });

      await lrShowDay(dayKey);

      return true;
    }

    async function lrHandleManualTimeMessage() {
      if (payload) return false;

      const session = await getSession(key);
      if (!session || !['lr_wait_manual_calendar_time_v7', 'lr_wait_manual_calendar_time_v6', 'lr_wait_manual_calendar_time_v5'].includes(session.state)) return false;

      const time = lrNormalizeTime(getMessageText(update));
      const dayKey = (session.data && session.data.dayKey) || dateKey(new Date());

      if (!time) {
        await sendMaxMessage({
          chatId,
          text: '⚠️ Введите время в формате <b>18:30</b> или <b>1830</b>.',
          format: 'html',
          attachments: inlineKeyboard([[callbackButton('⬅️ Назад к дате', 'lr_cal:day:' + dayKey)]])
        });

        return true;
      }

      await lrFinalizeSchedule(dayKey, time.replace(':', ''), session);

      return true;
    }

    if (await lrHandleSavedTimeMessage()) return res.json({ ok: true });
    if (await lrHandleManualTimeMessage()) return res.json({ ok: true });

    if (!payload) return next();

    if (payload === 'noop') {
      await lrAck('Недоступно');
      return res.json({ ok: true });
    }

    if (payload === 'schedule:manual') {
      await lrAck('Откройте календарь и выберите дату');
      return res.json({ ok: true });
    }

    if (payload === 'schedule:calendar') {
      await lrShowMonth(lrMonthKeyFromDay(dateKey(new Date())), null);
      return res.json({ ok: true });
    }

    if (payload.startsWith('schedule:week:')) {
      const dayKey = payload.split(':')[2] || dateKey(new Date());
      await lrShowMonth(lrMonthKeyFromDay(dayKey), dayKey);
      return res.json({ ok: true });
    }

    if (payload.startsWith('schedule:day:')) {
      await lrShowDay(payload.split(':')[2] || dateKey(new Date()));
      return res.json({ ok: true });
    }

    if (payload.startsWith('schedule:time:')) {
      const parts = payload.split(':');
      await lrFinalizeSchedule(parts[2] || dateKey(new Date()), parts[3] || '');
      return res.json({ ok: true });
    }

    if (payload.startsWith('schedule:manual_day:')) {
      await lrAskManualTime(payload.split(':')[2] || dateKey(new Date()));
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_cal:month:')) {
      const parts = payload.split(':');
      await lrShowMonth(parts[2] || lrMonthKeyFromDay(dateKey(new Date())), parts[3] && parts[3] !== '0' ? parts[3] : null);
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_cal:day:')) {
      await lrShowDay(payload.split(':')[2] || dateKey(new Date()));
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_cal:saved_time:')) {
      await lrShowSavedManager(payload.split(':')[2] || dateKey(new Date()));
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_cal:add_saved:')) {
      await lrAskSavedTime(payload.split(':')[2] || dateKey(new Date()));
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_cal:delete_saved:')) {
      const parts = payload.split(':');
      await lrDeleteSavedTime(parts[2] || dateKey(new Date()), parts[3] || '');
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_cal:manual_day:')) {
      await lrAskManualTime(payload.split(':')[2] || dateKey(new Date()));
      return res.json({ ok: true });
    }

    if (payload.startsWith('lr_cal:pick:')) {
      const parts = payload.split(':');
      await lrFinalizeSchedule(parts[2] || dateKey(new Date()), parts[3] || '');
      return res.json({ ok: true });
    }

    return next();
  } catch (error) {
    console.error('[LR_CALENDAR_SCHEDULE_BUTTON_V7]', error && error.stack ? error.stack : error);
    return next();
  }
});
/* LR_CALENDAR_SCHEDULE_BUTTON_V6_END */

/* LR_MONTH_CALENDAR_V1_START */
app.use(async function lrMonthCalendarMiddleware(req, res, next) {
  try {
    const update = req.body || {};
    const payload = getCallbackPayload(update);
    const callbackId = getCallbackId(update);
    const chatId = getChatId(update);
    const key = getSessionKey(update);

    function lrRows(r) {
      return Array.isArray(r) ? r : (r && r.rows ? r.rows : []);
    }

    function lrEsc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function lrDateKeyLocal(date) {
      const d = new Date(date);
      return String(d.getFullYear()).padStart(4, '0') + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    }

    function lrMskNow() {
      return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
    }

    function lrTodayKey() {
      return lrDateKeyLocal(lrMskNow());
    }

    function lrParseDayKey(dayKey) {
      const p = String(dayKey || lrTodayKey()).split('-').map(Number);
      return new Date(p[0] || 2026, (p[1] || 1) - 1, p[2] || 1);
    }

    function lrMonthKeyFromDay(dayKey) {
      const d = lrParseDayKey(dayKey);
      return String(d.getFullYear()).padStart(4, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }

    function lrMonthName(monthIndex) {
      return ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'][monthIndex] || '';
    }

    function lrHumanDate(dayKey) {
      const d = lrParseDayKey(dayKey);
      const names = ['вс','пн','вт','ср','чт','пт','сб'];
      const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
      return names[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ' г.';
    }

    function lrPrevMonth(monthKey) {
      const p = String(monthKey).split('-').map(Number);
      const d = new Date(p[0], (p[1] || 1) - 2, 1);
      return String(d.getFullYear()).padStart(4, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }

    function lrNextMonth(monthKey) {
      const p = String(monthKey).split('-').map(Number);
      const d = new Date(p[0], p[1] || 1, 1);
      return String(d.getFullYear()).padStart(4, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }

    function lrNormalizeTime(raw) {
      const s = String(raw || '').trim();
      let m = s.match(/^(\d{1,2})[:.\s](\d{2})$/);
      if (!m) m = s.match(/^(\d{2})(\d{2})$/);
      if (!m) return null;

      const hh = Number(m[1]);
      const mm = Number(m[2]);

      if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

      return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }

    function lrTimePayload(timeText) {
      return String(timeText || '').replace(':', '');
    }

    function lrDayStartIso(dayKey) {
      return dayKey + 'T00:00:00+03:00';
    }

    function lrDayEndIso(dayKey) {
      return dayKey + 'T23:59:59+03:00';
    }

    async function lrEnsureSavedTimesTable() {
      await query("CREATE TABLE IF NOT EXISTS channel_saved_times (id serial PRIMARY KEY, channel_id integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE, time_text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(channel_id, time_text))");
    }

    async function lrCb(text, rows) {
      if (callbackId) {
        return answerCallback({
          callbackId: callbackId,
          text: text,
          format: 'html',
          attachments: rows && rows.length ? inlineKeyboard(rows) : []
        });
      }

      if (chatId) {
        return sendMaxMessage({
          chatId: chatId,
          text: text,
          format: 'html',
          attachments: rows && rows.length ? inlineKeyboard(rows) : []
        });
      }
    }

    function lrDraftFromSession(session) {
      const data = session && session.data ? session.data : {};
      const raw = data.draft ? data.draft : data;
      try {
        return typeof safeDraft === 'function' ? safeDraft(raw) : raw;
      } catch {
        return raw || {};
      }
    }

    async function lrCurrentDraft() {
      const session = await getSession(key);
      return lrDraftFromSession(session);
    }

    function lrChannelIdsFromDraft(draft) {
      if (!draft) return [];
      if (Array.isArray(draft.channelIds)) return draft.channelIds.map(Number).filter(Boolean);
      if (draft.channelId) return [Number(draft.channelId)].filter(Boolean);
      return [];
    }

    async function lrBusyTimes(dayKey, channelIds) {
      if (!channelIds.length) return new Set();

      const r = await query(
        "SELECT to_char(publish_at AT TIME ZONE 'Europe/Moscow', 'HH24:MI') AS time_text FROM scheduled_posts WHERE channel_id = ANY($1::int[]) AND status IN ('scheduled','publishing') AND publish_at >= $2::timestamptz AND publish_at <= $3::timestamptz",
        [channelIds, lrDayStartIso(dayKey), lrDayEndIso(dayKey)]
      );

      return new Set(lrRows(r).map(x => String(x.time_text || '').trim()).filter(Boolean));
    }

    async function lrSavedTimes(channelIds) {
      await lrEnsureSavedTimesTable();

      if (!channelIds.length) return [];

      const r = await query(
        "SELECT DISTINCT time_text FROM channel_saved_times WHERE channel_id = ANY($1::int[]) ORDER BY time_text",
        [channelIds]
      );

      return lrRows(r).map(x => String(x.time_text || '').trim()).filter(Boolean);
    }

    async function lrFreeSavedTimes(dayKey, channelIds) {
      const saved = await lrSavedTimes(channelIds);
      const busy = await lrBusyTimes(dayKey, channelIds);
      return saved.filter(t => !busy.has(t));
    }

    function lrMonthRows(monthKey, selectedDay) {
      const p = String(monthKey || lrMonthKeyFromDay(lrTodayKey())).split('-').map(Number);
      const year = p[0] || lrMskNow().getFullYear();
      const month = (p[1] || 1) - 1;

      const today = lrTodayKey();
      const first = new Date(year, month, 1);
      const last = new Date(year, month + 1, 0);
      const start = new Date(first);

      const mondayOffset = (first.getDay() || 7) - 1;
      start.setDate(first.getDate() - mondayOffset);

      const rows = [];

      rows.push([
        callbackButton('⬅️ ' + lrMonthName(new Date(year, month - 1, 1).getMonth()), 'lr_cal:month:' + lrPrevMonth(monthKey) + ':0'),
        callbackButton(lrMonthName(month) + ' ' + year, 'noop'),
        callbackButton(lrMonthName(new Date(year, month + 1, 1).getMonth()) + ' ➡️', 'lr_cal:month:' + lrNextMonth(monthKey) + ':0')
      ]);

      rows.push([
        callbackButton('ПН', 'noop'),
        callbackButton('ВТ', 'noop'),
        callbackButton('СР', 'noop'),
        callbackButton('ЧТ', 'noop'),
        callbackButton('ПТ', 'noop'),
        callbackButton('СБ', 'noop'),
        callbackButton('ВС', 'noop')
      ]);

      for (let week = 0; week < 6; week++) {
        const row = [];
        for (let day = 0; day < 7; day++) {
          const d = new Date(start);
          d.setDate(start.getDate() + week * 7 + day);

          const dk = lrDateKeyLocal(d);
          const inMonth = d.getMonth() === month;
          const isPast = dk < today;

          let label = inMonth ? String(d.getDate()) : '·';
          if (selectedDay && dk === selectedDay) label = '✅ ' + label;
          if (isPast) label = '•';

          row.push(callbackButton(label, (!inMonth || isPast) ? 'noop' : 'lr_cal:day:' + dk));
        }
        rows.push(row);

        const weekEnd = new Date(start);
        weekEnd.setDate(start.getDate() + week * 7 + 6);
        if (weekEnd > last && week >= 4) break;
      }

      rows.push([callbackButton('✍️ Ввести время вручную', 'schedule:manual')]);
      rows.push([callbackButton('⬅️ Назад', 'editor:next')]);

      return rows;
    }

    async function lrShowMonth(monthKey, selectedDay) {
      const p = String(monthKey || lrMonthKeyFromDay(lrTodayKey())).split('-').map(Number);
      const title = lrMonthName((p[1] || 1) - 1) + ' ' + (p[0] || lrMskNow().getFullYear());

      return lrCb(
        '━━━━━━━━━━━━━━\n📅 <b>Календарь публикации</b>\n\n' +
        title +
        '\n\nВыберите день. Календарь идёт по неделям: 7 дней в ряд.\n' +
        'Прошедшие дни отмечены точкой.\n━━━━━━━━━━━━━━',
        lrMonthRows(monthKey, selectedDay)
      );
    }

    async function lrShowDay(dayKey) {
      const draft = await lrCurrentDraft();
      const channelIds = lrChannelIdsFromDraft(draft);
      const savedFree = await lrFreeSavedTimes(dayKey, channelIds);
      const busy = await lrBusyTimes(dayKey, channelIds);

      const rows = [];

      if (savedFree.length) {
        const line = [];
        for (const t of savedFree.slice(0, 3)) {
          line.push(callbackButton('💾 ' + t, 'lr_cal:pick:' + dayKey + ':' + lrTimePayload(t)));
        }
        rows.push(line);

        if (savedFree.length > 3) {
          const line2 = [];
          for (const t of savedFree.slice(3, 6)) {
            line2.push(callbackButton('💾 ' + t, 'lr_cal:pick:' + dayKey + ':' + lrTimePayload(t)));
          }
          rows.push(line2);
        }
      }

      rows.push([callbackButton('💾 Сохранённое время', 'lr_cal:saved_time:' + dayKey)]);

            // LR_CALENDAR_SAVED_TIMES_V4: стандартные времена 09/12/15/18/21/23 убраны

            // LR_CALENDAR_SAVED_TIMES_V4: стандартные времена 09/12/15/18/21/23 убраны

      rows.push([callbackButton('✍️ Ввести время вручную', 'schedule:manual_day:' + dayKey)]);
      rows.push([callbackButton('⬅️ К месяцу', 'lr_cal:month:' + lrMonthKeyFromDay(dayKey) + ':' + dayKey)]);

      let savedText = savedFree.length
        ? savedFree.map(t => '💾 ' + t).join('  ')
        : 'нет свободного сохранённого времени';

      if (busy.size) {
        savedText += '\n\nЗанято на этот день: ' + Array.from(busy).join(', ');
      }

      return lrCb(
        '━━━━━━━━━━━━━━\n📅 <b>' + lrEsc(lrHumanDate(dayKey)) + '</b>\n\n' +
        'Сохранённое время:\n' + lrEsc(savedText) +
        '\n\nЕсли сохранённое время уже занято на этот день, оно не показывается кнопкой.\n━━━━━━━━━━━━━━',
        rows
      );
    }

    async function lrAskSavedTime(dayKey) {
      const session = await getSession(key);
      const draft = lrDraftFromSession(session);

      await setSession(key, 'lr_wait_calendar_saved_time', {
        draft: draft,
        dayKey: dayKey
      });

      return lrCb(
        '💾 Введите сохранённое время для канала.\n\nПример: 18:30 или 1830.\nОно сохранится для выбранного канала и будет показываться сверху при выборе даты, если время свободно.',
        [[callbackButton('⬅️ Назад к дате', 'lr_cal:day:' + dayKey)]]
      );
    }

    async function lrSaveTimeFromMessage() {
      const session = await getSession(key);
      if (!session || session.state !== 'lr_wait_calendar_saved_time') return false;

      const text = getMessageText(update);
      const time = lrNormalizeTime(text);

      if (!time) {
        await sendMaxMessage({
          chatId: chatId,
          text: '⚠️ Введите время в формате 18:30 или 1830.',
          format: 'html',
          attachments: inlineKeyboard([[callbackButton('⬅️ Назад', 'lr_cal:day:' + (session.data && session.data.dayKey ? session.data.dayKey : lrTodayKey()))]])
        });
        return true;
      }

      const draft = lrDraftFromSession(session);
      const channelIds = lrChannelIdsFromDraft(draft);

      if (!channelIds.length) {
        await sendMaxMessage({
          chatId: chatId,
          text: '⚠️ Сначала выберите канал для поста.',
          format: 'html'
        });
        await clearSession(key);
        return true;
      }

      await lrEnsureSavedTimesTable();

      for (const channelId of channelIds) {
        await query(
          "INSERT INTO channel_saved_times(channel_id, time_text, updated_at) VALUES($1, $2, now()) ON CONFLICT(channel_id, time_text) DO UPDATE SET updated_at=now()",
          [channelId, time]
        );
      }

      await setSession(key, 'publish_menu', { draft: draft });

      await sendMaxMessage({
        chatId: chatId,
        text: '✅ Сохранённое время добавлено: <b>' + lrEsc(time) + '</b>',
        format: 'html'
      });

      await lrShowDay(session.data && session.data.dayKey ? session.data.dayKey : lrTodayKey());
      return true;
    }

    if (await lrSaveTimeFromMessage()) {
      return res.json({ ok: true });
    }

    if (!payload) return next();

    if (payload === 'noop') {
      if (callbackId) {
        await answerCallback({ callbackId, notification: 'Недоступно' }).catch(function(){});
      }
      return res.json({ ok: true });
    }

    if (payload === 'schedule:calendar') {
      return lrShowMonth(lrMonthKeyFromDay(lrTodayKey()), null).then(function(){ return res.json({ ok: true }); });
    }

    if (payload.startsWith('schedule:week:')) {
      const dayKey = payload.split(':')[2] || lrTodayKey();
      return lrShowMonth(lrMonthKeyFromDay(dayKey), dayKey).then(function(){ return res.json({ ok: true }); });
    }

    if (payload.startsWith('schedule:day:')) {
      const dayKey = payload.split(':')[2] || lrTodayKey();
      return lrShowDay(dayKey).then(function(){ return res.json({ ok: true }); });
    }

    if (payload.startsWith('lr_cal:month:')) {
      const parts = payload.split(':');
      const monthKey = parts[2] || lrMonthKeyFromDay(lrTodayKey());
      const selected = parts[3] && parts[3] !== '0' ? parts[3] : null;
      return lrShowMonth(monthKey, selected).then(function(){ return res.json({ ok: true }); });
    }

    if (payload.startsWith('lr_cal:day:')) {
      const dayKey = payload.split(':')[2] || lrTodayKey();
      return lrShowDay(dayKey).then(function(){ return res.json({ ok: true }); });
    }

    if (payload.startsWith('lr_cal:saved_time:')) {
      const dayKey = payload.split(':')[2] || lrTodayKey();
      return lrAskSavedTime(dayKey).then(function(){ return res.json({ ok: true }); });
    }

    return next();
  } catch (error) {
    console.error('[LR_MONTH_CALENDAR_V1]', error && error.message ? error.message : error);
    return next();
  }
});
/* LR_MONTH_CALENDAR_V1_END */

/* LR_CLEAN_SIGNATURE_FIX_START */
app.use(async function lrCleanSignatureMiddleware(req, res, next) {
  try {
    const update = req.body || {};
    const payload = getCallbackPayload(update);
    const callbackId = getCallbackId(update);
    const chatId = getChatId(update);
    const key = getSessionKey(update);

    function lrRows(r) {
      return Array.isArray(r) ? r : (r && r.rows ? r.rows : []);
    }

    function lrEsc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function lrPlain(v) {
      return String(v || '')
        .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(b|strong|i|em|u|s|strike|code|pre|span|p|div|h1|h2|h3)[^>]*>/gi, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
    }

    async function lrSigChannels(onlyIds) {
      if (onlyIds && onlyIds.length) {
        const r = await query(
          'SELECT * FROM channels WHERE id = ANY($1::int[]) ORDER BY id',
          [onlyIds.map(Number)]
        );
        return lrRows(r);
      }

      const r = await query('SELECT * FROM channels ORDER BY id');
      return lrRows(r);
    }

    async function lrSigChannel(channelId) {
      const r = await query('SELECT * FROM channels WHERE id=$1 LIMIT 1', [Number(channelId)]);
      return lrRows(r)[0] || null;
    }

    async function lrLoadSig(channelId) {
      const r = await query(
        'SELECT * FROM channel_signatures WHERE channel_id=$1 ORDER BY is_active DESC, updated_at DESC, id DESC LIMIT 1',
        [Number(channelId)]
      );
      return lrRows(r)[0] || null;
    }

    async function lrSaveSig(channelId, content) {
      const markup = (Array.isArray(content.markup) ? content.markup : []).filter(function(m) {
        const t = String((m && (m.type || m.kind)) || '').toLowerCase();
        return !t.includes('quote') && !t.includes('blockquote') && !t.includes('citation') && !t.includes('cite');
      });

      await query(
        'INSERT INTO channel_signatures(channel_id, owner_key, title, text, format, markup, is_active, updated_at) VALUES($1, $2, $3, $4, $5, $6::jsonb, true, now()) ON CONFLICT(channel_id, owner_key) DO UPDATE SET text=EXCLUDED.text, format=EXCLUDED.format, markup=EXCLUDED.markup, is_active=true, updated_at=now()',
        [Number(channelId), 'global', 'Автоподпись', String(content.text || '').trim(), 'html', JSON.stringify(markup)]
      );
    }

    function lrKb(rows) {
      return inlineKeyboard(rows);
    }

    async function lrCb(text, rows) {
      return answerCallback({
        callbackId: callbackId,
        text: text,
        format: 'html',
        attachments: lrKb(rows || [])
      });
    }

    async function lrMsg(text, rows) {
      return sendMaxMessage({
        chatId: chatId,
        text: text,
        format: 'html',
        attachments: rows && rows.length ? lrKb(rows) : []
      });
    }

    function lrChName(ch) {
      return lrEsc(ch && (ch.title || ch.name || ch.link || ('Канал ' + ch.id)));
    }

    function lrBack(mode) {
      return mode === 'editor'
        ? callbackButton('⬅️ В редактор', 'editor:back')
        : callbackButton('⬅️ В Studio', 'main:posting');
    }

    async function lrShowSigList(mode, onlyIds) {
      const channels = await lrSigChannels(onlyIds);

      if (!channels.length) {
        await lrCb('━━━━━━━━━━━━━━\n🏷 <b>Автоподписи</b>\n\nКаналы не найдены.\n━━━━━━━━━━━━━━', [[lrBack(mode)]]);
        return res.json({ ok: true });
      }

      const buttons = [];

      for (const ch of channels) {
        const sig = await lrLoadSig(ch.id);
        const active = Boolean(sig && sig.text && sig.is_active);
        buttons.push([
          callbackButton((active ? '🟢 ' : '🔴 ') + lrPlain(ch.title || ch.name || ('Канал ' + ch.id)), 'lr:sig:channel:' + ch.id + ':' + mode)
        ]);
      }

      buttons.push([lrBack(mode)]);

      await lrCb(
        '━━━━━━━━━━━━━━\n🏷 <b>Автоподписи</b>\n\n🟢 подпись включена\n🔴 подпись выключена или не создана\n\nВыберите канал.\n━━━━━━━━━━━━━━',
        buttons
      );

      return res.json({ ok: true });
    }

    async function lrShowSigChannel(channelId, mode) {
      const ch = await lrSigChannel(channelId);
      const sig = await lrLoadSig(channelId);
      const active = Boolean(sig && sig.text && sig.is_active);

      const text = [
        '━━━━━━━━━━━━━━',
        '🏷 <b>Автоподпись</b>',
        '',
        'Канал:',
        ch ? lrChName(ch) : ('Канал ' + channelId),
        '',
        'Статус: ' + (active ? '🟢 включена' : '🔴 выключена или не создана'),
        '',
        sig && sig.text ? String(sig.text) : '<i>подпись не создана</i>',
        '━━━━━━━━━━━━━━'
      ].join('\n');

      const buttons = [
        [callbackButton('✏️ Заменить подпись', 'lr:sig:add:' + channelId + ':' + mode)],
        [callbackButton(active ? '🔴 Выключить' : '🟢 Включить', 'lr:sig:toggle:' + channelId + ':' + mode)],
        [lrBack(mode)]
      ];

      await lrCb(text, buttons);
      return res.json({ ok: true });
    }

    async function lrAskSignature(channelId, mode) {
      const session = await getSession(key);
      const draft = safeDraft(session && session.data && session.data.draft ? session.data.draft : (session && session.data ? session.data : {}));

      await setSession(key, 'lr_wait_signature_clean', {
        channelId: Number(channelId),
        mode: mode,
        draft: draft
      });

      await lrCb(
        '🏷 Отправьте подпись. Ссылки, жирный, курсив, подчёркивание, зачёркивание, моно и заголовок MAX сохранятся.\n\nЦитата в подписи специально будет обычным текстом.',
        [[callbackButton('⬅️ Назад', 'lr:sig:channel:' + channelId + ':' + mode)]]
      );

      return res.json({ ok: true });
    }

    if (payload === 'sig:menu') {
      return lrShowSigList('studio', null);
    }

    if (payload === 'editor:signature') {
      const session = await getSession(key);
      const draft = safeDraft(session && session.data && session.data.draft ? session.data.draft : (session && session.data ? session.data : {}));
      const ids = Array.isArray(draft.channelIds) ? draft.channelIds.map(Number).filter(Boolean) : [];

      if (ids.length === 1) return lrShowSigChannel(ids[0], 'editor');
      if (ids.length > 1) return lrShowSigList('editor', ids);

      return lrShowSigList('editor', null);
    }

    if (payload.startsWith('lr:sig:channel:')) {
      const p = payload.split(':');
      return lrShowSigChannel(Number(p[3]), p[4] || 'studio');
    }

    if (payload.startsWith('lr:sig:add:')) {
      const p = payload.split(':');
      return lrAskSignature(Number(p[3]), p[4] || 'studio');
    }

    if (payload.startsWith('lr:sig:toggle:')) {
      const p = payload.split(':');
      const channelId = Number(p[3]);
      const mode = p[4] || 'studio';
      const sig = await lrLoadSig(channelId);
      const nextActive = !(sig && sig.text && sig.is_active);

      await query('UPDATE channel_signatures SET is_active=$2, updated_at=now() WHERE channel_id=$1', [channelId, nextActive]);

      return lrShowSigChannel(channelId, mode);
    }

    if (payload.startsWith('sig:channel:')) {
      return lrShowSigChannel(Number(payload.split(':')[2]), 'studio');
    }

    if (payload.startsWith('sig:add_channel:')) {
      return lrAskSignature(Number(payload.split(':')[2]), 'studio');
    }

    if (payload.startsWith('sig:toggle_channel:')) {
      const channelId = Number(payload.split(':')[2]);
      const sig = await lrLoadSig(channelId);
      await query('UPDATE channel_signatures SET is_active=$2, updated_at=now() WHERE channel_id=$1', [channelId, !(sig && sig.text && sig.is_active)]);
      return lrShowSigChannel(channelId, 'studio');
    }

    const session = await getSession(key);

    if (session && session.state === 'lr_wait_signature_clean') {
      const channelId = Number(session.data && session.data.channelId);
      const mode = (session.data && session.data.mode) || 'studio';
      const draft = safeDraft(session.data && session.data.draft ? session.data.draft : {});

      const content = await hydrateContent(update);
      const markup = (Array.isArray(content.markup) ? content.markup : []).filter(function(m) {
        const t = String((m && (m.type || m.kind)) || '').toLowerCase();
        return !t.includes('quote') && !t.includes('blockquote') && !t.includes('citation') && !t.includes('cite');
      });

      const text = String(content.text || '').replace(/\\n/g, '\n').trim();

      if (!text) {
        await lrMsg('⚠️ Подпись пустая. Отправьте текст подписи.');
        return res.json({ ok: true });
      }

      await lrSaveSig(channelId, {
        text: text,
        markup: markup
      });

      if (mode === 'editor') {
        draft.signatureEnabled = true;
        await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft: draft });
        await lrMsg('✅ Подпись добавлена в канал.');
        await sendDraftPreview(chatId, draft);
        await msg(chatId, editorMenuText(), editorMenuRows(draft));
      } else {
        await clearSession(key);
        await lrMsg('✅ Подпись добавлена в канал.');
        if (typeof sendStudio === 'function') {
          await sendStudio(chatId);
        } else {
          await lrMsg('━━━━━━━━━━━━━━\n🧬 <b>LinkRay Studio</b>\n\nВыберите действие.\n━━━━━━━━━━━━━━', [
            [callbackButton('🧬 LinkRay Studio', 'main:posting')],
            [callbackButton('🔗 Добавить канал', 'channel:add')],
            [callbackButton('📊 Отчёты', 'reports:menu'), callbackButton('🛡 Антифрод', 'fraud:menu')]
          ]);
        }
      }

      return res.json({ ok: true });
    }

    return next();
  } catch (e) {
    console.error('[LR_CLEAN_SIGNATURE_FIX]', e && e.message ? e.message : e);
    return next();
  }
});
/* LR_CLEAN_SIGNATURE_FIX_END */

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
function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`); await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()`);

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
function lrFirstNonEmpty(...values) {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const text = String(v).trim();
    if (text && text !== 'undefined' && text !== 'null' && text !== 'NaN') return v;
  }
  return null;
}

function lrDeepFirst(obj, keys, seen = new Set(), depth = 0) {
  if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > 7) return null;
  seen.add(obj);

  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }

  for (const child of Object.values(obj)) {
    if (child && typeof child === 'object') {
      const found = lrDeepFirst(child, keys, seen, depth + 1);
      if (found !== null && found !== undefined && String(found).trim() !== '') return found;
    }
  }

  return null;
}

function getChatId(u) {
  return lrFirstNonEmpty(
    u?.chat_id,
    u?.chatId,
    u?.chat?.id,
    u?.chat?.chat_id,
    u?.chat?.chatId,
    u?.recipient?.chat_id,
    u?.recipient?.chatId,
    u?.body?.chat_id,
    u?.body?.chatId,
    u?.message?.recipient?.chat_id,
    u?.message?.recipient?.chatId,
    u?.message?.chat_id,
    u?.message?.chatId,
    u?.message?.chat?.id,
    u?.message?.chat?.chat_id,
    u?.message?.chat?.chatId,
    u?.callback?.chat?.id,
    u?.callback?.chat?.chat_id,
    u?.callback?.chat?.chatId,
    u?.callback?.message?.recipient?.chat_id,
    u?.callback?.message?.recipient?.chatId,
    u?.callback?.message?.chat_id,
    u?.callback?.message?.chatId,
    u?.callback?.message?.chat?.id
  );
}

function getUserId(u) {
  return lrFirstNonEmpty(
    u?.user_id,
    u?.userId,
    u?.user?.id,
    u?.user?.user_id,
    u?.user?.userId,
    u?.sender?.id,
    u?.sender?.user_id,
    u?.sender?.userId,
    u?.message?.sender?.user_id,
    u?.message?.sender?.userId,
    u?.message?.sender?.id,
    u?.callback?.user?.user_id,
    u?.callback?.user?.userId,
    u?.callback?.user?.id,
    lrDeepFirst(u, ['user_id', 'userId'])
  );
}

function getSessionKey(u) {
  const chat = getChatId(u);
  if (chat) return String(chat);

  const user = getUserId(u);
  if (user) return `user:${user}`;

  return 'unknown';
}

function lrResolveReplyChatId(update, fallback = '') {
  const chat = update ? getChatId(update) : null;
  if (chat) return String(chat);

  const user = update ? getUserId(update) : null;
  if (user) return `user:${user}`;

  const f = String(fallback || '').trim();
  return f || 'unknown';
}

function lrBuildSendTarget(target) {
  const id = String(target || '').trim();

  if (!id || id === 'unknown' || id === 'undefined' || id === 'null' || id === 'NaN') {
    throw new Error('Не найден chat_id/user_id для отправки ответа');
  }

  if (id.startsWith('user:')) {
    return { userId: id.slice(5) };
  }

  return { chatId: id };
}

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
async function msg(chatId, text, rows = [], format = 'html') {
  const target = lrBuildSendTarget(chatId);
  return sendMaxMessage({
    ...target,
    text,
    format,
    attachments: rows.length ? buttonRows(rows) : []
  });
}

async function sendMessage(chatId, { text = '', buttons = [], format = 'html' } = {}) {
  return msg(chatId, text, buttons, format);
}

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
function channelLine(ch) {
  const title = escapeHtml(channelName(ch));
  return `• ${title}`;
} function channelsLines(channels) { return (channels || []).map(channelLine).join('\n') || '• канал не выбран'; }

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

// LR_FORWARD_HYDRATE_EXACT_V2_START
function lrDeepPickForwardMessage(update) {
  const direct = [
    update?.message?.link?.message,
    update?.link?.message,
    update?.message?.body?.link?.message,
    update?.body?.link?.message,
    update?.message?.forward?.message,
    update?.forward?.message,
    update?.message?.body?.forward?.message,
    update?.message,
    update?.message?.body,
    update?.body,
    update
  ].filter(Boolean);

  const all = [];
  const seen = new WeakSet();

  function walk(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (!Array.isArray(value)) {
      const text =
        value.text ??
        value.body?.text ??
        value.content?.text ??
        value.message?.text ??
        value.message?.body?.text ??
        '';

      const markup =
        value.markup ??
        value.body?.markup ??
        value.content?.markup ??
        value.message?.markup ??
        value.message?.body?.markup ??
        [];

      const attachments =
        value.attachments ??
        value.body?.attachments ??
        value.content?.attachments ??
        value.message?.attachments ??
        value.message?.body?.attachments ??
        [];

      if (
        String(text || '').trim() ||
        (Array.isArray(markup) && markup.length) ||
        (Array.isArray(attachments) && attachments.length)
      ) {
        all.push(value);
      }
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }

    for (const key of Object.keys(value)) {
      if (key === 'sender' || key === 'recipient' || key === 'chat') continue;
      walk(value[key], depth + 1);
    }
  }

  for (const item of direct) walk(item, 0);
  walk(update, 0);

  function textOf(value) {
    return String(
      value?.text ??
      value?.body?.text ??
      value?.content?.text ??
      value?.message?.text ??
      value?.message?.body?.text ??
      ''
    );
  }

  function markupOf(value) {
    const m =
      value?.markup ??
      value?.body?.markup ??
      value?.content?.markup ??
      value?.message?.markup ??
      value?.message?.body?.markup ??
      [];
    return Array.isArray(m) ? m : [];
  }

  function attachmentsOf(value) {
    const a =
      value?.attachments ??
      value?.body?.attachments ??
      value?.content?.attachments ??
      value?.message?.attachments ??
      value?.message?.body?.attachments ??
      [];
    return Array.isArray(a) ? a : [];
  }

  function score(value) {
    const text = textOf(value);
    const markup = markupOf(value);
    const attachments = attachmentsOf(value);

    let n = 0;
    if (String(text).trim()) n += 10000 + text.length;
    if (attachments.length) n += 5000 + attachments.length * 100;
    if (markup.length) n += 2000 + markup.length * 50;

    if (
      value === update?.message?.link?.message ||
      value === update?.link?.message ||
      value === update?.message?.body?.link?.message
    ) {
      n += 100000;
    }

    return n;
  }

  const unique = [];
  const uniqueSeen = new WeakSet();

  for (const item of all) {
    if (!item || typeof item !== 'object') continue;
    if (uniqueSeen.has(item)) continue;
    uniqueSeen.add(item);
    unique.push(item);
  }

  unique.sort((a, b) => score(b) - score(a));
  return unique[0] || update;
}

function lrExactTextOf(value) {
  return String(
    value?.text ??
    value?.body?.text ??
    value?.content?.text ??
    value?.message?.text ??
    value?.message?.body?.text ??
    ''
  );
}

function lrExactMarkupOf(value) {
  const m =
    value?.markup ??
    value?.body?.markup ??
    value?.content?.markup ??
    value?.message?.markup ??
    value?.message?.body?.markup ??
    [];
  return Array.isArray(m) ? m : [];
}

function lrExactAttachmentsOf(value) {
  const a =
    value?.attachments ??
    value?.body?.attachments ??
    value?.content?.attachments ??
    value?.message?.attachments ??
    value?.message?.body?.attachments ??
    [];
  return Array.isArray(a) ? a : [];
}

function lrNormalizeExactAttachments(list) {
  const raw = Array.isArray(list) ? list.filter(Boolean) : [];

  try {
    if (typeof normalizeAttachments === 'function') {
      return normalizeAttachments(raw);
    }
  } catch (error) {
    console.error('[forward exact attachments normalize]', error?.message || error);
  }

  return raw;
}

function lrNativeExactHtml(text, markup) {
  try {
    if (typeof applyMarkupToHtml === 'function') {
      return applyMarkupToHtml(text, markup);
    }

    if (typeof lrMaxMarkupToHtml === 'function') {
      return lrMaxMarkupToHtml(text, markup);
    }

    if (typeof lrMaxMarkupToMarkdown === 'function') {
      return lrMaxMarkupToMarkdown(text, markup);
    }
  } catch (error) {
    console.error('[forward exact markup convert]', error?.message || error);
  }

  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function hydrateContentUnsafe(update) {
  const picked = lrDeepPickForwardMessage(update);
  const text = lrExactTextOf(picked);
  const markup = lrExactMarkupOf(picked);
  const attachments = lrNormalizeExactAttachments(lrExactAttachmentsOf(picked));

  if (String(text || '').trim() || markup.length || attachments.length) {
    const html = lrNativeExactHtml(text, markup);

    console.log('[hydrate exact forward]', JSON.stringify({
      textLength: text.length,
      markup: markup.length,
      attachments: attachments.length,
      format: 'html'
    }));

    return {
      text: html,
      format: 'html',
      attachments,
      markup: [],
      raw: picked,
      hasRealBody: Boolean(String(text || '').trim() || attachments.length)
    };
  }

  if (typeof lrOldHydrateContentUnsafeV2 === 'function') {
    return lrOldHydrateContentUnsafeV2(update);
  }

  return {
    text: '',
    format: 'html',
    attachments: [],
    markup: [],
    raw: update,
    hasRealBody: false
  };
}

async function hydrateContent(update) {
  try {
    return await hydrateContentUnsafe(update);
  } catch (error) {
    console.error('[hydrate exact safe fallback]', error?.message || error);

    try {
      if (typeof lrOldHydrateContentUnsafeV2 === 'function') {
        return await lrOldHydrateContentUnsafeV2(update);
      }
    } catch (legacyError) {
      console.error('[hydrate exact legacy failed]', legacyError?.message || legacyError);
    }

    return {
      text: '',
      format: 'html',
      attachments: [],
      markup: [],
      raw: update,
      hasRealBody: false
    };
  }
}

// LR_QUOTE_HYDRATE_WRAP_V1_START
const __lrHydrateContentBeforeQuoteV1 = typeof hydrateContent === 'function' ? hydrateContent : null;

if (__lrHydrateContentBeforeQuoteV1) {
  hydrateContent = async function lrHydrateContentQuoteV1(update) {
    const content = await __lrHydrateContentBeforeQuoteV1(update);

    try {
      const rawText = lrQuoteFindMessageText(update);
      const extraMarkup = lrQuoteCollectNativeMarkupDeep(update, rawText);
      const hasQuote = extraMarkup.some((x) => lrQuoteKind(lrQuoteTypeOf(x)) === 'quote');

      // Если пришла нативная цитата, пересобираем HTML из исходного текста и всех native markups.
      // Это нужно именно после пересылки/обновления превью: старый путь часто теряет quote-range.
      if (rawText && hasQuote) {
        const merged = lrQuoteMergeMarkup(content?.markup || [], extraMarkup);
        return {
          ...(content || {}),
          text: applyMarkupToHtml(rawText, merged),
          format: 'html',
          markup: merged,
        };
      }
    } catch (error) {
      console.error('[quote hydrate wrapper]', error.message || error);
    }

    return content;
  };
}
// LR_QUOTE_HYDRATE_WRAP_V1_END

// LR_FORWARD_HYDRATE_EXACT_V2_END

// LR_NATIVE_MAX_MARKUP_V4_START
function lrRichHtmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lrRichAttr(value) {
  return lrRichHtmlEscape(value).replace(/\n/g, '').trim();
}

function lrRichType(mark) {
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

function lrRichUrl(mark) {
  return String(
    mark?.url ||
    mark?.href ||
    mark?.link ||
    mark?.payload?.url ||
    mark?.payload?.href ||
    mark?.payload?.link ||
    ''
  ).trim();
}

function lrRichStart(mark, max) {
  const raw = mark?.from ?? mark?.start ?? mark?.offset ?? mark?.position ?? mark?.index ?? 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, n));
}

function lrRichEnd(mark, start, max) {
  const direct = mark?.to ?? mark?.end;
  if (direct !== undefined && direct !== null && direct !== '') {
    const n = Number(direct);
    if (Number.isFinite(n) && n > start) return Math.max(start, Math.min(max, n));
  }

  const len = mark?.length ?? mark?.len ?? mark?.size;
  const n = Number(len);
  if (Number.isFinite(n) && n > 0) return Math.max(start, Math.min(max, start + n));

  return start;
}

function lrRichKind(type) {
  if (!type) return '';
  if (type.includes('quote') || type.includes('blockquote') || type.includes('quotation') || type.includes('quoted') || type.includes('cite')) return 'quote';
  if (type.includes('heading') || type.includes('header') || type.includes('title') || /^h[1-6]$/.test(type)) return 'heading';
  if (type.includes('bold') || type.includes('strong') || type === 'b') return 'bold';
  if (type.includes('italic') || type.includes('emphas') || type === 'em' || type === 'i') return 'italic';
  if (type.includes('underline') || type === 'u' || type === 'ins') return 'underline';
  if (type.includes('strike') || type.includes('through') || type.includes('delete') || type === 's' || type === 'del') return 'strike';
  if (type.includes('mono') || type.includes('code') || type.includes('pre') || type === 'tt') return 'code';
  if (type.includes('mark') || type.includes('highlight')) return 'mark';
  if (type.includes('link') || type.includes('url') || type === 'a') return 'link';
  return '';
}

function lrRichNormalizeMarks(text, markup) {
  const source = String(text ?? '');
  const max = source.length;
  const list = Array.isArray(markup) ? markup : [];
  const out = [];

  for (const mark of list) {
    if (!mark || typeof mark !== 'object') continue;
    const type = lrRichType(mark);
    const kind = lrRichKind(type);
    if (!kind) continue;

    const start = lrRichStart(mark, max);
    const end = lrRichEnd(mark, start, max);
    if (end <= start || start >= max) continue;

    const url = lrRichUrl(mark);
    if (kind === 'link' && !url) continue;

    out.push({ kind, type, start, end, url });
  }

  return out;
}

function lrRichTagsFor(active) {
  const tags = [];
  const has = (kind) => active.some((x) => x.kind === kind);
  const link = [...active].reverse().find((x) => x.kind === 'link' && x.url);

  if (has('quote')) tags.push(['<blockquote>', '</blockquote>']);
  if (has('heading')) tags.push(['<h1>', '</h1>']);
  if (has('bold')) tags.push(['<b>', '</b>']);
  if (has('italic')) tags.push(['<i>', '</i>']);
  if (has('underline')) tags.push(['<u>', '</u>']);
  if (has('strike')) tags.push(['<s>', '</s>']);
  if (has('code')) tags.push(['<code>', '</code>']);
  if (has('mark')) tags.push(['<mark>', '</mark>']);
  if (link) tags.push(['<a href="' + lrRichAttr(link.url) + '">', '</a>']);

  return tags;
}

function applyMarkupToHtml(text, markup = []) {
  const source = String(text ?? '');

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function attr(value) {
    return esc(value).replace(/'/g, '&#39;');
  }

  function rawType(mark) {
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
      mark?.message_style ||
      mark?.messageStyle ||
      mark?.payload?.type ||
      mark?.payload?.kind ||
      mark?.payload?.style ||
      ''
    ).toLowerCase();
  }

  function kind(mark) {
    const t = rawType(mark);

    if (
      t.includes('blockquote') ||
      t.includes('block_quote') ||
      t.includes('block-quote') ||
      t.includes('quote') ||
      t.includes('quotation') ||
      t.includes('quoted') ||
      t.includes('citation') ||
      t.includes('cite')
    ) return 'quote';

    if (t.includes('heading') || t.includes('header') || t.includes('title') || /^h[1-6]$/.test(t)) return 'heading';
    if (t.includes('bold') || t.includes('strong') || t === 'b') return 'bold';
    if (t.includes('italic') || t.includes('emphasis') || t.includes('emphasized') || t === 'em' || t === 'i') return 'italic';
    if (t.includes('underline') || t === 'u' || t === 'ins') return 'underline';
    if (t.includes('strike') || t.includes('through') || t.includes('deleted') || t === 's' || t === 'del') return 'strike';
    if (t.includes('mono') || t.includes('code') || t.includes('pre') || t === 'tt') return 'code';
    if (t.includes('mark') || t.includes('highlight')) return 'mark';
    if (t.includes('link') || t.includes('url') || t === 'a') return 'link';

    return '';
  }

  function startOf(mark, max) {
    const n = Number(mark?.from ?? mark?.start ?? mark?.offset ?? mark?.position ?? mark?.index ?? mark?.begin ?? 0);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
  }

  function endOf(mark, start, max) {
    const direct = mark?.to ?? mark?.end ?? mark?.stop;

    if (direct !== undefined && direct !== null && direct !== '') {
      const n = Number(direct);
      if (Number.isFinite(n) && n > start) return Math.max(start, Math.min(max, n));
    }

    const len = Number(mark?.length ?? mark?.len ?? mark?.size ?? mark?.count);
    if (Number.isFinite(len) && len > 0) return Math.max(start, Math.min(max, start + len));

    return start;
  }

  function urlOf(mark) {
    const url = String(
      mark?.url ||
      mark?.href ||
      mark?.link ||
      mark?.payload?.url ||
      mark?.payload?.href ||
      mark?.payload?.link ||
      ''
    ).trim();

    if (!url) return '';
    if (/^javascript:/i.test(url)) return '';
    return url;
  }

  function priority(k) {
    if (k === 'quote') return 0;
    if (k === 'heading') return 1;
    if (k === 'link') return 2;
    if (k === 'bold') return 3;
    if (k === 'italic') return 4;
    if (k === 'underline') return 5;
    if (k === 'strike') return 6;
    if (k === 'code') return 7;
    if (k === 'mark') return 8;
    return 99;
  }

  function openTag(item) {
    if (item.kind === 'quote') return '<blockquote>';
    if (item.kind === 'heading') return '<h1>';
    if (item.kind === 'bold') return '<b>';
    if (item.kind === 'italic') return '<i>';
    if (item.kind === 'underline') return '<u>';
    if (item.kind === 'strike') return '<s>';
    if (item.kind === 'code') return '<code>';
    if (item.kind === 'mark') return '<mark>';
    if (item.kind === 'link') return item.url ? '<a href="' + attr(item.url) + '">' : '';
    return '';
  }

  function closeTag(item) {
    if (item.kind === 'quote') return '</blockquote>';
    if (item.kind === 'heading') return '</h1>';
    if (item.kind === 'bold') return '</b>';
    if (item.kind === 'italic') return '</i>';
    if (item.kind === 'underline') return '</u>';
    if (item.kind === 'strike') return '</s>';
    if (item.kind === 'code') return '</code>';
    if (item.kind === 'mark') return '</mark>';
    if (item.kind === 'link') return item.url ? '</a>' : '';
    return '';
  }

  const max = source.length;
  const list = Array.isArray(markup) ? markup : [];
  const items = [];
  const seen = new Set();

  for (const mark of list) {
    if (!mark || typeof mark !== 'object') continue;

    const k = kind(mark);
    if (!k) continue;

    const start = startOf(mark, max);
    const end = endOf(mark, start, max);
    const url = urlOf(mark);

    if (end <= start || start >= max) continue;
    if (k === 'link' && !url) continue;

    const key = [k, start, end, url].join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({ mark, kind: k, start, end, url, priority: priority(k) });
  }

  if (!source) return '';
  if (!items.length) return esc(source);

  items.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.end - a.end;
  });

  const opens = new Map();
  const closes = new Map();

  for (const item of items) {
    if (!opens.has(item.start)) opens.set(item.start, []);
    if (!closes.has(item.end)) closes.set(item.end, []);

    opens.get(item.start).push(item);
    closes.get(item.end).push(item);
  }

  for (const arr of opens.values()) {
    arr.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.end - a.end;
    });
  }

  for (const arr of closes.values()) {
    arr.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.start - b.start;
    });
  }

  let out = '';

  for (let i = 0; i <= max; i++) {
    const closeItems = closes.get(i);
    if (closeItems) {
      for (const item of closeItems) out += closeTag(item);
    }

    const openItems = opens.get(i);
    if (openItems) {
      for (const item of openItems) out += openTag(item);
    }

    if (i < max) out += esc(source[i]);
  }

  return out;
}

// LR_QUOTE_BLOCKQUOTE_V1_START
function lrQuoteTypeOf(mark) {
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
    mark?.message_style ||
    mark?.messageStyle ||
    mark?.payload?.type ||
    mark?.payload?.kind ||
    ''
  ).toLowerCase();
}

function lrQuoteIsQuoteType(type) {
  const t = String(type || '').toLowerCase();
  return (
    t.includes('quote') ||
    t.includes('blockquote') ||
    t.includes('block_quote') ||
    t.includes('block-quote') ||
    t.includes('quotation') ||
    t.includes('quoted') ||
    t.includes('cite') ||
    t.includes('citation')
  );
}

function lrQuoteKind(type) {
  const t = String(type || '').toLowerCase();

  if (lrQuoteIsQuoteType(t)) return 'quote';
  if (t.includes('heading') || t.includes('header') || t.includes('title') || /^h[1-6]$/.test(t)) return 'heading';
  if (t.includes('bold') || t.includes('strong') || t === 'b') return 'bold';
  if (t.includes('italic') || t.includes('emphas') || t === 'em' || t === 'i') return 'italic';
  if (t.includes('underline') || t === 'u' || t === 'ins') return 'underline';
  if (t.includes('strike') || t.includes('through') || t.includes('delete') || t === 's' || t === 'del') return 'strike';
  if (t.includes('mono') || t.includes('code') || t.includes('pre') || t === 'tt') return 'code';
  if (t.includes('mark') || t.includes('highlight')) return 'mark';
  if (t.includes('link') || t.includes('url') || t === 'a') return 'link';

  return '';
}

function lrQuoteStart(mark, max) {
  const raw = mark?.from ?? mark?.start ?? mark?.offset ?? mark?.position ?? mark?.index ?? mark?.begin ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
}

function lrQuoteEnd(mark, start, max) {
  const direct = mark?.to ?? mark?.end ?? mark?.stop;
  if (direct !== undefined && direct !== null && direct !== '') {
    const n = Number(direct);
    if (Number.isFinite(n) && n > start) return Math.max(start, Math.min(max, n));
  }

  const len = mark?.length ?? mark?.len ?? mark?.size ?? mark?.count;
  const n = Number(len);
  if (Number.isFinite(n) && n > 0) return Math.max(start, Math.min(max, start + n));

  return start;
}

function lrQuoteUrl(mark) {
  return String(
    mark?.url ||
    mark?.href ||
    mark?.link ||
    mark?.payload?.url ||
    mark?.payload?.href ||
    mark?.payload?.link ||
    ''
  ).trim();
}

function lrQuoteHasRange(mark) {
  return (
    mark &&
    typeof mark === 'object' &&
    (
      mark.from !== undefined ||
      mark.start !== undefined ||
      mark.offset !== undefined ||
      mark.position !== undefined ||
      mark.index !== undefined ||
      mark.begin !== undefined
    ) &&
    (
      mark.length !== undefined ||
      mark.len !== undefined ||
      mark.size !== undefined ||
      mark.count !== undefined ||
      mark.to !== undefined ||
      mark.end !== undefined ||
      mark.stop !== undefined
    )
  );
}

function lrQuoteFindMessageText(root) {
  const candidates = [
    root?.message?.body?.text,
    root?.message?.text,
    root?.body?.text,
    root?.text,
    root?.message?.link?.message?.body?.text,
    root?.message?.link?.message?.text,
    root?.link?.message?.body?.text,
    root?.link?.message?.text,
  ];

  for (const value of candidates) {
    const text = String(value || '');
    if (text.trim()) return text;
  }

  return '';
}

function lrQuoteMergeMarkup(base = [], extra = []) {
  const out = [];
  const seen = new Set();

  for (const item of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
    if (!item || typeof item !== 'object') continue;

    const type = lrQuoteTypeOf(item);
    const kind = lrQuoteKind(type);
    if (!kind) continue;

    const from = item.from ?? item.start ?? item.offset ?? item.position ?? item.index ?? item.begin ?? 0;
    const len = item.length ?? item.len ?? item.size ?? item.count ?? '';
    const to = item.to ?? item.end ?? item.stop ?? '';
    const url = lrQuoteUrl(item);

    if (kind === 'link' && !url) continue;

    const key = [kind, type, from, len, to, url].join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(item);
  }

  return out;
}

function lrQuoteCollectNativeMarkupDeep(root, sourceText = '') {
  const text = String(sourceText || lrQuoteFindMessageText(root) || '');
  const max = text.length;
  const out = [];
  const seenObjects = new WeakSet();
  const seenRanges = new Set();

  function addRange(mark, typeHint = '') {
    if (!mark || typeof mark !== 'object') return;

    const type = lrQuoteTypeOf(mark) || String(typeHint || '').toLowerCase();
    const kind = lrQuoteKind(type);
    if (!kind) return;

    let start = lrQuoteStart(mark, max);
    let end = lrQuoteEnd(mark, start, max);

    // Иногда MAX отдаёт цитату как блок с text, но без диапазона.
    // Тогда ищем этот текст в общем тексте и создаём диапазон сами.
    if ((!lrQuoteHasRange(mark) || end <= start) && lrQuoteIsQuoteType(type)) {
      const blockText = String(
        mark?.text ||
        mark?.body?.text ||
        mark?.payload?.text ||
        mark?.caption ||
        ''
      ).trim();

      if (blockText && text.includes(blockText)) {
        start = text.indexOf(blockText);
        end = start + blockText.length;
      }
    }

    if (end <= start || start >= max) return;

    const url = lrQuoteUrl(mark);
    if (kind === 'link' && !url) return;

    const key = [kind, start, end, url].join('|');
    if (seenRanges.has(key)) return;
    seenRanges.add(key);

    out.push({
      ...mark,
      type: type || kind,
      from: start,
      length: end - start,
      ...(url ? { url } : {}),
    });
  }

  function walk(value, keyHint = '') {
    if (!value || typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, keyHint);
      return;
    }

    addRange(value, keyHint);

    for (const [key, child] of Object.entries(value)) {
      // Встречаются разные контейнеры: markup, markups, entities, richText, blocks.
      // Поэтому идём вглубь, но key передаём как подсказку для объектов без поля type.
      walk(child, key);
    }
  }

  walk(root, '');

  if (out.some((x) => lrQuoteKind(lrQuoteTypeOf(x)) === 'quote')) {
    console.log('[quote markup] found', JSON.stringify(out.map((x) => ({
      type: lrQuoteTypeOf(x),
      from: x.from,
      length: x.length,
      text: text.slice(Number(x.from || 0), Number(x.from || 0) + Number(x.length || 0)).slice(0, 80),
    })).slice(0, 20)));
  }

  return out;
}
// LR_QUOTE_BLOCKQUOTE_V1_END

function lrMaxMarkupToHtml(text, markup = []) {
  return applyMarkupToHtml(text, markup);
}

function lrMaxMarkupToMarkdown(text, markup = []) {
  return applyMarkupToHtml(text, markup);
}

// LR_NATIVE_MAX_MARKUP_V4_END

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

function hasContent(d) {
  return Boolean(
    String(d?.content?.text || '').trim() ||
    (Array.isArray(d?.content?.attachments) && d.content.attachments.length) ||
    d?.content?.link
  );
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

async function composePostForChannelUnsafe(draft, channelId) {
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
        ? globalThis.__lrRichV7?.signatureForPost(sig.text, ((typeof format !== 'undefined' && format) || (typeof content !== 'undefined' && content?.format) || (typeof draft !== 'undefined' && draft?.content?.format) || 'html'))
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

async function composePostForChannel(draft, channelId) {
  try {
    return await composePostForChannelUnsafe(draft, channelId);
  } catch (e) {
    const message = String(e?.message || e || '');
    console.error('[composePostForChannel safe fallback]', message);

    const content = lrSafePreviewContent(draft);
    return {
      text: content.text,
      format: content.format || 'html',
      attachments: content.attachments,
      link: content.link || null
    };
  }
}

function makeDraftFromPost(row) { return { ...emptyDraft(), channelIds: [Number(row.channel_id)], content: { text: row.text || '', format: row.format || 'html', attachments: safeJson(row.attachments, []), markup: [], raw: null }, buttons: safeJson(row.buttons, []), isAd: Boolean(row.is_ad), cpm: row.cpm ? Number(row.cpm) : null, autoDeleteMinutes: row.auto_delete_minutes || null, reportAfterHours: row.report_after_hours || 24, signatureEnabled: !row.is_ad, postId: Number(row.id), publishedMessageId: row.published_message_id || null, status: row.status || 'scheduled' }; }

function mainMenuRows() {
  return [
    [callbackButton(' LinkRay Studio', 'main:posting')],
    [callbackButton('📊 Аналитика', 'main:analytics')],
    [callbackButton(' Добавить канал', 'post:add_channel')],
    [callbackButton(' Отчёты', 'reports:menu'), callbackButton(' Антифрод', 'fraud:menu')],
  ];
}
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
    [callbackButton('🔘 Добавить кнопку', 'editor:button'), callbackButton(draft.isAd ? '🔒 Автоподпись выкл' : '🏷 Автоподпись', 'editor:signature')],
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
  await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });

  try {
    await cb(callbackId, editorMenuText(), editorMenuRows(draft));
  } catch (error) {
    console.error('[editor menu callback failed]', error.message || error);
    if (Number(key)) {
      await msg(Number(key), editorMenuText(), editorMenuRows(draft));
    }
  }

  if (hasContent(draft) && Number(key)) {
    setTimeout(async () => {
      try {
        const latest = await getSession(key);
        const latestDraft = safeDraft(latest.data);
        const targetDraft = hasContent(latestDraft) ? latestDraft : draft;

        const mid = await sendDraftPreview(Number(key), targetDraft);
        if (mid) {
          targetDraft.previewMessageId = mid;
          await setSession(key, targetDraft.postId ? 'edit_existing' : 'edit_draft', { draft: targetDraft });
        }
      } catch (error) {
        console.error('[preview background failed]', error.message || error);
      }
    }, 0);
  }
}

function lrSafePreviewContent(draft) {
  const content = draft?.content || {};

  let attachments = Array.isArray(content.attachments)
    ? content.attachments.filter(Boolean)
    : [];

  try {
    if (Array.isArray(draft?.buttons) && draft.buttons.length) {
      const kb = buttonRows(draft.buttons);
      if (Array.isArray(kb)) attachments = attachments.concat(kb);
      else if (kb) attachments.push(kb);
    }
  } catch (e) {
    console.error('[safe preview buttons]', e.message || e);
  }

  return {
    text: String(content.text || ''),
    format: content.format || 'html',
    attachments,
    link: content.link || null
  };
}

async function lrSendSafePreview(chatId, draft) {
  const content = lrSafePreviewContent(draft);

  if (!String(content.text || '').trim() && !content.attachments.length && !content.link) {
    return null;
  }

  const target = typeof lrBuildSendTarget === 'function'
    ? lrBuildSendTarget(chatId)
    : { chatId };

  const sent = await sendMaxMessage({
    ...target,
    text: content.text,
    format: content.format || 'html',
    attachments: content.attachments,
    link: content.link || null
  });

  if (typeof extractMessageId === 'function') {
    return extractMessageId(sent);
  }

  return sent?.message?.body?.mid || sent?.message?.id || sent?.message_id || sent?.messageId || sent?.id || sent?.mid || null;
}

async function sendDraftPreviewUnsafe(chatId, draft) {
  try {
    const content = await composePostForChannel(draft, draft.channelIds[0]);
    if (draft.previewMessageId) {
      try { await editMaxMessage(draft.previewMessageId, content); return draft.previewMessageId; }
      catch (editError) { console.error('[preview edit failed, sending new]', editError.message || editError); }
    }
    const sent = await sendMaxMessage({ ...lrBuildSendTarget(chatId), ...content });
    return extractMessageId(sent);
  } catch (e) {
    console.error('[preview]', e.message || e);
    await msg(chatId, `⚠️ Не удалось вывести превью полностью: ${escapeHtml(e.message || e)}\n\n${escapeHtml(short(draft.content.text, 900))}`, [], 'html');
    return null;
  }
}

async function sendDraftPreview(chatId, draft) {
  try {
    return await sendDraftPreviewUnsafe(chatId, draft);
  } catch (e) {
    const message = String(e?.message || e || '');
    console.error('[sendDraftPreview safe fallback]', message);

    return lrSendSafePreview(chatId, draft);
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
    [callbackButton('📅 Календарь', 'schedule:calendar')],
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
  const channels = await getChannelsByIds(draft.channelIds);

  for (const channel of channels) {
    let content = null;
    let sent = null;
    let messageId = null;
    let dbPostId = null;

    try {
      content = await composePostForChannel(draft, channel.id);

      sent = await sendMaxMessage({
        chatId: channel.max_chat_id,
        ...content
      });

      messageId = extractMessageId(sent);

      // Важно: если дошли сюда — MAX уже принял/отправил пост.
      // Ошибка ниже в БД больше не должна превращать публикацию в "0/1".
    } catch (e) {
      console.error('[publish now send failed]', e?.message || e);
      results.push({
        ok: false,
        channel,
        error: e?.message || String(e)
      });
      continue;
    }

    try {
      const r = await query(
        `INSERT INTO scheduled_posts(
          channel_id,
          text,
          format,
          publish_at,
          status,
          notify,
          created_by_max_user_id,
          attachments,
          buttons,
          draft,
          is_ad,
          cpm,
          auto_delete_minutes,
          report_after_hours,
          report_group_id,
          published_at,
          published_message_id,
          updated_at
        )
        VALUES(
          $1,$2,$3,now(),'published',false,$4,
          $5::jsonb,$6::jsonb,$7::jsonb,
          $8,$9,$10,$11,$12,
          now(),$13,now()
        )
        RETURNING id`,
        [
          channel.id,
          content.text,
          content.format,
          String(key),
          JSON.stringify(normalizeAttachments(draft.content?.attachments || [])),
          JSON.stringify(draft.buttons || []),
          JSON.stringify(draft),
          Boolean(draft.isAd),
          draft.cpm,
          draft.autoDeleteMinutes,
          draft.reportAfterHours || 24,
          draft.campaignId,
          messageId
        ]
      );

      dbPostId = r?.[0]?.id || null;
    } catch (dbError) {
      console.error('[publish now db after sent]', dbError?.message || dbError);
      // Пост уже вышел, поэтому пользователю не показываем ошибку MAX API.
    }

    results.push({
      ok: true,
      channel,
      id: dbPostId,
      messageId
    });
  }

  return results;
}

/* LR_INPLACE_AFTER_PLANNED_HELPER_V1_START */
async function lrInplaceAfterPlannedHelperV1(callbackId, chatId, draft, publishAt, ids) {
  const channels = await getChannelsByIds(draft.channelIds || []);
  const d = parseDbDate(publishAt);

  const text = draft.isAd
    ? `━━━━━━━━━━━━━━
✅ <b>Рекламный пост запланирован</b>

🕒 ${dateText(d)} ${timeText(d)} МСК

📡 Каналы:
${channelsLines(channels)}

CPM: ${draft.cpm || 'не указан'} ₽
Автоудаление: ${formatAutoDelete(draft.autoDeleteMinutes)}

Пост добавлен в очередь.
━━━━━━━━━━━━━━`
    : `━━━━━━━━━━━━━━
✅ <b>Публикация запланирована</b>

🕒 ${dateText(d)} ${timeText(d)} МСК

📡 Каналы:
${channelsLines(channels)}

Автоудаление: ${formatAutoDelete(draft.autoDeleteMinutes)}

Пост добавлен в очередь.
━━━━━━━━━━━━━━`;

  const rows = [
    [callbackButton('📂 Посты', 'post:all')],
    [callbackButton('🧬 LinkRay Studio', 'main:posting')]
  ];

  if (callbackId) {
    return cb(callbackId, text, rows);
  }

  return msg(chatId, text, rows);
}
/* LR_INPLACE_AFTER_PLANNED_HELPER_V1_END */

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

async function afterPublished(chatId, draft, results, callbackId = null) {
  const list = Array.isArray(results) ? results : [];
  const ok = list.filter(r => r && r.ok);
  const fail = list.filter(r => r && !r.ok);

  let channels = ok.map(r => r.channel).filter(Boolean);

  if (!channels.length) {
    channels = list.map(r => r && r.channel).filter(Boolean);
  }

  if (!channels.length && draft?.channelIds?.length) {
    channels = await getChannelsByIds(draft.channelIds);
  }

  const channelTitle = channels.length > 1 ? 'Каналы' : 'Канал';
  const channelList = channels.length ? channelsLines(channels) : '—';

  let text;

  if (draft.isAd) {
    text =
`━━━━━━━━━━━━━━
✅ Рекламный пост опубликован

${channelTitle}:
${channelList}

CPM: ${draft.cpm || 'не указан'} ₽
Автоудаление: ${formatAutoDelete(draft.autoDeleteMinutes)}
Отчёт придёт через 24ч
Страница отчёта: <a href="${reportUrl(draft.campaignId)}">LinkRay Analytics</a>
━━━━━━━━━━━━━━`;
  } else {
    text =
`━━━━━━━━━━━━━━
✅ Пост опубликован.

${channelTitle}:
${channelList}
━━━━━━━━━━━━━━`;
  }

  if (!ok.length && fail.length) {
    text += `

⚠️ MAX API не подтвердил публикацию. Проверь пост в канале.`;
  }

  const rows = draft.isAd
    ? [
        [callbackButton('📊 Открыть отчёт', `report:open:${draft.campaignId}`)],
        [callbackButton('🗂 Посты', 'post:all')],
        [callbackButton('🏠 В меню', 'main:menu')]
      ]
    : [
        [callbackButton('🗂 Посты', 'post:all')],
        [callbackButton('🏠 В меню', 'main:menu')]
      ];

  if (callbackId) {
    return cb(callbackId, text, rows);
  }

  return msg(chatId, text, rows);
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
function postPreviewDraft(p) { return { ...emptyDraft(), channelIds: [p.channel_id], content: { text: p.text || '', format: p.format || 'html', attachments: safeJson(p.attachments, []), markup: [] }, buttons: safeJson(p.buttons, []), isAd: Boolean(p.is_ad), cpm: p.cpm ? Number(p.cpm) : null, autoDeleteMinutes: p.auto_delete_minutes, reportAfterHours: p.report_after_hours || 24, signatureEnabled: true }; }
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

async function openPost(callbackId, chatId, id) { const p = await getPost(id); if (!p) { await cb(callbackId, 'Пост не найден.', [[callbackButton('⬅️ К постам','post:all')]]); return; } await answerCallback({ callbackId, notification: 'Открываю пост...' }).catch(()=>{}); try { const d = postPreviewDraft(p); await sendMaxMessage({ ...lrBuildSendTarget(chatId), text: p.text || '', format: p.format || 'html', attachments: finalAttachments(d) }); await msg(chatId, postMenuText(p), postMenuRows(p)); } catch (e) { console.error('[open post]', e.message || e); await cb(callbackId, `${postMenuText(p)}\n\n⚠️ Пост не удалось вывести отдельно: ${escapeHtml(e.message || e)}`, postMenuRows(p)); } }
async function editExisting(callbackId, key, id) { const p = await getPost(id); if (!p) return cb(callbackId, 'Пост не найден.', [[callbackButton('⬅️ К постам','post:all')]]); if (olderThan24(p)) return cb(callbackId, '🔒 Редактирование недоступно: прошло больше 24 часов.', [[callbackButton('⬅️ Назад', `post:open:${id}`)]]); const draft = makeDraftFromPost(p); await showEditor(callbackId, key, draft); }

async function saveExisting(callbackId, key, draft) {
  const chatId = Number(key || 0);

  function lrSaveExistingJson(value, fallback) {
    try {
      if (value === undefined || value === null) return JSON.stringify(fallback);
      return JSON.stringify(value);
    } catch {
      return JSON.stringify(fallback);
    }
  }

  function lrSaveExistingAttachments(draft) {
    let src = Array.isArray(draft?.content?.attachments) ? draft.content.attachments : [];

    try {
      if (typeof normalizeAttachments === 'function') {
        src = normalizeAttachments(src);
      }
    } catch (e) {
      console.error('[saveExisting normalizeAttachments]', e?.message || e);
    }

    const out = [];

    for (const item of Array.isArray(src) ? src : []) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

      const type = String(
        item.type ||
        item.kind ||
        item.attachment_type ||
        item.attachmentType ||
        ''
      ).toLowerCase();

      if (type.includes('inline_keyboard')) continue;
      if (type.includes('keyboard')) continue;
      if (type.includes('button')) continue;
      if (type.includes('link_preview')) continue;
      if (type.includes('web_page')) continue;

      out.push(item);
    }

    return out;
  }

  function lrStudioSavedText(extra = '') {
    return `━━━━━━━━━━━━━━
✅ Пост сохранён.${extra ? '\n\n' + extra : ''}

🧬 <b>LinkRay Studio</b>

Собирайте посты, планируйте публикации и управляйте рекламными размещениями.
━━━━━━━━━━━━━━`;
  }

  try {
    if (!draft || !draft.postId) {
      return cb(callbackId, `━━━━━━━━━━━━━━
⚠️ Пост не найден в редакторе.
━━━━━━━━━━━━━━`, studioRows());
    }

    const post = await getPost(draft.postId);

    if (!post) {
      return cb(callbackId, `━━━━━━━━━━━━━━
⚠️ Пост не найден.
━━━━━━━━━━━━━━`, studioRows());
    }

    draft.previewMessageId = null;

    if (!draft.content) draft.content = {};
    if (!Array.isArray(draft.content.attachments)) draft.content.attachments = [];
    if (!Array.isArray(draft.buttons)) draft.buttons = [];

    const channelId = Number(draft.channelIds?.[0] || post.channel_id || 0);

    let content;

    try {
      content = await composePostForChannel(draft, channelId);
    } catch (composeError) {
      console.error('[saveExisting compose failed]', composeError?.message || composeError);

      const fallbackAttachments =
        typeof finalAttachments === 'function'
          ? finalAttachments(draft)
          : lrSaveExistingAttachments(draft);

      content = {
        text: draft.content?.text || post.text || '',
        format: draft.content?.format || post.format || 'html',
        attachments: fallbackAttachments,
        markup: []
      };
    }

    await query(
      `UPDATE scheduled_posts
       SET text=$2,
           format=$3,
           attachments=$4::jsonb,
           buttons=$5::jsonb,
           draft=$6::jsonb,
           is_ad=$7,
           cpm=$8,
           auto_delete_minutes=$9,
           report_after_hours=$10,
           updated_at=now()
       WHERE id=$1`,
      [
        draft.postId,
        content.text || '',
        content.format || 'html',
        lrSaveExistingJson(lrSaveExistingAttachments(draft), []),
        lrSaveExistingJson(draft.buttons || [], []),
        lrSaveExistingJson({ ...draft, previewMessageId: null }, {}),
        Boolean(draft.isAd),
        draft.cpm || null,
        draft.autoDeleteMinutes || null,
        draft.reportAfterHours || 24
      ]
    );

    let warning = '';

    if (post.status === 'published' && post.published_message_id) {
      try {
        await editMaxMessage(post.published_message_id, content);
      } catch (editError) {
        warning =
          `⚠️ В базе сохранено, но MAX не обновил сообщение в канале:\n` +
          `${escapeHtml(editError?.message || editError)}`;

        console.error('[saveExisting edit published failed]', editError?.message || editError);
      }
    }

    try {
      if (typeof clearSession === 'function') {
        await clearSession(key);
      }
    } catch (clearError) {
      console.error('[saveExisting clearSession failed]', clearError?.message || clearError);
    }

    if (callbackId) {
      return cb(callbackId, lrStudioSavedText(warning), studioRows());
    }

    if (chatId) {
      return msg(chatId, lrStudioSavedText(warning), studioRows());
    }

    return null;
  } catch (e) {
    console.error('[saveExisting to studio error]', e?.stack || e);

    return cb(
      callbackId,
      `━━━━━━━━━━━━━━
⚠️ Не удалось сохранить пост:
${escapeHtml(e?.message || e)}
━━━━━━━━━━━━━━`,
      [
        [callbackButton('⬅️ В редактор', 'editor:back')],
        [callbackButton('🧬 В Studio', 'main:posting')]
      ]
    );
  }
}

async function handleCallback(update) {
  __lrStartChannelDbSyncTimer();
  __lrStartChannelDbSyncTimer();
  if (await __lrShouldIgnoreInboundChannelUpdate(update)) return;
  const callbackId = getCallbackId(update); const payload = getCallbackPayload(update); const key = getSessionKey(update); const chatId = lrResolveReplyChatId(update, key);
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
  if (payload === 'editor:ad') {
      const s = await getSession(key);
      const draft = safeDraft(s.data);

      draft.isAd = !draft.isAd;
      draft.is_ad = draft.isAd;

      if (draft.isAd) {
        draft.signatureEnabled = false;
        draft.signature = null;
        draft.signatureText = '';
        draft.reportAfterHours = 24;
        if (!draft.autoDeleteMinutes) draft.autoDeleteMinutes = 2880;
      }

      await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft });

      if (callbackId) {
        try {
          await answerCallback({
            callbackId,
            notification: draft.isAd
              ? 'Рекламный пост включён. Автоподпись отключена.'
              : 'Рекламный режим выключен.'
          });
        } catch {}
      }

      if (chatId && typeof sendStudioEditorMessage === 'function') {
        return sendStudioEditorMessage(chatId, draft);
      }

      return showEditor(callbackId, key, draft);
    }
  if (payload === 'editor:cpm') {
      const s = await getSession(key);
      const draft = safeDraft(s.data);

      draft.isAd = true;
      draft.is_ad = true;
      draft.signatureEnabled = false;
      draft.signature = null;
      draft.signatureText = '';
      draft.reportAfterHours = 24;
      if (!draft.autoDeleteMinutes) draft.autoDeleteMinutes = 2880;

      await setSession(key, 'wait_cpm', { draft });

      return cb(callbackId, '💰 Введите цену за 1000 просмотров.', [[callbackButton('⬅️ Назад','editor:back')]]);
    }
  if (payload === 'editor:back') { const s = await getSession(key); return showEditor(callbackId, key, safeDraft(s.data)); }
  if (payload === 'editor:next') { const s = await getSession(key); return showPublishMenu(callbackId, key, safeDraft(s.data)); }
  if (payload === 'editor:save') { const s = await getSession(key); return saveExisting(callbackId, key, safeDraft(s.data)); }
  if (payload === 'publish:auto_delete') { const s = await getSession(key); return showPublishMenu(callbackId, key, safeDraft(s.data)); }
  if (payload.startsWith('publish:auto_set:')) { const session = await getSession(key); const draft = safeDraft(session.data); const v = Number(payload.split(':')[2] || 0) || null; draft.autoDeleteMinutes = v; await setSession(key, 'publish_menu', { draft }); return showPublishMenu(callbackId, key, draft); }
  if (payload === 'schedule:manual') { const s = await getSession(key); await setSession(key, 'wait_schedule_time', s.data); return cb(callbackId, '🕒 Введите время: 18:30, 0235, завтра 18:30, через 1 минуту или 2026-06-23 18:30.', [[callbackButton('⬅️ Назад','editor:next')]]); }
  if (payload === 'schedule:calendar') return showScheduleCalendar(callbackId, key, dateKey(new Date()));
  if (payload.startsWith('schedule:week:')) return showScheduleCalendar(callbackId, key, payload.split(':')[2]);
  if (payload.startsWith('schedule:day:')) return showScheduleTimes(callbackId, key, payload.split(':')[2]);
  
  if (payload.startsWith('lr_cal:pick:')) {
    const [, , dayKey, hhmm] = payload.split(':');
    const clean = String(hhmm || '').replace(/[^0-9]/g, '').padStart(4, '0').slice(0, 4);
    const niceTime = clean.slice(0, 2) + ':' + clean.slice(2, 4);

    const dt = dateTimeFromDayTime(dayKey, clean);
    if (dt.getTime() > Date.now() && chatId) {
      await sendMaxMessage({
        chatId,
        text: '✅ Время выбрано: <b>' + escapeHtml(niceTime) + '</b>',
        format: 'html'
      }).catch(() => {});
    }

    return scheduleFromCallbackTime(callbackId, chatId, key, dayKey, clean);
  }
  if (payload.startsWith('schedule:time:')) { const [, , dayKey, hhmm] = payload.split(':'); return scheduleFromCallbackTime(callbackId, chatId, key, dayKey, hhmm); }
  if (payload.startsWith('schedule:manual_day:')) { const dayKey = payload.split(':')[2]; const s = await getSession(key); await setSession(key, 'wait_schedule_time', s.data); return cb(callbackId, `🕒 Введите время для ${dateText(keyToDate(dayKey))}: ${dayKey} 18:30`, [[callbackButton('⬅️ К календарю', `schedule:week:${dayKey}`)]]); }
  if (payload === 'publish:now') { const s = await getSession(key); const draft = safeDraft(s.data); const results = await publishDraftNow(draft, key); await clearSession(key); await answerCallback({ callbackId, notification: 'Публикация выполнена.' }).catch(()=>{}); return afterPublished(chatId, draft, results, callbackId); }
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
  if (payload.startsWith('post:now:')) { const p = await getPost(Number(payload.split(':')[2])); if (!p) return cb(callbackId, 'Пост не найден.', [[callbackButton('🗂 Посты','post:all')]]); const draft = makeDraftFromPost(p); const results = await publishDraftNow(draft, key); await query(`UPDATE scheduled_posts SET status='canceled', updated_at=now() WHERE id=$1`, [p.id]); await answerCallback({ callbackId, notification: 'Отправлено на публикацию.' }).catch(()=>{}); return afterPublished(chatId, draft, results, callbackId); }
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
  const looksChannel = __lrLooksLikeChannelUpdate(update);

  // Важно: пересланный пост может содержать внутри себя channel/chat,
  // но сам апдейт пришёл в личку. Поэтому без явного channel-типа не игнорируем.
  if (!looksChannel) return false;
  if (!chatId) return false;

  const knownChannel = await __lrIsKnownChannelChat(chatId);

  if (knownChannel || looksChannel) {
    console.log('[channel guard] ignored real channel update', JSON.stringify({
      type: update?.type || update?.update_type || '',
      chatId: String(chatId),
      knownChannel,
      looksChannel
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

function lrFindForwardBodyMessage(update) {
  return (
    update?.message?.link?.message ||
    update?.message?.body?.link?.message ||
    update?.body?.link?.message ||
    update?.link?.message ||
    update?.message?.forward?.message ||
    update?.message?.body?.forward?.message ||
    update?.message ||
    update
  );
}

function lrFallbackContentFromUpdate(update) {
  const m = lrFindForwardBodyMessage(update) || {};
  const body = m.body || {};

  const rawText = String(
    m.text ??
    body.text ??
    m.caption ??
    body.caption ??
    ''
  );

  const markup = Array.isArray(m.markup)
    ? m.markup
    : Array.isArray(body.markup)
      ? body.markup
      : [];

  let text = rawText;

  try {
    if (typeof lrMaxMarkupToMarkdown === 'function') {
      text = lrBuildMaxHtmlV2(rawText, markup);
    }
  } catch (error) {
    console.error('[fallback markup ignored]', error.message || error);
    text = rawText;
  }

  const rawAttachments = Array.isArray(m.attachments)
    ? m.attachments
    : Array.isArray(body.attachments)
      ? body.attachments
      : [];

  let attachments = rawAttachments.filter(Boolean);

  try {
    if (typeof normalizeAttachments === 'function') {
      attachments = normalizeAttachments(attachments);
    }
  } catch (error) {
    console.error('[fallback attachments normalize ignored]', error.message || error);
  }

  return {
    text,
    format: 'html',
    attachments,
    markup,
    raw: m
  };
}

async function lrSafeHydrateContent(update) {
  try {
    const hydrated = await hydrateContent(update);

    if (
      hydrated &&
      (
        String(hydrated.text || '').trim() ||
        (Array.isArray(hydrated.attachments) && hydrated.attachments.length) ||
        hydrated.link
      )
    ) {
      return hydrated;
    }

    console.error('[safe hydrate] empty result, using fallback');
  } catch (error) {
    console.error('[safe hydrate] hydrateContent failed:', error?.stack || error?.message || error);

    try {
      await writeFile(
        '/tmp/linkray_hydrate_error.json',
        JSON.stringify({
          error: String(error?.stack || error?.message || error),
          update
        }, null, 2)
      ).catch(() => {});
    } catch {}
  }

  return lrFallbackContentFromUpdate(update);
}

async function handleMessage(update) {
  __lrStartChannelDbSyncTimer();
  __lrStartChannelDbSyncTimer();
  if (await __lrShouldIgnoreInboundChannelUpdate(update)) return;
  const chatId = lrResolveReplyChatId(update, getSessionKey(update));
  await __lrRememberPrivateChatId(chatId);
  await __lrNotifyNewChannels(chatId);

  await __lrRememberPrivateChatId(chatId);
  await __lrNotifyNewChannels(chatId);
 const key = getSessionKey(update); const text = getMessageText(update); const n = norm(text); log('message', { chatId, key, text: text.slice(0,80) });
  await writeFile('/tmp/linkray_last_update.json', JSON.stringify(update, null, 2)).catch(()=>{});
  if (['/start','start','/menu','меню','начать'].includes(n) || String(getUpdateType(update) || '').toLowerCase().includes('bot_started')) { await clearSession(key); return sendMain(chatId); }
  const session = await getSession(key); const draft = safeDraft(session.data);
  if (session.state === 'wait_post_content') { const content = await lrSafeHydrateContent(update); draft.content = { ...draft.content, ...content }; lrApplyEditorPostFormat(draft, content); draft.previewMessageId = null; const mid = await sendDraftPreview(chatId, draft); if (mid) draft.previewMessageId = mid; await setSession(key, 'edit_draft', { draft }); return msg(chatId, editorMenuText(), editorMenuRows(draft)); }
  if (session.state === 'wait_edit_text') { const content = await lrSafeHydrateContent(update); draft.content.text = content.text || text; lrApplyEditorPostFormat(draft, content); draft.previewMessageId = null; await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft }); return sendEditorAsNew(chatId, key, draft); }
  if (session.state === 'wait_edit_media') { const content = await lrSafeHydrateContent(update); if (content.attachments.length) draft.content.attachments = content.attachments; if (content.text) draft.content.text = content.text; lrApplyEditorPostFormat(draft, content); draft.previewMessageId = null; await setSession(key, draft.postId ? 'edit_existing' : 'edit_draft', { draft }); return sendEditorAsNew(chatId, key, draft); }
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

  if (session.state === 'wait_cpm') {
    return lrCpmPreviewFinalV4(chatId, key, text, session);
  } if (session.state === 'wait_auto_delete') { const v = parseDuration(text); if (v === undefined) return msg(chatId, 'Не понял срок. Введите число от 1 до 72 часов или 0.'); draft.autoDeleteMinutes = v; await setSession(key, 'publish_menu', { draft }); return msg(chatId, `✅ Автоудаление: ${formatAutoDelete(v)}`, [[callbackButton('➡️ К выпуску','editor:next')]]); }
  if (session.state === 'wait_schedule_time') { const publishAt = parseSchedule(text); if (!publishAt) return msg(chatId, 'Не понял время. Пример: 18:30, 0235, завтра 18:30, через 1 минуту.'); const ids = await scheduleDraft(draft, key, publishAt); await clearSession(key); return afterPlanned(chatId, draft, publishAt, ids); }
  if (session.state === 'wait_post_auto_delete') { const v = parseDuration(text); if (v === undefined) return msg(chatId, 'Не понял срок. Введите число от 1 до 72 часов или 0.'); await query('UPDATE scheduled_posts SET auto_delete_minutes=$2, updated_at=now() WHERE id=$1', [session.data.postId, v]); await clearSession(key); return msg(chatId, `✅ Автоудаление: ${formatAutoDelete(v)}`, [[callbackButton('👁 Открыть пост', `post:open:${session.data.postId}`)]]); }
  if (session.state === 'wait_post_time') { const publishAt = parseSchedule(text); if (!publishAt) return msg(chatId, 'Не понял время.'); await query(`UPDATE scheduled_posts SET publish_at=$2, updated_at=now() WHERE id=$1`, [session.data.postId, publishAt]); await clearSession(key); return msg(chatId, '✅ Время обновлено.', [[callbackButton('👁 Открыть пост', `post:open:${session.data.postId}`)]]); }
  const content = await lrSafeHydrateContent(update); if (String(content.text || '').trim() || (Array.isArray(content.attachments) && content.attachments.length) || content.link) { const d = emptyDraft(); d.content = { ...d.content, ...content }; await setSession(key, 'select_channels', { draft: d }); const channels = await getChannels(); const rs = channels.map(c => [callbackButton(`📡 ${channelName(c)}`, `post:single:${c.id}`)]); rs.push([callbackButton('🌐 Все каналы','post:all_channels')],[callbackButton('❌ Отмена','post:cancel')]); return msg(chatId, '📡 Пост принят. Теперь выберите канал для публикации.', rs); }
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

// LINKRAY_CHANNEL_ANALYTICS_START
import('./linkrayChannelAnalytics.js')
  .then((mod) => {
    if (typeof mod.mountLinkRayChannelAnalytics === 'function') {
      mod.mountLinkRayChannelAnalytics(app);
    }
  })
  .catch((error) => console.error('[LinkRay channel analytics mount]', error?.stack || error));
// LINKRAY_CHANNEL_ANALYTICS_END

app.post('/webhook', async (req, res) => {
  const incomingSecret = req.header('X-Max-Bot-Api-Secret');
  if (process.env.WEBHOOK_SECRET && incomingSecret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ ok: false });
  res.json({ ok: true });
  try {
    const update = req.body || {}; const type = getUpdateType(update); log('webhook', { type, chatId: getChatId(update), key: getSessionKey(update) }); await maybeRegisterChannel(update);
    if (type.includes('callback') || getCallbackId(update)) await handleCallback(update); else await handleMessage(update);
  } catch(e) { console.error('[webhook] processing error:', e); }
});

// LR_APPEND_HEADING_QUOTE_SAFE_V2_START
function lrHq2EscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrHq2Attr(value) {
  return lrHq2EscapeHtml(value).replace(/"/g, '&quot;');
}

function lrHq2Plain(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function lrHq2RawType(mark, hint) {
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
    hint ||
    ''
  ).toLowerCase();
}

function lrHq2Kind(mark, hint) {
  const t = lrHq2RawType(mark, hint);

  if (t.includes('heading') || t.includes('header') || t.includes('title') || /^h[1-6]$/.test(t)) return 'heading';
  if (t.includes('quote') || t.includes('blockquote') || t.includes('quotation') || t.includes('quoted') || t.includes('citation') || t.includes('cite')) return 'quote';

  if (t.includes('strong') || t.includes('bold') || t === 'b') return 'bold';
  if (t.includes('emphas') || t.includes('italic') || t === 'i' || t === 'em') return 'italic';
  if (t.includes('underline') || t === 'u' || t === 'ins') return 'underline';
  if (t.includes('strike') || t.includes('through') || t.includes('deleted') || t === 's' || t === 'del') return 'strike';
  if (t.includes('mono') || t.includes('code') || t === 'pre') return 'mono';
  if (t.includes('mark') || t.includes('highlight') || t.includes('important')) return 'mark';
  if (t.includes('link') || t.includes('url') || t === 'a') return 'link';

  return '';
}

function lrHq2Url(mark) {
  return String(
    mark?.url ||
    mark?.href ||
    mark?.link ||
    mark?.payload?.url ||
    mark?.payload?.href ||
    mark?.payload?.link ||
    mark?.button?.url ||
    ''
  ).trim();
}

function lrHq2Start(mark, max) {
  const raw = mark?.from ?? mark?.start ?? mark?.offset ?? mark?.position ?? mark?.index ?? mark?.begin ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
}

function lrHq2End(mark, start, max) {
  const direct = mark?.to ?? mark?.end ?? mark?.stop;
  if (direct !== undefined && direct !== null && direct !== '') {
    const n = Number(direct);
    if (Number.isFinite(n)) return Math.max(start, Math.min(max, n));
  }

  const len = mark?.length ?? mark?.len ?? mark?.size ?? mark?.count;
  const n = Number(len);
  if (Number.isFinite(n) && n > 0) return Math.max(start, Math.min(max, start + n));

  return start;
}

function lrHq2Priority(kind) {
  if (kind === 'heading') return 1;
  if (kind === 'quote') return 2;
  if (kind === 'link') return 3;
  if (kind === 'bold') return 4;
  if (kind === 'italic') return 5;
  if (kind === 'underline') return 6;
  if (kind === 'strike') return 7;
  if (kind === 'mono') return 8;
  if (kind === 'mark') return 9;
  return 99;
}

function lrHq2Open(item) {
  if (item.kind === 'heading') return '<h1>';
  if (item.kind === 'quote') return '<blockquote>';
  if (item.kind === 'bold') return '<b>';
  if (item.kind === 'italic') return '<i>';
  if (item.kind === 'underline') return '<u>';
  if (item.kind === 'strike') return '<s>';
  if (item.kind === 'mono') return '<code>';
  if (item.kind === 'mark') return '<mark>';
  if (item.kind === 'link') return item.url ? '<a href="' + lrHq2Attr(item.url) + '">' : '';
  return '';
}

function lrHq2Close(item) {
  if (item.kind === 'heading') return '</h1>';
  if (item.kind === 'quote') return '</blockquote>';
  if (item.kind === 'bold') return '</b>';
  if (item.kind === 'italic') return '</i>';
  if (item.kind === 'underline') return '</u>';
  if (item.kind === 'strike') return '</s>';
  if (item.kind === 'mono') return '</code>';
  if (item.kind === 'mark') return '</mark>';
  if (item.kind === 'link') return item.url ? '</a>' : '';
  return '';
}

function lrHq2ApplyMarkupToHtml(text, markup) {
  const source = String(text || '');
  const list = Array.isArray(markup) ? markup : [];
  if (!source) return '';
  if (!list.length) return lrHq2EscapeHtml(source);

  const items = [];

  for (const mark of list) {
    if (!mark || typeof mark !== 'object') continue;
    const kind = lrHq2Kind(mark, '');
    if (!kind) continue;

    const start = lrHq2Start(mark, source.length);
    const end = lrHq2End(mark, start, source.length);
    const url = lrHq2Url(mark);

    if (end <= start || start >= source.length) continue;
    if (kind === 'link' && !url) continue;

    items.push({ kind, start, end, url, priority: lrHq2Priority(kind) });
  }

  if (!items.length) return lrHq2EscapeHtml(source);

  const opens = new Map();
  const closes = new Map();

  for (const item of items) {
    if (!opens.has(item.start)) opens.set(item.start, []);
    if (!closes.has(item.end)) closes.set(item.end, []);
    opens.get(item.start).push(item);
    closes.get(item.end).push(item);
  }

  for (const arr of opens.values()) {
    arr.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : b.end - a.end));
  }

  for (const arr of closes.values()) {
    arr.sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.start - b.start));
  }

  let out = '';
  for (let i = 0; i <= source.length; i++) {
    const closeItems = closes.get(i);
    if (closeItems) {
      for (const item of closeItems) out += lrHq2Close(item);
    }

    const openItems = opens.get(i);
    if (openItems) {
      for (const item of openItems) out += lrHq2Open(item);
    }

    if (i < source.length) out += lrHq2EscapeHtml(source[i]);
  }

  return out;
}

function lrHq2FindRawText(root) {
  const candidates = [
    root?.message?.body?.text,
    root?.message?.text,
    root?.message?.caption,
    root?.body?.text,
    root?.text,
    root?.caption,
    root?.message?.link?.message?.body?.text,
    root?.message?.link?.message?.text,
    root?.link?.message?.body?.text,
    root?.link?.message?.text,
    root?.message?.linked_message?.body?.text,
    root?.message?.linkedMessage?.body?.text,
    root?.message?.forwarded_message?.body?.text,
    root?.message?.forwardedMessage?.body?.text,
    root?.linked_message?.body?.text,
    root?.linkedMessage?.body?.text,
    root?.forwarded_message?.body?.text,
    root?.forwardedMessage?.body?.text
  ];

  for (const value of candidates) {
    const text = String(value || '');
    if (text.trim()) return text;
  }

  return '';
}

function lrHq2ObjectText(obj) {
  if (!obj || typeof obj !== 'object') return '';

  const candidates = [
    obj.text,
    obj.caption,
    obj.title,
    obj.body?.text,
    obj.payload?.text,
    obj.payload?.body?.text,
    obj.quote?.text,
    obj.quote?.body?.text,
    obj.quoted?.text,
    obj.quoted?.body?.text,
    obj.blockquote?.text,
    obj.blockquote?.body?.text,
    obj.blockQuote?.text,
    obj.blockQuote?.body?.text,
    obj.heading?.text,
    obj.header?.text,
    obj.message?.body?.text,
    obj.message?.text
  ];

  for (const value of candidates) {
    const text = String(value || '').trim();
    if (text) return text;
  }

  return '';
}

function lrHq2CollectDeep(root, sourceText) {
  const text = String(sourceText || '');
  const max = text.length;
  const out = [];
  const seenObjects = new WeakSet();
  const seenRanges = new Set();
  if (!max) return out;

  function push(kind, rawType, start, end, mark, url) {
    if (!kind) return;
    if (kind === 'link' && !url) return;

    const a = Math.max(0, Math.min(max, Number(start) || 0));
    const b = Math.max(a, Math.min(max, Number(end) || 0));
    if (b <= a) return;

    const key = [kind, a, b, url || ''].join('|');
    if (seenRanges.has(key)) return;
    seenRanges.add(key);

    out.push({
      ...(mark && typeof mark === 'object' ? mark : {}),
      type: rawType || kind,
      from: a,
      length: b - a,
      ...(url ? { url } : {})
    });
  }

  function addMark(mark, hint) {
    if (!mark || typeof mark !== 'object') return;

    const raw = lrHq2RawType(mark, hint);
    const kind = lrHq2Kind(mark, hint);
    if (!kind) return;

    let start = lrHq2Start(mark, max);
    let end = lrHq2End(mark, start, max);
    const url = lrHq2Url(mark);

    if (end <= start && (kind === 'heading' || kind === 'quote')) {
      const part = lrHq2ObjectText(mark);
      const idx = part ? text.indexOf(part) : -1;
      if (idx >= 0) {
        start = idx;
        end = idx + part.length;
      }
    }

    push(kind, raw || kind, start, end, mark, url);
  }

  function walk(value, hint) {
    if (!value || typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, hint);
      return;
    }

    addMark(value, hint);

    for (const entry of Object.entries(value)) {
      const key = String(entry[0] || '');
      const child = entry[1];
      const lower = key.toLowerCase();

      if (typeof child === 'string') {
        const kind = lower.includes('heading') || lower.includes('header') || lower.includes('title')
          ? 'heading'
          : (lower.includes('quote') || lower.includes('blockquote') || lower.includes('citation') || lower.includes('cite') ? 'quote' : '');

        if (kind) {
          const part = child.trim();
          const idx = part ? text.indexOf(part) : -1;
          if (idx >= 0) push(kind, kind, idx, idx + part.length, { type: kind, text: part }, '');
        }
      }

      walk(child, key);
    }
  }

  walk(root, '');
  return out;
}

function lrHq2MergeMarkup(base, extra) {
  const out = [];
  const seen = new Set();

  for (const item of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
    if (!item || typeof item !== 'object') continue;
    const kind = lrHq2Kind(item, '');
    if (!kind) continue;

    const start = item.from ?? item.start ?? item.offset ?? item.position ?? item.index ?? item.begin ?? 0;
    const len = item.length ?? item.len ?? item.size ?? item.count ?? '';
    const to = item.to ?? item.end ?? item.stop ?? '';
    const url = lrHq2Url(item);

    if (kind === 'link' && !url) continue;

    const key = [kind, start, len, to, url].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

try {
  if (typeof applyMarkupToHtml === 'function') {
    applyMarkupToHtml = lrHq2ApplyMarkupToHtml;
    console.log('[heading quote patch] applyMarkupToHtml overridden');
  }
} catch (error) {
  console.error('[heading quote patch] apply override failed:', error?.message || error);
}

try {
  if (typeof lrMaxMarkupToMarkdown === 'function') {
    lrMaxMarkupToMarkdown = function lrMaxMarkupToMarkdownPatched(text, markup = []) {
      return lrHq2ApplyMarkupToHtml(text, markup);
    };
    console.log('[heading quote patch] lrMaxMarkupToMarkdown overridden');
  }
} catch (error) {
  console.error('[heading quote patch] markdown override failed:', error?.message || error);
}

try {
  if (typeof hydrateContent === 'function') {
    const lrHq2HydrateBefore = hydrateContent;
    hydrateContent = async function lrHq2HydrateContent(update) {
      const content = await lrHq2HydrateBefore(update);

      try {
        const rawText = lrHq2FindRawText(update) || String(content?.raw?.text || content?.sourceText || '') || lrHq2Plain(content?.text || '');
        if (!String(rawText || '').trim()) return content;

        const baseMarkup = Array.isArray(content?.markup) ? content.markup : [];
        const extraMarkup = lrHq2CollectDeep(update, rawText);
        const mergedMarkup = lrHq2MergeMarkup(baseMarkup, extraMarkup);

        const special = mergedMarkup.filter((x) => {
          const k = lrHq2Kind(x, '');
          return k === 'heading' || k === 'quote';
        });

        if (special.length) {
          console.log('[heading quote detected]', JSON.stringify(special.map((x) => {
            const from = Number(x.from ?? x.start ?? x.offset ?? 0) || 0;
            const length = Number(x.length ?? x.len ?? x.size ?? 0) || 0;
            return {
              type: lrHq2RawType(x, ''),
              kind: lrHq2Kind(x, ''),
              from,
              length,
              text: String(rawText).slice(from, from + length).slice(0, 120)
            };
          }).slice(0, 20)));
        }

        if (mergedMarkup.length) {
          return {
            ...(content || {}),
            text: lrHq2ApplyMarkupToHtml(rawText, mergedMarkup),
            format: 'html',
            markup: mergedMarkup,
            raw: {
              ...(content?.raw || {}),
              text: rawText
            }
          };
        }
      } catch (error) {
        console.error('[heading quote hydrate error]', error?.message || error);
      }

      return content;
    };
    console.log('[heading quote patch] hydrateContent wrapped');
  }
} catch (error) {
  console.error('[heading quote patch] hydrate wrapper failed:', error?.message || error);
}
// LR_APPEND_HEADING_QUOTE_SAFE_V2_END

await ensureDb();
startAutopostWorker().catch(e => console.error('[autopost start]', e));
app.listen(PORT, () => console.log(`LinkRay bot started on port ${PORT}`));

// LR_HEADING_QUOTE_SPECIAL_V6_START
(() => {
  if (globalThis.__lrHeadingQuoteSpecialV6Installed) return;
  globalThis.__lrHeadingQuoteSpecialV6Installed = true;

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const attr = (value) => esc(value).replace(/'/g, '&#39;');

  const rawType = (mark, keyHint = '') => String(
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
    mark?.message_style ||
    mark?.messageStyle ||
    mark?.payload?.type ||
    mark?.payload?.kind ||
    mark?.payload?.style ||
    mark?.payload?.format ||
    mark?.payload?.markup_type ||
    mark?.payload?.markupType ||
    mark?.payload?.entity_type ||
    mark?.payload?.entityType ||
    mark?.payload?.block_type ||
    mark?.payload?.blockType ||
    keyHint ||
    ''
  ).toLowerCase();

  const kindFromType = (mark, keyHint = '') => {
    const t = rawType(mark, keyHint)
      .replace(/[\s_-]+/g, '');

    if (
      t.includes('blockquote') ||
      t.includes('quote') ||
      t.includes('quotation') ||
      t.includes('quoted') ||
      t.includes('citation') ||
      t.includes('cite')
    ) return 'quote';

    if (
      t.includes('heading') ||
      t.includes('header') ||
      t.includes('headline') ||
      t.includes('title') ||
      t.includes('h1') ||
      t.includes('h2') ||
      t.includes('h3') ||
      t.includes('h4') ||
      t.includes('h5') ||
      t.includes('h6') ||
      t === 'big' ||
      t === 'large'
    ) return 'heading';

    if (t.includes('bold') || t.includes('strong') || t === 'b') return 'bold';
    if (t.includes('italic') || t.includes('emphasis') || t.includes('emphasized') || t === 'em' || t === 'i') return 'italic';
    if (t.includes('underline') || t === 'u' || t === 'ins') return 'underline';
    if (t.includes('strike') || t.includes('strikethrough') || t.includes('through') || t.includes('deleted') || t === 's' || t === 'del') return 'strike';
    if (t.includes('mono') || t.includes('code') || t.includes('pre') || t === 'tt') return 'code';
    if (t.includes('mark') || t.includes('highlight')) return 'mark';
    if (t.includes('link') || t.includes('url') || t === 'a') return 'link';

    return '';
  };

  const urlOf = (mark) => {
    const url = String(
      mark?.url ||
      mark?.href ||
      mark?.link ||
      mark?.payload?.url ||
      mark?.payload?.href ||
      mark?.payload?.link ||
      mark?.data?.url ||
      mark?.data?.href ||
      mark?.data?.link ||
      ''
    ).trim();

    if (!url || /^javascript:/i.test(url)) return '';

    return url;
  };

  const numFrom = (mark, names) => {
    const boxes = [
      mark,
      mark?.range,
      mark?.text_range,
      mark?.textRange,
      mark?.span,
      mark?.segment,
      mark?.selection,
      mark?.entity,
      mark?.payload,
      mark?.payload?.range,
      mark?.payload?.text_range,
      mark?.payload?.textRange,
      mark?.payload?.span,
      mark?.payload?.segment,
      mark?.payload?.selection,
      mark?.data,
      mark?.data?.range,
      mark?.data?.text_range,
      mark?.data?.textRange,
      mark?.data?.span,
    ];

    for (const box of boxes) {
      if (!box || typeof box !== 'object') continue;

      for (const name of names) {
        const n = Number(box?.[name]);

        if (Number.isFinite(n)) return n;
      }
    }

    return NaN;
  };

  const startOf = (mark, max) => {
    const n = numFrom(mark, ['from', 'start', 'offset', 'position', 'index', 'begin']);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
  };

  const endOf = (mark, start, max) => {
    const direct = numFrom(mark, ['to', 'end', 'stop']);

    if (Number.isFinite(direct) && direct > start) {
      return Math.max(start, Math.min(max, direct));
    }

    const len = numFrom(mark, ['length', 'len', 'size', 'count']);

    if (Number.isFinite(len) && len > 0) {
      return Math.max(start, Math.min(max, start + len));
    }

    return start;
  };

  const priority = (kind) => {
    if (kind === 'quote') return 0;
    if (kind === 'heading') return 1;
    if (kind === 'bold') return 2;
    if (kind === 'italic') return 3;
    if (kind === 'underline') return 4;
    if (kind === 'strike') return 5;
    if (kind === 'code') return 6;
    if (kind === 'mark') return 7;
    if (kind === 'link') return 8;

    return 99;
  };

  const openTag = (item) => {
    if (item.kind === 'quote') return '<blockquote>';
    if (item.kind === 'heading') return '<h1>';
    if (item.kind === 'bold') return '<b>';
    if (item.kind === 'italic') return '<i>';
    if (item.kind === 'underline') return '<u>';
    if (item.kind === 'strike') return '<s>';
    if (item.kind === 'code') return '<code>';
    if (item.kind === 'mark') return '<mark>';
    if (item.kind === 'link') return item.url ? '<a href="' + attr(item.url) + '">' : '';

    return '';
  };

  const closeTag = (item) => {
    if (item.kind === 'quote') return '</blockquote>';
    if (item.kind === 'heading') return '</h1>';
    if (item.kind === 'bold') return '</b>';
    if (item.kind === 'italic') return '</i>';
    if (item.kind === 'underline') return '</u>';
    if (item.kind === 'strike') return '</s>';
    if (item.kind === 'code') return '</code>';
    if (item.kind === 'mark') return '</mark>';
    if (item.kind === 'link') return item.url ? '</a>' : '';

    return '';
  };

  const renderHtml = (text, markup = []) => {
    const source = String(text ?? '');
    const max = source.length;
    const list = Array.isArray(markup) ? markup : [];
    const items = [];
    const seen = new Set();

    if (!source) return '';

    for (const mark of list) {
      if (!mark || typeof mark !== 'object') continue;

      const kind = kindFromType(mark);
      if (!kind) continue;

      const start = startOf(mark, max);
      const end = endOf(mark, start, max);
      const url = urlOf(mark);

      if (end <= start || start >= max) continue;
      if (kind === 'link' && !url) continue;

      const key = [kind, start, end, url].join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        mark,
        kind,
        start,
        end,
        url,
        priority: priority(kind),
      });
    }

    if (!items.length) return esc(source);

    const opens = new Map();
    const closes = new Map();

    for (const item of items) {
      if (!opens.has(item.start)) opens.set(item.start, []);
      if (!closes.has(item.end)) closes.set(item.end, []);

      opens.get(item.start).push(item);
      closes.get(item.end).push(item);
    }

    for (const arr of opens.values()) {
      arr.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.end - a.end;
      });
    }

    for (const arr of closes.values()) {
      arr.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return b.start - a.start;
      });
    }

    let out = '';

    for (let i = 0; i <= max; i++) {
      const closeItems = closes.get(i);
      if (closeItems) {
        for (const item of closeItems) out += closeTag(item);
      }

      const openItems = opens.get(i);
      if (openItems) {
        for (const item of openItems) out += openTag(item);
      }

      if (i < max) out += esc(source[i]);
    }

    return out;
  };

  const findText = (root) => {
    const candidates = [
      root?.message?.body?.text,
      root?.message?.text,
      root?.message?.caption,
      root?.body?.text,
      root?.text,
      root?.caption,
      root?.message?.link?.message?.body?.text,
      root?.message?.link?.message?.text,
      root?.link?.message?.body?.text,
      root?.link?.message?.text,
      root?.linked_message?.body?.text,
      root?.linkedMessage?.body?.text,
    ];

    for (const value of candidates) {
      const text = String(value || '');

      if (text.trim()) return text;
    }

    return '';
  };

  const findNestedText = (obj) => {
    if (!obj || typeof obj !== 'object') return '';

    const candidates = [
      obj.text,
      obj.caption,
      obj.title,
      obj.body?.text,
      obj.payload?.text,
      obj.payload?.body?.text,
      obj.data?.text,
      obj.data?.body?.text,
      obj.quote?.text,
      obj.quote?.body?.text,
      obj.quoted?.text,
      obj.quoted?.body?.text,
      obj.blockquote?.text,
      obj.blockquote?.body?.text,
      obj.blockQuote?.text,
      obj.blockQuote?.body?.text,
      obj.message?.body?.text,
      obj.message?.text,
    ];

    for (const value of candidates) {
      const text = String(value || '').trim();

      if (text) return text;
    }

    return '';
  };

  const collectDeepMarkup = (root, sourceText = '') => {
    const text = String(sourceText || findText(root) || '');
    const max = text.length;

    if (!max) return [];

    const out = [];
    const seenObjects = new WeakSet();
    const seenRanges = new Set();

    const push = (kind, type, start, end, mark, url = '') => {
      if (!kind || end <= start || start >= max) return;
      if (kind === 'link' && !url) return;

      const key = [kind, start, end, url].join('|');
      if (seenRanges.has(key)) return;
      seenRanges.add(key);

      out.push({
        ...(mark && typeof mark === 'object' ? mark : {}),
        type: type || kind,
        from: start,
        length: end - start,
        ...(url ? { url } : {}),
      });
    };

    const addMark = (mark, keyHint = '') => {
      if (!mark || typeof mark !== 'object') return;

      const type = rawType(mark, keyHint);
      const kind = kindFromType(mark, keyHint);
      if (!kind) return;

      let start = startOf(mark, max);
      let end = endOf(mark, start, max);
      const url = urlOf(mark);

      if ((kind === 'quote' || kind === 'heading') && end <= start) {
        const nestedText = findNestedText(mark);

        if (nestedText) {
          const idx = text.indexOf(nestedText);

          if (idx >= 0) {
            start = idx;
            end = idx + nestedText.length;
          }
        }
      }

      push(kind, type || kind, start, end, mark, url);
    };

    const walk = (value, keyHint = '') => {
      if (!value || typeof value !== 'object') return;
      if (seenObjects.has(value)) return;
      seenObjects.add(value);

      if (Array.isArray(value)) {
        for (const item of value) walk(item, keyHint);
        return;
      }

      addMark(value, keyHint);

      for (const [key, child] of Object.entries(value)) {
        const lower = String(key || '').toLowerCase().replace(/[\s_-]+/g, '');

        if (typeof child === 'string') {
          let syntheticKind = '';

          if (
            lower.includes('blockquote') ||
            lower.includes('quote') ||
            lower.includes('quotation') ||
            lower.includes('quoted') ||
            lower.includes('citation') ||
            lower.includes('cite')
          ) syntheticKind = 'quote';

          if (
            lower.includes('heading') ||
            lower.includes('header') ||
            lower.includes('headline') ||
            lower.includes('title')
          ) syntheticKind = syntheticKind || 'heading';

          if (syntheticKind) {
            const part = child.trim();
            const idx = part ? text.indexOf(part) : -1;

            if (idx >= 0) {
              push(syntheticKind, syntheticKind, idx, idx + part.length, { type: syntheticKind, text: part }, '');
            }
          }
        }

        walk(child, key);
      }
    };

    walk(root, '');

    return out;
  };

  const mergeMarkup = (base = [], extra = []) => {
    const out = [];
    const seen = new Set();

    for (const item of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
      if (!item || typeof item !== 'object') continue;

      const kind = kindFromType(item);
      if (!kind) continue;

      const from = item.from ?? item.start ?? item.offset ?? item.position ?? item.index ?? item.begin ?? item.range?.from ?? item.range?.start ?? 0;
      const len = item.length ?? item.len ?? item.size ?? item.count ?? item.range?.length ?? item.range?.len ?? '';
      const to = item.to ?? item.end ?? item.stop ?? item.range?.to ?? item.range?.end ?? '';
      const url = urlOf(item);

      if (kind === 'link' && !url) continue;

      const key = [kind, from, len, to, url].join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      out.push(item);
    }

    return out;
  };

  const summarizeKinds = (markup, rawText) => {
    const counts = {};
    const ranges = [];

    for (const item of Array.isArray(markup) ? markup : []) {
      const kind = kindFromType(item) || 'unknown';
      counts[kind] = (counts[kind] || 0) + 1;

      if (kind === 'heading' || kind === 'quote') {
        const start = startOf(item, rawText.length);
        const end = endOf(item, start, rawText.length);

        ranges.push({
          kind,
          from: start,
          length: end - start,
          type: rawType(item),
          text: rawText.slice(start, end).slice(0, 120),
        });
      }
    }

    return { counts, ranges: ranges.slice(0, 20) };
  };

  const previousHydrate = typeof hydrateContent === 'function' ? hydrateContent : null;

  if (!previousHydrate) {
    console.error('[heading quote v6] hydrateContent not found');
    return;
  }

  hydrateContent = async function lrHeadingQuoteSpecialV6HydrateContent(update) {
    const content = await previousHydrate(update);

    try {
      const rawText =
        findText(update) ||
        String(content?.raw?.text || content?.sourceText || content?.text || '');

      if (!rawText) return content;

      const extraMarkup = collectDeepMarkup(update, rawText);
      const mergedMarkup = mergeMarkup(content?.markup || [], extraMarkup);

      const hasSpecial = mergedMarkup.some((x) => {
        const kind = kindFromType(x);

        return kind === 'heading' || kind === 'quote';
      });

      const summary = summarizeKinds(mergedMarkup, rawText);

      console.log('[heading quote v6]', JSON.stringify({
        rawTextLength: rawText.length,
        baseMarkup: Array.isArray(content?.markup) ? content.markup.length : 0,
        extraMarkup: extraMarkup.length,
        mergedMarkup: mergedMarkup.length,
        hasSpecial,
        counts: summary.counts,
        ranges: summary.ranges,
      }));

      if (hasSpecial) {
        return {
          ...(content || {}),
          text: renderHtml(rawText, mergedMarkup),
          format: 'html',
          markup: mergedMarkup,
          raw: {
            ...(content?.raw || {}),
            text: rawText,
          },
        };
      }
    } catch (error) {
      console.error('[heading quote v6 error]', error.message || error);
    }

    return content;
  };
})();
// LR_HEADING_QUOTE_SPECIAL_V6_END

// LR_SAFE_APPEND_MAX_MARKUP_START
try {
  if (!globalThis.__lrSafeAppendMaxMarkupInstalled) {
    globalThis.__lrSafeAppendMaxMarkupInstalled = true;

    const __lrEscHtml = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const __lrRawType = (mark, keyHint = '') => String(
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
      keyHint ||
      ''
    ).toLowerCase();

    const __lrKind = (mark, keyHint = '') => {
      const t = __lrRawType(mark, keyHint);
      if (!t) return '';

      if (t.includes('heading') || t.includes('header') || t.includes('title') || /^h[1-6]$/.test(t)) return 'heading';
      if (t.includes('blockquote') || t.includes('block_quote') || t.includes('quote') || t.includes('quotation') || t.includes('quoted') || t.includes('cite')) return 'quote';
      if (t.includes('bold') || t.includes('strong')) return 'bold';
      if (t.includes('italic') || t.includes('emphasis') || t.includes('emphasiz') || t === 'em') return 'italic';
      if (t.includes('underline') || t === 'ins') return 'underline';
      if (t.includes('strike') || t.includes('through') || t.includes('deleted') || t === 'del' || t === 's') return 'strike';
      if (t.includes('mono') || t.includes('inline_code') || t.includes('pre') || t === 'code') return 'code';
      if (t.includes('mark') || t.includes('highlight')) return 'mark';
      if (t.includes('link') || t.includes('url')) return 'link';

      return '';
    };

    const __lrUrl = (mark) => String(
      mark?.url ||
      mark?.href ||
      mark?.link ||
      mark?.payload?.url ||
      mark?.payload?.href ||
      mark?.payload?.link ||
      ''
    ).trim();

    const __lrStart = (mark, max) => {
      const raw = mark?.from ?? mark?.start ?? mark?.offset ?? mark?.position ?? mark?.index ?? mark?.begin ?? 0;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
    };

    const __lrEnd = (mark, start, max) => {
      const direct = mark?.to ?? mark?.end ?? mark?.stop;

      if (direct !== undefined && direct !== null && direct !== '') {
        const n = Number(direct);
        if (Number.isFinite(n)) return Math.max(start, Math.min(max, n));
      }

      const len = mark?.length ?? mark?.len ?? mark?.size ?? mark?.count;
      const n = Number(len);

      if (Number.isFinite(n) && n > 0) {
        return Math.max(start, Math.min(max, start + n));
      }

      return start;
    };

    const __lrPriority = (kind) => ({
      quote: 10,
      heading: 20,
      bold: 30,
      italic: 40,
      underline: 50,
      strike: 60,
      mark: 70,
      code: 80,
      link: 90,
    }[kind] ?? 100);

    const __lrOpenTag = (item) => {
      if (item.kind === 'quote') return '<blockquote>';
      if (item.kind === 'heading') return '<h1>';
      if (item.kind === 'bold') return '<b>';
      if (item.kind === 'italic') return '<i>';
      if (item.kind === 'underline') return '<u>';
      if (item.kind === 'strike') return '<s>';
      if (item.kind === 'mark') return '<mark>';
      if (item.kind === 'code') return '<code>';
      if (item.kind === 'link') return item.url ? '<a href="' + __lrEscHtml(item.url) + '">' : '';
      return '';
    };

    const __lrCloseTag = (item) => {
      if (item.kind === 'quote') return '</blockquote>';
      if (item.kind === 'heading') return '</h1>';
      if (item.kind === 'bold') return '</b>';
      if (item.kind === 'italic') return '</i>';
      if (item.kind === 'underline') return '</u>';
      if (item.kind === 'strike') return '</s>';
      if (item.kind === 'mark') return '</mark>';
      if (item.kind === 'code') return '</code>';
      if (item.kind === 'link') return item.url ? '</a>' : '';
      return '';
    };

    const __lrApplyHtml = (text, markup = []) => {
      const source = String(text ?? '');
      const list = Array.isArray(markup) ? markup : [];

      if (!source || !list.length) return __lrEscHtml(source);

      const items = [];
      const seen = new Set();

      for (const mark of list) {
        if (!mark || typeof mark !== 'object') continue;

        const kind = __lrKind(mark);
        if (!kind) continue;

        const start = __lrStart(mark, source.length);
        const end = __lrEnd(mark, start, source.length);
        const url = __lrUrl(mark);

        if (end <= start || start >= source.length) continue;
        if (kind === 'link' && !url) continue;

        const key = [kind, start, end, url].join('|');
        if (seen.has(key)) continue;
        seen.add(key);

        items.push({ kind, start, end, url, priority: __lrPriority(kind) });
      }

      if (!items.length) return __lrEscHtml(source);

      const opens = new Map();
      const closes = new Map();

      for (const item of items) {
        if (!opens.has(item.start)) opens.set(item.start, []);
        if (!closes.has(item.end)) closes.set(item.end, []);
        opens.get(item.start).push(item);
        closes.get(item.end).push(item);
      }

      for (const arr of opens.values()) {
        arr.sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          return b.end - a.end;
        });
      }

      for (const arr of closes.values()) {
        arr.sort((a, b) => {
          if (a.priority !== b.priority) return b.priority - a.priority;
          return a.start - b.start;
        });
      }

      let out = '';

      for (let i = 0; i <= source.length; i++) {
        const closeItems = closes.get(i);
        if (closeItems) {
          for (const item of closeItems) out += __lrCloseTag(item);
        }

        const openItems = opens.get(i);
        if (openItems) {
          for (const item of openItems) out += __lrOpenTag(item);
        }

        if (i < source.length) out += __lrEscHtml(source[i]);
      }

      return out;
    };

    try {
      applyMarkupToHtml = function applyMarkupToHtmlPatched(text, markup = []) {
        return __lrApplyHtml(text, markup);
      };
    } catch (error) {
      console.error('[safe max markup] applyMarkupToHtml override failed:', error?.message || error);
    }

    try {
      lrMaxMarkupToMarkdown = function lrMaxMarkupToMarkdownPatched(text, markup = []) {
        return __lrApplyHtml(text, markup);
      };
    } catch (error) {
      console.error('[safe max markup] lrMaxMarkupToMarkdown override failed:', error?.message || error);
    }

    const __lrFindText = (root) => {
      const candidates = [
        root?.message?.body?.text,
        root?.message?.text,
        root?.message?.caption,
        root?.body?.text,
        root?.text,
        root?.caption,
        root?.message?.link?.message?.body?.text,
        root?.message?.link?.message?.text,
        root?.link?.message?.body?.text,
        root?.link?.message?.text,
        root?.linked_message?.body?.text,
        root?.linkedMessage?.body?.text,
      ];

      for (const value of candidates) {
        const text = String(value || '');
        if (text.trim()) return text;
      }

      return '';
    };

    const __lrInnerText = (obj) => {
      if (!obj || typeof obj !== 'object') return '';

      const direct = [
        obj.text,
        obj.caption,
        obj.title,
        obj.body?.text,
        obj.payload?.text,
        obj.payload?.body?.text,
        obj.quote?.text,
        obj.quote?.body?.text,
        obj.quoted?.text,
        obj.quoted?.body?.text,
        obj.blockquote?.text,
        obj.blockquote?.body?.text,
        obj.blockQuote?.text,
        obj.blockQuote?.body?.text,
        obj.message?.body?.text,
        obj.message?.text,
      ];

      for (const value of direct) {
        const text = String(value || '').trim();
        if (text) return text;
      }

      return '';
    };

    const __lrCollectMarkup = (root, sourceText = '') => {
      const text = String(sourceText || __lrFindText(root) || '');
      const max = text.length;

      if (!max) return [];

      const out = [];
      const seenObj = new WeakSet();
      const seenRange = new Set();

      const push = (kind, rawType, start, end, mark, url = '') => {
        if (!kind || end <= start || start >= max) return;
        if (kind === 'link' && !url) return;

        const key = [kind, start, end, url].join('|');
        if (seenRange.has(key)) return;
        seenRange.add(key);

        out.push({
          ...(mark && typeof mark === 'object' ? mark : {}),
          type: rawType || kind,
          from: start,
          length: end - start,
          ...(url ? { url } : {}),
        });
      };

      const addMark = (mark, keyHint = '') => {
        if (!mark || typeof mark !== 'object') return;

        const rawType = __lrRawType(mark, keyHint);
        const kind = __lrKind(mark, keyHint);

        if (!kind) return;

        let start = __lrStart(mark, max);
        let end = __lrEnd(mark, start, max);
        const url = __lrUrl(mark);

        const hasRange =
          mark.from !== undefined ||
          mark.start !== undefined ||
          mark.offset !== undefined ||
          mark.position !== undefined ||
          mark.index !== undefined ||
          mark.begin !== undefined;

        if ((end <= start || !hasRange) && (kind === 'quote' || kind === 'heading')) {
          const inner = __lrInnerText(mark);

          if (inner) {
            const idx = text.indexOf(inner);

            if (idx >= 0) {
              start = idx;
              end = idx + inner.length;
            }
          }
        }

        push(kind, rawType, start, end, mark, url);
      };

      const walk = (value, keyHint = '') => {
        if (!value || typeof value !== 'object') return;
        if (seenObj.has(value)) return;

        seenObj.add(value);

        if (Array.isArray(value)) {
          for (const item of value) walk(item, keyHint);
          return;
        }

        addMark(value, keyHint);

        for (const [key, child] of Object.entries(value)) {
          const low = String(key || '').toLowerCase();

          if (
            typeof child === 'string' &&
            child.trim() &&
            (
              low.includes('blockquote') ||
              low.includes('quote') ||
              low.includes('quotation') ||
              low.includes('cite') ||
              low.includes('heading') ||
              low.includes('header') ||
              low.includes('title')
            )
          ) {
            const inner = child.trim();
            const idx = text.indexOf(inner);

            if (idx >= 0) {
              const k = (
                low.includes('heading') ||
                low.includes('header') ||
                low.includes('title')
              ) ? 'heading' : 'quote';

              push(k, k, idx, idx + inner.length, { type: k, text: inner }, '');
            }
          }

          walk(child, key);
        }
      };

      walk(root, '');

      return out;
    };

    const __lrMergeMarkup = (base = [], extra = []) => {
      const out = [];
      const seen = new Set();

      for (const item of [
        ...(Array.isArray(base) ? base : []),
        ...(Array.isArray(extra) ? extra : []),
      ]) {
        if (!item || typeof item !== 'object') continue;

        const kind = __lrKind(item);
        if (!kind) continue;

        const from = item.from ?? item.start ?? item.offset ?? item.position ?? item.index ?? item.begin ?? 0;
        const len = item.length ?? item.len ?? item.size ?? item.count ?? '';
        const to = item.to ?? item.end ?? item.stop ?? '';
        const url = __lrUrl(item);

        if (kind === 'link' && !url) continue;

        const key = [kind, from, len, to, url].join('|');
        if (seen.has(key)) continue;

        seen.add(key);
        out.push(item);
      }

      return out;
    };

    try {
      if (typeof hydrateContent === 'function') {
        const __lrBaseHydrateContent = hydrateContent;

        hydrateContent = async function hydrateContentSafeMaxMarkup(update) {
          const content = await __lrBaseHydrateContent(update);

          try {
            const rawText =
              __lrFindText(update) ||
              String(content?.raw?.text || content?.sourceText || content?.text || '');

            if (!rawText) return content;

            const extraMarkup = __lrCollectMarkup(update, rawText);
            const mergedMarkup = __lrMergeMarkup(content?.markup || content?.raw?.markup || [], extraMarkup);

            if (mergedMarkup.length) {
              const special = mergedMarkup.some((x) => {
                const k = __lrKind(x);
                return k === 'heading' || k === 'quote';
              });

              if (special) {
                console.log('[full max markup] special ranges', JSON.stringify(mergedMarkup.map((x) => ({
                  type: __lrRawType(x),
                  kind: __lrKind(x),
                  from: x.from ?? x.start ?? x.offset,
                  length: x.length ?? x.len,
                  text: rawText
                    .slice(
                      Number(x.from ?? x.start ?? x.offset ?? 0),
                      Number(x.from ?? x.start ?? x.offset ?? 0) + Number(x.length ?? x.len ?? 0)
                    )
                    .slice(0, 80),
                })).slice(0, 40)));
              }

              return {
                ...(content || {}),
                text: __lrApplyHtml(rawText, mergedMarkup),
                format: 'html',
                markup: mergedMarkup,
                raw: {
                  ...(content?.raw || {}),
                  text: rawText,
                  markup: mergedMarkup,
                },
              };
            }
          } catch (error) {
            console.error('[full max markup hydrate]', error?.message || error);
          }

          return content;
        };
      }
    } catch (error) {
      console.error('[safe max markup] hydrateContent override failed:', error?.message || error);
    }
  }
} catch (error) {
  console.error('[safe max markup append]', error?.message || error);
}
// LR_SAFE_APPEND_MAX_MARKUP_END

// LR_HEADING_QUOTE_HEURISTIC_START
try {
  if (typeof hydrateContent === 'function' && !globalThis.__LR_HEADING_QUOTE_HEURISTIC__) {
    globalThis.__LR_HEADING_QUOTE_HEURISTIC__ = true;
    const __lrHydrateBeforeHeadingQuote = hydrateContent;

    function lrHqEsc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function lrHqType(mark) {
      return String(
        (mark && (mark.type || mark.kind || mark.style || mark.format || mark.markup_type || mark.markupType)) || ''
      ).toLowerCase();
    }

    function lrHqKind(mark) {
      const t = lrHqType(mark);
      if (!t) return '';
      if (t.includes('heading') || t === 'h1' || t === 'header' || t.includes('title')) return 'heading';
      if (t.includes('quote') || t.includes('blockquote') || t.includes('citation') || t === 'cite') return 'quote';
      if (t.includes('bold') || t.includes('strong')) return 'bold';
      if (t.includes('italic') || t.includes('emphas')) return 'italic';
      if (t.includes('underline') || t === 'ins') return 'underline';
      if (t.includes('strike') || t.includes('through') || t.includes('deleted') || t === 's' || t === 'del') return 'strike';
      if (t.includes('mono') || t.includes('code')) return 'code';
      if (t.includes('mark') || t.includes('highlight')) return 'mark';
      if (t.includes('link') || t.includes('url')) return 'link';
      return '';
    }

    function lrHqStart(mark, max) {
      const raw = mark && (mark.from ?? mark.start ?? mark.offset ?? mark.position ?? mark.index ?? mark.begin ?? 0);
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
    }

    function lrHqEnd(mark, start, max) {
      const direct = mark && (mark.to ?? mark.end ?? mark.stop);
      if (direct !== undefined && direct !== null && direct !== '') {
        const n = Number(direct);
        if (Number.isFinite(n)) return Math.max(start, Math.min(max, n));
      }
      const len = mark && (mark.length ?? mark.len ?? mark.size ?? mark.count);
      const n = Number(len);
      if (Number.isFinite(n) && n > 0) return Math.max(start, Math.min(max, start + n));
      return start;
    }

    function lrHqUrl(mark) {
      return String(
        (mark && (mark.url || mark.href || mark.link || (mark.payload && (mark.payload.url || mark.payload.href || mark.payload.link)))) || ''
      ).trim();
    }

    function lrHqPriority(kind) {
      if (kind === 'quote') return 1;
      if (kind === 'heading') return 2;
      if (kind === 'link') return 9;
      return 5;
    }

    function lrHqOpen(item) {
      if (item.kind === 'heading') return '<h1>';
      if (item.kind === 'quote') return '<blockquote>';
      if (item.kind === 'bold') return '<b>';
      if (item.kind === 'italic') return '<i>';
      if (item.kind === 'underline') return '<u>';
      if (item.kind === 'strike') return '<s>';
      if (item.kind === 'code') return '<code>';
      if (item.kind === 'mark') return '<mark>';
      if (item.kind === 'link') return item.url ? '<a href="' + lrHqEsc(item.url) + '">' : '';
      return '';
    }

    function lrHqClose(item) {
      if (item.kind === 'heading') return '</h1>';
      if (item.kind === 'quote') return '</blockquote>';
      if (item.kind === 'bold') return '</b>';
      if (item.kind === 'italic') return '</i>';
      if (item.kind === 'underline') return '</u>';
      if (item.kind === 'strike') return '</s>';
      if (item.kind === 'code') return '</code>';
      if (item.kind === 'mark') return '</mark>';
      if (item.kind === 'link') return item.url ? '</a>' : '';
      return '';
    }

    function lrHqTextFrom(update, content) {
      const msg = update && (update.message?.link?.message || update.link?.message || update.message || update);
      const values = [
        msg?.body?.text,
        msg?.text,
        msg?.caption,
        update?.message?.body?.text,
        update?.message?.text,
        content?.raw?.text,
        content?.sourceText
      ];
      for (const value of values) {
        const text = String(value == null ? '' : value);
        if (text.trim()) return text;
      }
      const current = String(content?.text || '');
      return /<[^>]+>/.test(current) ? '' : current;
    }

    function lrHqMarkupFrom(update, content) {
      const msg = update && (update.message?.link?.message || update.link?.message || update.message || update);
      const lists = [
        msg?.body?.markup,
        msg?.markup,
        update?.message?.body?.markup,
        update?.message?.markup,
        content?.markup
      ];
      for (const list of lists) {
        if (Array.isArray(list) && list.length) return list;
      }
      return [];
    }

    function lrHqAddManualQuoteRanges(text, ranges) {
      let pos = 0;
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*>\s*(.+)$/);
        if (m) {
          const start = pos + line.indexOf(m[1]);
          ranges.push({ kind: 'quote', start, end: pos + line.length, priority: lrHqPriority('quote'), url: '' });
        }
        pos += line.length + 1;
      }
    }

    function lrHqAddHeuristicQuote(text, ranges, originalMarkup) {
      const hasQuote = ranges.some((x) => x.kind === 'quote');
      if (hasQuote) return false;

      const heading = ranges.find((x) => x.kind === 'heading' && x.start === 0);
      if (!heading) return false;

      const meaningful = (Array.isArray(originalMarkup) ? originalMarkup : []).filter((m) => lrHqKind(m));
      if (meaningful.length !== 1 || lrHqKind(meaningful[0]) !== 'heading') return false;

      let start = heading.end;
      let sawBlank = false;

      while (start < text.length && /[ \t\r\n]/.test(text[start])) {
        if (text[start] === '\n' && text[start + 1] === '\n') sawBlank = true;
        start++;
      }

      let end = text.length;
      while (end > start && /[ \t\r\n]/.test(text[end - 1])) end--;

      const quoteText = text.slice(start, end).trim();
      if (!quoteText) return false;
      if (!sawBlank && text.slice(heading.end, start).indexOf('\n') < 0) return false;
      if (quoteText.length > 700) return false;

      const nonEmptyLines = quoteText.split('\n').map((line) => line.trim()).filter(Boolean);
      if (nonEmptyLines.length > 4) return false;

      ranges.push({ kind: 'quote', start, end, priority: lrHqPriority('quote'), url: '' });
      return true;
    }

    function lrHqBuildHtml(text, markup) {
      const source = String(text || '');
      const max = source.length;
      const originalMarkup = Array.isArray(markup) ? markup : [];
      const ranges = [];

      for (const mark of originalMarkup) {
        if (!mark || typeof mark !== 'object') continue;
        const kind = lrHqKind(mark);
        if (!kind) continue;

        const start = lrHqStart(mark, max);
        const end = lrHqEnd(mark, start, max);
        const url = lrHqUrl(mark);

        if (end <= start || start >= max) continue;
        if (kind === 'link' && !url) continue;

        ranges.push({ kind, start, end, url, priority: lrHqPriority(kind) });
      }

      lrHqAddManualQuoteRanges(source, ranges);
      const heuristicQuote = lrHqAddHeuristicQuote(source, ranges, originalMarkup);

      if (!ranges.length) return { html: lrHqEsc(source), changed: false, ranges };

      const opens = new Map();
      const closes = new Map();

      for (const item of ranges) {
        if (!opens.has(item.start)) opens.set(item.start, []);
        if (!closes.has(item.end)) closes.set(item.end, []);
        opens.get(item.start).push(item);
        closes.get(item.end).push(item);
      }

      for (const arr of opens.values()) arr.sort((a, b) => a.priority - b.priority || b.end - a.end);
      for (const arr of closes.values()) arr.sort((a, b) => b.priority - a.priority || b.start - a.start);

      let out = '';

      for (let i = 0; i <= max; i++) {
        const closeItems = closes.get(i);
        if (closeItems) for (const item of closeItems) out += lrHqClose(item);

        const openItems = opens.get(i);
        if (openItems) for (const item of openItems) out += lrHqOpen(item);

        if (i < max) out += lrHqEsc(source[i]);
      }

      return { html: out, changed: true, ranges, heuristicQuote };
    }

    hydrateContent = async function lrHydrateContentHeadingQuote(update) {
      const content = await __lrHydrateBeforeHeadingQuote(update);

      try {
        const rawText = lrHqTextFrom(update, content);
        const markup = lrHqMarkupFrom(update, content);

        if (!rawText || !Array.isArray(markup) || !markup.length) return content;

        const result = lrHqBuildHtml(rawText, markup);
        const types = result.ranges.map((x) => x.kind);

        console.log('[heading quote heuristic]', JSON.stringify({
          textLength: rawText.length,
          markup: markup.length,
          types,
          heuristicQuote: !!result.heuristicQuote
        }));

        if (result.changed && result.html && result.html !== content?.text) {
          return {
            ...(content || {}),
            text: result.html,
            format: 'html',
            markup: [],
            raw: { ...((content && content.raw) || {}), text: rawText, markup }
          };
        }
      } catch (error) {
        console.error('[heading quote heuristic error]', error && (error.message || error));
      }

      return content;
    };

    console.log('[heading quote heuristic] hydrateContent wrapped');
  }
} catch (error) {
  console.error('[heading quote heuristic install error]', error && (error.message || error));
}
// LR_HEADING_QUOTE_HEURISTIC_END

/* LR_CLEAN_SIGNATURE_COMPOSE_START */
{
  const lrRowsCompose = function(r) {
    return Array.isArray(r) ? r : (r && r.rows ? r.rows : []);
  };

  const lrLoadSigCompose = async function(channelId) {
    const r = await query(
      'SELECT * FROM channel_signatures WHERE channel_id=$1 AND is_active=true ORDER BY updated_at DESC, id DESC LIMIT 1',
      [Number(channelId)]
    );
    return lrRowsCompose(r)[0] || null;
  };

  if (typeof composePostForChannel === 'function') {
    const lrOldComposePostForChannelClean = composePostForChannel;

    composePostForChannel = async function(draft, channelId) {
      const result = await lrOldComposePostForChannelClean(draft, channelId);

      if (!draft || draft.isAd || draft.signatureEnabled === false) {
        return result;
      }

      const sig = await lrLoadSigCompose(channelId);

      if (!sig || !sig.text || !sig.is_active) {
        return result;
      }

      const baseText = String(result && result.text ? result.text : '');
      const sigText = String(sig.text || '').trim();

      if (!sigText) {
        return result;
      }

      const basePlain = plain(baseText);
      const sigPlain = plain(sigText);

      if (sigPlain && basePlain.includes(sigPlain)) {
        return result;
      }

      return {
        ...(result || {}),
        text: baseText ? baseText + '\n\n' + sigText : sigText,
        format: 'html'
      };
    };

    console.log('[LR_CLEAN_SIGNATURE_COMPOSE] installed');
  }
}
/* LR_CLEAN_SIGNATURE_COMPOSE_END */

/* LR_PREVIEW_PAYLOAD_FIX_V13_START */
{
  const __lrPreviewOldComposeV13 = composePostForChannel;
  const __lrPreviewOldSendDraftPreviewV13 = sendDraftPreview;

  function lrPreviewBtnTextV13(button, index = 0) {
    return String(
      button?.text ||
      button?.title ||
      button?.label ||
      button?.name ||
      `Кнопка ${index + 1}`
    ).trim();
  }

  function lrPreviewBtnUrlV13(button) {
    return String(
      button?.url ||
      button?.link ||
      button?.href ||
      button?.targetUrl ||
      button?.originalUrl ||
      ''
    ).trim();
  }

  function lrPreviewCleanButtonsV13(buttons) {
    const source = Array.isArray(buttons) ? buttons : [];
    const out = [];
    const seen = new Set();

    for (const item of source) {
      const raw = Array.isArray(item) ? item : [item];

      for (let i = 0; i < raw.length; i++) {
        const b = raw[i] || {};
        const text = lrPreviewBtnTextV13(b, i);
        const url = lrPreviewBtnUrlV13(b);

        if (!text || !/^https?:\/\//i.test(url)) continue;
        if (/^(⚠️|формат кнопки|добавить кнопку|отправьте|можно отправить|сейчас|кнопки поста)/i.test(text)) continue;

        const id = text + '|' + url;
        if (seen.has(id)) continue;
        seen.add(id);

        out.push({ text, url });
      }
    }

    return out;
  }

  function lrPreviewKeyboardV13(draft) {
    const buttons = lrPreviewCleanButtonsV13(draft?.buttons || []);
    if (!buttons.length) return [];

    const rows = buttons.map((b) => [linkButton(b.text, b.url)]);
    return inlineKeyboard(rows);
  }

  function lrPreviewCleanAttachmentsV13(attachments) {
    let list = Array.isArray(attachments) ? attachments : [];

    try {
      if (typeof normalizeAttachments === 'function') {
        list = normalizeAttachments(list);
      }
    } catch (e) {
      console.error('[LR_PREVIEW_PAYLOAD_FIX_V13 normalize]', e?.message || e);
    }

    const out = [];
    const seen = new Set();

    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

      const type = String(
        item.type ||
        item.kind ||
        item.attachment_type ||
        item.attachmentType ||
        ''
      ).toLowerCase();

      // Эти типы часто ломают body при повторной отправке чужого/пересланного поста.
      if (type.includes('inline_keyboard')) continue;
      if (type.includes('keyboard')) continue;
      if (type.includes('button')) continue;
      if (type.includes('link_preview')) continue;
      if (type.includes('web_page')) continue;
      if (type.includes('preview')) continue;

      // Не отправляем сырой payload входящего сообщения обратно в MAX.
      if ('payload' in item && !type.match(/photo|video|audio|file|image|media|sticker/)) continue;

      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);

      out.push(item);
    }

    return out;
  }

  function lrPreviewSanitizeContentV13(content, draft) {
    const base = content && typeof content === 'object' ? content : {};
    const draftContent = draft?.content || {};

    const text = String(
      base.text ??
      draftContent.text ??
      ''
    );

    const format = String(
      base.format ||
      draftContent.format ||
      'html'
    );

    const baseAttachments =
      Array.isArray(base.attachments) && base.attachments.length
        ? base.attachments
        : draftContent.attachments;

    const attachments = [
      ...lrPreviewCleanAttachmentsV13(baseAttachments),
      ...lrPreviewKeyboardV13(draft)
    ];

    // Если текст уже HTML, markup лучше не дублировать: MAX иногда падает на смешанном html + markup + кнопки.
    const markup = format === 'html'
      ? []
      : (Array.isArray(base.markup) ? base.markup : []);

    return {
      text,
      format,
      attachments,
      markup
    };
  }

  composePostForChannel = async function lrPreviewComposePayloadFixV13(draft, channelId) {
    let result = null;

    try {
      result = await __lrPreviewOldComposeV13(draft, channelId);
    } catch (e) {
      console.error('[LR_PREVIEW_PAYLOAD_FIX_V13 compose old failed]', e?.message || e);
      result = draft?.content || {};
    }

    return lrPreviewSanitizeContentV13(result, draft);
  };

  sendDraftPreview = async function lrPreviewSendDraftPreviewFixV13(chatId, draft) {
    try {
      const channelId = Array.isArray(draft?.channelIds) ? draft.channelIds[0] : null;
      const content = await composePostForChannel(draft, channelId);

      if (!String(content.text || '').trim() && !content.attachments.length) {
        return null;
      }

      if (draft?.previewMessageId) {
        try {
          await editMaxMessage(draft.previewMessageId, content);
          return draft.previewMessageId;
        } catch (editError) {
          console.error('[LR_PREVIEW_PAYLOAD_FIX_V13 edit failed, send new]', editError?.message || editError);
        }
      }

      try {
        const sent = await sendMaxMessage({ chatId, ...content });
        return extractMessageId(sent);
      } catch (firstError) {
        console.error('[LR_PREVIEW_PAYLOAD_FIX_V13 full send failed]', firstError?.message || firstError);

        // Второй проход: текст + кнопки без старых вложений.
        const safeContent = {
          text: content.text || draft?.content?.text || 'пост без текста',
          format: content.format || draft?.content?.format || 'html',
          attachments: lrPreviewKeyboardV13(draft),
          markup: []
        };

        const sent = await sendMaxMessage({ chatId, ...safeContent });
        return extractMessageId(sent);
      }
    } catch (e) {
      console.error('[LR_PREVIEW_PAYLOAD_FIX_V13 final failed]', e?.message || e);

      await msg(
        chatId,
        '⚠️ Не удалось вывести превью полностью, но текст поста сохранён.\n\n' +
          escapeHtml(short(draft?.content?.text || '', 900)),
        [],
        'html'
      );

      return null;
    }
  };

  console.log('[LR_PREVIEW_PAYLOAD_FIX_V13] installed');
}
/* LR_PREVIEW_PAYLOAD_FIX_V13_END */

/* LR_PUBLISHED_DB_SAVE_V15_START */
{
  const __lrOldPublishDraftNowV15 = publishDraftNow;

  function lrPubJsonV15(value, fallback) {
    try {
      if (value === undefined || value === null) return JSON.stringify(fallback);
      return JSON.stringify(value);
    } catch {
      return JSON.stringify(fallback);
    }
  }

  function lrPubCleanButtonsV15(buttons) {
    const out = [];
    const seen = new Set();

    for (const b of Array.isArray(buttons) ? buttons : []) {
      const text = String(b?.text || b?.title || b?.label || '').trim();
      const url = String(b?.url || b?.link || b?.href || '').trim();

      if (!text || !/^https?:\/\//i.test(url)) continue;

      const id = text + '|' + url;
      if (seen.has(id)) continue;
      seen.add(id);

      out.push({ text, url });
    }

    return out;
  }

  function lrPubCleanAttachmentsV15(draft, content) {
    let src =
      Array.isArray(draft?.content?.attachments) ? draft.content.attachments :
      Array.isArray(content?.attachments) ? content.attachments :
      [];

    try {
      if (typeof normalizeAttachments === 'function') {
        src = normalizeAttachments(src);
      }
    } catch (e) {
      console.error('[LR_PUBLISHED_DB_SAVE_V15 normalizeAttachments]', e?.message || e);
    }

    const out = [];

    for (const a of Array.isArray(src) ? src : []) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) continue;

      const type = String(a.type || a.kind || a.attachment_type || '').toLowerCase();

      if (type.includes('inline_keyboard')) continue;
      if (type.includes('keyboard')) continue;
      if (type.includes('button')) continue;

      out.push(a);
    }

    return out;
  }

  async function lrPublishedColumnsV15() {
    try {
      const rows = await query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema='public'
           AND table_name='scheduled_posts'`
      );

      return new Set((rows || []).map(r => r.column_name));
    } catch (e) {
      console.error('[LR_PUBLISHED_DB_SAVE_V15 columns]', e?.message || e);
      return new Set();
    }
  }

  async function lrSavePublishedPostRowV15({ draft, key, channel, content, messageId }) {
    const cols = await lrPublishedColumnsV15();

    if (!cols.size) {
      throw new Error('Не удалось прочитать columns scheduled_posts');
    }

    const text = String(
      content?.text ??
      draft?.content?.text ??
      draft?.text ??
      ''
    );

    const format = String(
      content?.format ||
      draft?.content?.format ||
      draft?.format ||
      'html'
    );

    const safeDraft = {
      ...draft,
      previewMessageId: null,
      buttons: lrPubCleanButtonsV15(draft?.buttons || [])
    };

    const values = {
      channel_id: Number(channel.id),
      text,
      format,
      publish_at: new Date(),
      status: 'published',
      notify: false,
      created_by_max_user_id: String(key || ''),
      attachments: lrPubCleanAttachmentsV15(draft, content),
      buttons: lrPubCleanButtonsV15(draft?.buttons || []),
      draft: safeDraft,
      is_ad: Boolean(draft?.isAd || draft?.is_ad),
      cpm: draft?.cpm ?? null,
      auto_delete_minutes: draft?.autoDeleteMinutes ?? draft?.auto_delete_minutes ?? null,
      report_after_hours: draft?.reportAfterHours || draft?.report_after_hours || 24,
      report_group_id: draft?.campaignId || draft?.campaign_id || null,
      published_at: new Date(),
      published_message_id: messageId || null,
      updated_at: new Date(),
      created_at: new Date()
    };

    const names = [];
    const params = [];

    for (const [name, value] of Object.entries(values)) {
      if (!cols.has(name)) continue;

      names.push(name);

      if (['attachments', 'buttons', 'draft'].includes(name)) {
        params.push(lrPubJsonV15(value, name === 'draft' ? {} : []));
      } else {
        params.push(value);
      }
    }

    if (!names.includes('channel_id') || !names.includes('text') || !names.includes('publish_at') || !names.includes('status')) {
      throw new Error('В scheduled_posts нет нужных колонок для сохранения поста');
    }

    const placeholders = names.map((_, i) => `$${i + 1}`).join(',');
    const quoted = names.map(n => `"${n}"`).join(',');

    const rows = await query(
      `INSERT INTO scheduled_posts(${quoted})
       VALUES(${placeholders})
       RETURNING id`,
      params
    );

    return rows?.[0]?.id || null;
  }

  publishDraftNow = async function lrPublishDraftNowDbSaveV15(draft, key) {
    if (!draft.campaignId) {
      draft.campaignId = `lr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    }

    if (draft.isAd && !draft.autoDeleteMinutes) {
      draft.autoDeleteMinutes = 2880;
    }

    const results = [];
    const channels = await getChannelsByIds(draft.channelIds);

    for (const channel of channels) {
      let content = null;
      let messageId = null;
      let dbPostId = null;

      try {
        content = await composePostForChannel(draft, channel.id);

        const sent = await sendMaxMessage({
          chatId: channel.max_chat_id,
          ...content
        });

        messageId = extractMessageId(sent);
      } catch (sendError) {
        console.error('[LR_PUBLISHED_DB_SAVE_V15 send failed]', sendError?.message || sendError);

        results.push({
          ok: false,
          channel,
          error: sendError?.message || String(sendError)
        });

        continue;
      }

      try {
        dbPostId = await lrSavePublishedPostRowV15({
          draft,
          key,
          channel,
          content,
          messageId
        });

        console.log('[LR_PUBLISHED_DB_SAVE_V15 saved]', JSON.stringify({
          channelId: channel.id,
          postId: dbPostId,
          messageId
        }));
      } catch (dbError) {
        console.error('[LR_PUBLISHED_DB_SAVE_V15 db failed]', dbError?.message || dbError);

        // Пост уже вышел в канал, но если БД не сохранила — это важно видеть в логах.
        // Пользователю всё равно показываем публикацию успешной, чтобы не было ложной ошибки MAX API.
      }

      results.push({
        ok: true,
        channel,
        id: dbPostId,
        messageId
      });
    }

    return results;
  };

  console.log('[LR_PUBLISHED_DB_SAVE_V15] installed');
}
/* LR_PUBLISHED_DB_SAVE_V15_END */

/* LR_FINAL_ATTACHMENTS_SAFE_START */
function finalAttachments(draft) {
  const out = [];
  const seen = new Set();

  const src =
    Array.isArray(draft?.content?.attachments) ? draft.content.attachments :
    Array.isArray(draft?.attachments) ? draft.attachments :
    [];

  let normalized = src;

  try {
    if (typeof normalizeAttachments === 'function') {
      normalized = normalizeAttachments(src);
    }
  } catch (e) {
    console.error('[LR_FINAL_ATTACHMENTS_SAFE normalize]', e?.message || e);
  }

  for (const item of Array.isArray(normalized) ? normalized : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const type = String(
      item.type ||
      item.kind ||
      item.attachment_type ||
      item.attachmentType ||
      ''
    ).toLowerCase();

    if (type.includes('inline_keyboard')) continue;
    if (type.includes('keyboard')) continue;
    if (type.includes('button')) continue;
    if (type.includes('link_preview')) continue;
    if (type.includes('web_page')) continue;

    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(item);
  }

  const buttons = Array.isArray(draft?.buttons) ? draft.buttons : [];
  const rows = [];

  for (const item of buttons) {
    const row = Array.isArray(item) ? item : [item];
    const cleanRow = [];

    for (const b of row) {
      const text = String(b?.text || b?.title || b?.label || '').trim();
      const url = String(b?.url || b?.link || b?.href || '').trim();

      if (!text || !/^https?:\/\//i.test(url)) continue;

      if (typeof linkButton === 'function') {
        cleanRow.push(linkButton(text, url));
      }
    }

    if (cleanRow.length) rows.push(cleanRow);
  }

  if (rows.length && typeof inlineKeyboard === 'function') {
    const kb = inlineKeyboard(rows);
    if (Array.isArray(kb)) out.push(...kb);
    else if (kb) out.push(kb);
  }

  return out;
}
/* LR_FINAL_ATTACHMENTS_SAFE_END */

/* LR_NORMALIZE_ATTACHMENTS_SAFE_V1_START */
function normalizeAttachments(input) {
  const src = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();

  for (const item of src) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const type = String(
      item.type ||
      item.kind ||
      item.attachment_type ||
      item.attachmentType ||
      ''
    ).toLowerCase();

    // Клавиатуры/кнопки не должны попадать в поле attachments БД как обычные медиа.
    if (type.includes('inline_keyboard')) continue;
    if (type.includes('keyboard')) continue;
    if (type.includes('button')) continue;

    // link_preview/web_page иногда ломают повторную отправку через MAX body.
    // Их не сохраняем как media-attachments.
    if (type.includes('link_preview')) continue;
    if (type.includes('web_page')) continue;

    const clean = { ...item };
    const key = JSON.stringify(clean);

    if (seen.has(key)) continue;
    seen.add(key);

    out.push(clean);
  }

  return out;
}
/* LR_NORMALIZE_ATTACHMENTS_SAFE_V1_END */

