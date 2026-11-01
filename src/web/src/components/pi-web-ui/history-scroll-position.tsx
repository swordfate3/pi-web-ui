import { useLayoutEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { usePiWebUiStore } from "../../core/store";

/** Scroll offsets are small view metadata, never retained history bodies. */
export function HistoryScrollPosition() {
  const sessionId = usePiWebUiStore((state) => state.sessionId);
  const range = usePiWebUiStore((state) => state.historyRange);
  const before = usePiWebUiStore((state) => state.historyBefore);
  const anchor = usePiWebUiStore((state) => state.historyAnchor);
  const loading = usePiWebUiStore((state) => state.historyLoading);
  const { scrollRef, stopScroll, scrollToBottom } = useStickToBottomContext();
  const saved = useRef({ sessionId, offsets: new Map<string, number>() });
  // The first page has the same reading identity before and after anchoring.
  // Never key live rows by the moving head: that would force a bottom scroll
  // whenever a reply is persisted while the reader is scrolled upward.
  const key = JSON.stringify([sessionId, range.from, range.to, before]);
  const historical = Boolean(before || anchor || Date.now() < range.from || Date.now() >= range.to);
  const active = useRef<{ key: string; historical: boolean } | null>(null);
  useLayoutEffect(() => {
    if (loading) return;
    const element = scrollRef.current;
    if (!element) return;
    if (saved.current.sessionId !== sessionId) saved.current = { sessionId, offsets: new Map() };
    if (active.current?.key !== key || (active.current.historical && !historical)) {
      active.current = { key, historical };
      if (historical) {
        stopScroll();
        element.scrollTop = saved.current.offsets.get(key) ?? 0;
      } else void scrollToBottom({ animation: "instant" });
    }
    const record = () => saved.current.offsets.set(key, element.scrollTop);
    element.addEventListener("scroll", record, { passive: true });
    return () => {
      element.removeEventListener("scroll", record);
    };
  }, [sessionId, key, loading, historical, scrollRef, stopScroll, scrollToBottom]);
  return null;
}
