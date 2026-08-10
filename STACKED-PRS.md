# Stacked pull requests

What changes for CI when a change is split into a chain of dependent pull
requests, and how to consume these workflows from one.

> GitHub ships stacked pull requests as a **public preview**, "subject to
> change". Everything here that reads `github.event.pull_request.stack` is
> therefore **opt-in** — nothing in this repo changes behaviour for a consumer
> who does not ask for it, so a change to the preview API cannot break a
> pipeline that never enabled it.

## The one-line version

Every workflow runs on **every** pull request in the stack, as if each targeted
the stack's base. Checks don't need changing to *run*; they need changing to stop
being wrong (`detect-changes`) and to stop being wasteful (deploys, smoke tests).

## What a stack does to a diff — and why `detect-changes` needs telling

Mid-stack, a pull request's base is **the branch below it**, not `main`. The
default diff therefore sees one layer only.

That's right for review ("what did this layer change?") and wrong for selection
("what needs to run?"). A layer changing package B, sitting on a layer that
changed package A, reports only B — so A's suites are skipped even though the
merged result contains both. This fails **open**: the pipeline goes green having
skipped work it should have done.

Pass `stack-aware: true` and the diff is taken against the stack's base instead:

```yaml
changes:
  uses: 12-apps/ci/.github/workflows/detect-changes.yml@v2
  permissions:
    contents: read
    pull-requests: read
  with:
    path-filters: |
      web: ['apps/web/**']
      api: ['services/api/**']
    stack-aware: true
```

No effect off a stack, so it is safe to leave on. On a stacked pull request it
forces a full-history checkout (the base is a raw sha the filter has to resolve
locally), which is the cost of being correct here.

An explicit `base:` still wins, for callers who have already made this decision
themselves.

## Cutting the cost

A four-layer stack is roughly 4× the CI of the equivalent single pull request,
and that is before restacking (below). Two positions are worth spending on:

| Position | Condition |
|---|---|
| **Lowest unmerged** — bottom of what's left, targets the stack base directly | `github.event.pull_request.stack.base.ref == github.event.pull_request.base.ref` |
| **Top** — carries the full set of changes | `github.event.pull_request.stack.position == github.event.pull_request.stack.size` |

Always guard on `github.event.pull_request.stack != null` first; the property is
absent on unstacked pull requests.

Good candidates for gating: preview deploys (`cd.yml`, `deploy-*.yml`) and
`nextjs-prod-smoke.yml`. Deploying a preview per layer builds intermediate states
that were never meant to stand up on their own.

### The trap: a gated *job* can never satisfy a required check

Required status checks are enforced on **every** pull request in the stack,
including mid-stack ones that don't target your default branch. A job skipped by
`if:` reports no status at all — so gating a *required* check by position leaves
those pull requests stuck on "Expected — waiting for status", forever.

GitHub's own examples dodge this by gating **steps**, leaving the job to run and
report. That doesn't transfer here: what's expensive in this repo is a whole
reusable-workflow call, and `jobs.<id>.if` is the only lever on one.

So gate the expensive job, and add an always-running job that reports the
required check:

```yaml
jobs:
  deploy-preview:
    if: >-
      github.event.pull_request.stack == null ||
      github.event.pull_request.stack.position == github.event.pull_request.stack.size
    uses: 12-apps/ci/.github/workflows/deploy-cloudflare.yml@v2
    secrets: inherit

  # THIS is the name to mark required in branch protection — never the job above.
  # It runs unconditionally, so every layer reports a status; it fails only if a
  # gated job actually failed. `skipped` is a pass: not running was the point.
  preview-gate:
    needs: [deploy-preview]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: |
          if [ "${{ needs.deploy-preview.result }}" = "failure" ] \
          || [ "${{ needs.deploy-preview.result }}" = "cancelled" ]; then
            echo "deploy-preview: ${{ needs.deploy-preview.result }}"
            exit 1
          fi
          echo "deploy-preview: ${{ needs.deploy-preview.result }} — OK"
```

Note the `stack == null ||` in the gate: without it the job stops running on
ordinary unstacked pull requests too.

## Restacking is the real multiplier

`gh stack push` force-pushes with `--force-with-lease`, and `gh stack sync` /
`gh stack rebase` cascade-rebase every branch above the one you touched. Each
restack fires `synchronize` on **every** open pull request in the stack. The
multiplier is layers × restacks, not layers.

The caller-side concurrency this repo already recommends is what contains it:

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name != 'push' }}
```

Keyed on `github.ref`, so layers never cancel each other, and a superseded run of
*the same* layer is dropped. Keep it.

## What needs no change

- **`commitlint.yml`** walks `base..head`. Mid-stack that base is the layer
  below, so it lints exactly the new commits and doesn't re-lint reviewed ones.
  Correct as-is.
- **`release-version.yml` / `release-major-tag.yml`** walk the full commit range
  rather than reading the head commit. Merging a stack lands several commits at
  once, and both still produce one correct result. A head-commit-only
  implementation would not have.

## Before you turn it on

- **Merging needs the asynchronous merge API.** "The legacy pull request merge
  endpoints can't merge a stack." Audit anything that merges pull requests
  programmatically — an automerge bot, a release script — before adopting.
- **Merge queue**, if you use one: `gh stack merge` enqueues the stack rather
  than merging directly.
- The CLI exits `9` when stacked pull requests aren't enabled for the repo.

## Reference

- [About stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)
- [Optimizing CI for stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests)
- [Roll out stacked pull requests to your organization](https://docs.github.com/en/pull-requests/tutorials/roll-out-stacked-prs)
