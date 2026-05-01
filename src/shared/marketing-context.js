import { loadBrandProfile } from './brand-profile.js';
import { getAllSongs, getReleaseLinks } from './db.js';

export function getMarketingContext() {
  const brandProfile = loadBrandProfile();
  const songs = getAllSongs().map(song => ({
    id: song.id,
    title: song.title,
    topic: song.topic,
    status: song.status,
    concept: song.concept,
    target_age_range: song.target_age_range || brandProfile.audience?.age_range,
    genre_tags: song.genre_tags || [],
    mood_tags: song.mood_tags || [],
    keywords: song.keywords || [],
    release_date: song.release_date,
    distributor: song.distributor || brandProfile.distribution?.default_distributor,
    release_links: getReleaseLinks(song.id),
  }));

  return {
    brand: {
      name: brandProfile.brand_name,
      app_title: brandProfile.app_title || brandProfile.brand_name,
      type: brandProfile.brand_type,
      description: brandProfile.brand_description,
      audience: brandProfile.audience,
      character: brandProfile.character,
      visuals: brandProfile.visuals,
      distribution: brandProfile.distribution,
      music: brandProfile.music,
      lyrics: brandProfile.lyrics,
      songwriting: brandProfile.songwriting || {},
      ui: brandProfile.ui || {},
    },
    songs,
  };
}

export function renderMarketingTemplate(template, context = getMarketingContext()) {
  if (!template) return template;
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, rawPath) => {
    const value = getPathValue(context, rawPath) ?? getPathValue(context.brand, rawPath);
    if (Array.isArray(value)) return value.join(', ');
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

function getPathValue(obj, path) {
  return String(path).split('.').reduce((current, key) => current?.[key], obj);
}
