/**
 * One conflicted merge, classified file by file. Shared by `probe` (the PR as
 * it is now, against the base tip) and `report` (every sync merge a PR ever
 * made, replayed).
 */
import { bucketOf } from "./config.mjs";
import { blobAt, git, lines, mergeTree, pathExists } from "./git.mjs";
import { fileShape } from "./shape.mjs";

const PR_REF = /\(#(\d+)\)/g;

/** The PR a squash (or merge) commit landed, from the `(#N)` in its subject. */
export function prOfSubject(subject) {
  const all = [...subject.matchAll(PR_REF)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

/**
 * The base-side commits that touched `path` since the branch last saw the
 * base: first-parent history of `mainSide` not reachable from `branchSide`.
 * Every one of them is a candidate cause — the report says "candidate", since
 * a commit can touch the file without touching the conflicting lines.
 */
export function culprits(mainSide, branchSide, path, cwd) {
  const { out } = git(
    ["log", "--first-parent", "--format=%H%x09%cI%x09%s", mainSide, `^${branchSide}`, "--", path],
    { cwd },
  );
  return lines(out).map((l) => {
    const [sha, date, ...subject] = l.split("\t");
    const s = subject.join("\t");
    return { sha, date, subject: s, pr: prOfSubject(s) };
  });
}

/**
 * Merge `branchSide` with `mainSide` and classify every conflicted file.
 * Returns `null` for a clean merge.
 *
 * `baseTip` is where `absent` bucket rules look: a path missing there has
 * left the repository.
 */
export function analyzeMerge({ mainSide, branchSide, config, baseTip, cwd, withCulprits = true }) {
  const merge = mergeTree(branchSide, mainSide, cwd);
  if (!merge.conflicted) return null;
  const exists = (p) => pathExists(baseTip, p, cwd);
  return merge.files.map((file) => ({
    file,
    shape: fileShape(merge.kinds.get(file) ?? new Set(), blobAt(merge.tree, file, cwd)),
    bucket: bucketOf(file, config, exists),
    culprits: withCulprits ? culprits(mainSide, branchSide, file, cwd) : [],
  }));
}
