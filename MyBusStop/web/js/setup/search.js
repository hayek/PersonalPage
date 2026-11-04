// The search screen, as the app has it (BusBus/Setup/Search): a field to type into, the map edge to
// edge under it, and the stops in view in a drawer over the map's foot — or, in a window wider than
// it is tall, in a panel beside it.
//
// The map and the list show the same stops, and a tap on either is the same tap: both open the
// confirm step, where the stop is centred on the map and said in full with the lines that call
// there, so nothing is chosen by a mis-tap on a small pin. SELECT STOP slides the line picker over
// the confirm step, inside this screen, and the picker's way back is to the confirm step as it was.
//
// It lies over the home rather than replacing it, and walks the browser's history: Back from the
// line picker is the confirm step, Back from the confirm step is the list as it was left, and Back
// from the list is the home. Opening the board, or CANCEL, takes the screen's entries off again.

import { h, icon, badge, colorIndexFor, distanceText, plural } from '../ui.js';
import { store } from '../storage.js';
import { WORLDWIDE, regionsContaining } from '../transit/regions.js';
import { Capability, compareLines, isNumbered, lineLabel, lineTitle } from '../transit/model.js';
import { session, providerFor } from '../main.js';
import { showLines } from './lines.js';
import { friendly, whereabouts } from './stops.js';
import { hasRouteShape } from '../transit/shapes/route-shape.js';
import { showLineCard, closeLineCard } from '../board/line-card.js';
import { createSearchMap, metresBetween, searchRadius, SEARCHABLE_SPAN } from './search-map.js';

/** As in the app: stops within 500 m, widened to 1 km when fewer than four are that close. */
const NEARBY_RADII = [500, 1000];
/** The most stops listed and pinned at once (SetupViewModel.mapResultLimit). */
const LIMIT = 40;
/** A list around the rider is shown again, without asking, for this long. */
const NEARBY_FRESH_MS = 3 * 60_000;
/** Drawer heights (DrawerHeights): the header strip alone, a little under half, and up to a band of map. */
const SMALL = 120;
const MAP_PEEK = 150;
const STEP_DEPTH = { map: 1, confirm: 2, lines: 3 };

/** Kept for the visit only, never stored: the rider's location is used and forgotten. */
let rider = null;
let lastNearby = null;
/** Lines already looked up at a stop this visit, so the confirm step and the picker ask once. */
const linesAsked = new Map();

/** The screen while it is open, else null. */
let screen = null;

export const searchIsOpen = () => screen != null;
/** How many history entries the screen has pushed: one for the list, one more each for confirm and lines. */
export const searchDepth = () => (screen ? STEP_DEPTH[screen.step] : 0);

/** The browser moved to one of the screen's own entries (Back or Forward). */
export function searchPopped(state) {
    screen?.popTo(state?.step ?? 'map');
}

/** Takes the screen down. True when the region changed under it, so the home must be drawn again. */
export function closeSearch() {
    if (!screen) return false;
    const changed = screen.regionChanged;
    screen.teardown();
    screen = null;
    return changed;
}

/**
 * Opens the screen over the home, always fresh: an empty field, no stop picked, the drawer at its
 * resting height, and the list around the rider.
 * @param {{onCancel: () => void}} options CANCEL's way out, which takes the screen's history off
 */
export function openSearch({ onCancel }) {
    if (screen) return;
    history.pushState({ screen: 'search', step: 'map' }, '', `${location.pathname}${location.search}#search`);
    screen = buildScreen({ onCancel });
}

function buildScreen({ onCancel }) {
    let provider = session.provider;
    const self = { step: 'map', regionChanged: false, popTo, teardown };

    // MARK: State

    let query = '';
    let searchTimer = null;
    let searchToken = 0;
    /** @type {{state: 'idle'|'searching'|'done'|'error', stops: object[], error?: Error}} */
    let results = { state: 'idle', stops: [] };
    /** What the list shows when nothing is typed. */
    let list = { kind: 'nearby', state: 'idle', stops: [], radius: null, error: null };
    let stopsToken = 0;
    /** 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported' */
    let permission = 'geolocation' in navigator ? 'unknown' : 'unsupported';
    let locating = false;
    /** Where the last list was asked around: the rider, or the middle of the map. */
    let listCenter = null;
    let userMoved = false;

    let drawer = 'medium';
    let confirming = null;
    let confirmToken = 0;
    let confirmLines = { state: 'loading', lines: [] };
    let restore = null;
    let linesTeardown = null;
    let mapView = null;
    let mapFailed = false;
    let lastFocusHeight = null;

    // MARK: Elements

    const input = h('input', {
        type: 'search', class: 'search-input', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search',
        'aria-label': 'Search stops',
    });
    const clearButton = h('button', { type: 'button', class: 'search-clear', 'aria-label': 'Clear', hidden: true,
        onclick: () => { input.value = ''; queryChanged(); input.focus(); } }, icon('close', 16));
    const field = h('form', { class: 'search search-field', role: 'search', onsubmit: (e) => e.preventDefault() },
        icon('search', 20), input, clearButton);
    const cancel = h('button', { type: 'button', class: 'search-cancel', onclick: () => onCancel() }, 'CANCEL');

    const mapBox = h('div', { class: 'search-map' });
    const mapNote = h('p', { class: 'search-map-note', hidden: true });
    const hereButton = h('button', { type: 'button', class: 'search-here', hidden: true, onclick: searchHere });
    const recenter = h('button', { type: 'button', class: 'search-recenter', hidden: true, 'aria-label': 'Show stops around me', title: 'Stops around me',
        onclick: () => findNearby({ fresh: true }) }, icon('locate', 22));

    const listTitle = h('h2', {});
    const listAside = h('span', { class: 'section-aside' });
    const handle = h('div', { class: 'sheet-handle', 'aria-hidden': 'true' }, h('span'));
    const listHead = h('div', { class: 'sheet-head' }, listTitle, listAside);
    const listBody = h('div', { class: 'sheet-body', tabindex: '-1' });
    const listView = h('div', { class: 'sheet-list' }, handle, listHead, listBody);
    const confirmView = h('div', { class: 'sheet-confirm', hidden: true, role: 'region', 'aria-label': 'Confirm the stop' });
    const sheet = h('section', { class: 'search-sheet', 'aria-label': 'Stops' }, listView, confirmView);
    const linesPane = h('div', { class: 'search-lines', hidden: true });
    const body = h('div', { class: 'search-body' }, mapBox, mapNote, hereButton, recenter, sheet);
    const root = h('div', { class: 'search-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Find a stop' },
        h('header', { class: 'search-head' }, field, cancel), body, linesPane);

    // MARK: Mounting

    const app = document.getElementById('app');
    const savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    app.inert = true;
    document.body.append(root);
    document.addEventListener('keydown', onKey);
    const resizeObserver = new ResizeObserver(() => layout());
    resizeObserver.observe(body);

    refreshField();
    layout();
    renderList();
    // On a phone the keyboard would cover the map the rider came for; with a keyboard of its own the
    // field is simply ready.
    if (window.matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true });

    createSearchMap(mapBox, {
        onPinTap: (entry) => beginConfirm(entry),
        onMapTap: () => { if (confirming && self.step === 'confirm') history.back(); },
        onMoved: () => { userMoved = true; },
        covered,
        onError: () => mapUnavailable(),
    }).then((view) => {
        if (screen !== self) { view.remove(); return; }
        mapView = view;
        view.map.on('moveend', () => updateHereButton());
        view.map.on('load', () => updateHereButton());
        if (rider) view.setRider(rider);
        frameNow({ animate: false });
        pinNow();
    }).catch(() => mapUnavailable());

    startNearby();

    input.addEventListener('input', queryChanged);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { clearTimeout(searchTimer); if (query) runSearch(query); input.blur(); }
    });

    // MARK: Layout

    function isPanel() {
        const { width, height } = body.getBoundingClientRect();
        return width > height && width >= 600;
    }

    function heights() {
        const area = body.clientHeight;
        const large = Math.max(0, area - MAP_PEEK);
        const medium = Math.min(window.innerHeight * 0.45, large);
        return { small: Math.min(SMALL, medium), medium, large };
    }

    function layout({ animate = true } = {}) {
        const panel = isPanel();
        root.classList.toggle('is-panel', panel);
        root.classList.toggle('is-drawer', !panel);
        root.classList.toggle('is-confirming', confirming != null);
        sheet.classList.toggle('no-animate', !animate);
        if (panel) {
            sheet.style.height = '';
            sheet.style.maxHeight = '';
        } else if (confirming) {
            // As tall as its lines need, up to a cap that leaves the stop room on the map above.
            const hs = heights();
            sheet.style.height = 'auto';
            sheet.style.maxHeight = `${Math.min(hs.large, Math.max(hs.medium, (hs.large + MAP_PEEK) * 0.6))}px`;
        } else {
            sheet.style.maxHeight = '';
            sheet.style.height = `${heights()[drawer]}px`;
        }
        sheet.classList.toggle('is-large', !panel && !confirming && drawer === 'large');
        updateCover();
    }

    /** How much of the map the drawer, the panel or the confirm panel hides. */
    function covered() {
        if (isPanel()) return { bottom: 0, left: sheet.offsetWidth };
        if (confirming) return { bottom: sheet.offsetHeight, left: 0 };
        return { bottom: heights()[drawer], left: 0 };
    }

    /** The recenter button rides on the drawer, and the search-here capsule centres over the map left uncovered. */
    function updateCover(shownHeight = null) {
        const panel = isPanel();
        // The height the drawer is going to, not the one it is animating from.
        const height = shownHeight ?? (confirming ? sheet.offsetHeight : heights()[drawer]);
        body.style.setProperty('--cover-bottom', `${panel ? 0 : height}px`);
        body.style.setProperty('--cover-left', `${panel ? sheet.offsetWidth : 0}px`);
    }

    function setDrawer(height) {
        if (drawer === height) return;
        drawer = height;
        layout();
    }

    // Dragging the drawer: by its handle and head at any height, and by its list below its tallest,
    // where the list does not scroll yet. A flick goes on to the next height; a nudge settles back.
    let drag = null;
    let suppressClick = false;
    sheet.addEventListener('pointerdown', (event) => {
        if (isPanel() || confirming || event.button > 0) return;
        const onHead = handle.contains(event.target) || listHead.contains(event.target);
        if (!onHead && drawer === 'large') return;
        drag = { id: event.pointerId, y: event.clientY, start: sheet.offsetHeight, moved: false, samples: [{ y: event.clientY, t: event.timeStamp }] };
    });
    sheet.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.abs(dy) < 6) return;
        if (!drag.moved) {
            drag.moved = true;
            try { sheet.setPointerCapture(event.pointerId); } catch { /* a pointer the page no longer holds */ }
            sheet.classList.add('dragging');
        }
        const hs = heights();
        const height = Math.min(hs.large, Math.max(hs.small, drag.start - dy));
        sheet.style.height = `${height}px`;
        updateCover(height);
        drag.samples.push({ y: event.clientY, t: event.timeStamp });
        if (drag.samples.length > 5) drag.samples.shift();
    });
    const endDrag = (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const wasDrag = drag.moved;
        const { samples, start, y } = drag;
        drag = null;
        sheet.classList.remove('dragging');
        if (!wasDrag) return;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        const first = samples[0];
        const last = samples.at(-1);
        const velocity = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0; // px per ms, down is positive
        const projected = start - (event.clientY - y) - velocity * 180;
        const hs = heights();
        const nearest = Object.entries(hs).reduce((a, b) => (Math.abs(b[1] - projected) < Math.abs(a[1] - projected) ? b : a))[0];
        drawer = nearest;
        layout();
        if (mapView && !userMoved) frameNow();
    };
    sheet.addEventListener('pointerup', endDrag);
    sheet.addEventListener('pointercancel', endDrag);
    sheet.addEventListener('click', (event) => {
        if (suppressClick) { event.stopPropagation(); event.preventDefault(); }
    }, true);
    // A wheel over the list raises the drawer first, and lowers it again from the list's top.
    listBody.addEventListener('wheel', (event) => {
        if (isPanel() || confirming) return;
        if (drawer !== 'large' && event.deltaY > 4) { event.preventDefault(); setDrawer('large'); }
        else if (drawer === 'large' && listBody.scrollTop <= 0 && event.deltaY < -24) { setDrawer('medium'); }
    }, { passive: false });
    handle.addEventListener('click', () => {
        if (!isPanel()) setDrawer(drawer === 'large' ? 'medium' : drawer === 'medium' ? 'large' : 'medium');
    });

    // MARK: The field

    function refreshField() {
        const byName = provider.capabilities.has(Capability.stopSearchByName);
        input.placeholder = byName ? 'Search a stop, street or line' : 'Enter the stop code from the sign';
        input.inputMode = byName ? 'search' : 'numeric';
    }

    function queryChanged() {
        const before = query;
        query = input.value.trim();
        clearButton.hidden = !input.value;
        clearTimeout(searchTimer);
        // The first letter pulls the drawer up to show the results, and clearing the field lets it
        // settle again; a drawer pulled down while typing stays down through the next letters.
        if (!before !== !query) setDrawer(query ? 'large' : 'medium');
        if (!query) {
            searchToken++;
            results = { state: 'idle', stops: [] };
            renderList();
            pinNow();
            if (!before !== !query) frameNow();
            return;
        }
        if (results.state !== 'searching') { results = { state: 'searching', stops: results.stops }; renderList(); }
        searchTimer = setTimeout(() => runSearch(query), 350);
    }

    async function runSearch(term) {
        const token = ++searchToken;
        results = { state: 'searching', stops: results.stops };
        renderList();
        try {
            const stops = await provider.searchStops(term);
            if (token !== searchToken || screen !== self) return;
            results = { state: 'done', stops: stops.slice(0, LIMIT).map((stop) => ({ stop, distanceMeters: -1, lines: [] })) };
            renderList();
            pinNow();
            frameNow();
        } catch (error) {
            if (token !== searchToken || screen !== self) return;
            results = { state: 'error', stops: [], error };
            renderList();
            pinNow();
        }
    }

    function showingResults() { return query.length > 0; }
    /** What the map pins and the list names: the same stops, in the same order. */
    function shownStops() { return showingResults() ? results.stops : list.stops; }

    // MARK: Nearby and this area

    function supportsNearby() { return typeof provider.stopsNearby === 'function' && provider.capabilities.has(Capability.nearbyStops); }

    async function startNearby() {
        if (lastNearby && lastNearby.regionID === session.region.id && Date.now() - lastNearby.at < NEARBY_FRESH_MS) {
            list = { kind: 'nearby', state: 'ready', stops: lastNearby.stops, radius: lastNearby.radius, error: null };
            listCenter = lastNearby.point;
            renderList();
            pinNow();
            frameNow({ animate: false });
            return;
        }
        if (permission !== 'unsupported') {
            try {
                const status = await navigator.permissions?.query({ name: 'geolocation' });
                if (status) permission = status.state;
            } catch { /* Not every browser can say; the card asks. */ }
        }
        if (screen !== self) return;
        if (permission === 'granted') findNearby();
        else renderList();
    }

    function locate({ fresh = false } = {}) {
        return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }), reject,
            { enableHighAccuracy: true, timeout: 15_000, maximumAge: fresh ? 10_000 : 60_000 }));
    }

    async function findNearby({ fresh = false } = {}) {
        if (permission === 'unsupported') return;
        locating = true;
        list = { ...list, state: 'loading' };
        renderList();
        let point;
        try {
            point = await locate({ fresh });
        } catch (error) {
            locating = false;
            if (screen !== self) return;
            if (error?.code === 1) permission = 'denied';
            list = { kind: 'nearby', state: error?.code === 1 ? 'idle' : 'error', stops: [], radius: null,
                error: error?.code === 1 ? null : new Error('Couldn’t find your location. Search instead, or move the map and search this area.') };
            renderList();
            pinNow();
            updateHereButton();
            return;
        }
        locating = false;
        if (screen !== self) return;
        permission = 'granted';
        rider = point;
        mapView?.setRider(point);
        userMoved = false;
        await loadAround(point, { isArea: false });
    }

    /**
     * The capsule stays up while an area is being searched, turning, and a tap after the map has
     * moved asks about the new view instead: the earlier answer is let go of when it lands (the
     * token), and a tap on the same view asks nothing twice.
     */
    function searchHere() {
        if (!mapView) return;
        if (areaLoading() && !userMoved) return;
        const { center, span } = mapView.visibleArea();
        if (span > SEARCHABLE_SPAN) return;
        userMoved = false;
        loadAround(center, { isArea: true, radius: searchRadius(span) });
    }

    /** The region follows the stops: a stop in Oslo is not found by asking London. */
    async function adoptRegion(point) {
        const covering = regionsContaining(point);
        const current = session.region;
        if (current.id !== WORLDWIDE.id && covering.some((r) => r.id === current.id)) return;
        const best = covering[0];
        if (best.id === current.id) return;
        session.region = best;
        store.setRegion(best.id);
        provider = await providerFor(best);
        self.regionChanged = true;
        refreshField();
        if (query) runSearch(query);
    }

    async function loadAround(point, { isArea, radius = null }) {
        const token = ++stopsToken;
        listCenter = point;
        await adoptRegion(point);
        if (token !== stopsToken || screen !== self) return;
        if (!supportsNearby()) {
            list = { kind: isArea ? 'area' : 'nearby', state: 'unavailable', stops: [], radius: null, error: null };
            renderList();
            pinNow();
            updateHereButton();
            return;
        }
        list = { ...list, kind: isArea ? 'area' : 'nearby', state: 'loading' };
        renderList();
        updateHereButton();
        try {
            const radii = isArea ? [radius] : NEARBY_RADII;
            let used = radii[0];
            let stops = await provider.stopsNearby(point, used);
            for (const wider of radii.slice(1)) {
                if (stops.length >= 4) break;
                used = wider;
                stops = await provider.stopsNearby(point, used);
            }
            if (token !== stopsToken || screen !== self) return;
            // A row's distance is always how far the rider would walk, not how far from the map's middle.
            if (isArea && rider) stops = stops.map((entry) => ({ ...entry, distanceMeters: metresBetween(rider, entry.stop.location) }));
            stops = stops.slice(0, LIMIT);
            list = { kind: isArea ? 'area' : 'nearby', state: 'ready', stops, radius: used, error: null };
            if (!isArea) lastNearby = { regionID: session.region.id, stops, radius: used, point, at: Date.now() };
            renderList();
            pinNow();
            if (!isArea) frameNow();
        } catch (error) {
            if (token !== stopsToken || screen !== self) return;
            list = { kind: isArea ? 'area' : 'nearby', state: 'error', stops: [], radius: null, error };
            renderList();
            pinNow();
        }
        updateHereButton();
    }

    // MARK: The map

    function pinNow() {
        if (!mapView) return;
        mapView.setPins(shownStops(), { numbered: showingResults() });
        mapView.setFocus(confirming?.stop.code ?? null);
        updateHereButton();
    }

    /** Frames what the list shows: the results, or the stops around the rider with the rider among them. */
    function frameNow({ animate = true } = {}) {
        if (!mapView || confirming) return;
        const stops = shownStops().map((e) => e.stop.location);
        if (showingResults()) {
            if (stops.length) mapView.fit(stops, { animate });
            return;
        }
        if (list.kind === 'area') return;
        if (stops.length) mapView.fit(rider ? [rider, ...stops] : stops, { animate });
        else if (rider) mapView.fit([rider], { animate });
        else mapView.fitRegion(session.region.bounds);
        userMoved = false;
    }

    /** SEARCH THIS AREA once the map is moved, and always while nothing is listed; past a city's width, ZOOM IN TO SEARCH. */
    function areaLoading() { return list.kind === 'area' && list.state === 'loading'; }

    function updateHereButton() {
        if (!mapView || confirming || showingResults()) { hereButton.hidden = true; return; }
        const loading = areaLoading();
        const empty = !list.stops.length && list.state !== 'loading' && !locating;
        if (!userMoved && !empty && !loading) { hereButton.hidden = true; return; }
        const { span } = mapView.visibleArea();
        const tooWide = span > SEARCHABLE_SPAN;
        // Still turning once the map has moved on: a tap there asks about the new view.
        const spinning = loading && !(userMoved && tooWide);
        hereButton.hidden = false;
        hereButton.disabled = tooWide && !spinning;
        hereButton.classList.toggle('is-loading', spinning);
        hereButton.setAttribute('aria-busy', String(spinning));
        hereButton.replaceChildren(...[
            spinning ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null,
            tooWide && !spinning ? 'ZOOM IN TO SEARCH' : 'SEARCH THIS AREA',
            spinning ? h('span', { class: 'visually-hidden' }, ', searching') : null].filter(Boolean));
    }

    function mapUnavailable() {
        if (mapFailed) return;
        mapFailed = true;
        mapNote.hidden = false;
        mapNote.textContent = 'THE MAP COULDN’T LOAD. THE LIST STILL WORKS.';
    }

    // MARK: The list

    function renderList() {
        recenter.hidden = !rider || confirming != null;
        const searching = showingResults();
        listTitle.textContent = searching ? 'RESULTS' : list.kind === 'area' ? 'THIS AREA' : 'NEARBY';
        listAside.textContent = searching ? '' : caption();
        listAside.classList.toggle('shimmer', list.state === 'loading');
        const parts = [];
        if (searching) {
            parts.push(resultRows());
        } else {
            const terms = store.recentSearches;
            if (terms.length) {
                parts.push(h('div', { class: 'search-terms', role: 'list', 'aria-label': 'Recent searches' },
                    terms.map((term) => h('button', { type: 'button', class: 'search-term', role: 'listitem',
                        onclick: () => { input.value = term; queryChanged(); clearTimeout(searchTimer); runSearch(term); } },
                    icon('search', 14), term))));
            }
            parts.push(...nearbyParts());
        }
        parts.push(serviceFooter());
        listBody.replaceChildren(...parts.filter(Boolean));
        updateHereButton();
    }

    function caption() {
        const within = list.radius == null ? '' : list.radius >= 1000 ? `${list.radius / 1000} KM` : `${list.radius} M`;
        switch (list.state) {
            case 'loading': return list.kind === 'area' ? 'LOOKING HERE…' : 'FINDING STOPS NEAR YOU…';
            case 'ready': return list.kind === 'area' ? `${plural(list.stops.length, 'STOP', 'STOPS')} IN THIS AREA` : `${plural(list.stops.length, 'STOP', 'STOPS')} WITHIN ${within}`;
            case 'unavailable': return 'NOT AVAILABLE HERE';
            case 'error': return 'NO ANSWER';
            default: return '';
        }
    }

    function nearbyParts() {
        const parts = [];
        if (list.state === 'unavailable') {
            parts.push(h('p', { class: 'status' }, `NEARBY STOPS AREN’T AVAILABLE FOR ${session.region.name.toUpperCase()}. SEARCH BY NAME INSTEAD.`));
            return parts;
        }
        if (list.state === 'error') {
            parts.push(h('p', { class: 'status status-error' }, friendly(list.error)));
        }
        if (list.state === 'loading' && !list.stops.length) {
            parts.push(skeleton(4, true));
            return parts;
        }
        if (!list.stops.length && list.kind === 'nearby' && list.state !== 'loading') {
            if (permission === 'denied' || permission === 'unsupported') {
                parts.push(h('div', { class: 'location-card' },
                    h('p', { class: 'location-card-title' }, permission === 'denied' ? 'LOCATION IS OFF FOR THIS SITE' : 'THIS BROWSER CAN’T SHARE YOUR LOCATION'),
                    h('p', { class: 'hint-text' }, 'Search a stop by name, or move the map and search that area.',
                        permission === 'denied' ? ' To list the stops around you, allow location for this site in your browser.' : ''),
                    h('button', { type: 'button', class: 'button button-secondary', onclick: () => input.focus() }, icon('search', 20), 'SEARCH BY NAME')));
                return parts;
            }
            if (list.state !== 'error') {
                parts.push(h('div', { class: 'location-card' },
                    h('p', { class: 'location-card-title' }, 'STOPS AROUND YOU'),
                    h('p', { class: 'hint-text' }, 'Your location is used once to find stops around you, and never stored.'),
                    h('button', { type: 'button', class: 'button button-primary', onclick: () => findNearby() }, icon('locate', 20), 'FIND STOPS NEAR ME')));
                parts.push(skeleton(3, false));
                return parts;
            }
        }
        if (list.state === 'ready' && !list.stops.length) {
            parts.push(h('p', { class: 'status' }, list.kind === 'area'
                ? 'NO STOPS IN THIS AREA. MOVE THE MAP AND TRY AGAIN.'
                : 'NO STOPS NEAR YOU. SEARCH BY NAME, OR MOVE THE MAP AND SEARCH THAT AREA.'));
            return parts;
        }
        if (list.stops.length) {
            const showsDistance = list.kind === 'nearby' || rider != null;
            parts.push(h('ul', { class: `rows sheet-rows${list.state === 'loading' ? ' shimmer' : ''}` },
                list.stops.map((entry) => listRow(entry, { distance: showsDistance ? entry.distanceMeters : null, lines: entry.lines }))));
        }
        return parts;
    }

    function resultRows() {
        if (results.state === 'error') return h('p', { class: 'status status-error' }, friendly(results.error));
        if (!results.stops.length && results.state === 'searching') return skeleton(4, false);
        if (!results.stops.length) {
            return h('p', { class: 'status' }, provider.capabilities.has(Capability.stopSearchByName) ? 'NO STOPS MATCH. TRY ANOTHER NAME.' : 'NO STOP WITH THAT CODE.');
        }
        return h('ul', { class: `rows sheet-rows${results.state === 'searching' ? ' shimmer' : ''}` },
            results.stops.map((entry, index) => listRow(entry, { number: index + 1 })));
    }

    /** A stop in the drawer: a tap opens the confirm step, as its pin does. */
    function listRow(entry, { distance = null, number = null, lines = [] }) {
        const where = whereabouts(entry.stop);
        const shown = lines.slice(0, 3);
        return h('li', { class: 'row-item', dataset: { code: entry.stop.code } },
            h('button', { type: 'button', class: 'row sheet-row', onclick: () => beginConfirm(entry) },
                number != null ? h('span', { class: 'row-number', 'aria-label': `Stop ${number}` }, String(number))
                    : distance != null && distance >= 0 ? h('span', { class: 'row-distance' }, distanceText(distance)) : null,
                h('span', { class: 'row-text' },
                    h('span', { class: 'row-title', dir: 'auto' }, entry.stop.name),
                    where ? h('span', { class: 'row-caption', dir: 'auto' }, where) : null),
                shown.length ? h('span', { class: 'row-badges' },
                    shown.map((line) => badge(line, colorIndexFor(provider.id, line))),
                    lines.length > 3 ? h('span', { class: 'row-more' }, `+${lines.length - 3}`) : null) : null));
    }

    function skeleton(count, shimmers) {
        return h('ul', { class: `rows sheet-rows skeleton${shimmers ? ' shimmer' : ''}`, 'aria-hidden': 'true' },
            Array.from({ length: count }, (_, i) => h('li', { class: 'row-item' },
                h('div', { class: 'row sheet-row' },
                    h('span', { class: 'skeleton-block', style: { width: '44px', height: '14px' } }),
                    h('span', { class: 'row-text' },
                        h('span', { class: 'skeleton-block', style: { width: `${[62, 48, 70, 55][i % 4]}%`, height: '18px' } }),
                        h('span', { class: 'skeleton-block', style: { width: `${[40, 52, 34, 46][i % 4]}%`, height: '10px' } }))))));
    }

    /** Whose stops these are, a way to switch where operators overlap (Hong Kong), and the credit line. */
    function serviceFooter() {
        const region = session.region;
        const at = listCenter ?? rider;
        const here = at ? regionsContaining(at).filter((r) => r.id !== WORLDWIDE.id) : [];
        const regionLine = here.length > 1 && here.some((r) => r.id === region.id)
            ? h('label', { class: 'sheet-region' }, h('span', {}, 'STOPS FROM'),
                h('select', {
                    'aria-label': 'Operator',
                    onchange: async (e) => {
                        const chosen = here.find((r) => r.id === e.target.value);
                        if (!chosen) return;
                        session.region = chosen;
                        store.setRegion(chosen.id);
                        provider = await providerFor(chosen);
                        self.regionChanged = true;
                        refreshField();
                        if (query) runSearch(query);
                        if (listCenter) loadAround(listCenter, { isArea: list.kind === 'area', radius: list.radius ?? 500 });
                    },
                }, here.map((r) => h('option', { value: r.id, selected: r.id === region.id }, r.name))))
            : h('p', {}, region.id === WORLDWIDE.id ? 'STOPS WORLDWIDE, FROM TRANSITOUS' : `STOPS IN ${region.name.toUpperCase()}`);
        const note = region.id === WORLDWIDE.id
            ? 'Outside the regions listed, times come from Transitous, a community-run service fed by agencies’ open data. It has arrival times but no bus positions.'
            : region.fit === 'arrivalsOnly' ? `${region.name} publishes arrival times but not bus positions, so the board shows the route without buses.` : null;
        return h('footer', { class: 'sheet-foot' },
            regionLine,
            note ? h('p', { class: 'sheet-note' }, note) : null,
            provider.attribution ? h('p', { class: 'attribution' }, provider.attribution) : null);
    }

    // MARK: The confirm step

    function beginConfirm(entry) {
        // A second tap on the stop being asked about does nothing: BACK is the way out.
        if (confirming) return;
        input.blur();
        restore = { drawer, scrollTop: listBody.scrollTop, camera: mapView?.camera() ?? null, code: entry.stop.code };
        confirming = entry;
        const token = ++confirmToken;
        history.pushState({ screen: 'search', step: 'confirm' }, '', location.href);
        self.step = 'confirm';
        field.classList.add('is-held');
        input.disabled = true;

        const known = entry.lines?.length ? entry.lines : linesAsked.get(linesKey(entry.stop));
        confirmLines = known ? { state: known.length ? 'lines' : 'none', lines: [...known].sort(compareLines) } : { state: 'loading', lines: [] };
        renderConfirm();
        listView.hidden = true;
        confirmView.hidden = false;
        layout();
        mapView?.setFocus(entry.stop.code);
        hereButton.hidden = true;
        recenter.hidden = true;
        lastFocusHeight = sheet.offsetHeight;
        mapView?.focusOn(entry.stop.location);
        confirmView.querySelector('.confirm-name')?.focus({ preventScroll: true });

        if (known) return;
        provider.linesAtStop(entry.stop).then((found) => {
            linesAsked.set(linesKey(entry.stop), found);
            if (token !== confirmToken) return;
            confirmLines = { state: found.length ? 'lines' : 'none', lines: [...found].sort(compareLines) };
            renderConfirm();
            refocusIfResized();
        }).catch((error) => {
            if (token !== confirmToken) return;
            confirmLines = { state: 'error', lines: [], error };
            renderConfirm();
            refocusIfResized();
        });
    }

    function linesKey(stop) { return `${provider.id}:${stop.code}`; }

    /** The panel grew or shrank once its lines came: the stop is centred again above it, not left under it. */
    function refocusIfResized() {
        if (!confirming || isPanel()) return;
        const height = sheet.offsetHeight;
        if (lastFocusHeight != null && Math.abs(height - lastFocusHeight) <= 12) return;
        lastFocusHeight = height;
        mapView?.focusOn(confirming.stop.location);
    }

    function renderConfirm() {
        const entry = confirming;
        const metres = rider ? metresBetween(rider, entry.stop.location) : null;
        const walk = metres != null ? `${distanceText(metres)} · ${Math.max(1, Math.ceil(metres / 80))} MIN WALK` : null;
        const code = signCode(entry.stop.code);
        const where = [entry.stop.address, entry.stop.city].filter((p, i, all) => p && all.findIndex((q) => q?.toLowerCase() === p.toLowerCase()) === i).join(' · ');

        let linesArea;
        if (confirmLines.state === 'loading') {
            linesArea = h('div', { class: 'confirm-lines shimmer', 'aria-label': 'Loading lines', role: 'status' },
                [150, 110, 130].map((w) => h('div', { class: 'confirm-line' },
                    h('span', { class: 'skeleton-block', style: { width: '34px', height: '34px', borderRadius: '8px' } }),
                    h('span', { class: 'skeleton-block', style: { width: `${w}px`, height: '12px' } }))));
        } else if (confirmLines.state === 'lines') {
            linesArea = h('ul', { class: 'confirm-lines', 'aria-label': 'Lines at this stop' }, confirmLines.lines.map((line) => {
                const destination = isNumbered(line)
                    ? line.destination ?? line.headsign ?? line.longName ?? line.agency
                    : lineTitle(line) ?? line.agency;
                return h('li', { class: 'confirm-line' },
                    badge(line, colorIndexFor(provider.id, line)),
                    h('span', { class: 'confirm-line-title', dir: 'auto' }, destination ?? ''),
                    hasRouteShape(provider, line) ? h('button', {
                        type: 'button', class: 'line-info', 'aria-label': `About ${lineLabel(line)}`, title: 'Route and stops',
                        onclick: () => showLineCard({ line, provider, stopCode: entry.stop.code, colorIndex: colorIndexFor(provider.id, line) }),
                    }, icon('info', 20)) : null);
            }));
        } else {
            linesArea = h('p', { class: `confirm-quiet${confirmLines.state === 'error' ? ' status-error' : ''}` },
                confirmLines.state === 'none' ? 'NO LINES STOP HERE' : friendly(confirmLines.error));
        }

        const canSelect = confirmLines.state !== 'none';
        confirmView.replaceChildren(...[
            h('div', { class: 'confirm-caption' },
                h('span', { class: 'confirm-ask' }, 'THIS STOP?'),
                walk ? h('span', { class: 'confirm-walk' }, walk) : null),
            h('h2', { class: 'confirm-name', dir: 'auto', tabindex: '-1' }, entry.stop.name),
            where || code ? h('p', { class: 'confirm-where' },
                where ? h('span', { class: 'confirm-address', dir: 'auto' }, where) : null,
                code ? h('span', { class: 'confirm-code' }, `STOP ${code}`) : null) : null,
            linesArea,
            h('div', { class: 'confirm-actions' },
                h('button', { type: 'button', class: 'button button-outline confirm-back', onclick: () => history.back() },
                    h('span', { class: 'flip-rtl' }, icon('chevronBack', 20)), 'BACK'),
                h('button', { type: 'button', class: 'button button-primary confirm-select', disabled: !canSelect, onclick: selectStop },
                    'SELECT STOP', h('span', { class: 'flip-rtl' }, icon('chevronForward', 20)))),
        ].filter(Boolean));
    }

    /** Back from the confirm step: the drawer at its height and scroll, and the map where it was. */
    function endConfirm() {
        if (!confirming) return;
        const was = restore;
        confirming = null;
        confirmToken++;
        restore = null;
        lastFocusHeight = null;
        field.classList.remove('is-held');
        input.disabled = false;
        confirmView.hidden = true;
        confirmView.replaceChildren();
        listView.hidden = false;
        mapView?.setFocus(null);
        if (was) drawer = was.drawer;
        layout();
        renderList();
        if (was) {
            listBody.scrollTop = was.scrollTop;
            mapView?.restore(was.camera);
            const row = listBody.querySelector(`.row-item[data-code="${CSS.escape(was.code)}"] .row`);
            row?.focus({ preventScroll: true });
        }
        updateHereButton();
    }

    function selectStop() {
        if (!confirming) return;
        if (showingResults()) store.rememberSearch(query);
        const stop = confirming.stop;
        session.stop = stop;
        // A stop already among My stops comes back with the lines the rider watched there.
        const saved = store.history.find((entry) => entry.providerID === provider.id && entry.stop.code === stop.code);
        session.preselected = saved?.lines ?? [];
        session.knownLines = confirmLines.state === 'lines' ? { providerID: provider.id, code: stop.code, lines: confirmLines.lines } : null;
        history.pushState({ screen: 'search', step: 'lines' }, '', `${location.pathname}${location.search}#lines`);
        self.step = 'lines';
        showLinesPane();
    }

    function showLinesPane() {
        linesTeardown?.();
        linesPane.replaceChildren();
        linesPane.hidden = false;
        linesPane.scrollTop = 0;
        body.inert = true;
        root.querySelector('.search-head').inert = true;
        linesTeardown = showLines(linesPane) ?? null;
        linesPane.querySelector('.lines-head .round-button')?.focus({ preventScroll: true });
    }

    function hideLinesPane() {
        linesTeardown?.();
        linesTeardown = null;
        linesPane.hidden = true;
        linesPane.replaceChildren();
        body.inert = false;
        root.querySelector('.search-head').inert = false;
        confirmView.querySelector('.confirm-select')?.focus({ preventScroll: true });
    }

    // MARK: History and keys

    function popTo(step) {
        if (step === self.step) return;
        if (self.step === 'lines' && step !== 'lines') hideLinesPane();
        if (step === 'map') {
            endConfirm();
        } else if (step === 'confirm' && !confirming) {
            // Forward into a confirm step this screen no longer has: stay on the list.
            history.replaceState({ screen: 'search', step: 'map' }, '', location.href);
            step = 'map';
        } else if (step === 'lines' && self.step === 'confirm' && session.stop) {
            showLinesPane();
        }
        self.step = step;
    }

    function onKey(event) {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        // A field with text in it clears on Escape first, as a search field does.
        if (event.target === input && input.value) return;
        event.preventDefault();
        if (self.step === 'map') onCancel();
        else history.back();
    }

    function teardown() {
        clearTimeout(searchTimer);
        searchToken++;
        stopsToken++;
        confirmToken++;
        linesTeardown?.();
        closeLineCard();
        resizeObserver.disconnect();
        document.removeEventListener('keydown', onKey);
        mapView?.remove();
        root.remove();
        app.inert = false;
        document.body.style.overflow = savedOverflow;
    }

    return self;
}

/**
 * The code printed on the stop's sign, when the provider's id is one: short, letters and digits.
 * Many providers key stops on long internal ids ("NSR:Quay:7203") no sign carries.
 */
function signCode(code) {
    const text = String(code ?? '');
    return /^[A-Za-z0-9]{1,8}$/.test(text) && /\d/.test(text) ? text : null;
}
