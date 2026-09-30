import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { ConfigError, loadConfig, loadOverlapConfig, parseConfig, parseOverlapConfig } from "../lib/config.mjs";
import { runProbe } from "../probe.mjs";

// The `overlap` block is read by the overlap mode ONLY. Without it the mode
// does nothing at all; with a bad one the overlap mode fails naming the reason
// — and E0's probe and report, reading the same file, never notice.

const dir = mkdtempSync(join(tmpdir(), "cm-overlap-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const OVERLAP = fileURLToPath(new URL("../overlap.mjs", import.meta.url));

const BUCKETS = [
  { name: "removed from git", absent: true, paths: ["gone.json"] },
  { name: "route table", paths: ["routes.generated.ts"] },
  { name: "dependencies", paths: ["pnpm-lock.yaml", "**/package.json"] },
];
const file = (name, raw) => {
  const path = join(dir, name);
  writeFileSync(path, typeof raw === "string" ? raw : JSON.stringify(raw));
  return path;
};

/** The overlap entry point, as the action runs it; any API call would hit a closed port and fail. */
function runMain(configPath) {
  return spawnSync(process.execPath, [OVERLAP], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CONFIG_PATH: configPath, GITHUB_REPOSITORY: "o/r", BASE_BRANCH: "main", GITHUB_API_URL: "http://127.0.0.1:9" },
  });
}

test("the block parses: globs, declared buckets, head prefixes, and comment on by default", () => {
  const rules = parseConfig(JSON.stringify({ buckets: BUCKETS })).rules;
  const o = parseOverlapConfig({ ignoreBuckets: ["route table"], ignorePaths: ["**/*.generated.ts"], ignoreHeads: ["renovate/"] }, rules);
  assert.equal(o.comment, true);
  assert.deepEqual([...o.ignoreBuckets], ["route table"]);
  assert.ok(o.ignorePaths[0].test("apps/web/x.generated.ts"));
  assert.deepEqual(o.ignoreHeads, ["renovate/"]);
  assert.equal(parseOverlapConfig({ comment: false }, rules).comment, false);
  assert.equal(parseOverlapConfig(undefined, rules), null);
  assert.equal(parseOverlapConfig(null, rules), null);
});

test("a bad block names the reason", () => {
  const rules = parseConfig(JSON.stringify({ buckets: BUCKETS })).rules;
  const bad = [
    [[], /"overlap" must be an object/],
    [{ ignoreBuckets: ["nope"] }, /ignoreBuckets names bucket\(s\) not declared in "buckets": "nope"/],
    [{ ignorePaths: "a" }, /ignorePaths must be an array of non-empty strings/],
    [{ ignoreHeads: [""] }, /ignoreHeads must be an array/],
    [{ comment: "yes" }, /comment must be true or false/],
    [{ ignorBuckets: [] }, /unknown key\(s\): ignorBuckets/],
  ];
  for (const [raw, reason] of bad) {
    assert.throws(() => parseOverlapConfig(raw, rules, "cfg.json"), (e) => e instanceof ConfigError && reason.test(e.message), JSON.stringify(raw));
  }
});

test("no `overlap` key, or no file: the mode exits 0 having read and written nothing", () => {
  for (const path of [file("no-key.json", { buckets: BUCKETS }), join(dir, "missing.json")]) {
    assert.equal(loadOverlapConfig(path).overlap, null);
    const res = runMain(path);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /no "overlap" key in .*: nothing to do/);
    assert.doesNotMatch(res.stdout, /overlap-pairs/);
  }
});

test("a bad block fails the overlap mode — and E0's config reader and probe on the same file still pass", async () => {
  const path = file("bad.json", { buckets: BUCKETS, overlap: { ignoreBuckets: ["ADR index"] } });
  const res = runMain(path);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error::.*bad\.json: "overlap"\.ignoreBuckets names bucket\(s\) not declared in "buckets": "ADR index"/);
  const config = loadConfig(path);
  assert.equal(config.rules.length, 3);
  const api = { paginate: async () => [], request: async () => assert.fail("no write") };
  const { tally } = await runProbe({ api, repo: "o/r", base: "main", baseSha: "0".repeat(40), config, cwd: dir, fetch: () => [] });
  assert.equal(tally.probed, 0);
});
