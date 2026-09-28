import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// cd.yml's `build_cache` input decides whether an image build reads and writes
// the GitHub Actions layer cache. The write is an UPLOAD, which a self-hosted
// runner on a cloud host pays for as egress: future-pay's fleet sent up to
// 2.2 GB per image per deploy doing it (2026-09-28). The two expressions that
// implement the modes are lifted out of the workflow and evaluated here, so what
// is tested is what ships.

const here = path.dirname(fileURLToPath(import.meta.url));
const yaml = readFileSync(path.join(here, "..", "cd.yml"), "utf8");

function expression(key) {
  const m = new RegExp(`^\\s+${key}: \\$\\{\\{(.*)\\}\\}\\s*$`, "m").exec(yaml);
  assert.ok(m, `cd.yml sets ${key} from an expression`);
  return m[1];
}

/** GitHub's `a && b || c` over strings is JavaScript's; format() is {0} substitution. */
function evaluate(expr, buildCache, cache = "img-web") {
  const js = expr
    .replace(/format\('([^']*)',\s*matrix\.cache\)/g, (_, f) => JSON.stringify(f.replace("{0}", cache)))
    .replace(/inputs\.build_cache/g, JSON.stringify(buildCache))
    .replace(/'([^']*)'/g, (_, s) => JSON.stringify(s));
  return Function(`"use strict"; return (${js});`)();
}

const MODES = {
  gha: { from: "type=gha,scope=img-web", to: "type=gha,mode=max,scope=img-web" },
  read: { from: "type=gha,scope=img-web", to: "" },
  none: { from: "", to: "" },
};

for (const [mode, want] of Object.entries(MODES)) {
  test(`build_cache=${mode}: cache-from ${want.from || "(none)"}, cache-to ${want.to || "(none)"}`, () => {
    assert.equal(evaluate(expression("cache-from"), mode), want.from);
    assert.equal(evaluate(expression("cache-to"), mode), want.to);
  });
}

test("the default is gha: a caller that sets nothing keeps today's cache", () => {
  const block = /\n      build_cache:\n([\s\S]*?)\n      [a-z_]+:\n/.exec(yaml);
  assert.ok(block, "cd.yml declares a build_cache input");
  assert.match(block[1], /^\s+default: gha$/m);
});

test("the build refuses any other value instead of guessing one", () => {
  const step = /name: Check the build cache mode[\s\S]*?case "\$BUILD_CACHE" in\n\s+([^)]*)\)/.exec(yaml);
  assert.ok(step, "cd.yml checks the build_cache value before building");
  assert.deepEqual(step[1].split("|").map((s) => s.trim()).sort(), Object.keys(MODES).sort());
  assert.ok(
    yaml.indexOf("name: Check the build cache mode") < yaml.indexOf("name: Build & push"),
    "the check runs before the build",
  );
});

// ── reproducible images ────────────────────────────────────────────────────
// A matrix entry with `reproducible: true` (deploy/config.json) is exported with
// its timestamps rewritten to SOURCE_DATE_EPOCH=0, so an unchanged layer keeps
// its digest. Every other image pushes exactly as before.

function stepValue(key) {
  const m = new RegExp(`^\\s+${key}: \\$\\{\\{(.*)\\}\\}\\s*$`, "m").exec(yaml);
  assert.ok(m, `cd.yml sets ${key} from an expression`);
  return m[1];
}

function evalMatrix(expr, reproducible) {
  const js = expr
    .replace(/matrix\.reproducible/g, JSON.stringify(reproducible))
    .replace(/'([^']*)'/g, (_, s) => JSON.stringify(s));
  return Function(`"use strict"; return (${js});`)();
}

test("a reproducible image pushes through an image output with rewrite-timestamp", () => {
  assert.equal(evalMatrix(stepValue("push"), true), false);
  assert.equal(evalMatrix(stepValue("outputs"), true), "type=image,push=true,rewrite-timestamp=true");
  assert.match(yaml, /\$\{\{ matrix\.reproducible == true && 'SOURCE_DATE_EPOCH=0' \|\| '' \}\}/);
});

test("any other image pushes as before: push true, no outputs, no SOURCE_DATE_EPOCH", () => {
  for (const r of [false, undefined]) {
    assert.equal(evalMatrix(stepValue("push"), r), true);
    assert.equal(evalMatrix(stepValue("outputs"), r), "");
    assert.equal(evalMatrix("matrix.reproducible == true && 'SOURCE_DATE_EPOCH=0' || ''", r), "");
  }
});
