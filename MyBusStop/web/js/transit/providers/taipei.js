// Taiwan, Taipei — Taipei City's own keyless bus files (臺北市政府公共運輸處, data.taipei), free under
// the Open Government Data License v1, which asks for the agency's credit. Port of
// BusBus/Transit/Providers/TaipeiProvider.swift.
//
// Taipei publishes whole-city gzipped files (the stop file alone is 1.4 MB) on a blob store that
// sends no CORS headers, so everything comes through the web relay (the `webTransit` Cloud
// Function, route `taipei`, functions/src/taipei.ts in the app repo). It holds no key: it fetches
// each file at most once per window for everyone and answers with what it cuts out of them:
//   - `stops`: every stop pole with the line directions calling there (~240 KB gzipped), searched
//     and ranked by distance here, and kept in the browser for six hours.
//   - `route?id=`: one route's poles, both directions, in order.
//   - `arrivals?stop=`: the next bus of every line at one pole, in seconds from when Taipei wrote
//     the file.
//   - `buses?route=`: one route's buses.
// Names are Traditional Chinese and English; the page shows the English (`hkNameLanguage`).

import { Capability, TransitError, compareLines, fold, makeLine, meters } from '../model.js';
import { getJSON, memo, staticData } from '../http.js';
import { hkNameLanguage, pick } from './hk-shared.js';

const RELAY = 'https://me-west1-busbus-ios.cloudfunctions.net/webTransit/taipei';
const SIX_HOURS = 6 * 3600_000;
/** A position older than this is a bus that has stopped reporting. */
const STALE_MS = 300_000;

/** 台 and 臺 are one character to a rider; case and width don't matter either. */
const foldName = (text) => fold(String(text ?? '').replace(/台/g, '臺'));

function network() {
    return memo('taipei:network', SIX_HOURS, async () => {
        const file = await staticData('taipei:stops', SIX_HOURS, () => getJSON(`${RELAY}/stops`, { timeout: 60_000 }));
        const routes = (file.routes ?? []).map(([id, nameZh, nameEn, depZh, depEn, destZh, destEn, operator]) =>
            ({ id, nameZh, nameEn, depZh, depEn, destZh, destEn, operator }));
        const directions = (file.directions ?? []).map(([route, dir]) => ({ route, dir }));
        const stops = (file.stops ?? []).map(([code, nameZh, nameEn, lat, lon, dirs, address]) => ({
            code, nameZh, nameEn, location: { lat, lon }, address: address || null, directions: dirs ?? [],
            foldedZh: foldName(nameZh), foldedEn: foldName(nameEn),
        }));
        return { routes, directions, stops, byCode: new Map(stops.map((s) => [s.code, s])) };
    });
}

function stopOf(entry, language = hkNameLanguage()) {
    return { code: entry.code, name: pick(entry.nameEn, entry.nameZh, null, language) ?? entry.code, city: null, location: entry.location, address: entry.address };
}

/** Out (0) heads for the route's destination, back (1) for where it starts. */
function lineOf(net, index, stopCode, language = hkNameLanguage()) {
    const direction = net.directions[index];
    const route = direction && net.routes[direction.route];
    if (!route) return null;
    const from = pick(route.depEn, route.depZh, null, language);
    const to = pick(route.destEn, route.destZh, null, language);
    const [origin, destination] = direction.dir === 0 ? [from, to] : [to, from];
    return makeLine({
        id: `${route.id}/${direction.dir}`,
        shortName: pick(route.nameEn, route.nameZh, null, language) ?? route.id,
        headsign: destination, agency: route.operator || null, origin, destination,
        providerRefs: { routeId: route.id, direction: String(direction.dir), stopId: stopCode },
    });
}

const linesAt = (net, entry) => entry.directions.map((i) => lineOf(net, i, entry.code)).filter(Boolean).sort(compareLines);

function ref(line) {
    const [route, dir] = String(line.id).split('/');
    const routeId = line.providerRefs?.routeId ?? route;
    const direction = Number(line.providerRefs?.direction ?? dir);
    if (!routeId || !Number.isInteger(direction)) throw new TransitError('unsupported', `line ${line.id} is not a Taipei route/direction`);
    return { routeId, direction };
}

/** @type {import('../model.js').TransitProvider} */
const provider = {
    id: 'taipei',
    displayName: 'Taipei City Bus',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.nearbyStops,
    ]),
    // Taipei rewrites its estimate and position files about every 20 s, and the relay holds each that long.
    refreshSeconds: 20,
    datasetID: 'taipei',
    attribution: '臺北市政府公共運輸處 · data.taipei · Open Government Data License v1',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        const net = await network();
        const exact = net.byCode.get(text);
        if (exact) return [stopOf(exact)];
        const needle = foldName(text);
        if (!needle) return [];
        const prefix = (s) => s.foldedZh.startsWith(needle) || s.foldedEn.startsWith(needle);
        return net.stops
            .filter((s) => s.directions.length && (s.foldedZh.includes(needle) || s.foldedEn.includes(needle)))
            .map((s) => ({ s, p: prefix(s), stop: stopOf(s) }))
            .sort((a, b) => (a.p === b.p ? 0 : a.p ? -1 : 1) || a.stop.name.localeCompare(b.stop.name) || a.s.code.localeCompare(b.s.code, undefined, { numeric: true }))
            .slice(0, 40)
            .map((x) => x.stop);
    },

    async linesAtStop(stop) {
        const net = await network();
        const entry = net.byCode.get(stop.code);
        if (!entry) throw new TransitError('notFound', `stop ${stop.code} in Taipei`);
        return linesAt(net, entry);
    },

    async routePattern(line) {
        const { routeId, direction } = ref(line);
        const reply = await memo(`taipei:route:${routeId}`, 3600_000, () => getJSON(`${RELAY}/route`, { query: { id: routeId } }));
        const stops = reply?.directions?.find((d) => d.dir === direction)?.stops ?? [];
        if (stops.length < 2) throw new TransitError('notFound', `direction ${direction} of Taipei route ${line.shortName}`);
        const language = hkNameLanguage();
        return {
            line,
            stops: stops.map(([code, nameZh, nameEn, lat, lon], i) => ({
                stop: { code, name: pick(nameEn, nameZh, null, language) ?? code, city: null, location: { lat, lon } },
                sequence: i + 1, distanceAlongRoute: null,
            })),
        };
    },

    async vehicles(line) {
        const { routeId, direction } = ref(line);
        // Both directions in one reply: the two directions on a board share it.
        const reply = await memo(`taipei:buses:${routeId}`, 15_000, () => getJSON(`${RELAY}/buses`, { query: { route: routeId } }));
        const now = Date.now();
        return (reply?.vehicles ?? [])
            .filter(([, dir]) => dir === direction)
            .map(([plate, , lat, lon, bearing, speed, ts]) => ({
                location: { lat, lon },
                recordedAt: ts == null ? null : new Date(ts * 1000),
                tripId: null,
                plateNumber: plate || null,
                bearing: bearing ?? null,
                speedKmh: speed ?? null,
            }))
            .filter((v) => !v.recordedAt || now - v.recordedAt.getTime() <= STALE_MS);
    },

    /** Taipei's estimate of the line's next bus at the pole; one reply serves every line there. */
    async arrivals(line, stop) {
        const { routeId, direction } = ref(line);
        const reply = await memo(`taipei:arrivals:${stop.code}`, 15_000, () => getJSON(`${RELAY}/arrivals`, { query: { stop: stop.code } }));
        const base = reply?.at ? reply.at * 1000 : Date.now();
        return (reply?.arrivals ?? [])
            .filter(([route, dir]) => route === routeId && dir === direction)
            .map(([, , seconds]) => ({ expectedAt: new Date(base + seconds * 1000), scheduledAt: null, isRealtime: true, tripId: null }))
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
            .slice(0, 15)
            .map(({ s, distanceMeters }) => ({ stop: stopOf(s), distanceMeters, lines: linesAt(net, s) }));
    },
};

export default provider;
