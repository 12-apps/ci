#!/usr/bin/env bash
# Fill the host's shared pnpm store before the host is imaged.
#
#   sudo ./warm-pnpm-store.sh packages.txt [store-dir]
#
# packages.txt is pnpm-store-packages.mjs's output for the lockfile(s) the
# fleet's jobs install. The store is written from inside the job image, so it
# holds exactly what that image's pnpm reads, and handed to the image's
# `runner` user. supervisor.sh mounts it into every job container at
# /opt/pnpm-store (CI_RUNNER_PNPM_STORE); a job's `pnpm install` then links
# from local disk and fetches only what changed since the image was made.
set -euo pipefail
list="${1:?usage: warm-pnpm-store.sh packages.txt [store-dir]}"
store="${2:-/var/lib/ci-runner/pnpm-store}"
image="${CI_RUNNER_IMAGE:-ci-runner:latest}"
pnpm_version="${PNPM_VERSION:-10}"

mkdir -p "$store"
started=$(date +%s)
docker run --rm --entrypoint bash \
  --volume "$(realpath "$list"):/tmp/packages.txt:ro" --volume "${store}:/opt/pnpm-store" \
  "$image" -c "xargs -a /tmp/packages.txt -n 100 npx -y pnpm@${pnpm_version} store add --store-dir /opt/pnpm-store >/dev/null"
owner=$(docker run --rm --entrypoint id "$image" -u runner):$(docker run --rm --entrypoint id "$image" -g runner)
chown -R "$owner" "$store"
echo "warm-pnpm-store: $(wc -l < "$list") packages in $(( $(date +%s) - started ))s, $(du -sh "$store" | cut -f1) at ${store}"
