#!/usr/bin/env bash
# What one job used: memory, CPU, disk, and whether it waited on any of them.
#
# A slot is sized by guess today (half an 8-core host, ~14 GB). Whether a job
# would run as fast in 4 GB and 2 cores, or needs the r-type's 64 GB, is only
# answerable per job, from the job's own container. Each job runs in its own
# container (supervisor.sh), so that container's cgroup IS the job: its
# counters cover the runner, the inner dockerd and every service container the
# job starts.
#
# Three modes, one file:
#
#   sample   run by the entrypoint as root for the container's whole life. Once
#            a second it tracks what a single end-of-job read cannot give:
#              - the peak WORKING SET (memory.current minus inactive page
#                cache). memory.peak counts page cache the kernel would drop
#                under pressure, so it overstates what the job needs;
#              - the peak cores used over any 5 s window;
#              - the peak disk IOPS and MB/s over any 5 s window.
#            (The network needs no sampler: its totals are enough.)
#            The maxima restart when the job starts, so the runner's own boot
#            is not billed to the job.
#   start    the runner's job-started hook: records the counters at t0.
#   report   the runner's job-completed hook: prints ONE line to the job log,
#              ci-runner-usage {"wallMs":…,"peakWorkingSetMiB":…,…}
#            which usage-report.mjs collects from the logs of every job.
#
# `netTxMiB`/`netRxMiB` are what the job sent and received on the container's
# own interface, which carries its service containers' traffic too. What a
# fleet host SENDS is billed as internet egress (~US$ 0.09/GB), so this is how
# an upload-heavy job is found.
#
# The `*Pct` fields are pressure stall information: the share of the job's wall
# time in which some task waited for CPU, for memory, or for disk. A job at 2%
# CPU wait would not finish sooner on more cores; one at 40% would.
#
# A hook that fails fails the JOB, so every mode swallows its own errors and
# exits 0. Nothing here may cost a job.
#
# Env (tests): CI_USAGE_CGROUP (default /sys/fs/cgroup), CI_USAGE_DIR (default
# /run/ci-runner-usage), CI_USAGE_UPTIME (default /proc/uptime),
# CI_USAGE_NETDEV (default /proc/net/dev),
# CI_USAGE_INTERVAL (sampler period in seconds, default 1),
# CI_USAGE_WINDOW_MS (rate window, default 5000).

cg="${CI_USAGE_CGROUP:-/sys/fs/cgroup}"
dir="${CI_USAGE_DIR:-/run/ci-runner-usage}"
uptime_file="${CI_USAGE_UPTIME:-/proc/uptime}"
window_ms="${CI_USAGE_WINDOW_MS:-5000}"

now_ms() { date +%s%3N; }
# `key value` files: memory.stat, cpu.stat, memory.events.
field() { awk -v k="$2" '$1 == k { print $2; found = 1; exit } END { if (!found) print 0 }' "$cg/$1" 2>/dev/null || echo 0; }
# PSI: the cumulative stall in microseconds, `some` or `full`.
stall() {
  awk -v kind="$2" '$1 == kind { for (i = 2; i <= NF; i++) if ($i ~ /^total=/) { sub(/^total=/, "", $i); print $i; found = 1 } }
    END { if (!found) print 0 }' "$cg/$1.pressure" 2>/dev/null || echo 0
}
# io.stat, summed over every device: `<ios> <bytes>`.
io_totals() {
  awk '{ for (i = 2; i <= NF; i++) { split($i, kv, "="); if (kv[1] ~ /^[rw]ios$/) ios += kv[2]; if (kv[1] ~ /^[rw]bytes$/) bytes += kv[2] } }
    END { printf "%d %d\n", ios, bytes }' "$cg/io.stat" 2>/dev/null || echo "0 0"
}
# /proc/net/dev: `<rx bytes> <tx bytes>` over the container's own interfaces.
# The inner dockerd's bridge and veths are skipped: that traffic reaches the
# outside through eth0 and would be counted twice.
net_totals() {
  awk -F'[: ]+' 'NR > 2 { i = ($1 == "" ? 2 : 1); if ($i ~ /^(lo|docker|veth|br-)/) next; rx += $(i + 1); tx += $(i + 9) }
    END { printf "%d %d\n", rx, tx }' "${CI_USAGE_NETDEV:-/proc/net/dev}" 2>/dev/null || echo "0 0"
}
num() { local v="${1:-0}"; [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0; }

sample() {
  mkdir -p "$dir" && chmod 1777 "$dir"
  local ws_max=0 anon_max=0 mcores_max=0 iops_max=0 mbps_max=0 started=0
  local t0 u0 ios0 bytes0
  t0=$(now_ms); u0=$(num "$(field cpu.stat usage_usec)"); read -r ios0 bytes0 < <(io_totals)
  while :; do
    if (( ! started )) && [[ -f "$dir/start" ]]; then
      started=1; ws_max=0; anon_max=0; mcores_max=0; iops_max=0; mbps_max=0
    fi
    local cur inactive anon ws
    cur=$(num "$(cat "$cg/memory.current" 2>/dev/null)")
    inactive=$(num "$(field memory.stat inactive_file)")
    anon=$(num "$(field memory.stat anon)")
    ws=$(( cur > inactive ? cur - inactive : 0 ))
    (( ws > ws_max )) && ws_max=$ws
    (( anon > anon_max )) && anon_max=$anon

    local t u ios bytes dt
    t=$(now_ms); dt=$(( t - t0 ))
    if (( dt >= window_ms )); then
      u=$(num "$(field cpu.stat usage_usec)"); read -r ios bytes < <(io_totals)
      # The counters only grow. A read that failed comes back 0, and taking it
      # as the new baseline would bill the whole counter to the next window as
      # one impossible spike: such a window is skipped, baseline kept.
      if (( u > 0 && u >= u0 && ios >= ios0 && bytes >= bytes0 )); then
        # usec over ms is thousandths of a core.
        local mcores=$(( (u - u0) / dt )) iops=$(( (ios - ios0) * 1000 / dt )) mbps=$(( (bytes - bytes0) * 1000 / dt / 1048576 ))
        (( mcores > mcores_max )) && mcores_max=$mcores
        (( iops > iops_max )) && iops_max=$iops
        (( mbps > mbps_max )) && mbps_max=$mbps
        t0=$t; u0=$u; ios0=$ios; bytes0=$bytes
      fi
    fi
    printf '%d %d %d %d %d\n' "$ws_max" "$anon_max" "$mcores_max" "$iops_max" "$mbps_max" > "$dir/peaks.tmp" \
      && mv -f "$dir/peaks.tmp" "$dir/peaks"
    sleep "${CI_USAGE_INTERVAL:-1}"
  done
}

counters() {
  local ios bytes rx tx
  read -r ios bytes < <(io_totals)
  read -r rx tx < <(net_totals)
  printf '%d %d %d %d %d %d %d %d %d %d\n' "$(now_ms)" "$(num "$(field cpu.stat usage_usec)")" \
    "$(num "$(stall cpu some)")" "$(num "$(stall memory some)")" "$(num "$(stall memory full)")" \
    "$(num "$(stall io some)")" "$ios" "$bytes" "$(num "$rx")" "$(num "$tx")"
}

start() {
  mkdir -p "$dir" 2>/dev/null
  counters > "$dir/start.tmp" && mv -f "$dir/start.tmp" "$dir/start"
}

report() {
  local t0 u0 cpu0 mem0 memfull0 io0 ios0 bytes0 rx0 tx0
  local t1 u1 cpu1 mem1 memfull1 io1 ios1 bytes1 rx1 tx1
  read -r t1 u1 cpu1 mem1 memfull1 io1 ios1 bytes1 rx1 tx1 < <(counters)
  if ! read -r t0 u0 cpu0 mem0 memfull0 io0 ios0 bytes0 rx0 tx0 < "$dir/start" 2>/dev/null; then
    echo "ci-runner-usage: no job-start counters; nothing to report"
    return 0
  fi
  local ws_max=0 anon_max=0 mcores_max=0 iops_max=0 mbps_max=0
  [[ -r "$dir/peaks" ]] && read -r ws_max anon_max mcores_max iops_max mbps_max < "$dir/peaks"

  local wall_ms=$(( t1 > t0 ? t1 - t0 : 1 )) wall_us
  wall_us=$(( wall_ms * 1000 ))
  local limit cpus boot_s up_s
  limit=$(cat "$cg/memory.max" 2>/dev/null); [[ "$limit" =~ ^[0-9]+$ ]] && limit=$(( limit / 1048576 )) || limit=null
  cpus=$(awk -F, '{ n = 0; for (i = 1; i <= NF; i++) { split($i, r, "-"); n += (r[2] == "" ? 1 : r[2] - r[1] + 1) } print n }' \
    "$cg/cpuset.cpus.effective" 2>/dev/null)
  [[ "$cpus" =~ ^[0-9]+$ ]] || cpus=null
  up_s=$(awk '{ printf "%d", $1 }' "$uptime_file" 2>/dev/null)
  boot_s=$(( t1 / 1000 - $(num "$up_s") ))

  # Percentages to one decimal, as integers of tenths, so bash can do it.
  pct() { local d=$(( $1 * 1000 / wall_us )); printf '%d.%d' $(( d / 10 )) $(( d % 10 )); }
  printf 'ci-runner-usage {"v":1,"runner":"%s","hostBootS":%d,"startMs":%d,"wallMs":%d,' \
    "${RUNNER_NAME:-}" "$boot_s" "$t0" "$wall_ms"
  printf '"cpus":%s,"limitMiB":%s,"cpuSec":%d,"avgCores":%s,"peakCores":%s,' \
    "$cpus" "$limit" $(( (u1 - u0) / 1000000 )) \
    "$(awk -v u=$(( u1 - u0 )) -v w="$wall_us" 'BEGIN { printf "%.2f", u / w }')" \
    "$(awk -v m="$mcores_max" 'BEGIN { printf "%.2f", m / 1000 }')"
  printf '"peakWorkingSetMiB":%d,"peakAnonMiB":%d,"peakMiB":%d,"oomKills":%d,' \
    $(( ws_max / 1048576 )) $(( anon_max / 1048576 )) $(( $(num "$(cat "$cg/memory.peak" 2>/dev/null)") / 1048576 )) \
    "$(num "$(field memory.events oom_kill)")"
  printf '"cpuWaitPct":%s,"memWaitPct":%s,"memStallPct":%s,"ioWaitPct":%s,' \
    "$(pct $(( cpu1 - cpu0 )))" "$(pct $(( mem1 - mem0 )))" "$(pct $(( memfull1 - memfull0 )))" "$(pct $(( io1 - io0 )))"
  printf '"diskIos":%d,"diskMiB":%d,"peakIops":%d,"peakDiskMiBps":%d,' \
    $(( ios1 - ios0 )) $(( (bytes1 - bytes0) / 1048576 )) "$iops_max" "$mbps_max"
  printf '"netRxMiB":%d,"netTxMiB":%d}\n' $(( (${rx1:-0} - ${rx0:-0}) / 1048576 )) $(( (${tx1:-0} - ${tx0:-0}) / 1048576 ))
}

case "${1:-$(basename "$0")}" in
  sample) sample ;;
  start | *started*) start ;;
  report | *completed*) report ;;
  *) echo "usage: job-usage.sh sample|start|report" >&2 ;;
esac
exit 0
