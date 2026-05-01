import { stripEmojis } from './song-qa.js';
import { buildLockedTitleRequestLines } from './locked-title-policy.js';

export function buildLockedSongGenerationRequest(song = {}) {
  const lockedTitle = cleanTitle(song.title || '');
  const coreTopic = cleanText(song.topic || song.concept || song.notes || lockedTitle || 'song');
  const concept = cleanText(song.concept || '');
  const notes = cleanText(song.notes || '');
  const ageRange = cleanText(song.target_age_range || '');
  const moodTags = arrayText(song.mood_tags);
  const genreTags = arrayText(song.genre_tags);
  const keywords = arrayText(song.keywords);

  const lines = [];
  if (lockedTitle) lines.push(...buildLockedTitleRequestLines(lockedTitle));

  lines.push(`song_topic: ${coreTopic}`);
  if (concept && concept !== coreTopic) lines.push(`concept: ${concept}`);
  if (ageRange) lines.push(`target_age_range: ${ageRange}`);
  if (moodTags.length) lines.push(`mood_tags: ${moodTags.join(', ')}`);
  if (genreTags.length) lines.push(`genre_tags: ${genreTags.join(', ')}`);
  if (keywords.length) lines.push(`keywords: ${keywords.join(', ')}`);
  if (notes) lines.push(`notes: ${notes}`);

  return {
    lockedTitle,
    coreTopic,
    topic: lines.join('\n'),
    sourceSongId: song.id || null,
  };
}

export function extractLockedTitleFromTopic(topic = '') {
  const text = String(topic || '');
  const patterns = [
    /^\s*locked_title\s*:\s*["“”']?([^\n"“”']+)["“”']?\s*$/im,
    /^\s*title\s*:\s*["“”']?([^\n"“”']+)["“”']?\s*$/im,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanTitle(match[1]);
  }

  return '';
}

function cleanTitle(value = '') {
  return stripEmojis(String(value || ''))
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value = '') {
  return stripEmojis(String(value || ''))
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function arrayText(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return [cleanText(value)].filter(Boolean);
}
