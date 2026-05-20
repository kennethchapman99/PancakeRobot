/**
 * Premium hero art generation for Marketing Release Agent.
 *
 * Generates a tiny set of master visuals per song, then the deterministic
 * renderer handles all final platform crops, text overlays, and MP4 assembly.
 */

import fs from 'fs';
import { basename, dirname, extname, join, relative } from 'path';
import { createCanvas, loadImage } from 'canvas';

const DEFAULT_OPENAI_MODEL = process.env.MARKETING_OPENAI_IMAGE_MODEL || 'gpt-image-1';
const CF_MODEL = process.env.MARKETING_CLOUDFLARE_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';

function exists(path) {
  return path && fs.existsSync(path);
}

function truthy(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function safeInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rel(assets, path) {
  return path ? relative(assets.repoRoot, path) : null;
}

function outputRel(assets, path) {
  return path ? relative(assets.outputDir, path) : null;
}

function imageMime(path) {
  const ext = extname(path || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function readReferenceSummary(referencePath) {
  if (!referencePath) return 'No reference image found; use the Pancake Robot brand identity from the song cover if available.';
  return `Use ${basename(referencePath)} as the primary visual continuity reference. Keep the Pancake Robot character consistent with that asset.`;
}

function bestReferenceAsset(assets) {
  const priorSquare = join(assets.dirs.sourceDir, 'hero_square_3000x3000.png');
  const priorPortrait = join(assets.dirs.sourceDir, 'hero_portrait_1080x1920.png');
  const candidates = [
    process.env.MARKETING_CHARACTER_ASSET,
    priorSquare,
    priorPortrait,
    assets.source.copiedCover,
    assets.source.coverPath,
    assets.source.copiedCharacter,
    assets.source.characterPath,
    join(assets.repoRoot, 'assets/pancake-robot-character.png'),
    join(assets.repoRoot, 'assets/pancake-robot-avatar.png'),
    join(assets.repoRoot, 'src/web/public/logo.png'),
  ];
  return candidates.find(exists) || null;
}

function buildPrompt({ assets, referencePath, format }) {
  const topic = assets.song?.topic || assets.metadata?.topic || assets.title;
  const concept = assets.song?.concept || assets.metadata?.concept || topic;
  const sceneLine = `${assets.title}: ${concept}`;
  const referenceLine = readReferenceSummary(referencePath);
  const aspectLine = format === 'portrait'
    ? 'Vertical 9:16 poster composition, strong subject in the center, safe space for text overlays in top and bottom thirds.'
    : format === 'landscape'
      ? 'Wide 16:9 cinematic composition, strong subject on one side, open negative space for future title overlay.'
      : 'Square album-cover composition, centered character, clean read at small size.';

  return [
    'Premium polished children\'s music cover art.',
    'Cute cheerful Pancake Robot character, friendly robot made for kids music, whimsical but not cluttered.',
    referenceLine,
    `Song scene: ${sceneLine}.`,
    aspectLine,
    'Bright warm lighting, saturated kid-friendly palette, glossy 3D cartoon / high quality illustrated album art, charming facial expression, clean background depth.',
    'No words, no letters, no captions, no logos, no watermark, no misspelled text.',
  ].join(' ');
}

function getHeroSpecs(count) {
  const specs = [
    {
      key: 'square',
      filename: 'hero_square_3000x3000.png',
      width: 3000,
      height: 3000,
      format: 'square',
      openaiSize: '1024x1024',
      purpose: 'Premium square master visual for feed posts, square posts, and cover-style derivatives',
    },
    {
      key: 'portrait',
      filename: 'hero_portrait_1080x1920.png',
      width: 1080,
      height: 1920,
      format: 'portrait',
      openaiSize: '1024x1536',
      purpose: 'Premium vertical master visual for reels, stories, TikTok, and portrait covers',
    },
  ];

  if (count >= 3) {
    specs.push({
      key: 'landscape',
      filename: 'hero_landscape_1920x1080.png',
      width: 1920,
      height: 1080,
      format: 'landscape',
      openaiSize: '1536x1024',
      purpose: 'Optional wide master visual for YouTube-style thumbnails and future horizontal derivatives',
    });
  }
  return specs;
}

async function writeBufferToSpec(buffer, outputPath, spec) {
  fs.mkdirSync(dirname(outputPath), { recursive: true });
  const tmpPath = outputPath.replace(/\.png$/i, '.generated-source.png');
  fs.writeFileSync(tmpPath, buffer);
  try {
    const img = await loadImage(tmpPath);
    const canvas = createCanvas(spec.width, spec.height);
    const ctx = canvas.getContext('2d');
    const scale = Math.max(spec.width / img.width, spec.height / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    ctx.drawImage(img, (spec.width - iw) / 2, (spec.height - ih) / 2, iw, ih);
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

async function createFallbackHeroImage({ assets, spec, outputPath, referencePath }) {
  const canvas = createCanvas(spec.width, spec.height);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, spec.width, spec.height);
  gradient.addColorStop(0, '#FFF3D7');
  gradient.addColorStop(0.5, '#FDE7B0');
  gradient.addColorStop(1, '#95E0EF');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, spec.width, spec.height);

  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#FFFFFF';
  for (let i = 0; i < 18; i++) {
    const x = (i * 337) % spec.width;
    const y = (i * 521) % spec.height;
    const r = Math.max(42, Math.min(spec.width, spec.height) * (0.03 + (i % 4) * 0.01));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  if (referencePath && exists(referencePath)) {
    try {
      const img = await loadImage(referencePath);
      const maxW = spec.width * (spec.format === 'landscape' ? 0.48 : 0.72);
      const maxH = spec.height * (spec.format === 'square' ? 0.70 : 0.62);
      const scale = Math.min(maxW / img.width, maxH / img.height);
      const iw = img.width * scale;
      const ih = img.height * scale;
      const x = (spec.width - iw) / 2;
      const y = spec.format === 'portrait' ? spec.height * 0.25 : (spec.height - ih) / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.24)';
      ctx.shadowBlur = Math.max(24, spec.width * 0.025);
      ctx.shadowOffsetY = Math.max(12, spec.height * 0.012);
      ctx.drawImage(img, x, y, iw, ih);
      ctx.restore();
    } catch {}
  }

  fs.mkdirSync(dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

async function callOpenAIImage({ prompt, spec }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_OPENAI_MODEL,
      prompt,
      size: spec.openaiSize,
      n: 1,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI image API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const item = json.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error(`OpenAI image URL fetch failed: ${imgRes.status}`);
    return Buffer.from(await imgRes.arrayBuffer());
  }
  throw new Error('OpenAI image API returned no usable image data');
}

async function callCloudflareImage({ prompt }) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;
  if (!accountId || !apiToken || accountId === '...' || apiToken === '...') {
    throw new Error('CF_ACCOUNT_ID / CF_API_TOKEN are not set');
  }

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, num_steps: 4 }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudflare image API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.success) {
    const errs = (json.errors || []).map(e => e.message || JSON.stringify(e)).join('; ');
    throw new Error(`Cloudflare generation failed: ${errs}`);
  }
  const imageBase64 = json.result?.image;
  if (!imageBase64) throw new Error('Cloudflare returned no image data');
  return Buffer.from(imageBase64, 'base64');
}

async function generateWithProvider({ provider, prompt, spec }) {
  if (provider === 'openai') return callOpenAIImage({ prompt, spec });
  if (provider === 'cloudflare') return callCloudflareImage({ prompt, spec });
  throw new Error(`Unsupported marketing image provider: ${provider}`);
}

export async function generateHeroArt(assets, options = {}) {
  const enabled = truthy(options.usePremiumHeroArt ?? process.env.MARKETING_USE_PREMIUM_HERO_ART, true);
  const count = safeInt(options.imageCount ?? process.env.MARKETING_IMAGE_COUNT, 2);
  const provider = String(options.imageProvider || process.env.MARKETING_IMAGE_PROVIDER || 'openai').toLowerCase();
  const fallbackProvider = String(options.fallbackProvider || process.env.MARKETING_IMAGE_FALLBACK_PROVIDER || 'cloudflare').toLowerCase();
  const referencePath = bestReferenceAsset(assets);
  const specs = getHeroSpecs(count);
  const prompts = Object.fromEntries(specs.map(spec => [spec.key, buildPrompt({ assets, referencePath, format: spec.format })]));
  const warnings = [];
  const generated = [];
  let providerUsed = null;
  let fallbackUsed = false;

  if (!enabled) {
    return {
      enabled: false,
      provider,
      provider_used: null,
      fallback_used: false,
      reference_path: rel(assets, referencePath),
      reference_mime: imageMime(referencePath),
      prompts,
      generated,
      warnings: ['MARKETING_USE_PREMIUM_HERO_ART=false'],
      hero: {},
    };
  }

  for (const spec of specs) {
    const outputPath = join(assets.dirs.sourceDir, spec.filename);
    const prompt = prompts[spec.key];
    let buffer = null;
    let used = provider;

    try {
      buffer = await generateWithProvider({ provider, prompt, spec });
      providerUsed = providerUsed || provider;
    } catch (primaryErr) {
      warnings.push(`${spec.filename}: ${provider} failed: ${primaryErr.message}`);
      try {
        buffer = await generateWithProvider({ provider: fallbackProvider, prompt, spec });
        used = fallbackProvider;
        providerUsed = providerUsed || fallbackProvider;
        fallbackUsed = true;
      } catch (fallbackErr) {
        warnings.push(`${spec.filename}: ${fallbackProvider} failed: ${fallbackErr.message}`);
      }
    }

    if (buffer) {
      await writeBufferToSpec(buffer, outputPath, spec);
      generated.push({
        key: spec.key,
        filename: spec.filename,
        path: outputPath,
        relative_path: outputRel(assets, outputPath),
        repo_relative_path: rel(assets, outputPath),
        resolution: `${spec.width}x${spec.height}`,
        provider_used: used,
        purpose: spec.purpose,
      });
    } else {
      fallbackUsed = true;
      await createFallbackHeroImage({ assets, spec, outputPath, referencePath });
      generated.push({
        key: spec.key,
        filename: spec.filename,
        path: outputPath,
        relative_path: outputRel(assets, outputPath),
        repo_relative_path: rel(assets, outputPath),
        resolution: `${spec.width}x${spec.height}`,
        provider_used: 'deterministic_reference_fallback',
        purpose: spec.purpose,
      });
    }
  }

  const hero = Object.fromEntries(generated.map(item => [item.key, item.path]));
  assets.source.heroSquarePath = hero.square || null;
  assets.source.heroPortraitPath = hero.portrait || null;
  assets.source.heroLandscapePath = hero.landscape || null;
  assets.relative.heroSquarePath = rel(assets, hero.square);
  assets.relative.heroPortraitPath = rel(assets, hero.portrait);
  assets.relative.heroLandscapePath = rel(assets, hero.landscape);

  return {
    enabled,
    provider,
    fallback_provider: fallbackProvider,
    provider_used: providerUsed || 'deterministic_reference_fallback',
    fallback_used: fallbackUsed,
    reference_path: rel(assets, referencePath),
    reference_mime: imageMime(referencePath),
    prompts,
    generated,
    warnings,
    hero,
  };
}
