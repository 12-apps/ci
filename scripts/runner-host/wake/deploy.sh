#!/usr/bin/env bash
# Stand up the runner fleet: an AMI, a launch template for throwaway spot
# hosts, and the Lambda that sizes the fleet to the queue (scale.mjs).
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
# slower per core than the runner the lanes are tuned for),
# SLOTS_PER_HOST (2: a 4-core, 14 GB slot, like the 4-vCPU runner the lanes are
# tuned for), MAX_HOSTS (30; 30 × 8 vCPU must fit the account's spot vCPU
# quota, L-34B43A08), POOL_SIZE (0; stopped hosts kept warm, see README), TOKEN_PARAMETER
# (/ci-runner/github-app-key), FUNCTION_NAME (ci-runner-scale),
# WAKE_SECRET_FILE (~/.ci-runner-wake-secret, created 0600, never printed),
# ROOT_IOPS (6000) and ROOT_THROUGHPUT (500 MB/s) for the hosts' gp3 root volume.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
region="${AWS_REGION:-us-east-1}"
repo="${REPOSITORY:-12-apps/future-pay}"
label="${RUNNER_LABEL:-future-pay-ci}"
types="${INSTANCE_TYPES:-m7a.2xlarge,m6a.2xlarge,m7i.2xlarge,m7i-flex.2xlarge,m6i.2xlarge,r7a.2xlarge,r6a.2xlarge,r7i.2xlarge,r6i.2xlarge}"
slots="${SLOTS_PER_HOST:-2}"
max_hosts="${MAX_HOSTS:-30}"
pool_size="${POOL_SIZE:-0}"
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
aws() { command aws --region "$region" --output text "$@"; }
account=$(aws sts get-caller-identity --query Account)

# ── image ────────────────────────────────────────────────────────────────────
if [[ -z "${AMI_ID:-}" ]]; then
  : "${GOLDEN_INSTANCE_ID:?set GOLDEN_INSTANCE_ID (a host from prepare-golden.sh) or AMI_ID}"
  name="ci-runner-${label}-$(date -u +%Y%m%d-%H%M)"
  echo "deploy: imaging ${GOLDEN_INSTANCE_ID} as ${name} (the host reboots)..."
  AMI_ID=$(aws ec2 create-image --instance-id "$GOLDEN_INSTANCE_ID" --name "$name" \
    --tag-specifications "ResourceType=image,Tags=[{Key=Project,Value=ci-runner}]" \
    "ResourceType=snapshot,Tags=[{Key=Project,Value=ci-runner}]" --query ImageId)
  # A 100+ GB root takes longer than the CLI waiter's 10 minutes to snapshot.
  for _ in $(seq 1 180); do
    state=$(aws ec2 describe-images --image-ids "$AMI_ID" --query 'Images[0].State')
    [[ "$state" == available ]] && break
    [[ "$state" == failed ]] && { echo "deploy: ${AMI_ID} failed" >&2; exit 1; }
    sleep 20
  done
  [[ "$state" == available ]] || { echo "deploy: ${AMI_ID} still ${state} after an hour" >&2; exit 1; }
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
# Every default subnet of the VPC, one per zone: the fleet spreads across them.
vpc=$(aws ec2 describe-subnets --subnet-ids "$subnet" --query 'Subnets[0].VpcId')
subnets=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${vpc}" "Name=default-for-az,Values=true" \
  --query 'Subnets[].SubnetId' | tr '\t' ',')
[[ -n "$subnets" ]] || subnets=$subnet
# Only the (type, subnet) pairs EC2 offers: one type a zone lacks (m7i-flex in
# us-east-1e) makes an instant fleet refuse the whole request
# (InvalidFleetConfiguration), and the queue waits.
overrides=""
while read -r sn az; do
  [[ -n "$sn" ]] || continue
  for t in $(aws ec2 describe-instance-type-offerings --location-type availability-zone \
      --filters "Name=location,Values=${az}" "Name=instance-type,Values=${types}" --query 'InstanceTypeOfferings[].InstanceType'); do
    overrides+="${overrides:+,}${t}@${sn}"
  done
done < <(IFS=, read -ra ids <<< "$subnets"; aws ec2 describe-subnets --subnet-ids "${ids[@]}" --query 'Subnets[].[SubnetId,AvailabilityZone]')
[[ -n "$overrides" ]] || { echo "deploy: none of ${types} is offered in any subnet of ${vpc}" >&2; exit 1; }
host_role=$(aws iam get-instance-profile --instance-profile-name "${profile_arn##*/}" --query 'InstanceProfile.Roles[0].Arn')

# ── launch template: throwaway hosts that terminate when idle ───────────────
# No market options here: the scaler's fleet request asks for spot and falls
# back to on-demand when no spot pool has capacity (index.mjs).
data=$(jq -n --arg ami "$AMI_ID" --arg type "${types%%,*}" --arg profile "$profile_arn" \
  --arg sg "$sg" --arg label "$label" \
  --arg dev "$root_device" --argjson gb "$root_gb" --argjson iops "$root_iops" --argjson tput "$root_throughput" '{
  ImageId: $ami, InstanceType: $type,
  IamInstanceProfile: {Arn: $profile},
  SecurityGroupIds: [$sg],
  MetadataOptions: {HttpTokens: "required", HttpEndpoint: "enabled"},
  InstanceInitiatedShutdownBehavior: "terminate",
  BlockDeviceMappings: [{DeviceName: $dev, Ebs: {VolumeSize: $gb, VolumeType: "gp3", Iops: $iops, Throughput: $tput, Encrypted: true, DeleteOnTermination: true}}],
  TagSpecifications: [
    {ResourceType: "instance", Tags: [{Key: "Project", Value: "ci-runner"}, {Key: "Name", Value: "ci-runner-fleet"}, {Key: "ci-runner-fleet", Value: $label}]},
    {ResourceType: "volume", Tags: [{Key: "Project", Value: "ci-runner"}]}
  ]}')
if aws ec2 describe-launch-templates --launch-template-names "$template" >/dev/null 2>&1; then
  v=$(aws ec2 create-launch-template-version --launch-template-name "$template" --launch-template-data "$data" \
    --query LaunchTemplateVersion.VersionNumber)
  aws ec2 modify-launch-template --launch-template-name "$template" --default-version "$v" >/dev/null
else
  aws ec2 create-launch-template --launch-template-name "$template" --launch-template-data "$data" \
    --tag-specifications "ResourceType=launch-template,Tags=[{Key=Project,Value=ci-runner}]" >/dev/null
fi
template_arn="arn:aws:ec2:${region}:${account}:launch-template/$(aws ec2 describe-launch-templates \
  --launch-template-names "$template" --query 'LaunchTemplates[0].LaunchTemplateId')"

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
policy=$(jq -n --arg lt "$template_arn" --arg hostrole "$host_role" --arg label "$label" \
  --arg param "arn:aws:ssm:${region}:${account}:parameter${param}" \
  --arg logs "arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${fn}" '{
  Version: "2012-10-17",
  Statement: [
    {Effect: "Allow", Action: "ec2:RunInstances", Resource: "*", Condition: {ArnLike: {"ec2:LaunchTemplate": $lt}}},
    {Effect: "Allow", Action: "ec2:CreateFleet", Resource: "*"},
    {Effect: "Allow", Action: "ec2:CreateTags", Resource: "*", Condition: {StringEquals: {"ec2:CreateAction": ["RunInstances", "CreateFleet"]}}},
    {Effect: "Allow", Action: ["ec2:DescribeLaunchTemplateVersions", "ec2:DescribeImages", "ec2:DescribeSubnets"], Resource: "*"},
    {Effect: "Allow", Action: "ec2:StartInstances", Resource: "*", Condition: {StringEquals: {"aws:ResourceTag/ci-runner-pool": $label}}},
    {Effect: "Allow", Action: "iam:PassRole", Resource: $hostrole},
    {Effect: "Allow", Action: "ec2:DescribeInstances", Resource: "*"},
    {Effect: "Allow", Action: "ssm:GetParameter", Resource: $param},
    {Effect: "Allow", Action: "kms:Decrypt", Resource: "*", Condition: {StringEquals: {"kms:ViaService": "ssm.\($lt | split(":")[3]).amazonaws.com"}}},
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
  --arg p "$param" --arg types "$types" --arg subnets "$subnets" --arg overrides "$overrides" --arg slots "$slots" --arg max "$max_hosts" \
  '{Variables: {MODE: "scale", WEBHOOK_SECRET: ($s | rtrimstr("\n")), RUNNER_LABEL: $l, REPOSITORY: $r,
    LAUNCH_TEMPLATE: $t, TOKEN_PARAMETER: $p, INSTANCE_TYPES: $types, SUBNETS: $subnets, OVERRIDES: $overrides, SLOTS_PER_HOST: $slots, MAX_HOSTS: $max}}' > "$work/env.json")
cp "$here/wake.mjs" "$here/scale.mjs" "$here/index.mjs" "$work/"
(cd "$work" && python3 -m zipfile -c fn.zip wake.mjs scale.mjs index.mjs)
if aws lambda get-function --function-name "$fn" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$work/fn.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$fn"
  aws lambda update-function-configuration --function-name "$fn" --environment "file://$work/env.json" --timeout 30 >/dev/null
else
  aws lambda create-function --function-name "$fn" --runtime nodejs22.x --handler index.handler \
    --role "arn:aws:iam::${account}:role/${role}" --timeout 30 --memory-size 256 \
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

cat <<DONE
deploy: fleet ready. AMI ${AMI_ID}, template ${template}, up to ${max_hosts} hosts × ${slots} slots,
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
