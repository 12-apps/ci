#!/usr/bin/env bash
# Prove an image can serve a job the way `ubuntu-latest` does.
#
#   smoke.sh <image>
#
# Starts the image the way supervisor.sh does (privileged, big /dev/shm, its
# own /var/lib/docker) but swaps the runner for checks of what the workflows
# depend on: its own dockerd, a `services:`-style container answering on the
# job's localhost, passwordless sudo, the CLI tools, and a Chromium launched
# from Playwright using nothing but the system libraries baked into the image.
# Each failure here is one a real job would hit minutes in.
set -euo pipefail

image="${1:?usage: smoke.sh <image>}"

docker run --rm --privileged --shm-size 2g --volume /var/lib/docker \
  ${NODE_EXTRA_CA_CERTS:+--env NODE_EXTRA_CA_CERTS} \
  --entrypoint bash "$image" -c '
set -euo pipefail
test "$(id -u)" = 0
# What the entrypoint does first: `localhost` is 127.0.0.1 alone, and no
# HOSTNAME reaches the job (servers bind to it; the GitHub VM exports none).
ci-runner-localhost
grep -q "^unset HOSTNAME$" /usr/local/bin/ci-runner-entrypoint \
  || { echo "smoke: the entrypoint lets the Docker HOSTNAME reach the job" >&2; exit 1; }
dockerd >/var/log/dockerd.log 2>&1 &
for _ in $(seq 1 120); do docker info >/dev/null 2>&1 && break; sleep 0.5; done
runuser -u runner -- env ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS"} bash -euo pipefail -c "
  sudo -n true
  # node before any setup-node: workflows call it in their first steps.
  for t in git git-lfs jq gh curl zip unzip xz zstd ssh rsync python3 gcc make docker \
           shellcheck node npm npx; do
    command -v \$t >/dev/null || { echo \"smoke: missing \$t\" >&2; exit 1; }
  done
  node -e \"process.exit(Number(process.versions.node.split(\\\".\\\")[0]) >= 20 ? 0 : 1)\" \
    || { echo \"smoke: system node is older than 20\" >&2; exit 1; }
  # Electron apps load these at start; a packaged app dies without them.
  for lib in libgtk-3.so.0 libnotify.so.4 libsecret-1.so.0 libfuse.so.2; do
    /sbin/ldconfig -p | grep -q \"\$lib\" || { echo \"smoke: missing \$lib\" >&2; exit 1; }
  done
  command -v Xvfb >/dev/null || { echo \"smoke: missing Xvfb\" >&2; exit 1; }

  # A server bound to localhost (the Vite default) is reachable at localhost.
  # With the /etc/hosts Docker writes it binds ::1 alone and the client is refused.
  node --input-type=module -e \"
    import http from \\\"node:http\\\";
    const srv = http.createServer((q, r) => r.end(\\\"ok\\\"));
    await new Promise((res) => srv.listen(0, \\\"localhost\\\", res));
    const body = await (await fetch(\\\"http://localhost:\\\" + srv.address().port)).text();
    if (body !== \\\"ok\\\") process.exit(1);
    srv.close();
  \" || { echo \"smoke: a server bound to localhost is not reachable at localhost\" >&2; exit 1; }
  docker buildx version >/dev/null
  docker compose version >/dev/null

  # services: — a container port mapped onto THIS job container localhost.
  docker run -d --name svc -p 6379:6379 mirror.gcr.io/library/redis:7-alpine >/dev/null
  pong=
  for _ in \$(seq 1 60); do
    pong=\$( (exec 3<>/dev/tcp/127.0.0.1/6379 && printf \"PING\\r\\n\" >&3 && head -c 5 <&3) 2>/dev/null || true)
    [[ \$pong == +PONG ]] && break
    sleep 0.5
  done
  [[ \$pong == +PONG ]] || { echo \"smoke: service container not reachable on localhost\" >&2; exit 1; }

  # Chromium on the baked-in libraries only: no --with-deps here.
  nv=v24.9.0
  curl -fsSL https://nodejs.org/dist/\$nv/node-\$nv-linux-x64.tar.xz | tar -xJ -C /opt/hostedtoolcache
  export PATH=/opt/hostedtoolcache/node-\$nv-linux-x64/bin:\$PATH
  mkdir -p ~/pw && cd ~/pw && npm init -y >/dev/null && npm i --silent playwright@1
  npx playwright install chromium >/dev/null
  node -e \"
    const { chromium } = require(\\\"playwright\\\");
    (async () => {
      const b = await chromium.launch();
      const p = await b.newPage();
      await p.setContent(\\\"<h1>ok</h1>\\\");
      if ((await p.textContent(\\\"h1\\\")) !== \\\"ok\\\") throw new Error(\\\"page did not render\\\");
      console.log(\\\"smoke: chromium\\\", b.version());
      await b.close();
    })().catch((e) => { console.error(\\\"smoke: chromium failed:\\\", e.message); process.exit(1); });
  \"
"
'
echo "smoke: ok"
