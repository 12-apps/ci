import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// expo-apk.yml hands an app its Sentry DSN at build time: the optional
// `SENTRY_DSN` secret, exported under the variable the caller names in
// `sentry-dsn-env`, to `prebuild` and `assembleRelease` and nothing else.
//
// Every way this goes wrong is green. A DSN that never reaches Gradle builds a
// perfectly good APK whose crash reporting is off for ever (expo-constants
// re-evaluates the app config INSIDE assembleRelease, so exporting it to
// prebuild alone is the same bug). A DSN routed through $GITHUB_ENV works and
// hands the value to every later step and third-party action. An absent secret
// that fails the build turns an optional input into a required one for every
// consumer. So the step bodies are extracted from the workflow and RUN, against
// a stub pnpm and a stub gradlew, rather than only read.
//
// Dependency-free (node: builtins, raw-text extraction rather than a YAML
// parse), like the rest of this folder: it runs in self-test.yml's
// `action-scripts` job, which has no install step.

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.join(here, "..", "expo-apk.yml");
const text = readFileSync(WORKFLOW, "utf8");
const lines = text.split("\n");

const DSN = "https://0123456789abcdef@o42.ingest.sentry.io/4242";

/** The lines of the step called `name`, from its `- name:` line to the next step. */
function stepLines(name) {
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `no step named "${name}" in expo-apk.yml`);
  const indent = lines[start].indexOf("-");
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    const ind = l.length - l.trimStart().length;
    if (l.trim() !== "" && ind <= indent && !l.trimStart().startsWith("#")) break;
    end++;
  }
  return lines.slice(start, end);
}

/** The step's `run: |` body, dedented. */
function stepRun(name) {
  const step = stepLines(name);
  const at = step.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(at >= 0, `step "${name}" has no block run:`);
  const keyIndent = step[at].length - step[at].trimStart().length;
  const body = [];
  for (const l of step.slice(at + 1)) {
    const ind = l.length - l.trimStart().length;
    if (l.trim() !== "" && ind <= keyIndent) break;
    body.push(l);
  }
  const min = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return body.map((l) => l.slice(min)).join("\n");
}

/** The step's own `env:` map, as raw expression text. */
function stepEnv(name) {
  const step = stepLines(name);
  const at = step.findIndex((l) => /^\s+env:\s*$/.test(l));
  if (at < 0) return {};
  const keyIndent = step[at].length - step[at].trimStart().length;
  const env = {};
  for (const l of step.slice(at + 1)) {
    const ind = l.length - l.trimStart().length;
    if (l.trim() !== "" && ind <= keyIndent) break;
    const m = /^\s+([A-Z_][A-Z0-9_]*):\s*(.+?)\s*$/.exec(l);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** Run a step body the way the runner does (`bash --noprofile --norc -eo pipefail`). */
function runStep(body, env, cwd) {
  const dir = mkdtempSync(path.join(tmpdir(), "expo-apk-dsn-"));
  const out = path.join(dir, "output");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", body], {
    cwd: cwd ?? dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, RUNNER_TEMP: dir, ...env },
  });
  const outputs = {};
  for (const l of readFileSync(out, "utf8").split("\n")) {
    const i = l.indexOf("=");
    if (i > 0) outputs[l.slice(0, i)] = l.slice(i + 1);
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs };
}

/** A directory holding a stub executable that records what it saw of `varName`. */
function stubBin(file, varName) {
  const dir = mkdtempSync(path.join(tmpdir(), "expo-apk-stub-"));
  const seen = path.join(dir, "seen");
  const bin = path.join(dir, file);
  writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s' "\${${varName}-<unset>}" > "${seen}"\n`);
  chmodSync(bin, 0o755);
  return { dir, bin, seen: () => readFileSync(seen, "utf8"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// The value may appear on stdout ONLY inside the runner's own mask command.
function assertNeverEchoed(stdout, stderr) {
  const leaks = `${stdout}\n${stderr}`.split("\n").filter((l) => l.includes(DSN) && !l.startsWith("::add-mask::"));
  assert.deepEqual(leaks, [], "the DSN was printed outside ::add-mask::");
}

test("the secret and the input are declared optional, with a default that exports nothing unasked", () => {
  assert.match(text, /\n {6}SENTRY_DSN:\n(?: {8}.*\n)*? {8}required: false\n/, "secret SENTRY_DSN must be declared with required: false");
  const input = /\n {6}sentry-dsn-env:\n((?: {8}.*\n)+)/.exec(text);
  assert.ok(input, "input sentry-dsn-env must be declared");
  assert.match(input[1], / {8}type: string\n/);
  assert.match(input[1], / {8}required: false\n/);
  assert.match(input[1], / {8}default: 'SENTRY_DSN'\n/);
});

test("the DSN reaches prebuild and Assemble, and no other step, never through $GITHUB_ENV", () => {
  const carriers = [];
  let current = null;
  for (const l of lines) {
    const m = /^\s+- name: (.+?)\s*$/.exec(l);
    if (m) current = m[1];
    if (l.includes("secrets.SENTRY_DSN }}")) carriers.push(current);
  }
  assert.deepEqual(carriers.sort(), ["Assemble", "Generate the native project", "Hand the build its Sentry DSN"].sort());
  for (const name of ["Generate the native project", "Assemble"]) {
    const env = stepEnv(name);
    assert.equal(env.EXPO_APK_SENTRY_DSN, "${{ secrets.SENTRY_DSN }}", `${name} must receive the secret`);
    assert.equal(env.EXPO_APK_SENTRY_DSN_ENV, "${{ steps.dsn.outputs.env }}", `${name} must read the validated name`);
  }
  assert.equal(stepEnv("Hand the build its Sentry DSN").EXPO_APK_SENTRY_DSN_ENV, "${{ inputs.sentry-dsn-env }}");
  assert.doesNotMatch(stepRun("Hand the build its Sentry DSN"), /GITHUB_ENV/);
  // The step that decides has to run before the two that use it.
  const order = ["Hand the build its Sentry DSN", "Generate the native project", "Assemble"].map((n) =>
    lines.findIndex((l) => l.trim() === `- name: ${n}`),
  );
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("no secret: nothing is exported, the step passes, the summary says absent", () => {
  const r = runStep(stepRun("Hand the build its Sentry DSN"), {
    EXPO_APK_SENTRY_DSN: "",
    EXPO_APK_SENTRY_DSN_ENV: "SENTRY_DSN_MOTOBOY",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.env, undefined);
  assert.match(r.outputs.summary, /^Sentry DSN: absent/);
});

test("a secret and a valid name: the name is handed on, the value is masked and never echoed", () => {
  const r = runStep(stepRun("Hand the build its Sentry DSN"), {
    EXPO_APK_SENTRY_DSN: DSN,
    EXPO_APK_SENTRY_DSN_ENV: "SENTRY_DSN_MOTOBOY",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.split("\n").includes(`::add-mask::${DSN}`), "the value must be masked");
  assertNeverEchoed(r.stdout, r.stderr);
  assert.equal(r.outputs.env, "SENTRY_DSN_MOTOBOY");
  assert.match(r.outputs.summary, /^Sentry DSN: present/);
  assert.ok(!Object.values(r.outputs).some((v) => v.includes(DSN)), "the value must not be written to a step output");
});

test("a secret and an invalid name: a warning, no DSN, and still no failure", () => {
  for (const bad of ["", "SENTRY-DSN", "1DSN", "A B", "X;rm -rf /"]) {
    const r = runStep(stepRun("Hand the build its Sentry DSN"), {
      EXPO_APK_SENTRY_DSN: DSN,
      EXPO_APK_SENTRY_DSN_ENV: bad,
    });
    assert.equal(r.status, 0, `name ${JSON.stringify(bad)}: ${r.stderr}`);
    assert.equal(r.outputs.env, undefined, `name ${JSON.stringify(bad)} must not be handed on`);
    assert.match(r.stdout, /::warning /);
    assert.match(r.outputs.summary, /NOT applied/);
    assertNeverEchoed(r.stdout, r.stderr);
  }
});

test("prebuild sees the DSN under the caller's name, and sees nothing when there is none", () => {
  const body = stepRun("Generate the native project");
  for (const [name, value, want] of [
    ["SENTRY_DSN_MOTOBOY", DSN, DSN],
    ["", "", "<unset>"],
  ]) {
    const pnpm = stubBin("pnpm", "SENTRY_DSN_MOTOBOY");
    const r = runStep(body, {
      PATH: `${pnpm.dir}:${process.env.PATH}`,
      APP: "motoboy",
      EXPO_APK_SENTRY_DSN: value,
      EXPO_APK_SENTRY_DSN_ENV: name,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(pnpm.seen(), want);
    assertNeverEchoed(r.stdout, r.stderr);
    pnpm.done();
  }
});

test("assembleRelease sees the DSN under the caller's name, and sees nothing when there is none", () => {
  const body = stepRun("Assemble");
  for (const [name, value, want] of [
    ["SENTRY_DSN_MOTOBOY", DSN, DSN],
    ["", "", "<unset>"],
  ]) {
    const gradlew = stubBin("gradlew", "SENTRY_DSN_MOTOBOY");
    const r = runStep(
      body,
      {
        ABIS: "arm64-v8a",
        SIGNED: "",
        EXPO_APK_SENTRY_DSN: value,
        EXPO_APK_SENTRY_DSN_ENV: name,
      },
      gradlew.dir,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(gradlew.seen(), want);
    assertNeverEchoed(r.stdout, r.stderr);
    gradlew.done();
  }
});

test("the job summary reports the DSN state, present or absent, and nothing more", () => {
  const env = stepEnv("Prove the APK exists, and that it is the one that was asked for");
  assert.equal(env.SENTRY_DSN_STATE, "${{ steps.dsn.outputs.summary }}");
  assert.match(stepRun("Prove the APK exists, and that it is the one that was asked for"), /echo "- \$\{SENTRY_DSN_STATE\}"/);
});
