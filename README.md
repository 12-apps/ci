# 12-apps/ci

Shared, generic, vendor-pluggable **CD framework** consumed by any repo in the
org via a ~10-line caller workflow. Extracted from `12-apps/future-pay` so the
engine lives in one place and improvements ship to every consumer at once.

## What's here

| Path | Purpose |
|------|---------|
| `.github/workflows/cd.yml` | Reusable CD orchestrator (`workflow_call`): discover → build → flag-gated per-vendor deploy. |
| `.github/workflows/deploy-digitalocean.yml` | Reusable DigitalOcean adapter (provision / deploy / destroy). |
| `.github/workflows/deploy-cloudflare.yml` | Reusable Cloudflare adapter (Workers + Pages, fanned out from discovery). |
| `.github/workflows/quality.yml` | Reusable static-quality + test-reliability gate (`workflow_call`). |
| `.github/workflows/mcp-contract.yml` | Reusable MCP-surface contract gate (`workflow_call`): drift + surface-lint + optional in-process parity. |
| `.github/actions/discover` | Composite action wrapping the discovery engine (ships `discover.sh` to consumers). |
| `.github/actions/do-provision` | Composite action wrapping the droplet cloud-init bootstrap. |
| `scripts/deploy/` | Discovery engine (`discover.sh` + `lib/common.sh`). |
| `scripts/ephemeral/` | DigitalOcean droplet tooling (cloud-init, create/destroy helpers). |
| `.github/deploy/` | Descriptor + vendor-manifest JSON schemas and the contract README. |

## How it works

The reusable workflows run **in the caller's checkout**, so per-app descriptors
(`apps/*/deploy/config.json`) and the GHCR image namespace (derived from
`github.repository`) resolve to the consuming repo — nothing is hardcoded to
`future-pay`. The engine *scripts* ship from this repo through composite actions
(`uses: 12-apps/ci/.github/actions/discover@v1`), which is the only way a
consumer's job token can run private-repo scripts without a dedicated PAT.

## Versioning

Consumers pin the moving major tag `@v1`. Backwards-compatible changes move
`v1`; a breaking change cuts `v2`.

`v1` moves **automatically**: `.github/workflows/release-major-tag.yml` re-points
it to every push on `main` — no manual force-push. Commits marked breaking
(conventional `type!:` / `type(scope)!:` subject, or a `BREAKING CHANGE:` footer)
are skipped, so a breaking change never auto-ships to `@v1`; cut `v2` by hand for
those.

## Use it

See **[CONSUMING.md](./CONSUMING.md)**.
