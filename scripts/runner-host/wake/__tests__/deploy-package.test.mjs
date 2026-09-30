import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// deploy.sh packages the scaler from a list of files. A module index.mjs
// imports that is missing from the zip fails every invocation at import: no
// delivery is answered and the fleet stops growing, which unit tests of the
// modules themselves cannot see.

const WAKE = dirname(dirname(fileURLToPath(import.meta.url)));
const deploy = readFileSync(join(WAKE, "deploy.sh"), "utf8");

/** Every module reachable from `entry` through relative imports. */
function closure(entry, found = new Set()) {
  if (found.has(entry)) return found;
  found.add(entry);
  const source = readFileSync(join(WAKE, entry), "utf8");
  for (const [, dep] of source.matchAll(/^import[^;]*?from "\.\/([\w-]+\.mjs)";/gms)) closure(dep, found);
  return found;
}

test("the zip deploy.sh builds holds every module the handler imports", () => {
  const modules = [...closure("index.mjs")].sort();
  assert.ok(modules.includes("github.mjs") && modules.includes("scale.mjs"), `found ${modules.join(", ")}`);
  const copied = deploy.match(/^cp ((?:"\$here\/[\w-]+\.mjs" )+)"\$work\/"$/m);
  assert.ok(copied, "deploy.sh copies the modules with one cp line");
  const zipped = deploy.match(/python3 -m zipfile -c fn\.zip ([\w. -]+\.mjs)\)/);
  assert.ok(zipped, "deploy.sh zips the modules with one zipfile line");
  assert.deepEqual([...copied[1].matchAll(/\$here\/([\w-]+\.mjs)/g)].map((m) => m[1]).sort(), modules);
  assert.deepEqual(zipped[1].split(/\s+/).sort(), modules);
});

// The queue table block, run for real against a fake `aws`: it creates the
// table only when DynamoDB says it is missing. On 2026-09-30 an AccessDenied on
// describe-table (the weekly refresh's role) read as "missing", and the
// CreateTable that followed stopped the refresh after its smoke check passed.
function queueBlock(describe) {
  const start = deploy.indexOf("# Created only when DynamoDB says it does not exist.");
  const end = deploy.indexOf("\npolicy=$(", start);
  assert.ok(start !== -1 && end !== -1, "the queue-table block is where the test expects it");
  const dir = mkdtempSync(join(tmpdir(), "deploy-queue-"));
  const calls = join(dir, "calls.log");
  const script = `set -euo pipefail
aws() {
  echo "$*" >> "${calls}"
  case "$*" in
    *describe-table*) ${describe} ;;
    *) return 0 ;;
  esac
}
label=future-pay-ci
${deploy.slice(start, end)}
echo done`;
  const res = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const log = existsSync(calls) ? readFileSync(calls, "utf8") : "";
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, created: /create-table/.test(log) };
}

test("an existing queue table is left alone", () => {
  const r = queueBlock("return 0");
  assert.equal(r.status, 0);
  assert.equal(r.created, false);
});

test("a missing queue table is created", () => {
  const r = queueBlock('echo "An error occurred (ResourceNotFoundException) when calling the DescribeTable operation: Requested resource not found" >&2; return 254');
  assert.equal(r.status, 0);
  assert.equal(r.created, true);
});

test("a queue table the role cannot read is not created, and the deploy goes on", () => {
  const r = queueBlock('echo "An error occurred (AccessDeniedException) when calling the DescribeTable operation: not authorized" >&2; return 254');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.created, false);
  assert.match(r.stderr, /could not read the queue table ci-runner-queue-future-pay-ci/);
  assert.match(r.stdout, /done/);
});
