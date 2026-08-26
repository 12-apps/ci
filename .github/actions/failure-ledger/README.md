# `failure-ledger`

Record what a failing run broke; answer, from a bare checkout, whether the next
push has anything worth replaying first.

Every selector in a CI pipeline answers *what could this diff have broken?*
Nothing answers the cheaper question a **fix push** actually asks — *is the
thing that was broken last time still broken?* — even though the failing run
computed that answer in full and then threw it away.

## The two modes

| mode | runs in | does |
|---|---|---|
| `record` | your final aggregate job, on a red run | reads the run's failed jobs, scrapes their logs for test files, writes + publishes the `ci-failure-ledger` artifact |
| `probe` | `monorepo-static.yml`'s retry gate, before any toolchain | finds the previous failed run's ledger, drops what this checkout no longer has, reports `any` |

The gate itself is `monorepo-static.yml` — see **Replaying last run's failures
first** in `CONSUMING.md`. This action is the two ends it plugs into.

## The asymmetry that makes it safe

**Which lane** failed comes from the jobs API — the job's name, and the name of
the step whose conclusion is `failure`. Structured data the platform maintains.

**Which files** failed comes from scraping the job log, which is unavoidably a
guess about a runner's output format. So it may only ever **narrow**: a lane
whose files cannot be extracted is recorded under `unreplayable` rather than
replayed whole.

That asymmetry is what makes a log-scraped input acceptable here when it would
be indefensible in a test selector. The gate this feeds **can only ever fail
earlier, never green** — the real lanes still run in full behind it — so a
stale, partial or mis-scraped ledger costs seconds, not coverage.

Two consequences worth knowing before editing:

- **The log tail is not where the failure is.** Post-job cleanup writes ~20
  lines of git plumbing after the last step, and a step that fails midway is
  followed by every later step's output. The whole log is scanned and the
  failing step read from the API.
- **A per-workspace runner prints package-relative paths.** A sharded vitest
  lane runs with the package as cwd, so it prints `lib/x/__tests__/y.test.ts` —
  meaningless from the repo root where the replay runs. Those are re-anchored
  onto the workspace the runner last announced (`workspace-marker`). Getting it
  wrong is safe — the probe's existence check drops the path — but it is what
  makes those lanes replayable at all.

## Why the job-name table is here and not in the consumer

`Tests / Unit Tests`, `Tests / Integration Tests`, `Quality / E2E Reliability`
and `Quality / E2E (affected only)` are names **this repo's workflows produce**.
A consumer holding a copy would be holding a hand-copied list of strings it does
not own: rename a job here and every consumer's ledger silently empties — no red
run, just a feature that stopped working.

So the table lives beside the workflows that emit the names, and a consumer
declares only the jobs **it** defines, through `extra-lanes`.

## What the consumer still owns

How to invoke its own runners. The probe hands `retry-gate-command` a ledger
already narrowed to surviving, non-quarantined files; the consumer decides which
of those its lanes can run and runs them — through the same code path the real
lane uses, so a replay that passes where the lane fails cannot happen.

## Scope

Only lanes whose failures **name files** are replayable. A gate lane fails as a
whole, and replaying one would need a table mapping CI step names to package
scripts — a hand-copied list that rots silently toward pointing at the wrong
command, which is the exact failure this design refuses elsewhere. Gate failures
are still recorded under `unreplayable`, so the artifact tells a human
everything a thirty-job run knew without opening thirty logs.

## Tests

`__tests__/ledger.test.mjs` is the one that matters most, and its fixtures are
real runner output quoted from consumer runs rather than output invented to
match the regexes. A detector that stopped recognising a format records an empty
ledger, the next run stands down politely, and nothing is red at any point.

`__tests__/probe.test.mjs` pins the other direction: every way of being unsure
stands down. Both run in `self-test.yml`.
