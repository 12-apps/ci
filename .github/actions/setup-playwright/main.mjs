/* global process */
/**
 * Entry point for the setup-playwright action. The logic worth testing lives in
 * `install-playwright.mjs`; this is the thin shell that reads the action's
 * inputs off the environment and writes apt's config before handing over.
 */
import { execFileSync } from 'node:child_process';

import { APT_CONF, APT_CONF_PATH, installWithRetry } from './install-playwright.mjs';

const browser = process.env.PW_BROWSER || 'chromium';
const attempts = Number(process.env.PW_ATTEMPTS || '3');
const timeoutMs = Number(process.env.PW_TIMEOUT_SECONDS || '360') * 1000;
// A cache hit restores the browser binaries but NOT the apt system deps — they
// live outside ~/.cache/ms-playwright — so the two paths install different
// things. Both reach apt, so both are bounded.
const cacheHit = process.env.PW_CACHE_HIT === 'true';

execFileSync('sudo', ['tee', APT_CONF_PATH], { input: APT_CONF, stdio: ['pipe', 'ignore', 'inherit'] });

const args = cacheHit ? ['install-deps', browser] : ['install', '--with-deps', browser];
const used = await installWithRetry({ args, attempts, timeoutMs });
if (used > 1) console.log(`playwright ${args.join(' ')} succeeded on attempt ${used}`);
