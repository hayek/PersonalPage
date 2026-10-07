// Norway — Entur, the national journey planner (every operator: Skyss, AtB, Kolumbus, Ruter, …).
// Port of BusBus/Transit/Providers/EnturProvider.swift. Keyless and documented (developer.entur.no),
// NLOD licence. Journey Planner v3 and Vehicles v2 are GraphQL over POST; stop search is the
// Pelias-style geocoder. Every call carries `ET-Client-Name` (allowed by Entur's CORS preflight):
// unidentified clients are strictly rate-limited and may be blocked. It names the client; it is not
// a secret.
//
// A stop is a *stop place* (what riders search for and what the geocoder returns), normalised to its
// multimodal parent when it has one. A stop place holds several quays (one per kerb/direction), so
// direction lives on the line instead: one line per line + journey-pattern direction that actually
// calls at one of the stop's quays. That keeps the board one stop with many lines, while arrivals and
// vehicles are filtered to the rider's direction.
//
// Ruter (Oslo/Akershus) does not feed vehicle positions to Entur, so Oslo lines have arrivals only.

import { Capability, TransitError, compareLineNames, makeLine, meters } from '../model.js';
import { ResponseError, getJSON, memo, postJSON, serviceDate } from '../http.js';

const GEOCODER = 'https://api.entur.io/geocoder/v1/autocomplete';
const JOURNEY_PLANNER = 'https://api.entur.io/journey-planner/v3/graphql';
const VEHICLES_API = 'https://api.entur.io/realtime/v2/vehicles/graphql';
/** Oslo time: service dates and every timetable in the feed are Norwegian. */
const TIME_ZONE = 'Europe/Oslo';
const HEADERS = { 'ET-Client-Name': 'hayek-busbus' };
const BUS_MODES = new Set(['bus']);
const BUS_CATEGORIES = new Set(['onstreetBus', 'busStation', 'coachStation']);
/**
 * Directions that mean the same thing on every pattern of a line. Anything else ("unknown",
 * missing) cannot be paired with other patterns, so such a pattern is its own direction.
 */
const NAMED_DIRECTIONS = new Set(['inbound', 'outbound', 'clockwise', 'anticlockwise']);

function directionKey(pattern) {
    const type = (pattern.directionType ?? '').toLowerCase();
    return NAMED_DIRECTIONS.has(type) ? type : pattern.id;
}

/** A GraphQL string literal. JSON string escaping is a subset of GraphQL's. */
const gql = (value) => JSON.stringify(String(value));

async function graphQL(url, query) {
    const reply = await postJSON(url, { query }, { headers: HEADERS });
    if (reply?.data) return reply.data;
    const reason = (reply?.errors ?? []).map((e) => e?.message).filter(Boolean).join('; ') || 'no data';
    throw new ResponseError(`GraphQL: ${reason}`, { url, status: 200, body: JSON.stringify(reply) });
}

/** Times carry their offset: "2026-09-22T11:36:00+02:00". */
function parseDate(text) {
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** What a line from this provider carries: Entur line, direction key, the stop place it was listed at. */
function lineRef(line) {
    const refs = line.providerRefs ?? {};
    if (!refs.line || !refs.direction || !refs.stop) {
        throw new TransitError('unsupported', `line ${line.id} has no Entur refs (was it loaded from another provider?)`);
    }
    // `headsign` is only set for a pattern with no direction: its destination display.
    return { line: refs.line, direction: refs.direction, stop: refs.stop, headsign: refs.headsign ?? null };
}

// ---------------------------------------------------------------------------------------------
// Lines

// The journey patterns calling at each quay are the complete, static list of what stops here; the
// next day's departures (`soon`) say which of them a rider can actually *board* here and under which
// headsign. ~160 KB at Bergen busstasjon (the largest), ~60 KB at a city-centre stop.
const CALL_FIELDS = 'destinationDisplay { frontText } serviceJourney { journeyPattern { id directionType line { id } } }';

function linesFields(soon) {
    return `quays(filterByInUse: true) { journeyPatterns { id directionType
          line { id publicCode transportMode authority { name } } } }
        soon: estimatedCalls(numberOfDepartures: ${soon}, timeRange: 86400) { ${CALL_FIELDS} }`;
}

/** One group per line + direction among the bus patterns at the stop, with the headsigns seen so far. */
function groupsOf(place) {
    const groups = new Map();
    for (const quay of place.quays ?? []) {
        for (const pattern of quay.journeyPatterns ?? []) {
            const line = pattern.line;
            if (!line || !BUS_MODES.has(line.transportMode ?? '')) continue;
            const direction = directionKey(pattern);
            const key = `${line.id}#${direction}`;
            if (!groups.has(key)) groups.set(key, { line, direction, headsigns: new Map() });
        }
    }
    count(place.soon ?? [], groups);
    return groups;
}

function count(calls, groups) {
    for (const call of calls) {
        const pattern = call?.serviceJourney?.journeyPattern;
        const line = pattern?.line?.id;
        const text = call?.destinationDisplay?.frontText;
        if (!pattern || !line || !text) continue;
        const group = groups.get(`${line}#${directionKey(pattern)}`);
        if (group) group.headsigns.set(text, (group.headsigns.get(text) ?? 0) + 1);
    }
}

/** Only groups with a departure become lines: that drops the directions that end here. */
function linesOf(groups, stopCode) {
    const lines = new Map();
    for (const [key, group] of groups) {
        // The most common headsign; a tie goes to the alphabetically first.
        let headsign = null;
        let best = -1;
        let trips = 0;
        for (const [text, n] of group.headsigns) {
            trips += n;
            if (n > best || (n === best && text < headsign)) { headsign = text; best = n; }
        }
        if (headsign == null) continue;
        const refs = { line: group.line.id, direction: group.direction, stop: stopCode };
        // A pattern with no direction stands alone. Operators that leave direction out (the airport
        // coaches) publish one such pattern per variant, so they are told apart — and merged back
        // into one line — by headsign.
        let dedupe = key;
        if (!NAMED_DIRECTIONS.has(group.direction)) {
            refs.headsign = headsign;
            dedupe = `${group.line.id}#to:${headsign}`;
            const existing = lines.get(dedupe);
            if (existing && existing.trips >= trips) continue;
        }
        lines.set(dedupe, {
            trips,
            line: makeLine({
                id: `${key}#${stopCode}`,
                shortName: group.line.publicCode ?? group.line.id,
                headsign,
                agency: group.line.authority?.name ?? null,
                destination: headsign,
                providerRefs: refs,
            }),
        });
    }
    return [...lines.values()].map((v) => v.line).sort((a, b) =>
        compareLineNames(a.shortName, b.shortName) || ((a.headsign ?? '') < (b.headsign ?? '') ? -1 : (a.headsign ?? '') > (b.headsign ?? '') ? 1 : 0));
}

/**
 * Directions with no departure in the next day are either ones that end here (nothing to board) or
 * ones that run on other days (night and weekend lines). One look a week ahead per line tells them
 * apart; OTP's own one-per-line departure query gives up after a few hours, so each line gets its
 * own aliased `estimatedCalls`.
 */
async function lookAhead(stopCode, lineIDs) {
    if (!lineIDs.length) return [];
    const aliases = lineIDs.slice(0, 60).map((line, index) =>
        `l${index}: estimatedCalls(numberOfDepartures: 10, timeRange: 604800, filters: [{ select: [{ lines: [${gql(line)}] }] }]) { ${CALL_FIELDS} }`);
    const data = await graphQL(JOURNEY_PLANNER, `{ stopPlace(id: ${gql(stopCode)}) { ${aliases.join('\n')} } }`);
    return Object.values(data.stopPlace ?? {}).flatMap((calls) => calls ?? []);
}

// ---------------------------------------------------------------------------------------------
// Line patterns

function isIn(quay, stopCode) {
    return quay.stopPlace?.id === stopCode || quay.stopPlace?.parent?.id === stopCode;
}

/**
 * The stop a rider knows: the multimodal parent when there is one (as the geocoder and `nearest`
 * return), except that the stop the line was listed at keeps its own code.
 */
function quayStop(quay, preferring) {
    const own = quay.stopPlace ?? null;
    const place = own?.id === preferring ? own : (own?.parent ?? own);
    return {
        code: place?.id ?? quay.id,
        name: place?.name ?? quay.name ?? quay.id,
        city: null,
        location: { lat: place?.latitude ?? quay.latitude ?? 0, lon: place?.longitude ?? quay.longitude ?? 0 },
    };
}

/** Last quay and its stop place(s): what a vehicle's `destinationRef` may name. */
function terminalRefs(pattern) {
    const last = pattern.quays?.[pattern.quays.length - 1];
    if (!last) return [];
    return [last.id, last.stopPlace?.id, last.stopPlace?.parent?.id].filter(Boolean);
}

/**
 * Every journey pattern of a line with its quays and today's journeys (~40 KB for a trunk line), kept
 * in memory for the session: routePattern and every vehicles poll need it.
 */
function linePatterns(lineID) {
    const date = serviceDate(TIME_ZONE);
    return memo(`entur:patterns:${lineID}@${date}`, 24 * 3600_000, async () => {
        const data = await graphQL(JOURNEY_PLANNER, `{ line(id: ${gql(lineID)}) { journeyPatterns { id directionType
                serviceJourneysForDate(date: "${date}") { id }
                quays { id name latitude longitude
                  stopPlace { id name latitude longitude parent { id name latitude longitude } } } } } }`);
        const patterns = data.line?.journeyPatterns;
        if (!patterns) throw new TransitError('notFound', `line ${lineID}`);
        return patterns.map((p) => ({ ...p, quays: p.quays ?? [] }));
    });
}

// ---------------------------------------------------------------------------------------------

/** @type {import('../model.js').TransitProvider} */
export default {
    id: 'entur',
    displayName: 'Entur (Norway)',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    refreshSeconds: 20,
    datasetID: 'entur',
    attribution: 'Data: Entur (NLOD), including data from Norwegian public transport operators',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        // No public stop numbers in Norway (quays only have kerb letters), so name search only.
        // `layers=venue` returns stop places *and* POIs; only `NSR:StopPlace` ids are stops.
        const response = await getJSON(GEOCODER, {
            query: { text, layers: 'venue', size: '20', lang: 'no' },
            headers: HEADERS,
        });
        const stops = [];
        for (const feature of response.features ?? []) {
            const p = feature.properties ?? {};
            const coordinates = feature.geometry?.coordinates ?? [];
            if (!String(p.id ?? '').startsWith('NSR:StopPlace:') || coordinates.length !== 2) continue;
            if (Array.isArray(p.category) && !p.category.some((c) => BUS_CATEGORIES.has(c))) continue;
            stops.push({ code: p.id, name: p.name, city: p.locality ?? null, location: { lat: coordinates[1], lon: coordinates[0] } });
        }
        return stops;
    },

    async linesAtStop(stop) {
        const data = await graphQL(JOURNEY_PLANNER, `{ stopPlace(id: ${gql(stop.code)}) { id ${linesFields(300)} } }`);
        const place = data.stopPlace;
        if (!place) throw new TransitError('notFound', `stop place ${stop.code}`);
        const groups = groupsOf(place);
        const quiet = [...new Set([...groups.values()].filter((g) => g.headsigns.size === 0).map((g) => g.line.id))].sort();
        count(await lookAhead(stop.code, quiet), groups);
        return linesOf(groups, stop.code);
    },

    async routePattern(line) {
        const ref = lineRef(line);
        const patterns = await linePatterns(ref.line);
        const group = patterns.filter((p) => directionKey(p) === ref.direction);
        // Several variants share a direction (short turns, depot runs, school trips). Draw the one
        // that runs most today among those calling at the rider's stop — so the stop is on it.
        const calling = group.filter((p) => p.quays.some((q) => isIn(q, ref.stop)));
        const pool = calling.length ? calling : group;
        let chosen = null;
        for (const p of pool) {
            if (!chosen) { chosen = p; continue; }
            const a = [p.serviceJourneysForDate?.length ?? 0, p.quays.length];
            const b = [chosen.serviceJourneysForDate?.length ?? 0, chosen.quays.length];
            if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) chosen = p;
        }
        if (!chosen) throw new TransitError('notFound', `journey pattern for ${line.id}`);
        const stops = [];
        for (const quay of chosen.quays) {
            const stop = quayStop(quay, ref.stop);
            // Two kerbs of the same stop place back to back would be one stop to a rider.
            if (stops.length && stops[stops.length - 1].stop.code === stop.code) continue;
            stops.push({ stop, sequence: stops.length + 1, distanceAlongRoute: null });
        }
        return { line, stops };
    },

    async vehicles(line) {
        const ref = lineRef(line);
        // Without maxDataAge the feed also returns vehicles last heard from up to an hour ago.
        const data = await graphQL(VEHICLES_API, `{ vehicles(lineRef: ${gql(ref.line)}, maxDataAge: "PT2M") {
            vehicleId direction destinationRef destinationName lastUpdatedEpochSecond bearing
            serviceJourney { id } location { latitude longitude } monitoredCall { stopPointRef } } }`);
        const vehicles = data.vehicles ?? [];
        if (!vehicles.length) return [];

        // The vehicle feed has no journey-pattern id. Some operators (AtB) send a direction that
        // matches the pattern's directionType; others (Skyss) send none, so the vehicle's destination
        // quay is matched against the terminals of this direction's patterns instead.
        const patterns = await linePatterns(ref.line);
        const mine = patterns.filter((p) => directionKey(p) === ref.direction);
        const others = patterns.filter((p) => directionKey(p) !== ref.direction);
        const myTerminals = new Set(mine.flatMap(terminalRefs));
        const otherTerminals = new Set(others.flatMap(terminalRefs));
        const myQuays = new Set(mine.flatMap((p) => p.quays.map((q) => q.id)));
        const otherQuays = new Set(others.flatMap((p) => p.quays.map((q) => q.id)));

        const out = [];
        for (const v of vehicles) {
            const lat = v.location?.latitude;
            const lon = v.location?.longitude;
            if (lat == null || lon == null) continue;
            let belongs;
            const direction = v.direction ? v.direction.toLowerCase() : null;
            if (direction && NAMED_DIRECTIONS.has(ref.direction)) {
                belongs = direction === ref.direction;
            } else if (ref.headsign && v.destinationName === ref.headsign) {
                belongs = true;
            } else if (v.destinationRef && myTerminals.has(v.destinationRef)) {
                if (otherTerminals.has(v.destinationRef)) {
                    // Both directions end there (a loop): fall back to where the bus is calling now.
                    const current = v.monitoredCall?.stopPointRef;
                    if (!current) continue;
                    belongs = myQuays.has(current) && !otherQuays.has(current);
                } else {
                    belongs = true;
                }
            } else {
                belongs = false;
            }
            if (!belongs) continue;
            out.push({
                location: { lat, lon },
                recordedAt: v.lastUpdatedEpochSecond != null ? new Date(v.lastUpdatedEpochSecond * 1000) : null,
                distanceAlongRoute: null,
                tripId: v.serviceJourney?.id ?? null,
                plateNumber: null,
                bearing: v.bearing ?? null,
            });
        }
        return out;
    },

    async arrivals(line, stop) {
        const ref = lineRef(line);
        const data = await graphQL(JOURNEY_PLANNER, `{ stopPlace(id: ${gql(stop.code)}) {
            estimatedCalls(numberOfDepartures: 30, timeRange: 86400, filters: [{ select: [{ lines: [${gql(ref.line)}] }] }]) {
              realtime aimedArrivalTime expectedArrivalTime aimedDepartureTime expectedDepartureTime
              destinationDisplay { frontText } serviceJourney { id journeyPattern { id directionType } } } } }`);
        const calls = data.stopPlace?.estimatedCalls;
        if (!calls) throw new TransitError('notFound', `stop place ${stop.code}`);
        const out = [];
        for (const call of calls) {
            const pattern = call.serviceJourney?.journeyPattern;
            if (!pattern) continue;
            const ok = ref.headsign
                ? !NAMED_DIRECTIONS.has(directionKey(pattern)) && call.destinationDisplay?.frontText === ref.headsign
                : directionKey(pattern) === ref.direction;
            if (!ok) continue;
            const expectedAt = parseDate(call.expectedArrivalTime ?? call.expectedDepartureTime);
            if (!expectedAt) continue;
            out.push({
                expectedAt,
                scheduledAt: parseDate(call.aimedArrivalTime ?? call.aimedDepartureTime),
                isRealtime: call.realtime ?? false,
                tripId: call.serviceJourney?.id ?? null,
            });
        }
        return out.sort((a, b) => a.expectedAt - b.expectedAt);
    },

    /**
     * `nearest` with `multiModalMode: parent` returns the same stop place ids the geocoder does, and
     * the lines ride along in the same request (one call, no per-stop fan-out; ~160 KB for ten stops
     * in central Bergen).
     */
    async stopsNearby(point, radiusMeters) {
        const data = await graphQL(JOURNEY_PLANNER, `{ nearest(latitude: ${point.lat}, longitude: ${point.lon}, maximumDistance: ${Math.trunc(radiusMeters)}, maximumResults: 10,
                  filterByPlaceTypes: [stopPlace], filterByModes: [bus], filterByInUse: true, multiModalMode: parent) {
            edges { node { distance place { ... on StopPlace { id name latitude longitude ${linesFields(120)} } } } } } }`);
        const out = [];
        for (const edge of data.nearest?.edges ?? []) {
            const place = edge?.node?.place;
            if (!place?.id || place.latitude == null || place.longitude == null) continue;
            const stop = { code: place.id, name: place.name ?? place.id, city: null, location: { lat: place.latitude, lon: place.longitude } };
            // No week-ahead look per stop here: the list is about what runs now.
            const lines = linesOf(groupsOf(place), place.id);
            if (!lines.length) continue;
            out.push({ stop, distanceMeters: edge.node.distance ?? meters(point, stop.location), lines });
        }
        return out.sort((a, b) => a.distanceMeters - b.distanceMeters);
    },
};
