import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { MARKER, decide, renderOverlap } from "../lib/comment.mjs";
import { OVERLAP_BOT, OVERLAP_MARKER, RESOLVED, MERGED, groupsOf, readComment } from "../lib/overlap-state.mjs";
import { overlapLogLine, overlapSummary } from "../overlap.mjs";
import { runProbe } from "../probe.mjs";
import { lines } from "./fixture.mjs";
import { A, cleanupWorlds, config, own, pair, run, stubApi, world } from "./overlap-world.mjs";

// The overlap mode end to end, over the shared world (overlap-world.mjs): a
// real remote with hand-written `refs/pull/N/head` refs, a real clone as the
// checkout, and a stubbed GitHub whose files API is computed from the refs.

after(cleanupWorlds);

/** The comment on #n as the next run reads it, with its groups flattened back to rows. */
function rowsOn(api, n, open = [1, 2, 3, 4, 5]) {
  const c = readComment(own(api, n).at(-1), { self: n, open: new Set(open) });
  const rows = c.groups.flatMap((g) => g.rows.map((r) => ({ partner: g.partner, path: r.path, kind: r.kind, ...(g.merged ? { merged: true } : {}) })));
  return { ...c, rows };
}

test("both PRs of a predicted conflict get one comment each, with the same set; drafts are paired; R1 is summary only", async () => {
  const w = pair();
  const api = stubApi(w);
  const result = await run(w, api);
  assert.deepEqual(api.writes.sort(), [["create", 1], ["create", 2]]);
  assert.deepEqual(rowsOn(api, 1).rows, [{ partner: 2, path: "a.txt", kind: "same lines" }]);
  assert.deepEqual(rowsOn(api, 2).rows, [{ partner: 1, path: "a.txt", kind: "same lines" }]);
  assert.match(own(api, 1)[0].body, /No action needed\. If #2 merges first, the conflict comment will list what to resolve\./);
  assert.equal(api.comments(3).length, 0);
  assert.deepEqual(result.r1.map((p) => [p.a, p.b]), [[1, 3], [2, 3]]);
  const md = overlapSummary(result, { base: "main", baseSha: w.baseSha() });
  assert.match(md, /\| #1 × #2 \| <code>a\.txt<\/code> \| <code>same lines<\/code> \|/);
  assert.match(md, /\| #1 × #3 \| <code>a\.txt<\/code> \|/);
});

test("the log line is one machine-readable JSON record of the run", async () => {
  const w = pair();
  const api = stubApi(w);
  const result = await run(w, api);
  const line = overlapLogLine(result, { baseSha: w.baseSha(), stats: api.stats });
  assert.ok(line.startsWith("overlap-pairs {"));
  assert.ok(!line.includes("\n"));
  const rec = JSON.parse(line.slice("overlap-pairs ".length));
  assert.equal(rec.base, w.baseSha());
  assert.equal(rec.open, 3);
  assert.deepEqual(rec.r2, [[1, 2, ["a.txt"]]]);
  assert.deepEqual(rec.r1, [[1, 3], [2, 3]]);
  assert.deepEqual(rec.skipped, []);
  // 1 list page + 3 files lists + 3 comment lists.
  assert.equal(rec.reads, 7);
  assert.equal(typeof rec.rateUsed, "number");
});

test("a second run over the same state writes nothing", async () => {
  const w = pair();
  const api = stubApi(w);
  await run(w, api);
  api.writes.length = 0;
  const { tally } = await run(w, api);
  assert.deepEqual(api.writes, []);
  assert.equal(tally.unchanged, 3);
});

test("reverting the line resolves both; re-introducing it re-posts both, create then delete", async () => {
  const w = pair();
  const api = stubApi(w);
  await run(w, api);
  const firstIds = [own(api, 1)[0].id, own(api, 2)[0].id];
  w.push(2, { "a.txt": A("two") });
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes.sort(), [["update", 1], ["update", 2]]);
  assert.equal(rowsOn(api, 1).state, RESOLVED);
  assert.equal(rowsOn(api, 2).state, RESOLVED);
  w.push(2, { "a.txt": A("TWO AGAIN") });
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes, [["create", 1], ["delete", 1], ["create", 2], ["delete", 2]]);
  const ids = [own(api, 1), own(api, 2)].map((cs) => (assert.equal(cs.length, 1), cs[0].id));
  assert.ok(ids.every((id) => !firstIds.includes(id)), "new comment ids");
});

test("a partner never seen re-posts; one already seen returning is an edit", async () => {
  const w = pair();
  const api = stubApi(w);
  await run(w, api);
  w.push(4, { "a.txt": A("FOUR") });
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes.filter((x) => x[1] === 1), [["create", 1], ["delete", 1]]);
  assert.deepEqual(api.writes.filter((x) => x[1] === 4), [["create", 4]]);
  assert.deepEqual(rowsOn(api, 1).seen, [2, 4]);
  // #4 steps away, then comes back: both are edits on #1, never a re-post.
  w.push(4, { "a.txt": A("two") });
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes.filter((x) => x[1] === 1), [["update", 1]]);
  w.push(4, { "a.txt": A("FOUR AGAIN") });
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes.filter((x) => x[1] === 1), [["update", 1]]);
});

test("a partner that merged becomes a merged row, kept in the digest; one closed without merge is dropped", async () => {
  const w = pair();
  w.push(4, { "a.txt": A("FOUR") });
  const api = stubApi(w, { closed: { 2: { merged_at: "2026-09-30T12:00:00Z" }, 4: { merged_at: null } } });
  await run(w, api);
  w.pulls.find((p) => p.number === 2).state = "closed";
  w.pulls.find((p) => p.number === 4).state = "closed";
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes, [["update", 1]], "the closed PRs' own comments stay as they were");
  const prev = rowsOn(api, 1, [1, 3]);
  assert.equal(prev.state, MERGED);
  assert.deepEqual(prev.rows, [{ partner: 2, path: "a.txt", kind: "same lines", merged: true }]);
  assert.match(own(api, 1)[0].body, /#2 merged\. If this PR now conflicts, the conflict comment lists the files\./);
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes, [], "and the merged state is stable");
});

test("the last open partner closing without merge resolves the comment; the closed PR's own comment keeps its state", async () => {
  const w = pair();
  const api = stubApi(w, { closed: { 1: { merged_at: null } } });
  await run(w, api);
  const onOne = own(api, 1)[0].body;
  w.pulls.find((p) => p.number === 1).state = "closed";
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes, [["update", 2]]);
  assert.equal(rowsOn(api, 2).state, RESOLVED);
  assert.equal(own(api, 1)[0].body, onOne);
});

test("a partner whose head or files cannot be read keeps its rows, with no write, run after run", async () => {
  const w = pair();
  const api = stubApi(w);
  await run(w, api);
  const before = own(api, 1)[0].body;
  w.remote.git("update-ref", "-d", "refs/pull/2/head");
  api.writes.length = 0;
  for (let i = 0; i < 2; i += 1) {
    const { tally } = await run(w, api);
    assert.deepEqual(tally.skipped, [2]);
    assert.deepEqual(api.writes, []);
    assert.equal(own(api, 1)[0].body, before);
  }
  // Its files list failing instead: the same.
  w.push(2, { "list.txt": lines("alpha", "x", "omega") });
  api.fail.files.add(2);
  await run(w, api);
  assert.deepEqual(api.writes, []);
});

test("a failed write fails the run; a failed delete of a re-post is cleaned up by the next run", async () => {
  const w = pair();
  const api = stubApi(w);
  api.fail.write = () => true;
  const { tally } = await run(w, api);
  assert.deepEqual(tally.failedWrites, [1, 2]);
  api.fail.write = null;
  await run(w, api);
  w.push(4, { "a.txt": A("FOUR") });
  api.fail.write = (method) => method === "DELETE";
  const failed = await run(w, api);
  // #4 is new to both #1 and #2: both re-post, and both deletes fail.
  assert.deepEqual(failed.tally.failedWrites, [1, 2]);
  assert.equal(own(api, 1).length, 2, "the new comment is there, the old one was not deleted");
  api.fail.write = null;
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes, [["delete", 1], ["delete", 2]], "the older one goes; the newest is kept and already current");
  assert.equal(own(api, 1).length, 1);
  assert.deepEqual(rowsOn(api, 1).rows.map((r) => r.partner), [2, 4]);
});

test("E0's comment, a person's marked comment and another bot's are never touched, and never read", async () => {
  const w = pair();
  const api = stubApi(w);
  const e0 = decide([{ file: "a.txt", shape: "edit/edit", bucket: "code", culprits: [] }], null, { base: "main", baseSha: "abc1234" }).body;
  const fake = `${OVERLAP_MARKER}\n<!-- conflict-monitor:overlap:state resolved -->`;
  api.comments(1).push(
    { id: 1, body: e0, user: { type: "Bot", login: OVERLAP_BOT } },
    { id: 2, body: fake, user: { type: "User", login: "someone" } },
    { id: 3, body: fake, user: { type: "Bot", login: "some-app[bot]" } },
  );
  await run(w, api);
  assert.deepEqual(api.writes.filter((x) => x[1] === 1), [["create", 1]]);
  assert.deepEqual(api.comments(1).slice(0, 3).map((c) => c.body), [e0, fake, fake]);
  assert.ok(api.comments(1)[0].body.startsWith(MARKER));
});

test("the probe and the overlap mode, on one PR, each keep their own comment and leave the other's alone", async () => {
  const w = pair();
  const api = stubApi(w);
  await run(w, api);
  const overlapBody = own(api, 1)[0].body;
  // main moves under #1: now it conflicts with the base, and E0 says so.
  w.remote.commit("land (#9)", { "a.txt": A("MAIN") });
  await runProbe({ api, repo: "o/r", base: "main", baseSha: w.baseSha(), config, cwd: w.local.dir });
  const e0 = api.comments(1).filter((c) => c.body.startsWith(MARKER));
  assert.equal(e0.length, 1, "E0 created its own comment");
  assert.equal(own(api, 1)[0].body, overlapBody, "and did not touch the overlap comment");
  const e0Body = e0[0].body;
  await run(w, api);
  assert.equal(api.comments(1).find((c) => c.body.startsWith(MARKER)).body, e0Body, "the overlap run leaves E0's comment alone");
  assert.equal(rowsOn(api, 1).state, RESOLVED, "a.txt is E0's now: the overlap is gone from both");
  assert.equal(rowsOn(api, 2).state, RESOLVED);
});

test("an entries line that does not validate is dropped, and the comment recomputed in place", async () => {
  const w = pair();
  const api = stubApi(w);
  await run(w, api);
  const c = own(api, 1)[0];
  const bogus = Buffer.from(JSON.stringify({ rows: [["2", "a.txt", "same lines"], [777, "x", "nope<"]], seen: [777] })).toString("base64url");
  c.body = c.body.replace(/entries \S+/, `entries ${bogus}`);
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes, [["update", 1]]);
  assert.deepEqual(rowsOn(api, 1).rows, [{ partner: 2, path: "a.txt", kind: "same lines" }]);
});

test("a well-formed row naming a PR that does not exist is dropped by its 404, and the comment recomputed", async () => {
  const w = pair();
  const api = stubApi(w);
  await run(w, api);
  // Both hidden lines forged, and consistent with each other.
  const rows = [{ partner: 2, path: "a.txt", kind: "same lines" }, { partner: 777, path: "x", kind: "same lines" }];
  own(api, 1)[0].body = renderOverlap({ groups: groupsOf(rows), seen: [2, 777] }, { base: "main", baseSha: w.baseSha() });
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes, [["update", 1]]);
  assert.deepEqual(rowsOn(api, 1).rows, [{ partner: 2, path: "a.txt", kind: "same lines" }]);
});

test("ignored buckets, paths and heads make no pair", async () => {
  for (const block of [{ ignorePaths: ["a.txt"] }, { ignorePaths: ["*.txt"] }, { ignoreHeads: ["feat/pr2"] }]) {
    const w = pair();
    const api = stubApi(w);
    const result = await run(w, api, { block });
    assert.deepEqual(result.r2, [], JSON.stringify(block));
    assert.deepEqual(api.writes, [], JSON.stringify(block));
  }
  const w = world();
  w.push(1, { "gen.txt": lines("one") });
  w.push(2, { "gen.txt": lines("two") });
  const api = stubApi(w);
  assert.equal((await run(w, api)).r2.length, 1, "without the bucket ignored, it is a pair");
  const ignored = await run(w, stubApi(w), { block: { ignoreBuckets: ["generated"] } });
  assert.deepEqual([ignored.r2, ignored.r1], [[], []]);
});

test("a stacked pair is not paired: by base, and by held commits", async () => {
  const w = world();
  w.push(1, { "a.txt": A("ONE") });
  w.push(2, { "a.txt": A("TWO") }, { from: "feat/pr1", base: "feat/pr1" });
  w.push(3, { "a.txt": A("THREE") }, { from: "feat/pr1" });
  const api = stubApi(w);
  const result = await run(w, api);
  assert.equal(result.tally.open, 2, "#2 targets its parent's branch and is not listed");
  assert.deepEqual([result.r2, result.r1], [[], []]);
  assert.deepEqual(api.writes, []);
});

test("`comment: false` and a dry run write nothing, and still report the pairs", async () => {
  const w = pair();
  const api = stubApi(w);
  const off = await run(w, api, { block: { comment: false } });
  assert.equal(off.r2.length, 1);
  const dry = await run(w, api, { dryRun: true });
  assert.equal(dry.r2.length, 1);
  assert.deepEqual(api.writes, []);
});
