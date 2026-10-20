import { boundedJson, jsonTextPrefix } from "../../../../extensions/bounded-json";
import type { ChatItem, HistoryMetadata, SessionEntry, WorkspaceArtifact } from "./types";
import { uiText } from "./ui-text";

const ITEM_BYTES = 64 * 1024;
const WINDOW_BYTES = 512 * 1024;
const NOTICE = "[Preview: large content omitted; full data remains in the original session.]";
const cache = new WeakMap<ChatItem, { item: ChatItem; bytes: number }>();
const prefix = (value: unknown, budget = 8192) => (typeof value === "string" ? jsonTextPrefix(value, budget) : "");

// Reserve the largest serialized view state before choosing the history boundary.
// Adding `open` on the first toggle (or changing true to false) must not evict
// source rows after boundHistoryWindow has established exact cursors/counts.
const withViewBudget = (item: ChatItem): ChatItem => (item.kind === "tool" ? { ...item, open: false } : item);

export function entryDetailTargets(item: ChatItem): string[] {
  if (!item.historyPreview) return [];
  return [...new Set([item.entryId, item.detailEntryId].filter((id): id is string => Boolean(id)))];
}

function boundedItem(source: ChatItem) {
  const cached = cache.get(source);
  if (cached) return cached;
  const complete = boundedJson(withViewBudget(source), ITEM_BYTES);
  let item: ChatItem;
  if (complete) item = source;
  else {
    // Retain exact identities, not source objects hidden inside preview metadata.
    const base = {
      id: source.id,
      entryId: source.entryId,
      detailEntryId: source.detailEntryId,
      relatedEntryIds: source.relatedEntryIds?.slice(-4),
      historyPreview: true,
    };
    if (source.kind === "message")
      item = {
        ...base,
        kind: "message",
        role: source.role,
        text: prefix(source.text),
        reasoning: prefix(source.reasoning),
        streaming: source.streaming,
        copyable: false,
        presentation: source.presentation,
        cost: source.cost,
      };
    else if (source.kind === "tool")
      item = {
        ...base,
        kind: "tool",
        name: prefix(source.name, 512),
        input: boundedJson(source.input, 8192)?.value ?? { historyPreview: true, notice: NOTICE },
        output: prefix(source.output),
        errorText: prefix(source.errorText),
        state: source.state,
        open: source.open,
        resultOnly: source.resultOnly,
      };
    else item = { ...base, kind: "system", text: `${prefix(source.text)} ${NOTICE}`, tone: source.tone };
  }
  const checked = complete ?? boundedJson(withViewBudget(item), ITEM_BYTES);
  // Pathological identities are never shortened into different action targets.
  if (!checked) return null;
  const result = { item, bytes: checked.bytes };
  cache.set(source, result);
  cache.set(item, result);
  return result;
}

export function boundConversationWindow(items: readonly ChatItem[]) {
  const retained: ChatItem[] = [];
  let bytes = 2;
  let limited = false;
  for (let i = items.length - 1; i >= 0; i--) {
    if (retained.length >= 200) {
      limited = true;
      break;
    }
    const bounded = boundedItem(items[i]);
    if (!bounded) {
      limited = true;
      continue;
    }
    const size = bounded.bytes + (retained.length ? 1 : 0);
    if (bytes + size > WINDOW_BYTES) {
      limited = true;
      break;
    }
    bytes += size;
    retained.push(bounded.item);
    limited ||= bounded.item !== items[i];
  }
  return { items: retained.reverse(), limited };
}

/** Browser rows can outnumber persisted entries. Page from the retained boundary,
 * not the server page boundary, and expose any partially retained entry as detail.
 * Only identities/counts are collected; no entries or source bodies are cached. */
export function boundHistoryWindow(
  items: readonly ChatItem[],
  entries: readonly SessionEntry[],
  history: HistoryMetadata | undefined,
) {
  let window = boundConversationWindow(items);
  const counts = (rows: readonly ChatItem[]) => {
    const result = new Map<string, number>();
    for (const row of rows) if (row.entryId) result.set(row.entryId, (result.get(row.entryId) ?? 0) + 1);
    return result;
  };
  const originalCounts = counts(items);
  const identities = (rows: readonly ChatItem[]) => {
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.entryId) ids.add(row.entryId);
      if (row.detailEntryId) ids.add(row.detailEntryId);
      for (const id of row.relatedEntryIds ?? []) ids.add(id);
    }
    return ids;
  };
  const originalIds = identities(items);
  const rowIds = new Set<string>();
  for (const item of items) rowIds.add(item.id);
  let previewCounter = 0;
  while (window.limited) {
    const retainedCounts = counts(window.items);
    const marked = new Set<string>();
    const rows: ChatItem[] = window.items.map((row) => {
      const id = row.entryId;
      if (!id || marked.has(id) || retainedCounts.get(id) === originalCounts.get(id)) return row;
      marked.add(id);
      if (row.historyPreview) return row;
      return { ...row, historyPreview: true, ...(row.kind === "message" ? { copyable: false } : {}) };
    });
    const retainedIds = identities(rows);
    const first = entries.findIndex((entry) => entry.id && retainedIds.has(entry.id));
    // A tool result may be newer than its invocation but live on an evicted
    // tool row. It cannot be reached by paging before the retained invocation.
    // Give each omitted entry its own small, action-safe detail preview. Never
    // put an entire page's opaque IDs on one row: that list can exceed 64 KiB.
    const omitted = entries.flatMap((entry, index) =>
      index >= first && entry.id && originalIds.has(entry.id) && !retainedIds.has(entry.id) ? [entry.id] : [],
    );
    for (const entryId of omitted) {
      let id: string;
      do {
        id = `history-preview-${previewCounter++}`;
      } while (rowIds.has(id));
      rowIds.add(id);
      const preview = boundedItem({
        kind: "system",
        id,
        entryId,
        historyPreview: true,
        text: uiText("History preview. Full data remains in the original session."),
      });
      // Invalid legacy identities must not create a retry loop either. Valid
      // page IDs fit individually; an unrepresentable ID is never shortened.
      if (preview) rows.push(preview.item);
    }
    // Previews are at the retained tail, so older source rows make room for
    // them. At most 40 entry IDs from a <=192-KiB page fit comfortably in their
    // own rows. Recheck the boundary after count/byte eviction or projection.
    const next = boundConversationWindow(rows);
    const nextIds = identities(next.items);
    const stable = next.items.length === rows.length && [...identities(rows)].every((id) => nextIds.has(id));
    window = { ...next, limited: true };
    if (stable) break;
  }
  if (!history) return { ...window, history };

  const retained = identities(window.items);
  const previews = new Set<string>();
  for (const row of window.items) {
    for (const id of entryDetailTargets(row)) previews.add(id);
  }
  const first = entries.findIndex((entry) => entry.id && retained.has(entry.id));
  const lostOlderEntry = entries.some(
    (entry, index) => index < first && entry.id && originalIds.has(entry.id) && !retained.has(entry.id),
  );
  return {
    ...window,
    history: {
      ...history,
      // Preserve the original cursor unless browser eviction created a gap.
      nextBefore: lostOlderEntry ? (entries[first]?.id ?? history.nextBefore) : history.nextBefore,
      returned: window.limited
        ? entries.filter((entry) => entry.id && retained.has(entry.id)).length
        : history.returned,
      truncatedEntries: entries.filter(
        (entry) =>
          (!window.limited || (entry.id && retained.has(entry.id))) &&
          (entry.historyPreview || (entry.id && previews.has(entry.id))),
      ).length,
    },
  };
}

/** Format only a bounded tool projection; never stringify the full result first. */
export function boundedToolOutput(source: unknown): { output: string; preview: boolean } {
  const bounded = boundedJson(source, 24 * 1024);
  if (!bounded) {
    const record = source && typeof source === "object" ? (source as { content?: unknown }) : null;
    const content = record?.content ?? source;
    const first = Array.isArray(content) ? content[0] : null;
    return { output: `${prefix(typeof content === "string" ? content : first?.text)} ${NOTICE}`, preview: true };
  }
  const render = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (!value) return "";
    if (Array.isArray(value))
      return value
        .map((block) => (block?.type === "text" ? block.text || "" : JSON.stringify(block, null, 2)))
        .join("\n");
    if (typeof value === "object" && "content" in value && Array.isArray(value.content)) return render(value.content);
    return JSON.stringify(value, null, 2);
  };
  const output = render(bounded.value);
  const text = jsonTextPrefix(output, 32 * 1024);
  return { output: text, preview: text.length !== output.length };
}

// Artifact side cache is derived from retained tool rows, not lifetime traffic.
export function retainWindowArtifacts(artifacts: WorkspaceArtifact[], items: readonly ChatItem[]) {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool" || !item.input || typeof item.input !== "object" || item.historyPreview) continue;
    const input = item.input as Record<string, unknown>;
    for (const key of ["path", "filePath", "filepath", "file_path", "file", "target", "filename"]) {
      const value = input[key];
      if (typeof value === "string" && value.length <= 4096)
        paths.add(
          value
            .trim()
            .replace(/^file:\/\//, "")
            .replace(/\\/g, "/")
            .replace(/\/+/g, "/")
            .replace(/^\.\//, ""),
        );
    }
  }
  const retained: WorkspaceArtifact[] = [];
  let bytes = 2;
  for (const artifact of artifacts) {
    if (!paths.has(artifact.path)) continue;
    const safe = boundedJson(artifact, 8192);
    if (!safe || bytes + safe.bytes + 1 > 32 * 1024 || retained.length >= 200) continue;
    retained.push(safe.value);
    bytes += safe.bytes + 1;
  }
  return retained;
}
