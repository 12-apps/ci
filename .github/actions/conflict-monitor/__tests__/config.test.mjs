import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError, bucketOf, globToRegExp, loadConfig, parseConfig, ticketsIn } from "../lib/config.mjs";

test("globs: ** crosses directories and may match none, * stays in one segment", () => {
  const any = globToRegExp("**/package.json");
  assert.ok(any.test("package.json"));
  assert.ok(any.test("apps/web/package.json"));
  const root = globToRegExp(".*.json");
  assert.ok(root.test(".payments-surface.json"));
  assert.ok(!root.test("apps/.x.json"), "a leading-dot pattern is a ROOT file");
  assert.ok(!root.test("xpayments.json"), "the dot is literal");
  assert.ok(globToRegExp("**/mcp/**").test("apps/web/mcp/manifest.json"));
  assert.ok(globToRegExp("a/[id]/b.ts").test("a/[id]/b.ts"), "brackets are literal, as in route paths");
});

test("the first matching rule wins, and an unclaimed file is `code`", () => {
  const config = parseConfig(
    JSON.stringify({
      buckets: [
        { name: "route table", paths: ["apps/web/server/routes.generated.ts"] },
        { name: "everything under apps", paths: ["apps/**"] },
      ],
    }),
  );
  assert.equal(bucketOf("apps/web/server/routes.generated.ts", config), "route table");
  assert.equal(bucketOf("apps/web/x.ts", config), "everything under apps");
  assert.equal(bucketOf("docs/x.md", config), "code");
});

test("an `absent` rule claims a path only once it has left the base", () => {
  const config = parseConfig(JSON.stringify({ buckets: [{ name: "removed", absent: true, paths: ["**/mcp/**"] }] }));
  assert.equal(bucketOf("apps/web/mcp/manifest.json", config, () => false), "removed");
  assert.equal(bucketOf("apps/web/mcp/mcp-exclusions.json", config, () => true), "code");
});

test("a malformed config names the file and the reason", () => {
  assert.throws(() => parseConfig("{", "cfg.json"), (e) => e instanceof ConfigError && /cfg\.json: not valid JSON/.test(e.message));
  assert.throws(() => parseConfig('{"buckets":{}}', "cfg.json"), /cfg\.json: "buckets" must be an array/);
  assert.throws(() => parseConfig('{"buckets":[{"name":"x","paths":[]}]}', "cfg.json"), /buckets\[0\] \("x"\) needs a non-empty "paths"/);
  assert.throws(() => parseConfig('{"buckets":[{"name":"code","paths":["a"]}]}', "cfg.json"), /"code" is the default bucket/);
  assert.throws(() => parseConfig('{"ticketPattern":"("}', "cfg.json"), /"ticketPattern" is not a valid regex/);
});

test("a missing config file is no buckets; a present one is parsed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-config-"));
  try {
    assert.deepEqual(loadConfig(join(dir, "nope.json")).rules, []);
    writeFileSync(join(dir, "c.json"), JSON.stringify({ buckets: [{ name: "b", paths: ["x"] }], ticketPattern: "FUT-\\d+" }));
    const c = loadConfig(join(dir, "c.json"));
    assert.equal(c.rules[0].name, "b");
    assert.deepEqual([...ticketsIn("feat: x (FUT-12) and FUT-7", c)], ["FUT-12", "FUT-7"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
