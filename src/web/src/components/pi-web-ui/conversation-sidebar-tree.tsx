import {
  ArrowDownIcon,
  ArrowRightToLineIcon,
  ChevronRightIcon,
  GitBranchPlusIcon,
  LocateFixedIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { highlightSegments } from "../../core/format";
import { t, useLanguage } from "../../core/i18n";
import type { ConversationTreeItem, SessionTreeNode } from "../../core/types";
import {
  SIDEBAR_TREE_ROW_HEIGHT,
  sidebarScrollOffset,
  sidebarVirtualIndices,
  sidebarVirtualRange,
} from "./sidebar-virtual-rows";
import type { ConversationTreeState } from "./use-conversation-tree";

const TREE_GUTTER_WIDTH = 16;

export function ConversationSidebarTree({
  branchEnabled,
  treeState,
  query,
  onQueryChange,
  tree,
  selectedEntryId,
  loadingEntryId,
  syncing,
  syncError,
  onBranch,
  onContinue,
  onRefresh,
  onSelect,
}: {
  branchEnabled: boolean;
  treeState: ConversationTreeState;
  query: string;
  onQueryChange: (query: string) => void;
  tree: SessionTreeNode[];
  leafId: string | null;
  selectedEntryId: string | null;
  loadingEntryId: string | null;
  syncing: boolean;
  syncError: string | null;
  onBranch: (entryId: string) => void;
  onContinue: (entryId: string) => void;
  onRefresh: () => void;
  onSelect: (entryId: string) => void;
}) {
  const language = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim();
  const {
    currentEntryId,
    currentOrder,
    items,
    indexById,
    toggleExpanded,
    matchIndices,
    scrollTop,
    positioned,
    lastPositionedEntry,
    revealCurrent,
  } = treeState;
  const [viewport, setViewport] = useState({ top: scrollTop.current, height: 400 });
  const [focusedEntryId, setFocusedEntryId] = useState<string | null>(null);
  const [tabEntryId, setTabEntryId] = useState<string | null>(null);
  const [pendingCurrent, setPendingCurrent] = useState(false);
  const matchCursor = useRef<{ query: string; index: number } | null>(null);
  const range = sidebarVirtualRange(items.length, viewport.top, viewport.height);
  const focusedIndex = focusedEntryId ? (indexById.get(focusedEntryId) ?? -1) : -1;
  const mountedIndices = sidebarVirtualIndices(items.length, range, focusedIndex);
  const tabIndex =
    focusedIndex >= 0 ? focusedIndex : tabEntryId ? (indexById.get(tabEntryId) ?? range.start) : range.start;
  const tabOrder = Math.max(range.start, Math.min(range.end - 1, tabIndex));

  useLayoutEffect(() => {
    if (!focusedEntryId) return;
    const active = document.activeElement;
    const row = active instanceof HTMLElement ? active.closest<HTMLElement>("[data-tree-entry-id]") : null;
    // Removing a row during filtering/folding need not dispatch blur. Do not
    // accidentally pin that historical ID when a later projection restores it.
    if (
      !indexById.has(focusedEntryId) ||
      !row ||
      !containerRef.current?.contains(row) ||
      row.dataset.treeEntryId !== focusedEntryId
    ) {
      setFocusedEntryId(null);
    }
  }, [focusedEntryId, indexById]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const container = containerRef.current;
      if (!container || index < 0 || index >= items.length) return;
      const top = sidebarScrollOffset(index, items.length, container.clientHeight);
      // Immediate positioning avoids animating across thousands of virtual row mounts.
      container.scrollTop = top;
      scrollTop.current = top;
      setViewport({ top, height: container.clientHeight });
    },
    [items.length, scrollTop],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!positioned.current && !normalizedQuery && currentOrder >= 0) {
      scrollTop.current = sidebarScrollOffset(currentOrder, items.length, container.clientHeight);
      positioned.current = true;
    }
    container.scrollTop = scrollTop.current;
    const measure = () => {
      scrollTop.current = container.scrollTop;
      setViewport({ top: container.scrollTop, height: container.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollTop, positioned, currentOrder, normalizedQuery, items.length]);

  useEffect(() => {
    if (lastPositionedEntry.current === currentEntryId) return;
    lastPositionedEntry.current = currentEntryId;
    scrollToIndex(currentOrder);
  }, [currentEntryId, currentOrder, scrollToIndex, lastPositionedEntry]);

  useEffect(() => {
    if (!pendingCurrent || normalizedQuery || currentOrder < 0) return;
    scrollToIndex(currentOrder);
    setPendingCurrent(false);
  }, [pendingCurrent, normalizedQuery, currentOrder, scrollToIndex]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-entry-id]");
    if (!row || event.target !== row) return; // Nested action buttons keep native keyboard behavior.
    const index = indexById.get(row.dataset.treeEntryId ?? "");
    if (index === undefined) return;
    const next =
      event.key === "ArrowDown"
        ? index + 1
        : event.key === "ArrowUp"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(items.length - 1, next));
    const targetId = items[target]?.id;
    if (!targetId) return;
    setTabEntryId(targetId);
    scrollToIndex(target);
    requestAnimationFrame(() => {
      // Resolve again: a snapshot/projection may have reordered entries in the meantime.
      const targetRow = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>("[data-tree-entry-id]") ?? [],
      ).find((element) => element.dataset.treeEntryId === targetId);
      targetRow?.focus({ preventScroll: true });
    });
  };

  const refreshTitle = syncError
    ? t("Refresh conversation failed: {error}", { error: syncError })
    : t("Refresh conversation");

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <div className="flex items-center gap-1 px-2">
        <SidebarGroupLabel className="min-w-0 flex-1 px-0">{t("Conversation")}</SidebarGroupLabel>
        <Button
          aria-label={refreshTitle}
          disabled={syncing}
          onClick={onRefresh}
          size="icon-xs"
          title={refreshTitle}
          type="button"
          variant="ghost"
        >
          <RefreshCwIcon className={cn("size-3.5", syncing && "animate-spin", syncError && "text-destructive")} />
        </Button>
        <Button
          disabled={!currentEntryId}
          aria-label={t("Scroll to current")}
          data-tree-scroll-current="true"
          onClick={() => {
            onQueryChange("");
            revealCurrent();
            setPendingCurrent(true);
          }}
          size="icon-xs"
          title={t("Scroll to current")}
          type="button"
          variant="ghost"
        >
          <LocateFixedIcon className="size-3.5" />
        </Button>
      </div>
      {tree.length === 0 ? (
        <SidebarGroupContent className="p-2 text-muted-foreground text-sm">
          {t("Start a conversation")}
        </SidebarGroupContent>
      ) : (
        <>
          <p className="px-3 pb-2 text-muted-foreground text-[11px]">
            {t("Use the branch-end arrow to switch versions. Files stay unchanged.")}
          </p>
          <div className="relative px-2 pb-2">
            <SearchIcon className="absolute left-4 top-2 size-3.5 text-muted-foreground" />
            <SidebarInput
              aria-label={t("Search conversation...")}
              data-tree-search="true"
              className="h-8 pl-7 text-xs"
              onChange={(event) => {
                scrollTop.current = 0;
                if (containerRef.current) containerRef.current.scrollTop = 0;
                setViewport((current) => ({ ...current, top: 0 }));
                onQueryChange(event.target.value);
              }}
              placeholder={t("Search conversation...")}
              value={query}
            />
          </div>
          {normalizedQuery && (
            <div className="flex items-center justify-end px-2 pb-1">
              <Button
                data-tree-scroll-match="next"
                aria-label={language === "zh-CN" ? "滚动到下一个匹配节点" : "Scroll to next matching node"}
                title={language === "zh-CN" ? "滚动到下一个匹配节点" : "Scroll to next matching node"}
                size="icon-xs"
                variant="ghost"
                type="button"
                disabled={matchIndices.length === 0}
                onClick={() => {
                  const cursor = matchCursor.current?.query === normalizedQuery ? matchCursor.current.index : -1;
                  const next = matchIndices.find((index) => index > cursor) ?? matchIndices[0] ?? -1;
                  matchCursor.current = { query: normalizedQuery, index: next };
                  scrollToIndex(next);
                }}
              >
                <ArrowDownIcon className="size-3.5" />
              </Button>
            </div>
          )}
          <SidebarGroupContent
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 [overflow-anchor:none]"
            ref={containerRef}
            data-tree-viewport="true"
            onKeyDown={moveFocus}
            onFocusCapture={(event) => {
              // Includes native Branch/Continue/collapse buttons, without stealing their focus.
              const row = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-entry-id]");
              const id = row?.dataset.treeEntryId ?? null;
              setFocusedEntryId(id);
              if (id) setTabEntryId(id);
            }}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedEntryId(null);
            }}
            onScroll={(event) => {
              scrollTop.current = event.currentTarget.scrollTop;
              setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight });
            }}
          >
            {items.length === 0 ? (
              <div className="p-2 text-muted-foreground text-sm">{t("No matching nodes")}</div>
            ) : (
              <SidebarMenu
                className="relative block gap-0"
                aria-label={t("Conversation")}
                style={{ height: items.length * SIDEBAR_TREE_ROW_HEIGHT }}
              >
                {mountedIndices.map((index) => (
                  <ConversationTreeRow
                    branchEnabled={branchEnabled}
                    currentOrder={currentOrder}
                    item={items[index]}
                    key={items[index].id}
                    loadingEntryId={loadingEntryId}
                    onBranch={onBranch}
                    onContinue={onContinue}
                    onSelect={onSelect}
                    onToggleExpand={toggleExpanded}
                    query={normalizedQuery}
                    selectedEntryId={selectedEntryId}
                    tabIndex={index === (focusedIndex >= 0 ? focusedIndex : tabOrder) ? 0 : -1}
                    totalCount={items.length}
                  />
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </>
      )}
    </SidebarGroup>
  );
}

function ConversationTreeRow({
  branchEnabled,
  item,
  currentOrder,
  loadingEntryId,
  query,
  selectedEntryId,
  onBranch,
  onContinue,
  onSelect,
  onToggleExpand,
  tabIndex,
  totalCount,
}: {
  branchEnabled: boolean;
  item: ConversationTreeItem;
  tabIndex: number;
  totalCount: number;
  currentOrder: number;
  loadingEntryId: string | null;
  query: string;
  selectedEntryId: string | null;
  onBranch: (entryId: string) => void;
  onContinue: (entryId: string) => void;
  onSelect: (entryId: string) => void;
  onToggleExpand: (entryId: string) => void;
}) {
  useLanguage();
  const segments = query ? highlightSegments(item.text, query) : [{ text: item.text, match: false, offset: 0 }];
  const detailSegments =
    query && item.detail
      ? highlightSegments(item.detail, query)
      : [{ text: item.detail || "", match: false, offset: 0 }];
  const inactive = !query && currentOrder >= 0 && item.order > currentOrder;
  const selected = selectedEntryId === item.id;
  const active = item.isLeaf || selected;
  const loading = loadingEntryId === item.id;
  const branchTitle = branchEnabled ? t("Branch from here") : t("Run /webui in terminal to enable branching");
  const continueTitle = branchEnabled
    ? t("Switch to this branch / version")
    : t("Run /webui in terminal to enable branching");
  const title = item.detail ? `${item.text} - ${item.detail}` : item.text;

  const selectFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    if (
      ((event.key === "ArrowRight" && !item.isExpanded) || (event.key === "ArrowLeft" && item.isExpanded)) &&
      item.isExpandable
    ) {
      event.preventDefault();
      onToggleExpand(item.id);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(item.id);
  };

  return (
    <SidebarMenuItem
      className="absolute inset-x-0"
      style={{ top: item.order * SIDEBAR_TREE_ROW_HEIGHT, height: SIDEBAR_TREE_ROW_HEIGHT }}
      aria-posinset={item.order + 1}
      aria-setsize={totalCount}
    >
      <SidebarMenuButton
        asChild
        className={cn(
          "h-7 gap-0 px-1 text-xs",
          item.isBranchable &&
            "font-medium text-sky-950 data-[active=true]:text-sky-950 dark:text-sky-100 dark:data-[active=true]:text-sky-100",
          inactive && "text-sidebar-foreground/45 hover:text-sidebar-accent-foreground",
          item.isBranchable && inactive && "text-sky-950/45 hover:text-sky-950 dark:text-sky-100/45",
          loading && "animate-pulse",
        )}
        isActive={active}
        size="sm"
        title={title}
      >
        <div
          data-tree-entry-id={item.id}
          data-tree-index={item.order}
          aria-current={item.isLeaf ? "location" : undefined}
          aria-pressed={selected}
          aria-expanded={item.isExpandable ? item.isExpanded : undefined}
          data-tree-depth={item.depth}
          data-tree-search-match={item.isSearchMatch ? "true" : undefined}
          onClick={() => onSelect(item.id)}
          onKeyDown={selectFromKeyboard}
          role="button"
          tabIndex={tabIndex}
        >
          <TreeGutter item={item} onToggleExpand={onToggleExpand} />
          <TreeActionSlot
            branchEnabled={branchEnabled}
            branchTitle={branchTitle}
            continueTitle={continueTitle}
            item={item}
            loading={loading}
            onBranch={onBranch}
            onContinue={onContinue}
          />
          <span className="min-w-0 flex-1 truncate">
            {renderHighlightedSegments(segments)}
            {item.detail && (
              <span className={cn("text-muted-foreground", inactive && "text-sidebar-foreground/35")}>
                {" · "}
                {renderHighlightedSegments(detailSegments)}
              </span>
            )}
          </span>
          {item.hiddenChildCount > 0 && (
            <span className="ml-1 shrink-0 rounded-sm bg-sidebar-accent px-1 text-[10px] text-muted-foreground">
              +{item.hiddenChildCount}
            </span>
          )}
        </div>
      </SidebarMenuButton>
      {!query && currentOrder === item.order && <div className="absolute inset-x-0 bottom-0 h-px bg-sidebar-border" />}
    </SidebarMenuItem>
  );
}

function TreeGutter({
  item,
  onToggleExpand,
}: {
  item: ConversationTreeItem;
  onToggleExpand: (entryId: string) => void;
}) {
  useLanguage();
  return (
    <span
      aria-hidden={!item.isExpandable}
      className="flex h-7 shrink-0 items-center"
      style={{ width: (item.connectorColumns.length + 1) * TREE_GUTTER_WIDTH }}
    >
      {item.connectorColumns.map((column) => (
        <span className="relative h-7 w-4 shrink-0" key={column.key}>
          {column.state === "line" && <span className="absolute inset-y-[-0.25rem] left-1/2 w-px bg-sidebar-border" />}
        </span>
      ))}
      <span className="relative flex h-7 w-4 shrink-0 items-center justify-center">
        <CurrentConnector kind={item.connectorKind} />
        {item.isExpandable && (
          <button
            aria-label={item.isExpanded ? t("Collapse branch") : t("Expand branch")}
            data-tree-action="toggle"
            className="relative z-[2] flex size-4 items-center justify-center rounded-sm bg-sidebar text-muted-foreground hover:bg-background hover:text-sidebar-foreground"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleExpand(item.id);
            }}
            title={item.isExpanded ? t("Collapse branch") : t("Expand branch")}
            type="button"
          >
            <ChevronRightIcon className={cn("size-3 transition-transform", item.isExpanded && "rotate-90")} />
          </button>
        )}
      </span>
    </span>
  );
}

function CurrentConnector({ kind }: { kind: ConversationTreeItem["connectorKind"] }) {
  if (kind === "none" || kind === "blank") return null;

  return (
    <>
      {kind === "middle" && <span className="absolute inset-y-[-0.25rem] left-1/2 w-px bg-sidebar-border" />}
      {kind === "last" && <span className="absolute left-1/2 top-[-0.25rem] h-[1.125rem] w-px bg-sidebar-border" />}
      {kind === "line" && <span className="absolute inset-y-[-0.25rem] left-1/2 w-px bg-sidebar-border" />}
      {(kind === "middle" || kind === "last") && (
        <span className="absolute left-1/2 top-1/2 h-px w-1/2 bg-sidebar-border" />
      )}
    </>
  );
}

function TreeActionSlot({
  branchEnabled,
  branchTitle,
  continueTitle,
  item,
  loading,
  onBranch,
  onContinue,
}: {
  branchEnabled: boolean;
  branchTitle: string;
  continueTitle: string;
  item: ConversationTreeItem;
  loading: boolean;
  onBranch: (entryId: string) => void;
  onContinue: (entryId: string) => void;
}) {
  useLanguage();
  const actionClass =
    "flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-sidebar-foreground disabled:cursor-not-allowed disabled:opacity-45";

  return (
    <span className="flex h-7 w-5 shrink-0 items-center justify-center">
      {item.isBranchable ? (
        <button
          aria-label={branchTitle}
          data-tree-action="branch"
          className={actionClass}
          disabled={loading || !branchEnabled}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!branchEnabled) return;
            onBranch(item.id);
          }}
          title={branchTitle}
          type="button"
        >
          <GitBranchPlusIcon className="size-3.5" />
        </button>
      ) : item.isContinuable && item.continueTargetId ? (
        <button
          aria-label={t("Continue branch")}
          data-tree-action="continue"
          className={actionClass}
          disabled={loading || !branchEnabled}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!branchEnabled || !item.continueTargetId) return;
            onContinue(item.continueTargetId);
          }}
          title={continueTitle}
          type="button"
        >
          <ArrowRightToLineIcon className="size-3.5" />
        </button>
      ) : (
        <span aria-hidden="true" className="size-5 shrink-0" />
      )}
    </span>
  );
}

function renderHighlightedSegments(segments: Array<{ text: string; match: boolean; offset: number }>) {
  return segments.map((segment) =>
    segment.match ? (
      <mark className="rounded bg-primary/20 px-0.5 text-foreground" key={segment.offset}>
        {segment.text}
      </mark>
    ) : (
      <span key={segment.offset}>{segment.text}</span>
    ),
  );
}
