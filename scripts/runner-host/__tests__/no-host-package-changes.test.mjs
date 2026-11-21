import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// FUT-5281. A fleet host lives minutes and must never change its own packages:
// with Ubuntu's unattended-upgrades on, every host booted after a security
// release upgraded libc about a minute after boot, needrestart restarted
// containerd and dockerd, `Requires=docker.service` stopped both runner slots,
// and the supervisor removed their containers with the jobs inside. Measured on
// 2026-11-17..21: 69 to 160 such host losses a day, none before.
//
// Three rules hold that shut, and each is pinned here on the files themselves:
// packages change only when the weekly image is built; a docker restart does
// not stop a slot; a daemon restart does not stop a container.

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const golden = read("../wake/prepare-golden.sh");
const install = read("../install.sh");

test("the image takes every pending upgrade, then removes what would upgrade or restart on a host", () => {
  const upgrade = golden.indexOf("full-upgrade");
  const purge = golden.search(/purge unattended-upgrades needrestart/);
  const mask = golden.search(/systemctl mask apt-daily\.timer apt-daily-upgrade\.timer apt-daily\.service apt-daily-upgrade\.service unattended-upgrades\.service/);
  const kit = golden.indexOf('"$here/../install.sh"');
  assert.ok(upgrade !== -1, "prepare-golden.sh upgrades the image's packages");
  assert.ok(purge !== -1, "prepare-golden.sh removes unattended-upgrades and needrestart");
  assert.ok(mask !== -1, "prepare-golden.sh masks the apt timers and services");
  assert.ok(upgrade < purge && purge < mask && mask < kit, "upgrade, then remove and mask, all before the kit is installed");
  assert.match(golden, /APT::Periodic::Unattended-Upgrade "0"/);
});

test("nothing else refreshes or rebuilds on a fleet host: snaps are held, the kit's image-rebuild timer is masked", () => {
  const hold = golden.search(/snap refresh --hold/);
  assert.ok(hold !== -1 && golden.indexOf("snap refresh >/dev/null") < hold, "snaps are refreshed in the image, then held");
  assert.match(golden, /systemctl mask ci-runner-image\.timer/);
});

test("a docker restart does not stop a runner slot: the unit wants docker, it does not require it", () => {
  const unit = install.slice(install.indexOf("/etc/systemd/system/ci-runner@.service"), install.indexOf("\nUNIT\n", install.indexOf("/etc/systemd/system/ci-runner@.service")));
  assert.match(unit, /^After=docker\.service/m, "slots still start after docker");
  assert.match(unit, /^Wants=docker\.service$/m);
  assert.doesNotMatch(unit, /^(Requires|BindsTo|PartOf)=docker\.service/m);
});

test("a dockerd or containerd restart does not stop a container: live-restore is merged into daemon.json", () => {
  assert.match(install, /jq '\. \+ \{"live-restore": true\}' "\$daemon_json"/);
  const merge = install.indexOf("live-restore\": true}");
  const restart = install.indexOf("systemctl restart docker");
  assert.ok(merge !== -1 && restart > merge, "docker is restarted after the setting is written, so it takes effect");
});
