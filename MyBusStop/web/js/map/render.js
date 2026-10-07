// Draws a map scene into an <svg>. Ported from BusBus/Board/MapView.swift, MapRailsCanvas.swift,
// StopLabelsLayer.swift, BusPuckView.swift and LineBadgeView.swift.
//
// The scene holds every coordinate; nothing geometric is computed here beyond placing text on the
// anchors the engine chose. Layers, bottom to top, as in the app:
//   1. rails, terminus bars, rings, capsules, the stub and node      (MapRailsCanvas)
//   2. stop names, "+N STOPS" captions, terminus badges             (StopLabelsLayer)
//      — both cross-fade when the trunk changes
//   3. bus pucks, which slide between renders rather than fading
//   4. the YOUR STOP caption and the "TAP A BUS" hint

import { layoutMap, wrapLabelLines } from './engine.js';
import { chooseMapLayout } from './layout-mode.js';
import { PRESET, READABLE_MINIMUM, MONO_ADVANCE_EM, LINE_HEIGHT_EM, charCount } from './metrics.js';
import { THEMES, railColor, numeralColor, labelColor } from './palette.js';

const NS = 'http://www.w3.org/2000/svg';
const DIMMED = 0.45;
const PUCK_FADED = 0.55;
const PUCK_SLIDE = '600ms';
const CROSS_FADE_MS = 400;

// Fonts: the app's Space Mono Bold (codes, stop names, captions) and Archivo Black (numerals),
// with Archivo Bold standing in for Space Mono where a script is set solid.
const MONO = '\'Space Mono\', ui-monospace, monospace';
const SANS = '\'Archivo\', system-ui, sans-serif';
/** Space Mono's ascender and descender, in em: its line box is 1.48 em with the baseline 1.12 down. */
const MONO_ASCENT = 1.12;
const MONO_DESCENT = 0.36;
/** Archivo's line box, for centring a numeral the way SwiftUI centres its line. */
const SANS_ASCENT = 0.878;
const SANS_DESCENT = 0.21;
/** An Archivo Black figure's advance, roughly, for shrinking a long line number into its badge. */
const NUMERAL_ADVANCE_EM = 0.66;

const states = new WeakMap();

function el(name, attrs = {}, parent = null) {
    const node = document.createElementNS(NS, name);
    for (const key in attrs) {
        const value = attrs[key];
        if (value !== null && value !== undefined) node.setAttribute(key, String(value));
    }
    if (parent) parent.appendChild(node);
    return node;
}

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Letter-spaced monospace is a Latin idiom. A name from a feed is tracked only if every letter is
 * Latin (Vietnamese's included), Greek or Cyrillic; a Hebrew or Arabic stop name is set solid, in
 * Archivo, so the browser's own face for that script takes over.
 */
export function isTrackedText(text) {
    for (const ch of text) {
        if (!/\p{Alphabetic}/u.test(ch)) continue;
        const code = ch.codePointAt(0);
        if (!(code < 0x0530 || (code >= 0x1E00 && code <= 0x1FFF))) return false;
    }
    return true;
}

/** Face, size and spacing for one run of map text, floored at the readable minimum. */
function textStyle(text, fontSize, trackingPx) {
    const tracked = isTrackedText(text);
    return {
        family: tracked ? MONO : SANS,
        size: Math.max(READABLE_MINIMUM, fontSize),
        tracking: tracked ? trackingPx : 0,
        ascent: tracked ? MONO_ASCENT : SANS_ASCENT,
        descent: tracked ? MONO_DESCENT : SANS_DESCENT,
    };
}

function textNode(parent, text, style, attrs) {
    const node = el('text', {
        'font-family': style.family,
        'font-weight': 700,
        'font-size': r2(style.size),
        'letter-spacing': style.tracking ? r2(style.tracking) : null,
        ...attrs,
    }, parent);
    node.textContent = text;
    return node;
}

/** Baseline that puts the line box's vertical centre on `y`. */
const centredBaseline = (y, style) => y + (style.ascent - style.descent) / 2 * style.size;

// MARK: - Fitting text into the canvas
//
// The app sizes a portrait name to itself and lets the map's frame clip it; its fixture names are
// short. Real feeds are not ("Clapham Common Station (Stop TT)"), so here a horizontal name is held
// inside the canvas: wrapped onto a second line where the names above and below leave room, and
// cut with an ellipsis where they do not.

/** Keeps a name this far from the canvas edge. */
const EDGE_MARGIN = 4;
const ELLIPSIS = '…';
let measureContext;

/**
 * Width of a run of text as drawn. Space Mono is monospaced, so its width is exact without a
 * font; anything set solid (Archivo or a system face for its script) is measured.
 */
function measureText(text, style) {
    const chars = charCount(text);
    if (style.family === MONO) return chars * (style.size * MONO_ADVANCE_EM + style.tracking);
    try {
        if (measureContext === undefined) {
            measureContext = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
        }
        if (measureContext) {
            measureContext.font = `700 ${style.size}px ${style.family}`;
            return measureContext.measureText(text).width + chars * style.tracking;
        }
    } catch {
        measureContext = null;
    }
    return chars * style.size * 0.58;
}

/** The longest start of `text` that fits in `available` with an ellipsis after it. */
function ellipsize(text, style, available) {
    if (measureText(text, style) <= available) return text;
    const chars = [...text];
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {   // the most characters whose prefix + ellipsis fits
        const mid = Math.ceil((lo + hi) / 2);
        if (measureText(chars.slice(0, mid).join('').trimEnd() + ELLIPSIS, style) <= available) lo = mid;
        else hi = mid - 1;
    }
    return lo === 0 ? (measureText(ELLIPSIS, style) <= available ? ELLIPSIS : '') : chars.slice(0, lo).join('').trimEnd() + ELLIPSIS;
}

/**
 * Breaks a name into at most two lines inside `available`, between words where it can and inside
 * a word that is longer than the line. The second line is cut with an ellipsis if it overflows.
 */
function wrapTwoLines(text, style, available) {
    const words = text.split(' ').filter((w) => w.length > 0);
    let first = '';
    let used = 0;
    for (const word of words) {
        const candidate = first ? `${first} ${word}` : word;
        if (measureText(candidate, style) > available) break;
        first = candidate;
        used += 1;
    }
    let rest;
    if (used === 0) {
        // The first word alone is wider than the line: break inside it.
        const chars = [...text];
        let n = 1;
        while (n < chars.length && measureText(chars.slice(0, n + 1).join(''), style) <= available) n += 1;
        first = chars.slice(0, n).join('');
        rest = chars.slice(n).join('').trimStart();
    } else {
        rest = words.slice(used).join(' ');
    }
    return rest ? [first, ellipsize(rest, style, available)] : [first];
}

/** Room for a horizontal run of text anchored at `x`, inside a canvas `width` wide. */
function roomFor(alignment, x, width) {
    if (alignment === 'trailing') return x - EDGE_MARGIN;
    if (alignment === 'center') return 2 * Math.min(x, width - x) - 2 * EDGE_MARGIN;
    return width - x - EDGE_MARGIN;
}

/**
 * Fits every horizontal name. Names sharing a column (same edge, same x) are stacked along it, so
 * a name may take a second line only if the centre of the name (or "+N STOPS" caption) above and
 * below is far enough away for both to stand clear.
 *
 * @returns {Map<label, string[]>} the lines to draw for each horizontal label
 */
function fitHorizontalLabels(labels, dashCaptions, width) {
    const items = labels.map((label) => {
        const style = textStyle(label.text, label.fontSize, label.fontSize * label.trackingEm);
        const available = Math.max(0, roomFor(label.alignment, label.anchor.x, width));
        const fits = measureText(label.text, style) <= available;
        return {
            label, style, available,
            column: `${label.alignment}@${Math.round(label.anchor.x)}`,
            y: label.anchor.y,
            wants: fits ? 1 : wrapTwoLines(label.text, style, available).length,
        };
    });
    const obstacles = dashCaptions.map((d) => ({
        column: `${d.labelAlignment}@${Math.round(d.labelCenter.x)}`,
        y: d.labelCenter.y,
        wants: 1,
        lineHeight: Math.max(READABLE_MINIMUM, d.fontSize) * LINE_HEIGHT_EM,
    }));

    const result = new Map();
    for (const item of items) {
        const lineHeight = item.style.size * LINE_HEIGHT_EM;
        let lines = [item.label.text];
        if (item.wants === 2) {
            const roomy = items.concat(obstacles).every((other) => {
                if (other === item || other.column !== item.column) return true;
                const otherHeight = (other.lineHeight ?? other.style.size * LINE_HEIGHT_EM) * other.wants;
                return Math.abs(other.y - item.y) >= (2 * lineHeight + otherHeight) / 2 + 1;
            });
            lines = roomy ? wrapTwoLines(item.label.text, item.style, item.available) : [ellipsize(item.label.text, item.style, item.available)];
        } else if (measureText(item.label.text, item.style) > item.available) {
            lines = [ellipsize(item.label.text, item.style, item.available)];
        }
        result.set(item.label, lines);
    }
    return result;
}

const anchorFor = (alignment) => (alignment === 'trailing' ? 'end' : alignment === 'center' ? 'middle' : 'start');

// MARK: - Layer 1: rails and marks

function drawRails(group, scene, theme) {
    for (const rail of scene.rails) {
        const color = railColor(rail.colorIndex, theme.isLight);
        const opacity = rail.dimmed ? DIMMED : null;
        let solid = '';
        let cursor = null;
        for (const s of rail.segments) {
            if (s.type === 'dashed') {
                el('path', {
                    d: `M${r2(s.from.x)} ${r2(s.from.y)}L${r2(s.to.x)} ${r2(s.to.y)}`,
                    fill: 'none', stroke: color, 'stroke-width': r2(rail.width), 'stroke-linecap': 'butt',
                    'stroke-dasharray': `${r2(s.on)} ${r2(s.off)}`, 'stroke-opacity': opacity,
                }, group);
                cursor = null;
                continue;
            }
            if (!cursor || cursor.x !== s.from.x || cursor.y !== s.from.y) solid += `M${r2(s.from.x)} ${r2(s.from.y)}`;
            solid += s.type === 'cubic'
                ? `C${r2(s.c1.x)} ${r2(s.c1.y)} ${r2(s.c2.x)} ${r2(s.c2.y)} ${r2(s.to.x)} ${r2(s.to.y)}`
                : `L${r2(s.to.x)} ${r2(s.to.y)}`;
            cursor = s.to;
        }
        if (solid) {
            el('path', {
                d: solid, fill: 'none', stroke: color, 'stroke-width': r2(rail.width),
                'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': opacity,
            }, group);
        }
    }
}

function drawTermini(group, scene, theme) {
    for (const t of scene.termini) {
        if (t.style !== 'bar') continue;   // badges are drawn with the labels
        el('rect', {
            x: r2(t.rect.x), y: r2(t.rect.y), width: r2(t.rect.width), height: r2(t.rect.height),
            rx: r2(t.cornerRadius), fill: railColor(t.colorIndex, theme.isLight),
            'fill-opacity': t.dimmed ? DIMMED : null,
        }, group);
    }
}

/** Each mark is filled with the board's ground, so the rail under it stops at its edge. */
function drawRings(group, scene, theme) {
    for (const mark of scene.stops) {
        if (mark.kind !== 'ring') continue;
        el('circle', {
            cx: r2(mark.center.x), cy: r2(mark.center.y), r: r2(mark.ringRadius),
            fill: theme.background, stroke: railColor(mark.colorIndex, theme.isLight),
            'stroke-width': r2(mark.strokeWidth), 'stroke-opacity': mark.dimmed ? DIMMED : null,
        }, group);
    }
}

/**
 * One capsule spanning the whole bundle, never a dot per line: that is what tells you the wait is
 * shared between the lines running together there.
 */
function drawCapsules(group, scene, theme) {
    for (const mark of scene.stops) {
        if (mark.kind !== 'capsule') continue;
        const r = mark.capsuleRect;
        el('rect', {
            x: r2(r.x), y: r2(r.y), width: r2(r.width), height: r2(r.height), rx: r2(mark.capsuleCornerRadius),
            fill: theme.background, stroke: theme.primaryText, 'stroke-width': r2(mark.strokeWidth),
            'stroke-opacity': mark.dimmed ? DIMMED : null,
        }, group);
    }
}

function drawConvergence(group, scene, theme) {
    const c = scene.convergence;
    if (!scene.trunkLineID) return;
    el('path', {
        d: `M${r2(c.stubFrom.x)} ${r2(c.stubFrom.y)}L${r2(c.stubTo.x)} ${r2(c.stubTo.y)}`,
        stroke: theme.primaryText, 'stroke-width': r2(c.stubWidth), 'stroke-linecap': 'round', fill: 'none',
    }, group);
    el('circle', {
        cx: r2(c.nodeCenter.x), cy: r2(c.nodeCenter.y), r: r2(c.nodeRadius),
        fill: theme.background, stroke: theme.primaryText, 'stroke-width': r2(c.nodeStrokeWidth),
    }, group);
}

// MARK: - Layer 2: names, captions, badges

function labelColorFor(label, scene, theme, passedStopCode) {
    if (passedStopCode && label.stopCode === passedStopCode) return theme.primaryText;
    switch (label.role) {
    case 'terminus': return labelColor(label.colorIndex, theme.isLight);
    case 'junction':
    case 'passed': return theme.primaryText;
    default: return scene.preset === PRESET.landscapeSingle ? theme.secondaryText : theme.stopName;
    }
}

/**
 * In landscape the names are set at −35°, anchored at the dot and rising to the right. That is the
 * whole reason a stop can have a long name here: parallel lines of text can never collide, so the
 * only cost of a long name is vertical rise, which the row pitch absorbs.
 */
function drawLabels(group, scene, theme, passedStopCode, width) {
    const fitted = fitHorizontalLabels(scene.labels.filter((l) => l.rotationDegrees === 0),
        scene.dashes.filter((d) => d.showLabel), width);
    for (const label of scene.labels) {
        // Tracking is set from the geometric size, not the floored one.
        const style = textStyle(label.text, label.fontSize, label.fontSize * label.trackingEm);
        const fill = labelColorFor(label, scene, theme, passedStopCode);
        const opacity = label.dimmed ? DIMMED : null;
        const { x, y } = label.anchor;

        if (label.rotationDegrees !== 0) {
            // Anchored at the bottom-leading corner of the text box and turned about it.
            const glyph = style.family === MONO
                ? style.size * MONO_ADVANCE_EM + style.tracking
                : style.size * 0.55;
            const wrapped = wrapLabelLines(label.text, label.maxWidth, glyph, label.lineLimit);
            const lines = wrapped.lines.slice();
            if (wrapped.truncated) {
                const capacity = label.maxWidth > 0 ? Math.max(1, Math.floor(label.maxWidth / glyph)) : Infinity;
                const last = lines[lines.length - 1];
                lines[lines.length - 1] = charCount(last) + 1 > capacity
                    ? [...last].slice(0, Math.max(1, capacity - 1)).join('') + '…'
                    : `${last}…`;
            }
            const g = el('g', { transform: `rotate(${label.rotationDegrees} ${r2(x)} ${r2(y)})`, opacity }, group);
            const lineHeight = style.size * LINE_HEIGHT_EM;
            const text = textNode(g, '', style, { fill });
            lines.forEach((line, i) => {
                const span = el('tspan', {
                    x: r2(x),
                    y: r2(y - (lines.length - 1 - i) * lineHeight - style.descent * style.size),
                }, text);
                span.textContent = line;
            });
            if (wrapped.truncated) el('title', {}, text).textContent = label.text;
        } else {
            const lines = fitted.get(label) ?? [label.text];
            const lineHeight = style.size * LINE_HEIGHT_EM;
            const text = textNode(group, '', style, { fill, opacity, 'text-anchor': anchorFor(label.alignment) });
            // Centred on the anchor as a block, one line or two.
            lines.forEach((line, i) => {
                const span = el('tspan', {
                    x: r2(x),
                    y: r2(centredBaseline(y, style) + (i - (lines.length - 1) / 2) * lineHeight),
                }, text);
                span.textContent = line;
            });
            if (lines.join(' ') !== label.text) el('title', {}, text).textContent = label.text;
        }
    }
}

function drawDashCaptions(group, scene, theme, width) {
    for (const dash of scene.dashes) {
        if (!dash.showLabel) continue;
        const size = Math.max(READABLE_MINIMUM, dash.fontSize);
        const full = `+${dash.swallowedCount} STOPS`;
        // Tracking is proportional to size, so a size raised to the floor takes its tracking along.
        const style = textStyle(full, dash.fontSize, size * dash.trackingEm);
        const text = ellipsize(full, style, Math.max(0, roomFor(dash.labelAlignment, dash.labelCenter.x, width)));
        textNode(group, text, style, {
            x: r2(dash.labelCenter.x), y: r2(centredBaseline(dash.labelCenter.y, style)),
            fill: theme.dashCaption, opacity: dash.dimmed ? DIMMED : null,
            'text-anchor': anchorFor(dash.labelAlignment),
        });
    }
}

/**
 * The square that carries a line number, centred on (cx, cy). A long number shrinks into the
 * padding (to half size at most) rather than running into the corners.
 */
function drawNumeral(parent, number, cx, cy, size, boxWidth, padding, color) {
    const text = String(number);
    const available = Math.max(1, boxWidth - 2 * padding);
    const natural = Math.max(1, charCount(text)) * NUMERAL_ADVANCE_EM * size;
    const fitted = size * Math.max(0.5, Math.min(1, available / natural));
    const node = el('text', {
        x: r2(cx), y: r2(cy + (SANS_ASCENT - SANS_DESCENT) / 2 * fitted),
        'font-family': SANS, 'font-weight': 900, 'font-size': r2(fitted),
        'text-anchor': 'middle', fill: color,
    }, parent);
    node.textContent = text;
    return node;
}

function drawBadges(group, scene, theme) {
    for (const t of scene.termini) {
        if (t.style !== 'badge') continue;
        const side = Math.min(t.rect.width, t.rect.height);
        const cx = t.rect.x + t.rect.width / 2;
        const cy = t.rect.y + t.rect.height / 2;
        const g = el('g', { opacity: t.dimmed ? DIMMED : null }, group);
        el('rect', {
            x: r2(cx - side / 2), y: r2(cy - side / 2), width: r2(side), height: r2(side),
            rx: r2(t.cornerRadius), fill: railColor(t.colorIndex, theme.isLight),
        }, g);
        drawNumeral(g, t.number, cx, cy, Math.max(READABLE_MINIMUM, t.fontSize), side, side * 0.14,
            numeralColor(t.colorIndex, theme.isLight));
    }
}

// MARK: - Layer 3: pucks

/**
 * What a puck looks like: a badge carrying the line number, punched through the rail it sits on,
 * ringed when it is the bus the readout is about. Drawn centred on (0, 0).
 */
function drawPuckContent(inner, puck, theme) {
    const { width: w, height: h } = puck.size;
    const halo = puck.haloWidth;
    const ring = puck.ringWidth;
    const target = { w: Math.max(44, w), h: Math.max(44, h) };
    // The mark is 44×36, but the target is never smaller than 44 in either direction.
    el('rect', {
        x: r2(-target.w / 2), y: r2(-target.h / 2), width: r2(target.w), height: r2(target.h),
        fill: 'transparent', 'pointer-events': 'all',
    }, inner);
    // The halo punches the puck through the rail it sits on.
    el('rect', {
        x: r2(-w / 2 - halo), y: r2(-h / 2 - halo), width: r2(w + 2 * halo), height: r2(h + 2 * halo),
        rx: r2(puck.cornerRadius + halo), fill: theme.background,
    }, inner);
    el('rect', {
        x: r2(-w / 2), y: r2(-h / 2), width: r2(w), height: r2(h),
        rx: r2(puck.cornerRadius), fill: railColor(puck.colorIndex, theme.isLight),
    }, inner);
    drawNumeral(inner, puck.lineNumber, 0, 0, Math.max(READABLE_MINIMUM, puck.fontSize), w, w * 0.12,
        numeralColor(puck.colorIndex, theme.isLight));
    if (puck.isSelected) {
        const inset = halo + ring / 2;
        el('rect', {
            x: r2(-w / 2 - inset), y: r2(-h / 2 - inset), width: r2(w + 2 * inset), height: r2(h + 2 * inset),
            rx: r2(puck.cornerRadius + halo + ring), fill: 'none',
            stroke: theme.primaryText, 'stroke-width': r2(ring),
        }, inner);
    }
}

function prefersReducedMotion() {
    try {
        return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

const PUCK_TRANSITION = `transform ${PUCK_SLIDE} ease-in-out, opacity 300ms ease`;

/**
 * @param relayout true when the map itself was laid out anew (a new size, axis, scale, trunk or set
 *   of lines). A bus then jumps to its place instead of sliding: the stops near the node are placed
 *   back from it, so a resize moves them, and a slide would show the bus travelling along a route
 *   it is not on — or leave it below the node while the slide runs.
 */
function updatePucks(state, scene, theme, staleIDs, selectedScale, relayout) {
    const layer = state.puckLayer;
    const seen = new Set();
    const reduce = prefersReducedMotion();
    let jumped = false;

    for (const puck of scene.pucks) {
        seen.add(puck.id);
        let entry = state.pucks.get(puck.id);
        const transform = `translate(${r2(puck.center.x)}px, ${r2(puck.center.y)}px)`;
        if (!entry) {
            const outer = el('g', { class: 'map-puck', role: 'button', tabindex: 0 }, layer);
            const inner = el('g', {}, outer);
            outer.style.transform = transform;
            inner.style.transformOrigin = '0 0';
            outer.style.cursor = 'pointer';
            const busID = puck.id;
            outer.addEventListener('click', (event) => {
                event.stopPropagation();
                state.onBusTap?.(busID);
            });
            outer.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    state.onBusTap?.(busID);
                }
            });
            entry = { outer, inner };
            state.pucks.set(puck.id, entry);
            // Arrives where it is; slides from the next render on.
            if (!reduce) {
                requestAnimationFrame(() => {
                    outer.style.transition = PUCK_TRANSITION;
                    inner.style.transition = 'transform 250ms ease';
                });
            }
        } else if (relayout && entry.outer.style.transition) {
            entry.outer.style.transition = 'none';
            entry.outer.style.transform = transform;
            jumped = true;
        } else {
            entry.outer.style.transform = transform;
        }
        entry.inner.replaceChildren();
        drawPuckContent(entry.inner, puck, theme);
        entry.inner.style.transform = puck.isSelected ? `scale(${selectedScale})` : 'scale(1)';
        const faded = puck.dimmed || staleIDs.has(puck.id);
        entry.outer.style.opacity = faded ? String(PUCK_FADED) : '1';
        entry.outer.setAttribute('aria-label', `Bus ${puck.lineNumber}${puck.isSelected ? ', selected' : ''}`);
        if (puck.isSelected) entry.outer.setAttribute('aria-pressed', 'true');
        else entry.outer.removeAttribute('aria-pressed');
    }

    if (jumped) {
        // Commit the jump before the slide comes back for the next render.
        layer.getBoundingClientRect();
        for (const id of seen) {
            const entry = state.pucks.get(id);
            if (entry.outer.style.transition === 'none') entry.outer.style.transition = PUCK_TRANSITION;
        }
    }

    for (const [id, entry] of state.pucks) {
        if (seen.has(id)) continue;
        entry.outer.remove();
        state.pucks.delete(id);
    }

    // The bus you are waiting for is drawn last so its ring is never clipped by another puck.
    // Only reorder when the order changed: moving a node restarts its slide.
    const wanted = scene.pucks.map((p) => state.pucks.get(p.id).outer);
    const current = Array.from(layer.children);
    if (wanted.some((node, i) => current[i] !== node)) {
        for (const node of wanted) layer.appendChild(node);
    }
}

// MARK: - Layer 4: caption and hint

function drawOverlay(group, scene, theme, hintText) {
    const c = scene.convergence;
    if (scene.trunkLineID) {
        const text = 'YOUR STOP';
        const size = Math.max(READABLE_MINIMUM, c.captionFontSize);
        const style = textStyle(text, c.captionFontSize, size * c.captionTrackingEm);
        // Under the node in landscape (its top edge on the anchor), beside it in portrait.
        const y = c.captionIsBelow ? c.captionAnchor.y + style.ascent * style.size : centredBaseline(c.captionAnchor.y, style);
        textNode(group, text, style, {
            x: r2(c.captionAnchor.x), y: r2(y), fill: theme.primaryText,
            'text-anchor': c.captionIsBelow ? 'middle' : 'start',
        });
    }
    if (scene.hintAnchor && hintText) {
        const size = Math.max(READABLE_MINIMUM, 11 * scene.scale);
        const style = textStyle(hintText, size, size * 0.14);
        textNode(group, hintText, style, {
            x: r2(scene.hintAnchor.x), y: r2(scene.hintAnchor.y + style.ascent * style.size),
            fill: theme.dashCaption,
        });
    }
}

// MARK: - Entry point

/**
 * Lays out and draws the map into `svg`, re-rendering in place. Pucks keep their element between
 * calls (keyed by bus id) so they slide to their new position.
 *
 * @param {SVGSVGElement} svg
 * @param {object} options
 * @param {Array<{id:string, number:string, colorIndex:number, stops:Array<{code:string,name:string}>}>} options.lines
 *   selection order 1…3; each line's stops run terminus first … rider's stop LAST.
 * @param {string} options.trunkLineID the line drawn as the straight spine.
 * @param {string} options.userStopCode
 * @param {Array<{id:string, lineID:string, lastStopIndex:number, progressToNext:number, isSelected?:boolean, isStale?:boolean}>} [options.vehicles]
 * @param {number} options.width CSS px of the map area
 * @param {number} options.height
 * @param {'dark'|'light'} [options.theme]
 * @param {(busID: string) => void} [options.onBusTap]
 * Optional overrides: axis, preset, scale, orientation ('landscape'|'portrait'), namedLineIDs
 * (null = all), highlightedLineID (dims every other line), passedStopCode (drawn in primary text),
 * hint (true or a string: the "TAP A BUS TO INSPECT IT" line, landscape only), tailBudget,
 * headCount, minimumStopPitch.
 * @returns the scene drawn.
 */
export function renderMap(svg, options) {
    const width = Math.max(1, options.width);
    const height = Math.max(1, options.height);
    const lines = options.lines ?? [];
    const theme = THEMES[options.theme === 'light' ? 'light' : 'dark'];
    const mode = chooseMapLayout(width, height, lines.length, { orientation: options.orientation });
    const trunkLineID = options.trunkLineID ?? lines[0]?.id ?? '';

    const scene = layoutMap({
        lines,
        trunkLineID,
        userStopCode: options.userStopCode ?? '',
        vehicles: options.vehicles ?? [],
        axis: options.axis ?? mode.axis,
        preset: options.preset ?? mode.preset,
        canvasSize: { width, height },
        scale: options.scale ?? mode.scale,
        namedLineIDs: options.namedLineIDs !== undefined ? options.namedLineIDs : mode.namedLineIDs(trunkLineID),
        highlightedLineID: options.highlightedLineID ?? null,
        tailBudget: options.tailBudget ?? null,
        headCount: options.headCount ?? null,
        minimumStopPitch: options.minimumStopPitch ?? null,
    });

    let state = states.get(svg);
    // Someone else emptied the svg (a "no route" note, say): start again rather than drawing into
    // layers that are no longer in it.
    if (state && state.baseLayer.parentNode !== svg) {
        states.delete(svg);
        state = null;
    }
    if (!state) {
        svg.replaceChildren();
        state = {
            baseLayer: el('g', { class: 'map-base' }, svg),
            puckLayer: el('g', { class: 'map-pucks' }, svg),
            overlay: el('g', { class: 'map-overlay', 'pointer-events': 'none' }, svg),
            base: null,
            trunkLineID: null,
            pucks: new Map(),
            onBusTap: null,
        };
        states.set(svg, state);
        svg.setAttribute('role', 'group');
        svg.setAttribute('aria-label', 'Route map');
        // The −35° angle lets a long name reach a little way above the map, into the header band;
        // only the sides and the foot of the map are a boundary.
        svg.style.overflow = 'visible';
    }
    state.onBusTap = options.onBusTap ?? null;
    state.lastOptions = options;
    // A name set solid is measured to fit it; measured before the web font arrives it would be cut
    // to the fallback's width, so draw once more when the fonts are in.
    if (!state.awaitingFonts && typeof document !== 'undefined' && document.fonts && document.fonts.status !== 'loaded') {
        state.awaitingFonts = true;
        document.fonts.ready.then(() => {
            state.awaitingFonts = false;
            if (state.lastOptions && svg.isConnected) renderMap(svg, state.lastOptions);
        });
    }

    svg.setAttribute('viewBox', `0 0 ${r2(width)} ${r2(height)}`);
    svg.setAttribute('width', r2(width));
    svg.setAttribute('height', r2(height));

    // Rails, marks and names, rebuilt whole. They cross-fade when the trunk changes; the pucks
    // slide, so they sit outside the fade.
    const base = el('g', { 'pointer-events': 'none' });
    drawRails(base, scene, theme);
    drawTermini(base, scene, theme);
    drawRings(base, scene, theme);
    drawCapsules(base, scene, theme);
    drawConvergence(base, scene, theme);
    drawLabels(base, scene, theme, options.passedStopCode ?? null, width);
    drawDashCaptions(base, scene, theme, width);
    drawBadges(base, scene, theme);

    const previous = state.base;
    const trunkChanged = previous && state.trunkLineID !== null && state.trunkLineID !== scene.trunkLineID;
    state.baseLayer.appendChild(base);
    if (previous) {
        if (trunkChanged && !prefersReducedMotion()) {
            base.style.opacity = '0';
            base.style.transition = `opacity ${CROSS_FADE_MS}ms ease-in-out`;
            previous.style.transition = `opacity ${CROSS_FADE_MS}ms ease-in-out`;
            requestAnimationFrame(() => {
                base.style.opacity = '1';
                previous.style.opacity = '0';
            });
            setTimeout(() => previous.remove(), CROSS_FADE_MS + 50);
        } else {
            previous.remove();
        }
    }
    // Anything left over from an interrupted fade.
    for (const child of Array.from(state.baseLayer.children)) {
        if (child !== base && child !== previous) child.remove();
    }
    state.base = base;
    state.trunkLineID = scene.trunkLineID;

    const staleIDs = new Set((options.vehicles ?? []).filter((v) => v.isStale).map((v) => v.id));
    const layoutKey = [r2(width), r2(height), scene.axis, scene.preset, r2(scene.scale),
        lines.map((l) => `${l.id}:${l.stops.length}`).join(',')].join('|');
    const relayout = state.layoutKey !== undefined && state.layoutKey !== layoutKey;
    state.layoutKey = layoutKey;
    updatePucks(state, scene, theme, staleIDs, 1.14, relayout);

    state.overlay.replaceChildren();
    const hintText = options.hint === true ? 'TAP A BUS TO INSPECT IT' : (typeof options.hint === 'string' ? options.hint : null);
    drawOverlay(state.overlay, scene, theme, hintText);
    return scene;
}
