#!/usr/bin/env bash
# Power the host off once no slot has run a job for CI_RUNNER_IDLE_MINUTES
# (default 20; 0 disables). Run every minute by ci-runner-idle.timer.
#
# The machine is billed by the hour it is up, and CI is idle most of the day,
# so a host that stops itself costs a fraction of one left on. It is started
# again when a job is queued (wake/, a GitHub webhook and a Lambda), so the
# first job after a quiet spell waits a minute or two for it to boot.
#
# Stopping must never cost a job. Each slot's waiting runner is released
# through the API first (supervisor.sh's RELEASE_WAITING mode), which GitHub
# refuses for a runner it has just handed a job; only then is the slot
# stopped. One refusal aborts the whole stop and brings back any slot already
# stopped, and the idle clock starts again.
#
# Test seams: CI_RUNNER_STATE_DIR, CI_RUNNER_SUPERVISOR, CI_RUNNER_POWEROFF,
# CI_RUNNER_SYSTEMCTL.
set -euo pipefail

state_dir="${CI_RUNNER_STATE_DIR:-/run/ci-runner}"
idle_minutes="${CI_RUNNER_IDLE_MINUTES:-20}"
supervisor="${CI_RUNNER_SUPERVISOR:-/opt/ci-runner/supervisor.sh}"
systemctl="${CI_RUNNER_SYSTEMCTL:-systemctl}"
poweroff="${CI_RUNNER_POWEROFF:-systemctl poweroff}"
busy_file="${state_dir}/last-busy"

log() { echo "idle-stop: $*" >&2; }

[[ "$idle_minutes" =~ ^[0-9]+$ ]] || { log "CI_RUNNER_IDLE_MINUTES must be a whole number"; exit 64; }
(( idle_minutes > 0 )) || exit 0
mkdir -p "$state_dir"

slots=$(find "$state_dir" -maxdepth 1 -name 'slot-*.json' -printf '%f\n' 2>/dev/null \
  | sed -E 's/slot-([0-9]+)\.json/\1/' | sort -n)

# Busy now: restart the clock. /run is a tmpfs, so after a boot the file is
# missing and the clock starts at the first run, not at the last job before
# the machine went down.
for slot in $slots; do
  if [[ "$(jq -r '.phase // ""' "${state_dir}/slot-${slot}.json" 2>/dev/null)" == running ]]; then
    touch "$busy_file"; exit 0
  fi
done
[[ -e "$busy_file" ]] || { touch "$busy_file"; exit 0; }
idle_for=$(( $(date +%s) - $(stat -c %Y "$busy_file") ))
(( idle_for >= idle_minutes * 60 )) || exit 0

log "no job for ${idle_for}s; releasing the waiting runners"
stopped=()
for slot in $slots; do
  set +e
  CI_RUNNER_RELEASE_WAITING=1 "$supervisor" "$slot"
  rc=$?
  set -e
  if (( rc == 3 )); then
    log "slot ${slot} has just been handed a job; staying up"
    for s in "${stopped[@]}"; do "$systemctl" start "ci-runner@${s}.service"; done
    touch "$busy_file"
    exit 0
  fi
  (( rc == 0 )) || log "slot ${slot}: could not release its runner (exit ${rc}); stopping it anyway"
  "$systemctl" stop "ci-runner@${slot}.service"
  stopped+=("$slot")
done

log "every slot stopped; powering off"
$poweroff
