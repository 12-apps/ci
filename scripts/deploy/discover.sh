#!/usr/bin/env bash
#
# Deploy discovery engine — the deploy-side analogue of
# scripts/rotate/rotate-secrets.sh.
#
# Scans the repo for per-app deploy descriptors and emits the build/deploy
# matrices that cd.yml fans out over. The descriptor is the "manifest"; each
# vendor (provider) is a "plugin" (a deploy-<vendor>.yml reusable workflow).
# Drop a descriptor → it deploys. Nothing repo-specific is hardcoded: the image
# namespace is derived from GITHUB_REPOSITORY, so this works in any repo.
#
# Descriptor — apps/*/deploy/config.json:
#   {
#     "name": "web",
#     "targets": [
#       { "provider": "digitalocean",
#         "build": { "type": "container", "image": "web", "dockerfile": "apps/web/Dockerfile",
#                    "target": "runner", "cache": "web", "role": "runner" } },
#       { "provider": "cloudflare",
#         "build": { "type": "static", "command": "pnpm turbo build --filter=site...",
#                    "outputPath": "apps/site/out" }, "deploy": { "projectName": "my-site" } },
#       { "provider": "cloudflare",
#         "build": { "type": "worker", "wranglerDir": "apps/api" } }
#     ]
#   }
# A bare wrangler.toml with no descriptor is auto-synthesized into a worker
# target (restores the old "drop a wrangler.toml and it deploys" convention).
#
# Env in:
#   GITHUB_REPOSITORY   owner/repo (auto in Actions) — derives the GHCR namespace
#   TARGET              optional vendor filter (workflow_dispatch 'target': all|<vendor>); default all
#   PLAN_ONLY=1         print the human summary only; never write GITHUB_OUTPUT
# Out ($GITHUB_OUTPUT):
#   image_namespace=ghcr.io/<lower(owner/repo)>
#   images=[{app,dir,provider,image,ref,dockerfile,target,cache,role}]     has_images=true|false
#   statics=[{app,dir,provider,command,outputPath,artifact,projectName}]   has_statics=true|false
#   workers=[{app,dir,provider,wranglerDir,command}]                       has_workers=true|false
#
# `dir` is the app directory the descriptor lives in (apps/web/deploy/config.json
# → "apps/web"), derived from the descriptor's PATH and never from its `name`.
# select-images.sh maps an image to a workspace package by `dir`, so a consumer
# that sets `name` != directory cannot silently break change detection — and the
# `migrate` image, which is a second *target* of apps/web's descriptor, inherits
# apps/web's affectedness instead of looking for a package called "migrate".
#
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/common.sh
. "$HERE/lib/common.sh"

command -v jq >/dev/null || die "jq is required"
: "${GITHUB_REPOSITORY:?missing GITHUB_REPOSITORY (owner/repo)}"
TARGET="${TARGET:-all}"

# GHCR namespace, derived once and lowercased (GHCR rejects uppercase).
NS="ghcr.io/$(printf '%s' "$GITHUB_REPOSITORY" | tr '[:upper:]' '[:lower:]')"

# Collect descriptor paths (null-delimited; same find idiom as the old detect-apps).
descs=()
while IFS= read -r -d '' f; do descs+=("$f"); done \
  < <(find . -path '*/deploy/config.json' -not -path './node_modules/*' -print0 2>/dev/null)

# Validate each is JSON; warn + drop invalid ones (don't fail the whole run).
valid=()
if [ "${#descs[@]}" -gt 0 ]; then
  for f in "${descs[@]}"; do
    if jq empty "$f" >/dev/null 2>&1; then valid+=("$f"); else warn "invalid descriptor JSON, skipping: $f"; fi
  done
fi

# Pair each descriptor with its own location before flattening. jq's `inputs`
# loses the filename, and `input_filename` is read-ahead-sensitive across
# multiple files, so the path is attached here in bash where it is unambiguous.
descriptors='[]'
if [ "${#valid[@]}" -gt 0 ]; then
  descriptors="$(
    for f in "${valid[@]}"; do
      p="${f#./}"                        # apps/web/deploy/config.json
      d="$(dirname "$(dirname "$p")")"   # apps/web  (find only matches */deploy/config.json)
      jq -c --arg dir "$d" '{dir: $dir, doc: .}' "$f"
    done | jq -sc '.'
  )"
fi

# Flatten every descriptor's targets into the three matrices in one jq pass.
plan="$(jq -n --arg ns "$NS" --arg target "$TARGET" --argjson descs "$descriptors" '
  [ $descs[] as $e | ($e.doc.targets // [])[] | . + {app: ($e.doc.name // ""), dir: $e.dir} ]
  | map(select(.app != "" and (.build.type != null)))
  | map(select($target == "all" or .provider == $target))
  | {
      images: [ .[] | select(.build.type == "container")
        | { app, dir, provider,
            image:  (.build.image // .app),
            ref:    ($ns + "-" + (.build.image // .app)),
            dockerfile: (.build.dockerfile // "Dockerfile"),
            target: (.build.target // "runner"),
            cache:  (.build.cache // (.build.image // .app)),
            role:   (.build.role // "runner") } ],
      statics: [ .[] | select(.build.type == "static")
        | { app, dir, provider,
            command: .build.command,
            outputPath: .build.outputPath,
            artifact: ("deploy-static-" + (.deploy.projectName // .app)),
            projectName: (.deploy.projectName // .app) } ],
      workers: [ .[] | select(.build.type == "worker")
        | { app, dir, provider,
            wranglerDir: ((.build.wranglerDir // "") | ltrimstr("./")),
            command: (.deploy.command // "deploy") } ]
    }
')"

# Fallback: a bare wrangler.toml with no descriptor → synthesize a worker target.
if [ "$TARGET" = "all" ] || [ "$TARGET" = "cloudflare" ]; then
  while IFS= read -r -d '' toml; do
    dir="$(dirname "$toml")"; dir="${dir#./}"
    if ! jq -e --arg d "$dir" 'any(.workers[]; .wranglerDir == $d)' >/dev/null <<<"$plan"; then
      plan="$(jq --arg d "$dir" --arg app "$(basename "$dir")" \
        '.workers += [{app:$app, dir:$d, provider:"cloudflare", wranglerDir:$d, command:"deploy"}]' <<<"$plan")"
    fi
  done < <(find . -name wrangler.toml -not -path './node_modules/*' -print0 2>/dev/null)
fi

images="$(jq -c '.images'  <<<"$plan")"
statics="$(jq -c '.statics' <<<"$plan")"
workers="$(jq -c '.workers' <<<"$plan")"
has() { if [ "$(jq 'length' <<<"$1")" -gt 0 ]; then echo true; else echo false; fi; }

emit() { # key value
  [ "${PLAN_ONLY:-}" = "1" ] && return 0
  [ -n "${GITHUB_OUTPUT:-}" ] || return 0
  printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
}
emit image_namespace "$NS"
emit images  "$images";  emit has_images  "$(has "$images")"
emit statics "$statics"; emit has_statics "$(has "$statics")"
emit workers "$workers"; emit has_workers "$(has "$workers")"

# Human summary — always to stderr (and the only output under PLAN_ONLY).
{
  echo "deploy discovery — namespace: $NS  (target: $TARGET)"
  echo "  images : $(jq -r 'if length==0 then "none" else map("\(.image)[\(.dir)]->\(.ref):\(.target)")|join(", ") end' <<<"$images")"
  echo "  statics: $(jq -r 'if length==0 then "none" else map("\(.app)->\(.projectName)")|join(", ") end' <<<"$statics")"
  echo "  workers: $(jq -r 'if length==0 then "none" else map("\(.app)@\(.wranglerDir)")|join(", ") end' <<<"$workers")"
} >&2
