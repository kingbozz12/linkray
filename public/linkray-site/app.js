(() => {
    'use strict';

    const body = document.body;
    const header = document.querySelector('[data-header]');
    const toggle = document.querySelector('[data-menu-toggle]');
    const nav = document.querySelector('[data-nav]');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const setHeaderState = () => {
        if (header) {
            header.classList.toggle('scrolled', window.scrollY > 12);
        }
    };

    const closeMenu = () => {
        if (!toggle || !nav) return;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Открыть меню');
        nav.classList.remove('open');
        body.classList.remove('menu-open');
    };

    if (toggle && nav) {
        toggle.addEventListener('click', () => {
            const nextOpen = toggle.getAttribute('aria-expanded') !== 'true';
            toggle.setAttribute('aria-expanded', String(nextOpen));
            toggle.setAttribute('aria-label', nextOpen ? 'Закрыть меню' : 'Открыть меню');
            nav.classList.toggle('open', nextOpen);
            body.classList.toggle('menu-open', nextOpen);
        });

        nav.querySelectorAll('a').forEach((link) => {
            link.addEventListener('click', closeMenu);
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeMenu();
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth > 820) closeMenu();
        }, { passive: true });
    }

    setHeaderState();
    window.addEventListener('scroll', setHeaderState, { passive: true });

    const revealItems = [...document.querySelectorAll('.reveal')];

    if (reducedMotion || !('IntersectionObserver' in window)) {
        revealItems.forEach((item) => item.classList.add('is-visible'));
    } else {
        const revealObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            });
        }, {
            rootMargin: '0px 0px -8% 0px',
            threshold: 0.12,
        });

        revealItems.forEach((item) => revealObserver.observe(item));
    }

    const year = document.querySelector('[data-year]');
    if (year) year.textContent = String(new Date().getFullYear());

    document.querySelectorAll('a[href^="#"]').forEach((link) => {
        link.addEventListener('click', (event) => {
            const selector = link.getAttribute('href');
            if (!selector || selector === '#') return;

            const target = document.querySelector(selector);
            if (!target) return;

            event.preventDefault();
            target.scrollIntoView({
                behavior: reducedMotion ? 'auto' : 'smooth',
                block: 'start',
            });

            history.replaceState(null, '', selector);
        });
    });
})();

/* LR_MOBILE_LAYOUT_FIX_V2_START */
(() => {
  const OFFICIAL_LOGO = '/linkray-site/linkray-logo-exact.webp?v=lr-logo-v4-2';
  const MOBILE_LIMIT = 760;
  let resizeTimer = null;

  function replaceBrandMarks() {
    const imageSelectors = [
      'header img',
      'nav img',
      '[class*="brand"] img',
      '[class*="logo"] img'
    ].join(',');

    document.querySelectorAll(imageSelectors).forEach((image) => {
      const alt = String(image.getAttribute('alt') || '');
      const src = String(image.getAttribute('src') || '');
      const className = String(image.className || '');
      const parentClass = String(image.parentElement?.className || '');

      if (
        /linkray|logo|brand/i.test(`${alt} ${src} ${className} ${parentClass}`)
      ) {
        image.setAttribute('src', OFFICIAL_LOGO);
        image.setAttribute('alt', 'LinkRay');
        image.decoding = 'async';
      }
    });

    const svgSelectors = [
      'header [class*="brand"] svg',
      'header [class*="logo"] svg',
      'nav [class*="brand"] svg',
      'nav [class*="logo"] svg'
    ].join(',');

    document.querySelectorAll(svgSelectors).forEach((svg) => {
      if (svg.closest('.lr-official-logo')) return;

      const image = document.createElement('img');
      image.src = OFFICIAL_LOGO;
      image.alt = 'LinkRay';
      image.className = 'lr-official-logo';
      image.decoding = 'async';
      svg.replaceWith(image);
    });
  }

  function findDashboardPreview() {
    const anchors = Array.from(document.querySelectorAll('body *')).filter(
      (element) =>
        element.children.length === 0 &&
        /app\.linkray\.ru/i.test(String(element.textContent || ''))
    );

    for (const anchor of anchors) {
      let node = anchor;
      while (node && node !== document.body) {
        const text = String(node.textContent || '');
        const dashboardTerms = [
          /обзор\s+канала/i,
          /публикац/i,
          /аналитик/i,
          /antifraud/i
        ].filter((pattern) => pattern.test(text)).length;

        if (dashboardTerms >= 3) {
          return node;
        }
        node = node.parentElement;
      }
    }

    return document.querySelector(
      '[class*="dashboard-preview"],' +
      '[class*="product-preview"],' +
      '[class*="browser-window"],' +
      '[class*="app-window"],' +
      '[class*="dashboard-mockup"]'
    );
  }

  function resetPreview(preview, host) {
    preview.style.removeProperty('width');
    preview.style.removeProperty('transform');
    preview.style.removeProperty('transform-origin');
    host.style.removeProperty('height');
  }

  function fitDashboardPreview() {
    const preview = findDashboardPreview();
    if (!preview || !preview.parentElement) return;

    const host = preview.parentElement;
    preview.classList.add('lr-fit-preview');
    host.classList.add('lr-fit-preview-host');

    resetPreview(preview, host);

    if (window.innerWidth > MOBILE_LIMIT) return;

    const hostWidth = Math.max(280, host.clientWidth);
    const measuredWidth = Math.max(
      preview.scrollWidth,
      Math.ceil(preview.getBoundingClientRect().width)
    );

    if (!measuredWidth || measuredWidth <= hostWidth + 2) return;

    const scale = Math.min(1, hostWidth / measuredWidth);

    preview.style.width = `${measuredWidth}px`;
    preview.style.transformOrigin = 'top left';
    preview.style.transform = `scale(${scale})`;

    requestAnimationFrame(() => {
      const height = Math.ceil(preview.scrollHeight * scale);
      host.style.height = `${height}px`;
    });
  }

  function markSafeMobileBlocks() {
    if (window.innerWidth > MOBILE_LIMIT) return;

    document
      .querySelectorAll(
        'main > section, main [class*="container"], main [class*="wrapper"]'
      )
      .forEach((element) => {
        element.style.maxWidth = '100%';
        element.style.minWidth = '0';
      });
  }

  function runMobileLayoutFix() {
    replaceBrandMarks();
    markSafeMobileBlocks();
    fitDashboardPreview();
  }

  function scheduleLayoutFix() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(runMobileLayoutFix, 90);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runMobileLayoutFix, {
      once: true
    });
  } else {
    runMobileLayoutFix();
  }

  window.addEventListener('resize', scheduleLayoutFix, { passive: true });
  window.addEventListener('orientationchange', scheduleLayoutFix, {
    passive: true
  });
  window.addEventListener('load', runMobileLayoutFix, { once: true });

  window.setTimeout(runMobileLayoutFix, 250);
  window.setTimeout(runMobileLayoutFix, 900);
})();
/* LR_MOBILE_LAYOUT_FIX_V2_END */
