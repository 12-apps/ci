import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const quality=readFileSync(new URL('../quality.yml',import.meta.url),'utf8');
const reliability=quality.slice(quality.indexOf('\n  e2e-reliability:'));
test('artifact inputs are declared, optional and disabled by default',()=>{
  for(const name of ['e2e-build-artifact-name','e2e-build-artifact-paths'])assert.match(quality,new RegExp(`${name}:\\n[\\s\\S]{0,300}?default: ''`));
});
test('Reliability publishes only after its successful build and before browser tests',()=>{
  const prepare=reliability.indexOf('- name: Pre-e2e setup'),publish=reliability.indexOf('- name: Publish immutable workspace build'),run=reliability.indexOf('- name: Re-run changed e2e specs');
  assert.ok(prepare>=0&&publish>prepare&&run>publish);
  const p=reliability.slice(publish,run);assert.match(p,/changed-specs\.outputs\.any == 'true'/);assert.doesNotMatch(p,/spa-e2e-plan/);
});
test('no-spec fast path and independent Reliability execution remain',()=>{
  assert.match(reliability,/no e2e specs changed vs base — skipping toolchain setup and reliability run/);
  assert.match(reliability,/pnpm test:e2e:reliability/);assert.match(reliability,/E2E_RELIABILITY_REPEAT: \$\{\{ inputs\.e2e-repeat \}\}/);
});
test('Reliability reports independently on failures as well as success',()=>{
  assert.match(reliability,/if: \$\{\{ always\(\) && steps\.changed-specs\.outputs\.any == 'true' \}\}/);
  assert.match(reliability,/name: e2e-reliability-report/);assert.doesNotMatch(reliability,/name: spa-e2e-report/);
});
