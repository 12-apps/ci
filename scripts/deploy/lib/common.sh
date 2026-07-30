# shellcheck shell=bash
#
# Shared helpers for the deploy discovery engine.
# Mirrors scripts/rotate/lib/common.sh so the two subsystems stay self-contained
# (each can be extracted to a shared CI repo independently).

err()    { printf '::error::%s\n' "$*" >&2; }
die()    { err "$*"; exit 1; }
log()    { printf '%s\n' "$*" >&2; }
warn()   { printf '::warning::%s\n' "$*" >&2; }
notice() { printf '::notice::%s\n' "$*" >&2; }

# Extract a string value by key from a JSON object blob (e.g. toJSON(vars)).
# Empty string when the key is absent/null.
json_str() { jq -r --arg k "$2" '.[$k] // ""' <<<"${1:-{}}"; }
