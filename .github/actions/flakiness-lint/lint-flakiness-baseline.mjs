#!/usr/bin/env node
// Runs ESLint with the flakiness suppressions baseline when present, but strips
// any file that has been touched in this PR/working tree so its exemption is
// revoked — touched files must be fully clean.
//
// This runner is the SINGLE SOURCE OF TRUTH shipped inside the `flakiness-lint`
// composite action. It decouples three things so it can lint a CONSUMER repo
// using the PROVIDER's config + eslint toolchain:
//
//   FLAKINESS_ROOT       consumer checkout — cwd for git + eslint; source of the
//                        eslint-suppressions.json baseline and the lint targets.
//                        Default: the repo this script sits in (standalone use).
//   FLAKINESS_CONFIG     path to eslint.flakiness.config.mjs. Default: a sibling
//                        file next to this script (so plugins resolve from the
//                        PROVIDER's node_modules, not the consumer's).
//   FLAKINESS_ESLINT_BIN absolute path to eslint's bin. When set, eslint is
//                        invoked as `node <bin> …` (PROVIDER toolchain); when
//                        unset, falls back to `pnpm exec eslint` (standalone).
//   FLAKINESS_TARGETS    space-separated lint targets. Default: `apps packages`
//                        (monorepo). The action passes `.` for single-package
//                        repos. CLI args after `--` override (pre-commit path).

import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';

// Consumer checkout: where git runs, where the baseline + tests live.
const ROOT = process.env.FLAKINESS_ROOT
  ? resolve(process.env.FLAKINESS_ROOT)
  : resolve(new URL('.', import.meta.url).pathname);
const SUPPRESSIONS = join(ROOT, 'eslint-suppressions.json');

// Config from the PROVIDER (this action). Default: sibling of this script.
const CONFIG = process.env.FLAKINESS_CONFIG
  ? resolve(process.env.FLAKINESS_CONFIG)
  : resolve(new URL('./eslint.flakiness.config.mjs', import.meta.url).pathname);

const ESLINT_BIN = process.env.FLAKINESS_ESLINT_BIN
  ? resolve(process.env.FLAKINESS_ESLINT_BIN)
  : '';

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function getChangedFiles() {
  // Prefer PR base if available (CI sets GITHUB_BASE_REF). Fall back to origin/main.
  const base = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : 'origin/main';

  // Files changed in commits + uncommitted changes (working tree + staged).
  const committed = git(`diff --name-only --diff-filter=AMR ${base}...HEAD`);
  const working = git('diff --name-only --diff-filter=AMR HEAD');
  const staged = git('diff --name-only --diff-filter=AMR --cached');
  const set = new Set(
    [committed, working, staged]
      .join('\n')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return set;
}

function stripChangedFromSuppressions(suppressions, changed) {
  let removed = 0;
  for (const path of Object.keys(suppressions)) {
    if (changed.has(path)) {
      delete suppressions[path];
      removed++;
    }
  }
  return removed;
}

function getSuppressionsArgs() {
  if (!existsSync(SUPPRESSIONS)) {
    return [];
  }

  const changed = getChangedFiles();
  const suppressions = JSON.parse(readFileSync(SUPPRESSIONS, 'utf8'));

  const dir = mkdtempSync(join(tmpdir(), 'flakiness-suppressions-'));
  const tempFile = join(dir, 'eslint-suppressions.json');
  const removed = stripChangedFromSuppressions(suppressions, changed);
  writeFileSync(tempFile, JSON.stringify(suppressions, null, 2));

  if (removed > 0) {
    console.log(
      `[lint-flakiness-baseline] revoked exemptions for ${removed} touched file(s); they must now be fully clean.`,
    );
  }

  return ['--suppressions-location', tempFile];
}

function resolveTargets() {
  // CLI args after `--` are paths to lint (used by pre-commit to lint only
  // staged files). Then FLAKINESS_TARGETS. Then the monorepo default.
  const cliPaths = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (cliPaths.length > 0) return cliPaths;
  if (process.env.FLAKINESS_TARGETS) {
    return process.env.FLAKINESS_TARGETS.split(/\s+/).filter(Boolean);
  }
  return ['apps', 'packages'];
}

function main() {
  const targets = resolveTargets();
  const configPath = isAbsolute(CONFIG) ? CONFIG : join(ROOT, CONFIG);
  const eslintArgs = [
    '--config',
    configPath,
    ...targets,
    ...getSuppressionsArgs(),
  ];

  // PROVIDER toolchain: run the pinned eslint directly with cwd = consumer so
  // `files`/`ignores` globs and target paths resolve against the consumer,
  // while the config's plugin imports resolve from the PROVIDER's node_modules.
  // Standalone fallback: the consumer's own eslint via pnpm.
  const [cmd, cmdArgs] = ESLINT_BIN
    ? ['node', [ESLINT_BIN, ...eslintArgs]]
    : ['pnpm', ['exec', 'eslint', ...eslintArgs]];

  const result = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

main();
