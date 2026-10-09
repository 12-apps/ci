import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const path = '.github/workflows/monorepo-tests.yml';
const source = readFileSync(path, 'utf8');
const build = source.split('\n  build:\n')[1].split('\n  integration-plan:')[0];
const block = (text, name) => text.split(`      - name: ${name}\n`)[1].split(/\n      (?:- |#)/)[0];

test('shadow is declared, optional and off by default', () => {
  assert.match(source, /build-cache-index-shadow:\n(?:.*\n){1,4}        default: false/);
});
test('normal restore, Build and save retain their original gates, keys and commands', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/build-shadow-original.json', import.meta.url), 'utf8'));
  for (const name of ['Restore turbo cache', 'Build', 'Save turbo cache', 'Record the lane verdict']) {
    const old = baseline[name], current = block(build, name).replace('        id: build-cache\n', '');
    assert.equal(current, old, name);
  }
});
test('all advisory steps are opted in, verdict gated, warning only and bounded to four minutes', () => {
  const names = ['Check the Build shadow inventory baseline', 'Observe the current Build index and tiny transport', 'Observe the normal Build producer inventory'];
  const bounds = [1, 2, 1];
  names.forEach((name, i) => {
    const step = block(build, name);
    assert.match(step, /inputs\.build-cache-index-shadow && steps\.lane-verdict\.outputs\.hit != 'true'/);
    assert.match(step, /continue-on-error: true/);
    assert.match(step, new RegExp(`timeout-minutes: ${bounds[i]}`));
  });
  assert.equal(build.match(/turbo-index-shadow@c61be55976bf4d266e6aae1af2ab8a58d3cfc8c1/g)?.length, 2);
});
test('ordinary Build cannot consume any advisory decision', () => {
  assert.doesNotMatch(block(build, 'Build') + block(build, 'Restore turbo cache') + block(build, 'Save turbo cache'), /shadow|index/);
});
test('self tests actually call the added action controls', () => {
  assert.match(readFileSync('.github/workflows/self-test.yml', 'utf8'), /node --test \.github\/actions\/turbo-index-shadow\/__tests__\/\*\.test\.mjs/);
});
