// Decides which line owns the straight spine of the map. Ported from
// BusBus/MapEngine/TrunkSelector.swift.
//
// The trunk is the line of the next arriving bus, but two close ETAs must not make the whole
// diagram re-lay itself every few seconds — so a change is held back until the previous one has
// had at least half a minute to settle.

export const TRUNK_MINIMUM_INTERVAL_MS = 30 * 1000;

const toMs = (now) => (now instanceof Date ? now.getTime() : Number(now));

/**
 * @param {{currentTrunkID?: string|null, lastChangeAt?: Date|number|null, manualTrunkID?: string|null}} [initial]
 * @returns {{currentTrunkID: string|null, lastChangeAt: number|null, manualTrunkID: string|null,
 *            select: (candidateID: string|null, now: Date|number) => string|null}}
 *   `manualTrunkID` is set when the rider taps a distance spine on a portrait phone to promote it.
 *   It outranks the automatic candidate, but still goes through the same interval gate.
 */
export function createTrunkSelector(initial = {}) {
    return {
        currentTrunkID: initial.currentTrunkID ?? null,
        lastChangeAt: initial.lastChangeAt === undefined || initial.lastChangeAt === null ? null : toMs(initial.lastChangeAt),
        manualTrunkID: initial.manualTrunkID ?? null,

        /** @param candidateID the line of the soonest arrival, or null when nothing is coming. */
        select(candidateID, now) {
            const at = toMs(now);
            const desired = this.manualTrunkID ?? candidateID ?? null;
            const current = this.currentTrunkID;
            if (current === null) {
                this.currentTrunkID = desired;
                this.lastChangeAt = desired === null ? null : at;
                return this.currentTrunkID;
            }
            if (desired === null || desired === current) return current;
            if (this.lastChangeAt !== null && at - this.lastChangeAt < TRUNK_MINIMUM_INTERVAL_MS) return current;
            this.currentTrunkID = desired;
            this.lastChangeAt = at;
            return desired;
        },
    };
}
