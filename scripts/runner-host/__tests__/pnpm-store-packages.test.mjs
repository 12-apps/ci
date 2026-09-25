import { strict as assert } from "node:assert";
import { test } from "node:test";
import { storePackages } from "../pnpm-store-packages.mjs";

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
