/**
 * A turbo cache RESTORES on every run and WRITES on none of the pull requests.
 *
 * `actions/cache@v4` is restore-plus-a-post-step-save, and that post step fires
 * whenever the exact key missed. Every turbo key here is the commit sha, which
 * by construction has never been seen before — so the combined action wrote a
 * fresh ~1 GB entry on every commit under a key nothing would ever ask for
 * again. Measured on a future-pay `Tests / Build` job: 10s to restore ~995 MB
 * by prefix, 31s to write the ~1 GB nobody reads, out of a 100s job.
 *
 * The seconds are the smaller half. Four turbo namespaces at ~1 GB is ~4 GB
 * written per commit against a 10 GB repository ceiling with LRU eviction, so
 * a couple of pushes evict every other cache in the repository — the vitest
 * results the failed-first ordering depends on, the pnpm store, the PGlite
 * template — and each of those then pays a cold restore of its own. The
 * write is what makes the whole cache estate churn.
 *
 * Both halves of the fix are silent if they regress, which is why they are
 * asserted rather than remembered:
 *
 *   - going back to `actions/cache@v4` restores the unconditional write, and
 *     nothing goes red — CI is simply slower and the ceiling thrashes again;
 *   - dropping the `restore-keys` prefix makes every restore a guaranteed MISS
 *     (the sha key cannot pre-exist), so every lane runs cold, and that is
 *     green too. It is the failure the previous author already guarded against
 *     in prose; this makes it a test.
 *
 * Node builtins only — the self-test lane runs before any install.
 *
 * Usage: node --test .github/workflows/__tests__/turbo-cache-writes.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKFLOWS = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every `key: turbo-…` in the workflow estate, with the step block around it. */
function turboCacheSteps() {
  const found = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = readFileSync(join(WORKFLOWS, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      const key = /^\s*key:\s*(turbo-[a-z-]+)-\$\{\{/.exec(line);
      if (!key) return;
      // The step is the block from its `- name:` down to the next one.
      let start = i;
      while (start > 0 && !/^\s*- (name|uses):/.test(lines[start])) start -= 1;
      let end = i;
      while (end < lines.length - 1 && !/^\s*- (name|uses):/.test(lines[end + 1])) end += 1;
      found.push({ file, namespace: key[1], line: i + 1, block: lines.slice(start, end + 1).join("\n") });
    });
  }
  return found;
}

test("the estate still has turbo caches to talk about", () => {
  // A parser that matches nothing certifies a clean estate. Every assertion
  // below is vacuous without this one.
  const steps = turboCacheSteps();
  const namespaces = new Set(steps.map((s) => s.namespace));
  assert.ok(steps.length >= 4, `expected the turbo cache steps, found ${steps.length}`);
  assert.deepEqual(
    [...namespaces].sort(),
    ["turbo-build", "turbo-lint", "turbo-typecheck", "turbo-unit"],
    "a turbo namespace appeared or vanished — decide about its writes, do not inherit them",
  );
});

test("a restore never carries the post-step save", () => {
  for (const step of turboCacheSteps()) {
    if (!/restore-keys:/.test(step.block)) continue; // this is a save step
    assert.match(
      step.block,
      /uses: actions\/cache\/restore@/,
      `${step.file}:${step.line} (${step.namespace}) restores with the COMBINED action, whose post step writes ~1 GB under a sha key nothing will ever read. Use actions/cache/restore@v4 and add a PR-gated actions/cache/save@v4.`,
    );
  }
});

test("every restore keeps the prefix fallback that makes the cache readable at all", () => {
  for (const step of turboCacheSteps()) {
    if (/actions\/cache\/save@/.test(step.block)) continue;
    assert.match(
      step.block,
      /restore-keys:/,
      `${step.file}:${step.line} (${step.namespace}) has no restore-keys. The key is the commit sha, so without a prefix fallback EVERY restore misses and every lane runs cold — green, and twice as slow.`,
    );
  }
});

test("every write is gated off pull requests", () => {
  const saves = turboCacheSteps().filter((s) => /actions\/cache\/save@/.test(s.block));
  assert.equal(saves.length, 4, `expected one save per namespace, found ${saves.length}`);
  for (const step of saves) {
    assert.match(
      step.block,
      /if:[^\n]*github\.event_name != 'pull_request'/,
      `${step.file}:${step.line} (${step.namespace}) writes on pull requests too. That is ~1 GB per commit per namespace against a 10 GB ceiling, and it evicts every other cache in the repository.`,
    );
  }
});

// ---------------------------------------------------------------------------
// FUT-4538: a caller may skip the Build job's pull-request RESTORE.
//
// future-pay measured 169 of 175 PR Build restores reusing nothing, at a
// median ~100 s download against a ~50 s build. `build-turbo-restore: false`
// drops that download on pull requests only. Three regressions would all be
// green: a default that flips (every consumer silently loses its warm PR
// builds), the input leaking off pull requests (the default branch builds
// cold every day), or the save starting to read it (main stops writing the
// entry every PR restores). Each is pinned below.
// ---------------------------------------------------------------------------

const TESTS_YML = readFileSync(join(WORKFLOWS, "monorepo-tests.yml"), "utf8");

/** The `build-turbo-restore` declaration block under workflow_call.inputs. */
function buildTurboRestoreInput() {
  const m = /\n {6}build-turbo-restore:\n((?: {8}.*\n| {10}.*\n)+)/.exec(TESTS_YML);
  return m ? m[1] : null;
}

function buildSteps() {
  return turboCacheSteps().filter((s) => s.file === "monorepo-tests.yml" && s.namespace === "turbo-build");
}

/** The single-line `if:` of a step block, as the text inside `${{ }}`. */
function ifExpression(block) {
  const m = /\n\s*if:\s*\$\{\{\s*(.*?)\s*\}\}\s*\n/.exec(`\n${block}\n`);
  return m ? m[1] : null;
}

/**
 * Evaluates the subset of GitHub's expression language these two `if:`s use
 * (`!=`, `==`, `&&`, `||`, `!`, parentheses, string literals, three context
 * reads). Anything else in the expression throws, so a rewrite that this
 * cannot read fails loudly instead of being judged on a guess.
 */
function evaluate(expr, { event, input, hit }) {
  const values = {
    "steps.lane-verdict.outputs.hit": JSON.stringify(hit),
    "github.event_name": JSON.stringify(event),
    "inputs.build-turbo-restore": JSON.stringify(input),
  };
  let js = expr;
  for (const [ref, value] of Object.entries(values)) js = js.split(ref).join(value);
  const rest = js.replace(/'[^']*'|"[^"]*"|true|false|!=|==|&&|\|\||[()!\s]/g, "");
  if (rest !== "") throw new Error(`unreadable expression: ${expr} (left: ${rest})`);
  return Boolean(new Function(`return (${js.replace(/!=/g, "!==").replace(/([^!=])==/g, "$1===")});`)());
}

test("build-turbo-restore is declared as a boolean that defaults to TODAY's behaviour", () => {
  const block = buildTurboRestoreInput();
  assert.ok(block, "monorepo-tests.yml declares no build-turbo-restore input; a caller passing it is a startup_failure");
  assert.match(block, /^\s+type: boolean$/m);
  assert.match(block, /^\s+required: false$/m);
  assert.match(block, /^\s+default: true$/m, "the default must keep the PR restore on, or every consumer silently loses it");
});

test("the Build restore honours build-turbo-restore on pull requests only", () => {
  const restore = buildSteps().find((s) => /actions\/cache\/restore@/.test(s.block));
  assert.ok(restore, "no turbo-build restore step found");
  const expr = ifExpression(restore.block);
  assert.ok(expr, `the restore step has no single-line if: ${restore.block}`);
  const cases = [
    // event, input, verdict hit -> restores?
    ["pull_request", true, "", true],
    ["pull_request", false, "", false],
    ["push", true, "", true],
    ["push", false, "", true],
    ["schedule", false, "", true],
    ["workflow_dispatch", false, "", true],
    ["pull_request", true, "true", false],
    ["push", false, "true", false],
  ];
  for (const [event, input, hit, want] of cases) {
    assert.equal(
      evaluate(expr, { event, input, hit }),
      want,
      `event=${event} build-turbo-restore=${input} verdict-hit=${hit || "no"}: restore ${want ? "must" : "must not"} run (if: ${expr})`,
    );
  }
});

test("the Build save never reads build-turbo-restore", () => {
  const save = buildSteps().find((s) => /actions\/cache\/save@/.test(s.block));
  assert.ok(save, "no turbo-build save step found");
  assert.doesNotMatch(save.block, /build-turbo-restore/, "the save must not depend on the restore input: main keeps writing the entry PRs restore");
  const expr = ifExpression(save.block);
  for (const input of [true, false]) {
    assert.equal(evaluate(expr, { event: "push", input, hit: "" }), true, "main/daily always save");
    assert.equal(evaluate(expr, { event: "pull_request", input, hit: "" }), false, "a PR never saves");
  }
});

test("the evaluator refuses what it cannot read", () => {
  assert.throws(() => evaluate("contains(github.event_name, 'pull')", { event: "push", input: true, hit: "" }));
  assert.equal(evaluate("github.event_name != 'pull_request' || inputs.build-turbo-restore", { event: "pull_request", input: false, hit: "" }), false);
});
