"""Direct real-worker IPC failure acceptance; no production config or credentials."""
import base64
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
import unittest


class StreamWorker(unittest.TestCase):
    def setUp(self):
        self.worker = subprocess.Popen(
            [sys.executable, "-I", "-B", str(Path(__file__).with_name("pty-stream-worker.py"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={key: value for key, value in os.environ.items()
                 if key in ["PATH", "PI_E2E_BIN", "PI_PTY_TUI_MODE"]},
        )
        self.addCleanup(self.cleanup)
        self.buffer = bytearray()
        self.messages = []
        self.received_types = []
        self.output_bytes = 0
        self.ready = self.message(lambda value: value["type"] == "ready", timeout=25)
        self.pid = self.ready["pid"]
        self.epoch = self.ready["terminalEpoch"]
        self.sequence = 0

    def message(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for message in self.messages:
                if predicate(message):
                    self.messages.remove(message)
                    return message
            if not select.select([self.worker.stdout], [], [], .05)[0]:
                continue
            chunk = os.read(self.worker.stdout.fileno(), 32768)
            if not chunk:
                self.fail("worker pipe closed before expected synthetic response")
            self.buffer.extend(chunk)
            while b"\n" in self.buffer:
                line, _, rest = self.buffer.partition(b"\n")
                self.buffer = bytearray(rest)
                value = json.loads(line)
                self.received_types.append(value["type"])
                if value["type"] == "output":
                    self.output_bytes += len(base64.b64decode(value["data"], validate=True))
                else:
                    self.messages.append(value)
        self.fail("worker IPC response timed out; raw terminal output intentionally omitted")

    def request(self, kind, **fields):
        self.sequence += 1
        request = {"id": self.sequence, "type": kind, **fields}
        self.worker.stdin.write((json.dumps(request) + "\n").encode())
        self.worker.stdin.flush()
        return self.message(lambda value: value["type"] == "ack" and value["id"] == self.sequence)

    def grant(self, lease="a" * 32):
        return self.request("grant", terminalEpoch=self.epoch, leaseId=lease, expiresInMs=30000)

    def assert_stopped(self):
        self.worker.communicate(timeout=8)
        self.assertFalse(Path(f"/proc/{self.pid}").exists(), "isolated Pi was not reaped")

    def cleanup(self):
        if self.worker.poll() is None:
            if self.worker.stdin is not None and not self.worker.stdin.closed:
                self.worker.stdin.close()
                self.worker.stdin = None
            try:
                self.worker.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                self.worker.terminate()
                self.worker.communicate(timeout=25)
        else:
            self.worker.communicate(timeout=3)

    def test_sink_checks_epoch_lease_and_sequence_before_writing(self):
        base = {"terminalEpoch": self.epoch, "leaseId": "a" * 32}
        self.assertFalse(self.request("input", **base, sequence=1, data="\r")["ok"])
        self.assertTrue(self.grant()["ok"])
        self.assertFalse(self.grant("b" * 32)["ok"], "active lease cannot be overwritten")
        self.assertFalse(self.request("revoke", terminalEpoch=self.epoch, leaseId="b" * 32)["ok"])
        self.assertFalse(self.request("input", terminalEpoch="0" * 32, leaseId="a" * 32, sequence=1, data="\r")["ok"])
        self.assertTrue(self.request("input", **base, sequence=1, data="/pty-panel")["ok"])
        self.assertFalse(self.request("input", **base, sequence=1, data="\r")["ok"])
        self.assertFalse(self.request("input", **base, sequence=2, data="\r")["ok"], "duplicate fenced sink lease")
        self.assertTrue(self.request("revoke", **base)["ok"], "already revoked cleanup is idempotent")
        self.assertTrue(self.grant("b" * 32)["ok"])

    def test_startup_barrier_and_ordered_resize_geometry(self):
        self.assertTrue(self.request("barrier")["ok"])
        self.assertGreater(self.output_bytes, 0, "startup prefix must precede barrier ACK")
        self.assertTrue(self.grant()["ok"])
        start = len(self.received_types)
        self.assertTrue(self.request("resize", terminalEpoch=self.epoch, leaseId="a" * 32,
                                     columns=64, rows=24)["ok"])
        ordered = self.received_types[start:]
        self.assertIn("geometry", ordered)
        self.assertLess(ordered.index("geometry"), ordered.index("ack"))
        geometry = self.message(lambda value: value["type"] == "geometry")
        self.assertEqual((geometry["columns"], geometry["rows"]), (64, 24))

    def test_parent_pipe_eof_reaps_pi(self):
        self.worker.stdin.close()
        self.worker.stdin = None
        self.assert_stopped()

    def test_worker_sigterm_reaps_pi(self):
        self.worker.send_signal(signal.SIGTERM)
        self.assert_stopped()

    def test_malformed_ipc_fails_closed(self):
        # Distinct worker per unittest: choose duplicate-key JSON (not silently last-wins).
        self.worker.stdin.write(b'{"id":1,"type":"stop","type":"input"}\n')
        self.worker.stdin.flush()
        self.assert_stopped()
        self.assertNotEqual(self.worker.returncode, 0)

    def test_oversized_ipc_fails_closed(self):
        self.worker.stdin.write(b"x" * 65537 + b"\n")
        self.worker.stdin.flush()
        self.assert_stopped()
        self.assertNotEqual(self.worker.returncode, 0)

    def test_unterminated_frame_times_out_and_reaps_pi(self):
        self.worker.stdin.write(b'{"id":')
        self.worker.stdin.flush()
        # communicate() would close stdin and test EOF instead of the partial-frame deadline.
        deadline = time.monotonic() + 6
        while self.worker.poll() is None and time.monotonic() < deadline:
            if select.select([self.worker.stdout], [], [], .05)[0]:
                os.read(self.worker.stdout.fileno(), 32768)
        self.assertIsNotNone(self.worker.poll(), "partial-frame deadline did not stop worker")
        self.assert_stopped()
        self.assertNotEqual(self.worker.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
