// The full lines view's layout: every watched line over its whole route, terminus to terminus,
// every stop drawn and none folded into a "+N STOPS" run. Pure (no DOM), like the engine, so it
// runs in Node as well.
//
// The rows are lined up on the rider's stop: it is one column across every line, whatever each line
// did before it, so how far out a bus is reads the same on every row. A line that starts closer to
// the stop simply starts further along.

import { AXIS } from './metrics.js';

/**
 * @param {object} request
 * @param {Array<{id:string, number:string, colorIndex:number, stops:Array<{code:string,name:string}>}>} request.lines
 *   selection order; each line's stops run first terminus … last terminus, the rider's stop among them.
 * @param {string} request.userStopCode
 * @param {Array<{id:string, lineID:string, lastStopIndex:number, progressToNext:number, isSelected?:boolean}>} [request.vehicles]
 *   positions as the board measures them: an index into the route up to the rider's stop, which is
 *   the same index into the whole route.
 * @param {'horizontal'|'vertical'} request.axis which way travel runs, and so which way the view scrolls
 * @param {number} request.pitch distance between neighbouring stops along the route
 * @param {number} request.leadIn along the route, before the first column: room for the line badge
 * @param {number} request.leadOut along the route, after the last column: room for its last name
 * @param {number[]} request.across where each row sits across the route, in selection order
 * @returns {{axis:string, along:number, userAlong:number, columns:number, rows:object[], pucks:object[]}}
 *   `along` is the length of the whole drawing in the scrolling direction.
 */
export function layoutFullRoute({ lines, userStopCode, vehicles = [], axis, pitch, leadIn, leadOut, across }) {
    const point = (along, acrossAt) => (axis === AXIS.horizontal ? { x: along, y: acrossAt } : { x: acrossAt, y: along });

    // The last call at the stop, as the board trims to: a loop that passes twice is caught on the
    // second pass, and the bus positions the board hands over are counted to that one.
    const userIndices = lines.map((line) => {
        let index = -1;
        line.stops.forEach((stop, i) => { if (stop.code === userStopCode) index = i; });
        return index < 0 ? line.stops.length - 1 : index;
    });
    const before = Math.max(0, ...userIndices);
    const columns = Math.max(1, ...lines.map((line, i) => before - userIndices[i] + line.stops.length));
    const alongOf = (column) => leadIn + column * pitch;

    const rows = lines.map((line, row) => {
        const offset = before - userIndices[row];
        const acrossAt = across[row] ?? 0;
        const stops = line.stops.map((stop, index) => {
            const along = alongOf(offset + index);
            return {
                index, code: stop.code, name: stop.name, along, across: acrossAt, point: point(along, acrossAt),
                isUser: index === userIndices[row],
                isAfter: index > userIndices[row],
                isTerminus: index === 0 || index === line.stops.length - 1,
            };
        });
        return {
            lineID: line.id, number: line.number, colorIndex: line.colorIndex, across: acrossAt,
            userIndex: userIndices[row],
            firstAlong: alongOf(offset),
            lastAlong: alongOf(offset + Math.max(0, line.stops.length - 1)),
            stops,
        };
    });

    const pucks = [];
    for (const vehicle of vehicles) {
        const row = rows.find((r) => r.lineID === vehicle.lineID);
        if (!row || !row.stops.length) continue;
        const index = Math.min(Math.max(0, vehicle.lastStopIndex), row.stops.length - 1);
        const next = Math.min(index + 1, row.stops.length - 1);
        const progress = Math.min(Math.max(vehicle.progressToNext ?? 0, 0), 1);
        const along = row.stops[index].along + (row.stops[next].along - row.stops[index].along) * progress;
        pucks.push({
            id: vehicle.id, lineID: row.lineID, number: row.number, colorIndex: row.colorIndex,
            along, across: row.across, point: point(along, row.across), isSelected: !!vehicle.isSelected,
        });
    }
    // The bus the readout is about goes last, so its ring is drawn over any bus beside it.
    pucks.sort((a, b) => Number(a.isSelected) - Number(b.isSelected));

    return {
        axis, columns,
        along: alongOf(columns - 1) + leadOut,
        userAlong: alongOf(before),
        rows, pucks,
    };
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/** How far to scroll so `along` sits in the middle of the view, within what can be scrolled. */
export function scrollToCentre(along, viewport, content) {
    return clamp(along - viewport / 2, 0, content - viewport);
}

/**
 * The window the mini map draws over the whole route: what the main view shows, at the strip's
 * scale. Never wider than the strip, and never outside it.
 * @returns {{start:number, length:number}} in strip units, from the strip's start
 */
export function miniWindow({ scroll, viewport, content, strip }) {
    if (!(content > 0) || !(strip > 0)) return { start: 0, length: Math.max(0, strip) };
    const scale = strip / content;
    const length = Math.min(strip, viewport * scale);
    return { start: clamp(scroll * scale, 0, strip - length), length };
}

/** The scroll that puts the window's middle at `at` on the strip: a tap there, or a drag. */
export function scrollForMini({ at, viewport, content, strip }) {
    if (!(strip > 0)) return 0;
    return scrollToCentre((at / strip) * content, viewport, content);
}
