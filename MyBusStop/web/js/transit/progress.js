// Combines a route pattern, vehicle positions and arrivals into where each bus is relative to the
// rider's stop. Port of BusBus/Transit/Progress/BusProgressService.swift.

import { Capability, TransitError } from './model.js';

export const AT_STOP_TOLERANCE = 40;
export const LIMITS = {
    /** Buses farther than this from the stop-to-stop polyline are ignored. */
    maxOffRouteMeters: 400,
    /** Within this of the origin the bus hasn't left yet; within this of the end it has finished. */
    terminalToleranceMeters: 50,
    /** Fixes this much older than the newest one belong to rides that already ended. */
    staleAfterMs: 3 * 60_000,
};

/** Two live trips this close in place and time are one bus the feed carries twice. */
const SHADOW_TRIP_METERS = 300;
const SHADOW_TRIP_MS = 3 * 60_000;

/**
 * @param {import('./model.js').TransitProvider} provider
 * @param {import('./geometry.js').RouteGeometry} geometry
 */
export async function busProgress(provider, geometry, line, stop) {
    const targetIndex = geometry.pattern.stops.findIndex((s) => s.stop.code === stop.code);
    if (targetIndex < 0) throw new TransitError('notFound', `stop ${stop.code} on line ${line.shortName}`);
    const targetDistance = geometry.stopDistances[targetIndex];

    const [vehiclesResult, arrivalsResult] = await Promise.allSettled([
        provider.capabilities.has(Capability.vehiclePositions) ? provider.vehicles(line) : Promise.resolve([]),
        provider.arrivals(line, stop),
    ]);
    let vehicles = vehiclesResult.status === 'fulfilled' ? vehiclesResult.value : [];
    const arrivals = arrivalsResult.status === 'fulfilled' ? arrivalsResult.value : [];
    // Either half on its own still says something true; nothing at all does not.
    if (arrivalsResult.status === 'rejected' && vehiclesResult.status === 'rejected') throw arrivalsResult.reason;

    // Providers that only attach the bus to its prediction still give us one position.
    if (!vehicles.length) {
        const attached = arrivals.find((a) => a.isRealtime && a.vehicleLocation)?.vehicleLocation;
        if (attached) vehicles = [{ location: attached }];
    }

    const newest = Math.max(-Infinity, ...vehicles.map((v) => v.recordedAt?.getTime() ?? -Infinity));
    let buses = vehicles.flatMap((vehicle) => {
        const at = vehicle.recordedAt?.getTime();
        if (at != null && Number.isFinite(newest) && newest - at > LIMITS.staleAfterMs) return [];
        let distance, offRoute;
        if (vehicle.distanceAlongRoute != null) {
            [distance, offRoute] = [vehicle.distanceAlongRoute, 0];
        } else {
            const snapped = geometry.project(vehicle.location);
            if (!snapped) return [];
            [distance, offRoute] = [snapped.distanceAlong, snapped.offRoute];
        }
        if (offRoute > LIMITS.maxOffRouteMeters
            || distance <= LIMITS.terminalToleranceMeters
            || distance >= geometry.totalLength - LIMITS.terminalToleranceMeters) return [];
        return [{ id: '', vehicle, distanceAlongRoute: distance, offRoute, isNext: false }];
    }).sort((a, b) => a.distanceAlongRoute - b.distanceAlongRoute);

    let upcoming = arrivals.filter((a) => a.expectedAt.getTime() > Date.now() - 60_000);
    if (provider.reportsShadowTrips) {
        ({ arrivals: upcoming, buses } = mergingShadowTrips(upcoming, buses, (p) => geometry.project(p)?.distanceAlong ?? null));
    }
    buses.forEach((bus, i) => { bus.id = bus.vehicle.plateNumber ?? bus.vehicle.tripId ?? `bus-${buses.length - i}`; });
    // The next bus is the one closest to the stop that hasn't passed it.
    for (let i = buses.length - 1; i >= 0; i--) {
        if (buses[i].distanceAlongRoute <= targetDistance + AT_STOP_TOLERANCE) { buses[i].isNext = true; break; }
    }

    return {
        targetStopIndex: targetIndex,
        targetDistance,
        routeLength: geometry.totalLength,
        buses,
        arrivals: upcoming,
        arrivalsError: arrivalsResult.status === 'rejected' ? describe(arrivalsResult.reason) : null,
        vehiclesError: vehiclesResult.status === 'rejected' ? describe(vehiclesResult.reason) : null,
    };
}

/**
 * Folds one bus carried under two trips back into one: of two live predictions whose buses sit
 * within SHADOW_TRIP_METERS along the route and are due within SHADOW_TRIP_MS of each other, the
 * earlier is kept, and the drawn bus at the later one's position goes with it.
 */
export function mergingShadowTrips(arrivals, buses, along) {
    const kept = [];
    const dropped = [];
    const result = [];
    for (const arrival of [...arrivals].sort((a, b) => a.expectedAt - b.expectedAt)) {
        const position = arrival.isRealtime && arrival.vehicleLocation ? along(arrival.vehicleLocation) : null;
        if (position == null) { result.push(arrival); continue; }
        const twin = kept.find((k) => Math.abs(k.along - position) <= SHADOW_TRIP_METERS
            && arrival.expectedAt - k.arrival.expectedAt <= SHADOW_TRIP_MS);
        if (twin) { dropped.push({ kept: twin.along, shadow: position }); continue; }
        kept.push({ arrival, along: position });
        result.push(arrival);
    }
    const remaining = [...buses];
    for (const pair of dropped) {
        if (remaining.length <= 1) continue;
        const nearest = (target, skip) => remaining.reduce((best, bus, i) => (i === skip ? best
            : best < 0 || Math.abs(bus.distanceAlongRoute - target) < Math.abs(remaining[best].distanceAlongRoute - target) ? i : best), -1);
        const real = nearest(pair.kept, -1);
        const shadow = nearest(pair.shadow, real);
        if (shadow < 0
            || Math.abs(remaining[shadow].distanceAlongRoute - pair.shadow) > SHADOW_TRIP_METERS
            || Math.abs(remaining[shadow].distanceAlongRoute - remaining[real].distanceAlongRoute) > SHADOW_TRIP_METERS) continue;
        remaining.splice(shadow, 1);
    }
    return { arrivals: result, buses: remaining };
}

export const describe = (error) => error?.message ?? String(error);
