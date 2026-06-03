# ALBUM_MPVMJGNA_ACIR Canonical Package RCA

Date: 2026-06-03 (revised)

## Summary

Release `ALBUM_MPVMJGNA_ACIR` ("Still Water Running", brand profile `tribe`, 3 tracks)
could not be used as a Browsy recording source. The release page reported:

```text
tracks[1].audioPath is required
tracks[2].audioPath is required
album.artistName is required
Canonical package manifest is missing
```

There were **two distinct issues**, only one of which is a code defect:

1. **Audio paths (data state, now resolved):** at the time the original errors were
   captured, tracks 2 and 3 had not finished song generation, so they had no audio
   file on disk. Those tracks have since been generated and now have selected release
   masters, so `tracks[].audioPath` resolves correctly.
2. **`album.artistName is required` (code defect — the real root cause):** the Browsy
   source-payload builder never applies the brand-profile → artist business rule. With
   no canonical manifest built yet, the artist field collapsed to an empty string even
   though the business rule guarantees a value.

## Verified Runtime State (post audio generation)

Database (`music-pipeline.db`):

```text
album   ALBUM_MPVMJGNA_ACIR  brand_profile_id=tribe  status=generating_tracks  number_of_songs=3
song    SONG_MPVMJGNA_ACIR_T01  Warm Front       pipeline_stage=album_track_generated      track_number=1
song    SONG_MPVMJGNA_ACIR_T02  August Equation  pipeline_stage=release_selection_complete  track_number=2
song    SONG_MPVMJGNA_ACIR_T03  Good Problem     pipeline_stage=release_selection_complete  track_number=3
```

Audio files on disk (all present):

```text
output/songs/SONG_MPVMJGNA_ACIR_T01/audio/warm-front.mp3
output/songs/SONG_MPVMJGNA_ACIR_T02/audio/august-equation.mp3
output/songs/SONG_MPVMJGNA_ACIR_T03/audio/good-problem.mp3
```

`getSelectedReleaseAudio` returns a selected master for all three tracks
(`duplicate=false`, `requiresSelection=false`).

No canonical package manifest exists:
`output/release-packages/ALBUM_MPVMJGNA_ACIR/manifest.json` is absent.

## Pipeline Trace — artistName

The Browsy source payload shown on the release page is produced by:

`buildReleaseCockpitViewModel` (`src/shared/release-cockpit.js:192`)
→ `buildDistroKidAlbumWorkflowContext` (`src/shared/automation-workflow-presets.js:122`)
→ `buildDistroKidAlbumSamplePayload` (`automation-workflow-presets.js:92`)
→ `buildDistroKidPayloadFromCockpit` (`src/shared/distrokid-payload.js:8`)
→ `validateDistroKidAlbumWorkflowContext` (`automation-workflow-presets.js:134`)

| Stage | artist input | artist output |
| --- | --- | --- |
| `buildDistroKidPayloadFromCockpit` | `uploadPayload.artist`/`manifest.artist` (both empty — no manifest) | `""` |
| `buildDistroKidAlbumSamplePayload` | `canonical.artistName \|\| canonical.artist \|\| cockpit.brandProfileName` | `""` (`cockpit.brandProfileName` is `undefined`) |
| `validateDistroKidAlbumWorkflowContext` | `album.artistName = ""` | error: `album.artistName is required.` |

### Root Cause

`buildDistroKidPayloadFromCockpit` derived the artist **only** from a built manifest
(`distrokid-payload.js:38`):

```js
const artistName = clean(uploadPayload.artist || manifest.artist || options.artistName || options.artist);
```

Before the package is built there is no manifest, so `artistName === ""`. The brand-profile
business rule (`resolveDistroKidArtist`: default → "Pancake Robot", any other → "Figment
Factory", `src/shared/brand-profile.js:206`) was **only** applied inside
`writeCanonicalAlbumReleasePackage` when assembling the built manifest — never on the
pre-build source-payload path.

The sample-payload fallback (`automation-workflow-presets.js:108`) tried
`cockpit.brandProfileName`, but the cockpit object assembled at `release-cockpit.js:192-197`
spreads `release` (which carries only `brandProfileId`) and never includes
`brandProfileName`. So the fallback was always `undefined`, and `artistName` collapsed to
`""`. This violated the invariant that artistName is never missing.

## Fix

Make the canonical payload builder apply the business rule directly, so artist is always
resolved from the release brand profile when no explicit manifest value is present
(`src/shared/distrokid-payload.js`):

```js
const artistName = clean(uploadPayload.artist || manifest.artist || options.artistName || options.artist)
  || resolveDistroKidArtist(
    clean(cockpit.brandProfileId || cockpit.brand_profile_id || manifest.brand_profile_id || uploadPayload.brand_profile_id) || null,
  );
```

This is the single source of truth used by both the Browsy source payload and the built
workflow package, so it fixes the release page and keeps the built manifest consistent.
An explicit manifest artist still wins (it is evaluated first).

### Verification

After the fix, the source payload for `ALBUM_MPVMJGNA_ACIR` resolves:

```text
album.artistName = "Figment Factory"   (tribe → non-default profile)
tracks[0..2].audioPath = <existing mp3 files>, audioExists = true
validation.ok = true, errors = []
```

## Regression Coverage

`test/distrokid-payload.test.js`:

- `canonical payload derives artist from brand profile when no package manifest exists yet`
  — non-default profile → "Figment Factory", `default`/`null` → "Pancake Robot".
- `explicit manifest artist still wins over brand-profile fallback`.

## Out of Scope / Separate Concern

The `media` stage still reports "Platform derivatives missing" (Spotify/DSP cover, YouTube
thumbnail, etc.). That is an independent release-asset generation gate, unrelated to the
artistName/audioPath defect, and must be satisfied (Generate/refresh release assets) before
`readyForPackage` allows the canonical album package to be built.
