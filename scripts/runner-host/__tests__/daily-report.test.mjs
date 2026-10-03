import { strict as assert } from "node:assert";
import { test } from "node:test";
import { anomalies, category, diskChanges, disksInEffect, costByDay, offHours, reduceUsage, regionOf, renderHtml, taggedByDay, windowDays } from "../daily-report.mjs";

// The report is read as a phone notification and turned into tickets. A day
// off by one, a cost filed under the wrong category or a rule that never fires
// sends someone after the wrong thing, or after nothing.

test("windowDays: the n UTC days before until, oldest first, until excluded", () => {
  assert.deepEqual(windowDays("2026-10-03", 3), ["2026-09-30", "2026-10-01", "2026-10-02"]);
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

test("regions handing out different disks is drift", () => {
  const r = { days: [day("2026-10-01")], templates: [tpl("us-east-1"), tpl("eu-north-1", 6000, 500)], dispatches: [] };
  assert.ok(keys(r).includes("ticket:template-drift"));
});

test("reduceUsage keeps what the report shows, and renderHtml prints every section", () => {
  const usage = { runner: "eu-north-1b-ip-1-2-3-4-1-1790575022", hostBootS: 1000, startMs: 1_060_000, wallMs: 600_000, peakWorkingSetMiB: 1000, ioWaitPct: 12, peakDiskMiBps: 200, oomKills: 0 };
  const u = reduceUsage({ runs: 1, jobs: 1, records: [{ group: "CI / Unit", usage, queuedMs: 4000 }], waiting: [] });
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
