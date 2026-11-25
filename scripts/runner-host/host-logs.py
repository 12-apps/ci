#!/usr/bin/env python3
"""Ship the few host log lines that explain a lost runner to CloudWatch Logs.

    python3 /opt/ci-runner/host-logs.py        (ci-runner-logs.service, install.sh)

A fleet host that dies (a spot reclaim, a crash, its own power-off) takes its
journal with it, and AWS records nothing for a host that shuts itself down
(FUT-5281). So while the host runs, this ships a FILTERED part of its journal
to the log group CI_RUNNER_LOG_GROUP (default /ci-runner/hosts) in the host's
own region, one stream per instance, named by its instance id:

- kernel lines that kill or stall a job: the OOM killer, hung tasks, a full
  disk, I/O errors, lockups (the bridge and veth chatter of every container is
  dropped);
- the kit's own units: every ci-runner@N slot (the supervisor's registrations,
  jobs, failures and the `_diag` tail of a job that ended without a result),
  the image, credential, prewarm and idle-stop units, minus the idle timer's
  once-a-minute start and finish;
- each slot's runner output (the container's journald tag ci-runner-N);
- the lifecycle of docker and containerd as systemd tells it (a daemon
  restart cost both slots' jobs on 2026-11-17);
- the shutdown path: the power key, logind's "powering down", systemd's
  shutdown targets, and, on stop, the shutdown job systemd has queued;
- an EC2 spot interruption notice or rebalance recommendation, read from the
  instance metadata every poll.

Why a script and not an agent: it is python3's standard library alone, which
the Ubuntu image already carries for cloud-init, so the image gains no
package, no third-party apt repository and no daemon of its own, and the rule
that packages never change on a running host is untouched. The journal is read
by `journalctl --after-cursor` every CI_RUNNER_LOGS_INTERVAL seconds (5), so
a sudden death loses at most those seconds. Credentials are the instance
profile's, from the metadata service, refreshed before they expire.

The interesting lines are the LAST ones, so stopping is a flush: systemd stops
this unit after every runner slot (ci-runner@.service is After= it) and before
the network (it is After=network-online.target), and on SIGTERM it reads the
journal once more, names the shutdown job, ships, and exits.

No secret reaches a line: the JIT config never reaches a log (supervisor.sh),
and every line is scrubbed of token shapes anyway. Cost is capped here rather
than hoped for: repeats within 5 minutes are counted instead of shipped, and
ordinary lines draw on a byte allowance (CI_RUNNER_LOGS_HOURLY_BYTES, 64 KiB an
hour); the critical ones (kernel, shutdown, spot, `_diag`) have their own
(CI_RUNNER_LOGS_CRITICAL_BYTES, 32 KiB a boot). README.md, "Host logs after the
host is gone".

A failure here never touches a job: a slot only Wants= this unit, and an
unreachable CloudWatch keeps the lines buffered (512 KiB at most) for the next
poll. Off EC2 (no instance metadata) or with CI_RUNNER_LOG_GROUP=off it exits 0
and stays down.

Test seams: CI_RUNNER_LOGS_IMDS (metadata base URL), CI_RUNNER_LOGS_ENDPOINT
(CloudWatch Logs URL), CI_RUNNER_LOGS_JOURNALCTL, CI_RUNNER_LOGS_SYSTEMCTL,
CI_RUNNER_LOGS_STATE_DIR (default /run/ci-runner-logs: one boot, one cursor,
never baked into an image), CI_RUNNER_LOGS_INTERVAL.
"""

import datetime
import hashlib
import hmac
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# ── what is kept ─────────────────────────────────────────────────────────────

OUR_UNIT = re.compile(r"^ci-runner(@\d+|-[a-z]+)?\.service$")
SLOT_UNIT = re.compile(r"^ci-runner@\d+\.service$")
DAEMON_UNITS = {"docker.service", "containerd.service"}
SLOT_TAG = re.compile(r"^ci-runner-\d+$")
SYSTEMD_IDENTS = {"systemd", "systemd-logind", "systemd-shutdown"}
KERNEL = re.compile(
    r"out of memory|oom[-_ ]kill|killed process|invoked oom-killer|hung_task|blocked for more than"
    r"|no space left|ext4-fs (error|warning)|i/o error|soft lockup|hard lockup|rcu\w* (detected )?stall"
    r"|kernel bug|bug: |kernel panic|general protection|segfault",
    re.I,
)
SHUTDOWN = re.compile(
    r"power key|powering (off|down)|power-?off|system is (powering down|rebooting|halting|going down)"
    r"|(reached|stopped) target .*(shutdown|power-?off|reboot|halt|final|multi-user)|shutting down"
    r"|received sig(term|int|rtmin)",
    re.I,
)
# What systemd says every minute about the idle timer's oneshot, and its peers.
ROUTINE = re.compile(r"^(Starting|Started|Finished) |Deactivated successfully|Consumed .* CPU time")
UNIT_TROUBLE = re.compile(r"fail|kill|exited|timed out|restart|watchdog|dump", re.I)
# The supervisor's own lines that only an abnormal end writes.
SUPERVISOR_CRITICAL = re.compile(r"\bdiag \S+: |ended with result: unknown|exceeded \d+s|giving up the job|powering off")


def message_of(entry):
    """MESSAGE is a string, or a list of bytes for one that is not UTF-8."""
    m = entry.get("MESSAGE", "")
    if isinstance(m, list):
        m = bytes(b & 0xFF for b in m if isinstance(b, int)).decode("utf-8", "replace")
    return str(m or "").rstrip()


def select(entry):
    """`(source, text, critical)` for a journal entry worth shipping, else None."""
    text = message_of(entry)
    if not text:
        return None
    unit = entry.get("_SYSTEMD_UNIT", "")
    ident = entry.get("SYSLOG_IDENTIFIER", "")
    tag = entry.get("CONTAINER_TAG", "") or ident
    if entry.get("_TRANSPORT") == "kernel":
        try:
            crit = int(entry.get("PRIORITY", "6")) <= 2
        except ValueError:
            crit = False
        return ("kernel", text, True) if (crit or KERNEL.search(text)) else None
    if OUR_UNIT.match(unit):
        return (unit[: -len(".service")], text, bool(SUPERVISOR_CRITICAL.search(text)))
    if SLOT_TAG.match(entry.get("CONTAINER_TAG", "")) or (SLOT_TAG.match(ident) and unit == "docker.service"):
        return (tag, text, False)
    if ident in SYSTEMD_IDENTS:
        about = entry.get("UNIT", "")
        if OUR_UNIT.match(about) or about in DAEMON_UNITS:
            if "Consumed " in text and not SLOT_UNIT.match(about):
                return None
            if ROUTINE.search(text) and not (SLOT_UNIT.match(about) or about in DAEMON_UNITS):
                return None
            return (ident, text, bool(SHUTDOWN.search(text) or UNIT_TROUBLE.search(text)))
        if SHUTDOWN.search(text):
            return (ident, text, True)
    return None


# ── no secret leaves the host ────────────────────────────────────────────────

SECRET_SHAPES = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|\bgh[pousr]_[A-Za-z0-9]{20,}"
    r"|\bgithub_pat_[A-Za-z0-9_]{20,}"
    r"|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*"
    r"|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"
    r"|(?i:(?:token|secret|password|authorization|jitconfig)[\"']?\s*[:=]\s*[\"']?)[^\s\"',;]+"
    r"|[A-Za-z0-9+/_=-]{64,}"
)
MAX_LINE = 1000


def scrub(text):
    """Every token-shaped run replaced, and the line kept to MAX_LINE characters."""
    out = SECRET_SHAPES.sub("<redacted>", text)
    return out if len(out) <= MAX_LINE else out[: MAX_LINE - 1] + "…"


# ── repeats and the byte allowance ───────────────────────────────────────────

EVENT_OVERHEAD = 26  # CloudWatch bills each event's UTF-8 bytes plus 26


# A repeat is the same line but for its leading time stamp and its long
# numbers (epochs in runner names, PIDs, addresses); short ones (a shard's
# "2/4") still tell two lines apart.
LEADING_TIME = re.compile(r"^\d{4}-\d\d-\d\d[ T][\d:.]+Z?:?\s*")
LONG_NUMBER = re.compile(r"\d{5,}")


class Gate:
    """Decides which selected lines are shipped: no repeat within `window`
    seconds of JOURNAL time (exact text for a critical line), and ordinary
    lines only while their allowance, `hourly_bytes` per hour of journal time,
    lasts. Journal time, not this process's clock: the first read of a boot,
    or one after an outage, takes many minutes of lines at once."""

    def __init__(self, hourly_bytes, critical_bytes, window=300.0):
        self.rate = hourly_bytes / 3600.0
        self.burst = float(hourly_bytes)
        self.allowance = float(hourly_bytes)
        self.critical_left = critical_bytes
        self.window = window
        self.last_tick = None
        self.seen = {}  # key -> (shipped_at, suppressed, the text shipped)
        self.capped_said = False

    def _key(self, source, text, critical):
        return (source, text if critical else LONG_NUMBER.sub("#", LEADING_TIME.sub("", text)))

    def admit(self, ts_ms, source, text, critical):
        """The lines to ship for this one: none, it, or a cap notice and it."""
        now = ts_ms / 1000.0
        if self.last_tick is not None and now > self.last_tick:
            self.allowance = min(self.burst, self.allowance + (now - self.last_tick) * self.rate)
        self.last_tick = now if self.last_tick is None else max(self.last_tick, now)
        key = self._key(source, text, critical)
        prev = self.seen.get(key)
        if prev and abs(now - prev[0]) < self.window:
            self.seen[key] = (prev[0], prev[1] + 1, prev[2])
            return []
        out = []
        plain = text
        if prev and prev[1]:
            text = f"{text} (and {prev[1]} like it in the {int(self.window)}s before, not shipped)"
        size = len(text.encode()) + len(source) + 2 + EVENT_OVERHEAD
        if critical:
            if self.critical_left < size:
                return []
            self.critical_left -= size
        elif self.allowance < size:
            if not self.capped_said:
                self.capped_said = True
                out.append(("host-logs", "hourly byte allowance reached: ordinary lines are dropped until it refills", True))
            return out
        else:
            self.allowance -= size
            # Said again only once the allowance has really refilled, not
            # for every line a trickle of refill lets through.
            if self.allowance > self.burst / 2:
                self.capped_said = False
        self.seen[key] = (now, 0, plain)
        if len(self.seen) > 5000:
            self.seen = {k: v for k, v in self.seen.items() if abs(now - v[0]) < self.window}
        out.append((source, text, critical))
        return out

    def pending_repeats(self):
        """At the final flush: one line per repeat still unreported."""
        out = []
        for (source, _), (_, n, text) in self.seen.items():
            if n:
                out.append((source, f"{text} (repeated {n} more times, not shipped)", False))
        return out


# ── AWS: instance metadata and a signed CloudWatch Logs call ─────────────────


def log(msg):
    print(f"host-logs: {msg}", file=sys.stderr, flush=True)


class Metadata:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.token = None
        self.token_at = 0.0
        self.creds = None

    def _token(self):
        if self.token and time.monotonic() - self.token_at < 3 * 3600:
            return self.token
        req = urllib.request.Request(f"{self.base}/latest/api/token", method="PUT",
                                     headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"})
        with urllib.request.urlopen(req, timeout=2) as r:
            self.token = r.read().decode()
        self.token_at = time.monotonic()
        return self.token

    def get(self, path):
        """The body at `path`, or None for a 404 (no spot notice, no role)."""
        req = urllib.request.Request(f"{self.base}/latest/{path}", headers={"X-aws-ec2-metadata-token": self._token()})
        try:
            with urllib.request.urlopen(req, timeout=2) as r:
                return r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def identity(self):
        """`(instance_id, region)`, or None off EC2."""
        try:
            return self.get("meta-data/instance-id"), self.get("meta-data/placement/region")
        except (OSError, urllib.error.URLError):
            return None

    def credentials(self):
        """The instance profile's credentials, fetched again 5 minutes before they expire."""
        if self.creds and self.creds["expires"] - time.time() > 300:
            return self.creds
        role = (self.get("meta-data/iam/security-credentials/") or "").split("\n")[0].strip()
        if not role:
            raise RuntimeError("the instance has no instance profile")
        c = json.loads(self.get(f"meta-data/iam/security-credentials/{role}"))
        expires = datetime.datetime.strptime(c["Expiration"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()
        self.creds = {"key": c["AccessKeyId"], "secret": c["SecretAccessKey"], "token": c.get("Token"), "expires": expires}
        return self.creds


def sign_v4(method, url, region, service, body, headers, creds, now=None):
    """AWS Signature Version 4 headers for one request with no query string."""
    u = urllib.parse.urlsplit(url)
    stamp = (now or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    day = stamp[:8]
    all_h = {k.lower(): str(v).strip() for k, v in headers.items()}
    all_h["host"] = u.netloc
    all_h["x-amz-date"] = stamp
    if creds.get("token"):
        all_h["x-amz-security-token"] = creds["token"]
    names = sorted(all_h)
    canonical = "\n".join([method, u.path or "/", "", "".join(f"{n}:{all_h[n]}\n" for n in names),
                           ";".join(names), hashlib.sha256(body).hexdigest()])
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = ("AWS4" + creds["secret"]).encode()
    for part in (day, region, service, "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    all_h["authorization"] = f"AWS4-HMAC-SHA256 Credential={creds['key']}/{scope}, SignedHeaders={';'.join(names)}, Signature={sig}"
    del all_h["host"]
    return all_h


class AwsError(Exception):
    def __init__(self, status, kind, message):
        super().__init__(f"{status} {kind}: {message[:200]}")
        self.kind = kind


class Logs:
    def __init__(self, endpoint, region, group, stream, creds):
        self.endpoint, self.region, self.group, self.stream, self.creds = endpoint, region, group, stream, creds

    def call(self, action, payload, timeout=5):
        body = json.dumps(payload).encode()
        headers = sign_v4("POST", self.endpoint, self.region, "logs", body,
                          {"content-type": "application/x-amz-json-1.1", "x-amz-target": f"Logs_20140328.{action}"}, self.creds())
        req = urllib.request.Request(self.endpoint, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                j = json.loads(raw)
            except ValueError:
                j = {}
            raise AwsError(e.code, str(j.get("__type", "")).split("#")[-1], str(j.get("message", raw))) from None

    def ensure_stream(self):
        try:
            self.call("CreateLogStream", {"logGroupName": self.group, "logStreamName": self.stream})
        except AwsError as e:
            if e.kind != "ResourceAlreadyExistsException":
                raise

    def put(self, events):
        """Ship `events` ([{timestamp, message}], in time order) in batches CloudWatch accepts."""
        batch, size = [], 0
        for ev in events:
            n = len(ev["message"].encode()) + EVENT_OVERHEAD
            if batch and (size + n > 1_000_000 or len(batch) >= 10_000 or ev["timestamp"] - batch[0]["timestamp"] > 23 * 3600 * 1000):
                self._put(batch)
                batch, size = [], 0
            batch.append(ev)
            size += n
        if batch:
            self._put(batch)

    def _put(self, batch):
        try:
            self.call("PutLogEvents", {"logGroupName": self.group, "logStreamName": self.stream, "logEvents": batch})
        except AwsError as e:
            if e.kind != "ResourceNotFoundException":
                raise
            self.ensure_stream()
            self.call("PutLogEvents", {"logGroupName": self.group, "logStreamName": self.stream, "logEvents": batch})


# ── the shipper ──────────────────────────────────────────────────────────────

FIELDS = "MESSAGE,PRIORITY,_TRANSPORT,_SYSTEMD_UNIT,UNIT,SYSLOG_IDENTIFIER,CONTAINER_TAG"
MAX_BUFFER = 512 * 1024


class Shipper:
    def __init__(self, env, meta, logs, gate):
        self.env, self.meta, self.logs, self.gate = env, meta, logs, gate
        self.state_dir = env.get("CI_RUNNER_LOGS_STATE_DIR", "/run/ci-runner-logs")
        self.journalctl = shlex.split(env.get("CI_RUNNER_LOGS_JOURNALCTL", "journalctl"))
        self.systemctl = shlex.split(env.get("CI_RUNNER_LOGS_SYSTEMCTL", "systemctl"))
        os.makedirs(self.state_dir, exist_ok=True)
        saved = self._load()
        self.cursor = saved.get("cursor")  # shipped up to here
        self.read_cursor = self.cursor  # read up to here
        self.last_ts = saved.get("last_ts", 0)  # the newest entry read, ms
        self.buffer = []  # [{timestamp, message, critical}]
        self.notices = set()
        self.failing_since = None

    def _load(self):
        try:
            with open(os.path.join(self.state_dir, "state.json")) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def _save(self):
        path = os.path.join(self.state_dir, "state.json")
        with open(path + ".tmp", "w") as f:
            json.dump({"cursor": self.cursor, "last_ts": self.last_ts}, f)
        os.replace(path + ".tmp", path)

    def add(self, ts_ms, source, text, critical):
        for s, t, c in self.gate.admit(ts_ms, source, scrub(text), critical):
            self.buffer.append({"timestamp": ts_ms, "message": f"{s}: {t}", "critical": c})

    def _journal(self):
        """`(returncode, stdout)` of one read after the cursor, or since the newest entry read."""
        cmd = [*self.journalctl, "-b", "--no-pager", "-o", "json", f"--output-fields={FIELDS}"]
        if self.read_cursor:
            cmd.append(f"--after-cursor={self.read_cursor}")
        elif self.last_ts:
            cmd.append(f"--since=@{self.last_ts // 1000}")
        run = subprocess.run(cmd, capture_output=True, timeout=30, check=False)
        return run.returncode, run.stdout

    def read_journal(self):
        try:
            rc, out = self._journal()
            if rc != 0 and self.read_cursor and not out:
                # A cursor journald no longer has (its files were rotated
                # away): go on from the newest entry read, never from the
                # boot's start.
                log("the saved journal cursor is gone; reading on from the last entry's time")
                self.read_cursor = None
                rc, out = self._journal()
        except (OSError, subprocess.TimeoutExpired) as e:
            log(f"journalctl could not be read: {e}")
            return
        for line in out.splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            self.read_cursor = entry.get("__CURSOR", self.read_cursor)
            picked = select(entry)
            if picked:
                try:
                    ts = int(entry.get("__REALTIME_TIMESTAMP", "0")) // 1000
                except ValueError:
                    ts = 0
                self.last_ts = max(self.last_ts, ts)
                self.add(ts or int(time.time() * 1000), *picked)

    def poll_metadata(self):
        """A spot interruption notice or a rebalance recommendation, once each."""
        for path, what in (("meta-data/spot/instance-action", "spot interruption notice"),
                           ("meta-data/events/recommendations/rebalance", "rebalance recommendation")):
            try:
                body = self.meta.get(path)
            except (OSError, urllib.error.URLError):
                continue
            if body and (path, body) not in self.notices:
                self.notices.add((path, body))
                self.add(int(time.time() * 1000), "host-logs", f"{what}: {body.strip()}", True)

    def shutdown_job(self):
        """The shutdown target systemd has queued (poweroff.target, reboot.target…), or None."""
        try:
            out = subprocess.run([*self.systemctl, "list-jobs", "--no-legend", "--plain"], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.TimeoutExpired):
            return None
        m = re.search(r"\b((?:poweroff|reboot|halt|kexec|shutdown)\.target)\b", out)
        return m.group(1) if m else None

    def flush(self, final=False):
        if final:
            for s, t, c in self.gate.pending_repeats():
                self.buffer.append({"timestamp": int(time.time() * 1000), "message": f"{s}: {scrub(t)}", "critical": c})
        if not self.buffer:
            if self.read_cursor != self.cursor:
                self.cursor = self.read_cursor
                self._save()
            return True
        events = sorted(self.buffer, key=lambda e: e["timestamp"])
        try:
            self.logs.put([{"timestamp": e["timestamp"], "message": e["message"]} for e in events])
        except Exception as e:  # noqa: BLE001 — nothing here may stop the shipper
            if self.failing_since is None:
                self.failing_since = time.monotonic()
                log(f"CloudWatch refused or did not answer ({e}); keeping {len(self.buffer)} line(s) for the next poll")
            self._trim()
            return False
        if self.failing_since is not None:
            log("CloudWatch answers again")
            self.failing_since = None
        self.buffer = []
        self.cursor = self.read_cursor
        self._save()
        return True

    def _trim(self):
        """Over MAX_BUFFER, the oldest ordinary lines go first, then the oldest of any."""
        size = sum(len(e["message"]) for e in self.buffer)
        i = 0
        while size > MAX_BUFFER and i < len(self.buffer):
            if not self.buffer[i]["critical"]:
                size -= len(self.buffer.pop(i)["message"])
            else:
                i += 1
        while size > MAX_BUFFER and self.buffer:
            size -= len(self.buffer.pop(0)["message"])


def main(env=os.environ):
    group = env.get("CI_RUNNER_LOG_GROUP", "/ci-runner/hosts")
    if group in ("", "off"):
        log("CI_RUNNER_LOG_GROUP is off; not shipping")
        return 0
    meta = Metadata(env.get("CI_RUNNER_LOGS_IMDS", "http://169.254.169.254"))
    ident = meta.identity()
    if not ident or not all(ident):
        log("no EC2 instance metadata; not shipping")
        return 0
    instance, region = ident
    endpoint = env.get("CI_RUNNER_LOGS_ENDPOINT", f"https://logs.{region}.amazonaws.com/")
    logs = Logs(endpoint, region, group, instance, meta.credentials)
    gate = Gate(int(env.get("CI_RUNNER_LOGS_HOURLY_BYTES", 64 * 1024)), int(env.get("CI_RUNNER_LOGS_CRITICAL_BYTES", 32 * 1024)))
    shipper = Shipper(env, meta, logs, gate)
    interval = float(env.get("CI_RUNNER_LOGS_INTERVAL", "5"))

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    try:
        logs.ensure_stream()
    except Exception as e:  # noqa: BLE001 — every put retries it
        log(f"the stream {group}/{instance} could not be created yet ({e}); retrying with every poll")
    shipper.add(int(time.time() * 1000), "host-logs", f"shipping to {group}/{instance} in {region}", False)
    while True:
        stopping = stop.is_set()
        shipper.read_journal()
        shipper.poll_metadata()
        if stopping:
            target = shipper.shutdown_job()
            what = f"shutdown job queued: {target}" if target else "no shutdown job queued (this unit alone was stopped)"
            shipper.add(int(time.time() * 1000), "host-logs", f"stopping; {what}", True)
            for attempt in range(3):
                if shipper.flush(final=attempt == 0):
                    break
                time.sleep(1)
            return 0
        shipper.flush()
        stop.wait(interval)


if __name__ == "__main__":
    sys.exit(main())
