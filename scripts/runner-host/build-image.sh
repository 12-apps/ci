#!/usr/bin/env bash
# Build (or rebuild) the per-job runner image, then drop what the last build
# left behind. Run by install.sh and weekly by ci-runner-image.timer: GitHub
# stops sending jobs to a runner release that has fallen too far behind, and a
# weekly rebuild keeps the image on the current one without anyone watching.
#
# Env: CI_RUNNER_IMAGE (default ci-runner:latest), CI_RUNNER_BASE_IMAGE
# (default ubuntu:24.04), RUNNER_VERSION (default: the latest release).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
image="${CI_RUNNER_IMAGE:-ci-runner:latest}"
base="${CI_RUNNER_BASE_IMAGE:-ubuntu:24.04}"

# Tags over git rather than the releases API: no token, no API rate limit.
version="${RUNNER_VERSION:-$(git ls-remote --tags --refs https://github.com/actions/runner 'v2.*' \
  | awk -F/ '{print $3}' | sed 's/^v//' | sort -V | tail -n 1)}"
[[ -n "$version" ]] || { echo "build-image: could not resolve the runner version" >&2; exit 1; }

echo "build-image: actions/runner ${version} on ${base} -> ${image}"
docker build --pull \
  --build-arg "BASE_IMAGE=${base}" \
  --build-arg "RUNNER_VERSION=${version}" \
  -t "$image" "$here"

# Slots pick the new tag up on their next job; the old layers are garbage.
docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null
