/* global process */
/**
 * Was this module the script node was asked to run?
 *
 * Compared by REAL path: an action checked out under a symlinked or
 * percent-encodable directory makes a plain `import.meta.url === file://argv[1]`
 * test false, `main()` silently never runs, and the step passes having done
 * nothing — the worst way for a monitor to break.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
