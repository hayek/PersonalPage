// A line's road on a real map: OpenFreeMap's streets drawn by MapLibre GL JS, the line over them
// in its colour, its stops on it and, in the full lines view, its buses. Shared by the line card
// and the full lines view's map, as BusBus/Board/LineCardView.swift and FullRouteMapView.swift
// share their look in the app.
//
// MapLibre (vendor/maplibre-gl, about 300 KB gzipped) is fetched the first time a map opens and
// never before; a rider who never opens one never downloads it. The streets come from
// OpenFreeMap: keyless, no account, nothing sent but the tiles asked for.

import { isLightTheme } from '../ui.js';
import { THEMES } from '../map/index.js';

const VENDOR = new URL('../../vendor/maplibre-gl/', import.meta.url);

/** OpenFreeMap's quiet styles, one per theme, so the line's colour is the loudest thing drawn. */
export const STYLES = Object.freeze({
    light: 'https://tiles.openfreemap.org/styles/positron',
    dark: 'https://tiles.openfreemap.org/styles/dark',
});

/** A finger's reach around a stop's dot, in CSS pixels: the dots are drawn far smaller. */
const HIT_SLOP = 14;
/** The least a map frames, so a short line still shows the streets around it (MapFraming). */
const MINIMUM_METERS = 600;
const PADDING = 0.12;

/**
 * Dot sizes and ring widths, as the app's StopDot draws them on a map: a plain stop, a terminus a
 * size up, and the stop the card was opened from (or the rider's own) larger still and filled.
 * MapLibre strokes a circle outside its radius, so the radius is the side less the ring.
 */
const MARKS = Object.freeze({
    stop: { side: 8, ring: 2 },
    terminus: { side: 13, ring: 3.5 },
    highlighted: { side: 18, ring: 3.5 },
});
/** The halo round the stop last tapped: 5 px clear of the dot, 2.5 px wide. */
const HALO_GAP = 5;
const HALO_RING = 2.5;

let library = null;

/** MapLibre and its stylesheet, fetched once; a failure is forgotten so the next map tries again. */
export function loadMapLibre() {
    if (!library) {
        const href = new URL('maplibre-gl.css', VENDOR).href;
        const css = document.querySelector(`link[href="${href}"]`) ? Promise.resolve() : new Promise((resolve, reject) => {
            const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
            link.onload = resolve;
            link.onerror = () => { link.remove(); reject(new Error('the map’s stylesheet did not load')); };
            document.head.append(link);
        });
        library = Promise.all([import(new URL('maplibre-gl.mjs', VENDOR).href), css]).then(([module]) => module);
        library.catch(() => { library = null; });
    }
    return library;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A map in `container`, in the board's theme. What it draws is set with `setRoutes`, `setStops`
 * and `setBuses` at any time; anything set before the style has loaded is drawn once it has.
 * Rejects when MapLibre cannot be loaded or the browser has no WebGL.
 *
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {{top?: number, right?: number, bottom?: number, left?: number}} [options.insets]
 *   room kept clear at the edges when framing (the full lines view's toggle sits over the foot)
 * @param {(stop: {code: string, index: number}) => void} [options.onStopTap]
 * @param {() => void} [options.onError] the streets could not be loaded
 */
export async function createRouteMap(container, { insets = {}, onStopTap, onError } = {}) {
    const maplibre = await loadMapLibre();
    const theme = THEMES[isLightTheme() ? 'light' : 'dark'];
    const map = new maplibre.Map({
        container,
        style: STYLES[theme.isLight ? 'light' : 'dark'],
        // OpenFreeMap's terms ask for the credit in full, not folded behind a button.
        attributionControl: { compact: false },
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxPitch: 0,
        renderWorldCopies: false,
        fadeDuration: reducedMotion() ? 0 : 300,
        center: [0, 20],
        zoom: 1,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    // OpenFreeMap's dark style names a pattern ("wood-pattern") its sprite lacks: a clear pixel in
    // its place draws what the style would have drawn without it, and keeps the console quiet.
    map.setMissingStyleImageResolver?.((id) => {
        if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
    });

    const data = { routes: [], stops: [], buses: [] };
    let loaded = false;
    let pendingFrame = null;
    let removed = false;

    map.on('load', () => {
        loaded = true;
        addLayers(map, theme);
        for (const kind of Object.keys(data)) push(kind);
        if (pendingFrame) frame(...pendingFrame);
    });
    map.on('error', (event) => {
        // A tile now and then may fail; only a style that never came leaves the map blank.
        if (!loaded) onError?.(event.error);
    });

    // A tap finds the nearest stop within a finger's reach; a pointer over one becomes a hand.
    const stopAt = (point) => {
        if (!loaded) return null;
        const box = [[point.x - HIT_SLOP, point.y - HIT_SLOP], [point.x + HIT_SLOP, point.y + HIT_SLOP]];
        const hits = map.queryRenderedFeatures(box, { layers: ['mbs-stops'] });
        let best = null;
        let bestDistance = Infinity;
        for (const hit of hits) {
            const at = map.project(hit.geometry.coordinates);
            const distance = Math.hypot(at.x - point.x, at.y - point.y);
            if (distance < bestDistance) { best = hit; bestDistance = distance; }
        }
        return best ? { code: best.properties.code, index: best.properties.index } : null;
    };
    if (onStopTap) {
        map.on('click', (event) => {
            const stop = stopAt(event.point);
            if (stop) onStopTap(stop);
        });
        map.on('mousemove', (event) => {
            map.getCanvas().style.cursor = stopAt(event.point) ? 'pointer' : '';
        });
    }

    function push(kind) {
        if (!loaded || removed) return;
        map.getSource(`mbs-${kind}`)?.setData({ type: 'FeatureCollection', features: data[kind] });
    }

    function frame(points, animate) {
        if (!loaded) { pendingFrame = [points, animate]; return; }
        pendingFrame = null;
        const bounds = frameAround(points);
        if (!bounds) return;
        const { width, height } = container.getBoundingClientRect();
        // Room for the insets only where the map is big enough to give it.
        const pad = (value) => Math.max(0, value ?? 0);
        const padding = { top: pad(insets.top), right: pad(insets.right), bottom: pad(insets.bottom), left: pad(insets.left) };
        if (padding.top + padding.bottom >= height - 40) padding.top = padding.bottom = 0;
        if (padding.left + padding.right >= width - 40) padding.left = padding.right = 0;
        map.fitBounds(bounds, { padding, duration: animate && !reducedMotion() ? 350 : 0, maxZoom: 17 });
    }

    return {
        map,
        /** @param {Array<{color: string, branches: Array<Array<{lat:number, lon:number}>>}>} routes */
        setRoutes(routes) {
            data.routes = routes.map((route) => ({
                type: 'Feature',
                properties: { color: route.color },
                geometry: { type: 'MultiLineString', coordinates: route.branches.map((b) => b.map((p) => [p.lon, p.lat])) },
            }));
            push('routes');
        },
        /**
         * @param {Array<{code: string, index: number, location: {lat:number, lon:number}, color: string,
         *   mark: 'stop'|'terminus'|'highlighted', focused?: boolean}>} stops
         */
        setStops(stops) {
            data.stops = stops.filter((s) => isPlaced(s.location)).map((stop) => {
                const { side, ring } = MARKS[stop.mark] ?? MARKS.stop;
                const filled = stop.mark === 'highlighted';
                return {
                    type: 'Feature',
                    properties: {
                        code: stop.code, index: stop.index, focused: Boolean(stop.focused),
                        radius: side / 2 - ring, ring,
                        fill: filled ? stop.color : theme.background,
                        stroke: filled ? theme.primaryText : stop.color,
                        halo: side / 2 + HALO_GAP - HALO_RING,
                    },
                    geometry: { type: 'Point', coordinates: [stop.location.lon, stop.location.lat] },
                };
            });
            push('stops');
        },
        /** @param {Array<{id: string, location: {lat:number, lon:number}, color: string, isSelected?: boolean}>} buses */
        setBuses(buses) {
            data.buses = buses.filter((b) => isPlaced(b.location)).map((bus) => ({
                type: 'Feature',
                properties: { color: bus.color, ring: bus.isSelected ? 3 : 2, radius: bus.isSelected ? 6 : 5, selected: bus.isSelected ? 1 : 0 },
                geometry: { type: 'Point', coordinates: [bus.location.lon, bus.location.lat] },
            }));
            push('buses');
        },
        /** Frames the points, with room round the edges; `animate` eases there unless motion is reduced. */
        frame,
        resize() { if (!removed) map.resize(); },
        remove() {
            if (removed) return;
            removed = true;
            map.remove();
        },
    };
}

/** The line in its colour, cased in the ground so it reads over any road, then stops, then buses. */
function addLayers(map, theme) {
    for (const kind of ['routes', 'stops', 'buses']) {
        map.addSource(`mbs-${kind}`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    const round = { 'line-cap': 'round', 'line-join': 'round' };
    map.addLayer({ id: 'mbs-route-casing', type: 'line', source: 'mbs-routes', layout: round, paint: { 'line-color': theme.background, 'line-width': 8 } });
    map.addLayer({ id: 'mbs-route', type: 'line', source: 'mbs-routes', layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 5 } });
    map.addLayer({
        id: 'mbs-stop-halo', type: 'circle', source: 'mbs-stops', filter: ['==', ['get', 'focused'], true],
        paint: { 'circle-radius': ['get', 'halo'], 'circle-opacity': 0, 'circle-stroke-width': HALO_RING, 'circle-stroke-color': theme.primaryText },
    });
    map.addLayer({
        id: 'mbs-stops', type: 'circle', source: 'mbs-stops',
        paint: {
            'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'fill'],
            'circle-stroke-width': ['get', 'ring'], 'circle-stroke-color': ['get', 'stroke'],
        },
    });
    map.addLayer({
        id: 'mbs-buses', type: 'circle', source: 'mbs-buses',
        // The bus the readout is about drawn last, over any bus beside it.
        layout: { 'circle-sort-key': ['get', 'selected'] },
        paint: {
            'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'],
            'circle-stroke-width': ['get', 'ring'], 'circle-stroke-color': theme.primaryText,
        },
    });
}

/** A feed that leaves a stop at 0,0 has not placed it. */
function isPlaced(point) {
    return point && Number.isFinite(point.lat) && Number.isFinite(point.lon) && !(point.lat === 0 && point.lon === 0);
}

/**
 * The map's frame round some points, as [[west, south], [east, north]]: their box grown by an
 * eighth each side and to at least 600 m, so the termini are never cut in half and a short line
 * still shows its streets. Null with nothing to frame.
 */
export function frameAround(points) {
    const placed = points.filter(isPlaced);
    if (!placed.length) return null;
    let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
    for (const { lat, lon } of placed) {
        south = Math.min(south, lat); north = Math.max(north, lat);
        west = Math.min(west, lon); east = Math.max(east, lon);
    }
    const midLat = (south + north) / 2;
    const midLon = (west + east) / 2;
    const metresPerDegree = 111_320;
    const minLat = MINIMUM_METERS / metresPerDegree;
    const minLon = MINIMUM_METERS / (metresPerDegree * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)));
    const halfLat = Math.max((north - south) * (1 + 2 * PADDING), minLat) / 2;
    const halfLon = Math.max((east - west) * (1 + 2 * PADDING), minLon) / 2;
    return [[midLon - halfLon, midLat - halfLat], [midLon + halfLon, midLat + halfLat]];
}
