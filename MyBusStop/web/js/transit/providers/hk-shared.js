// Helpers shared by the Hong Kong providers (KMB, Citybus, GMB, NLB): which of the parallel name
// fields to show, timestamps, line ordering, bounded fan-out for the per-stop lookups, and the
// Transport Department's drawn route lines (`HKRouteLines`).

import { TransitError } from '../model.js';
import { ResponseError, buildURL, getJSON, memo } from '../http.js';
import { Projection, TOLERANCE, length, meters, orderedOffsets, trimmed, verdict } from '../shapes/shape-check.js';

/**
 * Which of the parallel name fields Hong Kong feeds publish (`name_en` / `name_tc` / `name_sc`) to
 * show. The app picks by its language: Chinese in Traditional script reads `tc`, Simplified `sc`,
 * anything else English. The web version is English, so this stays 'en' unless set otherwise.
 * @type {'en'|'tc'|'sc'}
 */
let nameLanguage = 'en';

export function hkNameLanguage() {
    return nameLanguage;
}

/** @param {'en'|'tc'|'sc'} language */
export function setHKNameLanguage(language) {
    nameLanguage = ['en', 'tc', 'sc'].includes(language) ? language : 'en';
}

/** The name in the current language, else the nearest other one that is present. Blank counts as absent. */
export function pick(en, tc, sc = null, language = nameLanguage) {
    const order = language === 'tc' ? [tc, sc, en] : language === 'sc' ? [sc, tc, en] : [en, tc, sc];
    for (const value of order) {
        const text = value == null ? '' : String(value).trim();
        if (text) return text;
    }
    return null;
}

/** Case-insensitive "contains", as Swift's `localizedCaseInsensitiveContains`. */
export function containsText(haystack, needle) {
    return haystack != null && String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

/**
 * Timestamps carry their offset ("2026-09-22T17:26:11+08:00", GMB with milliseconds), so no zone
 * guessing is needed. Null when absent or unreadable.
 */
export function parseHKTime(text) {
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Lines ordered by name length, then name, then id: "1" < "2" < "10" < "1A" (as the app orders them). */
export function compareHKLines(a, b) {
    if (a.shortName.length !== b.shortName.length) return a.shortName.length - b.shortName.length;
    if (a.shortName !== b.shortName) return a.shortName < b.shortName ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** First of each key, in order. */
export function uniqueBy(items, key) {
    const seen = new Set();
    return items.filter((item) => {
        const k = key(item);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `body` over every item, at most `limit` at a time, results in input order. Rejects if a body does. */
export async function mapLimit(items, limit, body) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next++;
            results[index] = await body(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * A session cache that coalesces concurrent loads of the same key and keeps the result until the
 * page goes away. Failures are not kept. `seed` stores a value already in hand, unless one is
 * loaded or loading.
 */
export class SessionCache {
    constructor() {
        this.entries = new Map();
    }

    get(key, load) {
        const hit = this.entries.get(key);
        if (hit) return hit;
        const promise = load();
        this.entries.set(key, promise);
        promise.catch(() => { if (this.entries.get(key) === promise) this.entries.delete(key); });
        return promise;
    }

    seed(key, value) {
        if (!this.entries.has(key)) this.entries.set(key, Promise.resolve(value));
    }
}

export const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Route lines (port of BusBus/Transit/Shapes/HKRouteLines.swift)

/**
 * The Transport Department's drawn routes, the only official line geometry for Hong Kong: the
 * operators' APIs have none and TD's GTFS has no shapes.txt. Served by the CSDI portal's ArcGIS
 * server, slowly (2–8 s) and now and then not at all. Free to use, crediting the Government and the
 * CSDI Portal.
 *
 * TD numbers the variants itself (`ROUTE_ID`) and no operator API says which is which; even
 * `ROUTE_SEQ` is not the direction. So one query fetches every variant of a route number in both
 * directions, and the one the pattern's stops lie along is kept, cut to its first and last stop.
 */
export const HKRouteLines = {
    /** Franchised buses: KMB, Long Win, Citybus, NLB, and four MTR feeders filed as KMB. */
    busLayer: 'https://portal.csdi.gov.hk/server/rest/services/common/td_rcd_1638844988873_41214/MapServer/0',
    /** Green minibuses, where `ROUTE_ID` and `ROUTE_SEQ` are the GMB API's own `route_id` and `route_seq`. */
    minibusLayer: 'https://portal.csdi.gov.hk/server/rest/services/common/td_rcd_1697082463580_57453/MapServer/0',
    /**
     * How far a stop may stand from every drawn variant and still be left as a marker beside the line
     * (`misses`); Citybus' Ice House Street stop is 131 m from route 11's.
     */
    missReach: 150,
};

const ROUTE_TOLERANCE = TOLERANCE.platforms;

/**
 * The line of `route` (a route number) for this pattern, among the variants `company` (an extra
 * `where` clause) selects.
 */
export function hkRouteShape(route, company, pattern, misses = 0) {
    const name = `ROUTE_NAMEE = '${String(route).replaceAll("'", "''")}'`;
    const clause = [name, company].filter(Boolean).join(' AND ');
    return hkLayerShape(HKRouteLines.busLayer, clause, pattern, misses);
}

/**
 * The pattern's line among the route lines matching `clause`; `notFound` when TD has not drawn the
 * route or no drawn variant serves the pattern's stops, which the shape cache keeps as such.
 */
export async function hkLayerShape(layer, clause, pattern, misses = 0) {
    const found = await routeFeatures(layer, clause);
    const shape = pickRouteLine(found, (pattern?.stops ?? []).map((s) => s.stop.location), misses);
    if (!shape) throw new TransitError('notFound', `route line for ${clause}`);
    return shape;
}

/**
 * The route lines matching `clause`, as [{routeID, seq, line}]. A rider opening one direction often
 * opens the other next, so a reply is kept ten minutes; the shapes themselves are cached for a month.
 * Simplified to ~3 m on the server (NLB 3M: 167 KB → 35 KB), piece by piece, so the pieces still meet.
 * The portal's firewall answers 403 to `IN (…)`, so callers stick to `=`, `<>`, `LIKE` and `AND`.
 */
function routeFeatures(layer, clause) {
    return memo(`hk-route-lines:${layer}|${clause}`, 600_000, async () => {
        const url = buildURL(layer, '/query', {
            where: clause, outFields: 'ROUTE_ID,ROUTE_SEQ', returnGeometry: 'true', outSR: '4326',
            geometryPrecision: '5', maxAllowableOffset: '0.00003', f: 'geojson',
        });
        let reply;
        try {
            reply = await getJSON(url, { timeout: 15_000 });
        } catch (error) {
            // About one query in ten timed out or was reset during research, and passed when asked again.
            if (!(error instanceof ResponseError) || error.status !== -1) throw error;
            await sleep(3000);
            reply = await getJSON(url, { timeout: 15_000 });
        }
        return (reply?.features ?? []).map(routeFeature).filter(Boolean);
    });
}

/**
 * Bus features are MultiLineStrings with one piece per stop-to-stop link, already in travel order
 * and meeting end to end; minibus ones LineStrings. `[lon, lat]` pairs.
 */
function routeFeature(item) {
    const coordinates = item?.geometry?.coordinates ?? [];
    const pieces = Array.isArray(coordinates[0]?.[0]) ? coordinates : [coordinates];
    const line = [];
    for (const piece of pieces) {
        const points = piece.filter((c) => c.length >= 2).map(([lon, lat]) => ({ lat, lon }));
        const last = line[line.length - 1];
        const joins = last && points[0] && last.lat === points[0].lat && last.lon === points[0].lon;
        line.push(...(joins ? points.slice(1) : points));
    }
    const routeID = item?.properties?.ROUTE_ID;
    const seq = item?.properties?.ROUTE_SEQ;
    return line.length >= 2 && routeID != null && seq != null ? { routeID, seq, line } : null;
}

/**
 * The pattern's line among the drawn variants, in order of preference:
 * - one variant all the stops lie along, in order;
 * - two variants run one after the other, where TD draws a circular route as two directions
 *   meeting at the far end (MTR Bus K18: out to Kwong Fuk, back to Tai Po Market);
 * - two variants as branches, each with the stops along it in order, when the operator's list
 *   merges two of TD's (Citybus 1 outbound: one via Chater Road, one via Des Voeux Road Central);
 * - one variant missing at most `misses` stops, each within `missReach`, when a stop is on no
 *   drawn variant at all (Citybus 11 inbound's Ice House Street stop); it stays a marker.
 * Otherwise, or when TD has not drawn the route, null. (Not the nearest variant: Citybus' looser
 * tolerance would let one through that misses more stops than allowed here.)
 */
export function pickRouteLine(features, stops, misses = 0) {
    const whole = features
        .map((feature) => ({ feature, fitted: fit(feature.line, stops) }))
        .filter((f) => f.fitted)
        .map((f) => ({ ...f, length: length(f.fitted.line) }));
    if (whole.length) {
        const best = whole.reduce((a, b) => (b.fitted.worst < a.fitted.worst
            || (b.fitted.worst === a.fitted.worst && b.length < a.length) ? b : a));
        return { branches: [best.fitted.line] };
    }

    let joined = null;
    for (const first of features) {
        for (const then of features) {
            if (then.routeID !== first.routeID || then.seq === first.seq) continue;
            if (meters(first.line[first.line.length - 1], then.line[0]) > 30) continue;
            const fitted = fit([...first.line, ...then.line.slice(1)], stops);
            if (fitted && (!joined || fitted.worst < joined.worst)) joined = fitted;
        }
    }
    if (joined) return { branches: [joined.line] };

    const limit = (index) => (index === 0 || index === stops.length - 1 ? ROUTE_TOLERANCE.ends : ROUTE_TOLERANCE.stops);
    const offsets = features.map((feature) => {
        const projection = new Projection(feature.line);
        return stops.map((stop) => projection.nearest(stop));
    });
    const along = (k) => stops.map((_, i) => i).filter((i) => offsets[k][i] <= limit(i));

    let pair = null;
    for (let a = 0; a < features.length; a++) {
        for (let b = a + 1; b < features.length; b++) {
            const onA = along(a);
            const onB = along(b);
            if (onA.length < 2 || onB.length < 2 || new Set([...onA, ...onB]).size !== stops.length) continue;
            const lineA = fit(features[a].line, onA.map((i) => stops[i]));
            const lineB = lineA && fit(features[b].line, onB.map((i) => stops[i]));
            if (!lineB) continue;
            const worst = Math.max(lineA.worst, lineB.worst);
            if (!pair || worst < pair.worst) pair = { branches: [lineA.line, lineB.line], worst };
        }
    }
    if (pair) return { branches: pair.branches };

    if (misses > 0) {
        // Matched in order: on a loop, a stop can stand by the other half of it.
        let best = null;
        for (const feature of features) {
            const ordered = orderedOffsets(feature.line, stops);
            if (!ordered) continue;
            const missed = stops.map((_, i) => i).filter((i) => ordered[i] > limit(i));
            if (missed.length > misses || !missed.every((i) => ordered[i] <= HKRouteLines.missReach)) continue;
            const kept = fit(feature.line, stops.filter((_, i) => !missed.includes(i)));
            if (kept && (!best || kept.worst < best.worst)) best = kept;
        }
        if (best) return { branches: [best.line] };
    }

    return null;
}

/**
 * The line cut to the stretch from the first stop to the last when it still fits them so (a loop
 * drawn whole, of which the pattern is one half), else whole; null when the stops do not lie along
 * it in order. `worst` is the farthest stop's offset.
 */
function fit(line, stops) {
    const whole = verdict({ branches: [line] }, stops, ROUTE_TOLERANCE);
    if (!whole.accepted || line.length < 2) return null;
    const first = line[0];
    const last = line[line.length - 1];
    const cuts = [trimmed(line, stops)];
    // A half starting (or ending) at a loop's seam is as near the loop's end as its start, and the
    // plain cut cannot tell which is meant: cut that half at its other end only.
    if (meters(first, last) <= 30 && stops.length >= 2) {
        cuts.push(trimmed(line, [first, ...stops.slice(1)]));
        cuts.push(trimmed(line, [...stops.slice(0, -1), last]));
    }
    let best = null;
    for (const cut of cuts) {
        const result = verdict({ branches: [cut] }, stops, ROUTE_TOLERANCE);
        if (!result.accepted) continue;
        const cutLength = length(cut);
        if (!best || cutLength < best.length) best = { line: cut, worst: result.worstOffset ?? 0, length: cutLength };
    }
    return best ? { line: best.line, worst: best.worst } : { line, worst: whole.worstOffset ?? 0 };
}
