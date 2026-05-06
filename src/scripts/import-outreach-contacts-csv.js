import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { getActiveProfileId } from '../shared/brand-profile.js';
import { initMarketingSchema, upsertMarketingTarget, upsertTargetSource } from '../shared/marketing-db.js';

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizePriority(value) {
  const priority = String(value || '').trim().toUpperCase();
  return ['P0', 'P1', 'P2', 'P3'].includes(priority) ? priority : 'P2';
}

function fitScoreForPriority(priority) {
  return { P0: 95, P1: 85, P2: 75, P3: 65 }[priority] || 70;
}

function recommendationForPriority(priority) {
  return priority === 'P0' || priority === 'P1' ? 'submit' : 'manual_review';
}

const sourcePath = resolve(getArg('--source') || 'outreach_contacts.csv');
const brandProfileId = getArg('--brand') || getActiveProfileId();

if (!fs.existsSync(sourcePath)) {
  console.error(`[OUTREACH-CSV] Source not found: ${sourcePath}`);
  process.exit(1);
}

initMarketingSchema();

const raw = fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
if (lines.length < 2) {
  console.error(`[OUTREACH-CSV] CSV appears empty: ${sourcePath}`);
  process.exit(1);
}

const header = parseCsvLine(lines[0]);
const expected = ['Name', 'Type', 'Priority', 'Contact Email'];
if (expected.some((label, index) => header[index] !== label)) {
  console.error(`[OUTREACH-CSV] Unexpected header. Got: ${header.join(' | ')}`);
  process.exit(1);
}

let imported = 0;
let skipped = 0;

for (const [index, line] of lines.slice(1).entries()) {
  const [name, type, priorityRaw, contactEmail] = parseCsvLine(line);
  if (!name || !type || !contactEmail) {
    skipped++;
    console.log(`[OUTREACH-CSV] Row ${index + 2}: skipped (missing name/type/contact email)`);
    continue;
  }

  const priority = normalizePriority(priorityRaw);
  const sourceUrl = `file://${sourcePath}#${slugify(name) || `row-${index + 2}`}`;
  const lowerType = String(type).trim().toLowerCase();

  try {
    upsertMarketingTarget({
      brand_profile_id: brandProfileId,
      name,
      type: lowerType,
      platform: 'email',
      source_url: sourceUrl,
      contact_method: 'email',
      contact_email: contactEmail,
      public_email: contactEmail,
      best_free_contact_method: 'email',
      fit_score: fitScoreForPriority(priority),
      ai_policy: 'unclear',
      recommendation: recommendationForPriority(priority),
      status: 'approved',
      freshness_status: 'fresh',
      last_verified_at: new Date().toISOString(),
      research_summary: `Imported from curated outreach_contacts.csv with enriched email contact information. Priority ${priority}.`,
      notes: `CSV import from ${sourcePath}`,
      raw_json: {
        imported_from: 'outreach_contacts.csv',
        imported_at: new Date().toISOString(),
        priority,
        category: lowerType,
        contact: {
          email: contactEmail,
          submission_path: 'email',
        },
        best_free_contact_method: 'email',
      },
      contactability: {
        status: 'contactable',
        free_contact_method_found: true,
        best_channel: 'email',
        contact_methods: [{ type: 'email', value: contactEmail, free: true }],
        evidence_url: sourceUrl,
      },
      outreach_eligibility: {
        eligible: true,
        reason_codes: [],
        reason_summary: 'Free email contact available',
        last_checked_at: new Date().toISOString(),
      },
      cost_policy: {
        requires_payment: false,
        cost_type: 'free',
        confidence: 'medium',
        evidence_url: sourceUrl,
      },
    });
    imported++;
    console.log(`[OUTREACH-CSV] Imported ${name} (${priority}, ${lowerType})`);
  } catch (error) {
    skipped++;
    console.log(`[OUTREACH-CSV] Row ${index + 2}: skipped ${name} — ${error.message}`);
  }
}

upsertTargetSource({
  brand_profile_id: brandProfileId,
  source_type: 'csv_import',
  source_name: 'outreach_contacts.csv',
  source_path: sourcePath,
  source_url: `file://${sourcePath}`,
  status: 'active',
  last_checked_at: new Date().toISOString(),
  notes: `Imported ${imported} contact rows from CSV`,
});

console.log(`\n[OUTREACH-CSV] Done: ${imported} imported, ${skipped} skipped from ${sourcePath}`);
