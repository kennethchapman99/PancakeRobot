/**
 * Release Planner Agent
 * Builds per-song or per-album release plans from local state.
 * No external sending. Uses cached target library — no live research.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSong, getAllSongs, getReleaseLinks } from '../shared/db.js';
import { loadBrandProfileById, getActiveProfileId } from '../shared/brand-profile.js';
import { getReleaseMatches, getApprovedTargetsForBrand, getSuppressionRules, initMarketingSchema, createMarketingAgentRun, logMarketingAgentRun, finishMarketingAgentRun } from '../shared/marketing-db.js';
import { getInboxMessages } from '../shared/marketing-inbox-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');

function outputDir(songId) { return path.join(REPO_ROOT, 'output/marketing-ready', songId); }
function albumDir(albumId) { return path.join(REPO_ROOT, 'output/albums', albumId); }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
function writeMd(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

// ─── Song readiness check ─────────────────────────────────────────────────────

function checkSongReadiness(songId, brandProfile) {
  const songDir = path.join(REPO_ROOT, 'output/songs', songId);
  const distDir = path.join(REPO_ROOT, 'output/distribution-ready', songId);
  const packDir = outputDir(songId);
  const refDir = path.join(songDir, 'reference');

  const hasAudio = fs.existsSync(path.join(distDir, 'upload-this.mp3')) || fs.existsSync(path.join(songDir, 'audio.mp3'));
  const hasCover = fs.existsSync(distDir) && fs.readdirSync(distDir).some(f => /\.(png|jpg|jpeg)$/i.test(f));
  const hasLyrics = fs.existsSync(path.join(songDir, 'lyrics.md')) || fs.existsSync(path.join(songDir, 'lyrics-clean.txt'));
  const hasMetadata = fs.existsSync(path.join(songDir, 'metadata.json'));
  const hasMarketingPack = fs.existsSync(path.join(packDir, 'metadata.json'));
  const hasBaseImage = fs.existsSync(refDir) && fs.readdirSync(refDir).some(f => f.startsWith('base-image'));
  const links = [];
  try { const l = getReleaseLinks(songId); links.push(...l); } catch {}

  return {
    finalAudio: hasAudio,
    coverArt: hasCover,
    lyrics: hasLyrics,
    metadata: hasMetadata,
    marketingPack: hasMarketingPack,
    baseImage: hasBaseImage,
    releaseLinks: links.length > 0,
    linkCount: links.length,
    links,
  };
}

// ─── Single release plan ──────────────────────────────────────────────────────

export async function buildReleasePlan(songId, options = {}) {
  initMarketingSchema();
  const brandProfileId = options.brandProfileId || getActiveProfileId();
  const runId = createMarketingAgentRun({ agentName: 'release-planner-agent', runType: 'release_plan', input: { songId, brandProfileId } });
  const log = (level, msg) => { logMarketingAgentRun(runId, level, msg); if (options.logger) options.logger(`[${level}] ${msg}`); else console.log(`[RELEASE-PLAN] ${msg}`); };

  try {
    const song = getSong(songId);
    if (!song) throw new Error(`Song not found: ${songId}`);

    const brandProfile = loadBrandProfileById(brandProfileId);
    const readiness = checkSongReadiness(songId, brandProfile);
    const matches = getReleaseMatches(songId, brandProfileId);
    const approvedTargets = getApprovedTargetsForBrand(brandProfileId);

    const packMeta = readJson(path.join(outputDir(songId), 'metadata.json'));
    const songMeta = readJson(path.join(REPO_ROOT, 'output/songs', songId, 'metadata.json'));

    log('info', `Building release plan for ${song.title || songId}`);

    const missing = [];
    if (!readiness.finalAudio) missing.push('Final audio file (upload-this.mp3)');
    if (!readiness.coverArt) missing.push('Cover art image');
    if (!readiness.marketingPack) missing.push('Marketing pack (run: npm run marketing -- ' + songId + ')');
    if (!readiness.releaseLinks) missing.push('Release / streaming links');
    if (approvedTargets.length === 0) missing.push('Approved promotion targets (import and approve targets first)');
    if (matches.length === 0) missing.push('Target matches for this release (run: npm run marketing:targets:match -- --song-id ' + songId + ')');

    const humanTasks = [];
    const agentTasks = [];

    if (missing.length) {
      humanTasks.push(...missing.map(m => ({ task: m, status: 'missing', priority: 'high' })));
    }
    humanTasks.push({ task: 'Review and approve release plan', status: 'pending', priority: 'high' });
    humanTasks.push({ task: 'Manually post to social platforms using captions.md', status: 'pending', priority: 'high' });
    humanTasks.push({ task: 'Review outreach drafts before sending any emails', status: 'pending', priority: 'high' });

    agentTasks.push({ task: 'Build marketing pack', status: readiness.marketingPack ? 'done' : 'pending', command: `npm run marketing -- ${songId}` });
    agentTasks.push({ task: 'Match targets for release', status: matches.length > 0 ? 'done' : 'pending', command: `npm run marketing:targets:match -- --song-id ${songId}` });
    agentTasks.push({ task: 'Generate outreach drafts', status: 'pending', command: `npm run marketing:agent -- --song-id ${songId} --promote` });

    const plan = {
      release_type: 'single',
      song_id: songId,
      song_title: song.title || songId,
      brand_profile_id: brandProfileId,
      brand_name: brandProfile.brand_name,
      generated_at: new Date().toISOString(),
      readiness,
      missing_prerequisites: missing,
      human_tasks: humanTasks,
      agent_tasks: agentTasks,
      approved_targets: approvedTargets.length,
      matched_targets: matches.length,
      top_matches: matches.slice(0, 5).map(m => {
        let reasons = [];
        try { reasons = JSON.parse(m.match_reasons_json || '[]'); } catch {}
        return { target_id: m.target_id, score: m.match_score, recommended_action: m.recommended_action, reasons };
      }),
      social_asset_status: {
        marketing_pack_built: readiness.marketingPack,
        base_image_present: readiness.baseImage,
        pack_metadata: packMeta ? { qa_status: packMeta.qa_status, generated_at: packMeta.generated_at } : null,
      },
      release_links: readiness.links,
      distribution: {
        distributor: song.distributor || brandProfile.distribution.default_distributor,
        artist: songMeta?.primary_artist || brandProfile.distribution.default_artist,
        genres: songMeta?.primary_genre ? [songMeta.primary_genre] : brandProfile.distribution.spotify_genres,
      },
      outreach_plan: {
        targets_to_pitch: matches.filter(m => m.status === 'planned').length,
        drafts_dir: `output/marketing-ready/${songId}/outreach-drafts/`,
        instructions: 'Review outreach-drafts/ folder. All sends are manual.',
      },
      post_release: {
        inbox_monitoring: 'Scan Gmail inbox weekly: npm run marketing:gmail:scan -- --write',
        follow_up_days: 14,
        followup_plan: `output/marketing-ready/${songId}/post-release-followup.md`,
      },
    };

    const outDir = outputDir(songId);
    writeJson(path.join(outDir, 'release-plan.json'), plan);
    writeMd(path.join(outDir, 'release-plan.md'), formatReleasePlanMd(plan));

    log('info', `Release plan saved to output/marketing-ready/${songId}/release-plan.json`);
    log('info', `Missing prerequisites: ${missing.length}`);
    log('info', `Approved targets: ${approvedTargets.length}, Matched: ${matches.length}`);

    const result = { status: 'done', songId, planPath: `output/marketing-ready/${songId}/release-plan.json`, plan };
    finishMarketingAgentRun(runId, 'done', result);
    return result;
  } catch (err) {
    finishMarketingAgentRun(runId, 'error', null, err.message);
    throw err;
  }
}

// ─── Safe promotion run ───────────────────────────────────────────────────────

export async function runSafePromotion(songId, options = {}) {
  initMarketingSchema();
  const brandProfileId = options.brandProfileId || getActiveProfileId();
  const runId = createMarketingAgentRun({ agentName: 'release-planner-agent', runType: 'promotion_run', input: { songId, brandProfileId } });
  const log = (level, msg) => { logMarketingAgentRun(runId, level, msg); if (options.logger) options.logger(`[${level}] ${msg}`); else console.log(`[PROMOTION] ${msg}`); };

  try {
    const song = getSong(songId);
    if (!song) throw new Error(`Song not found: ${songId}`);

    const brandProfile = loadBrandProfileById(brandProfileId);
    const matches = getReleaseMatches(songId, brandProfileId);
    const suppressed = getSuppressionRules(brandProfileId);
    const suppressedIds = new Set(suppressed.map(s => s.target_id).filter(Boolean));
    const approvedTargets = getApprovedTargetsForBrand(brandProfileId);
    const packMeta = readJson(path.join(outputDir(songId), 'metadata.json'));

    log('info', `Running safe local promotion for ${song.title || songId}`);
    log('info', `No external sending will occur (MARKETING_OUTREACH_DRY_RUN=${process.env.MARKETING_OUTREACH_DRY_RUN || 'true'})`);

    const outDir = outputDir(songId);
    const draftsDir = path.join(outDir, 'outreach-drafts');
    fs.mkdirSync(draftsDir, { recursive: true });

    const eligibleMatches = matches.filter(m => {
      if (suppressedIds.has(m.target_id)) { log('info', `Suppressed: ${m.target_id}`); return false; }
      return m.status === 'planned' && m.match_score >= parseInt(process.env.MARKETING_TARGET_MIN_FIT_SCORE || '70', 10);
    });

    log('info', `Eligible targets for outreach drafts: ${eligibleMatches.length}`);

    const draftsWritten = [];
    for (const match of eligibleMatches.slice(0, parseInt(process.env.MARKETING_MAX_DAILY_OUTREACH || '10', 10))) {
      const target = approvedTargets.find(t => t.id === match.target_id);
      if (!target) continue;

      const draft = buildOutreachDraft(target, song, brandProfile, packMeta, match);
      const fname = `${target.id}-${target.type}.md`;
      const fpath = path.join(draftsDir, fname);
      writeMd(fpath, draft);
      draftsWritten.push({ targetId: target.id, name: target.name, type: target.type, file: `output/marketing-ready/${songId}/outreach-drafts/${fname}` });
      log('info', `Draft written: ${fname} (${target.name})`);
    }

    // Write campaign plan
    const campaignPlan = buildCampaignPlanMd(song, brandProfile, eligibleMatches, approvedTargets);
    writeMd(path.join(outDir, 'campaign-plan.md'), campaignPlan);

    // Write posting checklist
    const checklist = buildPostingChecklist(song, packMeta);
    writeMd(path.join(outDir, 'posting-checklist.md'), checklist);

    // Write post-release followup
    const followup = buildFollowupPlan(song, brandProfile);
    writeMd(path.join(outDir, 'post-release-followup.md'), followup);

    const report = {
      song_id: songId,
      generated_at: new Date().toISOString(),
      dry_run: process.env.MARKETING_OUTREACH_DRY_RUN !== 'false',
      external_sending: false,
      eligible_targets: eligibleMatches.length,
      drafts_written: draftsWritten.length,
      drafts: draftsWritten,
      outputs: {
        campaign_plan: `output/marketing-ready/${songId}/campaign-plan.md`,
        posting_checklist: `output/marketing-ready/${songId}/posting-checklist.md`,
        outreach_drafts: `output/marketing-ready/${songId}/outreach-drafts/`,
        post_release_followup: `output/marketing-ready/${songId}/post-release-followup.md`,
      },
      instructions: 'All outreach is manual. Review drafts/ folder, then send by hand.',
    };

    writeJson(path.join(outDir, 'promotion-run-report.json'), report);
    log('info', `Promotion run complete: ${draftsWritten.length} drafts, no external sends`);

    const result = { status: 'done', songId, report };
    finishMarketingAgentRun(runId, 'done', result);
    return result;
  } catch (err) {
    finishMarketingAgentRun(runId, 'error', null, err.message);
    throw err;
  }
}

// ─── Album release plan ───────────────────────────────────────────────────────

export async function buildAlbumReleasePlan(albumTitle, songIds, options = {}) {
  const albumId = options.albumId || `ALBUM_${Date.now().toString(36).toUpperCase()}`;
  const brandProfileId = options.brandProfileId || getActiveProfileId();
  const brandProfile = loadBrandProfileById(brandProfileId);

  const log = (msg) => { if (options.logger) options.logger(msg); else console.log(`[ALBUM-PLAN] ${msg}`); };
  log(`Building album plan: "${albumTitle}" (${songIds.length} tracks)`);

  const tracks = [];
  for (const [i, songId] of songIds.entries()) {
    const song = getSong(songId);
    if (!song) { log(`Warning: song not found: ${songId}`); continue; }
    const readiness = checkSongReadiness(songId, brandProfile);
    tracks.push({ track: i + 1, song_id: songId, title: song.title || songId, status: song.status, readiness });
  }

  const plan = {
    album_id: albumId,
    album_title: albumTitle,
    brand_profile_id: brandProfileId,
    brand_name: brandProfile.brand_name,
    generated_at: new Date().toISOString(),
    track_count: tracks.length,
    tracks,
    readiness_summary: {
      all_audio_ready: tracks.every(t => t.readiness.finalAudio),
      all_cover_ready: tracks.every(t => t.readiness.coverArt),
      all_packs_built: tracks.every(t => t.readiness.marketingPack),
      tracks_ready: tracks.filter(t => t.readiness.finalAudio && t.readiness.coverArt).length,
    },
    album_requirements: [
      'Album cover art (3000x3000)',
      'Album title metadata for each track',
      'UPC code from distributor',
      'All tracks approved',
      'DistroKid: upload as album (not singles)',
    ],
    distrokid_checklist: [
      'Upload all tracks in sequence order',
      'Set album title on each track',
      'Set track numbers',
      'Upload album cover art',
      'Set release date (coordinate all tracks)',
      'Set primary genre across all tracks',
    ],
    campaign_notes: [
      'Release one album teaser single first if possible',
      'Schedule all track social posts across release week',
      'Submit to playlist curators as album + standalone tracks',
    ],
    outputs: {
      plan_json: `output/albums/${albumId}/album-release-plan.json`,
      plan_md: `output/albums/${albumId}/album-release-plan.md`,
    },
  };

  const dir = albumDir(albumId);
  writeJson(path.join(dir, 'album-release-plan.json'), plan);
  writeMd(path.join(dir, 'album-release-plan.md'), formatAlbumPlanMd(plan));
  log(`Album plan saved to output/albums/${albumId}/`);

  return { status: 'done', albumId, albumTitle, tracks: tracks.length, planPath: `output/albums/${albumId}/album-release-plan.json`, plan };
}

// ─── Markdown formatters ─────────────────────────────────────────────────────

function formatReleasePlanMd(plan) {
  const missing = plan.missing_prerequisites.length ? plan.missing_prerequisites.map(m => `- [ ] ${m}`).join('\n') : '- None';
  const humanTasks = plan.human_tasks.map(t => `- [ ] **${t.task}**`).join('\n');
  const agentTasks = plan.agent_tasks.map(t => `- [${t.status === 'done' ? 'x' : ' '}] ${t.task}${t.command ? `\n  \`${t.command}\`` : ''}`).join('\n');
  return `# Release Plan: ${plan.song_title}
Brand: ${plan.brand_name} | Profile: ${plan.brand_profile_id}
Generated: ${plan.generated_at}

## Missing Prerequisites
${missing}

## Human Tasks
${humanTasks}

## Agent Tasks
${agentTasks}

## Targets
- Approved: ${plan.approved_targets}
- Matched for this release: ${plan.matched_targets}

## Top Target Matches
${plan.top_matches.map(m => `- Score ${m.score}: ${m.target_id} → ${m.recommended_action} (${m.reasons.join('; ')})`).join('\n') || '- None matched yet'}

## Release Links
${plan.release_links.map(l => `- ${l.platform}: ${l.url}`).join('\n') || '- No links added yet'}

## Outreach
- Drafts directory: ${plan.outreach_plan.drafts_dir}
- ${plan.outreach_plan.instructions}

## Post-Release
- Monitor: ${plan.post_release.inbox_monitoring}
- Follow-up after ${plan.post_release.follow_up_days} days
`;
}

function formatAlbumPlanMd(plan) {
  const tracks = plan.tracks.map(t => `| ${t.track} | ${t.title} | ${t.status} | ${t.readiness.finalAudio ? '✓' : '✗'} audio | ${t.readiness.coverArt ? '✓' : '✗'} cover |`).join('\n');
  return `# Album Release Plan: ${plan.album_title}
Brand: ${plan.brand_name} | Album ID: ${plan.album_id}
Generated: ${plan.generated_at}

## Track List
| # | Title | Status | Audio | Cover |
|---|-------|--------|-------|-------|
${tracks}

## Readiness Summary
- Tracks with audio: ${plan.readiness_summary.tracks_ready}/${plan.track_count}
- All audio ready: ${plan.readiness_summary.all_audio_ready ? 'Yes' : 'No'}
- All packs built: ${plan.readiness_summary.all_packs_built ? 'Yes' : 'No'}

## Album Requirements
${plan.album_requirements.map(r => `- [ ] ${r}`).join('\n')}

## DistroKid Checklist
${plan.distrokid_checklist.map(r => `- [ ] ${r}`).join('\n')}

## Campaign Notes
${plan.campaign_notes.map(n => `- ${n}`).join('\n')}
`;
}

function buildOutreachDraft(target, song, brandProfile, packMeta, match) {
  const aiDisclosure = ['disclosure_required', 'individual_curator_choice'].includes(target.ai_policy)
    ? '\n\n*Disclosure: This music was created with AI assistance.*'
    : '';
  let reasons = [];
  try { reasons = JSON.parse(match.match_reasons_json || '[]'); } catch {}

  return `# Outreach Draft: ${target.name}
Target ID: ${target.id}
Type: ${target.type}
Platform: ${target.platform || 'n/a'}
AI Policy: ${target.ai_policy}
Match Score: ${match.match_score || 'n/a'}
Match Reasons: ${reasons.join('; ') || 'n/a'}

## Why This Release
${reasons.length ? reasons.map(r => `- ${r}`).join('\n') : '- Genre and audience fit'}

## Draft Pitch
Subject: ${song.title} — New Release from ${brandProfile.brand_name}

Hi ${target.name},

I wanted to share a new release from ${brandProfile.brand_name}: "${song.title}".${aiDisclosure}

${target.submission_url ? `You can submit/listen here: ${target.submission_url}` : `Source: ${target.source_url}`}

Please let me know if this is a fit. Happy to share the full track or press materials.

Best,
${brandProfile.distribution.default_artist || brandProfile.brand_name}

---
**Manual send instructions:**
1. Review and personalize this draft before sending
2. Send from your own email client — not automated
3. Record the send in your CRM/notes
4. Check inbox in 2 weeks for replies

**DO NOT auto-send this draft.**
`;
}

function buildCampaignPlanMd(song, brandProfile, matches, approvedTargets) {
  return `# Campaign Plan: ${song.title}
Brand: ${brandProfile.brand_name}
Generated: ${new Date().toISOString()}

## Strategy
- Type: Single release
- Artist: ${brandProfile.distribution.default_artist}
- Genre: ${brandProfile.distribution.primary_genre}

## Target Segments (${matches.length} matched)
${matches.slice(0, 20).map(m => `- [Score ${m.match_score}] ${m.target_id} → ${m.recommended_action}`).join('\n') || '- No matches yet'}

## Approved Targets (${approvedTargets.length} total)
Available in target library for this brand profile.

## Social Posting Plan
1. Post teaser on Instagram (Reels) on release day
2. Post on TikTok within 24h
3. Pin to bio link
4. Post YouTube Shorts version
5. Share in relevant communities

## Outreach Sequence
1. Pitch top-scored playlist curators first
2. Wait 14 days before follow-up
3. Track all responses in inbox scan
4. Mark opt-outs as do_not_contact immediately

## Safety Rules
- No auto-send
- No guaranteed-stream services
- No bot engagement services
- Respect opt-outs immediately
- Disclose AI where required
`;
}

function buildPostingChecklist(song, packMeta) {
  const dashboard = packMeta?.dashboard_url || 'output/marketing-ready/' + song.id + '/index.html';
  return `# Posting Checklist: ${song.title}

## Before Posting
- [ ] Review marketing pack: ${dashboard}
- [ ] Review captions.md
- [ ] Review upload-checklist.md
- [ ] Confirm release links are live (Spotify, Apple Music, YouTube)
- [ ] Test all links

## Instagram
- [ ] Post Reel (hook clip from captions.md)
- [ ] Add caption with hashtags
- [ ] Add link in bio
- [ ] Add to Highlights

## TikTok
- [ ] Post TikTok video
- [ ] Add caption and hashtags
- [ ] Check trending sounds (manual decision)

## YouTube
- [ ] Upload lyric video or visualizer
- [ ] Add description with all streaming links
- [ ] Add to playlist

## Streaming
- [ ] Confirm track is live on Spotify
- [ ] Confirm track is live on Apple Music
- [ ] Pitch to editorial playlists manually (if applicable)

## Outreach
- [ ] Review outreach drafts in outreach-drafts/
- [ ] Send manually from your email client
- [ ] Log sends in notes

## Post-Release (Day 7-14)
- [ ] Scan inbox: npm run marketing:gmail:scan -- --write
- [ ] Reply to interested curators/creators
- [ ] Mark any opt-outs as do_not_contact
`;
}

function buildFollowupPlan(song, brandProfile) {
  return `# Post-Release Follow-Up: ${song.title}

## Week 1
- Monitor streaming numbers
- Check for playlist additions
- Scan inbox for curator replies
- Engage with comments and shares

## Week 2
- Follow up with pitches that had no response (one time only)
- Share any press / playlist placements on social
- Compile initial metrics

## Week 4
- Review performance snapshot
- Decide on retargeting or next single
- Update target statuses based on responses

## Inbox Monitoring
Run weekly: \`npm run marketing:gmail:scan -- --write\`

## Do Not Contact List
Immediately update suppression rules if anyone replies with opt-out language.

## Next Release
- Plan next single release
- Reuse approved target library
- Run: \`npm run marketing:targets:match -- --song-id NEXT_SONG_ID\`
`;
}
