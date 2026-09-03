/**
 * Vercel Function entry point (handoff 3.3).
 *
 * Express apps are themselves `(req, res)` handlers, so exporting the built app
 * is all Vercel's Node runtime needs. vercel.json rewrites every path here, so
 * `/mcp`, `/authorize`, `/token`, `/register`, `/login` and both discovery
 * documents are all served by the same function with their original paths.
 *
 * This imports the COMPILED output rather than ../src directly: `npm run build`
 * (the vercel.json buildCommand) runs tsc, and dist/** is traced into the
 * function bundle. That keeps the NodeNext module resolution the source is
 * written against out of the deployment builder's hands.
 *
 * Node.js runtime, not Edge - the code uses node:crypto, node:fs and axios.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../dist/app.js';

/**
 * Built once per instance and reused while it stays warm.
 *
 * assertConfigIsSafe runs inside buildApp, and on a fresh project it is SUPPOSED
 * to fail - Upstash Redis and MCP_PUBLIC_URL are added after the first deploy
 * creates the project. Letting that throw at module scope produces an
 * unexplained 500 on every route, so the failure is captured and served as a
 * 503 that names exactly what is missing.
 */
let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
let configError: string | undefined;

try {
  handler = buildApp().app as unknown as (req: IncomingMessage, res: ServerResponse) => void;
} catch (error) {
  configError = error instanceof Error ? error.message : String(error);
  console.error(configError);
}

export default function (req: IncomingMessage, res: ServerResponse): void {
  if (handler) {
    handler(req, res);
    return;
  }

  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify(
      {
        error: 'configuration_incomplete',
        message: configError,
        next_steps: [
          'Project -> Storage -> Marketplace -> Upstash Redis (injects UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)',
          'Project -> Settings -> Environment Variables: MM_ENV, MCP_AUTH_MODE, MM_LOGIN_DOMAIN, MCP_TOKEN_TTL_SECONDS, MM_MAX_SCREENSHOTS_PER_CALL, MCP_PUBLIC_URL',
          'MCP_PUBLIC_URL must exactly equal the final public domain, with no trailing slash',
          'Redeploy - these values are read at cold start and baked into OAuth discovery'
        ]
      },
      null,
      2
    )
  );
}
