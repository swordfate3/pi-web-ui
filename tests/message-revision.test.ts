import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type RawData, WebSocket } from "ws";
import {
  checkRevisionTextBudget,
  MAX_REVISION_TEXT_BYTES,
  matchesRevisionDispatch,
  type RevisionEntry,
  resolveMessageRevision,
  revisionContent,
} from "../extensions/message-revision.ts";

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

const image1 = { type: "image" as const, data: "AAAB/w==", mimeType: "image/png" };
const image2 = { type: "image" as const, data: "AP8BBA==", mimeType: "image/webp" };
const fullText = `  original\n${"long complete question ".repeat(4000)}\nend  `;
function entries(): RevisionEntry[] {
  return [
    { id: "u0", parentId: null, type: "message", message: { role: "user", content: "older question" } },
    { id: "a0", parentId: "u0", type: "message", message: { role: "assistant", content: [] } },
    {
      id: "u1",
      parentId: "a0",
      type: "message",
      message: {
        role: "user",
        content: [image1, { type: "text", text: fullText }, image2, { type: "text", text: "last block" }],
      },
    },
    { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [] } },
    { id: "tool", parentId: "a1", type: "message", message: { role: "toolResult", content: [] } },
    { id: "meta", parentId: "tool", type: "custom" },
    { id: "a2", parentId: "meta", type: "message", message: { role: "assistant", content: [] } },
    { id: "other", parentId: "a0", type: "message", message: { role: "user", content: "unrelated newer branch" } },
  ];
}

test("revision uses the nearest raw parent-chain user, full text and all original image bytes", () => {
  const raw = entries();
  const before = JSON.stringify(raw);
  const original = resolveMessageRevision((id) => raw.find((entry) => entry.id === id), "a2", "regenerate");
  assert.equal(original.userEntryId, "u1");
  assert.equal(original.text, `${fullText}\nlast block`);
  assert.equal(original.hasImages, true);
  assert.deepEqual(revisionContent(original, "regenerate", undefined), raw[2].message?.content);
  assert.deepEqual(revisionContent(original, "edit", "  edited\ntext  "), [
    image1,
    { type: "text", text: "  edited\ntext  " },
    image2,
  ]);
  assert.equal(JSON.stringify(raw), before, "no raw session entry is mutated");
  assert.throws(() => revisionContent(original, "edit", " \n"), /empty/);
  assert.throws(() => revisionContent(original, "regenerate", "client replacement"), /original question/);
  for (const [id, mode] of [
    ["a1", "edit"],
    ["u1", "regenerate"],
    ["tool", "regenerate"],
    ["missing", "edit"],
    ["u1", "invalid"],
  ]) {
    assert.throws(() => resolveMessageRevision((key) => raw.find((entry) => entry.id === key), id, mode));
  }
});

test("unsupported attachments, malformed chains, empty originals and JSON-escaped over-budget text fail closed", () => {
  const raw = entries();
  const lookup = (id: string) => raw.find((entry) => entry.id === id);
  required(raw[2].message).content = [{ type: "audio", data: "must not lose" }];
  assert.throws(() => resolveMessageRevision(lookup, "a2", "regenerate"), /unsupported/);
  required(raw[2].message).content = [{ type: "image", data: 12, mimeType: "image/png" }];
  assert.throws(() => resolveMessageRevision(lookup, "u1", "edit"), /malformed/);
  required(raw[2].message).content = "";
  assert.throws(() => resolveMessageRevision(lookup, "u1", "edit"), /empty/);
  required(raw[2].message).content = [image1];
  const imageOnly = resolveMessageRevision(lookup, "u1", "edit");
  assert.equal(imageOnly.text, "");
  assert.deepEqual(revisionContent(imageOnly, "edit", "caption"), [{ type: "text", text: "caption" }, image1]);
  raw[5].parentId = "a2";
  assert.throws(() => resolveMessageRevision(lookup, "a2", "regenerate"), /parent chain/);
  raw[5].parentId = "missing";
  assert.throws(() => resolveMessageRevision(lookup, "a2", "regenerate"), /parent chain/);
  checkRevisionTextBudget("a".repeat(MAX_REVISION_TEXT_BYTES - 2));
  assert.throws(() => checkRevisionTextBudget("a".repeat(MAX_REVISION_TEXT_BYTES)), /too large/);
  assert.throws(() => checkRevisionTextBudget("\u0001".repeat(400_000)), /no text was truncated/);
  assert.throws(() => checkRevisionTextBudget("中".repeat(800_000)), /too large/);
});

test("dispatch matching follows Pi text/image layout but rejects transforms and changed parents", () => {
  const expected = {
    parentId: "a0",
    content: resolveMessageRevision((id) => entries().find((entry) => entry.id === id), "a2", "regenerate").content,
  };
  const content = [{ type: "text", text: `${fullText}\nlast block` }, image1, image2];
  assert.equal(matchesRevisionDispatch(expected, "a0", content), true);
  assert.equal(matchesRevisionDispatch(expected, "other", content), false);
  assert.equal(matchesRevisionDispatch(expected, "a0", [{ type: "text", text: "transformed" }, image1, image2]), false);
  assert.equal(matchesRevisionDispatch(expected, "a0", [content[0], image2, image1]), false);
  assert.equal(
    matchesRevisionDispatch(expected, "a0", [content[0], { ...image1, mimeType: "image/jpeg" }, image2]),
    false,
  );
});

test("dispatch accepts only a bounded, valid system-only chain to the exact parent", () => {
  const expected = { parentId: "a0", content: [image1, { type: "text" as const, text: "exact" }] };
  const content = [{ type: "text", text: "exact" }, image1];
  const system = (id: string, parentId: string | null): RevisionEntry => ({
    id,
    parentId,
    type: "message",
    message: { role: "system", content: "" },
  });
  const raw = [system("s1", "a0"), system("s2", "s1")];
  const lookup = (id: string) => raw.find((entry) => entry.id === id);
  for (const leaf of ["a0", "s1", "s2"]) {
    assert.equal(matchesRevisionDispatch(expected, leaf, content, lookup), true);
    assert.equal(matchesRevisionDispatch(expected, leaf, "different", lookup), false);
    assert.equal(matchesRevisionDispatch(expected, leaf, [content[0], { ...image1, data: "changed" }], lookup), false);
    assert.equal(
      matchesRevisionDispatch(expected, leaf, [content[0], { ...image1, mimeType: "image/jpeg" }], lookup),
      false,
    );
  }
  for (const entry of [
    system("s1", "other"),
    system("s1", "missing"),
    system("s1", "s2"),
    system("s1", "s1"),
    system("wrong-id", "a0"),
    system("s1", ""),
    system("s1", undefined as never),
    ...["user", "assistant", "toolResult", "custom", "unknown"].map((role) => ({
      ...system("s1", "a0"),
      message: { role },
    })),
    ...["custom", "model_change", "session_info", "unknown"].map((type) => ({ ...system("s1", "a0"), type })),
  ]) {
    raw[0] = entry;
    assert.equal(matchesRevisionDispatch(expected, "s2", content, lookup), false, JSON.stringify(entry));
  }
  assert.equal(
    matchesRevisionDispatch(expected, "s1", content, () => system("wrong-id", "a0")),
    false,
  );
  const chain = Array.from({ length: 65 }, (_, i) => system(`p${i}`, i ? `p${i - 1}` : "a0"));
  const get = (id: string) => chain.find((entry) => entry.id === id);
  assert.equal(matchesRevisionDispatch(expected, "p63", content, get), true);
  assert.equal(matchesRevisionDispatch(expected, "p64", content, get), false);
  assert.equal(
    matchesRevisionDispatch({ parentId: null, content: "root" }, "s", "root", () => system("s", null)),
    true,
  );
});

test("mock mirror revision WS contract and lifecycle/dispatch fences", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-revision-"));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const env = {
    PI_WEB_UI_PORT: String(port),
    PI_WEB_UI_HOST: "127.0.0.1",
    PI_WEB_UI_DISABLED: "1",
    PI_WEB_UI_STATIC_DIR: root,
    PI_CODING_AGENT_DIR: root,
    PI_WEB_UI_REGISTRY_SOCKET: "",
    PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: "",
    PI_WEB_UI_PUBLIC_URL: "",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  // /webui grants the command context without opening a real browser/subprocess.
  const execMock = t.mock.method(childProcess, "execFile", (() => ({})) as never);
  syncBuiltinESMExports();
  t.after(() => {
    execMock.mock.restore();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const events = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  let raw = entries();
  let leaf: string | null = "a2";
  let sessionId = "revision-session";
  let idle = true;
  let pending = false;
  let ctxGeneration = 0;
  let sendThrows = false;
  let compactCalls = 0;
  let getModels: () => Promise<Array<{ provider: string; id: string }>> = async () => [];
  let setModelImpl: () => Promise<boolean> = async () => true;
  const sends: Array<{ content: unknown; options: unknown }> = [];
  const navigations: Array<{ target: string; options: unknown }> = [];
  let navigate: () => Promise<{ cancelled: boolean }>;
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of events.get(name) ?? []) await handler(event, context());
  };
  function context() {
    const generation = ctxGeneration;
    const check = () => assert.equal(generation, ctxGeneration, "must not read a captured stale context");
    return {
      cwd: root,
      model: undefined,
      modelRegistry: { getAvailable: () => getModels() },
      signal: undefined,
      ui: { notify() {}, setStatus() {} },
      isIdle() {
        check();
        return idle;
      },
      hasPendingMessages() {
        check();
        return pending;
      },
      getContextUsage() {
        check();
        return undefined;
      },
      abort() {},
      compact() {
        compactCalls++;
      },
      sessionManager: {
        getEntry(id: string) {
          check();
          return raw.find((entry) => entry.id === id);
        },
        getEntries() {
          check();
          return raw;
        },
        getBranch() {
          check();
          return [];
        },
        getTree() {
          check();
          return [];
        },
        getLeafId() {
          check();
          return leaf;
        },
        getSessionId() {
          check();
          return sessionId;
        },
        getSessionDir() {
          check();
          return root;
        },
        getSessionFile() {
          check();
          return undefined;
        },
      },
      async navigateTree(target: string, options: unknown) {
        check();
        navigations.push({ target, options });
        return navigate();
      },
    };
  }
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = events.get(name) ?? [];
      list.push(handler);
      events.set(name, list);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, command);
    },
    setModel: () => setModelImpl(),
    getThinkingLevel: () => "off",
    getSessionName: () => "fixture",
    getCommands: () => [],
    sendUserMessage(content: unknown, options: unknown) {
      sends.push({ content, options });
      if (sendThrows) throw new Error("private credential/provider details");
    },
  };
  // Variable import avoids pulling the legacy adapter into strict helper type checks.
  const extensionModule = "../extensions/mirror-server.ts";
  (await import(extensionModule)).default(pi);
  await emit("session_start");
  await required(commands.get("webui-start")).handler("", context());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const snapshots: Array<{ leafId: string | null }> = [];
  ws.on("message", (data: RawData) => {
    const message = JSON.parse(data.toString());
    if (message.event === "state_sync") snapshots.push(message.payload);
  });
  t.after(async () => {
    ws.terminate();
    await emit("session_shutdown");
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  type Reply = { ok: boolean; result?: Record<string, unknown>; error?: string };
  let sequence = 0;
  const request = (method: string, params: Record<string, unknown> = {}, socket = ws) =>
    new Promise<Reply>((resolve, reject) => {
      const id = String(++sequence);
      const timeout = setTimeout(() => {
        socket.off("message", onMessage);
        reject(new Error("revision response timeout"));
      }, 3000);
      const onMessage = (data: RawData) => {
        const response = JSON.parse(data.toString());
        if (response.type !== "res" || response.id !== id) return;
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolve(response);
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const state = await request("get_messages");
  const runtimeId = required(state.result).runtimeId;
  // Exercise the actual mirror parser, dispatch and catch path over its socket.
  // A detail/helper throw alone cannot prove that the final error stays bounded.
  for (const [method, length, budget] of [
    ["get_entry_detail", 70_000, 64 * 1024],
    ["get_history", 300_000, 256 * 1024],
    ["sync_request", 300_000, 256 * 1024],
    ["get_entry_detail", 513, 64 * 1024],
    ["get_entry_detail", 512, 64 * 1024],
  ] as const) {
    await t.test(`request ID boundary: ${method}, ${length} characters`, async (subtest) => {
      const id = (length === 512 ? "\u0001" : "x").repeat(length);
      const raw = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off("message", onMessage);
          reject(new Error("request ID boundary response timeout"));
        }, 3000);
        const onMessage = (data: RawData) => {
          const text = data.toString();
          const response = JSON.parse(text);
          if (response.type !== "res" && response.type !== "error") return;
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve(text);
        };
        ws.on("message", onMessage);
        ws.send(
          JSON.stringify({
            type: "req",
            id,
            method,
            params: { sessionId, runtimeId, entryId: "missing", from: 1, to: 0 },
          }),
        );
      });
      const bytes = Buffer.byteLength(raw);
      subtest.diagnostic(`final ${method} error: ${bytes} bytes`);
      assert.ok(bytes <= budget, `final response exceeds ${budget} bytes: ${bytes}`);
      const response = JSON.parse(raw);
      if (length > 512) {
        assert.equal(response.type, "error");
        assert.equal(response.code, "bad_request");
        assert.ok(!Object.hasOwn(response, "id"), "invalid opaque identity must not be echoed or truncated");
      } else {
        assert.equal(response.type, "res");
        assert.equal(response.ok, false);
        assert.equal(response.id, id, "accepted escape-heavy identity must be preserved exactly");
      }
    });
  }
  const params = () => ({ entryId: "a2", mode: "regenerate", sessionId, runtimeId, sourceLeafId: "a2" });
  const previewParams = async (input = params()) => {
    const preview = await request("get_message_revision", input);
    return { ...input, previewId: preview.result?.previewId };
  };
  const submit = async (input: Record<string, unknown> = params()) =>
    request("submit_message_revision", {
      ...input,
      previewId: (await request("get_message_revision", input)).result?.previewId,
    });
  const startedContent = () => [{ type: "text", text: `${fullText}\nlast block` }, image1, image2];
  const reset = async () => {
    raw = entries();
    leaf = "a2";
    idle = true;
    pending = false;
    sendThrows = false;
    sends.length = 0;
    compactCalls = 0;
    navigations.length = 0;
    await emit("session_start");
    await required(commands.get("webui")).handler("", context());
    navigate = async () => {
      leaf = "a0";
      ctxGeneration++;
      await emit("session_tree", { oldLeafId: "a2", newLeafId: leaf });
      return { cancelled: false };
    };
  };

  await t.test("terminal permission, scope, busy and changed leaf reject before navigation", async () => {
    assert.match((await request("get_message_revision", params())).error ?? "", /webui/);
    await reset();
    for (const patch of [
      { sessionId: "other" },
      { runtimeId: "other" },
      { runtimeId: undefined },
      { sourceLeafId: "old" },
    ]) {
      const operation = await previewParams();
      assert.equal((await request("submit_message_revision", { ...operation, ...patch })).ok, false);
    }
    const busyOperation = await previewParams();
    idle = false;
    assert.equal((await request("submit_message_revision", busyOperation)).ok, false);
    idle = true;
    const queuedOperation = await previewParams();
    pending = true;
    assert.equal((await request("submit_message_revision", queuedOperation)).ok, false);
    pending = false;
    assert.equal(navigations.length, 0);
    assert.equal(sends.length, 0);
  });
  await t.test(
    "pre-existing asynchronous model mutations block revision through discovery and auth waits",
    async () => {
      await reset();
      const models = [{ provider: "fixture", id: "m1" }];
      let release!: () => void, entered!: () => void;
      let started = new Promise<void>((r) => {
        entered = r;
      });
      getModels = async () => {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
        return models;
      };
      const discovery = request("set_model", { provider: "fixture", modelId: "m1" });
      await started;
      assert.match((await submit()).error ?? "", /still in progress/);
      assert.equal(navigations.length, 0);
      release();
      await discovery;
      getModels = async () => models;
      started = new Promise<void>((r) => {
        entered = r;
      });
      setModelImpl = async () => {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
        return true;
      };
      const authentication = request("set_model", { provider: "fixture", modelId: "m1" });
      await started;
      assert.match((await submit()).error ?? "", /still in progress/);
      assert.equal(navigations.length, 0);
      assert.equal(sends.length, 0);
      release();
      await authentication;
      setModelImpl = async () => true;
      assert.equal((await submit()).ok, true);
      getModels = async () => [];
    },
  );
  await t.test("plain queued prompt identity is enforced before dispatch", async () => {
    await reset();
    for (const patch of [
      { sessionId: "foreign", runtimeId },
      { sessionId, runtimeId: "foreign" },
      { sessionId },
      { runtimeId },
    ]) {
      assert.equal((await request("prompt", { message: "queued text", ...patch })).ok, false);
    }
    assert.equal(sends.length, 0);
    assert.equal((await request("prompt", { message: "queued text", sessionId, runtimeId })).ok, true);
    assert.equal(sends.length, 1);
  });
  await t.test(
    "read-only get contains complete text but never image data; regeneration dispatch is not acceptance",
    async () => {
      await reset();
      const reply = await request("get_message_revision", params());
      assert.deepEqual(reply.result, {
        previewId: reply.result?.previewId,
        entryId: "a2",
        userEntryId: "u1",
        text: `${fullText}\nlast block`,
        hasImages: true,
        sourceLeafId: "a2",
        sessionId,
        runtimeId,
      });
      assert.equal(navigations.length, 0);
      assert.equal(sends.length, 0);
      const operation = { ...params(), previewId: reply.result?.previewId };
      assert.equal(typeof operation.previewId, "string");
      const submitted = await request("submit_message_revision", operation);
      assert.deepEqual(submitted.result, { dispatched: true, sessionId, runtimeId, userEntryId: "u1" });
      assert.deepEqual(navigations, [{ target: "u1", options: { summarize: false } }]);
      assert.deepEqual(sends, [
        { content: required(raw[2].message).content, options: { expandPromptTemplates: false } },
      ]);
      assert.equal(raw.length, 8, "old branch remains intact");
      assert.equal(snapshots.at(-1)?.leafId, "a0");
      assert.equal((await request("submit_message_revision", operation)).ok, false);
      assert.equal(sends.length, 1);
    },
  );
  await t.test(
    "edit retains images and exact edited whitespace; empty/unsupported/oversized requests fail before navigation",
    async () => {
      await reset();
      const edit = { ...params(), entryId: "u1", mode: "edit", text: "  /new\nedited  " };
      assert.equal((await submit({ ...edit, text: "\n " })).ok, false);
      assert.equal((await submit(edit)).ok, true);
      assert.deepEqual(sends[0], {
        content: [image1, { type: "text", text: edit.text }, image2],
        options: { expandPromptTemplates: false },
      });
      await reset();
      required(raw[2].message).content = [{ type: "audio", data: "x" }];
      assert.match((await request("get_message_revision", params())).error ?? "", /unsupported/);
      assert.equal((await submit(params())).ok, false);
      required(raw[2].message).content = "\u0001".repeat(400_000);
      assert.match((await request("get_message_revision", params())).error ?? "", /too large/);
      assert.equal(navigations.length, 0);
    },
  );
  await t.test(
    "cancel returns cancelled true, throwing navigation is unknown, and no-op does not dispatch",
    async () => {
      await reset();
      navigate = async () => ({ cancelled: true });
      assert.deepEqual((await submit(params())).result, { cancelled: true });
      assert.equal(sends.length, 0);
      navigate = async () => {
        throw new Error("private internals");
      };
      assert.match((await submit(params())).error ?? "", /outcome is unknown/);
      navigate = async () => ({ cancelled: false });
      assert.match((await submit(params())).error ?? "", /not dispatched/);
      assert.equal(sends.length, 0);
    },
  );
  await t.test(
    "double click and prompt/session actions cannot interleave navigation; abort prevents dispatch",
    async () => {
      await reset();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      navigate = async () => {
        entered();
        await held;
        return { cancelled: true };
      };
      const first = submit(params());
      await started;
      for (const method of [
        "submit_message_revision",
        "navigate_tree",
        "prompt",
        "reload",
        "compact",
        "set_model",
        "set_session_name",
      ]) {
        assert.equal((await request(method, params())).ok, false, method);
      }
      assert.equal(compactCalls, 0, "navigation must not invoke compact");
      assert.equal((await request("health")).ok, true);
      assert.equal((await request("abort")).ok, true);
      release();
      assert.deepEqual((await first).result, { cancelled: true });
      assert.equal(sends.length, 0);
      assert.equal(navigations.length, 1);
    },
  );
  await t.test("fresh context scope/leaf/busy fences and post-navigation throw never resend", async () => {
    for (const failure of ["scope", "leaf", "busy", "pending", "throw", "send", "abort"] as const) {
      await reset();
      navigate = async () => {
        leaf = failure === "leaf" ? "other" : "a0";
        ctxGeneration++;
        await emit("session_tree", { oldLeafId: "a2", newLeafId: leaf });
        if (failure === "scope") {
          sessionId = "replacement";
          await emit("session_start");
        }
        if (failure === "busy") idle = false;
        if (failure === "pending") pending = true;
        if (failure === "throw") throw new Error("private navigation failure");
        if (failure === "send") sendThrows = true;
        if (failure === "abort") await request("abort");
        return { cancelled: false };
      };
      const reply = await submit(params());
      assert.match(reply.error ?? "", /branch has switched.*do not automatically retry/i, failure);
      assert.equal(sends.length, failure === "send" ? 1 : 0, failure);
      assert.ok(!(reply.error ?? "").includes("private"));
      sessionId = "revision-session";
    }
  });
  await t.test("delayed input beyond timeout stays unknown across unrelated user/tree/terminal events", async () => {
    await reset();
    const operation = await previewParams();
    assert.equal((await request("submit_message_revision", operation)).ok, true);
    // Fake a slow input hook: dispatch returns void, user start arrives after 8 seconds.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedStart = held.then(() =>
      emit("message_start", {
        message: { role: "user", content: startedContent() },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 8_050));
    assert.equal((await request("get_message_revision", params())).ok, true);
    const assertUnknown = async () => {
      for (const method of [
        "submit_message_revision",
        "prompt",
        "navigate_tree",
        "reload",
        "compact",
        "steer",
        "follow_up",
      ]) {
        assert.match((await request(method, operation)).error ?? "", /pending or unknown/, method);
      }
      assert.equal(compactCalls, 0);
      assert.equal(sends.length, 1);
    };
    await assertUnknown();
    await emit("message_start", { message: { role: "user", content: "unrelated" } });
    await assertUnknown();
    await emit("message_start", {
      message: {
        role: "user",
        content: [{ type: "text", text: `${fullText}\nlast block` }, { ...image1, data: "changed" }, image2],
      },
    });
    await assertUnknown();
    leaf = "other";
    await emit("session_tree", { oldLeafId: "a0", newLeafId: leaf });
    await emit("message_start", { message: { role: "user", content: startedContent() } });
    for (const event of ["message_end", "turn_end", "agent_end", "agent_settled"]) {
      await emit(event, { message: { role: "user", content: "unrelated" }, messages: [] });
    }
    await assertUnknown();
    leaf = "a0";
    await emit("session_tree", { oldLeafId: "other", newLeafId: leaf });
    await assertUnknown();
    release();
    await delayedStart;
    await assertUnknown(); // Returning to the same parent cannot erase intervening navigation.
  });
  await t.test("late exact start after timeout confirms through system patches without navigation", async () => {
    await reset();
    assert.equal((await submit()).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 8_050));
    raw.push({ id: "patch", parentId: "a0", type: "message", message: { role: "system" } });
    leaf = "patch";
    ctxGeneration++;
    await emit("message_start", { message: { role: "user", content: startedContent() } });
    assert.equal((await request("prompt", { message: "explicit prompt after confirmation" })).ok, true);
    assert.equal(sends.length, 2);
  });
  await t.test("fresh system-patch context confirms; wrong chains and changed session do not unlock", async () => {
    for (const role of [
      "system",
      "user",
      "assistant",
      "toolResult",
      "unknown",
      "metadata",
      "wrong-branch",
      "wrong-session",
    ]) {
      await reset();
      assert.equal((await submit()).ok, true);
      raw.push({
        id: "patch",
        parentId: role === "wrong-branch" ? "other" : "a0",
        type: role === "metadata" ? "custom" : "message",
        message: { role: role.startsWith("wrong-") ? "system" : role },
      });
      leaf = "patch";
      if (role === "wrong-session") sessionId = "foreign";
      ctxGeneration++;
      await emit("message_start", { message: { role: "user", content: startedContent() } });
      assert.equal((await request("prompt", { message: "next" })).ok, role === "system", role);
      sessionId = "revision-session";
    }
  });
  await t.test("old lifecycle acceptance cannot clear a new revision's unknown fence", async () => {
    await reset();
    assert.equal((await submit()).ok, true);
    // Session replacement clears the old dispatch, not a newer dispatch's identity/content fence.
    ctxGeneration++;
    await reset();
    const text = "new lifecycle revision";
    assert.equal((await submit({ ...params(), entryId: "u1", mode: "edit", text })).ok, true);
    await emit("message_start", { message: { role: "user", content: startedContent() } });
    assert.equal((await request("prompt", { message: "too early" })).ok, false);
    await emit("message_start", { message: { role: "user", content: [{ type: "text", text }, image1, image2] } });
    assert.equal((await request("prompt", { message: "confirmed current dispatch" })).ok, true);
  });
  await t.test("current user leaf is rejected before Pi's no-op navigation", async () => {
    await reset();
    leaf = "u1";
    const reply = await submit({
      ...params(),
      entryId: "u1",
      mode: "edit",
      text: "new",
      sourceLeafId: "u1",
    });
    assert.match(reply.error ?? "", /current leaf/);
    assert.equal(navigations.length, 0);
  });
  await t.test(
    "one-shot preview rejects replay but fresh preview permits regeneration on the original branch",
    async () => {
      await reset();
      const old = await previewParams();
      const operation = await previewParams();
      assert.notEqual(old.previewId, operation.previewId);
      assert.match((await request("submit_message_revision", old)).error ?? "", /preview/);
      assert.equal((await request("submit_message_revision", { ...operation, previewId: undefined })).ok, false);
      assert.equal((await request("submit_message_revision", operation)).ok, true);
      assert.equal((await request("prompt", { message: "too early" })).ok, false);
      await emit("message_start", { message: { role: "user", content: startedContent() } });
      leaf = "a2";
      await emit("session_tree", { oldLeafId: "a0", newLeafId: leaf });
      await required(commands.get("webui")).handler("", context());
      assert.match((await request("submit_message_revision", operation)).error ?? "", /preview/);
      const fresh = await previewParams();
      assert.notEqual(fresh.previewId, operation.previewId);
      assert.equal((await request("submit_message_revision", fresh)).ok, true);
      assert.equal(sends.length, 2);
    },
  );
  await t.test("previews are socket-local, payload-bound and cleared on lifecycle reset", async () => {
    await reset();
    const other = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      await new Promise<void>((resolve, reject) => {
        other.once("open", resolve);
        other.once("error", reject);
      });
      const operation = await previewParams();
      assert.match((await request("submit_message_revision", operation, other)).error ?? "", /preview/);
      const otherPreview = await request("get_message_revision", params(), other);
      assert.equal(otherPreview.ok, true);
      assert.match((await request("submit_message_revision", { ...operation, mode: "edit" })).error ?? "", /preview/);
      assert.match((await request("submit_message_revision", operation)).error ?? "", /preview/);
      const next = await previewParams();
      await reset();
      assert.match((await request("submit_message_revision", next)).error ?? "", /preview/);
      assert.match(
        (
          await request(
            "submit_message_revision",
            {
              ...params(),
              previewId: otherPreview.result?.previewId,
            },
            other,
          )
        ).error ?? "",
        /preview/,
      );
      assert.equal(sends.length, 0);
      assert.equal(navigations.length, 0);
    } finally {
      other.terminate();
    }
  });
  await t.test("cancel consumes preview, while a fresh preview can be submitted", async () => {
    await reset();
    navigate = async () => ({ cancelled: true });
    const operation = await previewParams();
    assert.deepEqual((await request("submit_message_revision", operation)).result, { cancelled: true });
    assert.match((await request("submit_message_revision", operation)).error ?? "", /preview/);
    assert.deepEqual((await submit(params())).result, { cancelled: true });
    assert.equal(navigations.length, 2);
  });
});
