import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAdminRole, type MeraMonitorIdentity } from '../auth/meramonitor.js';
import { guard, identityOf, json, type ToolContext } from './shared.js';

export interface OrgUser {
  userId: string;
  fullName: string;
  email: string;
  isActive: boolean;
}

/** GET Registration/GetAllUserListByOrganization - note the camelCase param. */
export async function fetchOrgUsers(
  ctx: ToolContext,
  identity: MeraMonitorIdentity
): Promise<OrgUser[]> {
  const rows = await ctx
    .clientFor(identity)
    .get<OrgUser[]>('/Registration/GetAllUserListByOrganization', {
      organizationId: identity.organizationId
    });
  return Array.isArray(rows) ? rows : [];
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
  const needle = nameOrEmail.trim().toLowerCase();
  const users = await fetchOrgUsers(ctx, identity);

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

export function registerIdentityTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'whoami',
    {
      title: 'Show signed-in account',
      description:
        'Who this session is acting as in MeraMonitor: user id, organization, role, timezone, ' +
        'and which backend environment is in use.',
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
          orgTimeZone: identity.orgTimeZoneName
        });
      })
  );

  server.registerTool(
    'list_users',
    {
      title: 'List organization users',
      description:
        'Everyone in the signed-in organization, with the userId the other tools need. ' +
        'Use this to turn a person name into a userId.',
      inputSchema: {
        search: z.string().optional().describe('Filter by name or email substring'),
        includeInactive: z.boolean().optional().describe('Include deactivated users (default false)')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ search, includeInactive }, extra) =>
      guard(async () => {
        const identity = identityOf(extra);
        let users = await fetchOrgUsers(ctx, identity);

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
