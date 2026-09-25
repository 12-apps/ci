import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// setup-node's pnpm cache must stand down on a self-hosted runner whose host
// already carries a warm pnpm store (runner-host's warm-pnpm-store.sh), and
// only there. The switch is the caller's repository variable CI_PNPM_STORE:
// `warm` once its fleet's image has the store.
//
// Left as `cache: pnpm`, every job on the fleet downloads and extracts the
// whole store (508 MB for future-pay, ~13 s a job, 50 MB/s from Stockholm)
// on top of the one already on its disk, and two slots extract into the
// shared store at once. Written the obvious way round,
// `self-hosted && warm && '' || 'pnpm'`, the empty string is falsy and the
// expression ALWAYS yields 'pnpm': the switch would do nothing, silently.

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..");
// The clause every pnpm cache must end with; a job may put its own condition
// in front (`inputs.install && …`).
const CLAUSE = "!(runner.environment == 'self-hosted' && vars.CI_PNPM_STORE == 'warm') && 'pnpm' || '' }}";

test("every setup-node pnpm cache stands down on a warm self-hosted runner", () => {
  const offenders = [];
  let seen = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
    readFileSync(path.join(dir, f), "utf8").split("\n").forEach((line, i) => {
      const m = /^\s+cache:\s*(.+?)\s*$/.exec(line);
      if (!m || !/pnpm/.test(m[1])) return;
      seen++;
      if (!(m[1].startsWith("${{ ") && m[1].endsWith(CLAUSE))) offenders.push(`${f}:${i + 1}: cache: ${m[1]}`);
    });
  }
  assert.ok(seen > 0, "no setup-node pnpm cache found at all: the scan is broken");
  assert.deepEqual(offenders, []);
});

test("the switch yields '' only for a self-hosted runner with CI_PNPM_STORE=warm", () => {
  // GitHub's && and || return an operand, as JavaScript's do, and '' is falsy.
  const cache = (environment, store) => (!(environment === "self-hosted" && store === "warm") && "pnpm") || "";
  assert.equal(cache("github-hosted", "warm"), "pnpm");
  assert.equal(cache("self-hosted", ""), "pnpm");
  assert.equal(cache("self-hosted", "cold"), "pnpm");
  assert.equal(cache("self-hosted", "warm"), "");
  // The obvious spelling never turns the cache off.
  const naive = (environment, store) => (environment === "self-hosted" && store === "warm" && "") || "pnpm";
  assert.equal(naive("self-hosted", "warm"), "pnpm");
});
