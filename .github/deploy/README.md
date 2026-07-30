# Deploy framework

Config-driven, vendor-pluggable CD — the deploy-side sibling of
[`.github/rotation/`](../rotation/README.md). `cd.yml` discovers what to deploy
from per-app descriptors and fans out to thin, flag-gated vendor adapters.
Nothing is hardcoded to this repo: the image namespace is derived from
`github.repository`, so the same workflows work in any repository.

## How it works

```
cd.yml
 ├─ discover      scripts/deploy/discover.sh      → images[] / statics[] / workers[]
 │                scripts/deploy/select-images.sh → build_images[] / reuse_images[]
 ├─ build-images  build the affected images → GHCR
 ├─ reuse-images  retag the unaffected ones (one job, registry-side manifest copy)
 ├─ build-static  build static artifacts
 └─ deploy        one thin caller job per enabled vendor (deploy-<vendor>.yml)
```

- **`scripts/deploy/discover.sh`** — the engine. Scans `apps/*/deploy/config.json`
  (+ bare `wrangler.toml`), derives `IMAGE_NAMESPACE=ghcr.io/<owner/repo>`, and
  emits the build/deploy matrices. Each entry carries `dir` — the app directory
  the descriptor was found in, taken from its PATH rather than its `name`.
- **`scripts/deploy/select-images.sh`** — the image-reuse planner. See below.
- **`targets.json`** — the vendor registry (this file's sibling). Each vendor is
  gated by its `enabledVar` repo Variable; nothing enabled = nothing deploys.

## Image reuse (FUT-466)

The deploy pulls `<ref>:<github.sha>`, so an image that is not built has no tag
and the deploy breaks. Rather than skipping unaffected images, the planner
**retags** them: `docker buildx imagetools create -t <ref>:$SHA <ref>:$BEFORE`
copies the manifest inside the registry — no layer transfer, no build context,
~2s — and all unaffected images share one job.

"Affected" comes from turbo: an image is rebuilt when its descriptor's `dir` is
in `turbo ls --affected`'s closure (changed packages **plus their dependents**),
or when its own Dockerfile changed.

Two things about this are load-bearing:

- **The base commit is passed explicitly** (`github.event.before` →
  `TURBO_SCM_BASE`). `turbo --affected`'s auto-detection reads `GITHUB_BASE_REF`,
  which exists only on `pull_request`. CD is push-triggered, so auto-detection
  would diff main against its own tip, report **zero** affected packages, retag
  every image from the parent commit and build none — a green deploy shipping the
  previous commit's code.
- **The mapping is by directory, not by name.** A descriptor may set
  `name` != its directory, and one descriptor may declare several images (in
  future-pay, `migrate` is a second *target* of `apps/web`'s descriptor, so it
  inherits `apps/web`'s affectedness including Prisma changes — there is no
  package called "migrate" to look up). An image whose `dir` is not a workspace
  package at all is always rebuilt.

Everything ambiguous **fails open** (rebuilds everything) and says so with a
`::notice::`/`::warning::` and a job-summary table, every run: all-zeros or
unreachable base, missing/erroring/unparseable turbo, no `turbo.json`, a changed
`.dockerignore`, a reuse source manifest that is not in the registry. Pass
`reuse_unaffected_images: false` to the `cd.yml` caller to force full rebuilds.

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
