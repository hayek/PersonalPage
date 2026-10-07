// France — STAR, the Rennes Métropole network run by Keolis Rennes, through its Opendatasoft portal
// (data.explore.star.fr, Explore API v2.1). Official and keyless; anonymous callers get 20,000 calls
// a day per IP. Data is ODbL: attribute "Données STAR / Keolis Rennes". The portal sends
// `access-control-allow-origin: *`.
//
// The realtime datasets identify a trip only by line and direction (`sens`), never by route variant
// (`parcours`), so a TransitLine here is one line in one direction, and the variant that serves the
// rider's stop (the main one when it does) is kept for drawing the pattern. The whole stop list
// (1.8k stops, ~220 KB of JSON) is cached for a day for name search, nearby and the coordinates of
// pattern stops.
// Port of BusBus/Transit/Providers/STARRennesProvider.swift.

import { Capability, TransitError, fold, meters, makeLine } from '../model.js';
import { getJSON, staticData, memo } from '../http.js';

const BASE = 'https://data.explore.star.fr/api/explore/v2.1/catalog/datasets';
const DAY = 86_400_000;

const provider = {
    id: 'star-rennes',
    displayName: 'STAR (Rennes)',
    attribution: 'Données STAR / Keolis Rennes (ODbL)',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    // Vehicle and passage datasets are re-extracted about once a minute.
    refreshSeconds: 30,
    datasetID: 'star-rennes',
    reportsShadowTrips: false,

    async searchStops(query) {
        query = String(query ?? '').trim();
        if (!query) return [];
        const index = await stops();
        if (/^\d+$/.test(query)) {
            const stop = index.byID.get(query);
            return stop ? [stop] : [];
        }
        const folded = fold(query);
        const tokens = folded.split(' ').filter(Boolean);
        return index.all
            .filter((entry) => tokens.every((t) => entry.key.includes(t)))
            .sort((a, b) => {
                const ap = a.key.startsWith(folded), bp = b.key.startsWith(folded);
                if (ap !== bp) return ap ? -1 : 1;
                return cmp(a.stop.name, b.stop.name) || cmp(a.stop.code, b.stop.code);
            })
            .slice(0, 50)
            .map((entry) => entry.stop);
    },

    async linesAtStop(stop) {
        const calls = await getJSON(`${BASE}/tco-bus-topologie-dessertes-td/exports/json`, { query: {
            where: `idarret=${quoted(stop.code)}`,
            select: 'idparcours,idligne,nomcourtligne',
        } });
        if (!calls.length) return [];
        const ids = [...new Set(calls.map((c) => c.idparcours))];
        const variants = await getJSON(`${BASE}/tco-bus-topologie-parcours-td/exports/json`, { query: {
            where: `id in (${ids.map(quoted).join(',')})`,
            select: 'id,idligne,nomcourtligne,sens,type,nomarretdepart,nomarretarrivee,estaccessiblepmr',
        } });
        // One line per (line, direction); prefer the main variant, then the one listed first.
        const grouped = new Map();
        for (const v of variants) {
            const key = lineKey(v.idligne, v.sens);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(v);
        }
        return [...grouped.values()]
            .map((group) => group.find((v) => v.type === 'Principal') ?? [...group].sort((a, b) => cmp(a.id, b.id))[0])
            .map(parcoursLine)
            .sort((a, b) => a.shortName.length - b.shortName.length || cmp(a.shortName, b.shortName) || cmp(a.id, b.id));
    },

    async routePattern(line) {
        const parcours = line.providerRefs?.parcours;
        if (!parcours) throw new TransitError('unsupported', `line ${line.id} has no parcours (was it loaded from another provider?)`);
        const index = await stops();
        const calls = await getJSON(`${BASE}/tco-bus-topologie-dessertes-td/exports/json`, { query: {
            where: `idparcours=${quoted(parcours)}`,
            select: 'idarret,ordre',
            order_by: 'ordre',
        } });
        const patternStops = [...calls]
            .sort((a, b) => a.ordre - b.ordre)
            .map((call) => {
                const stop = index.byID.get(call.idarret);
                return stop ? { stop, sequence: call.ordre, distanceAlongRoute: null } : null;
            })
            .filter(Boolean);
        if (!patternStops.length) throw new TransitError('notFound', `stops for parcours ${parcours}`);
        return { line, stops: patternStops };
    },

    // Positions only (no fix time, no trip id); `ecartsecondes` is the delay, not the age.
    async vehicles(line) {
        const key = parseLineKey(line);
        const response = await getJSON(`${BASE}/tco-bus-vehicules-position-tr/records`, { query: {
            where: `idligne=${quoted(key.idligne)} and sens=${key.sens}`,
            limit: '100',
        } });
        return (response.results ?? [])
            .filter((v) => (Array.isArray(v.etat) ? v.etat.includes('En ligne') : true))
            .filter((v) => v.coordonnees)
            .map((v) => ({ location: { lat: v.coordonnees.lat, lon: v.coordonnees.lon } }));
    },

    // `precision` says whether a passage is "Temps réel" or "Applicable" (timetable only). Departure
    // times are used: at a line's first stop `arrivee` is when the bus pulled in to lay over, often
    // 10–30 minutes before it leaves; everywhere else the two are the same.
    async arrivals(line, stop) {
        const key = parseLineKey(line);
        const response = await getJSON(`${BASE}/tco-bus-circulation-passages-tr/records`, { query: {
            where: `idarret=${quoted(stop.code)} and idligne=${quoted(key.idligne)} and sens=${key.sens}`,
            order_by: 'depart',
            limit: '20',
        } });
        const cutoff = Date.now() - 60_000;
        return (response.results ?? [])
            .map((p) => {
                const expected = parse(p.depart ?? p.arrivee);
                if (!expected || expected.getTime() < cutoff) return null;
                return {
                    expectedAt: expected,
                    scheduledAt: parse(p.departtheorique ?? p.arriveetheorique),
                    isRealtime: p.precision === 'Temps réel',
                    tripId: p.idcourse ?? null,
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.expectedAt - b.expectedAt);
    },

    // Stops come from the cached list; their lines from one `dessertes` query for all of them. Those
    // lines carry number and direction only — `linesAtStop` fills in the rest.
    async stopsNearby(point, radiusMeters) {
        const index = await stops();
        const near = index.all
            .map((e) => ({ stop: e.stop, distance: meters(point, e.stop.location) }))
            .filter((n) => n.distance <= radiusMeters)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 30);
        if (!near.length) return [];
        const calls = await getJSON(`${BASE}/tco-bus-topologie-dessertes-td/exports/json`, { query: {
            where: `idarret in (${near.map((n) => quoted(n.stop.code)).join(',')})`,
            select: 'idarret,idparcours,idligne,nomcourtligne',
        } });
        const byStop = new Map();
        for (const call of calls) {
            const id = call.idarret ?? '';
            if (!byStop.has(id)) byStop.set(id, []);
            byStop.get(id).push(call);
        }
        return near.map(({ stop, distance }) => {
            const seen = new Set();
            const lines = [...(byStop.get(stop.code) ?? [])]
                .sort((a, b) => cmp(a.idparcours, b.idparcours))
                .map(desserteLine)
                .filter((l) => l && !seen.has(l.id) && seen.add(l.id));
            return { stop, distanceMeters: distance, lines };
        });
    },
};

export default provider;

// ---------------------------------------------------------------------------------------------
// Helpers

function stops() {
    return memo('star-rennes:stops', DAY, async () => {
        const rows = await staticData('star-rennes.stops.v1', DAY, async () => {
            const list = await getJSON(`${BASE}/tco-bus-topologie-pointsarret-td/exports/json`, { query: {
                select: 'id,nom,nomcommune,coordonnees',
            } });
            return list.filter((s) => s.coordonnees).map((s) => [s.id, s.nom ?? s.id, s.nomcommune ?? null, s.coordonnees.lat, s.coordonnees.lon]);
        });
        const all = rows.map(([code, name, city, lat, lon]) => {
            const stop = { code, name, city, location: { lat, lon } };
            return { stop, key: fold([name, city ?? ''].join(' ')) };
        });
        const byID = new Map();
        for (const e of all) if (!byID.has(e.stop.code)) byID.set(e.stop.code, e.stop);
        return { all, byID };
    });
}

/** A line in one direction: TransitLine.id is "<idligne>-<sens>", e.g. "0001-0" (C1 outbound). */
function lineKey(idligne, sens) {
    return `${idligne}-${sens}`;
}

function parseLineKey(line) {
    const parts = String(line.id).split('-');
    const sens = Number(parts[1]);
    if (parts.length !== 2 || !Number.isInteger(sens)) {
        throw new TransitError('badResponse', `line id ${line.id} is not a STAR line-direction`);
    }
    return { idligne: parts[0], sens };
}

function parcoursLine(v) {
    return makeLine({
        id: lineKey(v.idligne, v.sens),
        shortName: v.nomcourtligne ?? v.idligne,
        headsign: v.nomarretarrivee ?? null,
        agency: 'STAR',
        origin: v.nomarretdepart ?? null,
        destination: v.nomarretarrivee ?? null,
        providerRefs: { parcours: v.id },
    });
}

/** Variant ids read "<idligne>-<A|B>-<from>-<to>…"; A is `sens` 0, B is `sens` 1. */
function desserteLine(call) {
    const parts = String(call.idparcours).split('-');
    const idligne = call.idligne ?? parts[0];
    if (parts.length < 2 || !idligne) return null;
    const sens = parts[1] === 'A' ? 0 : parts[1] === 'B' ? 1 : null;
    if (sens === null) return null;
    return makeLine({
        id: lineKey(idligne, sens),
        shortName: call.nomcourtligne ?? idligne,
        agency: 'STAR',
        providerRefs: { parcours: call.idparcours },
    });
}

/** ODSQL string literal. */
function quoted(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Times carry their offset: "2026-09-22T09:36:15+00:00". */
function parse(string) {
    if (!string) return null;
    const date = new Date(string);
    return Number.isNaN(date.getTime()) ? null : date;
}

function cmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
