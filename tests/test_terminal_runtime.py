"""Real PTY + private Unix adapter tests. No personal Pi state or credentials."""
import base64
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import termios
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "runtime/terminal"
RUN = "a" * 32
TOKEN = "b" * 64
INSTANCE = "c" * 32
CHILD = r'''
import os, signal, termios, tty, struct, fcntl
tty.setraw(0)
def out(s): os.write(1, (s + "\n").encode())
def size(*_):
    r,c,_,_=struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0"*8))
    out("SIZE:%d:%d" % (c,r))
signal.signal(signal.SIGWINCH, size)
signal.signal(signal.SIGTERM, lambda *_: (out("TERM"), exit(0)))
out("PID:%d:%d:%d" % (os.getpid(), os.getsid(0), os.tcgetpgrp(0)))
while True:
    data=os.read(0,8192)
    if not data: break
    out("BYTES:" + data.hex())
'''


class Adapter:
    """Temporary real server implementing the proposed Task3 wire contract."""
    def __init__(self, path):
        self.path = path
        self.instance = INSTANCE
        self.session = "session-1"
        self.latched = False
        self.hold = threading.Event()
        self.hold.set()
        self.stop = threading.Event()
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(path))
        self.server.listen(8)
        self.server.settimeout(.1)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with conn:
                conn.settimeout(1)
                try:
                    raw = b""
                    while b"\n" not in raw and len(raw) <= 65536:
                        chunk = conn.recv(4096)
                        if not chunk: break
                        raw += chunk
                    req = json.loads(raw)
                    if req["token"] != TOKEN: continue
                    if req["action"] == "terminal-prepare":
                        self.hold.wait(2)
                        self.latched = True
                    elif req["action"] != "terminal-state":
                        continue
                    result = {"runId": RUN, "runtimeId": "runtime-1", "sessionId": self.session,
                              "terminalEpoch": req["expected"]["terminalEpoch"],
                              "adapterInstanceId": self.instance, "latched": self.latched}
                    conn.sendall((json.dumps({"ok": True, "result": result}) + "\n").encode())
                except (OSError, ValueError, KeyError):
                    pass

    def close(self):
        self.stop.set()
        self.hold.set()
        self.server.close()
        self.thread.join(3)


class Peer:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(3)
        self.sock.connect(str(path))
        self.buffer = b""
        self.frames = []
        self.sequence = 0
        self.request_id = 0

    def send(self, value):
        self.sock.sendall(json.dumps(value).encode() + b"\n")

    def receive(self):
        while b"\n" not in self.buffer:
            chunk = self.sock.recv(65536)
            if not chunk: raise EOFError("runtime closed peer")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def request(self, kind, **fields):
        self.request_id += 1
        self.send({"id": self.request_id, "type": kind, **fields})
        while True:
            value = self.receive()
            if value.get("type") == "response" and value["id"] == self.request_id:
                return value["result"]
            self.frames.append(value)

    def close(self):
        self.sock.close()


class Running:
    def __init__(self, stage, adapter=True, child=CHILD, argv=None):
        self.tmp = tempfile.TemporaryDirectory(prefix="terminal-runtime-")
        self.dir = Path(self.tmp.name)
        self.adapter = Adapter(self.dir / "adapter.sock") if adapter else None
        self.master, self.slave = pty.openpty()
        self.before = termios.tcgetattr(self.slave)
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(self.dir), "TERM": "xterm-256color"}
        script = (
            "import sys; sys.path.insert(0,sys.argv[1]); from supervisor import Runtime; "
            "raise SystemExit(Runtime(sys.argv[2],sys.argv[3],sys.argv[4]).run(sys.argv[5:]))"
        )
        self.process = subprocess.Popen(
            ["/usr/bin/python3", "-I", "-c", script, str(stage), str(self.dir), RUN, TOKEN,
             *(argv or ["/usr/bin/python3", "-I", "-u", "-c", child])],
            stdin=self.slave, stdout=self.slave, stderr=subprocess.DEVNULL, env=env, cwd=self.dir,
        )
        self.output = b""
        self.peers = []

    def until(self, needle, timeout=5):
        deadline = time.monotonic() + timeout
        while needle not in self.output and time.monotonic() < deadline:
            if select.select([self.master], [], [], .05)[0]:
                try: self.output += os.read(self.master, 65536)
                except OSError: break
        if needle not in self.output:
            raise AssertionError("expected terminal marker absent (content intentionally not logged)")

    def status(self):
        peer = Peer(self.dir / "terminal.sock")
        try:
            peer.send({"v": 1, "op": "status", "runId": RUN})
            return peer.receive()
        finally: peer.close()

    def connect(self, scope="write"):
        deadline = time.monotonic() + 4
        while True:
            status = self.status()
            if status.get("type") == "ready": break
            if time.monotonic() > deadline: raise AssertionError("adapter identity not discovered")
            time.sleep(.03)
        self.target = status["target"]
        peer = Peer(self.dir / "terminal.sock")
        self.peers.append(peer)
        peer.send({"v": 1, "op": "connect", "target": self.target, "scope": scope,
                   "binding": {"authorizationId": os.urandom(16).hex(), "connectionId": os.urandom(16).hex()}})
        ready = peer.receive()
        if ready.get("type") != "ready": raise AssertionError("attach rejected")
        return peer

    def local(self, data):
        os.write(self.master, data)

    def handoff(self):
        self.local(b"\x1dw")
        self.until(b"[terminal: none]")

    def input(self, peer, lease, data, sequence=1):
        return peer.request("input", v=1, terminalEpoch=self.target["terminalEpoch"],
                            leaseId=lease["leaseId"], sequence=sequence, data=data)

    def close(self):
        for peer in self.peers: peer.close()
        if self.process.poll() is None: self.process.send_signal(signal.SIGTERM)
        try: self.process.wait(5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        if self.adapter: self.adapter.close()
        os.close(self.master)
        os.close(self.slave)
        self.tmp.cleanup()


class RuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stage_tmp = tempfile.TemporaryDirectory(prefix="terminal-image-")
        cls.stage = Path(cls.stage_tmp.name)
        if (SOURCE / "supervisor.py").exists():
            shutil.copy(SOURCE / "supervisor.py", cls.stage)
        if (SOURCE / "broker.ts").exists():
            subprocess.run([str(ROOT / "node_modules/.bin/esbuild"), str(SOURCE / "broker.ts"),
                            "--bundle", "--platform=node", "--format=cjs", "--target=node22",
                            "--log-level=error", "--outfile=" + str(cls.stage / "broker.cjs")], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.stage_tmp.cleanup()

    @contextlib.contextmanager
    def runtime(self, **kwargs):
        runtime = Running(self.stage, **kwargs)
        try:
            runtime.until(b"PID:")
            deadline = time.monotonic() + 4
            while not (runtime.dir / "terminal.sock").exists() and time.monotonic() < deadline:
                time.sleep(.02)
            yield runtime
        finally: runtime.close()

    def test_remote_input_is_rejected_while_local_owns_terminal(self):
        with self.runtime() as runtime:
            peer = runtime.connect()
            self.assertEqual(peer.request("acquire")["error"], "local_owns_input")
            self.assertFalse(b"BYTES:" in runtime.output, "rejected control must not reach child")
            self.assertFalse(runtime.target["managedRestartEligible"])

    def test_same_child_local_handoff_remote_input_and_reclaim(self):
        with self.runtime() as runtime:
            runtime.local(b"local\x1d\x1d")
            runtime.until(b"6c6f63616c1d")
            peer = runtime.connect()
            runtime.handoff()
            lease = peer.request("acquire")
            self.assertEqual(lease["expiresInMs"], 30000)
            self.assertTrue(runtime.adapter.latched)
            self.assertEqual(runtime.input(peer, lease, "remote")["delivery"], "written")
            runtime.until(b"72656d6f7465")
            runtime.local(b"\x1dl")
            runtime.until(b"[terminal: local]")
            self.assertFalse(runtime.input(peer, lease, "forbidden", 2)["ok"])
            runtime.local(b"again")
            runtime.until(b"616761696e")
            self.assertEqual(runtime.output.count(b"PID:"), 1)

    def test_adapter_absent_is_unavailable_but_local_relay_still_works(self):
        with self.runtime(adapter=False) as runtime:
            self.assertEqual(runtime.status()["error"], "terminal_backend_unavailable")
            runtime.local(b"safe")
            runtime.until(b"73616665")

    def test_real_resize_and_termios_restore_on_signal(self):
        with self.runtime() as runtime:
            peer = runtime.connect()
            runtime.handoff()
            lease = peer.request("acquire")
            result = peer.request("resize", leaseId=lease["leaseId"], columns=88, rows=31)
            self.assertTrue(result["ok"])
            runtime.until(b"SIZE:88:31")
            runtime.process.send_signal(signal.SIGTERM)
            runtime.process.wait(5)
            self.assertEqual(termios.tcgetattr(runtime.slave), runtime.before)
            self.assertFalse((runtime.dir / "terminal.sock").exists())

    def test_adapter_replacement_invalidates_lease_without_breaking_local_input(self):
        with self.runtime() as runtime:
            peer = runtime.connect()
            runtime.handoff()
            lease = peer.request("acquire")
            runtime.adapter.instance = "d" * 32
            time.sleep(.8)
            self.assertFalse(runtime.input(peer, lease, "forbidden")["ok"])
            runtime.local(b"\x1dl")
            runtime.until(b"[terminal: local]")
            runtime.local(b"recover")
            runtime.until(b"7265636f766572")

    def test_disconnect_during_prepare_cannot_resurrect_lease(self):
        with self.runtime() as runtime:
            peer = runtime.connect()
            runtime.handoff()
            runtime.adapter.hold.clear()
            peer.send({"id": 1, "type": "acquire"})
            time.sleep(.1)
            peer.close()
            runtime.adapter.hold.set()
            time.sleep(.3)
            next_peer = runtime.connect()
            self.assertTrue(next_peer.request("acquire")["ok"])

    def test_lease_expires_without_input_renewal_and_old_sequence_is_not_replayed(self):
        with self.runtime() as runtime:
            peer = runtime.connect()
            runtime.handoff()
            lease = peer.request("acquire")
            self.assertTrue(runtime.input(peer, lease, "once")["ok"])
            runtime.until(b"6f6e6365")
            time.sleep(15)
            self.assertTrue(runtime.input(peer, lease, "midlease", 2)["ok"])
            time.sleep(15.1)
            self.assertFalse(runtime.input(peer, lease, "expired", 3)["ok"])
            successor = peer.request("acquire")
            self.assertTrue(successor["ok"])
            self.assertTrue(successor["leaseId"] != lease["leaseId"], "successor must use a fresh lease")
            self.assertTrue(runtime.input(peer, successor, "next")["ok"])
            self.assertFalse(runtime.input(peer, successor, "duplicate")["ok"])

    def test_expired_connection_cannot_resize_successor_writer(self):
        with self.runtime() as runtime:
            old = runtime.connect()
            current = runtime.connect()
            runtime.handoff()
            stale = old.request("acquire")
            time.sleep(30.1)
            self.assertTrue(current.request("acquire")["ok"])
            self.assertFalse(old.request("resize", leaseId=stale["leaseId"], columns=89, rows=32)["ok"])

    def test_pty_backpressure_is_unknown_and_revokes_without_retry(self):
        child = CHILD.replace('while True:', '''
ready = False
def resume(*_):
    global ready
    ready = True
signal.signal(signal.SIGUSR1, resume)
while not ready: signal.pause()
while True:''')
        with self.runtime(child=child) as runtime:
            peer = runtime.connect()
            runtime.handoff()
            lease = peer.request("acquire")
            for sequence in range(1, 128):
                result = runtime.input(peer, lease, "x" * 8192, sequence)
                if result.get("delivery") == "unknown": break
            else: self.fail("blocked real PTY did not exercise nonblocking partial/EAGAIN")
            self.assertFalse(result["ok"])
            self.assertEqual(runtime.input(peer, lease, "must-not-retry", sequence + 1)["delivery"], "rejected")
            pid = int(re.search(rb"PID:(\d+)", runtime.output).group(1))
            os.kill(pid, signal.SIGUSR1)
            runtime.until(b"BYTES:")

    def test_local_yield_while_remote_does_not_implicitly_revoke_writer(self):
        with self.runtime() as runtime:
            peer = runtime.connect()
            runtime.handoff()
            lease = peer.request("acquire")
            runtime.local(b"\x1dw")
            runtime.until(b"[terminal: remote]")
            self.assertTrue(peer.request("resize", leaseId=lease["leaseId"], columns=90, rows=33)["ok"])

    def test_readers_limited_to_two_and_malformed_request_cannot_steal_local_control(self):
        with self.runtime() as runtime:
            first = runtime.connect("read")
            second = runtime.connect("read")
            with self.assertRaises((EOFError, ConnectionResetError)):
                runtime.connect("read")
            first.send({"id": 1, "type": "local-yield"})
            time.sleep(.1)
            self.assertEqual(second.request("acquire")["error"], "local_owns_input")
            runtime.local(b"still-local")
            runtime.until(b"7374696c6c2d6c6f63616c")

    def test_snapshots_are_chunked_and_same_session_process_is_foreground(self):
        with self.runtime() as runtime:
            match = re.search(rb"PID:(\d+):(\d+):(\d+)", runtime.output)
            self.assertIsNotNone(match)
            self.assertEqual(len(set(match.groups())), 1)
            peer = runtime.connect("read")
            snapshot = bytearray()
            start = None
            while True:
                frame = peer.receive()
                if frame["type"] == "screen-start":
                    start = frame
                elif frame["type"] == "screen-chunk":
                    self.assertLessEqual(len(json.dumps(frame).encode()), 32768)
                    snapshot.extend(base64.b64decode(frame["data"]))
                elif frame["type"] == "screen-end":
                    break
            self.assertEqual(len(snapshot), start["bytes"])
            self.assertTrue(b"PID:" in snapshot, "snapshot must contain child output")

    def test_heartbeat_loss_and_session_change_fence_input(self):
        for change in ("loss", "session"):
            with self.subTest(change=change), self.runtime() as runtime:
                peer = runtime.connect()
                runtime.handoff()
                lease = peer.request("acquire")
                if change == "loss": runtime.adapter.close()
                else: runtime.adapter.session = "different-session"
                time.sleep(.9)
                self.assertFalse(runtime.input(peer, lease, "forbidden")["ok"])

    def test_reclaim_during_prepare_cancels_grant(self):
        with self.runtime() as runtime:
            peer = runtime.connect()
            runtime.handoff()
            runtime.adapter.hold.clear()
            peer.send({"id": 1, "type": "acquire"})
            time.sleep(.1)
            runtime.local(b"\x1dl")
            runtime.until(b"[terminal: local]")
            runtime.adapter.hold.set()
            while True:
                frame = peer.receive()
                if frame.get("type") == "response": break
            self.assertFalse(frame["result"]["ok"])
            runtime.local(b"safe")
            runtime.until(b"73616665")

    def test_parser_output_flood_does_not_block_local_relay(self):
        child = CHILD.replace('out("PID:', 'os.write(1, b"x" * (4 * 1024 * 1024))\nout("PID:')
        with self.runtime(child=child) as runtime:
            runtime.local(b"survives")
            runtime.until(b"7375727669766573")
            self.assertIsNone(runtime.process.poll())
            runtime.until(b"remote screen unavailable")
            self.assertEqual(runtime.status()["error"], "terminal_backend_unavailable")

    def test_raw_local_interrupt_and_canonical_eof_reach_foreground_child(self):
        child = CHILD.replace("tty.setraw(0)", "pass").replace(
            'signal.signal(signal.SIGWINCH, size)',
            'signal.signal(signal.SIGWINCH, size)\nsignal.signal(signal.SIGINT, lambda *_: out("INTERRUPTED"))')
        with self.runtime(child=child) as runtime:
            runtime.local(b"\x03")
            runtime.until(b"INTERRUPTED")
            runtime.local(b"\x04")
            runtime.process.wait(5)
            self.assertEqual(runtime.process.returncode, 0)
            self.assertEqual(termios.tcgetattr(runtime.slave), runtime.before)

    def test_pending_connections_timeout_and_oversized_json_drops_peer(self):
        with self.runtime() as runtime:
            pending = Peer(runtime.dir / "terminal.sock")
            try:
                pending.sock.sendall(b"{" + b" " * 65537)
                with self.assertRaises((EOFError, ConnectionResetError)):
                    pending.receive()
            finally: pending.close()
            pending = Peer(runtime.dir / "terminal.sock")
            try:
                with self.assertRaises(EOFError): pending.receive()
            finally: pending.close()
            runtime.local(b"alive")
            runtime.until(b"616c697665")

    def test_slow_reader_is_closed_without_blocking_local_input(self):
        child = CHILD.replace('out("BYTES:" + data.hex())', '''
    if data == b"flood":
        for i in range(700):
            os.write(1, (("\\x1b[31m" + "x"*10 + "\\x1b[32m" + "y"*10)*6 + "\\r\\n").encode())
            __import__('time').sleep(.003)
    out("BYTES:" + data.hex())''')
        with self.runtime(child=child) as runtime:
            slow = runtime.connect("read")
            slow.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            runtime.local(b"flood")
            runtime.until(b"666c6f6f64", timeout=12)
            time.sleep(2.2)
            closed = False
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try: slow.receive()
                except (EOFError, ConnectionResetError):
                    closed = True
                    break
                except socket.timeout: break
            self.assertTrue(closed, "slow snapshot consumer must lose its reader slot")
            runtime.local(b"after")
            runtime.until(b"6166746572")

    def test_real_isolated_pi_starts_on_pty_without_adapter_and_remains_local(self):
        argv = [shutil.which("node"), str(ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
                "--no-extensions", "--no-skills", "--no-session", "--no-prompt-templates", "--no-themes"]
        runtime = Running(self.stage, adapter=False, argv=argv)
        try:
            runtime.until(b"v1.1.0", timeout=15)
            self.assertIsNone(runtime.process.poll())
            self.assertEqual(runtime.status()["error"], "terminal_backend_unavailable")
            runtime.local(b"\x1dw")
            runtime.until(b"[terminal: none]")
            runtime.local(b"\x1dl")
            runtime.until(b"[terminal: local]")
        finally: runtime.close()

    def test_child_descendant_process_group_is_cleaned(self):
        child = CHILD.replace('out("PID:', '''
descendant = os.fork()
if descendant == 0:
    os.setpgid(0,0)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True: signal.pause()
out("DESC:%d" % descendant)
out("PID:''')
        with self.runtime(child=child) as runtime:
            runtime.until(b"DESC:")
            pid = int(re.search(rb"DESC:(\d+)", runtime.output).group(1))
            runtime.process.send_signal(signal.SIGTERM)
            runtime.process.wait(5)
            deadline = time.monotonic() + 2
            while Path(f"/proc/{pid}/stat").exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertFalse(Path(f"/proc/{pid}/stat").exists(), "descendants must be reaped, not orphan zombies")


class ClientTests(unittest.TestCase):
    def test_client_rejects_oversized_nonobject_and_non_utf8_frames(self):
        spec = importlib.util.spec_from_file_location("terminal_client", SOURCE / "client.py")
        client = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(client)
        for data in (b"x" * 65537, b"[]\n", b'{"x":"\xff"}\n'):
            with self.assertRaises(ValueError): client.Frames().feed(data)

    def test_fixed_client_rejects_path_arguments(self):
        self.assertTrue((SOURCE / "client.py").exists(), "fixed client implementation required")
        result = subprocess.run(["/usr/bin/python3", "-I", str(SOURCE / "client.py"), "/tmp/other.sock"],
                                input=b"", capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")

    def test_real_client_frames_and_eof_close_only_its_connection(self):
        self.assertTrue((SOURCE / "client.py").exists(), "fixed client implementation required")
        parent, child = socket.socketpair()
        script = ("import sys,socket;sys.path.insert(0,sys.argv[1]);import client;"
                  "raise SystemExit(client.relay(socket.socket(fileno=int(sys.argv[2]))))")
        process = subprocess.Popen(["/usr/bin/python3", "-I", "-c", script, str(SOURCE), str(child.fileno())],
                                   pass_fds=(child.fileno(),), stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        child.close()
        parent.settimeout(3)
        try:
            process.stdin.write(b'{"v":1,"op":"status"}\n')
            process.stdin.flush()
            self.assertEqual(parent.recv(4096), b'{"v":1,"op":"status"}\n')
            parent.sendall(b'{"type":"ready"}\n')
            self.assertEqual(process.stdout.readline(), b'{"type":"ready"}\n')
            process.stdin.close()
            process.wait(3)
            self.assertEqual(parent.recv(4096), b"")
        finally:
            if process.poll() is None: process.kill()
            process.wait()
            process.stdout.close()
            parent.close()


if __name__ == "__main__":
    unittest.main()
