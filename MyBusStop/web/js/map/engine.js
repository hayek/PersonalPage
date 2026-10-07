// The map layout engine. Ported from BusBus/MapEngine/MapLayoutEngine.swift, RailPath.swift,
// MapScene.swift and LabelHeadroom.swift.
//
// Turns route data plus live positions into the plain-object scene the renderer draws.
//
// Pure and deterministic: no clock, no randomness, no DOM. It computes in (along, across) — along
// being the direction of travel — and converts to view coordinates exactly once, at the end, so
// landscape and portrait share every rule.
//
// Scene shapes (all coordinates in CSS px of the map area):
//   point   { x, y }            rect { x, y, width, height }
//   segment { type: 'line', from, to } | { type: 'cubic', from, c1, c2, to }
//         | { type: 'dashed', from, to, on, off }
//   scene   { axis, preset, scale, trunkLineID, rails, termini, dashes, stops, labels, pucks,
//             convergence, hintAnchor, stopAlong }

import { AXIS, PRESET, makeMetrics, labelMaxWidthFor, MONO_ADVANCE_EM, LINE_HEIGHT_EM, READABLE_MINIMUM, charCount } from './metrics.js';
import { RouteCompressor, JunctionDetector, hasJunction, range, rangeCount, drawnStopIndices } from './routes.js';

const pt = (x, y) => ({ x, y });
const ptEq = (a, b) => a !== null && b !== null && a.x === b.x && a.y === b.y;

// MARK: - Segments and rail paths

export const segmentStart = (s) => s.from;
export const segmentEnd = (s) => s.to;

/**
 * Where a rail sits, across, at a given point along it. Segments are in engine space, where `x`
 * is along and `y` is across.
 *
 * Straight and dashed segments interpolate linearly. A cubic is evaluated at
 * `u = (along - from.x) / (to.x - from.x)`, which is exact at both ends and stays within about two
 * points in the middle for the curve shapes used here — the control points never fold back on the
 * along axis, so `u` tracks the real parameter closely.
 */
export function railAcrossAt(segments, along) {
    if (segments.length === 0) return 0;
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (along <= first.from.x) return first.from.y;
    if (along >= last.to.x) return last.to.y;

    for (const segment of segments) {
        const a = segment.from;
        const b = segment.to;
        if (!(along >= a.x && along <= b.x)) continue;
        const span = b.x - a.x;
        const u = span > 0 ? (along - a.x) / span : 0;
        if (segment.type === 'cubic') {
            const v = 1 - u;
            return v * v * v * a.y + 3 * v * v * u * segment.c1.y + 3 * v * u * u * segment.c2.y + u * u * u * b.y;
        }
        return a.y + (b.y - a.y) * u;
    }
    // Between two segments (a gap should not happen): fall back to the nearest endpoint.
    for (let i = segments.length - 1; i >= 0; i--) if (segments[i].to.x <= along) return segments[i].to.y;
    return first.from.y;
}

/** Converts engine space (x = along, y = across) into the view's coordinates. */
export const AxisTransform = {
    point(p, axis) {
        return axis === AXIS.horizontal ? p : pt(p.y, p.x);
    },
    rect(r, axis) {
        return axis === AXIS.horizontal ? r : { x: r.y, y: r.x, width: r.height, height: r.width };
    },
    segment(s, axis) {
        if (axis !== AXIS.vertical) return s;
        const p = (q) => pt(q.y, q.x);
        if (s.type === 'cubic') return { type: 'cubic', from: p(s.from), c1: p(s.c1), c2: p(s.c2), to: p(s.to) };
        if (s.type === 'dashed') return { type: 'dashed', from: p(s.from), to: p(s.to), on: s.on, off: s.off };
        return { type: 'line', from: p(s.from), to: p(s.to) };
    },
};

// MARK: - Entry point

/**
 * @param {object} request
 * @param {Array<{id:string, number:string, colorIndex:number, stops:Array<{code:string,name:string}>}>} request.lines
 *   selection order, 1…3; each line's stops run terminus first … user's stop LAST.
 * @param {string} request.trunkLineID
 * @param {string} request.userStopCode
 * @param {Array<{id:string, lineID:string, lastStopIndex:number, progressToNext:number, isSelected?:boolean}>} [request.vehicles]
 * @param {'horizontal'|'vertical'} [request.axis]
 * @param {string} [request.preset]
 * @param {{width:number,height:number}} [request.canvasSize] the map area
 * @param {number} [request.scale] 1.0 at the reference size
 * @param {string[]|null} [request.namedLineIDs] lines whose stops get names; null = all.
 * @param {string|null} [request.highlightedLineID] everything else is dimmed.
 * @param {number|null} [request.tailBudget] @param {number|null} [request.headCount]
 * @param {number|null} [request.minimumStopPitch]
 */
export function layoutMap(request) {
    const req = {
        vehicles: [],
        axis: AXIS.horizontal,
        preset: PRESET.landscape,
        canvasSize: { width: 1280, height: 380 },
        scale: 1,
        namedLineIDs: null,
        highlightedLineID: null,
        tailBudget: null,
        headCount: null,
        minimumStopPitch: null,
        ...request,
    };
    const axis = req.axis;
    const alongExtent = axis === AXIS.horizontal ? req.canvasSize.width : req.canvasSize.height;
    const acrossExtent = axis === AXIS.horizontal ? req.canvasSize.height : req.canvasSize.width;
    const named = req.namedLineIDs ? new Set(req.namedLineIDs) : null;

    // 1. Drop anything that cannot be drawn: a line must reach the user's stop and have a route.
    const valid = req.lines.filter((line) =>
        line.stops.length >= 2 && line.stops.some((s) => s.code === req.userStopCode));
    const metrics = makeMetrics(req.preset, req.scale, valid.length);
    const tailBudget = Math.max(1, req.tailBudget ?? metrics.tailBudget);
    const headCount = Math.max(0, req.headCount ?? metrics.headCount);
    const minimumPitch = req.minimumStopPitch ?? 0;
    const center = acrossExtent / 2;
    const nodeAlong = alongExtent - metrics.nodeInsetFromEnd;

    const trunk = valid.find((l) => l.id === req.trunkLineID) ?? valid[0];
    if (!trunk) return emptyScene(req, metrics, nodeAlong, center);
    const others = valid.filter((l) => l.id !== trunk.id);

    // 2. Across position of each line's own rail.
    const rowAcross = acrossPositions(trunk, others, valid, center, metrics);

    // 3. Junctions, measured against the trunk only — never line against line.
    const junctions = new Map();
    for (const line of others) junctions.set(line.id, JunctionDetector.junction(line, trunk, req.userStopCode));

    // 4. Which side of the trunk each joined rail runs on. Two rails never share an offset.
    const parallelAcross = parallelSides(others, junctions, rowAcross, center, metrics);

    // 5. The trunk's shared corridor starts at the earliest junction any line makes with it.
    const trunkN = trunk.stops.length - 1;
    const junctionIndices = others.map((l) => junctions.get(l.id)?.trunkJunctionIndex).filter((v) => v !== null && v !== undefined);
    const trunkShared = junctionIndices.length > 0 ? range(Math.min(...junctionIndices), trunkN) : range(trunkN, trunkN);

    // 6. Compress and place the trunk.
    const lastTailAlong = nodeAlong - metrics.lastTailFromNode;
    const terminusEnd = metrics.terminusCenterAlong + metrics.terminusAlong / 2;
    let trunkCompressed = RouteCompressor.compress(trunk, trunkShared, headCount, tailBudget);
    let trunkPlacement = place(trunkCompressed.runs, metrics.firstStopAlong, lastTailAlong, terminusEnd, minimumPitch, metrics);
    // A canvas too short for the tail: spend the head on the dash instead of crushing the pitch.
    if (trunkPlacement.tailPitch < 0.6 * metrics.stopPitch && headCount > 0) {
        trunkCompressed = RouteCompressor.compress(trunk, trunkShared, 0, tailBudget);
        trunkPlacement = place(trunkCompressed.runs, metrics.firstStopAlong, lastTailAlong, terminusEnd, minimumPitch, metrics);
    }

    const layouts = [];
    const trunkLayout = newLineLayout({
        line: trunk, isTrunk: true, rowAcross: center, parallelAcross: null,
        junction: JunctionDetector.none, compressed: trunkCompressed,
        stopAlong: alongArray(trunk.stops.length, trunkPlacement, nodeAlong, metrics),
    });
    trunkLayout.drawnOwnIndices = drawnStopIndices(trunkCompressed.runs);
    layouts.push(trunkLayout);

    // 7. Place every other line against the trunk's positions.
    for (const line of others) {
        const junction = junctions.get(line.id) ?? JunctionDetector.none;
        const row = rowAcross.get(line.id) ?? center;
        const n = line.stops.length - 1;

        if (hasJunction(junction)) {
            const lineJunction = junction.lineJunctionIndex;
            const trunkJunction = junction.trunkJunctionIndex;
            const stopAlong = new Array(line.stops.length).fill(0);
            stopAlong[n] = nodeAlong;
            let drawnOwn = [];
            let dashSpans = [];
            // Shared stops take the trunk's positions, which is what makes capsules and bundle
            // dashes line up across the whole bundle.
            for (let j = lineJunction; j < n; j++) {
                const trunkIndex = trunkJunction + (j - lineJunction);
                stopAlong[j] = trunkLayout.stopAlong[Math.min(trunkIndex, trunkN)];
            }
            const junctionAlong = stopAlong[lineJunction];

            const ownRuns = trailingTrimmed(
                RouteCompressor.compress(line, range(lineJunction, n), headCount, tailBudget).runs, lineJunction);
            if (ownRuns.length > 0) {
                const placement = place(ownRuns, metrics.firstStopAlong,
                    Math.max(terminusEnd + metrics.stopPitch, junctionAlong - metrics.stopPitch),
                    terminusEnd, minimumPitch, metrics);
                for (const [index, along] of placement.positions) stopAlong[index] = along;
                drawnOwn = drawnStopIndices(ownRuns);
                dashSpans = placement.dashSpans;
            }
            stopAlong[0] = junction.lineIsSubsetOfTrunk ? junctionAlong : metrics.terminusCenterAlong;

            const layout = newLineLayout({
                line, isTrunk: false, rowAcross: row, parallelAcross: parallelAcross.get(line.id) ?? null,
                junction,
                compressed: { lineID: line.id, runs: ownRuns, ownTailCount: drawnOwn.length, sharedDashed: null },
                stopAlong,
            });
            layout.drawnOwnIndices = drawnOwn;
            layout.dashes = dashRuns(dashSpans, line.id, row, metrics, true);
            layouts.push(layout);
        } else {
            // Independent all the way: laid out exactly like the trunk, so the stop columns
            // still line up across rows.
            let compressed = RouteCompressor.compress(line, range(n, n), headCount, tailBudget);
            let placement = place(compressed.runs, metrics.firstStopAlong, lastTailAlong, terminusEnd, minimumPitch, metrics);
            if (placement.tailPitch < 0.6 * metrics.stopPitch && headCount > 0) {
                compressed = RouteCompressor.compress(line, range(n, n), 0, tailBudget);
                placement = place(compressed.runs, metrics.firstStopAlong, lastTailAlong, terminusEnd, minimumPitch, metrics);
            }
            const layout = newLineLayout({
                line, isTrunk: false, rowAcross: row, parallelAcross: null,
                junction: JunctionDetector.none, compressed,
                stopAlong: alongArray(line.stops.length, placement, nodeAlong, metrics),
            });
            layout.drawnOwnIndices = drawnStopIndices(compressed.runs);
            layout.dashes = dashRuns(placement.dashSpans, line.id, row, metrics, true);
            layouts.push(layout);
        }
    }

    layouts[0].dashes = dashRuns(trunkPlacement.dashSpans, trunk.id, center, metrics, true);

    // 8. Rails.
    const railsEnd = nodeAlong - metrics.railsEndFromNode;
    for (const layout of layouts) {
        layout.dimmed = req.highlightedLineID !== null && req.highlightedLineID !== undefined
            && layout.line.id !== req.highlightedLineID;
        layout.segments = railSegments(layout, trunkPlacement, center, nodeAlong, railsEnd, terminusEnd, metrics);
    }

    // 9. Bundle dashes repeat on every rail of the bundle, but the caption is written once.
    for (const layout of layouts) {
        if (layout.parallelAcross === null) continue;
        const trunkJunction = layout.junction.trunkJunctionIndex;
        if (trunkJunction === null || trunkJunction === undefined) continue;
        const shared = trunkPlacement.dashSpans.filter((s) => s.range.lower >= trunkJunction);
        layout.dashes = layout.dashes.concat(dashRuns(shared, layout.line.id, layout.parallelAcross, metrics, false));
    }

    // 10. Marks, labels and pucks.
    const marks = stopMarks(layouts, layouts[0], center, metrics);
    // Portrait names sit in a column outside the widest point of the bundle; landscape names rise
    // away from the rail and need no such clearance.
    const capsuleBottoms = marks.filter((m) => m.kind === 'capsule').map((m) => m.capsuleRect.y + m.capsuleRect.height);
    const labelColumn = axis === AXIS.vertical
        ? Math.max(center + metrics.labelOffset,
            (capsuleBottoms.length > 0 ? Math.max(...capsuleBottoms) : center) + 14 * req.scale)
        : center + metrics.labelOffset;
    const labels = stopLabels(layouts, req, named, center, labelColumn, metrics);
    const termini = terminusMarks(layouts, metrics);
    const pucks = puckMarks(layouts, req, nodeAlong, metrics);
    const convergence = convergenceMark(nodeAlong, center, metrics, axis);

    // 11. Convert to view coordinates.
    const rails = layouts.map((layout) => ({
        lineID: layout.line.id,
        colorIndex: layout.line.colorIndex,
        width: metrics.railWidth,
        segments: layout.segments.map((s) => AxisTransform.segment(s, axis)),
        isTrunk: layout.isTrunk,
        dimmed: layout.dimmed,
    }));
    // Non-trunk rails first so the trunk reads as the spine, drawn over them.
    const orderedRails = rails.filter((r) => !r.isTrunk).concat(rails.filter((r) => r.isTrunk));

    const stopAlongByLine = {};
    for (const layout of layouts) stopAlongByLine[layout.line.id] = layout.stopAlong;
    const dimmedByLine = new Map(layouts.map((l) => [l.line.id, l.dimmed]));

    const scene = {
        axis,
        preset: req.preset,
        scale: req.scale,
        trunkLineID: trunk.id,
        rails: orderedRails,
        termini: termini.map((m) => ({ ...m, rect: AxisTransform.rect(m.rect, axis) })),
        dashes: layouts.flatMap((l) => l.dashes).map((dash) => {
            const d = { ...dash };
            if (axis === AXIS.vertical) {
                // Put the caption in the same column as the names rather than centred on the
                // rail, where the words would sit on top of the track.
                if (Math.abs(dash.from.y - center) <= metrics.parallelOffset) {
                    d.labelCenter = pt(dash.labelCenter.x, labelColumn);
                    d.labelAlignment = 'leading';
                } else if (metrics.namesSitRightOfEveryRail) {
                    d.labelCenter = pt(dash.labelCenter.x, dash.from.y + metrics.labelOffset);
                    d.labelAlignment = 'leading';
                } else {
                    d.labelCenter = pt(dash.labelCenter.x, dash.from.y - metrics.trailingLabelOffset);
                    d.labelAlignment = 'trailing';
                }
            }
            d.from = AxisTransform.point(d.from, axis);
            d.to = AxisTransform.point(d.to, axis);
            d.labelCenter = AxisTransform.point(d.labelCenter, axis);
            d.dimmed = dimmedByLine.get(dash.lineID) ?? false;
            // A distance spine says where the bus is, not what it passes — so it carries no stop
            // names and no "+N STOPS" either.
            if (named && !named.has(dash.lineID)) d.showLabel = false;
            return d;
        }),
        stops: marks.map((m) => ({
            ...m,
            center: AxisTransform.point(m.center, axis),
            capsuleRect: AxisTransform.rect(m.capsuleRect, axis),
        })),
        labels: labels.map((l) => ({ ...l, anchor: AxisTransform.point(l.anchor, axis) })),
        pucks: pucks.map((p) => ({ ...p, center: AxisTransform.point(p.center, axis) })),
        convergence,
        hintAnchor: req.preset === PRESET.landscape
            ? AxisTransform.point(pt(40 * req.scale, acrossExtent - 32 * req.scale), axis)
            : null,
        stopAlong: stopAlongByLine,
    };
    return keepingNamesInside(scene, acrossExtent);
}

/** The rail of a line, for hit-testing and for placing pucks. */
export const sceneRail = (scene, lineID) => scene.rails.find((r) => r.lineID === lineID) ?? null;

// MARK: - Geometry helpers

function newLineLayout(fields) {
    return { drawnOwnIndices: [], dashes: [], segments: [], dimmed: false, ...fields };
}

function emptyScene(req, metrics, nodeAlong, center) {
    return {
        axis: req.axis, preset: req.preset, scale: req.scale, trunkLineID: '',
        rails: [], termini: [], dashes: [], stops: [], labels: [], pucks: [],
        convergence: convergenceMark(nodeAlong, center, metrics, req.axis),
        hintAnchor: null, stopAlong: {},
    };
}

/**
 * The trunk owns the centre. In landscape and on iPad the other lines take a side each; the phone
 * puts them all to the left so the trunk's names always own the right of the screen.
 */
function acrossPositions(trunk, others, selectionOrder, center, metrics) {
    const result = new Map([[trunk.id, center]]);
    if (others.length === 0) return result;

    if (metrics.rowsAreSigned) {
        if (others.length >= 2) {
            result.set(others[0].id, center - metrics.rowOffsets[0]);
            result.set(others[1].id, center + metrics.rowOffsets[1]);
        } else {
            const orderOf = (id) => Math.max(0, selectionOrder.findIndex((l) => l.id === id));
            const otherIsFirst = orderOf(others[0].id) < orderOf(trunk.id);
            result.set(others[0].id, otherIsFirst ? center - metrics.rowOffsets[0] : center + metrics.rowOffsets[0]);
        }
    } else {
        others.forEach((line, index) => {
            result.set(line.id, center - metrics.rowOffsets[Math.min(index, metrics.rowOffsets.length - 1)]);
        });
    }
    return result;
}

/**
 * A joined rail runs 18 pt above or below the trunk, keeping its own colour. Two rails of one
 * bundle never take the same offset: the line that joins earlier keeps the side it wants.
 */
function parallelSides(others, junctions, rowAcross, center, metrics) {
    const joined = others
        .filter((l) => hasJunction(junctions.get(l.id) ?? JunctionDetector.none))
        .sort((a, b) => (junctions.get(a.id).trunkJunctionIndex ?? 0) - (junctions.get(b.id).trunkJunctionIndex ?? 0));

    const used = new Set();
    const result = new Map();
    for (const line of joined) {
        const row = rowAcross.get(line.id) ?? center;
        let sign = metrics.rowsAreSigned ? (row < center ? -1 : 1) : -1;
        if (used.has(sign)) sign = -sign;
        used.add(sign);
        result.set(line.id, center + sign * metrics.parallelOffset);
    }
    return result;
}

/**
 * Places one contiguous stretch of a route: head stops run forward from the front, tail stops run
 * backwards from the end, and the dash takes whatever is between them.
 *
 * Returns `{ positions: Map<index, along>, dashSpans: [{ range, from, to }], tailPitch, lastDrawnAlong }`.
 */
function place(runs, firstAlong, endAlong, terminusEnd, minimumPitch, metrics) {
    const placement = { positions: new Map(), dashSpans: [], tailPitch: metrics.stopPitch, lastDrawnAlong: 0 };
    const drawn = drawnStopIndices(runs);
    if (drawn.length === 0) {
        placement.lastDrawnAlong = terminusEnd;
        return placement;
    }

    const clearance = 4 * metrics.scale;
    const firstDash = runs.findIndex((r) => r.kind === 'dash');
    if (firstDash < 0) {
        // Everything is drawn. Spread backwards from the end so stop columns still line up across
        // rows, never starting before the first-stop mark.
        const gaps = Math.max(1, drawn.length - 1);
        const pitch = Math.min(metrics.stopPitch, Math.max(0, (endAlong - firstAlong) / gaps));
        drawn.forEach((index, offset) => {
            placement.positions.set(index, endAlong - (drawn.length - 1 - offset) * pitch);
        });
        placement.tailPitch = pitch;
        placement.lastDrawnAlong = endAlong;
        return placement;
    }

    const head = drawnStopIndices(runs.slice(0, firstDash));
    const rest = runs.slice(firstDash);

    head.forEach((index, offset) => placement.positions.set(index, firstAlong + offset * metrics.stopPitch));
    const lastHeadAlong = head.length === 0 ? terminusEnd : (placement.positions.get(head[head.length - 1]) ?? firstAlong);

    // A route can need more than one dashed run — its own compression and the bundle's. Each dash
    // is a gap between two stops, and every stop that does not follow one is a pitch on from the
    // stop before it, so the space after the head divides into those two kinds of step.
    let dashCount = 0;
    let pitchSteps = 0;
    let followsDash = false;
    for (const run of rest) {
        if (run.kind === 'stop') {
            if (!followsDash) pitchSteps += 1;
            followsDash = false;
        } else {
            dashCount += 1;
            followsDash = true;
        }
    }

    // Shrink the tail pitch, not the dash: a dash below its minimum length stops reading as one.
    const room = endAlong - lastHeadAlong;
    let tailPitch = metrics.stopPitch;
    if (pitchSteps > 0) {
        const reserved = dashCount * (2 * (metrics.ringOuter + clearance) + metrics.minimumDashLength);
        tailPitch = Math.min(metrics.stopPitch, Math.max(0, (room - reserved) / pitchSteps));
        // Held apart where the caller asks, out of the dashes' share, as far as there is room.
        if (dashCount > 0) tailPitch = Math.max(tailPitch, Math.min(minimumPitch, room / pitchSteps));
    }
    placement.tailPitch = tailPitch;
    // Whatever the stops leave over belongs to the dashes, shared evenly between them.
    const dashGap = dashCount > 0 ? (room - pitchSteps * tailPitch) / dashCount : 0;

    let cursor = lastHeadAlong;
    let cursorIsStop = head.length > 0;
    for (const run of rest) {
        if (run.kind === 'stop') {
            if (cursorIsStop) cursor += tailPitch;
            placement.positions.set(run.index, cursor);
            cursorIsStop = true;
        } else {
            const swallowed = run.swallowed;
            const from = cursor + (cursorIsStop ? metrics.ringOuter + clearance : clearance);
            const nextStopAlong = cursor + dashGap;
            const to = Math.max(from, nextStopAlong - metrics.ringOuter - clearance);
            placement.dashSpans.push({ range: swallowed, from, to });

            // Swallowed stops still exist: give them positions inside the dash so a bus crossing
            // that stretch keeps moving smoothly instead of jumping.
            const steps = rangeCount(swallowed) + 1;
            for (let index = swallowed.lower, offset = 0; index < swallowed.upper; index++, offset++) {
                placement.positions.set(index, from + (to - from) * (offset + 1) / steps);
            }
            cursor = nextStopAlong;
            cursorIsStop = false;
        }
    }

    placement.lastDrawnAlong = endAlong;
    return placement;
}

function alongArray(count, placement, nodeAlong, metrics) {
    const result = new Array(count).fill(0);
    result[0] = metrics.terminusCenterAlong;
    if (count > 1) result[count - 1] = nodeAlong;
    for (const [index, along] of placement.positions) {
        if (index >= 0 && index < count) result[index] = along;
    }
    return result;
}

/** Keeps only the runs belonging to a line's own segment, before it reaches the trunk. */
function trailingTrimmed(runs, limit) {
    return runs.filter((run) => (run.kind === 'stop' ? run.index < limit : run.swallowed.upper <= limit));
}

function dashRuns(spans, lineID, across, metrics, showLabel) {
    return spans.map((span) => ({
        id: `${lineID}#dash${span.range.lower}-${span.range.upper}`,
        lineID,
        from: pt(span.from, across),
        to: pt(span.to, across),
        swallowedCount: rangeCount(span.range),
        fontSize: metrics.dashFontSize,
        trackingEm: metrics.dashTrackingEm,
        labelCenter: pt((span.from + span.to) / 2, across + metrics.dashLabelOffset),
        // Landscape centres the caption under its dash; portrait aligns it in the name column.
        labelAlignment: 'center',
        // False on the non-trunk rails of a shared bundle dash — the stops are the same, so the
        // "+N STOPS" caption is written once.
        showLabel,
        dimmed: false,
    }));
}

/** Solid stretches broken by the dashed runs that fall inside them. */
function pieces(start, end, dashes) {
    const result = [];
    let cursor = start;
    const sorted = dashes.slice().sort((a, b) => a.from - b.from);
    for (const dash of sorted) {
        if (!(dash.from >= start && dash.to <= end)) continue;
        if (dash.from > cursor) result.push({ from: cursor, to: dash.from, dashed: false });
        result.push({ from: dash.from, to: dash.to, dashed: true });
        cursor = dash.to;
    }
    if (end > cursor) result.push({ from: cursor, to: end, dashed: false });
    return result;
}

function segmentsFrom(pieceList, across, metrics) {
    const result = [];
    for (const piece of pieceList) {
        const from = pt(piece.from, across);
        const to = pt(piece.to, across);
        const previous = result[result.length - 1];
        if (piece.dashed) {
            result.push({ type: 'dashed', from, to, on: metrics.dashOn, off: metrics.dashOff });
        } else if (previous && previous.type === 'line' && ptEq(previous.to, from) && previous.from.y === across) {
            // Merge collinear solid stretches so a rail reads as one run of track.
            result[result.length - 1] = { type: 'line', from: previous.from, to };
        } else {
            result.push({ type: 'line', from, to });
        }
    }
    return result;
}

const dashSpanPairs = (spans) => spans.map((s) => ({ from: s.from, to: s.to }));
const dashRunPairs = (dashes) => dashes.map((d) => ({ from: d.from.x, to: d.to.x }));

// MARK: - Rails, marks, labels, pucks

function railSegments(layout, trunkPlacement, center, nodeAlong, railsEnd, terminusEnd, metrics) {
    if (layout.isTrunk) {
        // The spine: dead straight from its terminus to the stub, and it never bends.
        return segmentsFrom(pieces(terminusEnd, railsEnd, dashSpanPairs(trunkPlacement.dashSpans)), center, metrics);
    }

    const parallel = layout.parallelAcross;
    const lineJunction = layout.junction.lineJunctionIndex;
    const trunkJunction = layout.junction.trunkJunctionIndex;
    if (parallel === null || lineJunction === null || lineJunction === undefined
        || trunkJunction === null || trunkJunction === undefined) {
        // Independent rail: one curve into the stub at the very end.
        const curveStart = nodeAlong - metrics.curveStartFromNode;
        const result = segmentsFrom(pieces(terminusEnd, curveStart, dashRunPairs(layout.dashes)), layout.rowAcross, metrics);
        result.push({
            type: 'cubic',
            from: pt(curveStart, layout.rowAcross),
            c1: pt(nodeAlong - metrics.curveC1FromNode, layout.rowAcross),
            c2: pt(nodeAlong - metrics.curveC2FromNode, center),
            to: pt(railsEnd, center),
        });
        return result;
    }

    let result = [];
    const junctionAlong = layout.stopAlong[lineJunction];

    if (layout.drawnOwnIndices.length > 0) {
        // Its own route, then one curve onto the trunk's shoulder.
        const ownEnd = junctionAlong - metrics.junctionCurveLength;
        result = segmentsFrom(pieces(terminusEnd, ownEnd, dashRunPairs(layout.dashes)), layout.rowAcross, metrics);
        const mid = junctionAlong - metrics.junctionCurveLength / 2;
        result.push({
            type: 'cubic',
            from: pt(ownEnd, layout.rowAcross),
            c1: pt(mid, layout.rowAcross),
            c2: pt(mid, parallel),
            to: pt(junctionAlong, parallel),
        });
    }

    // From the junction on it runs parallel to the trunk, keeping its own colour, over exactly the
    // stops the trunk draws — which is what makes the bundle read as one corridor.
    const joinedCurveStart = nodeAlong - metrics.joinedCurveStartFromNode;
    const sharedDashes = trunkPlacement.dashSpans.filter((s) => s.range.lower >= trunkJunction);
    result = result.concat(segmentsFrom(pieces(junctionAlong, joinedCurveStart, dashSpanPairs(sharedDashes)), parallel, metrics));
    result.push({
        type: 'cubic',
        from: pt(joinedCurveStart, parallel),
        c1: pt(nodeAlong - metrics.joinedCurveC1FromNode, parallel),
        c2: pt(nodeAlong - metrics.joinedCurveC2FromNode, center),
        to: pt(railsEnd, center),
    });
    return result;
}

const ZERO_RECT = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

/**
 * A stop served by more than one drawn line is one capsule spanning the whole bundle — the
 * interchange mark. A stop on a single line is a ring in that line's colour.
 */
function stopMarks(layouts, trunkLayout, center, metrics) {
    const rings = [];
    const capsules = [];
    const joined = layouts.filter((l) => l.parallelAcross !== null);
    const trunkLast = trunkLayout.line.stops.length - 1;

    for (const index of trunkLayout.drawnOwnIndices) {
        if (index >= trunkLast) continue;
        const along = trunkLayout.stopAlong[index];
        const code = trunkLayout.line.stops[index].code;
        const active = joined.filter((l) => (l.junction.trunkJunctionIndex ?? Infinity) <= index);

        if (active.length === 0) {
            rings.push(ring(`${trunkLayout.line.id}#${index}`, code, pt(along, center), trunkLayout.line.colorIndex,
                [trunkLayout.line.id], trunkLayout.dimmed, metrics));
        } else {
            const acrossValues = [center].concat(active.map((l) => l.parallelAcross));
            const lowest = Math.min(...acrossValues);
            const highest = Math.max(...acrossValues);
            capsules.push({
                id: `shared#${code}#${index}`,
                stopCode: code,
                kind: 'capsule',
                colorIndex: null,
                center: pt(along, (lowest + highest) / 2),
                ringRadius: 0,
                strokeWidth: metrics.capsuleStroke,
                capsuleRect: {
                    x: along - metrics.capsuleWidth / 2,
                    y: lowest - metrics.capsuleMargin,
                    width: metrics.capsuleWidth,
                    height: (highest - lowest) + 2 * metrics.capsuleMargin,
                },
                capsuleCornerRadius: metrics.capsuleCornerRadius,
                lineIDs: [trunkLayout.line.id].concat(active.map((l) => l.line.id)),
                dimmed: trunkLayout.dimmed && active.every((l) => l.dimmed),
            });
        }
    }

    for (const layout of layouts) {
        if (layout.isTrunk) continue;
        const last = layout.line.stops.length - 1;
        for (const index of layout.drawnOwnIndices) {
            if (index >= last) continue;
            rings.push(ring(`${layout.line.id}#${index}`, layout.line.stops[index].code,
                pt(layout.stopAlong[index], layout.rowAcross), layout.line.colorIndex, [layout.line.id],
                layout.dimmed, metrics));
        }
    }

    return rings.concat(capsules);
}

function ring(id, code, center, colorIndex, lineIDs, dimmed, metrics) {
    return {
        id, stopCode: code, kind: 'ring', colorIndex, center,
        ringRadius: metrics.ringRadius, strokeWidth: metrics.ringStroke,
        capsuleRect: ZERO_RECT, capsuleCornerRadius: 0, lineIDs, dimmed,
    };
}

/**
 * Stop names sit at −35° in landscape, anchored at the dot and rising to the right: parallel lines
 * of text can never collide, so a name can be any length. Portrait has room to set them
 * horizontally, outside each rail.
 *
 * A label's `anchor` is, in landscape, the bottom-left corner of the (unrotated) text box, which is
 * also the rotation anchor; in portrait, the vertical centre of the text's leading (or trailing)
 * edge. `role` is 'terminus' | 'stop' | 'junction'.
 */
function stopLabels(layouts, req, named, center, trunkLabelAcross, metrics) {
    const labels = [];
    const joined = layouts.filter((l) => l.parallelAcross !== null);
    const junctionIndices = new Set(joined.map((l) => l.junction.trunkJunctionIndex).filter((v) => v !== null && v !== undefined));

    function anchor(along, across, onBundle) {
        if (metrics.labelRotation !== 0) return [pt(along, across - metrics.labelOffset), 'leading'];
        // Names on the bundle share one column, set clear of the widest capsule.
        if (onBundle) return [pt(along, trunkLabelAcross), 'leading'];
        if (metrics.namesSitRightOfEveryRail) return [pt(along, across + metrics.labelOffset), 'leading'];
        return [pt(along, across - metrics.trailingLabelOffset), 'trailing'];
    }

    /** How high the bundle reaches at a given trunk stop, so a name can clear the capsule there. */
    function bundleTop(index) {
        const active = joined.filter((l) => (l.junction.trunkJunctionIndex ?? Infinity) <= index);
        if (active.length === 0) return center;
        return Math.min(center, Math.min(...active.map((l) => l.parallelAcross))) - metrics.capsuleMargin;
    }

    const make = (layout, id, index, point, alignment, role) => {
        const stop = layout.line.stops[index];
        return {
            id, lineID: layout.line.id, stopCode: stop.code, text: stop.name.toUpperCase(),
            anchor: point, rotationDegrees: metrics.labelRotation, alignment, role,
            colorIndex: layout.line.colorIndex,
            fontSize: metrics.stopNameFontSize, trackingEm: metrics.stopNameTrackingEm,
            // Zero when the name runs as far as it likes on one line.
            maxWidth: labelMaxWidthFor(metrics, stop.name),
            lineLimit: metrics.labelLineLimit,
            dimmed: layout.dimmed,
        };
    };

    for (const layout of layouts) {
        if (named && !named.has(layout.line.id)) continue;
        const isTrunk = layout.isTrunk;
        // A line drawn entirely on the bundle starts there, so its terminus name belongs to the
        // bundle's column; every other name is set beside the line's own rail.
        const startsOnBundle = layout.parallelAcross !== null && layout.drawnOwnIndices.length === 0;
        const across = startsOnBundle ? layout.parallelAcross : layout.rowAcross;

        const [terminusAnchor, terminusAlignment] = anchor(layout.stopAlong[0], across, isTrunk || startsOnBundle);
        labels.push(make(layout, `${layout.line.id}#terminus`, 0, terminusAnchor, terminusAlignment, 'terminus'));

        const last = layout.line.stops.length - 1;
        for (const index of layout.drawnOwnIndices) {
            if (index >= last) continue;
            // A stop shared by the bundle is named once, from the trunk's row, and clears the
            // capsule rather than the rail.
            const markAcross = isTrunk ? bundleTop(index) : layout.rowAcross;
            const [point, alignment] = anchor(layout.stopAlong[index], markAcross, isTrunk);
            const role = isTrunk && junctionIndices.has(index) ? 'junction' : 'stop';
            labels.push(make(layout, `${layout.line.id}#${index}`, index, point, alignment, role));
        }
    }
    return labels;
}

/** `style` is 'bar' (landscape: rounded bar in the line colour) or 'badge' (portrait: carries the number). */
function terminusMarks(layouts, metrics) {
    return layouts.map((layout) => {
        // A line that lies entirely on the trunk starts on the parallel rail, at the junction.
        const across = layout.drawnOwnIndices.length === 0 && layout.parallelAcross !== null
            ? layout.parallelAcross : layout.rowAcross;
        return {
            id: layout.line.id,
            lineID: layout.line.id,
            colorIndex: layout.line.colorIndex,
            rect: {
                x: layout.stopAlong[0] - metrics.terminusAlong / 2,
                y: across - metrics.terminusAcross / 2,
                width: metrics.terminusAlong,
                height: metrics.terminusAcross,
            },
            cornerRadius: metrics.terminusCornerRadius,
            style: metrics.terminusIsBadge ? 'badge' : 'bar',
            number: layout.line.number,
            fontSize: metrics.terminusFontSize,
            dimmed: layout.dimmed,
        };
    });
}

function puckMarks(layouts, req, nodeAlong, metrics) {
    const pucks = [];
    for (const vehicle of req.vehicles) {
        const layout = layouts.find((l) => l.line.id === vehicle.lineID);
        if (!layout) continue;
        const last = layout.line.stops.length - 1;
        if (last < 1) continue;
        const index = Math.min(Math.max(Math.trunc(vehicle.lastStopIndex) || 0, 0), last - 1);
        const from = layout.stopAlong[index];
        const to = layout.stopAlong[index + 1];
        const selected = !!vehicle.isSelected;
        const size = selected ? metrics.selectedPuckSize : metrics.puckSize;
        // The white stub is the last stretch into the rider's own stop; a bus stops short of it
        // rather than being drawn over the one mark that says the route ends here.
        const puckAlong = req.axis === AXIS.horizontal ? size.width : size.height;
        const limit = nodeAlong - metrics.stubStartFromNode - (puckAlong / 2 + metrics.puckHalo + metrics.puckRing);
        const progress = Math.min(Math.max(Number(vehicle.progressToNext) || 0, 0), 1);
        const along = Math.min(from + (to - from) * progress, limit);
        const across = railAcrossAt(layout.segments, along);
        pucks.push({
            id: vehicle.id, vehicleID: vehicle.id, lineID: layout.line.id,
            lineNumber: layout.line.number, colorIndex: layout.line.colorIndex,
            center: pt(along, across), size,
            cornerRadius: metrics.puckCornerRadius, fontSize: metrics.puckFontSize,
            haloWidth: metrics.puckHalo, ringWidth: metrics.puckRing,
            isSelected: selected, dimmed: layout.dimmed,
        });
    }
    // The bus you are waiting for is drawn last so its ring is never clipped by another puck.
    return pucks.filter((p) => !p.isSelected).concat(pucks.filter((p) => p.isSelected));
}

function convergenceMark(nodeAlong, center, metrics, axis) {
    const p = (along, across) => AxisTransform.point(pt(along, across), axis);
    return {
        stubFrom: p(nodeAlong - metrics.stubStartFromNode, center),
        stubTo: p(nodeAlong - metrics.stubEndFromNode, center),
        stubWidth: metrics.stubWidth,
        nodeCenter: p(nodeAlong, center),
        nodeRadius: metrics.nodeRadius,           // centre-line radius
        nodeStrokeWidth: metrics.nodeStroke,
        captionAnchor: p(nodeAlong, center + metrics.captionOffset),
        captionAlignment: 'leading',
        captionIsBelow: axis === AXIS.horizontal, // landscape: the caption sits under the node
        captionFontSize: metrics.captionFontSize,
        captionTrackingEm: metrics.captionTrackingEm,
    };
}

// MARK: - Label headroom

/**
 * The name broken between words the way SwiftUI's `Text` breaks it inside `maxWidth`, up to
 * `lineLimit`. Shared with the renderer so what is measured is what is drawn. `truncated` is true
 * when words were left over.
 */
export function wrapLabelLines(text, maxWidth, glyphWidth, lineLimit) {
    if (!(maxWidth > 0)) return { lines: [text], truncated: false };
    const capacity = Math.max(1, Math.floor(maxWidth / glyphWidth));
    const lines = [];
    for (const word of text.split(' ').filter((w) => w.length > 0)) {
        const last = lines[lines.length - 1];
        if (last !== undefined && charCount(last) + 1 + charCount(word) <= capacity) {
            lines[lines.length - 1] = `${last} ${word}`;
        } else {
            lines.push(word);
        }
    }
    const limit = Math.max(1, lineLimit);
    return { lines: lines.slice(0, limit), truncated: lines.length > limit };
}

/**
 * How high an angled name reaches: at the size it is drawn, held at the readable floor, or at the
 * size the layout gave it. Only angled names climb; a portrait name sits in its column.
 */
function labelTopEdge(label, atReadableFloor) {
    if (label.rotationDegrees === 0) return label.anchor.y;
    const drawn = atReadableFloor ? Math.max(READABLE_MINIMUM, label.fontSize) : label.fontSize;
    // Space Mono is monospaced; tracking is set from the geometric size.
    const glyph = drawn * MONO_ADVANCE_EM + label.fontSize * label.trackingEm;
    const { lines } = wrapLabelLines(label.text, label.maxWidth, glyph, label.lineLimit);
    const width = Math.max(0, ...lines.map(charCount)) * glyph;
    const height = lines.length * drawn * LINE_HEIGHT_EM;
    // The text box is anchored at its bottom-leading corner and turned about it, so its top corner
    // is the far end of the top line.
    const angle = Math.abs(label.rotationDegrees) * Math.PI / 180;
    return label.anchor.y - (width * Math.sin(angle) + height * Math.cos(angle));
}

/**
 * Keeps the angled names of a landscape map inside it.
 *
 * A name rises up and to the right of its stop, so the top row's names need room above the row.
 * The design leaves that room at its own sizes, but a name is never drawn below READABLE_MINIMUM:
 * on a small board the names are larger than the map was laid out for, and the top row's climb
 * further than the design allows, into the header. The scene is then moved down by that extra
 * climb, as far as the room under it allows, giving up the "TAP A BUS" hint when that is what it
 * takes. A full-size board is unchanged.
 */
export function keepingNamesInside(scene, height) {
    if (scene.axis !== AXIS.horizontal) return scene;
    // Only what the floor adds: at its own sizes the design lets the top row's names reach into
    // the space the header leaves, and a full-size board is left exactly as drawn.
    const minOf = (values) => (values.length > 0 ? Math.min(...values) : 0);
    const designed = Math.max(0, -minOf(scene.labels.map((l) => labelTopEdge(l, false))));
    const drawn = Math.max(0, -minOf(scene.labels.map((l) => labelTopEdge(l, true))));
    const overflow = drawn - designed;
    if (!(overflow > 0.5)) return scene;
    const lowest = lowestEdge(scene);
    const shift = Math.min(overflow, Math.max(0, floorOfRoom(scene, height) - lowest));
    if (shift < overflow && scene.hintAnchor) {
        // Not enough room above the "TAP A BUS" hint. The hint is only there until the first tap,
        // and the names are what the map is read by, so they take its room.
        const fuller = Math.min(overflow, Math.max(0, height - lowest));
        if (fuller > shift) return { ...offsetScene(scene, 0, fuller), hintAnchor: null };
    }
    return shift > 0 ? { ...offsetScene(scene, 0, shift), hintAnchor: scene.hintAnchor } : scene;
}

/** Where the room under the map ends: the "TAP A BUS" hint where there is one, else the edge. */
function floorOfRoom(scene, height) {
    if (!scene.hintAnchor) return height;
    return scene.hintAnchor.y - Math.max(READABLE_MINIMUM, 11 * scene.scale) * LINE_HEIGHT_EM / 2;
}

/** The lowest thing drawn: a rail, a puck, a "+N STOPS" caption or the YOUR STOP caption. */
function lowestEdge(scene) {
    const edges = [];
    for (const rail of scene.rails) {
        for (const s of rail.segments) edges.push(s.from.y + rail.width / 2, s.to.y + rail.width / 2);
    }
    for (const p of scene.pucks) edges.push(p.center.y + p.size.height / 2 + p.haloWidth);
    for (const d of scene.dashes) {
        if (d.showLabel) edges.push(d.labelCenter.y + Math.max(READABLE_MINIMUM, d.fontSize) * LINE_HEIGHT_EM / 2);
    }
    const c = scene.convergence;
    edges.push(c.captionAnchor.y + Math.max(READABLE_MINIMUM, c.captionFontSize) * LINE_HEIGHT_EM);
    return edges.length > 0 ? Math.max(...edges) : 0;
}

/** Everything drawn, moved as one. */
export function offsetScene(scene, dx, dy) {
    const move = (p) => pt(p.x + dx, p.y + dy);
    const moveRect = (r) => ({ ...r, x: r.x + dx, y: r.y + dy });
    const moveSegment = (s) => (s.type === 'cubic'
        ? { ...s, from: move(s.from), c1: move(s.c1), c2: move(s.c2), to: move(s.to) }
        : { ...s, from: move(s.from), to: move(s.to) });
    return {
        ...scene,
        rails: scene.rails.map((r) => ({ ...r, segments: r.segments.map(moveSegment) })),
        termini: scene.termini.map((t) => ({ ...t, rect: moveRect(t.rect) })),
        dashes: scene.dashes.map((d) => ({ ...d, from: move(d.from), to: move(d.to), labelCenter: move(d.labelCenter) })),
        stops: scene.stops.map((s) => ({ ...s, center: move(s.center), capsuleRect: moveRect(s.capsuleRect) })),
        labels: scene.labels.map((l) => ({ ...l, anchor: move(l.anchor) })),
        pucks: scene.pucks.map((p) => ({ ...p, center: move(p.center) })),
        convergence: {
            ...scene.convergence,
            stubFrom: move(scene.convergence.stubFrom),
            stubTo: move(scene.convergence.stubTo),
            nodeCenter: move(scene.convergence.nodeCenter),
            captionAnchor: move(scene.convergence.captionAnchor),
        },
        hintAnchor: scene.hintAnchor ? move(scene.hintAnchor) : null,
    };
}
