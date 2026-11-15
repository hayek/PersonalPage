// US, Philadelphia — SEPTA's keyless public API (www3.septa.org/api). Buses and trackless trolleys
// only. Port of BusBus/Transit/Providers/SEPTAProvider.swift.
//
// - Stops, the lines at a stop, nearby stops and a line's stops in order come from
//   `web/data/septa-bus-stops.json`, the same file the app carries (built from SEPTA's own bus GTFS
//   by the app repo's scripts/septa-stop-index.py; ~250 KB gzipped, fetched once and then revalidated
//   by the browser). The API has no stop search and no "routes at this stop", so nothing here asks it.
// - Bus positions: `v2/trips/?route_id=`, read straight from the browser (it sends
//   `Access-Control-Allow-Origin: *`).
// - Minutes: `BusSchedules`, the timetable only (SEPTA publishes no realtime ETA). It sends no CORS
//   headers, so it comes through the web relay (the `webTransit` Cloud Function), which holds no key.
//   Some of its backends answer HTTP 501 with the next day's trips; only 200s are used, asking again.
//
// Licence: free use and redistribution of the data; SEPTA's marks are not used. Credited "Data: SEPTA".

import { Capability, TransitError, fold, makeLine, meters, modeFromRouteType } from '../model.js';
import { getJSON, memo, zonedTime } from '../http.js';

const API = 'https://www3.septa.org/api';
const RELAY = 'https://me-west1-busbus-ios.cloudfunctions.net/webTransit/septa';
const INDEX_URL = new URL('../../../data/septa-bus-stops.json', import.meta.url).href;
const TIME_ZONE = 'America/New_York';
/** Asks of `BusSchedules` before giving up; each lands on a backend afresh. */
const SCHEDULE_ATTEMPTS = 3;

/** The bundled network: stops by code, line per route direction, patterns and who calls where. */
function network() {
    return memo('septa:network', Infinity, async () => {
        const file = await getJSON(INDEX_URL, { timeout: 60_000 });
        const stops = new Map();
        for (const [code, [name, lat, lon]] of Object.entries(file.stops ?? {})) {
            stops.set(code, { stop: { code, name, city: null, location: { lat, lon } }, folded: fold(name) });
        }
        const lines = new Map();
        const patterns = new Map();
        const servedBy = new Map();
        for (const route of file.routes ?? []) {
            for (const direction of route.directions ?? []) {
                const pattern = direction.stops.filter((code) => stops.has(code)).map((code) => stops.get(code).stop);
                if (pattern.length < 2) continue;
                const key = `${route.id}:${direction.id}`;
                const to = direction.to || pattern.at(-1).name;
                lines.set(key, makeLine({
                    id: key, shortName: route.short, headsign: to, agency: 'SEPTA', origin: pattern[0].name, destination: to,
                    longName: route.long || null, mode: modeFromRouteType(route.type),
                    providerRefs: { route: route.id, direction: direction.id },
                }));
                patterns.set(key, pattern);
                for (const code of new Set(direction.stops)) {
                    if (!stops.has(code)) continue;
                    if (!servedBy.has(code)) servedBy.set(code, []);
                    servedBy.get(code).push(key);
                }
            }
        }
        return { stops, lines, patterns, servedBy };
    });
}

/** The route directions that call at the stop; one that only ends here only when nothing else calls. */
function linesAt(net, code) {
    const serving = net.servedBy.get(code) ?? [];
    const through = serving.filter((key) => net.patterns.get(key).at(-1).code !== code);
    return (through.length ? through : serving).map((key) => net.lines.get(key));
}

function ref(line) {
    const [route, direction = '0'] = String(line.id).split(':');
    return { route: line.providerRefs?.route ?? route, direction: line.providerRefs?.direction ?? direction };
}

/** "11/15/26 01:04 pm", Philadelphia local time. */
function parseCalendar(text) {
    const match = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{1,2}):(\d{2}) ([ap]m)$/i.exec(String(text ?? '').trim());
    if (!match) return null;
    const [, mm, dd, yy, h, min, half] = match;
    const hour = (Number(h) % 12) + (half.toLowerCase() === 'pm' ? 12 : 0);
    const instant = zonedTime(`20${yy}-${mm}-${dd}`, `${hour}:${min}:00`, TIME_ZONE);
    return Number.isNaN(instant.getTime()) ? null : instant;
}

/** @type {import('../model.js').TransitProvider} */
const provider = {
    id: 'septa',
    displayName: 'SEPTA (Philadelphia)',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    // Vehicle fixes are 1–20 s old; a poll is one small trips call plus the timetable.
    refreshSeconds: 20,
    datasetID: 'septa',
    attribution: 'Data: SEPTA',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        const net = await network();
        if (/^\d+$/.test(text)) {
            const hit = net.stops.get(text);
            return hit ? [hit.stop] : [];
        }
        // "7th and Spring Garden": the names write "&", which folding drops.
        const words = fold(text).split(/\s+/).filter((w) => w && w !== 'and');
        if (!words.length) return [];
        const needle = words.join(' ');
        const rank = (s) => (s.folded === needle ? 0 : s.folded.startsWith(needle) ? 1 : 2);
        return [...net.stops.values()]
            .filter((s) => words.every((w) => s.folded.includes(w)))
            .sort((a, b) => rank(a) - rank(b) || a.stop.name.localeCompare(b.stop.name, 'en') || a.stop.code.localeCompare(b.stop.code))
            .slice(0, 40)
            .map((s) => s.stop);
    },

    async linesAtStop(stop) {
        return linesAt(await network(), stop.code);
    },

    async routePattern(line) {
        const r = ref(line);
        const stops = (await network()).patterns.get(`${r.route}:${r.direction}`);
        if (!stops) throw new TransitError('notFound', `stops of route ${r.route} direction ${r.direction}`);
        return { line, stops: stops.map((stop, i) => ({ stop, sequence: i + 1, distanceAlongRoute: null })) };
    },

    async vehicles(line) {
        const r = ref(line);
        const trips = await memo(`septa:trips:${r.route}`, 10_000, () => getJSON(`${API}/v2/trips/`, { query: { route_id: r.route } }));
        const result = [];
        for (const t of trips ?? []) {
            if (String(t.route_id) !== r.route || String(t.direction_id ?? '') !== r.direction) continue;
            const lat = Number.parseFloat(t.lat);
            const lon = Number.parseFloat(t.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const heading = Number.parseFloat(t.heading);
            result.push({
                location: { lat, lon },
                // Trips without a fix carry seconds-of-day here instead of a Unix time.
                recordedAt: t.timestamp > 1_000_000_000 ? new Date(t.timestamp * 1000) : null,
                tripId: t.trip_id ?? null,
                bearing: Number.isFinite(heading) ? heading : null,
            });
        }
        return result;
    },

    /** Timetable departures of the line at the stop (SEPTA has no realtime ETA). */
    async arrivals(line, stop) {
        const r = ref(line);
        const schedule = await memo(`septa:schedule:${stop.code}:${r.route}`, 30_000, async () => {
            let last;
            for (let attempt = 0; attempt < SCHEDULE_ATTEMPTS; attempt++) {
                try {
                    return await getJSON(`${RELAY}/BusSchedules/index.php`, { query: { stop_id: stop.code, req2: r.route, req6: '10' } });
                } catch (error) {
                    last = error;
                }
            }
            throw last;
        });
        return (schedule?.[r.route] ?? [])
            .filter((t) => String(t.Direction) === r.direction)
            .map((t) => {
                const at = parseCalendar(t.DateCalender);
                return at ? { expectedAt: at, scheduledAt: at, isRealtime: false, tripId: t.trip_id ?? null } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.expectedAt - b.expectedAt);
    },

    /** Stops within the radius, nearest first, with the lines that call there. */
    async stopsNearby(point, radiusMeters) {
        const net = await network();
        return [...net.stops.values()]
            .map((s) => ({ stop: s.stop, distanceMeters: meters(point, s.stop.location) }))
            .filter((n) => n.distanceMeters <= radiusMeters)
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .slice(0, 15)
            .map((n) => ({ ...n, lines: linesAt(net, n.stop.code) }))
            .filter((n) => n.lines.length);
    },
};

export default provider;
