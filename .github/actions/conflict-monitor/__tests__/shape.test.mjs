import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { analyzeMerge, prOfSubject } from "../lib/analyze.mjs";
import { parseConfig } from "../lib/config.mjs";
import { conflictKinds, diff3Hunks, hunkShape } from "../lib/shape.mjs";
import { lines, makeRepo } from "./fixture.mjs";

// The shape is what the whole report is sorted by — "avoidable" or "two
// people really changed the same lines" — so each one is produced here by
// git itself, from two real branches, and read back through the same
// merge-tree call the monitor makes.

const NO_BUCKETS = parseConfig("{}");
const repos = [];
after(() => repos.forEach((r) => r.cleanup()));

/** A base commit, a branch `feat` with `branch` files, and `main` moved with `main` files. */
function diverge(base, branch, main) {
  const r = makeRepo();
  repos.push(r);
  r.commit("base", base);
  r.checkout("feat", true);
  r.commit("feature (#2)", branch);
  r.checkout("main");
  r.commit("land something (#1)", main);
  const records = analyzeMerge({
    mainSide: r.git("rev-parse", "main"),
    branchSide: r.git("rev-parse", "feat"),
    config: NO_BUCKETS,
    baseTip: r.git("rev-parse", "main"),
    cwd: r.dir,
  });
  return { r, records };
}

test("a clean merge is null, not an empty list", () => {
  const { records } = diverge({ "a.txt": lines("1", "2", "3") }, { "b.txt": "x\n" }, { "c.txt": "y\n" });
  assert.equal(records, null);
});

test("both sides rewrite the same line: edit/edit", () => {
  const { records } = diverge(
    { "a.txt": lines("one", "two", "three") },
    { "a.txt": lines("one", "TWO-branch", "three") },
    { "a.txt": lines("one", "TWO-main", "three") },
  );
  assert.deepEqual(records.map((r) => [r.file, r.shape, r.bucket]), [["a.txt", "edit/edit", "code"]]);
});

test("both sides append at the end, keeping the base: insert/insert", () => {
  const { records } = diverge(
    { "list.txt": lines("a", "b") },
    { "list.txt": lines("a", "b", "from-branch") },
    { "list.txt": lines("a", "b", "from-main") },
  );
  assert.deepEqual(records.map((r) => r.shape), ["insert/insert"]);
});

test("a positional table renumbered by one insertion is edit/edit — the route0…routeN shape", () => {
  const table = (names) => names.map((n, i) => `import * as route${i} from "./${n}";`);
  const base = ["a", "c", "e"];
  const { records } = diverge(
    { "routes.ts": lines(...table(base)) },
    { "routes.ts": lines(...table(["a", "b", "c", "e"])) },
    { "routes.ts": lines(...table(["a", "c", "d", "e"])) },
  );
  assert.deepEqual(records.map((r) => r.shape), ["edit/edit"]);
});

test("both sides create the same path: add/add", () => {
  const { records } = diverge({ "keep.txt": "k\n" }, { "new.txt": "branch\n" }, { "new.txt": "main\n" });
  assert.deepEqual(records.map((r) => r.shape), ["add/add"]);
});

test("one side deletes what the other edits: the git kind, verbatim", () => {
  const { records } = diverge(
    { "gone.txt": lines("1", "2") },
    { "gone.txt": lines("1", "2", "3") },
    { "gone.txt": null },
  );
  assert.deepEqual(records.map((r) => r.shape), ["modify/delete"]);
});

test("the culprit is the base commit that touched the file, with its PR number", () => {
  const { records } = diverge(
    { "a.txt": lines("x") },
    { "a.txt": lines("branch") },
    { "a.txt": lines("main") },
  );
  assert.equal(records[0].culprits.length, 1);
  assert.equal(records[0].culprits[0].pr, 1);
});

test("hunkShape: an empty base is an insertion; the base kept on both sides is an insertion", () => {
  assert.equal(hunkShape({ ours: ["a"], base: [], theirs: ["b"] }), "insert/insert");
  assert.equal(hunkShape({ ours: ["k", "a"], base: ["k"], theirs: ["k", "b"] }), "insert/insert");
  assert.equal(hunkShape({ ours: ["a"], base: ["k"], theirs: ["b"] }), "edit/edit");
});

test("diff3Hunks needs all four markers in order, so a stray ======= is not a hunk", () => {
  assert.deepEqual(diff3Hunks("=======\nplain text\n"), []);
  const blob = "<<<<<<< ours\na\n||||||| base\nk\n=======\nb\n>>>>>>> theirs\n";
  assert.deepEqual(diff3Hunks(blob), [{ ours: ["a"], base: ["k"], theirs: ["b"] }]);
});

test("conflictKinds reads only the messages about the path asked for", () => {
  const msgs = "CONFLICT (content): Merge conflict in a.txt\nCONFLICT (add/add): Merge conflict in b[x].txt\n";
  assert.deepEqual([...conflictKinds(msgs, "a.txt")], ["content"]);
  assert.deepEqual([...conflictKinds(msgs, "b[x].txt")], ["add/add"]);
});

test("prOfSubject takes the LAST (#N): a squash subject may quote another PR first", () => {
  assert.equal(prOfSubject("fix: revert (#10) properly (#12)"), 12);
  assert.equal(prOfSubject("chore: no number"), null);
});
