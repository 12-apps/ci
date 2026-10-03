#!/usr/bin/env node
// What CI costs in USD, per workflow and per lane, with the fleet's overhead
// and utilization as their own lines.
//
//   GITHUB_TOKEN=… node fleet-cost.mjs --repo owner/name --since 2026-09-24 --until 2026-09-30 \
//     --costs ce-region.json [--spot spot.json] [--untagged ce-untagged.json] \
//     [--lanes lanes.json] [--label future-pay-ci] [--idle-minutes 2] [--slots 2] \
//     [--cache .fleet-cost-cache] [--csv out.csv] [--jobs jobs.json] [--types m7a.2xlarge,…] \
//     [--margin-minutes 3]
//
// AWS data comes in as FILES, the JSON the aws CLI prints, so this needs no
// SDK and the credentials stay with whoever runs it:
//
//   aws ce get-cost-and-usage --time-period Start=…,End=… --granularity DAILY \
//     --metrics UnblendedCost --filter '{"Tags":{"Key":"Project","Values":["ci-runner"]}}' \
//     --group-by Type=DIMENSION,Key=REGION                              > ce-region.json
//   aws ce get-cost-and-usage … --filter '{"Not":{"Tags":{"Key":"Project","Values":["ci-runner"]}}}' \
//     --group-by Type=DIMENSION,Key=USAGE_TYPE                          > ce-untagged.json
//   aws ec2 describe-spot-price-history --region <r> --instance-types … \
//     --product-descriptions Linux/UNIX --start-time … --end-time …    > spot-<r>.json
//   jq -s '{SpotPriceHistory: map(.SpotPriceHistory[])}' spot-*.json  > spot.json  (one per region, merged)
//
// ## How a dollar is attributed
//
// A host is not one job: it runs SLOTS jobs at a time and lives from boot to
// IDLE minutes after its last job. So instance tags cannot say what a job cost.
// Instead:
//
//  1. Host lifetimes are rebuilt from every fleet job's runner name
//     (`<az>-ip-…-<slot>-<epoch>`, usage-report.mjs › hostAndSlot). A runner key
//     is not a host, because private IPs are recycled: the jobs on one key are
//     split wherever the job usage lines disagree on the host's boot time, or
//     wherever the key sat with no job for longer than IDLE + a margin (idle-stop
//     has terminated the host by then). A lifetime starts at its boot (from a
//     usage line) or, with none, at its first job minus the median startup
//     measured on the lifetimes that do have one, and ends IDLE minutes after
//     its last job.
//  2. Each slot of each lifetime is cut into running a job, startup, between
//     jobs, tail and never used, and every piece is cut again at UTC midnight
//     (Cost Explorer's days are UTC) and filed under the host's region.
//  3. Per UTC day and region, the tagged cost is spread over the PAID
//     slot-minutes. A job gets its own minutes at that rate; the overhead kinds
//     get theirs. Utilization is running ÷ paid.
//
// That spread adds up to the tagged total by construction, so it proves
// nothing on its own. The independent check is the BOTTOM-UP cost: every
// lifetime's hours at the mean spot price of the fleet's types in its zone at
// that hour, plus its disk and address. tagged − bottom-up is the GAP, and it
// holds what the jobs cannot show: a host that never got a job, the on-demand
// fallback, snapshots and images, and the type mix (a runner name carries no
// instance type, so the price is the zone's mean over the types). A large gap
// is a reason to look, not a number to attribute.
//
// The all-in rate per JOB-minute (tagged ÷ minutes running a job) is what
// cost-report.yml's `self_hosted` rate means: that workflow multiplies it by
// the minutes jobs ran, so the overhead has to be inside it.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchRetrying, hostAndSlot, parseUsage } from "./usage-report.mjs";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── lanes ───────────────────────────────────────────────────────────────────

/**
 * A job's group: `<workflow> / <job>` with every standalone number folded to
 * `#` (a digit inside a word, `E2E`, stays), so the
 * legs of a matrix (`Unit Tests · shard 3/4`, `E2E (2)`) and a workflow named
 * after its PR (`Code Quality: PR #2123`) each read as one thing. Wider than
 * usage-report.mjs's jobGroup, which folds only inside parentheses: here a
 * group is a line of a bill, and a shard per line is noise. cost-report.yml
 * folds the same way, so a lane rule means the same in both.
 */
export function costGroup(workflow, name) {
  return foldName(`${workflow ?? ""} / ${name ?? ""}`);
}

/**
 * A name with its varying parts folded: a commit (a run-name may carry the
 * one it ran for, `Post-CD Tests — prod @ <sha>`) and every standalone number
 * (`Code Quality: PR #`). Without it every deploy and every PR is a line.
 */
export function foldName(s) {
  return String(s ?? "").replace(/\b[0-9a-f]{40}\b/g, "<sha>").replace(/\b\d+\b/g, "#");
}

/**
 * Lane rules: `[{ "lane": "unit", "match": "Unit Tests" }, …]`, tried in order,
 * each `match` a case-insensitive regular expression over the job's
 * `costGroup`. Unmatched is `other`.
 */
export function compileLanes(rules = []) {
  if (!Array.isArray(rules)) throw new Error("lane rules must be an array of { lane, match }");
  const compiled = rules.map((r, i) => {
    if (!r || typeof r.lane !== "string" || typeof r.match !== "string") {
      throw new Error(`lane rule ${i} needs a string "lane" and a string "match"`);
    }
    return { lane: r.lane, re: new RegExp(r.match, "i") };
  });
  return (group) => compiled.find((r) => r.re.test(group))?.lane ?? "other";
}

/**
 * The matrix leg a job name carries: `Unit Tests · shard 3/8` → `3/8`,
 * `E2E (client, 2)` → `client, 2`, or "" for none.
 */
export function shardOf(name) {
  const m = /\bshard (\d+\/\d+)/i.exec(name ?? "") ?? /\(([^)]*\d[^)]*)\)\s*$/.exec(name ?? "");
  return m ? m[1] : "";
}

// ── regions and days ────────────────────────────────────────────────────────

/** `eu-north-1b` → `eu-north-1`. */
export function regionOf(az) {
  const m = /^([a-z]{2}(?:-gov)?-[a-z]+-\d+)[a-z]$/.exec(az ?? "");
  return m ? m[1] : "unknown";
}

/** `eu-north-1b-ip-172-31-36-84` → `eu-north-1b`, or null for a name with no zone. */
export function zoneOf(host) {
  const m = /^([a-z]{2}(?:-gov)?-[a-z]+-\d+[a-z])-ip-/.exec(host ?? "");
  return m ? m[1] : null;
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** [from, to) cut at every UTC midnight it crosses: `[[day, from, to], …]`. */
export function byUtcDay(from, to) {
  const out = [];
  for (let a = from; a < to; ) {
    const midnight = Math.floor(a / DAY) * DAY + DAY;
    const b = Math.min(to, midnight);
    out.push([dayOf(a), a, b]);
    a = b;
  }
  return out;
}

// ── host lifetimes ──────────────────────────────────────────────────────────

/**
 * One fleet job as this module needs it, from the Actions API's job object.
 * Jobs that never ran on a fleet runner are dropped.
 */
export function fleetJob(j) {
  const hs = hostAndSlot(j.runner_name);
  const start = Date.parse(j.started_at);
  const end = Date.parse(j.completed_at);
  if (!hs || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const zone = zoneOf(hs.host);
  return {
    id: j.id,
    workflow: foldName(j.workflow),
    name: j.name ?? "",
    group: costGroup(j.workflow, j.name),
    host: hs.host,
    slot: Number(hs.slot),
    zone,
    region: regionOf(zone),
    start,
    end,
    bootMs: Number.isFinite(j.hostBootS) ? j.hostBootS * 1000 : null,
  };
}

/**
 * Split the jobs of each runner key into host lifetimes (see the header).
 * `splitGapMs` is IDLE + the margin. Returns lifetimes without start/end yet:
 * those need the startup median, which needs the lifetimes first.
 */
export function splitHosts(jobs, { splitGapMs }) {
  const byKey = new Map();
  for (const j of jobs) {
    if (!byKey.has(j.host)) byKey.set(j.host, []);
    byKey.get(j.host).push(j);
  }
  const out = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let cur = null;
    for (const j of list) {
      // A different boot is a different host, however short the gap.
      const otherBoot = cur && j.bootMs !== null && cur.bootMs !== null && Math.abs(j.bootMs - cur.bootMs) > 2000;
      if (!cur || otherBoot || j.start - cur.busyUntil > splitGapMs) {
        cur = { key, zone: j.zone, region: j.region, jobs: [], busyUntil: -Infinity, bootMs: null };
        out.push(cur);
      }
      cur.jobs.push(j);
      cur.busyUntil = Math.max(cur.busyUntil, j.end);
      if (j.bootMs !== null) cur.bootMs = cur.bootMs === null ? j.bootMs : Math.min(cur.bootMs, j.bootMs);
    }
  }
  return out;
}

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

/**
 * Give every lifetime its start and end. A lifetime with a known boot starts
 * there; one without starts at its first job minus the median startup of the
 * lifetimes with a boot in the same region and UTC day (else any day, else
 * `defaultStartupMs`).
 */
export function placeHosts(hosts, { idleMs, defaultStartupMs = 150_000 }) {
  const first = (h) => Math.min(...h.jobs.map((j) => j.start));
  const measured = new Map();
  const all = [];
  for (const h of hosts) {
    if (h.bootMs === null) continue;
    const s = first(h) - h.bootMs;
    if (s < 0) continue; // a clock that disagrees is not a measurement
    const k = `${h.region}@${dayOf(first(h))}`;
    if (!measured.has(k)) measured.set(k, []);
    measured.get(k).push(s);
    all.push(s);
  }
  const fallback = median(all) ?? defaultStartupMs;
  for (const h of hosts) {
    const f = first(h);
    const startup = median(measured.get(`${h.region}@${dayOf(f)}`) ?? []) ?? fallback;
    h.startKnown = h.bootMs !== null && h.bootMs <= f;
    h.start = h.startKnown ? h.bootMs : f - startup;
    h.end = h.busyUntil + idleMs;
  }
  return { hosts, startupMs: fallback };
}

// ── slot time ───────────────────────────────────────────────────────────────

export const KINDS = ["busy", "startup", "between", "tail", "unused"];

/**
 * Every paid slot-millisecond of every lifetime, as pieces
 * `{ day, region, kind, ms, job? }`. `slots` is the configured count; a
 * lifetime that ran a higher slot number than that had more slots (the
 * 4-slot test of 2026-10-01), and is counted with what it ran.
 */
export function slotPieces(hosts, { slots = 2 } = {}) {
  const pieces = [];
  const put = (h, kind, from, to, job) => {
    const cut = byUtcDay(from, to);
    // A job with no measurable time (equal timestamps, or nested inside the
    // slot's previous job) still ran: it keeps a zero-length piece so it is
    // counted and laned.
    if (!cut.length && job) cut.push([dayOf(from), from, from]);
    for (const [day, a, b] of cut) pieces.push({ day, region: h.region, kind, ms: b - a, job });
  };
  for (const h of hosts) {
    const n = Math.max(slots, ...h.jobs.map((j) => j.slot));
    // Boot ends when the host takes its first job on ANY slot. A slot that
    // waits after that is an idle slot on a running host, not boot.
    const booted = Math.min(...h.jobs.map((j) => j.start));
    for (let s = 1; s <= n; s++) {
      const list = h.jobs.filter((j) => j.slot === s).sort((a, b) => a.start - b.start);
      if (!list.length) {
        put(h, "unused", h.start, h.end);
        continue;
      }
      put(h, "startup", h.start, Math.min(booted, list[0].start));
      if (list[0].start > booted) put(h, "between", booted, list[0].start);
      let at = list[0].start;
      for (const j of list) {
        if (j.start > at) put(h, "between", at, j.start);
        const from = Math.max(j.start, at); // a slot runs one job at a time
        put(h, "busy", from, Math.max(from, j.end), j);
        at = Math.max(at, j.end);
      }
      put(h, "tail", at, h.end);
    }
  }
  return pieces;
}

// ── prices ──────────────────────────────────────────────────────────────────

/**
 * Tagged cost per `day@region` from `aws ce get-cost-and-usage … --group-by
 * REGION`. Keys other than a real region (`global`, `NoRegion`) stay as they
 * are and end up unattributed.
 */
export function costsByDayRegion(ce) {
  const out = new Map();
  for (const r of ce?.ResultsByTime ?? []) {
    const day = r.TimePeriod.Start;
    for (const g of r.Groups ?? []) {
      const usd = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
      if (usd) out.set(`${day}@${g.Keys[0]}`, (out.get(`${day}@${g.Keys[0]}`) ?? 0) + usd);
    }
    const total = Number(r.Total?.UnblendedCost?.Amount ?? 0);
    if (!r.Groups?.length && total) out.set(`${day}@unknown`, total);
  }
  return out;
}

/**
 * The mean spot price of the fleet's types in a zone at an instant, from
 * `describe-spot-price-history` records: per type, the last price set at or
 * before `t`. Types with no price by then are left out of the mean.
 */
export function spotPricer(history = []) {
  const byZone = new Map();
  for (const p of history) {
    const z = p.AvailabilityZone;
    if (!byZone.has(z)) byZone.set(z, new Map());
    const byType = byZone.get(z);
    if (!byType.has(p.InstanceType)) byType.set(p.InstanceType, []);
    byType.get(p.InstanceType).push([Date.parse(p.Timestamp), Number(p.SpotPrice)]);
  }
  for (const byType of byZone.values()) for (const v of byType.values()) v.sort((a, b) => a[0] - b[0]);
  return (zone, t, types) => {
    const byType = byZone.get(zone);
    if (!byType) return null;
    const prices = [];
    for (const [type, v] of byType) {
      if (types && !types.includes(type)) continue;
      let lo = 0, hi = v.length - 1, found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (v[mid][0] <= t) { found = v[mid][1]; lo = mid + 1; } else hi = mid - 1;
      }
      if (found !== null) prices.push(found);
    }
    return prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  };
}

/**
 * Bottom-up cost per `day@region`: each lifetime's hours, hour by hour, at
 * the zone's mean spot price plus the per-host extras (disk, public IPv4).
 * Hours with no price are counted in `unpricedHours`, never as free.
 */
export function bottomUp(hosts, price, { extrasPerHour = 0.019, types } = {}) {
  const out = new Map();
  let unpricedHours = 0;
  for (const h of hosts) {
    for (let a = h.start; a < h.end; ) {
      const b = Math.min(h.end, Math.floor(a / HOUR) * HOUR + HOUR);
      const hours = (b - a) / HOUR;
      const p = price(h.zone, a, types);
      if (p === null) unpricedHours += hours;
      const k = `${dayOf(a)}@${h.region}`;
      out.set(k, (out.get(k) ?? 0) + hours * ((p ?? 0) + extrasPerHour));
      a = b;
    }
  }
  return { byDayRegion: out, unpricedHours };
}

// ── attribution ─────────────────────────────────────────────────────────────

/**
 * Spread each day × region's tagged cost over its paid slot-minutes.
 * Returns per-day totals, per-job-row USD and the cost nothing ran under.
 *
 * A day on which some host's region cannot be read (runner names carried no
 * zone before 2026-09-25) is POOLED: all of its regions' cost over all of its
 * paid time. Pricing those hosts at zero would hand their share to the hosts
 * whose names do say a region, and file the rest as unattributed.
 */
export function attribute(pieces, costs, { lane = () => "other", days } = {}) {
  const pooled = new Set(pieces.filter((p) => p.region === "unknown" && p.ms > 0).map((p) => p.day));
  const keyOf = (day, region) => (pooled.has(day) ? `${day}@*` : `${day}@${region}`);
  const paid = new Map(); // day@region (or day@* when pooled) -> ms
  for (const p of pieces) paid.set(keyOf(p.day, p.region), (paid.get(keyOf(p.day, p.region)) ?? 0) + p.ms);
  // Cost Explorer files some cost under no region (`global`, `NoRegion`).
  // No host ran there, so it is unattributed on every day alike, pooled or not.
  const isRegion = (r) => /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(r);
  const pool = new Map(); // costs re-keyed the same way
  for (const [k, usd] of costs) {
    const [day, region] = k.split("@");
    if (isRegion(region)) pool.set(keyOf(day, region), (pool.get(keyOf(day, region)) ?? 0) + usd);
  }
  const rate = new Map(); // key -> USD per slot-ms
  for (const [k, ms] of paid) if (ms > 0) rate.set(k, (pool.get(k) ?? 0) / ms);

  const inWindow = (day) => !days || days.includes(day);
  const perDay = new Map();
  const dayRow = (day) => {
    if (!perDay.has(day)) {
      perDay.set(day, { day, pooled: pooled.has(day), tagged: 0, paidMs: 0, unattributed: 0, ...Object.fromEntries(KINDS.flatMap((k) => [[`${k}Ms`, 0], [`${k}Usd`, 0]])) });
    }
    return perDay.get(day);
  };
  const rows = new Map(); // workflow|lane|group|shard|day|region -> row
  for (const p of pieces) {
    if (!inWindow(p.day)) continue;
    const usd = p.ms * (rate.get(keyOf(p.day, p.region)) ?? 0);
    const d = dayRow(p.day);
    d.paidMs += p.ms;
    d[`${p.kind}Ms`] += p.ms;
    d[`${p.kind}Usd`] += usd;
    if (p.kind !== "busy") continue;
    const j = p.job;
    const l = lane(j.group);
    const shard = shardOf(j.name);
    const rk = [j.workflow, l, j.group, shard, p.day, p.region].join("|");
    if (!rows.has(rk)) {
      rows.set(rk, { workflow: j.workflow, lane: l, group: j.group, shard, day: p.day, region: p.region, jobs: new Set(), ms: 0, usd: 0 });
    }
    const r = rows.get(rk);
    r.jobs.add(j.id);
    r.ms += p.ms;
    r.usd += usd;
  }
  // Cost under a day × region where no fleet slot was paid (an image copy, a
  // snapshot, a host the jobs never saw): real, but nothing ran under it.
  for (const [k, usd] of costs) {
    const [day] = k.split("@");
    if (!inWindow(day)) continue;
    const d = dayRow(day);
    d.tagged += usd;
    const region = k.split("@")[1];
    if (!isRegion(region) || !rate.has(keyOf(day, region))) d.unattributed += usd;
  }
  return {
    days: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    // `ids` lets a roll-up across days count a job that crossed midnight once.
    rows: [...rows.values()].map((r) => ({ ...r, ids: r.jobs, jobs: r.jobs.size })),
  };
}

/**
 * Untagged spend that is probably the fleet's: cross-region image copies,
 * their snapshots, and public IPv4. The untagged bucket also holds things
 * that are not CI (a NAT gateway, other machines), so this is a candidate
 * line, reported beside the attribution and never inside it.
 */
export const UNTAGGED_CI = /(?:-AWS-(?:In|Out)-Bytes|SnapshotUsage|PublicIPv4|DataTransfer-Regional-Bytes)/;
export function untaggedByDay(ce, pattern = UNTAGGED_CI) {
  const out = new Map();
  for (const r of ce?.ResultsByTime ?? []) {
    const day = r.TimePeriod.Start;
    let usd = 0;
    const by = {};
    for (const g of r.Groups ?? []) {
      if (!pattern.test(g.Keys[0])) continue;
      const v = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
      usd += v;
      by[g.Keys[0]] = v;
    }
    out.set(day, { usd, by });
  }
  return out;
}

// ── rendering ───────────────────────────────────────────────────────────────

const usd = (n) => `$${n.toFixed(2)}`;
// A table cell: a backslash first, so the escape of a pipe cannot be undone by one.
const cell = (v) => String(v || "–").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
const h1 = (ms) => (ms / HOUR).toFixed(1);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");

/** The all-in USD per job-minute: tagged cost ÷ minutes running a job. */
export function allInRate(days) {
  const tagged = days.reduce((a, d) => a + d.tagged, 0);
  const busyMin = days.reduce((a, d) => a + d.busyMs, 0) / MIN;
  return busyMin ? tagged / busyMin : null;
}

export function renderDays(days, { bottom, untagged } = {}) {
  const lines = [
    "| UTC day | tagged | bottom-up | gap | paid slot-h | running slot-h | utilization | USD per job-min | untagged CI-like |",
    "|---|--:|--:|--:|--:|--:|--:|--:|--:|",
  ];
  const t = { tagged: 0, bottom: 0, paidMs: 0, busyMs: 0, untagged: 0 };
  for (const d of days) {
    const b = bottom ? [...bottom.entries()].filter(([k]) => k.startsWith(`${d.day}@`)).reduce((a, [, v]) => a + v, 0) : null;
    const u = untagged?.get(d.day)?.usd ?? null;
    t.tagged += d.tagged; t.bottom += b ?? 0; t.paidMs += d.paidMs; t.busyMs += d.busyMs; t.untagged += u ?? 0;
    lines.push(
      `| ${d.day} | ${usd(d.tagged)} | ${b === null ? "–" : usd(b)} | ${b === null ? "–" : `${usd(d.tagged - b)} (${pct(d.tagged - b, d.tagged)})`} | ` +
        `${h1(d.paidMs)} | ${h1(d.busyMs)} | ${pct(d.busyMs, d.paidMs)} | ` +
        `${d.busyMs ? `$${(d.tagged / (d.busyMs / MIN)).toFixed(4)}` : "–"} | ${u === null ? "–" : usd(u)} |`,
    );
  }
  lines.push(
    `| **total** | **${usd(t.tagged)}** | ${bottom ? `**${usd(t.bottom)}**` : "–"} | ${bottom ? `**${usd(t.tagged - t.bottom)}** (${pct(t.tagged - t.bottom, t.tagged)})` : "–"} | ` +
      `**${h1(t.paidMs)}** | **${h1(t.busyMs)}** | **${pct(t.busyMs, t.paidMs)}** | ` +
      `**${t.busyMs ? `$${(t.tagged / (t.busyMs / MIN)).toFixed(4)}` : "–"}** | ${untagged ? `**${usd(t.untagged)}**` : "–"} |`,
  );
  return lines.join("\n");
}

export function renderOverhead(days) {
  const sum = (k) => days.reduce((a, d) => a + d[k], 0);
  const paid = sum("paidMs");
  const tagged = sum("tagged");
  const labels = {
    busy: "running a job", startup: "startup (boot → the host's first job)", between: "slot idle on a running host",
    tail: "tail (last job → stop)", unused: "slot never used",
  };
  const lines = ["| where the money went | slot-h | USD | share of tagged |", "|---|--:|--:|--:|"];
  for (const k of KINDS) lines.push(`| ${labels[k]} | ${h1(sum(`${k}Ms`))} | ${usd(sum(`${k}Usd`))} | ${pct(sum(`${k}Usd`), tagged)} |`);
  lines.push(`| no fleet slot paid that day in that region | – | ${usd(sum("unattributed"))} | ${pct(sum("unattributed"), tagged)} |`);
  lines.push(`| **total** | **${h1(paid)}** | **${usd(tagged)}** | 100% |`);
  return lines.join("\n");
}

/** Rows grouped by the given keys, sorted by USD. */
export function rollup(rows, keys) {
  const m = new Map();
  for (const r of rows) {
    const k = keys.map((x) => r[x]).join("|");
    if (!m.has(k)) m.set(k, { ...Object.fromEntries(keys.map((x) => [x, r[x]])), ids: new Set(), jobs: 0, ms: 0, usd: 0 });
    const a = m.get(k);
    for (const id of r.ids ?? []) a.ids.add(id);
    a.jobs = r.ids ? a.ids.size : a.jobs + r.jobs;
    a.ms += r.ms; a.usd += r.usd;
  }
  return [...m.values()].sort((a, b) => b.usd - a.usd);
}

export function renderRollup(rows, keys, tagged) {
  const lines = [
    `| ${keys.join(" | ")} | jobs | job-min | USD | % of tagged |`,
    `|${keys.map(() => "---").join("|")}|--:|--:|--:|--:|`,
  ];
  for (const r of rollup(rows, keys)) {
    lines.push(`| ${keys.map((k) => cell(r[k])).join(" | ")} | ${r.jobs} | ${Math.round(r.ms / MIN)} | ${usd(r.usd)} | ${pct(r.usd, tagged)} |`);
  }
  return lines.join("\n");
}

export function toCsv(rows) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = ["day", "region", "workflow", "lane", "group", "shard", "jobs", "minutes", "usd"];
  const body = [...rows]
    .sort((a, b) => a.day.localeCompare(b.day) || b.usd - a.usd)
    .map((r) => [r.day, r.region, r.workflow, r.lane, r.group, r.shard, r.jobs, (r.ms / MIN).toFixed(2), r.usd.toFixed(4)].map(esc).join(","));
  return [head.join(","), ...body].join("\n") + "\n";
}

// ── GitHub ──────────────────────────────────────────────────────────────────

/**
 * Every run created in [fromMs, toMs). The runs API answers at most 1000
 * results for one `created` query, silently: a busy day has more. So the window
 * is asked an hour at a time, and halved whenever it fills.
 */
export async function listRuns(gh, repo, fromMs, toMs, { stepMs = HOUR } = {}) {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const runs = [];
  const window = async (a, b) => {
    const page = [];
    for (let p = 1; p <= 10; p++) {
      const r = await gh(`/repos/${repo}/actions/runs?created=${iso(a)}..${iso(b - 1000)}&per_page=100&page=${p}`);
      if (!r) throw new Error(`${repo}: no such repository, or this token cannot read its Actions runs`);
      page.push(...r.workflow_runs);
      if (r.workflow_runs.length < 100) return page;
    }
    if (b - a <= 2000) throw new Error(`over 1000 runs created in one second at ${iso(a)}`);
    const mid = a + Math.floor((b - a) / 2000) * 1000;
    return [...(await window(a, mid)), ...(await window(mid, b))];
  };
  for (let a = fromMs; a < toMs; a += stepMs) runs.push(...(await window(a, Math.min(toMs, a + stepMs))));
  return runs;
}

/**
 * How long to pause after an answer, from its rate-limit headers: until the
 * window resets once less than `floor` of the allowance is left, else not at
 * all. A bulk read on a token that something else also uses (the fleet's own
 * scaler did, on 2026-09-29) must leave that something its share.
 */
export function quotaPauseMs(headers, { floor = 0.4, now = Date.now() } = {}) {
  const get = (k) => Number(headers?.get?.(k) ?? headers?.[k]);
  const left = get("x-ratelimit-remaining");
  const limit = get("x-ratelimit-limit");
  const reset = get("x-ratelimit-reset");
  if (!Number.isFinite(left) || !Number.isFinite(limit) || !Number.isFinite(reset) || limit <= 0) return 0;
  return left < floor * limit ? Math.max(0, reset * 1000 - now) + 1000 : 0;
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

export function cached(dir, name, keep, fn) {
  if (!dir) return fn();
  const file = path.join(dir, name);
  if (existsSync(file)) return Promise.resolve(JSON.parse(readFileSync(file, "utf8")));
  return fn().then((v) => {
    if (!keep(v)) return v;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(v));
    return v;
  });
}

/**
 * The fleet's jobs for [since, until] (UTC days, inclusive), each with the
 * host boot its usage line reports where one was read. Only the first and last
 * job of each provisional lifetime have their log read (a host's boot is the
 * same in all of its jobs), and every job of a lifetime whose two ends
 * disagree: a recycled address the gap rule did not catch.
 */
export async function collectFleetJobs({ repo, since, until, label, cache, token, splitGapMs }) {
  const gh = async (p, { raw = false } = {}) => {
    const res = await fetchRetrying(`https://api.github.com${p}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      redirect: "follow",
    });
    const pause = quotaPauseMs(res.headers);
    if (pause) {
      console.error(`fleet-cost: under 40% of the API allowance left; pausing ${Math.round(pause / 1000)} s until it resets`);
      await new Promise((r) => setTimeout(r, pause));
    }
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
    return raw ? res.text() : res.json();
  };
  const jobs = [];
  // From the day BEFORE `since`: a job is billed to the day it ran, but its run
  // is listed by the day it was created, and a run created at 23:55 (or re-run
  // a day later) has jobs on the next day. `attribute` keeps only the window.
  for (let d = Date.parse(`${since}T00:00:00Z`) - DAY; d <= Date.parse(`${until}T00:00:00Z`); d += DAY) {
    const day = dayOf(d);
    // A day whose runs can still change (today, or jobs still running) is
    // never cached: a cache would freeze it half-finished.
    const settled = (list) => d + DAY + HOUR < Date.now() && list.every((j) => j.completed_at || j.conclusion === "skipped");
    const dayJobs = await cached(cache, `jobs-${day}.json`, settled, async () => {
      const runs = await listRuns(gh, repo, d, d + DAY);
      const perRun = await pool(runs, 8, async (run) => {
        const out = [];
        for (let page = 1; ; page++) {
          const r = await gh(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`);
          if (!r) break;
          out.push(...r.jobs.map((j) => ({
            id: j.id, workflow: run.name, name: j.name, labels: j.labels, runner_name: j.runner_name,
            conclusion: j.conclusion, started_at: j.started_at, completed_at: j.completed_at,
          })));
          if (r.jobs.length < 100) break;
        }
        return out;
      });
      return perRun.flat();
    });
    jobs.push(...dayJobs.filter((j) => j.labels?.includes(label) && j.runner_name && j.conclusion !== "skipped"));
  }
  const boot = async (id) => {
    const u = await cached(cache, `usage/${id}.json`, () => true, async () => parseUsage((await gh(`/repos/${repo}/actions/jobs/${id}/logs`, { raw: true })) ?? "") ?? {});
    return Number.isFinite(u.hostBootS) ? u.hostBootS : null;
  };
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const provisional = splitHosts(jobs.map(fleetJob).filter(Boolean), { splitGapMs });
  const ends = provisional.flatMap((h) => [h.jobs[0].id, h.jobs[h.jobs.length - 1].id]);
  await pool([...new Set(ends)], 8, async (id) => { byId.get(id).hostBootS = await boot(id); });
  // Read every job of a lifetime whose ends disagree, or where one end has a
  // boot and the other could not be read: either can hide a recycled address.
  const disagree = provisional.filter((h) => {
    const a = byId.get(h.jobs[0].id).hostBootS;
    const b = byId.get(h.jobs[h.jobs.length - 1].id).hostBootS;
    if (a === null && b === null) return false; // no usage lines that day
    return a === null || b === null || Math.abs(a - b) > 2;
  });
  const inner = disagree.flatMap((h) => h.jobs.map((j) => j.id)).filter((id) => byId.get(id).hostBootS === undefined);
  await pool(inner, 8, async (id) => { byId.get(id).hostBootS = await boot(id); });
  return jobs;
}

// ── main ────────────────────────────────────────────────────────────────────

export function report(jobs, { costs, spot, untagged, lanes, since, until, idleMinutes = 2, slots = 2, marginMinutes = 3, types }) {
  const idleMs = idleMinutes * MIN;
  const fleet = jobs.map(fleetJob).filter(Boolean);
  const { hosts, startupMs } = placeHosts(splitHosts(fleet, { splitGapMs: idleMs + marginMinutes * MIN }), { idleMs });
  const pieces = slotPieces(hosts, { slots });
  const days = [];
  for (let d = Date.parse(`${since}T00:00:00Z`); d <= Date.parse(`${until}T00:00:00Z`); d += DAY) days.push(dayOf(d));
  const result = attribute(pieces, costsByDayRegion(costs), { lane: compileLanes(lanes), days });
  const history = Array.isArray(spot) ? spot.flatMap((x) => x.SpotPriceHistory ?? [x]) : spot?.SpotPriceHistory;
  const bottom = spot ? bottomUp(hosts, spotPricer(history), { types }) : null;
  // The collection reaches a day before the window (a run created then has
  // jobs in it); the counts printed are the window's alone.
  const from = Date.parse(`${since}T00:00:00Z`);
  const to = Date.parse(`${until}T00:00:00Z`) + DAY;
  // `>=`: a zero-length job at the window's first instant has a piece in it.
  const inWindow = hosts.filter((h) => h.end >= from && h.start < to);
  const windowJobs = fleet.filter((j) => j.end >= from && j.start < to);
  return {
    ...result,
    hosts: inWindow.length,
    hostsWithBoot: inWindow.filter((h) => h.startKnown).length,
    startupMs,
    jobs: windowJobs.length,
    unknownRegionJobs: windowJobs.filter((j) => j.region === "unknown").length,
    bottom: bottom?.byDayRegion,
    unpricedHours: bottom?.unpricedHours ?? 0,
    untagged: untagged ? untaggedByDay(untagged) : null,
  };
}

export function render(r, { repo, since, until, label }) {
  const tagged = r.days.reduce((a, d) => a + d.tagged, 0);
  const rate = allInRate(r.days);
  const other = rollup(r.rows.filter((x) => x.lane === "other"), ["group"]);
  const out = [
    `# Fleet cost, ${repo}, ${since}..${until} (UTC)`,
    "",
    `${r.jobs} fleet jobs (label \`${label}\`) on ${r.hosts} host lifetimes; ${r.hostsWithBoot} have a boot time ` +
      `from a usage line, the rest start ${(r.startupMs / 1000).toFixed(0)} s (median startup) before their first job.` +
      (r.unknownRegionJobs ? ` ${r.unknownRegionJobs} job(s) ran on a runner name with no zone and are filed under \`unknown\`.` : "") +
      (r.unpricedHours ? ` ${r.unpricedHours.toFixed(1)} host-hours had no spot price and are bottom-up at the extras only.` : "") +
      (r.days.some((d) => d.pooled)
        ? ` Regions are pooled on ${r.days.filter((d) => d.pooled).map((d) => d.day).join(", ")}: some runner names there carry no zone.`
        : ""),
    "",
    "## Per day",
    "",
    renderDays(r.days, { bottom: r.bottom, untagged: r.untagged }),
    "",
    "## Where the money went",
    "",
    renderOverhead(r.days),
    "",
    "## Per lane",
    "",
    renderRollup(r.rows, ["lane"], tagged),
    "",
    "## Per workflow and lane",
    "",
    renderRollup(r.rows, ["workflow", "lane"], tagged),
    "",
    "## Per lane and shard",
    "",
    renderRollup(r.rows.filter((x) => x.shard), ["lane", "shard"], tagged),
    "",
  ];
  if (other.length) {
    out.push("## Not matched by a lane rule (`other`)", "", "| group | jobs | job-min | USD |", "|---|--:|--:|--:|");
    for (const o of other) out.push(`| ${cell(o.group)} | ${o.jobs} | ${Math.round(o.ms / MIN)} | ${usd(o.usd)} |`);
    out.push("");
  }
  out.push(
    "## Rate for cost-report.yml",
    "",
    rate === null
      ? "No job ran in the window; no rate."
      : `All in, tagged cost ÷ minutes running a job: **$${rate.toFixed(4)} per job-minute**. ` +
          `As the caller's input: \`runner-rates: '{"linux":0.006,"linux_arm":0.005,"windows":0.01,"macos":0.062,"self_hosted":${rate.toFixed(4)}}'\``,
    "",
  );
  return out.join("\n");
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
  );
  const read = (f) => (f ? JSON.parse(readFileSync(f, "utf8")) : null);
  const { repo, since, until = since } = args;
  if (!repo || !since || !args.costs || (!args.jobs && !process.env.GITHUB_TOKEN)) {
    console.error("usage: GITHUB_TOKEN=… fleet-cost.mjs --repo owner/name --since YYYY-MM-DD [--until YYYY-MM-DD] --costs ce-region.json [--spot …] [--untagged …] [--lanes …] [--csv …]");
    process.exit(64);
  }
  const label = args.label ?? "future-pay-ci";
  const idleMinutes = Number(args["idle-minutes"] ?? 2);
  const jobs = args.jobs
    ? read(args.jobs)
    : await collectFleetJobs({
        repo, since, until, label, cache: args.cache, token: process.env.GITHUB_TOKEN,
        splitGapMs: (idleMinutes + Number(args["margin-minutes"] ?? 3)) * MIN,
      });
  const r = report(jobs.filter((j) => !args.jobs || (j.labels?.includes(label) && j.runner_name)), {
    costs: read(args.costs), spot: read(args.spot), untagged: read(args.untagged),
    lanes: read(args.lanes)?.rules ?? read(args.lanes) ?? [], since, until, idleMinutes,
    slots: Number(args.slots ?? 2), marginMinutes: Number(args["margin-minutes"] ?? 3),
    types: args.types?.split(","),
  });
  console.log(render(r, { repo, since, until, label }));
  if (args.csv) writeFileSync(args.csv, toCsv(r.rows));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
