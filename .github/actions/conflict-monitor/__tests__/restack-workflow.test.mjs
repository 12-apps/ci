import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ConfigError, parseConfig, parseRestackConfig } from "../lib/config.mjs";

// conflict-restack.yml's shape, read as text like the rest of the workflow
// tests: the concurrency keying the design depends on, the runner a PAT job
// must stay on, and where the token may go.

const source = readFileSync(new URL("../../../workflows/conflict-restack.yml", import.meta.url), "utf8");
const job = source.slice(source.indexOf("\njobs:"));

/** The job's concurrency group, with `inputs.pr` and the repository substituted. */
function groupFor(pr) {
  const m = /^ {6}group:\s*(.+)$/m.exec(job);
  assert.ok(m, "the job declares a concurrency group");
  return m[1]
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, "o/r")
    .replace(/\$\{\{\s*inputs\.pr \|\| 'all'\s*\}\}/g, pr || "all");
}

test("concurrency: keyed by the PR, so single-PR runs for #A and #B both run; a full run is 'all'", () => {
  assert.match(job, /group: conflict-restack-\$\{\{ github\.repository \}\}-\$\{\{ inputs\.pr \|\| 'all' \}\}/);
  assert.notEqual(groupFor("101"), groupFor("102"));
  assert.equal(groupFor(""), "conflict-restack-o/r-all");
  assert.match(job, /cancel-in-progress: false/);
  assert.doesNotMatch(source, /renovate-heal/, "no group shared with the heal");
});

test("the job holding PUSH_TOKEN runs on GitHub's ephemeral image, with no runner input", () => {
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(source, /^ {6}runner:/m, "no `runner` input");
  assert.doesNotMatch(source, /vars\.CI_RUNNER/, "no fallback a caller could move it with");
});

test("the token is only handed to the action, the checkout keeps no credential, and the grant is read-only", () => {
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /fetch-depth: 0/);
  assert.equal((source.match(/secrets\.PUSH_TOKEN/g) ?? []).length, 1);
  assert.match(job, /push-token: \$\{\{ secrets\.PUSH_TOKEN \}\}/);
  assert.doesNotMatch(source, /^\s+run:/m, "no run: step at all");
  assert.doesNotMatch(source, /write\b(?!.*#)/m, "no write scope");
  assert.match(source, /^ {6}PUSH_TOKEN:\n(?: {8}.*\n)+ {8}required: false$/m, "the secret is optional");
});

test("the output the probe consumes is wired through", () => {
  assert.match(source, /value: \$\{\{ jobs\.restack\.outputs\.pushed \}\}/);
  assert.match(job, /pushed: \$\{\{ steps\.restack\.outputs\.pushed \}\}/);
  const probe = readFileSync(new URL("../../../workflows/conflict-probe.yml", import.meta.url), "utf8");
  assert.match(probe, /restacked: \$\{\{ inputs\.restacked \}\}/);
});

test("parseRestackConfig: no key is null; a bad key fails naming it; parseConfig ignores the block", () => {
  assert.equal(parseRestackConfig(undefined), null);
  assert.equal(parseRestackConfig(null), null);
  assert.deepEqual(parseRestackConfig({}), { push: true, ignoreHeads: [], command: null });
  assert.deepEqual(parseRestackConfig({ push: false, ignoreHeads: ["renovate/"], command: " pnpm restack " }), {
    push: false,
    ignoreHeads: ["renovate/"],
    command: "pnpm restack",
  });
  for (const [raw, re] of [
    [[], /must be an object/],
    [{ push: "no" }, /push must be true or false/],
    [{ ignoreHeads: "renovate/" }, /ignoreHeads must be an array/],
    [{ ignoreHeads: [""] }, /ignoreHeads must be an array/],
    [{ command: "a`b" }, /command must be a one-line string/],
    [{ command: "a\nb" }, /command must be a one-line string/],
    [{ heal: true }, /unknown key\(s\): heal/],
  ]) {
    assert.throws(() => parseRestackConfig(raw, "c.json"), (err) => err instanceof ConfigError && re.test(err.message));
  }
  assert.deepEqual(parseConfig(JSON.stringify({ restack: { bogus: 1 } })).rules, []);
});
