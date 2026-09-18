# AWS single-controller deployment

This opt-in adapter consumes an **already published private ECR digest**. It does
not build source, copy GHCR tags, provision implicitly, delete infrastructure, or
send application/AI prompts. The consumer owns its image, CloudFormation
template, secret population, domain/TLS and database migration policy.

## Local CLI

Requirements: Node 22+, AWS CLI v2, an explicitly authorized AWS profile/default
credential chain. No AWS keys are accepted in CLI arguments.

```bash
node scripts/deploy/aws.mjs plan \
  --profile my-deploy-profile --region us-east-1 \
  --expected-account 123456789012 --stack my-app \
  --template deploy/controller.json --parameters deploy/parameters.json
```

`plan` only checks identity, ownership (if the stack exists), template validity and
parameter shape. It does not produce an infrastructure diff or create a change
set. Review the app template before explicit `provision`, which may create
billable resources. `provision` submits a create/update and reports `submitted`,
**not completed**; poll `status` until CloudFormation is stable. New stacks have
termination protection. Existing stacks require `ManagedBy=12-apps-ci`; an
unrelated stack, an access error or an in-progress update is never adopted.

```bash
node scripts/deploy/aws.mjs deploy \
  --profile my-deploy-profile --region us-east-1 \
  --expected-account 123456789012 --stack my-app \
  --image 123456789012.dkr.ecr.us-east-1.amazonaws.com/my-app@sha256:REPLACE_WITH_64_HEX_DIGEST \
  --container application --mount /srv/application/data \
  --destination /var/lib/application \
  --ready-file /var/lib/12-apps-controller-ready --port 8787 --health /readyz
```

Use `rollback` with the same host settings (no image) to restore the retained
previous container, including its original environment and Docker configuration.
Use `status` to read stack metadata; add `--command-id <UUID>` to inspect a rollout
already submitted. Status never claims application health from CloudFormation's
status alone. All commands require account, region and stack; profile is optional.

## App/host contract

The stack must output these non-secret references:

| Output | Required meaning |
| --- | --- |
| `ControllerInstanceId` | Running EC2 instance resource owned by the stack, online in SSM |
| `DataVolumeId` | Encrypted EBS volume resource owned by the stack, attached to that instance |
| `ApplicationRepositoryUri` | Private ECR repository in the same expected account and region |
| `SecretArn` | Same-account/region Secrets Manager secret containing JSON environment strings |
| `ArtifactBucket` | App-owned artifact bucket name; the engine does not upload source to it |
| `PublicUrl` | Stable HTTPS application URL, without credentials/query/fragment |

Host bootstrap must install Docker, AWS CLI, SSM Agent, Python 3, `findmnt` and
`lsblk`; mount the correct EBS data volume without destroying existing data;
create the data directory owned by UID 1000; then write the root-owned ready
marker. The engine requires that marker and checks the mounted device's NVMe
serial against the exact stack EBS ID. This MVP targets Nitro instances; it fails
closed on hosts that cannot prove the EBS serial. It never formats, mounts,
creates or changes ownership of the data directory during deployment.

The controller image runs as `1000:1000`, with host networking, all Linux
capabilities dropped, no-new-privileges, a private writable `/tmp` tmpfs and a bind
mount at the configured data destination. Set a writable persistent HOME in the
app image/environment. The image must not rely on root or docker-socket access.

Application protocol on **loopback**, not the proxy's generic health endpoint:

- `GET /readyz` (or `--health`): HTTP 200 JSON `{"ok":true}` only after durable
  dependencies such as the database are usable.
- `POST /internal/deploy/drain`: HTTP 200 JSON `{"ok":true}` only after blocking
  new admission and confirming no busy work, in-flight writes or login flows.
  HTTP 409 must leave the existing controller running.
- `POST /internal/deploy/resume`: safely clears a drain if deployment aborts.
  Protect both administrative routes against remote/browser access in the app.

Secrets must be a nonempty JSON object of uppercase environment keys and string
values. Newline, carriage-return and NUL values are rejected; encode multiline
keys in the app's documented format. The host fetches the secret directly using
its instance role, writes a mode-0600 env file in a mode-0700 `/run` temporary
directory, passes the file to Docker and removes the directory afterward. The
deployment payload and SSM logs contain references, never secret values. Docker
necessarily retains environment values in root-readable container metadata,
including the stopped previous container used for exact rollback. Restrict host
root/Docker access and encrypt host disks. This is not a secret boundary against
a host administrator.

## Rollout, rollback and interruptions

The host uses a nonblocking exclusive deployment lock. It verifies ownership,
pulls the exact digest and validates the secret **before** draining the old
container. It then stops the old controller (120-second graceful timeout),
retains it stopped, starts the new controller and verifies application readiness.
There is intentionally downtime: two controllers must never concurrently write
the same durable data. Choose a maintenance window; this is not rolling/HA deploy.

Readiness/start/stop/rename failures attempt to restore the original container by
its Docker ID and verify readiness. The deployment still exits failed after a
successful recovery. A successful release retains one previous container;
successful rollback retains the displaced release for a later roll-forward.
Unmanaged, unexpectedly running or interrupted-transition containers are not
silently deleted. Inspect them before retrying. No image/data/volume pruning is
performed. The previous container is removed only when a newer deployment has a
current controller to retain in its place.

SSM returns a command handle immediately. Polling observes **that same command**;
an observation timeout or client interruption does not imply the command stopped.
Do not resubmit, reboot or cancel blindly. Inspect `status --command-id` and host
state first. A host crash, out-of-disk condition, unrecoverable Docker failure or
SSM execution timeout can require manual recovery; automated rollback is not a
backup. Use app/data/key backups and backward-compatible migrations. Rollback of
an image cannot undo an incompatible database migration.

## GitHub Actions / OIDC

The repository `12-apps/ci` is public, so the action/reusable workflow can be
consumed across organizations. Before a release moves the supported major tag,
pin **both** the reusable workflow and `engine_ref` to the same tested commit
that contains this feature. Do not use the old `v2` implementation to test new
files. `engine_ref` requires a full 40-character SHA and selects the engine
checkout explicitly; it never runs an action relative to the consumer's tree.

```yaml
permissions:
  contents: read
jobs:
  # publish is a consumer-owned job exporting an immutable ECR digest.
  deploy:
    needs: publish
    permissions:
      contents: read
      id-token: write
      actions: write # only needed for optional post-CD workflow dispatch
    uses: 12-apps/ci/.github/workflows/deploy-aws.yml@REPLACE_WITH_TESTED_COMMIT_SHA
    with:
      engine_ref: REPLACE_WITH_SAME_TESTED_COMMIT_SHA
      action: deploy
      region: us-east-1
      expected_account: '123456789012'
      role_arn: arn:aws:iam::123456789012:role/app-deploy
      stack: my-app
      image: ${{ needs.publish.outputs.ecr_image_digest }}
```

The consumer supplies its publish job/dependency and immutable output.
Alternatively call `.github/actions/aws-deploy` at the same pinned SHA after
configuring AWS credentials; the composite requires Node/AWS CLI already
installed. The reusable workflow installs Node 22, uses the runner AWS CLI and
authenticates with OIDC. No long-lived GitHub/AWS token or secret inheritance is
required. Set repository variable **`ENABLE_DEPLOY_AWS=true`** explicitly; absent
or false means no deployment. Configure environment protection rules and OIDC
trust for the exact consumer repository and deployment environment, not an org
wildcard. Concurrency is serialized by account/region/stack and never cancelled
by newer workflow runs.

The deployment role needs STS identity, stack/resource/instance/volume reads,
ECR manifest reads, SSM online/command-status reads and SendCommand limited to
`AWS-RunShellScript` and the stack's controller instance. It does **not** need
Secrets Manager plaintext access: only the host instance role reads that one
secret and pulls that repository. Use a separate reviewed provisioning role for
CloudFormation create/update and the app template's IAM/resource permissions.
Keep the host role limited to its ECR repository, one secret and SSM. Account
checks and ownership tags supplement IAM; they are not authorization by themselves.

After release, `cd.yml` has a thin `target: aws` lane (deliberately not `all`) with
inputs `aws_engine_ref`, `aws_image`, `aws_template`, `aws_parameters`. Set repo
variables `AWS_REGION`, `AWS_EXPECTED_ACCOUNT`, `AWS_DEPLOY_ROLE_ARN`,
`AWS_DEPLOY_STACK`; optional `AWS_CONTAINER_NAME`, `AWS_DATA_MOUNT`,
`AWS_DATA_DESTINATION`, `AWS_READY_FILE`, `AWS_APP_PORT`, `AWS_HEALTH_PATH`,
`AWS_DEPLOY_ENVIRONMENT`, `AWS_POST_CD_WORKFLOW`. AWS skips the GHCR discovery/build
lanes and never infers an ECR artifact from a source SHA. The direct pinned
workflow is recommended for consumers with a separate artifact publication
pipeline. Optional post-CD dispatch runs only after a verified deploy, not after
plan/provision/status/rollback or a failed recovery.

## Test boundary

`node --test scripts/deploy/__tests__/aws.test.mjs` and
`python3 -B scripts/deploy/__tests__/aws_rollout_test.py` exercise guards, redaction,
secret delivery and lifecycle failures with fake cloud/host processes. They do
not provision AWS, authorize OIDC, prove a real AMI/bootstrap, or claim a live
deployment passed. Consumers must validate those integration boundaries on their
authorized stack and record the command handle, digest and readiness result.
