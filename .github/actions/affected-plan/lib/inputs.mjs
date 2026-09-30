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
export const INPUTS_VERSION = "test-inputs-v1";

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
  const seen = new Set([file]);
  const stack = [file];
  let blind = false;
  while (stack.length > 0) {
    const current = stack.pop();
    if (blindFiles.has(current)) blind = true;
    for (const record of edges.get(current) ?? []) {
      if (!seen.has(record.target)) {
        seen.add(record.target);
        stack.push(record.target);
      }
    }
  }
  return { files: seen, blind };
}

/**
 * One hash per test, or `null` where no bounded hash exists.
 *
 * @param {object} options
 * @param {string[]} options.tests          repo-relative test files (the plan's list)
 * @param {Map<string, object[]>} options.edges   `buildGraph` edges the selection walked
 * @param {string[]} [options.blind]        files whose imports did not resolve
 * @param {RegExp[]} [options.globals]      the lane's global inputs, matched against tracked paths
 * @param {{ match: RegExp, entries: string[] }[]} [options.routes]  the plan's static
 *   routes: a committed file no module imports, routed to the file(s) that
 *   carry its effect — typically the suite that reads it with `readFileSync`.
 *   The closure cannot see such a file, so every tracked path a route matches
 *   joins the inputs of any test whose closure holds one of its entries.
 * @param {Map<string,string>} options.tree `treeIndex()` of the head
 * @returns {{ inputs: Record<string, string|null>, globalFiles: string[], stats: object }}
 */
export function testInputs({ tests, edges, blind = [], globals = [], routes = [], tree }) {
  const blindFiles = new Set(blind);
  // Static routes, each resolved once against the tree: the files it matches,
  // and the entries that make a test care about them.
  const routed = routes
    .filter((r) => r?.match instanceof RegExp && Array.isArray(r.entries) && r.entries.length > 0)
    .map((r) => ({ entries: new Set(r.entries), files: [...tree.keys()].filter((p) => r.match.test(p)) }))
    .filter((r) => r.files.length > 0);
  // Global inputs are the same for every test in the lane, so they are lined
  // up once and folded into each hash. A global that matches no tracked path
  // contributes nothing — and a consumer that spells one wrong gets a hash
  // that does not move on it, which is why the consumer's own tests must pin
  // each global as moving the hash.
  const globalFiles = [...tree.keys()].filter((p) => globals.some((re) => re.test(p))).sort();
  const globalLines = globalFiles.map((p) => `${tree.get(p)} ${p}`);

  const inputs = {};
  let hashed = 0;
  let unbounded = 0;
  let missing = 0;
  for (const test of tests) {
    const { files, blind: isBlind } = closureOf(test, edges, blindFiles);
    if (isBlind) {
      inputs[test] = null;
      unbounded++;
      continue;
    }
    // Every closure file must be in the tree: the graph was built from the
    // checkout, so a file the tree lacks is one the checkout changed under
    // us, or one git does not track — either way not a stable input.
    // A route whose entry is in the closure brings the files it matches along:
    // the suite reads them off disk, so they decide its verdict as surely as an
    // import would — the graph just cannot see them.
    const counted = new Set(files);
    for (const r of routed) if ([...r.entries].some((e) => files.has(e))) for (const f of r.files) counted.add(f);
    const lines = [];
    let complete = true;
    for (const file of counted) {
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
    // NUL-joined with the counts hashed in: a path may contain any separator
    // a naive join would use, and two different sets must never hash alike.
    hash.update(`${INPUTS_VERSION}\0${lines.length}\0${globalLines.length}\0`);
    for (const line of lines) hash.update(`${line}\0`);
    hash.update("globals\0");
    for (const line of globalLines) hash.update(`${line}\0`);
    inputs[test] = hash.digest("hex");
    hashed++;
  }
  return { inputs, globalFiles, stats: { hashed, unbounded, missing, globals: globalFiles.length } };
}
