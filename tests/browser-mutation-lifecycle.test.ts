import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the real nested request handler. Only the SDK/authentication and
// external opener boundaries are controlled, so no application is launched.
const file = ts.createSourceFile(
  "mirror-server.ts",
  readFileSync(new URL("../extensions/mirror-server.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const declarations: ts.FunctionDeclaration[] = [];
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && ["handleRequest", "assertBrowserWritable"].includes(node.name?.text ?? ""))
    declarations.push(node);
  ts.forEachChild(node, visit);
}
visit(file);
assert.equal(declarations.length, 2);
const js = ts.transpileModule(declarations.map((node) => node.getText(file)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
  transformers: {
    before: [
      (context) => {
        const transform: ts.Visitor = (node) => {
          if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
            return ts.factory.createCallExpression(ts.factory.createIdentifier("loadChildProcess"), undefined, []);
          return ts.visitEachChild(node, transform, context);
        };
        return (source) => ts.visitNode(source, transform) as ts.SourceFile;
      },
    ],
  },
}).outputText;

for (const action of ["attachment", "open_file"] as const) {
  for (const transition of ["shutdown", "replacement"] as const) {
    test(`${action} cannot dispatch after ${transition} while its asynchronous prerequisite is pending`, async () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const prerequisite = new Promise<void>((resolve) => {
        release = resolve;
      });
      const responses: { ok: boolean; error?: string }[] = [];
      let dispatches = 0;
      const model = { id: "fixture" };
      const sdk = {
        model,
        isIdle: () => true,
        hasPendingMessages: () => false,
        modelRegistry: {
          getApiKeyAndHeaders: async () => {
            entered();
            await prerequisite;
            return { ok: true };
          },
        },
      };
      const context = vm.createContext({
        latestCtx: sdk,
        runtimeActive: true,
        runtimeStopping: false,
        runtimeControl: undefined,
        runtimeId: "runtime",
        revisionAttempt: false,
        revisionDispatchUnknown: false,
        activeBrowserMutations: 0,
        sessionReplacementPending: false,
        lifecycleEpoch: 1,
        sessionScope: () => ({ epoch: 1 }),
        scopeIsCurrent: (scope: { epoch: number }) => scope.epoch === context.lifecycleEpoch,
        checkHistoryIdentity: () => sdk,
        sendTo: (_socket: unknown, response: { ok: boolean; error?: string }) => responses.push(response),
        workspaceUploads: {
          resolve: () => ["/workspace/fixture.pdf"],
          send: async (
            _scope: unknown,
            _ids: unknown,
            _message: unknown,
            before: () => Promise<void>,
            dispatch: () => void,
          ) => {
            await before();
            dispatch();
          },
        },
        pi: {
          sendUserMessage: () => {
            dispatches++;
          },
        },
        loadChildProcess: async () => {
          entered();
          await prerequisite;
          return {
            execFile: () => {
              dispatches++;
            },
          };
        },
      });
      vm.runInContext(js, context);
      const request = context.handleRequest(
        {},
        {
          id: "test",
          method: action === "attachment" ? "prompt" : "open_file",
          params:
            action === "attachment"
              ? { sessionId: "session", runtimeId: "runtime", uploads: ["upload"], message: "read" }
              : { filePath: "/workspace/fixture.pdf" },
        },
      );
      await started;
      if (transition === "shutdown") context.runtimeStopping = true;
      else context.lifecycleEpoch = 2;
      release();
      await request;
      assert.equal(dispatches, 0, "an old request must not start a new side effect");
      assert.equal(responses.length, 1);
      assert.equal(responses[0].ok, false);
      assert.match(responses[0].error ?? "", /Session changed/);
      assert.equal(context.activeBrowserMutations, 0);
    });
  }
}
