// London — TfL Unified API (api.tfl.gov.uk). Official, keyless at 50 requests/minute per IP (the
// free `app_key` that lifts it is not used: the web version holds no keys). Commercial use is
// allowed under the TfL transport data terms, which require the credit "Powered by TfL Open Data"
// (and "Contains OS data © Crown copyright and database rights"). Port of
// BusBus/Transit/Providers/TfLProvider.swift. Every endpoint answers CORS with `*`.
//
// ARRIVALS-ONLY: TfL publishes no bus GPS (`Line/{id}/Vehicles` is a 404), only iBus countdown
// predictions, which have no timetable time next to them.
//
// Stops are NaPTAN ids ("490000173RC"): that is what every endpoint takes. The 5-digit SMS code on the
// stop flag is accepted by search and resolved to its NaPTAN id. Bus stops are one-directional, so a
// line at a stop is one TransitLine per direction ("88:inbound").

import { Capability, TransitError, makeLine, meters, modeNamed } from '../model.js';
import { getJSON } from '../http.js';
import { decodePolyline, encodePolyline } from '../shapes/polyline.js';
import { bestPiece, length } from '../shapes/shape-check.js';

const BASE = 'https://api.tfl.gov.uk';

const get = (path, query) => getJSON(BASE + path, query ? { query } : {});

/** Night routes have lower-case ids ("n15"); the blinds say "N15". */
/** A bus line's id is its route number in lower case ("n18"), so upper-cased it is what the bus shows. */
const displayName = (lineId) => String(lineId).toUpperCase();

/** "Oxford Circus Station (Stop RC)". Stops without a letter publish an arrow ("->W") instead. */
function stopName(name, letter) {
    const clean = String(name ?? '').replaceAll('  ', ' ');
    if (!letter || letter.startsWith('-')) return clean;
    return `${clean} (Stop ${letter})`;
}

/** Instants are UTC with a "Z": "2026-09-22T09:42:35Z". */
function parseInstant(string) {
    if (!string) return null;
    const date = new Date(`${String(string).slice(0, 19)}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
}

const pointStop = (point) => ({
    code: point.naptanId, name: stopName(point.commonName, point.stopLetter), city: null,
    location: { lat: point.lat, lon: point.lon },
});

/** This point and everything under it that a bus actually stops at. */
function busStops(point) {
    const own = point.stopType === 'NaptanPublicBusCoachTram' && (point.modes ?? []).includes('bus') ? [point] : [];
    return own.concat((point.children ?? []).flatMap(busStops));
}

function sectionLine(section, naptanId) {
    // "Etherow Street - Margaret Street / Oxford Circus": origin is what precedes the destination.
    let origin = null;
    const name = section.routeSectionName, destination = section.destinationName;
    if (name && destination && name.endsWith(` - ${destination}`)) origin = name.slice(0, -(destination.length + 3));
    return makeLine({
        id: `${section.lineId}:${section.direction}`,
        shortName: displayName(section.lineId),
        mode: modeNamed(section.mode),
        headsign: section.vehicleDestinationText ?? destination ?? null,
        agency: 'TfL',
        origin,
        destination: destination ?? null,
        providerRefs: { lineId: section.lineId, direction: section.direction, naptanId },
    });
}

const routeSections = (naptanId) => get(`/StopPoint/${encodeURIComponent(naptanId)}/Route`, { serviceTypes: 'Regular,Night' });

/**
 * The line id, its direction and the stop it was picked at. A line from the nearby list carries no
 * direction: its stop is one-directional, so its route through it says which way.
 */
async function reference(line) {
    const refs = line.providerRefs ?? {};
    const lineId = refs.lineId ?? String(line.id).split(/[:@]/)[0];
    const naptanId = refs.naptanId ?? null;
    if (refs.direction) return { lineId, direction: refs.direction, naptanId };
    if (!naptanId) throw new TransitError('unsupported', `line ${line.id} has no direction or stop`);
    const section = (await routeSections(naptanId) ?? []).find((s) => s.lineId === lineId);
    if (!section) throw new TransitError('notFound', `line ${lineId} at stop ${naptanId}`);
    return { lineId, direction: section.direction, naptanId };
}

/**
 * `lineStrings` are not one per route variant: identical copies, and pieces for short workings
 * beside the full route (63 inbound). Of every distinct piece, the shortest one the stops lie along
 * is the pattern's. Pieces are never joined: the 63's two joined run twice its length. When none
 * fits (19 inbound's Highbury Grove routing has no geometry of its own), the longest is kept anyway,
 * so the shape cache records the rejection instead of asking again. Null when there is no geometry.
 */
function chosenPiece(lineStrings, stops) {
    const pieces = (lineStrings ?? []).flatMap((string) => {
        // A JSON string inside the JSON: `[[[lon, lat], …], …]`, one array per piece.
        let decoded;
        try {
            decoded = JSON.parse(string);
        } catch {
            return [];
        }
        if (!Array.isArray(decoded)) return [];
        return decoded.map((piece) => (Array.isArray(piece) ? piece : [])
            .filter((pair) => Array.isArray(pair) && pair.length >= 2)
            .map(([lon, lat]) => ({ lat, lon })));
    });
    const best = bestPiece(pieces, stops.map((s) => s.stop.location));
    if (best) return best;
    const drawn = pieces.filter((piece) => piece.length >= 2);
    return drawn.length ? drawn.reduce((a, b) => (length(b) > length(a) ? b : a)) : null;
}

/**
 * The longest end-to-end variant through the rider's stop, with the drawn line of that variant from
 * the same reply (see `chosenPiece`).
 */
async function sequencePattern(line) {
    const ref = await reference(line);
    const sequence = await get(
        `/Line/${encodeURIComponent(ref.lineId)}/Route/Sequence/${encodeURIComponent(ref.direction)}`,
        { serviceTypes: 'Regular,Night', excludeCrowding: 'true' },
    );
    const points = new Map();
    for (const branch of sequence?.stopPointSequences ?? []) {
        for (const point of branch.stopPoint ?? []) points.set(point.id, point);
    }
    // `orderedLineRoutes` are the whole end-to-end variants; the longest one through the rider's
    // stop is the one the board draws.
    const routes = (sequence?.orderedLineRoutes ?? []).map((r) => r.naptanIds ?? []);
    const through = routes.filter((ids) => (ref.naptanId ? ids.includes(ref.naptanId) : true));
    const ids = (through.length ? through : routes).reduce((best, r) => (best && best.length >= r.length ? best : r), null);
    if (!ids?.length) throw new TransitError('notFound', `stops for line ${ref.lineId} ${ref.direction}`);
    const stops = ids
        .map((id) => points.get(id))
        .filter(Boolean)
        .map((p) => ({ code: p.id, name: stopName(p.name, p.stopLetter), city: null, location: { lat: p.lat, lon: p.lon } }));
    if (stops.length < 2) throw new TransitError('notFound', `stops for line ${ref.lineId} ${ref.direction}`);
    const pattern = { line, stops: stops.map((stop, i) => ({ stop, sequence: i, distanceAlongRoute: null })) };
    // The same reply carries the drawn line (`lineStrings`), so the shape costs no request. Only
    // the piece that is this pattern's is kept, encoded: a few KB in the cached pattern, not the
    // ~150 KB of every piece. A reply without geometry keeps an empty one, so nothing asks again.
    const piece = chosenPiece(sequence?.lineStrings, pattern.stops);
    pattern.shapeData = { polyline: piece ? encodePolyline(piece, 6) : '' };
    return pattern;
}

export default {
    id: 'tfl',
    displayName: 'TfL (London)',
    attribution: 'Powered by TfL Open Data. Contains OS data © Crown copyright and database rights',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.realtimeArrivals, Capability.nearbyStops,
    ]),
    /** Predictions are refreshed upstream every ~30 s, and 50 req/min is shared by everything on the IP. */
    refreshSeconds: 30,
    datasetID: 'tfl',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        if (/^\d{5}$/.test(text)) {
            // `/StopPoint/Sms/{code}` answers with a 302 to `/StopPoint/{naptanId}`, which fetch follows
            // (both carry CORS headers). An unknown code is a 404, read as "no such stop"; the code is
            // checked on the way back anyway.
            let point;
            try {
                point = await get(`/StopPoint/Sms/${text}`);
            } catch {
                return [];
            }
            if (point?.smsCode !== text) return [];
            return busStops(point).map(pointStop);
        }
        // Matches are a mix of single stops and stop groups ("490G…"), and carry no stop letter, so
        // they are looked up again in one batched call to get both the children and the letters.
        const term = text.replaceAll('/', ' ');
        const search = await get(`/StopPoint/Search/${encodeURIComponent(term)}`, {
            modes: 'bus', includeHubs: 'false', maxResults: '12',
        });
        const ids = (search?.matches ?? []).map((m) => m.id);
        if (!ids.length) return [];
        // `/StopPoint/{a,b}` answers with an array, `/StopPoint/{a}` with a single object.
        const reply = await get(`/StopPoint/${ids.map(encodeURIComponent).join(',')}`);
        const points = Array.isArray(reply) ? reply : [reply];
        const seen = new Set();
        return points.flatMap(busStops)
            .filter((p) => !seen.has(p.naptanId) && seen.add(p.naptanId))
            .map(pointStop);
    },

    /**
     * `StopPoint/{id}/Route` lists each line's route sections through the stop with their direction,
     * which is exactly the per-direction split the picker needs, in one call.
     */
    async linesAtStop(stop) {
        const byLine = new Map();
        for (const section of await routeSections(stop.code) ?? []) {
            if (section.mode !== 'bus') continue;
            const key = `${section.lineId}:${section.direction}`;
            const existing = byLine.get(key);
            if (!existing) {
                byLine.set(key, section);
            } else if (existing.isActive !== true && section.isActive === true) {
                // Branches: keep a section that is running today over one that is not.
                byLine.set(key, section);
            }
        }
        return [...byLine.values()].map((section) => sectionLine(section, stop.code));
    },

    routePattern: sequencePattern,

    /** From the pattern; one call again only for a pattern cached before shapes were kept on it. */
    async routeShape(line, pattern) {
        const data = pattern?.shapeData ?? (await sequencePattern(line)).shapeData;
        const points = data?.polyline ? decodePolyline(data.polyline, 6) : [];
        return points.length >= 2 ? { branches: [points] } : null;
    },

    async vehicles() {
        return [];
    },

    /**
     * `Line/{id}/Arrivals/{stop}` narrows the countdown to one line at one stop. Every prediction is
     * live iBus data; TfL gives no scheduled time alongside it.
     *
     * The feed now and then lists one prediction twice under the same `id`, and a reply may be up to a
     * minute old (`s-maxage=60` at the edge), so a prediction past its `timeToLive` is dropped.
     */
    async arrivals(line, stop) {
        const ref = await reference(line);
        const query = line.providerRefs?.direction ? { direction: ref.direction } : undefined;
        const predictions = await get(`/Line/${encodeURIComponent(ref.lineId)}/Arrivals/${encodeURIComponent(stop.code)}`, query);
        const now = new Date();
        const seen = new Set();
        const arrivals = [];
        for (const prediction of predictions ?? []) {
            if (prediction.naptanId !== stop.code || prediction.lineId !== ref.lineId) continue;
            if (prediction.id != null) {
                if (seen.has(prediction.id)) continue;
                seen.add(prediction.id);
            }
            const ttl = parseInstant(prediction.timeToLive);
            if (ttl && ttl <= now) continue;
            const expectedAt = parseInstant(prediction.expectedArrival);
            if (!expectedAt) continue;
            arrivals.push({ expectedAt, scheduledAt: null, isRealtime: true, tripId: null, vehicleLocation: null });
        }
        return arrivals.sort((a, b) => a.expectedAt - b.expectedAt);
    },

    /**
     * The proximity search returns each stop with the ids of its lines but not their direction, so
     * those lines only carry the stop; the direction is looked up if one is ever used on its own.
     * Stops with no lines (disused, or drop-off only) are left out.
     */
    async stopsNearby(point, radiusMeters) {
        const response = await get('/StopPoint', {
            lat: String(point.lat), lon: String(point.lon), radius: String(Math.trunc(radiusMeters)),
            stopTypes: 'NaptanPublicBusCoachTram', modes: 'bus', returnLines: 'true',
        });
        return (response?.stopPoints ?? [])
            .filter((entry) => (entry.modes ?? []).includes('bus') && (entry.lines ?? []).length > 0)
            .map((entry) => {
                const stop = pointStop(entry);
                const lines = entry.lines.map((l) => makeLine({
                    id: `${l.id}@${entry.naptanId}`, shortName: displayName(l.name ?? l.id), agency: 'TfL',
                    providerRefs: { lineId: l.id, naptanId: entry.naptanId },
                }));
                return { stop, distanceMeters: meters(point, stop.location), lines };
            })
            .sort((a, b) => a.distanceMeters - b.distanceMeters);
    },
};
