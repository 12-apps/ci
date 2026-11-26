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
# until the root holds none (a few rounds at most; bounded all the same).
for _ in 1 2 3 4 5; do
  moved=0
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    echo "$pid" > "$cg/init/cgroup.procs" 2>/dev/null && moved=1
  done < "$cg/cgroup.procs"
  [[ "$moved" == 1 ]] || break
  [[ -s "$cg/cgroup.procs" ]] || break
done

controllers=$(sed -e 's/^ *//' -e 's/ *$//' -e 's/  */ /g' "$cg/cgroup.controllers")
[[ -n "$controllers" ]] || exit 0
echo "+${controllers// / +}" > "$cg/cgroup.subtree_control" \
  || warn "could not enable '${controllers}' for the job's containers; they keep no accounting"
