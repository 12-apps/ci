#!/usr/bin/env node
// The fleet's last N days on one page: what CI cost, per merge and per push,
// how long the jobs took, how hard they waited on the disk, how much of the
// paid slot time ran a job, which full suites were dispatched and when, which
// disk the launch templates hand a host — and the readings that look wrong.
//
//   GITHUB_TOKEN=… node daily-report.mjs --repo owner/name [--days 7] \
//     [--until YYYY-MM-DD] [--window 14-17] [--regions us-east-1,us-east-2,eu-north-1] \
//     [--template ci-runner-fleet-future-pay-ci] [--label future-pay-ci] \
//     [--workflow ci.yml] [--budget 100] [--baseline 0.69] [--out dir] [--pdf]
//
// Writes report.json and report.html into --out (and report.pdf with --pdf,
// through a headless Chromium: CHROME_PATH, else Playwright's, else
// `chromium`). The AWS half shells out to the aws CLI, so the credentials stay
// with whoever runs it; it needs ce:GetCostAndUsage, ec2:Describe* and
// cloudtrail:LookupEvents.
//
// ## The window
//
// Days are UTC and --until is exclusive (default: today, so the last complete
// day is yesterday). Cost Explorer revises its last day or two for a while;
// those carry `estimated` and the report says so.
//
// Per-job usage is read from every fleet job's log (usage-report.mjs), one
// API call per job. A whole day is ~3000 calls and seven of them would spend
// a shared token's hourly allowance, so usage is SAMPLED: the same --window of
// UTC hours on every day (default 14–17, 11:00–14:00 in Brasília, the busiest
// stretch). Counts, cost and dispatches are whole days. Reads pause while the
// token's remaining allowance is under --reserve (default 4000).
//
// ## CI cost
//
// The account runs the fleet and little else, so CI cost is the account's
// total minus Tax (billed on the 1st of the month, all at once), minus Route
// 53, minus --baseline (what the account costs with no CI). The fleet's
// Project=ci-runner tagged cost is shown beside it; the difference is public
// addresses, snapshots, images and anything left untagged.
//
// ## What gets flagged
//
// Every rule in `anomalies()` names its evidence. `ticket` means a reading
// with no explanation in the data (a cost category that doubled, a disk
// faster than any template provisions, a suite dispatched in the middle of
// the night); `watch` means a trend worth a glance. The rules are heuristics
// over one week: a reader decides what becomes a ticket.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collect, fetchRetrying, idleBreakdown, percentile, summarizeJobs } from "./usage-report.mjs";

const DAY = 86_400_000;
const HOUR = 3_600_000;

// ── days and categories ─────────────────────────────────────────────────────

/** The `n` UTC days before `until` (exclusive), oldest first. */
export function windowDays(until, n) {
  const end = Date.parse(`${until}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(end - (n - i) * DAY).toISOString().slice(0, 10));
}

/** A Cost Explorer usage type, by what it pays for. */
export function category(usageType) {
  const t = usageType.replace(/^[A-Z]{2,4}\d?-/, "");
  if (/SpotUsage/.test(t)) return "spot";
  if (/BoxUsage|DedicatedUsage/.test(t)) return "on-demand";
  if (/VolumeP-IOPS/.test(t)) return "ebs-iops";
  if (/VolumeP-Throughput/.test(t)) return "ebs-throughput";
  if (/EBS:VolumeUsage/.test(t)) return "ebs-storage";
  if (/Snapshot|TimedStorage/.test(t)) return "snapshots-images";
  if (/NatGateway/.test(t)) return "nat";
  if (/DataTransfer-Out|AWS-Out-Bytes|DataTransfer-Regional|Out-Bytes/.test(t)) return "egress";
  if (/PublicIPv4/.test(t)) return "public-ip";
  return "other";
}

/** The region prefix of a usage type: `EUN1-SpotUsage` → `EUN1`, none → `USE1`. */
export const regionOf = (usageType) => /^([A-Z]{2,4}\d)-/.exec(usageType)?.[1] ?? "USE1";

/**
 * Per day: the account total, Tax, Route 53, CI cost and CI cost by category,
 * from `get-cost-and-usage --group-by SERVICE --group-by USAGE_TYPE`.
 */
export function costByDay(ce, { baseline = 0 } = {}) {
  const out = {};
  for (const r of ce.ResultsByTime ?? []) {
    const d = { account: 0, tax: 0, route53: 0, estimated: Boolean(r.Estimated), categories: {}, regions: {} };
    for (const g of r.Groups ?? []) {
      const [service, usage] = g.Keys;
      const amount = Number(g.Metrics.UnblendedCost.Amount);
      d.account += amount;
      if (service === "Tax") d.tax += amount;
      else if (/Route 53/.test(service)) d.route53 += amount;
      else {
        const c = category(usage);
        d.categories[c] = (d.categories[c] ?? 0) + amount;
        d.regions[regionOf(usage)] = (d.regions[regionOf(usage)] ?? 0) + amount;
      }
    }
    d.ci = Math.max(0, d.account - d.tax - d.route53 - baseline);
    out[r.TimePeriod.Start] = d;
  }
  return out;
}

/** Tagged fleet cost per day, from `--group-by REGION` with the tag filter. */
export function taggedByDay(ce) {
  const out = {};
  for (const r of ce.ResultsByTime ?? []) {
    out[r.TimePeriod.Start] = (r.Groups ?? []).reduce((a, g) => a + Number(g.Metrics.UnblendedCost.Amount), 0);
  }
  return out;
}

const median = (xs) => percentile(xs.filter(Number.isFinite), 50);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The hour of day at `iso` in a fixed UTC offset. */
export const localHour = (iso, offsetHours) => new Date(Date.parse(iso) + offsetHours * HOUR).getUTCHours();

/** Off-hours: from `from` at night to `to` in the morning, local time. */
export const offHours = (iso, { offset = -3, from = 22, to = 7 } = {}) => {
  const h = localHour(iso, offset);
  return h >= from || h < to;
};

// ── the rules ───────────────────────────────────────────────────────────────

/**
 * What looks wrong. `r` is the report (see `main`). Each finding:
 * { severity: "ticket" | "watch", key, title, evidence }.
 */
export function anomalies(r, { budget = 100, offset = -3 } = {}) {
  const out = [];
  const add = (severity, key, title, evidence) => out.push({ severity, key, title, evidence });
  const days = r.days;
  const money = (n) => `$${n.toFixed(2)}`;

  // 1. Run rate against the monthly budget.
  const ci = days.map((d) => d.cost?.ci).filter(Number.isFinite);
  if (ci.length) {
    const monthly = mean(ci) * 30;
    if (monthly > budget) {
      add(
        monthly > 1.5 * budget ? "ticket" : "watch",
        "budget",
        `Run rate ${money(monthly)}/month against a ${money(budget)} target`,
        `mean CI cost ${money(mean(ci))}/day over ${ci.length} days`,
      );
    }
  }

  // 2. A day that cost far more per push than the week.
  const perPush = days.map((d) => d.perPush);
  const mPush = median(perPush);
  for (const d of days) {
    if (mPush && d.perPush > 1.5 * mPush && d.pushes >= 20) {
      add("ticket", `per-push-${d.day}`, `${d.day} cost ${money(d.perPush)} per push`, `week median ${money(mPush)}; ${d.pushes} pushes, CI ${money(d.cost.ci)}`);
    }
  }

  // 3. A cost category that grew: the last three days against the first four.
  const cats = new Set(days.flatMap((d) => Object.keys(d.cost?.categories ?? {})));
  if (days.length >= 5) {
    for (const c of cats) {
      const v = days.map((d) => d.cost?.categories?.[c] ?? 0);
      const early = mean(v.slice(0, days.length - 3));
      const late = mean(v.slice(-3));
      if (late > 1 && late > 2 * Math.max(early, 0.01)) {
        add("ticket", `growth-${c}`, `${c} cost grew from ${money(early)} to ${money(late)} a day`, v.map((x, i) => `${days[i].day.slice(5)} ${x.toFixed(2)}`).join(", "));
      }
    }
  }

  // 4. Provisioned disk performance billed above what the templates provision.
  const maxIops = Math.max(0, ...r.templates.map((t) => t.disk?.iops ?? 0));
  const maxTp = Math.max(0, ...r.templates.map((t) => t.disk?.throughput ?? 0));
  for (const d of days) {
    const iops = d.cost?.categories?.["ebs-iops"] ?? 0;
    if (iops > 0.1 && maxIops <= 3000) {
      add("ticket", `iops-${d.day}`, `${d.day}: ${money(iops)} of provisioned IOPS while every template provisions ${maxIops}`, "gp3 bills IOPS only above 3000: some host ran on a disk no current template describes");
    }
  }
  const tooFast = days.flatMap((d) => (d.usage?.jobs ?? []).filter((j) => j.runs >= 5 && j.mibpsP95 > maxTp * 1.1).map((j) => `${d.day.slice(5)} ${j.group} ${j.mibpsP95} MiB/s`));
  if (maxTp && tooFast.length) {
    add("ticket", "throughput-above-template", `Jobs read faster than the ${maxTp} MiB/s the templates provision`, tooFast.slice(0, 6).join("; "));
  }

  // 5. Template changes and drift between regions.
  const disks = new Set(r.templates.map((t) => (t.disk ? `${t.disk.iops}/${t.disk.throughput}/${t.disk.size}` : "none")));
  if (disks.size > 1) add("ticket", "template-drift", "Regions hand hosts different disks", r.templates.map((t) => `${t.region} ${t.disk ? `${t.disk.iops}/${t.disk.throughput}` : "no template"}`).join("; "));
  const changes = r.templates.flatMap((t) => (t.changes ?? []).map((c) => ({ ...c, region: t.region })));
  const diskChanges = changes.filter((c) => c.disk && c.previousDisk && (c.disk.iops !== c.previousDisk.iops || c.disk.throughput !== c.previousDisk.throughput));
  if (diskChanges.length) {
    add("ticket", "template-disk-changed", "A template's default disk changed inside the window", diskChanges.map((c) => `${c.region} ${c.at} v${c.version} ${c.previousDisk.iops}/${c.previousDisk.throughput} → ${c.disk.iops}/${c.disk.throughput} by ${c.by}`).join("; "));
  }

  // 6. Paid slot time that ran no job.
  const util = days.filter((d) => d.usage?.idle?.paidHours > 0);
  for (const d of util) {
    const u = d.usage.idle;
    if (u.runningShare < 0.35) add("ticket", `utilization-${d.day}`, `${d.day}: ${(100 * u.runningShare).toFixed(0)}% of paid slot time ran a job`, `${u.paidHours.toFixed(1)} paid slot-hours, ${u.runningHours.toFixed(1)} running, in the sampled window`);
  }
  const perJobHour = util.map((d) => d.usage.idle.paidHours / Math.max(d.usage.idle.runningHours, 0.1));
  const mRatio = median(perJobHour);
  util.forEach((d, i) => {
    if (mRatio && perJobHour[i] > 1.4 * mRatio) add("watch", `slot-hours-${d.day}`, `${d.day}: ${perJobHour[i].toFixed(2)} paid slot-hours per job-hour`, `week median ${mRatio.toFixed(2)}`);
  });

  // 7. Jobs that got slower: the last day against each job's week median.
  const last = days[days.length - 1];
  const slower = (last?.usage?.jobs ?? [])
    .filter((j) => j.runs >= 10)
    .map((j) => {
      const prior = days.slice(0, -1).map((d) => d.usage?.jobs?.find((x) => x.group === j.group)?.p50).filter(Number.isFinite);
      return { group: j.group, p50: j.p50, base: median(prior) };
    })
    .filter((j) => j.base && j.p50 > 1.3 * j.base && j.p50 - j.base > 0.5)
    .sort((a, b) => b.p50 / b.base - a.p50 / a.base);
  if (slower.length) {
    add("watch", "slower-jobs", `${slower.length} jobs ran over 30% slower on ${last.day}`, slower.slice(0, 5).map((j) => `${j.group} ${j.base.toFixed(1)} → ${j.p50.toFixed(1)} min`).join("; "));
  }

  // 8. IO wait creeping up across the heaviest jobs.
  const io = days.map((d) => median((d.usage?.jobs ?? []).slice(0, 15).map((j) => j.ioWaitP95)));
  const firstIo = io.find(Number.isFinite);
  const lastIo = [...io].reverse().find(Number.isFinite);
  if (firstIo && lastIo > 1.5 * firstIo) add("watch", "io-wait", `IO wait p95 of the heaviest jobs went from ${firstIo.toFixed(0)}% to ${lastIo.toFixed(0)}%`, "median over the 15 jobs with the most job-minutes");

  // 9. Full suites dispatched off-hours, and the same branch dispatched again and again.
  const night = r.dispatches.filter((x) => offHours(x.started, { offset }));
  if (night.length) {
    const min = night.reduce((a, x) => a + x.jobMinutes, 0);
    add("ticket", "night-dispatch", `${night.length} full suites dispatched off-hours (${Math.round(min)} job-min)`, night.map((x) => `${x.started.slice(0, 16)}Z ${x.branch} ${x.conclusion ?? x.status} #${x.id}`).join("; "));
  }
  const byBranchDay = new Map();
  for (const x of r.dispatches) {
    const k = `${x.started.slice(0, 10)} ${x.branch}`;
    byBranchDay.set(k, [...(byBranchDay.get(k) ?? []), x]);
  }
  for (const [k, xs] of byBranchDay) {
    const red = xs.filter((x) => x.conclusion === "failure").length;
    if (xs.length >= 3) add("ticket", `dispatch-loop-${k}`, `${xs.length} full suites on ${k}`, `${red} red; ${Math.round(xs.reduce((a, x) => a + x.jobMinutes, 0))} job-min`);
  }

  // 10. On-demand fallback, egress and NAT.
  for (const d of days) {
    const c = d.cost?.categories ?? {};
    const compute = (c.spot ?? 0) + (c["on-demand"] ?? 0);
    if (compute > 1 && (c["on-demand"] ?? 0) > 0.15 * compute) add("ticket", `on-demand-${d.day}`, `${d.day}: on-demand was ${money(c["on-demand"])} of ${money(compute)} compute`, "the fleet asks for spot; on-demand is the fallback");
    const net = (c.egress ?? 0) + (c.nat ?? 0);
    if (net > 1) add("ticket", `egress-${d.day}`, `${d.day}: ${money(net)} of egress and NAT`, "cache and registry traffic should stay inside the region");
  }

  // 11. Memory kills and queue waits.
  const ooms = days.flatMap((d) => (d.usage?.jobs ?? []).filter((j) => j.oom > 0).map((j) => `${d.day.slice(5)} ${j.group} ×${j.oom}`));
  if (ooms.length) add("watch", "oom", "Jobs killed for memory", ooms.slice(0, 6).join("; "));
  for (const d of days) if (d.usage?.queueP90s > 60) add("watch", `queue-${d.day}`, `${d.day}: queue p90 ${d.usage.queueP90s}s`, "jobs waited for a runner");

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "ticket" ? -1 : 1));
}

// ── HTML ────────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const n1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const n2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const table = (head, rows) =>
  `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;

/** One printable page set. Pure: the report in, HTML out. */
export function renderHtml(r) {
  const days = r.days;
  const short = (d) => d.day.slice(8, 10) + "/" + d.day.slice(5, 7);
  const sum = (k) => days.reduce((a, d) => a + (d[k] ?? 0), 0);
  const ciTotal = days.reduce((a, d) => a + (d.cost?.ci ?? 0), 0);
  const cats = [...new Set(days.flatMap((d) => Object.keys(d.cost?.categories ?? {})))].sort(
    (a, b) => days.reduce((s, d) => s + (d.cost.categories[b] ?? 0), 0) - days.reduce((s, d) => s + (d.cost.categories[a] ?? 0), 0),
  );
  const top = [...new Map(days.flatMap((d) => (d.usage?.jobs ?? []).slice(0, 15).map((j) => [j.group, j]))).keys()].slice(0, 18);
  const cell = (d, g, k) => d.usage?.jobs?.find((j) => j.group === g)?.[k];
  const sev = { ticket: "Ticket", watch: "Watch" };

  return `<!doctype html><html><head><meta charset="utf-8"><title>CI fleet report ${esc(r.until)}</title><style>
@page { size: A4 landscape; margin: 12mm; }
body { font: 10px/1.35 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1d1d1f; }
h1 { font-size: 18px; margin: 0 0 2px; } h2 { font-size: 13px; margin: 14px 0 4px; border-bottom: 1px solid #ccc; }
.sub { color: #666; margin-bottom: 8px; } table { border-collapse: collapse; width: 100%; margin-bottom: 6px; }
th, td { border: 1px solid #ddd; padding: 2px 4px; vertical-align: top; } th { background: #f3f3f3; text-align: left; }
td.n { text-align: right; white-space: nowrap; } .ticket { color: #b00020; font-weight: 600; } .watch { color: #8a6d00; font-weight: 600; }
.kpi { display: inline-block; margin: 0 18px 6px 0; } .kpi b { font-size: 15px; display: block; }
.note { color: #666; font-size: 9px; } .brk { page-break-before: always; }
</style></head><body>
<h1>CI fleet — ${esc(r.repo)}</h1>
<div class="sub">${esc(days[0]?.day)} → ${esc(days[days.length - 1]?.day)} (UTC days) · generated ${esc(r.generated)} · usage sampled ${esc(r.window)} UTC</div>
<div><span class="kpi"><b>$${ciTotal.toFixed(2)}</b>CI cost, ${days.length} days</span>
<span class="kpi"><b>$${(ciTotal / Math.max(days.length, 1) * 30).toFixed(0)}/mo</b>run rate (target $${r.budget})</span>
<span class="kpi"><b>${sum("merges")}</b>merges</span><span class="kpi"><b>${sum("pushes")}</b>PR pushes</span>
<span class="kpi"><b>$${n2(ciTotal / Math.max(sum("merges"), 1))}</b>per merge</span><span class="kpi"><b>$${n2(ciTotal / Math.max(sum("pushes"), 1))}</b>per push</span></div>

<h2>What looks wrong</h2>
${r.anomalies.length ? table(["", "finding", "evidence"], r.anomalies.map((a) => [sev[a.severity], a.title, a.evidence])).replace(/<td>(Ticket|Watch)<\/td>/g, (_, s) => `<td class="${s.toLowerCase()}">${s}</td>`) : "<p>Nothing out of pattern.</p>"}

<h2>Cost, merges and pushes per day</h2>
${table(
  ["day", "CI $", "fleet tagged $", "account $", "merges", "PR pushes", "$/merge", "$/push", ""],
  days.map((d) => [short(d), n2(d.cost?.ci), n2(d.tagged), n2(d.cost?.account), d.merges, d.pushes, n2(d.perMerge), n2(d.perPush), d.cost?.estimated ? "estimated" : ""]),
)}
<p class="note">CI $ = account − Tax − Route 53 − $${r.baseline}/day baseline. Merges: pull requests merged that UTC day. PR pushes: ${esc(r.workflow)} runs started by a pull_request event.</p>

<h2>AWS CI cost by category ($/day)</h2>
${table(["category", ...days.map(short), "total"], cats.map((c) => [c, ...days.map((d) => n2(d.cost?.categories?.[c] ?? 0)), n2(days.reduce((a, d) => a + (d.cost?.categories?.[c] ?? 0), 0))]))}

<h2>Disk the launch templates hand a host</h2>
${table(
  ["region", "default version", "type", "IOPS", "MiB/s", "GiB", "changes in the window"],
  r.templates.map((t) => [t.region, t.version ?? "–", t.disk?.type ?? "–", t.disk?.iops ?? "–", t.disk?.throughput ?? "–", t.disk?.size ?? "–", (t.changes ?? []).map((c) => `${c.at.slice(5, 16)} v${c.version} ${c.disk ? `${c.disk.iops}/${c.disk.throughput}` : ""} (${c.by})`).join("; ")]),
)}

<h2 class="brk">Job duration p50 (min) — sampled window</h2>
${table(["job", ...days.map(short)], top.map((g) => [g, ...days.map((d) => n1(cell(d, g, "p50")))]))}

<h2>IO wait p95 (%)</h2>
${table(["job", ...days.map(short)], top.map((g) => [g, ...days.map((d) => n1(cell(d, g, "ioWaitP95")))]))}

<h2 class="brk">Disk read/write p95 (MiB/s)</h2>
${table(["job", ...days.map(short)], top.map((g) => [g, ...days.map((d) => cell(d, g, "mibpsP95") ?? "–")]))}

<h2>Paid slot time — sampled window</h2>
${table(
  ["day", "runs", "jobs", "host boots", "paid slot-h", "running", "startup", "between", "tail", "never used", "queue p50 s", "p90 s"],
  days.map((d) => {
    const u = d.usage?.idle;
    const pct = (k) => (u ? `${(100 * u.shares[k]).toFixed(0)}%` : "–");
    return [short(d), d.usage?.runs ?? "–", d.usage?.jobsCount ?? "–", u?.hosts ?? "–", n1(u?.paidHours), pct("busy"), pct("startup"), pct("between"), pct("tail"), pct("unused"), d.usage?.queueP50s ?? "–", d.usage?.queueP90s ?? "–"];
  }),
)}

<h2>Full suites dispatched</h2>
${r.dispatches.length ? table(["started (UTC)", "local", "branch", "actor", "result", "wall min", "job-min", "run"], r.dispatches.map((x) => [x.started.slice(0, 16).replace("T", " "), `${String(localHour(x.started, r.offset)).padStart(2, "0")}h${offHours(x.started, { offset: r.offset }) ? " off-hours" : ""}`, x.branch, x.actor, x.conclusion ?? x.status, n1(x.wallMinutes), Math.round(x.jobMinutes), x.id])) : "<p>None.</p>"}
</body></html>`;
}

// ── collection ──────────────────────────────────────────────────────────────

const aws = (args) => JSON.parse(execFileSync("aws", [...args, "--output", "json"], { encoding: "utf-8", maxBuffer: 64 << 20 }));

async function ghJson(p) {
  const res = await fetchRetrying(`https://api.github.com${p}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Sleep until the core allowance is back above `reserve`. */
async function spare(reserve) {
  const { resources } = await ghJson("/rate_limit");
  const { remaining, reset } = resources.core;
  if (remaining >= reserve) return;
  const ms = Math.max(0, reset * 1000 - Date.now()) + 5000;
  console.error(`rate limit: ${remaining} left, waiting ${Math.round(ms / 60000)} min for the reset`);
  await new Promise((r) => setTimeout(r, ms));
}

/** Cost Explorer, every page: a page holds a slice of the groups, so the days are merged. */
function ce(args) {
  const byDay = new Map();
  let token;
  do {
    const page = aws([...args, ...(token ? ["--next-page-token", token] : [])]);
    for (const r of page.ResultsByTime ?? []) {
      const seen = byDay.get(r.TimePeriod.Start);
      if (seen) seen.Groups.push(...(r.Groups ?? []));
      else byDay.set(r.TimePeriod.Start, { ...r, Groups: [...(r.Groups ?? [])] });
    }
    token = page.NextPageToken;
  } while (token);
  return { ResultsByTime: [...byDay.values()] };
}

function costs(days, until, baseline) {
  const period = `Start=${days[0]},End=${until}`;
  const base = ["ce", "get-cost-and-usage", "--time-period", period, "--granularity", "DAILY", "--metrics", "UnblendedCost"];
  const all = costByDay(ce([...base, "--group-by", "Type=DIMENSION,Key=SERVICE", "Type=DIMENSION,Key=USAGE_TYPE"]), { baseline });
  const tagged = taggedByDay(ce([...base, "--filter", '{"Tags":{"Key":"Project","Values":["ci-runner"]}}', "--group-by", "Type=DIMENSION,Key=REGION"]));
  return { all, tagged };
}

const diskOf = (data) => {
  const ebs = data?.BlockDeviceMappings?.find((m) => m.Ebs)?.Ebs;
  return ebs ? { type: ebs.VolumeType, iops: ebs.Iops, throughput: ebs.Throughput, size: ebs.VolumeSize } : null;
};

/** Each region's default template version, its disk, and the default changes since `since`. */
function templates(regions, name, since) {
  return regions.map((region) => {
    try {
      const versions = aws(["ec2", "describe-launch-template-versions", "--region", region, "--launch-template-name", name]).LaunchTemplateVersions;
      const byNumber = new Map(versions.map((v) => [v.VersionNumber, v]));
      const def = versions.find((v) => v.DefaultVersion);
      const events = aws(["cloudtrail", "lookup-events", "--region", region, "--lookup-attributes", "AttributeKey=EventName,AttributeValue=ModifyLaunchTemplate", "--start-time", `${since}T00:00:00Z`]).Events ?? [];
      const changes = events
        .map((e) => JSON.parse(e.CloudTrailEvent))
        .filter((e) => e.requestParameters?.ModifyLaunchTemplateRequest?.LaunchTemplateName === name || e.responseElements?.ModifyLaunchTemplateResponse?.launchTemplate?.launchTemplateName === name)
        .map((e) => ({ at: e.eventTime, version: Number(e.requestParameters.ModifyLaunchTemplateRequest.SetDefaultVersion), by: String(e.userIdentity?.arn ?? "").split("/").slice(1).join("/") }))
        .sort((a, b) => a.at.localeCompare(b.at));
      let previous = null;
      for (const c of changes) {
        c.disk = diskOf(byNumber.get(c.version)?.LaunchTemplateData);
        c.previousDisk = previous;
        previous = c.disk;
      }
      return { region, version: def?.VersionNumber, disk: diskOf(def?.LaunchTemplateData), changes };
    } catch (e) {
      return { region, version: null, disk: null, changes: [], error: String(e.message).split("\n")[0] };
    }
  });
}

/**
 * Pull requests merged per UTC day. The closed list sorted by update, read
 * until it is older than the window: a merge updates the pull request, so none
 * merged inside the window sorts below that point. (The search API would be
 * one call a day, but a repository-scoped token cannot reach it.)
 */
async function mergesByDay(repo, days, until) {
  const out = {};
  for (let page = 1; ; page++) {
    const pulls = await ghJson(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    for (const p of pulls) {
      const d = p.merged_at?.slice(0, 10);
      if (d && d >= days[0] && d < until) out[d] = (out[d] ?? 0) + 1;
    }
    if (pulls.length < 100 || pulls[pulls.length - 1].updated_at.slice(0, 10) < days[0]) return out;
  }
}

async function dispatches(repo, workflow, days, until) {
  const runs = (await ghJson(`/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&created=${days[0]}..${until}&per_page=100`)).workflow_runs.filter(
    (x) => x.created_at.slice(0, 10) < until,
  );
  const out = [];
  for (const x of runs) {
    const jobs = (await ghJson(`/repos/${repo}/actions/runs/${x.id}/jobs?filter=latest&per_page=100`)).jobs;
    const jobMinutes = jobs.reduce((a, j) => a + (j.completed_at && j.started_at ? (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 60000 : 0), 0);
    out.push({
      id: x.id,
      branch: x.head_branch,
      actor: x.triggering_actor?.login ?? x.actor?.login,
      started: x.run_started_at ?? x.created_at,
      status: x.status,
      conclusion: x.conclusion,
      wallMinutes: (Date.parse(x.updated_at) - Date.parse(x.run_started_at ?? x.created_at)) / 60000,
      jobMinutes,
    });
  }
  return out.sort((a, b) => a.started.localeCompare(b.started));
}

/** The sampled window's usage, reduced to what the report shows. */
export function reduceUsage({ runs, jobs, records, waiting }, { slots = 2, idleMinutes = 2 } = {}) {
  const rows = summarizeJobs(records);
  const t = idleBreakdown(
    records.map((r) => r.usage),
    { slots, idleMinutes, waiting },
  );
  const waits = records.map((r) => r.queuedMs).filter(Number.isFinite);
  const share = (ms) => (t.paid ? ms / t.paid : 0);
  return {
    runs,
    jobsCount: jobs,
    jobs: rows.map((j) => ({
      group: j.group,
      runs: j.runs,
      jobMinutes: j.jobMinutes,
      p50: j.wallMinP50,
      ioWaitP95: j.ioWaitPctP95,
      mibpsP95: j.peakDiskMiBpsP95,
      oom: j.oomKills,
    })),
    idle: {
      hosts: t.hosts,
      paidHours: t.paid / HOUR,
      runningHours: t.busy / HOUR,
      runningShare: share(t.busy),
      shares: { busy: share(t.busy), startup: share(t.startup), between: share(t.between), tail: share(t.tail), unused: share(t.unused) },
    },
    queueP50s: waits.length ? Math.round(percentile(waits, 50) / 1000) : null,
    queueP90s: waits.length ? Math.round(percentile(waits, 90) / 1000) : null,
  };
}

function chrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const bin = path.join(pw, d, "chrome-linux", "chrome");
      if (existsSync(bin)) return bin;
    }
  }
  return "chromium";
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]] : acc), []),
  );
  const repo = args.repo;
  if (!repo || !process.env.GITHUB_TOKEN) {
    console.error("usage: GITHUB_TOKEN=… daily-report.mjs --repo owner/name [--days 7] [--until YYYY-MM-DD] [--out dir] [--pdf]");
    process.exit(64);
  }
  const until = args.until ?? new Date().toISOString().slice(0, 10);
  const days = windowDays(until, Number(args.days ?? 7));
  const [fromH, toH] = String(args.window ?? "14-17").split("-").map(Number);
  const workflow = args.workflow ?? "ci.yml";
  const baseline = Number(args.baseline ?? 0.69);
  const budget = Number(args.budget ?? 100);
  const offset = Number(args.offset ?? -3);
  const reserve = Number(args.reserve ?? 4000);
  const label = args.label ?? "future-pay-ci";
  const out = args.out ?? ".";
  mkdirSync(out, { recursive: true });

  console.error("cost explorer…");
  const cost = costs(days, until, baseline);
  console.error("launch templates…");
  const tpl = templates((args.regions ?? "us-east-1,us-east-2,eu-north-1").split(","), args.template ?? "ci-runner-fleet-future-pay-ci", days[0]);

  console.error("merges…");
  const merged = await mergesByDay(repo, days, until);
  const report = { repo, until, generated: new Date().toISOString().slice(0, 16) + "Z", window: `${fromH}:00–${toH}:00`, workflow, baseline, budget, offset, templates: tpl, days: [] };
  for (const day of days) {
    console.error(`${day}: counts…`);
    const pushes = (await ghJson(`/repos/${repo}/actions/workflows/${workflow}/runs?event=pull_request&created=${day}&per_page=1`)).total_count;
    const merges = merged[day] ?? 0;
    await spare(reserve);
    console.error(`${day}: usage ${fromH}–${toH} UTC…`);
    const hh = (h) => String(h).padStart(2, "0");
    const usage = reduceUsage(await collect({ repo, since: `${day}T${hh(fromH)}:00:00Z`, until: `${day}T${hh(toH)}:00:00Z`, label }));
    const c = cost.all[day];
    report.days.push({ day, pushes, merges, cost: c, tagged: cost.tagged[day], perPush: c && pushes ? c.ci / pushes : null, perMerge: c && merges ? c.ci / merges : null, usage });
  }
  console.error("dispatches…");
  report.dispatches = await dispatches(repo, workflow, days, until);
  report.anomalies = anomalies(report, { budget, offset });

  writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  const html = path.join(out, "report.html");
  writeFileSync(html, renderHtml(report));
  if (args.pdf) {
    const pdf = path.resolve(out, "report.pdf");
    execFileSync(chrome(), ["--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdf}`, pathToFileURL(path.resolve(html)).href], { stdio: "ignore" });
    console.error(`wrote ${pdf}`);
  }
  for (const a of report.anomalies) console.log(`${a.severity.toUpperCase()}\t${a.title}\t${a.evidence}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
