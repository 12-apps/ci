import assert from "node:assert/strict";
import { test } from "node:test";

import { fitFixedCost, mergeLedger, slowReport } from "../lib/refresh.mjs";
import { emptyLedger, normaliseLedger, serialiseLedger, sizeLane } from "../lib/timings.mjs";

// future-pay's daily run 43265976316: each Gherkin leg's summed feature seconds
// against its test step. Every leg pays about a minute before its first feature.
const GHERKIN = [
  [529, 595], [527, 588], [586, 667], [559, 624], [488, 548], [515, 593], [517, 598], [402, 473],
].map(([measured, wall], i) => ({ leg: i + 1, measured, wall }));

const ledgerOf = (files, extra = {}) => ({ ...emptyLedger(), ...extra, files: new Map(Object.entries(files)) });

test("a serial lane's fixed cost is the median of step minus items, and concurrency is what is left", () => {
  const { fixedSeconds, concurrency } = fitFixedCost(GHERKIN, emptyLedger());
  // Gaps 60, 61, 65, 66, 71, 78, 81, 81 → median (66 + 71) / 2.
  assert.equal(fixedSeconds, 68.5);
  assert.ok(concurrency > 0.97 && concurrency < 1.03, `concurrency ${concurrency}`);
});

test("a leg that waited on a slow runner does not move the fixed cost", () => {
  const withOutlier = [...GHERKIN, { leg: 9, measured: 300, wall: 900 }];
  // Nine gaps, the ninth 600 s: the median moves one place, to 71, not to the mean (~128).
  assert.equal(fitFixedCost(withOutlier, emptyLedger()).fixedSeconds, 71);
});

test("no paired leg keeps yesterday's fixed cost and concurrency", () => {
  const yesterday = { ...emptyLedger(), concurrency: 0.98, fixedSeconds: 70 };
  assert.deepEqual(fitFixedCost([], yesterday), { concurrency: 0.98, fixedSeconds: 70 });
});

test("a lane that does not opt in keeps the ratio-only concurrency and no fixed cost", () => {
  const paired = GHERKIN.reduce((a, p) => ({ measured: a.measured + p.measured, wall: a.wall + p.wall }), { measured: 0, wall: 0 });
  const { ledger } = mergeLedger(emptyLedger(), new Map([["a.feature", { seconds: 10 }]]), {
    exists: () => true, paired, pairs: GHERKIN,
  });
  assert.equal(ledger.concurrency, 0.88);
  assert.equal(ledger.fixedSeconds ?? 0, 0);
  assert.doesNotMatch(serialiseLedger(ledger), /fixedSeconds/);
});

test("a lane that opts in stores its fixed cost in the ledger", () => {
  const { ledger } = mergeLedger(emptyLedger(), new Map([["a.feature", { seconds: 10 }]]), {
    exists: () => true, pairs: GHERKIN, fixedCost: true,
  });
  assert.equal(ledger.fixedSeconds, 68.5);
  const back = normaliseLedger(JSON.parse(serialiseLedger(ledger)));
  assert.equal(back.fixedSeconds, 68.5);
});

test("size gives each leg the target minus its fixed cost", () => {
  const files = { a: 400, b: 350, c: 350 }; // 1,100 s of items, one at a time
  const without = sizeLane(Object.keys(files), ledgerOf(files), { targetSeconds: 600, maxShards: 10 });
  assert.equal(without.shardTotal, 2);
  const withFixed = sizeLane(Object.keys(files), ledgerOf(files, { fixedSeconds: 72.5 }), { targetSeconds: 600, maxShards: 10 });
  // 1,100 / (600 − 72.5) = 2.09 → 3 legs, each reported with its boot.
  assert.equal(withFixed.shardTotal, 3);
  assert.equal(withFixed.fixedSeconds, 72.5);
  assert.deepEqual([...withFixed.legSeconds].sort((x, y) => x - y), [422.5, 422.5, 472.5]);
});

test("a fixed cost near the target cannot ask for unbounded legs", () => {
  const files = { a: 300, b: 300 };
  const sized = sizeLane(Object.keys(files), ledgerOf(files, { fixedSeconds: 590 }), { targetSeconds: 600, maxShards: 50 });
  // Items get at least a quarter of the target: 600 / 150 = 4, capped by 2 items.
  assert.equal(sized.wanted, 4);
  assert.equal(sized.shardTotal, 2);
});

test("the full-width report counts the fixed cost too", () => {
  const files = { a: 600, b: 600 };
  const at = (extra) =>
    slowReport("gherkin", new Map(), { slowFileSeconds: 180, targetSeconds: 600, ledger: ledgerOf(files, extra), maxShards: 10 });
  assert.equal(at({}).cap.fullWidthWants, 2); // 1,200 / 600
  assert.equal(at({ fixedSeconds: 100 }).cap.fullWidthWants, 3); // 1,200 / 500
});
