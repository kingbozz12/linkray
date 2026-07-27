const header = document.querySelector('[data-header]');
const navToggle = document.querySelector('[data-nav-toggle]');
const nav = document.querySelector('[data-nav]');

function closeNavigation() {
  if (!navToggle || !nav) return;
  navToggle.setAttribute('aria-expanded', 'false');
  nav.classList.remove('is-open');
}

navToggle?.addEventListener('click', () => {
  const next = navToggle.getAttribute('aria-expanded') !== 'true';
  navToggle.setAttribute('aria-expanded', String(next));
  nav?.classList.toggle('is-open', next);
});

nav?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', closeNavigation);
});

function updateHeader() {
  header?.classList.toggle('is-scrolled', window.scrollY > 20);
}
updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });

const revealObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -30px' })
  : null;

document.querySelectorAll('.reveal').forEach((element) => {
  if (revealObserver) revealObserver.observe(element);
  else element.classList.add('is-visible');
});

const demoTabs = [...document.querySelectorAll('[data-demo-tab]')];
const demoPanels = [...document.querySelectorAll('[data-demo-panel]')];

demoTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.demoTab;
    demoTabs.forEach((item) => {
      const active = item === tab;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    demoPanels.forEach((panel) => {
      panel.classList.toggle('is-active', panel.dataset.demoPanel === target);
    });
  });
});

function animateNumber(element) {
  const target = Number(element.dataset.count || 0);
  const prefix = element.dataset.prefix || '';
  const grouped = element.dataset.grouped === 'true';
  const duration = 850;
  const started = performance.now();

  function frame(now) {
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(target * eased);
    element.textContent = prefix + (grouped ? new Intl.NumberFormat('ru-RU').format(value) : value);
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

const counterObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        animateNumber(entry.target);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.65 })
  : null;

document.querySelectorAll('[data-count]').forEach((element) => {
  if (counterObserver) counterObserver.observe(element);
  else animateNumber(element);
});

const sections = [...document.querySelectorAll('section[id]')];
const navLinks = [...document.querySelectorAll('.main-nav a[href^="#"]')];

if ('IntersectionObserver' in window && sections.length) {
  const sectionObserver = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    navLinks.forEach((link) => {
      link.classList.toggle('is-active', link.getAttribute('href') === `#${visible.target.id}`);
    });
  }, { rootMargin: '-30% 0px -55%', threshold: [0.05, 0.2, 0.5] });
  sections.forEach((section) => sectionObserver.observe(section));
}

const pathToSection = {
  '/features': 'capabilities',
  '/studio': 'studio',
  '/analytics': 'analytics',
  '/antifraud': 'antifraud',
  '/purchases': 'purchases',
  '/docs': 'faq',
};

const initialSection = pathToSection[window.location.pathname.replace(/\/+$/, '') || '/'];
if (initialSection) {
  requestAnimationFrame(() => {
    document.getElementById(initialSection)?.scrollIntoView({ block: 'start' });
  });
}

fetch('/api/site/meta', { headers: { Accept: 'application/json' } })
  .then((response) => response.ok ? response.json() : null)
  .then((meta) => {
    if (!meta?.botLink) return;
    document.querySelectorAll('[data-bot-link]').forEach((link) => {
      link.setAttribute('href', meta.botLink);
    });
  })
  .catch(() => {});
