import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { defaultRemarkPlugins } from "streamdown";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fileDownloadUrl, fileLinkPath, remarkFileLinks } from "../../core/file-links";
import { t, useLanguage } from "../../core/i18n";
import { usePiWebUiStore } from "../../core/store";

const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkFileLinks];
const linkSafety = { enabled: false };
type Selection = { path: string; sessionId: string; runtimeId: string };

export function FileMessageResponse({ children, className }: { children: string; className?: string }) {
  return (
    <div data-file-message>
      <MessageResponse className={className} remarkPlugins={remarkPlugins} linkSafety={linkSafety}>
        {children}
      </MessageResponse>
    </div>
  );
}

// A settled history snapshot can replace the message row's key. Keep the user's
// pending confirmation outside individual rows, but fence it to the Pi identity.
export function FileDownloadBoundary({ children }: { children: ReactNode }) {
  useLanguage();
  const sessionId = usePiWebUiStore((s) => s.sessionId);
  const runtimeId = usePiWebUiStore((s) => s.runtimeId);
  const connection = usePiWebUiStore((s) => s.connection);
  const prepareFileDownload = usePiWebUiStore((s) => s.prepareFileDownload);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const externalRequest = useRef(0);
  function closeExternal() {
    externalRequest.current++;
    setExternalUrl(null);
    setLinkCopied(false);
  }
  function close() {
    request.current++;
    setSelection(null);
    setBusy(false);
    setFailed(false);
  }
  useEffect(() => {
    if (!selection || (selection.sessionId === sessionId && selection.runtimeId === runtimeId)) return;
    request.current++;
    setSelection(null);
    setBusy(false);
    setFailed(false);
  }, [sessionId, runtimeId, selection]);
  useEffect(
    () => () => {
      request.current++;
      externalRequest.current++;
    },
    [],
  );

  function select(event: MouseEvent<HTMLDivElement>) {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    const href = anchor?.getAttribute("href");
    if (!href || !anchor?.closest("[data-file-message]")) return;
    const path = fileLinkPath(href);
    event.preventDefault();
    event.stopPropagation();
    if (!path) {
      // Preserve the external-link confirmation instead of treating URLs as files.
      externalRequest.current++;
      setLinkCopied(false);
      setExternalUrl(href);
      return;
    }
    if (!sessionId || !runtimeId) return;
    request.current++;
    setBusy(false);
    setFailed(false);
    setSelection({ path, sessionId, runtimeId });
  }

  async function download() {
    if (!selection || busy) return;
    const current = usePiWebUiStore.getState();
    if (
      current.sessionId !== selection.sessionId ||
      current.runtimeId !== selection.runtimeId ||
      current.connection !== "connected"
    ) {
      close();
      return;
    }
    const id = ++request.current;
    setBusy(true);
    setFailed(false);
    try {
      const result = await prepareFileDownload(selection.path);
      if (id !== request.current) return;
      const anchor = document.createElement("a");
      anchor.href = fileDownloadUrl(result, location.origin, location.pathname);
      anchor.download = result.filename;
      anchor.rel = "noopener noreferrer";
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
      close();
    } catch {
      if (id === request.current) {
        setBusy(false);
        setFailed(true);
      }
    }
  }

  return (
    <>
      <div className="contents" onClickCapture={select}>
        {children}
      </div>
      <Dialog
        open={Boolean(selection && selection.sessionId === sessionId && selection.runtimeId === runtimeId)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Download this file?")}</DialogTitle>
            <DialogDescription>{t("Save this project file to your device?")}</DialogDescription>
          </DialogHeader>
          <p className="break-all text-sm" data-testid="download-file-path">
            {selection?.path}
          </p>
          {failed && (
            <p role="alert" className="text-destructive text-sm">
              {t("File unavailable for download. Use a regular, non-sensitive file in the current project.")}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button onClick={() => void download()} disabled={busy || connection !== "connected"}>
              {t(busy ? "Preparing download..." : "Yes, download")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={externalUrl !== null}
        onOpenChange={(open) => {
          if (!open) closeExternal();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Open external link?")}</DialogTitle>
            <DialogDescription>{t("You're about to visit an external website.")}</DialogDescription>
          </DialogHeader>
          <p className="break-all text-sm">{externalUrl}</p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={async () => {
                if (!externalUrl) return;
                const id = ++externalRequest.current;
                try {
                  await navigator.clipboard.writeText(externalUrl);
                  if (id === externalRequest.current) setLinkCopied(true);
                } catch {
                  if (id === externalRequest.current) setLinkCopied(false);
                }
              }}
            >
              {t(linkCopied ? "Copied" : "Copy link")}
            </Button>
            <Button variant="outline" onClick={closeExternal}>
              {t("Cancel")}
            </Button>
            <Button
              onClick={() => {
                if (externalUrl) window.open(externalUrl, "_blank", "noopener,noreferrer");
                closeExternal();
              }}
            >
              {t("Open link")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
