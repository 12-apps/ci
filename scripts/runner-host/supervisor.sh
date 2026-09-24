#!/usr/bin/env bash
# One runner slot: register a single-use runner, run one job, clean up, repeat.
#
#   supervisor.sh <slot>
#
# Every iteration asks GitHub for a just-in-time (JIT) runner config — a runner
# that is registered, takes exactly ONE job and is deregistered by GitHub — and
# starts a fresh container from $CI_RUNNER_IMAGE with it. When the job ends,
# fails, times out or the slot is stopped, the container is removed together
# with everything the job wrote: its workspace, its private Docker daemon's
# images and volumes, and any npm config or credential a step left behind. The
# next job starts from the image again, which is the property a GitHub-hosted
# runner has and a long-lived self-hosted one does not.
#
# Configuration is the environment (systemd reads it from /etc/ci-runner/env).
#
#   Credentials — one of:
#   CI_RUNNER_APP_ID + CI_RUNNER_APP_KEY_FILE   a GitHub App (preferred). Every
#                     iteration mints a short-lived installation token narrowed
#                     to the one permission runner registration needs.
#                     CI_RUNNER_APP_INSTALLATION_ID is optional (looked up).
#   CI_RUNNER_TOKEN   a fine-grained PAT (Administration: write on the repo, or
#                     Self-hosted runners: write on the org).
#   Neither ever reaches a job: the container only receives its own JIT config.
#
#   CI_RUNNER_SCOPE   `repos/<owner>/<repo>` or `orgs/<org>`
#   CI_RUNNER_LABELS  comma-separated custom labels, e.g. `future-pay-ci`
#   CI_RUNNER_IMAGE   image to start per job (default ci-runner:latest)
#   CI_RUNNER_GROUP_ID  runner group id (default 1, the Default group)
#   CI_RUNNER_NAME    name prefix (default: the host name)
#
#   Limits (all optional):
#   CI_RUNNER_MEMORY  per-job memory cap, e.g. `7000m` (swap capped to the same)
#   CI_RUNNER_CPUS    per-job CPU cap, e.g. `2.5`
#   CI_RUNNER_DISK    per-job disk cap, e.g. `40G`: the job's workspace and its
#                     Docker data live on a loop-mounted ext4 file of this size,
#                     formatted fresh for every job. Unset: an anonymous volume.
#   CI_RUNNER_JOB_TIMEOUT_MINUTES  wall-clock cap on one job once it has
#                     STARTED (default 360). Waiting for a job is not capped.
#
# Operations: the slot's state is written to $CI_RUNNER_STATE_DIR/slot-<n>.json
# (default /run/ci-runner) for `ci-runner-status`. It holds names, times and
# PIDs — never a token.
#
# Test seams: CI_RUNNER_API (API base URL), CI_RUNNER_ONCE=1 (one iteration),
# CI_RUNNER_POLL_SECONDS (watch interval), CI_RUNNER_DATA_DIR (loop files),
# CI_RUNNER_LOG_DRIVER (default journald; json-file where there is no journald).
set -euo pipefail

slot="${1:?usage: supervisor.sh <slot>}"
: "${CI_RUNNER_SCOPE:?CI_RUNNER_SCOPE is not set (repos/<owner>/<repo> or orgs/<org>)}"
: "${CI_RUNNER_LABELS:?CI_RUNNER_LABELS is not set}"
if [[ -z "${CI_RUNNER_TOKEN:-}" && -z "${CI_RUNNER_APP_ID:-}" ]]; then
  echo "ci-runner[${slot}]: set CI_RUNNER_APP_ID + CI_RUNNER_APP_KEY_FILE (GitHub App) or CI_RUNNER_TOKEN" >&2
  exit 64
fi
if [[ -n "${CI_RUNNER_APP_ID:-}" && ! -r "${CI_RUNNER_APP_KEY_FILE:-}" ]]; then
  echo "ci-runner[${slot}]: CI_RUNNER_APP_KEY_FILE is not a readable file" >&2
  exit 64
fi
image="${CI_RUNNER_IMAGE:-ci-runner:latest}"
api_base="${CI_RUNNER_API:-https://api.github.com}"
group_id="${CI_RUNNER_GROUP_ID:-1}"
prefix="${CI_RUNNER_NAME:-$(hostname -s)}-${slot}"
container="ci-runner-${slot}"
state_dir="${CI_RUNNER_STATE_DIR:-/run/ci-runner}"
state="${state_dir}/slot-${slot}.json"
data_dir="${CI_RUNNER_DATA_DIR:-/var/lib/ci-runner}"
poll="${CI_RUNNER_POLL_SECONDS:-5}"
job_timeout=$(( ${CI_RUNNER_JOB_TIMEOUT_MINUTES:-360} * 60 ))
max_failures=8

mkdir -p "$state_dir"

log() { echo "ci-runner[${slot}]: $*" >&2; }

# ── state for ci-runner-status ───────────────────────────────────────────────
# Rewritten whole (write + rename) so a reader never sees half a file.
phase=starting runner_name="" job="" job_started="" last_failure="" last_failure_at=""
save_state() {
  local pid=""
  pid=$(docker inspect -f '{{.State.Pid}}' "$container" 2>/dev/null || true)
  jq -n --arg slot "$slot" --arg phase "$phase" --arg runner "$runner_name" \
    --arg container "$container" --arg pid "${pid:-}" --arg job "$job" \
    --arg job_started "$job_started" --arg heartbeat "$(date +%s)" \
    --arg last_failure "$last_failure" --arg last_failure_at "$last_failure_at" \
    '{slot:$slot, phase:$phase, runner:$runner, container:$container, pid:$pid,
      job:$job, job_started:$job_started, heartbeat:($heartbeat|tonumber),
      last_failure:$last_failure, last_failure_at:$last_failure_at}' \
    > "${state}.tmp" && mv "${state}.tmp" "$state"
}
fail() { last_failure="$1"; last_failure_at="$(date -u +%FT%TZ)"; log "$1"; }

# ── GitHub credentials ───────────────────────────────────────────────────────
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# A GitHub App JWT (RS256, 9 minutes) signed with the App's private key.
app_jwt() {
  local now header payload unsigned sig
  now=$(date +%s)
  header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$CI_RUNNER_APP_ID" | b64url)
  unsigned="${header}.${payload}"
  sig=$(printf '%s' "$unsigned" | openssl dgst -sha256 -sign "$CI_RUNNER_APP_KEY_FILE" | b64url)
  printf '%s.%s' "$unsigned" "$sig"
}

gh_get() { # <token> <url>
  curl -fsS --retry 3 --retry-delay 2 -H "Authorization: Bearer $1" \
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$2"
}

# The token this iteration uses. For an App: a fresh installation token (1 h)
# narrowed to runner administration on the scope and nothing else.
token=""
auth() {
  if [[ -z "${CI_RUNNER_APP_ID:-}" ]]; then token="$CI_RUNNER_TOKEN"; return 0; fi
  local jwt inst body
  jwt=$(app_jwt) || return 1
  inst="${CI_RUNNER_APP_INSTALLATION_ID:-}"
  if [[ -z "$inst" ]]; then
    inst=$(gh_get "$jwt" "${api_base}/${CI_RUNNER_SCOPE}/installation" | jq -er '.id') || return 1
  fi
  if [[ "$CI_RUNNER_SCOPE" == repos/* ]]; then
    body=$(jq -n --arg r "${CI_RUNNER_SCOPE##*/}" '{repositories:[$r], permissions:{administration:"write"}}')
  else
    body='{"permissions":{"organization_self_hosted_runners":"write"}}'
  fi
  token=$(curl -fsS --retry 3 --retry-delay 2 -X POST -H "Authorization: Bearer ${jwt}" \
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
    "${api_base}/app/installations/${inst}/access_tokens" -d "$body" | jq -er '.token') || return 1
}

api() {
  curl -fsS --retry 3 --retry-delay 2 \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

# A slot killed mid-job (reboot, OOM, timeout, `systemctl restart`) leaves its
# runner registered and offline. Remove this slot's leftovers so the runner
# list only ever shows machines that exist — and never another slot's.
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
  # runner_name is set by the caller: this runs in a $(…) subshell, so an
  # assignment here would never reach the state file or the logs.
  local body
  body=$(jq -n \
    --arg name "$runner_name" \
    --arg labels "$CI_RUNNER_LABELS" \
    --argjson group "$group_id" \
    '{name: $name, runner_group_id: $group, work_folder: "_work",
      labels: ($labels | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)))}')
  api -X POST "${api_base}/${CI_RUNNER_SCOPE}/actions/runners/generate-jitconfig" -d "$body" \
    | jq -er '.encoded_jit_config'
}

# ── per-job disk ─────────────────────────────────────────────────────────────
mnt="${data_dir}/slot-${slot}"
img="${data_dir}/slot-${slot}.img"
disk_up() {
  [[ -n "${CI_RUNNER_DISK:-}" ]] || return 0
  mkdir -p "$data_dir" "$mnt"
  mountpoint -q "$mnt" && umount -l "$mnt"
  rm -f "$img"
  truncate -s "$CI_RUNNER_DISK" "$img"
  mkfs.ext4 -q -F -m 0 "$img"
  mount -o loop "$img" "$mnt"
  mkdir -p "$mnt/docker" "$mnt/work"
}
disk_down() {
  [[ -n "${CI_RUNNER_DISK:-}" ]] || return 0
  mountpoint -q "$mnt" && umount -l "$mnt" || true
  rm -f "$img"
}

# Whatever happened — job done, crash, timeout, `systemctl stop` — nothing of
# the job survives this slot.
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  disk_down
}

# A runner whose container ended deregisters itself (it is single-use) or is
# swept by the next iteration's remove_stale. One still waiting when the slot
# STOPS has neither: it would sit offline under Settings → Runners until this
# slot next starts, and for ever if it never does. So the slot takes its own
# registration with it — by exact name, never a neighbour's.
live=0
deregister_self() {
  (( live )) && [[ -n "$runner_name" ]] || return 0
  local id
  auth || return 0
  id=$(api --max-time 10 "${api_base}/${CI_RUNNER_SCOPE}/actions/runners?per_page=100" \
    | jq -r --arg n "$runner_name" '.runners[] | select(.name == $n) | .id') || return 0
  [[ -n "$id" ]] || return 0
  api --max-time 10 -X DELETE "${api_base}/${CI_RUNNER_SCOPE}/actions/runners/${id}" >/dev/null \
    && log "deregistered ${runner_name}" || true
}
on_exit() { cleanup; deregister_self; live=0; phase=stopped; save_state 2>/dev/null || true; }

# ── draining ─────────────────────────────────────────────────────────────────
# New scripts or a new image must never cost a running job: a restart removes
# the container mid-build (it cost a production CD job on 2026-09-24).
# install.sh asks for a drain by touching $state_dir/drain instead of
# restarting. A slot with no job answers at once; a slot with a job answers
# when the job ends, then exits for systemd to start the new scripts.
#
# A waiting runner is released through the API first. GitHub refuses to delete
# a runner it has just handed a job (422, busy), so the release cannot race an
# assignment; only after the delete succeeds is the container removed. A stale
# image alone (the weekly rebuild) recycles a waiting runner the same way,
# without exiting.
drain_file="${state_dir}/drain"
started_epoch=$(date +%s)
drain_requested() {
  [[ -e "$drain_file" ]] && (( $(stat -c %Y "$drain_file") > started_epoch ))
}
image_stale() {
  local want have
  want=$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null) || return 1
  have=$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null) || return 1
  [[ -n "$want" && "$want" != "$have" ]]
}
release_idle() {
  local id
  auth || return 1
  id=$(api --max-time 10 "${api_base}/${CI_RUNNER_SCOPE}/actions/runners?per_page=100" \
    | jq -r --arg n "$runner_name" '.runners[] | select(.name == $n) | .id') || return 1
  [[ -n "$id" ]] || return 1
  api --max-time 10 -X DELETE "${api_base}/${CI_RUNNER_SCOPE}/actions/runners/${id}" >/dev/null || return 1
  docker rm -f "$container" >/dev/null 2>&1 || true
  live=0
}
trap on_exit EXIT
trap 'exit 143' TERM INT

# ── one job ──────────────────────────────────────────────────────────────────
# Watches the container until it exits: records the job it picked up, keeps
# the heartbeat fresh, and kills it if the job outlives its cap.
watch_job() {
  local since started_at=0 out result
  since=$(date +%s)
  while [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" == "true" ]]; do
    if [[ -z "$job" ]]; then
      out=$(docker logs --since "$since" "$container" 2>&1 | grep -m1 -o 'Running job: .*' || true)
      if [[ -n "$out" ]]; then
        job="${out#Running job: }"; started_at=$(date +%s); job_started="$(date -u +%FT%TZ)"
        phase=running; log "running job '${job}' as ${runner_name}"
      elif { drain_requested || image_stale; } && release_idle; then
        log "released waiting runner ${runner_name} (drain or new image)"
        return 0
      fi
    elif (( $(date +%s) - started_at > job_timeout )); then
      fail "job '${job}' exceeded ${job_timeout}s; killing it"
      docker rm -f "$container" >/dev/null 2>&1 || true
      return 0
    fi
    save_state
    sleep "$poll"
  done
  result=$(docker logs "$container" 2>&1 | grep -o 'completed with result: [A-Za-z]*' | tail -n1 | awk '{print $4}' || true)
  if [[ -n "$job" && "$result" != "Succeeded" ]]; then
    fail "job '${job}' ended with result: ${result:-unknown}"
  fi
}

run_one() {
  disk_up
  local args=(run -d --name "$container" --privileged
    # Chromium dies on Docker's 64 MB default /dev/shm; GitHub's image has GBs.
    --shm-size 2g
    # Runner output to journald, tagged per slot; journald rotates it.
    --log-driver "${CI_RUNNER_LOG_DRIVER:-journald}"
    # Passed by NAME so the value never appears in this host's process list.
    --env RUNNER_JITCONFIG)
  if [[ -n "${CI_RUNNER_DISK:-}" ]]; then
    args+=(--volume "${mnt}/docker:/var/lib/docker" --volume "${mnt}/work:/home/runner/actions-runner/_work")
  else
    # The inner dockerd's storage must not be overlay-on-overlay, and must go
    # away with the job.
    args+=(--volume /var/lib/docker)
  fi
  [[ "${CI_RUNNER_LOG_DRIVER:-journald}" == journald ]] && args+=(--log-opt "tag=ci-runner-${slot}")
  [[ -n "${CI_RUNNER_MEMORY:-}" ]] && args+=(--memory "$CI_RUNNER_MEMORY" --memory-swap "$CI_RUNNER_MEMORY")
  [[ -n "${CI_RUNNER_CPUS:-}" ]] && args+=(--cpus "$CI_RUNNER_CPUS")
  args+=("$image")

  if ! RUNNER_JITCONFIG="$1" docker "${args[@]}" >/dev/null; then
    fail "the job container did not start"
    return 1
  fi
  live=1; phase=idle; job=""; job_started=""; save_state
  log "registered ${runner_name}; waiting for a job"
  watch_job
  live=0
}

# ── one-shot modes (install.sh / uninstall.sh / idle-stop.sh) ────────────────
# RELEASE_WAITING: delete this slot's runner if it is still waiting, so the slot
# can be stopped without killing a job. Exit 0 when nothing is left to lose
# (released, or no runner), 3 when the runner has a job — GitHub answers 422
# to deleting a runner it has just handed one, so this cannot race it.
if [[ "${CI_RUNNER_RELEASE_WAITING:-}" == 1 ]]; then
  trap - EXIT
  [[ "$(jq -r '.phase // ""' "$state" 2>/dev/null)" == running ]] && exit 3
  runner_name=$(jq -r '.runner // ""' "$state" 2>/dev/null || true)
  [[ -n "$runner_name" ]] || exit 0
  auth || { log "the credential was refused"; exit 1; }
  id=$(api "${api_base}/${CI_RUNNER_SCOPE}/actions/runners?per_page=100" \
    | jq -r --arg n "$runner_name" '.runners[] | select(.name == $n) | .id') || exit 1
  [[ -n "$id" ]] || exit 0
  api -X DELETE "${api_base}/${CI_RUNNER_SCOPE}/actions/runners/${id}" >/dev/null || exit 3
  log "released waiting runner ${runner_name}"
  exit 0
fi

# CHECK_ONLY: prove the credential can manage runners on the scope, then exit.
# DEREGISTER_ONLY: remove every runner this HOST registered (any slot, any
# status), then exit.
if [[ "${CI_RUNNER_CHECK_ONLY:-}" == 1 || "${CI_RUNNER_DEREGISTER_ONLY:-}" == 1 ]]; then
  trap - EXIT
  auth || { log "the credential was refused"; exit 1; }
  runners=$(api "${api_base}/${CI_RUNNER_SCOPE}/actions/runners?per_page=100") \
    || { log "the credential cannot list runners on ${CI_RUNNER_SCOPE}"; exit 1; }
  if [[ "${CI_RUNNER_DEREGISTER_ONLY:-}" == 1 ]]; then
    host="${CI_RUNNER_NAME:-$(hostname -s)}-"
    for id in $(jq -r --arg p "$host" '.runners[] | select(.name | startswith($p)) | .id' <<<"$runners"); do
      api -X DELETE "${api_base}/${CI_RUNNER_SCOPE}/actions/runners/${id}" >/dev/null && log "deregistered runner ${id}"
    done
  fi
  exit 0
fi

# ── the loop ─────────────────────────────────────────────────────────────────
cleanup
failures=0
while true; do
  phase=registering; runner_name="${prefix}-$(date +%s)"; job=""; job_started=""; save_state
  if auth && remove_stale && jit=$(jit_config); then
    failures=0
    run_one "$jit" || true
    unset jit
    cleanup
    if drain_requested; then
      log "drained; exiting so systemd starts the current scripts"
      phase=stopped; save_state
      exit 0
    fi
  else
    failures=$((failures + 1))
    fail "could not register a runner (attempt ${failures}/${max_failures})"
    # Bounded: a bad credential or a long outage ends the process, systemd
    # restarts it after RestartSec, and `ci-runner-status` shows the failure.
    if (( failures >= max_failures )) || [[ "${CI_RUNNER_ONCE:-}" == 1 ]]; then
      phase=failed; save_state; exit 1
    fi
    phase=backoff; save_state
    sleep $(( 5 * 2 ** failures > 300 ? 300 : 5 * 2 ** failures ))
    continue
  fi
  [[ "${CI_RUNNER_ONCE:-}" == 1 ]] && exit 0
done
