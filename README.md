# Profile-Driven Autonomous Music Pipeline

An autonomous multi-agent system that researches trends, writes lyrics, generates thumbnails, and prepares songs for distribution from the active brand profile — with one human gate: you approve before anything publishes.

## How It Works

```
Research → Lyricist → Brand Review → Revise? → Metadata → Audio → Release Selection → QA → YOU APPROVE NEXT STEP
```

Magic mode is now available for the narrower autonomous release-candidate flow:

```
Magic Pipeline → Create → A&R Score → Improve Once Max → Auto-build Marketing If Publish Candidate
```

Seven specialized agents handle the pipeline:

| Agent | Role |
|---|---|
| Researcher | Market trends and audience/genre context from the active profile |
| Brand Manager | Brand bible guardian, scores every song 0–100 |
| Lyricist | Writes lyrics + Suno/Udio audio generation prompts |
| Product Manager | YouTube/Spotify metadata, SEO, distribution research |
| Creative Manager | AI prompt guidance and release asset source art |
| Financial Manager | Cost tracking, service research, visual reports |
| Ops Manager | QA checklist, human task instructions |

---

## Release Selection

Finished songs now receive an automatic deterministic A&R pass before any release packaging step moves forward.

- The song stays in public `draft` status after analysis
- `ReleaseSelectionAgent` writes a `release_recommendation` object into the canonical song record
- It also writes `marketing_inputs_from_ar` for future asset generation
- The song detail page shows the recommendation, score, rationale, issues, blockers, best hook, and best clip window
- Operator actions decide whether the song moves to editing, release packaging, hold, or archive

Manual commands:

```bash
# Analyze one song
npm run release-selection -- --song SONG_1234567890_abc123

# Analyze recent draft songs
npm run release-selection -- --recent

# Analyze a specific set of songs
npm run release-selection -- --song SONG_1 --song SONG_2
```

The automatic hook runs inside the main generation pipeline immediately after audio generation completes in `src/orchestrator.js`.

---

## Setup

### 1. Prerequisites

- The repo launcher installs and uses Node.js 22.22.2 locally.
- An Anthropic API key (with access to the `managed-agents-2026-04-01` beta)

### 2. Install dependencies

```bash
cd <repo-dir>
npm install
```

> `canvas` requires native build tools. On macOS: `xcode-select --install`. On Ubuntu: `apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...

# Optional — preferred for generated album/single cover art
OPENAI_API_KEY=sk-...
OPENAI_IMAGE_MODEL=gpt-image-1.5
```

### 4. Run first-time setup

```bash
./bin/pancakerobot setup
```

This will:
1. Create and store a shared Managed Agents environment (workspace container)
2. Create and store agent configs for all 7 agents
3. Run financial service research (free/cheap service comparison)
4. Research distribution services appropriate to the active profile
5. Build the active profile brand bible

Agent IDs and environment IDs are stored in `music-pipeline.config.json` — they persist across runs and are recreated automatically when an agent definition changes.

---

## Release Images and Asset Packs

The normal album/single asset workflow is:

1. Open a song detail page or album detail page.
2. In the marketing/assets panel, choose a primary image source:
   - Generate with OpenAI image generation (`OPENAI_API_KEY`, optional `OPENAI_IMAGE_MODEL=gpt-image-1.5`).
   - Upload a PNG, JPG/JPEG, or WEBP image.
   - Reuse the repo base image library in `base images/`.
3. Generate derivatives.
4. Preview or download the asset pack.

Generated derivatives:

- Spotify / generic DSP cover: `spotify-cover-3000x3000.png`
- YouTube thumbnail: `youtube-thumbnail-1280x720.png`
- Instagram square: `instagram-square-1080x1080.png`
- Instagram story/reel vertical: `instagram-vertical-1080x1920.png`
- Facebook post: `facebook-post-1200x630.png`

Cloudflare image generation is not part of the main release image pipeline. The only supported automatic provider in the normal UI is OpenAI image generation; manual upload and base-image selection work without any image provider configured. A legacy Cloudflare provider remains hidden behind `PANCAKE_ENABLE_LEGACY_CLOUDFLARE_IMAGE=1` for debugging old flows.

Smoke test:

```bash
./bin/pancakerobot smoke:release-assets
```

---

## Command Reference

```bash
# First-time setup (run once)
./bin/pancakerobot setup

# Generate a new song (full pipeline)
./bin/pancakerobot new "dinosaurs"
./bin/pancakerobot new "brushing teeth"
./bin/pancakerobot new "sharing with friends"

# Run the one-click magic pipeline
./bin/pancakerobot magic "dinosaurs"

# Start the app
./bin/pancakerobot web

# Refresh market research
./bin/pancakerobot research

# Generate financial report
./bin/pancakerobot report

# List all songs with status
./bin/pancakerobot list

# Run release-selection analysis manually
npm run release-selection -- --song SONG_1234567890_abc123
npm run release-selection -- --recent

# Approve a song for distribution
./bin/pancakerobot approve SONG_1234567890_abc123

# Reject a song
./bin/pancakerobot reject SONG_1234567890_abc123 "Topic too mature for age group"

# Start recurring task scheduler (keeps running)
./bin/pancakerobot schedule
```

---

## Estimated Costs Per Song

| Component | Cost | Notes |
|---|---|---|
| Researcher agent | ~$0.05 | Runs once per 30 days, amortized |
| Lyricist agent | ~$0.15 | Per song, ~1–2 revision loops |
| Brand Manager review | ~$0.08 | Per song (1–3 reviews) |
| Product Manager | ~$0.12 | Metadata + distribution research |
| Creative Manager | ~$0.05 | Image prompt generation |
| Ops Manager | ~$0.05 | QA + human task instructions |
| **AI pipeline total** | **~$0.50–$0.70** | |
| Release image generation | varies | Optional OpenAI image generation, or $0 with manual upload/base images |
| Music generation | **$0.00–$0.10** | Suno free tier or paid |
| Distribution | varies | Based on the active profile's distributor |
| **Total per song** | **~$0.50–$0.80** | |

Costs are tracked per-agent in SQLite and visualized in the financial report. Run `./bin/pancakerobot report` at any time to see the breakdown.

---

## The Approval Gate

After the pipeline completes, the song is analyzed and stays in `draft`. In the CLI flow, you still get an interactive prompt:

```
================================================================================
SONG READY FOR REVIEW
================================================================================
Title:       The Dino Dance Party
Topic:       dinosaurs
Brand Score: 88/100
Pipeline Cost: $0.0634

Would you like to review the lyrics first? (Y/n)
...

Decision:
  ❯ Yes — approve this song
    No — reject and discard
    Revise — send back for another revision pass
```

- **Yes**: Song moves toward release packaging. In the web flow, the song detail page exposes the release-selection recommendation and the operator chooses the next action there.
- **No**: Song is marked `rejected`. Pipeline stops. You can provide a rejection reason.
- **Revise**: Sends the song back through the lyricist with your notes, then reruns brand review. Up to 3 total revision attempts.

You can also approve/reject after the fact:

```bash
./bin/pancakerobot approve SONG_1234567890_abc123
./bin/pancakerobot reject SONG_1234567890_abc123 "Too similar to existing song"
```

---

## Output Files

After a successful pipeline run:

```
output/
├── songs/
│   └── SONG_1234567890_abc123/
│       ├── lyrics.md                    # Full song with structure markers
│       ├── audio-prompt.md              # Ready-to-paste Suno/Udio prompt
│       ├── metadata.json                # YouTube, Spotify, Apple Music metadata
│       ├── qa-report.json               # Automated QA checklist results
│       └── reference/
│           ├── base-image.png           # selected primary cover image
│           └── base-image.metadata.json # OpenAI generation metadata when used
├── marketing-ready/
│   └── SONG_1234567890_abc123/
│       ├── spotify-cover-3000x3000.png
│       ├── youtube-thumbnail-1280x720.png
│       ├── facebook-post-1200x630.png
│       ├── instagram/
│       │   ├── instagram-square-1080x1080.png
│       │   └── instagram-vertical-1080x1920.png
│       ├── metadata.json
│       └── index.html
├── human-tasks/
│   └── SONG_1234567890_abc123-human-tasks.md  # Your to-do list
├── reports/
│   ├── financial-report.html            # Visual cost report
│   └── charts/
│       ├── cost-by-agent.png
│       └── spend-over-time.png
├── research/
│   └── research-report.json             # Market research cache
├── brand/
│   └── brand-bible.md                   # Brand guidelines document
└── distribution/
    └── distribution-research.json       # Service comparison
```

---

## Reading the Financial Report

Open `output/reports/financial-report.html` in any browser.

The report shows:
- **Total Spent** — lifetime pipeline costs
- **Avg Cost / Run** — per agent invocation
- **Cost by Agent** — bar chart + table showing which agents cost the most
- **Spend Over Time** — daily spend + cumulative curve
- **Service Research** — comparison of music generation, distribution, and image services with free tier info

The report regenerates automatically after every song pipeline completes. Run `./bin/pancakerobot report` to regenerate on demand with AI cost-reduction recommendations.

---

## Recurring Task Schedule

The scheduler keeps the pipeline current without manual intervention:

```bash
./bin/pancakerobot schedule
```

| Task | Schedule | What it does |
|---|---|---|
| Market Research | 1st of every month, 9am | Refreshes trend and audience data for the active profile |
| Financial Report | Every Monday, 9am | Regenerates cost analysis + service research |
| Distribution Check | 1st of every month, 10am | Checks distribution platform pricing/terms |

The scheduler blocks the terminal. Use a process manager (PM2, systemd, launchd) for production:

```bash
# PM2 example
npm install -g pm2
pm2 start "./bin/pancakerobot schedule" --name music-pipeline-scheduler
pm2 save
pm2 startup
```

---

## Adding New Song Topics

Just pass any topic to `--new`:

```bash
./bin/pancakerobot new "a serious piano ballad about leaving home"
./bin/pancakerobot new "old-school cypher about building something from nothing"
./bin/pancakerobot new "late-night synth pop song about starting over"
```

Topics work best when they are:
- Concrete, specific, and emotionally or visually clear
- Aligned with the selected brand profile's audience, genre, and rules
- Focused enough for one song

The researcher will have surfaced trending topics during `--setup` and monthly refreshes. Check `output/research/research-report.json` for the current list.

---

## Project Structure

```
MusicPipeline/
├── src/
│   ├── orchestrator.js          # Main CLI entry point
│   ├── agents/
│   │   ├── researcher.js        # Market research agent
│   │   ├── brand-manager.js     # Brand guardian agent
│   │   ├── lyricist.js          # Songwriting agent
│   │   ├── product-manager.js   # Metadata + distribution agent
│   │   ├── creative-manager.js  # Thumbnail generation agent
│   │   ├── financial-manager.js # Cost tracking + service research agent
│   │   └── ops-manager.js       # QA + human task generation agent
│   ├── shared/
│   │   ├── managed-agent.js     # Core agent infrastructure
│   │   ├── db.js                # SQLite schema + queries
│   │   ├── costs.js             # Token cost calculation
│   │   └── approval-gate.js     # Interactive approval CLI
│   └── reports/
│       └── financial-report.js  # Chart.js + HTML report generator
├── output/                      # All generated content (gitignored)
├── music-pipeline.config.json   # Generic runtime IDs only; brand source is config/brand-profile*.json
├── .env                         # API keys (never commit)
├── .env.example                 # Template
└── package.json
```

---

## Known Beta API Quirks

The pipeline uses `managed-agents-2026-04-01` beta, which has a few behaviors worth knowing:

**1. Stream before send**

The session event stream must be opened *before* sending the user message, or early events are missed. `managed-agent.js` handles this with `client.beta.sessions.stream(sessionId)` called first, then `sessions.events.send()`.

**2. Agent IDs are permanent**

Agent configs are stored objects — they don't expire. `music-pipeline.config.json` stores IDs across runs, and `managed-agent.js` recreates agents when the stored definition fingerprint no longer matches the current profile-driven definition. If an agent call 404s (rare, e.g. after account changes), the orchestrator clears the stored ID and recreates automatically on the next run.

**3. `session.status_idle` vs `requires_action`**

The pipeline breaks on `session.status_idle` only when `stop_reason.type !== 'requires_action'`. When `requires_action`, a tool result is expected — the agent toolset (`agent_toolset_20260401`) handles tool execution server-side, so this is handled internally and you'll see `status_idle` again after.

**4. Token usage is in `span.model_request_end` events**

Cost tracking reads `event.model_usage.input_tokens` / `output_tokens` from `span.model_request_end` events, not from a top-level response field.

**5. No response body — only event stream**

Agent output comes entirely from `agent.message` events in the SSE stream. There is no response body to parse. `parseAgentJson()` in `managed-agent.js` extracts JSON from the agent's message text (handles both raw JSON and markdown code fences).

**6. `canvas` native module**

Chart generation uses `canvas` (node-canvas), a native Node.js addon. It must be compiled for your platform. If `npm install` errors on canvas, see: [github.com/Automattic/node-canvas#compiling](https://github.com/Automattic/node-canvas#compiling). Chart generation gracefully degrades — the HTML report still renders without charts if canvas isn't available.

---

## Database

Song runs and costs are stored in the local SQLite database for the current pipeline slug.

```bash
# Inspect directly
sqlite3 music-pipeline.db

# Useful queries
SELECT agent_name, COUNT(*) as runs, SUM(cost_usd) as total_cost FROM runs GROUP BY agent_name;
SELECT song_id, title, status, brand_score FROM songs ORDER BY created_at DESC;
```

---

## License

MIT
