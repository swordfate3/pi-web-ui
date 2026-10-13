import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSessionTree, decodeSessionTreeOrKeep } from "../src/web/src/core/session-tree-wire.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";

const wire = (id: string, parentNodeId: string | null = null) => ({
  entry: { id, type: "message", message: { role: "user", content: id } },
  parentNodeId,
});
const legacy = (id: string, children: unknown[] = []) => ({ entry: wire(id).entry, children });

test("rebuilds all 10k linear nodes without recursion or truncation", () => {
  const treeNodes = Array.from({ length: 10_000 }, (_, i) => wire(String(i), i ? String(i - 1) : null));
  const tree = decodeSessionTree({ treeNodes });
  assert.equal(tree.length, 1);
  let children = tree;
  for (let i = 0; i < treeNodes.length; i++) {
    assert.equal(children.length, 1);
    assert.equal(children[0].entry.id, String(i));
    children = children[0].children;
  }
  assert.equal(children.length, 0);
});

test("preserves root/sibling order, every entry and labels; uses structural parents only", () => {
  const root = wire("z");
  const branch = { ...wire("b", "z"), label: "branch", labelTimestamp: "2026-01-01" };
  const child = { ...wire("c", "b"), entry: { ...wire("c").entry, parentId: "z" } };
  const sibling = { ...wire("a", "z"), label: "" };
  const tree = decodeSessionTree({ treeNodes: [root, branch, child, sibling, wire("root-2")] });
  assert.deepEqual(
    tree.map((node) => node.entry.id),
    ["z", "root-2"],
  );
  assert.deepEqual(
    tree[0].children.map((node) => node.entry.id),
    ["b", "a"],
  );
  assert.equal(tree[0].children[0].label, branch.label);
  assert.equal(tree[0].children[0].labelTimestamp, branch.labelTimestamp);
  assert.equal(tree[0].children[1].label, "");
  assert.equal(tree[0].children[0].children[0].entry, child.entry);
  assert.equal(child.entry.parentId, "z");
});

test("accepts legacy trees, retaining order and labels, including a 10k chain", () => {
  const root = { ...legacy("0"), label: "root", labelTimestamp: "time" };
  let node = root;
  for (let i = 1; i < 10_000; i++) {
    const child = { ...legacy(String(i)), label: "child", labelTimestamp: "time" };
    node.children.push(child);
    node = child;
  }
  let children = decodeSessionTree({ tree: [root, legacy("other")] });
  assert.equal(children[0].label, "root");
  assert.equal(children[1].entry.id, "other");
  for (let i = 0; i < 10_000; i++) {
    assert.equal(children[0].entry.id, String(i));
    children = children[0].children;
  }
  assert.equal(children.length, 0);
});

const invalidSnapshots: Array<[string, { treeNodes?: unknown; tree?: unknown }]> = [
  ["non-array flat", { treeNodes: "[Truncated]" }],
  ["null flat", { treeNodes: null }],
  ["undefined flat", { treeNodes: undefined }],
  ["null node", { treeNodes: [null] }],
  ["missing entry", { treeNodes: [{ parentNodeId: null }] }],
  ["missing id", { treeNodes: [{ entry: { type: "message" }, parentNodeId: null }] }],
  ["empty id", { treeNodes: [wire("")] }],
  ["invalid type", { treeNodes: [{ ...wire("a"), entry: { id: "a", type: {} } }] }],
  ["duplicate id", { treeNodes: [wire("a"), wire("a")] }],
  ["missing structural parent", { treeNodes: [wire("a", "absent")] }],
  ["missing parent field", { treeNodes: [{ entry: wire("a").entry }] }],
  ["invalid parent", { treeNodes: [{ ...wire("a"), parentNodeId: 42 }] }],
  ["invalid label", { treeNodes: [{ ...wire("a"), label: {} }] }],
  ["invalid labelTimestamp", { treeNodes: [{ ...wire("a"), labelTimestamp: 42 }] }],
  ["self cycle", { treeNodes: [wire("a", "a")] }],
  ["disconnected cycle", { treeNodes: [wire("root"), wire("a", "b"), wire("b", "a")] }],
  ["entry parent cycle", { treeNodes: [{ ...wire("a"), entry: { ...wire("a").entry, parentId: "a" } }] }],
  ["invalid message", { treeNodes: [{ ...wire("a"), entry: { ...wire("a").entry, message: "bad" } }] }],
  [
    "invalid message block",
    { treeNodes: [{ ...wire("a"), entry: { id: "a", type: "message", message: { role: "user", content: [null] } } }] },
  ],
  ["legacy string tree", { tree: "[Truncated]" }],
  ["legacy string children", { tree: [{ ...legacy("a"), children: "[Truncated]" }] }],
  ["legacy missing children", { tree: [{ entry: wire("a").entry }] }],
  ["legacy duplicate id", { tree: [legacy("a", [legacy("a")])] }],
  ["bad flat cannot fall back to legacy", { treeNodes: "bad", tree: [legacy("fallback")] }],
];
const cyclicLegacy = legacy("cycle");
cyclicLegacy.children.push(cyclicLegacy);
invalidSnapshots.push(["legacy object cycle", { tree: [cyclicLegacy] }]);

for (const [name, snapshot] of invalidSnapshots) {
  test(`rejects ${name} atomically and retains previous tree`, () => {
    const previous = decodeSessionTree({ treeNodes: [wire("previous")] });
    assert.throws(() => decodeSessionTree(snapshot), /Invalid session tree/);
    const result = decodeSessionTreeOrKeep(snapshot, previous);
    assert.equal(result.ok, false);
    assert.equal(result.tree, previous);
    assert.match(result.error ?? "", /Invalid session tree/);
  });
}

test("flat takes precedence; empty snapshots and explicit empty trees are valid", () => {
  assert.deepEqual(decodeSessionTree({ treeNodes: [], tree: [legacy("ignored")] }), []);
  assert.deepEqual(decodeSessionTree({}), []);
  assert.deepEqual(decodeSessionTree({ tree: [] }), []);
});

test("applyStateSync keeps a valid tree/selection on failure and clears errors on recovery", () => {
  // Minimal in-memory store, not a WebSocket mock or E2E fixture.
  let state: ReturnType<typeof createSessionSlice>;
  const get = () => state;
  const set = (patch: unknown) => {
    Object.assign(state, typeof patch === "function" ? patch(state) : patch);
  };
  state = createSessionSlice(set as never, get as never, {} as never);
  Object.assign(state, { requestGitStatusRefresh() {} });
  state.applyStateSync({ treeNodes: [wire("good")], leafId: "good" });
  const previous = state.tree;
  state.setSelectedTreeEntryId("good");
  for (const [, snapshot] of invalidSnapshots) {
    state.applyStateSync({ ...snapshot, leafId: "bad" } as Parameters<typeof state.applyStateSync>[0]);
    assert.equal(state.tree, previous);
    assert.equal(state.leafId, "good");
    assert.equal(state.selectedTreeEntryId, "good");
    assert.match(state.conversationSyncError ?? "", /Invalid session tree/);
  }
  state.applyStateSync({ treeNodes: [wire("new")], leafId: "new" });
  assert.equal(state.tree[0].entry.id, "new");
  assert.equal(state.conversationSyncError, null);
  state.applyStateSync({ tree: [legacy("old-format")], leafId: "old-format" });
  assert.equal(state.tree[0].entry.id, "old-format");
});

test("applyStateSync handles 10k nodes and preserves a deep selection", () => {
  let state: ReturnType<typeof createSessionSlice>;
  state = createSessionSlice(
    ((patch: object) => Object.assign(state, patch)) as never,
    (() => state) as never,
    {} as never,
  );
  Object.assign(state, { requestGitStatusRefresh() {} });
  const treeNodes = Array.from({ length: 10_000 }, (_, i) => wire(String(i), i ? String(i - 1) : null));
  state.applyStateSync({ treeNodes, leafId: "9999" });
  state.setSelectedTreeEntryId("9998");
  state.applyStateSync({ treeNodes, leafId: "9999" });
  assert.equal(state.selectedTreeEntryId, "9998");
  assert.equal(state.conversationSyncError, null);
});
