/**
 * Brand profile loader.
 *
 * Extraction-only layer: keeps Pancake Robot defaults exactly the same while
 * moving brand/content constants out of tool/agent code over time.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_PATH = join(__dirname, '../../config/brand-profile.json');

const FALLBACK_PROFILE = {
  brand_name: 'Pancake Robot',
  app_title: 'Pancake Robot',
  brand_type: 'children_music',
  brand_description: "a children's music brand",
  audience: {
    age_range: '4-10',
    description: 'kids ages 4-10',
    guardrail: 'age-appropriate for ages 4-10',
  },
  character: {
    name: 'Pancake Robot',
    core_concept: 'a cheerful robot who loves making pancakes and going on silly adventures',
    fallback_summary: 'cheerful robot who loves pancakes and silly adventures',
    clap_name: 'Pancake Robot Clap',
    visual_identity: 'A cheerful robot with a toaster-style body, monitor head with a glowing pixel smiley face, silver/grey metallic arms and legs with joint bolts, warm syrup dripping from hands and feet, holding a stack of golden pancakes',
    visual_reference: [
      'Toaster-style silver/grey metallic body with control panel buttons',
      'Monitor/CRT screen head with glowing yellow pixel smiley face on dark teal screen',
      'Silver articulated robot arms and legs with round joint bolts',
      'Warm golden syrup dripping from hands and feet',
      'Holding or interacting with golden pancake stacks',
      'Music notes floating nearby',
      'Expression: always joyful, energetic, caught mid-action',
    ],
  },
  music: {
    default_style: "upbeat children's pop",
    default_bpm: 118,
    default_key: 'C Major',
    default_prompt: "Upbeat children's pop song, 118 BPM, C Major, bright and silly, fun for kids ages 4-10, hand claps, xylophone, singalong chorus, cheerful vocals",
    target_length: '1:30-3:00',
    min_words: 120,
    normal_word_range: '140-320',
    first_vocal_by_seconds: 3,
    max_instrumental_intro_seconds: 5,
  },
  lyrics: {
    title_examples: ['Raining Taco Dogs', 'The Counting Stomp', 'Wiggle Like a Jellyfish', 'Five Silly Dinosaurs'],
    topic_variety: 'animals, weather, space, vehicles, silly food, emotions, counting, colors, nature, dinosaurs, robots, dance',
    required_closing: 'End with an open question or forward tease — never a goodbye or resolution',
  },
  visuals: {
    style: 'Bold cartoon illustration, clean black outlines, bright saturated colors — NOT photorealistic',
    palette: {
      syrup_gold: '#D4860A',
      silver_grey: '#B0B8C1',
      sky_blue: '#7EC8E3',
      cream: '#F5ECD7',
      dark_red: '#8B0000',
    },
    negative_prompt: 'text, words, letters, photorealistic, dark colors, scary, violent, blurry',
    text_overlay_style: 'bold rounded font, white fill with thick dark red outline, drop shadow',
  },
  distribution: {
    default_distributor: 'TuneCore',
    legacy_distributor: 'DistroKid',
    default_artist: 'Pancake Robot',
    default_album: 'Pancake Robot Vol. 1',
    primary_genre: "Children's Music",
    spotify_genres: ["children's music", 'kids pop', 'educational'],
    youtube_tags_seed: ['kids songs', "children's music", 'pancake robot'],
    apple_music_genres: ['Kids & Family', "Children's Music"],
    coppa_status: 'directed to children under 13',
    content_advisory: 'suitable for all ages',
  },
  ui: {
    sidebar_subtitle: 'Music Studio',
    logo_path: '/logo.png',
  },
};

let cachedProfile = null;

export function loadBrandProfile() {
  if (cachedProfile) return cachedProfile;

  const profilePath = process.env.BRAND_PROFILE_PATH || DEFAULT_PROFILE_PATH;

  try {
    if (fs.existsSync(profilePath)) {
      const loaded = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      cachedProfile = deepMerge(FALLBACK_PROFILE, loaded);
      return cachedProfile;
    }
  } catch (err) {
    console.warn(`[BRAND-PROFILE] Failed to load ${profilePath}: ${err.message}`);
  }

  cachedProfile = FALLBACK_PROFILE;
  return cachedProfile;
}

export function clearBrandProfileCache() {
  cachedProfile = null;
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
