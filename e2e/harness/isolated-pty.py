"""Linux-only synthetic PTY experiment, NOT a production broker or security boundary.

No listener, shell launcher, provider credentials, managed runtime, or replay queue.
A connection here is a local test handle, not a browser authorization grant.
"""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]


class IsolatedPiPty:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi-web-ui-pty-")
        self.directory = Path(self.temp.name)
        self.workspace = self.directory / "workspace"
        self.workspace.mkdir()
        agent = self.directory / "agent"
        agent.mkdir()
        home = self.directory / "home"
        home.mkdir()
        (agent / "settings.json").write_text(json.dumps({
            "packages": [], "quietStartup": True,
            "tuiMode": os.environ.get("PI_PTY_TUI_MODE", "regular"),
        }))
        executable = os.environ.get("PI_E2E_BIN", str(ROOT / "node_modules/.bin/pi"))
        executable = shutil.which(executable)
        if not executable:
            self.temp.cleanup()
            raise RuntimeError("PI_E2E_BIN is not an existing executable; no installation attempted")
        # Deliberate allowlist: do not inherit API keys, runtime credentials or NODE_OPTIONS guard.
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"), "TMPDIR": str(self.directory),
            "LANG": "C.UTF-8", "TERM": "xterm-256color", "COLORTERM": "truecolor",
            "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1",
            "PI_WEB_UI_PTY_FIXTURE": "1", "NODE_OPTIONS": "",
        }
        args = [executable, "--no-session", "--no-extensions", "--no-skills",
                "--no-prompt-templates", "--no-context-files", "--no-tools", "--approve",
                "--model", "faux/faux-1", "--api-key", "synthetic-no-network",
                "--extension", str(ROOT / "e2e/fixtures/faux-provider-extension.ts"),
                "--extension", str(ROOT / "e2e/fixtures/pty-ui-extension.ts")]
        self.fd = None
        self.pid = None
        self.status = None
        self.closed = False
        self.output = bytearray()
        self.output_truncated = False
        self.connection = None
        self.next_connection = 0
        self.next_sequence = 1
        self.bytes_written = 0
        try:
            # forkpty establishes a new session and controlling terminal, not just redirected pipes.
            pid, fd = pty.fork()
            if pid == 0:
                try:
                    os.chdir(self.workspace)
                    termios.tcsetwinsize(0, (40, 120))
                    os.closerange(3, 65536)
                    os.execve(executable, args, env)
                except BaseException:
                    os._exit(127)
            self.pid, self.fd = pid, fd
            os.set_blocking(fd, False)
            self.wait_for(lambda: any(e["event"] == "ready" for e in self.events()), 20)
            self.wait_output("PTY_FIXTURE_READY")
            self.pump(.2)
        except BaseException:
            self.close()
            self.temp.cleanup()
            raise

    def events(self):
        file = self.workspace / "pty-events.jsonl"
        if not file.exists():
            return []
        # Ignore only an incomplete final append, never malformed committed JSON.
        lines = file.read_text().splitlines(keepends=True)
        return [json.loads(line) for line in lines if line.endswith("\n")]

    def poll(self):
        if self.pid is not None and self.status is None and not self.closed:
            # Observe exit but retain the zombie leader until group cleanup is finished.
            # This pins its PID/PGID against reuse while close() still needs to signal it.
            result = os.waitid(os.P_PID, self.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if result is not None:
                self.status = result.si_status if result.si_code == os.CLD_EXITED else -result.si_status
        return self.status

    def pump(self, seconds=.05):
        deadline = time.monotonic() + seconds
        while self.fd is not None and time.monotonic() < deadline:
            if not select.select([self.fd], [], [], min(.05, max(0, deadline - time.monotonic())))[0]:
                continue
            try:
                chunk = os.read(self.fd, 32768)
            except BlockingIOError:
                continue
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            self.output.extend(chunk)
            if len(self.output) > 1048576:
                self.output_truncated = True
                del self.output[:-1048576]
        self.poll()

    def wait_for(self, predicate, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            self.pump()
            if self.poll() is not None:
                raise AssertionError(f"isolated Pi exited early ({self.status})")
        raise AssertionError("isolated PTY condition timed out (output intentionally not logged)")

    def wait_output(self, text):
        self.wait_for(lambda: text.encode() in self.output)

    def attach(self):
        if self.connection is not None or self.poll() is not None:
            raise RuntimeError("test connection unavailable")
        self.next_connection += 1
        self.connection = self.next_connection
        self.next_sequence = 1
        return self.connection

    def disconnect(self, connection):
        if connection == self.connection:
            self.connection = None
        # No queued input to transfer/retry. PTY stays open to drain output.

    def send(self, connection, sequence, data):
        if connection != self.connection or self.connection is None or self.poll() is not None:
            raise RuntimeError("test connection fenced")
        if sequence != self.next_sequence or not isinstance(data, bytes) or not 0 < len(data) <= 8192:
            self.disconnect(connection)
            raise RuntimeError("test input sequence/size rejected")
        self.next_sequence += 1
        try:
            count = os.write(self.fd, data)
            self.bytes_written += count
            if count != len(data):
                raise RuntimeError("partial PTY delivery; no automatic retry")
        except BaseException:
            self.disconnect(connection)
            raise

    def resize(self, connection, columns, rows):
        if connection != self.connection or self.connection is None or self.poll() is not None:
            raise RuntimeError("test connection fenced")
        if not 20 <= columns <= 240 or not 5 <= rows <= 120:
            raise ValueError("test size out of bounds")
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def close(self):
        if self.closed:
            return
        self.connection = None
        if self.pid is not None:
            # Leader is never reaped by poll(): keep its identity pinned through the final signal.
            # Only same-process-group descendants are covered; setsid/setpgid escape is not tracked.
            try:
                os.killpg(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 3
            while self.poll() is None and time.monotonic() < deadline:
                self.pump()
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, status = os.waitpid(self.pid, 0)
            self.status = os.waitstatus_to_exitcode(status)
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        self.closed = True

    def cleanup(self):
        self.close()
        self.temp.cleanup()
