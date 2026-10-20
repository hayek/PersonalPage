// The mark a line without a number carries in its badge: a glyph for the mode its feed states, or,
// when the feed states none, a plain dot that claims no mode. Paths on the 24×24 grid of the ui.js
// icons, stroked the same way, so the lists (ui.js `badge`) and the maps (render.js) share them.

const GLYPHS = {
    bus: '<rect x="5" y="3.5" width="14" height="14.5" rx="3"/><path d="M5 11h14M8.5 21v-3M15.5 21v-3"/><circle cx="8.5" cy="14.5" r="0.7" fill="currentColor"/><circle cx="15.5" cy="14.5" r="0.7" fill="currentColor"/>',
    trolleybus: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M5 13.5h14M8.5 22v-3M15.5 22v-3M9 8l3-5.5M13 8l3-5.5"/>',
    tram: '<rect x="6" y="7" width="12" height="12" rx="2.5"/><path d="M6 12.5h12M9 3.5h6M12 3.5V7M9.5 22l1-3M14.5 22l-1-3"/>',
    metro: '<circle cx="12" cy="12" r="9"/><path d="M8 16V8.5l4 4.5 4-4.5V16"/>',
    rail: '<rect x="6.5" y="3" width="11" height="13" rx="3.5"/><path d="M6.5 9.5h11M9 16l-2.5 5.5M15 16l2.5 5.5M7.8 19h8.4"/>',
    ferry: '<path d="M4.5 15l1.5-5h12l1.5 5"/><path d="M8.5 10V6.5h7V10M12 6.5V3.5"/><path d="M3 19.5c1.5 0 1.5-1.2 3-1.2s1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2"/>',
    cable: '<path d="M3 5.5L21 2.5"/><path d="M12 4v4"/><rect x="6.5" y="8" width="11" height="10.5" rx="2.5"/><path d="M6.5 12.5h11"/>',
};

/** No mode given, or "other": a dot, which says "a line" and nothing about what runs on it. */
const NEUTRAL = '<circle cx="12" cy="12" r="4" fill="currentColor"/>';

/** The glyph's SVG markup (paths only) for a `Mode` value; the neutral dot when there is none. */
export function glyphPaths(mode) {
    return GLYPHS[mode] ?? NEUTRAL;
}

/** Whether the mark is a mode's glyph, rather than the neutral dot. */
export const hasModeGlyph = (mode) => mode in GLYPHS;
