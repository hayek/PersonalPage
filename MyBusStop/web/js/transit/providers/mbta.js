// US, Boston — MBTA V3 API (api-v3.mbta.com), official, JSON:API. Port of
// BusBus/Transit/Providers/MBTAProvider.swift.
//
// Keyless use is capped at 20 requests/minute per IP (a free key lifts it to 1000/min, but the web
// version holds no keys), so every method here is a single request and the board's poll — vehicles
// plus predictions — costs two. In a browser the cap is the rider's own IP. Stop ids are the public
// stop numbers printed on the signs. Every endpoint answers CORS with `*`.
// Licence: MassDOT Developers License Agreement — the app must credit MassDOT as the data provider.
// Bus only: stops and lines are filtered to `route_type` 3.

import { Capability, TransitError, fold, makeLine, meters, stopAddress } from '../model.js';
import { getJSON, staticData } from '../http.js';

const BASE = 'https://api-v3.mbta.com';
const BUS_ROUTE_TYPE = 3;
const TIME_ZONE = 'America/New_York';
const STOP_FIELDS = 'name,latitude,longitude,municipality,address,on_street,at_street';
const DAY_MS = 86_400_000;

const get = (path, query) => getJSON(BASE + path, { query });

/** ISO 8601 with the Boston offset: "2026-09-22T05:37:00-04:00". */
function parseDate(string) {
    if (!string) return null;
    const date = new Date(string);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Arrival, or departure at a trip's first stop (where arrival is null). */
const time = (a) => parseDate(a?.arrival_time ?? a?.departure_time);

/** `data` of a relationship is an object, an array or null; all become a list of ids. */
function ids(resource, name) {
    const data = resource?.relationships?.[name]?.data;
    if (data == null) return [];
    return Array.isArray(data) ? data.map((d) => d.id) : [data.id];
}

/** `included` keyed by "type:id". */
function index(included) {
    const map = new Map();
    for (const resource of included ?? []) {
        const key = `${resource.type}:${resource.id}`;
        if (!map.has(key)) map.set(key, resource);
    }
    return map;
}

function toStop(resource) {
    const a = resource?.attributes;
    if (resource?.type !== 'stop' || a?.latitude == null || a?.longitude == null) return null;
    // A station has a postal address; a pole has the street it stands on and the one it is at.
    const address = stopAddress([a.address]) ?? stopAddress([a.on_street, a.at_street], ' & ');
    return {
        code: resource.id, name: a.name ?? resource.id, city: a.municipality ?? null,
        location: { lat: a.latitude, lon: a.longitude }, address,
    };
}

/**
 * Route and direction to filter live data by. Pattern ids are `{route}-{variant}-{direction}`, which
 * is the fallback for a line saved before `providerRefs` were filled.
 */
function ref(line) {
    const parts = String(line.id).split('-');
    return {
        route: line.providerRefs?.route ?? parts.slice(0, -2).join('-'),
        direction: line.providerRefs?.direction ?? parts.at(-1) ?? '0',
    };
}

/** Most typical first, then MBTA's own ordering (which follows route number). */
function compareRank(a, b) {
    const ta = a.attributes?.typicality ?? 9, tb = b.attributes?.typicality ?? 9;
    if (ta !== tb) return ta - tb;
    return (a.attributes?.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.attributes?.sort_order ?? Number.MAX_SAFE_INTEGER);
}

/**
 * MBTA's service day runs past midnight; `/schedules` wants the service date and a time of day
 * counted from its start ("25:10"), in Boston time.
 */
function serviceDay(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type).value;
    const hour = Number(get('hour')) % 24;
    const rollover = hour < 3;
    const day = rollover ? new Date(now.getTime() - DAY_MS) : now;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);
    const minTime = `${String(hour + (rollover ? 24 : 0)).padStart(2, '0')}:${get('minute')}`;
    return { date, minTime };
}

/**
 * MBTA gives a departure time only where riders can board, so a visit with none is a trip that ends
 * here (a short-turn) or sets down only. The official app hides those on a stop's board; they are
 * kept only when nothing else calls, which is a terminus board.
 */
function boarding(visits) {
    const boardable = visits.filter((v) => v.boardable);
    return (boardable.length ? boardable : visits).map((v) => v.arrival).sort((a, b) => a.expectedAt - b.expectedAt);
}

/** Case- and accent-insensitive "every word appears in the name", exact and prefix matches first. */
function matchStops(query, stops, limit = 40) {
    const needle = fold(query);
    const words = needle.split(' ').filter(Boolean);
    if (!words.length) return [];
    const ranked = [];
    for (const stop of stops) {
        const name = fold(stop.name);
        if (!words.every((word) => name.includes(word))) continue;
        ranked.push({ stop, rank: name === needle ? 0 : name.startsWith(needle) ? 1 : 2 });
    }
    return ranked
        .sort((a, b) => (a.rank - b.rank) || (a.stop.name < b.stop.name ? -1 : a.stop.name > b.stop.name ? 1 : 0))
        .slice(0, limit)
        .map((r) => r.stop);
}

/**
 * Every MBTA bus stop (~6,900; ~255 KB gzipped, 1.9 MB of JSON), for name search: the API has no
 * text search. Kept for a day across visits.
 */
function allStops() {
    return staticData('mbta.stops.v1', DAY_MS, async () => {
        const response = await get('/stops', { 'filter[route_type]': String(BUS_ROUTE_TYPE), 'fields[stop]': STOP_FIELDS });
        return (response.data ?? []).map(toStop).filter(Boolean);
    });
}

/**
 * Bus lines per direction at each of the given stops, from a single `/route_patterns` call. Each
 * (route, direction) keeps its most typical pattern that actually stops there; patterns that only
 * *end* at the stop are dropped unless nothing else serves it (a terminus).
 */
async function servingLines(stopIDs) {
    const response = await get('/route_patterns', {
        'filter[stop]': stopIDs.join(','),
        include: 'route,representative_trip.stops',
        'fields[route_pattern]': 'direction_id,typicality,sort_order',
        'fields[route]': 'short_name,long_name,type',
        'fields[trip]': 'headsign,stops',
        'fields[stop]': 'name',
    });
    const included = index(response.included);

    const candidates = [];
    for (const pattern of response.data ?? []) {
        const a = pattern.attributes;
        if (a?.direction_id == null || (a.typicality ?? 1) >= 5) continue;
        const routeID = ids(pattern, 'route')[0];
        const route = routeID != null ? included.get(`route:${routeID}`)?.attributes : null;
        if (!route || route.type !== BUS_ROUTE_TYPE) continue;
        const tripID = ids(pattern, 'representative_trip')[0];
        const trip = tripID != null ? included.get(`trip:${tripID}`) : null;
        if (!trip) continue;
        const tripStops = ids(trip, 'stops');
        const names = tripStops.map((id) => included.get(`stop:${id}`)?.attributes?.name ?? null);
        const line = makeLine({
            id: pattern.id,
            shortName: [route.short_name, route.long_name].find((name) => name) ?? routeID,
            headsign: trip.attributes?.headsign ?? null,
            agency: 'MBTA',
            origin: names[0] ?? null,
            destination: names.at(-1) ?? null,
            providerRefs: { route: routeID, direction: String(a.direction_id), trip: tripID },
        });
        candidates.push({ pattern, line, stopIDs: tripStops });
    }

    const result = new Map();
    for (const stopID of stopIDs) {
        const serving = candidates.filter((c) => c.stopIDs.includes(stopID));
        const boardingHere = serving.filter((c) => c.stopIDs.at(-1) !== stopID || c.stopIDs.slice(0, -1).includes(stopID));
        const best = new Map();
        for (const candidate of (boardingHere.length ? boardingHere : serving)) {
            const key = `${candidate.line.providerRefs.route ?? ''}|${candidate.line.providerRefs.direction ?? ''}`;
            const current = best.get(key);
            if (current && compareRank(current.pattern, candidate.pattern) <= 0) continue;
            best.set(key, candidate);
        }
        result.set(stopID, [...best.values()].sort((x, y) => compareRank(x.pattern, y.pattern)).map((c) => c.line));
    }
    return result;
}

async function scheduled(r, stop) {
    const day = serviceDay();
    const response = await get('/schedules', {
        'filter[stop]': stop.code, 'filter[route]': r.route, 'filter[direction_id]': r.direction,
        'filter[date]': day.date, 'filter[min_time]': day.minTime,
        'fields[schedule]': 'arrival_time,departure_time',
        sort: 'departure_time', 'page[limit]': '10',
    });
    const visits = [];
    for (const schedule of response.data ?? []) {
        const at = time(schedule.attributes);
        if (!at) continue;
        visits.push({
            arrival: { expectedAt: at, scheduledAt: at, isRealtime: false, tripId: ids(schedule, 'trip')[0] ?? null },
            boardable: schedule.attributes.departure_time != null,
        });
    }
    return boarding(visits);
}

export default {
    id: 'mbta',
    displayName: 'MBTA (Boston)',
    attribution: 'Data provided by MassDOT',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    /** Two calls per poll against a 20/min budget that setup screens share. */
    refreshSeconds: 30,
    datasetID: 'mbta',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        if (/^\d+$/.test(text)) {
            try {
                const direct = await get(`/stops/${encodeURIComponent(text)}`, { 'fields[stop]': STOP_FIELDS });
                const stop = toStop(direct.data);
                if (stop) return [stop];
            } catch { /* not a stop number: search names */ }
        }
        return matchStops(text, await allStops());
    },

    async linesAtStop(stop) {
        return (await servingLines([stop.code])).get(stop.code) ?? [];
    },

    /**
     * `/stops` answers a radius query (in degrees) nearest-first but says nothing about routes, so
     * the lines come from one `/route_patterns` call covering every stop found: two requests total.
     */
    async stopsNearby(point, radiusMeters) {
        const response = await get('/stops', {
            'filter[latitude]': String(point.lat),
            'filter[longitude]': String(point.lon),
            'filter[radius]': String(radiusMeters / 111_320),
            'filter[route_type]': String(BUS_ROUTE_TYPE),
            'fields[stop]': STOP_FIELDS,
            'page[limit]': '15',
        });
        const stops = (response.data ?? []).map(toStop).filter(Boolean);
        if (!stops.length) return [];
        const lines = await servingLines(stops.map((s) => s.code));
        return stops
            .map((stop) => {
                const served = lines.get(stop.code);
                return served?.length ? { stop, distanceMeters: meters(point, stop.location), lines: served } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.distanceMeters - b.distanceMeters);
    },

    /** A line is one MBTA route pattern (`1-_-0`); its representative trip carries the stop order. */
    async routePattern(line) {
        const response = await get(`/route_patterns/${encodeURIComponent(line.id)}`, {
            include: 'representative_trip.stops',
            'fields[route_pattern]': 'direction_id',
            'fields[trip]': 'headsign,stops',
            'fields[stop]': STOP_FIELDS,
        });
        const included = index(response.included);
        const tripID = ids(response.data, 'representative_trip')[0];
        const stopIDs = tripID != null ? ids(included.get(`trip:${tripID}`), 'stops') : [];
        if (!stopIDs.length) throw new TransitError('notFound', `stops for route pattern ${line.id}`);
        const stops = stopIDs.map((id) => toStop(included.get(`stop:${id}`))).filter(Boolean);
        return { line, stops: stops.map((stop, i) => ({ stop, sequence: i + 1, distanceAlongRoute: null })) };
    },

    async vehicles(line) {
        const r = ref(line);
        const response = await get('/vehicles', {
            'filter[route]': r.route, 'filter[direction_id]': r.direction,
            'fields[vehicle]': 'latitude,longitude,bearing,speed,updated_at,label',
        });
        const vehicles = [];
        for (const vehicle of response.data ?? []) {
            const a = vehicle.attributes;
            if (a?.latitude == null || a?.longitude == null) continue;
            vehicles.push({
                location: { lat: a.latitude, lon: a.longitude },
                recordedAt: parseDate(a.updated_at),
                tripId: ids(vehicle, 'trip')[0] ?? null,
                plateNumber: a.label ?? null,
                bearing: a.bearing ?? null,
                speedKmh: a.speed != null ? a.speed * 3.6 : null, // metres per second on the wire
            });
        }
        return vehicles;
    },

    /**
     * Predictions carry their timetable slot via `include=schedule`. When there are none (late at
     * night, or a route without live data) one more call falls back to the timetable itself.
     */
    async arrivals(line, stop) {
        const r = ref(line);
        const response = await get('/predictions', {
            'filter[stop]': stop.code, 'filter[route]': r.route, 'filter[direction_id]': r.direction,
            include: 'schedule,vehicle',
            'fields[prediction]': 'arrival_time,departure_time,schedule_relationship',
            'fields[schedule]': 'arrival_time,departure_time',
            'fields[vehicle]': 'latitude,longitude',
        });
        const included = index(response.included);
        const predicted = [];
        for (const prediction of response.data ?? []) {
            const a = prediction.attributes;
            if (!a || ['CANCELLED', 'SKIPPED'].includes(a.schedule_relationship ?? '')) continue;
            const expectedAt = time(a);
            if (!expectedAt) continue;
            const scheduleID = ids(prediction, 'schedule')[0];
            const vehicleID = ids(prediction, 'vehicle')[0];
            const schedule = scheduleID != null ? included.get(`schedule:${scheduleID}`) : null;
            const vehicle = vehicleID != null ? included.get(`vehicle:${vehicleID}`)?.attributes : null;
            predicted.push({
                arrival: {
                    expectedAt,
                    scheduledAt: time(schedule?.attributes),
                    isRealtime: true,
                    tripId: ids(prediction, 'trip')[0] ?? null,
                    vehicleLocation: vehicle?.latitude != null && vehicle?.longitude != null
                        ? { lat: vehicle.latitude, lon: vehicle.longitude } : null,
                },
                boardable: a.departure_time != null,
            });
        }
        if (predicted.length) return boarding(predicted);
        return scheduled(r, stop);
    },
};
