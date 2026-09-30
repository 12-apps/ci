# `skip-green` — do not re-run what this pull request already proved

Selection (`affected-plan`) is cumulative on purpose: every push diffs against
the merge base with the default branch, so only the latest run gates the merge
button. The cost is that push 3 of a PR re-runs push 1's tests even when push 3
changed nothing those tests can see. This action is the complement: a test that
an earlier **green** run of the same lane on the same PR passed **with identical
inputs** is reported as skipped and does not run.

## How it decides

1. `affected-plan` hashes each selected test's **inputs** into the plan
   (`inputs: { test: hash }`, `lib/inputs.mjs`): the test file plus its
   transitive **value** import closure, and the lane's declared **global**
   inputs (`lanes.<lane>.skipGreen.globals` in the consumer's config — the
   lockfile, the workspace manifest, vitest configs, setup files, a database
   lane's migrations). Each file enters as `<mode> <blob sha> <path>` from
   `git ls-tree`, so two trees with identical counted entries hash alike.
   A test whose closure reaches an unresolvable import gets `null`: no hash,
   never skippable.
   A committed file the plan ROUTES to a suite (one it reads off disk with
   `readFileSync` — a manifest, a YAML, a ledger) joins that suite's inputs
   too: the closure cannot see it, the route says the suite's verdict depends
   on it.
2. **`filter`** (in the plan job, before the matrix is sized) reads the
   manifest an earlier green run left in the Actions cache and drops every
   planned test whose hash matches its recorded one — unless the test is on the
   consumer's **always-run** list. The plan document is rewritten in place:
   `tests` shrinks, `skipped: [{ test, greenAt, greenRun }]` says what was
   skipped and which run earned it, `mode` becomes `none` when nothing is
   left, and `counts.shardTotal` is re-sized by the plan's own rule.
3. **`record`** (after the matrix, in a lane whose result is `success`) merges
   the run's hashes into the manifest and the workflow saves it under
   `green-<lane>-<key>-pr<N>-<run_id>`; the next run restores by the
   `green-<lane>-<key>-pr<N>-` prefix, so the newest green manifest of the PR
   wins. `<key>` is the workflow's hash of the lane's Node version and
   commands, so changing how the lane runs invalidates every entry.

## Shadow first

`policy: shadow` decides, prints `would skip: <test> — green at <sha> (run N)`
and runs everything anyway. A week of shadow with no "would have skipped, then
failed" is the evidence to flip to `enforce`; a single such case is a hole in
the hash (or a non-hermetic test for the always-run list) to fix first.

## What never happens

| situation | outcome |
|---|---|
| no manifest, unreadable manifest, another lane's manifest | nothing skipped |
| plan without `inputs` (lane did not opt in), plan not `narrowed` | nothing skipped |
| test with `null` inputs (unresolved import in its closure) | runs |
| test whose closure reaches a file git does not track (a workspace package's built `dist/` present at plan time wins over its `src/` — plan on a CLEAN checkout, before any install or build) | runs; the plan log says `N with a closure file git does not track` |
| test on the always-run list, or the list cannot be read | runs (all run, if the list is unreadable) |
| lane result is anything but `success` | nothing recorded |
| push / dispatch runs | the workflow never calls this: the full suite skips nothing |

Tests: `__tests__/filter.test.mjs`, `__tests__/record.test.mjs`, and
`../affected-plan/__tests__/inputs.test.mjs` for the hash; the wiring in
`monorepo-tests.yml` is pinned by `.github/workflows/__tests__/skip-green-wiring.test.mjs`.
