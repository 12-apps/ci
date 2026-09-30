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
 * Three subcommands, each reading its inputs from the environment (never from
 * argv, so a computed value can never be re-parsed as a flag):
 *
 *   key     run the consumer's fingerprint command and print the cache key
 *           `<lane>-lane-<key16>-<fingerprint>`, where `<key16>` folds in how
 *           the lane RUNS (Node version, the commands) — those live in a
 *           workflow file the fingerprint ignores, and without them editing the
 *           lint command would inherit the old command's verdict. Empty when
 *           the event is not a pull request, the command is empty, fails, or
 *           prints no usable hash: an optimisation that cannot answer must
 *           answer "run it".
 *   report  turn `actions/cache/restore`'s `cache-hit` into the `hit` output,
 *           with a notice when the lane is skipped.
 *   marker  write the file the record step saves under the key — the entry's
 *           existence is the verdict; the body says which run earned it.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
/**
 * The key's schema epoch. Bumped when what a key STANDS FOR changes — here,
 * when the audit of 2026-09-30 (E7/E8) added the base, the engine revision
 * and the runner to the material: a verdict recorded under the old shape
 * answers for fewer things than the new key asks, so none may match.
 */
export const VERDICT_SCHEMA = "verdict-v2";

/**
 * The digests of EMPTY input, by algorithm. `git ls-tree missing | sha256sum`
 * prints one and exits 0 without `pipefail` (E9); a consumer's command can
 * hand it back looking like a hash, and two different trees would then share
 * a verdict. Refused by value, whatever shell produced it.
 */
const EMPTY_DIGESTS = new Set([
  "d41d8cd98f00b204e9800998ecf8427e",
  "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
]);

export function verdictKey({ lane, fingerprintCommand, material = "", event, run = runShell }) {
  if (!/^[a-z][a-z0-9-]*$/.test(lane ?? "")) return { key: "", fingerprint: "", why: `lane "${lane}" is not a name` };
  if (event !== "pull_request") return { key: "", fingerprint: "", why: `event is ${event || "unknown"} — a verdict is consulted only on a pull request` };
  if (!fingerprintCommand?.trim()) return { key: "", fingerprint: "", why: "no fingerprint command" };
  let out;
  try {
    out = run(fingerprintCommand);
  } catch (error) {
    return { key: "", fingerprint: "", why: `fingerprint command failed: ${String(error.message ?? error).split("\n")[0]}` };
  }
  const fingerprint = String(out ?? "").replace(/\s+/g, "").toLowerCase();
  if (!HEX.test(fingerprint)) return { key: "", fingerprint: "", why: "fingerprint command produced no usable hash" };
  if (EMPTY_DIGESTS.has(fingerprint)) {
    return { key: "", fingerprint: "", why: "fingerprint command hashed EMPTY input — its producer failed" };
  }
  const key16 = createHash("sha256").update(`${VERDICT_SCHEMA}\0${material}\0${fingerprintCommand}`).digest("hex").slice(0, 16);
  return { key: `${lane}-lane-${key16}-${fingerprint}`, fingerprint, why: "" };
}

function runShell(command) {
  // `pipefail`: a producer that dies inside the consumer's pipeline must fail
  // the command, not hand the next stage empty input to hash (E9).
  return execSync(`set -o pipefail\n${command}`, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: "/bin/bash" });
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
  console.error(`[lane-verdict] unknown mode "${mode}" — expected key, report or marker`);
  return 2;
}

if (process.argv[1] && process.argv[1].endsWith("verdict.mjs")) process.exit(main(process.argv.slice(2)));
