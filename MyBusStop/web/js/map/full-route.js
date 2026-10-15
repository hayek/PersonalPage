// The full lines view's layout: every stop of every watched line, terminus to terminus, with
// nothing folded into a "+N STOPS" run. Where the board's engine works hard to fit a route into one
// screen, this one does the opposite: the route is as long as it is, and the view scrolls along it.
// Ported from BusBus/MapEngine/FullRouteLayout.swift. Pure (no DOM), so it runs in Node as well.
//
// Lines that call at the same stops run together there, as a bundle of parallel rails with one
// capsule and one name per shared stop, and part again where their routes do. The stops are lined
// up across the lines the way two texts are diffed: a stop both lines call at gets one column, and
// stops a line has to itself sit beside the other lines' own stops rather than queue after them.

import { AXIS } from './metrics.js';

export const FULL_ROUTE = Object.freeze({
    /** Room for a name at −35° between two stops, and for a finger on either. */
    horizontalPitch: 72,
    /** Two lines of a name stacked between two stops. */
    verticalPitch: 48,
    /** Before the first column: the margin before the line's badge. */
    leadingMargin: 16,
    /** After the last stop: room for its name, which runs on past it at −35° in landscape. */
    horizontalTrailingInset: 120,
    verticalTrailingInset: 48,
    /** Above the first lane in landscape, for the rise of the top lane's longest names. */
    horizontalTopInset: 20,
    /**
     * A lane is never squeezed below this, even with three lines on a short screen; the view
     * scrolls across too rather than overlap them.
     */
    minimumHorizontalLane: 140,
    minimumVerticalLane: 132,
    /** Where a horizontal lane's rail sits, up from its foot: below it only the pucks' lower half. */
    horizontalRailFromFoot: 30,
    /** Where a vertical lane's rail sits, in from its leading edge. */
    verticalRailInset: 30,
    /** Rails running together, centre to centre: a rail's width and a sliver of ground. */
    bundleSpacing: 14,
    railWidth: 10,
    badgeSide: 34,
    ringRadius: 8,
    ringStroke: 4,
    nodeRadius: 12,
    labelFontSize: 12,
});

const ANGLE = 35 * Math.PI / 180;

const EMPTY = Object.freeze({
    axis: AXIS.horizontal, contentSize: { width: 0, height: 0 }, lines: [], stops: [], pucks: [],
    userStopAlong: 0, railWidth: 0, ringRadius: 0, ringStroke: 0, nodeRadius: 0, badgeSide: 0,
    labelRotation: 0, labelFontSize: 0, isEmpty: true,
});

/** Where a segment is at `t` (0…1): along its curve where it bends, straight where it does not. */
export function segmentPoint(segment, t) {
    const s = Math.min(Math.max(t, 0), 1);
    const { from, to } = segment;
    if (!segment.bends) return { x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s };
    const u = 1 - s;
    const a = u * u * u, b = 3 * u * u * s, c = 3 * u * s * s, d = s * s * s;
    return {
        x: a * from.x + b * segment.control1.x + c * segment.control2.x + d * to.x,
        y: a * from.y + b * segment.control1.y + c * segment.control2.y + d * to.y,
    };
}

/**
 * @param {object} request
 * @param {Array<{id:string, number:string, colorIndex:number, stops:Array<{code:string,name:string}>, userStopIndex?:number}>} request.lines
 *   each line's whole route, first terminus to last. Without `userStopIndex` the rider's stop is the
 *   last call at `request.userStopCode`, as the board trims to.
 * @param {string} [request.userStopCode]
 * @param {Array<{id:string, lineID:string, lastStopIndex:number, progressToNext:number, isSelected?:boolean}>} [request.vehicles]
 *   `lastStopIndex` counts along the whole route, which starts the same as the board's trimmed one.
 * @param {'horizontal'|'vertical'} request.axis
 * @param {{width:number, height:number}} request.viewport what the scroller shows at once; the lanes
 *   share its height (or width) between them
 */
export function layoutFullRoute({ lines: input, userStopCode = null, vehicles = [], axis, viewport }) {
    const F = FULL_ROUTE;
    const lines = input.filter((l) => l.stops.length >= 2);
    if (!lines.length) return EMPTY;
    const horizontal = axis === AXIS.horizontal;
    const pitch = horizontal ? F.horizontalPitch : F.verticalPitch;
    const userIndex = lines.map((line) => {
        let index = line.userStopIndex;
        if (index == null) {
            index = -1;
            line.stops.forEach((s, i) => { if (s.code === userStopCode) index = i; });
            if (index < 0) index = line.stops.length - 1;
        }
        return Math.min(Math.max(0, index), line.stops.length - 1);
    });

    // 1. Columns: which stop of which line sits where along the route.
    const columns = alignRoutes(lines.map((l) => l.stops.map((s) => s.code)), userIndex);
    let userColumn = columns.findIndex((column) => Object.keys(column).length === lines.length
        && Object.entries(column).every(([line, stop]) => userIndex[line] === stop));
    if (userColumn < 0) userColumn = 0;
    /** Per line, the column each of its stops is in. */
    const columnOf = lines.map((l) => new Array(l.stops.length).fill(0));
    columns.forEach((column, c) => { for (const [line, stop] of Object.entries(column)) columnOf[line][stop] = c; });

    // 2. Who runs with whom: per column, the lines calling at the same stop.
    const groups = columns.map((column) => {
        const byCode = new Map();
        for (const [key, stop] of Object.entries(column)) {
            const line = Number(key);
            const code = lines[line].stops[stop].code;
            if (!byCode.has(code)) byCode.set(code, []);
            byCode.get(code).push(line);
        }
        return [...byCode.values()].map((g) => g.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
    });
    const lane = laneOrder(lines.length, groups, userColumn);

    // 3. Across: each line's slot at each of its stops — its own lane alone, a bundle's slot
    // together. A line alone between two stops it shares with the same lines stays in the bundle:
    // an express passing a stop the others serve, not a detour.
    const topInset = horizontal ? F.horizontalTopInset : 0;
    // The lanes share what is left under the top inset, so a view tall enough for them does not
    // scroll across by the inset's height.
    const acrossViewport = horizontal ? viewport.height - topInset : viewport.width;
    const laneSize = Math.max(horizontal ? F.minimumHorizontalLane : F.minimumVerticalLane, acrossViewport / lines.length);

    const slot = (line, group) => {
        const members = [...group].sort((a, b) => lane[a] - lane[b]);
        const k = Math.max(0, members.indexOf(line));
        if (horizontal) {
            // Gathered on the lowest member's rail: the names rise into the lanes above, which the
            // bundle has emptied.
            const anchor = Math.max(...members.map((m) => lane[m]));
            const base = topInset + (anchor + 1) * laneSize - F.horizontalRailFromFoot;
            return base - (members.length - 1) * F.bundleSpacing + k * F.bundleSpacing;
        }
        // Gathered on the first member's rail: the names run on into the lanes after it.
        const anchor = Math.min(...members.map((m) => lane[m]));
        return anchor * laneSize + F.verticalRailInset + k * F.bundleSpacing;
    };

    const groupAt = lines.map((l, line) => l.stops.map((_, stop) => groups[columnOf[line][stop]].find((g) => g.includes(line)) ?? [line]));
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    lines.forEach((_, line) => {
        const own = groupAt[line].slice();
        own.forEach((group, stop) => {
            if (group.length !== 1) return;
            const before = own.slice(0, stop).reverse().find((g) => g.length > 1);
            const after = own.slice(stop + 1).find((g) => g.length > 1);
            if (!before || !after || !same(before, after)) return;
            // The others must be passing, not calling somewhere of their own.
            const column = columns[columnOf[line][stop]];
            if (!before.every((m) => m === line || !(m in column))) return;
            groupAt[line][stop] = before;
        });
    });
    const across = lines.map((l, line) => l.stops.map((_, stop) => slot(line, groupAt[line][stop])));

    // 4. Along: a pitch per column, and more where a line bends into or out of a bundle, so the
    // bend is a curve rather than a step.
    const along = new Array(columns.length).fill(0);
    const firstColumns = lines.map((_, line) => columnOf[line][0]);
    // The badges of lines starting at the same column stack along, ahead of their first stop.
    const badgeStack = lines.map((_, line) => lines.filter((__, other) => other < line
        && firstColumns[other] === firstColumns[line]
        && across[other][0] !== across[line][0]
        && Math.abs(across[other][0] - across[line][0]) < F.badgeSide).length);
    const badgeReach = (F.badgeSide + 6) * (Math.max(...badgeStack) + 1) + 8;
    along[0] = F.leadingMargin + badgeReach;
    for (let c = 1; c < columns.length; c++) {
        let position = along[c - 1] + pitch;
        lines.forEach((l, line) => {
            for (let stop = 1; stop < l.stops.length; stop++) {
                if (columnOf[line][stop] !== c) continue;
                const shift = Math.abs(across[line][stop] - across[line][stop - 1]);
                if (shift <= 0.5) continue;
                const bend = Math.max(pitch * 1.5, shift * 0.7);
                position = Math.max(position, along[columnOf[line][stop - 1]] + bend);
            }
        });
        along[c] = position;
    }

    const point = (a, x) => (horizontal ? { x: a, y: x } : { x, y: a });

    // 5. Rails.
    const routeLines = lines.map((l, line) => {
        const centers = l.stops.map((_, stop) => point(along[columnOf[line][stop]], across[line][stop]));
        const segments = centers.slice(0, -1).map((from, i) => {
            const to = centers[i + 1];
            const a0 = along[columnOf[line][i]];
            const a1 = along[columnOf[line][i + 1]];
            const half = (a1 - a0) / 2;
            return {
                from, to,
                control1: point(a0 + half, across[line][i]),
                control2: point(a1 - half, across[line][i + 1]),
                bends: Math.abs(across[line][i] - across[line][i + 1]) > 0.5,
                faded: i >= userIndex[line],
            };
        });
        const badgeAlong = along[columnOf[line][0]] - F.badgeSide / 2 - 14 - badgeStack[line] * (F.badgeSide + 6);
        return {
            lineID: l.id, number: l.number, colorIndex: l.colorIndex,
            badgeCenter: point(badgeAlong, across[line][0]),
            stopCenters: centers, segments, userStopIndex: userIndex[line],
        };
    });

    /** Where a line's rail crosses column `c`, whether it calls there or passes. */
    const railAcross = (line, c) => {
        const cols = columnOf[line];
        if (c < cols[0] || c > cols[cols.length - 1]) return null;
        const stop = cols.indexOf(c);
        if (stop >= 0) return across[line][stop];
        const next = cols.findIndex((col) => col > c);
        if (next <= 0) return null;
        const t = (along[c] - along[cols[next - 1]]) / Math.max(1, along[cols[next]] - along[cols[next - 1]]);
        const p = segmentPoint(routeLines[line].segments[next - 1], t);
        return horizontal ? p.y : p.x;
    };

    // 6. Marks and names: one per stop per group of lines calling there.
    const contentAcross = topInset + laneSize * lines.length;
    const labelGap = horizontal ? 23 : 32;
    const fontSize = F.labelFontSize;
    const stops = [];
    columns.forEach((column, c) => {
        for (const group of groups[c]) {
            const members = [...group].sort((a, b) => lane[a] - lane[b]);
            const first = members[0];
            const stop = lines[first].stops[column[first]];
            const memberAcross = members.map((m) => across[m][column[m]]);
            const memberCenters = memberAcross.map((x) => point(along[c], x));
            const low = Math.min(...memberAcross);
            const high = Math.max(...memberAcross);
            const others = lines.map((_, l) => l).filter((l) => !members.includes(l))
                .map((l) => railAcross(l, c)).filter((x) => x != null);
            const role = c === userColumn ? 'userStop'
                : members.length === 1 && column[first] === lines[first].stops.length - 1 ? 'lastStop'
                    : 'stop';
            let labelAnchor;
            let labelMaxWidth;
            if (horizontal) {
                labelAnchor = point(along[c], low - labelGap);
                // The name climbs at −35° until it would meet the next rail up.
                const above = others.filter((x) => x < low - 1);
                const ceiling = above.length ? Math.max(...above) + F.railWidth / 2 + 6 : 0;
                const textLines = role === 'userStop' ? 3 : 2;
                const rise = labelAnchor.y - ceiling - textLines * fontSize * 1.25 * Math.cos(ANGLE);
                labelMaxWidth = Math.min(112, Math.max(40, rise / Math.sin(ANGLE)));
            } else {
                labelAnchor = point(along[c], high + labelGap);
                const after = others.filter((x) => x > high + 1);
                const wall = after.length ? Math.min(...after) - F.railWidth / 2 - 8 : contentAcross - 8;
                labelMaxWidth = Math.min(240, Math.max(48, wall - labelAnchor.x));
            }
            stops.push({
                id: `${c}#${stop.code}`, code: stop.code, name: stop.name,
                lineIDs: members.map((m) => lines[m].id),
                colorIndex: lines[first].colorIndex,
                center: point(along[c], (low + high) / 2),
                memberCenters, role,
                isPastUserStop: c > userColumn,
                isShared: members.length > 1,
                labelAnchor, labelMaxWidth,
            });
        }
    });

    // 7. Buses, on the same curves as the rails.
    const pucks = [];
    for (const vehicle of vehicles) {
        const line = lines.findIndex((l) => l.id === vehicle.lineID);
        if (line < 0) continue;
        const route = routeLines[line];
        const index = Math.min(Math.max(0, vehicle.lastStopIndex), route.stopCenters.length - 1);
        const center = index < route.segments.length
            ? segmentPoint(route.segments[index], vehicle.progressToNext ?? 0)
            : route.stopCenters[index];
        pucks.push({
            id: vehicle.id, vehicleID: vehicle.id, lineID: route.lineID, lineNumber: route.number,
            colorIndex: route.colorIndex, center, size: { width: 44, height: 34 }, cornerRadius: 10,
            fontSize: 18, haloWidth: 4, ringWidth: 4, isSelected: !!vehicle.isSelected, dimmed: false,
        });
    }

    const alongLength = along[along.length - 1] + (horizontal ? F.horizontalTrailingInset : F.verticalTrailingInset);
    return {
        axis,
        contentSize: horizontal ? { width: alongLength, height: contentAcross } : { width: contentAcross, height: alongLength },
        lines: routeLines, stops, pucks,
        userStopAlong: along[userColumn],
        railWidth: F.railWidth, ringRadius: F.ringRadius, ringStroke: F.ringStroke, nodeRadius: F.nodeRadius,
        badgeSide: F.badgeSide, labelRotation: horizontal ? -35 : 0, labelFontSize: fontSize,
        isEmpty: false,
    };
}

/**
 * Lanes in the order that keeps lines running together side by side, so no line has to cross
 * another to join its bundle. Ties keep the order the lines were picked in.
 * @returns {number[]} `lane[line]`, the lane each line runs in
 */
export function laneOrder(lineCount, groups, userColumn) {
    const identity = Array.from({ length: lineCount }, (_, i) => i);
    if (lineCount <= 2 || lineCount > 4) return identity;
    const penalty = (lane) => {
        let total = 0;
        groups.forEach((column, c) => {
            if (c === userColumn) return;
            for (const group of column) {
                if (group.length <= 1) continue;
                const lanes = group.map((g) => lane[g]);
                if (Math.max(...lanes) - Math.min(...lanes) !== group.length - 1) total += 1;
            }
        });
        return total;
    };
    let best = identity;
    let bestPenalty = penalty(identity);
    for (const order of permutations(identity)) {
        // `order[k]` is the line in lane k; `lane[line]` is the inverse.
        const lane = identity.slice();
        order.forEach((line, k) => { lane[line] = k; });
        const p = penalty(lane);
        if (p < bestPenalty) { best = lane; bestPenalty = p; }
    }
    return best;
}

function permutations(items) {
    if (items.length <= 1) return [items];
    return items.flatMap((head, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [head, ...rest]));
}

// MARK: - Lining the routes up

export const MATCH_SCORE = 4;
export const GAP_SCORE = -1;

/**
 * Lines up the stops of several routes into shared columns, as a diff lines up two texts.
 *
 * Every route is cut at the rider's stop, which is one column for all of them. The parts before it
 * are aligned to end there and the parts after it to start there. Within a part a stop two lines
 * share is worth a column of its own; stops a line has to itself sit beside the others' own stops
 * rather than after them, so independent stretches run in parallel instead of end to end.
 *
 * @param {string[][]} lines each line's stop codes
 * @param {number[]} userIndices
 * @returns {Array<Record<number, number>>} each column maps a line's index to its stop's index there
 */
export function alignRoutes(lines, userIndices) {
    const before = lines.map((codes, line) => codes.slice(0, userIndices[line]).map((code, stop) => ({ line, stop, code })));
    const after = lines.map((codes, line) => codes.slice(userIndices[line] + 1)
        .map((code, i) => ({ line, stop: userIndices[line] + 1 + i, code })));
    const userColumn = Object.fromEntries(lines.map((_, line) => [line, userIndices[line]]));
    // After the stop the parts start together, so they are aligned back to front, reversed.
    const reversedAfter = progressive(after.map((part) => part.slice().reverse()));
    return [...progressive(before), userColumn, ...reversedAfter.reverse()];
}

/** Aligns each part to the columns of the parts before it, ending all of them together. */
function progressive(parts) {
    let profile = [];
    for (const part of parts) {
        if (!part.length) continue;
        profile = profile.length ? align(profile, part) : part.map((entry) => [entry]);
    }
    return profile.map((column) => Object.fromEntries(column.map((e) => [e.line, e.stop])));
}

/**
 * Needleman–Wunsch with free leading gaps: the columns and the new part must end together, but
 * either may start later. Ties go to pairing, which pushes the gaps to the front.
 */
function align(profile, part) {
    const n = profile.length;
    const m = part.length;
    const score = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    const pair = (i, j) => (profile[i].some((e) => e.code === part[j].code) ? MATCH_SCORE : 0);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            score[i][j] = Math.max(score[i - 1][j - 1] + pair(i - 1, j - 1),
                score[i - 1][j] + GAP_SCORE,
                score[i][j - 1] + GAP_SCORE);
        }
    }
    const result = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && score[i][j] === score[i - 1][j - 1] + pair(i - 1, j - 1)) {
            result.push([...profile[i - 1], part[j - 1]]);
            i -= 1; j -= 1;
        } else if (i > 0 && (j === 0 || score[i][j] === score[i - 1][j] + GAP_SCORE)) {
            result.push(profile[i - 1]);
            i -= 1;
        } else {
            result.push([part[j - 1]]);
            j -= 1;
        }
    }
    return result.reverse();
}

// MARK: - Scrolling and the strip

/** Keeps a scroll offset inside the content; a content smaller than the view stays at zero. */
export function clampOffset(offset, visible, content) {
    return {
        x: Math.min(Math.max(0, offset.x), Math.max(0, content.width - visible.width)),
        y: Math.min(Math.max(0, offset.y), Math.max(0, content.height - visible.height)),
    };
}

/**
 * The scroll that puts the rider's stop in the middle of the view, kept inside the content. Across
 * too: lanes kept at their minimum can make the drawing taller (or wider) than the view, and the
 * rider's stop is not always in the first of them.
 */
export function centreOnUserStop(scene, viewport) {
    const node = scene.stops.find((s) => s.role === 'userStop');
    const horizontal = scene.axis === AXIS.horizontal;
    const across = node ? (horizontal ? node.center.y : node.center.x) : 0;
    const target = {
        along: scene.userStopAlong - (horizontal ? viewport.width : viewport.height) / 2,
        across: across - (horizontal ? viewport.height : viewport.width) / 2,
    };
    return clampOffset(horizontal ? { x: target.along, y: target.across } : { x: target.across, y: target.along },
        viewport, scene.contentSize);
}

/**
 * The strip under the full route: the whole of it squeezed into a few pixels, with a window on the
 * part the main view shows. The route always runs left to right in the strip, whichever way the
 * main view scrolls, so the strip reads the same in both orientations.
 * @param {{axis:string, content:{width:number,height:number}, strip:{width:number,height:number}}} minimap
 */
export function minimapScales({ axis, content, strip }) {
    const contentAlong = axis === AXIS.horizontal ? content.width : content.height;
    const contentAcross = axis === AXIS.horizontal ? content.height : content.width;
    return {
        along: contentAlong > 0 ? strip.width / contentAlong : 0,
        across: contentAcross > 0 ? strip.height / contentAcross : 0,
    };
}

/** A point of the content, in the strip. */
export function minimapPoint(minimap, p) {
    const k = minimapScales(minimap);
    const horizontal = minimap.axis === AXIS.horizontal;
    return { x: (horizontal ? p.x : p.y) * k.along, y: (horizontal ? p.y : p.x) * k.across };
}

/** What the main view shows (`visible`, a rect of the content), in the strip. */
export function minimapWindow(minimap, visible) {
    const a = minimapPoint(minimap, { x: visible.x, y: visible.y });
    const b = minimapPoint(minimap, { x: visible.x + visible.width, y: visible.y + visible.height });
    const x0 = Math.max(0, Math.min(a.x, b.x));
    const y0 = Math.max(0, Math.min(a.y, b.y));
    const x1 = Math.min(minimap.strip.width, Math.max(a.x, b.x));
    const y1 = Math.min(minimap.strip.height, Math.max(a.y, b.y));
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Where to scroll the main view so its window centres on a point of the strip. */
export function minimapOffset(minimap, stripPoint, visible) {
    const k = minimapScales(minimap);
    const along = k.along > 0 ? stripPoint.x / k.along : 0;
    const across = k.across > 0 ? stripPoint.y / k.across : 0;
    const centre = minimap.axis === AXIS.horizontal ? { x: along, y: across } : { x: across, y: along };
    return clampOffset({ x: centre.x - visible.width / 2, y: centre.y - visible.height / 2 }, visible, minimap.content);
}
