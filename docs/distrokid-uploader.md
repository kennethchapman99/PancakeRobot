# DistroKid Uploader

## What This Automates

- Builds local DistroKid release packages from real Pancake Robot song IDs.
- Copies audio, artwork, and lyrics into `output/release-packages/<SONG_ID>/`.
- Writes metadata, manifest, readiness checks, and missing-field reports.
- Saves and verifies reusable DistroKid auth.
- Opens DistroKid with Playwright and fills/uploads fields that have reliable selectors.
- Fills Pancake Robot defaults for AI disclosure, Children's Music genre, songwriter real name, and Apple Music performer/producer credits when selectors are available.
- Stops before final submission every time.
- Lets you mark a song submitted after you manually submit in DistroKid.

## What It Never Automates

- It never clicks final submit, finalize, release, send-to-stores, or upload-to-stores actions.
- It does not click Continue automatically.
- It does not select paid extras or optional add-ons.
- `--dry-run` defaults to true, and this implementation forces dry-run behavior.
- Manual DistroKid review and final submit remain your responsibility.

## Safety Rules

- Dangerous final buttons are listed in `scripts/distrokid/lib.mjs` and `config/distrokid/field-map.example.json`.
- The uploader installs a browser click guard and never calls click on dangerous button text.
- Missing or ambiguous selectors are skipped and logged.
- If multiple generic file inputs exist, the uploader does not guess blindly.
- Certification checkboxes are legal attestations and stay manual unless `--certify-important-checkboxes` is passed.

## Install And Setup

```bash
cd /Users/kchapman/PancakeRobot
npm install
npx playwright install chromium
npm run distrokid:smoke
```

## Primary Auth Flow

```bash
npm run distrokid:save-auth
```

Log in to DistroKid in the Chrome window. Wait for the dashboard or upload page. Close Chrome after the script says auth was saved.

Do not use codegen for Google login. The auth script launches Chrome with the working automation workaround and saves `.auth/distrokid.json` while the session is live.

## Auth Check

```bash
npm run distrokid:check-auth
```

Artifacts:

- `output/release-packages/auth-check.png`
- `output/release-packages/auth-check-page-text.txt`
- `output/release-packages/auth-check.html`

## Queue Songs

```bash
npm run distrokid:queue -- --song-id SONG_ID
npm run distrokid:queue -- --list
```

The Song Catalog bulk action and Song Detail card call the same queue helpers. Queueing does not change `song.status`.

## Build Package

```bash
npm run distrokid:package -- --song-id SONG_ID
```

Multiple songs:

```bash
npm run distrokid:package -- --song-ids SONG_1,SONG_2,SONG_3
```

Output:

- `output/release-packages/<SONG_ID>/manifest.json`
- `output/release-packages/<SONG_ID>/metadata-summary.md`
- `output/release-packages/<SONG_ID>/missing-fields.json`
- copied audio, cover art, and `lyrics.txt` when available

## Upload Dry-Run

```bash
npm run distrokid:upload -- --manifest output/release-packages/SONG_ID/manifest.json --dry-run
```

The browser opens, fills/uploads what it can, saves logs and screenshots, and stops for manual review.

For Pancake Robot releases, the uploader maps DistroKid-specific required fields as follows:

- AI disclosure: selects Yes, checks Lyrics, Music, and All of the audio, skips Part of the audio, then clicks Save only inside the AI modal.
- Genre: sets primary genre to `Children's Music`; secondary genre is optional and may remain manual.
- Songwriter real name: uses `Music and lyrics`, `Kenneth`, blank middle name, and `Chapman`.
- Apple Music credits: expands `Add credits for each song on this release`, then fills Performer `Pancake Robot` and Executive Producer `Kenneth Chapman`.

To also check the allowlisted legal/certification checkboxes:

```bash
npm run distrokid:upload -- \
  --manifest output/release-packages/SONG_ID/manifest.json \
  --dry-run \
  --certify-important-checkboxes
```

Only use `--certify-important-checkboxes` when the legal statements are true. The final submit and Continue actions remain manual.

## Discover DistroKid Fields

After the first dry-run, run discovery to map the live DistroKid form without filling anything:

```bash
npm run distrokid:upload -- \
  --manifest output/release-packages/SONG_ID/manifest.json \
  --dry-run \
  --discover-fields
```

Inspect:

```text
output/release-packages/SONG_ID/distrokid-run/discovered-fields.md
```

Use the discovered inputs, textareas, selects, buttons, and file inputs to create `config/distrokid/field-map.local.json`.

## Selector Capture

Use codegen only after auth is saved:

```bash
npx playwright codegen --browser=chromium --load-storage=.auth/distrokid.json https://distrokid.com/new/
```

Codegen is for selectors only. Do not use codegen for Google login. Do not click final submit during capture.

Recommended selector workflow:

1. Run `--discover-fields`.
2. Inspect `output/release-packages/SONG_ID/distrokid-run/discovered-fields.md`.
3. If needed, run codegen.
4. Do not click final submit.

See `docs/distrokid-selector-capture.md`.

## Manual Review Checklist

- Correct artist
- Correct title
- Correct release title
- Correct audio file
- Correct artwork
- Explicit flag
- AI-generated disclosure if DistroKid asks
- Songwriter real name
- Apple Music performer and producer credits
- Made for Kids/COPPA flag
- Genre
- Language
- Lyrics
- Release date
- Store selection
- YouTube/Content ID options
- Paid extras not accidentally selected
- Certification checkboxes only when the legal statements are true
- Continue remains manual
- Final submit is still manual

## Mark Submitted

After you manually submit in DistroKid:

```bash
npm run distrokid:mark-submitted -- --song-id SONG_ID --distrokid-url "URL_FROM_DISTROKID"
```

This updates Pancake Robot status to `submitted to DistroKid`, records distributor metadata, upserts the DistroKid release link, marks the distributor checklist item done, and writes `output/release-packages/<SONG_ID>/distrokid-submission.json`.

## Batch Dry-Run

```bash
npm run distrokid:batch -- --song-ids SONG_1,SONG_2,SONG_3 --dry-run
```

Batch mode processes one song at a time and writes:

- `output/release-packages/batch-runs/<timestamp>/batch-report.json`
- `output/release-packages/batch-runs/<timestamp>/batch-report.md`

## Weekly Queued Runner

Suggested weekly command only; no cron is installed automatically:

```bash
cd /Users/kchapman/PancakeRobot && npm run distrokid:run-queued -- --limit 5 --dry-run
```

## Troubleshooting

- Auth missing: run `npm run distrokid:save-auth`.
- Auth rejected: run `npm run distrokid:check-auth` and inspect the screenshot/text artifacts.
- Missing audio/art: rebuild Pancake Robot distribution-ready assets before packaging.
- Fields skipped: capture real selectors and update `config/distrokid/field-map.local.json`.
- Multiple file inputs: add a specific local selector for audio and cover art.

## Known Limitations

- DistroKid selectors can change and may require re-capture.
- Some DistroKid options and paid extras should remain manual.
- Store links are not known until after DistroKid submission/review.
- Final submission is intentionally not implemented.
