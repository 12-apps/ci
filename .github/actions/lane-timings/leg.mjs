#!/usr/bin/env node
/**
 * `lane-timings` leg mode: hand one leg of a matrix exactly the list the plan
 * job packed for it.
 *
 *   node leg.mjs --plan <plan.json> --leg <n> --out <file> [--items-key tests] [--when-sized]
 *
 * Reads `legs` (written by `size`) and writes leg n's items to `--out`, one
 * per line. Before it does, it checks what a leg must be able to trust:
 *
 *   - the plan has `legs`, one per leg of the matrix (`shardTotal`, or
 *     `counts.shardTotal`, when the plan states one);
 *   - together the legs hold every item of the plan's list exactly once, so no
 *     leg runs a file twice and none is dropped;
 *   - `n` names one of them.
 *
 * Anything else is a failure, never a guess: a leg that falls back to its own
 * split could disagree with the matrix it was sized by and leave files unrun
 * while every leg reports green.
 *
 * Outputs (GITHUB_OUTPUT): file (the list's path), count, total.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const arg = (name, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const getPath = (object, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), object);

/**
 * Leg `n` of `plan`, or a reason it cannot be trusted. Pure, for the tests.
 * @returns {{ items: string[], total: number } | { error: string }}
 */
export function legOf(plan, n, itemsKey = "tests") {
  const legs = plan?.legs;
  const items = getPath(plan, itemsKey);
  if (!Array.isArray(legs) || legs.length === 0) return { error: "the plan carries no legs — run lane-timings `size` on it first" };
  if (!legs.every((leg) => Array.isArray(leg) && leg.every((item) => typeof item === "string"))) {
    return { error: "the plan's legs are not lists of items" };
  }
  const stated = plan.shardTotal ?? plan.counts?.shardTotal;
  if (Number.isInteger(stated) && stated !== legs.length) {
    return { error: `the plan was sized for ${stated} leg(s) but carries ${legs.length}` };
  }
  if (!Array.isArray(items)) return { error: `the plan has no list at "${itemsKey}" to check its legs against` };
  const dealt = legs.flat();
  const unique = new Set(dealt);
  if (unique.size !== dealt.length) return { error: "an item is dealt to more than one leg" };
  const missing = items.filter((item) => !unique.has(item));
  const extra = dealt.filter((item) => !items.includes(item));
  if (missing.length || extra.length) {
    return {
      error:
        `the legs do not cover the plan's list exactly (${missing.length} undealt` +
        `${missing.length ? `, first ${missing[0]}` : ""}; ${extra.length} not in the list` +
        `${extra.length ? `, first ${extra[0]}` : ""})`,
    };
  }
  if (!Number.isInteger(n) || n < 1 || n > legs.length) return { error: `leg ${n} is not one of the plan's ${legs.length}` };
  return { items: legs[n - 1], total: legs.length };
}

function main() {
  const planPath = arg("plan");
  const n = Number(arg("leg"));
  const out = arg("out");
  const lane = arg("lane", "lane");
  if (!planPath || !out) {
    console.error("[lane-timings] leg: --plan and --out are required");
    process.exit(2);
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    console.error(`::error title=lane-timings (${lane})::cannot read the plan ${planPath}: ${error.message}`);
    process.exit(1);
  }
  // `--when-sized`: a plan `size` never touched (a lane with no ledger, a
  // `none` or `full` plan) has neither `legs` nor `timings`, and the leg has
  // no list to read: say so and hand back no file. A plan that WAS sized and
  // carries bad legs is still a failure below.
  if (process.argv.includes("--when-sized") && plan.legs === undefined && plan.timings === undefined) {
    console.log(`[lane-timings] ${lane}: the plan was not sized by measured time; leg ${arg("leg")} splits as the runner does.`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "file=\ncount=\ntotal=\n");
    return;
  }
  const leg = legOf(plan, n, arg("items-key", "tests"));
  if ("error" in leg) {
    console.error(`::error title=lane-timings (${lane})::leg ${arg("leg")}: ${leg.error}.`);
    process.exit(1);
  }
  writeFileSync(out, leg.items.length ? `${leg.items.join("\n")}\n` : "");
  const seconds = plan.timings?.legSeconds?.[n - 1];
  console.log(
    `[lane-timings] ${lane}: leg ${n}/${leg.total} runs ${leg.items.length} item(s), packed by measured time` +
      `${typeof seconds === "number" ? ` (~${Math.round(seconds)} s by the ledger)` : ""}.`,
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `file=${out}\ncount=${leg.items.length}\ntotal=${leg.total}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
