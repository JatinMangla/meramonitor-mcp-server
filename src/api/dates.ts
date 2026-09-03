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
