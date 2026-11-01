import assert from "node:assert/strict";
import test from "node:test";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";

function fixture() {
  let state: ReturnType<typeof createSessionSlice> & {
    connection: string;
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Record<string, unknown>[] = [];
  state = createSessionSlice(
    ((patch: object | ((s: unknown) => object)) =>
      Object.assign(state, typeof patch === "function" ? patch(state) : patch)) as never,
    (() => state) as never,
    {} as never,
  ) as typeof state;
  Object.assign(state, {
    connection: "connected",
    sessionId: "s",
    runtimeId: "r",
    requestGitStatusRefresh() {},
    send: async (_method: string, params: Record<string, unknown>) => {
      calls.push(params);
      const index = params.cursor === "second" ? 1 : params.cursor === "third" ? 2 : 0;
      return {
        sessionId: "s",
        runtimeId: "r",
        entryId: params.entryId,
        text: ["# First\n\n正文一", "## Second\n\n正文二", "## Third\n\n正文三"][index],
        nextCursor: ["second", "third", null][index],
        format: "markdown",
      };
    },
  });
  return { state, calls };
}

test("long results read forward and backward retaining cursors but only one body", async () => {
  const { state, calls } = fixture();
  await state.loadEntryDetail("result", undefined, "markdown");
  assert.equal(state.entryDetailPageIndex, 0);
  await state.loadEntryDetail("result", "second", "markdown");
  await state.loadEntryDetail("result", "third", "markdown");
  assert.equal(state.entryDetailPageIndex, 2);
  assert.equal(state.entryDetail?.text, "## Third\n\n正文三");
  assert.equal(typeof state.loadPreviousEntryDetail, "function");
  await state.loadPreviousEntryDetail();
  assert.equal(state.entryDetail?.text, "## Second\n\n正文二");
  await state.loadPreviousEntryDetail();
  assert.equal(state.entryDetail?.text, "# First\n\n正文一");
  assert.equal(calls.at(-1)?.presentation, "markdown");
  assert.deepEqual(state.entryDetailTrail, [null, "second", "third"]);
  assert.equal(state.entryDetail?.format, "markdown");
});

test("a failed long-result page request keeps its readable body and retry location", async () => {
  const { state } = fixture();
  await state.loadEntryDetail("result", undefined, "markdown");
  const first = state.entryDetail;
  state.send = async () => {
    throw new Error("network temporarily unavailable");
  };
  await state.loadEntryDetail("result", "second", "markdown");
  assert.equal(state.entryDetail, first);
  assert.equal(state.entryDetailPageIndex, 0);
  assert.deepEqual(state.entryDetailTrail, [null]);
  assert.ok(state.entryDetailError);
});

test("invalid result format cannot mark arbitrary partial text as rendered Markdown", async () => {
  const { state } = fixture();
  await state.loadEntryDetail("result", undefined, "markdown");
  const first = state.entryDetail;
  state.send = async () => ({
    sessionId: "s",
    runtimeId: "r",
    entryId: "result",
    text: "bad",
    nextCursor: null,
    format: "html",
  });
  await state.loadEntryDetail("result", "second", "markdown");
  assert.equal(state.entryDetail, first);
  assert.ok(state.entryDetailError);
  state.closeEntryDetail();
  assert.deepEqual(state.entryDetailTrail, [null]);
  assert.equal(state.entryDetailPageIndex, 0);
});
