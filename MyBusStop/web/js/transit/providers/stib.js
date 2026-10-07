// Brussels, Belgium — STIB-MIVB (buses, trams and metro) through the Belgian Mobility Company's
// open-data gateway (data.belgianmobility.io). Official and keyless; CC BY 4.0, with the credit line
// the platform's terms prescribe. Anonymous callers are told to expect about 100 requests a day and
// 10 a minute (not enforced as of September 2026), so everything static is fetched once a day and the
// board costs two small requests a refresh. The gateway sends `access-control-allow-origin: *`.
//
// Four datasets, each filtered with an Opendatasoft-like `where`:
// - `static/stopDetails`: every stop pole (2.5k, ~330 KB of JSON), bilingual names.
// - `static/stopsByLine`: the ordered stop ids of each line in each direction (~150 rows, ~120 KB).
// - `rt/WaitingTimes`: the next two passages of each line at a stop.
// - `rt/VehiclePositions`: each vehicle as the last stop it passed plus metres since.
//
// A TransitLine is one line in one direction ("City" or "Suburb"). The static datasets tag some poles
// with a letter ("2292B"); the realtime ones never do ("2292"), so they are matched on the digits.
// Names are JSON strings inside the JSON ("{\"fr\":…,\"nl\":…}"). There is no proximity query (a geo
// filter is silently ignored), so nearby stops come from the cached list.
// Port of BusBus/Transit/Providers/STIBProvider.swift.

import { Capability, TransitError, fold, meters, makeLine } from '../model.js';
import { getJSON, staticData, memo, serviceDate } from '../http.js';
import { RouteGeometry } from '../geometry.js';

const BASE = 'https://api-management-discovery-production.azure-api.net/api/datasets/stibmivb';
const TIME_ZONE = 'Europe/Brussels';
const DAY = 86_400_000;

/**
 * Stop and terminus names come in French and Dutch. Dutch readers get Dutch; everyone else French,
 * the language most visitors meet first. Resolved per call, like the page's language.
 */
function language() {
    const tag = (globalThis.document?.documentElement?.lang || globalThis.navigator?.language || '').toLowerCase();
    return tag.startsWith('nl') ? 'nl' : 'fr';
}

const provider = {
    id: 'stib',
    displayName: 'STIB-MIVB (Brussels)',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    // Both realtime datasets refresh about every 20 s; the slow end of the band spares the quota.
    refreshSeconds: 30,
    reportsShadowTrips: false,

    // The platform's terms (art. 4) ask for "Source: [PTO Name] – Open Data – [Date of dataset
    // update]". The realtime datasets are updated continuously, so the date is today's in Brussels.
    get attribution() {
        return `Source: STIB-MIVB – Open Data – ${serviceDate(TIME_ZONE)}`;
    },

    // Cached lines and patterns carry names, so each language is its own dataset.
    get datasetID() {
        return `stib.${language()}`;
    },

    async searchStops(query) {
        query = String(query ?? '').trim();
        if (!query) return [];
        const net = await network();
        const lang = language();
        if (/^\d/.test(query) && !query.includes(' ')) {
            const code = query.toUpperCase();
            const exact = net.stops.get(code);
            if (exact) return [poleStop(exact, lang)];
            return [...net.stops.values()]
                .filter((pole) => digits(pole.id) === code)
                .sort((a, b) => cmp(a.id, b.id))
                .map((pole) => poleStop(pole, lang));
        }
        const folded = fold(query);
        const tokens = folded.split(' ').filter(Boolean);
        return [...net.stops.values()]
            .filter((pole) => tokens.every((t) => pole.key.includes(t)))
            .map((pole) => poleStop(pole, lang))
            .sort((a, b) => {
                const ap = fold(a.name).startsWith(folded), bp = fold(b.name).startsWith(folded);
                if (ap !== bp) return ap ? -1 : 1;
                return cmp(a.name, b.name) || cmp(a.code, b.code);
            })
            .slice(0, 50);
    },

    async linesAtStop(stop) {
        const net = await network();
        const lang = language();
        return net.routes
            .filter((route) => route.points.includes(stop.code))
            .map((route) => net.line(route, lang))
            .sort(order);
    },

    // Poles missing from `stopDetails` (depots, works diversions, ~90 of them) have no coordinates and
    // are left out of the pattern.
    async routePattern(line) {
        const net = await network();
        const route = net.route(line);
        const lang = language();
        const stops = route.points
            .map((id, index) => {
                const pole = net.stops.get(id);
                return pole ? { stop: poleStop(pole, lang), sequence: index + 1, distanceAlongRoute: null } : null;
            })
            .filter(Boolean);
        if (stops.length < 2) throw new TransitError('notFound', `stops for STIB line ${line.id}`);
        return { line: net.line(route, lang), stops };
    },

    // The feed gives no coordinates, only the last stop passed and the metres driven since, so each
    // vehicle is placed that far along the pattern's stop-to-stop polyline. Nor does it say the
    // direction outright: `directionId` is the stop the vehicle is heading for, usually the terminus,
    // but a short working's last stop or a diversion's may be neither.
    async vehicles(line) {
        const net = await network();
        const route = net.route(line);
        const other = net.routes.find((r) => r.line === route.line && r.direction !== route.direction) ?? null;
        const [response, pattern] = await Promise.all([
            getJSON(`${BASE}/rt/VehiclePositions`, { query: { where: `lineid=${quoted(route.line)}` } }),
            provider.routePattern(line),
        ]);
        const geometry = new RouteGeometry(pattern);
        const indexByDigits = new Map();
        pattern.stops.forEach((s, i) => {
            const key = digits(s.stop.code);
            if (!indexByDigits.has(key)) indexByDigits.set(key, i);
        });
        const d = geometry.stopDistances;
        return (response.results ?? [])
            .flatMap((row) => nested(row.vehiclepositions) ?? [])
            .filter((vehicle) => carries(route, vehicle, other))
            .map((vehicle) => {
                const index = indexByDigits.get(vehicle.pointId);
                if (index === undefined) return null;
                const start = d[index];
                const end = index + 1 < d.length ? d[index + 1] : start;
                const along = Math.min(start + Math.max(Number(vehicle.distanceFromPoint) || 0, 0), end);
                return { location: pointAtDistance(pattern, d, along), distanceAlongRoute: along };
            })
            .filter(Boolean);
    },

    // Two passages per line and stop. "Theoretical time" marks a timetable guess; buses flagged
    // "Do not embark" (arriving to terminate) are no use to someone waiting, so they are dropped.
    async arrivals(line, stop) {
        const net = await network();
        const route = net.route(line);
        const response = await getJSON(`${BASE}/rt/WaitingTimes`, { query: {
            where: `pointid=${quoted(digits(stop.code))} and lineid=${quoted(route.line)}`,
        } });
        // Most poles serve one direction; where a line calls both ways (a loop, a terminus) the
        // passages are told apart by where they are going.
        const bothWays = net.routes.filter((r) => r.line === route.line && r.points.includes(stop.code)).length > 1;
        const cutoff = Date.now() - 60_000;
        return (response.results ?? [])
            .flatMap((row) => nested(row.passingtimes) ?? [])
            .filter((p) => p.message?.en !== 'Do not embark')
            .filter((p) => !bothWays || p.destination?.fr === route.destination.fr)
            .map((p) => {
                const expected = parse(p.expectedArrivalTime);
                if (!expected || expected.getTime() < cutoff) return null;
                return { expectedAt: expected, scheduledAt: null, isRealtime: p.message?.en !== 'Theoretical time' };
            })
            .filter(Boolean)
            .sort((a, b) => a.expectedAt - b.expectedAt);
    },

    // Stops and their lines both come from the cached lists: no request of its own.
    async stopsNearby(point, radiusMeters) {
        const net = await network();
        const lang = language();
        return [...net.stops.values()]
            .map((pole) => ({ pole, distance: meters(point, pole.location) }))
            .filter((n) => n.distance <= radiusMeters)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 30)
            .map(({ pole, distance }) => ({
                stop: poleStop(pole, lang),
                distanceMeters: distance,
                lines: net.routes
                    .filter((route) => route.points.includes(pole.id))
                    .map((route) => net.line(route, lang))
                    .sort(order),
            }));
    },
};

export default provider;

// ---------------------------------------------------------------------------------------------
// Cached reference data

/** Both static datasets, decoded and trimmed, kept for a day. French and Dutch are both kept. */
function reference() {
    return staticData('stib.network.v1', DAY, async () => {
        const [stops, routes] = await Promise.all([
            getJSON(`${BASE}/static/stopDetails`),
            getJSON(`${BASE}/static/stopsByLine`),
        ]);
        return {
            // [id, fr, nl, lat, lon]
            stops: (stops.results ?? []).map((row) => {
                const coordinates = nested(row.gpscoordinates);
                if (!coordinates || coordinates.latitude == null || coordinates.longitude == null) return null;
                const name = nested(row.name) ?? {};
                return [row.id, name.fr ?? null, name.nl ?? null, coordinates.latitude, coordinates.longitude];
            }).filter(Boolean),
            routes: (routes.results ?? []).map((row) => {
                const points = nested(row.points);
                if (!Array.isArray(points) || !points.length) return null;
                const destination = nested(row.destination) ?? {};
                return {
                    line: row.lineid,
                    direction: row.direction, // "City" or "Suburb"
                    destination: { fr: destination.fr ?? null, nl: destination.nl ?? null },
                    // Pole ids in order, letters and all.
                    points: [...points].sort((a, b) => a.order - b.order).map((p) => p.id),
                };
            }).filter(Boolean),
        };
    });
}

function network() {
    return memo('stib:network', DAY, async () => new STIBNetwork(await reference()));
}

class STIBNetwork {
    constructor({ stops, routes }) {
        this.stops = new Map();
        for (const [id, fr, nl, lat, lon] of stops) {
            if (this.stops.has(id)) continue;
            this.stops.set(id, {
                id, name: { fr, nl }, location: { lat, lon },
                key: fold([fr, nl].filter(Boolean).join(' ')), // Both names folded, for search.
            });
        }
        this.routes = routes;
    }

    route(line) {
        const route = this.routes.find((r) => routeID(r) === line.id);
        if (!route) throw new TransitError('notFound', `STIB line ${line.id} (was it loaded from another provider?)`);
        return route;
    }

    line(route, lang) {
        const destination = pick(route.destination, lang);
        const first = route.points.length ? this.stops.get(route.points[0]) : null;
        return makeLine({
            id: routeID(route),
            shortName: route.line,
            headsign: destination,
            agency: 'STIB-MIVB',
            origin: first ? pick(first.name, lang) : null,
            destination,
        });
    }
}

function routeID(route) {
    return `${route.line}-${route.direction}`;
}

/**
 * Whether a vehicle of this line is travelling this way. A vehicle bound for this route's terminus
 * is; one bound for the other's is not. Otherwise it is judged by the stop it last passed: on this
 * route only, or on both with the stop it is heading for further along here.
 */
function carries(route, vehicle, other) {
    const terminus = (r) => (r.points.length ? digits(r.points[r.points.length - 1]) : null);
    if (vehicle.directionId === terminus(route)) return true;
    if (other && vehicle.directionId === terminus(other)) return false;
    const routeDigits = route.points.map(digits);
    const at = routeDigits.indexOf(vehicle.pointId);
    if (at < 0) return false;
    if (!other || !other.points.some((p) => digits(p) === vehicle.pointId)) return true;
    const heading = routeDigits.indexOf(vehicle.directionId);
    return heading >= 0 ? at <= heading : false;
}

/** The point a distance along the stop-to-stop polyline, clamped to its ends. */
function pointAtDistance(pattern, stopDistances, distance) {
    const points = pattern.stops.map((s) => s.stop.location);
    if (!points.length) return { lat: 0, lon: 0 };
    let index = -1;
    for (let i = stopDistances.length - 1; i >= 0; i--) if (stopDistances[i] <= distance) { index = i; break; }
    if (index < 0 || index + 1 >= points.length) return distance <= 0 ? points[0] : points[points.length - 1];
    const a = points[index], b = points[index + 1];
    const span = stopDistances[index + 1] - stopDistances[index];
    const t = span > 0 ? Math.min(1, (distance - stopDistances[index]) / span) : 0;
    return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
}

function poleStop(pole, lang) {
    return { code: pole.id, name: pick(pole.name, lang) ?? pole.id, city: null, location: pole.location };
}

/** French and Dutch, the reader's first. */
function pick(name, lang) {
    const order = lang === 'nl' ? [name?.nl, name?.fr] : [name?.fr, name?.nl];
    for (const value of order) {
        const trimmed = value == null ? '' : String(value).trim();
        if (trimmed) return trimmed;
    }
    return null;
}

/** Numbers in numeric order ("1" … "98"), then anything else ("T81"). */
function order(a, b) {
    const n = (s) => (/^\d+$/.test(s) ? Number(s) : Number.MAX_SAFE_INTEGER);
    return n(a.shortName) - n(b.shortName) || cmp(a.shortName, b.shortName) || cmp(a.id, b.id);
}

/** A pole id without its letter, as the realtime datasets write it: "2292B" → "2292". */
function digits(id) {
    return String(id).match(/^\d*/)[0];
}

/** Several fields are JSON documents serialised into a string. */
function nested(string) {
    if (typeof string !== 'string') return null;
    try {
        return JSON.parse(string);
    } catch {
        return null;
    }
}

/** The gateway's string literal. */
function quoted(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** "2026-09-28T15:46:01.541+02:00" — Brussels offset, with or without milliseconds. */
function parse(string) {
    if (!string) return null;
    const date = new Date(string);
    return Number.isNaN(date.getTime()) ? null : date;
}

function cmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
