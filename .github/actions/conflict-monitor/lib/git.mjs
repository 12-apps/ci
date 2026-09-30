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

export function git(args, { cwd = process.cwd(), ok = [0], input, env } = {}) {
  const res = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    ...(env ? { env: { ...process.env, ...env } } : {}),
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
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const KIND = /^CONFLICT \(([^)]+)\):/;

/**
 * Parse `merge-tree --write-tree --name-only -z` output.
 *
 * `-z` is what keeps a path intact: without it git C-quotes any path holding
 * a `"`, a `\` or a non-ASCII byte, and the quoted form matches nothing later
 * (the blob, the log, the bucket globs). It also hands back each message WITH
 * the paths it is about, so a conflict's kind is attached to its path by git
 * itself rather than found by searching message text for the path.
 *
 *   <tree> NUL <path> NUL … NUL NUL
 *   ( <count> NUL <path> × count <type> NUL <message> NUL )*
 *
 * The kind is read from the MESSAGE's `CONFLICT (<kind>):` — the type field
 * spells content conflicts `contents`, the message `content`.
 */
export function parseMergeTreeZ(out) {
  const parts = out.split("\0");
  const tree = (parts[0] ?? "").trim();
  let i = 1;
  const files = [];
  while (i < parts.length && parts[i] !== "") files.push(parts[i++]);
  i += 1;
  const kinds = new Map();
  while (i < parts.length) {
    if (parts[i] === "") break;
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`merge-tree -z: unexpected message header "${parts[i]}"`);
    const paths = parts.slice(i + 1, i + 1 + n);
    const message = parts[i + 2 + n] ?? "";
    const kind = KIND.exec(message)?.[1];
    if (kind) for (const p of paths) (kinds.get(p) ?? kinds.set(p, new Set()).get(p)).add(kind);
    i += n + 3;
  }
  return { tree, files, kinds };
}

export function mergeTree(ours, theirs, cwd) {
  const { out, status } = git(
    ["-c", "merge.conflictStyle=diff3", "merge-tree", "--write-tree", "--name-only", "-z", ours, theirs],
    { cwd, ok: [0, 1] },
  );
  const { tree, files, kinds } = parseMergeTreeZ(out);
  // Exit 1 is ALSO what git returns for "not something we can merge", with
  // no tree at all. Read as a conflict with no files, that would reach the
  // probe as "clean" and mark a real conflict resolved — so a status-1 answer
  // without a tree, or without a conflicted path, is an error.
  if (!OID.test(tree)) throw new Error(`git merge-tree ${ours} ${theirs} printed no tree (exit ${status})`);
  if (status === 0) return { conflicted: false, tree, files: [], kinds: new Map() };
  if (!files.length) throw new Error(`git merge-tree ${ours} ${theirs} reported a conflict and no conflicted path`);
  return { conflicted: true, tree, files: [...new Set(files)], kinds };
}

export function blobAt(tree, path, cwd) {
  const { out, status } = git(["cat-file", "-p", `${tree}:${path}`], { cwd, ok: [0, 128] });
  return status === 0 ? out : "";
}

export function pathExists(ref, path, cwd) {
  return git(["cat-file", "-e", `${ref}:${path}`], { cwd, ok: [0, 128] }).status === 0;
}
