# DistroKid Uploader

## What This Automates

- Builds local DistroKid release packages from real Pancake Robot song IDs.
- Copies audio, artwork, and lyrics into `output/release-packages/<SONG_ID>/`.
- Writes metadata, manifest, readiness checks, and missing-field reports.
- Saves and verifies reusable DistroKid auth.
- Opens DistroKid with Playwright and fills/uploads fields that have reliable selectors.
- Stops before final submission every time.
- Lets you mark a song submitted after you manually submit in DistroKid.

## What It Never Automates

- It never clicks final submit, finalize, release, send-to-stores, or upload-to-stores actions.
- `--dry-run` defaults to true, and this implementation forces dry-run behavior.
- Manual DistroKid review and final submit remain your responsibility.

## Safety Rules

- Dangerous final buttons are listed in `scripts/distrokid/lib.mjs` and `config/distrokid/field-map.example.json`.
- The uploader installs a browser click guard and never calls click on dangerous button text.
- Missing or ambiguous selectors are skipped and logged.
- If multiple generic file inputs exist, the uploader does not guess blindly.

## Install And Setup

```bash
cd /Users/kchapman/PancakeRobot

npm install
npx playwright install chromium
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

## Selector Capture

Use codegen only after auth is saved:

```bash
npx playwright codegen --browser=chromium --load-storage=.auth/distrokid.json https://distrokid.com/new/
```

Codegen is for selectors only. Do not use codegen for Google login. Do not click final submit during capture.

See `docs/distrokid-selector-capture.md`.

## Manual Review Checklist

- Correct artist
- Correct title
- Correct release title
- Correct audio file
- Correct artwork
- Explicit flag
- AI-generated disclosure if DistroKid asks
- Made for Kids/COPPA flag
- Genre
- Language
- Lyrics
- Release date
- Store selection
- YouTube/Content ID options
- Paid extras not accidentally selected
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
