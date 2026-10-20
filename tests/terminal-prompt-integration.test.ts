import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startPiWebUi } from "../e2e/harness/pi-process.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for fixture event");
}

test("real ctx.ui.confirm emits metadata and reconnect snapshot; Web cannot approve; trusted RPC ends wait", {
  timeout: 45_000,
}, async () => {
  const rpcEvents: Record<string, unknown>[] = [];
  const harness = await startPiWebUi("basic", {
    repositoryRoot: root,
    git: false,
    extraExtensions: [path.join(root, "e2e/fixtures/terminal-prompt-extension.ts")],
    onRpcEvent: (event) => rpcEvents.push(event),
  });
  const sockets: WebSocket[] = [];
  const connect = () => {
    const messages: {
      type?: string;
      event?: string;
      id?: string;
      ok?: boolean;
      error: string;
      payload: Record<string, unknown>;
    }[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
    sockets.push(socket);
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    return { socket, messages };
  };
  try {
    const first = connect();
    await waitFor(() => first.messages.find((m) => m.event === "state_sync"));
    const command = harness.rpc({ type: "prompt", message: "/test-terminal-confirm" });
    const start = await waitFor(() => first.messages.find((m) => m.event === "ui_prompt_start"));
    assert.equal(start.payload.kind, "confirm");
    assert.equal(start.payload.title, "Synthetic terminal confirmation");
    assert.equal(start.payload.message, undefined);
    const request = await waitFor(() =>
      rpcEvents.find((e) => e.type === "extension_ui_request" && e.method === "confirm"),
    );
    assert.equal(request.message, "PRIVATE_FIXTURE_BODY_NOT_FOR_WS");
    first.socket.send(
      JSON.stringify({
        type: "req",
        id: "hostile",
        method: "extension_ui_response",
        params: { id: request.id, confirmed: true },
      }),
    );
    const response = await waitFor(() => first.messages.find((m) => m.type === "res" && m.id === "hostile"));
    assert.equal(response.ok, false);
    assert.match(response.error, /unsupported|terminal/i);
    assert.equal(
      first.messages.some((m) => m.event === "ui_prompt_end"),
      false,
    );
    first.socket.close();
    const second = connect();
    const sync = await waitFor(() => second.messages.find((m) => m.event === "state_sync"));
    assert.deepEqual(sync.payload.terminalPrompt, { kind: "confirm", title: "Synthetic terminal confirmation" });
    harness.respondToUI(String(request.id), false);
    await command;
    await waitFor(() => second.messages.find((m) => m.event === "ui_prompt_end"));
    await waitFor(() => rpcEvents.find((e) => e.message === "FIXTURE_REJECTED_BY_RPC"));
    assert.equal(
      JSON.stringify([...first.messages, ...second.messages]).includes("PRIVATE_FIXTURE_BODY_NOT_FOR_WS"),
      false,
    );
    const third = connect();
    const after = await waitFor(() => third.messages.find((m) => m.event === "state_sync"));
    assert.equal(after.payload.terminalPrompt, null);
  } finally {
    for (const socket of sockets) socket.terminate();
    await harness.stop();
  }
});

for (const mode of ["timeout", "abort"] as const) {
  test(`real ctx.ui.confirm ${mode} emits SDK end and clears reconnect snapshot without Web approval`, {
    timeout: 45_000,
  }, async () => {
    const rpcEvents: Record<string, unknown>[] = [];
    const harness = await startPiWebUi("basic", {
      repositoryRoot: root,
      git: false,
      extraExtensions: [path.join(root, "e2e/fixtures/terminal-prompt-extension.ts")],
      onRpcEvent: (event) => rpcEvents.push(event),
    });
    const sockets: WebSocket[] = [];
    const connect = () => {
      const messages: {
        type?: string;
        event?: string;
        id?: string;
        ok?: boolean;
        error: string;
        payload: Record<string, unknown>;
      }[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
      sockets.push(socket);
      socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
      return { socket, messages };
    };
    try {
      const first = connect();
      const initial = await waitFor(() => first.messages.find((m) => m.event === "state_sync"));
      assert.equal(initial.payload.terminalPrompt, null);
      const command = harness.rpc({ type: "prompt", message: `/test-terminal-confirm-${mode}` });
      const start = await waitFor(() => first.messages.find((m) => m.event === "ui_prompt_start"));
      assert.equal(start.payload.kind, "confirm");
      assert.equal(start.payload.title, `Synthetic terminal confirmation ${mode}`);
      assert.equal(start.payload.message, undefined);
      const request = await waitFor(() =>
        rpcEvents.find((e) => e.type === "extension_ui_request" && e.method === "confirm"),
      );
      assert.equal(request.message, "PRIVATE_FIXTURE_BODY_NOT_FOR_WS");
      // The abort case has no timeout fallback: only AbortController may settle it.
      assert.equal(request.timeout, mode === "timeout" ? 100 : undefined);
      first.socket.send(
        JSON.stringify({
          type: "req",
          id: "hostile",
          method: "extension_ui_response",
          params: { id: request.id, confirmed: true },
        }),
      );
      const response = await waitFor(() => first.messages.find((m) => m.type === "res" && m.id === "hostile"));
      assert.equal(response.ok, false);
      assert.match(response.error, /unsupported|terminal/i);
      // No trusted RPC response is sent. This is the real SDK lifecycle event,
      // forwarded by mirror-server after the dialog's timeout/signal settles it.
      const end = await waitFor(() => first.messages.find((m) => m.event === "ui_prompt_end"));
      assert.deepEqual(end.payload, start.payload);
      assert.ok(first.messages.indexOf(end) > first.messages.indexOf(start));
      await command;
      await waitFor(() => rpcEvents.find((e) => e.message === `FIXTURE_CANCELLED_BY_${mode.toUpperCase()}`));
      assert.equal(
        rpcEvents.some((e) => e.message === "FIXTURE_UNEXPECTED_APPROVAL"),
        false,
      );
      assert.equal(first.messages.filter((m) => m.event === "ui_prompt_start").length, 1);
      assert.equal(first.messages.filter((m) => m.event === "ui_prompt_end").length, 1);

      first.socket.close();
      const reconnected = connect();
      const sync = await waitFor(() => reconnected.messages.find((m) => m.event === "state_sync"));
      assert.equal(sync.payload.terminalPrompt, null);
      assert.equal(
        JSON.stringify([...first.messages, ...reconnected.messages]).includes("PRIVATE_FIXTURE_BODY_NOT_FOR_WS"),
        false,
      );
    } finally {
      for (const socket of sockets) socket.terminate();
      await harness.stop();
    }
  });
}
