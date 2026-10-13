import type { ExportHtmlResult } from "./types";
import { UiError, uiText } from "./ui-text";

/** Only accept the exact server-owned attachment route, never arbitrary HTML/URLs. */
export function exportDownloadUrl(result: ExportHtmlResult, origin: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !result ||
    typeof result.token !== "string" ||
    !uuid.test(result.token) ||
    result.downloadUrl !== `/api/exports/${result.token}` ||
    typeof result.filename !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*\.html$/i.test(result.filename)
  ) {
    throw new UiError(uiText("Invalid export download response"));
  }
  const url = new URL(result.downloadUrl, origin);
  if (url.origin !== origin || url.pathname !== result.downloadUrl || url.search || url.hash) {
    throw new UiError(uiText("Export download must use the same-origin attachment endpoint"));
  }
  return url.href;
}

export function downloadExport(result: ExportHtmlResult) {
  const anchor = document.createElement("a");
  anchor.href = exportDownloadUrl(result, window.location.origin);
  anchor.download = result.filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}
