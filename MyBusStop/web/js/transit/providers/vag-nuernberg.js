// Germany, Nuremberg — VAG's PULS web API (start.vag.de/dm/api/v1), keyless, the backend of VAG's own
// departure monitor. Port of BusBus/Transit/Providers/VAGProvider.swift.
//
// Licence: VAG-OpenData publishes the API ("Fahrplan | Echtzeitabfahrtsmonitor:
// Schnittstellenbeschreibung API") under cc-by-4.0, so the credit names VAG and the licence. The
// portal states no separate API terms and no rate limit, hence experimental.
//
// ARRIVALS-ONLY: departures carry live times (`AbfahrtszeitIst`, `Prognose`) and the operational
// vehicle number, but no vehicle positions.
//
// Stops are VGN ids ("704", Plärrer), which cover VAG's city network (Nuremberg, Fürth, the 20/30
// buses to Erlangen) and the VGN regional buses that feed PULS. The API has no line or route
// catalogue: a line is a board entry's product, number and direction ("Tram 4, Richtung2"), and its
// ordered stops are one live trip of it, read whole from the Fahrten API.

import { Capability, TransitError, makeLine, meters } from '../model.js';
import { getJSON } from '../http.js';

const BASE = 'https://start.vag.de/dm/api/v1';
/** PULS products a bus board is for; U-Bahn, S-Bahn and regional-train departures are left out. */
const SURFACE_PRODUCTS = ['Bus', 'Tram'];

const segment = (text) => encodeURIComponent(String(text));

/**
 * "Hauptbahnhof (Fürth (Bayern))" → ["Hauptbahnhof", "Fürth (Bayern)"]: the place is the last
 * bracket, which may hold one of its own.
 */
function splitName(full) {
    if (!full.endsWith(')')) return [full, null];
    let depth = 0;
    for (let i = full.length - 1; i >= 0; i--) {
        const ch = full[i];
        if (ch === ')') depth += 1;
        else if (ch === '(') {
            depth -= 1;
            if (depth !== 0) continue;
            const name = full.slice(0, i).trim();
            const city = full.slice(i + 1, -1).trim();
            return [name || full, city || null];
        }
    }
    return [full, null];
}

/** "Bus,Tram,UBahn"; missing for stops VAG itself does not serve. */
function isSurface(s) {
    if (s.Produkte == null) return true;
    return String(s.Produkte).split(',').some((p) => SURFACE_PRODUCTS.includes(p));
}

/** A stop of a search, or a call of a trip (which has no `Produkte`). */
function toStop(s) {
    if (s?.VGNKennung == null || s.Latitude == null || s.Longitude == null) return null;
    const [name, city] = splitName(s.Haltestellenname ?? String(s.VGNKennung));
    return { code: String(s.VGNKennung), name, city, location: { lat: s.Latitude, lon: s.Longitude } };
}

/** PULS lists one stop under several VAG ids ("FL", "FLUGHA"), all with the same VGN id. */
function unique(stops) {
    const seen = new Set();
    return stops.filter((s) => (seen.has(s.code) ? false : (seen.add(s.code), true)));
}

/** "Tram:4:Richtung2" — the line id, one per direction. */
const lineKey = (d) => (d.Produkt && d.Linienname && d.Richtung ? `${d.Produkt}:${d.Linienname}:${d.Richtung}` : null);

/** The most frequent value, the earliest seen on a tie. */
function mostCommon(values) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    if (!counts.size) return null;
    const top = Math.max(...counts.values());
    return values.find((v) => counts.get(v) === top) ?? null;
}

/** "2026-09-28T15:47:00+02:00". */
function parseDate(text) {
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Surface departures at a VGN stop, of one line when given. Without `limitcount` PULS answers with eight. */
async function board(stopCode, line, product, limit) {
    const path = `/abfahrten/VGN/${segment(stopCode)}${line != null ? `/${segment(line)}` : ''}`;
    const products = product ? [product] : [...SURFACE_PRODUCTS].sort();
    const response = await getJSON(`${BASE}${path}`, { query: { product: products.join(','), limitcount: String(limit) } });
    return (response.Abfahrten ?? []).filter((d) => d.Produkt && SURFACE_PRODUCTS.includes(d.Produkt));
}

/** @type {import('../model.js').TransitProvider} */
const provider = {
    id: 'vag-nuernberg',
    displayName: 'VAG (Nuremberg)',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.linesAtStop, Capability.routePattern,
        Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    // No limit is published; one departures call per poll.
    refreshSeconds: 30,
    datasetID: 'vag-nuernberg',
    attribution: 'Daten: VAG Verkehrs-Aktiengesellschaft Nürnberg, CC BY 4.0',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        const response = await getJSON(`${BASE}/haltestellen/VAG`, { query: { name: text } });
        return unique((response.Haltestellen ?? []).filter(isSurface).map(toStop).filter(Boolean));
    },

    /** One board of 40 surface departures (an hour or more at a busy stop) gives the lines and directions. */
    async linesAtStop(stop) {
        const departures = await board(stop.code, null, null, 40);
        const byKey = new Map(); // insertion order = board order
        for (const d of departures) {
            const key = lineKey(d);
            if (!key) continue;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(d);
        }
        const lines = [];
        for (const [key, group] of byKey) {
            const first = group[0];
            const headsign = mostCommon(group.map((d) => d.Richtungstext).filter((t) => t != null));
            const refs = { stop: stop.code, product: first.Produkt, name: first.Linienname, direction: first.Richtung };
            if (headsign != null) refs.headsign = headsign;
            if (first.Fahrtnummer != null) refs.trip = String(first.Fahrtnummer);
            if (first.Betriebstag != null) refs.day = first.Betriebstag;
            lines.push(makeLine({ id: key, shortName: first.Linienname, headsign, agency: 'VAG', destination: headsign, providerRefs: refs }));
        }
        return lines;
    },

    /**
     * The Fahrten API returns a trip's whole stop list, first stop to last, passed stops included. The
     * trip is the line's next one at the rider's stop, one showing the line's usual destination when
     * there is one (short workings end early); the trip seen when the lines were listed stands in when
     * the board has none left.
     */
    async routePattern(line) {
        const { stop: stopCode, product, name } = line.providerRefs ?? {};
        if (!stopCode || !product || !name) throw new TransitError('notFound', `stop of line ${line.id}`);
        const candidates = [];
        try {
            const own = (await board(stopCode, name, product, 20)).filter((d) => lineKey(d) === line.id);
            const preferred = [...own.filter((d) => d.Richtungstext === line.headsign), ...own.filter((d) => d.Richtungstext !== line.headsign)];
            for (const d of preferred.slice(0, 2)) if (d.Fahrtnummer != null) candidates.push({ trip: String(d.Fahrtnummer), day: d.Betriebstag ?? null });
        } catch { /* the saved trip below still stands in */ }
        if (line.providerRefs.trip) candidates.push({ trip: line.providerRefs.trip, day: line.providerRefs.day ?? null });

        for (const candidate of candidates) {
            // With the operating day the trip is found after it has ended, too.
            const path = [product, candidate.day, candidate.trip].filter((p) => p != null).map(segment).join('/');
            let trip;
            try {
                trip = await getJSON(`${BASE}/fahrten/${path}`);
            } catch {
                continue;
            }
            const stops = [];
            for (const call of trip.Fahrtverlauf ?? []) {
                const stop = toStop(call);
                if (!stop || stops[stops.length - 1]?.code === stop.code) continue;
                stops.push(stop);
            }
            if (stops.length < 2) continue;
            return { line, stops: stops.map((stop, i) => ({ stop, sequence: i + 1, distanceAlongRoute: null })) };
        }
        throw new TransitError('notFound', `a trip of ${name} at ${stopCode}`);
    },

    async vehicles() {
        return [];
    },

    /** The board is asked for the one line (a path segment PULS filters on), and its direction picked out. */
    async arrivals(line, stop) {
        const name = line.providerRefs?.name;
        if (!name) throw new TransitError('notFound', `number of line ${line.id}`);
        const departures = await board(stop.code, name, line.providerRefs.product ?? null, 20);
        const cutoff = Date.now() - 60_000;
        const out = [];
        for (const d of departures) {
            if (lineKey(d) !== line.id) continue;
            const planned = parseDate(d.AbfahrtszeitSoll);
            // `AbfahrtszeitIst` equals the planned time when `Prognose` is false.
            const expectedAt = parseDate(d.AbfahrtszeitIst) ?? planned;
            if (!expectedAt || expectedAt.getTime() < cutoff) continue;
            out.push({ expectedAt, scheduledAt: planned, isRealtime: d.Prognose === true, tripId: d.Fahrtnummer != null ? String(d.Fahrtnummer) : null });
        }
        return out.sort((a, b) => a.expectedAt - b.expectedAt);
    },

    /**
     * The radius search (`distance`, in metres) gives stops without distances; the lines of the closest
     * few cost one board each.
     */
    async stopsNearby(point, radiusMeters) {
        const response = await getJSON(`${BASE}/haltestellen/VAG/location`, {
            query: { lat: String(point.lat), lon: String(point.lon), distance: String(Math.trunc(radiusMeters)) },
        });
        const near = unique((response.Haltestellen ?? []).filter(isSurface).map(toStop).filter(Boolean))
            .map((stop) => ({ stop, distanceMeters: meters(point, stop.location) }))
            .filter((n) => n.distanceMeters <= radiusMeters)
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .slice(0, 5);
        const results = await Promise.all(near.map(async (n) => {
            try {
                const lines = await provider.linesAtStop(n.stop);
                return lines.length ? { ...n, lines } : null;
            } catch {
                return null;
            }
        }));
        return results.filter(Boolean);
    },
};

export default provider;
