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

1. **A token that can mint runners.** Fine-grained PAT, resource owner = the
   org:
   - repo runners: *Repository access* = the repo, *Administration: Read and
     write*;
   - org runners (serves every repo): *Organization permissions → Self-hosted
     runners: Read and write*.
2. **On the machine** (fresh Ubuntu 24.04, as root):

   ```bash
   git clone https://github.com/12-apps/ci /opt/src/ci
   cd /opt/src/ci/scripts/runner-host
   CI_RUNNER_TOKEN=github_pat_... \
   CI_RUNNER_SCOPE=repos/12-apps/future-pay \
   CI_RUNNER_LABELS=future-pay-ci \
   ./install.sh 8
   ```

   The install checks that the token can list runners before it does anything
   else. It builds the image, then enables `ci-runner@1..8`. The runners then
   show up under *Settings → Actions → Runners* as Idle.
3. **Flip the switch** in the repo: *Settings → Secrets and variables → Actions
   → Variables → New repository variable* `CI_RUNNER` = `future-pay-ci`.

Re-run `install.sh` at any time to change the slot count or rotate the token.
Leave the token out and it keeps the one already installed.

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
systemctl status 'ci-runner@*'            # one line per slot
journalctl -u ci-runner@3 -f              # that slot's registrations and exits
docker ps --filter name=ci-runner-        # the jobs running right now
systemctl start ci-runner-image           # rebuild the image now
```

## Security

The containers are `--privileged`, because a job's own dockerd needs that. A
job can therefore do anything the machine can. That is fine for a **private
repository whose PR authors you trust**. It is not fine for a public repository
that runs pull requests from forks. Use this machine for nothing else.
