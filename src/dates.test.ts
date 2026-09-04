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
  periodFrom,
  resolveDay,
  resolveRange,
  todayInZone,
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


// --- relative dates -------------------------------------------------------
//
// Anchored to fixed days rather than the real clock. Week and month boundaries
// are wrong only on particular dates - a Sunday, a 1st, a 31st - so a suite
// that runs against "now" would pass every day except the ones that matter.

console.log('\nrelative date resolution');

// 2026-09-04 is a Friday; the Monday of its week is 2026-08-31.
const FRIDAY = '2026-09-04';

check('today and yesterday resolve to single days', () => {
  assert.deepEqual(periodFrom('today', FRIDAY), { fromDate: FRIDAY, toDate: FRIDAY });
  assert.deepEqual(periodFrom('yesterday', FRIDAY), {
    fromDate: '2026-09-03',
    toDate: '2026-09-03'
  });
});

check('this_week runs Monday to today, not to the end of the week', () => {
  assert.deepEqual(periodFrom('this_week', FRIDAY), { fromDate: '2026-08-31', toDate: FRIDAY });
});

check('last_week is the whole previous Monday-to-Sunday', () => {
  assert.deepEqual(periodFrom('last_week', FRIDAY), {
    fromDate: '2026-08-24',
    toDate: '2026-08-30'
  });
});

check('a Sunday still belongs to the week that began the previous Monday', () => {
  // The off-by-one a weekday-anchored test never sees: with weeks starting
  // Monday, Sunday is day 7 of the current week, not day 1 of the next.
  assert.deepEqual(periodFrom('this_week', '2026-09-06'), {
    fromDate: '2026-08-31',
    toDate: '2026-09-06'
  });
  assert.deepEqual(periodFrom('last_week', '2026-09-06'), {
    fromDate: '2026-08-24',
    toDate: '2026-08-30'
  });
});

check('a Monday is the first day of its own week', () => {
  assert.deepEqual(periodFrom('this_week', '2026-09-07'), {
    fromDate: '2026-09-07',
    toDate: '2026-09-07'
  });
});

check('last_7_days is inclusive of today, so it spans 7 days not 8', () => {
  assert.deepEqual(periodFrom('last_7_days', FRIDAY), {
    fromDate: '2026-08-29',
    toDate: FRIDAY
  });
  assert.deepEqual(periodFrom('last_30_days', FRIDAY), {
    fromDate: '2026-08-06',
    toDate: FRIDAY
  });
});

check('this_month stops at today rather than running into the future', () => {
  assert.deepEqual(periodFrom('this_month', FRIDAY), { fromDate: '2026-09-01', toDate: FRIDAY });
});

check('last_month covers the whole previous month, including its last day', () => {
  assert.deepEqual(periodFrom('last_month', FRIDAY), {
    fromDate: '2026-08-01',
    toDate: '2026-08-31'
  });
  // A 30-day month, and a February, where "subtract 31 days" is wrong.
  assert.deepEqual(periodFrom('last_month', '2026-05-15'), {
    fromDate: '2026-04-01',
    toDate: '2026-04-30'
  });
  assert.deepEqual(periodFrom('last_month', '2026-03-10'), {
    fromDate: '2026-02-01',
    toDate: '2026-02-28'
  });
});

check('last_month crosses the year boundary', () => {
  assert.deepEqual(periodFrom('last_month', '2026-01-09'), {
    fromDate: '2025-12-01',
    toDate: '2025-12-31'
  });
});

check('period names are matched loosely but unknown ones are rejected', () => {
  assert.deepEqual(periodFrom('Last Week', FRIDAY), periodFrom('last_week', FRIDAY));
  assert.deepEqual(periodFrom('last-week', FRIDAY), periodFrom('last_week', FRIDAY));
  assert.throws(() => periodFrom('last_fortnight', FRIDAY), /Unknown period/);
});

check('todayInZone returns YYYY-MM-DD and never throws on a bad zone', () => {
  const shape = /^\d{4}-\d{2}-\d{2}$/;
  assert.match(todayInZone('Asia/Kolkata'), shape);
  // An unrecognised zone must fall back rather than throw - the org timezone
  // comes from the backend and is not validated anywhere upstream.
  assert.match(todayInZone('Not/AZone'), shape);
  assert.match(todayInZone(undefined), shape);
});

check('resolveDay passes literal dates through untouched', () => {
  assert.equal(resolveDay('2026-02-11'), '2026-02-11');
  assert.equal(resolveDay('  2026-02-11 '), '2026-02-11');
  assert.equal(resolveDay('today', 'UTC'), todayInZone('UTC'));
});

check('resolveRange prefers an explicit pair and rejects an empty argument set', () => {
  assert.deepEqual(resolveRange({ fromDate: '2026-02-01', toDate: '2026-02-10' }), {
    fromDate: '2026-02-01',
    toDate: '2026-02-10'
  });
  // An explicit pair wins over a period, so a caller sending both is never
  // silently handed the period's dates instead.
  assert.deepEqual(
    resolveRange({ period: 'last_month', fromDate: '2026-02-01', toDate: '2026-02-10' }),
    { fromDate: '2026-02-01', toDate: '2026-02-10' }
  );
  assert.throws(() => resolveRange({}), /Give either period/);
});

check('every resolved period is a range assertRangeIsSane accepts', () => {
  for (const name of ['today', 'this_week', 'last_week', 'last_30_days', 'last_month']) {
    const range = periodFrom(name, FRIDAY);
    assert.doesNotThrow(() => assertRangeIsSane(range.fromDate, range.toDate), name);
  }
});

console.log(`\n${passed} assertions passed.`);
