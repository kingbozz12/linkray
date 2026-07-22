/* LR_MAIN_MENU_PURCHASES_PROFILE_TEXT_V1 */
import { installLinkRayPurchases } from './linkrayPurchases.js';
import { installLinkRayProofReports } from './linkrayProofReports.js';
/* LR_PROFILE_SUPPORT_BUTTON_V1 */
import { startChannelTeamAccess, getProfileTeamAccess } from './channelTeamAccess.js';
import { startChannelAccessSync } from './channelAccessSync.js';
import { installLinkRayAdminPanel } from './adminPanel.js';
import 'dotenv/config';
import './maxTextFormatPatch.js';
import * as lrCrypto from 'node:crypto';
import { mountLinkRayChannelAnalytics, handleLinkRayChannelAnalyticsIncoming } from './linkrayChannelAnalytics.js';
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

/* LR_GENERATED_STATIC_V34_START */
try {
  app.use('/generated', express.static('public/generated', {
    maxAge: '10m',
    etag: false,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'public, max-age=600');
    },
  }));
} catch {}
/* LR_GENERATED_STATIC_V34_END */


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
    /* LR_ANALYTICS_NO_CACHE_V66 */
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
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


/* LR_PURCHASES_WEBHOOK_PRIORITY_V1 */
installLinkRayPurchases(app);

/* LR_CONTENT_PLAN_V51_START */
const lrV51ContentPlanCache = {
  tablesAt: 0,
  tables: null,
};

function lrV51Rows(result) {
  return Array.isArray(result) ? result : (result && Array.isArray(result.rows) ? result.rows : []);
}

function lrV51Esc(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(String(value ?? ''));
  } catch {}
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrV51Button(label, payload) {
  if (typeof callbackButton === 'function') return callbackButton(label, payload);
  return { text: String(label), callback: { payload: String(payload) } };
}

function lrV51Keyboard(rows) {
  const clean = (Array.isArray(rows) ? rows : [])
    .map(r => Array.isArray(r) ? r.filter(Boolean) : [])
    .filter(r => r.length);
  try {
    if (typeof inlineKeyboard === 'function') return inlineKeyboard(clean);
  } catch {}
  return clean;
}

async function lrV51Answer(callbackId, chatId, text, rows = []) {
  const cleanRows = (Array.isArray(rows) ? rows : [])
    .map(r => Array.isArray(r) ? r.filter(Boolean) : [])
    .filter(r => r.length);

  if (callbackId && typeof cb === 'function') {
    return cb(callbackId, String(text || 'LinkRay'), cleanRows, 'html');
  }

  if (callbackId && typeof answerCallback === 'function') {
    return answerCallback({
      callbackId,
      text: String(text || 'LinkRay'),
      format: 'html',
      attachments: cleanRows.length ? lrV51Keyboard(cleanRows) : []
    });
  }

  if (chatId && typeof msg === 'function') {
    return msg(chatId, String(text || 'LinkRay'), cleanRows, 'html');
  }

  if (chatId && typeof sendMaxMessage === 'function') {
    return sendMaxMessage({
      chatId,
      text: String(text || 'LinkRay'),
      format: 'html',
      attachments: cleanRows.length ? lrV51Keyboard(cleanRows) : []
    });
  }
}

function lrV51QuoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function lrV51Hash(value) {
  const text = String(value || '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function lrV51ToObj(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch {}
  }
  return null;
}

function lrV51DeepText(value, depth = 0) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth > 4) return '';

  if (Array.isArray(value)) {
    return value.map(v => lrV51DeepText(v, depth + 1)).filter(Boolean).join(' ');
  }

  if (typeof value === 'object') {
    const priority = [
      'text', 'caption', 'body', 'message', 'message_text', 'post_text',
      'content_text', 'html', 'raw', 'title', 'description', 'content',
      'payload', 'data'
    ];

    for (const key of priority) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
        const out = lrV51DeepText(value[key], depth + 1);
        if (out) return out;
      }
    }

    const parts = [];
    for (const key of Object.keys(value).slice(0, 16)) {
      if (/id|url|link|file|photo|video|image|attach|markup|button|keyboard/i.test(key)) continue;
      const out = lrV51DeepText(value[key], depth + 1);
      if (out) parts.push(out);
    }
    return parts.join(' ');
  }

  return '';
}

function lrV51CleanText(value, max = 64) {
  const text = lrV51DeepText(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const safe = text || 'пост';
  return safe.length > max ? safe.slice(0, max - 1).trim() + '…' : safe;
}

function lrV51DateKeyFromDate(d) {
  const local = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
}

function lrV51DateKey(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return lrV51DateKeyFromDate(d);
}

function lrV51Today() {
  return lrV51DateKeyFromDate(new Date());
}

function lrV51NowMs() {
  return Date.now();
}

function lrV51ShiftDay(day, diff) {
  const m = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) : new Date();
  d.setDate(d.getDate() + Number(diff || 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lrV51ShiftMonth(month, diff) {
  const m = String(month || '').match(/^(\d{4})-(\d{2})$/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1, 12, 0, 0) : new Date();
  d.setMonth(d.getMonth() + Number(diff || 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function lrV51HumanDay(day, compact = false) {
  const m = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) : new Date();
  return d.toLocaleDateString('ru-RU', {
    weekday: compact ? 'short' : 'short',
    day: 'numeric',
    month: compact ? 'short' : 'long',
    year: compact ? undefined : 'numeric',
    timeZone: 'Europe/Moscow'
  });
}

function lrV51HumanMonth(month) {
  const m = String(month || '').match(/^(\d{4})-(\d{2})$/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1, 12, 0, 0) : new Date();
  return d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
}

function lrV51Time(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}

function lrV51Bool(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  return /^(true|t|1|yes|y)$/i.test(String(value));
}

function lrV51StatusText(row) {
  return String(
    row.status ?? row.state ?? row.post_status ?? row.publication_status ??
    row.publish_status ?? row.kind ?? row.type ?? ''
  ).toLowerCase();
}

function lrV51IsPublished(row) {
  const status = lrV51StatusText(row);
  if (/(published|sent|done|posted|success|опублик|отправ|выпущ)/i.test(status)) return true;
  if (lrV51Bool(row.is_published) || lrV51Bool(row.published) || lrV51Bool(row.is_sent) || lrV51Bool(row.sent) || lrV51Bool(row.done)) return true;
  if (row.published_at || row.sent_at || row.posted_at || row.delivered_at || row.publication_at || row.fact_publish_at) return true;
  if (row.max_message_id || row.published_message_id || row.sent_message_id || row.message_id) {
    if (!/(draft|pending|scheduled|planned|queue|отлож|заплан)/i.test(status)) return true;
  }
  return false;
}

function lrV51PostDate(row) {
  if (lrV51IsPublished(row)) {
    return row.published_at || row.sent_at || row.posted_at || row.delivered_at ||
      row.publication_at || row.fact_publish_at || row.publish_at || row.scheduled_at ||
      row.schedule_at || row.planned_at || row.run_at || row.send_at || row.created_at || row.updated_at || '';
  }

  return row.publish_at || row.scheduled_at || row.schedule_at || row.planned_at ||
    row.run_at || row.send_at || row.publication_at || row.created_at || row.updated_at || '';
}

function lrV51IsScheduled(row) {
  if (lrV51IsPublished(row)) return false;
  const status = lrV51StatusText(row);
  if (/(scheduled|planned|pending|queue|wait|draft|deferred|отлож|заплан|ожид)/i.test(status)) return true;
  if (row.publish_at || row.scheduled_at || row.schedule_at || row.planned_at || row.run_at || row.send_at) return true;
  return false;
}

function lrV51PostTitle(row) {
  const data = lrV51ToObj(row.data) || lrV51ToObj(row.payload) || lrV51ToObj(row.content) || null;
  return lrV51CleanText(
    row.title ?? row.name ?? row.preview ?? row.text ?? row.message_text ?? row.caption ??
    row.body ?? row.content_text ?? row.post_text ?? row.html ?? row.raw ?? row.content ??
    row.payload ?? row.data ?? data ?? '',
    56
  );
}

function lrV51PostLong(row) {
  const data = lrV51ToObj(row.data) || lrV51ToObj(row.payload) || lrV51ToObj(row.content) || null;
  return lrV51CleanText(
    row.title ?? row.name ?? row.preview ?? row.text ?? row.message_text ?? row.caption ??
    row.body ?? row.content_text ?? row.post_text ?? row.html ?? row.raw ?? row.content ??
    row.payload ?? row.data ?? data ?? '',
    800
  );
}

function lrV51RowId(row) {
  return String(row.id ?? row.post_id ?? row.publication_id ?? row.message_id ?? row.uuid ?? row.uid ?? '');
}

function lrV51ChannelId(row) {
  const direct = row.channel_id ?? row.channelId ?? row.channel ?? row.chat_id ?? row.max_chat_id ??
    row.maxChatId ?? row.target_chat_id ?? row.targetChatId ?? row.channel_max_chat_id ?? '';
  if (direct) return String(direct);

  const data = lrV51ToObj(row.data) || lrV51ToObj(row.payload) || lrV51ToObj(row.content) || {};
  return String(
    data.channel_id ?? data.channelId ?? data.channel ?? data.chat_id ?? data.max_chat_id ??
    data.maxChatId ?? data.target_chat_id ?? data.targetChatId ?? ''
  );
}

function lrV51AutoDelete(row) {
  const v = row.auto_delete_minutes ?? row.autoDeleteMinutes ?? row.delete_after_minutes ??
    row.autodelete_minutes ?? row.auto_delete ?? row.autoDelete ?? row.delete_after ?? '';
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    if (n % 60 === 0) return `${n / 60}ч`;
    return `${n}м`;
  }
  return '';
}

function lrV51IsAd(row) {
  if (lrV51Bool(row.is_ad) || lrV51Bool(row.isAd) || lrV51Bool(row.ad) || lrV51Bool(row.is_cpm)) return true;
  if (row.cpm || row.cpm_price || row.price || row.cost) return true;
  return false;
}

async function lrV51LoadChannels() {
  const out = [];
  try {
    const rows = lrV51Rows(await query(`
      SELECT id, max_chat_id, title, link, is_active, updated_at
      FROM channels
      WHERE COALESCE(is_active,true)=true
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 80
    `));
    for (const r of rows) {
      out.push({
        id: String(r.id),
        max_chat_id: String(r.max_chat_id || ''),
        title: String(r.title || 'Канал'),
        link: r.link || ''
      });
    }
  } catch (e) {
    console.error('[v51 plan] load channels failed', e?.stack || e?.message || e);
  }
  return out;
}

function lrV51TableScore(t) {
  const name = String(t.name || '').toLowerCase();
  const cols = (t.cols || []).map(c => String(c).toLowerCase());

  if (/^(bot_sessions|lr_bot_state|channels|users|admins|settings|migrations|signatures|channel_signatures)$/i.test(t.name)) return -999;
  if (/(analytics|metric|stats|view|report|click|avatar|media_cache|log|state|session|signature|pending)/i.test(name)) return -120;

  let score = 0;
  if (/(^|_)(post|posts|publication|publications|queue|schedule|scheduled|creative|campaign|draft)(_|$)/i.test(name)) score += 45;
  if (/post|publication|queue|schedule|creative|campaign|draft/i.test(name)) score += 20;
  if (cols.some(c => /^(id|post_id|publication_id|uuid|uid)$/.test(c))) score += 8;
  if (cols.some(c => /(text|caption|content|body|title|message|payload|data|raw|html)/.test(c))) score += 25;
  if (cols.some(c => /(publish|schedule|planned|sent|posted|created|updated|run|send|delivered|publication).*at/.test(c))) score += 22;
  if (cols.some(c => /(status|state|published|sent|done|is_ad|cpm|auto_delete)/.test(c))) score += 14;
  if (cols.some(c => /(channel|chat|target).*id/.test(c))) score += 12;

  return score;
}

async function lrV51CandidateTables() {
  const now = Date.now();
  if (lrV51ContentPlanCache.tables && now - lrV51ContentPlanCache.tablesAt < 60000) {
    return lrV51ContentPlanCache.tables;
  }

  const rows = lrV51Rows(await query(`
    SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public'
    GROUP BY table_name
  `));

  const tables = rows.map(r => ({
    name: String(r.table_name || ''),
    cols: Array.isArray(r.cols) ? r.cols.map(String) : []
  }))
    .map(t => ({ ...t, score: lrV51TableScore(t) }))
    .filter(t => t.score >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  lrV51ContentPlanCache.tables = tables;
  lrV51ContentPlanCache.tablesAt = now;

  console.log('[v51 plan] candidate tables', JSON.stringify(tables.map(t => ({
    name: t.name,
    score: t.score,
    cols: t.cols.slice(0, 28)
  }))));

  return tables;
}

function lrV51OrderColumn(cols) {
  return (
    cols.find(c => /^updated_at$/i.test(c)) ||
    cols.find(c => /^published_at$/i.test(c)) ||
    cols.find(c => /^sent_at$/i.test(c)) ||
    cols.find(c => /^posted_at$/i.test(c)) ||
    cols.find(c => /^publish_at$/i.test(c)) ||
    cols.find(c => /^scheduled_at$/i.test(c)) ||
    cols.find(c => /^created_at$/i.test(c)) ||
    cols.find(c => /^id$/i.test(c)) ||
    cols[0]
  );
}

async function lrV51LoadPostsRaw() {
  const tables = await lrV51CandidateTables();
  const out = [];

  for (const t of tables) {
    try {
      const orderCol = lrV51OrderColumn(t.cols);
      const orderSql = orderCol ? ` ORDER BY ${lrV51QuoteIdent(orderCol)} DESC NULLS LAST` : '';
      const rows = lrV51Rows(await query(
        `SELECT row_to_json(x) AS row
         FROM (SELECT * FROM ${lrV51QuoteIdent(t.name)}${orderSql} LIMIT 700) x`
      ));

      for (const r of rows) {
        const row = r.row || r;
        if (!row || typeof row !== 'object') continue;
        row.__lrV51Table = t.name;
        row.__lrV51Score = t.score;
        out.push(row);
      }

      console.log('[v51 plan] loaded table', JSON.stringify({ table: t.name, count: rows.length }));
    } catch (e) {
      console.error('[v51 plan] table load failed', t.name, e?.message || e);
    }
  }

  return out;
}

function lrV51NormalizePosts(raw) {
  const out = [];
  const seen = new Set();

  for (const row of raw) {
    const date = lrV51PostDate(row);
    const day = lrV51DateKey(date);
    const title = lrV51PostTitle(row);
    const id = lrV51RowId(row);
    const channelId = lrV51ChannelId(row);
    const status = lrV51IsPublished(row) ? 'published' : (lrV51IsScheduled(row) ? 'scheduled' : 'draft');

    if (!day && status !== 'draft') continue;
    if (!id && !title) continue;
    if (title === 'пост' && !date) continue;

    const table = String(row.__lrV51Table || '');
    const virtualId = `${table}:${id || lrV51Hash(JSON.stringify(row).slice(0, 700))}`;
    const key = `${table}:${id || ''}:${channelId}:${day}:${lrV51Time(date)}:${status}:${title}`;

    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      ...row,
      __v51Id: virtualId,
      __v51Day: day,
      __v51Date: date,
      __v51Title: title,
      __v51Status: status,
      __v51ChannelId: channelId,
    });
  }

  out.sort((a, b) => {
    const at = new Date(a.__v51Date || 0).getTime() || 0;
    const bt = new Date(b.__v51Date || 0).getTime() || 0;
    return at - bt;
  });

  console.log('[v51 plan] normalized', JSON.stringify({
    total: out.length,
    sample: out.slice(0, 8).map(x => ({
      table: x.__lrV51Table,
      id: x.__v51Id,
      day: x.__v51Day,
      status: x.__v51Status,
      channel: x.__v51ChannelId,
      title: x.__v51Title
    }))
  }));

  return out;
}

/* LR_REAL_SCHEDULED_POSTS_ONLY_V2 */
async function lrV51LoadPosts() {
  /*
   * Контент-план использует только scheduled_posts.
   *
   * Таблицы рекламной аналитики, трекеры просмотров
   * и служебные записи не являются отложенными постами.
   */
  const result = await query(`
    SELECT
      post.*,

      channel.title
        AS lr_channel_title,

      channel.max_chat_id::text
        AS lr_channel_chat_id,

      channel.link
        AS lr_channel_link

    FROM public.scheduled_posts post

    LEFT JOIN public.channels channel
      ON channel.id=post.channel_id

    WHERE
      channel.id IS NULL

      OR COALESCE(
        channel.is_active,
        true
      )=true

    ORDER BY
      COALESCE(
        post.publish_at,
        post.published_at,
        post.created_at,
        post.updated_at
      ) DESC NULLS LAST,

      post.id DESC
  `);

  const sourceRows = Array.isArray(result)
    ? result
    : (
        Array.isArray(result?.rows)
          ? result.rows
          : []
      );

  const parseJson = (
    value,
    fallback
  ) => {
    if (
      value !== null &&
      typeof value === 'object'
    ) {
      return value;
    }

    try {
      return JSON.parse(
        String(value || '')
      );
    } catch {
      return fallback;
    }
  };

  const moscowDay = (value) => {
    if (!value) {
      return '';
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return '';
    }

    const parts =
      new Intl.DateTimeFormat(
        'ru-RU',
        {
          timeZone: 'Europe/Moscow',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }
      ).formatToParts(date);

    const values = {};

    for (const part of parts) {
      if (part.type !== 'literal') {
        values[part.type] =
          part.value;
      }
    }

    return [
      values.year,
      values.month,
      values.day,
    ].join('-');
  };

  const normalized = [];

  for (const row of sourceRows) {
    const status = String(
      row?.status ?? ''
    )
      .trim()
      .toLowerCase();

    /*
     * Служебные и отменённые задания
     * не должны отображаться как посты.
     */
    if (
      /draft|чернов|cancel|отмен|delete|удал|failed|ошиб/.test(
        status
      )
    ) {
      continue;
    }

    const published = Boolean(
      row?.published_at ||
      row?.published_message_id ||

      /published|sent|done|posted|success|опублик|отправ/.test(
        status
      )
    );

    const scheduled = Boolean(
      !published &&
      row?.publish_at
    );

    /*
     * Строка без даты публикации не является
     * элементом контент-плана.
     */
    if (!published && !scheduled) {
      continue;
    }

    const draft = parseJson(
      row?.draft,
      {}
    );

    const content = parseJson(
      draft?.content,
      {}
    );

    const text = String(
      row?.text ||
      row?.post_text ||
      content?.text ||
      draft?.text ||
      ''
    ).trim();

    const eventDate = published
      ? (
          row?.published_at ||
          row?.publish_at ||
          row?.created_at
        )
      : row?.publish_at;

    const channelTitle = String(
      row?.channel_title ||
      row?.lr_channel_title ||
      'Канал'
    ).trim();

    const channelChatId = String(
      row?.max_chat_id ||
      row?.lr_channel_chat_id ||
      ''
    ).trim();

    normalized.push({
      ...row,

      channel_title:
        channelTitle,

      max_chat_id:
        channelChatId,

      channel_link:
        row?.channel_link ||
        row?.lr_channel_link ||
        '',

      __v51Id:
        `scheduled_posts:${row.id}`,

      __v51RecordId:
        String(row.id),

      __v51Table:
        'scheduled_posts',

      __v51Source:
        'scheduled_posts',

      __v51ChannelId:
        String(
          row?.channel_id ||
          ''
        ),

      __v51ChannelTitle:
        channelTitle,

      __v51ChatId:
        channelChatId,

      __v51Date:
        eventDate,

      __v51Day:
        moscowDay(eventDate),

      __v51Status:
        published
          ? 'published'
          : 'scheduled',

      __v51Published:
        published,

      __v51Scheduled:
        scheduled,

      __v51Text:
        text,

      __v51Title:
        text || 'пост',
    });
  }

  console.log(
    '[real scheduled posts only]',
    JSON.stringify({
      databaseRows:
        sourceRows.length,

      visibleRows:
        normalized.length,

      scheduled:
        normalized.filter(
          (row) =>
            row.__v51Status ===
            'scheduled'
        ).length,

      published:
        normalized.filter(
          (row) =>
            row.__v51Status ===
            'published'
        ).length,
    })
  );

  return normalized;
}


function lrV51MatchesChannel(row, channelKey, channels) {
  if (!channelKey || channelKey === 'all') return true;

  const ch = channels.find(c => c.id === String(channelKey) || c.max_chat_id === String(channelKey));
  if (!ch) return false;

  const rowCh = String(row.__v51ChannelId || '');
  if (!rowCh) return true; // если старая запись без channel_id, показываем, чтобы пост не пропал

  return rowCh === ch.id || rowCh === ch.max_chat_id;
}

function lrV51ChannelTitle(row, channels) {
  const id = String(row.__v51ChannelId || '');
  const ch = channels.find(c => c.id === id || c.max_chat_id === id);
  return ch ? ch.title : '';
}

function lrV51FilterPosts(posts, channels, channelKey, filter, day) {
  const now = lrV51NowMs();
  let arr = posts.filter(p => lrV51MatchesChannel(p, channelKey, channels));

  if (filter === 'scheduled') {
    arr = arr.filter(p => p.__v51Status !== 'published');
    arr = arr.filter(p => {
      const t = new Date(p.__v51Date || 0).getTime() || 0;
      return !t || t >= now - 60000;
    });
  } else if (filter === 'published') {
    arr = arr.filter(p => p.__v51Status === 'published' && p.__v51Day === day);
  } else {
    arr = arr.filter(p => p.__v51Day === day);
  }

  arr.sort((a, b) => {
    const at = new Date(a.__v51Date || 0).getTime() || 0;
    const bt = new Date(b.__v51Date || 0).getTime() || 0;
    return filter === 'published' ? bt - at : at - bt;
  });

  return arr;
}

function lrV51CountForDay(posts, channels, channelKey, day) {
  const dayPosts = posts.filter(p => lrV51MatchesChannel(p, channelKey, channels) && p.__v51Day === day);
  const published = dayPosts.filter(p => p.__v51Status === 'published');
  const scheduled = dayPosts.filter(p => p.__v51Status !== 'published');
  return { dayPosts, published, scheduled };
}

function lrV51CountScheduledFuture(posts, channels, channelKey) {
  const now = lrV51NowMs();
  return posts.filter(p => lrV51MatchesChannel(p, channelKey, channels) && p.__v51Status !== 'published' && ((new Date(p.__v51Date || 0).getTime() || 0) >= now - 60000)).length;
}

function lrV51ChannelLabel(channelKey, channels) {
  if (!channelKey || channelKey === 'all') return 'Все каналы';
  const ch = channels.find(c => c.id === String(channelKey) || c.max_chat_id === String(channelKey));
  return ch ? ch.title : 'Канал';
}

function lrV51DateInRow(row, filter) {
  if (filter === 'scheduled') {
    return `${lrV51HumanDay(row.__v51Day, true)} ${lrV51Time(row.__v51Date)}`;
  }
  return lrV51Time(row.__v51Date);
}

function lrV51PostRowLabel(row, filter, channels) {
  const tags = [];

  // Наш стиль:
  // обычный опубликованный - без эмодзи;
  // рекламный - чемодан;
  // отложенный - песочные часы;
  // рекламный и отложенный - чемодан + песочные часы.
  if (lrV51IsAd(row)) tags.push('💼');
  if (row.__v51Status !== 'published') tags.push('⏳');

  const prefix = tags.length ? `${tags.join('')} ` : '';
  const media = '✏️ 🖼️';
  const del = lrV51AutoDelete(row) ? ` 🗑 ${lrV51AutoDelete(row)}` : '';
  const ch = filter !== 'scheduled' ? '' : (lrV51ChannelTitle(row, channels) ? ` · ${lrV51CleanText(lrV51ChannelTitle(row, channels), 18)}` : '');

  return `${prefix}${lrV51DateInRow(row, filter)} · ${media} · ${lrV51CleanText(row.__v51Title, 30)}${del}${ch}`;
}

function lrV51PayloadSafe(value) {
  return encodeURIComponent(String(value || ''));
}

function lrV51PayloadRead(value) {
  try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); }
}

async function lrV51SetState(key, state, data = {}) {
  if (!key || typeof setSession !== 'function') return;
  try {
    await setSession(key, state, { ...data, ts: Date.now() });
  } catch (e) {
    console.error('[v51 plan] set session failed', e?.message || e);
  }
}

async function lrV51ShowChannels(callbackId, chatId, key) {
  await lrV51SetState(key, 'content_plan_v51_channels', { mode: 'posts' });

  const channels = await lrV51LoadChannels();
  const rows = [];

  for (let i = 0; i < channels.length; i += 2) {
    const a = channels[i];
    const b = channels[i + 1];
    const row = [lrV51Button(lrV51CleanText(a.title, 24), `lr_plan_v51:view:${lrV51PayloadSafe(a.id)}:${lrV51Today()}:all:0`)];
    if (b) row.push(lrV51Button(lrV51CleanText(b.title, 24), `lr_plan_v51:view:${lrV51PayloadSafe(b.id)}:${lrV51Today()}:all:0`));
    rows.push(row);
  }

  rows.push([lrV51Button('📣 Все каналы', `lr_plan_v51:view:all:${lrV51Today()}:all:0`)]);
  rows.push([lrV51Button('⬅️ Назад', 'main:posting')]);

  const text =
    '━━━━━━━━━━━━━━\n' +
    '🗂 <b>Контент‑план LinkRay</b>\n\n' +
    'Здесь можно просматривать запланированные и опубликованные публикации.\n\n' +
    'Выберите канал для просмотра контент‑плана.\n' +
    '━━━━━━━━━━━━━━';

  console.log('[v51 plan] channels screen', JSON.stringify({ chatId, key, count: channels.length }));
  return lrV51Answer(callbackId, chatId, text, rows);
}

async function lrV51RenderList(callbackId, chatId, key, channelKey = 'all', day = lrV51Today(), filter = 'all', page = 0) {
  channelKey = lrV51PayloadRead(channelKey);
  day = day || lrV51Today();
  filter = filter || 'all';
  page = Math.max(0, Number(page || 0));

  await lrV51SetState(key, 'content_plan_v51_list', { channelKey, day, filter, page });

  const channels = await lrV51LoadChannels();
  const posts = await lrV51LoadPosts();

  const counts = lrV51CountForDay(posts, channels, channelKey, day);
  const scheduledFutureCount = lrV51CountScheduledFuture(posts, channels, channelKey);
  const visibleAll = lrV51FilterPosts(posts, channels, channelKey, filter, day);

  const perPage = filter === 'scheduled' ? 10 : 8;
  const start = page * perPage;
  const visible = visibleAll.slice(start, start + perPage);

  const title = lrV51ChannelLabel(channelKey, channels);
  const filterTitle =
    filter === 'scheduled' ? `📋 Всего запланировано: ${scheduledFutureCount}` :
    filter === 'published' ? `✅ ${counts.published.length} опубликовано` :
    `📋 Всего за день: ${counts.dayPosts.length} · ⏳ ${counts.scheduled.length} отложено · ✅ ${counts.published.length} опубликовано`;

  const text =
    '━━━━━━━━━━━━━━\n' +
    `📣 <b>${lrV51Esc(title)}</b>\n` +
    (filter === 'scheduled'
      ? `${filterTitle}\n`
      : `📅 ${lrV51Esc(lrV51HumanDay(day))}\n${filterTitle}\n`) +
    '━━━━━━━━━━━━━━';

  const rows = [];

  for (const row of visible) {
    rows.push([lrV51Button(lrV51PostRowLabel(row, filter, channels), `lr_plan_v51:open:${lrV51PayloadSafe(row.__v51Id)}:${lrV51PayloadSafe(channelKey)}:${day}:${filter}:${page}`)]);
  }

  if (!visible.length) {
    rows.push([lrV51Button('Постов нет', `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${day}:${filter}:${page}`)]);
  }

  rows.push([
    lrV51Button(`${filter === 'scheduled' ? '🟡' : ''} Отложенные`, `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${day}:scheduled:0`),
    lrV51Button(`${filter === 'published' ? '🟢' : ''} Опубликованные`, `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${day}:published:0`)
  ]);
  rows.push([lrV51Button('📋 Все посты', `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${day}:all:0`)]);
  rows.push([lrV51Button('📅 Развернуть календарь', `lr_plan_v51:calendar:${lrV51PayloadSafe(channelKey)}:${day.slice(0, 7)}:${filter}`)]);

  if (filter === 'scheduled') {
    if (start + perPage < visibleAll.length) rows.push([lrV51Button('⬇️ Ниже', `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${day}:${filter}:${page + 1}`)]);
    if (page > 0) rows.push([lrV51Button('⬆️ Выше', `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${day}:${filter}:${page - 1}`)]);
  } else {
    rows.push([
      lrV51Button('⬅️', `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${lrV51ShiftDay(day, -1)}:${filter}:0`),
      lrV51Button('Сегодня', `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${lrV51Today()}:${filter}:0`),
      lrV51Button('➡️', `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${lrV51ShiftDay(day, 1)}:${filter}:0`)
    ]);
  }

  rows.push([lrV51Button('⬅️ Назад', 'lr_plan_v51:channels')]);

  console.log('[v51 plan] rendered', JSON.stringify({
    chatId, key, channelKey, day, filter, page,
    visible: visible.length,
    totalVisible: visibleAll.length,
    dayTotal: counts.dayPosts.length,
    scheduledDay: counts.scheduled.length,
    publishedDay: counts.published.length,
    scheduledFutureCount
  }));

  return lrV51Answer(callbackId, chatId, text, rows);
}

async function lrV51RenderCalendar(callbackId, chatId, key, channelKey = 'all', month = '', filter = 'all') {
  channelKey = lrV51PayloadRead(channelKey);
  month = String(month || lrV51Today().slice(0, 7)).slice(0, 7);
  filter = filter || 'all';

  await lrV51SetState(key, 'content_plan_v51_calendar', { channelKey, month, filter });

  const channels = await lrV51LoadChannels();
  const posts = await lrV51LoadPosts();

  const m = month.match(/^(\d{4})-(\d{2})$/);
  const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1, 12, 0, 0) : new Date();
  const year = base.getFullYear();
  const mon = base.getMonth();
  const first = new Date(year, mon, 1, 12, 0, 0);
  const last = new Date(year, mon + 1, 0, 12, 0, 0);

  let startWeekday = first.getDay();
  if (startWeekday === 0) startWeekday = 7;

  const rows = [];
  rows.push([
    lrV51Button('⬅️', `lr_plan_v51:calendar:${lrV51PayloadSafe(channelKey)}:${lrV51ShiftMonth(month, -1)}:${filter}`),
    lrV51Button(lrV51HumanMonth(month), `lr_plan_v51:calendar:${lrV51PayloadSafe(channelKey)}:${month}:${filter}`),
    lrV51Button('➡️', `lr_plan_v51:calendar:${lrV51PayloadSafe(channelKey)}:${lrV51ShiftMonth(month, 1)}:${filter}`)
  ]);
  rows.push(['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x => lrV51Button(x, `lr_plan_v51:calendar:${lrV51PayloadSafe(channelKey)}:${month}:${filter}`)));

  let row = [];
  for (let i = 1; i < startWeekday; i += 1) row.push(lrV51Button('·', `lr_plan_v51:calendar:${lrV51PayloadSafe(channelKey)}:${month}:${filter}`));

  for (let d = 1; d <= last.getDate(); d += 1) {
    const day = `${year}-${String(mon + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const label = String(d);
    row.push(lrV51Button(day === lrV51Today() ? `•${label}•` : label, `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${day}:${filter}:0`));
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }

  if (row.length) {
    while (row.length < 7) row.push(lrV51Button('·', `lr_plan_v51:calendar:${lrV51PayloadSafe(channelKey)}:${month}:${filter}`));
    rows.push(row);
  }

  rows.push([lrV51Button('⬅️ К списку', `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${lrV51Today()}:${filter}:0`)]);

  const text =
    '━━━━━━━━━━━━━━\n' +
    '📅 <b>Календарь контент‑плана</b>\n\n' +
    `${lrV51Esc(lrV51ChannelLabel(channelKey, channels))}\n` +
    `${lrV51Esc(lrV51HumanMonth(month))}\n\n` +
    'Нажмите на любой день, чтобы открыть публикации за эту дату.\n' +
    '━━━━━━━━━━━━━━';

  console.log('[v51 plan] calendar', JSON.stringify({ chatId, key, channelKey, month, filter }));
  return lrV51Answer(callbackId, chatId, text, rows);
}

async function lrV51OpenPost(callbackId, chatId, key, virtualId, channelKey, day, filter, page) {
  channelKey = lrV51PayloadRead(channelKey);
  virtualId = lrV51PayloadRead(virtualId);

  await lrV51SetState(key, 'content_plan_v51_editor', { virtualId, channelKey, day, filter, page });

  const channels = await lrV51LoadChannels();
  const posts = await lrV51LoadPosts();
  const row = posts.find(p => p.__v51Id === virtualId);

  if (!row) {
    return lrV51Answer(callbackId, chatId,
      '━━━━━━━━━━━━━━\n⚠️ <b>Пост не найден</b>\n\nОн мог быть изменён или удалён.\n━━━━━━━━━━━━━━',
      [[lrV51Button('⬅️ Назад', `lr_plan_v51:view:${lrV51PayloadSafe(channelKey)}:${day || lrV51Today()}:${filter || 'all'}:${page || 0}`)]]
    );
  }

  const ch = lrV51ChannelTitle(row, channels) || lrV51ChannelLabel(channelKey, channels);
  const status = row.__v51Status === 'published' ? 'опубликован' : 'отложен';
  const ad = lrV51IsAd(row) ? 'да' : 'нет';
  const del = lrV51AutoDelete(row) || 'без удаления';
  const safeVirtualId = lrV51PayloadSafe(row.__v51Id);
  const safeChannelKey = lrV51PayloadSafe(channelKey);

  const text =
    '━━━━━━━━━━━━━━\n' +
    '🧬 <b>Редактор LinkRay</b>\n\n' +
    'Пост из контент‑плана открыт для редактирования.\n\n' +
    `📣 Канал: ${lrV51Esc(ch)}\n` +
    `📌 Статус: ${lrV51Esc(status)}\n` +
    `🕒 Время: ${lrV51Esc(lrV51HumanDay(row.__v51Day))} ${lrV51Esc(lrV51Time(row.__v51Date))}\n` +
    `🗑 Автоудаление: ${lrV51Esc(del)}\n` +
    `💼 Реклама: ${lrV51Esc(ad)}\n\n` +
    'Настройте пост и нажмите «Сохранить пост».\n' +
    '━━━━━━━━━━━━━━';

  const rows = [
    [
      lrV51Button('✏️ Изменить текст', `lr_plan_v51:edit_text:${safeVirtualId}:${safeChannelKey}:${day || row.__v51Day || lrV51Today()}:${filter || 'all'}:${page || 0}`),
      lrV51Button('🖼️ Медиа', `lr_plan_v51:edit_media:${safeVirtualId}:${safeChannelKey}:${day || row.__v51Day || lrV51Today()}:${filter || 'all'}:${page || 0}`)
    ],
    [
      lrV51Button('🔘 Добавить кнопку', `lr_plan_v51:edit_button:${safeVirtualId}:${safeChannelKey}:${day || row.__v51Day || lrV51Today()}:${filter || 'all'}:${page || 0}`),
      lrV51Button('🏷 Автоподпись', `lr_plan_v51:edit_signature:${safeVirtualId}:${safeChannelKey}:${day || row.__v51Day || lrV51Today()}:${filter || 'all'}:${page || 0}`)
    ],
    [lrV51Button('💼 Рекламный пост', `lr_plan_v51:edit_ad:${safeVirtualId}:${safeChannelKey}:${day || row.__v51Day || lrV51Today()}:${filter || 'all'}:${page || 0}`)],
    [lrV51Button('💾 Сохранить пост', `lr_plan_v51:save:${safeVirtualId}:${safeChannelKey}:${day || row.__v51Day || lrV51Today()}:${filter || 'all'}:${page || 0}`)],
    [
      lrV51Button('⬅️ К списку', `lr_plan_v51:view:${safeChannelKey}:${day || row.__v51Day || lrV51Today()}:${filter || 'all'}:${page || 0}`),
      lrV51Button('❌ Отмена', `lr_plan_v51:view:${safeChannelKey}:${day || row.__v51Day || lrV51Today()}:${filter || 'all'}:${page || 0}`)
    ]
  ];

  console.log('[v52 plan ui] post editor opened', JSON.stringify({
    chatId, key, id: row.__v51Id, status: row.__v51Status, isAd: lrV51IsAd(row)
  }));

  return lrV51Answer(callbackId, chatId, text, rows);
}

function lrV51IsPlanEntryPayload(payload) {
  const p = String(payload || '');
  return (
    p === 'post:all' ||
    p === 'posts:menu' ||
    p === 'posts:all' ||
    p === 'post:history' ||
    p === 'post:list' ||
    p === 'post:scheduled' ||
    p === 'post:published' ||
    p === 'post:posted'
  );
}

app.use(async function lrContentPlanV51Router(req, res, next) {
  try {
    if (req.method !== 'POST') return next();

    const update = req.body || {};
    const payload = String((typeof getCallbackPayload === 'function' ? getCallbackPayload(update) : '') || '');
    const callbackId = typeof getCallbackId === 'function' ? getCallbackId(update) : '';
    const chatId = typeof getChatId === 'function' ? getChatId(update) : '';
    const key = typeof getSessionKey === 'function' ? getSessionKey(update) : String(chatId || '');

    if (lrV51IsPlanEntryPayload(payload)) {
      if (payload === 'post:scheduled') {
        await lrV51RenderList(callbackId, chatId, key, 'all', lrV51Today(), 'scheduled', 0);
      } else if (payload === 'post:published' || payload === 'post:posted') {
        await lrV51RenderList(callbackId, chatId, key, 'all', lrV51Today(), 'published', 0);
      } else {
        await lrV51ShowChannels(callbackId, chatId, key);
      }
      return res.json({ ok: true, v51: true, entry: payload });
    }

    if (payload === 'lr_plan_v51:channels') {
      await lrV51ShowChannels(callbackId, chatId, key);
      return res.json({ ok: true, v51: true, channels: true });
    }

    if (payload.startsWith('lr_plan_v51:view:')) {
      const parts = payload.split(':');
      await lrV51RenderList(
        callbackId,
        chatId,
        key,
        parts[2] || 'all',
        parts[3] || lrV51Today(),
        parts[4] || 'all',
        parts[5] || 0
      );
      return res.json({ ok: true, v51: true, view: true });
    }

    if (payload.startsWith('lr_plan_v51:calendar:')) {
      const parts = payload.split(':');
      await lrV51RenderCalendar(
        callbackId,
        chatId,
        key,
        parts[2] || 'all',
        parts[3] || lrV51Today().slice(0, 7),
        parts[4] || 'all'
      );
      return res.json({ ok: true, v51: true, calendar: true });
    }


    if (payload.startsWith('lr_plan_v51:edit_text:')) {
      const parts = payload.split(':');
      await lrV51SetState(key, 'content_plan_v53_wait_text', {
        virtualId: lrV51PayloadRead(parts[2] || ''),
        channelKey: lrV51PayloadRead(parts[3] || 'all'),
        day: parts[4] || lrV51Today(),
        filter: parts[5] || 'all',
        page: parts[6] || 0
      });
      await lrV51Answer(callbackId, chatId,
        '━━━━━━━━━━━━━━\n✏️ <b>Изменить текст</b>\n\nОтправьте новый текст поста следующим сообщением.\nПосле отправки текст будет сохранён и редактор откроется снова.\n━━━━━━━━━━━━━━',
        [[lrV51Button('⬅️ К редактору', `lr_plan_v51:open:${parts[2] || ''}:${parts[3] || 'all'}:${parts[4] || lrV51Today()}:${parts[5] || 'all'}:${parts[6] || 0}`)]]
      );
      console.log('[v53 plan editor] wait text', JSON.stringify({ chatId, key, payload }));
      return res.json({ ok: true, v53: true, wait: 'text' });
    }

    if (payload.startsWith('lr_plan_v51:edit_media:')) {
      const parts = payload.split(':');
      await lrV51SetState(key, 'content_plan_v53_wait_media', {
        virtualId: lrV51PayloadRead(parts[2] || ''),
        channelKey: lrV51PayloadRead(parts[3] || 'all'),
        day: parts[4] || lrV51Today(),
        filter: parts[5] || 'all',
        page: parts[6] || 0
      });
      await lrV51Answer(callbackId, chatId,
        '━━━━━━━━━━━━━━\n🖼️ <b>Медиа</b>\n\nОтправьте новое фото, видео, файл или пост следующим сообщением.\nПосле отправки медиа будет сохранено и редактор откроется снова.\n━━━━━━━━━━━━━━',
        [[lrV51Button('⬅️ К редактору', `lr_plan_v51:open:${parts[2] || ''}:${parts[3] || 'all'}:${parts[4] || lrV51Today()}:${parts[5] || 'all'}:${parts[6] || 0}`)]]
      );
      console.log('[v53 plan editor] wait media', JSON.stringify({ chatId, key, payload }));
      return res.json({ ok: true, v53: true, wait: 'media' });
    }

    if (payload.startsWith('lr_plan_v51:edit_button:')) {
      const parts = payload.split(':');
      await lrV51SetState(key, 'content_plan_v53_wait_button', {
        virtualId: lrV51PayloadRead(parts[2] || ''),
        channelKey: lrV51PayloadRead(parts[3] || 'all'),
        day: parts[4] || lrV51Today(),
        filter: parts[5] || 'all',
        page: parts[6] || 0
      });
      await lrV51Answer(callbackId, chatId,
        '━━━━━━━━━━━━━━\n🔘 <b>Добавить кнопку</b>\n\nОтправьте название и ссылку двумя строками:\n\nКупить рекламу\nhttps://site.ru\n━━━━━━━━━━━━━━',
        [[lrV51Button('⬅️ К редактору', `lr_plan_v51:open:${parts[2] || ''}:${parts[3] || 'all'}:${parts[4] || lrV51Today()}:${parts[5] || 'all'}:${parts[6] || 0}`)]]
      );
      console.log('[v53 plan editor] wait button', JSON.stringify({ chatId, key, payload }));
      return res.json({ ok: true, v53: true, wait: 'button' });
    }

    if (payload.startsWith('lr_plan_v51:edit_signature:')) {
      const parts = payload.split(':');
      const virtualId = lrV51PayloadRead(parts[2] || '');
      const posts = await lrV51LoadPosts();
      const row = posts.find(p => p.__v51Id === virtualId);
      let result = { ok: false };
      if (row) result = await lrV53ToggleBoolean(row, ['signature_enabled','signatureEnabled','use_signature','with_signature','signature']);
      await lrV51Answer(callbackId, chatId,
        result.ok
          ? '━━━━━━━━━━━━━━\n✅ <b>Автоподпись переключена</b>\n\nИзменение сохранено.\n━━━━━━━━━━━━━━'
          : '━━━━━━━━━━━━━━\n⚠️ <b>Автоподпись</b>\n\nНе удалось найти поле автоподписи у этого поста.\n━━━━━━━━━━━━━━',
        [[lrV51Button('⬅️ К редактору', `lr_plan_v51:open:${parts[2] || ''}:${parts[3] || 'all'}:${parts[4] || lrV51Today()}:${parts[5] || 'all'}:${parts[6] || 0}`)]]
      );
      console.log('[v53 plan editor] signature toggle', JSON.stringify({ chatId, key, ok: result.ok, payload }));
      return res.json({ ok: true, v53: true, signature: result.ok });
    }

    if (payload.startsWith('lr_plan_v51:edit_ad:')) {
      const parts = payload.split(':');
      const virtualId = lrV51PayloadRead(parts[2] || '');
      const posts = await lrV51LoadPosts();
      const row = posts.find(p => p.__v51Id === virtualId);
      let result = { ok: false };
      if (row) result = await lrV53ToggleBoolean(row, ['is_ad','isAd','ad','is_advertising','advertising','promo']);
      await lrV51Answer(callbackId, chatId,
        result.ok
          ? '━━━━━━━━━━━━━━\n✅ <b>Рекламный режим переключён</b>\n\nИзменение сохранено.\n━━━━━━━━━━━━━━'
          : '━━━━━━━━━━━━━━\n⚠️ <b>Рекламный пост</b>\n\nНе удалось найти поле рекламы у этого поста.\n━━━━━━━━━━━━━━',
        [[lrV51Button('⬅️ К редактору', `lr_plan_v51:open:${parts[2] || ''}:${parts[3] || 'all'}:${parts[4] || lrV51Today()}:${parts[5] || 'all'}:${parts[6] || 0}`)]]
      );
      console.log('[v53 plan editor] ad toggle', JSON.stringify({ chatId, key, ok: result.ok, payload }));
      return res.json({ ok: true, v53: true, ad: result.ok });
    }


    if (payload.startsWith('lr_plan_v51:save:')) {
      const parts = payload.split(':');
      await lrV51Answer(
        callbackId,
        chatId,
        '━━━━━━━━━━━━━━\n✅ <b>Пост сохранён</b>\n\nИзменения сохранены в редакторе LinkRay.\n━━━━━━━━━━━━━━',
        [[lrV51Button('⬅️ К списку', `lr_plan_v51:view:${parts[3] || 'all'}:${parts[4] || lrV51Today()}:${parts[5] || 'all'}:${parts[6] || 0}`)]]
      );
      console.log('[v52 plan ui] save clicked', JSON.stringify({ chatId, key, payload }));
      return res.json({ ok: true, v52: true, save: true });
    }

    if (
      payload.startsWith('lr_plan_v51:edit_text:') ||
      payload.startsWith('lr_plan_v51:edit_media:') ||
      payload.startsWith('lr_plan_v51:edit_button:') ||
      payload.startsWith('lr_plan_v51:edit_signature:') ||
      payload.startsWith('lr_plan_v51:edit_ad:')
    ) {
      const parts = payload.split(':');
      const action = parts[1] || 'edit';
      await lrV51SetState(key, `content_plan_v51_${action}`, {
        virtualId: lrV51PayloadRead(parts[2] || ''),
        channelKey: lrV51PayloadRead(parts[3] || 'all'),
        day: parts[4] || lrV51Today(),
        filter: parts[5] || 'all',
        page: parts[6] || 0
      });
      await lrV51Answer(
        callbackId,
        chatId,
        '━━━━━━━━━━━━━━\n🧬 <b>Редактор LinkRay</b>\n\nЭтот пункт открыт из контент‑плана.\nНажмите «Сохранить пост» или вернитесь к списку.\n━━━━━━━━━━━━━━',
        [
          [lrV51Button('💾 Сохранить пост', `lr_plan_v51:save:${parts[2] || ''}:${parts[3] || 'all'}:${parts[4] || lrV51Today()}:${parts[5] || 'all'}:${parts[6] || 0}`)],
          [lrV51Button('⬅️ К списку', `lr_plan_v51:view:${parts[3] || 'all'}:${parts[4] || lrV51Today()}:${parts[5] || 'all'}:${parts[6] || 0}`)]
        ]
      );
      console.log('[v52 plan ui] editor action clicked', JSON.stringify({ chatId, key, action, payload }));
      return res.json({ ok: true, v52: true, editorAction: action });
    }

    if (payload.startsWith('lr_plan_v51:open:')) {
      const parts = payload.split(':');
      await lrV51OpenPost(
        callbackId,
        chatId,
        key,
        parts[2] || '',
        parts[3] || 'all',
        parts[4] || lrV51Today(),
        parts[5] || 'all',
        parts[6] || 0
      );
      return res.json({ ok: true, v51: true, open: true });
    }
  } catch (e) {
    console.error('[v51 plan] router failed', e?.stack || e?.message || e);
    try {
      if (!res.headersSent) return res.json({ ok: true, v51: true, error: String(e?.message || e) });
    } catch {}
  }

  return next();
});

console.log('[v51 plan] content plan router installed');

/* LR_PLAN_EDITOR_ACTIONS_V53_START */
function lrV53Rows(result) {
  return Array.isArray(result) ? result : (result && Array.isArray(result.rows) ? result.rows : []);
}

function lrV53Q(name) {
  return '"' + String(name || '').replace(/"/g, '""') + '"';
}

function lrV53PostNumericIds(row) {
  const ids = [];
  for (const v of [row?.id, row?.post_id, row?.postId, row?.publication_id, row?.publicationId, row?.queue_id, row?.queueId, row?.db_id, row?.dbId, row?.__v51DbId]) {
    const n = Number(String(v || '').replace(/\D+/g, ''));
    if (Number.isFinite(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  const tail = String(row?.__v51Id || '').match(/(\d+)(?!.*\d)/);
  if (tail) {
    const n = Number(tail[1]);
    if (Number.isFinite(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  return ids;
}

async function lrV53FindDbTarget(row) {
  if (typeof query !== 'function') return null;

  const ids = lrV53PostNumericIds(row);
  if (!ids.length) return null;

  const meta = lrV53Rows(await query(`
    SELECT table_schema, table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public'
    ORDER BY table_name, ordinal_position
  `));

  const byTable = new Map();
  for (const m of meta) {
    const k = `${m.table_schema}.${m.table_name}`;
    if (!byTable.has(k)) byTable.set(k, { schema: m.table_schema, table: m.table_name, cols: new Map() });
    byTable.get(k).cols.set(m.column_name, m.data_type);
  }

  const postish = /(post|publication|queue|schedule|campaign|creative|message)/i;
  for (const id of ids) {
    for (const t of byTable.values()) {
      if (!t.cols.has('id')) continue;
      if (!postish.test(t.table)) continue;

      try {
        const sql = `SELECT * FROM ${lrV53Q(t.schema)}.${lrV53Q(t.table)} WHERE id=$1 LIMIT 1`;
        const rows = lrV53Rows(await query(sql, [id]));
        if (rows.length) {
          return { schema: t.schema, table: t.table, id, cols: t.cols, row: rows[0] };
        }
      } catch (e) {}
    }
  }

  return null;
}

function lrV53TextFromUpdate(update) {
  try {
    return String(
      update?.message?.body?.text ??
      update?.message?.text ??
      update?.body?.text ??
      update?.content?.text ??
      update?.text ??
      ''
    ).trim();
  } catch {
    return '';
  }
}

async function lrV53HydrateContent(update) {
  try {
    if (typeof lrSafeHydrateContent === 'function') return await lrSafeHydrateContent(update);
  } catch (e) {
    console.error('[v53 plan editor] hydrate failed', e?.message || e);
  }

  const text = lrV53TextFromUpdate(update);
  const raw = update?.message || update;
  const attachments =
    update?.message?.body?.attachments ||
    update?.message?.attachments ||
    update?.body?.attachments ||
    update?.content?.attachments ||
    [];
  return {
    raw,
    text,
    format: 'html',
    markup: [],
    attachments: Array.isArray(attachments) ? attachments : []
  };
}

function lrV53PostTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 90 ? t.slice(0, 87) + '...' : (t || 'пост');
}

async function lrV53UpdateText(row, text) {
  const target = await lrV53FindDbTarget(row);
  if (!target) return { ok: false, reason: 'post target not found' };

  const cols = target.cols;
  const set = [];

  for (const c of ['text', 'caption', 'body', 'message_text', 'content_text', 'html', 'description']) {
    if (cols.has(c)) set.push(`${lrV53Q(c)}=$2`);
  }

  if (cols.has('title')) set.push(`${lrV53Q('title')}=$3`);

  if (cols.has('content')) {
    const type = String(cols.get('content') || '').toLowerCase();
    if (type.includes('json')) {
      set.push(`${lrV53Q('content')}=jsonb_set(COALESCE(${lrV53Q('content')}::jsonb, '{}'::jsonb), '{text}', to_jsonb($2::text), true)`);
    } else if (!set.length) {
      set.push(`${lrV53Q('content')}=$2`);
    }
  }

  if (cols.has('updated_at')) set.push(`${lrV53Q('updated_at')}=now()`);
  if (cols.has('edited_at')) set.push(`${lrV53Q('edited_at')}=now()`);

  if (!set.length) return { ok: false, reason: 'text columns not found', target };

  const sql = `UPDATE ${lrV53Q(target.schema)}.${lrV53Q(target.table)} SET ${set.join(', ')} WHERE id=$1`;
  await query(sql, [target.id, text, lrV53PostTitle(text)]);
  console.log('[v53 plan editor] text updated', JSON.stringify({ table: target.table, id: target.id }));
  return { ok: true, target };
}

async function lrV53UpdateContent(row, content) {
  const target = await lrV53FindDbTarget(row);
  if (!target) return { ok: false, reason: 'post target not found' };

  const cols = target.cols;
  const set = [];
  const params = [target.id, JSON.stringify(content), content?.text || ''];

  if (cols.has('raw')) {
    const type = String(cols.get('raw') || '').toLowerCase();
    set.push(type.includes('json') ? `${lrV53Q('raw')}=$2::jsonb` : `${lrV53Q('raw')}=$2`);
  }

  if (cols.has('attachments')) {
    const type = String(cols.get('attachments') || '').toLowerCase();
    const att = JSON.stringify(content?.attachments || []);
    params.push(att);
    set.push(type.includes('json') ? `${lrV53Q('attachments')}=$4::jsonb` : `${lrV53Q('attachments')}=$4`);
  }

  if (cols.has('content')) {
    const type = String(cols.get('content') || '').toLowerCase();
    set.push(type.includes('json') ? `${lrV53Q('content')}=$2::jsonb` : `${lrV53Q('content')}=$3`);
  }

  for (const c of ['text', 'caption', 'body', 'message_text']) {
    if (cols.has(c) && content?.text) set.push(`${lrV53Q(c)}=$3`);
  }

  if (cols.has('title') && content?.text) {
    params.push(lrV53PostTitle(content.text));
    set.push(`${lrV53Q('title')}=$${params.length}`);
  }

  if (cols.has('updated_at')) set.push(`${lrV53Q('updated_at')}=now()`);

  if (!set.length) return { ok: false, reason: 'content columns not found', target };

  const sql = `UPDATE ${lrV53Q(target.schema)}.${lrV53Q(target.table)} SET ${set.join(', ')} WHERE id=$1`;
  await query(sql, params);
  console.log('[v53 plan editor] content updated', JSON.stringify({ table: target.table, id: target.id }));
  return { ok: true, target };
}

function lrV53ParseButton(text) {
  const lines = String(text || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
  let title = '';
  let url = '';
  if (lines.length >= 2) {
    title = lines[0];
    url = lines[1];
  } else {
    const m = String(text || '').match(/(.+?)\s+(https?:\/\/\S+)/i);
    if (m) {
      title = m[1].trim();
      url = m[2].trim();
    }
  }
  if (!/^https?:\/\//i.test(url)) return null;
  return { title: title || 'Перейти', text: title || 'Перейти', url };
}

async function lrV53UpdateButtons(row, button) {
  const target = await lrV53FindDbTarget(row);
  if (!target) return { ok: false, reason: 'post target not found' };

  const cols = target.cols;
  const buttons = [button];
  const payload = JSON.stringify(buttons);
  const set = [];
  const params = [target.id, payload];

  for (const c of ['buttons', 'inline_buttons', 'keyboard', 'inline_keyboard']) {
    if (!cols.has(c)) continue;
    const type = String(cols.get(c) || '').toLowerCase();
    set.push(type.includes('json') ? `${lrV53Q(c)}=$2::jsonb` : `${lrV53Q(c)}=$2`);
  }

  if (cols.has('content')) {
    const type = String(cols.get('content') || '').toLowerCase();
    if (type.includes('json')) {
      set.push(`${lrV53Q('content')}=jsonb_set(COALESCE(${lrV53Q('content')}::jsonb, '{}'::jsonb), '{buttons}', $2::jsonb, true)`);
    }
  }

  if (cols.has('updated_at')) set.push(`${lrV53Q('updated_at')}=now()`);

  if (!set.length) return { ok: false, reason: 'button columns not found', target };

  const sql = `UPDATE ${lrV53Q(target.schema)}.${lrV53Q(target.table)} SET ${set.join(', ')} WHERE id=$1`;
  await query(sql, params);
  console.log('[v53 plan editor] button updated', JSON.stringify({ table: target.table, id: target.id }));
  return { ok: true, target };
}

async function lrV53ToggleBoolean(row, names) {
  const target = await lrV53FindDbTarget(row);
  if (!target) return { ok: false, reason: 'post target not found' };

  const cols = target.cols;
  const col = names.find(c => cols.has(c));
  if (!col) return { ok: false, reason: 'column not found', target };

  const set = [`${lrV53Q(col)} = NOT COALESCE(${lrV53Q(col)}, false)`];
  if (cols.has('updated_at')) set.push(`${lrV53Q('updated_at')}=now()`);

  const sql = `UPDATE ${lrV53Q(target.schema)}.${lrV53Q(target.table)} SET ${set.join(', ')} WHERE id=$1`;
  await query(sql, [target.id]);
  console.log('[v53 plan editor] boolean toggled', JSON.stringify({ table: target.table, id: target.id, col }));
  return { ok: true, target, col };
}

async function lrV53ReopenPlanEditor(chatId, key, ctx, note) {
  const virtualId = ctx?.virtualId || '';
  const channelKey = ctx?.channelKey || 'all';
  const day = ctx?.day || lrV51Today();
  const filter = ctx?.filter || 'all';
  const page = ctx?.page || 0;

  if (note && typeof msg === 'function') {
    await msg(chatId, note, [], 'html').catch(e => console.error('[v53 plan editor] note failed', e?.message || e));
  }

  if (typeof lrV51OpenPost === 'function') {
    return lrV51OpenPost(null, chatId, key, virtualId, channelKey, day, filter, page);
  }
}

async function lrV53PlanEditorInput(update) {
  const type = typeof getUpdateType === 'function' ? getUpdateType(update) : (update?.update_type || update?.type || '');
  if (String(type) !== 'message_created') return false;

  const chatId = typeof getChatId === 'function' ? getChatId(update) : (update?.chat_id || update?.chatId || update?.message?.recipient?.chat_id || update?.message?.chat_id);
  const key = typeof getSessionKey === 'function' ? getSessionKey(update) : String(chatId || '');
  if (!chatId || !key || typeof getSession !== 'function') return false;

  const session = await getSession(key).catch(() => null);
  const state = String(session?.state || '');
  if (!state.startsWith('content_plan_v53_wait_')) return false;

  const data = session?.data || {};
  const ctx = {
    virtualId: data.virtualId || '',
    channelKey: data.channelKey || 'all',
    day: data.day || lrV51Today(),
    filter: data.filter || 'all',
    page: data.page || 0
  };

  const posts = await lrV51LoadPosts();
  const row = posts.find(p => p.__v51Id === ctx.virtualId);
  if (!row) {
    if (typeof clearSession === 'function') await clearSession(key).catch(()=>{});
    await msg(chatId, '⚠️ Пост не найден. Откройте список постов заново.', [[lrV51Button('⬅️ К списку', `lr_plan_v51:view:${lrV51PayloadSafe(ctx.channelKey)}:${ctx.day}:${ctx.filter}:${ctx.page}`)]], 'html').catch(()=>{});
    return true;
  }

  try {
    if (state === 'content_plan_v53_wait_text') {
      const text = lrV53TextFromUpdate(update);
      if (!text) {
        await msg(chatId, '⚠️ Отправьте новый текст поста обычным сообщением.', [], 'html').catch(()=>{});
        return true;
      }
      const r = await lrV53UpdateText(row, text);
      if (typeof clearSession === 'function') await clearSession(key).catch(()=>{});
      await lrV53ReopenPlanEditor(chatId, key, ctx, r.ok ? '✅ Текст поста обновлён.' : '⚠️ Не удалось обновить текст в базе. Нужна проверка структуры таблицы постов.');
      return true;
    }

    if (state === 'content_plan_v53_wait_media') {
      const content = await lrV53HydrateContent(update);
      const r = await lrV53UpdateContent(row, content);
      if (typeof clearSession === 'function') await clearSession(key).catch(()=>{});
      await lrV53ReopenPlanEditor(chatId, key, ctx, r.ok ? '✅ Медиа/контент поста обновлены.' : '⚠️ Не удалось обновить медиа в базе. Нужна проверка структуры таблицы постов.');
      return true;
    }

    if (state === 'content_plan_v53_wait_button') {
      const text = lrV53TextFromUpdate(update);
      const button = lrV53ParseButton(text);
      if (!button) {
        await msg(chatId, '⚠️ Отправьте кнопку так:\n\nНазвание кнопки\nhttps://site.ru', [], 'html').catch(()=>{});
        return true;
      }
      const r = await lrV53UpdateButtons(row, button);
      if (typeof clearSession === 'function') await clearSession(key).catch(()=>{});
      await lrV53ReopenPlanEditor(chatId, key, ctx, r.ok ? '✅ Кнопка поста обновлена.' : '⚠️ Не удалось сохранить кнопку в базе. Нужна проверка структуры таблицы постов.');
      return true;
    }
  } catch (e) {
    console.error('[v53 plan editor] input failed', e?.stack || e?.message || e);
    await msg(chatId, '❌ Ошибка при сохранении изменений поста. Скиньте логи v53 plan editor.', [], 'html').catch(()=>{});
    return true;
  }

  return false;
}

try {
  if (typeof handleMessage === 'function' && !handleMessage.__lrV53PlanEditorWrapped) {
    const __lrV53OldHandleMessage = handleMessage;
    handleMessage = async function lrV53PlanEditorHandleMessage(update) {
      if (await lrV53PlanEditorInput(update)) return true;
      return __lrV53OldHandleMessage(update);
    };
    handleMessage.__lrV53PlanEditorWrapped = true;
  }
} catch (e) {
  console.error('[v53 plan editor] handleMessage wrap failed', e?.stack || e?.message || e);
}

console.log('[v53 plan editor] installed: edit buttons now have actions');
/* LR_PLAN_EDITOR_ACTIONS_V53_END */

/* LR_CONTENT_PLAN_UI_V52_START */
console.log('[v52 plan ui] installed: calendar clean, post emojis, editor menu');
/* LR_CONTENT_PLAN_UI_V52_END */
/* LR_CONTENT_PLAN_V51_END */


// LR_FORCE_START_MENU_V7_START
function __lrForceMainMenuTextV7() { return `━━━━━━━━━━━━━━
⚡ LinkRay

🚀 LinkRay Studio
Создание постов, очередь публикаций и рекламные выходы.

📊 Аналитика
PNG-карточки каналов, графики, просмотры и ежедневный отчёт ПДП.

➕ Добавить канал
Подключение MAX-канала к LinkRay.

🚀 Закупы
Создание и контроль рекламных закупов, сроков, просмотров и стоимости.

🛡 Антифрод
Проверка качества трафика и подозрительных скачков.

👤 Профиль
LinkRay ID, тариф, подключённые каналы и поддержка.

Выберите нужный раздел.
━━━━━━━━━━━━━━`; }

function __lrForceMainMenuRowsV7() {
  return [
    [callbackButton('🚀 LinkRay Studio', 'main:posting')],
    [callbackButton('📊 Аналитика', 'main:analytics')],
    [callbackButton('➕ Добавить канал', 'post:add_channel')],
    [
      callbackButton('🚀 Закупы', 'reports:menu'),
      callbackButton('🛡 Антифрод', 'fraud:menu')
    ],
 [callbackButton('👤 Профиль', 'main:profile')],
 ];
}

function __lrForceMenuAttachmentsV7(rows) {
  if (typeof inlineKeyboard === 'function') return inlineKeyboard(rows);
  if (typeof buttonRows === 'function') return buttonRows(rows);
  return rows;
}

/* LR_USER_PROFILE_V1_START */

let __lrProfileSchemaPromise = null;

function lrProfileRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

function lrProfileClean(value, max = 500) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.slice(0, max);
}

function lrProfileEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrProfilePayload(update) {
  try {
    if (typeof getCallbackPayload === 'function') {
      return lrProfileClean(
        getCallbackPayload(update),
        300
      );
    }
  } catch {}

  return lrProfileClean(
    update?.callback?.payload ||
    update?.callback?.data ||
    update?.callback_payload ||
    update?.payload ||
    update?.message_callback?.payload ||
    '',
    300
  );
}

function lrProfileMessageText(update) {
  try {
    if (typeof getMessageText === 'function') {
      return lrProfileClean(
        getMessageText(update),
        1000
      );
    }
  } catch {}

  return lrProfileClean(
    update?.message?.body?.text ||
    update?.message?.text ||
    update?.body?.text ||
    update?.text ||
    '',
    1000
  );
}

function lrProfileCallbackId(update) {
  try {
    if (typeof getCallbackId === 'function') {
      return lrProfileClean(
        getCallbackId(update),
        300
      );
    }
  } catch {}

  return lrProfileClean(
    update?.callback?.callback_id ||
    update?.callback?.callbackId ||
    update?.callback?.id ||
    update?.message_callback?.callback_id ||
    '',
    300
  );
}

/* LR_PROFILE_HUMAN_USER_V2 */

function lrProfileHumanCandidates(update) {
  return [
    update?.callback?.user,
    update?.message_callback?.user,
    update?.message_callback?.callback?.user,
    update?.user,
    update?.message?.sender,
    update?.sender,
    update?.body?.user,
    update?.message?.body?.user,
    update?.callback?.message?.sender,
  ].filter(
    (value) =>
      value &&
      typeof value === 'object'
  );
}

function lrProfileCandidateId(candidate) {
  return lrProfileClean(
    candidate?.user_id ||
    candidate?.userId ||
    candidate?.id ||
    '',
    100
  );
}

function lrProfileIsHuman(candidate) {
  const id = lrProfileCandidateId(candidate);

  if (!/^\d+$/.test(id)) {
    return false;
  }

  if (
    candidate?.is_bot === true ||
    candidate?.isBot === true
  ) {
    return false;
  }

  const username = lrProfileClean(
    candidate?.username ||
    candidate?.login ||
    '',
    200
  ).toLowerCase();

  if (username.endsWith('_bot')) {
    return false;
  }

  return true;
}

function lrProfileMaxUserId(update) {
  for (
    const candidate
    of lrProfileHumanCandidates(update)
  ) {
    if (lrProfileIsHuman(candidate)) {
      return lrProfileCandidateId(candidate);
    }
  }

  const scalarCandidates = [
    update?.callback?.user_id,
    update?.callback?.userId,
    update?.message_callback?.user_id,
    update?.message_callback?.userId,
    update?.user_id,
    update?.userId,
    update?.body?.user_id,
    update?.body?.userId,
  ];

  for (const value of scalarCandidates) {
    const id = lrProfileClean(value, 100);

    if (/^\d+$/.test(id)) {
      return id;
    }
  }

  return '';
}

function lrProfileUserBox(update, maxUserId) {
  const expectedId = lrProfileClean(
    maxUserId,
    100
  );

  for (
    const candidate
    of lrProfileHumanCandidates(update)
  ) {
    if (
      lrProfileIsHuman(candidate) &&
      lrProfileCandidateId(candidate) === expectedId
    ) {
      return candidate;
    }
  }

  return {};
}

function lrProfilePrivateChatId(update, maxUserId) {
  try {
    if (typeof getChatId === 'function') {
      const value = lrProfileClean(
        getChatId(update),
        100
      );

      if (value && !value.startsWith('-')) {
        return value;
      }
    }
  } catch {}

  return maxUserId;
}

async function lrProfileEnsureSchema() {
  if (__lrProfileSchemaPromise) {
    return __lrProfileSchemaPromise;
  }

  __lrProfileSchemaPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS public.lr_tariffs (
        code text PRIMARY KEY,
        title text NOT NULL,
        description text,
        price_rub numeric(12,2) NOT NULL DEFAULT 0,
        duration_days integer,
        is_free boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await query(`
      INSERT INTO public.lr_tariffs (
        code,
        title,
        description,
        price_rub,
        duration_days,
        is_free,
        is_active,
        sort_order
      )
      VALUES (
        'free',
        'Бесплатный',
        'Бесплатный доступ к LinkRay',
        0,
        NULL,
        true,
        true,
        1
      )
      ON CONFLICT (code) DO UPDATE SET
        title=EXCLUDED.title,
        description=EXCLUDED.description,
        price_rub=EXCLUDED.price_rub,
        duration_days=EXCLUDED.duration_days,
        is_free=EXCLUDED.is_free,
        is_active=EXCLUDED.is_active,
        updated_at=now()
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS public.lr_users (
        id bigserial PRIMARY KEY,
        max_user_id text NOT NULL UNIQUE,
        private_chat_id text,
        first_name text,
        last_name text,
        display_name text,
        username text,
        language_code text,
        is_blocked boolean NOT NULL DEFAULT false,
        registered_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        updates_count bigint NOT NULL DEFAULT 1,
        raw_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
        lr_users_last_seen_idx
      ON public.lr_users(last_seen_at DESC)
    `);

    /* LR_PUBLIC_PROFILE_NUMBER_V1 */

    await query(`
      ALTER TABLE public.lr_users
      ADD COLUMN IF NOT EXISTS profile_number bigint
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_profile_migrations (
          key text PRIMARY KEY,
          completed_by_user_id bigint,
          completed_at timestamptz
            NOT NULL DEFAULT now()
        )
    `);

    /*
     * Один раз перенумеровываем только настоящих
     * пользователей по порядку регистрации.
     */
    await query(`
      DO $lr_public_numbers$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM public.lr_profile_migrations
          WHERE key='public_profile_numbers_v1'
        ) THEN

          UPDATE public.lr_users
          SET profile_number=NULL
          WHERE max_user_id ~ '^[0-9]+$'
            AND COALESCE(
              raw_profile->>'is_bot',
              'false'
            )<>'true'
            AND RIGHT(
              LOWER(COALESCE(username, '')),
              4
            )<>'_bot'
            AND LOWER(
              COALESCE(display_name, '')
            ) NOT LIKE 'linkray%';

          WITH numbered AS (
            SELECT
              id,
              ROW_NUMBER() OVER (
                ORDER BY
                  registered_at ASC,
                  id ASC
              )::bigint AS public_number
            FROM public.lr_users
            WHERE max_user_id ~ '^[0-9]+$'
              AND COALESCE(
                raw_profile->>'is_bot',
                'false'
              )<>'true'
              AND RIGHT(
                LOWER(COALESCE(username, '')),
                4
              )<>'_bot'
              AND LOWER(
                COALESCE(display_name, '')
              ) NOT LIKE 'linkray%'
          )
          UPDATE public.lr_users users
          SET profile_number=numbered.public_number
          FROM numbered
          WHERE users.id=numbered.id;

          INSERT INTO public.lr_profile_migrations (
            key,
            completed_at
          )
          VALUES (
            'public_profile_numbers_v1',
            now()
          )
          ON CONFLICT (key) DO NOTHING;
        END IF;
      END
      $lr_public_numbers$;
    `);

    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        lr_users_profile_number_unique_idx
      ON public.lr_users(profile_number)
      WHERE profile_number IS NOT NULL
    `);

    /*
     * Транзакционный счётчик не расходует номер,
     * когда пользователь уже существует.
     */
    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_profile_number_counter (
          id smallint PRIMARY KEY
            CHECK (id=1),
          last_value bigint NOT NULL DEFAULT 0,
          updated_at timestamptz
            NOT NULL DEFAULT now()
        )
    `);

    await query(`
      INSERT INTO public.lr_profile_number_counter (
        id,
        last_value,
        updated_at
      )
      VALUES (
        1,
        COALESCE(
          (
            SELECT MAX(profile_number)
            FROM public.lr_users
          ),
          0
        ),
        now()
      )
      ON CONFLICT (id) DO UPDATE SET
        last_value=GREATEST(
          public.lr_profile_number_counter.last_value,
          EXCLUDED.last_value
        ),
        updated_at=now()
    `);

    await query(`
      CREATE OR REPLACE FUNCTION
        public.lr_assign_public_profile_number()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $lr_function$
      DECLARE
        next_number bigint;
      BEGIN
        IF NEW.profile_number IS NOT NULL THEN
          RETURN NEW;
        END IF;

        IF COALESCE(
          NEW.raw_profile->>'is_bot',
          'false'
        )='true' THEN
          RETURN NEW;
        END IF;

        IF RIGHT(
          LOWER(COALESCE(NEW.username, '')),
          4
        )='_bot' THEN
          RETURN NEW;
        END IF;

        IF LOWER(
          COALESCE(NEW.display_name, '')
        ) LIKE 'linkray%' THEN
          RETURN NEW;
        END IF;

        INSERT INTO public.lr_profile_number_counter (
          id,
          last_value,
          updated_at
        )
        VALUES (1, 0, now())
        ON CONFLICT (id) DO NOTHING;

        UPDATE public.lr_profile_number_counter
        SET
          last_value=last_value + 1,
          updated_at=now()
        WHERE id=1
        RETURNING last_value
        INTO next_number;

        UPDATE public.lr_users
        SET
          profile_number=next_number,
          updated_at=now()
        WHERE id=NEW.id
          AND profile_number IS NULL;

        RETURN NEW;
      END;
      $lr_function$
    `);

    await query(`
      DROP TRIGGER IF EXISTS
        lr_users_assign_public_number_trigger
      ON public.lr_users
    `);

    await query(`
      CREATE TRIGGER
        lr_users_assign_public_number_trigger
      AFTER INSERT
      ON public.lr_users
      FOR EACH ROW
      EXECUTE FUNCTION
        public.lr_assign_public_profile_number()
    `);


    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_user_subscriptions (
          id bigserial PRIMARY KEY,
          user_id bigint NOT NULL
            REFERENCES public.lr_users(id)
            ON DELETE CASCADE,
          tariff_code text NOT NULL
            REFERENCES public.lr_tariffs(code),
          status text NOT NULL DEFAULT 'active',
          starts_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz,
          auto_renew boolean NOT NULL DEFAULT false,
          payment_provider text,
          external_payment_id text,
          source text NOT NULL DEFAULT 'registration',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
    `);

    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        lr_user_one_active_subscription_idx
      ON public.lr_user_subscriptions(user_id)
      WHERE status='active'
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS
        public.lr_user_channels (
          user_id bigint NOT NULL
            REFERENCES public.lr_users(id)
            ON DELETE CASCADE,
          channel_id integer NOT NULL
            REFERENCES public.channels(id)
            ON DELETE CASCADE,
          linked_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, channel_id)
        )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS
        lr_user_channels_channel_idx
      ON public.lr_user_channels(channel_id)
    `);
  })().catch((error) => {
    __lrProfileSchemaPromise = null;
    throw error;
  });

  return __lrProfileSchemaPromise;
}

async function lrProfileTouch(update) {
/* LR_SKIP_CHANNEL_USER_REGISTRATION_V3 */
  const __lrEventTypeV3 = String(
    update?.update_type ||
    update?.type ||
    update?.event_type ||
    update?.event?.type ||
    update?.body?.update_type ||
    update?.body?.type ||
    ''
  ).trim().toLowerCase();

  const __lrChannelEventV3 = [
    'user_added',
    'user_removed',
    'bot_added',
    'bot_removed',
    'chat_title_changed',
    'chat_created',
    'chat_deleted',
    'message_removed',
  ].includes(__lrEventTypeV3);

  const __lrChannelContextV3 = Boolean(
    update?.is_channel === true ||
    update?.chat?.type === 'channel' ||
    update?.message?.recipient?.chat_type === 'channel' ||
    update?.body?.message?.recipient?.chat_type === 'channel'
  );

  if (__lrChannelEventV3 || __lrChannelContextV3) {
    return null;
  }

/* LR_PROFILE_SKIP_CHANNEL_EVENTS_FINAL_V1 */
  const __lrProfileEventTypeFinalV1 = String(
    update?.update_type ||
    update?.type ||
    update?.event_type ||
    update?.event?.type ||
    update?.body?.update_type ||
    update?.body?.type ||
    ''
  ).trim().toLowerCase();

  const __lrProfileChannelEventFinalV1 = [
    'user_added',
    'user_removed',
    'bot_added',
    'bot_removed',
    'chat_title_changed',
    'chat_created',
    'chat_deleted',
    'message_removed',
  ].includes(__lrProfileEventTypeFinalV1);

  const __lrProfileChannelContextFinalV1 = Boolean(
    update?.is_channel === true ||
    update?.chat?.type === 'channel' ||
    update?.message?.recipient?.chat_type === 'channel' ||
    update?.body?.message?.recipient?.chat_type === 'channel'
  );

  if (
    __lrProfileChannelEventFinalV1 ||
    __lrProfileChannelContextFinalV1
  ) {
    return null;
  }

  /* LR_VERIFIED_USER_REGISTRATION_V1 */

  const maxUserId = lrProfileClean(
    lrProfileMaxUserId(update),
    100
  );

  if (!/^\d+$/.test(maxUserId)) {
    return null;
  }

  await lrProfileEnsureSchema();

  /*
   * Сначала проверяем, существует ли пользователь.
   * Уже зарегистрированный профиль можно использовать
   * даже при неполном callback без имени.
   */
  const existingUser = lrProfileRows(await query(`
    SELECT *
    FROM public.lr_users
    WHERE max_user_id=$1
    LIMIT 1
  `, [maxUserId]))[0] || null;

  const userBox = lrProfileUserBox(
    update,
    maxUserId
  );

  const boxUserId = lrProfileClean(
    userBox?.user_id ||
    userBox?.userId ||
    userBox?.id ||
    '',
    100
  );

  const isBot = Boolean(
    userBox?.is_bot === true ||
    userBox?.isBot === true
  );

  const firstName = lrProfileClean(
    userBox?.first_name ||
    userBox?.firstName ||
    '',
    200
  );

  const lastName = lrProfileClean(
    userBox?.last_name ||
    userBox?.lastName ||
    '',
    200
  );

  const explicitName = lrProfileClean(
    userBox?.display_name ||
    userBox?.displayName ||
    userBox?.name ||
    '',
    300
  );

  const displayName =
    explicitName ||
    [firstName, lastName]
      .filter(Boolean)
      .join(' ');

  const normalizedName = displayName
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const hasRealName = Boolean(
    displayName &&
    normalizedName !== 'пользователь max' &&
    !normalizedName.startsWith('linkray')
  );

  const verifiedUserObject =
    boxUserId === maxUserId &&
    !isBot &&
    hasRealName;

  /*
   * Главное исправление:
   * неполное событие больше не создаёт новый профиль.
   */
  if (!verifiedUserObject) {
    if (!existingUser) {
      console.log(
        '[LR profile] skipped incomplete user',
        JSON.stringify({
          maxUserId,
          hasUserObject:
            Boolean(
              userBox &&
              Object.keys(userBox).length
            ),
          boxUserId,
          hasRealName,
          isBot,
        })
      );
    }

    return existingUser;
  }

  const username = lrProfileClean(
    userBox?.username ||
    userBox?.login ||
    '',
    200
  ).replace(/^@+/, '');

  const languageCode = lrProfileClean(
    userBox?.language_code ||
    userBox?.languageCode ||
    '',
    30
  );

  const privateChatId = lrProfileClean(
    lrProfilePrivateChatId(
      update,
      maxUserId
    ),
    100
  );

  const safeRaw = {
    user_id: maxUserId,
    first_name: firstName || null,
    last_name: lastName || null,
    display_name: displayName,
    username: username || null,
    language_code: languageCode || null,
    is_bot: false,
    verified: true,
  };

  const users = lrProfileRows(await query(`
    INSERT INTO public.lr_users (
      max_user_id,
      private_chat_id,
      first_name,
      last_name,
      display_name,
      username,
      language_code,
      last_seen_at,
      updates_count,
      raw_profile,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      now(),
      1,
      $8::jsonb,
      now()
    )

    ON CONFLICT (max_user_id) DO UPDATE SET
      private_chat_id=COALESCE(
        NULLIF(EXCLUDED.private_chat_id, ''),
        public.lr_users.private_chat_id
      ),

      first_name=COALESCE(
        NULLIF(EXCLUDED.first_name, ''),
        public.lr_users.first_name
      ),

      last_name=COALESCE(
        NULLIF(EXCLUDED.last_name, ''),
        public.lr_users.last_name
      ),

      display_name=COALESCE(
        NULLIF(EXCLUDED.display_name, ''),
        public.lr_users.display_name
      ),

      username=COALESCE(
        NULLIF(EXCLUDED.username, ''),
        public.lr_users.username
      ),

      language_code=COALESCE(
        NULLIF(EXCLUDED.language_code, ''),
        public.lr_users.language_code
      ),

      last_seen_at=now(),

      updates_count=
        public.lr_users.updates_count + 1,

      raw_profile=
        public.lr_users.raw_profile ||
        EXCLUDED.raw_profile,

      updated_at=now()

    RETURNING *
  `, [
    maxUserId,
    privateChatId || null,
    firstName || null,
    lastName || null,
    displayName,
    username || null,
    languageCode || null,
    JSON.stringify(safeRaw),
  ]));

  const user = users[0];

  if (!user) {
    return existingUser;
  }

  await query(`
    INSERT INTO public.lr_user_subscriptions (
      user_id,
      tariff_code,
      status,
      starts_at,
      expires_at,
      auto_renew,
      source,
      updated_at
    )
    SELECT
      $1,
      'free',
      'active',
      now(),
      NULL,
      false,
      'registration',
      now()
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.lr_user_subscriptions
      WHERE user_id=$1
        AND status='active'
    )
  `, [user.id]);

  return user;
}

async function lrProfileLinkChannel(
  maxUserId,
  channelId
) {
  const safeUserId = lrProfileClean(
    maxUserId,
    100
  );

  const safeChannelId = Number(channelId);

  if (
    !/^\d+$/.test(safeUserId) ||
    !Number.isInteger(safeChannelId) ||
    safeChannelId <= 0
  ) {
    return false;
  }

  await lrProfileEnsureSchema();

  const users = lrProfileRows(await query(`
    SELECT id
    FROM public.lr_users
    WHERE max_user_id=$1
    LIMIT 1
  `, [safeUserId]));

  const userId = Number(users[0]?.id);

  if (!userId) {
    return false;
  }

  await query(`
    INSERT INTO public.lr_user_channels (
      user_id,
      channel_id,
      linked_at
    )
    VALUES ($1, $2, now())
    ON CONFLICT (user_id, channel_id)
    DO NOTHING
  `, [userId, safeChannelId]);

  await query(`
    UPDATE public.channels
    SET
      owner_max_user_id=COALESCE(
        owner_max_user_id,
        $1::bigint
      ),
      updated_at=now()
    WHERE id=$2
  `, [safeUserId, safeChannelId]).catch(
    (error) => {
      console.error(
        '[LR profile channel owner]',
        error?.message || error
      );
    }
  );

  return true;
}

async function lrProfileSingleUserBackfill(user) {
  const userId = Number(user?.id);
  const maxUserId = lrProfileClean(
    user?.max_user_id,
    100
  );

  if (
    !Number.isInteger(userId) ||
    userId <= 0 ||
    !/^\d+$/.test(maxUserId)
  ) {
    return;
  }

  await lrProfileEnsureSchema();

  await query(`
    CREATE TABLE IF NOT EXISTS
      public.lr_profile_migrations (
        key text PRIMARY KEY,
        completed_by_user_id bigint,
        completed_at timestamptz
          NOT NULL DEFAULT now()
      )
  `);

  const otherRealUsers = lrProfileRows(await query(`
    SELECT id
    FROM public.lr_users
    WHERE id<>$1
      AND COALESCE(is_blocked, false)=false
      AND LOWER(COALESCE(display_name, ''))
            NOT LIKE 'linkray%'
      AND LOWER(COALESCE(username, ''))
            NOT LIKE '%\\_bot' ESCAPE '\\'
    LIMIT 1
  `, [userId]).catch(() => []));

  if (otherRealUsers.length > 0) {
    return;
  }

  const claimed = lrProfileRows(await query(`
    INSERT INTO public.lr_profile_migrations (
      key,
      completed_by_user_id,
      completed_at
    )
    VALUES (
      'legacy_channels_to_first_real_user_v4',
      $1,
      now()
    )
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `, [userId]));

  if (!claimed.length) {
    return;
  }

  await query(`
    INSERT INTO public.lr_user_channels (
      user_id,
      channel_id,
      linked_at
    )
    SELECT
      $1,
      c.id,
      now()
    FROM public.channels c
    WHERE COALESCE(c.is_active, true)=true
    ON CONFLICT (user_id, channel_id)
    DO NOTHING
  `, [userId]);

  await query(`
    UPDATE public.channels
    SET
      owner_max_user_id=$1::bigint,
      updated_at=now()
    WHERE COALESCE(is_active, true)=true
  `, [maxUserId]).catch((error) => {
    console.error(
      '[LR profile legacy owner]',
      error?.message || error
    );
  });
}

function lrProfileMskDate(value) {
  const date = value ? new Date(value) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return 'не определена';
  }

  return date.toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/* LR_PROFILE_CHANNEL_OWNER_SYNC_V2 */

async function lrProfileSyncChannels(user) {
  const userId = Number(user?.id);

  const maxUserId = lrProfileClean(
    user?.max_user_id,
    100
  );

  const privateChatId = lrProfileClean(
    user?.private_chat_id,
    100
  );

  if (
    !Number.isInteger(userId) ||
    userId <= 0 ||
    !/^\d+$/.test(maxUserId)
  ) {
    return;
  }

  await lrProfileEnsureSchema();

  await lrProfileSingleUserBackfill(user)
    .catch((error) => {
      console.error(
        '[LR profile legacy sync]',
        error?.message || error
      );
    });

  await query(`
    INSERT INTO public.lr_user_channels (
      user_id,
      channel_id,
      linked_at
    )
    SELECT
      $1,
      c.id,
      now()
    FROM public.channels c
    WHERE COALESCE(c.is_active, true)=true
      AND c.owner_max_user_id::text=$2
    ON CONFLICT (user_id, channel_id)
    DO NOTHING
  `, [
    userId,
    maxUserId,
  ]).catch((error) => {
    console.error(
      '[LR profile owner sync]',
      error?.message || error
    );
  });

  const ownerIds = [
    maxUserId,
    privateChatId,
  ].filter(Boolean);

  if (ownerIds.length) {
    await query(`
      INSERT INTO public.lr_user_channels (
        user_id,
        channel_id,
        linked_at
      )
      SELECT DISTINCT
        $1,
        c.id,
        now()
      FROM public.channels c
      JOIN public.lr_channel_analytics_daily_channels d
        ON d.channel_id=c.id
      WHERE COALESCE(c.is_active, true)=true
        AND d.owner_chat_id::text=
            ANY($2::text[])
      ON CONFLICT (user_id, channel_id)
      DO NOTHING
    `, [
      userId,
      ownerIds,
    ]).catch(() => {});
  }

  await query(`
    INSERT INTO public.lr_user_channels (
      user_id,
      channel_id,
      linked_at
    )
    SELECT DISTINCT
      $1,
      c.id,
      now()
    FROM public.channels c
    JOIN public.scheduled_posts p
      ON p.channel_id=c.id
    WHERE COALESCE(c.is_active, true)=true
      AND p.created_by_max_user_id::text=$2
    ON CONFLICT (user_id, channel_id)
    DO NOTHING
  `, [
    userId,
    maxUserId,
  ]).catch(() => {});
}

async function lrProfileRead(maxUserId) {
  await lrProfileEnsureSchema();

  const result = lrProfileRows(await query(`
    SELECT
      u.id,
      u.profile_number,
      u.max_user_id,
      u.private_chat_id,
      u.first_name,
      u.last_name,
      u.display_name,
      u.registered_at,
      u.last_seen_at,
      u.is_blocked,

      COALESCE(t.code, 'free')
        AS tariff_code,

      COALESCE(t.title, 'Бесплатный')
        AS tariff_title,

      s.status AS subscription_status,
      s.starts_at AS subscription_started_at,
      s.expires_at AS subscription_expires_at,

      (
        SELECT COUNT(DISTINCT c.id)
        FROM public.channels c
        WHERE COALESCE(c.is_active, true)=true
          AND (
            c.owner_max_user_id::text=
              u.max_user_id

            OR EXISTS (
              SELECT 1
              FROM public.lr_user_channels uc
              WHERE uc.user_id=u.id
                AND uc.channel_id=c.id
            )
          )
      )::integer AS channels_count

    FROM public.lr_users u

    LEFT JOIN LATERAL (
      SELECT *
      FROM public.lr_user_subscriptions current_sub
      WHERE current_sub.user_id=u.id
        AND current_sub.status='active'
        AND (
          current_sub.expires_at IS NULL
          OR current_sub.expires_at > now()
        )
      ORDER BY
        current_sub.created_at DESC,
        current_sub.id DESC
      LIMIT 1
    ) s ON true

    LEFT JOIN public.lr_tariffs t
      ON t.code=s.tariff_code

    WHERE u.max_user_id=$1
    LIMIT 1
  `, [String(maxUserId)]));

  return result[0] || null;
}

function lrProfileFormatText(profile) {
  const localId = `LR-${String(
    profile.profile_number ||
    profile.id
  ).padStart(6, '0')}`;

  const access = profile.subscription_expires_at
    ? `до ${lrProfileMskDate(
        profile.subscription_expires_at
      )}`
    : 'без ограничений';

  return [
    '👤 <b>Профиль LinkRay</b>',
    '',
    `🆔 ID профиля: <b>${localId}</b>`,
    `👤 Имя: <b>${lrProfileEsc(
      profile.display_name ||
      'Пользователь MAX'
    )}</b>`,
    '',
    `💎 Тариф: <b>${lrProfileEsc(
      profile.tariff_title ||
      'Бесплатный'
    )}</b>`,
    `📅 Доступ: <b>${access}</b>`,
    `📢 Подключено каналов: <b>${Number(
      profile.channels_count || 0
    )}</b>`,
    `🗓 Регистрация: <b>${lrProfileMskDate(
      profile.registered_at
    )}</b>`,
    '',
    '━━━━━━━━━━━━',
    'Сейчас LinkRay доступен бесплатно.',
  ].join('\n');
}

/* LR_TEAM_PROFILE_FORMAT_V1 */

/* LR_TEAM_PROFILE_ACCESS_LINE_V2 */

function lrProfileFormatTextWithTeam(
  profile,
  team = {}
) {
  const localId = `LR-${String(
    profile.profile_number ||
    profile.id
  ).padStart(6, '0')}`;

  const sharedChannels =
    Array.isArray(team.sharedChannels)
      ? team.sharedChannels
      : [];

  const lines = [
    '👤 <b>Профиль LinkRay</b>',
    '',
    `🆔 ID профиля: <b>${localId}</b>`,
    `👤 Имя: <b>${lrProfileEsc(
      profile.display_name ||
      'Пользователь MAX'
    )}</b>`,
    '',
  ];

  /*
   * Собственная платная подписка.
   */
  if (team.ownPaid) {
    lines.push(
      `💎 Личная подписка: <b>${lrProfileEsc(
        team.ownPaid.tariffTitle ||
        'Платный тариф'
      )}</b>`
    );

    const channelLimit =
      team.ownPaid.channelLimit === null ||
      team.ownPaid.channelLimit === undefined
        ? ''
        : ` из ${Number(
            team.ownPaid.channelLimit
          )}`;

    lines.push(
      `📢 Оплачено каналов: <b>${Number(
        team.ownPaid.assignedChannels ||
        0
      )}${channelLimit}</b>`
    );

    lines.push(
      '👥 Доступ другим администраторам: ' +
      '<b>включён</b>'
    );
  } else {
    /*
     * Бесплатный личный тариф остаётся
     * у пользователя даже при командном доступе.
     */
    lines.push(
      `💎 Личная подписка: <b>${lrProfileEsc(
        profile.tariff_title ||
        'Бесплатный'
      )}</b>`
    );
  }

  /*
   * Каналы, оплаченные другим администратором.
   */
  if (sharedChannels.length) {
    lines.push('');

    lines.push(
      `🤝 Доступ по подписке команды: <b>${
        sharedChannels.length
      }</b>`
    );

    for (
      const channel
      of sharedChannels.slice(0, 10)
    ) {
      lines.push('');

      lines.push(
        `• <b>${lrProfileEsc(
          channel.channelTitle ||
          'Канал MAX'
        )}</b>`
      );

      lines.push(
        `  Тариф: ${lrProfileEsc(
          channel.tariffTitle ||
          'Платный'
        )}`
      );

      lines.push(
        `  Оплачивает: ${lrProfileEsc(
          channel.payerName ||
          'другой администратор'
        )}`
      );

      if (channel.expiresAt) {
        lines.push(
          `  Действует до: ${lrProfileMskDate(
            channel.expiresAt
          )}`
        );
      }
    }
  }

  lines.push('');

  /*
   * Общая строка доступа.
   */
  if (team.freeMode) {
    lines.push(
      '📅 Доступ: <b>без ограничений</b>'
    );
  } else if (team.ownPaid) {
    if (team.ownPaid.expiresAt) {
      lines.push(
        `📅 Доступ до: <b>${lrProfileMskDate(
          team.ownPaid.expiresAt
        )}</b>`
      );
    } else {
      lines.push(
        '📅 Доступ: <b>без ограничений</b>'
      );
    }
  } else if (sharedChannels.length) {
    lines.push(
      '📅 Доступ: <b>по подписке команды</b>'
    );
  } else {
    lines.push(
      '📅 Доступ: <b>требуется подписка</b>'
    );
  }

  lines.push(
    `📢 Подключено каналов: <b>${Number(
      profile.channels_count || 0
    )}</b>`
  );

  lines.push(
    `🗓 Регистрация: <b>${lrProfileMskDate(
      profile.registered_at
    )}</b>`
  );

  lines.push('');
  lines.push('━━━━━━━━━━━━');

  if (team.freeMode) {
    lines.push(
      'Сейчас LinkRay доступен бесплатно.'
    );
  } else if (
    !team.ownPaid &&
    !sharedChannels.length
  ) {
    lines.push(
      'Для использования LinkRay требуется подписка.'
    );
  } else {
    lines.push(
      'Один оплаченный канал доступен всем его администраторам.'
    );
  }

  return lines.join('\n');
}

async function lrProfileShow(
  update,
  touchedUser = null
) {
  let user =
    touchedUser ||
    await lrProfileTouch(update);

  if (!user) {
    const chatId = lrProfilePrivateChatId(
      update,
      ''
    );

    if (chatId) {
      user = lrProfileRows(await query(`
        SELECT *
        FROM public.lr_users
        WHERE private_chat_id=$1
           OR max_user_id=$1
        ORDER BY last_seen_at DESC
        LIMIT 1
      `, [String(chatId)]))[0] || null;
    }
  }

  if (!user?.max_user_id) {
    throw new Error(
      'Не удалось определить пользователя MAX'
    );
  }

  await lrProfileSyncChannels(user)
    .catch((error) => {
      console.error(
        '[LR profile sync nonfatal]',
        error?.stack ||
        error?.message ||
        error
      );
    });

  const profile = await lrProfileRead(
    user.max_user_id
  );

  if (!profile) {
    throw new Error(
      'Профиль пользователя не найден'
    );
  }

  /* LR_TEAM_PROFILE_HOOK_V1 */
  const teamAccess =
    await getProfileTeamAccess(
      profile.max_user_id
    ).catch((error) => {
      console.error(
        '[team profile access]',
        error?.stack ||
        error?.message ||
        error
      );

      return {
        freeMode: true,
        ownPaid: null,
        sharedChannels: [],
      };
    });

  const profileText =
    lrProfileFormatTextWithTeam(
      profile,
      teamAccess
    );

  const rows = [
    [
      callbackButton(
        '❓ Вопросы / предложения',
        'support:open'
      ),
    ],
    [
      callbackButton(
        '⬅️ Главное меню',
        'main:menu'
      ),
    ],
  ];

  const attachments =
    typeof buttonRows === 'function'
      ? buttonRows(rows)
      : (
          typeof inlineKeyboard === 'function'
            ? inlineKeyboard(rows)
            : rows
        );

  const callbackId =
    lrProfileCallbackId(update);

  if (
    callbackId &&
    typeof answerCallback === 'function'
  ) {
    await answerCallback({
      callbackId,
      text: profileText,
      format: 'html',
      attachments,
    });

    return true;
  }

  const chatId = lrProfilePrivateChatId(
    update,
    profile.max_user_id
  );

  await sendMaxMessage({
    chatId,
    text: profileText,
    format: 'html',
    attachments,
  });

  return true;
}

async function lrProfileHandle(
  update,
  touchedUser = null
) {
  const payload = lrProfilePayload(update)
    .toLowerCase();

  const messageText = lrProfileMessageText(update)
    .replace(/\uFE0F/g, '')
    .trim()
    .toLowerCase();

  const isProfile =
    payload === 'profile' ||
    payload === 'main:profile' ||
    payload === 'menu:profile' ||
    payload === 'user:profile' ||
    payload === 'profile:open' ||
    payload.endsWith(':profile') ||
    messageText === 'профиль' ||
    messageText === '👤 профиль' ||
    messageText === '/profile';

  if (!isProfile) {
    return false;
  }

  try {
    await lrProfileShow(
      update,
      touchedUser
    );

    return true;
  } catch (error) {
    console.error(
      '[LR profile handled error]',
      error?.stack ||
      error?.message ||
      error
    );

    const errorText = [
      '⚠️ <b>Не удалось открыть профиль</b>',
      '',
      'Профиль зарегистрирован, но при получении данных возникла ошибка.',
      'Повторите открытие через несколько секунд.',
    ].join('\n');

    const rows = [[
      callbackButton(
        '⬅️ Главное меню',
        'main:menu'
      )
    ]];

    const attachments =
      typeof buttonRows === 'function'
        ? buttonRows(rows)
        : (
            typeof inlineKeyboard === 'function'
              ? inlineKeyboard(rows)
              : rows
          );

    const callbackId =
      lrProfileCallbackId(update);

    let sent = false;

    if (
      callbackId &&
      typeof answerCallback === 'function'
    ) {
      try {
        await answerCallback({
          callbackId,
          text: errorText,
          format: 'html',
          attachments,
        });

        sent = true;
      } catch {}
    }

    if (!sent) {
      const chatId = lrProfilePrivateChatId(
        update,
        lrProfileMaxUserId(update)
      );

      if (chatId) {
        await sendMaxMessage({
          chatId,
          text: errorText,
          format: 'html',
          attachments,
        }).catch(() => {});
      }
    }

    /*
     * Важно: callback профиля обработан.
     * Не передаём его общему fallback.
     */
    return true;
  }
}

lrProfileEnsureSchema().catch((error) => {
  console.error(
    '[LR profile schema]',
    error?.stack ||
    error?.message ||
    error
  );
});

/* LR_USER_PROFILE_V1_END */

/* LR_ADMIN_PANEL_V1_INSTALL */
installLinkRayAdminPanel(app);

app.use(async function lrForceStartMenuV7(req, res, next) {
  try {
    if (req.method !== 'POST') return next();

    const update = req.body || {};

    /* LR_USER_PROFILE_REQUEST_HOOK_V1 */
    const __lrTouchedProfileUser =
      await lrProfileTouch(update).catch(
        (error) => {
          console.error(
            '[LR profile touch]',
            error?.stack ||
            error?.message ||
            error
          );

          return null;
        }
      );

    const __lrProfileHandled =
      await lrProfileHandle(
        update,
        __lrTouchedProfileUser
      ).catch((error) => {
        console.error(
          '[LR profile handle]',
          error?.stack ||
          error?.message ||
          error
        );

        return false;
      });

    if (__lrProfileHandled) {
      return res.json({ ok: true });
    }

  __lrAddConfirmWatch(update).catch(e => console.error('[channel add confirm watch] hook failed', e?.message || e));
    const text = String(getMessageText(update) || '').trim();
    const payload = String(getCallbackPayload(update) || '');
    const callbackId = getCallbackId(update);
    const chatId = getChatId(update);

    const isStart = /^\/start(?:\s|$)/i.test(text);
    const isMainMenuNew = payload === 'lrchan:main:new';
      const isMainMenu =
        payload === 'main:menu' ||
        payload === 'menu:main' ||
        payload === 'start:menu' ||
        isMainMenuNew;
      /* LR_ANALYTICS_NEW_MAIN_MESSAGE_V83_1 */

    if (!isStart && !isMainMenu) return next();

    const menuText = __lrForceMainMenuTextV7();
    const rows = __lrForceMainMenuRowsV7();
    const attachments = __lrForceMenuAttachmentsV7(rows);

    if (isMainMenuNew && callbackId && chatId) {
        await answerCallback({
          callbackId,
          notification: 'Главное меню открыто',
        }).catch((error) => {
          console.error(
            '[LR_ANALYTICS_NEW_MAIN_MESSAGE_V83_1_ACK]',
            error?.message || error
          );
        });

        await sendMaxMessage({
          chatId,
          text: menuText,
          format: 'html',
          attachments,
        });
      } else if (callbackId) {
        await answerCallback({
          callbackId,
          text: menuText,
          format: 'html',
          attachments,
        });
      } else if (chatId) {
        await sendMaxMessage({
          chatId,
          text: menuText,
          format: 'html',
          attachments,
        });
      } else {
      return next();
    }

    console.log('[LR_FORCE_START_MENU_V7] sent priority main menu', JSON.stringify({
      chatId: String(chatId || ''),
      payload,
      isStart,
      isMainMenu
    }));

    return res.json({ ok: true });
  } catch (error) {
    console.error('[LR_FORCE_START_MENU_V7]', error && error.stack ? error.stack : error);
    return next();
  }
});
// LR_FORCE_START_MENU_V7_END


// LR_ANALYTICS_PRIORITY_BEFORE_POSTING_START
mountLinkRayChannelAnalytics(app);

app.use(async function lrAnalyticsPriorityBeforePosting(req, res, next) {
  try {
    if (req.method !== 'POST') {
      return next();
    }

    const handled = await handleLinkRayChannelAnalyticsIncoming(req.body || {});

    if (handled) {
      console.log('[LR_ANALYTICS_PRIORITY] handled before posting');
      return res.json({ ok: true, analytics: true });
    }
  } catch (error) {
    console.error('[LR_ANALYTICS_PRIORITY]', error?.stack || error);
  }

  return next();
});
// LR_ANALYTICS_PRIORITY_BEFORE_POSTING_END


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
            [callbackButton('🚀 LinkRay Studio', 'main:posting')],
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
/* LR_EDITOR_PREVIEW_ABOVE_MENU_V45_START */
function lrV45MessageId(value) {
  if (!value) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return (
    value.message_id ||
    value.messageId ||
    value.id ||
    value.mid ||
    value.message?.message_id ||
    value.message?.messageId ||
    value.message?.id ||
    value.result?.message_id ||
    value.result?.messageId ||
    value.result?.id ||
    null
  );
}

function lrV45EditorRows(draft) {
  try {
    if (typeof editorMenuRows === 'function') return editorMenuRows(draft);
  } catch (e) {
    console.error('[v45 editor order] editor rows failed', e?.message || e);
  }

  return [
    [callbackButton('✏️ Изменить текст', 'editor:text'), callbackButton('🖼 Медиа', 'editor:media')],
    [callbackButton('⚫ Добавить кнопку', 'editor:button'), callbackButton('🏷 Автоподпись', 'editor:signature')],
    [callbackButton('💼 Рекламный пост', 'editor:ad')],
    [callbackButton('➡️ Далее', 'editor:next')],
    [callbackButton('⬅️ Назад', 'editor:back'), callbackButton('❌ Отмена', 'post:cancel')]
  ];
}

function lrV45EditorText() {
  try {
    if (typeof editorMenuText === 'function') return editorMenuText();
  } catch {}

  return `━━━━━━━━━━━━━━
🧬 <b>Редактор LinkRay</b>

Пост-превью находится выше.
При изменении текста, медиа, кнопок или автоподписи превью будет обновляться.

Настройте оформление.
━━━━━━━━━━━━━━`;
}

async function lrV45ShowEditorPreviewFirst(chatId, key, draft, noticeText = '') {
  if (!chatId) return false;

  try {
    if (typeof setSession === 'function') {
      await setSession(key, draft?.postId ? 'edit_existing' : 'edit_draft', { draft });
    }
  } catch (e) {
    console.error('[v45 editor order] setSession failed', e?.message || e);
  }

  try {
    if (noticeText && typeof answerCallback === 'function' && typeof callbackId !== 'undefined' && callbackId) {
      await answerCallback({ callbackId, notification: String(noticeText) });
    }
  } catch {}

  // Сначала отправляем/обновляем превью поста.
  try {
    if (typeof sendDraftPreview === 'function') {
      const result = await sendDraftPreview(chatId, draft);
      const mid = lrV45MessageId(result);
      if (mid) {
        draft.previewMessageId = mid;
        draft.preview_message_id = mid;
      }

      if (typeof setSession === 'function') {
        await setSession(key, draft?.postId ? 'edit_existing' : 'edit_draft', { draft });
      }

      console.log('[v45 editor order] preview sent before menu', JSON.stringify({ chatId, mid }));
    }
  } catch (e) {
    console.error('[v45 editor order] preview failed', e?.stack || e?.message || e);
  }

  // Потом отправляем меню редактора ниже превью.
  try {
    const rows = lrV45EditorRows(draft);
    const attachments = rows && rows.length && typeof inlineKeyboard === 'function' ? inlineKeyboard(rows) : rows;

    if (typeof sendMaxMessage === 'function') {
      await sendMaxMessage({
        chatId,
        text: lrV45EditorText(),
        format: 'html',
        attachments
      });
      console.log('[v45 editor order] menu sent after preview', JSON.stringify({ chatId }));
      return true;
    }

    if (typeof msg === 'function') {
      await msg(chatId, lrV45EditorText(), rows, 'html');
      console.log('[v45 editor order] menu msg after preview', JSON.stringify({ chatId }));
      return true;
    }
  } catch (e) {
    console.error('[v45 editor order] menu failed', e?.stack || e?.message || e);
  }

  return false;
}

console.log('[v45 editor order] installed');
/* LR_EDITOR_PREVIEW_ABOVE_MENU_V45_END */
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
        const label = dk === todayKey ? `🟡 ${day}` : String(day);

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
      if (!callbackId && !payload) return;

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

    async function lrEnsureSignatureTableClean() {
    await query(`CREATE TABLE IF NOT EXISTS channel_signatures (
      id serial PRIMARY KEY,
      channel_id integer NOT NULL,
      owner_key text NOT NULL DEFAULT 'global',
      title text,
      text text,
      format text DEFAULT 'html',
      markup jsonb DEFAULT '[]'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS owner_key text NOT NULL DEFAULT 'global'`);
    await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS title text`);
    await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS text text`);
    await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS format text DEFAULT 'html'`);
    await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS markup jsonb DEFAULT '[]'::jsonb`);
    await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
    await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
    await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS channel_signatures_channel_owner_uq ON channel_signatures(channel_id, owner_key)`);
  }

  async function lrSaveSig(channelId, content) {
  await lrEnsureSignatureTableClean();

  const lrSigRows = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.rows) ? v.rows : []);

  const cleanText = String(content && content.text ? content.text : '').trim();
  if (!cleanText) throw new Error('empty signature text');

  const markup = (Array.isArray(content && content.markup) ? content.markup : []).filter(function(m) {
    const t = String((m && (m.type || m.kind)) || '').toLowerCase();
    return !t.includes('quote') && !t.includes('blockquote') && !t.includes('citation') && !t.includes('cite');
  });

  await query("CREATE TABLE IF NOT EXISTS channel_signatures ( id serial PRIMARY KEY, channel_id integer NOT NULL, owner_key text NOT NULL DEFAULT 'global', title text, text text, format text DEFAULT 'html', markup jsonb DEFAULT '[]'::jsonb, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now() )");
  await query("ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS owner_key text NOT NULL DEFAULT 'global'");
  await query("ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS title text");
  await query("ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS text text");
  await query("ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS format text DEFAULT 'html'");
  await query("ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS markup jsonb DEFAULT '[]'::jsonb");
  await query("ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true");
  await query("ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()");
  await query("ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS channel_signatures_channel_owner_uq ON channel_signatures(channel_id, owner_key)");

  const saved = await query(
    "INSERT INTO channel_signatures(channel_id, owner_key, title, text, format, markup, is_active, created_at, updated_at) " +
    "VALUES($1, $2, $3, $4, $5, $6::jsonb, true, now(), now()) " +
    "ON CONFLICT(channel_id, owner_key) DO UPDATE SET " +
    "title=EXCLUDED.title, text=EXCLUDED.text, format=EXCLUDED.format, markup=EXCLUDED.markup, is_active=true, updated_at=now() " +
    "RETURNING id, channel_id, owner_key, is_active, text, updated_at",
    [Number(channelId), 'global', 'Автоподпись', cleanText, 'html', JSON.stringify(markup)]
  );

  const savedRows = lrSigRows(saved);
  if (!savedRows.length || !savedRows[0].id) {
    throw new Error('autosign save returned no row');
  }

  const check = await query(
    "SELECT id, channel_id, owner_key, is_active, text, updated_at FROM channel_signatures WHERE id=$1 LIMIT 1",
    [savedRows[0].id]
  );

  const checkRows = lrSigRows(check);
  if (!checkRows.length) {
    throw new Error('autosign saved row not found after save');
  }

  console.log('[autosign db save] saved+verified', JSON.stringify({
    id: checkRows[0].id,
    channelId: Number(channelId),
    len: cleanText.length,
    text: cleanText.slice(0, 40)
  }));
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

      const buttons = (sig && String(sig.text || '').trim())
    ? [
        [callbackButton('✏️ Заменить автоподпись', 'lr:sig:add:' + channelId + ':' + mode)],
        [callbackButton(active ? '🔴 Выключить автоподпись' : '🟢 Включить автоподпись', 'lr:sig:toggle:' + channelId + ':' + mode)],
        [lrBack(mode)]
      ]
    : [
        [callbackButton('✍️ Создать автоподпись', 'lr:sig:add:' + channelId + ':' + mode)],
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
        await __lrV23AutosignSavedBack(update);
        await sendDraftPreview(chatId, draft);
        await msg(chatId, editorMenuText(), editorMenuRows(draft));
      } else { await clearSession(key); await msg(chatId, '✅ Подпись к каналу добавлена.', [[callbackButton('⬅️ Назад', 'main:posting')]]); return res.json({ ok: true }); } return res.json({ ok: true });
    }

    return next();
  } catch (e) {
    console.error('[LR_CLEAN_SIGNATURE_FIX]', e && e.message ? e.message : e);
    return next();
  }
});
/* LR_CLEAN_SIGNATURE_FIX_END */

// LR_CHANNEL_DB_SYNC_MIDDLEWARE_START
/* LR_MAX_SUBSCRIPTIONS_CORE_V31_START */
/*
  LinkRay MAX subscriptions core v31.

  Назначение:
  - убрать зависимость от общего GET /chats как списка каналов;
  - хранить каналы в таблице channels;
  - принимать bot_added / bot_removed / chat_title_changed через webhook;
  - ставить/обрабатывать режим "Добавить канал";
  - вернуть стабильную обработку кнопок Studio post:*;
  - один блок вместо временных v21-v30.
*/

function lrV31Rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function lrV31Clean(value, max = 4000) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) return '';
  if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(text.toLowerCase())) return '';
  return text;
}

function lrV31Esc(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
  } catch {}

  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrV31Type(update) {
  return String(
    update?.update_type ||
    update?.type ||
    update?.body?.update_type ||
    update?.body?.type ||
    ''
  );
}

function lrV31Payload(update) {
  try {
    const p = typeof getCallbackPayload === 'function' ? getCallbackPayload(update) : '';
    if (typeof p === 'string') return p;
  } catch {}

  const p =
    update?.callback?.payload ||
    update?.callback?.payload?.payload ||
    update?.message?.callback?.payload ||
    update?.body?.callback?.payload ||
    update?.payload ||
    update?.body?.payload ||
    '';

  return typeof p === 'string' ? p : '';
}

function lrV31CallbackId(update) {
  try {
    return typeof getCallbackId === 'function' ? getCallbackId(update) : '';
  } catch {
    return '';
  }
}

function lrV31Key(update) {
  try {
    return String(getSessionKey(update) || '');
  } catch {
    return '';
  }
}

function lrV31ChatId(update, key = '') {
  try {
    if (typeof lrResolveReplyChatId === 'function') {
      const id = lrV31Clean(lrResolveReplyChatId(update, key));
      if (id) return id;
    }
  } catch {}

  try {
    if (typeof getChatId === 'function') {
      const id = lrV31Clean(getChatId(update));
      if (id) return id;
    }
  } catch {}

  return lrV31Clean(
    update?.chat_id ||
    update?.chatId ||
    update?.body?.chat_id ||
    update?.body?.chatId ||
    update?.message?.recipient?.chat_id ||
    update?.message?.recipient?.id ||
    update?.message?.chat_id ||
    update?.body?.message?.recipient?.chat_id ||
    update?.body?.message?.recipient?.id ||
    update?.body?.message?.chat_id ||
    key ||
    ''
  );
}

function lrV31UserId(update) {
  return lrV31Clean(
    update?.user?.user_id ||
    update?.user?.id ||
    update?.user_id ||
    update?.sender?.user_id ||
    update?.sender?.id ||
    update?.message?.sender?.user_id ||
    update?.message?.sender?.id ||
    update?.body?.user?.user_id ||
    update?.body?.user?.id ||
    ''
  );
}

function lrV31PrivateChatId(update, fallback = '') {
  const keyFallback = lrV31Clean(fallback, 100);

  const directChat = lrV31Clean(
    update?.chat_id ||
    update?.chatId ||
    update?.body?.chat_id ||
    update?.body?.chatId ||
    update?.message?.recipient?.chat_id ||
    update?.message?.recipient?.id ||
    update?.body?.message?.recipient?.chat_id ||
    update?.body?.message?.recipient?.id ||
    '',
    100
  );

  // Для личного диалога MAX даёт положительный chatId. Его и надо использовать для ответа.
  if (directChat && !String(directChat).startsWith('-')) return String(directChat);

  if (keyFallback && !String(keyFallback).startsWith('-')) return String(keyFallback);

  try {
    const resolved = lrV31Clean(lrV31ChatId(update, keyFallback), 100);
    if (resolved && !String(resolved).startsWith('-')) return String(resolved);
  } catch {}

  // user_id не равен chat_id. Поэтому он только последний fallback, а не основной адрес для уведомления.
  const userId = lrV31Clean(
    update?.user?.user_id ||
    update?.user?.id ||
    update?.sender?.user_id ||
    update?.sender?.id ||
    update?.message?.sender?.user_id ||
    update?.message?.sender?.id ||
    update?.body?.user?.user_id ||
    update?.body?.user?.id ||
    '',
    100
  );

  return lrV31Clean(
    process.env.LR_OWNER_CHAT_ID ||
    process.env.OWNER_CHAT_ID ||
    process.env.ADMIN_CHAT_ID ||
    keyFallback ||
    userId ||
    '405954311',
    100
  ) || '405954311';
}

function lrV31ApiBase() {
  return String(
    process.env.MAX_API_BASE ||
    process.env.MAX_BASE_URL ||
    process.env.MAX_PLATFORM_API ||
    'https://platform-api2.max.ru'
  ).replace(/\/+$/, '');
}

function lrV31ApiToken() {
  for (const k of ['MAX_TOKEN', 'MAX_BOT_TOKEN', 'MAX_ACCESS_TOKEN', 'BOT_TOKEN', 'ACCESS_TOKEN', 'API_TOKEN', 'TOKEN']) {
    if (process.env[k]) return String(process.env[k]);
  }

  try {
    if (typeof MAX_TOKEN !== 'undefined' && MAX_TOKEN) return String(MAX_TOKEN);
  } catch {}

  try {
    if (typeof BOT_TOKEN !== 'undefined' && BOT_TOKEN) return String(BOT_TOKEN);
  } catch {}

  return '';
}

async function lrV31Api(path, options = {}) {
  const token = lrV31ApiToken();
  const headers = {
    ...(options.headers || {}),
    Authorization: token
  };

  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${lrV31ApiBase()}${path}`, {
    ...options,
    headers
  });

  const raw = await response.text().catch(() => '');
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    console.error('[v31 core] MAX API failed', JSON.stringify({
      path,
      status: response.status,
      preview: raw.slice(0, 500)
    }));
  }

  return {
    ok: response.ok && data?.success !== false,
    status: response.status,
    data,
    raw
  };
}

async function lrV31ApiGet(path) {
  return lrV31Api(path, { method: 'GET' });
}

async function lrV31ApiPost(path, body) {
  return lrV31Api(path, {
    method: 'POST',
    body: JSON.stringify(body || {})
  });
}

async function lrV31EnsureSchema() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS channels (
      id serial PRIMARY KEY,
      max_chat_id text UNIQUE,
      title text,
      link text,
      is_public boolean DEFAULT false,
      is_channel boolean DEFAULT true,
      is_active boolean DEFAULT true,
      bot_added_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

    await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS max_chat_id text`);
    await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS title text`);
    await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS link text`);
    await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_public boolean DEFAULT false`);
    await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_channel boolean DEFAULT true`);
    await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true`);
    await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS bot_added_at timestamptz`);
    await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

    await query(`CREATE UNIQUE INDEX IF NOT EXISTS channels_max_chat_id_uidx ON channels(max_chat_id)`);

    await query(`CREATE TABLE IF NOT EXISTS lr_bot_state (
      key text PRIMARY KEY,
      value text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  } catch (e) {
    console.error('[v31 core] ensure schema failed', e?.stack || e?.message || e);
  }
}

async function lrV31PutState(key, value) {
  await lrV31EnsureSchema();

  await query(
    `INSERT INTO lr_bot_state(key, value, updated_at)
     VALUES($1, $2, now())
     ON CONFLICT(key) DO UPDATE
       SET value=EXCLUDED.value,
           updated_at=now()`,
    [String(key), JSON.stringify(value || {})]
  );
}

async function lrV31GetState(keys) {
  await lrV31EnsureSchema();

  const rows = lrV31Rows(await query(
    `SELECT key, value, updated_at
     FROM lr_bot_state
     WHERE key = ANY($1::text[])
     ORDER BY updated_at DESC
     LIMIT 1`,
    [keys.map(String)]
  ));

  if (!rows[0]) return null;

  try {
    return JSON.parse(rows[0].value || '{}');
  } catch {
    return null;
  }
}

async function lrV31DelAddStates() {
  try {
    await query(
      `DELETE FROM lr_bot_state
       WHERE key = 'lr_v31_add_wait_global'
          OR key LIKE 'lr_v31_add_wait:%'
          OR key LIKE 'lr_v30_add_wait:%'
          OR key LIKE 'lr_v29_add_wait:%'
          OR key LIKE 'lr_v28_add_wait:%'
          OR key LIKE 'lr_v27_add_wait:%'
          OR key LIKE 'lr_v23_add_wait:%'
          OR key LIKE 'lr_add_channel_wait:%'
          OR key LIKE 'add_channel_wait:%'
          OR key LIKE 'channel_add_wait:%'`
    );
  } catch {}

  globalThis.__lrV31AddWait = null;

  try {
    if (globalThis.__lrV31WatcherTimer) clearInterval(globalThis.__lrV31WatcherTimer);
  } catch {}

  globalThis.__lrV31WatcherTimer = null;
}

function lrV31ExtractChatTitleFromApi(data) {
  const root = data?.chat || data?.result || data || {};
  return lrV31Clean(root.title || root.name || root.chat?.title || root.chat?.name || '');
}

function lrV31ExtractChatLinkFromApi(data) {
  const root = data?.chat || data?.result || data || {};
  return lrV31Clean(root.link || root.invite_link || root.inviteLink || root.chat?.link || root.chat?.invite_link || '', 800);
}

async function lrV31FetchChatInfo(chatId) {
  if (!chatId) return {};

  try {
    const r = await lrV31ApiGet(`/chats/${encodeURIComponent(String(chatId))}`);

    if (r.ok) {
      return {
        title: lrV31ExtractChatTitleFromApi(r.data),
        link: lrV31ExtractChatLinkFromApi(r.data),
        raw: r.data
      };
    }
  } catch (e) {
    console.error('[v31 core] fetch chat info failed', e?.message || e);
  }

  return {};
}

async function lrV31CheckBotAdmin(chatId) {
  if (!chatId) return { ok: false, admin: false, status: 0 };

  let last = { ok: false, admin: false, status: 0 };

  for (const path of [
    `/chats/${encodeURIComponent(String(chatId))}/members/me`,
    `/chats/${encodeURIComponent(String(chatId))}/members/me/`
  ]) {
    try {
      const r = await lrV31ApiGet(path);
      const box = r.data?.member || r.data?.user || r.data?.result || r.data?.profile || r.data?.payload || r.data || {};
      const perms = box.permissions || box.rights || box.chat_permissions || [];
      const permSet = new Set(Array.isArray(perms) ? perms.map(x => String(x).toLowerCase()) : []);

      const admin =
        box.is_admin === true ||
        box.isAdmin === true ||
        box.admin === true ||
        box.role === 'admin' ||
        box.role === 'administrator' ||
        permSet.has('write') ||
        permSet.has('edit') ||
        permSet.has('delete') ||
        permSet.has('read_all_messages') ||
        permSet.has('change_chat_info') ||
        permSet.has('add_remove_members');

      last = { ok: r.ok, admin, status: r.status, data: r.data };

      if (r.status !== 404) return last;
    } catch (e) {
      console.error('[v31 core] check admin failed', e?.message || e);
    }
  }

  return last;
}

async function lrV31UpsertChannel(chatId, title = '', link = '', isChannel = true) {
  await lrV31EnsureSchema();

  const id = lrV31Clean(chatId, 100);
  if (!id) throw new Error('Не найден chat_id канала.');

  let finalTitle = lrV31Clean(title, 300);
  let finalLink = lrV31Clean(link, 800);

  if (!finalTitle || /^канал$/i.test(finalTitle) || /^channel$/i.test(finalTitle)) {
    const info = await lrV31FetchChatInfo(id);
    finalTitle = lrV31Clean(info.title || finalTitle, 300);
    finalLink = lrV31Clean(info.link || finalLink, 800);
  }

  if (!finalTitle) finalTitle = `Канал ${id}`;

  const rows = lrV31Rows(await query(
    `INSERT INTO channels(max_chat_id, title, link, is_public, is_channel, is_active, bot_added_at, updated_at)
     VALUES($1,$2,$3,$4,$5,true,now(),now())
     ON CONFLICT(max_chat_id) DO UPDATE
       SET title=EXCLUDED.title,
           link=COALESCE(NULLIF(EXCLUDED.link,''), channels.link),
           is_public=EXCLUDED.is_public,
           is_channel=EXCLUDED.is_channel,
           is_active=true,
           bot_added_at=COALESCE(channels.bot_added_at, now()),
           updated_at=now()
     RETURNING id, max_chat_id, title, link, is_active, updated_at`,
    [String(id), finalTitle, finalLink || null, Boolean(finalLink), Boolean(isChannel)]
  ));

  const ch = rows[0] || { max_chat_id: id, title: finalTitle, link: finalLink, is_active: true };
  console.log('[v31 core] channel upserted', JSON.stringify({ id: ch.id, max_chat_id: ch.max_chat_id, title: ch.title }));
  return ch;
}

async function lrV31DeactivateChannel(chatId) {
  await lrV31EnsureSchema();

  const id = lrV31Clean(chatId, 100);
  if (!id) return null;

  const rows = lrV31Rows(await query(
    `UPDATE channels
     SET is_active=false, updated_at=now()
     WHERE max_chat_id=$1
     RETURNING id, max_chat_id, title, link, is_active, updated_at`,
    [String(id)]
  ));

  console.log('[v31 core] channel deactivated', JSON.stringify({ chat_id: id, found: Boolean(rows[0]) }));
  return rows[0] || null;
}

async function lrV31GetChannelsFromDb() {
  await lrV31EnsureSchema();

  return lrV31Rows(await query(
    `SELECT id, max_chat_id, title, link, is_active, updated_at
     FROM channels
     WHERE COALESCE(is_active,true)=true
     ORDER BY title NULLS LAST, id`
  ));
}

async function lrV31Send(chatId, text, rows = null) {
  rows = rows || [[callbackButton('⬅️ В меню', 'main:menu')]];

  if (typeof msg === 'function') {
    try {
      await msg(chatId, text, rows, 'html');
      console.log('[v31 core] msg sent', JSON.stringify({ chatId }));
      return true;
    } catch (e) {
      console.error('[v31 core] msg failed', e?.stack || e?.message || e);
    }
  }

  if (typeof sendMaxMessage === 'function') {
    try {
      const payload = { chatId, text, format: 'html' };
      if (typeof inlineKeyboard === 'function') payload.attachments = inlineKeyboard(rows);
      await sendMaxMessage(payload);
      console.log('[v31 core] sendMaxMessage sent', JSON.stringify({ chatId }));
      return true;
    } catch (e) {
      console.error('[v31 core] sendMaxMessage failed', e?.stack || e?.message || e);
    }
  }

  return false;
}

async function lrV31NotifyConnected(privateChatId, key, channel) {
  const title = lrV31Clean(channel?.title || '', 300);
  if (!title) return false;

  const lockKey = `lr_v31_channel_connected_notified:${privateChatId}:${channel.id || channel.max_chat_id}`;

  try {
    const rows = lrV31Rows(await query(
      `SELECT key FROM lr_bot_state WHERE key=$1 AND updated_at > now() - interval '2 minutes' LIMIT 1`,
      [lockKey]
    ));

    if (rows[0]) {
      console.log('[v31 core] duplicate connected notification skipped', JSON.stringify({ privateChatId, title }));
      return true;
    }
  } catch {}

  const ok = await lrV31Send(privateChatId, `✅ <b>Канал подключён к LinkRay</b>

${lrV31Esc(title)}

Канал сохранён в базе и теперь доступен для постов, автоподписей, аналитики и отчётов.`);

  if (ok) {
    await lrV31PutState(lockKey, { privateChatId, key, channel, ts: Date.now() }).catch(() => {});

    try {
      if (key && typeof clearSession === 'function') await clearSession(String(key));
    } catch {}

    await lrV31DelAddStates();

    console.log('[v31 core] connected notification done', JSON.stringify({
      privateChatId,
      key,
      id: channel.id,
      max_chat_id: channel.max_chat_id,
      title
    }));
  }

  return ok;
}

async function lrV31NotifyRemoved(privateChatId, channel) {
  /* LR_V37_REMOVED_PATCH */
  try {
    if (typeof lrV37NotifyChannelRemoved === 'function') {
      const ok = await lrV37NotifyChannelRemoved(channel, null, 'bot_removed_event');
      if (ok) return true;
    }
  } catch (e) {
    console.error('[v37 notify] lrV31NotifyRemoved patch failed', e?.message || e);
  }

  const title = lrV31Clean(channel?.title || 'канал', 300);

  await lrV31Send(privateChatId, `✅ <b>Канал удалён из LinkRay</b>

${lrV31Esc(title)}

Канал отключён в базе и больше не будет использоваться для постов, автоподписей, аналитики и отчётов.`);
}

async function lrV31NotifyFailed(privateChatId, errText = '') {
  return lrV31Send(privateChatId, `❌ <b>Канал не добавлен</b>

LinkRay не смог подтвердить права администратора или определить канал.

Проверьте:
1. LinkRay добавлен в администраторы канала.
2. Выдано право публикации.
3. Переслан именно пост из канала.

После этого перешлите другой пост из этого канала сюда, в бота.${errText ? `

Ошибка: ${lrV31Esc(errText)}` : ''}`);
}

async function lrV31BaselineChannelId() {
  try {
    const rows = lrV31Rows(await query(
      `SELECT id FROM channels ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`
    ));
    return Number(rows[0]?.id || 0);
  } catch {
    return 0;
  }
}

async function lrV31LatestChannelSince(startedAt, excludeId = 0) {
  try {
    const rows = lrV31Rows(await query(
      `SELECT id, max_chat_id, title, link, is_active, updated_at
       FROM channels
       WHERE updated_at >= $1::timestamptz - interval '10 seconds'
         AND trim(coalesce(title,'')) <> ''
         AND lower(trim(coalesce(title,''))) NOT IN ('канал','channel')
         AND ($2::int = 0 OR id <> $2::int)
       ORDER BY updated_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [startedAt.toISOString(), Number(excludeId || 0)]
    ));

    return rows[0] || null;
  } catch (e) {
    console.error('[v31 core] latest channel lookup failed', e?.stack || e?.message || e);
    return null;
  }
}

function lrV31StopWatcher() {
  try {
    if (globalThis.__lrV31WatcherTimer) clearInterval(globalThis.__lrV31WatcherTimer);
  } catch {}

  globalThis.__lrV31WatcherTimer = null;
}

function lrV31StartWatcher(state) {
  /* LR_CHANNEL_V4_DISABLE_LEGACY_WATCHER */
  lrV31StopWatcher();
  return null;
}

async function lrV31SetAddMode(privateChatId, key = '') {
  const resolvedPrivate = lrV31Clean(privateChatId || key || process.env.LR_OWNER_CHAT_ID || process.env.OWNER_CHAT_ID || process.env.ADMIN_CHAT_ID || '405954311') || '405954311';
  const resolvedKey = lrV31Clean(key || resolvedPrivate) || resolvedPrivate;
  const now = new Date();
  const baselineId = await lrV31BaselineChannelId();

  const state = {
    privateChatId: String(resolvedPrivate),
    chatId: String(resolvedPrivate),
    key: String(resolvedKey),
    ts: Date.now(),
    iso: now.toISOString(),
    startedAt: now.toISOString(),
    baselineId
  };

  globalThis.__lrV31AddWait = state;

  try {
    if (typeof setSession === 'function') {
      await setSession(state.key, 'wait_add_channel', {
        mode: 'add_channel',
        chatId: state.privateChatId,
        ts: state.ts,
        baselineId
      });
    }
  } catch (e) {
    console.error('[v31 core] setSession failed', e?.message || e);
  }

  try {
    await lrV31PutState('lr_v31_add_wait_global', state);
    await lrV31PutState(`lr_v31_add_wait:${state.privateChatId}`, state);
    await lrV31PutState(`lr_v31_add_wait:${state.key}`, state);
  } catch (e) {
    console.error('[v31 core] put add state failed', e?.stack || e?.message || e);
  }

  lrV31StartWatcher(state);
  console.log('[v31 core] add mode stored', JSON.stringify(state));
  return state;
}

async function lrV31GetAddMode(privateChatId, key) {
  const mem = globalThis.__lrV31AddWait;
  if (mem && Date.now() - Number(mem.ts || 0) < 30 * 60 * 1000) return mem;

  try {
    const state = await lrV31GetState([
      'lr_v31_add_wait_global',
      `lr_v31_add_wait:${privateChatId}`,
      `lr_v31_add_wait:${key}`
    ]);

    if (state) {
      globalThis.__lrV31AddWait = state;
      lrV31StartWatcher(state);
      return state;
    }
  } catch (e) {
    console.error('[v31 core] get add mode failed', e?.message || e);
  }

  try {
    if (key && typeof getSession === 'function') {
      const session = await getSession(String(key)).catch(() => null);
      if (session?.state === 'wait_add_channel') {
        return {
          privateChatId: lrV31Clean(privateChatId || key || '405954311') || '405954311',
          key: lrV31Clean(key || privateChatId || '405954311') || '405954311',
          ts: Date.now(),
          baselineId: await lrV31BaselineChannelId(),
          startedAt: new Date().toISOString()
        };
      }
    }
  } catch {}

  return null;
}

async function lrV31HandleAddForward(update) {
  /* LR_CHANNEL_V4_DISABLE_LEGACY_FORWARD */
  // Точный forwarded-post обрабатывает __lrCh3HandleForward().
  return false;
}

async function lrV31HandleBotAdded(update) {
  /* LR_CHANNEL_V4_DISABLE_LEGACY_BOT_ADDED */
  // Событие сохраняет действующий __lrCh3HandleBotAdded().
  return false;
}

async function lrV31HandleBotRemoved(update) {
  /* LR_CHANNEL_V4_DISABLE_LEGACY_BOT_REMOVED */
  // Событие обрабатывает действующий __lrCh3HandleBotRemoved().
  return false;
}

async function lrV31HandleTitleChanged(update) {
  const chatId = lrV31ChatId(update);
  if (!chatId) return false;

  const info = await lrV31FetchChatInfo(chatId);
  if (!info.title) return false;

  await lrV31UpsertChannel(chatId, info.title, info.link || '', true);
  return true;
}

async function lrV31ShowAddChannel(update) {
  const callbackId = lrV31CallbackId(update);
  const key = lrV31Key(update);
  const chatId = lrV31ChatId(update, key);
  const privateChatId = lrV31PrivateChatId(update, chatId || key);

  await lrV31SetAddMode(privateChatId, key || privateChatId);

  const text = `━━━━━━━━━━━━━━
🔗 <b>Добавить канал</b>

1. Откройте канал в MAX.
2. Добавьте LinkRay в администраторы.
3. Выдайте право публикации.
4. Перешлите любой пост из этого канала сюда, в бота.

Если LinkRay не является администратором — канал не будет добавлен.
━━━━━━━━━━━━━━`;

  const rows = [[callbackButton('⬅️ В меню', 'main:menu')]];

  if (callbackId && typeof cb === 'function') {
    await cb(callbackId, text, rows);
  } else {
    await lrV31Send(privateChatId, text, rows);
  }

  console.log('[v31 core] add channel screen shown', JSON.stringify({ privateChatId, chatId, key }));
  return true;
}

async function lrV31HandlePostCallback(update) {
  /* LR_V40_KEEP_ONLY_ADD_CHANNEL */
  {
    const __lrV40Payload = typeof lrV31Payload === 'function' ? lrV31Payload(update) : lrV40Payload(update);
    if (__lrV40Payload && __lrV40Payload !== 'post:add_channel') {
      console.log('[v40 buttons] pass post callback to native handler', JSON.stringify({ payload: __lrV40Payload }));
      return false;
    }
  }

  /* LR_V38_KEEP_ONLY_ADD_CHANNEL */
  {
    const __lrV38Payload = typeof lrV31Payload === 'function' ? lrV31Payload(update) : '';
    if (__lrV38Payload && __lrV38Payload !== 'post:add_channel') {
      console.log('[v38 restore] pass post callback to native handler', JSON.stringify({ payload: __lrV38Payload }));
      return false;
    }
  }

  const payload = lrV31Payload(update);
  if (!payload) return false;

  const callbackId = lrV31CallbackId(update);
  const key = lrV31Key(update);
  const chatId = lrV31ChatId(update, key) || lrV31PrivateChatId(update, key);

  if (payload === 'post:add_channel') return lrV31ShowAddChannel(update);

  if (payload === 'post:create') {
    const draft = emptyDraft();
    console.log('[v31 core] post:create', JSON.stringify({ chatId, key }));

    if (typeof showChannelSelect === 'function') return showChannelSelect(callbackId, key, draft, false);
    if (typeof lrV15SendChannelSelect === 'function') return lrV15SendChannelSelect(chatId, key, draft, false);
    return false;
  }

  if (payload === 'post:all') {
    console.log('[v31 core] post:all', JSON.stringify({ chatId, key }));

    if (typeof showPosts === 'function') return showPosts(callbackId, 'all', await defaultPostDay('all'), null, chatId);
    return lrV31Send(chatId, 'Посты пока недоступны.', [[callbackButton('⬅️ В Studio', 'main:posting')]]);
  }

  if (payload === 'post:cancel') {
    await lrV31DelAddStates();
    try {
      if (key && typeof clearSession === 'function') await clearSession(key);
    } catch {}
    return lrV31Send(chatId, '❌ Действие отменено.', [[callbackButton('⬅️ В меню', 'main:menu')]]);
  }

  if (payload === 'post:multi') {
    const session = await getSession(key);
    const draft = safeDraft(session.data);
    console.log('[v31 core] post:multi', JSON.stringify({ chatId, key }));
    return showChannelSelect(callbackId, key, draft, true);
  }

  if (payload.startsWith('post:toggle:')) {
    const id = Number(payload.split(':')[2]);
    const session = await getSession(key);
    const draft = safeDraft(session.data);
    const selected = new Set(draft.channelIds || []);
    selected.has(id) ? selected.delete(id) : selected.add(id);
    draft.channelIds = [...selected];

    console.log('[v31 core] post:toggle', JSON.stringify({ chatId, key, id, selected: draft.channelIds }));
    return showChannelSelect(callbackId, key, draft, true);
  }

  if (payload.startsWith('post:single:')) {
    const id = Number(payload.split(':')[2]);
    const session = await getSession(key);
    const draft = safeDraft(session.data);
    draft.channelIds = [id];

    console.log('[v31 core] post:single', JSON.stringify({ chatId, key, id }));

    if (typeof hasContent === 'function' && hasContent(draft)) {
      await setSession(key, 'edit_draft', { draft }).catch(() => {});
      await answerCallback({ callbackId, notification: 'Открываю редактор...' }).catch(() => {});
      return sendEditorAsNew(chatId, key, draft);
    }

    return askContent(callbackId, key, draft);
  }

  if (payload === 'post:all_channels') {
    const session = await getSession(key);
    const draft = safeDraft(session.data);
    draft.channelIds = (await getChannels()).map(c => Number(c.id));

    console.log('[v31 core] post:all_channels', JSON.stringify({ chatId, key, count: draft.channelIds.length }));

    if (typeof hasContent === 'function' && hasContent(draft)) {
      await setSession(key, 'edit_draft', { draft }).catch(() => {});
      await answerCallback({ callbackId, notification: 'Открываю редактор...' }).catch(() => {});
      return sendEditorAsNew(chatId, key, draft);
    }

    return askContent(callbackId, key, draft);
  }

  if (payload === 'post:channels_next') {
    const session = await getSession(key);
    const draft = safeDraft(session.data);

    if (!draft.channelIds.length) {
      return lrV31Send(chatId, 'Выберите хотя бы один канал.', [[callbackButton('⬅️ Назад', 'post:multi')]]);
    }

    if (typeof hasContent === 'function' && hasContent(draft)) {
      await setSession(key, 'edit_draft', { draft }).catch(() => {});
      await answerCallback({ callbackId, notification: 'Открываю редактор...' }).catch(() => {});
      return sendEditorAsNew(chatId, key, draft);
    }

    return askContent(callbackId, key, draft);
  }

  if (payload === 'post:change_channels') {
    const session = await getSession(key);
    return showChannelSelect(callbackId, key, safeDraft(session.data), false);
  }

  return false;
}

async function lrV31HandleUpdate(update) {
  const type = lrV31Type(update);

  if (type === 'bot_added') return lrV31HandleBotAdded(update);
  if (type === 'bot_removed') return lrV31HandleBotRemoved(update);
  if (type === 'chat_title_changed') return lrV31HandleTitleChanged(update);

  if (String(type).includes('callback')) {
    return lrV31HandlePostCallback(update);
  }

  return lrV31HandleAddForward(update);
}

function lrV31WebhookUrl() {
  const direct = lrV31Clean(
    process.env.WEBHOOK_URL ||
    process.env.MAX_WEBHOOK_URL ||
    process.env.PUBLIC_WEBHOOK_URL ||
    process.env.LINKRAY_WEBHOOK_URL ||
    '',
    1000
  );

  if (direct) return /\/webhook$/i.test(direct) ? direct : `${direct.replace(/\/+$/, '')}/webhook`;

  const base = lrV31Clean(
    process.env.PUBLIC_URL ||
    process.env.APP_URL ||
    process.env.BASE_URL ||
    process.env.LINKRAY_BOT_URL ||
    process.env.DOMAIN ||
    '',
    1000
  ).replace(/\/+$/, '');

  if (!base) return '';
  if (/\/webhook$/i.test(base)) return base;
  return `${base}/webhook`;
}

async function lrV31InstallSubscription() {
  try {
    const url = lrV31WebhookUrl();
    const token = lrV31ApiToken();

    if (!url || !token) {
      console.log('[v31 core] subscription skipped: no WEBHOOK_URL/PUBLIC_URL or token');
      return false;
    }

    const updateTypes = [
      'message_created',
      'message_callback',
      'bot_added',
      'bot_removed',
      'bot_started',
      'chat_title_changed', 'user_added', 'user_removed'];

    const body = {
      url,
      update_types: updateTypes
    };

    const secret = lrV31Clean(process.env.WEBHOOK_SECRET || process.env.MAX_WEBHOOK_SECRET || '', 256);
    if (secret) body.secret = secret;

    const r = await lrV31ApiPost('/subscriptions', body);

    await lrV31PutState('lr_v31_subscription_last', {
      url,
      updateTypes,
      ok: r.ok,
      status: r.status,
      response: r.data,
      ts: new Date().toISOString()
    }).catch(() => {});

    console.log('[v31 core] subscription install result', JSON.stringify({
      ok: r.ok,
      status: r.status,
      url,
      response: r.data
    }));

    return r.ok;
  } catch (e) {
    console.error('[v31 core] subscription install failed', e?.stack || e?.message || e);
    return false;
  }
}

try {
  setTimeout(() => {
    lrV31EnsureSchema().then(() => lrV31InstallSubscription()).catch(e => {
      console.error('[v31 core] startup failed', e?.stack || e?.message || e);
    });
  }, 2500).unref?.();
} catch {}

console.log('[v31 core] installed');
/* LR_MAX_SUBSCRIPTIONS_CORE_V31_END */
/* LR_PRIVATE_CHAT_SUBSCRIPTION_BRIDGE_V32_START */
app.use(async function lrPrivateChatSubscriptionBridgeV32(req, res, next) {
  try {
    if (req.method !== 'POST') return next();

    const incomingSecret = req.header('X-Max-Bot-Api-Secret');
    const expectedSecret = process.env.WEBHOOK_SECRET || process.env.MAX_WEBHOOK_SECRET || '';
    if (expectedSecret && incomingSecret && incomingSecret !== expectedSecret) return next();

    const update = req.body || {};
    const type = typeof lrV31Type === 'function' ? lrV31Type(update) : String(update?.type || update?.update_type || '');
    const payload = typeof lrV31Payload === 'function' ? lrV31Payload(update) : '';

    const isV31Callback =
      String(type).includes('callback') &&
      payload === 'post:add_channel';

    const isMaxChannelEvent =
      type === 'bot_added' ||
      type === 'bot_removed' ||
      type === 'chat_title_changed';

    // Для message_created проверяем режим "Добавить канал"; если режима нет, не мешаем старому автопостингу.
    let isAddForward = false;
    if (!String(type).includes('callback') && typeof lrV31GetAddMode === 'function') {
      const key = typeof lrV31Key === 'function' ? lrV31Key(update) : '';
      const chatId = typeof lrV31ChatId === 'function' ? lrV31ChatId(update, key) : '';
      const privateChatId = typeof lrV31PrivateChatId === 'function' ? lrV31PrivateChatId(update, chatId || key) : (chatId || key);
      const st = await lrV31GetAddMode(privateChatId || chatId, key).catch(() => null);
      isAddForward = Boolean(st);
    }

    if (isV31Callback || isMaxChannelEvent || isAddForward) {
      console.log('[v32 bridge] handling update', JSON.stringify({ type, payload, isV31Callback, isMaxChannelEvent, isAddForward }));

      const handled = await lrV31HandleUpdate(update);

      if (handled) {
        if (!res.headersSent) return res.json({ ok: true, handled: 'lr_private_chat_subscription_bridge_v32' });
        return;
      }
    }

    return next();
  } catch (e) {
    console.error('[v32 bridge] failed', e?.stack || e?.message || e);
    return next();
  }
});

console.log('[v32 bridge] installed');
/* LR_PRIVATE_CHAT_SUBSCRIPTION_BRIDGE_V32_END */
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

function getCallbackId(u) {
  return lrFirstNonEmpty(
    u?.callback?.callback_id,
    u?.callback?.callbackId,
    u?.callback?.id,

    u?.message_callback?.callback_id,
    u?.message_callback?.callbackId,
    u?.message_callback?.id,

    u?.messageCallback?.callback_id,
    u?.messageCallback?.callbackId,
    u?.messageCallback?.id,

    u?.callback_query?.id,
    u?.callbackQuery?.id,

    u?.body?.callback_id,
    u?.body?.callbackId,
    u?.body?.callback?.id,

    u?.message?.callback_id,
    u?.message?.callbackId,
    u?.message?.callback?.id,

    u?.callback_id,
    u?.callbackId,

    lrDeepFirst(u, ['callback_id', 'callbackId', 'callback_query_id', 'callbackQueryId'])
  ) || null;
}
function getCallbackPayload(u) {
  const candidates = [
    u?.callback?.payload,
    u?.callback?.button?.payload,
    u?.callback?.button?.data,
    u?.callback?.data,
    u?.callback?.value,

    u?.message_callback?.payload,
    u?.message_callback?.button?.payload,
    u?.message_callback?.button?.data,
    u?.message_callback?.button?.value,
    u?.message_callback?.data,
    u?.message_callback?.value,

    u?.messageCallback?.payload,
    u?.messageCallback?.button?.payload,
    u?.messageCallback?.button?.data,
    u?.messageCallback?.button?.value,
    u?.messageCallback?.data,
    u?.messageCallback?.value,

    u?.callback_query?.data,
    u?.callback_query?.payload,
    u?.callbackQuery?.data,
    u?.callbackQuery?.payload,

    u?.button?.payload,
    u?.button?.data,
    u?.button?.value,

    u?.body?.payload,
    u?.body?.data,
    u?.body?.button?.payload,
    u?.body?.button?.data,

    u?.message?.body?.payload,
    u?.message?.body?.data,
    u?.message?.payload,
    u?.message?.data,

    u?.payload,
    u?.data
  ];

  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    if (typeof c === 'string') return c;
    if (typeof c === 'number') return String(c);
    if (typeof c === 'object') {
      const v = c.payload || c.data || c.value || c.callback_data || c.callbackData;
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
  }

  const deep = lrDeepFirst(u, ['payload', 'callback_data', 'callbackData', 'data', 'value']);
  if (deep !== undefined && deep !== null && String(deep).trim() !== '') {
    if (typeof deep === 'object') {
      const v = deep.payload || deep.data || deep.value || deep.callback_data || deep.callbackData;
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
    return String(deep);
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
async function cb(callbackId, text, rows = [], format = 'html') {
  if (callbackId) {
    return answerCallback({ callbackId, text, format, attachments: buttonRows(rows) });
  }

  const fallbackChatId = globalThis.__lrLastCallbackChatId;
  if (fallbackChatId && typeof msg === 'function') {
    return msg(fallbackChatId, text, rows, format);
  }

  return null;
}
// LR_SAFE_SERVICE_GUARD_V2_START
function __lrSafeRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

function __lrServiceKind(text = '') {
  const t = String(text || '').toLowerCase();

  if (
    t.includes('канал добавлен в linkray') ||
    t.includes('канал сохранён в базе') ||
    t.includes('канал сохранен в базе')
  ) return 'channel_added';

  if (
    t.includes('команда не найдена') ||
    t.includes('нажмите /start') ||
    t.includes('главное меню') ||
    t.includes('linkray studio') ||
    t.includes('отправьте ссылку max-канала') ||
    t.includes('ежедневный отчёт пдп') ||
    t.includes('ежедневный отчет пдп')
  ) return 'service';

  return '';
}

async function __lrKnownChannelChatSafe(chatId) {
  try {
    const id = String(chatId || '').trim();
    if (!id) return false;

    if (typeof __lrIsKnownChannelChat === 'function') {
      const known = await __lrIsKnownChannelChat(id).catch(() => false);
      if (known) return true;
    }

    const cols = __lrSafeRows(await query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='channels'`
    ).catch(() => [])).map((r) => String(r.column_name));

    const allowed = [
      'id',
      'chat_id',
      'channel_id',
      'max_chat_id',
      'max_channel_id',
      'max_id',
      'external_id'
    ].filter((c) => cols.includes(c));

    if (!allowed.length) return false;

    const where = allowed.map((c) => `"${c}"::text=$1`).join(' OR ');
    const found = __lrSafeRows(await query(
      `SELECT 1 FROM public.channels WHERE ${where} LIMIT 1`,
      [id]
    ).catch(() => []));

    return found.length > 0;
  } catch {
    return false;
  }
}

async function __lrBlockServiceToChannel(chatId, text = '', buttons = []) {
  const kind = __lrServiceKind(text);
  const hasButtons = Array.isArray(buttons) && buttons.length > 0;
  const knownChannel = await __lrKnownChannelChatSafe(chatId).catch(() => false);

  if (knownChannel && (kind || hasButtons)) {
    console.log('[SKIP_CHANNEL_REPLY] service message blocked', JSON.stringify({
      chatId: String(chatId),
      kind: kind || 'buttons',
    }));
    return true;
  }

  return false;
}

async function __lrSkipDuplicateChannelAdded(chatId, text = '') {
  const kind = __lrServiceKind(text);
  if (kind !== 'channel_added') return false;

  try {
    await query(`
      CREATE TABLE IF NOT EXISTS public.lr_service_notice_dedupe (
        id bigserial PRIMARY KEY,
        chat_id text NOT NULL,
        kind text NOT NULL,
        fingerprint text NOT NULL,
        sent_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(chat_id, kind, fingerprint)
      )
    `);

    await query(`DELETE FROM public.lr_service_notice_dedupe WHERE sent_at < now() - interval '14 days'`).catch(() => {});

    const fingerprint = String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 350);

    const inserted = __lrSafeRows(await query(
      `INSERT INTO public.lr_service_notice_dedupe(chat_id, kind, fingerprint, sent_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(chat_id, kind, fingerprint) DO NOTHING
       RETURNING id`,
      [String(chatId), kind, fingerprint]
    ).catch(() => []));

    if (!inserted.length) {
      console.log('[SKIP_DUPLICATE_SERVICE] duplicate channel-added notice skipped', JSON.stringify({
        chatId: String(chatId),
      }));
      return true;
    }
  } catch {}

  return false;
}
// LR_SAFE_SERVICE_GUARD_V2_END

/* LR_NOTIFICATION_DEDUPE_V48_START */
function lrV48Rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}
function lrV48CleanText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function lrV48Hash(value) {
  const text = String(value || '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function lrV48OutgoingKind(text) {
  const t = lrV48CleanText(text).toLowerCase();
  const isRemove = /канал удал[её]н из linkray/i.test(t) || /канал отключ[её]н в базе/i.test(t) || /был удал[её]н из администраторов/i.test(t);
  const isAddSuccess = /канал подключ[её]н к linkray/i.test(t) || /канал сохран[её]н в базе/i.test(t);
  const isAddFail = /канал не добавлен/i.test(t) || /не смог подтвердить права/i.test(t) || /не смог подтвердить.*администратор/i.test(t) || /не удалось определить канал/i.test(t) || /бот не является администратором канала/i.test(t);
  if (isRemove) return 'remove';
  if (isAddSuccess) return 'add_success';
  if (isAddFail) return 'add_fail';
  return '';
}
async function lrV48StateGet(key) {
  try {
    const rows = lrV48Rows(await query(`SELECT value FROM lr_bot_state WHERE key=$1 LIMIT 1`, [key]));
    if (!rows[0]) return null;
    return typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
  } catch { return null; }
}
async function lrV48StateSet(key, value) {
  try {
    await query(
      `INSERT INTO lr_bot_state(key,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [key, JSON.stringify(value || {})]
    );
  } catch (e) { console.error('[v48 notify dedupe] state set failed', e?.message || e); }
}
async function lrV48RecentChannelAdded() {
  try {
    const rows = lrV48Rows(await query(
      `SELECT id, max_chat_id, title, updated_at
       FROM channels
       WHERE COALESCE(is_active,true)=true
         AND updated_at > now() - interval '8 minutes'
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`
    ));
    return rows[0] || null;
  } catch { return null; }
}
async function lrV48RecentlySent(key, ms) {
  const row = await lrV48StateGet(key);
  const ts = Number(row?.ts || 0);
  return Boolean(ts && Date.now() - ts < ms);
}
async function lrV48ShouldSuppressOutgoing(chatId, text, via = '') {
  const clean = lrV48CleanText(text);
  const kind = lrV48OutgoingKind(clean);
  if (!kind) return false;
  const chat = String(chatId || 'unknown').trim() || 'unknown';
  const textHash = lrV48Hash(clean.slice(0, 220));
  const exactKey = `lr_v48_notify_exact:${chat}:${kind}:${textHash}`;

  if (await lrV48RecentlySent(exactKey, kind === 'remove' ? 10 * 60 * 1000 : 90 * 1000)) {
    console.log('[v48 notify dedupe] suppressed exact duplicate', JSON.stringify({ chat, kind, via }));
    return true;
  }

  if (kind === 'add_success') {
    const successKey = `lr_v48_add_success:${chat}`;
    if (await lrV48RecentlySent(successKey, 90 * 1000)) {
      console.log('[v48 notify dedupe] suppressed duplicate add success', JSON.stringify({ chat, via }));
      return true;
    }
    await lrV48StateSet(successKey, { ts: Date.now(), text: clean.slice(0, 300), via });
    await lrV48StateSet(exactKey, { ts: Date.now(), text: clean.slice(0, 300), via });
    console.log('[v48 notify dedupe] allow add success', JSON.stringify({ chat, via }));
    return false;
  }

  if (kind === 'add_fail') {
    const successKey = `lr_v48_add_success:${chat}`;
    const hasRecentSuccess = await lrV48RecentlySent(successKey, 8 * 60 * 1000);
    const recentChannel = await lrV48RecentChannelAdded();
    if (hasRecentSuccess || recentChannel) {
      console.log('[v48 notify dedupe] suppressed false add failure after saved channel', JSON.stringify({
        chat, via, hasRecentSuccess, recentChannelId: recentChannel?.id || null, recentTitle: recentChannel?.title || null
      }));
      await lrV48StateSet(exactKey, { ts: Date.now(), suppressed: true, text: clean.slice(0, 300), via });
      return true;
    }
    if (await lrV48RecentlySent(exactKey, 3 * 60 * 1000)) {
      console.log('[v48 notify dedupe] suppressed duplicate add failure', JSON.stringify({ chat, via }));
      return true;
    }
    await lrV48StateSet(exactKey, { ts: Date.now(), text: clean.slice(0, 300), via });
    console.log('[v48 notify dedupe] allow add failure', JSON.stringify({ chat, via }));
    return false;
  }

  if (kind === 'remove') {
    await lrV48StateSet(exactKey, { ts: Date.now(), text: clean.slice(0, 300), via });
    console.log('[v48 notify dedupe] allow remove notification', JSON.stringify({ chat, via }));
    return false;
  }
  return false;
}
function lrV48ExtractOutgoing(args) {
  const first = args && args[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return { chatId: first.chatId || first.chat_id || first.recipient || first.to || '', text: first.text || first.body || first.message || '' };
  }
  return { chatId: args?.[0] || '', text: args?.[1] || '' };
}
function lrV48InstallRuntimeWrappers() {
  try {
    if (typeof msg === 'function' && !msg.__lrV48Wrapped) {
      const oldMsg = msg;
      const wrapped = async function(...args) {
        const out = lrV48ExtractOutgoing(args);
        if (await lrV48ShouldSuppressOutgoing(out.chatId, out.text, 'msg-wrapper')) return { ok: true, suppressed: true, v48: true };
        return oldMsg.apply(this, args);
      };
      wrapped.__lrV48Wrapped = true;
      msg = wrapped;
      console.log('[v48 notify dedupe] msg wrapper installed');
    }
  } catch (e) { console.error('[v48 notify dedupe] msg wrapper failed', e?.message || e); }

  try {
    if (typeof sendMaxMessage === 'function' && !sendMaxMessage.__lrV48Wrapped) {
      const oldSendMaxMessage = sendMaxMessage;
      const wrappedSend = async function(...args) {
        const out = lrV48ExtractOutgoing(args);
        if (await lrV48ShouldSuppressOutgoing(out.chatId, out.text, 'sendMaxMessage-wrapper')) return { ok: true, suppressed: true, v48: true };
        return oldSendMaxMessage.apply(this, args);
      };
      wrappedSend.__lrV48Wrapped = true;
      sendMaxMessage = wrappedSend;
      console.log('[v48 notify dedupe] sendMaxMessage wrapper installed');
    }
  } catch (e) { console.error('[v48 notify dedupe] sendMaxMessage wrapper failed', e?.message || e); }
}
try {
  setTimeout(lrV48InstallRuntimeWrappers, 2500);
  setTimeout(lrV48InstallRuntimeWrappers, 6000);
} catch {}
console.log('[v48 notify dedupe] installed');
/* LR_NOTIFICATION_DEDUPE_V48_END */

/* LR_V59_MSG_GUARD_HELPERS_START */
function lrV59MsgText(value) {
  const out = [];
  const seen = new WeakSet();
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const key of ['text','caption','message','body','notification','title','description']) {
      const v = node[key];
      if (typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object') walk(v);
    }
    if (Array.isArray(node)) for (const v of node) walk(v);
  };
  walk(value);
  return out.join('\n');
}
function lrV59MsgGuardDuplicateClickReport(payload) {
  const text = lrV59MsgText(payload).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const isReport = /Сводн(?:ый|ой)\s+отч[её]т|Публикации\s*:|Просмотры\s+за\s+24ч|Общие\s+просмотры/i.test(text);
  const hasClicks = /Уникальные\s+клики|Все\s+клики|Переходы\s+по\s+ссылкам|Красивый\s+отч[её]т\s*:|Все\s+переходы/i.test(text);
  return Boolean(isReport && hasClicks);
}
/* LR_V59_MSG_GUARD_HELPERS_END */

async function msg(chatId, text, rows = [], format = 'html') { if (typeof lrV59MsgGuardDuplicateClickReport === 'function' && lrV59MsgGuardDuplicateClickReport({ chatId, text, rows })) { console.log('[v59 report] dropped duplicate click report through msg', JSON.stringify({ chatId: String(chatId || ''), preview: String(text || '').slice(0, 180) })); return null; } 
  /* LR_V48_OUTGOING_DEDUPE_GUARD */
  try {
    let __v48Chat = '';
    let __v48Text = '';
    try {
      __v48Chat = (typeof chatId !== 'undefined')
        ? chatId
        : (arguments[0] && (arguments[0].chatId || arguments[0].chat_id || arguments[0].recipient || arguments[0].to));
    } catch {}
    try {
      __v48Text = (typeof text !== 'undefined')
        ? text
        : (arguments[0] && (arguments[0].text || arguments[0].body || arguments[0].message));
    } catch {}
    if (await lrV48ShouldSuppressOutgoing(__v48Chat, __v48Text, 'function-guard')) {
      return { ok: true, suppressed: true, v48: true };
    }
  } catch (e) {
    console.error('[v48 notify dedupe] function guard failed', e?.message || e);
  }

  if (await __lrBlockServiceToChannel(chatId, text, rows)) return null;
  if (await __lrSkipDuplicateChannelAdded(chatId, text)) return null;

  const target = lrBuildSendTarget(chatId);
  return sendMaxMessage({
    ...target,
    text,
    format,
    attachments: rows.length ? buttonRows(rows) : []
  });
}

async function sendMessage(chatId, { text = '', buttons = [], format = 'html' } = {}) {
  if (await __lrBlockServiceToChannel(chatId, text, buttons)) return null;
  if (await __lrSkipDuplicateChannelAdded(chatId, text)) return null;

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

/* LR_PLAN_DAY_LABEL_V60_START */
function lrV60MoscowDayKey(offsetDays = 0) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + Number(offsetDays || 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lrV60NormalizeDayKey(dayLike) {
  const raw = String(dayLike ?? '').trim();
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  const d = dayLike instanceof Date ? dayLike : new Date(raw);
  if (!d || Number.isNaN(d.getTime())) return lrV60MoscowDayKey(0);

  const msk = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  msk.setHours(12, 0, 0, 0);
  return `${msk.getFullYear()}-${String(msk.getMonth() + 1).padStart(2, '0')}-${String(msk.getDate()).padStart(2, '0')}`;
}

function lrV60PlanNavDayLabel(dayLike) {
  const day = lrV60NormalizeDayKey(dayLike);
  if (day === lrV60MoscowDayKey(0)) return 'Сегодня';
  if (day === lrV60MoscowDayKey(1)) return 'Завтра';
  if (day === lrV60MoscowDayKey(2)) return 'Послезавтра';

  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const text = dt.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Moscow',
  });
  return text.replace(/\s*г\.$/i, '');
}
/* LR_PLAN_DAY_LABEL_V60_END */


function dateButtonText(d) { return lrV60PlanNavDayLabel(d); }
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

async function __lrEnsureChannelsActiveColumn() {
  try {
    await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
  } catch (e) {
    console.error('[bot removed cleanup] ensure is_active', e?.message || e);
  }
}

function __lrRows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function __lrClean(value, max = 1200) {
  const text = String(value ?? '').trim();
  const low = text.toLowerCase();
  if (!text || text.length > max) return '';
  if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(low)) return '';
  return text;
}

function __lrNormTitle(value) {
  return __lrClean(value, 300)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function __lrIsBadChannelTitle(value) {
  const t = __lrNormTitle(value);
  return !t || t === 'кирилл' || t === 'kirill' || t === 'megamozg996' || t === 'linkray';
}

function __lrBotRemovedType(update) {
  const rawType = String(
    update?.type ||
    update?.update_type ||
    update?.event_type ||
    update?.event ||
    update?.body?.type ||
    ''
  ).toLowerCase();

  const raw = JSON.stringify(update || {}).toLowerCase();

  return (
    rawType.includes('bot_removed') ||
    rawType.includes('bot_left') ||
    rawType.includes('member_removed') ||
    rawType.includes('chat_member_removed') ||
    raw.includes('"bot_removed"') ||
    raw.includes('"bot_left"') ||
    raw.includes('"member_removed"') ||
    raw.includes('"chat_member_removed"') ||
    raw.includes('"removed"') && raw.includes('"bot"') && raw.includes('"channel"')
  );
}

function __lrBotRemovedCandidate(update) {
  function fromObj(obj) {
    if (!obj || typeof obj !== 'object') return null;

    const id = __lrClean(
      obj.max_chat_id ||
      obj.maxChatId ||
      obj.chat_id ||
      obj.chatId ||
      obj.channel_id ||
      obj.channelId ||
      obj.id ||
      obj.chat?.max_chat_id ||
      obj.chat?.chat_id ||
      obj.chat?.id ||
      obj.channel?.max_chat_id ||
      obj.channel?.chat_id ||
      obj.channel?.id ||
      obj.recipient?.chat_id ||
      obj.recipient?.id ||
      obj.source?.chat_id ||
      obj.source?.id
    );

    const title = __lrClean(
      obj.title ||
      obj.name ||
      obj.chat_title ||
      obj.chatTitle ||
      obj.channel_title ||
      obj.channelTitle ||
      obj.chat?.title ||
      obj.chat?.name ||
      obj.channel?.title ||
      obj.channel?.name ||
      obj.recipient?.title ||
      obj.recipient?.name ||
      obj.source?.title ||
      obj.source?.name,
      300
    );

    const link = __lrClean(
      obj.link ||
      obj.url ||
      obj.href ||
      obj.invite_link ||
      obj.inviteLink ||
      obj.public_link ||
      obj.publicLink ||
      obj.chat?.link ||
      obj.channel?.link ||
      obj.recipient?.link ||
      obj.source?.link
    );

    if (!id && !title && !link) return null;

    return {
      id,
      title: __lrIsBadChannelTitle(title) ? '' : title,
      link
    };
  }

  const direct = [
    update?.chat,
    update?.channel,
    update?.recipient,
    update?.source,
    update?.message?.chat,
    update?.message?.channel,
    update?.message?.recipient,
    update?.message?.source,
    update?.body?.chat,
    update?.body?.channel,
    update?.body?.recipient,
    update?.body?.source,
    update?.body?.message?.chat,
    update?.body?.message?.channel,
    update?.body?.message?.recipient,
    update?.body?.message?.source
  ];

  for (const obj of direct) {
    const c = fromObj(obj);
    if (c && (c.id || c.title || c.link)) return c;
  }

  let id = '';
  let title = '';
  let link = '';

  try { id = __lrClean(getChatId(update)); } catch {}
  try { title = __lrClean(getChatTitle(update), 300); } catch {}
  try { link = __lrClean(getChatLink(update)); } catch {}

  return {
    id,
    title: __lrIsBadChannelTitle(title) ? '' : title,
    link
  };
}

async function __lrDeactivateChannelAfterBotRemoved(update) {
  if (!__lrBotRemovedType(update)) return false;

  await __lrEnsureChannelsActiveColumn();

  const c = __lrBotRemovedCandidate(update);
  const id = __lrClean(c?.id);
  const title = __lrClean(c?.title, 300);
  const link = __lrClean(c?.link);
  const wanted = __lrNormTitle(title);

  let matchedIds = [];

  if (id || link) {
    const exact = await query(
      `SELECT id, max_chat_id, title, link
       FROM channels
       WHERE COALESCE(is_active, true) = true
         AND (
           ($1::text <> '' AND max_chat_id::text = $1)
           OR ($2::text <> '' AND link = $2)
         )
       ORDER BY updated_at DESC NULLS LAST, id DESC`,
      [id || '', link || '']
    ).catch((e) => {
      console.error('[bot removed cleanup] exact select', e?.message || e);
      return [];
    });

    matchedIds = __lrRows(exact).map((r) => Number(r.id)).filter(Boolean);
  }

  if (!matchedIds.length && wanted) {
    const all = await query(
      `SELECT id, max_chat_id, title, link
       FROM channels
       WHERE COALESCE(is_active, true) = true
       ORDER BY updated_at DESC NULLS LAST, id DESC
       LIMIT 1000`
    ).catch((e) => {
      console.error('[bot removed cleanup] title select', e?.message || e);
      return [];
    });

    for (const row of __lrRows(all)) {
      const rt = __lrNormTitle(row.title);
      if (!rt) continue;

      if (rt === wanted || rt.includes(wanted) || wanted.includes(rt)) {
        matchedIds.push(Number(row.id));
      }
    }
  }

  matchedIds = [...new Set(matchedIds)].filter(Boolean);

  if (matchedIds.length) {
    await query(
      `UPDATE channels
       SET is_active = false,
           updated_at = now()
       WHERE id = ANY($1::int[])`,
      [matchedIds]
    ).catch((e) => console.error('[bot removed cleanup] update channels', e?.message || e));

    await query(
      `UPDATE scheduled_posts
       SET status = 'deleted',
           updated_at = now()
       WHERE channel_id = ANY($1::int[])
         AND status::text = 'scheduled'`,
      [matchedIds]
    ).catch(() => {});

    await query(
      `UPDATE channel_signatures
       SET is_active = false,
           updated_at = now()
       WHERE channel_id = ANY($1::int[])`,
      [matchedIds]
    ).catch(() => {});

    console.log('[bot removed cleanup] channel deactivated', JSON.stringify({
      ids: matchedIds,
      maxChatId: id || null,
      title: title || null,
      link: link || null
    }));
  } else {
    console.log('[bot removed cleanup] bot_removed received but channel not found', JSON.stringify({
      maxChatId: id || null,
      title: title || null,
      link: link || null
    }));
  }

  // Событие удаления бота не должно идти дальше в обычные команды.
  return true;
}


/* LR_CHANNEL_V2_STABLE_MIN_START */
function lrChV2Rows(r){return Array.isArray(r)?r:(r?.rows||[])}
function lrChV2Clean(v,max=2500){const s=String(v??'').trim();const l=s.toLowerCase();if(!s||s.length>max)return'';if(['unknown','undefined','null','nan','[object object]'].includes(l))return'';return s}
function lrChV2Html(v){try{if(typeof escapeHtml==='function')return escapeHtml(v)}catch{}return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function lrChV2Norm(v){return lrChV2Clean(v,300).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim()}
function lrChV2BadTitle(v){const t=lrChV2Norm(v);return !t||['кирилл','kirill','megamozg996','linkray','бот'].includes(t)}
async function lrChV2Ensure(){await query(`CREATE TABLE IF NOT EXISTS lr_bot_state(key text PRIMARY KEY,value text,updated_at timestamptz NOT NULL DEFAULT now())`).catch(()=>{});await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`).catch(()=>{});await query(`UPDATE channels SET is_active=true WHERE is_active IS NULL`).catch(()=>{})}
function lrChV2Token(){return String(process.env.MAX_TOKEN||process.env.MAX_BOT_TOKEN||process.env.MAX_ACCESS_TOKEN||process.env.BOT_TOKEN||process.env.ACCESS_TOKEN||process.env.API_TOKEN||process.env.TOKEN||'')}
function lrChV2Base(){return String(process.env.MAX_API_BASE||process.env.MAX_BASE_URL||process.env.MAX_PLATFORM_API||'https://platform-api2.max.ru').replace(/\/+$/,'')}
async function lrChV2Get(path){const token=lrChV2Token();if(!token||typeof fetch!=='function')return{ok:false,status:0,temp:true,data:null,raw:''};for(const auth of [token,`Bearer ${token}`]){try{const r=await fetch(`${lrChV2Base()}${path}`,{method:'GET',headers:{Authorization:auth,Accept:'application/json'}});const raw=await r.text().catch(()=>'');let data=null;try{data=raw?JSON.parse(raw):null}catch{data=raw}console.log('[channel v2]',JSON.stringify({path,status:r.status,ok:r.ok,preview:raw.slice(0,160)}));if(r.ok)return{ok:true,status:r.status,data,raw};if([401,429,500,502,503,504].includes(Number(r.status)))return{ok:false,status:r.status,data,raw,temp:true};return{ok:false,status:r.status,data,raw,temp:false}}catch(e){console.error('[channel v2 api]',path,e?.message||e);return{ok:false,status:0,temp:true,data:null,raw:''}}}return{ok:false,status:0,temp:true,data:null,raw:''}}
function lrChV2Type(u){return String(u?.type||u?.update_type||u?.event_type||u?.event||u?.body?.type||'').toLowerCase()}
function lrChV2Text(u){try{const t=getMessageText(u);if(lrChV2Clean(t))return lrChV2Clean(t,7000)}catch{}return lrChV2Clean(u?.message?.body?.text||u?.message?.text||u?.body?.message?.body?.text||u?.body?.message?.text||u?.text||'',7000)}
function lrChV2Private(u){return lrChV2Clean(u?.chatId||u?.chat_id||u?.body?.chatId||u?.body?.chat_id||u?.message?.recipient?.chat_id||u?.message?.recipient?.id||u?.body?.message?.recipient?.chat_id||u?.body?.message?.recipient?.id)}
function lrChV2ChatId(u){try{const id=getChatId(u);if(lrChV2Clean(id))return lrChV2Clean(id)}catch{}return lrChV2Clean(u?.chat?.id||u?.channel?.id||u?.chat_id||u?.message?.chat?.id||u?.message?.recipient?.chat_id||u?.message?.recipient?.id||u?.body?.chat?.id||u?.body?.channel?.id||u?.body?.message?.chat?.id)}
function lrChV2Title(u){try{const t=getChatTitle(u);if(lrChV2Clean(t,300)&&!lrChV2BadTitle(t))return lrChV2Clean(t,300)}catch{}const t=lrChV2Clean(u?.chat?.title||u?.chat?.name||u?.channel?.title||u?.channel?.name||u?.message?.chat?.title||u?.message?.chat?.name||u?.message?.recipient?.title||u?.message?.recipient?.name||u?.body?.chat?.title||u?.body?.channel?.title||u?.body?.message?.chat?.title,300);return lrChV2BadTitle(t)?'':t}
function lrChV2Link(u){try{const l=getChatLink(u);if(lrChV2Clean(l))return lrChV2Clean(l)}catch{}return lrChV2Clean(u?.chat?.link||u?.channel?.link||u?.message?.chat?.link||u?.message?.recipient?.link||u?.body?.chat?.link||u?.body?.channel?.link||u?.body?.message?.chat?.link)}
function lrChV2Removed(u){const t=lrChV2Type(u),raw=JSON.stringify(u||{}).toLowerCase();return t.includes('bot_removed')||t.includes('bot_left')||t.includes('member_removed')||t.includes('chat_member_removed')||raw.includes('bot_removed')||raw.includes('bot_left')||(raw.includes('removed')&&raw.includes('bot')&&raw.includes('channel'))}
function lrChV2Added(u){const t=lrChV2Type(u),raw=JSON.stringify(u||{}).toLowerCase();return t.includes('bot_added')||t.includes('bot_started')||t.includes('member_added')||t.includes('chat_member_added')||raw.includes('bot_added')||raw.includes('bot_started')}
function lrChV2ChannelEvent(u){const t=lrChV2Type(u);if(lrChV2Added(u)||lrChV2Removed(u)||t.includes('channel'))return true;const types=[u?.chat?.type,u?.channel?.type,u?.message?.chat?.type,u?.message?.recipient?.type,u?.body?.chat?.type,u?.body?.channel?.type].map(x=>String(x||'').toLowerCase());return types.some(x=>x.includes('channel')||x==='chat')}
function lrChV2HasForward(u){const raw=JSON.stringify(u||{}).toLowerCase();return Boolean(u?.message?.link||u?.message?.body?.link||u?.body?.link||u?.link||u?.message?.forward||u?.message?.body?.forward||u?.forward||raw.includes('forward')||raw.includes('source')||raw.includes('link'))}
async function lrChV2Busy(u){let key='';try{key=lrChV2Clean(getSessionKey(u))}catch{}if(!key||typeof getSession!=='function')return false;try{const raw=JSON.stringify(await getSession(key).catch(()=>null)||{}).toLowerCase();return raw.includes('draft')||raw.includes('editor')||raw.includes('wait_post')||raw.includes('post_content')||raw.includes('schedule')||raw.includes('calendar')||raw.includes('signature')||raw.includes('autosign')}catch{return false}}
function lrChV2Strings(root){const out=[],seen=new WeakSet();function add(v){const s=lrChV2Clean(v,7000);if(s)out.push(s)}function walk(v,d=0){if(v==null||d>8)return;if(typeof v==='string'){add(v);return}if(typeof v!=='object'||seen.has(v))return;seen.add(v);if(Array.isArray(v)){for(const x of v)walk(x,d+1);return}for(const[k,ch]of Object.entries(v)){if(['text','title','name','caption','url','link','href'].includes(String(k).toLowerCase()))add(ch);if(ch&&typeof ch==='object')walk(ch,d+1)}}walk(root);return[...new Set(out)]}
function lrChV2TitleFromText(u){for(const t of lrChV2Strings(u)){const lines=String(t).split(/\n+/).map(x=>x.trim()).filter(Boolean);for(let i=lines.length-1;i>=0;i--){const line=lines[i].replace(/^[@#]+/,'').replace(/^[🔗📌✅➡️👉\-—–\s]+/,'').replace(/https?:\/\/\S+/gi,'').replace(/\s+/g,' ').trim();if(line.length>=3&&line.length<=120&&/[А-Яа-яA-Za-z]/.test(line)&&!lrChV2BadTitle(line))return line}}return''}
function lrChV2ObjCandidate(o,source,score,fallback){if(!o||typeof o!=='object')return null;const raw=JSON.stringify(o||'').toLowerCase();if((raw.includes('first_name')||raw.includes('last_name')||raw.includes('username'))&&!raw.includes('title')&&!raw.includes('channel'))return null;const id=lrChV2Clean(o.max_chat_id||o.maxChatId||o.chat_id||o.chatId||o.channel_id||o.channelId||o.id||o.source_chat_id||o.sourceChatId||o.chat?.id||o.chat?.chat_id||o.channel?.id||o.channel?.chat_id||o.recipient?.id||o.recipient?.chat_id||o.source?.id||o.source?.chat_id);let title=lrChV2Clean(o.title||o.name||o.chat_title||o.chatTitle||o.channel_title||o.channelTitle||o.source_title||o.sourceTitle||o.chat?.title||o.chat?.name||o.channel?.title||o.channel?.name||o.recipient?.title||o.recipient?.name||o.source?.title||o.source?.name,300);if(lrChV2BadTitle(title))title=fallback||'';const link=lrChV2Clean(o.link||o.url||o.href||o.invite_link||o.inviteLink||o.public_link||o.publicLink||o.chat?.link||o.channel?.link||o.recipient?.link||o.source?.link);if(!id&&!link)return null;if(!title||lrChV2BadTitle(title))return null;return{id:id||link,title,link:link||null,source,score}}
function lrChV2Candidates(u){const fallback=lrChV2TitleFromText(u),privateId=lrChV2Private(u),out=[],seen=new WeakSet();function add(o,src,score){const c=lrChV2ObjCandidate(o,src,score,fallback);if(c&&!(privateId&&String(c.id)===String(privateId)))out.push(c)}[u?.chat,u?.channel,u?.message?.link?.chat,u?.message?.body?.link?.chat,u?.body?.link?.chat,u?.link?.chat,u?.message?.link?.message?.chat,u?.message?.link?.message?.recipient,u?.message?.forward?.message?.chat,u?.message?.forward?.message?.recipient,u?.forward?.message?.chat,u?.forward?.message?.recipient,u?.message?.source,u?.body?.message?.source,u?.message?.channel,u?.body?.message?.channel].filter(Boolean).forEach((x,i)=>add(x,'direct',10000-i));function walk(o,d=0,path=''){if(!o||typeof o!=='object'||d>8||seen.has(o))return;seen.add(o);if(/forward|link|message|recipient|chat|channel|source/i.test(path))add(o,path,900-d);if(Array.isArray(o)){for(const it of o)walk(it,d+1,path);return}for(const[k,v]of Object.entries(o))if(v&&typeof v==='object')walk(v,d+1,path?`${path}.${k}`:k)}walk(u);for(const text of lrChV2Strings(u)){if(!/(max\.ru|i\.oneme\.ru|:\/\/|join\/)/i.test(text))continue;if(fallback&&!lrChV2BadTitle(fallback))out.push({id:text,title:fallback,link:text,source:'text_link',score:5000})}const m=new Map();for(const c of out){const k=`${c.id||''}::${c.link||''}::${lrChV2Norm(c.title)}`;if(!m.has(k)||c.score>m.get(k).score)m.set(k,c)}return[...m.values()].sort((a,b)=>b.score-a.score).slice(0,15)}
function lrChV2Variants(v){const raw=lrChV2Clean(v,2000);if(!raw)return[];const out=new Set();function add(x){x=lrChV2Clean(x,700);if(!x)return;x=x.replace(/^@+/,'').replace(/^https?:\/\//i,'').replace(/^max\.ru\//i,'').replace(/^i\.oneme\.ru\/i\?r=/i,'').split(/[?#]/)[0].replace(/^\/+|\/+$/g,'');if(x)out.add(x);if(x.startsWith('join/'))out.add(x.slice(5));const last=x.split('/').filter(Boolean).pop();if(last)out.add(last)}add(raw);try{const u=new URL(raw);add(u.pathname);add(u.pathname.split('/').filter(Boolean).pop()||'');const r=u.searchParams.get('r');if(r)add(r)}catch{}return[...out].filter(x=>x&&x.length>=3)}
function lrChV2Admin(data){const raw=JSON.stringify(data||{}).toLowerCase();if(data?.is_admin===true||data?.isAdmin===true||data?.admin===true||data?.is_owner===true||data?.isOwner===true||data?.owner===true||data?.member?.is_admin===true||data?.member?.isAdmin===true||data?.member?.is_owner===true||data?.member?.isOwner===true)return true;const perms=[].concat(data?.permissions||[],data?.rights||[],data?.available_permissions||[],data?.availablePermissions||[],data?.member?.permissions||[],data?.member?.rights||[],data?.access||[]);const txt=perms.map(x=>typeof x==='string'?x:JSON.stringify(x||'')).join(' ').toLowerCase();return/(write|send|post|publish|message|manage|admin|editor)/i.test(txt)||/"is_admin"\s*:\s*true|isadmin"\s*:\s*true|"admin"\s*:\s*true|"owner"\s*:\s*true/.test(raw)}
async function lrChV2BotAdmin(chatId){const id=lrChV2Clean(chatId);if(!id)return false;const r=await lrChV2Get(`/chats/${encodeURIComponent(id)}/members/me`);if(r.ok){const a=lrChV2Admin(r.data);console.log('[channel v2 members/me]',JSON.stringify({chatId:id,status:r.status,admin:a}));return a}if(r.temp)return null;return false}
async function lrChV2Resolve(c){const id=lrChV2Clean(c?.id),link=lrChV2Clean(c?.link),title=lrChV2Clean(c?.title,300);if(/^-?\d+$/.test(id))return{max_chat_id:id,title,link:link||null};for(const v of[...new Set([id,link].filter(Boolean).flatMap(lrChV2Variants))]){const r=await lrChV2Get(`/chats/${encodeURIComponent(v)}`);if(!r.ok)continue;const info=r.data?.chat||r.data?.result||r.data;const chatId=lrChV2Clean(info?.chat_id||info?.chatId||info?.id||info?.chat?.chat_id||info?.chat?.id);const name=lrChV2Clean(info?.title||info?.name||info?.chat?.title||info?.chat?.name||title,300);const pub=lrChV2Clean(info?.link||info?.chat?.link||link||id);if(chatId&&name&&!lrChV2BadTitle(name))return{max_chat_id:chatId,title:name,link:pub||null}}return null}
async function lrChV2Upsert(chatId,title,link=null){await lrChV2Ensure();const id=lrChV2Clean(chatId),name=lrChV2Clean(title,300),url=lrChV2Clean(link);if(!id||!name||lrChV2BadTitle(name))return null;const res=await query(`INSERT INTO channels(max_chat_id,title,link,is_public,is_channel,is_active,bot_added_at,updated_at) VALUES($1,$2,$3,$4,true,true,now(),now()) ON CONFLICT(max_chat_id) DO UPDATE SET title=COALESCE(EXCLUDED.title,channels.title),link=COALESCE(EXCLUDED.link,channels.link),is_public=EXCLUDED.is_public,is_channel=true,is_active=true,bot_added_at=COALESCE(channels.bot_added_at,now()),updated_at=now() RETURNING id,max_chat_id,title,link,is_active`,[String(id),name,url||null,Boolean(url)]).catch(e=>{console.error('[channel v2 upsert]',e?.message||e);return[]});const row=lrChV2Rows(res)[0]||{max_chat_id:id,title:name,link:url||null};console.log('[channel v2 saved]',JSON.stringify({id:row.id||null,max_chat_id:row.max_chat_id,title:row.title,link:row.link||null}));return row}
async function lrChV2Find(cands){const ids=[...new Set(cands.map(c=>lrChV2Clean(c.id)).filter(Boolean))],links=[...new Set(cands.map(c=>lrChV2Clean(c.link)).filter(Boolean))];const exact=await query(`SELECT id,max_chat_id,title,link FROM channels WHERE ($1::text[]<>'{}'::text[] AND max_chat_id::text=ANY($1::text[])) OR ($2::text[]<>'{}'::text[] AND link=ANY($2::text[])) ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 1`,[ids,links]).catch(()=>[]);if(lrChV2Rows(exact)[0])return lrChV2Rows(exact)[0];const all=await query(`SELECT id,max_chat_id,title,link FROM channels ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 1000`).catch(()=>[]);for(const row of lrChV2Rows(all)){const rt=lrChV2Norm(row.title);for(const c of cands){const ct=lrChV2Norm(c.title);if(ct&&ct.length>=5&&(rt===ct||rt.includes(ct)||ct.includes(rt)))return row}}return null}
async function lrChV2Send(u,text,rows=[[callbackButton('⬅️ В меню','main:menu')]]){const chat=lrChV2Private(u)||lrChV2ChatId(u);if(!chat)return;return msg(chat,text,rows,'html').catch(e=>console.error('[channel v2 send]',e?.message||e))}
async function lrChV2Delete(ids,reason='unknown'){ids=[...new Set((Array.isArray(ids)?ids:[]).map(Number).filter(Boolean))];if(!ids.length)return 0;await lrChV2Ensure();console.log('[channel v2 deleting]',JSON.stringify({ids,reason}));await query(`UPDATE channels SET is_active=false,updated_at=now() WHERE id=ANY($1::int[])`,[ids]).catch(()=>{});const refs=await query(`SELECT table_schema,table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='channel_id' AND table_name<>'channels' ORDER BY table_name`).catch(()=>[]);for(const r of lrChV2Rows(refs)){const schema=String(r.table_schema||'public').replace(/"/g,'""'),table=String(r.table_name||'').replace(/"/g,'""');if(!table)continue;await query(`DELETE FROM "${schema}"."${table}" WHERE channel_id=ANY($1::int[])`,[ids]).catch(e=>console.error('[channel v2 child delete]',schema,table,e?.message||e))}const del=await query(`DELETE FROM channels WHERE id=ANY($1::int[]) RETURNING id,max_chat_id,title`,[ids]).catch(()=>[]);console.log('[channel v2 deleted]',JSON.stringify(lrChV2Rows(del)));return lrChV2Rows(del).length}
async function lrChV2HandleRemoved(u){if(!lrChV2Removed(u))return false;await lrChV2Ensure();const id=lrChV2ChatId(u),title=lrChV2Title(u),link=lrChV2Link(u),wanted=lrChV2Norm(title);let ids=[];if(id||link){const exact=await query(`SELECT id FROM channels WHERE ($1::text<>'' AND max_chat_id::text=$1) OR ($2::text<>'' AND link=$2)`,[id||'',link||'']).catch(()=>[]);ids=lrChV2Rows(exact).map(r=>Number(r.id)).filter(Boolean)}if(!ids.length&&wanted){const all=await query(`SELECT id,title FROM channels ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 1000`).catch(()=>[]);for(const r of lrChV2Rows(all)){const rt=lrChV2Norm(r.title);if(rt&&(rt===wanted||rt.includes(wanted)||wanted.includes(rt)))ids.push(Number(r.id))}}await lrChV2Delete(ids,'bot_removed');return true}
async function lrChV2HandleAdded(u){if(!lrChV2Added(u)&&!lrChV2ChannelEvent(u))return false;const privateId=lrChV2Private(u),chatId=lrChV2ChatId(u),title=lrChV2Title(u),link=lrChV2Link(u);if(!chatId||!title||lrChV2BadTitle(title))return false;if(privateId&&String(privateId)===String(chatId))return false;await lrChV2Upsert(chatId,title,link);return false}
async function lrChV2HandleForward(u){const text=lrChV2Text(u);if(text.startsWith('/'))return false;if(!lrChV2HasForward(u))return false;if(await lrChV2Busy(u)){console.log('[channel v2 skip forward: busy session]');return false}const cands=lrChV2Candidates(u);console.log('[channel v2 candidates]',JSON.stringify(cands.map(c=>({id:c.id,title:c.title,link:c.link,src:c.source,score:c.score})).slice(0,10)));if(!cands.length)return false;let last=cands[0]?.title||'Канал';for(const c of cands){last=c.title||last;const r=await lrChV2Resolve(c);if(!r?.max_chat_id)continue;const admin=await lrChV2BotAdmin(r.max_chat_id);if(admin===true){const saved=await lrChV2Upsert(r.max_chat_id,r.title||c.title,r.link||c.link||null);/* LR_PROFILE_V2_CHANNEL_LINK_V1 */await lrProfileLinkChannel(lrProfileMaxUserId(u), saved?.id).catch((e)=>console.error('[LR profile channel V2]',e?.message||e));if(saved){await query(`DELETE FROM lr_bot_state WHERE key LIKE 'lr_add_channel_wait:%' OR key LIKE 'lr_admin_channel%' OR key LIKE 'pending_channel_add%'`).catch(()=>{});await lrChV2Send(u,`✅ <b>Канал подключён к LinkRay</b>\n\n${lrChV2Html(saved.title||r.title||c.title)}\n\nКанал сохранён в базе и теперь доступен для постов, автоподписей, аналитики и отчётов.`);return true}}if(admin===null){await lrChV2Send(u,`⚠️ <b>Не удалось проверить права LinkRay</b>\n\nКанал: <b>${lrChV2Html(r.title||c.title)}</b>\n\nПроверьте, что бот добавлен в администраторы и выдано право публикации, затем перешлите пост ещё раз.`);return true}}const old=await lrChV2Find(cands);if(old?.max_chat_id){const admin=await lrChV2BotAdmin(old.max_chat_id);if(admin===true){const saved=await lrChV2Upsert(old.max_chat_id,old.title||last,old.link||cands[0]?.link||null);await lrChV2Send(u,`✅ <b>Канал подключён к LinkRay</b>\n\n${lrChV2Html(saved.title||old.title||last)}\n\nКанал сохранён в базе и теперь доступен для постов, автоподписей, аналитики и отчётов.`);return true}}await lrChV2Send(u,`❌ <b>Бот не является администратором канала</b>\n\nКанал: <b>${lrChV2Html(last)}</b>\n\nСначала добавьте LinkRay в администраторы канала и выдайте право публикации.\n\nПосле этого снова перешлите любой пост из этого канала сюда, в бота.\n\nКанал не добавлен в базу.`);return true}
async function lrChV2Sweep(){await lrChV2Ensure();const key='lr_channel_v2_sweep_last';const last=await query(`SELECT updated_at FROM lr_bot_state WHERE key=$1 LIMIT 1`,[key]).catch(()=>[]);const row=lrChV2Rows(last)[0];if(row?.updated_at&&Date.now()-new Date(row.updated_at).getTime()<60000)return;await query(`INSERT INTO lr_bot_state(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[key,JSON.stringify({ts:Date.now()})]).catch(()=>{});const ch=await query(`SELECT id,max_chat_id,title FROM channels WHERE COALESCE(is_active,true)=true ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 300`).catch(()=>[]);const remove=[];for(const c of lrChV2Rows(ch)){const admin=await lrChV2BotAdmin(c.max_chat_id);if(admin===false)remove.push(Number(c.id))}if(remove.length)await lrChV2Delete(remove,'members_me_sweep')}
async function lrChV2Handle(u){await lrChV2Ensure();if(await lrChV2HandleRemoved(u))return true;await lrChV2HandleAdded(u).catch(e=>console.error('[channel v2 added]',e?.message||e));await lrChV2Sweep().catch(e=>console.error('[channel v2 sweep]',e?.message||e));if(await lrChV2HandleForward(u))return true;return false}
/* LR_CHANNEL_V2_STABLE_MIN_END */

/* LR_CHANNEL_ADD_V3_FINAL_START */
function __lrCh3Rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function __lrCh3Clean(value, max = 4000) {
  const text = String(value ?? '').trim();
  const low = text.toLowerCase();

  if (!text || text.length > max) return '';
  if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(low)) return '';

  return text;
}

function __lrCh3Esc(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
  } catch {}

  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function __lrCh3Norm(value) {
  return __lrCh3Clean(value, 300)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function __lrCh3BadTitle(value) {
  const t = __lrCh3Norm(value);
  return !t || t === 'кирилл' || t === 'kirill' || t === 'megamozg996' || t === 'linkray' || t === 'бот';
}

function __lrCh3PrivateChatId(update) {
  /* LR_CHANNEL_NOTIFY_V4_2_PRIVATE_CHAT */
  const candidates = [
    update?.message?.recipient?.chat_id,
    update?.message?.recipient?.chatId,
    update?.body?.message?.recipient?.chat_id,
    update?.body?.message?.recipient?.chatId,
    update?.callback?.message?.recipient?.chat_id,
    update?.callback?.message?.recipient?.chatId,
    update?.body?.callback?.message?.recipient?.chat_id,
    update?.body?.callback?.message?.recipient?.chatId,
    update?.recipient?.chat_id,
    update?.recipient?.chatId,
    update?.chat_id,
    update?.chatId,
    update?.body?.chat_id,
    update?.body?.chatId,
  ];

  for (const value of candidates) {
    const id = __lrCh3Clean(value, 100);

    if (/^\d{5,}$/.test(id)) {
      return id;
    }
  }

  try {
    if (typeof getChatId === 'function') {
      const id = __lrCh3Clean(
        getChatId(update),
        100
      );

      if (/^\d{5,}$/.test(id)) {
        return id;
      }
    }
  } catch {}

  const senderCandidates = [
    update?.message?.sender?.user_id,
    update?.message?.sender?.userId,
    update?.body?.message?.sender?.user_id,
    update?.body?.message?.sender?.userId,
    update?.sender?.user_id,
    update?.sender?.userId,
    update?.user?.user_id,
    update?.user?.userId,
  ];

  for (const value of senderCandidates) {
    const id = __lrCh3Clean(value, 100);

    if (/^\d{5,}$/.test(id)) {
      return id;
    }
  }

  return '';
}

function __lrCh3AnyChatId(update) {
  try {
    const id = getChatId(update);
    if (__lrCh3Clean(id)) return __lrCh3Clean(id);
  } catch {}

  return __lrCh3Clean(
    update?.chat?.id ||
    update?.chat_id ||
    update?.message?.chat?.id ||
    update?.body?.message?.chat?.id ||
    update?.channel?.id ||
    update?.body?.channel?.id ||
    update?.message?.recipient?.chat_id ||
    update?.message?.recipient?.id ||
    update?.body?.message?.recipient?.chat_id ||
    update?.body?.message?.recipient?.id
  );
}

function __lrCh3GetTitle(update) {
  try {
    const title = getChatTitle(update);
    if (__lrCh3Clean(title, 300) && !__lrCh3BadTitle(title)) return __lrCh3Clean(title, 300);
  } catch {}

  const title = __lrCh3Clean(
    update?.chat?.title ||
    update?.chat?.name ||
    update?.channel?.title ||
    update?.channel?.name ||
    update?.message?.chat?.title ||
    update?.message?.chat?.name ||
    update?.message?.recipient?.title ||
    update?.body?.chat?.title ||
    update?.body?.channel?.title ||
    update?.body?.message?.chat?.title ||
    update?.body?.message?.recipient?.title,
    300
  );

  return __lrCh3BadTitle(title) ? '' : title;
}

function __lrCh3GetLink(update) {
  try {
    const link = getChatLink(update);
    if (__lrCh3Clean(link, 1200)) return __lrCh3Clean(link, 1200);
  } catch {}

  return __lrCh3Clean(
    update?.chat?.link ||
    update?.channel?.link ||
    update?.message?.chat?.link ||
    update?.message?.recipient?.link ||
    update?.body?.chat?.link ||
    update?.body?.channel?.link ||
    update?.body?.message?.chat?.link ||
    update?.body?.message?.recipient?.link ||
    update?.link,
    1200
  );
}

function __lrCh3Type(update) {
  return String(
    update?.type ||
    update?.update_type ||
    update?.event_type ||
    update?.event ||
    update?.body?.type ||
    ''
  ).toLowerCase();
}

function __lrCh3IsBotAdded(update) {
  const type = __lrCh3Type(update);
  const raw = JSON.stringify(update || {}).toLowerCase();

  return (
    type.includes('bot_added') ||
    type.includes('bot_started') ||
    type.includes('chat_member_added') ||
    raw.includes('"bot_added"') ||
    raw.includes('"bot_started"') ||
    raw.includes('"chat_member_added"')
  );
}

function __lrCh3IsBotRemoved(update) {
  const type = __lrCh3Type(update);
  const raw = JSON.stringify(update || {}).toLowerCase();

  return (
    type.includes('bot_removed') ||
    type.includes('bot_left') ||
    type.includes('chat_member_removed') ||
    raw.includes('"bot_removed"') ||
    raw.includes('"bot_left"') ||
    raw.includes('"chat_member_removed"') ||
    (raw.includes('"removed"') && raw.includes('"bot"') && raw.includes('"channel"'))
  );
}

function __lrCh3IsPrivateUpdate(update) {
  const id = __lrCh3PrivateChatId(update);
  const any = __lrCh3AnyChatId(update);

  if (id && any && String(id) === String(any)) return true;

  const types = [
    update?.chat?.type,
    update?.message?.chat?.type,
    update?.message?.recipient?.type,
    update?.message?.recipient?.chat_type,
    update?.message?.recipient?.recipient_type,
    update?.body?.chat?.type,
    update?.body?.message?.chat?.type,
    update?.body?.message?.recipient?.type,
    update?.chat_type,
    update?.recipient_type
  ].map((x) => String(x || '').toLowerCase()).filter(Boolean);

  if (types.some((x) => x.includes('dialog') || x.includes('private') || x === 'user')) return true;

  return false;
}

function __lrCh3Text(update) {
  try {
    const text = getMessageText(update);
    if (__lrCh3Clean(text, 6000)) return __lrCh3Clean(text, 6000);
  } catch {}

  return __lrCh3Clean(
    update?.message?.body?.text ||
    update?.message?.text ||
    update?.body?.message?.body?.text ||
    update?.body?.message?.text ||
    update?.text ||
    '',
    6000
  );
}

function __lrCh3HasForwardEvidence(update) {
  const raw = JSON.stringify(update || {}).toLowerCase();

  return Boolean(
    update?.message?.link ||
    update?.message?.body?.link ||
    update?.body?.link ||
    update?.link ||
    update?.message?.forward ||
    update?.message?.body?.forward ||
    update?.forward ||
    raw.includes('"forward"') ||
    raw.includes('"forwarded"') ||
    raw.includes('"source"') ||
    raw.includes('"sender_chat"') ||
    raw.includes('"link"') ||
    raw.includes('"chat_id"') ||
    raw.includes('"channel"')
  );
}

function __lrCh3AllStrings(root) {
  const out = [];
  const seen = new WeakSet();

  function add(v) {
    const text = __lrCh3Clean(v, 7000);
    if (text) out.push(text);
  }

  function walk(v, depth = 0) {
    if (v == null || depth > 10) return;

    if (typeof v === 'string') {
      add(v);
      return;
    }

    if (typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);

    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }

    for (const [k, child] of Object.entries(v)) {
      const key = String(k || '').toLowerCase();

      if (['text', 'title', 'name', 'caption', 'url', 'link', 'href', 'chat_id', 'channel_id', 'id'].includes(key)) {
        if (typeof child !== 'object') add(child);
      }

      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  }

  walk(root);

  return [...new Set(out)];
}

function __lrCh3TitleFromText(update) {
  const strings = __lrCh3AllStrings(update);

  for (const text of strings) {
    const lines = String(text)
      .split(/\n+/)
      .map((x) => x.trim())
      .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
        .replace(/^[@#]+/, '')
        .replace(/^[🔗📌✅➡️👉\-—–\s]+/, '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (line.length >= 3 && line.length <= 120 && /[А-Яа-яA-Za-z]/.test(line) && !__lrCh3BadTitle(line)) {
        return line;
      }
    }
  }

  return '';
}

function __lrCh3CandidateFromObject(obj, source, score, fallbackTitle) {
  if (!obj || typeof obj !== 'object') return null;

  const raw = JSON.stringify(obj || '').toLowerCase();

  // Не берём личный профиль как канал.
  if (
    (raw.includes('"first_name"') || raw.includes('"last_name"') || raw.includes('"username"')) &&
    !raw.includes('"title"') &&
    !raw.includes('"channel"') &&
    !raw.includes('"chat"')
  ) {
    return null;
  }

  const id = __lrCh3Clean(
    obj.max_chat_id ||
    obj.maxChatId ||
    obj.chat_id ||
    obj.chatId ||
    obj.channel_id ||
    obj.channelId ||
    obj.id ||
    obj.source_chat_id ||
    obj.sourceChatId ||
    obj.sender_chat_id ||
    obj.senderChatId ||
    obj.chat?.max_chat_id ||
    obj.chat?.chat_id ||
    obj.chat?.id ||
    obj.channel?.max_chat_id ||
    obj.channel?.chat_id ||
    obj.channel?.id ||
    obj.recipient?.chat_id ||
    obj.recipient?.id ||
    obj.source?.chat_id ||
    obj.source?.id ||
    obj.sender_chat?.id ||
    obj.sender_chat?.chat_id
  );

  let title = __lrCh3Clean(
    obj.title ||
    obj.name ||
    obj.chat_title ||
    obj.chatTitle ||
    obj.channel_title ||
    obj.channelTitle ||
    obj.source_title ||
    obj.sourceTitle ||
    obj.sender_chat_title ||
    obj.senderChatTitle ||
    obj.chat?.title ||
    obj.chat?.name ||
    obj.channel?.title ||
    obj.channel?.name ||
    obj.recipient?.title ||
    obj.source?.title ||
    obj.source?.name ||
    obj.sender_chat?.title ||
    obj.sender_chat?.name,
    300
  );

  if (__lrCh3BadTitle(title)) title = fallbackTitle || '';

  const link = __lrCh3Clean(
    obj.link ||
    obj.url ||
    obj.href ||
    obj.invite_link ||
    obj.inviteLink ||
    obj.public_link ||
    obj.publicLink ||
    obj.chat?.link ||
    obj.channel?.link ||
    obj.recipient?.link ||
    obj.source?.link ||
    obj.sender_chat?.link,
    1200
  );

  if (!id && !link) return null;
  if (!title || __lrCh3BadTitle(title)) return null;

  return { id: id || link, title, link: link || null, source, score };
}

function __lrCh3Candidates(update) {
  const out = [];
  const seen = new WeakSet();
  const privateId = __lrCh3PrivateChatId(update);
  const fallbackTitle = __lrCh3TitleFromText(update);

  function add(obj, score, source) {
    const c = __lrCh3CandidateFromObject(obj, source, score, fallbackTitle);
    if (!c) return;

    if (privateId && c.id && String(c.id) === String(privateId)) return;

    out.push(c);
  }

  [
    update?.chat,
    update?.channel,
    update?.message?.link?.chat,
    update?.message?.body?.link?.chat,
    update?.body?.link?.chat,
    update?.link?.chat,
    update?.message?.link?.message?.chat,
    update?.message?.link?.message?.recipient,
    update?.message?.body?.link?.message?.chat,
    update?.message?.body?.link?.message?.recipient,
    update?.message?.forward?.message?.chat,
    update?.message?.forward?.message?.recipient,
    update?.message?.body?.forward?.message?.chat,
    update?.message?.body?.forward?.message?.recipient,
    update?.forward?.message?.chat,
    update?.forward?.message?.recipient,
    update?.message?.source,
    update?.message?.sender_chat,
    update?.body?.message?.source,
    update?.body?.message?.sender_chat,
    update?.message?.channel,
    update?.body?.message?.channel
  ].filter(Boolean).forEach((x, i) => add(x, 10000 - i, 'direct'));

  function walk(obj, depth = 0, path = '') {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    if (seen.has(obj)) return;
    seen.add(obj);

    if (/(forward|link|message|recipient|chat|channel|source|sender)/i.test(path)) {
      add(obj, 900 - depth, path || 'walk');
    }

    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1, path);
      return;
    }

    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') walk(v, depth + 1, path ? `${path}.${k}` : k);
    }
  }

  walk(update);

  for (const text of __lrCh3AllStrings(update)) {
    if (!/(max\.ru|i\.oneme\.ru|:\/\/|join\/)/i.test(text)) continue;

    const title = fallbackTitle;

    if (title && !__lrCh3BadTitle(title)) {
      out.push({ id: text, title, link: text, score: 5000, source: 'text_link' });
    }
  }

  const uniq = new Map();

  for (const c of out) {
    const key = `${c.id || ''}::${c.link || ''}::${__lrCh3Norm(c.title)}`;
    const old = uniq.get(key);
    if (!old || c.score > old.score) uniq.set(key, c);
  }

  return [...uniq.values()].sort((a, b) => b.score - a.score).slice(0, 30);
}

function __lrCh3Token() {
  for (const k of ['MAX_TOKEN', 'MAX_BOT_TOKEN', 'MAX_ACCESS_TOKEN', 'BOT_TOKEN', 'ACCESS_TOKEN', 'API_TOKEN', 'TOKEN']) {
    if (process.env[k]) return String(process.env[k]);
  }

  try { if (typeof MAX_TOKEN !== 'undefined' && MAX_TOKEN) return String(MAX_TOKEN); } catch {}
  try { if (typeof BOT_TOKEN !== 'undefined' && BOT_TOKEN) return String(BOT_TOKEN); } catch {}
  try { if (typeof TOKEN !== 'undefined' && TOKEN) return String(TOKEN); } catch {}

  return '';
}

function __lrCh3ApiBase() {
  let base = '';

  try { if (typeof MAX_API_BASE !== 'undefined' && MAX_API_BASE) base = String(MAX_API_BASE); } catch {}

  base =
    base ||
    process.env.MAX_API_BASE ||
    process.env.MAX_BASE_URL ||
    process.env.MAX_PLATFORM_API ||
    'https://platform-api2.max.ru';

  return String(base).replace(/\/+$/, '');
}

async function __lrCh3ApiGet(path) {
  const token = __lrCh3Token();

  if (!token || typeof fetch !== 'function') {
    return { ok: false, status: 0, data: null, raw: '', temporary: true };
  }

  for (const auth of [token, `Bearer ${token}`]) {
    try {
      const r = await fetch(`${__lrCh3ApiBase()}${path}`, {
        method: 'GET',
        headers: {
          Authorization: auth,
          Accept: 'application/json'
        }
      });

      const raw = await r.text().catch(() => '');
      let data = null;

      try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }

      console.log('[channel add v3] api get', JSON.stringify({
        path,
        status: r.status,
        ok: r.ok,
        preview: raw.slice(0, 220)
      }));

      if (r.ok) return { ok: true, status: r.status, data, raw };

      if ([401, 429, 500, 502, 503, 504].includes(Number(r.status))) {
        return { ok: false, status: r.status, data, raw, temporary: true };
      }

      return { ok: false, status: r.status, data, raw };
    } catch (e) {
      console.error('[channel add v3] api get error', path, e?.message || e);
      return { ok: false, status: 0, data: null, raw: '', temporary: true };
    }
  }

  return { ok: false, status: 0, data: null, raw: '', temporary: true };
}

function __lrCh3AdminFromMembers(data) {
  const raw = JSON.stringify(data || {}).toLowerCase();

  if (
    data?.is_admin === true ||
    data?.isAdmin === true ||
    data?.admin === true ||
    data?.is_owner === true ||
    data?.isOwner === true ||
    data?.owner === true ||
    data?.member?.is_admin === true ||
    data?.member?.isAdmin === true ||
    data?.member?.is_owner === true ||
    data?.member?.isOwner === true ||
    data?.user?.is_admin === true ||
    data?.user?.isAdmin === true
  ) {
    return true;
  }

  const perms = []
    .concat(data?.permissions || [])
    .concat(data?.rights || [])
    .concat(data?.available_permissions || [])
    .concat(data?.availablePermissions || [])
    .concat(data?.available_rights || [])
    .concat(data?.availableRights || [])
    .concat(data?.member?.permissions || [])
    .concat(data?.member?.rights || [])
    .concat(data?.chat?.permissions || [])
    .concat(data?.chat?.rights || [])
    .concat(data?.access || [])
    .concat(data?.access_rights || [])
    .concat(data?.accessRights || []);

  const permText = perms
    .map((x) => typeof x === 'string' ? x : JSON.stringify(x || ''))
    .join(' ')
    .toLowerCase();

  if (/(write|send|post|publish|message|manage|admin|editor)/i.test(permText)) return true;

  for (const obj of [
    data?.permissions,
    data?.rights,
    data?.available_permissions,
    data?.availablePermissions,
    data?.available_rights,
    data?.availableRights,
    data?.member?.permissions,
    data?.member?.rights,
    data?.chat?.permissions,
    data?.chat?.rights,
    data?.access,
    data?.access_rights,
    data?.accessRights
  ]) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) {
        if (v === true && /(write|send|post|publish|message|manage|admin|editor)/i.test(k)) return true;
      }
    }
  }

  if (/"is_admin"\s*:\s*true|isadmin"\s*:\s*true|"admin"\s*:\s*true|"owner"\s*:\s*true/.test(raw)) return true;

  return false;
}

async function __lrCh3BotIsAdmin(maxChatId) {
  const id = __lrCh3Clean(maxChatId);

  if (!id) return false;

  const r = await __lrCh3ApiGet(`/chats/${encodeURIComponent(id)}/members/me`);

  if (r.ok) {
    const admin = __lrCh3AdminFromMembers(r.data);

    console.log('[channel add v3] members/me', JSON.stringify({
      maxChatId: id,
      admin,
      status: r.status
    }));

    return admin;
  }

  if (r.temporary) return null;

  return false;
}

function __lrCh3LinkVariants(value) {
  const raw = __lrCh3Clean(value, 2000);
  if (!raw) return [];

  const out = new Set();

  function add(v) {
    v = __lrCh3Clean(v, 600);
    if (!v) return;

    out.add(v);

    v = v.replace(/^@+/, '');
    v = v.replace(/^https?:\/\//i, '');
    v = v.replace(/^max\.ru\//i, '');
    v = v.replace(/^i\.oneme\.ru\/i\?r=/i, '');
    v = v.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');

    if (v) out.add(v);
    if (v.startsWith('join/')) out.add(v.slice(5));

    const last = v.split('/').filter(Boolean).pop();
    if (last) out.add(last);
  }

  add(raw);

  try {
    const u = new URL(raw);
    add(u.href);
    add(u.pathname);
    add(u.pathname.split('/').filter(Boolean).pop() || '');

    const r = u.searchParams.get('r');
    if (r) add(r);
  } catch {}

  return [...out].filter((x) => x && x.length >= 3);
}

async function __lrCh3EnsureDb() {
  await query(`CREATE TABLE IF NOT EXISTS lr_bot_state (
    key text PRIMARY KEY,
    value text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});

  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`).catch(() => {});
  await query(`UPDATE channels SET is_active = true WHERE is_active IS NULL`).catch(() => {});

  await query(`CREATE TABLE IF NOT EXISTS lr_pending_channels (
    max_chat_id text PRIMARY KEY,
    title text,
    link text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`).catch((e) => {
    console.error('[channel add v3] ensure pending table failed', e?.message || e);
  });
}

async function __lrCh3StorePending(maxChatId, title, link = null) {
  await __lrCh3EnsureDb();

  const id = __lrCh3Clean(maxChatId);
  const name = __lrCh3Clean(title, 300);
  const url = __lrCh3Clean(link, 1200);

  if (!id || !name || __lrCh3BadTitle(name)) return null;

  await query(
    `INSERT INTO lr_pending_channels(max_chat_id, title, link, created_at, updated_at)
     VALUES($1, $2, $3, now(), now())
     ON CONFLICT(max_chat_id) DO UPDATE
       SET title = COALESCE(EXCLUDED.title, lr_pending_channels.title),
           link = COALESCE(EXCLUDED.link, lr_pending_channels.link),
           updated_at = now()`,
    [id, name, url || null]
  ).catch((e) => {
    console.error('[channel add v3] store pending failed', e?.message || e);
  });

  console.log('[channel add v3] pending stored', JSON.stringify({ id, title: name, link: url || null }));

  return { max_chat_id: id, title: name, link: url || null };
}

async function __lrCh3UpsertChannel(maxChatId, title, link = null) {
  /* LR_CHANNEL_ADD_V4_1_UPSERT_NO_UNBOUND_UPDATE */
  await __lrCh3EnsureDb();

  const id = __lrCh3Clean(maxChatId);
  const name = __lrCh3Clean(title, 300);
  const url = __lrCh3Clean(link, 1200);

  if (!id || !name || __lrCh3BadTitle(name)) {
    return null;
  }

  const result = await query(
    `INSERT INTO channels(
       max_chat_id,
       title,
       link,
       is_public,
       is_channel,
       is_active,
       bot_added_at,
       updated_at
     )
     VALUES($1,$2,$3,$4,true,true,now(),now())
     ON CONFLICT(max_chat_id)
     DO UPDATE SET
       title=EXCLUDED.title,
       link=COALESCE(EXCLUDED.link,channels.link),
       is_public=COALESCE(EXCLUDED.is_public,channels.is_public),
       is_channel=true,
       is_active=true,
       bot_added_at=COALESCE(channels.bot_added_at,now()),
       updated_at=now()
     RETURNING
       id,
       max_chat_id,
       title,
       link,
       is_active`,
    [
      String(id),
      name,
      url || null,
      Boolean(url),
    ]
  ).catch((error) => {
    console.error(
      '[channel add v4.1] upsert failed',
      error?.stack || error?.message || error
    );
    return [];
  });

  const saved = __lrCh3Rows(result)[0] || null;

  if (!saved) return null;

  await query(
    `DELETE FROM lr_pending_channels
     WHERE max_chat_id=$1`,
    [String(id)]
  ).catch(() => {});

  await query(
    `DELETE FROM lr_bot_state
     WHERE key IN (
       'lr_v34_add_wait_global',
       'lr_v31_add_wait_global',
       'lr_v30_add_wait_global',
       'lr_v29_add_wait_global'
     )
     OR key LIKE 'lr_v34_add_wait:%'
     OR key LIKE 'lr_v31_add_wait:%'
     OR key LIKE 'lr_v30_add_wait:%'
     OR key LIKE 'lr_v29_add_wait:%'
     OR key LIKE 'lr_add_channel_wait:%'
     OR key LIKE 'pending_channel_add:%'`
  ).catch(() => {});

  await query(
    `DELETE FROM bot_sessions
     WHERE state='wait_add_channel'`
  ).catch(() => {});

  globalThis.__lrV34AddWait = null;
  globalThis.__lrV31AddWait = null;
  globalThis.__lrV30AddWait = null;
  globalThis.__lrV29AddWait = null;

  console.log(
    '[channel add v4.1] saved channel',
    JSON.stringify({
      id: saved.id || null,
      max_chat_id: saved.max_chat_id,
      title: saved.title,
      link: saved.link || null,
    })
  );

  return saved;
}

async function __lrCh3FindPending(candidates) {
  await __lrCh3EnsureDb();

  const ids = [...new Set(candidates.map((c) => __lrCh3Clean(c.id)).filter(Boolean))];
  const links = [...new Set(candidates.map((c) => __lrCh3Clean(c.link, 1200)).filter(Boolean))];
  const titles = [...new Set(candidates.map((c) => __lrCh3Norm(c.title)).filter(Boolean))];

  const all = await query(
    `SELECT max_chat_id, title, link
     FROM lr_pending_channels
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 500`
  ).catch(() => []);

  for (const row of __lrCh3Rows(all)) {
    const rowId = __lrCh3Clean(row.max_chat_id);
    const rowLink = __lrCh3Clean(row.link, 1200);
    const rowTitle = __lrCh3Norm(row.title);

    if (ids.includes(rowId)) return row;
    if (rowLink && links.includes(rowLink)) return row;

    for (const link of links) {
      for (const variant of __lrCh3LinkVariants(link)) {
        if (rowLink && __lrCh3LinkVariants(rowLink).includes(variant)) return row;
      }
    }

    for (const t of titles) {
      if (t && rowTitle && (t === rowTitle || t.includes(rowTitle) || rowTitle.includes(t))) return row;
    }
  }

  return null;
}

async function __lrCh3ResolveByLink(candidate) {
  /* LR_CHANNEL_ADD_V4_1_RESOLVE_API_TITLE */
  const variants = [...new Set(
    [
      candidate?.id,
      candidate?.link,
    ]
      .filter(Boolean)
      .flatMap(__lrCh3LinkVariants)
  )];

  for (const variant of variants) {
    const response = await __lrCh3ApiGet(
      `/chats/${encodeURIComponent(variant)}`
    );

    if (!response.ok) continue;

    const info =
      response.data?.chat ||
      response.data?.result ||
      response.data;

    const chatId = __lrCh3Clean(
      info?.chat_id ||
      info?.chatId ||
      info?.id ||
      info?.chat?.chat_id ||
      info?.chat?.chatId ||
      info?.chat?.id
    );

    // Название разрешено брать только из ответа MAX API.
    // Текст пересланного поста здесь не используется.
    const apiTitle = __lrCh3Clean(
      info?.title ||
      info?.name ||
      info?.chat?.title ||
      info?.chat?.name,
      300
    );

    const apiLink = __lrCh3Clean(
      info?.link ||
      info?.invite_link ||
      info?.inviteLink ||
      info?.chat?.link ||
      candidate?.link ||
      '',
      1200
    );

    if (
      chatId &&
      apiTitle &&
      !__lrCh3BadTitle(apiTitle)
    ) {
      return {
        max_chat_id: String(chatId),
        title: apiTitle,
        link: apiLink || null,
      };
    }
  }

  return null;
}

async function __lrCh3ResolveCandidate(candidate) {
  /* LR_CHANNEL_ADD_V4_1_NO_POST_TEXT_TITLE */
  const id = __lrCh3Clean(candidate?.id);
  const link = __lrCh3Clean(candidate?.link, 1200);

  if (!id && !link) return null;

  // Даже если forwarded update уже содержит числовой chat_id,
  // обязательно запрашиваем /chats/{id}.
  return await __lrCh3ResolveByLink({
    ...candidate,
    id,
    link,
    title: '',
  });
}

/* LR_CHANNEL_ADD_V4_1_REPAIR_TITLES */
async function __lrCh41RepairChannelTitles() {
  if (globalThis.__lrCh41RepairRunning) return;

  globalThis.__lrCh41RepairRunning = true;

  try {
    const rows = __lrCh3Rows(
      await query(
        `SELECT id,max_chat_id,title,link
         FROM channels
         WHERE COALESCE(is_active,true)=true
         ORDER BY id`
      )
    );

    for (const channel of rows) {
      const maxChatId = __lrCh3Clean(
        channel?.max_chat_id
      );

      if (!maxChatId) continue;

      const response = await __lrCh3ApiGet(
        `/chats/${encodeURIComponent(maxChatId)}`
      );

      if (!response.ok) continue;

      const info =
        response.data?.chat ||
        response.data?.result ||
        response.data;

      const apiTitle = __lrCh3Clean(
        info?.title ||
        info?.name ||
        info?.chat?.title ||
        info?.chat?.name,
        300
      );

      const apiLink = __lrCh3Clean(
        info?.link ||
        info?.invite_link ||
        info?.inviteLink ||
        info?.chat?.link ||
        '',
        1200
      );

      if (
        !apiTitle ||
        __lrCh3BadTitle(apiTitle)
      ) {
        continue;
      }

      const oldTitle = __lrCh3Clean(
        channel?.title,
        300
      );

      await query(
        `UPDATE channels
         SET
           title=$2,
           link=COALESCE(NULLIF($3,''),link),
           is_public=CASE
             WHEN COALESCE(NULLIF($3,''),link) IS NOT NULL
             THEN true
             ELSE is_public
           END,
           updated_at=CASE
             WHEN title IS DISTINCT FROM $2
             THEN now()
             ELSE updated_at
           END
         WHERE id=$1`,
        [
          Number(channel.id),
          apiTitle,
          apiLink || '',
        ]
      );

      if (oldTitle !== apiTitle) {
        console.log(
          '[channel add v4.1] repaired title',
          JSON.stringify({
            id: channel.id,
            maxChatId,
            oldTitle,
            apiTitle,
          })
        );
      }
    }
  } catch (error) {
    console.error(
      '[channel add v4.1] title repair failed',
      error?.stack || error?.message || error
    );
  } finally {
    globalThis.__lrCh41RepairRunning = false;
  }
}

if (!globalThis.__lrCh41RepairTimerInstalled) {
  globalThis.__lrCh41RepairTimerInstalled = true;

  setTimeout(() => {
    __lrCh41RepairChannelTitles().catch(() => {});
  }, 4000).unref?.();

  setInterval(() => {
    __lrCh41RepairChannelTitles().catch(() => {});
  }, 6 * 60 * 60 * 1000).unref?.();
}


async function __lrCh3Notify(chatId, text) {
  /* LR_CHANNEL_NOTIFY_V4_2_FALLBACK_CHAIN */
  const id = __lrCh3Clean(chatId, 100);

  if (!/^\d{5,}$/.test(id)) {
    console.error(
      '[channel notify v4.2] invalid private chat id',
      JSON.stringify({
        chatId: String(chatId || ''),
      })
    );
    return false;
  }

  const rows = [
    [
      callbackButton(
        '⬅️ В меню',
        'main:menu'
      ),
    ],
  ];

  const errors = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (typeof sendMaxMessage === 'function') {
      try {
        await sendMaxMessage({
          chatId: id,
          text,
          format: 'html',
          attachments:
            typeof inlineKeyboard === 'function'
              ? inlineKeyboard(rows)
              : [],
        });

        console.log(
          '[channel notify v4.2] sent',
          JSON.stringify({
            chatId: id,
            transport: 'sendMaxMessage',
            attempt,
          })
        );

        return true;
      } catch (error) {
        errors.push(
          `sendMaxMessage:${error?.message || error}`
        );
      }
    }

    if (typeof sendMessage === 'function') {
      try {
        await sendMessage(id, {
          text,
          buttons: rows,
        });

        console.log(
          '[channel notify v4.2] sent',
          JSON.stringify({
            chatId: id,
            transport: 'sendMessage',
            attempt,
          })
        );

        return true;
      } catch (error) {
        errors.push(
          `sendMessage:${error?.message || error}`
        );
      }
    }

    if (typeof msg === 'function') {
      try {
        await msg(
          id,
          text,
          rows,
          'html'
        );

        console.log(
          '[channel notify v4.2] sent',
          JSON.stringify({
            chatId: id,
            transport: 'msg',
            attempt,
          })
        );

        return true;
      } catch (error) {
        errors.push(
          `msg:${error?.message || error}`
        );
      }
    }

    if (attempt < 2) {
      await new Promise((resolve) => {
        setTimeout(resolve, 700);
      });
    }
  }

  console.error(
    '[channel notify v4.2] all transports failed',
    JSON.stringify({
      chatId: id,
      errors,
    })
  );

  try {
    await query(
      `INSERT INTO lr_bot_state(
         key,
         value,
         updated_at
       )
       VALUES(
         'channel_notify_last_error',
         $1,
         now()
       )
       ON CONFLICT(key)
       DO UPDATE SET
         value=EXCLUDED.value,
         updated_at=now()`,
      [
        JSON.stringify({
          chatId: id,
          errors,
          at: new Date().toISOString(),
        }),
      ]
    );
  } catch {}

  return false;
}

async function __lrCh3NotifyTargets() {
  const ids = new Set();

  function add(value) {
    const text = String(value ?? '').trim();
    if (/^\d{5,}$/.test(text)) ids.add(text);
  }

  add(globalThis.__lrLastCallbackChatId);
  add(globalThis.__lrLastPrivateChatId);
  add(globalThis.__lrPrivateChatId);
  add(process.env.LINKRAY_OWNER_CHAT_ID);
  add(process.env.OWNER_CHAT_ID);
  add(process.env.ADMIN_CHAT_ID);

  // fallback по текущему приватному чату из логов
  add('405954311');

  return [...ids].slice(0, 5);
}

async function __lrCh3NotifyDeleted(deletedRows, reason = 'removed') {
  const rows = Array.isArray(deletedRows) ? deletedRows.filter(Boolean) : [];
  if (!rows.length) return;

  const targets = await __lrCh3NotifyTargets();

  const list = rows
    .map((x) => `• <b>${__lrCh3Esc(x.title || 'Канал')}</b>`)
    .join('\n');

  const title = rows.length === 1
    ? '✅ <b>Канал удалён из LinkRay</b>'
    : '✅ <b>Каналы удалены из LinkRay</b>';

  const text = `${title}

${list}

Бот удалён из администраторов, поэтому канал убран из базы и больше не доступен для автопостинга, автоподписей, аналитики и отчётов.`;

  for (const target of targets) {
    await __lrCh3Notify(target, text);
  }

  console.log('[channel add v3] deleted notify sent', JSON.stringify({
    reason,
    targets,
    count: rows.length
  }));
}

async function __lrCh3DeleteChannels(ids, reason = 'removed') {
  const cleanIds = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
  if (!cleanIds.length) return [];

  await __lrCh3EnsureDb();

  await query(
    `UPDATE channels
     SET is_active=false,
         updated_at=now()
     WHERE id = ANY($1::int[])`,
    [cleanIds]
  ).catch(() => {});

  const refs = await query(
    `SELECT table_schema, table_name
     FROM information_schema.columns
     WHERE table_schema='public'
       AND column_name='channel_id'
       AND table_name <> 'channels'
     ORDER BY table_name`
  ).catch(() => []);

  for (const r of __lrCh3Rows(refs)) {
    const schema = String(r.table_schema || 'public').replace(/"/g, '""');
    const table = String(r.table_name || '').replace(/"/g, '""');
    if (!table) continue;

    await query(
      `DELETE FROM "${schema}"."${table}"
       WHERE channel_id = ANY($1::int[])`,
      [cleanIds]
    ).catch((e) => {
      console.error(`[channel add v3] child delete ${schema}.${table}`, e?.message || e);
    });
  }

  const deleted = await query(
    `DELETE FROM channels
     WHERE id = ANY($1::int[])
     RETURNING id, max_chat_id, title`,
    [cleanIds]
  ).catch((e) => {
    console.error('[channel add v3] delete failed', e?.message || e);
    return [];
  });

  const rows = __lrCh3Rows(deleted);

  await __lrCh3NotifyDeleted(rows, reason).catch((e) => {
    console.error('[channel add v3] notify deleted wrapper failed', e?.message || e);
  });

  return rows;
}

async function __lrCh3HandleBotAdded(update) {
  /* LR_CHANNEL_ADD_V4_1_BOT_ADDED_META */
  if (!__lrCh3IsBotAdded(update)) return false;

  const privateId = __lrCh3PrivateChatId(update);
  const eventChatId = __lrCh3AnyChatId(update);

  if (!eventChatId) return false;

  if (
    privateId &&
    String(privateId) === String(eventChatId)
  ) {
    return false;
  }

  let title = '';
  let link = '';

  const response = await __lrCh3ApiGet(
    `/chats/${encodeURIComponent(eventChatId)}`
  );

  if (response.ok) {
    const info =
      response.data?.chat ||
      response.data?.result ||
      response.data;

    title = __lrCh3Clean(
      info?.title ||
      info?.name ||
      info?.chat?.title ||
      info?.chat?.name,
      300
    );

    link = __lrCh3Clean(
      info?.link ||
      info?.invite_link ||
      info?.inviteLink ||
      info?.chat?.link ||
      '',
      1200
    );
  }

  if (!title) {
    title = __lrCh3GetTitle(update);
  }

  if (!link) {
    link = __lrCh3GetLink(update);
  }

  if (!title || __lrCh3BadTitle(title)) {
    console.log(
      '[channel add v4.1] bot_added without verified title',
      JSON.stringify({ eventChatId })
    );
    return false;
  }

  await __lrCh3StorePending(
    eventChatId,
    title,
    link || null
  );

  console.log(
    '[channel add v4.1] bot_added pending',
    JSON.stringify({
      eventChatId,
      title,
      link: link || null,
    })
  );

  return false;
}

async function __lrCh3HandleBotRemoved(update) {
  if (!__lrCh3IsBotRemoved(update)) return false;

  await __lrCh3EnsureDb();

  const id = __lrCh3AnyChatId(update);
  const title = __lrCh3GetTitle(update);
  const link = __lrCh3GetLink(update);
  const titleNorm = __lrCh3Norm(title);

  await query(
    `DELETE FROM lr_pending_channels
     WHERE ($1::text <> '' AND max_chat_id = $1)
        OR ($2::text <> '' AND link = $2)
        OR ($3::text <> '' AND lower(regexp_replace(title, '[^[:alnum:]]+', ' ', 'g')) LIKE '%' || $3 || '%')`,
    [id || '', link || '', titleNorm || '']
  ).catch(() => {});

  let found = [];

  if (id || link) {
    const rows = await query(
      `SELECT id, max_chat_id, title, link
       FROM channels
       WHERE ($1::text <> '' AND max_chat_id::text = $1)
          OR ($2::text <> '' AND link = $2)
       ORDER BY updated_at DESC NULLS LAST, id DESC`,
      [id || '', link || '']
    ).catch(() => []);

    found = __lrCh3Rows(rows);
  }

  if (!found.length && titleNorm) {
    const rows = await query(
      `SELECT id, max_chat_id, title, link
       FROM channels
       ORDER BY updated_at DESC NULLS LAST, id DESC
       LIMIT 500`
    ).catch(() => []);

    found = __lrCh3Rows(rows).filter((r) => {
      const t = __lrCh3Norm(r.title);
      return t && (t === titleNorm || t.includes(titleNorm) || titleNorm.includes(t));
    });
  }

  await __lrCh3DeleteChannels(found.map((x) => x.id), 'bot_removed');

  console.log('[channel add v3] bot_removed handled', JSON.stringify({
    id: id || null,
    title: title || null,
    found: found.map((x) => x.id)
  }));

  return true;
}

async function __lrCh3SweepRemoved(reason = 'periodic') {
  await __lrCh3EnsureDb();

  const stateKey = 'lr_channel_add_v3_sweep_last';

  const lastRows = await query(
    `SELECT updated_at
     FROM lr_bot_state
     WHERE key=$1
     LIMIT 1`,
    [stateKey]
  ).catch(() => []);

  const last = __lrCh3Rows(lastRows)[0];

  if (last?.updated_at && Date.now() - new Date(last.updated_at).getTime() < 45000) return;

  await query(
    `INSERT INTO lr_bot_state(key, value, updated_at)
     VALUES($1, $2, now())
     ON CONFLICT(key) DO UPDATE
       SET value=EXCLUDED.value,
           updated_at=now()`,
    [stateKey, JSON.stringify({ ts: Date.now() })]
  ).catch(() => {});

  const channels = await query(
    `SELECT id, max_chat_id, title
     FROM channels
     WHERE COALESCE(is_active, true)=true
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT 300`
  ).catch(() => []);

  const remove = [];

  for (const ch of __lrCh3Rows(channels)) {
    const admin = await __lrCh3BotIsAdmin(ch.max_chat_id);
    if (admin === false) remove.push(ch.id);
  }

  if (remove.length) await __lrCh3DeleteChannels(remove, reason);
}

async function __lrCh3BusyPostingSession(update) {
  let key = '';

  try { key = __lrCh3Clean(getSessionKey(update)); } catch {}

  if (!key || typeof getSession !== 'function') return false;

  try {
    const ses = await getSession(key).catch(() => null);
    const raw = JSON.stringify(ses || {}).toLowerCase();

    if (!raw || raw === '{}') return false;

    const posting =
      raw.includes('draft') ||
      raw.includes('editor') ||
      raw.includes('post:') ||
      raw.includes('wait_post') ||
      raw.includes('post_content') ||
      raw.includes('autopost') ||
      raw.includes('calendar') ||
      raw.includes('schedule');

    const signature =
      raw.includes('signature') ||
      raw.includes('autosign') ||
      raw.includes('автоподпис');

    return Boolean(posting || signature);
  } catch {
    return false;
  }
}

async function __lrCh3HandleForward(update) {

  /* LR_CHANNEL_NOTIFY_V4_2_REMEMBER_TARGET */
  const __lrCh42PrivateTarget =
    __lrCh3PrivateChatId(update);

  if (__lrCh42PrivateTarget) {
    globalThis.__lrLastPrivateChatId =
      String(__lrCh42PrivateTarget);

    try {
      await query(
        `INSERT INTO lr_bot_state(
           key,
           value,
           updated_at
         )
         VALUES(
           'last_private_chat_id',
           $1,
           now()
         )
         ON CONFLICT(key)
         DO UPDATE SET
           value=EXCLUDED.value,
           updated_at=now()`,
        [String(__lrCh42PrivateTarget)]
      );
    } catch (error) {
      console.error(
        '[channel notify v4.2] remember target failed',
        error?.message || error
      );
    }
  }

  const type = __lrCh3Type(update);
  const text = __lrCh3Text(update);
  const privateChatId = __lrCh3PrivateChatId(update) || '405954311';

  // Команды не считаем пересылкой канала.
  if (text.startsWith('/')) return false;

  // Только входящее сообщение в личном чате с ботом.
  if (type && !type.includes('message_created')) return false;
  if (!__lrCh3IsPrivateUpdate(update)) return false;
  if (!__lrCh3HasForwardEvidence(update)) return false;

  // Не перехватываем пересланные посты внутри редактора/автоподписи.
  if (await __lrCh3BusyPostingSession(update)) {
    console.log('[channel add v3] skip forward because editor/signature session active');
    return false;
  }

  const candidates = __lrCh3Candidates(update);

  console.log('[channel add v3] forward candidates', JSON.stringify(
    candidates.map((c) => ({
      id: c.id,
      title: c.title,
      link: c.link,
      source: c.source,
      score: c.score
    })).slice(0, 15)
  ));

  if (!candidates.length) return false;

  // 1) Сначала матчим недавно добавленный bot_added pending.
  const pending = await __lrCh3FindPending(candidates);

  if (pending?.max_chat_id) {
    const admin = await __lrCh3BotIsAdmin(pending.max_chat_id);

    if (admin === true) {
      const saved = await __lrCh3UpsertChannel(
        pending.max_chat_id,
        pending.title || candidates[0]?.title,
        pending.link || candidates[0]?.link || null
      );

      if (saved) {
        await __lrCh3Notify(privateChatId, `✅ <b>Канал подключён к LinkRay</b>

${__lrCh3Esc(saved.title)}

Канал сохранён в базе и теперь доступен для постов, автоподписей, аналитики и отчётов.`);
        return true;
      }
    }

    await __lrCh3Notify(privateChatId, `❌ <b>Бот не является администратором канала</b>

Канал: <b>${__lrCh3Esc(pending.title || candidates[0]?.title || 'Канал')}</b>

Сначала добавьте LinkRay в администраторы канала и выдайте право публикации.

После этого снова перешлите любой пост из этого канала сюда, в бота.

Канал не добавлен в базу.`);
    return true;
  }

  // 2) Если pending не пришёл, пробуем получить channel_id по публичной ссылке.
  let lastTitle = candidates[0]?.title || 'Канал';

  for (const c of candidates) {
    lastTitle = c.title || lastTitle;

    const resolved = await __lrCh3ResolveCandidate(c);
    if (!resolved?.max_chat_id) continue;

    const admin = await __lrCh3BotIsAdmin(resolved.max_chat_id);

    if (admin === true) {
      const saved = await __lrCh3UpsertChannel(
        resolved.max_chat_id,
        resolved.title || c.title,
        resolved.link || c.link || null
      );

      if (saved) {
        await __lrCh3Notify(privateChatId, `✅ <b>Канал подключён к LinkRay</b>

${__lrCh3Esc(saved.title)}

Канал сохранён в базе и теперь доступен для постов, автоподписей, аналитики и отчётов.`);
        return true;
      }
    }

    if (admin === false) {
      await __lrCh3Notify(privateChatId, `❌ <b>Бот не является администратором канала</b>

Канал: <b>${__lrCh3Esc(resolved.title || c.title || lastTitle)}</b>

Сначала добавьте LinkRay в администраторы канала и выдайте право публикации.

После этого снова перешлите любой пост из этого канала сюда, в бота.

Канал не добавлен в базу.`);
      return true;
    }
  }

  await __lrCh3Notify(privateChatId, `⚠️ <b>Канал не найден</b>

Перешлите именно любой пост из нужного канала в этот чат.

Если канал приватный: сначала добавьте LinkRay в администраторы канала, выдайте право публикации и только потом перешлите пост.

Канал не добавлен в базу.`);

  return true;
}

async function __lrCh3Handle(update) {
  try {
    await __lrCh3EnsureDb();

    if (await __lrCh3HandleBotRemoved(update)) return true;

    await __lrCh3HandleBotAdded(update).catch((e) => {
      console.error('[channel add v3] bot_added failed', e?.message || e);
    });

    await __lrCh3SweepRemoved('sweep').catch((e) => {
      console.error('[channel add v3] sweep failed', e?.message || e);
    });

    if (await __lrCh3HandleForward(update)) return true;

    return false;
  } catch (e) {
    console.error('[channel add v3] handler failed', e?.stack || e?.message || e);
    return false;
  }
}

if (!globalThis.__lrChannelAddV3WatcherStarted) {
  globalThis.__lrChannelAddV3WatcherStarted = true;

  setTimeout(() => {
    __lrCh3SweepRemoved('startup').catch((e) => {
      console.error('[channel add v3] startup sweep failed', e?.message || e);
    });
  }, 10000);

  setInterval(() => {
    __lrCh3SweepRemoved('periodic').catch((e) => {
      console.error('[channel add v3] periodic sweep failed', e?.message || e);
    });
  }, 45000);

  console.log('[channel add v3] installed');
}
/* LR_CHANNEL_ADD_V3_FINAL_END */


/* LR_WRAP_MAYBE_REGISTER_CONFIRM_V34_START */
function lrV34Clean(value, max = 4000) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) return '';
  if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(text.toLowerCase())) return '';
  return text;
}

function lrV34Esc(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
  } catch {}

  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrV34Rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function lrV34ReplyChatId(update) {
  let id = '';

  try {
    if (typeof getChatId === 'function') {
      id = lrV34Clean(getChatId(update), 100);
    }
  } catch {}

  if (!id) {
    id = lrV34Clean(
      update?.chat_id ||
      update?.chatId ||
      update?.body?.chat_id ||
      update?.body?.chatId ||
      update?.message?.recipient?.chat_id ||
      update?.message?.recipient?.id ||
      update?.body?.message?.recipient?.chat_id ||
      update?.body?.message?.recipient?.id ||
      '',
      100
    );
  }

  // Ответ должен идти в личный чат пользователя. Каналы в MAX обычно отрицательные.
  if (!id || String(id).startsWith('-')) {
    id = lrV34Clean(
      process.env.LR_OWNER_CHAT_ID ||
      process.env.OWNER_CHAT_ID ||
      process.env.ADMIN_CHAT_ID ||
      '405954311',
      100
    ) || '405954311';
  }

  return String(id);
}

function lrV34SessionKey(update, fallback = '') {
  try {
    if (typeof getSessionKey === 'function') {
      const k = lrV34Clean(getSessionKey(update), 100);
      if (k) return k;
    }
  } catch {}

  return lrV34Clean(fallback, 100) || '';
}

async function lrV34EnsureState() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS lr_bot_state (
      key text PRIMARY KEY,
      value text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  } catch (e) {
    console.error('[v34 confirm] ensure state failed', e?.message || e);
  }
}

async function lrV34PutState(key, value) {
  await lrV34EnsureState();

  await query(
    `INSERT INTO lr_bot_state(key, value, updated_at)
     VALUES($1,$2,now())
     ON CONFLICT(key) DO UPDATE
       SET value=EXCLUDED.value,
           updated_at=now()`,
    [String(key), JSON.stringify(value || {})]
  );
}

async function lrV34SetAddMode(chatId, key = '') {
  const replyChatId = lrV34Clean(chatId || key || '405954311', 100) || '405954311';
  const sessionKey = lrV34Clean(key || replyChatId, 100) || replyChatId;

  const state = {
    chatId: String(replyChatId),
    key: String(sessionKey),
    ts: Date.now(),
    startedAt: new Date().toISOString()
  };

  globalThis.__lrV34AddWait = state;

  try {
    await lrV34PutState('lr_v34_add_wait_global', state);
    await lrV34PutState(`lr_v34_add_wait:${state.chatId}`, state);
    await lrV34PutState(`lr_v34_add_wait:${state.key}`, state);
  } catch (e) {
    console.error('[v34 confirm] put add mode failed', e?.message || e);
  }

  console.log('[v34 confirm] add mode stored', JSON.stringify(state));
  return state;
}

async function lrV34IsAddMode(update) {
  const chatId = lrV34ReplyChatId(update);
  const key = lrV34SessionKey(update, chatId);

  for (const name of ['__lrV34AddWait', '__lrV31AddWait', '__lrV30AddWait', '__lrV29AddWait']) {
    try {
      const st = globalThis[name];
      if (st && Date.now() - Number(st.ts || 0) < 30 * 60 * 1000) {
        const vals = [
          String(st.chatId || ''),
          String(st.privateChatId || ''),
          String(st.key || '')
        ];
        if (vals.includes(String(chatId)) || vals.includes(String(key))) {
          console.log('[v34 confirm] add mode from memory', JSON.stringify({ chatId, key, name }));
          return true;
        }
      }
    } catch {}
  }

  try {
    const rows = lrV34Rows(await query(
      `SELECT key
       FROM lr_bot_state
       WHERE key IN (
           'lr_v34_add_wait_global',
           'lr_v31_add_wait_global',
           'lr_v30_add_wait_global',
           'lr_v29_add_wait_global',
           $1,$2,$3,$4,$5,$6,$7,$8
         )
         AND updated_at > now() - interval '30 minutes'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [
        `lr_v34_add_wait:${chatId}`,
        `lr_v34_add_wait:${key}`,
        `lr_v31_add_wait:${chatId}`,
        `lr_v31_add_wait:${key}`,
        `lr_v30_add_wait:${chatId}`,
        `lr_v30_add_wait:${key}`,
        `lr_v29_add_wait:${chatId}`,
        `lr_v29_add_wait:${key}`
      ]
    ));

    if (rows[0]) {
      console.log('[v34 confirm] add mode from lr_bot_state', JSON.stringify({ chatId, key, stateKey: rows[0].key }));
      return true;
    }
  } catch (e) {
    console.error('[v34 confirm] state check failed', e?.message || e);
  }

  try {
    const rows = lrV34Rows(await query(
      `SELECT user_id, state
       FROM bot_sessions
       WHERE user_id::text = ANY($1::text[])
         AND state = 'wait_add_channel'
         AND updated_at > now() - interval '30 minutes'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [[String(chatId), `user:${chatId}`, String(key), `user:${key}`]]
    ));

    if (rows[0]) {
      console.log('[v34 confirm] add mode from bot_sessions', JSON.stringify({ chatId, key }));
      return true;
    }
  } catch (e) {
    console.error('[v34 confirm] bot session check failed', e?.message || e);
  }

  console.log('[v34 confirm] no add mode', JSON.stringify({ chatId, key }));
  return false;
}

async function lrV34LatestChannelSince(startedAt) {
  try {
    const rows = lrV34Rows(await query(
      `SELECT id, max_chat_id, title, link, updated_at
       FROM channels
       WHERE updated_at >= $1::timestamptz - interval '10 seconds'
         AND trim(coalesce(title,'')) <> ''
       ORDER BY updated_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [(startedAt instanceof Date ? startedAt : new Date()).toISOString()]
    ));

    return rows[0] || null;
  } catch (e) {
    console.error('[v34 confirm] latest channel failed', e?.message || e);
    return null;
  }
}

async function lrV34Send(chatId, text, rows) {
  rows = rows || [[callbackButton('⬅️ В меню', 'main:menu')]];

  if (typeof msg === 'function') {
    try {
      await msg(chatId, text, rows, 'html');
      console.log('[v34 confirm] msg sent', JSON.stringify({ chatId }));
      return true;
    } catch (e) {
      console.error('[v34 confirm] msg failed', e?.stack || e?.message || e);
    }
  }

  if (typeof sendMaxMessage === 'function') {
    try {
      const payload = { chatId, text, format: 'html' };
      try {
        if (typeof inlineKeyboard === 'function') payload.attachments = inlineKeyboard(rows);
      } catch {}
      await sendMaxMessage(payload);
      console.log('[v34 confirm] sendMaxMessage sent', JSON.stringify({ chatId }));
      return true;
    } catch (e) {
      console.error('[v34 confirm] sendMaxMessage failed', e?.stack || e?.message || e);
    }
  }

  return false;
}

async function lrV34ClearAddMode(chatId, key) {
  try {
    await query(
      `DELETE FROM lr_bot_state
       WHERE key IN (
         'lr_v34_add_wait_global',
         'lr_v31_add_wait_global',
         'lr_v30_add_wait_global',
         'lr_v29_add_wait_global',
         $1,$2,$3,$4,$5,$6,$7,$8
       )`,
      [
        `lr_v34_add_wait:${chatId}`,
        `lr_v34_add_wait:${key}`,
        `lr_v31_add_wait:${chatId}`,
        `lr_v31_add_wait:${key}`,
        `lr_v30_add_wait:${chatId}`,
        `lr_v30_add_wait:${key}`,
        `lr_v29_add_wait:${chatId}`,
        `lr_v29_add_wait:${key}`
      ]
    );
  } catch {}

  try {
    await query(
      `DELETE FROM bot_sessions
       WHERE user_id::text = ANY($1::text[])`,
      [[String(chatId), `user:${chatId}`, String(key), `user:${key}`]]
    );
  } catch {}

  globalThis.__lrV34AddWait = null;
}

async function lrV34ConfirmAfterRegister(update, result, startedAt) {
  /* LR_CHANNEL_V4_DISABLE_DUPLICATE_CONFIRM */
  // Подтверждение отправляет только Channel Add V3.
  return false;
}
/* LR_WRAP_MAYBE_REGISTER_CONFIRM_V34_END */
/* LR_DIRECT_USER_NOTIFY_V36_START */
function lrV36Clean(value, max = 4000) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) return '';
  if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(text.toLowerCase())) return '';
  return text;
}

function lrV36ApiBase() {
  return String(
    process.env.MAX_API_BASE ||
    process.env.MAX_BASE_URL ||
    process.env.MAX_PLATFORM_API ||
    'https://platform-api2.max.ru'
  ).replace(/\/+$/, '');
}

function lrV36ApiToken() {
  for (const k of ['MAX_TOKEN', 'MAX_BOT_TOKEN', 'MAX_ACCESS_TOKEN', 'BOT_TOKEN', 'ACCESS_TOKEN', 'API_TOKEN', 'TOKEN']) {
    if (process.env[k]) return String(process.env[k]);
  }

  try {
    if (typeof MAX_TOKEN !== 'undefined' && MAX_TOKEN) return String(MAX_TOKEN);
  } catch {}

  try {
    if (typeof BOT_TOKEN !== 'undefined' && BOT_TOKEN) return String(BOT_TOKEN);
  } catch {}

  return '';
}

function lrV36WalkIds(obj, out = [], path = '') {
  if (!obj || typeof obj !== 'object') return out;
  if (out.length > 100) return out;

  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;

    if (v && typeof v === 'object') {
      lrV36WalkIds(v, out, p);
      continue;
    }

    const sv = String(v ?? '').trim();
    if (!/^-?\d{4,}$/.test(sv)) continue;

    const lk = String(k).toLowerCase();
    const lp = p.toLowerCase();

    const item = { key: k, path: p, value: sv, score: 0 };

    if (lk === 'user_id' || lk === 'userid') item.score += 1000;
    if (lk === 'id') item.score += 200;
    if (lp.includes('user')) item.score += 600;
    if (lp.includes('sender') || lp.includes('author') || lp.includes('from')) item.score += 700;
    if (lp.includes('recipient') || lp.includes('chat')) item.score -= 500;
    if (sv.startsWith('-')) item.score -= 2000;
    if (sv === '334737573') item.score -= 5000; // bot user_id из logs members/me
    if (sv === '405954311') item.score -= 100; // chat_id личного диалога, не user_id

    out.push(item);
  }

  return out;
}

function lrV36UserId(update) {
  const direct = lrV36Clean(
    update?.user?.user_id ||
    update?.user?.id ||
    update?.sender?.user_id ||
    update?.sender?.id ||
    update?.message?.sender?.user_id ||
    update?.message?.sender?.id ||
    update?.body?.user?.user_id ||
    update?.body?.user?.id ||
    update?.body?.message?.sender?.user_id ||
    update?.body?.message?.sender?.id ||
    '',
    100
  );

  if (direct && !String(direct).startsWith('-') && direct !== '334737573') return direct;

  const ids = lrV36WalkIds(update || {})
    .filter(x => !String(x.value).startsWith('-') && x.value !== '334737573')
    .sort((a, b) => b.score - a.score);

  if (ids[0]) {
    console.log('[v36 notify] user id candidate', JSON.stringify(ids.slice(0, 8)));
    return ids[0].value;
  }

  return '';
}

function lrV36ChatId(update) {
  let id = '';

  try {
    if (typeof getChatId === 'function') id = lrV36Clean(getChatId(update), 100);
  } catch {}

  if (!id) {
    id = lrV36Clean(
      update?.chat_id ||
      update?.chatId ||
      update?.body?.chat_id ||
      update?.body?.chatId ||
      update?.message?.recipient?.chat_id ||
      update?.message?.recipient?.id ||
      update?.body?.message?.recipient?.chat_id ||
      update?.body?.message?.recipient?.id ||
      '',
      100
    );
  }

  if (!id || String(id).startsWith('-')) {
    id = lrV36Clean(
      process.env.LR_OWNER_CHAT_ID ||
      process.env.OWNER_CHAT_ID ||
      process.env.ADMIN_CHAT_ID ||
      '405954311',
      100
    ) || '405954311';
  }

  return id;
}

async function lrV36PostMessage(params, body) {
  const token = lrV36ApiToken();
  if (!token) {
    console.error('[v36 notify] no MAX token');
    return { ok: false, status: 0, error: 'no token' };
  }

  const qs = new URLSearchParams(params);
  const url = `${lrV36ApiBase()}/messages?${qs.toString()}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const text = await response.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    console.log('[v36 notify] POST /messages result', JSON.stringify({
      params,
      status: response.status,
      ok: response.ok,
      preview: text.slice(0, 500)
    }));

    return { ok: response.ok && data?.success !== false, status: response.status, data, text };
  } catch (e) {
    console.error('[v36 notify] POST /messages failed', e?.stack || e?.message || e);
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
}

async function lrV36DirectUserNotify(update, text) {
  const userId = lrV36UserId(update);
  const chatId = lrV36ChatId(update);

  const body = { text, format: 'html', notify: true };

  // MAX docs: личное сообщение пользователю отправляется через POST /messages?user_id=...
  if (userId) {
    const r = await lrV36PostMessage({ user_id: userId }, body);
    if (r.ok) {
      console.log('[v36 notify] direct user_id notification sent', JSON.stringify({ userId, chatId }));
      return true;
    }
  }

  // запасной путь
  if (chatId) {
    const r = await lrV36PostMessage({ chat_id: chatId }, body);
    if (r.ok) {
      console.log('[v36 notify] direct chat_id notification sent', JSON.stringify({ userId, chatId }));
      return true;
    }
  }

  console.error('[v36 notify] direct notification failed all targets', JSON.stringify({ userId, chatId }));
  return false;
}

console.log('[v36 notify] installed');
/* LR_DIRECT_USER_NOTIFY_V36_END */
/* LR_NOTIFY_BUTTON_FAST_REMOVE_V37_START */
function lrV37ButtonRows() {
  return [[callbackButton('⬅️ Главное меню', 'main:menu')]];
}

function lrV37Clean(value, max = 4000) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) return '';
  if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(text.toLowerCase())) return '';
  return text;
}

function lrV37Esc(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
  } catch {}

  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrV37Rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function lrV37InlineKeyboard(rows) {
  try {
    if (typeof inlineKeyboard === 'function') return inlineKeyboard(rows || lrV37ButtonRows());
  } catch (e) {
    console.error('[v37 notify] inlineKeyboard failed', e?.message || e);
  }

  return [];
}

function lrV37ApiBase() {
  return String(
    process.env.MAX_API_BASE ||
    process.env.MAX_BASE_URL ||
    process.env.MAX_PLATFORM_API ||
    'https://platform-api2.max.ru'
  ).replace(/\/+$/, '');
}

function lrV37ApiToken() {
  for (const k of ['MAX_TOKEN', 'MAX_BOT_TOKEN', 'MAX_ACCESS_TOKEN', 'BOT_TOKEN', 'ACCESS_TOKEN', 'API_TOKEN', 'TOKEN']) {
    if (process.env[k]) return String(process.env[k]);
  }

  try {
    if (typeof MAX_TOKEN !== 'undefined' && MAX_TOKEN) return String(MAX_TOKEN);
  } catch {}

  try {
    if (typeof BOT_TOKEN !== 'undefined' && BOT_TOKEN) return String(BOT_TOKEN);
  } catch {}

  return '';
}

function lrV37OwnerUserId() {
  return lrV37Clean(
    process.env.LR_OWNER_USER_ID ||
    process.env.OWNER_USER_ID ||
    process.env.ADMIN_USER_ID ||
    process.env.LR_OWNER_CHAT_ID ||
    process.env.OWNER_CHAT_ID ||
    process.env.ADMIN_CHAT_ID ||
    '405954311',
    100
  ) || '405954311';
}

async function lrV37ApiPostMessage(params, text, rows) {
  const token = lrV37ApiToken();
  if (!token) {
    console.error('[v37 notify] no MAX token');
    return { ok: false, status: 0 };
  }

  const qs = new URLSearchParams(params);
  const attachments = lrV37InlineKeyboard(rows || lrV37ButtonRows());

  const body = {
    text,
    format: 'html',
    notify: true
  };

  if (attachments && attachments.length) body.attachments = attachments;

  try {
    const response = await fetch(`${lrV37ApiBase()}/messages?${qs.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const raw = await response.text().catch(() => '');
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }

    console.log('[v37 notify] POST /messages result', JSON.stringify({
      params,
      status: response.status,
      ok: response.ok,
      preview: raw.slice(0, 500)
    }));

    return { ok: response.ok && data?.success !== false, status: response.status, data, raw };
  } catch (e) {
    console.error('[v37 notify] POST /messages failed', e?.stack || e?.message || e);
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
}

async function lrV37DirectNotifyUser(text, rows, update = null) {
  let userId = '';

  try {
    if (typeof lrV36UserId === 'function' && update) userId = lrV37Clean(lrV36UserId(update), 100);
  } catch {}

  if (!userId || userId === '334737573') userId = lrV37OwnerUserId();

  const r = await lrV37ApiPostMessage({ user_id: userId }, text, rows || lrV37ButtonRows());

  if (r.ok) {
    console.log('[v37 notify] direct user notification sent', JSON.stringify({ userId }));
    return true;
  }

  // Запасной вариант: старый chat_id личного диалога.
  const chatId = lrV37Clean(process.env.LR_OWNER_CHAT_ID || process.env.OWNER_CHAT_ID || process.env.ADMIN_CHAT_ID || '405954311', 100) || '405954311';
  const r2 = await lrV37ApiPostMessage({ chat_id: chatId }, text, rows || lrV37ButtonRows());

  if (r2.ok) {
    console.log('[v37 notify] direct chat notification sent', JSON.stringify({ chatId }));
    return true;
  }

  console.error('[v37 notify] direct notification failed', JSON.stringify({ userId, chatId }));
  return false;
}

async function lrV37SendWithMenu(chatId, text, update = null) {
  const rows = lrV37ButtonRows();

  let okNormal = false;

  if (typeof msg === 'function') {
    try {
      await msg(chatId, text, rows, 'html');
      console.log('[v37 notify] msg sent with menu', JSON.stringify({ chatId }));
      okNormal = true;
    } catch (e) {
      console.error('[v37 notify] msg with menu failed', e?.message || e);
    }
  }

  const okDirect = await lrV37DirectNotifyUser(text, rows, update);
  return Boolean(okNormal || okDirect);
}

async function lrV37NotifyChannelRemoved(channel, update = null, reason = 'fast_remove') {
  const title = lrV37Clean(channel?.title || channel?.name || 'канал', 300) || 'канал';
  const text = `✅ <b>Канал удалён из LinkRay</b>

${lrV37Esc(title)}

Канал отключён в базе и больше не будет использоваться для постов, автоподписей, аналитики и отчётов.`;

  const id = lrV37Clean(channel?.id || channel?.max_chat_id || channel?.maxChatId || title, 120);
  const lockKey = `lr_v37_removed_notified:${id}`;

  try {
    const rows = lrV37Rows(await query(
      `SELECT key FROM lr_bot_state
       WHERE key=$1 AND updated_at > now() - interval '90 seconds'
       LIMIT 1`,
      [lockKey]
    ));

    if (rows[0]) {
      console.log('[v37 notify] removed duplicate skip', JSON.stringify({ title, reason }));
      return true;
    }
  } catch {}

  const ok = await lrV37SendWithMenu(lrV37OwnerUserId(), text, update);

  if (ok) {
    try {
      await query(
        `INSERT INTO lr_bot_state(key,value,updated_at)
         VALUES($1,$2,now())
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [lockKey, JSON.stringify({ title, reason, ts: Date.now() })]
      );
    } catch {}

    console.log('[v37 notify] removed notification done', JSON.stringify({ title, reason }));
  }

  return ok;
}

async function lrV37FastRemoveSweep() {
  try {
    if (globalThis.__lrV37RemoveSweepRunning) return;
    globalThis.__lrV37RemoveSweepRunning = true;

    const rows = lrV37Rows(await query(
      `SELECT id, max_chat_id, title, updated_at
       FROM channels
       WHERE COALESCE(is_active,true)=true
       ORDER BY updated_at DESC NULLS LAST, id DESC
       LIMIT 30`
    ));

    for (const ch of rows) {
      const maxChatId = lrV37Clean(ch.max_chat_id, 100);
      if (!maxChatId) continue;

      let admin = null;

      try {
        if (typeof lrV31CheckBotAdmin === 'function') {
          admin = await lrV31CheckBotAdmin(maxChatId);
        }
      } catch (e) {
        console.error('[v37 notify] lrV31CheckBotAdmin failed', e?.message || e);
      }

      if (!admin && typeof lrV15CheckAdmin === 'function') {
        try {
          admin = await lrV15CheckAdmin(maxChatId);
        } catch (e) {
          console.error('[v37 notify] lrV15CheckAdmin failed', e?.message || e);
        }
      }

      if (!admin || !admin.ok) continue;

      if (admin.admin === false) {
        await query(
          `UPDATE channels
           SET is_active=false, updated_at=now()
           WHERE max_chat_id=$1`,
          [maxChatId]
        );

        await lrV37NotifyChannelRemoved(ch, null, 'fast_sweep');
      }
    }
  } catch (e) {
    console.error('[v37 notify] fast remove sweep failed', e?.stack || e?.message || e);
  } finally {
    globalThis.__lrV37RemoveSweepRunning = false;
  }
}

try {
  if (!globalThis.__lrV37RemoveSweepTimer) {
    globalThis.__lrV37RemoveSweepTimer = setInterval(lrV37FastRemoveSweep, 10000);
    globalThis.__lrV37RemoveSweepTimer.unref?.();
    setTimeout(lrV37FastRemoveSweep, 3000).unref?.();
    console.log('[v37 notify] fast remove sweep started');
  }
} catch (e) {
  console.error('[v37 notify] fast sweep start failed', e?.message || e);
}

console.log('[v37 notify] installed');
/* LR_NOTIFY_BUTTON_FAST_REMOVE_V37_END */
/* LR_RESTORE_POST_BUTTONS_CHANNEL_EMOJIS_V38_START */
console.log('[v38 restore] native post buttons restored; channel emojis enabled');
/* LR_RESTORE_POST_BUTTONS_CHANNEL_EMOJIS_V38_END */
/* LR_FIX_NATIVE_CALLBACK_TYPE_V40_START */
function lrV40Type(update) {
  try {
    if (typeof getUpdateType === 'function') return String(getUpdateType(update) || '');
  } catch {}

  return String(
    update?.type ||
    update?.update_type ||
    update?.event_type ||
    update?.body?.type ||
    update?.body?.update_type ||
    ''
  );
}

function lrV40ChatId(update) {
  try {
    if (typeof getChatId === 'function') return String(getChatId(update) || '');
  } catch {}

  return String(
    update?.chat_id ||
    update?.chatId ||
    update?.body?.chat_id ||
    update?.body?.chatId ||
    update?.message?.recipient?.chat_id ||
    update?.message?.recipient?.id ||
    update?.body?.message?.recipient?.chat_id ||
    update?.body?.message?.recipient?.id ||
    ''
  );
}

function lrV40Payload(update) {
  try {
    if (typeof getCallbackPayload === 'function') return String(getCallbackPayload(update) || '');
  } catch {}

  try {
    if (typeof lrV31Payload === 'function') return String(lrV31Payload(update) || '');
  } catch {}

  return String(
    update?.payload ||
    update?.callback?.payload ||
    update?.body?.payload ||
    update?.body?.callback?.payload ||
    update?.message?.payload ||
    ''
  );
}

console.log('[v40 buttons] installed: fixed missing type without redeclaring chatId');
/* LR_FIX_NATIVE_CALLBACK_TYPE_V40_END */


/* LR_CONFIRM_AFTER_CHANNEL_ADD_V3_SAVE_V35_START */
function lrV35Clean(value, max = 4000) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) return '';
  if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(text.toLowerCase())) return '';
  return text;
}

function lrV35Esc(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
  } catch {}

  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrV35Rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function lrV35ReplyChatId(update) {
  let id = '';

  try {
    if (typeof getChatId === 'function') {
      id = lrV35Clean(getChatId(update), 100);
    }
  } catch {}

  if (!id) {
    id = lrV35Clean(
      update?.chat_id ||
      update?.chatId ||
      update?.body?.chat_id ||
      update?.body?.chatId ||
      update?.message?.recipient?.chat_id ||
      update?.message?.recipient?.id ||
      update?.body?.message?.recipient?.chat_id ||
      update?.body?.message?.recipient?.id ||
      '',
      100
    );
  }

  if (!id || String(id).startsWith('-')) {
    id = lrV35Clean(
      process.env.LR_OWNER_CHAT_ID ||
      process.env.OWNER_CHAT_ID ||
      process.env.ADMIN_CHAT_ID ||
      '405954311',
      100
    ) || '405954311';
  }

  return String(id);
}

async function lrV35EnsureState() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS lr_bot_state (
      key text PRIMARY KEY,
      value text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  } catch (e) {
    console.error('[v35 confirm] ensure state failed', e?.message || e);
  }
}

async function lrV35Send(chatId, text, rows) {
  rows = rows || [[callbackButton('⬅️ В меню', 'main:menu')]];

  if (typeof msg === 'function') {
    try {
      await msg(chatId, text, rows, 'html');
      console.log('[v35 confirm] msg sent', JSON.stringify({ chatId }));
      return true;
    } catch (e) {
      console.error('[v35 confirm] msg failed', e?.stack || e?.message || e);
    }
  }

  if (typeof sendMaxMessage === 'function') {
    try {
      const payload = { chatId, text, format: 'html' };
      try {
        if (typeof inlineKeyboard === 'function') payload.attachments = inlineKeyboard(rows);
      } catch {}
      await sendMaxMessage(payload);
      console.log('[v35 confirm] sendMaxMessage sent', JSON.stringify({ chatId }));
      return true;
    } catch (e) {
      console.error('[v35 confirm] sendMaxMessage failed', e?.stack || e?.message || e);
    }
  }

  return false;
}

async function lrV35ConfirmSavedChannel(update, saved, reason = 'channel_add_v3_saved') {
  try {
    if (!saved || typeof saved !== 'object') {
      console.log('[v35 confirm] no saved object', JSON.stringify({ reason }));
      return false;
    }

    const chatId = lrV35ReplyChatId(update);
    const title = lrV35Clean(saved.title || saved.name || saved.channel_title || saved.channelTitle || 'канал', 300) || 'канал';
    const savedId = lrV35Clean(saved.id || saved.channel_id || saved.max_chat_id || saved.maxChatId || title, 120);
    const lockKey = `lr_v35_add_confirm_sent:${chatId}:${savedId}`;

    await lrV35EnsureState();

    try {
      const rows = lrV35Rows(await query(
        `SELECT key FROM lr_bot_state
         WHERE key=$1 AND updated_at > now() - interval '90 seconds'
         LIMIT 1`,
        [lockKey]
      ));

      if (rows[0]) {
        console.log('[v35 confirm] duplicate skip', JSON.stringify({ chatId, title, reason }));
        return true;
      }
    } catch {}

    const notificationText = `✅ <b>Канал подключён к LinkRay</b>

${lrV35Esc(title)}

Канал сохранён в базе и теперь доступен для постов, автоподписей, аналитики и отчётов.`;

    const okNormal = await lrV35Send(chatId, notificationText);
    const okDirect = await lrV37DirectNotifyUser(notificationText, lrV37ButtonRows(), update);
    const ok = Boolean(okNormal || okDirect);

    if (ok) {
      try {
        await query(
          `INSERT INTO lr_bot_state(key, value, updated_at)
           VALUES($1,$2,now())
           ON CONFLICT(key) DO UPDATE
             SET value=EXCLUDED.value,
                 updated_at=now()`,
          [lockKey, JSON.stringify({ chatId, savedId, title, reason, ts: Date.now() })]
        );
      } catch {}

      try {
        const key = typeof getSessionKey === 'function' ? String(getSessionKey(update) || '') : '';
        if (key && typeof clearSession === 'function') await clearSession(key);
      } catch {}

      try {
        await query(
          `DELETE FROM lr_bot_state
           WHERE key IN (
             'lr_v34_add_wait_global',
             'lr_v31_add_wait_global',
             'lr_v30_add_wait_global',
             'lr_v29_add_wait_global'
           )
           OR key LIKE 'lr_v34_add_wait:%'
           OR key LIKE 'lr_v31_add_wait:%'
           OR key LIKE 'lr_v30_add_wait:%'
           OR key LIKE 'lr_v29_add_wait:%'`
        );
      } catch {}

      console.log('[v35 confirm] connected notification done', JSON.stringify({ chatId, savedId, title, reason }));
    }

    return ok;
  } catch (e) {
    console.error('[v35 confirm] failed', e?.stack || e?.message || e);
    return false;
  }
}

console.log('[v35 confirm] installed');
/* LR_CONFIRM_AFTER_CHANNEL_ADD_V3_SAVE_V35_END */
async function __lrOrigMaybeRegisterChannelV34(update) {
  try {
    return await __lrCh3Handle(update);
  } catch (e) {
    console.error('[channel add v3] maybeRegisterChannel failed', e?.stack || e?.message || e);
    return false;
  }
}
async function maybeRegisterChannel(update) {
  const __lrV34StartedAt = new Date();
  const __lrV34Result = await __lrOrigMaybeRegisterChannelV34(update);
  await lrV34ConfirmAfterRegister(update, __lrV34Result, __lrV34StartedAt)
    .catch(e => console.error('[v34 confirm] wrapper call failed', e?.stack || e?.message || e));
  return __lrV34Result;
}


async function getChannels() {
  /* LR_FINAL_MAX_CORE_V47_GETCHANNELS_DB */
  try {
    const rows = await query(`
      SELECT id, max_chat_id, title, link, is_active, bot_added_at, updated_at
      FROM channels
      WHERE COALESCE(is_active,true)=true
      ORDER BY COALESCE(updated_at, bot_added_at, now()) DESC, id DESC
    `);
    return Array.isArray(rows) ? rows : (rows?.rows || []);
  } catch (e) {
    console.error('[v47 final] getChannels DB failed', e?.stack || e?.message || e);
    return [];
  }
}


async function getChannel(id) {
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`).catch(() => {});
  const rows = await query(`
    SELECT *
    FROM channels
    WHERE id = $1
      AND COALESCE(is_active, true) = true
    LIMIT 1
  `, [id]);
  return rows[0] || null;
}


async function getChannelsByIds(ids) {
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`).catch(() => {});

  const cleanIds = (Array.isArray(ids) ? ids : [])
    .map((x) => Number(x))
    .filter(Boolean);

  if (!cleanIds.length) return [];

  return query(`
    SELECT *
    FROM channels
    WHERE id = ANY($1::int[])
      AND COALESCE(is_active, true) = true
    ORDER BY title ASC NULLS LAST, id ASC
  `, [cleanIds]);
}


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

function mainMenuTextV5() { return `━━━━━━━━━━━━━━
⚡ LinkRay

🚀 LinkRay Studio
Создание постов, очередь публикаций и рекламные выходы.

📊 Аналитика
PNG-карточки каналов, графики, просмотры и ежедневный отчёт ПДП.

➕ Добавить канал
Подключение MAX-канала к LinkRay.

🚀 Закупы
Создание и контроль рекламных закупов, сроков, просмотров и стоимости.

🛡 Антифрод
Проверка качества трафика и подозрительных скачков.

👤 Профиль
LinkRay ID, тариф, подключённые каналы и поддержка.

Выберите нужный раздел.
━━━━━━━━━━━━━━`; }


function mainMenuTextV6() { return `━━━━━━━━━━━━━━
⚡ LinkRay

🚀 LinkRay Studio
Создание постов, очередь публикаций и рекламные выходы.

📊 Аналитика
PNG-карточки каналов, графики, просмотры и ежедневный отчёт ПДП.

➕ Добавить канал
Подключение MAX-канала к LinkRay.

🚀 Закупы
Создание и контроль рекламных закупов, сроков, просмотров и стоимости.

🛡 Антифрод
Проверка качества трафика и подозрительных скачков.

👤 Профиль
LinkRay ID, тариф, подключённые каналы и поддержка.

Выберите нужный раздел.
━━━━━━━━━━━━━━`; }

function mainMenuRows() {
  return [
    [callbackButton('🚀 LinkRay Studio', 'main:posting')],
    [callbackButton('📊 Аналитика', 'main:analytics')],
    [callbackButton('➕ Добавить канал', 'post:add_channel')],
    [
      callbackButton('🚀 Закупы', 'reports:menu'),
      callbackButton('🛡 Антифрод', 'fraud:menu')
    ],
 [callbackButton('👤 Профиль', 'main:profile')],
 ];
}

async function showMainCallback(callbackId) {
  await cb(callbackId, mainMenuTextV6(), mainMenuRows());
}

async function sendMain(chatId) {
  await msg(chatId, mainMenuTextV6(), mainMenuRows());
}

function studioRows() { return [[callbackButton('🧩 Собрать пост', 'post:create')],[callbackButton('🗂 Посты', 'post:all')],[callbackButton('🏷 Автоподписи', 'sig:menu')],[callbackButton('🔗 Добавить канал', 'post:add_channel')],[callbackButton('⬅️ В меню', 'main:menu')]]; }
async function showStudio(callbackId) { await cb(callbackId, `━━━━━━━━━━━━━━\n🧬 <b>LinkRay Studio</b>\n\nСобирайте посты, планируйте публикации и управляйте рекламными размещениями.\n━━━━━━━━━━━━━━`, studioRows()); }
async function sendStudio(chatId) { await msg(chatId, `━━━━━━━━━━━━━━\n🧬 <b>LinkRay Studio</b>\n\nВыберите действие.\n━━━━━━━━━━━━━━`, studioRows()); }

async function showChannelSelect(callbackId, key, draft, multi = false) {
  /* LR_V44_SAVE_DRAFT_ON_CHANNEL_SELECT */
  try {
    await lrV44SaveForwardDraft(key, draft, 'showChannelSelect');
  } catch (e) {
    console.error('[v44 forward editor] save draft hook failed', e?.message || e);
  }

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
/* LR_RECOVER_FORWARD_DRAFT_EDITOR_V44_START */
function lrV44Rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function lrV44CleanKey(key) {
  return String(key || '').trim().slice(0, 120);
}

function lrV44DraftHasContent(draft) {
  try {
    if (typeof hasDraftContent === 'function' && hasDraftContent(draft)) return true;
  } catch {}

  const d = draft || {};
  const c = d.content || {};

  if (String(c.text || d.text || d.caption || d.html || '').trim()) return true;
  if (Array.isArray(c.attachments) && c.attachments.length) return true;
  if (Array.isArray(d.attachments) && d.attachments.length) return true;
  if (Array.isArray(c.media) && c.media.length) return true;
  if (Array.isArray(d.media) && d.media.length) return true;
  if (c.link || d.link || c.forward || d.forward || c.forwarded || d.forwarded) return true;
  if (c.message || d.message || c.message_id || d.message_id || c.messageId || d.messageId) return true;
  if (c.raw || d.raw) return true;

  return false;
}

function lrV44MergeDrafts(savedDraft, currentDraft) {
  const saved = savedDraft || {};
  const cur = currentDraft || {};
  const curContent = lrV44DraftHasContent(cur);

  const merged = {
    ...saved,
    ...cur,
    content: curContent ? (cur.content || {}) : (saved.content || cur.content || {})
  };

  const curIds = Array.isArray(cur.channelIds) ? cur.channelIds : [];
  const savedIds = Array.isArray(saved.channelIds) ? saved.channelIds : [];

  merged.channelIds = curIds.length ? curIds : savedIds;

  if (!merged.campaignId && saved.campaignId) merged.campaignId = saved.campaignId;
  if (merged.signatureEnabled === undefined && saved.signatureEnabled !== undefined) {
    merged.signatureEnabled = saved.signatureEnabled;
  }

  return merged;
}

async function lrV44SaveForwardDraft(key, draft, reason = 'channel_select') {
  const k = lrV44CleanKey(key);
  if (!k || !lrV44DraftHasContent(draft)) return false;

  try {
    await query(
      `INSERT INTO lr_bot_state(key,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [`lr_v44_forward_draft:${k}`, JSON.stringify({ draft, reason, ts: Date.now() })]
    );

    console.log('[v44 forward editor] saved forward draft', JSON.stringify({
      key: k,
      reason,
      hasText: Boolean(String(draft?.content?.text || draft?.text || '').trim()),
      attachments: Array.isArray(draft?.content?.attachments) ? draft.content.attachments.length : (Array.isArray(draft?.attachments) ? draft.attachments.length : 0)
    }));

    return true;
  } catch (e) {
    console.error('[v44 forward editor] save forward draft failed', e?.stack || e?.message || e);
    return false;
  }
}

async function lrV44LoadForwardDraft(key) {
  const k = lrV44CleanKey(key);
  if (!k) return null;

  try {
    const rows = lrV44Rows(await query(
      `SELECT value
       FROM lr_bot_state
       WHERE key=$1 AND updated_at > now() - interval '30 minutes'
       LIMIT 1`,
      [`lr_v44_forward_draft:${k}`]
    ));

    if (!rows[0]) return null;

    const value = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    const draft = value?.draft || value;

    return draft && typeof draft === 'object' ? draft : null;
  } catch (e) {
    console.error('[v44 forward editor] load forward draft failed', e?.stack || e?.message || e);
    return null;
  }
}

async function lrV44OpenEditorIfForwardDraft(callbackId, key, draft, showEditorCleanFn) {
  /* LR_V45_V44_CHATID_FIX */
  let chatId = globalThis.chatId || '';
  try {
    if (!chatId && typeof lrV42ChatId === 'function') chatId = lrV42ChatId(globalThis.__lastUpdate || {});
  } catch {}

  const current = draft || {};
  const saved = await lrV44LoadForwardDraft(key);
  const merged = lrV44MergeDrafts(saved, current);

  if (!lrV44DraftHasContent(merged)) return false;

  const channels = Array.isArray(merged.channelIds) ? merged.channelIds : [];
  if (!channels.length && !merged.channelId) return false;

  console.log('[v44 forward editor] open editor after channel selection', JSON.stringify({
    key: lrV44CleanKey(key),
    channels,
    hasSaved: Boolean(saved),
    currentHasContent: lrV44DraftHasContent(current),
    mergedHasContent: lrV44DraftHasContent(merged)
  }));

  /* LR_V45_V44_PREVIEW_FIRST */
  if (await lrV45ShowEditorPreviewFirst(lrV42ChatId ? lrV42ChatId({ chat_id: chatId }) || chatId : chatId, key, merged)) {
    /* LR_V46_CLEAR_AFTER_V44_EDITOR_OPEN */
  try { await lrV46DeleteForwardDrafts({ chat_id: key, payload: 'post:create' }, 'after_editor_open'); } catch {}
  return true;
  }


  if (typeof showEditorCleanFn === 'function') {
    if (await lrV45ShowEditorPreviewFirst(chatId, key, merged)) /* LR_V46_CLEAR_AFTER_V44_EDITOR_OPEN */
  try { await lrV46DeleteForwardDrafts({ chat_id: key, payload: 'post:create' }, 'after_editor_open'); } catch {}
  return true;
    await showEditorCleanFn(merged);
    /* LR_V46_CLEAR_AFTER_V44_EDITOR_OPEN */
  try { await lrV46DeleteForwardDrafts({ chat_id: key, payload: 'post:create' }, 'after_editor_open'); } catch {}
  return true;
  }

  if (typeof showEditorClean === 'function') {
    if (await lrV45ShowEditorPreviewFirst(chatId, key, merged)) /* LR_V46_CLEAR_AFTER_V44_EDITOR_OPEN */
  try { await lrV46DeleteForwardDrafts({ chat_id: key, payload: 'post:create' }, 'after_editor_open'); } catch {}
  return true;
    await showEditorClean(merged);
    /* LR_V46_CLEAR_AFTER_V44_EDITOR_OPEN */
  try { await lrV46DeleteForwardDrafts({ chat_id: key, payload: 'post:create' }, 'after_editor_open'); } catch {}
  return true;
  }

  if (typeof showEditor === 'function') {
    if (await lrV45ShowEditorPreviewFirst(chatId, key, merged)) /* LR_V46_CLEAR_AFTER_V44_EDITOR_OPEN */
  try { await lrV46DeleteForwardDrafts({ chat_id: key, payload: 'post:create' }, 'after_editor_open'); } catch {}
  return true;
    await showEditor(callbackId, key, merged);
    /* LR_V46_CLEAR_AFTER_V44_EDITOR_OPEN */
  try { await lrV46DeleteForwardDrafts({ chat_id: key, payload: 'post:create' }, 'after_editor_open'); } catch {}
  return true;
  }

  console.error('[v44 forward editor] no editor function found');
  return false;
}

console.log('[v44 forward editor] installed');
/* LR_RECOVER_FORWARD_DRAFT_EDITOR_V44_END */
async function askContent(callbackId, key, draft) {
    /* LR_V44_ASKCONTENT_RECOVER_FORWARD_DRAFT */
    try {
      if (await lrV44OpenEditorIfForwardDraft(callbackId, key, draft, typeof showEditorClean === 'function' ? showEditorClean : null)) return;
    } catch (e) {
      console.error('[v44 forward editor] askContent guard failed', e?.stack || e?.message || e);
    }
 await setSession(key, 'wait_post_content', { draft }); const channels = await getChannelsByIds(draft.channelIds); await cb(callbackId, `━━━━━━━━━━━━━━\n📨 <b>Отправьте пост</b>\n\nКаналы:\n${channelsLines(channels)}\n\nМожно отправить текст, фото, видео, файл или пересланный пост.\n━━━━━━━━━━━━━━`, [[callbackButton('⬅️ К каналам', 'post:change_channels')],[callbackButton('❌ Отмена', 'post:cancel')]]); }
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


/* LR_AUTOSIGN_WAIT_CHANNEL_V9_START */
function __lrRowsV9(r) {
  if (Array.isArray(r)) return r;
  if (Array.isArray(r?.rows)) return r.rows;
  return [];
}

function __lrAllStringsV9(obj, out = [], depth = 0) {
  if (!obj || depth > 8) return out;
  if (typeof obj === 'string') {
    out.push(obj);
    return out;
  }
  if (typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const x of obj) __lrAllStringsV9(x, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') __lrAllStringsV9(v, out, depth + 1);
  }
  return out;
}

function __lrPayloadV9(update) {
  try {
    if (typeof getCallbackPayload === 'function') {
      const p = String(getCallbackPayload(update) || '');
      if (p) return p;
    }
  } catch {}

  const direct = String(
    update?.callback?.payload ||
    update?.callback_query?.data ||
    update?.message?.body?.payload ||
    update?.body?.payload ||
    update?.payload ||
    update?.data ||
    ''
  );

  if (direct) return direct;

  for (const x of __lrAllStringsV9(update)) {
    if (/^sig:(channel|add|add_channel|toggle|toggle_channel)/.test(x)) return x;
    const m = x.match(/sig:(?:channel|add_channel):\d+/);
    if (m) return m[0];
    if (x === 'sig:add') return x;
  }

  return '';
}

function __lrTextV9(update) {
  try {
    if (typeof getMessageText === 'function') return String(getMessageText(update) || '').trim();
  } catch {}
  try {
    if (typeof getText === 'function') return String(getText(update) || '').trim();
  } catch {}

  return String(
    update?.message?.body?.text ||
    update?.message?.text ||
    update?.body?.text ||
    update?.text ||
    ''
  ).trim();
}

function __lrChatV9(update) {
  try {
    if (typeof getChatId === 'function') return String(getChatId(update) || '');
  } catch {}

  return String(
    update?.message?.recipient?.chat_id ||
    update?.message?.chat_id ||
    update?.chat_id ||
    update?.chat?.id ||
    update?.recipient?.chat_id ||
    ''
  );
}

function __lrSessionKeyV9(update) {
  try {
    if (typeof getSessionKey === 'function') return String(getSessionKey(update) || '');
  } catch {}
  try {
    if (typeof sessionKey === 'function') return String(sessionKey(update) || '');
  } catch {}

  return __lrChatV9(update);
}

function __lrIdsV9(update) {
  const ids = new Set();

  const add = (v) => {
    if (v === null || v === undefined) return;
    const x = String(v).trim();
    if (x && x !== '[object Object]' && x.length <= 120) ids.add(x);
  };

  add(__lrChatV9(update));
  add(__lrSessionKeyV9(update));

  const walk = (obj, depth = 0) => {
    if (!obj || depth > 7 || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const x of obj) walk(x, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      const lk = String(k).toLowerCase();
      if (
        lk === 'chat_id' ||
        lk === 'chatid' ||
        lk === 'user_id' ||
        lk === 'userid' ||
        lk === 'sender_id' ||
        lk === 'recipient_id' ||
        lk === 'from_id' ||
        lk === 'author_id' ||
        lk === 'id'
      ) {
        if (typeof v !== 'object') add(v);
      }
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };

  walk(update);
  return [...ids];
}

async function __lrEnsureAutosignTablesV9() {
  await query(`CREATE TABLE IF NOT EXISTS lr_bot_state (
    key text PRIMARY KEY,
    value text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS channel_signatures (
    id bigserial PRIMARY KEY,
    channel_id bigint NOT NULL,
    owner_key text,
    text text NOT NULL DEFAULT '',
    is_active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function __lrPutStateV9(keys, data) {
  await __lrEnsureAutosignTablesV9();
  const value = JSON.stringify({ ...data, ts: Date.now() });

  for (const key of keys.filter(Boolean)) {
    await query(
      `INSERT INTO lr_bot_state(key,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [key, value]
    );
  }
}

async function __lrGetStateV9(keys) {
  await __lrEnsureAutosignTablesV9();

  for (const key of keys.filter(Boolean)) {
    const rows = __lrRowsV9(await query(`SELECT value, updated_at FROM lr_bot_state WHERE key=$1 LIMIT 1`, [key]).catch(() => []));
    if (!rows[0]?.value) continue;

    try {
      const data = JSON.parse(rows[0].value);
      if (data?.ts && Date.now() - Number(data.ts) > 60 * 60 * 1000) {
        await query(`DELETE FROM lr_bot_state WHERE key=$1`, [key]).catch(() => {});
        continue;
      }
      return data;
    } catch {}
  }

  return null;
}

async function __lrDelStateV9(keys) {
  if (!keys.length) return;
  await query(`DELETE FROM lr_bot_state WHERE key = ANY($1::text[])`, [keys]).catch(() => {});
}

function __lrStateKeysV9(update, type) {
  const ids = __lrIdsV9(update);
  const keys = [`autosign_v9:${type}:global`];
  for (const id of ids) keys.push(`autosign_v9:${type}:${id}`);
  return [...new Set(keys)];
}

async function __lrRememberAutosignChannelV9(update, channelId) {
  const cid = Number(channelId || 0);
  if (!cid) return false;

  await __lrPutStateV9(__lrStateKeysV9(update, 'last_channel'), { channelId: cid });
  console.log('[autosign v9] last_channel', JSON.stringify({ channelId: cid }));
  return true;
}

async function __lrSetAutosignWaitV9(update, channelId) {
  let cid = Number(channelId || 0);

  if (!cid) {
    const last = await __lrGetStateV9(__lrStateKeysV9(update, 'last_channel'));
    cid = Number(last?.channelId || 0);
  }

  if (!cid) {
    console.log('[autosign v9] wait failed no channel');
    return false;
  }

  await __lrPutStateV9(__lrStateKeysV9(update, 'wait'), { channelId: cid });
  console.log('[autosign v9] wait_set', JSON.stringify({ channelId: cid }));
  return true;
}

async function __lrSaveAutosignV9(channelId, text, ownerKey) {
  await __lrEnsureAutosignTablesV9();

  const cid = Number(channelId || 0);
  const clean = String(text || '').trim();
  if (!cid || !clean) return null;

  const owner = String(ownerKey || 'linkray').slice(0, 200);

  const existing = __lrRowsV9(
    await query(`SELECT id FROM channel_signatures WHERE channel_id=$1 ORDER BY updated_at DESC LIMIT 1`, [cid]).catch(() => [])
  );

  if (existing.length) {
    await query(
      `UPDATE channel_signatures
       SET owner_key=$2, text=$3, is_active=true, updated_at=now()
       WHERE channel_id=$1`,
      [cid, owner, clean]
    );
  } else {
    await query(
      `INSERT INTO channel_signatures(channel_id, owner_key, text, is_active, updated_at)
       VALUES($1,$2,$3,true,now())`,
      [cid, owner, clean]
    );
  }

  const saved = __lrRowsV9(
    await query(
      `SELECT id, channel_id, owner_key, is_active, text, updated_at
       FROM channel_signatures
       WHERE channel_id=$1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [cid]
    )
  )[0] || null;

  console.log('[autosign v9] saved+verified', JSON.stringify({
    channelId: cid,
    saved: !!saved,
    id: saved?.id || null,
    len: String(saved?.text || '').length
  }));
  return saved;
}

async function __lrSendAutosignSavedV9(update, saved, text) {
  const chatId = __lrChatV9(update);
  if (!chatId) return;

  const channelId = Number(saved?.channel_id || 0);
  const body = `✅ Подпись сохранена в базе.

━━━━━━━━━━━━━━
🏷 <b>Автоподпись</b>

Статус: 🟢 включена

${String(saved?.text || text || '').trim()}
━━━━━━━━━━━━━━`;

  const rows = [
    [callbackButton('✏️ Заменить автоподпись', `sig:add_channel:${channelId}`)],
    [callbackButton('🔴 Выключить', `sig:toggle_channel:${channelId}`)],
    [callbackButton('⬅️ Автоподписи', 'sig:menu')],
    [callbackButton('⬅️ В Studio', 'main:posting')]
  ];

  if (typeof msg === 'function') {
    await msg(chatId, body, rows, 'html');
  } else if (typeof sendMaxMessage === 'function') {
    await sendMaxMessage({
      chatId,
      text: body,
      format: 'html',
      attachments: typeof inlineKeyboard === 'function' ? inlineKeyboard(rows) : rows
    });
  }
}

async function __lrAutosignV9Callback(update) {
  const payload = __lrPayloadV9(update);
  if (!payload) return false;

  if (payload.startsWith('sig:channel:')) {
    const channelId = Number(payload.split(':')[2] || 0);
    await __lrRememberAutosignChannelV9(update, channelId);
    return false;
  }

  if (payload.startsWith('sig:add_channel:')) {
    const channelId = Number(payload.split(':')[2] || 0);
    await __lrRememberAutosignChannelV9(update, channelId);
    await __lrSetAutosignWaitV9(update, channelId);
    return false;
  }

  if (payload === 'sig:add') {
    await __lrSetAutosignWaitV9(update, 0);
    return false;
  }

  return false;
}

async function __lrAutosignV9Message(update) {
  const text = __lrTextV9(update);

  if (!text) return false;

  if (text.startsWith('/')) {
    await __lrDelStateV9(__lrStateKeysV9(update, 'wait'));
    return false;
  }

  const wait = await __lrGetStateV9(__lrStateKeysV9(update, 'wait'));
  const channelId = Number(wait?.channelId || 0);

  if (!channelId) return false;

  const saved = await __lrSaveAutosignV9(channelId, text, __lrSessionKeyV9(update) || __lrChatV9(update));
  await __lrDelStateV9(__lrStateKeysV9(update, 'wait'));

  if (typeof clearSession === 'function') {
    const key = __lrSessionKeyV9(update);
    if (key) await clearSession(key).catch(() => {});
  }

  await __lrSendAutosignSavedV9(update, saved, text);
  return true;
}
/* LR_AUTOSIGN_WAIT_CHANNEL_V9_END */


/* LR_AUTOSIGN_DIRECT_SAVE_V12_START */
function __lrV12Rows(x) {
  if (Array.isArray(x)) return x;
  if (Array.isArray(x?.rows)) return x.rows;
  return [];
}

function __lrV12Strings(obj, out = [], depth = 0) {
  if (!obj || depth > 9) return out;
  if (typeof obj === 'string') {
    out.push(obj);
    return out;
  }
  if (typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const x of obj) __lrV12Strings(x, out, depth + 1);
    return out;
  }
  for (const v of Object.values(obj)) __lrV12Strings(v, out, depth + 1);
  return out;
}

function __lrV12Payload(update) {
  try {
    if (typeof getCallbackPayload === 'function') {
      const p = String(getCallbackPayload(update) || '');
      if (p) return p;
    }
  } catch {}

  const direct = String(
    update?.callback?.payload ||
    update?.callback_query?.data ||
    update?.message?.body?.payload ||
    update?.message?.payload ||
    update?.body?.payload ||
    update?.payload ||
    update?.data ||
    ''
  );

  if (direct) return direct;

  for (const x of __lrV12Strings(update)) {
    const s = String(x || '');
    const m = s.match(/sig:(?:channel|add_channel|toggle_channel):\d+|sig:add|sig:menu/);
    if (m) return m[0];
  }

  return '';
}

function __lrV12Text(update) {
  try {
    if (typeof getMessageText === 'function') {
      const t = String(getMessageText(update) || '').trim();
      if (t) return t;
    }
  } catch {}

  try {
    if (typeof getText === 'function') {
      const t = String(getText(update) || '').trim();
      if (t) return t;
    }
  } catch {}

  return String(
    update?.message?.body?.text ||
    update?.message?.text ||
    update?.body?.text ||
    update?.text ||
    ''
  ).trim();
}

function __lrV12ChatId(update) {
  try {
    if (typeof getChatId === 'function') {
      const id = String(getChatId(update) || '');
      if (id) return id;
    }
  } catch {}

  return String(
    update?.message?.recipient?.chat_id ||
    update?.message?.chat_id ||
    update?.chat_id ||
    update?.chat?.id ||
    update?.recipient?.chat_id ||
    ''
  );
}

function __lrV12Ids(update) {
  const ids = new Set();
  const add = (v) => {
    if (v === null || v === undefined) return;
    const x = String(v).trim();
    if (!x || x === '[object Object]' || x.length > 140) return;
    ids.add(x);
  };

  add(__lrV12ChatId(update));

  const walk = (obj, depth = 0) => {
    if (!obj || depth > 8 || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const x of obj) walk(x, depth + 1);
      return;
    }

    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).toLowerCase();
      if (
        key === 'chat_id' ||
        key === 'chatid' ||
        key === 'user_id' ||
        key === 'userid' ||
        key === 'sender_id' ||
        key === 'recipient_id' ||
        key === 'from_id' ||
        key === 'author_id'
      ) {
        if (typeof v !== 'object') add(v);
      }

      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };

  walk(update);
  return [...ids];
}

function __lrV12StateKeys(update, kind) {
  const keys = [`autosign_direct_v12:${kind}:global`];
  for (const id of __lrV12Ids(update)) keys.push(`autosign_direct_v12:${kind}:${id}`);
  return [...new Set(keys)];
}

async function __lrV12EnsureDb() {
  await query(`CREATE TABLE IF NOT EXISTS lr_bot_state (
    key text PRIMARY KEY,
    value text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS channel_signatures (
    id bigserial PRIMARY KEY,
    channel_id bigint NOT NULL,
    owner_key text,
    text text NOT NULL DEFAULT '',
    is_active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS owner_key text`).catch(() => {});
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`).catch(() => {});
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`).catch(() => {});
}

async function __lrV12Put(keys, data) {
  await __lrV12EnsureDb();
  const value = JSON.stringify({ ...data, ts: Date.now() });

  for (const key of keys) {
    await query(
      `INSERT INTO lr_bot_state(key,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [key, value]
    );
  }
}

async function __lrV12Get(keys) {
  await __lrV12EnsureDb();

  for (const key of keys) {
    const rows = __lrV12Rows(await query(`SELECT value FROM lr_bot_state WHERE key=$1 LIMIT 1`, [key]).catch(() => []));
    if (!rows[0]?.value) continue;

    try {
      const data = JSON.parse(rows[0].value);
      if (data?.ts && Date.now() - Number(data.ts) > 6 * 60 * 60 * 1000) {
        await query(`DELETE FROM lr_bot_state WHERE key=$1`, [key]).catch(() => {});
        continue;
      }
      return data;
    } catch {}
  }

  return null;
}

async function __lrV12Del(keys) {
  await query(`DELETE FROM lr_bot_state WHERE key = ANY($1::text[])`, [keys]).catch(() => {});
}

function __lrV12FindChannelIdFromAny(update) {
  const payload = __lrV12Payload(update);
  const m = payload.match(/sig:(?:channel|add_channel|toggle_channel):(\d+)/);
  if (m) return Number(m[1]);

  for (const x of __lrV12Strings(update)) {
    const mm = String(x || '').match(/sig:(?:channel|add_channel|toggle_channel):(\d+)/);
    if (mm) return Number(mm[1]);
  }

  return 0;
}


async function __lrV23AutosignSavedBack(update) {
  const chatId = __lrV12ChatId(update);
  return msg(chatId, '✅ Подпись к каналу добавлена.', [
    [callbackButton('⬅️ Назад', 'main:posting')]
  ]);
}

async function __lrV24AutosignSavedBack(update) {
  const chatId = __lrV12ChatId(update);
  const rows = [[callbackButton('⬅️ Назад', 'main:posting')]];

  try {
    if (typeof msg === 'function') {
      await msg(chatId, '✅ Подпись к каналу добавлена.', rows);
      return true;
    }
  } catch (e) {
    console.error('[autosign success v24 msg]', e?.stack || e?.message || e);
  }

  try {
    if (typeof lrMsg === 'function') {
      await lrMsg('✅ Подпись к каналу добавлена.', rows);
      return true;
    }
  } catch (e) {
    console.error('[autosign success v24 lrMsg]', e?.stack || e?.message || e);
  }

  return true;
}


/* LR_SIG_POST_STABLE_FIX_START */
function lrSigStableOk(v) {
  const x = String(v ?? '').trim();
  const low = x.toLowerCase();
  if (!x || x.length > 260) return '';
  if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(low)) return '';
  return x;
}

function lrSigStableEsc(v) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(v);
  } catch {}
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lrSigStableMid(update) {
  const list = [
    update?.message?.body?.mid,
    update?.message?.mid,
    update?.callback?.message?.body?.mid,
    update?.callback?.message?.mid,
    update?.message_callback?.message?.body?.mid,
    update?.message_callback?.message?.mid,
    update?.body?.message?.body?.mid,
    update?.body?.message?.mid,
    update?.update?.message?.body?.mid,
    update?.update?.message?.mid
  ];
  for (const v of list) {
    const id = lrSigStableOk(v);
    if (id) return id;
  }
  return '';
}

function lrSigStableKeyboard(rows) {
  try {
    if (typeof inlineKeyboard === 'function') return inlineKeyboard(rows || []);
    if (typeof buttonRows === 'function') return buttonRows(rows || []);
  } catch {}
  return rows || [];
}

function lrSigStablePromptText() {
  return `🏷 <b>Отправьте подпись.</b> Ссылки, жирный, курсив, подчёркивание, зачёркивание, моно и заголовок MAX сохранятся.

Цитата в подписи специально будет обычным текстом.`;
}

function lrSigStableContent(update, fallbackText = '') {
  let a = null;
  let b = null;

  try {
    if (typeof lrAutoSigFinalContent === 'function') a = lrAutoSigFinalContent(update);
  } catch {}

  try {
    if (typeof lrSigV14Content === 'function') b = lrSigV14Content(update);
  } catch {}

  const at = String(a?.text || '').trim();
  const bt = String(b?.text || '').trim();
  const fb = String(fallbackText || '').trim();

  const richA = /<(a|b|strong|i|em|u|s|code)\b/i.test(at);
  const richB = /<(a|b|strong|i|em|u|s|code)\b/i.test(bt);

  if (richA && !richB) return at;
  if (richB && !richA) return bt;
  if (at.length >= bt.length && at) return at;
  if (bt) return bt;
  return fb;
}

async function lrSigStableClearWait(update) {
  try {
    if (typeof __lrV12Del === 'function' && typeof __lrV12StateKeys === 'function') {
      await __lrV12Del(__lrV12StateKeys(update, 'wait')).catch(() => {});
    }
  } catch {}

  await query(
    `DELETE FROM lr_bot_state
     WHERE key LIKE 'autosign_direct_v12:wait:%'
        OR key LIKE 'autosign_v9:wait:%'
        OR key LIKE 'pending_signature:%'
        OR key LIKE 'lr_runtime_sig_wait:%'`
  ).catch(() => {});
}

async function lrSigStableIsPostFlow(update) {
  try {
    const key = getSessionKey(update);
    const ses = key && typeof getSession === 'function' ? await getSession(key).catch(() => null) : null;
    const state = String(ses?.state || ses?.mode || '');
    if (/post|draft|calendar|saved_time|manual_time|editor|wait_post/i.test(state)) return true;
  } catch {}
  return false;
}

async function lrSigStableRememberWait(update, channelId, menuMid) {
  const value = {
    channelId: Number(channelId),
    menuMid: lrSigStableOk(menuMid)
  };

  await __lrV12Put(__lrV12StateKeys(update, 'last_channel'), value).catch(() => {});
  await __lrV12Put(__lrV12StateKeys(update, 'wait'), value).catch(() => {});

  console.log('[LR_SIG_POST_STABLE_FIX wait]', JSON.stringify(value));
}

async function lrSigStableChangedText(saved, sigHtml) {
  const channelId = Number(saved?.channel_id || saved?.channelId || 0);
  let title = channelId ? `#${channelId}` : 'каналу';

  try {
    if (channelId && typeof getChannel === 'function') {
      const ch = await getChannel(channelId).catch(() => null);
      if (ch && typeof channelName === 'function') title = channelName(ch);
    }
  } catch {}

  return `✅ <b>Автоподпись изменена</b>

Канал: <b>${lrSigStableEsc(title)}</b>

━━━━━━━━━━━━━━
🏷 <b>Автоподпись</b>

Статус: 🟢 включена

${String(sigHtml || saved?.signature || saved?.text || '').trim()}
━━━━━━━━━━━━━━`;
}
/* LR_SIG_POST_STABLE_FIX_END */

async function __lrV12SaveSignature(cid, text, ownerKey = 'global') {
  const channelId = Number(cid);
  const sigHtml = String(text || '').trim();

  if (!channelId || !sigHtml) {
    throw new Error('empty signature or channel id');
  }

  await query(`CREATE TABLE IF NOT EXISTS channel_signatures (
    id bigserial PRIMARY KEY,
    channel_id bigint NOT NULL UNIQUE,
    owner_key text NOT NULL DEFAULT 'global',
    title text,
    text text,
    signature text,
    format text DEFAULT 'html',
    markup jsonb DEFAULT '[]'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS owner_key text NOT NULL DEFAULT 'global'`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS title text`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS text text`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS signature text`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS format text DEFAULT 'html'`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS markup jsonb DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

  const rows = await query(
    `INSERT INTO channel_signatures(channel_id, owner_key, title, text, signature, format, enabled, is_active, created_at, updated_at)
     VALUES($1::bigint, $2, 'Автоподпись', $3, $3, 'html', true, true, now(), now())
     ON CONFLICT (channel_id) DO UPDATE
       SET owner_key = EXCLUDED.owner_key,
           title = EXCLUDED.title,
           text = EXCLUDED.text,
           signature = EXCLUDED.signature,
           format = 'html',
           enabled = true,
           is_active = true,
           updated_at = now()
     RETURNING id, channel_id, owner_key, title, text, signature, format, enabled, is_active, updated_at`,
    [channelId, String(ownerKey || 'global'), sigHtml]
  );

  const saved = rows?.[0] || null;
  console.log('[LR_SIG_POST_STABLE_FIX upsert]', JSON.stringify({ channelId, id: saved?.id || null, len: sigHtml.length }));
  return saved;
}

async function __lrV12SendSaved(update, saved, wait = {}, sigHtml = '') {
  const chatId = __lrV12ChatId(update);
  if (!chatId) return true;

  sigHtml = String(sigHtml || saved?.signature || saved?.text || '').trim();

  const text = await lrSigStableChangedText(saved, sigHtml);
  const rows = [[callbackButton('⬅️ Назад', `sig:channel:${saved?.channel_id || wait?.channelId || 0}`)]];

  if (typeof msg === 'function') {
    await msg(chatId, text, rows, 'html');
  } else if (typeof sendMaxMessage === 'function') {
    await sendMaxMessage({
      chatId,
      text,
      format: 'html',
      attachments: lrSigStableKeyboard(rows)
    });
  }

  console.log('[LR_SIG_POST_STABLE_FIX saved menu]', JSON.stringify({
    channelId: saved?.channel_id || wait?.channelId || null,
    hasBold: /<b>|<strong>/i.test(sigHtml),
    hasLink: /<a\s/i.test(sigHtml)
  }));

  return true;
}

async function __lrAutosignDirectCallbackV12(update) {
  const payload = __lrV12Payload(update);
  if (!payload) return false;

  const channelId = __lrV12FindChannelIdFromAny(update);
  const menuMid = lrSigStableMid(update);

  if (payload.startsWith('sig:channel:') && channelId) {
    await __lrV12Put(__lrV12StateKeys(update, 'last_channel'), { channelId, menuMid });
    return false;
  }

  if (payload.startsWith('sig:add_channel:') && channelId) {
    await lrSigStableRememberWait(update, channelId, menuMid);

    const rows = [[callbackButton('⬅️ Назад', `sig:channel:${channelId}`)]];
    const callbackId = getCallbackId(update);

    if (callbackId && typeof cb === 'function') {
      await cb(callbackId, lrSigStablePromptText(), rows, 'html');
    } else {
      const chatId = __lrV12ChatId(update);
      if (chatId && typeof msg === 'function') await msg(chatId, lrSigStablePromptText(), rows, 'html');
    }

    console.log('[LR_SIG_POST_STABLE_FIX prompt]', JSON.stringify({ channelId, menuMid }));
    return true;
  }

  if (payload === 'sig:add') {
    const last = await __lrV12Get(__lrV12StateKeys(update, 'last_channel')).catch(() => null);
    const cid = Number(last?.channelId || 0);
    const mid = menuMid || last?.menuMid || '';

    if (!cid) return true;

    await lrSigStableRememberWait(update, cid, mid);

    const rows = [[callbackButton('⬅️ Назад', `sig:channel:${cid}`)]];
    const callbackId = getCallbackId(update);

    if (callbackId && typeof cb === 'function') {
      await cb(callbackId, lrSigStablePromptText(), rows, 'html');
    } else {
      const chatId = __lrV12ChatId(update);
      if (chatId && typeof msg === 'function') await msg(chatId, lrSigStablePromptText(), rows, 'html');
    }

    console.log('[LR_SIG_POST_STABLE_FIX prompt sig:add]', JSON.stringify({ channelId: cid, menuMid: mid }));
    return true;
  }

  return false;
}

async function __lrAutosignDirectMessageV12(update) {
  const text = __lrV12Text(update);
  if (!text) return false;

  if (String(text).startsWith('/')) {
    await lrSigStableClearWait(update);
    return false;
  }

  if (await lrSigStableIsPostFlow(update)) {
    await lrSigStableClearWait(update);
    console.log('[LR_SIG_POST_STABLE_FIX] skip autosign, active post flow');
    return false;
  }

  const wait = await __lrV12Get(__lrV12StateKeys(update, 'wait')).catch(() => null);
  const channelId = Number(wait?.channelId || 0);

  if (!channelId) return false;

  try {
    const sigHtml = lrSigStableContent(update, text);
    if (!sigHtml) return false;

    const saved = await __lrV12SaveSignature(
      channelId,
      sigHtml,
      __lrV12ChatId(update) || 'linkray'
    );

    await lrSigStableClearWait(update);

    try {
      const chat = __lrV12ChatId(update);
      if (typeof clearSession === 'function' && chat) {
        await clearSession(chat).catch(() => {});
      }
    } catch {}

    await __lrV12SendSaved(update, saved, wait, sigHtml);
    return true;
  } catch (e) {
    console.error('[LR_SIG_POST_STABLE_FIX message save]', e?.stack || e?.message || e);
    await lrSigStableClearWait(update);
    return true;
  }
}

/* LR_AUTOSIGN_DIRECT_SAVE_V12_END */

/* LR_AUTOSIGN_DIRECT_SAVE_V12_END */

async function handleCallback(update) {


  if (await __lrAutosignDirectCallbackV12(update).catch(e => {
    console.error('[autosign direct v18 callback]', e?.stack || e?.message || e);
    return false;
  })) return;

  await __lrAutosignV9Callback(update).catch(e => console.error('[autosign v9 callback]', e?.stack || e?.message || e));
  __lrStartChannelDbSyncTimer();
  __lrStartChannelDbSyncTimer();
  if (await __lrShouldIgnoreInboundChannelUpdate(update)) return;
  const callbackId = getCallbackId(update); let payload = getCallbackPayload(update); const key = getSessionKey(update); const chatId = lrResolveReplyChatId(update, key);
    if (
      !String(type || '').includes('callback') &&
      !callbackId &&
      payload &&
      (typeof payload !== 'string' || String(payload) === '[object Object]' || String(payload).startsWith('[object '))
    ) {
      console.log('[v17 payload fix] ignore fake message payload', JSON.stringify({
        type,
        chatId,
        payloadType: typeof payload,
        payloadPreview: String(payload).slice(0, 80)
      }));
      payload = '';
    }
  globalThis.__lrLastCallbackChatId = chatId;
  await __lrRememberPrivateChatId(chatId, update);
  await __lrNotifyNewChannels(chatId, update);

  await __lrRememberPrivateChatId(chatId, update);
  await __lrNotifyNewChannels(chatId, update);

  log('callback', { payload, key });
  if (!callbackId) return;
  if (payload === 'noop') return;
  if (payload === 'main:menu') return showMainCallback(callbackId);
  if (payload === 'main:posting') return showStudio(callbackId);
  if (payload === 'post:add_channel') return showChannels(callbackId, chatId);
  if (payload === 'reports:menu') return cb(callbackId, '🚀 Закупы скоро будут здесь.', [[callbackButton('⬅️ В меню','main:menu')]]);
  if (String(payload || '').startsWith('fraud:')) { if (globalThis.__lrAntiFraud24x7) return globalThis.__lrAntiFraud24x7.handleCallback(update); return cb(callbackId, '⚠️ AntiFraud временно недоступен.', [[callbackButton('⬅️ В меню','main:menu')]]); }
  if (payload === 'post:cancel') { await clearSession(key); return cb(callbackId, '❌ Действие отменено.', [[callbackButton('🏠 В меню','main:menu')]]); }
  if (payload === 'post:create') { const draft = emptyDraft(); return showChannelSelect(callbackId, key, draft, false); }
  if (payload === 'post:multi') { const s = await getSession(key); return showChannelSelect(callbackId, key, safeDraft(s.data), true); }
  if (payload.startsWith('post:toggle:')) { const id = Number(payload.split(':')[2]); const s = await getSession(key); const draft = safeDraft(s.data); const set = new Set(draft.channelIds); set.has(id) ? set.delete(id) : set.add(id); draft.channelIds = [...set]; return showChannelSelect(callbackId, key, draft, true); }
  if (payload.startsWith('post:single:')) { const id = Number(payload.split(':')[2]); const s = await getSession(key); const draft = safeDraft(s.data); draft.channelIds = [id]; if (hasContent(draft)) { await answerCallback({ callbackId, notification: 'Открываю редактор...' }).catch(()=>{}); return sendEditorAsNew(chatId, key, draft); } return askContent(callbackId, key, draft); }
  if (payload === 'post:all_channels') { const s = await getSession(key); const draft = safeDraft(s.data); draft.channelIds = (await getChannels()).map(c=>Number(c.id)); if (hasContent(draft)) { await answerCallback({ callbackId, notification: 'Открываю редактор...' }).catch(()=>{}); return sendEditorAsNew(chatId, key, draft); } return askContent(callbackId, key, draft); }
  if (payload === 'post:channels_next') { const s = await getSession(key); const draft = safeDraft(s.data); if (!draft.channelIds.length) return cb(callbackId, 'Выберите хотя бы один канал.', [[callbackButton('⬅️ Назад','post:multi')]]); if (hasContent(draft)) { await answerCallback({ callbackId, notification: 'Открываю редактор...' }).catch(()=>{}); return sendEditorAsNew(chatId, key, draft); } return askContent(callbackId, key, draft); }
  if (payload === 'post:change_channels') { const s = await getSession(key); return showChannelSelect(callbackId, key, safeDraft(s.data), false); }
if (payload === 'editor:text') { const s = await getSession(key); await setSession(key, 'wait_edit_text', s.data); return cb(callbackId, '✏️ Отправьте новый текст поста. Форматирование MAX сохранится.', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:media') { const s = await getSession(key); await setSession(key, 'wait_edit_media', s.data); return cb(callbackId, '🖼 Отправьте новое фото, видео или файл.', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:button') { const s = await getSession(key); await setSession(key, 'wait_button', s.data); return cb(callbackId, '🔘 Формат кнопки:\n<code>Название - https://site.ru</code>\nНесколько в строке через |', [[callbackButton('⬅️ Назад','editor:back')]]); }
  if (payload === 'editor:signature') { const s = await getSession(key); const draft = safeDraft(s.data); if (draft.isAd) return cb(callbackId, '💼 Для рекламного поста автоподпись не добавляется.', [[callbackButton('⬅️ В редактор','editor:back')]]); const channelId = draft.channelIds[0]; const sig = channelId ? await loadSignature(channelId) : null; const rows = (sig && String(sig.text || '').trim())
      ? [
          [callbackButton('✏️ Заменить автоподпись','sig:add')],
          [callbackButton(sig?.is_active ? '🔴 Выключить автоподпись' : '🟢 Включить автоподпись', 'sig:toggle')],
          [callbackButton('⬅️ В редактор','editor:back')]
        ]
      : [
          [callbackButton('✍️ Создать автоподпись','sig:add')],
          [callbackButton('⬅️ В редактор','editor:back')]
        ]; return cb(callbackId, `━━━━━━━━━━━━━━\n🏷 <b>Автоподпись</b>\n\nСтатус: ${sig?.is_active ? 'включена' : 'выключена'}\n\n${sig?.text ? globalThis.__lrSigSaveSafeV11.preview(sig) : 'Подпись не создана.'}\n━━━━━━━━━━━━━━`, rows); }
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
  if (payload.startsWith('publish:auto_set:')) { const session = await getSession(key); const draft = safeDraft(session.data);

  if (session.state === 'wait_add_channel') {
    return lrV15HandleAddChannelForward(update, chatId, key);
  }

  if (
    (!session.state || ['idle','main','menu','start'].includes(String(session.state))) &&
    !String(lrV15Text(update) || '').trim().startsWith('/')
  ) {
    const content = typeof lrSafeHydrateContent === 'function'
      ? await lrSafeHydrateContent(update)
      : await hydrateContent(update);

    const hasPostContent =
      String(content?.text || '').trim() ||
      (Array.isArray(content?.attachments) && content.attachments.length) ||
      content?.link ||
      content?.hasRealBody;

    if (hasPostContent) {
      const d = emptyDraft();
      d.content = { ...d.content, ...content };
      lrApplyEditorPostFormat(d, content);
      d.previewMessageId = null;

      console.log('[v16 payload fix] main message -> select channels', JSON.stringify({
        chatId,
        key,
        state: session.state || '',
        textLength: String(d.content?.text || '').length,
        attachments: Array.isArray(d.content?.attachments) ? d.content.attachments.length : 0
      }));

      return lrV15SendChannelSelect(chatId, key, d, false);
    }
  }

  if ((!session.state || ['idle','main','menu','start'].includes(String(session.state))) && lrV15LooksForwardedPost(update)) {
    if (session.state === 'wait_add_channel') {
    console.log('[v19 native guard] wait_add_channel forward', JSON.stringify({ chatId, key }));
    return lrV15HandleAddChannelForward(update, chatId, key);
  }

  const content = await lrSafeHydrateContent(update);
    const hasPostContent = String(content?.text || '').trim() || (Array.isArray(content?.attachments) && content.attachments.length) || content?.link;
    if (hasPostContent) {
      const d = emptyDraft();
      d.content = { ...d.content, ...content };
      lrApplyEditorPostFormat(d, content);
      d.previewMessageId = null;
      console.log('[v15 native] main forward -> select channels', JSON.stringify({ chatId, key, textLength: String(d.content?.text || '').length, attachments: Array.isArray(d.content?.attachments) ? d.content.attachments.length : 0 }));
      return lrV15SendChannelSelect(chatId, key, d, false);
    }
  }


  if (session.state === 'wait_add_channel') {
    return lrNativeHandleAddChannelForward(update, chatId, key);
  }

  if (
    (!session.state || ['idle','main','menu','start'].includes(String(session.state))) &&
    lrNativeLooksForwardedPost(update)
  ) {
    const content = await lrSafeHydrateContent(update);
    const nextDraft = emptyDraft();
    nextDraft.content = { ...nextDraft.content, ...content };
    lrApplyEditorPostFormat(nextDraft, content);
    nextDraft.previewMessageId = null;
    console.log('[native router fix] main forward -> channel select', JSON.stringify({
      chatId,
      key,
      textLength: String(nextDraft.content?.text || '').length,
      attachments: Array.isArray(nextDraft.content?.attachments) ? nextDraft.content.attachments.length : 0
    }));
    return lrNativeSendChannelSelect(chatId, key, nextDraft, false);
  }
 if (await __lrHandlePendingSignatureTextV5({ chatId, key, update, session, draft, text, send: msg })) return; const v = Number(payload.split(':')[2] || 0) || null; draft.autoDeleteMinutes = v; await setSession(key, 'publish_menu', { draft }); return showPublishMenu(callbackId, key, draft); }
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
        [callbackButton('✏️ Заменить автоподпись', `sig:add_channel:${channelId}`)],
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
        [callbackButton('✏️ Заменить автоподпись', `sig:add_channel:${channelId}`)],
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
    [callbackButton('✏️ Заменить автоподпись', `sig:add_channel:${channelId}`)],
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

/* LR_NATIVE_V15_NO_LAYERS_START */
async function __lrAddConfirmWatch() { return false; }
async function lrNativeV15MaybeRegisterDisabled() { return false; }
function lrV15Clean(value, max = 4000) { const text = String(value ?? '').trim(); const low = text.toLowerCase(); if (!text || text.length > max) return ''; if (['unknown','undefined','null','nan','[object object]'].includes(low)) return ''; return text; }
function lrV15Rows(result) { return Array.isArray(result) ? result : (result?.rows || []); }
function lrV15Esc(value) { try { if (typeof escapeHtml === 'function') return escapeHtml(value); } catch {} return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function lrV15GoodTitle(value) { const text = lrV15Clean(value, 300); if (!text) return ''; if (/^канал$/i.test(text) || /^channel$/i.test(text) || /^linkray/i.test(text) || /^undefined$/i.test(text)) return ''; return text; }
function lrV15Buttons() { return [[callbackButton('⬅️ В меню', 'main:menu')]]; }

function lrV15ChannelCandidates(update) {
  const out = [], seen = new Set(); const seenObjects = new WeakSet();
  function add(item) { const id = lrV15Clean(item?.id || item?.chat_id || item?.chatId || item?.max_chat_id || item?.maxChatId || '', 300); const title = lrV15GoodTitle(item?.title || item?.name || item?.chat_title || item?.chatTitle || item?.channel_title || item?.channelTitle || ''); const link = lrV15Clean(item?.link || item?.url || item?.href || item?.invite_link || item?.inviteLink || '', 600); const source = lrV15Clean(item?.source || '', 80); if (!id && !link) return; const key = [id,title,link].join('|'); if (seen.has(key)) return; seen.add(key); let score = Number(item?.score || 0); if (/^-\d+$/.test(id)) score += 10000; if (title) score += 3000; if (/max\.ru\/join\//i.test(link)) score += 1000; if (/link|forward|message/i.test(source)) score += 600; out.push({ id, title, link, source, score }); }
  function maybeObject(value, source='') { if (!value || typeof value !== 'object' || Array.isArray(value)) return; const type = String(value.type || value.kind || value.chat_type || value.chatType || '').toLowerCase(); const id = value.chat_id ?? value.chatId ?? value.max_chat_id ?? value.maxChatId ?? value.channel_id ?? value.channelId ?? value.id; const title = value.title ?? value.name ?? value.chat_title ?? value.chatTitle ?? value.channel_title ?? value.channelTitle; const link = value.link ?? value.url ?? value.href ?? value.invite_link ?? value.inviteLink; if (type.includes('channel') || String(id || '').startsWith('-') || /max\.ru\/join\//i.test(String(link || ''))) add({ id, title, link, source }); }
  function walk(value, source='root', depth=0) { if (!value || depth > 9) return; if (typeof value === 'string') { for (const m of value.matchAll(/https?:\/\/max\.ru\/join\/[A-Za-z0-9._~%-]+/gi)) add({ id:m[0], link:m[0], source:`${source}.max_join`, score:100 }); return; } if (typeof value !== 'object') return; if (seenObjects.has(value)) return; seenObjects.add(value); maybeObject(value, source); const special = [ ['message.link.chat', value?.message?.link?.chat], ['message.link.message.chat', value?.message?.link?.message?.chat], ['message.forward.chat', value?.message?.forward?.chat], ['message.forward.message.chat', value?.message?.forward?.message?.chat], ['message.forwarded_message.chat', value?.message?.forwarded_message?.chat], ['message.sender_chat', value?.message?.sender_chat], ['link.chat', value?.link?.chat], ['link.message.chat', value?.link?.message?.chat], ['forward.chat', value?.forward?.chat], ['forward.message.chat', value?.forward?.message?.chat], ['body.link.chat', value?.body?.link?.chat], ['body.link.message.chat', value?.body?.link?.message?.chat], ['message.body.link.chat', value?.message?.body?.link?.chat], ['message.body.link.message.chat', value?.message?.body?.link?.message?.chat] ]; for (const [name,item] of special) if (item) maybeObject(item, name); const title = value.title ?? value.name ?? value.chat_title ?? value.chatTitle ?? value.channel_title ?? value.channelTitle; const link = value.url ?? value.href ?? value.link ?? value.target_url ?? value.targetUrl; if (title && link && /max\.ru\/join\//i.test(String(link))) add({ id:link, title, link, source:`${source}.text_link`, score:300 }); if (Array.isArray(value)) { value.forEach((item,i)=>walk(item,`${source}[${i}]`,depth+1)); return; } for (const [key, child] of Object.entries(value)) { if (key === 'recipient' || key === 'sender') continue; walk(child, `${source}.${key}`, depth+1); } }
  walk(update, 'update', 0); out.sort((a,b)=>b.score-a.score); return out;
}
function lrV15LooksForwardedPost(update) { const raw = JSON.stringify(update || {}); if (/forward|forwarded|linked_message|linkedMessage|"link"\s*:/i.test(raw)) return true; if (lrV15ChannelCandidates(update).some(x => /^-\d+$/.test(String(x.id || '')))) return true; return false; }
function lrV15ApiToken() { for (const k of ['MAX_TOKEN','MAX_BOT_TOKEN','MAX_ACCESS_TOKEN','BOT_TOKEN','ACCESS_TOKEN','API_TOKEN','TOKEN']) if (process.env[k]) return String(process.env[k]); try { if (typeof MAX_TOKEN !== 'undefined' && MAX_TOKEN) return String(MAX_TOKEN); } catch {} try { if (typeof BOT_TOKEN !== 'undefined' && BOT_TOKEN) return String(BOT_TOKEN); } catch {} try { if (typeof TOKEN !== 'undefined' && TOKEN) return String(TOKEN); } catch {} return ''; }
function lrV15ApiBase() { let base = ''; try { if (typeof MAX_API_BASE !== 'undefined' && MAX_API_BASE) base = String(MAX_API_BASE); } catch {} return String(base || process.env.MAX_API_BASE || process.env.MAX_BASE_URL || process.env.MAX_PLATFORM_API || 'https://platform-api2.max.ru').replace(/\/+$/,''); }
async function lrV15ApiGet(path) { const response = await fetch(`${lrV15ApiBase()}${path}`, { method:'GET', headers:{ Authorization: lrV15ApiToken() } }); const body = await response.text().catch(()=>''); let data = null; try { data = body ? JSON.parse(body) : null; } catch { data = { raw: body }; } console.log('[v15 native] api get', JSON.stringify({ path, status: response.status, ok: response.ok, preview: body.slice(0,250) })); return { ok: response.ok && data?.success !== false, status: response.status, data }; }
async function lrV15FetchChannelMeta(candidate) { const out = { ...candidate }; const id = lrV15Clean(out.id, 300); if (!/^-\d+$/.test(id)) return out; if (typeof getMaxChatInfo === 'function') { try { const info = await getMaxChatInfo(id); const chat = info?.chat || info?.result || info || {}; out.title = lrV15GoodTitle(chat.title || chat.name || out.title); out.link = lrV15Clean(chat.link || chat.invite_link || chat.inviteLink || out.link || '', 600); } catch(e) { console.error('[v15 native] getMaxChatInfo failed', e?.message || e); } } if (!lrV15GoodTitle(out.title)) { try { const r = await lrV15ApiGet(`/chats/${encodeURIComponent(id)}`); const chat = r.data?.chat || r.data?.result || r.data || {}; out.title = lrV15GoodTitle(chat.title || chat.name || chat.chat?.title || chat.chat?.name || out.title); out.link = lrV15Clean(chat.link || chat.invite_link || chat.inviteLink || chat.chat?.link || out.link || '', 600); } catch(e) { console.error('[v15 native] chat info api failed', e?.message || e); } } return out; }
function lrV15AdminFromData(data) { for (const box of [data, data?.member, data?.user, data?.result, data?.profile, data?.payload].filter(Boolean)) { if (box.is_admin === true || box.isAdmin === true || box.admin === true || box.role === 'admin' || box.role === 'administrator') return true; const perms = box.permissions || box.rights || box.chat_permissions || box.chatPermissions; if (Array.isArray(perms)) { const set = new Set(perms.map(x => String(x).toLowerCase())); if (set.has('write') || set.has('read_all_messages') || set.has('add_remove_members') || set.has('change_chat_info') || set.has('edit') || set.has('delete')) return true; } } return false; }
async function lrV15CheckAdmin(maxChatId) { const id = lrV15Clean(maxChatId,300); if (!/^-\d+$/.test(id)) return { ok:false, admin:false, status:0 }; let last = { ok:false, admin:false, status:0 }; for (const path of [`/chats/${encodeURIComponent(id)}/members/me`, `/chats/${encodeURIComponent(id)}/members/me/`]) { try { const r = await lrV15ApiGet(path); last = { ok:r.ok, admin:r.ok && lrV15AdminFromData(r.data), status:r.status, data:r.data }; console.log('[v15 native] members/me', JSON.stringify({ id, status:r.status, ok:last.ok, admin:last.admin })); if (r.status !== 404) return last; } catch(e) { console.error('[v15 native] members/me failed', e?.message || e); } } return last; }
async function lrV15UpsertChannel(candidate) { const maxChatId = lrV15Clean(candidate.id || candidate.max_chat_id || candidate.maxChatId, 300); const title = lrV15GoodTitle(candidate.title); const link = lrV15Clean(candidate.link || '', 600) || null; if (!/^-\d+$/.test(maxChatId)) throw new Error('Не найден ID канала из пересланного поста.'); if (!title) throw new Error('Не удалось получить настоящее название канала. Перешлите другой пост из канала.'); const rows = await query(`INSERT INTO channels(max_chat_id,title,link,is_public,is_channel,bot_added_at,updated_at) VALUES($1,$2,$3,$4,true,now(),now()) ON CONFLICT(max_chat_id) DO UPDATE SET title=EXCLUDED.title, link=COALESCE(EXCLUDED.link, channels.link), is_public=EXCLUDED.is_public, is_channel=true, bot_added_at=COALESCE(channels.bot_added_at, now()), updated_at=now() RETURNING id,max_chat_id,title,link,is_public`, [String(maxChatId), title, link, Boolean(link)]); await query('UPDATE channels SET is_active=true, updated_at=now() WHERE max_chat_id=$1', [String(maxChatId)]).catch(()=>{}); return lrV15Rows(rows)[0] || { max_chat_id:maxChatId, title, link }; }
async function lrV15HandleAddChannelForward(update, chatId, key) { const candidates = lrV15ChannelCandidates(update); console.log('[v15 native] add candidates', JSON.stringify(candidates.slice(0,12))); if (!candidates.length) { await msg(chatId, `⚠️ <b>Канал не найден</b>\n\nПерешлите именно любой пост из нужного канала в этот чат.`, lrV15Buttons(), 'html'); return true; } let notAdmin = null, lastError = ''; for (const raw of candidates) { if (!/^-\d+$/.test(String(raw.id || ''))) continue; const candidate = await lrV15FetchChannelMeta(raw); const title = lrV15GoodTitle(candidate.title); if (!title) { lastError = 'Не удалось получить настоящее название канала.'; continue; } const admin = await lrV15CheckAdmin(candidate.id); if (!admin.ok || !admin.admin) { notAdmin = candidate; continue; } try { const saved = await lrV15UpsertChannel(candidate); /* LR_PROFILE_V15_CHANNEL_LINK_V1 */ await lrProfileLinkChannel(lrProfileMaxUserId(update), saved?.id).catch((e)=>console.error('[LR profile channel V15]',e?.message||e)); await clearSession(key).catch(()=>{}); await msg(chatId, `✅ <b>Канал подключён к LinkRay</b>\n\n${lrV15Esc(saved.title || title)}\n\nКанал сохранён в базе и теперь доступен для постов, автоподписей, аналитики и отчётов.`, lrV15Buttons(), 'html'); console.log('[v15 native] channel saved final', JSON.stringify(saved)); return true; } catch(e) { lastError = e?.message || String(e); console.error('[v15 native] upsert failed', e?.stack || e?.message || e); } } if (notAdmin) { const title = lrV15GoodTitle(notAdmin.title) || 'канал'; await msg(chatId, `❌ <b>Бот не является администратором канала</b>\n\nКанал: <b>${lrV15Esc(title)}</b>\n\nСначала добавьте LinkRay в администраторы канала и выдайте право публикации.\n\nКанал не добавлен в базу.`, lrV15Buttons(), 'html'); return true; } await msg(chatId, `⚠️ <b>Канал не добавлен</b>\n\n${lrV15Esc(lastError || 'Не удалось определить канал из пересланного поста.')}\n\nПерешлите другой пост из этого канала.`, lrV15Buttons(), 'html'); return true; }
async function lrV15SendChannelSelect(chatId, key, draft, multi=false) {
  /* LR_V44_SAVE_DRAFT_ON_CHANNEL_SELECT */
  try {
    await lrV44SaveForwardDraft(key, draft, 'lrV15SendChannelSelect');
  } catch (e) {
    console.error('[v44 forward editor] save draft hook failed', e?.message || e);
  }
 const channels = await getChannels(); if (!channels.length) { await setSession(key, 'select_channels', { draft }); return msg(chatId, `━━━━━━━━━━━━━━\n🔗 <b>Подключить канал</b>\n\nСначала добавьте канал в LinkRay.\n━━━━━━━━━━━━━━`, [[callbackButton('➕ Добавить канал','post:add_channel')],[callbackButton('⬅️ В меню','main:menu')]], 'html'); } const rows = []; for (const ch of channels) { const selected = draft.channelIds.includes(Number(ch.id)); rows.push([callbackButton(`${selected ? '✅' : '📡'} ${channelName(ch)}`, multi ? `post:toggle:${ch.id}` : `post:single:${ch.id}`)]); } rows.push([callbackButton('🧩 Выбрать несколько','post:multi'), callbackButton('🌐 Все каналы','post:all_channels')]); if (multi) rows.push([callbackButton('➡️ Далее','post:channels_next')]); rows.push([callbackButton('🔗 Добавить канал','post:add_channel')]); rows.push([callbackButton('⬅️ Назад','main:posting'), callbackButton('❌ Отмена','post:cancel')]); await setSession(key, multi ? 'select_channels_multi' : 'select_channels', { draft }); return msg(chatId, `━━━━━━━━━━━━━━\n📡 <b>Куда выпустить пост?</b>\n\nПост принят.\nВыберите канал.\n━━━━━━━━━━━━━━`, rows, 'html'); }
console.log('[v15 native] helpers installed');
/* LR_NATIVE_V15_NO_LAYERS_END */
async function showChannels(callbackId, chatId) {
  /* LR_SHOWCHANNELS_V34_START */
  {
    const __lrV34ChatId = lrV34Clean(chatId || '', 100) || '405954311';
    const __lrV34Key = lrV34Clean((typeof key !== 'undefined' ? key : chatId) || __lrV34ChatId, 100) || __lrV34ChatId;
    await lrV34SetAddMode(__lrV34ChatId, __lrV34Key).catch((e) => console.error('[v34 confirm] showChannels set mode failed', e?.message || e));
  }
  /* LR_SHOWCHANNELS_V34_END */

  /* LR_SHOWCHANNELS_V31_START */
  await lrV31SetAddMode(chatId, key).catch((e) => console.error('[v31 core] showChannels set mode failed', e?.message || e));
  /* LR_SHOWCHANNELS_V31_END */

  /* LR_SHOWCHANNELS_V30_START */
  await lrV30SetAddMode(chatId, key).catch((e) => console.error('[v30 core] showChannels set mode failed', e?.message || e));
  /* LR_SHOWCHANNELS_V30_END */

  const key = String(chatId || '');
  if (key) await setSession(key, 'wait_add_channel', { mode: 'add_channel', ts: Date.now() });
  const text = `━━━━━━━━━━━━━━
🔗 <b>Добавить канал</b>

1. Откройте канал в MAX.
2. Добавьте LinkRay в администраторы.
3. Выдайте право публикации.
4. Перешлите любой пост из этого канала сюда, в бота.

Если LinkRay не является администратором — канал не будет добавлен.
━━━━━━━━━━━━━━`;
  console.log('[v15 native] showChannels wait_add_channel', JSON.stringify({ chatId, key }));
  if (callbackId && typeof cb === 'function') return cb(callbackId, text, lrV15Buttons(), 'html');
  if (chatId && typeof msg === 'function') return msg(chatId, text, lrV15Buttons(), 'html');
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
  return __lrGuardLooksChannel(update);
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


// LR_NO_CHANNEL_SERVICE_MESSAGES_V2_START
function __lrGuardDirectChatObjects(update) {
  return [
    update?.chat,
    update?.recipient,
    update?.message?.chat,
    update?.message?.recipient,
    update?.message?.body?.chat,
    update?.message?.body?.recipient,
    update?.body?.chat,
    update?.body?.recipient,
    update?.callback?.chat,
    update?.callback?.recipient,
    update?.message_callback?.chat,
    update?.message_callback?.recipient,
  ].filter((x) => x && typeof x === 'object');
}

function __lrGuardDirectTypes(update) {
  const out = [];

  for (const obj of __lrGuardDirectChatObjects(update)) {
    out.push(
      obj.type,
      obj.chat_type,
      obj.chatType,
      obj.kind,
      obj.recipient_type,
      obj.recipientType
    );
  }

  out.push(
    update?.chat_type,
    update?.chatType,
    update?.recipient_type,
    update?.recipientType,
    update?.message?.chat_type,
    update?.message?.chatType,
    update?.message?.recipient_type,
    update?.message?.recipientType
  );

  return out.map((x) => String(x || '').toLowerCase()).filter(Boolean);
}

function __lrGuardLooksPrivate(update) {
  if (update && (
    update.privateChat === true ||
    update.private_chat === true ||
    update.isPrivate === true ||
    update.is_private === true ||
    update?.message?.privateChat === true ||
    update?.message?.private_chat === true ||
    update?.body?.privateChat === true ||
    update?.body?.private_chat === true ||
    update?.message_callback?.privateChat === true ||
    update?.callback?.privateChat === true
  )) {
    return true;
  }

  const types = __lrGuardDirectTypes(update);
  return types.some((x) =>
    x === 'user' ||
    x === 'private' ||
    x === 'dialog' ||
    x === 'direct' ||
    x.includes('private') ||
    x.includes('dialog') ||
    x.includes('user')
  );
}

function __lrGuardLooksChannel(update) {
  const types = __lrGuardDirectTypes(update);

  if (types.some((x) =>
    x === 'channel' ||
    x === 'chat' && !__lrGuardLooksPrivate(update) ||
    x.includes('channel')
  )) {
    return true;
  }

  const rootType = String(update?.type || update?.update_type || update?.event_type || '').toLowerCase();

  if (
    rootType.includes('channel') ||
    rootType.includes('chat_member') ||
    rootType.includes('member_added') ||
    rootType.includes('member_removed') ||
    rootType.includes('bot_added') ||
    rootType.includes('bot_removed')
  ) {
    return true;
  }

  for (const obj of __lrGuardDirectChatObjects(update)) {
    const hasChannelId =
      obj.channel_id ||
      obj.channelId ||
      obj.max_channel_id ||
      obj.maxChannelId ||
      obj.chat_id ||
      obj.chatId;

    const hasUserId =
      obj.user_id ||
      obj.userId ||
      obj.sender_id ||
      obj.senderId ||
      obj.author_id ||
      obj.authorId;

    if (hasChannelId && !hasUserId && !__lrGuardLooksPrivate(update)) {
      return true;
    }
  }

  return false;
}

async function __lrGuardIsSafePrivateChat(chatId, update = null) {
  if (!chatId) return false;

  if (update && __lrGuardLooksPrivate(update)) return true;
  if (update && __lrGuardLooksChannel(update)) return false;

  try {
    if (await __lrIsKnownChannelChat(chatId)) return false;
  } catch {}

  return true;
}
// LR_NO_CHANNEL_SERVICE_MESSAGES_V2_END

async function __lrShouldIgnoreInboundChannelUpdate(update) {
  const chatId = getChatId(update);
  if (!chatId) return false;

  const looksPrivate = __lrGuardLooksPrivate(update);

  // Пересланный пост из канала приходит в личку с privateChat=true.
  // Его нельзя глушить как channel update, иначе после пересылки будет тишина.
  if (looksPrivate) return false;

  const knownChannel = await __lrIsKnownChannelChat(chatId).catch(() => false);
  const looksChannel = __lrLooksLikeChannelUpdate(update);

  if (knownChannel || looksChannel) {
    console.log('[SKIP_CHANNEL_REPLY] ignored inbound channel update', JSON.stringify({
      type: update?.type || update?.update_type || update?.event_type || '',
      chatId: String(chatId),
      knownChannel,
      looksChannel,
      looksPrivate,
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

async function __lrRememberPrivateChatId(chatId, update = null) {
  if (!chatId) return;

  const safePrivate = await __lrGuardIsSafePrivateChat(chatId, update).catch(() => false);

  if (!safePrivate) {
    console.log('[SKIP_CHANNEL_REPLY] not remembering channel as private chat', JSON.stringify({
      chatId: String(chatId),
    }));
    return;
  }

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

async function __lrNotifyNewChannels(targetChatId = '', update = null) {
  try {
    await __lrEnsureChannelDbSyncTables();

    const channels = await getChannels();
    const initialized = await __lrInitSeenChannelsIfNeeded(channels);

    if (!initialized) return;

    let chatId = String(targetChatId || await __lrGetLastPrivateChatId() || '').trim();

    if (chatId && !(await __lrGuardIsSafePrivateChat(chatId, update).catch(() => false))) {
      console.log('[SKIP_CHANNEL_REPLY] new channel notification target is channel, fallback to private chat', JSON.stringify({
        chatId,
      }));
      chatId = String(await __lrGetLastPrivateChatId() || '').trim();
    }

    if (!chatId) return;

    if (!(await __lrGuardIsSafePrivateChat(chatId, null).catch(() => false))) {
      console.log('[SKIP_CHANNEL_REPLY] no safe private chat for channel notification');
      return;
    }

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
        text:
          `✅ <b>Канал подключён к LinkRay</b>\n\n` +
          `${title}\n\n` +
          `Канал сохранён в базе и будет использоваться для публикаций, аналитики, отчётов, антифрода и рекламных закупов.`,
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

const __lrStartDedupeMap = new Map();


/* LR_AUTOSIGN_PENDING_SAVE_V5_START */
function __lrSigRowsV5(result) {
  return Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
}

function __lrPendingSigKeysV5(chatId, key) {
  const out = [];
  const a = String(chatId || '').trim();
  const b = String(key || '').trim();
  if (a) out.push(`pending_signature:${a}`);
  if (b) out.push(`pending_signature:${b}`);
  return [...new Set(out)];
}

async function __lrEnsureSigTablesV5() {
  await query(`CREATE TABLE IF NOT EXISTS lr_bot_state (
    key text PRIMARY KEY,
    value text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});

  await query(`CREATE TABLE IF NOT EXISTS channel_signatures (
    id bigserial PRIMARY KEY,
    channel_id bigint NOT NULL,
    owner_key text,
    text text NOT NULL DEFAULT '',
    is_active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`).catch(() => {});
}

async function __lrSetPendingSigInputV5(chatId, key, channelId) {
  const cid = Number(channelId || 0);
  if (!cid) return;
  await __lrEnsureSigTablesV5();
  const value = JSON.stringify({ channelId: cid, chatId: String(chatId || ''), key: String(key || ''), ts: Date.now() });
  for (const k of __lrPendingSigKeysV5(chatId, key)) {
    await query(
      `INSERT INTO lr_bot_state(key,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [k, value]
    ).catch((e) => console.error('[autosign pending set]', e.message || e));
  }
}

async function __lrGetPendingSigInputV5(chatId, key) {
  await __lrEnsureSigTablesV5();
  for (const k of __lrPendingSigKeysV5(chatId, key)) {
    const rows = __lrSigRowsV5(await query(`SELECT value FROM lr_bot_state WHERE key=$1 LIMIT 1`, [k]).catch(() => []));
    const raw = rows[0]?.value;
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      if (data?.ts && Date.now() - Number(data.ts) > 30 * 60 * 1000) {
        await query(`DELETE FROM lr_bot_state WHERE key=$1`, [k]).catch(() => {});
        continue;
      }
      if (Number(data?.channelId || 0)) return data;
    } catch {}
  }
  return null;
}

async function __lrClearPendingSigInputV5(chatId, key) {
  for (const k of __lrPendingSigKeysV5(chatId, key)) {
    await query(`DELETE FROM lr_bot_state WHERE key=$1`, [k]).catch(() => {});
  }
}

async function __lrSaveSigDirectV5(channelId, content, ownerKey = '') {
  await __lrEnsureSigTablesV5();

  const cid = Number(channelId || 0);
  const text = String(content?.text ?? content ?? '').trim();
  if (!cid || !text) return null;

  const owner = String(ownerKey || 'linkray').slice(0, 200);

  const existing = __lrSigRowsV5(
    await query(`SELECT id FROM channel_signatures WHERE channel_id=$1 ORDER BY updated_at DESC LIMIT 1`, [cid]).catch(() => [])
  );

  if (existing.length) {
    await query(
      `UPDATE channel_signatures
       SET text=$2, is_active=true, owner_key=$3, updated_at=now()
       WHERE channel_id=$1`,
      [cid, text, owner]
    );
  } else {
    await query(
      `INSERT INTO channel_signatures(channel_id, owner_key, text, is_active, updated_at)
       VALUES($1,$2,$3,true,now())`,
      [cid, owner, text]
    );
  }

  const saved = __lrSigRowsV5(
    await query(
      `SELECT id, channel_id, owner_key, is_active, text, updated_at
       FROM channel_signatures
       WHERE channel_id=$1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [cid]
    ).catch(() => [])
  )[0] || null;

  console.log('[autosign db save] saved+verified', JSON.stringify({
    channelId: cid,
    len: text.length,
    saved: !!saved,
    id: saved?.id || null
  }));
  return saved;
}

async function __lrHandlePendingSignatureTextV5({ chatId, key, update, session, draft, text, send }) {
  const pending = await __lrGetPendingSigInputV5(chatId, key);
  const state = String(session?.state || '');
  if (state !== 'wait_signature' && !pending) return false;

  const channelId = Number(
    draft?.channelIds?.[0] ||
    session?.data?.draft?.channelIds?.[0] ||
    session?.data?.channelId ||
    pending?.channelId ||
    0
  );

  if (!channelId) {
    await __lrClearPendingSigInputV5(chatId, key);
    await clearSession(key).catch(() => {});
    await send(chatId, '⚠️ Канал для автоподписи не найден. Откройте Studio → Автоподписи и выберите канал заново.', [
      [callbackButton('🏷 Автоподписи', 'sig:menu')],
      [callbackButton('⬅️ В Studio', 'main:posting')]
    ]);
    return true;
  }

  let content = null;
  try {
    if (typeof lrSigV14Content === 'function') content = lrSigV14Content(update);
    else if (typeof lrAutoSigFinalContent === 'function') content = lrAutoSigFinalContent(update);
  } catch (e) {
    console.error('[autosign content parse]', e.message || e);
  }

  if (!content || !String(content.text || '').trim()) {
    content = { text: String(text || '').trim(), format: 'html', markup: [], attachments: [] };
  }

  if (!String(content.text || '').trim()) {
    await send(chatId, '⚠️ Подпись пустая. Отправьте текст подписи.', [
      [callbackButton('⬅️ Автоподписи', 'sig:menu')]
    ]);
    return true;
  }

  const saved = await __lrSaveSigDirectV5(channelId, content, key || chatId);

  await clearSession(key).catch(() => {});
  await __lrClearPendingSigInputV5(chatId, key);

  const preview = String(saved?.text || content.text || '').trim() || 'Подпись сохранена.';
  await send(
    chatId,
    `✅ Подпись сохранена в базе.\n\n━━━━━━━━━━━━━━\n🏷 <b>Автоподпись</b>\n\nКанал:\n${channelId}\n\nСтатус: 🟢 включена\n\n${preview}\n━━━━━━━━━━━━━━`,
    [
      [callbackButton('✏️ Заменить автоподпись', `sig:add_channel:${channelId}`)],
      [callbackButton('🔴 Выключить', `sig:toggle_channel:${channelId}`)],
      [callbackButton('⬅️ Автоподписи', 'sig:menu')],
      [callbackButton('⬅️ В Studio', 'main:posting')]
    ],
    'html'
  );

  return true;
}
/* LR_AUTOSIGN_PENDING_SAVE_V5_END */


/* LR_CHANNEL_FORWARD_CONFIRM_START */
function __lrCfRows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function __lrCfClean(value, max = 4000) {
  const text = String(value ?? '').trim();
  const low = text.toLowerCase();
  if (!text || text.length > max) return '';
  if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(low)) return '';
  return text;
}

function __lrCfEsc(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
  } catch {}
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function __lrCfNorm(value) {
  return __lrCfClean(value, 300)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function __lrCfType(update) {
  return String(update?.type || update?.update_type || update?.event_type || update?.event || update?.body?.type || '').toLowerCase();
}

function __lrCfPrivateChatId(update) {
  let id = '';
  try { if (typeof getChatId === 'function') id = getChatId(update); } catch {}
  id = __lrCfClean(
    update?.chatId || update?.chat_id || update?.body?.chatId || update?.body?.chat_id ||
    update?.message?.recipient?.chat_id || update?.message?.recipient?.id ||
    update?.body?.message?.recipient?.chat_id || update?.body?.message?.recipient?.id || id
  );
  return id;
}

function __lrCfIsPrivateMessage(update) {
  const id = __lrCfPrivateChatId(update);
  if (!id || id.startsWith('-')) return false;

  const types = [
    update?.chat?.type,
    update?.message?.chat?.type,
    update?.message?.recipient?.type,
    update?.message?.recipient?.chat_type,
    update?.message?.recipient?.recipient_type,
    update?.body?.chat?.type,
    update?.body?.message?.chat?.type,
    update?.body?.message?.recipient?.type,
    update?.chat_type,
    update?.recipient_type
  ].map((x) => String(x || '').toLowerCase()).filter(Boolean);

  if (!types.length) return true;
  return types.some((x) => x.includes('dialog') || x.includes('private') || x === 'user');
}

function __lrCfText(update) {
  try {
    if (typeof getMessageText === 'function') {
      const text = getMessageText(update);
      if (__lrCfClean(text, 7000)) return __lrCfClean(text, 7000);
    }
  } catch {}
  return __lrCfClean(
    update?.message?.body?.text || update?.message?.text ||
    update?.body?.message?.body?.text || update?.body?.message?.text || update?.text || '',
    7000
  );
}

function __lrCfAllStrings(root) {
  const out = [];
  const seen = new WeakSet();
  function add(v) {
    const text = __lrCfClean(v, 7000);
    if (text) out.push(text);
  }
  function walk(v, depth = 0) {
    if (v == null || depth > 10) return;
    if (typeof v === 'string') { add(v); return; }
    if (typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const item of v) walk(item, depth + 1); return; }
    for (const [k, child] of Object.entries(v)) {
      const key = String(k || '').toLowerCase();
      if (['text','title','name','caption','url','link','href','chat_id','channel_id','id'].includes(key)) {
        if (typeof child !== 'object') add(child);
      }
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  }
  walk(root);
  return [...new Set(out)];
}

function __lrCfHasForwardEvidence(update) {
  const raw = JSON.stringify(update || {}).toLowerCase();
  return Boolean(
    update?.message?.link || update?.message?.body?.link || update?.body?.link || update?.link ||
    update?.message?.forward || update?.message?.body?.forward || update?.forward ||
    raw.includes('"forward"') || raw.includes('"forwarded"') || raw.includes('"source"') ||
    raw.includes('"sender_chat"') || raw.includes('"link"') || raw.includes('"channel"') || raw.includes('"chat_id"')
  );
}

function __lrCfCandidateTitles(update) {
  const titles = new Set();
  function add(v) {
    const text = __lrCfClean(v, 300);
    const n = __lrCfNorm(text);
    if (!text || text.length < 3 || text.length > 120) return;
    if (!/[A-Za-zА-Яа-я]/.test(text)) return;
    if (['кирилл', 'kirill', 'megamozg996', 'linkray', 'бот'].includes(n)) return;
    titles.add(text);
  }
  [
    update?.chat?.title, update?.chat?.name, update?.channel?.title, update?.channel?.name,
    update?.message?.chat?.title, update?.message?.chat?.name, update?.message?.recipient?.title,
    update?.message?.link?.chat?.title, update?.message?.link?.message?.chat?.title,
    update?.message?.link?.message?.recipient?.title, update?.message?.body?.link?.chat?.title,
    update?.message?.body?.link?.message?.chat?.title, update?.message?.body?.link?.message?.recipient?.title,
    update?.message?.forward?.message?.chat?.title, update?.message?.forward?.message?.recipient?.title,
    update?.body?.message?.link?.chat?.title, update?.body?.message?.link?.message?.chat?.title,
    update?.body?.message?.link?.message?.recipient?.title, update?.body?.message?.forward?.message?.chat?.title,
    update?.body?.message?.forward?.message?.recipient?.title
  ].forEach(add);

  for (const text of __lrCfAllStrings(update)) {
    const lines = String(text).split(/\n+/).map((x) => x.trim()).filter(Boolean);
    for (const lineRaw of lines) {
      const line = lineRaw
        .replace(/^[@#]+/, '')
        .replace(/^[🔗📌✅➡️👉\-—–\s]+/, '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      add(line);
    }
  }
  return [...titles];
}

function __lrCfLinkVariants(value) {
  const raw = __lrCfClean(value, 2000);
  if (!raw) return [];
  const out = new Set();
  function add(v) {
    v = __lrCfClean(v, 600);
    if (!v) return;
    out.add(v);
    v = v.replace(/^@+/, '');
    v = v.replace(/^https?:\/\//i, '');
    v = v.replace(/^max\.ru\//i, '');
    v = v.replace(/^i\.oneme\.ru\/i\?r=/i, '');
    v = v.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
    if (v) out.add(v);
    if (v.startsWith('join/')) out.add(v.slice(5));
    const last = v.split('/').filter(Boolean).pop();
    if (last) out.add(last);
  }
  add(raw);
  try {
    const u = new URL(raw);
    add(u.href);
    add(u.pathname);
    add(u.pathname.split('/').filter(Boolean).pop() || '');
    const r = u.searchParams.get('r');
    if (r) add(r);
  } catch {}
  return [...out].filter((x) => x && x.length >= 3);
}

function __lrCfCandidateLinks(update) {
  const links = new Set();
  for (const text of __lrCfAllStrings(update)) {
    if (/(max\.ru|i\.oneme\.ru|:\/\/|join\/)/i.test(text)) {
      for (const v of __lrCfLinkVariants(text)) links.add(v);
    }
  }
  return [...links];
}

function __lrCfCandidateIds(update) {
  const ids = new Set();
  function add(v) {
    const text = __lrCfClean(v, 100);
    if (/^-?\d{5,}$/.test(text)) ids.add(text);
  }
  [
    update?.chat?.id, update?.channel?.id, update?.channel?.chat_id,
    update?.message?.chat?.id, update?.message?.chat?.chat_id,
    update?.message?.recipient?.id, update?.message?.recipient?.chat_id,
    update?.message?.link?.chat?.id, update?.message?.link?.chat?.chat_id,
    update?.message?.link?.message?.chat?.id, update?.message?.link?.message?.chat?.chat_id,
    update?.message?.link?.message?.recipient?.id, update?.message?.link?.message?.recipient?.chat_id,
    update?.message?.body?.link?.chat?.id, update?.message?.body?.link?.chat?.chat_id,
    update?.message?.body?.link?.message?.chat?.id, update?.message?.body?.link?.message?.chat?.chat_id,
    update?.message?.body?.link?.message?.recipient?.id, update?.message?.body?.link?.message?.recipient?.chat_id,
    update?.message?.forward?.message?.chat?.id, update?.message?.forward?.message?.chat?.chat_id,
    update?.message?.forward?.message?.recipient?.id, update?.message?.forward?.message?.recipient?.chat_id,
    update?.body?.message?.link?.chat?.id, update?.body?.message?.link?.chat?.chat_id,
    update?.body?.message?.link?.message?.chat?.id, update?.body?.message?.link?.message?.chat?.chat_id,
    update?.body?.message?.link?.message?.recipient?.id, update?.body?.message?.link?.message?.recipient?.chat_id
  ].forEach(add);
  return [...ids];
}

async function __lrCfSessionBusy(update) {
  let key = '';
  try { if (typeof getSessionKey === 'function') key = __lrCfClean(getSessionKey(update)); } catch {}
  if (!key || typeof getSession !== 'function') return false;
  try {
    const ses = await getSession(key).catch(() => null);
    const raw = JSON.stringify(ses || {}).toLowerCase();
    if (!raw || raw === '{}') return false;
    return (
      raw.includes('draft') || raw.includes('editor') || raw.includes('post:') || raw.includes('wait_post') ||
      raw.includes('post_content') || raw.includes('autopost') || raw.includes('calendar') || raw.includes('schedule') ||
      raw.includes('signature') || raw.includes('autosign') || raw.includes('автоподпис')
    );
  } catch { return false; }
}

async function __lrCfFindSavedChannel(update) {
  if (typeof query !== 'function') return null;
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`).catch(() => {});

  const ids = __lrCfCandidateIds(update);
  const links = __lrCfCandidateLinks(update);
  const titles = __lrCfCandidateTitles(update).map(__lrCfNorm).filter(Boolean);

  console.log('[channel forward confirm] candidates', JSON.stringify({ ids, links: links.slice(0, 10), titles: titles.slice(0, 10) }));

  const rows = await query(
    `SELECT id, max_chat_id, title, link, updated_at
     FROM channels
     WHERE COALESCE(is_active, true) = true
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT 500`
  ).catch((e) => {
    console.error('[channel forward confirm] select channels failed', e?.message || e);
    return [];
  });

  let best = null;
  let bestScore = -1;

  for (const ch of __lrCfRows(rows)) {
    const chId = String(ch.max_chat_id || '').trim();
    const chTitle = __lrCfNorm(ch.title);
    const chLinks = __lrCfLinkVariants(ch.link || '');
    let score = 0;

    if (ids.includes(chId)) score += 10000;

    for (const l of links) {
      if (chLinks.includes(l)) score += 9000;
      for (const v of __lrCfLinkVariants(l)) {
        if (chLinks.includes(v)) score += 8000;
      }
    }

    for (const t of titles) {
      if (!t || !chTitle) continue;
      if (t === chTitle) score += 6000;
      else if (t.includes(chTitle) || chTitle.includes(t)) score += 3000;
    }

    const updatedAt = ch.updated_at ? new Date(ch.updated_at).getTime() : 0;
    const fresh = updatedAt && Date.now() - updatedAt < 10 * 60 * 1000;
    if (fresh && titles.some((t) => t && chTitle && (t === chTitle || t.includes(chTitle) || chTitle.includes(t)))) {
      score += 2500;
    }

    if (score > bestScore) {
      bestScore = score;
      best = ch;
    }
  }

  if (best && bestScore >= 2500) {
    console.log('[channel forward confirm] matched saved channel', JSON.stringify({ id: best.id, max_chat_id: best.max_chat_id, title: best.title, score: bestScore }));
    return best;
  }

  console.log('[channel forward confirm] no saved channel matched', JSON.stringify({ bestScore }));
  return null;
}

async function __lrCfSend(chatId, text) {
  const id = __lrCfClean(chatId) || '405954311';
  const rows = typeof callbackButton === 'function' ? [[callbackButton('⬅️ В меню', 'main:menu')]] : undefined;

  if (typeof msg === 'function') {
    try { await msg(id, text, rows, 'html'); return true; }
    catch (e) { console.error('[channel forward confirm] msg failed', e?.message || e); }
  }

  if (typeof sendMaxMessage === 'function') {
    try {
      await sendMaxMessage({
        chatId: id,
        text,
        format: 'html',
        attachments: (typeof inlineKeyboard === 'function' && rows) ? inlineKeyboard(rows) : undefined
      });
      return true;
    } catch (e) { console.error('[channel forward confirm] sendMaxMessage failed', e?.message || e); }
  }

  return false;
}

async function __lrCfAlreadySent(chatId, channelId) {
  if (typeof query !== 'function') return false;
  const key = `lr_channel_forward_confirm:${chatId}:${channelId}`;
  const rows = await query(`SELECT updated_at FROM lr_bot_state WHERE key=$1 LIMIT 1`, [key]).catch(() => []);
  const row = __lrCfRows(rows)[0];
  if (row?.updated_at && Date.now() - new Date(row.updated_at).getTime() < 60 * 1000) return true;
  await query(
    `INSERT INTO lr_bot_state(key, value, updated_at)
     VALUES($1, $2, now())
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [key, JSON.stringify({ chatId, channelId, ts: Date.now() })]
  ).catch(() => {});
  return false;
}

async function __lrChannelForwardConfirm(update) {
  try {
    const type = __lrCfType(update);
    const text = __lrCfText(update);
    const chatId = __lrCfPrivateChatId(update);

    if (type && !type.includes('message_created')) return false;
    if (!chatId || !__lrCfIsPrivateMessage(update)) return false;
    if (text.startsWith('/')) return false;
    if (!__lrCfHasForwardEvidence(update)) return false;
    if (await __lrCfSessionBusy(update)) return false;

    const channel = await __lrCfFindSavedChannel(update);
    if (!channel) return false;

    if (await __lrCfAlreadySent(chatId, channel.id)) return true;

    await __lrCfSend(chatId, `✅ <b>Канал подключён к LinkRay</b>\n\n${__lrCfEsc(channel.title)}\n\nКанал сохранён в базе и теперь доступен для постов, автоподписей, аналитики и отчётов.`);
    return true;
  } catch (e) {
    console.error('[channel forward confirm] failed', e?.stack || e?.message || e);
    return false;
  }
}

console.log('[channel forward confirm] installed');
/* LR_CHANNEL_FORWARD_CONFIRM_END */

/* LR_GLOBAL_TYPE_GUARD_V42_START */
function lrV42Type(update) {
  try { if (typeof getUpdateType === 'function') return String(getUpdateType(update) || ''); } catch {}
  return String(
    update?.type ||
    update?.update_type ||
    update?.event_type ||
    update?.body?.type ||
    update?.body?.update_type ||
    ''
  );
}

function lrV42ChatId(update) {
  try { if (typeof getChatId === 'function') return String(getChatId(update) || ''); } catch {}
  return String(
    update?.chat_id ||
    update?.chatId ||
    update?.body?.chat_id ||
    update?.body?.chatId ||
    update?.message?.recipient?.chat_id ||
    update?.message?.recipient?.id ||
    update?.body?.message?.recipient?.chat_id ||
    update?.body?.message?.recipient?.id ||
    ''
  );
}

function lrV42Payload(update) {
  try { if (typeof getCallbackPayload === 'function') return String(getCallbackPayload(update) || ''); } catch {}
  try { if (typeof lrV31Payload === 'function') return String(lrV31Payload(update) || ''); } catch {}
  return String(
    update?.payload ||
    update?.callback?.payload ||
    update?.body?.payload ||
    update?.body?.callback?.payload ||
    update?.message?.payload ||
    ''
  );
}

function lrV42SetGlobals(update) {
  try {
    globalThis.type = lrV42Type(update);
    globalThis.chatId = lrV42ChatId(update);
    globalThis.payload = lrV42Payload(update);
    globalThis.callbackId = typeof getCallbackId === 'function' ? getCallbackId(update) : (
      update?.callback_id ||
      update?.callbackId ||
      update?.callback?.callback_id ||
      update?.callback?.id ||
      update?.body?.callback_id ||
      update?.body?.callbackId ||
      update?.body?.callback?.callback_id ||
      update?.body?.callback?.id ||
      ''
    );
  } catch (e) {
    console.error('[v42 buttons] set globals failed', e?.message || e);
  }
}

// Важно: некоторые старые слои обращаются к type/chatId как к свободным переменным.
// В Node они могут читаться из globalThis, если заданы заранее.
globalThis.type = globalThis.type || '';
globalThis.chatId = globalThis.chatId || '';
globalThis.payload = globalThis.payload || '';
globalThis.callbackId = globalThis.callbackId || '';

console.log('[v42 buttons] installed: global type/chatId guard');
/* LR_GLOBAL_TYPE_GUARD_V42_END */
/* LR_CLEAN_COLLECT_POST_START_V46_START */
function lrV46Payload(update) {
  try {
    if (typeof getCallbackPayload === 'function') return String(getCallbackPayload(update) || '');
  } catch {}

  try {
    if (typeof lrV31Payload === 'function') return String(lrV31Payload(update) || '');
  } catch {}

  try {
    if (typeof lrV42Payload === 'function') return String(lrV42Payload(update) || '');
  } catch {}

  return String(
    update?.payload ||
    update?.callback?.payload ||
    update?.body?.payload ||
    update?.body?.callback?.payload ||
    update?.message?.payload ||
    ''
  );
}

function lrV46Key(update) {
  try {
    if (typeof getSessionKey === 'function') return String(getSessionKey(update) || '');
  } catch {}

  try {
    if (typeof lrV42ChatId === 'function') return String(lrV42ChatId(update) || '');
  } catch {}

  try {
    if (typeof getChatId === 'function') return String(getChatId(update) || '');
  } catch {}

  return String(
    update?.chat_id ||
    update?.chatId ||
    update?.body?.chat_id ||
    update?.body?.chatId ||
    update?.message?.recipient?.chat_id ||
    update?.message?.recipient?.id ||
    ''
  );
}

function lrV46UniqueIds(update) {
  const base = String(lrV46Key(update) || '').trim();
  const ids = new Set();

  if (base) {
    ids.add(base);
    ids.add(`user:${base}`);
  }

  try {
    const chatId = typeof lrV42ChatId === 'function' ? String(lrV42ChatId(update) || '').trim() : '';
    if (chatId) {
      ids.add(chatId);
      ids.add(`user:${chatId}`);
    }
  } catch {}

  try {
    const chatId2 = typeof getChatId === 'function' ? String(getChatId(update) || '').trim() : '';
    if (chatId2) {
      ids.add(chatId2);
      ids.add(`user:${chatId2}`);
    }
  } catch {}

  return [...ids].filter(Boolean).slice(0, 12);
}

async function lrV46DeleteForwardDrafts(update, reason = 'manual') {
  const ids = lrV46UniqueIds(update);

  if (!ids.length) return;

  try {
    for (const id of ids) {
      await query(
        `DELETE FROM lr_bot_state
         WHERE key=$1
            OR key=$2
            OR key=$3`,
        [
          `lr_v44_forward_draft:${id}`,
          `lr_v43_forward_draft:${id}`,
          `lr_v45_forward_draft:${id}`
        ]
      ).catch(() => {});
    }

    console.log('[v46 create clean] forward drafts cleared', JSON.stringify({ reason, ids }));
  } catch (e) {
    console.error('[v46 create clean] clear forward drafts failed', e?.stack || e?.message || e);
  }
}

async function lrV46ResetCollectPostStart(update) {
  const payload = lrV46Payload(update);

  if (payload !== 'post:create') return false;

  const ids = lrV46UniqueIds(update);

  try {
    await lrV46DeleteForwardDrafts(update, 'post:create');

    for (const id of ids) {
      await query(
        `DELETE FROM bot_sessions
         WHERE user_id::text=$1`,
        [String(id)]
      ).catch(() => {});
    }

    console.log('[v46 create clean] post:create starts clean flow', JSON.stringify({ payload, ids }));
  } catch (e) {
    console.error('[v46 create clean] reset failed', e?.stack || e?.message || e);
  }

  return false;
}

console.log('[v46 create clean] installed');
/* LR_CLEAN_COLLECT_POST_START_V46_END */
async function handleMessage(update) {
  /* LR_V42_SET_GLOBALS_IN_HANDLER */
  lrV42SetGlobals(update);

  /* LR_V40_HANDLE_TYPE_FIX */
  const type = lrV40Type(update);

  if (await __lrAutosignDirectMessageV12(update).catch(e => { console.error('[autosign direct v18 message]', e?.stack || e?.message || e); return true; })) return;
  if (await __lrAutosignV9Message(update).catch(e => { console.error('[autosign v9 message]', e?.stack || e?.message || e); return false; })) return;
  __lrStartChannelDbSyncTimer();
  __lrStartChannelDbSyncTimer();
  if (await __lrShouldIgnoreInboundChannelUpdate(update)) return;
  const chatId = lrResolveReplyChatId(update, getSessionKey(update));
  await __lrRememberPrivateChatId(chatId, update);
  await __lrNotifyNewChannels(chatId, update);

  await __lrRememberPrivateChatId(chatId, update);
  await __lrNotifyNewChannels(chatId, update);
 const key = getSessionKey(update);
const text = getMessageText(update);
const n = norm(text);

/* LR_POST_FIRST_FLOW_V78_MESSAGE */
const __lrV78Command = [
  '/start',
  'start',
  '/menu',
  'меню',
  'начать',
].includes(n)
  || String(text || '').trim().startsWith('/');

if (!__lrV78Command) {
  const __lrV78Wait = await lrV78LoadWait(
    update,
    [chatId, key]
  );

  if (__lrV78Wait?.draft) {
    const __lrV78Content =
      await lrSafeHydrateContent(update);

    const __lrV78Draft = safeDraft({
      draft: __lrV78Wait.draft,
    });

    __lrV78Draft.content = {
      ...(__lrV78Draft.content || {}),
      ...(__lrV78Content || {}),
    };

    if (
      typeof lrApplyEditorPostFormat
        === 'function'
    ) {
      lrApplyEditorPostFormat(
        __lrV78Draft,
        __lrV78Content
      );
    }

    const __lrV78HasContent = Boolean(
      String(
        __lrV78Draft?.content?.text || ''
      ).trim()
      || (
        Array.isArray(
          __lrV78Draft?.content?.attachments
        )
        && __lrV78Draft.content.attachments.length
      )
      || __lrV78Draft?.content?.link
      || __lrV78Draft?.content?.raw
    );

    if (__lrV78HasContent) {
      const __lrV78Key = String(
        __lrV78Wait.sessionKey
        || key
        || chatId
        || ''
      );

      __lrV78Draft.channelIds = [];

      await lrV78ClearWait(
        __lrV78Wait,
        update
      );

      /*
       * Сохраняем материал в действующий draft.
       * После выбора каналов существующий обработчик
       * увидит контент и откроет редактор.
       */
      await lrV47StateSet(
        `lr_v44_forward_draft:${__lrV78Key}`,
        {
          draft: __lrV78Draft,
          reason: 'post_first_v78',
          ts: Date.now(),
        }
      );

      await lrV47SetSession(
        __lrV78Key,
        'select_channels',
        {
          draft: __lrV78Draft,
        }
      );

      console.log(
        '[post first v78] content -> channel select',
        JSON.stringify({
          chatId,
          key,
          effectiveKey: __lrV78Key,
          matchedBy:
            __lrV78Wait.matchedBy || null,
          textLength: String(
            __lrV78Draft?.content?.text || ''
          ).length,
          attachments:
            Array.isArray(
              __lrV78Draft?.content?.attachments
            )
              ? __lrV78Draft.content.attachments.length
              : 0,
        })
      );

      return lrV47ShowChannelSelect(
        chatId,
        __lrV78Key,
        __lrV78Draft,
        false
      );
    }

    return lrV47Msg(
      chatId,
      `⚠️ Не удалось получить содержимое поста.

Отправьте текст, фото, видео, файл
или перешлите готовый пост ещё раз.`,
      [
        [
          lrV47Btn(
            '❌ Отмена',
            'post:cancel'
          ),
        ],
      ],
      'html'
    );
  }
} log('message', { chatId, key, text: text.slice(0,80) });
  await writeFile('/tmp/linkray_last_update.json', JSON.stringify(update, null, 2)).catch(()=>{});
  if (['/start','start','/menu','меню','начать'].includes(n) || String(getUpdateType(update) || '').toLowerCase().includes('bot_started')) {
    const now = Date.now();
    const dedupeKey = String(chatId || key || 'unknown');
    const prev = __lrStartDedupeMap.get(dedupeKey) || 0;
    __lrStartDedupeMap.set(dedupeKey, now);
    if (now - prev < 3500) {
      console.log('[start dedupe] skipped duplicate start menu', JSON.stringify({ chatId: dedupeKey, diff: now - prev }));
      return;
    }
    await clearSession(key);
    return sendMain(chatId);
  }
  /* LR_V47_PENDING_DRAFT_CONSUMER_V47_6 */
const __lrV476RawIds = [
  String(key || '').trim(),
  String(chatId || '').trim(),
].filter(Boolean);

const __lrV476Ids = [
  ...new Set(
    __lrV476RawIds.flatMap((value) => {
      const plain = value.replace(/^user:/, '');

      return [
        value,
        plain,
        `user:${plain}`,
      ];
    })
  ),
];

const __lrV476PendingKeys = __lrV476Ids.map(
  (id) => `lr_v47_pending_post_content:${id}`
);

let __lrV476PendingDraft = null;
let __lrV476PendingSessionKey = String(key || '');

if (__lrV476PendingKeys.length) {
  try {
    const __lrV476RowsResult = await query(
      `SELECT key,value,updated_at
         FROM lr_bot_state
        WHERE key = ANY($1::text[])
          AND updated_at > now() - interval '30 minutes'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [__lrV476PendingKeys]
    );

    const __lrV476Rows = Array.isArray(__lrV476RowsResult)
      ? __lrV476RowsResult
      : (__lrV476RowsResult?.rows || []);

    const __lrV476Row = __lrV476Rows[0];

    if (__lrV476Row) {
      const __lrV476Value =
        typeof __lrV476Row.value === 'string'
          ? JSON.parse(__lrV476Row.value)
          : (__lrV476Row.value || {});

      __lrV476PendingDraft =
        __lrV476Value?.draft || null;

      __lrV476PendingSessionKey = String(
        __lrV476Value?.sessionKey
        || key
        || chatId
        || ''
      );
    }
  } catch (error) {
    console.error(
      '[v47.6 pending] load failed',
      error?.stack || error?.message || error
    );
  }
}

if (
  __lrV476PendingDraft
  && !String(text || '').trim().startsWith('/')
) {
  const __lrV476SelectedIds = Array.isArray(
    __lrV476PendingDraft?.channelIds
  )
    ? __lrV476PendingDraft.channelIds
        .map(Number)
        .filter(Number.isFinite)
    : [];

  const __lrV476Content =
    await lrSafeHydrateContent(update);

  const __lrV476HasContent = Boolean(
    String(__lrV476Content?.text || '').trim()
    || (
      Array.isArray(__lrV476Content?.attachments)
      && __lrV476Content.attachments.length
    )
    || __lrV476Content?.link
    || __lrV476Content?.hasRealBody
  );

  if (
    __lrV476SelectedIds.length
    && __lrV476HasContent
  ) {
    const __lrV476Draft = safeDraft({
      draft: __lrV476PendingDraft,
    });

    __lrV476Draft.channelIds =
      __lrV476SelectedIds;

    __lrV476Draft.content = {
      ...(__lrV476Draft.content || {}),
      ...(__lrV476Content || {}),
    };

    lrApplyEditorPostFormat(
      __lrV476Draft,
      __lrV476Content
    );

    __lrV476Draft.previewMessageId = null;

    const __lrV476PreviewId =
      await sendDraftPreview(
        chatId,
        __lrV476Draft
      );

    if (__lrV476PreviewId) {
      __lrV476Draft.previewMessageId =
        __lrV476PreviewId;
    }

    const __lrV476EffectiveKey =
      __lrV476PendingSessionKey
      || String(key || chatId || '');

    await setSession(
      __lrV476EffectiveKey,
      __lrV476Draft.postId
        ? 'edit_existing'
        : 'edit_draft',
      { draft: __lrV476Draft }
    );

    try {
      await query(
        `DELETE FROM lr_bot_state
          WHERE key = ANY($1::text[])`,
        [__lrV476PendingKeys]
      );
    } catch (error) {
      console.error(
        '[v47.6 pending] clear failed',
        error?.stack || error?.message || error
      );
    }

    console.log(
      '[v47.6 pending] consumed -> editor',
      JSON.stringify({
        chatId,
        key,
        effectiveKey: __lrV476EffectiveKey,
        channelIds: __lrV476Draft.channelIds,
      })
    );

    return msg(
      chatId,
      editorMenuText(),
      editorMenuRows(__lrV476Draft)
    );
  }
}

const session = await getSession(key);
const draft = safeDraft(session.data);
  if (session.state === 'wait_post_content') { 

  const content = await lrSafeHydrateContent(update); draft.content = { ...draft.content, ...content }; lrApplyEditorPostFormat(draft, content); draft.previewMessageId = null; const mid = await sendDraftPreview(chatId, draft); if (mid) draft.previewMessageId = mid; await setSession(key, 'edit_draft', { draft }); return msg(chatId, editorMenuText(), editorMenuRows(draft)); }
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
      await query(`CREATE TABLE IF NOT EXISTS channel_signatures (
  id serial PRIMARY KEY,
  channel_id integer NOT NULL,
  owner_key text NOT NULL DEFAULT 'global',
  title text,
  text text,
  format text DEFAULT 'html',
  markup jsonb DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`);
await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS owner_key text NOT NULL DEFAULT 'global'`);
await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS title text`);
await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS text text`);
await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS format text DEFAULT 'html'`);
await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS markup jsonb DEFAULT '[]'::jsonb`);
await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
await query(`ALTER TABLE channel_signatures ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

const sigText = String(content && content.text ? content.text : '').trim();
const sigMarkup = Array.isArray(content && content.markup) ? content.markup : [];

await query(
  `DELETE FROM channel_signatures WHERE channel_id=$1 AND owner_key=$2`,
  [Number(channelId), 'global']
);

await query(
  `INSERT INTO channel_signatures(channel_id, owner_key, title, text, format, markup, is_active, created_at, updated_at)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,true,now(),now())`,
  [Number(channelId), 'global', 'Автоподпись', sigText, 'html', JSON.stringify(sigMarkup)]
);

console.log('[autosign db save] wait_signature saved', JSON.stringify({ channelId: Number(channelId), len: sigText.length }));
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
  
/* LR_NATIVE_HANDLEMESSAGE_SELECT_V20_START */
/* LR_POST_FIRST_FLOW_V78_V20_GUARD */
/* LR_NATIVE_KEEP_SELECTED_CHANNELS_V20_1 */
if (session && session.state === 'wait_add_channel') {
  console.log(
    '[v20.1 native] wait_add_channel -> channel add',
    JSON.stringify({ chatId, key })
  );

  return lrV15HandleAddChannelForward(
    update,
    chatId,
    key
  );
}

const content = await lrSafeHydrateContent(update);

const __lrPostInputState = String(
  (session && session.state) || ''
);

const __lrPostHasContent = Boolean(
  String(content.text || '').trim()
  || (
    Array.isArray(content.attachments)
    && content.attachments.length
  )
  || content.link
  || content.hasRealBody
);

const __lrIsCommandLike = String(text || '')
  .trim()
  .startsWith('/');

const __lrMainPostState =
  !__lrPostInputState
  || [
    'idle',
    'main',
    'menu',
    'start',
  ].includes(__lrPostInputState);

const __lrSelectedChannelIds = [
  ...new Set(
    (
      Array.isArray(draft?.channelIds)
        ? draft.channelIds
        : (
          draft?.channelId
            ? [draft.channelId]
            : []
        )
    )
      .map(Number)
      .filter(Number.isFinite)
  ),
];

const __lrHasSelectedChannels =
  __lrSelectedChannelIds.length > 0;

const __lrSelectedPostFlow = [
  'wait_post_content',
  'post_content',
  'wait_content',
  'wait_post_media',
  'select_channels',
  'select_channels_multi',
].includes(__lrPostInputState);

/*
 * Главный ремонт:
 * если каналы уже выбраны, входящий пост добавляется
 * в существующий draft и сразу открывается редактор.
 *
 * emptyDraft() здесь использовать нельзя — он стирал
 * channelIds и повторно открывал выбор каналов.
 */
if (
  __lrSelectedPostFlow
  && __lrHasSelectedChannels
  && __lrPostHasContent
) {
  draft.channelIds = __lrSelectedChannelIds;

  draft.content = {
    ...(draft.content || {}),
    ...content,
  };

  if (typeof lrApplyEditorPostFormat === 'function') {
    lrApplyEditorPostFormat(draft, content);
  }

  draft.previewMessageId = null;

  const previewMessageId =
    await sendDraftPreview(chatId, draft);

  if (previewMessageId) {
    draft.previewMessageId = previewMessageId;
  }

  await setSession(
    key,
    draft.postId
      ? 'edit_existing'
      : 'edit_draft',
    { draft }
  );

  console.log(
    '[v20.1 native] selected channels preserved -> editor',
    JSON.stringify({
      chatId,
      key,
      state: __lrPostInputState,
      channelIds: draft.channelIds,
      textLength: String(
        draft.content?.text || ''
      ).length,
      attachments:
        Array.isArray(draft.content?.attachments)
          ? draft.content.attachments.length
          : 0,
    })
  );

  return msg(
    chatId,
    editorMenuText(),
    editorMenuRows(draft)
  );
}

/*
 * Старое разрешённое поведение сохраняется:
 * - пост из главного меню сначала открывает выбор каналов;
 * - если канал ещё не выбран, также показывается выбор.
 */
const __lrCanAcceptPostInput =
  [
    'wait_post_content',
    'post_content',
    'wait_content',
    'wait_post_media',
  ].includes(__lrPostInputState)
  || (
    __lrMainPostState
    && __lrPostHasContent
    && !__lrIsCommandLike
  );

if (
  __lrCanAcceptPostInput
  && __lrPostHasContent
) {
  const d = emptyDraft();

  d.content = {
    ...d.content,
    ...content,
  };

  if (typeof lrApplyEditorPostFormat === 'function') {
    lrApplyEditorPostFormat(d, content);
  }

  d.previewMessageId = null;

  console.log(
    '[v20.1 native] no selected channels -> channel select',
    JSON.stringify({
      chatId,
      key,
      state: __lrPostInputState,
      fromMain: __lrMainPostState,
      selectedChannels:
        __lrSelectedChannelIds.length,
      textLength: String(
        d.content?.text || ''
      ).length,
      attachments:
        Array.isArray(d.content?.attachments)
          ? d.content.attachments.length
          : 0,
    })
  );

  if (typeof lrV15SendChannelSelect === 'function') {
    return lrV15SendChannelSelect(
      chatId,
      key,
      d,
      false
    );
  }

  const channels = await getChannels();
  const rows = [];

  for (const ch of channels) {
    rows.push([
      callbackButton(
        `📡 ${channelName(ch)}`,
        `post:single:${ch.id}`
      ),
    ]);
  }

  rows.push([
    callbackButton(
      '🧩 Выбрать несколько',
      'post:multi'
    ),
    callbackButton(
      '🌐 Все каналы',
      'post:all_channels'
    ),
  ]);

  rows.push([
    callbackButton(
      '🔗 Добавить канал',
      'post:add_channel'
    ),
  ]);

  rows.push([
    callbackButton(
      '⬅️ Назад',
      'main:posting'
    ),
    callbackButton(
      '❌ Отмена',
      'post:cancel'
    ),
  ]);

  await setSession(
    key,
    'select_channels',
    { draft: d }
  );

  return msg(
    chatId,
    `━━━━━━━━━━━━━━
📡 Куда выпустить пост?

Пост принят.
Выберите канал.
━━━━━━━━━━━━━━`,
    rows,
    'html'
  );
}
/* LR_NATIVE_HANDLEMESSAGE_SELECT_V20_END */
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


/* LR_FIX_ALL_WEBHOOK_TYPE_SCOPE_V41_START */
function lrV41Type(update) {
  try { if (typeof getUpdateType === 'function') return String(getUpdateType(update) || ''); } catch {}
  return String(update?.type || update?.update_type || update?.event_type || update?.body?.type || update?.body?.update_type || '');
}
function lrV41ChatId(update) {
  try { if (typeof getChatId === 'function') return String(getChatId(update) || ''); } catch {}
  return String(
    update?.chat_id || update?.chatId || update?.body?.chat_id || update?.body?.chatId ||
    update?.message?.recipient?.chat_id || update?.message?.recipient?.id ||
    update?.body?.message?.recipient?.chat_id || update?.body?.message?.recipient?.id || ''
  );
}
function lrV41Payload(update) {
  try { if (typeof getCallbackPayload === 'function') return String(getCallbackPayload(update) || ''); } catch {}
  try { if (typeof lrV31Payload === 'function') return String(lrV31Payload(update) || ''); } catch {}
  return String(update?.payload || update?.callback?.payload || update?.body?.payload || update?.body?.callback?.payload || update?.message?.payload || '');
}
console.log('[v41 buttons] installed: all webhook routes have type/chatId scope');
/* LR_FIX_ALL_WEBHOOK_TYPE_SCOPE_V41_END */
/* LR_ANTIFRAUD_24X7_V1_START */
let lrAntiFraud24x7 = null;
try {
  const { installLinkRayAntiFraud: lrInstallAntiFraud24x7 } = await import('./linkrayAntiFraud24x7.js');
  lrAntiFraud24x7 = await lrInstallAntiFraud24x7({
    query,
    callbackButton,
    linkButton: typeof linkButton === 'function' ? linkButton : null,
    inlineKeyboard,
    answerCallback,
    sendMaxMessage,
    getChannels: typeof getChannels === 'function' ? getChannels : null,
    logger: console,
  });
  globalThis.__lrAntiFraud24x7 = lrAntiFraud24x7;
  console.log('[LinkRay AntiFraud 24/7] middleware ready');
} catch (error) {
  globalThis.__lrAntiFraud24x7 = null;
  console.error('[LinkRay AntiFraud 24/7] disabled after initialization error:', error?.stack || error?.message || error);
}

if (lrAntiFraud24x7) {
  app.use(async function lrAntiFraud24x7Middleware(req, res, next) {
    const update = req?.body;
    if (!update || typeof update !== 'object' || Array.isArray(update)) return next();
    try {
      /* LR_FRAUD_CALLBACK_ALL_V1_START */
      const lrFraudPayload = String(
        update?.payload ||
        update?.callback?.payload ||
        update?.message_callback?.payload ||
        update?.body?.payload ||
        update?.body?.callback?.payload ||
        update?.message?.payload ||
        ''
      );

      if (
        lrFraudPayload.startsWith('fraud:') &&
        typeof lrAntiFraud24x7.handleCallback === 'function'
      ) {
        await lrAntiFraud24x7.handleCallback(update);
        return res.status(200).json({
          success: true,
          antifraud: true,
          callback: lrFraudPayload,
        });
      }
      /* LR_FRAUD_CALLBACK_ALL_V1_END */

      const result = await lrAntiFraud24x7.handleHttpUpdate(update);
      if (result?.handled) return res.status(200).json({ success: true });
    } catch (error) {
      console.error('[LinkRay AntiFraud 24/7] update failed:', error?.stack || error?.message || error);
    }
    return next();
  });
}
/* LR_ANTIFRAUD_24X7_V1_END */

/* LR_FINAL_MAX_CORE_V47_START */
function lrV47Rows(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function lrV47Esc(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
  } catch {}
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrV47Token() {
  return String(
    process.env.MAX_TOKEN ||
    process.env.MAX_BOT_TOKEN ||
    process.env.MAX_ACCESS_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.ACCESS_TOKEN ||
    process.env.API_TOKEN ||
    process.env.TOKEN ||
    ''
  );
}

function lrV47ApiBase() {
  return String(
    process.env.MAX_API_BASE ||
    process.env.MAX_BASE_URL ||
    process.env.MAX_API_URL ||
    process.env.MAX_PLATFORM_API ||
    'https://platform-api2.max.ru'
  ).replace(/\/+$/, '');
}

async function lrV47Api(path, method = 'GET', body = null) {
  const token = lrV47Token();
  const url = `${lrV47ApiBase()}${path}`;
  const headers = { Authorization: token };

  if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined
  });

  const text = await response.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!response.ok || data?.success === false) {
    const err = new Error(`MAX API ${method} ${path} ${response.status}: ${text.slice(0, 500)}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return { ok: response.ok, status: response.status, data };
}

function lrV47WebhookUrl() {
  let url = String(
    process.env.WEBHOOK_URL ||
    process.env.PUBLIC_WEBHOOK_URL ||
    process.env.LINKRAY_WEBHOOK_URL ||
    ''
  ).trim();

  if (!url) {
    const base = String(
      process.env.PUBLIC_URL ||
      process.env.APP_URL ||
      process.env.LINKRAY_PUBLIC_URL ||
      process.env.DOMAIN ||
      'https://linkray.ru'
    ).trim().replace(/\/+$/, '');
    url = `${base}/webhook`;
  }

  if (!/^https:\/\//i.test(url)) url = 'https://linkray.ru/webhook';

  return url.replace(/\/+$/, '');
}

function lrV47Type(update) {
  try { if (typeof getUpdateType === 'function') return String(getUpdateType(update) || ''); } catch {}
  return String(
    update?.type ||
    update?.update_type ||
    update?.event_type ||
    update?.body?.type ||
    update?.body?.update_type ||
    ''
  );
}

function lrV47Payload(update) {
  try { if (typeof getCallbackPayload === 'function') return String(getCallbackPayload(update) || ''); } catch {}
  try { if (typeof lrV31Payload === 'function') return String(lrV31Payload(update) || ''); } catch {}
  try { if (typeof lrV42Payload === 'function') return String(lrV42Payload(update) || ''); } catch {}
  return String(
    update?.payload ||
    update?.callback?.payload ||
    update?.body?.payload ||
    update?.body?.callback?.payload ||
    update?.message?.payload ||
    ''
  );
}

function lrV47CallbackId(update) {
  try { if (typeof getCallbackId === 'function') return getCallbackId(update); } catch {}
  return (
    update?.callback_id ||
    update?.callbackId ||
    update?.callback?.callback_id ||
    update?.callback?.id ||
    update?.body?.callback_id ||
    update?.body?.callbackId ||
    update?.body?.callback?.callback_id ||
    update?.body?.callback?.id ||
    null
  );
}

function lrV47ChatId(update) {
  try { if (typeof getChatId === 'function') return String(getChatId(update) || ''); } catch {}
  try { if (typeof lrV42ChatId === 'function') return String(lrV42ChatId(update) || ''); } catch {}

  return String(
    update?.chat_id ||
    update?.chatId ||
    update?.body?.chat_id ||
    update?.body?.chatId ||
    update?.message?.recipient?.chat_id ||
    update?.message?.recipient?.id ||
    update?.body?.message?.recipient?.chat_id ||
    update?.body?.message?.recipient?.id ||
    update?.message?.chat_id ||
    update?.message?.chatId ||
    ''
  );
}

function lrV47SenderId(update) {
  return String(
    update?.user_id ||
    update?.userId ||
    update?.sender?.user_id ||
    update?.sender?.id ||
    update?.message?.sender?.user_id ||
    update?.message?.sender?.id ||
    update?.body?.user_id ||
    update?.body?.userId ||
    update?.body?.message?.sender?.user_id ||
    update?.body?.message?.sender?.id ||
    ''
  );
}

function lrV47PrivateChatId(update) {
  const chatId = lrV47ChatId(update);
  if (chatId && !String(chatId).startsWith('-')) return chatId;

  const sender = lrV47SenderId(update);
  if (sender && !String(sender).startsWith('-')) return sender;

  return chatId || '405954311';
}

function lrV47Key(update) {
  try { if (typeof getSessionKey === 'function') return String(getSessionKey(update) || ''); } catch {}
  return lrV47PrivateChatId(update) || lrV47ChatId(update) || '';
}

function lrV47SetGlobals(update) {
  try {
    globalThis.type = lrV47Type(update);
    globalThis.chatId = lrV47ChatId(update);
    globalThis.payload = lrV47Payload(update);
    globalThis.callbackId = lrV47CallbackId(update);
    globalThis.__lastUpdate = update;
  } catch (e) {
    console.error('[v47 final] set globals failed', e?.message || e);
  }
}

globalThis.type = globalThis.type || '';
globalThis.chatId = globalThis.chatId || '';
globalThis.payload = globalThis.payload || '';
globalThis.callbackId = globalThis.callbackId || '';

function lrV47Btn(text, payload) {
  if (typeof callbackButton === 'function') return callbackButton(text, payload);
  return { type: 'callback', text, payload };
}

async function lrV47Msg(chatId, text, rows = [], format = 'html') {
  if (!chatId) return false;

  try {
    if (typeof msg === 'function') {
      await msg(chatId, text, rows, format);
      console.log('[v47 final] msg sent', JSON.stringify({ chatId }));
      return true;
    }
  } catch (e) {
    console.error('[v47 final] msg failed', e?.stack || e?.message || e);
  }

  try {
    if (typeof sendMaxMessage === 'function') {
      const attachments = rows && rows.length && typeof inlineKeyboard === 'function' ? inlineKeyboard(rows) : rows;
      await sendMaxMessage({ chatId, text, format, attachments });
      console.log('[v47 final] sendMaxMessage sent', JSON.stringify({ chatId }));
      return true;
    }
  } catch (e) {
    console.error('[v47 final] sendMaxMessage failed', e?.stack || e?.message || e);
  }

  return false;
}

async function lrV47Cb(callbackId, chatId, text, rows = [], format = 'html') {
  if (callbackId && typeof cb === 'function') {
    try {
      await cb(callbackId, text, rows, format);
      console.log('[v47 final] cb sent', JSON.stringify({ chatId }));
      return true;
    } catch (e) {
      console.error('[v47 final] cb failed, fallback msg', e?.stack || e?.message || e);
    }
  }

  return lrV47Msg(chatId, text, rows, format);
}

async function lrV47Ack(callbackId, text = '') {
  if (!callbackId) return;
  try {
    if (typeof answerCallback === 'function') {
      await answerCallback({ callbackId, notification: text || 'Готово' });
    }
  } catch {}
}

async function lrV47SetSession(key, state, data = {}) {
  const k = String(key || '').trim();
  if (!k) return;

  try {
    if (typeof setSession === 'function') {
      await setSession(k, state, data);
      return;
    }
  } catch (e) {
    console.error('[v47 final] setSession native failed', e?.message || e);
  }

  try {
    await query(
      `INSERT INTO bot_sessions(user_id,state,data,updated_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,data=EXCLUDED.data,updated_at=now()`,
      [k, state, JSON.stringify(data || {})]
    );
  } catch (e) {
    console.error('[v47 final] setSession DB failed', e?.stack || e?.message || e);
  }
}

async function lrV47GetSession(key) {
  const k = String(key || '').trim();
  if (!k) return null;

  try {
    if (typeof getSession === 'function') return await getSession(k);
  } catch (e) {
    console.error('[v47 final] getSession native failed', e?.message || e);
  }

  try {
    const rows = lrV47Rows(await query(
      `SELECT user_id,state,data,updated_at
       FROM bot_sessions
       WHERE user_id::text=$1 OR user_id::text=$2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [k, `user:${k}`]
    ));
    return rows[0] || null;
  } catch (e) {
    console.error('[v47 final] getSession DB failed', e?.stack || e?.message || e);
    return null;
  }
}

async function lrV47ClearSession(key) {
  const k = String(key || '').trim();
  if (!k) return;

  try {
    if (typeof clearSession === 'function') {
      await clearSession(k);
    }
  } catch {}

  try {
    await query(
      `DELETE FROM bot_sessions
       WHERE user_id::text=$1 OR user_id::text=$2`,
      [k, `user:${k}`]
    );
  } catch {}
}

async function lrV47StateSet(key, value) {
  try {
    await query(
      `INSERT INTO lr_bot_state(key,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [key, JSON.stringify(value || {})]
    );
  } catch (e) {
    console.error('[v47 final] state set failed', e?.stack || e?.message || e);
  }
}

async function lrV47StateGet(key) {
  try {
    const rows = lrV47Rows(await query(`SELECT value FROM lr_bot_state WHERE key=$1 LIMIT 1`, [key]));
    if (!rows[0]) return null;
    return typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
  } catch {
    return null;
  }
}

async function lrV47StateDelLike(patterns) {
  try {
    for (const pattern of patterns) {
      await query(`DELETE FROM lr_bot_state WHERE key LIKE $1`, [pattern]).catch(() => {});
    }
  } catch {}
}

function lrV47EmptyDraft() {
  try {
    if (typeof emptyDraft === 'function') return emptyDraft();
  } catch {}

  return {
    content: { text: '', format: 'html', markup: [], attachments: [] },
    buttons: [],
    isAd: false,
    cpm: null,
    channelIds: [],
    scheduleDate: null,
    signatureEnabled: true,
    autoDeleteMinutes: null,
    reportAfterHours: 24,
    campaignId: `lr-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  };
}

function lrV47SessionDraft(session) {
  const data = session?.data || {};
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return parsed?.draft || parsed || lrV47EmptyDraft();
    } catch {}
  }
  return data?.draft || data || lrV47EmptyDraft();
}

function lrV47DraftHasContent(draft) {
  try {
    if (typeof hasDraftContent === 'function' && hasDraftContent(draft)) return true;
  } catch {}

  const d = draft || {};
  const c = d.content || {};

  if (String(c.text || d.text || d.caption || d.html || '').trim()) return true;
  if (Array.isArray(c.attachments) && c.attachments.length) return true;
  if (Array.isArray(d.attachments) && d.attachments.length) return true;
  if (Array.isArray(c.media) && c.media.length) return true;
  if (Array.isArray(d.media) && d.media.length) return true;
  if (c.link || d.link || c.forward || d.forward || c.forwarded || d.forwarded) return true;
  if (c.raw || d.raw || c.message || d.message || c.message_id || d.message_id || c.messageId || d.messageId) return true;

  return false;
}

async function lrV47Channels(subjectId = '') {
  /* LR_USER_SCOPED_STUDIO_CHANNELS_V87_5
   *
   * Изолированная фильтрация только списка каналов Studio.
   * Добавление каналов, редактор, публикация, аналитика,
   * AntiFraud и закупы не изменяются.
   */
  const subject = String(subjectId || '')
    .replace(/^user:/, '')
    .trim();

  if (!/^\d+$/.test(subject)) {
    console.error(
      '[v87.5 studio channels] invalid user context',
      JSON.stringify({ subjectId })
    );
    return [];
  }

  try {
    return lrV47Rows(await query(`
      SELECT DISTINCT
        channel.id,
        channel.max_chat_id,
        channel.title,
        channel.link,
        channel.is_active,
        channel.updated_at
      FROM public.channels channel
      JOIN public.lr_user_channels access
        ON access.channel_id=channel.id
      JOIN public.lr_users user_account
        ON user_account.id=access.user_id
      WHERE (
          user_account.max_user_id::text=$1
          OR user_account.private_chat_id::text=$1
        )
        AND COALESCE(user_account.is_blocked, false)=false
        AND COALESCE(channel.is_active, true)=true
        AND LOWER(COALESCE(access.role, '')) IN (
          'owner',
          'admin',
          'administrator'
        )
        AND (
          COALESCE(access.access_source, '')='workspace'
          OR access.last_verified_at >=
             now() - interval '30 minutes'
        )
      ORDER BY
        channel.updated_at DESC NULLS LAST,
        channel.id DESC
    `, [subject]));
  } catch (error) {
    /*
     * При ошибке возвращаем пустой список.
     * Общий список чужих каналов как fallback запрещён.
     */
    console.error(
      '[v87.5 studio channels] scoped query failed',
      error?.stack || error?.message || error
    );
    return [];
  }
}



function lrV47ChannelName(ch) {
  try {
    if (typeof channelName === 'function') return channelName(ch);
  } catch {}

  return String(ch?.title || ch?.name || ch?.max_chat_id || ch?.id || 'Канал');
}

function lrV47ChannelButtonText(ch, selected = false) {
  return `${selected ? '✅' : '📡'} ${lrV47ChannelName(ch)}`;
}

function lrV47SelectText(draft) {
  const has = lrV47DraftHasContent(draft);
  return `━━━━━━━━━━━━━━
📡 <b>Куда выпустить пост?</b>

${has ? 'Пост принят.' : 'Сначала выберите канал.'}
Выберите один канал, несколько каналов или все каналы.
━━━━━━━━━━━━━━`;
}

async function lrV47ShowChannelSelect(
  chatId,
  key,
  draft = null,
  multi = false,
  callbackId = null
) {
  /* LR_V47_MULTI_SAME_MESSAGE_V47_3 */
  const channels = await lrV47Channels(key || chatId);
  const d = draft || lrV47EmptyDraft();

  d.channelIds = Array.isArray(d.channelIds)
    ? d.channelIds
    : [];

  const render = async (text, rows) => {
    if (callbackId) {
      return lrV47Cb(
        callbackId,
        chatId,
        text,
        rows,
        'html'
      );
    }

    return lrV47Msg(
      chatId,
      text,
      rows,
      'html'
    );
  };

  if (!channels.length) {
    await lrV47SetSession(
      key,
      'select_channels',
      { draft: d }
    );

    return render(
      `━━━━━━━━━━━━━━
🔗 Подключить канал

Сначала добавьте канал в LinkRay.
━━━━━━━━━━━━━━`,
      [
        [
          lrV47Btn(
            '🔗 Добавить канал',
            'post:add_channel'
          ),
        ],
        [
          lrV47Btn(
            '⬅️ В меню',
            'main:menu'
          ),
        ],
      ]
    );
  }

  const rows = [];

  for (const ch of channels) {
    const channelId = Number(ch.id);
    const selected = d.channelIds
      .map(Number)
      .includes(channelId);

    rows.push([
      lrV47Btn(
        lrV47ChannelButtonText(ch, selected),
        multi
          ? `post:toggle:${ch.id}`
          : `post:single:${ch.id}`
      ),
    ]);
  }

  rows.push([
    lrV47Btn(
      '🧩 Выбрать несколько',
      'post:multi'
    ),
    lrV47Btn(
      '🌐 Все каналы',
      'post:all_channels'
    ),
  ]);

  if (multi) {
    rows.push([
      lrV47Btn(
        '➡️ Далее',
        'post:channels_next'
      ),
    ]);
  }

  rows.push([
    lrV47Btn(
      '🔗 Добавить канал',
      'post:add_channel'
    ),
  ]);

  rows.push([
    lrV47Btn(
      '⬅️ Назад',
      'main:posting'
    ),
    lrV47Btn(
      '❌ Отмена',
      'post:cancel'
    ),
  ]);

  await lrV47SetSession(
    key,
    multi
      ? 'select_channels_multi'
      : 'select_channels',
    { draft: d }
  );

  return render(
    lrV47SelectText(d),
    rows
  );
}

async function lrV47AskContent(chatId, key, draft) {
  /* LR_V47_PENDING_DRAFT_ROUTE_V47_6 */
  const d = draft || lrV47EmptyDraft();

  d.channelIds = Array.isArray(d.channelIds)
    ? d.channelIds.map(Number).filter(Number.isFinite)
    : [];

  await lrV47SetSession(
    key,
    'wait_post_content',
    { draft: d }
  );

  const rawIds = [
    String(key || '').trim(),
    String(chatId || '').trim(),
  ].filter(Boolean);

  const pendingIds = [
    ...new Set(
      rawIds.flatMap((value) => {
        const plain = value.replace(/^user:/, '');

        return [
          value,
          plain,
          `user:${plain}`,
        ];
      })
    ),
  ];

  const pendingValue = {
    draft: d,
    chatId: String(chatId || ''),
    sessionKey: String(key || ''),
    ts: Date.now(),
  };

  for (const id of pendingIds) {
    await lrV47StateSet(
      `lr_v47_pending_post_content:${id}`,
      pendingValue
    );
  }

  console.log(
    '[v47.6 pending] selected draft saved',
    JSON.stringify({
      chatId,
      key,
      pendingIds,
      channelIds: d.channelIds,
    })
  );

  const channels = await lrV47Channels(key || chatId);

  const selected = channels.filter((channel) =>
    d.channelIds.includes(Number(channel.id))
  );

  const list = selected.length
    ? selected
        .map(
          (channel) =>
            `• ${lrV47Esc(lrV47ChannelName(channel))}`
        )
        .join('\n')
    : '—';

  return lrV47Msg(
    chatId,
    `━━━━━━━━━━━━━━
📨 Отправьте пост

Каналы:
${list}

Можно отправить текст, фото, видео,
файл или пересланный пост.
━━━━━━━━━━━━━━`,
    [
      [
        lrV47Btn(
          '⬅️ К каналам',
          'post:change_channels'
        ),
      ],
      [
        lrV47Btn(
          '❌ Отмена',
          'post:cancel'
        ),
      ],
    ],
    'html'
  );
}

function lrV47EditorRows(draft) {
  try {
    if (typeof editorMenuRows === 'function') return editorMenuRows(draft);
  } catch {}

  return [
    [lrV47Btn('✏️ Изменить текст', 'editor:text'), lrV47Btn('🖼 Медиа', 'editor:media')],
    [lrV47Btn('⚫ Добавить кнопку', 'editor:button'), lrV47Btn('🏷 Автоподпись', 'editor:signature')],
    [lrV47Btn('💼 Рекламный пост', 'editor:ad')],
    [lrV47Btn('➡️ Далее', 'editor:next')],
    [lrV47Btn('⬅️ Назад', 'editor:back'), lrV47Btn('❌ Отмена', 'post:cancel')]
  ];
}

function lrV47EditorText() {
  try {
    if (typeof editorMenuText === 'function') return editorMenuText();
  } catch {}

  return `━━━━━━━━━━━━━━
🧬 <b>Редактор LinkRay</b>

Пост-превью находится выше.
При изменении текста, медиа, кнопок или автоподписи превью будет обновляться.

Настройте оформление.
━━━━━━━━━━━━━━`;
}

async function lrV47OpenEditor(chatId, key, draft) {
  const d = draft || lrV47EmptyDraft();

  await lrV47SetSession(key, d.postId ? 'edit_existing' : 'edit_draft', { draft: d });

  try {
    if (typeof sendDraftPreview === 'function') {
      await sendDraftPreview(chatId, d);
      console.log('[v47 final] preview sent before editor menu', JSON.stringify({ chatId }));
    } else if (typeof sendMaxMessage === 'function') {
      const content = d.content || {};
      const text = content.text || d.text || '';
      const attachments = Array.isArray(content.attachments) ? content.attachments : [];
      if (text || attachments.length) {
        await sendMaxMessage({ chatId, text, format: content.format || 'html', attachments });
      }
    }
  } catch (e) {
    console.error('[v47 final] preview failed', e?.stack || e?.message || e);
  }

  await lrV47Msg(chatId, lrV47EditorText(), lrV47EditorRows(d), 'html');
  return true;
}

async function lrV47ExtractDraft(update) {
  const draft = lrV47EmptyDraft();

  try {
    if (typeof lrSafeHydrateContent === 'function') {
      const content = await lrSafeHydrateContent(update);
      draft.content = {
        ...draft.content,
        ...content,
        raw: update
      };
      if (!Array.isArray(draft.content.attachments)) draft.content.attachments = [];
      return draft;
    }
  } catch (e) {
    console.error('[v47 final] lrSafeHydrateContent failed', e?.message || e);
  }

  const msgObj =
    update?.message ||
    update?.body?.message ||
    update?.message_created ||
    update?.body?.message_created ||
    {};

  const content = msgObj.content || msgObj.body || update?.content || update?.body?.content || {};
  const text =
    content.text ||
    content.caption ||
    msgObj.text ||
    msgObj.caption ||
    update?.text ||
    update?.body?.text ||
    '';

  draft.content = {
    ...draft.content,
    text: String(text || ''),
    format: 'html',
    markup: content.markup || content.entities || msgObj.markup || [],
    attachments: Array.isArray(content.attachments) ? content.attachments :
      (Array.isArray(msgObj.attachments) ? msgObj.attachments : []),
    raw: update
  };

  if (!lrV47DraftHasContent(draft)) {
    draft.content.raw = update;
  }

  return draft;
}

function lrV47LooksForwarded(update) {
  const raw = JSON.stringify(update || {});
  if (/forward|forwarded|linked_message|linkedMessage|"link"\s*:/i.test(raw)) return true;

  const msgObj = update?.message || update?.body?.message || {};
  const content = msgObj.content || update?.content || {};
  if (content?.attachments?.length || msgObj?.attachments?.length) return true;
  if (String(content?.text || msgObj?.text || '').trim()) return true;

  return false;
}

async function lrV47ClearTempDrafts(key) {
  const k = String(key || '').trim();

  if (!k) {
    return;
  }

  const plain = k.replace(/^user:/, '');

  await lrV47StateDelLike([
    `lr_v44_forward_draft:${k}`,
    `lr_v43_forward_draft:${k}`,
    `lr_v45_forward_draft:${k}`,
    `lr_v47_forward_draft:${k}`,
    `lr_v47_pending_post_content:${k}`,
    `lr_v47_pending_post_content:${plain}`,
    `lr_v47_pending_post_content:user:${plain}`,
  ]);
}

/* LR_POST_FIRST_FLOW_V78_HELPERS_START */
/* LR_POST_FIRST_FLOW_V78 */
function lrV78CleanId(value) {
  return String(value ?? '')
    .trim()
    .replace(/^user:/, '')
    .slice(0, 180);
}

function lrV78IdentityIds(update, extras = []) {
  const values = [
    ...extras,

    update?.user_id,
    update?.userId,
    update?.user?.user_id,
    update?.user?.userId,
    update?.user?.id,

    update?.sender?.user_id,
    update?.sender?.userId,
    update?.sender?.id,

    update?.callback?.user_id,
    update?.callback?.userId,
    update?.callback?.user?.user_id,
    update?.callback?.user?.userId,
    update?.callback?.user?.id,

    update?.message_callback?.user_id,
    update?.message_callback?.userId,
    update?.message_callback?.user?.user_id,
    update?.message_callback?.user?.userId,
    update?.message_callback?.user?.id,

    update?.message?.sender?.user_id,
    update?.message?.sender?.userId,
    update?.message?.sender?.id,

    update?.message?.recipient?.chat_id,
    update?.message?.recipient?.chatId,
    update?.message?.recipient?.id,

    update?.chat_id,
    update?.chatId,

    update?.body?.user_id,
    update?.body?.userId,
    update?.body?.user?.user_id,
    update?.body?.user?.userId,
    update?.body?.user?.id,

    update?.body?.callback?.user_id,
    update?.body?.callback?.userId,
    update?.body?.callback?.user?.user_id,
    update?.body?.callback?.user?.userId,
    update?.body?.callback?.user?.id,

    update?.body?.message?.sender?.user_id,
    update?.body?.message?.sender?.userId,
    update?.body?.message?.sender?.id,

    update?.body?.message?.recipient?.chat_id,
    update?.body?.message?.recipient?.chatId,
    update?.body?.message?.recipient?.id,
  ];

  try {
    values.push(lrV47SenderId(update));
  } catch (_) {}

  try {
    values.push(lrV47ChatId(update));
  } catch (_) {}

  try {
    values.push(lrV47PrivateChatId(update));
  } catch (_) {}

  try {
    values.push(lrV47Key(update));
  } catch (_) {}

  try {
    if (typeof getSessionKey === 'function') {
      values.push(getSessionKey(update));
    }
  } catch (_) {}

  const ids = new Set();

  for (const value of values) {
    const plain = lrV78CleanId(value);

    if (!plain || plain === '0') {
      continue;
    }

    ids.add(plain);
    ids.add(`user:${plain}`);
  }

  return [...ids];
}

function lrV78WaitKey(id) {
  return `lr_v78_wait_post:${String(id || '').slice(0, 190)}`;
}

async function lrV78SaveWait(update, chatId, key, draft) {
  const ids = lrV78IdentityIds(
    update,
    [chatId, key]
  );

  const value = {
    draft,
    ids,
    chatId: String(chatId || ''),
    sessionKey: String(key || ''),
    ts: Date.now(),
  };

  for (const id of ids) {
    await lrV47StateSet(
      lrV78WaitKey(id),
      value
    );
  }

  return value;
}

async function lrV78LoadWait(update, extras = []) {
  const ids = lrV78IdentityIds(
    update,
    extras
  );

  for (const id of ids) {
    const value = await lrV47StateGet(
      lrV78WaitKey(id)
    );

    if (
      value?.draft
      && Number(value?.ts || 0)
        > Date.now() - 30 * 60 * 1000
    ) {
      return {
        ...value,
        matchedBy: id,
      };
    }
  }

  /*
   * Резерв допустим только при одном незавершённом
   * создании поста за последние 30 минут.
   */
  try {
    const rows = lrV47Rows(
      await query(
        `SELECT key,value,updated_at
           FROM lr_bot_state
          WHERE key LIKE 'lr_v78_wait_post:%'
            AND updated_at > now() - interval '30 minutes'
          ORDER BY updated_at DESC
          LIMIT 20`
      )
    );

    const unique = new Map();

    for (const row of rows) {
      let value = row?.value || {};

      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch (_) {
          value = {};
        }
      }

      if (!value?.draft) {
        continue;
      }

      const signature = JSON.stringify({
        chatId: value?.chatId || '',
        sessionKey: value?.sessionKey || '',
        ts: value?.ts || 0,
      });

      unique.set(signature, value);
    }

    if (unique.size === 1) {
      return {
        ...[...unique.values()][0],
        matchedBy: 'single-recent-wait',
      };
    }
  } catch (error) {
    console.error(
      '[post first v78] fallback failed',
      error?.stack || error?.message || error
    );
  }

  return null;
}

async function lrV78ClearWait(wait, update) {
  const ids = new Set([
    ...(Array.isArray(wait?.ids) ? wait.ids : []),
    ...lrV78IdentityIds(
      update,
      [wait?.chatId, wait?.sessionKey]
    ),
  ]);

  for (const id of ids) {
    try {
      await query(
        `DELETE FROM lr_bot_state WHERE key=$1`,
        [lrV78WaitKey(id)]
      );
    } catch (_) {}
  }
}
/* LR_POST_FIRST_FLOW_V78_HELPERS_END */
async function lrV47StartCreate(update) {
  /* LR_POST_FIRST_FLOW_V78 */
  const callbackId = lrV47CallbackId(update);
  const chatId = lrV47PrivateChatId(update);
  const key = lrV47Key(update);
  const draft = lrV47EmptyDraft();

  await lrV47ClearTempDrafts(key);
  await lrV47ClearSession(key);

  /*
   * Старые pending-записи больше не должны влиять
   * на новый порядок создания поста.
   */
  const ids = lrV78IdentityIds(
    update,
    [chatId, key]
  );

  for (const id of ids) {
    try {
      await query(
        `DELETE FROM lr_bot_state
          WHERE key=$1
             OR key=$2
             OR key=$3`,
        [
          `lr_v47_pending_post_content:${id}`,
          `lr_v77_pending_post:${id}`,
          `lr_v44_forward_draft:${id}`,
        ]
      );
    } catch (_) {}
  }

  await lrV47SetSession(
    key,
    'wait_post_first_v78',
    {
      draft,
      mode: 'post_first',
      ts: Date.now(),
    }
  );

  await lrV78SaveWait(
    update,
    chatId,
    key,
    draft
  );

  await lrV47Ack(
    callbackId,
    'Отправьте пост'
  );

  console.log(
    '[post first v78] waiting content',
    JSON.stringify({
      chatId,
      key,
      ids,
    })
  );

  return lrV47Cb(
    callbackId,
    chatId,
    `━━━━━━━━━━━━━━
📨 Отправьте пост

Сначала отправьте текст, фото, видео,
файл или перешлите готовый пост.

После этого LinkRay один раз покажет
выбор каналов и откроет редактор.
━━━━━━━━━━━━━━`,
    [
      [
        lrV47Btn(
          '⬅️ В Studio',
          'main:posting'
        ),
      ],
      [
        lrV47Btn(
          '❌ Отмена',
          'post:cancel'
        ),
      ],
    ],
    'html'
  );
}

async function lrV47ShowAddChannel(update) {
  const callbackId = lrV47CallbackId(update);
  const chatId = lrV47PrivateChatId(update);
  const key = lrV47Key(update);

  const baseline = lrV47Rows(await query(`SELECT COALESCE(MAX(id),0)::int AS id FROM channels`).catch(() => [{ id: 0 }]))[0]?.id || 0;

  await lrV47SetSession(key, 'wait_add_channel', { mode: 'add_channel', chatId, ts: Date.now(), baselineId: baseline });
  await lrV47StateSet(`lr_v47_add_wait:${key}`, { privateChatId: chatId, key, baselineId: baseline, ts: Date.now() });
  await lrV47StateSet(`lr_v47_add_wait_global`, { privateChatId: chatId, key, baselineId: baseline, ts: Date.now() });

  const text = `━━━━━━━━━━━━━━
🔗 <b>Добавить канал</b>

1. Откройте канал в MAX.
2. Добавьте LinkRay в администраторы.
3. Выдайте право публикации.
4. Перешлите любой пост из этого канала сюда, в бота.

Если LinkRay не является администратором — канал не будет добавлен.
━━━━━━━━━━━━━━`;

  console.log('[v47 final] add channel mode enabled', JSON.stringify({ chatId, key, baseline }));

  return lrV47Cb(callbackId, chatId, text, [[lrV47Btn('⬅️ В меню', 'main:menu')]], 'html');
}

async function lrV47IsAddMode(update) {
  const key = lrV47Key(update);
  const session = await lrV47GetSession(key);
  if (session?.state === 'wait_add_channel') return true;

  const st = await lrV47StateGet(`lr_v47_add_wait:${key}`);
  if (st && Date.now() - Number(st.ts || 0) < 30 * 60 * 1000) return true;

  return false;
}

async function lrV47LatestChannelAfter(baselineId = 0) {
  try {
    const rows = lrV47Rows(await query(
      `SELECT id, max_chat_id, title, link, is_active, updated_at
       FROM channels
       WHERE id > $1
          OR updated_at > now() - interval '2 minutes'
       ORDER BY id DESC, updated_at DESC
       LIMIT 1`,
      [Number(baselineId || 0)]
    ));

    return rows[0] || null;
  } catch {
    return null;
  }
}

async function lrV47NotifyConnected(chatId, key, channel) {
  if (!channel) return false;

  const stateKey = `lr_v47_connected_notified:${chatId}:${channel.id}`;

  if (await lrV47StateGet(stateKey)) {
    console.log('[v47 final] duplicate connected notification skipped', JSON.stringify({ chatId, id: channel.id }));
    return true;
  }

  const ok = await lrV47Msg(chatId, `✅ <b>Канал подключён к LinkRay</b>

${lrV47Esc(channel.title || 'Канал')}

Канал сохранён в базе и теперь доступен для постов, автоподписей, аналитики и отчётов.`, [
    [lrV47Btn('⬅️ Главное меню', 'main:menu')]
  ], 'html');

  if (ok) {
    await lrV47StateSet(stateKey, { chatId, key, channel, ts: Date.now() });
    console.log('[v47 final] connected notification done', JSON.stringify({
      chatId,
      key,
      id: channel.id,
      max_chat_id: channel.max_chat_id,
      title: channel.title
    }));
  }

  return ok;
}

async function lrV47HandleAddForward(update) {
  const isAdd = await lrV47IsAddMode(update);
  if (!isAdd) return false;

  const chatId = lrV47PrivateChatId(update);
  const key = lrV47Key(update);
  const st = await lrV47StateGet(`lr_v47_add_wait:${key}`) || await lrV47StateGet('lr_v47_add_wait_global') || {};
  const baseline = Number(st.baselineId || 0);

  console.log('[v47 final] add forward intercepted', JSON.stringify({ chatId, key, baseline }));

  let result = false;
  try {
    if (typeof maybeRegisterChannel === 'function') {
      result = await maybeRegisterChannel(update);
    }
  } catch (e) {
    console.error('[v47 final] maybeRegisterChannel failed', e?.stack || e?.message || e);
  }

  const channel = await lrV47LatestChannelAfter(baseline);

  if (channel) {
    await lrV47ClearSession(key);
    await lrV47StateDelLike([`lr_v47_add_wait:${key}`, 'lr_v47_add_wait_global']);
    await lrV47NotifyConnected(chatId, key, channel);
    return true;
  }

  if (result === true) {
    // На случай, если maybeRegisterChannel вернул true, но канал уже был старый.
    const old = await lrV47LatestChannelAfter(0);
    if (old) {
      await lrV47ClearSession(key);
      await lrV47NotifyConnected(chatId, key, old);
      return true;
    }
  }

  await lrV47Msg(chatId, `❌ <b>Бот не является администратором канала</b>

Сначала добавьте LinkRay в администраторы канала и выдайте право публикации.

Канал не добавлен в базу.`, [
    [lrV47Btn('⬅️ Главное меню', 'main:menu')]
  ], 'html');

  return true;
}

async function lrV47HandleMainForward(update) {
  if (!lrV47LooksForwarded(update)) return false;

  const chatId = lrV47PrivateChatId(update);
  const key = lrV47Key(update);
  const draft = await lrV47ExtractDraft(update);

  await lrV47ClearTempDrafts(key);
  await lrV47StateSet(`lr_v47_forward_draft:${key}`, { draft, ts: Date.now() });
  await lrV47SetSession(key, 'select_channels', { draft });

  console.log('[v47 final] main forward -> channel select', JSON.stringify({
    chatId,
    key,
    hasContent: lrV47DraftHasContent(draft)
  }));

  await lrV47ShowChannelSelect(chatId, key, draft, false);
  return true;
}

async function lrV47HandleSelectedChannels(
  update,
  payload
) {
  const callbackId = lrV47CallbackId(update);
  const chatId = lrV47PrivateChatId(update);
  const key = lrV47Key(update);
  const session = await lrV47GetSession(key);
  const draft = lrV47SessionDraft(session);

  if (payload.startsWith('post:single:')) {
    const id = Number(payload.split(':')[2]);

    draft.channelIds = Number.isFinite(id)
      ? [id]
      : [];

    console.log(
      '[v47 final] channel selected',
      JSON.stringify({
        chatId,
        key,
        id,
        hasContent: lrV47DraftHasContent(draft),
      })
    );

    await lrV47Ack(
      callbackId,
      'Канал выбран'
    );

    if (lrV47DraftHasContent(draft)) {
      return lrV47OpenEditor(
        chatId,
        key,
        draft
      );
    }

    return lrV47AskContent(
      chatId,
      key,
      draft
    );
  }

  if (payload === 'post:all_channels') {
    const channels = await lrV47Channels(key || chatId);

    draft.channelIds = channels
      .map((ch) => Number(ch.id))
      .filter(Number.isFinite);

    console.log(
      '[v47 final] all channels selected',
      JSON.stringify({
        chatId,
        key,
        count: draft.channelIds.length,
        hasContent: lrV47DraftHasContent(draft),
      })
    );

    await lrV47Ack(
      callbackId,
      'Все каналы выбраны'
    );

    if (lrV47DraftHasContent(draft)) {
      return lrV47OpenEditor(
        chatId,
        key,
        draft
      );
    }

    return lrV47AskContent(
      chatId,
      key,
      draft
    );
  }

  if (payload === 'post:multi') {
    await lrV47Ack(
      callbackId,
      'Выберите несколько каналов'
    );

    return lrV47ShowChannelSelect(
      chatId,
      key,
      draft,
      true,
      callbackId
    );
  }

  if (payload.startsWith('post:toggle:')) {
    const id = Number(payload.split(':')[2]);

    draft.channelIds = Array.isArray(draft.channelIds)
      ? draft.channelIds.map(Number)
      : [];

    if (Number.isFinite(id)) {
      if (draft.channelIds.includes(id)) {
        draft.channelIds = draft.channelIds.filter(
          (selectedId) => Number(selectedId) !== id
        );
      } else {
        draft.channelIds.push(id);
      }
    }

    await lrV47Ack(
      callbackId,
      'Выбор обновлён'
    );

    return lrV47ShowChannelSelect(
      chatId,
      key,
      draft,
      true,
      callbackId
    );
  }

  if (payload === 'post:channels_next') {
    draft.channelIds = Array.isArray(draft.channelIds)
      ? draft.channelIds.map(Number)
      : [];

    if (!draft.channelIds.length) {
      await lrV47Ack(
        callbackId,
        'Сначала выберите канал'
      );

      return lrV47ShowChannelSelect(
        chatId,
        key,
        draft,
        true,
        callbackId
      );
    }

    if (lrV47DraftHasContent(draft)) {
      return lrV47OpenEditor(
        chatId,
        key,
        draft
      );
    }

    return lrV47AskContent(
      chatId,
      key,
      draft
    );
  }

  return false;
}

async function lrV47HandlePostsList(update) {
  const callbackId = lrV47CallbackId(update);
  const chatId = lrV47PrivateChatId(update);

  try {
    if (typeof showPosts === 'function') {
      await showPosts(callbackId, 'all', null, null, chatId);
      console.log('[v47 final] posts list opened', JSON.stringify({ chatId }));
      return true;
    }
  } catch (e) {
    console.error('[v47 final] showPosts failed', e?.stack || e?.message || e);
  }

  await lrV47Cb(callbackId, chatId, `━━━━━━━━━━━━━━
📁 <b>Посты</b>

Не удалось открыть список через старый обработчик.
Попробуйте ещё раз после перезапуска.
━━━━━━━━━━━━━━`, [[lrV47Btn('⬅️ В Studio', 'main:posting')]], 'html');

  return true;
}

async function lrV47HandleBotRemoved(update) {
  const type = lrV47Type(update);
  if (!/bot_removed|chat_deleted|bot_deleted/i.test(type)) return false;

  const removedChatId = lrV47ChatId(update);

  try {
    if (removedChatId) {
      await query(
        `UPDATE channels
         SET is_active=false, updated_at=now()
         WHERE max_chat_id::text=$1`,
        [String(removedChatId)]
      ).catch(() => {});
    }
  } catch {}

  const targets = new Set(['405954311']);

  try {
    const rows = lrV47Rows(await query(
      `SELECT value
       FROM lr_bot_state
       WHERE key LIKE 'lr_v47_connected_notified:%'
          OR key LIKE 'lr_v31_channel_connected_notified:%'
          OR key LIKE 'lr_v35_channel_connected_notified:%'
       ORDER BY updated_at DESC
       LIMIT 30`
    ));

    for (const row of rows) {
      const v = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      if (v?.chatId) targets.add(String(v.chatId));
      if (v?.privateChatId) targets.add(String(v.privateChatId));
    }
  } catch {}

  for (const target of targets) {
    await lrV47Msg(target, `✅ <b>Канал удалён из LinkRay</b>

Бот был удалён из администраторов канала.
Канал отключён в базе и больше не будет использоваться для постов.`, [
      [lrV47Btn('⬅️ Главное меню', 'main:menu')]
    ], 'html');
  }

  console.log('[v47 final] bot_removed handled', JSON.stringify({ removedChatId, targets: [...targets] }));
  return true;
}

async function lrV47HandleCallback(update) {
  const payload = lrV47Payload(update);

  if (!payload) return false;

  if (payload === 'post:create') return lrV47StartCreate(update);
  if (payload === 'post:add_channel') return lrV47ShowAddChannel(update);
  if (payload === 'post:all') return lrV47HandlePostsList(update);

  if (
    payload.startsWith('post:single:') ||
    payload === 'post:all_channels' ||
    payload === 'post:multi' ||
    payload.startsWith('post:toggle:') ||
    payload === 'post:channels_next'
  ) {
    return lrV47HandleSelectedChannels(update, payload);
  }

  if (payload === 'post:cancel') {
    const chatId = lrV47PrivateChatId(update);
    const key = lrV47Key(update);
    await lrV47ClearSession(key);
    await lrV47ClearTempDrafts(key);
    if (typeof sendMain === 'function') {
      try {
        await sendMain(chatId);
        return true;
      } catch {}
    }
    await lrV47Msg(chatId, 'Отменено.', [[lrV47Btn('⬅️ Главное меню', 'main:menu')]], 'html');
    return true;
  }

  return false;
}

async function lrV47HandleMessageCreated(update) {
  /* LR_V47_POST_SESSION_ROUTE_V47_5 */
  if (await lrV47HandleBotRemoved(update)) {
    return true;
  }

  if (await lrV47HandleAddForward(update)) {
    return true;
  }

  const chatId = lrV47PrivateChatId(update);
  const senderId = lrV47SenderId(update);
  const recipientChatId = lrV47ChatId(update);

  let nativeKey = '';

  try {
    nativeKey =
      typeof getSessionKey === 'function'
        ? String(getSessionKey(update) || '')
        : '';
  } catch (_) {}

  const candidates = [
    nativeKey,
    lrV47Key(update),
    chatId,
    senderId,
    recipientChatId,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const expandedCandidates = [
    ...new Set(
      candidates.flatMap((value) => {
        const plain = value.replace(/^user:/, '');

        return [
          value,
          plain,
          `user:${plain}`,
        ];
      })
    ),
  ];

  let key = expandedCandidates[0] || chatId;
  let session = null;

  /*
   * Callback выбора каналов и следующее message_created
   * могут возвращать разные ключи. Ищем именно активную
   * wait_post_content-сессию по всем ID этого пользователя.
   */
  for (const candidate of expandedCandidates) {
    const current =
      await lrV47GetSession(candidate).catch(() => null);

    if (!current) {
      continue;
    }

    const currentState = String(current?.state || '');

    if (currentState === 'wait_post_content') {
      key = String(current?.user_id || candidate);
      session = current;
      break;
    }

    if (!session) {
      key = String(current?.user_id || candidate);
      session = current;
    }
  }

  /*
   * Дополнительная точная DB-проверка по тому же набору
   * ключей. Чужая недавняя сессия здесь не выбирается.
   */
  if (
    String(session?.state || '') !== 'wait_post_content'
    && expandedCandidates.length
  ) {
    try {
      const rows = lrV47Rows(
        await query(
          `SELECT user_id,state,data,updated_at
             FROM bot_sessions
            WHERE state='wait_post_content'
              AND user_id::text = ANY($1::text[])
            ORDER BY updated_at DESC
            LIMIT 1`,
          [expandedCandidates]
        )
      );

      if (rows[0]) {
        session = rows[0];
        key = String(rows[0].user_id || key);
      }
    } catch (error) {
      console.error(
        '[v47.5 session route] candidate DB lookup failed',
        error?.stack || error?.message || error
      );
    }
  }

  const state = String(session?.state || '');

  console.log(
    '[v47.5 session route] resolved',
    JSON.stringify({
      chatId,
      senderId,
      recipientChatId,
      nativeKey,
      candidates: expandedCandidates,
      resolvedKey: key,
      state,
    })
  );

  if (state === 'wait_post_content') {
    const draft = lrV47SessionDraft(session);

    const selectedChannelIds = Array.isArray(
      draft?.channelIds
    )
      ? draft.channelIds
          .map(Number)
          .filter(Number.isFinite)
      : [];

    if (!selectedChannelIds.length) {
      console.error(
        '[v47.5 session route] selected channels lost',
        JSON.stringify({
          chatId,
          key,
          state,
        })
      );

      await lrV47ShowChannelSelect(
        chatId,
        key,
        draft,
        true
      );

      return true;
    }

    const incomingDraft =
      await lrV47ExtractDraft(update);

    draft.content = {
      ...(draft.content || {}),
      ...(incomingDraft?.content || {}),
    };

    if (
      Array.isArray(incomingDraft?.buttons)
      && incomingDraft.buttons.length
    ) {
      draft.buttons = incomingDraft.buttons;
    }

    /*
     * Каналы берём только из сделанного пользователем выбора.
     * Источник пересланного поста не может их заменить.
     */
    draft.channelIds = selectedChannelIds;
    draft.previewMessageId = null;

    await lrV47OpenEditor(
      chatId,
      key,
      draft
    );

    console.log(
      '[v47.5 session route] opened existing editor',
      JSON.stringify({
        chatId,
        key,
        channelIds: draft.channelIds,
        hasContent: lrV47DraftHasContent(draft),
      })
    );

    return true;
  }

  /*
   * Другие состояния редактора остаются у уже существующих
   * обработчиков. С главного меню пересланный пост по-прежнему
   * начинает новый сценарий с выбора каналов.
   */
  if (
    [
      'post_content',
      'wait_content',
      'wait_post_media',
    ].includes(state)
  ) {
    return false;
  }

  return lrV47HandleMainForward(update);
}

async function lrV47InstallSubscriptions() {
  const token = lrV47Token();
  if (!token) {
    console.log('[v47 final] subscription skipped: no token');
    return;
  }

  const url = lrV47WebhookUrl();

  const body = {
    url,
    update_types: [
      'bot_added',
      'bot_removed',
      'bot_started',
      'message_created',
      'message_callback',
      'message_edited',
      'message_removed', 'user_added', 'user_removed']
  };

  const secret = String(process.env.WEBHOOK_SECRET || process.env.MAX_WEBHOOK_SECRET || '').trim();
  if (secret && /^[a-zA-Z0-9_-]{5,256}$/.test(secret)) body.secret = secret;

  try {
    const r = await lrV47Api('/subscriptions', 'POST', body);
    console.log('[v47 final] subscription install result', JSON.stringify({ ok: true, status: r.status, url, response: r.data }));
  } catch (e) {
    console.error('[v47 final] subscription install failed', e?.stack || e?.message || e);
  }
}

try {
  setTimeout(() => lrV47InstallSubscriptions().catch(e => console.error('[v47 final] startup failed', e?.stack || e?.message || e)), 1500);
} catch {}

app.use(async function lrFinalMaxCoreV47(req, res, next) {
  try {
    if (req.method !== 'POST') return next();
    if (!String(req.path || req.url || '').includes('/webhook')) return next();

    const update = req.body || {};
    lrV47SetGlobals(update);

    const type = lrV47Type(update);
    const payload = lrV47Payload(update);
    const chatId = lrV47ChatId(update);

    console.log('[v47 final] webhook', JSON.stringify({ type, payload, chatId, key: lrV47Key(update) }));

    let handled = false;

    if (/callback/i.test(type) || payload) {
      handled = await lrV47HandleCallback(update);
    } else if (/message_created|message_edited|bot_added|bot_removed|chat_/i.test(type)) {
      handled = await lrV47HandleMessageCreated(update);
    } else {
      handled = await lrV47HandleMessageCreated(update);
    }

    if (handled) {
      if (!res.headersSent) return res.json({ ok: true, handled: 'lr_final_max_core_v47' });
      return;
    }

    return next();
  } catch (e) {
    console.error('[v47 final] middleware failed', e?.stack || e?.message || e);
    if (!res.headersSent) return res.json({ ok: true, handled: 'lr_final_max_core_v47_error_logged' });
  }
});

console.log('[v47 final] installed');
/* LR_FINAL_MAX_CORE_V47_END */


/* LR_V59_SYNC_EDITOR_AND_REPORT_GUARD_START */
function lrV59Rows(result) { if (Array.isArray(result)) return result; if (result && Array.isArray(result.rows)) return result.rows; return []; }
function lrV59Json(value, fallback = {}) { if (value === null || value === undefined || value === '') return fallback; if (typeof value === 'object') return value; try { return JSON.parse(String(value)); } catch (_) { return fallback; } }
function lrV59Esc(value) { try { if (typeof escapeHtml === 'function') return escapeHtml(String(value ?? '')); } catch (_) {} return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function lrV59Btn(label, payload) { if (typeof callbackButton === 'function') return callbackButton(label, payload); return { type: 'callback', text: label, payload }; }
function lrV59Type(update) { try { if (typeof getUpdateType === 'function') return String(getUpdateType(update) || ''); } catch (_) {} return String(update?.update_type || update?.type || update?.event_type || update?.event || ''); }
function lrV59ChatId(update) { try { if (typeof getChatId === 'function') return String(getChatId(update) || ''); } catch (_) {} return String(update?.recipient?.chat_id || update?.message?.recipient?.chat_id || update?.chat_id || update?.chatId || update?.chat?.id || ''); }
function lrV59Key(update, chatId) { try { if (typeof getSessionKey === 'function') return String(getSessionKey(update) || chatId || ''); } catch (_) {} return String(chatId || update?.user_id || update?.sender?.user_id || update?.message?.sender?.user_id || update?.message?.sender?.id || ''); }
function lrV59Text(update) { const vals = [update?.message?.body?.text, update?.message?.text, update?.message?.content?.text, update?.body?.text, update?.text, update?.content?.text]; for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim(); return ''; }
function lrV59Decode(value) { const raw = String(value || ''); try { return decodeURIComponent(raw); } catch (_) { return raw; } }
function lrV59Encode(value) { try { return encodeURIComponent(String(value ?? '')); } catch (_) { return String(value ?? ''); } }
function lrV59Today() { try { if (typeof lrV51Today === 'function') return lrV51Today(); } catch (_) {} return new Date().toISOString().slice(0, 10); }
function lrV59ParseTarget(data) { const raw = lrV59Decode(data?.virtualId || data?.postKey || data?.itemKey || data?.target || data?.id || ''); const m = String(raw).match(/(?:^|:)(scheduled_posts|ad_post_trackers|ad_post_tracker_channels|lr_post_entry_v68):(\d+)(?:$|:)/); if (!m) return null; return { table: m[1], id: Number(m[2]), raw }; }
function lrV59CtxFromSession(data) { return { virtualId: data?.virtualId || data?.postKey || data?.itemKey || data?.target || data?.id || '', channelKey: data?.channelKey || data?.channel || data?.channel_id || 'all', day: data?.day || lrV59Today(), filter: data?.filter || 'all', page: Number(data?.page || 0) || 0 }; }
function lrV59OpenPayload(ctx) { return `lr_plan_v51:open:${lrV59Encode(ctx.virtualId)}:${lrV59Encode(ctx.channelKey || 'all')}:${ctx.day || lrV59Today()}:${ctx.filter || 'all'}:${ctx.page || 0}`; }
async function lrV59Send(chatId, text, rows = []) { if (!chatId) return null; try { if (typeof msg === 'function') return await msg(chatId, text, rows || [], 'html'); } catch (e) { console.error('[v59 sync] msg failed', e?.stack || e?.message || e); } try { if (typeof sendMaxMessage === 'function') { const payload = { chatId, text, format: 'html' }; if (rows && rows.length) { try { payload.attachments = typeof inlineKeyboard === 'function' ? inlineKeyboard(rows) : rows; } catch (_) { payload.attachments = rows; } } return await sendMaxMessage(payload); } } catch (e) { console.error('[v59 sync] sendMaxMessage failed', e?.stack || e?.message || e); } return null; }
async function lrV59GetSession(key) { if (!key || typeof query !== 'function') return null; const r = await query(`SELECT user_id,state,data,updated_at FROM bot_sessions WHERE user_id::text=$1 ORDER BY updated_at DESC LIMIT 1`, [String(key)]); return lrV59Rows(r)[0] || null; }
async function lrV59ClearSession(key) { if (!key) return; try { if (typeof clearSession === 'function') return await clearSession(key); } catch (_) {} if (typeof query === 'function') await query(`UPDATE bot_sessions SET state='idle', data='{}'::jsonb, updated_at=now() WHERE user_id::text=$1`, [String(key)]).catch(()=>{}); }
function lrV59Published(row) { const status = String(row?.status || row?.state || row?.publish_status || '').toLowerCase(); if (/published|sent|done|posted|success|опублик|отправ|выпущ/.test(status)) return true; return Boolean(row?.published_at || row?.sent_at || row?.posted_at || row?.delivered_at || row?.fact_publish_at || row?.max_message_id || row?.published_message_id || row?.sent_message_id || row?.message_id); }
function lrV59MessageId(row) { const draft = lrV59Json(row?.draft, {}); const meta = lrV59Json(row?.meta, {}); const raw = lrV59Json(row?.raw, {}); const vals = [row?.published_message_id,row?.max_message_id,row?.sent_message_id,row?.message_id,row?.messageId,row?.post_message_id,row?.channel_message_id,meta?.published_message_id,meta?.max_message_id,meta?.message_id,draft?.published_message_id,draft?.max_message_id,draft?.message_id,draft?.content?.message_id,raw?.message_id,raw?.message?.message_id,raw?.message?.id]; for (const v of vals) { const t = String(v ?? '').trim(); if (t && t !== 'null' && t !== 'undefined' && t !== '[object Object]') return t; } return ''; }
function lrV59ApiToken() { for (const k of ['MAX_TOKEN','MAX_BOT_TOKEN','MAX_ACCESS_TOKEN','BOT_TOKEN','ACCESS_TOKEN','API_TOKEN','TOKEN']) if (process.env[k]) return String(process.env[k]); try { if (typeof MAX_TOKEN !== 'undefined' && MAX_TOKEN) return String(MAX_TOKEN); } catch (_) {} try { if (typeof BOT_TOKEN !== 'undefined' && BOT_TOKEN) return String(BOT_TOKEN); } catch (_) {} try { if (typeof TOKEN !== 'undefined' && TOKEN) return String(TOKEN); } catch (_) {} return ''; }
function lrV59ApiBase() { let base = ''; try { if (typeof MAX_API_BASE !== 'undefined' && MAX_API_BASE) base = String(MAX_API_BASE); } catch (_) {} return String(base || process.env.MAX_API_BASE || process.env.MAX_BASE_URL || process.env.MAX_PLATFORM_API || process.env.MAX_API_URL || 'https://platform-api2.max.ru').replace(/\/+$/, ''); }
async function lrV59PutMessage(messageId, text, format = 'html') { const token = lrV59ApiToken(); if (!messageId) return { ok: false, skipped: true, reason: 'published message_id not found' }; if (!token) return { ok: false, skipped: true, reason: 'MAX token not found' }; const url = `${lrV59ApiBase()}/messages?message_id=${encodeURIComponent(String(messageId))}`; const body = { text: String(text || ''), attachments: null, notify: false, format: format || 'html' }; const response = await fetch(url, { method: 'PUT', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const raw = await response.text().catch(() => ''); let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { raw }; } const ok = response.ok && (!data || data.success !== false); console.log('[v59 sync] PUT /messages result', JSON.stringify({ messageId, status: response.status, ok, preview: raw.slice(0, 300) })); return { ok, status: response.status, data, raw, messageId }; }
async function lrV59LoadScheduled(id) { const r = await query(`SELECT sp.*, c.max_chat_id AS lr_channel_chat_id, c.title AS lr_channel_title FROM scheduled_posts sp LEFT JOIN channels c ON c.id=sp.channel_id WHERE sp.id=$1 LIMIT 1`, [id]); return lrV59Rows(r)[0] || null; }
async function lrV59UpdateScheduledText(id, text) { const before = await lrV59LoadScheduled(id).catch(() => null); if (!before) throw new Error('post row not found: scheduled_posts:' + id); const groupId = before.report_group_id ? String(before.report_group_id) : ''; const sql = groupId ? `UPDATE scheduled_posts SET text=$1, draft = CASE WHEN draft IS NULL THEN draft ELSE jsonb_set(jsonb_set(COALESCE(draft, '{}'::jsonb), '{text}', to_jsonb($1::text), true), '{content}', COALESCE(draft->'content','{}'::jsonb) || jsonb_build_object('text',$1::text), true) END, updated_at=now() WHERE id=$2 OR report_group_id=$3 RETURNING *` : `UPDATE scheduled_posts SET text=$1, draft = CASE WHEN draft IS NULL THEN draft ELSE jsonb_set(jsonb_set(COALESCE(draft, '{}'::jsonb), '{text}', to_jsonb($1::text), true), '{content}', COALESCE(draft->'content','{}'::jsonb) || jsonb_build_object('text',$1::text), true) END, updated_at=now() WHERE id=$2 RETURNING *`; const params = groupId ? [text, id, groupId] : [text, id]; const r = await query(sql, params); const updated = lrV59Rows(r); if (!updated.length) throw new Error('post row not found after update: scheduled_posts:' + id); return updated; }
async function lrV59UpdatePostText(target, text) { if (!target || !Number.isFinite(target.id)) throw new Error('post target not found'); if (target.table === 'scheduled_posts') return await lrV59UpdateScheduledText(target.id, text); if (target.table === 'ad_post_trackers') { const r = await query(`UPDATE ad_post_trackers SET post_text=$1, updated_at=now() WHERE id=$2 RETURNING *`, [text, target.id]); const row = lrV59Rows(r)[0]; if (!row) throw new Error('post row not found after update: ad_post_trackers:' + target.id); return [row]; } if (target.table === 'ad_post_tracker_channels') { const r = await query(`UPDATE ad_post_tracker_channels SET post_text=$1, updated_at=now() WHERE id=$2 RETURNING *`, [text, target.id]); const row = lrV59Rows(r)[0]; if (!row) throw new Error('post row not found after update: ad_post_tracker_channels:' + target.id); return [row]; } if (target.table === 'lr_post_entry_v68') { const r = await query(`UPDATE lr_post_entry_v68 SET text=$1 WHERE id=$2 RETURNING *`, [text, target.id]); const row = lrV59Rows(r)[0]; if (!row) throw new Error('post row not found after update: lr_post_entry_v68:' + target.id); return [row]; } throw new Error('unsupported post table: ' + target.table); }
async function lrV59SyncPublishedRows(rowsToSync, text) { const seen = new Set(); const results = []; for (const row of rowsToSync || []) { if (!lrV59Published(row)) { results.push({ ok: true, skipped: true, reason: 'not published yet' }); continue; } const messageId = lrV59MessageId(row); if (!messageId || seen.has(messageId)) continue; seen.add(messageId); try { results.push(await lrV59PutMessage(messageId, text, row?.format || 'html')); } catch (e) { results.push({ ok: false, error: e?.message || String(e), messageId }); console.error('[v59 sync] PUT failed', e?.stack || e?.message || e); } } return results; }
async function lrV59HandleTextInput(update, chatId, key, session) { const state = String(session?.state || ''); if (!['content_plan_v59_wait_text','content_plan_v58_wait_text','content_plan_v57_wait_text','content_plan_v56_wait_text','content_plan_v55_wait_text','content_plan_v54_wait_text','content_plan_v53_wait_text'].includes(state)) return false; const text = lrV59Text(update); if (!text || text.startsWith('/')) return false; const data = lrV59Json(session?.data, {}); const ctx = lrV59CtxFromSession(data); const target = lrV59ParseTarget(data); console.log('[v59 sync] text input', JSON.stringify({ chatId, key, state, ctx, target })); const updatedRows = await lrV59UpdatePostText(target, text); const syncResults = await lrV59SyncPublishedRows(updatedRows, text); await lrV59ClearSession(key); const okCount = syncResults.filter(x => x && x.ok && !x.skipped).length; const publishedAttemptCount = syncResults.filter(x => x && !x.skipped).length; let note = '✅ <b>Текст поста сохранён</b>\n\nИзменения записаны в контент-план.'; if (okCount > 0) note += `\nКанал MAX тоже обновлён${okCount > 1 ? `: ${okCount} сообщений` : ''}.`; else if (publishedAttemptCount === 0) note += '\nПост ещё не опубликован или у него не найден message_id, поэтому в канале обновлять пока нечего.'; else { const err = syncResults.find(x => x && !x.ok)?.error || syncResults.find(x => x && !x.ok)?.raw || 'ошибка MAX API'; note += `\n⚠️ В базе сохранено, но канал не обновился: ${lrV59Esc(err)}.`; } await lrV59Send(chatId, note, [[lrV59Btn('⬅️ К редактору', lrV59OpenPayload(ctx))]]); try { if (typeof lrV57OpenPost === 'function') await lrV57OpenPost(null, chatId, key, ctx.virtualId, ctx.channelKey, ctx.day, ctx.filter, ctx.page); } catch (e) { console.error('[v59 sync] reopen editor failed', e?.stack || e?.message || e); } console.log('[v59 sync] text saved and channel sync finished', JSON.stringify({ chatId, key, target, updatedRows: updatedRows.length, syncResults })); return true; }
async function lrV59Webhook(req, res, next) { try { const update = req.body || {}; const type = lrV59Type(update); if (type !== 'message_created') return next(); const chatId = lrV59ChatId(update); const key = lrV59Key(update, chatId); if (!key) return next(); const session = await lrV59GetSession(key).catch(() => null); if (session && await lrV59HandleTextInput(update, chatId, key, session)) { if (res && !res.headersSent) return res.json({ ok: true, handled: 'lr_v59_sync_editor_to_channel' }); return; } return next(); } catch (e) { console.error('[v59 sync] webhook failed', e?.stack || e?.message || e); try { const update = req.body || {}; const chatId = lrV59ChatId(update); await lrV59Send(chatId, `❌ <b>Ошибка при сохранении текста</b>\n\n${lrV59Esc(e?.message || e)}`, []); } catch (_) {} if (res && !res.headersSent) return res.json({ ok: true, handled: 'lr_v59_sync_error' }); return; } }
try { if (typeof app !== 'undefined' && app && typeof app.use === 'function') { app.use('/webhook', lrV59Webhook); console.log('[v59 sync] installed: no-click 24h report guard + content-plan edits update published MAX message'); } } catch (e) { console.error('[v59 sync] install failed', e?.stack || e?.message || e); }
/* LR_V59_SYNC_EDITOR_AND_REPORT_GUARD_END */

/* LR_PLAN_POST_PREVIEW_EDITOR_V57_START */
// v57: в контент-плане при открытии поста показываем сам пост сверху,
// затем меню редактора ниже. После изменения текста редактор открывается снова уже с обновлённым превью.
function lrV57Rows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}
function lrV57Esc(value) {
  try { if (typeof escapeHtml === 'function') return escapeHtml(String(value ?? '')); } catch (_) {}
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function lrV57Json(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return fallback; }
}
function lrV57Arr(value) {
  const v = lrV57Json(value, value);
  if (Array.isArray(v)) return v;
  return [];
}
function lrV57Btn(label, payload) {
  if (typeof callbackButton === 'function') return callbackButton(label, payload);
  return { type: 'callback', text: label, payload };
}
function lrV57Keyboard(rows) {
  try { if (typeof inlineKeyboard === 'function') return inlineKeyboard(rows); } catch (_) {}
  return rows;
}
function lrV57PayloadSafe(value) {
  try { if (typeof lrV51PayloadSafe === 'function') return lrV51PayloadSafe(value); } catch (_) {}
  try { return encodeURIComponent(String(value ?? '')); } catch (_) { return String(value ?? ''); }
}
function lrV57PayloadRead(value) {
  try { if (typeof lrV51PayloadRead === 'function') return lrV51PayloadRead(value); } catch (_) {}
  try { return decodeURIComponent(String(value ?? '')); } catch (_) { return String(value ?? ''); }
}
function lrV57Today() {
  try { if (typeof lrV51Today === 'function') return lrV51Today(); } catch (_) {}
  return new Date().toISOString().slice(0, 10);
}
function lrV57Time(value) {
  try { if (typeof lrV51Time === 'function') return lrV51Time(value); } catch (_) {}
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}
function lrV57HumanDay(value) {
  try { if (typeof lrV51HumanDay === 'function') return lrV51HumanDay(value); } catch (_) {}
  return String(value || lrV57Today());
}
function lrV57Type(update) {
  try { if (typeof getUpdateType === 'function') return String(getUpdateType(update) || ''); } catch (_) {}
  return String(update?.update_type || update?.type || update?.event_type || update?.event || '');
}
function lrV57Payload(update) {
  try { if (typeof getCallbackPayload === 'function') return String(getCallbackPayload(update) || ''); } catch (_) {}
  return String(update?.callback?.payload || update?.message?.callback?.payload || update?.payload || update?.message?.payload || '');
}
function lrV57ChatId(update) {
  try { if (typeof getChatId === 'function') return String(getChatId(update) || ''); } catch (_) {}
  return String(update?.recipient?.chat_id || update?.message?.recipient?.chat_id || update?.chat_id || update?.chatId || update?.chat?.id || '');
}
function lrV57Key(update, chatId) {
  try { if (typeof getSessionKey === 'function') return String(getSessionKey(update) || chatId || ''); } catch (_) {}
  return String(chatId || update?.user_id || update?.sender?.user_id || update?.message?.sender?.user_id || update?.message?.sender?.id || '');
}
function lrV57Text(update) {
  const vals = [
    update?.message?.body?.text,
    update?.message?.text,
    update?.message?.content?.text,
    update?.body?.text,
    update?.text,
    update?.content?.text
  ];
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}
function lrV57ParseCtxFromPayload(payload) {
  const parts = String(payload || '').split(':');
  return {
    action: parts[1] || '',
    virtualId: lrV57PayloadRead(parts[2] || ''),
    channelKey: lrV57PayloadRead(parts[3] || 'all') || 'all',
    day: parts[4] || lrV57Today(),
    filter: parts[5] || 'all',
    page: Number(parts[6] || 0) || 0
  };
}
function lrV57OpenPayload(ctx) {
  return `lr_plan_v51:open:${lrV57PayloadSafe(ctx.virtualId)}:${lrV57PayloadSafe(ctx.channelKey || 'all')}:${ctx.day || lrV57Today()}:${ctx.filter || 'all'}:${ctx.page || 0}`;
}
function lrV57ListPayload(ctx) {
  return `lr_plan_v51:view:${lrV57PayloadSafe(ctx.channelKey || 'all')}:${ctx.day || lrV57Today()}:${ctx.filter || 'all'}:${ctx.page || 0}`;
}
function lrV57ActionPayload(action, ctx) {
  return `lr_plan_v51:${action}:${lrV57PayloadSafe(ctx.virtualId)}:${lrV57PayloadSafe(ctx.channelKey || 'all')}:${ctx.day || lrV57Today()}:${ctx.filter || 'all'}:${ctx.page || 0}`;
}
async function lrV57SetSession(key, state, data) {
  if (!key) return;
  try { if (typeof lrV51SetState === 'function') return await lrV51SetState(key, state, data || {}); } catch (_) {}
  try { if (typeof setSession === 'function') return await setSession(key, state, data || {}); } catch (_) {}
  if (typeof query === 'function') {
    await query(
      `INSERT INTO bot_sessions(user_id,state,data,updated_at)
       VALUES($1,$2,$3::jsonb,now())
       ON CONFLICT (user_id) DO UPDATE SET state=EXCLUDED.state,data=EXCLUDED.data,updated_at=now()`,
      [String(key), String(state), JSON.stringify(data || {})]
    ).catch(e => console.error('[v57 plan preview] setSession failed', e?.message || e));
  }
}
async function lrV57GetSession(key) {
  if (!key || typeof query !== 'function') return null;
  const r = await query(
    `SELECT user_id,state,data,updated_at FROM bot_sessions WHERE user_id::text=$1 ORDER BY updated_at DESC LIMIT 1`,
    [String(key)]
  );
  return lrV57Rows(r)[0] || null;
}
async function lrV57ClearSession(key) {
  if (!key) return;
  try { if (typeof clearSession === 'function') return await clearSession(key); } catch (_) {}
  if (typeof query === 'function') {
    await query(`UPDATE bot_sessions SET state='idle', data='{}'::jsonb, updated_at=now() WHERE user_id::text=$1`, [String(key)]).catch(()=>{});
  }
}
function lrV57PostTargetFromVirtual(virtualId) {
  const raw = lrV57PayloadRead(virtualId || '');
  const m = String(raw).match(/(?:^|:)(scheduled_posts|ad_post_trackers|ad_post_tracker_channels|lr_post_entry_v68):(\d+)(?:$|:)/);
  if (!m) return null;
  return { table: m[1], id: Number(m[2]), raw };
}
async function lrV57LoadPosts() {
  if (typeof lrV51LoadPosts === 'function') return await lrV51LoadPosts();
  return [];
}
async function lrV57LoadChannels() {
  if (typeof lrV51LoadChannels === 'function') return await lrV51LoadChannels();
  return [];
}
function lrV57FindPost(posts, virtualId) {
  const v = lrV57PayloadRead(virtualId || '');
  return posts.find(p => String(p.__v51Id || '') === v) ||
         posts.find(p => String(p.__v51Id || '') === String(virtualId || '')) ||
         null;
}
function lrV57ChannelTitle(row, channels, channelKey) {
  try { if (typeof lrV51ChannelTitle === 'function') return lrV51ChannelTitle(row, channels) || ''; } catch (_) {}
  const id = String(row?.__v51ChannelId || row?.channel_id || row?.chat_id || '');
  const ch = channels.find(c => String(c.id) === id || String(c.max_chat_id) === id || String(c.id) === String(channelKey));
  return ch?.title || (channelKey === 'all' ? 'Все каналы' : 'Канал');
}
function lrV57IsAd(row) {
  try { if (typeof lrV51IsAd === 'function') return lrV51IsAd(row); } catch (_) {}
  return Boolean(row?.is_ad || row?.isAd || row?.cpm);
}
function lrV57AutoDelete(row) {
  try { if (typeof lrV51AutoDelete === 'function') return lrV51AutoDelete(row); } catch (_) {}
  const n = Number(row?.auto_delete_minutes || row?.autoDeleteMinutes || 0);
  if (Number.isFinite(n) && n > 0) return n % 60 === 0 ? `${n/60}ч` : `${n}м`;
  return '';
}
function lrV57PostLong(row) {
  try { if (typeof lrV51PostLong === 'function') return lrV51PostLong(row); } catch (_) {}
  return String(row?.text || row?.post_text || row?.caption || row?.body || row?.__v51Title || 'Пост');
}
function lrV57CollectAttachments(row) {
  const draft = lrV57Json(row?.draft, {});
  const meta = lrV57Json(row?.meta, {});
  const raw = lrV57Json(row?.raw, {});
  const candidates = [
    row?.attachments,
    draft?.attachments,
    draft?.content?.attachments,
    draft?.raw?.attachments,
    draft?.message?.attachments,
    meta?.attachments,
    raw?.attachments,
    raw?.message?.attachments,
    row?.content?.attachments,
  ];
  for (const c of candidates) {
    const arr = lrV57Arr(c);
    if (arr.length) return arr;
  }
  return [];
}
function lrV57CollectButtons(row) {
  const draft = lrV57Json(row?.draft, {});
  const meta = lrV57Json(row?.meta, {});
  const candidates = [row?.buttons, draft?.buttons, draft?.content?.buttons, meta?.buttons];
  for (const c of candidates) {
    const arr = lrV57Arr(c);
    if (arr.length) return arr;
  }
  return [];
}
function lrV57CollectText(row) {
  const draft = lrV57Json(row?.draft, {});
  const content = lrV57Json(row?.content, {});
  const raw = lrV57Json(row?.raw, {});
  const vals = [
    row?.text,
    row?.post_text,
    row?.message_text,
    row?.caption,
    row?.body,
    row?.content_text,
    draft?.content?.text,
    draft?.text,
    draft?.raw?.text,
    draft?.raw?.body?.text,
    content?.text,
    raw?.text,
    raw?.body?.text,
    row?.__v51Title
  ];
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return lrV57PostLong(row);
}
function lrV57DraftFromRow(row, ctx) {
  const text = lrV57CollectText(row);
  const attachments = lrV57CollectAttachments(row);
  const buttons = lrV57CollectButtons(row);
  return {
    postId: row?.id || row?.__v51Id || ctx?.virtualId || null,
    source: 'content_plan_v57',
    content: {
      raw: row?.raw || row || null,
      text,
      format: row?.format || 'html',
      markup: [],
      attachments
    },
    buttons,
    channelIds: row?.channel_id ? [Number(row.channel_id)] : [],
    scheduleDate: row?.__v51Date || row?.publish_at || row?.published_at || null,
    signatureEnabled: row?.signature_enabled !== false,
    isAd: lrV57IsAd(row),
    cpm: row?.cpm || null,
    autoDeleteMinutes: row?.auto_delete_minutes || null,
    reportAfterHours: row?.report_after_hours || 24,
    __contentPlanCtx: ctx
  };
}
async function lrV57Send(chatId, text, rows) {
  if (!chatId) return null;
  try {
    if (typeof sendMaxMessage === 'function') {
      const payload = { chatId, text, format: 'html' };
      if (rows && rows.length) payload.attachments = lrV57Keyboard(rows);
      return await sendMaxMessage(payload);
    }
  } catch (e) {
    console.error('[v57 plan preview] sendMaxMessage failed', e?.stack || e?.message || e);
  }
  try { if (typeof msg === 'function') return await msg(chatId, text, rows || [], 'html'); } catch (e) {
    console.error('[v57 plan preview] msg failed', e?.stack || e?.message || e);
  }
  return null;
}
async function lrV57SendPreview(chatId, row, ctx) {
  const draft = lrV57DraftFromRow(row, ctx);
  try {
    if (typeof sendDraftPreview === 'function') {
      const r = await sendDraftPreview(chatId, draft);
      console.log('[v57 plan preview] draft preview sent', JSON.stringify({ chatId, id: row.__v51Id, attachments: draft.content.attachments.length }));
      return r;
    }
  } catch (e) {
    console.error('[v57 plan preview] sendDraftPreview failed', e?.stack || e?.message || e);
  }
  const text = draft.content.text || 'Пост';
  try {
    if (typeof sendMaxMessage === 'function') {
      const payload = { chatId, text, format: 'html' };
      // Если MAX не примет старые media attachments, ошибка уйдёт в fallback ниже.
      if (draft.content.attachments && draft.content.attachments.length) payload.attachments = draft.content.attachments;
      const r = await sendMaxMessage(payload);
      console.log('[v57 plan preview] raw preview sent', JSON.stringify({ chatId, id: row.__v51Id }));
      return r;
    }
  } catch (e) {
    console.error('[v57 plan preview] raw preview failed', e?.message || e);
  }
  return lrV57Send(chatId, lrV57Esc(text), []);
}
function lrV57EditorRows(ctx) {
  return [
    [
      lrV57Btn('✏️ Изменить текст', lrV57ActionPayload('edit_text', ctx)),
      lrV57Btn('🖼️ Медиа', lrV57ActionPayload('edit_media', ctx))
    ],
    [
      lrV57Btn('🔘 Добавить кнопку', lrV57ActionPayload('edit_button', ctx)),
      lrV57Btn('🏷 Автоподпись', lrV57ActionPayload('edit_signature', ctx))
    ],
    [lrV57Btn('💼 Рекламный пост', lrV57ActionPayload('edit_ad', ctx))],
    [lrV57Btn('💾 Сохранить пост', lrV57ActionPayload('save', ctx))],
    [
      lrV57Btn('⬅️ К списку', lrV57ListPayload(ctx)),
      lrV57Btn('❌ Отмена', lrV57ListPayload(ctx))
    ]
  ];
}
function lrV57EditorText(row, channels, ctx) {
  const ch = lrV57ChannelTitle(row, channels, ctx.channelKey);
  const status = row?.__v51Status === 'published' ? 'опубликован' : 'отложен';
  const del = lrV57AutoDelete(row) || 'без удаления';
  const ad = lrV57IsAd(row) ? 'да' : 'нет';
  return '━━━━━━━━━━━━━━\n' +
    '🧬 <b>Редактор LinkRay</b>\n\n' +
    'Пост-превью находится выше.\n' +
    'После изменения текста превью откроется заново уже обновлённым.\n\n' +
    `📣 Канал: ${lrV57Esc(ch)}\n` +
    `📌 Статус: ${lrV57Esc(status)}\n` +
    `🕒 Время: ${lrV57Esc(lrV57HumanDay(row?.__v51Day || ctx.day))} ${lrV57Esc(lrV57Time(row?.__v51Date))}\n` +
    `🗑 Автоудаление: ${lrV57Esc(del)}\n` +
    `💼 Реклама: ${lrV57Esc(ad)}\n\n` +
    'Настройте пост и нажмите «Сохранить пост».\n' +
    '━━━━━━━━━━━━━━';
}
async function lrV57OpenPost(callbackId, chatId, key, virtualId, channelKey, day, filter, page) {
  const ctx = {
    virtualId: lrV57PayloadRead(virtualId || ''),
    channelKey: lrV57PayloadRead(channelKey || 'all') || 'all',
    day: day || lrV57Today(),
    filter: filter || 'all',
    page: Number(page || 0) || 0
  };

  await lrV57SetSession(key, 'content_plan_v57_editor', ctx);

  const channels = await lrV57LoadChannels();
  const posts = await lrV57LoadPosts();
  const row = lrV57FindPost(posts, ctx.virtualId);

  if (!row) {
    await lrV57Send(chatId,
      '━━━━━━━━━━━━━━\n⚠️ <b>Пост не найден</b>\n\nОн мог быть изменён или удалён.\n━━━━━━━━━━━━━━',
      [[lrV57Btn('⬅️ К списку', lrV57ListPayload(ctx))]]
    );
    console.log('[v57 plan preview] open failed row not found', JSON.stringify({ chatId, key, ctx }));
    return true;
  }

  // Важно: сначала сам пост, потом меню. Не редактируем старое сообщение списка,
  // чтобы порядок был как в редакторе публикации: превью сверху, управление снизу.
  await lrV57SendPreview(chatId, row, ctx);
  await lrV57Send(chatId, lrV57EditorText(row, channels, ctx), lrV57EditorRows(ctx));
  console.log('[v57 plan preview] editor sent below preview', JSON.stringify({ chatId, key, id: row.__v51Id }));
  return true;
}
async function lrV57UpdateText(target, text) {
  if (!target || !Number.isFinite(target.id)) throw new Error('post target not found');
  if (target.table === 'scheduled_posts') {
    const r = await query(
      `UPDATE scheduled_posts
          SET text=$1,
              draft = CASE
                WHEN draft IS NULL THEN draft
                ELSE jsonb_set(
                       jsonb_set(COALESCE(draft, '{}'::jsonb), '{text}', to_jsonb($1::text), true),
                       '{content}', COALESCE(draft->'content','{}'::jsonb) || jsonb_build_object('text',$1::text), true
                     )
              END,
              updated_at=now()
        WHERE id=$2
        RETURNING id`,
      [text, target.id]
    );
    if (!lrV57Rows(r)[0]) throw new Error('post row not found after update');
    return true;
  }
  if (target.table === 'ad_post_trackers') {
    const r = await query(`UPDATE ad_post_trackers SET post_text=$1, updated_at=now() WHERE id=$2 RETURNING id`, [text, target.id]);
    if (!lrV57Rows(r)[0]) throw new Error('post row not found after update');
    return true;
  }
  if (target.table === 'ad_post_tracker_channels') {
    const r = await query(`UPDATE ad_post_tracker_channels SET post_text=$1, updated_at=now() WHERE id=$2 RETURNING id`, [text, target.id]);
    if (!lrV57Rows(r)[0]) throw new Error('post row not found after update');
    return true;
  }
  if (target.table === 'lr_post_entry_v68') {
    const r = await query(`UPDATE lr_post_entry_v68 SET text=$1 WHERE id=$2 RETURNING id`, [text, target.id]);
    if (!lrV57Rows(r)[0]) throw new Error('post row not found after update');
    return true;
  }
  throw new Error('unsupported post table: ' + target.table);
}
async function lrV57HandleTextInput(update, chatId, key, session) {
  const state = String(session?.state || '');
  if (!['content_plan_v57_wait_text', 'content_plan_v56_wait_text', 'content_plan_v53_wait_text'].includes(state)) return false;
  const text = lrV57Text(update);
  if (!text || text.startsWith('/')) return false;
  const data = lrV57Json(session?.data, {});
  const ctx = {
    virtualId: data.virtualId || '',
    channelKey: data.channelKey || 'all',
    day: data.day || lrV57Today(),
    filter: data.filter || 'all',
    page: Number(data.page || 0) || 0
  };
  const target = lrV57PostTargetFromVirtual(ctx.virtualId);
  console.log('[v57 plan preview] text input', JSON.stringify({ chatId, key, state, ctx, target }));
  await lrV57UpdateText(target, text);
  await lrV57ClearSession(key);

  await lrV57Send(chatId, '✅ <b>Текст поста сохранён</b>\n\nРедактор ниже откроется с обновлённым превью.', []);
  await lrV57OpenPost(null, chatId, key, ctx.virtualId, ctx.channelKey, ctx.day, ctx.filter, ctx.page);
  return true;
}
async function lrV57Webhook(req, res, next) {
  try {
    const update = req.body || {};
    const type = lrV57Type(update);
    const payload = lrV57Payload(update);
    const chatId = lrV57ChatId(update);
    const key = lrV57Key(update, chatId);

    if (String(type) === 'message_created' && key) {
      const session = await lrV57GetSession(key).catch(() => null);
      if (session && await lrV57HandleTextInput(update, chatId, key, session)) {
        if (res && !res.headersSent) return res.json({ ok: true, handled: 'lr_v57_text_input' });
        return;
      }
    }

    if (!payload || !payload.startsWith('lr_plan_v51:')) return next();

    if (payload.startsWith('lr_plan_v51:open:')) {
      const ctx = lrV57ParseCtxFromPayload(payload);
      await lrV57OpenPost(null, chatId, key, ctx.virtualId, ctx.channelKey, ctx.day, ctx.filter, ctx.page);
      if (res && !res.headersSent) return res.json({ ok: true, handled: 'lr_v57_open' });
      return;
    }

    if (payload.startsWith('lr_plan_v51:edit_text:')) {
      const ctx = lrV57ParseCtxFromPayload(payload);
      await lrV57SetSession(key, 'content_plan_v57_wait_text', ctx);
      await lrV57Send(chatId,
        '━━━━━━━━━━━━━━\n✏️ <b>Изменить текст</b>\n\nОтправьте новый текст поста следующим сообщением.\nПосле отправки текст сохранится, а пост-превью и редактор откроются снова.\n━━━━━━━━━━━━━━',
        [[lrV57Btn('⬅️ К редактору', lrV57OpenPayload(ctx))]]
      );
      console.log('[v57 plan preview] wait text', JSON.stringify({ chatId, key, ctx }));
      if (res && !res.headersSent) return res.json({ ok: true, handled: 'lr_v57_wait_text' });
      return;
    }

    if (payload.startsWith('lr_plan_v51:save:')) {
      const ctx = lrV57ParseCtxFromPayload(payload);
      await lrV57ClearSession(key);
      await lrV57Send(chatId,
        '━━━━━━━━━━━━━━\n✅ <b>Пост сохранён</b>\n\nИзменения сохранены в контент-плане.\n━━━━━━━━━━━━━━',
        [[lrV57Btn('⬅️ К редактору', lrV57OpenPayload(ctx))], [lrV57Btn('⬅️ К списку', lrV57ListPayload(ctx))]]
      );
      console.log('[v57 plan preview] save', JSON.stringify({ chatId, key, ctx }));
      if (res && !res.headersSent) return res.json({ ok: true, handled: 'lr_v57_save' });
      return;
    }

    return next();
  } catch (e) {
    console.error('[v57 plan preview] webhook failed', e?.stack || e?.message || e);
    try {
      const update = req.body || {};
      const chatId = lrV57ChatId(update);
      await lrV57Send(chatId, '❌ Ошибка редактора контент-плана. Скиньте логи v57 plan preview.', []);
    } catch (_) {}
    if (res && !res.headersSent) return res.json({ ok: true, handled: 'lr_v57_error' });
    return;
  }
}
try {
  // Оборачиваем старый lrV51OpenPost: любые старые кнопки/вызовы тоже будут открывать превью сверху и меню снизу.
  if (typeof lrV51OpenPost === 'function' && !lrV51OpenPost.__lrV57Wrapped) {
    const __lrV57OldOpenPost = lrV51OpenPost;
    lrV51OpenPost = async function lrV57WrappedOpenPost(callbackId, chatId, key, virtualId, channelKey, day, filter, page) {
      return lrV57OpenPost(callbackId, chatId, key, virtualId, channelKey, day, filter, page);
    };
    lrV51OpenPost.__lrV57Wrapped = true;
    lrV51OpenPost.__lrV57OldOpenPost = __lrV57OldOpenPost;
  }
  if (typeof app !== 'undefined' && app && typeof app.use === 'function') {
    app.use('/webhook', lrV57Webhook);
  }
  console.log('[v57 plan preview] installed: post preview above editor menu');
} catch (e) {
  console.error('[v57 plan preview] install failed', e?.stack || e?.message || e);
}
/* LR_PLAN_POST_PREVIEW_EDITOR_V57_END */


/* LR_V61_FORWARD_MAIN_AND_DAY_LABELS_START */
/*
  v61:
  1) Перехватывает пересланный пост в главном меню ДО старого fallback "Команда не найдена".
     В режиме Добавить канал не вмешивается — там работает добавление канала.
  2) Подменяет центральную кнопку даты в контент-плане:
     Сегодня / Завтра / Послезавтра / 15 июля.
*/
function lrV61Json(u) {
  try { return JSON.stringify(u || {}); } catch (_) { return ''; }
}
function lrV61Type(update) {
  try {
    return String(
      update?.update_type || update?.type || update?.event_type ||
      update?.event?.type || update?.payload?.type || ''
    );
  } catch (_) { return ''; }
}
function lrV61ChatId(update) {
  try { if (typeof getChatId === 'function') return String(getChatId(update) || ''); } catch (_) {}
  try {
    return String(
      update?.chat_id || update?.chatId || update?.chat?.id ||
      update?.recipient?.chat_id || update?.recipient?.chatId ||
      update?.message?.chat_id || update?.message?.chatId || update?.message?.recipient?.chat_id ||
      update?.payload?.chat_id || update?.payload?.chatId || update?.payload?.chat?.id || ''
    );
  } catch (_) { return ''; }
}
function lrV61Key(update) {
  try { if (typeof getSessionKey === 'function') return String(getSessionKey(update) || ''); } catch (_) {}
  return lrV61ChatId(update);
}
function lrV61Payload(update) {
  try { if (typeof getCallbackPayload === 'function') return getCallbackPayload(update); } catch (_) {}
  try {
    return update?.callback?.payload || update?.callback_payload || update?.payload?.callback?.payload || update?.payload?.payload || '';
  } catch (_) { return ''; }
}
function lrV61Message(update) {
  try {
    return update?.message || update?.payload?.message || update?.data?.message || update?.body?.message || update?.message_created || update?.payload || update || {};
  } catch (_) { return {}; }
}
function lrV61Text(update) {
  try {
    var m = lrV61Message(update);
    return String(
      m?.content?.text || m?.text || m?.body?.text ||
      update?.content?.text || update?.text || update?.payload?.text || ''
    );
  } catch (_) { return ''; }
}
async function lrV61Session(key) {
  try { if (typeof getSession === 'function') return await getSession(key); } catch (_) {}
  try {
    if (typeof query === 'function' && key) {
      var r = await query('SELECT state,data FROM bot_sessions WHERE user_id::text=$1 ORDER BY updated_at DESC LIMIT 1', [String(key)]);
      var row = (r && r.rows && r.rows[0]) || null;
      return row ? { state: row.state, data: row.data || {} } : null;
    }
  } catch (_) {}
  return null;
}
async function lrV61IsAddMode(update, key) {
  try {
    var ses = await lrV61Session(key);
    if (ses && String(ses.state || '') === 'wait_add_channel') return true;
  } catch (_) {}
  try {
    if (typeof lrV31GetAddMode === 'function') {
      var mode = await lrV31GetAddMode(lrV61ChatId(update), key);
      if (mode) return true;
    }
  } catch (_) {}
  try {
    if (typeof query === 'function' && key) {
      var r = await query(
        "SELECT 1 FROM lr_bot_state WHERE key IN ($1,$2,$3) OR key LIKE $4 LIMIT 1",
        [
          'lr_v31_add_wait:' + String(key),
          'lr_v31_add_wait_global',
          'lr_v31_add_wait:' + lrV61ChatId(update),
          '%add_wait%' + String(key) + '%'
        ]
      );
      if (r && r.rows && r.rows.length) return true;
    }
  } catch (_) {}
  return false;
}
function lrV61LooksForwardedPost(update) {
  try { if (typeof lrV15LooksForwardedPost === 'function' && lrV15LooksForwardedPost(update)) return true; } catch (_) {}
  var raw = lrV61Json(update).toLowerCase();
  if (!raw) return false;
  if (/forward|forwarded|linked_message|linkedmessage|original_message|source_message|\"link\"\s*:/.test(raw)) return true;
  try {
    var m = lrV61Message(update);
    var atts = m?.content?.attachments || m?.attachments || update?.attachments || [];
    if (Array.isArray(atts) && atts.length) return true;
  } catch (_) {}
  return false;
}
async function lrV61DraftFromForward(update) {
  var d = null;
  try { if (typeof emptyDraft === 'function') d = emptyDraft(); } catch (_) {}
  if (!d || typeof d !== 'object') {
    d = {
      cpm: null,
      isAd: false,
      buttons: [],
      content: { raw: null, text: '', format: 'html', markup: [], attachments: [] },
      campaignId: 'lr-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      channelIds: [],
      scheduleDate: null,
      previewMessageId: null,
      reportAfterHours: 24,
      signatureEnabled: true,
      autoDeleteMinutes: null
    };
  }
  var content = null;
  try { if (typeof lrSafeHydrateContent === 'function') content = await lrSafeHydrateContent(update); } catch (e) {
    console.error('[v61 forward] hydrate failed', e?.stack || e?.message || e);
  }
  if (!content || typeof content !== 'object') {
    var m = lrV61Message(update);
    var text = lrV61Text(update);
    content = {
      raw: m || update || null,
      text: text || '',
      format: 'html',
      markup: [],
      attachments: Array.isArray(m?.content?.attachments) ? m.content.attachments : (Array.isArray(m?.attachments) ? m.attachments : [])
    };
  }
  d.content = Object.assign({}, d.content || {}, content || {});
  if (!Array.isArray(d.buttons)) d.buttons = [];
  if (!Array.isArray(d.channelIds)) d.channelIds = [];
  return d;
}
function lrV61ChannelTitle(ch) {
  try { if (typeof channelName === 'function') return channelName(ch); } catch (_) {}
  return String(ch?.title || ch?.name || ch?.channel_title || ('Канал ' + (ch?.id || ''))).slice(0, 40);
}
async function lrV61OpenChannelSelect(chatId, key, draft) {
  if (typeof lrV15SendChannelSelect === 'function') {
    return lrV15SendChannelSelect(chatId, key, draft, false);
  }
  var channels = [];
  try { if (typeof getChannels === 'function') channels = await getChannels(); } catch (e) {
    console.error('[v61 forward] getChannels failed', e?.stack || e?.message || e);
  }
  if (!channels.length) {
    if (typeof setSession === 'function') await setSession(key, 'select_channels', { draft });
    if (typeof msg === 'function') return msg(chatId, '━━━━━━━━━━━━\n🔗 <b>Подключить канал</b>\n\nСначала добавьте канал в LinkRay.\n━━━━━━━━━━━━', [[callbackButton('🔗 Добавить канал', 'post:add_channel')], [callbackButton('⬅️ В меню', 'main:menu')]], 'html');
    return;
  }
  var rows = [];
  for (var i = 0; i < channels.length && i < 30; i++) {
    var ch = channels[i];
    rows.push([callbackButton('📡 ' + lrV61ChannelTitle(ch), 'post:single:' + ch.id)]);
  }
  rows.push([callbackButton('🧩 Выбрать несколько', 'post:multi'), callbackButton('🌐 Все каналы', 'post:all_channels')]);
  rows.push([callbackButton('🔗 Добавить канал', 'post:add_channel')]);
  rows.push([callbackButton('⬅️ Назад', 'main:posting'), callbackButton('❌ Отмена', 'post:cancel')]);
  if (typeof setSession === 'function') await setSession(key, 'select_channels', { draft });
  if (typeof msg === 'function') {
    return msg(chatId, '━━━━━━━━━━━━\n📡 <b>Куда выпустить пост?</b>\n\nПост принят.\nВыберите канал.\n━━━━━━━━━━━━', rows, 'html');
  }
}
async function lrV61HandleForwardFromMain(update) {
  var type = lrV61Type(update);
  if (type && type !== 'message_created' && type !== 'message_created_callback') return false;
  var payload = lrV61Payload(update);
  if (payload && typeof payload === 'string' && payload !== '[object Object]') return false;
  var key = lrV61Key(update);
  var chatId = lrV61ChatId(update);
  if (!chatId || !key) return false;
  if (await lrV61IsAddMode(update, key)) return false;
  var text = String(lrV61Text(update) || '').trim();
  if (text.startsWith('/')) return false;
  if (!lrV61LooksForwardedPost(update)) return false;
  var draft = await lrV61DraftFromForward(update);
  await lrV61OpenChannelSelect(chatId, key, draft);
  console.log('[v61 forward] main forward accepted', JSON.stringify({ chatId, key, hasText: Boolean(draft?.content?.text), attachments: Array.isArray(draft?.content?.attachments) ? draft.content.attachments.length : 0 }));
  return true;
}
function lrV61MskDateOnly(d) {
  var x = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}
function lrV61DayLabel(dateObj) {
  try {
    var months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    var today = lrV61MskDateOnly(new Date());
    var target = lrV61MskDateOnly(dateObj);
    var diff = Math.round((target - today) / 86400000);
    if (diff === 0) return 'Сегодня';
    if (diff === 1) return 'Завтра';
    if (diff === 2) return 'Послезавтра';
    var x = new Date(target);
    return x.getUTCDate() + ' ' + months[x.getUTCMonth()];
  } catch (_) { return 'Сегодня'; }
}
function lrV61ParseRuDate(text) {
  try {
    var months = { 'января':0, 'февраля':1, 'марта':2, 'апреля':3, 'мая':4, 'июня':5, 'июля':6, 'августа':7, 'сентября':8, 'октября':9, 'ноября':10, 'декабря':11 };
    var m = String(text || '').toLowerCase().match(/(?:пн|вт|ср|чт|пт|сб|вс)?\s*,?\s*(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(20\d{2})/i);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[3]), months[m[2]], Number(m[1]), 0, 0, 0));
  } catch (_) { return null; }
}
function lrV61ButtonText(btn) {
  if (!btn || typeof btn !== 'object') return '';
  return String(btn.text ?? btn.title ?? btn.label ?? btn.caption ?? btn.name ?? '');
}
function lrV61SetButtonText(btn, text) {
  if (!btn || typeof btn !== 'object') return btn;
  if ('text' in btn) btn.text = text;
  else if ('title' in btn) btn.title = text;
  else if ('label' in btn) btn.label = text;
  else if ('caption' in btn) btn.caption = text;
  else if ('name' in btn) btn.name = text;
  return btn;
}
function lrV61PatchRowsDayLabel(rows, messageText) {
  try {
    if (!Array.isArray(rows)) return rows;
    var src = String(messageText || '');
    if (!/(Контент\-план|Все каналы|Всего за день|отложено|опубликовано|Постов нет)/i.test(src)) return rows;
    var d = lrV61ParseRuDate(src);
    if (!d) return rows;
    var label = lrV61DayLabel(d);
    function walk(x) {
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === 'object') {
        var t = lrV61ButtonText(x).trim();
        if (t === 'Сегодня' || t === 'Завтра' || t === 'Послезавтра' || /^\d{1,2}\s+[а-яё]+$/i.test(t)) return lrV61SetButtonText(x, label);
      }
      return x;
    }
    return walk(rows);
  } catch (e) {
    console.error('[v61 labels] failed', e?.message || e);
    return rows;
  }
}
try {
  if (typeof msg === 'function' && !msg.__lrV61Wrapped) {
    var lrV61OldMsg = msg;
    msg = async function lrV61MsgWrapped(chatId, text, rows, format) {
      return lrV61OldMsg.call(this, chatId, text, lrV61PatchRowsDayLabel(rows, text), format);
    };
    msg.__lrV61Wrapped = true;
    console.log('[v61 labels] msg wrapped');
  }
} catch (e) { console.error('[v61 labels] msg wrap failed', e?.message || e); }
try {
  if (typeof cb === 'function' && !cb.__lrV61Wrapped) {
    var lrV61OldCb = cb;
    cb = async function lrV61CbWrapped(callbackId, text, rows, format) {
      return lrV61OldCb.call(this, callbackId, text, lrV61PatchRowsDayLabel(rows, text), format);
    };
    cb.__lrV61Wrapped = true;
    console.log('[v61 labels] cb wrapped');
  }
} catch (e) { console.error('[v61 labels] cb wrap failed', e?.message || e); }

app.use(async function lrV61ForwardMainBeforeFallback(req, res, next) {
  try {
    if (req.method !== 'POST' || !String(req.path || req.url || '').includes('/webhook')) return next();
    if (await lrV61HandleForwardFromMain(req.body || {})) return res.json({ ok: true, handled: 'lr_v61_forward_main' });
  } catch (e) {
    console.error('[v61 forward] middleware failed', e?.stack || e?.message || e);
  }
  return next();
});
console.log('[v61 forward] installed: main forward before command fallback + day labels');
/* LR_V61_FORWARD_MAIN_AND_DAY_LABELS_END */

/* LR_CONTENT_PLAN_MEDIA_EDIT_V62_START
   Фикс редактора постов из контент-плана:
   - перехватывает ожидание нового текста/медиа до старого v53-обработчика;
   - исправляет ошибку сохранения медиа в уже опубликованном посте;
   - обновляет строку scheduled_posts;
   - если у опубликованного поста есть message_id, сразу редактирует сообщение в MAX через PUT /messages.
*/
function lrV62Rows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}
function lrV62Clean(value, max = 4000) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}
function lrV62Esc(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
  } catch (_) {}
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function lrV62Btn(text, payload) {
  try {
    if (typeof callbackButton === 'function') return callbackButton(text, payload);
  } catch (_) {}
  return { type: 'callback', text, payload };
}
function lrV62Type(update) {
  try {
    if (typeof getUpdateType === 'function') return String(getUpdateType(update) || '');
  } catch (_) {}
  return String(update?.update_type || update?.type || update?.event_type || '');
}
function lrV62ChatId(update) {
  try {
    if (typeof getChatId === 'function') {
      const v = getChatId(update);
      if (v !== undefined && v !== null && String(v)) return String(v);
    }
  } catch (_) {}
  const paths = [
    update?.message?.recipient?.chat_id,
    update?.message?.recipient?.chatId,
    update?.message?.chat_id,
    update?.message?.chatId,
    update?.message?.body?.dialog_chat_id,
    update?.message?.body?.dialogChatId,
    update?.chat_id,
    update?.chatId,
    update?.dialog_chat_id,
    update?.dialogChatId,
    update?.recipient?.chat_id,
    update?.callback?.chat_id,
  ];
  for (const v of paths) {
    if (v !== undefined && v !== null && String(v)) return String(v);
  }
  return '';
}
function lrV62SessionKey(update, chatId) {
  try {
    if (typeof getSessionKey === 'function') {
      const v = getSessionKey(update);
      if (v !== undefined && v !== null && String(v)) return String(v);
    }
  } catch (_) {}
  return String(chatId || '');
}
function lrV62Payload(update) {
  try {
    if (typeof getCallbackPayload === 'function') return String(getCallbackPayload(update) || '');
  } catch (_) {}
  return String(
    update?.callback?.payload ||
    update?.payload ||
    update?.message?.payload ||
    update?.message?.body?.payload ||
    ''
  );
}
function lrV62CallbackId(update) {
  try {
    if (typeof getCallbackId === 'function') return getCallbackId(update);
  } catch (_) {}
  return update?.callback?.id || update?.callback_id || update?.message?.callback_id || null;
}
function lrV62Text(update) {
  const paths = [
    update?.message?.body?.text,
    update?.message?.content?.text,
    update?.message?.text,
    update?.body?.text,
    update?.content?.text,
    update?.text,
  ];
  for (const v of paths) {
    const t = lrV62Clean(v, 4000);
    if (t) return t;
  }
  return '';
}
function lrV62Attachments(update) {
  const paths = [
    update?.message?.body?.attachments,
    update?.message?.content?.attachments,
    update?.message?.attachments,
    update?.body?.attachments,
    update?.content?.attachments,
    update?.attachments,
  ];
  for (const v of paths) {
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}
function lrV62SessionIds(chatId, key) {
  const out = [];
  for (const v of [key, chatId, `user:${key}`, `user:${chatId}`]) {
    const t = String(v || '').trim();
    if (!t) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
async function lrV62GetSession(chatId, key) {
  const ids = lrV62SessionIds(chatId, key);
  if (!ids.length || typeof query !== 'function') return null;
  const params = [];
  const placeholders = ids.map((x) => {
    params.push(x);
    return `$${params.length}`;
  }).join(',');
  const sql = `
    SELECT user_id::text AS user_id, state, data, updated_at
    FROM bot_sessions
    WHERE user_id::text IN (${placeholders})
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  const rows = lrV62Rows(await query(sql, params));
  return rows[0] || null;
}
async function lrV62SetSession(userId, state, data) {
  const id = String(userId || '').replace(/^user:/, '');
  if (!id || typeof query !== 'function') return;
  await query(
    `INSERT INTO bot_sessions(user_id,state,data,updated_at)
     VALUES($1,$2,$3::jsonb,now())
     ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,data=EXCLUDED.data,updated_at=now()`,
    [id, state, JSON.stringify(data || {})]
  );
}
async function lrV62ClearSession(userId) {
  const id = String(userId || '').replace(/^user:/, '');
  if (!id || typeof query !== 'function') return;
  try {
    if (typeof clearSession === 'function') {
      await clearSession(id);
      return;
    }
  } catch (_) {}
  await query(`UPDATE bot_sessions SET state='idle', data='{}'::jsonb, updated_at=now() WHERE user_id::text=$1`, [id]);
}
function lrV62ParseVirtualId(value) {
  let raw = String(value || '').trim();
  try { raw = decodeURIComponent(raw); } catch (_) {}
  const m = raw.match(/^(scheduled_posts):(\d+)$/i) || raw.match(/(scheduled_posts)%3A(\d+)/i);
  if (!m) return null;
  return { table: 'scheduled_posts', id: Number(m[2]) };
}
function lrV62MessageId(row) {
  return lrV62Clean(
    row?.published_message_id ||
    row?.max_message_id ||
    row?.message_id ||
    row?.report_message_id ||
    '',
    200
  );
}
function lrV62Token() {
  for (const k of ['MAX_TOKEN','MAX_BOT_TOKEN','MAX_ACCESS_TOKEN','BOT_TOKEN','ACCESS_TOKEN','API_TOKEN','TOKEN']) {
    if (process.env[k]) return String(process.env[k]);
  }
  try { if (typeof MAX_TOKEN !== 'undefined' && MAX_TOKEN) return String(MAX_TOKEN); } catch (_) {}
  try { if (typeof BOT_TOKEN !== 'undefined' && BOT_TOKEN) return String(BOT_TOKEN); } catch (_) {}
  try { if (typeof TOKEN !== 'undefined' && TOKEN) return String(TOKEN); } catch (_) {}
  return '';
}
function lrV62Base() {
  return String(
    process.env.MAX_API_BASE ||
    process.env.MAX_BASE_URL ||
    process.env.MAX_PLATFORM_API ||
    'https://platform-api2.max.ru'
  ).replace(/\/+$/, '');
}
async function lrV62ApiPutMessage(messageId, body) {
  const token = lrV62Token();
  if (!token || !messageId) return { ok: false, status: 0, text: 'no token or message id' };
  const response = await fetch(`${lrV62Base()}/messages?message_id=${encodeURIComponent(messageId)}`, {
    method: 'PUT',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  const ok = response.ok && (!json || json.success !== false);
  if (!ok) console.error('[v62 plan media] MAX edit failed', JSON.stringify({ status: response.status, preview: text.slice(0, 500) }));
  else console.log('[v62 plan media] MAX edit ok', JSON.stringify({ messageId, status: response.status }));
  return { ok, status: response.status, text, json };
}
async function lrV62Send(chatId, text, rows, format = 'html') {
  if (!chatId) return;
  if (typeof msg === 'function') return msg(chatId, text, rows || [], format);
  if (typeof sendMaxMessage === 'function') {
    return sendMaxMessage({ chatId, text, attachments: rows && rows.length ? inlineKeyboard(rows) : [], format });
  }
}
async function lrV62SendPreview(chatId, row) {
  const text = lrV62Clean(row?.text || row?.post_text || 'Превью поста', 4000);
  const atts = Array.isArray(row?.attachments) ? row.attachments : [];
  try {
    if (typeof sendMaxMessage === 'function') {
      await sendMaxMessage({
        chatId,
        text,
        format: row?.format || 'html',
        attachments: atts,
        notify: false,
      });
      return;
    }
  } catch (e) {
    console.error('[v62 plan media] preview sendMaxMessage failed', e?.message || e);
  }
  await lrV62Send(chatId, text || 'Превью поста обновлено.', [], row?.format || 'html');
}
async function lrV62GetPost(target) {
  const rows = lrV62Rows(await query(`SELECT * FROM scheduled_posts WHERE id=$1`, [target.id]));
  return rows[0] || null;
}
async function lrV62UpdatePostText(target, text) {
  const rows = lrV62Rows(await query(
    `UPDATE scheduled_posts
     SET text=$1,
         draft=COALESCE(draft,'{}'::jsonb) || jsonb_build_object('text',$1::text),
         updated_at=now()
     WHERE id=$2
     RETURNING *`,
    [text, target.id]
  ));
  return rows[0] || null;
}
async function lrV62UpdatePostMedia(target, attachments) {
  const rows = lrV62Rows(await query(
    `UPDATE scheduled_posts
     SET attachments=$1::jsonb,
         draft=COALESCE(draft,'{}'::jsonb) || jsonb_build_object('attachments',$1::jsonb),
         updated_at=now()
     WHERE id=$2
     RETURNING *`,
    [JSON.stringify(attachments || []), target.id]
  ));
  return rows[0] || null;
}
function lrV62EditorRows(virtualId) {
  const enc = encodeURIComponent(String(virtualId || ''));
  return [
    [lrV62Btn('✏️ Изменить текст', `lr_v62:edit_text:${enc}`), lrV62Btn('🖼 Медиа', `lr_v62:edit_media:${enc}`)],
    [lrV62Btn('🔘 Добавить кнопку', `lr_v62:edit_button:${enc}`), lrV62Btn('🏷 Автоподпись', `lr_v62:signature:${enc}`)],
    [lrV62Btn('💼 Рекламный пост', `lr_v62:ad:${enc}`)],
    [lrV62Btn('💾 Сохранить пост', `lr_v62:save:${enc}`)],
    [lrV62Btn('⬅️ К списку', 'post:all'), lrV62Btn('❌ Отмена', 'post:cancel')],
  ];
}
async function lrV62ShowEditor(chatId, key, data, row, note = '') {
  const virtualId = data?.virtualId || `scheduled_posts:${row?.id}`;
  await lrV62SendPreview(chatId, row);
  const title = note ? `\n\n${lrV62Esc(note)}` : '';
  await lrV62Send(
    chatId,
    `━━━━━━━━━━━━━━\n🧬 <b>Редактор LinkRay</b>${title}\n\nПост-превью находится выше.\nИзменения сохраняются в контент-план и, если пост уже опубликован, применяются в канале.\n━━━━━━━━━━━━━━`,
    lrV62EditorRows(virtualId),
    'html'
  );
}
async function lrV62EditPublishedIfNeeded(row, mode, value) {
  const messageId = lrV62MessageId(row);
  if (!messageId) {
    console.log('[v62 plan media] no published message id, db only', JSON.stringify({ id: row?.id, mode }));
    return { ok: true, skipped: true };
  }
  const body = {
    text: lrV62Clean(row?.text || row?.post_text || '', 4000),
    format: row?.format || 'html',
    notify: false,
  };
  if (mode === 'media') body.attachments = Array.isArray(value) ? value : [];
  if (mode === 'text') body.text = String(value || '');
  return lrV62ApiPutMessage(messageId, body);
}

/* LR_RESTORE_FULL_EDITOR_AFTER_MEDIA_V63_START
   Возвращает полный набор кнопок после сохранения медиа в редакторе контент-плана.
   Дополнительно даёт действия для: добавить кнопку, автоподпись, рекламный пост.
*/
function lrV63ParseInlineButton(text) {
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const title = lines[0].slice(0, 80);
  const url = lines.find(x => /^https?:\/\//i.test(x));
  if (!title || !url) return null;
  return { text: title, url };
}
function lrV63InlineRows(buttons) {
  const list = Array.isArray(buttons) ? buttons : [];
  return list
    .filter(b => b && (b.text || b.title) && (b.url || b.link))
    .map(b => [lrV62Btn(String(b.text || b.title).slice(0, 80), String(b.url || b.link))]);
}
async function lrV63ColumnSet(table) {
  try {
    const rows = lrV62Rows(await query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [table]
    ));
    return new Set(rows.map(r => String(r.column_name)));
  } catch (e) {
    console.error('[v63 full editor] column lookup failed', e?.message || e);
    return new Set();
  }
}
async function lrV63UpdateButtons(target, button) {
  const cols = await lrV63ColumnSet('scheduled_posts');
  if (!cols.has('buttons')) return null;
  const current = lrV62Rows(await query(`SELECT buttons FROM scheduled_posts WHERE id=$1`, [target.id]))[0] || {};
  let buttons = [];
  try { buttons = Array.isArray(current.buttons) ? current.buttons : JSON.parse(current.buttons || '[]'); } catch (_) { buttons = []; }
  buttons = [button];
  const sets = [`buttons=$1::jsonb`];
  if (cols.has('draft')) sets.push(`draft=COALESCE(draft,'{}'::jsonb) || jsonb_build_object('buttons',$1::jsonb)`);
  if (cols.has('updated_at')) sets.push(`updated_at=now()`);
  const rows = lrV62Rows(await query(
    `UPDATE scheduled_posts SET ${sets.join(', ')} WHERE id=$2 RETURNING *`,
    [JSON.stringify(buttons), target.id]
  ));
  return rows[0] || null;
}
async function lrV63TogglePostFlag(target, candidates) {
  const cols = await lrV63ColumnSet('scheduled_posts');
  const col = candidates.find(c => cols.has(c));
  if (!col) return null;
  const sets = [`${col}=NOT COALESCE(${col}, false)`];
  if (cols.has('updated_at')) sets.push(`updated_at=now()`);
  const rows = lrV62Rows(await query(`UPDATE scheduled_posts SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, [target.id]));
  return rows[0] || null;
}
async function lrV63EditPublishedButtonsIfNeeded(row) {
  const messageId = lrV62MessageId(row);
  if (!messageId) return { ok: true, skipped: true };
  let buttons = [];
  try { buttons = Array.isArray(row.buttons) ? row.buttons : JSON.parse(row.buttons || '[]'); } catch (_) { buttons = []; }
  const body = {
    text: lrV62Clean(row?.text || row?.post_text || '', 4000),
    format: row?.format || 'html',
    notify: false,
  };
  const keyboardRows = lrV63InlineRows(buttons);
  if (keyboardRows.length) {
    try {
      if (typeof inlineKeyboard === 'function') body.attachments = inlineKeyboard(keyboardRows);
    } catch (_) {}
  }
  return lrV62ApiPutMessage(messageId, body);
}
/* LR_RESTORE_FULL_EDITOR_AFTER_MEDIA_V63_END */

async function lrV62HandleWaitInput(update, chatId, key, session) {
  const state = String(session?.state || '');
  if (!/^content_plan_v\d+_wait_(text|media|button)$/.test(state) && !/^lr_plan_v\d+_wait_(text|media|button)$/.test(state)) return false;

  const data = session?.data || {};
  const target = lrV62ParseVirtualId(data.virtualId || data.postId || data.id);
  if (!target) {
    await lrV62Send(chatId, '❌ <b>Не удалось определить пост</b>\n\nВернитесь в список и откройте пост заново.', [[lrV62Btn('⬅️ К списку', 'post:all')]], 'html');
    await lrV62ClearSession(key || chatId).catch(()=>{});
    return true;
  }

  const isText = /_wait_text$/.test(state);
  const isMedia = /_wait_media$/.test(state);
  const isButton = /_wait_button$/.test(state);

  if (isText) {
    const text = lrV62Text(update);
    if (!text) return false;
    const row = await lrV62UpdatePostText(target, text);
    if (!row) {
      await lrV62Send(chatId, '❌ <b>Ошибка при сохранении текста</b>\n\npost row not found after update', [[lrV62Btn('⬅️ К списку', 'post:all')]], 'html');
      return true;
    }
    const api = await lrV62EditPublishedIfNeeded(row, 'text', text).catch(e => ({ ok:false, text:e?.message || String(e) }));
    await lrV62ClearSession(key || chatId).catch(()=>{});
    await lrV62ShowEditor(chatId, key, data, row, api.ok ? '✅ Текст поста сохранён.' : `⚠️ Текст сохранён в базе, но MAX не обновил сообщение: ${api.text || 'ошибка API'}`);
    return true;
  }


  if (isButton) {
    const text = lrV62Text(update);
    const button = lrV63ParseInlineButton(text);
    if (!button) {
      await lrV62Send(chatId, '⚠️ <b>Кнопка не распознана</b>\n\nОтправьте двумя строками:\n\nНазвание кнопки\nhttps://site.ru', [[lrV62Btn('⬅️ К редактору', `lr_v62:editor:${encodeURIComponent(data.virtualId || '')}`)]], 'html');
      return true;
    }
    const row = await lrV63UpdateButtons(target, button);
    if (!row) {
      await lrV62Send(chatId, '❌ <b>Ошибка при сохранении кнопки</b>\n\nВ таблице постов не найдено поле buttons.', [[lrV62Btn('⬅️ К списку', 'post:all')]], 'html');
      return true;
    }
    const api = await lrV63EditPublishedButtonsIfNeeded(row).catch(e => ({ ok:false, text:e?.message || String(e) }));
    await lrV62ClearSession(key || chatId).catch(()=>{});
    await lrV62ShowEditor(chatId, key, data, row, api.ok ? '✅ Кнопка поста сохранена.' : `⚠️ Кнопка сохранена в базе, но MAX не обновил сообщение: ${api.text || 'ошибка API'}`);
    return true;
  }

  if (isMedia) {
    const attachments = lrV62Attachments(update);
    if (!attachments.length) {
      await lrV62Send(chatId, '❌ <b>Медиа не найдено</b>\n\nОтправьте фото, видео, файл или пересланный пост с медиа.', [[lrV62Btn('⬅️ К редактору', `lr_v62:editor:${encodeURIComponent(data.virtualId || '')}`)]], 'html');
      return true;
    }
    const row = await lrV62UpdatePostMedia(target, attachments);
    if (!row) {
      await lrV62Send(chatId, '❌ <b>Ошибка при сохранении медиа</b>\n\npost row not found after update', [[lrV62Btn('⬅️ К списку', 'post:all')]], 'html');
      return true;
    }
    const api = await lrV62EditPublishedIfNeeded(row, 'media', attachments).catch(e => ({ ok:false, text:e?.message || String(e) }));
    await lrV62ClearSession(key || chatId).catch(()=>{});
    await lrV62ShowEditor(chatId, key, data, row, api.ok ? '✅ Медиа поста сохранено.' : `⚠️ Медиа сохранено в базе, но MAX не обновил сообщение: ${api.text || 'ошибка API'}`);
    return true;
  }

  return false;
}
async function lrV62HandleCallback(update, chatId, key, payload) {
  if (!payload.startsWith('lr_v62:')) return false;
  const callbackId = lrV62CallbackId(update);
  try {
    if (callbackId && typeof cb === 'function') await cb(callbackId, '⏳ Открываю...', []);
  } catch (_) {}

  const parts = payload.split(':');
  const action = parts[1] || '';
  const virtualId = (() => { try { return decodeURIComponent(parts.slice(2).join(':')); } catch (_) { return parts.slice(2).join(':'); } })();
  const target = lrV62ParseVirtualId(virtualId);
  if (!target) {
    await lrV62Send(chatId, '❌ <b>Пост не найден</b>\n\nОткройте его из списка заново.', [[lrV62Btn('⬅️ К списку', 'post:all')]], 'html');
    return true;
  }
  const row = await lrV62GetPost(target);
  if (!row) {
    await lrV62Send(chatId, '❌ <b>Пост не найден в базе</b>', [[lrV62Btn('⬅️ К списку', 'post:all')]], 'html');
    return true;
  }
  const data = { virtualId };

  if (action === 'editor') {
    await lrV62ShowEditor(chatId, key, data, row);
    return true;
  }
  if (action === 'edit_text') {
    await lrV62SetSession(key || chatId, 'content_plan_v62_wait_text', data);
    await lrV62Send(chatId, '━━━━━━━━━━━━━━\n✏️ <b>Изменить текст</b>\n\nОтправьте новый текст поста следующим сообщением.\nПосле отправки текст будет сохранён и редактор откроется снова.\n━━━━━━━━━━━━━━', [[lrV62Btn('⬅️ К редактору', `lr_v62:editor:${encodeURIComponent(virtualId)}`)]], 'html');
    return true;
  }
  if (action === 'edit_media') {
    await lrV62SetSession(key || chatId, 'content_plan_v62_wait_media', data);
    await lrV62Send(chatId, '━━━━━━━━━━━━━━\n🖼 <b>Медиа</b>\n\nОтправьте новое фото, видео, файл или пост следующим сообщением.\nПосле отправки медиа будет сохранено и редактор откроется снова.\n━━━━━━━━━━━━━━', [[lrV62Btn('⬅️ К редактору', `lr_v62:editor:${encodeURIComponent(virtualId)}`)]], 'html');
    return true;
  }

  if (action === 'edit_button') {
    await lrV62SetSession(key || chatId, 'content_plan_v62_wait_button', data);
    await lrV62Send(chatId, '━━━━━━━━━━━━━━\n🔘 <b>Добавить кнопку</b>\n\nОтправьте название и ссылку двумя строками:\n\nТекст кнопки\nhttps://site.ru\n━━━━━━━━━━━━━━', [[lrV62Btn('⬅️ К редактору', `lr_v62:editor:${encodeURIComponent(virtualId)}`)]], 'html');
    return true;
  }
  if (action === 'signature') {
    const updated = await lrV63TogglePostFlag(target, ['signature_enabled','signatureEnabled','use_signature','with_signature','signature']);
    if (!updated) {
      await lrV62Send(chatId, '⚠️ <b>Автоподпись</b>\n\nНе найдено поле автоподписи у этого поста.', [[lrV62Btn('⬅️ К редактору', `lr_v62:editor:${encodeURIComponent(virtualId)}`)]], 'html');
      return true;
    }
    await lrV62ShowEditor(chatId, key, data, updated, '✅ Автоподпись переключена.');
    return true;
  }
  if (action === 'ad') {
    const updated = await lrV63TogglePostFlag(target, ['is_ad','isAd','ad','is_advertising','advertising','promo']);
    if (!updated) {
      await lrV62Send(chatId, '⚠️ <b>Рекламный пост</b>\n\nНе найдено поле рекламного режима у этого поста.', [[lrV62Btn('⬅️ К редактору', `lr_v62:editor:${encodeURIComponent(virtualId)}`)]], 'html');
      return true;
    }
    await lrV62ShowEditor(chatId, key, data, updated, '✅ Рекламный режим переключён.');
    return true;
  }

  if (action === 'save') {
    await lrV62ClearSession(key || chatId).catch(()=>{});
    await lrV62ShowEditor(chatId, key, data, row, '✅ Пост сохранён.');
    return true;
  }
  return false;
}

app.use(async function lrContentPlanMediaEditV62(req, res, next) {
  try {
    const url = String(req.path || req.url || '');
    if (req.method !== 'POST' || !/\/webhook(?:$|\?)/.test(url)) return next();

    const update = req.body || {};
    const type = lrV62Type(update);
    const chatId = lrV62ChatId(update);
    const key = lrV62SessionKey(update, chatId);
    const payload = lrV62Payload(update);

    if (payload && await lrV62HandleCallback(update, chatId, key, payload)) {
      if (!res.headersSent) return res.json({ ok: true, handled: 'lr_content_plan_media_edit_v62_callback' });
      return;
    }

    const session = await lrV62GetSession(chatId, key).catch(e => {
      console.error('[v62 plan media] get session failed', e?.stack || e?.message || e);
      return null;
    });
    if (session && (type === 'message_created' || lrV62Text(update) || lrV62Attachments(update).length)) {
      const handled = await lrV62HandleWaitInput(update, chatId, key, session);
      if (handled) {
        if (!res.headersSent) return res.json({ ok: true, handled: 'lr_content_plan_media_edit_v62_input' });
        return;
      }
    }

    return next();
  } catch (e) {
    console.error('[v62 plan media] middleware failed', e?.stack || e?.message || e);
    return next();
  }
});
console.log('[v62 plan media] installed');
/* LR_CONTENT_PLAN_MEDIA_EDIT_V62_END */


/* LR_LINKRAY_PROOF_REPORTS_INSTALL_V1 */
/* LR_LINKRAY_PURCHASES_INSTALL_V1: old Proof runtime disabled */

app.post('/webhook', async (req, res) => {
  const incomingSecret = req.header('X-Max-Bot-Api-Secret');
  if (process.env.WEBHOOK_SECRET && incomingSecret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ ok: false });
  res.json({ ok: true });
  try {
    const update = req.body || {};
  /* LR_V46_CLEAN_ON_POST_CREATE */
  await lrV46ResetCollectPostStart(update);
  /* LR_V42_SET_GLOBALS_IN_WEBHOOK */
  lrV42SetGlobals(update); const type = getUpdateType(update);
log('webhook', { type: lrV40Type(update), chatId: getChatId(update), key: getSessionKey(update) }); if (await __lrChannelForwardConfirm(update)) return;

    
      let payload = String(getCallbackPayload(update) || '');
    const callbackId = getCallbackId(update);
    const chatId = getChatId(update);

    if (!type.includes('callback') && !callbackId && (payload === '[object Object]' || payload.startsWith('[object '))) {
      console.log('[v16 payload fix] drop fake payload on message', JSON.stringify({ type, chatId, payload }));
      payload = '';
    }

    if (type.includes('callback') || callbackId || payload) {
        console.log('[webhook callback direct]', JSON.stringify({ type: lrV40Type(update), chatId: lrV40ChatId(update), payload, hasCallbackId: Boolean(callbackId) }));
      /* LR_FRAUD_FINAL_WEBHOOK_V4_START */
      if (String(payload || '').startsWith('fraud:')) {
        const fraudModule = globalThis.__lrAntiFraud24x7;

        const fraudActorId = String(
          update?.user_id ||
          update?.userId ||
          update?.sender?.user_id ||
          update?.sender?.id ||
          update?.callback?.user?.user_id ||
          update?.callback?.user?.id ||
          update?.message_callback?.user?.user_id ||
          update?.message_callback?.user?.id ||
          update?.message?.sender?.user_id ||
          update?.message?.sender?.id ||
          update?.body?.user_id ||
          update?.body?.userId ||
          update?.body?.sender?.user_id ||
          update?.body?.sender?.id ||
          update?.body?.message?.sender?.user_id ||
          update?.body?.message?.sender?.id ||
          chatId ||
          ''
        );

        const fraudUpdate = {
          ...(update || {}),
          payload: String(payload),
          callback_id: String(
            callbackId ||
            update?.callback_id ||
            update?.callbackId ||
            update?.callback?.callback_id ||
            update?.callback?.id ||
            update?.message_callback?.callback_id ||
            update?.message_callback?.id ||
            update?.body?.callback_id ||
            update?.body?.callbackId ||
            update?.body?.callback?.callback_id ||
            update?.body?.callback?.id ||
            ''
          ),
          chat_id: String(
            chatId ||
            update?.chat_id ||
            update?.chatId ||
            update?.message?.recipient?.chat_id ||
            update?.message?.recipient?.id ||
            update?.body?.chat_id ||
            update?.body?.chatId ||
            update?.body?.message?.recipient?.chat_id ||
            update?.body?.message?.recipient?.id ||
            ''
          ),
          user_id: fraudActorId,
        };

        try {
          if (
            !fraudModule ||
            typeof fraudModule.handleCallback !== 'function'
          ) {
            throw new Error(
              'globalThis.__lrAntiFraud24x7 is unavailable'
            );
          }

          /*
           * Здесь нет предварительного answerCallback().
           * Карточку и callback отвечает ровно один раз сам AntiFraud.
           */
          const fraudHandled =
            await fraudModule.handleCallback(fraudUpdate);

          if (!fraudHandled) {
            throw new Error(
              `AntiFraud did not handle ${String(payload)}`
            );
          }

          console.log(
            '[LR_FRAUD_FINAL_WEBHOOK_V4]',
            JSON.stringify({
              ok: true,
              payload: String(payload),
              callbackId: callbackId || null,
              chatId: chatId || null,
              actorId: fraudActorId || null,
            })
          );
        } catch (fraudError) {
          console.error(
            '[LR_FRAUD_FINAL_WEBHOOK_V4]',
            fraudError?.stack ||
            fraudError?.message ||
            fraudError
          );

          const errorText =
            '⚠️ Не удалось открыть раздел AntiFraud. ' +
            'Попробуйте нажать кнопку ещё раз.';

          let delivered = false;

          if (callbackId && typeof cb === 'function') {
            try {
              await cb(
                callbackId,
                errorText,
                [[callbackButton('⬅️ К каналам', 'fraud:menu')]]
              );
              delivered = true;
            } catch {}
          }

          if (
            !delivered &&
            fraudActorId &&
            typeof msg === 'function'
          ) {
            try {
              await msg(
                fraudActorId,
                errorText,
                [[callbackButton('⬅️ К каналам', 'fraud:menu')]]
              );
            } catch {}
          }
        }

        return;
      }
      /* LR_FRAUD_FINAL_WEBHOOK_V4_END */



      


        if (payload === 'main:menu') {
          if (callbackId && typeof showMainCallback === 'function') await showMainCallback(callbackId);
          else if (chatId && typeof sendMain === 'function') await sendMain(chatId);
          return;
        }

        if (payload === 'main:posting') {
          if (callbackId && typeof showStudio === 'function') await showStudio(callbackId);
          else if (chatId && typeof sendStudio === 'function') await sendStudio(chatId);
          return;
        }

        if (payload === 'post:add_channel') { await showChannels(callbackId, chatId); return; } if (payload === 'reports:menu') {
          const rows = [[callbackButton('⬅️ В меню', 'main:menu')]];
          const text = `📈 <b>Отчёты</b>

Раздел отчётов скоро будет доступен.`;
          if (callbackId && typeof cb === 'function') await cb(callbackId, text, rows);
          else if (chatId && typeof msg === 'function') await msg(chatId, text, rows);
          return;
        }

        

        if (payload === 'main:analytics' || payload === 'analytics:menu') {
          const rows = [[callbackButton('⬅️ В меню', 'main:menu')]];
          const text = `📊 <b>LinkRay Analytics</b>

Выберите раздел:

🖼 <b>Картинка по ссылке</b> — отправьте ссылку канала или несколько ссылок, бот сделает PNG-карточку.

📅 <b>Ежедневный отчёт ПДП</b> — отчёт каждый день в 08:00 МСК: подписки, отписки и общий итог.`;
          if (callbackId && typeof cb === 'function') await cb(callbackId, text, rows);
          else if (chatId && typeof msg === 'function') await msg(chatId, text, rows);
          return;
        }

        await handleCallback(update);
      } else {
        await handleMessage(update);
      }

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


/* LR_POST_SINGLE_FALLBACK_FIX_START */
(function installPostSingleFallbackFix() {
  function ok(v) {
    const x = String(v ?? '').trim();
    const low = x.toLowerCase();
    if (!x || x.length > 260) return '';
    if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(low)) return '';
    return x;
  }

  function payload(update) {
    const list = [];

    try {
      if (typeof getCallbackPayload === 'function') list.push(getCallbackPayload(update));
    } catch {}

    list.push(
      update?.payload,
      update?.callback?.payload,
      update?.message_callback?.payload,
      update?.body?.payload,
      update?.data,
      update?.callback?.data,
      update?.body?.data
    );

    for (const v of list) {
      const p = ok(v);
      if (p) return p;
    }

    return '';
  }

  function chatId(update, key) {
    try {
      if (typeof lrResolveReplyChatId === 'function') {
        const id = lrResolveReplyChatId(update, key);
        if (ok(id)) return ok(id);
      }
    } catch {}

    try {
      if (typeof getChatId === 'function') {
        const id = getChatId(update);
        if (ok(id)) return ok(id);
      }
    } catch {}

    return ok(
      update?.chatId ||
      update?.chat_id ||
      update?.body?.chatId ||
      update?.body?.chat_id ||
      update?.message?.recipient?.chat_id ||
      ''
    );
  }

  function sessionKey(update) {
    try {
      if (typeof getSessionKey === 'function') {
        const key = getSessionKey(update);
        if (ok(key)) return ok(key);
      }
    } catch {}

    return chatId(update, '');
  }

  function textOf(update) {
    const list = [];

    try {
      if (typeof __lrV12Text === 'function') list.push(__lrV12Text(update));
    } catch {}

    try {
      if (typeof getMessageText === 'function') list.push(getMessageText(update));
    } catch {}

    list.push(
      update?.message?.body?.text,
      update?.message?.text,
      update?.body?.message?.body?.text,
      update?.body?.message?.text,
      update?.text
    );

    for (const v of list) {
      const t = String(v ?? '').trim();
      if (t) return t;
    }

    return '';
  }

  function hasContent(content) {
    return !!(
      String(content?.text || '').trim() ||
      String(content?.link || '').trim() ||
      (Array.isArray(content?.attachments) && content.attachments.length)
    );
  }

  async function hydrate(update) {
    try {
      if (typeof lrSafeHydrateContent === 'function') {
        const content = await lrSafeHydrateContent(update);
        if (hasContent(content)) return content;
      }
    } catch (e) {
      console.error('[LR_POST_SINGLE_FALLBACK_FIX hydrate lrSafe]', e?.stack || e?.message || e);
    }

    try {
      if (typeof hydrateContent === 'function') {
        const content = await hydrateContent(update);
        if (hasContent(content)) return content;
      }
    } catch (e) {
      console.error('[LR_POST_SINGLE_FALLBACK_FIX hydrate]', e?.stack || e?.message || e);
    }

    const text = textOf(update);
    if (!text) return null;

    return {
      text,
      format: 'html',
      markup: [],
      attachments: []
    };
  }

  async function ensureStateTable() {
    await query(`CREATE TABLE IF NOT EXISTS lr_bot_state (
      key text PRIMARY KEY,
      value text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async function putWait(update, channelId) {
    const key = sessionKey(update);
    const chat = chatId(update, key);

    const value = {
      channelIds: [Number(channelId)],
      channelId: Number(channelId),
      key,
      chatId: chat,
      ts: Date.now()
    };

    await ensureStateTable();

    const keys = new Set();
    if (key) keys.add(`lr_post_single_wait:${key}`);
    if (chat) keys.add(`lr_post_single_wait:${chat}`);

    for (const stateKey of keys) {
      await query(
        `INSERT INTO lr_bot_state(key, value, updated_at)
         VALUES($1, $2, now())
         ON CONFLICT(key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = now()`,
        [stateKey, JSON.stringify(value)]
      ).catch(() => {});
    }

    try {
      if (typeof setSession === 'function') {
        const draft = { channelIds: [Number(channelId)] };
        await setSession(key, 'wait_post_content', { draft }).catch(() => {});
      }
    } catch {}

    console.log('[LR_POST_SINGLE_FALLBACK_FIX wait]', JSON.stringify({
      channelId: Number(channelId),
      key,
      chat,
      keys: keys.size
    }));
  }

  async function readWait(update) {
    const key = sessionKey(update);
    const chat = chatId(update, key);

    const keys = [];
    if (key) keys.push(`lr_post_single_wait:${key}`);
    if (chat) keys.push(`lr_post_single_wait:${chat}`);

    if (!keys.length) return null;

    const rows = await query(
      `SELECT value
         FROM lr_bot_state
        WHERE key = ANY($1::text[])
          AND updated_at > now() - interval '30 minutes'
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
      [keys]
    ).catch(() => []);

    if (!rows?.[0]?.value) return null;

    try {
      const wait = JSON.parse(rows[0].value);
      if (Array.isArray(wait?.channelIds) && wait.channelIds.length) return wait;
      if (wait?.channelId) return { ...wait, channelIds: [Number(wait.channelId)] };
    } catch {}

    return null;
  }

  async function clearWait(update) {
    const key = sessionKey(update);
    const chat = chatId(update, key);

    const keys = [];
    if (key) keys.push(`lr_post_single_wait:${key}`);
    if (chat) keys.push(`lr_post_single_wait:${chat}`);

    if (keys.length) {
      await query(`DELETE FROM lr_bot_state WHERE key = ANY($1::text[])`, [keys]).catch(() => {});
    }
  }

  async function sendEditor(update, wait, content) {
    const key = sessionKey(update);
    const chat = chatId(update, key);

    if (!chat) {
      console.error('[LR_POST_SINGLE_FALLBACK_FIX] no chat id');
      return false;
    }

    let draft = {};

    try {
      draft = typeof safeDraft === 'function' ? safeDraft({}) : {};
    } catch {
      draft = {};
    }

    draft.channelIds = (wait.channelIds || []).map(Number).filter(Boolean);
    draft.content = {
      ...(draft.content || {}),
      ...content
    };

    if (!draft.channelIds.length) {
      console.error('[LR_POST_SINGLE_FALLBACK_FIX] no channelIds');
      return false;
    }

    await clearWait(update);

    try {
      if (typeof setSession === 'function') {
        await setSession(key, 'edit_draft', { draft }).catch(() => {});
      }
    } catch {}

    console.log('[LR_POST_SINGLE_FALLBACK_FIX editor]', JSON.stringify({
      key,
      chat,
      channelIds: draft.channelIds,
      textLen: String(draft.content?.text || '').length,
      attachments: Array.isArray(draft.content?.attachments) ? draft.content.attachments.length : 0
    }));

    if (typeof sendEditorAsNew === 'function') {
      await sendEditorAsNew(chat, key, draft);
      return true;
    }

    if (typeof sendDraftPreview === 'function') {
      await sendDraftPreview(chat, key, draft);
      return true;
    }

    console.error('[LR_POST_SINGLE_FALLBACK_FIX] editor sender not found');
    return false;
  }

  const oldCallback = handleCallback;
  handleCallback = async function(update) {
    const p = payload(update);

    try {
      if (p === 'post:create' || p === 'main:posting' || p === 'post:cancel' || p.startsWith('sig:') || p.startsWith('main:')) {
        await clearWait(update);
      }

      const m = String(p || '').match(/^post:single:(\d+)$/);
      if (m) {
        await putWait(update, Number(m[1]));
      }
    } catch (e) {
      console.error('[LR_POST_SINGLE_FALLBACK_FIX callback pre]', e?.stack || e?.message || e);
    }

    return oldCallback(update);
  };

  const oldMessage = handleMessage;
  handleMessage = async function(update) {
  /* LR_V42_SET_GLOBALS_IN_HANDLER */
  lrV42SetGlobals(update);
    try {
      const raw = textOf(update);

      if (raw.startsWith('/')) {
        await clearWait(update);
        return oldMessage(update);
      }

      const wait = await readWait(update);

      if (wait?.channelIds?.length) {
        const content = await hydrate(update);

        if (hasContent(content)) {
          const done = await sendEditor(update, wait, content);
          if (done) return;
        }

        console.log('[LR_POST_SINGLE_FALLBACK_FIX] wait exists but no content');
      }
    } catch (e) {
      console.error('[LR_POST_SINGLE_FALLBACK_FIX message]', e?.stack || e?.message || e);
    }

    return oldMessage(update);
  };

  console.log('[LR_POST_SINGLE_FALLBACK_FIX] installed');
})();
/* LR_POST_SINGLE_FALLBACK_FIX_END */


/* LR_POST_MESSAGE_CALLBACK_FIX_START */
(function installPostMessageCallbackFix() {
  function ok(v) {
    const x = String(v ?? '').trim();
    const low = x.toLowerCase();
    if (!x || x.length > 260) return '';
    if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(low)) return '';
    return x;
  }

  function typeOf(update) {
    return String(update?.type || update?.update_type || update?.event_type || update?.body?.type || '').toLowerCase();
  }

  function callbackId(update) {
    try {
      if (typeof getCallbackId === 'function') {
        const id = getCallbackId(update);
        if (ok(id)) return ok(id);
      }
    } catch {}

    return ok(
      update?.callback_id ||
      update?.callbackId ||
      update?.callback?.id ||
      update?.callback?.callback_id ||
      update?.message_callback?.callback_id ||
      update?.body?.callback_id ||
      ''
    );
  }

  function sessionKey(update) {
    try {
      if (typeof getSessionKey === 'function') {
        const key = getSessionKey(update);
        if (ok(key)) return ok(key);
      }
    } catch {}

    return chatId(update, '');
  }

  function chatId(update, key) {
    try {
      if (typeof lrResolveReplyChatId === 'function') {
        const id = lrResolveReplyChatId(update, key);
        if (ok(id)) return ok(id);
      }
    } catch {}

    try {
      if (typeof getChatId === 'function') {
        const id = getChatId(update);
        if (ok(id)) return ok(id);
      }
    } catch {}

    return ok(
      update?.chatId ||
      update?.chat_id ||
      update?.body?.chatId ||
      update?.body?.chat_id ||
      update?.message?.recipient?.chat_id ||
      update?.message?.chat_id ||
      ''
    );
  }

  function textOf(update) {
    const values = [];

    try {
      if (typeof __lrV12Text === 'function') values.push(__lrV12Text(update));
    } catch {}

    try {
      if (typeof getMessageText === 'function') values.push(getMessageText(update));
    } catch {}

    values.push(
      update?.message?.body?.text,
      update?.message?.text,
      update?.body?.message?.body?.text,
      update?.body?.message?.text,
      update?.text,
      update?.body?.text
    );

    for (const v of values) {
      const t = String(v ?? '').trim();
      if (t) return t;
    }

    return '';
  }

  function hasContent(content) {
    return !!(
      String(content?.text || '').trim() ||
      String(content?.link || '').trim() ||
      (Array.isArray(content?.attachments) && content.attachments.length)
    );
  }

  async function hydrate(update) {
    try {
      if (typeof lrSafeHydrateContent === 'function') {
        const content = await lrSafeHydrateContent(update);
        if (hasContent(content)) return content;
      }
    } catch (e) {
      console.error('[LR_POST_MESSAGE_CALLBACK_FIX hydrate safe]', e?.stack || e?.message || e);
    }

    try {
      if (typeof hydrateContent === 'function') {
        const content = await hydrateContent(update);
        if (hasContent(content)) return content;
      }
    } catch (e) {
      console.error('[LR_POST_MESSAGE_CALLBACK_FIX hydrate]', e?.stack || e?.message || e);
    }

    const text = textOf(update);
    if (!text) return null;

    return { text, format: 'html', markup: [], attachments: [] };
  }

  async function readWait(update) {
    const key = sessionKey(update);
    const chat = chatId(update, key);

    const keys = [];
    if (key) keys.push(`lr_post_single_wait:${key}`);
    if (chat) keys.push(`lr_post_single_wait:${chat}`);

    if (!keys.length) return null;

    const rows = await query(
      `SELECT value
         FROM lr_bot_state
        WHERE key = ANY($1::text[])
          AND updated_at > now() - interval '30 minutes'
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
      [keys]
    ).catch(() => []);

    if (!rows?.[0]?.value) return null;

    try {
      const wait = JSON.parse(rows[0].value);
      if (Array.isArray(wait?.channelIds) && wait.channelIds.length) return wait;
      if (wait?.channelId) return { ...wait, channelIds: [Number(wait.channelId)] };
    } catch {}

    return null;
  }

  async function clearWait(update) {
    const key = sessionKey(update);
    const chat = chatId(update, key);

    const keys = [];
    if (key) keys.push(`lr_post_single_wait:${key}`);
    if (chat) keys.push(`lr_post_single_wait:${chat}`);

    if (keys.length) {
      await query(`DELETE FROM lr_bot_state WHERE key = ANY($1::text[])`, [keys]).catch(() => {});
    }
  }

  async function openEditor(update, wait, content) {
    const key = sessionKey(update);
    const chat = chatId(update, key);

    if (!chat) {
      console.error('[LR_POST_MESSAGE_CALLBACK_FIX] no chat id');
      return false;
    }

    let draft = {};
    try {
      draft = typeof safeDraft === 'function' ? safeDraft({}) : {};
    } catch {
      draft = {};
    }

    draft.channelIds = (wait.channelIds || []).map(Number).filter(Boolean);
    draft.content = { ...(draft.content || {}), ...content };

    if (!draft.channelIds.length) {
      console.error('[LR_POST_MESSAGE_CALLBACK_FIX] no channelIds');
      return false;
    }

    await clearWait(update);

    try {
      if (typeof setSession === 'function') {
        await setSession(key, 'edit_draft', { draft }).catch(() => {});
      }
    } catch {}

    console.log('[LR_POST_MESSAGE_CALLBACK_FIX editor]', JSON.stringify({
      key,
      chat,
      channelIds: draft.channelIds,
      textLen: String(draft.content?.text || '').length,
      attachments: Array.isArray(draft.content?.attachments) ? draft.content.attachments.length : 0
    }));

    if (typeof sendEditorAsNew === 'function') {
      await sendEditorAsNew(chat, key, draft);
      return true;
    }

    if (typeof sendDraftPreview === 'function') {
      await sendDraftPreview(chat, key, draft);
      return true;
    }

    console.error('[LR_POST_MESSAGE_CALLBACK_FIX] editor sender not found');
    return false;
  }

  const oldHandleCallback = handleCallback;

  handleCallback = async function(update) {
    try {
      const t = typeOf(update);
      const cbid = callbackId(update);

      // В MAX входящий текст иногда попадает в callback-ветку как message_created
      // с payload "[object Object]". Поэтому перехватываем его здесь до старого callback-кода.
      if (t === 'message_created' && !cbid) {
        const raw = textOf(update);

        if (raw.startsWith('/')) {
          await clearWait(update);
          return oldHandleCallback(update);
        }

        const wait = await readWait(update);

        if (wait?.channelIds?.length) {
          const content = await hydrate(update);

          if (hasContent(content)) {
            const done = await openEditor(update, wait, content);
            if (done) return;
          }

          console.log('[LR_POST_MESSAGE_CALLBACK_FIX] message_created wait but no content');
        }
      }
    } catch (e) {
      console.error('[LR_POST_MESSAGE_CALLBACK_FIX callback message]', e?.stack || e?.message || e);
    }

    return oldHandleCallback(update);
  };

  console.log('[LR_POST_MESSAGE_CALLBACK_FIX] installed');
})();
/* LR_POST_MESSAGE_CALLBACK_FIX_END */


/* LR_PUBLISH_AUTODELETE_FIX_START */
(function installPublishAutoDeleteFix() {
  function ok(v) {
    const x = String(v ?? '').trim();
    const low = x.toLowerCase();
    if (!x || x.length > 260) return '';
    if (['unknown', 'undefined', 'null', 'nan', '[object object]'].includes(low)) return '';
    return x;
  }

  function getPayload(update) {
    const values = [];

    try {
      if (typeof getCallbackPayload === 'function') values.push(getCallbackPayload(update));
    } catch {}

    values.push(
      update?.payload,
      update?.callback?.payload,
      update?.message_callback?.payload,
      update?.body?.payload,
      update?.data,
      update?.callback?.data,
      update?.body?.data
    );

    for (const v of values) {
      const p = ok(v);
      if (p) return p;
    }

    return '';
  }

  function getKey(update) {
    try {
      if (typeof getSessionKey === 'function') {
        const key = getSessionKey(update);
        if (ok(key)) return ok(key);
      }
    } catch {}

    return ok(update?.chatId || update?.chat_id || update?.body?.chatId || update?.body?.chat_id || '');
  }

  function getCbId(update) {
    try {
      if (typeof getCallbackId === 'function') {
        const id = getCallbackId(update);
        if (ok(id)) return ok(id);
      }
    } catch {}

    return ok(
      update?.callback_id ||
      update?.callbackId ||
      update?.callback?.id ||
      update?.message_callback?.callback_id ||
      update?.body?.callback_id ||
      ''
    );
  }

  function autoText(minutes) {
    try {
      if (typeof formatAutoDelete === 'function') return formatAutoDelete(minutes);
    } catch {}

    const n = Number(minutes || 0);
    if (!n) return 'без удаления';
    if (n % 1440 === 0) return `${n / 1440}д`;
    if (n % 60 === 0) return `${n / 60}ч`;
    return `${n} мин`;
  }

  const oldHandleCallback = handleCallback;

  handleCallback = async function(update) {
    const payload = getPayload(update);

    if (payload.startsWith('publish:auto_set:')) {
      try {
        const key = getKey(update);
        const callbackId = getCbId(update);
        const minutes = Number(payload.split(':')[2] || 0) || null;

        if (!key) {
          console.error('[LR_PUBLISH_AUTODELETE_FIX] no session key');
          return oldHandleCallback(update);
        }

        const session = await getSession(key);
        const draft = typeof safeDraft === 'function'
          ? safeDraft(session?.data)
          : ((session?.data && session.data.draft) ? session.data.draft : (session?.data || {}));

        draft.autoDeleteMinutes = minutes;
        draft.auto_delete_minutes = minutes;
        draft.deleteAfterMinutes = minutes;
        draft.removeAfterMinutes = minutes;

        await setSession(key, 'publish_menu', { draft });

        console.log('[LR_PUBLISH_AUTODELETE_FIX]', JSON.stringify({
          key,
          minutes,
          label: autoText(minutes)
        }));

        if (typeof showPublishMenu === 'function') {
          return showPublishMenu(callbackId, key, draft);
        }

        if (callbackId && typeof cb === 'function') {
          return cb(
            callbackId,
            `✅ Автоудаление: ${autoText(minutes)}`,
            [[callbackButton('⬅️ К выпуску', 'editor:next')]]
          );
        }

        return;
      } catch (e) {
        console.error('[LR_PUBLISH_AUTODELETE_FIX]', e?.stack || e?.message || e);
        return;
      }
    }

    return oldHandleCallback(update);
  };

  console.log('[LR_PUBLISH_AUTODELETE_FIX] installed');
})();
/* LR_PUBLISH_AUTODELETE_FIX_END */

/* LR_CONTENT_PLAN_TEXT_SAVE_V54_START */
// Исправляет сохранение текста поста из контент-плана.
// Причина старой ошибки: SQL UPDATE ожидал 2 параметра, а обработчик отдавал 3.
function lrV54PlanEsc(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
  } catch (_) {}
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lrV54PlanText(update) {
  const list = [
    update?.message?.body?.text,
    update?.message?.text,
    update?.message?.content?.text,
    update?.message?.content?.body?.text,
    update?.content?.text,
    update?.content?.body?.text,
    update?.body?.text,
    update?.text,
    update?.message?.body,
    update?.body
  ];
  for (const v of list) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

async function lrV54PlanGetSession(key) {
  try {
    if (typeof getSession === 'function') {
      const s = await getSession(key);
      if (s && typeof s === 'object') return s;
    }
  } catch (e) {
    console.error('[v54 plan text] getSession failed', e?.message || e);
  }
  try {
    if (typeof query === 'function') {
      const r = await query(
        `SELECT user_id,state,data,updated_at
           FROM bot_sessions
          WHERE user_id::text IN ($1, $2)
          ORDER BY updated_at DESC
          LIMIT 1`,
        [String(key), 'user:' + String(key).replace(/^user:/, '')]
      );
      const row = (r?.rows || [])[0];
      if (row) return row;
    }
  } catch (e) {
    console.error('[v54 plan text] DB session read failed', e?.message || e);
  }
  return null;
}

function lrV54PlanData(session) {
  let data = session?.data || {};
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { data = {}; }
  }
  return data && typeof data === 'object' ? data : {};
}

function lrV54PlanTarget(data) {
  const rawVid = String(data.virtualId || data.vid || data.target || '').trim();
  let vid = rawVid;
  try { vid = decodeURIComponent(vid); } catch (_) {}

  let table = String(data.table || '').trim();
  let id = String(data.id || data.postId || '').trim();

  if ((!table || !id) && vid) {
    const parts = vid.split(':');
    if (parts.length >= 2) {
      table = table || parts[0];
      id = id || parts[1];
    }
  }

  table = table.replace(/[^a-zA-Z0-9_]/g, '');
  id = id.replace(/[^0-9]/g, '');

  const colByTable = {
    scheduled_posts: 'text',
    ad_post_trackers: 'post_text',
    ad_post_tracker_channels: 'post_text',
    lr_post_entry_v68: 'text'
  };
  const col = colByTable[table] || '';
  if (!table || !id || !col) return null;
  return { table, id, col, virtualId: vid || `${table}:${id}` };
}

async function lrV54PlanHasColumn(table, column) {
  try {
    const r = await query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name=$1
          AND column_name=$2
        LIMIT 1`,
      [table, column]
    );
    return Boolean((r?.rows || [])[0]);
  } catch (_) {
    return false;
  }
}

async function lrV54PlanClearSession(key) {
  try {
    if (typeof clearSession === 'function') {
      await clearSession(key);
      return;
    }
  } catch (e) {
    console.error('[v54 plan text] clearSession failed', e?.message || e);
  }
  try {
    await query(`UPDATE bot_sessions SET state='idle', data='{}'::jsonb, updated_at=now() WHERE user_id::text IN ($1,$2)`, [String(key), 'user:' + String(key).replace(/^user:/, '')]);
  } catch (e) {
    console.error('[v54 plan text] DB session clear failed', e?.message || e);
  }
}

async function lrV54PlanSend(chatId, text, rows) {
  if (!chatId) return;
  try {
    if (typeof msg === 'function') {
      await msg(chatId, text, rows || [], 'html');
      console.log('[v54 plan text] msg sent', JSON.stringify({ chatId }));
      return;
    }
  } catch (e) {
    console.error('[v54 plan text] msg failed', e?.stack || e?.message || e);
  }
  try {
    if (typeof sendMaxMessage === 'function') {
      await sendMaxMessage({ chatId, text, attachments: rows && typeof inlineKeyboard === 'function' ? inlineKeyboard(rows) : [] });
      console.log('[v54 plan text] sendMaxMessage sent', JSON.stringify({ chatId }));
    }
  } catch (e) {
    console.error('[v54 plan text] sendMaxMessage failed', e?.stack || e?.message || e);
  }
}

async function lrV54PlanTextInput(update) {
  const type = (typeof getUpdateType === 'function') ? String(getUpdateType(update) || '') : String(update?.update_type || update?.type || '');
  if (type && type !== 'message_created' && type !== 'message_edited') return false;

  const chatId = (typeof getChatId === 'function') ? getChatId(update) : (update?.message?.recipient?.chat_id || update?.message?.chat_id || update?.chat_id || update?.chat?.id || update?.dialog_chat_id || update?.dialogChatId);
  const key = (typeof getSessionKey === 'function') ? getSessionKey(update) : chatId;
  if (!key || !chatId) return false;

  const session = await lrV54PlanGetSession(key);
  if (!session || String(session.state || '') !== 'content_plan_v53_wait_text') return false;

  const newText = lrV54PlanText(update);
  if (!newText || newText.startsWith('/')) return false;

  const data = lrV54PlanData(session);
  const target = lrV54PlanTarget(data);
  console.log('[v54 plan text] input caught', JSON.stringify({ chatId, key, state: session.state, target, len: newText.length }));

  if (!target) {
    await lrV54PlanClearSession(key);
    await lrV54PlanSend(chatId, '❌ <b>Пост не найден</b>\n\nВернитесь в контент-план и откройте пост заново.', [[callbackButton('⬅️ К списку', 'post:all')]]);
    return true;
  }

  try {
    const hasUpdatedAt = await lrV54PlanHasColumn(target.table, 'updated_at');
    const sql = `UPDATE ${target.table} SET ${target.col}=$1${hasUpdatedAt ? ', updated_at=now()' : ''} WHERE id=$2 RETURNING *`;
    const saved = await query(sql, [newText, Number(target.id)]);
    const row = (saved?.rows || [])[0];
    if (!row) throw new Error('post row not found after update');

    await lrV54PlanClearSession(key);

    const encVid = encodeURIComponent(target.virtualId || `${target.table}:${target.id}`);
    const channelKey = String(data.channelKey || data.channel_id || data.channelId || data.channel || 'all');
    const day = String(data.day || data.date || 'today');
    const filter = String(data.filter || 'all');
    const page = String(data.page || '0');

    const rows = [];
    // payload старого контент-плана оставляем, чтобы действующие обработчики открывали тот же пост/список.
    rows.push([callbackButton('💾 Сохранить пост', `lr_plan_v51:save:${encVid}:${channelKey}:${day}:${filter}:${page}`)]);
    rows.push([callbackButton('⬅️ К списку', `lr_plan_v51:day:${channelKey}:${day}:${filter}:${page}`)]);
    rows.push([callbackButton('📁 Посты', 'post:all')]);

    await lrV54PlanSend(
      chatId,
      `━━━━━━\n🧬 <b>Редактор LinkRay</b>\n\n✅ Текст поста сохранён.\n\nНажмите «Сохранить пост» или вернитесь к списку.\n━━━━━━`,
      rows
    );

    console.log('[v54 plan text] text updated', JSON.stringify({ table: target.table, id: target.id, col: target.col }));
    return true;
  } catch (e) {
    console.error('[v54 plan text] update failed', e?.stack || e?.message || e);
    await lrV54PlanSend(chatId, `❌ <b>Ошибка при сохранении текста</b>\n\n${lrV54PlanEsc(e?.message || e)}`, [[callbackButton('⬅️ К списку', 'post:all')]]);
    return true;
  }
}

try {
  if (typeof handleMessage === 'function') {
    const lrV54PrevHandleMessage = handleMessage;
    handleMessage = async function lrV54HandleMessage(update) {
      if (await lrV54PlanTextInput(update)) return true;
      return lrV54PrevHandleMessage(update);
    };
    console.log('[v54 plan text] installed: fixed 2-param update for content-plan text editor');
  } else {
    console.error('[v54 plan text] handleMessage not found');
  }
} catch (e) {
  console.error('[v54 plan text] install failed', e?.stack || e?.message || e);
}
/* LR_CONTENT_PLAN_TEXT_SAVE_V54_END */

/* LR_CHANNEL_METRICS_COLLECTOR_V1_BOOTSTRAP */
import('./channelMetricsCollector.js')
  .then((mod) => mod.installChannelMetricsCollector(app))
  .catch((error) => {
    console.error(
      '[LR_CHANNEL_METRICS_BOOTSTRAP]',
      error?.stack || error?.message || error
    );
  });
/* LR_CHANNEL_METRICS_COLLECTOR_V1_BOOTSTRAP_END */

/* LR_CHANNEL_ACCESS_SYNC_V1_START */
try {
  startChannelAccessSync();
} catch (error) {
  console.error(
    '[channel access sync] start failed',
    error?.stack ||
    error?.message ||
    error
  );
}
/* LR_CHANNEL_ACCESS_SYNC_V1_END */

/* LR_CHANNEL_TEAM_ACCESS_START */
try {
  startChannelTeamAccess();
} catch (error) {
  console.error(
    '[channel team access] start failed',
    error?.stack ||
    error?.message ||
    error
  );
}
/* LR_CHANNEL_TEAM_ACCESS_END */

/* LR_POST_FLOW_FINAL_V77_START */
/*
 * Финальный изолированный маршрут создания поста.
 * Существующие функции не удаляются и не переписываются:
 * меняются только ссылки на три обработчика после загрузки файла.
 */
const lrV77OriginalSenderId =
  lrV47SenderId;

const lrV77OriginalAskContent =
  lrV47AskContent;

const lrV77OriginalMessageCreated =
  lrV47HandleMessageCreated;

const lrV77OriginalClearTempDrafts =
  lrV47ClearTempDrafts;

function lrV77CleanId(value) {
  return String(value ?? '')
    .trim()
    .replace(/^user:/, '')
    .slice(0, 180);
}

function lrV77IdentityIds(update, extras = []) {
  const values = [
    ...extras,

    update?.user_id,
    update?.userId,
    update?.user?.user_id,
    update?.user?.userId,
    update?.user?.id,

    update?.sender?.user_id,
    update?.sender?.userId,
    update?.sender?.id,

    update?.callback?.user_id,
    update?.callback?.userId,
    update?.callback?.user?.user_id,
    update?.callback?.user?.userId,
    update?.callback?.user?.id,

    update?.message_callback?.user_id,
    update?.message_callback?.userId,
    update?.message_callback?.user?.user_id,
    update?.message_callback?.user?.userId,
    update?.message_callback?.user?.id,

    update?.message?.sender?.user_id,
    update?.message?.sender?.userId,
    update?.message?.sender?.id,

    update?.message?.recipient?.chat_id,
    update?.message?.recipient?.chatId,
    update?.message?.recipient?.id,

    update?.chat_id,
    update?.chatId,

    update?.body?.user_id,
    update?.body?.userId,
    update?.body?.user?.user_id,
    update?.body?.user?.userId,
    update?.body?.user?.id,

    update?.body?.callback?.user_id,
    update?.body?.callback?.userId,
    update?.body?.callback?.user?.user_id,
    update?.body?.callback?.user?.userId,
    update?.body?.callback?.user?.id,

    update?.body?.message?.sender?.user_id,
    update?.body?.message?.sender?.userId,
    update?.body?.message?.sender?.id,

    update?.body?.message?.recipient?.chat_id,
    update?.body?.message?.recipient?.chatId,
    update?.body?.message?.recipient?.id,
  ];

  try {
    values.push(lrV47ChatId(update));
  } catch (_) {}

  try {
    values.push(lrV47PrivateChatId(update));
  } catch (_) {}

  try {
    values.push(lrV47Key(update));
  } catch (_) {}

  try {
    if (typeof getSessionKey === 'function') {
      values.push(getSessionKey(update));
    }
  } catch (_) {}

  const ids = new Set();

  for (const value of values) {
    const plain = lrV77CleanId(value);

    if (!plain || plain === '0') {
      continue;
    }

    ids.add(plain);
    ids.add(`user:${plain}`);
  }

  return [...ids];
}

function lrV77PendingKey(id) {
  return `lr_v77_pending_post:${String(id || '').slice(0, 190)}`;
}

function lrV77MessageId(update) {
  const values = [
    update?.message_id,
    update?.messageId,

    update?.message?.message_id,
    update?.message?.messageId,
    update?.message?.id,
    update?.message?.body?.mid,
    update?.message?.body?.message_id,
    update?.message?.body?.messageId,

    update?.body?.message_id,
    update?.body?.messageId,
    update?.body?.message?.message_id,
    update?.body?.message?.messageId,
    update?.body?.message?.id,
    update?.body?.message?.body?.mid,

    update?.callback?.message_id,
    update?.callback?.messageId,
  ];

  for (const value of values) {
    const id = String(value ?? '').trim();

    if (id && id !== '0') {
      return id;
    }
  }

  return '';
}

function lrV77EventFingerprint(update) {
  const ids = lrV77IdentityIds(update);
  const messageId = lrV77MessageId(update);

  const timestamp = String(
    update?.timestamp
    ?? update?.message?.timestamp
    ?? update?.body?.timestamp
    ?? ''
  );

  const linkedId = String(
    update?.message?.link?.message?.body?.mid
    ?? update?.message?.link?.message?.message_id
    ?? update?.message?.link?.message?.id
    ?? update?.body?.message?.link?.message?.body?.mid
    ?? update?.body?.message?.link?.message?.message_id
    ?? ''
  );

  const text = String(
    update?.message?.body?.text
    ?? update?.message?.text
    ?? update?.body?.message?.body?.text
    ?? update?.body?.message?.text
    ?? update?.body?.text
    ?? ''
  )
    .trim()
    .slice(0, 180);

  return [
    messageId,
    linkedId,
    timestamp,
    ids[0] || '',
    text,
  ]
    .join('|')
    .slice(0, 760);
}

async function lrV77IsClaimed(update) {
  const fingerprint =
    lrV77EventFingerprint(update);

  if (!fingerprint.replace(/\|/g, '')) {
    return false;
  }

  const key =
    `lr_v77_post_event:${fingerprint}`;

  try {
    const rows = lrV47Rows(
      await query(
        `SELECT 1
           FROM lr_bot_state
          WHERE key=$1
            AND updated_at > now() - interval '30 minutes'
          LIMIT 1`,
        [key]
      )
    );

    return Boolean(rows[0]);
  } catch (_) {
    return false;
  }
}

async function lrV77Claim(update) {
  const fingerprint =
    lrV77EventFingerprint(update);

  if (!fingerprint.replace(/\|/g, '')) {
    return true;
  }

  const key =
    `lr_v77_post_event:${fingerprint}`;

  try {
    const rows = lrV47Rows(
      await query(
        `INSERT INTO lr_bot_state(key,value,updated_at)
         VALUES($1,$2,now())
         ON CONFLICT(key) DO NOTHING
         RETURNING key`,
        [
          key,
          JSON.stringify({
            fingerprint,
            ts: Date.now(),
          }),
        ]
      )
    );

    return Boolean(rows[0]);
  } catch (error) {
    console.error(
      '[v77 post flow] claim failed',
      error?.stack
      || error?.message
      || error
    );

    return true;
  }
}

async function lrV77SavePending(
  update,
  chatId,
  sessionKey,
  draft
) {
  const ids = lrV77IdentityIds(
    update,
    [chatId, sessionKey]
  );

  const value = {
    draft,
    ids,
    chatId: String(chatId || ''),
    sessionKey: String(sessionKey || ''),
    ts: Date.now(),
  };

  for (const id of ids) {
    await lrV47StateSet(
      lrV77PendingKey(id),
      value
    );
  }

  console.log(
    '[v77 post flow] pending saved',
    JSON.stringify({
      chatId,
      sessionKey,
      ids,
      channelIds:
        Array.isArray(draft?.channelIds)
          ? draft.channelIds
          : [],
    })
  );

  return value;
}

async function lrV77LoadPending(update) {
  const ids = lrV77IdentityIds(update);

  for (const id of ids) {
    const value = await lrV47StateGet(
      lrV77PendingKey(id)
    );

    if (
      value?.draft
      && Number(value?.ts || 0)
        > Date.now() - 30 * 60 * 1000
    ) {
      return {
        ...value,
        matchedBy: id,
      };
    }
  }

  /*
   * Резерв используется только при единственном
   * незавершённом draft за последние 30 минут.
   * При нескольких пользователях чужой draft
   * автоматически не выбирается.
   */
  try {
    const rows = lrV47Rows(
      await query(
        `SELECT key,value,updated_at
           FROM lr_bot_state
          WHERE key LIKE 'lr_v77_pending_post:%'
            AND updated_at > now() - interval '30 minutes'
          ORDER BY updated_at DESC
          LIMIT 20`
      )
    );

    const unique = new Map();

    for (const row of rows) {
      let value = row?.value || {};

      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch (_) {
          value = {};
        }
      }

      if (!value?.draft) {
        continue;
      }

      const signature = JSON.stringify({
        sessionKey: value?.sessionKey || '',
        chatId: value?.chatId || '',
        channelIds: value?.draft?.channelIds || [],
        ts: value?.ts || 0,
      });

      unique.set(signature, value);
    }

    if (unique.size === 1) {
      return {
        ...[...unique.values()][0],
        matchedBy: 'single-recent-pending',
      };
    }
  } catch (error) {
    console.error(
      '[v77 post flow] pending fallback failed',
      error?.stack
      || error?.message
      || error
    );
  }

  return null;
}

async function lrV77ClearPending(
  pending,
  update
) {
  const ids = new Set([
    ...(
      Array.isArray(pending?.ids)
        ? pending.ids
        : []
    ),
    ...lrV77IdentityIds(
      update,
      [
        pending?.chatId,
        pending?.sessionKey,
      ]
    ),
  ]);

  for (const id of ids) {
    try {
      await query(
        `DELETE FROM lr_bot_state
          WHERE key=$1`,
        [lrV77PendingKey(id)]
      );
    } catch (_) {}
  }
}

async function lrV77FindSession(update) {
  const ids = lrV77IdentityIds(update);

  for (const id of ids) {
    const session = await lrV47GetSession(id)
      .catch(() => null);

    if (
      session
      && String(session?.state || '')
        === 'wait_post_content'
    ) {
      return {
        session,
        key: String(
          session?.user_id || id
        ),
        matchedBy: id,
      };
    }
  }

  try {
    const rows = lrV47Rows(
      await query(
        `SELECT user_id,state,data,updated_at
           FROM bot_sessions
          WHERE state='wait_post_content'
            AND updated_at > now() - interval '30 minutes'
          ORDER BY updated_at DESC
          LIMIT 2`
      )
    );

    if (rows.length === 1) {
      return {
        session: rows[0],
        key: String(
          rows[0]?.user_id || ''
        ),
        matchedBy: 'single-recent-session',
      };
    }
  } catch (error) {
    console.error(
      '[v77 post flow] session fallback failed',
      error?.stack
      || error?.message
      || error
    );
  }

  return null;
}

lrV47SenderId = function lrV47SenderIdV77(
  update
) {
  const ids = lrV77IdentityIds(update);

  for (const id of ids) {
    if (!String(id).startsWith('user:')) {
      return id;
    }
  }

  try {
    return String(
      lrV77OriginalSenderId(update)
      || ''
    );
  } catch (_) {
    return '';
  }
};

lrV47AskContent =
async function lrV47AskContentV77(
  chatId,
  key,
  draft
) {
  const d = draft || lrV47EmptyDraft();

  d.channelIds = Array.isArray(d.channelIds)
    ? [
        ...new Set(
          d.channelIds
            .map(Number)
            .filter(Number.isFinite)
        ),
      ]
    : [];

  await lrV47SetSession(
    key,
    'wait_post_content',
    { draft: d }
  );

  await lrV77SavePending(
    globalThis.__lastUpdate || {},
    chatId,
    key,
    d
  );

  const channels =
    await lrV47Channels(key || chatId);

  const selected = channels.filter(
    (channel) =>
      d.channelIds.includes(
        Number(channel.id)
      )
  );

  const list = selected.length
    ? selected
        .map(
          (channel) =>
            `• ${lrV47Esc(
              lrV47ChannelName(channel)
            )}`
        )
        .join('\n')
    : '—';

  return lrV47Msg(
    chatId,
    `━━━━━━━━━━━━━━
📨 Отправьте пост

Каналы:
${list}

Можно отправить текст, фото, видео,
файл или пересланный пост.
━━━━━━━━━━━━━━`,
    [
      [
        lrV47Btn(
          '⬅️ К каналам',
          'post:change_channels'
        ),
      ],
      [
        lrV47Btn(
          '❌ Отмена',
          'post:cancel'
        ),
      ],
    ],
    'html'
  );
};

lrV47ClearTempDrafts =
async function lrV47ClearTempDraftsV77(
  key
) {
  await lrV77OriginalClearTempDrafts(key);

  const plain = lrV77CleanId(key);
  const ids = [
    plain,
    plain ? `user:${plain}` : '',
  ].filter(Boolean);

  for (const id of ids) {
    try {
      await query(
        `DELETE FROM lr_bot_state
          WHERE key=$1`,
        [lrV77PendingKey(id)]
      );
    } catch (_) {}
  }
};

lrV47HandleMessageCreated =
async function lrV47HandleMessageCreatedV77(
  update
) {
  /*
   * Сохраняем существующую обработку удаления
   * и добавления каналов.
   */
  if (await lrV47HandleBotRemoved(update)) {
    return true;
  }

  if (await lrV47HandleAddForward(update)) {
    return true;
  }

  const chatId =
    lrV47PrivateChatId(update);

  /*
   * Второй webhook того же сообщения не должен
   * запускать новый сценарий после edit_draft.
   */
  if (await lrV77IsClaimed(update)) {
    console.log(
      '[v77 post flow] duplicate ignored',
      JSON.stringify({
        chatId,
        messageId:
          lrV77MessageId(update),
      })
    );

    return true;
  }

  const pending =
    await lrV77LoadPending(update);

  const foundSession =
    await lrV77FindSession(update);

  let key = String(
    pending?.sessionKey
    || foundSession?.key
    || lrV47Key(update)
    || chatId
    || ''
  );

  let draft =
    pending?.draft
    || (
      foundSession?.session
        ? lrV47SessionDraft(
            foundSession.session
          )
        : null
    );

  const selectedChannelIds =
    Array.isArray(draft?.channelIds)
      ? [
          ...new Set(
            draft.channelIds
              .map(Number)
              .filter(Number.isFinite)
          ),
        ]
      : [];

  if (
    draft
    && selectedChannelIds.length
  ) {
    const claimed =
      await lrV77Claim(update);

    if (!claimed) {
      return true;
    }

    const incomingDraft =
      await lrV47ExtractDraft(update);

    draft.content = {
      ...(draft.content || {}),
      ...(incomingDraft?.content || {}),
    };

    if (
      Array.isArray(
        incomingDraft?.buttons
      )
      && incomingDraft.buttons.length
    ) {
      draft.buttons =
        incomingDraft.buttons;
    }

    draft.channelIds =
      selectedChannelIds;

    draft.previewMessageId = null;

    await lrV77ClearPending(
      pending || {
        sessionKey: key,
        chatId,
        ids: lrV77IdentityIds(update),
      },
      update
    );

    await lrV47OpenEditor(
      chatId,
      key,
      draft
    );

    console.log(
      '[v77 post flow] opened editor',
      JSON.stringify({
        chatId,
        key,
        pending:
          pending?.matchedBy || null,
        session:
          foundSession?.matchedBy || null,
        channelIds:
          draft.channelIds,
        messageId:
          lrV77MessageId(update),
      })
    );

    return true;
  }

  const ids =
    lrV77IdentityIds(update);

  let currentSession = null;

  for (const id of ids) {
    currentSession =
      await lrV47GetSession(id)
        .catch(() => null);

    if (currentSession) {
      key = String(
        currentSession?.user_id
        || id
      );

      break;
    }
  }

  const state = String(
    currentSession?.state || ''
  );

  /*
   * Эти состояния не имеют права превращать
   * входящее сообщение в новый пост.
   */
  const protectedStates = new Set([
    'select_channels',
    'select_channels_multi',
    'edit_draft',
    'edit_existing',
  ]);

  if (protectedStates.has(state)) {
    console.log(
      '[v77 post flow] protected state',
      JSON.stringify({
        chatId,
        key,
        state,
      })
    );

    return true;
  }

  /*
   * Эти состояния должен продолжать обрабатывать
   * старый действующий handleMessage.
   */
  const nativeInputStates = new Set([
    'wait_edit_text',
    'wait_edit_media',
    'wait_button',
    'wait_signature',
    'wait_cpm',
    'wait_schedule',
    'wait_post_time',
    'wait_auto_delete',
  ]);

  if (nativeInputStates.has(state)) {
    return false;
  }

  const mainStates = new Set([
    '',
    'idle',
    'main',
    'menu',
    'start',
  ]);

  if (mainStates.has(state)) {
    return lrV47HandleMainForward(
      update
    );
  }

  /*
   * Любое неизвестное активное состояние
   * не передаём в новый выбор каналов.
   */
  console.log(
    '[v77 post flow] non-main state ignored',
    JSON.stringify({
      chatId,
      key,
      state,
    })
  );

  return false;
};

console.log(
  '[v77 post flow] installed: '
  + 'selected channels persist; '
  + 'duplicates cannot reopen channel selection'
);
/* LR_POST_FLOW_FINAL_V77_END */
