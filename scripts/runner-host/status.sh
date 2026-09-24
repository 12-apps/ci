#!/usr/bin/env bash
# ci-runner-status — the state of every runner slot on this machine.
#
#   ci-runner-status            human-readable table
#   ci-runner-status --json     the same, one JSON object per slot
#
# Reads what the supervisors write to $CI_RUNNER_STATE_DIR (default
# /run/ci-runner) plus systemd, Docker and the kernel. It prints names, times,
# PIDs and usage — never an environment, a command line or a credential.
# Exit status: 0 when every enabled slot is healthy, 1 otherwise, so it can
# back a monitoring probe.
set -euo pipefail

state_dir="${CI_RUNNER_STATE_DIR:-/run/ci-runner}"
data_dir="${CI_RUNNER_DATA_DIR:-/var/lib/ci-runner}"
stale_after="${CI_RUNNER_STALE_SECONDS:-120}"
json=false
[[ "${1:-}" == "--json" ]] && json=true

now=$(date +%s)
unhealthy=0
rows=()

slots=$(systemctl list-units --all --plain --no-legend 'ci-runner@*.service' 2>/dev/null \
  | awk '{print $1}' | sed -E 's/ci-runner@([0-9]+)\.service/\1/' | sort -n || true)
[[ -z "$slots" ]] && slots=$(find "$state_dir" -maxdepth 1 -name 'slot-*.json' -printf '%f\n' 2>/dev/null \
  | sed -E 's/slot-([0-9]+)\.json/\1/' | sort -n || true)

for slot in $slots; do
  unit="ci-runner@${slot}.service"
  active=$(systemctl is-active "$unit" 2>/dev/null || true)
  f="${state_dir}/slot-${slot}.json"
  s='{}'
  [[ -r "$f" ]] && s=$(cat "$f")
  heartbeat=$(jq -r '.heartbeat // 0' <<<"$s")
  age=$(( heartbeat > 0 ? now - heartbeat : -1 ))
  container=$(jq -r '.container // ""' <<<"$s")
  usage='{}'
  if [[ -n "$container" ]] && docker inspect "$container" >/dev/null 2>&1; then
    usage=$(docker stats --no-stream --format '{"cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}"}' "$container" 2>/dev/null || echo '{}')
  fi
  disk=""
  if mountpoint -q "${data_dir}/slot-${slot}" 2>/dev/null; then
    disk=$(df -h --output=used,size "${data_dir}/slot-${slot}" | tail -n1 | awk '{print $1"/"$2}')
  fi
  healthy=true
  [[ "$active" == active ]] || healthy=false
  (( age >= 0 && age <= stale_after )) || healthy=false
  [[ "$(jq -r '.phase // ""' <<<"$s")" == failed ]] && healthy=false
  $healthy || unhealthy=1
  rows+=("$(jq -c -n --arg slot "$slot" --arg service "$active" --argjson state "$s" \
    --argjson usage "$usage" --arg age "$age" --arg disk "$disk" --argjson healthy "$healthy" \
    '{slot:$slot, service:$service, phase:($state.phase // "unknown"), runner:($state.runner // ""),
      job:($state.job // ""), job_started:($state.job_started // ""), pid:($state.pid // ""),
      heartbeat_age_s:($age|tonumber), cpu:($usage.cpu // ""), mem:($usage.mem // ""),
      disk:$disk, last_failure:($state.last_failure // ""),
      last_failure_at:($state.last_failure_at // ""), healthy:$healthy}')")
done

if $json; then
  printf '%s\n' "${rows[@]}"
  exit "$unhealthy"
fi

printf '%-4s %-9s %-11s %-6s %-5s %-7s %-22s %-10s %s\n' SLOT SERVICE PHASE PID BEAT CPU MEM DISK JOB
for r in "${rows[@]}"; do
  jq -r '[.slot, .service, .phase, (.pid|tostring), ((.heartbeat_age_s|tostring)+"s"),
          .cpu, .mem, .disk, .job] | @tsv' <<<"$r" \
    | awk -F'\t' '{printf "%-4s %-9s %-11s %-6s %-5s %-7s %-22s %-10s %s\n",$1,$2,$3,$4,$5,$6,$7,$8,$9}'
done
echo
echo "last failures:"
for r in "${rows[@]}"; do
  jq -r 'select(.last_failure != "") | "  slot \(.slot) at \(.last_failure_at): \(.last_failure)"' <<<"$r"
done
echo
printf 'host: load %s | mem %s | disk / %s\n' \
  "$(cut -d' ' -f1-3 /proc/loadavg)" \
  "$(free -h | awk '/^Mem:/ {print $3"/"$2}')" \
  "$(df -h --output=used,size / | tail -n1 | awk '{print $1"/"$2}')"
exit "$unhealthy"
