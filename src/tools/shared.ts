import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import { MeraMonitorClient } from '../api/client.js';
import type { MeraMonitorIdentity } from '../auth/meramonitor.js';

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ToolContext {
  config: Config;
  /** A client bound to the MeraMonitor token carried by the caller's OAuth token. */
  clientFor(identity: MeraMonitorIdentity): MeraMonitorClient;
}

export function createToolContext(config: Config): ToolContext {
  return {
    config,
    clientFor(identity: MeraMonitorIdentity) {
      return new MeraMonitorClient(
        config.baseUrl,
        async () => identity.accessToken,
        config.apiTimeoutMs
      );
    }
  };
}

/**
 * The MeraMonitor identity the caller signed in as.
 *
 * It rides on the verified OAuth token rather than a server-side session map,
 * so there is no separate linking step and nothing to look up or expire
 * independently of the token itself. This is also what makes the tools work
 * unchanged on serverless: the identity arrives with the request.
 */
export function identityOf(extra: ToolExtra): MeraMonitorIdentity {
  const identity = extra.authInfo?.extra?.['identity'] as MeraMonitorIdentity | undefined;
  if (!identity?.accessToken || !identity.organizationId) {
    throw new Error(
      'This session is not signed in to MeraMonitor. Reconnect the connector to sign in again.'
    );
  }
  return identity;
}

export function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

export function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

export function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Every tool body runs through this so a thrown API error becomes a readable
 * tool result instead of a transport-level failure.
 */
export async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
