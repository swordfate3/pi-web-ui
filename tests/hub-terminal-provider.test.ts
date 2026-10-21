import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as provider from "../hub/terminal-provider.ts";
import * as wire from "../hub/terminal-wire.ts";

const target = {
  v: 1 as const,
  runId: "a".repeat(32),
  runtimeId: "runtime",
  sessionId: "session",
  terminalEpoch: "b".repeat(32),
  profile: "web-terminal-v1" as const,
  inputState: "none" as const,
  managedRestartEligible: false as const,
};
const binding = { authorizationId: "c".repeat(32), connectionId: "d".repeat(32) };
async function fixture(t: test.TestContext, accept: (socket: net.Socket) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "task5-provider-"));
  const credentialFile = path.join(dir, "token");
  writeFileSync(credentialFile, "e".repeat(64), { mode: 0o600 });
  const socketPath = path.join(dir, "provider.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
    accept(s);
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, credentialFile, socketPath, config: { credentialFile, socketPath } };
}
test("provider status uses only its private token and validates immutable identity", async (t) => {
  let opening: unknown;
  const f = await fixture(t, (s) =>
    s.once("data", (b) => {
      opening = JSON.parse(b.toString());
      s.end(`${JSON.stringify({ type: "ready", target })}\n`);
    }),
  );
  assert.deepEqual(await provider.terminalProviderStatus(f.config, target.runId), target);
  assert.deepEqual(opening, { v: 1, op: "status", token: "e".repeat(64), runId: target.runId });
  await assert.rejects(provider.terminalProviderStatus(f.config, "f".repeat(32)), /unavailable/);
});
test("provider missing or stalled first frame fails closed at two seconds without retry", {
  timeout: 5000,
}, async (t) => {
  let connections = 0;
  const f = await fixture(t, () => {
    connections++;
  });
  const started = Date.now();
  await assert.rejects(provider.terminalProviderStatus(f.config, target.runId), /unavailable/);
  assert.ok(Date.now() - started >= 1900 && Date.now() - started < 3000);
  assert.equal(connections, 1);
});
test("coalesced ready and initial snapshot are delivered once even before connect continuation", async (t) => {
  const f = await fixture(t, (s) =>
    s.once("data", () =>
      s.write(
        [
          { type: "ready", target },
          { type: "screen-start", target, sequence: 0, columns: 80, rows: 24, bytes: 3, chunks: 1 },
          { type: "screen-chunk", terminalEpoch: target.terminalEpoch, sequence: 0, index: 0, data: "5Lit" },
          { type: "screen-end", terminalEpoch: target.terminalEpoch, sequence: 0 },
        ]
          .map((v) => `${JSON.stringify(v)}\n`)
          .join(""),
      ),
    ),
  );
  const snapshots: unknown[] = [];
  let delivered!: () => void;
  const seen = new Promise<void>((r) => {
    delivered = r;
  });
  const client = await provider.connectTerminalProvider(f.config, target, "read", binding, {
    onSnapshot(value) {
      snapshots.push(value);
      delivered();
    },
    onUnavailable() {},
  });
  await seen;
  assert.deepEqual(snapshots, [{ sequence: 0, columns: 80, rows: 24, data: "中" }]);
  client.close();
});
test("provider validates correlated ACKs and missing input ACK is unknown, never replayed", async (t) => {
  const requests: unknown[] = [];
  const f = await fixture(t, (s) => {
    let first = true;
    s.on("data", (b) => {
      for (const line of b.toString().trim().split("\n")) {
        const v = JSON.parse(line);
        requests.push(v);
        if (first) {
          first = false;
          s.write(`${JSON.stringify({ type: "ready", target })}\n`);
        } else s.destroy();
      }
    });
  });
  const client = await provider.connectTerminalProvider(f.config, target, "write", binding, {
    onSnapshot() {},
    onUnavailable() {},
  });
  const result = await client.request({
    id: 1,
    v: 1,
    type: "input",
    terminalEpoch: target.terminalEpoch,
    leaseId: "f".repeat(32),
    sequence: 1,
    data: "中文\r",
  });
  assert.deepEqual(result, { ok: false, delivery: "unknown", error: "input_delivery_unknown" });
  assert.equal(requests.length, 2);
  client.close();
});
test("provider narrow token reader rejects symlinks, world modes, hard links and untrusted parents", async (t) => {
  const f = await fixture(t, () => {});
  assert.equal(provider.readTerminalProviderSecret(f.credentialFile), "e".repeat(64));
  chmodSync(f.credentialFile, 0o644);
  assert.throws(() => provider.readTerminalProviderSecret(f.credentialFile));
  chmodSync(f.credentialFile, 0o640);
  assert.throws(
    () => provider.readTerminalProviderSecret(f.credentialFile),
    "owner private layout cannot impersonate root group layout",
  );
  chmodSync(f.credentialFile, 0o600);
  symlinkSync(f.credentialFile, path.join(f.dir, "link"));
  assert.throws(() => provider.readTerminalProviderSecret(path.join(f.dir, "link")));
  linkSync(f.credentialFile, path.join(f.dir, "hardlink"));
  assert.throws(() => provider.readTerminalProviderSecret(f.credentialFile));
  unlinkSync(path.join(f.dir, "hardlink"));
  mkdirSync(path.join(f.dir, "unsafe"), { mode: 0o777 });
  chmodSync(path.join(f.dir, "unsafe"), 0o777);
  writeFileSync(path.join(f.dir, "unsafe/token"), "e".repeat(64), { mode: 0o600 });
  assert.throws(() => provider.readTerminalProviderSecret(path.join(f.dir, "unsafe/token")));
});
test("eight pending private clients cap admission before a ninth socket; close aborts pending readiness", {
  timeout: 5000,
}, async (t) => {
  let accepted = 0;
  const f = await fixture(t, () => {
    accepted++;
  });
  const pending = Array.from({ length: 8 }, () => provider.terminalProviderStatus(f.config, target.runId));
  await assert.rejects(provider.terminalProviderStatus(f.config, target.runId), /unavailable/);
  const results = await Promise.allSettled(pending);
  assert.equal(results.filter((v) => v.status === "rejected").length, 8);
  assert.equal(accepted, 8);
});
test("healthy continuous partial frames advance only at frame completion; byte trickling still closes", {
  timeout: 9000,
}, async (t) => {
  const timers: NodeJS.Timeout[] = [];
  t.after(() => timers.forEach(clearTimeout));
  const frames = [
    `${JSON.stringify({ type: "screen-start", target, sequence: 0, columns: 80, rows: 24, bytes: 3, chunks: 1 })}\n`,
    JSON.stringify({ type: "screen-chunk", terminalEpoch: target.terminalEpoch, sequence: 0, index: 0, data: "5Lit" }) +
      "\n",
    `${JSON.stringify({ type: "screen-end", terminalEpoch: target.terminalEpoch, sequence: 0 })}\n`,
  ];
  const f = await fixture(t, (s) =>
    s.once("data", () => {
      s.write(`${JSON.stringify({ type: "ready", target })}\n${frames[0].slice(0, 8)}`);
      for (let index = 0; index < 3; index++)
        timers.push(
          setTimeout(
            () => s.write(frames[index].slice(8) + (frames[index + 1]?.slice(0, 8) ?? "")),
            (index + 1) * 1100,
          ),
        );
    }),
  );
  let delivered!: () => void;
  const seen = new Promise<void>((r) => {
    delivered = r;
  });
  const client = await provider.connectTerminalProvider(f.config, target, "read", binding, {
    onSnapshot() {
      delivered();
    },
    onUnavailable() {},
  });
  await seen;
  client.close();
  const trickle = await fixture(t, (s) =>
    s.once("data", () => {
      s.write(`${JSON.stringify({ type: "ready", target })}\n{"type":`);
      timers.push(
        setInterval(() => {
          if (!s.destroyed) s.write(" ");
        }, 200),
      );
    }),
  );
  let ended!: () => void;
  const end = new Promise<void>((r) => {
    ended = r;
  });
  const start = Date.now();
  const bad = await provider.connectTerminalProvider(trickle.config, target, "read", binding, {
    onSnapshot() {
      assert.fail("trickled frame must not produce snapshot");
    },
    onUnavailable() {
      ended();
    },
  });
  await end;
  assert.ok(Date.now() - start >= 1900 && Date.now() - start < 2900);
  bad.close();
});
test("provider rejects duplicate keys and replaced readiness without content diagnostics", async (t) => {
  for (const raw of [
    `{"type":"ready","type":"ready","target":${JSON.stringify(target)}}\n`,
    `${JSON.stringify({ type: "ready", target: { ...target, sessionId: "changed" } })}\n`,
  ]) {
    const f = await fixture(t, (s) => s.once("data", () => s.write(raw)));
    await assert.rejects(
      provider.connectTerminalProvider(f.config, target, "read", binding, {
        onSnapshot() {
          assert.fail();
        },
        onUnavailable() {},
      }),
      /unavailable/,
    );
  }
});
test("closed wire rejects duplicate JSON, malformed Unicode, unknown fields and corrupted snapshot ordering", () => {
  assert.throws(() => wire.parseTerminalJson('{"type":"ready","type":"error"}'));
  assert.throws(() => wire.parseTerminalJson('{"data":"\\ud800"}'));
  const assembly = new wire.TerminalSnapshotAssembly(target);
  assert.equal(
    assembly.accept({ type: "screen-start", target, sequence: 0, columns: 80, rows: 24, bytes: 3, chunks: 1 }),
    undefined,
  );
  assert.throws(() =>
    assembly.accept({ type: "screen-chunk", terminalEpoch: target.terminalEpoch, sequence: 0, index: 1, data: "YWJj" }),
  );
  const valid = new wire.TerminalSnapshotAssembly(target);
  valid.accept({ type: "screen-start", target, sequence: 0, columns: 80, rows: 24, bytes: 3, chunks: 1 });
  valid.accept({ type: "screen-chunk", terminalEpoch: target.terminalEpoch, sequence: 0, index: 0, data: "5Lit" });
  assert.deepEqual(valid.accept({ type: "screen-end", terminalEpoch: target.terminalEpoch, sequence: 0 }), {
    sequence: 0,
    columns: 80,
    rows: 24,
    data: "中",
  });
  const input = {
    id: 1,
    v: 1,
    type: "input",
    terminalEpoch: target.terminalEpoch,
    leaseId: "f".repeat(32),
    sequence: 1,
    data: "x".repeat(8192),
  };
  assert.equal(wire.parseTerminalRequest(input).type, "input");
  assert.throws(() => wire.parseTerminalRequest({ ...input, data: "x".repeat(8193) }));
  for (const invalid of [
    { bytes: 1048577, chunks: 52 },
    { columns: 241 },
    { rows: 121 },
    { target: { ...target, sessionId: "replaced" } },
  ]) {
    assert.throws(() =>
      new wire.TerminalSnapshotAssembly(target).accept({
        type: "screen-start",
        target,
        sequence: 0,
        columns: 240,
        rows: 120,
        bytes: 0,
        chunks: 0,
        ...invalid,
      }),
    );
  }
  assert.throws(() => wire.parseTerminalJson(JSON.stringify({ data: "x".repeat(65536) })));
});

test("coalesced subsequent snapshots cannot queue behind one stalled assembly consumer", {
  timeout: 5000,
}, async (t) => {
  const frames = [{ type: "ready", target }];
  const encoded = `${JSON.stringify(frames[0])}\n${[0, 1]
    .flatMap((sequence) => [
      { type: "screen-start", target, sequence, columns: 80, rows: 24, bytes: 0, chunks: 0 },
      { type: "screen-end", terminalEpoch: target.terminalEpoch, sequence },
    ])
    .map((value) => `${JSON.stringify(value)}\n`)
    .join("")}`;
  const f = await fixture(t, (socket) => socket.once("data", () => socket.write(encoded)));
  let snapshots = 0,
    finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const client = await provider.connectTerminalProvider(f.config, target, "read", binding, {
    onSnapshot() {
      snapshots++;
      return new Promise<void>(() => {});
    },
    onUnavailable() {
      finish();
    },
  });
  await closed;
  assert.equal(snapshots, 1, "paused parsing must not dispatch an unbounded snapshot backlog");
  client.close();
});
