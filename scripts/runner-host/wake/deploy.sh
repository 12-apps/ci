#!/usr/bin/env bash
# Create or update the wake Lambda: a GitHub webhook calls its URL for every
# job, and it starts the CI host when a job for the host is queued.
#
#   AWS_PROFILE=ci-runner-admin INSTANCE_ID=i-0123... ./deploy.sh
#
# Needs IAM and Lambda rights (an admin profile), once. Idempotent: re-run it
# to ship a new version or point it at a replacement host.
#
# Env: INSTANCE_ID (required), AWS_REGION (us-east-1), REPOSITORY
# (12-apps/future-pay), RUNNER_LABEL (future-pay-ci), FUNCTION_NAME
# (ci-runner-wake), WAKE_SECRET_FILE (~/.ci-runner-wake-secret; created 0600
# on the first run, and the webhook must be given the same value).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
: "${INSTANCE_ID:?set INSTANCE_ID to the CI host (i-...)}"
region="${AWS_REGION:-us-east-1}"
repo="${REPOSITORY:-12-apps/future-pay}"
label="${RUNNER_LABEL:-future-pay-ci}"
fn="${FUNCTION_NAME:-ci-runner-wake}"
role="${fn}"
secret_file="${WAKE_SECRET_FILE:-$HOME/.ci-runner-wake-secret}"
aws() { command aws --region "$region" --output text "$@"; }

account=$(aws sts get-caller-identity --query Account)
aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name' >/dev/null \
  || { echo "deploy: cannot see instance ${INSTANCE_ID} in ${region}" >&2; exit 1; }

# ── role: start THIS instance, write its own logs, nothing else ─────────────
new_role=0
if ! aws iam get-role --role-name "$role" >/dev/null 2>&1; then
  aws iam create-role --role-name "$role" --tags Key=Project,Value=ci-runner \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  new_role=1
fi
policy=$(jq -n --arg inst "arn:aws:ec2:${region}:${account}:instance/${INSTANCE_ID}" \
  --arg logs "arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${fn}" '{
  Version: "2012-10-17",
  Statement: [
    {Effect: "Allow", Action: "ec2:StartInstances", Resource: $inst},
    {Effect: "Allow", Action: "ec2:DescribeInstances", Resource: "*"},
    {Effect: "Allow", Action: "logs:CreateLogGroup", Resource: $logs},
    {Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: ($logs + ":*")}
  ]}')
aws iam put-role-policy --role-name "$role" --policy-name wake --policy-document "$policy"
# A role is not assumable by Lambda for a few seconds after it is created.
(( new_role )) && sleep 15

# ── secret: generated once, never printed ────────────────────────────────────
if [[ ! -s "$secret_file" ]]; then
  (umask 077; openssl rand -hex 32 > "$secret_file")
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(umask 077; jq -n --rawfile s "$secret_file" --arg i "$INSTANCE_ID" --arg l "$label" --arg r "$repo" \
  '{Variables: {WEBHOOK_SECRET: ($s | rtrimstr("\n")), INSTANCE_ID: $i, RUNNER_LABEL: $l, REPOSITORY: $r}}' > "$work/env.json")
cp "$here/wake.mjs" "$here/index.mjs" "$work/"
(cd "$work" && python3 -m zipfile -c fn.zip wake.mjs index.mjs)

# ── function ─────────────────────────────────────────────────────────────────
if aws lambda get-function --function-name "$fn" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$work/fn.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$fn"
  aws lambda update-function-configuration --function-name "$fn" --environment "file://$work/env.json" >/dev/null
else
  aws lambda create-function --function-name "$fn" --runtime nodejs22.x --handler index.handler \
    --role "arn:aws:iam::${account}:role/${role}" --timeout 90 --memory-size 128 \
    --zip-file "fileb://$work/fn.zip" --environment "file://$work/env.json" \
    --tags Project=ci-runner >/dev/null
fi
aws lambda wait function-updated-v2 --function-name "$fn"

# ── public URL: the handler rejects anything not signed with the secret ─────
url=$(aws lambda get-function-url-config --function-name "$fn" --query FunctionUrl 2>/dev/null || true)
if [[ -z "$url" || "$url" == None ]]; then
  url=$(aws lambda create-function-url-config --function-name "$fn" --auth-type NONE --query FunctionUrl)
fi
aws lambda add-permission --function-name "$fn" --statement-id url-invoke \
  --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null 2>&1 || true
aws lambda add-permission --function-name "$fn" --statement-id url-invoke-function \
  --action lambda:InvokeFunction --principal '*' --invoked-via-function-url >/dev/null 2>&1 || true

# ── prove it answers a signed ping ───────────────────────────────────────────
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
deploy: ${fn} answers at ${url} and can start ${INSTANCE_ID}.

Now add the webhook on github.com/${repo} → Settings → Webhooks → Add webhook:
  Payload URL   ${url}
  Content type  application/json
  Secret        the contents of ${secret_file}
  Events        Let me select individual events → only "Workflow jobs"
GitHub sends a ping on save; Recent Deliveries should show 200 "pong".
DONE
