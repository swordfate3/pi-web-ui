import { ArrowLeftIcon, BrainIcon, ChevronsUpDownIcon, CommandIcon, GitCompareIcon, Settings2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { connectionLabel, t, thinkingLabel, useLanguage } from "../../core/i18n";
import type { ConnectionState } from "../../core/types";
import { ConnectionDot } from "./connection-dot";

type AppHeaderProps = {
  title: string;
  connection: ConnectionState;
  modelLabel: string;
  thinkingLevel: string;
  isViewingOtherSession: boolean;
  /** Context window size in tokens (0 = unknown). */
  contextWindowSize: number;
  /** Context usage percentage (0-100). */
  contextPercent: number;
  /** Should suggest compaction (80% or higher usage). */
  shouldSuggestCompaction: boolean;
  /** Total cost in dollars. */
  totalCost: number;
  onReturnToLive: () => void;
  onOpenModelPicker: () => void;
  onCycleThinking: () => void;
  onToggleContext: () => void;
  onCompactContext: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onToggleWorkspace: () => void;
  workspaceOpen: boolean;
  contextOpen: boolean;
};

export function AppHeader({
  title,
  connection,
  modelLabel,
  thinkingLevel,
  isViewingOtherSession,
  contextWindowSize,
  contextPercent,
  shouldSuggestCompaction,
  totalCost,
  onReturnToLive,
  onOpenModelPicker,
  onCycleThinking,
  onToggleContext,
  onCompactContext,
  onOpenCommandPalette,
  onOpenSettings,
  onToggleWorkspace,
  workspaceOpen,
  contextOpen,
}: AppHeaderProps) {
  useLanguage();
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 sm:flex-nowrap sm:px-5">
      <SidebarTrigger
        data-testid="toggle-left-sidebar"
        aria-label={t("Toggle left sidebar")}
        className="size-9 shrink-0"
        title={t("Toggle left sidebar")}
      />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0" title={connectionLabel(connection)}>
          <ConnectionDot state={connection} />
          <span className="sr-only">{connectionLabel(connection)}</span>
        </span>
        <div className="truncate font-medium text-sm" title={title}>
          {title || "Pi"}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 sm:order-last">
        <Button
          data-testid="open-workspace-status"
          aria-label={t("Open workspace status")}
          aria-expanded={workspaceOpen}
          aria-haspopup="dialog"
          onClick={onToggleWorkspace}
          size="icon-sm"
          title={t("Workspace status")}
          type="button"
          variant="ghost"
        >
          <GitCompareIcon className="size-4" />
        </Button>
        <Button
          data-testid="open-settings"
          aria-label={t("Open settings")}
          onClick={onOpenSettings}
          size="icon-sm"
          title={t("Settings")}
          type="button"
          variant="ghost"
        >
          <Settings2Icon className="size-4" />
        </Button>
        <Button
          aria-label={t("Open command palette")}
          onClick={onOpenCommandPalette}
          size="icon-sm"
          title={t("Commands (Ctrl/⌘ K)")}
          type="button"
          variant="ghost"
        >
          <CommandIcon className="size-4" />
        </Button>
      </div>

      {isViewingOtherSession && (
        <Button onClick={onReturnToLive} size="sm" type="button" variant="ghost">
          <ArrowLeftIcon className="size-4" />

          {t("Live")}
        </Button>
      )}

      <div className="flex w-full min-w-0 items-center justify-end gap-0.5 text-muted-foreground sm:w-auto">
        <Button
          aria-label={modelLabel}
          className="min-w-0 shrink px-2"
          onClick={onOpenModelPicker}
          size="sm"
          title={t("Select model")}
          type="button"
          variant="ghost"
        >
          <ChevronsUpDownIcon className="size-4" />
          <span className="max-w-36 truncate sm:max-w-40">{modelLabel}</span>
        </Button>
        <Button
          className="shrink-0 px-2"
          onClick={onCycleThinking}
          size="sm"
          title={t("Cycle thinking level")}
          type="button"
          variant="ghost"
        >
          <BrainIcon className="hidden size-4 sm:block" />
          <span>{thinkingLabel(thinkingLevel)}</span>
        </Button>
        {contextWindowSize > 0 && (
          <Button
            aria-label={t("Open context usage")}
            aria-expanded={contextOpen}
            title={t("Context usage")}
            className={cn("shrink-0 px-2", shouldSuggestCompaction && "text-amber-600 dark:text-amber-400")}
            onClick={onToggleContext}
            size="sm"
            type="button"
            variant="ghost"
          >
            {contextPercent}%
          </Button>
        )}
        {totalCost > 0 && (
          <div className="hidden px-2 py-1 text-muted-foreground text-xs lg:block">${totalCost.toFixed(4)}</div>
        )}
        {shouldSuggestCompaction && (
          <Button className="shrink-0 px-2" onClick={onCompactContext} size="sm" type="button" variant="ghost">
            {t("Compact")}
          </Button>
        )}
      </div>
    </header>
  );
}
