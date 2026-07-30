import { installLinkRayWebCabinet } from './linkrayWebCabinet.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const siteRoot = path.resolve(__dirname, '../public/linkray-site');

function applyWebsiteHeaders(_req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=()'
    );
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "img-src 'self' data:",
            "style-src 'self'",
            "script-src 'self'",
            "connect-src 'self'",
            "font-src 'self'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ].join('; ')
    );
    next();
}

function sendSiteFile(res, filename, cacheControl = 'no-cache') {
    res.setHeader('Cache-Control', cacheControl);
    return res.sendFile(path.join(siteRoot, filename));
}

export function mountLinkRayWebsiteRoutes(app) {
  installLinkRayWebCabinet(app);
    if (!app || typeof app.use !== 'function' || typeof app.get !== 'function') {
        throw new TypeError('LinkRay website requires an Express application');
    }

    app.use('/linkray-site', applyWebsiteHeaders);

    app.use(
        '/linkray-site',
        express.static(siteRoot, {
            fallthrough: false,
            index: false,
            maxAge: '7d',
            setHeaders(res, filename) {
                if (filename.endsWith('.html')) {
                    res.setHeader('Cache-Control', 'no-cache');
                }
            },
        })
    );

    
// LINKRAY_STATIC_SITE_MIDDLEWARE
app.use(express.static(`${process.cwd()}/public/linkray-site`, { index: false, maxAge: '1h', extensions: ['html'] }));

app.get('/', applyWebsiteHeaders, (_req, res) => {
        sendSiteFile(res, 'index.html');
    });

    app.get('/robots.txt', applyWebsiteHeaders, (_req, res) => {
        sendSiteFile(res, 'robots.txt', 'public, max-age=3600');
    });

    app.get('/sitemap.xml', applyWebsiteHeaders, (_req, res) => {
        sendSiteFile(res, 'sitemap.xml', 'public, max-age=3600');
    });

    app.get('/site.webmanifest', applyWebsiteHeaders, (_req, res) => {
        sendSiteFile(res, 'site.webmanifest', 'public, max-age=86400');
    });

    app.get('/go-bot', (_req, res) => {
        const target = String(
            process.env.LINKRAY_BOT_URL ||
            process.env.MAX_BOT_URL ||
            'https://max.ru'
        ).trim();

        res.redirect(302, target);
    });

    app.get('/api/website/status', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            ok: true,
            service: 'linkray-website',
            version: 'production-v1',
        });
    });

    console.log('[LinkRay Website] production-v1 routes mounted');
}
