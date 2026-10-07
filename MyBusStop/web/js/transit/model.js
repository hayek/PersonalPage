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
 * @property {string} shortName
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

/** Shorthand used by every adapter, so a line always carries a `providerRefs` object. */
export function makeLine(fields) {
    return { headsign: null, agency: null, origin: null, destination: null, brandColorIndex: null, ...fields, providerRefs: { ...(fields.providerRefs ?? {}) } };
}
