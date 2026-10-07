// Hong Kong — green minibuses (GMB), the Transport Department's ETA API on data.etagmb.gov.hk (via
// DATA.GOV.HK). Keyless, CORS open, no published rate limit; every one of the ~550 GMB routes is covered.
//
// ARRIVALS ONLY, and ROUTE-FIRST: GMB publishes predicted times per stop but no minibus positions, and
// has no list of all stops and no search. Its lists are the route codes by region (`/route`, ~5 KB,
// kept for a day), a route's variants and directions (`/route/{region}/{code}`, ~5 KB) and each
// direction's stops with their names (`/route-stop/{route_id}/{route_seq}`, ~2 KB), with coordinates
// one stop at a time (`/stop/{id}`, ~370 B). An all-stops dump exists only as the Transport
// Department's 20 MB GeoJSON, far too big, so search works from routes, like Citybus:
// - a route code ("1", "12A", or "NT 1A" for one region) lists every stop of every variant and
//   direction of that route;
// - anything else matches route termini ("Sai Kung") and lists the stops, on up to four such route
//   directions, whose name contains the query. The termini come from the same dataset's route layer
//   on the CSDI portal (every direction's first and last stop, ~50 KB gzipped, kept for a day).
// Unlike Citybus, `/stop-route/{id}` names every route calling at a stop, so the lines offered at a
// stop never depend on what was searched. There is no nearby-stops support: no endpoint takes a point.
//
// Route codes repeat across the three regions (HKI, KLN, NT — NT 1 and HKI 1 are unrelated), so a
// line is the `route_id` of one variant plus its `route_seq` (1 or 2; a circular route has only 1).
// Stop ids are eight digits with no public meaning; one searched as a whole finds that stop.
//
// Names follow the name language (hk-shared.js): English, or the `*_tc` / `*_sc` fields every
// record also carries. The session caches keep all three, and search matches any of them.

import { Capability, TransitError, makeLine } from '../model.js';
import { buildURL, getJSON, staticData } from '../http.js';
import { DAY_MS, SessionCache, compareHKLines, containsText, hkNameLanguage, mapLimit, parseHKTime, pick, sleep, uniqueBy } from './hk-shared.js';

const BASE = 'https://data.etagmb.gov.hk';
/** The GMB route layer of the same dataset, served by the CSDI portal's ArcGIS server. */
const TERMINI_URL = 'https://portal.csdi.gov.hk/server/rest/services/common/td_rcd_1697082463580_57453/MapServer/0';
const REGIONS = ['HKI', 'KLN', 'NT'];
/** A terminus-name query ("Central") can match dozens of route directions; each costs ~20 stop lookups. */
const PLACE_ROUTE_LIMIT = 4;
/**
 * Parallel lookups at a time (`/stop/{id}`, `/route/{id}`). Kept low: the API answers a burst
 * from one address with 429 "Too Many Requests".
 */
const FAN_OUT = 3;

/** Keyed by request path: "/route/HKI/1" (every variant) or "/route/2006408" (one). */
const routeCache = new SessionCache();
const rowCache = new SessionCache();
const locationCache = new SessionCache();

/**
 * A GET on the ETA API, tried once more after a pause when it answers 429 "Too Many Requests",
 * which it does to a burst of lookups (a route search is dozens of `/stop` calls).
 */
async function get(path) {
    try {
        return await getJSON(BASE + path);
    } catch (error) {
        if (error.status !== 429) throw error;
        await sleep(3000);
        return getJSON(BASE + path);
    }
}

/** `TransitLine.id` is "route_id|route_seq", e.g. "2006408|1". */
function parseRef(id) {
    const parts = String(id).split('|');
    if (parts.length !== 2) return null;
    const routeID = Number.parseInt(parts[0], 10);
    const seq = Number.parseInt(parts[1], 10);
    return Number.isFinite(routeID) && Number.isFinite(seq) ? { routeID, seq, id: `${routeID}|${seq}` } : null;
}

const ref = (routeID, seq) => ({ routeID, seq, id: `${routeID}|${seq}` });

/** A stop as one route direction names it. (The same stop id may carry a different name on another route.) */
function toStop(entry) {
    return { code: entry.code, name: pick(entry.en, entry.tc, entry.sc) ?? entry.code, city: null, location: entry.location };
}

function matches(entry, query) {
    return [entry.en, entry.tc, entry.sc].some((name) => containsText(name, query));
}

// ---------------------------------------------------------------------------------------------
// Loading

/** Route codes by region: { HKI: ["1", "1A", …], KLN: […], NT: […] }. */
function routeList() {
    return staticData('hk-gmb/routes', DAY_MS, async () => (await get('/route')).data?.routes ?? {});
}

/** Every variant of a route code in a region ("Normal Route", "Short Working Service"…). */
function variants(region, code) {
    const path = `/route/${region}/${encodeURIComponent(code)}`;
    return routeCache.get(path, async () => {
        const routes = (await get(path)).data ?? [];
        for (const route of routes) routeCache.seed(`/route/${route.route_id}`, [route]);
        return routes;
    });
}

async function routeByID(id) {
    const path = `/route/${id}`;
    return (await routeCache.get(path, async () => (await get(path)).data ?? []))[0] ?? null;
}

function termini() {
    return staticData('hk-gmb/termini', DAY_MS, async () => {
        const url = buildURL(TERMINI_URL, '/query', {
            where: '1=1', returnGeometry: 'false', f: 'json',
            outFields: 'ROUTE_ID,ROUTE_SEQ,ST_STOP_NAMEE,ST_STOP_NAMEC,ST_STOP_NAMES,ED_STOP_NAMEE,ED_STOP_NAMEC,ED_STOP_NAMES',
        });
        return ((await getJSON(url)).features ?? []).map((feature) => feature.attributes);
    });
}

/** One direction's stop list: ids and names, in travel order. */
function rows(lineRef) {
    return rowCache.get(lineRef.id, async () => {
        const list = (await get(`/route-stop/${lineRef.routeID}/${lineRef.seq}`)).data?.route_stops ?? [];
        return [...list].sort((a, b) => a.stop_seq - b.stop_seq);
    });
}

function locationOf(id) {
    return locationCache.get(String(id), async () => {
        const point = (await get(`/stop/${id}`)).data?.coordinates?.wgs84;
        if (!point) throw new TransitError('notFound', `GMB stop ${id}`);
        return { lat: point.latitude, lon: point.longitude };
    });
}

/**
 * One direction's stops with coordinates. A stop whose coordinates cannot be had is skipped
 * rather than failing the whole route.
 */
async function stopsOf(lineRef) {
    const list = await rows(lineRef);
    const ids = [...new Set(list.map((row) => row.stop_id))];
    const located = await mapLimit(ids, FAN_OUT, (id) => locationOf(id).catch(() => null));
    const locations = new Map();
    ids.forEach((id, i) => { if (located[i]) locations.set(id, located[i]); });
    if (!locations.size && list.length) throw new TransitError('notFound', `coordinates of GMB line ${lineRef.id}`);
    return list
        .filter((row) => locations.has(row.stop_id))
        .map((row) => ({
            code: String(row.stop_id), location: locations.get(row.stop_id), sequence: row.stop_seq,
            en: row.name_en ?? null, tc: row.name_tc ?? null, sc: row.name_sc ?? null,
        }));
}

/** Several directions, loaded side by side (a few at a time), concatenated in the order asked. */
async function stopsOfAll(refs) {
    return (await mapLimit(refs, FAN_OUT, (r) => stopsOf(r))).flat();
}

/** A stop reached by its id alone: coordinates from `/stop`, its name from the first route calling there. */
async function stopByID(id) {
    const number = Number.parseInt(id, 10);
    if (!Number.isFinite(number)) throw new TransitError('notFound', `GMB stop ${id}`);
    const [location, calls] = await Promise.all([locationOf(number), get(`/stop-route/${id}`)]);
    const first = calls.data?.[0];
    return { code: id, location, sequence: first?.stop_seq ?? 0, en: first?.name_en ?? null, tc: first?.name_tc ?? null, sc: first?.name_sc ?? null };
}

function toLine(route, lineRef) {
    const direction = (route.directions ?? []).find((d) => d.route_seq === lineRef.seq);
    if (!direction) return null;
    const destination = pick(direction.dest_en, direction.dest_tc, direction.dest_sc);
    return makeLine({
        id: lineRef.id, shortName: route.route_code, headsign: destination, agency: 'GMB',
        origin: pick(direction.orig_en, direction.orig_tc, direction.orig_sc),
        destination,
        providerRefs: { region: route.region, route: route.route_code, routeID: String(lineRef.routeID), routeSeq: String(lineRef.seq) },
    });
}

// ---------------------------------------------------------------------------------------------

/** @type {import('../model.js').TransitProvider} */
export default {
    id: 'hk-gmb',
    displayName: 'Green Minibus (Hong Kong)',
    /** Lines and patterns are cached with their names baked in, so each name language is its own dataset. */
    get datasetID() { return `hk-gmb.${hkNameLanguage()}`; },
    attribution: 'Data: Transport Department / DATA.GOV.HK',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.linesAtStop, Capability.routePattern,
        Capability.realtimeArrivals, Capability.scheduledArrivals,
    ]),
    refreshSeconds: 30,
    reportsShadowTrips: false,

    async searchStops(query) {
        const needle = String(query ?? '').trim();
        if (!needle) return [];

        if (/^[0-9]{8}$/.test(needle)) return [toStop(await stopByID(needle))];

        const routes = await routeList();
        const words = needle.split(' ');
        const head = words[0];
        const tail = words.slice(1).join(' ');
        const region = words.length >= 2 ? REGIONS.find((r) => r.toLowerCase() === head.toLowerCase()) : undefined;
        const code = region ? tail : needle;
        const codes = (region ? [region] : REGIONS).flatMap((r) => (routes[r] ?? [])
            .filter((c) => c.toLowerCase() === code.toLowerCase())
            .map((c) => [r, c]));
        if (codes.length) {
            const directions = [];
            for (const [r, c] of codes) {
                for (const route of await variants(r, c)) {
                    for (const direction of route.directions ?? []) directions.push(ref(route.route_id, direction.route_seq));
                }
            }
            return uniqueBy(await stopsOfAll(directions), (s) => s.code).map(toStop);
        }

        // The termini are a nicety on top of the ETA API: without them a place name just finds nothing.
        const all = await termini().catch(() => []);
        const matched = all
            .filter((t) => [t.ST_STOP_NAMEE, t.ST_STOP_NAMEC, t.ST_STOP_NAMES, t.ED_STOP_NAMEE, t.ED_STOP_NAMEC, t.ED_STOP_NAMES]
                .some((name) => containsText(name, needle)))
            .slice(0, PLACE_ROUTE_LIMIT)
            .map((t) => ref(t.ROUTE_ID, t.ROUTE_SEQ));
        const stops = (await stopsOfAll(matched)).filter((s) => matches(s, needle));
        return uniqueBy(stops, (s) => s.code).map(toStop);
    },

    /**
     * Every route direction calling at the stop, minus those that end there (nobody boards a minibus
     * at its last stop; a loop's last stop is its first).
     */
    async linesAtStop(stop) {
        const calls = (await get(`/stop-route/${encodeURIComponent(stop.code)}`)).data ?? [];
        const refs = uniqueBy(calls.map((c) => ref(c.route_id, c.route_seq)), (r) => r.id);
        // One route or stop list that will not load drops that line, not the whole stop.
        const routeIDs = [...new Set(refs.map((r) => r.routeID))];
        const [info, lists] = await Promise.all([
            mapLimit(routeIDs, FAN_OUT, (id) => routeByID(id).catch(() => null)),
            mapLimit(refs, FAN_OUT, (r) => rows(r).catch(() => null)),
        ]);
        const byID = new Map(info.filter(Boolean).map((route) => [route.route_id, route]));
        const endsHere = new Set(refs.filter((r, i) => {
            const list = lists[i];
            if (!list?.length) return false;
            return String(list[list.length - 1].stop_id) === stop.code && String(list[0].stop_id) !== stop.code;
        }).map((r) => r.id));
        const lines = refs
            .filter((r) => !endsHere.has(r.id))
            .map((r) => (byID.has(r.routeID) ? toLine(byID.get(r.routeID), r) : null))
            .filter(Boolean)
            .sort(compareHKLines);
        if (!lines.length) throw new TransitError('notFound', `GMB lines at stop ${stop.code}`);
        return lines;
    },

    async routePattern(line) {
        const lineRef = parseRef(line.id);
        if (!lineRef) throw new TransitError('unsupported', `line ${line.id} has no GMB route id/sequence (was it loaded from another provider?)`);
        const stops = await stopsOf(lineRef);
        if (stops.length < 2) throw new TransitError('notFound', `stops for GMB line ${line.id}`);
        return { line, stops: stops.map((s) => ({ stop: toStop(s), sequence: s.sequence, distanceAlongRoute: null })) };
    },

    /** GMB publishes no vehicle positions. */
    async vehicles() {
        return [];
    },

    /**
     * `eta/route-stop/{route_id}/{stop_id}` answers every visit of the route to the stop, in both
     * directions; the other direction is dropped. At a loop's first stop (HKI 12, 14M) that includes the
     * minibuses finishing the loop there (the last `stop_seq`), so only the first visit is kept. An entry
     * remarked "Scheduled" (未開出, "not yet departed") is a timetable slot, not a tracked minibus.
     * `enabled: false` means no ETA service.
     */
    async arrivals(line, stop) {
        const lineRef = parseRef(line.id);
        if (!lineRef) throw new TransitError('unsupported', `line ${line.id} has no GMB route id/sequence (was it loaded from another provider?)`);
        const visits = ((await get(`/eta/route-stop/${lineRef.routeID}/${encodeURIComponent(stop.code)}`)).data ?? [])
            .filter((visit) => visit.route_seq === lineRef.seq);
        const firstVisit = visits.length ? Math.min(...visits.map((visit) => visit.stop_seq)) : undefined;
        return visits
            .filter((visit) => visit.stop_seq === firstVisit && visit.enabled !== false)
            .flatMap((visit) => visit.eta ?? [])
            .map((eta) => {
                const expectedAt = parseHKTime(eta.timestamp);
                if (!expectedAt) return null;
                const scheduled = String(eta.remarks_en ?? '').toLowerCase().includes('scheduled');
                return { expectedAt, scheduledAt: null, isRealtime: !scheduled, tripId: null, vehicleLocation: null };
            })
            .filter(Boolean)
            .sort((a, b) => a.expectedAt - b.expectedAt);
    },
};
