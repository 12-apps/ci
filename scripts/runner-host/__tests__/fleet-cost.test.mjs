import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  allInRate,
  attribute,
  bottomUp,
  byUtcDay,
  cached,
  collectFleetJobs,
  compileLanes,
  costGroup,
  costsByDayRegion,
  fleetJob,
  listRuns,
  placeHosts,
  quotaPauseMs,
  regionOf,
  render,
  report,
  rollup,
  shardOf,
  slotPieces,
  splitHosts,
  spotPricer,
  toCsv,
  untaggedByDay,
  zoneOf,
} from "../fleet-cost.mjs";

// The report decides what a lane is told it costs. A host counted twice, a
// recycled address merged into one long "paid" stretch, or a rate per slot
// passed where a rate per job-minute is expected all make every figure wrong
// while the totals still add up — so the tests pin the pieces, not the sum.

const MIN = 60_000;
const T0 = Date.parse("2026-09-29T10:00:00Z");
const at = (min) => new Date(T0 + min * MIN).toISOString();
let nextId = 1;
const job = (host, slot, from, to, extra = {}) => ({
  id: nextId++, workflow: "CI", name: "Unit Tests (1/4)", labels: ["fleet"],
  runner_name: `${host}-${slot}-1790575022`, conclusion: "success",
  started_at: at(from), completed_at: at(to), ...extra,
});
const H = "us-east-2a-ip-10-0-0-1";

test("zones, regions and matrix legs are read from the names", () => {
  assert.equal(zoneOf("eu-north-1b-ip-10-0-0-1"), "eu-north-1b");
  assert.equal(zoneOf("ip-10-0-0-1"), null);
  assert.equal(regionOf("eu-north-1b"), "eu-north-1");
  assert.equal(regionOf(null), "unknown");
  assert.equal(shardOf("Unit Tests (3/8)"), "3/8");
  assert.equal(shardOf("E2E (client, shard 2)"), "client, shard 2");
  assert.equal(shardOf("Lint"), "");
  assert.equal(shardOf("Build (web)"), "");
  assert.equal(shardOf("Unit Tests · shard 3/4"), "3/4");
});

test("a cost group folds every number: shards, matrix legs and a PR-named workflow", () => {
  assert.equal(costGroup("CI", "Tests / Unit Tests · shard 3/4"), "CI / Tests / Unit Tests · shard #/#");
  assert.equal(costGroup("CI", "Tests / Unit Tests · shard 1/4"), costGroup("CI", "Tests / Unit Tests · shard 4/4"));
  assert.equal(costGroup("Code Quality: PR #2123", "Analyze (javascript-typescript)"), "Code Quality: PR ## / Analyze (javascript-typescript)");
  assert.equal(costGroup("CI", "Lint"), "CI / Lint");
  assert.equal(costGroup("CI", "SPA E2E (3)"), "CI / SPA E2E (#)", "a digit inside a word is part of the name");
  assert.equal(costGroup(`Post-CD Tests — prod @ ${"a1".repeat(20)}`, "Smoke"), "Post-CD Tests — prod @ <sha> / Smoke");
});

test("lanes: first matching rule wins, unmatched is other, a bad rule is refused", () => {
  const lane = compileLanes([
    { lane: "unit", match: "unit tests" },
    { lane: "tests", match: "tests" },
  ]);
  assert.equal(lane(costGroup("CI", "Tests / Unit Tests · shard 2/4")), "unit");
  assert.equal(lane("CI / Integration Tests"), "tests");
  assert.equal(lane("CI / Lint"), "other");
  assert.throws(() => compileLanes([{ lane: "x" }]), /string "match"/);
  assert.throws(() => compileLanes({}), /array/);
});

test("byUtcDay cuts a stretch at every UTC midnight", () => {
  const a = Date.parse("2026-09-29T23:30:00Z");
  const b = Date.parse("2026-09-30T00:15:00Z");
  assert.deepEqual(byUtcDay(a, b).map(([d, x, y]) => [d, (y - x) / MIN]), [["2026-09-29", 30], ["2026-09-30", 15]]);
  assert.deepEqual(byUtcDay(b, a), []);
});

test("one runner key is split into two hosts when the address sat idle past idle + margin", () => {
  const jobs = [job(H, 1, 0, 10), job(H, 1, 30, 40)].map(fleetJob);
  const hosts = splitHosts(jobs, { splitGapMs: 5 * MIN });
  assert.equal(hosts.length, 2, "a 20-minute silence is a terminated host, not one host idling");
});

test("the gap is measured from the end of ALL slots' work, not the previous job's end", () => {
  // Slot 1 runs 0–30; slot 2 runs a short 1–2 and then 32–40. In start order the
  // previous job (1–2) ended 30 minutes before 32, but the host was busy until 30.
  const jobs = [job(H, 1, 0, 30), job(H, 2, 1, 2), job(H, 2, 32, 40)].map(fleetJob);
  assert.equal(splitHosts(jobs, { splitGapMs: 5 * MIN }).length, 1);
});

test("a different boot time splits a key even with no gap: a recycled address", () => {
  const boot = (min) => (T0 + min * MIN) / 1000;
  const jobs = [job(H, 1, 0, 10, { hostBootS: boot(-3) }), job(H, 1, 11, 20, { hostBootS: boot(8) })].map(fleetJob);
  assert.equal(splitHosts(jobs, { splitGapMs: 5 * MIN }).length, 2);
});

test("a host starts at its boot when known, else at its first job minus the measured startup", () => {
  const boot = (min) => (T0 + min * MIN) / 1000;
  const jobs = [
    job(H, 1, 0, 10, { hostBootS: boot(-4) }), // startup 4 min
    job("us-east-2b-ip-10-0-0-2", 1, 0, 10), // no boot: borrows 4 min
  ].map(fleetJob);
  const { hosts, startupMs } = placeHosts(splitHosts(jobs, { splitGapMs: 5 * MIN }), { idleMs: 2 * MIN });
  assert.equal(startupMs, 4 * MIN);
  for (const h of hosts) {
    assert.equal(h.start, T0 - 4 * MIN);
    assert.equal(h.end, T0 + 12 * MIN, "last job end + idle");
  }
  assert.deepEqual(hosts.map((h) => h.startKnown).sort(), [false, true]);
});

test("slot pieces add up to slots × lifetime and say where each minute went", () => {
  const jobs = [job(H, 1, 0, 10), job(H, 1, 12, 20)].map(fleetJob);
  const { hosts } = placeHosts(splitHosts(jobs, { splitGapMs: 5 * MIN }), { idleMs: 2 * MIN, defaultStartupMs: 3 * MIN });
  const pieces = slotPieces(hosts, { slots: 2 });
  const by = (k) => pieces.filter((p) => p.kind === k).reduce((a, p) => a + p.ms, 0) / MIN;
  // Lifetime −3 … 22 = 25 min, 2 slots = 50 slot-min.
  assert.equal(by("busy"), 18);
  assert.equal(by("startup"), 3);
  assert.equal(by("between"), 2);
  assert.equal(by("tail"), 2);
  assert.equal(by("unused"), 25);
  assert.equal(pieces.reduce((a, p) => a + p.ms, 0) / MIN, 50);
});

test("a host that ran slot 4 had four slots that day, whatever the default", () => {
  const jobs = [job(H, 4, 0, 10)].map(fleetJob);
  const { hosts } = placeHosts(splitHosts(jobs, { splitGapMs: 5 * MIN }), { idleMs: 0, defaultStartupMs: 0 });
  const pieces = slotPieces(hosts, { slots: 2 });
  assert.equal(pieces.filter((p) => p.kind === "unused").length, 3);
});

const ce = (rows) => ({
  ResultsByTime: Object.entries(rows).map(([day, groups]) => ({
    TimePeriod: { Start: day },
    Groups: Object.entries(groups).map(([k, v]) => ({ Keys: [k], Metrics: { UnblendedCost: { Amount: String(v) } } })),
  })),
});

test("attribution spreads a day × region's cost over PAID slot time, and keeps cost with no slot apart", () => {
  const jobs = [job(H, 1, 0, 10), job(H, 2, 0, 10)].map(fleetJob);
  const { hosts } = placeHosts(splitHosts(jobs, { splitGapMs: 5 * MIN }), { idleMs: 10 * MIN, defaultStartupMs: 0 });
  // 2 slots × 20 min paid, 20 of them running jobs.
  const costs = costsByDayRegion(ce({ "2026-09-29": { "us-east-2": 4, "us-east-1": 1 } }));
  const { days, rows } = attribute(slotPieces(hosts, { slots: 2 }), costs, { lane: () => "unit" });
  const [d] = days;
  assert.equal(d.tagged, 5);
  assert.equal(d.unattributed, 1, "us-east-1 had cost but no fleet slot");
  assert.equal(Math.round(d.busyUsd * 100) / 100, 2);
  assert.equal(Math.round(d.tailUsd * 100) / 100, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobs, 2);
  assert.equal(rows[0].shard, "1/4");
  // The all-in rate charges the overhead to the running minutes: $5 over 20 job-min.
  assert.equal(allInRate(days), 0.25);
});

test("a day with a zone-less runner name pools its regions instead of pricing that host at zero", () => {
  const jobs = [job(H, 1, 0, 10), job("ip-10-0-0-9", 1, 0, 10)].map(fleetJob);
  const { hosts } = placeHosts(splitHosts(jobs, { splitGapMs: 5 * MIN }), { idleMs: 0, defaultStartupMs: 0 });
  const costs = costsByDayRegion(ce({ "2026-09-29": { "us-east-2": 1, "us-east-1": 1 } }));
  const { days, rows } = attribute(slotPieces(hosts, { slots: 1 }), costs);
  assert.equal(days[0].pooled, true);
  assert.equal(days[0].unattributed, 0);
  assert.deepEqual(rows.map((r) => r.usd).sort(), [1, 1], "each host gets half of the day's $2");
});

test("a job across UTC midnight is billed to each day at that day's rate", () => {
  const T = Date.parse("2026-09-29T23:50:00Z");
  const j = fleetJob({ ...job(H, 1, 0, 0), started_at: new Date(T).toISOString(), completed_at: new Date(T + 20 * MIN).toISOString() });
  const { hosts } = placeHosts(splitHosts([j], { splitGapMs: 5 * MIN }), { idleMs: 0, defaultStartupMs: 0 });
  const costs = costsByDayRegion(ce({ "2026-09-29": { "us-east-2": 1 }, "2026-09-30": { "us-east-2": 1 } }));
  const { rows } = attribute(slotPieces(hosts, { slots: 1 }), costs);
  assert.deepEqual(rows.map((r) => [r.day, r.ms / MIN, r.usd]).sort(), [["2026-09-29", 10, 1], ["2026-09-30", 10, 1]]);
});

test("the spot pricer takes, per type, the last price at or before the instant, and averages the types", () => {
  const price = spotPricer([
    { AvailabilityZone: "us-east-2a", InstanceType: "m7a.2xlarge", SpotPrice: "0.20", Timestamp: "2026-09-29T00:00:00Z" },
    { AvailabilityZone: "us-east-2a", InstanceType: "m7a.2xlarge", SpotPrice: "0.40", Timestamp: "2026-09-29T12:00:00Z" },
    { AvailabilityZone: "us-east-2a", InstanceType: "m6a.2xlarge", SpotPrice: "0.10", Timestamp: "2026-09-29T00:00:00Z" },
  ]);
  assert.equal(price("us-east-2a", Date.parse("2026-09-29T11:00:00Z")).toFixed(2), "0.15");
  assert.equal(price("us-east-2a", Date.parse("2026-09-29T13:00:00Z")).toFixed(2), "0.25");
  assert.equal(price("us-east-2a", Date.parse("2026-09-28T13:00:00Z")), null, "no price yet");
  assert.equal(price("us-east-2b", T0), null);
  assert.equal(price("us-east-2a", Date.parse("2026-09-29T13:00:00Z"), ["m6a.2xlarge"]).toFixed(2), "0.10");
});

test("bottom-up prices every host-hour and never counts an unpriced hour as free", () => {
  const j = fleetJob(job(H, 1, 0, 60));
  const { hosts } = placeHosts(splitHosts([j], { splitGapMs: 5 * MIN }), { idleMs: 0, defaultStartupMs: 0 });
  const priced = bottomUp(hosts, () => 0.2, { extrasPerHour: 0.02 });
  assert.equal(priced.byDayRegion.get("2026-09-29@us-east-2").toFixed(3), "0.220");
  const unpriced = bottomUp(hosts, () => null, { extrasPerHour: 0.02 });
  assert.equal(unpriced.unpricedHours, 1);
});

test("untagged CI-like spend picks copies, snapshots and IPv4, and leaves the rest", () => {
  const u = untaggedByDay(ce({ "2026-09-29": { "USE1-EUN1-AWS-Out-Bytes": 2, "EUN1-EBS:SnapshotUsage": 1, "NatGateway-Hours": 5, "USE1-PublicIPv4:InUseAddress": 0.5 } }));
  assert.equal(u.get("2026-09-29").usd, 3.5);
});

test("listRuns halves a window that fills, so a busy hour is not cut at 1000", async () => {
  // 1500 runs in one hour: the API returns at most 10 pages for one query.
  const all = Array.from({ length: 1500 }, (_, i) => ({ id: i, created: T0 + i * 2000 }));
  const asked = [];
  const gh = async (p) => {
    const m = /created=([^.]+)\.\.([^&]+)&per_page=100&page=(\d+)/.exec(p);
    const [a, b, page] = [Date.parse(m[1]), Date.parse(m[2]), Number(m[3])];
    asked.push(p);
    const hit = all.filter((r) => r.created >= a && r.created <= b).slice(0, 1000);
    return { workflow_runs: hit.slice((page - 1) * 100, page * 100) };
  };
  const runs = await listRuns(gh, "o/r", T0, T0 + 3_600_000);
  assert.equal(new Set(runs.map((r) => r.id)).size, 1500);
  assert.equal(runs.length, 1500, "no run listed twice");
});

test("a bulk read pauses until the reset once under 40% of the allowance is left", () => {
  const now = 1_000_000;
  const h = (left) => new Map([["x-ratelimit-remaining", String(left)], ["x-ratelimit-limit", "5000"], ["x-ratelimit-reset", String(now / 1000 + 60)]]);
  assert.equal(quotaPauseMs(h(2001), { now }), 0);
  assert.equal(quotaPauseMs(h(1999), { now }), 61_000);
  assert.equal(quotaPauseMs(new Map(), { now }), 0, "no headers, no pause");
});

test("the whole report renders, rolls up and writes CSV", () => {
  const jobs = [job(H, 1, 0, 10), job(H, 2, 0, 5, { name: "Lint" })];
  const r = report(jobs, {
    costs: ce({ "2026-09-29": { "us-east-2": 1 } }),
    spot: { SpotPriceHistory: [{ AvailabilityZone: "us-east-2a", InstanceType: "m7a.2xlarge", SpotPrice: "0.2", Timestamp: "2026-09-29T00:00:00Z" }] },
    untagged: ce({ "2026-09-29": { "EUN1-EBS:SnapshotUsage": 0.3 } }),
    lanes: [{ lane: "unit", match: "unit" }],
    since: "2026-09-29", until: "2026-09-29",
  });
  const md = render(r, { repo: "o/r", since: "2026-09-29", until: "2026-09-29", label: "fleet" });
  assert.match(md, /## Per lane/);
  assert.match(md, /\| unit \| 1 \| 10 \|/);
  assert.match(md, /## Not matched by a lane rule \(`other`\)\n\n\| group \|[^\n]*\n\|---[^\n]*\n\| CI \/ Lint \|/);
  assert.match(md, /"self_hosted":\d\.\d{4}/);
  assert.deepEqual(rollup(r.rows, ["lane"]).map((x) => x.lane).sort(), ["other", "unit"]);
  const csv = toCsv(r.rows).trim().split("\n");
  assert.equal(csv[0], "day,region,workflow,lane,group,shard,jobs,minutes,usd");
  assert.equal(csv.length, 3);
  const sum = r.rows.reduce((a, x) => a + x.usd, 0) + r.days[0].startupUsd + r.days[0].betweenUsd + r.days[0].tailUsd + r.days[0].unusedUsd;
  assert.equal(sum.toFixed(6), "1.000000", "job USD + overhead = the tagged cost");
});

test("boot ends at the host's first job on ANY slot; a slot idle after that is not startup", () => {
  // Slot 1 runs 0–180; slot 2's first job starts at 170, with a 3-minute boot.
  const jobs = [job(H, 1, 0, 180), job(H, 2, 170, 175)].map(fleetJob);
  const { hosts } = placeHosts(splitHosts(jobs, { splitGapMs: 5 * MIN }), { idleMs: 0, defaultStartupMs: 3 * MIN });
  const pieces = slotPieces(hosts, { slots: 2 });
  const by = (k) => pieces.filter((p) => p.kind === k).reduce((a, p) => a + p.ms, 0) / MIN;
  assert.equal(by("startup"), 6, "3 minutes of boot on each of the two slots");
  assert.equal(by("between"), 170, "slot 2 idle 0–170 on a running host");
  assert.equal(by("tail"), 5, "slot 2 after its job, until the host stops at 180");
});

test("a job that crossed midnight is one job in a roll-up, not two", () => {
  const T = Date.parse("2026-09-29T23:50:00Z");
  const j = fleetJob({ ...job(H, 1, 0, 0), started_at: new Date(T).toISOString(), completed_at: new Date(T + 20 * MIN).toISOString() });
  const { hosts } = placeHosts(splitHosts([j], { splitGapMs: 5 * MIN }), { idleMs: 0, defaultStartupMs: 0 });
  const costs = costsByDayRegion(ce({ "2026-09-29": { "us-east-2": 1 }, "2026-09-30": { "us-east-2": 1 } }));
  const { rows } = attribute(slotPieces(hosts, { slots: 1 }), costs);
  assert.equal(rows.length, 2, "one row per day");
  assert.equal(rollup(rows, ["lane"])[0].jobs, 1);
});

test("a job with no measurable time is still counted", () => {
  const jobs = [job(H, 1, 0, 10), job(H, 1, 2, 3), job(H, 1, 10, 10)].map(fleetJob); // nested, then zero-length
  const { hosts } = placeHosts(splitHosts(jobs, { splitGapMs: 5 * MIN }), { idleMs: 0, defaultStartupMs: 0 });
  const { rows } = attribute(slotPieces(hosts, { slots: 1 }), costsByDayRegion(ce({ "2026-09-29": { "us-east-2": 1 } })));
  assert.equal(rollup(rows, ["lane"])[0].jobs, 3);
});

test("cost under no region is unattributed on every day, pooled or not", () => {
  const plain = [job(H, 1, 0, 10)].map(fleetJob);
  const pooled = [job(H, 1, 0, 10), job("ip-10-0-0-9", 1, 0, 10)].map(fleetJob);
  for (const jobs of [plain, pooled]) {
    const { hosts } = placeHosts(splitHosts(jobs, { splitGapMs: 5 * MIN }), { idleMs: 0, defaultStartupMs: 0 });
    const { days } = attribute(slotPieces(hosts, { slots: 1 }), costsByDayRegion(ce({ "2026-09-29": { "us-east-2": 1, global: 0.5 } })));
    assert.equal(days[0].unattributed, 0.5);
  }
});

test("a lane name with a backslash before a pipe cannot unescape it", () => {
  const r = report([job(H, 1, 0, 10)], {
    costs: ce({ "2026-09-29": { "us-east-2": 1 } }), lanes: [{ lane: "a\\|b", match: "unit" }],
    since: "2026-09-29", until: "2026-09-29",
  });
  assert.ok(render(r, { repo: "o/r", since: "2026-09-29", until: "2026-09-29", label: "fleet" }).includes("| a\\\\\\|b | 1 |"));
});

test("a lane name with a pipe does not break the table", () => {
  const r = report([job(H, 1, 0, 10)], {
    costs: ce({ "2026-09-29": { "us-east-2": 1 } }), lanes: [{ lane: "a|b", match: "unit" }],
    since: "2026-09-29", until: "2026-09-29",
  });
  assert.match(render(r, { repo: "o/r", since: "2026-09-29", until: "2026-09-29", label: "fleet" }), /\| a\\\|b \| 1 \|/);
});

test("the cache keeps only what it is told is settled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-cost-"));
  try {
    await cached(dir, "a.json", () => false, async () => [1]);
    assert.equal(existsSync(path.join(dir, "a.json")), false);
    await cached(dir, "b.json", () => true, async () => [1]);
    assert.deepEqual(await cached(dir, "b.json", () => true, async () => [2]), [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collection reads the day before `since`, and every log of a lifetime with an unread end", async () => {
  // Run 1 was created at 23:55 the day before; its job ran after midnight.
  // Runs 1 and 2 share a runner key with no gap; the first job's log has no
  // usage line, the last one's does, so the middle one must be read too.
  const runs = {
    "2026-09-28": [{ id: 1, name: "CI", created_at: "2026-09-28T23:55:00Z" }],
    "2026-09-29": [{ id: 2, name: "CI", created_at: "2026-09-29T00:20:00Z" }],
  };
  const jobOf = (id, run, from, to) => ({ id, run_id: run, name: "Lint", labels: ["fleet"], runner_name: `${H}-1-1790575022`, conclusion: "success", started_at: from, completed_at: to });
  const jobs = {
    1: [jobOf(11, 1, "2026-09-29T00:05:00Z", "2026-09-29T00:10:00Z"), jobOf(12, 1, "2026-09-29T00:11:00Z", "2026-09-29T00:15:00Z")],
    2: [jobOf(21, 2, "2026-09-29T00:21:00Z", "2026-09-29T00:30:00Z")],
  };
  const logs = { 21: `ci-runner-usage {"hostBootS":${Date.parse("2026-09-29T00:01:00Z") / 1000}}` };
  const asked = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push(u.pathname);
    const json = (v) => new Response(JSON.stringify(v), { status: 200 });
    let m = /\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
    if (m) return json({ jobs: jobs[m[1]] ?? [] });
    m = /\/actions\/jobs\/(\d+)\/logs$/.exec(u.pathname);
    if (m) return new Response(logs[m[1]] ?? "no usage line", { status: 200 });
    const created = u.searchParams.get("created");
    const day = created.slice(0, 10);
    const hour = created.slice(11, 13);
    const list = (runs[day] ?? []).filter((r) => r.created_at.slice(11, 13) === hour);
    return json({ workflow_runs: u.searchParams.get("page") === "1" ? list : [] });
  };
  try {
    const got = await collectFleetJobs({ repo: "o/r", since: "2026-09-29", until: "2026-09-29", label: "fleet", token: "t", splitGapMs: 5 * MIN });
    assert.deepEqual(got.map((j) => j.id).sort(), [11, 12, 21], "run 1, created the day before, is included");
    assert.ok(asked.includes("/repos/o/r/actions/jobs/12/logs"), "the middle job of a lifetime with one unread end is read");
  } finally {
    globalThis.fetch = saved;
  }
});

test("the counts the report prints are the window's, not the day collected before it", () => {
  const before = { ...job("us-east-2a-ip-10-0-0-7", 1, 0, 0), started_at: "2026-09-28T10:00:00Z", completed_at: "2026-09-28T10:10:00Z" };
  const r = report([job(H, 1, 0, 10), before], {
    costs: ce({ "2026-09-29": { "us-east-2": 1 } }), since: "2026-09-29", until: "2026-09-29",
  });
  assert.equal(r.jobs, 1);
  assert.equal(r.hosts, 1);
  const edge = { ...job("us-east-2b-ip-10-0-0-8", 1, 0, 0), started_at: "2026-09-29T00:00:00Z", completed_at: "2026-09-29T00:00:00Z" };
  const e = report([edge], { costs: ce({ "2026-09-29": { "us-east-2": 1 } }), since: "2026-09-29", until: "2026-09-29" });
  assert.equal(e.jobs, 1, "a zero-length job at the window's first instant is in the header and the tables alike");
  assert.equal(rollup(e.rows, ["lane"])[0].jobs, 1);
});

test("the per-workflow roll-up folds a PR number or a commit out of the workflow's name", () => {
  const jobs = [
    job(H, 1, 0, 10, { workflow: "Code Quality: PR #2123" }),
    job(H, 2, 0, 10, { workflow: "Code Quality: PR #2124" }),
    job(H, 1, 11, 15, { workflow: `Post-CD Tests — prod @ ${"b2".repeat(20)}` }),
  ];
  const r = report(jobs, { costs: ce({ "2026-09-29": { "us-east-2": 1 } }), since: "2026-09-29", until: "2026-09-29" });
  assert.deepEqual(rollup(r.rows, ["workflow"]).map((x) => [x.workflow, x.jobs]).sort(), [
    ["Code Quality: PR ##", 2], ["Post-CD Tests — prod @ <sha>", 1],
  ]);
});
