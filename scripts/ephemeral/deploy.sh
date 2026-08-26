#!/bin/bash

# ============================================================
# Deploy to Digital Ocean Droplet
# ============================================================
# Creates a droplet, deploys code, runs docker compose
#
# Usage: ./deploy.sh [options]
#
# Options:
#   -n, --name NAME       Droplet name (default: app-deploy-TIMESTAMP)
#   -s, --size SIZE       Droplet size (default: s-2vcpu-4gb)
#   -b, --branch BRANCH   Git branch to deploy (default: current branch)
#   -k, --keep            Keep server running after deployment
#   -d, --destroy ID      Destroy existing droplet by ID
#   --db-only             Only start databases, skip app build
#   -h, --help            Show this help
#
# Environment variables:
#   DO_API_TOKEN          - Digital Ocean API token (required)
#   DO_SSH_PRIVATE_KEY_B64 - SSH private key base64 encoded (required)
#   SECRETS_PROVIDER      - Where app secrets come from: doppler (default) or
#                           none. With a provider, secrets are injected at
#                           container start and NO secret-bearing .env is
#                           written to the box; only a root-only (0600) service
#                           token lands on disk. `none` generates POSTGRES_*
#                           and AUTH_SECRET on the droplet into a root-only
#                           .env, which is the unmanaged throwaway-box path.
#   SECRETS_TOKEN         - The provider's service token (required unless the
#                           provider is `none`). DOPPLER_TOKEN is accepted as a
#                           fallback so existing callers keep working.
#   MIGRATE_SERVICE       - compose service that runs migrations (default:
#                           migrate). See STEP 5.
#   GITHUB_TOKEN          - For private repositories (optional)
#
# Examples:
#   ./deploy.sh                           # Deploy current branch
#   ./deploy.sh -b main -k                # Deploy main branch, keep server
#   ./deploy.sh -d 123456789              # Destroy droplet
#   ./deploy.sh --db-only                 # Only start databases
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_INFO_FILE="/tmp/server-info.json"
SSH_KEY_FILE="/tmp/do_ephemeral_key"

# Default values
DROPLET_NAME="app-deploy-$(date +%s)"
DROPLET_SIZE="s-2vcpu-4gb"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
KEEP_SERVER=false
DESTROY_ID=""
DB_ONLY=false
REPO_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--name)
            DROPLET_NAME="$2"
            shift 2
            ;;
        -s|--size)
            DROPLET_SIZE="$2"
            shift 2
            ;;
        -b|--branch)
            BRANCH="$2"
            shift 2
            ;;
        -k|--keep)
            KEEP_SERVER=true
            shift
            ;;
        -d|--destroy)
            DESTROY_ID="$2"
            shift 2
            ;;
        --db-only)
            DB_ONLY=true
            shift
            ;;
        -h|--help)
            head -40 "$0" | tail -35
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Handle destroy command
if [ -n "$DESTROY_ID" ]; then
    echo "Destroying droplet: $DESTROY_ID"
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -X DELETE "https://api.digitalocean.com/v2/droplets/$DESTROY_ID" \
        -H "Authorization: Bearer $DO_API_TOKEN")
    if [ "$HTTP_CODE" = "204" ]; then
        echo "Droplet destroyed successfully!"
    else
        echo "Failed to destroy droplet (HTTP $HTTP_CODE)"
        exit 1
    fi
    exit 0
fi

# Validate environment
if [ -z "$DO_API_TOKEN" ]; then
    echo "Error: DO_API_TOKEN environment variable is required"
    exit 1
fi

if [ -z "$DO_SSH_PRIVATE_KEY_B64" ]; then
    echo "Error: DO_SSH_PRIVATE_KEY_B64 environment variable is required"
    exit 1
fi

if [ -z "$REPO_URL" ]; then
    echo "Error: Could not detect repository URL. Run from a git repository."
    exit 1
fi

# Resolve the secrets provider. Validated HERE, before anything is created —
# failing later would mean creating (and then tearing down) a droplet for a run
# that could never have succeeded.
SECRETS_PROVIDER="${SECRETS_PROVIDER:-doppler}"
SECRETS_TOKEN="${SECRETS_TOKEN:-${DOPPLER_TOKEN:-}}"
TOKEN_FILE="/root/.secrets-token"
MIGRATE_SERVICE="${MIGRATE_SERVICE:-migrate}"

case "$SECRETS_PROVIDER" in
    doppler)
        SECRETS_INSTALL="curl -Ls https://cli.doppler.com/install.sh | sh"
        # Injects the config into the child process, which is what resolves
        # ${VAR} interpolation in docker-compose.yml.
        SECRETS_RUN="DOPPLER_TOKEN=\$(cat $TOKEN_FILE) doppler run --"
        ;;
    none)
        SECRETS_INSTALL=""
        SECRETS_RUN=""
        ;;
    *)
        echo "Error: unknown SECRETS_PROVIDER '$SECRETS_PROVIDER' (expected: doppler, none)" >&2
        exit 1
        ;;
esac

if [ "$SECRETS_PROVIDER" != "none" ] && [ -z "$SECRETS_TOKEN" ]; then
    echo "Error: SECRETS_TOKEN is required for SECRETS_PROVIDER=$SECRETS_PROVIDER" >&2
    echo "  Doppler: doppler configs tokens create deploy --project <p> --config prd --plain" >&2
    echo "  Or set SECRETS_PROVIDER=none for an unmanaged throwaway box." >&2
    exit 1
fi

# Setup SSH key
echo "$DO_SSH_PRIVATE_KEY_B64" | tr -d ' \n\r\t' | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"

echo ""
echo "============================================================"
echo "  DEPLOYMENT - Digital Ocean"
echo "============================================================"
echo ""
echo "  Repository: $REPO_URL"
echo "  Branch:     $BRANCH"
echo "  Droplet:    $DROPLET_NAME ($DROPLET_SIZE)"
echo "  Keep:       $KEEP_SERVER"
echo "  DB Only:    $DB_ONLY"
echo ""

# Cleanup function
cleanup() {
    local exit_code=$?
    if [ "$KEEP_SERVER" = "true" ]; then
        echo ""
        echo "KEEP_SERVER=true - Server will NOT be destroyed"
        if [ -f "$SERVER_INFO_FILE" ]; then
            echo ""
            echo "Server info:"
            jq '.' "$SERVER_INFO_FILE"
            echo ""
            SERVER_IP=$(jq -r '.ip' "$SERVER_INFO_FILE")
            DROPLET_ID=$(jq -r '.id' "$SERVER_INFO_FILE")
            echo "Access:"
            echo "  Web app:  http://$SERVER_IP:3000"
            echo "  Docs:     http://$SERVER_IP:3001"
            echo "  Postgres: $SERVER_IP:5432"
            echo "  Redis:    $SERVER_IP:6379"
            echo ""
            echo "Destroy with: ./deploy.sh -d $DROPLET_ID"
        fi
    else
        echo "Cleaning up..."
        if [ -f "$SERVER_INFO_FILE" ]; then
            DROPLET_ID=$(jq -r '.id' "$SERVER_INFO_FILE")
            curl -s -X DELETE "https://api.digitalocean.com/v2/droplets/$DROPLET_ID" \
                -H "Authorization: Bearer $DO_API_TOKEN" || true
            rm -f "$SERVER_INFO_FILE"
        fi
        rm -f "$SSH_KEY_FILE"
    fi
    exit $exit_code
}

trap cleanup EXIT

# Remote execution helper
remote_exec() {
    local ip=$(jq -r '.ip' "$SERVER_INFO_FILE")
    ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR -i "$SSH_KEY_FILE" root@$ip "$@"
}

# ============================================================
# STEP 1: Create Droplet
# ============================================================
echo "------------------------------------------------------------"
echo "STEP 1/5: Creating droplet..."
echo "------------------------------------------------------------"

"$SCRIPT_DIR/create-server.sh" "$DROPLET_NAME" "$DROPLET_SIZE"

SERVER_IP=$(jq -r '.ip' "$SERVER_INFO_FILE")
echo "Server IP: $SERVER_IP"

# ============================================================
# STEP 2: Clone Repository
# ============================================================
echo ""
echo "------------------------------------------------------------"
echo "STEP 2/5: Cloning repository..."
echo "------------------------------------------------------------"

if [ -n "$GITHUB_TOKEN" ]; then
    REPO_WITH_TOKEN=$(echo "$REPO_URL" | sed "s|https://|https://${GITHUB_TOKEN}@|")
    remote_exec "git clone --branch $BRANCH --depth 1 '$REPO_WITH_TOKEN' /app"
else
    remote_exec "git clone --branch $BRANCH --depth 1 '$REPO_URL' /app"
fi

echo "Repository cloned to /app"

# ============================================================
# STEP 3: Provision secret access
#
# With a provider, NO secret-bearing .env is written to the box: secrets live in
# the provider's config and are injected at container-start time by STEP 4. Only
# the service token lands on the droplet, root-only (0600), and it is piped over
# ssh STDIN rather than passed as an argument — an argument is visible in the
# remote host's process list to every user on it, for as long as the command
# runs.
#
# `none` keeps the old shape for a throwaway box, with the two fixes it needed
# anyway: the values are generated ON THE DROPLET rather than locally, so they
# never cross the wire, and the file is 0600 rather than world-readable.
# ============================================================
echo ""
echo "------------------------------------------------------------"
echo "STEP 3/5: Configuring secret access..."
echo "------------------------------------------------------------"

if [ "$SECRETS_PROVIDER" = "none" ]; then
    remote_exec "umask 077 && cat > /app/.env << ENVFILE
# Database
POSTGRES_USER=app
POSTGRES_PASSWORD=app_secret_\$(openssl rand -hex 8)
POSTGRES_DB=app

# Auth
AUTH_SECRET=\$(openssl rand -hex 32)
AUTH_URL=http://$SERVER_IP:3000

# Ports
WEB_PORT=3000
DOCS_PORT=3001
POSTGRES_PORT=5432
REDIS_PORT=6379
ENVFILE
chmod 600 /app/.env"
    echo "Environment configured (unmanaged; generated on the droplet, root-only)"
else
    remote_exec "$SECRETS_INSTALL"
    printf '%s' "$SECRETS_TOKEN" | remote_exec "cat > $TOKEN_FILE && chmod 600 $TOKEN_FILE"
    echo "$SECRETS_PROVIDER installed; service token provisioned root-only"
fi

# ============================================================
# STEP 4: Start Docker Compose
# ============================================================
echo ""
echo "------------------------------------------------------------"
echo "STEP 4/5: Starting Docker Compose..."
echo "------------------------------------------------------------"

# Every compose invocation goes through the provider, which is what puts the app
# secrets in the environment without their ever being written to disk.
if [ "$DB_ONLY" = "true" ]; then
    echo "Starting databases only..."
    remote_exec "cd /app && $SECRETS_RUN docker compose up -d postgres redis"
else
    echo "Building and starting all services..."
    remote_exec "cd /app && $SECRETS_RUN docker compose up -d --build"
fi

echo "Waiting for services to start (30s)..."
sleep 30

# ============================================================
# STEP 5: Run Migrations & Health Check
# ============================================================
echo ""
echo "------------------------------------------------------------"
echo "STEP 5/5: Running migrations and health check..."
echo "------------------------------------------------------------"

# Run migrations if not db-only.
#
# This step FAILS THE DEPLOY when it fails. It used to end in
# `|| echo "Migration skipped (may not exist)"`, which meant a migration that
# could not run -- or a migrations folder that never made it into the image --
# reported success and the app booted against the old schema, with nothing
# anywhere saying the migration had not run. A deploy whose schema did not move
# is not a successful deploy.
#
# It also ran through the `web` service, which is the application runner: it
# carries no migration tree and no Prisma working directory, so the command
# could never have worked. The `|| echo` then swallowed that, so every deploy
# reported success while applying nothing. Use the dedicated migrator service
# instead -- built from the same artifact set precisely for this, and one-shot
# via `run --rm`. Override the name with MIGRATE_SERVICE.
if [ "$DB_ONLY" = "false" ]; then
    if ! remote_exec "cd /app && $SECRETS_RUN docker compose --profile tools config --services 2>/dev/null | grep -qx '$MIGRATE_SERVICE'"; then
        echo "ERROR: compose defines no '$MIGRATE_SERVICE' service, so migrations cannot run."
        echo "       Add one (a one-shot image carrying the migration tree), or set"
        echo "       MIGRATE_SERVICE to the name yours uses."
        exit 1
    fi

    echo "Running database migrations via the '$MIGRATE_SERVICE' service..."
    if ! remote_exec "cd /app && $SECRETS_RUN docker compose run --rm -T $MIGRATE_SERVICE < /dev/null"; then
        echo "ERROR: migrations FAILED. The application would run against an unmigrated"
        echo "       schema; deploy aborted so this is not mistaken for success."
        exit 1
    fi
fi

echo ""
echo "Container status:"
remote_exec "cd /app && docker compose ps"

echo ""
echo "Health checks:"
if curl -s --connect-timeout 5 "http://$SERVER_IP:3000" > /dev/null 2>&1; then
    echo "  Web app (3000): OK"
else
    echo "  Web app (3000): Not responding yet"
fi

if curl -s --connect-timeout 5 "http://$SERVER_IP:3001" > /dev/null 2>&1; then
    echo "  Docs (3001): OK"
else
    echo "  Docs (3001): Not responding yet"
fi

# ============================================================
# Result
# ============================================================
echo ""
echo "============================================================"
echo "  DEPLOYMENT COMPLETE"
echo "============================================================"
echo ""
echo "  Web app:  http://$SERVER_IP:3000"
echo "  Docs:     http://$SERVER_IP:3001"
echo ""

# Keep server flag is handled by cleanup trap
KEEP_SERVER=true
