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
   on it. So does every migration, for a test the consumer's `database` block
   names as a migration reader, carrier or always-run file, and every schema
   file for a schema reader (the 2026-09-30 audit, F1).
   A global that is itself a **module** — a setup file, a vitest config, the
   runner script — brings its own transitive import closure along (F3b); a
   module global the graph cannot reach, or whose closure is blind, withholds
   EVERY hash of the lane. And a change to a global that nothing routes plans
   the **full** suite (F3a): selection walks imports, and nothing imports a
   setup file. The manifest names the construction its hashes came from
   (`inputs: <inputsVersion>`); a wider construction retires older manifests
   rather than matching them.
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
| a manifest whose hashes were made with another `inputsVersion` (a narrower construction) | nothing skipped — old proofs are retired, not trusted |
| plan without `inputs` (lane did not opt in), plan not `narrowed` | nothing skipped |
| test with `null` inputs (unresolved import in its closure) | runs |
| test whose closure reaches a file git does not track (a workspace package's built `dist/` present at plan time wins over its `src/` — plan on a CLEAN checkout, before any install or build) | runs; the plan log says `N with a closure file git does not track` |
| test on the always-run list, or the list cannot be read | runs (all run, if the list is unreadable) |
| lane result is anything but `success` | nothing recorded |
| push / dispatch runs | the workflow never calls this: the full suite skips nothing |

Tests: `__tests__/filter.test.mjs`, `__tests__/record.test.mjs`, and
`../affected-plan/__tests__/inputs.test.mjs` for the hash; the wiring in
`monorepo-tests.yml` is pinned by `.github/workflows/__tests__/skip-green-wiring.test.mjs`.
