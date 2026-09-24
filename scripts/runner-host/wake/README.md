# wake — start the CI host when a job is queued

The runner host powers itself off after `CI_RUNNER_IDLE_MINUTES` with no job
(`../idle-stop.sh`), which is what keeps a CI machine billed by the hour
cheap. Something has to start it again when work arrives, and that is this:

```
GitHub ──workflow_job webhook──▶ Lambda function URL ──ec2:StartInstances──▶ host
```

- **What it starts.** Only a `queued` job whose labels include the host's
  label (`RUNNER_LABEL`, the value of the repository variable `CI_RUNNER`)
  starts anything. Every other delivery is answered and ignored.
- **Who can call it.** The URL is public. Every delivery must carry GitHub's
  `X-Hub-Signature-256` for the shared secret, and the payload must name the
  configured repository, or it is refused before any AWS call. The role can
  start **this one instance** and describe instances. Nothing else.
- **A host that is still powering off.** A job queued in that window waits in
  the function until the host reaches `stopped` (up to 75 s), then starts it.
- **What it costs.** One invocation per job, well inside Lambda's free tier.
- **What the first job waits.** A stopped host boots and registers its runners
  in about one to two minutes. Jobs queued while it is up start at once.

## Install

The host must be stoppable: an on-demand instance, or a *persistent* spot
request with `InstanceInterruptionBehavior=stop` (a one-time spot instance
can only be terminated). Then, with a profile allowed to manage IAM and
Lambda:

```bash
AWS_PROFILE=ci-runner-admin INSTANCE_ID=i-0123456789abcdef0 ./deploy.sh
```

It prints the URL and where to put it: the repository's **Settings →
Webhooks → Add webhook**, content type `application/json`, the secret from
`~/.ci-runner-wake-secret`, and only the **Workflow jobs** event.

Last, turn the idle stop on, on the host:

```bash
sudo CI_RUNNER_IDLE_MINUTES=20 /opt/src/ci/scripts/runner-host/install.sh
```

## When it does not wake

- **Deliveries.** Settings → Webhooks → Recent Deliveries shows every call
  and the function's answer, for example `host starting`, `job is not for
  this host` or `bad signature`.
- **Function logs.** `aws logs tail /aws/lambda/ci-runner-wake --follow`.
- **No capacity.** A spot host can fail to start when the zone has no
  capacity. The answer is `503`, and the job stays queued until the next job
  or a manual `aws ec2 start-instances`.
