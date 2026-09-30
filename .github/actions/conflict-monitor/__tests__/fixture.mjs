/**
 * Throwaway git repositories, built at test time.
 *
 * Every conflict shape the monitor classifies is produced here by real git
 * commands rather than by hand-written merge output: the thing under test is
 * how the classifier reads what git actually prints, so the fixture must be
 * git's own output.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { git } from "../lib/git.mjs";

export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "conflict-monitor-"));
  const run = (...args) => git(args, { cwd: dir }).out.trim();
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Fixture");
  run("config", "user.email", "fixture@example.invalid");
  run("config", "commit.gpgsign", "false");
  const repo = {
    dir,
    git: run,
    write(files) {
      for (const [path, content] of Object.entries(files)) {
        const abs = join(dir, path);
        if (content === null) {
          rmSync(abs, { force: true });
          continue;
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    },
    /** Write files, commit them, return the new commit. */
    commit(message, files = {}) {
      repo.write(files);
      run("add", "-A");
      run("commit", "-q", "--allow-empty", "-m", message);
      return run("rev-parse", "HEAD");
    },
    checkout(ref, create = false) {
      if (create) run("checkout", "-q", "-b", ref);
      else run("checkout", "-q", ref);
    },
    /** Merge `ref` into the current branch, resolving any conflict with `files`. */
    mergeResolving(ref, files = {}, message = `Merge ${ref}`) {
      git(["merge", "--no-ff", "--no-commit", ref], { cwd: dir, ok: [0, 1] });
      repo.write(files);
      run("add", "-A");
      run("commit", "-q", "--no-edit", "-m", message);
      return run("rev-parse", "HEAD");
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return repo;
}

export const lines = (...l) => l.join("\n") + "\n";
