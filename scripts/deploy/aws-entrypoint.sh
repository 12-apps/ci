#!/usr/bin/env bash
# Shared adapter for the reusable workflow and composite action. All caller
# values are data in environment variables, never interpolated shell source.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
args=("$DEPLOY_ACTION" --region "$DEPLOY_REGION" --expected-account "$DEPLOY_ACCOUNT" --stack "$DEPLOY_STACK" --container "$DEPLOY_CONTAINER" --mount "$DEPLOY_MOUNT" --destination "$DEPLOY_DESTINATION" --ready-file "$DEPLOY_READY_FILE" --port "$DEPLOY_PORT" --health "$DEPLOY_HEALTH" --timeout "$DEPLOY_TIMEOUT")
if [ -n "${DEPLOY_IMAGE:-}" ]; then args+=(--image "$DEPLOY_IMAGE"); fi
if [ -n "${DEPLOY_TEMPLATE:-}" ]; then args+=(--template "$DEPLOY_TEMPLATE"); fi
if [ -n "${DEPLOY_PARAMETERS:-}" ]; then args+=(--parameters "$DEPLOY_PARAMETERS"); fi
exec node "$script_dir/aws.mjs" "${args[@]}"
