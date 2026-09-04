import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  assertRangeIsSane,
  formatSeconds,
  nowApiDateTime,
  resolveDay,
  resolveRange,
  toApiDateTime,
  toApiDayStart,
  PERIOD_NAMES
} from '../api/dates.js';
import { isAdminRole } from '../auth/meramonitor.js';
import { resolveUser } from './identity.js';
import { guard, identityOf, json, text, type ToolContext } from './shared.js';

interface ClaimableDetail {
  timeClaimId?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  spentTime?: number | null;
  userActivityStatus?: string | null;
  requestStatus?: string | null;
  reason?: string | null;
}

/** Note: the total* fields come back as pre-formatted strings, not seconds. */
interface ClaimableResponse {
  firstActivity?: string | null;
  lastActivity?: string | null;
  totalTime?: string | null;
  totalIdleTime?: string | null;
  totalAwayTime?: string | null;
  totalActiveTime?: string | null;
  totalProductiveTime?: string | null;
  totalUnProductiveTime?: string | null;
  totalNeutralTime?: string | null;
  details?: ClaimableDetail[] | null;
}

interface ClaimStatusRow {
  timeClaimId?: string | null;
  userId?: string | null;
  userName?: string | null;
  claimStatus?: string | null;
  fromTime?: string | null;
  toTime?: string | null;
  recordDate?: string | null;
  reason?: string | null;
  activityStatus?: string | null;
  responseBy?: string | null;
  timeZone?: string | null;
  createdDate?: string | null;
}

interface PendingCountResponse {
  pendingRequestCount?: number | null;
  initialRequestDate?: string | null;
  latestRequestDate?: string | null;
}

interface WriteResult {
  success?: boolean;
  message?: string;
}

/** Statuses the backend routes down the "away" endpoints (timeclaim.service.ts:62). */
const AWAY_STATUSES = new Set(['stopped', 'offline', 'away']);

function isAwayStatus(status: string): boolean {
  return AWAY_STATUSES.has(status.trim().toLowerCase());
}

export function registerTimeClaimTools(server: McpServer, ctx: ToolContext): void {
  // ---- Phase 2: reads ------------------------------------------------------

  server.registerTool(
    'get_claimable_time',
    {
      title: 'Claimable idle/away time for a day',
      description:
        'What time can still be claimed on a given day, broken into individual idle/away segments ' +
        'with their start, end and duration. This is the list you pick from when claiming.',
      inputSchema: {
        user: z.string().optional().describe('Name, email, or userId. Defaults to you.'),
        date: z.string().describe('Which day: YYYY-MM-DD, or "today" / "yesterday"')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user, date }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const day = resolveDay(date, identity.orgTimeZoneName);
        const target = user ? await resolveUser(ctx, identity, user) : null;

        const data = await ctx.clientFor(identity).get<ClaimableResponse>('/TimeClaim/GetUserTimeToClaim', {
          UserId: target?.userId ?? identity.userId,
          OrganizationId: identity.organizationId,
          FromDate: toApiDayStart(day)
        });

        const details = (data?.details ?? []).map(d => ({
          timeClaimId: d.timeClaimId,
          from: d.startTime,
          to: d.endTime,
          duration: formatSeconds(d.spentTime),
          seconds: d.spentTime ?? 0,
          activityStatus: d.userActivityStatus,
          requestStatus: d.requestStatus,
          reason: d.reason
        }));

        return json({
          user: target
            ? { userId: target.userId, fullName: target.fullName }
            : { userId: identity.userId, fullName: identity.fullName },
          date: day,
          firstActivity: data?.firstActivity,
          lastActivity: data?.lastActivity,
          totals: {
            total: data?.totalTime,
            active: data?.totalActiveTime,
            idle: data?.totalIdleTime,
            away: data?.totalAwayTime,
            productive: data?.totalProductiveTime,
            unproductive: data?.totalUnProductiveTime,
            neutral: data?.totalNeutralTime
          },
          claimableSegments: details
        });
      })
  );

  server.registerTool(
    'list_time_claims',
    {
      title: 'List time claims and their status',
      description:
        'Time claim requests over a date range with their approval status (pending, approved, rejected).',
      inputSchema: {
        user: z.string().optional().describe('Name, email, or userId. Defaults to you.'),
        period: z
          .enum(PERIOD_NAMES)
          .optional()
          .describe('Relative range, resolved in the organization timezone. Prefer this.'),
        fromDate: z
          .string()
          .optional()
          .describe('Start of an explicit range: YYYY-MM-DD, or "today" / "yesterday".'),
        toDate: z.string().optional().describe('End of an explicit range (inclusive).'),
        status: z.string().optional().describe('Filter client-side by claim status, e.g. Pending')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user, period, fromDate, toDate, status }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const range = resolveRange({ period, fromDate, toDate }, identity.orgTimeZoneName);
        assertRangeIsSane(range.fromDate, range.toDate);
        const target = user ? await resolveUser(ctx, identity, user) : null;

        const rows = await ctx
          .clientFor(identity)
          .get<ClaimStatusRow[]>('/TimeClaim/GetAllClaimTimeStatus', {
            OrganizationId: identity.organizationId,
            UserId: target?.userId ?? identity.userId,
            FromDate: toApiDayStart(range.fromDate),
            ToDate: toApiDayStart(range.toDate),
            UserType: identity.roleName
          });

        let list = Array.isArray(rows) ? rows : [];
        if (status) {
          const needle = status.trim().toLowerCase();
          list = list.filter(r => (r.claimStatus ?? '').toLowerCase() === needle);
        }

        return json({
          range: { ...range, ...(period ? { period } : {}) },
          count: list.length,
          claims: list.map(r => ({
            timeClaimId: r.timeClaimId,
            user: r.userName,
            date: r.recordDate,
            from: r.fromTime,
            to: r.toTime,
            activityStatus: r.activityStatus,
            claimStatus: r.claimStatus,
            reason: r.reason,
            respondedBy: r.responseBy,
            createdDate: r.createdDate
          }))
        });
      })
  );

  server.registerTool(
    'get_pending_claim_count',
    {
      title: 'Count pending time claims',
      description: 'How many time claim requests are awaiting a decision, and the date range they span.',
      inputSchema: {
        user: z.string().optional().describe('Name, email, or userId. Defaults to you.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const target = user ? await resolveUser(ctx, identity, user) : null;

        const data = await ctx
          .clientFor(identity)
          .get<PendingCountResponse>('/TimeClaim/GetPendingTimeClaimRequestCount', {
            OrganizationId: identity.organizationId,
            UserId: target?.userId ?? identity.userId,
            UserType: identity.roleName
          });

        return json({
          pendingRequestCount: data?.pendingRequestCount ?? 0,
          earliestRequest: data?.initialRequestDate,
          latestRequest: data?.latestRequestDate
        });
      })
  );

  // ---- Phase 3: the one write ---------------------------------------------

  server.registerTool(
    'submit_time_claim',
    {
      title: 'Submit a time claim',
      description:
        'Claims a block of idle or away time. Creates ONE claim per call. ' +
        'Without confirm=true it only echoes the exact payload it would send, so you can check it first. ' +
        'This tool cannot approve, reject, or delete claims.',
      inputSchema: {
        user: z.string().optional().describe('Who the claim is for. Defaults to you.'),
        fromTime: z.string().describe('Start, as YYYY-MM-DDTHH:mm:ss (or YYYY-MM-DD HH:mm)'),
        toTime: z.string().describe('End, same format as fromTime'),
        activityStatus: z
          .string()
          .describe('Idle | Away | Stopped | Offline - taken from get_claimable_time'),
        reason: z.string().min(1).describe('Why this time should be claimed'),
        projectId: z.string().optional().describe('Optional project to book the time against'),
        taskId: z.string().optional().describe('Optional task to book the time against'),
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true to actually submit. Omit for a dry run.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ user, fromTime, toTime, activityStatus, reason, projectId, taskId, confirm }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const target = user ? await resolveUser(ctx, identity, user) : null;

        const targetUserId = target?.userId ?? identity.userId;
        const from = toApiDateTime(fromTime);
        const to = toApiDateTime(toTime);
        if (new Date(to) <= new Date(from)) {
          throw new Error(`toTime (${toTime}) must be after fromTime (${fromTime}).`);
        }

        const admin = isAdminRole(identity.roleName);
        const away = isAwayStatus(activityStatus);

        // Four endpoints on two axes - see timeclaim.service.ts:58-62.
        const path = away
          ? admin
            ? '/TimeClaim/AddAwayTimeClaimByAdmin'
            : '/TimeClaim/AddUserTimeToClaimForStoppedorOffline'
          : admin
            ? '/TimeClaim/AddIdleTimeClaimByAdmin'
            : '/TimeClaim/AddUserTimeToClaim';

        const optional = {
          ...(projectId ? { projectId } : {}),
          ...(taskId ? { taskId } : {})
        };

        const body: Record<string, unknown> = admin
          ? {
              organizationId: identity.organizationId,
              userId: targetUserId,
              adminUserId: identity.userId,
              fromTime: from,
              toTime: to,
              reason,
              activityStatusType: activityStatus,
              ...optional
            }
          : {
              organizationId: identity.organizationId,
              userId: targetUserId,
              claimStatus: '',
              fromTime: from,
              toTime: to,
              requestDate: nowApiDateTime(),
              reason,
              ...(away ? { activityStatusType: activityStatus, ...optional } : {})
            };

        if (confirm !== true) {
          return json({
            dryRun: true,
            note: 'Nothing was submitted. Call again with confirm=true to send this.',
            endpoint: path,
            actingAs: { userId: identity.userId, role: identity.roleName, isAdmin: admin },
            claimFor: target
              ? { userId: target.userId, fullName: target.fullName }
              : { userId: identity.userId, fullName: identity.fullName },
            body
          });
        }

        const result = await ctx.clientFor(identity).post<WriteResult>(path, body);

        if (result?.success === false) {
          throw new Error(result.message?.trim() || `${path} reported failure.`);
        }

        return text(
          `Claim submitted via ${path}.\n` +
            `${activityStatus} time ${from} to ${to} for ` +
            `${target?.fullName ?? identity.fullName ?? targetUserId}.\n` +
            `Backend said: ${result?.message?.trim() || 'no message'}\n` +
            'Verify it with list_time_claims.'
        );
      })
  );
}
