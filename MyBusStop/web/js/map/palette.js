// Line colours, the board's two themes and the line colour assigner. Ported from
// BusBus/Design/LinePalette.swift and DesignTokens.swift.
//
// In light mode the colour lives only in rails and badge fills: amber and cyan cannot carry text on
// cream at any size, so numerals go ink and terminus names use a darker ink of the line colour.

export const PALETTE_COUNT = 12;

export const DARK_RAIL = [
    0xFF3B3F, 0xFFC300, 0x22D3EE, 0x3DDC84, 0xA78BFA, 0xFF7A1A,
    0x4D8CFF, 0xFF5CA8, 0x7BE0C2, 0xE8D44D, 0xC3F53C, 0xFFA9A9,
];

/**
 * Darkened to hold at least 3:1 against the cream ground — except index 1, the brief's amber,
 * which the brief fixes at this value and which reaches only 1.88:1.
 */
export const LIGHT_RAIL = [
    0xD32029, 0xEFA400, 0x0E7C86, 0x1A7F4B, 0x6D4FD6, 0xC2520A,
    0x2461D9, 0xC8207A, 0x1E8A6E, 0x9A8A00, 0x5E8A00, 0xC04A4A,
];

/** Terminus names and the tapped-bus kicker in light mode: at least 4.5:1 on cream. */
export const LIGHT_TEXT = [
    0xB01A22, 0x8A6000, 0x0B636B, 0x12603A, 0x4E37A6, 0x8F3C05,
    0x1A47A8, 0x961558, 0x146650, 0x6F6400, 0x446600, 0x8F3434,
];

export const hex = (value) => `#${value.toString(16).padStart(6, '0').toUpperCase()}`;

export function wrapIndex(index) {
    const m = Math.trunc(Number(index) || 0) % PALETTE_COUNT;
    return m < 0 ? m + PALETTE_COUNT : m;
}

export function relativeLuminance(value) {
    const channel = (part8) => {
        const part = part8 / 255;
        return part <= 0.03928 ? part / 12.92 : Math.pow((part + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel((value >> 16) & 0xFF)
        + 0.7152 * channel((value >> 8) & 0xFF)
        + 0.0722 * channel(value & 0xFF);
}

export function contrast(a, b) {
    const first = relativeLuminance(a);
    const second = relativeLuminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** The rail, terminus bar, ring and badge fill of a line. */
export function railColor(index, isLight) {
    return hex((isLight ? LIGHT_RAIL : DARK_RAIL)[wrapIndex(index)]);
}

/**
 * The number written on a badge or puck of this line's colour: ink or white, whichever the numeral
 * can actually be read in. On the dark palette ink always wins — every one of those twelve is
 * bright. The light palette is darkened so it can hold its own as a rail against cream, and that
 * leaves most of it far too dark to carry ink.
 */
export function numeralColor(index, isLight) {
    const fill = (isLight ? LIGHT_RAIL : DARK_RAIL)[wrapIndex(index)];
    const ink = isLight ? 0x14140F : 0x08080B;
    return contrast(fill, ink) >= contrast(fill, 0xFFFFFF) ? hex(ink) : '#FFFFFF';
}

/** Text in a line's colour (terminus names): the rail colour in dark, a darker ink of it in light. */
export function labelColor(index, isLight) {
    return hex(isLight ? LIGHT_TEXT[wrapIndex(index)] : DARK_RAIL[wrapIndex(index)]);
}

/** The board's colours the map uses, in both themes. One ground behind the whole board. */
export const THEMES = Object.freeze({
    dark: Object.freeze({
        isLight: false,
        background: '#08080B',
        primaryText: '#FFFFFF',
        secondaryText: '#A0A0AE',
        captionText: '#C4C4CE',
        stopName: '#8C8C9A',
        dashCaption: '#5E5E6C',
        numeralOnColor: '#08080B',
    }),
    // One continuous cream ground: no white panels anywhere.
    light: Object.freeze({
        isLight: true,
        background: '#F4F2EC',
        primaryText: '#14140F',
        secondaryText: '#55555F',
        captionText: '#45454E',
        stopName: '#55555F',
        dashCaption: '#8A8790',
        numeralOnColor: '#14140F',
    }),
});

// MARK: - Line colour assigner

/** Hue of a colour in degrees. */
export function hueOf(value) {
    const r = ((value >> 16) & 0xFF) / 255;
    const g = ((value >> 8) & 0xFF) / 255;
    const b = (value & 0xFF) / 255;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const delta = maximum - minimum;
    if (!(delta > 0)) return 0;
    let h;
    if (maximum === r) h = 60 * (((g - b) / delta) % 6);   // truncating remainder, like Swift's
    else if (maximum === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
    return h < 0 ? h + 360 : h;
}

/** Hue of each palette entry, computed from the colour itself so it stays correct if the palette is edited. */
const HUES = DARK_RAIL.map(hueOf);

export function hueDistance(a, b) {
    const difference = Math.abs(HUES[wrapIndex(a)] - HUES[wrapIndex(b)]);
    return Math.min(difference, 360 - difference);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xFFFFFFFFFFFFFFFFn;
const utf8 = new TextEncoder();

/** FNV-1a over the line id, so the same line looks the same on every device and every launch. */
export function hashedIndex(lineID) {
    let hash = FNV_OFFSET;
    for (const byte of utf8.encode(String(lineID))) {
        hash ^= BigInt(byte);
        hash = (hash * FNV_PRIME) & MASK_64;
    }
    return Number(hash % BigInt(PALETTE_COUNT));
}

/** What to show a line as before it has ever been selected. */
export function provisionalIndex(lineID, persisted = {}) {
    const known = persisted[lineID];
    return known === undefined || known === null ? hashedIndex(lineID) : known;
}

/** Two hues closer than this are not worth telling apart on a rail seen across a room. */
const MINIMUM_SEPARATION = 40;

/**
 * Gives every line a colour that does not move between sessions, and never lets two lines the
 * rider is watching look alike.
 *
 * Keeps whatever a line has been shown as before. A new line takes the colour its operator
 * publishes, or its hashed one; if that is taken it takes the free colour furthest in hue from the
 * ones already in use — two watched lines must be told apart at a glance, and "next free index"
 * happily hands out mint next to green.
 *
 * @param {Record<string, number>} persisted lineID → palette index already shown
 * @param {string[]} selectedIDs the lines being watched, in selection order
 * @param {Record<string, number|null>} [preferred] lineID → the operator's palette index, or null
 * @returns {Record<string, number>} persisted plus an index for every selected line
 */
export function assignLineColors(persisted = {}, selectedIDs = [], preferred = {}) {
    const has = (map, key) => map[key] !== undefined && map[key] !== null;
    const result = { ...persisted };
    const taken = new Set(selectedIDs.filter((id) => has(persisted, id)).map((id) => persisted[id]));
    const separation = (index) => {
        let min = 360;
        for (const t of taken) min = Math.min(min, hueDistance(index, t));
        return min;
    };

    for (const lineID of selectedIDs) {
        if (has(persisted, lineID)) continue;
        const wanted = has(preferred, lineID) ? wrapIndex(preferred[lineID]) : hashedIndex(lineID);
        const isClear = !taken.has(wanted) && [...taken].every((t) => hueDistance(t, wanted) >= MINIMUM_SEPARATION);

        let index = wanted;
        if (!isClear) {
            // The first of the furthest free colours, as Swift's `max(by:)` keeps the first maximum.
            let best = null;
            for (let candidate = 0; candidate < PALETTE_COUNT; candidate++) {
                if (taken.has(candidate)) continue;
                if (best === null || separation(best) < separation(candidate)) best = candidate;
            }
            index = best ?? wanted;
        }
        result[lineID] = index;
        taken.add(index);
    }
    return result;
}
