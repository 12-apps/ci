/* global process */
/**
 * Post-merge regeneration: run the caller's `command` on the LIVE tip of the
 * base, and land whatever it changed as ONE squash-merged PR that starts no
 * workflow on the base (no deploy). See action.yml for the contract.
 *
 * In order — the order is what keeps two runs from undoing each other:
 *
 *   0. fetch the base tip; if an open regen PR already regenerates exactly
 *      this tip, make sure its auto-merge is on and stop (a re-run, a dispatch);
 *   1. switch auto-merge OFF on every other open regen PR, so none of them can
 *      merge underneath this run;
 *   2. fetch the tip AGAIN — a PR that merged before step 1 is now in it — and
 *      re-check step 0 against it;
 *   3. check the tip out and run the command, with no token in its env;
 *   4. no change: close the stale regen PRs and stop;
 *   5. a change: commit it on `<prefix><sha7>`, push that branch and open the
 *      PR with the PAT, enable auto-merge with GITHUB_TOKEN, then close the
 *      stale ones and delete their branches.
 *
 * The tip is never `GITHUB_SHA`. A regen merge starts no run of its own, so a
 * run queued behind one was triggered by an OLDER push; regenerating that
 * push's tree would redo what the merged regen PR already did.
 */
import { execFileSync, spawnSync } from "node:child_process";

import { isMain } from "./lib/entry.mjs";
import { disableAutoMerge, enableAutoMerge, githubClient } from "./lib/github.mjs";
import { branchFor, planStart, regenPrs } from "./lib/plan.mjs";

/** The environment names the command must never see. */
const SECRET_ENV = ["GITHUB_TOKEN", "PR_TOKEN", "GH_TOKEN", "INPUT_PR-TOKEN", "INPUT_GITHUB-TOKEN"];

export function scrubbedEnv(env) {
  const out = { ...env };
  for (const name of SECRET_ENV) delete out[name];
  return out;
}

function gitRunner(cwd) {
  return (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function parseAuthor(author) {
  const m = /^(.+?)\s*<([^>]+)>$/.exec(author ?? "");
  if (!m) throw new Error(`post-merge-regen: commit-author must read "Name <email>", got "${author}"`);
  return { name: m[1], email: m[2] };
}

/**
 * The whole run. Every side effect comes in through `deps`, so the tests drive
 * it against a real throwaway repository and a stubbed GitHub.
 */
export async function runRegen(cfg, deps) {
  const { repo, base, prefix, command, title, body, author } = cfg;
  const { bot, pat, git, runCommand, pushUrl, log = () => {} } = deps;
  const { name, email } = parseAuthor(author);

  const fetchTip = () => {
    // Through the PAT URL, like the push: the checkout keeps no credentials
    // (`persist-credentials: false`), and a private repository refuses an
    // anonymous fetch.
    git("-c", "http.https://github.com/.extraheader=", "fetch", "--quiet", pushUrl, `+refs/heads/${base}:refs/remotes/origin/${base}`);
    return git("rev-parse", `refs/remotes/origin/${base}`);
  };
  const listOwned = async () => regenPrs(await bot.paginate(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}`), { prefix, repo });
  const keepIfCurrent = async (tip, owned) => {
    const plan = planStart({ tip, prefix, owned });
    if (plan.kind !== "keep") return null;
    const how = await enableAutoMerge(bot, repo, plan.keep);
    log(`#${plan.keep.number} already regenerates ${tip.slice(0, 7)} — kept (${how}).`);
    return { action: "kept", pr: plan.keep.number };
  };

  // 0.
  let tip = fetchTip();
  let owned = await listOwned();
  const kept = await keepIfCurrent(tip, owned);
  if (kept) return kept;

  // 1.
  for (const pr of owned) {
    if (await disableAutoMerge(bot, pr)) log(`#${pr.number}: auto-merge off (superseded).`);
  }

  // 2.
  const again = fetchTip();
  if (again !== tip) {
    tip = again;
    owned = await listOwned();
    const keptLater = await keepIfCurrent(tip, owned);
    if (keptLater) return keptLater;
  }

  // 3.
  if (git("status", "--porcelain", "--untracked-files=all") !== "") {
    throw new Error("post-merge-regen: the checkout is dirty before the command ran");
  }
  git("checkout", "--quiet", "--detach", tip);
  log(`regenerating ${base} at ${tip.slice(0, 7)}: ${command}`);
  runCommand(command);
  const changed = git("status", "--porcelain", "--untracked-files=all");

  const closeStale = async (keepNumber) => {
    for (const pr of owned) {
      if (pr.number === keepNumber) continue;
      await bot.request("PATCH", `/repos/${repo}/pulls/${pr.number}`, { state: "closed" });
      try {
        await bot.request("DELETE", `/repos/${repo}/git/refs/heads/${pr.head.ref}`);
      } catch (err) {
        log(`#${pr.number}: closed; its branch was already gone (${err.message}).`);
        continue;
      }
      log(`#${pr.number}: closed, branch ${pr.head.ref} deleted (superseded).`);
    }
  };

  // 4.
  if (changed === "") {
    await closeStale(null);
    log(`nothing to regenerate at ${tip.slice(0, 7)}.`);
    return { action: "none" };
  }

  // 5.
  const branch = branchFor(prefix, tip);
  git("switch", "--quiet", "-c", branch);
  git("add", "-A");
  // `--author` as well as `user.*`: an ambient GIT_AUTHOR_NAME (a runner
  // image, a hook) outranks `-c user.name` and would put a person's name on
  // the bot's commit.
  git("-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "--no-verify", `--author=${name} <${email}>`, "-m", title, ...(body ? ["-m", body] : []));
  // An `actions/checkout` extraheader would override the PAT in the URL, and a
  // push authenticated as GITHUB_TOKEN starts no `pull_request` run.
  git("-c", "http.https://github.com/.extraheader=", "push", "--quiet", pushUrl, `HEAD:refs/heads/${branch}`);
  const pr = await pat.request("POST", `/repos/${repo}/pulls`, { title, body: body ?? "", head: branch, base, draft: false });
  const how = await enableAutoMerge(bot, repo, pr);
  log(`#${pr.number} opened from ${branch} (${how}).`);
  await closeStale(pr.number);
  return { action: "opened", pr: pr.number, branch };
}

async function main() {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY;
  const cfg = {
    repo,
    base: env.BASE_BRANCH,
    prefix: env.BRANCH_PREFIX,
    command: env.REGEN_COMMAND,
    title: env.PR_TITLE,
    body: env.PR_BODY,
    author: env.COMMIT_AUTHOR,
  };
  for (const key of ["repo", "base", "prefix", "command", "title"]) {
    if (!cfg[key]) throw new Error(`post-merge-regen: ${key} is required`);
  }
  if (!env.PR_TOKEN) throw new Error("post-merge-regen: pr-token is required — a PR opened with GITHUB_TOKEN never gets its checks");
  const cwd = process.cwd();
  const result = await runRegen(cfg, {
    bot: githubClient({ token: env.GITHUB_TOKEN }),
    pat: githubClient({ token: env.PR_TOKEN }),
    git: gitRunner(cwd),
    pushUrl: `https://x-access-token:${env.PR_TOKEN}@github.com/${repo}.git`,
    runCommand: (command) => {
      const res = spawnSync("bash", ["-euo", "pipefail", "-c", command], { cwd, env: scrubbedEnv(env), stdio: "inherit" });
      if (res.status !== 0) throw new Error(`post-merge-regen: the command exited ${res.status ?? res.signal}`);
    },
    log: (line) => console.log(`[post-merge-regen] ${line}`),
  });
  console.log(`[post-merge-regen] ${JSON.stringify(result)}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error title=post-merge-regen::${err.message}`);
    process.exit(1);
  });
}
