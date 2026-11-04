/**
 * The daily refresh: fold one full run's measurements into a lane's ledger,
 * and say what in that run is too slow.
 *
 * Pure: the CLI (`refresh.mjs`) does the I/O — artifacts, the Actions API, the
 * checkout — and hands this module plain data.
 *
 * ## The merge
 *
 * The daily run measures every item it ran, so a measured item takes its NEW
 * cost outright: "recalculated every day" means today's number, not an average
 * that takes a week to notice a file doubled. An item the run did not measure
 * (its leg was lost, or it was skipped) keeps its old cost while it still
 * exists, and an item that no longer exists is dropped, so the ledger never
 * accumulates ghosts.
 *
 * ## Concurrency
 *
 * A leg's summed per-item time is not its wall time: vitest runs files in a
 * pool. The ratio is measured, never configured: Σ item seconds over Σ test
 * STEP seconds, over the legs of the same run that left both a report and a
 * step time. With no such leg (the API was unavailable, every artifact expired)
 * the previous ratio is kept.
 *
 * ## What is reported
 *
 *   - every item slower than `slowFileSeconds` (the owner's 3 minutes): either
 *     a file with too many tests that should be split, or a feature that got
 *     slow — the report cannot tell which, so it says both;
 *   - every leg whose test step ran past `targetSeconds`;
 *   - the cap: when a full-width run would want more legs than `maxShards`.
 */
import { round1 } from "./timings.mjs";

/**
 * @param {object} ledger            the current ledger (timings.mjs shape)
 * @param {Map<string,{seconds:number,tests:number|null}>} measured  this run's items
 * @param {object} opts
 * @param {(item: string) => boolean} opts.exists  whether an item still exists in the tree
 * @param {{measured:number, wall:number}} [opts.paired]  summed item seconds and test-step seconds
 *   over the legs that left both a report and a step time
 * @param {object} [opts.measuredMeta]   { run, sha, at } to stamp the ledger with
 */
export function mergeLedger(ledger, measured, { exists, paired = { measured: 0, wall: 0 }, measuredMeta = null } = {}) {
  const files = new Map();
  const changes = { added: [], removed: [], updated: 0, kept: 0 };
  for (const [item, row] of measured) {
    if (!exists(item)) continue;
    if (!ledger.files.has(item)) changes.added.push(item);
    else changes.updated += 1;
    files.set(item, row.seconds);
  }
  for (const [item, seconds] of ledger.files) {
    if (files.has(item)) continue;
    if (exists(item)) {
      files.set(item, seconds);
      changes.kept += 1;
    } else {
      changes.removed.push(item);
    }
  }
  const concurrency =
    paired.measured > 0 && paired.wall > 0 ? Math.max(round2(paired.measured / paired.wall), 0.1) : ledger.concurrency;
  return {
    ledger: { ...ledger, concurrency, ...(measuredMeta ? { measured: measuredMeta } : {}), files },
    changes: { ...changes, added: changes.added.sort(), removed: changes.removed.sort() },
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * What in this run deserves a human's eye. Never throws, never decides: the
 * caller turns it into annotations and a summary.
 */
export function slowReport(lane, measured, { slowFileSeconds, targetSeconds, stepSeconds = [], ledger, maxShards }) {
  const slowFiles = [...measured.entries()]
    .filter(([, row]) => row.seconds > slowFileSeconds)
    .sort(([, a], [, b]) => b.seconds - a.seconds)
    .map(([item, row]) => ({ lane, item, seconds: round1(row.seconds), tests: row.tests }));
  // `stepSeconds`: `{ leg, seconds }` per leg, or plain numbers in leg order.
  const slowLegs = stepSeconds
    .map((row, i) => (typeof row === "number" ? { leg: i + 1, seconds: row } : row))
    .map((row) => ({ lane, leg: row.leg, seconds: round1(row.seconds) }))
    .filter((leg) => leg.seconds > targetSeconds);
  const total = [...ledger.files.values()].reduce((a, b) => a + b, 0) / (ledger.concurrency || 1);
  const fullWidthWants = Math.max(1, Math.ceil(total / targetSeconds));
  const cap =
    Number.isFinite(maxShards) && maxShards > 0
      ? { maxShards, fullWidthWants, binding: fullWidthWants > maxShards, fullWidthSeconds: round1(total) }
      : null;
  return { lane, slowFiles, slowLegs, cap };
}

const minutes = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;

/** GitHub workflow commands for the run's annotations. One line each. */
export function annotations(report, { targetSeconds, slowFileSeconds }) {
  const lines = [];
  for (const f of report.slowFiles) {
    const tests = f.tests == null ? "" : ` (${f.tests} test(s))`;
    lines.push(
      `::warning file=${f.item},title=slow test file (${report.lane})::${f.item} took ${minutes(f.seconds)}${tests}, ` +
        `over the ${minutes(slowFileSeconds)} a single file may take. Split it into smaller files, or look for what in it ` +
        `(or in the feature it covers) got slow.`,
    );
  }
  for (const leg of report.slowLegs) {
    lines.push(
      `::warning title=slow leg (${report.lane})::${report.lane} leg ${leg.leg} ran its tests for ${minutes(leg.seconds)}, ` +
        `over the ${minutes(targetSeconds)} target.`,
    );
  }
  if (report.cap?.binding) {
    lines.push(
      `::warning title=shard cap binds (${report.lane})::a full-width ${report.lane} run measures ` +
        `${minutes(report.cap.fullWidthSeconds)} and wants ${report.cap.fullWidthWants} leg(s) of ${minutes(targetSeconds)}, ` +
        `but its cap is ${report.cap.maxShards}. Raise the lane's max shards.`,
    );
  }
  return lines;
}

/** The job-summary block for every lane of the refresh. */
export function summaryMarkdown(results, { targetSeconds, slowFileSeconds }) {
  const out = ["### Lane timings", "", `Target: **${minutes(targetSeconds)}** of tests per leg · a file is slow past **${minutes(slowFileSeconds)}**.`, ""];
  out.push("| lane | items measured | ledger items | concurrency | full width | legs wanted / cap | slow files | slow legs |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const cap = r.report.cap;
    out.push(
      `| ${r.lane} | ${r.measuredCount} | ${r.ledgerCount} | ${r.concurrency} | ${cap ? minutes(cap.fullWidthSeconds) : "—"} | ` +
        `${cap ? `${cap.fullWidthWants} / ${cap.maxShards}${cap.binding ? " ⚠️" : ""}` : "—"} | ${r.report.slowFiles.length} | ${r.report.slowLegs.length} |`,
    );
  }
  const slow = results.flatMap((r) => r.report.slowFiles);
  if (slow.length) {
    out.push("", "#### Slow files", "", "A file this slow either holds too many tests and should be split, or covers something that got slow.", "");
    out.push("| lane | file | time | tests |", "|---|---|---|---|");
    for (const f of slow) out.push(`| ${f.lane} | \`${f.item}\` | ${minutes(f.seconds)} | ${f.tests ?? "—"} |`);
  }
  const legs = results.flatMap((r) => r.report.slowLegs);
  if (legs.length) {
    out.push("", "#### Legs over the target", "", "| lane | leg | test step |", "|---|---|---|");
    for (const l of legs) out.push(`| ${l.lane} | ${l.leg} | ${minutes(l.seconds)} |`);
  }
  for (const r of results.filter((x) => x.missing?.length)) {
    out.push("", `_${r.lane}: no report from ${r.missing.join(", ")}; those items kept yesterday's cost._`);
  }
  return `${out.join("\n")}\n`;
}
