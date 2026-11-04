// The search screen's map: OpenFreeMap's streets under the stops the drawer lists, the rider's
// own dot, and the confirm step's stop picked out — as BusBus/Setup/Search/SearchMapView.swift and
// StopPin.swift draw them in the app.
//
// The pins are buttons laid over the map rather than circles drawn into it: there are never more
// than a few dozen, each must take a tap and a keyboard's focus, and a result's pin carries its
// number in the list beside it.

import { loadMapLibre, STYLES, frameAround } from '../board/route-map.js';
import { glyphPaths } from '../map/glyphs.js';
import { isLightTheme } from '../ui.js';

/** The widest view, in metres, an area can be searched in (MapFraming.searchableSpanMeters). */
export const SEARCHABLE_SPAN = 6_000;
/** The radius an area search asks for: about what is on screen, within what providers allow. */
export const searchRadius = (span) => Math.min(Math.max(span / 2, 250), 1_500);
/** The widest view the confirm step shows its stop in: a stop picked from a whole city is brought to its streets. */
const CONFIRM_SPAN = 1_500;
const EARTH = 40_075_016.686;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Metres between two points, near enough for anything a rider walks. */
export function metresBetween(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const isPlaced = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && !(p.lat === 0 && p.lon === 0);

/**
 * @param {HTMLElement} container
 * @param {object} options
 * @param {(entry: object) => void} options.onPinTap  a pin tapped: the confirm step's way in
 * @param {() => void} options.onMapTap  the map itself tapped (BACK, while a stop is being confirmed)
 * @param {() => void} options.onMoved  the rider panned or zoomed the map
 * @param {() => {bottom: number, left: number}} options.covered  how much of the map the drawer or panel hides
 * @param {(error: Error) => void} [options.onError]
 */
export async function createSearchMap(container, { onPinTap, onMapTap, onMoved, covered, onError }) {
    const maplibre = await loadMapLibre();
    const map = new maplibre.Map({
        container,
        style: STYLES[isLightTheme() ? 'light' : 'dark'],
        attributionControl: { compact: true },
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
    map.setMissingStyleImageResolver?.((id) => {
        if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    let loaded = false;
    map.on('load', () => { loaded = true; });
    map.on('error', (event) => { if (!loaded) onError?.(event.error); });

    // Only the rider's own pans and zooms count as moving the map; the framing done here does not.
    map.on('movestart', (event) => { if (event.originalEvent) onMoved(); });
    map.on('click', (event) => {
        if (event.originalEvent?.target?.closest?.('.search-pin')) return;
        onMapTap();
    });

    /** @type {Map<string, {marker: object, element: HTMLElement, entry: object}>} */
    let pins = new Map();
    let rider = null;
    let focusedID = null;

    /** The middle of what the drawer or panel leaves uncovered, as an offset from the map's middle. */
    function offset() {
        const { bottom = 0, left = 0 } = covered();
        return [left / 2, -bottom / 2];
    }
    function padding(extra = 28) {
        const { bottom = 0, left = 0 } = covered();
        const { width, height } = container.getBoundingClientRect();
        const pad = { top: extra + 52, right: extra, bottom: bottom + extra, left: left + extra };
        // Room for the drawer only where the map is big enough to give it.
        if (pad.top + pad.bottom >= height - 60) { pad.top = extra; pad.bottom = Math.max(extra, height - 120 - extra); }
        if (pad.left + pad.right >= width - 60) pad.left = pad.right = extra;
        return pad;
    }

    function pinElement(entry, number) {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'search-pin';
        element.setAttribute('aria-label', number ? `Stop ${number}, ${entry.stop.name}` : entry.stop.name);
        const mark = document.createElement('span');
        mark.className = 'search-pin-mark';
        if (number) {
            mark.classList.add('search-pin-number');
            mark.textContent = String(number);
        } else {
            mark.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphPaths('bus')}</svg>`;
        }
        element.append(mark);
        element.addEventListener('click', (event) => {
            event.stopPropagation();
            onPinTap(entry);
        });
        return element;
    }

    function applyFocus() {
        container.classList.toggle('search-map-focusing', focusedID != null);
        for (const [id, pin] of pins) {
            const on = id === focusedID;
            pin.element.classList.toggle('focused', on);
            pin.element.setAttribute('aria-pressed', String(on));
            // Faded pins take no taps: BACK is the way out of the confirm step.
            pin.element.tabIndex = focusedID != null && !on ? -1 : 0;
            pin.element.style.zIndex = on ? '2' : '';
        }
    }

    return {
        map,

        /** The stops the list shows, numbered when they are search results. */
        setPins(entries, { numbered = false } = {}) {
            for (const pin of pins.values()) pin.marker.remove();
            pins = new Map();
            entries.forEach((entry, index) => {
                if (!isPlaced(entry.stop.location)) return;
                const id = entry.stop.code;
                if (pins.has(id)) return;
                const element = pinElement(entry, numbered ? index + 1 : null);
                const marker = new maplibre.Marker({ element, anchor: 'center' })
                    .setLngLat([entry.stop.location.lon, entry.stop.location.lat])
                    .addTo(map);
                pins.set(id, { marker, element, entry });
            });
            applyFocus();
        },

        /** The rider's own dot, or none. */
        setRider(point) {
            if (!isPlaced(point)) { rider?.remove(); rider = null; return; }
            if (!rider) {
                const element = document.createElement('div');
                element.className = 'search-rider';
                element.setAttribute('aria-hidden', 'true');
                rider = new maplibre.Marker({ element, anchor: 'center' });
                rider.setLngLat([point.lon, point.lat]).addTo(map);
            } else {
                rider.setLngLat([point.lon, point.lat]);
            }
        },

        /** The confirm step's stop raised and ringed, every other pin faded; null puts them all back. */
        setFocus(id) {
            focusedID = id;
            applyFocus();
        },

        /** Frames the points in what the drawer leaves uncovered. */
        fit(points, { animate = true, maxZoom = 16.5 } = {}) {
            const bounds = frameAround(points.filter(isPlaced));
            if (!bounds) return;
            map.fitBounds(bounds, { padding: padding(), maxZoom, duration: animate && !reducedMotion() ? 450 : 0 });
        },

        /** A whole region, before anything is known of where the rider is. */
        fitRegion([minLat, minLon, maxLat, maxLon]) {
            if (maxLat - minLat >= 170) { map.jumpTo({ center: [10, 25], zoom: 1.2 }); return; }
            map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: padding(12), duration: 0 });
        },

        /**
         * Puts a stop in the middle of what the confirm panel leaves uncovered, brought down to its
         * streets only when the view is wider than that.
         */
        focusOn(point) {
            if (!isPlaced(point)) return;
            const { left = 0 } = covered();
            const visibleWidth = Math.max(120, container.clientWidth - left);
            const metresPerPixel = (EARTH * Math.cos((point.lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
            const zoom = metresPerPixel * visibleWidth > CONFIRM_SPAN
                ? Math.log2((EARTH * Math.cos((point.lat * Math.PI) / 180) * visibleWidth) / (512 * CONFIRM_SPAN))
                : map.getZoom();
            map.easeTo({ center: [point.lon, point.lat], zoom, offset: offset(), duration: reducedMotion() ? 0 : 500 });
        },

        /** Where the map stands now, for BACK to put back. */
        camera() { const c = map.getCenter(); return { center: [c.lng, c.lat], zoom: map.getZoom() }; },
        restore(camera) {
            if (camera) map.easeTo({ center: camera.center, zoom: camera.zoom, duration: reducedMotion() ? 0 : 400 });
        },

        /** The middle of the uncovered map, and how many metres across it shows. */
        visibleArea() {
            const { bottom = 0, left = 0 } = covered();
            const width = container.clientWidth;
            const height = Math.max(1, container.clientHeight - bottom);
            const mid = map.unproject([left + (width - left) / 2, height / 2]);
            const west = map.unproject([left, height / 2]);
            const east = map.unproject([width, height / 2]);
            const north = map.unproject([left + (width - left) / 2, 0]);
            const south = map.unproject([left + (width - left) / 2, height]);
            const across = metresBetween({ lat: west.lat, lon: west.lng }, { lat: east.lat, lon: east.lng });
            const down = metresBetween({ lat: north.lat, lon: north.lng }, { lat: south.lat, lon: south.lng });
            return { center: { lat: mid.lat, lon: mid.lng }, span: Math.max(across, down) };
        },

        resize() { map.resize(); },
        remove() {
            for (const pin of pins.values()) pin.marker.remove();
            rider?.remove();
            map.remove();
        },
    };
}
