import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertRangeIsSane, formatSeconds, toApiDayStart } from '../api/dates.js';
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

function summarise(row: TimeTrackerRow): Record<string, unknown> {
  return {
    date: row.reportDate,
    employee: row.employeeName,
    email: row.email,
    department: row.department,
    location: row.location,
    reportsTo: row.reportHead,
    timeZone: row.timeZone,
    ...(row.inTime !== undefined ? { inTime: row.inTime, outTime: row.outTime } : {}),
    ...(row.attendance !== undefined ? { attendance: row.attendance } : {}),
    ...(row.isPresent !== undefined && row.isPresent !== null ? { present: row.isPresent } : {}),
    total: formatSeconds(row.totalTime),
    active: formatSeconds(row.activeTime),
    productive: formatSeconds(row.productiveTime),
    unproductive: formatSeconds(row.unproductiveTime),
    neutral: formatSeconds(row.neutralTime),
    idle: formatSeconds(row.idleTime),
    away: formatSeconds(row.awayTime),
    seconds: {
      total: row.totalTime ?? 0,
      active: row.activeTime ?? 0,
      productive: row.productiveTime ?? 0,
      unproductive: row.unproductiveTime ?? 0,
      neutral: row.neutralTime ?? 0,
      idle: row.idleTime ?? 0,
      away: row.awayTime ?? 0
    }
  };
}

const rangeSchema = {
  user: z
    .string()
    .optional()
    .describe('Name, email, or userId. Omit for everyone you are allowed to see.'),
  fromDate: z.string().describe('Start of the range, YYYY-MM-DD (inclusive)'),
  toDate: z.string().describe('End of the range, YYYY-MM-DD (inclusive)'),
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
        'idle and away time per person. This is the main reporting view.',
      inputSchema: rangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user, fromDate, toDate, scope, locationId, departmentId }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        assertRangeIsSane(fromDate, toDate);

        const target = user ? await resolveUser(ctx, identity, user) : null;
        const request = buildRequest(
          identity,
          buildScope(identity, target, scope),
          fromDate,
          toDate,
          locationId,
          departmentId
        );

        const rows = await ctx
          .clientFor(identity)
          .post<TimeTrackerRow[]>('/Calculate/TimeTrackerCummulativeReport', request);
        const list = Array.isArray(rows) ? rows : [];

        return json({
          range: { fromDate, toDate },
          scope: request.userType,
          count: list.length,
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
        'Use this when the question is about a specific day or attendance pattern.',
      inputSchema: rangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user, fromDate, toDate, scope, locationId, departmentId }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        assertRangeIsSane(fromDate, toDate);

        const target = user ? await resolveUser(ctx, identity, user) : null;
        const request = buildRequest(
          identity,
          buildScope(identity, target, scope),
          fromDate,
          toDate,
          locationId,
          departmentId
        );

        const rows = await ctx
          .clientFor(identity)
          .post<TimeTrackerRow[]>('/Calculate/UserBifurcationTimeTrackerReport', request);
        const list = Array.isArray(rows) ? rows : [];

        return json({
          range: { fromDate, toDate },
          scope: request.userType,
          count: list.length,
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
        date: z.string().describe('Which day, as YYYY-MM-DD')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user, date }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const target = await resolveUser(ctx, identity, user);

        const data = await ctx
          .clientFor(identity)
          .post<UserActivitiesResponse>('/ActivityTracker/GetUserActivities', {
            organizationId: identity.organizationId,
            userId: target.userId,
            fromDate: toApiDayStart(date)
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
          date,
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
