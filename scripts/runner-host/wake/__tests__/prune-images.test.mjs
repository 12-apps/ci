import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { imagesToPrune, launchedImages } from "../prune-images.mjs";

// Deleting an image the fleet still launches, or the one a rollback needs,
// breaks CI; keeping every image bills a 72 GB snapshot per image per month.

const img = (ImageId, CreationDate, extra = {}) => ({
  ImageId, CreationDate, State: "available",
  BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { SnapshotId: `snap-${ImageId.slice(4)}` } }],
  ...extra,
});
const ver = (VersionNumber, ImageId) => ({ VersionNumber, LaunchTemplateData: { ImageId } });
// us-east-1 as it stood on 2026-09-25: five images from the 24th (025b the one
// in production that day), the first warm build (0c22, never deployed) and the
// second (0f36), deployed twice: with the store at 20:27, without it at 21:00.
const useast1 = [
  img("ami-0589", "2026-09-24T04:34:00.000Z"),
  img("ami-05b2", "2026-09-24T13:41:00.000Z"),
  img("ami-0d80", "2026-09-24T14:30:00.000Z"),
  img("ami-0776", "2026-09-24T15:30:00.000Z"),
  img("ami-025b", "2026-09-24T16:03:00.000Z"),
  img("ami-0c22", "2026-09-25T19:52:00.000Z"),
  img("ami-0f36", "2026-09-25T20:13:00.000Z"),
];
const history = [ver(1, "ami-0589"), ver(2, "ami-05b2"), ver(3, "ami-0776"), ver(4, "ami-025b"), ver(5, "ami-025b"), ver(6, "ami-0f36"), ver(7, "ami-0f36")];
const ids = (out) => out.map((o) => o.id);

test("the rollback is the previous image the template launched, not the previous image by date", () => {
  assert.deepEqual(launchedImages(history), ["ami-0f36", "ami-025b"], "a redeploy of the same image is not a new one");
  const out = imagesToPrune(useast1, { held: launchedImages(history) });
  // 0c22 is newer than 025b but was never deployed: it goes, 025b stays.
  assert.deepEqual(ids(out), ["ami-0c22", "ami-0776", "ami-0d80", "ami-05b2", "ami-0589"]);
  assert.deepEqual(out.find((o) => o.id === "ami-0589").snapshots, ["snap-0589"]);
});

test("an image a live host was launched from stays, however old", () => {
  const out = imagesToPrune(useast1, { held: [...launchedImages(history), "ami-0589"] });
  assert.ok(!ids(out).includes("ami-0589"));
});

test("the newest image stays even when no template names it, and a copy in flight is never touched", () => {
  // Older than the newest, so only its state can save it.
  const images = [...useast1, img("ami-pend", "2026-09-25T20:00:00.000Z", { State: "pending" })];
  const out = imagesToPrune(images, { held: ["ami-0f36"] });
  assert.ok(!ids(out).includes("ami-pend"), "pending: a deploy in progress");
  assert.ok(!ids(imagesToPrune(useast1, { held: [] })).includes("ami-0f36"), "the newest is kept with nothing held");
});

test("with only what must stay there is nothing to delete", () => {
  assert.deepEqual(imagesToPrune(useast1.slice(-1), { held: ["ami-0f36"] }), []);
  assert.deepEqual(imagesToPrune([], {}), []);
  assert.deepEqual(launchedImages([]), []);
});

function cli(images, versions, live = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "prune-"));
  writeFileSync(path.join(dir, "i.json"), JSON.stringify({ Images: images }));
  writeFileSync(path.join(dir, "v.json"), JSON.stringify({ LaunchTemplateVersions: versions }));
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prune-images.mjs");
  return execFileSync("node", [bin, path.join(dir, "i.json"), path.join(dir, "v.json"), live], { encoding: "utf8" });
}

test("the CLI prints `<image> <snapshots>` per line to delete", () => {
  assert.deepEqual(cli(useast1, history, "ami-0776").trim().split("\n"), [
    "ami-0c22 snap-0c22", "ami-0d80 snap-0d80", "ami-05b2 snap-05b2", "ami-0589 snap-0589",
  ]);
});

test("the CLI deletes nothing when the region has no template history to go by", () => {
  assert.equal(cli(useast1, []), "");
});
