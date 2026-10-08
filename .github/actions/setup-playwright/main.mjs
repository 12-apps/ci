/* global process */
import { setupPlaywright } from './setup-playwright.mjs';

await setupPlaywright({
  browser: process.env.PW_BROWSER || 'chromium',
  attempts: Number(process.env.PW_ATTEMPTS || '3'),
  timeoutMs: Number(process.env.PW_TIMEOUT_SECONDS || '360') * 1000,
  cacheHit: process.env.PW_CACHE_HIT === 'true',
});
