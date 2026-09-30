// A successful-result cache is evidence about an implementation and runtime,
// not just the consumer's tree. Resolve the central sources from THIS module:
// reusable workflows execute in the consumer checkout, which is not 12-apps/ci.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Never reuse entries written before failure-preserving shells and complete
// selection context were introduced. All success-result caches share this era.
export const VERDICT_SCHEMA = "ci-verdict-v2";

const SOURCE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function implementationHash(sourceRoot = SOURCE_ROOT) {
  const hash = createHash("sha256");
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        hash.update(JSON.stringify([relative(sourceRoot, path), statSync(path).mode & 0o111, bytes.length]));
        hash.update(bytes);
      } else throw new Error(`unsupported implementation source: ${path}`);
    }
  }
  // Hash both: workflows can change enforcement without changing the action,
  // and an action at moving @v2 can change independently of the consumer tree.
  visit(join(sourceRoot, ".github", "actions"));
  visit(join(sourceRoot, ".github", "workflows"));
  return hash.digest("hex");
}

export function executionIdentity({
  sourceRoot = SOURCE_ROOT,
  consumerRoot = process.cwd(),
  env = process.env,
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return createHash("sha256").update(JSON.stringify({
    schema: VERDICT_SCHEMA,
    implementation: implementationHash(sourceRoot),
    // Workflow commits can advance without changing execution semantics. Hash
    // their actual blobs instead of GITHUB_WORKFLOW_SHA (which keys every push
    // separately and defeats reuse on content-identical reruns).
    callerWorkflows: execFileSync("git", ["ls-tree", "-r", "--full-tree", "HEAD", "--", ".github/workflows"], {
      cwd: consumerRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }),
    nodeVersion,
    platform,
    arch,
    runnerOS: env.RUNNER_OS ?? "",
    runnerArch: env.RUNNER_ARCH ?? "",
    runnerEnvironment: env.RUNNER_ENVIRONMENT ?? "",
    imageOS: env.ImageOS ?? "",
    imageVersion: env.ImageVersion ?? "",
  })).digest("hex");
}
