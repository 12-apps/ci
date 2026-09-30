// The key decides whether a lane RUNS, so every way it can be wrong is a way a
// lane is skipped on a tree it never passed. Each refusal below is a case a
// real run produces: a push event, an unset command, a command that dies, a
// command that prints prose, a lane run with a different command.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { verdictKey } from "../verdict.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "verdict.mjs");
const TMP = mkdtempSync(join(tmpdir(), "lane-verdict-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const FP = "a".repeat(64);
const ok = (over = {}) => verdictKey({ lane: "lint", fingerprintCommand: "fp", material: "24\npnpm turbo run lint", event: "pull_request", run: () => `${FP}\n`, ...over });

test("a pull request with a hashing command gets `<lane>-lane-<key16>-<fingerprint>`", () => {
  const { key, fingerprint, why } = ok();
  assert.equal(why, "");
  assert.equal(fingerprint, FP);
  assert.match(key, new RegExp(`^lint-lane-[0-9a-f]{16}-${FP}$`));
});

test("the key folds in how the lane runs — a different command or Node version is a different key", () => {
  const base = ok().key;
  assert.notEqual(ok({ material: "22\npnpm turbo run lint" }).key, base, "Node version");
  assert.notEqual(ok({ material: "24\npnpm turbo run lint --filter x" }).key, base, "the command");
  assert.notEqual(ok({ fingerprintCommand: "fp --lane other" }).key, base, "the fingerprint command itself");
  assert.notEqual(ok({ lane: "type-check" }).key, base, "the lane");
  assert.equal(ok().key, base, "and the same inputs give the same key");
});

test("a fingerprint's surrounding whitespace is not part of it", () => {
  assert.equal(ok({ run: () => `  ${FP}\n\n` }).key, ok().key);
});

test("never off a pull request", () => {
  for (const event of ["push", "workflow_dispatch", "schedule", "", undefined]) {
    const { key, why } = ok({ event });
    assert.equal(key, "", `event ${JSON.stringify(event)}`);
    assert.match(why, /only on a pull request/);
  }
});

test("no command, a failing command, or a command that prints no hash — no key, and the reason", () => {
  assert.match(ok({ fingerprintCommand: "" }).why, /no fingerprint command/);
  assert.match(ok({ fingerprintCommand: "   " }).why, /no fingerprint command/);
  assert.match(ok({ run: () => { throw new Error("boom\nmore"); } }).why, /^fingerprint command failed: boom$/);
  assert.match(ok({ run: () => "not a hash" }).why, /no usable hash/);
  assert.match(ok({ run: () => "abc" }).why, /no usable hash/, "too short to be one");
  assert.match(ok({ run: () => "" }).why, /no usable hash/);
  for (const c of [ok({ fingerprintCommand: "" }), ok({ run: () => "not a hash" })]) assert.equal(c.key, "");
});

test("a lane that is not a name is refused (it prefixes a cache key)", () => {
  assert.equal(ok({ lane: "Lint Job" }).key, "");
  assert.equal(ok({ lane: "" }).key, "");
});

// ── the CLI, as the composite action runs it ────────────────────────────────

function cli(mode, env) {
  const outputs = join(TMP, `${mode}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(outputs, "");
  const r = spawnSync("node", [CLI, mode], { cwd: TMP, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputs, ...env } });
  const emitted = Object.fromEntries(readFileSync(outputs, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, emitted };
}

test("CLI key: runs the command through bash and writes key + fingerprint", () => {
  const r = cli("key", { LANE: "build", FP_CMD: `printf '%s\\n' ${FP}`, KEY_MATERIAL: "24", GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(r.code, 0);
  assert.match(r.emitted.key, new RegExp(`^build-lane-[0-9a-f]{16}-${FP}$`));
  assert.equal(r.emitted.fingerprint, FP);
});

test("CLI key: a failing command exits 0 with an EMPTY key — the lane runs, the job does not fail", () => {
  const r = cli("key", { LANE: "build", FP_CMD: "exit 3", KEY_MATERIAL: "24", GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(r.code, 0);
  assert.equal(r.emitted.key, "");
  assert.match(r.stdout, /no lookup — fingerprint command failed/);
});

test("CLI key: a push never looks anything up", () => {
  const r = cli("key", { LANE: "build", FP_CMD: `echo ${FP}`, KEY_MATERIAL: "24", GITHUB_EVENT_NAME: "push" });
  assert.equal(r.emitted.key, "");
});

test("CLI report: hit only when the probe said so AND a key existed", () => {
  assert.equal(cli("report", { LANE: "lint", KEY: "lint-lane-x", HIT: "true" }).emitted.hit, "true");
  assert.equal(cli("report", { LANE: "lint", KEY: "lint-lane-x", HIT: "false" }).emitted.hit, "false");
  assert.equal(cli("report", { LANE: "lint", KEY: "lint-lane-x", HIT: "" }).emitted.hit, "false");
  assert.equal(cli("report", { LANE: "lint", KEY: "", HIT: "true" }).emitted.hit, "false", "a hit with no key is a stale output, not a verdict");
  assert.match(cli("report", { LANE: "lint", KEY: "lint-lane-x", HIT: "true" }).stdout, /::notice::lint lane: .*already covered/);
});

test("CLI marker: writes the file the record step saves, naming the run", () => {
  const r = cli("marker", { LANE: "gates", KEY: "gates-lane-k", GITHUB_RUN_ID: "77", GITHUB_SHA: "abc" });
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(TMP, ".lane-verdict/gates/passed"), "utf8"), "gates-lane-k\nrun 77\nsha abc\n");
});

test("CLI: an unknown mode is a hard error", () => {
  assert.equal(cli("nope", {}).code, 2);
});
