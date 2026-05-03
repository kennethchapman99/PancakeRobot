import express from 'express';
import { registerMarketingRouter } from './marketing/router-consolidated.js';

const originalGet = express.application.get;
const mountedApps = new WeakSet();

function ensureMarketingRouter(app) {
  if (mountedApps.has(app)) return;
  mountedApps.add(app);
  registerMarketingRouter(app);
}

express.application.get = function marketingRouterBootstrapGet(...args) {
  const first = args[0];
  if (typeof first === 'string' && first.startsWith('/')) {
    ensureMarketingRouter(this);
  }
  return originalGet.apply(this, args);
};
