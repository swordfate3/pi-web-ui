import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { entryDetailTargets } from "../../core/conversation-window";
import { t, useLanguage } from "../../core/i18n";
import { usePiWebUiStore } from "../../core/store";
import type { ChatItem } from "../../core/types";
import { renderUiText } from "../../core/ui-text";
import { FileMessageResponse } from "./file-message-response";

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
        <Button
          key={entryId}
          size="sm"
          variant="outline"
          disabled={!available}
          onClick={() => void load(entryId, undefined, "markdown")}
        >
          {t(targets.length === 1 ? "Read full result" : index === 0 ? "Load invocation detail" : "Read full result")}
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
  const previous = usePiWebUiStore((state) => state.loadPreviousEntryDetail);
  const page = usePiWebUiStore((state) => state.entryDetailPageIndex);
  const presentation = usePiWebUiStore((state) => state.entryDetailPresentation);
  const [sourceEntry, setSourceEntry] = useState<string | null>(null);
  const source = Boolean(detail && sourceEntry === detail.entryId);
  return (
    <Dialog
      open={Boolean(detail)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="flex max-h-[90dvh] min-w-0 flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("Entry detail")}</DialogTitle>
          <DialogDescription>
            {t("Read the complete result page by page. Only the current page is kept in memory.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={loading || page === 0}
            onClick={() => void previous()}
            aria-label={t("Previous result page")}
          >
            {t("Previous result page")}
          </Button>
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {t("Result page {page}", { page: page + 1 })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={loading || !detail?.nextCursor}
            onClick={() => {
              if (detail?.nextCursor) void load(detail.entryId, detail.nextCursor, presentation);
            }}
          >
            {t("Next result page")}
          </Button>
          {detail?.format === "markdown" && (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={source}
              onClick={() => setSourceEntry(source ? null : detail.entryId)}
            >
              {t(source ? "Rendered" : "Source")}
            </Button>
          )}
        </div>
        {loading && <p role="status">{t("Loading result page…")}</p>}
        {error && (
          <p role="alert" className="break-words text-destructive">
            {renderUiText(error)}
          </p>
        )}
        {detail?.format === "text" && (
          <p className="text-muted-foreground text-xs">
            {t("This block is shown as source to preserve content across page boundaries.")}
          </p>
        )}
        <div
          key={`${detail?.entryId}:${page}`}
          data-testid="entry-detail-body"
          className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border p-3 [overflow-wrap:anywhere]"
        >
          {detail?.format === "markdown" && !source ? (
            <FileMessageResponse
              key={`${detail.entryId}:${page}`}
              mode="static"
              className="break-words text-sm leading-6 [&_pre]:overflow-x-auto"
            >
              {detail.text}
            </FileMessageResponse>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-xs">{detail?.text}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
