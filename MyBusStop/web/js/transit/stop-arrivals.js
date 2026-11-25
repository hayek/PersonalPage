// Every line's next bus at one stop, for the lists that show it away from the board: the stop card
// and the line picker. As in the app (BusBus/Transit/StopArrivals.swift).
//
// Asked line by line, a few at a time. Feeds whose departures reply covers the whole stop (Föli,
// Tampere, Metro Transit, Swiss, Carris, Transitous…) keep that reply about 10 s with `memo`, so a
// stop's lines cost one request a round.

import { Capability } from './model.js';
import { countdown } from '../ui.js';

/** Whether the feed can say when a line's next bus comes at all. */
export function hasArrivals(provider) {
    return !!provider?.capabilities
        && (provider.capabilities.has(Capability.realtimeArrivals) || provider.capabilities.has(Capability.scheduledArrivals));
}

/**
 * The next arrivals of every line at one stop, as a Map from line id. A line whose request fails is
 * left out rather than failing the others.
 * @returns {Promise<Map<string, import('./model.js').Arrival[]>>}
 */
export async function arrivalsAtStop(provider, stop, lines, maxConcurrent = 4) {
    const found = new Map();
    if (!hasArrivals(provider) || !lines.length) return found;
    let next = 0;
    const worker = async () => {
        while (next < lines.length) {
            const line = lines[next++];
            try {
                found.set(line.id, await provider.arrivals(line, stop));
            } catch (error) {
                console.warn('[stop arrivals]', line.id, error);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, lines.length) }, worker));
    return found;
}

/**
 * Asks `arrivalsAtStop` again at the board's pace, handing each answer to `update`, while the page is
 * in front; a hidden tab asks nothing until it comes back. Returns the function that stops it.
 */
export function pollArrivals(provider, stop, lines, update) {
    if (!hasArrivals(provider) || !lines.length) return () => {};
    let stopped = false;
    let running = false;
    let timer = null;
    const round = async () => {
        timer = null;
        if (stopped || running || document.hidden) return;
        running = true;
        const found = await arrivalsAtStop(provider, stop, lines);
        running = false;
        if (stopped) return;
        update(found);
        timer = setTimeout(round, (provider.refreshSeconds ?? 30) * 1000);
    };
    const onVisibility = () => {
        if (document.hidden || timer != null || running) return;
        round();
    };
    document.addEventListener('visibilitychange', onVisibility);
    round();
    return () => {
        stopped = true;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onVisibility);
    };
}

/** A line's arrivals still to come, soonest first, as the board counts them. */
export function upcoming(arrivals, now = Date.now()) {
    return (arrivals ?? [])
        .filter((a) => a.expectedAt - now > -30_000)
        .sort((a, b) => a.expectedAt - b.expectedAt);
}

/** The next bus as the lists print it: the board's countdown, and whether it is only the timetable's. */
export function nextBus(arrivals, now = Date.now()) {
    const [first, second] = upcoming(arrivals, now);
    if (!first) return null;
    return {
        ...countdown(first.expectedAt, now),
        isRealtime: first.isRealtime,
        then: second ? countdown(second.expectedAt, now) : null,
    };
}
