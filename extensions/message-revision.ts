import { isDeepStrictEqual } from "node:util";

/** Raw-session revision rules. Never use browser history previews as source content. */
export type RevisionMode = "edit" | "regenerate";
export type RevisionEntry = {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role?: string; content?: unknown };
};
export type RevisionBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// Reserve ample room within the 4 MiB application frame for the response envelope.
export const MAX_REVISION_TEXT_BYTES = 2 * 1024 * 1024;

export function checkRevisionTextBudget(text: string): void {
  if (
    text.length > MAX_REVISION_TEXT_BYTES ||
    new TextEncoder().encode(JSON.stringify(text)).byteLength > MAX_REVISION_TEXT_BYTES
  ) {
    throw new Error("Full message text is too large for Web revision. Edit it in Pi locally; no text was truncated.");
  }
}

export function resolveMessageRevision(
  getEntry: (id: string) => RevisionEntry | undefined,
  entryId: unknown,
  mode: unknown,
) {
  if (mode !== "edit" && mode !== "regenerate") throw new Error("Invalid message revision mode");
  if (typeof entryId !== "string" || !entryId) throw new Error("Select a saved message to revise");
  const target = getEntry(entryId);
  if (
    !target ||
    target.id !== entryId ||
    target.type !== "message" ||
    target.message?.role !== (mode === "edit" ? "user" : "assistant")
  ) {
    throw new Error("Select a saved user message to edit or an assistant response to regenerate");
  }
  let entry: RevisionEntry = target;
  const visited = new Set<string>();
  while (entry.type !== "message" || entry.message?.role !== "user") {
    if (visited.has(entry.id)) throw new Error("Invalid message parent chain");
    visited.add(entry.id);
    const parentId: string | null = entry.parentId;
    const parent: RevisionEntry | undefined = typeof parentId === "string" ? getEntry(parentId) : undefined;
    if (!parent || parent.id !== parentId) throw new Error("No original user message found in this parent chain");
    entry = parent;
  }
  if (entry.parentId !== null && (typeof entry.parentId !== "string" || !entry.parentId)) {
    throw new Error("Invalid user message parent");
  }
  const raw = entry.message?.content;
  let content: string | RevisionBlock[];
  if (typeof raw === "string") content = raw;
  else if (Array.isArray(raw)) {
    content = raw.map((block): RevisionBlock => {
      if (block && block.type === "text" && typeof block.text === "string") return { ...block };
      if (
        block &&
        block.type === "image" &&
        typeof block.data === "string" &&
        block.data &&
        typeof block.mimeType === "string" &&
        block.mimeType
      )
        return { ...block };
      throw new Error("This user message has unsupported or malformed attachments; revision would lose content");
    });
  } else throw new Error("Unsupported original user message content");
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  checkRevisionTextBudget(text);
  const hasImages = Array.isArray(content) && content.some((block) => block.type === "image");
  if (!text.trim() && !hasImages) throw new Error("The original user message is empty");
  return { entryId, userEntryId: entry.id, parentId: entry.parentId, text, hasImages, content };
}

export function revisionContent(
  original: ReturnType<typeof resolveMessageRevision>,
  mode: unknown,
  text: unknown,
): string | RevisionBlock[] {
  if (mode === "regenerate") {
    if (text !== undefined) throw new Error("Regeneration uses the original question, not replacement text");
    return original.content;
  }
  if (mode !== "edit" || typeof text !== "string" || !text.trim()) throw new Error("Edited message cannot be empty");
  checkRevisionTextBudget(text);
  if (typeof original.content === "string") return text;
  // Replace text at its first position; keep every original image and its order/bytes.
  let inserted = false;
  const content: RevisionBlock[] = [];
  for (const block of original.content) {
    if (block.type === "image") content.push(block);
    else if (!inserted) {
      content.push({ type: "text", text });
      inserted = true;
    }
  }
  if (!inserted) content.unshift({ type: "text", text });
  return content;
}

/** Match Pi's public user message event without adding markers to user content.
 * sendUserMessage joins text blocks with newlines and places images after text.
 * No input.source/request metadata survives onto message_start in Pi 1.1.
 * Compare all original image bytes too: transforms/resizing fail closed, not proof
 * of completion. The caller owns lifecycle reset and the expected parent fence.
 */
export function matchesRevisionDispatch(
  expected: { parentId: string | null; content: string | RevisionBlock[] },
  parentId: string | null,
  content: unknown,
): boolean {
  if (parentId !== expected.parentId) return false;
  const text =
    typeof expected.content === "string"
      ? expected.content
      : expected.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  const images = typeof expected.content === "string" ? [] : expected.content.filter((block) => block.type === "image");
  const normalized = [{ type: "text", text }, ...images];
  return isDeepStrictEqual(normalized, typeof content === "string" ? [{ type: "text", text: content }] : content);
}
