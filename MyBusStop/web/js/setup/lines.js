// PICK UP TO 3 LINES TO WATCH: every line that calls at the stop, as chips. A line whose road can
// be drawn has an ⓘ in its chip's corner, which opens its card: the route on a map and its stops.

import { h, icon, lineKey, isLightTheme, colorIndexFor, modeGlyph } from '../ui.js';
import { store } from '../storage.js';
import { compareLines, isNumbered, lineLabel, lineTitle } from '../transit/model.js';
import { assignLineColors, railColor, numeralColor } from '../map/index.js';
import { session, go } from '../main.js';
import { friendly } from './stops.js';
import { hasRouteShape } from '../transit/shapes/route-shape.js';
import { showLineCard, closeLineCard } from '../board/line-card.js';

const MAX_LINES = 3;

/**
 * A numbered line is its number over where it goes. One without a number is its mode's glyph (or a
 * neutral dot) over where it goes, set larger since that is now its name, and who runs it.
 */
function chipName(line) {
    if (isNumbered(line)) {
        return [h('span', { class: 'chip-number' }, line.shortName),
            h('span', { class: 'chip-dest', dir: 'auto' }, line.destination ?? line.headsign ?? line.agency ?? '')];
    }
    const title = lineTitle(line);
    return [h('span', { class: 'chip-number chip-glyph' }, modeGlyph(line.mode)),
        h('span', { class: 'chip-title', dir: 'auto' }, title ?? line.agency ?? 'Unnamed service'),
        title && line.agency ? h('span', { class: 'chip-dest', dir: 'auto' }, line.agency) : null];
}

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
            const chip = h('button', {
                class: `chip${on ? ' chip-on' : ''}`, 'aria-pressed': String(on), disabled: full,
                style: on ? { background: railColor(color, light), color: numeralColor(color, light), borderColor: railColor(color, light) } : null,
                onclick: () => {
                    if (on) selected.splice(index, 1);
                    else if (selected.length < MAX_LINES) selected.push(line);
                    render();
                },
            },
            ...chipName(line),
            on ? h('span', { class: 'chip-check', style: { '--check': railColor(color, light) } }, icon('check', 16)) : null);
            if (!hasRouteShape(provider, line)) return chip;
            // Beside the chip's button rather than inside it: the chip picks the line, the ⓘ opens its card.
            const about = h('button', {
                class: 'chip-info', 'aria-label': `About ${lineLabel(line)}`, title: 'Route and stops',
                style: on ? { color: numeralColor(color, light) } : null,
                onclick: () => showLineCard({ line, provider, stopCode: stop.code, colorIndex: color ?? colorIndexFor(provider.id, line) }),
            }, icon('info', 20));
            return h('div', { class: 'chip-item' }, chip, about);
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
        lines = [...found].sort(compareLines);
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

    return () => { cancelled = true; closeLineCard(); };
}
