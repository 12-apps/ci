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

# The image carries no token and no identity of this host.
sed -i 's/^CI_RUNNER_TOKEN=.*/CI_RUNNER_TOKEN=/' /etc/ci-runner/env
rm -f /etc/ci-runner/token.env
cloud-init clean --logs --seed >/dev/null 2>&1 || true
truncate -s 0 /etc/machine-id
echo "prepare-golden: ready to image; deploy.sh GOLDEN_INSTANCE_ID=$(cloud-init query instance_id 2>/dev/null || echo '<this instance>')"
