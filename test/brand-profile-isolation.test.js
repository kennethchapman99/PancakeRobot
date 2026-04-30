import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('Sue profile lyric prompt uses songwriting rules without stale brand leakage', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-profile-'));
  const profilePath = path.join(tmp, 'sue.json');

  fs.writeFileSync(profilePath, JSON.stringify({
    brand_name: "Mother's Day Ballad for Sue",
    app_title: "Mother's Day Ballad for Sue",
    brand_type: 'personal_family_ballad',
    brand_description: "a deeply emotional Mother's Day ballad celebrating Sue Wong's 18th year of being a mother",
    audience: {
      age_range: 'family',
      description: 'Sue Wong, Ken, Jayda, Myles, Makena, Cheddar, and the family',
      guardrail: 'heartfelt, sincere, emotional, family-safe, deeply personal, loving, grateful, and tear-jerking'
    },
    character: {
      name: 'Sue Wong',
      core_concept: 'a loving mother, wife, gardener, traveler, baker, comfort-giver, song-maker, hilarious partner, and heart of the family',
      fallback_summary: 'Sue Wong, beloved mother of Jayda, Myles, and Makena, wife of Ken, best friend to Cheddar the mini wiener dog, and the person who fills the home with love, food, laughter, songs, and care',
      clap_name: 'none',
      visual_identity: 'warm family memory imagery',
      visual_reference: [
        "Jayda was born on Mother's Day",
        'Myles was born at home',
        'Makena is the youngest and always happy',
        "Cheddar is Sue's best friend"
      ]
    },
    music: {
      default_style: 'tear-jerking emotional piano ballad',
      default_bpm: 72,
      default_key: 'D Major',
      default_prompt: 'Create a tear-jerking Mother\'s Day piano ballad for Sue, from Ken, Jayda, Myles, Makena, and Cheddar.',
      target_length: '3:00-4:00',
      min_words: 240,
      normal_word_range: '280-460',
      first_vocal_by_seconds: 5,
      max_instrumental_intro_seconds: 8
    },
    lyrics: {
      title_examples: ['Eighteen Years of You', 'The Heart of This Home'],
      topic_variety: 'motherhood, marriage, family memories, gardening, travel, humor, food as love',
      required_closing: 'End with a final emotional image of Sue surrounded by Ken, Jayda, Myles, Makena, and Cheddar.'
    },
    songwriting: {
      song_type: 'adult_contemporary_personal_ballad',
      primary_emotional_goal: 'make Sue feel deeply seen, loved, celebrated, and moved to tears',
      voice_perspective: 'from Ken, Jayda, Myles, and Makena to Sue',
      allowed_elements: ['specific family memories', 'warm natural humor', 'food as love', 'gardening'],
      forbidden_elements: ['children\'s song language', 'claps', 'stomps', 'wiggles', 'call-and-response', 'robot sounds', 'pancake metaphors'],
      structure_preferences: ['[INTRO] -> [VERSE 1] -> [CHORUS] -> [VERSE 2] -> [CHORUS] -> [BRIDGE] -> [FINAL CHORUS] -> [OUTRO]'],
      required_elements: ['Sue Wong', 'Ken', 'Jayda', 'Myles', 'Makena', 'Cheddar'],
      output_schema: {
        include_physical_action_cue: false,
        include_funny_long_word: false,
        include_audio_prompt: true,
        include_chorus_lines: true
      }
    },
    visuals: {
      style: 'Warm cinematic family-memory artwork',
      palette: {},
      negative_prompt: 'none',
      text_overlay_style: 'none'
    },
    distribution: {
      default_distributor: 'personal_use',
      legacy_distributor: 'none',
      research_default_service: 'none',
      research_default_url: 'none',
      default_artist: 'Ken for Sue',
      default_album: "Mother's Day",
      primary_genre: 'Singer-Songwriter',
      spotify_genres: ['singer-songwriter'],
      youtube_tags_seed: ["mother's day song"],
      apple_music_genres: ['Singer/Songwriter'],
      coppa_status: 'not directed to children under 13',
      content_advisory: 'suitable for all ages'
    },
    ui: {
      sidebar_subtitle: "Mother's Day Ballad Studio",
      logo_path: '/logo.png'
    }
  }, null, 2));

  process.env.BRAND_PROFILE_PATH = profilePath;
  const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
  clearBrandProfileCache();

  const { buildLyricsTask } = await import(`../src/agents/lyricist.js?cacheBust=${Date.now()}`);
  const prompt = buildLyricsTask({
    topic: 'title: For Sue',
    brandData: { character: { name: 'Pancake Robot' } }
  });

  for (const forbiddenLeak of ['Pancake Robot', 'beep boop']) {
    assert.equal(prompt.toLowerCase().includes(forbiddenLeak.toLowerCase()), false, `prompt leaked stale brand: ${forbiddenLeak}`);
  }

  for (const required of ['Sue Wong', "Mother's Day", 'tear-jerking', 'piano ballad', 'Ken', 'Jayda', 'Myles', 'Makena', 'Cheddar']) {
    assert.equal(prompt.includes(required), true, `prompt missing: ${required}`);
  }

  assert.equal(prompt.includes('adult_contemporary_personal_ballad'), true, 'songwriting.song_type missing');
  assert.equal(prompt.includes('pancake metaphors'), true, 'songwriting.forbidden_elements missing');
  assert.equal(prompt.includes('physical_action_cue": "description'), false, 'non-children output schema leaked physical_action_cue field');
  assert.equal(prompt.includes('funny_long_word": "the comedic'), false, 'non-children output schema leaked funny_long_word field');
});
