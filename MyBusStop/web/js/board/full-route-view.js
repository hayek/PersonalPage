// The full lines view: every watched line over its whole route, every stop drawn, scrolled along
// the way travel runs (sideways on a wide screen, down on a tall one). Lines that share stops run
// together as a bundle and part where their routes do. A strip at the foot shows the whole of it,
// with a window over the part in view; dragging the window, or tapping the strip, moves the view.
// Beside the strip, Previous and Next step from bus to bus along the line, and My stop goes back.
//
// Layout is `layoutFullRoute` (js/map/full-route.js); this file only draws it and wires it up, as
// BusBus/Board/FullRouteView.swift does in the app. The pucks and the palette are the board's own.

import { h, icon, isLightTheme } from '../ui.js';
import {
    layoutFullRoute, centreOnUserStop, clampOffset, minimapPoint, minimapWindow, minimapOffset, FOCUS, stepBus,
    chooseMapLayout, AXIS, READABLE_MINIMUM, THEMES, railColor, numeralColor, labelColor,
} from '../map/index.js';
import { svgElement as el, textStyle, textNode, measureText, wrapTwoLines, centredBaseline, drawNumeral, drawPuckContent } from '../map/render.js';
import { LINE_HEIGHT_EM } from '../map/metrics.js';

/** The part of a route past the rider's stop: still there to read, but no bus there is coming. */
const FADED = 0.35;
const LABEL_FADED = 0.5;
const MINI_HEIGHT = 64;
const MINI_PAD = { x: 16, y: 10 };
/** The board's terminus bar radius: the last stop of a line on its own is a square, not a ring. */
const LAST_STOP_RADIUS = 5;

let current = null;

/**
 * @param {object} options
 * @param {string} options.stopName the rider's stop, for the title
 * @param {() => {lines: Array<{id:string, number:string, colorIndex:number, stops:Array<{code:string,name:string}>}>,
 *   userStopCode: string, vehicles: object[], note: string|null}} options.read
 *   what to draw, asked again on every `update()`
 * @param {(stopCode: string) => void} options.onStopTap
 * @returns {{update: () => void, close: () => void}}
 */
export function openFullRoute({ stopName, read, onStopTap }) {
    closeFullRoute();
    const returnFocus = document.activeElement;
    const titleID = 'full-route-title';

    const svg = el('svg', { class: 'fr-svg' });
    const note = h('p', { class: 'map-note fr-note', hidden: true });
    const scroller = h('div', { class: 'fr-scroller', tabindex: 0, role: 'region', 'aria-label': 'Every stop of the lines. Scroll to follow the route.' }, svg, note);
    const miniSvg = el('svg', { class: 'fr-mini-svg', 'aria-hidden': 'true' });
    const windowBox = h('div', { class: 'fr-mini-window' });
    // The strip repeats what the view shows, for a pointer to move it; the view itself scrolls by
    // keyboard, so the strip is kept out of the accessibility tree.
    const mini = h('div', { class: 'fr-mini', 'aria-hidden': 'true' }, miniSvg, windowBox);
    const navButton = (name, label, onclick, flips) => h('button', { class: 'fr-nav-button', 'aria-label': label, title: label, onclick },
        Object.assign(icon(name, 17), { className: `icon${flips ? ' flip-rtl' : ''}` }));
    const previousButton = navButton('chevronBack', 'Previous bus', () => step(-1), true);
    const myStopButton = navButton('scope', 'My stop', () => moveTo(FOCUS.userStop));
    const nextButton = navButton('chevronForward', 'Next bus', () => step(1), true);
    // Where the bus the view moved to is said, for a screen reader: the view itself has no words.
    const announcer = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
    const closeButton = h('button', { class: 'round-button', 'aria-label': 'Close the full lines view', onclick: () => closeFullRoute() }, icon('close', 20));
    const overlay = h('div', { class: 'full-route', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleID },
        h('header', { class: 'fr-head' },
            h('div', { class: 'fr-title' },
                h('p', { class: 'caption' }, 'FULL LINES VIEW'),
                h('h2', { id: titleID, dir: 'auto' }, stopName)),
            closeButton),
        scroller,
        h('div', { class: 'fr-foot' }, mini, h('div', { class: 'fr-nav' }, previousButton, myStopButton, nextButton)),
        announcer);

    let scene = null;
    let layoutKey = null;
    let frame = 0;
    /** What Previous, My stop and Next go from; the view opens on the rider's stop. */
    let focus = FOCUS.userStop;
    /**
     * True while the view moves itself, so its scroll events are not taken for the rider's. The
     * rider's own wheel, touch, key or press ends it at once.
     */
    let selfScrolling = false;
    let selfScrollTimer = 0;

    const visible = () => ({ x: scroller.scrollLeft, y: scroller.scrollTop, width: scroller.clientWidth, height: scroller.clientHeight });
    const strip = () => ({ width: Math.max(1, mini.clientWidth - 2 * MINI_PAD.x), height: MINI_HEIGHT - 2 * MINI_PAD.y });
    const minimap = () => ({ axis: scene.axis, content: scene.contentSize, strip: strip() });
    function scrollTo({ x, y }, smooth = false) {
        selfScrolling = true;
        clearTimeout(selfScrollTimer);
        const instant = !smooth || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        scroller.scrollTo({ left: x, top: y, behavior: instant ? 'instant' : 'smooth' });
        // `scrollend` ends it where the browser has it; the timer where it has not.
        selfScrollTimer = setTimeout(() => { selfScrolling = false; }, instant ? 100 : 900);
    }

    // MARK: Drawing

    function draw() {
        const data = read();
        const width = scroller.clientWidth;
        const height = scroller.clientHeight;
        const axis = chooseMapLayout(Math.max(1, width), Math.max(1, height), data.lines.length).axis;
        const next = data.lines.length && width > 0 && height > 0
            ? layoutFullRoute({ lines: data.lines, userStopCode: data.userStopCode, vehicles: data.vehicles, axis, viewport: { width, height } })
            : null;
        if (!next || next.isEmpty) {
            svg.replaceChildren();
            miniSvg.replaceChildren();
            windowBox.hidden = true;
            note.hidden = false;
            note.textContent = data.note ?? 'LOADING THE ROUTE…';
            scene = null;
            layoutKey = null;
            return;
        }
        note.hidden = true;
        windowBox.hidden = false;
        const theme = THEMES[isLightTheme() ? 'light' : 'dark'];
        const key = [width, height, axis, theme.isLight, data.userStopCode,
            data.lines.map((l) => `${l.id}:${l.colorIndex}:${l.stops.map((st) => st.code).join(',')}`).join(';')].join('|');

        if (key !== layoutKey) {
            // Where the view was, as a share of the drawing, so a resize or a turn keeps the place.
            let place = null;
            if (scene) {
                const v = visible();
                place = scene.axis === AXIS.horizontal ? (v.x + v.width / 2) / scene.contentSize.width
                    : (v.y + v.height / 2) / scene.contentSize.height;
            }
            layoutKey = key;
            scene = next;
            drawBase(theme);
            const viewport = { width, height };
            // Across, the rider's lane stays in view either way.
            const home = centreOnUserStop(scene, viewport);
            if (place === null) {
                scrollTo(home);
            } else {
                const target = scene.axis === AXIS.horizontal
                    ? { x: place * scene.contentSize.width - width / 2, y: home.y }
                    : { x: home.x, y: place * scene.contentSize.height - height / 2 };
                scrollTo(clampOffset(target, viewport, scene.contentSize));
            }
        } else {
            // Same routes, new positions: only the buses move.
            scene = next;
        }
        // The bus Previous or Next went to carries the ring, so the eye finds it once the view has
        // moved; until then, and once it has gone, the ring stays where the board puts it.
        if (focus.kind === 'bus' && scene.pucks.some((p) => p.vehicleID === focus.id)) {
            scene = { ...scene, pucks: scene.pucks.map((p) => ({ ...p, isSelected: p.vehicleID === focus.id })) };
        }
        drawPucks(theme);
        drawMini(theme);
        updateWindow();
    }

    function drawBase(theme) {
        const { width, height } = scene.contentSize;
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', width);
        svg.setAttribute('height', height);
        svg.setAttribute('role', 'group');
        svg.setAttribute('aria-label', `${scene.lines.length === 1 ? 'Line' : 'Lines'} ${scene.lines.map((l) => l.number).join(', ')}, every stop`);
        svg.replaceChildren();

        const rails = el('g', { 'pointer-events': 'none' }, svg);
        for (const line of scene.lines) drawRail(rails, line, theme);
        const stops = el('g', { class: 'fr-stops' }, svg);
        for (const stop of scene.stops) drawStop(stops, stop, theme);
        el('g', { class: 'fr-pucks', 'pointer-events': 'none' }, svg);
    }

    /** One path for the rail up to the rider's stop and one, drawn back, for the rest. */
    function drawRail(group, line, theme) {
        const color = railColor(line.colorIndex, theme.isLight);
        for (const faded of [false, true]) {
            let d = '';
            let cursor = null;
            for (const s of line.segments) {
                if (s.faded !== faded) { cursor = null; continue; }
                if (!cursor || cursor.x !== s.from.x || cursor.y !== s.from.y) d += `M${s.from.x} ${s.from.y}`;
                d += s.bends ? `C${s.control1.x} ${s.control1.y} ${s.control2.x} ${s.control2.y} ${s.to.x} ${s.to.y}` : `L${s.to.x} ${s.to.y}`;
                cursor = s.to;
            }
            if (!d) continue;
            el('path', {
                d, fill: 'none', stroke: color, 'stroke-width': scene.railWidth,
                'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': faded ? FADED : null,
            }, group);
        }
        // The line's badge leads its rail, as the terminus badge leads a board's rail.
        const side = scene.badgeSide;
        const { x, y } = line.badgeCenter;
        el('rect', { x: x - side / 2, y: y - side / 2, width: side, height: side, rx: side * 0.23, fill: color }, group);
        drawNumeral(group, line.number, x, y, 17, side, side * 0.14, numeralColor(line.colorIndex, theme.isLight));
    }

    function drawStop(group, stop, theme) {
        const numbers = stop.lineIDs.map((id) => scene.lines.find((l) => l.lineID === id)?.number ?? id);
        const g = el('g', {
            class: 'fr-stop map-stop', 'data-stop-code': stop.code, role: 'button', tabindex: 0,
            'aria-label': `${stop.name}, ${numbers.length === 1 ? 'line' : 'lines'} ${numbers.join(' and ')}${stop.role === 'userStop' ? ', your stop' : ''}`,
        }, group);

        // A finger's worth around the mark, however small it is drawn.
        const xs = stop.memberCenters.map((p) => p.x);
        const ys = stop.memberCenters.map((p) => p.y);
        const bounds = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
        const cx = (bounds.x0 + bounds.x1) / 2;
        const cy = (bounds.y0 + bounds.y1) / 2;
        const tw = Math.max(44, bounds.x1 - bounds.x0 + 2 * scene.ringRadius);
        const th = Math.max(44, bounds.y1 - bounds.y0 + 2 * scene.ringRadius);
        el('rect', { x: cx - tw / 2, y: cy - th / 2, width: tw, height: th, fill: 'transparent' }, g);

        const past = stop.isPastUserStop ? FADED : null;
        if (stop.role === 'userStop') {
            capsule(g, bounds, scene.nodeRadius, scene.ringStroke + 1, theme.primaryText, null, theme);
        } else if (stop.role === 'lastStop' && !stop.isShared) {
            const side = scene.ringRadius * 2 + scene.ringStroke;
            el('rect', {
                x: stop.center.x - side / 2, y: stop.center.y - side / 2, width: side, height: side, rx: LAST_STOP_RADIUS,
                fill: railColor(stop.colorIndex, theme.isLight), 'fill-opacity': past,
            }, g);
        } else {
            // One capsule across lines calling together, in the ink rather than any one line's
            // colour: the wait there is shared, as on the board.
            capsule(g, bounds, scene.ringRadius, scene.ringStroke,
                stop.isShared ? theme.primaryText : railColor(stop.colorIndex, theme.isLight), past, theme);
        }
        drawName(g, stop, theme);
    }

    /** A ring on one line, or a capsule spanning every line calling at the stop together. */
    function capsule(group, b, radius, width, stroke, opacity, theme) {
        el('rect', {
            x: b.x0 - radius, y: b.y0 - radius, width: b.x1 - b.x0 + 2 * radius, height: b.y1 - b.y0 + 2 * radius,
            rx: radius, fill: theme.background, stroke, 'stroke-width': width, 'stroke-opacity': opacity,
        }, group);
    }

    /**
     * The name, on up to two lines of the room the layout gave it, and "YOUR STOP" under the
     * rider's own. Landscape sets it at −35°, anchored at its bottom-leading corner; portrait sets it
     * level, centred on the anchor.
     */
    function drawName(group, stop, theme) {
        const size = Math.max(READABLE_MINIMUM, scene.labelFontSize);
        const text = stop.name.toUpperCase();
        const run = textStyle(text, size, size * 0.04);
        const room = Math.max(0, stop.labelMaxWidth);
        const lines = measureText(text, run) <= room ? [text] : wrapTwoLines(text, run, room);
        const fill = stop.role === 'userStop' ? theme.primaryText
            : stop.role === 'lastStop' ? labelColor(stop.colorIndex, theme.isLight) : theme.stopName;
        const rows = lines.map((line) => ({ line, run }));
        if (stop.role === 'userStop') {
            const small = textStyle('YOUR STOP', Math.max(11, size - 1), size * 0.06);
            rows.push({ line: 'YOUR STOP', run: small });
        }
        const lineHeight = size * LINE_HEIGHT_EM;
        const { x, y } = stop.labelAnchor;
        const node = el('g', {
            opacity: stop.isPastUserStop ? LABEL_FADED : null,
            transform: scene.labelRotation ? `rotate(${scene.labelRotation} ${x} ${y})` : null,
        }, group);
        rows.forEach((row, i) => {
            const baseline = scene.labelRotation
                ? y - (rows.length - 1 - i) * lineHeight - row.run.descent * row.run.size
                : centredBaseline(y, row.run) + (i - (rows.length - 1) / 2) * lineHeight;
            textNode(node, row.line, row.run, { x, y: baseline, fill });
        });
        if (lines.join(' ') !== text) el('title', {}, group).textContent = stop.name;
    }

    function drawPucks(theme) {
        const layer = svg.querySelector('.fr-pucks');
        if (!layer || !scene) return;
        layer.replaceChildren();
        // The bus the readout is about goes last, so its ring is drawn over any bus beside it.
        const pucks = [...scene.pucks].sort((a, b) => Number(a.isSelected) - Number(b.isSelected));
        for (const puck of pucks) {
            const g = el('g', { transform: `translate(${puck.center.x} ${puck.center.y})` }, layer);
            const inner = el('g', { transform: puck.isSelected ? 'scale(1.14)' : null }, g);
            drawPuckContent(inner, puck, theme, { hitTarget: false });
        }
    }

    // MARK: The strip

    function drawMini(theme) {
        miniSvg.replaceChildren();
        if (!scene) return;
        const width = mini.clientWidth;
        miniSvg.setAttribute('viewBox', `0 0 ${width} ${MINI_HEIGHT}`);
        miniSvg.setAttribute('width', width);
        miniSvg.setAttribute('height', MINI_HEIGHT);
        const map = minimap();
        const at = (p) => {
            const q = minimapPoint(map, p);
            return { x: MINI_PAD.x + q.x, y: MINI_PAD.y + q.y };
        };
        // A path per line and shade, not a line per segment: drawn back, the round ends of one
        // segment would lay over the next and leave the rail looking dotted.
        for (const line of scene.lines) {
            const color = railColor(line.colorIndex, theme.isLight);
            for (const faded of [false, true]) {
                const parts = line.segments.filter((s) => s.faded === faded);
                if (!parts.length) continue;
                const d = parts.map((s, i) => {
                    const a = at(s.from);
                    const b = at(s.to);
                    const joined = i > 0 && parts[i - 1].to === s.from;
                    return `${joined ? '' : `M${a.x} ${a.y}`}L${b.x} ${b.y}`;
                }).join('');
                el('path', { d, fill: 'none', stroke: color, 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': faded ? FADED : null }, miniSvg);
            }
        }
        for (const stop of scene.stops) {
            if (stop.role !== 'userStop') continue;
            for (const c of stop.memberCenters) {
                const p = at(c);
                el('circle', { cx: p.x, cy: p.y, r: 4, fill: theme.primaryText }, miniSvg);
            }
        }
        for (const puck of scene.pucks) {
            const p = at(puck.center);
            el('rect', {
                x: p.x - 5, y: p.y - 4, width: 10, height: 8, rx: 2,
                fill: railColor(puck.colorIndex, theme.isLight), stroke: puck.isSelected ? theme.primaryText : null, 'stroke-width': 1.5,
            }, miniSvg);
        }
    }

    function updateWindow() {
        updateNav();
        if (!scene) return;
        const w = minimapWindow(minimap(), visible());
        windowBox.style.left = `${MINI_PAD.x + w.x - 2}px`;
        windowBox.style.top = `${MINI_PAD.y + w.y - 2}px`;
        windowBox.style.width = `${Math.max(12, w.width + 4)}px`;
        windowBox.style.height = `${Math.max(12, w.height + 4)}px`;
    }

    // MARK: Moving about

    scroller.addEventListener('scroll', () => {
        // The rider moved the view: the steps now go from whatever is in its middle.
        if (!selfScrolling && focus.kind !== 'free') setFocus(FOCUS.free);
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(updateWindow);
    }, { passive: true });
    scroller.addEventListener('scrollend', () => { selfScrolling = false; });
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
        scroller.addEventListener(type, () => { selfScrolling = false; }, { passive: true });
    }

    const middleAlong = () => {
        const v = visible();
        return scene.axis === AXIS.horizontal ? v.x + v.width / 2 : v.y + v.height / 2;
    };

    function setFocus(next) {
        const ringMoves = focus.kind === 'bus' || next.kind === 'bus';
        focus = next;
        if (ringMoves && scene) draw();
        else updateNav();
    }

    /** A button whose step would find nothing is shown, but greyed and out of reach. */
    function updateNav() {
        const has = scene && !scene.isEmpty;
        previousButton.disabled = !has || !stepBus(-1, focus, scene, middleAlong());
        nextButton.disabled = !has || !stepBus(1, focus, scene, middleAlong());
        myStopButton.disabled = !has;
    }

    function step(direction) {
        if (!scene) return;
        const bus = stepBus(direction, focus, scene, middleAlong());
        if (bus) moveTo(FOCUS.bus(bus.vehicleID), bus);
    }

    /** Centres the view on the rider's stop or on a bus, and says which bus. */
    function moveTo(target, bus = null) {
        if (!scene) return;
        const viewport = { width: scroller.clientWidth, height: scroller.clientHeight };
        const offset = bus
            ? clampOffset({ x: bus.center.x - viewport.width / 2, y: bus.center.y - viewport.height / 2 }, viewport, scene.contentSize)
            : centreOnUserStop(scene, viewport);
        setFocus(target);
        scrollTo(offset, true);
        if (bus) {
            // Emptied first, so the same words said twice are still said.
            announcer.textContent = '';
            requestAnimationFrame(() => { announcer.textContent = `Bus ${bus.lineNumber}`; });
        }
    }

    // A tap on the strip centres the view there; a drag carries the window, from wherever on it
    // the finger landed rather than jumping its middle under the finger.
    let grab = null;
    const stripAt = (event) => {
        const box = mini.getBoundingClientRect();
        return { x: event.clientX - box.left - MINI_PAD.x, y: event.clientY - box.top - MINI_PAD.y };
    };
    const seek = (p) => {
        setFocus(FOCUS.free);
        scrollTo(minimapOffset(minimap(), p, { width: scroller.clientWidth, height: scroller.clientHeight }));
    };
    mini.addEventListener('pointerdown', (event) => {
        if (!scene || event.button > 0) return;
        const p = stripAt(event);
        const w = minimapWindow(minimap(), visible());
        const inside = p.x >= w.x && p.x <= w.x + w.width && p.y >= w.y - 4 && p.y <= w.y + w.height + 4;
        grab = inside ? { x: p.x - (w.x + w.width / 2), y: p.y - (w.y + w.height / 2) } : { x: 0, y: 0 };
        mini.setPointerCapture(event.pointerId);
        mini.classList.add('dragging');
        seek({ x: p.x - grab.x, y: p.y - grab.y });
        event.preventDefault();
    });
    mini.addEventListener('pointermove', (event) => {
        if (!grab) return;
        const p = stripAt(event);
        seek({ x: p.x - grab.x, y: p.y - grab.y });
    });
    const release = () => { grab = null; mini.classList.remove('dragging'); };
    mini.addEventListener('pointerup', release);
    mini.addEventListener('pointercancel', release);
    mini.addEventListener('lostpointercapture', release);

    // MARK: Stops

    const stopFrom = (event) => event.target.closest?.('[data-stop-code]');
    svg.addEventListener('click', (event) => {
        const node = stopFrom(event);
        if (node) onStopTap(node.getAttribute('data-stop-code'));
    });
    svg.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const node = stopFrom(event);
        if (!node) return;
        event.preventDefault();
        onStopTap(node.getAttribute('data-stop-code'));
    });

    // MARK: Lifecycle

    const onKey = (event) => {
        if (event.defaultPrevented) return;
        if (event.key === 'Escape') { event.preventDefault(); closeFullRoute(); return; }
        if (event.key !== 'Tab') return;
        const focusable = [...overlay.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const resize = new ResizeObserver(() => draw());
    const scrollLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.append(overlay);
    resize.observe(scroller);
    resize.observe(mini);
    draw();
    closeButton.focus({ preventScroll: true });

    const controller = {
        update: () => { if (current === controller) draw(); },
        close() {
            if (current !== controller) return;
            current = null;
            cancelAnimationFrame(frame);
            clearTimeout(selfScrollTimer);
            resize.disconnect();
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = scrollLock;
            overlay.remove();
            if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
        },
    };
    current = controller;
    return controller;
}

export function closeFullRoute() {
    current?.close();
}
