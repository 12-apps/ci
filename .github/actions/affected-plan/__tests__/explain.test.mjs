/**
 * The attribution, and the two questions it has to answer.
 *
 * A narrowed lane is a claim — "these 125 files are the ones that can observe
 * this diff" — and until this module the claim came with no argument attached.
 * The walk that produced it was recorded in the plan document all along and
 * printed nowhere, so the only selections a reviewer could check were the ones
 * small enough to eyeball.
 *
 * Two failure shapes are worth pinning, and neither is loud:
 *
 *   - a chain rendered WRONG points at an innocent file, and the reader goes
 *     and splits a module that was never the cause;
 *   - a list SILENTLY truncated reads as a small selection, which is the exact
 *     misreading the attribution exists to prevent.
 *
 * Usage: node --test .github/actions/affected-plan/__tests__/explain.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { explainByChange, explainByTest, explainSummary, originOf } from "../lib/explain.mjs";

const hop = (importer, imports, line) => ({ importer, imports, line, statement: `import … from '${imports}'` });

const REASONS = {
  "apps/web/app/api/x/__tests__/route.test.ts": [
    hop("apps/web/app/api/x/__tests__/route.test.ts", "apps/web/lib/y.ts", 12),
    hop("apps/web/lib/y.ts", "packages/prisma/src/index.ts", 4),
  ],
  "apps/web/app/api/z/__tests__/route.test.ts": [
    hop("apps/web/app/api/z/__tests__/route.test.ts", "packages/prisma/src/index.ts", 3),
  ],
  "apps/client/src/__tests__/cart.test.tsx": [
    { importer: "apps/client/src/__tests__/cart.test.tsx", imports: "apps/client/src/__tests__/cart.test.tsx", line: 0, statement: "changed file — runs as itself" },
  ],
};

test("a multi-hop chain names every file between the change and the test", () => {
  const line = explainByTest(REASONS).find((l) => l.includes("api/x"));
  assert.equal(
    line,
    "[explain] apps/web/app/api/x/__tests__/route.test.ts ← apps/web/lib/y.ts:12 ← packages/prisma/src/index.ts:4",
  );
});

test("a test that IS the changed file says so rather than pointing at itself", () => {
  const line = explainByTest(REASONS).find((l) => l.includes("cart.test"));
  assert.match(line, /→ changed file — runs as itself$/);
  assert.doesNotMatch(line, /←/, "an arrow to itself reads as a dependency that does not exist");
});

test("the output is one line per selected test, sorted, and complete", () => {
  const lines = explainByTest(REASONS);
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => l.split(" ")[1]),
    [...Object.keys(REASONS)].sort(),
    "unsorted output makes two runs of one diff look like different decisions",
  );
});

test("truncation SAYS it truncated", () => {
  // The silent version of this is the whole bug: a reader takes the short list
  // for the selection and concludes the lane is narrow when it is not.
  const lines = explainByTest(REASONS, { limit: 1 });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /and 2 more/);
  assert.match(lines[1], /plan artifact/, "say where the complete list is");
});

test("the cost view attributes each test to the CHANGED file, most expensive first", () => {
  assert.deepEqual(explainByChange(REASONS), [
    "[cost] packages/prisma/src/index.ts → 2 test file(s)",
    "[cost] apps/client/src/__tests__/cart.test.tsx → 1 test file(s)",
  ]);
});

test("ties break on the path, so the ordering is stable run to run", () => {
  const reasons = {
    "b.test.ts": [hop("b.test.ts", "z.ts", 1)],
    "a.test.ts": [hop("a.test.ts", "a.ts", 1)],
  };
  assert.deepEqual(explainByChange(reasons), ["[cost] a.ts → 1 test file(s)", "[cost] z.ts → 1 test file(s)"]);
});

test("an empty or missing plan explains nothing rather than throwing", () => {
  // The plan job runs this on every event, including the ones that select
  // nothing. A throw here would redden a lane for having had no work to do.
  for (const empty of [{}, null, undefined]) {
    assert.deepEqual(explainByTest(empty), []);
    assert.deepEqual(explainByChange(empty), []);
    assert.deepEqual(explainSummary(empty), []);
  }
  assert.equal(originOf([]), null);
  assert.equal(originOf(null), null);
});

test("the summary is one collapsed block carrying both views and the true total", () => {
  const block = explainSummary(REASONS).join("\n");
  assert.match(block, /^<details><summary>Why each test was selected<\/summary>/);
  assert.match(block, /\[cost\] packages\/prisma\/src\/index\.ts → 2 test file\(s\)/);
  assert.match(block, /\(3 total\)/, "the total must be the real one, not the rendered count");
  assert.match(block, /<\/details>$/);
});
