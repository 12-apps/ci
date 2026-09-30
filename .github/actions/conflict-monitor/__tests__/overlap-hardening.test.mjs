import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { confirmPartners, overlapSummary, runOverlap } from "../overlap.mjs";
import { lines } from "./fixture.mjs";
import { A, cleanupWorlds, config, overlapOf, own, pair, run, stubApi, world } from "./overlap-world.mjs";

// The overlap mode where it meets the unexpected: a pair large enough to
// overflow a comment, a path that carries a newline, a forged or stale
// comment, a PR that stops being eligible, and a GitHub read that fails.

after(cleanupWorlds);

const GITHUB_LIMIT = 65_536;
const MARGIN = 5_000;

/** A console.log capture around `f`. */
async function logsOf(f) {
  const seen = [];
  const log = console.log;
  console.log = (...a) => seen.push(a.join(" "));
  try {
    await f();
  } finally {
    console.log = log;
  }
  return seen;
}

test("a pair overlapping on 1,200 files: each body stays well under GitHub's limit, reads back, and a second run writes nothing", async () => {
  const w = world();
  const many = (tag) => Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`apps/admin/src/features/configuracao/vendas/components/file-${String(i).padStart(4, "0")}.tsx`, lines(tag)]));
  w.remote.commit("many files", many("base"));
  w.push(1, many("one"));
  w.push(2, many("two"));
  const api = stubApi(w);
  const first = await run(w, api);
  assert.deepEqual(first.tally.failedWrites, []);
  assert.deepEqual(api.writes.sort(), [["create", 1], ["create", 2]]);
  for (const n of [1, 2]) {
    const body = own(api, n)[0].body;
    assert.ok(body.length < GITHUB_LIMIT - MARGIN, `#${n}: ${body.length} characters`);
    assert.match(body, /\| #\d \| 1[0-9]{3} more file\(s\) \|/, "the rows not shown are counted");
  }
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes, [], "what the writer wrote, the reader trusts");
  // A change among the HIDDEN rows still moves the digest.
  w.push(2, { "apps/admin/src/features/configuracao/vendas/components/file-1199.tsx": lines("base") });
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes.sort(), [["update", 1], ["update", 2]]);
});

test("a newline in a path cannot break out of the code span, the table or the summary", async () => {
  const w = world();
  const evil = "x\n\n## Security notice: [re-run CI here](https://evil.example)\r\u2028y.md";
  w.push(1, { [evil]: lines("one") });
  w.push(2, { [evil]: lines("two") });
  const api = stubApi(w);
  const result = await run(w, api);
  assert.equal(result.r2.length, 1);
  const body = own(api, 1)[0].body;
  const summary = overlapSummary(result, { base: "main", baseSha: w.baseSha() });
  for (const text of [body, summary]) {
    assert.doesNotMatch(text, /^## Security/m);
    assert.doesNotMatch(text, /[\r\u2028]/);
    assert.ok(text.includes("\u240a"), "the newline is shown, as a visible control picture");
  }
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes, [], "and the reader accepts it back");
});

test("an invalid entries line under a `resolved` state line is rewritten in place, never re-posted", async () => {
  const w = pair();
  const api = stubApi(w);
  await run(w, api);
  const c = own(api, 1)[0];
  c.body = c.body.replace(/state \S+/, "state resolved").replace(/entries \S+/, "entries !!!");
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes, [["update", 1]]);
});

test("a merged group a trusted comment stores is final: it is not looked up again, and the comment does not change", async () => {
  const w = pair();
  w.push(4, { "a.txt": A("FOUR") });
  const api = stubApi(w, { closed: { 4: { merged_at: "2026-09-30T12:00:00Z" } } });
  await run(w, api);
  w.pull(4).state = "closed";
  await run(w, api);
  assert.match(own(api, 1)[0].body, /#4 merged/);
  // What the comment says about #4 is no longer what GitHub says.
  api.closed[4] = { merged_at: null };
  api.writes.length = 0;
  api.lookups.length = 0;
  await run(w, api);
  assert.deepEqual(api.lookups, [], "confirmed when it was written; never read again");
  assert.match(own(api, 1)[0].body, /#4 merged/);
  assert.deepEqual(api.writes, []);
});

test("partner lookups are bounded per run, and the bound is logged; rows past it are kept as they were", async () => {
  const w = pair();
  w.push(4, { "a.txt": A("FOUR") });
  w.push(5, { "a.txt": A("FIVE") });
  const api = stubApi(w, { closed: { 4: { merged_at: null }, 5: { merged_at: null } } });
  await run(w, api);
  w.pull(4).state = "closed";
  w.pull(5).state = "closed";
  api.lookups.length = 0;
  const logs = await logsOf(() =>
    runOverlap({ api, repo: "o/r", base: "main", baseSha: w.baseSha(), config, overlap: overlapOf(), cwd: w.local.dir, maxLookups: 1 }),
  );
  assert.deepEqual(api.lookups, [4], "one lookup, cached across PRs");
  assert.ok(logs.some((l) => /partner lookups? (capped|bound)/.test(l)), logs.join("\n"));
});

test("a partner whose state cannot be read (a 5xx, not a 404) keeps its rows, with no write", async () => {
  const w = pair();
  const api = stubApi(w, { closed: { 2: { status: 500 } } });
  await run(w, api);
  const before = own(api, 1)[0].body;
  w.pull(2).state = "closed";
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.writes.filter((x) => x[1] === 1), []);
  assert.equal(own(api, 1)[0].body, before);
});

test("a PR that stops being eligible — its head newly ignored, or its base retargeted — is told once, and never again", async () => {
  for (const change of ["ignoreHeads", "retarget"]) {
    const w = pair();
    const api = stubApi(w);
    await run(w, api);
    const opts = {};
    if (change === "ignoreHeads") opts.block = { ignoreHeads: ["feat/pr2"] };
    else w.pull(2).base.ref = "feat/elsewhere";
    api.writes.length = 0;
    await run(w, api, opts);
    assert.deepEqual(api.writes.sort(), [["update", 1], ["update", 2]], change);
    assert.match(own(api, 2)[0].body, /no longer checked for overlaps/i, change);
    api.writes.length = 0;
    await run(w, api, opts);
    assert.deepEqual(api.writes, [], `${change}: no flapping`);
  }
});

test("`ignoreBuckets` with an `absent` rule: a path gone from the base is ignored, a live one under the same glob is not", async () => {
  const w = world();
  w.remote.commit("keep one", { "gone/live.txt": lines("l") });
  w.push(1, { "gone/new.txt": lines("one"), "gone/live.txt": lines("one") });
  w.push(2, { "gone/new.txt": lines("two"), "gone/live.txt": lines("two") });
  const result = await run(w, stubApi(w), { block: { ignoreBuckets: ["removed"] } });
  assert.deepEqual(result.r2.map((p) => p.overlaps.map((o) => o.path)), [["gone/live.txt"]]);
});

test("a PR whose comments cannot be listed is skipped and logged; the others are still written", async () => {
  const w = pair();
  const api = stubApi(w);
  api.fail.comments.add(1);
  let result;
  const logs = await logsOf(async () => {
    result = await run(w, api);
  });
  assert.deepEqual(api.writes, [["create", 2]]);
  assert.ok(logs.some((l) => /#1: .*comments could not be listed/.test(l)), logs.join("\n"));
  assert.deepEqual(result.tally.failedWrites, []);
});

test("lookups never starve: 26 merged partners and one closed all resolve within two runs, and the steady state costs 0 lookups", async () => {
  const w = world();
  const selfFiles = {};
  for (let k = 1; k <= 27; k += 1) selfFiles[`f${k}.txt`] = lines("S");
  w.push(100, selfFiles);
  for (let k = 1; k <= 27; k += 1) w.push(100 + k, { [`f${k}.txt`]: lines("P") });
  const closed = {};
  for (let k = 1; k <= 26; k += 1) closed[100 + k] = { merged_at: "2026-09-30T12:00:00Z" };
  closed[127] = { merged_at: null };
  const api = stubApi(w, { closed });
  await run(w, api);
  for (let k = 1; k <= 27; k += 1) w.pull(100 + k).state = "closed";
  await run(w, api);
  await run(w, api);
  const body = own(api, 100).at(-1).body;
  assert.match(body, /#126 merged/);
  assert.doesNotMatch(body, /#127/, "the partner closed without merging is gone");
  assert.doesNotMatch(body, /If #1\d\d merges first/, "no open row is left for a PR that is gone");
  api.lookups.length = 0;
  api.writes.length = 0;
  await run(w, api);
  assert.deepEqual(api.lookups, [], "a stored merged group is final: never looked up again");
  assert.deepEqual(api.writes, []);
});

test("lookups rotate by run: partners whose reads keep failing cannot starve the others", async () => {
  const w = pair();
  for (const n of [4, 5, 6, 7, 8, 9]) w.push(n, { "a.txt": A(`P${n}`) });
  const closed = { 4: { status: 500 }, 5: { status: 500 } };
  for (const n of [6, 7, 8, 9]) closed[n] = { merged_at: null };
  const api = stubApi(w, { closed });
  await run(w, api);
  for (const n of [4, 5, 6, 7, 8, 9]) w.pull(n).state = "closed";
  const partnersOn1 = () => (own(api, 1).at(-1).body.match(/\| #(\d+) \|/g) ?? []).map((s) => Number(/\d+/.exec(s)[0]));
  for (let seed = 0; seed < 6; seed += 1) {
    await runOverlap({ api, repo: "o/r", base: "main", baseSha: w.baseSha(), config, overlap: overlapOf(), cwd: w.local.dir, maxLookups: 2, lookupSeed: seed });
  }
  assert.deepEqual([...new Set(partnersOn1())].sort((a, b) => a - b), [2, 4, 5], "#6–#9 dropped; only the unreadable #4 and #5 kept");
});

test("rotation covers every partner within ⌈n / max⌉ consecutive runs, even when every read keeps failing", async () => {
  const partners = Array.from({ length: 60 }, (_, i) => 1000 + i);
  const asked = new Set();
  const api = { request: async (_method, path) => {
    asked.add(Number(path.split("/").pop()));
    throw Object.assign(new Error("500"), { status: 500 });
  } };
  const runs = Math.ceil(partners.length / 25);
  for (let seed = 0; seed < runs; seed += 1) await confirmPartners(partners, { api, repo: "o/r", base: "main", max: 25, seed });
  assert.equal(asked.size, partners.length, `every partner asked within ${runs} runs`);
});

test("the unchecked sweep costs nothing in the steady state: 20 ignored PRs, no comment reads for them", async () => {
  const w = world();
  w.push(1, { "a.txt": A("ONE") });
  w.push(2, { "a.txt": A("TWO") });
  for (let k = 0; k < 20; k += 1) w.push(10 + k, { [`dep${k}.txt`]: lines("x") }, { head: `renovate/dep-${k}` });
  const api = stubApi(w);
  const block = { ignoreHeads: ["renovate/"] };
  await run(w, api, { block });
  const before = api.stats.reads;
  await run(w, api, { block });
  assert.equal(api.stats.reads - before, 5, "1 list page + 2 files lists + 2 comment lists");
});
