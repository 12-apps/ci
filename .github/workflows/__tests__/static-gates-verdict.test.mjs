import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBlock } from "./run-block.mjs";

// FUT-4559: Static Gates reuses its verdict from the pull request's own last
// green head. A hit skips the install and the gates that read only the
// checked-out tree; the three ratchets that diff against the base branch and
// the flaky-quarantine check (it reads the clock) still run.
//
// Two halves:
//   - the job's REAL `if:` conditions are evaluated for a hit, a miss and the
//     input left empty, so a step that runs on a hit when it should not (or a
//     base-reading ratchet that a hit skips) fails here by name;
//   - the ratchets' REAL `run:` blocks run under `bash --noprofile --norc -eo
//     pipefail` in a scratch git repository with no install and no pnpm on
//     PATH, as they do on a hit, and the same pull request head goes green and
//     then red when only the base branch moves. That is why a head-keyed
//     verdict must never skip them.

const TEXT = readFileSync(new URL("../quality.yml", import.meta.url), "utf8");
const INPUT = "static-gates-fingerprint-command";

/** The static-gates job's steps as [{ name, cond, block }]. */
function jobSteps() {
  const lines = TEXT.split("\n");
  const start = lines.findIndex((l) => l === "  static-gates:");
  assert.ok(start >= 0, "quality.yml has no static-gates job");
  let end = lines.findIndex((l, i) => i > start && /^ {2}[a-z][a-z0-9-]*:$/.test(l));
  if (end === -1) end = lines.length;
  const body = lines.slice(start, end);
  const starts = body.map((l, i) => (/^ {6}- /.test(l) ? i : -1)).filter((i) => i !== -1);
  return starts.map((s, k) => {
    const block = body.slice(s, k + 1 < starts.length ? starts[k + 1] : body.length).join("\n");
    const name = /- name: (.+)/.exec(block)?.[1] ?? /uses: ([^\s@]+)/.exec(block)[1];
    const cond = /^ {8}if: \$\{\{ (.+) \}\}$/m.exec(block)?.[1] ?? null;
    return { name, cond, block };
  });
}

/**
 * Evaluates a GitHub expression over a context, for the operators this job
 * uses: `!`, `&&`, `||`, `==`, `!=`, parentheses, string literals, and the
 * status functions. Dotted names (dashes included) are looked up in `ctx`.
 */
function evaluate(cond, ctx) {
  if (cond === null) return true;
  const js = cond.replace(/\b(?:inputs|steps|github|vars|runner)\.[A-Za-z0-9_.-]*[A-Za-z0-9_]/g, (ref) => {
    assert.ok(ref in ctx, `the test has no value for ${ref} (in: ${cond})`);
    return JSON.stringify(ctx[ref]);
  });
  return Boolean(Function("cancelled", "success", "always", `return (${js});`)(() => false, () => true, () => true));
}

/** future-pay's quality call, plus the steps' outcomes for each scenario. */
function context({ enabled, hit }) {
  const missed = hit !== "true";
  return {
    [`inputs.${INPUT}`]: enabled ? "node scripts/ci-test-fingerprint.mjs --lane static-gates --ref \"$PR_HEAD_SHA\"" : "",
    "github.event_name": "pull_request",
    "inputs.run-knip": true,
    "inputs.run-data-views": false,
    "inputs.nextjs-app-dirs": "",
    "inputs.e2e-coverage-app-dirs": "apps/admin/src/pages",
    "inputs.e2e-content-app-dirs": "apps/admin/src/pages",
    "steps.lane-verdict.outputs.hit": enabled ? hit : "",
    "steps.lane-verdict.outputs.key": enabled ? "static-gates-lane-v1-0123456789abcdef-" + "a".repeat(64) : "",
    "steps.install.outcome": missed ? "success" : "skipped",
    "steps.background.outcome": missed ? "success" : "skipped",
    "steps.src.outputs.mode": missed ? "legacy" : "",
  };
}

const ran = (ctx) => jobSteps().filter((s) => evaluate(s.cond, ctx)).map((s) => s.name);

const ON_A_HIT = [
  "Resolve Node for the verdict",
  "Look up a recorded lane verdict",
  "Say what a verdict hit still runs",
  "pnpm/action-setup",
  "Validate flaky-quarantine.json",
  "Enforce .quality-exceptions burn-down (shrink-only + touch-must-fix)",
  "Enforce exceptions ratchet (shrink-only + touch-must-fix)",
  "Enforce exceptions ratchet (shrink-only + touch-must-fix)",
];

test(`${INPUT} is declared, opt-in and empty by default`, () => {
  const block = new RegExp(`^      ${INPUT}:\\n((?:(?:        .*|)\\n)+)`, "m").exec(TEXT);
  assert.ok(block, `${INPUT} is not declared — a caller passing it is a startup failure`);
  assert.match(block[1], /type: string/);
  assert.match(block[1], /required: false/);
  assert.match(block[1], /default: ''/);
});

test("a hit runs only the verdict steps, the base-branch ratchets and the clock check", () => {
  assert.deepEqual(ran(context({ enabled: true, hit: "true" })).filter((n) => n !== "actions/checkout"), ON_A_HIT);
});

test("a miss runs every gate and records last", () => {
  const names = ran(context({ enabled: true, hit: "false" }));
  for (const gate of [
    "Install dependencies",
    "Start jscpd and knip in the background",
    "Complexity gate (size/complexity on source)",
    "Flakiness gate (legacy consumer script)",
    "Copy-paste detection (jscpd)",
    "Unused files/exports/deps (knip)",
    "Enforce page.* ↔ e2e spec coverage",
    "Enforce e2e spec content-quality",
    "Validate flaky-quarantine.json",
    "Enforce .quality-exceptions burn-down (shrink-only + touch-must-fix)",
  ]) assert.ok(names.includes(gate), `${gate} must run on a miss`);
  assert.ok(!names.includes("Say what a verdict hit still runs"));
  assert.equal(names.at(-1), "Record the lane verdict", "a miss that passed records its verdict, as the last step");
});

test("with the input empty the job runs exactly what it ran before: no lookup, no record", () => {
  const off = ran(context({ enabled: false }));
  const miss = ran(context({ enabled: true, hit: "false" }));
  const verdictSteps = ["Resolve Node for the verdict", "Look up a recorded lane verdict", "Record the lane verdict"];
  for (const n of verdictSteps) assert.ok(!off.includes(n), `${n} must not run when ${INPUT} is empty`);
  assert.deepEqual(off, miss.filter((n) => !verdictSteps.includes(n)));
});

test("every step that runs on a hit needs no install", () => {
  const hit = context({ enabled: true, hit: "true" });
  for (const s of jobSteps().filter((x) => evaluate(x.cond, hit))) {
    const code = s.block.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    assert.doesNotMatch(code, /pnpm (install|exec|dlx)|npx |node_modules/, `${s.name} would need the install a hit skips`);
    for (const m of code.matchAll(/\bpnpm ([a-z:-]+)/g)) assert.equal(m[1], "quality:quarantine", `${s.name} runs pnpm ${m[1]}`);
  }
});

test("the lookup keys the PR head, Node and the gate inputs, and never the base branch or the run", () => {
  const steps = jobSteps();
  const at = (re) => steps.findIndex((s) => re.test(s.block));
  const lookup = at(/id: lane-verdict/);
  assert.ok(at(/actions\/checkout@/) < at(/id: verdict-node/) && at(/id: verdict-node/) < lookup, "Node is resolved after checkout and before the lookup");
  assert.ok(lookup < at(/pnpm\/action-setup@/), "the lookup precedes pnpm, setup-node's cache and the install");
  const block = steps[lookup].block;
  assert.equal(steps[lookup].cond, `inputs.${INPUT} != '' && github.event_name == 'pull_request'`, "opt-in, and never off a pull request");
  assert.match(block, /uses: 12-apps\/ci\/\.github\/actions\/lane-verdict@v2/);
  assert.match(block, /lane: static-gates\n/);
  assert.match(block, new RegExp(`fingerprint-command: \\$\\{\\{ inputs\\.${INPUT} \\}\\}`));
  assert.match(block, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/, "the consumer hashes the PR head, not the merge checkout");
  assert.match(block, /key-material: \|\n\s+node=\$\{\{ inputs\.node-version \}\}/);
  for (const input of ["run-knip", "run-data-views", "flakiness-targets", "nextjs-app-dirs", "loading-must-render",
    "e2e-coverage-app-dirs", "e2e-coverage-spec-suffix", "e2e-coverage-page-file", "e2e-coverage-exempt-globs", "e2e-coverage-exceptions",
    "e2e-content-app-dirs", "e2e-content-spec-suffix", "e2e-content-exempt-globs", "e2e-content-min-assertions", "e2e-content-exceptions"]) {
    assert.ok(block.includes(`inputs.${input} }}`), `${input} changes what a gate checks: it belongs in the key`);
  }
  assert.doesNotMatch(block, /github\.(sha|run_id|run_attempt|base_ref)|pull_request\.base|pre-e2e-command|e2e-build-artifact/,
    "a per-run value never hits; a base-branch value keys on main");
  const setupNode = steps.find((s) => /actions\/setup-node@/.test(s.block) && !/id: verdict-node/.test(s.block));
  assert.match(setupNode.block, /node-version: \$\{\{ steps\.verdict-node\.outputs\.node-version \|\| inputs\.node-version \}\}/);
});

test("the record is the job's last step, only after a passing miss with a key", () => {
  const last = jobSteps().at(-1);
  assert.equal(last.name, "Record the lane verdict");
  assert.equal(last.cond, "success() && steps.lane-verdict.outputs.key != '' && steps.lane-verdict.outputs.hit != 'true'");
  assert.match(last.block, /mode: record\n\s+lane: static-gates\n\s+key: \$\{\{ steps\.lane-verdict\.outputs\.key \}\}/);
});

// ── The ratchets' real run blocks, as a hit runs them ─────────────────────

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commitAll = (cwd, msg) => { git(cwd, "add", "-A"); git(cwd, "commit", "-q", "--allow-empty", "-m", msg); return git(cwd, "rev-parse", "HEAD"); };

/**
 * A scratch origin with `main`, a pull request branch, and a work clone whose
 * HEAD is the merge of the PR head into a given `main` tip, the way a
 * pull_request checkout (`refs/pull/N/merge`) is.
 */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "static-gates-verdict-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  git(work, "checkout", "-q", "-b", "main");
  const write = (path, text) => { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), text); };
  return {
    root, work, write,
    commit: (msg) => commitAll(work, msg),
    push: (ref) => git(work, "push", "-q", "origin", ref),
    /** Check out merge(main tip, PR head) as a detached HEAD. */
    mergeCheckout(mainSha, prHead) {
      git(work, "checkout", "-q", "--detach", mainSha);
      git(work, "merge", "-q", "--no-edit", "--no-ff", prHead);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Runs a step's real run block with no install and no pnpm on PATH. */
function runStep(cwd, name, env, nth = 0) {
  const script = join(cwd, "..", `step-${nth}.sh`);
  const blocks = TEXT.split(`- name: ${name}\n`);
  assert.ok(blocks.length > nth + 1, `no step "${name}" #${nth}`);
  writeFileSync(script, runBlock(`      - name: ${name}\n${blocks[nth + 1]}`, name));
  // A hit has no install: any pnpm call from these steps fails loudly.
  const shims = join(cwd, "..", "shims");
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, "pnpm"), "#!/bin/sh\necho 'pnpm called on a hit' >&2\nexit 97\n", { mode: 0o755 });
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd, encoding: "utf8", timeout: 30000, env: { ...process.env, PATH: `${shims}:${process.env.PATH}`, ...env },
  });
}

test("the .quality-exceptions ratchet runs with no install, and a base-branch move alone flips it", () => {
  const r = repo();
  try {
    r.write(".quality-exceptions", "# grandfathered\nsrc/old.ts\n");
    r.write("src/old.ts", "export const a = 1;\n");
    const base = r.commit("base");
    r.push("main");
    // The PR touches a listed file and leaves it listed: touch-must-fix.
    git(r.work, "checkout", "-q", "-b", "pr");
    r.write("src/old.ts", "export const a = 2;\n");
    const head = r.commit("pr touches old.ts");
    // main, without the PR, de-lists old.ts (it was fixed there).
    git(r.work, "checkout", "-q", "main");
    r.mergeCheckout(base, head);
    const red = runStep(r.work, "Enforce .quality-exceptions burn-down (shrink-only + touch-must-fix)", { BASE_REF: "main" });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stdout, /still grandfathered in \.quality-exceptions/);

    git(r.work, "checkout", "-q", "main");
    r.write(".quality-exceptions", "# grandfathered\n");
    const moved = r.commit("main de-lists old.ts");
    r.push("main");
    r.mergeCheckout(moved, head);
    const green = runStep(r.work, "Enforce .quality-exceptions burn-down (shrink-only + touch-must-fix)", { BASE_REF: "main" });
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /ratchet OK/);
  } finally {
    r.cleanup();
  }
});

test("the e2e coverage ratchet goes red on the same PR head when only the base branch moves", () => {
  // The counterexample a head-keyed verdict must never skip: the PR head is
  // unchanged, it was green, and a base-branch commit alone turns it red.
  const r = repo();
  const env = {
    BASE_REF: "main",
    EXCEPTIONS_FILE: ".e2e-coverage-exceptions.json",
    APP_DIRS: "apps/admin/src/pages",
    SPEC_SUFFIX: ".e2e.ts",
    EXEMPT: ".journey.,.global.",
    PAGE_FILE: "^index\\.tsx$",
  };
  try {
    r.write("apps/admin/src/pages/orders/index.tsx", "export const Orders = () => null;\n");
    const base = r.commit("base: a page, no exceptions file");
    r.push("main");
    git(r.work, "checkout", "-q", "-b", "pr");
    r.write("apps/admin/src/pages/orders/index.tsx", "export const Orders = () => 'pedidos';\n");
    const head = r.commit("pr edits the orders page");
    r.mergeCheckout(base, head);
    const green = runStep(r.work, "Enforce exceptions ratchet (shrink-only + touch-must-fix)", env, 0);
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /nothing to ratchet/);

    // main seeds the grandfather list with that page; the PR head is unchanged.
    git(r.work, "checkout", "-q", "main");
    r.write(".e2e-coverage-exceptions.json", JSON.stringify(["apps/admin/src/pages/orders"]) + "\n");
    const moved = r.commit("main seeds the exceptions file");
    r.push("main");
    r.mergeCheckout(moved, head);
    const red = runStep(r.work, "Enforce exceptions ratchet (shrink-only + touch-must-fix)", env, 0);
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, /changed files under segments still grandfathered/);
    assert.match(red.stderr, /apps\/admin\/src\/pages\/orders/);
  } finally {
    r.cleanup();
  }
});

test("the e2e content ratchet runs with no install and refuses a grown list", () => {
  const r = repo();
  const env = {
    BASE_REF: "main",
    EXCEPTIONS_FILE: ".e2e-content-exceptions.json",
    APP_DIRS: "apps/admin/src/pages",
    SPEC_SUFFIX: ".e2e.ts",
    EXEMPT: ".journey.,.global.",
    MIN_ASSERT: "2",
  };
  try {
    r.write(".e2e-content-exceptions.json", "[]\n");
    const base = r.commit("base: an empty list");
    r.push("main");
    git(r.work, "checkout", "-q", "-b", "pr");
    r.write(".e2e-content-exceptions.json", JSON.stringify(["apps/admin/src/pages/x/x.e2e.ts"]) + "\n");
    const head = r.commit("pr grandfathers a spec");
    r.mergeCheckout(base, head);
    const red = runStep(r.work, "Enforce exceptions ratchet (shrink-only + touch-must-fix)", env, 1);
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, /may only shrink, never grow/);
  } finally {
    r.cleanup();
  }
});
