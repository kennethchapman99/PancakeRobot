/**
 * Smoke test for the consolidated marketing router.
 * Spins up a minimal Express app (no full server.js) and fires HTTP requests.
 * Exits 0 on all pass, 1 on any failure.
 */

import express from 'express';
import { registerMarketingRouter } from '../web/marketing/router-consolidated.js';
import { upsertSong } from '../shared/db.js';

upsertSong({
  id: 'SONG_SOCIAL_SMOKE',
  title: 'Smoke Test Social Song',
  topic: 'robot pancakes',
  status: 'submitted to DistroKid',
  marketing_links: {
    smart_link: 'https://example.com/listen/smoke-test-social-song',
    release_kit_url: 'https://example.com/release-kit/smoke-test-social-song',
    instagram_url: 'https://instagram.com/pancakerobotmusic',
  },
  marketing_assets: {
    square_post_url: 'https://example.com/assets/smoke-square.png',
    vertical_post_url: 'https://example.com/assets/smoke-vertical.png',
    portrait_post_url: 'https://example.com/assets/smoke-portrait.png',
    cover_safe_promo_url: 'https://example.com/assets/smoke-cover-safe.png',
    no_text_variation_url: 'https://example.com/assets/smoke-no-text.png',
    generated_at: new Date().toISOString(),
  },
  marketing_inputs_from_ar: {
    use_in_daily_social_push: true,
    prioritize_next_daily_campaign: true,
  },
  release_recommendation: { score: 90, updated_at: new Date().toISOString() },
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
registerMarketingRouter(app);
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(0, async () => {
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const tests = [
    // HTML pages
    ['GET /marketing returns 200 HTML',                         'GET',  '/marketing',                          200, null, true],
    ['GET /marketing/social returns 200 HTML',                  'GET',  '/marketing/social',                   200, null, true],
    ['GET /marketing/campaigns/fake returns 404 HTML',          'GET',  '/marketing/campaigns/fake',           404, null, true],

    // API routes — outlets
    ['GET /api/marketing/outlets returns 200 ok:true',          'GET',  '/api/marketing/outlets',              200, b => b.ok === true && Array.isArray(b.outlets)],
    ['GET /api/marketing/outlets/summary returns 200',          'GET',  '/api/marketing/outlets/summary',      200, b => b.ok === true],

    // API routes — outreach
    ['GET /api/marketing/outreach-items returns 200',           'GET',  '/api/marketing/outreach-items',       200, b => b.ok === true],
    ['GET /api/marketing/outreach-events returns 200',          'GET',  '/api/marketing/outreach-events',      200, b => b.ok === true],
    ['GET /api/marketing/outreach-summary returns 200',         'GET',  '/api/marketing/outreach-summary',     200, b => b.ok === true],
    ['POST /api/social/daily/run-dry-run returns 200',          'POST', '/api/social/daily/run-dry-run',       200, b => b.ok === true],

    // 404 for unknown routes
    ['GET unknown /api/marketing/x returns 404',                'GET',  '/api/marketing/nonexistent-route',    404, null],
  ];

  let passed = 0;
  let failed = 0;

  for (const [desc, method, path, expectedStatus, check, expectHtml] of tests) {
    try {
      const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' } });
      const contentType = res.headers.get('content-type') || '';
      const isJson = contentType.includes('json');
      const body = isJson ? await res.json() : await res.text();

      if (res.status !== expectedStatus) {
        console.error(`FAIL  ${desc}`);
        console.error(`      expected status ${expectedStatus}, got ${res.status}`);
        failed++;
        continue;
      }

      if (check && isJson && !check(body)) {
        console.error(`FAIL  ${desc}`);
        console.error(`      body check failed:`, JSON.stringify(body).slice(0, 120));
        failed++;
        continue;
      }

      if (expectHtml && !contentType.includes('text/html')) {
        console.error(`FAIL  ${desc}`);
        console.error(`      expected text/html, got ${contentType}`);
        failed++;
        continue;
      }

      console.log(`PASS  ${desc}`);
      passed++;
    } catch (err) {
      console.error(`FAIL  ${desc}`);
      console.error(`      ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
});
