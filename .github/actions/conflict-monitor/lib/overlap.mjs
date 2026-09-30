/**
 * Two OPEN PRs that will conflict with each other, told before either merges.
 *
 * `probe` answers "does this PR still merge with the base?" — after the base
 * has moved. This answers the question one step earlier: if P merged now,
 * would Q still merge? It is asked once per unordered pair and read entirely
 * from git, so the answer is the one `git merge` will give, not a guess from
 * file names:
 *
 *   1. paths      each PR's files list (rename sources included), minus the
 *                 caller's ignored paths;
 *   2. candidate  the two share a path, or either renames one;
 *   3. stack      a pair where either head holds the other's own commits is
 *                 not a pair at all (lib/stack.mjs) — a child overlaps its
 *                 parent by construction;
 *   4. direction  fixed, so the answer never flips between runs: the side
 *                 that merges cleanly with the base is merged into it (the
 *                 lower PR number when both do), as an unreferenced commit,
 *                 and the other side is merged onto THAT. The other side's own
 *                 conflicts with the base are E0's, and are taken out. When
 *                 neither side merges cleanly, the two heads are merged
 *                 directly and both sides' base conflicts are taken out;
 *   5. overlap    a conflicted path that is in both PRs' paths — or whose
 *                 rename source is: "P renames a→b, Q edits a" conflicts on
 *                 `b`, and is an overlap;
 *   6. kind       git's own, read as E0 reads it (lib/shape.mjs), in words.
 *
 * A pair that shares a path and merges cleanly is an R1 pair: worth a line in
 * the job summary, not a comment.
 */
import { blobAt, git, mergeTree } from "./git.mjs";
import { fileShape } from "./shape.mjs";
import { isStackedPair } from "./stack.mjs";

export const KINDS = {
  lines: "same lines",
  spot: "same spot",
  add: "both add",
  moved: "deletes or moves",
};

/**
 * A conflict shape in words. Anything git reports that is not one of the four
 * — `file/directory`, `distinct types`, `unknown` for a content conflict with
 * no diff3 hunk (a binary file) — is shown verbatim, as E0 shows it.
 */
export function kindOf(shape) {
  if (shape === "edit/edit") return KINDS.lines;
  if (shape === "insert/insert") return KINDS.spot;
  if (shape === "add/add") return KINDS.add;
  if (/delete|rename|location/.test(shape)) return KINDS.moved;
  return shape;
}

/**
 * A PR's paths from its `GET /pulls/{n}/files` list: every `filename`, plus the
 * `previous_filename` of a rename. `ignored(path)` drops a path; a rename with
 * either end ignored is dropped from the rename map too.
 */
export function pathSetOf(files, ignored = () => false) {
  const paths = new Set();
  const renamedFrom = new Map();
  for (const f of files) {
    if (typeof f?.filename !== "string") continue;
    const from = f.status === "renamed" && typeof f.previous_filename === "string" ? f.previous_filename : null;
    if (!ignored(f.filename)) paths.add(f.filename);
    if (from && !ignored(from)) paths.add(from);
    if (from && !ignored(from) && !ignored(f.filename)) renamedFrom.set(f.filename, from);
  }
  return { paths, renamedFrom };
}

export const sharedPaths = (a, b) => [...a.paths].filter((p) => b.paths.has(p)).sort();

/** Worth a merge at all: a shared path, or a rename on either side. */
export const isCandidate = (a, b) => a.renamedFrom.size > 0 || b.renamedFrom.size > 0 || sharedPaths(a, b).length > 0;

/** `path` is in `side`'s paths, directly or through a rename source either side recorded. */
function touches(side, other, path) {
  if (side.paths.has(path)) return true;
  const from = side.renamedFrom.get(path) ?? other.renamedFrom.get(path);
  return from != null && side.paths.has(from);
}

// The synthetic merge is an object, never a ref: nothing is pushed, nothing
// is written under refs/. A fixed identity and date make it the same commit on
// every run, and need no `user.name` on the runner.
const SYNTH_ENV = {
  GIT_AUTHOR_NAME: "conflict-monitor",
  GIT_AUTHOR_EMAIL: "conflict-monitor@users.noreply.github.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "conflict-monitor",
  GIT_COMMITTER_EMAIL: "conflict-monitor@users.noreply.github.com",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

const memo = (cache, key, f) => {
  if (!cache.has(key)) cache.set(key, f());
  return cache.get(key);
};

/** `head` merged with the base: the merge every PR is compared with, once per run. */
export const baseMerge = (baseSha, head, { cwd, cache = new Map() }) =>
  memo(cache, `base:${baseSha}:${head}`, () => mergeTree(baseSha, head, cwd));

function synthesise(baseSha, head, tree, { cwd, cache }) {
  return memo(cache, `synth:${baseSha}:${head}`, () =>
    git(["commit-tree", tree, "-p", baseSha, "-p", head, "-m", "conflict-monitor: synthetic merge"], { cwd, env: SYNTH_ENV }).out.trim(),
  );
}

/**
 * The merge that answers "would these two conflict?", with the files E0 owns
 * (a side's own conflicts with the base) listed separately.
 */
function pairMerge(baseSha, low, high, { cwd, cache }) {
  const ml = baseMerge(baseSha, low.head, { cwd, cache });
  const mh = baseMerge(baseSha, high.head, { cwd, cache });
  if (!ml.conflicted || !mh.conflicted) {
    const [s, o, mo] = !ml.conflicted ? [low, high, mh] : [high, low, ml];
    const sm = !ml.conflicted ? ml : mh;
    const synth = synthesise(baseSha, s.head, sm.tree, { cwd, cache });
    return { merge: mergeTree(synth, o.head, cwd), e0: new Set(mo.files), synthesised: s.number };
  }
  return { merge: mergeTree(low.head, high.head, cwd), e0: new Set([...ml.files, ...mh.files]), synthesised: null };
}

/**
 * One unordered pair. `a` and `b` are `{ number, head, paths }` (paths from
 * pathSetOf); their order does not matter.
 *
 *   { stacked: true }
 *   { overlaps: [{ path, kind }], shared: [path], synthesised: n | null }
 *
 * `overlaps` empty and `shared` not is an R1 pair. Throws when git cannot run
 * a merge (unrelated histories, a missing object); the caller skips the pair.
 */
export function analyzePair({ baseSha, a, b, cwd, cache = new Map() }) {
  const [low, high] = a.number < b.number ? [a, b] : [b, a];
  const shared = sharedPaths(low.paths, high.paths);
  if (!isCandidate(low.paths, high.paths)) return { overlaps: [], shared, synthesised: null };
  if (isStackedPair(low.head, high.head, { mainSide: baseSha, cwd, cache })) return { stacked: true };
  const { merge, e0, synthesised } = pairMerge(baseSha, low, high, { cwd, cache });
  const overlaps = [];
  if (merge.conflicted) {
    for (const path of merge.files) {
      if (e0.has(path)) continue;
      if (!touches(low.paths, high.paths, path) || !touches(high.paths, low.paths, path)) continue;
      const kinds = merge.kinds.get(path) ?? new Set();
      const blob = kinds.has("content") ? blobAt(merge.tree, path, cwd) : "";
      overlaps.push({ path, kind: kindOf(fileShape(kinds, blob)) });
    }
  }
  overlaps.sort((x, y) => x.path.localeCompare(y.path));
  return { overlaps, shared, synthesised };
}
