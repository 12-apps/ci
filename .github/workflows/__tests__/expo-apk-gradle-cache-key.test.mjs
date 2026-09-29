import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The Gradle cache entry is ~1GB and is re-saved whenever its key moves. Keyed
// on the monorepo's pnpm-lock.yaml it moved with nearly every push and filled
// the repo's 10GB cache budget; keyed on the app's own package.json it moves
// when the app's dependencies do.

const workflow = readFileSync(new URL("../expo-apk.yml", import.meta.url), "utf8");
const step = workflow.slice(workflow.indexOf("id: gradle-cache"), workflow.indexOf("restore-keys:", workflow.indexOf("id: gradle-cache")));
const key = step.slice(step.indexOf("key: >-"));

test("the Gradle cache key hashes the app's package.json and its Gradle files", () => {
  assert.match(key, /format\('\{0\}\/package\.json', inputs\.app-path\)/);
  assert.match(key, /gradle-wrapper\.properties/);
  assert.match(key, /android\/\*\*\/\*\.gradle/);
});

test("the Gradle cache key does not hash the monorepo lockfile", () => {
  assert.doesNotMatch(key, /pnpm-lock\.yaml/);
});

test("the Gradle cache is still saved only from a push, and only on a miss", () => {
  assert.match(workflow, /if: \$\{\{ github\.event_name == 'push' && steps\.gradle-cache\.outputs\.cache-hit != 'true' \}\}/);
});
