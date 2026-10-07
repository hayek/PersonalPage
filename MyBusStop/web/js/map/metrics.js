// Every geometric constant of the map, mined from the artboards at their reference size and
// multiplied by `scale`. Ported from BusBus/MapEngine/MapMetrics.swift.
//
// Offsets named `…FromNode` are measured backwards along the direction of travel from the node, so
// extra canvas length lengthens the dashed runs and nothing else moves.

/** Travel runs left → right (landscape) or top → bottom (portrait). */
export const AXIS = Object.freeze({ horizontal: 'horizontal', vertical: 'vertical' });

/** Which artboard's numbers apply. Chosen by the layout mode, never by the engine. */
export const PRESET = Object.freeze({
    landscape: 'landscape',             // Main / Merge / BusDetail (1280×720, 2–3 lines)
    landscapeSingle: 'landscapeSingle', // SingleLine (1280×720, 1 line)
    phone: 'phone',                     // PhoneOneLine / PhoneTwoLines / PhonePortrait (390×844)
    pad: 'pad',                         // PadPortrait (834×1194)
});

/** Space Mono sets every glyph 0.6 em wide, so a name's width is known without measuring it. */
export const MONO_ADVANCE_EM = 0.6;
/** Space Mono's line, ascender to descender. */
export const LINE_HEIGHT_EM = 1.48;
/** The size no text in the app goes below. */
export const READABLE_MINIMUM = 12;

/**
 * @param {string} preset one of PRESET
 * @param {number} scale 1 at the reference size
 * @param {number} lineCount drawable lines
 */
export function makeMetrics(preset, scale, lineCount) {
    const s = scale;
    const single = preset === PRESET.landscapeSingle;
    const phoneWide = preset === PRESET.phone && lineCount <= 1;
    const m = { preset, scale, lineCount };

    switch (preset) {
    case PRESET.phone:
        m.railWidth = (phoneWide ? 14 : 12) * s;
        m.rowOffsets = lineCount >= 3 ? [68 * s, 136 * s] : [85 * s, 85 * s];
        m.rowsAreSigned = false;        // every non-trunk column sits left of the trunk
        m.terminusAlong = 26 * s;
        m.terminusAcross = 30 * s;
        m.terminusCornerRadius = 8 * s;
        m.terminusCenterAlong = 21 * s;
        m.terminusIsBadge = true;
        m.terminusFontSize = 16 * s;
        m.firstStopAlong = 72 * s;
        m.stopPitch = (phoneWide ? 64 : 60) * s;
        // The artboards' circles are border-box, so 24/22 is the outer diameter.
        m.ringStroke = (phoneWide ? 6 : 5) * s;
        m.ringRadius = ((phoneWide ? 24 : 22) * s - m.ringStroke) / 2;
        m.dashOn = (phoneWide ? 18 : 16) * s;
        m.dashOff = (phoneWide ? 16 : 14) * s;
        m.dashFontSize = (phoneWide ? 12 : 11) * s;
        m.dashTrackingEm = 0.10;
        m.dashLabelOffset = 32 * s;
        m.minimumDashLength = 40 * s;
        m.stopNameFontSize = (phoneWide ? 12 : 11) * s;
        m.stopNameTrackingEm = 0.04;
        m.labelOffset = 32 * s;
        // 390 pt leaves about 78 pt for a name left of the second column; 22 buys back ten.
        m.trailingLabelOffset = 22 * s;
        m.namesSitRightOfEveryRail = false;
        m.labelRotation = 0;
        m.labelMaxWidth = 0;
        m.labelLineLimit = 1;
        m.nodeInsetFromEnd = 22 * s;
        m.nodeRadius = 17 * s;
        m.nodeStroke = 9 * s;
        m.stubStartFromNode = 40 * s;
        m.stubEndFromNode = 20 * s;
        m.stubWidth = 14 * s;
        m.railsEndFromNode = 38 * s;
        m.lastTailFromNode = 96 * s;
        m.curveStartFromNode = 60 * s;
        m.curveC1FromNode = 44 * s;
        m.curveC2FromNode = 56 * s;
        m.joinedCurveStartFromNode = 60 * s;
        m.joinedCurveC1FromNode = 44 * s;
        m.joinedCurveC2FromNode = 56 * s;
        m.junctionCurveLength = 60 * s;
        m.puckSize = { width: 46 * s, height: 36 * s };
        m.puckCornerRadius = 11 * s;
        m.puckFontSize = 20 * s;
        m.puckHalo = 5 * s;
        m.puckRing = 5 * s;
        m.captionFontSize = 12 * s;
        m.captionTrackingEm = 0.16;
        m.captionOffset = 33 * s;
        break;

    case PRESET.pad:
        m.railWidth = 14 * s;
        m.rowOffsets = [250 * s, 250 * s];
        m.rowsAreSigned = true;
        m.terminusAlong = 38 * s;
        m.terminusAcross = 44 * s;
        m.terminusCornerRadius = 11 * s;
        m.terminusCenterAlong = 39 * s;
        m.terminusIsBadge = true;
        m.terminusFontSize = 22 * s;
        m.firstStopAlong = 109 * s;
        m.stopPitch = 86 * s;
        m.ringStroke = 7 * s;
        m.ringRadius = (30 * s - m.ringStroke) / 2;
        m.dashOn = 20 * s;
        m.dashOff = 18 * s;
        m.dashFontSize = 12 * s;
        m.dashTrackingEm = 0.10;
        m.dashLabelOffset = 32 * s;
        m.minimumDashLength = 60 * s;
        m.stopNameFontSize = 12 * s;
        m.stopNameTrackingEm = 0.04;
        m.labelOffset = 32 * s;
        m.trailingLabelOffset = 32 * s;
        m.namesSitRightOfEveryRail = true;
        m.labelRotation = 0;
        m.labelMaxWidth = 0;
        m.labelLineLimit = 1;
        m.nodeInsetFromEnd = 44 * s;
        m.nodeRadius = 28 * s;
        m.nodeStroke = 12 * s;
        m.stubStartFromNode = 54 * s;
        m.stubEndFromNode = 26 * s;
        m.stubWidth = 18 * s;
        m.railsEndFromNode = 50 * s;
        m.lastTailFromNode = 147 * s;
        m.curveStartFromNode = 96 * s;
        m.curveC1FromNode = 70 * s;
        m.curveC2FromNode = 86 * s;
        m.joinedCurveStartFromNode = 96 * s;
        m.joinedCurveC1FromNode = 70 * s;
        m.joinedCurveC2FromNode = 86 * s;
        m.junctionCurveLength = 80 * s;
        m.puckSize = { width: 52 * s, height: 40 * s };
        m.puckCornerRadius = 12 * s;
        m.puckFontSize = 22 * s;
        m.puckHalo = 6 * s;
        m.puckRing = 5 * s;
        m.captionFontSize = 13 * s;
        m.captionTrackingEm = 0.16;
        m.captionOffset = 53 * s;
        break;

    default: // landscape, landscapeSingle
        m.railWidth = (single ? 14 : 12) * s;
        m.rowOffsets = [120 * s, 120 * s];
        m.rowsAreSigned = true;
        m.terminusAlong = 10 * s;
        m.terminusAcross = (single ? 60 : 40) * s;
        m.terminusCornerRadius = 5 * s;
        m.terminusCenterAlong = 45 * s;
        m.terminusIsBadge = false;
        m.terminusFontSize = 0;
        m.firstStopAlong = (single ? 150 : 110) * s;
        m.stopPitch = 100 * s;
        m.ringRadius = (single ? 17 : 13) * s;
        m.ringStroke = (single ? 8 : 6) * s;
        m.dashOn = (single ? 22 : 20) * s;
        m.dashOff = (single ? 20 : 18) * s;
        m.dashFontSize = (single ? 13 : 11) * s;
        m.dashTrackingEm = single ? 0.14 : 0.12;
        m.dashLabelOffset = (single ? 30 : 26) * s;
        m.minimumDashLength = 60 * s;
        m.stopNameFontSize = (single ? 14 : 12) * s;
        m.stopNameTrackingEm = 0.03;
        m.labelOffset = (single ? 24 : 20) * s;
        m.trailingLabelOffset = (single ? 24 : 20) * s;
        m.namesSitRightOfEveryRail = true;
        m.labelRotation = -35;
        m.labelMaxWidth = (single ? 130 : 110) * s;
        m.labelLineLimit = 2;
        m.nodeInsetFromEnd = 90 * s;
        m.nodeRadius = 26 * s;
        m.nodeStroke = 12 * s;
        m.stubStartFromNode = 72 * s;
        m.stubEndFromNode = 28 * s;
        m.stubWidth = 16 * s;
        m.railsEndFromNode = 70 * s;
        m.lastTailFromNode = 280 * s;
        m.curveStartFromNode = 170 * s;
        m.curveC1FromNode = 124 * s;
        m.curveC2FromNode = 116 * s;
        m.joinedCurveStartFromNode = 134 * s;
        m.joinedCurveC1FromNode = 100 * s;
        m.joinedCurveC2FromNode = 94 * s;
        m.junctionCurveLength = 80 * s;
        m.puckSize = single ? { width: 56 * s, height: 40 * s } : { width: 44 * s, height: 36 * s };
        m.puckCornerRadius = 10 * s;
        m.puckFontSize = (single ? 22 : 20) * s;
        m.puckHalo = (single ? 6 : 5) * s;
        m.puckRing = 5 * s;
        m.captionFontSize = 13 * s;
        m.captionTrackingEm = 0.16;
        m.captionOffset = 46 * s;
        break;
    }

    m.capsuleWidth = 20 * s;
    m.capsuleCornerRadius = 10 * s;
    m.capsuleStroke = 4 * s;
    m.capsuleMargin = 18 * s;
    m.parallelOffset = 18 * s;
    m.selectedPuckScale = 1.14;

    // Angled names are parallel, so neighbours collide only when the gap between them is thinner
    // than the text. On a board small enough for the names to be held at the readable floor, the
    // scaled pitch leaves a gap made for smaller text; the stops, and the first stop after the
    // terminus, are kept far enough apart for the text as drawn. A full-size board keeps the
    // design's spacing.
    if (m.labelRotation !== 0 && READABLE_MINIMUM > m.stopNameFontSize) {
        // A quarter line more than the text itself, so neighbours do not touch.
        const depth = (m.labelLineLimit + 0.25) * READABLE_MINIMUM * LINE_HEIGHT_EM;
        const pitch = Math.ceil(depth / Math.sin(Math.abs(m.labelRotation) * Math.PI / 180));
        m.stopPitch = Math.max(m.stopPitch, pitch);
        m.firstStopAlong = Math.max(m.firstStopAlong, m.terminusCenterAlong + pitch);
    }

    /** Outer edge of a stop ring, used to keep dashes clear of the marks they run between. */
    m.ringOuter = m.ringRadius + m.ringStroke / 2;
    /** Head stops drawn before the dashed run; the single-line board has room for two. */
    m.headCount = single ? 2 : 1;
    /** How many stop marks the tail may spend, shared between the bundle and the line's own route. */
    m.tailBudget = preset === PRESET.landscape || single ? 5 : 4;
    m.selectedPuckSize = single ? { width: 64 * s, height: 48 * s } : m.puckSize;
    return m;
}

/** Characters, not UTF-16 units, as Swift's `String.count` (close enough to grapheme clusters). */
export function charCount(text) {
    return [...text].length;
}

/**
 * The box `name` wraps in: the design's, widened just enough for its longest word. A name is drawn
 * no smaller than READABLE_MINIMUM, so on a small board it can be larger than the box was sized
 * for. Wrapping still falls between words, so the name climbs no higher than the design allows.
 */
export function labelMaxWidthFor(metrics, name) {
    if (!(metrics.labelMaxWidth > 0)) return 0;
    const drawn = Math.max(READABLE_MINIMUM, metrics.stopNameFontSize);
    // Tracking is set from the geometric size, not the floored one (the labels layer).
    const perGlyph = drawn * MONO_ADVANCE_EM + metrics.stopNameFontSize * metrics.stopNameTrackingEm;
    const words = name.split(' ').filter((w) => w.length > 0);
    const longestWord = words.reduce((max, w) => Math.max(max, charCount(w)), 0);
    return Math.max(metrics.labelMaxWidth, Math.ceil(longestWord * perGlyph) + 1);
}
