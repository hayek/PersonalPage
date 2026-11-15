// Sweden, Stockholm — SL (Storstockholms Lokaltrafik) Transport API (transport.integration.sl.se/v1),
// official and keyless, read straight from the browser (it sends `Access-Control-Allow-Origin: *`).
// Port of BusBus/Transit/Providers/SLProvider.swift, without what the app gets from our keyed proxy.
//
// ARRIVALS-ONLY on the web: the app shows SL's buses and route shapes from Trafiklab's GTFS feeds,
// which need a key, so they stay in the app. Buses only.
//
// A "stop" is an SL *site* — every platform of one named place — coded by its site id. Sites come in
// one list with no name filter (~370 KB gzipped), kept a week and searched in the page.
//
// Patterns come from the keyless SL Journey-planner v2 (an EFA planner, also CORS-open): a trip from
// the site to the line's destination, no changes, buses only, lists the stops the line calls at *from
// the rider's stop on*. When none of its proposals rides this line, the pattern is just the two ends.
// Times on the wire are Stockholm local time with no offset.

import { Capability, TransitError, fold, makeLine, meters, Mode } from '../model.js';
import { getJSON, memo, staticData, zonedTime } from '../http.js';

const BASE = 'https://transport.integration.sl.se/v1';
const PLANNER = 'https://journeyplanner.integration.sl.se/v2';
const TIME_ZONE = 'Europe/Stockholm';
const WEEK = 7 * 86_400_000;

/** Every site, compact: [{id, gid, name, note, lat, lon, areas}], kept a week. */
function loadSites() {
    return staticData('sl-sites-v1', WEEK, async () => {
        const raw = await getJSON(`${BASE}/sites`, { query: { expand: 'true' }, timeout: 60_000 });
        return raw
            .filter((s) => s.lat != null && s.lon != null && s.name)
            .map((s) => ({ id: s.id, gid: s.gid ?? null, name: s.name, note: s.note ?? null, lat: s.lat, lon: s.lon, areas: s.stop_areas ?? [] }));
    });
}

/** The site list with its lookups, built once per session. */
function siteIndex() {
    return memo('sl-site-index', Infinity, async () => {
        const sites = await loadSites();
        const byID = new Map();
        const ofArea = new Map();
        const all = sites.map((s) => {
            const site = { ...s, folded: fold(s.name), stop: { code: String(s.id), name: s.name, city: s.note, location: { lat: s.lat, lon: s.lon } } };
            byID.set(s.id, site);
            for (const area of s.areas) if (!ofArea.has(area)) ofArea.set(area, site);
            return site;
        });
        return { all, byID, ofArea };
    });
}

/** "2026-09-22T14:35:00", Stockholm local time. */
function parseLocal(text) {
    if (!text) return null;
    const [date, time] = String(text).split('T');
    if (!date || !time) return null;
    const instant = zonedTime(date, time, TIME_ZONE);
    return Number.isNaN(instant.getTime()) ? null : instant;
}

async function departures(site, forecast, line = null) {
    const query = { transport: 'BUS', forecast: String(forecast) };
    if (line) query.line = line;
    const reply = await memo(`sl:dep:${site}:${forecast}:${line ?? ''}`, 10_000, () => getJSON(`${BASE}/sites/${encodeURIComponent(site)}/departures`, { query }));
    return reply.departures ?? [];
}

/**
 * PubTrans states (from trafiklab-sl): NOTCALLED is a skipped stop, REPLACED a departure run by another
 * journey; a journey NOTEXPECTED/NOTRUN/ABORTED will not come.
 */
function isCancelled(d) {
    return ['CANCELLED', 'INHIBITED', 'NOTEXPECTED', 'NOTCALLED', 'REPLACED'].includes(d.state ?? '')
        || ['CANCELLED', 'NOTEXPECTED', 'NOTRUN', 'ABORTED'].includes(d.journey?.state ?? '');
}

function mostCommon(values) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = null;
    for (const v of values) if (best === null || counts.get(v) > counts.get(best)) best = v;
    return best;
}

/** One line per SL line and direction among the departures. */
function linesFrom(list, site) {
    const groups = new Map();
    for (const d of list) {
        const lineID = d.line?.id;
        const direction = d.direction_code;
        if (lineID == null || direction == null) continue;
        if (d.line?.transport_mode != null && d.line.transport_mode !== 'BUS') continue;
        const key = `${lineID}-${direction}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
    }
    const lines = [];
    for (const [key, group] of groups) {
        const first = group[0];
        const destination = mostCommon(group.map((d) => d.destination).filter(Boolean)) ?? first.direction ?? '';
        const designation = String(first.line?.designation ?? '').trim();
        lines.push(makeLine({
            id: key, shortName: designation, headsign: destination, agency: 'SL', origin: first.stop_area?.name ?? null,
            destination, mode: Mode.bus,
            providerRefs: { line: String(first.line.id), direction: String(first.direction_code), designation, destination, site: String(site) },
        }));
    }
    return lines;
}

/** A planner stop, named after the SL site its stop area belongs to ("18010591" is area 10591). */
function plannerStop(location, sites) {
    const stopID = location?.parent?.properties?.stopId;
    const area = stopID != null ? Number(stopID) - 18_000_000 : null;
    if (area != null && sites.ofArea.has(area)) return sites.ofArea.get(area).stop;
    const coord = location?.coord;
    const code = location?.parent?.id ?? location?.id;
    if (!coord || coord.length !== 2 || !code) return null;
    // EFA puts latitude first.
    return { code: String(code), name: location.parent?.disassembledName ?? location.disassembledName ?? location.name ?? String(code), city: null, location: { lat: coord[0], lon: coord[1] } };
}

/** @type {import('../model.js').TransitProvider} */
const provider = {
    id: 'sl',
    displayName: 'SL (Stockholm)',
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    // No published limit, only a request not to poll excessively; one small call per line per poll.
    refreshSeconds: 30,
    datasetID: 'sl',
    attribution: 'Data: SL (Storstockholms Lokaltrafik) via Trafiklab',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        const sites = await siteIndex();
        if (/^\d+$/.test(text)) {
            const site = sites.byID.get(Number(text));
            return site ? [site.stop] : [];
        }
        const words = fold(text).split(/\s+/).filter(Boolean);
        const needle = words.join(' ');
        const rank = (s) => (s.folded === needle ? 0 : s.folded.startsWith(needle) ? 1 : 2);
        return sites.all
            .filter((s) => words.every((w) => s.folded.includes(w)))
            .sort((a, b) => rank(a) - rank(b) || a.stop.name.localeCompare(b.stop.name, 'sv') || a.stop.code.localeCompare(b.stop.code))
            .slice(0, 60)
            .map((s) => s.stop);
    },

    /** The site's bus departures over the next 20 hours (`forecast` tops out at 1,200 minutes). */
    async linesAtStop(stop) {
        return linesFrom(await departures(stop.code, 1200), stop.code);
    },

    async routePattern(line) {
        const refs = line.providerRefs ?? {};
        if (!refs.site || !refs.line) throw new TransitError('unsupported', `line ${line.id} has no SL refs`);
        const sites = await siteIndex();
        const site = sites.byID.get(Number(refs.site));
        if (!site) throw new TransitError('notFound', `site ${refs.site}`);
        const destination = refs.destination ?? line.headsign ?? '';
        const designation = refs.designation ?? line.shortName;
        const finder = await getJSON(`${PLANNER}/stop-finder`, { query: { name_sf: destination, type_sf: 'any', any_obj_filter_sf: '2' } });
        const candidates = (finder.locations ?? []).filter((l) => l.type === 'stop' && l.id != null);
        const end = candidates.find((l) => (l.productClasses ?? []).includes(5)) ?? candidates[0];
        if (!end) throw new TransitError('notFound', `destination ${destination} of line ${line.shortName}`);

        let leg = null;
        try {
            const trips = await getJSON(`${PLANNER}/trips`, {
                query: {
                    type_origin: 'any', name_origin: String(site.gid ?? 9_091_001_000_000_000 + site.id),
                    type_destination: 'any', name_destination: end.id,
                    calc_number_of_trips: '3', max_changes: '0', gen_c: 'false',
                    incl_mot_0: 'false', incl_mot_2: 'false', incl_mot_4: 'false', incl_mot_9: 'false', incl_mot_14: 'false',
                },
            });
            leg = (trips.journeys ?? []).flatMap((j) => j.legs ?? [])
                .find((l) => l.transportation?.disassembledName === designation && (l.stopSequence?.length ?? 0) >= 2) ?? null;
        } catch { /* the two ends below stand in */ }

        let stops;
        if (leg) {
            stops = leg.stopSequence.map((l) => plannerStop(l, sites)).filter(Boolean);
        } else {
            stops = [site.stop];
            if (end.coord?.length === 2) {
                stops.push({ code: String(end.id), name: end.disassembledName ?? end.name ?? destination, city: end.parent?.name ?? null, location: { lat: end.coord[0], lon: end.coord[1] } });
            }
        }
        // The planner starts at one platform of the site; the board finds the rider's stop by code.
        if (stops.length) stops[0] = site.stop;
        stops = stops.filter((s, i) => i === 0 || stops[i - 1].code !== s.code);
        if (stops.length < 2) throw new TransitError('notFound', `stops for line ${line.id}`);
        return { line, stops: stops.map((stop, i) => ({ stop, sequence: i + 1, distanceAlongRoute: null })) };
    },

    async vehicles() {
        return [];
    },

    /**
     * Departures of this line and direction at the site. `expected` is a prediction only when the
     * journey carries a `prediction_state` other than LOSTCONTACT; otherwise it repeats the timetable.
     */
    async arrivals(line, stop) {
        const refs = line.providerRefs ?? {};
        if (!refs.line || !refs.direction) throw new TransitError('unsupported', `line ${line.id} has no SL refs`);
        const out = [];
        for (const d of await departures(stop.code, 180, refs.line)) {
            if (String(d.line?.id) !== refs.line || String(d.direction_code) !== refs.direction || isCancelled(d)) continue;
            const scheduledAt = parseLocal(d.scheduled);
            if (!scheduledAt) continue;
            const prediction = d.journey?.prediction_state;
            const isRealtime = prediction != null && prediction !== 'LOSTCONTACT';
            const expected = parseLocal(d.expected);
            // The trip number, as the app's buses name their trips (`2026111507295` → "7295").
            const tripId = d.journey?.id != null ? String(Number(d.journey.id) % 100_000) : null;
            out.push({ expectedAt: (isRealtime ? expected : null) ?? scheduledAt, scheduledAt, isRealtime, tripId });
        }
        return out.sort((a, b) => a.expectedAt - b.expectedAt);
    },

    /** Sites within the radius from the kept list; the lines of the nearest five from their next hour. */
    async stopsNearby(point, radiusMeters) {
        const sites = await siteIndex();
        const near = sites.all
            .map((s) => ({ stop: s.stop, distanceMeters: meters(point, s.stop.location) }))
            .filter((n) => n.distanceMeters <= radiusMeters)
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .slice(0, 5);
        const results = await Promise.all(near.map(async (n) => {
            try {
                const lines = linesFrom(await departures(n.stop.code, 60), n.stop.code);
                return lines.length ? { ...n, lines } : null;
            } catch {
                return null;
            }
        }));
        return results.filter(Boolean);
    },
};

export default provider;
