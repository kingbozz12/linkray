import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SITE_DIR = path.resolve(__dirname, '../public/linkray-site');
const INDEX_FILE = path.join(SITE_DIR, 'index.html');

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'linkray.ru')
    .split(',')[0]
    .trim();

  return `${proto}://${host}`;
}

function sendSiteIndex(_req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  return res.sendFile(INDEX_FILE);
}

export function mountLinkRayWebsiteRoutes(app) {
  if (!app || typeof app.get !== 'function' || typeof app.use !== 'function') {
    throw new TypeError('mountLinkRayWebsiteRoutes expects an Express application');
  }

  app.use(
    '/site-assets',
    express.static(SITE_DIR, {
      etag: true,
      maxAge: '7d',
      index: false,
      fallthrough: true,
    }),
  );

  app.get('/api/site/meta', (req, res) => {
    const baseUrl = publicBaseUrl(req);
    return res.json({
      ok: true,
      name: 'LinkRay',
      baseUrl,
      botLink: process.env.BOT_LINK || 'https://max.ru/se13353901_bot',
      logo: `${baseUrl}/brand/linkray-logo.webp`,
    });
  });

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(path.join(SITE_DIR, 'robots.txt'));
  });

  app.get('/sitemap.xml', (_req, res) => {
    res.type('application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(path.join(SITE_DIR, 'sitemap.xml'));
  });

  const publicPages = [
    '/',
    '/features',
    '/studio',
    '/analytics',
    '/antifraud',
    '/purchases',
    '/pricing',
    '/docs',
    '/privacy',
    '/terms',
  ];

  for (const route of publicPages) {
    app.get(route, sendSiteIndex);
  }

  console.log('[LinkRay site] public website routes mounted');
}
