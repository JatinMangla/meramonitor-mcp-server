import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Config } from '../config.js';

/**
 * Layer 1 of the two auth layers: proves which claude.ai user is calling.
 *
 * In `external` mode this server is an OAuth *resource* server only - it
 * validates tokens, it does not issue them. Point OAUTH_ISSUER_URL /
 * OAUTH_JWKS_URL at a real authorization server.
 */

function scopesFrom(payload: JWTPayload): string[] {
  const scope = payload['scope'];
  if (typeof scope === 'string') return scope.split(' ').filter(Boolean);
  const scp = payload['scp'];
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === 'string');
  return [];
}

export function createJwtVerifier(config: Config): OAuthTokenVerifier {
  if (!config.oauthJwksUrl || !config.oauthIssuerUrl) {
    throw new Error('createJwtVerifier requires OAUTH_JWKS_URL and OAUTH_ISSUER_URL.');
  }

  // Caches keys and refreshes on rotation; build it once, not per request.
  const jwks = createRemoteJWKSet(config.oauthJwksUrl);
  const issuer = config.oauthIssuerUrl.toString();

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          ...(config.oauthAudience ? { audience: config.oauthAudience } : {})
        });

        if (!payload.sub) {
          throw new InvalidTokenError('Token has no `sub` claim.');
        }

        return {
          token,
          clientId: typeof payload['client_id'] === 'string' ? payload['client_id'] : (payload.sub as string),
          scopes: scopesFrom(payload),
          ...(payload.exp ? { expiresAt: payload.exp } : {}),
          extra: { sub: payload.sub, email: payload['email'] }
        };
      } catch (error) {
        if (error instanceof InvalidTokenError) throw error;
        throw new InvalidTokenError(
          error instanceof Error ? error.message : 'Access token could not be verified.'
        );
      }
    }
  };
}

/**
 * Local-only verifier so the MCP Inspector can drive tools without an OAuth
 * provider. config.ts refuses to start with this enabled against production or
 * off localhost - do not relax that guard.
 */
export function createDevVerifier(): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      return {
        token,
        clientId: 'dev-local',
        scopes: [],
        extra: { sub: 'dev-local' }
      };
    }
  };
}

/** Stable per-user key used to look up the linked MeraMonitor account. */
export function subjectFromAuth(auth: AuthInfo | undefined): string {
  const sub = auth?.extra?.['sub'];
  if (typeof sub === 'string' && sub.length > 0) return sub;
  if (auth?.clientId) return auth.clientId;
  throw new Error('Request carried no authenticated subject.');
}
