# MeraMonitor MCP server — Vercel

Remote MCP server exposing MeraMonitor workforce analytics (screenshots, time tracker, time claims)
to Claude. Twelve tools across four areas, over a self-hosted OAuth 2.1 authorization server whose
credential check is delegated to MeraMonitor's own login.

This is the serverless port of the original persistent-process build. `src/server.ts` still runs it
as an ordinary Node process, so nothing here is a one-way door.

## Deploying

1. **Import this repo** into Vercel. No framework preset; `vercel.json` supplies the build.
2. **Add storage:** Project → Storage → Marketplace → **Upstash Redis**. This injects
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Note the region — it holds live
   credentials.
   *Not Vercel KV (no longer a first-party product) and not Vercel Global Config (its writes take
   "seconds" to propagate; an authorization code must be readable immediately after it is written).*
3. **Set environment variables:**
   ```
   MM_ENV=production
   MCP_AUTH_MODE=self-hosted
   MM_LOGIN_DOMAIN=app.mera.work
   MCP_TOKEN_TTL_SECONDS=28800
   MM_MAX_SCREENSHOTS_PER_CALL=4
   MCP_PUBLIC_URL=<the final public URL, no trailing slash>
   ```
4. **Domain.** `MCP_PUBLIC_URL` must **exactly** equal the final public domain — every OAuth
   endpoint is advertised from it. Set it, then **redeploy**; it is baked into discovery responses.
5. **Add the connector** in claude.ai: Settings → Connectors → Add custom connector →
   `https://<domain>/mcp`.

`GET /healthz` reports `stateBackend`, `stateDurable` and `redisReachable` — check it first when a
deployment misbehaves.

## What the port changed

| # | Change | Where |
|---|---|---|
| 3.1 | Five in-memory `Map`s and the JSON client file → Redis keys with TTLs. Periodic sweep deleted; Redis TTL replaces it. Authorization codes redeemed with `GETDEL` so concurrent redemptions cannot both succeed. | `src/auth/store.ts` |
| 3.2 | `sessionIdGenerator: undefined`, a fresh `McpServer` + transport per request, `transports` map and the `GET`/`DELETE /mcp` session routes deleted. | `src/app.ts` |
| 3.3 | `src/index.ts` split into `src/app.ts` (builds the app), `src/server.ts` (listens), `api/index.ts` (Vercel). `vercel.json` pins the Node runtime and `maxDuration`. | — |
| 3.4 | 3.5 MB response byte budget on `get_screenshots`; default per-call cap 10 → 4. | `src/tools/screenshots.ts` |
| 3.5 | Axios timeout 30s → 25s, below the 60s `maxDuration`. | `src/api/client.ts` |
| 3.6 | Redis credentials added; `assertConfigIsSafe` refuses to start without them on Vercel, and refuses a production deployment with no `MCP_PUBLIC_URL`. | `src/config.ts` |

Redis key layout:

| Key | Holds | TTL |
|---|---|---|
| `client:<client_id>` | registered OAuth client | **none** — if lost, every connector breaks and must be re-added |
| `pending:<txn>` | in-flight authorization request | 10 minutes |
| `code:<code>` | authorization code | 10 minutes, deleted on use (`GETDEL`) |
| `token:<access_token>` | issued token + bound MeraMonitor identity | `MCP_TOKEN_TTL_SECONDS` |
| `refresh:<refresh_token>` | pointer to its access token | token TTL + 30 days |

Without Redis credentials the store falls back to in-memory plus `MCP_CLIENTS_FILE`, exactly as the
pre-port build behaved. That path is for local development and the self-hosted fallback only —
start-up refuses it on Vercel.

## What stays imperfect on Vercel

1. **Full-size screenshot batches are capped** by the 4.5 MB response limit. The byte budget
   degrades gracefully — it returns what fits and names the skipped paths — but the limit is real
   and does not exist on a normal host.
2. **Cold starts** add latency to the first call after an idle period.
3. **MeraMonitor access tokens live in Upstash**, not only in server memory: a second third-party
   processor holding credentials to production employee data.
4. **Employee screenshots transit Vercel's infrastructure.** Unavoidable on any third-party host.

Items 3 and 4 are worth confirming against the SOC2/GDPR position.

## Things that look like bugs and are not

- `LiveTracking/AddLiveTrtackingAuditLogs` — the typo is in the real API path.
- Dates are `YYYY-MM-DDTHH:mm:ss` plus a **literal `Z` that is not a UTC marker**. The wall clock is
  local. Sending a genuine UTC instant shifts every report by the local offset. See
  `src/api/dates.ts`; `npm test` guards it.
- Casing is per endpoint, not per verb: `POST` bodies camelCase, most `GET` params PascalCase, but
  `Registration/GetAllUserListByOrganization` takes lowercase `organizationId`.
- All durations are int32 seconds.
- Four endpoints the product's frontend calls no longer exist in the live API
  (`TimeClaim/UpdateClaimStatus`, `TimeClaim/GetAllTimeClaims`,
  `CloudStorageScreenshots/GetMinutelyScreenShots`, `CloudStorageScreenshots/GetScreenshots`).
  This server deliberately avoids them.

## Safety properties — do not weaken

`assertConfigIsSafe` refuses to start on unsafe combinations. `get_screenshots` requires an explicit
non-empty `paths` list with no fetch-all option, caps the batch, defaults to thumbnails, and writes
every access to MeraMonitor's audit log. `submit_time_claim` is a dry run unless `confirm=true`, and
cannot approve, reject or delete. This server exposes real employee monitoring data.

## Local development

```bash
npm install
npm test            # 12 date/duration assertions
npm run typecheck
cp .env.example .env
npm run dev
```
