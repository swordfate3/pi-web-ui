import type { PiMessage } from "../../core/types";

/** Independent of output length: whitespace must also consume work budget. */
export const SIDEBAR_PREVIEW_SCAN_BUDGET = 4096;

/** Bounded display preview, not history truncation. Never serialize image/tool payloads. */
export function sidebarContentPreview(
  content: PiMessage["content"],
  kind: "text" | "thinking" = "text",
  max = 140,
): string {
  let result = "";
  let space = false;
  let remaining = SIDEBAR_PREVIEW_SCAN_BUDGET;
  const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
  for (const block of parts) {
    const part =
      typeof block === "string"
        ? block
        : block.type === kind
          ? block.type === "text"
            ? block.text
            : block.type === "thinking"
              ? block.thinking
              : ""
          : "";
    if (typeof part !== "string") continue;
    if (result) space = true;
    for (const char of part) {
      // An unexamined suffix is unknown, not empty. In particular, assistants with
      // text after a huge whitespace prefix must not disappear from the tree.
      if (remaining < char.length) return `${result.slice(0, max - 1)}...`;
      remaining -= char.length;
      if (/\s/.test(char)) {
        space = Boolean(result);
        continue;
      }
      if (space) result += " ";
      space = false;
      result += char;
      if (result.length > max) return `${result.slice(0, max - 1)}...`;
    }
  }
  return result;
}
