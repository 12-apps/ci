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
# STEP 3: Create .env file
# ============================================================
echo ""
echo "------------------------------------------------------------"
echo "STEP 3/5: Configuring environment..."
echo "------------------------------------------------------------"

remote_exec "cat > /app/.env << 'ENVFILE'
# Database
POSTGRES_USER=app
POSTGRES_PASSWORD=app_secret_$(openssl rand -hex 8)
POSTGRES_DB=app

# Auth
AUTH_SECRET=$(openssl rand -hex 32)
AUTH_URL=http://$SERVER_IP:3000

# Ports
WEB_PORT=3000
DOCS_PORT=3001
POSTGRES_PORT=5432
REDIS_PORT=6379
ENVFILE"

echo "Environment configured"

# ============================================================
# STEP 4: Start Docker Compose
# ============================================================
echo ""
echo "------------------------------------------------------------"
echo "STEP 4/5: Starting Docker Compose..."
echo "------------------------------------------------------------"

if [ "$DB_ONLY" = "true" ]; then
    echo "Starting databases only..."
    remote_exec "cd /app && docker compose up -d postgres redis"
else
    echo "Building and starting all services..."
    remote_exec "cd /app && docker compose up -d --build"
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

# Run Prisma migrations if not db-only
if [ "$DB_ONLY" = "false" ]; then
    echo "Running database migrations..."
    remote_exec "cd /app && docker compose exec -T web npx prisma migrate deploy" || echo "Migration skipped (may not exist)"
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
