/**
 * Date and duration helpers.
 *
 * The backend expects `YYYY-MM-DDTHH:mm:ss` followed by a LITERAL "Z" that is
 * not a UTC marker: the SPA produces these with dayjs `format("YYYY-MM-DDTHH:mm:ss[Z]")`,
 * where `[Z]` is an escaped literal, so the wall-clock is local and the Z is
 * decoration. We reproduce that byte-for-byte rather than sending real UTC -
 * sending a genuine UTC instant here shifts every report by the local offset.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Parses `YYYY-MM-DD` as a local calendar date, avoiding UTC-midnight drift. */
function parseLocal(input: string): Date {
  const trimmed = input.trim();

  if (DATE_ONLY.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map(Number);
    return new Date(y!, m! - 1, d!, 0, 0, 0, 0);
  }

  if (DATE_TIME.test(trimmed)) {
    const [datePart, timePart] = trimmed.split(/[T ]/);
    const [y, m, d] = datePart!.split('-').map(Number);
    const [hh, mm, ss] = timePart!.split(':').map(Number);
    return new Date(y!, m! - 1, d!, hh!, mm!, ss ?? 0, 0);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Unrecognised date "${input}". Use YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.`
    );
  }
  return parsed;
}

function format(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}Z`
  );
}

/** `2026-01-05 14:30` -> `2026-01-05T14:30:00Z` (local wall-clock, literal Z). */
export function toApiDateTime(input: string): string {
  return format(parseLocal(input));
}

/** `2026-01-05` -> `2026-01-05T00:00:00Z`. Used by every day-granular endpoint. */
export function toApiDayStart(input: string): string {
  const d = parseLocal(input);
  d.setHours(0, 0, 0, 0);
  return format(d);
}

/** Current instant in the same format, for `requestDate` fields. */
export function nowApiDateTime(): string {
  return format(new Date());
}

/**
 * Rejects an inverted or absurd range before it reaches the API, which returns
 * an empty array rather than an error for these.
 */
export function assertRangeIsSane(fromDate: string, toDate: string): void {
  const from = parseLocal(fromDate);
  const to = parseLocal(toDate);
  if (to.getTime() < from.getTime()) {
    throw new Error(`toDate (${toDate}) is before fromDate (${fromDate}).`);
  }
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > 366) {
    throw new Error(`Range is ${Math.round(days)} days; keep it to 366 or fewer.`);
  }
}

/** The API returns every duration as int32 seconds. Render it for a human. */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '0m';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

// --- relative dates ---------------------------------------------------------
//
// Every tool used to demand a literal YYYY-MM-DD, which pushed two problems
// onto the model: knowing what "today" is in the ORGANIZATION's timezone (not
// the server's - Vercel runs UTC), and doing the calendar arithmetic for
// "last week". Getting either wrong does not raise an error. Per HANDOFF §5 a
// wrong parameter returns an empty 200, so a bad date guess is indistinguishable
// from "this person did no work", which is the worst possible failure mode for
// a reporting tool.
//
// Resolving the words here, once, against the org timezone removes that class
// of silent wrong answer.

/** Today's calendar date in `timeZone`, as YYYY-MM-DD. Falls back to server
 *  local time if the zone is missing or not recognised. */
export function todayInZone(timeZone?: string): string {
  const parts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  };
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the shape we want.
    return new Intl.DateTimeFormat('en-CA', { ...parts, timeZone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', parts).format(new Date());
  }
}

/**
 * Calendar arithmetic on a YYYY-MM-DD string, done in UTC.
 *
 * UTC deliberately: these are calendar dates, not instants. Adding days to a
 * local Date crosses DST boundaries and can land on the same day twice or skip
 * one. Date.UTC has no such transitions, and since we only ever read the
 * Y/M/D back out, no timezone is involved in the result.
 */
function shiftDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = Date.UTC(y!, m! - 1, d!) + delta * 86_400_000;
  const out = new Date(t);
  return `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`;
}

/** Day of week for a YYYY-MM-DD string, 0 = Sunday. */
function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** Days back to the most recent Monday. Weeks start Monday - the convention
 *  every MeraMonitor report uses. */
function daysSinceMonday(day: string): number {
  return (weekdayOf(day) + 6) % 7;
}

function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function lastOfMonth(day: string): string {
  const [y, m] = day.split('-').map(Number);
  // Day 0 of the next month is the last day of this one.
  const out = new Date(Date.UTC(y!, m!, 0));
  return `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`;
}

/** Every period name `period` accepts, in the order they are offered to the model. */
export const PERIOD_NAMES = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'last_7_days',
  'last_14_days',
  'last_30_days',
  'this_month',
  'last_month'
] as const;

export type PeriodName = (typeof PERIOD_NAMES)[number];

export interface DateRange {
  fromDate: string;
  toDate: string;
}

/**
 * Expands a period name into an inclusive YYYY-MM-DD range, anchored to today
 * in the organization's timezone.
 *
 * Ranges never run past today: asking for "this_month" on the 4th returns the
 * 1st to the 4th, not the whole month. A range extending into the future
 * returns empty rows from the backend and reads as missing data.
 */
export function resolvePeriod(period: string, timeZone?: string): DateRange {
  return periodFrom(period, todayInZone(timeZone));
}

/**
 * The pure arithmetic behind resolvePeriod, against an explicit `today`.
 *
 * Separated so the calendar rules can be tested against fixed dates - week
 * boundaries and month ends are exactly the kind of logic that is wrong only
 * on a Sunday or a 31st, which a test anchored to the real clock would almost
 * never catch.
 */
export function periodFrom(period: string, today: string): DateRange {
  const name = period.trim().toLowerCase().replace(/[\s-]+/g, '_');

  switch (name) {
    case 'today':
      return { fromDate: today, toDate: today };
    case 'yesterday': {
      const d = shiftDays(today, -1);
      return { fromDate: d, toDate: d };
    }
    case 'this_week':
      return { fromDate: shiftDays(today, -daysSinceMonday(today)), toDate: today };
    case 'last_week': {
      const thisMonday = shiftDays(today, -daysSinceMonday(today));
      return { fromDate: shiftDays(thisMonday, -7), toDate: shiftDays(thisMonday, -1) };
    }
    case 'last_7_days':
      return { fromDate: shiftDays(today, -6), toDate: today };
    case 'last_14_days':
      return { fromDate: shiftDays(today, -13), toDate: today };
    case 'last_30_days':
      return { fromDate: shiftDays(today, -29), toDate: today };
    case 'this_month':
      return { fromDate: firstOfMonth(today), toDate: today };
    case 'last_month': {
      const endOfLast = shiftDays(firstOfMonth(today), -1);
      return { fromDate: firstOfMonth(endOfLast), toDate: lastOfMonth(endOfLast) };
    }
    default:
      throw new Error(
        `Unknown period "${period}". Use one of: ${PERIOD_NAMES.join(', ')}, ` +
          'or pass explicit fromDate and toDate as YYYY-MM-DD.'
      );
  }
}

/**
 * Accepts a single day as either a literal YYYY-MM-DD or the words `today` /
 * `yesterday`, resolved against the organization's timezone.
 */
export function resolveDay(input: string, timeZone?: string): string {
  const name = input.trim().toLowerCase();
  if (name === 'today') return todayInZone(timeZone);
  if (name === 'yesterday') return shiftDays(todayInZone(timeZone), -1);
  if (DATE_ONLY.test(input.trim())) return input.trim();
  // Anything else still has to be a date parseLocal understands; let it raise
  // its own message rather than guessing at intent.
  const parsed = parseLocal(input);
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

/**
 * The one entry point range-taking tools use: either a `period` word or an
 * explicit pair, with the explicit pair winning if both are somehow given.
 */
export function resolveRange(
  args: { period?: string; fromDate?: string; toDate?: string },
  timeZone?: string
): DateRange {
  if (args.fromDate && args.toDate) {
    return {
      fromDate: resolveDay(args.fromDate, timeZone),
      toDate: resolveDay(args.toDate, timeZone)
    };
  }
  if (args.period) return resolvePeriod(args.period, timeZone);
  if (args.fromDate && !args.toDate) {
    const from = resolveDay(args.fromDate, timeZone);
    return { fromDate: from, toDate: todayInZone(timeZone) };
  }
  throw new Error(
    `Give either period (${PERIOD_NAMES.join(', ')}) or both fromDate and toDate as YYYY-MM-DD.`
  );
}
