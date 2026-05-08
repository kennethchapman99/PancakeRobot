# Telegram Magic Song workflow

This branch adds a reusable Magic Song workflow surface that can be triggered from Telegram, CLI, UI, API, or a future autonomous agent.

The prior Telegram/OpenClaw implementation should be treated as reference code only. Pancake Robot should not depend on that app's domain code, naming, data model, or runtime behavior.

## What it does

- Accepts a free-text song theme from Telegram.
- Confirms which brand profile to apply.
- Runs the existing `src/orchestrator.js --magic` pipeline with a pre-generated song ID.
- Sends progress updates back to Telegram.
- Returns links to the song detail and release-kit preview.
- Stores workflow events in `output/workflow-runs/<RUN_ID>.jsonl`.
- Stores the final workflow snapshot in `output/workflow-runs/<RUN_ID>.json`.

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

## Run the workflow directly

```bash
npm run magic:workflow -- "a dinosaur who cannot reach the syrup"
```

## Current behavior

- Default mode is `human_review`.
- The workflow generates and scores the song through the existing Magic pipeline.
- It can build release-kit / marketing assets when the existing Magic pipeline does so.
- It does not submit to DistroKid.
- It does not publish social posts.
- It does not contact reviewers, bloggers, or radio outlets.

## No-regression strategy

The existing Magic pipeline is the production behavior. This branch protects that behavior by adding a wrapper around the current CLI path first instead of changing generation, scoring, metadata, audio, or release-kit internals in the same PR.

This is intentional sequencing:

1. Add a stable workflow contract.
2. Add Telegram as an adapter to that contract.
3. Prove the existing Magic pipeline still runs the same way.
4. Refactor orchestrator internals into direct function calls only after the workflow boundary is stable.

No-regression acceptance criteria:

```bash
npm run magic -- "theme"
npm run magic:workflow -- "theme"
npm run telegram
```

The original Magic command must continue to work. The workflow path should add Telegram/API-friendly progress and result handling without changing song generation behavior.

## Implementation notes

This first slice wraps the existing Magic pipeline to avoid behavior drift. The wrapper gives Telegram, API, UI, and future agents one stable workflow contract while leaving the existing orchestrator behavior intact.

Next hardening steps:

- Move Magic pipeline internals from `src/orchestrator.js` into importable services while preserving the current CLI contract.
- Persist Telegram sessions instead of using in-memory state.
- Add a workflow-runs database table and admin/debug UI.
- Add idempotency keys per Telegram request.
- Split `human_review` and `autonomous` behavior more explicitly after the workflow boundary is stable.
