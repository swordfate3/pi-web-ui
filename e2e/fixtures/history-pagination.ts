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
  entries.push(message("paging-125", markdown, 125));
  entries.push(message("paging-126", "## PAGING_LATEST_MARKER\n\n最新结果", 126));
  return entries;
}
