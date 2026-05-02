# Marketing workflow phases

This plan defines the operating sequence for the marketing system. The system must fail closed: no fake target data, no invented outreach records, and no campaign execution before setup and approvals are complete.

## Source of truth rules

- Brand, artist, audience, distribution, visual identity, and positioning come from `config/brand-profile.json` through `src/shared/marketing-context.js`.
- Songs and release links come from the local SQLite song catalog through `src/shared/db.js`.
- Playlist, influencer, blogger, radio, and community targets come from real sourced research records only.
- A marketing target is invalid unless it has `name`, `type`, and `source_url`.
- Campaigns are generated from approved targets only.
- Gmail and posting automation must start as dry-run before any live sending or publishing.

## Phase 1 — Account setup workspace

Goal: give the operator a simple checklist for human setup work.

Current implementation:

- `/marketing` displays setup items.
- Setup items are stored in SQLite so progress persists.
- Setup checklist configuration lives in `config/marketing-setup-checklist.json`.
- Checklist rendering supports brand-profile template tokens through `renderMarketingTemplate()`.

Ready when:

- Artist account/profile URLs are saved in the checklist.
- Gmail account and workflow labels are created.
- Smart-link/profile URLs are recorded.
- Brand profile has current artist, audience, genre, distribution, and positioning data.

## Phase 2 — Sourced target research intake

Goal: ingest real research without fabricating contacts or opportunities.

Current implementation:

- `MARKETING_RESEARCH_SOURCE_PATH` points to a real JSON file.
- `runMarketingResearchImport()` imports only real records from that file.
- Missing `name`, `type`, or `source_url` causes a row to be skipped and logged.
- If the file is missing or not configured, the run is blocked and logged.

Ready when:

- OpenClaw/Firecrawl or manual research outputs a JSON file matching `docs/marketing-target-import.md`.
- Imported targets appear in `/marketing` as `needs_review`.
- Each target includes source links and AI-policy notes where available.

## Phase 3 — Human target approval

Goal: make Ken the control point before campaign planning.

Current implementation:

- Targets start as `needs_review`.
- UI supports `approved` and `rejected` status.
- Draft campaign planner uses only approved targets.

Ready when:

- At least one target is approved.
- AI-hostile or sketchy targets are rejected.
- Notes are added for judgment calls.

## Phase 4 — Draft campaign planning

Goal: create a draft campaign plan from real internal context.

Current implementation:

- `runDraftCampaignPlanner()` reads brand profile, songs, release links, and approved targets.
- It blocks if there are no songs.
- It blocks if there are no approved targets.
- It creates a draft campaign with a brand-context snapshot.
- It does not send outreach or post content.

Ready when:

- Draft campaigns appear in `/marketing`.
- Each campaign has a focus song, approved target IDs, objective, audience, channel mix, and brand-context snapshot.

## Phase 5 — Google Sheet tracking

Goal: mirror the operational state into a spreadsheet for inspection and backup.

Not implemented yet.

Proposed tabs:

- `Setup`
- `Targets`
- `Campaigns`
- `Runs`
- `Replies`
- `Suppression`

Guardrails:

- Sheet export should mirror database state; it should not create source data.
- Imports from Sheets should validate the same required fields as JSON import.
- Rows without source URLs should be rejected.

## Phase 6 — Gmail/OpenClaw dry-run

Goal: classify inbound messages and draft responses without sending.

Not implemented yet.

Required behavior:

- Read only the dedicated marketing inbox.
- Classify messages into safe categories.
- Create draft replies or suggested next actions.
- Log every decision.
- Escalate ambiguous, legal, paid, angry, school/district, or child-data-related messages.

## Phase 7 — Controlled automation

Goal: move from draft-only to bounded automation.

Not implemented yet.

Required gates:

- Dry-run results reviewed.
- Suppression list exists.
- Daily send limits exist.
- Approved message templates exist.
- Campaign status must be explicitly active.
- Every action must be logged.

## Current readiness verdict

The branch is ready for setup tracking, sourced target intake, target approval, and draft campaign creation. It is not ready for live outreach automation yet.
