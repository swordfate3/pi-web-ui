import { Settings2Icon, TerminalIcon } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { t, useLanguage } from "../../core/i18n";
import type { ConnectionState, SessionTreeNode } from "../../core/types";
import { ConnectionDot } from "./connection-dot";
import { ConversationSidebarTree } from "./conversation-sidebar-tree";
import { useConversationTree } from "./use-conversation-tree";

const EMPTY_TREE: SessionTreeNode[] = [];

interface ConversationSidebarProps {
  branchEnabled: boolean;
  connection: ConnectionState;
  tree: SessionTreeNode[];
  leafId: string | null;
  selectedEntryId: string | null;
  loadingEntryId: string | null;
  syncing: boolean;
  syncError: string | null;
  onOpenSettings: () => void;
  onBranchTree: (entryId: string) => void;
  onContinueTree: (entryId: string) => void;
  onRefreshTree: () => void;
  onResizeSidebar: (width: number) => void;
  onSelectTree: (entryId: string) => void;
}

export function ConversationSidebar({
  branchEnabled,
  connection,
  tree,
  leafId,
  selectedEntryId,
  loadingEntryId,
  syncing,
  syncError,
  onOpenSettings,
  onBranchTree,
  onContinueTree,
  onRefreshTree,
  onResizeSidebar,
  onSelectTree,
}: ConversationSidebarProps) {
  useLanguage();
  const { isMobile, open, openMobile, setOpenMobile } = useSidebar();
  const navigationOpen = isMobile ? openMobile : open;
  const [query, setQuery] = useState("");
  const openedRef = useRef(false);
  if (navigationOpen) openedRef.current = true;
  // Lightweight owner survives desktop close and Sheet unmount; no hidden row DOM.
  const treeState = useConversationTree(openedRef.current ? tree : EMPTY_TREE, leafId, query.trim());
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const suppressRailClickRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
  const startSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !window.matchMedia("(min-width: 768px)").matches) return;
      const sidebar = event.currentTarget.closest<HTMLElement>("[data-slot='sidebar']");
      if (sidebar?.dataset.state !== "expanded") return;
      event.preventDefault();
      resizeCleanupRef.current?.();

      const startX = event.clientX;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      suppressRailClickRef.current = false;

      let frame: number | null = null;
      let latestX = startX;
      const flushResize = () => {
        frame = null;
        onResizeSidebar(latestX);
      };
      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (Math.abs(moveEvent.clientX - startX) < 4 && !suppressRailClickRef.current) return;
        suppressRailClickRef.current = true;
        latestX = moveEvent.clientX;
        if (frame === null) frame = requestAnimationFrame(flushResize);
      };

      const stopResize = () => {
        const didResize = suppressRailClickRef.current;
        if (frame !== null) {
          cancelAnimationFrame(frame);
          flushResize();
        }
        resizeCleanupRef.current = null;
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", stopResize);
        document.removeEventListener("pointercancel", stopResize);
        window.setTimeout(() => {
          if (didResize) suppressRailClickRef.current = false;
        }, 120);
      };

      resizeCleanupRef.current = stopResize;
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", stopResize);
      document.addEventListener("pointercancel", stopResize);
    },
    [onResizeSidebar],
  );
  const handleRailClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!suppressRailClickRef.current) return;
    suppressRailClickRef.current = false;
    event.preventDefault();
  }, []);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <div className="flex h-10 items-center gap-2 group-data-[collapsible=icon]:justify-center">
          <div className="flex min-w-0 flex-1 items-center gap-2 group-data-[collapsible=icon]:hidden">
            <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
            <ConnectionDot state={connection} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">Pi Web UI</div>
              <div className="truncate text-muted-foreground text-xs">{t("Browser interface for Pi")}</div>
            </div>
          </div>
          <SidebarTrigger aria-label={t("Close left sidebar")} title={t("Close left sidebar")} />
        </div>
      </SidebarHeader>

      <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />

      <SidebarContent className="group-data-[collapsible=icon]:hidden">
        {navigationOpen && (
          <ConversationSidebarTree
            branchEnabled={branchEnabled}
            leafId={leafId}
            loadingEntryId={loadingEntryId}
            onBranch={(entryId) => {
              closeMobile();
              onBranchTree(entryId);
            }}
            onContinue={(entryId) => {
              closeMobile();
              onContinueTree(entryId);
            }}
            onRefresh={onRefreshTree}
            onSelect={(entryId) => {
              closeMobile();
              onSelectTree(entryId);
            }}
            selectedEntryId={selectedEntryId}
            syncError={syncError}
            syncing={syncing}
            tree={tree}
            treeState={treeState}
            query={query}
            onQueryChange={setQuery}
          />
        )}
      </SidebarContent>

      <SidebarFooter>
        <Button
          className="w-full justify-start gap-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          onClick={() => {
            closeMobile();
            onOpenSettings();
          }}
          type="button"
          variant="ghost"
        >
          <Settings2Icon className="size-4" />
          <span className="group-data-[collapsible=icon]:hidden">{t("Settings")}</span>
        </Button>
      </SidebarFooter>
      <SidebarRail
        aria-label={t("Resize or toggle left sidebar")}
        onClick={handleRailClick}
        onPointerDown={startSidebarResize}
        title={t("Drag to resize, click to toggle")}
        className="group-data-[collapsible=offcanvas]:hidden"
      />
    </Sidebar>
  );
}
