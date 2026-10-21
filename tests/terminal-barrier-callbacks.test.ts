import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { resolveMessageRevision, revisionContent } from "../extensions/message-revision.ts";
import { TerminalBarrier, terminalReadOnly } from "../extensions/terminal-barrier.ts";

// Exercise the actual nested callbacks; only SDK/disk scheduling is controlled.
// Separate real SDK/WS/HTTP tests cover ingress and native lifecycle wiring.
const source = ts.createSourceFile(
  "mirror-server.ts",
  readFileSync(new URL("../extensions/mirror-server.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
function load(context: vm.Context, names: string[], command?: string) {
  const declarations: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text))
      declarations.push(node.getText(source));
    if (
      command &&
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "registerSessionCommand" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === command
    )
      declarations.push(`${node.getText(source)};`);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(declarations.length, names.length + (command ? 1 : 0));
  vm.runInContext(
    ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    context,
    { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  );
}

test("open_file cannot launch a host opener after preparation during its deferred import", async (t) => {
  const f = fixture();
  let launches = 0;
  const opener = t.mock.method(childProcess, "execFile", (() => {
    launches++;
    return {};
  }) as never);
  syncBuiltinESMExports();
  try {
    const work = f.context.handleRequest({}, { id: "open", method: "open_file", params: { filePath: "/fixture" } });
    assert.equal(f.barrier.prepare(), false);
    await work;
    assert.equal(launches, 0);
    assert.equal(f.responses[0].error, "terminal_untracked");
  } finally {
    opener.mock.restore();
    syncBuiltinESMExports();
  }
});

test("an ACKed host opener has no tracked application completion and keeps preparation unavailable", async (t) => {
  const f = fixture();
  const opener = t.mock.method(childProcess, "execFile", (() => ({})) as never);
  syncBuiltinESMExports();
  try {
    await f.context.handleRequest({}, { id: "open", method: "open_file", params: { filePath: "/fixture" } });
    assert.equal(f.responses[0].ok, true);
    assert.equal(f.barrier.prepare(), false);
  } finally {
    opener.mock.restore();
    syncBuiltinESMExports();
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const barrier = new TerminalBarrier();
  type Response = { ok: boolean; error?: string };
  type Command = { handler: (args: string, ctx: unknown) => unknown };
  const responses: Response[] = [];
  const commands = new Map<string, Command>();
  const dispatched: string[] = [];
  const ctx = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: {},
    sessionManager: { getSessionId: () => "session", getEntry: () => ({ id: "target" }) },
  };
  const context = vm.createContext({
    Error,
    terminalBarrier: barrier,
    terminalReadOnly,
    randomUUID,
    setTimeout,
    clearTimeout,
    runtimeActive: true,
    runtimeStopping: false,
    runtimeControl: undefined,
    lifecycleEpoch: 1,
    latestCtx: ctx,
    latestExecuteCtx: ctx,
    advancedFeaturesEnabled: true,
    sessionReplacementPending: false,
    pendingSessionCommand: null,
    pendingDispatchId: null,
    dispatchTimer: null,
    revisionDispatchTimer: null,
    pendingResume: null,
    activeBrowserMutations: 0,
    revisionAttempt: null,
    revisionDispatchUnknown: false,
    runtimeId: "runtime",
    internalCommands: new Set(),
    taintRuntimeInput() {},
    sessionScope: () => ({ epoch: context.lifecycleEpoch }),
    scopeIsCurrent: (scope: { epoch: number }) => scope.epoch === context.lifecycleEpoch,
    sendTo: (_ws: unknown, response: Response) => responses.push(response),
    broadcast() {},
    pi: {
      registerCommand(name: string, value: Command) {
        commands.set(name, value);
      },
      sendUserMessage(message: string) {
        dispatched.push(message);
      },
    },
  });
  load(context, [
    "assertBrowserWritable",
    "sendBrowserMessage",
    "clearSessionAction",
    "reportSessionCommandError",
    "registerSessionCommand",
    "requireSessionAction",
    "acceptSessionAction",
    "requestReload",
    "handleRequest",
  ]);
  return { barrier, context, responses, commands, dispatched };
}

test("delayed internal reload command cannot execute after prepare even though dispatch was ACKed", async () => {
  const f = fixture();
  let reloads = 0;
  f.context.registerSessionCommand("webui-reload", {
    handler: async () => {
      reloads++;
    },
  });
  await f.context.handleRequest({}, { id: "reload", method: "reload", params: {} });
  assert.equal(f.responses[0].ok, true);
  assert.equal(f.context.activeBrowserMutations, 0);
  assert.equal(f.barrier.prepare(), false, "void SDK dispatch remains unknown after ACK");
  const [, dispatchId] = f.dispatched[0].split(" ");
  const command = f.commands.get("webui-reload");
  assert.ok(command);
  await command.handler(dispatchId, f.context.latestExecuteCtx);
  assert.equal(reloads, 0);
  f.context.clearSessionAction();
  assert.equal(f.barrier.prepare(), false, "clearing a dispatch timer cannot erase unknown completion");
});

test("old navigation completion cannot acknowledge success or unlock a new session action", async () => {
  const f = fixture();
  const navigation = deferred<{ cancelled: boolean }>();
  f.context.latestExecuteCtx.navigateTree = () => navigation.promise;
  const request = f.context.handleRequest(
    {},
    { id: "navigate", method: "navigate_tree", params: { entryId: "target" } },
  );
  assert.equal(f.context.sessionReplacementPending, true);
  f.context.lifecycleEpoch++;
  f.context.sessionReplacementPending = true; // A new session's independent operation owns this lock.
  navigation.resolve({ cancelled: false });
  await request;
  assert.equal(f.responses[0].ok, false);
  assert.equal(f.context.sessionReplacementPending, true);
});

test("admitted navigation blocks grant and cannot ACK success after terminal prepare", async () => {
  const f = fixture();
  const navigation = deferred<{ cancelled: boolean }>();
  f.context.latestExecuteCtx.navigateTree = () => navigation.promise;
  const request = f.context.handleRequest(
    {},
    { id: "navigate", method: "navigate_tree", params: { entryId: "target" } },
  );
  assert.equal(f.barrier.prepare(), false);
  navigation.resolve({ cancelled: false });
  await request;
  assert.equal(f.responses[0].error, "terminal_untracked");
  assert.equal(f.barrier.prepare(), true);
});

test("revision navigation admitted before takeover cannot dispatch its queued user message", async () => {
  const f = fixture();
  const ws = {};
  const raw = [
    { id: "user", parentId: null, type: "message", message: { role: "user", content: "original" } },
    { id: "answer", parentId: "user", type: "message", message: { role: "assistant", content: "answer" } },
  ];
  let leaf: string | null = "answer";
  f.context.latestCtx.sessionManager.getLeafId = () => leaf;
  f.context.latestCtx.sessionManager.getEntry = (id: string) => raw.find((entry) => entry.id === id);
  f.context.resolveMessageRevision = resolveMessageRevision;
  f.context.revisionContent = revisionContent;
  f.context.revisionTreeVersion = 0;
  const params = {
    sessionId: "session",
    runtimeId: "runtime",
    entryId: "answer",
    mode: "regenerate",
    sourceLeafId: "answer",
    previewId: "preview",
  };
  f.context.revisionPreviews = new WeakMap([[ws, { ...params, epoch: 1 }]]);
  load(f.context, ["requireRevisionIdentity", "submitMessageRevision"]);
  const navigation = deferred<{ cancelled: boolean }>();
  f.context.latestExecuteCtx.navigateTree = () => navigation.promise;
  const request = f.context.handleRequest(ws, { id: "revision", method: "submit_message_revision", params });
  assert.equal(f.context.sessionReplacementPending, true);
  assert.equal(f.barrier.prepare(), false);
  leaf = null;
  f.context.revisionTreeVersion++;
  navigation.resolve({ cancelled: false });
  await request;
  assert.equal(f.responses[0].ok, false);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.barrier.prepare(), true);
});

test("already dispatched async model work keeps grant unavailable until its real promise settles", {
  timeout: 3000,
}, async () => {
  const f = fixture();
  const setting = deferred<boolean>();
  const started = deferred<void>();
  f.context.latestCtx.modelRegistry = { getAvailable: async () => [{ provider: "fixture", id: "model" }] };
  f.context.pi.setModel = () => {
    started.resolve();
    return setting.promise;
  };
  const request = f.context.handleRequest(
    {},
    { id: "model", method: "set_model", params: { provider: "fixture", modelId: "model" } },
  );
  await started.promise;
  assert.equal(f.barrier.prepare(), false);
  assert.equal(f.barrier.latched, false);
  setting.resolve(true);
  await request;
  assert.equal(f.responses[0].error, "terminal_untracked");
  assert.equal(f.barrier.prepare(), true);
});

for (const takeover of [false, true]) {
  test(`resume disk lookup uses fresh command context and rechecks takeover=${takeover} before switch`, async () => {
    const f = fixture();
    const listing = deferred<unknown[]>();
    let switchCount = 0;
    let stale = false;
    const old = {
      ...f.context.latestCtx,
      isIdle() {
        assert.equal(stale, false, "stale command ctx");
        return true;
      },
      switchSession: async () => {
        switchCount++;
        return { cancelled: false };
      },
    };
    f.context.latestExecuteCtx = old;
    f.context.pendingResume = {
      cwd: "/fixture",
      sessionDir: "/fixture",
      path: "/fixture/s.jsonl",
      targetSessionId: "saved",
      epoch: 1,
    };
    f.context.sessionReplacementPending = true;
    f.context.pendingSessionCommand = "webui-resume-session";
    f.context.pendingDispatchId = "dispatch";
    f.context.SessionManager = { list: () => listing.promise };
    f.context.path = { resolve: (value: string) => value };
    f.context.allowedSessionPath = () => true;
    f.context.fs = {
      openSync: () => 1,
      closeSync() {},
      readSync(_fd: number, buffer: Buffer) {
        return buffer.write('{"type":"session","id":"saved","cwd":"/fixture"}\n');
      },
    };
    f.context.Buffer = Buffer;
    const errors: string[] = [];
    f.context.reportSessionCommandError = (message: string) => errors.push(message);
    load(f.context, [], "webui-resume-session");
    const command = f.commands.get("webui-resume-session");
    assert.ok(command);
    const work = command.handler("dispatch selection", old);
    if (takeover) assert.equal(f.barrier.prepare(), false);
    else {
      stale = true;
      f.context.latestExecuteCtx = { ...old, isIdle: () => true };
    }
    listing.resolve([{ path: "/fixture/s.jsonl", id: "saved", cwd: "/fixture" }]);
    await work;
    assert.equal(switchCount, takeover ? 0 : 1);
    assert.equal(
      errors.some((message) => message.includes("stale command ctx")),
      false,
    );
    if (takeover) assert.ok(errors.includes("terminal_untracked"));
  });
}
