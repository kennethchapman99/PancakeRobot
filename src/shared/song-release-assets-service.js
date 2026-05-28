import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getAlbum, getSong } from './db.js';
import { buildMarketingReleasePack } from '../marketing/release-agent.js';
import { getSongBaseImageDir, resolveDefaultBaseImage, scanMarketingPack, scanSongBaseImage } from './song-catalog-marketing.js';
import { getSongMarketingKit, saveSongMarketingKit, syncSongMarketingKitFromPack } from './song-marketing-kit.js';
import { generateSocialImage } from '../visuals/image-provider.js';
import { findBrandProfileDefaultImage, getActiveProfileId, loadBrandProfile, loadBrandProfileById } from './brand-profile.js';
import { buildReleaseDerivatives, RELEASE_ASSET_TARGETS } from './release-asset-derivatives.js';

const GENERATED_ASSET_FIELDS = [
  'square_post_url',
  'vertical_post_url',
  'portrait_post_url',
  'outreach_banner_url',
  'cover_safe_promo_url',
  'no_text_variation_url',
];
export const DEFAULT_RELEASE_ASSET_FORMATS = Object.freeze([
  'spotify-cover-3000x3000.png',
  'youtube-thumbnail-1280x720.png',
  'instagram-square-1080x1080.png',
  'instagram-vertical-1080x1920.png',
  'facebook-post-1200x630.png',
]);
const serviceHooks = {
  buildMarketingReleasePack: null,
};

const OUTPUT_ROOT = path.join(process.cwd(), 'output');
const ENTITY_TYPE_ALBUM = 'album';
const ENTITY_TYPE_SONG = 'song';
const ENTITY_TYPE_SINGLE = 'single';

const ASSET_FIELD_BY_FORMAT = Object.freeze({
  'spotify-cover-3000x3000.png': 'cover_safe_promo_url',
  'youtube-thumbnail-1280x720.png': 'no_text_variation_url',
  'instagram-square-1080x1080.png': 'square_post_url',
  'instagram-vertical-1080x1920.png': 'vertical_post_url',
  'facebook-post-1200x630.png': 'outreach_banner_url',
});

function requireSong(songId) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);
  return song;
}

function requireAlbum(albumId) {
  const album = getAlbum(albumId);
  if (!album) throw new Error(`Album not found: ${albumId}`);
  return album;
}

function normalizeEntityType(entityType) {
  if (entityType === ENTITY_TYPE_ALBUM) return ENTITY_TYPE_ALBUM;
  if (entityType === ENTITY_TYPE_SINGLE) return ENTITY_TYPE_SONG;
  return ENTITY_TYPE_SONG;
}

function albumReferenceDir(albumId) {
  return path.join(OUTPUT_ROOT, 'albums', albumId, 'reference');
}

function albumAssetsDir(albumId) {
  return path.join(OUTPUT_ROOT, 'albums', albumId, 'assets');
}

function songAssetsDir(songId) {
  return path.join(OUTPUT_ROOT, 'marketing-ready', songId);
}

function albumReleasePackageManifestPath(albumId) {
  return path.join(OUTPUT_ROOT, 'release-packages', albumId, 'manifest.json');
}

function mediaUrl(absPath) {
  return '/media/' + path.relative(OUTPUT_ROOT, absPath).replace(/\\/g, '/');
}

function readJson(filePath) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}

function fileFingerprint(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stats = fs.statSync(filePath);
  const hash = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return `${hash}:${stats.size}`;
}

function findAlbumPrimaryImage(albumId) {
  const refDir = albumReferenceDir(albumId);
  const primaryFile = fs.existsSync(refDir)
    ? fs.readdirSync(refDir).find(name => /^primary-image\.(png|jpe?g|webp)$/i.test(name))
    : null;
  return primaryFile ? {
    path: path.join(refDir, primaryFile),
    url: mediaUrl(path.join(refDir, primaryFile)),
    name: primaryFile,
    source: 'album_media',
    source_label: 'Album media',
  } : null;
}

function resolveRepoPath(filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

function toPublicUrlFromAssetPath(filePath) {
  const resolvedPath = resolveRepoPath(filePath);
  if (!resolvedPath || !resolvedPath.startsWith(OUTPUT_ROOT) || !fs.existsSync(resolvedPath)) return null;
  return mediaUrl(resolvedPath);
}

function readCanonicalAlbumPackageMedia(albumId) {
  const manifest = readJson(albumReleasePackageManifestPath(albumId));
  if (!manifest || manifest.release_type !== ENTITY_TYPE_ALBUM) return null;

  const generatedAssets = Array.isArray(manifest.inherited_album_media?.assets)
    ? manifest.inherited_album_media.assets.map(asset => {
        const filePath = asset?.filePath || asset?.path || null;
        return {
          ...asset,
          path: filePath,
          publicUrl: asset?.publicUrl || toPublicUrlFromAssetPath(filePath),
        };
      })
    : [];

  const inheritedAssetPrimary = generatedAssets.find(asset => {
    const assetPath = resolveRepoPath(asset?.path);
    return assetPath && fs.existsSync(assetPath);
  }) || null;
  const primaryCandidate = resolveRepoPath(
    manifest.cover_art
    || manifest.inherited_album_media?.primary_image
    || inheritedAssetPrimary?.path
  );
  const primaryImage = primaryCandidate && fs.existsSync(primaryCandidate)
    ? {
        path: primaryCandidate,
        url: mediaUrl(primaryCandidate),
        name: path.basename(primaryCandidate),
        source: 'canonical_package_media',
        source_label: inheritedAssetPrimary?.path && path.resolve(primaryCandidate) === path.resolve(resolveRepoPath(inheritedAssetPrimary.path))
          ? 'Inherited album media'
          : 'Canonical package media',
      }
    : null;

  if (!primaryImage && generatedAssets.length === 0) return null;
  return {
    primaryImage,
    metadata: generatedAssets.length
      ? {
          generated_assets: generatedAssets,
          primary_image_fingerprint: primaryImage?.path ? fileFingerprint(primaryImage.path) : null,
          source: 'canonical_package_media',
        }
      : null,
  };
}

function derivativeStateFor(owner, metadata) {
  const byName = new Map((metadata?.generated_assets || []).map(asset => [asset.name || asset.format, asset]));
  return RELEASE_ASSET_TARGETS.map(target => {
    const asset = byName.get(target.fileName);
    return asset ? {
      ...asset,
      label: asset.label || target.label,
      format: asset.format || target.fileName,
      dimensions: asset.dimensions || { width: target.width, height: target.height },
      publicUrl: asset.publicUrl || (asset.path ? toPublicUrlFromAssetPath(asset.path) : null),
    } : {
      name: target.fileName,
      format: target.fileName,
      label: target.label,
      dimensions: { width: target.width, height: target.height },
      status: 'missing',
      publicUrl: null,
    };
  });
}

function applySongAssetFields(songId, assets, generatedAt) {
  const patch = { generated_at: generatedAt || new Date().toISOString(), generation_source: 'release_asset_derivatives' };
  for (const asset of assets || []) {
    const field = ASSET_FIELD_BY_FORMAT[asset.format || asset.name];
    if (field) patch[field] = asset.publicUrl || '';
  }
  const baseImage = scanSongBaseImage(songId);
  if (baseImage?.url) patch.base_image_url = baseImage.url;
  return saveSongMarketingKit(songId, { marketing_assets: patch });
}

function assertEditableOwner(entityType, entityId) {
  const owner = getReleaseAssetOwner(entityType, entityId);
  if (owner.inheritedFrom) {
    throw new Error(`Song ${entityId} inherits release assets from album ${owner.id}; edit album assets instead.`);
  }
  return owner;
}

function ownerTitle(owner) {
  if (owner.type === ENTITY_TYPE_ALBUM) {
    const album = requireAlbum(owner.id);
    return album.album_title || album.album_theme || album.id;
  }
  const song = requireSong(owner.id);
  return song.title || song.topic || song.id;
}

function ownerArtist() {
  const brandProfile = loadBrandProfile();
  return brandProfile.distribution?.default_artist || brandProfile.brand_name || 'Pancake Robot';
}

function ownerOutputDir(owner) {
  return owner.type === ENTITY_TYPE_ALBUM ? albumAssetsDir(owner.id) : songAssetsDir(owner.id);
}

function ownerPrimaryImage(owner) {
  if (owner.type === ENTITY_TYPE_ALBUM) {
    const albumImage = findAlbumPrimaryImage(owner.id);
    if (albumImage) return albumImage;
    const packageMedia = readCanonicalAlbumPackageMedia(owner.id);
    if (packageMedia?.primaryImage) return packageMedia.primaryImage;
    const album = requireAlbum(owner.id);
    return localBrandDefaultImage(album.brand_profile_id || getActiveProfileId());
  }

  const songImage = scanSongBaseImage(owner.id);
  if (songImage) return { ...songImage, source: 'song_media', source_label: 'Song media' };
  const song = requireSong(owner.id);
  return localBrandDefaultImage(song.brand_profile_id || getActiveProfileId());
}

function localBrandDefaultImage(profileId) {
  const image = findBrandProfileDefaultImage(profileId);
  if (!image?.path || !fs.existsSync(image.path)) return null;
  return {
    ...image,
    inherited: true,
    inheritedFrom: { type: 'brand', id: profileId, title: image.profileName || profileId },
    source: 'brand_media',
    source_label: image.source_label || image.sourceLabel || `Brand default image: ${image.profileName || profileId}`,
  };
}

function ownerMetadata(owner) {
  const liveMetadata = readJson(path.join(ownerOutputDir(owner), 'metadata.json'));
  if (liveMetadata) return liveMetadata;
  if (owner.type === ENTITY_TYPE_ALBUM) return readCanonicalAlbumPackageMedia(owner.id)?.metadata || null;
  return null;
}

export function getReleaseAssetOwner(entityType, entityId) {
  const normalizedType = normalizeEntityType(entityType);
  if (normalizedType === ENTITY_TYPE_ALBUM) {
    requireAlbum(entityId);
    return { type: ENTITY_TYPE_ALBUM, id: entityId, inheritedFrom: null };
  }

  const song = requireSong(entityId);
  if (song.album_id) {
    const album = requireAlbum(song.album_id);
    return {
      type: ENTITY_TYPE_ALBUM,
      id: album.id,
      inheritedFrom: { type: ENTITY_TYPE_ALBUM, id: album.id, title: album.album_title || album.album_theme || album.id },
      requestedSong: { id: song.id, title: song.title || song.topic || song.id },
    };
  }

  return { type: ENTITY_TYPE_SONG, id: song.id, inheritedFrom: null };
}

export function getReleaseAssetState(entityType, entityId) {
  const owner = getReleaseAssetOwner(entityType, entityId);
  const primaryImage = ownerPrimaryImage(owner);
  const metadata = ownerMetadata(owner);
  const currentFingerprint = primaryImage?.path ? fileFingerprint(primaryImage.path) : null;
  const stale = Boolean(
    primaryImage?.path
    && (
      !metadata
      || metadata.primary_image_fingerprint !== currentFingerprint
      || !Array.isArray(metadata.generated_assets)
      || metadata.generated_assets.length < RELEASE_ASSET_TARGETS.length
    )
  );
  const dashboardPath = path.join(ownerOutputDir(owner), 'index.html');
  const dashboardUrl = fs.existsSync(dashboardPath) ? mediaUrl(dashboardPath) : null;
  const assets = derivativeStateFor(owner, metadata);
  return {
    ok: true,
    entityType: normalizeEntityType(entityType),
    entityId,
    owner,
    inheritedFrom: owner.inheritedFrom,
    primaryImage,
    primaryImageFingerprint: currentFingerprint,
    derivativesStale: stale,
    dashboardUrl,
    previewUrl: owner.type === ENTITY_TYPE_ALBUM
      ? `/api/albums/${encodeURIComponent(owner.id)}/release-assets/preview`
      : `/api/songs/${encodeURIComponent(owner.id)}/release-assets/preview`,
    downloadUrl: owner.type === ENTITY_TYPE_ALBUM
      ? `/api/albums/${encodeURIComponent(owner.id)}/release-assets/download`
      : `/api/songs/${encodeURIComponent(entityId)}/release-assets/download`,
    metadata,
    assets,
  };
}

export async function ensureReleaseAssetDerivatives(entityType, entityId, options = {}) {
  const owner = getReleaseAssetOwner(entityType, entityId);
  const before = getReleaseAssetState(entityType, entityId);
  if (!before.primaryImage?.path) throw new Error('Upload/select a primary image first, or set a brand default image on the Brand Bible.');
  if (!options.force && !before.derivativesStale) return before;

  const result = await buildReleaseDerivatives({
    entityType: owner.type === ENTITY_TYPE_ALBUM ? ENTITY_TYPE_ALBUM : ENTITY_TYPE_SINGLE,
    entityId: owner.id,
    title: ownerTitle(owner),
    artist: ownerArtist(),
    sourceImagePath: before.primaryImage.path,
    sourceImageFingerprint: before.primaryImageFingerprint,
    outputDir: ownerOutputDir(owner),
    provider: options.provider || 'manual',
  });
  if (owner.type === ENTITY_TYPE_SONG) {
    applySongAssetFields(owner.id, result.assets, result.metadata.generated_at);
  }
  return getReleaseAssetState(entityType, entityId);
}

export function markReleaseAssetsStale(entityType, entityId) {
  const owner = getReleaseAssetOwner(entityType, entityId);
  const metadataPath = path.join(ownerOutputDir(owner), 'metadata.json');
  const metadata = readJson(metadataPath);
  if (metadata) {
    metadata.primary_image_fingerprint = null;
    metadata.stale = true;
    metadata.stale_at = new Date().toISOString();
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  }
  if (owner.type === ENTITY_TYPE_SONG) {
    const kit = getSongMarketingKit(owner.id);
    const patch = { ...kit.marketing_assets, generated_at: '' };
    for (const field of GENERATED_ASSET_FIELDS) patch[field] = '';
    saveSongMarketingKit(owner.id, { marketing_assets: patch });
  }
  return getReleaseAssetState(entityType, entityId);
}

export function setPrimaryImage(entityType, entityId, sourcePath, options = {}) {
  const owner = assertEditableOwner(entityType, entityId);
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Primary image source was not found.');
  const ext = path.extname(sourcePath).toLowerCase() || '.png';
  const refDir = owner.type === ENTITY_TYPE_ALBUM ? albumReferenceDir(owner.id) : getSongBaseImageDir(owner.id);
  const stem = owner.type === ENTITY_TYPE_ALBUM ? 'primary-image' : 'base-image';
  fs.mkdirSync(refDir, { recursive: true });
  for (const name of fs.readdirSync(refDir)) {
    if (new RegExp(`^${stem}\\.(png|jpe?g|webp)$`, 'i').test(name)) fs.unlinkSync(path.join(refDir, name));
  }
  const dest = path.join(refDir, `${stem}${ext}`);
  if (path.resolve(sourcePath) !== path.resolve(dest)) fs.copyFileSync(sourcePath, dest);
  if (owner.type === ENTITY_TYPE_SONG) {
    const scanned = scanSongBaseImage(owner.id);
    saveSongMarketingKit(owner.id, {
      marketing_assets: {
        base_image_url: scanned?.url || '',
        generation_source: options.generationSource || 'manual_primary_image',
      },
    });
  }
  return markReleaseAssetsStale(owner.type, owner.id);
}

export async function generatePrimaryImageWithOpenAI(entityType, entityId, input = {}) {
  const owner = assertEditableOwner(entityType, entityId);
  const result = await generateReleaseImage({
    ...input,
    entityType: owner.type === ENTITY_TYPE_ALBUM ? ENTITY_TYPE_ALBUM : ENTITY_TYPE_SINGLE,
    entityId: owner.id,
  });
  if (result.ok !== false) markReleaseAssetsStale(owner.type, owner.id);
  return result;
}

function pickGeneratedAssets(marketingAssets = {}) {
  return Object.fromEntries(GENERATED_ASSET_FIELDS.map(field => [field, marketingAssets[field] || '']));
}

function buildWarningFromImageSource(imageSource = {}) {
  if (!imageSource?.source_label) return '';
  return `Release-specific base image cleared. Now using: ${imageSource.source_label}.`;
}

function extensionForMime(mime = '') {
  if (/jpe?g/i.test(mime)) return '.jpg';
  if (/webp/i.test(mime)) return '.webp';
  return '.png';
}

function baseCharacterDescription(brandProfile) {
  const character = brandProfile.character || {};
  const references = Array.isArray(character.visual_reference) ? character.visual_reference.join('; ') : '';
  return [
    character.name ? `Feature ${character.name}.` : '',
    character.visual_identity || character.core_concept || character.fallback_summary || '',
    references,
    'Keep the Pancake Robot character visually consistent with the existing base image library in the repo.',
    'Album-cover quality composition, polished, vivid, not clipart.',
    'No readable text, logos, watermarks, song titles, or typography inside the image.',
  ].filter(Boolean).join(' ');
}

export function selectSongPrimaryImage(songId, sourcePath, options = {}) {
  assertEditableOwner(ENTITY_TYPE_SONG, songId);
  const resolvedSource = sourcePath && fs.existsSync(sourcePath)
    ? sourcePath
    : options.useDefaultBaseImage
      ? resolveDefaultBaseImage(songId)?.path
      : null;
  if (!resolvedSource) throw new Error('Primary image source was not found.');

  const ext = path.extname(resolvedSource).toLowerCase() || '.png';
  const refDir = getSongBaseImageDir(songId);
  fs.mkdirSync(refDir, { recursive: true });
  for (const name of fs.existsSync(refDir) ? fs.readdirSync(refDir) : []) {
    if (/^base-image\.(png|jpe?g|webp)$/i.test(name)) fs.unlinkSync(path.join(refDir, name));
  }
  const dest = path.join(refDir, `base-image${ext}`);
  fs.copyFileSync(resolvedSource, dest);
  const scanned = scanSongBaseImage(songId);
  const kit = saveSongMarketingKit(songId, {
    marketing_assets: {
      base_image_url: scanned?.url || '',
      generation_source: options.generationSource || 'manual_primary_image',
    },
  });
  markReleaseAssetsStale(ENTITY_TYPE_SONG, songId);
  return { ok: true, songId, primaryImage: scanned, marketingAssets: kit.marketing_assets, imageSource: kit.image_source };
}

export async function generateReleaseImage(input = {}) {
  const entityType = input.entityType === 'album' ? 'album' : 'single';
  const song = entityType === 'single' ? requireSong(input.entityId) : null;
  const album = entityType === 'album' ? getAlbum(input.entityId) : null;
  if (entityType === 'album' && !album) throw new Error(`Album not found: ${input.entityId}`);
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, code: 'missing_openai_key', error: 'OPENAI_API_KEY is not set. Upload or select a manual image instead.' };
  }

  const brandProfile = input.brandProfileId ? loadBrandProfileById(input.brandProfileId) : loadBrandProfile();
  const title = input.title || song?.title || song?.topic || album?.album_title || album?.album_theme || input.entityId;
  const artist = input.artist || brandProfile.distribution?.default_artist || brandProfile.brand_name || 'Pancake Robot';
  const prompt = [
    `Create primary cover art for the ${entityType} "${title}" by ${artist}.`,
    input.prompt || song?.concept || song?.topic || album?.album_theme || '',
    baseCharacterDescription(brandProfile),
    input.styleGuardrails || brandProfile.visuals?.style || brandProfile.visual_style?.style || '',
  ].filter(Boolean).join('\n');

  const refDir = entityType === 'single'
    ? getSongBaseImageDir(song.id)
    : path.join(process.cwd(), 'output', 'albums', album.id, 'reference');
  const ext = extensionForMime(input.outputMime);
  const outputPath = path.join(refDir, entityType === 'single' ? `base-image${ext}` : `primary-image${ext}`);
  const result = await generateSocialImage('spotify_square', prompt, outputPath, {
    provider: 'openai',
    quality: input.quality || 'high',
  });
  const metadataPath = path.join(refDir, entityType === 'single' ? 'base-image.metadata.json' : 'primary-image.metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify({
    entityType,
    entityId: input.entityId,
    title,
    artist,
    provider: result.provider,
    model: result.model,
    prompt,
    dimensions: result.size,
    outputKind: input.outputKind || 'cover',
    referenceAssetIds: input.referenceAssetIds || [],
    referenceNote: 'The Image API call is text-to-image here; base repo character images are represented in the prompt guardrails.',
    usage: result.usage || null,
    created_at: result.created_at || new Date().toISOString(),
    path: outputPath,
  }, null, 2));
  if (entityType === 'single') {
    const scanned = scanSongBaseImage(song.id);
    const kit = saveSongMarketingKit(song.id, {
      marketing_assets: {
        base_image_url: scanned?.url || '',
        generated_at: new Date().toISOString(),
        generation_source: 'openai_image_generation',
      },
    });
    return { ok: true, songId: song.id, entityType, entityId: song.id, primaryImage: scanned, metadataPath, providerResult: result, marketingAssets: kit.marketing_assets };
  }
  return {
    ok: true,
    albumId: album.id,
    entityType,
    entityId: album.id,
    primaryImage: {
      path: outputPath,
      url: `/media/albums/${encodeURIComponent(album.id)}/reference/${encodeURIComponent(path.basename(outputPath))}`,
    },
    metadataPath,
    providerResult: result,
  };
}

export function getSongReleaseAssetState(songId, options = {}) {
  const canonicalState = getReleaseAssetState(ENTITY_TYPE_SONG, songId);
  if (canonicalState.owner.type === ENTITY_TYPE_ALBUM) {
    return {
      ...canonicalState,
      songId,
      generatedAssets: {},
      marketingAssets: {},
      imageSource: {
        active_image_url: canonicalState.primaryImage?.url || '',
        source_label: canonicalState.primaryImage?.source_label || `Inherited from album: ${canonicalState.inheritedFrom?.title || canonicalState.owner.id}`,
        generation_source: canonicalState.primaryImage?.generation_source || 'album_inherited',
      },
      qaWarnings: [],
      qaFailures: [],
    };
  }

  const marketingPack = options.marketingPack || scanMarketingPack(songId);
  const marketingKit = options.marketingKit || getSongMarketingKit(songId, { marketingPack });

  return {
    ...canonicalState,
    ok: true,
    songId,
    dashboardUrl: marketingPack.dashboardUrl || null,
    manifest: marketingPack.manifest || null,
    generatedAssets: pickGeneratedAssets(marketingKit.marketing_assets),
    marketingAssets: marketingKit.marketing_assets,
    imageSource: marketingKit.image_source,
    qaWarnings: marketingPack.meta?.qa_warnings || [],
    qaFailures: marketingPack.meta?.qa_failures || [],
  };
}

export function clearSongBaseImage(songId, options = {}) {
  assertEditableOwner(ENTITY_TYPE_SONG, songId);

  const refDir = getSongBaseImageDir(songId);
  const deletedFiles = [];
  if (fs.existsSync(refDir)) {
    for (const name of fs.readdirSync(refDir)) {
      if (!/^base-image\.[A-Za-z0-9]+$/i.test(name)) continue;
      const absPath = path.join(refDir, name);
      fs.unlinkSync(absPath);
      deletedFiles.push(absPath);
    }
  }

  const currentKit = getSongMarketingKit(songId);
  const assetPatch = {
    ...currentKit.marketing_assets,
    base_image_url: '',
    generated_at: '',
    generation_source: currentKit.marketing_assets.generation_source === 'release_base_image'
      ? ''
      : currentKit.marketing_assets.generation_source,
  };

  if (options.clearGeneratedAssets !== false) {
    for (const field of GENERATED_ASSET_FIELDS) assetPatch[field] = '';
  }

  const refreshedKit = saveSongMarketingKit(songId, { marketing_assets: assetPatch });
  markReleaseAssetsStale(ENTITY_TYPE_SONG, songId);
  const rescannedBaseImage = scanSongBaseImage(songId);
  const imageSource = refreshedKit.image_source;
  const warning = !rescannedBaseImage && imageSource?.generation_source !== 'release_base_image'
    ? buildWarningFromImageSource(imageSource)
    : '';

  return {
    ok: true,
    songId,
    deletedFiles,
    imageSource,
    marketingAssets: refreshedKit.marketing_assets,
    warning,
  };
}

export async function buildSongReleaseAssets(songId, options = {}) {
  const owner = getReleaseAssetOwner(ENTITY_TYPE_SONG, songId);
  if (owner.type === ENTITY_TYPE_ALBUM) {
    const state = await ensureReleaseAssetDerivatives(ENTITY_TYPE_SONG, songId, { force: options.force === true });
    return {
      ok: true,
      songId,
      owner,
      dashboardUrl: state.dashboardUrl,
      generatedAssets: {},
      marketingAssets: {},
      imageSource: { active_image_url: state.primaryImage?.url || '', source_label: state.primaryImage?.source_label || `Inherited from album: ${state.inheritedFrom?.title || owner.id}` },
      qaWarnings: [],
      qaFailures: [],
    };
  }

  if (!options.builder && !serviceHooks.buildMarketingReleasePack && options.useCanonicalDerivatives !== false) {
    const state = await ensureReleaseAssetDerivatives(ENTITY_TYPE_SONG, songId, { force: options.force === true });
    const marketingKit = getSongMarketingKit(songId);
    return {
      ok: true,
      songId,
      dashboardUrl: state.dashboardUrl,
      generatedAssets: pickGeneratedAssets(marketingKit.marketing_assets),
      marketingAssets: marketingKit.marketing_assets,
      imageSource: marketingKit.image_source,
      qaWarnings: [],
      qaFailures: [],
    };
  }

  const normalizedOptions = {
    mode: 'render_from_existing_visuals',
    renderVideos: false,
    formats: DEFAULT_RELEASE_ASSET_FORMATS,
    ...options,
  };
  const builder = options.builder || serviceHooks.buildMarketingReleasePack || buildMarketingReleasePack;
  const result = await builder(songId, normalizedOptions);
  const marketingPack = scanMarketingPack(songId);
  const marketingKit = syncSongMarketingKitFromPack(songId, { marketingPack });
  const state = getSongReleaseAssetState(songId, { marketingPack, marketingKit });
  const syncWarning = result.marketingKitSyncError
    ? `Marketing kit sync warning: ${result.marketingKitSyncError}`
    : null;

  return {
    ok: result.ok,
    songId,
    dashboardUrl: state.dashboardUrl,
    generatedAssets: state.generatedAssets,
    marketingAssets: state.marketingAssets,
    imageSource: state.imageSource,
    qaWarnings: syncWarning ? [...state.qaWarnings, syncWarning] : state.qaWarnings,
    qaFailures: state.qaFailures,
  };
}

export function setSongReleaseAssetsServiceHooks(hooks = {}) {
  serviceHooks.buildMarketingReleasePack = hooks.buildMarketingReleasePack || null;
}
