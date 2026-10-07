// Hong Kong — KMB / Long Win Bus, the government ETA API on data.etabus.gov.hk (via DATA.GOV.HK).
// Keyless, CORS open, no published rate limit; predictions refresh about every 20–30 s.
//
// ARRIVALS ONLY: KMB publishes predicted times per stop but no bus positions, so the board computes
// progress itself. There is no search or proximity query either, so the whole network comes from two
// list endpoints, each fetched only when needed and kept for a day in the browser's cache:
// - `/stop` — every stop, ~6,700 of them: ~320 KB brotli (1.2 MB JSON). Search, nearby, patterns.
// - `/route-stop` — every stop of every route: ~390 KB brotli (3 MB JSON). Lines at a stop.
// plus `/route` (~40 KB brotli, 350 KB JSON) for termini. What is kept is a trimmed copy of each.
//
// Stop ids are 16-hex strings with no public meaning; the English name usually ends in the stop's
// signpost code ("NELSON STREET MONG KOK (MK515)"), so searching for "MK515" also finds it.
// A line is route + bound (O/I) + `service_type` — the latter numbers KMB's special variants of a route.
//
// Names follow the name language (hk-shared.js): English (upper case, as published), or the
// `*_tc` / `*_sc` fields every record also carries. Search matches every language at once.

import { Capability, TransitError, makeLine, meters } from '../model.js';
import { getJSON, memo, staticData } from '../http.js';
import { DAY_MS, compareHKLines, hkNameLanguage, parseHKTime, pick, sleep, uniqueBy } from './hk-shared.js';

const BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';
const SEARCH_LIMIT = 60;

/** `TransitLine.id` is "route|bound|service_type", e.g. "1A|O|1". */
function lineRef(line) {
    const parts = String(line.id).split('|');
    if (parts.length !== 3) {
        throw new TransitError('unsupported', `line ${line.id} has no KMB route/bound (was it loaded from another provider?)`);
    }
    const [route, bound, serviceType] = parts;
    return { route, bound, serviceType, boundPath: bound === 'I' ? 'inbound' : 'outbound' };
}

// ---------------------------------------------------------------------------------------------
// Whole-network lists

/**
 * The whole-network lists (`/stop`, `/route`, `/route-stop`) sit behind an Azure Front Door rule that
 * answers 403 "The request is blocked" to a second list request on the same connection, then closes
 * that connection about a second later. A browser cannot ask for a fresh connection, so the lists are
 * fetched one at a time, and a failed one is retried after a pause, by when the blocked connection
 * is gone and the retry opens a new one. The 403 carries no CORS header, so in a browser it surfaces
 * as a network error (status -1), which is retried the same way.
 */
let listQueue = Promise.resolve();

function fetchList(path) {
    const run = listQueue.then(() => loadList(path));
    listQueue = run.catch(() => {});
    return run;
}

async function loadList(path) {
    let failure;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(3000);
        try {
            return (await getJSON(BASE + path, { timeout: 60_000 })).data ?? [];
        } catch (error) {
            failure = error;
            if (error.status !== 403 && error.status !== -1) throw error;
        }
    }
    throw failure;
}

/** Every stop with its name in all three languages: [code, lat, lon, en, tc, sc]. */
function allStops() {
    return memo('hk-kmb:stops', DAY_MS, async () => {
        const rows = await staticData('hk-kmb/stops', DAY_MS, async () => (await fetchList('/stop'))
            .map((row) => [row.stop, Number(row.lat), Number(row.long), row.name_en ?? null, row.name_tc ?? null, row.name_sc ?? null])
            .filter((row) => Number.isFinite(row[1]) && Number.isFinite(row[2])));
        const list = rows.map(([code, lat, lon, en, tc, sc]) => ({ code, location: { lat, lon }, en, tc, sc }));
        return { list, byID: new Map(list.map((entry) => [entry.code, entry])) };
    });
}

function toStop(entry) {
    return { code: entry.code, name: pick(entry.en, entry.tc, entry.sc) ?? entry.code, city: null, location: entry.location };
}

/** `query` is upper-cased; Chinese is unaffected by that. */
function matches(entry, query) {
    return [entry.en?.toUpperCase(), entry.tc, entry.sc].some((name) => name != null && name.includes(query));
}

/**
 * Route keys calling at each stop, minus those that end there (nobody boards a bus at its last
 * stop). Worked out once from the dump, so only the answer is kept: { stopID: [key, …] }.
 */
function routeStops() {
    return staticData('hk-kmb/route-stop', DAY_MS, async () => {
        const rows = await fetchList('/route-stop');
        const lastSeq = new Map();
        const calls = [];
        for (const row of rows) {
            const seq = Number.parseInt(row.seq, 10);
            if (!Number.isFinite(seq)) continue;
            const key = `${row.route}|${row.bound}|${row.service_type}`;
            calls.push([row.stop, key, seq]);
            lastSeq.set(key, Math.max(lastSeq.get(key) ?? seq, seq));
        }
        const byStop = {};
        for (const [stop, key, seq] of calls) {
            if (lastSeq.get(key) === seq) continue;
            const keys = (byStop[stop] ??= []);
            if (!keys.includes(key)) keys.push(key);
        }
        return byStop;
    });
}

/** Route key → [route, bound, service_type, orig_en, dest_en, orig_tc, dest_tc, orig_sc, dest_sc]. */
function routeList() {
    return staticData('hk-kmb/routes', DAY_MS, async () => {
        const routes = {};
        for (const r of await fetchList('/route')) {
            const key = `${r.route}|${r.bound}|${r.service_type}`;
            routes[key] ??= [r.route, r.bound, r.service_type, r.orig_en ?? null, r.dest_en ?? null,
                r.orig_tc ?? null, r.dest_tc ?? null, r.orig_sc ?? null, r.dest_sc ?? null];
        }
        return routes;
    });
}

function linesAt(code, index, routes) {
    return (index[code] ?? [])
        .map((key) => {
            const r = routes[key];
            if (!r) return null;
            const [route, bound, serviceType, origEN, destEN, origTC, destTC, origSC, destSC] = r;
            const destination = pick(destEN, destTC, destSC);
            return makeLine({
                id: key,
                shortName: route,
                headsign: destination,
                agency: 'KMB',
                origin: pick(origEN, origTC, origSC),
                destination,
                providerRefs: { route, bound, serviceType },
            });
        })
        .filter(Boolean)
        .sort(compareHKLines);
}

// ---------------------------------------------------------------------------------------------

/** @type {import('../model.js').TransitProvider} */
export default {
    id: 'hk-kmb',
    displayName: 'KMB (Hong Kong)',
    /** Lines and patterns are cached with their names baked in, so each name language is its own dataset. */
    get datasetID() { return `hk-kmb.${hkNameLanguage()}`; },
    attribution: 'Data: Kowloon Motor Bus / DATA.GOV.HK',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    refreshSeconds: 30,
    reportsShadowTrips: false,

    async searchStops(query) {
        const needle = String(query ?? '').trim().toUpperCase();
        if (!needle) return [];
        const stops = await allStops();
        const exact = stops.byID.get(needle);
        if (exact) return [toStop(exact)];
        const found = [];
        for (const entry of stops.list) {
            if (!matches(entry, needle)) continue;
            found.push(toStop(entry));
            if (found.length >= SEARCH_LIMIT) break;
        }
        return found;
    },

    async linesAtStop(stop) {
        try {
            const [index, routes] = await Promise.all([routeStops(), routeList()]);
            return linesAt(stop.code, index, routes);
        } catch {
            // The dumps sit behind a touchy firewall. Without them, the stop's own ETA board still
            // names every route that has a bus coming — just not ones that have finished for the day.
            const response = await getJSON(`${BASE}/stop-eta/${encodeURIComponent(stop.code)}`);
            const lines = (response.data ?? [])
                .filter((eta) => eta.route && eta.dir && eta.service_type != null)
                .map((eta) => {
                    const destination = pick(eta.dest_en, eta.dest_tc, eta.dest_sc);
                    return makeLine({
                        id: `${eta.route}|${eta.dir}|${eta.service_type}`, shortName: eta.route, headsign: destination,
                        agency: 'KMB', destination,
                        providerRefs: { route: eta.route, bound: eta.dir, serviceType: String(eta.service_type) },
                    });
                });
            return uniqueBy(lines, (line) => line.id);
        }
    },

    async routePattern(line) {
        const ref = lineRef(line);
        const [response, index] = await Promise.all([
            getJSON(`${BASE}/route-stop/${encodeURIComponent(ref.route)}/${ref.boundPath}/${encodeURIComponent(ref.serviceType)}`),
            allStops(),
        ]);
        const stops = (response.data ?? [])
            .map((row) => {
                const seq = Number.parseInt(row.seq, 10);
                const entry = index.byID.get(row.stop);
                return Number.isFinite(seq) && entry ? { stop: toStop(entry), sequence: seq, distanceAlongRoute: null } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.sequence - b.sequence);
        if (stops.length < 2) throw new TransitError('notFound', `stops for KMB line ${line.id}`);
        return { line, stops };
    },

    /** KMB publishes no vehicle positions. */
    async vehicles() {
        return [];
    },

    /**
     * `eta/{stop}/{route}/{service_type}` answers both directions of the route; the other one is dropped.
     * It also answers every visit (`seq`) of the route to the stop: at a loop's first stop (5M, 8A) the
     * buses finishing the loop there come back too. Only the first visit is kept, as hkbus/hk-bus-eta does.
     * An entry remarked "Scheduled Bus" (原定班次) is a timetable slot, not a tracked bus. A null `eta`
     * means no service (the remark then says why, e.g. the last bus has left).
     */
    async arrivals(line, stop) {
        const ref = lineRef(line);
        const response = await getJSON(`${BASE}/eta/${encodeURIComponent(stop.code)}/${encodeURIComponent(ref.route)}/${encodeURIComponent(ref.serviceType)}`);
        const visits = (response.data ?? []).filter((eta) => eta.dir === ref.bound);
        const seqs = visits.map((eta) => eta.seq).filter((seq) => seq != null);
        const firstVisit = seqs.length ? Math.min(...seqs) : undefined;
        return visits
            .filter((eta) => eta.seq === firstVisit)
            .map((eta) => {
                const expectedAt = parseHKTime(eta.eta);
                if (!expectedAt) return null;
                const scheduled = String(eta.rmk_en ?? '').toLowerCase().includes('scheduled');
                return { expectedAt, scheduledAt: null, isRealtime: !scheduled, tripId: null, vehicleLocation: null };
            })
            .filter(Boolean)
            .sort((a, b) => a.expectedAt - b.expectedAt);
    },

    async stopsNearby(point, radiusMeters) {
        const [all, index, routes] = await Promise.all([allStops(), routeStops(), routeList()]);
        return all.list
            .map((entry) => {
                const distanceMeters = meters(point, entry.location);
                return distanceMeters <= radiusMeters
                    ? { stop: toStop(entry), distanceMeters, lines: linesAt(entry.code, index, routes) }
                    : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.distanceMeters - b.distanceMeters);
    },
};
