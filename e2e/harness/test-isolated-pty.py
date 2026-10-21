"""Real Pi TUI acceptance using only synthetic data and Python's standard library.

Run: python3 e2e/harness/test-isolated-pty.py
PI_E2E_BIN selects an already installed Pi; PI_PTY_TUI_MODE=fullscreen is optional.
Not browser E2E, production provider, managed restart, or human authorization proof.
"""
import importlib.util
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("isolated_pty", Path(__file__).with_name("isolated-pty.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RealPiPty(unittest.TestCase):
    def setUp(self):
        self.pi = module.IsolatedPiPty()
        self.addCleanup(self.pi.cleanup)
        self.connection = self.pi.attach()
        self.sequence = 0

    def send(self, data):
        self.sequence += 1
        self.pi.send(self.connection, self.sequence, data)
        self.pi.pump(.12)

    def command(self, name):
        self.pi.output.clear()
        self.send(name.encode())
        self.send(b"\r")

    def event(self, name, count=1):
        self.pi.wait_for(lambda: len([e for e in self.pi.events() if e["event"] == name]) >= count)
        return [e for e in self.pi.events() if e["event"] == name][-1]

    def wait_exit(self):
        deadline = time.monotonic() + 8
        while self.pi.poll() is None and time.monotonic() < deadline:
            self.pi.pump()
        self.assertIsNotNone(self.pi.poll(), "isolated Pi did not exit")
        # poll keeps the exited leader unreaped to pin PGID identity until close.
        self.pi.close()
        self.assertFalse(Path(f"/proc/{self.pi.pid}").exists(), "child was not reaped")

    def test_confirmation_preview_reject_then_approve_same_process(self):
        ready = self.event("ready")
        self.assertEqual(ready["pid"], self.pi.pid)
        self.assertEqual(ready["mode"], "tui")
        self.assertTrue(ready["hasUI"] and ready["stdinTTY"] and ready["stdoutTTY"])
        self.assertEqual(os.getsid(self.pi.pid), self.pi.pid)
        self.assertEqual(os.tcgetpgrp(self.pi.fd), self.pi.pid)
        # stdin/stdout really use the same slave; opening /dev/tty is not tested.
        self.assertEqual(os.readlink(f"/proc/{self.pi.pid}/fd/0"), os.readlink(f"/proc/{self.pi.pid}/fd/1"))
        self.command("/pty-confirm-normal")
        for text in ["PTY_CONFIRM_PREVIEW_BEGIN", "SYNTHETIC ONLY: write approved.txt", "预览：中文与 emoji 🐳", "PTY_CONFIRM_PREVIEW_END"]:
            self.pi.wait_output(text)
        self.assertFalse((self.pi.workspace / "approved.txt").exists())
        self.send(b"\x1b[B")  # select No, rather than patching a UI resolver
        self.send(b"\r")
        self.assertFalse(self.event("confirm-result")["approved"])
        self.assertFalse((self.pi.workspace / "approved.txt").exists())
        self.command("/pty-confirm-normal")
        self.event("confirm-open", 2)
        self.pi.wait_output("PTY_CONFIRM_PREVIEW_END")
        self.send(b"\r")  # Yes; synthetic test data ONLY
        self.assertTrue(self.event("confirm-result", 2)["approved"])
        self.assertEqual((self.pi.workspace / "approved.txt").read_text(), "SYNTHETIC_APPROVED\n")
        self.assertEqual({e["pid"] for e in self.pi.events()}, {self.pi.pid})

    def test_timeout_and_abort_never_approve(self):
        for count, mode in enumerate(["timeout", "abort"], 1):
            self.command(f"/pty-confirm-{mode}")
            result = self.event("confirm-result", count)
            self.assertEqual(result["mode"], mode)
            self.assertFalse(result["approved"])
        self.assertFalse((self.pi.workspace / "approved.txt").exists())

    def test_custom_panel_navigation_resize_and_cancel(self):
        self.command("/pty-panel")
        self.pi.wait_output("PTY_CUSTOM_PANEL")
        self.send(b"\x1b[B")
        self.send(b"\x1b[B")
        self.send(b"\x1b[A")
        self.pi.resize(self.connection, 64, 24)
        self.pi.wait_for(lambda: any(e["event"] == "panel-render" and e["columns"] == 64 and e["rows"] == 24 for e in self.pi.events()))
        self.send(b"\r")
        self.assertEqual(self.event("panel-result")["result"], "BETA")
        self.command("/pty-panel")
        self.event("panel-open", 2)
        self.pi.wait_output("PTY_CUSTOM_PANEL")
        self.send(b"\x1b")
        self.assertEqual(self.event("panel-result", 2)["result"], "CANCELLED")
        self.assertEqual({e["pid"] for e in self.pi.events()}, {self.pi.pid})

    def test_disconnect_and_duplicate_input_are_not_replayed(self):
        self.command("/pty-panel")
        self.pi.wait_output("PTY_CUSTOM_PANEL")
        self.send(b"\x1b[B")  # selection is now BETA in the real Pi
        old = self.connection
        before = self.pi.bytes_written
        self.pi.disconnect(old)
        with self.assertRaisesRegex(RuntimeError, "fenced"):
            self.pi.send(old, self.sequence + 1, b"\r")
        self.connection = self.pi.attach()
        self.sequence = 0
        self.pi.pump(.3)
        self.assertEqual(self.pi.bytes_written, before)
        self.assertFalse(any(e["event"] == "panel-result" for e in self.pi.events()))
        with self.assertRaisesRegex(RuntimeError, "fenced"):
            self.pi.send(old, 1, b"\r")
        self.send(b"\r")
        self.assertEqual(self.event("panel-result")["result"], "BETA")
        before_duplicate = self.pi.bytes_written
        with self.assertRaisesRegex(RuntimeError, "sequence"):
            self.pi.send(self.connection, 1, b"\r")  # duplicate sequence is fenced
        self.assertEqual(self.pi.bytes_written, before_duplicate)
        self.assertIsNone(self.pi.connection)
        self.assertEqual(len([e for e in self.pi.events() if e["event"] == "panel-result"]), 1)

    def test_quit_shutdown_reaps_child_and_closes_master(self):
        fd = self.pi.fd
        self.command("/quit")
        self.wait_exit()
        self.assertEqual(self.pi.status, 0)
        self.assertEqual(self.event("shutdown")["pid"], self.pi.pid)
        with self.assertRaisesRegex(RuntimeError, "fenced"):
            self.pi.send(self.connection, self.sequence + 1, b"\r")
        self.pi.close()
        self.assertIsNone(self.pi.fd)
        with self.assertRaises(OSError):
            os.fstat(fd)
        with patch.object(module.os, "killpg", side_effect=AssertionError("closed target reused")):
            self.pi.close()  # idempotent means no further signals

    def test_host_termination_during_open_confirmation(self):
        self.command("/pty-confirm-normal")
        self.pi.wait_output("PTY_CONFIRM_PREVIEW_END")
        os.killpg(self.pi.pid, signal.SIGTERM)
        self.wait_exit()
        self.assertFalse((self.pi.workspace / "approved.txt").exists())
        self.pi.close()
        self.assertIsNone(self.pi.fd)


class GroupCleanup(unittest.TestCase):
    def test_exited_leader_is_pinned_until_stubborn_descendant_is_killed(self):
        # Subreaper affects only this isolated Python helper, never the runner/session.
        script = r'''
import ctypes, importlib.util, os, pty, select, signal, sys, time
spec = importlib.util.spec_from_file_location("pty_harness", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0  # PR_SET_CHILD_SUBREAPER
ready_r, ready_w = os.pipe()
life_r, life_w = os.pipe()  # helper owns writer; its death releases the grandchild
leader = os.fork()
if leader == 0:
    os.close(ready_r)
    os.close(life_w)
    os.setsid()
    descendant = os.fork()
    if descendant == 0:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        os.write(ready_w, (str(os.getpid()) + "\n").encode())
        # Ignore TERM for the cleanup test, but never outlive the helper or a 10s deadline.
        if select.select([life_r], [], [], 10)[0]: os.read(life_r, 1)
        os._exit(0)
    os._exit(0)
os.close(ready_w)
os.close(life_r)
p = m.IsolatedPiPty.__new__(m.IsolatedPiPty)
p.pid, p.status, p.closed, p.connection = leader, None, False, None
p.fd, slave = pty.openpty(); os.close(slave)
os.set_blocking(p.fd, False); p.output = bytearray()
descendant = None
try:
    assert select.select([ready_r], [], [], 5)[0], "descendant startup timeout"
    descendant = int(os.read(ready_r, 100).strip())
    print(descendant, flush=True)  # synthetic helper output, never a Pi extension stream
    assert select.select([sys.stdin], [], [], 5)[0], "pidfd handshake timeout"
    assert sys.stdin.buffer.readline() == b"observed\n", "pidfd observer missing"
    if sys.argv[2] == "hang":
        while True: time.sleep(1)
    deadline = time.monotonic() + 5
    while p.poll() is None and time.monotonic() < deadline: time.sleep(.01)
    assert p.poll() == 0, "leader must exit first"
    assert os.path.exists(f"/proc/{leader}"), "leader must remain pinned, not reaped"
    assert os.getpgid(descendant) == leader
    p.close()
    assert not os.path.exists(f"/proc/{leader}")
    # This is the actual grandchild, now reparented to the helper, not just another group member.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        pid, status = os.waitpid(descendant, os.WNOHANG)
        if pid:
            descendant = None  # identity released: clear BEFORE any assertion can throw
            expected = signal.SIGTERM if sys.argv[2] == "wrong-exit" else signal.SIGKILL
            assert os.waitstatus_to_exitcode(status) == -expected, "synthetic exit mismatch"
            break
        time.sleep(.01)
    assert descendant is None, "stubborn descendant survived group cleanup"
    m.os.killpg = lambda *_: (_ for _ in ()).throw(AssertionError("repeated signal"))
    p.close()
finally:
    p.close()
    os.close(ready_r)
    os.close(life_w)
    if descendant is not None:
        os.kill(descendant, signal.SIGKILL)
        os.waitpid(descendant, 0)
'''
        for mode in ["normal", "wrong-exit", "hang"]:
            with self.subTest(mode=mode):
                helper = subprocess.Popen(
                    [sys.executable, "-I", "-B", "-c", script,
                     str(Path(__file__).with_name("isolated-pty.py")), mode],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                )
                pidfd = None
                try:
                    self.assertTrue(select.select([helper.stdout], [], [], 5)[0], "helper startup timeout")
                    descendant = int(helper.stdout.readline().strip())
                    time.sleep(.15)  # force observer delay; helper must not reap before acknowledgement
                    pidfd = os.pidfd_open(descendant)
                    helper.stdin.write(b"observed\n")
                    helper.stdin.flush()
                    if mode == "hang":
                        with self.assertRaises(subprocess.TimeoutExpired):
                            helper.communicate(timeout=.2)
                        helper.kill()  # simulate outer timeout bypassing all helper finally blocks
                    _, error = helper.communicate(timeout=8)
                    self.assertTrue(select.select([pidfd], [], [], 3)[0], "descendant survived helper cleanup/death")
                    if mode == "normal":
                        self.assertEqual(helper.returncode, 0, error.decode())
                    elif mode == "wrong-exit":
                        self.assertNotEqual(helper.returncode, 0)
                        self.assertIn(b"synthetic exit mismatch", error)
                        self.assertNotIn(b"ProcessLookupError", error)
                finally:
                    if helper.poll() is None:
                        helper.kill()
                    helper.communicate(timeout=3)
                    if pidfd is not None:
                        os.close(pidfd)
                    helper.stdout.close()
                    helper.stderr.close()


if __name__ == "__main__":

    unittest.main(verbosity=2)
