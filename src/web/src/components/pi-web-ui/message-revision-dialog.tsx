import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { t, useLanguage } from "../../core/i18n";

export type MessageRevisionDialogProps = {
  mode: "edit" | "regenerate";
  text: string;
  hasImages: boolean;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  onTextChange: (text: string) => void;
  onSubmit: () => void;
  onClose: () => void;
};

export function MessageRevisionDialog({
  mode,
  text,
  hasImages,
  loading,
  submitting,
  error,
  onTextChange,
  onSubmit,
  onClose,
}: MessageRevisionDialogProps) {
  useLanguage();
  const isEdit = mode === "edit";
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLTextAreaElement>(null);
  const cancelFocusRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();
  const onCloseRef = useRef(onClose);
  const submittingRef = useRef(submitting);
  onCloseRef.current = onClose;
  submittingRef.current = submitting;

  useEffect(() => {
    const focusInsideDialog = () => {
      if (isEdit && !initialFocusRef.current?.disabled) initialFocusRef.current?.focus();
      else if (!cancelFocusRef.current?.disabled) cancelFocusRef.current?.focus();
      else dialogRef.current?.focus();
    };
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusInsideDialog();

    const trapFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.contains(event.target as Node)) focusInsideDialog();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!submittingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", trapFocus);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", trapFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isEdit]);

  const canSubmit = !loading && !submitting && !error && (!isEdit || text.trim().length > 0);
  const title = isEdit ? t("Edit and resend") : t("Regenerate answer");

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-background/80 p-4 pt-[8vh] backdrop-blur-sm sm:pt-[12vh]">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-lg rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="mb-4 font-semibold text-base" id={titleId}>
          {title}
        </h2>

        {isEdit ? (
          <label className="mb-4 block space-y-2 text-sm" htmlFor={textId}>
            <span>{t("Edit the full question to resend")}</span>
            <textarea
              aria-label={t("Edit question")}
              autoComplete="off"
              className="min-h-40 w-full resize-y rounded-md border bg-background px-3 py-2 text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
              disabled={loading || submitting}
              id={textId}
              onChange={(event) => onTextChange(event.target.value)}
              ref={initialFocusRef}
              value={text}
            />
          </label>
        ) : (
          <div className="mb-4 space-y-2">
            <p className="text-sm font-medium">{t("Original question")}</p>
            <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 px-3 py-2 text-sm">
              {text}
            </div>
          </div>
        )}

        <div className="mb-4 space-y-3">
          <p className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 font-medium text-sm">
            {t(
              "Original branch preserved. Files are not rolled back. Regeneration may run tools again and use tokens.",
            )}
          </p>
          {hasImages && <p className="text-muted-foreground text-sm">{t("Original images will be preserved")}</p>}
        </div>

        {loading && (
          <p className="mb-3 text-muted-foreground text-sm" role="status">
            {t("Loading message…")}
          </p>
        )}
        {error && (
          <p
            className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm"
            role="alert"
          >
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={submitting} onClick={onClose} ref={cancelFocusRef} type="button" variant="outline">
            {t("Cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={onSubmit} type="button">
            {submitting ? t("Submitting…") : isEdit ? t("Edit and resend") : t("Regenerate")}
          </Button>
        </div>
      </div>
    </div>
  );
}
