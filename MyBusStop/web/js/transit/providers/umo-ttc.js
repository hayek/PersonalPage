// Umo IQ's "retro" NextBus public feed (retro.umoiq.com/service/publicJSONFeed) — the legacy NextBus
// XML feed served as JSON. Keyless, one host for every agency still on it (`agencyList`: TTC Toronto
// plus ~16 small US agencies), so the adapter is parametrised by agency tag; only the TTC is wired
// up. The feed sends `Access-Control-Allow-Origin: *`.
//
// It is an unsupported legacy feed: Umo "reserves the right to terminate … at any time". The feed
// document (rev 1.24) caps each IP at ~2 MB per 20 s and asks for polls no faster than every 10 s;
// predictions stop at five per direction.
//
// Shape of the data:
// - A route has one stop list (`stop[]`, with the public `stopId` riders see on the pole) and many
//   directions: one "useForUI" direction per way plus short-turn/garage variants, all carrying a
//   `name` ("North", "South"). A line here is one route in one named way; vehicles and predictions
//   come tagged with whichever variant they run (`29_0_29A`), so they are matched by the way's name,
//   not by tag. `terse=true&verbose=true` returns every variant without the path geometry.
// - There is no stop search and no proximity query. A number is looked up as a public stop id; a
//   name is matched against route titles (TTC routes are named after their streets) and then against
//   the stops of the few routes that match.
// - JSON is a mechanical XML translation: every value is a string, and any element that occurs once
//   is an object instead of a one-element array.
// Port of BusBus/Transit/Providers/UmoNextBusProvider.swift.

import { Capability, TransitError, fold, makeLine } from '../model.js';
import { getJSON, staticData } from '../http.js';

const BASE = 'https://retro.umoiq.com/service/publicJSONFeed';
const DAY = 86_400_000;
/** Route configs fetched to answer a name search (~18 KB each). */
const MAX_ROUTES_PER_SEARCH = 6;
/** Stops the feed gives no public id (terminal arrival points like "14316_ar") are addressed by tag. */
const TAG_PREFIX = 'tag:';

const TTC = {
    tag: 'ttc',
    displayName: 'TTC (Toronto)',
    shortName: 'TTC',
    // Whose copyright the feed's notice names ("All data copyright … <year>.").
    copyrightHolder: 'Toronto Transit Commission',
    timeZone: 'America/Toronto',
};

/** One agency on the feed. Each is a separate provider (and dataset) of its own. */
export function umoNextBusProvider(agency) {
    // Route configs already in hand, so a search also finds stops on routes the rider looked at before.
    const loaded = new Map();

    async function feed(query) {
        const response = await getJSON(BASE, { query: { ...query, a: agency.tag } });
        return response ?? {};
    }

    /**
     * Route configs, kept a day (they change with board periods, a few times a year). A TTC route
     * config is 10–25 KB; a full search touches at most six of them.
     */
    async function config(route) {
        const value = await staticData(`umo-${agency.tag}.route.${route}`, DAY, async () => {
            const response = await feed({ command: 'routeConfig', r: route, terse: 'true', verbose: 'true' });
            const raw = response.route;
            if (!raw || Array.isArray(raw) || raw.stop === undefined) {
                throw new TransitError('notFound', `route ${route}: ${feedError(response) ?? 'no config'}`);
            }
            return raw;
        });
        const parsed = loaded.get(route) ?? new Route(value);
        loaded.set(route, parsed);
        return parsed;
    }

    function routeList() {
        return staticData(`umo-${agency.tag}.routeList`, DAY, async () => {
            const response = await feed({ command: 'routeList' });
            const error = feedError(response);
            if (error && response.route === undefined) throw new TransitError('badResponse', error);
            return many(response.route).map((r) => ({ tag: r.tag, title: r.title }));
        });
    }

    /**
     * A public stop id, resolved through `predictions` (which names the routes and the stop tag) and
     * the first route's config (which has the coordinates).
     */
    async function stopByPublicID(publicID) {
        const response = await feed({ command: 'predictions', stopId: publicID });
        const first = many(response.predictions)[0];
        if (feedError(response) || !first) return null;
        const route = await config(first.routeTag);
        return route.publicStops().find((s) => s.code === publicID) ?? null;
    }

    function lineOf(route, direction) {
        const stops = route.stopsByTag;
        const tags = many(direction.stop);
        return makeLine({
            id: `${route.tag}|${direction.tag}`,
            shortName: route.tag,
            headsign: headsign(direction),
            agency: agency.shortName,
            origin: tags.length ? stops.get(tags[0].tag)?.title ?? null : null,
            destination: tags.length ? stops.get(tags[tags.length - 1].tag)?.title ?? null : null,
            providerRefs: { route: route.tag, direction: direction.tag, way: way(direction) },
        });
    }

    return {
        id: `umo-${agency.tag}`,
        displayName: agency.displayName,
        capabilities: new Set([
            Capability.stopSearchByName, Capability.stopSearchByCode, Capability.linesAtStop, Capability.routePattern,
            Capability.vehiclePositions, Capability.realtimeArrivals,
        ]),
        // Upstream refreshes every ~10 s; a board poll is two small calls (≈3 KB), far inside the budget.
        refreshSeconds: 20,
        datasetID: `umo-${agency.tag}`,
        reportsShadowTrips: false,

        // The feed's licence asks that its copyright notice be kept; this is the notice it sends.
        get attribution() {
            const year = new Intl.DateTimeFormat('en-US', { timeZone: agency.timeZone, year: 'numeric' }).format(new Date());
            return `All data copyright ${agency.copyrightHolder} ${year}.`;
        },

        async searchStops(query) {
            query = String(query ?? '').trim();
            if (!query) return [];
            if (/^\d+$/.test(query)) {
                const stop = await stopByPublicID(query);
                if (stop) return [stop];
                // Not a stop number: a route number lists that route's stops.
                const routes = await routeList();
                if (!routes.some((r) => r.tag === query)) return [];
                return (await config(query)).publicStops();
            }
            // Routes are ranked by the query words in their title, a word counting less the more
            // titles share it ("st", "west" hardly narrow anything; "king" does).
            const words = [...new Set(fold(query).split(' ').filter(Boolean))];
            const routes = (await routeList()).map((r) => ({ tag: r.tag, title: fold(r.title) }));
            const weight = new Map(words.map((word) => [word, 1 / Math.max(routes.filter((r) => r.title.includes(word)).length, 1)]));
            const ranked = routes
                .map((r) => ({ tag: r.tag, score: words.filter((w) => r.title.includes(w)).reduce((sum, w) => sum + weight.get(w), 0) }))
                .filter((r) => r.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, MAX_ROUTES_PER_SEARCH)
                .map((r) => r.tag);
            const configs = await Promise.all(ranked.map((tag) => config(tag)));
            const seen = new Set();
            const candidates = [...configs, ...loaded.values()]
                .flatMap((route) => route.publicStops())
                .filter((s) => !seen.has(s.code) && seen.add(s.code));
            return match(query, candidates);
        },

        async linesAtStop(stop) {
            // Which routes serve the stop, and the stop's tag on each.
            let served;
            const tag = tagOnly(stop.code);
            if (tag !== null) {
                served = [...loaded.values()]
                    .filter((route) => route.stops.some((s) => s.tag === tag))
                    .map((route) => ({ route: route.tag, stopTag: tag }));
            } else {
                const response = await feed({ command: 'predictions', stopId: stop.code });
                const error = feedError(response);
                if (error) throw new TransitError('notFound', `stop ${stop.code}: ${error}`);
                served = many(response.predictions).map((p) => ({ route: p.routeTag, stopTag: p.stopTag }));
            }
            const seen = new Set();
            served = served.filter((s) => !seen.has(s.route) && seen.add(s.route));
            const configs = await Promise.all(served.map((s) => config(s.route)));
            return served.flatMap((s, index) => configs[index].ways(s.stopTag).map((direction) => lineOf(configs[index], direction)));
        },

        async routePattern(line) {
            const ref = refOf(line);
            const route = await config(ref.route);
            const direction = route.directions.find((d) => d.tag === ref.direction);
            if (!direction) throw new TransitError('notFound', `direction ${ref.direction} of route ${ref.route}`);
            const stops = route.stopsByTag;
            const pattern = many(direction.stop).map((s) => transitStop(stops.get(s.tag))).filter(Boolean);
            return { line, stops: pattern.map((stop, i) => ({ stop, sequence: i + 1, distanceAlongRoute: null })) };
        },

        async vehicles(line) {
            const ref = refOf(line);
            const [route, response] = await Promise.all([
                config(ref.route),
                feed({ command: 'vehicleLocations', r: ref.route, t: '0' }),
            ]);
            // A refusal (over the per-IP byte budget, feed down) is an HTTP 200 with only an `Error`;
            // read as a list it would say no bus is running.
            const error = feedError(response);
            if (error) throw new TransitError('badResponse', error);
            const variants = route.variants(ref.direction, ref.way);
            const lastTime = Number(response.lastTime?.time);
            const now = Number.isFinite(lastTime) ? lastTime : Date.now();
            return many(response.vehicle)
                .map((v) => {
                    const lat = Number(v.lat), lon = Number(v.lon);
                    if (!v.dirTag || !variants.has(v.dirTag) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
                    const heading = v.heading != null ? Number(v.heading) : NaN;
                    const age = v.secsSinceReport != null ? Number(v.secsSinceReport) : NaN;
                    return {
                        location: { lat, lon },
                        recordedAt: Number.isFinite(age) ? new Date(now - age * 1000) : null,
                        plateNumber: v.id ?? null,
                        bearing: Number.isFinite(heading) && heading >= 0 ? heading : null, // -4 means "unknown"
                    };
                })
                .filter(Boolean);
        },

        // Predictions are GPS-based unless flagged `isScheduleBased`; the feed has no timetable time to
        // put next to them.
        async arrivals(line, stop) {
            const ref = refOf(line);
            const tag = tagOnly(stop.code);
            const query = tag !== null
                ? { command: 'predictions', r: ref.route, s: tag }
                : { command: 'predictions', stopId: stop.code, routeTag: ref.route };
            const [route, response] = await Promise.all([config(ref.route), feed(query)]);
            const error = feedError(response);
            if (error) throw new TransitError('badResponse', error);
            const variants = route.variants(ref.direction, ref.way);
            return many(response.predictions)
                .filter((p) => p.routeTag === ref.route)
                .flatMap((p) => many(p.direction))
                .flatMap((d) => many(d.prediction))
                .map((p) => {
                    const epoch = Number(p.epochTime);
                    if (!variants.has(p.dirTag ?? ref.direction) || !Number.isFinite(epoch)) return null;
                    return {
                        expectedAt: new Date(epoch),
                        scheduledAt: null,
                        isRealtime: p.isScheduleBased !== 'true',
                        tripId: p.tripTag ?? null,
                    };
                })
                .filter(Boolean)
                .sort((a, b) => a.expectedAt - b.expectedAt);
        },
    };
}

export default umoNextBusProvider(TTC);

// ---------------------------------------------------------------------------------------------
// Wire format helpers

/** An XML element that may occur once (an object) or many times (an array). */
function many(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

/** One `Error` is an object; several (a bad agency repeats it) an array. */
function feedError(response) {
    const first = many(response?.Error)[0];
    if (!first) return null;
    return (typeof first === 'string' ? first : first.content)?.trim() || 'feed error';
}

class Route {
    constructor(raw) {
        this.tag = raw.tag;
        this.title = raw.title;
        this.stops = many(raw.stop);
        this.directions = many(raw.direction);
        this.stopsByTag = new Map();
        for (const s of this.stops) if (!this.stopsByTag.has(s.tag)) this.stopsByTag.set(s.tag, s);
    }

    /** Stops a rider can look up: the ones with a public number. */
    publicStops() {
        return this.stops.filter((s) => s.stopId != null).map(transitStop).filter(Boolean);
    }

    /**
     * One direction per way ("North", "South") that stops at the tag: the UI direction when it does,
     * else the longest variant that does (a stop only a branch serves).
     */
    ways(stopTag) {
        const order = [];
        const best = new Map();
        for (const direction of this.directions) {
            if (!many(direction.stop).some((s) => s.tag === stopTag)) continue;
            const w = way(direction);
            const current = best.get(w);
            if (!current) {
                order.push(w);
                best.set(w, direction);
                continue;
            }
            const better = isUI(direction) !== isUI(current)
                ? isUI(direction)
                : many(direction.stop).length > many(current.stop).length;
            if (better) best.set(w, direction);
        }
        return order.map((w) => best.get(w));
    }

    /**
     * Every direction tag running the same way as the line's, which is what vehicles and predictions
     * are tagged with.
     */
    variants(tag, wayName) {
        const w = wayName || (this.directions.find((d) => d.tag === tag) ? way(this.directions.find((d) => d.tag === tag)) : tag);
        return new Set([...this.directions.filter((d) => way(d) === w).map((d) => d.tag), tag]);
    }
}

function transitStop(raw) {
    if (!raw) return null;
    const lat = Number(raw.lat), lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { code: raw.stopId ?? TAG_PREFIX + raw.tag, name: raw.title, city: null, location: { lat, lon } };
}

function isUI(direction) {
    return direction.useForUI === 'true';
}

/** The way it runs; agencies that leave `name` empty get one way per direction tag. */
function way(direction) {
    return direction.name ? direction.name : direction.tag;
}

/** "South - 29c Dufferin towards Exhibition (Princes' Gates)" → "Exhibition (Princes' Gates)". */
function headsign(direction) {
    const title = String(direction.title ?? '');
    const at = title.indexOf(' towards ');
    return at < 0 ? title : title.slice(at + ' towards '.length);
}

function tagOnly(code) {
    return String(code).startsWith(TAG_PREFIX) ? String(code).slice(TAG_PREFIX.length) : null;
}

function refOf(line) {
    const id = String(line.id);
    const bar = id.indexOf('|');
    const parts = bar < 0 ? [id] : [id.slice(0, bar), id.slice(bar + 1)];
    return {
        route: line.providerRefs?.route ?? parts[0] ?? line.shortName,
        direction: line.providerRefs?.direction ?? parts[1] ?? '',
        way: line.providerRefs?.way ?? '',
    };
}

/** Every query word appears in the stop name; exact and prefix matches first. */
function match(query, stops, limit = 40) {
    const needle = fold(query);
    const words = needle.split(' ').filter(Boolean);
    if (!words.length) return [];
    return stops
        .map((stop) => {
            const name = fold(stop.name);
            if (!words.every((w) => name.includes(w))) return null;
            return { stop, rank: name === needle ? 0 : name.startsWith(needle) ? 1 : 2 };
        })
        .filter(Boolean)
        .sort((a, b) => a.rank - b.rank || (a.stop.name < b.stop.name ? -1 : a.stop.name > b.stop.name ? 1 : 0))
        .map((m) => m.stop)
        .slice(0, limit);
}
