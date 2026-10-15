import { webRoute } from "./connection-path";
import type { FileDownloadResult } from "./types";
import { UiError, uiText } from "./ui-text";

const PREFIX = "#pi-download=";
const hasControls = (value: string) =>
  Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
export type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };

function localPath(value: string, encoded = false): string | null {
  let candidate = value;
  try {
    if (encoded) candidate = decodeURIComponent(candidate);
  } catch {
    return null;
  }
  candidate = candidate.replace(/^\.\//, "");
  if (
    !candidate ||
    candidate.length > 4096 ||
    hasControls(candidate) ||
    /[\\?#:]/.test(candidate) ||
    candidate.startsWith("//") ||
    candidate.split("/").some((part) => part === ".." || part.startsWith("."))
  )
    return null;
  if (!/\.[a-z0-9]{1,12}$/i.test(candidate)) return null;
  return candidate;
}

export function fileLinkPath(href: string | undefined): string | null {
  return href?.startsWith(PREFIX) ? localPath(href.slice(PREFIX.length), true) : null;
}

/** Transform Markdown nodes, not raw Markdown: fenced code, images and URLs stay intact. */
export function remarkFileLinks() {
  function link(value: string, child: MarkdownNode): MarkdownNode {
    return { type: "link", url: `${PREFIX}${encodeURIComponent(value)}`, children: [child] };
  }
  function walk(node: MarkdownNode) {
    if (node.type === "code" || node.type === "image" || node.type === "html" || node.type === "linkReference") return;
    if (node.type === "link" || node.type === "definition") {
      const candidate = node.url && localPath(node.url, true);
      if (candidate) node.url = `${PREFIX}${encodeURIComponent(candidate)}`;
      return;
    }
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "inlineCode" && child.value) {
        const candidate = localPath(child.value);
        if (candidate) return [link(candidate, child)];
      }
      if (child.type !== "text" || !child.value) {
        walk(child);
        return [child];
      }
      const nodes: MarkdownNode[] = [];
      let end = 0;
      for (const match of child.value.matchAll(/[^\s<>"'`*()[\]{}，。；！？：、]+/gu)) {
        const raw = match[0].replace(/[.,;!?]+$/, "");
        const candidate = raw.includes("/") ? localPath(raw) : null;
        if (!candidate) continue;
        const start = match.index;
        if (start > end) nodes.push({ type: "text", value: child.value.slice(end, start) });
        nodes.push(link(candidate, { type: "text", value: raw }));
        end = start + raw.length;
      }
      if (!nodes.length) return [child];
      if (end < child.value.length) nodes.push({ type: "text", value: child.value.slice(end) });
      return nodes;
    });
  }
  return walk;
}

export function fileDownloadUrl(result: FileDownloadResult, origin: string, pathname = "/") {
  if (
    !result ||
    typeof result.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.token) ||
    result.downloadUrl !== `/api/downloads/${result.token}` ||
    typeof result.filename !== "string" ||
    !result.filename ||
    /[/\\]/.test(result.filename) ||
    hasControls(result.filename) ||
    !Number.isSafeInteger(result.size) ||
    result.size < 0
  )
    throw new UiError(uiText("Invalid file download response"));
  const route = webRoute(result.downloadUrl, pathname);
  const url = new URL(route, origin);
  if (url.origin !== origin || url.pathname !== route || url.search || url.hash)
    throw new UiError(uiText("Invalid file download response"));
  return url.href;
}
