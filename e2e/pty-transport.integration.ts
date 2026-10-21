import assert from "node:assert/strict";
import { existsSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { startPtyTransport } from "./harness/pty-transport.ts";

type Message = {
  type: string;
  data: string;
  sequence: number;
  bytesWritten: number;
  leaseId: string;
  screenAvailable: boolean;
  target: { managedRestartEligible: false };
};
class Client {
  readonly socket: Socket;
  readonly messages: Message[] = [];
  output = Buffer.alloc(0);
  closed = false;
  private buffer = "";
  constructor(socketPath: string) {
    this.socket = createConnection(socketPath);
    this.socket.on("error", () => {
      this.closed = true;
    });
    this.socket.on("close", () => {
      this.closed = true;
    });
    this.socket.on("data", (bytes) => {
      this.buffer += bytes.toString();
      while (this.buffer.includes("\n")) {
        const end = this.buffer.indexOf("\n");
        const value: Message = JSON.parse(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 1);
        this.messages.push(value);
        if (value.type === "output") this.output = Buffer.concat([this.output, Buffer.from(value.data, "base64")]);
      }
    });
  }
  async wait(predicate: () => boolean, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Synthetic PTY condition timed out; output not logged");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  send(value: unknown) {
    this.socket.write(`${JSON.stringify(value)}\n`);
  }
  async response(value: unknown, type: string) {
    const count = this.messages.length;
    this.send(value);
    await this.wait(() => this.messages.slice(count).some((m) => m.type === type));
    return this.messages.slice(count).find((m) => m.type === type) as Message;
  }
  async auth(token: string) {
    return this.response({ type: "auth", token }, "attached");
  }
  close() {
    this.socket.destroy();
  }
}

async function scenario(t: TestContext) {
  const transport = await startPtyTransport();
  t.after(async () => transport.close());
  const connect = async (access: "read" | "write" = "write") => {
    const client = new Client(transport.socketPath);
    t.after(() => client.close());
    const attached = await client.auth(access === "write" ? transport.writeToken : transport.readToken);
    assert.equal(attached.screenAvailable, false, "live raw output is NOT a reconnect screen");
    assert.equal(attached.target.managedRestartEligible, false);
    return client;
  };
  const workspace = readlinkSync(`/proc/${transport.piPid}/cwd`);
  const events = () =>
    readFileSync(`${workspace}/pty-events.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { transport, connect, workspace, events };
}
function controller(client: Client, epoch: string, leaseId: string) {
  let sequence = 0;
  return {
    async input(data: string) {
      const message = { v: 1, type: "input", terminalEpoch: epoch, leaseId, sequence: ++sequence, data };
      const result = await client.response(message, "written");
      assert.equal(result.sequence, sequence);
      assert.equal(result.bytesWritten, Buffer.byteLength(data));
      return message;
    },
    async command(text: string) {
      client.output = Buffer.alloc(0);
      await this.input(text);
      await this.input("\r");
    },
  };
}

test("private Unix transport authenticates distinct access; rejects readers and malformed frames", {
  timeout: 30000,
}, async (t) => {
  const { transport, connect } = await scenario(t);
  assert.equal(statSync(transport.socketPath).mode & 0o777, 0o600);
  const bad = new Client(transport.socketPath);
  t.after(() => bad.close());
  bad.send({ type: "auth", token: "wrong" });
  await bad.wait(() => bad.closed);
  const reader = await connect("read");
  await reader.response({ type: "control", terminalEpoch: transport.target.terminalEpoch }, "denied");
  const writer = await connect();
  const lease = await writer.response({ type: "control", terminalEpoch: transport.target.terminalEpoch }, "control");
  assert.match(lease.leaseId, /^[a-f0-9]{32}$/);
  reader.send({
    v: 1,
    type: "input",
    terminalEpoch: transport.target.terminalEpoch,
    leaseId: lease.leaseId,
    sequence: 1,
    data: "\r",
  });
  await reader.wait(() => reader.closed);
  const partial = await connect("read");
  partial.socket.write('{"type":');
  await partial.wait(() => partial.closed, 4000);
});

test("real pipes and Unix socket carry native confirm preview, rejection and synthetic approval in the same Pi", {
  timeout: 30000,
}, async (t) => {
  const { transport, connect, workspace, events } = await scenario(t);
  const client = await connect();
  const lease = await client.response({ type: "control", terminalEpoch: transport.target.terminalEpoch }, "control");
  const control = controller(client, transport.target.terminalEpoch, lease.leaseId);
  await control.command("/pty-confirm-normal");
  for (const text of ["PTY_CONFIRM_PREVIEW_BEGIN", "预览：中文与 emoji 🐳", "PTY_CONFIRM_PREVIEW_END"])
    await client.wait(() => client.output.includes(Buffer.from(text)));
  assert.equal(existsSync(`${workspace}/approved.txt`), false);
  await control.input("\x1b[B");
  await control.input("\r");
  await client.wait(() => events().some((e) => e.event === "confirm-result"));
  assert.equal(events().find((e) => e.event === "confirm-result").approved, false);
  assert.equal(existsSync(`${workspace}/approved.txt`), false);
  await control.command("/pty-confirm-normal");
  await client.wait(() => client.output.includes(Buffer.from("PTY_CONFIRM_PREVIEW_END")));
  await control.input("\r");
  await client.wait(() => existsSync(`${workspace}/approved.txt`));
  assert.equal(readFileSync(`${workspace}/approved.txt`, "utf8"), "SYNTHETIC_APPROVED\n");
  assert.deepEqual([...new Set(events().map((e) => e.pid))], [transport.piPid]);
});

test("one writer; actual socket disconnect revokes sink before explicit new grant, without replay", {
  timeout: 30000,
}, async (t) => {
  const { transport, connect, events } = await scenario(t);
  const epoch = transport.target.terminalEpoch;
  const first = await connect();
  const lease = await first.response({ type: "control", terminalEpoch: epoch }, "control");
  const second = await connect();
  await second.response({ type: "control", terminalEpoch: epoch }, "denied");
  const control = controller(first, epoch, lease.leaseId);
  await control.command("/pty-panel");
  await first.wait(() => first.output.includes(Buffer.from("PTY_CUSTOM_PANEL")));
  await control.input("\x1b[B");
  first.close();
  await first.wait(() => first.closed);
  // Wait for revoked sink, not for command completion. A new owner is never automatic.
  await second.wait(() => transport.controlState === "none");
  assert.equal(
    events().some((e) => e.event === "panel-result"),
    false,
  );
  const next = await second.response({ type: "control", terminalEpoch: epoch }, "control");
  assert.notEqual(next.leaseId, lease.leaseId);
  const nextControl = controller(second, epoch, next.leaseId);
  await nextControl.input("\r");
  await second.wait(() => events().some((e) => e.event === "panel-result"));
  assert.equal(events().find((e) => e.event === "panel-result").result, "BETA");
  const output = second.messages.filter((m) => m.type === "output");
  assert.ok(output.every((m, i) => i === 0 || m.sequence > output[i - 1].sequence));
});

test("duplicate sequence and stale epoch fence actual input; native panel resize reaches Pi", {
  timeout: 30000,
}, async (t) => {
  const { transport, connect, events } = await scenario(t);
  const epoch = transport.target.terminalEpoch;
  const client = await connect();
  const lease = await client.response({ type: "control", terminalEpoch: epoch }, "control");
  const control = controller(client, epoch, lease.leaseId);
  await control.command("/pty-panel");
  await client.wait(() => client.output.includes(Buffer.from("PTY_CUSTOM_PANEL")));
  const down = await control.input("\x1b[B");
  await client.response(
    { type: "resize", terminalEpoch: epoch, leaseId: lease.leaseId, columns: 64, rows: 24 },
    "resized",
  );
  await client.wait(() => events().some((e) => e.event === "panel-render" && e.columns === 64 && e.rows === 24));
  client.send(down);
  await client.wait(() => client.closed);
  await client.wait(() => transport.controlState === "none");
  const replacement = await connect();
  const next = await replacement.response({ type: "control", terminalEpoch: epoch }, "control");
  const nextControl = controller(replacement, epoch, next.leaseId);
  await nextControl.input("\r");
  await replacement.wait(() => events().some((e) => e.event === "panel-result"));
  assert.equal(events().find((e) => e.event === "panel-result").result, "BETA", "duplicate Down did not reach PTY");
  replacement.send({
    v: 1,
    type: "input",
    terminalEpoch: "0".repeat(32),
    leaseId: next.leaseId,
    sequence: 2,
    data: "/pty-panel\r",
  });
  await replacement.wait(() => replacement.closed);
  assert.equal(events().filter((e) => e.event === "panel-open").length, 1);
});

test("real fixed lease expires without input renewal; successor needs explicit grant", {
  timeout: 45000,
}, async (t) => {
  const { transport, connect, events } = await scenario(t);
  const epoch = transport.target.terminalEpoch;
  const first = await connect();
  const lease = await first.response({ type: "control", terminalEpoch: epoch }, "control");
  const control = controller(first, epoch, lease.leaseId);
  await control.command("/pty-panel");
  await first.wait(() => first.output.includes(Buffer.from("PTY_CUSTOM_PANEL")));
  await control.input("\x1b[B");
  await first.wait(() => first.closed, 32000);
  assert.equal(
    events().some((e) => e.event === "panel-result"),
    false,
  );
  const successor = await connect();
  const next = await successor.response({ type: "control", terminalEpoch: epoch }, "control");
  assert.notEqual(next.leaseId, lease.leaseId);
  await controller(successor, epoch, next.leaseId).input("\r");
  await successor.wait(() => events().some((e) => e.event === "panel-result"));
  assert.equal(events().find((e) => e.event === "panel-result").result, "BETA");
});

test("disconnect while input is paused before sink admission discards queued Enter", { timeout: 30000 }, async (t) => {
  const { transport, connect, workspace, events } = await scenario(t);
  const client = await connect();
  const lease = await client.response({ type: "control", terminalEpoch: transport.target.terminalEpoch }, "control");
  const control = controller(client, transport.target.terminalEpoch, lease.leaseId);
  await control.command("/pty-confirm-normal");
  await client.wait(() => client.output.includes(Buffer.from("PTY_CONFIRM_PREVIEW_END")));
  const directory = path.dirname(transport.socketPath);
  writeFileSync(path.join(directory, "pause-before-write"), "");
  client.send({
    v: 1,
    type: "input",
    terminalEpoch: transport.target.terminalEpoch,
    leaseId: lease.leaseId,
    sequence: 3,
    data: "\r",
  });
  await client.wait(() => existsSync(path.join(directory, "input-paused")));
  client.close();
  await client.wait(() => client.closed && transport.controlState === "revoking");
  assert.equal(existsSync(path.join(directory, lease.leaseId)), false);
  unlinkSync(path.join(directory, "pause-before-write"));
  await client.wait(() => transport.controlState === "none");
  assert.equal(existsSync(`${workspace}/approved.txt`), false);
  assert.equal(
    events().some((e) => e.event === "confirm-result"),
    false,
  );
  const successor = await connect();
  const next = await successor.response({ type: "control", terminalEpoch: transport.target.terminalEpoch }, "control");
  await controller(successor, transport.target.terminalEpoch, next.leaseId).input("\x1b");
  await successor.wait(() => events().some((e) => e.event === "confirm-result"));
  assert.equal(events().find((e) => e.event === "confirm-result").approved, false);
});

test("stopped worker resumes into bounded cleanup rather than leaving Pi alive", { timeout: 35000 }, async (t) => {
  const { transport, connect } = await scenario(t);
  const client = await connect();
  const pid = transport.piPid;
  assert.ok(transport.workerPid);
  process.kill(transport.workerPid, "SIGSTOP");
  const started = Date.now();
  await transport.close();
  assert.ok(Date.now() - started < 12000);
  await client.wait(() => client.closed);
  assert.equal(existsSync(`/proc/${pid}`), false);
  assert.equal(existsSync(transport.socketPath), false);
});

test("shutdown closes real clients, removes socket and reaps the only Pi", { timeout: 30000 }, async (t) => {
  const { transport, connect } = await scenario(t);
  const client = await connect();
  const pid = transport.piPid;
  await transport.close();
  await client.wait(() => client.closed);
  assert.equal(existsSync(`/proc/${pid}`), false);
  assert.equal(existsSync(transport.socketPath), false);
  await transport.close();
});
