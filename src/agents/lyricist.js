/**
 * Lyricist Agent â€” Writes complete lyrics and audio generation prompts.
 *
 * The active brand profile is the source of truth. This file intentionally avoids
 * hard-coded assumptions from any single brand.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { runAgent, parseAgentJson } from '../shared/managed-agent.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import { sanitizeLyricsForQA, stripEmojis } from '../shared/song-qa.js';
import { extractLockedTitleFromTopic } from '../shared/song-generation-request.js';
import { buildLockedTitlePromptLines, getLockedTitlePolicy } from '../shared/locked-title-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const CHARACTER_NAME = BRAND_PROFILE.character.name;
const MUSIC = BRAND_PROFILE.music || {};
const SONGWRITING = BRAND_PROFILE.songwriting || {};
const OUTPUT_SCHEMA = SONGWRITING.output_schema || {};

export const LYRICIST_DEF = {
  name: `${BRAND_NAME} Lyricist`,
  noTools: true,
  system: `You are the songwriter for the active brand profile. Use the active profile as the only source of brand truth. Output valid JSON only.`,
};

export async function writeLyrics({ songId, topic, researchReport, brandData, revisionNotes, existingLyrics }) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });

  let result;
  let songData;
  let qaRevisionNotes = revisionNotes;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const task = buildLyricsTask({ topic, researchReport, brandData, revisionNotes: qaRevisionNotes, existingLyrics });
    result = await runAgent('lyricist', LYRICIST_DEF, task);

    try {
      songData = parseAgentJson(result.text);
    } catch {
      songData = { title: topic.substring(0, 50), lyrics: result.text, parse_error: true };
    }

    songData = sanitizeSongData(songData, topic);
    const contamination = findForbiddenElementContamination(songData);
    if (contamination.length === 0) break;

    qaRevisionNotes = [
      revisionNotes || '',
      'CRITICAL PROFILE QA FAILURE:',
      `The previous draft included forbidden active-profile element(s): ${contamination.map(item => item.element).join(', ')}.`,
      'Rewrite from scratch and remove every forbidden element. Use only allowed and required elements from the active brand profile.',
    ].filter(Boolean).join('\n');
  }

  const contamination = findForbiddenElementContamination(songData);
  if (contamination.length > 0) {
    throw new Error(`Lyricist profile QA failed for "${songData.title || topic}". Forbidden element(s): ${contamination.map(item => item.element).join(', ')}`);
  }

  const lyricsContent = formatLyricsMarkdown(songData);
  const audioPromptContent = formatAudioPrompt(songData);
  const lyricsPath = join(songDir, 'lyrics.md');
  const audioPromptPath = join(songDir, 'audio-prompt.md');

  fs.writeFileSync(lyricsPath, lyricsContent);
  fs.writeFileSync(audioPromptPath, audioPromptContent);
  fs.writeFileSync(join(songDir, 'lyrics-data.json'), JSON.stringify(songData, null, 2));

  console.log(`\nLyrics saved to ${liricsPath}`);
  console.log(`Audio prompt saved to ${audioPromptPath}`);

  return {
    songData,
    lyricsPath,
    audioPromptPath,
    title: songData.title || topic,
    lyricsText: lyricsContent,
    audioPromptText: audioPromptContent,
    costUsd: result.costUsd || 0,
  };
}

export function buildLyricsTask({ topic, researchReport, brandData, revisionNotes, existingLyrics }) {
  const lockedTitle = extractLockedTitleFromTopic(topic);
  const titlePolicyLines = buildLockedTitlePromptLines(lockedTitle, BRAND_PROFILE);

  return [
    `${existingLyrics ? 'Revise' : 'Write'} a production-ready song for the active ${BRAND_NAME} brand on this content request:`,
    topic,
    '',
    existingLyrics ? `EXISTING LYRICS:\n${existingLyrics}` : '',
    revisionNotes ? `REVISION NOTES:\n${revisionNotes}` : '',
    '',
    'ACTIVE BRAND\ PROFILE:',
    JSON.stringify(BRAND_PROFILE, null, 2),
    '',
    'COMPATIBLE GENERATED BRAND\ DATA:',
    JSON.stringify(getCompatibleGeneratedBrandData(brandData), null, 2),
    '',
    'RESEARCH / CONTEXT INSIGHTS:',
    JSON.stringify(summarizeResearch(researchReport), null, 2),
    '',
    'TITLE HANDLING:',
    formatTitleRules(lockedTitle, titlePolicyLines),
    '',
    'CONTENT RULES:',
    '- Use only the active brand profile as brand truth.',
    `- Make the song specific to ${BRAND_NAME}, ${CHARACTER_NAME}, and the content request.`,
    '- Follow forbidden elements, required elements, title policy, structure preferences, and output schema from the active brand profile.',
    '- The lyrics field may be sent to a music renderer; keep lyrics singable and remove production directions from the lyrics field.',
    '',
    'OUTPUT JSON SCHEMA:',
    formatOutputSchema(lockedTitle),
  ].filter(Boolean).join('\n');
}

function formatTitleRules(lockedTitle, titlePolicyLines) {
  const lines = [];
  if (lockedTitle) lines.push(`- The JSON title field must equal this locked title exactly: "${lockedTitle}".`);
  else lines.push('- If the content request includes an explicit title, preserve that title exactly.');

  if (titlePolicyLines.length > 0) {
    lines.push('- Apply the active brand profile title policy:');
    lines.push(...titlePolicyLines.map(line => `  - ${line}`));
  } else {
    lines.push('- No title placement rule is active unless specified by the active brand profile.');
  }

  return lines.join('\n');
}

function formatOutputSchema(lockedTitle = '') {
  const title = lockedTitle ? jsonEscape(lockedTitle) : 'The Song Title';
  return `{
  "title": "${title}",
  "lyrics": "full lyrics text with section markers",
  "chorus_lines": ["line1", "line2", "line3", "line4"],
  "word_count": 320,
  "structure_used": "which active-profile structure was used",
  "key_hook": "the memorable hook line",
  "physical_action_cue": "omit unless active profile asks for it",
  "funny_long_word": "omit unless active profile asks for it",
  "audio_prompt": {
    "style": "${jsonEscape(MUSIC.default_style || 'profile-aligned')}",
    "tempo_bpm": ${Number(MUSIC.default_bpm || 120)},
    "genre": "${jsonEscape(MUSIC.default_style || 'profile-aligned')}",
    "instrumentation": "match the active profile music direction",
    "energy": "match the active profile and song",
    "mood": "match the song",
    "voice_style": "match the active brand profile, audience, and topic",
    "structure_note": "describe the actual structure used and say vocals start immediately",
    "target_length": "${jsonEscape(MUSIC.target_length || '')}",
    "first_vocal_by_seconds": ${Number(MUSIC.first_vocal_by_seconds || 5)},
    "max_instrumental_intro_seconds": ${Number(MUSIC.max_instrumental_intro_seconds || 5)},
    "title_policy_note": "describe how the active brand title policy was applied, or say none",
    "special_notes": "follow the active brand profile only"
  }
}`;
}

function sanitizeSongData(songData, topic) {
  const lockedTitle = extractLockedTitleFromTopic(topic);
  const sanitized = {
    ...songData,
    title: stripEmojis(lockedTitle || songData.title || topic.substring(0, 50)).trim(),
    lyrics: sanitizeLyricsForQA(songData.lyrics || ''),
    key_hook: songData.key_hook ? stripEmojis(songData.key_hook).trim() : songData.key_hook,
    chorus_lines: Array.isArray(songData.chorus_lines)
      ? songData.chorus_lines.map(line => stripEmojis(line).trim())
      : songData.chorus_lines,
    audio_prompt: sanitizeAudioPrompt(songData.audio_prompt || {}),
  };

  if (lockedTitle) {
    sanitized.locked_title = lockedTitle;
    sanitized.title_was_locked = true;
  }

  if (!OUTPUT_SCHEMA.include_physical_action_cue) delete sanitized.physical_action_cue;
  if (!OUTPUT_SCHEMA.include_funny_long_word) delete sanitized.funny_long_word;

  return sanitized;
}

function sanitizeAudioPrompt(audioPrompt) {
  const cleaned = { ...audioPrompt };
  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === 'string') cleaned[key] = stripEmojis(value).trim();
  }
  return cleaned;
}

function formatLyricsMarkdown(songData) {
  let md = `# ${songData.title || 'Untitled Song'}\n\n`;
  md += `**Key Hook:** ${songData.key_hook || 'TBD'}\n`;
  if (OUTPUT_SCHEMA.include_physical_action_cue) md += `**Physical Action:** ${songData.physical_action_cue || 'TBD'}\n`;
  md += `**Word Count:** ~${songData.word_count || '?'}\n`;
  if (songData.title_was_locked) md += `**Locked Title:** ${songData.locked_title}\n`;
  md += `\n---\n\n${sanitizeLyricsForQA(songData.lyrics || '')}\n`;
  return md;
}

function formatAudioPrompt(songData) {
  const ap = songData.audio_prompt || {};
  const titlePolicy = getLockedTitlePolicy(BRAND_PROFILE);
  const titlePolicyNote = titlePolicy.enabled
    ? (ap.title_policy_note || buildLockedTitlePromptLines(songData.title, BRAND_PROFILE).join('; '))
    : 'No title placement requirement in active brand profile.';

  return `# Audio Generation Prompt\n\n## Song: ${songData.title || 'Untitled'}\n\n## Music Specs\n\n` +
    `**Style:** ${ap.tempo_bpm || MUSIC.default_bpm || 120} BPM, ${ap.genre || MUSIC.default_style || 'profile-aligned'}\n` +
    `**Instrumentation:** ${ap.instrumentation || MUSIC.default_prompt || 'profile-aligned'}\n` +
    `**Energy:** ${ap.energy || 'profile-aligned'}\n` 
+    `**Mood:** ${ap.mood || MUSIC.default_style || 'profile-aligned'}\n` 
+    `**Voice Style:** ${ap.voice_style || 'profile-aligned'}\n` 
+    `**Structure:** ${ap.structure_note || 'follow active brand profile structure preferences; vocals start immediately'}\n` +
    `**Target Length:** ${ap.target_length || MUSIC.target_length || ''}\n` +
    `**First Vocal By:** ${ap.first_vocal_by_seconds ?? MUSIC.first_vocal_by_seconds ?? 5} seconds\n` 
+    `**Max Instrumental Intro:** ${ap.max_instrumental_intro_seconds ?? MUSIC.max_instrumental_intro_seconds ?? 5} seconds\n` +
    `**Title Policy:** ${titlePolicyNote}\n` +
    `**Render Safety:** Vocals begin immediately. Follow the active brand profile title policy only if one is defined.\n` +
    (ap.special_notes ? `**Special Notes:(¨€‘í…À¹ÍÁ•¥…±}¹½Ñ•Íõq¹€€è€œœ¤€¬(€€€q¸´´µq¹q¸ŒŒÕ±°1åÉ¥Íq¹q¸‘íÍ…¹¥Ñ¥é•1åÉ¥Í½ÉE¡Í½¹…Ñ„¹±åÉ¥Ìñğ€œœ¥õq¹€ì)ô()™Õ¹Ñ¥½¸•Ñ½µÁ…Ñ¥‰±••¹•É…Ñ•‘	É…¹‘…Ñ„¡‰É…¹‘…Ñ„¤ì(€¥˜€ …‰É…¹‘…Ñ„¤É•ÑÕÉ¸€9½¹”ÍÕÁÁ±¥•¸œì((€½¹ÍĞÍ•É¥…±¥é•€ô)M=8¹ÍÑÉ¥¹¥™ä¡‰É…¹‘…Ñ„¤¹Ñ½1½İ•É…Í” ¤ì(€½¹ÍĞ…Ñ¥Ù•	É…¹€ô	I9}95¹Ñ½1½İ•É…Í” ¤ì(€½¹ÍĞ…Ñ¥Ù•¡…É…Ñ•È€ô!IQI}95¹Ñ½1½İ•É…Í” ¤ì((€¥˜€ …Í•É¥…±¥é•¹¥¹±Õ‘•Ì¡…Ñ¥Ù•	É…¹¤€˜˜€…Í•É¥…±¥é•¹¥¹±Õ‘•Ì¡…Ñ¥Ù•¡…É…Ñ•È¤¤ì(€€€½¹Í½±”¹±½œ m	I9t%¹½É¥¹œÍÑ…±”•¹•É…Ñ•‰É…¹‰¥‰±”™½È‘¥™™•É•¹Ğ‰É…¹œ¤ì(€€€É•ÑÕÉ¸€%¹½É•ÍÑ…±”•¹•É…Ñ•‰É…¹‰¥‰±”™½È‘¥™™•É•¹Ğ‰É…¹¸œì(€ô((€É•ÑÕÉ¸‰É…¹‘…Ñ„ì)ô()™Õ¹Ñ¥½¸ÍÕµµ…É¥é•I•Í•…É ¡É•Í•…É¡I•Á½ÉĞ¤ì(€¥˜€ …É•Í•…É¡I•Á½ÉĞ¤É•ÑÕÉ¸ì¹½Ñ”è€9¼É•Í•…É ‘…Ñ„…Ù…¥±…‰±”¸UÍ”Ñ¡”…Ñ¥Ù”‰É…¹ÁÉ½™¥±”…¹Í½¹İÉ¥Ñ¥¹œ•áÁ•ÉÑ¥Í”¸œôì(€É•ÑÕÉ¸É•Í•…É¡I•Á½ÉĞì)ô()•áÁ½ÉĞ™Õ¹Ñ¥½¸™¥¹‘½É‰¥‘‘•¹±•µ•¹Ñ½¹Ñ…µ¥¹…Ñ¥½¸¡Í½¹…Ñ„°™½É‰¥‘‘•¹±•µ•¹ÑÌ€ôM=9]I%Q%9¹™½É‰¥‘‘•¹}•±•µ•¹ÑÌñğmt¤ì(€½¹ÍĞÍ•…É¡…‰±”€ô½±±•ÑM•…É¡…‰±•M½¹Q•áĞ¡Í½¹…Ñ„¤ì(€½¹ÍĞ¹½Éµ…±¥é•€ô¹½Éµ…±¥é•½É½É‰¥‘‘•¹5…Ñ ¡Í•…É¡…‰±”¤ì((€É•ÑÕÉ¸™½É‰¥‘‘•¹±•µ•¹ÑÌ(€€€€¹™±…Ñ5…À¡•±•µ•¹Ğ€ôø‰Õ¥±‘½É‰¥‘‘•¹A…ÑÑ•É¹Ì¡•±•µ•¹Ğ¤¹µ…À¡Á…ÑÑ•É¸€ôø€¡ì•±•µ•¹Ğ°Á…ÑÑ•É¸ô¤¤¤(€€€€¹™¥±Ñ•È ¡ìÁ…ÑÑ•É¸ô¤€ôøÁ…ÑÑ•É¸¹Ñ•ÍĞ¡¹½Éµ…±¥é•¤¤(€€€€¹µ…À ¡ì•±•µ•¹Ğ°Á…ÑÑ•É¸ô¤€ôø€¡ì•±•µ•¹Ğ°Á…ÑÑ•É¸èÁ…ÑÑ•É¸¹Í½ÕÉ”ô¤¤ì)ô()™Õ¹Ñ¥½¸½±±•ÑM•…É¡…‰±•M½¹Q•áĞ¡Í½¹…Ñ„€ôíô¤ì(€É•ÑÕÉ¸l(€€€Í½¹…Ñ„¹Ñ¥Ñ±”°(€€€Í½¹…Ñ„¹±åÉ¥Ì°(€€€Í½¹…Ñ„¹­•å}¡½½¬°(€€€€¸¸¸¡ÉÉ…ä¹¥ÍÉÉ…ä¡Í½¹…Ñ„¹¡½ÉÕÍ}±¥¹•Ì¤€üÍ½¹…Ñ„¹¡½ÉÕÍ}±¥¹•Ì€èmt¤°(€€€™±…ÑÑ•¹5•Ñ…‘…Ñ…Q•áĞ¡Í½¹…Ñ„¹…Õ‘¥½}ÁÉ½µÁĞ¤°(€€€™±…ÑÑ•¹5•Ñ…‘…Ñ…Q•áĞ¡Í½¹…Ñ„¹µ•Ñ…‘…Ñ„¤°(€t¹™¥±Ñ•È¡	½½±•…¸¤¹©½¥¸ q¸œ¤ì)ô()™Õ¹Ñ¥½¸™±…ÑÑ•¹5•Ñ…‘…Ñ…Q•áĞ¡Ù…±Õ”¤ì(€¥˜€ …Ù…±Õ”¤É•ÑÕÉ¸€œœì(€¥˜€¡ÑåÁ•½˜Ù…±Õ”€ôôô€ÍÑÉ¥¹œœ¤É•ÑÕÉ¸Ù…±Õ”ì(€¥˜€¡ÉÉ…ä¹¥ÍÉÉ…ä¡Ù…±Õ”¤¤É•ÑÕÉ¸Ù…±Õ”¹µ…À¡™±…ÑÑ•¹5•Ñ…‘…Ñ…Q•áĞ¤¹©½¥¸ œ€œ¤ì(€¥˜€¡ÑåÁ•½˜Ù…±Õ”€ôôô€½‰©•Ğœ¤É•ÑÕÉ¸=‰©•Ğ¹Ù…±Õ•Ì¡Ù…±Õ”¤¹µ…À¡™±…ÑÑ•¹5•Ñ…‘…Ñ…Q•áĞ¤¹©½¥¸ œ€œ¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Ù…±Õ”¤ì)ô()™Õ¹Ñ¥½¸¹½Éµ…±¥é•½É½É‰¥‘‘•¹5…Ñ ¡Ù…±Õ”€ô€œœ¤ì(€É•ÑÕÉ¸€€‘íMÑÉ¥¹œ¡Ù…±Õ”¤¹Ñ½1½İ•É…Í” ¤¹É•Á±…” ½oŠdt½œ°€œœ¤¹É•Á±…” ½my„µèÀ´åt¬½œ°€œ€œ¤¹É•Á±…” ½qÌ¬½œ°€œ€œ¤¹ÑÉ¥´ ¥ô€ì)ô()™Õ¹Ñ¥½¸‰Õ¥±‘½É‰¥‘‘•¹A…ÑÑ•É¹Ì¡•±•µ•¹Ğ€ô€œœ¤ì(€½¹ÍĞ¹½Éµ…±¥é•€ô¹½Éµ…±¥é•½É½É‰¥‘‘•¹5…Ñ ¡•±•µ•¹Ğ¤¹ÑÉ¥´ ¤ì(€¥˜€ …¹½Éµ…±¥é•¤É•ÑÕÉ¸mtì(€É•ÑÕÉ¸m¹•ÜI•áÀ¡€qq‰í•Í…Á•I•áÀ¡¹½Éµ…±¥é•¤¹É•Á±…” ½qqÌ¬½œ°€qqÌ¼¬œ¥õq‰€°€¤œ¥tì)ô()™Õ¹Ñ¥½¸•Í…Á•I•áÀ¡Ù…±Õ”€ô€œœ¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Ù…±Õ”¤¹É•Á±…” ½l¸¨¬ıx‘íô ¥ñmquqqt½œ°€qp‘˜œ¤ì)ô()™Õ¹Ñ¥½¸©Í½¹Í…Á”¡Ù…±Õ”€ô€œœ¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Ù…±Õ”¤¹É•Á±…” ½qp½œ°€qqqpœ¤¹É•Á±…” ¼ˆ½œ°€qpˆœ¤ì)ô