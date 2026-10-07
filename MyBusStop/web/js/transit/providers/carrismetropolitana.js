// Portugal — Carris Metropolitana, the bus network of the Lisbon metropolitan area outside the city
// itself (api.carrismetropolitana.pt). Official, open-source, keyless; no published rate limit. GTFS
// and API data are CC-BY-4.0. Vehicle fixes are ~15–30 s old. Every endpoint sends
// `access-control-allow-origin: *`.
//
// The API has no name search and no proximity query, so both run on the full stop list
// (`/v2/stops`, 12.7k stops: 6.8 MB of JSON, ~540 KB gzipped on the wire), downloaded together with
// `/v2/lines` (~40 KB gz) and `/municipalities` (<1 KB gz). Only the fields used here are kept
// (~2 MB), in Cache Storage for a day.
// Port of BusBus/Transit/Providers/CarrisMetropolitanaProvider.swift.

import { Capability, TransitError, fold, meters, makeLine, compareLineNames } from '../model.js';
import { getJSON, memo, staticData, serviceDate } from '../http.js';

const BASE = 'https://api.carrismetropolitana.pt';
const DAY = 86_400_000;

const provider = {
    id: 'carrismetropolitana',
    displayName: 'Carris Metropolitana (Lisbon area)',
    attribution: 'Data: Carris Metropolitana (CC BY 4.0)',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    refreshSeconds: 20,
    datasetID: 'carrismetropolitana',
    reportsShadowTrips: false,

    async searchStops(query) {
        query = String(query ?? '').trim();
        if (!query) return [];
        const net = await network();
        if (/^\d+$/.test(query)) {
            // Stop numbers are six digits on the pole; accept them without the leading zero too.
            const entry = net.stopsByID.get(query.padStart(6, '0'));
            return entry ? [net.stop(entry)] : [];
        }
        const folded = fold(query);
        const tokens = folded.split(' ').filter(Boolean);
        return net.stops
            .filter((entry) => tokens.every((t) => entry.searchKey.includes(t)))
            .sort((a, b) => {
                const ap = a.searchKey.startsWith(folded), bp = b.searchKey.startsWith(folded);
                if (ap !== bp) return ap ? -1 : 1;
                return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
            })
            .slice(0, 50)
            .map((entry) => net.stop(entry));
    },

    // One line per pattern (a direction/variant) that the stop list says calls here. Each pattern is
    // fetched (~10 KB gz) for its headsign and end stops, and kept for `routePattern`.
    async linesAtStop(stop) {
        const net = await network();
        const entry = net.stopsByID.get(stop.code);
        if (!entry) throw new TransitError('notFound', `stop ${stop.code}`);
        const patterns = await Promise.all(entry.patternIds.map((id) => pattern(id).catch(() => null)));
        return patterns
            .filter(Boolean)
            .map((p) => net.lineForPattern(p))
            .sort((a, b) => compareLineNames(a.shortName, b.shortName) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async routePattern(line) {
        const net = await network();
        const p = await pattern(line.id);
        const stops = [...p.path]
            .sort((a, b) => a.stop_sequence - b.stop_sequence)
            .map((node) => {
                const entry = net.stopsByID.get(node.stop_id);
                if (!entry) return null;
                return {
                    stop: net.stop(entry),
                    sequence: node.stop_sequence,
                    distanceAlongRoute: node.distance == null ? null : node.distance * 1_000, // published in km
                };
            })
            .filter(Boolean);
        if (!stops.length) throw new TransitError('notFound', `stops for pattern ${line.id}`);
        return { line, stops };
    },

    // `/v2/vehicles` is the whole fleet (~900 buses, ~100 KB gz); its line filters are ignored, so it
    // is fetched once per 10 s and shared by every line on the board.
    async vehicles(line) {
        const all = await memo('carris:vehicles', 10_000, () => getJSON(`${BASE}/v2/vehicles`));
        return (Array.isArray(all) ? all : [])
            .filter((v) => v.pattern_id != null && stripVersion(v.pattern_id) === line.id)
            .filter((v) => v.lat != null && v.lon != null)
            .map((v) => ({
                location: { lat: v.lat, lon: v.lon },
                recordedAt: v.timestamp != null ? new Date(v.timestamp) : null, // Unix milliseconds
                distanceAlongRoute: null,
                tripId: v.trip_id ?? null,
                plateNumber: v.license_plate ?? null,
                bearing: v.bearing ?? null,
            }));
    },

    // `/v2/arrivals/by_stop` returns the stop's whole service day, past trips included and in no
    // particular order; it is shared across the lines polled at the same stop.
    async arrivals(line, stop) {
        const all = await memo(`carris:arrivals:${stop.code}`, 10_000,
            () => getJSON(`${BASE}/v2/arrivals/by_stop/${encodeURIComponent(stop.code)}`));
        const cutoff = Date.now() - 60_000;
        return (Array.isArray(all) ? all : [])
            // `observed_arrival_unix` is set once the bus has been seen passing the stop.
            .filter((a) => a.pattern_id != null && stripVersion(a.pattern_id) === line.id && a.observed_arrival_unix == null)
            .map((a) => {
                const unix = a.estimated_arrival_unix ?? a.scheduled_arrival_unix;
                if (unix == null || unix * 1000 < cutoff) return null;
                return {
                    expectedAt: new Date(unix * 1000),
                    scheduledAt: a.scheduled_arrival_unix != null ? new Date(a.scheduled_arrival_unix * 1000) : null,
                    isRealtime: a.estimated_arrival_unix != null,
                    tripId: a.trip_id ?? null,
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.expectedAt - b.expectedAt);
    },

    // Computed from the cached stop list; lines carry only the number (no headsign) so no per-pattern
    // calls are made — `linesAtStop` fills in the rest once a stop is picked.
    async stopsNearby(point, radiusMeters) {
        const net = await network();
        const latSpan = radiusMeters / 111_000;
        const lonSpan = latSpan / Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01);
        return net.stops
            .filter((e) => Math.abs(e.lat - point.lat) <= latSpan && Math.abs(e.lon - point.lon) <= lonSpan)
            .map((e) => {
                const stop = net.stop(e);
                return {
                    stop,
                    distanceMeters: meters(point, stop.location),
                    lines: e.patternIds.map((id) => net.lineForPatternID(id)),
                };
            })
            .filter((n) => n.distanceMeters <= radiusMeters)
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .slice(0, 30);
    },
};

export default provider;

// ---------------------------------------------------------------------------------------------
// Cached reference data

/** The stop, line and municipality lists, trimmed to what is used, for a day. */
function reference() {
    return staticData('carrismetropolitana.network.v1', DAY, async () => {
        const [stops, lines, municipalities] = await Promise.all([
            getJSON(`${BASE}/v2/stops`),
            getJSON(`${BASE}/v2/lines`),
            getJSON(`${BASE}/municipalities`).catch(() => []),
        ]);
        return {
            // [id, long_name, tts_name (when it differs), lat, lon, municipality_id, pattern_ids].
            // Stops with no patterns are out of service; leave them out of search and nearby.
            stops: stops
                .filter((s) => Array.isArray(s.pattern_ids) && s.pattern_ids.length && s.lat != null && s.lon != null)
                .map((s) => [s.id, s.long_name, s.tts_name && s.tts_name !== s.long_name ? s.tts_name : null,
                    s.lat, s.lon, s.municipality_id ?? null, s.pattern_ids]),
            lines: Object.fromEntries(lines.map((l) => [l.id, l.short_name ?? null])),
            municipalities: Object.fromEntries((Array.isArray(municipalities) ? municipalities : []).map((m) => [m.id, m.name])),
        };
    });
}

/** The reference lists, indexed for search, nearby and name lookups. */
function network() {
    return memo('carris:network', DAY, async () => new CarrisNetwork(await reference()));
}

class CarrisNetwork {
    constructor({ stops, lines, municipalities }) {
        this.stops = stops.map(([id, name, tts, lat, lon, municipalityID, patternIds]) => ({
            id, name, lat, lon, municipalityID, patternIds,
            searchKey: fold([name, tts ?? ''].join(' ')),
        }));
        this.stopsByID = new Map();
        for (const entry of this.stops) if (!this.stopsByID.has(entry.id)) this.stopsByID.set(entry.id, entry);
        this.lines = lines;
        this.municipalities = municipalities;
    }

    stop(entry) {
        return {
            code: entry.id,
            name: entry.name,
            city: (entry.municipalityID && this.municipalities[entry.municipalityID]) || null,
            location: { lat: entry.lat, lon: entry.lon },
        };
    }

    /** "stop name, municipality" */
    place(stopID) {
        const entry = this.stopsByID.get(stopID);
        if (!entry) return null;
        const stop = this.stop(entry);
        return [stop.name, stop.city].filter(Boolean).join(', ');
    }

    lineForPattern(p) {
        const path = [...p.path].sort((a, b) => a.stop_sequence - b.stop_sequence);
        const line = this.lineForPatternID(p.id);
        line.shortName = p.short_name ?? line.shortName;
        line.headsign = p.headsign ?? null;
        line.origin = path.length ? this.place(path[0].stop_id) : null;
        line.destination = path.length ? this.place(path[path.length - 1].stop_id) : null;
        return line;
    }

    /** Pattern ids are "<line>_<variant>_<direction>", e.g. "3535_0_2". */
    lineForPatternID(patternID) {
        const lineID = patternID.split('_')[0] || patternID;
        return makeLine({
            id: patternID,
            shortName: this.lines[lineID] ?? lineID,
            agency: 'Carris Metropolitana',
            providerRefs: { lineId: lineID },
        });
    }
}

/** A pattern id can have several timetable versions; the one running today (Lisbon date) wins. */
function pattern(id) {
    return memo(`carris:pattern:${id}`, 6 * 3_600_000, async () => {
        const versions = await getJSON(`${BASE}/v2/patterns/${encodeURIComponent(id)}`);
        const today = serviceDate('Europe/Lisbon').replaceAll('-', ''); // GTFS "yyyyMMdd"
        const list = Array.isArray(versions) ? versions : [];
        const nextDay = (v) => (v.valid_on ?? []).filter((d) => d >= today).sort()[0] ?? '9';
        const chosen = list.find((v) => (v.valid_on ?? []).includes(today))
            ?? [...list].sort((a, b) => (nextDay(a) < nextDay(b) ? -1 : nextDay(a) > nextDay(b) ? 1 : 0))[0];
        if (!chosen || !Array.isArray(chosen.path)) throw new TransitError('notFound', `pattern ${id}`);
        return chosen;
    });
}

/** Realtime payloads prefix ids with dataset versions: "[PCN1R][BNA17]2209_0_1" → "2209_0_1". */
function stripVersion(id) {
    let rest = String(id);
    while (rest.startsWith('[')) {
        const close = rest.indexOf(']');
        if (close < 0) break;
        rest = rest.slice(close + 1);
    }
    return rest;
}
