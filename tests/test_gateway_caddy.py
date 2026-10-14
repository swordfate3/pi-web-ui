"""Optional real gateway test; set CADDY_TEST_BIN to an official Caddy binary.

Uses temporary configuration, test credentials, a private test CA and loopback
ports only. No installed service, real gateway or system trust store is modified.
"""
import base64
import fcntl
import http.server
import importlib.util
import json
import os
import pathlib
import pty
import select
import socket
import ssl
import subprocess
import tempfile
import termios
import threading
import time
import unittest
import urllib.error
import urllib.request


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"isolated gateway fixture")

    def log_message(self, *_args):
        pass


def terminal_run(args, answers, env):
    """Exercise getpass with a real controlling terminal; passwords aren't argv."""
    master, slave = pty.openpty()
    def controlling_terminal():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    process = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_terminal, env=env)
    os.close(slave)
    pending, output = b"", b""
    try:
        for prompt, answer in answers:
            deadline = time.monotonic() + 20
            while prompt.encode() not in pending:
                if time.monotonic() > deadline:
                    raise AssertionError("Temporary maintenance terminal timed out")
                if select.select([master], [], [], 0.1)[0]:
                    chunk = os.read(master, 8192)
                    pending += chunk
                    output += chunk
            pending = b""
            os.write(master, answer.encode() + b"\n")
        status = process.wait(timeout=30)
        while select.select([master], [], [], 0)[0]:
            try:
                chunk = os.read(master, 8192)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
        return status, output.decode()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


@unittest.skipUnless(os.environ.get("CADDY_TEST_BIN"), "Set CADDY_TEST_BIN for real gateway integration")
class RealCaddyTests(unittest.TestCase):
    def test_adapted_auth_error_proxy_is_rejected_before_reload(self):
        source = pathlib.Path(__file__).parent.parent / "extensions/remote-access/gateway.py"
        spec = importlib.util.spec_from_file_location("gateway", source)
        gateway = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gateway)
        with tempfile.TemporaryDirectory(prefix="pi-web-error-routes-") as directory:
            target = pathlib.Path(directory) / "Caddyfile"
            old_hash, new_hash = "$2a$14$fixtureold", "$2a$14$fixturenew"
            protected = gateway.new_site("pi.example.com", "alice", old_hash, 13001)
            error_proxy = protected[:-2] + "    handle_errors {\n        reverse_proxy 127.0.0.1:13001\n    }\n}\n"
            candidate = gateway.update_account(error_proxy, "pi.example.com", "alice", "alice", new_hash)
            target.write_text(protected)
            reloads = []
            def validate():
                adapted = subprocess.run([os.environ["CADDY_TEST_BIN"], "adapt", "--adapter", "caddyfile", "--config", str(target)], capture_output=True, text=True, check=True, timeout=30)
                gateway.check_effective_config(json.loads(adapted.stdout), "pi.example.com", "alice", new_hash, require_origin_guard=True)
            with self.assertRaises(ValueError):
                gateway.apply_config(target, candidate, validate, lambda: reloads.append(True))
            self.assertEqual(reloads, [])
            self.assertEqual(target.read_text(), protected)

    def test_adapted_cross_listener_bypass_is_rejected_before_reload(self):
        source = pathlib.Path(__file__).parent.parent / "extensions/remote-access/gateway.py"
        spec = importlib.util.spec_from_file_location("gateway", source)
        gateway = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gateway)
        with tempfile.TemporaryDirectory(prefix="pi-web-listeners-") as directory:
            target = pathlib.Path(directory) / "Caddyfile"
            password_hash = "$2a$14$fixturehash"
            protected = gateway.new_site("pi.example.com", "alice", password_hash, 13001).replace("pi.example.com {", "pi.example.com {\n    bind 127.0.0.1")
            for competing in [":443", "*.example.com"]:
                candidate = protected + f"{competing} {{\n    bind 192.0.2.10\n    tls internal\n    reverse_proxy 127.0.0.1:13001\n}}\n"
                target.write_text(protected)
                reloads = []
                def validate():
                    adapted = subprocess.run([os.environ["CADDY_TEST_BIN"], "adapt", "--adapter", "caddyfile", "--config", str(target)], capture_output=True, text=True, check=True, timeout=30)
                    gateway.check_effective_config(json.loads(adapted.stdout), "pi.example.com", "alice", password_hash, require_origin_guard=True)
                with self.assertRaises(ValueError):
                    gateway.apply_config(target, candidate, validate, lambda: reloads.append(True))
                self.assertEqual(reloads, [])
                self.assertEqual(target.read_text(), protected)

    def test_auth_origins_effective_config_and_rollback(self):
        source = pathlib.Path(__file__).parent.parent / "extensions/remote-access/gateway.py"
        spec = importlib.util.spec_from_file_location("gateway", source)
        gateway = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gateway)
        with tempfile.TemporaryDirectory(prefix="pi-web-gateway-") as directory:
            root = pathlib.Path(directory)
            env = {**os.environ, "XDG_DATA_HOME": str(root / "data"), "XDG_CONFIG_HOME": str(root / "config")}
            def caddy(*args, stdin=None):
                return subprocess.run([os.environ["CADDY_TEST_BIN"], *args], input=stdin, text=True, capture_output=True, check=True, timeout=30, env=env)
            old_password, new_password = "fixture-old-password", "  fixture-密码  "
            old_hash = caddy("hash-password", "--algorithm", "bcrypt", stdin=old_password + "\n").stdout.strip()
            new_hash = caddy("hash-password", "--algorithm", "bcrypt", stdin=new_password + "\n").stdout.strip()
            upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
            threading.Thread(target=upstream.serve_forever, daemon=True).start()
            self.addCleanup(upstream.server_close)
            self.addCleanup(upstream.shutdown)
            admin_port, https_port = free_port(), free_port()
            site = root / "pi.caddy"
            original = gateway.new_site("localhost", "alice", old_hash, upstream.server_port)
            original = original.replace("localhost {\n", "localhost {\n    bind 127.0.0.1\n")
            original = original.replace(f"alice {old_hash}\n", f"alice {old_hash}\n        bob {old_hash}\n")
            site.write_text(original)
            site.chmod(0o640)
            main = root / "Caddyfile"
            main.write_text(f"{{\n admin 127.0.0.1:{admin_port}\n https_port {https_port}\n local_certs\n skip_install_trust\n auto_https disable_redirects\n}}\nimport {site}\n")
            with open(root / "caddy.log", "wb") as log:
                process = subprocess.Popen([os.environ["CADDY_TEST_BIN"], "run", "--config", str(main), "--adapter", "caddyfile"], stdout=log, stderr=log, env=env)
                try:
                    cert = root / "data/caddy/pki/authorities/local/root.crt"
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            self.fail("Temporary Caddy exited before starting")
                        # Listener/root CA precede asynchronous leaf issuance.
                        if cert.exists() and list((root / "data/caddy/certificates").glob("*/localhost/*.crt")):
                            try:
                                with socket.create_connection(("127.0.0.1", https_port), timeout=0.1):
                                    break
                            except OSError:
                                pass
                        time.sleep(0.05)
                    else:
                        self.fail("Temporary Caddy did not start")
                    url = f"https://localhost:{https_port}/"
                    tls = ssl.create_default_context(cafile=str(cert))
                    def status(username=None, password=None, origin=None, websocket=False):
                        headers = {}
                        if username:
                            headers["Authorization"] = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
                        if origin:
                            headers["Origin"] = origin
                        if websocket:
                            headers.update({"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="})
                        try:
                            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), context=tls, timeout=5) as response:
                                return response.status
                        except urllib.error.HTTPError as error:
                            code = error.code
                            error.close()
                            return code
                    try:
                        self.assertEqual(status(), 401)
                    except urllib.error.URLError:
                        self.fail("Temporary gateway TLS failed: " + (root / "caddy.log").read_text()[-4000:])
                    self.assertEqual(status("alice", old_password), 200)
                    self.assertEqual(status("alice", old_password, "https://evil.example", True), 403)
                    self.assertEqual(status("alice", old_password, "null"), 403)
                    self.assertEqual(status("alice", old_password, "https://localhost"), 200)
                    changed = gateway.update_account(original, "localhost", "alice", "carol", new_hash)
                    def validate():
                        caddy("validate", "--config", str(main), "--adapter", "caddyfile")
                        effective = json.loads(caddy("adapt", "--config", str(main), "--adapter", "caddyfile").stdout)
                        gateway.check_effective_config(effective, "localhost", "carol", new_hash)
                    def reload():
                        caddy("reload", "--config", str(main), "--adapter", "caddyfile")
                    gateway.apply_config(site, changed, validate, reload, expected_original=original)
                    self.assertEqual(status("carol", new_password), 200)
                    self.assertEqual(status("alice", old_password), 401)
                    self.assertEqual(status("bob", old_password), 200)
                    self.assertEqual(site.stat().st_mode & 0o777, 0o640)
                    self.assertEqual(next(root.glob("pi.caddy.backup-*")).stat().st_mode & 0o777, 0o600)
                    unrelated = {"apps": {"http": {"servers": {}}}}
                    with self.assertRaises(ValueError):
                        gateway.apply_config(site, original, lambda: gateway.check_effective_config(unrelated, "localhost", "alice", old_hash), reload)
                    self.assertEqual(site.read_text(), changed)
                    with self.assertRaises(subprocess.CalledProcessError):
                        gateway.apply_config(site, "not a valid config {", validate, reload)
                    self.assertEqual(site.read_text(), changed)
                    self.assertEqual(status("carol", new_password), 200)
                    # A valid global order override used to bypass auth while
                    # passing the presence-only proof. Reject before reload.
                    normal_main = main.read_text()
                    for override in ["order reverse_proxy before basic_auth", "order reverse_proxy before respond"]:
                        main.write_text(normal_main.replace("{\n", "{\n " + override + "\n", 1))
                        reloaded = []
                        def ordered_validate():
                            caddy("validate", "--config", str(main), "--adapter", "caddyfile")
                            effective = json.loads(caddy("adapt", "--config", str(main), "--adapter", "caddyfile").stdout)
                            gateway.check_effective_config(effective, "localhost", "alice", old_hash, require_origin_guard=True)
                        try:
                            with self.assertRaises(ValueError):
                                gateway.apply_config(site, original, ordered_validate, lambda: reloaded.append(True))
                            self.assertEqual(reloaded, [])
                            self.assertEqual(site.read_text(), changed)
                            self.assertEqual(status(), 401)
                            self.assertEqual(status("carol", new_password, "https://evil.example", True), 403)
                        finally:
                            main.write_text(normal_main)
                    previous_ca = os.environ.get("SSL_CERT_FILE")
                    os.environ["SSL_CERT_FILE"] = str(cert)
                    try:
                        gateway.verify_login(url, "carol", new_password)
                        with self.assertRaises(ValueError):
                            gateway.verify_login(url, "carol", old_password)
                    finally:
                        if previous_ca is None:
                            os.environ.pop("SSL_CERT_FILE", None)
                        else:
                            os.environ["SSL_CERT_FILE"] = previous_ca
                    env["PATH"] = str(pathlib.Path(os.environ["CADDY_TEST_BIN"]).parent) + os.pathsep + env["PATH"]
                    result, transcript = terminal_run(["python3", str(source), "recover", "--domain", "localhost", "--site-file", str(site), "--main-config", str(main)], [
                        ("authorize maintenance:", "localhost"),
                        ("Current web username to replace:", "carol"),
                        ("New web username (no default):", "carol"),
                        ("New web password", old_password),
                        ("Confirm new password:", old_password),
                    ], env)
                    self.assertEqual(result, 0, "Temporary terminal recovery failed")
                    self.assertIn("APPLIED:", transcript)
                    self.assertIn("NOT YET VERIFIED:", transcript)
                    self.assertNotIn(old_password, transcript)
                    self.assertEqual(status("carol", old_password), 200)
                    self.assertEqual(status("carol", new_password), 401)
                    self.assertEqual(status("bob", old_password), 200)
                finally:
                    process.terminate()
                    process.wait(timeout=10)
