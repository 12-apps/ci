#!/usr/bin/env node
// What each kind of job uses, what slot size it fits, and how much of every
// fleet host's paid time ran a job.
//
//   GITHUB_TOKEN=… node usage-report.mjs --repo owner/name --since 2026-09-29 \
//     [--until 2026-09-30] [--label future-pay-ci] [--slots 2] [--idle-minutes 2]
//
// Reads the `ci-runner-usage` line job-usage.sh prints at the end of every
// fleet job, from the logs GitHub keeps for 90 days, and prints markdown.
//
// ## Fits
//
// A job fits a memory tier when its LARGEST working set seen, plus 25%, is
// under it. The largest rather than a percentile: a job that runs out of memory
// once in twenty runs is a flaky job, and nobody will blame the slot size.
// Cores are reported, not fitted: whether a job finishes as fast on fewer cores
// is measured by running it on fewer cores (cpuWaitPct only says whether it was
// already waiting for CPU on the cores it had).
//
// ## Idle
//
// Per host, a slot is paid from the host's boot to the moment it stops, which is
// its last job's end plus the idle wait (IDLE_MINUTES on the scaler). That time
// splits into:
//   - running a job;
//   - startup: boot to the slot's first job (image, registration, queueing);
//   - between jobs: one job's end to the next one's start on the same slot
//     (container teardown, a new JIT runner, waiting to be handed a job);
//   - tail: the slot's last job to the host's stop;
//   - never used: a slot that ran nothing at all.
// Boot is read from the host's uptime, so the minute or so before the kernel
// runs (billed from `pending`) is not counted anywhere: the paid total here is
// a slight UNDER-count.

import { pathToFileURL } from "node:url";

export const TIERS_GIB = [4, 8, 16, 32, 64];
const HEADROOM = 1.25;
const USAGE = /ci-runner-usage (\{.*\})\s*$/m;

/** The usage record in one job's log text, or null. */
export function parseUsage(log) {
  const m = USAGE.exec(log.replace(/\r/g, ""));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Matrix legs of one job share a row: `Unit (3/8)` and `Unit (5/8)` → `Unit (#/#)`. */
export function jobGroup(workflow, name) {
  return `${workflow} / ${name.replace(/\(([^)]*)\)/g, (_, inner) => `(${inner.replace(/\d+/g, "#")})`)}`;
}

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

/** The smallest memory tier the job's largest working set fits in, with headroom. */
export function fitTier(maxWorkingSetMiB, tiers = TIERS_GIB) {
  const need = (maxWorkingSetMiB * HEADROOM) / 1024;
  return tiers.find((t) => need <= t) ?? null;
}

/** One row per job group. `records`: {group, usage}. */
export function summarizeJobs(records) {
  const byGroup = new Map();
  for (const r of records) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push(r.usage);
  }
  const rows = [];
  for (const [group, us] of byGroup) {
    const col = (k) => us.map((u) => u[k]);
    const maxWs = Math.max(...col("peakWorkingSetMiB"));
    rows.push({
      group,
      runs: us.length,
      wallMinP50: percentile(col("wallMs"), 50) / 60000,
      jobMinutes: col("wallMs").reduce((a, b) => a + b, 0) / 60000,
      avgCoresP50: percentile(col("avgCores"), 50),
      peakCoresP95: percentile(col("peakCores"), 95),
      cpuWaitPctP50: percentile(col("cpuWaitPct"), 50),
      workingSetMiBP95: percentile(col("peakWorkingSetMiB"), 95),
      workingSetMiBMax: maxWs,
      fitsGiB: fitTier(maxWs),
      ioWaitPctP95: percentile(col("ioWaitPct"), 95),
      peakIopsP95: percentile(col("peakIops"), 95),
      peakDiskMiBpsP95: percentile(col("peakDiskMiBps"), 95),
      oomKills: col("oomKills").reduce((a, b) => a + (b || 0), 0),
      // Sent from the fleet is billed as egress, so the total is the cost.
      netTxGiB: col("netTxMiB").reduce((a, b) => a + (b || 0), 0) / 1024,
      netTxMiBP50: percentile(col("netTxMiB"), 50),
    });
  }
  return rows.sort((a, b) => b.jobMinutes - a.jobMinutes);
}

/** `us-east-2a-ip-10-0-1-5-2` → host `us-east-2a-ip-10-0-1-5`, slot `2`. */
export function hostAndSlot(runner) {
  const m = /^(.*)-(\d+)$/.exec(runner ?? "");
  return m ? { host: m[1], slot: m[2] } : null;
}

/**
 * Where every paid slot-second went. `usages`: the parsed records (they carry
 * runner, hostBootS, startMs, wallMs).
 */
export function idleBreakdown(usages, { slots = 2, idleMinutes = 2 } = {}) {
  const hosts = new Map();
  for (const u of usages) {
    const hs = hostAndSlot(u.runner);
    if (!hs || !Number.isFinite(u.hostBootS)) continue;
    // A warm-pool host that was stopped and started again boots twice: each
    // boot is its own paid stretch.
    const key = `${hs.host}@${u.hostBootS}`;
    if (!hosts.has(key)) hosts.set(key, { boot: u.hostBootS * 1000, slots: new Map() });
    const h = hosts.get(key);
    if (!h.slots.has(hs.slot)) h.slots.set(hs.slot, []);
    h.slots.get(hs.slot).push([u.startMs, u.startMs + u.wallMs]);
  }
  const total = { hosts: 0, paid: 0, busy: 0, startup: 0, between: 0, tail: 0, unused: 0 };
  for (const h of hosts.values()) {
    const jobs = [...h.slots.values()];
    const stop = Math.max(...jobs.flat().map(([, end]) => end)) + idleMinutes * 60000;
    const paidPerSlot = stop - h.boot;
    total.hosts += 1;
    total.paid += paidPerSlot * Math.max(slots, h.slots.size);
    total.unused += paidPerSlot * Math.max(0, slots - h.slots.size);
    for (const list of jobs) {
      list.sort((a, b) => a[0] - b[0]);
      total.startup += Math.max(0, list[0][0] - h.boot);
      total.tail += stop - list[list.length - 1][1];
      for (let i = 0; i < list.length; i++) {
        total.busy += list[i][1] - list[i][0];
        if (i > 0) total.between += Math.max(0, list[i][0] - list[i - 1][1]);
      }
    }
  }
  return total;
}

// ── markdown ────────────────────────────────────────────────────────────────

const f1 = (n) => (n === null || n === undefined ? "–" : Number(n).toFixed(1));
const gib = (mib) => (mib === null ? "–" : (mib / 1024).toFixed(1));

export function renderJobs(rows) {
  const head =
    "| job | runs | job-min | p50 min | cores avg p50 | cores peak p95 | CPU wait p50 | mem p95 GiB | mem max GiB | fits | IO wait p95 | IOPS p95 | MiB/s p95 | sent p50 MiB | sent total GiB | OOM |\n" +
    "|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|";
  const body = rows.map(
    (r) =>
      `| ${r.group} | ${r.runs} | ${Math.round(r.jobMinutes)} | ${f1(r.wallMinP50)} | ${f1(r.avgCoresP50)} | ${f1(r.peakCoresP95)} | ${f1(r.cpuWaitPctP50)}% | ${gib(r.workingSetMiBP95)} | ${gib(r.workingSetMiBMax)} | ${r.fitsGiB ? `${r.fitsGiB} GiB` : "> 64"} | ${f1(r.ioWaitPctP95)}% | ${r.peakIopsP95 ?? "–"} | ${r.peakDiskMiBpsP95 ?? "–"} | ${r.netTxMiBP50 ?? "–"} | ${f1(r.netTxGiB)} | ${r.oomKills || ""} |`,
  );
  return [head, ...body].join("\n");
}

export function renderIdle(t) {
  const h = (ms) => (ms / 3_600_000).toFixed(1);
  const pct = (ms) => (t.paid ? ((100 * ms) / t.paid).toFixed(1) : "0.0");
  const rows = [
    ["running a job", t.busy],
    ["startup (boot → first job)", t.startup],
    ["between jobs on a slot", t.between],
    ["tail (last job → stop)", t.tail],
    ["slot never used", t.unused],
  ];
  return [
    `${t.hosts} host boots, ${h(t.paid)} paid slot-hours.`,
    "",
    "| where the paid slot time went | slot-hours | share |",
    "|---|--:|--:|",
    ...rows.map(([k, v]) => `| ${k} | ${h(v)} | ${pct(v)}% |`),
  ].join("\n");
}

// ── GitHub ──────────────────────────────────────────────────────────────────

async function gh(path, { raw = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    redirect: "follow",
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return raw ? res.text() : res.json();
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

async function collect({ repo, since, until, label }) {
  const runs = [];
  for (let page = 1; ; page++) {
    const r = await gh(`/repos/${repo}/actions/runs?created=${since}..${until}&per_page=100&page=${page}`);
    runs.push(...r.workflow_runs);
    if (r.workflow_runs.length < 100) break;
  }
  const jobs = (
    await pool(runs, 8, async (run) => {
      const out = [];
      for (let page = 1; ; page++) {
        const r = await gh(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`);
        out.push(...r.jobs.map((j) => ({ ...j, workflow: run.name })));
        if (r.jobs.length < 100) break;
      }
      return out;
    })
  )
    .flat()
    .filter((j) => j.labels?.includes(label) && j.runner_name && j.conclusion && j.conclusion !== "skipped");
  const records = await pool(jobs, 8, async (j) => {
    const usage = parseUsage((await gh(`/repos/${repo}/actions/jobs/${j.id}/logs`, { raw: true })) ?? "");
    return usage && { group: jobGroup(j.workflow, j.name), usage };
  });
  return { runs: runs.length, jobs: jobs.length, records: records.filter(Boolean) };
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
  );
  const repo = args.repo;
  const since = args.since;
  if (!repo || !since || !process.env.GITHUB_TOKEN) {
    console.error("usage: GITHUB_TOKEN=… usage-report.mjs --repo owner/name --since YYYY-MM-DD [--until YYYY-MM-DD]");
    process.exit(64);
  }
  const until = args.until ?? new Date().toISOString().slice(0, 10);
  const { runs, jobs, records } = await collect({ repo, since, until, label: args.label ?? "future-pay-ci" });
  console.log(`# Fleet job usage, ${repo}, ${since}..${until}\n`);
  console.log(`${runs} runs, ${jobs} fleet jobs, ${records.length} with a usage line.\n`);
  console.log(renderJobs(summarizeJobs(records)));
  console.log("\n## Host time\n");
  console.log(
    renderIdle(
      idleBreakdown(
        records.map((r) => r.usage),
        { slots: Number(args.slots ?? 2), idleMinutes: Number(args["idle-minutes"] ?? 2) },
      ),
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
