/**
 * Everything this checker asks git: which files are tracked, which lines a
 * diff adds, and what the index holds.
 *
 * Every call is `execFileSync("git", [...])`, never a shell string, and the
 * environment is passed through untouched: a caller that points
 * `GIT_INDEX_FILE` at a temporary index gets that index read.
 */
import { execFileSync } from "node:child_process";

/** A problem with how the checker was called or configured: exit 2, never a finding. */
export class UsageError extends Error {}

const DIFF = ["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--relative", "--src-prefix=a/", "--dst-prefix=b/"];

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
}

const lastLine = (error) => String(error.stderr ?? error.message).trim().split("\n").at(-1);

/** Paths under `root`, relative to it. `others` lists the untracked, unignored files instead. */
export function listFiles(root, { others = false } = {}) {
  try {
    return git(root, ["ls-files", "-z", ...(others ? ["--others", "--exclude-standard"] : [])]).split("\0").filter(Boolean);
  } catch (error) {
    throw new UsageError(`cannot list the files of ${root}: ${lastLine(error)}`);
  }
}

/** The commit `ref` and HEAD both descend from. */
export function mergeBase(root, ref) {
  let commit;
  try {
    commit = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).trim();
  } catch {
    throw new UsageError(`--base ${ref} does not resolve to a commit: fetch it first (fetch-depth: 0, or the fetch-base action)`);
  }
  try {
    return git(root, ["merge-base", commit, "HEAD"]).trim();
  } catch {
    throw new UsageError(`--base ${ref} and HEAD have no merge base in this checkout: fetch more history (fetch-depth: 0, or the fetch-base action)`);
  }
}

/**
 * The lines the working tree adds against `commit`, or the index adds against
 * HEAD when `commit` is null: path → Set of 1-based line numbers. A file the
 * diff deletes is absent; one it only removes lines from has an empty set.
 * Renames are not followed, so a line moved from another file is an added one.
 */
export function addedLines(root, commit) {
  let patch;
  try {
    patch = git(root, [...DIFF, ...(commit === null ? ["--cached"] : [commit]), "--"]);
  } catch (error) {
    throw new UsageError(`cannot read the diff: ${lastLine(error)}`);
  }
  return parseAddedLines(patch);
}

/** @param {string} patch  Output of `git diff -U0` with the `a/` and `b/` prefixes. */
export function parseAddedLines(patch) {
  const files = new Map();
  let current = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
    } else if (line.startsWith("+++ ") && current === null) {
      const path = unquote(line.slice(4).replace(/\t$/, ""));
      current = path === "/dev/null" ? undefined : new Set();
      if (current) files.set(path.replace(/^b\//, ""), current);
    } else if (line.startsWith("@@ ") && current) {
      const [, start, count = "1"] = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line) ?? [];
      for (let i = 0; i < Number(count); i += 1) current.add(Number(start) + i);
    }
  }
  return files;
}

/** Git quotes a path holding a control character, a quote or a backslash, C style. */
function unquote(path) {
  if (!path.startsWith('"')) return path;
  const escapes = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
  return path.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, code) => escapes[code] ?? String.fromCharCode(Number.parseInt(code, 8)));
}

/** The bytes the index holds for `file`, or null when it holds none. */
export function indexContent(root, file) {
  try {
    return git(root, ["show", `:./${file}`], "buffer");
  } catch {
    return null;
  }
}

/** Where `root` sits inside its repository (`apps/web/`, or `` at the top): GitHub resolves annotation paths from there. */
export function repoPrefix(root) {
  try {
    return git(root, ["rev-parse", "--show-prefix"]).trim();
  } catch {
    return "";
  }
}
