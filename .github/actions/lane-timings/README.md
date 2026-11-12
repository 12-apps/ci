# lane-timings

Size every test lane that expands a matrix by **measured time**, and keep the
measurements fresh with the daily full run.

Before this action each lane counted its way to a leg count: `ceil(files / 40)`
for unit and integration, `ceil(specs / 26)` for SPA E2E, `ceil(features / 4)`
for Gherkin. That gave two slow features one leg however long they took, and
the two lanes that packed by cost read ledgers somebody refreshed by hand
(future-pay's integration ledger knew 219 of its 842 files).

## The rule

A leg runs about `target-seconds` of **test step** time: 600 s, the top of the
owner's 8–10 minute target.

```
legs = clamp(ceil(Σ ledger seconds of the selection / concurrency / target), min-shards, max-shards)
```

- An item the ledger does not know costs the ledger's mean, never zero, so a
  new file never piles onto one leg. An empty or corrupt ledger is an even split.
- `concurrency` is measured, not configured: the summed per-item seconds the
  legs reported over the wall time of their test steps (vitest's pool runs
  files side by side; Playwright on one worker is about 1).
- `max-shards` is a cap, not a target. A selection that wants more legs gets
  the cap, a `binding` output and a warning: legs run past the target, and
  the cap is the thing to raise.
- The items are dealt longest-first onto the lightest leg (LPT), which is
  deterministic, so the plan job can compute it once and every leg runs its
  own list: `legs[i - 1]` in the rewritten plan.

## `size` — in the plan job

After the selection and any skip-green filter, before the matrix:

```yaml
- id: legs
  uses: 12-apps/ci/.github/actions/lane-timings@v2
  with:
    mode: size
    lane: gherkin
    plan: bdd-plan.json
    items-key: features
    ledger: .lane-timings/gherkin.json
    max-shards: '12'
    empty-shards: '1'   # this lane starts even with nothing selected (a gate)
# matrix: ${{ fromJson(steps.legs.outputs.shards) }}
```

The plan is rewritten in place with `legs`, `timings` (the estimate, each
leg's expected seconds, the unknown items, the largest one) and, where the
plan already has them, `counts.shardTotal`, `shardTotal` and `shards`. A
`full` plan (nothing enumerated) is left alone.

## `leg` — in each leg, before its tests

```yaml
- id: leg
  uses: 12-apps/ci/.github/actions/lane-timings@v2
  with:
    mode: leg
    lane: gherkin
    plan: bdd-plan.json
    items-key: features
    leg: ${{ matrix.shard }}
    out: leg.txt
# then run exactly the files in ${{ steps.leg.outputs.file }}, one per line
```

It writes the items `size` dealt to this leg, after checking that the legs
cover the plan's list exactly once and that the plan was sized for as many
legs as it carries. Anything else fails the leg: a leg that fell back to a
split of its own could drop files while every leg reports green.
`when-sized: 'true'` lets a plan that was never sized (no ledger, a `none`
plan) through with no file, so the runner splits as it always did.
`monorepo-tests.yml` runs it for unit and integration and hands the file to
the caller's command as `LANE_LEG_FILE`.

## `refresh` — in the daily full run

Use the reusable workflow, as the last job of the run, after every test lane:

```yaml
lane-timings:
  needs: [tests, spa-e2e, bdd-journeys]
  if: ${{ always() && <this is the daily full run> }}
  uses: 12-apps/ci/.github/workflows/lane-timings-refresh.yml@v2
  with:
    title: 'chore(ci): refresh the lane timings (FUT-xxxx)'
  secrets:
    PR_TOKEN: ${{ secrets.<a PAT> }}
```

`run-id` measures another run instead (a backfill, or a probe of the
refresh itself). It downloads every leg's reports from **this run's** artifacts, reads every
leg's test-step time from the Actions API, rewrites each ledger, and lands the
change as an auto-merged PR (the `post-merge-regen` prepare/land halves, under
the `chore/lane-timings-` prefix).

Each measured item takes **today's** cost. An item the run did not measure
(its leg was lost) keeps its cost while the file exists, and a deleted item is
dropped. A re-run attempt of the same leg keeps the longer number.

Every run writes, to the job summary and as annotations:

- **slow files** — any single item past `slowFileSeconds` (default 180 s):
  a file with too many tests to split, or a feature that got slow;
- **slow legs** — any leg whose test step ran past the target;
- **caps too small** — a lane whose full-width run wants more legs than its cap.

## The consumer's config — `.lane-timings.json`

```json
{
  "targetSeconds": 600,
  "slowFileSeconds": 180,
  "lanes": {
    "unit": {
      "ledger": ".lane-timings/unit.json", "maxShards": 6,
      "artifacts": "^unit-junit-a\\d+-s\\d+$", "files": "\\.(xml|durations\\.json)$",
      "format": "junit", "junitRoot": "reports/",
      "job": "^Tests / Unit Tests", "step": "Run unit tests"
    },
    "gherkin": {
      "ledger": ".lane-timings/gherkin.json", "maxShards": 12,
      "artifacts": "^bdd-journeys-report-s\\d+$", "files": "(^|/)spec-durations\\.json$",
      "format": "durations-json",
      "rewrite": [{ "pattern": "^\\.features-gen/[^/]+/(.+)\\.spec\\.js$", "replace": "$1" }],
      "job": "^Gherkin Journeys", "step": "Run the affected Gherkin journeys"
    }
  }
}
```

| key | meaning |
|---|---|
| `artifacts` | regex over this run's artifact names; a trailing `-s<n>` names the leg |
| `files` | regex over paths inside each artifact |
| `format` | `junit` (vitest: one `<testsuite>` per file) or `durations-json` (`{ item: seconds }`). In a `junit` lane, a matched `.json` file is read as `durations-json`, and an item both name costs the larger: vitest's `<testsuite time>` is the test phase only, so a lane whose files spend their time importing ships a per-file durations JSON beside the XML (E-012) |
| `junitRoot` | a junit report under `<pkg>/<junitRoot>…` names files relative to `<pkg>`; empty for root-relative reports |
| `rewrite` | regex rewrites from a report's key to the plan's item; parts of one item are summed |
| `job`, `step` | the legs' job names (`· shard <n>/<m>`) and their test step, for concurrency and slow legs |
| `maxShards` | the lane's cap, for the cap warning |

A new lane (load tests, say) is a new entry here plus a `size` step in its
plan job: nothing in this action changes.

## The ledger — `.lane-timings/<lane>.json`

```json
{ "version": "lane-timings-v1", "lane": "gherkin", "unit": "seconds", "concurrency": 0.93,
  "measured": { "run": "<url>", "sha": "<sha>", "at": "<iso>" },
  "files": { "tests/e2e/features/admin/cozinha-fluxos-expedicao.feature": 144.2 } }
```

Generated: never edit it by hand. The old hand-made shapes
(`{ "files": { path: ms } }` with `"unit": "ms"`) are read too, so a consumer
can switch before its first refresh lands.

## Tests

```bash
node --test .github/actions/lane-timings/__tests__/*.test.mjs
```
