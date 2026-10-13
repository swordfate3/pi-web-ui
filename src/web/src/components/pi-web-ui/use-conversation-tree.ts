import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../core/i18n";
import type { SessionTreeNode } from "../../core/types";
import { indexConversationTree, projectConversationTree, searchConversationTree } from "./conversation-tree-model";

/** Lives outside mobile Sheet: one current tree/query/projection, no previous-session cache. */
export function useConversationTree(tree: SessionTreeNode[], leafId: string | null, searchQuery: string) {
  const language = useLanguage();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const scrollTop = useRef(0);
  const positioned = useRef(false);
  const lastPositionedEntry = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: language invalidates translated summaries
  const index = useMemo(() => indexConversationTree(tree, leafId), [tree, leafId, language]);
  const search = useMemo(() => searchConversationTree(index, searchQuery), [index, searchQuery]);
  const projection = useMemo(() => projectConversationTree(index, search, collapsedIds), [index, search, collapsedIds]);
  const matchIndices = useMemo(
    () => projection.items.flatMap((item, i) => (item.isSearchMatch ? [i] : [])),
    [projection.items],
  );
  const indexById = useMemo(() => new Map(projection.items.map((item, i) => [item.id, i])), [projection.items]);

  // Bound retained UI state to IDs in the current snapshot, even after session replacement.
  useEffect(() => {
    setCollapsedIds((current) => {
      const next = new Set([...current].filter((id) => index.visibleById.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [index]);

  const toggleExpanded = useCallback((id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const revealCurrent = useCallback(() => {
    // Clear only collapsed segments on the current path; searching still controls visibility.
    const ancestors = new Set<string>();
    let id = index.effectiveLeafId;
    while (id) {
      ancestors.add(id);
      id = index.visibleParentById.get(id) ?? null;
    }
    setCollapsedIds((current) => {
      const next = new Set([...current].filter((id) => !ancestors.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [index]);

  return {
    collapsedIds,
    ...projection,
    indexById,
    matchIndices,
    scrollTop,
    positioned,
    lastPositionedEntry,
    toggleExpanded,
    revealCurrent,
  };
}

export type ConversationTreeState = ReturnType<typeof useConversationTree>;
