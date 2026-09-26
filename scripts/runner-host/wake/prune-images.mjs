#!/usr/bin/env node
// Which of a region's fleet images deploy.sh may delete.
//
// Every deploy makes an image and copies it to each region, and nothing ever
// removed one: by 2026-09-25 us-east-1 held seven, each a 72 GB snapshot billed
// by the month. After the templates point at the new image, deploy.sh asks this
// module which of the region's `ci-runner-<label>-*` images can go, and
// deregisters them with their snapshots.
//
// An image is kept when it is
//   - one of the last `keep` DISTINCT images the region's launch template
//     launched, newest version first: the one in use and the one before it,
//     which is the rollback (deploy.sh AMI_ID=<it>). By template history, not
//     by date: a newer image that was built and never deployed is not a
//     rollback, and a redeploy of the same image is not a new one;
//   - the image of any fleet instance that still exists, running or stopped
//     (a host mid-job must never lose its image under it);
//   - the newest image of all, whatever the template says;
//   - not `available` yet (a copy still in flight is a deploy in progress).
//
//   node prune-images.mjs <images.json> <template-versions.json> [live-image-ids] [keep]
//
// images.json is `aws ec2 describe-images --output json` for the region,
// template-versions.json `aws ec2 describe-launch-template-versions --output
// json`; the live ids are space-separated. Prints one line per image to
// delete: `<image-id> <snapshot-id>...`.
import { readFileSync } from "node:fs";

/**
 * The last `keep` distinct images a launch template launched, newest first.
 * @param {{ VersionNumber: number, LaunchTemplateData?: { ImageId?: string } }[]} versions
 */
export function launchedImages(versions, keep = 2) {
  const out = [];
  for (const v of [...versions].sort((a, b) => b.VersionNumber - a.VersionNumber)) {
    const id = v.LaunchTemplateData?.ImageId;
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= keep) break;
  }
  return out;
}

/**
 * @param {{ ImageId: string, CreationDate: string, State?: string,
 *   BlockDeviceMappings?: { Ebs?: { SnapshotId?: string } }[] }[]} images
 * @param {{ held?: Iterable<string> }} opts images that must stay
 * @returns {{ id: string, snapshots: string[] }[]} the images to delete, newest first
 */
export function imagesToPrune(images, { held = [] } = {}) {
  const keep = new Set(held);
  const newestFirst = [...images].sort((a, b) => Date.parse(b.CreationDate) - Date.parse(a.CreationDate));
  if (newestFirst[0]) keep.add(newestFirst[0].ImageId);
  return newestFirst
    .filter((i) => !keep.has(i.ImageId) && (i.State ?? "available") === "available")
    .map((i) => ({
      id: i.ImageId,
      snapshots: (i.BlockDeviceMappings ?? []).map((m) => m.Ebs?.SnapshotId).filter(Boolean),
    }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [imagesFile, versionsFile, live = "", keep = "2"] = process.argv.slice(2);
  const { Images = [] } = JSON.parse(readFileSync(imagesFile, "utf8"));
  const { LaunchTemplateVersions = [] } = JSON.parse(readFileSync(versionsFile, "utf8"));
  const launched = launchedImages(LaunchTemplateVersions, Math.max(Number(keep), 1));
  // No template history is no evidence of what is in use: delete nothing.
  if (launched.length === 0) process.exit(0);
  const held = [...launched, ...live.split(/\s+/).filter(Boolean)];
  for (const { id, snapshots } of imagesToPrune(Images, { held })) {
    process.stdout.write(`${[id, ...snapshots].join(" ")}\n`);
  }
}
