#!/bin/bash

# Connect to the ephemeral test droplet via SSH
# Usage: ./connect.sh [command]
#
# Environment variables:
#   DO_SSH_PRIVATE_KEY_B64 - SSH private key base64 encoded (required)
#
# Examples:
#   ./connect.sh              # Interactive SSH session
#   ./connect.sh "ls /app"    # Run a command and exit

SERVER_INFO_FILE="/tmp/server-info.json"
SSH_KEY_FILE="/tmp/do_ephemeral_key"

if [ ! -f "$SERVER_INFO_FILE" ]; then
    echo "Error: No server found. Run create-server.sh first."
    echo "Looking for: $SERVER_INFO_FILE"
    exit 1
fi

# Setup SSH key from environment variable (base64 encoded)
if [ -n "$DO_SSH_PRIVATE_KEY_B64" ]; then
    echo "$DO_SSH_PRIVATE_KEY_B64" | tr -d ' \n\r\t' | base64 -d > "$SSH_KEY_FILE"
    chmod 600 "$SSH_KEY_FILE"
elif [ ! -f "$SSH_KEY_FILE" ]; then
    echo "Error: DO_SSH_PRIVATE_KEY_B64 environment variable is required"
    exit 1
fi

SERVER_IP=$(jq -r '.ip' "$SERVER_INFO_FILE")
SERVER_NAME=$(jq -r '.name' "$SERVER_INFO_FILE")

echo "Connecting to: $SERVER_NAME ($SERVER_IP)"
echo ""

if [ -n "$1" ]; then
    # Run command
    ssh -i "$SSH_KEY_FILE" -o StrictHostKeyChecking=no root@$SERVER_IP "$@"
else
    # Interactive session
    ssh -i "$SSH_KEY_FILE" -o StrictHostKeyChecking=no root@$SERVER_IP
fi
