# Ephemeral Test Server (Digital Ocean)

Scripts for running tests on ephemeral Digital Ocean droplets.

## Prerequisites

1. **Digital Ocean Account** - Get API token from [DO Console](https://cloud.digitalocean.com/account/api/tokens)
2. **SSH Key** - Add your SSH public key to Digital Ocean at [Security Settings](https://cloud.digitalocean.com/account/security)
3. **Required tools**: `curl`, `jq`

## Quick Start

```bash
# Set environment variables (single line, .env compatible)
export DO_API_TOKEN="your-digitalocean-api-token"
export DO_SSH_PRIVATE_KEY_B64="base64-encoded-private-key"

# Run full test workflow
./run-ephemeral-test.sh https://github.com/user/repo.git main "pnpm test"
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DO_API_TOKEN` | Yes | Digital Ocean API token |
| `DO_SSH_PRIVATE_KEY_B64` | Yes | SSH private key base64 encoded (single line) |
| `GITHUB_TOKEN` | No | For private repositories |
| `DROPLET_SIZE` | No | Droplet size (default: `s-2vcpu-4gb`) |
| `SSH_KEY_ID` | No | Digital Ocean SSH key ID (auto-detected if not set) |
| `KEEP_SERVER` | No | Set to `true` to keep droplet after tests |

## How to Encode Your SSH Key

```bash
# Encode your private key to base64 (single line)
cat ~/.ssh/your_key | base64 -w 0

# Copy the output and set as env var
export DO_SSH_PRIVATE_KEY_B64="paste-here"
```

## .env Example

```env
DO_API_TOKEN=dop_v1_xxxxxxxxxxxxxxxx
DO_SSH_PRIVATE_KEY_B64=LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t...
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

## Scripts

| Script | Description |
|--------|-------------|
| `run-ephemeral-test.sh` | Full workflow: create, clone, test, destroy |
| `create-server.sh` | Create a new Digital Ocean droplet |
| `destroy-server.sh` | Destroy the current droplet |
| `connect.sh` | SSH into the droplet |
| `deploy-cloud-init.sh` | Deploy app via cloud-init (no SSH required) |
| `deploy.sh` | Deploy app via SSH (creates droplet, SSH-based provisioning) |

## Deployment Scripts

### deploy-cloud-init.sh (Recommended)

Creates a new droplet and deploys the app automatically using cloud-init. No SSH access required.

```bash
# Basic usage
./deploy-cloud-init.sh

# With options
./deploy-cloud-init.sh -n my-app -b main

# With Google OAuth
export GOOGLE_CLIENT_ID="your-client-id"
export GOOGLE_CLIENT_SECRET="your-client-secret"
./deploy-cloud-init.sh -n app-prod -b main

# List active droplets
./deploy-cloud-init.sh -l

# Destroy a droplet
./deploy-cloud-init.sh -d 123456789
```

**Options:**
- `-n, --name NAME` - Droplet name (default: app-TIMESTAMP)
- `-s, --size SIZE` - Droplet size (default: s-2vcpu-4gb)
- `-b, --branch BRANCH` - Git branch to deploy (default: main)
- `-d, --destroy ID` - Destroy droplet by ID
- `-l, --list` - List running droplets

**Endpoints (after deployment):**
- `http://<IP>/` - Web app
- `http://<IP>/docs` - Documentation
- `http://<IP>/api` - API endpoints
- `http://<IP>/health` - Health check

### deploy.sh (SSH-based)

Creates a new DigitalOcean droplet and deploys the app to it via SSH. Similar to `deploy-cloud-init.sh`, but uses SSH-based provisioning instead of cloud-init.

**Options:**

- `-b, --branch BRANCH` - Git branch to deploy (defaults to current branch)
- `-k, --keep` - Keep the droplet running after deployment (do not destroy)
- `--db-only` - Only start or migrate databases, do not deploy application code
- `-n, --name NAME` - Droplet name to create or target
- `-s, --size SIZE` - Droplet size slug (e.g. `s-1vcpu-1gb`, `s-2vcpu-4gb`)
- `-d, --destroy ID` - Destroy an existing droplet by ID and exit
- `-h, --help` - Show detailed usage information

**Examples:**

```bash
# Deploy current branch with default name/size
./deploy.sh

# Deploy specific branch, keep server running
./deploy.sh -b main -k

# Only start databases (no app deployment)
./deploy.sh --db-only

# Deploy to a named droplet with a larger size
./deploy.sh -n my-app-droplet -s s-4vcpu-8gb

# Destroy an existing droplet by ID
./deploy.sh -d 123456789
```

**Requires:** `DO_API_TOKEN` and `DO_SSH_PRIVATE_KEY_B64` environment variables

## Droplet Sizes

| Size | vCPU | RAM | Price/hr |
|------|------|-----|----------|
| `s-1vcpu-1gb` | 1 | 1GB | $0.007 |
| `s-2vcpu-4gb` | 2 | 4GB | $0.036 |
| `s-4vcpu-8gb` | 4 | 8GB | $0.071 |

## Examples

### Keep droplet for debugging:
```bash
KEEP_SERVER=true ./run-ephemeral-test.sh https://github.com/org/repo.git main "pnpm test"
```

### Larger droplet:
```bash
DROPLET_SIZE=s-4vcpu-8gb ./run-ephemeral-test.sh https://github.com/org/repo.git main "pnpm test"
```
