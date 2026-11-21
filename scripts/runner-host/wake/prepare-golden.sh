#!/usr/bin/env bash
# Turn this host into the source of the fleet AMI (deploy.sh images it).
#
#   sudo [PNPM_STORE_PACKAGES=packages.txt] ./prepare-golden.sh [slots]   (on the host, from a checkout)
#
# Installs the kit in fleet mode: the token is read from SSM at every boot
# (nothing secret on disk, so nothing secret in the image), and the host
# powers off after CI_RUNNER_IDLE_MINUTES (default 5) without a job, which
# the launch template turns into a TERMINATE. Then it forgets what makes it
# this particular machine, so every host launched from the image comes up as
# itself.
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo "prepare-golden: run as root" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
slots="${1:-2}"

# Packages change HERE, once a week, and never on a fleet host (FUT-5281).
# A host lives minutes, so it has no business patching itself: with Ubuntu's
# unattended-upgrades on, every host booted after a security release upgraded
# libc about a minute after boot, needrestart restarted containerd and dockerd,
# and the runner slots died with their jobs. So the image takes every pending
# upgrade now, and the host it boots carries nothing that installs or restarts
# on its own: no apt timers, no unattended-upgrades, no needrestart. The weekly
# image refresh is the patch cadence.
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -yq -o Dpkg::Options::=--force-confold full-upgrade
apt-get -yq purge unattended-upgrades needrestart || true
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service >/dev/null
printf 'APT::Periodic::Update-Package-Lists "0";\nAPT::Periodic::Unattended-Upgrade "0";\n' > /etc/apt/apt.conf.d/20auto-upgrades
# Snaps refresh themselves too (snapd, the SSM agent): held for good. The
# refresh updates them here, before the hold.
if command -v snap >/dev/null; then snap refresh >/dev/null 2>&1 || true; snap refresh --hold >/dev/null; fi

CI_RUNNER_TOKEN="" CI_RUNNER_TOKEN_PARAMETER="${CI_RUNNER_TOKEN_PARAMETER:-/ci-runner/github-app-key}" \
CI_RUNNER_IDLE_MINUTES="${CI_RUNNER_IDLE_MINUTES:-5}" \
  "$here/../install.sh" "$slots"

# A warm pnpm store for the jobs, when a package list is given
# (PNPM_STORE_PACKAGES, from pnpm-store-packages.mjs).
if [[ -n "${PNPM_STORE_PACKAGES:-}" ]]; then
  "$here/../warm-pnpm-store.sh" "$PNPM_STORE_PACKAGES" /var/lib/ci-runner/pnpm-store
  sed -i '/^CI_RUNNER_PNPM_STORE=/d' /etc/ci-runner/env
  echo "CI_RUNNER_PNPM_STORE=/var/lib/ci-runner/pnpm-store" >> /etc/ci-runner/env
fi

# The image is built here and nowhere else: the kit's weekly rebuild timer
# (install.sh, for a long-lived host) never runs on a fleet host, which would
# otherwise rebuild the runner image at boot (Persistent=true) under its jobs.
# Disabled, not masked: install.sh writes the timer as a regular file in
# /etc/systemd/system, which `systemctl mask` refuses, and next week's golden
# host (launched from this image) re-runs install.sh, which enables it.
systemctl disable --now ci-runner-image.timer >/dev/null

# The image carries no token and no identity of this host.
sed -i 's/^CI_RUNNER_TOKEN=.*/CI_RUNNER_TOKEN=/' /etc/ci-runner/env
rm -f /etc/ci-runner/token.env
cloud-init clean --logs --seed >/dev/null 2>&1 || true
truncate -s 0 /etc/machine-id
# deploy.sh has no defaults for the fleet it deploys: the hint names them all.
echo "prepare-golden: ready to image; GOLDEN_INSTANCE_ID=$(cloud-init query instance_id 2>/dev/null || echo '<this instance>') AWS_REGION=<home region> REPOSITORY=<owner/repo> RUNNER_LABEL=<label> FUNCTION_NAME=<scaler> deploy.sh"
