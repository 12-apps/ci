import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RUNNER_PLATFORM, storePackages } from "../pnpm-store-packages.mjs";

// The warm store holds what this list names, so a package the parser misses is
// downloaded by every job, and a spec it gets wrong fails the image build.

const lockfile = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      lodash:
        specifier: 4.17.21
        version: 4.17.21

packages:

  '@12-apps/state-api@1.4.0':
    resolution: {integrity: sha512-a}

  '@babel/core@7.26.0':
    resolution: {integrity: sha512-b}

  lodash@4.17.21:
    resolution: {integrity: sha512-c}

  local-thing@file:packages/local:
    resolution: {directory: packages/local, type: directory}

  typescript@5.6.3:
    resolution: {integrity: sha512-d}
    engines: {node: '>=14.17'}

snapshots:

  lodash@4.17.21: {}

  '@babel/core@7.26.0(supports-color@8.1.1)': {}
`;

test("lists every registry package, scoped or not, and nothing from snapshots", () => {
  assert.deepEqual(storePackages(lockfile), ["@12-apps/state-api@1.4.0", "@babel/core@7.26.0", "lodash@4.17.21", "typescript@5.6.3"]);
});

test("a skipped scope stays out: its packages need a credential the image does not carry", () => {
  assert.deepEqual(storePackages(lockfile, { skipScopes: ["@12-apps"] }), ["@babel/core@7.26.0", "lodash@4.17.21", "typescript@5.6.3"]);
});

const natives = `packages:

  '@esbuild/darwin-arm64@0.25.12':
    resolution: {integrity: sha512-e}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [darwin]

  '@esbuild/linux-x64@0.25.12':
    resolution: {integrity: sha512-f}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-linux-x64-musl@4.40.0':
    resolution: {integrity: sha512-g}
    cpu: [x64]
    os: [linux]
    libc: [musl]

  '@rollup/rollup-linux-x64-gnu@4.40.0':
    resolution: {integrity: sha512-h}
    cpu: [x64]
    os: [linux]
    libc: [glibc]

  fsevents@2.3.3:
    resolution: {integrity: sha512-i}
    os: [darwin]

  not-on-windows@1.0.0:
    resolution: {integrity: sha512-j}
    os: ['!win32']

  local-native@file:packages/native:
    resolution: {directory: packages/native, type: directory}
    os: [darwin]

  lodash@4.17.21:
    resolution: {integrity: sha512-c}
`;

test("for the runner's platform, another platform's native binary stays out", () => {
  assert.deepEqual(storePackages(natives, { platform: RUNNER_PLATFORM }), [
    "@esbuild/linux-x64@0.25.12", "@rollup/rollup-linux-x64-gnu@4.40.0", "not-on-windows@1.0.0", "lodash@4.17.21",
  ]);
});

test("with no platform every binary is listed, and a platform field never sticks to the next package", () => {
  assert.equal(storePackages(natives).length, 7);
  assert.deepEqual(storePackages(natives, { platform: { os: "win32", cpu: "x64", libc: "glibc" } }), ["lodash@4.17.21"]);
});
