#!/usr/bin/env node
/**
 * A paced caller (actions/cd-gate min_interval_minutes) must be able to turn off
 * the DigitalOcean deploy's "superseded" skip, and a deploy must run the compose
 * of the commit whose images it pins.
 *
 * Found on future-pay run 36489758795, the first paced deploy: it built its
 * images, then skipped the rollout because main had moved during the build
 * ("that commit's own deploy will ship it"). Under pacing that commit's run
 * WAITS up to X minutes, and with merges arriving faster than a build every run
 * would find itself superseded, so nothing would ever ship.
 *
 * Turning the skip off brings back what it also used to hide: the droplet reset
 * its compose to `origin/main` while pinning images to the run's sha. So the
 * remote now fetches the image sha itself.
 *
 * Usage: node --test .github/workflows/__tests__/deploy-paced.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const DO = read('deploy-digitalocean.yml');
const CD = read('cd.yml');

test('the superseded skip can be switched off, and is on by default', () => {
  assert.match(DO, /^ {6}skip_superseded:\n(?: {8}.*\n)*? {8}type: boolean\n {8}required: false\n {8}default: true$/m);
  assert.match(DO, /^ {8}if: github\.event_name == 'push' && inputs\.skip_superseded$/m);
});

test('cd.yml hands the switch through, on by default', () => {
  assert.match(CD, /^ {6}skip_superseded:\n(?: {8}.*\n)*? {8}type: boolean\n {8}required: false\n {8}default: true$/m);
  assert.match(CD, /^ {6}skip_superseded: \$\{\{ inputs\.skip_superseded \}\}$/m);
});

test("the droplet runs the compose of the images' own commit, not main's tip", () => {
  assert.match(DO, /^ {10}git fetch --depth 1 origin "\$IMAGE_TAG"$/m);
  assert.match(DO, /^ {10}git reset --hard FETCH_HEAD$/m);
  assert.doesNotMatch(DO, /^ {10}git reset --hard origin\/main$/m);
});
