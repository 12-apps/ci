import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, digitOf, digitsAt } from "../lib/assign.mjs";

const reg = {
  control: [0, 1],
  experiments: [
    { name: "plans-x", start: "2026-11-27T15:00:00-03:00", allocation: [
      { from: "2026-11-27T15:00:00-03:00", digits: [2, 3] },
      { from: "2026-11-29T15:00:00-03:00", digits: [2, 3, 4, 5] },
    ] },
    { name: "gates-y", start: "2026-11-27T15:00:00-03:00", end: "2026-12-04T15:00:00-03:00", allocation: [
      { from: "2026-11-27T15:00:00-03:00", digits: [6, 7] },
    ] },
  ],
};
const pr = (runId, createdAt, extra = {}) => assign({ runId, event: "pull_request", createdAt, registry: reg, ...extra });

test("the bucket is the run id's last digit", () => {
  assert.equal(digitOf("45689433892"), 2);
  assert.equal(digitOf(45689433890), 0);
  assert.equal(digitOf(""), null);
  assert.equal(digitOf("12a"), null);
});

test("control digits are never in an experiment", () => {
  for (const id of ["100", "101", "9990", "9991"]) assert.equal(pr(id, "2026-11-28T12:00:00Z").experiment, "");
});

test("a digit an experiment holds puts the run in it, once it has started", () => {
  assert.equal(pr("12", "2026-11-28T12:00:00Z").experiment, "plans-x");
  assert.equal(pr("17", "2026-11-28T12:00:00Z").experiment, "gates-y");
  assert.equal(pr("19", "2026-11-28T12:00:00Z").experiment, "", "a free digit is control");
});

test("before the start, everything is control", () => {
  assert.equal(pr("12", "2026-11-27T17:59:59Z").experiment, "");
  assert.equal(pr("12", "2026-11-27T18:00:00Z").experiment, "plans-x");
});

test("the allocation in force at the run's creation decides, not the latest one", () => {
  assert.equal(pr("14", "2026-11-28T12:00:00Z").experiment, "");
  assert.equal(pr("14", "2026-11-29T18:00:00Z").experiment, "plans-x");
});

test("after the end the experiment is gone", () => {
  assert.equal(pr("16", "2026-12-04T18:00:00Z").experiment, "");
});

test("a switched-off experiment is control at once", () => {
  assert.equal(pr("12", "2026-11-28T12:00:00Z", { off: "gates-y, plans-x" }).experiment, "");
  assert.equal(pr("17", "2026-11-28T12:00:00Z", { off: "plans-x" }).experiment, "gates-y");
});

test("only a pull request is ever in an experiment", () => {
  for (const event of ["push", "workflow_dispatch", "schedule"]) {
    assert.equal(assign({ runId: "12", event, createdAt: "2026-11-28T12:00:00Z", registry: reg }).experiment, "");
  }
});

test("fails open: no registry, garbage, a bad date or two holders is control", () => {
  assert.equal(pr("12", "2026-11-28T12:00:00Z", { registry: null }).experiment, "");
  assert.equal(pr("12", "2026-11-28T12:00:00Z", { registry: { experiments: "x" } }).experiment, "");
  assert.equal(pr("12", "not a date").experiment, "");
  const clash = { experiments: [
    { name: "a", start: "2026-11-01T00:00:00Z", allocation: [{ from: "2026-11-01T00:00:00Z", digits: [5] }] },
    { name: "b", start: "2026-11-01T00:00:00Z", allocation: [{ from: "2026-11-01T00:00:00Z", digits: [5] }] },
  ] };
  const r = pr("15", "2026-11-28T12:00:00Z", { registry: clash });
  assert.equal(r.experiment, "");
  assert.match(r.reason, /held by a and b/);
});

test("digitsAt ignores digits outside 0-9 and an experiment with no start", () => {
  assert.deepEqual(digitsAt({ start: "2026-11-01T00:00:00Z", allocation: [{ from: "2026-11-01T00:00:00Z", digits: [3, 12, -1, "4"] }] }, Date.parse("2026-11-02T00:00:00Z")), [3]);
  assert.deepEqual(digitsAt({ allocation: [{ from: "2026-11-01T00:00:00Z", digits: [3] }] }, Date.parse("2026-11-02T00:00:00Z")), []);
});

test("over ids in a row, each digit gets a tenth", () => {
  const counts = Array(10).fill(0);
  for (let i = 45000000000; i < 45000001000; i++) counts[digitOf(i)]++;
  assert.deepEqual(counts, Array(10).fill(100));
});

test("an allocation that is not a list is ignored, never thrown on", () => {
  for (const allocation of [5, {}, "x", null]) {
    const r = assign({ runId: "12", event: "pull_request", createdAt: "2026-11-28T12:00:00Z", registry: { experiments: [{ name: "a", start: "2026-11-01T00:00:00Z", allocation }] } });
    assert.equal(r.experiment, "");
  }
});
