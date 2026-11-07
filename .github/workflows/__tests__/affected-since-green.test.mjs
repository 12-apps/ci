/**
 * `affected-since-green`: Lint, Type Check and Build select what changed
 * since the lane was last green on this pull request (FUT-4557).
 *
 * Owner, 2026-11-07: on a pull request never compare against the base
 * branch; compare against the PR's own last tested head, and fall back to the
 * merge base when there is none. Every regression here is green — a range that
 * narrows past a change the lane never proved, a head recorded by a red job, a
 * force-pushed head trusted, a key that ignores the narrower range — so each is
 * pinned by RUNNING the steps' own scripts in a real git repository:
 *   - the input is declared, a boolean, default false (today's behaviour);
 *   - the head is restored and resolved before the verdict lookup, and keyed;
 *   - an ancestor head narrows TURBO_SCM_BASE/HEAD to green..PR head and
 *     exports AFFECTED_BASE; no head, garbage, the same head, an unknown or a
 *     non-ancestor head (force-push) keep the merge-base range;
 *   - the head is remembered only by a job that passed, never after a verdict
 *     hit, never off a pull request.
 *
 * Node builtins only — the self-test lane runs before any install.
 *
 * Usage: node --test .github/workflows/__tests__/affected-since-green.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKFLOWS = fileURLToPath(new URL("../", import.meta.url));
const JOBS = [
  { file: "monorepo-static.yml", job: "lint", lane: "lint" },
  { file: "monorepo-static.yml", job: "type-check", lane: "type-check" },
  { file: "monorepo-tests.yml", job: "build", lane: "build" },
];

function jobBody(file, name) {
  const text = readFileSync(join(WORKFLOWS, file), "utf8");
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, "m").exec(text);
  assert.ok(m, `${file} has no ${name} job`);
  return m[1];
}

/** The job's steps as [{ head, block }]. */
function steps(body) {
  const lines = body.split("\n");
  const starts = lines.map((l, i) => (/^ {6}- /.test(l) ? i : -1)).filter((i) => i !== -1);
  return starts.map((s, k) => ({ head: lines[s], block: lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length).join("\n") }));
}

function runScript(block) {
  const lines = block.split("\n");
  const at = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  assert.notEqual(at, -1, "no run: | block");
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    out.push(line.slice(10));
  }
  return out.join("\n");
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();
}

/** A repo: main → a (PR commit 1) → b (PR commit 2); plus an unrelated orphan-ish branch x. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "since-green-"));
  const g = (...a) => git(dir, ...a);
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "f"), "0\n");
  g("add", "f");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  writeFileSync(join(dir, "f"), "1\n");
  g("commit", "-qam", "a");
  const a = g("rev-parse", "HEAD");
  writeFileSync(join(dir, "f"), "2\n");
  g("commit", "-qam", "b");
  const b = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "x", base);
  writeFileSync(join(dir, "f"), "x\n");
  g("commit", "-qam", "x");
  const x = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  return { dir, base, a, b, x };
}

function narrow(block, dir, { green, head }) {
  const out = join(dir, "out");
  const envFile = join(dir, "env");
  writeFileSync(out, "");
  writeFileSync(envFile, "");
  mkdirSync(join(dir, "g"), { recursive: true });
  if (green !== undefined) writeFileSync(join(dir, "g", "sha"), `${green}\n`);
  const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", runScript(block)], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, PR_HEAD_SHA: head, GREEN_FILE: join(dir, "g", green === undefined ? "missing" : "sha"), GITHUB_OUTPUT: out, GITHUB_ENV: envFile },
  });
  assert.equal(r.status, 0, r.stderr);
  const pairs = (f) => Object.fromEntries(readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => l.split("=")));
  return { outputs: pairs(out), env: pairs(envFile), stdout: r.stdout };
}

for (const file of ["monorepo-static.yml", "monorepo-tests.yml"]) {
  test(`${file} declares affected-since-green as an opt-in boolean, default false`, () => {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    const m = /\n {6}affected-since-green:\n((?: {8}.*\n| {10}.*\n)+)/.exec(text);
    assert.ok(m, "not declared: a caller passing it is a startup_failure");
    assert.match(m[1], /^\s+type: boolean$/m);
    assert.match(m[1], /^\s+required: false$/m);
    assert.match(m[1], /^\s+default: false$/m, "a true default would change every consumer's selection");
  });
}

for (const { file, job, lane } of JOBS) {
  const body = jobBody(file, job);
  const all = steps(body);
  const find = (re) => all.findIndex((s) => re.test(s.block));

  test(`${job}: the green head is restored and resolved after the selection and before the verdict lookup`, () => {
    const selection = find(/id: selection\n/);
    const restore = find(/id: green-restore\n/);
    const green = find(/id: green\n/);
    const lookup = find(/id: lane-verdict\n/);
    assert.ok(selection < restore && restore < green && green < lookup, `${selection} < ${restore} < ${green} < ${lookup}`);
    const r = all[restore].block;
    assert.match(r, /if: \$\{\{ inputs\.affected-since-green && github\.event_name == 'pull_request' && steps\.selection\.outputs\.base-sha != '' \}\}/);
    assert.match(r, /uses: actions\/cache\/restore@v4/);
    assert.match(r, new RegExp(`path: \\.last-green-${lane}\\n`));
    assert.match(r, new RegExp(`key: last-green-${lane}-pr\\$\\{\\{ github\\.event\\.pull_request\\.number \\}\\}-\\$\\{\\{ github\\.event\\.pull_request\\.head\\.sha \\}\\}`));
    assert.match(r, new RegExp(`restore-keys: \\|\\n\\s+last-green-${lane}-pr\\$\\{\\{ github\\.event\\.pull_request\\.number \\}\\}-\\n`), "per-PR prefix: never another PR's head");
    assert.match(all[green].block, /if: \$\{\{ steps\.green-restore\.outcome == 'success' \}\}/);
    assert.match(all[green].block, new RegExp(`GREEN_FILE: \\.last-green-${lane}/sha`));
  });

  test(`${job}: the verdict key carries the narrowed base`, () => {
    assert.match(all[find(/id: lane-verdict\n/)].block, /\n\s+green-base=\$\{\{ steps\.green\.outputs\.base \}\}\n/, "a verdict proved on a narrow range must not answer a wide one");
  });

  test(`${job}: an ancestor green head narrows the range to green..PR head`, () => {
    const { dir, a, b } = repo();
    const r = narrow(all[find(/id: green\n/)].block, dir, { green: a, head: b });
    assert.deepEqual(r.outputs, { base: a });
    assert.deepEqual(r.env, { TURBO_SCM_BASE: a, TURBO_SCM_HEAD: b, AFFECTED_BASE: a });
  });

  test(`${job}: no head, garbage, the same head, an unknown or a non-ancestor head keep the merge-base range`, () => {
    const { dir, b, x } = repo();
    const block = all[find(/id: green\n/)].block;
    for (const [label, green] of [["none", undefined], ["garbage", "not-a-sha"], ["same head", b], ["unknown", "f".repeat(40)], ["force-pushed away", x]]) {
      const r = narrow(block, dir, { green, head: b });
      assert.deepEqual(r.outputs, {}, label);
      assert.deepEqual(r.env, {}, label);
    }
  });

  test(`${job}: the head is remembered only by a passing job, never after a hit, never off a pull request`, () => {
    const remember = all.find((s) => /name: Remember this head as the lane's last green/.test(s.block));
    const save = all.find((s) => /name: Save the lane's last green head/.test(s.block));
    assert.ok(remember && save, "no record steps");
    const cond = "if: ${{ success() && inputs.affected-since-green && github.event_name == 'pull_request' && steps.lane-verdict.outputs.hit != 'true' }}";
    assert.ok(remember.block.includes(cond), remember.block);
    assert.ok(save.block.includes(cond), save.block);
    assert.match(save.block, new RegExp(`key: last-green-${lane}-pr\\$\\{\\{ github\\.event\\.pull_request\\.number \\}\\}-\\$\\{\\{ github\\.event\\.pull_request\\.head\\.sha \\}\\}`));
    const { dir, b } = repo();
    const r = spawnSync("bash", ["-e", "-c", runScript(remember.block)], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, PR_HEAD_SHA: b } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, `.last-green-${lane}`, "sha"), "utf8"), `${b}\n`, "it records the PR head, not the merge commit");
    assert.ok(all.indexOf(save) < all.length - 1, "the lane verdict record stays the last step");
  });
}
