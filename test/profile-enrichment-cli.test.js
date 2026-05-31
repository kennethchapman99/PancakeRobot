import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { enrichProfileProposal, lintProfile } from '../src/shared/profile-enrichment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function makeProfile(overrides = {}) {
  return {
    brand_name: 'Test Brand',
    character: { name: 'Tester', core_concept: 'test character' },
    music: { default_style: 'rap', default_bpm: 120, default_prompt: 'hard rap beats' },
    songwriting: {
      song_type: 'rap',
      allowed_elements: ['hard language'],
      forbidden_elements: [],
      required_elements: [],
      structure_preferences: [],
      ...overrides.songwriting,
    },
    audience: { guardrail: 'adult content OK', explicitness: 'explicit_allowed' },
    ...overrides,
  };
}

// --- enrichProfileProposal (deterministic) ---

test('enrichProfileProposal proposes all 7 enriched fields for bare rap profile', () => {
  const profile = makeProfile();
  const proposal = enrichProfileProposal(profile);
  const keys = Object.keys(proposal.songwriting);
  assert.ok(keys.includes('vocal_performance_engine'), 'Should propose VPE');
  assert.ok(keys.includes('performance_conceit_bank'), 'Should propose conceit bank');
  assert.ok(keys.includes('album_mode_lanes'), 'Should propose lanes');
  assert.ok(keys.includes('song_differentiation_rules'), 'Should propose diff rules');
  assert.ok(keys.includes('anti_generic_rules'), 'Should propose anti-generic');
  assert.ok(keys.includes('do_not_repeat_across_album'), 'Should propose do-not-repeat');
  assert.ok(keys.includes('hidden_brief_requirements'), 'Should propose brief requirements');
});

test('enrichProfileProposal skips already-present fields', () => {
  const profile = makeProfile({
    songwriting: {
      song_type: 'rap',
      allowed_elements: [],
      forbidden_elements: [],
      required_elements: [],
      structure_preferences: [],
      vocal_performance_engine: { priority: 'existing', vocal_textures: ['existing texture'], timing_behaviors: [], adlib_behaviors: [], avoid: [] },
      performance_conceit_bank: ['existing conceit'],
      album_mode_lanes: [{ name: 'existing lane', description: 'existing' }],
      song_differentiation_rules: ['existing rule'],
      anti_generic_rules: ['existing anti-generic'],
      do_not_repeat_across_album: ['existing do-not-repeat'],
      hidden_brief_requirements: ['vocal_conceit'],
    },
  });
  const proposal = enrichProfileProposal(profile);
  const keys = Object.keys(proposal.songwriting);
  assert.equal(keys.length, 0, 'No new fields should be proposed when all already present');
});

test('enrichProfileProposal produces rock-flavored VPE for rock profile', () => {
  // Use song_type:'rock' so rock detection wins over default rap song_type.
  const profile = makeProfile({
    music: { default_style: 'indie rock', default_bpm: 130, default_prompt: 'rock song' },
    songwriting: { song_type: 'rock', allowed_elements: [], forbidden_elements: [], required_elements: [], structure_preferences: [] },
  });
  const proposal = enrichProfileProposal(profile);
  const vpe = proposal.songwriting.vocal_performance_engine;
  assert.ok(vpe, 'Should propose VPE');
  assert.ok(vpe.avoid.some(a => a.toLowerCase().includes('pop') || a.toLowerCase().includes('auto') || a.toLowerCase().includes('clean')), 'Rock VPE should avoid clean/pop delivery');
});

test('enrichProfileProposal VPE includes required sub-fields', () => {
  const profile = makeProfile();
  const proposal = enrichProfileProposal(profile);
  const vpe = proposal.songwriting.vocal_performance_engine;
  assert.ok(typeof vpe.priority === 'string');
  assert.ok(Array.isArray(vpe.vocal_textures) && vpe.vocal_textures.length > 0);
  assert.ok(Array.isArray(vpe.timing_behaviors) && vpe.timing_behaviors.length > 0);
  assert.ok(Array.isArray(vpe.adlib_behaviors) && vpe.adlib_behaviors.length > 0);
  assert.ok(Array.isArray(vpe.avoid) && vpe.avoid.length > 0);
});

test('enrichProfileProposal album_mode_lanes has name and description for each lane', () => {
  const profile = makeProfile();
  const proposal = enrichProfileProposal(profile);
  const lanes = proposal.songwriting.album_mode_lanes;
  assert.ok(Array.isArray(lanes) && lanes.length > 0);
  for (const lane of lanes) {
    assert.ok(typeof lane.name === 'string' && lane.name.length > 0, 'Lane must have name');
    assert.ok(typeof lane.description === 'string' && lane.description.length > 0, 'Lane must have description');
  }
});

test('enrichProfileProposal proposal does not include real artist names', () => {
  const profile = makeProfile();
  const proposal = enrichProfileProposal(profile);
  const text = JSON.stringify(proposal).toLowerCase();
  const artistNames = ['doechii', 'kendrick', 'drake', 'eminem', 'kanye', 'radiohead'];
  for (const name of artistNames) {
    assert.ok(!text.includes(name), `Proposal should not include artist name: ${name}`);
  }
});

// --- lintProfile ---

test('lintProfile warns on missing enriched fields for bare profile', () => {
  const profile = makeProfile();
  const result = lintProfile(profile, 'test-bare');
  assert.ok(result.warnings.some(w => w.includes('vocal_performance_engine')));
  assert.ok(result.warnings.some(w => w.includes('performance_conceit_bank')));
  assert.ok(result.warnings.some(w => w.includes('album_mode_lanes')));
  assert.ok(result.warnings.some(w => w.includes('anti_generic_rules')));
});

test('lintProfile reports no missing-field warnings for fully enriched profile', () => {
  const profile = makeProfile({
    songwriting: {
      song_type: 'rap',
      allowed_elements: [],
      forbidden_elements: [],
      required_elements: [],
      structure_preferences: [],
      vocal_performance_engine: { priority: 'test', vocal_textures: ['t'], timing_behaviors: ['t'], adlib_behaviors: ['t'], avoid: ['smooth'] },
      performance_conceit_bank: ['test conceit'],
      album_mode_lanes: [{ name: 'lane', description: 'desc' }],
      anti_generic_rules: ['rule'],
      do_not_repeat_across_album: ['item'],
    },
  });
  const result = lintProfile(profile, 'test-enriched');
  const missingFieldWarnings = result.warnings.filter(w => w.includes('[missing enriched field]'));
  assert.equal(missingFieldWarnings.length, 0, `Should have no missing-field warnings, got: ${missingFieldWarnings.join(', ')}`);
});

test('lintProfile errors on real artist name in generation-facing field', () => {
  const profile = makeProfile({
    music: { default_style: 'doechii-inspired experimental rap', default_bpm: 140, default_prompt: 'hard rap' },
  });
  const result = lintProfile(profile, 'test-artist-leak');
  assert.ok(result.errors.some(e => e.includes('[real artist name]') && e.toLowerCase().includes('doechii')));
  assert.equal(result.passed, false);
});

test('lintProfile score is lower for profile with errors than clean profile', () => {
  // doechii IS in the known real artist names list — should trigger an error.
  const badProfile = makeProfile({
    music: { default_style: 'doechii-inspired rap', default_bpm: 140, default_prompt: 'lyrical rap' },
  });
  const goodProfile = makeProfile({
    music: { default_style: 'hard experimental rap', default_bpm: 140, default_prompt: 'original beats' },
  });
  const badResult = lintProfile(badProfile, 'bad');
  const goodResult = lintProfile(goodProfile, 'good');
  assert.ok(badResult.score < goodResult.score, `Profile with errors (score=${badResult.score}) should be lower than clean profile (score=${goodResult.score}). Errors: ${badResult.errors.join(', ')}`);
});

test('lintProfile passes when no errors', () => {
  const profile = makeProfile({
    music: { default_style: 'experimental hip-hop', default_bpm: 130, default_prompt: 'original rap production' },
  });
  const result = lintProfile(profile, 'test-clean');
  assert.equal(result.passed, true);
  assert.equal(result.errors.length, 0);
});

// --- Dry-run: no files written ---

test('enrichProfileProposal is pure and never writes files', () => {
  const draftDir = path.join(REPO_ROOT, 'output', 'profile-drafts');
  const before = fs.existsSync(draftDir) ? fs.readdirSync(draftDir).length : 0;
  const profile = makeProfile();
  enrichProfileProposal(profile);
  lintProfile(profile, 'dry-run-test');
  const after = fs.existsSync(draftDir) ? fs.readdirSync(draftDir).length : 0;
  assert.equal(after, before, 'enrichProfileProposal and lintProfile should never write files');
});
