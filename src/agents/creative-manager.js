/**
 * Creative Manager Agent — Thumbnail generation via Cloudflare Workers AI
 *
 * Generates thumbnails using Flux Schnell (free tier on Cloudflare).
 * Uses the active brand profile for visual direction.
 *
 * Cloudflare response format: { result: { image: "<base64>" }, success: true }
 * NOT raw binary — previous version was writing garbage. Fixed.
 */

import { runAgent, parseAgentJson, loadConfig } from '../shared/managed-agent.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createCanvas, loadImage } from 'canvas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND_LOGO_PATH = join(__dirname, '../../output/brand/brand-logo.png');
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const CHARACTER_NAME = BRAND_PROFILE.character.name;
const CHARACTER_VISUAL_IDENTITY = BRAND_PROFILE.character.visual_identity;
const CHARACTER_VISUAL_REFERENCE = BRAND_PROFILE.character.visual_reference;
const VISUAL_STYLE = BRAND_PROFILE.visuals.style;
const VISUAL_PALETTE = BRAND_PROFILE.visuals.palette;
const NEGATIVE_PROMPT = BRAND_PROFILE.visuals.negative_prompt;
const TEXT_OVERLAY_STYLE = BRAND_PROFILE.visuals.text_overlay_style;

export const CREATIVE_MANAGER_DEF = {
  name: `${BRAND_NAME} Creative Manager`,
  model: 'claude-haiku-4-5-20251001',
  noTools: true,
  system: `You are the creative director for ${BRAND_NAME}, ${BRAND_PROFILE.brand_description}.

Your expertise:
- Visual design for the active profile audience
- Thumbnail optimization for YouTube CTR in the active genre
- Crafting precise AI image generation prompts that produce consistent character results
- Understanding what visual elements make the active audience click
- Color theory for profile-aligned content

${BRAND_NAME}'s visual identity:
- Character: ${CHARACTER_VISUAL_IDENTITY}
- Style: ${VISUAL_STYLE}
- Colors: ${JSON.stringify(VISUAL_PALETTE)}
- Always match the active brand profile and remain readable at small sizes

When crafting image prompts, match this character exactly and be extremely specific about composition.`,
};

/**
 * Generate thumbnails for a song using Cloudflare Workers AI (Flux Schnell)
 */
export async function generateThumbnails({ songId, title, topic, metadata }) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  const thumbDir = join(songDir, 'thumbnails');
  fs.mkdirSync(thumbDir, { recursive: true });

  // Load optional brand logo for grounding/reference.
  let brandLogoBase64 = null;
  if (fs.existsSync(BRAND_LOGO_PATH)) {
    brandLogoBase64 = fs.readFileSync(BRAND_LOGO_PATH).toString('base64');
    console.log('[CREATIVE-MANAGER] Brand logo loaded for grounding');
  } else {
    console.log('[CREATIVE-MANAGER] No brand logo found at output/brand/brand-logo.png — generating without reference');
  }

  const characterReferenceLines = CHARACTER_VISUAL_REFERENCE.map(item => `- ${item}`).join('\n');

  // Use the agent to craft optimal image prompts
  const promptTask = `Craft precise AI image generation prompts for ${BRAND_NAME} thumbnails.

SONG: "${title}"
TOPIC: ${topic}

CHARACTER REFERENCE (match this exactly):
${characterReferenceLines}

VISUAL STYLE:
- ${VISUAL_STYLE}
- Profile palette: ${JSON.stringify(VISUAL_PALETTE)}
- High contrast, reads well at thumbnail size
- NO text in the image (text added separately)

Create prompts for 3 formats. Each prompt MUST:
- Feature ${CHARACTER_NAME} prominently and in character
- Reflect the song topic "${topic}" in the scene/setting
- Be optimized for the specific crop ratio
- Describe composition explicitly (foreground/background/framing)

Output as JSON:
{
  "prompts": {
    "youtube_landscape": {
      "size": "1280x720",
      "prompt": "...",
      "negative_prompt": "${NEGATIVE_PROMPT}"
    },
    "spotify_square": {
      "size": "3000x3000",
      "prompt": "...",
      "negative_prompt": "text, words, letters, photorealistic, dark colors"
    },
    "apple_music_square": {
      "size": "3000x3000",
      "prompt": "...",
      "negative_prompt": "text, words, letters, photorealistic, dark colors"
    }
  },
  "text_overlay_notes": {
    "title_text": "${title}",
    "placement": "bottom third",
    "style_notes": "${TEXT_OVERLAY_STYLE}"
  }
}`;

  const promptResult = await runAgent('creative-manager', CREATIVE_MANAGER_DEF, promptTask);

  let promptData;
  try {
    promptData = parseAgentJson(promptResult.text);
  } catch {
    promptData = {
      prompts: {
        youtube_landscape: {
          size: '1280x720',
          prompt: `${VISUAL_STYLE}, ${CHARACTER_NAME} (${CHARACTER_VISUAL_IDENTITY}), ${topic} themed background, profile palette ${JSON.stringify(VISUAL_PALETTE)}, wide landscape composition, NO text`,
          negative_prompt: NEGATIVE_PROMPT,
        },
        spotify_square: {
          size: '3000x3000',
          prompt: `${VISUAL_STYLE}, ${CHARACTER_NAME} (${CHARACTER_VISUAL_IDENTITY}), ${topic} scene, profile palette ${JSON.stringify(VISUAL_PALETTE)}, square composition centered on the subject, NO text`,
          negative_prompt: NEGATIVE_PROMPT,
        },
        apple_music_square: {
          size: '3000x3000',
          prompt: `${VISUAL_STYLE}, ${CHARACTER_NAME} (${CHARACTER_VISUAL_IDENTITY}), ${topic} scene, profile palette ${JSON.stringify(VISUAL_PALETTE)}, square composition, NO text`,
          negative_prompt: NEGATIVE_PROMPT,
        },
      },
      text_overlay_notes: {
        title_text: title,
        placement: 'bottom third',
        style_notes: TEXT_OVERLAY_STYLE,
      },
    };
  }

  // Save prompts
  fs.writeFileSync(join(thumbDir, 'image-prompts.json'), JSON.stringify(promptData, null, 2));

  // Check Cloudflare credentials
  const cfAccountId = process.env.CF_ACCOUNT_ID;
  const cfApiToken = process.env.CF_API_TOKEN;

  if (!cfAccountId || !cfApiToken || cfAccountId === '...' || cfApiToken === '...') {
    console.log('\n[CREATIVE-MANAGER] Cloudflare credentials not set — skipping image generation');
    console.log('[CREATIVE-MANAGER] Set CF_ACCOUNT_ID and CF_API_TOKEN in .env to enable auto-thumbnails');
    fs.writeFileSync(join(thumbDir, 'THUMBNAIL_INSTRUCTIONS.md'), buildManualInstructions(promptData, title));
    return { thumbDir, generatedThumbnails: [], promptData, skipped: true };
  }

  // Generate thumbnails
  const generatedThumbnails = [];

  for (const [formatName, spec] of Object.entries(promptData.prompts || {})) {
    console.log(`\n[CREATIVE-MANAGER] Generating ${formatName}...`);

    let imageBase64 = null;
    const MAX_CF_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_CF_RETRIES; attempt++) {
      try {
        imageBase64 = await callCloudflareFlux({
          accountId: cfAccountId,
          apiToken: cfApiToken,
          prompt: spec.prompt,
          negativePrompt: spec.negative_prompt,
          // referenceImageBase64 removed — Flux Schnell doesn't support img2img (causes 500)
        });
        break; // success
      } catch (err) {
        const is500 = err.message.includes('500') || err.message.includes('Internal server error');
        if (is500 && attempt < MAX_CF_RETRIES) {
          console.log(`[CREATIVE-MANAGER] CF 500 on attempt ${attempt} — retrying in ${attempt * 5}s...`);
          await new Promise(r => setTimeout(r, attempt * 5000));
        } else {
          console.log(`[CREATIVE-MANAGER] Error generating ${formatName}: ${err.message}`);
          break;
        }
      }
    }

    if (imageBase64) {
      const buffer = Buffer.from(imageBase64, 'base64');
      const filename = `${formatName}-base.png`;
      const filePath = join(thumbDir, filename);
      fs.writeFileSync(filePath, buffer);
      generatedThumbnails.push({ formatName, filePath, size: spec.size });
      console.log(`[CREATIVE-MANAGER] ✓ Saved ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
    }

    // Delay between formats to avoid rate limits
    await new Promise(r => setTimeout(r, 1500));
  }

  // Save text overlay instructions
  fs.writeFileSync(
    join(thumbDir, 'TEXT_OVERLAY_INSTRUCTIONS.md'),
    buildTextOverlayInstructions(promptData.text_overlay_notes, generatedThumbnails)
  );

  if (generatedThumbnails.length > 0) {
    console.log(`\n[CREATIVE-MANAGER] ✓ Generated ${generatedThumbnails.length} thumbnail(s)`);

    // Burn title text into every thumbnail automatically — no Canva needed
    console.log('[CREATIVE-MANAGER] Adding title text overlay...');
    for (const thumb of generatedThumbnails) {
      try {
        const finalPath = thumb.filePath.replace('-base.png', '-final.png');
        await addTitleText(thumb.filePath, finalPath, title, thumb.formatName);
        thumb.finalPath = finalPath;
        console.log(`[CREATIVE-MANAGER] ✓ Title text added → ${finalPath.split('/').pop()}`);
      } catch (err) {
        console.log(`[CREATIVE-MANAGER] ⚠ Title text failed for ${thumb.formatName}: ${err.message}`);
        thumb.finalPath = thumb.filePath; // fall back to base
      }
    }
  } else {
    console.log('\n[CREATIVE-MANAGER] No thumbnails generated — check CF credentials and see THUMBNAIL_INSTRUCTIONS.md');
    fs.writeFileSync(join(thumbDir, 'THUMBNAIL_INSTRUCTIONS.md'), buildManualInstructions(promptData, title));
  }

  return { thumbDir, generatedThumbnails, promptData };
}

// ─────────────────────────────────────────────────────────────
// Cloudflare Workers AI — Flux Schnell
// ─────────────────────────────────────────────────────────────

/**
 * Call Cloudflare Flux Schnell and return base64 image string.
 *
 * Cloudflare response format:
 *   { result: { image: "<base64-png>" }, success: true, errors: [], messages: [] }
 *
 * The previous version did response.arrayBuffer() on this JSON — that wrote
 * the raw JSON bytes as a "PNG" file, which is why no images appeared.
 */
async function callCloudflareFlux({ accountId, apiToken, prompt, negativePrompt }) {
  // Note: Flux Schnell text-to-image only — img2img (image+strength) causes 500 errors
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;

  const body = {
    prompt,
    num_steps: 4, // Flux Schnell optimized for 4 steps
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cloudflare API ${res.status}: ${errText.substring(0, 300)}`);
  }

  // Cloudflare returns JSON — NOT raw binary
  const json = await res.json();

  if (!json.success) {
    const errs = (json.errors || []).map(e => e.message || JSON.stringify(e)).join('; ');
    throw new Error(`Cloudflare generation failed: ${errs}`);
  }

  // Image is base64-encoded in result.image
  const imageBase64 = json.result?.image;
  if (!imageBase64) {
    throw new Error(`Cloudflare returned success but no image data. Response: ${JSON.stringify(json).substring(0, 200)}`);
  }

  return imageBase64;
}

// ─────────────────────────────────────────────────────────────
// Title text overlay — uses canvas (already in package.json)
// ─────────────────────────────────────────────────────────────

/**
 * Burn song title text onto a PNG thumbnail.
 * - White bold text with dark red stroke + drop shadow
 * - Bottom third placement, auto-sized to fit
 * - Saves as a new file (keeps the -base.png intact)
 */
async function addTitleText(inputPath, outputPath, title, formatName) {
  const img = await loadImage(inputPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');

  // Draw base image
  ctx.drawImage(img, 0, 0);

  // Layout constants
  const isLandscape = img.width > img.height;
  const maxTextWidth = img.width * 0.88;
  const bottomPad = Math.round(img.height * 0.06);

  // Start font size large, shrink to fit
  let fontSize = isLandscape
    ? Math.round(img.height * 0.12)   // landscape: ~87px for 720h
    : Math.round(img.width * 0.10);   // square: ~300px for 3000w

  ctx.font = `bold ${fontSize}px "Arial Black", Arial, sans-serif`;
  while (ctx.measureText(title).width > maxTextWidth && fontSize > 20) {
    fontSize -= isLandscape ? 2 : 10;
    ctx.font = `bold ${fontSize}px "Arial Black", Arial, sans-serif`;
  }

  const textMetrics = ctx.measureText(title);
  const textX = img.width / 2;
  const textY = img.height - bottomPad;

  // Drop shadow (subtle)
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = isLandscape ? 8 : 24;
  ctx.shadowOffsetX = isLandscape ? 3 : 8;
  ctx.shadowOffsetY = isLandscape ? 3 : 8;

  const paletteValues = Object.values(VISUAL_PALETTE || {}).filter(value => typeof value === 'string');
  ctx.strokeStyle = VISUAL_PALETTE.text_outline || VISUAL_PALETTE.dark || paletteValues[0] || '#111827';
  ctx.lineWidth = isLandscape ? Math.round(fontSize * 0.18) : Math.round(fontSize * 0.14);
  ctx.lineJoin = 'round';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.strokeText(title, textX, textY);

  // White fill
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(title, textX, textY);
  ctx.restore();

  // Save
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
}

// ─────────────────────────────────────────────────────────────
// Instruction builders
// ─────────────────────────────────────────────────────────────

function buildManualInstructions(promptData, title) {
  let md = `# Manual Thumbnail Generation Instructions\n\n`;
  md += `Use these prompts with any AI image generator (Midjourney, DALL-E, Leonardo AI, etc.)\n\n`;
  if (fs.existsSync(BRAND_LOGO_PATH)) {
    md += `**Brand Reference:** Use \`output/brand/brand-logo.png\` as the reference image.\n\n`;
  }

  for (const [format, spec] of Object.entries(promptData.prompts || {})) {
    md += `## ${format} (${spec.size})\n\n`;
    md += `**Prompt:**\n${spec.prompt}\n\n`;
    md += `**Negative Prompt:**\n${spec.negative_prompt || 'text, dark colors, photorealistic'}\n\n`;
    md += `---\n\n`;
  }

  if (promptData.text_overlay_notes) {
    md += `## Text Overlay\n\n`;
    md += `**Title Text:** "${promptData.text_overlay_notes.title_text || title}"\n`;
    md += `**Placement:** ${promptData.text_overlay_notes.placement}\n`;
    md += `**Style:** ${promptData.text_overlay_notes.style_notes}\n\n`;
    md += `**Quick Tools:** Canva (free) · Adobe Express · GIMP\n`;
  }

  md += `\n## To enable automated generation:\n`;
  md += `Add to your .env:\n\`\`\`\nCF_ACCOUNT_ID=your_account_id\nCF_API_TOKEN=your_api_token\n\`\`\`\n`;
  md += `Get these at: https://dash.cloudflare.com → AI → Workers AI\n`;

  return md;
}

function buildTextOverlayInstructions(notes, generated) {
  let md = `# Text Overlay Instructions\n\n`;
  md += `**Title:** "${notes?.title_text || 'Song Title'}"\n`;
  md += `**Placement:** ${notes?.placement || 'bottom third'}\n`;
  md += `**Style:** ${notes?.style_notes || 'bold, rounded font, white with dark outline'}\n\n`;

  if (generated.length > 0) {
    md += `## Generated Files\n\n`;
    for (const thumb of generated) {
      md += `- \`${thumb.filePath.split('/').pop()}\` (${thumb.size})\n`;
      md += `  → Add title text → save as \`${thumb.formatName}-final.png\`\n`;
    }
    md += `\n**Quick Tools:** Canva (free) · Adobe Express · GIMP\n`;
  }

  return md;
}
