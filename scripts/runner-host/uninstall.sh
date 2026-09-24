#!/usr/bin/env bash
# Remove the runner host completely: services, running jobs, registrations on
# GitHub, images, files and the stored credential.
#
#   sudo ./uninstall.sh
#
# Docker itself stays installed: other things on the machine may use it.
#
# Deregistration uses the credential still in /etc/ci-runner/env; run this
# BEFORE revoking the GitHub App or PAT, or delete the runners by hand under
# Settings → Actions → Runners afterwards.
set -euo pipefail

[[ ${EUID} -eq 0 ]] || { echo "uninstall: run as root (sudo)" >&2; exit 1; }
envfile=/etc/ci-runner/env
prefix=/opt/ci-runner

# 1. Stop every slot: the unit's ExecStop and the supervisor's trap remove the
#    running containers and unmount the per-job disks.
units=$(systemctl list-units --all --plain --no-legend 'ci-runner*' 2>/dev/null | awk '{print $1}' || true)
for u in $units; do systemctl disable --now "$u" 2>/dev/null || true; done
docker ps -aq --filter name=ci-runner- | xargs -r docker rm -f >/dev/null 2>&1 || true

# 2. Deregister this host's runners on GitHub.
if [[ -r "$envfile" && -x "$prefix/supervisor.sh" ]]; then
  set -a
  # shellcheck disable=SC1090  # the path is ours
  . "$envfile"
  [[ -r /etc/ci-runner/token.env ]] && . /etc/ci-runner/token.env
  set +a
  if [[ -n "${CI_RUNNER_APP_ID:-}${CI_RUNNER_TOKEN:-}" ]]; then
    CI_RUNNER_DEREGISTER_ONLY=1 "$prefix/supervisor.sh" 0 \
      || echo "uninstall: could not deregister runners; delete them under Settings → Actions → Runners" >&2
  fi
fi

# 3. Files, units, state, per-job disks, logs config.
for m in /var/lib/ci-runner/slot-*; do mountpoint -q "$m" 2>/dev/null && umount -l "$m"; done
rm -f /etc/systemd/system/ci-runner@.service /etc/systemd/system/ci-runner-image.service \
      /etc/systemd/system/ci-runner-image.timer /etc/systemd/system/ci-runner-idle.service \
      /etc/systemd/system/ci-runner-idle.timer /etc/systemd/system/ci-runner-credential.service \
      /etc/systemd/journald.conf.d/ci-runner.conf \
      /etc/sysctl.d/90-ci-runner.conf /usr/local/bin/ci-runner-status
systemctl daemon-reload
systemctl restart systemd-journald 2>/dev/null || true
rm -rf "$prefix" /var/lib/ci-runner /run/ci-runner
# The credential last: shred what can be shredded.
[[ -d /etc/ci-runner ]] && find /etc/ci-runner -type f -exec shred -u {} + 2>/dev/null
rm -rf /etc/ci-runner

# 4. Images.
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^ci-runner:' | xargs -r docker rmi -f >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1 || true

echo "uninstall: Docker left installed; remove it with your package manager if nothing else uses it"
echo "uninstall: done. Also revoke the GitHub App installation (or PAT) and delete the CI_RUNNER repository variable."
