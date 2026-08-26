/* global process */
/**
 * What a failing run broke, as a document the NEXT run can act on.
 *
 * Every selector in a CI pipeline answers "what could this diff have broken?".
 * Nothing answers the cheaper question a FIX push actually asks — "is the thing
 * that was broken last time still broken?" — even though the failing run
 * computed that answer in full and then threw it away. This is the half that
 * writes it down; `monorepo-static.yml`'s retry gate is the half that reads it.
 *
 * ── Where the detail comes from ──────────────────────────────────────────────
 *
 * Two sources, and the split is the whole safety argument.
 *
 * WHICH LANE failed comes from the jobs API — the job's name and the name of
 * the step whose conclusion is `failure`. That is structured data the platform
 * maintains, and it is the half that decides whether anything is replayed.
 *
 * WHICH FILES failed comes from scraping the job log, which is unavoidably a
 * guess about a test runner's output format. So it may only ever NARROW: a lane
 * whose files cannot be extracted is recorded as unreplayable rather than
 * replayed whole, and a scrape that returns nonsense meets the gate's own
 * existence check before anything runs.
 *
 * The tail of a job log is NOT where the failure is. Post-job cleanup writes
 * ~20 lines of git plumbing after the last step, and a step that fails midway
 * is followed by every later step's output. So the whole log is scanned, and
 * the failing STEP is read from the API rather than inferred from the tail.
 *
 * ── Why the job-name table lives HERE ────────────────────────────────────────
 *
 * `Tests / Unit Tests`, `Tests / Integration Tests` and `Quality / E2E
 * Reliability` are names THIS REPO's workflows produce. A consumer holding a
 * copy of them would be holding a hand-copied list of strings it does not own:
 * rename a job here and every consumer's ledger silently empties — no red run,
 * just a feature that stopped working. That is the same rot this pipeline
 * refuses elsewhere, so the table sits beside the workflows that emit the
 * names, and a consumer adds only the jobs IT defines, through `extra-lanes`.
 */

/** Job-name → lane, for the jobs the shared workflows themselves emit. */
export const BUILTIN_LANES = [
  // `monorepo-tests.yml`. A matrix leg carries its shard suffix
  // (`· shard 3/4`), so these are prefixes rather than exact matches — a shard
  // count changing must not silently stop matching.
  [/^Tests \/ Unit Tests/, "unit"],
  [/^Tests \/ Integration Tests/, "integration"],
  // `quality.yml`.
  [/E2E Reliability/, "e2e"],
  [/E2E \(affected only\)/, "e2e"],
];

/**
 * The colour a runner writes and a reader never sees.
 *
 * This is the difference between a log as the API returns it and a log as the
 * web UI renders it, and it is the whole reason this strip exists. Vitest
 * paints its badge, so the RAW bytes of a failing unit lane read
 * `ESC[41mESC[1m FAIL ESC[22mESC[49m lib/x/y.test.ts` — the escapes sit in the
 * gap between `FAIL` and the path, which is exactly where `VITEST_FAIL`
 * requires the path to begin.
 *
 * Fixtures copied out of the browser are already rendered, so they match and
 * the real thing does not. Measured on 12-apps/future-pay run 33019734835: a
 * unit lane failed on one named file and the ledger recorded
 * `no unit test file named in the log`, with fourteen green tests either side
 * of the bug. Strip first, then match, and a fixture can be the real bytes.
 *
 * Deliberately the whole CSI family rather than SGR alone: cursor and erase
 * sequences cost nothing to drop and a runner that emits one would fail the
 * same silent way.
 */
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/** Vitest names a failing file after `FAIL`, before the ` > test > name` trail. */
const VITEST_FAIL = /(?:^|\s)FAIL\s+(\S+\.(?:test|spec)\.[cm]?tsx?)\b/;
/** Playwright names it as `file.e2e.ts:line:col`, in the failure and the summary. */
const PLAYWRIGHT_SPEC = /([\w./@-]+\.(?:e2e|spec)\.ts):\d+:\d+/g;

/**
 * A repo-relative path starts at one of these roots.
 *
 * Deliberately NOT widened to `src/` or `lib/`, which is the mistake to make
 * here: this same pattern is also the test for "is this path already anchored?",
 * and `lib/…` / `src/…` are exactly the PACKAGE-relative shapes a per-workspace
 * runner prints and that `extractFiles` exists to re-anchor. Adding them makes
 * every such path look finished and silently drops the workspace prefix.
 *
 * A consumer whose roots are none of these still fails safe: nothing anchors,
 * the path stays as the runner printed it, and the probe's existence check
 * drops it.
 */
const REPO_ANCHORED = /(?:^|\/)((?:apps|packages|tests|scripts)\/.*)$/;

/**
 * The workspace a per-package runner invocation is currently inside.
 *
 * A consumer that shards vitest per workspace prints package-relative paths
 * (see `extractFiles`), and the only reliable way to re-anchor them is the
 * runner's OWN announcement of which package it entered. The default matches
 * the `[tag] <workspace>: …` and `--filter ./<workspace>` shapes; override it
 * with `workspace-marker` when a runner announces itself differently.
 */
export const DEFAULT_WORKSPACE_MARKER =
  String.raw`\[[\w-]+\][^\n]*?(?:--filter\s+\.\/|\s)((?:apps|packages)\/[\w.-]+)[\s:]`;

/** The lane a job belongs to, or null when nothing can replay it. */
export function laneOf(jobName, extra = []) {
  const table = [...extra, ...BUILTIN_LANES];
  return table.find(([pattern]) => pattern.test(jobName))?.[1] ?? null;
}

/**
 * A path as the repository knows it.
 *
 * A runner log mixes repo-relative paths with absolute ones from stack frames
 * (`/home/runner/work/<repo>/<repo>/apps/admin/…`). Anchoring on the first
 * workspace-root segment normalises both without hard-coding the runner's
 * directory layout, which is not ours to depend on.
 */
export function normalize(raw) {
  return REPO_ANCHORED.exec(raw)?.[1] ?? raw.replace(/^\.\//, "");
}

/**
 * Every test path a lane's log names as failing, de-duplicated, in order.
 *
 * The vitest path needs the line-by-line walk, and it is the subtlety this
 * whole extractor turns on. A sharded unit lane invokes vitest ONCE PER
 * WORKSPACE with the package as cwd, so vitest prints
 * `lib/x/__tests__/y.test.ts` — package-relative, and meaningless from the repo
 * root where the replay will run. The failing file is therefore re-anchored
 * onto whichever workspace was last announced.
 *
 * Get that wrong in the unsafe direction and nothing breaks anyway: a path that
 * does not resolve from the repo root is dropped by the gate's own existence
 * check before a single test runs. The walk is what makes the lane USEFUL; the
 * gate is what makes it safe.
 */
export function extractFiles(lane, rawLog, marker = DEFAULT_WORKSPACE_MARKER) {
  // Before any match, so every pattern below sees the log a reader sees.
  const log = String(rawLog ?? "").replace(ANSI, "");
  if (lane === "e2e") {
    // Playwright runs from the repo root, so its paths already are repo-relative.
    return [...new Set([...log.matchAll(PLAYWRIGHT_SPEC)].map((m) => normalize(m[1])))];
  }
  if (lane !== "unit" && lane !== "integration") return [];

  const workspaceRe = new RegExp(marker);
  const files = new Set();
  let workspace = "";
  for (const line of log.split(/\r?\n/)) {
    workspace = workspaceRe.exec(line)?.[1] ?? workspace;
    const hit = VITEST_FAIL.exec(line);
    if (!hit) continue;
    const path = normalize(hit[1]);
    // Already anchored (a root-run lane always is; a per-workspace one is when
    // vitest happened to print an absolute frame) — take it as it stands.
    files.add(REPO_ANCHORED.test(`/${path}`) || !workspace ? path : `${workspace}/${path}`);
  }
  return [...files];
}

/**
 * Turn a run's failed jobs into ledger entries.
 *
 * Pure over `{ name, failedStep, log }` so the classification is testable
 * without a network — which matters more than usual here, because the half that
 * scrapes is the half most likely to be quietly wrong.
 *
 * Only lanes whose failures NAME FILES are replayable. A gate lane fails as a
 * whole, and replaying one would mean a table mapping CI step names to package
 * scripts — a hand-copied list that rots silently toward pointing at the wrong
 * command. Those are still recorded under `unreplayable`, so the artifact tells
 * a human everything the run knew; they simply do not drive the gate.
 */
export function classify(failures, { extraLanes = [], marker } = {}) {
  const replay = [];
  const unreplayable = [];
  for (const { name, failedStep, log } of failures) {
    const lane = laneOf(name, extraLanes);
    if (!lane) {
      unreplayable.push({ job: name, step: failedStep, why: "no replay lane matches this job" });
      continue;
    }
    const files = extractFiles(lane, log ?? "", marker);
    if (files.length === 0) {
      // The lane is replayable in principle and this failure is not. Replaying
      // the lane WHOLE is the tempting move and the wrong one: it is minutes of
      // work chosen because the parse failed, which is the moment to know least.
      unreplayable.push({ job: name, step: failedStep, why: `no ${lane} test file named in the log` });
      continue;
    }
    replay.push({ lane, job: name, step: failedStep, files });
  }
  return { replay, unreplayable };
}

/** `[[regex, lane], …]` from the `extra-lanes` input's JSON `{pattern: lane}`. */
export function parseExtraLanes(raw) {
  if (!raw || !raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Object.entries(parsed).map(([pattern, lane]) => [new RegExp(pattern), lane]);
}

export const SCHEMA = 1;

// ── the GitHub API, as much of it as either mode needs ───────────────────────

const API = "https://api.github.com";

export async function api(path, token, { raw = false } = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return raw ? response.text() : response.json();
}

/** The failed jobs of a run, each with the step that failed and its full log. */
export async function failedJobs(repo, runId, token) {
  const { jobs = [] } = await api(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
  const failures = [];
  for (const job of jobs.filter((j) => j.conclusion === "failure")) {
    const failedStep = job.steps?.find((s) => s.conclusion === "failure")?.name ?? "(unknown step)";
    let log = "";
    try {
      log = await api(`/repos/${repo}/actions/jobs/${job.id}/logs`, token, { raw: true });
    } catch (error) {
      // A log can 404 while the run is still finalising. The job still gets an
      // entry — under `unreplayable`, since no files can be named — so the
      // artifact never silently loses a failure it knew about.
      console.log(`[ledger] no log for "${job.name}" (${error.message})`);
    }
    failures.push({ name: job.name, failedStep, log });
  }
  return failures;
}
