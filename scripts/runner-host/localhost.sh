#!/usr/bin/env bash
# Make `localhost` mean 127.0.0.1 only, as it does on GitHub's Ubuntu runner.
#
# Docker writes `::1 localhost ip6-localhost ip6-loopback` into a container's
# /etc/hosts; Ubuntu's own file names ::1 only `ip6-localhost ip6-loopback`.
# Inside the container `localhost` therefore resolves to ::1 first, so a server
# that binds to `localhost` (Vite's default) listens on ::1 alone, while a
# client that tries 127.0.0.1 is refused. future-pay's Playwright web servers
# never became ready that way, three times out of three (#1978), on a runner
# where the same job passes on ubuntu-latest.
#
# /etc/hosts is a bind mount Docker owns: it is rewritten in place, not
# replaced. Runs as root, from the entrypoint, before the job starts.
set -euo pipefail
hosts="${CI_RUNNER_HOSTS_FILE:-/etc/hosts}"
fixed=$(sed -E '/^::1[[:space:]]/ s/[[:space:]]localhost([[:space:]]|$)/\1/' "$hosts")
printf '%s\n' "$fixed" > "$hosts"
