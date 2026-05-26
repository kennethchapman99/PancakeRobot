import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function validateCanonicalReleasePackageManifest(manifest, options = {}) {
  const releaseType = normalizeReleaseType(options.releaseType || manifest?.release_type);
  const issues = [];
  const missingInputs = [];

  if (!manifest || typeof manifest !== 'object') {
    addIssue(issues, missingInputs, {
      code: 'missing_manifest',
      message: 'Canonical package manifest is missing.',
      missingInput: 'manifest',
    });
    return finalizeValidation(releaseType, issues, missingInputs);
  }

  const isAlbum = releaseType === 'album' || (Array.isArray(manifest.tracks) && manifest.tracks.length > 0);
  const normalizedType = isAlbum ? 'album' : 'single';

  if (isAlbum) {
    validateAlbumManifest(manifest, issues, missingInputs);
  } else {
    validateSingleManifest(manifest, issues, missingInputs);
  }

  return finalizeValidation(normalizedType, issues, missingInputs, manifest);
}

function validateAlbumManifest(manifest, issues, missingInputs) {
  const albumId = clean(manifest.album_id);
  const releaseId = clean(manifest.release_id);
  const legacySongId = clean(manifest.song_id);

  if (!albumId && !releaseId && /^ALBUM_/i.test(legacySongId)) {
    addIssue(issues, missingInputs, {
      code: 'album_song_id_confusion',
      message: `Album package uses legacy song_id ${legacySongId} where album_id/release_id should be used.`,
      missingInput: 'album_id_or_release_id',
    });
  }

  validateCoverArt(manifest.cover_art, issues, missingInputs);

  if (!Array.isArray(manifest.tracks) || manifest.tracks.length === 0) {
    addIssue(issues, missingInputs, {
      code: 'missing_tracks',
      message: 'Canonical package has no tracks.',
      missingInput: 'tracks',
    });
    return;
  }

  manifest.tracks.forEach((track, index) => {
    const label = trackLabel(track, index);
    const audioFile = clean(track?.audio_file);
    if (!audioFile) {
      addIssue(issues, missingInputs, {
        code: 'missing_track_audio_file',
        message: `${label}: audio_file is missing.`,
        missingInput: 'audio_file',
        path: `tracks[${index}].audio_file`,
        trackIndex: index,
        trackSongId: clean(track?.song_id) || clean(track?.track_metadata?.id) || null,
      });
      return;
    }
    if (!existsOnDisk(audioFile)) {
      addIssue(issues, missingInputs, {
        code: 'missing_track_audio_file_path',
        message: `${label}: audio_file not found: ${audioFile}`,
        missingInput: 'audio_file',
        path: `tracks[${index}].audio_file`,
        trackIndex: index,
        trackSongId: clean(track?.song_id) || clean(track?.track_metadata?.id) || null,
      });
    }
  });
}

function validateSingleManifest(manifest, issues, missingInputs) {
  validateCoverArt(manifest.cover_art, issues, missingInputs);

  const audioFile = clean(manifest.audio_file);
  if (!audioFile) {
    addIssue(issues, missingInputs, {
      code: 'missing_track_audio_file',
      message: 'Canonical package is missing audio_file.',
      missingInput: 'audio_file',
      path: 'audio_file',
      trackSongId: clean(manifest.song_id) || null,
    });
    return;
  }
  if (!existsOnDisk(audioFile)) {
    addIssue(issues, missingInputs, {
      code: 'missing_track_audio_file_path',
      message: `audio_file not found: ${audioFile}`,
      missingInput: 'audio_file',
      path: 'audio_file',
      trackSongId: clean(manifest.song_id) || null,
    });
  }
}

function validateCoverArt(coverArt, issues, missingInputs) {
  const value = clean(coverArt);
  if (!value) {
    addIssue(issues, missingInputs, {
      code: 'missing_cover_art',
      message: 'Canonical package is missing cover_art.',
      missingInput: 'cover_art',
      path: 'cover_art',
    });
    return;
  }
  if (!existsOnDisk(value)) {
    addIssue(issues, missingInputs, {
      code: 'missing_cover_art_file',
      message: `cover_art not found: ${value}`,
      missingInput: 'cover_art',
      path: 'cover_art',
    });
  }
}

function finalizeValidation(releaseType, issues, missingInputs, manifest = null) {
  const distinctMissingInputs = [...new Set(missingInputs)];
  const missingCoverArtCount = issues.filter(issue => issue.missingInput === 'cover_art').length;
  const missingAudioFileCount = issues.filter(issue => issue.missingInput === 'audio_file').length;
  const isLegacyAlbumSongId = Boolean(
    releaseType === 'album'
      && !clean(manifest?.album_id)
      && !clean(manifest?.release_id)
      && /^ALBUM_/i.test(clean(manifest?.song_id))
  );

  return {
    releaseType,
    ready: issues.length === 0,
    issues,
    blocking_missing_fields: distinctMissingInputs,
    missingInputs: distinctMissingInputs,
    missingCoverArtCount,
    missingAudioFileCount,
    missingTrackCount: issues.filter(issue => issue.code === 'missing_tracks').length,
    hasLegacyAlbumSongId: isLegacyAlbumSongId,
    summary: buildValidationSummary({ issues, missingCoverArtCount, missingAudioFileCount }),
  };
}

function buildValidationSummary({ issues, missingCoverArtCount, missingAudioFileCount }) {
  if (!issues.length) return 'Canonical package is valid.';

  const summaryParts = [];
  if (missingCoverArtCount) summaryParts.push(`missing cover art${missingCoverArtCount > 1 ? ` (${missingCoverArtCount})` : ''}`);
  if (missingAudioFileCount) summaryParts.push(`missing ${missingAudioFileCount} audio file${missingAudioFileCount === 1 ? '' : 's'}`);
  if (!summaryParts.length) {
    const genericCount = issues.length;
    summaryParts.push(`${genericCount} validation issue${genericCount === 1 ? '' : 's'}`);
  }
  return `Canonical package is incomplete: ${joinSummary(summaryParts)}.`;
}

function addIssue(issues, missingInputs, issue) {
  issues.push(issue);
  if (issue.missingInput) missingInputs.push(issue.missingInput);
}

function joinSummary(parts) {
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

function existsOnDisk(filePath) {
  const absolutePath = toAbsolutePath(filePath);
  return Boolean(absolutePath) && fs.existsSync(absolutePath);
}

function toAbsolutePath(filePath) {
  const value = clean(filePath);
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

function trackLabel(track, index) {
  return clean(track?.song_id)
    || clean(track?.track_metadata?.id)
    || clean(track?.track_title)
    || `track ${index + 1}`;
}

function normalizeReleaseType(value) {
  return String(value || '').toLowerCase() === 'album' ? 'album' : 'single';
}

function clean(value) {
  const next = String(value || '').trim();
  return next || '';
}
