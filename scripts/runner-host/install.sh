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
# Optional limits: CI_RUNNER_PIN_CPUS (default 1: each slot owns cores/slots
# cores), CI_RUNNER_CPUS (a quota instead, unset by default), CI_RUNNER_MEMORY
# (default `auto`, 90% of RAM / slots at each job start), CI_RUNNER_DISK (per job, e.g.
# 40G), CI_RUNNER_JOB_TIMEOUT_MINUTES (default 360).
#
# CI_RUNNER_IDLE_MINUTES: power the host off after this long with no job
# (default 0, never). Set it only once something starts the host again when a
# job is queued — wake/README.md — or queued jobs wait for a person.
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
# CI_RUNNER_TOKEN_PARAMETER: an SSM SecureString holding the PAT, fetched on
# every boot by ci-runner-credential.service instead of stored in the env
# file. A host baked into an AMI then carries no secret, and every host
# launched from it reads the current token.
token_file=/etc/ci-runner/token.env
if [[ -n "${CI_RUNNER_TOKEN_PARAMETER:-}" ]]; then
  : "${CI_RUNNER_REGION:=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
    | xargs -I{} curl -fsS -H 'X-aws-ec2-metadata-token: {}' http://169.254.169.254/latest/meta-data/placement/region)}"
  export CI_RUNNER_REGION
  CI_RUNNER_TOKEN=""
fi
[[ -n "${CI_RUNNER_APP_ID:-}" || -n "${CI_RUNNER_TOKEN:-}" || -n "${CI_RUNNER_TOKEN_PARAMETER:-}" ]] \
  || die "a credential is required on the first install: CI_RUNNER_APP_ID + CI_RUNNER_APP_KEY_FILE, CI_RUNNER_TOKEN, or CI_RUNNER_TOKEN_PARAMETER"
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
# host — and every other slot's job — down with it. `auto` is 90% of RAM split
# evenly, computed by the supervisor when each job starts, so an image baked on
# one instance size is right on another.
CI_RUNNER_MEMORY="${explicit_memory:-auto}"
# CPU is partitioned, not shared: each slot owns cores / slots cores
# (supervisor.sh, CI_RUNNER_PIN_CPUS), so what a job sees is what it gets and
# its tools size their worker pools to it. A quota is only set when asked for.
CI_RUNNER_CPUS="${explicit_cpus:-}"

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
  "$here/status.sh" "$here/uninstall.sh" "$here/idle-stop.sh" "$here/fetch-credential.sh" "$prefix/"
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
CI_RUNNER_PIN_CPUS=${CI_RUNNER_PIN_CPUS:-1}
CI_RUNNER_DISK=${CI_RUNNER_DISK:-}
CI_RUNNER_JOB_TIMEOUT_MINUTES=${CI_RUNNER_JOB_TIMEOUT_MINUTES:-360}
CI_RUNNER_IDLE_MINUTES=${CI_RUNNER_IDLE_MINUTES:-0}
CI_RUNNER_TOKEN_PARAMETER=${CI_RUNNER_TOKEN_PARAMETER:-}
CI_RUNNER_REGION=${CI_RUNNER_REGION:-}
CI_RUNNER_IMAGE=${CI_RUNNER_IMAGE:-ci-runner:latest}
CI_RUNNER_BASE_IMAGE=${CI_RUNNER_BASE_IMAGE:-ubuntu:24.04}
ENV
umask 022

# Fail here, not in a restart loop: the credential must be able to manage
# runners on the scope. The same code path the slots use proves it.
if [[ -n "${CI_RUNNER_TOKEN_PARAMETER:-}" ]]; then
  "$prefix/fetch-credential.sh" || die "could not read ${CI_RUNNER_TOKEN_PARAMETER} from SSM"
else
  rm -f "$token_file"
fi
set -a
# shellcheck disable=SC1090  # the paths are ours, written above
. "$envfile"
[[ -r "$token_file" ]] && . "$token_file"
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
Wants=network-online.target ci-runner-credential.service
After=ci-runner-credential.service
Requires=docker.service
# Never give up on a slot: a GitHub outage or a revoked credential shows as a
# failure in ci-runner-status and recovers by itself once it is fixed.
StartLimitIntervalSec=0

[Service]
EnvironmentFile=${envfile}
EnvironmentFile=-${token_file}
ExecStart=${prefix}/supervisor.sh %i
# Stop = SIGTERM to the supervisor alone; its trap removes the container, the
# per-job disk and the slot's own registration, then exits 143. No ExecStop:
# stopping the container first let the loop see a finished job and register a
# fresh runner in the moment before the SIGTERM arrived.
KillMode=mixed
TimeoutStopSec=60
SuccessExitStatus=143
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

cat > /etc/systemd/system/ci-runner-idle.service <<UNIT
[Unit]
Description=Power the CI host off when no job has run for CI_RUNNER_IDLE_MINUTES

[Service]
Type=oneshot
EnvironmentFile=${envfile}
EnvironmentFile=-${token_file}
ExecStart=${prefix}/idle-stop.sh
UNIT

cat > /etc/systemd/system/ci-runner-idle.timer <<'UNIT'
[Unit]
Description=Check every minute whether the CI host has gone idle

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/ci-runner-credential.service <<UNIT
[Unit]
Description=Fetch the runner credential from SSM (CI_RUNNER_TOKEN_PARAMETER)
After=network-online.target
Wants=network-online.target
ConditionPathExists=${envfile}

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=${envfile}
ExecStart=${prefix}/fetch-credential.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable ci-runner-credential.service
systemctl enable --now ci-runner-image.timer ci-runner-idle.timer
# Running slots are DRAINED, never restarted: a restart removes the job a slot
# is running. Each finishes its job (or releases its waiting runner at once),
# exits, and systemd starts it again on the scripts just installed. The
# request is touched before new slots start, so they do not answer it.
install -d /run/ci-runner
touch /run/ci-runner/drain
for i in $(seq 1 "$slots"); do
  systemctl enable "ci-runner@${i}.service"
  systemctl is-active --quiet "ci-runner@${i}.service" || systemctl start "ci-runner@${i}.service"
done
# Shrinking: stop the slots above the new count.
for unit in $(systemctl list-units --all --plain --no-legend 'ci-runner@*.service' | awk '{print $1}'); do
  n="${unit#ci-runner@}"; n="${n%.service}"
  if (( n > slots )); then systemctl disable --now "$unit"; fi
done

echo "install: ${slots} slot(s), $( [[ "${CI_RUNNER_PIN_CPUS:-1}" != 0 ]] && echo "$(( cpus / slots )) pinned cores" || echo "${CI_RUNNER_CPUS:-shared} CPU" ) / ${CI_RUNNER_MEMORY} memory / ${CI_RUNNER_DISK:-unbounded} disk each, labels '${CI_RUNNER_LABELS}' on ${CI_RUNNER_SCOPE}"
echo "install: now set the repository variable CI_RUNNER=${CI_RUNNER_LABELS%%,*}"
