// A board in a link, so it can be shared, or shown in someone else's page: a Home Assistant
// dashboard (the "My Bus Stop" card, or its built-in Webpage card), a wall tablet's kiosk browser.
//
//   …/web/#b=<board>                      opens the board and saves it to My stops, like picking it here
//   …/web/?embed=1&theme=dark#b=<board>   the board alone, framed: nothing saved, no way off the board
//   …/web/?pick=1                         the stop picker for the card's editor: the board chosen is
//                                         posted to the page around it instead of being opened
//
// The board travels in the fragment (#), so it never reaches a server, analytics included. It is the
// saved board as is (stop, lines and their colours), deflated and base64url'd: nothing to look up
// again on arrival, and a link made today keeps working while the feed lists the same lines.

const params = new URLSearchParams(location.search);

/** Shown inside another page: the board only, kept in memory, never in this browser's storage. */
export const embedded = params.has('embed');
/** Choosing a board for the page around this one (the Home Assistant card's editor). */
export const picking = params.has('pick') && window.parent !== window;
/** A theme the page around asks for, over the rider's own choice. */
export const themeParam = ['light', 'dark', 'system'].includes(params.get('theme')) ? params.get('theme') : null;

const VERSION = 1;
const MESSAGE_SOURCE = 'mybusstop';

/** The board's data from the link, or null when the link carries none. */
export function boardInLink() {
    const match = /^#b=([A-Za-z0-9_-]+)$/.exec(location.hash);
    return match ? match[1] : null;
}

/**
 * A board as link text. `colors` maps a line id to its palette index, so the link shows the lines
 * in the colours they were picked in.
 * @param {{regionID: string, providerID: string, stop: object, lines: object[]}} board
 */
export async function encodeBoard(board, colors = {}) {
    const payload = {
        v: VERSION,
        r: board.regionID,
        p: board.providerID,
        s: compact(board.stop),
        l: board.lines.map(compact),
        c: board.lines.map((line) => colors[line.id] ?? null),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (typeof CompressionStream === 'function') return `z${base64url(await pipe(bytes, new CompressionStream('deflate-raw')))}`;
    return `j${base64url(bytes)}`;
}

/** The board a link carries: {regionID, providerID, stop, lines, colors}. Throws on anything else. */
export async function decodeBoard(text) {
    const kind = text[0];
    let bytes = unbase64url(text.slice(1));
    if (kind === 'z') {
        if (typeof DecompressionStream !== 'function') throw new Error('this browser is too old to open board links');
        bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    } else if (kind !== 'j') {
        throw new Error('not a board link');
    }
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (payload?.v !== VERSION) throw new Error('this board link is from a newer version');
    const { r: regionID, p: providerID, s: stop, l: lines, c: colors = [] } = payload;
    const isText = (value) => typeof value === 'string' && value.length > 0 && value.length < 2000;
    const valid = isText(regionID) && isText(providerID)
        && stop && isText(stop.code) && typeof stop.name === 'string'
        && Number.isFinite(stop.location?.lat) && Number.isFinite(stop.location?.lon)
        && Array.isArray(lines) && lines.length >= 1 && lines.length <= 3
        && lines.every((line) => line && isText(line.id) && typeof line.shortName === 'string');
    if (!valid) throw new Error('this board link is damaged');
    return {
        regionID,
        providerID,
        stop: { city: null, address: null, ...stop },
        lines: lines.map((line) => ({
            headsign: null, agency: null, origin: null, destination: null, brandColorIndex: null, longName: null, mode: null,
            ...line,
            providerRefs: { ...(line.providerRefs ?? {}) },
        })),
        colors: Object.fromEntries(lines.map((line, i) => [line.id, Number.isInteger(colors[i]) ? colors[i] : null]).filter(([, c]) => c != null)),
    };
}

/** The web app's address with a board in it; `embed` for a page that frames it. */
export async function boardLink(board, colors, { embed = false } = {}) {
    const url = new URL(location.pathname, location.origin);
    if (embed) url.searchParams.set('embed', '1');
    url.hash = `b=${await encodeBoard(board, colors)}`;
    return url.toString();
}

/**
 * Hands the board just chosen to the page around this one (the card's editor). Only what the rider
 * chose here goes out: the stop and its lines, which the editor keeps in the card's settings.
 */
export async function announceBoard(board, colors) {
    const data = await encodeBoard(board, colors);
    window.parent.postMessage({
        source: MESSAGE_SOURCE, type: 'board', version: VERSION, data,
        stop: board.stop.name,
        lines: board.lines.map((line) => String(line.shortName || line.destination || line.longName || '').trim()).filter(Boolean),
    }, '*');
}

/** A copy without the fields a reader fills back in (null, undefined), to keep links short. */
function compact(object) {
    return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));
}

async function pipe(bytes, transform) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer());
}

function base64url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(text) {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
