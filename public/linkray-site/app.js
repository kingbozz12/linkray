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
