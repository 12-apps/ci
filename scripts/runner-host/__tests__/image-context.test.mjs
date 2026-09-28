import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Every file the image COPYs must be one install.sh puts next to the
// Dockerfile on the host.
//
// The self-test builds the image straight from this directory, where every
// file is present, so a file missing from install.sh's list passes there and
// fails only on a real host: the weekly image refresh of 2026-09-28 died on
// `COPY job-usage.sh … not found` after #126 had gone green.

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

function copied() {
  return read("Dockerfile")
    .split("\n")
    .map((l) => /^COPY\s+(?!--from)(\S+)\s+\S+/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => m[1]);
}

function installed() {
  const src = read("install.sh").replace(/\\\n/g, " ");
  const line = src.split("\n").find((l) => /^install -m 0755 .*"\$prefix\/"/.test(l.trim()));
  assert.ok(line, "install.sh has the `install -m 0755 … \"$prefix/\"` line that ships the kit");
  return [...line.matchAll(/"\$here\/([^"]+)"/g)].map((m) => m[1]);
}

test("the Dockerfile COPYs something, so the check below is not vacuous", () => {
  assert.ok(copied().length >= 3, `COPY sources: ${copied().join(", ")}`);
});

test("every file the image COPYs is shipped to the host by install.sh", () => {
  const shipped = new Set(installed());
  const missing = copied().filter((f) => !shipped.has(f));
  assert.deepEqual(missing, [], `install.sh does not ship ${missing.join(", ")}; the image build fails on a real host`);
});
