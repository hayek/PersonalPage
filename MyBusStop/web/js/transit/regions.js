// The places the web version can serve, and the provider behind each. A subset of the app's
// SupportedRegions.swift: only feeds that need no key and let a browser read their replies (CORS).
// Everything else falls back to Transitous, which has times but no bus positions.

/** @typedef {{id: string, name: string, group: string, providerID: string, fit: 'full'|'arrivalsOnly', bounds: [number, number, number, number]}} Region */

/** bounds: [minLat, minLon, maxLat, maxLon] */
export const REGIONS = [
    // Through the web relay (bus.gov.il sends no CORS headers); see providers/bus.gov.il.js.
    { id: 'IL', name: 'Israel', group: 'Middle East', providerID: 'bus.gov.il', fit: 'full', bounds: [29.4, 34.2, 33.4, 35.9] },

    // Europe
    { id: 'NO', name: 'Norway', group: 'Europe', providerID: 'entur', fit: 'full', bounds: [57.9, 4.5, 71.2, 31.2] },
    { id: 'FI-TKU', name: 'Turku', group: 'Europe', providerID: 'foli', fit: 'full', bounds: [60.0, 21.3, 60.76, 23.53] },
    { id: 'FI-TRE', name: 'Tampere', group: 'Europe', providerID: 'tampere', fit: 'full', bounds: [61.12, 23.2, 61.89, 25.19] },
    { id: 'PT-LIS', name: 'Lisbon area', group: 'Europe', providerID: 'carrismetropolitana', fit: 'full', bounds: [38.4, -9.51, 39.09, -8.44] },
    { id: 'FR-RNS', name: 'Rennes', group: 'Europe', providerID: 'star-rennes', fit: 'full', bounds: [47.93, -1.96, 48.31, -1.46] },
    { id: 'GB-LON', name: 'London', group: 'Europe', providerID: 'tfl', fit: 'arrivalsOnly', bounds: [51.28, -0.51, 51.7, 0.34] },
    { id: 'BE-BRU', name: 'Brussels', group: 'Europe', providerID: 'stib', fit: 'full', bounds: [50.75, 4.24, 50.94, 4.53] },
    { id: 'CH', name: 'Switzerland', group: 'Europe', providerID: 'ch-opendata', fit: 'arrivalsOnly', bounds: [45.8, 5.95, 47.85, 10.5] },
    { id: 'DE-NUE', name: 'Nuremberg', group: 'Europe', providerID: 'vag-nuernberg', fit: 'arrivalsOnly', bounds: [49.33, 10.88, 49.63, 11.22] },

    // North America
    { id: 'US-BOS', name: 'Boston', group: 'North America', providerID: 'mbta', fit: 'full', bounds: [42.0, -71.4, 42.75, -70.75] },
    { id: 'US-MSP', name: 'Minneapolis–St Paul', group: 'North America', providerID: 'metrotransit', fit: 'full', bounds: [44.6, -93.85, 45.35, -92.8] },
    { id: 'CA-TOR', name: 'Toronto', group: 'North America', providerID: 'umo-ttc', fit: 'full', bounds: [43.58, -79.64, 43.86, -79.11] },

    // Asia
    { id: 'HK-KMB', name: 'Hong Kong — KMB', group: 'Asia', providerID: 'hk-kmb', fit: 'arrivalsOnly', bounds: [22.23, 113.89, 22.56, 114.34] },
    { id: 'HK-CTB', name: 'Hong Kong — Citybus', group: 'Asia', providerID: 'hk-citybus', fit: 'arrivalsOnly', bounds: [22.19, 113.83, 22.56, 114.3] },
    { id: 'HK-GMB', name: 'Hong Kong — Green Minibus', group: 'Asia', providerID: 'hk-gmb', fit: 'arrivalsOnly', bounds: [22.15, 113.83, 22.57, 114.44] },
    { id: 'HK-NLB', name: 'Hong Kong — NLB (Lantau)', group: 'Asia', providerID: 'hk-nlb', fit: 'arrivalsOnly', bounds: [22.2, 113.83, 22.35, 114.06] },
    { id: 'JP-TYO', name: 'Tokyo', group: 'Asia', providerID: 'odpt-toei', fit: 'full', bounds: [35.52, 139.2, 35.83, 139.93] },
];

/** Anywhere else: times from Transitous, no buses on the map. */
export const WORLDWIDE = {
    id: 'WORLD', name: 'Everywhere else', group: 'Worldwide', providerID: 'transitous', fit: 'arrivalsOnly', bounds: [-90, -180, 90, 180],
};

export const ALL_REGIONS = [...REGIONS, WORLDWIDE];

const area = ([a, b, c, d]) => (c - a) * (d - b);
const contains = ([minLat, minLon, maxLat, maxLon], p) => p.lat >= minLat && p.lat <= maxLat && p.lon >= minLon && p.lon <= maxLon;

/** Every region covering a point, most specific first; the worldwide fallback is always last. */
export function regionsContaining(point) {
    return [...REGIONS.filter((r) => contains(r.bounds, point)).sort((a, b) => area(a.bounds) - area(b.bounds)), WORLDWIDE];
}

export const regionByID = (id) => ALL_REGIONS.find((r) => r.id === id) ?? null;
