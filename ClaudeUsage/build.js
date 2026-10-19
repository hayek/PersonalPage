/* The opening: the page builds itself. An empty Mac screen with only the menu bar, the pointer
   comes in and clicks the app's status item, the popover opens on three accounts with ChatGPT
   selected, the pointer picks the Claude account, then the screen becomes the hero's own Mac
   screen and the rest of the page fades and moves in.
   GSAP drives it; without it, or when the gate in the page head says no, the page is just there. */
(function () {
    'use strict';
    const root = document.documentElement;
    const desk = document.getElementById('desk');
    const siteIn = () => {
        document.body.classList.add('site-in');
        document.dispatchEvent(new CustomEvent('site:in'));
    };
    if (!desk || !root.classList.contains('build') || typeof gsap === 'undefined') {
        root.classList.remove('build');
        siteIn();
        return;
    }

    // the hero's Mac screen: the opening ends exactly on it
    const stage = [...document.querySelectorAll('.mac-stage')].find((el) => el.getClientRects().length > 0);
    if (!stage) { root.classList.remove('build'); siteIn(); return; }
    const hero = stage.closest('.hv');

    const $ = (s) => desk.querySelector(s);
    const bar = $('.desk-bar'), hl = $('.desk-hl'), pop = $('.desk-pop');
    const popChatGPT = $('.desk-pop-chatgpt'), popClaude = $('.desk-pop-claude');
    const cursor = $('.desk-cursor'), ripple = $('.desk-ripple');

    // the desk wears the stage's own wallpaper and menu bar
    const cs = getComputedStyle(stage);
    // Safari leaves the computed `background` shorthand empty, so copy its parts
    desk.style.backgroundColor = cs.backgroundColor;
    desk.style.backgroundImage = cs.backgroundImage;
    bar.src = stage.querySelector('.stage-bar').getAttribute('src');

    // geometry, as fractions of the screen width (see .mac-stage in landing.css): the real menu bar
    // is 2880 × 88, the app's status item is centred 828.5 px from its right edge, and the 326 px
    // popover's arrow sits at 53% of its width
    const BAR_K = 88 / 2880, ITEM_K = 828.5 / 2880, POP_W = 326, ARROW = 0.53;
    const vw = window.innerWidth, vh = window.innerHeight;
    const barH = vw * BAR_K;
    const itemX = vw * (1 - ITEM_K), itemY = barH / 2;
    const popRight = vw * ITEM_K - POP_W * ARROW;
    const popLeft = vw - popRight - POP_W;
    // the Personal card in the ChatGPT popover: its avatar row sits at 64.8% of the image's height
    const personal = { x: popLeft + POP_W * 0.36, y: barH + 449 * 0.648 };

    gsap.set(desk, { left: 0, top: 0, width: vw, height: vh, right: 'auto', bottom: 'auto', borderRadius: 0 });
    gsap.set(pop, { top: barH, right: popRight, y: -(barH + 600) }); // hidden above the bar until the click
    gsap.set(cursor, { x: vw * 0.55, y: vh * 0.62, opacity: 0 });

    const tl = gsap.timeline({ paused: true });
    const click = (at, x, y, glide) => {
        tl.to(cursor, { x, y, duration: glide, ease: 'power2.inOut' }, at - glide - 0.05);
        tl.to(cursor, { scale: 0.84, duration: 0.07, ease: 'power2.in', transformOrigin: '0 0' }, at);
        tl.to(cursor, { scale: 1, duration: 0.18, ease: 'back.out(2.4)' }, at + 0.07);
        tl.set(ripple, { left: x, top: y }, at - 0.01);
        tl.fromTo(ripple, { opacity: 0.9, scale: 0.4 }, { opacity: 0, scale: 1.6, duration: 0.45, ease: 'power2.out' }, at);
    };

    // 1. the pointer appears, finds the status item and clicks it; the popover opens on ChatGPT
    tl.to(cursor, { opacity: 1, duration: 0.3 }, 0.5);
    click(2.0, itemX - 6, itemY + 6, 1.0);
    tl.to(hl, { opacity: 1, duration: 0.08 }, 2.0);
    tl.to(pop, { y: 0, duration: 0.7, ease: 'expo.out' }, 2.05);

    // 2. the pointer picks the Claude account; the popover switches to it
    click(3.6, personal.x, personal.y, 0.75);
    tl.to(pop, { scale: 0.99, duration: 0.08, ease: 'power2.in', transformOrigin: '53% 0%' }, 3.6);
    tl.to(pop, { scale: 1, duration: 0.25, ease: 'back.out(2.6)' }, 3.68);
    tl.to(popChatGPT, { opacity: 0, duration: 0.22 }, 3.66);
    tl.to(popClaude, { opacity: 1, duration: 0.22 }, 3.66);
    tl.to(cursor, { x: personal.x - 320, y: personal.y + 260, opacity: 0, duration: 0.7, ease: 'power2.in' }, 4.2);

    // 3. the screen becomes the hero's Mac screen; bar, highlight and popover land where the stage draws them
    const T = 4.75, D = 1.05, E = 'power3.inOut';
    tl.call(() => {
        const r = stage.getBoundingClientRect();
        const same = Math.abs(r.width - vw) < 2 && Math.abs(r.top) < 2 && Math.abs(r.left) < 2;
        const radius = parseFloat(cs.borderTopLeftRadius) || 0;
        const d = same ? 0.35 : D;
        gsap.to(desk, { left: r.left, top: r.top, width: r.width, height: r.height, borderRadius: radius, duration: d, ease: E });
        const pw = Math.min(POP_W, r.width * 0.54); // matches --pw on .mac-stage
        gsap.to(pop, { top: r.width * BAR_K, right: r.width * ITEM_K - pw * ARROW, width: pw, duration: d, ease: E, onComplete: finish });
    }, null, T);

    // 4. the page assembles around it
    let done = false;
    function finish() {
        if (done) return;
        done = true;
        tl.kill();
        gsap.killTweensOf([desk, pop]);
        const parts = [
            ...document.querySelectorAll('.store-head .app-icon, .store-head .app-title, .store-head .get-col'),
            ...(hero ? hero.querySelectorAll('.hero-copy > *') : [])
        ];
        const extras = hero ? [...hero.querySelectorAll('.stage-extra')] : [];
        gsap.set(parts, { opacity: 0, y: 16 });
        gsap.set(extras, { opacity: 0, y: 40 });
        root.classList.remove('build');
        desk.remove();
        document.body.classList.add('site-in-fresh');
        siteIn();
        gsap.to(parts, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out', stagger: 0.07, delay: 0.05, clearProps: 'transform,opacity' });
        gsap.to(extras, { opacity: 1, y: 0, duration: 0.9, ease: 'back.out(1.4)', stagger: 0.15, delay: 0.35, clearProps: 'transform,opacity' });
    }

    document.getElementById('deskSkip').addEventListener('click', finish);
    desk.addEventListener('click', (e) => { if (!e.target.closest('#deskSkip')) finish(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(); }, { once: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) tl.pause(); else if (!done) tl.play(); });

    const faces = ['900 100px "Archivo"', '500 100px "Archivo"'];
    Promise.all(faces.map((f) => document.fonts.load(f))).catch(() => {}).then(() => {
        window.scrollTo(0, 0);
        window.__build = tl;
        tl.play();
    });
})();
