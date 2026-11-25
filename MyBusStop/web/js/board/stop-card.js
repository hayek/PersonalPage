// A stop's card: its name and code, the lines that call there with when each one's next bus comes,
// where it is, and a small map of it.
// Opened by tapping a stop on the board's map, in the full lines view, or by a stop row's ⓘ.
// A line here whose road can be drawn has an ⓘ of its own, which opens the line's card over this one.
//
// The map is OpenStreetMap's own embed: keyless, and it asks nothing of any service but the one
// drawing the tiles. No geocoder is asked for an address either; the card shows the one the
// provider publishes, or the town.

import { h, icon, badge, colorIndexFor, isLightTheme } from '../ui.js';
import { railColor } from '../map/index.js';
import { staticData } from '../transit/http.js';
import { compareLines, isNumbered, lineLabel, lineTitle } from '../transit/model.js';
import { loadProvider } from '../transit/providers/index.js';
import { hasRouteShape } from '../transit/shapes/route-shape.js';
import { hasArrivals, nextBus, pollArrivals } from '../transit/stop-arrivals.js';
import { presentSheet } from './sheet.js';
import { showLineCard } from './line-card.js';

/** The lines at a stop change with the timetable, not by the minute. */
const LINES_MAX_AGE_MS = 12 * 3_600_000;
/** About 450 m across at mid latitudes: the stop and the streets either side of it. */
const MAP_SPAN = { lat: 0.0022, lon: 0.0032 };

const cards = [];

/**
 * @param {object} options
 * @param {import('../transit/model.js').TransitStop} options.stop
 * @param {string} options.providerID for the lines' colours and the cache key
 * @param {import('../transit/model.js').TransitProvider} [options.provider] for the lines' cards; loaded by id when not given
 * @param {() => Promise<import('../transit/model.js').TransitLine[]>} [options.linesAtStop]
 *   every line at the stop; not asked when `lines` already has them
 * @param {import('../transit/model.js').TransitLine[]} [options.lines] every line at the stop, when known
 * @param {import('../transit/model.js').TransitLine[]} [options.watched] lines the rider watches here, listed first
 * @param {boolean} [options.isRidersStop] the board's own stop
 */
export function showStopCard({ stop, providerID, provider = null, linesAtStop, lines = null, watched = [], isRidersStop = false }) {
    // A stop opened from the top card's own lines replaces it; one under a line's card stays.
    if (cards.at(-1)?.isTop()) cards.at(-1).dismiss();
    const providerReady = provider ? Promise.resolve(provider) : loadProvider(providerID).catch(() => null);
    const titleID = `stop-card-title-${Math.random().toString(36).slice(2, 8)}`;

    // Not a live region: the countdowns in it change every second.
    const linesBody = h('div', { class: 'stop-card-lines' });
    const where = [stop.address, stop.city].filter((part, i, all) => part && part.trim()
        && part.trim().toLowerCase() !== stop.name.trim().toLowerCase()
        && all.findIndex((p) => p?.trim().toLowerCase() === part.trim().toLowerCase()) === i).join(' · ');
    // The code printed on the sign, when the feed's id is one; an internal id helps nobody.
    const code = /^[\w-]{1,12}$/.test(stop.code) ? `STOP ${stop.code}` : null;

    const close = h('button', { class: 'round-button stop-card-close', 'aria-label': 'Close', onclick: () => sheet.dismiss() }, icon('close', 20));
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
    const backdrop = h('div', { class: 'stop-card-backdrop' }, card);

    let cancelled = false;
    let stopPolling = () => {};
    let ticker = null;
    const sheet = presentSheet(backdrop, card, {
        initialFocus: close,
        onClose: () => {
            cancelled = true;
            stopPolling();
            clearInterval(ticker);
            cards.splice(cards.indexOf(sheet), 1);
        },
    });
    cards.push(sheet);

    const show = async (found) => {
        const owner = await providerReady;
        if (cancelled) return;
        if (!found.length) {
            linesBody.replaceChildren(h('p', { class: 'stop-card-quiet', role: 'status' }, 'NO LINES ARE LISTED HERE RIGHT NOW.'));
            return;
        }
        const watchedIDs = watched.map((l) => l.id);
        const sorted = [...found].sort((a, b) => {
            const wa = watchedIDs.indexOf(a.id);
            const wb = watchedIDs.indexOf(b.id);
            if (wa >= 0 || wb >= 0) return (wa < 0 ? Infinity : wa) - (wb < 0 ? Infinity : wb);
            return compareLines(a, b);
        });
        const timed = hasArrivals(owner);
        /** Each line's next arrivals, by id; null until the first answer is in. */
        let arrivals = null;
        const slots = [];
        const drawETAs = () => {
            const now = Date.now();
            for (const { line, el } of slots) el.replaceChildren(...etaParts(arrivals, line, colorIndexFor(providerID, line), now));
        };
        linesBody.replaceChildren(h('ul', { class: 'stop-card-line-list' }, sorted.map((line) => {
            const isWatched = watchedIDs.includes(line.id);
            // A line without a number is named by where it goes, and who runs it.
            const towards = isNumbered(line) ? line.destination ?? line.headsign ?? null
                : [lineTitle(line), line.agency].filter(Boolean).join(' · ') || null;
            // Only where the line's road can be drawn; otherwise there is no card worth opening.
            const about = owner && hasRouteShape(owner, line)
                ? h('button', {
                    class: 'line-info', 'aria-label': `About ${lineLabel(line)}`, title: 'Route and stops',
                    onclick: () => showLineCard({ line, provider: owner, stopCode: stop.code }),
                }, icon('info', 20))
                : null;
            const eta = timed ? h('span', { class: 'stop-card-eta' }) : null;
            if (eta) slots.push({ line, el: eta });
            return h('li', { class: `stop-card-line${isWatched ? ' watched' : ''}` },
                badge(line, colorIndexFor(providerID, line)),
                h('span', { class: 'stop-card-line-text' },
                    towards ? h('span', { class: 'stop-card-towards', dir: 'auto' }, towards) : h('span', { class: 'stop-card-towards' }),
                    isWatched ? h('span', { class: 'stop-card-tag' }, 'WATCHING') : null),
                eta,
                about);
        })));
        if (!timed) return;
        drawETAs();
        // Asked again at the board's pace while the card is open, counting down in between.
        stopPolling = pollArrivals(owner, stop, sorted, (found) => { arrivals = found; drawETAs(); });
        ticker = setInterval(() => { if (arrivals && !document.hidden) drawETAs(); }, 1000);
    };

    if (lines?.length) {
        show(lines);
    } else if (linesAtStop) {
        linesBody.replaceChildren(h('p', { class: 'stop-card-quiet', role: 'status' }, h('i', { class: 'spinner', 'aria-hidden': 'true' }), 'LOADING LINES…'));
        // v2: lines without a number come merged into services, and lines that cannot be boarded here are left out.
        // v3: services split by where they start and the stops they make.
        staticData(`lines.v3:${providerID}:${stop.code}`, LINES_MAX_AGE_MS, linesAtStop)
            .then(show)
            .catch((error) => {
                console.warn('[stop card] lines', error);
                if (!cancelled) linesBody.replaceChildren(h('p', { class: 'stop-card-quiet', role: 'status' }, 'COULDN’T LOAD THE LINES HERE.'));
            });
    } else {
        show(watched);
    }
}

/**
 * "4 MIN" over "THEN 12", as the board counts. A timetable time says SCHEDULED under it instead, as
 * the board's readout does; a spinner until the first answer is in.
 */
function etaParts(arrivals, line, colorIndex, now) {
    if (!arrivals) return [h('i', { class: 'spinner', role: 'img', 'aria-label': 'Loading arrivals' })];
    const next = nextBus(arrivals.get(line.id), now);
    if (!next) return [h('span', { class: 'eta-quiet' }, 'NO BUSES DUE')];
    const light = isLightTheme();
    return [
        h('span', { class: 'eta-main' },
            h('b', {}, next.figure),
            next.unit ? h('small', { style: light ? null : { color: railColor(colorIndex, false) } }, next.unit) : null),
        !next.isRealtime ? h('span', { class: 'eta-tag' }, 'SCHEDULED')
            : next.then ? h('span', { class: 'eta-then' }, `THEN ${next.then.figure}`) : null,
    ];
}

/** Closes every stop card, the board's way out when it goes. */
export function closeStopCard() {
    for (const card of [...cards].reverse()) card.dismiss();
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
