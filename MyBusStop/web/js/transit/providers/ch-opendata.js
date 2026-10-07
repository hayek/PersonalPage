// Switzerland — transport.opendata.ch, the community Transport API over search.ch's timetable. Port of
// BusBus/Transit/Providers/SwissTransportProvider.swift. Keyless and unofficial ("The aim of this
// inofficial API is to cover public transport within Switzerland"); the official alternative,
// opentransportdata.swiss, needs a key.
//
// Rate limit: "constraint by the rate limit of timetable.search.ch", which caps a client at "1000
// Routensuchen und 10080 Abfahrtstabellen" a day. Everything here is a station board (the looser
// budget; route searches are never used), and each call asks only for the fields it reads
// (`fields[]`), which shrinks a board from ~230 KB to a few KB.
//
// ARRIVALS-ONLY: boards carry scheduled times and, where the operator feeds them, a `prognosis`; no
// vehicle positions. Stops are DIDOK station ids ("8591105"); a board never names a line or a
// direction, so a line is its public number plus the destination it shows ("72 → Zürich,
// Milchbuck"), and one number may give several lines when trips short-turn.

import { Capability, TransitError, makeLine, meters } from '../model.js';
import { getJSON } from '../http.js';

const BASE = 'https://transport.opendata.ch/v1';

/** Addresses and POIs come back without an id; boat piers are no bus stop. */
const isSurface = (station) => station?.id != null && station.icon !== 'ship';

/**
 * Names are "Place, Stop" ("Zürich, Bellevue") and kept whole, as signs and boards print them.
 * `coordinate.x` is the latitude, `y` the longitude.
 */
function toStop(station) {
    const lat = station?.coordinate?.x;
    const lon = station?.coordinate?.y;
    if (station?.id == null || lat == null || lon == null) return null;
    return { code: String(station.id), name: station.name ?? String(station.id), city: null, location: { lat, lon } };
}

/** "2026-09-22T14:38:00+0200" (Safari's Date wants the offset as "+02:00"). */
function parseDate(text) {
    if (!text) return null;
    const date = new Date(String(text).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Board categories: T/NFT are trams, everything else asked for here is a bus. */
const typeOf = (category) => (['T', 'NFT', 'TRAM'].includes(String(category ?? '').toUpperCase()) ? 'tram' : 'bus');

/** Repeated `name[]=` keys, so the URL is built here rather than from a query object. */
function board(stationID, types, limit, fields) {
    const params = new URLSearchParams();
    params.append('id', stationID);
    params.append('limit', String(limit));
    for (const t of types) params.append('transportations[]', t);
    for (const f of fields) params.append('fields[]', f);
    return getJSON(`${BASE}/stationboard?${params}`).then((b) => ({ station: b?.station ?? null, stationboard: b?.stationboard ?? [] }));
}

/**
 * A `passList` opens with the boarding stop under a wrong id and no name or place, so the board's own
 * station stands in for it. Stops without coordinates are dropped.
 */
function passStops(passList, boardStation) {
    const list = passList.map((p) => p?.station).filter(Boolean);
    if (boardStation && list.length) list[0] = boardStation;
    const stops = [];
    for (const station of list) {
        const stop = toStop(station);
        if (!stop || stops[stops.length - 1]?.code === stop.code) continue;
        stops.push(stop);
    }
    return stops;
}

const sequenced = (stops) => stops.map((stop, i) => ({ stop, sequence: i + 1, distanceAlongRoute: null }));

/** @type {import('../model.js').TransitProvider} */
const provider = {
    id: 'ch-opendata',
    displayName: 'Swiss public transport',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    // One small board per poll: 2,880 a day at 30 s, well inside search.ch's 10,080.
    refreshSeconds: 30,
    datasetID: 'ch-opendata',
    attribution: 'Data: transport.opendata.ch / search.ch',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        // A numeric query is matched as a station id, so codes need no separate path.
        const response = await getJSON(`${BASE}/locations`, { query: { query: text, type: 'station' } });
        return (response.stations ?? []).filter(isSurface).map(toStop).filter(Boolean);
    },

    async linesAtStop(stop) {
        const b = await board(stop.code, ['bus', 'tram'], 80,
            ['stationboard/category', 'stationboard/number', 'stationboard/operator', 'stationboard/to']);
        const seen = new Set();
        const lines = [];
        for (const entry of b.stationboard) {
            if (!entry.number || !entry.to) continue;
            const key = `${entry.number}>${entry.to}`;
            if (seen.has(key)) continue;
            seen.add(key);
            lines.push(makeLine({
                id: key,
                shortName: entry.number,
                headsign: entry.to,
                agency: entry.operator ? entry.operator.split(' ')[0] : null,
                destination: entry.to,
                providerRefs: { stop: stop.code, number: entry.number, to: entry.to, type: typeOf(entry.category) },
            }));
        }
        return lines;
    },

    /**
     * A board lists each trip's onward stops (`passList`). The stops before the rider's come from a
     * second board at the line's other end — the destination the opposite direction shows here — where
     * a trip of this line and destination that passes the rider's stop is listed whole. When that
     * fails (one-way loops, no opposite trip soon) the pattern starts at the rider's stop.
     */
    async routePattern(line) {
        const { stop: stopCode, number, to } = line.providerRefs ?? {};
        if (!stopCode || !number || !to) throw new TransitError('notFound', `stop of line ${line.id}`);
        const types = [line.providerRefs.type ?? 'bus'];
        const fields = ['station', 'stationboard/number', 'stationboard/to',
            'stationboard/passList/station/id', 'stationboard/passList/station/name',
            'stationboard/passList/station/coordinate'];
        const here = await board(stopCode, types, 40, fields);
        const trip = here.stationboard.find((e) => e.number === number && e.to === to);
        if (!trip) throw new TransitError('notFound', `a trip of ${number} → ${to} at ${stopCode}`);
        const onward = passStops(trip.passList ?? [], here.station);

        const opposite = here.stationboard
            .filter((e) => e.number === number && e.to !== to)
            .reduce((best, e) => (!best || (e.passList?.length ?? 0) > (best.passList?.length ?? 0) ? e : best), null);
        const originID = opposite?.passList?.[opposite.passList.length - 1]?.station?.id;
        if (originID != null && String(originID) !== stopCode) {
            try {
                const there = await board(String(originID), types, 30, fields);
                const whole = there.stationboard.find((e) => e.number === number && e.to === to
                    && (e.passList ?? []).some((p) => p?.station?.id != null && String(p.station.id) === stopCode));
                if (whole) {
                    const stops = passStops(whole.passList ?? [], there.station);
                    if (stops.length >= 2) return { line, stops: sequenced(stops) };
                }
            } catch { /* fall back to the onward stops */ }
        }
        if (onward.length < 2) throw new TransitError('notFound', `stops of ${number} → ${to}`);
        return { line, stops: sequenced(onward) };
    },

    async vehicles() {
        return [];
    },

    async arrivals(line, stop) {
        const { number, to } = line.providerRefs ?? {};
        const b = await board(stop.code, [line.providerRefs?.type ?? 'bus'], 40,
            ['stationboard/number', 'stationboard/to', 'stationboard/name',
                'stationboard/stop/departure', 'stationboard/stop/prognosis/departure']);
        const cutoff = Date.now() - 60_000;
        const out = [];
        for (const entry of b.stationboard) {
            if (entry.number !== number || entry.to !== to) continue;
            const planned = parseDate(entry.stop?.departure);
            const predicted = parseDate(entry.stop?.prognosis?.departure);
            const expectedAt = predicted ?? planned;
            if (!expectedAt || expectedAt.getTime() < cutoff) continue;
            out.push({ expectedAt, scheduledAt: planned, isRealtime: predicted != null, tripId: entry.name ?? null });
        }
        return out.sort((a, b2) => a.expectedAt - b2.expectedAt);
    },

    /**
     * `/locations` with a point answers nearest-first with distances; the lines of the closest few
     * stops cost one small board each.
     */
    async stopsNearby(point, radiusMeters) {
        const response = await getJSON(`${BASE}/locations`, { query: { x: String(point.lat), y: String(point.lon), type: 'station' } });
        const near = [];
        for (const station of (response.stations ?? []).filter(isSurface)) {
            const stop = toStop(station);
            if (!stop) continue;
            const distance = station.distance ?? meters(point, stop.location);
            if (distance <= radiusMeters) near.push({ stop, distanceMeters: distance });
        }
        near.sort((a, b) => a.distanceMeters - b.distanceMeters);
        const results = await Promise.all(near.slice(0, 5).map(async (n) => {
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
