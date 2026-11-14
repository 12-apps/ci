/**
 * Throwaway git repositories for the suite, and the CLI run inside them.
 *
 * Every child process gets an environment with no inherited `GIT_*` variable
 * (a suite started from a hook would otherwise read that hook's index) and
 * with the machine's git config switched off, so a global `core.hooksPath` or
 * a signing key cannot change what a fixture commit does. `GITHUB_*` is
 * dropped too: the tests that want the Actions output ask for it by name.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ACTION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CHECK = join(ACTION_DIR, "check.mjs");

const created = [];
process.on("exit", () => {
  for (const root of created) rmSync(root, { recursive: true, force: true });
});

export function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && !name.startsWith("GITHUB_")));
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extra };
}

/** Git in `root`, with `extra` added to the clean environment (a temporary index, say). */
export const gitWith = (extra, root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", env: cleanEnv(extra), stdio: ["ignore", "pipe", "pipe"] });

export const git = (root, ...args) => gitWith({}, root, ...args);

/** Write `files` (path → content) under `root`, creating directories. */
export function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** Stage everything and record it. */
export function commitAll(root, message = "change") {
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
}

/** A fresh directory that is removed when the test process exits. */
export function scratch(prefix = "terminology-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

/** A repository on `main` holding `files`, committed unless `commit: false`. */
export function repo(files = {}, { commit = true } = {}) {
  const root = scratch();
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  write(root, files);
  if (commit) commitAll(root, "initial");
  return root;
}

/** Run the CLI in `root`. `env` adds to the clean environment. */
export const run = (root, args, env = {}) => spawnSync(process.execPath, [CHECK, ...args], { cwd: root, encoding: "utf8", env: cleanEnv(env) });

/** A glossary with one enforced term, overridable: the shape most tests start from. */
export const glossary = (overrides = {}) =>
  JSON.stringify({
    include: ["src/**"],
    terms: [{ use: "motoboy", avoid: ["entregador", { word: "entregadores", use: "motoboys" }], autofix: true, reason: "Always motoboy." }],
    ...overrides,
  });
