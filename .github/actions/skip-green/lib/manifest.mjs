/**
 * The green manifest — what a lane's earlier runs on this pull request have
 * already proven, per test file — and the two operations over it.
 *
 * Shape (one file per lane, kept in the Actions cache under a per-PR prefix):
 *
 *   { version: "green-manifest-v1", lane: "unit",
 *     entries: { "<test path>": { hash, sha, run } } }
 *
 * `hash` is the test's input hash from the plan (affected-plan lib/inputs.mjs):
 * its import closure and the lane's global inputs, as blob shas. `sha` and
 * `run` say which head and which run earned the entry, for the log line a
 * skipped test prints.
 *
 * Everything here reads defensively and answers "nothing" on doubt. The two
 * callers are asymmetric on purpose: `filter` may only ever SKIP LESS than the
 * manifest would allow, and `record` may only ever RECORD what a green lane
 * ran. A corrupt manifest therefore skips nothing and is then rewritten from
 * scratch by the next green run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * v2 (2026-09-30): the manifest names the INPUTS version its hashes were made
 * with (`inputs`, affected-plan's INPUTS_VERSION), and a reader refuses a
 * mismatch. The audit's F1–F3 changed what a hash covers, so every hash
 * recorded before it is a claim about fewer inputs than the test really has;
 * bumping here retires all of them at once instead of trusting a collision
 * not to happen.
 */
export const MANIFEST_VERSION = "green-manifest-v2";

/** A 40-hex git sha, a run id — anything else is not an entry we made. */
const SHA_RE = /^[0-9a-f]{7,40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Read a manifest, or `null` when there is none worth trusting.
 *
 * @param {string} path
 * @param {string} lane  the manifest must name this lane; another lane's file
 *   under the wrong path skips nothing rather than answering for it
 * @param {string} [inputsVersion]  the plan's `inputsVersion`; a manifest hashed
 *   under another construction answers for different inputs and skips nothing
 * @returns {{ manifest: object|null, why: string }}
 */
export function readManifest(path, lane, inputsVersion) {
  if (!existsSync(path)) return { manifest: null, why: "no manifest — the first run of this lane on the pull request records one" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { manifest: null, why: `manifest unreadable (${error.message}) — skipping nothing` };
  }
  if (parsed?.version !== MANIFEST_VERSION) return { manifest: null, why: `manifest version ${JSON.stringify(parsed?.version)} is not ${MANIFEST_VERSION} — skipping nothing` };
  if (parsed.lane !== lane) return { manifest: null, why: `manifest is for lane ${JSON.stringify(parsed.lane)}, not ${lane} — skipping nothing` };
  if (inputsVersion && parsed.inputs !== inputsVersion) {
    return { manifest: null, why: `manifest hashes were made with ${JSON.stringify(parsed.inputs)}, the plan's are ${inputsVersion} — skipping nothing` };
  }
  if (!parsed.entries || typeof parsed.entries !== "object") return { manifest: null, why: "manifest has no entries — skipping nothing" };
  // Drop malformed entries one by one rather than the whole file: a bad line
  // costs its own test a skip, never the lane's.
  const entries = {};
  for (const [test, entry] of Object.entries(parsed.entries)) {
    if (typeof test !== "string" || !entry || typeof entry !== "object") continue;
    if (!HASH_RE.test(String(entry.hash))) continue;
    if (!SHA_RE.test(String(entry.sha))) continue;
    entries[test] = { hash: entry.hash, sha: entry.sha, run: String(entry.run ?? "") };
  }
  return { manifest: { version: MANIFEST_VERSION, lane, inputs: parsed.inputs ?? null, entries }, why: `${Object.keys(entries).length} recorded test(s)` };
}

export function writeManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The tests a lane must ALWAYS run, from the consumer's list: a JSON array of
 * paths, or `{ "tests": [...] }`. A path given but unreadable is an error the
 * caller turns into "skip nothing" — a list we cannot read might name
 * anything.
 *
 * @returns {{ always: Set<string>, error: string|null }}
 */
export function readAlwaysRun(path) {
  if (!path) return { always: new Set(), error: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tests) ? parsed.tests : null;
    if (!list) return { always: new Set(), error: `${path} is neither an array nor {"tests": [...]}` };
    return { always: new Set(list.filter((t) => typeof t === "string")), error: null };
  } catch (error) {
    return { always: new Set(), error: `${path}: ${error.message}` };
  }
}

/**
 * The shard count a plan of `count` tests is worth — the same arithmetic
 * `affected-plan` uses, restated here because a filtered list must be sized by
 * the same rule as an unfiltered one. Zero tests is an EMPTY matrix.
 */
export function shardTotalFor(count, maxShards, perShard) {
  if (count <= 0) return 0;
  return Math.max(1, Math.min(maxShards, Math.ceil(count / perShard)));
}

/** Parse `KEY=value` lines the way GITHUB_OUTPUT is written, for the tests. */
export function appendOutputs(pairs) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${v}`);
  writeFileSync(out, `${lines.join("\n")}\n`, { flag: "a" });
}
