// CHOOSE YOUR STOP: search, the boards opened before, and stops near the rider.

import { h, icon, badge, colorIndexFor, distanceText, plural } from '../ui.js';
import { store } from '../storage.js';
import { REGIONS, WORLDWIDE, regionByID, regionsContaining } from '../transit/regions.js';
import { Capability } from '../transit/model.js';
import { session, go, providerFor, applyTheme } from '../main.js';

/** As in the app: stops within 500 m, widened to 1 km when nothing is that close. */
const NEARBY_RADII = [500, 1000];
/** Kept for the visit only, never stored: the rider's location is used and forgotten. */
let lastPoint = null;
let lastNearby = null;

export function showSetup(root) {
    const provider = session.provider;
    const region = session.region;
    const searchesByName = provider.capabilities.has(Capability.stopSearchByName);
    let searchTimer = null;
    let searchToken = 0;

    const input = h('input', {
        type: 'search', class: 'search-input', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search',
        placeholder: searchesByName ? 'Search a stop, street or line' : 'Enter the stop code from the sign',
        'aria-label': 'Search stops',
        inputmode: searchesByName ? 'search' : 'numeric',
    });
    const results = h('section', { class: 'results', hidden: true, 'aria-label': 'Search results' });
    const nearbyBody = h('div', { class: 'nearby-body' });
    const nearbyCount = h('span', { class: 'section-aside' });

    const regionSelect = h('select', { class: 'region-select', 'aria-label': 'Region' },
        groupOptions(region.id));
    regionSelect.addEventListener('change', async () => {
        const chosen = regionByID(regionSelect.value) ?? WORLDWIDE;
        store.setRegion(chosen.id);
        session.region = chosen;
        lastNearby = null;
        await providerFor(chosen);
        go('setup', { push: false });
    });

    const themeSelect = h('select', { class: 'theme-select', 'aria-label': 'Theme' },
        ['system', 'light', 'dark'].map((t) => h('option', { value: t, selected: store.theme === t }, t === 'system' ? 'System' : t[0].toUpperCase() + t.slice(1))));
    themeSelect.addEventListener('change', () => { store.setTheme(themeSelect.value); applyTheme(); go('setup', { push: false }); });

    input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const query = input.value.trim();
        if (!query) { results.hidden = true; results.replaceChildren(); return; }
        searchTimer = setTimeout(() => runSearch(query), 350);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { clearTimeout(searchTimer); const q = input.value.trim(); if (q) runSearch(q); }
    });

    async function runSearch(query) {
        const token = ++searchToken;
        results.hidden = false;
        results.replaceChildren(h('p', { class: 'status' }, 'SEARCHING…'));
        try {
            const stops = await provider.searchStops(query);
            if (token !== searchToken) return;
            results.replaceChildren(
                h('div', { class: 'section-head' }, h('h2', {}, 'RESULTS'), h('span', { class: 'section-aside' }, plural(stops.length, 'STOP', 'STOPS'))),
                stops.length
                    ? h('ul', { class: 'rows' }, stops.slice(0, 30).map((stop) => stopRow(stop, { onclick: () => pick(stop) })))
                    : h('p', { class: 'status' }, searchesByName ? 'NO STOPS FOUND. TRY ANOTHER NAME.' : 'NO STOP WITH THAT CODE.'),
            );
        } catch (error) {
            if (token !== searchToken) return;
            results.replaceChildren(h('p', { class: 'status status-error' }, friendly(error)));
        }
    }

    function pick(stop, lines = []) {
        session.stop = stop;
        session.preselected = lines;
        go('lines');
    }

    // History
    const history = store.sortedHistory();
    const historySection = history.length ? h('section', { class: 'history' },
        h('div', { class: 'section-head' }, h('h2', {}, 'HISTORY')),
        h('ul', { class: 'rows' }, history.map((entry) => historyRow(entry))),
    ) : null;

    function historyRow(entry) {
        const row = stopRow(entry.stop, {
            lines: entry.lines, providerID: entry.providerID,
            caption: regionByID(entry.regionID)?.name,
            onclick: () => { store.openBoard(entry); go('board'); },
        });
        const remove = h('button', { class: 'row-remove', 'aria-label': `Remove ${entry.stop.name} from history`, title: 'Remove',
            onclick: (e) => { e.stopPropagation(); store.forget(entry.id); go('setup', { push: false }); } }, icon('close', 16));
        row.append(remove);
        return row;
    }

    // Nearby
    const supportsNearby = typeof provider.stopsNearby === 'function' && provider.capabilities.has(Capability.nearbyStops);
    const locateButton = h('button', { class: 'button button-secondary locate', onclick: () => findNearby() },
        icon('locate', 20), 'FIND STOPS NEAR ME');

    async function findNearby() {
        if (!('geolocation' in navigator)) {
            nearbyBody.replaceChildren(h('p', { class: 'status' }, 'THIS BROWSER CAN’T SHARE YOUR LOCATION. SEARCH INSTEAD.'));
            return;
        }
        nearbyBody.replaceChildren(h('p', { class: 'status' }, 'FINDING YOU…'));
        let point;
        try {
            point = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
                (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }), reject,
                { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 }));
        } catch (error) {
            nearbyBody.replaceChildren(h('p', { class: 'status' }, error?.code === 1
                ? 'LOCATION IS OFF FOR THIS SITE. SEARCH INSTEAD, OR ALLOW IT IN YOUR BROWSER.'
                : 'COULDN’T FIND YOUR LOCATION. SEARCH INSTEAD.'));
            return;
        }
        lastPoint = point;
        // The region follows the rider: a stop in Oslo is not found by asking London.
        const covering = regionsContaining(point);
        if (!covering.some((r) => r.id === session.region.id) || session.region.id === WORLDWIDE.id) {
            const best = covering[0];
            if (best.id !== session.region.id) {
                session.region = best;
                store.setRegion(best.id);
                await providerFor(best);
                lastNearby = { regionID: best.id, stops: null };
                return go('setup', { push: false });
            }
        }
        await loadNearby(point);
    }

    async function loadNearby(point) {
        nearbyBody.replaceChildren(h('p', { class: 'status' }, 'LOOKING FOR STOPS…'),
            provider.nearbyNote ? h('p', { class: 'hint-text' }, provider.nearbyNote) : null);
        try {
            let radius = NEARBY_RADII[0];
            let stops = await provider.stopsNearby(point, radius);
            if (!stops.length) {
                radius = NEARBY_RADII[1];
                stops = await provider.stopsNearby(point, radius);
            }
            lastNearby = { regionID: session.region.id, stops, radius };
            renderNearby(stops, radius);
        } catch (error) {
            nearbyBody.replaceChildren(h('p', { class: 'status status-error' }, friendly(error)));
        }
    }

    function renderNearby(stops, radius = NEARBY_RADII[1]) {
        const within = radius >= 1000 ? `${radius / 1000} KM` : `${radius} M`;
        nearbyCount.textContent = `${plural(stops.length, 'STOP', 'STOPS')} WITHIN ${within}`;
        nearbyBody.replaceChildren(stops.length
            ? h('ul', { class: 'rows' }, stops.slice(0, 20).map((nearby) => stopRow(nearby.stop, {
                lines: nearby.lines, providerID: provider.id, distance: nearby.distanceMeters,
                onclick: () => pick(nearby.stop),
            })))
            : h('p', { class: 'status' }, `NO STOPS WITHIN ${within}. SEARCH INSTEAD.`));
    }

    const nearbySection = h('section', { class: 'nearby' },
        h('div', { class: 'section-head' }, h('h2', {}, 'NEARBY'), nearbyCount),
        nearbyBody);
    if (!supportsNearby) {
        nearbyBody.append(h('p', { class: 'status' }, `NEARBY STOPS AREN’T AVAILABLE FOR ${region.name.toUpperCase()}. SEARCH INSTEAD.`));
    } else if (lastNearby?.regionID === region.id && lastNearby.stops) {
        renderNearby(lastNearby.stops, lastNearby.radius);
    } else if (lastNearby?.regionID === region.id && lastPoint) {
        loadNearby(lastPoint);
    } else {
        nearbyBody.append(h('p', { class: 'hint-text' }, 'Your location is used once to find stops around you, and never stored.'), locateButton);
    }

    const attribution = provider.attribution ? h('p', { class: 'attribution' }, provider.attribution) : null;
    const worldNote = region.id === WORLDWIDE.id
        ? h('p', { class: 'note' }, 'Outside the regions listed, times come from Transitous, a community-run service fed by agencies’ open data. It has arrival times but no bus positions, so the map shows the route without buses.')
        : region.fit === 'arrivalsOnly'
            ? h('p', { class: 'note' }, `${region.name} publishes arrival times but not bus positions, so the map shows the route without buses.`)
            : null;

    root.append(h('main', { class: 'screen setup' },
        h('header', { class: 'setup-head' },
            h('a', { class: 'home-link', href: '../', 'aria-label': 'About My Bus Stop' }, h('img', { src: '../Assets/icon.svg', alt: '', width: 40, height: 40 })),
            h('h1', {}, 'CHOOSE YOUR STOP'),
        ),
        h('div', { class: 'region-row' },
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'REGION'), regionSelect),
            h('label', { class: 'field field-narrow' }, h('span', { class: 'field-label' }, 'THEME'), themeSelect),
        ),
        h('form', { class: 'search', role: 'search', onsubmit: (e) => e.preventDefault() }, icon('search', 22), input),
        results,
        h('div', { class: 'setup-grid' }, historySection, nearbySection),
        worldNote,
        h('footer', { class: 'setup-foot' },
            attribution,
            h('p', {}, 'My Bus Stop is an independent app, not made or endorsed by any transit agency. ',
                h('a', { href: '../' }, 'Get it for iPhone, iPad, Mac, Apple Watch and Apple TV'), ' · ',
                h('a', { href: '../privacy/' }, 'Privacy')),
        ),
    ));
    if (!history.length) setTimeout(() => input.focus({ preventScroll: true }), 0);
    return () => clearTimeout(searchTimer);
}

function groupOptions(selectedID) {
    const groups = [...new Set(REGIONS.map((r) => r.group))];
    return [
        ...groups.map((group) => h('optgroup', { label: group },
            REGIONS.filter((r) => r.group === group).map((r) => h('option', { value: r.id, selected: r.id === selectedID }, r.name)))),
        h('optgroup', { label: 'Worldwide' }, h('option', { value: WORLDWIDE.id, selected: selectedID === WORLDWIDE.id }, 'Everywhere else (Transitous)')),
    ];
}

/** A stop in a list: its name, where it is, and the lines that call there. */
function stopRow(stop, { lines = [], providerID = null, distance = null, caption = null, onclick }) {
    // Poles of one stop often share its name; the code tells them apart.
    const where = [stop.address, stop.city, caption, /^[\w-]{1,12}$/.test(stop.code) ? `STOP ${stop.code}` : null].filter((part, i, all) => part && all.findIndex((p) => p?.toLowerCase() === part.toLowerCase()) === i).join(' · ');
    const shown = lines.slice(0, 3);
    return h('li', { class: 'row-item' },
        h('button', { class: 'row', onclick },
            distance != null ? h('span', { class: 'row-distance' }, distanceText(distance)) : null,
            h('span', { class: 'row-text' },
                h('span', { class: 'row-title', dir: 'auto' }, stop.name),
                where ? h('span', { class: 'row-caption', dir: 'auto' }, where) : null),
            shown.length ? h('span', { class: 'row-badges' },
                shown.map((line) => badge(line, colorIndexFor(providerID, line))),
                lines.length > 3 ? h('span', { class: 'row-more' }, `+${lines.length - 3}`) : null) : null,
        ));
}

export function friendly(error) {
    const message = String(error?.message ?? error);
    if (/timed out/.test(message)) return 'THE SERVICE IS TAKING TOO LONG TO ANSWER. TRY AGAIN IN A MOMENT.';
    if (/network|Failed to fetch|Load failed/i.test(message)) return 'CAN’T REACH THE SERVICE. CHECK YOUR CONNECTION AND TRY AGAIN.';
    if (/unsupported|Not supported/i.test(message)) return message.replace(/^Not supported by this provider: /, 'THIS REGION CAN’T DO THAT: ').toUpperCase();
    return `SOMETHING WENT WRONG: ${message}`.toUpperCase();
}
