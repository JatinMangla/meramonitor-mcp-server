import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEFAULT_CACHE_TTL_SECONDS } from '../cache.js';
import { todayInZone } from '../api/dates.js';
import { isAdminRole, type MeraMonitorIdentity } from '../auth/meramonitor.js';
import { guard, identityOf, json, type ToolContext } from './shared.js';

export interface OrgUser {
  userId: string;
  fullName: string;
  email: string;
  isActive: boolean;
}

/**
 * Cache key for one caller's view of the roster.
 *
 * Scoped to the USER, not just the organization. GetAllUserListByOrganization
 * is authorized by the bearer token, so what comes back can depend on who is
 * asking. Keying on organizationId alone would let one caller's result be
 * served to another whose own request would have returned less - a quiet
 * privilege leak in a product that exposes employee monitoring data. Per-caller
 * keys cost some hit rate; they are worth it.
 */
function rosterKey(identity: MeraMonitorIdentity): string {
  return `roster:${identity.organizationId}:${identity.userId}`;
}

/**
 * GET Registration/GetAllUserListByOrganization - note the camelCase param.
 *
 * Cached for DEFAULT_CACHE_TTL_SECONDS. Nearly every tool takes a person's
 * name and needs this list to turn it into a userId, so before caching a
 * three-tool conversation about one person fetched the identical full roster
 * three times, and list_users_with_screenshots fetched it once per name in a
 * sequential loop.
 *
 * `fresh` bypasses the cache for callers that must see a roster change
 * immediately - list_users, where a stale answer is the visible output rather
 * than an implementation detail.
 */
export async function fetchOrgUsers(
  ctx: ToolContext,
  identity: MeraMonitorIdentity,
  options: { fresh?: boolean } = {}
): Promise<OrgUser[]> {
  const key = rosterKey(identity);

  if (!options.fresh) {
    const cached = await ctx.cache.get<OrgUser[]>(key);
    if (cached) return cached;
  }

  const rows = await ctx
    .clientFor(identity)
    .get<OrgUser[]>('/Registration/GetAllUserListByOrganization', {
      organizationId: identity.organizationId
    });

  const users = Array.isArray(rows) ? rows : [];
  await ctx.cache.set(key, users, DEFAULT_CACHE_TTL_SECONDS);
  return users;
}

/**
 * Matches one name, email or userId against an already-fetched roster.
 *
 * Split out from resolveUser so a batch of names costs one roster fetch rather
 * than one per name.
 */
export function matchUser(users: readonly OrgUser[], nameOrEmail: string): OrgUser {
  const needle = nameOrEmail.trim().toLowerCase();

  const exact = users.filter(
    u => u.email?.toLowerCase() === needle || u.fullName?.toLowerCase() === needle || u.userId === nameOrEmail
  );
  if (exact.length === 1) return exact[0]!;

  const partial = users.filter(
    u => u.fullName?.toLowerCase().includes(needle) || u.email?.toLowerCase().includes(needle)
  );
  if (partial.length === 1) return partial[0]!;

  if (partial.length === 0) {
    throw new Error(`No user in this organization matches "${nameOrEmail}". Use list_users to see who exists.`);
  }
  throw new Error(
    `"${nameOrEmail}" matches ${partial.length} users: ` +
      `${partial.slice(0, 8).map(u => `${u.fullName} <${u.email}>`).join(', ')}. Be more specific.`
  );
}

/**
 * Resolves a name or email to exactly one user, or explains the ambiguity.
 * Every other tool needs a userId, and people ask by name.
 */
export async function resolveUser(
  ctx: ToolContext,
  identity: MeraMonitorIdentity,
  nameOrEmail: string
): Promise<OrgUser> {
  return matchUser(await fetchOrgUsers(ctx, identity), nameOrEmail);
}

/**
 * Resolves many names against ONE roster fetch.
 *
 * Reports every failure together rather than throwing on the first: asking
 * about eight people and being told only that the second name was ambiguous
 * costs a whole round trip per bad name to discover the rest.
 */
export async function resolveUsers(
  ctx: ToolContext,
  identity: MeraMonitorIdentity,
  namesOrEmails: readonly string[]
): Promise<OrgUser[]> {
  const users = await fetchOrgUsers(ctx, identity);
  const resolved: OrgUser[] = [];
  const problems: string[] = [];

  for (const name of namesOrEmails) {
    try {
      resolved.push(matchUser(users, name));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (problems.length > 0) throw new Error(problems.join('\n'));
  return resolved;
}

export function registerIdentityTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'whoami',
    {
      title: 'Show signed-in account',
      description:
        'Who this session is acting as in MeraMonitor: user id, organization, role, timezone, ' +
        "and today's date in that organization's timezone. Call this first when a question " +
        'involves a relative date and you need the anchor.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async (_args, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        return json({
          environment: ctx.config.envName,
          fullName: identity.fullName,
          email: identity.email,
          userId: identity.userId,
          organizationId: identity.organizationId,
          organizationName: identity.organizationName,
          role: identity.roleName,
          isAdmin: isAdminRole(identity.roleName),
          isManager: identity.isManager,
          orgTimeZone: identity.orgTimeZoneName,
          // The anchor every relative date resolves against. Without it the
          // model has to guess what "today" means on a UTC server for an org
          // that may be most of a day away.
          today: todayInZone(identity.orgTimeZoneName)
        });
      })
  );

  server.registerTool(
    'list_users',
    {
      title: 'List organization users',
      description:
        'Everyone in the signed-in organization, with the userId the other tools need. ' +
        'You usually do NOT need this first: every tool taking a `user` argument accepts a ' +
        'name or email directly and resolves it itself. Use this to browse who exists, or ' +
        'when a name came back ambiguous.',
      inputSchema: {
        search: z.string().optional().describe('Filter by name or email substring'),
        includeInactive: z.boolean().optional().describe('Include deactivated users (default false)')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ search, includeInactive }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        // Fresh: here the roster IS the answer, so a stale one is a wrong answer
        // rather than a slightly out-of-date lookup table.
        let users = await fetchOrgUsers(ctx, identity, { fresh: true });

        if (!includeInactive) users = users.filter(u => u.isActive !== false);
        if (search) {
          const needle = search.trim().toLowerCase();
          users = users.filter(
            u => u.fullName?.toLowerCase().includes(needle) || u.email?.toLowerCase().includes(needle)
          );
        }

        return json({ count: users.length, users });
      })
  );
}
