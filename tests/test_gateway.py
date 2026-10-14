import importlib.util
import os
import pathlib
import tempfile
import types
import unittest
from unittest import mock


class GatewayTests(unittest.TestCase):
    def setUp(self):
        script = pathlib.Path(__file__).parent.parent / "extensions/remote-access/gateway.py"
        self.assertTrue(script.exists(), "standalone account manager has not been implemented")
        spec = importlib.util.spec_from_file_location("gateway", script)
        self.gateway = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.gateway)
        self.original = "pi.example.com {\n    basic_auth {\n        alice $2a$14$old\n        bob $2a$14$other\n    }\n    reverse_proxy 127.0.0.1:13001\n}\n"

    def test_replace_preserves_other_accounts(self):
        changed = self.gateway.update_account(self.original, "pi.example.com", "alice", "carol", "$2a$14$new", False)
        self.assertNotIn("alice", changed)
        self.assertIn("bob $2a$14$other", changed)
        self.assertIn("carol $2a$14$new", changed)
        self.assertIn("reverse_proxy 127.0.0.1:13001", changed)

    def test_ambiguous_or_wrong_site_refuses_changes(self):
        for text in [self.original + "other.example.com {\n respond ok\n}\n", self.original.replace("basic_auth {", "basic_auth /admin* {"), self.original.replace("pi.example.com", "other.example.com")]:
            with self.assertRaises(ValueError):
                self.gateway.update_account(text, "pi.example.com", "alice", "alice", "$2a$14$new", False)

    def test_validation_and_reload_failures_restore_original(self):
        for step in ["validate", "reload"]:
            with tempfile.TemporaryDirectory() as directory:
                target = pathlib.Path(directory) / "site.caddy"
                target.write_text(self.original)
                target.chmod(0o604)
                original_stat = target.stat()
                def fail():
                    raise RuntimeError("isolated failure")
                with self.assertRaises(RuntimeError):
                    self.gateway.apply_config(target, "candidate", fail if step == "validate" else lambda: None, fail if step == "reload" else lambda: None)
                self.assertEqual(target.read_text(), self.original)
                restored_stat = target.stat()
                self.assertEqual((restored_stat.st_uid, restored_stat.st_gid), (original_stat.st_uid, original_stat.st_gid))
                self.assertEqual(restored_stat.st_mode & 0o7777, original_stat.st_mode & 0o7777)
                self.assertEqual(len(list(pathlib.Path(directory).glob("site.caddy.backup-*"))), 1)

    def test_atomic_write_skips_chown_when_temporary_file_already_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "site.caddy"
            target.write_text("original")
            previous_stat = target.stat()
            self.assertEqual(previous_stat.st_uid, os.geteuid())
            self.assertEqual(previous_stat.st_gid, os.getegid())
            with mock.patch.object(self.gateway.os, "fchown") as fchown:
                self.gateway.atomic_write(target, "replacement", previous_stat)
            fchown.assert_not_called()
            self.assertEqual(target.read_text(), "replacement")
            replaced_stat = target.stat()
            self.assertEqual((replaced_stat.st_uid, replaced_stat.st_gid), (previous_stat.st_uid, previous_stat.st_gid))
            self.assertEqual(replaced_stat.st_mode & 0o7777, previous_stat.st_mode & 0o7777)

    def test_unpreservable_owner_refuses_replacement_and_closes_fd(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "site.caddy"
            target.write_text("original")
            original_stat = target.stat()
            requested_stat = types.SimpleNamespace(
                st_uid=original_stat.st_uid,
                st_gid=original_stat.st_gid + 1,
                st_mode=original_stat.st_mode,
            )
            real_mkstemp = self.gateway.tempfile.mkstemp
            created = {}
            def capture_mkstemp(*args, **kwargs):
                created["fd"], created["path"] = real_mkstemp(*args, **kwargs)
                return created["fd"], created["path"]
            with mock.patch.object(self.gateway.tempfile, "mkstemp", side_effect=capture_mkstemp), mock.patch.object(
                self.gateway.os, "geteuid", return_value=1000
            ), mock.patch.object(
                self.gateway.os, "fchown", side_effect=PermissionError("synthetic permission denial")
            ) as fchown:
                with self.assertRaisesRegex(PermissionError, "Cannot preserve site file UID/GID"):
                    self.gateway.atomic_write(target, "replacement", requested_stat)
            fchown.assert_called_once_with(created["fd"], requested_stat.st_uid, requested_stat.st_gid)
            self.assertEqual(target.read_text(), "original")
            self.assertEqual((target.stat().st_uid, target.stat().st_gid), (original_stat.st_uid, original_stat.st_gid))
            self.assertFalse(pathlib.Path(created["path"]).exists())
            with self.assertRaises(OSError):
                os.fstat(created["fd"])

    def test_unverified_owner_change_refuses_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "site.caddy"
            target.write_text("original")
            original_stat = target.stat()
            requested_stat = types.SimpleNamespace(
                st_uid=original_stat.st_uid,
                st_gid=original_stat.st_gid + 1,
                st_mode=original_stat.st_mode,
            )
            with mock.patch.object(self.gateway.os, "fchown") as fchown:
                with self.assertRaisesRegex(PermissionError, "Cannot preserve site file UID/GID"):
                    self.gateway.atomic_write(target, "replacement", requested_stat)
            fchown.assert_called_once()
            self.assertEqual(target.read_text(), "original")
            self.assertEqual((target.stat().st_uid, target.stat().st_gid), (original_stat.st_uid, original_stat.st_gid))

    def test_rollback_owner_failure_keeps_candidate_and_reports_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "site.caddy"
            target.write_text(self.original)
            real_fstat = self.gateway.os.fstat
            fstat_calls = 0
            def report_unexpected_rollback_gid(fd):
                nonlocal fstat_calls
                fstat_calls += 1
                result = real_fstat(fd)
                if fstat_calls >= 5:
                    return types.SimpleNamespace(st_uid=result.st_uid, st_gid=result.st_gid + 1, st_mode=result.st_mode)
                return result
            def fail_validation():
                raise RuntimeError("isolated rollback trigger")
            with mock.patch.object(self.gateway.os, "fstat", side_effect=report_unexpected_rollback_gid), mock.patch.object(
                self.gateway.os, "fchown", side_effect=PermissionError("synthetic rollback permission denial")
            ) as fchown:
                with self.assertRaisesRegex(PermissionError, "Cannot preserve site file UID/GID"):
                    self.gateway.apply_config(target, "candidate", fail_validation, lambda: None)
            fchown.assert_called_once()
            self.assertEqual(target.read_text(), "candidate")
            self.assertEqual((target.stat().st_uid, target.stat().st_gid), (os.geteuid(), os.getegid()))

    def test_atomic_write_mode_failure_closes_fd_and_keeps_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "site.caddy"
            target.write_text("original")
            previous_stat = target.stat()
            real_mkstemp = self.gateway.tempfile.mkstemp
            created = {}
            def capture_mkstemp(*args, **kwargs):
                created["fd"], created["path"] = real_mkstemp(*args, **kwargs)
                return created["fd"], created["path"]
            with mock.patch.object(self.gateway.tempfile, "mkstemp", side_effect=capture_mkstemp), mock.patch.object(
                self.gateway.os, "fchmod", side_effect=PermissionError("synthetic mode denial")
            ):
                with self.assertRaises(PermissionError):
                    self.gateway.atomic_write(target, "replacement", previous_stat)
            self.assertEqual(target.read_text(), "original")
            self.assertFalse(pathlib.Path(created["path"]).exists())
            with self.assertRaises(OSError):
                os.fstat(created["fd"])

    def test_atomic_write_and_rollback_preserve_distinct_group_when_available(self):
        if not hasattr(os, "chown") or not hasattr(os, "getgroups"):
            self.skipTest("POSIX chown and supplementary group APIs are unavailable")
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "site.caddy"
            target.write_text(self.original)
            original_gid = target.stat().st_gid
            candidate_gids = sorted(set(os.getgroups() + [os.getegid()]) - {original_gid})
            if not candidate_gids and os.geteuid() == 0 and original_gid < 2**31 - 1:
                # Root can safely assign an arbitrary distinct GID to this
                # throwaway file; no system account/group is created or changed.
                candidate_gids = [original_gid + 1]
            if not candidate_gids:
                self.skipTest("No different current/supplementary GID is available to a non-root process")
            try:
                os.chown(target, -1, candidate_gids[0])
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"Filesystem/process cannot assign an already-held group to a temporary test file: {type(error).__name__}")
            original_stat = target.stat()
            target.chmod(0o4604)
            original_stat = target.stat()
            def fail_validation():
                candidate_stat = target.stat()
                self.assertEqual((candidate_stat.st_uid, candidate_stat.st_gid), (original_stat.st_uid, original_stat.st_gid))
                self.assertEqual(candidate_stat.st_mode & 0o7777, original_stat.st_mode & 0o7777)
                raise RuntimeError("isolated rollback trigger")
            with self.assertRaisesRegex(RuntimeError, "isolated rollback trigger"):
                self.gateway.apply_config(target, "candidate", fail_validation, lambda: None)
            self.assertEqual(target.read_text(), self.original)
            restored_stat = target.stat()
            self.assertEqual((restored_stat.st_uid, restored_stat.st_gid), (original_stat.st_uid, original_stat.st_gid))
            self.assertEqual(restored_stat.st_mode & 0o7777, original_stat.st_mode & 0o7777)

    def test_new_site_failure_removes_only_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "site.caddy"
            def fail():
                raise RuntimeError("isolated failure")
            with self.assertRaises(RuntimeError):
                self.gateway.apply_config(target, "candidate", fail, lambda: None)
            self.assertFalse(target.exists())

    def test_effective_config_must_contain_exact_domain_and_account(self):
        auth = {"handler": "authentication", "providers": {"http_basic": {"accounts": [{"username": "carol", "password": "$2a$14$new"}]}}}
        effective = {"apps": {"http": {"servers": {"srv0": {"routes": [{"match": [{"host": ["pi.example.com"]}], "handle": [{"handler": "subroute", "routes": [{"handle": [auth]}, {"handle": [{"handler": "reverse_proxy"}]}]}], "terminal": True}]}}}}}
        self.gateway.check_effective_config(effective, "pi.example.com", "carol", "$2a$14$new")
        for domain, username, password_hash in [("unused.example.com", "carol", "$2a$14$new"), ("pi.example.com", "alice", "$2a$14$new"), ("pi.example.com", "carol", "$2a$14$old")]:
            with self.assertRaises(ValueError):
                self.gateway.check_effective_config(effective, domain, username, password_hash)

    def test_new_site_rejects_foreign_origins_and_remains_editable(self):
        site = self.gateway.new_site("pi.example.com", "alice", "$2a$14$old", 13001)
        self.assertIn("not header Origin https://pi.example.com", site)
        self.assertIn("respond @foreignOrigin 403", site)
        changed = self.gateway.update_account(site, "pi.example.com", "alice", "carol", "$2a$14$new")
        self.assertIn("respond @foreignOrigin 403", changed)

    def test_effective_config_rejects_proxy_before_authentication(self):
        auth = {"handler": "authentication", "providers": {"http_basic": {"accounts": [{"username": "alice", "password": "$2a$14$old"}]}}}
        proxy = {"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:13001"}]}
        for routes in [
            [{"handle": [proxy]}, {"handle": [auth]}],
            [{"handle": [proxy, auth]}],
            [{"handle": [auth], "terminal": True}, {"handle": [proxy]}],
        ]:
            effective = {"apps": {"http": {"servers": {"srv0": {"routes": [{"match": [{"host": ["pi.example.com"]}], "handle": [{"handler": "subroute", "routes": routes}], "terminal": True}]}}}}}
            with self.assertRaises(ValueError):
                self.gateway.check_effective_config(effective, "pi.example.com", "alice", "$2a$14$old")

    def test_concurrent_edit_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "site.caddy"
            target.write_text("another administrator edited this")
            with self.assertRaises(ValueError):
                self.gateway.apply_config(target, "candidate", lambda: None, lambda: None, expected_original=self.original)
            self.assertEqual(target.read_text(), "another administrator edited this")

    def test_other_listener_cannot_bypass_selected_domain(self):
        auth = {"handler": "authentication", "providers": {"http_basic": {"accounts": [{"username": "alice", "password": "$2a$14$old"}]}}}
        protected = {"listen": ["127.0.0.1:443"], "routes": [{"match": [{"host": ["pi.example.com"]}], "handle": [{"handler": "subroute", "routes": [{"handle": [auth]}, {"handle": [{"handler": "reverse_proxy"}]}]}], "terminal": True}]}
        for match in [None, [{"host": ["*.example.com"]}], [{"path": ["/*"]}]]:
            competing = {"handle": [{"handler": "reverse_proxy"}]}
            if match is not None:
                competing["match"] = match
            effective = {"apps": {"http": {"servers": {"protected": protected, "public": {"listen": ["192.0.2.10:443"], "routes": [competing]}}}}}
            with self.assertRaises(ValueError):
                self.gateway.check_effective_config(effective, "pi.example.com", "alice", "$2a$14$old")
        # A separate plain host cannot serve the selected domain and stays usable.
        effective["apps"]["http"]["servers"]["public"]["routes"][0]["match"] = [{"host": ["other.example.com"]}]
        self.gateway.check_effective_config(effective, "pi.example.com", "alice", "$2a$14$old")

    def test_authentication_error_cannot_enter_unprotected_error_routes(self):
        auth = {"handler": "authentication", "providers": {"http_basic": {"accounts": [{"username": "alice", "password": "$2a$14$old"}]}}}
        proxy = {"handler": "reverse_proxy"}
        server = {"listen": [":443"], "routes": [{"match": [{"host": ["pi.example.com"]}], "handle": [{"handler": "subroute", "routes": [{"handle": [auth]}, {"handle": [proxy]}]}], "terminal": True}], "errors": {"routes": [{"handle": [proxy]}]}}
        effective = {"apps": {"http": {"servers": {"srv0": server}}}}
        with self.assertRaises(ValueError):
            self.gateway.check_effective_config(effective, "pi.example.com", "alice", "$2a$14$old")


if __name__ == "__main__":
    unittest.main()
