#!/bin/bash

# Ephemeral Test Server - Complete workflow (Digital Ocean)
# Creates droplet, clones repo, runs docker compose, executes tests, destroys droplet
#
# Usage: ./run-ephemeral-test.sh <repo-url> [branch] [test-command]
#
# Environment variables:
#   DO_API_TOKEN          - Digital Ocean API token (required)
#   DO_SSH_PRIVATE_KEY_B64 - SSH private key base64 encoded (required)
#   GITHUB_TOKEN          - For private repositories (optional)
#   DROPLET_SIZE          - Digital Ocean droplet size (default: s-2vcpu-4gb)
#   KEEP_SERVER           - Set to "true" to keep server after tests (for debugging)
#
# Examples:
#   ./run-ephemeral-test.sh https://github.com/user/repo.git main "pnpm test"
#   KEEP_SERVER=true ./run-ephemeral-test.sh https://github.com/user/repo.git

set -e

REPO_URL="${1:?Error: Repository URL is required}"
BRANCH="${2:-main}"
TEST_COMMAND="${3:-pnpm test}"
DROPLET_SIZE="${DROPLET_SIZE:-s-2vcpu-4gb}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_INFO_FILE="/tmp/server-info.json"
SSH_KEY_FILE="/tmp/do_ephemeral_key"

# Validate required environment
if [ -z "$DO_SSH_PRIVATE_KEY_B64" ]; then
    echo "Error: DO_SSH_PRIVATE_KEY_B64 environment variable is required"
    echo "Encode your key with: cat ~/.ssh/your_key | base64 -w 0"
    exit 1
fi

# Setup SSH key from environment variable (base64 encoded)
echo "$DO_SSH_PRIVATE_KEY_B64" | tr -d ' \n\r\t' | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"

echo ""
echo "============================================================"
echo "  EPHEMERAL TEST SERVER - Digital Ocean"
echo "============================================================"
echo ""
echo "  Repository: $REPO_URL"
echo "  Branch:     $BRANCH"
echo "  Command:    $TEST_COMMAND"
echo "  Droplet:    $DROPLET_SIZE"
echo ""

# Cleanup function
cleanup() {
    local exit_code=$?
    echo ""

    if [ "$KEEP_SERVER" = "true" ]; then
        echo "KEEP_SERVER=true - Droplet will NOT be destroyed"
        echo ""
        if [ -f "$SERVER_INFO_FILE" ]; then
            echo "Server info:"
            cat "$SERVER_INFO_FILE"
            echo ""
            echo "Connect with: ./connect.sh"
            echo "Destroy with: ./destroy-server.sh"
        fi
    else
        echo "Cleaning up..."
        if [ -f "$SERVER_INFO_FILE" ]; then
            "$SCRIPT_DIR/destroy-server.sh" || echo "Warning: Failed to destroy droplet"
        fi
        # Clean up SSH key file
        rm -f "$SSH_KEY_FILE"
    fi

    exit $exit_code
}

trap cleanup EXIT

# Helper for remote execution (uses SSH key)
remote_exec() {
    local ip=$(jq -r '.ip' "$SERVER_INFO_FILE")
    ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR -i "$SSH_KEY_FILE" root@$ip "$@"
}

remote_exec_quiet() {
    local ip=$(jq -r '.ip' "$SERVER_INFO_FILE")
    ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR -o BatchMode=yes -i "$SSH_KEY_FILE" root@$ip "$@" 2>/dev/null
}

# ============================================================
# STEP 1: Create Droplet
# ============================================================
echo ""
echo "------------------------------------------------------------"
echo "STEP 1/5: Creating droplet..."
echo "------------------------------------------------------------"

"$SCRIPT_DIR/create-server.sh" "ephemeral-$(date +%s)" "$DROPLET_SIZE"

SERVER_IP=$(jq -r '.ip' "$SERVER_INFO_FILE")

# Wait for cloud-init to complete
echo "Waiting for cloud-init to complete..."
for i in {1..30}; do
    if remote_exec_quiet "test -f /tmp/cloud-init-done"; then
        echo "Cloud-init complete!"
        break
    fi
    echo "  Waiting for setup... ($i/30)"
    sleep 10
done

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
# STEP 3: Start Docker Compose
# ============================================================
echo ""
echo "------------------------------------------------------------"
echo "STEP 3/5: Starting Docker Compose..."
echo "------------------------------------------------------------"

COMPOSE_FILE=$(remote_exec_quiet "ls /app/docker-compose.yml /app/compose.yml 2>/dev/null | head -1" || echo "")

if [ -z "$COMPOSE_FILE" ]; then
    echo "No docker-compose.yml found, skipping..."
else
    echo "Using: $COMPOSE_FILE"
    remote_exec "cd /app && docker compose up -d"

    echo "Waiting for containers to start (30s)..."
    sleep 30

    echo ""
    echo "Container status:"
    remote_exec "cd /app && docker compose ps" || true
fi

# ============================================================
# STEP 4: Run Tests
# ============================================================
echo ""
echo "------------------------------------------------------------"
echo "STEP 4/5: Running tests..."
echo "------------------------------------------------------------"
echo "Command: $TEST_COMMAND"
echo ""

# Install dependencies if package.json exists
if remote_exec_quiet "test -f /app/package.json"; then
    echo "Installing dependencies..."
    remote_exec "cd /app && pnpm install --frozen-lockfile" || \
    remote_exec "cd /app && npm ci" || \
    remote_exec "cd /app && npm install"
    echo ""
fi

# Run tests
TEST_EXIT_CODE=0
remote_exec "cd /app && $TEST_COMMAND" || TEST_EXIT_CODE=$?

echo ""
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "Tests PASSED!"
else
    echo "Tests FAILED (exit code: $TEST_EXIT_CODE)"
fi

# ============================================================
# STEP 5: Collect Logs
# ============================================================
echo ""
echo "------------------------------------------------------------"
echo "STEP 5/5: Collecting logs..."
echo "------------------------------------------------------------"

if [ -n "$COMPOSE_FILE" ]; then
    echo "Docker logs (last 50 lines):"
    remote_exec "cd /app && docker compose logs --tail=50" 2>/dev/null || true
fi

# ============================================================
# Result Summary
# ============================================================
echo ""
echo "============================================================"
echo "  RESULT"
echo "============================================================"
echo ""

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "  All tests PASSED!"
else
    echo "  Tests FAILED with exit code: $TEST_EXIT_CODE"
fi

echo ""

exit $TEST_EXIT_CODE
