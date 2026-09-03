/**
 * Long-lived process entry point: local development, and the self-hosted
 * fallback if Vercel's limits prove unacceptable (handoff 3.3).
 *
 * Nothing here is Vercel-aware. The app itself is built by src/app.ts.
 */
import { buildApp, startDevIdentity } from './app.js';
import { startupWarnings } from './config.js';

async function start(): Promise<void> {
  const built = buildApp();
  await startDevIdentity(built);

  built.app.listen(built.config.port, () => {
    console.log(
      `MeraMonitor MCP listening on ${built.config.publicUrl.origin}/mcp\n` +
        `  backend: ${built.config.baseUrl}  (MM_ENV=${built.config.envName})\n` +
        `  auth:    ${built.config.authMode}\n` +
        `  state:   ${built.store?.isDurable ? 'Upstash Redis' : 'in-memory + client file'}`
    );
    for (const warning of startupWarnings(built.config)) {
      console.warn(`\n  !!  ${warning}`);
    }
  });
}

start().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
