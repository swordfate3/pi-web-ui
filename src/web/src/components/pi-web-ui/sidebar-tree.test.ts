import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setLanguage } from "../../core/i18n";
import type { SessionTreeNode } from "../../core/types";
import { indexConversationTree, projectConversationTree, searchConversationTree } from "./conversation-tree-model";
import { SIDEBAR_PREVIEW_SCAN_BUDGET, sidebarContentPreview } from "./sidebar-tree-preview";
import {
  SIDEBAR_TREE_ROW_HEIGHT,
  sidebarScrollOffset,
  sidebarVirtualIndices,
  sidebarVirtualRange,
} from "./sidebar-virtual-rows";

const node = (id: string, children: SessionTreeNode[] = [], content = id): SessionTreeNode => ({
  entry: { id, type: "message", message: { role: "user", content } },
  children,
});
const project = (index: ReturnType<typeof indexConversationTree>, query = "", collapsed = new Set<string>()) =>
  projectConversationTree(index, searchConversationTree(index, query), collapsed);

test("6000-deep complete history: iterative indexing, leaf order and bounded virtual range", () => {
  const root = node("0");
  let previous = root;
  for (let i = 1; i < 6000; i++) {
    const child = node(String(i));
    previous.children.push(child);
    previous = child;
  }
  const index = indexConversationTree([root], "5999");
  const result = project(index);
  assert.equal(result.items.length, 6000);
  assert.equal(result.currentOrder, 5999);
  assert.equal(result.items[5999].isLeaf, true);
  const match = project(index, "5999");
  assert.equal(match.items.length, 6000, "search retains every ancestor, never truncates history");
  assert.equal(match.items.filter((item) => item.isSearchMatch).length, 1);
  const top = sidebarScrollOffset(5999, 6000, 640);
  const range = sidebarVirtualRange(6000, top, 640);
  assert.ok(range.end - range.start <= 33);
  assert.equal(range.end, 6000);
  assert.equal(top, 6000 * SIDEBAR_TREE_ROW_HEIGHT - 640);
});

test("cached summaries, labels, hidden settings ancestors, collapse override and actions", () => {
  let scans = 0;
  const left = node("left", [node("left-end")]);
  left.label = "named-branch";
  const right = node("right", [{ entry: { id: "right-end", type: "compaction", summary: "content" }, children: [] }]);
  const root = node("root", [{ entry: { id: "settings", type: "model_change" }, children: [left, right] }]);
  Object.defineProperty(left.entry.message, "content", {
    get: () => {
      scans++;
      return "left content";
    },
  });
  const index = indexConversationTree([root], "left-end");
  const initialScans = scans;
  const collapsed = project(index, "", new Set(["left"]));
  assert.equal(collapsed.items.find((item) => item.id === "left")?.hiddenChildCount, 1);
  assert.equal(collapsed.currentOrder, -1);
  assert.equal(collapsed.items.find((item) => item.id === "left")?.isBranchable, true);
  const matched = project(index, "named-branch", new Set(["left"]));
  assert.deepEqual(
    matched.items.map((item) => item.id),
    ["root", "left"],
  );
  assert.equal(matched.items[1].isSearchMatch, true);
  assert.equal(matched.items[1].isExpanded, true);
  const end = project(index).items.find((item) => item.id === "right-end");
  assert.equal(end?.isContinuable, true);
  assert.equal(end?.continueTargetId, "right-end");
  assert.equal(index.visibleParentById.get("left"), "root");
  assert.equal(scans, initialScans, "search/collapse never read raw messages again");
});

test("language invalidates summaries, never translates actual content", () => {
  const tree = [node("raw", [], "Settings /path/file.md"), node("empty", [], "")];
  try {
    setLanguage("en");
    assert.equal(project(indexConversationTree(tree, "empty")).items[0].text, "User message");
    setLanguage("zh-CN");
    const index = indexConversationTree(tree, "empty");
    assert.equal(index.itemMetaById.get("empty")?.text, "用户消息");
    assert.equal(index.itemMetaById.get("raw")?.text, "Settings /path/file.md");
    assert.equal(project(index, "用户消息").items[0].id, "empty");
  } finally {
    setLanguage("en");
  }
});

test("tool invocation summary skips large output and preview never serializes images", () => {
  let outputReads = 0;
  const tool: SessionTreeNode = {
    entry: {
      id: "result",
      type: "message",
      message: { role: "toolResult", toolName: "bash", toolCallId: "call", content: [] },
    },
    children: [],
  };
  Object.defineProperty(tool.entry.message, "content", {
    get: () => {
      outputReads++;
      return "huge".repeat(1_000_000);
    },
  });
  const assistant: SessionTreeNode = {
    entry: {
      id: "assistant",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } }],
      },
    },
    children: [tool],
  };
  // Neither tool indexing nor summary extraction may read results with invocation details.
  const index = indexConversationTree([assistant], "result");
  assert.equal(index.itemMetaById.get("result")?.detail, "pwd");
  assert.equal(outputReads, 0);
  const image = { type: "image", data: "base64" };
  Object.defineProperty(image, "data", {
    get: () => {
      throw new Error("must not serialize image");
    },
  });
  assert.equal(sidebarContentPreview([image]), "");
  assert.equal(sidebarContentPreview("  a\n b  "), "a b");
  assert.equal(sidebarContentPreview("x".repeat(1_000_000)).length, 142);
});

test("virtual offsets clamp empty, beginning, middle and stale scroll positions", () => {
  assert.deepEqual(sidebarVirtualRange(0, 100, 500), { start: 0, end: 0 });
  assert.equal(sidebarScrollOffset(0, 100, 320), 0);
  assert.equal(sidebarScrollOffset(50, 100, 320), 1456);
  const range = sidebarVirtualRange(10, 1_000_000, 160);
  assert.equal(range.end, 10);
  assert.ok(range.start < range.end);
});

test("structural parents win over stale entry parentId and hidden current leaf resolves to ancestor", () => {
  const hidden: SessionTreeNode = { entry: { id: "hidden", type: "session_info", parentId: "other" }, children: [] };
  const child = node("child", [hidden]);
  child.entry.parentId = "other";
  const tree = [node("root", [child]), node("other")];
  const index = indexConversationTree(tree, "hidden");
  assert.equal(index.effectiveLeafId, "child");
  assert.equal(index.visibleParentById.get("child"), "root");
  assert.equal(project(index).items.find((item) => item.id === "child")?.isLeaf, true);
});

test("preview work budget includes huge whitespace and marks unknown suffixes explicitly", () => {
  const whitespace = " ".repeat(10_000_000);
  assert.equal(sidebarContentPreview(whitespace), "...");
  assert.equal(sidebarContentPreview(`${whitespace}actual text`), "...");
  assert.equal(sidebarContentPreview(`prefix${whitespace}suffix`), "prefix...");
  assert.equal(sidebarContentPreview(" ".repeat(SIDEBAR_PREVIEW_SCAN_BUDGET)), "");
  assert.equal(sidebarContentPreview(`${" ".repeat(SIDEBAR_PREVIEW_SCAN_BUDGET)}x`), "...");
  assert.equal(sidebarContentPreview(`${" ".repeat(SIDEBAR_PREVIEW_SCAN_BUDGET - 1)}x`), "x");
  assert.equal(
    sidebarContentPreview([
      { type: "text", text: " ".repeat(SIDEBAR_PREVIEW_SCAN_BUDGET) },
      { type: "text", text: "later block" },
    ]),
    "...",
    "the scan budget is shared across content blocks",
  );
  // Prove bounded character iteration rather than relying on machine-dependent timings.
  let scanned = 0;
  const iterate = String.prototype[Symbol.iterator];
  String.prototype[Symbol.iterator] = function* (): Generator<string, undefined, unknown> {
    for (const char of iterate.call(this)) {
      scanned++;
      yield char;
    }
    return undefined;
  };
  try {
    assert.equal(sidebarContentPreview(whitespace), "...");
    assert.ok(scanned <= SIDEBAR_PREVIEW_SCAN_BUDGET + 1);
  } finally {
    String.prototype[Symbol.iterator] = iterate;
  }
  const assistant = node("assistant", [], `${whitespace}visible text`);
  if (assistant.entry.message) assistant.entry.message.role = "assistant";
  const emptyAssistant = node("empty-assistant", [], " \n\t");
  if (emptyAssistant.entry.message) emptyAssistant.entry.message.role = "assistant";
  const index = indexConversationTree([assistant, emptyAssistant, node("leaf")], "leaf");
  assert.equal(index.itemMetaById.get("assistant")?.text, "...");
  assert.equal(index.visibleById.has("empty-assistant"), false);
});

test("virtual rows pin only one actual focused entry outside overscan, including reordered IDs", () => {
  const range = sidebarVirtualRange(6000, 80_000, 640);
  const visible = sidebarVirtualIndices(6000, range);
  const pinned = sidebarVirtualIndices(6000, range, 1);
  assert.ok(pinned.includes(1));
  assert.equal(pinned.length, visible.length + 1);
  assert.ok(pinned.length <= 34, "scrolling away from focus never mounts intervening rows");
  assert.equal(new Set(pinned).size, pinned.length);
  assert.deepEqual(sidebarVirtualIndices(6000, range, range.start), visible);
  assert.deepEqual(sidebarVirtualIndices(6000, range, -1), visible);
  assert.deepEqual(sidebarVirtualIndices(6000, range, 6000), visible);
  assert.deepEqual(sidebarVirtualIndices(0, sidebarVirtualRange(0, 0, 640), 0), []);
  // Both row and nested-action focus resolve through the same entry-ID index.
  const original = project(indexConversationTree([node("a"), node("focused")], null));
  const reordered = project(indexConversationTree([node("0"), node("a"), node("focused")], null));
  const focusedIndex = (items: typeof original.items) => new Map(items.map((item, i) => [item.id, i])).get("focused");
  assert.equal(focusedIndex(original.items), 1);
  assert.equal(focusedIndex(reordered.items), 2);
  assert.deepEqual(sidebarVirtualIndices(3, { start: 0, end: 1 }, focusedIndex(reordered.items)), [0, 2]);
});

test("Sidebar owner boundary is session identity, not snapshot or open/close state", () => {
  // Source-level guard: Node unit tests cannot exercise React DOM remounts. Keep
  // the actual App boundary covered rather than duplicating its key in a helper.
  const app = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
  const sidebar = app.match(/<ConversationSidebar\s[\s\S]*?\/>/)?.[0];
  assert.ok(sidebar);
  assert.match(sidebar, /key=\{sessionId \?\? "pending-session"\}/);
  const owner = readFileSync(new URL("./conversation-sidebar.tsx", import.meta.url), "utf8");
  assert.match(owner, /const \[query, setQuery\] = useState\(""\)/);
  assert.match(owner, /useConversationTree\(openedRef\.current \? tree : EMPTY_TREE, leafId, query\.trim\(\)\)/);
  assert.match(owner, /navigationOpen && \([\s\S]*?<ConversationSidebarTree/);
  // Session IDs, even with identical entry IDs, now replace the owner. The null
  // startup owner is provisional and is replaced once the first real ID arrives.
  // New tree references and closing/reopening only affect the child, not the key.
});
