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
  with:
    fetch-depth: 0
- uses: actions/setup-node@v4
  with:
    node-version: ${{ inputs.node-version }}
- uses: 12-apps/ci/.github/actions/fetch-base@v2
  id: base
  if: ${{ github.event_name == 'pull_request' }}
- name: Look up a recorded lane verdict
  id: lane-verdict
  if: ${{ inputs.lint-fingerprint-command != '' && github.event_name == 'pull_request' && steps.base.outputs.merge-base != '' }}
  uses: 12-apps/ci/.github/actions/lane-verdict@v2
  with:
    lane: lint
    fingerprint-command: ${{ inputs.lint-fingerprint-command }}
    key-material: |
      node=${{ inputs.node-version }}
      base=${{ steps.base.outputs.base-sha }}
      merge-base=${{ steps.base.outputs.merge-base }}
      pnpm turbo run lint --affected
# … every later step: if: ${{ steps.lane-verdict.outputs.hit != 'true' }} …
# The lint step MUST use this same base as TURBO_SCM_BASE (TURBO_SCM_HEAD=HEAD).
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
  as `<lane>-lane-ci-verdict-v2-<key16>-<fingerprint>` where `<key16>` folds in
  `key-material` (how the lane RUNS: base/merge-base, Node version, pre-command, command — they
  live in a workflow file the fingerprint ignores, so without them editing the
  command would inherit the old command's verdict), and probes the Actions
  cache with `lookup-only`. Output `hit` is `true` only when an entry exists.
  Fingerprint shell commands use `bash -e -o pipefail`: a failed producer piped
  into a successful hash command disables the lookup, as does an early failed
  command. Intentional shell error handling (`command || fallback`) still works.
  Known digests of empty input (MD5, SHA-1, SHA-256 and SHA-512) are also
  refused by value, including uppercase output, as defense in depth when a
  consumer has masked its own producer error.
- **`record`** writes a marker naming the run and saves it under the key. The
  caller gates it on `success()`, so a job that failed records nothing, and
  places it LAST, so nothing runs after the claim.
- **`identity`** emits `execution-identity` for the test-lane/per-test caches.
  Empty means identity resolution failed; those callers must not restore or
  record a verdict. This mode does not run a fingerprint or probe the cache.

## Implementation, runtime and selection identity

The explicit `ci-verdict-v2` era invalidates all pre-fix keys. Every key also
hashes the downloaded central `.github/actions` and `.github/workflows` sources
relative to this action, not the consumer checkout. Updating a moving `@v2`
action therefore invalidates an old pass even if the consumer tree is unchanged.
The consumer's committed `.github/workflows` blobs are included too. Commit/run
IDs are not: a docs-only commit with unchanged execution inputs can still reuse
evidence.

Actual Node version, platform/architecture, and available runner/image identity
are included. The four bundled jobs resolve Node before lookup, and execute with
that same exact version; pnpm, dependency-cache restoration and install still wait
for a miss. Custom callers must similarly resolve the runtime before lookup.
This is not a hermetic-environment attestation: external services, untracked
inputs and mutable software outside these sources remain the caller's concern.

An affected lane must resolve and key its effective immutable base AND merge base
before lookup, then execute against that same base. An unknown base disables
reuse. The bundled jobs handle ordinary and stack-aware PRs this way; the MCP
ratchet also receives the immutable base it keyed, rather than fetching a moving
branch again after lookup. A retargeted PR can widen selection without changing
the tree, so tree identity alone is insufficient evidence.

Wired into `monorepo-static.yml` (`lint-fingerprint-command`,
`type-check-fingerprint-command`), `monorepo-tests.yml`
(`build-fingerprint-command`) and `package-gates.yml` (`fingerprint-command`);
`.github/workflows/__tests__/lane-verdict-jobs.test.mjs` pins the placement.

## What never happens

| situation | outcome |
|---|---|
| push, dispatch, schedule | no lookup: the full run skips nothing |
| no command, command fails, prints no 32–128 hex hash | no key, no lookup — the lane runs, the job does not fail |
| lane's base, implementation, runtime or command changed | different key — miss |
| implementation/runtime identity cannot be read | no key — the lane runs |
| a step of the job failed | `success()` is false — nothing recorded |
| the lookup hit | nothing recorded (nothing new to say) |

A hit skips the install too. Compared with the original checkout/probe-only hit,
resolving the actual Node patch and selection base adds startup work; this cost
has not yet been measured on hosted or self-hosted Actions runners.
The job still reports `success`, and its dependents run as they would after a
real pass — which is the point, and also the claim: only a run that passed
every step ever writes the key.
