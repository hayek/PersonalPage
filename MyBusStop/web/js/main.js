// My Bus Stop on the web: choose a stop, pick up to three lines, watch the board. Three screens,
// one page; the browser's back button walks back through them.

import { store } from './storage.js';
import { regionByID, WORLDWIDE } from './transit/regions.js';
import { loadProvider } from './transit/providers/index.js';
import { showSetup } from './setup/stops.js';
import { showLines } from './setup/lines.js';
import { showBoard } from './board/view.js';
import { guessRegion } from './setup/region-guess.js';

const app = document.getElementById('app');
let teardown = null;

/** The shared session: which region and provider, and the stop being set up. */
export const session = {
    region: regionByID(store.regionID) ?? guessRegion(),
    provider: null,
    stop: null,
    /** Lines already chosen at the stop, when it is reopened from history. */
    preselected: [],
};

applyTheme();
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => rerender());

export function applyTheme() {
    const theme = store.theme;
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
    if (push) history.pushState({ screen }, '', screen === 'setup' ? location.pathname : `#${screen}`);
    try {
        if (screen === 'board') {
            const board = store.currentBoard();
            if (!board) return go('setup', { push: false });
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

function rerender() { if (current) go(current, { push: false }); }

window.addEventListener('popstate', (event) => {
    const screen = event.state?.screen ?? 'setup';
    if (screen !== 'board' && current === 'board') store.closeBoard();
    if (screen === 'board' && !store.currentBoard()) return go('setup', { push: false });
    go(screen, { push: false });
});

// A saved board opens straight away, like the app; the stop picker is one Back away.
if (store.currentBoard()) {
    history.replaceState({ screen: 'setup' }, '', location.pathname);
    go('board');
} else {
    history.replaceState({ screen: 'setup' }, '', location.pathname);
    go('setup', { push: false });
}
