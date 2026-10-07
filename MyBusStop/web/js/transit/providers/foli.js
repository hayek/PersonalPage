// Turku region, Finland — Föli's open data at data.foli.fi (City of Turku). Port of
// BusBus/Transit/Providers/FoliProvider.swift. Keyless, no stated rate limit. Live data is SIRI-style
// JSON (`/siri/vm` for vehicles, `/siri/sm/{stop}` for departures); timetables are a GTFS feed exposed
// as JSON under `/gtfs/v0/{dataset}/…`.
//
// Licence CC BY 4.0, and the attribution wording is fixed by the publisher.
//
// Every live record carries `__routeref` and `__directionid`, the GTFS `route_id` and `direction_id`
// of its trip, so a line here is one GTFS route in one direction and live data is matched on those two
// rather than on the public line number (which the `…A`/`…T` variants share with their base line).

import { Capability, TransitError, compareLineNames, fold, makeLine, meters } from '../model.js';
import { ResponseError, getJSON, staticData } from '../http.js';

const BASE = 'https://data.foli.fi';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------
// Static half of the feed

// The dataset name (`/gtfs/v0/`, 0.2 KB), all stops (~225 KB, ~3,600 stops), all trips (~250 KB
// gzipped, ~12,000 trips) and routes (~4 KB). Each is kept per dataset, so a new dataset is a new key.
// Only the fields this adapter reads are stored.

function version() {
    return staticData('foli:version', 6 * HOUR, async () => (await getJSON(`${BASE}/gtfs/v0/`)).latest);
}

/** stop_id → {name, lat, lon}. `stop_id` equals the public stop number on the pole. */
async function stopsTable() {
    const v = await version();
    return staticData(`foli:stops:${v}`, DAY, async () => {
        const raw = await getJSON(`${BASE}/gtfs/v0/${v}/stops`);
        const out = {};
        for (const [id, s] of Object.entries(raw ?? {})) out[id] = { name: s.stop_name, lat: s.stop_lat, lon: s.stop_lon };
        return out;
    });
}

/** trip_id → [route_id, headsign, direction_id, shape_id, wheelchair_accessible]. */
async function tripsTable() {
    const v = await version();
    return staticData(`foli:trips:${v}`, DAY, async () => {
        const raw = await getJSON(`${BASE}/gtfs/v0/${v}/trips/all`);
        const out = {};
        for (const t of raw ?? []) {
            if (out[t.trip_id]) continue;
            out[t.trip_id] = [t.route_id, t.trip_headsign ?? null, t.direction_id ?? 0, t.shape_id ?? null, t.wheelchair_accessible ?? null];
        }
        return out;
    });
}

/** route_id → route_short_name. */
async function routesTable() {
    const v = await version();
    return staticData(`foli:routes:${v}`, DAY, async () => {
        const raw = await getJSON(`${BASE}/gtfs/v0/${v}/routes`);
        const out = {};
        for (const r of raw ?? []) if (!(r.route_id in out)) out[r.route_id] = r.route_short_name;
        return out;
    });
}

const toStop = (id, s) => ({ code: id, name: s.name, city: null, location: { lat: s.lat, lon: s.lon } });

// ---------------------------------------------------------------------------------------------
// Helpers

/** The commonest value; a tie goes to the alphabetically first. */
function mostCommon(values) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = null;
    let n = -1;
    for (const [v, c] of counts) if (c > n || (c === n && v < best)) { best = v; n = c; }
    return best;
}

function makeFoliLine(routeID, shortName, trips) {
    // The most travelled shape through this stop stands for the direction; its commonest headsign
    // names it ("Satama", "Lentoasema").
    const shape = mostCommon(trips.map((t) => t.shape ?? ''));
    const representative = trips.find((t) => (t.shape ?? '') === shape) ?? trips[0];
    const headsign = mostCommon(trips.map((t) => t.headsign).filter(Boolean));
    const direction = representative.direction ?? 0;
    const refs = { routeId: routeID, direction: String(direction), tripId: representative.tripId };
    if (representative.shape) refs.shapeId = representative.shape;
    const line = makeLine({
        id: `${routeID}/${direction}`,
        shortName,
        headsign,
        agency: 'Föli',
        origin: null,
        destination: headsign,
        providerRefs: refs,
    });
    const access = representative.wheelchair;
    line.isAccessible = access === 1 ? true : access === 2 ? false : null;
    return line;
}

function refsOf(line) {
    const parts = String(line.id ?? '').split('/');
    const route = line.providerRefs?.routeId ?? parts[0] ?? null;
    const dirText = line.providerRefs?.direction ?? parts[1];
    const direction = dirText != null && /^\d+$/.test(dirText) ? Number(dirText) : null;
    if (!route || direction == null) {
        throw new TransitError('unsupported', `line ${line.id} is not a Föli route/direction (was it loaded from another provider?)`);
    }
    return { route, direction };
}

/** Live times are Unix epoch seconds. */
const epoch = (seconds) => new Date(seconds * 1000);

// ---------------------------------------------------------------------------------------------

/** @type {import('../model.js').TransitProvider} */
const provider = {
    id: 'foli',
    displayName: 'Föli (Turku)',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    // There is no per-line vehicle query: every poll of `/siri/vm` is the whole fleet (~280 KB
    // gzipped, ~200 vehicles), so this stays at the slow end of the board's band.
    refreshSeconds: 30,
    datasetID: 'foli',
    attribution: 'Source: Turku region public transport operational and timetable data. Data maintained by City of Turku. Downloaded from data.foli.fi under CC BY 4.0.',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        const stops = await stopsTable();
        if (stops[text]) return [toStop(text, stops[text])];
        const needle = fold(text);
        return Object.entries(stops)
            .filter(([, s]) => fold(s.name).includes(needle))
            .map(([id, s]) => toStop(id, s))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
            .slice(0, 50);
    },

    /**
     * Built from the stop's full timetable (`stop_times/stop/{id}`, ~9 KB for a busy stop) joined to
     * the cached trip list, so every route+direction that ever calls here is listed — not only the
     * ones with a bus due in the next hour, which is all `/siri/sm` would show.
     */
    async linesAtStop(stop) {
        const v = await version();
        const [times, trips, routes] = await Promise.all([
            getJSON(`${BASE}/gtfs/v0/${v}/stop_times/stop/${encodeURIComponent(stop.code)}`),
            tripsTable(),
            routesTable(),
        ]);
        // A trip that only sets down here (its terminus) is not one the rider can board.
        const boarding = (times ?? []).filter((t) => t.pickup_type !== 1);
        const calls = boarding.length ? boarding : (times ?? []);

        const groups = new Map();
        for (const call of calls) {
            const t = trips[call.trip_id];
            if (!t) continue;
            const [routeID, headsign, direction, shape, wheelchair] = t;
            const key = `${routeID}/${direction ?? 0}`;
            if (!groups.has(key)) groups.set(key, { routeID, trips: [] });
            groups.get(key).trips.push({ tripId: call.trip_id, headsign, direction, shape, wheelchair });
        }
        const lines = [];
        for (const { routeID, trips: list } of groups.values()) {
            const shortName = routes[routeID];
            if (shortName == null) continue;
            lines.push(makeFoliLine(routeID, shortName, list));
        }
        return lines.sort((a, b) => (a.shortName === b.shortName ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : compareLineNames(a.shortName, b.shortName)));
    },

    async routePattern(line) {
        const v = await version();
        const stops = await stopsTable();
        let times = [];
        const savedTrip = line.providerRefs?.tripId;
        if (savedTrip) {
            try {
                times = await getJSON(`${BASE}/gtfs/v0/${v}/stop_times/trip/${encodeURIComponent(savedTrip)}`);
            } catch {
                times = [];
            }
        }
        if (!Array.isArray(times) || !times.length) {
            // The saved trip belongs to an older dataset; pick a fresh one of the same route,
            // direction and (when known) shape.
            const { route, direction } = refsOf(line);
            const trips = (await getJSON(`${BASE}/gtfs/v0/${v}/trips/route/${encodeURIComponent(route)}`) ?? [])
                .filter((t) => (t.direction_id ?? 0) === direction);
            const shape = line.providerRefs?.shapeId;
            const trip = trips.find((t) => t.shape_id === shape) ?? trips[0];
            if (!trip) throw new TransitError('notFound', `trips of Föli route ${route} direction ${direction}`);
            times = await getJSON(`${BASE}/gtfs/v0/${v}/stop_times/trip/${encodeURIComponent(trip.trip_id)}`);
        }
        const patternStops = [...(times ?? [])]
            .sort((a, b) => a.stop_sequence - b.stop_sequence)
            .filter((t) => stops[t.stop_id])
            .map((t) => ({ stop: toStop(t.stop_id, stops[t.stop_id]), sequence: t.stop_sequence, distanceAlongRoute: t.shape_dist_traveled ?? null }));
        if (!patternStops.length) throw new TransitError('notFound', `stops of Föli line ${line.id}`);
        return { line, stops: patternStops };
    },

    async vehicles(line) {
        const { route, direction } = refsOf(line);
        const response = await getJSON(`${BASE}/siri/vm`);
        const now = response.servertime ?? Math.floor(Date.now() / 1000);
        const out = [];
        for (const v of Object.values(response.result?.vehicles ?? {})) {
            if (v.__routeref !== route || v.__directionid !== String(direction)) continue;
            // A bus parked at its first stop keeps its last record long after it went quiet;
            // `validuntiltime` says when the publisher itself stops vouching for it.
            if ((v.validuntiltime ?? Infinity) < now || v.monitored === false) continue;
            if (v.latitude == null || v.longitude == null) continue;
            out.push({
                location: { lat: v.latitude, lon: v.longitude },
                recordedAt: v.recordedattime != null ? epoch(v.recordedattime) : null,
                distanceAlongRoute: null,
                tripId: v.__tripref ?? null,
                // Föli's fleet number, not a plate — the board only needs a stable identity.
                plateNumber: v.vehicleref ?? null,
                bearing: v.bearing ?? null,
                aimedDeparture: v.originaimeddeparturetime != null ? epoch(v.originaimeddeparturetime) : null,
            });
        }
        return out;
    },

    /**
     * `/siri/sm/{stop}` lists the next ~20 departures of every line at the stop, live or not.
     * `monitored` is also true for trips that have not left their first stop yet, whose "expected"
     * time is just the timetable (and whose coordinates, when present, are of the bus finishing its
     * previous run elsewhere). So a departure counts as real-time only once its trip has started.
     */
    async arrivals(line, stop) {
        const { route, direction } = refsOf(line);
        const url = `${BASE}/siri/sm/${encodeURIComponent(stop.code)}`;
        const response = await getJSON(url);
        // When the SIRI back end is down the reply is `"status":"NO_SIRI_DATA"` with an empty result
        // (documented at data.foli.fi/doc/siri/v0/sm) — an outage, not a stop with no buses due.
        if (response.status && response.status !== 'OK') {
            throw new ResponseError(`Föli stop monitoring status ${response.status}`, { url, status: 200 });
        }
        const now = response.servertime ?? Math.floor(Date.now() / 1000);
        const out = [];
        for (const call of response.result ?? []) {
            if (call.__routeref !== route || call.__directionid !== String(direction)) continue;
            const expected = call.expectedarrivaltime ?? call.expecteddeparturetime ?? call.aimedarrivaltime;
            if (expected == null) continue;
            const live = call.monitored === true && (call.originaimeddeparturetime ?? Infinity) <= now;
            const aimed = call.aimedarrivaltime ?? call.aimeddeparturetime;
            out.push({
                expectedAt: epoch(expected),
                scheduledAt: aimed != null ? epoch(aimed) : null,
                isRealtime: live,
                tripId: call.__tripref ?? null,
                vehicleLocation: live && call.latitude != null && call.longitude != null ? { lat: call.latitude, lon: call.longitude } : null,
            });
        }
        return out.sort((a, b) => a.expectedAt - b.expectedAt);
    },

    /**
     * There is no proximity query, so this filters the cached stop list and then asks each of the
     * nearest stops for its lines (one small request each, capped at 12 stops).
     */
    async stopsNearby(point, radiusMeters) {
        const stops = await stopsTable();
        const near = Object.entries(stops)
            .map(([id, s]) => toStop(id, s))
            .map((stop) => ({ stop, distanceMeters: meters(point, stop.location) }))
            .filter((n) => n.distanceMeters <= radiusMeters)
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .slice(0, 12);
        const results = await Promise.all(near.map(async (n) => ({ ...n, lines: await provider.linesAtStop(n.stop) })));
        return results.filter((n) => n.lines.length);
    },
};

export default provider;
