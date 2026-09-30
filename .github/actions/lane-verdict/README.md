# `lane-verdict` — skip a job this exact tree already passed

The tests lanes size their matrix at zero when the test-relevant tree is
byte-identical to one an earlier PASSING run covered (`*-fingerprint-command`
in `monorepo-tests.yml`). Every other lane of a same-commit re-run — a draft
flipping ready, a `reopened`, a hand re-run, about three a day measured on
future-pay — still paid Lint, Type Check, Build and the repository gates in
full. This action brings the same evidence to a single job.

## Shape

```yaml
- uses: actions/checkout@v4
- name: Look up a recorded lane verdict
  id: lane-verdict
  if: ${{ inputs.lint-fingerprint-command != '' && github.event_name == 'pull_request' }}
  uses: 12-apps/ci/.github/actions/lane-verdict@v2
  with:
    lane: lint
    fingerprint-command: ${{ inputs.lint-fingerprint-command }}
    key-material: |
      node=${{ inputs.node-version }}
      pnpm turbo run lint --affected
# … every later step: if: ${{ steps.lane-verdict.outputs.hit != 'true' }} …
- name: Record the lane verdict
  if: ${{ success() && steps.lane-verdict.outputs.key != '' && steps.lane-verdict.outputs.hit != 'true' }}
  uses: 12-apps/ci/.github/actions/lane-verdict@v2
  with:
    mode: record
    lane: lint
    key: ${{ steps.lane-verdict.outputs.key }}
```

- **`lookup`** runs the consumer's fingerprint command (a hash of every tracked
  path that can change the lane's outcome — the consumer knows which), keys it
  as `<lane>-lane-<key16>-<fingerprint>` where `<key16>` folds in
  `key-material` (how the lane RUNS: Node version, pre-command, command — they
  live in a workflow file the fingerprint ignores, so without them editing the
  command would inherit the old command's verdict), and probes the Actions
  cache with `lookup-only`. Output `hit` is `true` only when an entry exists.
- **`record`** writes a marker naming the run and saves it under the key. The
  caller gates it on `success()`, so a job that failed records nothing, and
  places it LAST, so nothing runs after the claim.

Wired into `monorepo-static.yml` (`lint-fingerprint-command`,
`type-check-fingerprint-command`), `monorepo-tests.yml`
(`build-fingerprint-command`) and `package-gates.yml` (`fingerprint-command`);
`.github/workflows/__tests__/lane-verdict-jobs.test.mjs` pins the placement.

## What never happens

| situation | outcome |
|---|---|
| push, dispatch, schedule | no lookup: the full run skips nothing |
| no command, command fails, prints no 32–128 hex hash | no key, no lookup — the lane runs, the job does not fail |
| lane's Node version or command changed | different key — miss |
| a step of the job failed | `success()` is false — nothing recorded |
| the lookup hit | nothing recorded (nothing new to say) |

A hit skips the install too, so the job's cost is a checkout and a cache probe.
The job still reports `success`, and its dependents run as they would after a
real pass — which is the point, and also the claim: only a run that passed
every step ever writes the key.
