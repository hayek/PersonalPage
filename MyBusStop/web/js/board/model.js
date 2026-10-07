// Owns the board's data: polls the provider, turns what comes back into arrivals and buses the
// view can draw, picks the trunk, and keeps the last good answer so the board never blanks.
// Port of BusBus/Board/BoardViewModel.swift, minus the parts only a device has (widgets, network
// monitor, telemetry).

import { RouteGeometry } from '../transit/geometry.js';
import { AT_STOP_TOLERANCE, LIMITS, busProgress, describe } from '../transit/progress.js';
import { staticData } from '../transit/http.js';
import { createTrunkSelector } from '../map/index.js';

/** Without a successful fetch for this long the LIVE indicator admits it is stale. */
export const STALE_AFTER_MS = 90_000;
const QUICK_RETRY_MS = 5_000;
const MAX_QUICK_RETRIES = 3;

/** A prediction's bus and a drawn bus are the same one when they sit this close along the route. */
const PREDICTION_MATCH_METERS = 500;
/** How far ahead of a prediction's position its bus may already be: that position trails the bus. */
const PREDICTION_LAG_METERS = 1_000;
/** City traffic, stops included (about 14 km/h), when no realtime prediction gives a pace to borrow. */
const FALLBACK_BUS_SPEED = 4;
const PLAUSIBLE_SPEEDS = [2, 15];
/** A timetable slot due this long after a drawn bus's estimate is still that bus, running early. */
const EARLY_RUNNING_ALLOWANCE_MS = 5 * 60_000;

/** Patterns change with the timetable, not by the minute; a day is short enough to pick up changes. */
const PATTERN_MAX_AGE_MS = 12 * 3_600_000;

export class BoardModel {
    /**
     * @param {import('../transit/model.js').TransitProvider} provider
     * @param {{stop: import('../transit/model.js').TransitStop, lines: import('../transit/model.js').TransitLine[]}} configuration
     * @param {() => void} onChange
     */
    constructor(provider, configuration, onChange) {
        this.provider = provider;
        this.configuration = configuration;
        this.onChange = onChange;
        this.snapshot = { fetchedAt: null, arrivals: [], buses: [], patterns: {} };
        this.lastSuccessAt = null;
        this.lastError = null;
        this.selectedBusID = null;
        this.trunk = createTrunkSelector();
        this.trunkLineID = configuration.lines[0]?.id ?? null;
        this.stopChangeTimes = new Map();
        this.consecutiveFailures = 0;
        this.incompleteRefreshes = 0;
        this.timer = null;
        this.inFlight = null;
        this.running = false;
    }

    get stop() { return this.configuration.stop; }
    get lines() { return this.configuration.lines; }
    line(id) { return this.lines.find((l) => l.id === id) ?? null; }

    liveState(now = Date.now()) {
        if (!this.lastSuccessAt) return 'connecting';
        return now - this.lastSuccessAt > STALE_AFTER_MS ? 'stale' : 'live';
    }

    /** The arrival the big readout shows: the tapped bus's, else the next one. */
    get primary() {
        const arrivals = this.snapshot.arrivals;
        if (this.selectedBusID) {
            const selected = arrivals.find((a) => a.bus?.id === this.selectedBusID);
            if (selected) return { arrival: selected, line: this.line(selected.lineID), kicker: 'SELECTED BUS' };
        }
        const next = arrivals[0];
        return next ? { arrival: next, line: this.line(next.lineID), kicker: 'NEXT ARRIVAL' } : null;
    }

    get secondary() {
        const primary = this.primary;
        if (!primary) return null;
        const next = this.snapshot.arrivals.find((a) => a.id !== primary.arrival.id && a.expectedAt >= primary.arrival.expectedAt);
        return next ? { arrival: next, line: this.line(next.lineID) } : null;
    }

    /** The puck that carries the white ring: the only thing tying the map to the numbers. */
    get ringedBusID() { return this.primary?.arrival.bus?.id ?? null; }

    get isAwaitingFirstBoard() { return !this.primary && !this.lastSuccessAt && !this.lastError; }

    tap(busID) {
        this.selectedBusID = this.selectedBusID === busID ? null : busID;
        this.onChange();
    }

    dismissTapped() {
        if (!this.selectedBusID) return;
        this.selectedBusID = null;
        this.onChange();
    }

    promoteTrunk(lineID) {
        this.trunk.manualTrunkID = lineID;
        this.trunkLineID = this.trunk.select(this.snapshot.arrivals[0]?.lineID ?? null, new Date());
        this.onChange();
    }

    // MARK: Polling

    async start() {
        if (this.running) return;
        this.running = true;
        await this.showCachedRoutes();
        this.loop();
    }

    stopPolling() {
        this.running = false;
        clearTimeout(this.timer);
        this.timer = null;
    }

    async loop() {
        if (!this.running) return;
        await this.refresh();
        if (!this.running) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.loop(), this.nextInterval());
    }

    /** Coming back to the tab: refresh at once rather than wait out the interval. */
    refreshNow() {
        if (!this.running) return;
        clearTimeout(this.timer);
        this.loop();
    }

    nextInterval() {
        if (this.consecutiveFailures > 0) return Math.min(60_000, 5_000 * 2 ** (this.consecutiveFailures - 1));
        if (this.incompleteRefreshes >= 1 && this.incompleteRefreshes <= MAX_QUICK_RETRIES) return QUICK_RETRY_MS;
        return this.provider.refreshSeconds * 1000;
    }

    patternKey(line) { return `pattern:${this.provider.datasetID ?? this.provider.id}:${line.id}`; }

    /** Puts the routes on screen before the first request goes out, when they are already known. */
    async showCachedRoutes() {
        const routes = {};
        for (const line of this.lines) {
            try {
                const cached = await peekStatic(this.patternKey(line));
                if (cached) routes[line.id] = trim(cached, this.stop);
            } catch { /* nothing cached */ }
        }
        if (Object.keys(routes).length && !Object.keys(this.snapshot.patterns).length) {
            this.snapshot = { ...this.snapshot, patterns: routes };
            this.onChange();
        }
    }

    refresh() {
        // A second caller joins the refresh under way rather than racing it.
        if (!this.inFlight) this.inFlight = this.load().finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    async load() {
        const { provider, stop } = this;
        const outcomes = await Promise.allSettled(this.lines.map(async (line) => {
            const pattern = await staticData(this.patternKey(line), PATTERN_MAX_AGE_MS, () => provider.routePattern(line));
            const progress = await busProgress(provider, new RouteGeometry(pattern), line, stop);
            return { lineID: line.id, pattern, progress };
        }));
        const results = outcomes.filter((o) => o.status === 'fulfilled').map((o) => o.value);
        const failures = outcomes.filter((o) => o.status === 'rejected').map((o) => o.reason);

        if (!results.length) {
            // Keep the last good board rather than blanking it; the LIVE dot tells the truth.
            this.consecutiveFailures += 1;
            this.lastError = failures[0] ? describe(failures[0]) : 'unknown';
            console.warn('[board] refresh failed', failures);
            this.onChange();
            return;
        }
        this.consecutiveFailures = 0;
        this.lastError = failures[0] ? describe(failures[0]) : results.find((r) => r.progress.arrivalsError)?.progress.arrivalsError ?? null;
        if (failures.length) console.warn('[board] some lines failed', failures);
        const complete = this.apply(results, new Date());
        this.incompleteRefreshes = complete ? 0 : this.incompleteRefreshes + 1;
        this.lastSuccessAt = Date.now();
        this.onChange();
    }

    /** Returns false when some line drew its buses but not their minutes, so the caller asks again soon. */
    apply(results, now) {
        let complete = true;
        const previousArrivals = this.snapshot.arrivals;
        const routes = { ...this.snapshot.patterns };
        const refreshed = new Set(results.map((r) => r.lineID));
        const retargeted = new Set();
        const buses = this.snapshot.buses.filter((b) => !refreshed.has(b.lineID));
        const arrivals = this.snapshot.arrivals.filter((a) => !refreshed.has(a.lineID));

        for (const result of results) {
            const trimmed = trim(result.pattern, this.stop);
            routes[result.lineID] = trimmed;
            const targetIndex = trimmed.stops.length - 1;
            const geometry = new RouteGeometry(trimmed);

            // Closest to the stop first: that is the order arrivals come in too, which is the only
            // link between a prediction and a position on a feed with no trip ids.
            const tracked = result.progress.buses
                .filter((b) => b.distanceAlongRoute <= result.progress.targetDistance + AT_STOP_TOLERANCE)
                .sort((a, b) => b.distanceAlongRoute - a.distanceAlongRoute);

            const lineBuses = tracked.map((bus, rank) => {
                const index = Math.min(geometry.lastStopIndex(bus.distanceAlongRoute), Math.max(0, targetIndex - 1));
                const from = geometry.stopDistances[index];
                const to = geometry.stopDistances[Math.min(index + 1, targetIndex)];
                const fraction = to > from ? (bus.distanceAlongRoute - from) / (to - from) : 0;
                const id = bus.vehicle.plateNumber ?? bus.vehicle.tripId ?? `${result.lineID}-rank${rank}`;

                const previous = this.stopChangeTimes.get(id);
                if (previous) {
                    if (previous.index > index) {
                        // A vehicle never runs backwards, so an id that does now names another bus.
                        this.stopChangeTimes.set(id, { index, changedAt: null });
                        retargeted.add(id);
                    } else if (previous.index < index) {
                        this.stopChangeTimes.set(id, { index, changedAt: now });
                    }
                } else {
                    this.stopChangeTimes.set(id, { index, changedAt: null });
                }
                const seen = this.stopChangeTimes.get(id);
                return {
                    id, lineID: result.lineID, lastStopIndex: index,
                    progressToNext: Math.min(Math.max(fraction, 0), 1),
                    stopsAway: Math.max(0, targetIndex - index),
                    lastStopName: trimmed.stops[index].stop.name,
                    lastStopPassedAt: seen.index === index ? seen.changedAt : null,
                    positionAge: bus.vehicle.recordedAt ? now - bus.vehicle.recordedAt : null,
                };
            });
            buses.push(...lineBuses);

            // A bus on its way with no minutes for it is a missing answer, not an empty timetable:
            // keep this line's last minutes that are still ahead rather than wipe the readout.
            const upcoming = [...result.progress.arrivals].sort((a, b) => a.expectedAt - b.expectedAt);
            if (result.progress.arrivalsError || (!upcoming.length && lineBuses.length)) {
                complete = false;
                previousArrivals
                    .filter((a) => a.lineID === result.lineID && a.expectedAt > now - 60_000)
                    .forEach((a, i) => arrivals.push({ ...a, bus: lineBuses[i] ?? null }));
                continue;
            }
            for (const pair of pairArrivals(upcoming, tracked, new RouteGeometry(result.pattern), result.progress.targetDistance, now)) {
                const matched = pair.busIndex != null ? lineBuses[pair.busIndex] : null;
                const { arrival } = pair;
                const key = pair.isEstimate ? `bus-${matched?.id ?? ''}` : arrival.tripId ?? String(Math.round(arrival.expectedAt / 1000));
                arrivals.push({
                    id: `${result.lineID}#${key}`, lineID: result.lineID, expectedAt: arrival.expectedAt,
                    isRealtime: arrival.isRealtime,
                    delay: arrival.isRealtime && arrival.scheduledAt ? arrival.expectedAt - arrival.scheduledAt : null,
                    bus: matched, isEstimate: pair.isEstimate,
                });
            }
        }

        this.snapshot = { fetchedAt: now, arrivals: arrivals.sort((a, b) => a.expectedAt - b.expectedAt), buses, patterns: routes };
        if (this.selectedBusID && (!buses.some((b) => b.id === this.selectedBusID) || retargeted.has(this.selectedBusID))) {
            this.selectedBusID = null;
        }
        this.trunkLineID = this.trunk.select(this.snapshot.arrivals[0]?.lineID ?? null, now) ?? this.trunkLineID;
        // Forget buses that have finished their run.
        const live = new Set(buses.map((b) => b.id));
        for (const id of [...this.stopChangeTimes.keys()]) if (!live.has(id)) this.stopChangeTimes.delete(id);
        return complete;
    }
}

/** The map draws a route only as far as the rider's stop; anything past it is another trip. */
export function trim(pattern, stop) {
    let index = -1;
    pattern.stops.forEach((s, i) => { if (s.stop.code === stop.code) index = i; });
    return index < 0 ? pattern : { ...pattern, stops: pattern.stops.slice(0, index + 1) };
}

/**
 * Which drawn bus each prediction is about, plus a time for a bus the timetable left out. `buses`
 * run closest to the stop first and were measured on `geometry`, the whole pattern. A shared trip
 * id settles it; failing that, a prediction that says where its bus is goes to the bus there; one
 * that says neither falls back to order.
 */
export function pairArrivals(arrivals, buses, geometry, targetDistance, now) {
    const busFor = arrivals.map(() => null);
    const free = new Set(buses.map((_, i) => i));
    const freeSorted = () => [...free].sort((a, b) => a - b);

    arrivals.forEach((arrival, index) => {
        if (!arrival.tripId) return;
        const bus = freeSorted().find((i) => buses[i].vehicle.tripId === arrival.tripId);
        if (bus == null) return;
        busFor[index] = bus;
        free.delete(bus);
    });

    // Filtered the way the buses themselves are, so the next trip's bus waiting at the origin
    // cannot claim the bus that has just left it.
    const along = arrivals.map((arrival) => {
        if (!arrival.vehicleLocation) return null;
        const snapped = geometry.project(arrival.vehicleLocation);
        if (!snapped || snapped.offRoute > LIMITS.maxOffRouteMeters || snapped.distanceAlong <= LIMITS.terminalToleranceMeters) return null;
        return snapped.distanceAlong;
    });
    // Closest pairs first; the position trails the bus, so gaps ahead are ranked against a longer reach.
    const candidates = [];
    arrivals.forEach((_, index) => {
        if (busFor[index] != null || along[index] == null) return;
        for (const bus of free) {
            const ahead = buses[bus].distanceAlongRoute - along[index];
            if (ahead < -PREDICTION_MATCH_METERS || ahead > PREDICTION_LAG_METERS) continue;
            const reach = ahead > 0 ? PREDICTION_LAG_METERS : PREDICTION_MATCH_METERS;
            candidates.push({ arrival: index, bus, gap: Math.abs(ahead) / reach });
        }
    });
    candidates.sort((a, b) => a.gap - b.gap || a.arrival - b.arrival || a.bus - b.bus);
    for (const c of candidates) {
        if (busFor[c.arrival] != null || !free.has(c.bus)) continue;
        busFor[c.arrival] = c.bus;
        free.delete(c.bus);
    }

    if (!busFor.some((b) => b != null)) {
        // With nothing tying a prediction to a bus there is no telling which bus a realtime feed
        // skipped. Timetable slots, though, are no bus at all: each bus coming gets a time of its
        // own at city pace, and takes the slot it is running so it is not counted twice.
        if (arrivals.some((a) => a.isRealtime)) {
            return arrivals.map((arrival, i) => ({ arrival, busIndex: i < buses.length ? i : null, isEstimate: false }));
        }
        const slots = arrivals.map((arrival) => ({ arrival, busIndex: null, isEstimate: false }));
        buses.forEach((bus, index) => {
            if (bus.distanceAlongRoute >= targetDistance) return;
            const expected = new Date(now.getTime() + ((targetDistance - bus.distanceAlongRoute) / FALLBACK_BUS_SPEED) * 1000);
            let running = -1;
            slots.forEach((slot, i) => {
                if (slot.isEstimate) return;
                if (running < 0 || slot.arrival.expectedAt < slots[running].arrival.expectedAt) running = i;
            });
            if (running >= 0 && slots[running].arrival.expectedAt <= expected.getTime() + EARLY_RUNNING_ALLOWANCE_MS) slots.splice(running, 1);
            slots.push({ arrival: { expectedAt: expected, scheduledAt: null, isRealtime: true, tripId: null, vehicleLocation: bus.vehicle.location }, busIndex: index, isEstimate: true });
        });
        return slots.sort((a, b) => a.arrival.expectedAt - b.arrival.expectedAt);
    }

    // A prediction that says nothing of its bus takes the closest free bus that keeps the order
    // the matched ones set: behind every bus due before it, ahead of every bus due after.
    arrivals.forEach((arrival, index) => {
        if (busFor[index] != null || arrival.vehicleLocation) return;
        const placed = arrivals.flatMap((other, o) => (busFor[o] != null ? [{ at: other.expectedAt, along: buses[busFor[o]].distanceAlongRoute }] : []));
        const ahead = Math.min(Infinity, ...placed.filter((p) => p.at <= arrival.expectedAt).map((p) => p.along));
        const behind = Math.max(-Infinity, ...placed.filter((p) => p.at > arrival.expectedAt).map((p) => p.along));
        const bus = freeSorted().find((i) => buses[i].distanceAlongRoute < ahead && buses[i].distanceAlongRoute > behind);
        if (bus == null) return;
        busFor[index] = bus;
        free.delete(bus);
    });

    const pairs = arrivals.map((arrival, i) => ({ arrival, busIndex: busFor[i], isEstimate: false }));

    // A bus nearer the stop than every predicted one reaches it first, whatever the timetable says.
    // Give it a time at the pace the nearest predicted bus keeps, so the numbers agree with the map.
    const matched = pairs.filter((p) => p.busIndex != null).map((p) => ({ bus: buses[p.busIndex], arrival: p.arrival }));
    if (!matched.length) return pairs;
    const lead = matched.reduce((a, b) => (b.bus.distanceAlongRoute > a.bus.distanceAlongRoute ? b : a));
    const leadMeters = targetDistance - lead.bus.distanceAlongRoute;
    const leadSeconds = (lead.arrival.expectedAt - now) / 1000;
    const pace = lead.arrival.isRealtime && leadMeters > 0 && leadSeconds > 30
        ? Math.min(Math.max(leadMeters / leadSeconds, PLAUSIBLE_SPEEDS[0]), PLAUSIBLE_SPEEDS[1])
        : FALLBACK_BUS_SPEED;
    for (const index of freeSorted()) {
        const bus = buses[index];
        if (bus.distanceAlongRoute <= lead.bus.distanceAlongRoute || bus.distanceAlongRoute >= targetDistance) continue;
        let expected = now.getTime() + ((targetDistance - bus.distanceAlongRoute) / pace) * 1000;
        if (lead.arrival.isRealtime) expected = Math.min(expected, lead.arrival.expectedAt.getTime());
        pairs.push({ arrival: { expectedAt: new Date(expected), scheduledAt: null, isRealtime: true, tripId: null, vehicleLocation: bus.vehicle.location }, busIndex: index, isEstimate: true });
    }
    return pairs.sort((a, b) => a.arrival.expectedAt - b.arrival.expectedAt);
}

/** A cached pattern without loading one, for drawing the routes before the network answers. */
async function peekStatic(key) {
    const cache = await caches.open('mybusstop-static-v1');
    const hit = await cache.match(new Request(`https://cache.mybusstop.invalid/${encodeURIComponent(key)}`));
    return hit ? hit.json() : null;
}
