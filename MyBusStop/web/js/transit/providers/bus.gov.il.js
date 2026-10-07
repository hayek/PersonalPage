// Israel: the JSON API behind route.bus.gov.il (National Public Transport Authority). Port of
// BusGovILProvider.swift. Undocumented and keyless; live positions are about 40 s fresh.
//
// bus.gov.il sends no CORS headers, so the browser reaches it through the web relay (the
// `webTransit` Cloud Function in Tel Aviv). The relay holds no key: it forwards an allowlisted set of
// these paths for this site only, and caches answers so riders polling one line share a fetch.

import { Capability, TransitError, makeLine, meters, stopAddress } from '../model.js';
import { getJSON, buildURL } from '../http.js';

const RELAY = 'https://me-west1-busbus-ios.cloudfunctions.net/webTransit/bus-gov-il';

/** Stop names come in Hebrew, English and Arabic. Hebrew and Arabic readers get their own;
 * everyone else gets English, the one a visitor can read. */
function language() {
    const code = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return code === 'he' || code === 'ar' ? code : 'en';
}

const scheduler = () => `${RELAY}/mot-scheduler-prod/api/${language()}`;
const planner = (lang = language()) => `${RELAY}/route-planner-prod/api/${lang}`;

async function get(base, path, query, options = {}) {
    const envelope = await getJSON(buildURL(base, path, query), options);
    return envelope?.data ?? null;
}

/** The app's language when the feed has it, Hebrew (always filled) when it does not. */
function preferred(names) {
    if (!names) return null;
    if (typeof names === 'string') return names;
    const wanted = { he: names.he, en: names.en, ar: names.ar }[language()];
    return [wanted, names.he, names.en, names.ar].find((n) => n && n.length) ?? null;
}

/** The scheduler's city names are Hebrew whatever the path says, so only Hebrew readers see them. */
const city = (name) => (language() === 'he' ? name ?? null : null);

const clean = (name, code) => String(name ?? code).replace(` (${code})`, '');

function schedulerStop(s) {
    return {
        code: String(s.stopcode), name: preferred(s.name) ?? String(s.stopcode), city: city(s.cityName),
        location: { lat: s.lat, lon: s.lng }, address: stopAddress([s.streetName, s.streetNumber]),
    };
}

function searchStation(s) {
    return {
        code: String(s.stopcode), name: clean(s.name, s.stopcode), city: s.cityName ?? null,
        location: { lat: s.lat, lon: s.lng }, address: stopAddress([s.streetName, s.streetNumber]),
    };
}

/** Parses the MOT `route_long_name`: "origin stop-city<->destination stop-city-2#". */
function longName(text) {
    const parts = String(text ?? '').split('<->');
    if (parts.length !== 2) return {};
    const place = (t) => {
        const dash = t.lastIndexOf('-');
        if (dash < 0) return t;
        const stop = t.slice(0, dash).trim();
        const town = t.slice(dash + 1).trim();
        return town ? `${stop}, ${town}` : stop;
    };
    return { origin: place(parts[0]), destination: place(parts[1].replace(/-[0-9]+[^-]*$/, '')) };
}

function routeLine(r) {
    const ordered = r.stops ? [...r.stops].sort((a, b) => a.stopSequence - b.stopSequence) : null;
    const placeOf = (s) => [preferred(s.name), city(s.cityName)].filter(Boolean).join(', ');
    const named = longName(r.routeLongName);
    return makeLine({
        id: String(r.routeId),
        shortName: r.routeName,
        headsign: preferred(r.headsign),
        agency: r.agencyName ?? null,
        origin: ordered?.length ? placeOf(ordered[0]) : named.origin ?? null,
        destination: ordered?.length ? placeOf(ordered[ordered.length - 1]) : named.destination ?? null,
        providerRefs: r.routeDesc ? { routeDesc: r.routeDesc } : {},
    });
}

/** Times come as Israel local time without an offset: "2026-09-17T05:59:26". */
function parseLocal(text) {
    if (!text) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    const offsetAt = (t) => {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
        }).formatToParts(new Date(t));
        const v = (type) => Number(parts.find((p) => p.type === type).value);
        return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'), v('second')) - Math.floor(t / 1000) * 1000;
    };
    const first = guess - offsetAt(guess);
    return new Date(guess - offsetAt(first));
}

export default {
    id: 'bus.gov.il',
    displayName: 'bus.gov.il (unofficial, live)',
    attribution: 'Data: Israel National Public Transport Authority (bus.gov.il)',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    refreshSeconds: 20,
    /** Seen on line 3 in Haifa: a late slot and the next one both live, one bus at the stop. */
    reportsShadowTrips: true,
    /** Cached lines and routes carry names, so each language is its own dataset. */
    get datasetID() { return `bus.gov.il.${language()}`; },

    async searchStops(query) {
        const q = query.trim();
        if (!q) return [];
        if (/^\d+$/.test(q)) {
            // The planner names the stop in the rider's language; the scheduler's lookup often has only
            // the Hebrew name, so it is the fallback for codes the planner does not know.
            const planned = await get(planner(), '/AutoComplete/SearchStations', { searchTerm: q }).catch(() => null);
            const exact = planned?.find((s) => String(s.stopcode) === q);
            if (exact) return [searchStation(exact)];
            const stop = await get(scheduler(), '/Stops/GetStopByCode', { stopcode: q });
            return stop ? [schedulerStop(stop)] : [];
        }
        return ((await get(planner(), '/AutoComplete/SearchStations', { searchTerm: q })) ?? []).map(searchStation);
    },

    async linesAtStop(stop) {
        const data = await get(scheduler(), '/Stops/GetStopFullData', { stopCode: stop.code });
        return (data?.routesInStop ?? []).map(routeLine);
    },

    async routePattern(line) {
        const data = await get(scheduler(), '/Routes/GetRouteStops', { routeId: line.id });
        const stops = data?.route?.stops ?? [];
        if (!stops.length) throw new TransitError('notFound', `stops for route ${line.id}`);
        return {
            line,
            stops: [...stops].sort((a, b) => a.stopSequence - b.stopSequence)
                .map((s) => ({ stop: schedulerStop(s), sequence: s.stopSequence, distanceAlongRoute: null })),
        };
    },

    /** Bare lat/lng of every bus on the route: no trip id, plate or timestamp. */
    async vehicles(line) {
        const data = await get(scheduler(), '/Routes/GetRouteLocations', { routeId: line.id });
        return (data ?? []).map((p) => ({ location: { lat: p.lat, lon: p.lng } }));
    },

    async arrivals(line, stop) {
        const routeDesc = line.providerRefs?.routeDesc;
        if (!routeDesc) throw new TransitError('unsupported', `line ${line.id} has no routeDesc`);
        // A stop with no departures left today (late at night, on Shabbat) comes back as
        // {"41122": null}: an empty board, not a broken feed.
        const data = await get(scheduler(), '/Calendar/GetRouteCalendarAtStopsByStopCodes', { stopCodes: stop.code, routeDesc });
        const times = data?.[stop.code]?.stopTimes ?? [];
        const now = Date.now();
        // A live trip's timetable slot can come back a second time as a bare scheduled entry: one bus, twice.
        const tracked = new Set(times.filter((t) => t.isRealTime).map((t) => t.staticArrivalTime).filter(Boolean));
        return times
            .filter((t) => t.isRealTime || !tracked.has(t.arrivalTime ?? ''))
            .flatMap((t) => {
                const expected = t.minutesToArrival != null ? new Date(now + t.minutesToArrival * 60_000) : parseLocal(t.arrivalTime);
                if (!expected) return [];
                return [{
                    expectedAt: expected,
                    scheduledAt: parseLocal(t.staticArrivalTime),
                    isRealtime: Boolean(t.isRealTime),
                    tripId: t.staticTripId ?? null,
                    vehicleLocation: t.routeLocation ? { lat: t.routeLocation.lat, lon: t.routeLocation.lng } : null,
                }];
            })
            .sort((a, b) => a.expectedAt - b.expectedAt);
    },

    /**
     * bus.gov.il's own nearby call (GetStopsCloseToLocation) answers with every route's whole stop
     * list, about 2 MB, and takes half a minute or more, longer than a page can wait. So the stops
     * around the rider come from Transitous, which carries the same Ministry of Transport stops, and
     * each is matched to its bus.gov.il stop code by searching its exact name and keeping the
     * result standing where Transitous puts it. Lines come once the rider picks a stop.
     */
    async stopsNearby(point, radiusMeters) {
        const dLat = radiusMeters / 111_320;
        const dLon = dLat / Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01);
        const places = await getJSON(buildURL('https://api.transitous.org', '/api/v6/map/stops', {
            min: `${(point.lat - dLat).toFixed(5)},${(point.lon - dLon).toFixed(5)}`,
            max: `${(point.lat + dLat).toFixed(5)},${(point.lon + dLon).toFixed(5)}`,
            grouped: 'true', language: 'he',
        }));
        const candidates = (places ?? [])
            .filter((p) => (p.modes ?? []).includes('BUS') && p.name)
            .map((p) => ({ place: p, distance: meters(point, { lat: p.lat, lon: p.lon }) }))
            .filter((c) => c.distance <= radiusMeters)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 10);
        const matched = await Promise.all(candidates.map(async ({ place }) => {
            try {
                const found = await get(planner('he'), '/AutoComplete/SearchStations', { searchTerm: place.name });
                const here = { lat: place.lat, lon: place.lon };
                const best = (found ?? [])
                    .map((s) => ({ s, off: meters(here, { lat: s.lat, lon: s.lng }) }))
                    .filter((m) => m.off <= 60)
                    .sort((a, b) => a.off - b.off)[0];
                return best ? searchStation(best.s) : null;
            } catch {
                return null; // A name the search rejects or cannot find is one stop fewer, not a failure.
            }
        }));
        const seen = new Set();
        return matched
            .filter((stop) => stop && !seen.has(stop.code) && seen.add(stop.code))
            .map((stop) => ({ stop, distanceMeters: meters(point, stop.location), lines: [] }))
            .sort((a, b) => a.distanceMeters - b.distanceMeters);
    },
};
