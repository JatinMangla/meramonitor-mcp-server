/**
 * The 12 date/duration assertions from section 2 of the handoff, kept as a
 * regression check on the one piece of logic that is silently wrong if broken:
 * the literal-Z format. `node --test` is not used so this runs on plain Node 20
 * with no extra dependency.
 */
import assert from 'node:assert/strict';
import {
  assertRangeIsSane,
  formatSeconds,
  nowApiDateTime,
  toApiDateTime,
  toApiDayStart
} from './api/dates.js';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log('date/duration helpers');

check('date-only input becomes local midnight with a literal Z', () => {
  assert.equal(toApiDayStart('2026-01-05'), '2026-01-05T00:00:00Z');
});

check('date-time input keeps the wall clock exactly', () => {
  assert.equal(toApiDateTime('2026-01-05 14:30'), '2026-01-05T14:30:00Z');
});

check('T separator is accepted as well as a space', () => {
  assert.equal(toApiDateTime('2026-01-05T14:30:00'), '2026-01-05T14:30:00Z');
});

check('seconds are preserved when given', () => {
  assert.equal(toApiDateTime('2026-03-09T08:07:06'), '2026-03-09T08:07:06Z');
});

check('toApiDayStart truncates a date-time to midnight', () => {
  assert.equal(toApiDayStart('2026-01-05T14:30:00'), '2026-01-05T00:00:00Z');
});

check('the Z is decoration, not a UTC conversion', () => {
  // If this ever starts converting to real UTC, every report shifts by the
  // local offset. Re-parsing the output as local must give back the input.
  const out = toApiDateTime('2026-06-15 23:45:00');
  assert.equal(out, '2026-06-15T23:45:00Z');
  assert.ok(!out.includes('+'), 'no offset should be emitted');
});

check('nowApiDateTime matches the wire format', () => {
  assert.match(nowApiDateTime(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

check('an unparseable date is rejected', () => {
  assert.throws(() => toApiDateTime('last tuesday'), /Unrecognised date/);
});

check('an inverted range is rejected', () => {
  assert.throws(() => assertRangeIsSane('2026-02-10', '2026-02-01'), /is before/);
});

check('a range longer than 366 days is rejected', () => {
  assert.throws(() => assertRangeIsSane('2024-01-01', '2026-01-01'), /366 or fewer/);
});

check('a sane range passes', () => {
  assert.doesNotThrow(() => assertRangeIsSane('2026-02-01', '2026-02-10'));
});

check('formatSeconds renders hours, minutes, seconds and nullish input', () => {
  assert.equal(formatSeconds(3600), '1h');
  assert.equal(formatSeconds(3660), '1h 1m');
  assert.equal(formatSeconds(90), '1m');
  assert.equal(formatSeconds(45), '45s');
  assert.equal(formatSeconds(null), '0m');
  assert.equal(formatSeconds(undefined), '0m');
});

console.log(`\n${passed} assertions passed.`);
