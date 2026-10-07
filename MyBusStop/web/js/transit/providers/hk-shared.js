// Helpers shared by the Hong Kong providers (KMB, Citybus, GMB, NLB): which of the parallel name
// fields to show, timestamps, line ordering, and bounded fan-out for the per-stop lookups.

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
