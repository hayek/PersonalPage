// The days a line runs (service-days.js). No dependencies:
//   node js/transit/service-days.test.mjs

import assert from 'node:assert/strict';
import { fromDates, fromDayTypes, isKnown, normalizeDate, serviceDates, spoken, week, weekdayOf, UNKNOWN_DAYS } from './service-days.js';

const tests = [];
const test = (name, body) => tests.push({ name, body });

/** Sunday 2026-11-01 to Saturday 2026-11-14: two of every weekday. */
const twoWeeks = Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);

test('day types cover their days', () => {
    assert.deepEqual(fromDayTypes(['weekday']).weekdays, [2, 3, 4, 5, 6]);
    assert.equal(fromDayTypes(['weekday', 'saturday', 'sunday']).weekdays.length, 7);
});

test('weekday of a date, both spellings', () => {
    assert.equal(weekdayOf('2026-11-11'), 4);
    assert.equal(weekdayOf('20261115'), 1);
    assert.equal(normalizeDate('2026-11-11T00:00:00'), null);
});

test("Haifa's 148: Sunday to Friday over two weeks", () => {
    const running = twoWeeks.filter((date) => weekdayOf(date) !== 7);
    assert.deepEqual(fromDates(running, twoWeeks).weekdays, [1, 2, 3, 4, 5, 6]);
});

test('a holiday does not dim a day', () => {
    const running = twoWeeks.filter((date) => weekdayOf(date) !== 7 && date !== '2026-11-11');
    assert.ok(fromDates(running, twoWeeks).weekdays.includes(4));
});

test('a holiday does not light a day', () => {
    const window = Array.from({ length: 28 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
    const sundays = window.filter((date) => weekdayOf(date) === 1);
    assert.deepEqual(fromDates([...sundays, '2026-11-02'], window).weekdays, [1]);
});

test('dates in the feed’s time zone', () => {
    const start = new Date('2026-11-14T23:30:00Z');
    assert.deepEqual(serviceDates({ start, count: 2, timeZone: 'Asia/Jerusalem' }), ['2026-11-15', '2026-11-16']);
    const back = serviceDates({ start, offset: -13, count: 14, timeZone: 'Asia/Jerusalem' });
    assert.equal(back[0], '2026-11-02');
    assert.equal(back.at(-1), '2026-11-15');
});

test('week in the rider’s order, and what is said', () => {
    const days = fromDayTypes(['weekday']);
    assert.deepEqual(week(days, 2).map((day) => day.weekday), [2, 3, 4, 5, 6, 7, 1]);
    assert.deepEqual(week(days, 1).map((day) => day.letter), ['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    assert.equal(spoken(days, 2), 'Monday, Tuesday, Wednesday, Thursday, and Friday');
    assert.equal(spoken(fromDayTypes(['weekday', 'saturday', 'sunday'])), 'every day');
    assert.ok(!isKnown(UNKNOWN_DAYS));
});

let failed = 0;
for (const { name, body } of tests) {
    try { await body(); console.log(`ok   ${name}`); } catch (error) { failed++; console.log(`FAIL ${name}\n${error.stack}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
