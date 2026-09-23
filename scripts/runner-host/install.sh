#!/usr/bin/env bash
# Turn a fresh Ubuntu 24.04 machine into a pool of single-use GitHub runners.
#
#   GitHub App (preferred):
#   sudo CI_RUNNER_APP_ID=123456 CI_RUNNER_APP_KEY_FILE=./app.pem \
#        CI_RUNNER_SCOPE=repos/<owner>/<repo> CI_RUNNER_LABELS=<label> \
#        ./install.sh [slots]
#
#   or a fine-grained PAT: CI_RUNNER_TOKEN=github_pat_... instead of the App.
#
# Optional limits: CI_RUNNER_CPUS (per job, default cores/slots),
# CI_RUNNER_MEMORY (default 90% of RAM / slots), CI_RUNNER_DISK (per job, e.g.
# 40G), CI_RUNNER_JOB_TIMEOUT_MINUTES (default 360).
#
# Idempotent: re-run it to change the slot count or limits, rotate the
# credential, or pick up a new version of these scripts. Values not passed are
# kept from /etc/ci-runner/env. See README.md for sizing and the switch.
set -euo pipefail

die() { echo "install: $*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die "run as root (sudo)"
here="$(cd "$(dirname "$0")" && pwd)"
prefix=/opt/ci-runner
envfile=/etc/ci-runner/env

# ── configuration ────────────────────────────────────────────────────────────
# The memory cap follows the slot count, so only an explicit one survives a
# re-run; the value in the env file was computed for the previous count.
explicit_memory="${CI_RUNNER_MEMORY:-}"
explicit_cpus="${CI_RUNNER_CPUS:-}"
# What the caller passes wins; the previous install only fills the gaps. That
# order is what makes `CI_RUNNER_TOKEN=<new> ./install.sh` a token rotation.
if [[ -f "$envfile" ]]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^CI_RUNNER_[A-Z_]+$ && -z "${!key:-}" ]] && export "$key=$value"
  done < "$envfile"
fi
if [[ -n "${CI_RUNNER_APP_KEY_FILE:-}" && "$CI_RUNNER_APP_KEY_FILE" != /etc/ci-runner/app.pem ]]; then
  [[ -r "$CI_RUNNER_APP_KEY_FILE" ]] || die "CI_RUNNER_APP_KEY_FILE is not readable: $CI_RUNNER_APP_KEY_FILE"
  install -d -m 0700 /etc/ci-runner
  install -m 0600 "$CI_RUNNER_APP_KEY_FILE" /etc/ci-runner/app.pem
  CI_RUNNER_APP_KEY_FILE=/etc/ci-runner/app.pem
fi
[[ -n "${CI_RUNNER_APP_ID:-}" || -n "${CI_RUNNER_TOKEN:-}" ]] \
  || die "a credential is required on the first install: CI_RUNNER_APP_ID + CI_RUNNER_APP_KEY_FILE, or CI_RUNNER_TOKEN"
[[ -z "${CI_RUNNER_APP_ID:-}" || -r "${CI_RUNNER_APP_KEY_FILE:-}" ]] \
  || die "CI_RUNNER_APP_ID is set but no private key: pass CI_RUNNER_APP_KEY_FILE"
: "${CI_RUNNER_SCOPE:?CI_RUNNER_SCOPE is required (repos/<owner>/<repo> or orgs/<org>)}"
: "${CI_RUNNER_LABELS:?CI_RUNNER_LABELS is required (the value the repo sets as CI_RUNNER)}"
[[ "$CI_RUNNER_SCOPE" =~ ^(repos/[^/]+/[^/]+|orgs/[^/]+)$ ]] \
  || die "CI_RUNNER_SCOPE must be repos/<owner>/<repo> or orgs/<org>, got '$CI_RUNNER_SCOPE'"

cpus=$(nproc)
slots="${1:-${CI_RUNNER_SLOTS:-$(( cpus / 2 > 0 ? cpus / 2 : 1 ))}}"
[[ "$slots" =~ ^[1-9][0-9]*$ ]] || die "slots must be a positive integer, got '$slots'"
# A cap per slot, so one runaway job is OOM-killed alone instead of taking the
# host — and every other slot's job — down with it. 90% of RAM, split evenly.
mem_mb=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
CI_RUNNER_MEMORY="${explicit_memory:-$(( mem_mb * 9 / 10 / slots ))m}"
# CPU is shared, not partitioned: each job may use up to twice its fair share,
# so a lone job on a quiet host is not starved while one busy job cannot take
# every core from the others.
CI_RUNNER_CPUS="${explicit_cpus:-$(awk -v c="$cpus" -v s="$slots" 'BEGIN { v = 2 * c / s; if (v > c) v = c; printf "%.1f", v }')}"

# ── packages ─────────────────────────────────────────────────────────────────
apt-get update -q
apt-get install -y -q ca-certificates curl git jq openssl e2fsprogs
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Kernel limits are the HOST's, shared by every job container: vite and vitest
# watchers exhaust the stock inotify limits long before CPU or memory run out.
cat > /etc/sysctl.d/90-ci-runner.conf <<'SYSCTL'
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 8192
vm.max_map_count = 262144
SYSCTL
sysctl --quiet --system

# ── files ────────────────────────────────────────────────────────────────────
install -d "$prefix"
install -m 0644 "$here/Dockerfile" "$prefix/Dockerfile"
install -m 0755 "$here/entrypoint.sh" "$here/supervisor.sh" "$here/build-image.sh" \
  "$here/status.sh" "$here/uninstall.sh" "$prefix/"
ln -sf "$prefix/status.sh" /usr/local/bin/ci-runner-status

# Runner and supervisor logs go to journald; cap what they can take.
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/ci-runner.conf <<'JOURNAL'
[Journal]
SystemMaxUse=2G
SystemMaxFileSize=128M
MaxRetentionSec=30day
JOURNAL
systemctl restart systemd-journald

install -d -m 0700 /etc/ci-runner
umask 077
cat > "$envfile" <<ENV
CI_RUNNER_TOKEN=${CI_RUNNER_TOKEN:-}
CI_RUNNER_APP_ID=${CI_RUNNER_APP_ID:-}
CI_RUNNER_APP_KEY_FILE=${CI_RUNNER_APP_KEY_FILE:-}
CI_RUNNER_APP_INSTALLATION_ID=${CI_RUNNER_APP_INSTALLATION_ID:-}
CI_RUNNER_SCOPE=${CI_RUNNER_SCOPE}
CI_RUNNER_LABELS=${CI_RUNNER_LABELS}
CI_RUNNER_SLOTS=${slots}
CI_RUNNER_MEMORY=${CI_RUNNER_MEMORY}
CI_RUNNER_CPUS=${CI_RUNNER_CPUS}
CI_RUNNER_DISK=${CI_RUNNER_DISK:-}
CI_RUNNER_JOB_TIMEOUT_MINUTES=${CI_RUNNER_JOB_TIMEOUT_MINUTES:-360}
CI_RUNNER_IMAGE=${CI_RUNNER_IMAGE:-ci-runner:latest}
CI_RUNNER_BASE_IMAGE=${CI_RUNNER_BASE_IMAGE:-ubuntu:24.04}
ENV
umask 022

# Fail here, not in a restart loop: the credential must be able to manage
# runners on the scope. The same code path the slots use proves it.
set -a
# shellcheck disable=SC1090  # the path is ours, written above
. "$envfile"
set +a
CI_RUNNER_CHECK_ONLY=1 "$prefix/supervisor.sh" 0 \
  || die "the credential cannot manage runners on ${CI_RUNNER_SCOPE}: a GitHub App needs Administration (repo) or Self-hosted runners (org) read/write and must be installed on it; a PAT needs the same permission"

# ── image ────────────────────────────────────────────────────────────────────
CI_RUNNER_IMAGE="${CI_RUNNER_IMAGE:-ci-runner:latest}" \
CI_RUNNER_BASE_IMAGE="${CI_RUNNER_BASE_IMAGE:-ubuntu:24.04}" \
  "$prefix/build-image.sh"

# ── services ─────────────────────────────────────────────────────────────────
cat > /etc/systemd/system/ci-runner@.service <<UNIT
[Unit]
Description=GitHub Actions runner slot %i (one job per container)
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service
# Never give up on a slot: a GitHub outage or a revoked credential shows as a
# failure in ci-runner-status and recovers by itself once it is fixed.
StartLimitIntervalSec=0

[Service]
EnvironmentFile=${envfile}
ExecStart=${prefix}/supervisor.sh %i
ExecStop=-/usr/bin/docker stop --time 30 ci-runner-%i
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/ci-runner-image.service <<UNIT
[Unit]
Description=Rebuild the GitHub Actions runner image
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
EnvironmentFile=${envfile}
ExecStart=${prefix}/build-image.sh
UNIT

cat > /etc/systemd/system/ci-runner-image.timer <<'UNIT'
[Unit]
Description=Rebuild the GitHub Actions runner image weekly

[Timer]
OnCalendar=Sun 04:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now ci-runner-image.timer
for i in $(seq 1 "$slots"); do
  systemctl enable "ci-runner@${i}.service"
  systemctl restart "ci-runner@${i}.service"
done
# Shrinking: stop the slots above the new count.
for unit in $(systemctl list-units --all --plain --no-legend 'ci-runner@*.service' | awk '{print $1}'); do
  n="${unit#ci-runner@}"; n="${n%.service}"
  if (( n > slots )); then systemctl disable --now "$unit"; fi
done

echo "install: ${slots} slot(s), ${CI_RUNNER_CPUS} CPU / ${CI_RUNNER_MEMORY} / ${CI_RUNNER_DISK:-unbounded} disk each, labels '${CI_RUNNER_LABELS}' on ${CI_RUNNER_SCOPE}"
echo "install: now set the repository variable CI_RUNNER=${CI_RUNNER_LABELS%%,*}"
