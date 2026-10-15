// The full lines view: every watched line over its whole route, every stop drawn, scrolled along
// the way travel runs (sideways on a wide screen, down on a tall one). A strip at the foot shows
// the whole of it, with a window over the part in view; dragging the window, or tapping the strip,
// moves the view there.
//
// Layout is `layoutFullRoute` (js/map/full-route.js); this file only draws it and wires it up. The
// marks, names and pucks are the board map's own, from the same metrics and the same palette.

import { h, icon, isLightTheme } from '../ui.js';
import {
    layoutFullRoute, scrollToCentre, miniWindow, scrollForMini,
    chooseMapLayout, makeMetrics, wrapLabelLines, AXIS, READABLE_MINIMUM,
    THEMES, railColor, numeralColor, labelColor,
} from '../map/index.js';
import { svgElement as el, textStyle, textNode, measureText, wrapTwoLines, centredBaseline, drawNumeral, drawPuckContent, MONO } from '../map/render.js';
import { LINE_HEIGHT_EM, MONO_ADVANCE_EM, charCount } from '../map/metrics.js';

/** The part of a route after the rider's stop: still there to read, but not where their bus is. */
const AFTER_OPACITY = 0.38;
/** Angled names, as on the landscape board. */
const LABEL_ANGLE = -35;
/** How long an angled name may run before it wraps onto a second line. */
const LABEL_MAX_WIDTH = 150;
const MINI_HEIGHT = 64;
const MINI_PAD = 14;

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
    const closeButton = h('button', { class: 'round-button', 'aria-label': 'Close the full lines view', onclick: () => closeFullRoute() }, icon('close', 20));
    const overlay = h('div', { class: 'full-route', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleID },
        h('header', { class: 'fr-head' },
            h('div', { class: 'fr-title' },
                h('p', { class: 'caption' }, 'FULL LINES VIEW'),
                h('h2', { id: titleID, dir: 'auto' }, stopName)),
            closeButton),
        scroller,
        mini);

    let scene = null;
    let layoutKey = null;
    let frame = 0;

    const isHorizontal = () => scene?.axis === AXIS.horizontal;
    const scrollPos = () => (isHorizontal() ? scroller.scrollLeft : scroller.scrollTop);
    const viewport = () => (isHorizontal() ? scroller.clientWidth : scroller.clientHeight);
    const content = () => Math.max(scene?.along ?? 0, viewport());
    const stripLength = () => Math.max(1, mini.clientWidth - 2 * MINI_PAD);
    function scrollTo(position) {
        if (isHorizontal()) scroller.scrollLeft = position;
        else scroller.scrollTop = position;
    }

    // MARK: Drawing

    function draw() {
        const data = read();
        const width = scroller.clientWidth;
        const height = scroller.clientHeight;
        if (!data.lines.length || width < 1 || height < 1) {
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
        const key = [width, height, theme.isLight, data.userStopCode,
            data.lines.map((l) => `${l.id}:${l.colorIndex}:${l.stops.length}`).join(',')].join('|');

        if (key !== layoutKey) {
            // Where the view was, as a share of the route, so a resize or a turn keeps the place.
            const centre = scene ? (scrollPos() + viewport() / 2) / content() : null;
            layoutKey = key;
            scene = drawBase(data, width, height, theme);
            if (centre === null) scrollTo(scrollToCentre(scene.userAlong, viewport(), content()));
            else scrollTo(scrollToCentre(centre * content(), viewport(), content()));
        } else {
            // Same routes, new positions: only the buses move.
            scene = { ...scene, ...layoutFullRoute({ ...scene.request, vehicles: data.vehicles }), request: scene.request, style: scene.style };
        }
        drawPucks(theme);
        drawMini(theme);
        updateWindow();
    }

    function drawBase(data, width, height, theme) {
        const count = data.lines.length;
        const mode = chooseMapLayout(width, height, count);
        const axis = mode.axis;
        // The board shrinks to fit a screen; here the route scrolls instead, so names stay readable.
        const scale = Math.min(1.25, Math.max(0.85, mode.scale));
        const m = makeMetrics(mode.preset, scale, count);
        const fontSize = Math.max(READABLE_MINIMUM, m.stopNameFontSize);
        const tracking = fontSize * m.stopNameTrackingEm;
        const lineHeight = fontSize * LINE_HEIGHT_EM;
        const badgeSide = Math.max(26, 30 * scale);
        const ring = m.ringRadius;
        const leadIn = badgeSide + ring + 24;
        const style = { m, fontSize, tracking, lineHeight, badgeSide, ring, scale };

        let request;
        let size;
        let labelRoom = [];
        if (axis === AXIS.horizontal) {
            // Angled names rise to the right of their stop into the band above the row, so each row
            // is given that band; the row above keeps clear of it.
            const angle = Math.abs(LABEL_ANGLE) * Math.PI / 180;
            const rise = LABEL_MAX_WIDTH * Math.sin(angle) + 2 * lineHeight * Math.cos(angle) + ring + 6;
            const below = Math.max(ring, m.puckSize.height / 2) + 8;
            const rowGap = rise + below;
            const top = rise + 8;
            const across = data.lines.map((_, i) => top + i * rowGap);
            const tall = top + (count - 1) * rowGap + below + lineHeight + 6;
            // A short drawing sits in the middle of a tall view rather than at its top.
            const shift = Math.max(0, (height - tall) / 2);
            request = {
                lines: data.lines, userStopCode: data.userStopCode, axis,
                pitch: Math.max(60, Math.min(m.stopPitch, 92)),
                leadIn, leadOut: LABEL_MAX_WIDTH * Math.cos(angle) + 24,
                across: across.map((a) => a + shift),
            };
            size = { height: Math.max(height, tall) };
        } else {
            // Columns share the width, each name running right of its rail up to the next column.
            // Room on the left for the first column's badge, and for a ringed bus on it whole.
            const pad = 8 + Math.max(badgeSide / 2, (m.puckSize.width / 2 + m.puckHalo + m.puckRing) * 1.14);
            const gap = Math.max(84, (width - pad - 8) / count);
            const across = data.lines.map((_, i) => pad + i * gap);
            labelRoom = across.map((a, i) => (i < count - 1 ? gap : width - a) - ring - 16);
            request = {
                lines: data.lines, userStopCode: data.userStopCode, axis,
                pitch: Math.max(52, Math.min(m.stopPitch, 72)),
                leadIn, leadOut: 40, across,
            };
            size = { width: Math.max(width, across[count - 1] + 96) };
        }
        const layout = layoutFullRoute({ ...request, vehicles: data.vehicles });
        const svgWidth = axis === AXIS.horizontal ? layout.along : size.width;
        const svgHeight = axis === AXIS.horizontal ? size.height : layout.along;
        svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
        svg.setAttribute('width', svgWidth);
        svg.setAttribute('height', svgHeight);
        svg.setAttribute('role', 'group');
        svg.setAttribute('aria-label', `${data.lines.length === 1 ? 'Line' : 'Lines'} ${data.lines.map((l) => l.number).join(', ')}, every stop`);
        svg.replaceChildren();

        const base = el('g', {}, svg);
        drawGuide(base, layout, style, theme, axis);
        for (const row of layout.rows) drawRail(base, row, style, theme, axis);
        const stops = el('g', { class: 'fr-stops' }, svg);
        layout.rows.forEach((row, i) => drawStops(stops, row, style, theme, axis, labelRoom[i]));
        el('g', { class: 'fr-pucks', 'pointer-events': 'none' }, svg);
        drawCaption(svg, layout, style, theme, axis, request.pitch);
        return { ...layout, request, style };
    }

    /** The rider's stop, one line through every row: where each bus is headed. */
    function drawGuide(group, layout, style, theme, axis) {
        const first = layout.rows[0].across - style.ring - 6;
        const last = layout.rows[layout.rows.length - 1].across + style.ring + 6;
        const [x1, y1, x2, y2] = axis === AXIS.horizontal
            ? [layout.userAlong, first, layout.userAlong, last]
            : [first, layout.userAlong, last, layout.userAlong];
        el('line', { x1, y1, x2, y2, stroke: theme.primaryText, 'stroke-width': 2, 'stroke-opacity': 0.3, 'stroke-linecap': 'round' }, group);
    }

    function drawRail(group, row, style, theme, axis) {
        const color = railColor(row.colorIndex, theme.isLight);
        const width = style.m.railWidth;
        const badgeAlong = row.firstAlong - (style.ring + 10 + style.badgeSide / 2);
        const at = (along) => (axis === AXIS.horizontal ? `${along} ${row.across}` : `${row.across} ${along}`);
        const user = row.stops[row.userIndex].along;
        el('path', { d: `M${at(badgeAlong)}L${at(user)}`, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', fill: 'none' }, group);
        if (row.lastAlong > user) {
            el('path', { d: `M${at(user)}L${at(row.lastAlong)}`, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', fill: 'none', 'stroke-opacity': AFTER_OPACITY }, group);
        }
        // The line's badge leads its row, as the terminus badge leads a board's rail.
        const [cx, cy] = axis === AXIS.horizontal ? [badgeAlong, row.across] : [row.across, badgeAlong];
        const side = style.badgeSide;
        el('rect', { x: cx - side / 2, y: cy - side / 2, width: side, height: side, rx: side * 0.23, fill: color }, group);
        drawNumeral(group, row.number, cx, cy, Math.max(READABLE_MINIMUM, 16 * style.scale), side, side * 0.14, numeralColor(row.colorIndex, theme.isLight));
    }

    function drawStops(group, row, style, theme, axis, room) {
        for (const stop of row.stops) {
            const g = el('g', {
                class: 'fr-stop map-stop', 'data-stop-code': stop.code, role: 'button', tabindex: 0,
                'aria-label': `${stop.name}, line ${row.number}${stop.isUser ? ', your stop' : ''}`,
                opacity: stop.isAfter ? AFTER_OPACITY : null,
            }, group);
            const { x, y } = stop.point;
            el('circle', { cx: x, cy: y, r: Math.max(22, style.ring), fill: 'transparent' }, g);
            if (stop.isUser) {
                el('circle', { cx: x, cy: y, r: style.ring * 1.25, fill: theme.background, stroke: theme.primaryText, 'stroke-width': style.m.ringStroke * 1.2 }, g);
            } else {
                el('circle', { cx: x, cy: y, r: style.ring, fill: theme.background, stroke: railColor(row.colorIndex, theme.isLight), 'stroke-width': style.m.ringStroke }, g);
            }
            const fill = stop.isUser ? theme.primaryText
                : stop.isTerminus ? labelColor(row.colorIndex, theme.isLight) : theme.stopName;
            const text = stop.name.toUpperCase();
            if (axis === AXIS.horizontal) drawAngledName(g, text, x + style.ring * 0.5, y - style.ring - 3, style, fill);
            else drawSideName(g, text, x + style.ring + 10, y, style, fill, room);
        }
    }

    /** As the landscape board sets them: anchored at the bottom-leading corner, turned about it. */
    function drawAngledName(group, text, x, y, style, fill) {
        const run = textStyle(text, style.fontSize, style.tracking);
        const glyph = run.family === MONO ? run.size * MONO_ADVANCE_EM + run.tracking : run.size * 0.55;
        const wrapped = wrapLabelLines(text, LABEL_MAX_WIDTH, glyph, 2);
        const lines = wrapped.lines.slice();
        if (wrapped.truncated) {
            const capacity = Math.max(1, Math.floor(LABEL_MAX_WIDTH / glyph));
            const last = lines[lines.length - 1];
            lines[lines.length - 1] = charCount(last) + 1 > capacity ? [...last].slice(0, Math.max(1, capacity - 1)).join('') + '…' : `${last}…`;
        }
        const g = el('g', { transform: `rotate(${LABEL_ANGLE} ${x} ${y})` }, group);
        const node = textNode(g, '', run, { fill });
        lines.forEach((line, i) => {
            const span = el('tspan', { x, y: y - (lines.length - 1 - i) * style.lineHeight - run.descent * run.size }, node);
            span.textContent = line;
        });
        if (wrapped.truncated) el('title', {}, node).textContent = text;
    }

    /** Beside its stop, on two lines where one is not enough: a column is narrow, a stop is not. */
    function drawSideName(group, text, x, y, style, fill, room) {
        const run = textStyle(text, style.fontSize, style.tracking);
        const available = Math.max(0, room);
        const lines = measureText(text, run) <= available ? [text] : wrapTwoLines(text, run, available);
        const node = textNode(group, '', run, { fill });
        lines.forEach((line, i) => {
            const span = el('tspan', { x, y: centredBaseline(y, run) + (i - (lines.length - 1) / 2) * style.lineHeight }, node);
            span.textContent = line;
        });
        if (lines.join(' ') !== text) el('title', {}, group).textContent = text;
    }

    function drawCaption(group, layout, style, theme, axis, pitch) {
        const text = 'YOUR STOP';
        const run = textStyle(text, Math.max(READABLE_MINIMUM, 12 * style.scale), 12 * style.scale * 0.16);
        const lastRow = layout.rows[layout.rows.length - 1];
        if (axis === AXIS.horizontal) {
            const y = lastRow.across + Math.max(style.ring, style.m.puckSize.height / 2) + 6 + run.ascent * run.size;
            textNode(group, text, run, { x: layout.userAlong, y, fill: theme.primaryText, 'text-anchor': 'middle', 'pointer-events': 'none' });
        } else {
            // Between the stop before and the rider's own, where no name sits.
            const x = layout.rows[0].across + style.ring + 10;
            textNode(group, text, run, { x, y: centredBaseline(layout.userAlong - pitch / 2, run), fill: theme.primaryText, 'pointer-events': 'none' });
        }
    }

    function drawPucks(theme) {
        const layer = svg.querySelector('.fr-pucks');
        if (!layer || !scene) return;
        layer.replaceChildren();
        const m = scene.style.m;
        for (const puck of scene.pucks) {
            const g = el('g', { transform: `translate(${puck.point.x} ${puck.point.y})` }, layer);
            const inner = el('g', { transform: puck.isSelected ? 'scale(1.14)' : null }, g);
            drawPuckContent(inner, {
                lineNumber: puck.number, colorIndex: puck.colorIndex, size: m.puckSize,
                cornerRadius: m.puckCornerRadius, fontSize: m.puckFontSize,
                haloWidth: m.puckHalo, ringWidth: m.puckRing, isSelected: puck.isSelected,
            }, theme, { hitTarget: false });
        }
    }

    // MARK: The strip

    function drawMini(theme) {
        miniSvg.replaceChildren();
        if (!scene) return;
        const width = mini.clientWidth;
        const height = MINI_HEIGHT;
        miniSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        miniSvg.setAttribute('width', width);
        miniSvg.setAttribute('height', height);
        const strip = stripLength();
        const k = strip / content();
        const x = (along) => MINI_PAD + along * k;
        const rows = scene.rows.length;
        const yOf = (i) => 12 + (i + 0.5) * ((height - 24) / rows);
        const railWidth = Math.max(3, Math.min(6, (height - 24) / rows / 3));

        el('line', { x1: x(scene.userAlong), y1: 6, x2: x(scene.userAlong), y2: height - 6, stroke: theme.primaryText, 'stroke-width': 2, 'stroke-opacity': 0.5 }, miniSvg);
        scene.rows.forEach((row, i) => {
            const color = railColor(row.colorIndex, theme.isLight);
            const y = yOf(i);
            const user = row.stops[row.userIndex].along;
            el('line', { x1: x(row.firstAlong), y1: y, x2: x(user), y2: y, stroke: color, 'stroke-width': railWidth, 'stroke-linecap': 'round' }, miniSvg);
            if (row.lastAlong > user) {
                el('line', { x1: x(user), y1: y, x2: x(row.lastAlong), y2: y, stroke: color, 'stroke-width': railWidth, 'stroke-linecap': 'round', 'stroke-opacity': AFTER_OPACITY }, miniSvg);
            }
        });
        for (const puck of scene.pucks) {
            const i = scene.rows.findIndex((r) => r.lineID === puck.lineID);
            el('rect', {
                x: x(puck.along) - 5, y: yOf(i) - 4.5, width: 10, height: 9, rx: 3,
                fill: railColor(puck.colorIndex, theme.isLight), stroke: puck.isSelected ? theme.primaryText : theme.background, 'stroke-width': 2,
            }, miniSvg);
        }
    }

    function updateWindow() {
        if (!scene) return;
        const { start, length } = miniWindow({ scroll: scrollPos(), viewport: viewport(), content: content(), strip: stripLength() });
        windowBox.style.left = `${MINI_PAD + start}px`;
        windowBox.style.width = `${Math.max(12, length)}px`;
    }

    // MARK: Moving about

    scroller.addEventListener('scroll', () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(updateWindow);
    }, { passive: true });

    // A tap on the strip centres the view there; a drag carries the window, from wherever on it
    // the finger landed rather than jumping its middle under the finger.
    let grab = null;
    const stripAt = (event) => event.clientX - mini.getBoundingClientRect().left - MINI_PAD;
    function seek(at) {
        scrollTo(scrollForMini({ at, viewport: viewport(), content: content(), strip: stripLength() }));
    }
    mini.addEventListener('pointerdown', (event) => {
        if (!scene || event.button > 0) return;
        const at = stripAt(event);
        const { start, length } = miniWindow({ scroll: scrollPos(), viewport: viewport(), content: content(), strip: stripLength() });
        grab = at >= start && at <= start + length ? at - (start + length / 2) : 0;
        mini.setPointerCapture(event.pointerId);
        mini.classList.add('dragging');
        seek(at - grab);
        event.preventDefault();
    });
    mini.addEventListener('pointermove', (event) => { if (grab !== null) seek(stripAt(event) - grab); });
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
        const focusable = [...overlay.querySelectorAll('button, [tabindex]:not([tabindex="-1"])')];
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
