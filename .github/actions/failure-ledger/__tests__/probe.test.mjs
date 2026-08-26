import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { SCHEMA } from "../lib/ledger.mjs";
import { survivors } from "../probe.mjs";

// The probe runs in FRONT of the entire pipeline, so the only question that
// matters about it is what it does when it is unsure.
//
// The answer has to be "nothing", every time. The gate's value — minutes saved
// on a fix push — is worth approximately one bad red: a gate that stops a sound
// tree costs a full cycle plus the trust that makes the next red believable,
// and a gate nobody trusts gets deleted.
//
// The asymmetry runs the opposite way from a test SELECTOR, and it is worth
// stating because it decides every rule below. A selector that is wrong reports
// a green lane on code no test touched. This can only ever fail EARLY, never
// green — the real lanes still run in full behind it — so the cost of trusting
// a bad ledger is a false RED, and every rule here narrows toward standing down.

/** A checkout containing exactly `files`, and a ledger naming `named`. */
function fixture(files, named, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  for (const f of files) {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  const ledger = { schema: SCHEMA, run: { id: "1" }, replay: [{ lane: "unit", files: named }], ...extra };
  return { dir, ledger };
}

/** `survivors` resolves paths against cwd, so each case runs inside its fixture. */
function inDir(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

const FILE = "apps/web/lib/x/__tests__/y.test.ts";

test("a ledger naming a file this checkout has is replayable", () => {
  const { dir, ledger } = fixture([FILE], [FILE]);
  assert.deepEqual(inDir(dir, () => survivors(ledger)), [{ lane: "unit", files: [FILE] }]);
});

test("a file that has left the checkout is dropped, not guessed at", () => {
  // The rebase case, and the likeliest reason a ledger goes stale: the branch
  // moved and the failing test no longer exists. A gate that ran the rest of a
  // list it has stopped believing would be reporting on a tree that is gone.
  const { dir, ledger } = fixture([], [FILE]);
  assert.equal(inDir(dir, () => survivors(ledger)), null);
});

test("the runnable half of a mixed ledger still runs", () => {
  // Deliberately unlike a PLAN, which refuses wholesale: a plan decides what a
  // lane runs INSTEAD of its own selection, so a bad one narrows a verdict.
  // This only decides what runs FIRST, ahead of the same lanes running in full,
  // so dropping the unrunnable half cannot cost coverage.
  const gone = "apps/web/lib/x/__tests__/gone.test.ts";
  const { dir, ledger } = fixture([FILE], [FILE, gone]);
  assert.deepEqual(inDir(dir, () => survivors(ledger)), [{ lane: "unit", files: [FILE] }]);
});

test("a quarantined path never enters a replay", () => {
  // The one way this lane can be worse than not existing: a test that failed by
  // chance last time and fails by chance again turns a sound push red early
  // instead of green late.
  const { dir, ledger } = fixture([FILE], [FILE]);
  assert.equal(inDir(dir, () => survivors(ledger, ["lib/x/__tests__/y.test.ts"])), null);
});

test("a ledger from a future schema is not interpreted", () => {
  const { dir, ledger } = fixture([FILE], [FILE]);
  assert.equal(inDir(dir, () => survivors({ ...ledger, schema: SCHEMA + 1 })), null);
});

test("a malformed or empty ledger stands down", () => {
  const { dir } = fixture([], []);
  inDir(dir, () => {
    assert.equal(survivors(null), null);
    assert.equal(survivors({}), null);
    assert.equal(survivors({ schema: SCHEMA, replay: [] }), null);
    assert.equal(survivors({ schema: SCHEMA, replay: "not an array" }), null);
  });
});

test("an entry with no files at all stands down rather than replaying nothing", () => {
  // An empty replay reporting success would be a gate claiming a verdict it
  // never earned.
  const { dir, ledger } = fixture([FILE], []);
  assert.equal(inDir(dir, () => survivors(ledger)), null);
});
