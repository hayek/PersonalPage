// My Bus Stop on the web: choose a stop, pick up to three lines, watch the board. Three screens,
// one page; the browser's back button walks back through them. A link can carry a board, and a
// framed page (Home Assistant) can show one board alone or pick one for its settings: js/embed.js.

import { store } from './storage.js';
import { regionByID, WORLDWIDE } from './transit/regions.js';
import { loadProvider } from './transit/providers/index.js';
import { showSetup } from './setup/stops.js';
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

/** Shows a screen. `push` adds a history entry so Back returns to the screen before. */
export async function go(screen, { push = true } = {}) {
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

function rerender() { if (current && current !== 'picked') go(current, { push: false }); }

/** Each line's colour on this board, for a link to carry. */
export function colorsOf(board) {
    return Object.fromEntries(board.lines.map((line) => [line.id, colorIndexFor(board.providerID, line)]));
}

/** The card's editor, after a board is chosen: what the card will show, and a way to choose again. */
function showPicked(root, board) {
    root.append(h('main', { class: 'screen picked' },
        h('p', { class: 'caption' }, 'THE CARD WILL SHOW'),
        h('h1', { dir: 'auto' }, board.stop.name),
        h('div', { class: 'picked-lines' }, board.lines.map((line) => badge(line, colorIndexFor(board.providerID, line), 'medium'))),
        h('p', { class: 'picked-hint' }, 'Save the card to keep this board. The preview beside this shows it live.'),
        h('button', { class: 'button button-outline', onclick: () => { store.closeBoard(); go('setup'); } }, 'CHOOSE ANOTHER STOP'),
    ));
}

window.addEventListener('popstate', (event) => {
    if (session.locked) return;
    const screen = event.state?.screen ?? 'setup';
    if (screen !== 'board' && current === 'board') store.closeBoard();
    if (screen === 'board' && !store.currentBoard()) return go('setup', { push: false });
    go(screen, { push: false });
});

async function start() {
    const shared = boardInLink();
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
