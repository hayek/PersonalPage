// A stop's card: its name and code, the lines that call there, where it is, and a small map of it.
// Opened by tapping a stop on the board's map, in the full lines view, or by a stop row's ⓘ.
//
// The map is OpenStreetMap's own embed: keyless, and it asks nothing of any service but the one
// drawing the tiles. No geocoder is asked for an address either; the card shows the one the
// provider publishes, or the town.

import { h, icon, badge, colorIndexFor } from '../ui.js';
import { staticData } from '../transit/http.js';
import { compareLineNames } from '../transit/model.js';

/** The lines at a stop change with the timetable, not by the minute. */
const LINES_MAX_AGE_MS = 12 * 3_600_000;
/** About 450 m across at mid latitudes: the stop and the streets either side of it. */
const MAP_SPAN = { lat: 0.0022, lon: 0.0032 };

let open = null;

/**
 * @param {object} options
 * @param {import('../transit/model.js').TransitStop} options.stop
 * @param {string} options.providerID for the lines' colours and the cache key
 * @param {() => Promise<import('../transit/model.js').TransitLine[]>} [options.linesAtStop]
 *   every line at the stop; not asked when `lines` already has them
 * @param {import('../transit/model.js').TransitLine[]} [options.lines] every line at the stop, when known
 * @param {import('../transit/model.js').TransitLine[]} [options.watched] lines the rider watches here, listed first
 * @param {boolean} [options.isRidersStop] the board's own stop
 */
export function showStopCard({ stop, providerID, linesAtStop, lines = null, watched = [], isRidersStop = false }) {
    closeStopCard();
    const returnFocus = document.activeElement;
    const titleID = `stop-card-title-${Math.random().toString(36).slice(2, 8)}`;

    const linesBody = h('div', { class: 'stop-card-lines', 'aria-live': 'polite' });
    const where = [stop.address, stop.city].filter((part, i, all) => part && part.trim()
        && part.trim().toLowerCase() !== stop.name.trim().toLowerCase()
        && all.findIndex((p) => p?.trim().toLowerCase() === part.trim().toLowerCase()) === i).join(' · ');
    // The code printed on the sign, when the feed's id is one; an internal id helps nobody.
    const code = /^[\w-]{1,12}$/.test(stop.code) ? `STOP ${stop.code}` : null;

    const close = h('button', { class: 'round-button stop-card-close', 'aria-label': 'Close', onclick: () => closeStopCard() }, icon('close', 20));
    const card = h('div', { class: 'stop-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleID },
        h('header', { class: 'stop-card-head' },
            h('div', { class: 'stop-card-title' },
                h('p', { class: 'caption' }, [isRidersStop ? 'YOUR STOP' : null, code].filter(Boolean).join(' · ') || 'STOP'),
                h('h2', { id: titleID, dir: 'auto' }, stop.name)),
            close),
        h('section', { class: 'stop-card-section' },
            h('h3', { class: 'stop-card-label' }, 'LINES HERE'),
            linesBody),
        where ? h('section', { class: 'stop-card-section' },
            h('h3', { class: 'stop-card-label' }, 'ADDRESS'),
            h('p', { class: 'stop-card-address', dir: 'auto' }, where)) : null,
        mapBlock(stop),
    );
    const backdrop = h('div', { class: 'stop-card-backdrop', onclick: (e) => { if (e.target === backdrop) closeStopCard(); } }, card);

    // Ahead of every other listener, so Escape here closes the card and not the view under it.
    const onKey = (event) => {
        if (!backdrop.isConnected) return;
        if (event.key === 'Escape') {
            event.stopImmediatePropagation();
            event.preventDefault();
            closeStopCard();
        } else if (event.key === 'Tab') {
            trapFocus(event, card);
        }
    };
    document.addEventListener('keydown', onKey, true);
    const scrollLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.append(backdrop);
    close.focus({ preventScroll: true });

    let cancelled = false;
    open = () => {
        cancelled = true;
        document.removeEventListener('keydown', onKey, true);
        document.body.style.overflow = scrollLock;
        backdrop.remove();
        if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
    };

    const show = (found) => {
        if (cancelled) return;
        if (!found.length) {
            linesBody.replaceChildren(h('p', { class: 'stop-card-quiet' }, 'NO LINES ARE LISTED HERE RIGHT NOW.'));
            return;
        }
        const watchedIDs = watched.map((l) => l.id);
        const sorted = [...found].sort((a, b) => {
            const wa = watchedIDs.indexOf(a.id);
            const wb = watchedIDs.indexOf(b.id);
            if (wa >= 0 || wb >= 0) return (wa < 0 ? Infinity : wa) - (wb < 0 ? Infinity : wb);
            return compareLineNames(a.shortName, b.shortName);
        });
        linesBody.replaceChildren(h('ul', { class: 'stop-card-line-list' }, sorted.map((line) => {
            const isWatched = watchedIDs.includes(line.id);
            const towards = line.destination ?? line.headsign ?? null;
            return h('li', { class: `stop-card-line${isWatched ? ' watched' : ''}` },
                badge(line, colorIndexFor(providerID, line)),
                towards ? h('span', { class: 'stop-card-towards', dir: 'auto' }, towards) : null,
                isWatched ? h('span', { class: 'stop-card-tag' }, 'WATCHING') : null);
        })));
    };

    if (lines?.length) {
        show(lines);
    } else if (linesAtStop) {
        linesBody.replaceChildren(h('p', { class: 'stop-card-quiet' }, h('i', { class: 'spinner', 'aria-hidden': 'true' }), 'LOADING LINES…'));
        staticData(`lines:${providerID}:${stop.code}`, LINES_MAX_AGE_MS, linesAtStop)
            .then(show)
            .catch((error) => {
                console.warn('[stop card] lines', error);
                if (!cancelled) linesBody.replaceChildren(h('p', { class: 'stop-card-quiet' }, 'COULDN’T LOAD THE LINES HERE.'));
            });
    } else {
        show(watched);
    }
}

export function closeStopCard() {
    const close = open;
    open = null;
    close?.();
}

/** The stop on OpenStreetMap's embed, with a way out to the rider's own maps app. */
function mapBlock(stop) {
    const { lat, lon } = stop.location ?? {};
    // A feed that leaves a stop at 0,0 has not placed it; a map of the Gulf of Guinea helps nobody.
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
    const bbox = [lon - MAP_SPAN.lon, lat - MAP_SPAN.lat, lon + MAP_SPAN.lon, lat + MAP_SPAN.lat].map((v) => v.toFixed(5)).join(',');
    const embed = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(6)},${lon.toFixed(6)}`;
    return h('section', { class: 'stop-card-section' },
        h('h3', { class: 'stop-card-label' }, 'ON THE MAP'),
        h('div', { class: 'stop-card-map' },
            h('iframe', { src: embed, title: `Map of ${stop.name}`, loading: 'lazy', referrerpolicy: 'no-referrer' })),
        h('a', { class: 'stop-card-maps-link', href: mapsLink(stop), target: '_blank', rel: 'noopener noreferrer' }, 'OPEN IN MAPS', icon('arrow', 16)));
}

/** Apple Maps on Apple's devices, which hand it to the Maps app; Google Maps everywhere else. */
function mapsLink(stop) {
    const { lat, lon } = stop.location;
    const apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
    return apple
        ? `https://maps.apple.com/?ll=${lat},${lon}&q=${encodeURIComponent(stop.name)}`
        : `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

/** Tab stays inside the card while it is open, as a modal's focus must. */
function trapFocus(event, container) {
    const focusable = [...container.querySelectorAll('a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}
