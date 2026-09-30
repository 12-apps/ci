/* global process */
/**
 * The only door to git. Everything here is a plain `git` subprocess in the
 * caller's checkout (or in `cwd`, which the tests point at a fixture repo).
 *
 * `run` refuses exit codes the caller did not declare acceptable, because
 * `git merge-tree` answers "conflicted" with exit 1 — a status that is data
 * here, not failure — and a helper that swallowed every non-zero would also
 * swallow a missing object, which must be loud.
 */
import { spawnSync } from "node:child_process";

const MAX_BUFFER = 512 * 1024 * 1024;

export function git(args, { cwd = process.cwd(), ok = [0], input } = {}) {
  const res = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (res.error) throw res.error;
  if (!ok.includes(res.status)) {
    throw new Error(`git ${args.join(" ")} exited ${res.status}: ${res.stderr.trim()}`);
  }
  return { out: res.stdout, status: res.status };
}

export const lines = (text) => text.split("\n").filter(Boolean);

export function revParse(ref, cwd) {
  const { out, status } = git(["rev-parse", "-q", "--verify", `${ref}^{commit}`], { cwd, ok: [0, 1] });
  return status === 0 ? out.trim() : null;
}

export function isAncestor(a, b, cwd) {
  return git(["merge-base", "--is-ancestor", a, b], { cwd, ok: [0, 1] }).status === 0;
}

export function countRange(include, exclude, cwd) {
  const args = ["rev-list", "--count", include, ...exclude.map((e) => `^${e}`)];
  return Number(git(args, { cwd }).out.trim() || 0);
}

/**
 * Re-run the merge of `ours` and `theirs` without touching the worktree.
 *
 * One `merge-tree` call answers everything the classifier needs: the exit
 * status (conflicted or not), the conflicted paths (`--name-only`), the
 * `CONFLICT (<kind>)` messages that name each path's conflict type, and the
 * resulting tree — whose blobs carry diff3 markers, so the base side of every
 * hunk can be read back without a second merge.
 */
export function mergeTree(ours, theirs, cwd) {
  const { out, status } = git(
    ["-c", "merge.conflictStyle=diff3", "merge-tree", "--write-tree", "--name-only", ours, theirs],
    { cwd, ok: [0, 1] },
  );
  const [head, ...rest] = out.split("\n");
  if (status === 0) return { conflicted: false, tree: head.trim(), files: [], messages: "" };
  // `--name-only` output: tree oid, the conflicted paths, a blank line, then
  // the informational messages.
  const blank = rest.indexOf("");
  const files = (blank === -1 ? rest : rest.slice(0, blank)).filter(Boolean);
  const messages = blank === -1 ? "" : rest.slice(blank + 1).join("\n");
  return { conflicted: true, tree: head.trim(), files: [...new Set(files)], messages };
}

export function blobAt(tree, path, cwd) {
  const { out, status } = git(["cat-file", "-p", `${tree}:${path}`], { cwd, ok: [0, 128] });
  return status === 0 ? out : "";
}

export function pathExists(ref, path, cwd) {
  return git(["cat-file", "-e", `${ref}:${path}`], { cwd, ok: [0, 128] }).status === 0;
}
