#!/usr/bin/python3 -I
"""Fixed-image stdio/Unix bridge. Gate authenticates before executing this helper.

No CLI options, environment-selected endpoint, credential, command or reconnect.
EOF/disconnect closes this helper only, never the supervisor or Pi child.
"""
import fcntl
import json
import os
import selectors
import socket
import sys
import time

SOCKET = "/run/pi-runtime/terminal.sock"
FRAME_BYTES = 65536
QUEUE_BYTES = 262144


class Frames:
    def __init__(self):
        self.pending = bytearray()

    def feed(self, chunk):
        result = bytearray()
        for piece in chunk.splitlines(keepends=True):
            self.pending.extend(piece)
            if len(self.pending) > FRAME_BYTES:
                raise ValueError("frame limit")
            if self.pending.endswith(b"\n"):
                value = json.loads(self.pending.decode("utf-8", "strict"))
                if not isinstance(value, dict):
                    raise ValueError("invalid frame")
                result.extend(self.pending)
                self.pending.clear()
        return result


def relay(connection):
    """Bridge an already-connected private socket; owns its close/EOF lifecycle."""
    selector = selectors.DefaultSelector()
    flags = {fd: fcntl.fcntl(fd, fcntl.F_GETFL) for fd in (0, 1)}
    outgoing, incoming = bytearray(), bytearray()
    stdin_frames, socket_frames = Frames(), Frames()
    deadline = time.monotonic() + 2
    received_first = False
    try:
        connection.setblocking(False)
        for fd in (0, 1): os.set_blocking(fd, False)
        selector.register(0, selectors.EVENT_READ, "stdin")
        selector.register(connection, selectors.EVENT_READ, "socket")
        while True:
            if not received_first and time.monotonic() > deadline:
                return 1
            if len(outgoing) > QUEUE_BYTES or len(incoming) > QUEUE_BYTES:
                return 1
            selector.modify(connection, selectors.EVENT_READ | (selectors.EVENT_WRITE if outgoing else 0), "socket")
            try: selector.unregister(1)
            except KeyError: pass
            if incoming: selector.register(1, selectors.EVENT_WRITE, "stdout")
            for key, mask in selector.select(.1):
                if key.data == "stdin":
                    try: data = os.read(0, 32768)
                    except BlockingIOError: continue
                    if not data: return 0
                    frames = stdin_frames.feed(data)
                    if frames: received_first = True
                    if len(outgoing) + len(frames) > QUEUE_BYTES: return 1
                    outgoing.extend(frames)
                elif key.data == "socket":
                    if mask & selectors.EVENT_WRITE:
                        try: del outgoing[:connection.send(outgoing)]
                        except BlockingIOError: pass
                    if mask & selectors.EVENT_READ:
                        data = connection.recv(32768)
                        if not data:
                            # Drain only already-complete bounded replies on a
                            # clean server half-close (e.g. one-shot status).
                            deadline = time.monotonic() + 1
                            while incoming and time.monotonic() < deadline:
                                try: del incoming[:os.write(1, incoming)]
                                except BlockingIOError:
                                    import select
                                    select.select([], [1], [], .05)
                            return 0 if not incoming and not socket_frames.pending else 1
                        frames = socket_frames.feed(data)
                        if len(incoming) + len(frames) > QUEUE_BYTES: return 1
                        incoming.extend(frames)
                elif key.data == "stdout":
                    try: del incoming[:os.write(1, incoming)]
                    except BlockingIOError: pass
    except (OSError, ValueError):
        return 1
    finally:
        connection.close()
        selector.close()
        for fd, flag in flags.items(): fcntl.fcntl(fd, fcntl.F_SETFL, flag)


def main():
    if len(sys.argv) != 1:
        return 1
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(2)
        connection.connect(SOCKET)
        return relay(connection)


if __name__ == "__main__":
    try: sys.exit(main())
    except Exception: sys.exit(1)
