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
import { ResponseError, getJSON } from '../http.js';
import { UNKNOWN_DAYS, serviceDays } from '../service-days.js';
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

// MARK: Service days

/** What a schedule's name may say beside its days without changing them. */
const FILLER_WORDS = new Set(['night', 'nights', 'morning', 'mornings', 'school', 'schools', 'schoolday', 'schooldays', 'days', 'only']);
const HOLIDAY_WORDS = new Set(['bank', 'public', 'holiday', 'holidays']);
const DAY_GROUPS = {
    weekday: [2, 3, 4, 5, 6], weekdays: [2, 3, 4, 5, 6], weekend: [1, 7], weekends: [1, 7],
    daily: [1, 2, 3, 4, 5, 6, 7], everyday: [1, 2, 3, 4, 5, 6, 7],
};
const DAY_NAMES = {
    sunday: 1, sun: 1, su: 1,
    monday: 2, mon: 2, mo: 2,
    tuesday: 3, tues: 3, tue: 3, tu: 3,
    wednesday: 4, wed: 4, we: 4,
    thursday: 5, thurs: 5, thur: 5, thu: 5, th: 5,
    friday: 6, fri: 6, fr: 6,
    saturday: 7, sat: 7, sa: 7,
};

/** "friday", "fri", "fr", or a plural, "fridays". */
const dayNamed = (word) => (Object.hasOwn(DAY_NAMES, word) ? DAY_NAMES[word]
    : word.endsWith('s') && Object.hasOwn(DAY_NAMES, word.slice(0, -1)) ? DAY_NAMES[word.slice(0, -1)] : null);

/**
 * The weekdays a schedule's name says, 1 = Sunday; null for a name it cannot read.
 *
 * Names are free text. Seen: "Monday to Thursday", "Monday to Friday", "Friday", "Tuesday" (a mobility
 * route that runs one day a week), "Mon-Th Schooldays" and "School Friday" (a school route: those
 * weekdays in term), and on night routes "Mo-Th Nights/Tu-Fr Morning" or "Sunday Night/Monday Morning".
 * A night belongs to the day it sets out, the part before the "/", as its times past midnight (25:13)
 * say. A name of holidays alone adds no weekday. Port of `TfLProvider.weekdays(inScheduleName:)`.
 * @returns {Set<number>|null}
 */
export function weekdaysInScheduleName(name) {
    const night = String(name ?? '').split('/')[0];
    const words = night.toLowerCase()
        .replaceAll('&', ' and ').replaceAll(',', ' and ').replaceAll('-', ' to ').replaceAll('–', ' to ')
        .split(/[\s().]+/).filter(Boolean);
    const days = new Set();
    let last = null;
    let inRange = false;
    let holidays = false;
    for (const word of words) {
        if (FILLER_WORDS.has(word)) continue;
        if (HOLIDAY_WORDS.has(word)) { holidays = true; continue; }
        if (word === 'to') {
            if (last === null || inRange) return null;
            inRange = true;
            continue;
        }
        if (word === 'and') {
            if (inRange) return null;
            last = null;
            continue;
        }
        if (Object.hasOwn(DAY_GROUPS, word)) {
            if (inRange) return null;
            for (const day of DAY_GROUPS[word]) days.add(day);
            last = null;
            continue;
        }
        const day = dayNamed(word);
        if (day === null) return null;
        if (inRange && last !== null) {
            // "Friday to Monday" runs on round the weekend.
            for (let step = last; step !== day;) { step = (step % 7) + 1; days.add(step); }
            inRange = false;
            last = null;
        } else {
            days.add(day);
            last = day;
        }
    }
    if (inRange || (!days.size && !holidays)) return null;
    return days;
}

/**
 * The days of every schedule that runs, joined: a branch or a short working through the stop is a route
 * of its own in the reply, each with its schedules. A schedule runs when it has journeys. One name it
 * cannot read leaves the whole week unknown rather than a guess with a day missing. Port of
 * `TfLProvider.serviceDays(scheduleNames:)`, from the `Line/{id}/Timetable/{stop}` reply.
 */
export function serviceDaysFromTimetable(reply) {
    const days = new Set();
    for (const route of reply?.timetable?.routes ?? []) {
        for (const schedule of route.schedules ?? []) {
            if (!(schedule.knownJourneys ?? []).length && !schedule.firstJourney) continue;
            if (schedule.name == null) continue;
            const named = weekdaysInScheduleName(schedule.name);
            if (!named) return UNKNOWN_DAYS;
            for (const day of named) days.add(day);
        }
    }
    return days.size ? serviceDays(days) : UNKNOWN_DAYS;
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

    /** The timetable is kept per stop: a short working can skip the rider's stop on Sundays. */
    serviceDaysVaryByStop: true,

    /**
     * `Line/{id}/Timetable/{stop}` names each of its schedules by the days it is for ("Monday to Thursday",
     * "Saturday"), at this stop in this direction: one request (about 8 KB gzipped), only when the card
     * opens. A line from the nearby list has no direction; TfL then picks it from the stop, which serves the
     * line one way. No stop at all asks nothing. A stop the line does not serve that way is a 400 or 404:
     * no row, kept a day like any answer. Port of `TfLProvider.serviceDays(for:atStopCode:)`.
     */
    async serviceDays(line, stopCode) {
        const refs = line.providerRefs ?? {};
        const lineId = refs.lineId ?? String(line.id).split(/[:@]/)[0];
        const naptanId = stopCode ?? refs.naptanId ?? null;
        if (!naptanId) return UNKNOWN_DAYS;
        let reply;
        try {
            reply = await get(`/Line/${encodeURIComponent(lineId)}/Timetable/${encodeURIComponent(naptanId)}`,
                refs.direction ? { direction: refs.direction } : undefined);
        } catch (error) {
            if (error instanceof ResponseError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
                return UNKNOWN_DAYS;
            }
            throw error;
        }
        return serviceDaysFromTimetable(reply);
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
