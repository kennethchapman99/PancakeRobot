/**
 * Smoke test for the consolidated marketing router.
 * Spins up a minimal Express app (no full server.js) and fires HTTP requests.
 * Exits 0 on all pass, 1 on any failure.
 */

import express from 'express';
import { registerMarketingRouter } from '../web/marketing/router-consolidated.js';

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
    ['GET /marketing/campaigns/fake returns 404 HTML',          'GET',  '/marketing/campaigns/fake',           404, null, true],

    // API routes — outlets
    ['GET /api/marketing/outlets returns 200 ok:true',          'GET',  '/api/marketing/outlets',              200, b => b.ok === true && Array.isArray(b.outlets)],
    ['GET /api/marketing/outlets/summary returns 200',          'GET',  '/api/marketing/outlets/summary',      200, b => b.ok === true],

    // API routes — outreach
    ['GET /api/marketing/outreach-items returns 200',           'GET',  '/api/marketing/outreach-items',       200, b => b.ok === true],
    ['GET /api/marketing/outreach-summary returns 200',         'GET',  '/api/marketing/outreach-summary',     200, b => b.ok === true],

    // 404 for unknown routes
    ['GET unknown /api/marketing/x returns 404',                'GET',  '/api/marketing/nonexistent-route',    404, null],
  ];

  let passed = 0;
  let failed = 0;

  for (const [desc, method, path, expectedStatus, check, expectHtml] of tests) {
    try {
      const res = await fetch(`${base}${path}`, { method });
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
