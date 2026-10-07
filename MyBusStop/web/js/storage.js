// What the rider chose, kept in this browser only (localStorage). Nothing here ever leaves the
// device: no account, no server. Every access is guarded, because storage can be off (private
// windows, blocked site data) and the board must still work for the visit.

const KEY = 'mybusstop.web.v1';
const MAX_HISTORY = 12;

const defaults = () => ({
    /** Boards the rider has opened, most recent first: {id, regionID, providerID, stop, lines, pinned, usedAt}. */
    history: [],
    /** The id of the board to open on arrival, or null for the stop picker. */
    current: null,
    /** Line key ("<provider>:<line id>") → palette index, so a line keeps its colour everywhere. */
    palette: {},
    /** 'system' | 'light' | 'dark' */
    theme: 'system',
    /** The region the rider picked, when they picked one. */
    regionID: null,
});

let state = read();

function read() {
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? { ...defaults(), ...JSON.parse(raw) } : defaults();
    } catch {
        return defaults();
    }
}

function write() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* the session keeps it */ }
}

export const store = {
    get history() { return state.history; },
    get theme() { return state.theme; },
    get regionID() { return state.regionID; },
    get palette() { return state.palette; },

    currentBoard() { return state.history.find((h) => h.id === state.current) ?? null; },

    setTheme(theme) { state.theme = theme; write(); },
    setRegion(id) { state.regionID = id; write(); },
    setPalette(palette) { state.palette = { ...state.palette, ...palette }; write(); },

    /** Saves a board and makes it the one to open next time. Same stop + provider replaces the old entry. */
    openBoard({ regionID, providerID, stop, lines }) {
        const id = `${providerID}:${stop.code}`;
        const existing = state.history.find((h) => h.id === id);
        const entry = { id, regionID, providerID, stop, lines, pinned: existing?.pinned ?? false, usedAt: Date.now() };
        state.history = [entry, ...state.history.filter((h) => h.id !== id)].slice(0, MAX_HISTORY);
        state.current = id;
        write();
        return entry;
    },

    closeBoard() { state.current = null; write(); },

    togglePin(id) {
        state.history = state.history.map((h) => (h.id === id ? { ...h, pinned: !h.pinned } : h));
        write();
    },

    forget(id) {
        state.history = state.history.filter((h) => h.id !== id);
        if (state.current === id) state.current = null;
        write();
    },

    /** Pinned first, then most recently used. */
    sortedHistory() {
        return [...state.history].sort((a, b) => (b.pinned - a.pinned) || (b.usedAt - a.usedAt));
    },
};
