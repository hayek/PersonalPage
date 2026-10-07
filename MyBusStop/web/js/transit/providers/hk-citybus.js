// Hong Kong — Citybus (which absorbed NWFB in 2023), the government ETA API on rt.data.gov.hk (via
// DATA.GOV.HK). Keyless, CORS open, no published rate limit; predictions refresh about every minute.
//
// ARRIVALS ONLY, and ROUTE-FIRST: Citybus publishes predicted times per stop but no bus positions,
// and — unlike KMB — has no list of all stops and no "routes at this stop" call. The only lists are
// the routes (`/route/ctb`, ~110 KB, kept for a day) and each route's stops by direction
// (`/route-stop/ctb/{route}/{outbound|inbound}`, ~2 KB), with names and coordinates one stop at a time
// (`/stop/{id}`, ~300 B). Indexing the whole network would take ~3,000 calls, so search works from
// routes instead:
// - a route number ("1", "A11", "E23") lists every stop of both directions of that route;
// - anything else matches route termini ("Happy Valley") and lists the stops, on up to four such
//   routes, whose name contains the query.
// Every route loaded that way is remembered for the session, and `linesAtStop` answers from that
// memory — so the lines offered at a stop are those of the routes the rider searched through. There
// is no nearby-stops support for the same reason. Six-digit stop ids exist but are not on signs.
//
// Names follow the name language (hk-shared.js): English, or the `*_tc` / `*_sc` fields every
// record also carries. The session caches keep all three, and search matches any of them.

import { Capability, TransitError, makeLine } from '../model.js';
import { getJSON, staticData } from '../http.js';
import { DAY_MS, SessionCache, compareHKLines, containsText, hkNameLanguage, mapLimit, parseHKTime, pick, uniqueBy } from './hk-shared.js';

const BASE = 'https://rt.data.gov.hk/v2/transport/citybus';
/** A terminus-name query ("Central") can match dozens of routes; each costs ~40 stop lookups. */
const PLACE_ROUTE_LIMIT = 4;
/** Parallel `/stop/{id}` lookups at a time, per route direction. */
const STOP_FAN_OUT = 6;

const DIRECTIONS = [
    { path: 'outbound', code: 'O' },
    { path: 'inbound', code: 'I' },
];

const patternCache = new SessionCache();
const stopCache = new SessionCache();
/** Line id → its stop ids in order, for every route direction loaded so far. */
const loaded = new Map();

/** `TransitLine.id` is "route|O" or "route|I", e.g. "1|I". */
function lineRef(id) {
    const parts = String(id).split('|');
    const direction = parts.length === 2 ? DIRECTIONS.find((d) => d.code === parts[1]) : null;
    return direction ? { route: parts[0], direction } : null;
}

function refID(route, direction) {
    return `${route}|${direction.code}`;
}

function toStop(entry) {
    return { code: entry.code, name: pick(entry.en, entry.tc, entry.sc) ?? entry.code, city: null, location: entry.location };
}

function matches(entry, query) {
    return [entry.en, entry.tc, entry.sc].some((name) => containsText(name, query));
}

/** `orig`/`dest` are the outbound termini; inbound runs the other way. */
function routeList() {
    return staticData('hk-citybus/routes', DAY_MS, async () => (await getJSON(`${BASE}/route/ctb`)).data ?? []);
}

/** Unknown or malformed ids are skipped rather than failing the whole route. An unknown id answers `"data": {}`. */
function stopDetail(id) {
    return stopCache.get(id, async () => {
        const stop = (await getJSON(`${BASE}/stop/${encodeURIComponent(id)}`)).data;
        const lat = Number.parseFloat(stop?.lat);
        const lon = Number.parseFloat(stop?.long);
        if (!stop?.stop || !Number.isFinite(lat) || !Number.isFinite(lon)) throw new TransitError('notFound', `Citybus stop ${id}`);
        return { code: stop.stop, location: { lat, lon }, en: stop.name_en ?? null, tc: stop.name_tc ?? null, sc: stop.name_sc ?? null };
    });
}

/**
 * Stops of one route direction, in travel order, with names and coordinates. Remembered for the
 * session, which is what `linesAtStop` answers from.
 */
function stopsOf(route, direction) {
    const key = refID(route, direction);
    return patternCache.get(key, async () => {
        const rows = (await getJSON(`${BASE}/route-stop/ctb/${encodeURIComponent(route)}/${direction.path}`)).data ?? [];
        const ids = [...rows].sort((a, b) => a.seq - b.seq).map((row) => row.stop);
        const unique = [...new Set(ids)];
        const details = await mapLimit(unique, STOP_FAN_OUT, (id) => stopDetail(id).catch(() => null));
        const byID = new Map(details.filter(Boolean).map((stop) => [stop.code, stop]));
        const stops = ids.map((id) => byID.get(id)).filter(Boolean);
        loaded.set(key, stops.map((stop) => stop.code));
        return stops;
    });
}

/** Both directions of each route, loaded side by side, concatenated in the order asked. */
async function stopsOfRoutes(routes) {
    const keys = routes.flatMap((route) => DIRECTIONS.map((direction) => [route, direction]));
    const lists = await Promise.all(keys.map(([route, direction]) => stopsOf(route, direction)));
    return lists.flat();
}

/** @type {import('../model.js').TransitProvider} */
export default {
    id: 'hk-citybus',
    displayName: 'Citybus (Hong Kong)',
    /** Lines and patterns are cached with their names baked in, so each name language is its own dataset. */
    get datasetID() { return `hk-citybus.${hkNameLanguage()}`; },
    attribution: 'Data: Citybus Limited / DATA.GOV.HK',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.linesAtStop, Capability.routePattern,
        Capability.realtimeArrivals, Capability.scheduledArrivals,
    ]),
    refreshSeconds: 30,
    reportsShadowTrips: false,

    async searchStops(query) {
        const needle = String(query ?? '').trim();
        if (!needle) return [];
        const routes = await routeList();

        const route = routes.find((r) => r.route.toLowerCase() === needle.toLowerCase());
        if (route) return uniqueBy(await stopsOfRoutes([route.route]), (s) => s.code).map(toStop);

        const matched = routes
            .filter((r) => [r.orig_en, r.dest_en, r.orig_tc, r.dest_tc, r.orig_sc, r.dest_sc].some((name) => containsText(name, needle)))
            .slice(0, PLACE_ROUTE_LIMIT)
            .map((r) => r.route);
        const stops = (await stopsOfRoutes(matched)).filter((s) => matches(s, needle));
        return uniqueBy(stops, (s) => s.code).map(toStop);
    },

    /**
     * Lines, among the routes loaded this session, that call at the stop — minus a direction that ends
     * there. A stop reached by a six-digit id alone, before any search, knows no lines yet.
     */
    async linesAtStop(stop) {
        const routes = new Map();
        for (const r of await routeList()) if (!routes.has(r.route)) routes.set(r.route, r);
        const lines = [];
        for (const [key, ids] of loaded) {
            const index = ids.lastIndexOf(stop.code);
            if (index < 0) continue;
            if (!(index < ids.length - 1 || ids[0] === stop.code)) continue; // a loop's last stop is its first
            const ref = lineRef(key);
            const route = ref && routes.get(ref.route);
            if (!route) continue;
            const outbound = ref.direction.code === 'O';
            const orig = pick(route.orig_en, route.orig_tc, route.orig_sc);
            const dest = pick(route.dest_en, route.dest_tc, route.dest_sc);
            const origin = outbound ? orig : dest;
            const destination = outbound ? dest : orig;
            lines.push(makeLine({
                id: key, shortName: route.route, headsign: destination, agency: 'Citybus',
                origin, destination, providerRefs: { route: route.route, dir: ref.direction.code },
            }));
        }
        if (!lines.length) throw new TransitError('notFound', `Citybus lines at stop ${stop.code} — search by route number first`);
        return lines.sort(compareHKLines);
    },

    async routePattern(line) {
        const ref = lineRef(line.id);
        if (!ref) throw new TransitError('unsupported', `line ${line.id} has no Citybus route/direction (was it loaded from another provider?)`);
        const stops = await stopsOf(ref.route, ref.direction);
        if (stops.length < 2) throw new TransitError('notFound', `stops for Citybus line ${line.id}`);
        return { line, stops: stops.map((s, i) => ({ stop: toStop(s), sequence: i + 1, distanceAlongRoute: null })) };
    },

    /** Citybus publishes no vehicle positions. */
    async vehicles() {
        return [];
    },

    /**
     * `eta/ctb/{stop}/{route}` answers both directions; the other one is dropped. It also answers every
     * visit (`seq`) of the route to the stop: at a loop's first stop (S1, S56) the buses finishing the
     * loop there come back too, so only the first visit is kept. The feed has no "scheduled" flag, but
     * at a route's first stop the times are whole-minute timetable departures (no bus is tracked before
     * it leaves), so those are reported as not realtime. A null or empty `eta` means no service.
     */
    async arrivals(line, stop) {
        const ref = lineRef(line.id);
        if (!ref) throw new TransitError('unsupported', `line ${line.id} has no Citybus route/direction (was it loaded from another provider?)`);
        const response = await getJSON(`${BASE}/eta/ctb/${encodeURIComponent(stop.code)}/${encodeURIComponent(ref.route)}`);
        const visits = (response.data ?? []).filter((eta) => eta.dir === ref.direction.code);
        const seqs = visits.map((eta) => eta.seq).filter((seq) => seq != null);
        const firstVisit = seqs.length ? Math.min(...seqs) : undefined;
        return visits
            .filter((eta) => eta.seq === firstVisit)
            .map((eta) => {
                const expectedAt = parseHKTime(eta.eta);
                if (!expectedAt) return null;
                const scheduled = eta.seq === 1 || String(eta.rmk_en ?? '').toLowerCase().includes('scheduled');
                return { expectedAt, scheduledAt: null, isRealtime: !scheduled, tripId: null, vehicleLocation: null };
            })
            .filter(Boolean)
            .sort((a, b) => a.expectedAt - b.expectedAt);
    },
};
