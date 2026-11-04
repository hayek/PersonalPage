// My Bus Stop on the web: choose a stop, pick up to three lines, watch the board. Three screens,
// one page; the browser's back button walks back through them. A link can carry a board, and a
// framed page (Home Assistant) can show one board alone or pick one for its settings: js/embed.js.

import { store } from './storage.js';
import { regionByID, WORLDWIDE } from './transit/regions.js';
import { loadProvider } from './transit/providers/index.js';
import { showSetup } from './setup/stops.js';
import { openSearch, closeSearch, searchIsOpen, searchDepth, searchPopped } from './setup/search.js';
import { showLines } from './setup/lines.js';
import { showBoard } from './board/view.js';
import { guessRegion } from './setup/region-guess.js';
import { embedded, picking, themeParam, boardInLink, decodeBoard, announceBoard } from './embed.js';
import { h, badge, colorIndexFor, lineKey } from './ui.js';

const app = document.getElementById('app');
let teardown = null;

// Before anything reads the store: a framed board keeps nothing in this browser.
if (embedded) store.keepInMemory();
if (embedded) document.documentElement.classList.add('embedded');
if (picking) document.documentElement.classList.add('picking');

/** The shared session: which region and provider, and the stop being set up. */
export const session = {
    region: regionByID(store.regionID) ?? guessRegion(),
    provider: null,
    stop: null,
    /** Lines already chosen at the stop, when it is reopened from history. */
    preselected: [],
    /** A framed board from a link: the board is all there is, with no way to another stop. */
    locked: false,
    /** The lines search's confirm step already found at `stop`, for the picker to use rather than ask again. */
    knownLines: null,
};

/** The address the setup screen keeps: a framed page's own settings stay in it. */
const home = () => location.pathname + (embedded || picking ? location.search : '');

applyTheme();
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => rerender());

export function applyTheme() {
    // A page that frames this one says which theme it is in; the rider's own choice is for this site.
    const theme = (embedded || picking) && themeParam ? themeParam : store.theme;
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
}

export async function providerFor(region) {
    session.region = region;
    session.provider = await loadProvider(region.providerID);
    return session.provider;
}

function mount(render) {
    teardown?.();
    teardown = null;
    app.replaceChildren();
    window.scrollTo(0, 0);
    teardown = render(app) ?? null;
}

let current = null;

/** Set while the search screen's own history entries are being taken off: that walk is not a Back. */
let walkingBack = null;

function popEntries(count) {
    if (count <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => { if (walkingBack === done) { walkingBack = null; resolve(); } };
        walkingBack = done;
        history.go(-count);
        // A browser that never says it got there must not leave the page waiting.
        setTimeout(done, 800);
    });
}

/** The search screen, over the home. */
export function startSearch() {
    openSearch({ onCancel: () => leaveSearch().then((changed) => { if (changed) go('setup', { push: false }); }) });
}

/** Closes the search screen and takes its history entries off, so Back from what comes next is the home. */
async function leaveSearch() {
    if (!searchIsOpen()) return false;
    const depth = searchDepth();
    const changed = closeSearch();
    await popEntries(depth);
    return changed;
}

/** Shows a screen. `push` adds a history entry so Back returns to the screen before. */
export async function go(screen, { push = true } = {}) {
    // The board, opened from the line picker inside search: the search goes, and Back is the home.
    if (searchIsOpen()) await leaveSearch();
    current = screen;
    if (push && !session.locked) history.pushState({ screen }, '', screen === 'setup' ? home() : `${home()}#${screen}`);
    try {
        if (screen === 'board') {
            const board = store.currentBoard();
            if (!board) return go('setup', { push: false });
            // Chosen for the card's editor: the editor keeps it, and its preview shows the board.
            if (picking && push) {
                current = 'picked';
                await announceBoard(board, colorsOf(board));
                mount((root) => showPicked(root, board));
                return;
            }
            const region = regionByID(board.regionID) ?? WORLDWIDE;
            const provider = await providerFor(region);
            mount((root) => showBoard(root, { board, provider, region }));
        } else if (screen === 'lines' && session.stop && session.provider) {
            mount((root) => showLines(root));
        } else {
            current = 'setup';
            await providerFor(session.region);
            mount((root) => showSetup(root));
        }
    } catch (error) {
        console.error(error);
        mount((root) => {
            root.append(Object.assign(document.createElement('p'), { className: 'fatal', textContent: `Something went wrong loading this screen: ${error.message}` }));
        });
    }
}

function rerender() { if (current && current !== 'picked' && !searchIsOpen()) go(current, { push: false }); }

/** Each line's colour on this board, for a link to carry. */
export function colorsOf(board) {
    return Object.fromEntries(board.lines.map((line) => [line.id, colorIndexFor(board.providerID, line)]));
}

/** The card's editor, after a board is chosen: what the card will show, and a way to choose again. */
function showPicked(root, board) {
    const change = () => changeLines(board);
    root.append(h('main', { class: 'screen picked' },
        h('p', { class: 'caption' }, 'THE CARD WILL SHOW'),
        h('h1', { dir: 'auto' }, h('button', { class: 'picked-stop', title: 'Change lines', onclick: change }, board.stop.name)),
        h('button', { class: 'picked-lines', 'aria-label': 'Change lines', onclick: change },
            board.lines.map((line) => badge(line, colorIndexFor(board.providerID, line), 'medium'))),
        h('p', { class: 'picked-hint' }, 'Save the card to keep this board. The preview beside this shows it live.'),
        h('div', { class: 'picked-actions' },
            h('button', { class: 'button button-primary', onclick: change }, 'CHANGE LINES'),
            h('button', { class: 'button button-outline', onclick: () => { store.closeBoard(); go('setup'); } }, 'CHOOSE ANOTHER STOP')),
    ));
}

/** The lines screen for a board's stop, its lines already ticked: from the card editor's board. */
async function changeLines(board) {
    await providerFor(regionByID(board.regionID) ?? WORLDWIDE);
    session.stop = board.stop;
    session.preselected = board.lines;
    go('lines');
}

window.addEventListener('popstate', (event) => {
    if (walkingBack) { walkingBack(); return; }
    if (session.locked) return;
    const screen = event.state?.screen ?? 'setup';
    if (screen === 'search') {
        if (searchIsOpen()) searchPopped(event.state);
        // Forward into a search that has closed: the home it was opened from.
        else { history.replaceState({ screen: 'setup' }, '', home()); if (current !== 'setup') go('setup', { push: false }); }
        return;
    }
    if (searchIsOpen()) {
        const changed = closeSearch();
        if (screen === 'setup' && current === 'setup') { if (changed) go('setup', { push: false }); return; }
    }
    if (screen !== 'board' && current === 'board') store.closeBoard();
    if (screen === 'board' && !store.currentBoard()) return go('setup', { push: false });
    go(screen, { push: false });
});

async function start() {
    const shared = boardInLink();
    if (shared && picking) {
        // The card editor reopened on a card that has a board: start on its lines, the stop picker one Back away.
        try {
            const board = await decodeBoard(shared);
            store.setPalette(Object.fromEntries(Object.entries(board.colors).map(([id, color]) => [lineKey(board.providerID, id), color])));
            history.replaceState({ screen: 'setup' }, '', home());
            await changeLines(board);
            return;
        } catch (error) {
            console.error(error);
        }
    }
    if (shared && !picking) {
        try {
            const board = await decodeBoard(shared);
            store.setPalette(Object.fromEntries(Object.entries(board.colors).map(([id, color]) => [lineKey(board.providerID, id), color])));
            store.openBoard(board);
            session.locked = embedded;
        } catch (error) {
            console.error(error);
            history.replaceState({ screen: 'setup' }, '', home());
            mount((root) => root.append(h('main', { class: 'screen link-error' },
                h('h1', {}, 'CAN’T OPEN THIS BOARD'),
                h('p', {}, `The link is incomplete or damaged (${error.message}). ${embedded ? 'Choose the stop again in the card’s settings.' : 'Ask for the link again, or choose the stop here.'}`),
                embedded ? null : h('button', { class: 'button button-primary', onclick: () => go('setup') }, 'CHOOSE A STOP'))));
            return;
        }
    }
    if (session.locked) {
        // The link stays in the address bar: a reload shows the same board.
        history.replaceState({ screen: 'board' }, '', location.href);
        go('board', { push: false });
    } else if (store.currentBoard() && !picking) {
        // A saved board opens straight away, like the app; the stop picker is one Back away.
        history.replaceState({ screen: 'setup' }, '', home());
        go('board');
    } else {
        history.replaceState({ screen: 'setup' }, '', home());
        go('setup', { push: false });
    }
}

start();
