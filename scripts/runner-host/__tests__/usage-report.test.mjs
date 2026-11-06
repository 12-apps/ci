import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  describeError,
  fetchRetrying,
  fitTier,
  hostAndSlot,
  idleBreakdown,
  jobGroup,
  parseUsage,
  percentile,
  runJobs,
  JOBS_PER_PAGE,
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

// The report is the ruler every fleet change is measured with. One 502 among
// hundreds of calls used to throw the whole day's report away.
test("fetchRetrying retries a 5xx and a dropped connection, then answers", async () => {
  const answers = [{ status: 502 }, new TypeError("fetch failed"), { status: 503 }, { status: 200 }];
  const waits = [];
  const res = await fetchRetrying("u", {}, {
    fetchFn: async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; },
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(waits, [1000, 2000, 4000], "backs off exponentially between attempts");
});

test("fetchRetrying returns a 4xx at once, and the last 5xx once the tries run out", async () => {
  let calls = 0;
  const notFound = await fetchRetrying("u", {}, { fetchFn: async () => { calls++; return { status: 404 }; }, sleep: async () => {} });
  assert.equal(notFound.status, 404);
  assert.equal(calls, 1, "a 4xx is an answer, not an outage");
  calls = 0;
  const down = await fetchRetrying("u", {}, { tries: 3, fetchFn: async () => { calls++; return { status: 502 }; }, sleep: async () => {} });
  assert.equal(down.status, 502, "the caller's own error names the status");
  assert.equal(calls, 3);
  await assert.rejects(
    fetchRetrying("u", {}, { tries: 2, fetchFn: async () => { throw new TypeError("fetch failed"); }, sleep: async () => {} }),
    /fetch failed/,
  );
});

// 2026-11-06: the daily report died 70 seconds in on a body that stopped
// halfway, and all its log said was `terminated`. The retry has to cover the
// body, and the error has to name the call.
test("fetchRetrying reads the body inside the retry, so a body that stops halfway is retried", async () => {
  const headers = new Headers({ "content-type": "application/json" });
  const answers = [
    { status: 200, ok: true, headers, url: "u", text: async () => { throw new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }) }); } },
    { status: 200, ok: true, headers, url: "u", text: async () => '{"jobs":[1]}' },
  ];
  const waits = [];
  const res = await fetchRetrying("u", {}, { fetchFn: async () => answers.shift(), sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [1000], "one retry after the cut body");
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(res.headers, headers);
  assert.deepEqual(await res.json(), { jobs: [1] });
  assert.equal(await res.text(), '{"jobs":[1]}', "the body is read once and handed out as often as asked");
});

test("fetchRetrying names the URL and every cause once the tries run out", async () => {
  const cut = () => new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }) });
  await assert.rejects(
    fetchRetrying("https://api.github.com/x", {}, { tries: 2, fetchFn: async () => ({ status: 200, ok: true, text: async () => { throw cut(); } }), sleep: async () => {} }),
    (e) => {
      assert.equal(e.message, "https://api.github.com/x: terminated <- SocketError: other side closed [UND_ERR_SOCKET]");
      assert.equal(e.cause.message, "terminated");
      return true;
    },
  );
  assert.equal(describeError(new Error("plain")), "plain");
  assert.equal(
    describeError(new Error("https://api.github.com/repos/o/timeout/x: fetch failed", { cause: new Error("fetch failed", { cause: new Error("timeout") }) })),
    "https://api.github.com/repos/o/timeout/x: fetch failed <- fetch failed <- timeout",
    "a cause is never dropped for words an earlier part happens to contain",
  );
  await assert.rejects(
    fetchRetrying("https://api.github.com/y", {}, { tries: 1, fetchFn: async () => ({ status: 200, ok: true, text: async () => { throw cut(); } }), sleep: async () => {} }),
    (e) => {
      assert.equal(describeError(e), "https://api.github.com/y: terminated <- SocketError: other side closed [UND_ERR_SOCKET]", "what main() prints says the chain once");
      return true;
    },
  );
  assert.equal(describeError(new TypeError("terminated", { cause: new TypeError("terminated") })), "terminated", "a cause with the same words is said once");
  assert.equal(describeError(new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) })), "fetch failed <- getaddrinfo ENOTFOUND [ENOTFOUND]");
});

test("fetchRetrying hands a 4xx and the last 5xx over with their bodies read", async () => {
  const notFound = await fetchRetrying("u", {}, { fetchFn: async () => ({ status: 404, ok: false, text: async () => "nope" }), sleep: async () => {} });
  assert.equal(notFound.ok, false);
  assert.equal(await notFound.text(), "nope");
  let cancelled = 0;
  const down = await fetchRetrying("u", {}, {
    tries: 2,
    fetchFn: async () => ({ status: 502, ok: false, body: { cancel: async () => { cancelled++; } }, text: async () => "bad gateway" }),
    sleep: async () => {},
  });
  assert.equal(down.status, 502);
  assert.equal(await down.text(), "bad gateway");
  assert.equal(cancelled, 1, "the retried 5xx body is let go, the returned one is read");
});

// 2026-11-06: one page of 100 jobs of the daily full suite's run answered 502
// on every try (GitHub timing out building it), and killed every report whose
// week held that run. Pages of 30 answer.
test("runJobs reads a run's jobs 30 a page until a short page, and stops on a missing run", async () => {
  assert.equal(JOBS_PER_PAGE, 30);
  const asked = [];
  const pages = [Array.from({ length: 30 }, (_, i) => ({ id: i })), Array.from({ length: 30 }, (_, i) => ({ id: 30 + i })), [{ id: 60 }]];
  const jobs = await runJobs(async (p) => { asked.push(p); return { jobs: pages.shift() }; }, "o/r", 7, "latest");
  assert.equal(jobs.length, 61);
  assert.deepEqual(asked, [1, 2, 3].map((n) => `/repos/o/r/actions/runs/7/jobs?filter=latest&per_page=30&page=${n}`));
  assert.ok(asked.every((p) => !p.includes("per_page=100")), "never the page size GitHub times out on");
  assert.deepEqual(await runJobs(async () => null, "o/r", 8), [], "a run GitHub no longer has is an empty list");
  const seen = [];
  await runJobs(async (p) => { seen.push(p); return { jobs: [] }; }, "o/r", 10);
  assert.deepEqual(seen, ["/repos/o/r/actions/runs/10/jobs?filter=all&per_page=30&page=1"], "every attempt's jobs unless asked otherwise");
  await assert.rejects(runJobs(async () => ({ jobs: Array.from({ length: 30 }, (_, i) => ({ id: i })) }), "o/r", 11), /page 100/, "a reader that ignores page fails instead of looping forever");
  const exact = [Array.from({ length: 30 }, (_, i) => ({ id: i })), []];
  assert.equal((await runJobs(async () => ({ jobs: exact.shift() }), "o/r", 9)).length, 30, "a full last page is followed by one empty page");
});
