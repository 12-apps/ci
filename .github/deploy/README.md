# Deploy framework

Config-driven, vendor-pluggable CD — the deploy-side sibling of
[`.github/rotation/`](../rotation/README.md). `cd.yml` discovers what to deploy
from per-app descriptors and fans out to thin, flag-gated vendor adapters.
Nothing is hardcoded to this repo: the image namespace is derived from
`github.repository`, so the same workflows work in any repository.

## How it works

```
cd.yml
 ├─ discover    scripts/deploy/discover.sh  → images[] / statics[] / workers[]
 ├─ build       build images → GHCR · build static artifacts
 └─ deploy      one thin caller job per enabled vendor (deploy-<vendor>.yml)
```

- **`scripts/deploy/discover.sh`** — the engine. Scans `apps/*/deploy/config.json`
  (+ bare `wrangler.toml`), derives `IMAGE_NAMESPACE=ghcr.io/<owner/repo>`, and
  emits the build/deploy matrices.
- **`targets.json`** — the vendor registry (this file's sibling). Each vendor is
  gated by its `enabledVar` repo Variable; nothing enabled = nothing deploys.

## Add an app

Drop `apps/<app>/deploy/config.json` (validated by `app.schema.json`):

```jsonc
{ "name": "myapp", "targets": [
  { "provider": "digitalocean",
    "build": { "type": "container", "image": "myapp", "dockerfile": "apps/myapp/Dockerfile", "target": "runner" } }
] }
```

One app may declare several targets. `build.type` is `container` (→ GHCR image),
`static` (→ Pages artifact) or `worker` (→ wrangler). A server app (e.g. web) is
`container` only; a static site declares a `cloudflare` `static` target. A bare
`wrangler.toml` with no descriptor is auto-discovered as a worker.

## Add a vendor

1. Add an entry to `targets.json` (`name`, `enabledVar`, `workflow`, `consumes`).
2. Add `deploy-<vendor>.yml` (reusable `workflow_call`) satisfying the adapter
   contract: validate only its own secrets, consume the prebuilt artifact/image
   it's given, never rebuild source, trigger `post-cd.yml`.
3. Add one thin caller job in `cd.yml` gated by the `enabledVar`.

The discovery/build core needs no changes.

## Enable / disable

Repo → Settings → Secrets and variables → Actions → **Variables**:
`ENABLE_DEPLOY_DIGITALOCEAN`, `ENABLE_DEPLOY_CLOUDFLARE` = `true|false`
(default off, so a merge never triggers a live deploy).
