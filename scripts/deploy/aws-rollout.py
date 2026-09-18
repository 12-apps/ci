"""Private SSM container rollout. Input is public deployment metadata, not secrets.

Do not add subprocess output, environment dumps, docker logs or tracebacks to
this script: SSM retains stdout/stderr. Only allowlisted status objects leave it.
"""
import base64
import fcntl
import http.client
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


class RolloutError(Exception):
    pass


class Rollout:
    def __init__(self, config):
        self.config = config
        self.name = config["container"]
        self.previous = self.name + "-previous"
        self.displaced = self.name + "-rollback-displaced"
        self.drained = False
        self.temporary = None
        self.attempt = uuid.uuid4().hex
        self.rollback_candidate = None

    def command(self, arguments, data=None, timeout=30):
        try:
            result = subprocess.run(arguments, input=data, text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise RolloutError("Required host command failed or timed out; private output suppressed.")
        if result.returncode != 0:
            raise RolloutError("Host operation failed; private output suppressed.")
        return result.stdout

    def names(self):
        # Only a successful Docker inventory can establish absence. Never turn
        # a daemon/permission/transient inspect error into "no old controller".
        names = self.command(["docker", "container", "ls", "--all", "--format", "{{.Names}}"])
        values = names.splitlines()
        if len(values) > 100 or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name) for name in values):
            raise RolloutError("Controller Docker inventory is invalid or unexpectedly large.")
        return values

    def raw_inspect(self, name):
        result = self.command(["docker", "inspect", "--type", "container", name])
        try:
            value = json.loads(result)[0]
            if not isinstance(value, dict) or not value.get("Id") or value.get("Name") != "/" + name:
                raise ValueError()
            return value
        except (ValueError, IndexError, TypeError):
            raise RolloutError("Container inspection returned an invalid result.")

    def inspect(self, name):
        if name not in self.names():
            return None
        value = self.raw_inspect(name)
        labels = value.get("Config", {}).get("Labels", {}) or {}
        if labels.get("ci.12-apps.managed") != "true" or labels.get("ci.12-apps.stack") != self.config["stack"]:
            raise RolloutError("Container name belongs to an unmanaged or different-stack resource.")
        if not value.get("Config", {}).get("Image", "").startswith(self.config["registry"] + "/"):
            raise RolloutError("Existing container image is outside the authorized ECR registry.")
        return value

    def validate_controllers(self):
        allowed = {self.name, self.previous, self.displaced}
        directory = os.path.realpath(self.config["mount"])
        for name in self.names():
            value = self.raw_inspect(name)
            if name in allowed:
                continue  # The transition separately verifies these owners/states.
            labels = value.get("Config", {}).get("Labels", {}) or {}
            overlaps = False
            for mount in value.get("Mounts", []):
                source = mount.get("Source")
                if isinstance(source, str) and os.path.isabs(source):
                    source = os.path.realpath(source)
                    overlaps = overlaps or os.path.commonpath([directory, source]) in [directory, source]
            if labels.get("ci.12-apps.stack") == self.config["stack"] or overlaps:
                raise RolloutError("Another controller/container uses this stack or overlaps its data mount. Refusing concurrent access.")

    def http(self, method, route):
        connection = http.client.HTTPConnection("127.0.0.1", self.config["port"], timeout=5)
        try:
            connection.request(method, route, headers={"Content-Length": "0"} if method == "POST" else {})
            response = connection.getresponse()
            body = response.read(65_537)
            if response.status != 200 or len(body) > 65_536:
                return False
            value = json.loads(body)
            return isinstance(value, dict) and value.get("ok") is True
        except (OSError, ValueError, http.client.HTTPException):
            return False
        finally:
            connection.close()

    def ready(self):
        deadline = time.monotonic() + self.config["timeout"]
        while time.monotonic() < deadline:
            container = self.inspect(self.name)
            if container and container.get("State", {}).get("Running") and self.http("GET", self.config["health"]):
                return True
            time.sleep(2)
        return False

    def stop(self, name):
        self.command(["docker", "stop", "--time", "120", name], timeout=150)
        if self.inspect(name).get("State", {}).get("Running"):
            raise RolloutError("Controller did not stop. Refusing to run two controllers against the same data.")

    def drain(self, current):
        if current and current.get("State", {}).get("Running"):
            if not self.http("POST", "/internal/deploy/drain"):
                raise RolloutError("Controller is busy or cannot safely drain. Existing container was not stopped.")
            self.drained = True

    def validate_mount(self):
        marker = pathlib.Path(self.config["readyFile"])
        if not marker.is_file() or marker.is_symlink() or marker.stat().st_uid != 0:
            raise RolloutError("Controller bootstrap has not completed its verified data-volume setup.")
        directory = pathlib.Path(self.config["mount"])
        if not directory.is_dir() or directory.is_symlink() or str(directory.resolve()) != str(directory):
            raise RolloutError("Persistent data directory must already exist and cannot contain symlinks.")
        if directory.stat().st_uid != 1000:
            raise RolloutError("Persistent data directory must be owned by application UID 1000.")
        mounted = json.loads(self.command(["findmnt", "--json", "--target", str(directory), "--output", "SOURCE,TARGET"]))["filesystems"][0]
        if mounted["target"] == "/":
            raise RolloutError("Persistent data directory is not on a separate mounted data filesystem.")
        serials = self.command(["lsblk", "--inverse", "--noheadings", "--output", "SERIAL", mounted["source"]])
        expected = self.config["volume"].replace("-", "")
        if expected not in [serial.strip().replace("-", "") for serial in serials.splitlines()]:
            raise RolloutError("Mounted data filesystem does not match the stack's encrypted EBS volume.")

    def prepare(self):
        self.temporary = tempfile.mkdtemp(prefix="12-apps-rollout-", dir="/run")
        os.chmod(self.temporary, 0o700)
        docker_config = os.path.join(self.temporary, "docker")
        os.mkdir(docker_config, 0o700)
        password = self.command(["aws", "--region", self.config["region"], "--no-cli-pager", "ecr", "get-login-password"], timeout=30)
        self.command(["docker", "--config", docker_config, "login", "--username", "AWS", "--password-stdin", self.config["registry"]], data=password, timeout=30)
        self.command(["docker", "--config", docker_config, "pull", self.config["image"]], timeout=600)
        secret = json.loads(self.command(["aws", "--region", self.config["region"], "--no-cli-pager", "secretsmanager", "get-secret-value", "--secret-id", self.config["secret"], "--output", "json"], timeout=30))
        values = json.loads(secret.get("SecretString", "null"))
        if not isinstance(values, dict) or not values:
            raise RolloutError("Application secret must be a nonempty JSON object of environment strings.")
        for key, value in values.items():
            if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key) or not isinstance(value, str) or any(character in value for character in ["\n", "\r", "\0"]):
                raise RolloutError("Application secret has an invalid environment key or multiline value.")
        envfile = os.path.join(self.temporary, "application.env")
        descriptor = os.open(envfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            for key, value in values.items():
                stream.write(key + "=" + value + "\n")
        return envfile

    def start(self, envfile):
        self.command(["docker", "run", "--detach", "--name", self.name,
                      "--label", "ci.12-apps.managed=true", "--label", "ci.12-apps.stack=" + self.config["stack"],
                      "--label", "ci.12-apps.attempt=" + self.attempt,
                      "--restart", "unless-stopped", "--network", "host", "--user", "1000:1000",
                      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                      "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
                      "--mount", "type=bind,src=" + self.config["mount"] + ",dst=" + self.config["destination"],
                      "--env-file", envfile, self.config["image"]], timeout=60)

    def recover(self, original, preserve_candidate=False):
        """Locate the original by Docker ID, including ambiguous rename outcomes."""
        current = self.inspect(self.name)
        if not original:
            if current:
                if current.get("Config", {}).get("Labels", {}).get("ci.12-apps.attempt") != self.attempt:
                    raise RolloutError("Unexpected container appeared during deployment; manual inspection is required.")
                self.command(["docker", "rm", "--force", self.name], timeout=150)
            return False
        states = {name: self.inspect(name) for name in [self.name, self.previous, self.displaced]}
        original_name = next((name for name, state in states.items() if state and state.get("Id") == original["Id"]), None)
        if not original_name:
            raise RolloutError("Original container is missing; manual recovery is required.")
        if current and current.get("Id") != original["Id"]:
            if preserve_candidate:
                if current.get("Id") != self.rollback_candidate:
                    raise RolloutError("Unexpected rollback candidate; manual inspection is required.")
                available = next((name for name in [self.previous, self.displaced] if not states[name]), None)
                if not available:
                    raise RolloutError("No safe recovery slot is available; manual inspection is required.")
                if current.get("State", {}).get("Running"):
                    self.stop(self.name)
                self.command(["docker", "rename", self.name, available])
            else:
                if current.get("Config", {}).get("Labels", {}).get("ci.12-apps.attempt") != self.attempt:
                    raise RolloutError("Unexpected container appeared during deployment; manual inspection is required.")
                self.command(["docker", "rm", "--force", self.name], timeout=150)
        if original_name != self.name:
            self.command(["docker", "rename", original_name, self.name])
        if not self.inspect(self.name).get("State", {}).get("Running"):
            self.command(["docker", "start", self.name])
        # A failed final rename may have used the temporary slot for the candidate.
        if preserve_candidate and self.inspect(self.displaced) and not self.inspect(self.previous):
            self.command(["docker", "rename", self.displaced, self.previous])
        # A live original may still be drained (e.g. stop/rename failed). Its
        # readiness intentionally remains 503 until admission is resumed.
        if self.drained and self.http("POST", "/internal/deploy/resume"):
            self.drained = False
        return self.ready()

    def deploy(self):
        current = self.inspect(self.name)
        previous = self.inspect(self.previous)
        if self.inspect(self.displaced):
            raise RolloutError("An interrupted rollback needs inspection before deploying again.")
        if previous and previous.get("State", {}).get("Running"):
            raise RolloutError("Previous controller is unexpectedly running; inspect before deploying.")
        if not current and previous:
            raise RolloutError("Interrupted deployment has a retained previous container. Recover it before a new deploy.")
        envfile = self.prepare()  # Pull and validate secrets before draining traffic.
        self.drain(current)
        try:
            if previous:
                self.command(["docker", "rm", self.previous])
            if current:
                self.stop(self.name)
                self.command(["docker", "rename", self.name, self.previous])
            self.start(envfile)
            if not self.ready():
                raise RolloutError("New container did not become ready.")
        except Exception:
            restored = self.recover(current)
            raise RolloutError("New container failed readiness. " + ("Previous container is healthy again." if restored else "No healthy previous container could be restored; manual inspection is required."))
        return {"ok": True, "action": "deploy", "image": self.config["image"], "previousRetained": bool(current)}

    def rollback(self):
        current = self.inspect(self.name)
        previous = self.inspect(self.previous)
        if not previous or previous.get("State", {}).get("Running"):
            raise RolloutError("A stopped, stack-owned previous container is required for rollback.")
        self.rollback_candidate = previous["Id"]
        if self.inspect(self.displaced):
            raise RolloutError("An interrupted rollback needs manual inspection.")
        self.drain(current)
        try:
            if current:
                self.stop(self.name)
                self.command(["docker", "rename", self.name, self.displaced])
            self.command(["docker", "rename", self.previous, self.name])
            self.command(["docker", "start", self.name])
            if not self.ready():
                raise RolloutError("Rollback container did not become ready.")
            if current:
                self.command(["docker", "rename", self.displaced, self.previous])
        except Exception:
            restored = self.recover(current, preserve_candidate=True) if current else False
            raise RolloutError("Rollback failed. " + ("Original container is healthy again." if restored else "Manual recovery is required."))
        return {"ok": True, "action": "rollback", "image": previous["Config"]["Image"]}

    def run(self):
        self.validate_mount()
        self.validate_controllers()
        try:
            return self.deploy() if self.config["action"] == "deploy" else self.rollback()
        finally:
            if self.drained:
                # Harmless after replacement; essential if a pre-stop operation failed.
                self.http("POST", "/internal/deploy/resume")
            if self.temporary:
                shutil.rmtree(self.temporary)


def main():
    os.umask(0o077)
    try:
        config = json.loads(base64.b64decode(sys.argv[1], validate=True))
        # Serialize the entire controller host, not caller-selected names: a
        # renamed controller must never get a second writer to the same EBS.
        lock_path = "/run/12-apps-controller-rollout.lock"
        with open(lock_path, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = Rollout(config).run()
            print(json.dumps(result))
    except RolloutError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1
    except Exception:
        print(json.dumps({"ok": False, "error": "Rollout could not complete. Inspect the deployment state; private output suppressed."}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
