# Handoff — MeraMonitor MCP server on Vercel

Paste this to Claude Code at the start of a session, or keep it in the repo root and say
"read HANDOFF.md first".

---

## 1. What this project is

A remote MCP (Model Context Protocol) server exposing **MeraMonitor** — a workforce-analytics
product — to Claude, so its data can be reached conversationally instead of through the web UI.

**Stack:** TypeScript, Node 22, Express, `@modelcontextprotocol/sdk` 1.30.0, axios, zod 4,
`@upstash/redis`. Build is `tsc -p tsconfig.json`; there is no bundler.

**Twelve tools, four areas:**

| Area | Tools |
|---|---|
| Identity | `whoami`, `list_users` |
| Screenshots | `list_screenshot_hours`, `get_screenshots`, `list_users_with_screenshots` |
| Time tracker | `get_time_tracker_report`, `get_time_tracker_daily_breakdown`, `get_user_activity_apps` |
| Time claims | `get_claimable_time`, `list_time_claims`, `get_pending_claim_count`, `submit_time_claim` |

### How authentication works — read before changing anything

Two layers, one login.

**Layer 1 — Claude to this server.** This server *is* an OAuth 2.1 authorization server. It is not
a client of some other IdP. It serves its own `/authorize`, `/token`, `/register` and `/revoke`
plus both discovery documents, via the SDK's `mcpAuthRouter` with a custom `OAuthServerProvider`
(`src/auth/provider.ts`). PKCE (S256) required; dynamic client registration (RFC 7591) lets Claude
register itself.

**Layer 2 — this server to MeraMonitor.** The sign-in page collects MeraMonitor credentials and
validates them against `Login/LoginWithDomain`. The MeraMonitor token that comes back is bound to
the OAuth token issued to Claude, so every downstream call is made *as that person* and MeraMonitor
keeps enforcing their real role and permissions.

Consequences that constrain every change:

- **Passwords are never stored.** Used once at sign-in, never written down.
- **There is no refresh endpoint on the MeraMonitor backend.** A refresh succeeds only while the
  original MeraMonitor token still passes `Login/TokenValidity`. Do not invent a refresh mechanism.
- **The OAuth identity IS the MeraMonitor identity.** No separate account-linking step. Do not add one.

---

## 2. What has been done

The server was built and verified as a persistent Node process, then ported to Vercel serverless.
The port is complete, committed, and pushed to `main` at
`https://github.com/JatinMangla/meramonitor-mcp-server`.

Seven changes, because serverless shares no memory between requests:

| # | Change | Where |
|---|---|---|
| 3.1 | `OAuthStore` rewritten on `@upstash/redis`. Five in-memory `Map`s and the JSON client-registry file became Redis keys with TTLs. The `setInterval` sweep was **deleted** — Redis TTL replaces it. Authorization codes are redeemed with **`GETDEL`** so two concurrent redemptions cannot both succeed. Class shape and method names unchanged; every method is now `async`. | `src/auth/store.ts` |
| 3.2 | Stateless MCP transport: `sessionIdGenerator: undefined`, a fresh `McpServer` + transport **per request**, the `transports` map deleted, and `GET`/`DELETE /mcp` removed (they only managed sessions, which no longer exist). | `src/app.ts` |
| 3.3 | The old `src/index.ts` split three ways: `src/app.ts` builds the app, `src/server.ts` calls `listen()`, `api/index.ts` exports it to Vercel. | — |
| 3.4 | Response **byte budget** on `get_screenshots` (see §5). Default per-call cap lowered 10 → 4. | `src/tools/screenshots.ts` |
| 3.5 | Axios timeout 30s → 25s, below the 60s `maxDuration`. | `src/api/client.ts` |
| 3.6 | Redis credentials added; `assertConfigIsSafe` extended with three serverless guards. | `src/config.ts` |

### Redis key layout

| Key | Holds | TTL |
|---|---|---|
| `client:<client_id>` | registered OAuth client | **none** — if lost, every connector breaks and must be re-added |
| `pending:<txn>` | in-flight authorization request | 10 minutes |
| `code:<code>` | authorization code | 10 minutes, deleted on use (`GETDEL`) |
| `token:<access_token>` | issued token + bound MeraMonitor identity | `MCP_TOKEN_TTL_SECONDS` (default 28800) |
| `refresh:<refresh_token>` | pointer to its access token | token TTL + 30 days |

Without Redis credentials the store falls back to in-memory + `MCP_CLIENTS_FILE`, exactly as the
pre-port build behaved. That path exists for local dev and the self-hosted fallback only —
start-up **refuses** it on Vercel.

### Verified locally before handoff

Locally, against a real instance: 0 TypeScript errors; 12/12 date-and-duration assertions
(`npm test`); both discovery documents; `POST /mcp` with no token → 401 + `WWW-Authenticate`
pointing at resource metadata; `POST /register` issues a `client_id`; `GET /authorize` renders the
sign-in page with an opaque txn; unknown and replayed transactions → 400; `GET`/`DELETE /mcp` → 404;
the client registry surviving a genuinely fresh process; and all seven start-up guards refusing
their unsafe configurations.

### Verified ON Vercel (2026-09-04)

Live at `https://meramonitor-mcp-server-jatinmanglas-projects.vercel.app`, Upstash linked,
Deployment Protection off. `GET /healthz` reports `stateBackend: upstash-redis`,
`stateDurable: true`, `redisReachable: true`.

- **Cross-instance persistence — the §4 headline test — PASSES.** A client registered and an
  authorization transaction opened on one deployment both still resolved after a redeploy replaced
  the lambdas (`/authorize` → 200, `/login` → 401), while a fabricated transaction returned 400.
  The control matters: it proves the 401 was a genuine Redis hit, not a blanket response.
- Transactions are single-use: replaying a consumed `txn` returns 400 (`GETDEL`).
- Both discovery documents serve and advertise the correct host; `POST /mcp` with no token returns
  401 with a `WWW-Authenticate` pointing at reachable resource metadata; `GET`/`DELETE /mcp` → 404.
- Dynamic client registration issues a `client_id`.

Getting there took three fixes, all recorded in §5: the `functions.runtime` value, the `express`
framework preset, and `MCP_PUBLIC_URL` pointing at `app.mera.work` (the SPA) rather than at this
server.

### Still NOT verified

All of these need a real sign-in, so they could not be reached without credentials:

- **Single-use authorization codes.** The `pending:<txn>` equivalent is proven, but `code:<code>`
  itself has not been redeemed twice.
- **Payload budget.** `get_screenshots` with 4 full-size images must truncate, never 413.
- **Cold start** completing within `maxDuration` on the first call after idle.
- **End to end.** `whoami`, `list_users`, `list_screenshot_hours`, `get_time_tracker_report`, and
  `submit_time_claim` without `confirm` (dry run — must echo the payload and send nothing).

---

## 3. Deployment configuration

1. **Upstash Redis**, linked to the project, all environments. This injects
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` automatically — do not type them by hand.
   *Not Vercel KV (no longer first-party) and not Vercel Global Config (documented write latency of
   "seconds"; an authorization code must be readable immediately after it is written, so
   seconds-latency writes cause intermittent, very confusing login failures).*

2. **Six environment variables** (Settings → Environment Variables, all environments):
   ```
   MM_ENV=production
   MCP_AUTH_MODE=self-hosted
   MM_LOGIN_DOMAIN=app.mera.work
   MCP_TOKEN_TTL_SECONDS=28800
   MM_MAX_SCREENSHOTS_PER_CALL=4
   MCP_PUBLIC_URL=https://<production domain, no trailing slash>
   ```

3. **`MCP_PUBLIC_URL` must exactly equal the final public domain.** Every OAuth endpoint is
   advertised from it; a mismatch breaks discovery in a way that is genuinely painful to debug.
   Change the domain later and you must change this and redeploy. It was originally set to
   `https://app.mera.work/auth`, which is the MeraMonitor SPA on Azure, not this server — discovery
   duly advertised an `/authorize`, `/token` and `/register` that do not exist there.

4. **Environment variables bind to a deployment when that deployment is created.** Changing one —
   or linking a storage integration — does nothing until a *new* deployment exists.

5. **Check `GET /healthz`.** It reports `stateBackend`, `stateDurable` and `redisReachable` — the
   fastest signal when a deployment misbehaves. A **503** with a JSON body listing next steps means
   a start-up guard fired and is telling you exactly what is missing; that is by design, not a bug.
   Note the guard collects *every* failure, so a single bullet means everything else passed.

6. **Add the connector** in claude.ai: Settings → Connectors → Add custom connector →
   `https://<domain>/mcp`. If you get a Vercel login wall instead of the app, check Settings →
   Deployment Protection — claude.ai must be able to reach it unauthenticated.

---

## 4. Verification checklist

Every check under "Verified locally before handoff" must still pass — that is the regression suite.
Then the Vercel-specific ones:

- [x] **Cross-instance persistence.** Register a client, force a new instance (redeploy, or wait out
      the idle timeout), confirm the same `client_id` still authenticates. **This is the test that
      proves the state port actually worked** — everything else can pass by accident through
      in-memory reuse inside one warm instance. Include a control that never existed, or a blanket
      response will read as a pass.
- [x] **Single-use transactions.** Replay a consumed `txn`; the second must fail with 400.
- [ ] **Payload budget.** Call `get_screenshots` with 4 full-size images. Must return a truncation
      notice listing skipped paths — never a 413.
- [ ] **Cold start.** First call after idle completes within `maxDuration`.
- [ ] **Single-use codes.** Redeem the same authorization code twice; the second must fail.
- [ ] **End to end.** Add the connector, sign in, run `whoami`, `list_users`,
      `list_screenshot_hours`, `get_time_tracker_report`, and `submit_time_claim` *without*
      `confirm` (dry run — must echo the payload and send nothing).

---

## 5. What to be careful about

### Do not weaken the safety guards

This server exposes real employee monitoring data. Deliberate, keep all of it:

- `assertConfigIsSafe` (`src/config.ts`) refuses start-up on: no-auth against production;
  self-hosted OAuth on a non-HTTPS public URL; token TTL under 300s; **on Vercel**, missing Redis
  credentials; a production deployment with no `MCP_PUBLIC_URL`; an axios timeout ≥ `maxDuration`.
- `get_screenshots` requires an explicit non-empty `paths` list with **no fetch-all option**, caps
  the batch, defaults to thumbnails, and writes every access to MeraMonitor's audit log.
- `submit_time_claim` is a dry run unless `confirm=true`, and cannot approve, reject or delete.

### The 4.5 MB response cap is real

A Vercel Function's response body is hard-capped at 4.5 MB; exceeding it is a
`413 FUNCTION_PAYLOAD_TOO_LARGE`, which the MCP client sees as an opaque transport failure rather
than a tool error it can explain. `get_screenshots` accumulates base64 length as images are
appended and stops at **3.5 MB** (`RESPONSE_BYTE_BUDGET`), returning what fits plus a note naming
the skipped paths. Do not remove this to "fix" truncation — truncating is the fix. It is a real
functional limit that does not exist on a normal host; say so plainly if asked.

### The MeraMonitor API has drifted — trust the code, not the field names you would expect

These four endpoints **no longer exist** in the live API. The server deliberately avoids them; do
not "helpfully" add them back:

- `TimeClaim/UpdateClaimStatus`
- `TimeClaim/GetAllTimeClaims`
- `CloudStorageScreenshots/GetMinutelyScreenShots`
- `CloudStorageScreenshots/GetScreenshots`

Quirks that are correct as written, **not bugs to fix**:

- **Casing is per endpoint, not per verb.** `POST` bodies are camelCase (`organizationId`); most
  `GET` query params are PascalCase (`OrganizationId`) — but
  `Registration/GetAllUserListByOrganization` takes lowercase `organizationId`. Getting this wrong
  returns an empty `200`, not an error.
- **`LiveTracking/AddLiveTrtackingAuditLogs`** — the typo is in the real API path. Keep it.
- **Dates are `YYYY-MM-DDTHH:mm:ss` followed by a literal `Z` that is NOT a UTC marker.** The wall
  clock is local; the SPA produces these with dayjs `format("YYYY-MM-DDTHH:mm:ss[Z]")` where `[Z]`
  is an escaped literal. Sending a genuine UTC instant shifts every report by the local offset. See
  the comment at the top of `src/api/dates.ts`; `npm test` guards it.
- **All durations are int32 seconds.**
- **The `domain` in `Login/LoginWithDomain` is the tenant's white-label HOST, not an email domain.**
  `app.mera.work` signs in; `meramonitor.com` is rejected. The SPA derives it from
  `window.location.hostname` (localhost falls back to `dev.mera.work`), so it is whatever host
  people reach MeraMonitor on — which means it changes if the front-end domain changes, and
  `MM_LOGIN_DOMAIN` must change with it. Verified by sign-in 2026-09-04. Note the API checks the
  email before the domain, so probing with a non-existent address cannot tell you the right value:
  both a correct and an incorrect domain return the same "not associated with your organization".
- `advanceFilter` wants `""` for unset, not `"all"` — sending `"all"` returns nothing.

### Serverless invariants

- No module-scope mutable state that a request depends on. Anything that must outlive a request
  goes in Redis.
- No `setInterval`/`setTimeout` background work — there is no process to run it.
- The filesystem is read-only and ephemeral. `MCP_CLIENTS_FILE` is self-hosted-path only.
- Node runtime, not Edge — the code uses `node:crypto`, `node:fs` and axios.
- Do **not** put a `runtime` key under `functions` in `vercel.json`. That field is for community
  runtimes and expects `name@version`; `"nodejs22.x"` there produces
  `Error: Function Runtimes must have a valid version`. This already broke one build. The Node
  major comes from `package.json` → `engines.node`.
- **`"framework": null` in `vercel.json` is load-bearing.** Vercel auto-detected the project as the
  `express` preset, which deploys a long-lived Express server by searching the output directory for
  `app`/`index`/`server.{js,ts}` — and fails the build with `No entrypoint found in output
  directory: "public"`. That preset is the pre-port architecture; this project is the "Other" shape
  (one Node Function at `api/index.ts`, every path rewritten to it, `public/` holding only a static
  landing page). It is pinned in `vercel.json` rather than the dashboard so it cannot drift back.
  This broke the second build.
- **"Redeploy" rebuilds the original deployment's commit, not the branch head.** Redeploying to pick
  up a fix silently rebuilds the same broken source — it cost one confusing round trip here. Push a
  commit instead, unless the newest deployment is already the commit you want.

### Keep the self-hosted path working

`src/server.ts` runs the same app as an ordinary Node process. It is the escape hatch if Vercel's
limits prove unacceptable. Do not let it rot — changes should work both ways.

---

## 6. What stays imperfect on Vercel

State these rather than discovering them later:

1. **Full-size screenshot batches are capped** by the 4.5 MB response limit. Mitigated by the byte
   budget, not removed.
2. **Cold starts** add latency to the first call after idle.
3. **MeraMonitor access tokens live in Upstash**, not only in server memory — a second third-party
   processor holding credentials to production employee data.
4. **Employee screenshots transit Vercel's infrastructure.** Unavoidable on any third-party host.

Items 3 and 4 are worth confirming against the SOC2/GDPR position; there is an active compliance
workstream and the team has already been told and chose to proceed. Mention once, do not belabour.

---

## 7. Working agreement

- Run `npm run typecheck` and `npm test` before claiming anything works.
- `npm run dev` runs it locally; `.env.example` documents every key.
- Reproduce a bug before fixing it; if you cannot, say so rather than guessing.
- When a fix touches auth, screenshots, or the date helpers, re-run the §4 checklist — those three
  are where a plausible-looking change does quiet damage.
- Say plainly when something is a platform limit rather than a defect.
