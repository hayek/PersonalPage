// Japan, Tokyo — Toei Bus (Bureau of Transportation, Tokyo Metropolitan Government) through the
// ODPT public API (api-public.odpt.org), official, keyless and CORS open. Only Toei is served on the
// token-free host; every other ODPT operator needs a developer token, which this web version never uses.
//
// - Positions: the fleet-wide GTFS-RT VehiclePosition feed (~20-40 KB of protobuf, refreshed every
//   ~30 s), read by the small decoder at the bottom of this file. Its trip ids are
//   `{pattern}-{direction}-…`, the same numbers as the ODPT route pattern ids, which is how a bus is
//   matched to a line.
// - Arrivals: ODPT publishes no predictions. The stop timetable gives the schedule; for buses on the
//   road, `odpt:Bus` says which stop each one last passed and when, and that trip's own timetable
//   turns this into a delay carried forward to the rider's stop. Only those are marked realtime.
// - Filters that take several values (`owl:sameAs=a,b`) accept at most 10, hence the chunking.
// - No published rate limit; responses are gzip'd and `Cache-Control: max-age=3600` on static data.
//
// Licence: CC BY 4.0 for every Toei bus dataset (ckan.odpt.org), crediting "東京都交通局・公共交通
// オープンデータ協議会" / "Bureau of Transportation, Tokyo Metropolitan Government / Association
// for Open Data of Public Transportation".

import { Capability, TransitError, compareLineNames, makeLine, meters } from '../model.js';
import { buildURL, getBytes, getJSON, memo, serviceDate, staticData, zonedTime } from '../http.js';

const BASE = 'https://api-public.odpt.org/api/v4';
const TIME_ZONE = 'Asia/Tokyo';
const POLE_PREFIX = 'odpt.BusstopPole:Toei.';
const PATTERN_PREFIX = 'odpt.BusroutePattern:Toei.';
const DAY_MS = 86_400_000;

/**
 * Names are published in Japanese and (for stops) English. Japanese readers get Japanese, everyone
 * else English; the web version is English.
 */
const language = () => 'en';

const get = (path, query = {}) => getJSON(buildURL(BASE, path, query));

// ---------------------------------------------------------------------------------------------
// Poles

/** One bus stop pole, from the API or from the cached list. */
function toPole(raw) {
    return {
        sameAs: raw['owl:sameAs'],
        ja: raw.title?.ja ?? raw['dc:title'] ?? null,
        en: raw.title?.en ?? null,
        kana: raw['odpt:kana'] ?? null,
        lat: raw['geo:lat'] ?? null,
        lon: raw['geo:long'] ?? null,
        number: raw['odpt:platformNumber'] ?? raw['odpt:busstopPoleNumber'] ?? null,
        patterns: raw['odpt:busroutePattern'] ?? [],
    };
}

const location = (pole) => (pole.lat != null && pole.lon != null ? { lat: pole.lat, lon: pole.lon } : null);

function poleName(pole, lang) {
    const ja = pole.ja ?? pole.sameAs;
    return lang === 'ja' ? ja : (pole.en ?? ja);
}

/** Poles of one stop share a name; the platform number riders see on the pole tells them apart. */
function poleStop(pole, lang, platform) {
    let name = poleName(pole, lang);
    if (platform && pole.number) name += lang === 'ja' ? ` ${pole.number}番のりば` : ` (stop ${pole.number})`;
    return { code: pole.sameAs.slice(POLE_PREFIX.length), name, city: null, location: location(pole) ?? { lat: 0, lon: 0 } };
}

/** The stop number inside the id: `…KinshichoStation.442.2` → 442. */
function stopNumber(pole) {
    const parts = pole.sameAs.split('.');
    return parts.length >= 2 ? Number.parseInt(parts[parts.length - 2], 10) : null;
}

let poleIndexStarted = false;

/**
 * Every Toei pole (~3,700; 5.6 MB of JSON, ~430 KB gzipped), kept for a day as a trimmed list
 * (~0.9 MB) of [code, ja, en, kana, lat, lon, number, patterns without their prefix].
 */
function poleIndex() {
    poleIndexStarted = true;
    const loading = memo('odpt-toei:poles', DAY_MS, async () => {
        const rows = await staticData('odpt-toei/poles', DAY_MS, async () => {
            const all = (await get('/odpt:BusstopPole', { 'odpt:operator': 'odpt.Operator:Toei' })).map(toPole);
            return all
                .filter((p) => location(p) && p.sameAs.startsWith(POLE_PREFIX))
                .map((p) => [p.sameAs.slice(POLE_PREFIX.length), p.ja, p.en, p.kana, p.lat, p.lon, p.number,
                    p.patterns.map((id) => (id.startsWith(PATTERN_PREFIX) ? id.slice(PATTERN_PREFIX.length) : id))]);
        });
        const index = new Map();
        for (const [code, ja, en, kana, lat, lon, number, patterns] of rows) {
            const sameAs = POLE_PREFIX + code;
            index.set(sameAs, {
                sameAs, ja, en, kana, lat, lon, number,
                patterns: patterns.map((id) => (id.startsWith('odpt.') ? id : PATTERN_PREFIX + id)),
            });
        }
        return index;
    });
    loading.catch(() => { poleIndexStarted = false; });
    return loading;
}

/** Poles by id: from the full list when it is already loaded or the ask is large, otherwise 10 per request. */
async function poles(ids) {
    if (ids.length > 30 || poleIndexStarted) {
        const index = await poleIndex();
        return ids.map((id) => index.get(id)).filter(Boolean);
    }
    return (await chunked(ids, (chunk) => get('/odpt:BusstopPole', { 'owl:sameAs': chunk.join(',') }))).map(toPole);
}

async function chunked(ids, load) {
    const unique = [...new Set(ids)].sort();
    const chunks = [];
    for (let i = 0; i < unique.length; i += 10) chunks.push(unique.slice(i, i + 10));
    return (await Promise.all(chunks.map(load))).flat();
}

// ---------------------------------------------------------------------------------------------
// Static documents, kept for the session

const patternStore = new Map();
const tripStore = new Map();
const poleTimetableStore = new Map();

function toPattern(raw) {
    return {
        sameAs: raw['owl:sameAs'],
        title: raw['dc:title'] ?? null,
        route: raw['odpt:busroute'] ?? null,
        stops: (raw['odpt:busstopPoleOrder'] ?? []).map((s) => ({ index: s['odpt:index'], pole: s['odpt:busstopPole'], note: s['odpt:note'] ?? null })),
    };
}

/**
 * "都０１(T01) 渋谷駅前行" → "都01" in Japanese, "T01" elsewhere when Toei gives a Latin code;
 * otherwise the Japanese name, which is what the bus shows.
 */
function patternShortName(pattern, lang) {
    const raw = (pattern.title ?? pattern.sameAs).split(' ').find(Boolean) ?? pattern.sameAs;
    const name = raw.normalize('NFKC'); // full-width digits → ASCII
    const open = name.indexOf('(');
    const close = name.lastIndexOf(')');
    if (open < 0 || close < 0 || open >= close) return name;
    const latin = name.slice(open + 1, close);
    return lang === 'ja' || !latin ? name.slice(0, open) : latin;
}

const firstStop = (p) => p.stops.reduce((a, b) => (b.index < a.index ? b : a), p.stops[0]);
const lastStop = (p) => p.stops.reduce((a, b) => (b.index > a.index ? b : a), p.stops[0]);

/** Route patterns by id, 10 per request, cached for the session (~2-20 KB each with its shape). */
async function patterns(ids) {
    const missing = ids.filter((id) => !patternStore.has(id));
    if (missing.length) {
        const loaded = await chunked(missing, (chunk) => get('/odpt:BusroutePattern', { 'owl:sameAs': chunk.join(',') }));
        for (const raw of loaded) {
            const pattern = toPattern(raw);
            patternStore.set(pattern.sameAs, pattern);
        }
    }
    return ids.map((id) => patternStore.get(id)).filter(Boolean);
}

/** Trip timetables by id, 10 per request, cached for the session (~1.5 KB each). */
async function tripTimetables(ids) {
    if (tripStore.size > 2_000) tripStore.clear();
    const missing = ids.filter((id) => !tripStore.has(id));
    if (missing.length) {
        const loaded = await chunked(missing, (chunk) => get('/odpt:BusTimetable', { 'owl:sameAs': chunk.join(',') }));
        for (const raw of loaded) {
            tripStore.set(raw['owl:sameAs'], {
                sameAs: raw['owl:sameAs'],
                entries: (raw['odpt:busTimetableObject'] ?? []).map((e) => ({
                    index: e['odpt:index'], pole: e['odpt:busstopPole'], arrivalTime: e['odpt:arrivalTime'] ?? null,
                    departureTime: e['odpt:departureTime'] ?? null, isMidnight: e['odpt:isMidnight'] ?? null,
                })),
            });
        }
    }
    return ids.map((id) => tripStore.get(id)).filter(Boolean);
}

/** Up to ~150 KB per busy pole and route; kept for the session (timetables change quarterly). */
async function poleTimetables(pole, route) {
    const key = `${pole}|${route}`;
    if (poleTimetableStore.has(key)) return poleTimetableStore.get(key);
    if (poleTimetableStore.size > 50) poleTimetableStore.clear();
    const tables = (await get('/odpt:BusstopPoleTimetable', { 'odpt:busstopPole': pole, 'odpt:busroute': route })).map((raw) => ({
        calendar: raw['odpt:calendar'] ?? null,
        entries: (raw['odpt:busstopPoleTimetableObject'] ?? []).map((e) => ({
            departureTime: e['odpt:departureTime'] ?? null, isMidnight: e['odpt:isMidnight'] ?? null, pattern: e['odpt:busroutePattern'] ?? null,
        })),
    }));
    poleTimetableStore.set(key, tables);
    return tables;
}

/** Calendar id → dates it runs ("2026-09-22"); ~80 calendars, 115 KB of JSON. Only dated ones are kept. */
function calendars() {
    return memo('odpt-toei:calendars', DAY_MS, async () => {
        const days = await staticData('odpt-toei/calendars', DAY_MS, async () => {
            const result = {};
            for (const c of await get('/odpt:Calendar')) {
                if (c['odpt:day']?.length) result[c['owl:sameAs']] = c['odpt:day'];
            }
            return result;
        });
        return new Map(Object.entries(days).map(([id, list]) => [id, new Set(list)]));
    });
}

// ---------------------------------------------------------------------------------------------
// Lines

/** The patterns and routes a line stands for; a line cached without refs is its own pattern. */
function lineRef(line) {
    const split = (value) => (value ? String(value).split(',').filter(Boolean) : []);
    const patternIDs = line.providerRefs?.patterns ? split(line.providerRefs.patterns) : [line.id];
    let routes = split(line.providerRefs?.routes);
    if (!routes.length) {
        // odpt.BusroutePattern:Toei.To07.60101.1 → odpt.Busroute:Toei.To07
        const parts = String(line.id).replace('odpt.BusroutePattern:', '').split('.');
        routes = [`odpt.Busroute:${parts.slice(0, -2).join('.')}`];
    }
    return { patterns: patternIDs, routes };
}

/**
 * Lines at each pole: its patterns, grouped by route name and terminus, keeping patterns that only
 * end there only when nothing else serves the pole. A line is the representative (longest) pattern;
 * `providerRefs.patterns` lists every pattern folded into it — variants of the same route and
 * terminus starting elsewhere.
 */
async function servingLines(poleList) {
    const lang = language();
    const all = await patterns([...new Set(poleList.flatMap((p) => p.patterns ?? []))]);
    const byID = new Map(all.map((p) => [p.sameAs, p]));
    const ends = [...new Set(all.filter((p) => p.stops.length).flatMap((p) => [firstStop(p).pole, lastStop(p).pole]))];
    const names = new Map((await poles(ends)).map((p) => [p.sameAs, p]));

    const result = new Map();
    for (const pole of poleList) {
        const serving = (pole.patterns ?? []).map((id) => byID.get(id))
            .filter((p) => p && p.stops.some((s) => s.pole === pole.sameAs));
        const boarding = serving.filter((p) => lastStop(p).pole !== pole.sameAs);
        const groups = new Map();
        for (const p of boarding.length ? boarding : serving) {
            const key = `${patternShortName(p, lang)}|${lastStop(p)?.pole ?? ''}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(p);
        }
        const lines = [...groups.values()].map((group) => {
            // The longest pattern; between equals, the first by id.
            const main = group.reduce((a, b) => (b.stops.length > a.stops.length
                || (b.stops.length === a.stops.length && b.sameAs < a.sameAs) ? b : a));
            const name = (entry) => (entry ? (names.has(entry.pole) ? poleName(names.get(entry.pole), lang) : entry.note) : null);
            const destination = name(lastStop(main));
            return makeLine({
                id: main.sameAs,
                shortName: patternShortName(main, lang),
                headsign: destination,
                agency: lang === 'ja' ? '都営バス' : 'Toei Bus',
                origin: name(firstStop(main)),
                destination,
                providerRefs: {
                    patterns: group.map((p) => p.sameAs).sort().join(','),
                    routes: [...new Set(group.map((p) => p.route).filter(Boolean))].sort().join(','),
                },
            });
        });
        lines.sort((a, b) => compareLineNames(a.shortName, b.shortName) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        result.set(pole.sameAs, lines);
    }
    return result;
}

// ---------------------------------------------------------------------------------------------
// Service days

/**
 * A service day in Tokyo time (no daylight saving). Timetable clock times belong to one;
 * `isMidnight` (or an hour past 23) moves a time onto the next calendar day.
 */
function serviceDay(offsetDays, at) {
    const ymd = serviceDate(TIME_ZONE, offsetDays, at);
    const [y, m, d] = ymd.split('-').map(Number);
    return { ymd, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 1, start: zonedTime(ymd, '00:00:00', TIME_ZONE) }; // 1 = Sunday
}

const daysAround = (now) => [-1, 0, 1].map((offset) => serviceDay(offset, now));

function dayTime(day, clock, midnight) {
    if (!clock) return null;
    const parts = String(clock).split(':').map((part) => Number.parseInt(part, 10)).filter(Number.isFinite);
    if (parts.length < 2) return null;
    let hour = parts[0];
    if (midnight === true && hour < 12) hour += 24;
    return new Date(day.start.getTime() + (hour * 60 + parts[1]) * 60_000);
}

/** The clock time on whichever of the three service days around `reference` lands closest. */
function nearestTime(clock, midnight, reference) {
    let best = null;
    for (const day of daysAround(reference)) {
        const time = dayTime(day, clock, midnight);
        if (time && (!best || Math.abs(time - reference) < Math.abs(best - reference))) best = time;
    }
    return best;
}

/**
 * Toei calendars are `Specific.Toei.*` with explicit dates (holidays included); the generic
 * weekday ones are approximated from the day of the week.
 */
function runs(calendar, day, calendarDays) {
    if (!calendar) return false;
    const days = calendarDays.get(calendar);
    if (days?.size) return days.has(day.ymd);
    const weekday = day.weekday; // 1 = Sunday
    switch (calendar.replace('odpt.Calendar:', '')) {
        case 'Everyday': return true;
        case 'Weekday': return weekday >= 2 && weekday <= 6;
        case 'Saturday': return weekday === 7;
        case 'Sunday': case 'Holiday': return weekday === 1;
        case 'SaturdayHoliday': return weekday === 1 || weekday === 7;
        default: return false;
    }
}

// ---------------------------------------------------------------------------------------------
// Arrivals

/**
 * Scheduled passing times of the line's patterns at the pole, across yesterday's service
 * (after-midnight trips), today's and tomorrow's.
 */
async function scheduledTimes(ref, pole, now) {
    const calendarDays = await calendars();
    const tables = [];
    for (const route of new Set(ref.routes)) tables.push(...await poleTimetables(pole, route));
    const wanted = new Set(ref.patterns);
    const times = new Set();
    for (const day of daysAround(now)) {
        for (const table of tables) {
            if (!runs(table.calendar, day, calendarDays)) continue;
            for (const entry of table.entries) {
                if (!wanted.has(entry.pattern ?? '')) continue;
                const time = dayTime(day, entry.departureTime, entry.isMidnight);
                if (time) times.add(time.getTime());
            }
        }
    }
    // The same departure can be listed under more than one of the pole's timetables.
    return [...times].sort((a, b) => a - b).map((ms) => new Date(ms));
}

/**
 * Buses of the line now on the road that have yet to reach the pole, each re-timed by the delay at
 * the stop it last passed; plus the scheduled times of those already past it.
 */
async function liveArrivals(ref, pole, now) {
    const wanted = new Set(ref.patterns);
    let buses = [];
    for (const route of new Set(ref.routes)) buses.push(...await get('/odpt:Bus', { 'odpt:busroute': route }));
    buses = buses.filter((bus) => wanted.has(bus['odpt:busroutePattern'] ?? '') && bus['odpt:busTimetable']);
    if (!buses.length) return { predicted: [], gone: [] };
    const trips = new Map((await tripTimetables(buses.map((bus) => bus['odpt:busTimetable']))).map((t) => [t.sameAs, t]));

    const predicted = [];
    const gone = [];
    for (const bus of buses) {
        const trip = trips.get(bus['odpt:busTimetable']);
        if (!trip) continue;
        const stops = [...trip.entries].sort((a, b) => a.index - b.index);
        const target = stops.find((s) => s.pole === pole);
        if (!target) continue;
        const passedPole = bus['odpt:fromBusstopPole'];
        const passedAt = bus['odpt:fromBusstopPoleTime'] ? new Date(bus['odpt:fromBusstopPoleTime']) : null;
        if (!passedPole || !passedAt || Number.isNaN(passedAt.getTime())) continue;
        const passed = stops.find((s) => s.pole === passedPole);
        if (!passed) continue;
        const passedPlan = nearestTime(passed.departureTime ?? passed.arrivalTime, passed.isMidnight, passedAt);
        if (!passedPlan) continue;
        const targetPlan = nearestTime(target.arrivalTime ?? target.departureTime, target.isMidnight, passedPlan);
        if (!targetPlan) continue;
        if (target.index <= passed.index) { gone.push(targetPlan); continue; }
        // Toei buses do not run ahead of the timetable, and a delay of hours means a stale match.
        const delay = Math.max(0, passedAt - passedPlan);
        if (delay >= 2 * 3600_000) continue;
        predicted.push({
            expectedAt: new Date(Math.max(targetPlan.getTime() + delay, now.getTime())),
            scheduledAt: targetPlan,
            isRealtime: true,
            tripId: trip.sameAs.split('.').pop(),
            vehicleLocation: null,
        });
    }
    return { predicted, gone };
}

/** GTFS-RT trip ids begin with the ODPT pattern number and direction: pattern `…To07.60101.1` runs trips `60101-1-…`. */
function tripPrefix(pattern) {
    const parts = pattern.split('.');
    return parts.length >= 2 ? `${parts[parts.length - 2]}-${parts[parts.length - 1]}-` : pattern;
}

// ---------------------------------------------------------------------------------------------

/** @type {import('../model.js').TransitProvider} */
export default {
    id: 'odpt-toei',
    displayName: 'Toei Bus (Tokyo)',
    /** Cached lines and patterns carry names, so each language is its own dataset. */
    get datasetID() { return `odpt-toei.${language()}`; },
    get attribution() {
        return language() === 'ja'
            ? '東京都交通局・公共交通オープンデータ協議会 (CC BY 4.0)'
            : 'Bureau of Transportation, Tokyo Metropolitan Government / Association for Open Data of Public Transportation (CC BY 4.0)';
    },
    capabilities: new Set([
        Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
        Capability.vehiclePositions, Capability.realtimeArrivals, Capability.scheduledArrivals, Capability.nearbyStops,
    ]),
    /** Both `odpt:Bus` and the GTFS-RT feed are regenerated every 30 s (`odpt:frequency`). */
    refreshSeconds: 30,
    reportsShadowTrips: false,

    /**
     * ODPT only matches exact titles, so search runs over the full pole list, kept for a day.
     * A number finds every pole of that stop ("442"); a pole code ("KinshichoStation.442.2") itself.
     */
    async searchStops(query) {
        const text = String(query ?? '').trim();
        if (!text) return [];
        const index = await poleIndex();
        const lang = language();
        const exact = index.get(POLE_PREFIX + text);
        if (exact) return [poleStop(exact, lang, true)];
        if (/^[0-9]+$/.test(text)) {
            const number = Number.parseInt(text, 10);
            const hits = [...index.values()].filter((p) => stopNumber(p) === number);
            if (hits.length) return hits.map((p) => poleStop(p, lang, true)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        }
        // Case, accents and full-/half-width folded away; kana keep their voicing marks.
        const fold = (s) => s.normalize('NFKC').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
        const needle = fold(text);
        const words = needle.split(/\s+/).filter(Boolean);
        const ranked = [];
        for (const pole of index.values()) {
            const names = [pole.ja, pole.en, pole.kana].filter(Boolean).map(fold);
            const name = names.find((n) => words.every((w) => n.includes(w)));
            if (name === undefined) continue;
            ranked.push([pole, name === needle ? 0 : name.startsWith(needle) ? 1 : 2]);
        }
        return ranked
            .sort((a, b) => a[1] - b[1] || (a[0].sameAs < b[0].sameAs ? -1 : a[0].sameAs > b[0].sameAs ? 1 : 0))
            .slice(0, 40)
            .map(([pole]) => poleStop(pole, lang, true));
    },

    async linesAtStop(stop) {
        const [pole] = await poles([POLE_PREFIX + stop.code]);
        if (!pole) throw new TransitError('notFound', `stop ${stop.code}`);
        return (await servingLines([pole])).get(pole.sameAs) ?? [];
    },

    /** `places/odpt:BusstopPole` is a true radius query; lines come from the patterns it lists. */
    async stopsNearby(point, radiusMeters) {
        const found = (await get('/places/odpt:BusstopPole', {
            lat: String(point.lat), lon: String(point.lon), radius: String(Math.trunc(Math.min(radiusMeters, 4_000))),
        })).map(toPole);
        const nearest = found
            .filter((p) => location(p) && p.sameAs.startsWith(POLE_PREFIX))
            .map((p) => ({ pole: p, distance: meters(point, location(p)) }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 15);
        const lines = await servingLines(nearest.map((n) => n.pole));
        const lang = language();
        return nearest
            .filter((n) => lines.get(n.pole.sameAs)?.length)
            .map((n) => ({ stop: poleStop(n.pole, lang, true), distanceMeters: n.distance, lines: lines.get(n.pole.sameAs) }));
    },

    async routePattern(line) {
        const [pattern] = await patterns([line.id]);
        if (!pattern) throw new TransitError('notFound', `pattern ${line.id}`);
        const order = [...pattern.stops].sort((a, b) => a.index - b.index);
        const byID = new Map((await poles(order.map((s) => s.pole))).map((p) => [p.sameAs, p]));
        const lang = language();
        const stops = order
            .map((entry) => {
                const pole = byID.get(entry.pole);
                return pole && location(pole) ? { stop: poleStop(pole, lang, false), sequence: entry.index, distanceAlongRoute: null } : null;
            })
            .filter(Boolean);
        if (stops.length < 2) throw new TransitError('notFound', `stops for pattern ${line.id}`);
        return { line, stops };
    },

    async vehicles(line) {
        const prefixes = lineRef(line).patterns.map(tripPrefix);
        const data = await getBytes(`${BASE}/gtfs/realtime/ToeiBus`);
        return gtfsVehicles(data)
            .filter((v) => prefixes.some((prefix) => v.tripId.startsWith(prefix)))
            .map((v) => ({
                location: { lat: v.lat, lon: v.lon },
                recordedAt: v.timestamp != null ? new Date(v.timestamp * 1000) : null,
                distanceAlongRoute: null,
                tripId: v.tripId,
                plateNumber: v.label,
                bearing: v.bearing,
            }));
    },

    /**
     * The stop timetable for the day, with the trips already on the road re-timed by how late
     * they passed their last stop. Trips that have already passed the rider are dropped.
     */
    async arrivals(line, stop) {
        const ref = lineRef(line);
        const pole = POLE_PREFIX + stop.code;
        const now = new Date();
        const [plan, { predicted, gone }] = await Promise.all([scheduledTimes(ref, pole, now), liveArrivals(ref, pole, now)]);

        const covered = [...predicted.map((a) => a.scheduledAt).filter(Boolean), ...gone];
        const timetable = plan
            .filter((time) => time >= now && !covered.some((c) => Math.abs(c - time) < 30_000))
            .map((time) => ({ expectedAt: time, scheduledAt: time, isRealtime: false, tripId: null, vehicleLocation: null }));
        return [...predicted, ...timetable]
            .filter((a) => a.expectedAt.getTime() >= now.getTime() - 60_000)
            .sort((a, b) => a.expectedAt - b.expectedAt)
            .slice(0, 12);
    },
};

// ---------------------------------------------------------------------------------------------
// GTFS-Realtime: just the VehiclePosition fields used here.

/**
 * FeedMessage.entity(2) → FeedEntity.vehicle(4) → VehiclePosition { trip(1){trip_id(1)},
 * position(2){latitude(1), longitude(2), bearing(3)}, timestamp(5), vehicle(8).label(2) }.
 */
function gtfsVehicles(bytes) {
    const decoder = new TextDecoder();
    const result = [];
    eachField(bytes, (field, type, value) => {
        if (field !== 2 || type !== 2) return;
        eachField(value, (f, t, body) => {
            if (f !== 4 || t !== 2) return;
            const v = { tripId: '', lat: 0, lon: 0, bearing: null, timestamp: null, label: null };
            eachField(body, (f2, t2, x) => {
                if (f2 === 1 && t2 === 2) {
                    eachField(x, (f3, t3, y) => { if (f3 === 1 && t3 === 2) v.tripId = decoder.decode(y); });
                } else if (f2 === 2 && t2 === 2) {
                    eachField(x, (f3, t3, y) => {
                        if (t3 !== 5) return;
                        const number = new DataView(y.buffer, y.byteOffset, 4).getFloat32(0, true);
                        if (f3 === 1) v.lat = number;
                        else if (f3 === 2) v.lon = number;
                        else if (f3 === 3) v.bearing = number;
                    });
                } else if (f2 === 5 && t2 === 0) {
                    v.timestamp = x;
                } else if (f2 === 8 && t2 === 2) {
                    eachField(x, (f3, t3, y) => { if (f3 === 2 && t3 === 2) v.label = decoder.decode(y); });
                }
            });
            if (v.tripId && v.lat !== 0 && v.lon !== 0) result.push(v);
        });
    });
    return result;
}

/** Visits each field of a protobuf message: (field number, wire type, number | Uint8Array). */
function eachField(bytes, visit) {
    let i = 0;
    const varint = () => {
        let result = 0;
        let scale = 1;
        for (let n = 0; n < 10; n++) {
            if (i >= bytes.length) throw new TransitError('badResponse', 'truncated protobuf varint');
            const byte = bytes[i++];
            result += (byte & 0x7f) * scale;
            if (byte < 0x80) return result;
            scale *= 128;
        }
        throw new TransitError('badResponse', 'protobuf varint too long');
    };
    const take = (count) => {
        if (count < 0 || i + count > bytes.length) throw new TransitError('badResponse', 'truncated protobuf field');
        const slice = bytes.subarray(i, i + count);
        i += count;
        return slice;
    };
    while (i < bytes.length) {
        const key = varint();
        const field = Math.floor(key / 8);
        const type = key % 8;
        switch (type) {
            case 0: visit(field, 0, varint()); break;
            case 1: visit(field, 1, take(8)); break;
            case 2: visit(field, 2, take(varint())); break;
            case 5: visit(field, 5, take(4)); break;
            default: throw new TransitError('badResponse', `unsupported protobuf wire type ${type}`);
        }
    }
}
