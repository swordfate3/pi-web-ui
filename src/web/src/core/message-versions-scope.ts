import type { ChatItem, HistoryRange } from "./types";

type Source = {
  sessionId: string;
  runtimeId: string;
  sourceLeafId: string | null;
  from: number;
  to: number;
  before: string | null;
  entryIds: readonly string[];
};
type Current = {
  connection: string;
  sessionId: string | null;
  runtimeId: string | null;
  leafId: string | null;
  chatStatus: string;
  sessionActionPending: boolean;
  historyLoading: boolean;
  conversationSyncing: boolean;
  historyRange: HistoryRange;
  historyBefore: string | null;
  items: ChatItem[];
};

/** A branch switch cannot reuse an entry cursor from the abandoned path. */
export async function loadMessageVersionHistory(
  source: { from: number; to: number; before: string | null },
  current: {
    historyRange: HistoryRange;
    historyBefore: string | null;
    loadHistory: (range: HistoryRange, before?: string) => Promise<void>;
  },
  ownsNavigation: () => boolean,
): Promise<void> {
  if (
    !ownsNavigation() ||
    current.historyRange.from !== source.from ||
    current.historyRange.to !== source.to ||
    current.historyBefore !== source.before
  )
    return;
  await current.loadHistory({ from: source.from, to: source.to });
}

/** Read completion is only meaningful for the exact displayed saved-message scope. */
export function messageVersionsReadIsCurrent(source: Source, current: Current): boolean {
  if (
    current.connection !== "connected" ||
    current.sessionId !== source.sessionId ||
    current.runtimeId !== source.runtimeId ||
    current.leafId !== source.sourceLeafId ||
    current.chatStatus !== "ready" ||
    current.sessionActionPending ||
    current.historyLoading ||
    current.conversationSyncing ||
    current.historyRange.from !== source.from ||
    current.historyRange.to !== source.to ||
    current.historyBefore !== source.before
  )
    return false;
  const ids = [
    ...new Set(current.items.flatMap((item) => (item.kind === "message" && item.entryId ? [item.entryId] : []))),
  ].slice(-100);
  return ids.length === source.entryIds.length && ids.every((id, index) => id === source.entryIds[index]);
}
