import assert from "node:assert/strict";
import { test } from "node:test";
import * as historyApi from "../extensions/session-history.ts";
import {
  guardHistoryFrame,
  selectSessionHistory,
  selectSavedSessions,
  utcRecentRange,
} from "../extensions/session-history.ts";
import { syncToItems } from "../src/web/src/core/chat-conversion.ts";
import { isToolExpandable, isToolHistoryPreview } from "../src/web/src/core/tool-summary.ts";

const from = Date.parse("2026-10-13T00:00:00Z");
const to = Date.parse("2026-10-16T00:00:00Z");
const entry = (id: string, timestamp = from) => ({
  id,
  type: "message",
  parentId: null,
  timestamp: new Date(timestamp).toISOString(),
  message: { role: "user", content: id },
});

test("approved history byte/count budgets traverse every entry newest-first without mutation", () => {
  const entries = Array.from({ length: 125 }, (_, i) => ({
    ...entry(`bounded-${i}`, from + i),
    message: { role: "user", content: "中\u0001".repeat(1500) },
  }));
  const original = JSON.stringify(entries);
  let before: string | undefined;
  const ids: string[] = [];
  do {
    const page = selectSessionHistory(entries, [], { from, to, before });
    assert.ok(page.entries.length > 0 && page.entries.length <= 40);
    assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) <= 192 * 1024);
    for (const value of page.entries) assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024);
    ids.unshift(...page.entries.map((value) => value.id!));
    assert.notEqual(page.history.nextBefore, before);
    before = page.history.nextBefore ?? undefined;
  } while (before);
  assert.deepEqual(ids, entries.map((value) => value.id));
  assert.equal(JSON.stringify(entries), original);
});

test("final history envelopes budget metadata and request IDs, reduce pages with progress, and fail closed", () => {
  const serialize = (envelope: unknown) => historyApi.serializeHistoryEnvelope(envelope);
  const entries = Array.from({ length: 80 }, (_, i) => ({
    ...entry(`envelope-${i}`, from + i), message: { role: "user", content: "x".repeat(14_000) },
  }));
  const tree = entries.map((value) => ({ entry: value, children: [] }));
  const page = selectSessionHistory(entries, tree, { from, to });
  const original = JSON.stringify(page);
  for (const type of ["event", "res"]) {
    const field = type === "event" ? "payload" : "result";
    const envelope = { type, ...(type === "event" ? { event: "state_sync" } : { id: "\u0001".repeat(512), ok: true }),
      [field]: { ...page, sessionId: "s", runtimeId: "r", model: { id: "m", metadata: "x".repeat(95_000) }, status: "ok" } };
    const raw = serialize(envelope);
    assert.ok(raw);
    assert.ok(Buffer.byteLength(raw) <= 256 * 1024);
    const result = JSON.parse(raw)[field];
    assert.equal(result.sessionId, "s");
    assert.equal(result.runtimeId, "r");
    assert.ok(result.entries.length > 0);
    assert.equal(result.entries.at(-1).id, "envelope-79");
    assert.equal(result.history.nextBefore, result.entries[0].id);
    assert.equal(result.history.returned, result.entries.length);
    const older = selectSessionHistory(entries, [], { from, to, before: result.history.nextBefore });
    assert.equal(older.entries.at(-1)?.id, `envelope-${Number(result.entries[0].id.split("-")[1]) - 1}`);
  }
  assert.equal(JSON.stringify(page), original);
  const rejectedRaw = serialize({ type: "res", id: "request", ok: true,
    result: { ...page, model: { id: "x".repeat(300_000), toJSON() { throw new Error("must not serialize source"); } } } });
  assert.ok(rejectedRaw);
  const rejected = JSON.parse(rejectedRaw);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.id, "request");
  assert.match(rejected.error, /limit|large|budget/i);
  assert.equal(serialize({ type: "res", id: "download", ok: true, result: { text: "x".repeat(300_000) } }), null);
});

test("history uses half-open dates and preserves chronological entries and source data", () => {
  const entries = [entry("old", from - 1), entry("recent-a"), entry("recent-b", to - 1), entry("future", to)];
  const before = JSON.stringify(entries);
  const page = selectSessionHistory(entries, [], { from, to });
  assert.deepEqual(
    page.entries.map((e) => e.id),
    ["recent-a", "recent-b"],
  );
  assert.deepEqual(page.entries, entries.slice(1, 3));
  assert.equal(page.history.total, 2);
  assert.equal(page.history.nextBefore, null);
  assert.equal(JSON.stringify(entries), before);
});

test("pages select newest entries, return chronological order and use entry ID cursors", () => {
  const entries = Array.from({ length: 205 }, (_, i) => entry(`id-${i}`, from + i));
  const page = selectSessionHistory(entries, [], { from, to });
  assert.equal(page.entries.length, 40);
  assert.equal(page.entries[0].id, "id-165");
  assert.equal(page.history.nextBefore, "id-165");
  const older = selectSessionHistory(entries, [], { from, to, before: page.history.nextBefore! });
  assert.equal(older.entries[0].id, "id-125");
  assert.equal(older.entries.at(-1)?.id, "id-164");
  assert.throws(() => selectSessionHistory(entries, [], { from, to, before: "missing" }), /cursor/i);
  assert.throws(() => selectSessionHistory(entries, [], { from: to, to: from }), /date|range/i);
  assert.throws(() => selectSessionHistory(entries, [], { from: "0" as never, to }), /date|range/i);
  assert.throws(() => selectSessionHistory(entries, [], { from, to: Infinity }), /date|range/i);
});

test("huge text, tool, image, custom data and metadata become bounded explicit previews without mutation", () => {
  const huge = "秘密".repeat(500_000);
  const entries = [
    { ...entry("text"), message: { role: "assistant", content: huge } },
    { ...entry("tool"), message: { role: "assistant", content: [{ type: "toolCall", arguments: { huge } }] } },
    { ...entry("image"), message: { role: "user", content: [{ type: "image", data: huge }] } },
    { ...entry("custom"), type: "custom", data: { huge } },
    { ...entry("metadata"), metadata: { huge } },
  ];
  const original = JSON.stringify(entries);
  const page = selectSessionHistory(entries, [], { from, to });
  assert.equal(page.history.truncatedEntries, 5);
  assert.ok(page.entries.every((e) => e.historyPreview === true));
  assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) <= 192 * 1024);
  assert.ok(!JSON.stringify(page.entries).includes(huge));
  assert.equal(JSON.stringify(entries), original);
});

test("byte paging makes progress even for many medium-sized entries", () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({
    ...entry(`id-${i}`, from + i),
    metadata: "m".repeat(14_000),
  }));
  let before: string | undefined;
  const ids: string[] = [];
  do {
    const page = selectSessionHistory(entries, [], { from, to, before });
    assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) <= 192 * 1024);
    assert.ok(page.entries.length > 0);
    ids.unshift(...page.entries.map((e) => e.id!));
    before = page.history.nextBefore ?? undefined;
  } while (before);
  assert.deepEqual(
    ids,
    entries.map((e) => e.id),
  );
});

test("oversized tool previews retain invocation/result associations after snapshot conversion", () => {
  const huge = "synthetic content\n".repeat(30_000);
  const argumentsValue = { path: "workspace/large.txt", command: "x".repeat(400), content: huge };
  const entries = [
    {
      ...entry("call"),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "exact-call-id", name: "write", arguments: argumentsValue }],
      },
    },
    {
      ...entry("result"),
      message: {
        role: "toolResult",
        toolCallId: "exact-call-id",
        toolName: "write",
        isError: true,
        content: [{ type: "text", text: huge }],
      },
    },
    {
      ...entry("small-call"),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "small-id", name: "read", arguments: { path: "workspace/small.txt" } }],
      },
    },
    {
      ...entry("small-result"),
      message: {
        role: "toolResult",
        toolCallId: "small-id",
        toolName: "read",
        content: [{ type: "text", text: "complete small result" }],
      },
    },
  ];
  const original = JSON.stringify(entries);
  const page = selectSessionHistory(entries, [], { from, to });
  const items = syncToItems(page.entries as Parameters<typeof syncToItems>[0], (prefix) => prefix);
  const tool = items.find((item) => item.kind === "tool" && item.id === "exact-call-id");
  assert.ok(tool?.kind === "tool", "the settled snapshot must not lose the tool row");
  assert.equal(tool.name, "write");
  assert.equal(tool.state, "output-error");
  assert.deepEqual(tool.relatedEntryIds, ["call", "result"]);
  const input = tool.input as Record<string, unknown>;
  assert.equal(input.path, argumentsValue.path);
  assert.equal(input.command, argumentsValue.command.slice(0, 160));
  assert.equal(input.historyPreview, true);
  assert.equal(isToolHistoryPreview(tool), true);
  assert.match(String(input.notice), /preview|omitted/i);
  assert.ok(!("content" in input), "large content is omitted, not replaced with fake original arguments");
  assert.equal(page.entries[1].message?.toolName, "write");
  assert.match(tool.errorText!, /preview/i);
  assert.deepEqual(page.entries.slice(2), entries.slice(2), "ordinary small entries stay complete");
  assert.ok(
    items.some((item) => item.kind === "tool" && item.id === "small-id" && item.output === "complete small result"),
  );
  assert.equal(page.history.truncatedEntries, 2);
  assert.ok(page.entries.every((value) => Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024));
  assert.equal(JSON.stringify(entries), original);
});

test("tool preview identities are exact and abnormal identities reject rather than truncate", () => {
  const huge = "x".repeat(40_000);
  const id = "\u0001".repeat(512);
  const call = {
    ...entry("call"),
    message: { role: "assistant", content: [{ type: "toolCall", id, name: "write", arguments: { content: huge } }] },
  };
  const result = { ...entry("result"), message: { role: "toolResult", toolCallId: id, content: huge } };
  const page = selectSessionHistory([call, result], [], { from, to });
  const items = syncToItems(page.entries as Parameters<typeof syncToItems>[0], (prefix) => prefix);
  assert.equal(items[0].id, id);
  assert.equal(page.entries[1].message?.toolCallId, id);
  assert.ok(page.entries.every((value) => Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024));
  const invalidCall = {
    ...call,
    message: { ...call.message, content: [{ ...call.message.content[0], id: `${id}x` }] },
  };
  assert.throws(() => selectSessionHistory([invalidCall], [], { from, to }), /identity/i);
  assert.throws(
    () => selectSessionHistory([{ ...result, message: { ...result.message, toolCallId: `${id}x` } }], [], { from, to }),
    /identity/i,
  );
});

for (const boundary of ["count", "byte", "date"] as const) {
  test(`tool results remain visible when a ${boundary} boundary excludes their invocation`, () => {
    const call = {
      ...entry("call", boundary === "date" ? from - 1 : from),
      metadata: boundary === "byte" ? "m".repeat(14_000) : "",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "split-call", name: "read", arguments: { path: "workspace/example.txt" } }],
      },
    };
    const result = {
      ...entry("result", from + 1),
      message: {
        role: "toolResult",
        toolCallId: "split-call",
        toolName: "read",
        isError: boundary === "date",
        content: "result " + (boundary === "byte" ? "r".repeat(14_000) : "complete"),
      },
    };
    const users = Array.from({ length: boundary === "count" ? 39 : boundary === "byte" ? 12 : 0 }, (_, i) => ({
      ...entry(`user-${i}`, from + 2 + i),
      ...(boundary === "byte" ? { metadata: "m".repeat(14_000) } : {}),
    }));
    const page = selectSessionHistory([call, result, ...users], [], { from, to });
    assert.ok(!page.entries.some((value) => value.id === "call"));
    assert.ok(page.entries.some((value) => value.id === "result"));
    assert.ok(page.entries.length <= 40);
    assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) <= 192 * 1024);
    const tool = syncToItems(page.entries as Parameters<typeof syncToItems>[0], (prefix) => prefix).find(
      (item) => item.kind === "tool",
    );
    assert.ok(tool?.kind === "tool", "an orphan result must remain visible without expanding the page");
    assert.equal(tool.id, "split-call");
    assert.equal(tool.name, "read");
    assert.equal(tool.entryId, "result");
    assert.deepEqual(tool.relatedEntryIds, ["result"]);
    assert.equal(boundary === "date" ? tool.errorText : tool.output, result.message.content);
    assert.equal(tool.state, boundary === "date" ? "output-error" : "output-available");
    assert.equal((tool.input as Record<string, unknown>).historyPreview, true);
    assert.equal(isToolExpandable(tool), true, "orphan read results must be expandable");
    assert.equal(tool.resultOnly, true);
    assert.equal(isToolHistoryPreview(tool), true);
  });
}

test("10k-node tree is a bounded lightweight preview with valid structural parents", () => {
  const roots = [{ entry: entry("0"), children: [] as any[] }];
  let node = roots[0];
  for (let i = 1; i < 10_000; i++) {
    const child = { entry: { ...entry(String(i)), data: "x".repeat(2000) }, children: [] };
    node.children.push(child);
    node = child;
  }
  const page = selectSessionHistory([], roots, { from, to });
  assert.equal(page.history.treeLimited, true);
  assert.ok(page.treeNodes.length > 0 && page.treeNodes.length <= 200);
  assert.equal(page.treeNodes.at(-1)?.entry.id, "9999");
  assert.ok(Buffer.byteLength(JSON.stringify(page.treeNodes)) <= 32 * 1024);
  const ids = new Set(page.treeNodes.map((n) => n.entry.id));
  for (const n of page.treeNodes) {
    assert.ok(n.parentNodeId === null || ids.has(n.parentNodeId));
    assert.ok(!("data" in n.entry));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
});

test("saved session date filtering happens before capping and reports truncation", () => {
  const sessions = [
    { id: "old", modified: new Date(from - 1) },
    { id: "a", modified: new Date(from) },
    { id: "b", modified: new Date(to - 1) },
    { id: "future", modified: new Date(to) },
  ];
  const result = selectSavedSessions(sessions, { from, to }, 1);
  assert.deepEqual(
    result.sessions.map((s) => s.id),
    ["b"],
  );
  assert.equal(result.total, 2);
  assert.equal(result.truncated, true);
});

test("tree dates do not leak older message bodies and excluded parents become structural roots", () => {
  const old = {
    entry: entry("old-marker", from - 1),
    children: [{ entry: { ...entry("recent"), parentId: "original-parent" }, children: [] }],
  };
  const page = selectSessionHistory([], [old], { from, to });
  assert.deepEqual(
    page.treeNodes.map((n) => n.entry.id),
    ["recent"],
  );
  assert.equal(page.treeNodes[0].parentNodeId, null);
  assert.equal(page.treeNodes[0].entry.parentId, "original-parent");
  assert.equal(page.history.treeLimited, true);
  assert.ok(!JSON.stringify(page.treeNodes).includes("old-marker"));
});

test("tree also enforces a byte budget for long opaque IDs and escape-heavy labels", () => {
  const padding = "\u0001".repeat(500);
  const roots = Array.from({ length: 1000 }, (_, i) => ({
    entry: { ...entry(`${i}-${padding}`), parentId: padding, summary: padding, label: padding },
    label: padding,
    children: [],
  }));
  const page = selectSessionHistory([], roots, { from, to });
  assert.equal(page.history.treeLimited, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page.treeNodes)) <= 32 * 1024);
  assert.ok(page.treeNodes.length > 0);
  assert.equal(page.treeNodes.at(-1)?.entry.id, `999-${padding}`);
});

test("bootstrap uses three UTC calendar days and oversize transport errors preserve request IDs", () => {
  assert.deepEqual(utcRecentRange(Date.parse("2026-10-15T12:34:56Z")), { from, to });
  const raw = JSON.stringify({ type: "event", event: "message_update", payload: { delta: "ok" } });
  assert.equal(guardHistoryFrame(raw, { type: "event" }), raw);
  const oversized = "x".repeat(5 * 1024 * 1024);
  const rejected = JSON.parse(guardHistoryFrame(oversized, { type: "res", id: "request-1" }));
  assert.equal(rejected.id, "request-1");
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /large|limit/i);
  assert.ok(guardHistoryFrame(oversized, { type: "event" }).length < 1000);
  assert.ok(guardHistoryFrame(oversized, { type: "res", id: oversized }).length < 1000);
});
