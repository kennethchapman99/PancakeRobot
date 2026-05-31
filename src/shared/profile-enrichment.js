/**
 * Profile Enrichment and Linting Utilities
 *
 * Deterministic, offline helpers for the `pancakerobot profile` CLI.
 * No live model calls — proposals are derived from existing profile fields.
 *
 * enrichProfileProposal(profile) → { songwriting: { ...enrichedFields } }
 * lintProfile(profile, profileId) → { errors: [], warnings: [], score: 0-100 }
 */

const KNOWN_REAL_ARTIST_NAMES = [
  'doechii', 'radiohead', 'thom yorke', 'kendrick lamar', 'tyler', 'kanye', 'jay-z',
  'beyonce', 'drake', 'eminem', 'travis scott', 'frank ocean', 'anderson paak',
  'childish gambino', 'donald glover', 'wu-tang', 'wu tang', 'a tribe called quest',
  'tribe called quest', 'lorde', 'bjork', 'grimes', 'burial', 'aphex twin',
  'rage against the machine', 'smashing pumpkins', 'nirvana', 'soundgarden',
];

const GENERIC_GENRE_ADJECTIVES = new Set([
  'energetic', 'catchy', 'upbeat', 'feel-good', 'feel good', 'powerful', 'emotional',
  'melodic', 'rhythmic', 'contemporary', 'modern', 'fresh', 'authentic', 'vibrant',
  'dynamic', 'epic', 'anthemic', 'soulful', 'smooth', 'polished', 'radio-friendly',
  'radio friendly', 'mainstream', 'commercial', 'crisp', 'clean',
]);

const GENERATION_FACING_FIELDS = [
  'songwriting.reference_artists_for_internal_vibe_only',
  'songwriting.allowed_elements',
  'songwriting.forbidden_elements',
  'songwriting.required_elements',
  'songwriting.structure_preferences',
  'songwriting.qa_rules',
  'songwriting.render_safety',
  'music.default_style',
  'music.default_prompt',
  'character.core_concept',
];

export function enrichProfileProposal(profile) {
  const sw = profile.songwriting || {};
  const music = profile.music || {};
  const character = profile.character || {};
  const audience = profile.audience || {};

  const brandStyle = music.default_style || 'pop';
  const characterName = character.name || profile.brand_name || 'the artist';
  const guardrail = audience.guardrail || 'general audience';
  const isExplicit = audience.explicitness === 'explicit_allowed' || sw.lyric_conventions?.explicitness === 'explicit_allowed';
  const isRap = /rap|hip.?hop|trap|drill/i.test(brandStyle + (sw.song_type || ''));
  const isRock = /rock|punk|metal|grunge/i.test(brandStyle + (sw.song_type || ''));
  const isElectronic = /electro|synth|house|techno|edm|indie.?pop|alt.?pop/i.test(brandStyle + (sw.song_type || ''));

  const enriched = {};

  if (!sw.vocal_performance_engine) {
    enriched.vocal_performance_engine = buildVocalPerformanceEngine({ isRap, isRock, isElectronic, characterName, isExplicit, brandStyle, sw });
  }

  if (!sw.performance_conceit_bank || sw.performance_conceit_bank.length === 0) {
    enriched.performance_conceit_bank = buildPerformanceConceitBank({ isRap, isRock, isElectronic });
  }

  if (!sw.album_mode_lanes || sw.album_mode_lanes.length === 0) {
    enriched.album_mode_lanes = buildAlbumModeLanes({ isRap, isRock, isElectronic, brandStyle });
  }

  if (!sw.song_differentiation_rules || sw.song_differentiation_rules.length === 0) {
    enriched.song_differentiation_rules = buildSongDifferentiationRules();
  }

  if (!sw.anti_generic_rules || sw.anti_generic_rules.length === 0) {
    enriched.anti_generic_rules = buildAntiGenericRules({ brandStyle, isRap, isRock, isElectronic, guardrail });
  }

  if (!sw.do_not_repeat_across_album || sw.do_not_repeat_across_album.length === 0) {
    enriched.do_not_repeat_across_album = buildDoNotRepeatList();
  }

  if (!sw.hidden_brief_requirements || sw.hidden_brief_requirements.length === 0) {
    enriched.hidden_brief_requirements = [
      'The brief must specify a vocal conceit unique to this track — not a repeat of any prior track on this album',
      'The brief must describe how the vocal flow moves across the song — name the arc, not just "varied"',
      'The brief must define an adlib personality distinct from the directly preceding track',
      'The brief must identify one sonic oddity audible within the first 10 seconds of the track',
      'The brief must name the emotional contradiction the song embodies — the surface register vs. the underlying feeling',
      'The brief must list specific elements from prior tracks on this album that this track must avoid repeating',
    ];
  }

  return { songwriting: enriched };
}

function buildVocalPerformanceEngine({ isRap, isRock, isElectronic, characterName, isExplicit, brandStyle, sw }) {
  if (isRap) {
    return {
      priority: `The vocal is the main instrument for ${characterName}; prioritize attack, timing, breath control, character shifts, and adlib placement over generic loudness or surface confidence.`,
      vocal_textures: [
        'clipped consonant attacks',
        'dry close-mic delivery',
        'sudden double-time bursts',
        'whispered aside lines',
        'barked one-word adlibs',
      ],
      timing_behaviors: [
        'behind-the-beat swagger punctuated by snap-ahead double-time',
        'rhythmic pauses before punchlines',
        'intentionally uneven phrase lengths',
      ],
      adlib_behaviors: [
        'self-interrupting adlibs that cut across the main vocal',
        'call-and-response with self',
        'dry one-word reactions in pockets',
      ],
      avoid: [
        'single steady unvarying flow across an entire track',
        'generic surface-level confidence tone without character texture',
        'smooth radio-safe delivery when the brand calls for edge',
        'polished round vocals that erase attack',
      ],
    };
  }
  if (isRock) {
    return {
      priority: `Vocal texture and rawness drive the identity of ${characterName}; prioritize grain, breath, and dynamic range over perfection.`,
      vocal_textures: [
        'cracked upper-register breaks',
        'dry spoken-to-sung transitions',
        'grit on sustained notes',
        'whispered verses erupting into shout',
      ],
      timing_behaviors: [
        'phrases that hang behind the beat for tension',
        'sudden eruptions ahead of the downbeat',
        'breath-exposed pauses before climaxes',
      ],
      adlib_behaviors: [
        'raw echo doubles on key words',
        'half-sung background harmonies that feel unstable',
      ],
      avoid: [
        'clean auto-tuned pop delivery',
        'generic soaring rock clichés without character',
        'smooth polished tone that removes grain',
      ],
    };
  }
  if (isElectronic) {
    return {
      priority: `Voice-as-texture is central to ${characterName}; treat the vocal as a sound design element — processed, distanced, or fragmented.`,
      vocal_textures: [
        'fragmented syllable cuts',
        'heavily reverbed distant vocals',
        'dry whisper versus wet processed contrast',
        'spoken word over pulse',
      ],
      timing_behaviors: [
        'vocal entering after a full bar of silence',
        'syncopated non-metered phrase starts',
        'held vowels that decay into the texture',
      ],
      adlib_behaviors: [
        'reversed vocal fragments as texture',
        'pitched-down voice doubling the lead',
      ],
      avoid: [
        'conventionally melodic pop delivery without texture',
        'overuse of obvious vocal chops as novelty',
        'radio-ready clarity when moodiness is more fitting',
      ],
    };
  }
  return {
    priority: `The voice of ${characterName} should feel specific and non-replaceable — not a generic performer delivering the genre defaults for ${brandStyle}.`,
    vocal_textures: [
      'character-specific tonal quality',
      'dynamic range from intimate to full',
      'deliberate breath placement',
    ],
    timing_behaviors: [
      'phrases that breathe against the beat rather than sitting squarely on it',
    ],
    adlib_behaviors: [
      'personality-driven reactive adlibs',
    ],
    avoid: [
      'generic genre-default vocal delivery',
      'smooth performance that removes character roughness',
    ],
  };
}

function buildPerformanceConceitBank({ isRap, isRock, isElectronic }) {
  if (isRap) {
    return [
      'the vocal sounds bored until every fourth bar snaps into a vicious double-time burst',
      'adlibs argue with the lead vocal like a second personality fighting for the mic',
      'the hook is built from clipped breath fragments rather than a smooth traditional chorus',
      'the beat drops out completely before punchlines so the vocal lands dry and exposed',
      'the verse starts like a private confession and mutates into an open aggressive flex',
      'the rapper rides behind the beat in the verse then suddenly jumps three beats ahead at the hook',
      'every section ends with a self-interrupting line that undercuts what was just said',
      'the hook is a single repeated word with shifting delivery — bored, then furious, then amused',
    ];
  }
  if (isRock) {
    return [
      'the verse is spoken dry then the chorus erupts into full voice without warning',
      'the bridge strips away all instruments except a single guitar and raw unguarded vocal',
      'the final chorus is sung half-time over a double-time rhythm section',
      'every third line deliberately cracks on the high note and keeps going',
      'the guitar riff is introduced by the vocal melody before the instruments play it',
      'the outro dissolves from full arrangement into a single sustained raw vocal note',
    ];
  }
  if (isElectronic) {
    return [
      'the vocal enters as texture — reversed and barely recognizable — before snapping into clarity at the drop',
      'the hook is a single repeated vocal fragment pitch-shifted across an octave',
      'the verse vocals are whispered over 4-on-the-floor before erupting into processed shout on the chorus',
      'silence replaces the expected bass hit; the vocal fills the hole',
      'the lead vocal is doubled by a pitched-down version that creates unsettling width',
    ];
  }
  return [
    'the song opens mid-sentence as if we have walked in on something already in progress',
    'the most emotional moment of the song is also the quietest',
    'the hook deliberately avoids resolution — it asks instead of declares',
    'the expected instrumental break is replaced by an a capella moment',
    'the final line contradicts the premise established in the first line',
  ];
}

function buildAlbumModeLanes({ isRap, isRock, isElectronic, brandStyle }) {
  if (isRap) {
    return [
      { name: 'pressure track', description: 'dense flows, beat-stop punchlines, technical vocal precision, minimal melodic relief, maximum controlled aggression' },
      { name: 'theatrical villain', description: 'character voices, monologue breaks, sarcasm, sudden mood flips, dramatic pauses, strange narrative hooks' },
      { name: 'club menace', description: 'bass-forward, chantable, physical, high-energy, with hostile humor and weird vocal cuts' },
      { name: 'ugly funny chaos', description: 'absurd insults, crooked hooks, odd percussion, self-adlib arguments, intentionally unstable delivery' },
      { name: 'wounded flex', description: 'hard exterior, exposed emotional cracks, private confession moments, less club, more tension and vulnerability' },
      { name: 'experimental texture', description: 'strange bass textures, sparse drums, alien vocal pockets, humid atmosphere, non-obvious rap language' },
    ];
  }
  if (isRock) {
    return [
      { name: 'raw catharsis', description: 'loud, fast, unguarded, emotionally exposed, minimum production polish' },
      { name: 'slow-burn tension', description: 'sparse verse builds to full-band explosion, dynamic contrast as the primary weapon' },
      { name: 'dark narrative', description: 'story-driven, character-specific, unsettling imagery, melody as emotional anchor' },
      { name: 'noise experiment', description: 'unconventional song movement, distortion as texture, deconstructed structure' },
    ];
  }
  if (isElectronic) {
    return [
      { name: 'hypnotic pulse', description: 'repetitive, meditative, gradual micro-shifts, texture over melody' },
      { name: 'emotional peak', description: 'melodic anchor, dynamic buildup to euphoric release, human warmth inside electronic coldness' },
      { name: 'alien fragment', description: 'dissonant, sparse, unsettling, non-functional song structures, sound as environment' },
      { name: 'floor pressure', description: 'bass-forward, body-focused, functional club energy with a strange edge' },
    ];
  }
  return [
    { name: 'intimate', description: 'close-mic, personal, stripped production, emotional directness' },
    { name: 'expansive', description: 'full arrangement, dynamic arc, emotional climax' },
    { name: 'strange', description: 'unconventional structure, unexpected sonic choices, specific weirdness' },
    { name: 'energetic', description: 'high tempo, physical energy, chorus-forward, immediate impact' },
  ];
}

function buildSongDifferentiationRules() {
  return [
    'Adjacent tracks must differ in at least three of: hook type, flow behavior, vocal posture, sonic oddity, emotional angle, tempo/energy, imagery cluster, arrangement trick, adlib personality.',
    'No two consecutive tracks may share the same opening vocal move.',
    'No two consecutive tracks may share the same hook delivery style (chant, fragmented, melodic, spoken, single-word).',
    'Rotate emotional angle across tracks: do not stack more than two tracks with the same dominant emotion.',
    'Vary tempo feel — not just BPM, but whether the vocal sits behind, on, or ahead of the beat.',
    'At least one track per album should have an unusual sonic entry point that violates genre default expectations.',
  ];
}

function buildAntiGenericRules({ brandStyle, isRap, isRock, isElectronic, guardrail }) {
  const rules = [
    'Do not produce a standard genre song with only expected production and surface-level lyrics. Every track must have a specific identifiable creative decision.',
    'Every track must have a vocal gimmick, sonic oddity, or performance conceit recognizable within the first 10 seconds.',
    'Avoid generic empowerment or confidence language unless it is filtered through the artist\'s specific character voice and subverted or complicated.',
  ];
  if (isRap) {
    rules.push('Avoid single steady rap flow maintained across the entire track — flow must move.');
    rules.push('Avoid smooth radio-safe delivery when the profile calls for attack, sharpness, or danger.');
    rules.push('Avoid hooks that are melodic, polished, or pop-smooth when the brand voice is raw or hostile.');
  }
  if (isRock) {
    rules.push('Avoid generic rock anthem structures with predictable verse-chorus movement and inspirational language.');
    rules.push('Avoid clean vocals when grain and roughness are brand-appropriate.');
  }
  if (isElectronic) {
    rules.push('Avoid obvious drop-build-drop structures as the sole creative decision.');
    rules.push('Avoid over-relying on vocal chops or pitch-shifting as novelty without a stronger creative rationale.');
  }
  rules.push(`Reject any output that could have been made by any artist in the ${brandStyle} genre — output must be distinctively this character.`);
  return rules;
}

function buildDoNotRepeatList() {
  return [
    'same vocal conceit or delivery gimmick used in any prior track on this album',
    'same hook type (melodic/chant/fragmented/spoken/single-word) as the previous track',
    'same opening vocal move as any track in the first half of the album',
    'same rhyme family used as the primary sonic anchor more than twice across the album',
    'same dominant imagery cluster (violence/love/money/nature/tech) on consecutive tracks',
    'same emotional conclusion (triumphant/resigned/angry/vulnerable) on more than two consecutive tracks',
    'same beat-switch or structural trick used in any prior track on this album',
    'same adlib personality as the directly preceding track',
  ];
}

export function lintProfile(profile, profileId = 'profile') {
  const errors = [];
  const warnings = [];

  const sw = profile.songwriting || {};
  const music = profile.music || {};
  const character = profile.character || {};

  if (!sw.vocal_performance_engine) {
    warnings.push('[missing enriched field] songwriting.vocal_performance_engine — no vocal identity defined; generator will default to generic genre delivery');
  }
  if (!sw.performance_conceit_bank || sw.performance_conceit_bank.length === 0) {
    warnings.push('[missing enriched field] songwriting.performance_conceit_bank — no per-song vocal tricks defined; tracks may sound samey');
  }
  if (!sw.album_mode_lanes || sw.album_mode_lanes.length === 0) {
    warnings.push('[missing enriched field] songwriting.album_mode_lanes — no album variety lanes; multi-album output may collapse into one sound');
  }
  if (!sw.anti_generic_rules || sw.anti_generic_rules.length === 0) {
    warnings.push('[missing enriched field] songwriting.anti_generic_rules — no anti-generic rejection rules');
  }
  if (!sw.do_not_repeat_across_album || sw.do_not_repeat_across_album.length === 0) {
    warnings.push('[missing enriched field] songwriting.do_not_repeat_across_album — no album-level novelty guard');
  }

  const genreAdjectiveCount = countGenreAdjectives(music.default_style || '', music.default_prompt || '', sw.allowed_elements || []);
  if (genreAdjectiveCount > 6 && !sw.vocal_performance_engine) {
    warnings.push(`[generic style language] ${genreAdjectiveCount} broad genre adjectives found without vocal performance instructions — this tends to produce generic output`);
  }

  const artistNameHits = findRealArtistNamesInGenerationFields(profile);
  for (const hit of artistNameHits) {
    errors.push(`[real artist name] "${hit.name}" found in generation-facing field ${hit.field} — must be abstracted to traits`);
  }

  const repeatedPhrases = findRepeatedMotifPhrases(profile);
  for (const phrase of repeatedPhrases) {
    warnings.push(`[repeated motif overuse] "${phrase}" appears in multiple generation-facing fields`);
  }

  const score = Math.max(0, 100
    - errors.length * 20
    - warnings.filter(w => w.startsWith('[missing enriched')).length * 5
    - warnings.filter(w => !w.startsWith('[missing enriched')).length * 3
  );

  return {
    profileId,
    errors,
    warnings,
    score,
    passed: errors.length === 0,
  };
}

function countGenreAdjectives(...sources) {
  const text = sources.flat().join(' ').toLowerCase();
  let count = 0;
  for (const adj of GENERIC_GENRE_ADJECTIVES) {
    if (text.includes(adj)) count++;
  }
  return count;
}

function findRealArtistNamesInGenerationFields(profile) {
  const hits = [];
  const sw = profile.songwriting || {};

  const fieldsToCheck = [
    { path: 'songwriting.reference_artists_for_internal_vibe_only', value: (sw.reference_artists_for_internal_vibe_only || []).join(' ') },
    { path: 'songwriting.allowed_elements', value: (sw.allowed_elements || []).join(' ') },
    { path: 'songwriting.forbidden_elements', value: (sw.forbidden_elements || []).join(' ') },
    { path: 'songwriting.required_elements', value: (sw.required_elements || []).join(' ') },
    { path: 'songwriting.qa_rules', value: (sw.qa_rules || []).join(' ') },
    { path: 'music.default_style', value: profile.music?.default_style || '' },
    { path: 'music.default_prompt', value: profile.music?.default_prompt || '' },
    { path: 'character.core_concept', value: profile.character?.core_concept || '' },
    { path: 'songwriting.vocal_performance_engine', value: JSON.stringify(sw.vocal_performance_engine || {}) },
    { path: 'songwriting.anti_generic_rules', value: (sw.anti_generic_rules || []).join(' ') },
  ];

  for (const { path, value } of fieldsToCheck) {
    const lower = value.toLowerCase();
    for (const name of KNOWN_REAL_ARTIST_NAMES) {
      if (lower.includes(name)) {
        hits.push({ name, field: path });
      }
    }
  }

  return hits;
}

function findRepeatedMotifPhrases(profile) {
  const sw = profile.songwriting || {};
  const allText = [
    ...(sw.allowed_elements || []),
    ...(sw.forbidden_elements || []),
    ...(sw.required_elements || []),
    ...(sw.structure_preferences || []),
    ...(sw.qa_rules || []),
    profile.music?.default_style || '',
    profile.music?.default_prompt || '',
    profile.character?.core_concept || '',
  ].join('\n').toLowerCase();

  const motifCandidates = extractNgramsFromText(allText, 3);
  return motifCandidates
    .filter(([phrase, count]) => count >= 3 && phrase.split(' ').length >= 2)
    .map(([phrase]) => phrase)
    .slice(0, 5);
}

function extractNgramsFromText(text, minCount) {
  const words = text.replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  const counts = new Map();
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= minCount).sort((a, b) => b[1] - a[1]);
}
