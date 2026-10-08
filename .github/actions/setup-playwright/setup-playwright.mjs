/* global process */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APT_CONF, APT_CONF_PATH, installWithRetry, runBounded } from './install-playwright.mjs';

export async function setupPlaywright({ browser, cacheHit, attempts, timeoutMs }, {
  validate = () => runBounded(process.execPath, [fileURLToPath(new URL('./validate-browser.mjs', import.meta.url))], {
    timeoutMs: 30_000, graceMs: 5_000,
  }),
  configureApt = () => execFileSync('sudo', ['tee', APT_CONF_PATH], {
    input: APT_CONF, stdio: ['pipe', 'ignore', 'inherit'],
  }),
  install = installWithRetry,
  log = console.log,
} = {}) {
  // Only an affirmative real launch permits skipping apt; errors are inconclusive.
  let valid = false;
  try { valid = (await validate())?.ok === true; } catch { /* preserve fallback */ }
  if (valid) {
    log(`Playwright ${browser} validation passed; dependency installation is unnecessary`);
    return;
  }
  log(`Playwright ${browser} validation failed or was inconclusive; using bounded installation`);
  configureApt();
  const args = cacheHit ? ['install-deps', browser] : ['install', '--with-deps', browser];
  const used = await install({ args, attempts, timeoutMs });
  if (used > 1) log(`playwright ${args.join(' ')} succeeded on attempt ${used}`);
}
