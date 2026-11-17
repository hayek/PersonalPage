// Italy, Turin — GTT (Gruppo Torinese Trasporti): the city and suburban buses and trams with live
// times and positions, and the extraurban buses on their timetable. Keyless open data, CC BY-NC 4.0
// (aperTO) and non-commercial on GTT's own licence page, which a free page with no ads satisfies.
// Port of BusBus/Transit/Providers/GTTProvider.swift (whose reply handling is TrafiklabRegionalProvider's).
//
// The feeds make no sense to a browser on their own: the static GTFS is a 20 MB zip with no CORS
// headers, the realtime names no stop (only each trip's `stop_sequence`), positions name no trip, and
// trip ids change whenever GTT republishes. So everything comes through the web relay (the `webTransit`
// Cloud Function, route `gtt`, functions/src/gtt.ts in the app repo), which holds no key and answers
// from the timetable the app's nightly job builds, moved by GTT's realtime:
//   - `stops`: every pole with the line directions calling there (~120 KB gzipped), searched and
//     ranked by distance here, and kept in the browser for six hours.
//   - `route?id=`: one line's patterns per direction, with their shapes.
//   - `departures?stop=`: one pole's next 90 minutes, the timetable moved by the realtime.
//   - `buses?route=`: one line's vehicles, both directions.
// Stop codes are GTT's pole numbers ("470"), as on the pole; lines are GTT route ids ("4U", "16CSU").

import { Capability, TransitError, compareLines, fold, makeLine, meters, modeFromRouteType } from '../model.js';
import { getJSON, memo, staticData } from '../http.js';

const RELAY = 'https://me-west1-busbus-ios.cloudfunctions.net/webTransit/gtt';
const HOUR = 3600_000;
/** A position older than this is a bus that has stopped reporting. */
const STALE_MS = 300_000;
const OPERATOR = 'GTT';

/** The stop file with its lookups, built once per session. */
function network() {
    return memo('gtt:network', 6 * HOUR, async () => {
        const file = await staticData('gtt:stops-v1', 6 * HOUR, () => getJSON(`${RELAY}/stops`, { timeout: 60_000 }));
        const lines = (file.lines ?? []).map(([id, shortName, longName, type, colour, aliases]) =>
            ({ id, shortName, longName, type, colour, aliases: aliases ?? [] }));
        const directions = (file.directions ?? []).map(([line, dir, headsign]) => ({ line, dir, headsign }));
        const stops = (file.stops ?? []).map(([code, name, lat, lon, dirs, locality]) => ({
            code: String(code), name, locality: locality || null, location: { lat, lon }, directions: dirs ?? [],
            folded: fold([name, locality].filter(Boolean).join(' ')),
        }));
        return { feed: file.feed ?? null, lines, directions, stops, byCode: new Map(stops.map((s) => [s.code, s])) };
    });
}

const stopOf = (entry) => ({ code: entry.code, name: entry.name, city: entry.locality, location: entry.location });

/** Direction `index` as a line the rider can pick at `stopCode`. */
function lineOf(net, index, stopCode) {
    const direction = net.directions[index];
    const line = direction && net.lines[direction.line];
    if (!line) return null;
    const headsign = direction.headsign || null;
    return makeLine({
        id: `${line.id}/${direction.dir}`,
        shortName: line.shortName,
        headsign, agency: OPERATOR, origin: null, destination: headsign,
        longName: line.longName || null,
        mode: modeFromRouteType(line.type),
        providerRefs: { routeId: line.id, direction: String(direction.dir), stopId: stopCode },
    });
}

/** Same number, two directions: keep them in id order, as the app does. */
const byLine = (a, b) => (a.shortName && a.shortName === b.shortName ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : compareLines(a, b));
const linesAt = (net, entry) => entry.directions.map((i) => lineOf(net, i, entry.code)).filter(Boolean).sort(byLine);

function ref(line) {
    const [route, dir] = String(line.id).split('/');
    const routeId = line.providerRefs?.routeId ?? route;
    const direction = Number(line.providerRefs?.direction ?? dir);
    if (!routeId || !Number.isInteger(direction)) throw new TransitError('unsupported', `line ${line.id} is not a GTT route/direction`);
    return { routeId, direction };
}

/** The line's own route id for any route id merged into it, so a board saved before a timetable change still finds it. */
function canonicalRoute(net, route) {
    return net.lines.find((l) => l.id === route || l.aliases.includes(route))?.id ?? route;
}

/**
 * The line's direction as the rider meets it: the busiest variant calling at the stop the line was
 * picked at, else the busiest. Its shape rides in the same reply, so the line's map costs no request.
 */
async function variantOf(line) {
    const { routeId, direction } = ref(line);
    const reply = await memo(`gtt:route:${routeId}`, HOUR, () => getJSON(`${RELAY}/route`, { query: { id: routeId } }));
    const variants = reply?.directions?.find((d) => d.dir === direction)?.variants ?? [];
    if (!variants.length) throw new TransitError('notFound', `direction ${direction} of GTT line ${line.shortName}`);
    const stopCode = line.providerRefs?.stopId;
    const variant = variants.find((v) => v.stops?.some(([code]) => code === stopCode)) ?? variants[0];
    return { variant, feed: reply.feed ?? null };
}

/** @type {import('../model.js').TransitProvider} */
const provider = {
    id: 'gtt',
    displayName: 'GTT Torino',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.scheduledArrivals, Capability.realtimeArrivals, Capability.nearbyStops,
    ]),
    // The relay shares one fetch of GTT's feeds for 20 s.
    refreshSeconds: 20,
    datasetID: 'gtt',
    attribution: 'Data source: GTT S.p.A. – Gruppo Torinese Trasporti (www.gtt.to.it), CC BY-NC 4.0',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        const net = await network();
        // A pole number, as riders read it off the pole.
        const exact = net.byCode.get(text.toUpperCase());
        if (exact) return [stopOf(exact)];
        const needle = fold(text);
        if (!needle) return [];
        return net.stops
            .filter((s) => s.directions.length && s.folded.includes(needle))
            .map((s) => ({ s, p: s.folded.startsWith(needle) }))
            .sort((a, b) => (a.p === b.p ? 0 : a.p ? -1 : 1)
                || (a.s.name === b.s.name ? a.s.code.localeCompare(b.s.code, undefined, { numeric: true }) : a.s.name.localeCompare(b.s.name, undefined, { numeric: true })))
            .slice(0, 40)
            .map(({ s }) => stopOf(s));
    },

    async linesAtStop(stop) {
        const net = await network();
        const entry = net.byCode.get(stop.code);
        if (!entry) throw new TransitError('notFound', `GTT stop ${stop.code}`);
        return linesAt(net, entry);
    },

    async routePattern(line) {
        const { variant } = await variantOf(line);
        const stops = (variant.stops ?? []).map(([code, name, lat, lon, locality], i) => ({
            stop: { code: String(code), name, city: locality || null, location: { lat, lon } },
            sequence: i + 1, distanceAlongRoute: null,
        }));
        if (stops.length < 2) throw new TransitError('notFound', `stops of GTT line ${line.shortName}`);
        return { line, stops };
    },

    async routeShape(line) {
        const { variant, feed } = await variantOf(line);
        const flat = variant.shape ?? [];
        const branch = [];
        for (let i = 0; i + 1 < flat.length; i += 2) branch.push({ lat: flat[i], lon: flat[i + 1] });
        if (branch.length < 2) return null;
        return { branches: [branch], ...(feed ? { version: feed } : {}) };
    },

    async vehicles(line) {
        const { routeId, direction } = ref(line);
        // Both directions in one reply: the two directions on a board share it.
        const reply = await memo(`gtt:buses:${routeId}`, 15_000, () => getJSON(`${RELAY}/buses`, { query: { route: routeId } }));
        const now = Date.now();
        return (reply?.vehicles ?? [])
            .filter((bus) => bus.dir === direction)
            .map((bus) => ({
                location: { lat: bus.lat, lon: bus.lon },
                recordedAt: bus.ts == null ? null : new Date(bus.ts * 1000),
                tripId: bus.trip ?? null,
                // GTT's fleet number, not a plate; the board only needs a stable identity.
                plateNumber: bus.vehicle ?? null,
                bearing: bus.bearing ?? null,
                speedKmh: bus.speed == null ? null : bus.speed * 3.6,
            }))
            .filter((v) => !v.recordedAt || now - v.recordedAt.getTime() <= STALE_MS);
    },

    /** The line's departures in the pole's reply: live where a bus runs the trip, else the timetable. One reply serves every line there. */
    async arrivals(line, stop) {
        const { routeId, direction } = ref(line);
        const route = canonicalRoute(await network().catch(() => ({ lines: [] })), routeId);
        const reply = await memo(`gtt:departures:${stop.code}`, 15_000, () => getJSON(`${RELAY}/departures`, { query: { stop: stop.code } }));
        return (reply?.departures ?? [])
            .filter((d) => d.route === route && d.dir === direction)
            .map((d) => {
                const scheduledAt = new Date(d.sched * 1000);
                return { expectedAt: d.exp != null ? new Date(d.exp * 1000) : scheduledAt, scheduledAt, isRealtime: d.exp != null, tripId: d.trip ?? null };
            })
            .sort((a, b) => a.expectedAt - b.expectedAt);
    },

    /** Poles within the radius, nearest first, with the lines that call there. */
    async stopsNearby(point, radiusMeters) {
        const net = await network();
        return net.stops
            .filter((s) => s.directions.length)
            .map((s) => ({ s, distanceMeters: meters(point, s.location) }))
            .filter((n) => n.distanceMeters <= radiusMeters)
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .slice(0, 12)
            .map(({ s, distanceMeters }) => ({ stop: stopOf(s), distanceMeters, lines: linesAt(net, s) }));
    },
};

export default provider;
