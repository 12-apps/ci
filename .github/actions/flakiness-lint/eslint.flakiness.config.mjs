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
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
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
  // element-removal, long-text/index queries) still catch real e2e flakiness.
  {
    files: ['**/tests/e2e/**/*.ts', '**/tests/e2e/**/*.tsx'],
    rules: {
      'test-flakiness/no-unmocked-network': 'off',
      'test-flakiness/no-unconditional-wait': 'off',
      'test-flakiness/no-random-data': 'off',
      'test-flakiness/no-global-state-mutation': 'off',
      'test-flakiness/no-test-isolation': 'off',
      'test-flakiness/no-test-focus': ['error', { allowSkip: true }],
      'test-flakiness/no-database-operations': 'off',
      'test-flakiness/no-unmocked-fs': 'off',
    },
  },
];
