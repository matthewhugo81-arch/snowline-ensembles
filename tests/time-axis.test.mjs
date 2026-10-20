import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMobileTimeAxis, MOBILE_AXIS_BOTTOM} from '../docs/time-axis.js';

const HOUR = 3600, DAY = 24 * HOUR;
const utc = text => Date.parse(text) / 1000;
const base = {start: utc('2026-10-20T06:00Z'), end: utc('2026-10-25T00:00Z'), width: 332, height: 384, left: 38, right: 53, top: 11};
const axis = overrides => buildMobileTimeAxis({...base, ...overrides});

test('screenshot window labels every day with a weekday, date and UTC time', () => {
  for (const width of [262, 332, 372]) {
    const result = axis({width});
    assert.equal(result.tickHours, 24);
    assert.deepEqual(result.ticks.map(t => t.date), width === 262 ? ['21', '22', '23', '24', '25'] : ['21 Oct', '22 Oct', '23 Oct', '24 Oct', '25 Oct']);
    assert.deepEqual(result.ticks.map(t => t.day), ['Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    assert.ok(result.ticks.every(t => t.clock === '00Z'));
    assert.equal(result.bottom, MOBILE_AXIS_BOTTOM);
    for (let i = 1; i < result.ticks.length; i++) assert.ok(result.ticks[i].left >= result.ticks[i - 1].right, `${width}px labels must not collide`);
    assert.ok(result.ticks[0].left >= 0);
    assert.ok(result.ticks.at(-1).right <= width);
  }
});

test('the normal seven-day phone view retains daily labels at 390px viewport width', () => {
  const result = axis({end: base.start + 7 * DAY});
  assert.equal(result.tickHours, 24);
  assert.equal(result.ticks.length, 7);
});

test('a 320px phone shows every day in a seven-day view using compact day numbers', () => {
  const result = axis({width: 262, end: base.start + 7 * DAY});
  assert.equal(result.tickHours, 24);
  assert.equal(result.ticks.length, 7);
  assert.equal(result.compact, true);
  assert.deepEqual(result.ticks.map(t => t.date), ['21', '22', '23', '24', '25', '26', '27']);
  for (let i = 1; i < result.ticks.length; i++) assert.ok(result.ticks[i].left >= result.ticks[i - 1].right);
});

test('sixteen-day windows keep every daily guide while spacing date labels', () => {
  const result = axis({end: base.start + 16 * DAY});
  assert.equal(result.gridTimes.length, 16);
  assert.ok(result.ticks.length >= 4);
  assert.ok(result.tickHours > 24);
  for (let i = 1; i < result.gridTimes.length; i++) assert.equal(result.gridTimes[i] - result.gridTimes[i - 1], DAY);
  for (let i = 1; i < result.ticks.length; i++) assert.ok(result.ticks[i].left >= result.ticks[i - 1].right);
});

test('zooming to one or two days adds regular 6-hour and 12-hour time markers', () => {
  const one = axis({end: base.start + DAY}), two = axis({end: base.start + 2 * DAY});
  assert.equal(one.tickHours, 6);
  assert.equal(two.tickHours, 12);
  assert.deepEqual(one.ticks.map(t => t.clock), ['06Z', '12Z', '18Z', '00Z', '06Z']);
  for (let i = 1; i < one.ticks.length; i++) assert.equal(one.ticks[i].time - one.ticks[i - 1].time, 6 * HOUR);
  assert.ok(one.ticks.some(t => t.date === '20 Oct'));
  assert.ok(one.ticks.some(t => t.date === '21 Oct'));
});

test('12Z annotations appear between daily labels only when there is enough space', () => {
  assert.ok(axis({width: 332}).hourTicks.length > 0);
  assert.equal(axis({width: 262}).hourTicks.length, 0);
  assert.ok(axis({width: 332}).hourTicks.every(t => new Date(t.time * 1000).getUTCHours() === 12));
});

test('UTC date and time placement remains exact across the UK autumn clock change', () => {
  const start = utc('2026-10-24T18:00Z'), end = utc('2026-10-26T06:00Z');
  const result = axis({start, end});
  assert.ok(result.ticks.some(t => t.time === utc('2026-10-25T00:00Z') && t.clock === '00Z' && t.date === '25 Oct'));
  assert.ok(result.ticks.every(t => t.time % (result.tickHours * HOUR) === 0));
  for (const tick of result.ticks) assert.equal(tick.x, base.left + (tick.time - start) / (end - start) * (base.width - base.left - base.right));
});

test('axes share identical time marks across panels with different heights and precipitation headers', () => {
  const a = axis({height: 254, top: 11}), b = axis({height: 384, top: 25});
  assert.deepEqual(a.ticks, b.ticks);
  assert.deepEqual(a.hourTicks, b.hourTicks);
  assert.deepEqual(a.gridTimes, b.gridTimes);
});

test('SVG contains inline date contrast and font styling for image exports', () => {
  const result = axis();
  assert.match(result.markup, /class="mobile-time-axis"/);
  assert.match(result.markup, /class="date-tick"[^>]*style="fill:var\(--ink\);font-size:11px;font-weight:600/);
  assert.match(result.markup, /class="tick-date"[^>]*style="font-weight:700"/);
  assert.match(result.markup, /class="tick-clock"[^>]*style="fill:var\(--muted\);font-size:10px/);
});

test('invalid or empty domains produce no misleading labels', () => {
  for (const args of [{end: base.start}, {end: base.start - 1}, {start: NaN}, {width: 70}, {height: 40}]) {
    const result = axis(args);
    assert.equal(result.markup, '');
    assert.deepEqual(result.ticks, []);
  }
});
