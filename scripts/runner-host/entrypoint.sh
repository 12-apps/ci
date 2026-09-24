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

# Docker exports HOSTNAME=<container id>, which resolves to the container's
# bridge address; GitHub's runner VM exports no HOSTNAME at all. The runner
# hands its environment to every step, and servers that read it as their bind
# address (future-pay's `process.env.HOSTNAME ?? "0.0.0.0"`) then listen on
# 172.17.0.x alone: Playwright's web servers never answered on localhost.
unset HOSTNAME

cd /home/runner/actions-runner
# The work folder is /home/runner/work, where GitHub's runners keep it
# (supervisor.sh). With a per-job disk it is a bind mount the host created as root.
mkdir -p /home/runner/work && chown runner:runner /home/runner/work
exec runuser -u runner -- ./run.sh --jitconfig "$jit"
