# Consuming the CD framework

A repo opts in by adding one caller workflow plus the per-repo config the engine
discovers. Everything vendor-specific (descriptors, compose files, secrets,
feature flags) stays in the consumer; the pipeline logic lives in `12-apps/ci`.

## 1. One-time org access (done once per `12-apps/ci`)

The `12-apps/ci` repo must allow other org repos to use its reusable workflows
and actions: **Settings → Actions → General → Access → "Accessible from
repositories in the 12-apps organization"** (or via API,
`PUT /repos/12-apps/ci/actions/permissions/access` `{ "access_level": "organization" }`).

## 2. Caller workflow — `.github/workflows/cd.yml`

```yaml
name: CD
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      target:
        type: choice
        default: all
        options: [all, digitalocean, cloudflare]
      action:
        type: choice
        default: deploy
        options: [deploy, provision, destroy]

# The reusable workflow can never exceed these — grant the union it needs.
permissions:
  contents: read
  actions: write     # Cloudflare adapter dispatches post-cd
  packages: write    # build-images pushes to GHCR

jobs:
  cd:
    uses: 12-apps/ci/.github/workflows/cd.yml@v1
    with:
      target: ${{ inputs.target || 'all' }}
      action: ${{ inputs.action || 'deploy' }}
    secrets: inherit
```

## 3. Per-app descriptor — `apps/<app>/deploy/config.json`

```jsonc
{
  "name": "web",
  "targets": [
    { "provider": "digitalocean",
      "build": { "type": "container", "image": "web", "dockerfile": "apps/web/Dockerfile",
                 "target": "runner", "cache": "web", "role": "runner" } }
  ]
}
```

`build.type` is `container` (→ GHCR image, DigitalOcean), `static` (→ Cloudflare
Pages), or `worker` (→ Cloudflare Workers; a bare `wrangler.toml` is
auto-discovered too). See `.github/deploy/README.md` for the full schema.

## 4. Supporting files (per build type)

- **container / DigitalOcean:** `docker-compose.yml` referencing
  `${IMAGE_NAMESPACE}-<svc>:${IMAGE_TAG}`, plus the Dockerfiles.
- **static / worker:** the build command + `outputPath`, or a `wrangler.toml`.

## 5. Variables & secrets (consumer repo)

| Kind | Name | When |
|------|------|------|
| Variable | `ENABLE_DEPLOY_DIGITALOCEAN` = `true` | enable the DO target |
| Variable | `ENABLE_DEPLOY_CLOUDFLARE` = `true` | enable the CF target |
| Variable | `DEPLOY_HOST` | DO droplet IPv4, set after first provision |
| Secret | `DO_API_TOKEN`, `DO_SSH_PRIVATE_KEY_B64` | DigitalOcean |
| Secret | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional app OAuth |
| Secret | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Cloudflare |

Flags default OFF — until a vendor is enabled, the pipeline builds artifacts but
deploys nothing.

---

# Consuming the Monorepo CI pipeline

The fail-fast CI core for pnpm + turborepo monorepos, split in two reusable
workflows so consumers keep the fail-fast topology around their own jobs:

- **`monorepo-static.yml`** — changes paths-filter, `turbo lint/check-types
  --affected` with cross-run `.turbo` caches, actionlint. Exposes `code` /
  `workflows` outputs.
- **`monorepo-tests.yml`** — unit tests (turbo cache + vitest results-cache
  persistence for failed-first/slowest-first ordering + fail-fast bail), build,
  opt-in integration lane.

On `push` events both run the FULL suite (all filters forced true, no
`--affected`, no bail) — the post-merge safety net that makes PR-time
incremental selection safe to trust. Trigger the caller on **both**
`pull_request` and `push: [main]`.

## A. Caller workflow (consumer `ci.yml`)

```yaml
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

# Reusable workflows cannot define workflow-level concurrency — the CALLER must:
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name != 'push' }}

permissions:
  contents: read
  pull-requests: read

jobs:
  # Consumer-side filters for repo-specific gating (e.g. run integration only
  # when the integration-relevant surface changed). Force outputs 'true' on
  # push so the safety net skips nothing. Omit this job entirely (and the
  # `run-integration` line below) if you don't need repo-specific filters.
  changes:
    runs-on: ubuntu-latest
    outputs:
      integration: ${{ github.event_name == 'push' && 'true' || steps.filter.outputs.integration }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        if: github.event_name == 'pull_request'
        with:
          filters: |
            integration:
              - 'apps/web/**'
              - 'packages/**'
              - 'pnpm-lock.yaml'

  static:
    permissions:
      contents: read
      pull-requests: read   # dorny/paths-filter reads the PR's file list
    uses: 12-apps/ci/.github/workflows/monorepo-static.yml@v1
    with:
      # e.g. Prisma: the generated client lives in node_modules, outside any
      # turbo output — regenerate before type-checking.
      pre-typecheck-command: pnpm --filter @repo/shared-helpers prisma:generate

  tests:
    # `changes` must be in needs for `needs.changes.outputs.integration` below
    # to resolve — without it the expression is empty and run-integration is
    # silently always false.
    needs: [changes, static]
    if: needs.static.outputs.code == 'true'
    permissions:
      contents: read
    uses: 12-apps/ci/.github/workflows/monorepo-tests.yml@v1
    with:
      pre-test-command: pnpm --filter @repo/shared-helpers prisma:generate
      pre-build-command: pnpm --filter @repo/shared-helpers prisma:generate
      pre-integration-command: pnpm --filter @repo/shared-helpers prisma:generate
      # File-level affected selection (optional — default is turbo-affected):
      unit-test-command: CI_AFFECTED_BASE=FETCH_HEAD node scripts/ci-affected-tests.mjs
      unit-full-command: CI_FULL_SUITE=1 node scripts/ci-affected-tests.mjs
      vitest-cache-paths: |
        apps/web/node_modules/.vite/vitest
        packages/ui/node_modules/.vite/vitest
      run-integration: ${{ needs.changes.outputs.integration == 'true' }}
      integration-cache-path: node_modules/.vite/vitest

  # Repo-specific jobs gate on the static tier the same way `tests` does:
  my-repo-gate:
    needs: static
    if: needs.static.outputs.code == 'true'
    ...

  # Required-checks aggregation: require ONLY this job in the branch ruleset.
  ci-success:
    if: always()
    # `changes` MUST be listed even though every other job depends on it: if it
    # FAILS (e.g. the paths-filter action errors), its dependents go `skipped`
    # — not `failure` — and an aggregation that only watches the dependents
    # would pass with zero tests run. Listing it surfaces the failure here.
    needs: [changes, static, tests, my-repo-gate]
    runs-on: ubuntu-latest
    steps:
      - env:
          RESULTS: ${{ join(needs.*.result, ' ') }}
        run: |
          set -euo pipefail
          echo "job results: $RESULTS"
          if printf '%s' "$RESULTS" | grep -qwE 'failure|cancelled'; then exit 1; fi
```

## B. Required in the consumer repo

- **Per-package turbo `outputs`** — the cross-run `.turbo` cache restores only
  what each package's `turbo.json` declares. A wrong/absent `outputs` (e.g. a
  library inheriting a Next-style `.next/**`) means a cache hit that restores
  NOTHING and breaks downstream builds. Give every buildable library its own
  `turbo.json` with `build.outputs: ["dist/**"]`.
- **Generated-into-node_modules artifacts** (Prisma clients etc.) can never be
  turbo outputs — regenerate them via the `pre-*-command` inputs.
- Optional file-level unit selection: copy `scripts/ci-affected-tests.mjs`
  from `future-pay` (supports `CI_AFFECTED_BASE`, `CI_FULL_SUITE`, `CI_BAIL`).
- Keep repo-specific filters (e.g. an `integration` or `mcp` paths filter) in
  a small consumer-side `changes` job and feed them in via `with:`.

# Consuming the Quality gate

Separate from CD: a reusable static-quality + test-reliability gate
(`quality.yml`). It runs in the CALLER's checkout, so it uses the consumer's own
config and scripts — the workflow only orchestrates.

## A. Caller job (add to your CI workflow)

```yaml
  quality:
    needs: changes            # optional: gate on a paths-filter change-detector
    if: needs.changes.outputs.code == 'true'
    # Least-privilege: the quality gate only reads the repo. Grant exactly this
    # so a combined CI file's broader grants (packages/actions write) don't leak
    # in. (The reusable workflow also caps itself at contents:read, so this is
    # belt-and-suspenders — but keep it explicit for reviewers.)
    permissions:
      contents: read
    uses: 12-apps/ci/.github/workflows/quality.yml@v1
    with:
      # Command run before the e2e reliability gate (build shared pkgs, etc.).
      pre-e2e-command: pnpm --filter @repo/shared-helpers build
    secrets: inherit
```

Inputs (all optional): `node-version` (default `24`), `run-knip` (default true,
blocking via the consumer's shrink-only ratchet), `run-data-views` (default
**false** — opt-in DataViews backend-only gate, needs a `quality:data-views`
script + shrink-only exceptions file in the consumer), `run-e2e-reliability` (default true), `run-affected-e2e` (default
**false** — opt-in selective e2e), `pre-e2e-command`, `install-playwright`
(default true), `e2e-repeat` (default `3`), `nextjs-app-dirs` (default empty —
opt-in loading-coverage gate), `loading-must-render` (default empty),
`e2e-coverage-app-dirs` (default empty — opt-in e2e page↔spec coverage gate),
`e2e-coverage-spec-suffix` (default `.e2e.ts`), `e2e-coverage-exempt-globs`
(default `.journey.,.global.`), `e2e-coverage-exceptions` (default
`.e2e-coverage-exceptions.json`), `e2e-coverage-page-file` (default
`^page\.(js|jsx|ts|tsx)$` — the route-page marker regex; a Vite/React-Router SPA
keyed on `src/pages/<route>/index.tsx` passes `^index\.tsx$`),
`e2e-content-app-dirs` (default empty — opt-in e2e content-quality gate),
`e2e-content-spec-suffix` (default `.e2e.ts`), `e2e-content-exempt-globs`
(default `.journey.,.global.`), `e2e-content-min-assertions` (default `2`),
`e2e-content-exceptions` (default `.e2e-content-exceptions.json`).

### Next.js loading-coverage gate (opt-in)

In the App Router, a route segment shipping a `page.*` without a `loading.*`
renders NOTHING while the segment streams (prod) or compiles on demand (dev).
Point `nextjs-app-dirs` at your App Router root(s) and every `page.*` must have
a sibling `loading.*`; optionally set `loading-must-render` to a shared spinner
component name so an empty placeholder can't satisfy the gate. Needs no scripts
or install in the consumer — the gate only walks the checkout.

```yaml
    with:
      nextjs-app-dirs: apps/web/app
      loading-must-render: RouteLoading
```

### E2E page↔spec coverage gate (opt-in)

Ties e2e specs to pages by **co-location**: every route segment shipping a
`page.*` must have a co-located e2e spec (default suffix `*.e2e.ts`) somewhere in
its subtree, and every such spec must sit under a route segment (so no spec
floats free). Cross-cutting specs that don't belong to one page — journeys and
globals — are exempt via `e2e-coverage-exempt-globs` (default `.journey.`,
`.global.`).

Pages with no spec yet are grandfathered in a **shrink-only** JSON array
(`e2e-coverage-exceptions`, default `.e2e-coverage-exceptions.json`, a list of
route-segment dirs). The ratchet enforces the same policy as `.quality-exceptions`:

- **shrink-only** — the list may only lose entries; a *new* page can never be
  grandfathered (add its spec instead);
- **touch-must-fix** — if a PR changes any file under a still-listed segment
  (a rename or delete counts), that segment must be de-listed, i.e. get a spec;
- the gate also rejects a **stale** entry — one that is no longer a page, or that
  already has a spec — so the list stays honest and keeps shrinking.

Needs no scripts or install — the gate walks the checkout and diffs the
exceptions file against the base branch (`fetch-depth: 0`).

```yaml
    with:
      e2e-coverage-app-dirs: apps/web/app
      e2e-coverage-exceptions: apps/web/.e2e-coverage-exceptions.json
      # optional overrides:
      # e2e-coverage-spec-suffix: '.e2e.ts'
      # e2e-coverage-exempt-globs: '.journey.,.global.'
```

The affected-selection side (running only the specs a diff touches) is separate:
enable `run-affected-e2e` and provide a `test:e2e:affected` selector in the
consumer — with co-located specs the selector maps by directory, no manifest.

### E2E content-quality gate (opt-in)

The companion to the coverage gate. Coverage proves a spec **file** exists per
page; this proves the spec actually **exercises** the page instead of being a
`goto` + `toBeVisible` render smoke test. Point `e2e-content-app-dirs` at the
same root(s) and every non-exempt spec (default suffix `*.e2e.ts`) must:

1. perform **≥1 interaction** — `click` / `fill` / `press` / `selectOption` /
   `check` / `type` / `setInputFiles` / … (a nav-only spec has none);
2. carry **≥1 behavioral assertion** — a matcher other than the render-only
   `toBeVisible` / `toBeAttached` / `toBeInViewport` family. A positive
   `toBeHidden()` (asserting an element is absent — empty state, filtered out,
   gated) or a negated visibility check like `.not.toBeVisible()` both prove a
   state/transition and **count as behavioral**;
3. have **≥1 assertion after an interaction, within the same test** — the
   strongest cheap signal that the spec verifies a *state change*, not just the
   initial render (the check is per-`test()` block, so an action in one test
   can't borrow an assertion from another);
4. meet the **`e2e-content-min-assertions`** floor (default `2`).

Weak specs are grandfathered in a **shrink-only** JSON array
(`e2e-content-exceptions`, default `.e2e-content-exceptions.json`, a list of spec
file paths) with the same ratchet as the coverage gate — the list may only
shrink, and touching a listed spec forces it to be de-listed (i.e. strengthened).
Needs no scripts or install — pure static analysis of the spec source.

**This is a heuristic, not proof.** It stops *lazy* specs, not *adversarial*
ones: a spec author (or agent) told "you need an interaction and an assertion
after it" can satisfy the letter without testing anything meaningful. The
non-gameable measure is runtime coverage (instrument the e2e build, threshold
per page); treat this gate as the cheap first layer that raises the floor.

```yaml
    with:
      e2e-content-app-dirs: apps/web/app
      e2e-content-exceptions: apps/web/.e2e-content-exceptions.json
      # optional overrides:
      # e2e-content-spec-suffix: '.e2e.ts'
      # e2e-content-exempt-globs: '.journey.,.global.'
      # e2e-content-min-assertions: 2
```

## B. Required in the consumer repo

`package.json` scripts:

| Script | Purpose |
|--------|---------|
| `quality:complexity` | `eslint --config eslint.complexity.config.mjs .` (size/complexity/nested-loop/cognitive on source — also good on pre-commit) |
| `quality:dup` | `jscpd …` copy-paste detection |
| `quality:quarantine` | `node scripts/flaky-quarantine-check.mjs` |
| `quality:knip` | `node scripts/knip-gate.mjs` — knip behind a shrink-only ratchet (`.knip-exceptions.json`); fails only on NEW dead code |
| `quality:data-views` | `node scripts/data-views-gate.mjs` — DataViews backend-only ratchet (shrink-only exceptions file) — only if `run-data-views: true` |
| `test:e2e:reliability` | `node scripts/e2e-reliability.mjs` (re-run changed specs Nx) |
| `test:e2e:affected` | `node scripts/e2e-affected.mjs` (run only diff-affected specs) — only if `run-affected-e2e: true` |

Plus these files (copy from any consumer, e.g. `future-pay`):
`eslint.complexity.config.mjs`,
`eslint.quality.shared.mjs` (shared thresholds/ignores/globs/rule sets),
`.quality-exceptions` (per-repo grandfather list), `knip.json`,
`flaky-quarantine.json`, `scripts/e2e-reliability.mjs`,
`scripts/flaky-quarantine-check.mjs`, `tests/e2e/reporters/flaky-test-reporter.ts`,
and the devDeps `eslint-plugin-sonarjs`, `jscpd`, `knip`.

The flakiness gate is **not** in this list on purpose — its ruleset, runner, and
eslint toolchain are centralized (see below), so a consumer carries neither
`eslint.flakiness.config.mjs` nor `eslint-plugin-test-flakiness`.
For selective e2e (`run-affected-e2e: true`) also copy `scripts/e2e-affected.mjs`
and add your own `e2e-affected.json` (the per-repo source-path → spec map).

Failed-first ordering: the `e2e-affected` job persists Playwright's
`test-results/.last-run.json` across runs (per-ref cache, saved even on
failure). A consumer's `test:e2e:affected` selector can use it to run a quick
`playwright test --last-failed` phase before the affected set and bail early
when a previous failure still fails — see `future-pay`'s `e2e-affected.mjs`.
Selectors that ignore the file are unaffected. The cached path assumes
Playwright's default `outputDir` (`test-results/`, resolved from the repo
root); a consumer that overrides `outputDir` writes `.last-run.json` elsewhere
and gets no cross-run cache — keep the default (or symlink) to opt in.

Per-repo (NOT shared): `.quality-exceptions` (grandfathered offenders), the
jscpd `--threshold` baseline, and `e2e-affected.json` (feature→spec map).
Everything else is portable.

### Flakiness gate (central — no per-repo config)

The anti-flake ESLint gate is the one part of the quality suite that is fully
centralized: the tiered ruleset (`eslint.flakiness.config.mjs`), the baseline
runner, and the eslint + `eslint-plugin-test-flakiness` toolchain all live in
`12-apps/ci/.github/actions/flakiness-lint`. The `Flakiness` job pulls them from
there and lints **your** checkout, so updating the rules in `12-apps/ci` reaches
every repo on its next CI run — you never copy or bump the config or the plugin.

The consumer owns exactly one repo-specific artifact: `eslint-suppressions.json`,
the per-violation baseline of pre-existing offenders (native ESLint bulk
suppressions). It is stripped per-file on every run — any test file your PR
touches loses its exemption and must be fully clean. Seed it once:

```bash
# from your repo root, using the central config (no local devDeps needed):
npx --package eslint@9 --package eslint-plugin-test-flakiness@1 \
  --package @typescript-eslint/eslint-plugin@8 --package @typescript-eslint/parser@8 \
  --package globals@16 -- \
  eslint --config <path-to>/eslint.flakiness.config.mjs apps packages \
  --suppress-all --suppressions-location eslint-suppressions.json
```

Then commit `eslint-suppressions.json` and burn it down over time. Do **not**
copy the config into your repo — that would re-fork the ruleset you just
centralized.

**Targets & opt-out.** By default the gate lints `.` (works for single- and
multi-package repos). Pass `flakiness-targets: 'apps packages'` to the reusable
workflow to scope it. A repo not yet migrated can keep its own
`quality:flakiness` script — while that script exists the job runs it (legacy
path) instead of the central action, so migration is: delete the script + the
config, keep `eslint-suppressions.json`.

### `.quality-exceptions` ratchet (automatic)

The **Quality Exceptions Ratchet** job enforces the burn-down with no consumer
script — it runs whenever the repo has a `.quality-exceptions` file:

- **Shrink-only:** a PR may only REMOVE lines from `.quality-exceptions`, never
  add them. You cannot grandfather a new file — fix its issues instead.
- **Touch-must-fix:** if a PR changes a file that is still listed, the line must
  be removed in the same PR. Removing it makes the complexity/flakiness gate
  turn that file's findings into hard errors, so touching a grandfathered file
  forces it to be cleaned up.

Make this check required in branch protection (`Quality (reusable) / Quality
Exceptions Ratchet`) so the burn-down cannot be bypassed.

---

# Consuming the MCP contract gate

Separate again: a reusable gate (`mcp-contract.yml`) that keeps a repo's MCP tool
surface honest against its own HTTP endpoints. It runs in the CALLER's checkout
and only orchestrates — the app owns generation/validation behind three scripts.

The pattern it enforces: every app exposes its endpoints as an MCP server by
**generating one tool per operation from an OpenAPI spec** (produced from runtime
Zod schemas), and the MCP server is an **auth-proxy** that forwards each tool call
to the real endpoint carrying the caller's bearer token — so an agent gets exactly
the user's permissions, and authz stays in the endpoints. This gate guarantees the
generated surface never drifts from the endpoint surface.

## A. Caller job (add to your CI workflow)

```yaml
  mcp-contract:
    needs: changes            # optional: gate on a paths-filter change-detector
    if: needs.changes.outputs.code == 'true'
    # Least-privilege on two axes (see the notes below): a read-only token, and
    # NO inherited secrets.
    permissions:
      contents: read
      # packages: read   # add ONLY if pnpm install pulls private GitHub Packages
    uses: 12-apps/ci/.github/workflows/mcp-contract.yml@v1
    with:
      # Build the MCP package / render the OpenAPI before the gate runs.
      pre-command: pnpm --filter @repo/mcp build
    # NOTE: intentionally no `secrets: inherit` — this gate needs no secrets.
```

**Secrets — pass none.** Do **not** add `secrets: inherit` to this caller. Every
job runs consumer-controlled code (dependency install, `pre-command`, and the
`mcp:*` scripts), so any inherited secret could be read by a compromised
dependency or script. `permissions` scopes only the `GITHUB_TOKEN`, **not** env
secrets — withholding `secrets: inherit` is the distinct control that protects
them. Design the scripts to run **offline**: generate the OpenAPI, diff the
manifest, and lint with no live DB or real credentials. If `mcp:parity` needs
configuration, pass non-secret test values as plain `env:` on the job.

**Private packages.** If your `pnpm install` pulls **private GitHub Packages**,
you need *both* the permission *and* the registry auth wiring — and both are
covered:

1. Grant `packages: read` in the caller (commented in the snippet above).
   Otherwise the permissions intersection strips package access and installs
   401/403 before any check runs.
2. Set the `github-packages-scope` input to your scope. Each job then writes
   `~/.npmrc` pointing that scope at `npm.pkg.github.com` and authenticates with
   the job's own `GITHUB_TOKEN` **before** install — so no `.npmrc` or token
   setup is required in your repo, and no user secret is involved.

   ```yaml
   with:
     github-packages-scope: '@my-org'
   ```

Granting `packages: read` **without** setting the scope (or committing your own
`.npmrc`) still 401/403s — the permission alone does not configure the registry.

Prefer to wire it yourself? Commit an `.npmrc` in your repo mapping the scope to
`npm.pkg.github.com` with `${NODE_AUTH_TOKEN}` interpolation; it is used as-is and
you can leave `github-packages-scope` unset. **Cross-org** private packages are
not readable by the job `GITHUB_TOKEN` — those require a PAT, which (being a user
secret) must go through your own `.npmrc` wiring, not this input. Public-only
consumers set neither and are unaffected.

Inputs (all optional): `node-version` (default `24`), `run-drift` (default true),
`run-lint` (default true), `run-parity` (default **false** — opt-in in-process
served-schema parity), `pre-command`, `github-packages-scope` (default empty —
see Private packages below).

## B. Required in the consumer repo

`package.json` scripts:

| Script | Purpose |
|--------|---------|
| `mcp:check` | Regenerate the MCP tool manifest from the app's OpenAPI and **exit non-zero on drift** (typically: regenerate to a temp path, then `git diff --exit-code` the committed manifest). The load-bearing gate. |
| `mcp:lint` | Static lint of the exposed surface — no secret-bearing fields leak into tool schemas, every tool has an input schema, write tools are classified. Fails on violation. |
| `mcp:coverage` | Route/action coverage: every HTTP route the app serves must be registered on the MCP surface (or sit on a documented infra allowlist), and every server action/RPC must map to a registered operation or carry a reviewed exclusion. This is what makes the surface **complete**, not just non-drifting — without it a new endpoint ships silently outside the agent contract. The job is on by default but only runs when the script exists (skips with a notice otherwise), so adoption is per-repo: define the script and the gate arms itself. For a staged rollout — or to silence even the skip notice — callers can opt out explicitly with `run-coverage: false` (mirrors `run-parity`). |
| `mcp:parity` | (only if `run-parity: true`) Boot the MCP server in-process against the rendered OpenAPI and diff served tool schemas vs the manifest. |

Plus a committed source-of-truth pair the scripts operate on: the rendered
**OpenAPI** document and the **generated MCP tool manifest** (both regenerated by
`@repo/mcp` from the app's Zod-schema'd routes). Drift between endpoint schemas and
the manifest is exactly what `mcp:check` catches.

# Consuming the RBAC coverage gate

The access-control sibling of the MCP contract gate: a reusable gate
(`rbac-coverage.yml`) that keeps a repo's **authorization** surface complete. It
runs in the CALLER's checkout and only orchestrates — the app owns the coverage
logic behind one script.

The pattern it enforces: every access-controlled surface the app ships — each
guarded route/handler and each permission-bearing server action — either maps to
a **declared permission** in the RBAC model, or sits on a **reviewed exclusions
allowlist** (e.g. `rbac-exclusions.json`) with a reason. It's the RBAC analogue of
`mcp:coverage`: where that keeps the agent surface complete, this stops a new
endpoint silently shipping OUTSIDE the permission model (unguarded, or guarded by
an unregistered permission).

## A. Caller job (add to your CI workflow)

```yaml
  rbac-coverage:
    needs: changes            # optional: gate on a paths-filter change-detector
    if: needs.changes.outputs.code == 'true'
    # Least-privilege on two axes (see the MCP notes above): a read-only token,
    # and NO inherited secrets.
    permissions:
      contents: read
      # packages: read   # add ONLY if pnpm install pulls private GitHub Packages
    uses: 12-apps/ci/.github/workflows/rbac-coverage.yml@v1
    with:
      # Build the RBAC package before the gate runs, if it needs one.
      pre-command: pnpm --filter @repo/rbac build
    # NOTE: intentionally no `secrets: inherit` — this gate needs no secrets.
```

**Secrets — pass none.** Same rule and rationale as the MCP gate: every job runs
consumer-controlled code, so withhold `secrets: inherit`; `permissions` scopes
only the `GITHUB_TOKEN`, not env secrets. `rbac:coverage` is a **static** analysis
of the route/action surface vs the permission registry — design it to run offline
(no live DB or real credentials).

**Private packages.** Identical wiring to the MCP gate — grant `packages: read`
and set `github-packages-scope: '@my-org'` (see that section above). Public-only
consumers set neither.

Inputs (all optional): `node-version` (default `24`), `run-coverage` (default
true — self-skips with a notice until the consumer defines the script; set
`false` to opt out explicitly), `pre-command`, `github-packages-scope` (default
empty — see the MCP Private-packages section).

## B. Required in the consumer repo

`package.json` script:

| Script | Purpose |
|--------|---------|
| `rbac:coverage` | Enumerate the guarded routes/handlers + permission-bearing server actions and **exit non-zero** if any is neither mapped to a declared permission nor carried on the reviewed exclusions allowlist. On by default but only runs when the script exists (skips with a notice otherwise), so adoption is per-repo: define the script and the gate arms itself. |

Plus the committed source-of-truth the script operates on: the **permission
registry** (the app's declared permissions) and a **reviewed exclusions file**
(e.g. `rbac-exclusions.json`) — the consumer owns this file and its shrink policy.

## 6. First DigitalOcean provision

Run the caller via **workflow_dispatch** with `action=provision`,
`target=digitalocean`. It creates the droplet and prints its IP; set the
`DEPLOY_HOST` repo Variable to that IP so subsequent push-to-main runs deploy to
it.
