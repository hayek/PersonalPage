// The days of the week a line runs, for the row of day letters on its card. Port of
// BusBus/Transit/Models/ServiceDays.swift: weekdays are numbered as the app's `Calendar` numbers them,
// 1 = Sunday … 7 = Saturday, so the two read the same feeds the same way.
//
// It is the line's usual week, not a promise for one date: feeds give either the day types their
// timetables are published for (weekdays, Saturday, Sunday) or the dates the line runs, and dates are
// read over a window of a week or more so a holiday on one of them does not dim or light a day. Never
// read it off a single GTFS calendar or service id: a line runs on the union of all its services, and
// one of them can say "Fridays only" for a line that runs all week.

/** @typedef {{weekdays: number[]}} ServiceDays  1 = Sunday … 7 = Saturday; empty when nothing is known. */

/** Nothing known: the card shows no row. */
export const UNKNOWN_DAYS = Object.freeze({ weekdays: [] });

const DAY_TYPES = { weekday: [2, 3, 4, 5, 6], saturday: [7], sunday: [1] };

/** @param {Iterable<number>} weekdays @returns {ServiceDays} */
export function serviceDays(weekdays) {
    return { weekdays: [...new Set(weekdays)].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b) };
}

/** @param {ServiceDays|null|undefined} days */
export const isKnown = (days) => (days?.weekdays?.length ?? 0) > 0;

/** From the day types timetables are published for: 'weekday' (Monday to Friday), 'saturday', 'sunday'. */
export function fromDayTypes(types) {
    return serviceDays([...types].flatMap((type) => DAY_TYPES[type] ?? []));
}

/**
 * From the service dates the line runs on, over a window of consecutive dates. A weekday counts when the
 * line runs on at least half of its dates in the window (and on one at least), so a holiday that drops it
 * one week, or adds a Sunday service to a Monday, does not change the row. Dates are "yyyy-MM-dd" or
 * "yyyyMMdd"; dates outside the window are ignored.
 * @param {Iterable<string>} running @param {Iterable<string>} window
 */
export function fromDates(running, window) {
    const inWindow = new Set([...window].map(normalizeDate).filter(Boolean));
    const ran = new Set([...running].map(normalizeDate).filter((date) => date && inWindow.has(date)));
    const occurrences = new Map();
    const runs = new Map();
    for (const date of inWindow) {
        const day = weekdayOf(date);
        if (!day) continue;
        occurrences.set(day, (occurrences.get(day) ?? 0) + 1);
        if (ran.has(date)) runs.set(day, (runs.get(day) ?? 0) + 1);
    }
    return serviceDays([...runs].filter(([day, count]) => count * 2 >= (occurrences.get(day) ?? 1)).map(([day]) => day));
}

/**
 * `count` consecutive service dates as "yyyy-MM-dd", starting `offset` days from the date it is at
 * `start` in `timeZone` (the feed's own, not the rider's).
 */
export function serviceDates({ start = new Date(), offset = 0, count, timeZone }) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(start).map(({ type, value }) => [type, value]));
    const first = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    return Array.from({ length: Math.max(count, 0) }, (_, step) =>
        new Date(first + (offset + step) * 86_400_000).toISOString().slice(0, 10));
}

/** "yyyy-MM-dd", from either spelling; null for anything else. */
export function normalizeDate(date) {
    const text = String(date ?? '');
    if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/** The weekday of a "yyyy-MM-dd" date, 1 = Sunday; null for anything else. */
export function weekdayOf(date) {
    const normal = normalizeDate(date);
    if (!normal) return null;
    const [year, month, day] = normal.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 1;
}

// MARK: Showing it

/** The rider's first weekday, 1 = Sunday: from the browser where it says, else Sunday in the few regions that start there. */
export function firstWeekday(locale = globalThis.navigator?.language ?? 'en-US') {
    try {
        const info = new Intl.Locale(locale);
        const week = info.getWeekInfo?.() ?? info.weekInfo;
        if (week?.firstDay) return (week.firstDay % 7) + 1; // Intl: 1 = Monday … 7 = Sunday
    } catch { /* an odd tag: fall through */ }
    const region = (() => { try { return new Intl.Locale(locale).maximize().region; } catch { return null; } })();
    return ['US', 'CA', 'IL', 'JP', 'BR', 'MX', 'HK', 'TW', 'KR', 'PH', 'IN', 'ZA', 'AU'].includes(region) ? 1 : 2;
}

/**
 * The seven days from the rider's first weekday, with a one-letter and a full English name (the web
 * version speaks English), and whether the line runs on each.
 * @param {ServiceDays} days
 */
export function week(days, first = firstWeekday()) {
    const runs = new Set(days.weekdays);
    // 2026-11-01 was a Sunday: weekday n is n - 1 days after it.
    const named = (n, style) => new Intl.DateTimeFormat('en', { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, n)));
    return Array.from({ length: 7 }, (_, step) => {
        const weekday = ((first - 1 + step) % 7) + 1;
        return { weekday, letter: named(weekday, 'narrow'), name: named(weekday, 'long'), runs: runs.has(weekday) };
    });
}

/** What a screen reader says after "Runs": "every day", or the days it runs in week order. */
export function spoken(days, first = firstWeekday()) {
    if (days.weekdays.length === 7) return 'every day';
    return new Intl.ListFormat('en', { type: 'conjunction' }).format(week(days, first).filter((day) => day.runs).map((day) => day.name));
}
