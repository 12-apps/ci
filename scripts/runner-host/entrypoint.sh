#!/usr/bin/env bash
# Container entrypoint: a private dockerd, then exactly one job.
#
# Runs as root only long enough to start the daemon, then drops to `runner`.
# The JIT config arrives in the environment (never on a command line the host's
# `ps` could read) and is removed from it before the runner starts, because the
# runner hands its own environment down to every step of the job.
set -euo pipefail

if [[ -z "${RUNNER_JITCONFIG:-}" ]]; then
  echo "ci-runner: RUNNER_JITCONFIG is empty; nothing to run" >&2
  exit 64
fi
jit="$RUNNER_JITCONFIG"
unset RUNNER_JITCONFIG

# `localhost` must be 127.0.0.1 alone, as on ubuntu-latest (localhost.sh).
ci-runner-localhost

dockerd --host=unix:///var/run/docker.sock >/var/log/dockerd.log 2>&1 &
for _ in $(seq 1 120); do
  docker info >/dev/null 2>&1 && break
  sleep 0.5
done
if ! docker info >/dev/null 2>&1; then
  echo "ci-runner: dockerd did not come up; the job would fail on its first docker call" >&2
  tail -n 50 /var/log/dockerd.log >&2
  exit 70
fi

cd /home/runner/actions-runner
# With a per-job disk the workspace is a bind mount the host created as root.
mkdir -p _work && chown runner:runner _work
exec runuser -u runner -- ./run.sh --jitconfig "$jit"
