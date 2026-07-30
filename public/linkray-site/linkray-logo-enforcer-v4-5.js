(() => {
  'use strict';

  const EXACT_LOGO =
    '/linkray-site/linkray-logo-exact.webp?v=lr-logo-v4-5-1ac20ba95b';

  const BRAND_WORDS =
    /(linkray|brand|branding|logo|logotype|site[-_ ]?mark|product[-_ ]?mark)/i;

  const ICON_WORDS =
    /(logo|mark|icon|emblem|symbol|badge|avatar|brand)/i;

  const EXCLUDED_WORDS =
    /(menu|hamburger|toggle|close|cross|arrow|back|up|down|chevron|chart|graph|feature|check|plus|minus|button)/i;

  function text(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function marker(element) {
    if (!element || !element.getAttribute) return '';

    const className =
      typeof element.className === 'string'
        ? element.className
        : element.className?.baseVal || '';

    return text([
      element.tagName,
      element.id,
      className,
      element.getAttribute('alt'),
      element.getAttribute('title'),
      element.getAttribute('aria-label'),
      element.getAttribute('data-role'),
      element.getAttribute('data-testid'),
    ].filter(Boolean).join(' ')).toLowerCase();
  }

  function dimensions(element) {
    let width = 0;
    let height = 0;

    try {
      const rect = element.getBoundingClientRect();
      width = Number(rect.width) || 0;
      height = Number(rect.height) || 0;
    } catch (_) {}

    width =
      width ||
      Number(element.getAttribute?.('width')) ||
      Number(element.width) ||
      0;

    height =
      height ||
      Number(element.getAttribute?.('height')) ||
      Number(element.height) ||
      0;

    return { width, height };
  }

  function isSmallGraphic(element) {
    const { width, height } = dimensions(element);

    if (!width && !height) return true;
    return width <= 260 && height <= 220;
  }

  function hasLinkRayContext(element) {
    let node = element;

    for (let depth = 0; node && depth < 5; depth += 1) {
      const ownMarker = marker(node);
      const ownText = text(node.textContent).toLowerCase();

      if (
        BRAND_WORDS.test(ownMarker) ||
        ownText === 'linkray' ||
        ownText.startsWith('linkray ') ||
        ownText.includes(' linkray')
      ) {
        return true;
      }

      node = node.parentElement;
    }

    return false;
  }

  function isExcluded(element) {
    return EXCLUDED_WORDS.test(marker(element));
  }

  function exactImage(className = '') {
    const image = document.createElement('img');
    image.src = EXACT_LOGO;
    image.alt = 'Логотип LinkRay';
    image.setAttribute('data-lr-exact-logo', '1');
    image.className = text(`${className} lr-exact-logo-v4-5`);
    return image;
  }

  function enforceImage(image) {
    if (!image || isExcluded(image) || !isSmallGraphic(image)) return;

    const source = text(
      image.currentSrc ||
      image.getAttribute('src') ||
      image.getAttribute('data-src')
    );

    const shouldReplace =
      hasLinkRayContext(image) ||
      BRAND_WORDS.test(marker(image)) ||
      /(?:linkray|logo|brand|favicon)/i.test(source);

    if (!shouldReplace) return;

    if (!source.includes('linkray-logo-exact.webp')) {
      image.setAttribute('src', EXACT_LOGO);
    }

    image.removeAttribute('srcset');
    image.removeAttribute('data-src');
    image.removeAttribute('loading');
    image.setAttribute('data-lr-exact-logo', '1');
    image.classList.add('lr-exact-logo-v4-5');

    if (!image.getAttribute('alt')) {
      image.setAttribute('alt', 'Логотип LinkRay');
    }
  }

  function enforcePicture(picture) {
    if (!picture || isExcluded(picture) || !hasLinkRayContext(picture)) return;
    if (!isSmallGraphic(picture)) return;

    picture.querySelectorAll('source').forEach((source) => {
      source.setAttribute('srcset', EXACT_LOGO);
    });

    picture.querySelectorAll('img').forEach(enforceImage);
  }

  function replaceSvg(svg) {
    if (!svg || isExcluded(svg) || !isSmallGraphic(svg)) return;

    const shouldReplace =
      hasLinkRayContext(svg) ||
      BRAND_WORDS.test(marker(svg));

    if (!shouldReplace) return;

    const className =
      typeof svg.className === 'string'
        ? svg.className
        : svg.className?.baseVal || '';

    const image = exactImage(className);

    for (const attribute of ['width', 'height', 'style']) {
      const value = svg.getAttribute(attribute);
      if (value) image.setAttribute(attribute, value);
    }

    svg.replaceWith(image);
  }

  function explicitLogoElement(element) {
    const ownMarker = marker(element);

    if (
      isExcluded(element) ||
      !ICON_WORDS.test(ownMarker) ||
      !BRAND_WORDS.test(ownMarker) ||
      !isSmallGraphic(element)
    ) {
      return;
    }

    const tag = String(element.tagName || '').toLowerCase();

    if (tag === 'img') {
      enforceImage(element);
      return;
    }

    if (tag === 'svg') {
      replaceSvg(element);
      return;
    }

    const ownText = text(element.textContent);
    if (ownText && ownText.toLowerCase() !== 'linkray') {
      const childrenText = Array.from(element.children || [])
        .map((child) => text(child.textContent))
        .join('');

      if (childrenText.length > 3) return;
    }

    element.classList.add('lr-exact-logo-background-v4-5');
    element.style.setProperty(
      'background-image',
      `url("${EXACT_LOGO}")`,
      'important'
    );
    element.style.setProperty('background-size', 'cover', 'important');
    element.style.setProperty('background-position', 'center', 'important');
    element.style.setProperty('background-repeat', 'no-repeat', 'important');
    element.style.setProperty('-webkit-mask', 'none', 'important');
    element.style.setProperty('mask', 'none', 'important');

    element.querySelectorAll(':scope > svg, :scope > picture, :scope > canvas')
      .forEach((child) => child.remove());

    element.querySelectorAll(':scope > img').forEach(enforceImage);
  }

  function replaceHeaderFooterGraphics(root) {
    root.querySelectorAll('header svg, footer svg').forEach((svg) => {
      if (
        hasLinkRayContext(svg) &&
        !isExcluded(svg) &&
        isSmallGraphic(svg)
      ) {
        replaceSvg(svg);
      }
    });

    root.querySelectorAll('header img, footer img').forEach((image) => {
      if (
        hasLinkRayContext(image) &&
        !isExcluded(image) &&
        isSmallGraphic(image)
      ) {
        enforceImage(image);
      }
    });
  }

  function apply(root = document) {
    if (!root || !root.querySelectorAll) return;

    root.querySelectorAll('img').forEach(enforceImage);
    root.querySelectorAll('picture').forEach(enforcePicture);

    root.querySelectorAll(
      '[class*="brand"],[id*="brand"],' +
      '[class*="logo"],[id*="logo"],' +
      '[class*="mark"],[id*="mark"],' +
      '[class*="emblem"],[id*="emblem"]'
    ).forEach(explicitLogoElement);

    root.querySelectorAll(
      '[class*="brand"] svg,[id*="brand"] svg,' +
      '[class*="logo"] svg,[id*="logo"] svg,' +
      '[class*="mark"] svg,[id*="mark"] svg'
    ).forEach(replaceSvg);

    replaceHeaderFooterGraphics(root);
  }

  let pending = false;

  function schedule() {
    if (pending) return;
    pending = true;

    requestAnimationFrame(() => {
      pending = false;
      apply(document);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule, { once: true });
  } else {
    schedule();
  }

  window.addEventListener('load', schedule, { once: true });

  setTimeout(schedule, 100);
  setTimeout(schedule, 500);
  setTimeout(schedule, 1500);

  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'src',
      'srcset',
      'class',
      'id',
      'style',
      'data-src',
    ],
  });
})();
