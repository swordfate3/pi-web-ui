import type { SessionEntry, SessionTreeNode } from "./types";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid session tree: ${message}`);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalStrings(value: RecordValue, keys: string[]) {
  for (const key of keys) {
    if (value[key] !== undefined && typeof value[key] !== "string") fail(`${key} must be a string`);
  }
}

/** Validate fields consumed by the tree renderer; leave extension-specific entry data opaque. */
function readEntry(value: unknown): SessionEntry & { id: string } {
  if (!isRecord(value) || !isId(value.id) || !isId(value.type)) fail("entry requires an id and type");
  if (value.parentId !== undefined && value.parentId !== null && !isId(value.parentId)) {
    fail(`invalid entry.parentId for ${value.id}`);
  }
  optionalStrings(value, ["timestamp", "label", "summary", "modelId", "provider", "thinkingLevel"]);
  if (value.message !== undefined) {
    const message = value.message;
    if (!isRecord(message) || typeof message.role !== "string") fail(`invalid message for ${value.id}`);
    optionalStrings(message, ["id", "toolCallId", "toolName", "customType", "errorMessage", "stopReason"]);
    const content = message.content;
    if (content !== undefined && typeof content !== "string") {
      if (!Array.isArray(content)) fail(`invalid message content for ${value.id}`);
      for (const block of content) {
        if (!isRecord(block) || typeof block.type !== "string") fail(`invalid content block for ${value.id}`);
        optionalStrings(block, ["text", "thinking", "id", "name"]);
      }
    }
  }
  return value as SessionEntry & { id: string };
}

function readNode(value: unknown): SessionTreeNode & { entry: SessionEntry & { id: string } } {
  if (!isRecord(value)) fail("node must be an object");
  const entry = readEntry(value.entry);
  optionalStrings(value, ["label", "labelTimestamp"]);
  return {
    entry,
    children: [],
    ...(value.label !== undefined && { label: value.label as string }),
    ...(value.labelTimestamp !== undefined && { labelTimestamp: value.labelTimestamp as string }),
  };
}

/** Linear-time, non-recursive cycle check, including components disconnected from any root. */
function checkParents(parents: Map<string, string | null>, requireParent: boolean) {
  const done = new Set<string>();
  for (const start of parents.keys()) {
    const path = new Set<string>();
    let id: string | null = start;
    while (id !== null && !done.has(id)) {
      if (path.has(id)) fail(`cycle at ${id}`);
      if (!parents.has(id)) {
        if (requireParent) fail(`missing parent ${id}`);
        break;
      }
      path.add(id);
      id = parents.get(id) ?? null;
    }
    for (const visited of path) done.add(visited);
  }
}

/**
 * Decode an untrusted snapshot atomically. Flat nodes take precedence (even when invalid).
 * Both formats retain input root/sibling order, entries and labels, without recursion or
 * pruning. entry.parentId is session history, NOT the structural parent in the wire tree.
 */
export function decodeSessionTree(snapshot: { treeNodes?: unknown; tree?: unknown }): SessionTreeNode[] {
  const flat = Object.hasOwn(snapshot, "treeNodes");
  const source = flat ? snapshot.treeNodes : Object.hasOwn(snapshot, "tree") ? snapshot.tree : [];
  if (!Array.isArray(source)) fail(`${flat ? "treeNodes" : "tree"} must be an array`);

  const nodes = new Map<string, SessionTreeNode>();
  const parents = new Map<string, string | null>();
  const entryParents = new Map<string, string | null>();
  const addNode = (value: unknown, parentId: string | null) => {
    const node = readNode(value);
    const id = node.entry.id;
    if (nodes.has(id)) fail(`duplicate id ${id} (or legacy cycle)`);
    nodes.set(id, node);
    parents.set(id, parentId);
    entryParents.set(id, node.entry.parentId ?? null);
    return id;
  };

  if (flat) {
    for (const value of source) {
      if (!isRecord(value) || (value.parentNodeId !== null && !isId(value.parentNodeId))) {
        fail("parentNodeId must be an id or null");
      }
      addNode(value, value.parentNodeId as string | null);
    }
  } else {
    // A frame per level avoids both call-stack overflow and push(...hugeChildren).
    const stack = [{ values: source, index: 0, parentId: null as string | null }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index === frame.values.length) {
        stack.pop();
        continue;
      }
      const value: unknown = frame.values[frame.index++];
      if (!isRecord(value) || !Array.isArray(value.children)) fail("children must be an array");
      const id = addNode(value, frame.parentId);
      stack.push({ values: value.children, index: 0, parentId: id });
    }
  }

  checkParents(parents, true);
  // Existing tree consumers also walk entry.parentId. It may differ from the
  // structural parent or point outside this tree, but must never cause a loop.
  checkParents(entryParents, false);
  const roots: SessionTreeNode[] = [];
  for (const [id, node] of nodes) {
    const parentId = parents.get(id) ?? null;
    if (parentId === null) roots.push(node);
    else nodes.get(parentId)?.children.push(node);
  }
  return roots;
}

export type SessionTreeDecodeResult =
  | { ok: true; tree: SessionTreeNode[]; error: null }
  | { ok: false; tree: SessionTreeNode[]; error: string };

/** A bad snapshot must never replace the last validated tree with partial/raw data. */
export function decodeSessionTreeOrKeep(
  snapshot: { treeNodes?: unknown; tree?: unknown },
  previousTree: SessionTreeNode[],
): SessionTreeDecodeResult {
  try {
    return { ok: true, tree: decodeSessionTree(snapshot), error: null };
  } catch (error) {
    return {
      ok: false,
      tree: previousTree,
      error: error instanceof Error ? error.message : "Invalid session tree",
    };
  }
}
