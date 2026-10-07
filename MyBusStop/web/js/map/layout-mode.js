// Picks the map's composition from the size of the map area. Ported from the map half of
// BusBus/Board/BoardLayoutMode.swift (`BoardLayout.resolve`).
//
// The app resolves the whole board from the screen; the web page lays out its own header and
// readout, so this works from the map area alone. Each artboard's map area is its reference size
// less the side margins, the header and the readout band:
//
//   landscape  1280×720  − 2×40, − 72 − 268  →  1200×380
//   pad         834×1194 − 2×36, − 88 − 386  →   762×720
//   phone       390×844  − 2×20, − 64 − 310  →   350×470
//
// so `min(width / refWidth, height / refHeight)` over the map area is the same scale the app gets
// from the screen.

import { AXIS, PRESET } from './metrics.js';

export const MAP_REFERENCE = Object.freeze({
    landscape: { width: 1200, height: 380 },
    landscapeSingle: { width: 1200, height: 380 },
    pad: { width: 762, height: 720 },
    phone: { width: 350, height: 470 },
});

export const MINIMUM_SCALE = 0.32;
/** A very large window should not produce a 200 pt numeral. */
export const MAXIMUM_SCALE = 1.6;

/** A map area at least this much wider than tall reads as the landscape composition. */
const LANDSCAPE_ASPECT = 1.4;
/** The app's 600 pt pad/phone break, less the phone's margins. */
const PAD_MIN_WIDTH = 560;

/**
 * @param {number} width map area, CSS px
 * @param {number} height map area, CSS px
 * @param {number} lineCount lines on the board (1…3)
 * @param {{orientation?: 'landscape'|'portrait'}} [options] force the composition instead of
 *   inferring it from the aspect ratio
 * @returns {{mode: string, axis: string, preset: string, scale: number, namesAllLines: boolean,
 *            namedLineIDs: (trunkLineID: string) => string[]|null}}
 *   `namesAllLines` is false only on a narrow phone showing three lines, where the two you are not
 *   catching become unnamed distance spines: 350 px cannot carry three named columns.
 *   `namedLineIDs(trunk)` turns that into the engine's `namedLineIDs` (null = all).
 */
export function chooseMapLayout(width, height, lineCount, options = {}) {
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    const isLandscape = options.orientation
        ? options.orientation === 'landscape'
        : w >= h * LANDSCAPE_ASPECT;
    const mode = isLandscape
        ? (lineCount <= 1 ? PRESET.landscapeSingle : PRESET.landscape)
        : (w >= PAD_MIN_WIDTH ? PRESET.pad : PRESET.phone);
    const reference = MAP_REFERENCE[mode];
    const scale = Math.min(MAXIMUM_SCALE, Math.max(MINIMUM_SCALE, Math.min(w / reference.width, h / reference.height)));
    const namesAllLines = mode !== PRESET.phone || lineCount < 3;
    return {
        mode,
        axis: isLandscape ? AXIS.horizontal : AXIS.vertical,
        preset: mode,
        scale,
        namesAllLines,
        namedLineIDs: (trunkLineID) => (namesAllLines || !trunkLineID ? null : [trunkLineID]),
    };
}
