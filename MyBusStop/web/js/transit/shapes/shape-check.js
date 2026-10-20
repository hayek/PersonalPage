// Checks a shape against the stops it is meant to serve, and the small geometry the providers need
// to assemble one. Port of BusBus/Transit/Shapes/ShapeCheck.swift; the rules come from checking every
// region live (BusBus docs/research/route-shapes.md §2).

/**
 * How far from the drawn line a stop may stand, in metres, before the shape is judged not to be this
 * line's: `stops` along the way, `ends` for the first and last stop, which often stand in a terminal or
 * bus station off the road.
 */
export const TOLERANCE = Object.freeze({
    /** Stop coordinates are the pole on the kerb. */
    platforms: Object.freeze({ stops: 50, ends: 150 }),
    /** Stop coordinates are the centre of a stop area serving both directions (a station's centre). */
    stopAreas: Object.freeze({ stops: 200, ends: 200 }),
});

/**
 * A RouteShape's branches, with lines too short to draw dropped. Also takes a bare list of branches, or
 * a bare point list as one branch.
 */
function branchesOf(shape) {
    const branches = !Array.isArray(shape) ? shape?.branches ?? [] : Array.isArray(shape[0]) ? shape : [shape];
    return branches.filter((b) => b.length >= 2);
}

const rejected = (reason, worstOffset) => ({ accepted: false, reason, worstOffset: worstOffset ?? null });

// ---------------------------------------------------------------------------------------------
// Verdict

/**
 * A shape passes when every stop is near it, in order along a single branch (loops and streets driven
 * twice included), and it is not merely straight lines between the stops. With several branches each
 * stop only has to be near one of them: they are variants. Length is not judged — real mountain and
 * express routes run more than twice their stops' straight-line distance.
 * @param {{branches: GeoPoint[][]}|GeoPoint[]} shape
 * @param {GeoPoint[]} stops  In route order.
 * @returns {{accepted: boolean, reason: string|null, worstOffset: number|null}}
 */
export function verdict(shape, stops, tolerance = TOLERANCE.platforms) {
    const branches = branchesOf(shape);
    if (!branches.length) return rejected('no geometry');
    if (stops.length < 2) return { accepted: true, reason: null, worstOffset: 0 };
    if (isStraightLines({ branches }, stops)) return rejected('straight lines between stops');

    let offsets;
    if (branches.length === 1) {
        offsets = orderedOffsets(branches[0], stops);
        if (!offsets) return rejected('stops are not in order along the line');
    } else {
        const projections = branches.map((b) => new Projection(b));
        offsets = stops.map((stop) => Math.min(...projections.map((p) => p.nearest(stop))));
    }

    const max = Math.max(...offsets);
    const worst = Number.isFinite(max) ? max : null;
    for (let index = 0; index < offsets.length; index++) {
        const offset = offsets[index];
        const isEnd = index === 0 || index === offsets.length - 1;
        const limit = isEnd ? tolerance.ends : tolerance.stops;
        if (offset > limit) {
            const how = Number.isFinite(offset) ? `${Math.trunc(offset)} m` : 'far';
            return rejected(`stop ${index + 1} of ${offsets.length} is ${how} from the line`, worst);
        }
    }
    return { accepted: true, reason: null, worstOffset: worst ?? 0 };
}

/**
 * A feed with no real shape sometimes sends the stops joined up: nearly every vertex is a stop. Real
 * shapes had 0.2–8 % of their vertices on a stop.
 */
export function isStraightLines(shape, stops) {
    const vertices = branchesOf(shape).flat();
    if (vertices.length < 2) return true;
    const frame = new LocalFrame(vertices[0]);
    const grid = new PointGrid(stops.map((s) => frame.xy(s)), 20);
    const onStops = vertices.filter((v) => grid.hasPoint(10, frame.xy(v))).length;
    return onStops / vertices.length >= 0.8;
}

/**
 * Each stop's distance from the line when the stops are matched in travel order, or null when they
 * cannot all be matched in order.
 */
export function orderedOffsets(line, stops, searchRadius = 400) {
    return orderedMatches(line, stops, searchRadius)?.map((m) => m.offset) ?? null;
}

const before = (a, b) => a.worst < b.worst || (a.worst === b.worst && a.sum < b.sum);

/**
 * Where each stop meets the line ({along, offset}) when matched in order. Dynamic programming over every
 * place a stop comes near the line, minimising the worst offset: a stop on a street the line drives twice
 * may take either pass, but never one behind the previous stop.
 */
export function orderedMatches(line, stops, searchRadius = 400) {
    if (line.length < 2 || !stops.length) return null;
    const projection = new Projection(line);
    const candidates = stops.map((s) => projection.candidates(s, searchRadius));
    if (!candidates.every((c) => c.length)) return null;

    // best[i][j]: {worst, sum} of the cheapest in-order assignment ending with stop i on candidate j.
    const best = [candidates[0].map((c) => ({ worst: c.offset, sum: c.offset, from: -1 }))];
    for (let i = 1; i < candidates.length; i++) {
        const row = [];
        for (const candidate of candidates[i]) {
            let chosen = null;
            candidates[i - 1].forEach((previous, j) => {
                if (previous.along > candidate.along + 1) return;
                const earlier = best[i - 1][j];
                if (!Number.isFinite(earlier.worst)) return;
                const option = { worst: Math.max(earlier.worst, candidate.offset), sum: earlier.sum + candidate.offset, from: j };
                // On a tie the later pass wins: the shortest stretch between the two stops.
                if (!chosen || !before(chosen, option)) chosen = option;
            });
            row.push(chosen ?? { worst: Infinity, sum: Infinity, from: -1 });
        }
        best.push(row);
    }

    const lastRow = best[best.length - 1];
    let last = 0;
    for (let j = 1; j < lastRow.length; j++) if (before(lastRow[j], lastRow[last])) last = j;
    if (!Number.isFinite(lastRow[last].worst)) return null;

    const matches = new Array(stops.length);
    let j = last;
    for (let i = stops.length - 1; i >= 0; i--) {
        matches[i] = candidates[i][j];
        j = best[i][j].from;
    }
    return matches;
}

// ---------------------------------------------------------------------------------------------
// Assembling a shape

/**
 * The line pointing the way the stops run: reversed when it starts nearer the last stop than the
 * first (some feeds store a direction backwards).
 */
export function oriented(line, stops) {
    if (stops.length < 2 || !line.length) return line;
    const start = line[0];
    return meters(start, stops[stops.length - 1]) < meters(start, stops[0]) ? line.slice().reverse() : line;
}

/**
 * Of several candidate lines (a feed's branches, duplicates, short workings), the shortest one that
 * passes for these stops, turned to run their way. Null when none passes.
 */
export function bestPiece(pieces, stops, tolerance = TOLERANCE.platforms) {
    const seen = new Set();
    let chosen = null, chosenLength = Infinity;
    for (const piece of pieces.map((p) => oriented(p, stops))) {
        if (piece.length < 2) continue;
        const key = piece.map((p) => `${p.lat},${p.lon}`).join(';');
        if (seen.has(key)) continue;
        seen.add(key);
        if (!verdict({ branches: [piece] }, stops, tolerance).accepted) continue;
        const pieceLength = length(piece);
        if (pieceLength < chosenLength) { chosen = piece; chosenLength = pieceLength; }
    }
    return chosen;
}

/**
 * Joins pieces that meet end to end (within `gap` metres), reversing a piece where it runs the other
 * way. Pieces that join nothing stay separate, so the result may be several branches.
 */
export function chained(pieces, gap = 30) {
    const remaining = pieces.filter((p) => p.length >= 2);
    const chains = [];
    while (remaining.length) {
        let chain = remaining.shift();
        let grew = true;
        while (grew) {
            grew = false;
            for (let index = 0; index < remaining.length; index++) {
                const piece = remaining[index];
                const reversed = () => piece.slice().reverse();
                if (meters(chain.at(-1), piece[0]) <= gap) chain = chain.concat(piece.slice(1));
                else if (meters(chain.at(-1), piece.at(-1)) <= gap) chain = chain.concat(reversed().slice(1));
                else if (meters(piece.at(-1), chain[0]) <= gap) chain = piece.concat(chain.slice(1));
                else if (meters(piece[0], chain[0]) <= gap) chain = reversed().concat(chain.slice(1));
                else continue;
                remaining.splice(index, 1);
                grew = true;
                break;
            }
        }
        chains.push(chain);
    }
    return chains;
}

/**
 * The part of a line between the points nearest the first and the last stop: a route-level shape cut
 * down to the variant's own ends.
 */
export function trimmed(line, stops) {
    // The ends where the stops meet the line in order, so a loop is not cut at the wrong pass.
    if (line.length < 2 || !stops.length) return line;
    const ends = orderedMatches(line, [stops[0], stops[stops.length - 1]]);
    if (!ends || !(ends[1].along > ends[0].along)) return line;
    return new Projection(line).slice(ends[0].along, ends[1].along);
}

/** Douglas–Peucker in metres: what the map draws. About 3 m keeps every bend a rider can see. */
export function simplified(line, tolerance = 3) {
    if (line.length <= 2) return line;
    const frame = new LocalFrame(line[0]);
    const xy = line.map((p) => frame.xy(p));
    const keep = new Array(line.length).fill(false);
    keep[0] = true;
    keep[line.length - 1] = true;
    const stack = [[0, line.length - 1]];
    while (stack.length) {
        const [first, last] = stack.pop();
        if (last <= first + 1) continue;
        let farthest = first, distance = 0;
        for (let index = first + 1; index < last; index++) {
            const d = segmentDistance(xy[index], xy[first], xy[last]).distance;
            if (d > distance) { distance = d; farthest = index; }
        }
        if (distance > tolerance) {
            keep[farthest] = true;
            stack.push([first, farthest], [farthest, last]);
        }
    }
    return line.filter((_, i) => keep[i]);
}

/** A line's length in metres. */
export function length(line) {
    let total = 0;
    for (let i = 1; i < line.length; i++) total += meters(line[i - 1], line[i]);
    return total;
}

/** Plane distance in metres, as the checks measure it (equirectangular around `a`). */
export function meters(a, b) {
    const p = new LocalFrame(a).xy(b);
    return Math.hypot(p.x, p.y);
}

// ---------------------------------------------------------------------------------------------
// Plane geometry

const METERS_PER_DEGREE_LAT = 111_320;

/** Metres east and north of a reference point. Equirectangular: accurate at city scale. */
export class LocalFrame {
    constructor(origin) {
        this.origin = origin;
        this.metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((origin.lat * Math.PI) / 180);
    }

    xy(point) {
        return { x: (point.lon - this.origin.lon) * this.metersPerDegreeLon, y: (point.lat - this.origin.lat) * METERS_PER_DEGREE_LAT };
    }

    point(xy) {
        return { lat: this.origin.lat + xy.y / METERS_PER_DEGREE_LAT, lon: this.origin.lon + xy.x / this.metersPerDegreeLon };
    }
}

/** Distance from p to the segment a–b, and how far along it (0…1) the nearest spot is. */
function segmentDistance(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const lengthSquared = abx * abx + aby * aby;
    const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared)) : 0;
    return { distance: Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby)), t };
}

/** A polyline in metres with each vertex's distance along it, for projecting stops and buses onto it. */
export class Projection {
    /** @param {GeoPoint[]} line */
    constructor(line) {
        this.points = line;
        this.frame = new LocalFrame(line[0] ?? { lat: 0, lon: 0 });
        this.xy = line.map((p) => this.frame.xy(p));
        let total = 0;
        this.cumulative = [0];
        for (let i = 1; i < this.xy.length; i++) {
            total += Math.hypot(this.xy[i].x - this.xy[i - 1].x, this.xy[i].y - this.xy[i - 1].y);
            this.cumulative.push(total);
        }
    }

    get length() { return this.cumulative[this.cumulative.length - 1] ?? 0; }

    /** The nearest spot on the line: metres `along` it from the start, and the point's `distance` off it. */
    project(point) {
        const p = this.frame.xy(point);
        let best = { along: 0, distance: Infinity };
        for (let i = 0; i < this.xy.length - 1; i++) {
            const { distance, t } = segmentDistance(p, this.xy[i], this.xy[i + 1]);
            if (distance < best.distance) {
                best = { along: this.cumulative[i] + t * (this.cumulative[i + 1] - this.cumulative[i]), distance };
            }
        }
        return best;
    }

    /** How far the point stands from the line, in metres. */
    nearest(point) {
        return this.project(point).distance;
    }

    /**
     * Every separate place the line passes within `radius` of the point: the closest spot of each pass,
     * passes told apart by 30 m along the line.
     * @returns {{along: number, offset: number}[]}
     */
    candidates(point, radius) {
        const p = this.frame.xy(point);
        const found = [];
        for (let i = 0; i < this.xy.length - 1; i++) {
            const { distance, t } = segmentDistance(p, this.xy[i], this.xy[i + 1]);
            if (distance > radius) continue;
            const along = this.cumulative[i] + t * (this.cumulative[i + 1] - this.cumulative[i]);
            const last = found[found.length - 1];
            if (last && along - last.along < 30) {
                if (distance < last.offset) found[found.length - 1] = { along, offset: distance };
            } else {
                found.push({ along, offset: distance });
            }
        }
        return found;
    }

    /** The point `along` metres from the start, clamped to the line's ends. */
    point(along) {
        const { cumulative, xy, points } = this;
        if (!points.length) return null;
        if (!(along > 0)) return points[0];
        let index = -1;
        for (let i = cumulative.length - 1; i >= 0; i--) if (cumulative[i] <= along) { index = i; break; }
        if (index < 0 || index >= xy.length - 1) return points[points.length - 1];
        const span = cumulative[index + 1] - cumulative[index];
        const t = span > 0 ? (along - cumulative[index]) / span : 0;
        const a = xy[index], b = xy[index + 1];
        return this.frame.point({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }

    /** The line between two distances along it. */
    slice(start, end) {
        const inside = this.points.filter((_, i) => this.cumulative[i] > start && this.cumulative[i] < end);
        return [this.point(start), ...inside, this.point(end)];
    }
}

/** Points bucketed into square cells, for "is any of them near here?". */
class PointGrid {
    constructor(points, cell) {
        this.cell = cell;
        this.cells = new Map();
        for (const p of points) {
            const key = this.key(Math.floor(p.x / cell), Math.floor(p.y / cell));
            if (!this.cells.has(key)) this.cells.set(key, []);
            this.cells.get(key).push(p);
        }
    }

    key(cx, cy) { return `${cx},${cy}`; }

    hasPoint(radius, p) {
        const cx = Math.floor(p.x / this.cell), cy = Math.floor(p.y / this.cell);
        const reach = Math.ceil(radius / this.cell);
        for (let dx = -reach; dx <= reach; dx++) {
            for (let dy = -reach; dy <= reach; dy++) {
                for (const q of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
                    if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= radius * radius) return true;
                }
            }
        }
        return false;
    }
}

/** @typedef {import('../model.js').GeoPoint} GeoPoint */
