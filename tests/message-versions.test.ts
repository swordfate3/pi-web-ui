import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type RawData, WebSocket } from "ws";
import { resolveMessageVersions, type VersionEntry } from "../extensions/message-versions.ts";

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
function msg(id: string, parentId: string | null, role = "user"): VersionEntry {
  return { id, parentId, type: "message", message: { role } };
}
function entries(): VersionEntry[] {
  return [
    msg("u0", null),
    msg("a0", "u0", "assistant"),
    msg("u1", "a0"),
    msg("a1", "u1", "assistant"),
    msg("tool", "a1", "toolResult"),
    { id: "meta", parentId: "tool", type: "custom" },
    msg("a2", "meta", "assistant"),
    msg("other", "a0"),
    msg("answer", "other", "assistant"),
  ];
}

test("raw metadata groups nearest users across tools and metadata, preserving append order", () => {
  const raw = entries();
  for (const entry of raw) {
    if (entry.message)
      Object.defineProperty(entry.message, "content", {
        get() {
          throw new Error("must not inspect body");
        },
      });
  }
  const before = JSON.stringify(raw);
  const result = resolveMessageVersions(raw, ["u1", "a1", "a2"], "a2");
  assert.deepEqual(result, {
    limited: false,
    groups: [
      {
        entryIds: ["u1", "a1", "a2"],
        userEntryId: "u1",
        index: 1,
        total: 2,
        versions: [
          { userEntryId: "u1", targetEntryId: "a2" },
          { userEntryId: "other", targetEntryId: "answer" },
        ],
      },
    ],
  });
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(resolveMessageVersions(raw, ["u0", "a0"], "a2"), { groups: [], limited: false });
  for (const ids of [["tool"], ["meta"], ["missing"], ["u1", "u1"], [1], null, Array(101).fill("x")])
    assert.throws(() => resolveMessageVersions(raw, ids, null));
});

test("root siblings, latest true leaf (not timestamps), source preference, and answered path safety", () => {
  const raw = [
    msg("u", null),
    msg("a", "u", "assistant"),
    msg("v", null),
    msg("b", "v", "assistant"),
    msg("next", "a"),
    msg("end", "next", "assistant"),
    msg("fork", "a"),
    msg("latest", "fork", "assistant"),
  ];
  Object.assign(raw[5], { timestamp: "2099-01-01T00:00:00Z" });
  Object.assign(raw[7], { timestamp: "2000-01-01T00:00:00Z" });
  const targets = (source: string | null = null) =>
    required(resolveMessageVersions(raw, ["a"], source).groups[0]).versions;
  assert.equal(targets()[0].targetEntryId, "latest");
  assert.equal(targets("end")[0].targetEntryId, "end");
  assert.equal(targets("a")[0].targetEntryId, "a", "current saved pointer need not be a true graph leaf");
  raw.push(msg("unanswered", "latest"));
  assert.equal(targets()[0].targetEntryId, null, "never navigate to a user leaf");
  raw.push({ id: "custom", parentId: "unanswered", type: "custom_message" });
  assert.equal(targets()[0].targetEntryId, null, "never navigate to custom_message");
  raw.push({ id: "tail", parentId: "custom", type: "custom" });
  assert.equal(targets()[0].targetEntryId, "tail", "metadata leaves are safe when candidate was answered");
  raw.push(msg("empty", null), msg("skip", "empty"), msg("later-answer", "skip", "assistant"));
  assert.equal(targets()[2].targetEntryId, null, "a later user's answer does not answer candidate");
  raw.push(msg("user-only", null));
  assert.equal(targets()[3].targetEntryId, null);
});

test("malformed parent chains fail closed and never fabricate root siblings", () => {
  const raw = [
    ...entries(),
    msg("orphan", "missing"),
    msg("cycle1", "cycle2"),
    msg("cycle2", "cycle1"),
    msg("bad-answer", "orphan", "assistant"),
  ];
  for (const id of ["orphan", "cycle1", "bad-answer"])
    assert.throws(() => resolveMessageVersions(raw, [id], null), /parent chain/);
  assert.equal(resolveMessageVersions(raw, ["a2"], null).groups[0].total, 2);
  assert.throws(() => resolveMessageVersions([...raw, raw[0]], ["a2"], null), /graph/);
});

test("whole-group reference budget, per-user deduplication and 100-group cap", () => {
  const raw: VersionEntry[] = [];
  for (let i = 0; i < 128; i++) raw.push(msg(`u${i}`, null), msg(`a${i}`, `u${i}`, "assistant"));
  const two = resolveMessageVersions(raw, ["u0", "a0", "u1"], null);
  assert.equal(two.groups.length, 2);
  assert.equal(two.limited, false);
  const three = resolveMessageVersions(raw, ["u0", "u1", "u2"], null);
  assert.equal(three.groups.length, 2);
  assert.equal(three.limited, true);
  assert.equal(three.groups[0].total, 128);
  for (let i = 128; i < 257; i++) raw.push(msg(`u${i}`, null));
  assert.deepEqual(resolveMessageVersions(raw, ["u0"], null), { groups: [], limited: true });
  const hundred: VersionEntry[] = [];
  for (let i = 0; i < 100; i++)
    hundred.push({ id: `p${i}`, parentId: null, type: "custom" }, msg(`u${i}`, `p${i}`), msg(`v${i}`, `p${i}`));
  assert.equal(
    resolveMessageVersions(
      hundred,
      Array.from({ length: 100 }, (_, i) => `u${i}`),
      null,
    ).groups.length,
    100,
  );
});

test("system patches on both versions share only a stable context position, not rewritten ancestry", () => {
  for (const base of [null, "context-answer"] as const) {
    const raw = [
      ...(base ? [msg("context", null), msg(base, "context", "assistant")] : []),
      msg("initial-system", base, "system"),
      msg("original", "initial-system"),
      msg("answer", "original", "assistant"),
      msg("later-user", "answer"),
      msg("later-answer", "later-user", "assistant"),
      msg("patch-one", "initial-system", "system"),
      msg("patch-two", "patch-one", "system"),
      msg("revision", "patch-two"),
      msg("revised-answer", "revision", "assistant"),
      // A separate patch chain at the same real context is also a version.
      msg("separate-system", base, "system"),
      msg("third", "separate-system"),
      msg("third-answer", "third", "assistant"),
    ];
    for (const entry of raw) {
      Object.defineProperty(entry, "timestamp", { get: () => assert.fail("must not inspect timestamps") });
      Object.defineProperty(required(entry.message), "content", { get: () => assert.fail("must not inspect body") });
      Object.freeze(entry.message);
      Object.freeze(entry);
    }
    Object.freeze(raw);
    const result = resolveMessageVersions(raw, ["revision", "revised-answer"], "revised-answer");
    assert.deepEqual(result, {
      limited: false,
      groups: [
        {
          entryIds: ["revision", "revised-answer"],
          userEntryId: "revision",
          index: 2,
          total: 3,
          versions: [
            { userEntryId: "original", targetEntryId: "later-answer" },
            { userEntryId: "revision", targetEntryId: "revised-answer" },
            { userEntryId: "third", targetEntryId: "third-answer" },
          ],
        },
      ],
    });
    assert.equal(resolveMessageVersions(raw, ["answer"], "answer").groups[0].versions[0].targetEntryId, "answer");
    assert.equal(raw.find((e) => e.id === "revision")?.parentId, "patch-two");
    // Index follows append order, even if ancestors appear later in the input.
    const reversed = resolveMessageVersions([...raw].reverse(), ["original"], null).groups[0];
    assert.deepEqual(
      reversed.versions.map((v) => v.userEntryId),
      ["third", "revision", "original"],
    );
    assert.equal(reversed.index, 3);
  }
});

test("system transparency stops at every non-system entry, including metadata and unrelated context", () => {
  const raw = [msg("system", null, "system"), msg("original", "system"), msg("answer", "original", "assistant")];
  const boundaries: VersionEntry[] = [
    ...["custom", "custom_message", "compaction", "branch_summary", "model_change", "label"].map((type) => ({
      id: type,
      type,
      parentId: "system",
      message: { role: "system" },
    })),
    ...["user", "assistant", "toolResult", "custom", "unknown"].map((role) => msg(`role-${role}`, "system", role)),
    { id: "no-role", type: "message", parentId: "system" },
  ];
  for (const boundary of boundaries)
    raw.push(
      boundary,
      msg(`patch-${boundary.id}`, boundary.id, "system"),
      msg(`u-${boundary.id}`, `patch-${boundary.id}`),
    );
  for (const boundary of boundaries)
    assert.deepEqual(resolveMessageVersions(raw, [`u-${boundary.id}`], null), { groups: [], limited: false });
  raw.push(msg("unrelated", "answer", "system"), msg("other-user", "unrelated"));
  assert.deepEqual(resolveMessageVersions(raw, ["other-user"], null), { groups: [], limited: false });
});

test("missing, cyclic and malformed system ancestry cannot become root versions or targets", () => {
  const raw = [msg("root", null), msg("root-answer", "root", "assistant"), msg("peer", null)];
  const badParents: unknown[] = [undefined, 0, false, {}, [], "", "missing"];
  for (const [i, parent] of badParents.entries()) {
    raw.push(msg(`bad-${i}`, parent as string, "system"), msg(`bad-user-${i}`, `bad-${i}`));
  }
  raw.push(msg("cycle-a", "cycle-b", "system"), msg("cycle-b", "cycle-a", "system"), msg("cycle-user", "cycle-a"));
  for (const id of [...badParents.map((_, i) => `bad-user-${i}`), "cycle-user"])
    assert.throws(() => resolveMessageVersions(raw, [id], null), /parent chain/);
  assert.equal(resolveMessageVersions(raw, ["root"], "cycle-a").groups[0].total, 2);
  // Even a runtime non-string ID matching the illegal parent must not validate it.
  assert.throws(
    () =>
      resolveMessageVersions(
        [...raw, { id: 0, parentId: null, type: "custom" } as unknown as VersionEntry],
        ["root"],
        null,
      ),
    /graph/,
  );
});

test("system-normalized groups retain request and whole-group reference budgets", () => {
  const raw: VersionEntry[] = [];
  for (let i = 0; i < 257; i++) raw.push(msg(`s${i}`, null, "system"), msg(`u${i}`, `s${i}`));
  assert.deepEqual(resolveMessageVersions(raw, ["u0"], null), { groups: [], limited: true });
  assert.throws(
    () =>
      resolveMessageVersions(
        raw,
        Array.from({ length: 101 }, (_, i) => `u${i}`),
        null,
      ),
    /at most 100/,
  );
  assert.throws(() => resolveMessageVersions(raw, ["u0", "u0"], null), /unique/);
});

test("long shared system chains are memoized without a depth cutoff or false root grouping", () => {
  const raw = [msg("unrelated-root", null), msg("context", "unrelated-root", "assistant")];
  let parent = "context";
  const length = 12_000;
  for (let i = 0; i < length; i++) {
    const id = `s${i}`;
    raw.push(msg(id, parent, "system"), msg(`u${i}`, id));
    parent = id;
  }
  raw.push(msg("context-peer", "context"), msg("context-answer", "context-peer", "assistant"));
  let reads = 0;
  for (const entry of raw) {
    const parentId = entry.parentId;
    Object.defineProperty(entry, "parentId", {
      get() {
        reads++;
        return parentId;
      },
    });
  }
  // Oversized group is omitted whole; it must not be truncated or become root siblings.
  assert.deepEqual(resolveMessageVersions(raw, ["u11999", "unrelated-root"], null), { groups: [], limited: true });
  assert.ok(reads < raw.length * 20, `parent reads must stay linear, got ${reads}`);
  // A single long chain still yields the correct non-root group, not a cutoff key.
  const chain = raw.filter((e) => !e.id.startsWith("u") || e.id === "u11999");
  chain.unshift(msg("unrelated-root", null));
  const group = resolveMessageVersions(chain, ["u11999"], null).groups[0];
  assert.deepEqual(group.versions, [
    { userEntryId: "u11999", targetEntryId: null },
    { userEntryId: "context-peer", targetEntryId: "context-answer" },
  ]);
});

test("mock WS message version scope, navigation and mutation fences", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-versions-"));
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
  let snapshotThrows = false;
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
          if (snapshotThrows) throw new Error("synthetic snapshot failure");
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
      // This spy records explicit revision/reload dispatch only; version switches must never call it.
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
  const scope = () => ({ sessionId, runtimeId, sourceLeafId: leaf });
  const read = (patch: Record<string, unknown> = {}) =>
    request("get_message_versions", { ...scope(), entryIds: ["a1", "a2"], ...patch });
  const change = (patch: Record<string, unknown> = {}) =>
    request("switch_message_version", {
      ...scope(),
      entryId: "a2",
      userEntryId: "other",
      targetEntryId: "answer",
      ...patch,
    });
  const reset = async () => {
    raw = entries();
    leaf = "a2";
    idle = true;
    pending = false;
    sessionId = "revision-session";
    snapshotThrows = false;
    sends.length = 0;
    navigations.length = 0;
    getModels = async () => [];
    setModelImpl = async () => true;
    await emit("session_start");
    await required(commands.get("webui")).handler("", context());
    navigate = async () => {
      const oldLeafId = leaf;
      leaf = required(navigations.at(-1)).target;
      ctxGeneration++;
      await emit("session_tree", { oldLeafId, newLeafId: leaf });
      return { cancelled: false };
    };
  };

  await t.test("read requires scope and leaf but not advanced/idle/model; never reads bounded history", async () => {
    const reply = await read();
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.result, { ...scope(), ...resolveMessageVersions(raw, ["a1", "a2"], leaf) });
    assert.match((await change()).error ?? "", /webui/);
    idle = false;
    pending = true;
    assert.equal((await read()).ok, true);
    for (const patch of [
      { sessionId: "foreign" },
      { runtimeId: "foreign" },
      { runtimeId: undefined },
      { sourceLeafId: "stale" },
      { sourceLeafId: undefined },
      { entryIds: ["a1", "a1"] },
      { entryIds: ["missing"] },
    ]) {
      assert.equal((await read(patch)).ok, false);
    }
    leaf = null;
    assert.equal((await read()).ok, true);
    assert.equal(navigations.length, 0);
    assert.equal(sends.length, 0);
  });

  await t.test("switch validates scope/leaf/idle/pending and recomputes exact sibling target", async () => {
    await reset();
    for (const patch of [
      { sessionId: "foreign" },
      { runtimeId: "foreign" },
      { runtimeId: undefined },
      { sourceLeafId: "stale" },
      { sourceLeafId: undefined },
      { entryId: "tool" },
      { userEntryId: "u0", targetEntryId: "a0" },
      { targetEntryId: "other" },
      { targetEntryId: "a1" },
    ]) {
      assert.equal((await change(patch)).ok, false);
    }
    idle = false;
    assert.equal((await change()).ok, false);
    idle = true;
    pending = true;
    assert.equal((await change()).ok, false);
    pending = false;
    raw.push(msg("new-answer", "answer", "assistant"));
    assert.equal((await change()).ok, false, "old lookup target cannot authorize a changed continuation");
    assert.equal(navigations.length, 0);
    assert.equal(sends.length, 0);
  });

  await t.test("strict ACK follows fresh tree context, no model or model dispatch, best-effort snapshot", async () => {
    await reset();
    assert.deepEqual((await change()).result, { switched: true, sessionId, runtimeId, leafId: "answer" });
    assert.deepEqual(navigations, [{ target: "answer", options: { summarize: false } }]);
    assert.equal(sends.length, 0);
    assert.equal(snapshots.at(-1)?.leafId, "answer");
    assert.equal(raw.length, 9);
    // Select current candidate and saved pointer: explicit no-op ACK, no navigation.
    assert.deepEqual((await change({ entryId: "answer" })).result, {
      switched: true,
      sessionId,
      runtimeId,
      leafId: "answer",
    });
    assert.equal(navigations.length, 1);
    await reset();
    navigate = async () => ({ cancelled: true });
    assert.deepEqual((await change()).result, { cancelled: true });
    assert.equal(sends.length, 0);
    await reset();
    navigate = async () => {
      leaf = "answer";
      ctxGeneration++;
      await emit("session_tree", { newLeafId: leaf });
      snapshotThrows = true;
      return { cancelled: false };
    };
    assert.deepEqual(
      (await change()).result,
      { switched: true, sessionId, runtimeId, leafId: "answer" },
      "a snapshot transport failure cannot replace a confirmed switch with invented failure",
    );
    snapshotThrows = false;
  });

  await t.test(
    "pre-existing asynchronous discovery/auth mutations block switching including self counter",
    async () => {
      await reset();
      for (const phase of ["discovery", "auth"]) {
        let release!: () => void, entered!: () => void;
        const started = new Promise<void>((r) => {
          entered = r;
        });
        const wait = async () => {
          entered();
          await new Promise<void>((r) => {
            release = r;
          });
        };
        const models = [{ provider: "fixture", id: "m1" }];
        getModels = async () => {
          if (phase === "discovery") await wait();
          return models;
        };
        setModelImpl = async () => {
          if (phase === "auth") await wait();
          return true;
        };
        const operation = request("set_model", { provider: "fixture", modelId: "m1" });
        await started;
        assert.match((await change()).error ?? "", /still in progress/);
        assert.equal(navigations.length, 0);
        release();
        assert.equal((await operation).ok, true);
      }
      assert.equal((await change()).ok, true);
      assert.equal(sends.length, 0);
    },
  );

  await t.test("held switch fences all mutations; read and abort allowed; aborted success cannot ACK", async () => {
    await reset();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    navigate = async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      leaf = "answer";
      ctxGeneration++;
      await emit("session_tree", { newLeafId: leaf });
      return { cancelled: false };
    };
    const operation = change();
    await started;
    for (const method of [
      "switch_message_version",
      "submit_message_revision",
      "navigate_tree",
      "prompt",
      "reload",
      "compact",
      "set_model",
      "set_session_name",
    ])
      assert.equal((await request(method)).ok, false, method);
    assert.equal((await read()).ok, true);
    assert.equal((await request("health")).ok, true);
    assert.equal((await request("abort")).ok, true);
    release();
    assert.equal((await operation).ok, false);
    assert.equal(sends.length, 0);
    assert.equal(compactCalls, 0);
  });

  await t.test("revision pending/unknown fence also rejects version switches", async () => {
    await reset();
    // Revision needs synthetic content; the version resolver never reads it.
    Object.assign(required(raw[2].message), { content: "synthetic question" });
    const params = { ...scope(), entryId: "a2", mode: "regenerate" };
    const preview = await request("get_message_revision", params);
    navigate = async () => {
      leaf = "a0";
      ctxGeneration++;
      await emit("session_tree", { newLeafId: leaf });
      return { cancelled: false };
    };
    assert.equal(
      (await request("submit_message_revision", { ...params, previewId: preview.result?.previewId })).ok,
      true,
    );
    assert.match((await change()).error ?? "", /pending or unknown/);
    assert.equal((await read()).ok, true);
    assert.equal(navigations.length, 1);
    assert.equal(sends.length, 1, "only explicit revision dispatched, never version switching");
  });

  await t.test("post-await lifecycle/leaf/busy/event/throw checks never falsely ACK or leak errors", async () => {
    for (const failure of ["scope", "lifecycle", "leaf", "busy", "pending", "event", "throw"] as const) {
      await reset();
      navigate = async () => {
        if (failure === "throw") throw new Error("private provider internals");
        leaf = failure === "leaf" ? "a0" : "answer";
        if (failure !== "event") {
          ctxGeneration++;
          await emit("session_tree", { newLeafId: leaf });
        }
        if (failure === "scope") sessionId = "replacement";
        if (failure === "lifecycle" || failure === "scope") await emit("session_start");
        if (failure === "busy") idle = false;
        if (failure === "pending") pending = true;
        return { cancelled: false };
      };
      const reply = await change();
      assert.equal(reply.ok, false, failure);
      assert.match(reply.error ?? "", /outcome is unknown/);
      assert.ok(!(reply.error ?? "").includes("private"));
      assert.equal(sends.length, 0);
    }
  });

  await t.test("old finally cannot clear a newer lifecycle's navigation lock", async () => {
    await reset();
    let releaseOld!: () => void, oldEntered!: () => void;
    const oldStarted = new Promise<void>((r) => {
      oldEntered = r;
    });
    navigate = async () => {
      oldEntered();
      await new Promise<void>((r) => {
        releaseOld = r;
      });
      return { cancelled: false };
    };
    const oldOperation = change();
    await oldStarted;
    await reset();
    // The old outstanding request also contributes to activeBrowserMutations.
    assert.match((await change()).error ?? "", /still in progress/);
    // A newer session operation owns the shared lock despite the old await.
    assert.equal((await request("reload", { sessionId })).ok, true);
    releaseOld();
    assert.equal((await oldOperation).ok, false);
    assert.match((await change()).error ?? "", /already in progress/);
    assert.equal(sends.length, 1, "only explicit reload dispatches its internal command");
  });
});
