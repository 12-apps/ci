#!/usr/bin/env bash
# Rebuild the fleet's image from a ci commit, prove a fresh host from it
# works, and redeploy it with the settings the fleet runs today.
#
#   AWS_REGION=<home region> RUNNER_LABEL=<label> FUNCTION_NAME=<scaler> \
#     CI_REF=<sha> SUBNET_ID=subnet-… SECURITY_GROUP_ID=sg-… \
#     INSTANCE_PROFILE_ARN=arn:aws:iam::…:instance-profile/ci-runner-host \
#     ./refresh-image.sh
#
# Every one of them is required. A default would name one consumer's fleet, and
# a second consumer that forgot a variable would rebuild and redeploy that one.
#
# Why it exists: hosts live minutes and terminate, so nothing on them ever
# updates. Every host runs the GitHub runner, Node and OS packages the image
# was built with, and GitHub stops accepting a runner that falls too far
# behind its latest release. A consumer calls runner-image-refresh.yml weekly.
#
# Steps, each of which stops the run on failure, and every instance it starts
# is terminated on exit whatever happened:
#   1. a golden host from the image the fleet launches now, updated to CI_REF
#      and prepared by prepare-golden.sh, then imaged;
#   2. a FRESH host from the new image: the runner image, its runner binary,
#      Node in the tool cache and the slot units must all be there. A failure
#      here deploys nothing;
#   3. deploy.sh with AMI_ID and the fleet's live settings (live-settings.mjs:
#      budget, regions, idle minutes, pnpm store, and the webhook secret, so a
#      refresh never rotates it), which copies the image to every region,
#      points the templates at it and prunes the old images.
#
# GOLDEN_BASE picks what the golden host starts from:
#   fleet  (default) the image the fleet launches now, updated in place;
#   ubuntu the latest Canonical Ubuntu 24.04 image, on a ROOT_GB root volume,
#          with the kit installed from scratch.
# Why `ubuntu` exists: an image built from the previous one inherits every
# block that image ever wrote. EBS takes no discard, so fstrim cannot give them
# back, and the snapshot only grows. On 2026-09-29 hosts used ~27 GB of a
# 116 GB root while the snapshot was 76 GB. Every region's copy, every
# snapshot and every host's volume pays for that. A clean base resets it, and
# ROOT_GB sizes the root (deploy.sh then launches the fleet at the new image's
# size). ROOT_GB is refused with `fleet`: a volume cannot be smaller than the
# snapshot it is made from.
#
# Neither host registers a runner. The smoke host's user data blanks the token
# parameter before any slot starts. The golden host needs the real parameter in
# its env file (the image carries it), so its slots and idle timer are held by
# a runtime drop-in under /run, which the image does not capture.
#
# Every instance is tagged ci-runner-refresh=$REFRESH_ID, so the workflow's
# always() step can terminate what a cancelled or timed-out run left behind:
# the runner SIGKILLs the step's process tree, and no EXIT trap runs then.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
region="${AWS_REGION:?set AWS_REGION to the home region of the fleet}"
label="${RUNNER_LABEL:?set RUNNER_LABEL to the runner label of the fleet}"
fn="${FUNCTION_NAME:?set FUNCTION_NAME to the scaler Lambda of the fleet}"
ref="${CI_REF:?set CI_REF to the ci commit the image should run}"
: "${SUBNET_ID:?}" "${SECURITY_GROUP_ID:?}" "${INSTANCE_PROFILE_ARN:?}"
template="ci-runner-fleet-${label}"
refresh_id="${REFRESH_ID:-manual-$(date -u +%Y%m%d%H%M%S)}"
types=(m7a.2xlarge m6a.2xlarge m7i.2xlarge m6i.2xlarge)
golden_base="${GOLDEN_BASE:-fleet}"
root_gb="${ROOT_GB:-}"
ci_source="${CI_SOURCE:-https://github.com/12-apps/ci.git}"
case "$golden_base" in
  fleet) [[ -z "$root_gb" ]] || { echo "refresh: ROOT_GB needs GOLDEN_BASE=ubuntu; a volume cannot shrink below its snapshot" >&2; exit 1; } ;;
  ubuntu) [[ "$root_gb" =~ ^[1-9][0-9]*$ ]] || { echo "refresh: GOLDEN_BASE=ubuntu needs ROOT_GB, the root volume in GiB" >&2; exit 1; } ;;
  *) echo "refresh: GOLDEN_BASE must be fleet or ubuntu, not ${golden_base}" >&2; exit 1 ;;
esac

aws() { command aws --region "$region" --output text "$@"; }
log() { printf 'refresh: %s\n' "$*" >&2; }
work=$(mktemp -d)
started=()
cleanup() {
  local status=$?
  # A TERM arriving mid-cleanup (the runner sends one after its INT) must not
  # cut the terminate short.
  trap '' INT TERM
  if [[ ${#started[@]} -gt 0 ]]; then
    if aws ec2 terminate-instances --instance-ids "${started[@]}" >/dev/null; then
      log "terminated ${started[*]}"
    else
      # An on-demand m7a.2xlarge left running costs ~$10 a day: never quietly.
      log "COULD NOT TERMINATE ${started[*]}: terminate them by hand (tag ci-runner-refresh=${refresh_id})"
      status=1
    fi
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cat > "$work/user-data.yaml" <<'UD'
#cloud-config
bootcmd:
  - [sh, -c, "[ ! -f /etc/ci-runner/env ] || sed -i 's|^CI_RUNNER_TOKEN_PARAMETER=.*|CI_RUNNER_TOKEN_PARAMETER=|' /etc/ci-runner/env"]
UD

# launch <ami> <name> [gb] → sets $launched, on-demand, the fleet's disk
# shape; the root is the image's own size unless gb is given.
# Never call it as $(launch …): a subshell's `started+=` does not reach the
# EXIT trap, and the host outlives the run (it did, on the first real one).
launch() {
  local ami=$1 name=$2 gb=${3:-} dev t id
  dev=$(aws ec2 describe-images --image-ids "$ami" --query 'Images[0].RootDeviceName')
  [[ -n "$gb" ]] || gb=$(aws ec2 describe-images --image-ids "$ami" --query 'Images[0].BlockDeviceMappings[0].Ebs.VolumeSize')
  for t in "${types[@]}"; do
    if id=$(aws ec2 run-instances --image-id "$ami" --instance-type "$t" --subnet-id "$SUBNET_ID" \
        --security-group-ids "$SECURITY_GROUP_ID" --iam-instance-profile "Arn=${INSTANCE_PROFILE_ARN}" \
        --metadata-options HttpTokens=required,HttpEndpoint=enabled \
        --block-device-mappings "DeviceName=${dev},Ebs={VolumeSize=${gb},VolumeType=gp3,Iops=6000,Throughput=500,Encrypted=true,DeleteOnTermination=true}" \
        --instance-initiated-shutdown-behavior terminate --user-data "file://$work/user-data.yaml" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=ci-runner},{Key=Name,Value=${name}},{Key=ci-runner-fleet,Value=golden},{Key=ci-runner-refresh,Value=${refresh_id}}]" \
          'ResourceType=volume,Tags=[{Key=Project,Value=ci-runner}]' \
        --query 'Instances[0].InstanceId' 2>"$work/launch.err"); then
      started+=("$id")
      launched=$id
      log "launched ${name} ${id} (${t})"
      return 0
    fi
  done
  cat "$work/launch.err" >&2
  return 1
}

wait_ssm() {
  local id=$1 state
  for _ in $(seq 1 90); do
    state=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=${id}" \
      --query 'InstanceInformationList[0].PingStatus' 2>/dev/null || true)
    [[ "$state" == Online ]] && return 0
    sleep 10
  done
  log "${id} never came online in SSM"
  return 1
}

# ssm <instance> <script file> <timeout s> → prints the output, fails with it
ssm() {
  local id=$1 file=$2 timeout=$3 cmd status
  cmd=$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript --timeout-seconds "$timeout" \
    --parameters "commands=[\"echo $(base64 -w0 "$file") | base64 -d > /root/refresh-step.sh && bash /root/refresh-step.sh 2>&1\"]" \
    --query Command.CommandId)
  for _ in $(seq 1 $((timeout / 10 + 30))); do
    sleep 10
    status=$(aws ssm get-command-invocation --command-id "$cmd" --instance-id "$id" --query Status 2>/dev/null || true)
    case "$status" in Success | Failed | TimedOut | Cancelled) break ;; esac
  done
  aws ssm get-command-invocation --command-id "$cmd" --instance-id "$id" --query StandardOutputContent | grep -v 'npm notice' >&2 || true
  [[ "$status" == Success ]]
}

wait_image() {
  local ami=$1 state
  for _ in $(seq 1 270); do
    state=$(aws ec2 describe-images --image-ids "$ami" --query 'Images[0].State')
    [[ "$state" == available ]] && return 0
    [[ "$state" == failed ]] && { log "image ${ami} failed"; return 1; }
    sleep 20
  done
  log "image ${ami} still ${state} after 90 minutes"
  return 1
}

# ── 0. the live settings, before anything is spent ──────────────────────────
aws lambda get-function-configuration --function-name "$fn" \
  --query 'Environment.Variables' --output json > "$work/lambda-env.json"
aws ec2 describe-launch-template-versions --launch-template-name "$template" --versions '$Default' \
  --query 'LaunchTemplateVersions[0].LaunchTemplateData' --output json > "$work/template.json"
pool=$(aws ec2 describe-instances --filters "Name=tag:ci-runner-pool,Values=${label}" \
  "Name=instance-state-name,Values=pending,running,stopping,stopped" --no-paginate --query 'length(Reservations[].Instances[])')
# Captured first: `eval "$(cmd)"` succeeds when cmd fails, and the first real
# run went on with no settings at all until an unbound variable stopped it.
settings=$(node "$here/live-settings.mjs" "$work/lambda-env.json" "$work/template.json" "$pool" "$work/wake-secret")
eval "$settings"
# The scaler names the fleet it serves. A function and a label from two
# different fleets would image one and redeploy the other.
if [[ "$RUNNER_LABEL" != "$label" ]]; then
  log "${fn} scales the ${RUNNER_LABEL} fleet, not ${label}: nothing launched"
  exit 1
fi
log "live settings: regions ${REGIONS}, budget ${DAILY_BUDGET}, idle ${IDLE_MINUTES:-default}, pnpm store ${PNPM_STORE}, pool ${POOL_SIZE}"

# ── 1. golden ────────────────────────────────────────────────────────────────
if [[ "$golden_base" == ubuntu ]]; then
  # Canonical's account; the newest noble gp3 server image. DescribeImages
  # needs nothing the role does not already have for the fleet's own images.
  base=$(aws ec2 describe-images --owners 099720109477 \
    --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' 'Name=state,Values=available' \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId')
  [[ "$base" == ami-* ]] || { log "no Ubuntu 24.04 image found in ${region}: nothing launched"; exit 1; }
  log "base image ${base} (clean Ubuntu 24.04, ${root_gb} GiB root), ci ${ref}"
  launch "$base" ci-runner-golden "$root_gb"
else
  base=$(jq -r .ImageId "$work/template.json")
  log "base image ${base} (what ${template} launches now), ci ${ref}"
  launch "$base" ci-runner-golden
fi
golden=$launched
# A clean Ubuntu has no kit, no /etc/ci-runner/env for install.sh to take the
# scope and label from, and no aws CLI for the boot-time token read
# (fetch-credential.sh). The fleet's own image has all three, and keeps what
# its env file says.
clean_kit=""
if [[ "$golden_base" == ubuntu ]]; then
  clean_kit="command -v git >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -yq git; }
[[ -d /opt/src/ci/.git ]] || git clone -q '${ci_source}' /opt/src/ci
command -v aws >/dev/null || snap install aws-cli --classic
export CI_RUNNER_SCOPE='repos/${REPOSITORY}' CI_RUNNER_LABELS='${RUNNER_LABEL}'"
fi
wait_ssm "$golden"
cat > "$work/golden.sh" <<EOF
set -e
# install.sh starts the slots with the real token parameter and restarts the
# idle timer; held here, no slot registers a runner and the host does not power
# itself off mid-build. /run is not in the image.
for unit in ci-runner@.service ci-runner-idle.service; do
  mkdir -p "/run/systemd/system/\$unit.d"
  printf '[Unit]\nConditionPathExists=/nonexistent/refresh-image\n' > "/run/systemd/system/\$unit.d/refresh-hold.conf"
done
systemctl daemon-reload
systemctl stop ci-runner-idle.timer ci-runner-idle.service 2>/dev/null || true
for s in 1 2 3; do systemctl stop "ci-runner@\$s" 2>/dev/null || true; done
${clean_kit}
cd /opt/src/ci
git fetch -q origin "${ref}"
git checkout -q --detach FETCH_HEAD
git log --oneline -1
CI_RUNNER_TOKEN_PARAMETER='${TOKEN_PARAMETER:-/ci-runner/github-app-key}' ./scripts/runner-host/wake/prepare-golden.sh '${SLOTS_PER_HOST:-2}' > /root/golden.log 2>&1 || { tail -40 /root/golden.log; exit 1; }
grep -E 'ready to image' /root/golden.log
systemctl stop ci-runner-idle.timer ci-runner-idle.service 2>/dev/null || true
for s in 1 2 3; do systemctl stop "ci-runner@\$s" 2>/dev/null || true; done
rm -f /etc/ci-runner/token.env
EOF
ssm "$golden" "$work/golden.sh" 3600
name="ci-runner-${label}-$(date -u +%Y%m%d-%H%M)"
ami=$(aws ec2 create-image --instance-id "$golden" --name "$name" \
  --tag-specifications "ResourceType=image,Tags=[{Key=Project,Value=ci-runner}]" "ResourceType=snapshot,Tags=[{Key=Project,Value=ci-runner}]" \
  --query ImageId)
log "imaging ${golden} as ${name}: ${ami}"
wait_image "$ami"

# ── 2. a fresh host from it ─────────────────────────────────────────────────
launch "$ami" ci-runner-smoke
fresh=$launched
wait_ssm "$fresh"
cat > "$work/smoke.sh" <<'EOF'
set -e
systemctl stop ci-runner-idle.timer 2>/dev/null || true
systemctl is-enabled ci-runner@1.service ci-runner-credential.service ci-runner-idle.timer
docker image inspect ci-runner:latest --format 'runner image {{.Id}}'
docker run --rm --entrypoint bash ci-runner:latest -c '
  set -e
  # Assigned first: set -e ignores a failed $(…) inside an echo.
  v=$(/home/runner/actions-runner/bin/Runner.Listener --version)
  echo "runner $v"
  ls /opt/hostedtoolcache/node | grep -q "^24\." && echo "node $(ls /opt/hostedtoolcache/node | paste -sd " ")"'
echo SMOKE-OK
EOF
ssm "$fresh" "$work/smoke.sh" 900 || { log "the fresh host failed its checks — nothing deployed; ${ami} stays for inspection"; exit 1; }

# ── 3. deploy with the live settings ────────────────────────────────────────
log "deploying ${ami} with the live settings: regions ${REGIONS}, budget ${DAILY_BUDGET}, idle ${IDLE_MINUTES:-default}, pnpm store ${PNPM_STORE}"
AMI_ID="$ami" WAKE_SECRET_FILE="$work/wake-secret" AWS_REGION="$region" bash "$here/deploy.sh"
