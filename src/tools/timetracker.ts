import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  assertRangeIsSane,
  formatSeconds,
  resolveDay,
  resolveRange,
  toApiDayStart,
  PERIOD_NAMES
} from '../api/dates.js';
import { isAdminRole, type MeraMonitorIdentity } from '../auth/meramonitor.js';
import { resolveUser, type OrgUser } from './identity.js';
import { guard, identityOf, json, type ToolContext } from './shared.js';

/** Shared request shape for both Calculate/* report endpoints. */
interface TimeTrackerRequest {
  fromDate: string;
  toDate: string;
  organizationId: string;
  userType: string;
  userId: string;
  userEmailId?: string;
  filtersType: { filterCategory: string; filterOperation: string; filterValue: number };
  isAdvanceFilterEnable: boolean;
  advanceFilter: { locationId: string; departmentId: string };
}

interface TimeTrackerRow {
  reportDate?: string | null;
  employeeName?: string | null;
  email?: string | null;
  role?: string | null;
  department?: string | null;
  location?: string | null;
  reportHead?: string | null;
  timeZone?: string | null;
  inTime?: string | null;
  outTime?: string | null;
  attendance?: string | null;
  isPresent?: boolean | null;
  totalTime?: number | null;
  activeTime?: number | null;
  productiveTime?: number | null;
  unproductiveTime?: number | null;
  neutralTime?: number | null;
  idleTime?: number | null;
  awayTime?: number | null;
  averageTimeSpent?: number | null;
}

interface ActivityBucket {
  applicationOrWebsite?: string | null;
  processTotalTimeSeconds?: number | null;
}

interface IdleBucket {
  applicationOrWebsite?: string | null;
  idleStart?: string | null;
  idleEnd?: string | null;
  idleTime?: number | null;
}

interface UserActivitiesResponse {
  productiveAppAndWebResponses?: ActivityBucket[] | null;
  unProductiveAppAndWebResponses?: ActivityBucket[] | null;
  neutralAppAndWebResponses?: ActivityBucket[] | null;
  idleAppAndWebResponses?: IdleBucket[] | null;
}

type Scope = 'organization' | 'team' | 'individual';

/**
 * Picks `userType`/`userId` the way the SPA does per role:
 *   Admin   -> "All" org-wide  (TimeTrackerAdmin.tsx:89-107)
 *   Manager -> "Team"          (TimeTrackerManager.tsx:138-149)
 *   User    -> "Individual"    (TimeTrackerUser.tsx:102-106)
 * Naming one person always narrows to "Individual" regardless of role; the
 * backend still enforces whether the caller may see them.
 */
function buildScope(
  identity: MeraMonitorIdentity,
  target: OrgUser | null,
  requested: Scope | undefined
): { userType: string; userId: string; userEmailId?: string } {
  if (target) {
    return { userType: 'Individual', userId: target.userId, userEmailId: target.email };
  }

  const scope: Scope =
    requested ??
    (isAdminRole(identity.roleName) ? 'organization' : identity.isManager ? 'team' : 'individual');

  if (scope === 'organization') return { userType: 'All', userId: identity.userId };
  if (scope === 'team') return { userType: 'Team', userId: identity.userId };
  return { userType: 'Individual', userId: identity.userId, userEmailId: identity.email };
}

function buildRequest(
  identity: MeraMonitorIdentity,
  scope: { userType: string; userId: string; userEmailId?: string },
  fromDate: string,
  toDate: string,
  locationId?: string,
  departmentId?: string
): TimeTrackerRequest {
  const hasAdvanced = Boolean(locationId || departmentId);
  return {
    fromDate: toApiDayStart(fromDate),
    toDate: toApiDayStart(toDate),
    organizationId: identity.organizationId,
    userType: scope.userType,
    userId: scope.userId,
    ...(scope.userEmailId ? { userEmailId: scope.userEmailId } : {}),
    filtersType: { filterCategory: '', filterOperation: '', filterValue: 0 },
    isAdvanceFilterEnable: hasAdvanced,
    // The API wants "" for unset, not "all" - sending "all" returns nothing.
    advanceFilter: { locationId: locationId ?? '', departmentId: departmentId ?? '' }
  };
}

/** The seven duration metrics every report row carries, in report order. */
const METRICS = [
  ['total', (r: TimeTrackerRow) => r.totalTime],
  ['active', (r: TimeTrackerRow) => r.activeTime],
  ['productive', (r: TimeTrackerRow) => r.productiveTime],
  ['unproductive', (r: TimeTrackerRow) => r.unproductiveTime],
  ['neutral', (r: TimeTrackerRow) => r.neutralTime],
  ['idle', (r: TimeTrackerRow) => r.idleTime],
  ['away', (r: TimeTrackerRow) => r.awayTime]
] as const;

/**
 * One report row, trimmed.
 *
 * Two deliberate reductions from the original shape:
 *
 *   - Durations are emitted ONCE, as seconds, instead of as both a formatted
 *     string and a seconds value. Every row carried seven of each, so half of
 *     a large report was a restatement of the other half. The `totals` block
 *     below still carries formatted strings, which is where a human-readable
 *     duration is actually wanted.
 *   - Null and empty fields are dropped rather than emitted as `null`. The
 *     backend returns a wide row and fills a minority of it.
 *
 * An org-wide month is roughly half its former size as a result, which is the
 * difference between fitting in a reply and being truncated by the client.
 */
function summarise(row: TimeTrackerRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== '') out[key] = value;
  };

  put('date', row.reportDate);
  put('employee', row.employeeName);
  put('email', row.email);
  put('department', row.department);
  put('location', row.location);
  put('reportsTo', row.reportHead);
  put('timeZone', row.timeZone);
  put('inTime', row.inTime);
  put('outTime', row.outTime);
  put('attendance', row.attendance);
  if (row.isPresent !== null && row.isPresent !== undefined) out['present'] = row.isPresent;

  // Seconds, per HANDOFF §5: every duration the API returns is int32 seconds.
  const seconds: Record<string, number> = {};
  for (const [name, read] of METRICS) {
    const value = read(row);
    if (value) seconds[name] = value; // zeros omitted - absence reads the same
  }
  if (Object.keys(seconds).length > 0) out['seconds'] = seconds;

  return out;
}

/**
 * Sums the range so the model does not have to.
 *
 * Asking an LLM to add seven metrics across a few hundred rows is both a
 * reliable source of arithmetic errors and the reason a caller would need the
 * full row set in context at all. Computing it here makes the common question
 * - "how much productive time did the team have last week" - answerable from
 * one small object.
 */
function totalsOf(rows: readonly TimeTrackerRow[]): Record<string, unknown> {
  const seconds: Record<string, number> = {};
  const formatted: Record<string, string> = {};

  for (const [name, read] of METRICS) {
    const sum = rows.reduce((acc, row) => acc + (read(row) ?? 0), 0);
    seconds[name] = sum;
    formatted[name] = formatSeconds(sum);
  }

  const people = new Set(
    rows.map(r => r.email ?? r.employeeName).filter((v): v is string => Boolean(v))
  );
  const days = new Set(rows.map(r => r.reportDate).filter((v): v is string => Boolean(v)));

  return {
    people: people.size,
    ...(days.size > 0 ? { daysCovered: days.size } : {}),
    seconds,
    formatted
  };
}

const rangeSchema = {
  user: z
    .string()
    .optional()
    .describe('Name, email, or userId. Omit for everyone you are allowed to see.'),
  // Relative dates, resolved server-side against the ORGANIZATION's timezone.
  // Prefer these: they remove the need to know today's date, and a miscomputed
  // explicit range returns an empty 200 that looks exactly like "no activity".
  period: z
    .enum(PERIOD_NAMES)
    .optional()
    .describe(
      'Relative range, resolved in the organization timezone. Prefer this over ' +
        'computing dates yourself. Ranges never extend past today.'
    ),
  fromDate: z
    .string()
    .optional()
    .describe('Start of an explicit range: YYYY-MM-DD, or "today"/"yesterday". Use with toDate.'),
  toDate: z
    .string()
    .optional()
    .describe('End of an explicit range (inclusive). Defaults to today if fromDate is given alone.'),
  scope: z
    .enum(['organization', 'team', 'individual'])
    .optional()
    .describe('Ignored when `user` is given. Defaults from your role.'),
  locationId: z.string().optional().describe('Filter by location id'),
  departmentId: z.string().optional().describe('Filter by department id')
};

export function registerTimeTrackerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_time_tracker_report',
    {
      title: 'Time tracker report (cumulative)',
      description:
        'Time tracker totals over a date range: total, active, productive, unproductive, neutral, ' +
        'idle and away time per person. This is the main reporting view.\n' +
        'Pass `period` (e.g. last_week) rather than computing dates. The response includes a ' +
        '`totals` block already summed across the range - use it instead of adding up rows. ' +
        'Durations inside rows are seconds.',
      inputSchema: rangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user, period, fromDate, toDate, scope, locationId, departmentId }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const range = resolveRange({ period, fromDate, toDate }, identity.orgTimeZoneName);
        assertRangeIsSane(range.fromDate, range.toDate);

        const target = user ? await resolveUser(ctx, identity, user) : null;
        const request = buildRequest(
          identity,
          buildScope(identity, target, scope),
          range.fromDate,
          range.toDate,
          locationId,
          departmentId
        );

        const rows = await ctx
          .clientFor(identity)
          .post<TimeTrackerRow[]>('/Calculate/TimeTrackerCummulativeReport', request);
        const list = Array.isArray(rows) ? rows : [];

        return json({
          // Echo the resolved range: when `period` was used this is the only
          // place the caller learns which dates it actually covered.
          range: { ...range, ...(period ? { period } : {}) },
          scope: request.userType,
          count: list.length,
          totals: totalsOf(list),
          rows: list.map(summarise)
        });
      })
  );

  server.registerTool(
    'get_time_tracker_daily_breakdown',
    {
      title: 'Time tracker day-by-day breakdown',
      description:
        'Per-day rows with in/out time and attendance alongside the productivity split. ' +
        'Use this when the question is about a specific day or attendance pattern; use ' +
        'get_time_tracker_report when only the range total matters.\n' +
        'Pass `period` rather than computing dates. Durations inside rows are seconds.',
      inputSchema: rangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user, period, fromDate, toDate, scope, locationId, departmentId }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const range = resolveRange({ period, fromDate, toDate }, identity.orgTimeZoneName);
        assertRangeIsSane(range.fromDate, range.toDate);

        const target = user ? await resolveUser(ctx, identity, user) : null;
        const request = buildRequest(
          identity,
          buildScope(identity, target, scope),
          range.fromDate,
          range.toDate,
          locationId,
          departmentId
        );

        const rows = await ctx
          .clientFor(identity)
          .post<TimeTrackerRow[]>('/Calculate/UserBifurcationTimeTrackerReport', request);
        const list = Array.isArray(rows) ? rows : [];

        return json({
          range: { ...range, ...(period ? { period } : {}) },
          scope: request.userType,
          count: list.length,
          totals: totalsOf(list),
          days: list.map(summarise)
        });
      })
  );

  server.registerTool(
    'get_user_activity_apps',
    {
      title: 'Apps and sites used on a day',
      description:
        'Which applications and websites one person used on a single day, split into productive, ' +
        'unproductive and neutral, plus the individual idle periods.',
      inputSchema: {
        user: z.string().describe('Name, email, or userId'),
        date: z.string().describe('Which day: YYYY-MM-DD, or "today" / "yesterday"')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user, date }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const day = resolveDay(date, identity.orgTimeZoneName);
        const target = await resolveUser(ctx, identity, user);

        const data = await ctx
          .clientFor(identity)
          .post<UserActivitiesResponse>('/ActivityTracker/GetUserActivities', {
            organizationId: identity.organizationId,
            userId: target.userId,
            fromDate: toApiDayStart(day)
          });

        const apps = (rows: ActivityBucket[] | null | undefined) =>
          (rows ?? [])
            .map(r => ({
              name: r.applicationOrWebsite,
              time: formatSeconds(r.processTotalTimeSeconds),
              seconds: r.processTotalTimeSeconds ?? 0
            }))
            .sort((a, b) => b.seconds - a.seconds);

        return json({
          user: { userId: target.userId, fullName: target.fullName, email: target.email },
          date: day,
          productive: apps(data?.productiveAppAndWebResponses),
          unproductive: apps(data?.unProductiveAppAndWebResponses),
          neutral: apps(data?.neutralAppAndWebResponses),
          idlePeriods: (data?.idleAppAndWebResponses ?? []).map(r => ({
            from: r.idleStart,
            to: r.idleEnd,
            duration: formatSeconds(r.idleTime),
            seconds: r.idleTime ?? 0,
            during: r.applicationOrWebsite
          }))
        });
      })
  );
}
