#!/usr/bin/env bash
# Delegate the cgroup v2 controllers to the job's own containers.
#
# A slot is a privileged container with its own dockerd (supervisor.sh). On a
# cgroup v2 host that container gets a private cgroup namespace whose root,
# /sys/fs/cgroup, enables NO controller for its children: the inner dockerd
# then starts every container without memory, cpu or io accounting, and
# `docker stats` reads each one as `0B / 0B`. Measured on future-pay's fleet
# (FUT-5708, run 45887319544): cgroup v2, an empty cgroup.subtree_control, and
# a running redis read `0B / 0B`, so its memory budget could measure nothing.
#
# cgroup v2 refuses to enable a controller for children while the cgroup
# itself holds processes ("no internal processes"), so every process moves to
# a leaf, `init`, first. The official docker:dind image does the same.
#
# Runs as root, from the entrypoint, before the usage sampler and dockerd. On
# cgroup v1 there is nothing to delegate and it does nothing. A failure here
# leaves the slot as it was before, so it never costs a job: it warns and
# exits 0.
#
# Env (tests): CI_RUNNER_CGROUP (default /sys/fs/cgroup).
set -uo pipefail
cg="${CI_RUNNER_CGROUP:-/sys/fs/cgroup}"

[[ -f "$cg/cgroup.controllers" ]] || exit 0

warn() { echo "ci-runner-cgroup-nest: $*" >&2; exit 0; }

mkdir -p "$cg/init" || warn "cannot create $cg/init; containers keep no accounting"
# A process can start between the read and the write, so the move is repeated
# until the root holds none. `mapfile` reads without forking (a fork would be
# a new process in the root), and a cgroupfs file reports size 0, so the list
# itself is what is checked (FUT-5708: a `-s` test stopped after one round).
for _ in 1 2 3 4 5 6 7 8 9 10; do
  mapfile -t pids < "$cg/cgroup.procs"
  (( ${#pids[@]} == 0 )) && break
  for pid in "${pids[@]}"; do
    [[ -n "$pid" ]] && { echo "$pid" > "$cg/init/cgroup.procs"; } 2>/dev/null
  done
done
mapfile -t left < "$cg/cgroup.procs"

# One write per controller: the kernel refuses a whole list when it refuses any
# one of it (`Device or resource busy` on a GitHub VM, 2026-11-26, for a list
# of nine). runc enables what a container needs on its own once the root is
# empty, so a refused controller is named here and costs nothing else.
refused=()
read -r -a controllers < "$cg/cgroup.controllers" || true
for c in "${controllers[@]}"; do
  echo "+$c" > "$cg/cgroup.subtree_control" 2>/dev/null || refused+=("$c")
done
if (( ${#refused[@]} > 0 )); then
  names=()
  for pid in "${left[@]}"; do names+=("${pid}:$(cat "/proc/${pid}/comm" 2>/dev/null || echo gone)"); done
  warn "the kernel refused to delegate: ${refused[*]} (processes still in the root: ${names[*]:-none})"
fi
