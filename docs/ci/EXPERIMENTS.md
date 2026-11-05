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

## E-004 — A module-context edit narrows when nothing new runs at load

**Date:** 2026-10-22 · **Status:** Local, history and hosted proof complete; consumer run on `v2` pending

**Question:** `affectedExports` answers `*` for any edit outside an exported
declaration. future-pay#3351 added one import and one private helper to
`tests/e2e/helpers/spa-session.ts`. The `*` reached `tests/e2e/warm-api.ts`
through its import of the untouched `SUPER_ADMIN_USER`, and that file is a runner
root. So both e2e selectors went full: all 65 Gherkin features and all 229 SPA
specs, and the slowest leg took 24.8 minutes (future-pay run 39842217382). Can
the engine prove a narrower answer without a new false negative?

**Baseline:** engine `b25ce98` (`v2`). Running `plan.mjs --lane e2e` locally on
future-pay `a7d8ef9` against `b101b95` reports `spa-session.ts: ["*"]`, 228
test files, and reaches `warm-api.ts`.

**Method:** `lib/module-context.mjs` re-proves the whole file whenever
`affectedExports` says `*`.
- **The cut.** It cuts base and head into top-level units on the
  literal-masked text. A unit starts at column 0. Everything indented, inside a
  literal or a template, or opening with a closing bracket belongs to the unit
  above it.
- **When it narrows.** Only when all of these hold:
  - every unit balances and starts a fresh statement;
  - opaque (load-time) units are identical and reach no tainted name;
  - evaluated modules keep their order and their bindings;
  - every added module is pure and exports each name the file binds from it;
  - no runtime name is declared twice;
  - every export list names a declared binding;
  - head parses (`module.stripTypeScriptTypes`);
  - nothing calls `eval` or `Function`.
- **The answer.** The exported names the changed inert or erased declarations
  can reach.
- **`inertDeclaration` (moved from `select.mjs`).** It now finds a function's
  body past a destructured parameter or an object return type. It refuses an
  arrow, literal or type alias that a line break could end early by ASI.

**Results:**
- **future-pay#3351.** The same command now reports `spa-session.ts:
  [signInAs, signInAsAdmin, signInAsAdminSuperuser, signInAsSuperAdmin,
  signInAsWaiter]` and 94 test files, and `warm-api.ts` is not reached. Fed to
  the consumer's selectors: Gherkin goes from full (65) to **42 features**, SPA
  E2E from full (229) to **65 specs**.
- **Why 94 and not 105.** A simulation that forced only `signInAs` gave 105.
  The difference is the `inertDeclaration` fix. `journey-buyer.ts`'s
  `startJourney(…, options: { … })` read as eager code, which widened every
  importer of that module, including step files that bind only constants.
- **Adversarial review, four rounds, VERDICT OK on round 4.** Rounds 1–3 found
  18 new false negatives, each reproduced as a test that passes before the edit
  and fails after it, and each selected by `b25ce98`. All are fixed:
  - ASI after an expression arrow, a type alias or a postfix `++`;
  - a regex at a line's end;
  - `!`, `as(` or `satisfies(` starting the next line;
  - `export default` or `new` above a column-0 function;
  - an indented side effect inside an added "pure" module;
  - `export default function foo` read as a named export;
  - an `export const` line inside a template;
  - a nonexistent `node:` builtin;
  - a redeclared import binding;
  - a syntax error in a private body;
  - a direct `eval`;
  - an export list naming a removed declaration;
  - a value import of a type.

  Each is a case in `module-context.test.mjs`. Ten of them were also run
  against the pre-review snapshot and failed there. The reviewer's pre-existing
  P1 (an indented statement after an inert arrow in an intermediate module)
  is closed by the same `asiSafe` check. P2 (a syntax error inside an EXPORTED
  body narrows to that export) predates this change and is unchanged.
- **Guards are load-bearing.** Removing any one guard turns at least one test
  red: the continuation check, the load-time reach check, the export-name
  check, the purity recursion, the order check, the binding check, the
  function-end check, the erased-end check, the opaque-identity check, cycle
  impurity, and the unit-start check.
- **Suite:** `node --test .github/actions/affected-plan/__tests__/*.test.mjs`
  passes **346/346** (312 before this change).

**Why:** a deferred function, an arrow or a literal does nothing when a
module loads. A module made only of those runs nothing either, and binding a
name it exports changes nothing for an importer that never calls it. What can
run at load must be unchanged and must not reach the edit. Every shape the cut
cannot read keeps `*`.

**Regression watch:** `module-context.test.mjs`. Its "stays wide" cases are
executable counterexamples, and each one must stay selected. The type-only
counterexamples from #179/#180 still pass, unchanged.

**Consumer history:** `plan.mjs` ran with `b25ce98` and with this change
(the same engine bytes that were committed) on the last 15 first-parent
commits of future-pay `main` (`56e4dc35`..`14261957`), each against its first
parent, for the `e2e` and `unit` lanes. That is 30 plans.
- **Containment.** In every one, the new selection is contained in the old:
  **0** tests selected that `b25ce98` did not.
- **Where it narrows.** It is smaller in one: `4167bb11` (#3351 merged),
  e2e **228 → 94**.
- **Where it does not.** The other 29 are identical, from 1 to 3,512 tests.
  Those commits add no import or private helper to a file a test reaches.

**Hosted:** Self Tests on this branch at `70e7667`: affected-plan
**346/346** on Node v24.21.0 (job 120133147847).

**Pending:** a consumer run once `v2` carries this change.

## E-005 — The database input pass tests each pattern once, not once per migration (FUT-4396)

**Date:** 2026-11-04 · **Status:** Worked locally; hosted proof pending

**Question:** why does future-pay's `Tests / Integration Plan` take 5m55s, and
can it be made fast without changing a single selection or input hash?

**Baseline:** future-pay PR 4096, run 41874433175: the job's only real step,
`Compute the affected test plan`, took **329 s** (Unit Plan's took 122 s). A
local `node --cpu-prof` of the same `plan.mjs` on the same commit and
arguments took **8m38s** and put **94%** of it under `databaseInputRoutes`:
skip-green's input hashing runs the database router over every tracked file as
"changed", i.e. all **567** migrations, and for each one `migrationReaders`
rescanned every source file for a migration name and `entriesForMatches`
re-tested that migration's model patterns against the same ~4,000 files. That
run's log line: `[inputs] 0 test(s) hashed`.

**Method:** answer-preserving caching only, scoped to one router run:
`matchCache()` in `lib/occurrences.mjs` memoizes which files a pattern
matches (keyed by source and flags), each file's declarations, and
`reachableExports(file, hot)`; a pattern that is exactly `\b(?:a|b)\b` over
identifiers is answered from a per-file word set; a mention pattern carries its
anchor words (`withAnchors`), a necessary condition checked case-insensitively
before the regex runs; `relationsInto` is deduplicated (the `client` pattern
repeated `\bclient\s*:` dozens of times); `migrationReaders` indexes every
file's migration names once.

**Results (local, 4 vCPU):**

| step | integration plan, PR 4096 head |
|---|---|
| before | 8m38s |
| + memo per pattern, readers index | 3m12s |
| + word index | 2m42s |
| + anchors, dedupe | 1m09s |
| + reachable memo | **48 s** |

Every row wrote a document **byte-identical** (`cmp`) to the baseline's.
Old (`53e15c8`) against new on three more cases, same machine, every document
byte-identical:

| case | old | new | plan |
|---|---|---|---|
| integration, future-pay `6e17214` (adds a migration) vs its parent | 544 s | 62 s | narrowed, 748 tests, 748 hashed |
| unit, the same commit | 169 s | 36 s | narrowed, 731 tests, 731 hashed |
| unit, PR 4096's head | 163 s | 29 s | narrowed, 265 tests, 265 hashed |

Mutations: making the
anchor check case-sensitive fails 3 of `occurrences-cache.test.mjs`'s 7 cases;
counting `$` as a word character fails 1.

**Hosted evidence:** pending — the consumer's next PR run on a `v2` that
carries this.

## E-006 — Every matrix lane is sized by measured time, refreshed by the daily run (FUT-4395)

**Date:** 2026-11-04 · **Status:** Engine half built and exercised against a real run; consumer half pending

**Question:** can one mechanism size unit, integration, SPA E2E and Gherkin
(and later load tests) to about 8–10 minutes of test step a leg, keep its
numbers fresh without a human, and say which single file is too slow?

**Baseline:** each lane counted (`ceil(files / 40)`, `ceil(specs / 26)`,
`ceil(features / 4)`); the two cost-packed lanes read hand-refreshed ledgers
(future-pay's integration ledger: 219 of 846 files).

**Method:** `.github/actions/lane-timings` — `size` (legs =
`ceil(Σ ledger seconds / concurrency / target)`, clamped, packed LPT into
`legs[]` of the plan) and `refresh` (reads every leg's junit /
`spec-durations.json` from the run's artifacts and every leg's test-step time
from the Actions API, rewrites the ledgers, reports files over
`slowFileSeconds`, legs over the target and caps too small). Reusable workflow
`lane-timings-refresh.yml` lands the ledgers through the post-merge-regen
halves under `chore/lane-timings-`. `monorepo-tests.yml` takes
`unit-timings-ledger` / `integration-timings-ledger` (off by default).

**Exercised:** `refresh.mjs` run locally against future-pay's daily run
41818675238 (2026-11-04, main `85d3af9`):

| lane | items | concurrency | full width | legs wanted / cap | legs that ran past 10 min |
|---|---|---|---|---|---|
| unit | 3110 | 1.01 | 32m49s* | 4 / 4 | 4 of 4 (10m01s–11m52s) |
| integration | 846 | 1.56 | 91m43s | 10 / 24 | 1 of 24 |
| spa-e2e | 252 | 1.06 | 67m13s | 7 / 4 | 4 of 4 (14m49s–21m00s) |
| gherkin | 66 | 0.93 | 76m23s | 8 / 6 | 6 of 6 (12m23s–14m27s) |

\* one unit leg's artifact had expired (1-day retention) when this was run
after the fact; inside the run it will not have.

Six files over 3 minutes, each annotated: `lista-de-pagamento.feature` 6m09s,
`demo-consistency.test.ts` 5m34s, `cozinha-fluxos-edicao.feature` 4m43s,
`infinitepay-activation.feature` 4m01s, `cozinha-fluxos-arrastar.feature`
3m55s, `business-snapshot.e2e.ts` 3m06s.

Two defects the real run found and the code now handles: the jobs API
answered 502 once (retries, and a failed jobs call no longer discards the
artifacts); and a leg whose artifact had expired was counted against nobody's
measurements, reading concurrency 0.74 instead of 1.01 (concurrency now pairs
each artifact `-s<n>` with its own leg's `shard <n>/<m>`).

**Pending:** hosted Self Tests; the consumer wiring, a PR run sized by a
ledger, and the first daily refresh PR.

## E-007 — A leg reads its list from the engine, and the refresh can measure any run (FUT-4409)

**Date:** 2026-11-04 · **Status:** Built and tested locally; hosted proof pending

**Question:** can the consumer stop carrying its own copies of the leg
logic (future-pay validated `legs[i - 1]` twice and packed with its own
longest-first copy twice), and can the daily refresh be exercised end to end
before it first runs on its own?

**Method:** `lane-timings` gains `leg` mode (`leg.mjs`): it writes leg n's
items to a file after checking that the plan's legs cover its list exactly
once and match its stated leg count, and fails otherwise; `when-sized` lets
an unsized plan through with no file. `monorepo-tests.yml` runs it in the
unit and integration legs and passes `LANE_LEG_FILE` to the caller's
command. `refresh` and `lane-timings-refresh.yml` take a `run-id`, so the
reusable workflow can measure an earlier run: the probe of the whole
prepare → measure → land path that the consumer runs next.

**Results (local):** `lane-timings` and `.github/workflows/__tests__`
suites green, including `leg.test.mjs` (every untrustworthy plan refused,
`--when-sized` passes an unsized plan and still refuses bad legs) and the
leg wiring cases in `lane-timings-wiring.test.mjs`; dropping `when-sized`
from the wiring fails its case.

**Pending:** hosted Self Tests, the consumer switching its legs to
`LANE_LEG_FILE` and the `leg` step, and the refresh probe's PR.

## E-008 — The ledger PR's commit body fits commitlint (FUT-4409)

**Date:** 2026-11-04 · **Status:** Fixed; hosted proof is the next refresh

**Question:** why was the first ledger PR into future-pay's `main` closed
the moment it opened?

**Evidence:** a one-off run of `lane-timings-refresh.yml` against main
(future-pay run 41934916045, measuring daily run 41818675238): prepare,
measure and land passed, and land opened future-pay#4155 with auto-merge,
changing only the four ledgers. Then future-pay's commitlint enforcement
closed it and deleted its branch: the `body` input's default was one
185-character line, over `body-max-line-length` (100). The earlier probe
(#4145) never met that check because its base was not `main`.

**Change:** the default body is a literal block, three lines of at most 78
characters, and the input's description states the limit.
`lane-timings-wiring.test.mjs` asserts every line of the default is 100
characters or fewer; it fails on the old default.

This also closes E-007's pending refresh probe: future-pay#4146 ran the
`leg` step on every leg (unit, integration, SPA E2E, Gherkin) and merged.

**Addendum (same day):** the first ledgers on future-pay's `main` (#4157)
record `measured.sha` as the one-off branch's commit (`f74dc4d`), not the
commit the measured daily run tested (`85d3af99`). With `--run-id`,
`refresh` now records that run's `head_sha` (`measuredSha`, tested in
`refresh-sha.test.mjs`), and null when the run cannot be read. Its CLI runs
only when executed, so the helper can be imported.

## E-009 — A type-only edit seeds no runtime work, re-landed on three proofs (FUT-3586)

**Date:** 2026-11-05 · **Status:** Built and tested locally; hosted proof pending

**Question:** can an edit confined to `interface` and `type` declarations
stop selecting runtime tests without reopening the five false negatives
that reverted 12-apps/ci#179 (#180)? On a future-pay branch one added union
member in an interface selected 92 integration files: `withinFile` followed
the name to the exports annotating with it, and `initializationMayObserve`
widened the file to `*` on a non-inert initializer.

**Method:** `typeOnlyEdit` (`lib/module-context.mjs`) runs in
`selectAffected` before the module-context and `withinFile` steps, on a
changed non-test file, and answers yes only when three independent proofs
agree; otherwise the file takes the old path unchanged.

1. Names: every name `affectedExports` reports is declared by an erased unit
   (`type`/`interface`) and by no runtime unit, export list or import
   binding, on both sides; `*` is never type-only.
2. Units: both sides cut with `topLevelUnits` (#182's literal masking, the
   template-literal backtick tracking, `erasedEndsCleanly` and `asiSafe`),
   and every non-erased unit, imports included, is identical in order.
3. Emit: Node's `stripTypeScriptTypes` erases both sides to the same
   JavaScript, compared with literals byte for byte and line breaks kept
   (`canonicalLines`, new beside `canonical`). JSX or a non-erasable form
   cannot be stripped and is not type-only.

#179's single bracketer was the failure: both it and the runtime proof put
the same swallowed text in the type span. Here the runtime text is compared
by a different cut and by a real parser.

**New counterexamples** (`__tests__/type-only.test.mjs`), each a runtime
edit that must stay selected: an indented IIFE after a semicolon-less union,
with no `;` of its own; a column-0 `;(() => …)()` after a semicolon-less
type; a generic default holding a template literal with `${` and a call
after it, on its line and indented below it; a comment holding `}` inside an
interface with a call after the real close; a comment holding `{` inside an
interface over a changed const; an interface and an exported const on one
line; a `;`-terminated type and a call on one line; a string-literal type
holding a backtick over a changed const. In four of them `affectedExports`
blames only the type name.

**Results (local):** `node --test .github/actions/affected-plan/__tests__/*.test.mjs`:
23 files, 418/418 pass, with `type-only-counterexamples.test.mjs` unchanged.
The new file against main (667ab0c): the three narrowed cases and the plan
document case fail (`'narrowed' !== 'none'`), the 14 wide cases pass.
Against #179's code (7e31e38): five fail, the added `import type` and four
of the new counterexamples (indented IIFE, `}` in a comment, interface and
const on one line, type and call on one line).

**Pending:** hosted Self Tests, and a consumer branch with an interface-only
edit planning `none` with the file under `typeOnly`.

**Addendum (round-2 review, same day):** an independent review of 09c8340
found four runtime edits the rule reported as `typeOnly` with no test, each
selected on main. All four are now refused, pinned in
`__tests__/type-only-review.test.mjs` (each failed on 09c8340, passes now):

- B1, a `?raw` importer: `import text from "./basket.ts?raw"` reads the
  file's text, so a type edit changes a value. A file any importer reaches
  through a `?…` specifier is never type-only; a `?raw` glob importer stays
  selected through its route.
- B2, proof 3 shared a literal walker: `canonicalLines` reused
  `walkLiterals`, which misreads a backtick inside a template substitution
  (`${"`"}`, `${/`/.source}`, `${ /* ` */ 1}`, `${1 // `}`) and then
  collapsed whitespace inside a later real string. Strip mode keeps every
  byte at its position (checked: output length equals input length), so
  proof 3 now requires each erased unit's lines to strip to whitespace and
  compares the remaining lines byte for byte; `canonicalLines` is gone.
- B3, a `.tsx` file stripped as TypeScript: a JSX element whose opening tag
  also parses as a generic arrow got through with its text read as a
  comment. Only `.ts`, `.mts` and `.cts` files qualify.
- B4, decorators: under `emitDecoratorMetadata` a changed `type Id` changes
  the emitted `design:type`. A file with an `@` outside literals and
  comments is never type-only. A decorated class in another file that
  annotates with the type is not covered; the README says so.

Local: `node --test .github/actions/affected-plan/__tests__/*.test.mjs`, 24
files, 423/423; `type-only-counterexamples.test.mjs` and
`type-only.test.mjs` unchanged and green.

**Round 3 (same day):** two round-2 fixes were incomplete, pinned in
`type-only-review.test.mjs` (both failed on 3de7a62): R2-1, a computed
`import()` holding `?raw` is recorded as `<computed import>`, so the query
check never saw it; now one computed `import()`/`require()` whose argument
holds `?` or `#` turns type-only off for the whole plan, named under
`typeOnlyOff`. R2-2, `scan` read `z++ / 2; @Col() …` as a regex and masked
the decorator away; the `@` check now reads the raw text of both sides, so
an `@` in a string or a JSDoc refuses too. Local: 24 files, 426/426.
