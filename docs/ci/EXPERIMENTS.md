# CI experiments

Append results and corrections; retain failures and their explanations. Consumer
experiments also live in each caller's own CI log.

## E-001 — Explicit GitHub-hosted runner choice survives inherited variables

**Date:** 2026-09-30 · **Status:** Local proof complete; hosted proof pending

**Question:** can a public consumer explicitly keep every reusable job on
GitHub-hosted runners when its context contains a private `CI_RUNNER` label,
without changing existing private callers or repository settings?

**Baseline:** engine `2114b2a87467f1deb21139ed0edf79581f16f941` uses
`vars.CI_RUNNER || 'ubuntu-latest'` for all 18 jobs in `monorepo-static.yml`
(5), `monorepo-tests.yml` (9), `commitlint.yml` (1) and
`post-merge-regen.yml` (3). It has no caller input. Observing a GitHub-hosted job
under an empty variable does not prove isolation from an inherited fleet label.

**Method:** add optional string input `runner`, default empty, and make every
job choose `inputs.runner || vars.CI_RUNNER || 'ubuntu-latest'`. No runner
infrastructure, permissions, repository variables, or AWS settings change.
`runner-override.test.mjs` evaluates the actual shipped expressions with
`runner=ubuntu-latest` and inherited `future-pay-ci`; checks a second explicit
label, the existing private fallback, and the default; mutates each of the 18
jobs to remove the override; and swaps priority to show the unsafe fleet choice.
The declaration contract checks type, optionality and default. The hosted
Self Tests workflow explicitly invokes the new suite.

**Results:**
- Run `node --test .github/workflows/__tests__/runner-override.test.mjs` with the
  original four workflow files and original Self Tests file: **8 passed,
  9 failed**, exit 1. The missing declaration, missing caller priority and
  missing hosted suite invocation are rejected.
- The first full local aggregate on the changed files produced **294 passed,
  1 failed**. The existing `runner-selection.test.mjs` deliberately required
  the old expression for every reusable job. Independent review found the same
  mismatch. The guard was kept and taught to expect the exact input-first form
  only when the workflow actually declares `runner`; all other workflows still
  require the old exact fallback, and the pinned-job exceptions remain.
- Re-run `node --test .github/workflows/__tests__/*.test.mjs
  .github/actions/vitest-signal-guard/__tests__/*.test.mjs`: **318 passed,
  0 failed, 0 skipped**, 9.59 seconds. This materialized tree also contains the
  separately reviewed full-suite guard from #157; those files are not part of
  the runner change.
- Independent closed-list review after the correction: runner selection,
  runner override and declared inputs **72/72**, 161.8 ms; zero unresolved
  findings. `actionlint` 1.7.7 passes all five changed workflows with optional
  external shellcheck/pyflakes disabled.

**Why:** an explicit per-call value takes precedence; empty preserves the
existing variable and default. This supports public GitHub-hosted callers and
private fleets without an organization-wide settings change. Regeneration's
existing ephemeral-per-job secret-isolation requirement remains in force.
No measured billing or speed reduction is claimed.

**Hosted evidence:** pending. GitHub connector reads began returning HTTP 401
Unauthorized at 16:00 UTC before publication. After access is restored, publish
the scoped PR, verify its exact-head checks and actual suite count, append the
run/job links here, and verify the normal release. Consumers then pin that
release and supply `runner: ubuntu-latest` on every call, with their own
positive/negative assertions and observed GitHub-hosted job metadata. A local
expression result alone is not reported as a hosted run.

**Regression watch:** all 18 jobs must honor the override, including plan,
signal, verdict and regeneration jobs. Empty input must preserve private
`CI_RUNNER`; empty input and variable must fall back to `ubuntu-latest`.
`runner-selection.test.mjs` rejects an input expression in an undeclared
workflow; `runner-override.test.mjs` catches missing/ignored/wrong-priority
inputs; `declared-inputs.test.mjs` catches undeclared input reads. No permission
or infrastructure change is part of this experiment.

**Publication isolation (2026-09-30, 16:21 UTC):** connector access recovered.
The runner change is published separately on current main `2114b2a`, excluding
#157's pending full-suite guard so it cannot release that guard prematurely.
The isolated workflow/guard aggregate passes **286/286**, zero skips, in 1.42 s;
actionlint again passes all five changed workflows. The 318 count above refers
to the earlier combined local tree, not this isolated PR. Private caller fallback
behavior remains unchanged. Hosted verification is still pending.

**Hosted proof (2026-09-30):** source head
`2549ff61a619dbc6588ea397f298f62a45e3717f` ran
[Self Tests 36743687944](https://github.com/12-apps/ci/actions/runs/36743687944).
[Action script tests 109984347476](https://github.com/12-apps/ci/actions/runs/36743687944/job/109984347476)
completed successfully. The actual log records the runner override suite at
16:23:03 UTC: **17 tests, 17 pass, 0 fail, 0 skipped**, 83.76 ms. It includes
all 18 missing-override mutations and each inherited-first negative, with the
explicit public and unchanged private/default cases. The existing runner
selection step, including its imported declaration/timeout checks, logs
**32/32**, 121.84 ms. Declared inputs and workflow permissions also passed.
[Runner image 109984347781](https://github.com/12-apps/ci/actions/runs/36743687944/job/109984347781)
passed its build and smoke check; the empty-matrix case was intentionally
skipped. These are fixture timings, not a workload speed or billing claim.

This documentation-only head must pass its own exact-head checks before merge.
The first source head's CodeQL analysis was still running when this addendum
was written, and is not counted as completed evidence here. The normal release
and real consumer runner metadata remain separate rollout checks.

## E-002 — Full-suite test execution is checked on every event

**Date:** 2026-09-30 · **Ticket:** FUT-2098 · **Status:** Proven source; final reconciliation checks pending

**Question:** can a successful push, dispatch or scheduled test command report
success when all cases are skipped? The old PR-only JUnit condition allowed it.

**Method:** #157 applies the existing opt-in execution guard to unit and
integration on every event, both within a one-shard job and over aggregate
multi-shard reports. Preserve empty plans, verified reuse and report opt-out;
restrict the label bypass to pull requests. Retain #158's XML parser correction
and #161's explicit runner precedence. The permanent wiring suite executes a
real Node runner plus the production parser under the shipped workflow conditions.

**Results and rejected behavior:**
- On baseline `102a864b`, existing checks passed 246/246, while the new wiring
  controls had 15 passes and 16 failures, including all 12 all-skipped combinations
  of push/dispatch/schedule, unit/integration and one/multiple shards.
- Corrected source `4f101f09` passed 278/278 local checks, zero skipped;
  independent reconciliation review passed 55/55 with no findings.
- Strict Vitest 3.2.7 proved the underlying problem: one skipped case exits 0,
  but the guard exits 1. One executed plus one skipped case passes both. Missing
  and malformed reports remain failures. No intentionally failing probe is merged.
- [Self Tests 36734581363](https://github.com/12-apps/ci/actions/runs/36734581363),
  [job 109952804649](https://github.com/12-apps/ci/actions/runs/36734581363/job/109952804649),
  actually logged 31/31 wiring and 24/24 guard checks. All exact-head checks,
  including CodeQL and runner image smoke, completed successfully; the empty
  matrix job was intentionally skipped.

**Consumer prerequisite:** FuturePay's full-unit command lacked `CI_JUNIT_DIR`.
Adding that alone failed on a warm Turbo cache because its XML was not a task
output. The fix writes/restores only each workspace's own XML and collects
disjoint root/app/package directories. The env-only attempt, missing-output
negative, real cold/warm controls, initial fixture Git-scope failure and fix,
commit-message enforcement recovery, and hosted counts are recorded in
[FuturePay E-019](https://github.com/12-apps/future-pay/blob/bc4708376e31cd9936cac999aa7134d4888b8c98/docs/ci/EXPERIMENTS.md#e-019--full-unit-junit-survives-cached-workspaces).
Closed #2283 is replaced by [#2297](https://github.com/12-apps/future-pay/pull/2297).
Its source run 36743367282 passed all 13 shards, 19,768 unit cases/77 reports and
4,595 integration cases/9 reports; installed gates including real cache controls
passed 49/49. Release of this full-event guard remains held until the consumer's
final head is green and merged. No manual full application-suite dispatch or
cost-saving claim is made.

**Runner reconciliation:** #161 released v2.49.0 at `ea880246` independently.
This PR preserves all 18 input-first runner choices, its runner tests and its
Self Tests invocation. The two new self-test steps both remain. The combined
local prototype previously passed 318/318; the new reconciliation head must
pass its own applicable local and hosted checks before merge. Normal release
verification and base-app's actual full-path proof follow before consumer merge.

**Regression watch:** `full-suite-signal.test.mjs` binds the actual workflow
conditions to executed cases, including zero-work/reuse/opt-out and PR-only label
controls. `check-test-signal.test.mjs` covers missing, malformed and skipped XML,
including quoted attributes. `runner-override.test.mjs` must still keep an
explicit GitHub-hosted choice ahead of inherited variables. Never infer an
executed test from a command's exit code or a cache log alone.

**Reconciliation verification (2026-09-30, 16:42 UTC):** the combined final
workflow/guard aggregate passed **318/318**, zero skipped, in 9.69 s. Independent
reconciliation verification passed **104/104** guard/parser/runner/declaration
controls, zero skipped, and actionlint passed. The reviewer confirmed all nine
monorepo-test job runner choices, both self-test steps and the original parser
logic are preserved; only the already-reviewed non-PR zero-test advice differs
in the parser file. No reconciliation regression was found.

**Combined hosted proof (2026-09-30):** reconciled source head
`cce2568229fd0c13fddbb6c7e63c55bddf8d2e1c` passed all nine recorded checks,
including CodeQL and runner image smoke, in
[Self Tests 36746315517](https://github.com/12-apps/ci/actions/runs/36746315517).
The intentionally empty matrix job was skipped.
[Action script tests 109993289028](https://github.com/12-apps/ci/actions/runs/36746315517/job/109993289028)
actually logged **24/24 guard**, **17/17 runner override** and **31/31 full-suite
wiring** checks, all with zero skipped, proving both changes coexist in the
hosted tree. This documentation-only addendum must pass its own final-head
checks before merge; the compatibility prerequisite still applies.

## E-003 — A stacked branch is re-stacked with its parent's pre-squash head as a merge base

**Date:** 2026-10-05 · **Ticket:** FUT-3341 · **Status:** Local proof and replay complete; hosted proof pending

**Question:** after a parent PR is squash-merged, can the engine take the base
into its child branch with the right merge base, push that merge without
rewriting anything, and leave only the real conflicts to a person? And can the
report tell that merge from a hand resolution, given that most hand
resolutions produce the same tree?

**Baseline:** engine `ce9be5f` (`v2`, #166). The report counts every
conflicted file of a stacked sync as `code: stacked`. Replayed over
future-pay's PR history (2,574 PRs, every `refs/pull/*/head` fetched, config
`.github/conflict-monitor.json`), pinned to the epic's window
(`until 2026-09-29T13:14:23Z`, `base-tip eb17230`, `since 2026-09-15`):
`code: stacked` 315 / 52 of 2,076 / 472 files. A culprit is mapped to its PR
by the subject's `(#N)` only, which missed #1984's squash (`6cf2cda`, no
number in its title).

**Method:** `lib/restack.mjs` merges the branch with a throwaway commit Z (the
base's tree, with the base and each stacked parent's held head as parents), so
git uses every merge base it finds. A new `restack` mode and
`conflict-restack.yml` push a clean result as a two-parent merge under a lease;
the probe analyses a stacked PR against Z; the report replays each stacked sync
against Z and prints the re-stack-aware groups next to the legacy ones, mapping
a culprit through the PR list's `merge_commit_sha` before `(#N)`. The
scenarios live in `__tests__/restack-cases.json` and are built with real git;
the mode's pushes go to a real bare remote; GitHub is stubbed.

**Results:**
- The engine's own planner (`planRestack`, as the bot calls it) over E0's 60
  live stacked syncs: **46 clean (33 distinct merges), 14 residual, 81
  residual files**; 40 of the 46 clean trees equal what the human committed.
  Identical row by row to the ticket's measurement, with the squash mapped by
  `merge_commit_sha` only or with the `(#N)` fallback. The three two-parent
  syncs take both held heads; #740 is left with 5 files either way.
- The pinned report, legacy → re-stack-aware (all / since 09-15): stacked
  **318 / 55 → 249 / 9**; concurrent edit **635 / 168 → 672 / 187**; append
  point **273 / 102 → 288 / 112**; duplicated scope **32 / 5 → 49 / 22**.
  Every other row and the totals (2,076 / 472) are unchanged. The legacy
  column is today's rule plus the `merge_commit_sha` mapping (+3, #1984). The
  live report gives 327 / 64 → 258 / 18, 714 / 247 → 751 / 266,
  297 / 126 → 312 / 136 and 32 / 5 → 49 / 22, and names the five stacked syncs
  since 09-15 (#1849, #1984, #2123, #2344, #2519).
- `node --test .github/actions/conflict-monitor/__tests__/*.test.mjs`:
  **173 passed, 0 failed** (117 before); every `self-test.yml` step run
  locally is green; `node --test .github/workflows/__tests__/*.test.mjs`
  **309 / 309**; actionlint 1.7.7 passes the four conflict workflows.
- Ten mutations each turn a test red: trailers accepted unchecked, the blob
  check dropped, no revert skip, Z without held heads, Z with one of two, a
  plain `--force`, no ping-pong cap, forks not excluded, the probe re-fetching
  a re-stacked PR, and the report without the `merge_commit_sha` mapping.
- The rendered messages (one parent, 4- and 5-digit numbers, two and five
  parents, with and without `Restack-Redo`) pass the real `@commitlint/cli`
  with future-pay's `scripts/commitlint/ci.config.mjs` and
  `REQUIRE_ISSUE_REF=true`.

**Rejected:** a single `--merge-base` (43 clean syncs, and worse than the
default merge on 3); `rebase --onto` (28 clean, and a force-push); recording
the parent's head as a third parent (the report would replay it as a sync);
the `(#N)` subject as the only map; a `GITHUB_TOKEN` push (it starts no
checks on the PR).

**Why:** the merge is the one git would have made had the parent landed as a
merge commit, so it removes exactly the squash artefacts and keeps every real
conflict. The trailers, accepted only when they match the report's own
computation and the committed blob equals Z's, are the tell that the tree is
not. Decision record: `docs/adr/2026-10-05-restack-after-squash.md`.

**Regression watch:** the report's groups move for every consumer: the
re-stack-aware columns are primary, the legacy ones keep the old rule for
comparison. `restack-cases.json` is the contract a consumer's local command is
tested against; a change to a case or its tree id is a change to that
contract. `runner-selection.test.mjs` lists `conflict-restack.yml:restack` as
PINNED ("holds a PAT"). Hosted evidence (the job's median wall time, the first
pushes) is recorded with the consumer's rollout.

**Correction (review r1, 2026-10-06):** the first ping-pong cap could not fire
on GitHub. It looked for the bot's re-stack in the PR timeline's `committed`
events, and GitHub lists there only the commits the PR has now: on every
force-pushed future-pay PR checked (#169, #1327, #1727, #1837, #1849) the
timeline's commits equal `/pulls/{n}/commits`, and none is a commit a
force-push removed. The test was green because it fed exactly the shape
GitHub never returns. The cap now reads
`GET /repos/{o}/{r}/activity?ref=refs/heads/<ref>&activity_type=force_push`
and, per force-push, `GET /repos/{o}/{r}/compare/{after}...{before}`, which
still serves the discarded commits. Both were checked read-only on #1849's
force-push of 2026-09-19 (`36f5625` -> `29e4aba`, 41 discarded commits, one of
them a hand merge of `main`). `__tests__/restack-activity.json` keeps that
structure with its values replaced, and the test force-pushes for real and
answers compare from the repository. In the same pass: no git subprocess of
the mode inherits `PUSH_TOKEN` or `GITHUB_TOKEN` and every git call runs with
hooks and fsmonitor off (a `git` wrapper asserts it, and removing either now
turns a test red; before, removing the hardening turned nothing red); a
`[remote rejected]` push is a warning and that PR's entry, not a red run; the
commit is dated by its parents; the comment's recipe computes the held heads
instead of printing trailer values; a tool merge's file with a custom merge
driver counts as the tool's. Re-run: conflict-monitor **177 / 177**, every
`self-test.yml` step green, workflow tests **309 / 309**, actionlint clean,
and the replay unchanged (46 / 14 / 81; 318 / 55 → 249 / 9 and the other
three rows as above). The duplicated-scope ticket line reads 20 instead of 3
on the pinned window: it follows the re-stack-aware group.

**Correction (review r2, 2026-10-06):** two changes of the r1 pass were
wrong and are reverted or hardened.
- **The merge-driver exemption is withdrawn.** It let a trailered merge's file
  count as the tool's whenever its path had a custom `merge=` driver,
  whatever its blob, and read that attribute from the merge being judged.
  future-pay gives every `*.ts`, `*.tsx`, `*.js` and `*.mjs` file a driver, so
  trailers alone would have hidden any hand resolution, a wrong one included.
  The blob check is strict again for every file; a driver that writes another
  blob than Z's is counted as `code: stacked`, which is conservative and
  expected to be rare (a driver runs only where both sides changed a file Z
  already merges cleanly). A regression test pins it.
- **The raw recipe was not fail-fast.** Pasted with an unpublished
  `refs/pull/N/head`, its later lines still rewrote MERGE_HEAD and committed
  the branch's own tree under the tool's header, a merge that silently drops
  `main`'s changes. It is now one `( set -eu … )` subshell that refuses an
  empty held head or merge base and proceeds only when the merge in progress
  is Z's, plus a commit line that runs only while that merge is in progress.
  A test pastes it with no `refs/pull`, with an empty held head and over a
  dirty worktree: each exits non-zero and creates no commit.
- **The activity API's permission is documented, not assumed:** GitHub's REST
  docs list `GET /repos/{o}/{r}/activity` and `GET /repos/{o}/{r}/compare/…`
  under "Contents" (read), among the endpoints an installation token
  (`GITHUB_TOKEN`) may call. The job grants `contents: read`. An unreadable
  record now skips the PR with a `::warning::` naming the cause; force-pushes
  before the PR was opened are ignored, and a compare 404 is no bot re-stack.

**Correction (live proof, 2026-10-06):** the first live re-stack in
future-pay skipped its child PR (#2639) as "a protected head" (run
37452210190, `restack {"pushed":[],"skipped":[[2639,"a protected head"]]}`).
future-pay's repo-wide ruleset 19208143 (`branch_name_pattern` +
`non_fast_forward`) applies to every branch, so `GET /branches/<b>` reports
`protected: true` everywhere while classic protection is off; the exclusion
made the bot inert in that repository, and no test caught it because the
stub never set the flag on a pushable branch. The exclusion now reads classic
protection (`protection.enabled`) and the effective rule types
(`GET /rules/branches/{branch}`), skipping only on a rule that stops a
fast-forward push; a protected branch whose rules cannot be read is skipped
with the reason. A test pins the future-pay shape (protected, naming rules
only → pushed), and reverting either half of the check turns it red.
