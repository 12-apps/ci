#!/bin/bash

# ============================================================
# Deploy to Digital Ocean using Cloud-Init (No SSH required)
# ============================================================
# Creates a droplet that auto-deploys via cloud-init user-data
#
# Usage: ./deploy-cloud-init.sh [options]
#
# Options:
#   -n, --name NAME       Droplet name (default: app-TIMESTAMP)
#   -s, --size SIZE       Droplet size (default: s-1vcpu-1gb, +2G swap for build)
#   -b, --branch BRANCH   Git branch to deploy (default: main)
#   -d, --destroy ID      Destroy existing droplet by ID
#   -l, --list            List running droplets
#   -p, --print-user-data Render the cloud-init user-data and exit, creating
#                         nothing and calling no API. What it prints is exactly
#                         what a real run would ship.
#   -h, --help            Show this help
#
# Environment variables:
#   DO_API_TOKEN          - Digital Ocean API token (required)
#   SECRETS_PROVIDER      - Where app secrets come from: doppler (default) or
#                           none. See "Secrets" below.
#   SECRETS_TOKEN         - The provider's service token (required unless the
#                           provider is `none`). DOPPLER_TOKEN is accepted as a
#                           fallback so existing callers keep working.
#   GITHUB_TOKEN          - For private repositories (optional)
#
# Secrets
# -------
# App secrets are INJECTED AT CONTAINER START by the provider, and no
# secret-bearing .env is written to the box. Only the provider's service token
# lands on disk, root-only (0600).
#
# That token has to reach the droplet somehow, and the only channel a fresh
# droplet has is cloud-init user-data — which the metadata endpoint serves to
# ANY process on the box, root or not. So the FIRST thing runcmd does is drop
# non-root egress to 169.254.169.254, before the token is ever written. Without
# that, an unprivileged process could read the user-data back and lift both the
# service token and the clone URL's GITHUB_TOKEN.
#
# `SECRETS_PROVIDER=none` is the unmanaged escape hatch for a throwaway box: it
# generates POSTGRES_PASSWORD / AUTH_SECRET ON THE DROPLET (never in user-data)
# and writes them to a root-only /app/.env. It cannot carry OAuth credentials —
# an OAuth secret would have to be interpolated into user-data to get here, and
# an input that can only be used unsafely should not exist.
# ============================================================

set -e

# Default values
DROPLET_NAME="app-$(date +%s)"
DROPLET_SIZE="s-1vcpu-1gb"
BRANCH="main"
PRINT_ONLY=false
REGION="nyc1"
IMAGE="ubuntu-24-04-x64"
# Override with REPO_URL=... (CI passes the running repo's clone URL) so this
# script is portable to any repository; the literal is only a local-run default.
REPO_URL="${REPO_URL:-https://github.com/12-apps/future-pay.git}"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--name) DROPLET_NAME="$2"; shift 2 ;;
        -s|--size) DROPLET_SIZE="$2"; shift 2 ;;
        -b|--branch) BRANCH="$2"; shift 2 ;;
        -p|--print-user-data) PRINT_ONLY=true; shift ;;
        -d|--destroy)
            echo "Destroying droplet: $2"
            curl -sk -X DELETE "https://api.digitalocean.com/v2/droplets/$2" \
                -H "Authorization: Bearer $DO_API_TOKEN"
            echo "Done"
            exit 0
            ;;
        -l|--list)
            echo "Active droplets:"
            curl -sk "https://api.digitalocean.com/v2/droplets" \
                -H "Authorization: Bearer $DO_API_TOKEN" | \
                jq -r '.droplets[] | "  \(.id) | \(.name) | \(.networks.v4[0].ip_address) | \(.status)"'
            exit 0
            ;;
        -h|--help) head -28 "$0" | tail -23; exit 0 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Validate. A dry run creates nothing and calls no API, so it needs no token —
# which is what lets a test render the user-data and assert on it.
if [ -z "$DO_API_TOKEN" ] && [ "$PRINT_ONLY" = "false" ]; then
    echo "Error: DO_API_TOKEN required"
    exit 1
fi

# Get SSH key ID (may fail if token lacks account:read scope)
if [ "$PRINT_ONLY" = "true" ]; then
    SSH_KEY_ID=""
else
    SSH_RESPONSE=$(curl -sk "https://api.digitalocean.com/v2/account/keys" \
        -H "Authorization: Bearer $DO_API_TOKEN")
    SSH_KEY_ID=$(echo "$SSH_RESPONSE" | jq -r '.ssh_keys[0].id // empty' 2>/dev/null || echo "")
fi

if [ -z "$SSH_KEY_ID" ] || [ "$SSH_KEY_ID" = "null" ]; then
    echo "Warning: Could not get SSH keys (token may lack account:read scope)"
    echo "         Droplet will have no SSH access"
    SSH_KEYS_JSON="[]"
else
    echo "Using SSH key ID: $SSH_KEY_ID"
    SSH_KEYS_JSON="[\"$SSH_KEY_ID\"]"
fi

# Resolve the secrets provider. A provider contributes three things to the
# cloud-init below: how to install its CLI, and how to wrap a command so the
# secrets are in its environment. Adding a vendor is adding a case here — the
# rest of this script does not know which one it is using.
SECRETS_PROVIDER="${SECRETS_PROVIDER:-doppler}"
# DOPPLER_TOKEN is the name every existing caller already sets.
SECRETS_TOKEN="${SECRETS_TOKEN:-${DOPPLER_TOKEN:-}}"
TOKEN_FILE="/root/.secrets-token"

case "$SECRETS_PROVIDER" in
    doppler)
        SECRETS_INSTALL="curl -Ls https://cli.doppler.com/install.sh | sh"
        # Reads the token from the env and injects the config into the child, which
        # is what resolves \${VAR} interpolation in docker-compose.yml.
        SECRETS_RUN="DOPPLER_TOKEN=\$(cat $TOKEN_FILE) doppler run --"
        ;;
    none)
        SECRETS_INSTALL=""
        SECRETS_RUN=""
        ;;
    *)
        echo "Error: unknown SECRETS_PROVIDER '$SECRETS_PROVIDER' (expected: doppler, none)"
        exit 1
        ;;
esac

if [ "$SECRETS_PROVIDER" != "none" ] && [ -z "$SECRETS_TOKEN" ]; then
    echo "Error: SECRETS_TOKEN required for SECRETS_PROVIDER=$SECRETS_PROVIDER"
    echo "  Doppler: doppler configs tokens create deploy --project <p> --config prd --plain"
    echo "  Or set SECRETS_PROVIDER=none for an unmanaged throwaway box."
    exit 1
fi

# Prepare GitHub clone URL
if [ -n "$GITHUB_TOKEN" ]; then
    CLONE_URL=$(echo "$REPO_URL" | sed "s|https://|https://${GITHUB_TOKEN}@|")
else
    CLONE_URL="$REPO_URL"
fi

# Everything informational goes to stderr from here on, so `--print-user-data`
# emits the document and nothing else.
if [ "$PRINT_ONLY" = "true" ]; then exec 3>&2; else exec 3>&1; fi
echo "" >&3
echo "============================================================" >&3
echo "  CLOUD-INIT DEPLOYMENT" >&3
echo "============================================================" >&3
echo "  Name:   $DROPLET_NAME" >&3
echo "  Size:   $DROPLET_SIZE" >&3
echo "  Branch: $BRANCH" >&3
echo "  Repo:   $REPO_URL" >&3
echo "" >&3

if [ "$SECRETS_PROVIDER" = "none" ]; then
    echo "  Secrets: unmanaged — generated on the droplet into a root-only /app/.env" >&3
else
    echo "  Secrets: injected at container start via $SECRETS_PROVIDER" >&3
fi
echo "" >&3

# The two halves of the cloud-init that depend on the provider. With `none`
# there is no CLI to install and no token to write; the box falls back to
# secrets it generates ITSELF, which is why they can be root-only (0600) —
# nothing off-box ever needs to read them, and they are never in user-data.
if [ "$SECRETS_PROVIDER" = "none" ]; then
    # Every line of the block scalar is indented by four, INCLUDING the heredoc
    # body and its ENVEOF terminator. YAML strips that common indent before the
    # shell ever sees it, so the script still receives a column-0 terminator —
    # and the document parses. Written at column 0, as the pre-port version
    # wrote it, the .env body escapes the `- |` scalar and the ENTIRE user-data
    # is invalid YAML. cloud-init then runs nothing at all and the droplet comes
    # up bare, with no error on any surface the caller can see. That is not
    # hypothetical: rendering `main`'s copy of this script and parsing the
    # result is how it was found.
    SECRETS_SETUP="  # No secrets provider: generate them on the box, root-only. These values
  # exist only here — they are NOT interpolated into user-data.
  - |
    IP=\$(curl -sk http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)
    umask 077
    cat > /app/.env << ENVEOF
    POSTGRES_USER=app
    POSTGRES_PASSWORD=app_secret_\$(openssl rand -hex 8)
    POSTGRES_DB=app
    AUTH_SECRET=\$(openssl rand -hex 32)
    AUTH_URL=http://\$IP
    AUTH_TRUST_HOST=true
    ENVEOF
    chmod 600 /app/.env"
else
    SECRETS_SETUP="  # Install the provider CLI and drop its service token root-only (0600). App
  # secrets are never written to disk — the provider injects them into each
  # compose invocation below, resolving \${VAR} interpolation in
  # docker-compose.yml. The token itself does travel inside user-data; the
  # metadata rule at the top of runcmd is what keeps a non-root process from
  # reading it back.
  - $SECRETS_INSTALL
  - printf '%s' '$SECRETS_TOKEN' > $TOKEN_FILE && chmod 600 $TOKEN_FILE"
fi

# Cloud-init script
# Note: Uses official Docker install script (docker.io package lacks compose plugin)
CLOUD_INIT=$(cat <<CLOUDINIT
#cloud-config
package_update: true
packages:
  - git
  - curl
  - jq
  - iptables
  - iptables-persistent
  - netfilter-persistent

runcmd:
  # SECURITY, and FIRST — before any token is written below. Whatever reaches
  # this box does so through cloud-init user-data (the provider's service token,
  # the clone URL's GITHUB_TOKEN), and user-data is served by the metadata
  # endpoint to ANY process on the droplet. Drop non-root egress to
  # 169.254.169.254 so an unprivileged process cannot read the user-data back
  # and lift them. Root — the deploy steps below, which read the metadata IP —
  # is unaffected. Persisted via netfilter-persistent so it survives a reboot
  # (kernel update, droplet reboot action); otherwise a post-reboot non-root
  # process could read the user-data.
  - iptables -A OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j DROP
  - netfilter-persistent save
  - systemctl enable netfilter-persistent

  # Add 2G swap so the on-box Next.js build survives on a 1GB droplet
  - |
    if [ ! -f /swapfile ]; then
      fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
      chmod 600 /swapfile
      mkswap /swapfile
      swapon /swapfile
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi

  # Install Docker using official script (includes compose plugin)
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable docker
  - systemctl start docker

  # Clone repository
  - git clone --branch $BRANCH --depth 1 "$CLONE_URL" /app

$SECRETS_SETUP

  # Build images, run migrations (the migrate service is profiles:[tools] and is
  # NOT started by \`up\`), then start the stack — otherwise web boots against an
  # unmigrated DB on a fresh droplet. Each step runs under the secrets provider,
  # which is what puts the app secrets in the environment without them ever
  # being written to disk.
  #
  # The backticks above are escaped deliberately: this heredoc is UNQUOTED (it
  # has to be, to interpolate the values below), so a bare \`up\` is command
  # substitution — it ran `up`, swallowed the word, and shipped the result into
  # the droplet's user-data.
  - cd /app && $SECRETS_RUN docker compose build
  - cd /app && $SECRETS_RUN docker compose run --rm migrate
  - cd /app && $SECRETS_RUN docker compose up -d

  # Signal completion
  - echo "DEPLOYMENT_COMPLETE" > /tmp/deploy-status
  - |
    IP=\$(curl -sk http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)
    echo "Deployment complete!" > /tmp/deploy-info
    echo "Web: http://\$IP" >> /tmp/deploy-info
    echo "Docs: http://\$IP/docs" >> /tmp/deploy-info
    echo "Health: http://\$IP/health" >> /tmp/deploy-info
CLOUDINIT
)

# A dry run stops here: the document above is exactly what a real run ships.
if [ "$PRINT_ONLY" = "true" ]; then
    printf '%s\n' "$CLOUD_INIT"
    exit 0
fi

# Create droplet
echo "Creating droplet..."

RESPONSE=$(curl -sk -X POST "https://api.digitalocean.com/v2/droplets" \
    -H "Authorization: Bearer $DO_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
        \"name\": \"$DROPLET_NAME\",
        \"size\": \"$DROPLET_SIZE\",
        \"image\": \"$IMAGE\",
        \"region\": \"$REGION\",
        \"ssh_keys\": $SSH_KEYS_JSON,
        \"user_data\": $(echo "$CLOUD_INIT" | jq -Rs .)
    }")

DROPLET_ID=$(echo "$RESPONSE" | jq -r '.droplet.id')

if [ "$DROPLET_ID" = "null" ] || [ -z "$DROPLET_ID" ]; then
    echo "Error creating droplet:"
    echo "$RESPONSE" | jq '.'
    exit 1
fi

echo "Droplet ID: $DROPLET_ID"
echo "Waiting for IP..."

# Wait for IP
for i in {1..30}; do
    DROPLET_INFO=$(curl -sk "https://api.digitalocean.com/v2/droplets/$DROPLET_ID" \
        -H "Authorization: Bearer $DO_API_TOKEN")

    STATUS=$(echo "$DROPLET_INFO" | jq -r '.droplet.status')
    IP=$(echo "$DROPLET_INFO" | jq -r '.droplet.networks.v4[] | select(.type=="public") | .ip_address' | head -1)

    if [ "$STATUS" = "active" ] && [ -n "$IP" ] && [ "$IP" != "null" ]; then
        break
    fi
    echo "  Status: $STATUS - waiting... ($i/30)"
    sleep 5
done

if [ -z "$IP" ] || [ "$IP" = "null" ]; then
    echo "Error: Could not get IP address"
    exit 1
fi

echo ""
echo "============================================================"
echo "  DROPLET CREATED"
echo "============================================================"
echo ""
echo "  ID:     $DROPLET_ID"
echo "  IP:     $IP"
echo "  Status: $STATUS"
echo ""
echo "  Cloud-init is now installing Docker and deploying..."
echo "  This takes 5-8 minutes."
echo ""
echo "  Endpoints (via nginx reverse proxy on port 80):"
echo "    http://$IP/          # Web app"
echo "    http://$IP/docs      # Docs"
echo "    http://$IP/api       # API"
echo "    http://$IP/health    # Health check"
echo ""
echo "  Destroy:"
echo "    ./deploy-cloud-init.sh -d $DROPLET_ID"
echo ""
