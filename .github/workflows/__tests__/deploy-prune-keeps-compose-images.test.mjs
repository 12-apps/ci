import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The DigitalOcean deploy's disk reclaim KEEPS the images the compose project
// names (FUT-3975).
//
// It was `docker system prune -af`, run before the pull: every image no
// running container used was deleted. The `tools` profile's services (migrate,
// demo-seed, …) only ever run as `compose run --rm`, so their images were
// deleted and pulled again in full on every deploy, even when not one layer had
// changed. That is what stopped 12-apps/future-pay from splitting its web image
// into a slim runner and a tools image whose dependency layer rarely moves.
//
// The reclaim stays BEFORE git and the pull: it exists because a pull on a full
// disk failed (2026-07-03), and a full disk fails git too. So the invariants:
//   1. what `docker compose --profile tools config --images` names survives;
//   2. every other unused image, the build cache, stopped containers, unused
//      networks and dangling layers still go;
//   3. with no compose project, or still short of disk afterwards, every unused
//      image goes, as before — disk wins over the cache;
//   4. it runs before the clone, the fetch and the pull.
//
// The function is taken out of the workflow and RUN against a fake `docker`
// that keeps an image store in a file, so what is pinned is what the box does.

const ROOT = path.join(fileURLToPath(new URL("../../../", import.meta.url)));
const WORKFLOW = readFileSync(path.join(ROOT, ".github/workflows/deploy-digitalocean.yml"), "utf8");

/** The remote script: the heredoc between `cat <<'REMOTE'` and `REMOTE`, de-indented. */
function remoteScript() {
  const lines = WORKFLOW.split("\n");
  const start = lines.findIndex((l) => /cat <<'REMOTE'\s*$/.test(l));
  assert.notEqual(start, -1, "the deploy no longer sends a REMOTE heredoc");
  const end = lines.findIndex((l, i) => i > start && l.trim() === "REMOTE");
  assert.notEqual(end, -1, "the REMOTE heredoc has no end");
  const body = lines.slice(start + 1, end);
  const indent = body.find((l) => l.trim()).match(/^\s*/)[0];
  return body.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trim())).join("\n");
}

/** `reclaim_disk() { … }`, from its opening line to the `}` at its own indent. */
function reclaimFunction() {
  const lines = remoteScript().split("\n");
  const start = lines.findIndex((l) => /^reclaim_disk\(\) \{\s*$/.test(l));
  assert.notEqual(start, -1, "the remote script no longer defines reclaim_disk()");
  const end = lines.findIndex((l, i) => i > start && l === "}");
  assert.notEqual(end, -1, "reclaim_disk() has no closing brace at its own indent");
  return lines.slice(start, end + 1).join("\n");
}

const LIVE = [
  ["sha256:web1", "ghcr.io/acme/app/web:r1"],
  ["sha256:tools1", "ghcr.io/acme/app/tools:r1"],
  ["sha256:pg16", "postgres:16"],
];
const STALE = [
  ["sha256:web0", "ghcr.io/acme/app/web:r0"],
  ["sha256:tools0", "ghcr.io/acme/app/tools:r0"],
  ["sha256:old", "ghcr.io/other/ns/web:latest"],
  ["sha256:dangling", "<none>:<none>"],
];
// As `config --images` prints them: refs as written in the compose file.
const NAMED = ["ghcr.io/acme/app/web:r1", "ghcr.io/acme/app/tools:r1", "docker.io/library/postgres:16"];

/**
 * Runs reclaim_disk against a fake docker. `inUse` are image IDs a running
 * container holds (`image rm` refuses them, as docker does without -f).
 */
function run({ app = true, freeMb = 20000, dopplerWorks = true, named = NAMED, inUse = ["sha256:web1", "sha256:pg16"] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "reclaim-"));
  const appDir = path.join(dir, "app");
  if (app) mkdirSync(appDir);
  const store = path.join(dir, "store");
  const log = path.join(dir, "calls");
  writeFileSync(store, [...LIVE, ...STALE].map(([id, ref]) => `${id} ${ref}`).join("\n") + "\n");
  writeFileSync(log, "");
  const script = `
set -euo pipefail
STORE=${JSON.stringify(store)}; LOG=${JSON.stringify(log)}; APP=${JSON.stringify(appDir)}
IN_USE=" ${inUse.join(" ")} "; NAMED=${JSON.stringify(named.join(" "))}; FREE_MB=${freeMb}
DOPPLER_TOKEN=dummy
id_of() { # ref or ID -> ID, with docker.io/library/ normalised away
  local r="\${1#docker.io/library/}"
  awk -v r="$r" '$1 == r || $2 == r { print $1; exit }' "$STORE"
}
docker() {
  echo "docker $*" >> "$LOG"
  case "$*" in
    "compose --profile tools config --images")
      [ "$PWD" = "$APP" ] || return 1
      printf '%s\\n' $NAMED ;;
    "image inspect --format {{.Id}} "*)
      local id; id=$(id_of "$5"); [ -n "$id" ] && echo "$id" ;;
    "image ls --no-trunc --format "*) cat "$STORE" ;;
    "image rm "*)
      local id; id=$(id_of "$3"); [ -n "$id" ] || return 1
      case "$IN_USE" in *" $id "*) return 1 ;; esac
      awk -v r="$3" '$1 != r && $2 != r' "$STORE" > "$STORE.n" && mv "$STORE.n" "$STORE" ;;
    "image prune -af")
      awk -v u="$IN_USE" 'index(u, " " $1 " ")' "$STORE" > "$STORE.n" && mv "$STORE.n" "$STORE" ;;
    "image prune -f")
      awk '$2 != "<none>:<none>"' "$STORE" > "$STORE.n" && mv "$STORE.n" "$STORE" ;;
    "info --format {{.DockerRootDir}}") echo /var/lib/docker ;;
    *) : ;;
  esac
}
doppler() { echo "doppler $*" >> "$LOG"; [ ${dopplerWorks ? 1 : 0} = 1 ] || return 1; shift 2; "$@"; }
df() { printf 'Filesystem 1048576-blocks Used Available Capacity Mounted on\\n/dev/vda1 25000 1 %s 1%% /\\n' "$FREE_MB"; }
${reclaimFunction()}
reclaim_disk "$APP"
`;
  const out = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const left = readFileSync(store, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ")[1]);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, left, calls };
}

test("the images the compose file names survive, the tools profile's included", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  for (const [, ref] of LIVE) assert.ok(r.left.includes(ref), `${ref} was removed:\n${r.left.join("\n")}`);
  assert.ok(r.calls.includes("docker compose --profile tools config --images"), "the keep list must come from the tools profile, the one the deploy pulls");
  assert.match(r.stdout, /keeping the 3 image\(s\)/);
});

test("disk is still reclaimed: older tags, other namespaces, dangling layers, cache", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  for (const [, ref] of STALE) assert.ok(!r.left.includes(ref), `${ref} survived the reclaim`);
  for (const c of ["docker container prune -f", "docker network prune -f", "docker builder prune -af", "docker image prune -f"]) {
    assert.ok(r.calls.includes(c), `the reclaim no longer runs \`${c}\``);
  }
  assert.ok(!r.calls.includes("docker image prune -af"), "with room to spare the kept images must not be pruned");
  assert.ok(!r.calls.some((c) => /^docker system prune/.test(c)), "`docker system prune` deletes the tools images again");
});

test("without Doppler the file is still read, so a box with no CLI yet keeps its images", () => {
  const r = run({ dopplerWorks: false });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.left.includes("ghcr.io/acme/app/tools:r1"));
});

test("with no compose project nothing is kept: every unused image goes, as before", () => {
  const r = run({ app: false });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.left.sort(), ["ghcr.io/acme/app/web:r1", "postgres:16"], "only images a container uses may remain");
});

test("an unreadable compose file fails safe the same way", () => {
  const r = run({ named: [] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.left.includes("ghcr.io/acme/app/tools:r1"));
});

test("still short of disk afterwards, every unused image goes and the deploy says so", () => {
  const r = run({ freeMb: 100 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.includes("docker image prune -af"));
  assert.deepEqual(r.left.sort(), ["ghcr.io/acme/app/web:r1", "postgres:16"]);
  assert.match(r.stdout, /::warning::only 100 MB free/);
});

test("the reclaim runs first: before the clone, the fetch and the pull", () => {
  const lines = remoteScript().split("\n");
  const at = (re, what) => {
    const i = lines.findIndex((l) => !/^\s*#/.test(l) && re.test(l));
    assert.notEqual(i, -1, `the remote script has no ${what}`);
    return i;
  };
  const reclaim = at(/^reclaim_disk \/app\s*$/, "`reclaim_disk /app` call");
  assert.ok(reclaim < at(/git clone/, "git clone"), "the reclaim must run before git writes anything");
  assert.ok(reclaim < at(/git fetch/, "git fetch"));
  assert.ok(reclaim < at(/docker compose --profile tools pull/, "pull"), "the pull needs the room the reclaim makes");
});

test("nothing else in the deploy prunes every unused image unconditionally", () => {
  const body = reclaimFunction().split("\n");
  const outside = remoteScript()
    .split("\n")
    .filter((l) => !body.includes(l))
    .filter((l) => !/^\s*#/.test(l) && /docker (system|image) prune/.test(l));
  assert.deepEqual(outside, [], "a prune outside reclaim_disk() would delete the kept images");
  const all = body.filter((l) => /docker image prune -af/.test(l));
  assert.equal(all.length, 1, "exactly one prune -af, the low-disk fallback");
  const guard = body.findIndex((l) => /-lt "\$min_free_mb"/.test(l));
  assert.ok(guard !== -1 && body.indexOf(all[0]) > guard, "the prune -af must sit inside the low-disk branch");
});
