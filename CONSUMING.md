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
  packages: write    # build-images pushes to GHCR; reuse-images retags in it

jobs:
  cd:
    uses: 12-apps/ci/.github/workflows/cd.yml@v1
    with:
      target: ${{ inputs.target || 'all' }}
      action: ${{ inputs.action || 'deploy' }}
    secrets: inherit
```

### Image reuse on merge (nothing to configure)

`cd.yml` rebuilds only the container images a commit actually affects and
**retags** the rest from the previous commit's manifest, so the deploy still finds
every `<ref>:<sha>` tag it pulls. Affectedness comes from `turbo ls --affected`
between `github.event.before` and `github.sha`, mapped to images by the
descriptor's *directory* — see `.github/deploy/README.md` for the details and the
`turbo --affected`-on-push trap this deliberately avoids.

On by default; it needs nothing from the consumer beyond what a turborepo already
has. A repo with no `turbo.json`, no descriptors, or a range the planner cannot
resolve just rebuilds everything — the planner fails open on every ambiguity and
logs which path it took and why.

To force a full rebuild of every image (re-seeding the registry, or ruling out a
selection bug):

```yaml
    with:
      reuse_unaffected_images: false
```

#### Root-level build inputs (`global_build_inputs`)

One case needs naming because turbo cannot see it. turbo attributes a change to
the package that **contains** it, so a **root-level** file belongs to no package
and a root-only commit reports *zero* affected packages. For `.github/**` and
`scripts/**` that is correct, and it is the saving. For a root file that is in the
Docker build context it is not: if your Dockerfiles `COPY . .` into a
`turbo prune` stage — the shape this framework expects — then `.npmrc`,
`patches/**` and friends *are* in every image's context. An `.npmrc`-only commit
would otherwise retag every image and the new `.npmrc` would never reach a build:
green CD, green deploy, green post-CD smoke tests, all running the previous
commit's binaries under the new sha.

The planner therefore fails open on a change to any **global build input**, with a
`::notice::` naming the file. The default list needs nothing from you:

```
.npmrc pnpm-lock.yaml pnpm-workspace.yaml turbo.json turbo.jsonc package.json patches/
```

Extend it if your repo has other root-level files in the build context (a root
`Makefile`, a `docker/` directory, a shared `tsconfig.base.json`, …):

```yaml
    with:
      global_build_inputs: >-
        .npmrc pnpm-lock.yaml pnpm-workspace.yaml turbo.json turbo.jsonc
        package.json patches/ tsconfig.base.json docker/
```

A trailing `/` is a root-anchored directory prefix; anything else is an exact
root-relative path — so a nested `packages/foo/package.json` does **not** trigger
it (turbo already attributes that to its own package). A value **replaces** the
default rather than adding to it, which is why the example repeats the default
entries. Entries are whitespace-separated, and a literal block scalar (`|`, one
line per group) is honoured in full exactly like the folded `>-` above — newlines
count as separators, not terminators. An empty or whitespace-only value falls back
to the default with a `::warning::` — the gate cannot be switched off by emptying
the list. The effective entry list is echoed as a `::notice::` on **every** run,
fired or not, so a narrowed or mistyped list is visible in the log.

**Also worth doing on your side:** declare `globalDependencies` in your own
`turbo.json` for the same files. That is the more complete fix — it corrects
affectedness for *every* turbo consumer (`turbo run`, remote cache, your own CI
filters), not just this planner. It is deliberately *not* what the gate above
relies on: that would put this engine's safety in a file the engine neither owns
nor can verify, and a consumer that never sets it would get silent staleness with
no warning. Doing both is fine — correct `globalDependencies` just makes the gate
fire redundantly at worst.

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

### Optional: fixture reset on every deploy (`demo-seed`)

A repo that keeps disposable demo/e2e fixture data on the deployed environment
can have it rebuilt on every deploy. Define a one-shot `demo-seed` service in
the compose file — same shape as `migrate`, under `profiles: [tools]` so a plain
`up` never fires it:

```yaml
  demo-seed:
    image: ${IMAGE_NAMESPACE}-migrate:${IMAGE_TAG}
    profiles: [tools]
    environment:
      - DATABASE_URL=...
    command: ["pnpm", "demo:reset"]
```

The DigitalOcean adapter runs it **after** `docker compose up`, so a failing
seed can never strand the deploy with the old containers still serving. It is
**non-fatal but loud**: a failure emits a `::error::` annotation rather than
failing a deployment that is already live and healthy.

Purely opt-in — the adapter asks the compose file whether the service exists, so
a repo without one skips it silently. Anything destructive the reset does is the
consumer's concern; the engine only invokes it.

### Optional: zero-downtime rollout (`scripts/deploy/rollout.sh`)

By default the DigitalOcean adapter brings a deploy live with:

```bash
docker compose up -d --no-build --force-recreate --remove-orphans
```

That recreates **every** service in the compose file, not only the ones whose
image moved — the database, the background worker and the reverse proxy
included. While the proxy container is gone nothing is listening on :80/:443,
so clients get connection refused rather than an error they could retry
through, and every app container additionally waits for the data tier to come
back healthy. The gap is the sum of all of that.

A repo that wants a gapless deploy ships an **executable**
`scripts/deploy/rollout.sh`; the adapter runs it in place of the line above,
still under `doppler run` so the compose environment is identical:

```bash
if [ -x scripts/deploy/rollout.sh ]; then
  doppler run -- bash scripts/deploy/rollout.sh
else
  doppler run -- docker compose up -d --no-build --force-recreate --remove-orphans
fi
```

The engine hands over completely at that point — it does not tell the script
what to roll or how. What it expects back is only an exit code: **non-zero
fails the deploy**, so a script that cannot get the new images live must say so
rather than exit 0 with the old ones still serving.

A working implementation to copy is `scripts/deploy/rollout.sh` in
`12-apps/future-pay`. The shape that matters:

- leave `postgres`/`redis` alone unless their compose definition changed
  (`up -d` **without** `--force-recreate` already has exactly that semantics);
- for each service that serves traffic, `up -d --no-recreate --scale <svc>=2`
  so the successor starts alongside its predecessor, wait for the new container
  to report **healthy**, then stop and remove the old one — which requires the
  service to have a `healthcheck:` and to have **no `container_name:`** (a
  fixed name caps the service at one container);
- hot-reload the edge proxy instead of recreating it;
- on a container that never goes healthy, remove the new one and leave the old
  one serving — the deploy fails with the previous version still up.

Purely opt-in, and unchanged for every repo without the file. Note this needs
enough free memory on the box to run two copies of the largest rolled service
at once; the future-pay implementation measures that at deploy time and falls
back to in-place replacement per service rather than risking the OOM killer.

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

- **`monorepo-static.yml`** — changes paths-filter (yours included, via
  `extra-filters`), `turbo lint/check-types --affected` with cross-run `.turbo`
  caches, actionlint. Exposes `code` / `workflows` / `matched` / `scripts`
  outputs.
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
  static:
    permissions:
      contents: read
      pull-requests: read   # dorny/paths-filter reads the PR's file list
    uses: 12-apps/ci/.github/workflows/monorepo-static.yml@v1
    with:
      # e.g. Prisma: the generated client lives in node_modules, outside any
      # turbo output — regenerate before type-checking.
      pre-typecheck-command: pnpm --filter @repo/shared-helpers prisma:generate
      # Repo-specific filters go HERE, not in a consumer-side `changes` job of
      # your own: a second Detect Changes job does ~6s of work and bills a
      # whole minute on every PR push and every merge (FUT-468). Raw YAML,
      # UNINDENTED — each filter name at column 0. Results come back in
      # `matched`; on push it lists every declared name, so the full-suite
      # safety net still skips nothing.
      extra-filters: |
        integration:
          - 'apps/web/**'
          - 'packages/**'
          - 'pnpm-lock.yaml'
      # Optional: "does the repo define this script?" — a question a job-level
      # `if:` cannot answer (it is evaluated before any checkout exists).
      # Answered here for free and read back via the `scripts` output.
      probe-scripts: |
        test:smoke

  tests:
    needs: static
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
      run-integration: ${{ contains(fromJSON(needs.static.outputs.matched), 'integration') }}
      integration-cache-path: node_modules/.vite/vitest

  # Repo-specific jobs gate on the static tier the same way `tests` does, and
  # read their own filters out of `matched`:
  my-repo-gate:
    needs: static
    if: needs.static.outputs.code == 'true' && contains(fromJSON(needs.static.outputs.matched), 'integration')
    ...

  # Required-checks aggregation: require ONLY this job in the branch ruleset.
  ci-success:
    if: always()
    # `static` MUST be listed even though every other job depends on it: if it
    # FAILS (e.g. the paths-filter action errors), its dependents go `skipped`
    # — not `failure` — and an aggregation that only watches the dependents
    # would pass with zero tests run. Listing it surfaces the failure here.
    needs: [static, tests, my-repo-gate]
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
- Pass repo-specific filters (e.g. an `integration` or `mcp` paths filter)
  through `extra-filters` — **do not** add a consumer-side `changes` job. Two
  Detect Changes jobs back to back is the exact regression FUT-468 removed: the
  second one did ~6s of work and cost a full billed minute on every PR push and
  every merge. Two consequences to know before you move a filter in:
  - a lane that previously needed only your own fast `changes` job now needs
    `static`, and **a reusable workflow's outputs are not available until the
    WHOLE called workflow finishes** — so that lane starts behind Lint and Type
    Check (~85s in rather than ~6s), and is *skipped* if the static tier fails.
    Cheaper and more fail-fast, but it is a behaviour change.
  - `extra-filters` must be UNINDENTED. An indented block declares no filter
    names, and the job fails loudly instead of quietly dropping those names from
    `matched` on push.

# Consuming the Quality gate

Separate from CD: a reusable static-quality + test-reliability gate
(`quality.yml`). It runs in the CALLER's checkout, so it uses the consumer's own
config and scripts — the workflow only orchestrates.

## A. Caller job (add to your CI workflow)

```yaml
  quality:
    needs: static             # optional: gate on the static tier's change-detector
    if: needs.static.outputs.code == 'true'
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

**Shape (one runner for four gates).** `drift`, `lint`, `coverage` and `parity`
run as sequential STEPS of a single `MCP Contract Gates` job — one checkout, one
`pnpm install --frozen-lockfile`, one `pre-command` — not four jobs each
repeating that setup. Every gate step is guarded by `!cancelled() &&
steps.install.outcome == 'success' && steps.pre.outcome != 'failure'` plus its
own toggle. That means:

- **A failing gate does not hide the gates after it** — one run reports the whole
  inventory, and the job ends failed if any gate failed.
- **A failed install or a failed `pre-command` skips all four gates.** The
  `pre-command` usually builds something the `mcp:*` scripts import, so without
  this the job would report the real error once and then four identical
  `Cannot find module …` failures on top of it.
- The `pre-command` term is `!= 'failure'`, **not** `== 'success'`, because a
  caller that passes no `pre-command` leaves that step *skipped* — `== 'success'`
  would silently skip every gate and report green.

`store-compliance` stays a separate job on purpose: it reads the committed
manifest and needs neither the install nor the `pre-command`. The whole
`MCP Contract Gates` job is skipped when `run-drift`, `run-lint`, `run-coverage`
and `run-parity` are all false; and when `run-coverage` is the *only* one of the
four that is on and your repo has no `mcp:coverage` script, the job still starts
but skips the pnpm/Node setup, the install and the `pre-command` — see the
`mcp:coverage` row of the script table in **B. Required in the consumer repo**
below for exactly what that does and does not save.

Consequence for branch rules: the per-gate check runs (`MCP Drift`, `MCP Lint`,
`MCP Coverage`, `MCP Parity`) no longer exist — they are steps inside `MCP
Contract Gates`. Prefer requiring your own aggregation job (the `ci-success`
pattern in the *Consuming the Monorepo CI pipeline* section above) rather than
this workflow's internal job names, which are not part of the contract and may
be renamed or merged again. Note this is a preference, not a doc-wide rule: two
other sections here — the `.quality-exceptions` ratchet and the MCP test-coverage
gate — do tell you to require a reusable workflow's check by name. If you follow
that style for this gate, the only names that exist are `MCP Contract Gates` and
`MCP Store Compliance`.

## A. Caller job (add to your CI workflow)

```yaml
  mcp-contract:
    needs: static             # optional: gate on the static tier's change-detector
    if: needs.static.outputs.code == 'true'
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
2. Set the `github-packages-scope` input to your scope. The gate job then writes
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
`run-lint` (default true), `run-coverage` (default true — self-skips until the
`mcp:coverage` script exists), `run-parity` (default **false** — opt-in
in-process served-schema parity), `run-store-compliance` (default true),
`manifest-path`, `store-exceptions-path`, `pre-command`,
`github-packages-scope` (default empty — see Private packages below).

## B. Required in the consumer repo

`package.json` scripts:

| Script | Purpose |
|--------|---------|
| `mcp:check` | Regenerate the MCP tool manifest from the app's OpenAPI and **exit non-zero on drift** (typically: regenerate to a temp path, then `git diff --exit-code` the committed manifest). The load-bearing gate. |
| `mcp:lint` | Static lint of the exposed surface — no secret-bearing fields leak into tool schemas, every tool has an input schema, write tools are classified. Fails on violation. |
| `mcp:coverage` | Route/action coverage: every HTTP route the app serves must be registered on the MCP surface (or sit on a documented infra allowlist), and every server action/RPC must map to a registered operation or carry a reviewed exclusion. This is what makes the surface **complete**, not just non-drifting — without it a new endpoint ships silently outside the agent contract. The gate is on by default but only runs when the script exists (skips with a notice otherwise), so adoption is per-repo: define the script and the gate arms itself. What that skip costs, precisely: the probe runs before the pnpm/Node setup, so if `run-coverage` is the **only** enabled gate in `MCP Contract Gates` and the script is absent, the job skips the setup, the `pnpm install` and the `pre-command`, and costs one runner + one checkout + the probe. If any of `run-drift` / `run-lint` / `run-parity` is also on — the default — the install and `pre-command` run regardless, because those gates need them; the probe then saves only the coverage script's own runtime, not the setup. For a staged rollout — or to silence even the skip notice — callers can opt out explicitly with `run-coverage: false` (mirrors `run-parity`). |
| `mcp:parity` | (only if `run-parity: true`) Boot the MCP server in-process against the rendered OpenAPI and diff served tool schemas vs the manifest. |

## The store-compliance floor (no consumer script)

One gate in this workflow needs **nothing from the consumer** and cannot be
weakened by it: `store-compliance` reads the committed MCP manifest directly and
holds it to the rules the assistant directories enforce at review time. The
ruleset lives in `12-apps/ci/.github/actions/mcp-store-compliance`, so tightening
it here tightens every org repo on its next CI run.

It fails a manifest when any tool:

- lacks a human-readable `annotations.title`, or one of the three boolean hints
  (`readOnlyHint`, `openWorldHint`, `destructiveHint`) — the Anthropic directory
  requires the title and derives auto-permissions from the hints, and the Apps
  SDK guidelines list missing annotations as a frequent rejection;
- claims both `readOnlyHint` and `destructiveHint`;
- has a name longer than 64 characters, or no description;
- has a description that steers the model (ignore-previous, system-prompt
  references, "you must call…", discouraging other tools, encoded blobs);
- **accepts** a payment-card, government-identifier, credential, or
  precise-location field; or
- **returns** one without redacting it. `outputSchema` is advertisement only —
  most dispatchers forward the upstream body verbatim — so a narrowed response
  schema is not enough. The gate clears the field only when the tool declares it
  in `redactResponse`, i.e. when the server actually strips it.

Field names are matched word-wise after a camelCase split, deliberately
fail-closed: `verificationToken` and `api_key` are flagged, `tokenization` is
not. A false positive costs one documented line; a missed credential costs a
rejection or a leak.

Declare genuine exceptions per repo in `mcp-store-exceptions.json`, each with a
reason (`_`-prefixed keys are treated as comments). Entries that match no served
tool fail as stale:

```json
{
  "listStoreDomains": {
    "output": ["data.domains.verificationToken"],
    "reason": "DNS TXT ownership proof; grants no access and the operator must read it."
  }
}
```

Repos with no MCP manifest at `manifest-path` skip the job with a notice, so
this is safe on the floating `@v1` tag. Point it elsewhere with `manifest-path`,
or opt out with `run-store-compliance: false`.

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
    needs: static             # optional: gate on the static tier's change-detector
    if: needs.static.outputs.code == 'true'
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
empty — see the MCP Private-packages section), `package-dir` (default `.` — the
directory whose `package.json` holds the `rbac:coverage` script; point it at a
workspace package, e.g. `apps/web`, if the script lives there).

The self-skip is only for a **valid** manifest that hasn't adopted the script
yet. A `package.json` that is **missing, unreadable, or malformed** at
`package-dir` is a hard **failure** (not a silent skip), so a broken consumer
config surfaces instead of quietly disabling the gate.

## B. Required in the consumer repo

`package.json` script:

| Script | Purpose |
|--------|---------|
| `rbac:coverage` | Enumerate the guarded routes/handlers + permission-bearing server actions and **exit non-zero** if any is neither mapped to a declared permission nor carried on the reviewed exclusions allowlist. On by default but only runs when the script exists (skips with a notice otherwise), so adoption is per-repo: define the script and the gate arms itself. |

Plus the committed source-of-truth the script operates on: the **permission
registry** (the app's declared permissions) and a **reviewed exclusions file**
(e.g. `rbac-exclusions.json`) — the consumer owns this file and its shrink policy.

# Consuming the entitlement-gate coverage gate

The plan-tier sibling of the RBAC gate: a reusable gate
(`entitlements-coverage.yml`) that keeps a repo's **entitlement** surface
complete. It runs in the CALLER's checkout and only orchestrates — the app owns
the coverage logic behind one script.

The pattern it enforces: every routed page the app ships either declares the
**plan feature** that gates it, or sits on a **reviewed exceptions allowlist**
with a reason.

Why it is worth a gate of its own, next to `rbac:coverage`: the two failures look
nothing alike. An unguarded route is a security hole, and it turns up in an
audit. An **ungated page** is a revenue hole and turns up nowhere — the page just
works, the tier meant to unlock it sells nothing, and the omission is
indistinguishable from a deliberate decision. This gate forces the distinction:
"ungated" has to be written down where a reviewer sees it.

## A. Caller job (add to your CI workflow)

```yaml
  entitlements-coverage:
    needs: static             # optional: gate on the static tier's change-detector
    if: needs.static.outputs.code == 'true'
    # Least-privilege on two axes (see the MCP notes above): a read-only token,
    # and NO inherited secrets.
    permissions:
      contents: read
    uses: 12-apps/ci/.github/workflows/entitlements-coverage.yml@v1
    with:
      package-dir: apps/admin   # where entitlements:coverage is defined
      install: false            # the script is plain node with no dependencies
    # NOTE: intentionally no `secrets: inherit` — this gate needs no secrets.
```

**`install: false` is the interesting one.** Write the coverage script as plain
node that reads the route tree and the feature catalog as text, and the gate
costs a checkout plus a node — not a full monorepo install. That is the
difference between a ~20s lane and a multi-minute one, on a check that runs on
every PR. Leave `install` at its default `true` if the script imports anything;
a script that needs deps and runs without them fails loudly on the missing
import rather than silently passing.

**Secrets — pass none.** Same rule and rationale as the MCP and RBAC gates: every
job runs consumer-controlled code, so withhold `secrets: inherit`; `permissions`
scopes only the `GITHUB_TOKEN`, not env secrets. `entitlements:coverage` is a
**static** analysis of the route tree vs the feature catalog — design it to run
offline (no live DB or real credentials).

**Private packages.** Identical wiring to the MCP gate — grant `packages: read`
and set `github-packages-scope: '@my-org'` (see that section above). Ignored when
`install: false`, since nothing is installed. Public-only consumers set neither.

Inputs (all optional): `node-version` (default `24`), `run-coverage` (default
true — self-skips with a notice until the consumer defines the script; set
`false` to opt out explicitly), `install` (default true), `pre-command`,
`github-packages-scope` (default empty), `package-dir` (default `.` — the
directory whose `package.json` holds the `entitlements:coverage` script; point it
at a workspace package, e.g. `apps/admin`, if the script lives there).

The self-skip is only for a **valid** manifest that hasn't adopted the script
yet. A `package.json` that is **missing, unreadable, or malformed** at
`package-dir` is a hard **failure** (not a silent skip), so a broken consumer
config surfaces instead of quietly disabling the gate.

## B. Required in the consumer repo

`package.json` script:

| Script | Purpose |
|--------|---------|
| `entitlements:coverage` | Enumerate the routed pages and **exit non-zero** if any is neither gated by a declared plan feature nor carried on the reviewed exceptions allowlist. On by default but only runs when the script exists (skips with a notice otherwise), so adoption is per-repo: define the script and the gate arms itself. |

Plus the committed source-of-truth the script operates on: the **feature catalog**
(the app's declared plan features) and a **reviewed exceptions file** (e.g.
`entitlement-gate-exceptions.json`) — the consumer owns this file and its shrink
policy. Worth cross-checking in the same pass, since each is a way for the gate
to pass while the product is wrong: a gate naming a feature key the catalog does
not declare (an unknown key typically resolves "not supported", which most
implementations render UNLOCKED), and a navigation entry that advertises a
feature no gated page actually owns.

# Consuming the MCP test-coverage gate

The third MCP sibling: a reusable gate (`mcp-test-coverage.yml`) that keeps a
repo's **served** MCP tool surface **tested**. It runs in the CALLER's checkout
and only orchestrates — the app owns the coverage logic behind one script.

The contract gate proves the surface is complete and internally consistent; it
cannot prove a tool works. A live smoke run can, but it needs a real deployment
and a real token, so it can never be a CI gate. This closes the part CI *can*
answer offline — every served tool has a test — and, more importantly, stops the
debt growing while the rest is being paid down.

**The ratchet is the gate.** The exemptions list is shrink-only and enforced by
the same two rules as the [`.quality-exceptions` ratchet](#quality-exceptions-ratchet-automatic):

- **Shrink-only:** a PR may only REMOVE entries, never add them. You cannot
  grandfather a new tool — write its test instead.
- **Touch-must-fix:** if a PR changes the source behind a still-listed tool, the
  entry must be removed in the same PR — which means the test gets written.

One exception, and only one: on the **adoption PR** — where the exemptions file
does not exist at the merge base — the initial baseline is accepted with a
notice, since otherwise the rule would demand the entire debt be paid before the
ratchet could start. From the next PR onward the file exists at the base and
shrink-only applies with no exception. A file left holding only comments counts
as no file at all, so a repo that reaches full coverage can keep the header
without failing its own gate.

Make this check required in branch protection (`MCP Test Coverage (reusable) /
MCP Test Coverage`) so the burn-down cannot be bypassed.

## A. Caller job (add to your CI workflow)

```yaml
  mcp-test-coverage:
    needs: static             # optional: gate on the static tier's change-detector
    if: needs.static.outputs.code == 'true' && contains(fromJSON(needs.static.outputs.matched), 'mcp')
    # Least-privilege on two axes (see the MCP notes above): a read-only token,
    # and NO inherited secrets.
    permissions:
      contents: read
      # packages: read   # add ONLY if pnpm install pulls private GitHub Packages
    uses: 12-apps/ci/.github/workflows/mcp-test-coverage.yml@v1
    with:
      package-dir: apps/web
      exemptions-file: apps/web/mcp/mcp-test-exemptions
    # NOTE: intentionally no `secrets: inherit` — this gate needs no secrets.
```

**Secrets — pass none.** Same rule and rationale as the other two gates: every
job runs consumer-controlled code, so withhold `secrets: inherit`; `permissions`
scopes only the `GITHUB_TOKEN`, not env secrets. `mcp:test-coverage` is a
**static** analysis of the tool registry vs the test tree — design it to run
offline.

**Private packages.** Identical wiring to the MCP contract gate — grant
`packages: read` and set `github-packages-scope: '@my-org'`. Public-only
consumers set neither.

Inputs (all optional): `node-version` (default `24`), `run-coverage` (default
true — self-skips with a notice until the consumer defines the script; set
`false` to opt out explicitly), `pre-command`, `github-packages-scope`,
`package-dir` (default `.`), and `exemptions-file` (default
`mcp-test-exemptions`, resolved from the repo ROOT — not from `package-dir`).

The ratchet runs on `pull_request` events only, since it needs a base ref to diff
against, and no-ops when the exemptions file is absent — so a repo that reaches
full coverage simply deletes the file. It runs even when the coverage step
FAILED: "the list grew" is usually *why* it failed, and reporting the symptom
while hiding the policy breach would be the wrong way round.

## B. Required in the consumer repo

`package.json` script:

| Script | Purpose |
|--------|---------|
| `mcp:test-coverage` | Enumerate the **served** tools and **exit non-zero** if any is neither tested nor carried on the exemptions list, or if any exemption has gone stale (its tool is now tested, is now withheld, or no longer exists). Called again with `--exempt-files`, print the source file behind each exempt tool — one repo-relative path per line — which is what touch-must-fix diffs against. On by default but only runs when the script exists (skips with a notice otherwise). |

Plus the committed **exemptions file** (one entry per line, `#` comments
ignored). What counts as "tested" is deliberately the consumer's call — this
workflow never looks at a test. Note that tightening that definition later only
moves tools out of `tested`, and the ratchet forbids paying for that with new
entries: a tightened definition must be paid for with tests, in the PR that
tightens it.

# Consuming the Next.js prod-smoke gate

A reusable gate (`nextjs-prod-smoke.yml`) that builds a Next.js app for
**production** and boots the standalone server to prove it actually comes up.

Why it's separate from e2e: Playwright runs against `next dev`, which does not
enforce the production runtime — the RSC server→client serialization boundary,
env validation, or a real standalone boot. So a class of defects passes e2e yet
500s in prod (a server component passing a **function-valued prop** across the RSC
boundary, a missing prod env var, a Prisma client that only inits under dev). This
lane catches that class in CI.

**Honest scope:** only the build+boot **scaffold** is centralized (install →
pre-command → prod build → run a consumer smoke script). WHAT to probe — which
endpoints/pages must 200, how to mint an auth cookie, how to seed a throwaway DB —
is app-specific and stays your `smoke-script` (default `prod:smoke`).

## A. Caller job (add to your CI workflow)

```yaml
  prod-smoke:
    needs: static             # optional: gate on the static tier / a change-detector
    if: needs.static.outputs.code == 'true'
    permissions:
      contents: read
      # packages: read   # add ONLY if pnpm install pulls private GitHub Packages
    uses: 12-apps/ci/.github/workflows/nextjs-prod-smoke.yml@v1
    with:
      pre-command: pnpm --filter @repo/shared-helpers prisma:generate
      build-command: SKIP_ENV_VALIDATION=1 USE_FILE_DB=1 pnpm turbo run build --filter=web
      # smoke-script: prod:smoke     # package.json script to probe + run (default)
    # NOTE: intentionally no `secrets: inherit` — this gate needs no secrets.
```

**Secrets — pass none.** Same rule and rationale as the MCP contract gate (see
above): every job runs consumer-controlled code, so withhold `secrets: inherit`;
`permissions` scopes only the `GITHUB_TOKEN`, not env secrets. The smoke must boot
against a **throwaway** local DB (e.g. PGlite) and a self-minted cookie — no live
DB or real credentials. Bake non-secret build/runtime flags inline in
`build-command` (`SKIP_ENV_VALIDATION=1`, `USE_FILE_DB=1`).

**Private packages.** Identical wiring to the MCP gate — grant `packages: read`
and set `github-packages-scope: '@my-org'`. Public-only consumers set neither.

Inputs (all optional): `node-version` (default `24`), `run-smoke` (default true —
self-skips with a notice until the `smoke-script` exists; set `false` to opt out),
`smoke-script` (default `prod:smoke`), `build-command` (the prod build; empty
skips the build step), `pre-command`, `github-packages-scope`, `package-dir`
(default `.` — the directory whose `package.json` holds the `smoke-script`; point
it at a workspace package, e.g. `apps/web`, if the script lives there).

The self-skip is only for a **valid** manifest that hasn't adopted the script
yet. A `package.json` that is **missing, unreadable, or malformed** at
`package-dir` is a hard **failure** (not a silent skip), so a broken consumer
config surfaces instead of quietly disabling the gate.

## B. Required in the consumer repo

`package.json` script:

| Script | Purpose |
|--------|---------|
| `prod:smoke` (or your `smoke-script` name) | Boot the production build (the `build-command` above produced it) against a throwaway DB, mint any auth cookie it needs, GET the key public + guarded endpoints/pages, and **exit non-zero** if any probe fails or the server logs a serialization/runtime error. Owns the endpoint list, seeding, and boot. Probed for existence; the job self-skips if absent. |

---

# Consuming the cost report & change detection

Two reusable workflows — `cost-report.yml` (one always-current PR comment
estimating the PR's runner-minute spend) and `detect-changes.yml` (caller-declared
path categories → per-category booleans for job `if:`) — plus the concurrency
snippet every caller should own. They are documented in full, with an end-to-end
wiring example, in **[README.md](./README.md#cost--smart-execution)**.

Two things to read before wiring `detect-changes.yml` in:

- If your repo already calls `monorepo-static.yml`, put the categories in its
  `extra-filters` input instead of adding a second detector job — see the
  FUT-468 note in the *Monorepo CI pipeline* section above, which is the same
  billed-minute regression.
- `cost-report.yml` needs `pull-requests: write` and `actions: read` at the
  caller, and `secrets: inherit` — no PAT.

Both live on `@v2`; `v1` is unchanged.

# Consuming the Commit-message gate

Enforces [Conventional Commits](https://www.conventionalcommits.org/) on a pull
request: the format, the allowed types, a 72-character header, imperative mood,
no trailing period, no emoji, 100-character body lines, and no AI attribution.
The full contract is in [CONTRIBUTING.md](./CONTRIBUTING.md).

Needs **nothing** in the consumer repo — no `package.json`, no devDependency, no
config file. The rule set is written by the workflow itself, so a repo that is
only workflows and shell scripts can still be gated.

## A. Caller workflow (consumer `.github/workflows/commitlint.yml`)

```yaml
name: Commit messages
on:
  pull_request:
    # `edited` is load-bearing — a malformed PR title fixed after the first run
    # must re-trigger the check, or the fix never turns it green.
    types: [opened, edited, synchronize, reopened]

permissions:
  contents: read
  pull-requests: read

jobs:
  commitlint:
    uses: 12-apps/ci/.github/workflows/commitlint.yml@v1
```

## B. Both the commits and the PR title are linted

Not redundancy. With `squash_merge_commit_title: COMMIT_OR_PR_TITLE` — the
setting these repos use — GitHub takes the **single commit's subject** when a PR
has one commit and the **PR title** when it has several. Either can be the
subject that lands on `main`, so both are checked.

That subject is machine-read once it lands: semantic-release derives the version
bump from it, and this repo's `release-major-tag.yml` decides whether to advance
`@v1` by looking for a `!` marker or a `BREAKING CHANGE:` footer.

## C. Inputs

| Input | Default | Purpose |
|---|---|---|
| `node-version` | `'24'` | Node used to run commitlint |
| `config-path` | `''` | Path to the consumer's own commitlint config. Empty uses the shared rule set |
| `require-issue-ref` | `false` | Require `(#123)` in every commit. Off by default — demanding an issue number for a one-line fix in a **public** repo turns a drive-by contribution into a two-step chore. Turn it on where every change is tracked |

## 6. First DigitalOcean provision

Run the caller via **workflow_dispatch** with `action=provision`,
`target=digitalocean`. It creates the droplet and prints its IP; set the
`DEPLOY_HOST` repo Variable to that IP so subsequent push-to-main runs deploy to
it.
