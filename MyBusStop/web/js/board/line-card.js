// A line on its own: where it goes, its road on a map and every stop it calls at. Opened by the ⓘ
// beside a line wherever lines are listed (the line picker, a stop's card, the board's readout, the
// full lines view's badges), and only where the line's feed can draw its road (`hasRouteShape`).
// Port of BusBus/Board/LineCardView.swift.
//
// The stops come first, from the pattern the board keeps (one request at most, none when the board
// already has it); the road joins them when its shape arrives, or never, and the card says so
// quietly. A line that has no shape, or one that misses its stops, is never drawn stop to stop
// instead: a straight line through the houses is worse than no line.

import { h, icon, badge, colorIndexFor, isLightTheme } from '../ui.js';
import { railColor } from '../map/index.js';
import { staticData } from '../transit/http.js';
import { loadRouteShape } from '../transit/shapes/route-shape.js';
import { createRouteMap } from './route-map.js';
import { presentSheet } from './sheet.js';
import { showStopCard } from './stop-card.js';

/** The board's own key and age for a pattern (js/board/model.js), so the card and the board share one. */
const PATTERN_MAX_AGE_MS = 12 * 3_600_000;
const patternKey = (provider, line) => `pattern:${provider.datasetID ?? provider.id}:${line.id}`;

const cards = [];

/**
 * @param {object} options
 * @param {import('../transit/model.js').TransitLine} options.line
 * @param {import('../transit/model.js').TransitProvider} options.provider
 * @param {string|null} [options.stopCode] the stop it was opened from, picked out on the map and in the list
 * @param {number} [options.colorIndex] the line's colour where the caller has given it one
 */
export function showLineCard({ line, provider, stopCode = null, colorIndex = null }) {
    // A card opened from the top card's own stops replaces it; one under a stop card stays.
    if (cards.at(-1)?.sheet.isTop()) cards.at(-1).sheet.dismiss();
    const light = isLightTheme();
    const color = railColor(colorIndex ?? colorIndexFor(provider.id, line), light);
    const titleID = `line-card-title-${Math.random().toString(36).slice(2, 8)}`;

    const title = h('h2', { id: titleID, dir: 'auto' }, titleFor(line, []));
    const subtitle = h('p', { class: 'line-card-subtitle', dir: 'auto', hidden: true });
    const canvas = h('div', { class: 'line-card-canvas', role: 'region', 'aria-label': 'Route map' });
    const mapNote = h('p', { class: 'line-card-note', hidden: true });
    const mapQuiet = h('p', { class: 'stop-card-quiet line-card-loading' }, h('i', { class: 'spinner', 'aria-hidden': 'true' }), 'LOADING THE ROUTE…');
    const stopsBody = h('div', { class: 'stop-card-section', hidden: true });
    const close = h('button', { class: 'round-button stop-card-close', 'aria-label': 'Close', onclick: () => entry.sheet.dismiss() }, icon('close', 20));
    const card = h('div', { class: 'stop-card line-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleID, style: { '--line': color } },
        h('header', { class: 'stop-card-head' },
            badge(line, colorIndex ?? colorIndexFor(provider.id, line), 'small'),
            h('div', { class: 'stop-card-title' },
                h('p', { class: 'caption' }, [`LINE ${line.shortName}`, line.agency].filter(Boolean).join(' · ')),
                title,
                subtitle),
            close),
        h('div', { class: 'line-card-map' }, canvas, mapQuiet, mapNote),
        stopsBody,
        provider.attribution ? h('p', { class: 'attribution line-card-credit' }, provider.attribution) : null,
    );
    const backdrop = h('div', { class: 'stop-card-backdrop line-card-backdrop' }, card);

    let cancelled = false;
    let routeMap = null;
    let stops = [];
    let shape = null;
    /** The stop last tapped on the map, found and marked in the list below. */
    let focused = null;
    const rows = [];

    const entry = {
        sheet: presentSheet(backdrop, card, {
            initialFocus: close,
            onClose: () => {
                cancelled = true;
                routeMap?.remove();
                cards.splice(cards.indexOf(entry), 1);
            },
        }),
    };
    cards.push(entry);

    const note = (text) => {
        mapQuiet.hidden = true;
        mapNote.hidden = !text;
        mapNote.textContent = text ?? '';
    };

    const mapReady = createRouteMap(canvas, {
        onStopTap: ({ index }) => focus(index),
        onError: () => note('COULDN’T LOAD THE MAP.'),
    }).then((created) => {
        if (cancelled) { created.remove(); return null; }
        routeMap = created;
        return created;
    }).catch((error) => {
        console.warn('[line card] map', error);
        if (!cancelled) note('COULDN’T LOAD THE MAP.');
        return null;
    });

    // MARK: Drawing

    /** Where a stop is drawn: where the shape's source puts it, so a stop-area centre does not float off the road. */
    const position = (stop) => shape?.stopPositions?.[stop.code] ?? stop.location;
    const mark = (index, stop) => (stop.code === stopCode ? 'highlighted'
        : index === 0 || index === stops.length - 1 ? 'terminus' : 'stop');

    function drawStops() {
        routeMap?.setStops(stops.map((stop, index) => ({
            code: stop.code, index, location: position(stop), color, mark: mark(index, stop), focused: index === focused,
        })));
    }

    function reframe(animate) {
        const points = shape ? shape.branches.flat() : stops.map(position);
        routeMap?.frame(points, animate);
    }

    /** A tap on a stop on the map: its row scrolled into view and marked, and a halo on the dot. */
    function focus(index) {
        rows[focused]?.classList.remove('focused');
        focused = index;
        const row = rows[index];
        row?.classList.add('focused');
        row?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        drawStops();
    }

    function showStops(pattern) {
        stops = pattern.stops.map((s) => s.stop);
        title.textContent = titleFor(line, stops);
        const words = subtitleFor(title.textContent, line.origin ?? stops[0]?.name, line.destination ?? stops.at(-1)?.name);
        subtitle.hidden = !words;
        subtitle.textContent = words ?? '';
        rows.length = 0;
        stopsBody.hidden = !stops.length;
        stopsBody.replaceChildren(
            h('h3', { class: 'stop-card-label' }, 'STOPS ON THIS LINE'),
            h('ol', { class: 'line-card-stops' }, stops.map((stop, index) => {
                const kind = mark(index, stop);
                const row = h('button', {
                    class: `line-card-stop line-card-stop-${kind}`, 'aria-current': kind === 'highlighted' ? 'location' : null,
                    'aria-label': `${stop.name}${stop.city ? `, ${stop.city}` : ''}. Shows the stop’s lines, address and map`,
                    onclick: () => showStopCard({
                        stop, provider, providerID: provider.id, watched: [line], isRidersStop: stop.code === stopCode,
                        linesAtStop: () => provider.linesAtStop(stop),
                    }),
                },
                h('span', { class: `line-card-rail${index === 0 ? ' first' : ''}${index === stops.length - 1 ? ' last' : ''}`, 'aria-hidden': 'true' },
                    h('i', { class: 'line-card-dot' })),
                h('span', { class: 'line-card-stop-text' },
                    h('span', { class: 'line-card-stop-name', dir: 'auto' }, stop.name),
                    stop.city ? h('span', { class: 'line-card-stop-city', dir: 'auto' }, stop.city) : null));
                rows.push(row);
                return h('li', {}, row);
            })));
    }

    // MARK: Loading

    (async () => {
        let pattern;
        try {
            pattern = await staticData(patternKey(provider, line), PATTERN_MAX_AGE_MS, () => provider.routePattern(line));
        } catch (error) {
            console.warn('[line card] stops', error);
            if (!cancelled) note('COULDN’T LOAD THIS LINE’S STOPS.');
            return;
        }
        if (cancelled) return;
        showStops(pattern);
        mapQuiet.hidden = true;
        await mapReady;
        if (cancelled) return;
        drawStops();
        reframe(false);

        try {
            shape = await loadRouteShape(provider, line, pattern);
        } catch (error) {
            console.warn('[line card] route', error);
            if (!cancelled) note('COULDN’T LOAD THE ROUTE MAP. TRY AGAIN LATER.');
            return;
        }
        if (cancelled) return;
        if (!shape) { note('NO ROUTE MAP FOR THIS LINE.'); return; }
        routeMap?.setRoutes([{ color, branches: shape.branches }]);
        drawStops();
        reframe(true);
    })();
}

export function closeLineCard() {
    for (const card of [...cards].reverse()) card.sheet.dismiss();
}

/** Where the line goes, named as in the row it was opened from, or its number when the feed says nothing. */
function titleFor(line, stops) {
    return line.destination ?? line.headsign ?? stops.at(-1)?.name ?? `Line ${line.shortName}`;
}

/**
 * The line under the title, which never says the title again: where the line sets out from, or,
 * when the title is a headsign rather than the last stop, the whole way from end to end. Each name
 * is isolated so a Hebrew or Arabic one keeps its side of the arrow. Null for a loop that ends where
 * it is named, or a feed that names no origin.
 */
export function subtitleFor(title, origin, terminus) {
    if (!origin || origin === title) return null;
    if (terminus && terminus !== title && terminus !== origin) return `‎⁨${origin}⁩ → ⁨${terminus}⁩`;
    return `From ${origin}`;
}
