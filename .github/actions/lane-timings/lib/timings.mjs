/**
 * The lane-timings ledger, and the two decisions made from it: how many legs a
 * selection is worth, and which item each leg runs.
 *
 * ONE mechanism for every lane that expands a matrix — unit, integration, SPA
 * E2E, Gherkin, and whatever comes next (load tests). Before it, each lane sized
 * itself by COUNTING (`ceil(files / 40)`, `ceil(specs / 26)`,
 * `ceil(features / 4)`), so a selection of two slow features got one leg however
 * long it took, and the two lanes that packed by cost read ledgers somebody had
 * to refresh by hand (future-pay's integration ledger knew 219 of 842 files).
 *
 * The rule: a leg should take about `targetSeconds` of TEST STEP time (the
 * owner's 8–10 minutes, so 600 s by default), measured, not counted.
 *
 *   legs = clamp(ceil(estimate / targetSeconds), minShards, maxShards)
 *
 * where `estimate` is the selection's summed ledger cost divided by the lane's
 * measured `concurrency` (the summed per-file time a leg reports over the wall
 * time its test step took — about 1 for Playwright on one worker, several for
 * vitest's pool). The items are then dealt longest-first onto the lightest leg.
 *
 * Everything here is pure and dependency-free (node builtins only): the plan job
 * that calls it runs before any install.
 *
 * Ledger shape (seconds, one file per lane, committed in the consumer and
 * rewritten by the daily refresh):
 *
 *   { "version": "lane-timings-v1", "lane": "gherkin", "unit": "seconds",
 *     "concurrency": 1.02, "measured": { "run": "<url>", "sha": "…", "at": "…" },
 *     "files": { "<item>": 144.2, … } }
 *
 * The ledger is an OPTIMISATION, never a correctness dependency: an absent or
 * corrupt ledger, or an item it does not know, is costed at the mean of what it
 * does know (or `defaultSeconds` when it knows nothing), so a new file never
 * piles onto one leg and a broken ledger degrades to an even split by count.
 */
import { readFileSync } from "node:fs";

export const LEDGER_VERSION = "lane-timings-v1";

/** The owner's target: a leg runs 8–10 minutes of tests. Sized at the top. */
export const DEFAULT_TARGET_SECONDS = 600;

/** What an item costs when the ledger knows nothing at all. */
export const DEFAULT_ITEM_SECONDS = 30;

/** A single file past this is reported: it should be split, or it is a symptom. */
export const DEFAULT_SLOW_FILE_SECONDS = 180;

/**
 * Read a ledger. Never throws: anything unusable is an empty ledger.
 *
 * Accepts the v1 shape above, and the two hand-made shapes this replaces in
 * future-pay (`{ files: { path: ms } }` with a `ms` unit, `{ files: { path: s } }`)
 * so a consumer can switch before its first refresh lands.
 */
export function readLedger(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyLedger();
  }
  return normaliseLedger(parsed);
}

export function emptyLedger() {
  return { version: LEDGER_VERSION, unit: "seconds", concurrency: 1, files: new Map() };
}

export function normaliseLedger(parsed) {
  if (!parsed || typeof parsed !== "object") return emptyLedger();
  const rows = parsed.files && typeof parsed.files === "object" ? parsed.files : null;
  if (!rows) return emptyLedger();
  const scale = parsed.unit === "ms" ? 1 / 1000 : 1;
  const files = new Map();
  for (const [key, value] of Object.entries(rows)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) files.set(key, value * scale);
  }
  const concurrency =
    typeof parsed.concurrency === "number" && Number.isFinite(parsed.concurrency) && parsed.concurrency > 0
      ? parsed.concurrency
      : 1;
  return { ...parsed, version: LEDGER_VERSION, unit: "seconds", concurrency, files };
}

/** The ledger as the JSON it is committed as: keys sorted, seconds to 0.1. */
export function serialiseLedger(ledger) {
  const files = Object.fromEntries(
    [...ledger.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, round1(v)]),
  );
  const { files: _files, ...rest } = ledger;
  return `${JSON.stringify({ ...rest, version: LEDGER_VERSION, unit: "seconds", files }, null, 2)}\n`;
}

export const round1 = (n) => Math.round(n * 10) / 10;

/** A cost function over the ledger: known items at their cost, the rest at the mean. */
export function costModel(ledger, { defaultSeconds = DEFAULT_ITEM_SECONDS } = {}) {
  const known = [...ledger.files.values()];
  const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : defaultSeconds;
  // Floored above zero: a free item would never raise its leg's load, and a run
  // of them could leave the other legs empty.
  return (item) => Math.max(ledger.files.get(item) ?? mean, 0.001);
}

/**
 * Deal `items` onto `total` legs, longest-processing-time-first.
 *
 * Deterministic, which a shard function has to be: equal cost sorts by name,
 * equal load picks the lowest leg. Returns `total` arrays that together hold
 * every item exactly once, each sorted by name for a stable log.
 */
export function packLegs(items, total, cost) {
  const legs = Array.from({ length: Math.max(total, 1) }, () => ({ load: 0, items: [] }));
  const ordered = [...new Set(items)].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const item of ordered) {
    const lightest = legs.reduce((lo, leg) => (leg.load < lo.load ? leg : lo), legs[0]);
    lightest.load += cost(item);
    lightest.items.push(item);
  }
  return legs.map((leg) => ({ load: leg.load, items: leg.items.sort() }));
}

const clampInt = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/**
 * Size and pack one selection.
 *
 * `maxShards` is a CAP, never a target: when the measured estimate wants more
 * legs than the cap allows, the answer is the cap and `binding` says so, so the
 * caller can warn rather than silently run 15-minute legs.
 *
 * An empty selection answers `emptyShards` legs (0: no matrix; a lane that must
 * still start for a gate passes 1).
 */
export function sizeLane(items, ledger, options = {}) {
  const targetSeconds = positive(options.targetSeconds, DEFAULT_TARGET_SECONDS);
  const maxShards = Math.max(1, Math.floor(positive(options.maxShards, 1)));
  const minShards = clampInt(Math.floor(positive(options.minShards, 1)), 1, maxShards);
  const emptyShards = Math.max(0, Math.floor(Number(options.emptyShards ?? 0) || 0));
  const unique = [...new Set(items)];
  const cost = costModel(ledger, options);
  const concurrency = ledger.concurrency > 0 ? ledger.concurrency : 1;

  if (unique.length === 0) {
    const total = Math.min(emptyShards, maxShards);
    return {
      shardTotal: total, legs: Array.from({ length: total }, () => []), estimateSeconds: 0,
      legSeconds: Array.from({ length: total }, () => 0), wanted: total, binding: false,
      targetSeconds, concurrency, unknown: [], largest: null,
    };
  }

  const estimateSeconds = unique.reduce((sum, item) => sum + cost(item), 0) / concurrency;
  const wanted = Math.max(1, Math.ceil(estimateSeconds / targetSeconds));
  // Never more legs than items: an empty leg boots a runner to run nothing.
  const shardTotal = Math.min(clampInt(wanted, minShards, maxShards), unique.length);
  const packed = packLegs(unique, shardTotal, cost);
  const largestItem = unique.reduce((top, item) => (cost(item) > cost(top) ? item : top), unique[0]);
  return {
    shardTotal,
    legs: packed.map((leg) => leg.items),
    legSeconds: packed.map((leg) => round1(leg.load / concurrency)),
    estimateSeconds: round1(estimateSeconds),
    wanted,
    binding: wanted > maxShards,
    targetSeconds,
    concurrency,
    unknown: unique.filter((item) => !ledger.files.has(item)).sort(),
    largest: { item: largestItem, seconds: round1(cost(largestItem) / concurrency) },
  };
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
