/* global process */
/**
 * Fetch a pull request's base ref so that `git merge-base <base> HEAD` WORKS —
 * without truncating history that is already present.
 *
 * ── The bug this exists to prevent ──────────────────────────────────────────
 * `git fetch --depth=1 origin <base>` does not merely "fetch a little". On a
 * repository that already has full history — an `actions/checkout` with
 * `fetch-depth: 0`, which is what every affected lane here uses — it CREATES a
 * shallow graft: git writes `.git/shallow`, the whole repo becomes shallow, and
 * merge-base traversals across the graft point fail. Measured on a scratch
 * repo pair:
 *
 *     is-shallow after full clone:      false
 *     merge-base BEFORE depth-1 fetch:  9f1a52c…      ← the true branch point
 *     is-shallow AFTER depth-1 fetch:   true
 *     merge-base AFTER depth-1 fetch:   fatal: no merge base
 *
 * The repository HAD the answer and the fetch threw it away. Everything
 * downstream then degrades, silently and expensively:
 *
 *   - `git diff base...HEAD` (three-dot) dies, and callers fall back to the
 *     two-dot form, which counts every commit the BASE advanced by as a change
 *     — including phantom deletions for files main added since the branch
 *     point;
 *   - `turbo run <task> --affected` prints "unable to detect git range,
 *     assuming all files have changed" and runs EVERY package while still
 *     reporting success — a full run wearing the word "affected";
 *   - a gate that greps a three-dot diff and swallows failure with `|| true`
 *     sees an EMPTY changed-file list and skips itself entirely. That one is
 *     the dangerous direction: not slow, just quietly not run.
 *
 * ── What this does instead ──────────────────────────────────────────────────
 * 1. Fetch the base ref with NO `--depth`, so a complete repository stays
 *    complete. This alone fixes every lane whose checkout is `fetch-depth: 0`.
 * 2. Only if the repo was ALREADY shallow (a `fetch-depth: 1` checkout, or a
 *    shallow clone) and the merge base still does not resolve, deepen in
 *    exponential rungs until it does, ending with `--unshallow`. A fixed depth
 *    is not a fix — `--depth=50` still fails for a branch that diverged 51
 *    commits ago, and the failure mode is the silent one above.
 * 3. Leave FETCH_HEAD pointing at the base tip, because that is what callers
 *    diff against. Every rung therefore ENDS with a base-ref fetch, and the
 *    merge base is re-tested only after that.
 *
 * Outputs `merge-base` and `base-sha` for callers that would rather diff
 * against an explicit commit than re-derive one.
 *
 * Node builtins only — the action runs before any consumer `pnpm install`.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * Deepening rungs, used ONLY when the checkout was already shallow. 64 covers
 * the overwhelming majority of real branch points in one round-trip; the tail
 * covers a branch that diverged long ago. `--unshallow` is the floor.
 */
const DEPTH_LADDER = [64, 256, 1024, 4096];

const git = (args, cwd) =>
  execFileSync("git", args, {
    encoding: "utf8",
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const tryGit = (args, cwd) => {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
};

const isShallow = (cwd) => tryGit(["rev-parse", "--is-shallow-repository"], cwd) === "true";

/**
 * Fetch the base ref, updating FETCH_HEAD. `depth` is omitted entirely unless
 * the repo is already shallow — passing one to a complete repo is the graft
 * that breaks everything.
 */
function fetchBase(baseRef, depth, cwd) {
  const depthArg = depth === null ? [] : [`--depth=${depth}`];
  return tryGit(["fetch", "--no-tags", ...depthArg, "origin", baseRef], cwd) !== null;
}

/**
 * Resolve the merge base between the fetched base tip and HEAD, deepening a
 * shallow checkout until it exists.
 *
 * @param {string} baseRef branch name (or a sha the remote allows in want)
 * @param {{ cwd?: string }} [opts]
 * @returns {{ mergeBase: string, baseSha: string } | null} null when the two
 *   histories are genuinely unrelated — the caller should widen to a full run
 *   rather than treat an empty diff as "nothing changed".
 */
export function fetchBaseAndResolve(baseRef, opts = {}) {
  const { cwd = process.cwd() } = opts;
  const startedShallow = isShallow(cwd);

  // Step 1: a plain fetch. On a complete repository this is the whole fix.
  if (!fetchBase(baseRef, startedShallow ? DEPTH_LADDER[0] : null, cwd)) {
    console.error(`[fetch-base] could not fetch ${baseRef} from origin`);
    return null;
  }

  const baseSha = tryGit(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], cwd);
  if (baseSha === null) return null;

  let mergeBase = tryGit(["merge-base", baseSha, "HEAD"], cwd);
  if (mergeBase !== null) return { mergeBase, baseSha };

  // Step 2: only a shallow checkout can get here. Deepen BOTH walks — a merge
  // base needs history behind the base tip and behind HEAD — re-fetching the
  // base ref last so FETCH_HEAD stays the base tip.
  for (const depth of DEPTH_LADDER.slice(1)) {
    console.log(`[fetch-base] no merge base yet — deepening to ${depth}`);
    tryGit(["fetch", "--no-tags", `--deepen=${depth}`, "origin"], cwd);
    fetchBase(baseRef, depth, cwd);
    mergeBase = tryGit(["merge-base", baseSha, "HEAD"], cwd);
    if (mergeBase !== null) return { mergeBase, baseSha };
  }

  console.log("[fetch-base] still no merge base — unshallowing");
  tryGit(["fetch", "--no-tags", "--unshallow", "origin"], cwd);
  fetchBase(baseRef, null, cwd);
  mergeBase = tryGit(["merge-base", baseSha, "HEAD"], cwd);
  return mergeBase === null ? null : { mergeBase, baseSha };
}

/** Write a GitHub Actions step output, when running inside Actions. */
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
  console.log(`[fetch-base] ${name}=${value}`);
}

// CLI entrypoint: `node fetch-base.mjs <base-ref>`. Kept out of the way of the
// self-tests, which import the function directly.
if (process.argv[1] && process.argv[1].endsWith("fetch-base.mjs")) {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error("[fetch-base] usage: fetch-base.mjs <base-ref>");
    process.exit(1);
  }
  const resolved = fetchBaseAndResolve(baseRef);
  if (resolved === null) {
    // Do NOT fail the job: a missing merge base is a legitimate state (an
    // unrelated history, a brand-new orphan branch). Report it as empty so the
    // caller's own fail-safe — run everything — is what decides, rather than a
    // hard stop here.
    console.log(`::warning::no merge base with ${baseRef}; consumers should widen to a full run`);
    setOutput("merge-base", "");
    setOutput("base-sha", "");
  } else {
    setOutput("merge-base", resolved.mergeBase);
    setOutput("base-sha", resolved.baseSha);
  }
}
