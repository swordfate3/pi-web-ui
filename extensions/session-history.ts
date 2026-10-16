import { RECOVERABLE_LIVE_EVENTS } from "./live-transport.ts";

export type HistoryRange = { from: number; to: number };
export type HistoryQuery = HistoryRange & { before?: string };
export type HistoryEntry = {
  id?: string;
  type?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
  historyPreview?: boolean;
  summary?: unknown;
  label?: unknown;
};
export type HistoryTreeNode = {
  entry: HistoryEntry & { id: string };
  parentNodeId: string | null;
  label?: string;
  labelTimestamp?: string;
};
const PAGE_BYTES = 512 * 1024;
const ENTRY_BYTES = 32 * 1024;
const TREE_NODES = 1000;
const TREE_BYTES = 1024 * 1024;
const FRAME_BYTES = 4 * 1024 * 1024;

export function utcRecentRange(now = Date.now()): HistoryRange {
  const today = new Date(now);
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return { from: midnight - 2 * 86_400_000, to: midnight + 86_400_000 };
}

export function historyRange(params: Record<string, unknown> = {}, now = Date.now()): HistoryRange {
  if (params.from === undefined && params.to === undefined) return utcRecentRange(now);
  const { from, to } = params;
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    !Number.isFinite(new Date(from).getTime()) ||
    !Number.isFinite(new Date(to).getTime()) ||
    from >= to
  ) {
    throw new Error("Invalid history date range: expected finite numeric from < to");
  }
  return { from, to };
}

const short = (value: unknown, length = 160): string | undefined =>
  typeof value === "string" ? value.slice(0, length) : undefined;

// Inspect a small bounded clone before serializing. A huge string/array/custom
// object never needs to be copied or stringified in full to discover its size.
function boundedEntry(entry: HistoryEntry): HistoryEntry {
  let budget = ENTRY_BYTES;
  const seen = new Set<object>();
  function clone(value: unknown, depth = 0): unknown {
    if (depth > 12 || budget < 0) throw new Error("preview");
    if (typeof value === "string") {
      if (value.length > budget) throw new Error("preview");
      budget -= Buffer.byteLength(JSON.stringify(value));
      if (budget < 0) throw new Error("preview");
      return value;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) {
      budget -= 16;
      return value;
    }
    if (typeof value !== "object" || seen.has(value)) throw new Error("preview");
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 256) throw new Error("preview");
        budget -= value.length + 2;
        return value.map((v) => clone(v, depth + 1));
      }
      const result: Record<string, unknown> = {};
      let count = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++count > 128 || key.length > budget) throw new Error("preview");
        budget -= Buffer.byteLength(JSON.stringify(key)) + 2;
        Object.defineProperty(result, key, {
          value: clone((value as Record<string, unknown>)[key], depth + 1),
          enumerable: true,
        });
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }
  try {
    const result = clone(entry) as HistoryEntry;
    if (Buffer.byteLength(JSON.stringify(result)) > ENTRY_BYTES) throw new Error("preview");
    return result;
  } catch {
    return { ...lightEntry(entry), historyPreview: true };
  }
}

function lightEntry(entry: HistoryEntry): HistoryEntry & { id: string } {
  // IDs are opaque capabilities: preserve them exactly, never shorten them.
  // Abnormal identity sizes reject safely instead of creating wrong targets.
  if (
    typeof entry.id !== "string" ||
    !entry.id ||
    entry.id.length > 512 ||
    (typeof entry.parentId === "string" && entry.parentId.length > 512)
  )
    throw new Error("Invalid history entry identity");
  const toolIdentity = (id: unknown): string | undefined => {
    if (id === undefined) return undefined;
    if (typeof id !== "string" || !id || id.length > 512) throw new Error("Invalid history tool identity");
    return id;
  };
  const previewNote = "[History preview: large content omitted; full data remains in the original session.]";
  let preview: unknown = "";
  const content = entry.message?.content;
  if (typeof content === "string") preview = `${content.slice(0, 160)} ${previewNote}`;
  else if (Array.isArray(content)) {
    preview = content.slice(0, 4).flatMap<Record<string, unknown>>((block) => {
      if (!block || typeof block !== "object") return [];
      if (block.type === "toolCall") {
        const args: Record<string, unknown> = { historyPreview: true, notice: previewNote };
        for (const key of ["path", "filePath", "command", "description"]) {
          const value = block.arguments?.[key];
          if (typeof value === "string") args[key] = value.slice(0, 160);
        }
        return [{ type: "toolCall", id: toolIdentity(block.id), name: short(block.name, 128), arguments: args }];
      }
      if (block.type === "thinking")
        return [{ type: "thinking", thinking: `${short(block.thinking) ?? ""} ${previewNote}` }];
      return [{ type: "text", text: `${short(block.text) ?? ""} ${previewNote}` }];
    });
  }
  const result = {
    id: entry.id,
    type: short(entry.type, 64),
    parentId: entry.parentId ?? null,
    timestamp: short(entry.timestamp, 64),
    historyPreview: true,
    ...(entry.message
      ? {
          message: {
            role: short(entry.message.role, 32),
            content: preview,
            toolCallId: toolIdentity(entry.message.toolCallId),
            toolName: short(entry.message.toolName, 128),
            isError: entry.message.isError === true,
          },
        }
      : {}),
    ...(typeof entry.summary === "string" ? { summary: short(entry.summary) } : {}),
    ...(typeof entry.label === "string" ? { label: short(entry.label) } : {}),
  };
  // Escape-heavy IDs and summaries also count toward the fixed wire budget.
  while (Buffer.byteLength(JSON.stringify(result)) > ENTRY_BYTES) {
    if (Array.isArray(preview) && preview.length) preview.pop();
    else throw new Error("History preview exceeds entry budget");
  }
  return result;
}

function treePreview(tree: unknown, range: HistoryRange) {
  if (!Array.isArray(tree)) throw new Error("Invalid session tree");
  const nodes: HistoryTreeNode[] = [];
  const seen = new Set<object>();
  const ids = new Set<string>();
  // Iterators keep traversal memory proportional to depth, not root fanout.
  const stack = [{ children: tree[Symbol.iterator](), parentNodeId: null as string | null }];
  let count = 0;
  let excluded = false;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const next = frame.children.next();
    if (next.done) {
      stack.pop();
      continue;
    }
    const node = next.value;
    if (!node || typeof node !== "object" || seen.has(node) || !node.entry || !Array.isArray(node.children)) {
      throw new Error("Invalid session tree");
    }
    seen.add(node);
    const entry = lightEntry(node.entry);
    if (ids.has(entry.id)) throw new Error("Invalid session tree: duplicate ID");
    ids.add(entry.id);
    // Rolling buffer keeps the most recent navigation nodes, without bodies.
    const time = Date.parse(entry.timestamp ?? "");
    if (time >= range.from && time < range.to) {
      nodes[count % TREE_NODES] = {
        entry,
        parentNodeId: frame.parentNodeId,
        label: short(node.label),
        labelTimestamp: short(node.labelTimestamp, 64),
      };
      count++;
    } else excluded = true;
    stack.push({ children: node.children[Symbol.iterator](), parentNodeId: entry.id });
  }
  const candidates =
    count > TREE_NODES ? [...nodes.slice(count % TREE_NODES), ...nodes.slice(0, count % TREE_NODES)] : nodes;
  const ordered: HistoryTreeNode[] = [];
  let bytes = 2;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(candidates[i])) + (ordered.length ? 1 : 0);
    if (bytes + size > TREE_BYTES) break;
    bytes += size;
    ordered.push(candidates[i]);
  }
  ordered.reverse();
  const included = new Set(ordered.map((n) => n.entry.id));
  for (const node of ordered) {
    if (node.parentNodeId && !included.has(node.parentNodeId)) node.parentNodeId = null;
  }
  return { treeNodes: ordered, treeLimited: excluded || count > ordered.length };
}

export function selectSessionHistory(branch: readonly HistoryEntry[], tree: unknown, query: HistoryQuery) {
  const range = historyRange(query);
  if (query.before !== undefined && (typeof query.before !== "string" || !query.before))
    throw new Error("Invalid history cursor");
  const matching = branch
    .filter((entry) => {
      const time = Date.parse(entry.timestamp ?? "");
      return time >= range.from && time < range.to;
    })
    .sort((a, b) => Date.parse(a.timestamp ?? "") - Date.parse(b.timestamp ?? ""));
  let end = matching.length;
  if (query.before !== undefined) {
    end = matching.findIndex((entry) => entry.id === query.before);
    if (end < 0) throw new Error("Unknown history cursor for this date range");
  }
  const entries: HistoryEntry[] = [];
  let bytes = 2;
  let truncatedEntries = 0;
  let index = end - 1;
  for (; index >= 0 && entries.length < 100; index--) {
    const entry = boundedEntry(matching[index]);
    const size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0);
    if (bytes + size > PAGE_BYTES) break;
    bytes += size;
    entries.push(entry);
    if (entry.historyPreview) truncatedEntries++;
  }
  entries.reverse();
  const { treeNodes, treeLimited } = treePreview(tree, range);
  return {
    entries,
    treeNodes,
    history: {
      ...range,
      nextBefore: index >= 0 ? (entries[0]?.id ?? null) : null,
      total: matching.length,
      returned: entries.length,
      truncatedEntries,
      treeLimited,
    },
  };
}

export function selectSavedSessions<T extends { modified: Date }>(sessions: T[], range: HistoryRange, limit: number) {
  historyRange(range);
  const matching = sessions
    .filter((s) => s.modified.getTime() >= range.from && s.modified.getTime() < range.to)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return { sessions: matching.slice(0, limit), total: matching.length, truncated: matching.length > limit };
}

export function guardHistoryFrame(
  serialized: string,
  envelope: unknown,
  scope?: { sessionId?: string; runtimeId?: string },
): string {
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= FRAME_BYTES) return serialized;
  const data = envelope as { type?: string; id?: string; event?: string } | null;
  if (
    data?.type === "event" &&
    typeof data.event === "string" &&
    RECOVERABLE_LIVE_EVENTS.has(data.event) &&
    typeof scope?.sessionId === "string" &&
    scope.sessionId.length <= 256 &&
    typeof scope.runtimeId === "string" &&
    scope.runtimeId.length <= 256
  ) {
    return JSON.stringify({
      type: "event",
      event: "transport_omitted",
      payload: { sessionId: scope.sessionId, runtimeId: scope.runtimeId, sourceEvent: data.event, bytes },
    });
  }
  const error = "Web UI message exceeds the transport size limit. Use bounded history or the original session.";
  return JSON.stringify(
    data?.type === "res" && typeof data.id === "string" && data.id.length <= 512
      ? { type: "res", id: data.id, ok: false, error }
      : { type: "error", code: "message_too_large", message: error },
  );
}
