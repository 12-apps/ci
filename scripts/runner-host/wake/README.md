# The runner fleet: as many hosts as the queue needs, none when it is empty

EC2 bills by the second, so ten hosts for ten minutes cost what one host
costs for a hundred. Nothing needs to wait for a slot. The fleet grows to the
queue at once, and every host terminates itself when it goes idle.

```
GitHub ──workflow_job──▶ Lambda (scale.mjs) ──RunInstances(template)──▶ N spot hosts
                              │  queued jobs − idle runners − booting slots
                              └─ reserved concurrency 1: one evaluation at a time
host: boots from the AMI → token from SSM → 3 slots → idle 5 min → terminates
```

- **Sizing.** Every `queued` or `completed` job for the fleet's label
  re-evaluates the fleet:
  - `launch = ceil((queued − idle runners − slots on hosts still booting) / slots per host)`
  - The result is capped at `MAX_HOSTS`.
  - Hosts still booting count as capacity, so a hundred deliveries in a burst launch what the queue needs, not a hundred hosts.
- **Spot capacity.** When one instance type has no spot capacity, the next in `INSTANCE_TYPES` is tried.
- **Boot.** A host launched from the AMI has Docker, the job image and the kit already on disk. It reads the PAT from SSM (`fetch-credential.sh`), so the image carries no secret, and registers its runners in about a minute.
- **Scale-in.** `idle-stop.sh` releases each waiting runner through the API. GitHub refuses that (422) for a runner it has just handed a job, and one refusal cancels the stop. Once released, the host powers off, which the launch template turns into a terminate.
- **Who can drive it.**
  - Every delivery must carry GitHub's `X-Hub-Signature-256` for the shared secret and name the configured repository.
  - The role can run instances only from the fleet's launch template, pass only the host role, and read only the token parameter.
- **What it costs.** The hosts, for the seconds they run. The Lambda stays inside the free tier.

## Install

1. **Token.** It lives in SSM (`/ci-runner/github-app-key`) and needs **Administration: Read and write** (register runners) plus **Actions: Read** (count the queue).
2. **Golden host.** On any host with the kit, as root:
   `wake/prepare-golden.sh 3`. It installs fleet mode, removes the token from disk and clears the host identity.
3. **Deploy.** With a profile allowed to manage IAM, Lambda, AMIs and launch templates:

   ```bash
   AWS_PROFILE=ci-runner-admin GOLDEN_INSTANCE_ID=i-0123456789abcdef0 ./deploy.sh
   ```

   This images the golden host (with a reboot), creates the launch template, the role and the function with its URL, and checks that the URL answers a signed ping.
4. **Webhook.** On the repository, under **Settings → Webhooks**, add the printed URL:
   - Content type `application/json`.
   - The secret from `~/.ci-runner-wake-secret`.
   - Only the **Workflow jobs** event.

After that, the golden host can be terminated. Re-run `deploy.sh` with a new golden host to ship a new image (for example after a runner release).

## When a job waits

- **Deliveries.** Webhooks → Recent Deliveries shows each evaluation, for example `{"queued":7,"idle":0,"hosts":2,"booting":0,"launched":1}`.
- **Function logs.** `aws logs tail /aws/lambda/ci-runner-scale --follow` shows each launch and any capacity failure.
- **Cap.** A deficit at `MAX_HOSTS` is logged as `at the N-host cap`. Raise `MAX_HOSTS` and re-deploy.
