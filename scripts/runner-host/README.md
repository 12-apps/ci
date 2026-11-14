# Runner host: single-use self-hosted runners on one machine

Turns one Ubuntu 24.04 machine into a pool of GitHub Actions runners that behave
like GitHub's `ubuntu-latest`. Each job gets a fresh container that is thrown
away afterwards. The machine costs a fixed monthly price, and GitHub does not
bill per minute for self-hosted runners.

## Why this exists

A private repo pays for every minute on GitHub-hosted runners. In September
2026 future-pay's CI used about **5,000 Linux minutes a day** (~$30/day at
$0.006/min), about 95% of it in jobs these reusable workflows define. The
selection logic is already aggressive (symbol-level plans, `--affected`, drafts
skip the heavy lanes), so the remaining lever is **where** the minutes run,
not how many there are.

## How it works

```
systemd ci-runner@N ──► supervisor.sh N ──(loop)──► POST generate-jitconfig
                                                   docker run --rm --privileged ci-runner
                                                     ├─ its own dockerd (services:, container:, docker build)
                                                     └─ run.sh --jitconfig …  → exactly ONE job, then exit
```

- **One job per container.** A JIT runner takes one job and is deregistered by
  GitHub. The container is `--rm` and keeps its Docker storage in an anonymous
  volume, so nothing a job writes reaches the next job. That is the guarantee
  a hosted runner gives, and a long-lived self-hosted runner does not.
- **One network per job.** Jobs start servers on fixed ports (3000, 5173…).
  Each container has its own network namespace and its own `localhost`, so
  eight concurrent E2E jobs cannot collide.
- **The token stays on the host.** The PAT that mints JIT configs lives in
  `/etc/ci-runner/env` (root, 0600). A job only ever sees its own single-use
  JIT config, which is passed by environment variable name, never on argv.
- **Memory is capped per slot** (90% of RAM split evenly), so a runaway job is
  OOM-killed alone instead of taking every other slot down with it.
- **The image rebuilds weekly** (`ci-runner-image.timer`) against the latest
  `actions/runner` release, because GitHub stops sending jobs to runner versions
  that fall too far behind.

## Sizing

Measured on future-pay (2026-09-21/22): CI is busy about 10 hours a day, with
about 8 jobs running at once on average and bursts to 45. Each slot runs one
job at a time and wants about **2 vCPU and 6–8 GB RAM** (the type check and the
Vite builds set the RAM floor).

| machine | slots | at the peaks |
|---|---|---|
| 16 threads / 64 GB | 8 | covers the average; bursts queue for a few minutes |
| 8 threads / 32 GB | 4 | works; PR feedback is noticeably slower in bursts |

A job's total time on your machine is not the same as its billed hosted time.
Setup (install, cache restore) runs at the machine's speed, and a modern
desktop-class CPU is faster per core than a hosted 2-vCPU runner.

### What each job actually uses

Those numbers are a guess per slot. Every job now reports what it used: the
image's runner hooks (`job-usage.sh`) print one line at the end of the job's log,

```
ci-runner-usage {"wallMs":412000,"avgCores":1.4,"peakCores":3.9,"cpuWaitPct":12.3,"peakWorkingSetMiB":5120,"ioWaitPct":1.1,"peakIops":2100,"netTxMiB":340,…}
```

read from the job container's own cgroup, so it covers the service containers
the job starts too. Memory is the peak WORKING SET, page cache the kernel would
drop left out. `*WaitPct` is the share of the job's time something waited for
CPU, memory or disk. `netTxMiB` is what the job sent out, which a cloud bills
as egress. `peakIops` counts bios before the kernel merges them, so it runs far
above what the volume serves; compare `peakDiskMiBps` and `ioWaitPct` with a
volume's limits instead.

`usage-report.mjs` gathers those lines from every job's log (GitHub keeps them
90 days) into one row per kind of job, with the memory tier it fits (largest
working set + 25%), and splits every host's paid time into running a job,
startup, between jobs, the tail before it stops, and slots that ran nothing:

```bash
GITHUB_TOKEN=… node scripts/runner-host/usage-report.mjs --repo owner/name --since 2026-09-29 \
  [--until …] [--label future-pay-ci] [--slots 2] [--idle-minutes 2]
```

### The week on one page

`daily-report.mjs` is what the daily CI-monitor routine runs: the last N UTC
days of merges, PR pushes, CI cost (account − Tax − Route 53 − a baseline,
with the AWS category breakdown and the tagged fleet cost beside it), cost per
merge and per push, per-job p50 / IO wait / disk MiB/s and the paid slot-time
split over a sampled window of hours (one log read per job, so a whole week of
whole days would spend a token's hourly allowance), every full suite
dispatched, the disk each region's launch template hands a host with the
default-version changes CloudTrail saw, and the readings that look wrong:

```bash
GITHUB_TOKEN=… node scripts/runner-host/daily-report.mjs --repo owner/name \
  [--days 7] [--until YYYY-MM-DD] [--window 14-17] [--regions …] [--template …] \
  [--budget 100] [--baseline 0.69] [--out dir] [--pdf]
```

It writes `report.json`, `report.html` and, with `--pdf`, `report.pdf` through
a headless Chromium, and prints one finding per line. Needs
`ce:GetCostAndUsage`, `ec2:DescribeLaunchTemplateVersions` and
`cloudtrail:LookupEvents`.

### What each workflow and lane costs, in USD

`fleet-cost.mjs` turns the same jobs into dollars. It rebuilds every host's
lifetime from the runner names, cuts each slot into running a job, startup,
between jobs, tail and never used, and spreads each UTC day and region's
**tagged** AWS cost over those paid slot-minutes. A job gets its own minutes at
that rate; the overhead kinds get theirs. AWS data comes in as the JSON the
`aws` CLI prints, so the script needs no SDK and runs with the operator's own
read-only credentials (`ce:GetCostAndUsage`, `ec2:DescribeSpotPriceHistory`):

```bash
GITHUB_TOKEN=… node scripts/runner-host/fleet-cost.mjs --repo owner/name \
  --since 2026-09-24 --until 2026-09-30 --costs ce-region.json \
  [--spot spot.json] [--untagged ce-untagged.json] [--lanes lanes.json] \
  [--label future-pay-ci] [--idle-minutes 2] [--margin-minutes 3] [--slots 2] \
  [--types m7a.2xlarge,…] [--cache .fleet-cost] [--csv out.csv] [--jobs jobs.json]
```

`--spot` takes one `describe-spot-price-history` answer, or a list of them
(one per region, merged with `jq -s '{SpotPriceHistory: map(.SpotPriceHistory[])}'`).
`--types` limits the bottom-up price to the fleet's own types. `--jobs` reads
a job list already fetched instead of the Actions API. The API is read slowly
(eight at a time). Once less than 40% of the token's allowance is left, the
script pauses until the allowance resets, so whatever else uses the token
(the scaler did) keeps its share.

- **The spread adds up to the tagged total by construction.** On its own it
  proves nothing. The check is the **bottom-up** cost: every host-hour at the
  mean spot price of the fleet's types in its zone, plus disk and address. The
  **gap** (tagged − bottom-up) holds what the jobs cannot show: hosts that never
  got a job, the on-demand fallback, images and snapshots, and the type mix.
- **A runner name is not a host.** Private addresses are recycled. Jobs on one
  name are split where their usage lines report different boots, or where the
  name sat idle past `--idle-minutes` + `--margin-minutes`.
- **Cost Explorer days are UTC** and the last day or two are incomplete; report
  complete days only.
- **The last section prints the all-in rate per job-minute** (tagged ÷ minutes
  running a job), which is what `cost-report.yml`'s `self_hosted` rate means,
  ready to paste as the caller's `runner-rates`. The same `--lanes` rules can
  be passed to `cost-report.yml` as `lane-rules`, so a lane means the same in
  the PR comment and in the daily report.

**Where:** anything that runs Ubuntu 24.04 with a public IPv4 and no
inbound ports. A dedicated server (Hetzner AX line or its server auction, OVH)
is far cheaper per core than a cloud VM. On DigitalOcean the equivalent droplet
costs more than the CI it replaces. Prices changed several times in 2026, so
check the current ones. **Budget: at most ~$60/month for the machine**, which
leaves room under $100 for the jobs that stay hosted (below).

## Install

**Prerequisites:** a dedicated Ubuntu 24.04 x86-64 machine, root, outbound
HTTPS to `github.com`, `api.github.com`, `*.actions.githubusercontent.com` and
the npm registry. No inbound port. The installer adds Docker, jq, openssl and
e2fsprogs.

1. **A credential that can register runners.** Prefer a **GitHub App**:
   *Org settings → Developer settings → GitHub Apps → New*, webhook off,
   **Repository permissions → Administration: Read and write**, nothing else.
   Install it on the one repository only and generate a private key. The
   supervisor mints a 9-minute JWT from that key and exchanges it for an
   installation token narrowed to `administration: write` on that repository.
   Neither ever reaches a job. A fine-grained PAT with the same permission
   also works (`CI_RUNNER_TOKEN`). For org-wide runners use *Organization
   permissions → Self-hosted runners: Read and write* and
   `CI_RUNNER_SCOPE=orgs/<org>`.
2. **On the machine**, as root:

   ```bash
   git clone https://github.com/12-apps/ci /opt/src/ci
   cd /opt/src/ci/scripts/runner-host
   CI_RUNNER_APP_ID=123456 CI_RUNNER_APP_KEY_FILE=/root/app.pem \
   CI_RUNNER_SCOPE=repos/12-apps/future-pay CI_RUNNER_LABELS=future-pay-ci \
   CI_RUNNER_DISK=60G ./install.sh 8
   shred -u /root/app.pem          # the installer keeps its own 0600 copy
   ```

   The install first proves the credential can manage runners on the scope,
   then builds the image and enables `ci-runner@1..8`. The runners show up
   under *Settings → Actions → Runners* as Idle.
3. **Flip the switch** in the repo: *Settings → Secrets and variables → Actions
   → Variables → New repository variable* `CI_RUNNER` = `future-pay-ci`.

Re-run `install.sh` at any time to change the slot count or limits, or to
rotate the credential. Values you leave out keep what is installed.

### Limits (per job)

| setting | default | what it does |
|---|---|---|
| `CI_RUNNER_MEMORY` | `auto`: 90% of RAM ÷ slots, read when each job starts | hard cap, swap included; the job is OOM-killed alone |
| `CI_RUNNER_PIN_CPUS` | `1` | slot N owns its own cores ÷ slots cores, and that is all it sees; `0` shares every core |
| `CI_RUNNER_CPUS` | unset | a CPU quota on top, for a host that shares cores |

Size a slot like the runner it replaces. future-pay's test lanes are tuned for GitHub's 4-vCPU, 16 GB runner (four vitest forks, FUT-801), so the fleet runs **two slots on an 8-vCPU, 32 GB host**. Three slots on 8 cores, each seeing all eight under a quota, ran three times the forks the cores could serve. Vitest's transform took 37 s instead of 11 s, a 20-second `findBy` timed out, and a Playwright web server missed its 180-second boot (future-pay #1978).
| `CI_RUNNER_DISK` | unbounded | the workspace and the job's Docker data on a fresh ext4 file of this size |
| `CI_RUNNER_JOB_TIMEOUT_MINUTES` | 360 | wall-clock cap from the moment a job starts; waiting for a job is not capped |

### Private npm packages

The token stays a GitHub **secret** and only lives in the job's environment.
future-pay maps `secrets.NPM_TOKEN` to `NODE_AUTH_TOKEN` and points
`NPM_CONFIG_USERCONFIG` at an `.npmrc` whose line is
`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`. The file holds the
variable reference, never the value; pnpm expands it in memory. Whatever a job
writes (npm config, caches, credentials) dies with its container.

### What a job no longer downloads

Every job used to fetch the same two things before doing any work: a Node
from GitHub (~4 s) and setup-node's pnpm cache (508 MB for future-pay, ~13 s,
and ~50 MB/s from Stockholm). Together that was about a tenth of the fleet's
job time. Both now come with the host:

- **Node in the tool cache.** The image carries the newest 24.x, 22.x and 20.x
  under `/opt/hostedtoolcache` (`TOOLCACHE_NODE_MAJORS`), in
  `@actions/tool-cache`'s own layout, so `setup-node` finds `24` locally.
- **A warm pnpm store.** `prepare-golden.sh` with `PNPM_STORE_PACKAGES` runs
  `warm-pnpm-store.sh`, which fills `/var/lib/ci-runner/pnpm-store` from the
  job image. `supervisor.sh` mounts it into every job at `/opt/pnpm-store` with
  `npm_config_store_dir` pointing there; the slots share it, since pnpm's store
  is content-addressed and safe for concurrent installs. The package list comes
  from `pnpm-store-packages.mjs` over the consumer's lockfile, minus
  `@12-apps/*`, whose restricted packages need a token the image must not hold,
  so the job fetches those few itself.

A host's disk is read lazily from the image's snapshot: ~116 MiB/s the first
time a block is touched, measured on a fresh host (2026-09-25). So the store
is kept to what a linux-x64 runner installs — the list leaves out every other
platform's native binary, 2.9 GB of future-pay's 4.4 GB — and
`ci-runner-prewarm.service` reads it once at boot, while the runner registers
and the first job checks out, instead of in that job's `pnpm install`.

**The store is off by default (`deploy.sh` `PNPM_STORE=off`).** Measured on
future-pay's jobs on 2026-09-25, the mounted store made installs slower, not
faster: it is a different mount from the job's workspace, so pnpm copies every
file instead of hardlinking it, and the install took 30–61 s. A host with no
store and no cache downloaded all 1877 packages from npm into the job's own
store and installed them in 13.6 s. So with `CI_PNPM_STORE=warm` a job skips
setup-node's 508 MB cache and lets pnpm fetch from npm; the image keeps the
store for a layout that can hardlink it, and `PNPM_STORE=on` mounts it again.

setup-node's cache stands down only where the caller's repository variable
`CI_PNPM_STORE` is `warm`, which is set once the fleet's image has the store.
Deleting the variable restores the download everywhere. A package added after
the image was made is fetched from npm by the job, so the store only needs
refreshing to stay fast, not to stay correct.

## The switch, and how to undo it

Every job in these reusable workflows says

```yaml
runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
```

A called workflow reads `vars` from the **caller's** repository, so the
consumer's single variable moves every job. **Delete the variable and the next
run is back on GitHub's runners**, with no commit needed. If the machine goes
down, jobs queue (they do not fail) until it comes back or the variable is
removed.

## A light pool for short jobs

A plan, a verdict, Detect Changes or an upkeep probe runs for seconds and
installs nothing, yet on the fleet each one holds a 4-core, 14 GB slot of an
8-vCPU spot host, and a burst of them launches hosts that boot for ~3 minutes
to run a 20-second job (FUT-4536). A **light pool** is a second fleet for
exactly those jobs: the same image and the same scaler, deployed again under
its own label, on 2-vCPU, 8 GB hosts.

**What the jobs use**, from their `ci-runner-usage` lines on future-pay
(2026-11-05): the Unit, Integration and SPA E2E plans average 0.84–1.1 cores
with a working set of 0.67–1.5 GiB; Detect Changes 0.5–0.8 cores and 0.3 GiB;
the conflict probes and the commit-message enforcement under 1.1 cores and
0.63 GiB. A light host keeps the image's **two slots**, so each slot owns one
vCPU and ~3.6 GB (90% of 8 GB ÷ 2), and no slot unit changes.

**How it is made.** Nothing on the main fleet changes; every setting below is
optional and its absence is today's behaviour:

- `deploy.sh` with `HOST_LABELS=<light label>` writes the label over the
  image's `CI_RUNNER_LABELS` at boot, so a host from the main fleet's image
  registers for the light pool. Its own `FUNCTION_NAME`, launch template
  (`ci-runner-fleet-<light label>`), queue table, daily budget and spend
  parameter all follow from `RUNNER_LABEL`.
- `WEBHOOK_SECRET_PARAMETER=<SSM name>`: the scaler reads its webhook secret
  from an SSM SecureString at run time instead of carrying it in its
  configuration. The webhook is created by hand (below), so the secret is made
  once by its owner and is never stored in a deploy's checkout or the
  function's environment. A deploy still reads it once to sign its test ping,
  and that passes it to `openssl dgst -hmac` on a command line, as the main
  fleet's deploy already does with its secret file.
- Pruning keeps the image every OTHER fleet template launches, so the main
  fleet's deploy never deletes the image the light pool still runs.
- `refresh-image.sh` with `LIGHT_FUNCTION_NAME` (the workflow's
  `light_function_name`) deploys the new image to the light pool too, after
  the main fleet, with the light scaler's own live settings, and never touches
  its webhook (`CREATE_WEBHOOK=0`).
- The reusable workflows take `light-runner` and send only their short jobs
  to it (`.github/workflows/__tests__/light-runner.test.mjs` lists them);
  empty, every job runs where it runs today.

A second scaler means a second webhook, because each scaler has its own
function URL and acts only on its own label (`scale-light.test.mjs`).

### Turning it on (the owner, once)

Do these in order. Until step 7 no job moves, so every step can be checked
before the next. `future-pay-ci-light` and `ci-runner-scale-light` are the
names the consumer's variables expect; the region is the fleet's home region.

1. **Merge the engine change and let its release move `v2`**, then merge the
   consumer's. With the repository variables of steps 5 and 7 unset, the
   consumer's CI runs exactly where it ran before.
2. **Make the webhook secret** on your own machine, never in a chat or a log:

   ```bash
   umask 077; openssl rand -hex 32 | tr -d '\n' > ~/ci-runner-light-webhook-secret
   ```

3. **Store it in SSM**, in the fleet's home region, under this exact name:
   `/ci-runner/webhook-secret-future-pay-ci-light`. *AWS console → Systems
   Manager → Parameter Store → Create parameter*: Tier **Standard**, Type
   **SecureString**, KMS key `alias/aws/ssm`, Value: the file's contents. Or:

   ```bash
   aws ssm put-parameter --region us-east-1 --type SecureString \
     --name /ci-runner/webhook-secret-future-pay-ci-light \
     --value "file://$HOME/ci-runner-light-webhook-secret"
   ```

4. **Deploy the light scaler** from a checkout of `main`, with the account's
   admin profile. `AMI_ID` is what the main fleet launches now, and `REGIONS`
   its live regions:

   ```bash
   ami=$(aws ec2 describe-launch-template-versions --region us-east-1 --launch-template-name ci-runner-fleet-future-pay-ci \
     --versions '$Default' --query 'LaunchTemplateVersions[0].LaunchTemplateData.ImageId' --output text)
   regions=$(aws lambda get-function-configuration --region us-east-1 --function-name ci-runner-scale \
     --query Environment.Variables.REGIONS --output text)
   cd scripts/runner-host/wake
   AWS_REGION=us-east-1 REPOSITORY=12-apps/future-pay \
   RUNNER_LABEL=future-pay-ci-light FUNCTION_NAME=ci-runner-scale-light HOST_LABELS=future-pay-ci-light \
   WEBHOOK_SECRET_PARAMETER=/ci-runner/webhook-secret-future-pay-ci-light CREATE_WEBHOOK=0 \
   AMI_ID="$ami" REGIONS="$regions" \
   SUBNET_ID=<as the main fleet> SECURITY_GROUP_ID=<as the main fleet> INSTANCE_PROFILE_ARN=<as the main fleet> \
   INSTANCE_TYPES=m7a.large,m6a.large,m7i.large,m6i.large,r7a.large,r6a.large,r7i.large,r6i.large \
   SLOTS_PER_HOST=2 MAX_HOSTS=10 DAILY_BUDGET=4 DEGRADED_MAX_HOSTS=1 IDLE_MINUTES=5 ROOT_THROUGHPUT=125 \
     ./deploy.sh
   ```

   It ends with `Scaler: https://….lambda-url.us-east-1.on.aws/`; the signed
   ping it sends proves the function reads the secret. `IDLE_MINUTES=5` keeps a
   cheap host for the next burst (modelled: half the launches of 2 minutes for
   6% more host-hours); `ROOT_THROUGHPUT=125` is gp3's free baseline, which a
   job that installs nothing does not exceed. `MAX_HOSTS=10` is 20 vCPU on top
   of the main fleet's 240 against the account's spot vCPU quota (L-34B43A08):
   check the quota has room in every region in `REGIONS`.
5. **Create webhook #2.** *github.com/12-apps/future-pay → Settings → Webhooks
   → Add webhook*: Payload URL = the `Scaler:` URL from step 4, exactly
   (trailing slash included); Content type `application/json`; Secret = the
   same value as step 3; SSL verification on; *Let me select individual
   events* → **Workflow jobs** and **Workflow runs** only; Active. Its *Recent
   Deliveries* must show the ping answered `200` with `pong`. Then delete
   `~/ci-runner-light-webhook-secret`.
6. **Let the weekly refresh carry it.** Give the refresh role (README in
   `wake/`, "One-time setup") the same rights over `ci-runner-scale-light`
   (function and role), `ci-runner-fleet-future-pay-ci-light` (template),
   `ci-runner-queue-future-pay-ci-light` (table),
   `/ci-runner/spend-future-pay-ci-light` and the secret parameter of step 3
   (`ssm:GetParameter` with decryption) as it has over the main fleet's, then
   set the consumer's repository variable `CI_LIGHT_RUNNER_FUNCTION` =
   `ci-runner-scale-light`. Unset, a refresh redeploys the main fleet only and
   the light pool stays on its image until someone redeploys it.
7. **Flip the switch**: repository variable `CI_LIGHT_RUNNER` =
   `future-pay-ci-light`. The next run's short jobs queue for the light pool.
   **Delete the variable and they are back on the main fleet** with the next
   run, no commit needed; if the light pool is down, its jobs queue (they do
   not fail) until it is back or the variable is gone.

**Its own GitHub credential (optional).** The light scaler reads the token at
`TOKEN_PARAMETER` (default the main fleet's `/ci-runner/github-app-key`), and
its reads come out of that token's hourly allowance: about one runner listing
per delivery that evaluates, and one reconcile every 10 minutes. To keep the
main scaler's allowance whole, store a second token (same permissions:
*Administration* and *Actions* read and write) as another SecureString and
deploy the light scaler with `TOKEN_PARAMETER=<its name>`. The hosts still
mint their runners with the image's credential.

**Reading it back.** `fleet-cost.mjs`, `usage-report.mjs` and
`daily-report.mjs` take `--label future-pay-ci-light` (and `--slots 2`) for
the light pool's own numbers. `cost-report.yml` prices every self-hosted job
at one rate, so its PR comment overstates a light job's cost.

## A medium pool

Between the light jobs and the heavy ones is a middle class (FUT-4944, the
"M" class, measured on future-pay on 2026-11-10/11): Gherkin, the RSC smoke,
Static Gates, Lint, Retry Gate, E2E Reliability, Page Load, the storefront
bundle budget, Request Waves, the image build. They average about two cores,
yet each holds a 4-core, 14 GB slot of the main fleet. A **medium pool** is a
third fleet for them, made the same way as the light pool: the same image and
the same scaler, deployed again under its own label, with **2 vCPU per slot**.

**The memory per slot is not set yet.** It is to be set from a memory-capped
measurement of the class (FUT-4944). The peaks read so far (Gherkin shards at
9.3 GiB of working set, Lint's p95 at 4.0 cores and 4.4 GiB) were taken in
slots capped at ~28,000 MiB, so they show what a job takes when memory is
effectively unlimited, not what it needs. The host type and the slots per host
follow from that number, so both stay parameters of the deploy
(`INSTANCE_TYPES`, `SLOTS_PER_HOST` and `HOST_SLOTS`): one slot on a 2-vCPU host
gives the slot 90% of the host's RAM, two slots on a 4-vCPU host give each 45%.

**How it is made.** Everything the light pool uses, plus one setting:

- `deploy.sh` with `HOST_LABELS=<medium label>`, its own `FUNCTION_NAME`
  (`ci-runner-scale-medium`), `WEBHOOK_SECRET_PARAMETER` and
  `CREATE_WEBHOOK=0`, exactly as in the light pool's steps.
- **`HOST_SLOTS=<n>`**, with `SLOTS_PER_HOST=<n>`, when the pool's slots per
  host differ from the image's. The image is built with the main fleet's two
  slot units; `HOST_SLOTS` writes the host's `CI_RUNNER_SLOTS` at
  boot, so the memory cap (`auto`, 90% of RAM / slots) and the pinned cores
  follow it, and `supervisor.sh` leaves a slot above the count down (it exits
  66, which the slot unit does not restart). `deploy.sh` refuses a
  `HOST_SLOTS` that differs from `SLOTS_PER_HOST`, the scaler's count. Unset,
  the user data is byte for byte what it was (`deploy-medium.test.mjs`).
  The unit's `RestartPreventExitStatus=66` arrives with the next image built
  from this checkout; on an older image the slot above the count retries
  every 30 seconds and still runs nothing.
- `refresh-image.sh` with `MEDIUM_FUNCTION_NAME` (the workflow's
  `medium_function_name`) deploys the new image to the medium pool too, after
  the main fleet and the light pool, with its own live settings, `HOST_SLOTS`
  included (`refresh-medium.test.mjs`).
- The reusable workflows take `medium-runner` and send only their M jobs to it
  (`.github/workflows/__tests__/medium-runner.test.mjs` lists them: Lint and
  Retry Gate, Static Gates and E2E Reliability, the Next.js prod smoke, Build
  image). The other M jobs are the consumer's own and are routed in its
  workflow. Empty, every job runs where it runs today.

**Turning it on** follows the light pool's steps 1 to 7 with `medium` for
`light` in every name (`future-pay-ci-medium`, `ci-runner-scale-medium`,
`/ci-runner/webhook-secret-future-pay-ci-medium`,
`ci-runner-fleet-future-pay-ci-medium`, `CI_MEDIUM_RUNNER_FUNCTION`,
`CI_MEDIUM_RUNNER`), and step 4's deploy with these settings:

```bash
RUNNER_LABEL=future-pay-ci-medium FUNCTION_NAME=ci-runner-scale-medium HOST_LABELS=future-pay-ci-medium \
WEBHOOK_SECRET_PARAMETER=/ci-runner/webhook-secret-future-pay-ci-medium CREATE_WEBHOOK=0 \
INSTANCE_TYPES=<from the capped measurement> SLOTS_PER_HOST=<n> HOST_SLOTS=<n> \
  ./deploy.sh   # with AWS_REGION, REPOSITORY, AMI_ID, REGIONS, the network and the caps as in the light pool's step 4
```

Pick `INSTANCE_TYPES` and `<n>` so that each slot gets 2 vCPU and at least the
memory the capped measurement sets: vCPU = 2 × n.

Measure it apart from the light pool: FUT-4944 waits for the light pool's
verdict (E-153) before the medium pool's first day, so the two are never
measured on the same day.

## What stays on GitHub's runners

(`expo-apk.yml`'s `apk` job moved to the fleet: the image carries the Android
SDK, NDK, CMake and ccache that a React Native release compiles with, pinned in
the Dockerfile's `ANDROID_PACKAGES`. Bump them when the app's react-native
does; a version missing here is still downloaded by Gradle, only slower.)

- Jobs that need Windows or macOS (a `matrix.os`), which this machine cannot
  provide.
- GitHub **Code Quality** / **CodeQL default setup** runs are dynamic workflows
  that ignore `CI_RUNNER`. Point them at the same label under *Settings → Code
  security → (Code Quality | CodeQL) → Runner type: Labeled runner*, or turn
  them off.

## Operating it

```bash
ci-runner-status                          # every slot: service, phase, job, PID, heartbeat, CPU/RAM/disk, last failure
ci-runner-status --json                   # same, for a probe (exit 1 when a slot is unhealthy)
journalctl -u 'ci-runner@*' -f            # registrations, job start/finish, failures
journalctl -t ci-runner-3 -f              # slot 3's runner output
touch /run/ci-runner/drain                # restart every slot once its job is done
systemctl restart 'ci-runner@*'           # KILLS running jobs; slots re-register
systemctl stop 'ci-runner@*'              # stop taking jobs (jobs queue on GitHub)
systemctl start ci-runner-image           # rebuild the image now (also weekly)
```

Logs go to journald, capped at 2 GB and 30 days
(`/etc/systemd/journald.conf.d/ci-runner.conf`). Neither the logs nor the
state files ever hold a token: the JIT config reaches the container by
environment variable name, and the credential never leaves the host.

A failed, hung or killed job cannot leave a slot busy. The container is removed
on every path (done, failed, timeout, `systemctl stop`, a crash of the
supervisor on its next start), the per-job disk is unmounted and deleted, and
an offline runner the slot left behind is deregistered before it registers
again. A slot that is stopped while its runner waits for a job deregisters that
runner on the way out, so `systemctl stop` or a reboot leaves nothing offline
under Settings → Runners. Registration failures back off exponentially. After 8 in a row the
slot's process exits, systemd restarts it 30 s later, and `ci-runner-status`
shows the failure until it clears.

### Stopping when idle, starting on demand

With `CI_RUNNER_IDLE_MINUTES=20`, the host powers itself off after 20 minutes
without a job (`idle-stop.sh`, every minute from `ci-runner-idle.timer`), and
a GitHub webhook and a Lambda start it again when a job for it is queued
([wake/README.md](wake/README.md)). The stop never costs a job:
- Each slot's waiting runner is released through the API before its slot
  stops.
- GitHub refuses that for a runner it has just handed a job, and one refusal
  cancels the stop.

The default is `0` (never stop). Leave it there until the wake is in place,
or queued jobs wait for a person.

### Upgrading

```bash
cd /opt/src/ci && git pull && cd scripts/runner-host && ./install.sh   # scripts + image
systemctl start ci-runner-image                                         # image only
```

Neither interrupts a job. `install.sh` does not restart a running slot: it
touches `/run/ci-runner/drain`, and each slot finishes its job (or releases a
runner still waiting, at once), exits, and comes back on the new scripts. A new
image needs no drain: a waiting runner on the old image is released and
re-registered on the new one, and a running job keeps its image until it ends.
A waiting runner is released by deleting it through the API before its
container goes, and GitHub refuses that for a runner it has just handed a job,
so a release never races an assignment.

### Rotating or revoking the credential

- **Rotate an App key:** generate a new private key in the App's settings, run
  `CI_RUNNER_APP_KEY_FILE=/root/new.pem ./install.sh`, then delete the old
  key in the App's settings.
- **Rotate a PAT:** `CI_RUNNER_TOKEN=<new> ./install.sh`, then revoke the old one.
- **Revoke:** uninstall first (it deregisters the runners with the credential
  it still has), then delete the App installation or the PAT.

### Uninstall

```bash
sudo /opt/ci-runner/uninstall.sh
```

This stops every slot, deregisters this host's runners, removes the units,
images, per-job disks and state, and shreds the stored credential. Then delete
the `CI_RUNNER` repository variable, and CI is back on GitHub's runners.

## Security

- **The containers are `--privileged`.** A job's own dockerd needs that (the
  workflows use `services:`, `container:` and `docker build`). The host's
  Docker socket is **not** mounted. A privileged job can still do anything the
  machine can, which is why:
- **Only trusted code runs here.** The runners are registered to **one
  private repository**, whose pull requests come from people with write
  access. Keep *Settings → Actions → Fork pull request workflows* disabled
  (the default for private repositories). Never point a public repository, or
  one that runs fork PRs, at this machine.
- **The machine is dedicated.** Nothing else runs on it, and it holds no
  secret except the runner credential (root-only, 0600).
- **Least privilege:** the App's installation token is scoped to runner
  administration on one repository and lives one hour.
- **Limitation:** jobs share the host kernel. This is container isolation, not
  VM isolation.
