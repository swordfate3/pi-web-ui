import { jsonTextPrefix } from "../../../../extensions/bounded-json";
import { MAX_IMAGE_DIM, VALID_IMAGE_MIME_TYPES } from "./constants";
import { boundedToolOutput } from "./conversation-window";
import type { ChatItem, PiMessage, PromptImage, Usage } from "./types";
import { UiError, uiText } from "./ui-text";

export function syncToItems(
  entries: Array<{ type: string; id?: string; message?: PiMessage; historyPreview?: boolean }>,
  nextId: (prefix: string) => string,
): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ChatItem & { kind: "tool" }>();

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;

    if (message.role === "user") {
      const text = extractText(message.content);
      const images = extractImages(message.content);
      if (text || images.length > 0) {
        items.push({
          kind: "message",
          id: message.id || nextId("user"),
          role: "user",
          text,
          images,
          entryId: entry.id,
          historyPreview: entry.historyPreview,
        });
      }
    } else if (message.role === "assistant") {
      const text = extractText(message.content);
      const reasoning = extractThinking(message.content);
      const toolCalls = extractToolCalls(message.content);
      if (text || reasoning) {
        items.push({
          kind: "message",
          id: message.id || nextId("assistant"),
          role: "assistant",
          text,
          reasoning,
          copyable: !entry.historyPreview && toolCalls.length === 0,
          presentation: toolCalls.length > 0 ? "activity" : "normal",
          cost: message.usage?.cost?.total,
          entryId: entry.id,
          historyPreview: entry.historyPreview,
        });
      }

      for (const call of toolCalls) {
        const tool: ChatItem & { kind: "tool" } = {
          kind: "tool",
          id: call.id || nextId("tool"),
          name: call.name || "tool",
          input: call.arguments,
          state: "input-available",
          entryId: entry.id,
          historyPreview: entry.historyPreview,
          relatedEntryIds: entry.id ? [entry.id] : [],
        };
        tools.set(tool.id, tool);
        items.push(tool);
      }
    } else if (message.role === "toolResult" && message.toolCallId) {
      let tool = tools.get(message.toolCallId);
      // Bounded pages can begin after the invocation (count, bytes or dates).
      // Keep its result visible without fetching outside the selected page.
      if (!tool) {
        tool = {
          kind: "tool",
          id: message.toolCallId,
          name: message.toolName || "tool",
          input: { historyPreview: true, notice: "Tool invocation is outside this history page." },
          resultOnly: true,
          state: "input-available",
          entryId: entry.id,
          relatedEntryIds: entry.id ? [entry.id] : [],
        };
        tools.set(tool.id, tool);
        items.push(tool);
      }
      if (tool) {
        const result = boundedToolOutput(message.content);
        if (entry.historyPreview || result.preview) {
          tool.historyPreview = true;
          tool.detailEntryId = entry.id;
        }
        if (entry.id && !tool.relatedEntryIds?.includes(entry.id)) {
          tool.relatedEntryIds = [...(tool.relatedEntryIds ?? []), entry.id];
        }
        if (message.isError) {
          tool.state = "output-error";
          tool.errorText = result.output;
        } else {
          tool.state = "output-available";
          tool.output = result.output;
        }
      }
    }
  }

  return items;
}

export function extractText(content: PiMessage["content"]): string {
  return extractSection(content, "text");
}

export function extractThinking(content: PiMessage["content"]): string {
  return extractSection(content, "thinking");
}

function extractSection(content: PiMessage["content"], type: "text" | "thinking") {
  if (typeof content === "string") return type === "text" ? jsonTextPrefix(content, 64 * 1024) : "";
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let remaining = 64 * 1024;
  for (const block of content) {
    if (block.type !== type) continue;
    const value = (block as Record<string, unknown>)[type];
    if (typeof value !== "string" || !value) continue;
    const text = jsonTextPrefix(value, remaining);
    parts.push(text);
    remaining -= new TextEncoder().encode(JSON.stringify(text)).length;
    if (text.length < value.length || remaining <= 0) break;
  }
  return parts.join("\n");
}

export function extractImages(content: PiMessage["content"]): PromptImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (
        block,
      ): block is {
        type: "image";
        data?: string;
        mimeType?: string;
        source?: { data?: string; media_type?: string };
      } => block.type === "image",
    )
    .map((block) => ({
      data: block.source?.data || block.data || "",
      mimeType: block.source?.media_type || block.mimeType || "image/png",
    }))
    .filter((image) => image.data);
}

export function extractToolCalls(content: PiMessage["content"]) {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (
      block,
    ): block is {
      type: "toolCall";
      id?: string;
      name?: string;
      arguments?: unknown;
    } => block.type === "toolCall",
  );
}

export function findLastUsage(entries: Array<{ type: string; message?: PiMessage }>): Usage | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const usage = entries[i].message?.usage;
    if (usage) return usage;
  }
  return null;
}

export async function processPromptFiles(files: unknown[] | undefined): Promise<PromptImage[]> {
  if (!files?.length) return [];
  const images: PromptImage[] = [];
  for (const filePart of files) {
    const file = filePart instanceof File ? filePart : getFileFromPart(filePart);
    if (!file) {
      const converted = getImageFromFilePart(filePart);
      if (converted) images.push(converted);
      continue;
    }
    if (!file.type.startsWith("image/")) continue;
    try {
      images.push(await processImageFile(file));
    } catch (err) {
      console.error("[pi-web-ui] Image processing failed:", err);
    }
  }
  return images;
}

function getFileFromPart(part: unknown): File | null {
  if (typeof part !== "object" || part === null) return null;
  const maybeFile = (part as { file?: unknown }).file;
  return maybeFile instanceof File ? maybeFile : null;
}

function getImageFromFilePart(part: unknown): PromptImage | null {
  if (typeof part !== "object" || part === null) return null;
  const value = part as { mediaType?: string; mimeType?: string; url?: string };
  const mimeType = value.mediaType || value.mimeType || "";
  if (!mimeType.startsWith("image/") || !value.url?.startsWith("data:")) return null;
  const [, data = ""] = value.url.split(",");
  return data ? { data, mimeType } : null;
}

function processImageFile(file: File): Promise<PromptImage> {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_IMAGE_MIME_TYPES.includes(file.type) ? file.type : "image/png";
    const reader = new FileReader();
    reader.onerror = () => reject(new UiError(uiText("Failed to read file")));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new UiError(uiText("Failed to create canvas")));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const outputMime = mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
        const dataUrl = canvas.toDataURL(outputMime, outputMime === "image/jpeg" ? 0.85 : undefined);
        const base64 = dataUrl.split(",")[1];
        if (!base64) {
          reject(new UiError(uiText("Failed to encode image")));
          return;
        }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new UiError(uiText("Failed to decode image")));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function formatToolOutput(result: unknown): string {
  return boundedToolOutput(result).output;
}
