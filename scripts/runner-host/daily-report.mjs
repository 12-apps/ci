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
import { collect, fetchRetrying, hostAndSlot, percentile, summarizeJobs } from "./usage-report.mjs";

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
 * The disks the regions' templates handed out at any moment of `day`, from
 * each template's default-version changes; null when a template changed
 * inside the window and nothing says what it handed out before the first
 * change.
 */
export function disksInEffect(templates, day) {
  const from = `${day}T00:00:00Z`;
  const to = `${day}T23:59:59Z`;
  const out = [];
  for (const t of templates) {
    const changes = t.changes ?? [];
    if (!changes.length) {
      if (t.disk) out.push(t.disk);
      continue;
    }
    const before = changes.filter((c) => c.at < from).pop();
    const start = before ? before.disk : changes[0].previousDisk;
    if (!start) return null;
    out.push(start, ...changes.filter((c) => c.at >= from && c.at <= to && c.disk).map((c) => c.disk));
  }
  return out;
}

/**
 * What looks wrong. `r` is the report (see `main`). Each finding:
 * { severity: "ticket" | "watch", key, title, why, evidence }, worded in
 * pt-BR for the team that reads the PDF and the Slack post.
 */
export function anomalies(r, { budget = 100, offset = -3 } = {}) {
  const out = [];
  const add = (severity, key, title, why, evidence = "") => out.push({ severity, key, title, why, evidence });
  const days = r.days;
  const when = (iso) => localTime(iso, offset);

  // 1. Run rate against the monthly budget.
  const ci = days.map((d) => d.cost?.ci).filter(Number.isFinite);
  if (ci.length) {
    const monthly = mean(ci) * 30;
    if (monthly > budget) {
      const week = ci.reduce((a, b) => a + b, 0);
      const machines = days.reduce((a, d) => a + (d.cost?.categories?.spot ?? 0) + (d.cost?.categories?.["on-demand"] ?? 0), 0);
      add(
        monthly > 1.5 * budget ? "ticket" : "watch",
        "budget",
        `Gasto no ritmo de ${usd(monthly, 0)}/mês — ${br(monthly / budget, 1)}× a meta de ${usd(budget, 0)}`,
        `Média de ${usd(mean(ci))} por dia nos últimos ${ci.length} dias.`,
        `Máquinas são ${usd(machines)} dos ${usd(week)} da semana.`,
      );
    }
  }

  // 2. A day that cost far more per push than the week. Quiet days (weekends)
  // carry the fixed cost over few pushes, so only busy days count.
  const mPush = median(days.map((d) => d.perPush));
  const busy = 0.6 * (median(days.map((d) => d.pushes)) ?? 0);
  for (const d of days) {
    if (mPush && d.perPush > 1.5 * mPush && d.pushes >= Math.max(20, busy)) {
      add("ticket", `per-push-${d.day}`, `${dm(d.day)} custou ${usd(d.perPush)} por push`, `A mediana da semana é ${usd(mPush)}.`, `${d.pushes} pushes, ${usd(d.cost.ci)} no dia.`);
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
        add("ticket", `growth-${c}`, `Custo de ${CATEGORY_LABEL[c] ?? c} subiu de ${usd(early)} para ${usd(late)} por dia`, "Últimos 3 dias contra os anteriores.", v.map((x, i) => `${dm(days[i].day)} ${br(x, 2)}`).join(" · "));
      }
    }
  }

  // 4. Disk performance billed or measured above what any template in effect
  // that day provisioned. A day whose template history is unknown is skipped.
  const iopsDays = [];
  const fastDays = [];
  for (const d of days) {
    const disks = disksInEffect(r.templates, d.day);
    if (!disks) continue;
    const maxIops = Math.max(0, ...disks.map((x) => x.iops ?? 0));
    const maxTp = Math.max(0, ...disks.map((x) => x.throughput ?? 0));
    const iops = d.cost?.categories?.["ebs-iops"] ?? 0;
    if (iops > 0.1 && maxIops <= 3000) iopsDays.push(`${dm(d.day)} ${usd(iops)}`);
    // 25% of slack: the probe samples one-second peaks, and on a 250 MiB/s
    // volume busy days read 270–290 at the p95 with no host on another disk.
    const fast = (d.usage?.jobs ?? []).filter((j) => j.runs >= 5 && maxTp && j.mibpsP95 > maxTp * 1.25);
    if (fast.length) fastDays.push(`${dm(d.day)}: ${fast.length} jobs acima de ${maxTp} MiB/s (máx. ${Math.max(...fast.map((j) => j.mibpsP95))})`);
  }
  if (iopsDays.length) add("ticket", "iops-unprovisioned", "IOPS extra cobrado sem nenhum template pedindo", "O gp3 só cobra IOPS acima de 3000: alguma máquina rodou com um disco que nenhum template descrevia.", iopsDays.join(" · "));
  if (fastDays.length) add("ticket", "throughput-above-template", "Jobs lendo o disco mais rápido do que o template permite", "Sinal de máquina rodando com outro disco.", fastDays.join(" · "));

  // 5. Template changes and drift between regions.
  const disks = new Set(r.templates.map((t) => (t.disk ? `${t.disk.iops}/${t.disk.throughput}/${t.disk.size}` : "none")));
  if (disks.size > 1) add("ticket", "template-drift", "Regiões entregando discos diferentes", "Todas deveriam ter o mesmo disco.", r.templates.map((t) => `${t.region} ${t.disk ? `${t.disk.iops}/${t.disk.throughput}` : "sem template"}`).join(" · "));
  // A raise costs money on every host from then on; a cut is the usual,
  // deliberate direction and only shows in the table.
  const raised = diskChanges(r.templates).filter((c) => c.raised);
  if (raised.length) {
    const fmt = (c) => `${c.regions.join(", ")}: ${when(c.at)} subiu para ${c.disk.iops} IOPS / ${c.disk.throughput} MiB/s (${c.by})${c.back ? `; voltou em ${when(c.back)}` : "; ainda em vigor"}`;
    add("ticket", "template-disk-raised", "O disco do template foi aumentado", "Toda máquina nova passa a custar mais. O padrão é 3000 IOPS / 250 MiB/s.", raised.map(fmt).join(" · "));
  }

  // 6. Paid slot time that ran no job.
  const util = days.filter((d) => d.usage?.idle?.paidHours > 0);
  const low = util.filter((d) => d.usage.idle.runningShare < 0.35);
  if (low.length) {
    const normal = median(util.filter((d) => d.usage.idle.runningShare >= 0.35).map((d) => d.usage.idle.runningShare));
    add(
      "ticket",
      "utilization",
      "Máquinas ligadas sem rodar job",
      `Só ${low.map((d) => `${pct(d.usage.idle.runningShare)} em ${dm(d.day)}`).join(", ")} do tempo pago rodou job${normal ? ` (nos outros dias, ${pct(normal)})` : ""}.`,
      low.map((d) => `${dm(d.day)}: ${br(d.usage.idle.paidHours, 0)} h pagas, ${br(d.usage.idle.runningHours, 0)} h rodando`).join(" · ") + " — janela amostrada",
    );
  }
  const perJobHour = util.map((d) => d.usage.idle.paidHours / Math.max(d.usage.idle.runningHours, 0.1));
  const mRatio = median(perJobHour);
  util.forEach((d, i) => {
    if (mRatio && perJobHour[i] > 1.4 * mRatio) add("watch", `slot-hours-${d.day}`, `${dm(d.day)}: ${br(perJobHour[i], 1)} h pagas por hora de job`, `O normal da semana é ${br(mRatio, 1)}.`);
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
    add("watch", "slower-jobs", `${slower.length} job(s) mais de 30% mais lentos em ${dm(last.day)}`, "", slower.slice(0, 5).map((j) => `${jobName(j.group)} ${br(j.base, 1)} → ${br(j.p50, 1)} min`).join(" · "));
  }

  // 8. IO wait creeping up across the heaviest jobs.
  const io = days.map((d) => median((d.usage?.jobs ?? []).slice(0, 15).map((j) => j.ioWaitP95)));
  const firstIo = io.find(Number.isFinite);
  const lastIo = [...io].reverse().find(Number.isFinite);
  if (firstIo && lastIo > 1.5 * firstIo) add("watch", "io-wait", `Espera por disco subiu de ${br(firstIo, 0)}% para ${br(lastIo, 0)}%`, "p95 dos 15 jobs mais pesados.");

  // 9. Full suites dispatched off-hours, and the same branch dispatched again and again.
  const night = r.dispatches.filter((x) => offHours(x.started, { offset }));
  if (night.length) {
    const min = night.reduce((a, x) => a + x.jobMinutes, 0);
    add("ticket", "night-dispatch", `${night.length} suíte(s) completa(s) disparada(s) de madrugada`, `${br(min, 0)} minutos de job fora do horário comercial.`, night.map((x) => `${when(x.started)} ${x.branch} (${RESULT[x.conclusion] ?? x.status})`).join(" · "));
  }
  const byBranchDay = new Map();
  for (const x of r.dispatches) {
    const k = `${x.started.slice(0, 10)} ${x.branch}`;
    byBranchDay.set(k, [...(byBranchDay.get(k) ?? []), x]);
  }
  for (const [k, xs] of byBranchDay) {
    const red = xs.filter((x) => x.conclusion === "failure").length;
    // Mostly at night: the night finding above already names these runs.
    const covered = xs.filter((x) => night.includes(x)).length * 2 >= xs.length;
    if (xs.length >= 3 && !covered) add("ticket", `dispatch-loop-${k}`, `${xs.length} suítes completas no mesmo dia em ${xs[0].branch} (${dm(k.slice(0, 10))})`, `${red} falharam.`, `${br(xs.reduce((a, x) => a + x.jobMinutes, 0), 0)} minutos de job.`);
  }

  // 10. On-demand fallback, egress and NAT — only while it is still happening
  // (any of the last three days); one that stopped earlier is in the table.
  const recent = days.slice(-3);
  const od = recent.filter((d) => {
    const c = d.cost?.categories ?? {};
    const compute = (c.spot ?? 0) + (c["on-demand"] ?? 0);
    return compute > 1 && (c["on-demand"] ?? 0) > 0.15 * compute;
  });
  if (od.length) add("ticket", "on-demand", "Máquinas on-demand acima de 15% do custo de máquina", "A frota pede spot; on-demand é o plano B e custa cerca de 3×.", od.map((d) => `${dm(d.day)} ${usd(d.cost.categories["on-demand"])}`).join(" · "));
  const net = recent.filter((d) => (d.cost?.categories?.egress ?? 0) + (d.cost?.categories?.nat ?? 0) > 1);
  if (net.length) add("ticket", "egress", "Tráfego de saída (egress e NAT) acima de US$ 1 por dia", "Cache e registry deveriam ficar dentro da região.", net.map((d) => `${dm(d.day)} ${usd((d.cost.categories.egress ?? 0) + (d.cost.categories.nat ?? 0))}`).join(" · "));

  // 11. The daily full suite red day after day (the suite routine owns the
  // ticket; the cost here is every red run re-dispatched).
  const mainDays = [...new Set(r.dispatches.filter((x) => x.branch === "main").map((x) => x.started.slice(0, 10)))].sort();
  const green = (d) => r.dispatches.some((x) => x.branch === "main" && x.started.startsWith(d) && x.conclusion === "success");
  let streak = 0;
  for (const d of [...mainDays].reverse()) {
    if (green(d)) break;
    streak++;
  }
  let run = [];
  let firstRed = null;
  for (const d of mainDays) {
    run = green(d) ? [] : [...run, d];
    if (run.length >= 2 && !firstRed) firstRed = run[0];
  }
  if (streak >= 2) add("watch", "suite-red", `A suíte completa no main está vermelha há ${streak} dias`, "A rotina diária da suíte cuida do ticket.");
  else if (firstRed) add("watch", "suite-was-red", "A suíte completa no main ficou vermelha dias seguidos", `Desde ${dm(firstRed)}; já voltou a passar.`);

  // 12. Memory kills and queue waits.
  const ooms = days.flatMap((d) => (d.usage?.jobs ?? []).filter((j) => j.oom > 0).map((j) => `${dm(d.day)} ${jobName(j.group)} ×${j.oom}`));
  if (ooms.length) add("watch", "oom", "Jobs mortos por falta de memória", "", ooms.slice(0, 6).join(" · "));
  for (const d of days) if (d.usage?.queueP90s > 60) add("watch", `queue-${d.day}`, `${dm(d.day)}: jobs esperaram ${d.usage.queueP90s}s por máquina (p90)`, "");

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "ticket" ? -1 : 1));
}

/**
 * Default-disk changes that moved IOPS or throughput, one entry per minute
 * and disk across regions (a deploy changes every region at once), with
 * whether it raised the disk and when the earlier disk came back.
 */
export function diskChanges(templates) {
  const all = templates.flatMap((t) => (t.changes ?? []).map((c) => ({ ...c, region: t.region })));
  const moved = all.filter((c) => c.disk && c.previousDisk && (c.disk.iops !== c.previousDisk.iops || c.disk.throughput !== c.previousDisk.throughput));
  // One deploy reaches the regions a minute or two apart.
  const groups = [];
  for (const c of moved.sort((x, y) => x.at.localeCompare(y.at))) {
    const back = all.find((x) => x.region === c.region && x.at > c.at && x.disk && x.disk.iops === c.previousDisk.iops && x.disk.throughput === c.previousDisk.throughput);
    let g = groups.find((x) => x.by === c.by && x.disk.iops === c.disk.iops && x.disk.throughput === c.disk.throughput && Date.parse(c.at) - Date.parse(x.at) <= 10 * 60_000);
    if (!g) {
      g = { at: c.at, by: c.by, disk: c.disk, previousDisk: c.previousDisk, regions: [], back: null };
      g.raised = (c.disk.iops ?? 0) > (c.previousDisk.iops ?? 0) || (c.disk.throughput ?? 0) > (c.previousDisk.throughput ?? 0);
      groups.push(g);
    }
    if (!g.regions.includes(c.region)) g.regions.push(c.region);
    if (back && (!g.back || back.at > g.back)) g.back = back.at;
  }
  return groups;
}

// ── HTML ────────────────────────────────────────────────────────────────────

const CATEGORY_LABEL = {
  spot: "máquinas spot",
  "on-demand": "máquinas on-demand",
  "ebs-storage": "disco (espaço)",
  "ebs-iops": "disco (IOPS extra)",
  "ebs-throughput": "disco (MiB/s extra)",
  "snapshots-images": "imagens e snapshots",
  egress: "tráfego de saída",
  nat: "NAT",
  "public-ip": "IPs públicos",
  other: "outros",
};
// The daily chart folds the categories into four a reader can tell apart.
const GROUPS = [
  { label: "Máquinas", color: "#2a78d6", cats: ["spot", "on-demand"] },
  { label: "Disco e imagens", color: "#eb6834", cats: ["ebs-storage", "ebs-iops", "ebs-throughput", "snapshots-images"] },
  { label: "Rede", color: "#1baf7a", cats: ["egress", "nat", "public-ip"] },
  { label: "Outros", color: "#eda100", cats: ["other"] },
];
const RESULT = { success: "passou", failure: "falhou", cancelled: "cancelada", timed_out: "estourou o tempo" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** A number the Brazilian way: 1.234,5. */
const br = (x, digits = 2) => (Number.isFinite(x) ? x.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "–");
const usd = (x, digits = 2) => (Number.isFinite(x) ? `US$ ${br(x, digits)}` : "–");
const pct = (x) => (Number.isFinite(x) ? `${Math.round(100 * x)}%` : "–");
const dm = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
/** `2026-10-02T03:44Z` at UTC-3 → `02/10 00:44`. */
export const localTime = (iso, offsetHours) => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso ?? "");
  const t = new Date(ms + offsetHours * HOUR).toISOString();
  return `${t.slice(8, 10)}/${t.slice(5, 7)} ${t.slice(11, 16)}`;
};
/** `CI / Tests / Unit Tests · shard 1/4` → `Tests / Unit Tests · shard 1/4`. */
const jobName = (group) => group.replace(/^CI \/ /, "");
const groupCost = (d, g) => g.cats.reduce((a, c) => a + (d.cost?.categories?.[c] ?? 0), 0);

const table = (head, rows, { num = [] } = {}) =>
  `<table><thead><tr>${head.map((h, i) => `<th${num.includes(i) ? ' class="n"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${num.includes(i) ? ' class="n"' : ""}>${c?.html ?? esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;

/** A rect whose top corners are rounded (the data end of a column). */
const topRounded = (x, y, w, h, r) => {
  const k = Math.min(r, h, w / 2);
  return `<path d="M${x},${y + h}V${y + k}Q${x},${y} ${x + k},${y}H${x + w - k}Q${x + w},${y} ${x + w},${y + k}V${y + h}Z"`;
};

/** Columns per day; `segments(d)` returns [{value, color}] bottom-up. */
function columns(days, segments, { height = 170, label = (v) => br(v, 2) } = {}) {
  const width = 680;
  const top = 18;
  const bottom = 22;
  const plotH = height - top - bottom;
  const totals = days.map((d) => segments(d).reduce((a, s) => a + s.value, 0));
  const max = Math.max(...totals, 0.01) * 1.08;
  const slot = width / days.length;
  const bar = Math.min(56, slot * 0.6);
  const y = (v) => top + plotH - (v / max) * plotH;
  const grid = [0.5, 1].map((f) => `<line x1="0" x2="${width}" y1="${y(max * f / 1.08)}" y2="${y(max * f / 1.08)}" class="grid"/>`).join("");
  const cols = days
    .map((d, i) => {
      const x = i * slot + (slot - bar) / 2;
      let base = 0;
      const segs = segments(d).filter((s) => s.value > 0);
      const shapes = segs
        .map((s, j) => {
          const y0 = y(base);
          base += s.value;
          const y1 = y(base);
          const h = Math.max(0, y0 - y1 - (j < segs.length - 1 ? 2 : 0));
          const top1 = j < segs.length - 1 ? y1 + 2 : y1;
          return j === segs.length - 1
            ? `${topRounded(x, top1, bar, h, 4)} fill="${s.color}"/>`
            : `<rect x="${x}" y="${top1}" width="${bar}" height="${h}" fill="${s.color}"/>`;
        })
        .join("");
      return `${shapes}<text x="${x + bar / 2}" y="${y(totals[i]) - 5}" class="val">${esc(label(totals[i]))}</text><text x="${x + bar / 2}" y="${height - 6}" class="day">${dm(d.day)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img">${grid}<line x1="0" x2="${width}" y1="${y(0)}" y2="${y(0)}" class="axis"/>${cols}</svg>`;
}

/** One horizontal bar per day: share of paid time that ran a job. */
function utilizationBars(days) {
  const rows = days.filter((d) => d.usage?.idle?.paidHours > 0);
  if (!rows.length) return "<p class=\"muted\">Sem medição de uso nesta semana.</p>";
  const width = 680;
  const rowH = 22;
  const labelW = 54;
  const barW = width - labelW - 150;
  const body = rows
    .map((d, i) => {
      const u = d.usage.idle;
      const y = i * rowH + 4;
      const run = barW * u.runningShare;
      return `<text x="0" y="${y + 12}" class="lbl">${dm(d.day)}</text>
<rect x="${labelW}" y="${y}" width="${Math.max(run - 1, 0)}" height="14" fill="#2a78d6"/>
<rect x="${labelW + run + 1}" y="${y}" width="${Math.max(barW - run - 1, 0)}" height="14" fill="#d9d8d3"/>
<text x="${labelW + barW + 8}" y="${y + 12}" class="lbl"><tspan class="strong">${pct(u.runningShare)}</tspan> de ${br(u.paidHours, 0)} h pagas</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${rows.length * rowH + 6}" class="chart" role="img">${body}</svg>`;
}

/** The report as printable pages: summary first, detail after. Pure. */
export function renderHtml(r) {
  const days = r.days;
  const offset = r.offset ?? -3;
  const sum = (f) => days.reduce((a, d) => a + (f(d) ?? 0), 0);
  const ciTotal = sum((d) => d.cost?.ci);
  const merges = sum((d) => d.merges);
  const pushes = sum((d) => d.pushes);
  const monthly = (ciTotal / Math.max(days.length, 1)) * 30;
  const estimated = days.filter((d) => d.cost?.estimated).map((d) => dm(d.day));
  const tickets = r.anomalies.filter((a) => a.severity === "ticket");
  const watch = r.anomalies.filter((a) => a.severity === "watch");
  const last = days[days.length - 1];

  const kpi = (value, label, note = "") => `<div class="kpi"><div class="kv">${esc(value)}</div><div class="kl">${esc(label)}</div>${note ? `<div class="kn">${esc(note)}</div>` : ""}</div>`;
  const legend = GROUPS.map((g) => `<span class="key"><i style="background:${g.color}"></i>${esc(g.label)}</span>`).join("");
  const finding = (a, i) => `<li><div class="ft"><b>${i + 1}.</b> ${esc(a.title)}</div>${a.why ? `<div class="fw">${esc(a.why)}</div>` : ""}${a.evidence ? `<div class="fe">${esc(a.evidence)}</div>` : ""}</li>`;

  // Jobs: the heaviest of the last measured day, against their own week.
  const measured = [...days].reverse().find((d) => d.usage?.jobs?.length);
  const jobRows = (measured?.usage?.jobs ?? []).slice(0, 12).map((j) => {
    const prior = days.filter((d) => d !== measured).map((d) => d.usage?.jobs?.find((x) => x.group === j.group)?.p50).filter(Number.isFinite);
    const base = median(prior);
    const delta = base ? (j.p50 - base) / base : null;
    const deltaCell = delta === null ? "–" : { html: `<span class="${delta > 0.3 ? "up" : delta < -0.1 ? "down" : ""}">${delta > 0 ? "+" : ""}${Math.round(100 * delta)}%</span>` };
    return [jobName(j.group), j.runs, br(base, 1), br(j.p50, 1), deltaCell, `${br(j.ioWaitP95, 0)}%`, j.mibpsP95 ?? "–"];
  });

  const disks = new Set(r.templates.map((t) => (t.disk ? `${t.disk.type} ${t.disk.size} GB, ${t.disk.iops} IOPS, ${t.disk.throughput} MiB/s` : "sem template")));
  const diskNow =
    disks.size === 1
      ? `<p>Hoje as ${r.templates.length} regiões entregam o mesmo disco: <b>${esc([...disks][0])}</b>.</p>`
      : table(["região", "disco"], r.templates.map((t) => [t.region, t.disk ? `${t.disk.type} ${t.disk.size} GB, ${t.disk.iops} IOPS, ${t.disk.throughput} MiB/s` : "sem template"]));
  const moves = diskChanges(r.templates);

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Frota de CI ${esc(r.until)}</title><style>
@page { size: A4; margin: 14mm 14mm 12mm; }
:root { --ink: #1d1d1b; --ink2: #52514e; --muted: #8a8984; --line: #e4e3df; --soft: #f6f5f2; --red: #c62828; --amber: #9a6700; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: var(--ink); font: 11px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 13px; margin: 18px 0 6px; }
.sub, .muted { color: var(--ink2); }
.note { color: var(--muted); font-size: 9.5px; margin: 4px 0 0; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 14px 0 4px; }
.kpi { background: var(--soft); border-radius: 8px; padding: 10px 12px; }
.kv { font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; }
.kl { color: var(--ink2); }
.kn { color: var(--muted); font-size: 9.5px; margin-top: 2px; }
.legend { display: flex; gap: 14px; margin: 2px 0 4px; color: var(--ink2); }
.key i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.chart { width: 100%; height: auto; display: block; }
.chart .grid { stroke: var(--line); stroke-width: 1; }
.chart .axis { stroke: #b9b8b3; stroke-width: 1; }
.chart text { font: 10px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; fill: var(--ink2); }
.chart .val { text-anchor: middle; fill: var(--ink); font-weight: 600; }
.chart .day { text-anchor: middle; }
.chart .strong { fill: var(--ink); font-weight: 600; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
ol.findings { list-style: none; padding: 0; margin: 0; }
ol.findings li { border-left: 3px solid var(--red); background: #fdf6f5; padding: 7px 10px; margin-bottom: 6px; border-radius: 0 6px 6px 0; page-break-inside: avoid; }
ol.watch li { border-left-color: #c9a227; background: #fdfaf0; }
.ft { font-weight: 600; } .fw { color: var(--ink2); } .fe { color: var(--muted); font-size: 9.5px; margin-top: 2px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th { text-align: left; font-weight: 600; color: var(--ink2); border-bottom: 1px solid #c9c8c3; padding: 4px 6px; }
td { border-bottom: 1px solid var(--line); padding: 4px 6px; vertical-align: top; }
th.n, td.n { text-align: right; white-space: nowrap; }
.up { color: var(--red); font-weight: 600; } .down { color: #2e7d32; }
.tag { display: inline-block; font-size: 9px; padding: 0 5px; border-radius: 8px; background: #fde8e6; color: var(--red); margin-left: 4px; }
.page { page-break-before: always; }
ul.plain { margin: 4px 0; padding-left: 16px; }
</style></head><body>

<h1>Frota de CI — ${esc(r.repo)}</h1>
<div class="sub">Semana de ${dm(days[0].day)} a ${dm(last.day)} · gerado em ${esc(localTime(r.generated, offset))} (Brasília)</div>

<div class="kpis">
${kpi(usd(ciTotal), "gasto em 7 dias")}
${kpi(`${usd(monthly, 0)}/mês`, "ritmo de gasto", `meta ${usd(r.budget, 0)} · ${br(monthly / r.budget, 1)}× acima`)}
${kpi(usd(ciTotal / Math.max(merges, 1)), "por merge", `${merges} merges`)}
${kpi(usd(ciTotal / Math.max(pushes, 1)), "por push de PR", `${pushes} pushes`)}
</div>

<h2>Gasto por dia (US$)</h2>
<div class="legend">${legend}</div>
${columns(days, (d) => GROUPS.map((g) => ({ value: groupCost(d, g), color: g.color })), { label: (v) => br(v, 0) })}
${estimated.length ? `<p class="note">${estimated.join(" e ")}: valores provisórios da AWS, ainda podem mudar.</p>` : ""}

<h2>O que investigar</h2>
${tickets.length ? `<ol class="findings">${tickets.map(finding).join("")}</ol>` : '<p class="muted">Nada fora do padrão.</p>'}
${watch.length ? `<h2>Para observar</h2><ol class="findings watch">${watch.map(finding).join("")}</ol>` : ""}

<div class="page"></div>
<h2>Dia a dia</h2>
${table(
  ["dia", "merges", "pushes de PR", "gasto", "por merge", "por push"],
  days.map((d) => [dm(d.day) + (d.cost?.estimated ? " *" : ""), d.merges, d.pushes, usd(d.cost?.ci), usd(d.perMerge), usd(d.perPush)]),
  { num: [1, 2, 3, 4, 5] },
)}
<p class="note">Gasto = conta AWS menos impostos, Route 53 e ${usd(r.baseline)}/dia que a conta custa sem CI. Merges = PRs mesclados no dia (UTC). Pushes = execuções do ${esc(r.workflow)} disparadas por PR.${estimated.length ? " * provisório." : ""}</p>

<h2>Custo por merge (US$)</h2>
${columns(days, (d) => [{ value: d.perMerge ?? 0, color: "#2a78d6" }], { height: 130 })}

<h2>Para onde foi o dinheiro (US$ por dia)</h2>
${table(
  ["", ...days.map((d) => dm(d.day)), "semana"],
  Object.keys(CATEGORY_LABEL)
    .map((c) => [c, sum((d) => d.cost?.categories?.[c])])
    .filter(([, total]) => total >= 0.05)
    .sort((a, b) => b[1] - a[1])
    .map(([c, total]) => [CATEGORY_LABEL[c], ...days.map((d) => br(d.cost?.categories?.[c] ?? 0, 2)), br(total, 2)]),
  { num: days.map((_, i) => i + 1).concat(days.length + 1) },
)}

<h2>Quanto do tempo pago das máquinas rodou job</h2>
<div class="legend"><span class="key"><i style="background:#2a78d6"></i>rodando job</span><span class="key"><i style="background:#d9d8d3"></i>ligada sem job (subindo, entre jobs, esperando desligar)</span></div>
${utilizationBars(days)}
<p class="note">Medido das ${esc(r.window)} UTC de cada dia, com o tempo de cada máquina e de cada job cortado nessa janela (amostra: ler o log de cada job do dia inteiro estouraria o limite da API do GitHub). Máquina que ligou e não rodou nenhum job não aparece, então o ocioso real é um pouco maior.</p>

<div class="page"></div>
<h2>Jobs mais pesados em ${measured ? dm(measured.day) : "–"}</h2>
${jobRows.length ? table(["job", "execuções", "duração típica (min)", "neste dia (min)", "variação", "espera de disco", "disco MiB/s"], jobRows, { num: [1, 2, 3, 4, 5, 6] }) : '<p class="muted">Sem medição de uso.</p>'}
<p class="note">Duração típica = mediana dos outros dias da semana. Espera de disco e MiB/s = p95. Mesma janela amostrada.</p>

<h2>Disco das máquinas</h2>
${diskNow}
${moves.length ? `<ul class="plain">${moves.map((c) => `<li>${esc(localTime(c.at, offset))}: ${esc(c.regions.join(", "))} ${c.raised ? "<b>subiu</b>" : "desceu"} de ${c.previousDisk.iops}/${c.previousDisk.throughput} para ${c.disk.iops}/${c.disk.throughput} (IOPS/MiB/s), por ${esc(c.by)}</li>`).join("")}</ul>` : '<p class="muted">Nenhuma mudança de disco na semana.</p>'}

<h2>Suítes completas disparadas</h2>
${
  r.dispatches.length
    ? table(
        ["quando (Brasília)", "branch", "quem", "resultado", "duração", "minutos de job"],
        r.dispatches.map((x) => [
          { html: `${esc(localTime(x.started, offset))}${offHours(x.started, { offset }) ? '<span class="tag">madrugada</span>' : ""}` },
          x.branch,
          x.actor === "github-actions[bot]" ? "agendada" : x.actor,
          RESULT[x.conclusion] ?? x.status,
          `${br(x.wallMinutes, 0)} min`,
          br(x.jobMinutes, 0),
        ]),
        { num: [4, 5] },
      )
    : '<p class="muted">Nenhuma.</p>'
}
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

/**
 * How much of the paid slot time inside [from, to) ran a job.
 *
 * Every host is paid per slot from its boot until IDLE minutes after its last
 * job; both that stretch and every job are CUT to the window before they are
 * summed. Counting a host from its boot instead charges the window with the
 * hours it spent, before the window, running jobs the window never read
 * (2026-10-03: that made a long-lived fleet look 27% busy). `records` must
 * hold every job that ran in the window, so the collection starts before it.
 * A host that ran no job at all never shows up: idle is a slight UNDER-count.
 */
export function windowUtilization(records, from, to, { slots = 2, idleMinutes = 2 } = {}) {
  const clip = (a, b) => Math.max(0, Math.min(b, to) - Math.max(a, from));
  const hosts = new Map();
  let busy = 0;
  for (const { usage: u } of records) {
    const hs = hostAndSlot(u.runner);
    if (!hs || !Number.isFinite(u.hostBootS) || !Number.isFinite(u.startMs)) continue;
    const key = `${hs.host}@${u.hostBootS}`;
    const h = hosts.get(key) ?? { boot: u.hostBootS * 1000, end: 0, slots: new Set() };
    h.end = Math.max(h.end, u.startMs + u.wallMs);
    h.slots.add(hs.slot);
    hosts.set(key, h);
    busy += clip(u.startMs, u.startMs + u.wallMs);
  }
  let paid = 0;
  let live = 0;
  for (const h of hosts.values()) {
    const p = clip(h.boot, h.end + idleMinutes * 60_000);
    if (p > 0) live++;
    paid += p * Math.max(slots, h.slots.size);
  }
  return { hosts: live, paidHours: paid / HOUR, runningHours: busy / HOUR, runningShare: paid ? busy / paid : 0 };
}

/**
 * The window's usage, reduced to what the report shows. `records` reach back
 * before `from` (see windowUtilization); job statistics count only the jobs
 * that started inside the window.
 */
export function reduceUsage({ runs, jobs, records }, { from, to, slots = 2, idleMinutes = 2 } = {}) {
  const inside = records.filter((r) => r.startedMs >= from && r.startedMs < to);
  const rows = summarizeJobs(inside);
  const waits = inside.map((r) => r.queuedMs).filter(Number.isFinite);
  return {
    runs,
    jobsCount: inside.length,
    jobs: rows.map((j) => ({
      group: j.group,
      runs: j.runs,
      jobMinutes: j.jobMinutes,
      p50: j.wallMinP50,
      ioWaitP95: j.ioWaitPctP95,
      mibpsP95: j.peakDiskMiBpsP95,
      oom: j.oomKills,
    })),
    idle: windowUtilization(records, from, to, { slots, idleMinutes }),
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
    // Runs created up to an hour before the window still run jobs inside it,
    // and a host's last job may come from a run created just after it.
    const from = Date.parse(`${day}T${hh(fromH)}:00:00Z`);
    const to = Date.parse(`${day}T${hh(toH)}:00:00Z`);
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const collected = await collect({ repo, since: iso(from - HOUR), until: iso(to + 15 * 60_000), label });
    const usage = reduceUsage(collected, { from, to, slots: Number(args.slots ?? 2), idleMinutes: Number(args["idle-minutes"] ?? 2) });
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
  for (const a of report.anomalies) console.log(`${a.severity.toUpperCase()}\t${a.title}\t${[a.why, a.evidence].filter(Boolean).join(" ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
