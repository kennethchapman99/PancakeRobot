#!/usr/bin/env node

import { basename, extname, join } from 'path';
import fs from 'fs';
import { getSong, getAssetsForSong } from '../../src/shared/db.js';
import { getActiveProfileId, loadBrandProfile, loadBrandProfileById } from '../../src/shared/brand-profile.js';
import { DISTROKID_JOB_STATUSES, getDistroKidJob, markDistroKidJobStatus } from '../../src/shared/distrokid-jobs.js';
import {
  OUTPUT_DIR,
  absoluteFromMaybeRelative,
  copyFileIfExists,
  ensureDir,
  exists,
  getReleasePackageDir,
  parseArgs,
  readJson,
  relativeToRepo,
  safeReadJson,
  splitCsv,
  writeJson,
  writeText,
} from './lib.mjs';

const { values } = parseArgs({
  'song-id': { type: 'string' },
  'song-ids': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
});

if (values.help) {
  printUsage();
  process.exit(0);
}

const songIds = values['song-ids'] ? splitCsv(values['song-ids']) : splitCsv(values['song-id']);
if (!songIds.length) {
  printUsage();
  process.exit(1);
}

const PANCAKE_ROBOT_DISTROKID_DEFAULTS = Object.freeze({
  primary_genre: "Children's Music",
  ai_disclosure: {
    uses_ai: true,
    lyrics_written_by_ai: false,
    music_composed_by_ai: false,
    all_audio_performed_by_ai: true,
    part_audio_performed_by_ai_and_humans: false,
  },
  songwriter_real_name: {
    role: 'Music and lyrics',
    first: 'Kenneth',
    middle: '',
    last: 'Chapman',
  },
  apple_music_credits: {
    performer: {
      role: 'Performer',
      name: 'Pancake Robot',
    },
    producer: {
      role: 'Executive Producer',
      name: 'Kenneth Chapman',
    },
  },
  rights_confirmations: {
    youtube_music_selected_acknowledged: true,
    no_promo_services: true,
    recorded_and_authorized: true,
    no_unapproved_artist_names: true,
    distribution_agreement_accepted: true,
    tiktok_commercial_music_library: false,
    snapchat: false,
  },
});

let hadError = false;
for (const songId of songIds) {
  try {
    const manifest = buildReleasePackage(songId);
    console.log(`Package: ${relativeToRepo(getReleasePackageDir(songId))}`);
    console.log(`Readiness: ${manifest.readiness.ready_for_distrokid_dry_run ? 'ready' : 'not ready'}`);
    console.log(`Blocking missing fields: ${manifest.readiness.blocking_missing_fields.join(', ') || 'none'}`);
    console.log(`Next: bash scripts/pancake.sh distrokid:upload --manifest output/release-packages/${songId}/manifest.json --dry-run`);
  } catch (error) {
    hadError = true;
    console.error(`FAIL ${songId}: ${error.message}`);
  }
}

if (hadError) process.exit(1);

function printUsage() {
  console.error('Usage:');
  console.error('  bash scripts/pancake.sh distrokid:package --song-id SONG_ID');
  console.error('  bash scripts/pancake.sh distrokid:package --song-ids SONG_1,SONG_2,SONG_3');
}

function buildReleasePackage(songId) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found in database: ${songId}`);

  const assets = getAssetsForSong(songId);
  const profileId = song.brand_profile_id || getActiveProfileId();
  const brandProfile = loadProfile(profileId);
  const dist = brandProfile.distribution || {};
  const metadata = loadMetadata(song, songId);
  const packageDir = ensureDir(getReleasePackageDir(songId));

  const fieldSources = {};
  const warnings = [];
  const missingFields = [];
  const blockingMissingFields = [];

  const audio = findAudio(songId, assets);
  const cover = findCoverArt(song, songId, assets);
  const lyrics = findLyrics(song, songId, assets);

  const manifest = {
    schema_version: 'distrokid-release-package-v1',
    song_id: songId,
    brand_profile_id: profileId,
    artist: pick('artist', [
      [metadata.value?.artist, metadata.source],
      [metadata.value?.primary_artist, metadata.source],
      [dist.default_artist, 'brand_profile'],
    ], fieldSources),
    release_title: null,
    track_title: pick('track_title', [
      [metadata.value?.track_title, metadata.source],
      [metadata.value?.title, metadata.source],
      [song.title, 'song'],
    ], fieldSources),
    audio_file: null,
    cover_art: null,
    lyrics_file: null,
    primary_genre: pick('primary_genre', [
      [metadata.value?.primary_genre, metadata.source],
      [metadata.value?.genre, metadata.source],
      [firstArrayValue(song.genre_tags), 'song'],
      [dist.primary_genre, 'brand_profile'],
      [PANCAKE_ROBOT_DISTROKID_DEFAULTS.primary_genre, 'pancake_robot_default'],
    ], fieldSources),
    secondary_genre: pick('secondary_genre', [
      [metadata.value?.secondary_genre, metadata.source],
      [secondArrayValue(song.genre_tags), 'song'],
      [secondArrayValue(dist.spotify_genres), 'brand_profile'],
    ], fieldSources),
    language: pick('language', [
      [metadata.value?.language, metadata.source],
      ['English', 'default'],
    ], fieldSources),
    explicit: pick('explicit', [
      [normalizeExplicit(metadata.value?.explicit ?? metadata.value?.explicit_content_rating), metadata.source],
      [false, 'default'],
    ], fieldSources),
    is_ai_generated: pick('is_ai_generated', [
      [metadata.value?.is_ai_generated, metadata.source],
      [true, 'default'],
    ], fieldSources),
    ai_disclosure: buildNestedDefaults('ai_disclosure', PANCAKE_ROBOT_DISTROKID_DEFAULTS.ai_disclosure, metadata.value?.ai_disclosure, metadata.source, fieldSources),
    release_date: pick('release_date', [
      [song.release_date, 'song'],
      [metadata.value?.release_date, metadata.source],
    ], fieldSources),
    stores: pick('stores', [
      [Array.isArray(metadata.value?.stores) ? metadata.value.stores : null, metadata.source],
      [[], 'default'],
    ], fieldSources),
    songwriter: pick('songwriter', [
      [metadata.value?.songwriter, metadata.source],
      [dist.songwriter, 'brand_profile'],
      [dist.default_artist, 'brand_profile'],
    ], fieldSources),
    songwriter_real_name: buildNestedDefaults('songwriter_real_name', PANCAKE_ROBOT_DISTROKID_DEFAULTS.songwriter_real_name, metadata.value?.songwriter_real_name, metadata.source, fieldSources),
    producer: pick('producer', [
      [metadata.value?.producer, metadata.source],
      [dist.producer, 'brand_profile'],
    ], fieldSources),
    apple_music_credits: buildNestedDefaults('apple_music_credits', PANCAKE_ROBOT_DISTROKID_DEFAULTS.apple_music_credits, metadata.value?.apple_music_credits, metadata.source, fieldSources),
    rights_confirmations: buildNestedDefaults('rights_confirmations', PANCAKE_ROBOT_DISTROKID_DEFAULTS.rights_confirmations, metadata.value?.rights_confirmations, metadata.source, fieldSources),
    copyright_year: pick('copyright_year', [
      [metadata.value?.copyright_year, metadata.source],
      [song.release_date ? String(new Date(song.release_date).getUTCFullYear()) : null, 'derived'],
      [String(new Date().getFullYear()), 'derived'],
    ], fieldSources),
    copyright_owner: pick('copyright_owner', [
      [metadata.value?.copyright_owner, metadata.source],
      [dist.copyright_owner, 'brand_profile'],
      [dist.default_artist, 'brand_profile'],
      [brandProfile.brand_name, 'brand_profile'],
    ], fieldSources),
    made_for_kids: pick('made_for_kids', [
      [metadata.value?.made_for_kids, metadata.source],
      [dist.made_for_kids, 'brand_profile'],
      [null, 'missing'],
    ], fieldSources),
    content_advisory: pick('content_advisory', [
      [metadata.value?.content_advisory, metadata.source],
      [dist.content_advisory, 'brand_profile'],
    ], fieldSources),
    callback_url: `http://localhost:3737/api/distrokid/releases/${songId}/complete`,
    field_sources: {},
    readiness: {},
  };

  if (isPresent(metadata.value?.ai_artist_identity)) {
    manifest.ai_artist_identity = metadata.value.ai_artist_identity;
    fieldSources.ai_artist_identity = metadata.source || 'metadata';
  }

  manifest.release_title = pick('release_title', [
    [metadata.value?.release_title, metadata.source],
    [metadata.value?.album, metadata.source],
    [dist.default_album, 'brand_profile'],
    [manifest.track_title, fieldSources.track_title || 'derived'],
  ], fieldSources);

  if (audio.path) {
    const dest = join(packageDir, `audio${extname(audio.path).toLowerCase()}`);
    copyFileIfExists(audio.path, dest);
    manifest.audio_file = relativeToRepo(dest);
    fieldSources.audio_file = audio.source;
  } else {
    fieldSources.audio_file = 'missing';
  }

  if (cover.path) {
    const ext = extname(cover.path).toLowerCase() || '.png';
    const dest = join(packageDir, `cover-art${ext}`);
    copyFileIfExists(cover.path, dest);
    manifest.cover_art = relativeToRepo(dest);
    fieldSources.cover_art = cover.source;
  } else {
    fieldSources.cover_art = 'missing';
  }

  if (lyrics.path || lyrics.text) {
    const dest = join(packageDir, 'lyrics.txt');
    writeText(dest, cleanLyrics(lyrics.text ?? fs.readFileSync(lyrics.path, 'utf8')));
    manifest.lyrics_file = relativeToRepo(dest);
    fieldSources.lyrics_file = lyrics.source;
  } else {
    fieldSources.lyrics_file = 'missing';
  }

  const checks = [
    ['audio_file', manifest.audio_file, true],
    ['cover_art', manifest.cover_art, true],
    ['track_title', manifest.track_title, true],
    ['artist', manifest.artist, true],
    ['primary_genre', manifest.primary_genre, true],
    ['release_date', manifest.release_date, false],
    ['lyrics_file', manifest.lyrics_file, false],
  ];

  for (const [field, value, blocking] of checks) {
    if (!isPresent(value)) {
      missingFields.push(field);
      if (blocking) blockingMissingFields.push(field);
      else warnings.push(field);
    }
  }

  manifest.field_sources = ensureManifestSources(manifest, fieldSources);
  manifest.readiness = {
    has_audio: Boolean(manifest.audio_file),
    has_cover_art: Boolean(manifest.cover_art),
    has_title: Boolean(manifest.track_title),
    has_artist: Boolean(manifest.artist),
    has_genre: Boolean(manifest.primary_genre),
    has_lyrics: Boolean(manifest.lyrics_file),
    ready_for_distrokid_dry_run: blockingMissingFields.length === 0,
    blocking_missing_fields: blockingMissingFields,
  };

  writeJson(join(packageDir, 'manifest.json'), manifest);
  writeJson(join(packageDir, 'missing-fields.json'), {
    blocking_missing_fields: blockingMissingFields,
    warning_missing_fields: warnings,
    all_missing_fields: [...new Set(missingFields)],
  });
  writeText(join(packageDir, 'metadata-summary.md'), buildSummary({
    songId,
    manifest,
    audio,
    cover,
    lyrics,
    blockingMissingFields,
    warnings,
  }));

  const currentJob = getDistroKidJob(songId);
  if (!currentJob || ![DISTROKID_JOB_STATUSES.AWAITING_MANUAL_REVIEW, DISTROKID_JOB_STATUSES.SUBMITTED].includes(currentJob.status)) {
    markDistroKidJobStatus(
      songId,
      blockingMissingFields.length ? DISTROKID_JOB_STATUSES.BLOCKED_MISSING_FIELDS : DISTROKID_JOB_STATUSES.PACKAGE_BUILT,
      { package_path: relativeToRepo(packageDir), latest_error_json: blockingMissingFields.length ? { blocking_missing_fields: blockingMissingFields } : null }
    );
  }

  return manifest;
}

function loadProfile(profileId) {
  if (!profileId || profileId === 'default') return loadBrandProfile();
  return loadBrandProfileById(profileId);
}

function loadMetadata(song, songId) {
  const candidates = [
    [join(OUTPUT_DIR, 'distribution-ready', songId, 'metadata.json'), 'distribution_metadata'],
    [absoluteFromMaybeRelative(song.metadata_path), 'song.metadata_path'],
    [join(OUTPUT_DIR, 'songs', songId, 'metadata.json'), 'song_output_metadata'],
  ];
  for (const [path, source] of candidates) {
    if (exists(path)) return { value: safeReadJson(path, {}), source: sourcePath(source, path) };
  }
  return { value: song, source: 'song' };
}

function findAudio(songId, assets) {
  const candidates = [
    [join(OUTPUT_DIR, 'distribution-ready', songId, 'upload-this.wav'), 'distribution-ready/upload-this.wav'],
    [join(OUTPUT_DIR, 'distribution-ready', songId, 'upload-this.mp3'), 'distribution-ready/upload-this.mp3'],
    [join(OUTPUT_DIR, 'songs', songId, 'audio.wav'), 'songs/audio.wav'],
    [join(OUTPUT_DIR, 'songs', songId, 'audio.mp3'), 'songs/audio.mp3'],
  ];
  for (const [path, source] of candidates) {
    if (exists(path)) return { path, source: sourcePath(source, path) };
  }
  const asset = assets.find(item => item.is_current && item.file_path && /audio/i.test(item.asset_type || '') && /\.(wav|mp3)$/i.test(item.file_path))
    || assets.find(item => item.file_path && /\.(wav|mp3)$/i.test(item.file_path));
  const assetPath = absoluteFromMaybeRelative(asset?.file_path);
  return exists(assetPath) ? { path: assetPath, source: `asset:${asset.asset_type}` } : {};
}

function findCoverArt(song, songId, assets) {
  const candidates = [
    [join(OUTPUT_DIR, 'distribution-ready', songId, 'cover-art-3000x3000.png'), 'distribution-ready/cover-art-3000x3000.png'],
    [join(OUTPUT_DIR, 'distribution-ready', songId, 'cover-art-3000x3000.jpg'), 'distribution-ready/cover-art-3000x3000.jpg'],
    [join(OUTPUT_DIR, 'distribution-ready', songId, 'cover.png'), 'distribution-ready/cover.png'],
    [join(OUTPUT_DIR, 'distribution-ready', songId, 'cover.jpg'), 'distribution-ready/cover.jpg'],
    [join(OUTPUT_DIR, 'marketing-ready', songId, 'no-text-variation.png'), 'marketing-ready/no-text-variation.png'],
    [join(OUTPUT_DIR, 'marketing-ready', songId, 'outreach-hero-1600x900.png'), 'marketing-ready/outreach-hero-1600x900.png'],
    [absoluteFromMaybeRelative(song.thumbnail_path), 'song.thumbnail_path'],
  ];
  for (const [path, source] of candidates) {
    if (exists(path)) return { path, source: sourcePath(source, path) };
  }
  const asset = assets.find(item => item.is_current && item.file_path && /image|cover|thumbnail/i.test(`${item.asset_type} ${item.label}`) && /\.(png|jpe?g)$/i.test(item.file_path))
    || assets.find(item => item.file_path && /\.(png|jpe?g)$/i.test(item.file_path));
  const assetPath = absoluteFromMaybeRelative(asset?.file_path);
  return exists(assetPath) ? { path: assetPath, source: `asset:${asset.asset_type}` } : {};
}

function findLyrics(song, songId, assets) {
  const candidates = [
    [absoluteFromMaybeRelative(song.lyrics_path), 'song.lyrics_path'],
    [join(OUTPUT_DIR, 'songs', songId, 'lyrics.txt'), 'songs/lyrics.txt'],
    [join(OUTPUT_DIR, 'songs', songId, 'lyrics.md'), 'songs/lyrics.md'],
  ];
  for (const [path, source] of candidates) {
    if (exists(path)) return { path, source: sourcePath(source, path) };
  }
  const asset = assets.find(item => item.is_current && item.text_content && /lyric/i.test(`${item.asset_type} ${item.label}`))
    || assets.find(item => item.text_content && /lyric/i.test(`${item.asset_type} ${item.label}`));
  return asset ? { text: asset.text_content, source: `asset:${asset.asset_type}` } : {};
}

function pick(field, candidates, fieldSources) {
  for (const [value, source] of candidates) {
    if (isPresent(value)) {
      fieldSources[field] = source || 'derived';
      return value;
    }
  }
  fieldSources[field] = 'missing';
  return null;
}

function buildNestedDefaults(field, defaults, sourceData, sourceName, fieldSources) {
  const result = Array.isArray(defaults) ? [] : {};
  const sources = Array.isArray(defaults) ? [] : {};
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const providedValue = sourceData?.[key];
    if (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
      result[key] = buildNestedDefaults(`${field}.${key}`, defaultValue, providedValue, sourceName, fieldSources);
      sources[key] = fieldSources[field]?.[key] || nestedSourceTree(result[key], 'pancake_robot_default');
      continue;
    }
    if (isPresent(providedValue) || providedValue === false) {
      result[key] = providedValue;
      sources[key] = sourceName || 'metadata';
    } else {
      result[key] = defaultValue;
      sources[key] = 'pancake_robot_default';
    }
  }
  setNestedFieldSource(fieldSources, field, sources);
  return result;
}

function setNestedFieldSource(fieldSources, field, value) {
  const parts = field.split('.');
  let cursor = fieldSources;
  while (parts.length > 1) {
    const part = parts.shift();
    cursor[part] = cursor[part] && typeof cursor[part] === 'object' ? cursor[part] : {};
    cursor = cursor[part];
  }
  cursor[parts[0]] = value;
}

function nestedSourceTree(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return source;
  return Object.fromEntries(Object.keys(value).map(key => [key, nestedSourceTree(value[key], source)]));
}

function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function firstArrayValue(value) {
  return Array.isArray(value) ? value[0] : null;
}

function secondArrayValue(value) {
  return Array.isArray(value) ? value[1] : null;
}

function normalizeExplicit(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  return ['true', 'yes', 'explicit', '1'].includes(String(value).trim().toLowerCase());
}

function cleanLyrics(value) {
  return String(value || '').replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/\*/g, '').trim() + '\n';
}

function sourcePath(source, path) {
  return `${source}:${relativeToRepo(path)}`;
}

function ensureManifestSources(manifest, sources) {
  const result = { ...sources };
  for (const key of Object.keys(manifest)) {
    if (['field_sources', 'readiness'].includes(key)) continue;
    if (!result[key]) result[key] = isPresent(manifest[key]) ? 'derived' : 'missing';
  }
  return result;
}

function buildSummary({ songId, manifest, audio, cover, lyrics, blockingMissingFields, warnings }) {
  const rows = [
    ['Artist', manifest.artist, manifest.field_sources.artist],
    ['Release title', manifest.release_title, manifest.field_sources.release_title],
    ['Track title', manifest.track_title, manifest.field_sources.track_title],
    ['Primary genre', manifest.primary_genre, manifest.field_sources.primary_genre],
    ['Secondary genre', manifest.secondary_genre, manifest.field_sources.secondary_genre],
    ['Language', manifest.language, manifest.field_sources.language],
    ['Explicit', manifest.explicit, manifest.field_sources.explicit],
    ['AI generated', manifest.is_ai_generated, manifest.field_sources.is_ai_generated],
    ['AI disclosure', JSON.stringify(manifest.ai_disclosure), manifest.field_sources.ai_disclosure],
    ['Made for kids', manifest.made_for_kids, manifest.field_sources.made_for_kids],
    ['Release date', manifest.release_date, manifest.field_sources.release_date],
    ['Songwriter', manifest.songwriter, manifest.field_sources.songwriter],
    ['Songwriter real name', `${manifest.songwriter_real_name.first} ${manifest.songwriter_real_name.last}`, manifest.field_sources.songwriter_real_name],
    ['Producer', manifest.producer, manifest.field_sources.producer],
    ['Apple Music credits', JSON.stringify(manifest.apple_music_credits), manifest.field_sources.apple_music_credits],
    ['Copyright owner', manifest.copyright_owner, manifest.field_sources.copyright_owner],
  ];

  return [
    `# DistroKid Release Package: ${manifest.track_title || songId}`,
    '',
    `Song ID: ${songId}`,
    `Built: ${new Date().toISOString()}`,
    `Ready for dry-run: ${manifest.readiness.ready_for_distrokid_dry_run ? 'yes' : 'no'}`,
    '',
    '## Metadata',
    '',
    '| Field | Value | Source |',
    '| --- | --- | --- |',
    ...rows.map(([label, value, source]) => `| ${label} | ${formatMd(value)} | ${formatMd(source)} |`),
    '',
    '## Source Files',
    '',
    `- Audio source: ${audio.path ? relativeToRepo(audio.path) : 'missing'}`,
    `- Package audio: ${manifest.audio_file || 'missing'}`,
    `- Cover source: ${cover.path ? relativeToRepo(cover.path) : 'missing'}`,
    `- Package cover: ${manifest.cover_art || 'missing'}`,
    `- Lyrics source: ${lyrics.path ? relativeToRepo(lyrics.path) : lyrics.text ? lyrics.source : 'missing'}`,
    `- Package lyrics: ${manifest.lyrics_file || 'missing'}`,
    '',
    '## Missing And Warnings',
    '',
    `Blocking: ${blockingMissingFields.join(', ') || 'none'}`,
    `Warnings: ${warnings.join(', ') || 'none'}`,
    '',
    '## Manual DistroKid Review Checklist',
    '',
    '- Correct artist',
    '- Correct title',
    '- Correct release title',
    '- Correct audio file',
    '- Correct artwork',
    '- Explicit flag',
    '- AI-generated disclosure',
    '- Songwriter real name',
    '- Apple Music performer and producer credits',
    '- Made for Kids/COPPA flag',
    '- Genre',
    '- Language',
    '- Lyrics',
    '- Release date',
    '- Store selection',
    '- YouTube/Content ID options',
    '- Paid extras not accidentally selected',
    '- Certification checkboxes only if the legal statements are true',
    '- Final submit is still manual',
    '',
  ].join('\n');
}

function formatMd(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (Array.isArray(value)) return value.join(', ');
  return String(value).replace(/\|/g, '\\|');
}
