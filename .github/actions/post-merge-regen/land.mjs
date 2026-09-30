/* global process */
/**
 * Job 3 of 3: land what the regeneration changed.
 *
 * It runs in a FRESH checkout of the tip that `prepare` chose. The consumer's
 * command ran in job 2, on another runner, with no secret, and all it hands
 * over is a patch artifact. So no repository code runs anywhere near the PAT.
 * The patch can change only tracked content, and this job still runs git with
 * hooks and fsmonitor disabled.
 *
 * When the patch changes something:
 * 1. Apply it and commit on `<prefix><sha7>`.
 * 2. Push that branch with the PAT (sent as an http extraheader, never in a
 *    URL that an error message could echo).
 * 3. Open the PR with the PAT.
 * 4. Enable auto-merge with GITHUB_TOKEN.
 * 5. Close the superseded regen PRs and delete their branches.
 *
 * When there is no patch, it only does step 5.
 *
 * A retry has to land even if an earlier attempt pushed the branch and then
 * failed to open its PR, and also after a person closed the PR and kept the
 * branch. So an existing branch whose tree equals this regeneration is
 * reused. A different tree is refused, and the error names the branch to
 * delete.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { isMain } from "./lib/entry.mjs";
import { enableAutoMerge, githubClient } from "./lib/github.mjs";
import { branchFor, regenPrs } from "./lib/plan.mjs";

/** Git never runs a hook or an fsmonitor from the working tree's config here. */
const HARDENED = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * Paths a regeneration may never write, whatever the caller allows. A change
 * to a workflow, or to an action a workflow runs, needs its own review, and it
 * would land here with zero approvals.
 */
const FORBIDDEN = /^\.github\/(workflows|actions)\//;

/** `**` spans directories, `*` does not, `?` is one character; anchored at both ends. */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 1;
      if (glob[i + 1] === "/") i += 1;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** The paths of `touched` this regeneration may not write, given the caller's allow-list (empty: no list). */
export function refusedPaths(touched, allow) {
  const globs = (allow ?? "").split("\n").map((g) => g.trim()).filter(Boolean).map(globToRegExp);
  return touched.filter((path) => FORBIDDEN.test(path) || (globs.length > 0 && !globs.some((re) => re.test(path))));
}

export function authEnv(token) {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("***");
    out = out.split(Buffer.from(`x-access-token:${secret}`).toString("base64")).join("***");
  }
  return out;
}

function parseAuthor(author) {
  const m = /^(.+?)\s*<([^>]+)>$/.exec(author ?? "");
  if (!m) throw new Error(`post-merge-regen: commit-author must read "Name <email>", got "${author}"`);
  return { name: m[1], email: m[2] };
}

export async function runLand(cfg, deps) {
  const { repo, base, prefix, tip, title, body, author, patch } = cfg;
  const { bot, pat, git, remote, log = () => {} } = deps;
  const { name, email } = parseAuthor(author);
  const owned = regenPrs(await bot.paginate(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}`), { prefix, repo });

  const closeStale = async (keepNumber) => {
    for (const pr of owned) {
      if (pr.number === keepNumber) continue;
      await bot.request("PATCH", `/repos/${repo}/pulls/${pr.number}`, { state: "closed" });
      try {
        await bot.request("DELETE", `/repos/${repo}/git/refs/heads/${pr.head.ref}`);
        log(`#${pr.number}: closed, branch ${pr.head.ref} deleted (superseded).`);
      } catch (err) {
        if (err.status === 404 || err.status === 422) log(`#${pr.number}: closed; its branch was already gone.`);
        else log(`#${pr.number}: closed; deleting ${pr.head.ref} failed (${err.message}). Delete it by hand.`);
      }
    }
  };

  if (!patch) {
    await closeStale(null);
    log(`nothing to regenerate at ${tip.slice(0, 7)}.`);
    return { action: "none" };
  }

  if (git("rev-parse", "HEAD") !== tip) throw new Error(`post-merge-regen: the checkout is not at ${tip}`);
  git("apply", "--index", "--binary", patch);
  // `--no-renames`: with rename detection a file moved OUT of a refused path
  // shows only its destination, and the deletion of the source would pass.
  const touched = git("diff", "--cached", "--name-only", "--no-renames").split("\n").filter(Boolean);
  const refused = refusedPaths(touched, cfg.allow);
  if (refused.length) throw new Error(`post-merge-regen: the regeneration may not change ${refused.join(", ")}`);
  // `--author` as well as `user.*`: an ambient GIT_AUTHOR_NAME outranks
  // `-c user.name` and would put somebody else's name on the commit.
  git("-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "--no-verify", `--author=${name} <${email}>`, "-m", title, ...(body ? ["-m", body] : []));
  const tree = git("rev-parse", "HEAD^{tree}");

  const branch = branchFor(prefix, tip);
  const existing = git("ls-remote", remote, `refs/heads/${branch}`).split(/\s+/)[0];
  if (existing) {
    git("fetch", "--quiet", remote, `refs/heads/${branch}`);
    if (git("rev-parse", "FETCH_HEAD^{tree}") !== tree) {
      throw new Error(`post-merge-regen: ${branch} already exists with a different tree. Delete that branch and re-run.`);
    }
    log(`${branch} already carries this regeneration; reusing it.`);
  } else {
    git("push", "--quiet", remote, `HEAD:refs/heads/${branch}`);
  }

  const open = owned.find((pr) => pr.head.ref === branch);
  const pr = open ?? (await pat.request("POST", `/repos/${repo}/pulls`, { title, body: body ?? "", head: branch, base, draft: false }));
  const how = await enableAutoMerge(bot, repo, pr);
  log(`#${pr.number} ${open ? "kept" : "opened"} from ${branch} (${how}).`);
  await closeStale(pr.number);
  return { action: open ? "kept" : "opened", pr: pr.number, branch };
}

async function main() {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY;
  const secrets = [env.PR_TOKEN, env.GITHUB_TOKEN];
  const cfg = {
    repo,
    base: env.BASE_BRANCH,
    prefix: env.BRANCH_PREFIX,
    tip: env.REGEN_TIP,
    title: env.PR_TITLE,
    body: env.PR_BODY,
    author: env.COMMIT_AUTHOR,
    allow: env.ALLOW_PATHS ?? "",
    patch: env.REGEN_PATCH && existsSync(env.REGEN_PATCH) ? env.REGEN_PATCH : null,
  };
  for (const key of ["repo", "base", "prefix", "tip", "title"]) {
    if (!cfg[key]) throw new Error(`post-merge-regen: ${key} is required`);
  }
  if (!env.PR_TOKEN) throw new Error("post-merge-regen: pr-token is required; a PR opened with GITHUB_TOKEN never gets its checks");
  const gitEnv = { ...env, ...authEnv(env.PR_TOKEN) };
  delete gitEnv.PR_TOKEN;
  delete gitEnv.GITHUB_TOKEN;
  const git = (...args) => {
    try {
      return execFileSync("git", [...HARDENED, ...args], { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (err) {
      throw new Error(redact(`git ${args[0]} failed: ${err.stderr || err.message}`, secrets));
    }
  };
  const result = await runLand(cfg, {
    bot: githubClient({ token: env.GITHUB_TOKEN }),
    pat: githubClient({ token: env.PR_TOKEN }),
    git,
    remote: `https://github.com/${repo}.git`,
    log: (line) => console.log(`[post-merge-regen] ${redact(line, secrets)}`),
  });
  console.log(`[post-merge-regen] ${JSON.stringify(result)}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error title=post-merge-regen::${redact(err.message, [process.env.PR_TOKEN, process.env.GITHUB_TOKEN])}`);
    process.exit(1);
  });
}
