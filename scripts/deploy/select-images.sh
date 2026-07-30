#!/usr/bin/env bash
#
# Image reuse planner — splits discover.sh's images[] matrix into the images this
# merge must REBUILD and the ones that can be RETAGGED from the previous commit.
#
# Why: cd.yml's build-images matrix rebuilt every image on every merge. The
# Dockerfiles `turbo prune <app> --docker`, so an unaffected app's build is a
# pure BuildKit cache hit (~15s) — but it still pays runner spin-up, checkout,
# setup-buildx and a GHCR login, ~1 billed minute each for nothing new.
#
# It has to be REUSE, not skip: cd.yml deploys `<ref>:${{ github.sha }}`, so
# omitting a build removes a tag the deploy needs. The reuse job instead runs
# `docker buildx imagetools create -t <ref>:$SHA <ref>:$BASE`, a registry-side
# manifest copy (no layer transfer, ~2s), for all unaffected images in ONE job.
#
# ---------------------------------------------------------------------------
# THE BASE COMMIT IS PASSED EXPLICITLY. THIS IS NOT OPTIONAL.
# ---------------------------------------------------------------------------
# `turbo run … --affected` infers its base from GITHUB_BASE_REF, which exists
# only on `pull_request`. CD is PUSH-triggered, so auto-detection diffs main
# against its own tip and reports ZERO affected packages — the same trap
# monorepo-static.yml documents at its Lint step ("Push (safety net):
# everything — --affected against the branch's own tip would diff empty and lint
# nothing"). Left to auto-detect, this planner would mark all six images
# unaffected, build none, and retag the PREVIOUS commit's images with the new
# sha: a green deploy that silently ships stale code. So the caller passes
# BASE_SHA (github.event.before) and it is exported as TURBO_SCM_BASE /
# TURBO_SCM_HEAD, which turbo honours (verified against turbo 2.7.5).
#
# EVERY uncertainty FAILS OPEN — builds everything. A missed rebuild ships stale
# code silently; a redundant rebuild costs a minute. Fail-open triggers:
#   - reuse disabled by the caller
#   - no turbo.json / turbo.jsonc at the repo root (not a turborepo)
#   - BASE_SHA empty or all-zeros (first push to a ref)
#   - BASE_SHA or HEAD_SHA unreachable (force-push, or too-shallow checkout)
#   - turbo missing, erroring, or emitting JSON this script cannot parse
#   - an image whose descriptor `dir` is not a workspace package at all
#   - an image whose Dockerfile (or any .dockerignore) changed in the range
#   - a GLOBAL_BUILD_INPUTS entry changed in the range (root-level build inputs
#     turbo cannot attribute to any package — see the gate for why)
#   - the reuse source manifest `<ref>:$BASE_SHA` is not in the registry
# Each one is logged with ::notice:: / ::warning:: and lands in the job summary,
# every run: a silent cap reads as "covered everything" when it did not.
#
# Env in:
#   IMAGES              discover.sh's images[] JSON (required; [] is fine)
#   BASE_SHA            previous tip of the pushed ref (github.event.before)
#   HEAD_SHA            commit being built (github.sha); defaults to HEAD
#   REUSE_ENABLED       true|false — caller kill switch; default true
#   AFFECTED_TASK       turbo task for the fallback probe; default build
#   GLOBAL_BUILD_INPUTS space-separated root-level paths that are in every
#                       image's build context but in no workspace package; a
#                       change to one rebuilds everything. Trailing `/` = a
#                       root-anchored directory prefix, otherwise an exact
#                       root-relative path. Conservative default below; an
#                       empty or whitespace-only value falls back to it (the
#                       gate cannot be switched off by emptying the list).
#   TURBO_VERSION       pin for the npx fallback; default: read from package.json
#   TURBO_TIMEOUT       seconds per turbo call; default 180 (npx can block)
#   PROBE_TIMEOUT       seconds per registry probe; default 30
#   PROBE_SOURCE_TAGS   1|0 — registry probe of the reuse source; default 1.
#                       0 is for offline tests ONLY: it asserts the source exists.
# Out ($GITHUB_OUTPUT):
#   build_images / has_build_images   images to hand to the build matrix
#   reuse_images / has_reuse_images   images to retag; each carries `source`
#   selection_mode                    all | partial
#   selection_reason                  one-line human explanation
#
set -uo pipefail   # deliberately NOT -e: a failing probe must fail OPEN, not abort
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/common.sh
. "$HERE/lib/common.sh"

command -v jq >/dev/null || die "jq is required"

IMAGES="${IMAGES:-[]}"
BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-}"
REUSE_ENABLED="${REUSE_ENABLED:-true}"
AFFECTED_TASK="${AFFECTED_TASK:-build}"
GBI_DEFAULT='.npmrc pnpm-lock.yaml pnpm-workspace.yaml turbo.json turbo.jsonc package.json patches/'
GLOBAL_BUILD_INPUTS="${GLOBAL_BUILD_INPUTS:-$GBI_DEFAULT}"
PROBE_SOURCE_TAGS="${PROBE_SOURCE_TAGS:-1}"
TURBO_TIMEOUT="${TURBO_TIMEOUT:-180}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-30}"

jq -e 'type == "array"' >/dev/null 2>&1 <<<"$IMAGES" || die "IMAGES is not a JSON array"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

emit() { # key value
  [ -n "${GITHUB_OUTPUT:-}" ] || return 0
  printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
}
summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"
}

names_of() { jq -r 'if length==0 then "none" else map(.image)|join(", ") end' <<<"$1"; }

# Terminal: build every discovered image. Called for every fail-open condition.
build_all() { # reason...
  local why="$*"
  notice "CD image reuse: building ALL images — $why"
  emit build_images "$IMAGES"
  emit has_build_images "$([ "$(jq 'length' <<<"$IMAGES")" -gt 0 ] && echo true || echo false)"
  emit reuse_images '[]'
  emit has_reuse_images false
  emit selection_mode all
  emit selection_reason "$why"
  summary "### CD image selection: **build all**"
  summary ""
  summary "$why"
  summary ""
  summary "- build: \`$(names_of "$IMAGES")\`"
  summary "- reuse: _none_"
  exit 0
}

n_images="$(jq 'length' <<<"$IMAGES")"
if [ "$n_images" -eq 0 ]; then
  notice "CD image reuse: no container targets discovered — nothing to select"
  emit build_images '[]'; emit has_build_images false
  emit reuse_images '[]'; emit has_reuse_images false
  emit selection_mode all
  emit selection_reason "no container targets discovered"
  exit 0
fi

# --- fail-open gates ---------------------------------------------------------

[ "$REUSE_ENABLED" = "true" ] \
  || build_all "image reuse is disabled by the caller (reuse_unaffected_images: $REUSE_ENABLED)"

[ -f turbo.json ] || [ -f turbo.jsonc ] \
  || build_all "no turbo.json/turbo.jsonc at the repo root — no affected-package graph to consult"

[ -n "$BASE_SHA" ] \
  || build_all "no base commit supplied (github.event.before is empty — not a push event?)"
case "$BASE_SHA" in
  *[!0]*) : ;;
  *) build_all "base commit is all-zeros — first push to this ref, nothing to reuse from" ;;
esac

git rev-parse --verify --quiet "${BASE_SHA}^{commit}" >/dev/null 2>&1 \
  || build_all "base commit $BASE_SHA is unreachable in this checkout (force-push, or a shallow clone missing it — cd.yml checks out with fetch-depth: 0)"

[ -n "$HEAD_SHA" ] || HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -z "$HEAD_SHA" ] || ! git rev-parse --verify --quiet "${HEAD_SHA}^{commit}" >/dev/null 2>&1; then
  build_all "head commit ${HEAD_SHA:-<empty>} is unreachable in this checkout"
fi

# Resolve a turbo entry point. The repo's own install wins (exact pinned
# version); otherwise npx fetches the declared one — turbo's package/affected
# queries read only the workspace files + git, so no pnpm install is needed.
TURBO_BIN=()
if [ -x node_modules/.bin/turbo ]; then
  TURBO_BIN=(node_modules/.bin/turbo)
elif command -v npx >/dev/null 2>&1; then
  tv="${TURBO_VERSION:-}"
  if [ -z "$tv" ] && [ -f package.json ]; then
    tv="$(jq -r '(.devDependencies.turbo // .dependencies.turbo // "") | ltrimstr("^") | ltrimstr("~")' package.json)"
  fi
  [ -n "$tv" ] && [ "$tv" != "null" ] || tv="^2"
  TURBO_BIN=(npx --yes "turbo@${tv}" --skip-infer)
fi
[ "${#TURBO_BIN[@]}" -gt 0 ] || build_all "turbo is not available (no node_modules/.bin/turbo and no npx)"

# Hard-bound every turbo call. `npx turbo@…` fetches from the npm registry, and a
# runner that cannot reach it BLOCKS rather than failing — which would hang the
# discover job (and the whole deploy behind it) until the 6-hour job timeout
# instead of falling back to building everything. Observed while testing this
# script with the proxy stripped from the environment.
TURBO=("${TURBO_BIN[@]}")
if command -v timeout >/dev/null 2>&1; then
  TURBO=(timeout "$TURBO_TIMEOUT" "${TURBO_BIN[@]}")
else
  warn "coreutils timeout is unavailable — turbo calls are unbounded"
fi

export TURBO_TELEMETRY_DISABLED=1
export TURBO_SCM_BASE="$BASE_SHA"
export TURBO_SCM_HEAD="$HEAD_SHA"

# 1. Every workspace package and its directory. Needed to tell "this image's dir
#    is genuinely unaffected" apart from "this image's dir is not a package at
#    all, so it can never appear in the affected list" — the second must build.
if ! "${TURBO[@]}" ls --output=json >"$TMP/all.json" 2>"$TMP/all.err"; then
  log "$(tail -5 "$TMP/all.err")"
  build_all "turbo could not enumerate the workspace packages (see the log above)"
fi
jq -er '.packages.items | map(.path) | .[]' "$TMP/all.json" >"$TMP/all.paths" 2>/dev/null \
  || build_all "turbo's package list was empty or unparseable"

# 2. The affected closure for BASE..HEAD (changed packages + their dependents).
affected_ok=0
if "${TURBO[@]}" ls --affected --output=json >"$TMP/aff.json" 2>"$TMP/aff.err" \
   && jq -e '.packages.items | type == "array"' >/dev/null 2>&1 "$TMP/aff.json"; then
  jq -r '.packages.items[].path' "$TMP/aff.json" >"$TMP/aff.paths"
  affected_ok=1
  method="turbo ls --affected (TURBO_SCM_BASE/TURBO_SCM_HEAD)"
else
  # `turbo ls` is flagged experimental upstream. Fall back to the stable dry-run
  # of a real task, which reports package NAMES; map them back to directories via
  # the full list. An unmappable name (e.g. the "//" root package, which turbo
  # reports when a root-level internal dependency changed) means "everything" —
  # fail open rather than guess.
  log "$(tail -5 "$TMP/aff.err")"
  warn "turbo ls --affected did not produce usable JSON; falling back to 'turbo run $AFFECTED_TASK --affected --dry=json'"
  if "${TURBO[@]}" run "$AFFECTED_TASK" --affected --dry=json >"$TMP/dry.json" 2>"$TMP/dry.err" \
     && jq -e '.packages | type == "array"' >/dev/null 2>&1 "$TMP/dry.json"; then
    if jq -r --slurpfile all "$TMP/all.json" '
          ($all[0].packages.items | map({key: .name, value: .path}) | from_entries) as $m
          | .packages | map($m[.] // " unmapped") | .[]
        ' "$TMP/dry.json" >"$TMP/aff.paths" 2>/dev/null \
       && ! grep -qF ' unmapped' "$TMP/aff.paths"; then
      affected_ok=1
      method="turbo run $AFFECTED_TASK --affected --dry=json (TURBO_SCM_BASE/TURBO_SCM_HEAD)"
    else
      build_all "turbo reported an affected package this planner cannot map to a directory"
    fi
  else
    log "$(tail -5 "$TMP/dry.err")"
    build_all "turbo could not compute the affected packages for ${BASE_SHA:0:12}..${HEAD_SHA:0:12}"
  fi
fi
[ "$affected_ok" = 1 ] || build_all "turbo affected query failed"
sort -u -o "$TMP/aff.paths" "$TMP/aff.paths"

# 3. Files changed in the range. turbo attributes a change to the package that
#    contains it, so build-definition files that live OUTSIDE any package (a
#    root Dockerfile, .dockerignore) are invisible to --affected. Catch those.
if ! git diff --name-only "$BASE_SHA" "$HEAD_SHA" >"$TMP/changed" 2>"$TMP/diff.err"; then
  log "$(tail -5 "$TMP/diff.err")"
  build_all "git diff $BASE_SHA..$HEAD_SHA failed"
fi
if grep -qE '(^|/)\.dockerignore$' "$TMP/changed"; then
  build_all "a .dockerignore changed in this range — every build context is affected"
fi

# Same blind spot, one level up: ROOT-LEVEL build inputs. turbo attributes a
# change to the package that CONTAINS it, and a root file belongs to none — so a
# root-only commit reports ZERO affected packages (measured: turbo 2.7.5, a
# commit touching only .github/ and scripts/ → "0 no packages"). For .github/**
# and scripts/** that is correct and is the whole saving. It is WRONG for root
# files that reach the image: the app Dockerfiles `COPY . .` into their
# `turbo prune` stage, so the pruner's input is the entire root. `.npmrc` is the
# sharpest case — it changes how `pnpm install` resolves and authenticates
# INSIDE the image, yet an .npmrc-only commit would retag every image and the
# new .npmrc would never reach a build. Same shape for `patches/` once pnpm
# patches are in use: patched dependency code changes, turbo reports nothing.
# The two existing build-context guards (.dockerignore, each image's own
# `dockerfile`) are exact-path checks and cover none of this.
#
# Entry semantics: a trailing `/` is a root-anchored DIRECTORY PREFIX
# (`patches/` matches `patches/react.patch`, not `packages/x/patches/y.patch`);
# anything else is an EXACT root-relative path. Exact is what keeps a nested
# `packages/foo/package.json` out of it — turbo already attributes that to its
# own package, and matching it here would rebuild everything on any manifest
# edit anywhere, destroying the saving.
#
# The default is deliberately conservative: pnpm-lock.yaml and the root
# package.json are probably already covered by turbo's lockfile handling and
# RootInternalDepChanged, so listing them costs an occasional redundant full
# rebuild and buys certainty. That is the correct direction of error — a missed
# rebuild ships stale code silently, a redundant one costs a minute.
#
# NOTE for consumers: declaring `globalDependencies` in your own turbo.json is
# the more complete fix (it corrects affectedness for every turbo consumer, not
# just this planner). It is not what this gate relies on, because that would put
# this engine's safety in a file the engine neither owns nor can verify — a
# consumer that never sets it would get silent staleness with no warning.
read -ra gbi_list <<<"$GLOBAL_BUILD_INPUTS"
if [ "${#gbi_list[@]}" -eq 0 ]; then
  # Blank or whitespace-only. `${VAR:-default}` above only catches the truly
  # empty case, and a YAML folded scalar can easily hand this step a lone space.
  # Silently honouring it would DISABLE the gate, which is the one direction this
  # script never goes: fall back to the default and say so.
  read -ra gbi_list <<<"$GBI_DEFAULT"
  warn "GLOBAL_BUILD_INPUTS is blank — using the engine default instead. The root-level build-input gate cannot be turned off by emptying the list; to narrow it, name the paths you do want."
fi
gbi_hit=''
for gbi in "${gbi_list[@]}"; do
  case "$gbi" in
    */)                                      # root-anchored directory prefix
      while IFS= read -r changed_path; do
        case "$changed_path" in "$gbi"*) gbi_hit="$changed_path"; break ;; esac
      done <"$TMP/changed"
      ;;
    *)                                       # exact root-relative path
      grep -Fxq -- "$gbi" "$TMP/changed" && gbi_hit="$gbi"
      ;;
  esac
  [ -z "$gbi_hit" ] || break
done
[ -z "$gbi_hit" ] \
  || build_all "'$gbi_hit' is a global build input (GLOBAL_BUILD_INPUTS) and changed in ${BASE_SHA:0:12}..${HEAD_SHA:0:12} — it is in every image's Docker build context but belongs to no workspace package, so turbo cannot report it affected"

count_of() { wc -l <"$1" | tr -d ' '; }
list_of()  { local s; s="$(paste -sd, "$1")"; printf '%s' "${s:-none}"; }
notice "CD image reuse: affected via $method for ${BASE_SHA:0:12}..${HEAD_SHA:0:12} — $(count_of "$TMP/aff.paths") of $(count_of "$TMP/all.paths") workspace packages: $(list_of "$TMP/aff.paths")"

# --- split -------------------------------------------------------------------

: >"$TMP/build.idx"; : >"$TMP/reuse.ndjson"; : >"$TMP/build.why"; : >"$TMP/reuse.why"
take_build() { # index image reason
  printf '%s\n' "$1" >>"$TMP/build.idx"
  printf '%s\t%s\n' "$2" "$3" >>"$TMP/build.why"
}

probe() { # ref:tag → 0 when the manifest exists in the registry
  [ "$PROBE_SOURCE_TAGS" = "1" ] || return 0
  if command -v timeout >/dev/null 2>&1; then
    timeout "$PROBE_TIMEOUT" docker buildx imagetools inspect --raw "$1" >/dev/null 2>&1
  else
    docker buildx imagetools inspect --raw "$1" >/dev/null 2>&1
  fi
}
if [ "$PROBE_SOURCE_TAGS" = "1" ] && ! docker buildx version >/dev/null 2>&1; then
  build_all "docker buildx is unavailable, so the reuse source manifests cannot be verified"
fi

for i in $(seq 0 $((n_images - 1))); do
  entry="$(jq -c ".[$i]" <<<"$IMAGES")"
  img="$(jq -r '.image' <<<"$entry")"
  dir="$(jq -r '.dir // ""' <<<"$entry")"
  ref="$(jq -r '.ref' <<<"$entry")"
  dockerfile="$(jq -r '.dockerfile // ""' <<<"$entry")"

  if [ -z "$dir" ] || [ "$dir" = "." ]; then
    warn "image '$img' has no app directory in its descriptor — building it"
    take_build "$i" "$img" "no descriptor dir"; continue
  fi
  if ! grep -Fxq "$dir" "$TMP/all.paths"; then
    warn "image '$img': descriptor dir '$dir' is not a workspace package, so turbo can never report it affected — building it"
    take_build "$i" "$img" "dir '$dir' is not a workspace package"; continue
  fi
  if [ -n "$dockerfile" ] && grep -Fxq "$dockerfile" "$TMP/changed"; then
    take_build "$i" "$img" "$dockerfile changed"; continue
  fi
  if grep -Fxq "$dir" "$TMP/aff.paths"; then
    take_build "$i" "$img" "$dir is affected"; continue
  fi

  # Unaffected. Reuse from the PARENT COMMIT's manifest, not from `:main`:
  # unaffectedness was proven for BASE..HEAD, so image(BASE) == image(HEAD).
  # `:main` only happens to agree — it can point at a newer concurrent run or at
  # an older commit that never built. Every CD run leaves a full set of `:<sha>`
  # tags (builds and retags alike), so `:$BASE_SHA` is the reliable source.
  src="${ref}:${BASE_SHA}"
  if ! probe "$src"; then
    warn "image '$img' is unaffected but its reuse source $src is not in the registry — building it"
    take_build "$i" "$img" "reuse source $src missing"; continue
  fi
  jq -nc --argjson i "$i" --arg src "$src" '{i: $i, src: $src}' >>"$TMP/reuse.ndjson"
  printf '%s\t%s unaffected, retag from %s\n' "$img" "$dir" "$src" >>"$TMP/reuse.why"
done

b_idx="$(jq -Rsc 'split("\n") | map(select(length > 0) | tonumber)' "$TMP/build.idx")"
r_pairs="$(jq -sc '.' "$TMP/reuse.ndjson")"
build_json="$(jq -c --argjson idx "$b_idx" '[ .[$idx[]] ]' <<<"$IMAGES")"
reuse_json="$(jq -c --argjson p "$r_pairs" '. as $all | [ $p[] | $all[.i] + {source: .src} ]' <<<"$IMAGES")"

n_build="$(jq 'length' <<<"$build_json")"
n_reuse="$(jq 'length' <<<"$reuse_json")"
[ "$((n_build + n_reuse))" -eq "$n_images" ] \
  || build_all "internal error: split $n_build+$n_reuse does not account for all $n_images images"

reason="reusing $n_reuse of $n_images images (${BASE_SHA:0:12}..${HEAD_SHA:0:12}); rebuilding $n_build"
emit build_images "$build_json"
emit has_build_images "$([ "$n_build" -gt 0 ] && echo true || echo false)"
emit reuse_images "$reuse_json"
emit has_reuse_images "$([ "$n_reuse" -gt 0 ] && echo true || echo false)"
emit selection_mode "$([ "$n_build" -eq "$n_images" ] && echo all || echo partial)"
emit selection_reason "$reason"

notice "CD image reuse: $reason — build: $(names_of "$build_json") | reuse: $(names_of "$reuse_json")"
if [ "$n_build" -eq 0 ]; then
  notice "CD image reuse: NOTHING is being rebuilt for ${HEAD_SHA:0:12} — every image is a retag of ${BASE_SHA:0:12}. Expected when a merge touches no workspace package (workflow/docs-only); investigate if it touched application code."
fi

summary "### CD image selection: reuse $n_reuse / $n_images"
summary ""
summary "Base \`${BASE_SHA:0:12}\` → head \`${HEAD_SHA:0:12}\` · affected via \`$method\`"
summary ""
summary "| image | decision |"
summary "|-------|----------|"
while IFS=$'\t' read -r img why; do summary "| \`$img\` | **build** · $why |"; done <"$TMP/build.why"
while IFS=$'\t' read -r img why; do summary "| \`$img\` | reuse · $why |"; done <"$TMP/reuse.why"

{
  echo "image selection — $reason"
  echo "  build: $(names_of "$build_json")"
  echo "  reuse: $(names_of "$reuse_json")"
} >&2
