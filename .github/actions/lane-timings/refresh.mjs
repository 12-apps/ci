#!/usr/bin/env node
/**
 * `lane-timings` refresh mode: read what every leg of THIS run measured, fold
 * it into each lane's committed ledger, and report what is too slow.
 *
 *   node refresh.mjs --config .lane-timings.json [--root .] [--report out.json]
 *
 * Runs at the end of the consumer's daily full run, in a job that needs every
 * test lane, so the artifacts and the step times of the same run are there.
 * Reads them through the Actions API with GITHUB_TOKEN (`actions: read`):
 * GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_API_URL come from the runner,
 * `--run-id` overrides the run.
 *
 * The consumer's config (`.lane-timings.json`):
 *
 *   {
 *     "targetSeconds": 600,          // a leg's test step, the owner's 8–10 min
 *     "slowFileSeconds": 180,        // one file past this is reported
 *     "lanes": {
 *       "gherkin": {
 *         "ledger": ".lane-timings/gherkin.json",
 *         "maxShards": 6,                              // the lane's cap, for the cap warning
 *         "artifacts": "^bdd-journeys-report-s\\d+$",  // which of the run's artifacts hold reports
 *         "files": "(^|/)spec-durations\\.json$",      // which files inside them
 *         "format": "durations-json",                  // or "junit"
 *         "junitRoot": "reports/",                     // junit only: see lib/reports.mjs
 *         "rewrite": [{ "pattern": "^\\.features-gen/[^/]+/(.+)\\.spec\\.js$", "replace": "$1" }],
 *         "job": "^Gherkin Journeys",                  // the legs' job names
 *         "step": "Run the affected Gherkin journeys"  // and their test step
 *       }
 *     }
 *   }
 *
 * Never fails the run over a measurement: an artifact that will not download,
 * a report that will not parse, an API that will not answer — each is a warning
 * and the lane keeps yesterday's numbers. The only red is a config that cannot
 * be read, because then nothing at all is being measured.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { junitPrefix, mergeReports, parseDurationsJson, parseJunit, reportItems } from "./lib/reports.mjs";
import { annotations, mergeLedger, slowReport, summaryMarkdown } from "./lib/refresh.mjs";
import { DEFAULT_SLOW_FILE_SECONDS, DEFAULT_TARGET_SECONDS, readLedger, serialiseLedger } from "./lib/timings.mjs";

const arg = (name, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const API = process.env.GITHUB_API_URL || "https://api.github.com";
const REPO = process.env.GITHUB_REPOSITORY;
const RUN = arg("run-id", process.env.GITHUB_RUN_ID || "");
const TOKEN = process.env.GITHUB_TOKEN || "";

/** A GET that retries what is worth retrying: a 5xx or a dropped connection, three times. */
async function get(url) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json" },
        redirect: "follow",
      });
      if (res.ok) return res;
      last = new Error(`${url.replace(API, "")}: HTTP ${res.status}`);
      if (res.status < 500) throw last;
    } catch (error) {
      last = error;
      if (/HTTP 4\d\d/.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
  throw last;
}

const api = async (path) => (await get(`${API}${path}`)).json();

async function paged(path, key) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const body = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...(body[key] ?? []));
    if ((body[key] ?? []).length < 100) break;
  }
  return out;
}

async function download(artifact, into) {
  const res = await get(`${API}/repos/${REPO}/actions/artifacts/${artifact.id}/zip`);
  const zip = join(into, `${artifact.id}.zip`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const dir = join(into, String(artifact.id));
  mkdirSync(dir, { recursive: true });
  execFileSync("unzip", ["-q", "-o", zip, "-d", dir]);
  return dir;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const seconds = (step) =>
  step?.started_at && step?.completed_at ? (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000 : null;

function readReports(dir, lane) {
  const filesRe = new RegExp(lane.files);
  const reports = [];
  for (const file of walk(dir)) {
    const rel = relative(dir, file).replace(/\\/g, "/");
    if (!filesRe.test(rel)) continue;
    const text = readFileSync(file, "utf8");
    const rows =
      lane.format === "junit" ? parseJunit(text, junitPrefix(rel, lane.junitRoot ?? "reports/")) : parseDurationsJson(text);
    reports.push(reportItems(rows, lane.rewrite ?? []));
  }
  return reports;
}

/** Leg n of an artifact (`…-s3`) or a job (`… · shard 3/6`); a lone unsharded leg is 1. */
export const legOfArtifact = (name) => Number(/-s(\d+)$/.exec(name)?.[1] ?? 1);
export const legOfJob = (name) => Number(/shard (\d+)\//.exec(name)?.[1] ?? 1);

/**
 * The commit the measured run tested. This run's own sha when it measures
 * itself; another run's head_sha when `--run-id` names one, since this run's
 * checkout (a probe or backfill branch) is not what produced the timings.
 * Null when the run cannot be read: the ledger never records a wrong commit.
 */
export async function measuredSha(run, { ownRunId, ownSha, readRun }) {
  if (String(run) === String(ownRunId)) return ownSha || null;
  try {
    return (await readRun(run))?.head_sha ?? null;
  } catch {
    return null;
  }
}

async function measureLane(name, lane, { artifacts, jobs, scratch }) {
  const re = new RegExp(lane.artifacts);
  const mine = artifacts.filter((a) => re.test(a.name) && !a.expired);
  const reports = [];
  const measuredByLeg = new Map(); // leg -> seconds summed over that leg's reports
  for (const artifact of mine) {
    try {
      const legReports = readReports(await download(artifact, scratch), lane);
      reports.push(...legReports);
      const leg = legOfArtifact(artifact.name);
      const sum = legReports.reduce((a, r) => a + [...r.values()].reduce((b, x) => b + x.seconds, 0), 0);
      // A re-run attempt of the same leg: keep the larger, as mergeReports does per item.
      measuredByLeg.set(leg, Math.max(measuredByLeg.get(leg) ?? 0, sum));
    } catch (error) {
      console.log(`::warning title=lane-timings (${name})::could not read ${artifact.name}: ${error.message}`);
    }
  }
  const jobRe = lane.job ? new RegExp(lane.job) : null;
  const legs = jobRe ? jobs.filter((j) => jobRe.test(j.name)) : [];
  const stepSeconds = [];
  const missing = [];
  // Concurrency only from legs that left BOTH a report and a step time: a leg
  // whose artifact expired or never uploaded would otherwise count its wall
  // time against nobody's measurements.
  const paired = { measured: 0, wall: 0 };
  for (const job of legs.sort((a, b) => legOfJob(a.name) - legOfJob(b.name))) {
    const step = (job.steps ?? []).find((s) => s.name === lane.step);
    const s = step?.status === "completed" ? seconds(step) : null;
    if (s == null) {
      missing.push(job.name);
      continue;
    }
    const leg = legOfJob(job.name);
    stepSeconds.push({ leg, seconds: s });
    if (measuredByLeg.has(leg)) {
      paired.measured += measuredByLeg.get(leg);
      paired.wall += s;
    }
  }
  return { measured: mergeReports(reports), stepSeconds, paired, missing, artifactCount: mine.length };
}

async function main() {
  const configPath = arg("config", ".lane-timings.json");
  const root = arg("root", ".");
  let config;
  try {
    config = JSON.parse(readFileSync(join(root, configPath), "utf8"));
  } catch (error) {
    console.error(`::error title=lane-timings::cannot read ${configPath}: ${error.message}`);
    process.exit(1);
  }
  const targetSeconds = Number(config.targetSeconds) || DEFAULT_TARGET_SECONDS;
  const slowFileSeconds = Number(config.slowFileSeconds) || DEFAULT_SLOW_FILE_SECONDS;
  const scratch = mkdtempSync(join(tmpdir(), "lane-timings-"));

  let artifacts = [];
  let jobs = [];
  try {
    artifacts = await paged(`/repos/${REPO}/actions/runs/${RUN}/artifacts`, "artifacts");
  } catch (error) {
    console.log(`::warning title=lane-timings::could not list the run's artifacts (${error.message}); no ledger changes.`);
  }
  try {
    jobs = await paged(`/repos/${REPO}/actions/runs/${RUN}/jobs?filter=latest`, "jobs");
  } catch (error) {
    // Without step times the costs still refresh; only the concurrency keeps yesterday's value.
    console.log(`::warning title=lane-timings::could not list the run's jobs (${error.message}); concurrency and slow legs are not measured.`);
  }

  const meta = {
    run: `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${REPO}/actions/runs/${RUN}`,
    sha: await measuredSha(RUN, {
      ownRunId: process.env.GITHUB_RUN_ID,
      ownSha: process.env.GITHUB_SHA,
      readRun: (id) => api(`/repos/${REPO}/actions/runs/${id}`),
    }),
    at: new Date().toISOString(),
  };
  const results = [];
  for (const [name, lane] of Object.entries(config.lanes ?? {})) {
    const ledgerPath = join(root, lane.ledger);
    const ledger = readLedger(ledgerPath);
    const { measured, stepSeconds, paired, missing, artifactCount } = await measureLane(name, lane, { artifacts, jobs, scratch });
    let next = ledger;
    if (measured.size > 0) {
      const merged = mergeLedger(ledger, measured, {
        exists: (item) => existsSync(join(root, item)),
        paired,
        measuredMeta: meta,
      });
      next = { ...merged.ledger, lane: name };
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, serialiseLedger(next));
      console.log(
        `[lane-timings] ${name}: ${measured.size} item(s) from ${artifactCount} artifact(s); ` +
          `+${merged.changes.added.length} new, ${merged.changes.updated} updated, ${merged.changes.kept} kept, ` +
          `-${merged.changes.removed.length} gone; concurrency ${next.concurrency}.`,
      );
    } else {
      console.log(`::warning title=lane-timings (${name})::no report measured anything in this run; the ledger is unchanged.`);
    }
    const report = slowReport(name, measured, { slowFileSeconds, targetSeconds, stepSeconds, ledger: next, maxShards: Number(lane.maxShards) });
    for (const line of annotations(report, { targetSeconds, slowFileSeconds })) console.log(line);
    results.push({ lane: name, report, measuredCount: measured.size, ledgerCount: next.files.size, concurrency: next.concurrency, missing });
  }

  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(results, { targetSeconds, slowFileSeconds }));
  rmSync(scratch, { recursive: true, force: true });
  const reportPath = arg("report");
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify({ targetSeconds, slowFileSeconds, run: meta, lanes: results }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // A measurement is never worth a red run.
    console.log(`::warning title=lane-timings::refresh stopped: ${error.stack || error.message}`);
  });
}
