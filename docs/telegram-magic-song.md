# Telegram Magic Song workflow

This workflow lets Ken trigger Pancake Robot song generation from Telegram, CLI, UI, API, or a future autonomous agent.

The prior Telegram/OpenClaw implementation should be treated as reference code only. Pancake Robot does not depend on that app's domain code, naming, data model, or runtime behavior.

## What it does

- Accepts a free-text song theme from Telegram.
- Confirms which brand profile to apply.
- Runs the importable Magic pipeline service with a pre-generated song ID.
- Sends progress updates back to Telegram.
- Returns links to the song detail and release-kit preview.
- Stores workflow events in SQLite and `output/workflow-runs/<RUN_ID>.jsonl`.
- Stores the final workflow snapshot in SQLite and `output/workflow-runs/<RUN_ID>.json`.
- Persists pending Telegram theme/brand sessions in SQLite.
- Prevents duplicate Telegram callback taps from creating duplicate song runs.
- Preserves the old orchestrator Magic path as `npm run magic:legacy`.

## Required env vars

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
PUBLIC_APP_BASE_URL=http://localhost:3737
DEFAULT_BRAND_ID=default
TELEGRAM_MAGIC_MODE=human_review
```

`TELEGRAM_ALLOWED_USER_IDS` is a comma-separated allowlist of Telegram user IDs.

## Run the Telegram bot

```bash
npm run telegram
```

Then send the bot a message like:

```text
make me a song about a dinosaur who cannot reach the syrup
```

The bot will ask which brand profile to use before starting generation.

## Run Magic Song from CLI

Primary service path:

```bash
npm run magic -- "a dinosaur who cannot reach the syrup"
```

Optional brand-specific run:

```bash
npm run magic -- --brand pancake_robot "a dinosaur who cannot reach the syrup"
```

Legacy fallback path:

```bash
npm run magic:legacy -- "a dinosaur who cannot reach the syrup"
```

Workflow wrapper path:

```bash
npm run magic:workflow -- "a dinosaur who cannot reach the syrup"
```

## Inspect workflow runs

CLI:

```bash
npm run workflow:runs
npm run workflow:show -- MAGIC_RUN_ID
```

Standalone local debug UI:

```bash
npm run workflow:admin
```

Open:

```text
http://localhost:3747/workflow-runs
```

This debug UI intentionally runs separately from the main Pancake Robot web server for now.

## Current behavior

- Default mode is `human_review`.
- The workflow generates and scores the song through the importable Magic pipeline service.
- It can build release-kit / marketing assets when the Magic pipeline produces a release candidate.
- It does not submit to DistroKid.
- It does not publish social posts.
- It does not contact reviewers, bloggers, or radio outlets.

## No-regression strategy

The original Magic command behavior is preserved as a fallback:

```bash
npm run magic:legacy -- "theme"
```

The primary command now uses the service boundary:

```bash
npm run magic -- "theme"
```

The Telegram workflow also uses the same service boundary instead of spawning `src/orchestrator.js --magic` as a child process.

No-regression acceptance criteria:

```bash
npm run magic -- "theme"
npm run magic:workflow -- "theme"
npm run magic:legacy -- "theme"
npm run telegram
npm test
```

## Service boundary design

`src/services/magic-pipeline-service.js` is now the importable boundary for the Magic pipeline.

It handles:

- selected brand profile loading
- brand-profile cache clearing
- brand-isolated lazy loading of brand-sensitive agents
- queued Magic runs so concurrent Telegram requests do not mutate the active brand profile at the same time
- lyrics generation
- brand review
- metadata generation
- music generation
- release-selection scoring
- QA
- single regeneration attempt
- distribution package / marketing asset finalization for release candidates
- cost reporting
- result object returned to workflow/Telegram/CLI

## Remaining hardening candidates

The feature is now functionally complete for Telegram-triggered Magic Song generation. Remaining work is optional platform hardening:

- Fold standalone workflow debug UI into the main Pancake Robot web app.
- Add true queue/worker semantics if Telegram runs need to survive process restarts during generation.
- Make `autonomous` mode explicitly hand off to future release/social workflows once those lanes are ready.
