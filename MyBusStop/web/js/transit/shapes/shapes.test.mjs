// Ports of the iOS shape tests (BusBusTests/Transit/RouteShapeTests.swift). No dependencies:
//   node js/transit/shapes/shapes.test.mjs
// Node has no Cache Storage, so the shape cache runs on its memory layer here.

import assert from 'node:assert/strict';
import { TransitError } from '../model.js';
import { ResponseError } from '../http.js';
import { decodeFlexiblePolyline, decodePolyline, encodePolyline } from './polyline.js';
import {
    Projection, TOLERANCE, bestPiece, chained, isStraightLines, length, meters, orderedOffsets, oriented, simplified,
    trimmed, verdict,
} from './shape-check.js';
import { MISSING_SHAPE_LIFETIME, hasRouteShape, isLasting, loadRouteShape, resetMemory, stopsFingerprint } from './route-shape.js';

const tests = [];
const test = (name, body) => tests.push({ name, body });
const near = (a, b, tolerance) => Math.abs(a.lat - b.lat) <= tolerance && Math.abs(a.lon - b.lon) <= tolerance;

// ---------------------------------------------------------------------------------------------
// Polyline

test('Google polyline decodes Google’s own example', () => {
    assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'),
        [{ lat: 38.5, lon: -120.2 }, { lat: 40.7, lon: -120.95 }, { lat: 43.252, lon: -126.453 }]);
});

test('Google polyline round-trips at either precision', () => {
    const points = [{ lat: 32.766142, lon: 35.039336 }, { lat: 32.766206, lon: 35.039362 }, { lat: -33.8688, lon: 151.2093 }];
    for (const precision of [5, 6]) {
        const decoded = decodePolyline(encodePolyline(points, precision), precision);
        const tolerance = precision === 5 ? 1e-5 : 1e-6;
        assert.equal(decoded.length, points.length);
        points.forEach((p, i) => assert.ok(near(p, decoded[i], tolerance + 1e-12), `precision ${precision} point ${i}`));
    }
});

test('a precision-6 polyline keeps coordinates far from zero exactly', () => {
    const points = [{ lat: -89.999999, lon: -179.999999 }, { lat: 89.999999, lon: 179.999999 }, { lat: 0, lon: 0 }];
    assert.deepEqual(decodePolyline(encodePolyline(points, 6), 6), points);
});

test('a truncated Google polyline throws', () => {
    assert.throws(() => decodePolyline('_p~iF~ps|U_'), TransitError);
});

test('an overlong Google polyline value throws', () => {
    assert.throws(() => decodePolyline('~'.repeat(40) + '?'), TransitError);
});

test('flexible polyline decodes HERE’s own example', () => {
    assert.deepEqual(decodeFlexiblePolyline('BFoz5xJ67i1B1B7PzIhaxL7Y'), [
        { lat: 50.10228, lon: 8.69821 }, { lat: 50.10201, lon: 8.69567 },
        { lat: 50.10063, lon: 8.6915 }, { lat: 50.09878, lon: 8.68752 },
    ]);
});

test('flexible polyline reads bus.gov.il’s precision 15', () => {
    const points = decodeFlexiblePolyline('Bv8Bog2nyuvoxm6Bggooun5l4n-Bw__p2m3D4_hi3twBggi0mvkUggji0u7H');
    const expected = [{ lat: 32.766142, lon: 35.039336 }, { lat: 32.766206, lon: 35.039362 }, { lat: 32.766552, lon: 35.039497 }];
    assert.equal(points.length, expected.length);
    points.forEach((p, i) => assert.ok(near(p, expected[i], 1e-9)));
});

test('a bad flexible polyline throws', () => {
    assert.throws(() => decodeFlexiblePolyline('B!'), TransitError);
    assert.throws(() => decodeFlexiblePolyline('CFoz5'), TransitError);
});

// ---------------------------------------------------------------------------------------------
// Fingerprint

const patternOf = (codes, locations = codes.map(() => ({ lat: 0, lon: 0 })), lineID = '1') => ({
    line: { id: lineID, shortName: lineID, providerRefs: {} },
    stops: codes.map((code, i) => ({ stop: { code, name: code, location: locations[i] }, sequence: i })),
});

test('the fingerprint matches the offline pipeline and ignores repeated stops', async () => {
    assert.equal(await stopsFingerprint(patternOf(['41122', '41123', '41123', '41130'])), 'caf2626e4e64e05c');
});

// ---------------------------------------------------------------------------------------------
// ShapeCheck: a street running east from (32.0, 34.8), a point every ~10 m, turning north after 1 km.

const east = Array.from({ length: 101 }, (_, i) => ({ lat: 32.0, lon: 34.8 + i * 0.0001059 }));
const north = Array.from({ length: 100 }, (_, i) => ({ lat: 32.0 + (i + 1) * 0.0000898, lon: east[100].lon }));
const street = [...east, ...north];
const stopsAt = (indices, offsetMeters = 8) => indices.map((i) => ({ lat: street[i].lat + offsetMeters / 111_320, lon: street[i].lon }));
const reversed = (line) => line.slice().reverse();
const shapeOf = (line) => ({ branches: [line] });

test('stops along the line in order pass', () => {
    const result = verdict(shapeOf(street), stopsAt([0, 30, 60, 100, 150, 200]));
    assert.ok(result.accepted, result.reason);
    assert.ok(result.worstOffset < 10);
});

test('stops in the opposite order fail', () => {
    assert.ok(!verdict(shapeOf(street), stopsAt([200, 150, 100, 60, 30, 0])).accepted);
});

test('a stop far from the line fails', () => {
    const stops = stopsAt([0, 50, 100, 200]);
    stops[1].lat += 100 / 111_320;
    assert.ok(!verdict(shapeOf(street), stops).accepted);
});

test('an end stop may stand further off', () => {
    const stops = stopsAt([0, 50, 100, 200]);
    stops[3].lat += 120 / 111_320;
    assert.ok(verdict(shapeOf(street), stops).accepted);
    assert.ok(!verdict(shapeOf(street), stops, { stops: 50, ends: 50 }).accepted);
    assert.deepEqual(TOLERANCE.platforms, { stops: 50, ends: 150 });
    assert.deepEqual(TOLERANCE.stopAreas, { stops: 200, ends: 200 });
});

test('the stops joined by straight lines are rejected', () => {
    const stops = stopsAt([0, 50, 100, 150, 200], 0);
    const result = verdict(shapeOf(stops), stops);
    assert.ok(!result.accepted);
    assert.equal(result.reason, 'straight lines between stops');
    assert.ok(isStraightLines(shapeOf(stops), stops));
    assert.ok(!isStraightLines(shapeOf(street), stops));
});

test('a line that drives a street twice passes with stops on both passes', () => {
    const outAndBack = [...street, ...reversed(street).slice(1)];
    const stops = [...stopsAt([20, 120, 190]), ...stopsAt([120, 20])];
    assert.ok(verdict(shapeOf(outAndBack), stops).accepted);
});

test('with several branches each stop needs only one', () => {
    const trunk = street.slice(0, 101), branch = street.slice(100);
    const shape = { branches: [trunk, [trunk.at(-1), { lat: 31.99, lon: trunk.at(-1).lon }], branch] };
    assert.ok(verdict(shape, stopsAt([0, 50, 150, 200])).accepted);
});

test('verdict also takes a bare point list or a bare list of branches', () => {
    const stops = stopsAt([0, 30, 60, 100, 150, 200]);
    assert.ok(verdict(street, stops).accepted);
    assert.ok(verdict([street], stops).accepted);
    assert.ok(!verdict(reversed(street), stops).accepted);
});

test('no geometry is rejected; fewer than two stops pass', () => {
    assert.equal(verdict({ branches: [[{ lat: 1, lon: 1 }]] }, stopsAt([0, 1])).reason, 'no geometry');
    assert.ok(verdict(shapeOf(street), stopsAt([0])).accepted);
});

test('a backwards line is turned round', () => {
    assert.deepEqual(oriented(reversed(street), stopsAt([0, 100, 200]))[0], street[0]);
});

test('the shortest passing piece is chosen', () => {
    const stops = stopsAt([0, 50, 100]);
    const part = street.slice(0, 111), wrong = street.slice(150);
    assert.deepEqual(bestPiece([street, wrong, part, part], stops), part);
    assert.equal(bestPiece([wrong], stops), null);
});

test('pieces meeting end to end are chained', () => {
    const a = street.slice(0, 81), b = street.slice(80, 161), c = street.slice(160);
    const chains = chained([c, reversed(b), a]);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].length, street.length);
    const ends = new Set([JSON.stringify(chains[0][0]), JSON.stringify(chains[0].at(-1))]);
    assert.deepEqual(ends, new Set([JSON.stringify(street[0]), JSON.stringify(street.at(-1))]));
});

test('a loop is trimmed where the stops meet it in order', () => {
    const outAndBack = [...street, ...reversed(street).slice(1)];
    const cut = trimmed(outAndBack, stopsAt([150, 40], 0));
    assert.ok(Math.abs(length(cut) - length(street.slice(40, 151))) < 5);
    assert.ok(meters(cut[0], street[150]) < 5);
});

test('no stops match nothing', () => {
    assert.equal(orderedOffsets(street, []), null);
});

test('a route shape is trimmed to the variant’s ends', () => {
    const cut = trimmed(street, stopsAt([40, 80, 120], 0));
    assert.ok(Math.abs(length(cut) - length(street.slice(40, 121))) < 5);
});

test('simplifying drops points on a straight run', () => {
    const thin = simplified(street);
    assert.equal(thin.length, 3);
    assert.deepEqual(thin[0], street[0]);
    assert.deepEqual(thin.at(-1), street.at(-1));
});

test('a projection finds how far along a point is, and the point that far along', () => {
    const projection = new Projection(street);
    const { along, distance } = projection.project(stopsAt([50])[0]);
    assert.ok(Math.abs(along - length(street.slice(0, 51))) < 1);
    assert.ok(Math.abs(distance - 8) < 0.5);
    assert.ok(meters(projection.point(along), street[50]) < 1);
    assert.deepEqual(projection.point(-10), street[0]);
    assert.deepEqual(projection.point(1e9), street.at(-1));
});

// ---------------------------------------------------------------------------------------------
// The shape cache, with a feed that counts its calls; its shape is the test street.

function feed({ stopIndices = [0, 100, 200], id = `feed-${Math.random()}`, shape = street, missing = false, failure = null } = {}) {
    const provider = {
        id, calls: 0,
        async routeShape() {
            provider.calls += 1;
            await new Promise((r) => setTimeout(r, 5));
            if (missing) return null;
            if (failure) throw failure;
            return { branches: [shape] };
        },
    };
    const pattern = patternOf(stopIndices.map((s, i) => `s${i}-${s}`), stopsAt(stopIndices), '7');
    return { provider, pattern, line: pattern.line };
}

test('hasRouteShape needs a routeShape and the feed’s say-so', () => {
    assert.ok(!hasRouteShape({ id: 'x' }, {}));
    assert.ok(hasRouteShape({ id: 'x', routeShape() {} }, {}));
    assert.ok(!hasRouteShape({ id: 'x', routeShape() {}, hasRouteShape: () => false }, {}));
});

test('a feed without shapes makes no request and gets null', async () => {
    assert.equal(await loadRouteShape({ id: 'plain' }, { id: '1' }, patternOf(['a', 'b'])), null);
});

test('a line’s shape is fetched once, thinned, and concurrent opens share the load', async () => {
    resetMemory();
    const { provider, line, pattern } = feed();
    const [first, again] = await Promise.all([loadRouteShape(provider, line, pattern), loadRouteShape(provider, line, pattern)]);
    const later = await loadRouteShape(provider, line, pattern);
    assert.ok(first && first.branches.length === 1);
    assert.ok(first.branches[0].length < street.length);
    assert.ok(meters(first.branches[0][0], street[0]) < 0.5);
    assert.deepEqual(again, first);
    assert.deepEqual(later, first);
    assert.equal(provider.calls, 1);
});

test('a changed stop list fetches the shape again', async () => {
    resetMemory();
    const before = feed({ id: 'same' }), after = feed({ id: 'same', stopIndices: [0, 120, 200] });
    after.provider = before.provider;
    await loadRouteShape(before.provider, before.line, before.pattern);
    await loadRouteShape(after.provider, after.line, after.pattern);
    assert.equal(before.provider.calls, 2);
});

test('a rejected shape is kept and not drawn', async () => {
    resetMemory();
    const { provider, line, pattern } = feed({ shape: street.slice(150) });
    assert.equal(await loadRouteShape(provider, line, pattern), null);
    assert.equal(await loadRouteShape(provider, line, pattern), null);
    assert.equal(provider.calls, 1);
});

test('a line with no path is not asked for again', async () => {
    resetMemory();
    const { provider, line, pattern } = feed({ missing: true });
    assert.equal(await loadRouteShape(provider, line, pattern), null);
    assert.equal(await loadRouteShape(provider, line, pattern), null);
    assert.equal(provider.calls, 1);
});

test('a rejection is asked again after a week; a good shape is not', async () => {
    resetMemory();
    const realNow = Date.now;
    try {
        const rejectedFeed = feed({ missing: true }), goodFeed = feed();
        await loadRouteShape(rejectedFeed.provider, rejectedFeed.line, rejectedFeed.pattern);
        await loadRouteShape(goodFeed.provider, goodFeed.line, goodFeed.pattern);
        const start = realNow();
        Date.now = () => start + MISSING_SHAPE_LIFETIME + 60_000;
        await loadRouteShape(rejectedFeed.provider, rejectedFeed.line, rejectedFeed.pattern);
        await loadRouteShape(goodFeed.provider, goodFeed.line, goodFeed.pattern);
        assert.equal(rejectedFeed.provider.calls, 2);
        assert.equal(goodFeed.provider.calls, 1);
        // After the month even a good shape is asked again; if that fails for now, the old one is drawn.
        Date.now = () => start + 31 * 86_400_000;
        goodFeed.provider.routeShape = async () => { goodFeed.provider.calls += 1; throw new ResponseError('HTTP 503', { status: 503 }); };
        assert.ok(await loadRouteShape(goodFeed.provider, goodFeed.line, goodFeed.pattern));
        assert.equal(goodFeed.provider.calls, 2);
    } finally {
        Date.now = realNow;
    }
});

test('lasting failures are kept and passing ones asked again', async () => {
    const cases = [
        [new TransitError('notFound', 'shape of 7'), true],
        [new ResponseError('HTTP 404', { status: 404 }), true],
        [new ResponseError('reply was not JSON', { status: 200 }), true],
        [new TransitError('badResponse', 'Bad polyline: truncated'), true],
        [new SyntaxError('Unexpected token'), true],
        [new ResponseError('HTTP 503', { status: 503 }), false],
        [new ResponseError('HTTP 429', { status: 429 }), false],
        [new ResponseError('HTTP 408', { status: 408 }), false],
        [new TransitError('badResponse', 'HTTP 502 for /x'), false],
        [new ResponseError('timed out after 30s'), false],
        [new ResponseError('network: Failed to fetch'), false],
        [new TypeError('Failed to fetch'), false],
    ];
    for (const [failure, lasting] of cases) {
        assert.equal(isLasting(failure), lasting, failure.message);
        resetMemory();
        const { provider, line, pattern } = feed({ failure });
        if (lasting) {
            assert.equal(await loadRouteShape(provider, line, pattern), null);
            assert.equal(await loadRouteShape(provider, line, pattern), null);
            assert.equal(provider.calls, 1, failure.message);
        } else {
            await assert.rejects(loadRouteShape(provider, line, pattern));
            await assert.rejects(loadRouteShape(provider, line, pattern));
            assert.equal(provider.calls, 2, failure.message);
        }
    }
});

test('stop positions from the shape’s source are used for the check and handed back', async () => {
    resetMemory();
    const { provider, line, pattern } = feed();
    // The provider's stops stand 300 m off; the shape's source knows where they really are.
    const truth = Object.fromEntries(pattern.stops.map((s) => [s.stop.code, { ...s.stop.location }]));
    for (const s of pattern.stops) s.stop.location = { lat: s.stop.location.lat + 300 / 111_320, lon: s.stop.location.lon };
    provider.routeShape = async () => { provider.calls += 1; return { branches: [street], stopPositions: truth }; };
    const shape = await loadRouteShape(provider, line, pattern);
    assert.ok(shape);
    assert.deepEqual(shape.stopPositions, truth);
});

// ---------------------------------------------------------------------------------------------

let failed = 0;
for (const { name, body } of tests) {
    try {
        await body();
        console.log(`ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`FAIL ${name}\n     ${error.stack ?? error}`);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
