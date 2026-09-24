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
# (future-pay-ci), INSTANCE_TYPES (c7a.2xlarge,c6a.2xlarge,m7a.2xlarge),
# SLOTS_PER_HOST (3), MAX_HOSTS (15), TOKEN_PARAMETER
# (/ci-runner/github-app-key), FUNCTION_NAME (ci-runner-scale),
# WAKE_SECRET_FILE (~/.ci-runner-wake-secret, created 0600, never printed).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
region="${AWS_REGION:-us-east-1}"
repo="${REPOSITORY:-12-apps/future-pay}"
label="${RUNNER_LABEL:-future-pay-ci}"
types="${INSTANCE_TYPES:-c7a.2xlarge,c6a.2xlarge,m7a.2xlarge}"
slots="${SLOTS_PER_HOST:-3}"
max_hosts="${MAX_HOSTS:-15}"
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
  aws ec2 wait image-available --image-ids "$AMI_ID"
fi
src="${GOLDEN_INSTANCE_ID:-}"
if [[ -n "$src" ]]; then
  read -r subnet sg profile_arn < <(aws ec2 describe-instances --instance-ids "$src" \
    --query 'Reservations[0].Instances[0].[SubnetId,SecurityGroups[0].GroupId,IamInstanceProfile.Arn]')
else
  : "${SUBNET_ID:?}" "${SECURITY_GROUP_ID:?}" "${INSTANCE_PROFILE_ARN:?}"
  subnet=$SUBNET_ID sg=$SECURITY_GROUP_ID profile_arn=$INSTANCE_PROFILE_ARN
fi
host_role=$(aws iam get-instance-profile --instance-profile-name "${profile_arn##*/}" --query 'InstanceProfile.Roles[0].Arn')

# ── launch template: throwaway spot hosts that terminate when idle ──────────
data=$(jq -n --arg ami "$AMI_ID" --arg type "${types%%,*}" --arg profile "$profile_arn" \
  --arg subnet "$subnet" --arg sg "$sg" --arg label "$label" '{
  ImageId: $ami, InstanceType: $type,
  IamInstanceProfile: {Arn: $profile},
  NetworkInterfaces: [{DeviceIndex: 0, SubnetId: $subnet, Groups: [$sg], AssociatePublicIpAddress: true}],
  MetadataOptions: {HttpTokens: "required", HttpEndpoint: "enabled"},
  InstanceMarketOptions: {MarketType: "spot", SpotOptions: {SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate"}},
  InstanceInitiatedShutdownBehavior: "terminate",
  BlockDeviceMappings: [{DeviceName: "/dev/sda1", Ebs: {VolumeSize: 80, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true}}],
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

# ── role: launch from THAT template, read the token, write own logs ─────────
new_role=0
if ! aws iam get-role --role-name "$role" >/dev/null 2>&1; then
  aws iam create-role --role-name "$role" --tags Key=Project,Value=ci-runner \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  new_role=1
fi
policy=$(jq -n --arg lt "$template_arn" --arg hostrole "$host_role" \
  --arg param "arn:aws:ssm:${region}:${account}:parameter${param}" \
  --arg logs "arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${fn}" '{
  Version: "2012-10-17",
  Statement: [
    {Effect: "Allow", Action: "ec2:RunInstances", Resource: "*", Condition: {ArnLike: {"ec2:LaunchTemplate": $lt}}},
    {Effect: "Allow", Action: "ec2:CreateTags", Resource: "*", Condition: {StringEquals: {"ec2:CreateAction": "RunInstances"}}},
    {Effect: "Allow", Action: "iam:PassRole", Resource: $hostrole},
    {Effect: "Allow", Action: "ec2:DescribeInstances", Resource: "*"},
    {Effect: "Allow", Action: "ssm:GetParameter", Resource: $param},
    {Effect: "Allow", Action: "kms:Decrypt", Resource: "*", Condition: {StringEquals: {"kms:ViaService": "ssm.\($lt | split(":")[3]).amazonaws.com"}}},
    {Effect: "Allow", Action: "logs:CreateLogGroup", Resource: $logs},
    {Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: ($logs + ":*")}
  ]}')
aws iam put-role-policy --role-name "$role" --policy-name fleet --policy-document "$policy"
(( new_role )) && sleep 15

# ── secret, function, URL ────────────────────────────────────────────────────
[[ -s "$secret_file" ]] || (umask 077; openssl rand -hex 32 > "$secret_file")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(umask 077; jq -n --rawfile s "$secret_file" --arg l "$label" --arg r "$repo" --arg t "$template" \
  --arg p "$param" --arg types "$types" --arg slots "$slots" --arg max "$max_hosts" \
  '{Variables: {MODE: "scale", WEBHOOK_SECRET: ($s | rtrimstr("\n")), RUNNER_LABEL: $l, REPOSITORY: $r,
    LAUNCH_TEMPLATE: $t, TOKEN_PARAMETER: $p, INSTANCE_TYPES: $types, SLOTS_PER_HOST: $slots, MAX_HOSTS: $max}}' > "$work/env.json")
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
# One evaluation at a time: a burst of deliveries must not launch a host each.
aws lambda put-function-concurrency --function-name "$fn" --reserved-concurrent-executions 1 >/dev/null

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

cat <<DONE
deploy: fleet ready. AMI ${AMI_ID}, template ${template}, up to ${max_hosts} hosts × ${slots} slots.
Scaler: ${url}

If the webhook is not there yet, add it on github.com/${repo} → Settings → Webhooks:
  Payload URL   ${url}
  Content type  application/json
  Secret        the contents of ${secret_file}
  Events        only "Workflow jobs"
The token in ${param} must also have Actions: Read, so the scaler can count the queue.
DONE
