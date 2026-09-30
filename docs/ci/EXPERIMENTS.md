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
