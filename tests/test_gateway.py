import importlib.util
import pathlib
import tempfile
import unittest


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
                def fail():
                    raise RuntimeError("isolated failure")
                with self.assertRaises(RuntimeError):
                    self.gateway.apply_config(target, "candidate", fail if step == "validate" else lambda: None, fail if step == "reload" else lambda: None)
                self.assertEqual(target.read_text(), self.original)
                self.assertEqual(len(list(pathlib.Path(directory).glob("site.caddy.backup-*"))), 1)

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
