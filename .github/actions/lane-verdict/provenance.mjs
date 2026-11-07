// A successful-result cache is evidence about an implementation and runtime,
// not just the consumer's tree. Resolve the central sources from THIS module:
// reusable workflows execute in the consumer checkout, which is not 12-apps/ci.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Never reuse entries written before failure-preserving shells and complete
// selection context were introduced. All success-result caches share this era.
export const VERDICT_SCHEMA = "ci-verdict-v2";

const SOURCE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function implementationHash(sourceRoot = SOURCE_ROOT) {
  const hash = createHash("sha256");
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        hash.update(JSON.stringify([relative(sourceRoot, path), statSync(path).mode & 0o111, bytes.length]));
        hash.update(bytes);
      } else throw new Error(`unsupported implementation source: ${path}`);
    }
  }
  // Hash both: workflows can change enforcement without changing the action,
  // and an action at moving @v2 can change independently of the consumer tree.
  visit(join(sourceRoot, ".github", "actions"));
  visit(join(sourceRoot, ".github", "workflows"));
  return hash.digest("hex");
}

/**
 * The implementation ONE reusable workflow executes, and nothing else
 * (FUT-4550). `implementationHash` folds every action and every workflow of
 * the engine, so every move of `@v2` — a deploy workflow, a README, a test of
 * an action the lane never calls — retired every skip-green manifest on every
 * open pull request: 5 moves in 42 hours on 2026-11-05/06, about 214
 * job-minutes re-running tests whose inputs had not moved.
 *
 * What it hashes:
 *   - the workflow file itself (`.github/workflows/<workflow>`);
 *   - every engine action it names (`12-apps/ci/.github/actions/<name>@…`),
 *     and every action THOSE name in their `action.yml`, transitively;
 *   - inside each such action, every file except its `__tests__/` and its
 *     Markdown — what runs, not what checks or explains it;
 *   - every file a hashed `.mjs`/`.js` imports by a relative path OUTSIDE
 *     the actions already hashed (one action importing another's module), and
 *     so on transitively; the action it lands in is then hashed whole.
 * Anything it cannot resolve — the workflow, a named action, an imported
 * file — THROWS: no identity, so nothing is reused. Never a narrower guess.
 */
const ACTION_REF = /12-apps\/ci\/\.github\/actions\/([A-Za-z0-9._-]+)@/g;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
const SKIPPED_IN_ACTION = (name, isDirectory) => (isDirectory ? name === "__tests__" : /\.md$/i.test(name));

export function laneImplementationFiles(workflow, sourceRoot = SOURCE_ROOT) {
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(String(workflow))) throw new Error(`not a workflow file name: ${JSON.stringify(workflow)}`);
  const files = new Set();
  const actions = new Set();
  const pending = [];
  const addFile = (path) => {
    if (files.has(path)) return;
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`lane implementation file missing: ${relative(sourceRoot, path)}`);
    files.add(path);
    pending.push(path);
  };
  const addAction = (name) => {
    if (actions.has(name)) return;
    const dir = join(sourceRoot, ".github", "actions", name);
    if (!existsSync(join(dir, "action.yml")) && !existsSync(join(dir, "action.yaml"))) throw new Error(`lane action missing: ${name}`);
    actions.add(name);
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (SKIPPED_IN_ACTION(entry.name, entry.isDirectory())) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) addFile(path);
        else throw new Error(`unsupported implementation source: ${path}`);
      }
    };
    walk(dir);
  };
  const actionsRoot = join(sourceRoot, ".github", "actions") + sep;
  const insideHashedAction = (target) => target.startsWith(actionsRoot) && actions.has(target.slice(actionsRoot.length).split(sep)[0]) && !target.split(sep).includes("__tests__") && !/\.md$/i.test(target);
  addFile(join(sourceRoot, ".github", "workflows", workflow));
  while (pending.length > 0) {
    const path = pending.pop();
    const text = readFileSync(path, "utf8");
    if (/\.ya?ml$/.test(path)) for (const [, name] of text.matchAll(ACTION_REF)) addAction(name);
    if (/\.(mjs|cjs|js)$/.test(path)) {
      for (const [, spec] of text.matchAll(RELATIVE_IMPORT)) {
        const target = resolve(dirname(path), spec);
        // Inside an action already hashed whole, the walk has it (and a
        // commented example import must not fail the identity).
        if (insideHashedAction(target)) continue;
        if (target !== sourceRoot && !target.startsWith(sourceRoot.endsWith(sep) ? sourceRoot : sourceRoot + sep)) {
          throw new Error(`${relative(sourceRoot, path)} imports outside the engine: ${spec}`);
        }
        const crossAction = target.startsWith(actionsRoot) ? target.slice(actionsRoot.length).split(sep)[0] : null;
        if (crossAction && existsSync(join(actionsRoot, crossAction, "action.yml"))) {
          if (!existsSync(target)) throw new Error(`${relative(sourceRoot, path)} imports a missing file: ${spec}`);
          addAction(crossAction);
        }
        else addFile(target);
      }
    }
  }
  return [...files].map((path) => relative(sourceRoot, path)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function laneImplementationHash(workflow, sourceRoot = SOURCE_ROOT) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(["lane-scope-v1", workflow]));
  for (const file of laneImplementationFiles(workflow, sourceRoot)) {
    const path = join(sourceRoot, file);
    const bytes = readFileSync(path);
    hash.update(JSON.stringify([file, statSync(path).mode & 0o111, bytes.length]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function executionIdentity({
  sourceRoot = SOURCE_ROOT,
  consumerRoot = process.cwd(),
  env = process.env,
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
  // FUT-4549: which commit's `.github/workflows` the identity folds in. `HEAD`
  // (the default) is the checkout — on a pull request, the MERGE commit, so a
  // workflow change on main retires everything keyed on this identity. A
  // per-test reuse that compares a PR against its own last tested commit passes
  // the PR head instead; a main-only workflow change is the daily run's.
  consumerRef = "HEAD",
  // A workflow file name narrows the implementation to what that workflow
  // executes (`laneImplementationHash`); empty keeps the whole engine.
  workflow = "",
} = {}) {
  if (!/^(HEAD|[0-9a-f]{7,40})$/.test(String(consumerRef))) throw new Error(`consumer ref ${JSON.stringify(consumerRef)} is not HEAD or a sha`);
  return createHash("sha256").update(JSON.stringify({
    schema: VERDICT_SCHEMA,
    ...(workflow
      ? { implementation: laneImplementationHash(workflow, sourceRoot), scope: workflow }
      : { implementation: implementationHash(sourceRoot) }),
    // Workflow commits can advance without changing execution semantics. Hash
    // their actual blobs instead of GITHUB_WORKFLOW_SHA (which keys every push
    // separately and defeats reuse on content-identical reruns).
    callerWorkflows: execFileSync("git", ["ls-tree", "-r", "--full-tree", consumerRef, "--", ".github/workflows"], {
      cwd: consumerRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }),
    nodeVersion,
    platform,
    arch,
    runnerOS: env.RUNNER_OS ?? "",
    runnerArch: env.RUNNER_ARCH ?? "",
    runnerEnvironment: env.RUNNER_ENVIRONMENT ?? "",
    imageOS: env.ImageOS ?? "",
    imageVersion: env.ImageVersion ?? "",
  })).digest("hex");
}
