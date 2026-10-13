import { FileTextIcon, GitBranchIcon, Loader2Icon } from "lucide-react";
import { useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatTime } from "../../core/format";
import { t, useLanguage } from "../../core/i18n";
import type { GitStatusResult, WorkspaceArtifact } from "../../core/types";

export function WorkspaceStatusFloat({
  open,
  onOpenChange,
  artifacts,
  gitLoading,
  gitStatus,
  onOpenArtifact,
  onOpenGitDiff,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifacts: WorkspaceArtifact[];
  gitLoading: boolean;
  gitStatus: GitStatusResult | null;
  onOpenArtifact: (artifact: WorkspaceArtifact) => void;
  onOpenGitDiff: () => void;
}) {
  useLanguage();
  // Wait for the modal's focus trap to release before opening another surface.
  const pendingSelectionRef = useRef<(() => void) | null>(null);
  const canOpenGitDiff = Boolean(gitStatus?.isRepo);
  const recentArtifacts = artifacts.slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(80dvh,36rem)] overflow-y-auto rounded-xl p-5 shadow-sm sm:max-w-md"
        data-testid="workspace-status-float"
        onOpenAutoFocus={() => {
          pendingSelectionRef.current = null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const selection = pendingSelectionRef.current;
          pendingSelectionRef.current = null;
          if (selection) {
            selection();
            requestAnimationFrame(() => {
              document.querySelector<HTMLButtonElement>('[data-testid="hide-right-panel"]')?.focus();
            });
          } else {
            document.querySelector<HTMLButtonElement>('[data-testid="open-workspace-status"]')?.focus();
          }
        }}
      >
        <div className="space-y-1 pr-6">
          <DialogTitle className="text-base">{t("Workspace")}</DialogTitle>
          <DialogDescription>{t("Git changes and recent artifacts")}</DialogDescription>
        </div>
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-muted-foreground text-xs">Git</div>
            {gitLoading && <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
              canOpenGitDiff ? "hover:bg-muted" : "cursor-default",
            )}
            data-testid="workspace-git-row"
            disabled={!canOpenGitDiff}
            onClick={() => {
              pendingSelectionRef.current = onOpenGitDiff;
              onOpenChange(false);
            }}
            type="button"
          >
            <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">{gitBranchLabel(gitStatus, gitLoading)}</div>
              <div className="truncate text-muted-foreground text-xs">{gitDetailLabel(gitStatus, gitLoading)}</div>
            </div>
            {gitStatus?.isRepo && gitStatus.hasChanges && (
              <div className="shrink-0 font-medium text-xs">
                <span className="text-emerald-600">+{gitStatus.additions}</span>{" "}
                <span className="text-destructive">-{gitStatus.deletions}</span>
              </div>
            )}
          </button>
        </section>

        <section className="space-y-2 pt-2">
          <div className="flex items-center justify-between">
            <div className="text-muted-foreground text-sm">{t("Artifacts")}</div>
            {artifacts.length > 0 && <div className="text-muted-foreground text-xs">{artifacts.length}</div>}
          </div>
          {recentArtifacts.length === 0 ? (
            <div className="px-2 py-1.5 text-muted-foreground text-sm">{t("No artifacts yet")}</div>
          ) : (
            <div className="space-y-1">
              {recentArtifacts.map((artifact) => (
                <ArtifactRow
                  artifact={artifact}
                  key={artifact.path}
                  onOpen={() => {
                    pendingSelectionRef.current = () => onOpenArtifact(artifact);
                    onOpenChange(false);
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactRow({ artifact, onOpen }: { artifact: WorkspaceArtifact; onOpen: () => void }) {
  useLanguage();
  return (
    <button
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
      data-testid="workspace-artifact-row"
      onClick={onOpen}
      type="button"
    >
      <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{artifact.name}</div>
        <div className="truncate text-muted-foreground text-xs">{artifact.directory}</div>
      </div>
      <div className="shrink-0 text-muted-foreground text-xs">
        {artifact.tool} · {formatTime(new Date(artifact.updatedAt).toISOString())}
      </div>
    </button>
  );
}

function gitBranchLabel(gitStatus: GitStatusResult | null, loading: boolean): string {
  if (loading && !gitStatus) return t("Loading git status");
  if (!gitStatus) return t("Git status unavailable");
  if (!gitStatus.isRepo) return t("No git repository");
  return gitStatus.branch || t("Detached HEAD");
}

function gitDetailLabel(gitStatus: GitStatusResult | null, loading: boolean): string {
  if (loading && !gitStatus) return t("Checking workspace");
  if (!gitStatus) return t("Connect to Pi to load status");
  if (!gitStatus.isRepo) return t("Open a git workspace to view changes");
  if (!gitStatus.hasChanges) return t("No changes");
  if (gitStatus.untracked)
    return t(gitStatus.untracked === 1 ? "{count} untracked file" : "{count} untracked files", {
      count: gitStatus.untracked,
    });
  return t("Changes");
}
