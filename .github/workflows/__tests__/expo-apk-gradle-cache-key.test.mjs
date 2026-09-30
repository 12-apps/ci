import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// The Gradle cache entry is ~1GB and is re-saved whenever its key moves. Keyed
// on the monorepo's pnpm-lock.yaml it moved with nearly every push and filled
// the repo's 10GB cache budget; keyed on the app's own package.json it moves
// when the app's dependencies do. Hashing the generated Gradle files as they
// are moved it on every run anyway: prebuild writes the run number into
// android/app/build.gradle as the versionCode.

const workflow = readFileSync(new URL("../expo-apk.yml", import.meta.url), "utf8");
const step = workflow.slice(workflow.indexOf("id: gradle-cache"), workflow.indexOf("restore-keys:", workflow.indexOf("id: gradle-cache")));
const key = step.slice(step.indexOf("key:"));

// The `run:` block of the step that computes the key, de-indented.
const keyStep = workflow.slice(workflow.indexOf("id: gradle-key"), workflow.indexOf("id: gradle-cache"));
const runBlock = keyStep.slice(keyStep.indexOf("run: |") + "run: |".length);
const script = runBlock
  .slice(0, runBlock.search(/^\s*- name:/m))
  .replace(/^ {10}/gm, "");

const APP = {
  "package.json": '{"name":"motoboy","dependencies":{"expo":"54.0.0"}}\n',
  "android/gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip\n",
  "android/build.gradle": "buildscript { }\n",
  "android/settings.gradle": "rootProject.name = 'motoboy'\n",
  "android/app/build.gradle": "android {\n    defaultConfig {\n        versionCode 101\n        versionName \"0.1.0\"\n    }\n}\ndependencies {\n    implementation(\"com.facebook.react:react-android\")\n}\n",
};

function hashOf(files) {
  const dir = mkdtempSync(join(tmpdir(), "gradle-key-"));
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    const out = join(dir, "github-output");
    writeFileSync(out, "");
    execFileSync("bash", ["-e", "-c", script], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out } });
    const line = readFileSync(out, "utf8").trim();
    assert.match(line, /^hash=[0-9a-f]{64}$/);
    return line.slice("hash=".length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const withApp = (path, edit) => ({ ...APP, [path]: edit(APP[path]) });

test("the Gradle cache key is the app, the OS and the computed hash", () => {
  assert.equal(key.split("\n")[0].trim(), "key: ${{ inputs.app }}-gradle-${{ runner.os }}-${{ steps.gradle-key.outputs.hash }}");
});

test("the key does not move with the run number prebuild writes as the versionCode", () => {
  assert.equal(hashOf(withApp("android/app/build.gradle", (s) => s.replace("versionCode 101", "versionCode 102"))), hashOf(APP));
});

test("the key moves with the app's package.json, its Gradle wrapper and any other Gradle line", () => {
  const base = hashOf(APP);
  assert.notEqual(hashOf(withApp("package.json", (s) => s.replace("54.0.0", "54.0.1"))), base);
  assert.notEqual(hashOf(withApp("android/gradle/wrapper/gradle-wrapper.properties", (s) => s.replace("8.14.3", "8.14.4"))), base);
  assert.notEqual(hashOf(withApp("android/app/build.gradle", (s) => s.replace("react-android", "hermes-android"))), base);
  assert.notEqual(hashOf(withApp("android/app/build.gradle", (s) => s.replace('"0.1.0"', '"0.2.0"'))), base);
  assert.notEqual(hashOf({ ...APP, "android/app/extra.gradle": "apply plugin: 'x'\n" }), base);
});

test("the Gradle cache key does not hash the monorepo lockfile", () => {
  assert.doesNotMatch(key, /pnpm-lock\.yaml/);
  assert.doesNotMatch(keyStep, /pnpm-lock\.yaml/);
});

test("the Gradle cache is still saved only from a push, and only on a miss", () => {
  assert.match(workflow, /if: \$\{\{ github\.event_name == 'push' && steps\.gradle-cache\.outputs\.cache-hit != 'true' \}\}/);
});
