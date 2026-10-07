// US, Minneapolis–St Paul — Metro Transit NexTrip v2 (svc.metrotransit.org/nextrip), official and
// keyless, no published rate limit or API-specific terms. Stop ids are the public stop numbers.
// Port of BusBus/Transit/Providers/MetroTransitProvider.swift.
//
// NexTrip itself has no stop coordinates for a route (its `/stops/{route}/{dir}` are timepoints
// without positions), no name search and no proximity query. So:
// - stop positions and names come from the Metropolitan Council's "Active Transit Stops" layer
//   (arcgis.metc.state.mn.us), the stop database Metro Transit's GTFS is built from: `site_id` is the
//   public stop number and `description` the GTFS stop name. The app instead pulls `stops.txt` out of
//   the 19 MB GTFS zip with range requests, which a browser cannot do here: the zip's server fails
//   the CORS preflight that a suffix range needs and does not expose `Content-Range`. The layer is
//   read in five pages (~200 KB gzipped) once a day;
// - the ordered stop list of a line comes from the sibling Schedule API (`/schedule/stoplist`);
// - lines at a stop are the routes/directions in its upcoming departures.
// Every endpoint answers CORS (`*`, or the page's origin for the ArcGIS layer).

import { Capability, TransitError, fold, makeLine, meters } from '../model.js';
import { buildURL, getJSON, memo, staticData } from '../http.js';

const NEXTRIP = 'https://svc.metrotransit.org/nextrip';
const SCHEDULE = 'https://svc.metrotransit.org/schedule';
const STOPS_LAYER = 'https://arcgis.metc.state.mn.us/arcgis/rest/services/LPH/Transportation_Transit/FeatureServer/2';
const LAYER_PAGE = 2000; // the layer's maxRecordCount
const TIME_ZONE = 'America/Chicago';
const DAY_MS = 86_400_000;

/** `agency_id` → name, from `/nextrip/agencies` (stable; not worth a call). */
const AGENCIES = {
    0: 'Metro Transit', 1: 'Metro Transit/Met Council', 2: 'Met Council', 3: 'Minnesota Valley',
    4: 'Maple Grove', 5: 'Plymouth', 6: 'SouthWest Transit', 10: 'Airport (MAC)', 11: 'University of Minnesota',
};

function departureLine(departure) {
    const route = departure.route_id ?? '';
    const direction = String(departure.direction_id ?? 0);
    const refs = { route, direction };
    if (departure.direction_text != null) refs.directionText = departure.direction_text;
    return makeLine({
        id: `${route}-${direction}`,
        shortName: departure.route_short_name ?? route,
        headsign: departure.description ?? null,
        agency: departure.agency_id != null ? (AGENCIES[departure.agency_id] ?? null) : null,
        providerRefs: refs,
    });
}

/**
 * A stop's upcoming departures. Kept for 10 s, so the lines of one board poll, and the lines and
 * arrivals asked for together, share a request.
 */
function nexTrip(stopCode) {
    return memo(`metrotransit:nextrip:${stopCode}`, 10_000, () => getJSON(`${NEXTRIP}/${encodeURIComponent(stopCode)}`));
}

/** Line ids are `{route_id}-{direction_id}`; `providerRefs` holds the same, unambiguously. */
function ref(line) {
    const parts = String(line.id).split('-');
    return {
        route: line.providerRefs?.route ?? parts.slice(0, -1).join('-'),
        direction: line.providerRefs?.direction ?? parts.at(-1) ?? '0',
    };
}

/** Timetables are published per day type; the service day runs to ~3 am, Twin Cities time. */
function dayType(now = new Date()) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hourCycle: 'h23', hour: '2-digit' }).format(now)) % 24;
    const serviceDay = hour < 3 ? new Date(now.getTime() - 3 * 3_600_000) : now;
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(serviceDay);
    return weekday === 'Sun' ? 'Sunday' : weekday === 'Sat' ? 'Saturday' : 'Weekday';
}

/** Today's day type if the route runs it, else any timetable in that direction (weekday first). */
function scheduleNumber(details, direction, today) {
    const matching = [];
    for (const schedule of details?.schedules ?? []) {
        const table = (schedule.timetables ?? []).find((t) => String(t.direction_id) === direction);
        if (table) matching.push({ name: schedule.schedule_type_name ?? '', number: table.schedule_number });
    }
    const wanted = today.toLowerCase();
    return (matching.find((m) => m.name.toLowerCase().includes(wanted)) ?? matching[0])?.number ?? null;
}

// ---------------------------------------------------------------------------------------------
// Stops

const layerStop = (feature) => {
    const a = feature.attributes ?? {};
    const g = feature.geometry;
    if (a.site_id == null || g?.x == null || g?.y == null) return null;
    const code = String(a.site_id);
    return { code, name: a.description || code, city: null, location: { lat: g.y, lon: g.x } };
};

function queryLayer(query) {
    return getJSON(buildURL(STOPS_LAYER, '/query', {
        outFields: 'site_id,description', outSR: '4326', geometryPrecision: '6', f: 'json', ...query,
    }));
}

/** Every active stop (~8,700), read page by page once a day. */
function allStops() {
    return staticData('metrotransit.stops.v1', DAY_MS, async () => {
        const where = "active_status='Y'";
        const { count } = await getJSON(buildURL(STOPS_LAYER, '/query', { where, returnCountOnly: 'true', f: 'json' }));
        if (!(count > 0)) throw new TransitError('badResponse', 'Metro Transit stop layer is empty');
        const offsets = Array.from({ length: Math.ceil(count / LAYER_PAGE) }, (_, i) => i * LAYER_PAGE);
        const pages = await Promise.all(offsets.map((offset) => queryLayer({
            where, orderByFields: 'site_id', resultOffset: String(offset), resultRecordCount: String(LAYER_PAGE),
        })));
        const seen = new Set();
        const stops = [];
        for (const page of pages) {
            if (page.error) throw new TransitError('badResponse', `Metro Transit stop layer: ${page.error.message ?? 'error'}`);
            for (const feature of page.features ?? []) {
                const stop = layerStop(feature);
                if (stop && !seen.has(stop.code)) {
                    seen.add(stop.code);
                    stops.push(stop);
                }
            }
        }
        return stops;
    });
}

/** Stops the daily list does not hold (inactive there, or added since), asked of the layer by number. */
async function stopsByCode(codes) {
    const numbers = codes.filter((code) => /^\d+$/.test(code));
    if (!numbers.length) return [];
    const reply = await queryLayer({ where: `site_id IN (${numbers.join(',')})` });
    return (reply.features ?? []).map(layerStop).filter(Boolean);
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

/** `route_id` → the Schedule API's `route_url_param` ("924" → "dline"), ~150 routes, ~15 KB. */
function routeParams() {
    return staticData('metrotransit.routeParams.v1', DAY_MS, async () => {
        const routes = await getJSON(`${SCHEDULE}/routes`);
        const params = {};
        for (const route of routes ?? []) {
            if (route.route_url_param != null && !((route.route_id ?? '') in params)) params[route.route_id ?? ''] = route.route_url_param;
        }
        return params;
    });
}

// ---------------------------------------------------------------------------------------------

const provider = {
    id: 'metrotransit',
    displayName: 'Metro Transit (Minneapolis–St Paul)',
    attribution: 'Data: Metro Transit (NexTrip)',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    /** Vehicle fixes arrive 25–45 s old, so polling faster buys nothing. */
    refreshSeconds: 30,
    datasetID: 'metrotransit',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        // An unknown stop number is an HTTP 400 ("Invalid Stop ID"); fall through to names then.
        if (/^\d+$/.test(text)) {
            try {
                const s = (await nexTrip(text)).stops?.[0];
                if (s?.stop_id != null) {
                    return [{
                        code: String(s.stop_id), name: s.description ?? String(s.stop_id), city: null,
                        location: { lat: s.latitude, lon: s.longitude },
                    }];
                }
            } catch { /* not a stop number */ }
        }
        return matchStops(text, await allStops());
    },

    /**
     * Routes and directions in the stop's upcoming departures (schedule and live), in the order they
     * next leave. A line with no trip in the feed's window (late night, peak-only expresses off-peak)
     * is missing until it has one.
     */
    async linesAtStop(stop) {
        const result = await nexTrip(stop.code);
        const seen = new Set();
        const lines = [];
        for (const departure of result.departures ?? []) {
            const line = departureLine(departure);
            if (seen.has(line.id)) continue;
            seen.add(line.id);
            lines.push(line);
        }
        return lines;
    },

    /**
     * Nearest stops within the radius (at most 8), each asked for its lines — NexTrip has no
     * proximity query, so this is the one place the adapter fans out.
     */
    async stopsNearby(point, radiusMeters) {
        const near = (await allStops())
            .map((stop) => ({ stop, distance: meters(point, stop.location) }))
            .filter(({ distance }) => distance <= radiusMeters)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 8);
        const found = await Promise.all(near.map(async ({ stop, distance }) => {
            try {
                const lines = await provider.linesAtStop(stop);
                return lines.length ? { stop, distanceMeters: distance, lines } : null;
            } catch {
                return null;
            }
        }));
        return found.filter(Boolean).sort((a, b) => a.distanceMeters - b.distanceMeters);
    },

    /**
     * Schedule API: route → today's timetable for the direction → its full ordered stop list.
     * Positions come from the stop list.
     */
    async routePattern(line) {
        const r = ref(line);
        const param = (await routeParams())[r.route];
        if (param == null) throw new TransitError('notFound', `timetable for route ${r.route}`);
        const details = await getJSON(`${SCHEDULE}/routedetails/${encodeURIComponent(param)}`);
        const number = scheduleNumber(details, r.direction, dayType());
        if (number == null) throw new TransitError('notFound', `timetable for route ${r.route} direction ${r.direction}`);
        const list = await getJSON(`${SCHEDULE}/stoplist/${encodeURIComponent(r.route)}/${number}`);
        const codes = (list ?? []).map((item) => String(item.stop_id));
        const byCode = new Map((await allStops()).map((stop) => [stop.code, stop]));
        const missing = codes.filter((code) => !byCode.has(code));
        if (missing.length) {
            try {
                for (const stop of await stopsByCode(missing)) byCode.set(stop.code, stop);
            } catch { /* drawn without them */ }
        }
        const stops = codes.map((code) => byCode.get(code)).filter(Boolean);
        if (stops.length < 2) throw new TransitError('notFound', `stops for route ${r.route} direction ${r.direction}`);
        const pattern = { ...line, providerRefs: { ...line.providerRefs } };
        if (pattern.origin == null) pattern.origin = stops[0].name;
        if (pattern.destination == null) pattern.destination = stops.at(-1).name;
        return { line: pattern, stops: stops.map((stop, i) => ({ stop, sequence: i + 1, distanceAlongRoute: null })) };
    },

    /** Every vehicle of the route; ones not currently on a trip report 0,0 and are dropped. */
    async vehicles(line) {
        const r = ref(line);
        const vehicles = await getJSON(`${NEXTRIP}/vehicles/${encodeURIComponent(r.route)}`);
        const result = [];
        for (const v of vehicles ?? []) {
            if (String(v.direction_id ?? -1) !== r.direction || v.latitude == null || v.longitude == null) continue;
            if (v.latitude === 0 && v.longitude === 0) continue;
            result.push({
                location: { lat: v.latitude, lon: v.longitude },
                recordedAt: v.location_time > 0 ? new Date(v.location_time * 1000) : null,
                tripId: v.trip_id ?? null,
                bearing: v.bearing ?? null,
                // `speed` is published without a documented unit, so it is left out.
            });
        }
        return result;
    },

    /**
     * `departure_time` is the prediction when `actual` is true and the timetable otherwise; the feed
     * never gives both, so a live departure carries no scheduled time.
     */
    async arrivals(line, stop) {
        const r = ref(line);
        const result = await nexTrip(stop.code);
        const arrivals = [];
        for (const d of result.departures ?? []) {
            if (d.route_id !== r.route || String(d.direction_id ?? -1) !== r.direction) continue;
            if (['skipped', 'canceled', 'cancelled'].includes(String(d.schedule_relationship ?? '').toLowerCase())) continue;
            if (d.departure_time == null) continue;
            const at = new Date(d.departure_time * 1000);
            const live = d.actual === true;
            arrivals.push({ expectedAt: at, scheduledAt: live ? null : at, isRealtime: live, tripId: d.trip_id ?? null });
        }
        return arrivals.sort((a, b) => a.expectedAt - b.expectedAt);
    },
};

export default provider;
