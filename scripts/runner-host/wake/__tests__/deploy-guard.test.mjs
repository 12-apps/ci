import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Every setting deploy.sh does not read from the live fleet comes from the
// checkout's own defaults. On 2026-09-30 a deploy from an older checkout put
// the fleet back on 6000/500 disks and 4xlarge hosts for a day. deploy.sh now
// refuses to run from a checkout behind origin/main. Run here against a local
// origin, so no network is needed.

const here = path.dirname(fileURLToPath(import.meta.url));
const deploy = path.join(here, "..", "deploy.sh");

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

function checkout({ behind }) {
  const root = mkdtempSync(path.join(tmpdir(), "deploy-guard-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  mkdirSync(path.join(work, "wake"));
  copyFileSync(deploy, path.join(work, "wake", "deploy.sh"));
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "first");
  git(work, "push", "-q", "origin", "HEAD:main");
  if (behind) {
    // Someone else lands a commit on main; this checkout never pulls it.
    const other = path.join(root, "other");
    git(root, "clone", "-q", origin, other);
    writeFileSync(path.join(other, "later.txt"), "x");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "later");
    git(other, "push", "-q", "origin", "HEAD:main");
  }
  return path.join(work, "wake", "deploy.sh");
}

// The required settings are left out on purpose: past the check, deploy.sh
// stops at the first of them, before it can reach AWS.
const run = (script, env = {}) =>
  spawnSync("bash", [script], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, timeout: 30_000 });

test("a checkout behind origin/main is refused before anything else", () => {
  const r = run(checkout({ behind: true }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /behind origin\/main/);
});

test("a current checkout passes the check (and stops at the first missing setting)", () => {
  const r = run(checkout({ behind: false }));
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /behind origin\/main/);
  assert.match(r.stderr, /AWS_REGION/);
});

test("ALLOW_STALE=1 skips the check", () => {
  const r = run(checkout({ behind: true }), { ALLOW_STALE: "1" });
  assert.doesNotMatch(r.stderr, /behind origin\/main/);
  assert.match(r.stderr, /AWS_REGION/);
});
