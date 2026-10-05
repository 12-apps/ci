/**
 * Builds a case of restack-cases.json with real git, in a throwaway
 * repository, with plumbing only (no worktree): a commit is its tip's tree
 * with the case's files written through a temporary index.
 *
 * Every commit has a fixed identity and a date one second after the
 * previous one, so a case builds the same objects on any machine — which is
 * what lets the JSON carry tree ids, and a consumer's command be checked
 * against the engine's trees.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git, mergeTree } from "../lib/git.mjs";
import { BOT, commitRestack, planRestack, restackMessage } from "../lib/restack.mjs";

export const CASES = JSON.parse(readFileSync(new URL("./restack-cases.json", import.meta.url), "utf8")).cases;
export const caseNamed = (name) => {
  const c = CASES.find((x) => x.name === name);
  if (!c) throw new Error(`no case "${name}" in restack-cases.json`);
  return c;
};

const EPOCH = 1767225600; // 2026-01-01T00:00:00Z
export const PR_HEAD = (n) => `refs/conflict-monitor/pr/${n}`;

export function buildCase(c, { onRestack = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "restack-case-"));
  let tick = 0;
  const env = () => {
    tick += 1;
    const date = `@${EPOCH + tick} +0000`;
    return {
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
  };
  const run = (args, opts = {}) => git(args, { cwd: dir, ...opts }).out.trim();
  run(["init", "-q", "--bare", "-b", "main"]);
  const labels = new Map();
  const tipOf = (branch) => {
    const { out, status } = git(["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`], { cwd: dir, ok: [0, 1] });
    return status === 0 ? out.trim() : null;
  };
  const resolve = (ref) => labels.get(ref) ?? tipOf(ref) ?? (() => { throw new Error(`${c.name}: unknown ref "${ref}"`); })();
  const message = (text) => text.replace(/\{([a-z0-9]+)\}/g, (_, l) => resolve(l));
  const label = (as, sha) => {
    if (as) labels.set(as, sha);
    return sha;
  };

  /** `base` tree (or nothing) with `files` written: a tree id. */
  function treeWith(base, files) {
    const index = join(dir, `index-${tick}`);
    const ienv = { GIT_INDEX_FILE: index };
    if (base) run(["read-tree", base], { env: ienv });
    else run(["read-tree", "--empty"], { env: ienv });
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        run(["update-index", "--force-remove", "--", path], { env: ienv });
        continue;
      }
      const blob = run(["hash-object", "-w", "--stdin"], { input: content });
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env: ienv });
    }
    const tree = run(["write-tree"], { env: ienv });
    rmSync(index, { force: true });
    return tree;
  }

  const commitTree = (tree, parents, msg) => run(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"], { env: env(), input: msg });
  const setBranch = (branch, sha) => run(["update-ref", `refs/heads/${branch}`, sha]);

  const world = {
    dir,
    case: c,
    labels,
    git: (...args) => run(args),
    resolve,
    tipOf,
    /** Point refs/conflict-monitor/pr/N at each PR's head, as a fetch would. */
    syncPrRefs() {
      for (const [n, pr] of Object.entries(c.prs)) {
        const tip = tipOf(pr.branch);
        if (tip) run(["update-ref", PR_HEAD(n), tip]);
      }
    },
    /** The PR whose merge commit is `sha` (what GET /commits/{sha}/pulls answers). */
    prOfSquash(sha) {
      const hit = Object.entries(c.prs).find(([, pr]) => pr.squash && labels.get(pr.squash) === sha);
      return hit ? Number(hit[0]) : null;
    },
    /** A local resolver with the API's answer and no network: squash → { number, head }. */
    localResolve(squash) {
      const n = world.prOfSquash(squash.sha);
      return n ? { number: n, head: tipOf(c.prs[n].branch) } : null;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };

  for (const step of c.steps) {
    if ("commit" in step) {
      const tip = tipOf(step.commit);
      const tree = treeWith(tip, step.files ?? {});
      const sha = commitTree(tree, tip ? [tip] : [], message(step.message ?? `${step.as ?? "commit"} on ${step.commit}`));
      setBranch(step.commit, label(step.as, sha));
    } else if ("branch" in step) {
      setBranch(step.branch, resolve(step.from));
    } else if ("squash" in step) {
      const into = tipOf(step.into);
      const m = mergeTree(into, resolve(step.squash), dir);
      if (m.conflicted) throw new Error(`${c.name}: squashing ${step.squash} conflicts on ${m.files.join(", ")}`);
      setBranch(step.into, label(step.as, commitTree(m.tree, [into], message(step.message))));
    } else if ("merge" in step) {
      const into = tipOf(step.into);
      const from = resolve(step.merge);
      const m = mergeTree(into, from, dir);
      const unresolved = m.files.filter((f) => !(f in (step.resolve ?? {})));
      if (unresolved.length) throw new Error(`${c.name}: merging ${step.merge} into ${step.into} leaves ${unresolved.join(", ")} unresolved`);
      const tree = m.conflicted ? treeWith(m.tree, step.resolve) : m.tree;
      setBranch(step.into, label(step.as, commitTree(tree, [into, from], `Merge ${step.merge} into ${step.into}`)));
    } else if ("restack" in step) {
      world.syncPrRefs();
      const n = step.restack;
      const child = tipOf(c.prs[n].branch);
      const base = tipOf("main");
      const plan = planRestack({ child, base, cwd: dir, resolve: world.localResolve, self: n });
      onRestack?.(n, plan, step.expect, { child, base });
      if (plan.status !== "restack") throw new Error(`${c.name}: step restack #${n} planned ${plan.status}`);
      const commit = commitRestack({
        tree: plan.tree,
        child,
        base,
        message: restackMessage({ base: "main", child: n, parents: plan.parents }),
        cwd: dir,
        identity: BOT,
        date: `@${EPOCH + (tick += 1)} +0000`,
      });
      setBranch(c.prs[n].branch, commit);
    } else {
      throw new Error(`${c.name}: unknown step ${JSON.stringify(step)}`);
    }
  }
  world.syncPrRefs();
  return world;
}

/** GitHub as the case describes it, and every call made to it. */
export function caseApi(world) {
  const calls = [];
  const pullOf = (n) => {
    const pr = world.case.prs[n];
    if (!pr) return null;
    const merged = pr.squash ? world.labels.get(pr.squash) : null;
    return {
      number: Number(n),
      state: merged ? "closed" : "open",
      merged_at: merged ? "2026-01-01T00:00:00Z" : null,
      merge_commit_sha: merged,
      head: { sha: world.tipOf(pr.branch), ref: pr.headRef ?? pr.branch },
      base: { ref: "main" },
    };
  };
  return {
    calls,
    pullOf,
    async request(method, path) {
      calls.push(`${method} ${path}`);
      let m = /\/pulls\/(\d+)$/.exec(path);
      if (method === "GET" && m) {
        const pr = pullOf(m[1]);
        if (!pr) throw Object.assign(new Error("Not Found"), { status: 404 });
        return pr;
      }
      m = /\/commits\/([0-9a-f]+)\/pulls$/.exec(path);
      if (method === "GET" && m) {
        const n = world.prOfSquash(m[1]);
        return n ? [pullOf(n)] : [];
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async paginate(path) {
      throw new Error(`unexpected paginate ${path}`);
    },
  };
}
