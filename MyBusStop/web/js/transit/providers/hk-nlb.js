// Hong Kong — New Lantao Bus (NLB), Lantau Island's buses (Tung Chung, Mui Wo, Tai O, Ngong Ping,
// the airport and the HZMB port), the operator's API v2 on rt.data.gov.hk (via DATA.GOV.HK).
// Keyless, CORS open, no published rate limit.
//
// ARRIVALS ONLY: NLB publishes predicted times per stop but no bus positions, and has no search or
// proximity query. The network is small, though — ~64 route variants, ~290 stops — so it comes whole
// from the two list endpoints, kept for a day: `route.php?action=list` (~19 KB) and each route's
// `stop.php?action=list&routeId=` (~8 KB, stops in order with names and coordinates), ~520 KB in all,
// uncompressed. Search, nearby, lines at a stop and patterns all answer from that.
//
// A route id is one direction of one variant (3M from Tung Chung and 3M from Mui Wo are two), so it is
// the line id as it stands. Stop ids are small numbers with no public meaning. The predictions are
// computed from the timetable and historical running times, not live traffic: only a departure that
// has left its first stop with a GPS-equipped bus (`departed`, `noGPS`) is shown as tracked.
//
// Names follow the name language (hk-shared.js): English, or the `_c` (Traditional) / `_s`
// (Simplified) fields every record also carries. Search matches every language at once, and route
// numbers too ("3M" lists the stops of every 3M variant).

import { Capability, TransitError, makeLine, meters } from '../model.js';
import { buildURL, getJSON, memo, staticData } from '../http.js';
import { DAY_MS, compareHKLines, containsText, hkNameLanguage, mapLimit, pick } from './hk-shared.js';

const BASE = 'https://rt.data.gov.hk/v2/transport/nlb';
/** Parallel `stop.php?action=list` requests while the network loads. */
const FAN_OUT = 6;

// Numbers come as strings or numbers, depending on the field and the day ("routeId": "2",
// "departed": "0", "someDepartureObserveOnly": 0), so they are read either way.
const text = (value) => (value == null ? null : String(value));

/**
 * Every route and every route's stops, trimmed to what is used. One route whose stops will not load
 * is left out; none loading at all is an error.
 */
function rawNetwork() {
    return staticData('hk-nlb/network', DAY_MS, async () => {
        const routes = ((await getJSON(buildURL(BASE, '/route.php', { action: 'list' }))).routes ?? []).map((r) => ({
            routeId: text(r.routeId), routeNo: r.routeNo, en: r.routeName_e ?? '', tc: r.routeName_c ?? '', sc: r.routeName_s ?? '',
        }));
        const lists = await mapLimit(routes, FAN_OUT, async (route) => {
            try {
                const reply = await getJSON(buildURL(BASE, '/stop.php', { action: 'list', routeId: route.routeId }));
                return (reply.stops ?? []).map((s) => ({
                    id: text(s.stopId), lat: text(s.latitude), lon: text(s.longitude),
                    en: s.stopName_e ?? null, tc: s.stopName_c ?? null, sc: s.stopName_s ?? null,
                    streetEN: s.stopLocation_e ?? null, streetTC: s.stopLocation_c ?? null, streetSC: s.stopLocation_s ?? null,
                }));
            } catch {
                return null;
            }
        });
        const stops = {};
        routes.forEach((route, i) => { if (lists[i]) stops[route.routeId] = lists[i]; });
        if (!Object.keys(stops).length) throw new TransitError('badResponse', 'no NLB route stop list loaded');
        return { routes, stops };
    });
}

/** The network indexed: stops by id, and each route's stop ids in order. */
function network() {
    return memo('hk-nlb:network', DAY_MS, async () => {
        const { routes, stops } = await rawNetwork();
        const list = [];
        const byID = new Map();
        const patterns = new Map();
        for (const route of routes) {
            const rows = stops[route.routeId];
            if (!rows) continue;
            patterns.set(route.routeId, rows.map((row) => row.id));
            for (const row of rows) {
                if (byID.has(row.id)) continue;
                const lat = Number.parseFloat(row.lat);
                const lon = Number.parseFloat(row.lon);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                const entry = { ...row, code: row.id, location: { lat, lon } };
                list.push(entry);
                byID.set(entry.code, entry);
            }
        }
        return { routes, list, byID, patterns };
    });
}

function toStop(entry) {
    return {
        code: entry.code, name: pick(entry.en, entry.tc, entry.sc) ?? entry.code, city: null,
        location: entry.location, address: pick(entry.streetEN, entry.streetTC, entry.streetSC),
    };
}

function matches(entry, query) {
    return [entry.en, entry.tc, entry.sc].some((name) => containsText(name, query));
}

/** "Mui Wo Ferry Pier > Tong Fuk (to Shui Hau)" → ["Mui Wo Ferry Pier", "Tong Fuk (to Shui Hau)"]. */
function termini(name) {
    const at = name.indexOf('>');
    const parts = (at < 0 ? [name] : [name.slice(0, at), name.slice(at + 1)])
        .map((part) => part.trim().replace(/\s{2,}/g, ' '))
        .map((part) => part || null);
    return parts.length === 2 ? parts : [null, parts[0] ?? null];
}

/**
 * Lines calling at the stop, minus those that end there (nobody boards a bus at its last stop;
 * a loop's last stop is its first).
 */
function linesAt(net, code) {
    return net.routes
        .filter((route) => {
            const ids = net.patterns.get(route.routeId);
            const index = ids ? ids.lastIndexOf(code) : -1;
            return index >= 0 && (index < ids.length - 1 || ids[0] === code);
        })
        .map((route) => {
            const [origin, destination] = termini(pick(route.en, route.tc, route.sc) ?? '');
            return makeLine({
                id: route.routeId, shortName: route.routeNo, headsign: destination, agency: 'NLB',
                origin, destination, providerRefs: { route: route.routeNo },
            });
        })
        .sort(compareHKLines);
}

/** "2026-09-28 22:15:00" is Hong Kong local time (UTC+8, no daylight saving), with no offset given. */
function parseNLBTime(value) {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(String(value ?? '').trim());
    if (!match) return null;
    const date = new Date(`${match[1]}T${match[2]}+08:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** @type {import('../model.js').TransitProvider} */
export default {
    id: 'hk-nlb',
    displayName: 'NLB (Hong Kong)',
    /** Lines and patterns are cached with their names baked in, so each name language is its own dataset. */
    get datasetID() { return `hk-nlb.${hkNameLanguage()}`; },
    attribution: 'Data: New Lantao Bus / DATA.GOV.HK',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.linesAtStop, Capability.routePattern,
        Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    refreshSeconds: 30,
    reportsShadowTrips: false,

    async searchStops(query) {
        const needle = String(query ?? '').trim();
        if (!needle) return [];
        const net = await network();
        const routes = net.routes.filter((r) => r.routeNo.toLowerCase() === needle.toLowerCase());
        if (routes.length) {
            const ids = [...new Set(routes.flatMap((r) => net.patterns.get(r.routeId) ?? []))];
            return ids.map((id) => net.byID.get(id)).filter(Boolean).map(toStop);
        }
        return net.list.filter((entry) => matches(entry, needle)).map(toStop);
    },

    async linesAtStop(stop) {
        const lines = linesAt(await network(), stop.code);
        if (!lines.length) throw new TransitError('notFound', `NLB lines at stop ${stop.code}`);
        return lines;
    },

    async routePattern(line) {
        const net = await network();
        const stops = (net.patterns.get(line.id) ?? [])
            .map((code, i) => {
                const entry = net.byID.get(code);
                return entry ? { stop: toStop(entry), sequence: i + 1, distanceAlongRoute: null } : null;
            })
            .filter(Boolean);
        if (stops.length < 2) throw new TransitError('notFound', `stops for NLB line ${line.id}`);
        return { line, stops };
    },

    /** NLB publishes no vehicle positions. */
    async vehicles() {
        return [];
    },

    /** No `estimatedArrivals` key (an empty `{}`) means nothing is due. */
    async arrivals(line, stop) {
        const language = { en: 'en', tc: 'zh', sc: 'cn' }[hkNameLanguage()] ?? 'en';
        const response = await getJSON(buildURL(BASE, '/stop.php', {
            action: 'estimatedArrivals', routeId: line.id, stopId: stop.code, language,
        }));
        return (response.estimatedArrivals ?? [])
            .map((eta) => {
                const expectedAt = parseNLBTime(eta.estimatedArrivalTime);
                if (!expectedAt) return null;
                const tracked = text(eta.departed) === '1' && text(eta.noGPS) !== '1';
                return { expectedAt, scheduledAt: null, isRealtime: tracked, tripId: null, vehicleLocation: null };
            })
            .filter(Boolean)
            .sort((a, b) => a.expectedAt - b.expectedAt);
    },

    async stopsNearby(point, radiusMeters) {
        const net = await network();
        return net.list
            .map((entry) => {
                const distanceMeters = meters(point, entry.location);
                return distanceMeters <= radiusMeters ? { stop: toStop(entry), distanceMeters, lines: linesAt(net, entry.code) } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.distanceMeters - b.distanceMeters);
    },
};
