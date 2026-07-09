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
report-only), `run-e2e-reliability` (default true), `run-affected-e2e` (default
**false** — opt-in selective e2e), `pre-e2e-command`, `install-playwright`
(default true), `e2e-repeat` (default `3`).

## B. Required in the consumer repo

`package.json` scripts:

| Script | Purpose |
|--------|---------|
| `quality:complexity` | `eslint --config eslint.complexity.config.mjs .` (size/complexity/nested-loop/cognitive on source — also good on pre-commit) |
| `quality:flakiness` | `eslint --config eslint.flakiness.config.mjs .` (tiered anti-flake lint on tests/specs/stories) |
| `quality:dup` | `jscpd …` copy-paste detection |
| `quality:quarantine` | `node scripts/flaky-quarantine-check.mjs` |
| `quality:knip` | `knip` (report-only) |
| `test:e2e:reliability` | `node scripts/e2e-reliability.mjs` (re-run changed specs Nx) |
| `test:e2e:affected` | `node scripts/e2e-affected.mjs` (run only diff-affected specs) — only if `run-affected-e2e: true` |

Plus these files (copy from any consumer, e.g. `future-pay`):
`eslint.complexity.config.mjs`, `eslint.flakiness.config.mjs`,
`eslint.quality.shared.mjs` (shared thresholds/ignores/globs/rule sets),
`.quality-exceptions` (per-repo grandfather list), `knip.json`,
`flaky-quarantine.json`, `scripts/e2e-reliability.mjs`,
`scripts/flaky-quarantine-check.mjs`, `tests/e2e/reporters/flaky-test-reporter.ts`,
and the devDeps `eslint-plugin-sonarjs`, `eslint-plugin-test-flakiness`, `jscpd`, `knip`.
For selective e2e (`run-affected-e2e: true`) also copy `scripts/e2e-affected.mjs`
and add your own `e2e-affected.json` (the per-repo source-path → spec map).

Per-repo (NOT shared): `.quality-exceptions` (grandfathered offenders), the
jscpd `--threshold` baseline, and `e2e-affected.json` (feature→spec map).
Everything else is portable.

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
    # Least-privilege: the gate only reads the repo. (The reusable workflow also
    # caps itself at contents:read — belt-and-suspenders, keep it explicit.)
    permissions:
      contents: read
    uses: 12-apps/ci/.github/workflows/mcp-contract.yml@v1
    with:
      # Build the MCP package / render the OpenAPI before the gate runs.
      pre-command: pnpm --filter @repo/mcp build
    secrets: inherit
```

Inputs (all optional): `node-version` (default `24`), `run-drift` (default true),
`run-lint` (default true), `run-parity` (default **false** — opt-in in-process
served-schema parity), `pre-command`.

## B. Required in the consumer repo

`package.json` scripts:

| Script | Purpose |
|--------|---------|
| `mcp:check` | Regenerate the MCP tool manifest from the app's OpenAPI and **exit non-zero on drift** (typically: regenerate to a temp path, then `git diff --exit-code` the committed manifest). The load-bearing gate. |
| `mcp:lint` | Static lint of the exposed surface — no secret-bearing fields leak into tool schemas, every tool has an input schema, write tools are classified. Fails on violation. |
| `mcp:parity` | (only if `run-parity: true`) Boot the MCP server in-process against the rendered OpenAPI and diff served tool schemas vs the manifest. |

Plus a committed source-of-truth pair the scripts operate on: the rendered
**OpenAPI** document and the **generated MCP tool manifest** (both regenerated by
`@repo/mcp` from the app's Zod-schema'd routes). Drift between endpoint schemas and
the manifest is exactly what `mcp:check` catches.

## 6. First DigitalOcean provision

Run the caller via **workflow_dispatch** with `action=provision`,
`target=digitalocean`. It creates the droplet and prints its IP; set the
`DEPLOY_HOST` repo Variable to that IP so subsequent push-to-main runs deploy to
it.
