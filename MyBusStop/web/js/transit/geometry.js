// Measures positions along a route pattern, so providers that only give bare GPS can still place a
// bus between two stops. Port of BusBus/Transit/Progress/RouteGeometry.swift: the polyline is
// stop-to-stop straight segments.

import { meters } from './model.js';

export class RouteGeometry {
    /** @param {import('./model.js').RoutePattern} pattern */
    constructor(pattern) {
        this.pattern = pattern;
        const published = pattern.stops.map((s) => s.distanceAlongRoute);
        const allPublished = published.every((d) => d != null && Number.isFinite(d));
        const increasing = published.every((d, i) => i === 0 || published[i - 1] <= d);
        if (allPublished && increasing) {
            this.stopDistances = published.slice();
        } else {
            let total = 0;
            this.stopDistances = pattern.stops.map((s, i) => {
                if (i > 0) total += meters(pattern.stops[i - 1].stop.location, s.stop.location);
                return total;
            });
        }
    }

    get totalLength() { return this.stopDistances[this.stopDistances.length - 1] ?? 0; }

    /** Snaps a point to the nearest segment: metres along the route, and how far off it the point is. */
    project(point) {
        const stops = this.pattern.stops.map((s) => s.stop.location);
        if (stops.length < 2) return null;
        let best = null;
        for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i], b = stops[i + 1];
            const mLat = 111_320, mLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
            const bx = (b.lon - a.lon) * mLon, by = (b.lat - a.lat) * mLat;
            const px = (point.lon - a.lon) * mLon, py = (point.lat - a.lat) * mLat;
            const len2 = bx * bx + by * by;
            const t = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
            const dx = px - t * bx, dy = py - t * by;
            const offRoute = Math.hypot(dx, dy);
            if (!best || offRoute < best.offRoute) {
                best = { distanceAlong: this.stopDistances[i] + t * (this.stopDistances[i + 1] - this.stopDistances[i]), offRoute };
            }
        }
        return best;
    }

    /** Index of the last stop at or before a distance along the route. */
    lastStopIndex(distance) {
        for (let i = this.stopDistances.length - 1; i >= 0; i--) if (this.stopDistances[i] <= distance + 1) return i;
        return 0;
    }
}
