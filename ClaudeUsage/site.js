/* Shared page behaviour for the landing page and the What's New page. Every block checks that
   its elements exist, so each page gets only what it has. */
    (function () {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------- Latest blog posts (newest three) ---------- */
    const latest = document.getElementById('latestPosts');
    // translated pages live one folder down (<html data-root="../">, i18n/build.py)
    const root = document.documentElement.dataset.root || '';
    if (latest && typeof BLOG_POSTS !== 'undefined') latest.innerHTML = BLOG_POSTS.slice(0, 3).map((p) => renderPostCard(p, root + 'blog/')).join('');

    /* ---------- iOS visitors: lead with the iOS listing ----------
       The Mac CTAs carry ?mt=12, which forces the Mac App Store and is a dead end
       from a phone. Both apps share one App Store ID (universal purchase), so
       dropping the parameter lands iOS visitors on the right listing.
       Touch-capable "Mac" UAs are iPadOS, which reports itself as a Mac. */
    (function platformCTA() {
        const ua = navigator.userAgent;
        const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1);
        if (!isIOS) return;
        document.querySelectorAll('.cta-label').forEach((el) => { el.textContent = 'Get the app'; });
        document.querySelectorAll('.cta-label-ios').forEach((el) => { el.textContent = 'Also on the Mac'; });
        document.querySelectorAll('a[href*="id6755173244"]').forEach((a) => {
            a.href = a.href.replace(/[?&]mt=12\b/, '');
        });
    })();

    /* ---------- The page is "in" right away, or once build.js finishes the opening ---------- */
    const whenSiteIn = (fn) => {
        const html = document.documentElement;
        if (document.body.classList.contains('site-in') || !(html.classList.contains('build') || html.classList.contains('ios-build'))) fn();
        else document.addEventListener('site:in', fn, { once: true });
    };


    /* ---------- Remember where the page was left, so a reload that lands mid-page skips the build ---------- */
    window.addEventListener('pagehide', () => { try { sessionStorage.setItem('scrollY', String(Math.round(window.scrollY))); } catch (e) {} });

    /* ---------- iPhone build-in: the clay field, the phone rises, the widget lands, then the words ---------- */
    (function iosBuild() {
        const html = document.documentElement;
        if (!html.classList.contains('ios-build')) return;
        const go = () => {
            requestAnimationFrame(() => html.classList.add('go'));
            setTimeout(() => {
                html.classList.remove('ios-build', 'go');
                document.body.classList.add('site-in');
                document.dispatchEvent(new CustomEvent('site:in'));
            }, 2700);
        };
        const fonts = document.fonts && document.fonts.load ? Promise.all([document.fonts.load('900 100px "Archivo"'), document.fonts.load('500 100px "Archivo"')]) : Promise.resolve();
        fonts.catch(() => {}).then(go);
    })();

    /* ---------- iPhone-first view: a desktop window resized narrow switches with it (iOS devices always have it) ---------- */
    (function platformView() {
        const html = document.documentElement;
        if (html.classList.contains('ios-device') || !window.matchMedia) return;
        const mq = window.matchMedia('(max-width: 900px)');
        const apply = () => html.classList.toggle('ios-view', mq.matches);
        if (mq.addEventListener) mq.addEventListener('change', apply); else mq.addListener(apply);
    })();

    /* ---------- Translated pages: a headline whose longest word is wider than its box steps down in size until it fits ---------- */
    (function fitTranslatedHeadlines() {
        if ((document.documentElement.lang || 'en') === 'en') return;
        const fit = () => document.querySelectorAll('.hl').forEach((el) => {
            el.style.fontSize = '';
            if (!el.offsetParent) return;
            let size = parseFloat(getComputedStyle(el).fontSize);
            const floor = size * 0.7;
            while (el.scrollWidth > el.clientWidth + 1 && size > floor) {
                size *= 0.95;
                el.style.fontSize = size + 'px';
            }
        });
        let t;
        const later = () => { clearTimeout(t); t = setTimeout(fit, 150); };
        (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(fit);
        window.addEventListener('resize', later);
    })();

    /* ---------- Menu bar clocks: the visitor's day and time, in macOS's own format ("Fri Oct 9 9:41") ---------- */
    (function menuBarClock() {
        const clocks = () => document.querySelectorAll('.bar-clock');
        if (!clocks().length && !document.querySelector('.live-time')) return;
        const h12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle !== 'h23';
        const tick = () => {
            const d = new Date();
            const day = d.toLocaleDateString('en-US', { weekday: 'short' });
            const mon = d.toLocaleDateString('en-US', { month: 'short' });
            const h = d.getHours();
            const hh = h12 ? (h % 12 || 12) : String(h).padStart(2, '0');
            const text = `${day} ${mon} ${d.getDate()} ${hh}:${String(d.getMinutes()).padStart(2, '0')}`;
            clocks().forEach((el) => { if (el.textContent !== text) el.textContent = text; });
            // the iPhone Lock Screen and Home Screen in the iPhone view
            const time = `${hh}:${String(d.getMinutes()).padStart(2, '0')}`;
            // the menu bar screenshots are English, so their clock is too; the Lock Screen speaks the page's language
            const date = d.toLocaleDateString(document.documentElement.lang || 'en-US', { weekday: 'long', month: 'long', day: 'numeric' });
            document.querySelectorAll('.live-time').forEach((el) => { el.textContent = time; });
            document.querySelectorAll('.live-date').forEach((el) => { el.textContent = date; });
        };
        // each clock is laid out at the screenshot's 2880 px width and scaled to its bar
        const fit = (el) => { const w = el.parentElement.clientWidth; if (w) el.style.setProperty('--bar-k', w / 2880); };
        if ('ResizeObserver' in window) {
            const ro = new ResizeObserver((entries) => entries.forEach((e) => { const c = e.target.querySelector(':scope > .bar-clock'); if (c) fit(c); }));
            clocks().forEach((c) => ro.observe(c.parentElement));
        } else { clocks().forEach(fit); window.addEventListener('resize', () => clocks().forEach(fit)); }
        tick();
        setTimeout(() => { tick(); setInterval(tick, 60000); }, (60 - new Date().getSeconds()) * 1000 + 50);
    })();

    /* ---------- The "4" as an activity grid (the app's What's New opener) ---------- */
    (function activityGrid() {
        const canvas = document.getElementById('wnGrid');
        if (!canvas || !canvas.getContext) return;
        const ctx = canvas.getContext('2d');
        const COLS = 19, ROWS = 11, GX = 6, GY = 1, LOOP = 8.5;
        const glyph = ['....##.', '...###.', '..#.##.', '.#..##.', '#...##.', '#######', '....##.', '....##.', '....##.'];
        const hash = (i, k) => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
        const cells = [];
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
            const i = r * COLS + c, gr = r - GY, gc = c - GX;
            const inFour = gr >= 0 && gr < glyph.length && gc >= 0 && gc < 7 && glyph[gr][gc] === '#';
            const h1 = hash(i, 1), h2 = hash(i, 2), h3 = hash(i, 3);
            let a = h1 < 0.22 ? 0 : 0.1 + 0.62 * h2 * h2;
            if (inFour) a = 0.18 + 0.5 * h2;
            const b = inFour ? 0.9 + 0.1 * h3 : a * 0.28;
            const d1 = 0.15 + c * 0.055 + h3 * 0.14;
            const d2 = inFour ? 2.35 + gr * 0.055 + Math.abs(c - 9) * 0.025 + h1 * 0.05 : 2.25 + h2 * 0.3;
            cells.push({ r, c, a, b, d0: d1 - 0.05, d1, d2, dur: inFour ? 0.8 : 1.1 });
        }
        const easeOut = (t) => 1 - Math.pow(1 - t, 3);
        const easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const clamp01 = (t) => Math.max(0, Math.min(1, t));
        const heat = [222, 115, 86];

        let w = 0, h = 0, dpr = 1;
        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            dpr = Math.min(2, window.devicePixelRatio || 1);
            w = Math.round(rect.width); h = Math.round(rect.width * 11 / 19);
            canvas.width = w * dpr; canvas.height = h * dpr;
            canvas.style.height = h + 'px';
        };
        const draw = (t) => {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const gap = w / (COLS * 5.2);
            const pitch = (w - gap * (COLS - 1)) / COLS;
            const radius = pitch * 0.24;
            const rr = (x, y, s, r) => { ctx.beginPath(); ctx.roundRect(x, y, s, s, r); ctx.fill(); };
            for (const cell of cells) {
                const inT = clamp01((t - cell.d0) / 0.6);
                if (inT <= 0) continue;
                const s = pitch * (0.5 + 0.5 * easeOut(inT));
                const x = cell.c * (pitch + gap) + (pitch - s) / 2;
                const y = cell.r * (pitch + gap) + (pitch - s) / 2;
                ctx.globalAlpha = easeOut(inT);
                ctx.fillStyle = 'rgba(243,236,228,0.06)';
                rr(x, y, s, radius);
                let o;
                if (t < cell.d1) o = 0;
                else if (t < cell.d1 + 0.55) o = cell.a * easeOut((t - cell.d1) / 0.55);
                else if (t < cell.d2) o = cell.a;
                else if (t < cell.d2 + cell.dur) o = cell.a + (cell.b - cell.a) * easeInOut((t - cell.d2) / cell.dur);
                else o = cell.b;
                if (o > 0) {
                    ctx.globalAlpha = o * easeOut(inT);
                    ctx.fillStyle = 'rgb(' + heat.join(',') + ')';
                    rr(x, y, s, radius);
                }
            }
            ctx.globalAlpha = 1;
        };
        // plays once, the first time it scrolls into view, then holds the finished "4"
        const END = 4.0; // every cell has landed by then
        let raf = 0, t0 = 0, running = false, done = false, inView = false;
        const frame = (now) => {
            if (!t0) t0 = now;
            const t = (now - t0) / 1000;
            if (t >= END) { draw(END); running = false; done = true; return; }
            draw(t);
            if (running) raf = requestAnimationFrame(frame);
        };
        const start = () => { if (running || done) return; running = true; t0 = 0; raf = requestAnimationFrame(frame); };
        const stop = () => { running = false; cancelAnimationFrame(raf); };
        resize();
        if (reduce || !('IntersectionObserver' in window)) { done = true; draw(END); }
        else {
            const io = new IntersectionObserver(([e]) => { inView = e.isIntersecting; if (inView) start(); }, { threshold: 0.25 });
            io.observe(canvas);
        }
        window.addEventListener('resize', () => { resize(); if (!running) draw(done ? END : 0); });
        document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (inView) start(); });
    })();

    /* ---------- View styles: the spotlight moves on its own until you point at one ---------- */
    (function viewStyles() {
        const root = document.getElementById('styles');
        if (!root) return;
        const items = [...root.querySelectorAll('.style')];
        let i = 1, timer = null, pinned = false, inView = false;
        const set = (k) => { i = k; items.forEach((el, n) => el.setAttribute('aria-current', n === k ? 'true' : 'false')); };
        const schedule = () => {
            clearTimeout(timer);
            if (reduce || pinned || !inView) return;
            timer = setTimeout(() => { set((i + 1) % items.length); schedule(); }, 2600);
        };
        items.forEach((el, k) => {
            el.addEventListener('mouseenter', () => { pinned = true; set(k); clearTimeout(timer); });
            el.addEventListener('focus', () => { pinned = true; set(k); clearTimeout(timer); });
            el.addEventListener('click', () => { pinned = true; set(k); clearTimeout(timer); });
        });
        root.addEventListener('mouseleave', () => { pinned = false; schedule(); });
        if ('IntersectionObserver' in window) {
            new IntersectionObserver(([e]) => { inView = e.isIntersecting; if (inView) schedule(); else clearTimeout(timer); }, { threshold: 0.3 }).observe(root);
        }
    })();

    /* ---------- Bento: tiles grow in once, keynote-style, when the grid scrolls into view ---------- */
    (function bento() {
        const grid = document.getElementById('bento');
        if (!grid) return;
        if (reduce || !('IntersectionObserver' in window)) { grid.classList.add('in'); return; }
        new IntersectionObserver(([e], io) => { if (e.isIntersecting) { grid.classList.add('in'); io.disconnect(); } }, { threshold: 0.2 }).observe(grid);
    })();

    /* ---------- FAQ accordion: the page ships it as static HTML; this renders it from the FAQPage JSON-LD only if the list is empty ---------- */
    const faqData = document.getElementById('faqData');
    const FAQ = faqData ? JSON.parse(faqData.textContent).mainEntity.map((q) => [q.name, q.acceptedAnswer.text]) : [];
    (function renderFAQ() {
        const list = document.getElementById('faqList');
        if (!list || list.children.length) return;
        list.innerHTML = FAQ.map(([q, a], i) => `
            <details class="faq-item"${i === 0 ? ' open' : ''}>
                <summary>${q}<span class="q-mark"></span></summary>
                <div class="faq-body">${a}</div>
            </details>`).join('');
    })();
    (function animatedFAQ() {
        document.querySelectorAll('.faq-item').forEach((item) => {
            const summary = item.querySelector('summary');
            const body = item.querySelector('.faq-body');
            summary.addEventListener('click', (e) => {
                e.preventDefault();
                if (reduce) { item.open = !item.open; return; }
                if (body.dataset.animating) return;
                if (item.open) {
                    body.dataset.animating = '1';
                    body.classList.add('is-animating');
                    body.style.height = body.scrollHeight + 'px';
                    body.style.paddingBottom = getComputedStyle(body).paddingBottom;
                    void body.offsetHeight;
                    requestAnimationFrame(() => { body.style.height = '0px'; body.style.paddingBottom = '0px'; });
                    body.addEventListener('transitionend', function done(ev) {
                        if (ev.propertyName !== 'height') return;
                        item.open = false;
                        body.style.height = ''; body.style.paddingBottom = '';
                        body.classList.remove('is-animating');
                        delete body.dataset.animating;
                        body.removeEventListener('transitionend', done);
                    });
                } else {
                    item.open = true;
                    body.dataset.animating = '1';
                    body.classList.add('is-animating');
                    const endPad = getComputedStyle(body).paddingBottom;
                    const target = body.scrollHeight;
                    body.style.height = '0px'; body.style.paddingBottom = '0px';
                    void body.offsetHeight;
                    requestAnimationFrame(() => { body.style.height = target + 'px'; body.style.paddingBottom = endPad; });
                    body.addEventListener('transitionend', function done(ev) {
                        if (ev.propertyName !== 'height') return;
                        body.style.height = 'auto'; body.style.paddingBottom = '';
                        body.classList.remove('is-animating');
                        delete body.dataset.animating;
                        body.removeEventListener('transitionend', done);
                    });
                }
            });
        });
    })();

    /* ---------- Sticky header: appears once the hero on show is scrolled past (always on pages without one),
       so its "Get the Mac app" never sits on screen next to the hero's own download button ---------- */
    const header = document.getElementById('siteHeader');
    const heroes = [...document.querySelectorAll('.hv')];
    if (header && !heroes.length) header.classList.add('is-visible');
    if (header && heroes.length) {
        let ticking = false;
        const update = () => {
            ticking = false;
            const cur = heroes.find((h) => h.getClientRects().length);
            header.classList.toggle('is-visible', !!cur && cur.getBoundingClientRect().bottom < 0);
        };
        window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
        update();
    }

    /* ---------- Scroll reveals: section heads, cards, rows and fields rise in as they arrive ---------- */
    document.querySelectorAll('.wn-open, .styles, .chatgpt, .post-card, .faq-list, .closing .field').forEach((el) => el.classList.add('reveal'));
    document.querySelectorAll('.also-grid, .info-table, .post-grid').forEach((group) => {
        [...group.children].forEach((el, i) => { el.style.transitionDelay = (i % 3) * 90 + 'ms'; });
    });
    whenSiteIn(() => {
        if (reduce || !('IntersectionObserver' in window)) {
            document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
            return;
        }
        let first = 0;
        const io = new IntersectionObserver((entries) => {
            entries.forEach((e) => {
                if (!e.isIntersecting) return;
                // whatever is already on screen when the page comes in arrives one after another
                if (document.body.classList.contains('site-in-fresh')) { e.target.style.transitionDelay = (0.25 + first * 0.12) + 's'; first += 1; }
                e.target.classList.add('in'); io.unobserve(e.target);
            });
        }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });
        document.querySelectorAll('.reveal:not(.in)').forEach((el) => io.observe(el));
        setTimeout(() => document.body.classList.remove('site-in-fresh'), 1500);
    });
    })();
