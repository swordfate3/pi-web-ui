#!/usr/bin/python3 -I
"""Image-owned single-child terminal supervisor. No browser-selected process paths.

Runtime's constructor is a trusted embedding API (also used by isolated source
tests); the installed CLI always uses /run/pi-runtime and its sibling broker.
Only Node writes user input to the inherited nonblocking PTY master.
"""
import base64
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import tty

DIRECTORY = "/run/pi-runtime"
NODE = "/usr/local/bin/node"
BROKER = Path(__file__).resolve().with_name("broker.cjs")
MAX_FRAME = 65536
MAX_QUEUE = 262144


class Runtime:
    profile = "web-terminal-v1"
    managed_restart_eligible = False
    restart_reason = "terminal_profile_unaudited"

    def __init__(self, directory, run_id, child_token, owner="local"):
        self.directory = Path(directory)
        stat = self.directory.lstat()
        if (not self.directory.is_dir() or self.directory.resolve() != self.directory
                or stat.st_uid != os.getuid() or stat.st_mode & 0o077
                or not re.fullmatch("[a-f0-9]{32}", run_id)
                or not re.fullmatch("[a-f0-9]{64}", child_token)
                or owner not in ("local", "none")):
            raise ValueError("invalid terminal startup")
        if (self.directory / "terminal.sock").exists():
            raise ValueError("terminal socket already exists")
        self.run_id, self.child_token, self.owner = run_id, child_token, owner
        self.epoch = os.urandom(16).hex()
        self.pending_signal = None
        self.window_changed = False
        self.child = None
        self.broker = None
        self.master = None
        self.channel = None
        self.outgoing = bytearray()
        self.display = bytearray()
        self.incoming = bytearray()
        self.screen_enabled = True
        self.prefix = False
        self.child_status = None

    def _queue(self, value, output=False):
        frame = json.dumps(value, separators=(",", ":")).encode() + b"\n"
        if len(frame) > MAX_FRAME:
            raise ValueError("terminal frame limit")
        # Reserve capacity for local control/input, independent of screen parsing.
        if output and len(self.outgoing) + len(frame) > MAX_QUEUE // 2:
            if self.screen_enabled:
                self.screen_enabled = False
                self._queue({"type": "screen-failed"})
            return
        if len(self.outgoing) + len(frame) > MAX_QUEUE:
            raise ValueError("terminal relay limit")
        self.outgoing.extend(frame)

    def _display(self, data):
        if len(self.display) + len(data) > MAX_QUEUE:
            # A blocked local terminal must not wedge the PTY or remote control.
            # Discard the bounded display backlog, never the PTY drain itself.
            self.display.clear()
            self.display.extend(b"\r\n[terminal: local display overflow]\r\n")
        self.display.extend(data)

    def _local(self, data):
        raw = bytearray()

        def flush():
            if raw:
                self._queue({"type": "local-input", "data": base64.b64encode(raw).decode()})
                raw.clear()

        for byte in data:
            if self.prefix:
                self.prefix = False
                if byte in (ord("w"), ord("l")):
                    flush()
                    self._queue({"type": "local-yield" if byte == ord("w") else "local-reclaim"})
                elif byte == 0x1d:
                    raw.append(0x1d)
                else:
                    self._display(b"\r\n[terminal: Ctrl+] w yields, Ctrl+] l reclaims, Ctrl+] Ctrl+] sends prefix]\r\n")
            elif byte == 0x1d:
                self.prefix = True
            else:
                raw.append(byte)
        flush()

    def _size(self):
        rows, columns, _, _ = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
        return max(20, min(240, columns or 120)), max(5, min(120, rows or 40))

    def _frames(self, data):
        for piece in data.splitlines(keepends=True):
            self.incoming.extend(piece)
            if len(self.incoming) > MAX_FRAME:
                raise ValueError("terminal frame limit")
            if not self.incoming.endswith(b"\n"):
                continue
            value = json.loads(self.incoming.decode("utf-8", "strict"))
            self.incoming.clear()
            if not isinstance(value, dict):
                raise ValueError("invalid terminal frame")
            kind = value.get("type")
            if kind == "owner" and value.get("owner") in ("local", "none", "remote"):
                self._display(("\r\n[terminal: " + value["owner"] + "]\r\n").encode())
            elif kind == "resize":
                columns, rows = value.get("columns"), value.get("rows")
                if type(columns) is not int or type(rows) is not int or not (20 <= columns <= 240 and 5 <= rows <= 120):
                    raise ValueError("invalid terminal size")
                fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
                self._queue({"type": "resized", "id": value["id"], "columns": columns, "rows": rows})
            elif kind == "screen-disabled":
                self.screen_enabled = False
                self._display(b"\r\n[terminal: remote screen unavailable; local input remains available]\r\n")
            elif kind == "local-input-unknown":
                self._display(b"\r\n[terminal: input delivery unknown; not retried]\r\n")
            elif kind != "started":
                raise ValueError("invalid terminal frame")

    def _groups(self):
        groups = {self.child} if self.child else set()
        # Linux session membership, not caller-supplied PIDs. Include job-control
        # descendants even after the session leader exits. Never inspect env.
        if self.child:
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    fields = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
                    if int(fields[3]) == self.child:
                        groups.add(int(fields[2]))
                except (OSError, ValueError, IndexError):
                    pass
        return groups

    def _signal_groups(self, sig):
        for group in self._groups():
            if group and group != os.getpgrp():
                try: os.killpg(group, sig)
                except ProcessLookupError: pass

    def run(self, argv):
        if not argv or not os.path.isabs(argv[0]) or not os.isatty(0) or not os.isatty(1):
            raise ValueError("terminal requires trusted absolute argv and local TTY")
        saved = termios.tcgetattr(0)
        flags = {fd: fcntl.fcntl(fd, fcntl.F_GETFL) for fd in (0, 1)}
        handlers = {}
        peer = None
        slave = None
        selector = selectors.DefaultSelector()
        result = 1
        try:
            columns, rows = self._size()
            self.master, slave = os.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            self.child = os.fork()
            if self.child == 0:
                try:
                    os.close(self.master)
                    os.setsid()
                    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                    for fd in (0, 1, 2): os.dup2(slave, fd)
                    if slave > 2: os.close(slave)
                    os.tcsetpgrp(0, os.getpgrp())
                    env = dict(os.environ)
                    env.update(PI_RUNTIME_RUN_ID=self.run_id, PI_RUNTIME_CHILD_TOKEN=self.child_token,
                               PI_RUNTIME_EXTENSION_SOCKET=str(self.directory / "adapter.sock"),
                               PI_RUNTIME_TERMINAL_EPOCH=self.epoch, PI_RUNTIME_PROFILE=self.profile)
                    os.execve(argv[0], argv, env)
                except BaseException:
                    os._exit(127)
            os.close(slave)
            slave = None
            os.set_blocking(self.master, False)
            self.channel, peer = socket.socketpair()
            self.channel.setblocking(False)
            self.broker = subprocess.Popen(
                [NODE, "--max-old-space-size=128", str(BROKER), str(self.master), str(peer.fileno())],
                pass_fds=(self.master, peer.fileno()), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
            )
            peer.close()
            peer = None
            self._queue({"type": "start", "directory": str(self.directory), "runId": self.run_id,
                         "childToken": self.child_token, "terminalEpoch": self.epoch, "owner": self.owner,
                         "columns": columns, "rows": rows})
            tty.setraw(0)
            for fd in (0, 1): os.set_blocking(fd, False)
            self._display(b"\r\n[terminal: Ctrl+] w yields; Ctrl+] l reclaims; double Ctrl+] sends prefix]\r\n")
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT, signal.SIGWINCH):
                handlers[sig] = signal.getsignal(sig)
                if sig == signal.SIGWINCH:
                    signal.signal(sig, lambda *_: setattr(self, "window_changed", True))
                else:
                    signal.signal(sig, lambda number, _: setattr(self, "pending_signal", number))
            selector.register(self.master, selectors.EVENT_READ, "pty")
            selector.register(self.channel, selectors.EVENT_READ, "broker")
            deadline = None
            while True:
                waited, status = os.waitpid(self.child, os.WNOHANG)
                if waited:
                    self.child_status = status
                    result = os.waitstatus_to_exitcode(status)
                    break
                if self.broker.poll() is not None:
                    break
                if self.pending_signal:
                    self._signal_groups(self.pending_signal)
                    self.pending_signal = None
                    deadline = time.monotonic() + 1
                if deadline and time.monotonic() >= deadline:
                    break
                if self.window_changed:
                    self.window_changed = False
                    columns, rows = self._size()
                    self._queue({"type": "local-resize", "columns": columns, "rows": rows})
                for fd, enabled, event, name in ((0, len(self.outgoing) < 65536, selectors.EVENT_READ, "input"),
                                                  (1, bool(self.display), selectors.EVENT_WRITE, "display")):
                    try: selector.unregister(fd)
                    except KeyError: pass
                    if enabled: selector.register(fd, event, name)
                selector.modify(self.channel, selectors.EVENT_READ | (selectors.EVENT_WRITE if self.outgoing else 0), "broker")
                for key, mask in selector.select(.05):
                    if key.data == "pty":
                        try: data = os.read(self.master, 32768)
                        except BlockingIOError: continue
                        except OSError as error:
                            if error.errno == errno.EIO: data = b""
                            else: raise
                        if data:
                            self._display(data)
                            if self.screen_enabled:
                                self._queue({"type": "output", "data": base64.b64encode(data).decode()}, output=True)
                    elif key.data == "input":
                        try: data = os.read(0, 8192)
                        except BlockingIOError: continue
                        if not data:
                            self.pending_signal = signal.SIGHUP
                        else: self._local(data)
                    elif key.data == "display":
                        try: del self.display[:os.write(1, self.display)]
                        except BlockingIOError: pass
                    elif key.data == "broker":
                        if mask & selectors.EVENT_WRITE:
                            try: del self.outgoing[:self.channel.send(self.outgoing)]
                            except BlockingIOError: pass
                        if mask & selectors.EVENT_READ:
                            data = self.channel.recv(65536)
                            if not data: return 1
                            self._frames(data)
        finally:
            # Restore local terminal even on partial startup or broker failure.
            termios.tcsetattr(0, termios.TCSANOW, saved)
            for fd, flag in flags.items(): fcntl.fcntl(fd, fcntl.F_SETFL, flag)
            for sig, handler in handlers.items(): signal.signal(sig, handler)
            selector.close()
            self._signal_groups(signal.SIGTERM)
            if self.broker and self.broker.poll() is None:
                self.broker.terminate()
                try: self.broker.wait(1)
                except subprocess.TimeoutExpired:
                    self.broker.kill()
                    self.broker.wait()
            self._signal_groups(signal.SIGKILL)
            if self.child and self.child_status is None:
                try: os.waitpid(self.child, 0)
                except ChildProcessError: pass
            if self.channel: self.channel.close()
            if peer: peer.close()
            if self.master is not None: os.close(self.master)
            if slave is not None: os.close(slave)
        return result if result >= 0 else 128 - result


def main():
    os.umask(0o077)
    Path(DIRECTORY).mkdir(mode=0o700, exist_ok=True)
    run_id = os.environ.get("PI_RUNTIME_RUN_ID", "")
    owner = os.environ.get("PI_PIRUN_WEB_TERMINAL_CONTROL", "local")
    if owner not in ("local", "remote"):
        raise ValueError("invalid initial terminal owner")
    return Runtime(DIRECTORY, run_id, os.urandom(32).hex(), "none" if owner == "remote" else "local").run(sys.argv[1:])


if __name__ == "__main__":
    try: sys.exit(main())
    except Exception:
        # No arbitrary exception text, argv, environment or terminal output logs.
        sys.stderr.write("terminal runtime unavailable\n")
        sys.exit(1)
