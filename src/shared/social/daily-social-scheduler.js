import cron from 'node-cron';
import { createOrRefreshDailySocialCampaign } from '../../agents/daily-social-planner-agent.js';
import { runSocialPublishWorker } from '../../agents/social-publish-worker.js';
import { getSocialEnv } from './social-env.js';

let schedulerState = { started: false, tasks: [] };

function toCronExpression(timeText) {
  const [hours, minutes] = String(timeText || '09:00').split(':').map(Number);
  return `${Number.isFinite(minutes) ? minutes : 0} ${Number.isFinite(hours) ? hours : 9} * * *`;
}

export function stopDailySocialScheduler() {
  for (const task of schedulerState.tasks) task.stop();
  schedulerState = { started: false, tasks: [] };
}

export function startDailySocialScheduler() {
  const env = getSocialEnv();
  if (!env.dailySocialEnabled) return schedulerState;
  if (schedulerState.started) return schedulerState;

  const tasks = env.dailySocialPlatforms.map(platform => cron.schedule(
    toCronExpression(env.dailySocialTimes[platform]),
    async () => {
      const { campaign } = createOrRefreshDailySocialCampaign({ platforms: [platform] });
      if (!env.dailySocialRequireApproval) {
        await runSocialPublishWorker({ campaignId: campaign.id, force: true });
      }
    },
    { timezone: env.dailySocialTimezone },
  ));

  schedulerState = { started: true, tasks };
  return schedulerState;
}
