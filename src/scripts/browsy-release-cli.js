#!/usr/bin/env node
//
// Drive the generic Browsy service for a Pancake Robot release over HTTP.
//
//   npm run browsy:contract -- --type single --id SONG_123
//   npm run browsy:dry-run  -- --type single --id SONG_123
//   npm run browsy:preview  -- --type single --id SONG_123
//   npm run browsy:live     -- --type single --id SONG_123 --auto-approve
//   npm run browsy:run      -- --type single --id SONG_123 --stages dry_run,preview
//
// Base URL comes from BROWSY_BASE_URL (default http://localhost:3001). Live
// submissions require an approval token via --token or BROWSY_APPROVAL_TOKEN.

import { BrowsyClient } from '../shared/browsy-client.js';
import { runReleaseBrowsyPipeline } from '../shared/browsy-release-pipeline.js';

const [, , command = '', ...rest] = process.argv;

try {
  const args = parseArgs(rest);
  const client = new BrowsyClient();

  switch (command) {
    case 'contract': {
      requireRelease(args);
      const { workflowId } = await resolveWorkflowForRelease(args);
      const contract = await client.getContract({ workflowId, version: args.version || '' });
      print({ ok: true, workflowId, contract });
      break;
    }
    case 'dry-run':
      print(await runStages(client, args, ['dry_run']));
      break;
    case 'preview':
      print(await runStages(client, args, ['dry_run', 'preview']));
      break;
    case 'live':
      print(await runStages(client, args, ['dry_run', 'preview', 'live']));
      break;
    case 'run':
      print(await runStages(client, args, parseStages(args.stages)));
      break;
    default:
      throw new Error(`Unknown browsy command: "${command}". Use contract|dry-run|preview|live|run.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function runStages(client, args, stages) {
  requireRelease(args);
  return runReleaseBrowsyPipeline({
    releaseType: args.type,
    releaseId: args.id,
    workflowId: args.workflow || '',
    version: args.version || '',
    stages,
    approvalToken: args.token || process.env.BROWSY_APPROVAL_TOKEN || '',
    approvedBy: args.approvedBy || process.env.BROWSY_APPROVED_BY || 'pancake-robot',
    autoApproveSubmit: Boolean(args.autoApprove),
    client,
  });
}

async function resolveWorkflowForRelease(args) {
  const { buildReleaseCockpitViewModel } = await import('../shared/release-cockpit.js');
  const { buildDistroKidPayloadFromCockpit } = await import('../shared/distrokid-payload.js');
  const cockpit = buildReleaseCockpitViewModel(args.type, args.id);
  if (!cockpit) throw new Error(`Release not found: ${args.type}/${args.id}`);
  const canonical = buildDistroKidPayloadFromCockpit(cockpit);
  const workflowId = args.workflow
    || (String(canonical.release_type).toLowerCase() === 'album'
      ? (process.env.BROWSY_DISTROKID_ALBUM_WORKFLOW || 'distrokid-album-submit')
      : (process.env.BROWSY_DISTROKID_SINGLE_WORKFLOW || 'distrokid-single-submit'));
  return { canonical, workflowId };
}

function requireRelease(args) {
  if (!args.type || !args.id) throw new Error('Both --type and --id are required.');
}

function parseStages(value) {
  const stages = String(value || '').split(',').map(stage => stage.trim()).filter(Boolean);
  return stages.length ? stages : ['dry_run', 'preview'];
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--type') args.type = next;
    else if (token === '--id') args.id = next;
    else if (token === '--workflow') args.workflow = next;
    else if (token === '--version') args.version = next;
    else if (token === '--stages') args.stages = next;
    else if (token === '--token') args.token = next;
    else if (token === '--approved-by') args.approvedBy = next;
    else if (token === '--auto-approve') args.autoApprove = true;
  }
  return args;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
