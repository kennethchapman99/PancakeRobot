import { getActiveProfileId, loadBrandProfileById } from '../../shared/brand-profile.js';

function fallbackScoringProfile(brandId = 'generic_default') {
  return {
    brand_id: brandId,
    brand_name: 'Generic Music Brand',
    audience: { description: 'general audience', age_range: 'general' },
    secondary_audience: { description: 'general listeners and caregivers' },
    voice: 'profile-driven music brand',
    themes: [],
    avoid_topics: [],
    scoring_preferences: {},
    hook_style: 'repeatable, memorable phrases',
    release_strategy: 'balanced release cadence',
    brand_fit_keywords: [],
    content_safety_rules: [],
    parent_tolerability_rules: [],
    differentiation_preferences: [],
    missing_brand_profile: true,
  };
}

export function buildReleaseSelectionBrandProfile(song = {}) {
  const brandProfileId = song.brand_profile_id || getActiveProfileId();
  if (!brandProfileId) return fallbackScoringProfile();

  try {
    const profile = loadBrandProfileById(brandProfileId);
    return {
      brand_id: brandProfileId,
      brand_name: profile.brand_name || brandProfileId,
      audience: profile.audience || {},
      secondary_audience: profile.secondary_audience || profile.parents || {
        description: 'secondary listeners who value tolerability and replay safety',
      },
      voice: profile.voice || profile.character?.core_concept || profile.brand_description || '',
      themes: normalizeStringArray(profile.themes || profile.lyrics?.theme_examples),
      avoid_topics: normalizeStringArray(profile.avoid_topics || profile.songwriting?.forbidden_elements),
      scoring_preferences: profile.scoring_preferences || {},
      hook_style: profile.hook_style || profile.music?.default_style || '',
      release_strategy: profile.release_strategy || profile.distribution?.default_album || '',
      brand_fit_keywords: normalizeStringArray(profile.brand_fit_keywords || profile.keywords),
      content_safety_rules: normalizeStringArray(profile.content_safety_rules || profile.songwriting?.forbidden_elements),
      parent_tolerability_rules: normalizeStringArray(profile.parent_tolerability_rules),
      differentiation_preferences: normalizeStringArray(profile.differentiation_preferences),
      raw_profile: profile,
      missing_brand_profile: false,
    };
  } catch {
    return fallbackScoringProfile(brandProfileId);
  }
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : [];
}

