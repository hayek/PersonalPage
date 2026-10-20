// The provider-agnostic transit model, as in the app (BusBus/Transit/Models/TransitModels.swift).
// Every adapter maps its own responses into these shapes; nothing above the provider layer knows
// which service the data came from. Plain objects, so a configuration can go to localStorage as is.
// Times are Date objects; an optional field is null or absent.

/**
 * @typedef {{lat: number, lon: number}} GeoPoint
 *
 * @typedef {object} TransitStop
 * @property {string} code      Stop id the provider is asked by again. Stable across days.
 * @property {string} name
 * @property {string|null} [city]
 * @property {GeoPoint} location
 * @property {string|null} [address]  Street address, when the provider publishes one.
 *
 * @typedef {object} TransitLine  One direction/variant of a line: the unit a rider waits for.
 * @property {string} id
 * @property {string} shortName  What the vehicle and the sign print, trimmed; "" when the feed gives
 *     no number. Never an internal id, "?" or the long name: a line without a number is named by
 *     where it goes (`lineTitle`).
 * @property {string|null} [longName]  The feed's route long name, when it has one.
 * @property {string|null} [mode]  A value of `Mode`, only when the feed states it (GTFS route_type,
 *     MOTIS mode, Entur transportMode, TfL mode, VAG Produkt…); null otherwise, never guessed.
 * @property {string|null} [headsign]
 * @property {string|null} [agency]
 * @property {string|null} [origin]
 * @property {string|null} [destination]
 * @property {number|null} [brandColorIndex]  Palette index the operator publishes the line in.
 * @property {Record<string, string>} providerRefs  Adapter-specific extras for calling back.
 *
 * @typedef {{stop: TransitStop, sequence: number, distanceAlongRoute?: number|null}} PatternStop
 * @typedef {{line: TransitLine, stops: PatternStop[]}} RoutePattern  Ordered stops of one direction.
 *
 * @typedef {object} VehiclePosition
 * @property {GeoPoint} location
 * @property {Date|null} [recordedAt]
 * @property {number|null} [distanceAlongRoute]  Metres from the start, when the provider computes it.
 * @property {string|null} [tripId]
 * @property {string|null} [plateNumber]
 * @property {number|null} [bearing]
 *
 * @typedef {object} Arrival
 * @property {Date} expectedAt
 * @property {Date|null} [scheduledAt]
 * @property {boolean} isRealtime
 * @property {string|null} [tripId]
 * @property {GeoPoint|null} [vehicleLocation]  Some providers attach the bus position to the prediction.
 *
 * @typedef {{stop: TransitStop, distanceMeters: number, lines: TransitLine[]}} NearbyStop
 *
 * @typedef {object} TransitProvider
 * @property {string} id
 * @property {string} displayName
 * @property {Set<string>} capabilities  Values of `Capability`.
 * @property {number} refreshSeconds     What the board polls at, 20–30 s for anything on a network.
 * @property {string} [datasetID]        Keys cached route patterns; defaults to `id`.
 * @property {string|null} [attribution] The credit line the data's licence asks for, verbatim.
 * @property {boolean} [reportsShadowTrips]
 * @property {(query: string) => Promise<TransitStop[]>} searchStops
 * @property {(stop: TransitStop) => Promise<TransitLine[]>} linesAtStop
 * @property {(line: TransitLine) => Promise<RoutePattern>} routePattern
 * @property {(line: TransitLine) => Promise<VehiclePosition[]>} vehicles  May be empty; that is not an error.
 * @property {(line: TransitLine, stop: TransitStop) => Promise<Arrival[]>} arrivals  Soonest first.
 * @property {(point: GeoPoint, radiusMeters: number) => Promise<NearbyStop[]>} [stopsNearby]  Nearest first.
 * @property {(line: TransitLine, pattern: RoutePattern) => Promise<RouteShape|null>} [routeShape]
 *     The line's real path along the roads, raw (unjudged, unsimplified); null when the feed has none for
 *     it. Asked for only through js/transit/shapes/route-shape.js `loadRouteShape`, which judges and caches it.
 * @property {(line: TransitLine) => boolean} [hasRouteShape]  Whether this line can have a route to draw;
 *     defaults to true when `routeShape` exists.
 * @property {{stops: number, ends: number}} [shapeTolerance]  How far a stop may stand from this feed's
 *     shapes; defaults to TOLERANCE.platforms (js/transit/shapes/shape-check.js).
 * @property {string} [shapeDatasetID]  Which cache a shape is kept under; defaults to `datasetID`, then `id`.
 *
 * @typedef {object} RouteShape  A line's path: one polyline per branch, in route order.
 * @property {GeoPoint[][]} branches
 * @property {Record<string, GeoPoint>} [stopPositions]  Where each stop really stands, by stop code, when
 *     the shape's source knows better than the provider's own stop list.
 */

export const Capability = Object.freeze({
    stopSearchByName: 'stopSearchByName',
    stopSearchByCode: 'stopSearchByCode',
    linesAtStop: 'linesAtStop',
    routePattern: 'routePattern',
    vehiclePositions: 'vehiclePositions',
    realtimeArrivals: 'realtimeArrivals',
    scheduledArrivals: 'scheduledArrivals',
    nearbyStops: 'nearbyStops',
});

export class TransitError extends Error {
    /** @param {'unsupported'|'notFound'|'badResponse'} kind */
    constructor(kind, message) {
        super(kind === 'unsupported' ? `Not supported by this provider: ${message}`
            : kind === 'notFound' ? `Not found: ${message}` : `Bad response: ${message}`);
        this.name = 'TransitError';
        this.kind = kind;
    }
}

/** An address from the pieces a provider publishes, with blanks dropped; null when nothing is left. */
export function stopAddress(parts, separator = ' ') {
    const kept = parts.map((p) => (p == null ? '' : String(p).trim())).filter(Boolean);
    return kept.length ? kept.join(separator) : null;
}

/** Folds case and accents away, for searching a downloaded stop list ("Bełżec" → "belzec"). */
export function fold(text) {
    return String(text ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/ł/g, 'l').replace(/Ł/g, 'l').replace(/ø/g, 'o').replace(/Ø/g, 'o').replace(/ß/g, 'ss')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/** Great-circle distance in metres. */
export function meters(a, b) {
    const r = 6_371_000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Natural ordering for line names: "2" < "10" < "10A" < "N12". */
export const compareLineNames = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/**
 * Shorthand used by every adapter, so a line always carries a `providerRefs` object. Names are
 * trimmed here, and a missing number becomes "", whatever the adapter passed.
 */
export function makeLine(fields) {
    return {
        headsign: null, agency: null, origin: null, destination: null, brandColorIndex: null, longName: null, mode: null,
        ...fields,
        shortName: String(fields.shortName ?? '').trim(),
        longName: trimmed(fields.longName),
        providerRefs: { ...(fields.providerRefs ?? {}) },
    };
}

const trimmed = (text) => (text == null ? null : String(text).trim() || null);

// MARK: Modes

/** What kind of vehicle a line runs, as the feed states it. A line keeps null when it does not. */
export const Mode = Object.freeze({
    bus: 'bus', trolleybus: 'trolleybus', tram: 'tram', metro: 'metro', rail: 'rail',
    ferry: 'ferry', cable: 'cable', other: 'other',
});

/** GTFS `route_type`, basic and extended (Google's "Extended GTFS Route Types"). */
export function modeFromRouteType(type) {
    const t = Number(type);
    if (type == null || type === '' || !Number.isInteger(t)) return null;
    switch (t) {
        case 0: return Mode.tram;
        case 1: case 12: return Mode.metro;
        case 2: return Mode.rail;
        case 3: return Mode.bus;
        case 4: return Mode.ferry;
        case 5: case 6: case 7: return Mode.cable;
        case 11: return Mode.trolleybus;
        default: break;
    }
    if (t >= 100 && t < 200) return Mode.rail;
    if (t >= 200 && t < 300) return Mode.bus; // coach
    if (t >= 400 && t < 500) return Mode.metro; // urban railway
    if (t >= 700 && t < 800) return Mode.bus;
    if (t === 800) return Mode.trolleybus;
    if (t >= 900 && t < 1000) return Mode.tram;
    if ((t >= 1000 && t < 1100) || t === 1200) return Mode.ferry;
    if (t >= 1300 && t < 1500) return Mode.cable; // aerial lifts, funiculars
    return Mode.other;
}

/** MOTIS (Transitous) `mode`. */
export function modeFromMotis(mode) {
    switch (String(mode ?? '').toUpperCase()) {
        case '': return null;
        case 'BUS': case 'COACH': return Mode.bus;
        case 'TRAM': return Mode.tram;
        case 'SUBWAY': case 'METRO': return Mode.metro;
        case 'RAIL': case 'HIGHSPEED_RAIL': case 'LONG_DISTANCE': case 'NIGHT_RAIL': case 'REGIONAL_FAST_RAIL':
        case 'REGIONAL_RAIL': case 'SUBURBAN': return Mode.rail;
        case 'FERRY': return Mode.ferry;
        case 'AERIAL_LIFT': case 'FUNICULAR': case 'CABLE_CAR': return Mode.cable;
        default: return Mode.other;
    }
}

/**
 * A mode a feed names in words: Entur's `transportMode`, TfL's `mode`, VAG's `Produkt`, a Swiss
 * board's transport type. Null for a word that is not one.
 */
export function modeNamed(word) {
    switch (String(word ?? '').toLowerCase().replace(/[^a-z]/g, '')) {
        case 'bus': case 'coach': return Mode.bus;
        case 'trolleybus': return Mode.trolleybus;
        case 'tram': return Mode.tram;
        case 'metro': case 'subway': case 'ubahn': case 'tube': case 'dlr': case 'monorail': return Mode.metro;
        case 'rail': case 'train': case 'overground': case 'nationalrail': case 'elizabethline': case 'sbahn': return Mode.rail;
        case 'water': case 'ferry': case 'riverbus': case 'boat': return Mode.ferry;
        case 'cableway': case 'cablecar': case 'funicular': case 'lift': return Mode.cable;
        case '': return null;
        default: return null;
    }
}

// MARK: Naming a line

/** Whether the feed gives the line a number to print. */
export const isNumbered = (line) => String(line?.shortName ?? '').trim() !== '';

/**
 * A line without a number is known by where it goes: its destination, else its long name, else its
 * headsign. Null when the feed names none of them.
 */
export const lineTitle = (line) => line?.destination ?? line?.longName ?? line?.headsign ?? null;

/**
 * The line in words, for screen readers and messages: "line 12", or for one without a number
 * "Israel Railways to Modi'in Center".
 */
export function lineLabel(line) {
    if (isNumbered(line)) return `line ${String(line.shortName).trim()}`;
    const agency = line?.agency ?? null;
    if (line?.destination) return agency ? `${agency} to ${line.destination}` : `service to ${line.destination}`;
    const name = line?.longName ?? line?.headsign ?? null;
    return [agency, name].filter(Boolean).join(' ') || 'unnamed service';
}

/** Numbered lines first, in natural order; then the rest by where they go. */
export function compareLines(a, b) {
    const na = isNumbered(a), nb = isNumbered(b);
    if (na !== nb) return na ? -1 : 1;
    if (na) return compareLineNames(a.shortName, b.shortName);
    return String(lineTitle(a) ?? '').localeCompare(String(lineTitle(b) ?? ''), undefined, { sensitivity: 'base' })
        || String(a.agency ?? '').localeCompare(String(b.agency ?? ''));
}

// MARK: Services a rider cannot tell apart

/**
 * Lines without a number that look the same to a rider (same agency, mode and destination — or long
 * name and headsign where the feed names no destination) are one service: a feed that lists each
 * train run as its own route lists the same "to Modi'in Center" dozens of times. Each becomes one
 * line with an id made from that identity, so a board saved today still finds it after the
 * timetable renumbers its runs. Its `providerRefs` are the representative member's (the first the
 * provider lists: its next departure, or its longest pattern), plus `serviceMembers`, the JSON list
 * of every member's id, and `serviceRepresentative`, the id the pattern and the shape are asked by.
 * A line without a number on its own becomes a service of one, so its id is just as stable. Numbered
 * lines pass through untouched.
 * @param {TransitLine[]} lines
 * @returns {TransitLine[]}
 */
export function mergeServices(lines) {
    const out = [];
    const groups = new Map();
    for (const line of lines) {
        if (isNumbered(line)) { out.push(line); continue; }
        const key = serviceKey(line);
        if (!groups.has(key)) {
            const group = { key, members: [] };
            groups.set(key, group);
            out.push(group);
        }
        groups.get(key).members.push(line);
    }
    return out.map((entry) => (entry.members ? serviceLine(entry.key, entry.members) : entry));
}

/** What a rider sees of an unnumbered line; equal keys are one service. */
function serviceKey(line) {
    const destination = line.destination ?? null;
    return JSON.stringify([
        line.agency ?? null, line.mode ?? null, destination,
        destination ? null : line.longName ?? null,
        destination ? null : line.headsign ?? null,
    ]);
}

function serviceLine(key, members) {
    const first = members[0];
    // A member already a service (a saved one, merged again) keeps its own members.
    const ids = [...new Set(members.flatMap((m) => serviceMemberIDs(m)))];
    const same = (field) => (members.every((m) => (m[field] ?? null) === (first[field] ?? null)) ? first[field] ?? null : null);
    const refs = { ...first.providerRefs };
    delete refs.serviceMembers;
    delete refs.serviceRepresentative;
    return {
        id: `service:${fnv64(key)}`,
        shortName: '',
        longName: same('longName'),
        mode: first.mode ?? null,
        headsign: same('headsign'),
        agency: first.agency ?? null,
        origin: same('origin'),
        destination: first.destination ?? null,
        brandColorIndex: same('brandColorIndex'),
        providerRefs: { ...refs, serviceRepresentative: serviceRepresentativeID(first), serviceMembers: JSON.stringify(ids) },
    };
}

/** Whether this line is a merged service (`mergeServices`). */
export const isService = (line) => typeof line?.providerRefs?.serviceMembers === 'string';

/** The ids of the routes a service stands for; a plain line stands for itself. */
export function serviceMemberIDs(line) {
    if (!isService(line)) return [line.id];
    try {
        const ids = JSON.parse(line.providerRefs.serviceMembers);
        return Array.isArray(ids) && ids.length ? ids.map(String) : [serviceRepresentativeID(line)];
    } catch {
        return [serviceRepresentativeID(line)];
    }
}

const serviceRepresentativeID = (line) => (isService(line) ? line.providerRefs.serviceRepresentative ?? line.id : line.id);

/** The member a service's pattern, shape and positions are asked by, as a line of the provider's own. */
export function serviceRepresentative(line) {
    if (!isService(line)) return line;
    const refs = { ...line.providerRefs };
    delete refs.serviceMembers;
    delete refs.serviceRepresentative;
    return { ...line, id: serviceRepresentativeID(line), providerRefs: refs };
}

/** FNV-1a, 64-bit, as hex: a short, stable id from a service's identity. */
function fnv64(text) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(text)) {
        hash ^= BigInt(byte);
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0');
}
