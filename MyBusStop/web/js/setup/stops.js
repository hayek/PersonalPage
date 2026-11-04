// MY STOPS: the boards opened before, one tap from their board, and a search bar that opens the
// search screen (search.js) — the map, the stops in view, and the confirm step — over this one.

import { h, icon, badge, colorIndexFor, distanceText } from '../ui.js';
import { store } from '../storage.js';
import { REGIONS, WORLDWIDE, regionByID } from '../transit/regions.js';
import { Capability } from '../transit/model.js';
import { session, go, providerFor, applyTheme, startSearch } from '../main.js';
import { loadProvider } from '../transit/providers/index.js';
import { showStopCard, closeStopCard } from '../board/stop-card.js';

export function showSetup(root) {
    const provider = session.provider;
    const region = session.region;
    const searchesByName = provider.capabilities.has(Capability.stopSearchByName);
    const saved = store.sortedHistory();

    const regionSelect = h('select', { class: 'region-select', 'aria-label': 'Region' },
        groupOptions(region.id));
    regionSelect.addEventListener('change', async () => {
        const chosen = regionByID(regionSelect.value) ?? WORLDWIDE;
        store.setRegion(chosen.id);
        session.region = chosen;
        await providerFor(chosen);
        go('setup', { push: false });
    });

    const themeSelect = h('select', { class: 'theme-select', 'aria-label': 'Theme' },
        ['system', 'light', 'dark'].map((t) => h('option', { value: t, selected: store.theme === t }, t === 'system' ? 'System' : t[0].toUpperCase() + t.slice(1))));
    themeSelect.addEventListener('change', () => { store.setTheme(themeSelect.value); applyTheme(); go('setup', { push: false }); });

    // Looks like the field, but is the way into the search screen: nothing is typed here.
    const searchBar = h('button', { type: 'button', class: 'search search-bar', onclick: () => startSearch() },
        icon('search', 22),
        h('span', { class: 'search-bar-text' }, searchesByName ? 'Search a stop, street or line' : 'Enter the stop code from the sign'));

    function historyRow(entry) {
        const row = stopRow(entry.stop, {
            lines: entry.lines, providerID: entry.providerID,
            caption: regionByID(entry.regionID)?.name,
            onclick: () => { store.openBoard(entry); go('board'); },
            // A board from another region asks its own provider, not the one setup has open now.
            onInfo: () => showStopCard({
                stop: entry.stop, providerID: entry.providerID, watched: entry.lines,
                linesAtStop: async () => (await loadProvider(entry.providerID)).linesAtStop(entry.stop),
            }),
        });
        const remove = h('button', { class: 'row-remove', 'aria-label': `Remove ${entry.stop.name} from My stops`, title: 'Remove',
            onclick: (e) => { e.stopPropagation(); store.forget(entry.id); go('setup', { push: false }); } }, icon('close', 16));
        row.append(remove);
        return row;
    }

    const stops = saved.length
        ? h('section', { class: 'history', 'aria-label': 'My stops' },
            h('ul', { class: 'rows' }, saved.map((entry) => historyRow(entry)),
                h('li', { class: 'row-item' },
                    h('button', { type: 'button', class: 'row add-stop', onclick: () => startSearch() },
                        h('span', { class: 'add-stop-plus', 'aria-hidden': 'true' }, '+'), h('span', { class: 'row-title' }, 'ADD A STOP')))))
        : h('button', { type: 'button', class: 'first-stop', onclick: () => startSearch() },
            h('span', { class: 'first-stop-icon', 'aria-hidden': 'true' }, icon('locate', 30)),
            h('span', { class: 'first-stop-text' },
                h('span', { class: 'first-stop-title' }, 'Find your first stop'),
                h('span', { class: 'hint-text' }, 'Search by name, or look around you on the map')),
            icon('chevronForward', 24));

    const attribution = provider.attribution ? h('p', { class: 'attribution' }, provider.attribution) : null;

    root.append(h('main', { class: 'screen setup' },
        h('header', { class: 'setup-head' },
            h('a', { class: 'home-link', href: '../', 'aria-label': 'About My Bus Stop' }, h('img', { src: '../Assets/icon.svg', alt: '', width: 40, height: 40 })),
            saved.length
                ? h('h1', {}, 'MY STOPS')
                : h('div', {}, h('h1', {}, 'WELCOME'), h('p', { class: 'setup-sub' }, 'Where do you catch the bus?')),
        ),
        searchBar,
        stops,
        h('div', { class: 'region-row' },
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'REGION'), regionSelect),
            h('label', { class: 'field field-narrow' }, h('span', { class: 'field-label' }, 'THEME'), themeSelect),
        ),
        h('footer', { class: 'setup-foot' },
            attribution,
            h('p', {}, 'My Bus Stop is an independent app, not made or endorsed by any transit agency. ',
                h('a', { href: '../' }, 'Get it for iPhone, iPad, Mac, Apple Watch and Apple TV'), ' · ',
                h('a', { href: '../privacy/' }, 'Privacy')),
        ),
    ));
    return () => closeStopCard();
}

function groupOptions(selectedID) {
    const groups = [...new Set(REGIONS.map((r) => r.group))];
    return [
        ...groups.map((group) => h('optgroup', { label: group },
            REGIONS.filter((r) => r.group === group).map((r) => h('option', { value: r.id, selected: r.id === selectedID }, r.name)))),
        h('optgroup', { label: 'Worldwide' }, h('option', { value: WORLDWIDE.id, selected: selectedID === WORLDWIDE.id }, 'Everywhere else (Transitous)')),
    ];
}

/**
 * A stop in a list: its name, where it is, and the lines that call there. Tapping the row picks the
 * stop; its ⓘ, beside the row's own button rather than inside it, opens the stop's card instead.
 */
function stopRow(stop, { lines = [], providerID = null, distance = null, caption = null, onclick, onInfo = null }) {
    const where = whereabouts(stop, caption);
    const shown = lines.slice(0, 3);
    const item = h('li', { class: `row-item${onInfo ? ' has-info' : ''}` },
        h('button', { class: 'row', onclick },
            distance != null ? h('span', { class: 'row-distance' }, distanceText(distance)) : null,
            h('span', { class: 'row-text' },
                h('span', { class: 'row-title', dir: 'auto' }, stop.name),
                where ? h('span', { class: 'row-caption', dir: 'auto' }, where) : null),
            shown.length ? h('span', { class: 'row-badges' },
                shown.map((line) => badge(line, colorIndexFor(providerID, line))),
                lines.length > 3 ? h('span', { class: 'row-more' }, `+${lines.length - 3}`) : null) : null,
        ));
    if (onInfo) {
        item.append(h('button', {
            class: 'row-info', 'aria-label': `About ${stop.name}`, title: 'About this stop',
            onclick: (e) => { e.stopPropagation(); onInfo(); },
        }, icon('info', 20)));
    }
    return item;
}

/** Where a stop stands, as a list's caption: its address, its town, and the code when it is a short one. */
export function whereabouts(stop, caption = null) {
    // Poles of one stop often share its name; the code tells them apart.
    return [stop.address, stop.city, caption, /^[\w-]{1,12}$/.test(stop.code) ? `STOP ${stop.code}` : null].filter((part, i, all) => part && all.findIndex((p) => p?.toLowerCase() === part.toLowerCase()) === i).join(' · ');
}

export function friendly(error) {
    const message = String(error?.message ?? error);
    if (/timed out/.test(message)) return 'THE SERVICE IS TAKING TOO LONG TO ANSWER. TRY AGAIN IN A MOMENT.';
    if (/network|Failed to fetch|Load failed/i.test(message)) return 'CAN’T REACH THE SERVICE. CHECK YOUR CONNECTION AND TRY AGAIN.';
    if (/unsupported|Not supported/i.test(message)) return message.replace(/^Not supported by this provider: /, 'THIS REGION CAN’T DO THAT: ').toUpperCase();
    return `SOMETHING WENT WRONG: ${message}`.toUpperCase();
}
