import { strict as assert } from "node:assert";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { KINDS, analyzePair, isCandidate, kindOf, pathSetOf } from "../lib/overlap.mjs";
import { overlapDigest } from "../lib/overlap-state.mjs";
import { lines, makeRepo } from "./fixture.mjs";

// The pair rule over real repositories: every kind produced by git itself, the
// fixed direction, E0's subtraction, the both-conflicted fallback, renames and
// the stack test. Each PR is a branch off `main`; its paths are what GitHub's
// files API would return for it — `git diff --name-status -M` against the
// merge base, rename sources included.

const repos = [];
after(() => repos.forEach((r) => r.cleanup()));

const BASE = {
  "a.txt": lines("one", "two", "three", "four", "five", "six", "seven", "eight"),
  "list.txt": lines("alpha", "omega"),
  "d.txt": lines("d1", "d2"),
  "old.txt": lines("o1", "o2", "o3", "o4", "o5", "o6"),
  "s.txt": lines("s"),
  "bin.dat": Buffer.from([0, 1, 2, 3, 0, 5]),
};

function world() {
  const r = makeRepo();
  repos.push(r);
  r.commit("base", BASE);
  return r;
}

/** A PR: a branch off `from` (default main) with one commit. */
function pr(r, number, files, { from = "main", after: prep } = {}) {
  r.checkout(from);
  r.checkout(`pr${number}`, true);
  prep?.();
  const head = r.commit(`pr ${number}`, files);
  r.checkout("main");
  return { number, head };
}

const STATUS = { A: "added", M: "modified", D: "removed", R: "renamed", T: "changed" };

/** What `GET /pulls/{n}/files` returns for `head`: the diff from its merge base with main. */
function filesOf(r, head) {
  const mb = r.git("merge-base", "main", head);
  return r
    .git("diff", "--name-status", "-M", mb, head)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [st, a, b] = l.split("\t");
      return b ? { filename: b, previous_filename: a, status: "renamed" } : { filename: a, status: STATUS[st[0]] };
    });
}

const side = (r, p, ignored) => ({ ...p, paths: pathSetOf(filesOf(r, p.head), ignored) });
const analyze = (r, p, q, opts = {}) => analyzePair({ baseSha: r.git("rev-parse", "main"), a: side(r, p, opts.ignored), b: side(r, q, opts.ignored), cwd: r.dir });

test("two PRs editing the same lines: `same lines`, on the shared path", () => {
  const r = world();
  const x = pr(r, 1, { "a.txt": lines("one", "X", "three", "four", "five", "six", "seven", "eight") });
  const y = pr(r, 2, { "a.txt": lines("one", "Y", "three", "four", "five", "six", "seven", "eight") });
  const res = analyze(r, x, y);
  assert.deepEqual(res.overlaps, [{ path: "a.txt", kind: KINDS.lines }]);
  assert.deepEqual(res.shared, ["a.txt"]);
});

test("each kind, read from git: same spot, both add, deletes or moves", () => {
  const r = world();
  const x = pr(r, 1, { "list.txt": lines("alpha", "beta", "omega"), "new.txt": lines("x"), "d.txt": null });
  const y = pr(r, 2, { "list.txt": lines("alpha", "gamma", "omega"), "new.txt": lines("y"), "d.txt": lines("d1", "D2") });
  const res = analyze(r, x, y);
  assert.deepEqual(res.overlaps, [
    { path: "d.txt", kind: KINDS.moved },
    { path: "list.txt", kind: KINDS.spot },
    { path: "new.txt", kind: KINDS.add },
  ]);
});

test("any other kind is git's own, verbatim: `distinct types`, and `unknown` for a binary file", () => {
  const r = world();
  const x = pr(r, 1, { "s.txt": lines("s2"), "bin.dat": Buffer.from([0, 9, 9, 3, 0, 5]) });
  const y = pr(r, 2, { "bin.dat": Buffer.from([0, 7, 7, 3, 0, 5]) }, {
    after: () => {
      rmSync(join(r.dir, "s.txt"));
      symlinkSync("elsewhere", join(r.dir, "s.txt"));
    },
  });
  const res = analyze(r, x, y);
  assert.deepEqual(res.overlaps, [
    { path: "bin.dat", kind: "unknown" },
    { path: "s.txt", kind: "distinct types" },
  ]);
  assert.equal(kindOf("file/directory"), "file/directory");
  assert.equal(kindOf("rename/rename"), KINDS.moved);
  assert.equal(kindOf("file location"), KINDS.moved);
});

test("a rename a→b against an edit of a is an overlap, although git reports it on b", () => {
  const r = world();
  const x = pr(r, 1, { "old.txt": null, "new-name.txt": lines("o1", "X", "o3", "o4", "o5", "o6") });
  const y = pr(r, 2, { "old.txt": lines("o1", "Y", "o3", "o4", "o5", "o6") });
  const sx = side(r, x);
  assert.equal(sx.paths.renamedFrom.get("new-name.txt"), "old.txt");
  const res = analyze(r, x, y);
  assert.deepEqual(res.overlaps, [{ path: "new-name.txt", kind: KINDS.lines }]);
  assert.deepEqual(res.shared, ["old.txt"]);
});

test("swapping which PR is which changes nothing", () => {
  const r = world();
  const x = pr(r, 1, { "a.txt": lines("one", "X", "three", "four", "five", "six", "seven", "eight"), "new.txt": lines("x") });
  const y = pr(r, 2, { "a.txt": lines("one", "Y", "three", "four", "five", "six", "seven", "eight"), "new.txt": lines("y") });
  assert.deepEqual(analyze(r, x, y), analyze(r, y, x));
  assert.equal(analyze(r, y, x).synthesised, 1, "both clean with main: the lower number is synthesised");
  // Each PR's comment digest, from either order: unchanged.
  const digests = (res, partner) => overlapDigest(res.overlaps.map((o) => ({ partner, path: o.path, kind: o.kind })));
  assert.equal(digests(analyze(r, x, y), 2), digests(analyze(r, y, x), 2));
  assert.equal(digests(analyze(r, x, y), 1), digests(analyze(r, y, x), 1));
});

test("a shared path that merges cleanly is R1: no overlap, but listed as shared", () => {
  const r = world();
  const x = pr(r, 1, { "a.txt": lines("one", "X", "three", "four", "five", "six", "seven", "eight") });
  const y = pr(r, 2, { "a.txt": lines("one", "two", "three", "four", "five", "six", "seven", "Y") });
  const res = analyze(r, x, y);
  assert.deepEqual(res.overlaps, []);
  assert.deepEqual(res.shared, ["a.txt"]);
});

test("no shared path and no rename: not a candidate, no merge run", () => {
  const r = world();
  const x = pr(r, 1, { "a.txt": lines("X") });
  const y = pr(r, 2, { "list.txt": lines("Y") });
  assert.equal(isCandidate(side(r, x).paths, side(r, y).paths), false);
  assert.deepEqual(analyze(r, x, y), { overlaps: [], shared: [], synthesised: null });
});

test("an ignored path is dropped before the pair is looked at", () => {
  const r = world();
  const x = pr(r, 1, { "list.txt": lines("alpha", "beta", "omega") });
  const y = pr(r, 2, { "list.txt": lines("alpha", "gamma", "omega") });
  const res = analyze(r, x, y, { ignored: (p) => p === "list.txt" });
  assert.deepEqual(res, { overlaps: [], shared: [], synthesised: null });
});

test("a PR already conflicting with main on the path: E0 owns it, no overlap; the clean side is synthesised", () => {
  const r = world();
  const x = pr(r, 1, { "a.txt": lines("one", "X", "three", "four", "five", "six", "seven", "eight") });
  const y = pr(r, 2, { "a.txt": lines("one", "Y", "three", "four", "five", "six", "seven", "eight"), "list.txt": lines("alpha", "y", "omega") });
  const z = pr(r, 3, { "list.txt": lines("alpha", "z", "omega") });
  // main moves: it now conflicts with #1 on a.txt, and with nothing else.
  r.commit("land (#9)", { "a.txt": lines("one", "MAIN", "three", "four", "five", "six", "seven", "eight") });
  const res = analyze(r, x, y);
  assert.equal(res.synthesised, null, "both conflict with main on a.txt: the fallback");
  assert.deepEqual(res.overlaps, [], "a.txt is both sides' own conflict with main");
  // #2 conflicts with main on a.txt; #3 is clean — so #3 is synthesised even
  // though its number is higher, and #2's a.txt conflict is taken out.
  const res23 = analyze(r, y, z);
  assert.equal(res23.synthesised, 3);
  assert.deepEqual(res23.overlaps, [{ path: "list.txt", kind: KINDS.spot }]);
});

test("when neither side merges cleanly with main, the heads are merged directly and both sides' main conflicts removed", () => {
  const r = world();
  const x = pr(r, 1, { "a.txt": lines("one", "X", "three", "four", "five", "six", "seven", "eight"), "list.txt": lines("alpha", "x", "omega") });
  const y = pr(r, 2, { "d.txt": lines("d1", "Y"), "list.txt": lines("alpha", "y", "omega") });
  r.commit("land (#9)", { "a.txt": lines("one", "MAIN", "three", "four", "five", "six", "seven", "eight"), "d.txt": lines("d1", "MAIN") });
  const res = analyze(r, x, y);
  assert.equal(res.synthesised, null);
  assert.deepEqual(res.overlaps, [{ path: "list.txt", kind: KINDS.spot }]);
});

test("a stacked pair — one head holds the other's own commits — is not a pair", () => {
  const r = world();
  const parent = pr(r, 1, { "a.txt": lines("one", "P", "three", "four", "five", "six", "seven", "eight") });
  const child = pr(r, 2, { "a.txt": lines("one", "C", "three", "four", "five", "six", "seven", "eight") }, { from: "pr1" });
  assert.deepEqual(analyze(r, parent, child), { stacked: true });
  assert.deepEqual(analyze(r, child, parent), { stacked: true });
});

test("stacked holds when the parent merged main in after the child was cut", () => {
  const r = world();
  const parent = pr(r, 1, { "a.txt": lines("one", "P", "three", "four", "five", "six", "seven", "eight") });
  const child = pr(r, 2, { "a.txt": lines("one", "C", "three", "four", "five", "six", "seven", "eight") }, { from: "pr1" });
  r.commit("land (#9)", { "z.txt": lines("z") });
  r.checkout("pr1");
  const merged = r.mergeResolving("main");
  r.checkout("main");
  assert.deepEqual(analyze(r, { number: 1, head: merged }, child), { stacked: true });
  assert.ok(parent);
});
