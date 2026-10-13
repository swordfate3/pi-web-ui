import { extractToolCalls } from "../../core/chat-conversion";
import { t } from "../../core/i18n";
import { formatToolInvocationSummary, formatToolInvocationTitle } from "../../core/tool-summary";
import type { ConversationTreeItem, PiContentBlock, SessionEntry, SessionTreeNode } from "../../core/types";
import { sidebarContentPreview } from "./sidebar-tree-preview";

/** Owned by one mounted sidebar; no global cache of historical sessions. */
export function indexConversationTree(tree: SessionTreeNode[], leafId: string | null) {
  const toolCallsById = buildToolCallIndex(tree);
  const nodeById = new Map<string, SessionTreeNode>();
  const parentById = new Map<string, string | null>();
  const visibleById = new Map<string, SessionTreeNode>();
  const visibleRoots: SessionTreeNode[] = [];
  const visibleParentById = new Map<string, string | null>();
  const terminalEntryIds = new Set<string>();
  const itemMetaById = new Map<string, { detail?: string; label?: string; text: string; searchText: string }>();
  const descendantCountById = new Map<string, number>();

  const sourceStack = tree.map((node) => ({ node, parentId: null as string | null })).reverse();
  while (sourceStack.length > 0) {
    const frame = sourceStack.pop();
    if (!frame?.node.entry.id) continue;
    const { node, parentId } = frame;
    const nodeId = frame.node.entry.id;
    nodeById.set(nodeId, node);
    parentById.set(nodeId, parentId);
    if (node.children.length === 0) terminalEntryIds.add(nodeId);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      sourceStack.push({ node: node.children[index], parentId: nodeId });
    }
  }

  const isVisibleNode = (node: SessionTreeNode) => {
    const entry = node.entry;
    const isCurrentLeaf = entry.id === leafId;
    const isSettingsEntry =
      entry.type === "label" ||
      entry.type === "custom" ||
      entry.type === "model_change" ||
      entry.type === "thinking_level_change" ||
      entry.type === "session_info";

    if (isSettingsEntry) return false;
    if (entry.type !== "message" || entry.message?.role !== "assistant" || isCurrentLeaf) return true;

    const message = entry.message as { errorMessage?: string; stopReason?: string };
    const hasText = sidebarContentPreview(entry.message.content).length > 0;
    const isErrorOrAborted = Boolean(message.errorMessage || (message.stopReason && message.stopReason !== "stop"));
    return hasText || isErrorOrAborted;
  };

  for (const node of nodeById.values()) {
    if (!isVisibleNode(node)) continue;
    const nodeId = node.entry.id;
    if (!nodeId) continue;
    visibleById.set(nodeId, {
      children: [],
      entry: node.entry,
      label: node.label,
      labelTimestamp: node.labelTimestamp,
    });
  }

  // Source traversal is preorder: resolve skipped ancestry once, not once per descendant.
  const nearestVisibleById = new Map<string, string | null>();
  for (const node of nodeById.values()) {
    const nodeId = node.entry.id;
    if (!nodeId) continue;
    const sourceParentId = parentById.get(nodeId) ?? null;
    const parentId = sourceParentId ? (nearestVisibleById.get(sourceParentId) ?? null) : null;
    const visibleNode = visibleById.get(nodeId);
    nearestVisibleById.set(nodeId, visibleNode ? nodeId : parentId);
    if (!visibleNode) continue;
    visibleParentById.set(nodeId, parentId);
    const visibleParent = parentId ? visibleById.get(parentId) : undefined;
    if (visibleParent) visibleParent.children.push(visibleNode);
    else visibleRoots.push(visibleNode);
  }

  for (const node of visibleById.values()) {
    node.children.sort(compareTreeNodes);
  }
  visibleRoots.sort(compareTreeNodes);

  const effectiveLeafId = leafId ? (nearestVisibleById.get(leafId) ?? null) : null;

  const matchStack = visibleRoots.map((node) => ({ node, visited: false })).reverse();
  while (matchStack.length > 0) {
    const frame = matchStack.pop();
    const id = frame?.node.entry.id;
    if (!frame || !id) continue;
    if (!frame.visited) {
      matchStack.push({ node: frame.node, visited: true });
      for (let index = frame.node.children.length - 1; index >= 0; index -= 1) {
        matchStack.push({ node: frame.node.children[index], visited: false });
      }
      continue;
    }

    const { detail, text } = getConversationTreeItemText(frame.node.entry, toolCallsById);
    const label = frame.node.label ?? (typeof frame.node.entry.label === "string" ? frame.node.entry.label : undefined);
    const searchText = `${text} ${detail ?? ""} ${label ?? ""} ${frame.node.entry.type}`.toLowerCase();
    itemMetaById.set(id, { detail, label, searchText, text });
    descendantCountById.set(
      id,
      frame.node.children.reduce((count, child) => count + 1 + (descendantCountById.get(child.entry.id ?? "") ?? 0), 0),
    );
  }
  return {
    visibleRoots,
    visibleById,
    visibleParentById,
    itemMetaById,
    terminalEntryIds,
    descendantCountById,
    effectiveLeafId,
    leafId,
  };
}

export type ConversationTreeIndex = ReturnType<typeof indexConversationTree>;

/** One active query only: ancestors remain visible and search overrides collapse. */
export function searchConversationTree(index: ConversationTreeIndex, searchQuery: string) {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const selfMatches = new Set<string>();
  const subtreeMatchesById = new Set<string>();
  if (normalizedQuery) {
    const stack = index.visibleRoots.map((node) => ({ node, visited: false })).reverse();
    while (stack.length) {
      const frame = stack.pop();
      const id = frame?.node.entry.id;
      if (!frame || !id) continue;
      if (!frame.visited) {
        stack.push({ node: frame.node, visited: true });
        for (const child of frame.node.children) stack.push({ node: child, visited: false });
        continue;
      }
      if (index.itemMetaById.get(id)?.searchText.includes(normalizedQuery)) selfMatches.add(id);
      if (selfMatches.has(id) || frame.node.children.some((child) => subtreeMatchesById.has(child.entry.id ?? ""))) {
        subtreeMatchesById.add(id);
      }
    }
  }
  return { normalizedQuery, selfMatches, subtreeMatchesById };
}

export function projectConversationTree(
  index: ConversationTreeIndex,
  search: ReturnType<typeof searchConversationTree>,
  collapsedIds: Set<string>,
) {
  const { visibleRoots, itemMetaById, terminalEntryIds, descendantCountById, effectiveLeafId, leafId } = index;
  const { normalizedQuery, selfMatches, subtreeMatchesById } = search;
  const items: ConversationTreeItem[] = [];
  let currentOrder = -1;
  const renderStack = visibleRoots
    .map((node, index) => ({
      ancestorColumns: [] as ConversationTreeItem["connectorColumns"],
      connectorContinues: false,
      connectorKind: "none" as ConversationTreeItem["connectorKind"],
      depth: 0,
      node,
      siblingIndex: index,
      siblingCount: visibleRoots.length,
    }))
    .reverse();

  while (renderStack.length > 0) {
    const frame = renderStack.pop();
    const id = frame?.node.entry.id;
    if (!frame || !id) continue;
    if (normalizedQuery && !subtreeMatchesById.has(id)) continue;

    const meta = itemMetaById.get(id) ?? { detail: undefined, label: undefined, text: t("Event") };
    const children = frame.node.children.filter(
      (child) => !normalizedQuery || subtreeMatchesById.has(child.entry.id ?? ""),
    );
    const isBranchable = frame.node.entry.type === "message" && frame.node.entry.message?.role === "user";
    const isCustomMessage = frame.node.entry.type === "custom_message";
    const isContinuable = terminalEntryIds.has(id) && id !== leafId && !isBranchable && !isCustomMessage;
    const isBranchSegmentStart = frame.connectorKind === "middle" || frame.connectorKind === "last";
    const isSegmentExpanded = Boolean(normalizedQuery) || !collapsedIds.has(id);
    const isExpandable = isBranchSegmentStart && children.length > 0;
    const item: ConversationTreeItem = {
      childCount: children.length,
      connectorColumns: frame.ancestorColumns,
      connectorKind: frame.connectorKind,
      continueTargetId: isContinuable ? id : undefined,
      depth: frame.depth,
      detail: meta.detail,
      entry: frame.node.entry,
      entryType: frame.node.entry.type,
      hiddenChildCount: isExpandable && !isSegmentExpanded ? (descendantCountById.get(id) ?? 0) : 0,
      id,
      isBranchable,
      isContinuable,
      isExpandable,
      isExpanded: isSegmentExpanded,
      isLeaf: id === effectiveLeafId,
      isSearchMatch: selfMatches.has(id) && Boolean(normalizedQuery),
      label: meta.label,
      order: items.length,
      parentId: frame.node.entry.parentId ?? null,
      text: meta.text,
    };

    if (item.id === effectiveLeafId) currentOrder = item.order;
    items.push(item);

    if (isExpandable && !isSegmentExpanded) continue;
    const childCreatesBranchSegments = children.length > 1;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      const childIsLast = index === children.length - 1;
      renderStack.push(
        childCreatesBranchSegments
          ? {
              ancestorColumns:
                frame.depth > 0
                  ? [
                      ...frame.ancestorColumns,
                      {
                        key: `${id}:column-${frame.depth}`,
                        state: frame.connectorContinues ? "line" : "blank",
                      },
                    ]
                  : [...frame.ancestorColumns],
              connectorContinues: !childIsLast,
              connectorKind: childIsLast ? "last" : "middle",
              depth: frame.depth + 1,
              node: child,
              siblingIndex: index,
              siblingCount: children.length,
            }
          : {
              ancestorColumns: frame.ancestorColumns,
              connectorContinues: frame.connectorContinues,
              connectorKind: frame.depth === 0 ? "none" : frame.connectorContinues ? "line" : "blank",
              depth: frame.depth,
              node: child,
              siblingIndex: index,
              siblingCount: children.length,
            },
      );
    }
  }

  return { currentEntryId: effectiveLeafId, currentOrder, items };
}

/** Compatibility entry point for callers/tests; hook caches the three stages separately. */
export function buildConversationTreeItems({
  tree,
  leafId,
  collapsedIds,
  searchQuery,
}: {
  tree: SessionTreeNode[];
  leafId: string | null;
  collapsedIds: Set<string>;
  searchQuery: string;
}) {
  const index = indexConversationTree(tree, leafId);
  return projectConversationTree(index, searchConversationTree(index, searchQuery), collapsedIds);
}

function getConversationTreeItemText(entry: SessionEntry, toolCallsById: Map<string, ToolCallInfo>) {
  if (entry.type === "message") {
    if (entry.message?.role === "toolResult") {
      const call = entry.message.toolCallId ? toolCallsById.get(entry.message.toolCallId) : undefined;
      const toolName = entry.message.toolName || call?.name || t("Tool");
      const callSummary = formatToolInvocationSummary(toolName, call?.arguments);
      return {
        // Do not scan large tool output when invocation details already describe this row.
        detail: callSummary || sidebarContentPreview(entry.message.content) || undefined,
        text: formatToolInvocationTitle(toolName),
      };
    }
    const text = sidebarContentPreview(entry.message?.content);
    if (text) return { text: truncateTreeText(text, 140) || t("Message") };
    if (entry.message?.role === "assistant") {
      const toolCalls = extractToolCalls(entry.message.content);
      if (toolCalls.length > 0) return summarizeAssistantToolCalls(toolCalls);
      const thinking = sidebarContentPreview(entry.message.content, "thinking");
      if (thinking) return { detail: truncateTreeText(thinking, 140), text: t("Reasoning") };
      return { text: t("Assistant update") };
    }
    if (entry.message?.role === "user") return { text: t("User message") };
    return { text: t("Message") };
  }
  if (entry.type === "branch_summary") {
    return {
      text: truncateTreeText(typeof entry.summary === "string" ? entry.summary : "", 140) || t("Branch summary"),
    };
  }
  if (entry.type === "compaction") {
    return {
      text: t("Compaction"),
      detail: truncateTreeText(typeof entry.summary === "string" ? entry.summary : "", 140),
    };
  }
  if (entry.type === "model_change") {
    return { text: t("Model change"), detail: [entry.provider, entry.modelId].filter(Boolean).join("/") || undefined };
  }
  if (entry.type === "thinking_level_change")
    return { text: t("Thinking: {level}", { level: entry.thinkingLevel || t("changed") }) };
  if (entry.type === "label") return { text: typeof entry.label === "string" ? entry.label : t("Label") };
  if (entry.type === "session_info") return { text: typeof entry.name === "string" ? entry.name : t("Session info") };
  if (entry.type === "custom_message") {
    const content = entry.content;
    if (typeof content === "string") return { text: sidebarContentPreview(content) };
    return { text: t("Custom message") };
  }
  return { text: entry.type || t("Event") };
}

type ToolCallInfo = Extract<PiContentBlock, { type: "toolCall" }>;

function buildToolCallIndex(tree: SessionTreeNode[]) {
  const toolCallsById = new Map<string, ToolCallInfo>();
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.entry.message?.role === "assistant") {
      for (const call of extractToolCalls(node.entry.message.content)) {
        if (call.id) toolCallsById.set(call.id, call);
      }
    }
    stack.push(...node.children);
  }
  return toolCallsById;
}

function summarizeAssistantToolCalls(toolCalls: ToolCallInfo[]) {
  if (toolCalls.length === 1) {
    const call = toolCalls[0];
    return {
      detail: formatToolInvocationSummary(call.name, call.arguments) || undefined,
      text: formatToolInvocationTitle(call.name),
    };
  }

  const counts = new Map<string, number>();
  for (const call of toolCalls) {
    const title = formatToolInvocationTitle(call.name);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const firstDetails = toolCalls
    .slice(0, 3)
    .map((call) => formatToolInvocationSummary(call.name, call.arguments))
    .filter(Boolean)
    .join(" · ");
  const label =
    dominant && dominant[1] === toolCalls.length
      ? `${dominant[0]} ${toolCalls.length}x`
      : t("{count} tool calls", { count: toolCalls.length });
  return { detail: truncateTreeText(firstDetails, 180), text: label };
}

function truncateTreeText(value: string, max: number) {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function compareTreeNodes(a: SessionTreeNode, b: SessionTreeNode) {
  const aTimeValue = typeof a.entry.timestamp === "string" ? new Date(a.entry.timestamp).getTime() : 0;
  const bTimeValue = typeof b.entry.timestamp === "string" ? new Date(b.entry.timestamp).getTime() : 0;
  const aTime = Number.isFinite(aTimeValue) ? aTimeValue : 0;
  const bTime = Number.isFinite(bTimeValue) ? bTimeValue : 0;
  if (aTime !== bTime) return aTime - bTime;
  return (a.entry.id ?? "").localeCompare(b.entry.id ?? "");
}
