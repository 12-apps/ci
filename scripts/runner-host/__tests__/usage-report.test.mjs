import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  fitTier,
  hostAndSlot,
  idleBreakdown,
  jobGroup,
  parseUsage,
  percentile,
  overlap,
  renderIdle,
  renderJobs,
  renderWaits,
  union,
  summarizeJobs,
} from "../usage-report.mjs";

// The report decides which jobs move to smaller slots. A fit rounded the wrong
// way sends a job to a slot it runs out of memory in; an idle split that
// double-counts hides where the fleet's money goes.

test("parseUsage finds the line in a real-shaped job log, CRLF and timestamps included", () => {
  const log =
    "2026-09-29T10:00:00.0000000Z ##[group]Run tests\r\n" +
    '2026-09-29T10:05:00.1234567Z ci-runner-usage {"v":1,"wallMs":300000,"peakWorkingSetMiB":2100}\r\n' +
    "2026-09-29T10:05:01.0000000Z Cleaning up orphan processes\r\n";
  assert.deepEqual(parseUsage(log), { v: 1, wallMs: 300000, peakWorkingSetMiB: 2100 });
  assert.equal(parseUsage("no usage here"), null);
  assert.equal(parseUsage("ci-runner-usage {broken"), null);
});

test("jobGroup folds matrix legs together and keeps the job's own words", () => {
  assert.equal(jobGroup("CI", "Unit Tests (3/8)"), "CI / Unit Tests (#/#)");
  assert.equal(jobGroup("CI", "Unit Tests (5/8)"), "CI / Unit Tests (#/#)");
  assert.equal(jobGroup("CI", "E2E (client, shard 2)"), "CI / E2E (client, shard #)");
  assert.equal(jobGroup("CI", "Lint"), "CI / Lint");
});

test("fitTier: the largest working set plus 25% must fit, never rounded down", () => {
  assert.equal(fitTier(3276), 4); // 3276 × 1.25 = 4095 MiB, under 4096
  assert.equal(fitTier(3277), 8); // 4096.25 MiB: over 4 GiB by a quarter MiB
  assert.equal(fitTier(12_000), 16);
  assert.equal(fitTier(60_000), null);
});

test("percentile is nearest-rank and ignores missing values", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([null, 4, undefined], 50), 4);
  assert.equal(percentile([], 50), null);
});

test("summarizeJobs fits a group by its WORST run, and sorts by job-minutes", () => {
  const u = (wallMs, ws) => ({
    wallMs,
    peakWorkingSetMiB: ws,
    avgCores: 1,
    peakCores: 2,
    cpuWaitPct: 0,
    oomKills: 0,
    netTxMiB: 512,
  });
  const rows = summarizeJobs([
    { group: "small", usage: u(60_000, 1000) },
    { group: "big", usage: u(600_000, 2000) },
    { group: "big", usage: u(600_000, 2000) },
    { group: "big", usage: u(600_000, 7000) }, // one bad run
  ]);
  assert.deepEqual(
    rows.map((r) => [r.group, r.runs, r.jobMinutes, r.fitsGiB, r.netTxGiB]),
    [
      ["big", 3, 30, 16, 1.5],
      ["small", 1, 1, 4, 0.5],
    ],
  );
});

test("renderJobs prints one row per group under a header of the same width", () => {
  const rows = summarizeJobs([{ group: "g", usage: { wallMs: 60_000, peakWorkingSetMiB: 100, netTxMiB: 1 } }]);
  const [head, rule, row] = renderJobs(rows).split("\n");
  const cells = (l) => l.split("|").length;
  assert.equal(cells(rule), cells(head));
  assert.equal(cells(row), cells(head));
});

test("hostAndSlot splits the slot number off the fleet's runner names", () => {
  // As a real fleet job reports it (future-pay run 36384097986): <host>-<slot>-<epoch>.
  assert.deepEqual(hostAndSlot("eu-north-1b-ip-172-31-36-84-1-1790575022"), {
    host: "eu-north-1b-ip-172-31-36-84",
    slot: "1",
  });
  assert.deepEqual(hostAndSlot("us-east-2a-ip-10-0-1-5-2"), { host: "us-east-2a-ip-10-0-1-5", slot: "2" });
  assert.equal(hostAndSlot(""), null);
});

test("idleBreakdown: every paid slot-second lands in exactly one bucket", () => {
  const boot = 1_790_574_985; // epoch seconds, as a real host reports
  const min = 60_000;
  const job = (slot, start, minutes, bootS = boot) => ({
    runner: `eu-north-1a-ip-10-0-0-9-${slot}-${bootS + start * 60}`,
    hostBootS: bootS,
    startMs: bootS * 1000 + start * min,
    wallMs: minutes * min,
  });
  // Slot 1: starts at 2 min, runs 10, idles 3, runs 5 → ends at 20.
  // Slot 2: starts at 4 min, runs 6 → ends at 10.
  // Stop = 20 + 2 idle minutes = 22 min after boot.
  const t = idleBreakdown([job(1, 2, 10), job(1, 15, 5), job(2, 4, 6)], { slots: 2, idleMinutes: 2 });
  assert.equal(t.hosts, 1);
  assert.equal(t.paid, 2 * 22 * min);
  assert.equal(t.busy, 21 * min);
  assert.equal(t.startup, (2 + 4) * min);
  assert.equal(t.between, 3 * min);
  assert.equal(t.tail, (2 + 12) * min);
  assert.equal(t.unused, 0);
  assert.equal(t.busy + t.startup + t.between + t.tail + t.unused, t.paid);

  // A 2-slot host that only ever ran one job pays for the empty slot too, and
  // a second boot of the same host (warm pool) is its own stretch.
  const u = idleBreakdown([job(1, 1, 4), job(1, 1, 4, boot + 3600)], { slots: 2, idleMinutes: 2 });
  assert.equal(u.hosts, 2);
  assert.equal(u.paid, 2 * 2 * 7 * min);
  assert.equal(u.unused, 2 * 7 * min);
  assert.equal(u.busy + u.startup + u.between + u.tail + u.unused, u.paid);
  assert.match(renderIdle(u), /slot never used \| 0\.2 \| 50\.0%/);
});

test("union merges overlapping and touching intervals and drops empty ones", () => {
  assert.deepEqual(union([[5, 8], [1, 3], [2, 4], [8, 9], [7, 7]]), [
    [1, 4],
    [5, 9],
  ]);
  assert.equal(overlap(0, 10, union([[1, 4], [5, 9]])), 7);
  assert.equal(overlap(3, 6, union([[1, 4], [5, 9]])), 2);
  assert.equal(overlap(10, 20, union([[1, 4]])), 0);
});

test("idleBreakdown: idle slot time while a job was queued is counted as overhead, the rest as no demand", () => {
  const boot = 1_790_574_985;
  const min = 60_000;
  const B = boot * 1000;
  const job = (slot, start, minutes) => ({
    runner: `eu-north-1a-ip-10-0-0-9-${slot}-${boot + start * 60}`,
    hostBootS: boot,
    startMs: B + start * min,
    wallMs: minutes * min,
  });
  // One slot: boots at 0, first job 2..6, next job 9..10, stops at 12.
  // A job was queued from 1 to 2 (it waited for this host to come up) and
  // from 7 to 9 (it waited while this slot turned over).
  const waiting = union([
    [B + 1 * min, B + 2 * min],
    [B + 7 * min, B + 9 * min],
  ]);
  const t = idleBreakdown([job(1, 2, 4), job(1, 9, 1)], { slots: 1, idleMinutes: 2, waiting });
  assert.equal(t.startup, 2 * min);
  assert.equal(t.whileWaiting.startup, 1 * min);
  assert.equal(t.between, 3 * min);
  assert.equal(t.whileWaiting.between, 2 * min);
  assert.equal(t.tail, 2 * min);
  assert.equal(t.whileWaiting.tail ?? 0, 0);
  assert.equal(t.busy + t.startup + t.between + t.tail + t.unused, t.paid);
  assert.match(renderIdle(t), /between jobs on a slot \| 0\.1 \| 25\.0% \| 0\.0 \|/);
});

test("renderWaits reports queue-wait percentiles in seconds", () => {
  const out = renderWaits([10, 20, 30, 40, 1000].map((s) => ({ queuedMs: s * 1000 })));
  assert.match(out, /\| 5 \| 30 s \| 1000 s \| 1000 s \| 1000 s \|/);
  assert.equal(renderWaits([]), "No queue times.");
});
