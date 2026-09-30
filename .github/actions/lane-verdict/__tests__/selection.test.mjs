// Execute the workflow's real context script and key material against a real
// Git graph. A text assertion alone cannot prove that retargeting changes keys.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { verdictKey } from "../verdict.mjs";

const root = mkdtempSync(join(tmpdir(), "lane-selection-"));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
mkdirSync(join(root, "packages/a"), { recursive: true }); mkdirSync(join(root, "packages/b"), { recursive: true });
writeFileSync(join(root, "packages/a/check.mjs"), "process.exit(0)\n");
writeFileSync(join(root, "packages/b/check.mjs"), "process.exit(0)\n");
const base = commit();
writeFileSync(join(root, "packages/a/check.mjs"), "process.exit(1)\n"); const lower = commit();
writeFileSync(join(root, "packages/b/check.mjs"), "process.exit(0) // upper\n"); const head = commit();
const workflows = join(dirname(fileURLToPath(import.meta.url)), "../../../workflows");
const bin = join(root, "bin"); mkdirSync(bin);
writeFileSync(join(bin, "pnpm"), '#!/usr/bin/env bash\nprintf "%s\\n" "$*"\nexit "${PNPM_STATUS:-0}"\n');
chmodSync(join(bin, "pnpm"), 0o755);

function job(file, name) {
  const text = readFileSync(join(workflows, file), "utf8");
  return new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, "m").exec(text)[1];
}

function blockScalar(block, key) {
  const match = new RegExp(`^( +)${key}: \\|\\n`, "m").exec(block);
  const lines = block.slice(match.index + match[0].length).split("\n");
  const indent = match[1].length + 2;
  const result = [];
  for (const line of lines) {
    if (line && !line.startsWith(" ".repeat(indent))) break;
    result.push(line.slice(indent));
  }
  return result.join("\n");
}

function resolveContext(body, candidate, stack = "") {
  const step = body.split("        id: selection\n")[1].split(/^      - /m)[0];
  const output = join(root, "outputs"); const envFile = join(root, "environment");
  writeFileSync(output, ""); writeFileSync(envFile, "");
  const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", blockScalar(step, "run")], {
    cwd: root, encoding: "utf8", env: { ...process.env, BASE_SHA: candidate, STACK_BASE: stack, GITHUB_OUTPUT: output, GITHUB_ENV: envFile },
  });
  assert.equal(r.status, 0, r.stderr);
  const pairs = (file) => Object.fromEntries(readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => line.split("=")));
  return { outputs: pairs(output), env: pairs(envFile) };
}

for (const [file, lane] of [["monorepo-static.yml", "lint"], ["monorepo-static.yml", "type-check"], ["monorepo-tests.yml", "build"]]) {
  test(`${lane}: actual workflow keys cannot reuse narrower base coverage on an identical tree`, () => {
    const body = job(file, lane);
    const material = blockScalar(body, "key-material");
    const key = (context) => verdictKey({ lane, event: "pull_request", fingerprintCommand: "fp", identity: () => "b".repeat(64),
      run: () => git("rev-parse", "HEAD^{tree}"),
      material: material.replace(/\$\{\{ steps\.selection\.outputs\.([a-z-]+) \}\}/g, (_, name) => context.outputs[name] ?? ""),
    }).key;
    const narrow = resolveContext(body, lower);
    const wide = resolveContext(body, base);
    assert.equal(narrow.env.TURBO_SCM_BASE, lower);
    assert.equal(wide.env.TURBO_SCM_BASE, base);
    assert.equal(wide.env.TURBO_SCM_HEAD, "HEAD");
    assert.notEqual(key(narrow), "");
    assert.notEqual(key(narrow), key(wide));
    assert.equal(key(wide), key(resolveContext(body, lower, base)), "the effective stack base is both keyed and executed");
    assert.deepEqual(git("diff", "--name-only", `${lower}...${head}`).split("\n"), ["packages/b/check.mjs"]);
    assert.ok(git("diff", "--name-only", `${base}...${head}`).includes("packages/a/check.mjs"));
    assert.equal(spawnSync("node", ["packages/a/check.mjs"], { cwd: root }).status, 1);
  });

  test(`${lane}: missing base leaves no context and disables the production lookup`, () => {
    const body = job(file, lane);
    assert.deepEqual(resolveContext(body, "missing-ref"), { outputs: {}, env: {} });
    assert.match(body, /if: .*steps\.selection\.outputs\.base-sha != ''/);
  });

  test(`${lane}: actual work runs full when its base is unknown, and never masks a failing task`, () => {
    const label = { lint: "Lint", "type-check": "Type check", build: "Build" }[lane];
    const body = job(file, lane);
    const step = body.split(`      - name: ${label}\n`)[1].split(/^      - /m)[0];
    assert.match(step, /SELECTION_BASE: \$\{\{ steps\.selection\.outputs\.base-sha \}\}/);
    for (const [event, selectionBase, affected] of [["pull_request", base, true], ["pull_request", "", false], ["push", base, false]]) {
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", blockScalar(step, "run")], {
        cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_NAME: event, SELECTION_BASE: selectionBase, PNPM_STATUS: "17" },
      });
      assert.equal(result.status, 17, result.stderr);
      assert.equal(result.stdout.includes("--affected"), affected, `${event}, ${selectionBase}`);
    }
    assert.match(blockScalar(body, "key-material"), /vars=\$\{\{ toJSON\(vars\) \}\}/);
  });
}

test("gates: ratchet lookup and execution carry the same immutable base and merge base", () => {
  const body = job("package-gates.yml", "gates");
  const material = blockScalar(body, "key-material");
  assert.match(material, /ratchet-base=\$\{\{ steps\.ratchet-base\.outputs\.base-sha \}\}/);
  assert.match(material, /ratchet-merge-base=\$\{\{ steps\.ratchet-base\.outputs\.merge-base \}\}/);
  assert.match(body, /if: .*inputs\.mcp-test-exemptions == '' \|\| steps\.ratchet-base\.outputs\.merge-base != ''/);
  assert.match(body.split("      - name: MCP test-coverage exemptions ratchet")[1], /base-sha: \$\{\{ steps\.ratchet-base\.outputs\.base-sha \}\}/);
});

for (const [file, lane, label] of [["monorepo-static.yml", "type-check", "Pre-typecheck setup"], ["monorepo-tests.yml", "build", "Pre-build setup"]]) {
  test(`${lane}: the real pre-command wrapper preserves pipeline and early-command failures`, () => {
    const step = job(file, lane).split(`      - name: ${label}\n`)[1].split(/^      - /m)[0];
    for (const command of ["false | cat", "false; true"]) {
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", blockScalar(step, "run")], {
        cwd: root, encoding: "utf8", env: { ...process.env, PRE_CMD: command },
      });
      assert.notEqual(result.status, 0, command);
    }
  });
}
