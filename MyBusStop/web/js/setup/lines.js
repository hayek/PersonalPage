// PICK UP TO 3 LINES TO WATCH: every line that calls at the stop, as chips.

import { h, icon, lineKey, isLightTheme, colorIndexFor } from '../ui.js';
import { store } from '../storage.js';
import { compareLineNames } from '../transit/model.js';
import { assignLineColors, railColor, numeralColor } from '../map/index.js';
import { session, go } from '../main.js';
import { friendly } from './stops.js';

const MAX_LINES = 3;

export function showLines(root) {
    const { provider, stop, region } = session;
    const selected = [];
    let lines = [];
    let cancelled = false;

    const grid = h('div', { class: 'chips' }, h('p', { class: 'status' }, 'LOADING LINES…'));
    const countText = h('p', { class: 'count-title' });
    const countHint = h('p', { class: 'count-hint' });
    const clear = h('button', { class: 'button button-outline', onclick: () => { selected.length = 0; render(); } }, 'CLEAR');
    const show = h('button', { class: 'button button-primary', onclick: open }, 'SHOW THE MAP', icon('arrow', 22));

    function colors() {
        // Fix a distinct colour for every chosen line, the way the board will draw them.
        const ids = selected.map((l) => l.id);
        const persisted = {};
        const preferred = {};
        for (const line of lines) {
            const saved = store.palette[lineKey(provider.id, line.id)];
            if (saved != null) persisted[line.id] = saved;
            preferred[line.id] = line.brandColorIndex ?? null;
        }
        return assignLineColors(persisted, ids, preferred);
    }

    function render() {
        const assigned = colors();
        const light = isLightTheme();
        grid.replaceChildren(...lines.map((line) => {
            const index = selected.findIndex((l) => l.id === line.id);
            const on = index >= 0;
            const color = on ? assigned[line.id] ?? colorIndexFor(provider.id, line) : null;
            const full = !on && selected.length >= MAX_LINES;
            return h('button', {
                class: `chip${on ? ' chip-on' : ''}`, 'aria-pressed': String(on), disabled: full,
                style: on ? { background: railColor(color, light), color: numeralColor(color, light), borderColor: railColor(color, light) } : null,
                onclick: () => {
                    if (on) selected.splice(index, 1);
                    else if (selected.length < MAX_LINES) selected.push(line);
                    render();
                },
            },
            h('span', { class: 'chip-number' }, line.shortName),
            on ? h('span', { class: 'chip-check', style: { '--check': railColor(color, light) } }, icon('check', 16)) : null,
            h('span', { class: 'chip-dest', dir: 'auto' }, line.destination ?? line.headsign ?? line.agency ?? ''));
        }));
        countText.textContent = `${selected.length} OF ${MAX_LINES} SELECTED`;
        countHint.textContent = selected.length === 0 ? 'TAP A LINE TO WATCH IT'
            : selected.length < MAX_LINES ? `ADD ${MAX_LINES - selected.length} MORE` : 'THAT’S THE MOST A BOARD SHOWS';
        show.disabled = selected.length === 0;
        clear.disabled = selected.length === 0;
    }

    function open() {
        if (!selected.length) return;
        const assigned = colors();
        store.setPalette(Object.fromEntries(selected.map((l) => [lineKey(provider.id, l.id), assigned[l.id]])));
        store.openBoard({ regionID: region.id, providerID: provider.id, stop, lines: selected.slice() });
        go('board');
    }

    root.append(h('main', { class: 'screen lines' },
        h('header', { class: 'lines-head' },
            h('button', { class: 'round-button', 'aria-label': 'Back', onclick: () => history.back() }, icon('back', 22)),
            h('div', {},
                h('h1', { dir: 'auto' }, stop.name),
                h('p', { class: 'caption' }, 'PICK UP TO 3 LINES TO WATCH')),
        ),
        grid,
        h('footer', { class: 'lines-foot' },
            h('div', {}, countText, countHint),
            h('div', { class: 'lines-actions' }, clear, show)),
    ));

    provider.linesAtStop(stop).then((found) => {
        if (cancelled) return;
        lines = [...found].sort((a, b) => compareLineNames(a.shortName, b.shortName));
        for (const line of session.preselected) {
            const match = lines.find((l) => l.id === line.id);
            if (match && selected.length < MAX_LINES) selected.push(match);
        }
        if (!lines.length) {
            grid.replaceChildren(h('p', { class: 'status' }, 'NO LINES ARE RUNNING HERE RIGHT NOW. TRY ANOTHER STOP, OR COME BACK LATER.'));
            countText.textContent = '';
            show.disabled = true;
            clear.disabled = true;
            return;
        }
        render();
    }).catch((error) => {
        if (cancelled) return;
        grid.replaceChildren(h('p', { class: 'status status-error' }, friendly(error)));
    });
    show.disabled = true;
    clear.disabled = true;

    return () => { cancelled = true; };
}
