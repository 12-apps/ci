// Standalone ESLint config that ONLY enables test-flakiness rules. This is the
// SINGLE SOURCE OF TRUTH for the anti-flake ruleset across all consuming repos:
// it ships inside the `flakiness-lint` composite action, so a consumer never
// copies it — updating the rules here updates every repo on its next CI run.
//
// Used by the baseline wrapper (lint-flakiness-baseline.mjs) and by a consumer's
// local `lint:flakiness:regen` (which points --config at this file).
//
// IMPORTANT: this config intentionally does NOT spread the root config.
// The baseline file (eslint-suppressions.json) suppresses only
// test-flakiness/* rules; if any other rule fired here it would block CI
// because it has no corresponding suppression entry. Keep this config
// scoped to flakiness rules only.

import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import testFlakinessPlugin from 'eslint-plugin-test-flakiness';
import globals from 'globals';

export default [
  // Match the root config's ignores so the wrapper does not lint build
  // artifacts, generated routes, vendor folders, etc.
  {
    ignores: [
      '**/storybook-static/**',
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.vercel/**',
      '**/public/**',
      '**/*.min.js',
      '**/*.min.css',
      '.husky/**',
      '.git/**',
      '**/.vite/**',
      '**/.nx/**',
      '**/tmp/**',
      'scripts/**',
      '**/.react-router/**',
      '.devcontainer/bash_history',
      '.devcontainer/zsh_history',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  // Parser + globals for all test files. No other rules.
  {
    // `*.e2e.*` is here because a spec does not have to live under `tests/`.
    // A repo that CO-LOCATES its e2e specs next to the pages they drive
    // (future-pay: `apps/<spa>/src/pages/<route>/<route>.e2e.ts`) matched none
    // of the globs below and none of the tier overrides either, so the whole
    // anti-flake ruleset was silently inert over the suite it applies to most —
    // green not because the specs were clean but because nothing read them.
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.e2e.ts',
      '**/*.e2e.tsx',
      '**/tests/**/*.ts',
      '**/tests/**/*.tsx',
    ],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        project: false,
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
        ...globals.jest,
        vi: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'test-flakiness': testFlakinessPlugin,
    },
    rules: {
      // Base tier (unit tests): the FULL anti-flake set — all 18 rules as
      // errors. `recommended` only turns on 8; the block below widens it to the
      // remaining 10 so hard-coded timeouts, real DB/fs access, promise races,
      // animation waits, viewport-dependent assertions, brittle index/long-text
      // queries, element-removal/focus-timing checks are ALL caught.
      ...testFlakinessPlugin.configs.recommended.rules,
      'test-flakiness/no-animation-wait': 'error',
      'test-flakiness/no-database-operations': 'error',
      'test-flakiness/no-element-removal-check': 'error',
      'test-flakiness/no-focus-check': 'error',
      'test-flakiness/no-hard-coded-timeout': 'error',
      'test-flakiness/no-index-queries': 'error',
      'test-flakiness/no-long-text-match': 'error',
      'test-flakiness/no-promise-race': 'error',
      'test-flakiness/no-unmocked-fs': 'error',
      'test-flakiness/no-viewport-dependent': 'error',
    },
  },
  // Integration tests run against real services (testcontainers / shared DB).
  // Real network calls, real DB/fs, shared state, and inter-test ordering are
  // expected — relax those rules; every other anti-flake rule still applies.
  {
    files: ['**/tests/integration/**/*.ts', '**/tests/integration/**/*.tsx'],
    rules: {
      'test-flakiness/no-unmocked-network': 'off',
      'test-flakiness/no-global-state-mutation': 'off',
      'test-flakiness/no-test-isolation': 'off',
      'test-flakiness/no-database-operations': 'off',
      'test-flakiness/no-unmocked-fs': 'off',
    },
  },
  // Smoke tests hit a running app/service over real HTTP. Health-check waits,
  // real network, real DB/fs, and shared state from the running target are
  // intrinsic.
  {
    files: ['**/tests/smoke/**/*.ts', '**/tests/smoke/**/*.tsx'],
    rules: {
      'test-flakiness/no-unmocked-network': 'off',
      'test-flakiness/no-unconditional-wait': 'off',
      'test-flakiness/no-global-state-mutation': 'off',
      'test-flakiness/no-test-isolation': 'off',
      'test-flakiness/no-database-operations': 'off',
      'test-flakiness/no-unmocked-fs': 'off',
    },
  },
  // E2E tests drive a real browser via Playwright. Page waits, real network,
  // real DB/fs seeding, and per-run unique fixture data are standard. The
  // remaining rules (timeouts, promise races, animation waits, viewport,
  // element-removal, long-text matches) still catch real e2e flakiness.
  //
  // Both LOCATIONS are listed, and this block must stay after the base tier so
  // its relaxations win. A co-located `*.e2e.ts` now matches the base tier
  // above; without the same path here it would be judged as a UNIT test, and
  // rules an e2e spec legitimately breaks (real network, page waits, seeded
  // data) would fail the gate on every well-written spec in the repo.
  {
    files: ['**/tests/e2e/**/*.ts', '**/tests/e2e/**/*.tsx', '**/*.e2e.ts', '**/*.e2e.tsx'],
    rules: {
      'test-flakiness/no-unmocked-network': 'off',
      'test-flakiness/no-unconditional-wait': 'off',
      'test-flakiness/no-random-data': 'off',
      'test-flakiness/no-global-state-mutation': 'off',
      'test-flakiness/no-test-isolation': 'off',
      'test-flakiness/no-test-focus': ['error', { allowSkip: true }],
      'test-flakiness/no-database-operations': 'off',
      'test-flakiness/no-unmocked-fs': 'off',
      // The two below describe TESTING-LIBRARY idioms, and read Playwright's
      // equivalents as the smell they are not. Both were measured against
      // future-pay's 103 co-located specs when the globs above started matching
      // them: 51 and 7 findings, every one a false positive.
      //
      // `no-index-queries` targets `getAllBy…()[0]` — picking an arbitrary
      // element out of a list. Playwright's `.first()` is not that: with strict
      // mode a locator matching two nodes THROWS, so `.first()` is the
      // sanctioned way to disambiguate, and `a.or(b).first()` is the documented
      // way to wait for either of two outcomes. Requiring a narrower query
      // where the DOM genuinely holds two matches would push specs toward
      // `nth()` on a positional index, which is the fragility this rule exists
      // to prevent.
      'test-flakiness/no-index-queries': 'off',
      // `no-cached-api-wait` flags waiting on a response that may already have
      // fired. Playwright's answer is to ARM the waiter before the action and
      // await it after — `const done = page.waitForResponse(…); await
      // toggle.check(); await done;` — which the rule still reports because it
      // only sees the call, not the ordering. Flagging the correct pattern
      // teaches people to delete the wait, which is how a spec becomes flaky.
      'test-flakiness/no-cached-api-wait': 'off',
    },
  },
];
