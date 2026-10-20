import { boundedJson } from "./bounded-json.ts";
import type { HistoryEntry, HistoryTreeNode } from "./session-history.ts";

const LIMIT = 256 * 1024;
type Page = {
  entries: HistoryEntry[];
  treeNodes: HistoryTreeNode[];
  history: { nextBefore: string | null; returned: number; truncatedEntries: number; treeLimited: boolean };
};

/** null means a non-history envelope: its existing transport contract is unchanged. */
export function serializeHistoryEnvelope(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const envelope = data as Record<string, unknown>;
  const field = envelope.type === "event" && envelope.event === "state_sync" ? "payload" : "result";
  const source = envelope[field] as Page | undefined;
  if (!source || !Array.isArray(source.entries) || !Array.isArray(source.treeNodes) || !source.history) return null;
  const error = () =>
    JSON.stringify(
      envelope.type === "res" && typeof envelope.id === "string" && envelope.id.length <= 512
        ? { type: "res", id: envelope.id, ok: false, error: "History metadata exceeds the transport budget limit." }
        : { type: "error", code: "history_too_large", message: "History metadata exceeds the transport budget limit." },
    );
  // Budget the entire non-content envelope BEFORE serialization, including the
  // model, context/status, exact opaque identities and request ID. No toJSON calls.
  const shell = boundedJson({ ...envelope, [field]: { ...source, entries: [], treeNodes: [] } }, LIMIT);
  if (!shell) return error();
  const entries = source.entries.slice();
  let nodes = source.treeNodes.slice();
  let reduced = false;
  for (;;) {
    const payload = {
      ...(shell.value[field] as Page),
      entries,
      treeNodes: nodes,
      history: {
        ...source.history,
        returned: entries.length,
        truncatedEntries: entries.filter((entry) => entry.historyPreview).length,
        nextBefore: reduced ? (entries[0]?.id ?? null) : source.history.nextBefore,
        treeLimited: source.history.treeLimited || nodes.length !== source.treeNodes.length,
      },
    };
    const candidate = boundedJson({ ...shell.value, [field]: payload }, LIMIT);
    if (candidate) {
      const raw = JSON.stringify(candidate.value);
      if (Buffer.byteLength(raw) <= LIMIT) return raw;
      return error();
    }
    // Navigation is optional; discard it before discarding oldest history.
    if (nodes.length) {
      nodes = [];
      continue;
    }
    if (entries.length <= 1) return error();
    entries.shift();
    reduced = true;
  }
}
