import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.equal(page.entries.length, 100);
  assert.equal(page.entries[0].id, "id-105");
  assert.equal(page.history.nextBefore, "id-105");
  const older = selectSessionHistory(entries, [], { from, to, before: page.history.nextBefore! });
  assert.equal(older.entries[0].id, "id-5");
  assert.equal(older.entries.at(-1)?.id, "id-104");
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
  assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) <= 512 * 1024);
  assert.ok(!JSON.stringify(page.entries).includes(huge));
  assert.equal(JSON.stringify(entries), original);
});

test("byte paging makes progress even for many medium-sized entries", () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({
    ...entry(`id-${i}`, from + i),
    metadata: "m".repeat(20_000),
  }));
  let before: string | undefined;
  const ids: string[] = [];
  do {
    const page = selectSessionHistory(entries, [], { from, to, before });
    assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) <= 512 * 1024);
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
  assert.ok(page.entries.every((value) => Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024));
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
  assert.ok(page.entries.every((value) => Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024));
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
      metadata: boundary === "byte" ? "m".repeat(20_000) : "",
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
        content: "result " + (boundary === "byte" ? "r".repeat(20_000) : "complete"),
      },
    };
    const users = Array.from({ length: boundary === "count" ? 99 : boundary === "byte" ? 25 : 0 }, (_, i) => ({
      ...entry(`user-${i}`, from + 2 + i),
      ...(boundary === "byte" ? { metadata: "m".repeat(20_000) } : {}),
    }));
    const page = selectSessionHistory([call, result, ...users], [], { from, to });
    assert.ok(!page.entries.some((value) => value.id === "call"));
    assert.ok(page.entries.some((value) => value.id === "result"));
    assert.ok(page.entries.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) <= 512 * 1024);
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
  assert.equal(page.treeNodes.length, 1000);
  const ids = new Set(page.treeNodes.map((n) => n.entry.id));
  for (const n of page.treeNodes) {
    assert.ok(n.parentNodeId === null || ids.has(n.parentNodeId));
    assert.ok(!("data" in n.entry));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4 * 1024 * 1024);
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
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4 * 1024 * 1024);
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
