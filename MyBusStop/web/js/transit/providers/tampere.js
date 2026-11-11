// Tampere region, Finland (Nysse) — ITS Factory Journeys API, a SIRI-flavoured JSON REST API. Port of
// BusBus/Transit/Providers/TampereProvider.swift. Keyless, no documented rate limit, CC BY 4.0.
// `exclude-fields` trims replies hard: a stop's journey patterns without their timetables are ~3 KB
// instead of ~700 KB, which is what makes this usable straight from the browser.
//
// A line here is one Journeys line in one direction. The two live endpoints disagree on how they
// number directions: `stop-monitoring` uses the journey pattern's own `direction` ("0"/"1"), while
// `vehicle-activity` counts from one ("1"/"2") — checked against origin/destination stops.

import { Capability, TransitError, compareLineNames, makeLine, meters } from '../model.js';
import { getJSON, zonedTime } from '../http.js';
import { UNKNOWN_DAYS, fromDates, serviceDates, weekdayOf } from '../service-days.js';

const BASE = 'https://data.itsfactory.fi/journeys/api/1';
const TIME_ZONE = 'Europe/Helsinki';
/**
 * Keeps each pattern's stop list but drops its timetable and per-stop municipality blocks. (Excluding
 * `stopPoints.url` would also drop the pattern's own `url`, which carries its id.)
 */
const PATTERN_FIELDS = 'journeys,stopPoints.municipality,stopPoints.tariffZone';

/**
 * A stop's journeys with nothing but their calendars: ~2 KB on the wire for a busy line at its terminal,
 * against ~40 KB with every field. (`departureTime` goes too: day types are the GTFS service day's, so a
 * bus at "24:51:00" already counts on the day it set out.)
 */
const CALENDAR_FIELDS = 'calls,activityUrl,journeyPatternUrl,journeyUrl,lineUrl,routeUrl,stopPointUrl,gtfs,'
    + 'headSign,arrivalTime,departureTime,wheelchairAccessible,lineId';
/** Four weeks of dates, so a holiday on one of them does not dim or light a day. */
const DAYS_WINDOW = 28;
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const lastPathComponent = (url) => (url ? String(url).replace(/\/+$/, '').split('/').pop() || null : null);

/** "lat,lon" as one string: "61.49754,23.76152". `shortName` is the four-digit stop number. */
function toStop(point) {
    const parts = String(point?.location ?? '').split(',').map(Number);
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n)) || !point.shortName) return null;
    return {
        code: point.shortName,
        name: point.name ?? point.shortName,
        city: point.municipality?.name ?? null,
        location: { lat: parts[0], lon: parts[1] },
    };
}

/** Coordinates arrive as strings: `"61.4986610"`. */
function coordinates(c) {
    const lat = c?.latitude != null ? Number(c.latitude) : NaN;
    const lon = c?.longitude != null ? Number(c.longitude) : NaN;
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function patternLine(pattern) {
    const lineName = lastPathComponent(pattern.lineUrl);
    if (!lineName) return null;
    const direction = pattern.direction ?? '0';
    const stops = pattern.stopPoints ?? [];
    const first = stops[0]?.name ?? null;
    const last = stops[stops.length - 1]?.name ?? null;
    const refs = { line: lineName, direction };
    const id = lastPathComponent(pattern.url);
    if (id) refs.patternId = id;
    return makeLine({
        id: `${lineName}/${direction}`,
        shortName: lineName, // the journeys API names a line by its public number ("lines/3A")
        headsign: last,
        agency: 'Nysse',
        origin: first,
        destination: last,
        providerRefs: refs,
    });
}

function refsOf(line) {
    const parts = String(line.id ?? '').split('/');
    const name = line.providerRefs?.line ?? parts[0];
    const direction = line.providerRefs?.direction ?? parts[1];
    if (!name || direction == null) {
        throw new TransitError('unsupported', `line ${line.id} is not a Tampere line/direction (was it loaded from another provider?)`);
    }
    return { name, direction };
}

const longest = (patterns) => patterns.reduce((best, p) =>
    (!best || (p.stopPoints?.length ?? 0) > (best.stopPoints?.length ?? 0) ? p : best), null);

/** Offsets are always present, with or without fractional seconds. */
function parseISO(text) {
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** `originAimedDepartureTime` is a bare local "HHmm" ("0918"); `dateFrameRef` is the service day. */
function parseClock(hhmm, day) {
    if (!hhmm || hhmm.length !== 4 || !day) return null;
    return zonedTime(day, `${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00`, TIME_ZONE);
}

/** The pattern the line stands for: its own id while that lasts, else the line's longest that way. */
async function journeyPattern(line) {
    const { name, direction } = refsOf(line);
    let pattern = null;
    const id = line.providerRefs?.patternId;
    if (id) {
        try {
            const response = await getJSON(`${BASE}/journey-patterns/${encodeURIComponent(id)}`, { query: { 'exclude-fields': PATTERN_FIELDS } });
            pattern = response.body?.[0] ?? null;
        } catch {
            pattern = null;
        }
    }
    if (!pattern?.stopPoints?.length) {
        // Pattern ids are content hashes and change with each timetable; fall back to the line.
        const response = await getJSON(`${BASE}/journey-patterns`, { query: { lineId: name, 'exclude-fields': PATTERN_FIELDS } });
        pattern = longest((response.body ?? []).filter((p) => (p.direction ?? '0') === direction));
    }
    return pattern;
}

/**
 * Whether one journey's calendar has it run on a "yyyy-MM-dd" date: an exception covering the date decides
 * (calendar_dates.txt); otherwise the date is within validFrom…validTo and its weekday is a day type.
 */
function runsOn(journey, date) {
    const exception = (journey.dayTypeExceptions ?? []).find((e) => e.from && e.to && e.from <= date && date <= e.to);
    if (exception) return exception.runs === 'yes';
    if (!journey.validFrom || !journey.validTo || date < journey.validFrom || date > journey.validTo) return false;
    const name = DAY_NAMES[(weekdayOf(date) ?? 0) - 1];
    return (journey.dayTypes ?? []).some((type) => String(type).toLowerCase() === name);
}

/**
 * The days a line runs, from a stop's journeys of it (`stop-points/{code}/journeys?lineId=`): a date of the
 * window counts when any journey the line's way runs on it. Every journey is one GTFS trip with its own
 * calendar, and a line has several at once (Monday to Thursday, Friday, Saturday, Sunday, holidays), so
 * the union is taken, never one of them.
 */
export function daysFromJourneys(journeys, direction, window) {
    const calendars = new Map();
    for (const journey of journeys ?? []) {
        if ((journey.directionId ?? '0') !== direction) continue;
        const { dayTypes, validFrom, validTo, dayTypeExceptions } = journey;
        calendars.set(JSON.stringify([dayTypes, validFrom, validTo, dayTypeExceptions]), journey);
    }
    const kept = [...calendars.values()];
    const running = window.filter((date) => kept.some((journey) => runsOn(journey, date)));
    return fromDates(running, window);
}

/**
 * "6144766,2383534:-6,-1:0,20:…": the first pair is lat,lon × 1e5, and every pair after it is
 * *subtracted* from the one before (adding them draws the line mirrored).
 */
function decodeProjection(text) {
    let lat = 0, lon = 0;
    return String(text).split(':').map((pair, index) => {
        const values = pair.split(',').map(Number);
        if (values.length !== 2 || !values.every(Number.isInteger)) {
            throw new TransitError('badResponse', `Tampere route projection ${pair}`);
        }
        if (index === 0) [lat, lon] = values;
        else { lat -= values[0]; lon -= values[1]; }
        return { lat: lat / 1e5, lon: lon / 1e5 };
    });
}

/** @type {import('../model.js').TransitProvider} */
const provider = {
    id: 'tampere',
    displayName: 'Nysse (Tampere)',
    // `stop-monitoring` only lists vehicles already on their way, so there is no timetable fallback.
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.nearbyStops,
    ]),
    refreshSeconds: 20,
    datasetID: 'tampere',
    attribution: 'Data: Tampere Regional Transport (Nysse) / ITS Factory Journeys API, CC BY 4.0',
    reportsShadowTrips: false,

    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        // Stop numbers are four digits with leading zeros ("0012"); `name` does not match them.
        const filter = /^\d+$/.test(text) ? { shortName: text.padStart(4, '0') } : { name: text };
        const response = await getJSON(`${BASE}/stop-points`, { query: { ...filter, 'exclude-fields': 'tariffZone' } });
        return (response.body ?? []).map(toStop).filter(Boolean);
    },

    async linesAtStop(stop) {
        const response = await getJSON(`${BASE}/journey-patterns`, {
            query: { stopPointId: stop.code, 'exclude-fields': PATTERN_FIELDS },
        });
        const groups = new Map();
        for (const pattern of response.body ?? []) {
            const line = lastPathComponent(pattern.lineUrl);
            if (!line) continue;
            const key = `${line}/${pattern.direction ?? '0'}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(pattern);
        }
        // Short-turn variants share a direction with the full run; the longest stands for it.
        return [...groups.values()]
            .map((patterns) => patternLine(longest(patterns)))
            .filter(Boolean)
            .sort((a, b) => (a.shortName === b.shortName ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : compareLineNames(a.shortName, b.shortName)));
    },

    async routePattern(line) {
        const pattern = await journeyPattern(line);
        const stops = (pattern?.stopPoints ?? []).map(toStop).filter(Boolean);
        if (!stops.length) throw new TransitError('notFound', `stops of Tampere line ${line.id}`);
        // The API returns stop points in travel order and publishes no sequence number of its own.
        // The pattern's route is where its shape lives; kept so the shape needs no second look.
        return {
            line,
            stops: stops.map((stop, i) => ({ stop, sequence: i + 1, distanceAlongRoute: null })),
            shapeData: { routeId: lastPathComponent(pattern.routeUrl) },
        };
    },

    /**
     * The path of the pattern's route (one route per journey pattern, short turns included):
     * `routes/{id}` without its journeys is 1–3 KB gzipped, with them ~425 KB.
     */
    async routeShape(line, pattern) {
        const routeId = pattern?.shapeData?.routeId ?? lastPathComponent((await journeyPattern(line))?.routeUrl);
        if (!routeId) throw new TransitError('notFound', `route of Tampere line ${line.id}`);
        const response = await getJSON(`${BASE}/routes/${encodeURIComponent(routeId)}`, {
            query: { 'exclude-fields': 'journeys,journeyPatterns' },
        });
        const projection = response.body?.[0]?.geographicCoordinateProjection;
        if (!projection) return null;
        const points = decodeProjection(projection);
        return points.length >= 2 ? { branches: [points] } : null;
    },

    async vehicles(line) {
        const { name, direction } = refsOf(line);
        const activityDirection = /^\d+$/.test(direction) ? String(Number(direction) + 1) : null;
        const response = await getJSON(`${BASE}/vehicle-activity`, {
            query: { lineRef: name, 'exclude-fields': 'monitoredVehicleJourney.onwardCalls' },
        });
        const out = [];
        for (const activity of response.body ?? []) {
            const journey = activity.monitoredVehicleJourney;
            if (!journey || journey.lineRef !== name || journey.directionRef !== activityDirection) continue;
            const location = coordinates(journey.vehicleLocation);
            if (!location) continue;
            const bearing = journey.bearing != null ? Number(journey.bearing) : NaN;
            const speed = journey.speed != null ? Number(journey.speed) : NaN;
            out.push({
                location,
                recordedAt: parseISO(activity.recordedAtTime),
                distanceAlongRoute: null,
                tripId: lastPathComponent(journey.framedVehicleJourneyRef?.datedVehicleJourneyRef),
                // Operator + vehicle number ("56920_4"), not a plate — the board only needs a stable identity.
                plateNumber: journey.vehicleRef ?? null,
                bearing: Number.isFinite(bearing) ? bearing : null,
                speedKmh: Number.isFinite(speed) ? speed : null,
                aimedDeparture: parseClock(journey.originAimedDepartureTime, journey.framedVehicleJourneyRef?.dateFrameRef),
            });
        }
        return out;
    },

    async arrivals(line, stop) {
        const { name, direction } = refsOf(line);
        const response = await getJSON(`${BASE}/stop-monitoring`, { query: { stops: stop.code } });
        const out = [];
        for (const visit of response.body?.[stop.code] ?? []) {
            if (visit.lineRef !== name || visit.directionRef !== direction) continue;
            const call = visit.call ?? {};
            const expectedAt = parseISO(call.expectedArrivalTime ?? call.expectedDepartureTime);
            if (!expectedAt) continue;
            out.push({
                expectedAt,
                scheduledAt: parseISO(call.aimedArrivalTime ?? call.aimedDepartureTime),
                isRealtime: true,
                tripId: null,
                vehicleLocation: coordinates(visit.vehicleLocation),
            });
        }
        return out.sort((a, b) => a.expectedAt - b.expectedAt);
    },

    /**
     * The days the line runs at the rider's stop, from its journeys there with their calendars. Only this
     * stop endpoint gives each journey its validFrom/validTo: `journeys?lineId=` keeps only the calendars
     * valid today (Monday to Thursday, on a Wednesday), and the journeys inside journey patterns or routes
     * carry no validity, so past one-day and holiday-only calendars would light days the line no longer
     * runs. Without a stop there is nothing to ask.
     */
    async serviceDays(line, stopCode) {
        if (!stopCode) return UNKNOWN_DAYS;
        const { name, direction } = refsOf(line);
        const response = await getJSON(`${BASE}/stop-points/${encodeURIComponent(stopCode)}/journeys`, {
            query: { lineId: name, 'exclude-fields': CALENDAR_FIELDS },
        });
        return daysFromJourneys(response.body ?? [], direction, serviceDates({ count: DAYS_WINDOW, timeZone: TIME_ZONE }));
    },
    /** A stop counts only the journeys that call there: a short turn that skips it is not its line's. */
    serviceDaysVaryByStop: true,

    /**
     * `stop-points?location=` takes a box, "minLat,minLon:maxLat,maxLon" (the "lat,lon:radius" form
     * returns nothing). Each of the nearest stops is then asked for its lines, capped at 12 stops.
     */
    async stopsNearby(point, radiusMeters) {
        const dLat = radiusMeters / 111_320;
        const dLon = radiusMeters / (111_320 * Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01));
        const box = `${point.lat - dLat},${point.lon - dLon}:${point.lat + dLat},${point.lon + dLon}`;
        const response = await getJSON(`${BASE}/stop-points`, { query: { location: box, 'exclude-fields': 'tariffZone' } });
        const near = (response.body ?? [])
            .map(toStop)
            .filter(Boolean)
            .map((stop) => ({ stop, distanceMeters: meters(point, stop.location) }))
            .filter((n) => n.distanceMeters <= radiusMeters)
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .slice(0, 12);
        const results = await Promise.all(near.map(async (n) => ({ ...n, lines: await provider.linesAtStop(n.stop) })));
        return results.filter((n) => n.lines.length);
    },
};

export default provider;
