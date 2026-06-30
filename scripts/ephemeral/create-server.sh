#!/bin/bash

# Creates a Digital Ocean Droplet for ephemeral testing
# Usage: ./create-server.sh [server-name] [droplet-size]
#
# Environment variables:
#   DO_API_TOKEN          - Digital Ocean API token (required)
#   DO_SSH_PRIVATE_KEY_B64 - SSH private key base64 encoded (required)
#   SSH_KEY_ID            - Digital Ocean SSH key ID (optional, uses first available if not set)
#
# Example:
#   DO_API_TOKEN=xxx DO_SSH_PRIVATE_KEY_B64="..." ./create-server.sh my-test-server s-2vcpu-4gb

set -e

SERVER_NAME="${1:-ephemeral-test-$(date +%s)}"
DROPLET_SIZE="${2:-s-2vcpu-4gb}"
IMAGE="ubuntu-24-04-x64"
REGION="nyc1"
SERVER_INFO_FILE="/tmp/server-info.json"
SSH_KEY_FILE="/tmp/do_ephemeral_key"

# Validate required environment (accept both DO_API_TOKEN and DO_API_KEY)
DO_API_TOKEN="${DO_API_TOKEN:-$DO_API_KEY}"
if [ -z "$DO_API_TOKEN" ]; then
    echo "Error: DO_API_TOKEN or DO_API_KEY environment variable is required"
    echo "Get your token from: https://cloud.digitalocean.com/account/api/tokens"
    exit 1
fi

# Setup SSH key from environment variable (base64 encoded)
if [ -n "$DO_SSH_PRIVATE_KEY_B64" ]; then
    echo "$DO_SSH_PRIVATE_KEY_B64" | tr -d ' \n\r\t' | base64 -d > "$SSH_KEY_FILE"
    chmod 600 "$SSH_KEY_FILE"
    echo "SSH key loaded from DO_SSH_PRIVATE_KEY_B64"
else
    echo "Error: DO_SSH_PRIVATE_KEY_B64 environment variable is required"
    echo "Encode your key with: cat ~/.ssh/your_key | base64 -w 0"
    exit 1
fi

# Get SSH key ID if not provided
if [ -z "$SSH_KEY_ID" ]; then
    echo "Fetching SSH keys from Digital Ocean..."
    SSH_KEYS_RESPONSE=$(curl -s "https://api.digitalocean.com/v2/account/keys" \
        -H "Authorization: Bearer $DO_API_TOKEN")

    SSH_KEY_ID=$(echo "$SSH_KEYS_RESPONSE" | jq -r '.ssh_keys[0].id // empty')
    SSH_KEY_NAME=$(echo "$SSH_KEYS_RESPONSE" | jq -r '.ssh_keys[0].name // empty')

    if [ -z "$SSH_KEY_ID" ]; then
        echo "Error: No SSH keys found in your Digital Ocean account."
        echo "Please add an SSH key at: https://cloud.digitalocean.com/account/security"
        echo "Or set SSH_KEY_ID environment variable manually."
        exit 1
    fi

    echo "Using SSH key: $SSH_KEY_NAME (ID: $SSH_KEY_ID)"
fi

echo ""
echo "Creating droplet: $SERVER_NAME"
echo "  Size: $DROPLET_SIZE"
echo "  Image: $IMAGE"
echo "  Region: $REGION"
echo "  SSH Key: $SSH_KEY_ID"
echo ""

# Cloud-init script to setup Docker and dependencies
CLOUD_INIT=$(cat <<'CLOUDINIT'
#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-plugin
  - git
  - curl
  - jq

runcmd:
  - systemctl enable docker
  - systemctl start docker
  - curl -fsSL https://get.docker.com | sh
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs
  - npm install -g pnpm
  - echo "Setup complete" > /tmp/cloud-init-done
CLOUDINIT
)

# Create the droplet
echo "Provisioning droplet (this may take 1-2 minutes)..."

RESPONSE=$(curl -s -X POST "https://api.digitalocean.com/v2/droplets" \
    -H "Authorization: Bearer $DO_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
        \"name\": \"$SERVER_NAME\",
        \"size\": \"$DROPLET_SIZE\",
        \"image\": \"$IMAGE\",
        \"region\": \"$REGION\",
        \"ssh_keys\": [\"$SSH_KEY_ID\"],
        \"user_data\": $(echo "$CLOUD_INIT" | jq -Rs .)
    }")

# Check for errors
if echo "$RESPONSE" | jq -e '.id // .message' | grep -q "message"; then
    echo "Error creating droplet:"
    echo "$RESPONSE" | jq '.'
    exit 1
fi

DROPLET_ID=$(echo "$RESPONSE" | jq -r '.droplet.id')

if [ "$DROPLET_ID" = "null" ] || [ -z "$DROPLET_ID" ]; then
    echo "Error: Failed to get droplet ID"
    echo "$RESPONSE" | jq '.'
    exit 1
fi

echo "Droplet created with ID: $DROPLET_ID"
echo "Waiting for IP address..."

# Poll for droplet to be active and get IP
MAX_ATTEMPTS=60
ATTEMPT=0
SERVER_IP=""

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    STATUS_RESPONSE=$(curl -s "https://api.digitalocean.com/v2/droplets/$DROPLET_ID" \
        -H "Authorization: Bearer $DO_API_TOKEN")

    STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.droplet.status')
    SERVER_IP=$(echo "$STATUS_RESPONSE" | jq -r '.droplet.networks.v4[] | select(.type=="public") | .ip_address' | head -1)

    if [ "$STATUS" = "active" ] && [ -n "$SERVER_IP" ] && [ "$SERVER_IP" != "null" ]; then
        echo "Droplet is active!"
        break
    fi

    ATTEMPT=$((ATTEMPT + 1))
    echo "  Status: $STATUS - Waiting... ($ATTEMPT/$MAX_ATTEMPTS)"
    sleep 5
done

if [ -z "$SERVER_IP" ] || [ "$SERVER_IP" = "null" ]; then
    echo "Error: Could not get droplet IP address"
    exit 1
fi

echo ""
echo "Droplet ready!"
echo "  ID: $DROPLET_ID"
echo "  IP: $SERVER_IP"
echo ""

# Save server info
cat > "$SERVER_INFO_FILE" <<EOF
{
    "id": "$DROPLET_ID",
    "name": "$SERVER_NAME",
    "ip": "$SERVER_IP",
    "ssh_key_id": "$SSH_KEY_ID",
    "created_at": "$(date -Iseconds)",
    "provider": "digitalocean"
}
EOF

echo "Server info saved to: $SERVER_INFO_FILE"

# Wait for SSH to be ready
echo ""
echo "Waiting for SSH to be ready..."

MAX_ATTEMPTS=60
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if ssh -i "$SSH_KEY_FILE" -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes root@$SERVER_IP "echo ready" 2>/dev/null; then
        echo "SSH is ready!"
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    echo "  Waiting... ($ATTEMPT/$MAX_ATTEMPTS)"
    sleep 5
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    echo "Warning: Server may not be fully ready. Try connecting manually."
fi

# Wait for cloud-init to complete
echo "Waiting for cloud-init to complete..."

for i in {1..30}; do
    if ssh -i "$SSH_KEY_FILE" -o StrictHostKeyChecking=no -o BatchMode=yes root@$SERVER_IP "test -f /tmp/cloud-init-done" 2>/dev/null; then
        echo "Cloud-init complete!"
        break
    fi
    echo "  Waiting for setup... ($i/30)"
    sleep 10
done

echo ""
echo "Server is ready!"
echo ""
echo "Connect with:"
echo "  ssh -i $SSH_KEY_FILE root@$SERVER_IP"
echo ""
echo "Or use: ./connect.sh"
