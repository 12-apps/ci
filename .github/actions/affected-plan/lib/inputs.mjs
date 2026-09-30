/**
 * What a selected test's verdict can depend on, as one hash per test.
 *
 * Selection answers "which tests could this diff have changed the outcome
 * of?". This answers the question the NEXT push asks: "has anything this test
 * can see moved since it last passed?" — so a lane can skip a test that is
 * green with identical inputs instead of re-running it because the PR's
 * cumulative diff still names it.
 *
 * The inputs of a test file are:
 *
 *   - the test file itself and its transitive import closure — VALUE edges
 *     only, over the graph the selection just walked (type-only imports are
 *     erased before any module graph exists, so a change cannot travel through
 *     one, and `buildGraph` already drops them);
 *   - the lane's GLOBAL inputs: paths the consumer declares can change any
 *     verdict in the lane without being imported — the lockfile, the workspace
 *     manifest, a vitest config, a setup file, and for a database lane its
 *     migrations. Declared by the consumer (`lanes.<lane>.skipGreen.globals`),
 *     because only the consumer knows what its runner reads by path.
 *
 * Each file enters the hash as `<mode> <blob sha> <path>`, read from `git
 * ls-tree -r HEAD` once. Content is never read: the blob sha IS the content,
 * and the mode is what `chmod +x` changes without the content moving. Two
 * trees that agree on every counted entry produce the same hash — that is the
 * whole claim, and it is deliberately narrow.
 *
 * A test whose closure reaches a BLIND file — one whose imports could not be
 * resolved — has no bounded set of inputs, so it gets `null`: never a hash, so
 * never skippable. The same asymmetry as everywhere else in this action: a
 * hash we cannot justify would skip a test on evidence we do not have.
 *
 * Deliberately NOT here: the lane name, the Node version, the test command.
 * Those decide HOW the lane runs and live in the workflow; the caller folds
 * them into the cache KEY beside this hash, so changing how a suite runs
 * invalidates every recorded verdict without this hash having to know.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Bump when the construction below changes shape — see ci-test-fingerprint's FORMAT_VERSION. */
export const INPUTS_VERSION = "test-inputs-v2";
const MODULE_RE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * `path -> "<mode> <sha>"` for every tracked blob and gitlink at `ref`.
 *
 * `-z`: git QUOTES paths with non-ASCII characters otherwise, and a hash that
 * depends on `core.quotePath` depends on git config rather than on content.
 */
export function treeIndex(repoRoot, ref = "HEAD") {
  const raw = execFileSync("git", ["ls-tree", "-r", "-z", ref], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const index = new Map();
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    if (type !== "blob" && type !== "commit") continue;
    index.set(record.slice(tab + 1), `${mode} ${sha}`);
  }
  return index;
}

/**
 * The transitive value-import closure of `file` over `edges`, `file` included.
 *
 * @returns {{ files: Set<string>, blind: boolean }} `blind` when any file in
 *   the closure is one whose imports did not resolve.
 */
export function closureOf(file, edges, blindFiles) {
  return inputClosure([file], edges, blindFiles, new Map());
}

/** Resolve persistent routes against this tree, never just the current diff. */
function routedFiles(routes, tree) {
  const byEntry = new Map();
  for (const route of routes) {
    if (!Array.isArray(route?.entries)) continue;
    const files = Array.isArray(route.files)
      ? route.files
      : route.match instanceof RegExp ? [...tree.keys()].filter((p) => route.match.test(p)) : [];
    for (const entry of route.entries) {
      // Symbol-qualified selection entries still denote a file dependency.
      // Hashing is deliberately file-granular, even when selection is finer.
      const file = entry.split("#")[0];
      if (!byEntry.has(file)) byEntry.set(file, new Set());
      for (const input of files) byEntry.get(file).add(input);
    }
  }
  return byEntry;
}

/** Imports and routed reads compose, including reads made by a global setup. */
function inputClosure(seeds, edges, blindFiles, routed) {
  const files = new Set(seeds);
  const stack = [...files];
  const expanded = new Set();
  let blind = false;
  while (stack.length > 0) {
    const file = stack.pop();
    if (expanded.has(file)) continue;
    expanded.add(file);
    blind ||= blindFiles.has(file);
    const dependencies = [
      ...(edges.get(file) ?? []),
      ...[...(routed.get(file) ?? [])].map((target) => ({ target })),
    ];
    for (const dependency of dependencies) {
      files.add(dependency.target);
      // ?raw/?url globs read a matched file's bytes, not its source imports.
      // A second ordinary path to that file still expands it independently.
      if (!dependency.terminal && !expanded.has(dependency.target)) stack.push(dependency.target);
    }
  }
  return { files, blind };
}

/** The dependency-closed global set, shared by selection and input hashing. */
export function globalInputs({ edges, blind = [], globals = [], routes = [], tree }) {
  const roots = [...tree.keys()].filter((p) => globals.some((re) => re.test(p)));
  const closure = inputClosure(roots, edges, new Set(blind), routedFiles(routes, tree));
  // Preserve main's fail-closed check for callers supplying a partial graph.
  closure.blind ||= roots.some((file) => MODULE_RE.test(file) && !edges.has(file));
  return closure;
}

/**
 * One hash per test, or `null` where no bounded hash exists.
 *
 * `routes` may contain static `{ match, entries }` routes or persistent
 * `{ files, entries }` routes derived from the entire current database tree.
 * Each route means its entries can read its files without importing them.
 * Global inputs include their transitive dependencies, not merely the blobs
 * of the setup/config files named by `globals`.
 */
export function testInputs({ tests, edges, blind = [], globals = [], routes = [], tree }) {
  const blindFiles = new Set(blind);
  const routed = routedFiles(routes, tree);
  const globalRoots = [...tree.keys()].filter((p) => globals.some((re) => re.test(p)));
  const globalClosure = inputClosure(globalRoots, edges, blindFiles, routed);
  const absentGlobal = globalRoots.find((file) => MODULE_RE.test(file) && !edges.has(file));
  const globalsUnbounded = absentGlobal ? `${absentGlobal}: graph does not hold this module global`
    : globalClosure.blind ? "a global closure contains an import that did not resolve" : null;
  globalClosure.blind ||= Boolean(globalsUnbounded);
  const globalFiles = [...globalClosure.files].sort();
  const globalMissing = globalFiles.some((file) => !tree.has(file));
  const globalLines = globalFiles.map((p) => `${tree.get(p)} ${p}`);

  const inputs = {};
  let hashed = 0;
  let unbounded = 0;
  let missing = 0;
  for (const test of tests) {
    const { files, blind: isBlind } = inputClosure([test], edges, blindFiles, routed);
    if (isBlind || globalClosure.blind) {
      inputs[test] = null;
      unbounded++;
      continue;
    }
    // Every input must be tracked. An untracked or missing dependency is not
    // a stable input, whether reached from a test or an external setup file.
    const lines = [];
    let complete = !globalMissing;
    for (const file of files) {
      const entry = tree.get(file);
      if (!entry) {
        complete = false;
        break;
      }
      lines.push(`${entry} ${file}`);
    }
    if (!complete) {
      inputs[test] = null;
      missing++;
      continue;
    }
    lines.sort();
    const hash = createHash("sha256");
    // Paths and counts are included: renaming/deleting a read migration must
    // invalidate its reader even when the surviving SQL bytes are identical.
    hash.update(`${INPUTS_VERSION}\0${lines.length}\0${globalLines.length}\0`);
    for (const line of lines) hash.update(`${line}\0`);
    hash.update("globals\0");
    for (const line of globalLines) hash.update(`${line}\0`);
    inputs[test] = hash.digest("hex");
    hashed++;
  }
  return { inputs, globalFiles, stats: { hashed, unbounded, missing, globals: globalFiles.length, globalsUnbounded } };
}
