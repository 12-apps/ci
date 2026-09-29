import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
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
