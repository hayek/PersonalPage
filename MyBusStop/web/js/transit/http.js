// Networking for every provider. The web version only talks to APIs that need no key and allow a
// browser to read their replies (CORS), so nothing here ever holds or sends a secret.

import { TransitError } from './model.js';

/** A reply a provider could not use, with what the server said. */
export class ResponseError extends TransitError {
    constructor(reason, { url = '', status = -1, body = '' } = {}) {
        super('badResponse', reason);
        this.name = 'ResponseError';
        this.url = url;
        this.status = status;
        this.body = String(body).slice(0, 2000);
    }
}

/** base + path + sorted query, with "+" sent as %2B (servers read a bare "+" as a space). */
export function buildURL(base, path = '', query = {}) {
    const url = new URL(base + path);
    for (const [name, value] of Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (value === undefined || value === null) continue;
        url.searchParams.append(name, String(value));
    }
    return url.toString();
}

async function send(url, { method = 'GET', headers = {}, body, timeout = 30_000, accept = 'application/json' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
        // `cache: 'no-store'`: live data must never come back from the browser's HTTP cache, and a
        // request that says where the rider is must not be written to disk.
        response = await fetch(url, {
            method, body, headers: { Accept: accept, ...headers },
            signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        });
    } catch (error) {
        throw new ResponseError(controller.signal.aborted ? `timed out after ${timeout / 1000}s` : `network: ${error.message}`, { url: redact(url) });
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new ResponseError(`HTTP ${response.status}`, { url: redact(url), status: response.status, body: text });
    }
    return response;
}

/** GET and decode JSON. `options.query` is appended to the URL. */
export async function getJSON(url, options = {}) {
    const full = options.query ? buildURL(url, '', options.query) : url;
    const response = await send(full, options);
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new ResponseError('reply was not JSON', { url: redact(full), status: response.status, body: text });
    }
}

/** POST a JSON body and decode the JSON reply (GraphQL, mostly). */
export async function postJSON(url, payload, options = {}) {
    return getJSON(url, {
        ...options, method: 'POST', body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    });
}

export async function getText(url, options = {}) {
    const full = options.query ? buildURL(url, '', options.query) : url;
    return (await send(full, { accept: '*/*', ...options })).text();
}

export async function getBytes(url, options = {}) {
    const full = options.query ? buildURL(url, '', options.query) : url;
    return new Uint8Array(await (await send(full, { accept: '*/*', ...options })).arrayBuffer());
}

/** A URL as it may be shown in an error: coordinates masked. */
export function redact(url) {
    return String(url).replace(/-?\d{1,3}\.\d+(\s*(,|:|%2C|%3A)\s*-?\d{1,3}\.\d+)?/gi, 'LOCATION');
}

// ---------------------------------------------------------------------------------------------
// Caches

const inMemory = new Map();

/**
 * Keeps a value for `ttlMs`, and makes concurrent callers share the one load in flight, so the three
 * lines of one board cost one departures request. Failures are not kept.
 */
export function memo(key, ttlMs, load) {
    const now = Date.now();
    const hit = inMemory.get(key);
    if (hit && now - hit.at < ttlMs) return hit.promise;
    const promise = load();
    inMemory.set(key, { at: now, promise });
    promise.catch(() => { if (inMemory.get(key)?.promise === promise) inMemory.delete(key); });
    return promise;
}

const STATIC_CACHE = 'mybusstop-static-v1';

/**
 * Static reference data (a network's stop list, route table) kept across visits in the browser's
 * Cache Storage for `maxAgeMs`, and in memory for the session. `load` returns anything JSON can hold.
 * A failed refresh falls back to an expired copy rather than nothing.
 */
export function staticData(key, maxAgeMs, load) {
    return memo(`static:${key}`, maxAgeMs, async () => {
        const request = new Request(`https://cache.mybusstop.invalid/${encodeURIComponent(key)}`);
        let cache = null;
        let stale;
        try {
            cache = await caches.open(STATIC_CACHE);
            const hit = await cache.match(request);
            if (hit) {
                const savedAt = Number(hit.headers.get('x-saved-at') ?? 0);
                const value = await hit.json();
                if (Date.now() - savedAt < maxAgeMs) return value;
                stale = value;
            }
        } catch {
            cache = null; // Private browsing or no Cache Storage: memory only.
        }
        let value;
        try {
            value = await load();
        } catch (error) {
            if (stale !== undefined) return stale;
            throw error;
        }
        try {
            await cache?.put(request, new Response(JSON.stringify(value), {
                headers: { 'content-type': 'application/json', 'x-saved-at': String(Date.now()) },
            }));
        } catch { /* quota: the session still has it in memory */ }
        return value;
    });
}

/** The service day in a time zone, as "YYYY-MM-DD" (`offsetDays` from today). */
export function serviceDate(timeZone, offsetDays = 0, at = new Date()) {
    const shifted = new Date(at.getTime() + offsetDays * 86_400_000);
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

/**
 * The instant a wall-clock time in a time zone stands for: ("2026-10-07", "25:10:00", "Europe/Oslo").
 * GTFS times past 24:00 roll into the next day, which this handles.
 */
export function zonedTime(dateString, timeString, timeZone) {
    const [y, m, d] = dateString.split('-').map(Number);
    const [hh, mm, ss = 0] = timeString.split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
    const offset = zoneOffsetMs(timeZone, new Date(guess));
    const first = guess - offset;
    // Across a DST change the offset at the answer can differ from the offset at the guess.
    const second = guess - zoneOffsetMs(timeZone, new Date(first));
    return new Date(second);
}

function zoneOffsetMs(timeZone, at) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(at);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return asUTC - Math.floor(at.getTime() / 1000) * 1000;
}
