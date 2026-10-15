import assert from "node:assert/strict";
import test from "node:test";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import type { PiWebUiStore } from "../src/web/src/core/store/types.ts";
import type { UsageStatsResult } from "../src/web/src/core/types.ts";
import { parseUsageStats } from "../src/web/src/core/usage-stats.ts";

const totals = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: null,
  unpricedRequests: 1,
  requests: 1,
};
function fixture(): UsageStatsResult {
  return {
    sessionId: "session",
    runtimeId: "runtime",
    statisticsScope: "all_entries",
    currency: "USD",
    totals: { ...totals },
    models: [{ ...totals, provider: "provider", model: "actual-response" }],
    lastResponse: null,
    truncated: false,
  };
}
test("usage reply validates scope and bounded nonnegative finite counters", () => {
  const result = fixture();
  assert.equal(parseUsageStats(result, "session", "runtime"), result);
  assert.throws(() => parseUsageStats(result, "other", "runtime"));
  assert.throws(() => parseUsageStats(result, "session", "reloaded"));
  for (const value of [
    null,
    {},
    { ...result, totals: { ...totals, input: NaN } },
    { ...result, totals: { ...totals, cost: Infinity } },
    { ...result, totals: { ...totals, requests: -1 } },
    { ...result, lastResponse: {} },
    { ...result, models: Array(33).fill(result.models[0]) },
    { ...result, currency: "CNY" },
    { ...result, models: [{ ...result.models[0], model: "x".repeat(257) }] },
  ]) {
    assert.throws(() => parseUsageStats(value, "session", "runtime"));
  }
});
test("unknown price stays unknown; known zero without usage is allowed", () => {
  assert.equal(parseUsageStats(fixture(), "session", "runtime").totals.cost, null);
  const result = fixture();
  result.totals = { ...totals, cost: 0, unpricedRequests: 0 };
  assert.equal(parseUsageStats(result, "session", "runtime").totals.cost, 0);
});

test("usage intent sends scoped command and rejects a late reply after replacement or disconnect", async () => {
  let state: PiWebUiStore;
  state = createSessionSlice(
    ((patch: object | ((state: PiWebUiStore) => object)) =>
      Object.assign(state, typeof patch === "function" ? patch(state) : patch)) as never,
    (() => state) as never,
    {} as never,
  ) as PiWebUiStore;
  Object.assign(state, {
    sessionId: "session",
    runtimeId: "runtime",
    connection: "connected",
    sessionActionPending: false,
  });
  let resolve!: (value: unknown) => void;
  state.send = (method: string, params: unknown) => {
    assert.equal(method, "get_usage_stats");
    assert.deepEqual(params, { sessionId: "session", runtimeId: "runtime" });
    return new Promise((done) => {
      resolve = done;
    });
  };
  const pending = state.getUsageStats();
  state.runtimeId = "new-runtime";
  resolve(fixture());
  await assert.rejects(pending);
  state.runtimeId = "runtime";
  const disconnected = state.getUsageStats();
  state.connection = "disconnected";
  resolve(fixture());
  await assert.rejects(disconnected);
  let sent = false;
  state.send = async () => {
    sent = true;
    return fixture();
  };
  await assert.rejects(state.getUsageStats());
  assert.equal(sent, false);
  state.connection = "connected";
  state.sessionActionPending = true;
  await assert.rejects(state.getUsageStats());
  assert.equal(sent, false);
  state.sessionActionPending = false;
  assert.equal((await state.getUsageStats()).totals.unpricedRequests, 1);
});
