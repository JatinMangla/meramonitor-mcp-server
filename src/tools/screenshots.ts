import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveDay, toApiDayStart } from '../api/dates.js';
import type { MeraMonitorIdentity } from '../auth/meramonitor.js';
import { fetchOrgUsers, resolveUser, resolveUsers } from './identity.js';
import { failure, guard, identityOf, json, type ToolContext } from './shared.js';

interface BlobThumbnail {
  thumbnail?: string | null;
  description?: string | null;
  path?: string | null;
}

interface HourlyRangeRow {
  range?: string | null;
  blobCount?: number | null;
  timeZone?: string | null;
  slotStartTime?: string | null;
  blobThumbnails?: BlobThumbnail[] | null;
}

interface UserScreenshot {
  path?: string | null;
  description?: string | null;
  data?: string | null;
}

/**
 * PORT NOTE (handoff 3.4) - the response byte budget.
 *
 * A Vercel Function's response body is hard-capped at 4.5 MB; exceeding it is
 * a 413 FUNCTION_PAYLOAD_TOO_LARGE, which the MCP client sees as an opaque
 * transport failure rather than a tool error it can explain. Screenshots are
 * returned as base64 image blocks, and a handful of full-size ones clears
 * 4.5 MB easily.
 *
 * So we accumulate the base64 length as images are appended and stop at
 * 3.5 MB, leaving roughly a megabyte of headroom for JSON-RPC framing, the
 * text blocks, and base64's own overhead. What fits is returned; what does not
 * is named in a text note so the model can ask for those paths in a follow-up
 * call. Degrading is the point - a partial answer beats a 413.
 *
 * This is a real functional limit that does not exist on a normal host. It is
 * mitigated here, not removed.
 */
const RESPONSE_BYTE_BUDGET = 3_500_000;

function mimeFor(path: string | null | undefined): string {
  const ext = (path ?? '').toLowerCase().split('.').pop() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

/**
 * Records that screenshots were viewed, mirroring what the SPA does at
 * ScreenshotContext.tsx:385-394. Best-effort: a failed audit write must not
 * hide the screenshots, but it is surfaced rather than swallowed.
 */
async function writeAuditLog(
  ctx: ToolContext,
  identity: MeraMonitorIdentity,
  targetUserId: string,
  reason: string
): Promise<string | null> {
  try {
    await ctx.clientFor(identity).post('/LiveTracking/AddLiveTrtackingAuditLogs', {
      orgId: identity.organizationId,
      userId: targetUserId,
      eventType: 'Screenshot',
      screen: 'MCP',
      reason,
      requestBy: identity.userId
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function registerScreenshotTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_screenshot_hours',
    {
      title: 'List screenshot activity by hour',
      description:
        'Day-wise screenshot overview for one person: how many screenshots exist in each hour slot, ' +
        'plus the path of each one. Only hours that actually contain screenshots are listed; ' +
        'totalScreenshots is the whole day. Returns NO image data - start here, then pass ' +
        'specific paths to get_screenshots for the hours that matter.',
      inputSchema: {
        user: z.string().describe('Name, email, or userId of the person to look at'),
        date: z.string().describe('Which day: YYYY-MM-DD, or "today" / "yesterday"')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user, date }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const day = resolveDay(date, identity.orgTimeZoneName);
        const target = await resolveUser(ctx, identity, user);

        const rows = await ctx
          .clientFor(identity)
          .post<HourlyRangeRow[]>('/CloudStorageScreenshots/GetScreenshotsByHourlyRange', {
            organizationId: identity.organizationId,
            userId: target.userId,
            email: target.email,
            reportDate: toApiDayStart(day)
          });

        const hours = (Array.isArray(rows) ? rows : []).map(row => ({
          range: row.range,
          count: row.blobCount ?? 0,
          timeZone: row.timeZone,
          slotStartTime: row.slotStartTime,
          // Strip `thumbnail` - it is base64 image data and would swamp the response.
          paths: (row.blobThumbnails ?? []).map(b => b.path).filter((p): p is string => Boolean(p))
        }));

        const total = hours.reduce((sum, h) => sum + h.count, 0);

        return json({
          user: { userId: target.userId, fullName: target.fullName, email: target.email },
          date: day,
          totalScreenshots: total,
          // Hours with no screenshots carry no information and are dropped.
          hours: hours.filter(h => h.count > 0 || h.paths.length > 0)
        });
      })
  );

  server.registerTool(
    'get_screenshots',
    {
      title: 'Fetch specific screenshots',
      description:
        'Returns the actual screenshot images for specific paths from list_screenshot_hours. ' +
        `Capped at ${ctx.config.maxScreenshotsPerCall} per call and thumbnails by default. ` +
        'The response is also capped at about 3.5 MB of image data; anything beyond that is ' +
        'listed as skipped so you can request it in a follow-up call. ' +
        'Every call is written to the MeraMonitor audit log.',
      inputSchema: {
        user: z.string().describe('Name, email, or userId - must match the paths requested'),
        date: z
          .string()
          .describe('The day those paths came from: YYYY-MM-DD, or "today" / "yesterday"'),
        paths: z
          .array(z.string())
          .min(1)
          .describe('Screenshot paths from list_screenshot_hours. Required - there is no fetch-all.'),
        fullSize: z
          .boolean()
          .optional()
          .describe('Full-resolution instead of thumbnails (default false)'),
        reason: z.string().optional().describe('Why these are being viewed; recorded in the audit log')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ user, date, paths, fullSize, reason }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const day = resolveDay(date, identity.orgTimeZoneName);
        const target = await resolveUser(ctx, identity, user);

        const cap = ctx.config.maxScreenshotsPerCall;
        if (paths.length > cap) {
          return failure(
            `Asked for ${paths.length} screenshots but the per-call cap is ${cap}. ` +
              'Narrow it to the specific times you need.'
          );
        }

        // The image fetch and the audit write are independent, so they run
        // together rather than one after the other - this is the slowest tool
        // and that was a whole serialised round trip.
        //
        // The ordering change is deliberate in one respect: the audit entry is
        // now written even if the fetch then fails. For an audit log that is
        // the safe direction - recording an attempt that returned nothing is a
        // far smaller problem than a successful view that went unrecorded.
        // writeAuditLog never throws, so Promise.all cannot lose the images to
        // an audit failure.
        const [rows, auditError] = await Promise.all([
          ctx.clientFor(identity).post<UserScreenshot[]>('/CloudStorageScreenshots/GetUserScreenshots', {
            organizationId: identity.organizationId,
            userId: target.userId,
            reportDate: toApiDayStart(day),
            pathList: paths,
            isThumbNail: fullSize !== true
          }),
          writeAuditLog(
            ctx,
            identity,
            target.userId,
            reason ?? `Viewed ${paths.length} screenshot(s) for ${day} via MCP`
          )
        ]);

        const images = (Array.isArray(rows) ? rows : []).filter(r => r.data);

        // --- byte budget ---------------------------------------------------
        const included: UserScreenshot[] = [];
        const skipped: string[] = [];
        let usedBytes = 0;

        for (const row of images) {
          const size = (row.data as string).length;
          // Always admit the first image even if it alone is over budget: a
          // truncated-to-nothing response is less useful than one oversized
          // image, and a single thumbnail is nowhere near 4.5 MB in practice.
          if (included.length > 0 && usedBytes + size > RESPONSE_BYTE_BUDGET) {
            skipped.push(row.path ?? '(unknown path)');
            continue;
          }
          included.push(row);
          usedBytes += size;
        }

        const requestedButMissing = paths.filter(
          p => !images.some(r => r.path === p)
        );

        const summary =
          `${included.length} of ${images.length} screenshot(s) returned for ` +
          `${target.fullName ?? target.email} on ${day} ` +
          `(${fullSize === true ? 'full size' : 'thumbnails'}, ` +
          `~${(usedBytes / 1_000_000).toFixed(2)} MB of a ${(RESPONSE_BYTE_BUDGET / 1_000_000).toFixed(1)} MB budget).`;

        const notes: string[] = [summary];

        if (skipped.length > 0) {
          notes.push(
            `TRUNCATED: ${skipped.length} screenshot(s) were left out to stay under Vercel's ` +
              '4.5 MB response limit. Call get_screenshots again with these paths to retrieve them' +
              (fullSize === true ? ', or omit fullSize to get thumbnails instead' : '') +
              `:\n${skipped.map(p => `  - ${p}`).join('\n')}`
          );
        }

        if (requestedButMissing.length > 0) {
          notes.push(
            `${requestedButMissing.length} requested path(s) returned no image data:\n` +
              requestedButMissing.map(p => `  - ${p}`).join('\n')
          );
        }

        if (auditError) {
          notes.push(`Audit log write FAILED: ${auditError}`);
        }

        const content: CallToolResult['content'] = [{ type: 'text', text: notes.join('\n\n') }];

        for (const row of included) {
          content.push({ type: 'text', text: `path: ${row.path ?? '(unknown)'}` });
          content.push({ type: 'image', data: row.data as string, mimeType: mimeFor(row.path) });
        }

        return { content };
      })
  );

  server.registerTool(
    'list_users_with_screenshots',
    {
      title: 'Which users have screenshots on a day',
      description:
        'Given a set of users and a date, returns the subset that actually has screenshots stored. ' +
        'Use it to skip empty days before drilling in.',
      inputSchema: {
        users: z
          .array(z.string())
          .optional()
          .describe('Names, emails, or userIds. Omit to check everyone in the organization.'),
        date: z.string().describe('Which day: YYYY-MM-DD, or "today" / "yesterday"')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ users, date }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        const day = resolveDay(date, identity.orgTimeZoneName);

        // resolveUsers matches every name against ONE roster fetch. This used
        // to be a `for` loop with an await inside, so ten names meant ten
        // sequential fetches of the same full organization list before the
        // real call could even start.
        const roster =
          users && users.length > 0
            ? await resolveUsers(ctx, identity, users)
            : (await fetchOrgUsers(ctx, identity)).filter(u => u.isActive !== false);

        const userIds = roster.map(u => u.userId);
        const nameById = new Map(roster.map(u => [u.userId, u.fullName ?? u.email]));

        const withData = await ctx
          .clientFor(identity)
          .post<string[]>('/CloudStorageScreenshots/GetScreenshotsExistUserList', {
            organizationId: identity.organizationId,
            userIds,
            reportDate: toApiDayStart(day)
          });

        const found = new Set(withData ?? []);

        return json({
          date: day,
          checked: userIds.length,
          // Names alongside the ids: the answer to "who has screenshots" is a
          // list of people, and returning bare GUIDs forced a second lookup.
          withScreenshots: [...found].map(id => ({ userId: id, name: nameById.get(id) })),
          withoutScreenshots: userIds.filter(id => !found.has(id)).length
        });
      })
  );
}
