#!/usr/bin/env node
/**
 * The unit and integration plan jobs size their matrix by measured time when
 * the caller hands them a ledger (12-apps/ci lane-timings), and the wiring
 * that makes that true is order-sensitive in three places, each pinned here:
 *
 *   1. the sizing runs AFTER skip-green's filter, so it sizes the list the legs
 *      will actually run, and BEFORE the upload, so the legs download a plan
 *      that names their lists;
 *   2. affected-plan does not upload its own copy when a ledger is set (one
 *      artifact name cannot hold two documents);
 *   3. the shard-list step takes the ledger's answer over the file-count one,
 *      and a reused verdict still empties the matrix after it.
 *
 * And the reusable refresh workflow keeps its report job running when no PR
 * can land, and never lands from a job that holds `actions: read` only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tests = readFileSync(join(here, "..", "monorepo-tests.yml"), "utf8");
const refresh = readFileSync(join(here, "..", "lane-timings-refresh.yml"), "utf8");

/** The text of one top-level job, up to the next one. */
function job(text, name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `no job ${name}`);
  const next = text.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next);
}

for (const [lane, cap] of [["unit", "unit-shards"], ["integration", "integration-shards"]]) {
  const plan = job(tests, `${lane}-plan`);
  const at = (needle) => {
    const i = plan.indexOf(needle);
    assert.notEqual(i, -1, `${lane}-plan is missing: ${needle}`);
    return i;
  };

  test(`${lane}-plan: filter → size → upload → shard list`, () => {
    const filter = at("id: skipgreen");
    const size = at("id: timings");
    const upload = at("- name: Upload the filtered plan");
    const list = at("- name: Compute the shard list");
    assert.ok(filter < size && size < upload && upload < list, "the sizing must sit between the filter and the upload");
  });

  test(`${lane}-plan: the size step reads the caller's ledger and is capped by ${cap}`, () => {
    const step = plan.slice(at("id: timings"), at("- name: Upload the filtered plan"));
    assert.match(step, /uses: 12-apps\/ci\/\.github\/actions\/lane-timings@v2/);
    assert.match(step, /mode: size/);
    assert.match(step, new RegExp(`plan: affected-plan\\.${lane}\\.json`));
    assert.match(step, new RegExp(`ledger: \\$\\{\\{ inputs\\.${lane}-timings-ledger \\}\\}`));
    assert.match(step, new RegExp(`max-shards: \\$\\{\\{ inputs\\.${cap} \\}\\}`));
    assert.match(step, new RegExp(`inputs\\.${lane}-timings-ledger != ''`));
    assert.match(step, /github\.event_name == 'pull_request'/);
  });

  test(`${lane}-plan: a ledger alone still uploads the plan the legs run`, () => {
    const upload = plan.slice(at("- name: Upload the filtered plan"), at("- name: Compute the shard list"));
    assert.match(upload, new RegExp(`\\(inputs\\.skip-green != '' \\|\\| inputs\\.${lane}-timings-ledger != ''\\)`));
  });

  test(`${lane}-plan: the ledger's count wins, and a reused verdict still empties the matrix`, () => {
    const list = plan.slice(at("- name: Compute the shard list"));
    const skip = list.indexOf('PLAN_ASKED="$SKIP_GREEN_ASKED"');
    const timings = list.indexOf('PLAN_ASKED="$TIMINGS_ASKED"');
    const verdict = list.indexOf('if [ "$VERDICT_HIT" = "true" ]; then');
    assert.ok(skip !== -1 && timings !== -1 && verdict !== -1);
    assert.ok(skip < timings && timings < verdict, "skip-green, then the ledger, then the verdict");
    assert.match(list, /TIMINGS_SIZED: \$\{\{ steps\.timings\.outputs\.sized \}\}/);
    // Clamped to the cap like every other source of the count.
    assert.match(list, /if \[ "\$COUNT" -gt "\$SHARDS" \]; then COUNT="\$SHARDS"; fi/);
  });
}

for (const [lane, jobName, runStep] of [["unit", "unit-tests", "Run unit tests"], ["integration", "integration-tests", "Run integration tests"]]) {
  test(`${jobName}: each leg reads its packed list after the plan lands, and hands it to the command`, () => {
    const body = job(tests, jobName);
    const download = body.indexOf("- name: Download the affected test plan");
    const leg = body.indexOf("id: leg\n");
    const run = body.indexOf(`- name: ${runStep}`);
    assert.ok(download !== -1 && leg !== -1 && run !== -1, `${jobName} has the download, leg and run steps`);
    assert.ok(download < leg && leg < run, "download → leg → run");
    const step = body.slice(leg, run);
    assert.match(step, /mode: leg/);
    assert.match(step, new RegExp(`plan: \\.affected-plan/affected-plan\\.${lane}\\.json`));
    assert.match(step, /leg: \$\{\{ matrix\.shard \}\}/);
    assert.match(step, /when-sized: 'true'/);
    assert.match(step, new RegExp(`inputs\\.${lane}-timings-ledger != ''`));
    assert.match(body.slice(run), /LANE_LEG_FILE: \$\{\{ steps\.leg\.outputs\.file != '' && format/);
  });
}

test("the inputs are declared, optional, and off by default", () => {
  for (const name of ["unit-timings-ledger", "integration-timings-ledger"]) {
    const block = tests.slice(tests.indexOf(`      ${name}:\n`), tests.indexOf(`      ${name}:\n`) + 1200);
    assert.match(block, /required: false/);
    assert.match(block, /default: ''/);
  }
  assert.match(tests, /lane-target-seconds:[\s\S]{0,400}default: 600/);
});

test("refresh: measure reports even when no PR can land, and lands only a change", () => {
  const measure = job(refresh, "measure");
  const land = job(refresh, "land");
  assert.match(measure, /if: \$\{\{ always\(\) && needs\.prepare\.result == 'success' \}\}/);
  assert.match(measure, /actions: read/);
  assert.doesNotMatch(measure, /contents: write/, "the job that reads artifacts must not hold a write token");
  assert.match(measure, /mode: refresh/);
  assert.match(land, /needs\.prepare\.outputs\.action == 'regen'/);
  assert.match(land, /needs\.measure\.outputs\.changed == 'true'/);
  assert.match(land, /mode: land/);
  assert.match(refresh, /default: 'chore\/lane-timings-'/, "its own prefix, so it never closes an ordinary regen PR");
  assert.match(refresh, /default: '\.lane-timings\/\*\*'/, "it may write the ledgers and nothing else by default");
});
