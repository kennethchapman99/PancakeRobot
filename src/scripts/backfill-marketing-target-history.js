import { getOutreachEvents } from '../shared/marketing-outreach-db.js';
import { updateMarketingTarget, getMarketingTargets } from '../shared/marketing-db.js';

const latestByTarget = new Map();
for (const event of getOutreachEvents({})) {
  const current = latestByTarget.get(event.target_id);
  if (!current || new Date(event.contacted_at || 0).getTime() > new Date(current.contacted_at || 0).getTime()) {
    latestByTarget.set(event.target_id, event);
  }
}

let updated = 0;
for (const target of getMarketingTargets({})) {
  const latest = latestByTarget.get(target.id);
  if (!latest) continue;
  updateMarketingTarget(target.id, {
    last_contact_at: latest.contacted_at || null,
    last_contact_release_marketing_id: latest.release_id || null,
    last_contact_release_title: latest.release_title || null,
    last_contact_subject: latest.subject || null,
    last_contact_body_preview: String(latest.message_body || '').slice(0, 240) || null,
    last_outcome: latest.status || null,
  });
  updated += 1;
}

console.log(`Backfilled target history for ${updated} marketing target(s).`);
