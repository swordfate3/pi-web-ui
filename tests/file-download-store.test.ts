import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectionSlice, SessionSlice, WorkspaceSlice } from "../src/web/src/core/store/types.ts";
import { createWorkspaceSlice } from "../src/web/src/core/store/workspace-slice.ts";

function fixture() {
  type State = WorkspaceSlice &
    Pick<ConnectionSlice, "connection" | "send"> &
    Pick<SessionSlice, "sessionId" | "runtimeId">;
  let state: State;
  state = {
    ...createWorkspaceSlice((() => {}) as never, (() => state) as never, {} as never),
    connection: "connected",
    sessionId: "s1",
    runtimeId: "r1",
    send: async () => ({ token: "test", filename: "report.pdf", size: 0, downloadUrl: "/api/downloads/test" }),
  };
  return state;
}

test("download preparation sends the current session and runtime identity", async () => {
  const state = fixture();
  const calls: unknown[] = [];
  state.send = async (method, params) => {
    calls.push({ method, params });
    return { filename: "report.pdf" };
  };
  await state.prepareFileDownload("documents/report.pdf");
  assert.deepEqual(calls, [
    { method: "prepare_file_download", params: { path: "documents/report.pdf", sessionId: "s1", runtimeId: "r1" } },
  ]);
});

test("disconnected or unidentified clients do not request a download", async () => {
  for (const patch of [{ connection: "disconnected" as const }, { sessionId: null }, { runtimeId: null }]) {
    const state = fixture();
    Object.assign(state, patch);
    let sent = false;
    state.send = async () => {
      sent = true;
    };
    await assert.rejects(state.prepareFileDownload("report.pdf"));
    assert.equal(sent, false);
  }
});

test("a late download reply is rejected after session/runtime changes or disconnection", async () => {
  for (const patch of [{ sessionId: "s2" }, { runtimeId: "r2" }, { connection: "disconnected" as const }]) {
    const state = fixture();
    let complete: (value: unknown) => void = () => {
      throw new Error("Request not started");
    };
    state.send = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const pending = state.prepareFileDownload("report.pdf");
    Object.assign(state, patch);
    complete({ filename: "report.pdf" });
    await assert.rejects(pending);
  }
});
