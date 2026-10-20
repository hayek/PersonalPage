// A line's real path along the roads, for the line card's map — never straight lines between stops.
// Port of BusBus/Transit/Shapes/RouteShape.swift and the shape half of
// BusBus/Transit/Cache/TransitCache.swift: each shape is judged against its stops once, thinned for
// drawing and kept, so a line costs at most one request of its own a month.

import { TransitError } from '../model.js';
import { ResponseError, keepStored, readStored } from '../http.js';
import { decodePolyline, encodePolyline } from './polyline.js';
import { TOLERANCE, simplified, verdict } from './shape-check.js';

const DAY = 86_400_000;
/** A line's path barely ever moves: fetched again when the pattern's stops change, or after a month. */
export const SHAPE_LIFETIME = 30 * DAY;
/**
 * A line with no usable path is asked again after a week: a feed may have gained it, but not so soon
 * that opening the card again costs a request each time.
 */
export const MISSING_SHAPE_LIFETIME = 7 * DAY;

/**
 * Whether this line can have a route to draw. The ⓘ that opens a line's card is offered only then: a
 * feed without shapes gets no map buttons at all.
 */
export function hasRouteShape(provider, line) {
    return typeof provider?.routeShape === 'function' && (provider.hasRouteShape?.(line) ?? true);
}

const memory = new Map();
const inFlight = new Map();

/**
 * The line's path, judged against the pattern's stops; null when it has none that may be drawn. A
 * rejected shape is kept as well, and so is an answer that will not change by asking again soon — no
 * path for this line, a reply that cannot be read, a 4xx — so a line is not asked for on every opening.
 * What may pass (no connection, a timeout, 5xx, 429) rejects and is asked again next time; a month-old
 * shape is still drawn meanwhile.
 * @param {import('../model.js').TransitProvider} provider
 * @param {import('../model.js').TransitLine} line
 * @param {import('../model.js').RoutePattern} pattern
 * @returns {Promise<import('../model.js').RouteShape|null>}
 */
export async function loadRouteShape(provider, line, pattern) {
    if (typeof provider?.routeShape !== 'function') return null; // no shapes: no request
    const key = shapeKey(provider, line);
    const fingerprint = await stopsFingerprint(pattern);
    const flight = `${key}#${fingerprint}`;
    if (!inFlight.has(flight)) {
        const load = resolve(provider, line, pattern, key, fingerprint);
        inFlight.set(flight, load);
        load.then(() => inFlight.delete(flight), () => inFlight.delete(flight));
    }
    return drawable(await inFlight.get(flight));
}

async function resolve(provider, line, pattern, key, fingerprint) {
    const kept = memory.get(key) ?? await readStored(key);
    if (kept) memory.set(key, kept);
    // A shape made for another stop list no longer answers the question, however fresh.
    const usable = kept?.value?.stopsFingerprint === fingerprint ? kept.value : null;
    if (usable && Date.now() - kept.savedAt < SHAPE_LIFETIME && !isStaleRejection(usable)) return usable;

    let stored;
    try {
        const raw = await provider.routeShape(line, pattern);
        stored = raw ? judging(raw, line, pattern, provider.shapeTolerance ?? TOLERANCE.platforms, fingerprint)
            : rejecting('the feed has no path for this line', line, fingerprint);
    } catch (error) {
        if (!isLasting(error)) {
            // Stale beats blank: an out-of-date route still draws the right shape.
            if (usable?.accepted) return usable;
            throw error;
        }
        stored = rejecting(error.message, line, fingerprint);
    }
    const entry = { value: stored, savedAt: stored.judgedAt };
    memory.set(key, entry);
    await keepStored(key, stored, entry.savedAt);
    return stored;
}

/**
 * A line's path as the cache keeps it: thinned for drawing, as precision-6 encoded polylines (lossless
 * at road scale, about a quarter the size of JSON coordinates), with the verdict reached on the full
 * geometry against the stops it was fetched for.
 */
function judging(shape, line, pattern, tolerance, fingerprint, at = Date.now()) {
    const branches = (shape.branches ?? []).filter((b) => b.length >= 2);
    const stops = pattern.stops.map((s) => shape.stopPositions?.[s.stop.code] ?? s.stop.location);
    const judged = verdict({ branches }, stops, tolerance);
    return {
        branches: branches.map((b) => encodePolyline(simplified(b), 6)),
        ...(shape.stopPositions ? { stopPositions: shape.stopPositions } : {}),
        ...(shape.version != null ? { version: shape.version } : {}),
        accepted: judged.accepted,
        reason: judged.reason,
        worstOffset: judged.worstOffset,
        stopsFingerprint: fingerprint,
        judgedAt: at,
        lineID: line.id,
    };
}

/** A line the feed has no usable path for, and why. */
function rejecting(reason, line, fingerprint, at = Date.now()) {
    return { branches: [], accepted: false, reason, worstOffset: null, stopsFingerprint: fingerprint, judgedAt: at, lineID: line.id };
}

/** A rejection old enough to ask again. */
function isStaleRejection(stored) {
    return !stored.accepted && Date.now() - stored.judgedAt >= MISSING_SHAPE_LIFETIME;
}

const decoded = new WeakMap();

/** What the map may draw: null when the shape failed its check (the card shows "no route map"). */
function drawable(stored) {
    if (!stored?.accepted) return null;
    if (!decoded.has(stored)) {
        const shape = { branches: stored.branches.map((b) => decodePolyline(b, 6)) };
        if (stored.stopPositions) shape.stopPositions = stored.stopPositions;
        if (stored.version != null) shape.version = stored.version;
        decoded.set(stored, shape);
    }
    return decoded.get(stored);
}

/**
 * An answer that asking again soon would not change: no path, a 4xx, a reply or polyline that cannot be
 * read. Connection failures, timeouts and server errors (5xx, 408, 429) may pass, and so may anything
 * unknown.
 */
export function isLasting(error) {
    if (error instanceof ResponseError) {
        if (error.status < 0) return false; // network, timeout
        if (error.status >= 500 || error.status === 408 || error.status === 429) return false;
        return true; // 4xx, or an OK reply that could not be read
    }
    if (error instanceof TransitError) {
        if (error.kind === 'notFound') return true;
        if (error.kind === 'badResponse') return !/HTTP (5\d\d|429|408)/.test(error.message);
        return false;
    }
    return error instanceof SyntaxError; // JSON.parse on a provider's own reply
}

/** Which cache a shape is kept under. Feeds that share line ids name the same `shapeDatasetID`. */
function shapeKey(provider, line) {
    return `shape/${provider.shapeDatasetID ?? provider.datasetID ?? provider.id}/${line.id}`;
}

/**
 * The stop codes in order with immediate repeats dropped (some feeds list a stop twice in a row), as a
 * short hash: sha1 of the codes joined by commas, first 16 hex digits, as the app and its offline files
 * compute it. A shape is kept until this changes.
 */
export async function stopsFingerprint(pattern) {
    const codes = [];
    for (const { stop } of pattern.stops) if (codes[codes.length - 1] !== stop.code) codes.push(stop.code);
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(codes.join(',')));
    return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Forgets every shape kept in memory this session (tests start cold with it). */
export function resetMemory() {
    memory.clear();
    inFlight.clear();
}
