// The route map ("board map"), ported from the app's MapEngine and Board views.
//
// Pure layout (no DOM): layoutMap, RouteCompressor, JunctionDetector, chooseMapLayout,
// createTrunkSelector, assignLineColors and the palette helpers all run in Node as well.
// Drawing: renderMap(svg, options).

export { renderMap, isTrackedText } from './render.js';
export { layoutMap, sceneRail, railAcrossAt, AxisTransform, wrapLabelLines, keepingNamesInside, offsetScene } from './engine.js';
export { RouteCompressor, JunctionDetector } from './routes.js';
export { AXIS, PRESET, makeMetrics, READABLE_MINIMUM } from './metrics.js';
export { chooseMapLayout, MAP_REFERENCE } from './layout-mode.js';
export { createTrunkSelector, TRUNK_MINIMUM_INTERVAL_MS } from './trunk.js';
export {
    assignLineColors, provisionalIndex, hashedIndex,
    railColor, numeralColor, labelColor, THEMES, PALETTE_COUNT,
} from './palette.js';
