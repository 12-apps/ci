import { strict as assert } from "node:assert";
import { test } from "node:test";
import { anomalies, category, costByDay, offHours, reduceUsage, regionOf, renderHtml, taggedByDay, windowDays } from "../daily-report.mjs";

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

test("the rules fire on the week of 2026-09-26: run rate, spot growth, IOPS, disk change, night dispatches", () => {
  const spot = [5.7, 6, 6.5, 6, 17, 18, 18.9];
  const dates = windowDays("2026-10-03", 7);
  const days = spot.map((s, i) =>
    day(dates[i], {
      cost: { ci: s + 5, categories: { spot: s, "ebs-iops": i === 5 ? 1.2 : 0 } },
      perPush: i === 2 ? 0.6 : 0.2,
      usage: {
        jobs: [{ group: "CI / Unit", runs: 30, p50: i === 6 ? 5 : 3, ioWaitP95: 20, mibpsP95: i === 5 ? 340 : 240, oom: 0 }],
        idle: { paidHours: i === 5 ? 320 : 150, runningHours: i === 5 ? 100 : 75, runningShare: i === 5 ? 0.31 : 0.5, shares: {} },
      },
    }),
  );
  const changes = [
    { at: "2026-09-30T15:50:53Z", version: 15, by: "refresh", disk: { iops: 3000, throughput: 250 }, previousDisk: { iops: 6000, throughput: 500 } },
    { at: "2026-09-30T17:13:38Z", version: 16, by: "provisioner", disk: { iops: 6000, throughput: 500 }, previousDisk: { iops: 3000, throughput: 250 } },
  ];
  const dispatches = [1, 2, 3].map((i) => ({ id: i, branch: "ci/hang", actor: "a", started: `2026-10-02T0${i + 2}:44:00Z`, conclusion: "failure", jobMinutes: 240, wallMinutes: 60 }));
  const found = keys({ days, templates: [tpl("us-east-1"), tpl("eu-north-1", 3000, 250, changes)], dispatches });
  for (const k of [
    "ticket:budget",
    "ticket:per-push-2026-09-28",
    "ticket:growth-spot",
    "ticket:iops-2026-10-01",
    "ticket:throughput-above-template",
    "ticket:template-disk-changed",
    "ticket:utilization-2026-10-01",
    "watch:slot-hours-2026-10-01",
    "watch:slower-jobs",
    "ticket:night-dispatch",
    "ticket:dispatch-loop-2026-10-02 ci/hang",
  ]) {
    assert.ok(found.includes(k), `${k} missing from ${found.join(", ")}`);
  }
  assert.ok(found.indexOf("watch:slower-jobs") > found.indexOf("ticket:budget"), "tickets come first");
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

  const r = { repo: "o/r", until: "2026-10-03", generated: "now", window: "14:00–17:00", workflow: "ci.yml", baseline: 0.69, budget: 100, offset: -3, templates: [tpl("us-east-1")], days: [day("2026-10-02", { usage: u })], dispatches: [], anomalies: [{ severity: "ticket", key: "k", title: "<b>x</b>", evidence: "e" }] };
  const html = renderHtml(r);
  for (const h of ["What looks wrong", "Cost, merges and pushes per day", "AWS CI cost by category", "launch templates", "Job duration p50", "IO wait p95", "MiB/s", "Paid slot time", "Full suites dispatched"]) {
    assert.ok(html.includes(h), h);
  }
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;") && !html.includes("<b>x</b>"), "finding text is escaped");
  assert.ok(html.includes('class="ticket"'));
});
