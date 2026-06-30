#!/bin/bash

# Destroys a Digital Ocean ephemeral test droplet
# Usage: ./destroy-server.sh [droplet-id]
#
# If no droplet-id is provided, reads from /tmp/server-info.json
#
# Environment variables:
#   DO_API_TOKEN - Digital Ocean API token (required)

set -e

SERVER_INFO_FILE="/tmp/server-info.json"

# Get droplet ID from argument or file
if [ -n "$1" ]; then
    DROPLET_ID="$1"
elif [ -f "$SERVER_INFO_FILE" ]; then
    DROPLET_ID=$(jq -r '.id' "$SERVER_INFO_FILE")
    SERVER_NAME=$(jq -r '.name' "$SERVER_INFO_FILE")
else
    echo "Error: No droplet ID provided and no server-info.json found"
    echo "Usage: ./destroy-server.sh [droplet-id]"
    exit 1
fi

# Validate required environment (accept both DO_API_TOKEN and DO_API_KEY)
DO_API_TOKEN="${DO_API_TOKEN:-$DO_API_KEY}"
if [ -z "$DO_API_TOKEN" ]; then
    echo "Error: DO_API_TOKEN or DO_API_KEY environment variable is required"
    exit 1
fi

echo "Destroying droplet: ${SERVER_NAME:-$DROPLET_ID} (ID: $DROPLET_ID)"

# Delete the droplet
HTTP_CODE=$(curl -s -o /tmp/do-delete-response.json -w "%{http_code}" \
    -X DELETE "https://api.digitalocean.com/v2/droplets/$DROPLET_ID" \
    -H "Authorization: Bearer $DO_API_TOKEN")

if [ "$HTTP_CODE" = "204" ]; then
    echo "Droplet destroyed successfully!"
elif [ "$HTTP_CODE" = "404" ]; then
    echo "Droplet already destroyed or not found"
else
    echo "Error destroying droplet (HTTP $HTTP_CODE):"
    cat /tmp/do-delete-response.json 2>/dev/null || echo "No response body"
    rm -f /tmp/do-delete-response.json
    exit 1
fi

rm -f /tmp/do-delete-response.json

# Clean up local files
if [ -f "$SERVER_INFO_FILE" ]; then
    rm "$SERVER_INFO_FILE"
    echo "Cleaned up $SERVER_INFO_FILE"
fi

echo "Done!"
