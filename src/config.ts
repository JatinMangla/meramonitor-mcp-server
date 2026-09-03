/**
 * Environment configuration and start-up safety guards.
 *
 * Every value here comes from the environment; nothing is hard-coded to a
 * secret. See .env.example for the documented keys.
 */

import { DEFAULT_TIMEOUT_MS } from './api/client.js';

export type MeraMonitorEnvName = 'dev' | 'qa' | 'production';

/**
 * How claude.ai (or any MCP client) authenticates to this server.
 *   self-hosted - this server is its own OAuth 2.1 authorization server and
 *                 checks credentials against MeraMonitor's login. The default.
 *   external    - tokens are issued by a third-party IdP and validated by JWKS.
 *   none        - no authentication at all. Local testing only.
 */
export type AuthMode = 'self-hosted' | 'external' | 'none';

const BASE_URLS: Record<MeraMonitorEnvName, string> = {
  dev: 'https://devapi.meramonitor.com/api/v1',
  qa: 'https://qaapi.meramonitor.com/api/v1',
  production: 'https://api.meramonitor.com/api/v1'
};

export interface Config {
  envName: MeraMonitorEnvName;
  baseUrl: string;
  /** Public origin this server is reachable at, e.g. https://mcp.example.com */
  publicUrl: URL;
  port: number;
  authMode: AuthMode;
  /** How long an issued access token lives, in seconds. */
  tokenTtlSeconds: number;
  /**
   * Where registered OAuth clients persist on the SELF-HOSTED path only.
   * Unused on Vercel: the filesystem there is read-only and ephemeral, so the
   * client registry lives in Redis instead (handoff 3.1 / 3.6).
   */
  clientsFile: string;
  /** Upstash Redis REST endpoint, injected by the Vercel Marketplace integration. */
  redisUrl?: string;
  redisToken?: string;
  /** True when running as a Vercel Function rather than a long-lived process. */
  isServerless: boolean;
  /** external mode only. */
  oauthIssuerUrl?: URL;
  oauthJwksUrl?: URL;
  oauthAudience?: string;
  oauthAuthorizationEndpoint?: URL;
  oauthTokenEndpoint?: URL;
  oauthRegistrationEndpoint?: URL;
  oauthScopesSupported: string[];
  /** Pre-fills the domain field on the sign-in form. */
  defaultLoginDomain?: string;
  /** Optional PortalIntegrationApi machine-to-machine credentials. */
  portalApiKey?: string;
  portalClientId?: string;
  portalClientSecret?: string;
  /** Hard cap on how many screenshot images one call may return. */
  maxScreenshotsPerCall: number;
  /** Axios timeout for MeraMonitor calls; must stay below vercel.json maxDuration. */
  apiTimeoutMs: number;
}

function optionalUrl(raw: string | undefined, key: string): URL | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${key} is not a valid URL: ${raw}`);
  }
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveAuthMode(env: NodeJS.ProcessEnv): AuthMode {
  if (env.MCP_DEV_NO_AUTH === 'true') return 'none';
  const raw = env.MCP_AUTH_MODE;
  if (raw === 'external' || raw === 'self-hosted' || raw === 'none') return raw;
  if (raw !== undefined) {
    throw new Error(`MCP_AUTH_MODE must be self-hosted|external|none, got: ${raw}`);
  }
  return 'self-hosted';
}

/**
 * On Vercel, MCP_PUBLIC_URL is authoritative but VERCEL_URL is a usable
 * fallback for preview deployments, where the hostname is not known until the
 * deployment exists. Production MUST set MCP_PUBLIC_URL explicitly - see the
 * guard in assertConfigIsSafe.
 */
function resolvePublicUrl(env: NodeJS.ProcessEnv, port: number): URL {
  const explicit = optionalUrl(env.MCP_PUBLIC_URL, 'MCP_PUBLIC_URL');
  if (explicit) return explicit;
  if (env.VERCEL_URL) return new URL(`https://${env.VERCEL_URL}`);
  return new URL(`http://localhost:${port}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const envName = (env.MM_ENV ?? 'production') as MeraMonitorEnvName;
  if (!(envName in BASE_URLS)) {
    throw new Error(`MM_ENV must be one of dev|qa|production, got: ${envName}`);
  }

  const port = parseIntOr(env.PORT, 3000);

  return {
    envName,
    baseUrl: env.MM_API_BASE_URL ?? BASE_URLS[envName],
    publicUrl: resolvePublicUrl(env, port),
    port,
    authMode: resolveAuthMode(env),
    tokenTtlSeconds: parseIntOr(env.MCP_TOKEN_TTL_SECONDS, 8 * 60 * 60),
    clientsFile: env.MCP_CLIENTS_FILE ?? './data/oauth-clients.json',
    redisUrl: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL,
    redisToken: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN,
    isServerless: Boolean(env.VERCEL),
    oauthIssuerUrl: optionalUrl(env.OAUTH_ISSUER_URL, 'OAUTH_ISSUER_URL'),
    oauthJwksUrl: optionalUrl(env.OAUTH_JWKS_URL, 'OAUTH_JWKS_URL'),
    oauthAudience: env.OAUTH_AUDIENCE,
    oauthAuthorizationEndpoint: optionalUrl(
      env.OAUTH_AUTHORIZATION_ENDPOINT,
      'OAUTH_AUTHORIZATION_ENDPOINT'
    ),
    oauthTokenEndpoint: optionalUrl(env.OAUTH_TOKEN_ENDPOINT, 'OAUTH_TOKEN_ENDPOINT'),
    oauthRegistrationEndpoint: optionalUrl(
      env.OAUTH_REGISTRATION_ENDPOINT,
      'OAUTH_REGISTRATION_ENDPOINT'
    ),
    oauthScopesSupported: (env.OAUTH_SCOPES ?? 'mcp')
      .split(/[,\s]+/)
      .filter(Boolean),
    defaultLoginDomain: env.MM_LOGIN_DOMAIN,
    portalApiKey: env.MM_PORTAL_API_KEY,
    portalClientId: env.MM_PORTAL_CLIENT_ID,
    portalClientSecret: env.MM_PORTAL_CLIENT_SECRET,
    // Lowered from 10 to 4 for the 4.5 MB Vercel response cap (handoff 3.4).
    maxScreenshotsPerCall: parseIntOr(env.MM_MAX_SCREENSHOTS_PER_CALL, 4),
    apiTimeoutMs: parseIntOr(env.MM_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
}

/** True when this config has usable Upstash Redis credentials. */
export function hasRedis(config: Config): boolean {
  return Boolean(config.redisUrl && config.redisToken);
}

/**
 * Fails start-up on configurations that would quietly expose production data.
 * Called before the app is built - never downgrade these to warnings.
 */
export function assertConfigIsSafe(config: Config): void {
  const problems: string[] = [];
  const looksLikeProduction =
    config.envName === 'production' || /(^|\/\/)api\.meramonitor\.com/.test(config.baseUrl);
  const isLocal =
    config.publicUrl.hostname === 'localhost' || config.publicUrl.hostname === '127.0.0.1';

  if (config.authMode === 'none' && looksLikeProduction) {
    problems.push(
      'Authentication is disabled but the backend is production. ' +
        'Set MM_ENV=dev for unauthenticated local testing, or use MCP_AUTH_MODE=self-hosted.'
    );
  }

  // Credentials are typed into this server's own login form, so plaintext
  // transport off-box would expose them directly.
  if (config.authMode === 'self-hosted' && config.publicUrl.protocol !== 'https:' && !isLocal) {
    problems.push(
      `MCP_PUBLIC_URL is ${config.publicUrl.origin}, but the sign-in form collects passwords. ` +
        'Serve it over HTTPS (terminate TLS at your reverse proxy) before exposing it.'
    );
  }

  if (config.authMode === 'external') {
    if (!config.oauthJwksUrl) problems.push('OAUTH_JWKS_URL is required when MCP_AUTH_MODE=external.');
    if (!config.oauthIssuerUrl) problems.push('OAUTH_ISSUER_URL is required when MCP_AUTH_MODE=external.');
    if (!config.oauthAuthorizationEndpoint || !config.oauthTokenEndpoint) {
      problems.push(
        'OAUTH_AUTHORIZATION_ENDPOINT and OAUTH_TOKEN_ENDPOINT are required when MCP_AUTH_MODE=external.'
      );
    }
  }

  if (config.tokenTtlSeconds < 300) {
    problems.push(`MCP_TOKEN_TTL_SECONDS is ${config.tokenTtlSeconds}; use at least 300.`);
  }

  // --- serverless-only guards (handoff 3.6) ---------------------------------
  //
  // Serverless has no shared memory between requests, so an in-memory OAuth
  // store would hand out a token one instance could not verify. Fail here, at
  // deploy time, rather than on someone's first sign-in.
  if (config.isServerless && config.authMode === 'self-hosted' && !hasRedis(config)) {
    problems.push(
      'Running on Vercel with MCP_AUTH_MODE=self-hosted but no Redis credentials. ' +
        'Add Upstash Redis (Project -> Storage -> Marketplace -> Upstash) so that ' +
        'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set. Without it, OAuth ' +
        'state cannot survive between function invocations and sign-in will fail intermittently.'
    );
  }

  // Every OAuth endpoint is advertised relative to publicUrl. On a production
  // deployment VERCEL_URL is a per-deployment hostname, not the stable domain,
  // so discovery would advertise a URL that changes on every deploy.
  if (config.isServerless && process.env.VERCEL_ENV === 'production' && !process.env.MCP_PUBLIC_URL) {
    problems.push(
      'MCP_PUBLIC_URL is not set on a production deployment. It must exactly equal the ' +
        'final public domain (no trailing slash) because OAuth discovery is advertised from it.'
    );
  }

  if (config.apiTimeoutMs >= 60_000) {
    problems.push(
      `MM_API_TIMEOUT_MS is ${config.apiTimeoutMs}ms, at or above the 60s function maxDuration. ` +
        'Lower it so a slow backend returns a tool error instead of FUNCTION_INVOCATION_TIMEOUT.'
    );
  }

  if (problems.length > 0) {
    throw new Error(`Refusing to start:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Non-fatal warnings printed at start-up. */
export function startupWarnings(config: Config): string[] {
  const warnings: string[] = [];
  const isLocal =
    config.publicUrl.hostname === 'localhost' || config.publicUrl.hostname === '127.0.0.1';

  if (config.authMode === 'none' && !isLocal) {
    warnings.push(
      `NO AUTHENTICATION on a public URL (${config.publicUrl.origin}).\n` +
        `    Anyone with this URL can reach the tools against ${config.envName}.\n` +
        '    Fine for a short test; never do this on production.'
    );
  }

  if (config.authMode === 'self-hosted' && isLocal) {
    warnings.push(
      'MCP_PUBLIC_URL is localhost, so claude.ai cannot reach this server.\n' +
        '    Set it to the public HTTPS URL before adding the connector.'
    );
  }

  if (config.authMode !== 'none') {
    warnings.push(
      hasRedis(config)
        ? 'OAuth state is in Upstash Redis: tokens and registered clients survive a restart.\n' +
            '    Note that live MeraMonitor access tokens are held there, not only in memory.'
        : 'Issued tokens are held in memory: restarting makes people sign in again.\n' +
            `    Registered clients do persist (${config.clientsFile}), so connectors survive a restart.`
    );
  }

  return warnings;
}
