// Route fixtures reconstructed from the design artboards. Ported from
// BusBus/MapEngine/MapFixtures.swift, so the demo page and the scratch tests describe exactly the
// routes the app's unit tests do.

export function stop(name) {
    return { code: name.toUpperCase().replaceAll(' ', '-'), name: name.toUpperCase() };
}

/** Anonymous stops swallowed by a dashed run. They exist in the data; the drawing hides them. */
export function filler(prefix, count) {
    return Array.from({ length: count }, (_, i) => stop(`${prefix} ${i + 1}`));
}

export const USER = 'HARBOR GATE';
export const USER_CODE = stop(USER).code;

const line = (id, colorIndex, stops) => ({ id, number: id, colorIndex, stops });

// Main — nothing merges before the user's stop (Main.dc.html)

export const line41Main = line('41', 1, [stop('VISTA PARK'), stop('AIRPORT LOOP'), ...filler('V', 4),
    stop('LOWER QUAY'), stop('BELL TOWER'), stop('CANAL ST'), stop('FISH MARKET'), stop('DOCK GATE'), stop(USER)]);

export const line18Main = line('18', 0, [stop('NORTHGATE'), stop('FOUNDRY RD'), ...filler('N', 6),
    stop('CIVIC CTR'), stop('WEST MARKET'), stop('OAK & 5TH'), stop('PIER FOUR'), stop('GRANITE ROW'), stop(USER)]);

export const line7Main = line('7', 2, [stop('HILLCREST'), stop('QUARRY RD'), ...filler('H', 9),
    stop('OLD MILL'), stop('COLLEGE RD'), stop('RIVER BEND'), stop('SOUTH PIER'), stop('CUSTOM HOUSE'), stop(USER)]);

export const main = [line18Main, line41Main, line7Main];

// Merge A — 18 joins 41 at MILL JUNCTION; 7 stays independent (Merge1.dc.html)

export const line41A = line('41', 1, [stop('VISTA PARK'), stop('AIRPORT LOOP'), ...filler('V', 5),
    stop('LOWER QUAY'), stop('BELL TOWER'), stop('MILL JUNCTION'), stop('CANAL ST'), stop('FISH MARKET'), stop('DOCK GATE'), stop(USER)]);

export const line18A = line('18', 0, [stop('NORTHGATE'), stop('FOUNDRY RD'), ...filler('N', 7),
    stop('CIVIC CTR'), stop('WEST MARKET'), stop('MILL JUNCTION'), stop('CANAL ST'), stop('FISH MARKET'), stop('DOCK GATE'), stop(USER)]);

export const line7A = line7Main;

export const mergeA = [line18A, line41A, line7A];

// Merge B — 18 joins at BELL TOWER, 7 joins later at PIER FOUR (Merge2.dc.html)

export const line41B = line('41', 1, [stop('VISTA PARK'), stop('AIRPORT LOOP'), ...filler('V', 4),
    stop('LOWER QUAY'), stop('BELL TOWER'), stop('CANAL ST'), stop('FISH MARKET'), stop('PIER FOUR'), stop('GRANITE ROW'), stop('DOCK GATE'), stop(USER)]);

export const line18B = line('18', 0, [stop('NORTHGATE'), stop('FOUNDRY RD'), ...filler('N', 6),
    stop('CIVIC CTR'), stop('BELL TOWER'), stop('CANAL ST'), stop('FISH MARKET'), stop('PIER FOUR'), stop('GRANITE ROW'), stop('DOCK GATE'), stop(USER)]);

export const line7B = line('7', 2, [stop('HILLCREST'), stop('QUARRY RD'), ...filler('H', 8),
    stop('OLD MILL'), stop('COLLEGE RD'), stop('PIER FOUR'), stop('GRANITE ROW'), stop('DOCK GATE'), stop(USER)]);

export const mergeB = [line18B, line41B, line7B];

// Merge C — all three share everything after WEST MARKET (Merge3.dc.html)

export const line41C = line('41', 1, [stop('VISTA PARK'), stop('AIRPORT LOOP'), ...filler('V', 6),
    stop('LOWER QUAY'), stop('WEST MARKET'), stop('CANAL ST'), stop('PIER FOUR'), stop('DOCK GATE'), stop(USER)]);

export const line18C = line('18', 0, [stop('NORTHGATE'), stop('FOUNDRY RD'), ...filler('N', 5),
    stop('CIVIC CTR'), stop('WEST MARKET'), stop('CANAL ST'), stop('PIER FOUR'), stop('DOCK GATE'), stop(USER)]);

export const line7C = line('7', 2, [stop('HILLCREST'), stop('QUARRY RD'), ...filler('H', 8),
    stop('OLD MILL'), stop('WEST MARKET'), stop('CANAL ST'), stop('PIER FOUR'), stop('DOCK GATE'), stop(USER)]);

export const mergeC = [line18C, line41C, line7C];

// Corridor — two lines only, 18 joining 41 six stops out and sharing the whole run in

/** Everything from the junction to the user's stop, on both lines. */
const corridor = () => [stop('BELL TOWER'), stop('CANAL ST'), stop('FISH MARKET'), stop('CUSTOM HOUSE'),
    stop('PIER FOUR'), stop('DOCK GATE'), stop(USER)];

export const line41Corridor = line('41', 1, [stop('VISTA PARK'), stop('AIRPORT LOOP'), ...filler('V', 16),
    stop('LOWER QUAY'), ...corridor()]);

export const line18Corridor = line('18', 0, [stop('NORTHGATE'), stop('FOUNDRY RD'), ...filler('N', 20),
    stop('CIVIC CTR'), ...corridor()]);

export const corridorPair = [line41Corridor, line18Corridor];

/** The route topologies the mock provider can serve, mirroring the artboards. */
export const SCENARIOS = {
    main: { title: 'Main — nothing merges', lines: main },
    mergeA: { title: 'Merge A — one shared corridor', lines: mergeA },
    mergeB: { title: 'Merge B — two junctions', lines: mergeB },
    mergeC: { title: 'Merge C — common trunk', lines: mergeC },
    corridor: { title: 'Corridor — two lines, long shared run', lines: corridorPair },
};

/** A layout request with the app's test defaults (landscape, 1280×380, scale 1, trunk 41). */
export function fixtureRequest(lines, overrides = {}) {
    return {
        lines,
        trunkLineID: '41',
        userStopCode: USER_CODE,
        vehicles: [],
        axis: 'horizontal',
        preset: 'landscape',
        canvasSize: { width: 1280, height: 380 },
        scale: 1,
        namedLineIDs: null,
        highlightedLineID: null,
        ...overrides,
    };
}

// London — real-world names, far longer than the artboards'. Two TfL lines that share their last
// stops; the names carry the stop letter as TfL publishes them.

const named = (name) => ({ code: name.toUpperCase().replace(/[^A-Z0-9]+/g, '-'), name });

export const LONDON_USER = 'Trafalgar Square (Stop S)';
export const LONDON_USER_CODE = named(LONDON_USER).code;

export const line12London = line('12', 1, [
    'Dulwich Library (Stop DL)', 'Etherow Street (Stop DB)', 'Goodrich Road (Stop GR)',
    ...Array.from({ length: 9 }, (_, i) => `Peckham Road Stop ${i + 1} (Stop P${i + 1})`),
    'Camberwell Green (Stop CG)', 'Elephant & Castle Station (Stop E)', 'Westminster Bridge Road (Stop WB)',
    'Parliament Square (Stop PS)', 'Whitehall Horse Guards (Stop H)', LONDON_USER,
].map(named));

export const line88London = line('88', 0, [
    'Clapham Common Station (Stop TT)', 'Clapham Common Old Town (Stop CJ)',
    ...Array.from({ length: 11 }, (_, i) => `Wandsworth Road Stop ${i + 1} (Stop W${i + 1})`),
    'Vauxhall Bus Station (Stop V)', 'Millbank Tate Britain (Stop MA)', 'Parliament Square (Stop PS)',
    'Whitehall Horse Guards (Stop H)', LONDON_USER,
].map(named));

export const londonPair = [line88London, line12London];

// Rennes — three lines that only come together for the last three stops before the rider's.

export const RENNES_USER = 'République';
export const RENNES_USER_CODE = named(RENNES_USER).code;
const rennesShared = ['Mouézy', 'Croix Saint-Hélier', 'Laënnec', RENNES_USER];

export const rennesTriple = [
    line('C2', 3, ['Haut Sancé', ...Array.from({ length: 12 }, (_, i) => `Sancé ${i + 1}`), ...rennesShared].map(named)),
    line('C1', 6, ['Chantepie', ...Array.from({ length: 9 }, (_, i) => `Chantepie ${i + 1}`), ...rennesShared].map(named)),
    line('11', 5, ['Torigné', ...Array.from({ length: 15 }, (_, i) => `Torigné ${i + 1}`), ...rennesShared].map(named)),
];
