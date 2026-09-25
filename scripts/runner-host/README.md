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

## What stays on GitHub's runners

- `expo-apk.yml`'s `apk` job: gradle needs the Android SDK that `ubuntu-latest`
  has preinstalled.
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
