#!/usr/bin/env bash
# Write the runner PAT from SSM (CI_RUNNER_TOKEN_PARAMETER) to
# /etc/ci-runner/token.env, 0600, for the slot and idle units to read. A no-op
# when no parameter is configured (the token then lives in the env file).
# Needs the instance role to allow ssm:GetParameter on that parameter.
set -euo pipefail
[[ -n "${CI_RUNNER_TOKEN_PARAMETER:-}" ]] || exit 0
out=/etc/ci-runner/token.env
umask 077
value=$(aws ssm get-parameter --region "${CI_RUNNER_REGION:?}" --with-decryption \
  --name "$CI_RUNNER_TOKEN_PARAMETER" --query Parameter.Value --output text)
[[ -n "$value" ]] || { echo "fetch-credential: ${CI_RUNNER_TOKEN_PARAMETER} is empty" >&2; exit 1; }
printf 'CI_RUNNER_TOKEN=%s\n' "$value" > "${out}.tmp"
mv "${out}.tmp" "$out"
