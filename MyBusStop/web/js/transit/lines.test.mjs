// Lines without a number: the model's normalisation, modes, naming and the merge of services a rider
// cannot tell apart (model.js, services.js). No dependencies:
//   node js/transit/lines.test.mjs

import assert from 'node:assert/strict';
import {
    Mode, compareLines, isNumbered, isService, lineLabel, lineTitle, makeLine, mergeServices, modeFromMotis,
    modeFromRouteType, modeNamed, serviceMemberIDs, serviceRepresentative,
} from './model.js';
import { withServices } from './services.js';

const tests = [];
const test = (name, body) => tests.push({ name, body });

/** One Israel Railways run as bus.gov.il lists it: no number, the run number as headsign. */
const run = (id, destination, extra = {}) => makeLine({
    id: String(id), shortName: '', headsign: String(id % 200), agency: 'Israel Railways',
    origin: 'Nahariya', destination, longName: `Nahariya – ${destination}`,
    providerRefs: { routeDesc: String(id % 200), stopid: '37382' }, ...extra,
});

// ---------------------------------------------------------------------------------------------
// Normalisation

test('makeLine trims the number and keeps a missing one as ""', () => {
    assert.equal(makeLine({ id: 'a', shortName: ' 12A ' }).shortName, '12A');
    assert.equal(makeLine({ id: 'a', shortName: null }).shortName, '');
    assert.equal(makeLine({ id: 'a' }).shortName, '');
    assert.equal(makeLine({ id: 'a', shortName: '   ' }).shortName, '');
});

test('makeLine gives every line a long name and a mode, null unless stated', () => {
    const line = makeLine({ id: 'a', shortName: '1' });
    assert.equal(line.longName, null);
    assert.equal(line.mode, null);
    assert.equal(makeLine({ id: 'a', longName: '  Airport – Harbour ' }).longName, 'Airport – Harbour');
    assert.equal(makeLine({ id: 'a', longName: '' }).longName, null);
});

test('a line saved before long names and modes still reads', () => {
    const saved = { id: '5', shortName: '5', headsign: 'Centre', providerRefs: {} };
    assert.ok(isNumbered(saved));
    assert.equal(lineLabel(saved), 'line 5');
    assert.equal(isService(saved), false);
    assert.deepEqual(serviceMemberIDs(saved), ['5']);
});

// ---------------------------------------------------------------------------------------------
// Modes, only from what a feed states

test('GTFS route types, basic and extended', () => {
    assert.equal(modeFromRouteType(0), Mode.tram);
    assert.equal(modeFromRouteType(1), Mode.metro);
    assert.equal(modeFromRouteType(2), Mode.rail);
    assert.equal(modeFromRouteType('3'), Mode.bus);
    assert.equal(modeFromRouteType(4), Mode.ferry);
    assert.equal(modeFromRouteType(6), Mode.cable);
    assert.equal(modeFromRouteType(11), Mode.trolleybus);
    assert.equal(modeFromRouteType(109), Mode.rail);
    assert.equal(modeFromRouteType(700), Mode.bus);
    assert.equal(modeFromRouteType(900), Mode.tram);
    assert.equal(modeFromRouteType(1000), Mode.ferry);
    assert.equal(modeFromRouteType(null), null);
    assert.equal(modeFromRouteType(''), null);
});

test('MOTIS modes and named modes', () => {
    assert.equal(modeFromMotis('REGIONAL_RAIL'), Mode.rail);
    assert.equal(modeFromMotis('BUS'), Mode.bus);
    assert.equal(modeFromMotis('SUBWAY'), Mode.metro);
    assert.equal(modeFromMotis(undefined), null);
    assert.equal(modeNamed('bus'), Mode.bus);
    assert.equal(modeNamed('Tram'), Mode.tram);
    assert.equal(modeNamed('UBahn'), Mode.metro);
    assert.equal(modeNamed('river-bus'), Mode.ferry);
    assert.equal(modeNamed('cable-car'), Mode.cable);
    assert.equal(modeNamed('hovercraft'), null);
    assert.equal(modeNamed(null), null);
});

// ---------------------------------------------------------------------------------------------
// Naming and order

test('a line without a number is named by where it goes, with its agency', () => {
    const line = run(30001, "Modi'in Center");
    assert.equal(isNumbered(line), false);
    assert.equal(lineTitle(line), "Modi'in Center");
    assert.equal(lineLabel(line), "Israel Railways to Modi'in Center");
    const longOnly = makeLine({ id: 'x', longName: 'Framingham/Worcester Line', agency: 'MBTA' });
    assert.equal(lineTitle(longOnly), 'Framingham/Worcester Line');
    assert.equal(lineLabel(longOnly), 'MBTA Framingham/Worcester Line');
    assert.equal(lineLabel(makeLine({ id: 'y' })), 'unnamed service');
});

test('numbered lines come first, in natural order; the rest by destination', () => {
    const lines = [run(1, 'Zichron'), makeLine({ id: 'b', shortName: '10' }), run(2, 'Akko'), makeLine({ id: 'a', shortName: '2' })];
    assert.deepEqual(lines.sort(compareLines).map((l) => l.shortName || l.destination), ['2', '10', 'Akko', 'Zichron']);
});

// ---------------------------------------------------------------------------------------------
// Merging

test('runs a rider cannot tell apart become one service; numbered lines stay as they are', () => {
    const lines = [
        run(30001, "Modi'in Center"), run(30003, "Modi'in Center"), run(30105, "Be'er Sheva Center"),
        makeLine({ id: '9', shortName: '9', destination: "Modi'in Center", agency: 'Israel Railways' }),
        run(30005, "Modi'in Center"),
    ];
    const merged = mergeServices(lines);
    assert.equal(merged.length, 3);
    const [modiin, beersheva, nine] = merged;
    assert.ok(isService(modiin));
    assert.deepEqual(serviceMemberIDs(modiin), ['30001', '30003', '30005']);
    assert.equal(modiin.shortName, '');
    assert.equal(modiin.destination, "Modi'in Center");
    assert.equal(modiin.headsign, null, 'run numbers differ, so no headsign stands for the service');
    assert.equal(modiin.agency, 'Israel Railways');
    assert.ok(isService(beersheva), 'a single unnumbered route is a service of one, for a stable id');
    assert.deepEqual(serviceMemberIDs(beersheva), ['30105']);
    assert.equal(beersheva.headsign, '105');
    assert.equal(nine, lines[3]);
});

test('a service keeps its id when the timetable renumbers its runs', () => {
    const today = mergeServices([run(30001, "Modi'in Center"), run(30003, "Modi'in Center")])[0];
    const nextWeek = mergeServices([run(41001, "Modi'in Center"), run(41003, "Modi'in Center"), run(41005, "Modi'in Center")])[0];
    assert.equal(today.id, nextWeek.id);
    assert.match(today.id, /^service:[0-9a-f]{16}$/);
    const other = mergeServices([run(30105, "Be'er Sheva Center")])[0];
    assert.notEqual(today.id, other.id);
});

test('different agencies or modes are not merged', () => {
    const merged = mergeServices([
        run(1, 'Haifa'), run(2, 'Haifa', { agency: 'Another' }), run(3, 'Haifa', { mode: Mode.rail }),
    ]);
    assert.equal(merged.length, 3);
});

test('without a destination, the long name and headsign tell services apart', () => {
    const a = makeLine({ id: 'r1|0', longName: 'Worcester Line', headsign: 'Worcester', agency: 'MBTA' });
    const b = makeLine({ id: 'r1|1', longName: 'Worcester Line', headsign: 'South Station', agency: 'MBTA' });
    const c = makeLine({ id: 'r2|0', longName: 'Worcester Line', headsign: 'Worcester', agency: 'MBTA' });
    const merged = mergeServices([a, b, c]);
    assert.equal(merged.length, 2);
    assert.deepEqual(serviceMemberIDs(merged[0]), ['r1|0', 'r2|0']);
});

test('the representative is the first member listed, with its own refs', () => {
    const service = mergeServices([run(30003, "Modi'in Center"), run(30001, "Modi'in Center")])[0];
    const representative = serviceRepresentative(service);
    assert.equal(representative.id, '30003');
    assert.equal(representative.providerRefs.routeDesc, '3');
    assert.equal(representative.providerRefs.serviceMembers, undefined);
    assert.equal(serviceRepresentative(run(1, 'X')).id, '1', 'a plain line is its own representative');
});

test('a service survives a trip through JSON (localStorage)', () => {
    const service = mergeServices([run(30001, "Modi'in Center"), run(30003, "Modi'in Center")])[0];
    const saved = JSON.parse(JSON.stringify(service));
    assert.ok(isService(saved));
    assert.deepEqual(serviceMemberIDs(saved), ['30001', '30003']);
    assert.equal(serviceRepresentative(saved).id, '30001');
});

// ---------------------------------------------------------------------------------------------
// The provider wrapper

function fakeProvider(listing) {
    const calls = { arrivals: [], patterns: [], lines: 0 };
    return {
        calls,
        provider: {
            id: 'fake', refreshSeconds: 30, capabilities: new Set(),
            async linesAtStop() { calls.lines += 1; return listing(); },
            async routePattern(line) { calls.patterns.push(line.id); return { line, stops: [] }; },
            async vehicles() { return [{ location: { lat: 0, lon: 0 } }]; },
            async arrivals(line) {
                calls.arrivals.push(line.id);
                return [{ expectedAt: new Date(Number(line.id) * 1000), isRealtime: false }];
            },
        },
    };
}

test('the wrapped provider merges, and asks for a service by its representative', async () => {
    const { provider, calls } = fakeProvider(() => [run(3, 'A'), run(1, 'A'), makeLine({ id: '9', shortName: '9' })]);
    const wrapped = withServices(provider);
    const lines = await wrapped.linesAtStop({ code: 's' });
    assert.equal(lines.length, 2);
    const service = lines[0];
    const pattern = await wrapped.routePattern(service);
    assert.deepEqual(calls.patterns, ['3']);
    assert.equal(pattern.line, service, 'the pattern is the service’s, for the board’s keys');
    const arrivals = await wrapped.arrivals(service, { code: 's' });
    assert.deepEqual(calls.arrivals.sort(), ['1', '3']);
    assert.deepEqual(arrivals.map((a) => a.expectedAt.getTime()), [1000, 3000]);
    assert.deepEqual(await wrapped.vehicles(service), [], 'no positions for a service of several runs');
    assert.equal(wrapped.id, 'fake');
    assert.equal(withServices(wrapped), wrapped);
});

test('a provider that times a service itself is asked once, with every member', async () => {
    const { provider, calls } = fakeProvider(() => [run(3, 'A'), run(1, 'A')]);
    let asked = null;
    provider.serviceArrivals = async (service, stop, members) => { asked = members.map((m) => m.id); return []; };
    const wrapped = withServices(provider);
    const [service] = await wrapped.linesAtStop({ code: 's' });
    await wrapped.arrivals(service, { code: 's' });
    assert.deepEqual(asked, ['3', '1']);
    assert.deepEqual(calls.arrivals, []);
});

test('a saved service is brought up to date from the stop’s lines, keeping its id', async () => {
    let listing = [run(30001, 'A'), run(30003, 'A')];
    const { provider } = fakeProvider(() => listing);
    const wrapped = withServices(provider);
    const [saved] = JSON.parse(JSON.stringify(await wrapped.linesAtStop({ code: 'renumbered' })));
    listing = [run(41001, 'A'), run(41003, 'A'), run(41005, 'A')];
    const fresh = withServices(fakeProvider(() => listing).provider);
    const [current] = await fresh.refreshServices([saved], { code: 'renumbered' });
    assert.equal(current.id, saved.id);
    assert.deepEqual(serviceMemberIDs(current), ['41001', '41003', '41005']);
    const plain = makeLine({ id: '9', shortName: '9' });
    assert.deepEqual(await fresh.refreshServices([plain], { code: 'renumbered' }), [plain], 'no services, no request');
});

// ---------------------------------------------------------------------------------------------

let failed = 0;
for (const { name, body } of tests) {
    try {
        await body();
        console.log(`ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`FAIL ${name}\n     ${error.stack ?? error}`);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
