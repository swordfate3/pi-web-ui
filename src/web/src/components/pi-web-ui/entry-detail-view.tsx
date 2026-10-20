import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { entryDetailTargets } from "../../core/conversation-window";
import { t, useLanguage } from "../../core/i18n";
import { usePiWebUiStore } from "../../core/store";
import type { ChatItem } from "../../core/types";
import { renderUiText } from "../../core/ui-text";

export function EntryPreviewControl({ item }: { item: ChatItem }) {
  useLanguage();
  const load = usePiWebUiStore((state) => state.loadEntryDetail);
  const available = usePiWebUiStore((state) => state.connection === "connected" && !state.sessionActionPending);
  if (!item.historyPreview) return null;
  const targets = entryDetailTargets(item);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
      <span>
        {t(
          targets.length
            ? "History preview. Full data remains in the original session."
            : "Live preview. Details become available after this entry is saved.",
        )}
      </span>
      {targets.map((entryId, index) => (
        <Button key={entryId} size="sm" variant="outline" disabled={!available} onClick={() => void load(entryId)}>
          {t(
            targets.length === 1 ? "Load entry detail" : index === 0 ? "Load invocation detail" : "Load result detail",
          )}
        </Button>
      ))}
    </div>
  );
}

/** One viewer for the conversation, not one retained text buffer per row. */
export function EntryDetailViewer() {
  useLanguage();
  const detail = usePiWebUiStore((state) => state.entryDetail);
  const loading = usePiWebUiStore((state) => state.entryDetailLoading);
  const error = usePiWebUiStore((state) => state.entryDetailError);
  const close = usePiWebUiStore((state) => state.closeEntryDetail);
  const load = usePiWebUiStore((state) => state.loadEntryDetail);
  return (
    <Dialog
      open={Boolean(detail)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[85dvh] min-w-0 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Entry detail")}</DialogTitle>
          <DialogDescription>
            {t("Only one chunk is shown. Loading the next chunk replaces this one.")}
          </DialogDescription>
        </DialogHeader>
        {loading && <p role="status">{t("Loading message…")}</p>}
        {error && (
          <p role="alert" className="break-words text-destructive">
            {renderUiText(error)}
          </p>
        )}
        <pre className="max-h-[55dvh] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs [overflow-wrap:anywhere]">
          {detail?.text}
        </pre>
        {detail?.nextCursor && (
          <Button
            disabled={loading}
            onClick={() => {
              if (detail.nextCursor) void load(detail.entryId, detail.nextCursor);
            }}
          >
            {t("Next detail chunk")}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
