// The board: the stop's name and the clock, the route map with the buses on it, and the readout —
// the next arrival in big numbers, then the one after it.

import { h, icon, badge, colorIndexFor, isLightTheme, clockTime, countdown, delayPhrase, lastStopPhrase, plural, lineShortLabel, serviceCaption } from '../ui.js';
import { isNumbered, lineLabel, lineTitle } from '../transit/model.js';
import { store } from '../storage.js';
import { BoardModel } from './model.js';
import { renderMap, railColor } from '../map/index.js';
import { go, session } from '../main.js';
import { friendly } from '../setup/stops.js';
import { openFullRoute, closeFullRoute } from './full-route-view.js';
import { showStopCard, closeStopCard } from './stop-card.js';
import { showLineCard, closeLineCard } from './line-card.js';
import { hasRouteShape } from '../transit/shapes/route-shape.js';

export function showBoard(root, { board, provider, region }) {
    const configuration = { stop: board.stop, lines: board.lines };
    const color = (lineID) => colorIndexFor(provider.id, board.lines.find((l) => l.id === lineID) ?? { id: lineID });

    const model = new BoardModel(provider, configuration, () => renderAll());
    let hasTappedOnce = false;
    let wakeLock = null;
    let fullView = null;

    // Header
    const clock = h('span', { class: 'clock' });
    const live = h('span', { class: 'live' }, h('i', { class: 'live-dot' }), h('span', { class: 'live-label' }, 'CONNECTING'));
    const menu = h('div', { class: 'menu', hidden: true, role: 'menu' },
        h('button', { role: 'menuitem', onclick: () => { closeMenu(); openFull(); } }, icon('route', 18), 'Full lines view'),
        h('button', { role: 'menuitem', onclick: () => { closeMenu(); toggleWall(); } }, icon('expand', 18), 'Wall mode'),
        h('button', { role: 'menuitem', onclick: () => { closeMenu(); store.closeBoard(); go('setup'); } }, 'Choose another stop'),
    );
    const gear = h('button', { class: 'icon-button', 'aria-label': 'Board options', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } }, icon('gear', 24));
    const closeMenu = () => { menu.hidden = true; };

    // The code printed on the sign, when the feed's id is one; an internal id helps nobody.
    const code = /^[\w-]{1,12}$/.test(board.stop.code) ? `STOP ${board.stop.code}` : null;
    const caption = [code, board.stop.city].filter(Boolean).join(' · ');
    // Beside the stop's name where there is room for it, in a rounded rect of its own so it reads
    // as the button it is; a phone keeps the room for the name, and has the same view first in the
    // options menu.
    const fullButton = h('button', {
        class: 'icon-button full-route-button', 'aria-label': 'Full lines view', title: 'Full lines view',
        onclick: (e) => { e.stopPropagation(); closeMenu(); openFull(); },
    }, icon('route', 18));
    // The back arrow is the way to another stop; the stop's name keeps the stop and changes which
    // of its lines are watched.
    const nameButton = h('button', {
        class: 'board-name', dir: 'auto', 'aria-label': `${board.stop.name}, change lines`, title: 'Change lines',
        onclick: (e) => { e.stopPropagation(); closeMenu(); changeLines(); },
    }, h('span', { class: 'board-name-text' }, board.stop.name));
    const header = h('header', { class: 'board-head' },
        h('button', { class: 'icon-button back', 'aria-label': 'Choose another stop', onclick: () => { store.closeBoard(); go('setup'); } }, icon('back', 26)),
        h('div', { class: 'board-title' },
            h('div', { class: 'board-name-row' }, h('h1', { dir: 'auto' }, nameButton), fullButton),
            caption ? h('p', { class: 'caption' }, caption) : null),
        h('div', { class: 'board-status' }, live, clock, h('div', { class: 'menu-wrap' }, gear, menu)),
    );

    // Map
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'map-svg');
    svg.setAttribute('role', 'img');
    const mapNote = h('p', { class: 'map-note', hidden: true });
    const mapBox = h('div', { class: 'board-map', onclick: () => model.dismissTapped() }, svg, mapNote);

    // Readout
    const readout = h('section', { class: 'readout', 'aria-live': 'polite' });
    const foot = h('footer', { class: 'board-foot' },
        provider.attribution ? h('span', {}, provider.attribution) : null,
        region.fit === 'arrivalsOnly' ? h('span', {}, `${region.name}: arrival times only, no bus positions.`) : null);

    const screen = h('main', { class: 'screen board' }, header, mapBox, readout, foot);
    root.append(screen);

    // MARK: The full lines view and the stop card

    /** London's "(Stop RC)" pole letters are on the sign, not worth a map's scarce width. */
    const mapName = (name) => name.replace(/\s*\(Stop [A-Z0-9]{1,3}\)$/i, '');

    function vehiclesOn(lines) {
        const ringed = model.ringedBusID;
        return model.snapshot.buses
            .filter((bus) => lines.some((l) => l.id === bus.lineID))
            .map((bus) => ({ id: bus.id, lineID: bus.lineID, lastStopIndex: bus.lastStopIndex, progressToNext: bus.progressToNext, isSelected: bus.id === ringed }));
    }

    function openFull() {
        fullView = openFullRoute({
            stopName: board.stop.name,
            read: () => {
                const full = model.snapshot.fullPatterns;
                const lines = board.lines
                    .filter((line) => full[line.id]?.stops.length >= 2)
                    .map((line) => ({
                        ...mapLine(line), colorIndex: color(line.id),
                        stops: full[line.id].stops.map((s) => ({ code: s.stop.code, name: mapName(s.stop.name) })),
                    }));
                const note = model.lastError && !model.lastSuccessAt ? friendly(model.lastError)
                    : model.lastSuccessAt ? 'NO ROUTE TO DRAW FOR THESE LINES RIGHT NOW.' : 'LOADING THE ROUTE…';
                return { lines, userStopCode: board.stop.code, vehicles: vehiclesOn(lines), note };
            },
            onStopTap: openStop,
            routeMap: {
                provider,
                lines: board.lines,
                colorIndex: color,
                userStopCode: board.stop.code,
                pattern: (lineID) => model.snapshot.fullPatterns[lineID] ?? null,
                // Each bus by the stop it last passed, named by code: the board counts stops on the
                // route as far as the rider's stop, the map on the whole of it.
                buses: () => {
                    const ringed = model.ringedBusID;
                    return model.snapshot.buses.map((bus) => ({
                        id: bus.id, lineID: bus.lineID, progressToNext: bus.progressToNext, isSelected: bus.id === ringed,
                        lastStopCode: model.snapshot.patterns[bus.lineID]?.stops[bus.lastStopIndex]?.stop.code ?? null,
                    }));
                },
                onAboutLine: openLine,
            },
        });
    }

    /** A watched line's card, with the board's stop picked out on it. */
    function openLine(line) {
        showLineCard({ line, provider, stopCode: board.stop.code, colorIndex: color(line.id) });
    }

    /**
     * The readout's ⓘ, one per line and kept between the second-by-second redraws, so a keyboard
     * that is on it stays on it.
     */
    const aboutButtons = new Map();
    function aboutButton(line) {
        if (!line || !hasRouteShape(provider, line)) return null;
        if (!aboutButtons.has(line.id)) {
            aboutButtons.set(line.id, h('button', {
                class: 'line-info readout-info', 'aria-label': `About ${lineLabel(line)}`, title: 'Route and stops',
                onclick: (e) => { e.stopPropagation(); openLine(line); },
            }, icon('info', 20)));
        }
        return aboutButtons.get(line.id);
    }

    function openStop(code) {
        const stop = model.stopByCode(code);
        if (!stop) return;
        showStopCard({
            stop, providerID: provider.id, provider, watched: board.lines, isRidersStop: stop.code === board.stop.code,
            linesAtStop: () => provider.linesAtStop(stop),
        });
    }

    function changeLines() {
        session.stop = board.stop;
        session.preselected = board.lines;
        go('lines');
    }

    // MARK: Rendering

    function renderAll() {
        renderHeader();
        renderMapNow();
        renderReadout();
        fullView?.update();
    }

    function renderHeader(now = Date.now()) {
        clock.textContent = clockTime(new Date(now));
        const state = model.liveState(now);
        live.dataset.state = state;
        live.lastElementChild.textContent = state === 'live' ? 'LIVE' : state === 'stale' ? 'STALE' : 'CONNECTING';
        live.title = model.lastSuccessAt ? `Updated ${clockTime(new Date(model.lastSuccessAt))}` : '';
    }

    function renderMapNow() {
        const { patterns } = model.snapshot;
        const lines = board.lines
            .filter((line) => patterns[line.id]?.stops.length >= 2)
            .map((line) => ({
                ...mapLine(line), colorIndex: color(line.id),
                // London's "(Stop RC)" pole letters are on the sign, not worth a map's scarce width.
                stops: patterns[line.id].stops.map((s) => ({ code: s.stop.code, name: mapName(s.stop.name) })),
            }));
        const vehicles = vehiclesOn(lines);
        const { width, height } = mapBox.getBoundingClientRect();
        if (!lines.length) {
            svg.replaceChildren();
            mapNote.hidden = false;
            mapNote.textContent = model.lastError && !model.lastSuccessAt ? friendly(model.lastError)
                : model.lastSuccessAt ? 'NO ROUTE TO DRAW FOR THESE LINES RIGHT NOW.' : 'LOADING THE ROUTE…';
            return;
        }
        mapNote.hidden = true;
        const trunk = lines.some((l) => l.id === model.trunkLineID) ? model.trunkLineID : lines[0].id;
        try {
            renderMap(svg, {
                lines, trunkLineID: trunk, userStopCode: board.stop.code, vehicles,
                width: Math.max(1, width), height: Math.max(1, height),
                theme: isLightTheme() ? 'light' : 'dark',
                // Where the layout has room for it (landscape), until the rider has tapped once.
                hint: !hasTappedOnce && vehicles.length > 0,
                onBusTap: (id) => { hasTappedOnce = true; model.tap(id); },
                onStopTap: openStop,
            });
        } catch (error) {
            console.error('[map]', error);
        }
        svg.setAttribute('aria-label', `Route map of ${plural(lines.length, 'line', 'lines')} to ${board.stop.name}, with ${plural(vehicles.length, 'bus', 'buses')} on the way`);
    }

    function renderReadout(now = Date.now()) {
        const focused = document.activeElement;
        const hadFocus = readout.contains(focused);
        drawReadout(now);
        if (hadFocus && focused.isConnected && !readout.contains(document.activeElement)) focused.focus({ preventScroll: true });
    }

    function drawReadout(now) {
        const primary = model.primary;
        if (!primary) {
            const message = model.isAwaitingFirstBoard ? 'CONNECTING…'
                : model.lastError && !model.lastSuccessAt ? friendly(model.lastError)
                    : 'NO BUSES DUE';
            const detail = model.isAwaitingFirstBoard ? null
                : model.lastError && !model.lastSuccessAt ? 'Trying again shortly.'
                    : `None of ${board.lines.map(lineShortLabel).join(', ')} is due here soon. The board keeps checking.`;
            readout.replaceChildren(h('div', { class: 'readout-empty' }, h('p', { class: 'readout-empty-title' }, message), detail ? h('p', { class: 'readout-empty-detail' }, detail) : null));
            return;
        }
        const light = isLightTheme();
        const p = primary.arrival;
        const pColor = color(p.lineID);
        const pc = countdown(p.expectedAt, now);
        const sub = [];
        if (primary.kicker === 'SELECTED BUS' && p.bus) {
            const left = lastStopPhrase(p.bus, now);
            if (left) sub.push(h('span', { class: 'sub-stops' }, left));
        } else if (p.bus) {
            sub.push(h('span', { class: 'sub-stops' }, p.bus.stopsAway === 1 ? '1 STOP AWAY' : `${p.bus.stopsAway} STOPS AWAY`));
        }
        sub.push(h('span', { class: 'sub-time' }, `ARRIVES ${clockTime(p.expectedAt)}`));
        const late = delayPhrase(p.delay);
        if (late) sub.push(h('span', { class: `sub-delay${p.delay > 0 ? ' late' : ''}` }, late));
        if (!p.isRealtime) sub.push(h('span', { class: 'sub-tag' }, 'SCHEDULED'));

        const primaryBlock = h('div', { class: 'readout-primary' },
            h('div', { class: 'readout-badge-ring' }, badge(primary.line ?? { shortName: '?' }, pColor, 'big')),
            h('div', { class: 'readout-main' },
                h('div', { class: 'kicker-row' }, h('p', { class: 'kicker' }, primary.kicker), aboutButton(primary.line)),
                serviceName(primary.line),
                h('p', { class: 'minutes' },
                    h('b', { class: pc.now ? 'now' : '' }, pc.figure),
                    // In dark mode the unit takes the line's colour; on cream it goes grey.
                    pc.unit ? h('small', { style: light ? null : { color: railColor(pColor, false) } }, pc.unit) : null),
                h('p', { class: 'subline' }, joinDots(sub))));

        const secondary = model.secondary;
        let thenBlock = null;
        if (secondary) {
            const s = secondary.arrival;
            const sc = countdown(s.expectedAt, now);
            const subS = [];
            // A line without a number says where it goes: its badge alone cannot.
            if (secondary.line && !isNumbered(secondary.line)) subS.push(h('span', { class: 'then-service', dir: 'auto' }, lineShortLabel(secondary.line)));
            if (s.bus) subS.push(h('span', {}, plural(s.bus.stopsAway, 'STOP', 'STOPS')));
            subS.push(h('span', {}, clockTime(s.expectedAt)));
            if (!s.isRealtime) subS.push(h('span', { class: 'sub-tag' }, 'SCHEDULED'));
            thenBlock = h('div', { class: 'readout-then' },
                h('p', { class: 'kicker' }, 'THEN'),
                h('div', { class: 'then-row' },
                    badge(secondary.line ?? { shortName: '?' }, color(s.lineID), 'medium'),
                    h('p', { class: 'minutes minutes-small' }, h('b', {}, sc.figure), sc.unit ? h('small', {}, sc.unit) : null),
                    h('p', { class: 'subline subline-then' }, joinDots(subS))));
        }
        readout.replaceChildren(primaryBlock, thenBlock ?? h('div', { class: 'readout-then readout-then-empty' }, h('p', { class: 'kicker' }, 'THEN'), h('p', { class: 'then-none' }, 'NOTHING ELSE DUE YET')));
    }

    // MARK: Wall mode: full screen, kept awake, always dark.

    async function toggleWall() {
        if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); return; }
        document.body.classList.add('wall');
        try { await document.documentElement.requestFullscreen?.(); } catch { /* iPhone Safari: no full screen, the class still applies */ }
        try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
        renderAll();
    }
    const onFullscreen = () => {
        if (document.fullscreenElement) return;
        document.body.classList.remove('wall');
        wakeLock?.release().catch(() => {});
        wakeLock = null;
        renderAll();
    };
    document.addEventListener('fullscreenchange', onFullscreen);

    // MARK: Lifecycle

    const tick = setInterval(() => { renderHeader(); renderReadout(); }, 1000);
    const resize = new ResizeObserver(() => renderMapNow());
    resize.observe(mapBox);
    const outside = () => closeMenu();
    document.addEventListener('click', outside);
    // A hidden tab asks nothing of the feeds; coming back refreshes at once.
    const visibility = async () => {
        if (document.hidden) { model.stopPolling(); return; }
        if (document.body.classList.contains('wall') && !wakeLock) {
            try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not granted */ }
        }
        model.start();
        model.refreshNow();
    };
    document.addEventListener('visibilitychange', visibility);

    renderAll();
    model.start();

    return () => {
        // The card first: each puts back the page's scrolling as it found it, so they unwind in order.
        closeStopCard();
        closeLineCard();
        closeFullRoute();
        model.stopPolling();
        clearInterval(tick);
        resize.disconnect();
        document.removeEventListener('click', outside);
        document.removeEventListener('visibilitychange', visibility);
        document.removeEventListener('fullscreenchange', onFullscreen);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        document.body.classList.remove('wall');
        wakeLock?.release().catch(() => {});
    };
}

/** What the map draws in a line's badge: its number, or for one without, its mode's glyph. */
function mapLine(line) {
    return { id: line.id, number: isNumbered(line) ? String(line.shortName).trim() : '', mode: line.mode ?? null, label: lineShortLabel(line) };
}

/** Under the kicker, for a line without a number: where it goes, and who runs it. */
function serviceName(line) {
    if (!line || isNumbered(line)) return null;
    const caption = lineTitle(line) ? serviceCaption(line) : null;
    // Each name isolated in a span of its own, so a Hebrew one keeps its script's order without
    // pulling the readout's alignment over to the right.
    return h('p', { class: 'readout-service' }, h('span', { dir: 'auto' }, lineShortLabel(line)),
        caption ? h('small', {}, h('span', { dir: 'auto' }, caption)) : null);
}

function joinDots(parts) {
    // Each dot travels with the fragment after it, so a wrapped line never ends on one.
    return parts.map((part, i) => (i ? h('span', { class: 'sub-part' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), part) : part));
}
