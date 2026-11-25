import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBlock } from "./run-block.mjs";

// future-pay FUT-5526: off a pull request, Type Check ran one `turbo run
// check-types` over every package. turbo started up to ten tsc processes at
// once, and web's 10.7 GB beside admin's 3.5 GB OOM-killed a 14.1 GB slot
// (exit 137, no heap error). `type-check-alone` runs each named package in an
// invocation of its own, after the rest. This runs the REAL `run:` block of
// monorepo-static.yml's "Type check" step the way GitHub runs `shell: bash`,
// with a fake `pnpm` that records its arguments.

const WORKFLOW = new URL("../monorepo-static.yml", import.meta.url);

const FAKE_PNPM = `#!/bin/bash
echo "$*" >> "$CALLS"
for a in "$@"; do [ "$a" = "--filter=$FAIL_ON" ] && exit 2; done
echo "turbo output for: $*"
exit 0
`;

function run(vars) {
  const dir = mkdtempSync(join(tmpdir(), "type-check-alone-"));
  try {
    writeFileSync(join(dir, "step.sh"), runBlock(readFileSync(WORKFLOW, "utf8"), "Type check"));
    writeFileSync(join(dir, "pnpm"), FAKE_PNPM);
    chmodSync(join(dir, "pnpm"), 0o755);
    const calls = join(dir, "calls");
    writeFileSync(calls, "");
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "step.sh")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CALLS: calls,
        GITHUB_EVENT_NAME: "push",
        SELECTION_BASE: "",
        TYPE_CHECK_ALONE: "",
        FAIL_ON: "",
        ...vars,
      },
    });
    return {
      status: r.status,
      calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
      log: readFileSync(join(dir, "typecheck.log"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("no type-check-alone: one invocation over everything, as before", () => {
  const r = run({});
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ["turbo run check-types"]);
});

test("a pull request is unchanged: --affected, even with type-check-alone set", () => {
  const r = run({ GITHUB_EVENT_NAME: "pull_request", SELECTION_BASE: "abc123", TYPE_CHECK_ALONE: "web" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ["turbo run check-types --affected"]);
});

test("off a PR, the rest runs first without the named package, then it runs alone", () => {
  const r = run({ TYPE_CHECK_ALONE: "web" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ["turbo run check-types --filter=!web", "turbo run check-types --filter=web"]);
  assert.match(r.log, /--filter=!web[\s\S]*--filter=web/, "typecheck.log keeps both invocations, in order");
});

test("several packages: each left out of the rest, then each alone, in order", () => {
  const r = run({ TYPE_CHECK_ALONE: " web  admin " });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, [
    "turbo run check-types --filter=!web --filter=!admin",
    "turbo run check-types --filter=web",
    "turbo run check-types --filter=admin",
  ]);
});

test("whitespace only is the same as empty", () => {
  const r = run({ TYPE_CHECK_ALONE: "   " });
  assert.deepEqual(r.calls, ["turbo run check-types"]);
});

test("a failing alone package fails the step with turbo's own exit code", () => {
  const r = run({ TYPE_CHECK_ALONE: "web", FAIL_ON: "web" });
  assert.equal(r.status, 2);
});
