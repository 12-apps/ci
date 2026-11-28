import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIONS, actionOf, actionsByDay, anomalies, awsFromFile, category, costPerAction, countedAction, defaultUntil, diskChanges, disksInEffect, costByDay, offHours, runsWithJobs, reduceUsage, regionOf, renderHtml, taggedByDay, windowDays, windowUtilization } from "../daily-report.mjs";

// The report is read as a phone notification and turned into tickets. A day
// off by one, a cost filed under the wrong category or a rule that never fires
// sends someone after the wrong thing, or after nothing.

test("windowDays: the n UTC days before until, oldest first, until excluded", () => {
  assert.deepEqual(windowDays("2026-10-03", 3), ["2026-09-30", "2026-10-01", "2026-10-02"]);
});

test("the default window leaves out yesterday and today, and keeps the day before yesterday", () => {
  // A run at 02:04 in Brasília on 2026-11-28 is 05:04 UTC the same day.
  for (const now of ["2026-11-28T05:04:00Z", "2026-11-28T00:00:00Z", "2026-11-28T23:59:59Z"]) {
    const days = windowDays(defaultUntil(Date.parse(now)), 7);
    assert.equal(days.at(-1), "2026-11-26", now);
    assert.equal(days[0], "2026-11-20", now);
    assert.ok(!days.includes("2026-11-27") && !days.includes("2026-11-28"), now);
  }
});

test("category and regionOf read Cost Explorer's usage types", () => {
  assert.equal(category("EUN1-SpotUsage:m7a.2xlarge"), "spot");
  assert.equal(category("BoxUsage:m7a.2xlarge"), "on-demand");
  assert.equal(category("EUN1-EBS:VolumeP-IOPS.gp3"), "ebs-iops");
  assert.equal(category("USE2-EBS:VolumeP-Throughput.gp3"), "ebs-throughput");
  assert.equal(category("EBS:VolumeUsage.gp3"), "ebs-storage");
  assert.equal(category("USE2-EBS:SnapshotUsage"), "snapshots-images");
  assert.equal(category("EUN1-NatGateway-Hours"), "nat");
  assert.equal(category("EUN1-DataTransfer-Out-Bytes"), "egress");
  assert.equal(category("EUN1-PublicIPv4:InUseAddress"), "public-ip");
  assert.equal(regionOf("EUN1-SpotUsage:m7a.2xlarge"), "EUN1");
  assert.equal(regionOf("SpotUsage:m7a.2xlarge"), "USE1");
});

const g = (service, usage, amount) => ({ Keys: [service, usage], Metrics: { UnblendedCost: { Amount: String(amount) } } });

test("costByDay takes Tax, Route 53 and the baseline out of CI cost", () => {
  const ce = {
    ResultsByTime: [
      {
        TimePeriod: { Start: "2026-10-01" },
        Estimated: true,
        Groups: [g("Tax", "NoUsageType", 6.72), g("Amazon Route 53", "HostedZone", 1), g("Amazon Elastic Compute Cloud - Compute", "EUN1-SpotUsage:m7a.2xlarge", 18), g("EC2 - Other", "EUN1-EBS:VolumeP-IOPS.gp3", 2)],
      },
    ],
  };
  const d = costByDay(ce, { baseline: 0.5 })["2026-10-01"];
  assert.equal(d.estimated, true);
  assert.equal(Math.round(d.account * 100), 2772);
  assert.equal(d.ci, 19.5);
  assert.deepEqual(d.categories, { spot: 18, "ebs-iops": 2 });
  assert.equal(taggedByDay({ ResultsByTime: [{ TimePeriod: { Start: "x" }, Groups: [g("eu-north-1", "", 3), g("us-east-1", "", 1)] }] }).x, 4);
});

test("offHours is local time, wrapping midnight", () => {
  assert.equal(offHours("2026-10-02T03:44:00Z"), true); // 00:44 in Brasília
  assert.equal(offHours("2026-10-02T15:00:00Z"), false); // noon
  assert.equal(offHours("2026-10-02T01:30:00Z"), true); // 22:30 the day before
  assert.equal(offHours("2026-10-02T10:30:00Z"), false); // 07:30
});

const day = (d, extra = {}) => ({
  day: d,
  pushes: 100,
  merges: 40,
  cost: { ci: 20, account: 21, categories: { spot: 10, "ebs-storage": 3 } },
  perPush: 0.2,
  perMerge: 0.5,
  usage: { jobs: [], idle: { paidHours: 100, runningHours: 50, runningShare: 0.5, shares: {} } },
  ...extra,
});
const tpl = (region, iops = 3000, throughput = 250, changes = []) => ({ region, version: 1, disk: { type: "gp3", iops, throughput, size: 64 }, changes });
const keys = (r, opts) => anomalies(r, opts).map((a) => `${a.severity}:${a.key}`);

test("a quiet week inside the budget flags nothing", () => {
  const r = { days: ["01", "02", "03", "04", "05", "06", "07"].map((d) => day(`2026-10-${d}`, { cost: { ci: 3, categories: { spot: 2 } }, perPush: 0.03 })), templates: [tpl("us-east-1"), tpl("eu-north-1")], dispatches: [] };
  assert.deepEqual(keys(r), []);
});

test("the rules fire on the week of 2026-09-26: run rate, spot growth, IOPS, disk raise, night dispatches", () => {
  const spot = [5.7, 6, 6.5, 6, 17, 18, 18.9];
  const dates = windowDays("2026-10-03", 7);
  const days = spot.map((s, i) =>
    day(dates[i], {
      cost: { ci: s + 5, categories: { spot: s, "ebs-iops": i === 4 ? 1.2 : 0 } },
      perPush: i === 2 ? 0.6 : 0.2,
      usage: {
        jobs: [{ group: "CI / Unit", runs: 30, p50: i === 6 ? 5 : 3, ioWaitP95: 20, mibpsP95: i === 4 ? 340 : 240, oom: 0 }],
        idle: { paidHours: i === 5 ? 320 : 150, runningHours: i === 5 ? 100 : 75, runningShare: i === 5 ? 0.31 : 0.5, shares: {} },
      },
    }),
  );
  // 3000/250 from before the window; raised on the last day.
  const changes = [
    { at: "2026-09-25T15:50:53Z", version: 15, by: "refresh", disk: { iops: 3000, throughput: 250 }, previousDisk: { iops: 6000, throughput: 500 } },
    { at: "2026-10-02T17:13:38Z", version: 16, by: "provisioner", disk: { iops: 6000, throughput: 500 }, previousDisk: { iops: 3000, throughput: 250 } },
  ];
  const dispatches = [1, 2, 3].map((i) => ({ id: i, branch: "ci/hang", actor: "a", started: `2026-10-02T0${i + 2}:44:00Z`, conclusion: "failure", jobMinutes: 240, wallMinutes: 60 }));
  const found = keys({ days, templates: [tpl("us-east-1"), tpl("eu-north-1", 6000, 500, changes)], dispatches });
  for (const k of [
    "ticket:budget",
    "ticket:per-push-2026-09-28",
    "ticket:growth-spot",
    "ticket:iops-unprovisioned",
    "ticket:throughput-above-template",
    "ticket:template-disk-raised",
    "ticket:utilization",
    "watch:slot-hours-2026-10-01",
    "watch:slower-jobs",
    "ticket:night-dispatch",
  ]) {
    assert.ok(found.includes(k), `${k} missing from ${found.join(", ")}`);
  }
  assert.ok(found.indexOf("watch:slower-jobs") > found.indexOf("ticket:budget"), "tickets come first");
  assert.ok(!found.includes("ticket:dispatch-loop-2026-10-02 ci/hang"), "night runs are named once, by the night finding");
  const day3 = [10, 13, 16].map((h, i) => ({ id: i, branch: "ci/hang", actor: "a", started: `2026-10-02T${h}:00:00Z`, conclusion: "failure", jobMinutes: 100, wallMinutes: 30 }));
  assert.ok(keys({ days, templates: [tpl("us-east-1")], dispatches: day3 }).includes("ticket:dispatch-loop-2026-10-02 ci/hang"), "three daytime runs on one branch are a loop");
});

test("a disk the template provisioned that day explains its IOPS and throughput", () => {
  const changes = [
    { at: "2026-09-25T00:00:00Z", version: 1, by: "x", disk: { iops: 3000, throughput: 250 }, previousDisk: { iops: 3000, throughput: 125 } },
    { at: "2026-10-01T17:13:00Z", version: 2, by: "x", disk: { iops: 6000, throughput: 500 }, previousDisk: { iops: 3000, throughput: 250 } },
    { at: "2026-10-02T18:06:00Z", version: 3, by: "x", disk: { iops: 3000, throughput: 250 }, previousDisk: { iops: 6000, throughput: 500 } },
  ];
  const t = [tpl("eu-north-1", 3000, 250, changes)];
  assert.deepEqual(disksInEffect(t, "2026-09-30").map((d) => d.iops), [3000]);
  assert.deepEqual(disksInEffect(t, "2026-10-01").map((d) => d.iops), [3000, 6000]);
  assert.deepEqual(disksInEffect(t, "2026-10-02").map((d) => d.iops), [6000, 3000]);
  assert.equal(disksInEffect([tpl("x", 3000, 250, [changes[1]].map((c) => ({ ...c, previousDisk: null })))], "2026-09-30"), null, "unknown before the first change");
  const d = day("2026-10-02", { cost: { ci: 1, categories: { "ebs-iops": 2 } }, usage: { jobs: [{ group: "g", runs: 9, mibpsP95: 480 }], idle: { paidHours: 0 } } });
  const found = keys({ days: [d], templates: t, dispatches: [] });
  assert.ok(!found.includes("ticket:iops-unprovisioned") && !found.includes("ticket:throughput-above-template"), found.join(", "));
  assert.ok(found.includes("ticket:template-disk-raised"));
});

test("weekend per-push cost and egress that already stopped are not findings", () => {
  const dates = windowDays("2026-10-03", 7);
  const days = dates.map((d, i) =>
    day(d, { pushes: i < 2 ? 70 : 190, perPush: i < 2 ? 0.3 : 0.12, cost: { ci: 20, categories: { spot: 15, egress: i < 4 ? 8 : 0 } } }),
  );
  const found = keys({ days, templates: [tpl("us-east-1")], dispatches: [] });
  assert.ok(!found.some((k) => k.startsWith("ticket:per-push") || k === "ticket:egress"), found.join(", "));
});

// Cost per action. On 2026-11-26 nine full suites ran on main, and the one
// cost per merge read US$ 0.33 while the merges' own share was ~US$ 0.28.
const run = (id, path, event, created = "2026-11-26T10:00:00Z", workflow_id = path) => ({ id, path: `.github/workflows/${path}`, event, created_at: created, workflow_id, conclusion: "success" });
const job = (name, start, minutes, { runner = "eu-north-1b-ip-1-1", labels = ["future-pay-ci"] } = {}) => ({
  name,
  runner_name: runner,
  labels,
  started_at: start,
  completed_at: new Date(Date.parse(start) + minutes * 60000).toISOString(),
});

test("actionOf: a pull request and its push are a merge, the dispatched suite and its gate a suite, CD and its smoke a deploy", () => {
  assert.equal(actionOf(run(1, "ci.yml", "pull_request")), "merge");
  assert.equal(actionOf(run(2, "post-merge-regen.yml", "push")), "merge");
  assert.equal(actionOf(run(3, "commitlint-enforce.yml", "pull_request_target")), "merge");
  assert.equal(actionOf(run(4, "ci.yml", "workflow_dispatch")), "suite");
  assert.equal(actionOf(run(5, "full-suite.yml", "schedule")), "suite");
  assert.equal(actionOf(run(6, "cd.yml", "workflow_dispatch")), "deploy");
  assert.equal(actionOf(run(7, "qa-cd.yml", "schedule")), "deploy");
  assert.equal(actionOf(run(8, "post-cd.yml", "workflow_dispatch")), "deploy");
  assert.equal(actionOf(run(9, "memory-tighten.yml", "schedule")), "other");
  assert.equal(actionOf(run(10, "runner-image-refresh.yml", "workflow_dispatch")), "other");
  assert.equal(actionOf(run(11, "my-ci.yml", "workflow_dispatch"), { workflow: "my-ci.yml" }), "suite");
  // Only a suite run and a rollout are counted; the gate and the smoke ride along.
  assert.equal(countedAction(run(4, "ci.yml", "workflow_dispatch")), "suite");
  assert.equal(countedAction(run(5, "full-suite.yml", "schedule")), null);
  assert.equal(countedAction(run(8, "post-cd.yml", "workflow_dispatch")), null);
  assert.equal(countedAction(run(7, "qa-cd.yml", "schedule")), "deploy");
});

test("actionsByDay counts a re-run's copied jobs once, leaves out GitHub's runners, and files a job by its start", () => {
  const suite = {
    run: run(1, "ci.yml", "workflow_dispatch", "2026-11-26T23:50:00Z"),
    jobs: [
      job("Unit 1/2", "2026-11-26T23:55:00Z", 10),
      job("Unit 1/2", "2026-11-26T23:55:00Z", 10), // attempt 2's copy of the passed job
      job("Unit 2/2", "2026-11-27T00:10:00Z", 20), // re-run on the next day
      job("Unit 2/2", "2026-11-26T23:55:00Z", 5), // attempt 1's failure: real work, counted
    ],
  };
  const pr = {
    run: run(2, "ci.yml", "pull_request"),
    jobs: [
      job("Lint", "2026-11-26T10:00:00Z", 3, { labels: ["future-pay-ci-medium"] }),
      job("Commit message", "2026-11-26T10:00:00Z", 1, { labels: ["ubuntu-latest"] }),
      job("Cancelled before a runner", "2026-11-26T10:00:00Z", 7, { runner: null }),
      { ...job("Skipped", "2026-11-26T10:05:00Z", 0), completed_at: "2026-11-26T10:04:00Z" },
    ],
  };
  const deploy = { run: run(3, "qa-cd.yml", "schedule", "2026-11-26T08:07:00Z"), jobs: [job("Build image", "2026-11-26T08:08:00Z", 12)] };
  const { minutes, counts } = actionsByDay([suite, pr, deploy], { label: "future-pay-ci" });
  assert.deepEqual(minutes["2026-11-26"], { suite: 15, merge: 3, deploy: 12 });
  assert.deepEqual(minutes["2026-11-27"], { suite: 20 });
  assert.deepEqual(counts, { "2026-11-26": { suite: 1, deploy: 1 } });
});

test("costPerAction splits the day's cost by fleet minutes and averages each share over its own count", () => {
  const a = costPerAction({ ci: 37.18, minutes: { merge: 8000, suite: 3200, deploy: 400, other: 400 }, counts: { merge: 111, suite: 9, deploy: 2 } });
  const shares = ACTIONS.reduce((s, k) => s + a[k].cost, 0);
  assert.ok(Math.abs(shares - 37.18) < 1e-9, "the shares add up to the day's cost");
  assert.ok(Math.abs(a.merge.per - (37.18 * 8000) / 12000 / 111) < 1e-9);
  assert.ok(Math.abs(a.suite.per - (37.18 * 3200) / 12000 / 9) < 1e-9);
  assert.equal(a.other.count, null);
  assert.equal(a.other.per, null, "upkeep is shown, never averaged");
  const none = costPerAction({ ci: 5, minutes: {}, counts: { merge: 3 } });
  assert.equal(none.merge.cost, null, "no fleet minutes, nothing to split by");
  assert.equal(costPerAction({ ci: 5, minutes: { merge: 10, suite: 2 }, counts: { merge: 0, suite: 0 } }).merge.per, null, "a day with no merge has no cost per merge");
});

test("runsWithJobs reads every suite and deploy, samples the rest evenly, and weighs the sample up to the whole", async () => {
  // 40 pull request runs of 4 fleet minutes each, 10 of them sampled: the
  // merges' minutes are estimated at 40 × 4 = 160, from 10 calls, not 40.
  const prs = Array.from({ length: 40 }, (_, i) => run(100 + i, "ci.yml", "pull_request", "2026-11-26T10:00:00Z", "ci"));
  const listed = [
    ...prs,
    run(300, "ci.yml", "workflow_dispatch", "2026-11-26T11:00:00Z", "ci"),
    run(301, "ci.yml", "workflow_dispatch", "2026-11-26T12:00:00Z", "ci"),
    run(400, "qa-cd.yml", "schedule", "2026-11-26T08:07:00Z", "qa"),
    { ...run(500, "ci.yml", "pull_request", "2026-11-26T11:00:00Z", "ci"), conclusion: "skipped" },
  ];
  const read = [];
  const minutesOf = { 300: 400, 301: 300, 400: 30 };
  const out = await runsWithJobs({
    listDay: async (from) => (from.startsWith("2026-11-26") ? listed : []),
    jobsOf: async (r) => {
      read.push(r.id);
      return [job("work", "2026-11-26T12:00:00Z", minutesOf[r.id] ?? 4)];
    },
    days: ["2026-11-26"],
    until: "2026-11-27",
    sample: 10,
  });
  const prRead = read.filter((id) => id >= 100 && id < 200).sort((a, b) => a - b);
  assert.equal(prRead.length, 10, "ten of the forty pull request runs");
  assert.deepEqual(prRead, [100, 104, 108, 112, 116, 120, 124, 128, 132, 136], "spread over the day's list, not its first ten");
  assert.ok([300, 301, 400].every((id) => read.includes(id)), "every suite and deploy run is read");
  assert.ok(!read.includes(500) && !out.some(({ run: r }) => r.id === 500), "a skipped run is neither read nor kept");
  assert.equal(out.length, 43, "the unread runs are kept with no jobs, so a count among them is not lost");
  const { counts, minutes } = actionsByDay(out, { label: "future-pay-ci" });
  assert.deepEqual(counts["2026-11-26"], { suite: 2, deploy: 1 });
  assert.equal(minutes["2026-11-26"].merge, 160, "10 sampled runs × 4 min × weight 4");
  assert.equal(minutes["2026-11-26"].suite, 700, "suites are exact");
  assert.equal(minutes["2026-11-26"].deploy, 30, "deploys are exact");

  read.length = 0;
  await runsWithJobs({ listDay: async () => prs, jobsOf: async (r) => (read.push(r.id), []), days: ["2026-11-26"], until: "2026-11-27", sample: Infinity });
  assert.equal(read.length, 80, "sample Infinity reads every run, on both listed days");
});

test("renderHtml shows the cost per merge, per suite and per deploy, and keeps one cost per merge without them", () => {
  const base = { repo: "o/r", until: "2026-11-27", generated: "2026-11-27T05:00:00Z", window: "14:00–17:00", workflow: "ci.yml", baseline: 0.69, budget: 100, offset: -3, templates: [tpl("us-east-1")], dispatches: [], anomalies: [] };
  const actions = costPerAction({ ci: 20, minutes: { merge: 600, suite: 300, deploy: 60, other: 40 }, counts: { merge: 40, suite: 2, deploy: 1 } });
  const html = renderHtml({ ...base, days: [day("2026-11-26", { actions })] });
  assert.ok(html.includes("por suíte completa") && html.includes("por deploy"), "the three KPIs");
  assert.ok(html.includes("US$ 0,30"), "per merge is the merges' share: 20 × 600/1000 / 40");
  assert.ok(html.includes("US$ 3,00") && html.includes("US$ 1,20"), "per suite 20 × 300/1000 / 2, per deploy 20 × 60/1000 / 1");
  assert.ok(html.includes("repeat(5, 1fr)"));
  const old = renderHtml({ ...base, days: [day("2026-11-26")] });
  assert.ok(old.includes("por push de PR") && !old.includes("por suíte completa") && old.includes("repeat(4, 1fr)"), "a report without actions keeps its old shape");
});

test("regions handing out different disks is drift", () => {
  const r = { days: [day("2026-10-01")], templates: [tpl("us-east-1"), tpl("eu-north-1", 6000, 500)], dispatches: [] };
  assert.ok(keys(r).includes("ticket:template-drift"));
});

test("reduceUsage keeps what the report shows, and renderHtml prints every section", () => {
  const usage = { runner: "eu-north-1b-ip-1-2-3-4-1-1790575022", hostBootS: 1000, startMs: 1_060_000, wallMs: 600_000, peakWorkingSetMiB: 1000, ioWaitPct: 12, peakDiskMiBps: 200, oomKills: 0 };
  const u = reduceUsage({ runs: 1, jobs: 1, records: [{ group: "CI / Unit", usage, startedMs: 1_060_000, queuedMs: 4000 }] }, { from: 0, to: 10_000_000 });
  assert.equal(u.jobs[0].p50, 10);
  assert.equal(u.jobs[0].mibpsP95, 200);
  assert.equal(u.queueP50s, 4);
  assert.ok(u.idle.paidHours > 0 && u.idle.runningShare > 0 && u.idle.runningShare < 1);

  const dispatches = [{ id: 1, branch: "main", actor: "a", started: "2026-10-02T03:44:00Z", conclusion: "failure", jobMinutes: 200, wallMinutes: 40 }];
  const r = { repo: "o/r", until: "2026-10-03", generated: "2026-10-03T19:23:00Z", window: "14:00–17:00", workflow: "ci.yml", baseline: 0.69, budget: 100, offset: -3, templates: [tpl("us-east-1")], days: [day("2026-10-02", { usage: u })], dispatches, anomalies: [{ severity: "ticket", key: "k", title: "<b>x</b>", why: "porque", evidence: "e" }] };
  const html = renderHtml(r);
  for (const h of ["gasto em 7 dias", "Gasto por dia", "O que investigar", "Dia a dia", "Custo por merge", "Para onde foi o dinheiro", "tempo pago das máquinas", "Jobs mais pesados", "Disco das máquinas", "Suítes completas disparadas"]) {
    assert.ok(html.includes(h), h);
  }
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;") && !html.includes("<b>x</b>"), "finding text is escaped");
  assert.ok(html.includes("porque"), "the finding's why is printed");
  assert.ok(html.includes("gerado em 03/10 16:23"), "times are local");
  assert.ok(html.includes("02/10 00:44") && html.includes("madrugada"), "an off-hours dispatch is marked");
  assert.ok(html.includes("US$ 20,00"), "money is written the Brazilian way");
});

test("windowUtilization cuts hosts and jobs to the window, so a host busy all morning is not idle", () => {
  const H = 3_600_000;
  const at = (h) => Date.parse("2026-10-01T00:00:00Z") + h * H;
  const job = (slot, start, hours, boot = at(9)) => ({ usage: { runner: `eu-north-1b-ip-1-2-3-4-${slot}-1790575022`, hostBootS: boot / 1000, startMs: start, wallMs: hours * H } });
  // Booted at 09:00, both slots busy 09:00–17:00 in back-to-back one-hour jobs.
  const records = [1, 2].flatMap((slot) => Array.from({ length: 8 }, (_, i) => job(slot, at(9 + i), 1)));
  const inWindow = windowUtilization(records, at(14), at(17));
  assert.equal(inWindow.paidHours, 6, "2 slots × 3 h of window, not 2 × 8 h since boot");
  assert.ok(Math.abs(inWindow.runningShare - 1) < 0.01, "busy the whole window");
  // The same host as the old sampling saw it: only jobs from runs created in the window.
  const sampled = records.filter((r) => r.usage.startMs >= at(14));
  assert.ok(windowUtilization(sampled, at(14), at(17)).runningShare > 0.99, "the cut no longer charges the morning to the window");
  // Half idle: one slot ran nothing after 15:00, the host stayed up for the other.
  const half = [job(1, at(14), 1), job(2, at(14), 3)];
  assert.equal(Math.round(100 * windowUtilization(half, at(14), at(17)).runningShare), 67);
});

test("diskChanges folds one deploy across regions and finds when it was undone", () => {
  const up = (region) => ({ at: region === "us-east-1" ? "2026-09-30T17:13:38Z" : "2026-09-30T17:14:51Z", version: 16, by: "provisioner", disk: { iops: 6000, throughput: 500 }, previousDisk: { iops: 3000, throughput: 250 } });
  const down = { at: "2026-10-01T18:06:40Z", version: 15, by: "provisioner", disk: { iops: 3000, throughput: 250 }, previousDisk: { iops: 6000, throughput: 500 } };
  const t = ["us-east-1", "eu-north-1"].map((region) => tpl(region, 3000, 250, [up(region), down]));
  const moves = diskChanges(t);
  assert.equal(moves.length, 2);
  assert.deepEqual(moves[0].regions, ["us-east-1", "eu-north-1"]);
  assert.equal(moves[0].raised, true);
  assert.equal(moves[0].back, "2026-10-01T18:06:40Z");
  assert.equal(moves[1].raised, false);
});

// --aws-only / --aws-from split the report so the AWS half can run under an
// OIDC role in a workflow and the GitHub half under a token with allowance.

const saved = { v: 1, until: "2026-10-13", days: ["2026-10-11", "2026-10-12"], baseline: 0.69, cost: { all: {}, tagged: {} }, templates: [] };

test("awsFromFile hands back the saved cost and templates for the same window", () => {
  assert.deepEqual(awsFromFile(saved, { until: "2026-10-13", days: ["2026-10-11", "2026-10-12"], baseline: 0.69 }), { cost: saved.cost, templates: [] });
});

test("awsFromFile refuses a file read for another window, naming what differs", () => {
  const want = { until: "2026-10-13", days: ["2026-10-11", "2026-10-12"], baseline: 0.69 };
  assert.throws(() => awsFromFile(saved, { ...want, until: "2026-10-14" }), /until 2026-10-13, this run wants 2026-10-14/);
  assert.throws(() => awsFromFile(saved, { ...want, days: ["2026-10-12"] }), /days/);
  assert.throws(() => awsFromFile(saved, { ...want, baseline: 1 }), /baseline/);
  assert.throws(() => awsFromFile({ ...saved, v: 2 }, want), /unknown format/);
});

test("--aws-only writes aws.json from the aws CLI alone: no GitHub token, no GitHub call", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aws-only-"));
  // A stand-in aws CLI: one Cost Explorer day, one template, no events.
  const stub = path.join(dir, "aws");
  writeFileSync(stub, `#!/usr/bin/env node
const a = process.argv.slice(2);
const day = { TimePeriod: { Start: "2026-10-12", End: "2026-10-13" }, Estimated: false,
  Groups: [{ Keys: ["Amazon Elastic Compute Cloud - Compute", "EUN1-SpotUsage:m7a.2xlarge"], Metrics: { UnblendedCost: { Amount: "3" } } }] };
const out = a[0] === "ce" ? { ResultsByTime: [day] }
  : a[0] === "ec2" ? { LaunchTemplateVersions: [{ VersionNumber: 1, DefaultVersion: true, LaunchTemplateData: { BlockDeviceMappings: [{ Ebs: { VolumeType: "gp3", Iops: 3000, Throughput: 250, VolumeSize: 64 } }] } }] }
  : { Events: [] };
process.stdout.write(JSON.stringify(out));
`);
  chmodSync(stub, 0o755);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "daily-report.mjs");
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  delete env.GITHUB_TOKEN;
  execFileSync(process.execPath, [script, "--aws-only", "--until", "2026-10-13", "--days", "1", "--regions", "eu-north-1", "--out", dir], { env, stdio: "pipe" });
  const file = JSON.parse(readFileSync(path.join(dir, "aws.json"), "utf-8"));
  assert.equal(file.v, 1);
  assert.equal(file.until, "2026-10-13");
  assert.deepEqual(file.days, ["2026-10-12"]);
  assert.equal(file.templates[0].region, "eu-north-1");
  assert.ok(file.cost.all["2026-10-12"], "the day's cost is in the file");
  // And it reads back for the same window.
  assert.ok(awsFromFile(file, { until: "2026-10-13", days: ["2026-10-12"], baseline: 0.69 }).cost);
});
