// Encoded polyline formats the providers send route shapes in. Port of
// BusBus/Transit/Shapes/Polyline.swift.

import { TransitError } from '../model.js';

/** A polyline that cannot be read: a lasting failure, asking again would get the same text. */
function bad(reason) {
    return new TransitError('badResponse', `Bad polyline: ${reason}`);
}

// ---------------------------------------------------------------------------------------------
// Google encoded polyline

/**
 * Google's encoded polyline. Precision 5 is the usual one; MOTIS (Transitous) and our own cache use 6.
 * Arithmetic rather than bit operators: JavaScript's are 32-bit, and a 7-chunk value needs 35.
 * @returns {import('../model.js').GeoPoint[]}
 */
export function decodePolyline(text, precision = 5) {
    const factor = 10 ** precision;
    const points = [];
    let lat = 0, lon = 0, index = 0;

    function next() {
        let result = 0, shift = 0;
        while (index < text.length) {
            const code = text.charCodeAt(index++);
            const chunk = code - 63;
            // Real values need 30 bits at most; a longer run is garbage.
            if (chunk < 0 || chunk >= 64 || shift > 30) throw bad(`character ${code}`);
            result += (chunk & 0x1f) * 2 ** shift;
            shift += 5;
            if (chunk < 0x20) return result % 2 ? -Math.floor(result / 2) - 1 : result / 2;
        }
        if (shift > 0) throw bad('truncated');
        return null;
    }

    for (let dLat = next(); dLat !== null; dLat = next()) {
        const dLon = next();
        if (dLon === null) throw bad('odd number of values');
        lat += dLat;
        lon += dLon;
        points.push({ lat: lat / factor, lon: lon / factor });
    }
    return points;
}

export function encodePolyline(points, precision = 6) {
    const factor = 10 ** precision;
    let output = '';
    let lastLat = 0, lastLon = 0;

    function append(value) {
        let v = value < 0 ? -2 * value - 1 : 2 * value;
        while (v >= 0x20) {
            output += String.fromCharCode((0x20 | (v % 0x20)) + 63);
            v = Math.floor(v / 0x20);
        }
        output += String.fromCharCode(v + 63);
    }

    for (const point of points) {
        // Swift's .rounded() rounds halves away from zero; Math.round would round -0.5 up.
        const lat = roundHalfAway(point.lat * factor), lon = roundHalfAway(point.lon * factor);
        append(lat - lastLat);
        append(lon - lastLon);
        lastLat = lat;
        lastLon = lon;
    }
    return output;
}

const roundHalfAway = (x) => Math.sign(x) * Math.round(Math.abs(x));

// ---------------------------------------------------------------------------------------------
// HERE flexible polyline

const FLEXIBLE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const flexibleValue = new Map([...FLEXIBLE_ALPHABET].map((c, i) => [c.charCodeAt(0), BigInt(i)]));

/**
 * HERE's flexible polyline (https://github.com/heremaps/flexible-polyline), which bus.gov.il sends.
 * A header gives the precision (bus.gov.il says 15) and whether a third value follows each point;
 * the third value is read and dropped. BigInt because precision 15 overflows a double's 53 bits.
 * @returns {import('../model.js').GeoPoint[]}
 */
export function decodeFlexiblePolyline(text) {
    const values = flexibleUnsigned(text);
    let at = 0;
    const next = () => (at < values.length ? values[at++] : null);
    if (next() !== 1n) throw bad('flexible version');
    const header = next();
    if (header === null) throw bad('flexible header');
    const precision = Number(header & 15n);
    const thirdDimension = (header >> 4n) & 7n;
    const factor = 10 ** precision;
    const zigzag = (value) => ((value & 1n) ? -(value >> 1n) - 1n : value >> 1n);

    const points = [];
    let lat = 0n, lon = 0n;
    for (let a = next(); a !== null; a = next()) {
        const b = next();
        if (b === null) throw bad('odd number of values');
        lat += zigzag(a);
        lon += zigzag(b);
        if (thirdDimension !== 0n && next() === null) throw bad('missing third value');
        points.push({ lat: Number(lat) / factor, lon: Number(lon) / factor });
    }
    return points;
}

function flexibleUnsigned(text) {
    const values = [];
    let result = 0n, shift = 0n;
    for (let i = 0; i < text.length; i++) {
        const chunk = flexibleValue.get(text.charCodeAt(i));
        if (chunk === undefined || shift >= 64n) throw bad(`character ${text.charCodeAt(i)}`);
        result |= (chunk & 0x1fn) << shift;
        if (chunk & 0x20n) {
            shift += 5n;
        } else {
            values.push(result);
            result = 0n;
            shift = 0n;
        }
    }
    if (shift > 0n) throw bad('truncated');
    return values;
}
