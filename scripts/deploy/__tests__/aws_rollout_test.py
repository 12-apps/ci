import copy
import importlib.util
import json
import pathlib
import os
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("rollout", pathlib.Path(__file__).parents[1] / "aws-rollout.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
IMAGE = "123456789012.dkr.ecr.us-east-1.amazonaws.com/app@sha256:"
CONFIG = {"action": "deploy", "container": "relay", "stack": "owned-stack", "image": IMAGE + "a" * 64,
          "registry": IMAGE.split("/")[0], "mount": "/srv/relay/data", "destination": "/var/lib/relay",
          "timeout": 10, "port": 8787, "health": "/readyz", "region": "us-east-1"}
CONFIG.update({"readyFile": "/var/lib/relay-controller-ready", "volume": "vol-1234567890abcdef0", "secret": "private-secret-reference"})


def container(image, running=True):
    return {"Id": image, "State": {"Running": running}, "Config": {"Image": image, "Env": ["SECRET=old-private-fixture"],
            "Labels": {"ci.12-apps.managed": "true", "ci.12-apps.stack": "owned-stack"}}}


class Fake(module.Rollout):
    def __init__(self):
        super().__init__(copy.deepcopy(CONFIG))
        self.containers = {"relay": container(IMAGE + "b" * 64)}
        self.events = []
        self.busy = False
        self.bad_image = None
        self.fail_start = False
        self.fail_once = None

    def command(self, args, data=None, timeout=180, optional=False):
        self.events.append(args)
        if self.fail_once == args:
            self.fail_once = None
            raise module.RolloutError("injected host failure")
        if args[:2] == ["docker", "inspect"]:
            return json.dumps([self.containers[args[-1]]]) if args[-1] in self.containers else None
        if args[:2] == ["docker", "stop"]:
            self.containers[args[-1]]["State"]["Running"] = False
        elif args[:2] == ["docker", "rename"]:
            self.containers[args[-1]] = self.containers.pop(args[-2])
        elif args[:2] == ["docker", "rm"]:
            self.containers.pop(args[-1])
        elif args[:2] == ["docker", "start"]:
            assert not any(value["State"]["Running"] for value in self.containers.values())
            self.containers[args[-1]]["State"]["Running"] = True
        elif args[:2] == ["docker", "run"]:
            assert not any(value["State"]["Running"] for value in self.containers.values())
            self.containers[self.name] = container(args[-1])
            if self.fail_start:
                raise module.RolloutError("start failed")
        else:
            raise AssertionError("Unexpected operation")
        return ""

    def validate_mount(self):
        pass

    def prepare(self):
        self.events.append(["prepare"])
        return "/private-test-env"

    def http(self, method, route):
        self.events.append([method, route])
        return not self.busy if route.endswith("drain") else True

    def ready(self):
        return self.containers[self.name]["Config"]["Image"] != self.bad_image


class Tests(unittest.TestCase):
    def test_bootstrap_and_exact_mounted_ebs_required_before_any_change(self):
        for mode in ["valid", "missing-marker", "wrong-marker-owner", "symlink", "wrong-owner", "root-disk", "wrong-volume"]:
            with self.subTest(mode=mode):
                marker = mock.MagicMock()
                marker.is_file.return_value = mode != "missing-marker"
                marker.is_symlink.return_value = False
                marker.stat.return_value.st_uid = 1000 if mode == "wrong-marker-owner" else 0
                directory = mock.MagicMock()
                directory.is_dir.return_value = True
                directory.is_symlink.return_value = mode == "symlink"
                directory.__str__.return_value = CONFIG["mount"]
                directory.resolve.return_value = CONFIG["mount"]
                directory.stat.return_value.st_uid = 0 if mode == "wrong-owner" else 1000
                rollout = module.Rollout(CONFIG)
                mounted = {"filesystems": [{"source": "/dev/nvme1n1", "target": "/" if mode == "root-disk" else "/srv/relay"}]}
                rollout.command = mock.Mock(side_effect=[json.dumps(mounted), "unrelated-volume" if mode == "wrong-volume" else "vol1234567890abcdef0\n"])
                with mock.patch.object(module.pathlib, "Path", side_effect=[marker, directory]):
                    if mode == "valid":
                        rollout.validate_mount()
                    else:
                        with self.assertRaises(module.RolloutError):
                            rollout.validate_mount()

    def test_secret_file_private_no_secret_in_command_arguments_and_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            private = pathlib.Path(directory) / "private"
            private.mkdir()
            rollout = module.Rollout(CONFIG)
            secret = "fake-sensitive-value-with-spaces-$()"
            calls = []
            def command(args, data=None, **kwargs):
                calls.append((args, data))
                if args[-1] == "get-login-password":
                    return "fake-ecr-password"
                if "get-secret-value" in args:
                    return json.dumps({"SecretString": json.dumps({"APP_SECRET": secret})})
                return ""
            rollout.command = command
            with mock.patch.object(module.tempfile, "mkdtemp", return_value=str(private)):
                envfile = rollout.prepare()
            self.assertEqual(os.stat(envfile).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(private).st_mode & 0o777, 0o700)
            self.assertEqual(pathlib.Path(envfile).read_text(), "APP_SECRET=" + secret + "\n")
            all_arguments = json.dumps([args for args, _ in calls])
            self.assertNotIn(secret, all_arguments)
            self.assertNotIn("fake-ecr-password", all_arguments)
            self.assertIn(("fake-ecr-password"), [data for _, data in calls])
            rollout.validate_mount = lambda: None
            rollout.deploy = mock.Mock(side_effect=module.RolloutError("injected failure"))
            with self.assertRaises(module.RolloutError):
                rollout.run()
            self.assertFalse(private.exists())

    def test_malformed_environment_is_rejected_before_old_controller_is_drained(self):
        for value in [{}, [], {"KEY": "multiline\nvalue"}, {"KEY": 123}, {"bad-key": "value"}]:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                private = pathlib.Path(directory) / "private"
                private.mkdir()
                fake = Fake()
                fake.prepare = lambda: module.Rollout.prepare(fake)
                original_command = fake.command
                def command(args, data=None, **kwargs):
                    if args[:2] == ["docker", "inspect"]:
                        return original_command(args)
                    if "get-secret-value" in args:
                        return json.dumps({"SecretString": json.dumps(value)})
                    return ""
                fake.command = command
                with mock.patch.object(module.tempfile, "mkdtemp", return_value=str(private)):
                    with self.assertRaises(module.RolloutError):
                        fake.run()
                self.assertNotIn(["POST", "/internal/deploy/drain"], fake.events)
                self.assertTrue(fake.containers["relay"]["State"]["Running"])
                self.assertFalse(private.exists())

    def test_single_controller_rollout_retains_exact_old_configuration(self):
        fake = Fake()
        original = copy.deepcopy(fake.containers["relay"])
        result = fake.run()
        self.assertTrue(result["ok"])
        original["State"]["Running"] = False
        self.assertEqual(fake.containers["relay-previous"], original)
        run = next(event for event in fake.events if event[:2] == ["docker", "run"])
        for flag in ["--cap-drop", "--security-opt", "--tmpfs", "--user", "--env-file"]:
            self.assertIn(flag, run)
        self.assertIn("1000:1000", run)
        self.assertIn(["POST", "/internal/deploy/resume"], fake.events)

    def test_busy_controller_never_stops(self):
        fake = Fake()
        fake.busy = True
        with self.assertRaisesRegex(module.RolloutError, "busy"):
            fake.run()
        self.assertFalse(any(event[:2] == ["docker", "stop"] for event in fake.events))
        self.assertTrue(fake.containers["relay"]["State"]["Running"])

    def test_unhealthy_new_image_restores_old_without_reporting_success(self):
        for failed_start in [False, True]:
            fake = Fake()
            fake.bad_image = CONFIG["image"]
            fake.fail_start = failed_start
            old = copy.deepcopy(fake.containers["relay"])
            with self.assertRaisesRegex(module.RolloutError, "Previous container is healthy"):
                fake.run()
            self.assertEqual(fake.containers["relay"], old)
            self.assertNotIn("relay-previous", fake.containers)

    def test_manual_rollback_restores_previous_digest_and_configuration(self):
        fake = Fake()
        fake.containers["relay-previous"] = container(IMAGE + "c" * 64, False)
        fake.config["action"] = "rollback"
        result = fake.run()
        self.assertEqual(result["image"], IMAGE + "c" * 64)
        self.assertEqual(fake.containers["relay-previous"]["Config"]["Image"], IMAGE + "b" * 64)
        self.assertTrue(fake.containers["relay"]["State"]["Running"])

    def test_transition_failures_restart_original_without_erasing_its_configuration(self):
        for action, failure in [
            ("deploy", ["docker", "stop", "--time", "120", "relay"]),
            ("deploy", ["docker", "rename", "relay", "relay-previous"]),
            ("rollback", ["docker", "rename", "relay", "relay-rollback-displaced"]),
            ("rollback", ["docker", "rename", "relay-previous", "relay"]),
            ("rollback", ["docker", "start", "relay"]),
            ("rollback", ["docker", "rename", "relay-rollback-displaced", "relay-previous"]),
        ]:
            with self.subTest(action=action, failure=failure):
                fake = Fake()
                original = copy.deepcopy(fake.containers["relay"])
                fake.config["action"] = action
                fake.containers["relay-previous"] = container(IMAGE + "c" * 64, False)
                fake.fail_once = failure
                with self.assertRaisesRegex(module.RolloutError, "healthy again"):
                    fake.run()
                self.assertEqual(fake.containers["relay"], original)
                self.assertEqual(sum(value["State"]["Running"] for value in fake.containers.values()), 1)

    def test_unhealthy_rollback_restores_original_and_retains_candidate(self):
        fake = Fake()
        original = copy.deepcopy(fake.containers["relay"])
        fake.config["action"] = "rollback"
        fake.bad_image = IMAGE + "c" * 64
        fake.containers["relay-previous"] = container(fake.bad_image, False)
        with self.assertRaisesRegex(module.RolloutError, "Original container is healthy"):
            fake.run()
        self.assertEqual(fake.containers["relay"], original)
        self.assertEqual(fake.containers["relay-previous"]["Config"]["Image"], fake.bad_image)

    def test_unmanaged_or_interrupted_containers_are_not_destroyed(self):
        for mode in ["unmanaged", "interrupted", "running-previous"]:
            fake = Fake()
            if mode == "unmanaged":
                fake.containers["relay"]["Config"]["Labels"] = {}
            elif mode == "interrupted":
                fake.containers["relay-rollback-displaced"] = container(IMAGE + "c" * 64, False)
            else:
                fake.containers["relay-previous"] = container(IMAGE + "c" * 64, True)
            before = copy.deepcopy(fake.containers)
            with self.assertRaises(module.RolloutError):
                fake.run()
            self.assertEqual(before, fake.containers)


if __name__ == "__main__":
    unittest.main()
