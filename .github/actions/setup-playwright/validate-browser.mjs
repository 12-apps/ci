/* global process */
// Resolve from the consumer, never from the engine checkout or a global CLI.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const requested = process.env.PW_BROWSER || 'chromium';
const version = require('@playwright/test/package.json').version;
if (!process.env.PW_VERSION || version !== process.env.PW_VERSION) {
  throw new Error('requested Playwright version is missing or differs from the installed version');
}
if (!['chromium', 'firefox', 'webkit'].includes(requested)) {
  throw new Error(`browser validation is inconclusive for ${requested}`);
}
// The installed API picks its own exact browser revision and headless executable.
// A binary in some other cache directory or an unrelated system Chrome cannot pass.
const browser = await require('@playwright/test')[requested].launch({ headless: true, timeout: 20_000 });
try {
  const page = await browser.newPage();
  if (await page.evaluate(() => 6 * 7) !== 42) throw new Error('browser evaluation failed');
} finally {
  await browser.close();
}
console.log(`validated Playwright ${version} ${requested}: launch, page and evaluation passed`);
