import assert from "node:assert/strict";
import { test } from "node:test";
import { getSessionUsageStatistics } from "../extensions/session-usage.ts";

const usage = (
  input: number,
  output: number,
  options: {
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: number;
    costObject?: unknown;
    reasoning?: number;
  } = {},
) => ({
  input,
  output,
  cacheRead: options.cacheRead ?? 0,
  cacheWrite: options.cacheWrite ?? 0,
  totalTokens: options.totalTokens ?? input + output + (options.cacheRead ?? 0) + (options.cacheWrite ?? 0),
  ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
  cost: options.costObject ?? {
    input: options.cost ?? 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: options.cost ?? 0,
  },
});

const assistant = (
  id: string,
  provider: string,
  model: string,
  messageUsage: unknown,
  extra: Record<string, unknown> = {},
) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: {
    role: "assistant",
    provider,
    model,
    content: [{ type: "text", text: "private chat body must not appear in statistics" }],
    usage: messageUsage,
    ...extra,
  },
});

const base = (entries: unknown[]) => getSessionUsageStatistics(entries, "session-123", "runtime-456");

test("aggregates all assistant responses by their own provider and response model across model switches", () => {
  const stats = base([
    { type: "model_change", id: "switch-1", provider: "openai", modelId: "new-current-model" },
    assistant("a1", "anthropic", "virtual-sonnet", usage(10, 4, { cost: 0.25 }), { responseModel: "claude-real-1" }),
    { type: "model_change", id: "switch-2", provider: "openai", modelId: "gpt-live" },
    assistant("a2", "openai", "gpt-old", usage(3, 2, { cost: 0.1 }), { responseModel: "gpt-response-2" }),
    assistant("a3", "anthropic", "claude-real-1", usage(1, 1, { cost: 0.05 })),
  ]);

  assert.equal(stats.sessionId, "session-123");
  assert.equal(stats.runtimeId, "runtime-456");
  assert.equal(stats.statisticsScope, "all_entries");
  assert.equal(stats.currency, "USD");
  const { cost: totalCost, ...totalUsage } = stats.totals;
  assert.deepEqual(totalUsage, {
    input: 14,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 21,
    unpricedRequests: 0,
    requests: 3,
  });
  assert.ok(typeof totalCost === "number" && Math.abs(totalCost - 0.4) < Number.EPSILON);
  assert.deepEqual(
    stats.models.map(({ provider, model, input, requests }) => ({ provider, model, input, requests })),
    [
      { provider: "anthropic", model: "claude-real-1", input: 11, requests: 2 },
      { provider: "openai", model: "gpt-response-2", input: 3, requests: 1 },
    ],
  );
  assert.equal(stats.lastResponse?.provider, "anthropic");
  assert.equal(stats.lastResponse?.model, "claude-real-1");
  assert.equal(stats.lastResponse?.output, 1);
  assert.ok(!JSON.stringify(stats).includes("private chat body"));
  assert.ok(!JSON.stringify(stats).includes("/"));
});

test("preserves cache buckets and does not add reasoning tokens a second time", () => {
  const stats = base([
    assistant(
      "a1",
      "provider",
      "reasoner",
      usage(8, 5, { cacheRead: 7, cacheWrite: 3, totalTokens: 23, cost: 0.8, reasoning: 4 }),
    ),
  ]);
  assert.deepEqual(stats.totals, {
    input: 8,
    output: 5,
    cacheRead: 7,
    cacheWrite: 3,
    totalTokens: 23,
    cost: 0.8,
    unpricedRequests: 0,
    requests: 1,
  });
});

test("keeps known subtotal and reports missing or ambiguous zero-price requests as unpriced", () => {
  const stats = base([
    assistant("known", "p", "known-model", usage(2, 3, { cost: 0.5 })),
    assistant("missing-cost", "p", "missing-price", {
      input: 4,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
    }),
    assistant("zero-cost", "p", "possibly-free", usage(0, 9)),
    assistant("zero-token", "p", "zero-usage", usage(0, 0)),
  ]);
  assert.equal(stats.totals.cost, 0.5);
  assert.equal(stats.totals.unpricedRequests, 2);
  assert.equal(stats.totals.requests, 4);
  assert.deepEqual(
    stats.models.find((group) => group.model === "zero-usage"),
    {
      provider: "p",
      model: "zero-usage",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      unpricedRequests: 0,
      requests: 1,
    },
  );

  const entirelyUnknown = base([assistant("x", "p", "unknown", usage(1, 1))]);
  assert.equal(entirelyUnknown.totals.cost, null);
  assert.equal(entirelyUnknown.totals.unpricedRequests, 1);
});

test("usage, tool-result, compaction and branch-summary charges are counted once in a private summary bucket", () => {
  const stats = base([
    assistant("assistant", "main-provider", "main-model", usage(3, 2, { cost: 0.3 })),
    {
      type: "message",
      id: "tool-result",
      parentId: "assistant",
      message: {
        role: "toolResult",
        toolCallId: "nested-call",
        toolName: "nested-model-tool",
        content: [{ type: "text", text: "tool output" }],
        usage: usage(2, 1, { cost: 0.2 }),
      },
    },
    { type: "compaction", id: "compact", usage: usage(1, 1, { cost: 0.1 }), summary: "private compaction" },
    { type: "branch_summary", id: "branch", usage: usage(1, 0, { cost: 0.05 }), summary: "private branch summary" },
    {
      type: "usage",
      id: "usage-entry",
      provider: "tool-provider",
      model: "tool-model",
      usage: usage(2, 0, { cost: 0.08 }),
    },
  ]);

  assert.deepEqual(stats.totals, {
    input: 9,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 13,
    cost: 0.73,
    unpricedRequests: 0,
    requests: 5,
  });
  const summary = stats.models.find((group) => group.provider === "tools" && group.model === "summaries");
  assert.ok(summary);
  const { cost: summaryCost, ...summaryUsage } = summary;
  assert.deepEqual(summaryUsage, {
    provider: "tools",
    model: "summaries",
    input: 4,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 6,
    unpricedRequests: 0,
    requests: 3,
  });
  assert.ok(typeof summaryCost === "number" && Math.abs(summaryCost - 0.35) < Number.EPSILON);
  assert.equal(stats.models.find((group) => group.provider === "tool-provider")?.model, "tool-model");
  assert.equal(JSON.stringify(summary).includes("private"), false);
});

test("deduplicates repeated retained-tail entry IDs and counts aborted assistant usage", () => {
  const aborted = assistant("aborted", "p", "partial-response", usage(6, 2, { cacheRead: 4, cost: 0.7 }), {
    stopReason: "aborted",
  });
  const stats = base([aborted, { ...aborted }]);
  assert.deepEqual(stats.totals, {
    input: 6,
    output: 2,
    cacheRead: 4,
    cacheWrite: 0,
    totalTokens: 12,
    cost: 0.7,
    unpricedRequests: 0,
    requests: 1,
  });
  assert.equal(stats.lastResponse?.requests, 1);
  assert.equal(stats.truncated, true);
});

test("uses literal model identities and keeps special characters separate", () => {
  const stats = base([
    assistant("one", "provider:one", "model/with/slashes", usage(1, 0, { cost: 0.01 })),
    assistant("two", "provider", "one:model/with/slashes", usage(2, 0, { cost: 0.02 })),
    assistant("three", "provider:one", "model/with/slashes", usage(3, 0, { cost: 0.03 })),
  ]);
  assert.equal(stats.models.length, 2);
  assert.equal(stats.models.find((group) => group.provider === "provider:one")?.input, 4);
  assert.equal(stats.models.find((group) => group.provider === "provider")?.input, 2);
  assert.equal(stats.totals.cost, 0.06);
});

test("caps model rows at 32, aggregates every overflow into other and preserves complete totals", () => {
  const entries = Array.from({ length: 40 }, (_, index) =>
    assistant(`entry-${index}`, `provider-${index}`, `model-${index}`, usage(index + 1, 1, { cost: 0.01 })),
  );
  const stats = base(entries);
  assert.equal(stats.models.length, 32);
  const other = stats.models.find((group) => group.provider === "other" && group.model === "other");
  assert.ok(other);
  assert.equal(other.requests, 9);
  assert.equal(other.input, 324);
  assert.ok(typeof other.cost === "number" && Math.abs(other.cost - 0.09) < Number.EPSILON);
  assert.equal(stats.totals.requests, 40);
  assert.equal(stats.totals.input, 820);
  assert.equal(stats.totals.output, 40);
  assert.ok(typeof stats.totals.cost === "number" && Math.abs(stats.totals.cost - 0.4) < Number.EPSILON);
  assert.equal(stats.truncated, true);
});

test("rejects unsafe counters and cost components, saturates overflow, and marks output truncated", () => {
  const stats = base([
    assistant("invalid", "p", "invalid", {
      input: -1,
      output: Number.NaN,
      cacheRead: Number.POSITIVE_INFINITY,
      cacheWrite: 4,
      totalTokens: 4,
      cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: -1 },
    }),
    assistant(
      "overflow",
      "p",
      "large",
      usage(Number.MAX_SAFE_INTEGER, 0, { totalTokens: Number.MAX_SAFE_INTEGER, cost: Number.MAX_VALUE }),
    ),
    assistant("overflow-2", "p", "large", usage(1, 0, { totalTokens: 1, cost: Number.MAX_VALUE })),
  ]);
  assert.equal(stats.truncated, true);
  assert.equal(stats.totals.input, Number.MAX_SAFE_INTEGER);
  assert.equal(stats.totals.totalTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(stats.totals.cost, Number.MAX_VALUE);
  assert.equal(stats.totals.unpricedRequests, 1);
  assert.equal(stats.totals.requests, 3);
});

test("does not count assistant messages without usage, but keeps explicit zero usage", () => {
  const stats = base([
    { type: "message", id: "user", message: { role: "user", content: "never copied to output" } },
    assistant("empty-abort", "p", "aborted-model", undefined, { stopReason: "aborted" }),
    { type: "usage", id: "zero", usage: usage(0, 0), provider: "p", model: "m" },
  ]);
  assert.equal(stats.lastResponse, null);
  assert.equal(stats.totals.requests, 1);
  assert.equal(stats.totals.cost, 0);
  assert.ok(!JSON.stringify(stats).includes("never copied"));
});

test("bounds oversized model labels, uses the overflow bucket, and makes summary row labels unique", () => {
  const longModel = "m".repeat(257);
  const stats = base([
    assistant("long", "p", longModel, usage(3, 2, { cost: 0.3 })),
    assistant("literal-other", "other", "other", usage(1, 1, { cost: 0.1 })),
    assistant("real-tools-label", "tools", "summaries", usage(2, 0, { cost: 0.2 })),
    { type: "compaction", id: "summary", usage: usage(1, 1, { cost: 0.1 }), summary: "private summary text" },
    {
      type: "message",
      id: "empty",
      message: { role: "assistant", provider: "p", model: "no-usage", stopReason: "aborted" },
    },
  ]);

  assert.equal(stats.totals.requests, 4);
  assert.equal(stats.totals.input, 7);
  assert.equal(stats.totals.output, 4);
  assert.equal(stats.totals.totalTokens, 11);
  assert.equal(stats.truncated, true);
  assert.ok(stats.models.length <= 32);
  assert.ok(stats.models.every((group) => group.provider.length <= 256 && group.model.length <= 256));
  assert.equal(
    new Set(stats.models.map(({ provider, model }) => JSON.stringify([provider, model]))).size,
    stats.models.length,
  );
  const overflow = stats.models.find((group) => group.provider === "other" && group.model === "other");
  assert.ok(overflow);
  assert.equal(overflow.requests, 2);
  assert.equal(overflow.input, 4);
  const summary = stats.models.find((group) => group.provider === "tools" && group.model.includes("summary"));
  assert.ok(summary);
  assert.notEqual(summary.model, "summaries");
  assert.equal(stats.lastResponse?.model, "summaries");
});
