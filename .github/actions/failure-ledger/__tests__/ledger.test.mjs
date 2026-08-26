import { strict as assert } from "node:assert";
import { test } from "node:test";

import { classify, extractFiles, laneOf, normalize, parseExtraLanes } from "../lib/ledger.mjs";

// The half of the retry gate that fails SILENTLY.
//
// Everything else in this pair is loud when it breaks: a gate that reproduces a
// failure goes red, a gate that cannot read its ledger says so in the log. The
// EXTRACTOR is the one part whose breakage looks exactly like success — a
// detector that stopped recognising a runner's output records an empty ledger,
// the next run finds nothing to replay, stands down politely, and the pipeline
// goes on being slow. Nothing is red at any point, and the feature is simply
// gone. That is the same shape as the host-copy budget's detector test, and it
// is here for the same reason.
//
// So the fixtures below are real runner output, quoted from runs on this repo,
// not output invented to match the regexes.

// Quoted from 12-apps/future-pay run 33007552017, `Quality / E2E Reliability` —
// the failure that prompted this whole mechanism. Real runner output, not
// output invented to match the regexes.
const PLAYWRIGHT_LOG = `
[e2e-reliability] re-running 1 changed spec(s) 2x each, retries=0:
  - apps/admin/src/pages/config/orders/config-orders.e2e.ts
##[error]  1) [admin] > apps/admin/src/pages/config/orders/config-orders.e2e.ts:94:3 > Config - orders > Concluir ao pagar
    Error: expect(locator).not.toBeChecked() failed
        at /home/runner/work/future-pay/future-pay/apps/admin/src/pages/config/orders/config-orders.e2e.ts:120:77
##[notice]  1 failed
    [admin] > apps/admin/src/pages/config/orders/config-orders.e2e.ts:94:3 > Config - orders
  13 passed (2.0m)
`;

// The unit lane's shape: vitest runs with the PACKAGE as cwd, so the path it
// prints is package-relative and useless from the repo root. The workspace has
// to be recovered from the runner's own announcement above it.
const UNIT_LOG = `
[ci-planned] apps/web: 2 planned test file(s).
[ci-affected] $ pnpm --filter ./apps/web exec node /repo/scripts/vitest-with-teardown.mjs run
 FAIL  lib/wiring/__tests__/endpoint.test.ts > wireEndpoint > passes the actor through
AssertionError: expected 401 to be 200
 Test Files  1 failed | 12 passed (13)
`;

const INTEGRATION_LOG = `
[ci-planned] 3 planned integration file(s).
 FAIL  apps/web/tests/integration/soft-delete-default.integration.test.ts > archived rows
`;

// The fixtures above are the log as a BROWSER renders it. The logs API returns
// the bytes the runner wrote, and vitest paints its badge — so the escapes land
// in the gap between `FAIL` and the path, precisely where the pattern expects
// the path to start.
//
// This one is therefore built from character 27 rather than pasted, because a
// paste through any rendering surface silently loses the thing under test.
// Transcribed from 12-apps/future-pay run 33019734835, job 98347325455.
const ESC = String.fromCharCode(27);
const ANSI_UNIT_LOG = [
  "2026-08-26T22:30:24.1839941Z [ci-planned] apps/web: 1 planned test file(s).",
  `2026-08-26T22:30:25.3735097Z ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m lib/feature-flags/__tests__/retry-gate-evidence.test.ts${ESC}[2m > ${ESC}[22mretry gate evidence`,
].join("\n");

test("a playwright failure names its spec, repo-relative and once", () => {
  assert.deepEqual(extractFiles("e2e", PLAYWRIGHT_LOG), [
    "apps/admin/src/pages/config/orders/config-orders.e2e.ts",
  ]);
});

test("a unit failure is re-anchored onto the workspace that was running", () => {
  // The load-bearing case. Without the workspace walk this is
  // `lib/wiring/__tests__/endpoint.test.ts`, which does not exist from the repo
  // root — the gate would drop it and the unit lane would never be replayable.
  assert.deepEqual(extractFiles("unit", UNIT_LOG), [
    "apps/web/lib/wiring/__tests__/endpoint.test.ts",
  ]);
});

test("an integration failure is already repo-relative and is left alone", () => {
  assert.deepEqual(extractFiles("integration", INTEGRATION_LOG), [
    "apps/web/tests/integration/soft-delete-default.integration.test.ts",
  ]);
});

test("an absolute runner path is reduced to the repo's own view of it", () => {
  assert.equal(
    normalize("/home/runner/work/future-pay/future-pay/apps/admin/src/x.e2e.ts"),
    "apps/admin/src/x.e2e.ts",
  );
  assert.equal(normalize("packages/ui/src/y.test.ts"), "packages/ui/src/y.test.ts");
  assert.equal(normalize("./scripts/z.mjs"), "scripts/z.mjs");
});

test("a log that names nothing yields nothing — never a whole-lane replay", () => {
  // The tempting failure mode: the parse fails, so replay the lane entire. That
  // is minutes of work chosen at the moment of knowing least, and it is what
  // `classify` records as unreplayable instead.
  for (const lane of ["unit", "integration", "e2e"]) {
    assert.deepEqual(extractFiles(lane, "some log with no failures in it"), []);
  }
});

test("the job names this pipeline actually emits map to a lane", () => {
  // Quoted from run 33007552017's job list. A reusable workflow reports as
  // `<caller job> / <inner job>`, and a matrix leg carries its shard suffix —
  // both are easy to break with a tighter anchor.
  assert.equal(laneOf("Tests / Unit Tests · shard 3/4"), "unit");
  assert.equal(laneOf("Tests / Integration Tests · shard 1/4"), "integration");
  assert.equal(laneOf("Quality / E2E Reliability"), "e2e");
  assert.equal(laneOf("Quality / E2E (affected only)"), "e2e");
});

test("a planning job is not its lane", () => {
  // `SPA E2E Plan` selects specs; it does not run them, and a failure in it is
  // not a spec failure. Matching it as `e2e` would scrape a plan for filenames
  // and replay a list nothing had run.
  assert.equal(laneOf("SPA E2E Plan"), null);
  assert.equal(laneOf("Tests / Unit Plan"), null);
});

test("a gate lane is recorded, not replayed", () => {
  const { replay, unreplayable } = classify([
    { name: "Quality / Static Gates", failedStep: "Copy-paste detection (jscpd)", log: "boom" },
  ]);
  assert.deepEqual(replay, []);
  assert.equal(unreplayable.length, 1);
  assert.match(unreplayable[0].why, /no replay lane/);
  // The step name is what makes the artifact worth opening for a lane the gate
  // cannot replay — `Quality / Static Gates` runs ~20 steps and its log tail
  // shows the later ones passing.
  assert.equal(unreplayable[0].step, "Copy-paste detection (jscpd)");
});

test("a replayable lane whose log named nothing is recorded, not replayed", () => {
  const { replay, unreplayable } = classify([
    { name: "Tests / Unit Tests · shard 2/4", failedStep: "Unit tests", log: "OOM killed" },
  ]);
  assert.deepEqual(replay, []);
  assert.match(unreplayable[0].why, /no unit test file named/);
});

test("a real failure becomes a replay entry", () => {
  const { replay } = classify([
    { name: "Quality / E2E Reliability", failedStep: "Re-run changed e2e specs (retries=0)", log: PLAYWRIGHT_LOG },
  ]);
  assert.deepEqual(replay, [
    {
      lane: "e2e",
      job: "Quality / E2E Reliability",
      step: "Re-run changed e2e specs (retries=0)",
      files: ["apps/admin/src/pages/config/orders/config-orders.e2e.ts"],
    },
  ]);
});


// ── The consumer's own jobs ──────────────────────────────────────────────────
//
// The built-in table covers the jobs THIS repo's workflows emit. A consumer's
// own lanes come in through `extra-lanes`, and they are merged AHEAD of the
// built-ins so a consumer can also correct a match rather than only add one.

test("a consumer's own job routes through extra-lanes", () => {
  const extra = parseExtraLanes('{"Gherkin Journeys": "e2e"}');
  assert.equal(laneOf("Gherkin Journeys", extra), "e2e");
  // …and is unknown without it, which is the point: the shared package does not
  // pretend to know a job it never defined.
  assert.equal(laneOf("Gherkin Journeys"), null);
});

test("extra-lanes takes precedence over a built-in", () => {
  const extra = parseExtraLanes('{"^Tests \\\\/ Unit Tests": "custom"}');
  assert.equal(laneOf("Tests / Unit Tests · shard 1/4", extra), "custom");
});

test("an absent or empty extra-lanes is simply no extra lanes", () => {
  assert.deepEqual(parseExtraLanes(undefined), []);
  assert.deepEqual(parseExtraLanes(""), []);
  assert.deepEqual(parseExtraLanes("   "), []);
});

test("a consumer's own workspace marker can replace the default", () => {
  // A runner that announces itself differently must still be re-anchorable, or
  // the whole unit lane silently stops being replayable for that consumer.
  const log = ">>> entering packages/ui\n FAIL  src/Button/__tests__/Button.test.tsx > renders\n";
  assert.deepEqual(
    extractFiles("unit", log, String.raw`>>> entering ((?:apps|packages)/[\w.-]+)`),
    ["packages/ui/src/Button/__tests__/Button.test.tsx"],
  );
});


test("a colourised unit failure is extracted (the raw bytes, not the rendered log)", () => {
  // The bug this pins: every fixture above was ANSI-free, fourteen tests were
  // green, and the feature had never once extracted a file from a real run.
  // Measured on run 33019734835 — one named failing file in, `no unit test file
  // named in the log` out.
  assert.deepEqual(extractFiles("unit", ANSI_UNIT_LOG), [
    "apps/web/lib/feature-flags/__tests__/retry-gate-evidence.test.ts",
  ]);
});

test("colour changes nothing about what a log means", () => {
  // Stripping must be invisible rather than merely permissive: the same lines
  // with and without escapes have to produce the same answer, or the strip is
  // just a second way to read a log.
  const stripped = ANSI_UNIT_LOG.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
  assert.deepEqual(extractFiles("unit", ANSI_UNIT_LOG), extractFiles("unit", stripped));
});
