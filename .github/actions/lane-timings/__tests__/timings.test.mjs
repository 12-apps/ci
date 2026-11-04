import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  costModel,
  emptyLedger,
  normaliseLedger,
  packLegs,
  readLedger,
  serialiseLedger,
  sizeLane,
} from "../lib/timings.mjs";

const ledgerOf = (files, concurrency = 1) => normaliseLedger({ concurrency, files });
const tmp = () => mkdtempSync(join(tmpdir(), "lane-timings-"));

test("a missing, corrupt or shapeless ledger reads as empty, never throws", () => {
  const dir = tmp();
  writeFileSync(join(dir, "bad.json"), "{nope");
  writeFileSync(join(dir, "shapeless.json"), "[1,2]");
  for (const path of [join(dir, "absent.json"), join(dir, "bad.json"), join(dir, "shapeless.json")]) {
    const ledger = readLedger(path);
    assert.equal(ledger.files.size, 0);
    assert.equal(ledger.concurrency, 1);
  }
});

test("the old hand-made ms ledger is read in seconds", () => {
  const ledger = normaliseLedger({ unit: "ms", files: { "a.test.ts": 4760, junk: "x", neg: -1 } });
  assert.deepEqual([...ledger.files], [["a.test.ts", 4.76]]);
});

test("serialise sorts keys, rounds, and round-trips", () => {
  const text = serialiseLedger(ledgerOf({ "b.ts": 1.26, "a.ts": 2 }, 3.5));
  const back = normaliseLedger(JSON.parse(text));
  assert.deepEqual(Object.keys(JSON.parse(text).files), ["a.ts", "b.ts"]);
  assert.equal(back.files.get("b.ts"), 1.3);
  assert.equal(back.concurrency, 3.5);
});

test("an unknown item costs the mean of the known; an empty ledger costs the default", () => {
  const cost = costModel(ledgerOf({ a: 100, b: 300 }));
  assert.equal(cost("new"), 200);
  assert.equal(costModel(emptyLedger(), { defaultSeconds: 7 })("x"), 7);
});

test("packing is longest-first, disjoint, exhaustive and deterministic", () => {
  const ledger = ledgerOf({ a: 144, b: 108, c: 89, d: 77, e: 57 });
  const cost = costModel(ledger);
  const legs = packLegs(["e", "d", "c", "b", "a"], 2, cost);
  // The run 41874433175 split, reproduced: leg 1 expedicao+tempos, leg 2 the other three.
  assert.deepEqual(legs.map((l) => l.items), [["a", "d"], ["b", "c", "e"]]);
  assert.deepEqual(packLegs(["a", "b", "c", "d", "e"], 2, cost), legs);
  assert.deepEqual(legs.flatMap((l) => l.items).sort(), ["a", "b", "c", "d", "e"]);
});

test("legs are sized by measured seconds, not by count", () => {
  // Two items worth 25 minutes: count-based sizing gave ONE leg.
  const ledger = ledgerOf({ slow1: 750, slow2: 750 });
  const sized = sizeLane(["slow1", "slow2"], ledger, { maxShards: 6 });
  assert.equal(sized.shardTotal, 2); // wants three; capped by item count: two items, two legs
  assert.equal(sized.wanted, 3);
  assert.deepEqual(sized.legs, [["slow1"], ["slow2"]]);
});

test("forty cheap items stay on one leg; a heavy selection fans out to ~10 minute legs", () => {
  const cheap = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, 5]));
  assert.equal(sizeLane(Object.keys(cheap), ledgerOf(cheap), { maxShards: 24 }).shardTotal, 1);

  const heavy = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`h${i}`, 100]));
  const sized = sizeLane(Object.keys(heavy), ledgerOf(heavy), { maxShards: 24 });
  assert.equal(sized.shardTotal, 10); // 6000 s / 600 s
  assert.ok(sized.legSeconds.every((s) => s <= 600), sized.legSeconds.join(","));
});

test("concurrency divides the estimate: a vitest pool of 4 needs a quarter of the legs", () => {
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, 96]));
  assert.equal(sizeLane(Object.keys(files), ledgerOf(files, 1), { maxShards: 24 }).shardTotal, 16);
  assert.equal(sizeLane(Object.keys(files), ledgerOf(files, 4), { maxShards: 24 }).shardTotal, 4);
});

test("the cap binds loudly, never silently", () => {
  const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 300]));
  const sized = sizeLane(Object.keys(files), ledgerOf(files), { maxShards: 4 });
  assert.equal(sized.shardTotal, 4);
  assert.equal(sized.wanted, 15);
  assert.equal(sized.binding, true);
});

test("an empty selection answers emptyShards legs; a minimum is honoured", () => {
  assert.equal(sizeLane([], emptyLedger(), { maxShards: 6 }).shardTotal, 0);
  assert.equal(sizeLane([], emptyLedger(), { maxShards: 6, emptyShards: 1 }).shardTotal, 1);
  assert.deepEqual(sizeLane([], emptyLedger(), { maxShards: 6, emptyShards: 1 }).legs, [[]]);
  assert.equal(sizeLane(["a", "b", "c"], ledgerOf({ a: 1, b: 1, c: 1 }), { maxShards: 6, minShards: 2 }).shardTotal, 2);
});

test("unknown items are listed, and the largest item is named", () => {
  const sized = sizeLane(["known", "new"], ledgerOf({ known: 400, other: 200 }), { maxShards: 4 });
  assert.deepEqual(sized.unknown, ["new"]);
  assert.deepEqual(sized.largest, { item: "known", seconds: 400 });
});
