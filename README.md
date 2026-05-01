# Profile-Driven Autonomous Music Pipeline

An autonomous multi-agent system that researches trends, writes lyrics, generates thumbnails, and prepares songs for distribution from the active brand profile — with one human gate: you approve before anything publishes.

## How It Works

```
Research → Lyricist → Brand Review → Revise? → Metadata → Thumbnails → QA → YOU APPROVE → Human Tasks
```

Seven specialized agents handle the pipeline:

| Agent | Role |
|---|---|
| Researcher | Market trends and audience/genre context from the active profile |
| Brand Manager | Brand bible guardian, scores every song 0–100 |
| Lyricist | Writes lyrics + Suno/Udio audio generation prompts |
| Product Manager | YouTube/Spotify metadata, SEO, distribution research |
| Creative Manager | AI thumbnail prompts + Cloudflare image generation |
| Financial Manager | Cost tracking, service research, visual reports |
| Ops Manager | QA checklist, human task instructions |

---

## Setup

### 1. Prerequisites

- Node.js 18+
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

# Optional — required for automatic thumbnail generation
CF_ACCOUNT_ID=your_cloudflare_account_id
CF_API_TOKEN=your_cloudflare_api_token
```

### 4. Run first-time setup

```bash
node src/orchestrator.js --setup
```

This will:
1. Create and store a shared Managed Agents environment (workspace container)
2. Create and store agent configs for all 7 agents
3. Run financial service research (free/cheap service comparison)
4. Research distribution services appropriate to the active profile
5. Build the active profile brand bible

Agent IDs and environment IDs are stored in `music-pipeline.config.json` — they persist across runs and are recreated automatically when an agent definition changes.

---

## Getting Free Cloudflare Credentials (for thumbnails)

Cloudflare Workers AI gives you **100,000 free image generations per day** using Flux Schnell.

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free account)
2. Go to **Workers & Pages → Workers AI**
3. Your **Account ID** is shown in the right sidebar of any Workers page (or in the URL: `dash.cloudflare.com/{account_id}/...`)
4. Create an API token:
   - Go to **My Profile → API Tokens → Create Token**
   - Use the **"Workers AI"** template, or create a custom token with `Workers AI - Run` permission
5. Add both to your `.env` file

If credentials aren't set, the pipeline still runs — the creative manager writes image prompt instructions to `output/songs/{songId}/thumbnails/THUMBNAIL_INSTRUCTIONS.md` so you can generate images manually.

---

## Command Reference

```bash
# First-time setup (run once)
node src/orchestrator.js --setup

# Generate a new song (full pipeline)
node src/orchestrator.js --new "dinosaurs"
node src/orchestrator.js --new "brushing teeth"
node src/orchestrator.js --new "sharing with friends"

# Refresh market research
node src/orchestrator.js --research

# Generate financial report
node src/orchestrator.js --report

# List all songs with status
node src/orchestrator.js --list

# Approve a song for distribution
node src/orchestrator.js --approve SONG_1234567890_abc123

# Reject a song
node src/orchestrator.js --reject SONG_1234567890_abc123 "Topic too mature for age group"

# Start recurring task scheduler (keeps running)
node src/orchestrator.js --schedule
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
| Thumbnail generation | **$0.00** | Cloudflare free tier (100k/day) |
| Music generation | **$0.00–$0.10** | Suno free tier or paid |
| Distribution | varies | Based on the active profile's distributor |
| **Total per song** | **~$0.50–$0.80** | |

Costs are tracked per-agent in SQLite and visualized in the financial report. Run `node src/orchestrator.js --report` at any time to see the breakdown.

---

## The Approval Gate

After the pipeline completes, you get an interactive prompt:

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

- **Yes**: Song is marked `approved`. Human task file is generated at `output/human-tasks/{songId}-human-tasks.md` with step-by-step instructions for audio generation, thumbnail text overlay, and distribution upload.
- **No**: Song is marked `rejected`. Pipeline stops. You can provide a rejection reason.
- **Revise**: Sends the song back through the lyricist with your notes, then reruns brand review. Up to 3 total revision attempts.

You can also approve/reject after the fact:

```bash
node src/orchestrator.js --approve SONG_1234567890_abc123
node src/orchestrator.js --reject SONG_1234567890_abc123 "Too similar to existing song"
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
│       └── thumbnails/
│           ├── image-prompts.json       # AI-generated image prompts
│           ├── youtube_landscape-base.png  # 1280x720 (if CF configured)
│           ├── spotify_square-base.png     # 3000x3000 (if CF configured)
│           ├── apple_music_square-base.png # 3000x3000 (if CF configured)
│           └── THUMBNAIL_INSTRUCTIONS.md   # Manual prompts (if CF not configured)
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

The report regenerates automatically after every song pipeline completes. Run `node src/orchestrator.js --report` to regenerate on demand with AI cost-reduction recommendations.

---

## Recurring Task Schedule

The scheduler keeps the pipeline current without manual intervention:

```bash
node src/orchestrator.js --schedule
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
pm2 start "node src/orchestrator.js --schedule" --name music-pipeline-scheduler
pm2 save
pm2 startup
```

---

## Adding New Song Topics

Just pass any topic to `--new`:

```bash
node src/orchestrator.js --new "a serious piano ballad about leaving home"
node src/orchestrator.js --new "old-school cypher about building something from nothing"
node src/orchestrator.js --new "late-night synth pop song about starting over"
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
