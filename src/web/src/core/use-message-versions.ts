import { useEffect, useMemo, useState } from "react";
import { type MessageVersionGroup, parseMessageVersions } from "./message-versions";
import { messageVersionsReadIsCurrent } from "./message-versions-scope";
import { usePiWebUiStore } from "./store";
import type { ChatItem } from "./types";

const emptyVersions: ReadonlyMap<string, MessageVersionGroup> = new Map();

/** Read-only metadata, never inferred from truncated tree bodies. Late reads cannot cross scopes/pages. */
export function useMessageVersions(items: ChatItem[], refreshKey: number) {
  const connection = usePiWebUiStore((s) => s.connection);
  const sessionId = usePiWebUiStore((s) => s.sessionId);
  const runtimeId = usePiWebUiStore((s) => s.runtimeId);
  const sourceLeafId = usePiWebUiStore((s) => s.leafId);
  const chatStatus = usePiWebUiStore((s) => s.chatStatus);
  const pending = usePiWebUiStore((s) => s.sessionActionPending);
  const syncing = usePiWebUiStore((s) => s.conversationSyncing);
  const historyLoading = usePiWebUiStore((s) => s.historyLoading);
  const from = usePiWebUiStore((s) => s.historyRange.from);
  const to = usePiWebUiStore((s) => s.historyRange.to);
  const before = usePiWebUiStore((s) => s.historyBefore);
  const entryIdsKey = JSON.stringify(
    [...new Set(items.flatMap((item) => (item.kind === "message" && item.entryId ? [item.entryId] : [])))].slice(-100),
  );
  const enabled = connection === "connected" && chatStatus === "ready" && !pending && !syncing && !historyLoading;
  // Retain read-only counters during an idle/sync transition in the same saved
  // scope. Controls are disabled by App; new identity/leaf/page always hides them.
  const scopeKey = JSON.stringify([sessionId, runtimeId, sourceLeafId, entryIdsKey, from, to, before]);
  const key = JSON.stringify([scopeKey, refreshKey]);
  const [result, setResult] = useState<{
    key: string;
    scopeKey: string;
    versions: ReadonlyMap<string, MessageVersionGroup>;
    unavailable: boolean;
    limited: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId || !runtimeId) return;
    const entryIds: string[] = JSON.parse(entryIdsKey);
    if (!entryIds.length) return;
    let active = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(async () => {
      const source = usePiWebUiStore.getState();
      const isCurrent = () => {
        const s = usePiWebUiStore.getState();
        return (
          active && messageVersionsReadIsCurrent({ sessionId, runtimeId, sourceLeafId, from, to, before, entryIds }, s)
        );
      };
      if (!isCurrent()) return;
      try {
        const expected = { sessionId, runtimeId, sourceLeafId };
        const value = await Promise.race([
          source.send("get_message_versions", { ...expected, entryIds }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("Version metadata unavailable")), 5000);
          }),
        ]);
        const parsed = parseMessageVersions(value, expected, entryIds);
        if (!isCurrent()) return;
        const versions = new Map<string, MessageVersionGroup>();
        for (const group of parsed.groups) for (const id of group.entryIds) versions.set(id, group);
        setResult({ key, scopeKey, versions, unavailable: false, limited: parsed.limited });
      } catch {
        if (isCurrent()) setResult({ key, scopeKey, versions: emptyVersions, unavailable: true, limited: false });
      } finally {
        clearTimeout(deadline);
      }
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(deadline);
    };
  }, [enabled, sessionId, runtimeId, sourceLeafId, entryIdsKey, from, to, before, key, scopeKey]);

  return useMemo(
    () => (result?.scopeKey === scopeKey ? result : { versions: emptyVersions, unavailable: false, limited: false }),
    [result, scopeKey],
  );
}
