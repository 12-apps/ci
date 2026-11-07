#!/usr/bin/env node
/* global process */
/**
 * `skip-green record` — after a GREEN lane, write down what it proved.
 *
 * For every test the lane RAN and passed, record the input hash the plan
 * computed for it, with the head and run that earned it. Tests the run
 * SKIPPED as already green keep their earlier entry: their hash is equal by
 * definition, and the entry should keep naming the run that actually executed
 * them. Entries for tests this run did not plan at all are kept too — the
 * manifest accumulates over the pull request, which is what lets push 3 skip
 * what push 1 proved even when push 2 did not select it.
 *
 * The one rule that matters: ONLY WHAT PASSED IS RECORDED. A lane whose
 * result is `success` records every test it ran. A lane that FAILED or was
 * CANCELLED records only what its green shards proved, and EVICTS what its red
 * shards ran (FUT-4548, see `fromShards`): each shard
 * whose own test step exited 0 wrote a shard record (`shard.mjs`) naming the
 * files of its leg and their hashes, and `--shard-records` hands them here. A
 * red shard writes no record, so no test of it — the failed one or the ones
 * beside it — enters the manifest. A shard record is used only when it names
 * THIS run, THIS head and THIS lane's inputs construction, and only for a test
 * the plan handed the lane with the very hash the record carries. Any other
 * result (`skipped`, empty) records nothing. A test with no hash (`null`: an
 * unresolved import in its closure) is never recorded either; there is no
 * bounded claim to make about it.
 *
 * Usage:
 *   node record.mjs --lane unit --plan affected-plan.unit.json \
 *     --manifest .skip-green/unit.json --lane-result success \
 *     --head-sha <sha> --run-id <id> [--shard-records .skip-green-shards]
 *
 * Outputs (GITHUB_OUTPUT): recorded (true|false), entries, added
 */
import { readFileSync } from "node:fs";

import { MANIFEST_VERSION, SHARD_RECORD_VERSION, appendOutputs, readManifest, readShardRecords, writeManifest } from "./lib/manifest.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

/**
 * The next manifest, pure so the tests can drive it; `null` when nothing may
 * be recorded.
 *
 * @returns {{ manifest: object|null, added: number, why: string }}
 */
export function nextManifest({ lane, plan, previous, laneResult, headSha, runId, shardRecords = null, shardTotal = null }) {
  const partial = laneResult === "failure" || laneResult === "cancelled";
  if (laneResult !== "success" && !(partial && Array.isArray(shardRecords))) {
    return { manifest: null, added: 0, why: `lane result is ${JSON.stringify(laneResult)} — a manifest records only what a green lane, or a green shard of it, proved` };
  }
  if (!plan || !plan.inputs || typeof plan.inputs !== "object") return { manifest: null, added: 0, why: "plan carries no test inputs — nothing to record" };
  if (!/^[0-9a-f]{7,40}$/.test(String(headSha))) return { manifest: null, added: 0, why: `head sha ${JSON.stringify(headSha)} is not a sha — nothing to record` };
  if (partial) return fromShards({ lane, plan, previous, laneResult, headSha, runId, shardRecords, shardTotal });

  const entries = { ...(previous?.entries ?? {}) };
  let added = 0;
  for (const test of plan.tests ?? []) {
    const hash = plan.inputs[test];
    if (!hash) continue; // unbounded — no claim to make
    const before = entries[test];
    entries[test] = { hash, sha: headSha, run: String(runId) };
    if (!before || before.hash !== hash) added++;
  }
  // Skipped tests keep the entry that earned them; a skipped test with no
  // entry is a contradiction (it was skipped BECAUSE of one) and is left out.
  return {
    manifest: { version: MANIFEST_VERSION, lane, inputs: plan.inputsVersion ?? null, entries },
    added,
    why: `${added} entr${added === 1 ? "y" : "ies"} added or refreshed, ${Object.keys(entries).length} in the manifest`,
  };
}

/**
 * A failed or cancelled lane: merge what its green shards proved, and EVICT
 * what its red shards ran.
 *
 * Eviction first, and it wins: a test whose shard failed in this run loses its
 * entry, whatever earlier head earned it, so its next run is a real one. That
 * is what keeps a proof from going stale while the test's own inputs stand
 * still — green at one head, red now because of something the hash does not
 * see. Evicted are:
 *   - every file a red shard's record names (`evict`, or `"*"`: all planned);
 *   - on a FAILED lane, the leg of every shard that left NO green record (it
 *     timed out, died before its tests, or its record was lost) — from the
 *     plan's own `legs`, or every planned test when the plan was not sized.
 * A cancelled lane evicts only what a red shard named: a shard the newer push
 * cut off proved nothing either way.
 *
 * A record is used only when it names THIS run, THIS head, THIS lane and its
 * inputs construction; a green one only for a test the plan handed the lane,
 * with the very hash the plan carries.
 */
function fromShards({ lane, plan, previous, laneResult, headSha, runId, shardRecords, shardTotal }) {
  const planned = new Set(plan.tests ?? []);
  const fits = (record) =>
    record?.version === SHARD_RECORD_VERSION &&
    record.lane === lane &&
    (record.inputs ?? null) === (plan.inputsVersion ?? null) &&
    String(record.run) === String(runId) &&
    record.sha === headSha;
  const usable = shardRecords.filter(fits);
  const refused = shardRecords.length - usable.length;
  const green = usable.filter((r) => r.passed === true && r.tests && typeof r.tests === "object");
  const red = usable.filter((r) => r.passed === false);

  const evict = new Set();
  let evictAll = false;
  for (const r of red) {
    if (r.evict === "*") evictAll = true;
    else if (Array.isArray(r.evict)) for (const t of r.evict) evict.add(t);
  }
  let silent = 0;
  if (laneResult === "failure") {
    const legs = Array.isArray(plan.legs) && plan.legs.every(Array.isArray) ? plan.legs : null;
    const total = legs ? legs.length : Number(shardTotal);
    const greenShards = new Set(green.map((r) => String(r.shard)));
    const redShards = new Set(red.map((r) => String(r.shard)));
    if (!Number.isInteger(total) || total < 1) evictAll = true;
    else {
      for (let n = 1; n <= total; n++) {
        if (greenShards.has(String(n)) || redShards.has(String(n))) continue;
        silent++;
        if (legs) for (const t of legs[n - 1]) evict.add(t);
        else evictAll = true;
      }
    }
  }
  if (evictAll) for (const t of planned) evict.add(t);

  const entries = { ...(previous?.entries ?? {}) };
  let evicted = 0;
  for (const t of evict) {
    if (entries[t]) {
      delete entries[t];
      evicted++;
    }
  }
  let added = 0;
  for (const record of green) {
    for (const [test, hash] of Object.entries(record.tests)) {
      // The plan's own hash, never the record's alone: a record is evidence
      // that THIS test ran with THIS hash in THIS run, nothing wider.
      if (evict.has(test) || !planned.has(test) || !plan.inputs[test] || plan.inputs[test] !== hash) continue;
      const before = entries[test];
      entries[test] = { hash, sha: headSha, run: String(runId) };
      if (!before || before.hash !== hash) added++;
    }
  }
  const tail =
    `${green.length} green and ${red.length} red shard record(s) of a ${laneResult} lane` +
    (silent ? `, ${silent} shard(s) with no record` : "") +
    (refused ? `, ${refused} refused (another run, head, lane or inputs construction)` : "");
  if (green.length === 0 && evicted === 0) return { manifest: null, added: 0, evicted: 0, why: `${tail} — nothing recorded, nothing to evict` };
  return {
    manifest: { version: MANIFEST_VERSION, lane, inputs: plan.inputsVersion ?? null, entries },
    added,
    evicted,
    why: `${tail}: ${added} entr${added === 1 ? "y" : "ies"} added or refreshed, ${evicted} evicted, ${Object.keys(entries).length} in the manifest`,
  };
}

function main() {
  const lane = arg("lane", "unit");
  const planPath = arg("plan");
  const manifestPath = arg("manifest");
  const laneResult = arg("lane-result", "");
  const headSha = arg("head-sha", process.env.GITHUB_SHA ?? "");
  const runId = arg("run-id", process.env.GITHUB_RUN_ID ?? "");
  if (!planPath || !manifestPath) {
    console.error("[skip-green] usage: record.mjs --lane <lane> --plan <file> --manifest <file> --lane-result <result>");
    return 2;
  }
  let plan = null;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    console.log(`[skip-green] ${lane}: cannot read the plan at ${planPath} — nothing recorded (${error.message})`);
    appendOutputs({ recorded: "false", entries: 0, added: 0 });
    return 0;
  }
  const { manifest: previous, why: previousWhy } = readManifest(manifestPath, lane, plan?.inputsVersion);
  console.log(`[skip-green] ${lane}: previous manifest — ${previousWhy}`);
  const shardDir = arg("shard-records", "");
  let shardRecords = null;
  if (shardDir) {
    const read = readShardRecords(shardDir, lane);
    shardRecords = read.records;
    console.log(`[skip-green] ${lane}: ${read.why}`);
  }
  const { manifest, added, why } = nextManifest({ lane, plan, previous, laneResult, headSha, runId, shardRecords, shardTotal: arg("shard-total", "") });
  console.log(`[skip-green] ${lane}: ${why}`);
  if (!manifest) {
    appendOutputs({ recorded: "false", entries: Object.keys(previous?.entries ?? {}).length, added: 0 });
    return 0;
  }
  writeManifest(manifestPath, manifest);
  appendOutputs({ recorded: "true", entries: Object.keys(manifest.entries).length, added });
  return 0;
}

// `exitCode`, never `process.exit()` — see filter.mjs.
if (process.argv[1] && process.argv[1].endsWith("record.mjs")) process.exitCode = main();
