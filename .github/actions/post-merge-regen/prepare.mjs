/* global process */
/**
 * Job 1 of 3 — decide, before anything is regenerated, which tip this run
 * regenerates and whether it has to. Runs with GITHUB_TOKEN only; it checks
 * nothing out and executes no repository code.
 *
 *   0. read the base tip; if an open regen PR already regenerates exactly this
 *      tip, make sure its auto-merge is on and stop (`action=keep`) — a re-run
 *      or a dispatch must never leave the kept PR with auto-merge off;
 *   1. switch auto-merge OFF on every other open regen PR, so none of them can
 *      merge underneath this run;
 *   2. read the tip AGAIN — a PR that merged before step 1 is now in it — and
 *      re-check step 0 against it; hand that tip to the next job (`action=regen`).
 *
 * The tip is never `GITHUB_SHA`. A regen merge starts no run of its own, so a
 * run queued behind one was triggered by an OLDER push; regenerating that
 * push's tree would redo what the merged regen PR already did.
 */
import { appendFileSync } from "node:fs";

import { isMain } from "./lib/entry.mjs";
import { disableAutoMerge, enableAutoMerge, githubClient } from "./lib/github.mjs";
import { planStart, regenPrs } from "./lib/plan.mjs";

export async function runPrepare({ repo, base, prefix }, { bot, log = () => {} }) {
  const readTip = async () => (await bot.request("GET", `/repos/${repo}/git/ref/heads/${base}`)).object.sha;
  const listOwned = async () => regenPrs(await bot.paginate(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}`), { prefix, repo });
  const keepIfCurrent = async (tip, owned) => {
    const plan = planStart({ tip, prefix, owned });
    if (plan.kind !== "keep") return null;
    const how = await enableAutoMerge(bot, repo, plan.keep);
    log(`#${plan.keep.number} already regenerates ${tip.slice(0, 7)}: kept (${how}).`);
    return { action: "keep", tip, pr: plan.keep.number };
  };

  // 0.
  const tip0 = await readTip();
  const owned = await listOwned();
  const kept = await keepIfCurrent(tip0, owned);
  if (kept) return kept;

  // 1.
  for (const pr of owned) {
    const what = await disableAutoMerge(bot, repo, pr);
    if (what !== "none") log(`#${pr.number}: auto-merge ${what === "disabled" ? "off (superseded)" : `not needed (${what})`}.`);
  }

  // 2.
  const tip = await readTip();
  if (tip !== tip0) {
    const keptLater = await keepIfCurrent(tip, await listOwned());
    if (keptLater) return keptLater;
  }
  log(`will regenerate ${base} at ${tip.slice(0, 7)}.`);
  return { action: "regen", tip };
}

async function main() {
  const env = process.env;
  const cfg = { repo: env.GITHUB_REPOSITORY, base: env.BASE_BRANCH, prefix: env.BRANCH_PREFIX };
  for (const [key, value] of Object.entries(cfg)) if (!value) throw new Error(`post-merge-regen: ${key} is required`);
  const result = await runPrepare(cfg, {
    bot: githubClient({ token: env.GITHUB_TOKEN }),
    log: (line) => console.log(`[post-merge-regen] ${line}`),
  });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `action=${result.action}\ntip=${result.tip}\n`);
  console.log(`[post-merge-regen] ${JSON.stringify(result)}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error title=post-merge-regen::${err.message}`);
    process.exit(1);
  });
}
