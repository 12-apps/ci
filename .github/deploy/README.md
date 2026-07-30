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
`.dockerignore`, a changed **global build input** (below), a reuse source manifest
that is not in the registry. Pass `reuse_unaffected_images: false` to the `cd.yml`
caller to force full rebuilds.

### Global build inputs — the root-level blind spot

turbo attributes a change to the package that **contains** it, and a root-level
file belongs to no package. So a root-only commit reports *zero* affected
packages (measured on turbo 2.7.5: a commit touching only `.github/` and
`scripts/` → `0 no packages`). For `.github/**` and `scripts/**` that is correct,
and it is the whole saving.

It is **wrong** for root files that reach the image. The app Dockerfiles do
`COPY . .` into their `turbo prune` stage, so the pruner's input is the entire
repo root. `.npmrc` is the sharpest case: it changes how `pnpm install` resolves
and authenticates *inside* the image, yet an `.npmrc`-only commit would retag all
images and the new `.npmrc` would never reach a build — a green CD, a green deploy
and green post-CD smoke tests, all exercising the previous commit's binaries under
the new sha. Same shape for `patches/**` once pnpm patches are in use. Neither
existing build-context guard covers it: `.dockerignore` and each image's own
`dockerfile` field are both exact-path checks.

`GLOBAL_BUILD_INPUTS` is that gate. A change to any entry fails open the same way
a changed `.dockerignore` does, with a `::notice::` naming the file. Default:

```
.npmrc pnpm-lock.yaml pnpm-workspace.yaml turbo.json turbo.jsonc package.json patches/
```

- A trailing `/` is a **root-anchored directory prefix** — `patches/` matches
  `patches/react@19.patch` but not `packages/x/patches/y.patch`.
- Anything else is an **exact root-relative path**. That is deliberate: a nested
  `packages/foo/package.json` must *not* trigger it, because turbo already
  attributes that change to its own package, and matching it here would rebuild
  everything on any manifest edit anywhere.
- Deliberately conservative. `pnpm-lock.yaml` and the root `package.json` are
  probably already covered by turbo's lockfile handling and
  `RootInternalDepChanged`, so listing them costs an occasional redundant full
  rebuild and buys certainty. A missed rebuild ships stale code silently; a
  redundant one costs a minute.

Override with the `global_build_inputs` input on `cd.yml` (or on the
`select-images` action directly) — space separated. A value **replaces** the
default rather than adding to it, so repeat the entries you still want. An empty
or whitespace-only value falls back to the default with a `::warning::` — the gate
cannot be switched off by emptying the list.

> A consumer that declares `globalDependencies` in its own `turbo.json` gets a
> more complete fix, because it corrects affectedness for *every* turbo consumer
> (`turbo run`, remote cache, CI filters) rather than just this planner — and it
> is worth doing. It is not what this gate relies on, because that would put the
> engine's safety in a file the engine neither owns nor can verify: a consumer
> that never sets it would get silent staleness with no warning. The two compose
> fine — a repo with `globalDependencies` set correctly just sees the gate fire
> redundantly at worst.

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
