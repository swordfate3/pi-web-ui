"""Private JSONL IPC worker for the isolated forkpty experiment.

This is a local test harness, not a production terminal broker. Its stdin and
stdout are private parent/worker pipes; Pi itself continues to use one forkpty
process and its PTY output is forwarded as raw bytes, never as a screen snapshot.
"""
import base64
import errno
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import select
import signal
import time

MAX_FRAME_BYTES = 65536
MAX_OUTPUT_BYTES = 32768
MAX_INPUT_BYTES = 8192
MAX_SAFE_INTEGER = (1 << 53) - 1
MAX_OUTPUT_BUFFER = 1048576
LEASE_SECONDS = 30.0
WORKER_SECONDS = 120.0
PARTIAL_FRAME_SECONDS = 2.0
PIPE_WRITE_SECONDS = 2.0
LEASE_ID_RE = re.compile(r"[0-9a-fA-F]{32}\Z")


class ProtocolError(Exception):
    """A malformed or out-of-schema private IPC frame."""


class WorkerShutdown(Exception):
    """Stop work on a handled termination signal and clean up normally."""


_shutdown_requested = False


def _handle_shutdown_signal(_signum, _frame):
    global _shutdown_requested
    # Do not interrupt forkpty construction between fork() and storing the child
    # PID/fd; let the constructor finish (or its own timeout clean it up), then
    # return through run_worker()'s finally block.
    _shutdown_requested = True


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(_value):
    raise ProtocolError("non-standard JSON constant")


def _is_safe_integer(value, minimum=1):
    return (isinstance(value, int) and not isinstance(value, bool)
            and minimum <= value <= MAX_SAFE_INTEGER)


def _parse_request(frame):
    try:
        request = json.loads(
            frame.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ProtocolError, ValueError) as error:
        raise ProtocolError("invalid JSON frame") from error

    if not isinstance(request, dict):
        raise ProtocolError("request must be an object")
    request_id = request.get("id")
    if not _is_safe_integer(request_id):
        raise ProtocolError("invalid request id")

    request_type = request.get("type")
    schemas = {
        "grant": {"id", "type", "terminalEpoch", "leaseId", "expiresInMs"},
        "revoke": {"id", "type", "terminalEpoch", "leaseId"},
        "input": {"id", "type", "terminalEpoch", "leaseId", "sequence", "data"},
        "resize": {"id", "type", "terminalEpoch", "leaseId", "columns", "rows"},
        "stop": {"id", "type"},
        "barrier": {"id", "type"},
    }
    if not isinstance(request_type, str) or request_type not in schemas:
        raise ProtocolError("unknown request type")
    if set(request) != schemas[request_type]:
        raise ProtocolError("request fields do not match schema")

    if request_type not in ("stop", "barrier"):
        epoch = request["terminalEpoch"]
        if not isinstance(epoch, str) or LEASE_ID_RE.fullmatch(epoch) is None:
            raise ProtocolError("invalid terminal epoch")
        lease_id = request["leaseId"]
        if not isinstance(lease_id, str) or LEASE_ID_RE.fullmatch(lease_id) is None:
            raise ProtocolError("invalid lease id")

    if request_type == "grant":
        if (not isinstance(request["expiresInMs"], int)
                or isinstance(request["expiresInMs"], bool)
                or request["expiresInMs"] != 30000):
            raise ProtocolError("invalid grant duration")
    elif request_type == "input":
        if not _is_safe_integer(request["sequence"]):
            raise ProtocolError("invalid input sequence")
        data = request["data"]
        if not isinstance(data, str):
            raise ProtocolError("input data must be a string")
        try:
            encoded = data.encode("utf-8", errors="strict")
        except UnicodeEncodeError as error:
            raise ProtocolError("input contains an isolated surrogate") from error
        if not 1 <= len(encoded) <= MAX_INPUT_BYTES:
            raise ProtocolError("input size out of bounds")
        request["_encodedData"] = encoded
    elif request_type == "resize":
        columns, rows = request["columns"], request["rows"]
        if (not isinstance(columns, int) or isinstance(columns, bool)
                or not 20 <= columns <= 240
                or not isinstance(rows, int) or isinstance(rows, bool)
                or not 5 <= rows <= 120):
            raise ProtocolError("terminal dimensions out of bounds")

    return request


def _load_isolated_pty_class():
    path = Path(__file__).with_name("isolated-pty.py")
    spec = importlib.util.spec_from_file_location("pi_web_ui_isolated_pty", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load isolated PTY harness")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.IsolatedPiPty


class PtyStreamWorker:
    def __init__(self, pi, terminal_epoch, deadline):
        self.pi = pi
        self.terminal_epoch = terminal_epoch
        self.deadline = deadline
        self.active = None
        self.input_buffer = bytearray()
        self.partial_started = None
        self.pty_eof = False
        # Fixed private fixture directory, never supplied by a socket client.
        self.fence_directory = Path(os.environ["PI_PTY_FENCE_DIR"]) if "PI_PTY_FENCE_DIR" in os.environ else None

    def _write_message(self, message):
        payload = (json.dumps(message, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
        fd = 1
        offset = 0
        deadline = min(time.monotonic() + PIPE_WRITE_SECONDS, self.deadline)
        while offset < len(payload):
            if _shutdown_requested:
                raise WorkerShutdown()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("private stdout pipe write timed out")
            try:
                _readable, writable, _exceptional = select.select([], [fd], [], min(remaining, 0.1))
            except InterruptedError:
                continue
            if _shutdown_requested:
                raise WorkerShutdown()
            if not writable:
                if time.monotonic() >= deadline:
                    raise TimeoutError("private stdout pipe write timed out")
                continue
            if _shutdown_requested:
                raise WorkerShutdown()
            try:
                written = os.write(fd, payload[offset:])
            except BlockingIOError:
                continue
            if written <= 0:
                raise BrokenPipeError("private stdout pipe closed")
            offset += written

    def _ack(self, request_id, ok, bytes_written=None):
        message = {"type": "ack", "id": request_id, "ok": bool(ok)}
        if ok and bytes_written is not None:
            message["bytesWritten"] = bytes_written
        self._write_message(message)

    def _emit_output(self, data):
        for offset in range(0, len(data), MAX_OUTPUT_BYTES):
            chunk = data[offset:offset + MAX_OUTPUT_BYTES]
            self._write_message({
                "type": "output",
                "data": base64.b64encode(chunk).decode("ascii"),
            })

    def _append_to_pi_output(self, data):
        self.pi.output.extend(data)
        if len(self.pi.output) > MAX_OUTPUT_BUFFER:
            del self.pi.output[:-MAX_OUTPUT_BUFFER]

    def _drain_pty(self, max_chunks=8):
        """Drain a bounded batch from the sole PTY reader; return true at EAGAIN/EOF."""
        if self.pty_eof or self.pi.fd is None:
            return True
        for _ in range(max_chunks):
            if time.monotonic() >= self.deadline:
                return False
            try:
                data = os.read(self.pi.fd, MAX_OUTPUT_BYTES)
            except BlockingIOError:
                return True
            except OSError as error:
                if error.errno == errno.EIO:
                    self.pty_eof = True
                    return True
                raise
            if not data:
                self.pty_eof = True
                return True
            self._append_to_pi_output(data)
            self._emit_output(data)
        return False

    def _disconnect_active(self):
        active, self.active = self.active, None
        if active is not None:
            self.pi.disconnect(active["connection"])

    def _expire_active(self):
        if self.active is not None and time.monotonic() >= self.active["deadline"]:
            self._disconnect_active()

    def _emit_exit_if_needed(self):
        code = self.pi.poll()
        if code is None:
            return False
        # Flush bytes already queued in the PTY before the terminal exit notice.
        if not self._drain_pty():
            return False
        self._write_message({"type": "exit", "code": code})
        return True

    def _authorized_active(self, request):
        self._expire_active()
        active = self.active
        return (active is not None
                and request["terminalEpoch"] == self.terminal_epoch
                and request["leaseId"] == active["leaseId"]
                and time.monotonic() < active["deadline"]
                and (self.fence_directory is None
                     or (self.fence_directory / active["leaseId"]).is_file()))

    def _process_request(self, request):
        if _shutdown_requested:
            return False
        request_id = request["id"]
        request_type = request["type"]
        self._expire_active()

        if request_type == "stop":
            self._ack(request_id, True)
            return False

        if request_type == "barrier":
            # Fixed test startup barrier: startup bytes are emitted before its ACK.
            # Not an extension completion or application execution barrier.
            self._ack(request_id, True)
            return True

        if request_type == "grant":
            if (request["terminalEpoch"] != self.terminal_epoch
                    or self.active is not None):
                self._ack(request_id, False)
                return True
            try:
                connection = self.pi.attach()
            except RuntimeError:
                if self._emit_exit_if_needed():
                    return False
                self._ack(request_id, False)
                return True
            self.active = {
                "leaseId": request["leaseId"],
                "connection": connection,
                "deadline": time.monotonic() + LEASE_SECONDS,
                "sequence": 1,
            }
            self._ack(request_id, True)
            return True

        if request_type == "revoke":
            if request["terminalEpoch"] != self.terminal_epoch:
                self._ack(request_id, False)
            elif self.active is None:
                # Idempotent fence: an already expired/revoked lease is done.
                self._ack(request_id, True)
            elif request["leaseId"] == self.active["leaseId"]:
                self._disconnect_active()
                self._ack(request_id, True)
            else:
                # Never let a stale revoke disconnect a later active lease.
                self._ack(request_id, False)
            return True

        if request_type == "input":
            if not self._authorized_active(request):
                self._ack(request_id, False)
                return True
            active = self.active
            sequence = request["sequence"]
            if sequence != active["sequence"] or sequence != self.pi.next_sequence:
                self._disconnect_active()
                self._ack(request_id, False)
                return True
            # Synthetic fault injection only, not a socket command or production feature.
            if self.fence_directory is not None:
                pause = self.fence_directory / "pause-before-write"
                if pause.exists():
                    (self.fence_directory / "input-paused").touch()
                    pause_deadline = min(time.monotonic() + 2, self.deadline)
                    while pause.exists() and time.monotonic() < pause_deadline:
                        if _shutdown_requested:
                            return False
                        time.sleep(.01)
            # Independent marker check is the sink admission linearization point.
            # Once passed, revoke can race the one syscall: in-flight/unknown,
            # NOT guaranteed cancelled by disconnect or any previous ACK.
            if (not self._authorized_active(request)
                    or self.active is not active
                    or sequence != active["sequence"]
                    or sequence != self.pi.next_sequence):
                self._ack(request_id, False)
                return True
            data = request["_encodedData"]
            before = self.pi.bytes_written
            try:
                self.pi.send(active["connection"], sequence, data)
            except Exception:
                self._disconnect_active()
                if self._emit_exit_if_needed():
                    return False
                self._ack(request_id, False)
                return True
            written = self.pi.bytes_written - before
            if written != len(data):
                self._disconnect_active()
                self._ack(request_id, False)
                return True
            active["sequence"] += 1
            self._ack(request_id, True, written)
            return True

        if request_type == "resize":
            if not self._authorized_active(request):
                self._ack(request_id, False)
                return True
            active_connection = self.active["connection"]
            # Recheck all fences immediately before the ioctl that changes PTY size.
            if (not self._authorized_active(request) or self.active is None
                    or self.active["connection"] != active_connection):
                self._ack(request_id, False)
                return True
            try:
                self.pi.resize(active_connection, request["columns"], request["rows"])
            except Exception:
                if self._emit_exit_if_needed():
                    return False
                self._ack(request_id, False)
                return True
            self._write_message({"type": "geometry", "columns": request["columns"], "rows": request["rows"]})
            self._ack(request_id, True)
            return True

        raise ProtocolError("unknown request type")

    def _consume_input(self):
        while True:
            if _shutdown_requested:
                return False
            newline = self.input_buffer.find(b"\n")
            if newline < 0:
                if len(self.input_buffer) > MAX_FRAME_BYTES:
                    raise ProtocolError("JSONL frame exceeds size limit")
                if self.input_buffer and self.partial_started is None:
                    self.partial_started = time.monotonic()
                elif not self.input_buffer:
                    self.partial_started = None
                return True
            if newline > MAX_FRAME_BYTES:
                raise ProtocolError("JSONL frame exceeds size limit")
            frame = bytes(self.input_buffer[:newline])
            del self.input_buffer[:newline + 1]
            request = _parse_request(frame)
            if not self._process_request(request):
                return False
            if not self.input_buffer:
                self.partial_started = None
            elif self.partial_started is None:
                self.partial_started = time.monotonic()

    def _read_stdin(self):
        try:
            chunk = os.read(0, MAX_FRAME_BYTES + 1)
        except BlockingIOError:
            return True
        if not chunk or _shutdown_requested:
            return False
        if not self.input_buffer:
            self.partial_started = time.monotonic()
        self.input_buffer.extend(chunk)
        return self._consume_input()

    def run(self):
        # Pi's constructor already pumped some startup bytes. They remain a raw
        # stream prefix after ready, not a claim that a full terminal screen exists.
        if self.pi.output_truncated:
            raise ProtocolError("startup terminal stream incomplete")
        startup_output = bytes(self.pi.output)
        os.set_blocking(0, False)
        os.set_blocking(1, False)
        self._write_message({
            "type": "ready",
            "terminalEpoch": self.terminal_epoch,
            "pid": self.pi.pid,
        })
        self._emit_output(startup_output)
        self.pi.output.clear()

        while True:
            if _shutdown_requested:
                return
            self._expire_active()
            if self._emit_exit_if_needed():
                return
            now = time.monotonic()
            if now >= self.deadline:
                return
            if self.partial_started is not None:
                partial_deadline = self.partial_started + PARTIAL_FRAME_SECONDS
                if now >= partial_deadline:
                    raise ProtocolError("partial JSONL frame timed out")
            else:
                partial_deadline = self.deadline

            timeout = min(0.1, self.deadline - now, partial_deadline - now)
            if self.active is not None:
                timeout = min(timeout, max(0.0, self.active["deadline"] - now))
            read_fds = [0]
            if not self.pty_eof:
                read_fds.append(self.pi.fd)
            readable, _writable, _exceptional = select.select(read_fds, [], [], timeout)
            if _shutdown_requested:
                return
            now = time.monotonic()
            if now >= self.deadline:
                return
            if (self.partial_started is not None
                    and now >= self.partial_started + PARTIAL_FRAME_SECONDS):
                raise ProtocolError("partial JSONL frame timed out")

            if self.pi.fd in readable:
                self._drain_pty()
                if self._emit_exit_if_needed():
                    return
            if 0 in readable and not self._read_stdin():
                return


def run_worker():
    worker_deadline = time.monotonic() + WORKER_SECONDS
    pi = None
    try:
        isolated_pty_class = _load_isolated_pty_class()
        if _shutdown_requested or time.monotonic() >= worker_deadline:
            return
        pi = isolated_pty_class()
        if _shutdown_requested or time.monotonic() >= worker_deadline:
            return
        worker = PtyStreamWorker(pi, secrets.token_hex(16), worker_deadline)
        worker.run()
    finally:
        if pi is not None:
            pi.cleanup()


def main():
    signal.signal(signal.SIGTERM, _handle_shutdown_signal)
    signal.signal(signal.SIGHUP, _handle_shutdown_signal)
    try:
        run_worker()
        return 0
    except WorkerShutdown:
        return 0
    except BaseException:
        # No exception text or Pi/PTY output is allowed onto the private protocol pipe.
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
