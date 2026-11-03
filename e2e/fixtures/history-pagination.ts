export function paginationEntries(now: number) {
  const message = (id: string, text: string, index: number) => ({
    type: "message",
    id,
    parentId: index ? `paging-${index - 1}` : null,
    timestamp: new Date(now - 10_000 + index).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "faux",
      model: "faux-1",
      timestamp: now - 10_000 + index,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: "stop",
    },
  });
  const entries = Array.from({ length: 125 }, (_, index) =>
    message(`paging-${index}`, `## ANSWER_${index}\n\n合成历史内容 ${index}`, index),
  );
  const markdown = Array.from(
    { length: 100 },
    (_, i) =>
      `## Result section ${i}\n\n${"中文分页正文😀，应当完整保留。".repeat(65)}\n\n` +
      "```ts\nconst example = '完整代码';\n```\n\n| 列一 | 列二 |\n| --- | --- |\n| 完整 | 表格 |\n\n$$x^2 + y^2 = z^2$$\n\n",
  ).join("");
  const longAnswer = message("paging-125", markdown, 125);
  Object.assign(longAnswer.message, {
    content: [
      { type: "thinking", thinking: "Verify the complete Markdown result before presenting it." },
      { type: "text", text: markdown },
    ],
  });
  entries.push(longAnswer);
  entries.push(message("paging-126", "## PAGING_LATEST_MARKER\n\n最新结果", 126));
  return entries;
}

export const readMarkdownDocument = [
  Array.from(
    { length: 24 },
    (_, index) =>
      `# File section ${index}\n\n${"真实 Markdown 文件，保留标题和正文。".repeat(18)}\n\n` +
      "| Name | Value |\n| --- | --- |\n| complete | yes |\n\n$$x^2 + y^2 = z^2$$\n\n",
  ).join(""),
  "```ts\nconst eofMarker = 'FILE_EOF_CODE';\n```",
].join("");
