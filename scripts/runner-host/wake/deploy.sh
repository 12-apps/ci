#!/usr/bin/env bash
# Stand up the runner fleet: an AMI, a launch template for throwaway spot
# hosts in each region, and the Lambda that sizes the fleet to the queue
# (scale.mjs) and picks the region to launch in (index.mjs).
#
#   AWS_PROFILE=ci-runner-admin GOLDEN_INSTANCE_ID=i-0123... ./deploy.sh
#
# GOLDEN_INSTANCE_ID is a host prepared by prepare-golden.sh: the kit
# installed with CI_RUNNER_TOKEN_PARAMETER (no secret on disk), idle-stop on.
# It is imaged (with a reboot) and can be terminated afterwards. Pass AMI_ID
# instead to reuse an image. Needs IAM, Lambda and EC2 image/template rights,
# once; idempotent, re-run it to ship a new AMI or a new function version.
#
# Env: AWS_REGION (us-east-1), REPOSITORY (12-apps/future-pay), RUNNER_LABEL
# (future-pay-ci), INSTANCE_TYPES (current 8-vCPU x86 types, 32 GB m and 64 GB r:
# more spot pools, fewer reclaims; m5a is left out, its first-generation EPYC is
# slower per core than the runner the lanes are tuned for, and m7i-flex, the
# shallowest pool: nine of eighteen reclaims on 2026-09-24),
# SLOTS_PER_HOST (2: a 4-core, 14 GB slot, like the 4-vCPU runner the lanes are
# tuned for), MAX_HOSTS (30; 30 × 8 vCPU must fit the account's spot vCPU
# quota, L-34B43A08), POOL_SIZE (0; stopped hosts kept warm, see README), TOKEN_PARAMETER
# (/ci-runner/github-app-key), FUNCTION_NAME (ci-runner-scale),
# WAKE_SECRET_FILE (~/.ci-runner-wake-secret, created 0600, never printed),
# ROOT_IOPS (6000) and ROOT_THROUGHPUT (500 MB/s) for the hosts' gp3 root volume,
# REGIONS (us-east-2,eu-north-1,AWS_REGION): where hosts may run, cheapest
# first. The AMI is copied (by name) into each and gets a launch template of
# the same name there; a region that cannot be set up is left out with a
# warning. The hosts of every region read the token from AWS_REGION's SSM.
# DAILY_BUDGET (10 USD; 0 turns it off): once the fleet has spent it in a local
# day (BUDGET_UTC_OFFSET, -3), it shrinks to DEGRADED_MAX_HOSTS (2) spot hosts
# until local midnight, and fires the hook in ALERT_PARAMETER
# (/ci-runner/budget-alert, a JSON SecureString {"url", "headers"}) once.
# SPOT_STRATEGY (capacity-optimized): the EC2 Fleet spot allocation strategy.
# IDLE_MINUTES (2): a host powers itself off after this long without a job.
# PNPM_STORE (off): `on` mounts the image's warm pnpm store into every job.
# PRUNE_IMAGES (1): after a deploy, delete each region's older fleet images and
# their snapshots, keeping the image in use, the one before it and any a live
# host runs on (prune-images.mjs). Needs ec2:DeregisterImage and
# ec2:DeleteSnapshot; without them it warns and the deploy still succeeds.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
region="${AWS_REGION:-us-east-1}"
repo="${REPOSITORY:-12-apps/future-pay}"
label="${RUNNER_LABEL:-future-pay-ci}"
types="${INSTANCE_TYPES:-m7a.2xlarge,m6a.2xlarge,m7i.2xlarge,m6i.2xlarge,r7a.2xlarge,r6a.2xlarge,r7i.2xlarge,r6i.2xlarge}"
slots="${SLOTS_PER_HOST:-2}"
max_hosts="${MAX_HOSTS:-30}"
pool_size="${POOL_SIZE:-0}"
daily_budget="${DAILY_BUDGET:-10}"
degraded_max_hosts="${DEGRADED_MAX_HOSTS:-2}"
budget_utc_offset="${BUDGET_UTC_OFFSET:--3}"
alert_param="${ALERT_PARAMETER:-/ci-runner/budget-alert}"
spot_strategy="${SPOT_STRATEGY:-capacity-optimized}"
idle_minutes="${IDLE_MINUTES:-2}"
pnpm_store="${PNPM_STORE:-off}"
[[ "$pnpm_store" == on || "$pnpm_store" == off ]] || { echo "deploy: PNPM_STORE must be on or off" >&2; exit 1; }
# Boot-time settings, applied to the image's /etc/ci-runner/env by cloud-init's
# bootcmd, which runs before network-online.target and so before any runner
# slot reads the file. No new image is needed to change them:
#  - the idle time: every minute a host stays up past its last job is billed,
#    and at 5 minutes that tail was about a quarter of a host's life;
#  - the runner's name, prefixed with the host's zone (eu-north-1a-ip-…): the
#    subnets of the fleet's regions overlap (172.31.0.0/20 is a zone in all
#    three), so a job's region cannot be told from its runner's IP;
#  - the warm pnpm store, off unless PNPM_STORE=on. Mounted into a job, it
#    sits on another mount than the workspace, so pnpm copies every file
#    instead of hardlinking it: on 2026-09-25 future-pay's install took 30-61 s
#    from the store against 13.6 s downloading all 1877 packages from npm into
#    the job's own store. Node in the tool cache is unaffected.
store_cmd=""
[[ "$pnpm_store" == off ]] && store_cmd="  - [sh, -c, \"sed -i 's/^CI_RUNNER_PNPM_STORE=.*/CI_RUNNER_PNPM_STORE=/' /etc/ci-runner/env\"]"
user_data=$(base64 -w0 <<UD
#cloud-config
bootcmd:
  - [sh, -c, "sed -i 's/^CI_RUNNER_IDLE_MINUTES=.*/CI_RUNNER_IDLE_MINUTES=${idle_minutes}/' /etc/ci-runner/env"]
  - [sh, -c, "t=\$(curl -s -m 5 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'); md() { curl -s -m 5 -H \"X-aws-ec2-metadata-token: \$t\" http://169.254.169.254/latest/meta-data/\$1; }; az=\$(md placement/availability-zone); ip=\$(md local-ipv4); [ -n \"\$az\" ] && [ -n \"\$ip\" ] || exit 0; sed -i '/^CI_RUNNER_NAME=/d' /etc/ci-runner/env; echo \"CI_RUNNER_NAME=\$az-ip-\$(echo \$ip | tr . -)\" >> /etc/ci-runner/env"]
${store_cmd}
UD
)
# gp3's baseline is 125 MB/s and 3000 IOPS. A job's dependency install is
# disk-bound once the cache is found (future-pay: 529 MB restored in 2.5 s,
# then 19 s to extract and more to link 1887 packages), so the root volume
# gets more; it is billed only while a host exists.
root_iops="${ROOT_IOPS:-6000}"
root_throughput="${ROOT_THROUGHPUT:-500}"
param="${TOKEN_PARAMETER:-/ci-runner/github-app-key}"
fn="${FUNCTION_NAME:-ci-runner-scale}"
role="$fn"
template="ci-runner-fleet-${label}"
secret_file="${WAKE_SECRET_FILE:-$HOME/.ci-runner-wake-secret}"
regions="${REGIONS:-us-east-2,eu-north-1,${region}}"
aws() { command aws --region "$region" --output text "$@"; }
# The same call in another region.
in_region() { local r=$1; shift; command aws --region "$r" --output text "$@"; }
# An image's snapshot takes minutes to tens of minutes; the CLI waiter gives up at ten.
wait_image() {
  local r=$1 id=$2 state=""
  for _ in $(seq 1 270); do
    state=$(in_region "$r" ec2 describe-images --image-ids "$id" --query 'Images[0].State') || return 1
    [[ "$state" == available ]] && return 0
    [[ "$state" == failed ]] && { echo "deploy: ${id} in ${r} failed" >&2; return 1; }
    sleep 20
  done
  echo "deploy: ${id} in ${r} still ${state} after 90 minutes" >&2
  return 1
}
account=$(aws sts get-caller-identity --query Account)

# ── image ────────────────────────────────────────────────────────────────────
if [[ -z "${AMI_ID:-}" ]]; then
  : "${GOLDEN_INSTANCE_ID:?set GOLDEN_INSTANCE_ID (a host from prepare-golden.sh) or AMI_ID}"
  name="ci-runner-${label}-$(date -u +%Y%m%d-%H%M)"
  echo "deploy: imaging ${GOLDEN_INSTANCE_ID} as ${name} (the host reboots)..."
  AMI_ID=$(aws ec2 create-image --instance-id "$GOLDEN_INSTANCE_ID" --name "$name" \
    --tag-specifications "ResourceType=image,Tags=[{Key=Project,Value=ci-runner}]" \
    "ResourceType=snapshot,Tags=[{Key=Project,Value=ci-runner}]" --query ImageId)
  wait_image "$region" "$AMI_ID" || exit 1
fi
# The root volume can be no smaller than the image's snapshot.
root_gb=$(aws ec2 describe-images --image-ids "$AMI_ID" --query 'Images[0].BlockDeviceMappings[0].Ebs.VolumeSize')
root_device=$(aws ec2 describe-images --image-ids "$AMI_ID" --query 'Images[0].RootDeviceName')
src="${GOLDEN_INSTANCE_ID:-}"
if [[ -n "$src" ]]; then
  read -r subnet sg profile_arn < <(aws ec2 describe-instances --instance-ids "$src" \
    --query 'Reservations[0].Instances[0].[SubnetId,SecurityGroups[0].GroupId,IamInstanceProfile.Arn]')
else
  : "${SUBNET_ID:?}" "${SECURITY_GROUP_ID:?}" "${INSTANCE_PROFILE_ARN:?}"
  subnet=$SUBNET_ID sg=$SECURITY_GROUP_ID profile_arn=$INSTANCE_PROFILE_ARN
fi
host_role=$(aws iam get-instance-profile --instance-profile-name "${profile_arn##*/}" --query 'InstanceProfile.Roles[0].Arn')

# ── launch template: throwaway hosts that terminate when idle ───────────────
# No market options here: the scaler's fleet request asks for spot and falls
# back to on-demand when no spot pool has capacity (index.mjs). No subnet
# either: the request names one per zone, from the region's default VPC.
# Prints the template's ARN.
put_template() {
  local r=$1 ami=$2 sg=$3 data v
  data=$(jq -n --arg ami "$ami" --arg type "${types%%,*}" --arg profile "$profile_arn" \
    --arg sg "$sg" --arg label "$label" --arg ud "$user_data" \
    --arg dev "$root_device" --argjson gb "$root_gb" --argjson iops "$root_iops" --argjson tput "$root_throughput" '{
    ImageId: $ami, InstanceType: $type, UserData: $ud,
    IamInstanceProfile: {Arn: $profile},
    SecurityGroupIds: [$sg],
    MetadataOptions: {HttpTokens: "required", HttpEndpoint: "enabled"},
    InstanceInitiatedShutdownBehavior: "terminate",
    BlockDeviceMappings: [{DeviceName: $dev, Ebs: {VolumeSize: $gb, VolumeType: "gp3", Iops: $iops, Throughput: $tput, Encrypted: true, DeleteOnTermination: true}}],
    TagSpecifications: [
      {ResourceType: "instance", Tags: [{Key: "Project", Value: "ci-runner"}, {Key: "Name", Value: "ci-runner-fleet"}, {Key: "ci-runner-fleet", Value: $label}]},
      {ResourceType: "volume", Tags: [{Key: "Project", Value: "ci-runner"}]}
    ]}')
  if in_region "$r" ec2 describe-launch-templates --launch-template-names "$template" >/dev/null 2>&1; then
    v=$(in_region "$r" ec2 create-launch-template-version --launch-template-name "$template" --launch-template-data "$data" \
      --query LaunchTemplateVersion.VersionNumber) || return 1
    in_region "$r" ec2 modify-launch-template --launch-template-name "$template" --default-version "$v" >/dev/null || return 1
  else
    in_region "$r" ec2 create-launch-template --launch-template-name "$template" --launch-template-data "$data" \
      --tag-specifications "ResourceType=launch-template,Tags=[{Key=Project,Value=ci-runner}]" >/dev/null || return 1
  fi
  echo "arn:aws:ec2:${r}:${account}:launch-template/$(in_region "$r" ec2 describe-launch-templates \
    --launch-template-names "$template" --query 'LaunchTemplates[0].LaunchTemplateId')"
}

# Another region: the image copied under the same name (reused when a copy
# exists), a security group with no inbound rule in its default VPC, and the
# template. Prints the template's ARN.
setup_region() {
  local r=$1 name ami vpc sg
  name=$(aws ec2 describe-images --image-ids "$AMI_ID" --query 'Images[0].Name') || return 1
  ami=$(in_region "$r" ec2 describe-images --owners self --filters "Name=name,Values=${name}" --query 'Images[0].ImageId') || return 1
  if [[ -z "$ami" || "$ami" == None ]]; then
    echo "deploy: copying ${AMI_ID} to ${r}..." >&2
    ami=$(in_region "$r" ec2 copy-image --source-region "$region" --source-image-id "$AMI_ID" --name "$name" \
      --copy-image-tags --query ImageId) || return 1
  fi
  wait_image "$r" "$ami" || return 1
  vpc=$(in_region "$r" ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId') || return 1
  [[ -n "$vpc" && "$vpc" != None ]] || { echo "deploy: ${r} has no default VPC" >&2; return 1; }
  sg=$(in_region "$r" ec2 describe-security-groups --filters "Name=vpc-id,Values=${vpc}" "Name=group-name,Values=ci-runner-host" \
    --query 'SecurityGroups[0].GroupId') || return 1
  if [[ -z "$sg" || "$sg" == None ]]; then
    sg=$(in_region "$r" ec2 create-security-group --vpc-id "$vpc" --group-name ci-runner-host \
      --description "CI runner hosts: outbound only" --query GroupId) || return 1
  fi
  put_template "$r" "$ami" "$sg"
}

template_arns=$(put_template "$region" "$AMI_ID" "$sg") || { echo "deploy: no launch template in ${region}" >&2; exit 1; }
live_regions=""
IFS=, read -ra wanted <<< "$regions"
for r in "${wanted[@]}"; do
  if [[ "$r" == "$region" ]]; then
    live_regions+="${live_regions:+,}${r}"
  elif arn=$(setup_region "$r"); then
    template_arns+=" ${arn}"
    live_regions+="${live_regions:+,}${r}"
  else
    echo "deploy: WARNING: ${r} left out of the fleet (see above)" >&2
  fi
done
[[ ",${live_regions}," == *",${region},"* ]] || live_regions+="${live_regions:+,}${region}"

# ── warm pool: stopped hosts whose disks have booted before ─────────────────
# A fresh host reads its root volume from the snapshot on first touch, which
# is most of its ~2.5 minutes to a first job. A stopped host keeps a volume
# that has already been read, so the scaler starts these first. They are
# persistent spot requests that STOP (idle-stop's poweroff, or an
# interruption) instead of terminating; they cost only their volumes while
# stopped. A pool host still on an older image is retired once it is stopped.
pool_hosts() {
  aws ec2 describe-instances --filters "Name=tag:ci-runner-pool,Values=${label}" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].[InstanceId,ImageId,State.Name,SpotInstanceRequestId]'
}
while read -r id image state request; do
  [[ -n "$id" && "$image" != "$AMI_ID" && "$state" == stopped ]] || continue
  echo "deploy: retiring pool host ${id} (image ${image})"
  [[ "$request" == None ]] || aws ec2 cancel-spot-instance-requests --spot-instance-request-ids "$request" >/dev/null
  aws ec2 terminate-instances --instance-ids "$id" >/dev/null
done < <(pool_hosts)
have=$(pool_hosts | awk -v ami="$AMI_ID" 'NF && ($2 == ami || $3 != "stopped")' | wc -l)
if (( have < pool_size )); then
  tags=$(jq -nc --arg label "$label" '[{ResourceType: "instance", Tags: [{Key: "Project", Value: "ci-runner"},
    {Key: "Name", Value: "ci-runner-pool"}, {Key: "ci-runner-fleet", Value: $label}, {Key: "ci-runner-pool", Value: $label}]},
    {ResourceType: "volume", Tags: [{Key: "Project", Value: "ci-runner"}]}]')
  echo "deploy: adding $(( pool_size - have )) pool host(s); each stops itself after its idle minutes"
  aws ec2 run-instances --launch-template "LaunchTemplateName=${template},Version=\$Default" \
    --count "$(( pool_size - have ))" --subnet-id "$subnet" --instance-initiated-shutdown-behavior stop \
    --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"persistent","InstanceInterruptionBehavior":"stop"}}' \
    --tag-specifications "$tags" --query 'Instances[].InstanceId'
fi

# ── role: launch from THAT template, read the token, write own logs ─────────
new_role=0
if ! aws iam get-role --role-name "$role" >/dev/null 2>&1; then
  aws iam create-role --role-name "$role" --tags Key=Project,Value=ci-runner \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  new_role=1
fi
policy=$(jq -n --arg lts "$template_arns" --arg hostrole "$host_role" --arg label "$label" \
  --arg param "arn:aws:ssm:${region}:${account}:parameter${param}" \
  --arg spend "arn:aws:ssm:${region}:${account}:parameter/ci-runner/spend-${label}" \
  --arg alert "arn:aws:ssm:${region}:${account}:parameter${alert_param}" \
  --arg logs "arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${fn}" '{
  Version: "2012-10-17",
  Statement: [
    {Effect: "Allow", Action: "ec2:RunInstances", Resource: "*", Condition: {ArnLike: {"ec2:LaunchTemplate": ($lts | split(" "))}}},
    {Effect: "Allow", Action: "ec2:CreateFleet", Resource: "*"},
    {Effect: "Allow", Action: "ec2:CreateTags", Resource: "*", Condition: {StringEquals: {"ec2:CreateAction": ["RunInstances", "CreateFleet"]}}},
    {Effect: "Allow", Action: ["ec2:DescribeLaunchTemplateVersions", "ec2:DescribeImages", "ec2:DescribeSubnets",
      "ec2:DescribeInstanceTypeOfferings", "ec2:GetSpotPlacementScores", "ec2:DescribeSpotPriceHistory"], Resource: "*"},
    {Effect: "Allow", Action: "ec2:StartInstances", Resource: "*", Condition: {StringEquals: {"aws:ResourceTag/ci-runner-pool": $label}}},
    {Effect: "Allow", Action: "iam:PassRole", Resource: $hostrole},
    {Effect: "Allow", Action: "ec2:DescribeInstances", Resource: "*"},
    {Effect: "Allow", Action: "ssm:GetParameter", Resource: [$param, $alert]},
    {Effect: "Allow", Action: ["ssm:GetParameter", "ssm:PutParameter"], Resource: $spend},
    {Effect: "Allow", Action: "kms:Decrypt", Resource: "*", Condition: {StringEquals: {"kms:ViaService": "ssm.\($param | split(":")[3]).amazonaws.com"}}},
    {Effect: "Allow", Action: "logs:CreateLogGroup", Resource: $logs},
    {Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: ($logs + ":*")}
  ]}')
aws iam put-role-policy --role-name "$role" --policy-name fleet --policy-document "$policy"
# An EC2 Fleet request needs the account's fleet service-linked role once.
aws iam create-service-linked-role --aws-service-name ec2fleet.amazonaws.com >/dev/null 2>&1 || true
(( new_role )) && sleep 15

# ── secret, function, URL ────────────────────────────────────────────────────
[[ -s "$secret_file" ]] || (umask 077; openssl rand -hex 32 > "$secret_file")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(umask 077; jq -n --rawfile s "$secret_file" --arg l "$label" --arg r "$repo" --arg t "$template" \
  --arg p "$param" --arg types "$types" --arg regions "$live_regions" --arg slots "$slots" --arg max "$max_hosts" \
  --arg budget "$daily_budget" --arg degraded "$degraded_max_hosts" --arg offset "$budget_utc_offset" --arg alert "$alert_param" --arg strategy "$spot_strategy" \
  '{Variables: {MODE: "scale", WEBHOOK_SECRET: ($s | rtrimstr("\n")), RUNNER_LABEL: $l, REPOSITORY: $r,
    LAUNCH_TEMPLATE: $t, TOKEN_PARAMETER: $p, INSTANCE_TYPES: $types, REGIONS: $regions, SLOTS_PER_HOST: $slots, MAX_HOSTS: $max,
    DAILY_BUDGET: $budget, DEGRADED_MAX_HOSTS: $degraded, BUDGET_UTC_OFFSET: $offset, ALERT_PARAMETER: $alert, SPOT_STRATEGY: $strategy}}' > "$work/env.json")
cp "$here/wake.mjs" "$here/scale.mjs" "$here/budget.mjs" "$here/index.mjs" "$work/"
(cd "$work" && python3 -m zipfile -c fn.zip wake.mjs scale.mjs budget.mjs index.mjs)
if aws lambda get-function --function-name "$fn" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$work/fn.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$fn"
  aws lambda update-function-configuration --function-name "$fn" --environment "file://$work/env.json" --timeout 120 >/dev/null
else
  aws lambda create-function --function-name "$fn" --runtime nodejs22.x --handler index.handler \
    --role "arn:aws:iam::${account}:role/${role}" --timeout 120 --memory-size 256 \
    --zip-file "fileb://$work/fn.zip" --environment "file://$work/env.json" --tags Project=ci-runner >/dev/null
fi
aws lambda wait function-updated-v2 --function-name "$fn"
# Overlapping evaluations are made safe by the launch's ClientToken
# (scale.mjs). A new account's 10-execution Lambda limit refuses any
# reservation, so none is made.

url=$(aws lambda get-function-url-config --function-name "$fn" --query FunctionUrl 2>/dev/null || true)
[[ -n "$url" && "$url" != None ]] || url=$(aws lambda create-function-url-config --function-name "$fn" --auth-type NONE --query FunctionUrl)
aws lambda add-permission --function-name "$fn" --statement-id url-invoke \
  --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null 2>&1 || true
aws lambda add-permission --function-name "$fn" --statement-id url-invoke-function \
  --action lambda:InvokeFunction --principal '*' --invoked-via-function-url >/dev/null 2>&1 || true

body='{"zen":"deploy check"}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$(cat "$secret_file")" | awk '{print $NF}')"
answer=""
for _ in 1 2 3 4 5 6; do
  answer=$(curl -sS -X POST "$url" -H 'Content-Type: application/json' -H 'X-GitHub-Event: ping' \
    -H "X-Hub-Signature-256: $sig" -d "$body" || true)
  [[ "$answer" == *pong* ]] && break
  sleep 5
done
[[ "$answer" == *pong* ]] || { echo "deploy: the function URL did not answer a signed ping: $answer" >&2; exit 1; }

# ── webhook: the function creates it (token from SSM needs Webhooks: write) ─
hook="not created (CREATE_WEBHOOK=0)"
if [[ "${CREATE_WEBHOOK:-1}" == 1 ]]; then
  jq -n --arg u "$url" '{setup: "webhook", url: $u}' > "$work/setup.json"
  aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out \
    --payload "file://$work/setup.json" "$work/setup.out" >/dev/null
  hook=$(jq -r 'if .webhook then "\(.webhook) (id \(.id))" else "FAILED: \(.errorMessage // .)" end' "$work/setup.out")
  [[ "$hook" != FAILED* ]] || { echo "deploy: webhook ${hook}" >&2; exit 1; }
fi

# ── old images: keep what runs and the rollback, delete the rest ──────────
# Every deploy leaves an image (and its copies) behind, each a 72 GB snapshot
# billed by the month, and nothing else ever removes one: us-east-1 held seven
# on 2026-09-25. Last, so only a deploy that got this far prunes anything.
# prune-images.mjs decides; this only lists and deletes. Scoped by name to this
# fleet's images, so another project's AMIs in the account are never listed.
prune_region() {
  local r=$1 live image snaps s
  command aws --region "$r" --output json ec2 describe-images --owners self \
    --filters "Name=name,Values=ci-runner-${label}-*" > "$work/images-${r}.json" || return 1
  command aws --region "$r" --output json ec2 describe-launch-template-versions \
    --launch-template-name "$template" > "$work/versions-${r}.json" || return 1
  live=$(in_region "$r" ec2 describe-instances --filters Name=tag-key,Values=ci-runner-fleet \
    "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped" \
    --query 'Reservations[].Instances[].ImageId') || return 1
  while read -r image snaps; do
    [[ -n "$image" ]] || continue
    if ! in_region "$r" ec2 deregister-image --image-id "$image" >/dev/null; then
      echo "deploy: WARNING: could not delete image ${image} in ${r} (needs ec2:DeregisterImage)" >&2
      continue
    fi
    for s in $snaps; do
      in_region "$r" ec2 delete-snapshot --snapshot-id "$s" >/dev/null \
        || echo "deploy: WARNING: image ${image} deleted in ${r}, its snapshot ${s} not (needs ec2:DeleteSnapshot)" >&2
    done
    echo "deploy: ${r}: deleted old image ${image} (${snaps:-no snapshot})"
  done < <(node "$here/prune-images.mjs" "$work/images-${r}.json" "$work/versions-${r}.json" "$live")
}
if [[ "${PRUNE_IMAGES:-1}" == 1 ]]; then
  IFS=, read -ra pruned <<< "$live_regions"
  for r in "${pruned[@]}"; do
    prune_region "$r" || echo "deploy: WARNING: could not list the old images in ${r}; none deleted there" >&2
  done
fi

cat <<DONE
deploy: fleet ready. AMI ${AMI_ID}, template ${template} in ${live_regions} (tried in that order,
then by spot placement score), up to ${max_hosts} hosts × ${slots} slots,
the first ${pool_size} started from the warm pool.
Scaler: ${url}

Webhook on ${repo}: ${hook}. To add it by hand instead (CREATE_WEBHOOK=0), use Settings → Webhooks:
  Payload URL   ${url}
  Content type  application/json
  Secret        the contents of ${secret_file}
  Events        "Workflow jobs" and "Workflow runs"
The token in ${param} needs Actions: Read and write (count the queue, re-run jobs lost to a
reclaimed host) and, for the webhook step, Webhooks: Read and write.
DONE
