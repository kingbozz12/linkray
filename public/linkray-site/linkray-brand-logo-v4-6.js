(() => {
  'use strict';

  const EXACT_LOGO =
    '/linkray-site/linkray-logo-exact.webp?v=lr-brand-v4-6-1ac20ba95b';

  const OLD_BACKGROUND_CLASS = 'lr-exact-logo-background-v4-5';
  const OLD_IMAGE_CLASS = 'lr-exact-logo-v4-5';
  const NEW_IMAGE_CLASS = 'lr-brand-logo-v4-6';
  const NEW_ROOT_CLASS = 'lr-brand-root-v4-6';

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function directText(element) {
    if (!element) return '';

    return normalize(
      Array.from(element.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '')
        .join(' ')
    );
  }

  function elementMarker(element) {
    if (!element || !element.getAttribute) return '';

    const className =
      typeof element.className === 'string'
        ? element.className
        : element.className?.baseVal || '';

    return normalize([
      element.tagName,
      element.id,
      className,
      element.getAttribute('alt'),
      element.getAttribute('title'),
      element.getAttribute('aria-label'),
      element.getAttribute('src'),
    ].filter(Boolean).join(' ')).toLowerCase();
  }

  function isMenuGraphic(element) {
    return /(menu|hamburger|burger|toggle|close|cross|chevron)/i.test(
      elementMarker(element)
    );
  }

  function containsLinkRayLabel(element) {
    if (!element) return false;

    const own = directText(element);
    const whole = normalize(element.textContent);

    return (
      /^linkray$/i.test(own) ||
      /^linkray$/i.test(whole) ||
      /\blinkray\b/i.test(own)
    );
  }

  function findBrandLabel(section) {
    if (!section) return null;

    const elements = Array.from(section.querySelectorAll('*'));

    return (
      elements.find((element) => /^linkray$/i.test(directText(element))) ||
      elements.find((element) => containsLinkRayLabel(element)) ||
      null
    );
  }

  function findBrandRoot(section, label) {
    if (!section || !label) return null;

    let current = label;

    for (let depth = 0; current && current !== section && depth < 5; depth += 1) {
      const graphics = Array.from(
        current.querySelectorAll('img, svg, picture')
      ).filter((element) => !isMenuGraphic(element));

      if (graphics.length > 0) {
        return current;
      }

      current = current.parentElement;
    }

    return label.parentElement || null;
  }

  function clearBrokenBackground(root) {
    if (!root) return;

    root.classList.remove(OLD_BACKGROUND_CLASS);
    root.classList.add(NEW_ROOT_CLASS);

    const backgroundImage = normalize(root.style.backgroundImage);

    if (
      /linkray-logo-exact|linkray-logo|brand|logo/i.test(backgroundImage)
    ) {
      root.style.removeProperty('background-image');
      root.style.removeProperty('background-position');
      root.style.removeProperty('background-size');
      root.style.removeProperty('background-repeat');
    }

    root.style.removeProperty('-webkit-mask');
    root.style.removeProperty('mask');
    root.style.removeProperty('-webkit-mask-image');
    root.style.removeProperty('mask-image');
  }

  function prepareImage(image) {
    image.setAttribute('src', EXACT_LOGO);
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    image.removeAttribute('data-src');
    image.removeAttribute('width');
    image.removeAttribute('height');
    image.removeAttribute('loading');

    image.setAttribute('alt', 'Логотип LinkRay');
    image.setAttribute('data-linkray-brand-logo', 'v4-6');

    image.classList.remove(OLD_IMAGE_CLASS);
    image.classList.add(NEW_IMAGE_CLASS);

    image.style.removeProperty('width');
    image.style.removeProperty('height');
    image.style.removeProperty('min-width');
    image.style.removeProperty('max-width');
    image.style.removeProperty('min-height');
    image.style.removeProperty('max-height');
    image.style.removeProperty('background-image');
    image.style.removeProperty('background-size');
    image.style.removeProperty('background-position');
    image.style.removeProperty('mask');
    image.style.removeProperty('-webkit-mask');

    return image;
  }

  function replaceSvg(svg) {
    const image = document.createElement('img');

    const className =
      typeof svg.className === 'string'
        ? svg.className
        : svg.className?.baseVal || '';

    image.className = className;
    prepareImage(image);
    svg.replaceWith(image);

    return image;
  }

  function convertGraphic(graphic) {
    if (!graphic || isMenuGraphic(graphic)) return null;

    const tag = String(graphic.tagName || '').toLowerCase();

    if (tag === 'img') {
      return prepareImage(graphic);
    }

    if (tag === 'svg') {
      return replaceSvg(graphic);
    }

    if (tag === 'picture') {
      graphic.querySelectorAll('source').forEach((source) => {
        source.remove();
      });

      const existingImage = graphic.querySelector('img');

      if (existingImage) {
        return prepareImage(existingImage);
      }

      const image = prepareImage(document.createElement('img'));
      graphic.appendChild(image);
      return image;
    }

    return null;
  }

  function applyToSection(section) {
    if (!section) return;

    const label = findBrandLabel(section);
    if (!label) return;

    const root = findBrandRoot(section, label);
    if (!root) return;

    clearBrokenBackground(root);

    let graphics = Array.from(
      root.querySelectorAll('img, svg, picture')
    ).filter((element) => !isMenuGraphic(element));

    if (graphics.length === 0) {
      const image = prepareImage(document.createElement('img'));
      root.insertBefore(image, root.firstChild);
      graphics = [image];
    }

    const primary = convertGraphic(graphics[0]);

    if (!primary) return;

    /*
     * Дубликаты внутри одного брендового блока удаляем.
     * Кнопка меню не затрагивается, потому что она исключена выше.
     */
    graphics.slice(1).forEach((graphic) => {
      if (graphic !== primary && graphic.isConnected) {
        graphic.remove();
      }
    });
  }

  function cleanOldRuntimeClasses() {
    document
      .querySelectorAll(`.${OLD_BACKGROUND_CLASS}`)
      .forEach((element) => {
        element.classList.remove(OLD_BACKGROUND_CLASS);

        const backgroundImage = normalize(element.style.backgroundImage);

        if (
          /linkray-logo-exact|linkray-logo|brand|logo/i.test(backgroundImage)
        ) {
          element.style.removeProperty('background-image');
          element.style.removeProperty('background-position');
          element.style.removeProperty('background-size');
          element.style.removeProperty('background-repeat');
        }
      });

    document
      .querySelectorAll(`img.${OLD_IMAGE_CLASS}`)
      .forEach((image) => {
        image.classList.remove(OLD_IMAGE_CLASS);
      });
  }

  function apply() {
    cleanOldRuntimeClasses();
    applyToSection(document.querySelector('header'));
    applyToSection(document.querySelector('footer'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }

  window.addEventListener('load', apply, { once: true });

  /*
   * Один повтор нужен только на случай, если основной app.js
   * дорисовывает шапку после DOMContentLoaded.
   */
  window.setTimeout(apply, 350);
})();
