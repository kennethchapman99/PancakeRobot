# Browsy ↔ Magic Release Recording Management

Pancake Robot owns the release/business/payload context. Browsy owns the browser
recorder, auth profile, selectors, replay, artifacts, and the workflow contract.
This integration lets the Release Cockpit *initiate, manage, import, validate,*
and *consume* Browsy-recorded browser automations for the authenticated steps of
the release pipeline (DistroKid submit, HyperFollow capture/enrich, platform link
harvest).

No DistroKid selectors or DistroKid-specific browser automation live in Pancake
Robot. Pancake only decides *what* workflow it wants Browsy to record and hands
over canonical payload/spec data.

## Mental model

1. A Magic Release campaign has Browsy-owned tasks (`owner: 'browsy'`), each with a
   `source_workflow_id` (e.g. `distrokid-single-submit`).
2. For each Browsy task, Pancake builds a **recording spec** (tabs, payload schema,
   file bindings, expected outputs, human checkpoints) from the release.
3. The operator drives the Browsy **recording lifecycle** from the cockpit:
   start → launch recorder → record in the real browser → stop → import.
4. Import publishes a Browsy **workflow contract**. Pancake evaluates contract
   **completeness**. Only a complete contract makes the task's live run runnable.
5. Live automation runs through Browsy's HTTP run API. It still stops at the
   mandatory human submit gate (`distrokid_final_submit_approval`, owner `ken`).

## No fake success

- A live run first fetches the published workflow contract.
- If Browsy is **unreachable** → result status `not_configured` (blocked). No run.
- If the contract is **missing or scaffold-only** → result status
  `contract_not_ready`, task set to `needs_ken` with suggested action
  "Record/import Browsy workflow first". No run.
- Dry-run (`PANCAKE_BROWSY_DRY_RUN=true` or explicit preview) is clearly marked
  `dry_run_passed` and is **not** gated.

## Auth: persistent profile + preflight gate

Google rejects OAuth sign-in inside a Playwright-controlled, unauthenticated
browser ("Couldn't sign you in — This browser or app may not be secure"). The fix
is a **stable persistent Chrome profile** the operator signs into once, plus an
**auth preflight** that blocks recording before it ever lands on the rejection.

**Persistent profile path** (stable across launches, app/workflow-scoped):

```
<browsy>/output/auth-profiles/pancake-robot/distrokid/user-data
<browsy>/output/auth-profiles/pancake-robot/distrokid/storageState.json
```

The profile id is `distrokid` (was `distrokid-main`); combined with the Browsy
appId `pancake-robot` it yields the path above. Browsy launches it with a **real
installed Chrome channel** (`channel: 'chrome'`) and **no anti-detection flags** —
the bundled-Chromium + `--disable-blink-features=AutomationControlled` +
`navigator.webdriver` spoofing path that tripped Google's check has been removed
(`browsy/src/core/auth.mjs`, `playwright-recording-runtime.mjs`).

**Preflight rules are app-provided and generic.** Browsy hosts a small generic
evaluator (`browsy/src/core/auth-preflight.mjs`); Pancake passes the rules in the
recording spec's `recordingSetup.authPreflight`. No DistroKid/Google logic lives
in the Browsy runtime. Default rules treat these as not-authenticated: final URL
contains `accounts.google.com` / `/signin` / `/login`; page text contains
"couldn't sign you in" or "this browser or app may not be secure" (the latter →
code `auth_rejected`).

**Gate behavior.** Before opening the recorder, Pancake runs a preflight against
the auth-required target in the *same* persistent profile. If it comes back
not-authenticated, the recorder does **not** launch — the recording row is set to
`auth_required` (or `auth_rejected`) and the cockpit shows "DistroKid
authentication is required. Open Auth Browser first." The operator clicks **Open
Auth Browser** → signs in once → **Verify Auth** → **Start Recording**. An
*unreachable* preflight does not block (the launch itself surfaces the real error).

Sample success / failure preflight responses (`POST /api/auth-profiles/preflight`,
both HTTP 200 — `ok` here means "the preflight ran", `preflight.ok` is the verdict):

```jsonc
// authenticated
{ "ok": true, "preflight": {
  "mode": "auth_preflight", "ok": true, "code": "authenticated",
  "channel": "chrome", "authProfileId": "distrokid", "appId": "pancake-robot",
  "userDataDir": ".../output/auth-profiles/pancake-robot/distrokid/user-data",
  "targetUrl": "https://distrokid.com/new/", "finalUrl": "https://distrokid.com/new/",
  "message": "Authenticated session detected — preflight passed." } }

// not authenticated (Google rejected the automation browser)
{ "ok": true, "preflight": {
  "mode": "auth_preflight", "ok": false, "code": "auth_required",
  "channel": "chrome", "authProfileId": "distrokid",
  "targetUrl": "https://distrokid.com/new/",
  "finalUrl": "https://accounts.google.com/v3/signin/rejected",
  "message": "Sign-in was rejected in the automation browser ..." } }
```

The preflight response never includes cookies, tokens, or page body text — only
the final URL, title, and the generic verdict.

## Components

| Concern | File |
| --- | --- |
| Recording lifecycle HTTP client | `src/shared/browsy-client.js` |
| Contract completeness evaluation | `evaluateBrowsyContractCompleteness` in `browsy-client.js` |
| Recording spec + lifecycle + view model | `src/shared/magic-release-browsy-recordings.js` |
| Durable recording state | `release_browsy_recordings` table in `src/shared/db.js` |
| Live-run contract gate | `runBrowsyWorkflow` in `src/shared/magic-release.js` |
| Cockpit view model wiring | `summarizeMagicReleaseBrowsyRecordings` → `release-cockpit.js` |
| Cockpit UI | "Browsy Recording Management" section in `src/web/views/releases/detail.ejs` |
| HTTP routes | `src/web/server.js` |

## HTTP routes (cockpit actions)

Base: `/releases/:type/:id/magic-release`

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/recordings/start` (body `task_key`) | Start a Browsy recording session for a task (preflight-gated) |
| POST | `/recordings/auth-setup` (body `task_key`) | Open Auth Browser — persistent profile, sign in once |
| POST | `/recordings/verify-auth` (body `task_key`) | Verify Auth — run a preflight, report signed-in / not |
| POST | `/recordings/:recordingId/launch` | Launch the recorder browser (preflight-gated) |
| POST | `/recordings/:recordingId/stop` | Stop the recording |
| POST | `/recordings/:recordingId/import` (body `overwrite`) | Import/replace the published workflow contract |
| POST | `/recordings/refresh-contract` (body `task_key`) | Re-fetch + re-evaluate the published contract |
| GET | `/recordings` | List recordings for the campaign (JSON) |
| GET | `/recordings/contract?workflow_id=…` or `?recording_session_id=…` | Fetch a contract (JSON) |
| POST | `/tasks/:taskKey/run` (body `dry_run`) | Run preview (`true`) or live (`false`) — live is gated |

All POST routes follow the form-POST + 303 redirect convention, with a JSON
branch when the request prefers JSON.

## Browsy API endpoints consumed

- `POST /api/auth-profiles/prepare` (Open Auth Browser — persistent profile)
- `POST /api/auth-profiles/preflight` (auth preflight verdict)
- `POST /api/recordings/start`
- `POST /api/recordings/:id/start` (launch recorder)
- `POST /api/recordings/:id/stop`
- `POST /api/recordings/:id/import`
- `GET  /api/recordings/:id/contract`
- `GET  /api/apps/:appId/workflows/:workflowId/contract`
- `POST /api/apps/:appId/workflows/:workflowId/runs` + `GET /api/runs/:runId` (run/poll)

## Environment

- `BROWSY_BASE_URL` / `PANCAKE_BROWSY_BASE_URL` (default `http://localhost:3001`)
- `PANCAKE_BROWSY_APP_ID` (default `pancake-robot`)
- `PANCAKE_BROWSY_DRY_RUN` (`true` forces dry-run; unset = live where reachable)
- `PANCAKE_BROWSY_POLL_INTERVAL_MS`, `PANCAKE_BROWSY_TIMEOUT_MS`

Start the Browsy API server: `cd /Users/kchapman/browsy && npm run api`.

## Contract completeness checks

`evaluateBrowsyContractCompleteness(contract, workflowId)` returns
`{ ready, severity, checks[], summary }`. Severity is one of `ready`, `incomplete`,
`missing`, `error`. For DistroKid submit workflows it requires: a run endpoint,
recorded tabs and steps, `album` + `tracks` required payload fields, at least one
file-upload binding, at least one human approval checkpoint, and an authenticated
DistroKid tab/profile. HyperFollow and link-harvest workflows have their own checks.
A scaffold-only contract (empty tabs/steps) is never reported ready.

## Tests

Run on the volta-pinned Node (22.x). The canvas native module breaks on Node 24.

```
./bin/pancakerobot test -- test/magic-release-browsy-recordings.test.js test/magic-release-browsy-http.test.js test/magic-release-browsy-auth-preflight.test.js
```

Coverage: spec builder, contract completeness, view model (empty + ready),
full record→import lifecycle, live-run gating on scaffold-only contracts,
contract refresh, unsupported-workflow rejection, and **auth preflight**
(authenticated target passes; Google-rejected/`/signin`/`/login` return
not-authenticated; HTTP relay normalization; unreachable Browsy is not
fabricated as authenticated).

Browsy side (run in the Browsy repo): `npm run acceptance:auth-preflight`
(pure rule evaluator) and `npm run acceptance:recording-persistent-profile`
(real-browser preflight endpoint + stable profile path + no body-text leak).

## Manual verification (no real DistroKid)

1. Start Browsy API (`npm run api` in the Browsy repo).
2. Create a Magic Release campaign for a test single.
3. In the cockpit's "Browsy Recording Management" section, click **Start Recording
   Setup** for the DistroKid submit task, then **Launch Recorder**.
4. Record against a local/staging target (do **not** use real DistroKid yet),
   **Stop**, then **Import / Replace**.
5. Confirm the task badge flips toward "ready" once the contract is complete, and
   that **Run Live** is disabled until then.
6. Use **Run Preview** to confirm a clearly-marked `dry_run_passed` result.
