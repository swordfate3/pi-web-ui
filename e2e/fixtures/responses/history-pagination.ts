import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { readMarkdownDocument } from "../history-pagination.ts";

function respond(context: TranscriptContext) {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") {
    return last.toolName === "write"
      ? fauxAssistantMessage([fauxToolCall("read", { path: "paged-document.md" })], { stopReason: "toolUse" })
      : fauxAssistantMessage("MARKDOWN_FILE_READ_COMPLETE");
  }
  const text = last?.role === "user" && typeof last.content === "string" ? last.content : "";
  const blocks = last?.role === "user" && Array.isArray(last.content) ? last.content : [];
  if (
    (text + blocks.map((block) => (block.type === "text" ? block.text : "")).join("")).includes("E2E_READ_MARKDOWN")
  ) {
    return fauxAssistantMessage([fauxToolCall("write", { path: "paged-document.md", content: readMarkdownDocument })], {
      stopReason: "toolUse",
    });
  }
  return fauxAssistantMessage("你好，Pi Web UI 已收到消息。");
}

export default Array.from({ length: 8 }, () => respond);
