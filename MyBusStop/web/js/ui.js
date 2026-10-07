// Small DOM and formatting helpers shared by the screens.

import { railColor, numeralColor } from './map/index.js';
import { store } from './storage.js';

/** h('div', {class: 'x', onclick}, child, 'text', [more]) — a tiny element builder. */
export function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs ?? {})) {
        if (value === undefined || value === null || value === false) continue;
        if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
        else if (name === 'style' && typeof value === 'object') {
            for (const [key, v] of Object.entries(value)) if (v != null) node.style.setProperty(key.startsWith('--') ? key : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), v);
        }
        else if (name === 'dataset') Object.assign(node.dataset, value);
        else node.setAttribute(name, value === true ? '' : value);
    }
    append(node, children);
    return node;
}

function append(node, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        if (Array.isArray(child)) append(node, child);
        else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

/** An inline SVG icon from a path list (24×24 grid, stroked). */
export function icon(name, size = 22) {
    const paths = {
        back: '<path d="M15 5l-7 7 7 7"/>',
        search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
        gear: '<circle cx="12" cy="12" r="3"/><path stroke-width="2" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        locate: '<path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
        arrow: '<path d="M4 12h15M13 6l6 6-6 6"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        pin: '<path d="M9 3h6l-1 6 3 3H7l3-3-1-6zM12 12v9"/>',
        check: '<path d="M6 12.5l4 4 8-9"/>',
        expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    };
    const span = document.createElement('span');
    span.className = 'icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ''}</svg>`;
    return span;
}

export function isLightTheme() {
    if (document.body.classList.contains('wall')) return false;
    const chosen = document.documentElement.dataset.theme;
    if (chosen === 'light') return true;
    if (chosen === 'dark') return false;
    return window.matchMedia('(prefers-color-scheme: light)').matches;
}

/** Palette key for a line: the same line number means different things in different networks. */
export const lineKey = (providerID, lineID) => `${providerID}:${lineID}`;

/** A line's colour index: the one it was given when picked, else one derived from its id. */
export function colorIndexFor(providerID, line) {
    const saved = store.palette[lineKey(providerID, line.id)];
    if (saved != null) return saved;
    if (line.brandColorIndex != null) return line.brandColorIndex;
    return hashedColorIndex(line.id);
}

/** FNV-1a over the line id, as the app does, so a line looks the same here as on the phone. */
export function hashedColorIndex(lineID) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(String(lineID))) {
        hash ^= BigInt(byte);
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return Number(hash % 12n);
}

/** A line number on its colour, the way every list and the readout show it. */
export function badge(line, colorIndex, size = 'small') {
    const light = isLightTheme();
    const name = String(line.shortName ?? '?');
    return h('span', {
        class: `badge badge-${size}${name.length > 3 ? ' badge-long' : ''}`,
        style: { background: railColor(colorIndex, light), color: numeralColor(colorIndex, light) },
    }, name);
}

/** "09:41" or "9:41 AM", as the rider's browser writes times. */
export function clockTime(date) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date).toUpperCase();
}

/**
 * The wait as the board prints it: rounded up, because a rider who reads "2" and arrives in 2
 * minutes should not have missed it. An hour or more reads "1:15 HR".
 */
export function countdown(expectedAt, now = Date.now()) {
    const seconds = (expectedAt - now) / 1000;
    if (seconds < 45) return { now: true, figure: 'NOW', unit: '' };
    const minutes = Math.max(0, Math.ceil(seconds / 60));
    if (minutes >= 60) return { now: false, figure: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`, unit: 'HR' };
    return { now: false, figure: String(minutes), unit: 'MIN' };
}

/** "3 MIN LATE" / "2 MIN EARLY"; nothing under a minute, which no prediction can promise. */
export function delayPhrase(delayMs) {
    if (delayMs == null) return null;
    const minutes = Math.round(Math.abs(delayMs) / 60_000);
    if (minutes < 1) return null;
    return delayMs > 0 ? `${minutes} MIN LATE` : `${minutes} MIN EARLY`;
}

/** "LEFT OLD MILL 1 MIN AGO": the stop from the route, the time only from what we watched happen. */
export function lastStopPhrase(bus, now = Date.now()) {
    if (!bus?.lastStopName) return null;
    const name = bus.lastStopName.toUpperCase();
    if (bus.lastStopIndex === 0 && bus.progressToNext < 0.02) return `AT ${name}`;
    if (!bus.lastStopPassedAt) return `LEFT ${name}`;
    const minutes = Math.floor((now - bus.lastStopPassedAt) / 60_000);
    return minutes < 1 ? `LEFT ${name} JUST NOW` : `LEFT ${name} ${minutes} MIN AGO`;
}

export function distanceText(metres) {
    return metres < 1000 ? `${Math.round(metres / 10) * 10} M` : `${(metres / 1000).toFixed(1)} KM`;
}

export function plural(count, one, many) { return `${count} ${count === 1 ? one : many}`; }
