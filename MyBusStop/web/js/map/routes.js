// Route compression and junction detection. Ported from BusBus/MapEngine/RouteCompressor.swift
// and JunctionDetector.swift.
//
// A Swift `Range<Int>` is `{ lower, upper }` here (half-open), and a drawn run is
// `{ kind: 'stop', index }` or `{ kind: 'dash', swallowed: { lower, upper } }`.

export const range = (lower, upper) => ({ lower, upper });
export const rangeCount = (r) => Math.max(0, r.upper - r.lower);
export const rangeIndices = (r) => {
    const out = [];
    for (let i = r.lower; i < r.upper; i++) out.push(i);
    return out;
};
const stopRun = (index) => ({ kind: 'stop', index });
const dashRun = (lower, upper) => ({ kind: 'dash', swallowed: range(lower, upper) });

export const drawnStopIndices = (runs) => runs.filter((r) => r.kind === 'stop').map((r) => r.index);
export const dashRanges = (runs) => runs.filter((r) => r.kind === 'dash').map((r) => r.swallowed);

/**
 * Turns a route that is far too long to draw into the handful of stops that actually get marks.
 *
 * Shape: terminus → one or two real stops → a dashed run labelled with the number of stops it
 * swallows → the last few stops before the junction (or before the user's stop). Each line is
 * compressed on its own, so the dashes deliberately do not line up across rows.
 */
export const RouteCompressor = {
    /**
     * A dash is only worth drawing when it hides at least this many stops. With head 1 and tail 5
     * this also delivers the brief's "a route of 9 stops or fewer is drawn in full".
     */
    minimumSwallowed: 2,

    /**
     * @param line `{ id, stops }`
     * @param shared indices the line runs together with the trunk — from its junction (inclusive)
     *   to the user's stop (exclusive). Empty when the line never joins.
     * @returns `{ lineID, runs, ownTailCount, sharedDashed }`. `runs` covers indices `1 ..< n` in
     *   order (the terminus at 0 is always drawn, the user's stop at `n` is the node). `sharedDashed`
     *   holds offsets *within the shared segment* that a bundle dash swallows, or null.
     */
    compress(line, shared, headCount, tailBudget) {
        const n = line.stops.length - 1;
        if (n < 1) return { lineID: line.id, runs: [], ownTailCount: 0, sharedDashed: null };

        // 1. Bundle compression: the corridor the lines share can itself be too long to draw.
        const sharedCount = rangeCount(shared);
        let sharedDashed = null;
        let sharedRuns = [];
        let drawnShared = sharedCount;

        if (sharedCount - tailBudget >= this.minimumSwallowed) {
            const keepAtEnd = Math.max(0, tailBudget - 1);
            const swallowed = range(1, sharedCount - keepAtEnd);
            sharedDashed = swallowed;
            drawnShared = tailBudget;
            sharedRuns.push(stopRun(shared.lower));
            sharedRuns.push(dashRun(shared.lower + swallowed.lower, shared.lower + swallowed.upper));
            for (let i = shared.upper - keepAtEnd; i < shared.upper; i++) sharedRuns.push(stopRun(i));
        } else {
            sharedRuns = rangeIndices(shared).map(stopRun);
        }

        // 2. What is left of the tail budget goes to the line's own stops before the junction.
        const ownTail = Math.max(1, tailBudget - drawnShared);

        // 3. The own segment: everything between the terminus and the junction (or the node).
        // A line that lies entirely on the trunk joins at its own index 0, so it has none.
        const ownUpper = Math.max(1, sharedCount === 0 ? n : shared.lower);
        const ownRange = range(1, ownUpper);
        let ownRuns = [];
        let ownTailCount = 0;

        const ownCount = rangeCount(ownRange);
        if (ownCount > 0) {
            const head = Math.min(headCount, ownCount);
            const tail = Math.min(ownTail, ownCount - head);
            const middle = range(ownRange.lower + head, ownRange.upper - tail);

            if (rangeCount(middle) >= this.minimumSwallowed) {
                for (let i = ownRange.lower; i < ownRange.lower + head; i++) ownRuns.push(stopRun(i));
                ownRuns.push(dashRun(middle.lower, middle.upper));
                for (let i = ownRange.upper - tail; i < ownRange.upper; i++) ownRuns.push(stopRun(i));
                ownTailCount = tail;
            } else {
                ownRuns = rangeIndices(ownRange).map(stopRun);
                ownTailCount = ownCount - head;
            }
        }

        return { lineID: line.id, runs: ownRuns.concat(sharedRuns), ownTailCount, sharedDashed };
    },
};

const NO_JUNCTION = Object.freeze({ lineJunctionIndex: null, trunkJunctionIndex: null, lineIsSubsetOfTrunk: false });
export const hasJunction = (j) => j.lineJunctionIndex !== null && j.lineJunctionIndex !== undefined;

const lastIndexOfCode = (stops, code) => {
    for (let i = stops.length - 1; i >= 0; i--) if (stops[i].code === code) return i;
    return -1;
};

/**
 * Where a line stops being its own route and starts running with the trunk.
 *
 * Merging is data, not decoration: walk both stop sequences backwards from the user's stop and
 * stop at the first divergence. Everything before that point is the line's own rail; everything
 * after it runs parallel to the trunk.
 *
 * Returns `{ lineJunctionIndex, trunkJunctionIndex, lineIsSubsetOfTrunk }`; the indices are null
 * when the line keeps its own rail all the way to the node.
 */
export const JunctionDetector = {
    none: NO_JUNCTION,

    junction(line, trunk, userStopCode) {
        // The last occurrence rather than the first: on a loop route that passes the user's stop
        // twice, the rider boards on the last pass, and it is that pass whose stop sequence
        // precedes the arrival. Callers normally trim the pattern so this is simply `count - 1`.
        const trunkUser = lastIndexOfCode(trunk.stops, userStopCode);
        const lineUser = lastIndexOfCode(line.stops, userStopCode);
        if (trunkUser < 0 || lineUser < 0) return NO_JUNCTION;

        let i = trunkUser;
        let j = lineUser;
        while (i > 0 && j > 0 && trunk.stops[i - 1].code === line.stops[j - 1].code) {
            i -= 1;
            j -= 1;
        }

        if (j === lineUser) {
            // Nothing shared before the user's stop: an independent rail that meets the trunk
            // only at the node (Main, and line 7 in Merge A).
            return NO_JUNCTION;
        }
        if (j === 0) {
            // The line's terminus is already on the trunk: no own segment, no junction curve.
            return { lineJunctionIndex: 0, trunkJunctionIndex: i, lineIsSubsetOfTrunk: true };
        }
        if (i === 0) {
            // We reached the trunk's terminus while the line still has stops of its own further
            // back. There is no room to draw that segment left of the trunk's terminus, so the
            // line is drawn independently and the shared stops appear as rings on both rails.
            return NO_JUNCTION;
        }
        return { lineJunctionIndex: j, trunkJunctionIndex: i, lineIsSubsetOfTrunk: false };
    },
};
