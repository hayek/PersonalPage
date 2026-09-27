// The hero's demo board: two lines on their way to "your stop", on a clock that runs at six
// times real speed. As in the app, 18 runs straight to the stop and 41 swings in beside it for
// the last stops, which both lines share. Buses leave each terminus on a fixed headway, and the readout is read
// off the map itself.
(function () {
    const svg = document.getElementById('board-map');
    if (!svg) return;

    const NS = 'http://www.w3.org/2000/svg';
    const SPEED = 6;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // stations by height on the map: each line's own, then the ones both lines stop at
    const TRUNK_STATIONS = [322, 364];
    // trip and headway in seconds; firstArrival is when the page's first bus on that line arrives
    const LINES = [
        { id: '41', color: '#FFC300', d: 'M150 34 V170 C150 240 278 220 278 290 V420', trip: 14 * 60, headway: 9 * 60, firstArrival: 2 * 60 + 20, stations: [84, 134] },
        { id: '18', color: '#FF3B3F', d: 'M290 34 V420', trip: 16 * 60, headway: 11 * 60, firstArrival: 8 * 60 + 30, stations: [84, 134, 184, 234] },
    ];

    const el = (name, attrs, parent) => {
        const node = document.createElementNS(NS, name);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(node);
        return node;
    };

    const rails = document.getElementById('rails');
    const stations = document.getElementById('stations');
    const busLayer = document.getElementById('buses');
    const ring = document.getElementById('stop-ring');

    for (const line of LINES) {
        line.path = el('path', { d: line.d, fill: 'none', stroke: line.color, 'stroke-width': 10, 'stroke-linecap': 'round' }, rails);
        line.length = line.path.getTotalLength();
        const x = line.path.getPointAtLength(0).x;
        for (const y of line.stations) el('circle', { cx: x, cy: y, r: 7, class: 'station' }, stations);
        line.stations = line.stations.concat(TRUNK_STATIONS);
    }
    for (const y of TRUNK_STATIONS) el('rect', { x: 265, y: y - 8, width: 38, height: 16, rx: 8, class: 'station' }, stations);

    const $ = (id) => document.getElementById(id);
    const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
    const hhmm = (ms) => {
        const d = new Date(ms);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };

    const startWall = Date.now();
    const startPerf = performance.now();
    const busNodes = new Map();

    // every bus on the road at sim second s, with how far along it is and how long until it arrives
    function busesAt(s) {
        const out = [];
        for (const line of LINES) {
            const base = line.firstArrival - line.trip; // departure of bus k = 0
            const kMin = Math.ceil((s - base - line.trip) / line.headway);
            const kMax = Math.floor((s - base) / line.headway);
            for (let k = kMin; k <= kMax; k++) {
                const dep = base + k * line.headway;
                const frac = (s - dep) / line.trip;
                if (frac < 0 || frac >= 1) continue;
                const p = line.path.getPointAtLength(frac * (line.length - 26)); // pull up just short of the stop ring
                const stopsAway = line.stations.filter((y) => y > p.y).length + 1;
                out.push({ key: line.id + ':' + k, line, frac, p, eta: dep + line.trip - s, stopsAway });
            }
        }
        return out.sort((a, b) => a.eta - b.eta);
    }

    function drawBus(bus, lead) {
        let g = busNodes.get(bus.key);
        if (!g) {
            g = el('g', { class: 'bus' }, busLayer);
            el('rect', { x: -24, y: -17, width: 48, height: 34, rx: 10, class: 'bus-halo' }, g);
            el('rect', { x: -20, y: -13, width: 40, height: 26, rx: 7, fill: bus.line.color }, g);
            const t = el('text', { x: 0, y: 5, 'text-anchor': 'middle', class: 'bus-num' }, g);
            t.textContent = bus.line.id;
            busNodes.set(bus.key, g);
        }
        const p = bus.p;
        g.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
        g.classList.toggle('bus-lead', lead);
        g.querySelector('.bus-halo').style.display = lead ? '' : 'none';
    }

    function readout(prefix, bus, now) {
        const badge = $(prefix + '-badge');
        badge.dataset.line = bus.line.id;
        set(badge, bus.line.id);
        const due = bus.eta < 60;
        set($(prefix + '-min'), due ? 'NOW' : String(Math.ceil(bus.eta / 60)));
        const unit = $(prefix + '-unit');
        if (unit) unit.style.display = due ? 'none' : '';
        const at = hhmm(now + bus.eta * 1000);
        if (prefix === 'next') {
            const stops = bus.stopsAway === 1 ? '1 STOP AWAY' : bus.stopsAway + ' STOPS AWAY';
            set($('next-sub'), due ? 'ARRIVING NOW' : stops + ' • ARRIVES ' + at);
        } else {
            set($('then-sub'), at);
        }
    }

    function frame() {
        const elapsed = (performance.now() - startPerf) / 1000 * (reduceMotion ? 0 : SPEED);
        const now = startWall + elapsed * 1000;
        const buses = busesAt(elapsed);

        const live = new Set(buses.map((b) => b.key));
        for (const [key, g] of busNodes) {
            if (live.has(key)) continue;
            g.remove();
            busNodes.delete(key);
            ring.classList.remove('arrived');
            void ring.getBBox();
            ring.classList.add('arrived');
        }
        buses.forEach((b, i) => drawBus(b, i === 0));
        // the next bus sits on top where the two lines run side by side
        if (buses[0]) busLayer.appendChild(busNodes.get(buses[0].key));

        set($('board-clock'), hhmm(now));
        if (buses[0]) readout('next', buses[0], now);
        if (buses[1]) readout('then', buses[1], now);

        if (!reduceMotion) requestAnimationFrame(frame);
    }

    if (reduceMotion) {
        const cap = document.querySelector('.board figcaption');
        if (cap) cap.textContent = 'Demo board.';
    }
    frame();
})();

// Questions: animate each answer open and closed instead of letting <details> jump.
(function () {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

    document.querySelectorAll('.faq details').forEach((details) => {
        const summary = details.querySelector('summary');
        let animation = null;

        details.classList.toggle('is-open', details.open);

        summary.addEventListener('click', (event) => {
            event.preventDefault();
            const opening = !details.classList.contains('is-open');
            const from = details.offsetHeight;

            if (animation) animation.cancel();
            details.classList.toggle('is-open', opening);
            if (opening) details.open = true;
            if (reduceMotion) { details.open = opening; return; }

            const border = details.offsetHeight - details.clientHeight; // heights are border-box
            const to = (opening ? details.scrollHeight : summary.offsetHeight) + border;
            const run = details.animate({ height: [from + 'px', to + 'px'] }, { duration: 320, easing: EASE });
            animation = run;
            // settle on a timer as well: finish events wait for a rendered frame, which a hidden tab never gets
            const settle = () => {
                if (animation !== run) return;
                animation = null;
                run.cancel();
                if (!opening) details.open = false;
            };
            run.onfinish = settle;
            setTimeout(settle, 360);
        });
    });
})();
