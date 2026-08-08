# 12-apps/ci

Shared, generic, vendor-pluggable **CD framework** consumed by any repo in the
org via a ~10-line caller workflow. Extracted from `12-apps/future-pay` so the
engine lives in one place and improvements ship to every consumer at once.

## What's here

| Path | Purpose |
|------|---------|
| `.github/workflows/cd.yml` | Reusable CD orchestrator (`workflow_call`): discover → build/reuse → flag-gated per-vendor deploy. |
| `.github/workflows/deploy-digitalocean.yml` | Reusable DigitalOcean adapter (provision / deploy / destroy). |
| `.github/workflows/deploy-cloudflare.yml` | Reusable Cloudflare adapter (Workers + Pages, fanned out from discovery). |
| `.github/workflows/quality.yml` | Reusable static-quality + test-reliability gate (`workflow_call`). |
| `.github/workflows/mcp-contract.yml` | Reusable MCP-surface contract gate (`workflow_call`): drift + surface-lint + optional in-process parity. |
| `.github/workflows/detect-changes.yml` | Reusable path-based change detection (`workflow_call`): caller-declared categories → per-category booleans for job `if:`. |
| `.github/workflows/cost-report.yml` | Reusable CI cost estimator (`workflow_call`): sums every run on the PR and keeps one PR comment up to date. |
| `.github/actions/discover` | Composite action wrapping the discovery engine (ships `discover.sh` to consumers). |
| `.github/actions/select-images` | Composite action wrapping the image-reuse planner (ships `select-images.sh`). |
| `.github/actions/do-provision` | Composite action wrapping the droplet cloud-init bootstrap. |
| `scripts/deploy/` | Discovery engine (`discover.sh`), image-reuse planner (`select-images.sh`), `lib/common.sh`. |
| `scripts/ephemeral/` | DigitalOcean droplet tooling (cloud-init, create/destroy helpers). |
| `.github/deploy/` | Descriptor + vendor-manifest JSON schemas and the contract README. |

## How it works

The reusable workflows run **in the caller's checkout**, so per-app descriptors
(`apps/*/deploy/config.json`) and the GHCR image namespace (derived from
`github.repository`) resolve to the consuming repo — nothing is hardcoded to
`future-pay`. The engine *scripts* ship from this repo through composite actions
(`uses: 12-apps/ci/.github/actions/discover@v1`), which is the only way a
consumer's job token can run private-repo scripts without a dedicated PAT.

## Use it from ANY organization

This repo is **public**, so its reusable workflows are callable from any repo in
any organization with no access configuration at all:

```yaml
uses: 12-apps/ci/.github/workflows/<file>.yml@v2
```

The org-access setting in [CONSUMING.md](./CONSUMING.md) §1 applies only to the
*private* consumption path (`12-apps/ci` as an internal repo); while it stays
public, nothing needs to be granted. Reusable workflows run in the **caller's**
checkout with the **caller's** `GITHUB_TOKEN`, so the only thing crossing the
repo boundary is the workflow definition itself.

## Cost & smart execution

Two reusable workflows that answer "what is this pipeline costing us?" and
"which of it did this diff actually need?". Both are fully generic — every
repo-specific value is an input.

### 1. Concurrency (yours to add — no workflow can do this for you)

A reusable workflow **cannot** declare `concurrency`; only the top-level caller
can. Without it, every push to a PR leaves its predecessor running to completion
and you pay for verdicts nobody will read. Add this to your own workflow:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

One caveat worth knowing before you copy it verbatim. If you also run the
workflow on `push: [main]` as a post-merge full-suite safety net, that snippet
lets a burst of merges cancel each other: GitHub keeps only **one pending run per
group**, and a newer arrival cancels the older *pending* one — so intermediate
merge verdicts vanish and you lose the ability to tell which merge broke the
suite. Key push runs by SHA to give every merge its own group:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name == 'push' && github.sha || github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name != 'push' }}
```

### 2. `detect-changes.yml` — skip what the diff can't affect

The caller declares its own categories; this workflow knows nothing about any
repo's layout.

```yaml
  changes:
    uses: 12-apps/ci/.github/workflows/detect-changes.yml@v2
    with:
      # YAML (top-level names UNINDENTED, at column 0) or JSON.
      path-filters: |
        web:
          - 'apps/web/**'
        api:
          - 'services/api/**'
        docs:
          - '**/*.md'
      # Post-merge safety net: report every category true so the full suite runs
      # on main. Incremental PR-time selection is only safe to trust when
      # something still runs everything.
      force-all: ${{ github.event_name == 'push' }}
```

Outputs: `changes` (JSON object of category → **JSON boolean**), `matched` (JSON
array of the names that matched), `any` (`'true'`/`'false'`). Use whichever
reads better:

```yaml
  unit-tests:
    needs: changes
    if: fromJSON(needs.changes.outputs.changes).web
  e2e:
    needs: changes
    if: contains(fromJSON(needs.changes.outputs.matched), 'web')
```

Every **declared** category always gets a key. That matters: a job `if:` reading
a key that does not exist gets `null`, which is falsy — the job would skip
silently and forever. A category name that never appears in `path-filters` is
therefore a typo you want to find, and it fails loudly at the source.

#### When NOT to use this

If your repo already calls `monorepo-static.yml`, declare the categories through
its **`extra-filters`** input instead of adding this job. That tier already runs
a Detect Changes job, and GitHub bills **every job that starts, rounded up to a
whole minute** — so a second detector does ~6s of work for a full billed minute
on every PR push and every merge. `future-pay` shipped exactly that regression
and removed it (FUT-468); don't re-add it. This workflow is for repos with no
static tier, or callers that need change detection independent of one.

### 3. `cost-report.yml` — one always-current PR comment

```yaml
  cost-report:
    # `always()` so the estimate is posted even when a gate failed — a red run
    # still costs money, and that is exactly when you want to see it.
    if: always() && github.event_name == 'pull_request'
    needs: [changes, unit-tests, e2e]   # list the heavy jobs: run LAST
    permissions:
      pull-requests: write   # find-or-create the comment
      actions: read          # GET /actions/runs/{id}/timing
    uses: 12-apps/ci/.github/workflows/cost-report.yml@v2
    secrets: inherit
```

`secrets: inherit` is all it needs — the job's own `GITHUB_TOKEN` does both API
calls, so **no PAT and no custom secret**. The two `permissions` above are
required at the caller: a reusable workflow's effective grant is the
*intersection* with its caller's, so omitting either yields a 403 rather than a
wrong number.

What it does on every run: reads
`GET /repos/{owner}/{repo}/actions/runs/{run_id}/timing` for **every** workflow
run tied to the PR, sums them, and find-or-creates the single comment carrying
`comment-marker`, editing it in place from then on. The total is **always
recomputed from the API** — never parsed back out of the previous comment — so
reruns, force-pushes and cancelled runs cannot make it drift.

Minutes are billed **per job, rounded up to the whole minute**, which is how
GitHub charges and why the report counts them that way: 26 jobs of 10s each bill
26 minutes, not 5. Wall-clock is shown alongside so the gap is visible.

Inputs (all optional): `runner-rates` (JSON map, default
`{"linux":0.006,"linux_arm":0.005,"windows":0.01,"macos":0.062}` — GitHub's
public 2-core rates; override for larger runners or another plan),
`comment-marker` (default `<!-- ci-cost-report -->`), `title`, `max-run-pages`.
Outputs: `billed-minutes`, `cost`.

On a **public** repository the comment says so and labels the figures as gross
minutes — public repos are not billed for GitHub-hosted runners, and a dollar
figure with no "this is free" caveat is how a reviewer ends up expecting a
billing change that will never appear.

### Full wiring, end to end

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  changes:
    uses: 12-apps/ci/.github/workflows/detect-changes.yml@v2
    with:
      path-filters: |
        web:
          - 'apps/web/**'
        docs:
          - '**/*.md'
      force-all: ${{ github.event_name == 'push' }}

  test:
    needs: changes
    if: fromJSON(needs.changes.outputs.changes).web
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "the diff touched apps/web"

  cost-report:
    if: always() && github.event_name == 'pull_request'
    needs: [changes, test]
    permissions:
      pull-requests: write
      actions: read
    uses: 12-apps/ci/.github/workflows/cost-report.yml@v2
    secrets: inherit
```

## Versioning

Consumers pin the moving major tag `@v1`. Backwards-compatible changes move
`v1`; a breaking change cuts `v2`.

`v2` is an **additive** line: it carries everything `v1` has plus the cost and
change-detection workflows above. Nothing in `v1` changed behaviour, so existing
`@v1` consumers are unaffected and need not migrate.

`v1` moves **automatically**: `.github/workflows/release-major-tag.yml` re-points
it to every push on `main` — no manual force-push. Commits marked breaking
(conventional `type!:` / `type(scope)!:` subject, or a `BREAKING CHANGE:` footer)
are skipped, so a breaking change never auto-ships to `@v1`; cut `v2` by hand for
those.

## Use it

See **[CONSUMING.md](./CONSUMING.md)**.
