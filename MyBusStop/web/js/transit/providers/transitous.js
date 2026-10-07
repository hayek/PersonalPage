// Worldwide fallback — Transitous (api.transitous.org), a community-run MOTIS 2 server fed by the
// open GTFS / GTFS-RT feeds of several hundred operators. Used only where no region of ours covers
// the rider. Port of BusBus/Transit/Providers/TransitousProvider.swift.
//
// LICENCE: the Transitous API policy (transitous.org/api) allows use only by projects that are open
// source, NOT commercial, and light on its resources. It is also best-effort and may cut any client
// off at any time.
//
// Arrivals only: MOTIS publishes departures with realtime delays (`realTime` says per departure
// whether a GTFS-RT update applied) but no vehicle positions. Its `/map/trips` positions are
// interpolated from the timetable, so they are deliberately not offered as buses on the map.
// The app sends a User-Agent naming itself, as the policy asks; a browser cannot set one, and its own
// is accepted. Stop ids are `<feed>_<gtfs stop_id>`; there is no search by the code printed on the
// sign, only by name. Buses and trams only. Every endpoint answers CORS with `*`.

import { Capability, TransitError, makeLine, meters, stopAddress } from '../model.js';
import { getJSON, memo } from '../http.js';

const BASE = 'https://api.transitous.org';
const MODES = 'BUS,TRAM';
const BUS_MODES = new Set(['BUS', 'TRAM']);
/** Departures looked at for a stop: the next 90 minutes, and at least 20 at a quiet stop. */
const DEPARTURE_WINDOW = 5400;
const DEPARTURE_MINIMUM = 20;
/** Departures per stop are kept this long, so the lines of one board poll share a request. */
const DEPARTURES_LIFETIME_MS = 15_000;

/** MOTIS applies GTFS translations where a feed has them and falls back to the published names. */
function language() {
    const tag = globalThis.navigator?.language ?? 'en';
    return tag.split('-')[0].toLowerCase() || 'en';
}

const get = (path, query) => getJSON(BASE + path, { query });

/** UTC, "2026-09-22T13:04:00Z"; fractional seconds are accepted too. */
function parseDate(string) {
    if (!string) return null;
    const date = new Date(string);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** A place on a trip or in a box, as a stop; null when it is not a stop. */
function placeStop(place) {
    if (place?.stopId == null) return null;
    return {
        code: place.stopId, name: place.name, city: null, location: { lat: place.lat, lon: place.lon },
        // The feed's GTFS `stop_desc`. Some feeds put the street there; many leave it empty or repeat
        // the name, which the address line hides.
        address: stopAddress([place.description]),
    };
}

const servesBusOrTram = (place) => (place.modes ?? []).some((mode) => BUS_MODES.has(mode));

const lineName = (departure) => [departure.routeShortName, departure.displayName].find((name) => name) ?? '?';

const isCancelled = (departure) => departure.cancelled === true || departure.tripCancelled === true;

/** A line is one route in one direction. Feeds without `direction_id` are split by headsign. */
const lineID = (departure) => `${departure.routeId}|${departure.directionId ?? `h:${departure.headsign ?? ''}`}`;

/**
 * The stop's upcoming bus and tram departures (by default MOTIS also includes its platforms and
 * same-named stops nearby). Kept for 15 s, so the lines of one board poll share a request.
 */
function departures(stopID) {
    const lang = language();
    return memo(`transitous:departures:${stopID}|${lang}`, DEPARTURES_LIFETIME_MS, async () => {
        const reply = await get('/api/v6/stoptimes', {
            stopId: stopID, mode: MODES, window: String(DEPARTURE_WINDOW),
            n: String(DEPARTURE_MINIMUM), withAlerts: 'false', language: lang,
        });
        return reply.stopTimes ?? [];
    });
}

export default {
    id: 'transitous',
    displayName: 'Transitous (worldwide)',
    /** The attribution the Transitous policy asks for: its sources page and OpenStreetMap. */
    attribution: 'Data: Transitous, https://transitous.org/sources/ · © OpenStreetMap contributors',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.linesAtStop, Capability.routePattern,
        Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    /**
     * A volunteer server that asks to be spared: the board's per-line calls share one cached
     * departures request per stop, so a poll costs one request.
     */
    refreshSeconds: 30,
    get datasetID() { return `transitous.${language()}`; },
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        const found = await get('/api/v1/geocode', {
            text, type: 'STOP', mode: MODES, numResults: '20', language: language(),
        });
        return (found ?? [])
            .filter((match) => match.type === 'STOP')
            .map((match) => ({
                code: match.id, name: match.name,
                city: (match.areas ?? []).find((area) => area.default === true)?.name ?? null,
                location: { lat: match.lat, lon: match.lon },
            }));
    },

    /**
     * One line per route and direction that departs from the stop in the next 90 minutes. A route
     * that runs later (a night bus, by day) is not listed until it does.
     */
    async linesAtStop(stop) {
        const groups = new Map();
        for (const departure of await departures(stop.code)) {
            const key = lineID(departure);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(departure);
        }
        return [...groups].map(([key, group]) => {
            const first = group[0];
            // The headsign most of its departures carry names the direction; short workings vary it.
            const counts = new Map();
            for (const departure of group) {
                if (departure.headsign != null) counts.set(departure.headsign, (counts.get(departure.headsign) ?? 0) + 1);
            }
            const headsign = [...counts].sort(([a, n], [b, m]) => (m - n) || (a < b ? -1 : a > b ? 1 : 0))[0]?.[0] ?? null;
            const typical = group.find((departure) => departure.headsign === headsign) ?? first;
            const refs = { routeId: first.routeId, stopId: stop.code };
            if (first.directionId != null) refs.directionId = String(first.directionId);
            if (headsign != null) refs.headsign = headsign;
            return makeLine({
                id: key, shortName: lineName(first), headsign, agency: first.agencyName ?? null,
                origin: typical.tripFrom?.name ?? null, destination: typical.tripTo?.name ?? headsign,
                providerRefs: refs,
            });
        });
    },

    /**
     * The whole trip of the line's next departure from the rider's stop, which is always a trip of
     * that direction that serves it. The stop the rider boards at is renamed to the stop they chose,
     * since the trip lists the platform and the board finds the rider's stop by code.
     */
    async routePattern(line) {
        const stopID = line.providerRefs?.stopId;
        if (!stopID) throw new TransitError('notFound', `stop of line ${line.id}`);
        const next = (await departures(stopID)).find((departure) => lineID(departure) === line.id);
        if (!next) throw new TransitError('notFound', `a departure of ${line.shortName} from ${stopID}`);
        const trip = await get('/api/v6/trip', { tripId: next.tripId, language: language() });
        const leg = trip?.legs?.[0];
        if (!leg) throw new TransitError('notFound', `trip ${next.tripId}`);
        const places = [leg.from, ...(leg.intermediateStops ?? []), leg.to];
        let boarding = places.findIndex((p) => p.stopId === next.place.stopId && p.departure === next.place.departure);
        if (boarding < 0) boarding = places.findIndex((p) => p.stopId === next.place.stopId);
        const stops = [];
        places.forEach((place, index) => {
            const stop = placeStop(place);
            if (!stop) return;
            if (index === boarding) stop.code = stopID;
            stops.push({ stop, sequence: index + 1, distanceAlongRoute: null });
        });
        return { line, stops };
    },

    /** No vehicle positions exist in MOTIS; see the comment at the top. */
    async vehicles() {
        return [];
    },

    /**
     * A trip that calls at two platforms of the stop (a bus station's bays, a loop) comes once per
     * call, a minute or two apart; it is kept once, at the rider's own stop when it calls there.
     */
    async arrivals(line, stop) {
        const calls = new Map();
        for (const departure of await departures(stop.code)) {
            if (lineID(departure) !== line.id || isCancelled(departure) || departure.place?.cancelled === true) continue;
            const kept = calls.get(departure.tripId);
            if (!kept) {
                calls.set(departure.tripId, departure);
            } else if (departure.place.stopId === stop.code && kept.place.stopId !== stop.code) {
                calls.set(departure.tripId, departure);
            }
        }
        const arrivals = [];
        for (const departure of calls.values()) {
            const place = departure.place;
            const expectedAt = parseDate(place.departure ?? place.arrival);
            if (!expectedAt) continue;
            arrivals.push({
                expectedAt,
                scheduledAt: parseDate(place.scheduledDeparture ?? place.scheduledArrival),
                isRealtime: departure.realTime === true,
                tripId: departure.tripId,
            });
        }
        return arrivals.sort((a, b) => a.expectedAt - b.expectedAt);
    },

    /**
     * `/map/stops` with `grouped` answers one entry per stop area in a box but says nothing about
     * routes, so the nearest few are each asked `/stop` for theirs, in parallel.
     */
    async stopsNearby(point, radiusMeters) {
        const lang = language();
        const dLat = radiusMeters / 111_320;
        const dLon = dLat / Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01);
        const places = await get('/api/v6/map/stops', {
            min: `${point.lat - dLat},${point.lon - dLon}`,
            max: `${point.lat + dLat},${point.lon + dLon}`,
            grouped: 'true', language: lang,
        });
        const candidates = (places ?? [])
            .filter(servesBusOrTram)
            .map(placeStop)
            .filter(Boolean)
            .map((stop) => ({ stop, distance: meters(point, stop.location) }))
            .filter(({ distance }) => distance <= radiusMeters)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 8);
        const found = await Promise.all(candidates.map(async ({ stop, distance }) => {
            const info = await get('/api/v6/stop', { stopId: stop.code, language: lang });
            const seen = new Set();
            const lines = (info?.routes ?? [])
                .filter((route) => BUS_MODES.has(route.mode ?? ''))
                .filter((route) => {
                    const key = route.routeShortName ?? route.routeId;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .map((route) => makeLine({
                    id: route.routeId, shortName: route.routeShortName ?? '?', agency: route.agencyName ?? null,
                }));
            return lines.length ? { stop, distanceMeters: distance, lines } : null;
        }));
        return found.filter(Boolean).sort((a, b) => a.distanceMeters - b.distanceMeters);
    },
};
