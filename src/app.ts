import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  mcpAuthRouter,
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

import { assertConfigIsSafe, hasRedis, loadConfig, type Config } from './config.js';
import { createJwtVerifier } from './auth/oauth.js';
import { loginWithDomain, type MeraMonitorIdentity } from './auth/meramonitor.js';
import { OAuthStore } from './auth/store.js';
import { MeraMonitorOAuthProvider, createLoginHandler } from './auth/provider.js';
import { createToolContext } from './tools/shared.js';
import { registerIdentityTools } from './tools/identity.js';
import { registerScreenshotTools } from './tools/screenshots.js';
import { registerTimeTrackerTools } from './tools/timetracker.js';
import { registerTimeClaimTools } from './tools/timeclaim.js';

/**
 * PORT NOTE (handoff 3.3): this file builds the configured Express app and
 * stops short of listen(), so the same app serves both deployment shapes:
 *   - api/index.ts   exports it as a Vercel Function
 *   - src/server.ts  calls listen() for local dev and the self-hosted fallback
 *
 * Keeping the second path is the escape hatch: if Vercel's limits prove
 * unacceptable, this code still runs as an ordinary Node process unchanged.
 */

export interface BuiltApp {
  app: Express;
  config: Config;
  store?: OAuthStore;
  /** Only used by the `none` auth mode; see startDevIdentity below. */
  setDevIdentity(identity: MeraMonitorIdentity): void;
}

export function buildApp(config: Config = loadConfig()): BuiltApp {
  assertConfigIsSafe(config);

  const toolContext = createToolContext(config);

  /**
   * PORT NOTE (handoff 3.2): one McpServer per request.
   *
   * Serverless gives no shared memory between invocations, so a long-lived
   * server object registered once at module scope would be rebuilt on every
   * cold start anyway and could not be relied on across them. Building it per
   * request is cheap (it only registers tool schemas) and is what makes the
   * stateless transport below correct.
   */
  function buildServer(): McpServer {
    const server = new McpServer(
      { name: 'meramonitor', version: '0.2.0' },
      {
        instructions:
          'MeraMonitor workforce analytics. You are already signed in - call whoami to see as whom. ' +
          'Use list_users to turn a person name into a userId. Screenshots are listed as hourly counts ' +
          'first; fetch actual images only for specific paths the user asks about.'
      }
    );
    registerIdentityTools(server, toolContext);
    registerScreenshotTools(server, toolContext);
    registerTimeTrackerTools(server, toolContext);
    registerTimeClaimTools(server, toolContext);
    return server;
  }

  const app = express();
  app.disable('x-powered-by');

  // The sign-in form posts urlencoded; MCP itself posts JSON.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '4mb' }));

  let verifier: OAuthTokenVerifier | undefined;
  let store: OAuthStore | undefined;

  if (config.authMode === 'self-hosted') {
    store = new OAuthStore(config);
    const provider = new MeraMonitorOAuthProvider(config, store);
    verifier = provider;

    // Our own credential-collection endpoint, referenced by the login form.
    app.post('/login', createLoginHandler(config, store));

    // Mounts /authorize, /token, /register, /revoke and both metadata documents.
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: config.publicUrl,
        baseUrl: config.publicUrl,
        resourceServerUrl: config.publicUrl,
        resourceName: 'MeraMonitor MCP',
        scopesSupported: config.oauthScopesSupported
      })
    );
  } else if (config.authMode === 'external') {
    verifier = createJwtVerifier(config);

    const oauthMetadata: OAuthMetadata = {
      issuer: config.oauthIssuerUrl!.toString(),
      authorization_endpoint: config.oauthAuthorizationEndpoint!.toString(),
      token_endpoint: config.oauthTokenEndpoint!.toString(),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: config.oauthScopesSupported,
      ...(config.oauthRegistrationEndpoint
        ? { registration_endpoint: config.oauthRegistrationEndpoint.toString() }
        : {})
    };

    app.use(
      mcpAuthMetadataRouter({
        oauthMetadata,
        resourceServerUrl: config.publicUrl,
        resourceName: 'MeraMonitor MCP',
        scopesSupported: config.oauthScopesSupported
      })
    );
  }

  /**
   * No-auth mode signs in once at start-up with credentials from the environment
   * and injects that identity into every request. Guarded to non-production by
   * assertConfigIsSafe, and only reachable on the self-hosted path.
   */
  let devIdentity: MeraMonitorIdentity | undefined;

  const authMiddleware =
    config.authMode === 'none'
      ? (req: Request, _res: Response, next: NextFunction) => {
          if (devIdentity) {
            req.auth = {
              token: 'dev',
              clientId: 'dev-local',
              scopes: [],
              extra: { sub: devIdentity.userId, identity: devIdentity }
            };
          }
          next();
        }
      : requireBearerAuth({
          verifier: verifier!,
          resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.publicUrl)
        });

  app.get('/healthz', async (_req, res) => {
    res.json({
      ok: true,
      environment: config.envName,
      auth: config.authMode,
      publicUrl: config.publicUrl.origin,
      serverless: config.isServerless,
      // The single most useful signal when debugging a deployment: whether OAuth
      // state can actually outlive this instance.
      stateBackend: hasRedis(config) ? 'upstash-redis' : 'in-memory',
      stateDurable: store ? store.isDurable : false,
      redisReachable: store ? await store.ping() : null
    });
  });

  // --- Streamable HTTP transport, stateless (handoff 3.2) --------------------
  //
  // `sessionIdGenerator: undefined` puts the SDK transport in stateless mode:
  // every POST carries everything needed to serve it, nothing is remembered
  // between requests, and there is no session map to lose on a cold start.
  //
  // The GET and DELETE /mcp routes are deliberately gone. They existed only to
  // resume and terminate sessions, and sessions no longer exist.
  app.post('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    // Free both when the response ends, however it ends. Without this a failed
    // request would leak a transport for the life of the warm instance.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  return {
    app,
    config,
    store,
    setDevIdentity(identity: MeraMonitorIdentity) {
      devIdentity = identity;
    }
  };
}

/**
 * Signs in the fixed identity used by `MCP_AUTH_MODE=none`. Separated from
 * buildApp so the serverless entry point never performs a network call at
 * module load.
 */
export async function startDevIdentity(built: BuiltApp): Promise<void> {
  if (built.config.authMode !== 'none') return;

  const email = process.env.MM_DEV_EMAIL;
  const password = process.env.MM_DEV_PASSWORD;
  const domain = process.env.MM_LOGIN_DOMAIN;
  if (!email || !password || !domain) {
    throw new Error(
      'Refusing to start:\n  - No-auth mode needs MM_DEV_EMAIL, MM_DEV_PASSWORD and MM_LOGIN_DOMAIN ' +
        'so the tools have an identity to act as.'
    );
  }

  const identity = await loginWithDomain(
    built.config.baseUrl,
    email,
    password,
    domain,
    built.config.apiTimeoutMs
  );
  built.setDevIdentity(identity);
  console.log(`Signed in as ${identity.fullName ?? identity.email} (${identity.roleName}).`);
}

export default buildApp;
