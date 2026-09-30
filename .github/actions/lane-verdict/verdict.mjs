#!/usr/bin/env node
/**
 * `lane-verdict` — has this exact tree already PASSED this lane, run this way?
 *
 * The tests lanes learned this first (monorepo-tests.yml, FUT-892 → FUT-2360):
 * a same-commit re-run — a draft flipping ready, a `reopened`, a hand re-run,
 * measured at about three a day — pays every lane again for a tree an earlier
 * run already passed. There the answer sizes the matrix at zero; here it gates
 * the steps of a single job, so Lint, Type Check, Build and a gates job can
 * skip their install and their work on the same evidence.
 *
 * Four subcommands, each reading its inputs from the environment (never from
 * argv, so a computed value can never be re-parsed as a flag):
 *
 *   key     run the consumer's fingerprint command and print the cache key
 *           `<lane>-lane-<schema>-<key16>-<fingerprint>`, where `<key16>` folds
 *           in the central source/runtime identity and how the lane RUNS
 *           (the immutable selection context and commands) — those live in a
 *           workflow file the fingerprint ignores, and without them editing the
 *           lint command would inherit the old command's verdict. Empty when
 *           the event is not a pull request, the command is empty, fails, or
 *           prints no usable hash: an optimisation that cannot answer must
 *           answer "run it".
 *   report  turn `actions/cache/restore`'s `cache-hit` into the `hit` output,
 *           with a notice when the lane is skipped.
 *   marker  write the file the record step saves under the key — the entry's
 *           existence is the verdict; the body says which run earned it.
 *   identity print only the central source/runtime identity, for other
 *           success-result caches that must invalidate on the same changes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionIdentity, VERDICT_SCHEMA } from "./provenance.mjs";

const HEX = /^[0-9a-f]{32,128}$/;

/**
 * @param {object} o
 * @param {string} o.lane
 * @param {string} o.fingerprintCommand  consumer shell, prints a hex hash
 * @param {string} o.material            what decides how the lane runs
 * @param {string} o.event               github.event_name
 * @param {(cmd: string) => string} [o.run]  injectable for tests
 * @returns {{ key: string, fingerprint: string, why: string }}
 */
export function verdictKey({ lane, fingerprintCommand, material = "", event, run = runShell, identity = executionIdentity }) {
  if (!/^[a-z][a-z0-9-]*$/.test(lane ?? "")) return { key: "", fingerprint: "", why: `lane "${lane}" is not a name` };
  if (event !== "pull_request") return { key: "", fingerprint: "", why: `event is ${event || "unknown"} — a verdict is consulted only on a pull request` };
  if (!fingerprintCommand?.trim()) return { key: "", fingerprint: "", why: "no fingerprint command" };
  let out, context;
  try {
    context = identity();
    if (!/^[0-9a-f]{64}$/.test(context)) throw new Error("no usable execution identity");
  } catch (error) {
    return { key: "", fingerprint: "", why: `execution identity unavailable: ${String(error.message ?? error).split("\n")[0]}` };
  }
  try {
    out = run(fingerprintCommand);
  } catch (error) {
    return { key: "", fingerprint: "", why: `fingerprint command failed: ${String(error.message ?? error).split("\n")[0]}` };
  }
  const fingerprint = String(out ?? "").replace(/\s+/g, "");
  if (!HEX.test(fingerprint)) return { key: "", fingerprint: "", why: "fingerprint command produced no usable hash" };
  const key16 = createHash("sha256").update(JSON.stringify([context, material, fingerprintCommand])).digest("hex").slice(0, 16);
  return { key: `${lane}-lane-${VERDICT_SCHEMA}-${key16}-${fingerprint}`, fingerprint, why: "" };
}

function runShell(command) {
  return execFileSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
}

function output(pairs) {
  const file = process.env.GITHUB_OUTPUT;
  const text = Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join("");
  if (file) appendFileSync(file, text);
  else process.stdout.write(text);
}

function main(argv) {
  const [mode] = argv;
  const lane = process.env.LANE ?? "";
  if (mode === "identity") {
    try {
      output({ "execution-identity": executionIdentity() });
    } catch (error) {
      output({ "execution-identity": "" });
      console.log(`[lane-verdict] no execution identity — ${error.message}; run the lane.`);
    }
    return 0;
  }
  if (mode === "key") {
    const { key, fingerprint, why } = verdictKey({
      lane,
      fingerprintCommand: process.env.FP_CMD ?? "",
      material: process.env.KEY_MATERIAL ?? "",
      event: process.env.GITHUB_EVENT_NAME ?? "",
    });
    output({ key, fingerprint });
    if (key) console.log(`[lane-verdict] ${lane}: key ${key}`);
    else console.log(`[lane-verdict] ${lane}: no lookup — ${why}; the lane runs.`);
    return 0;
  }
  if (mode === "report") {
    const hit = process.env.HIT === "true" && Boolean(process.env.KEY);
    output({ hit: hit ? "true" : "false" });
    if (hit) {
      console.log(
        `::notice::${lane} lane: this tree is byte-identical, in every path that can change this lane's outcome, ` +
          `to one an earlier PASSING run already covered (${process.env.KEY}). Install and work skipped.`,
      );
    } else if (process.env.KEY) console.log(`[lane-verdict] ${lane}: no recorded verdict for ${process.env.KEY} — the lane runs.`);
    return 0;
  }
  if (mode === "marker") {
    const dir = join(".lane-verdict", lane);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "passed"), `${process.env.KEY ?? ""}\nrun ${process.env.GITHUB_RUN_ID ?? "?"}\nsha ${process.env.GITHUB_SHA ?? "?"}\n`);
    console.log(`[lane-verdict] ${lane}: recording ${process.env.KEY} (run ${process.env.GITHUB_RUN_ID ?? "?"})`);
    return 0;
  }
  console.error(`[lane-verdict] unknown mode "${mode}" — expected identity, key, report or marker`);
  return 2;
}

if (process.argv[1] && process.argv[1].endsWith("verdict.mjs")) process.exit(main(process.argv.slice(2)));
