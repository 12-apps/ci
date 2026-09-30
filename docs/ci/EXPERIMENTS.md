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
