import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// expo-apk.yml prints the certificate its APK was signed with into the job
// summary, so whoever registers the app for Android developer verification can
// copy the SHA-256 from the run that produced the file. Every way this goes
// wrong is green: a fingerprint read from the keystore rather than the APK, a
// summary that omits it when apksigner is missing, a debug-signed build that
// presents the universal debug certificate as the app's own. So the step body
// is extracted and RUN, against a stub apksigner that prints what the real one
// prints (captured from `apksigner verify --print-certs`, build-tools 31).
//
// Dependency-free, like the rest of this folder: self-test.yml's
// `action-scripts` job has no install step.

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


const BASH = spawnSync("which", ["bash"], { encoding: "utf8" }).stdout.trim();
const STEP = "Print the signing certificate fingerprint";
const HEX = "60e2a8efe06d8656d3a91e3dd7623c0c0a8d47ea44ec23097db6b5460518116b";
const COLON = HEX.toUpperCase().replace(/(..)(?!$)/g, "$1:");

/** A work dir with an `android/` folder, optional APK, and stub apksigner/aapt2 on PATH. */
function fixture({ apk = true, apksigner = true, digest = HEX, signers = 1, aapt2 = "com.paladira.motoboy" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "expo-apk-fp-"));
  const bin = path.join(dir, "bin");
  const android = path.join(dir, "android");
  for (const d of [bin, android]) spawnSync("mkdir", ["-p", d]);
  if (apk) writeFileSync(path.join(android, "app-release.apk"), "not-a-real-zip");
  if (apksigner) {
    const lines = [];
    for (let i = 1; i <= signers; i++) {
      lines.push(`Signer #${i} certificate DN: CN=Throwaway Probe`);
      if (digest) lines.push(`Signer #${i} certificate SHA-256 digest: ${digest}`);
      lines.push(`Signer #${i} certificate SHA-1 digest: 19783a0830753aed4723ec55e589c7a6f2b4c740`);
    }
    const sh = path.join(bin, "apksigner");
    writeFileSync(sh, `#!${BASH}\ncat <<'EOT'\n${lines.join("\n")}\nEOT\n`);
    chmodSync(sh, 0o755);
  }
  // PATH is this directory alone, so a real apksigner on the machine running
  // the test cannot stand in for a missing stub.
  for (const t of ["cat", "sed", "tr", "ls", "sort", "tail", "mkdir"]) {
    spawnSync("ln", ["-s", spawnSync("which", [t], { encoding: "utf8" }).stdout.trim(), path.join(bin, t)]);
  }
  // `aapt2: null` leaves it off PATH; an empty string makes it print nothing.
  if (aapt2 !== null) {
    const sh = path.join(bin, "aapt2");
    writeFileSync(sh, `#!${BASH}\necho '${aapt2}'\n`);
    chmodSync(sh, 0o755);
  }
  return { dir, bin, android, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(fx, signed) {
  const summary = path.join(fx.dir, "summary.md");
  writeFileSync(summary, "");
  const r = spawnSync(BASH, ["--noprofile", "--norc", "-eo", "pipefail", "-c", stepRun(STEP)], {
    cwd: fx.android,
    encoding: "utf8",
    env: {
      PATH: fx.bin,
      GITHUB_STEP_SUMMARY: summary,
      APK: "app-release.apk",
      ...(signed ? { SIGNED: "true" } : {}),
    },
  });
  return { status: r.status, stderr: r.stderr, summary: readFileSync(summary, "utf8") };
}

test("the step runs after the APK is proven and reads the assembled APK, not the keystore", () => {
  const names = lines.map((l) => /^\s+- name: (.+?)\s*$/.exec(l)?.[1]).filter(Boolean);
  assert.ok(names.indexOf(STEP) > names.indexOf("Prove the APK exists, and that it is the one that was asked for"));
  const env = stepEnv(STEP);
  assert.equal(env.APK, "${{ steps.assemble.outputs.apk }}");
  assert.equal(env.SIGNED, "${{ steps.signing.outputs.signed }}");
  assert.doesNotMatch(stepRun(STEP), /keytool|KEYSTORE_|release\.keystore/, "the fingerprint must come from the APK, not a keystore");
  assert.equal(stepLines(STEP).some((l) => /^\s+if:/.test(l)), false, "no condition: it must run on both paths");
});

test("release-signed: prints the colon-separated uppercase SHA-256 with the package name", () => {
  const fx = fixture();
  const r = run(fx, true);
  fx.done();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.summary, /Package `com\.paladira\.motoboy`/);
  assert.ok(r.summary.includes(`- \`${COLON}\``), r.summary);
  assert.match(COLON, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.doesNotMatch(r.summary, /debug-signed/);
});

test("every signer is printed", () => {
  const fx = fixture({ signers: 2 });
  const r = run(fx, true);
  fx.done();
  assert.equal(r.summary.split(COLON).length - 1, 2);
});

test("debug-signed: says so and prints no fingerprint to register", () => {
  const fx = fixture();
  const r = run(fx, false);
  fx.done();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.summary, /debug-signed/);
  assert.match(r.summary, /cannot be registered/);
  assert.ok(!r.summary.includes(COLON));
});

test("fails loudly when the APK is missing", () => {
  const fx = fixture({ apk: false });
  const r = run(fx, true);
  fx.done();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No APK at app-release\.apk/);
  assert.equal(r.summary, "");
});

test("fails loudly when aapt2 is missing or prints no package name", () => {
  let fx = fixture({ aapt2: null });
  let r = run(fx, true);
  fx.done();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /aapt2 not found/);
  assert.equal(r.summary, "");

  fx = fixture({ aapt2: "" });
  r = run(fx, true);
  fx.done();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /aapt2 printed no package name/);
  assert.equal(r.summary, "");
});

test("fails loudly when apksigner is missing or prints no digest", () => {
  let fx = fixture({ apksigner: false });
  let r = run(fx, true);
  fx.done();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /apksigner not found/);
  assert.equal(r.summary, "");

  fx = fixture({ digest: "" });
  r = run(fx, true);
  fx.done();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /printed no certificate SHA-256 digest/);
  assert.equal(r.summary, "");
});
