# One GitHub Actions job, in a box of its own.
#
# The image a runner-host slot starts per job (see README.md). It stands in for
# GitHub's `ubuntu-latest`, so it carries what the 12-apps workflows actually
# reach for on that image — git, jq, gh, curl, zip, ssh, a C toolchain, python,
# shellcheck, sudo, Docker, a system Node, and Chromium's system libraries —
# and nothing else. Anything a workflow installs itself (a pinned node via
# setup-node, pnpm, Playwright's browsers) is left to the workflow, exactly as
# on a hosted runner.
#
# It runs its OWN dockerd (the container is started `--privileged`), so a job's
# `services:`, `container:` and `docker build` get a daemon, a network and a
# `localhost` that no other job on the host can see or collide with.
# BASE_IMAGE: a Docker Hub pull can be rate-limited (429) on a shared IP;
# `mirror.gcr.io/library/ubuntu:24.04` is the same image.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ARG RUNNER_VERSION
ARG PLAYWRIGHT_VERSION=1

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    TZ=Etc/UTC \
    # Read by setup-* actions to pick a prebuilt toolchain for this OS.
    ImageOS=ubuntu24 \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache

# Ubuntu's security mirror serves nodes out of step with its index: on
# 2026-09-24 91.189.91.82/.83 answered 404 for the libexpat1 the fresh index
# named, twice in an hour, while other nodes served it. apt does not retry a
# 404, so every install here goes through apt-install: update, install, and on
# failure wait and start over (a new update, often a different node).
RUN printf '%s\n' '#!/bin/sh' \
      'for i in 1 2 3 4 5; do' \
      '  apt-get update && apt-get install -y --no-install-recommends "$@" && exit 0' \
      '  echo "apt-install: attempt $i failed; retrying" >&2; sleep $((i * 15))' \
      'done' \
      'exit 1' > /usr/local/bin/apt-install \
 && chmod 0755 /usr/local/bin/apt-install \
 && echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries

RUN apt-install \
      build-essential ca-certificates curl file git git-lfs gnupg iproute2 \
      iptables jq less lsb-release openssh-client procps psmisc python3 \
      python3-pip python3-venv rsync shellcheck sudo tini tzdata unzip wget \
      xz-utils zip zstd \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-install \
      containerd.io docker-buildx-plugin docker-ce docker-ce-cli \
      docker-compose-plugin gh \
 && rm -rf /var/lib/apt/lists/*

# A system Node on PATH, as ubuntu-latest has one: workflows run `node` in
# steps BEFORE setup-node (12-apps/ci's fetch-base and migration-domains
# actions do, in the first seconds of Static), and on a runner without it
# every such job dies with `node: command not found`. setup-node still wins
# wherever a workflow pins a version, by putting its own ahead on PATH. Not
# apt's `nodejs`: noble ships 18, and Playwright refuses to start below 20.
ARG SYSTEM_NODE=v24.9.0
RUN curl -fsSL "https://nodejs.org/dist/${SYSTEM_NODE}/node-${SYSTEM_NODE}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
 && node --version

# Chromium's shared libraries and fonts, installed once here instead of by
# `playwright install --with-deps` on every job. Then what Electron adds on
# top — GTK 3, libnotify, libsecret, FUSE for AppImages, and Xvfb — which
# ubuntu-latest also carries: printer-agent's packaged-start proof died with
# `libgtk-3.so.0: cannot open shared object file` without them.
RUN (npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
      || { sleep 30; npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium; }) \
 && apt-install \
      libfuse2t64 libgtk-3-0t64 libnotify4 libsecret-1-0 libxss1 libxtst6 \
      xdg-utils xvfb \
 && rm -rf /root/.npm /var/lib/apt/lists/*

# The job user: passwordless sudo and the docker group, as on ubuntu-latest,
# because workflows `sudo apt-get` and `docker run` without asking.
RUN useradd --create-home --shell /bin/bash runner \
 && usermod -aG docker runner \
 && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
 && chmod 0440 /etc/sudoers.d/runner \
 && install -d -o runner -g runner /opt/hostedtoolcache

WORKDIR /home/runner/actions-runner
RUN test -n "$RUNNER_VERSION" \
 && curl -fsSL -o runner.tgz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && tar xzf runner.tgz && rm runner.tgz \
 && ./bin/installdependencies.sh \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R runner:runner /home/runner

COPY entrypoint.sh /usr/local/bin/ci-runner-entrypoint
COPY localhost.sh /usr/local/bin/ci-runner-localhost
ENTRYPOINT ["tini", "--", "/usr/local/bin/ci-runner-entrypoint"]
