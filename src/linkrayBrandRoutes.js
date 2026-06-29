import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const brandDir = path.resolve(__dirname, '../public/brand');
const logoFile = path.join(brandDir, 'linkray-logo.png');

function absoluteLogo(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'linkray.ru';
  return `${proto}://${host}/brand/linkray-logo.png`;
}

function brandHead(req) {
  const logo = absoluteLogo(req);
  return `
<!-- linkray-brand:start -->
<link rel="icon" type="image/png" href="/brand/linkray-logo.png">
<link rel="shortcut icon" type="image/png" href="/brand/linkray-logo.png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<meta name="theme-color" content="#071827">
<meta name="application-name" content="LinkRay">
<meta name="apple-mobile-web-app-title" content="LinkRay">
<meta property="og:site_name" content="LinkRay">
<meta property="og:title" content="LinkRay">
<meta property="og:image" content="${logo}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${logo}">
<!-- linkray-brand:end -->`;
}

function injectBrand(html, req) {
  const src = String(html || '');

  if (!src || src.includes('linkray-brand:start')) return src;
  if (!/<head[\s>]/i.test(src)) return src;

  return src.replace(/<head([^>]*)>/i, `<head$1>${brandHead(req)}`);
}

function isHtmlBody(body, res) {
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) return false;
  const type = String(res.getHeader('content-type') || '').toLowerCase();
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;

  return /<html[\s>]|<head[\s>]/i.test(text) && (!type || type.includes('text/html'));
}

export function mountLinkRayBrandRoutes(app) {
  app.use('/brand', express.static(brandDir, {
    maxAge: '30d',
    etag: true,
    immutable: true,
  }));

  const sendLogo = (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.type('png');
    return res.sendFile(logoFile);
  };

  app.get('/favicon.ico', sendLogo);
  app.get('/favicon.png', sendLogo);
  app.get('/apple-touch-icon.png', sendLogo);
  app.get('/analytics/logo.webp', sendLogo);
  app.get('/logo', sendLogo);
  app.get('/linkray/logo', sendLogo);
  app.get('/api/linkray/logo', sendLogo);
  app.get('/api/brand/logo', sendLogo);

  app.get('/api/linkray/brand', (req, res) => {
    const logo = absoluteLogo(req);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      name: 'LinkRay',
      title: 'LinkRay',
      logo,
      favicon: logo,
      appleTouchIcon: logo,
    });
  });

  app.use((req, res, next) => {
    const originalSend = res.send.bind(res);
    const originalEnd = res.end.bind(res);

    res.send = function patchedSend(body) {
      if (isHtmlBody(body, res)) {
        res.removeHeader('content-length');
        const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
        return originalSend(injectBrand(text, req));
      }

      return originalSend(body);
    };

    res.end = function patchedEnd(chunk, encoding, cb) {
      if (!res.headersSent && isHtmlBody(chunk, res)) {
        res.removeHeader('content-length');
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
        return originalEnd(injectBrand(text, req), encoding, cb);
      }

      return originalEnd(chunk, encoding, cb);
    };

    next();
  });
}
