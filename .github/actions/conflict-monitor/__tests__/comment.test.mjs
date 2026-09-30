import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MARKER, RESOLVED, decide, digest, stateOf } from "../lib/comment.mjs";

// The comment is the only thing a PR author ever sees of this monitor, so the
// rule it keeps — ONE comment, written only when the conflict changed — is
// pinned case by case. A monitor that re-commented on every merge to main
// would be muted within a week.

const ctx = { base: "main", baseSha: "a1b2c3d4e5f6" };
const rec = (file, shape = "edit/edit", bucket = "code", culprits = []) => ({ file, shape, bucket, culprits });

test("first conflict, no comment yet: create", () => {
  const plan = decide([rec("a.ts")], null, ctx);
  assert.equal(plan.action, "create");
  assert.ok(plan.body.startsWith(MARKER));
  assert.equal(stateOf(plan.body), digest([rec("a.ts")]));
  assert.match(plan.body, /\| `a\.ts` \| edit\/edit \| code \|/);
});

test("same conflict on the next run: nothing is written", () => {
  const body = decide([rec("a.ts")], null, ctx).body;
  assert.deepEqual(decide([rec("a.ts")], { id: 1, body }, ctx), { action: "none" });
});

test("a longer culprit list alone is not a change", () => {
  const body = decide([rec("a.ts", "edit/edit", "code", [{ sha: "1", pr: 1 }])], null, ctx).body;
  const plan = decide([rec("a.ts", "edit/edit", "code", [{ sha: "1", pr: 1 }, { sha: "2", pr: 2 }])], { id: 1, body }, ctx);
  assert.equal(plan.action, "none");
});

test("a different conflicted set: update in place", () => {
  const body = decide([rec("a.ts")], null, ctx).body;
  const plan = decide([rec("a.ts"), rec("b.ts", "insert/insert")], { id: 1, body }, ctx);
  assert.equal(plan.action, "update");
  assert.match(plan.body, /2 file\(s\) conflict/);
});

test("clean again after a conflict comment: marked resolved, once", () => {
  const body = decide([rec("a.ts")], null, ctx).body;
  const plan = decide(null, { id: 1, body }, ctx);
  assert.equal(plan.action, "update");
  assert.equal(stateOf(plan.body), RESOLVED);
  assert.deepEqual(decide(null, { id: 1, body: plan.body }, ctx), { action: "none" });
});

test("clean and never conflicted: nothing", () => {
  assert.deepEqual(decide(null, null, ctx), { action: "none" });
  assert.deepEqual(decide([], null, ctx), { action: "none" });
});

test("conflicted again after resolved: the resolved comment is reused", () => {
  const resolved = decide(null, { id: 1, body: decide([rec("a.ts")], null, ctx).body }, ctx).body;
  assert.equal(decide([rec("a.ts")], { id: 1, body: resolved }, ctx).action, "update");
});

test("a pipe in a path cannot break the table", () => {
  const body = decide([rec("we|ird.ts")], null, ctx).body;
  assert.match(body, /`we\\\|ird\.ts`/);
});
