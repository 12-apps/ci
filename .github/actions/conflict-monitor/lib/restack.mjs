/**
 * The re-stack: take the base into a branch cut from another PR's branch,
 * after that PR was squash-merged, without conflicting against the parent's
 * own code.
 *
 * A squash lands ONE commit S on the base, never the parent's commits. When
 * the child next takes the base in, git's merge base is the old base commit
 * the parent branched from, so the parent's code is "added on both sides" and
 * every place where the child changed the parent's lines conflicts.
 *
 * The fix is the merge git would have computed had the parent landed as a
 * merge commit. A throwaway commit Z carries the base's tree with the base AND
 * the parent's pre-squash head the child holds (`pOld`) as parents:
 *
 *   Z = commit-tree <base>^{tree} -p <base> -p pOld…
 *
 * `merge-tree child Z` then lets git use EVERY merge base it finds between the
 * child and Z (pOld, and the newest base commit the child already holds) and,
 * when there are several, merge them into a virtual base. A single explicit
 * `--merge-base=pOld` cannot do that (it takes one commit; repeating it keeps
 * the last), and is worse than doing nothing when the child merged the base
 * after taking the parent. Z is never pushed: the commit the bot writes has
 * the parents (child, base), exactly what a hand merge has.
 *
 * Everything here is git in `cwd`, synchronous, and asks nothing of GitHub:
 * mapping a squash to its PR is the caller's `resolve`, so the same code runs
 * in the bot (the REST API), the report (the PR list it already has) and a
 * developer's checkout. Shared by restack.mjs, probe.mjs and report.mjs.
 */
import { git, isAncestor, lines, mergeTree } from "./git.mjs";
import { heldCommitsOf } from "./stack.mjs";

export const TRAILER = { base: "Restack-Base", parent: "Restack-Parent", redo: "Restack-Redo" };

/** The identity of the bot's merge, as for the heal. */
export const BOT = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };

/**
 * Z is a fixed function of its tree and parents: a fixed identity and date,
 * so the same plan names the same object on every run and in every checkout,
 * and a checkout without `user.name` can still write it.
 */
const Z_ENV = {
  GIT_AUTHOR_NAME: "conflict-monitor",
  GIT_AUTHOR_EMAIL: "conflict-monitor@users.noreply.github.com",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "conflict-monitor",
  GIT_COMMITTER_EMAIL: "conflict-monitor@users.noreply.github.com",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

/**
 * The base-side commits that touched any conflicted file since the child last
 * took the base: E0's culprits (lib/analyze.mjs), for all files in one call.
 * A path filter over a set of paths shows a commit when it touched ANY of
 * them, so this is the union of the per-file sets.
 */
export function culpritSquashes({ base, child, files, cwd }) {
  if (!files.length) return [];
  const { out } = git(["log", "--first-parent", "--format=%H%x09%s", base, `^${child}`, "--", ...files], { cwd });
  return lines(out).map((l) => {
    const [sha, ...subject] = l.split("\t");
    return { sha, subject: subject.join("\t") };
  });
}

/**
 * A commit on `base ^child` that reverts squash `sha` of PR `pr`: its body
 * says `This reverts commit <sha>`, or its subject is `Revert "…(#pr)…"`.
 * Without this, a clean Z merge would declare the parent's code held by the
 * base when the base took it out again, and silently drop it from the child.
 */
export function revertOf({ base, child, sha, pr, cwd }) {
  const { out } = git(["log", "--format=%H%x1f%s%x1f%b%x1e", base, `^${child}`], { cwd });
  const bySha = new RegExp(`This reverts commit ${sha}`);
  const bySubject = pr ? new RegExp(`^Revert ".*\\(#${pr}\\).*"`) : null;
  for (const rec of out.split("\x1e")) {
    const [commit, subject = "", body = ""] = rec.trim().split("\x1f");
    if (!commit) continue;
    if (bySha.test(body) || (bySubject && bySubject.test(subject))) return commit;
  }
  return null;
}

/**
 * `pOld`: the parent's last head the child took in. The first commit on the
 * parent head's first-parent chain, outside the base, that is an ancestor of
 * the child. `null` when the child holds none of that chain.
 */
export function heldHead({ head, base, child, cwd }) {
  const { out } = git(["rev-list", "--first-parent", head, `^${base}`], { cwd });
  for (const c of lines(out)) if (isAncestor(c, child, cwd)) return c;
  return null;
}

/** Drop a pOld already reachable from another: it adds no merge base. */
export function independent(pOlds, cwd) {
  const unique = [...new Set(pOlds)];
  return unique.filter((p) => !unique.some((q) => q !== p && isAncestor(p, q, cwd)));
}

/** Z: the base's tree, with the base and every pOld as parents. Unreferenced, never pushed. */
export function virtualBase({ base, pOlds, cwd }) {
  const parents = independent(pOlds, cwd).flatMap((p) => ["-p", p]);
  const { out } = git(["commit-tree", "--no-gpg-sign", `${base}^{tree}`, "-p", base, ...parents, "-m", "conflict-monitor: re-stack base"], {
    cwd,
    env: Z_ENV,
  });
  return out.trim();
}

/**
 * The stacked parents among `squashes`, each with its pOld; the rest with the
 * reason they were dropped.
 *
 * `resolve(squash)` maps a base commit to the PR it squash-merged:
 * `{ number, head }`, `head` being that PR's final head as a local commit, or
 * null. A parent is stacked when the child holds commits of its head that the
 * base does not (lib/stack.mjs, the test E0 and E5 use).
 */
export function stackedParents({ base, child, squashes, resolve, self = null, cwd, cache = null }) {
  const parents = [];
  const skipped = [];
  const seen = new Set();
  for (const squash of squashes) {
    const pr = resolve(squash);
    if (!pr || !pr.head || pr.number === self || seen.has(pr.number)) continue;
    seen.add(pr.number);
    if (!lines(git(["rev-list", "-n1", pr.head, `^${base}`], { cwd }).out).length) continue;
    if (!heldCommitsOf(pr.head, { mainSide: base, branchSide: child, cwd, cache })) continue;
    const reverted = revertOf({ base, child, sha: squash.sha, pr: pr.number, cwd });
    if (reverted) {
      skipped.push({ pr: pr.number, squash: squash.sha, reason: `reverted by ${reverted.slice(0, 7)}` });
      continue;
    }
    const pOld = heldHead({ head: pr.head, base, child, cwd });
    if (!pOld) {
      skipped.push({ pr: pr.number, squash: squash.sha, reason: "the branch holds none of its head's first-parent chain" });
      continue;
    }
    parents.push({ pr: pr.number, squash: squash.sha, head: pr.head, pOld });
  }
  return { parents, skipped };
}

/**
 * The whole plan for one branch against one base commit:
 *
 *   clean        the default merge is clean: nothing to do (a PR GitHub can
 *                merge is left alone, and a second run is a no-op)
 *   not-stacked  it conflicts, and no culprit is a squash-merged parent the
 *                branch holds: a real conflict, the probe's
 *   restack      Z merges cleanly: `tree` is the merge to commit
 *   residual     Z still conflicts on `residual`: real conflicts no base
 *                removes; nothing is pushed
 *
 * `merge` and `squashes` may be passed in when the caller already has them
 * (the bot resolves the squashes asynchronously in between).
 */
export function planRestack({ child, base, cwd, resolve, self = null, merge = null, squashes = null, cache = null }) {
  const first = merge ?? mergeTree(child, base, cwd);
  if (!first.conflicted) return { status: "clean" };
  const culprits = squashes ?? culpritSquashes({ base, child, files: first.files, cwd });
  const { parents, skipped } = stackedParents({ base, child, squashes: culprits, resolve, self, cwd, cache });
  if (!parents.length) return { status: "not-stacked", files: first.files, skipped };
  const z = virtualBase({ base, pOlds: parents.map((p) => p.pOld), cwd });
  const second = mergeTree(child, z, cwd);
  const common = { files: first.files, parents, skipped, z, tree: second.tree };
  if (!second.conflicted) return { status: "restack", ...common };
  return { status: "residual", ...common, residual: second.files, kinds: second.kinds };
}

/** `text` wrapped at `width`, on spaces. */
function wrap(text, width = 100) {
  const out = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

const listOf = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
export const HEADER_MAX = 72;

/**
 * The bot's commit message. It must pass a consumer's commitlint as CI runs
 * it: `type(scope): summary` of at most 72 characters, imperative, an issue
 * reference (`(#<child>)` satisfies it), and body lines of at most 100.
 * One `Restack-Base`/`Restack-Parent` pair per stacked parent, in order: the
 * report accepts the merge as tool-made only when they match its own
 * computation (see `toolMade`).
 */
export function restackHeader({ base, child, parents }) {
  const prs = parents.map((p) => `#${p.pr}`);
  const headers = [
    `chore(stack): merge ${base} after the ${prs.length > 1 ? "squashes" : "squash"} of ${listOf(prs)} (#${child})`,
    `chore(stack): merge ${base} after ${prs.length} parent squashes (#${child})`,
    `chore(stack): merge the base after the parent's squash (#${child})`,
  ];
  return headers.find((h) => h.length <= HEADER_MAX) ?? headers[headers.length - 1];
}

export function restackMessage({ base, child, parents, redo = false }) {
  const prs = parents.map((p) => `#${p.pr}`);
  const header = restackHeader({ base, child, parents });
  const body = wrap(
    `Take ${base} in with the pre-squash head of ${listOf(prs)} as an extra merge base, so the ` +
      `parent's own code no longer conflicts with its squash. The merge has two parents, this ` +
      `branch and ${base}; the throwaway base commit is not part of the history.`,
  );
  const trailers = parents.flatMap((p) => [`${TRAILER.base}: ${p.pOld}`, `${TRAILER.parent}: #${p.pr}`]);
  if (redo) trailers.push(`${TRAILER.redo}: yes`);
  return [header, "", ...body, "", ...trailers].join("\n") + "\n";
}

/**
 * Commit a re-stack: the merged tree, with the parents (child, base). Z is
 * not a parent. `env` carries the identity; the bot's is BOT.
 */
export function commitRestack({ tree, child, base, message, cwd, identity = BOT, date = null }) {
  const env = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  };
  return git(["commit-tree", "--no-gpg-sign", tree, "-p", child, "-p", base, "-F", "-"], { cwd, env, input: message }).out.trim();
}

/** The re-stack trailers of a commit, as git parses them. */
export function trailersOf(commit, cwd) {
  const { out } = git(["log", "-1", "--format=%(trailers:only,unfold)", commit], { cwd });
  const found = { bases: [], parents: [], redo: false };
  for (const l of lines(out)) {
    const m = /^([A-Za-z-]+):\s*(.*?)\s*$/.exec(l);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === TRAILER.base.toLowerCase()) found.bases.push(m[2]);
    else if (key === TRAILER.parent.toLowerCase()) {
      const n = /^#(\d+)$/.exec(m[2]);
      found.parents.push(n ? Number(n[1]) : NaN);
    } else if (key === TRAILER.redo.toLowerCase()) found.redo = /^yes$/i.test(m[2]);
  }
  return found;
}

const sameSet = (a, b) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/**
 * The trailers name exactly the parents and pOlds this sync's own replay
 * computes. A trailer copied from another sync is refused when it names
 * another pOld or a PR outside this sync's stacked parents; two siblings cut
 * from one parent commit share a pOld, and there the report's blob check is
 * what holds.
 */
export function toolMade(trailers, parents) {
  if (!parents.length || !trailers.bases.length || !trailers.parents.length) return false;
  return sameSet(trailers.bases, parents.map((p) => p.pOld)) && sameSet(trailers.parents, parents.map((p) => p.pr));
}

/** The blob (or null) at `path` in `tree`. */
export function blobId(tree, path, cwd) {
  const { out, status } = git(["rev-parse", "-q", "--verify", `${tree}:${path}`], { cwd, ok: [0, 1, 128] });
  return status === 0 ? out.trim() : null;
}

/**
 * The commands a developer runs by hand to do what the bot does, run in the
 * branch's checkout: fetch the base and each parent's head, find each held
 * head (the first commit of the parent's first-parent chain this branch
 * holds), build Z, merge it without committing, point MERGE_HEAD back at the
 * base so the commit's parents are (branch, base), and commit with the bot's
 * header and trailers so the report tells the merge from a hand resolution.
 *
 * The held heads are COMPUTED by the recipe, never printed: the comment that
 * shows it carries no trailer value a hand merge could paste.
 */
export function recipeOf({ base, parents, child }) {
  const prs = [...new Set(parents.map((p) => p.pr))];
  const v = (pr) => `pold_${pr}`;
  return [
    `git fetch origin ${base} ${prs.map((pr) => `+refs/pull/${pr}/head:refs/restack/${pr}`).join(" ")}`,
    ...prs.map(
      (pr) =>
        `${v(pr)}=$(for c in $(git rev-list --first-parent refs/restack/${pr} ^origin/${base}); do git merge-base --is-ancestor "$c" HEAD && { echo "$c"; break; }; done)`,
    ),
    `z=$(git commit-tree "origin/${base}^{tree}" -p origin/${base} ${prs.map((pr) => `-p "$${v(pr)}"`).join(" ")} -m restack)`,
    `git merge --no-ff --no-commit "$z"`,
    `git rev-parse origin/${base} > "$(git rev-parse --git-path MERGE_HEAD)"`,
    "# resolve any file still conflicted and `git add` it, then:",
    [
      "git",
      "commit",
      "-m",
      `"${restackHeader({ base, child, parents })}"`,
      ...prs.flatMap((pr) => [`--trailer "${TRAILER.base}: $${v(pr)}"`, `--trailer "${TRAILER.parent}: #${pr}"`]),
    ].join(" "),
  ];
}

/**
 * The custom merge driver `path` names in the `.gitattributes` of `commit`,
 * or null. A real `git merge` (a consumer's local command) runs it; the
 * report's `merge-tree` does not, so a driver may legitimately write another
 * blob than Z's for a file both sides changed.
 */
export function mergeDriverOf(commit, path, cwd) {
  const { out, status } = git(["check-attr", `--source=${commit}`, "merge", "--", path], { cwd, ok: [0, 1, 128] });
  if (status !== 0) return null;
  const value = /: merge: (.*)$/.exec(out.trim())?.[1] ?? "unspecified";
  return ["unspecified", "unset", "set", "text", "binary"].includes(value) ? null : value;
}
