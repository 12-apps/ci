#!/usr/bin/env bash
# One runner slot: register a single-use runner, run one job, repeat.
#
#   supervisor.sh <slot>
#
# Every iteration asks GitHub for a just-in-time (JIT) runner config — a runner
# that is registered, takes exactly ONE job and is deregistered by GitHub — and
# starts a fresh container from $CI_RUNNER_IMAGE with it. When the job ends the
# container is removed with everything the job wrote, including its private
# Docker daemon's images and volumes. The next job starts from the image again,
# which is the property a GitHub-hosted runner has and a long-lived self-hosted
# one does not: nothing a job leaves behind can make the next one pass or fail.
#
# Configuration is the environment (systemd reads it from /etc/ci-runner/env):
#
#   CI_RUNNER_TOKEN   fine-grained PAT. Repo scope: Administration read/write
#                     on that repo. Org scope: Self-hosted runners read/write.
#                     It stays on the host; a job never sees it.
#   CI_RUNNER_SCOPE   `repos/<owner>/<repo>` or `orgs/<org>`
#   CI_RUNNER_LABELS  comma-separated custom labels, e.g. `future-pay-ci`
#   CI_RUNNER_IMAGE   image to start per job (default ci-runner:latest)
#   CI_RUNNER_MEMORY  per-slot memory cap for `docker run --memory` (optional)
#   CI_RUNNER_GROUP_ID  runner group id (default 1, the Default group)
#   CI_RUNNER_NAME    name prefix (default: the host name)
#
# Test seams: CI_RUNNER_API (API base URL) and CI_RUNNER_ONCE=1 (one iteration).
set -euo pipefail

slot="${1:?usage: supervisor.sh <slot>}"
: "${CI_RUNNER_TOKEN:?CI_RUNNER_TOKEN is not set}"
: "${CI_RUNNER_SCOPE:?CI_RUNNER_SCOPE is not set (repos/<owner>/<repo> or orgs/<org>)}"
: "${CI_RUNNER_LABELS:?CI_RUNNER_LABELS is not set}"
image="${CI_RUNNER_IMAGE:-ci-runner:latest}"
api_base="${CI_RUNNER_API:-https://api.github.com}"
group_id="${CI_RUNNER_GROUP_ID:-1}"
prefix="${CI_RUNNER_NAME:-$(hostname -s)}-${slot}"
container="ci-runner-${slot}"

api() {
  curl -fsS --retry 3 --retry-delay 2 \
    -H "Authorization: Bearer ${CI_RUNNER_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

# A slot killed mid-job (reboot, OOM, `systemctl restart`) leaves its runner
# registered and offline. Remove this slot's leftovers so the runner list only
# ever shows machines that exist.
remove_stale() {
  local ids
  ids=$(api "${api_base}/${CI_RUNNER_SCOPE}/actions/runners?per_page=100" \
    | jq -r --arg p "${prefix}-" \
        '.runners[] | select(.status == "offline" and (.name | startswith($p))) | .id') || return 0
  for id in $ids; do
    api -X DELETE "${api_base}/${CI_RUNNER_SCOPE}/actions/runners/${id}" >/dev/null || true
  done
}

jit_config() {
  local body
  body=$(jq -n \
    --arg name "${prefix}-$(date +%s)" \
    --arg labels "$CI_RUNNER_LABELS" \
    --argjson group "$group_id" \
    '{name: $name, runner_group_id: $group, work_folder: "_work",
      labels: ($labels | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)))}')
  api -X POST "${api_base}/${CI_RUNNER_SCOPE}/actions/runners/generate-jitconfig" -d "$body" \
    | jq -er '.encoded_jit_config'
}

docker rm -f "$container" >/dev/null 2>&1 || true
remove_stale

failures=0
while true; do
  if ! jit=$(jit_config); then
    failures=$((failures + 1))
    # Back off on a bad token or a GitHub outage instead of hammering the API.
    delay=$(( failures > 6 ? 300 : 5 * 2 ** failures ))
    echo "ci-runner[${slot}]: could not get a JIT config (attempt ${failures}); retrying in ${delay}s" >&2
    [[ "${CI_RUNNER_ONCE:-}" == 1 ]] && exit 1
    sleep "$delay"
    continue
  fi
  failures=0

  args=(run --rm --name "$container" --privileged
    # Chromium dies on Docker's 64 MB default /dev/shm; GitHub's image has GBs.
    --shm-size 2g
    # The inner dockerd's storage must not be overlay-on-overlay, and must go
    # away with the job: an anonymous volume does both under --rm.
    --volume /var/lib/docker
    # Passed by NAME so the value never appears in this host's process list.
    --env RUNNER_JITCONFIG)
  [[ -n "${CI_RUNNER_MEMORY:-}" ]] && args+=(--memory "$CI_RUNNER_MEMORY" --memory-swap "$CI_RUNNER_MEMORY")
  args+=("$image")

  RUNNER_JITCONFIG="$jit" docker "${args[@]}" || echo "ci-runner[${slot}]: container exited $?" >&2
  unset jit

  [[ "${CI_RUNNER_ONCE:-}" == 1 ]] && exit 0
done
