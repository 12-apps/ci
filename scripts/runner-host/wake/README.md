# The runner fleet: as many hosts as the queue needs, none when it is empty

EC2 bills by the second, so ten hosts for ten minutes cost what one host
costs for a hundred. Nothing needs to wait for a slot. The fleet grows to the
queue at once, and every host terminates itself when it goes idle.

```
GitHub ──workflow_job──▶ Lambda (scale.mjs) ──StartInstances──▶ stopped pool hosts (warm disks)
                              │                  └─RunInstances(template)──▶ the rest, fresh spot hosts
                              │  queued jobs − idle runners − booting slots
                              └─ launches carry an idempotent ClientToken
fresh host: boots from the AMI → token from SSM → 2 slots → idle 5 min → terminates
pool host:  starts → token from SSM → 2 slots → idle 5 min → stops (only its volume is billed)
```

- **Sizing.** Every `queued` or `completed` job for the fleet's label
  re-evaluates the fleet:
  - `launch = ceil((queued − idle runners − slots on hosts still booting) / slots per host)`
  - The result is capped at `MAX_HOSTS`.
  - Hosts still booting count as capacity, so a hundred deliveries in a burst launch what the queue needs, not a hundred hosts.
- **Slot size.** Two slots per 8-vCPU, 32 GB host. Each slot owns 4 cores (pinned, so that is also what `nproc` reports) and about 14 GB, the shape of the 4-vCPU, 16 GB GitHub runner that future-pay's lanes are tuned for. With three slots per host, each seeing all eight cores, vitest's transforms ran 3× slower, and a test and a Playwright web server timed out (future-pay #1978).
- **Warm pool.** A host launched from the AMI reads its disk from the snapshot on first touch: about 90 s to boot and another minute before its runner takes a job (measured 2 min 45 s from queue to start). `POOL_SIZE` hosts (default 2) are kept **stopped** instead, with disks that have booted before, and the scaler starts those before it launches anything. They are persistent spot requests whose poweroff stops rather than terminates, so while stopped they cost only their volumes (about US$10 a month each for the 120 GB root). A pool host that cannot start for lack of spot capacity is replaced by a fresh launch in the same evaluation.
- **Spot capacity.** Hosts are launched by one instant EC2 Fleet request that spans every type in `INSTANCE_TYPES` (five current-generation 8-vCPU, 32 GB x86 types) and every default subnet (one per zone). The `price-capacity-optimized` strategy puts them in the spot pools least likely to be reclaimed. On the first real burst, every host was a c7a in us-east-1d. That pool was out of capacity, and AWS reclaimed a host from it mid-job.
- **Reclaimed hosts.** A job on a host that AWS reclaims fails with it. When a run completes as a failure, the function looks for failed jobs whose runner's host was ended with `Server.SpotInstanceTermination`, and re-runs the run's failed jobs. This happens up to the third attempt. A job that failed on its own merits never triggers a re-run.
- **Boot.** A host launched from the AMI has Docker, the job image and the kit already on disk. It reads the PAT from SSM (`fetch-credential.sh`), so the image carries no secret, and registers its runners in about a minute.
- **Scale-in.** `idle-stop.sh` releases each waiting runner through the API. GitHub refuses that (422) for a runner it has just handed a job, and one refusal cancels the stop. Once released, the host powers off, which the launch template turns into a terminate.
- **Who can drive it.**
  - The role can start only instances tagged `ci-runner-pool=<label>`.
  - Every delivery must carry GitHub's `X-Hub-Signature-256` for the shared secret and name the configured repository.
  - The role can run instances only from the fleet's launch template, pass only the host role, and read only the token parameter.
- **What it costs.** The hosts, for the seconds they run. The Lambda stays inside the free tier.

## Install

1. **Token.** It lives in SSM (`/ci-runner/github-app-key`) and needs:
   - **Administration: Read and write** to register runners.
   - **Actions: Read and write** to count the queue and re-run jobs lost to a reclaimed host.
   - **Webhooks: Read and write** to create the webhook.
2. **Golden host.** On any host with the kit, as root:
   `wake/prepare-golden.sh 2`. It installs fleet mode, removes the token from disk and clears the host identity.
3. **Deploy.** With a profile allowed to manage IAM, Lambda, AMIs and launch templates:

   ```bash
   AWS_PROFILE=ci-runner-admin GOLDEN_INSTANCE_ID=i-0123456789abcdef0 ./deploy.sh
   ```

   This images the golden host (with a reboot), creates the launch template, the role and the function with its URL, and checks that the URL answers a signed ping.
4. **Webhook.** On the repository, under **Settings → Webhooks**, add the printed URL:
   - Content type `application/json`.
   - The secret from `~/.ci-runner-wake-secret`.
   - The **Workflow jobs** and **Workflow runs** events.

After that, the golden host can be terminated. Re-run `deploy.sh` with a new golden host to ship a new image (for example after a runner release). The run also tops the warm pool up to `POOL_SIZE` and retires stopped pool hosts on an older image; one that is running is left to finish and retired by the next run.

To remove a pool host by hand, cancel its spot request first (`aws ec2 cancel-spot-instance-requests`), then terminate it. A persistent request whose instance is terminated launches a replacement.

## When a job waits

- **Deliveries.** Webhooks → Recent Deliveries shows each evaluation, for example `{"queued":7,"idle":0,"hosts":2,"booting":0,"launched":1}`.
- **Function logs.** `aws logs tail /aws/lambda/ci-runner-scale --follow` shows each launch and any capacity failure.
- **Cap.** A deficit at `MAX_HOSTS` (default 30) is logged as `at the N-host cap`. Raise `MAX_HOSTS` and re-deploy.
- **Quota.** Launches past the account's spot vCPU quota fail with `MaxSpotInstanceCountExceeded` in the function log. A new account starts at 32 vCPUs (four hosts). 30 hosts need 240 vCPUs of the "All Standard Spot Instance Requests" quota (`L-34B43A08`).
- **Sizing.** future-pay's CI fans one pull request out to 20–30 parallel jobs, so a few open pull requests need 60–90 slots at once. Size the cap to the peak, not the average. At two slots per host, 30 hosts are 60 slots. More needs both a higher `MAX_HOSTS` and a larger spot quota (8 vCPUs per host).
