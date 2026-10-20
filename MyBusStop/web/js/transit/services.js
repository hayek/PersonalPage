// Lines without a number that a rider cannot tell apart, made one service (model.js `mergeServices`)
// for every provider alike. Wraps a provider so nothing above it needs to know: the stop's lines come
// merged, and a service's pattern, shape and positions are its representative member's.
//
// A service's arrivals are its members' together. A provider whose per-line calls each cost a
// request (bus.gov.il) times them itself in `serviceArrivals(service, stop, members)`; otherwise each
// member is asked in turn, which is free where one cached request per stop serves every line
// (Transitous).
//
// Members change with the timetable (a feed that lists each train run as a route renumbers them), so
// a board's services are brought up to date from the stop's lines before each poll: from a copy kept
// `servicesLifetimeMs` (6 hours by default, across visits; Transitous, whose lines are its departures in the next
// 90 minutes, keeps them as long as those). A board saved before the change keeps its service's id.

import { isService, mergeServices, serviceMemberIDs, serviceRepresentative } from './model.js';
import { memo, staticData } from './http.js';

const MEMBERS_LIFETIME_MS = 6 * 3_600_000;

/** @param {import('./model.js').TransitProvider} provider */
export function withServices(provider) {
    if (provider.withServices) return provider;
    const wrapped = Object.create(provider);
    /** The latest members of each service, as the provider's own lines (not kept in storage). */
    const known = new Map();

    const remember = (lines, all) => {
        for (const line of lines) {
            if (!isService(line)) continue;
            const ids = new Set(serviceMemberIDs(line));
            known.set(line.id, all.filter((l) => ids.has(l.id)));
        }
        return lines;
    };

    const members = (service) => {
        const ids = serviceMemberIDs(service);
        const kept = known.get(service.id);
        if (kept && kept.length === ids.length && kept.every((l, i) => l.id === ids[i])) return kept;
        // Only the ids survive a reload: each member is the representative's refs under its own id.
        const base = serviceRepresentative(service);
        return ids.map((id) => ({ ...base, id }));
    };

    Object.assign(wrapped, {
        withServices: true,

        async linesAtStop(stop) {
            const all = await provider.linesAtStop(stop);
            return remember(mergeServices(all), all);
        },

        /**
         * The board's lines with each service's members as the stop lists them now. A service the
         * stop no longer lists (none of it runs soon) keeps the members it had.
         */
        async refreshServices(lines, stop) {
            if (!lines.some(isService)) return lines;
            const key = `services:${provider.datasetID ?? provider.id}:${stop.code}`;
            const lifetime = provider.servicesLifetimeMs ?? MEMBERS_LIFETIME_MS;
            // A lifetime of hours outlives the page, so it is kept across visits; one of seconds is not.
            const keep = lifetime >= 60_000 ? staticData : memo;
            const current = await keep(key, lifetime, () => wrapped.linesAtStop(stop)).catch(() => null);
            if (!current) return lines;
            return lines.map((line) => (isService(line) ? current.find((l) => l.id === line.id) ?? line : line));
        },

        routePattern(line) {
            if (!isService(line)) return provider.routePattern(line);
            return provider.routePattern(serviceRepresentative(line)).then((pattern) => ({ ...pattern, line }));
        },

        /** A position belongs to one run; with many runs in a service, there is no telling which. */
        vehicles(line) {
            if (!isService(line)) return provider.vehicles(line);
            return serviceMemberIDs(line).length === 1 ? provider.vehicles(serviceRepresentative(line)) : Promise.resolve([]);
        },

        async arrivals(line, stop) {
            if (!isService(line)) return provider.arrivals(line, stop);
            const all = members(line);
            if (provider.serviceArrivals) return provider.serviceArrivals(line, stop, all);
            const each = await Promise.allSettled(all.map((member) => provider.arrivals(member, stop)));
            const found = each.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
            if (!found.length && each.length && each.every((r) => r.status === 'rejected')) throw each[0].reason;
            return found.sort((a, b) => a.expectedAt - b.expectedAt);
        },
    });

    if (typeof provider.routeShape === 'function') {
        wrapped.routeShape = (line, pattern) => provider.routeShape(isService(line) ? serviceRepresentative(line) : line, pattern);
    }
    if (typeof provider.hasRouteShape === 'function') {
        wrapped.hasRouteShape = (line) => provider.hasRouteShape(isService(line) ? serviceRepresentative(line) : line);
    }
    if (typeof provider.stopsNearby === 'function') {
        // The nearby list's badges: one per service, as the stop's own list will show them.
        wrapped.stopsNearby = async (point, radius) => (await provider.stopsNearby(point, radius))
            .map((entry) => ({ ...entry, lines: mergeServices(entry.lines ?? []) }));
    }
    return wrapped;
}
