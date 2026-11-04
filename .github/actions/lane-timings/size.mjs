#!/usr/bin/env node
/**
 * `lane-timings` size mode: size a lane's matrix from its ledger and write each
 * leg's list into the plan the legs will run.
 *
 *   node size.mjs --plan <plan.json> --ledger <ledger.json> [--items-key tests]
 *     [--target-seconds 600] [--max-shards 4] [--min-shards 1] [--empty-shards 0]
 *
 * Rewrites the plan IN PLACE, adding:
 *
 *   legs      leg i's items at legs[i - 1] — a leg runs exactly that list
 *   timings   what the sizing saw: estimate, per-leg seconds, cap, unknown items
 *
 * and, where the plan already carries them, `counts.shardTotal`, `shardTotal`
 * and `shards`, so every reader of the plan agrees with the matrix.
 *
 * A `full` plan (no enumerated list) is left alone: there is nothing to pack.
 *
 * Outputs (GITHUB_OUTPUT): sized, shard-total, shards, binding.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { readLedger, sizeLane } from "./lib/timings.mjs";

const arg = (name, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const getPath = (object, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), object);

function output(pairs) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  appendFileSync(out, `${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
}

function summary(text) {
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (out) appendFileSync(out, `${text}\n`);
}

const minutes = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;

function main() {
  const planPath = arg("plan");
  const lane = arg("lane", "lane");
  if (!planPath) {
    console.error("[lane-timings] --plan is required");
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  if (plan.mode === "full") {
    console.log(`[lane-timings] ${lane}: a full plan enumerates nothing to pack — left as it is.`);
    output({ sized: "false" });
    return;
  }
  const items = getPath(plan, arg("items-key", "tests"));
  if (!Array.isArray(items)) {
    console.error(`[lane-timings] ${lane}: ${planPath} has no array at "${arg("items-key", "tests")}" — left as it is.`);
    output({ sized: "false" });
    return;
  }
  const ledgerPath = arg("ledger");
  const ledger = readLedger(ledgerPath);
  const sized = sizeLane(items, ledger, {
    targetSeconds: arg("target-seconds", "600"),
    maxShards: arg("max-shards", "4"),
    minShards: arg("min-shards", "1"),
    emptyShards: arg("empty-shards", "0"),
  });

  plan.legs = sized.legs;
  plan.timings = {
    ledger: ledgerPath,
    ledgerItems: ledger.files.size,
    concurrency: sized.concurrency,
    targetSeconds: sized.targetSeconds,
    estimateSeconds: sized.estimateSeconds,
    legSeconds: sized.legSeconds,
    wanted: sized.wanted,
    binding: sized.binding,
    largest: sized.largest,
    unknown: sized.unknown,
  };
  if (plan.counts && typeof plan.counts === "object") plan.counts.shardTotal = sized.shardTotal;
  if ("shardTotal" in plan) plan.shardTotal = sized.shardTotal;
  if ("shards" in plan) plan.shards = Array.from({ length: sized.shardTotal }, (_, i) => i + 1);
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const legs = sized.legSeconds.map((s, i) => `leg ${i + 1} ~${minutes(s)}`).join(", ");
  console.log(
    `[lane-timings] ${lane}: ${items.length} item(s), ~${minutes(sized.estimateSeconds)} of tests by the ledger ` +
      `(${ledger.files.size} item(s) known, concurrency ${sized.concurrency}) → ${sized.shardTotal} leg(s): ${legs || "none"}.`,
  );
  if (sized.unknown.length) {
    console.log(`[lane-timings] ${lane}: ${sized.unknown.length} item(s) not in the ledger, costed at its mean.`);
  }
  if (sized.binding) {
    console.log(
      `::warning title=shard cap binds (${lane})::this selection wants ${sized.wanted} leg(s) of ` +
        `${minutes(sized.targetSeconds)} but the lane's cap is ${arg("max-shards", "4")}, so each leg runs longer than the target.`,
    );
  }
  summary(
    `**${lane} legs, sized by measured time:** ${sized.shardTotal} leg(s) for ~${minutes(sized.estimateSeconds)} ` +
      `(target ${minutes(sized.targetSeconds)} a leg${sized.binding ? `, cap ${arg("max-shards", "4")} binds` : ""}).`,
  );
  output({
    sized: "true",
    "shard-total": sized.shardTotal,
    shards: JSON.stringify(Array.from({ length: sized.shardTotal }, (_, i) => i + 1)),
    binding: String(sized.binding),
  });
}

main();
