import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as historyApi from "../extensions/session-history.ts";

const scope = { sessionId: "s", runtimeId: "r", leafId: "entry" };
const request = { sessionId: "s", runtimeId: "r", entryId: "entry" };
const read = historyApi.readEntryDetail;

test("markdown detail renders assistant text alongside native thinking without losing either", () => {
  const thinking = "Check the document before answering.";
  const text = "# Rendered answer\n\n| Name | Value |\n| --- | --- |\n| complete | yes |";
  const branch = [
    {
      id: "entry",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking },
          { type: "text", text },
        ],
      },
    },
  ];
  const result = read(branch, scope, { ...request, presentation: "markdown" }, "1");
  assert.equal(result.format, "markdown");
  assert.equal(result.text, `Thinking:\n${thinking}\n\n${text}`);
  assert.equal(result.nextCursor, null);
});

test("markdown detail accepts closing fences and display math at EOF without a final newline", () => {
  for (const ending of [
    "```ts\nconst answer = 42;\n```",
    "~~~md\n# Literal heading\n~~~",
    "$$\nx^2\n$$",
    "\\[\nx^2\n\\]",
  ]) {
    const branch = [
      { id: "entry", type: "message", message: { role: "toolResult", content: [{ type: "text", text: ending }] } },
    ];
    const result = read(branch, scope, { ...request, presentation: "markdown" }, "1");
    assert.equal(result.format, "markdown", ending);
    assert.equal(result.text, ending);
    assert.equal(result.nextCursor, null);
  }
});

test("markdown detail still treats unfinished fences and structured tool calls as source", () => {
  for (const content of [
    [{ type: "text", text: "```ts\nconst unfinished = true;" }],
    [{ type: "text", text: "$$\nx^2" }],
    [{ type: "text", text: "```ts" }],
    [{ type: "text", text: "$$" }],
    [{ type: "toolCall", name: "write", arguments: { path: "document.md", content: "# Document" } }],
  ]) {
    const branch = [{ id: "entry", type: "message", message: { role: "assistant", content } }];
    assert.equal(read(branch, scope, { ...request, presentation: "markdown" }, "1").format, "text");
  }
});

test("detail chunks traverse Unicode and escapes stably within the complete envelope without changing source", () => {
  const text = '秘密😀\n"\\\u0001'.repeat(30_000);
  const branch = [{ id: "entry", type: "message", message: { role: "assistant", content: text } }];
  const hash = () => createHash("sha256").update(JSON.stringify(branch)).digest("hex");
  const before = hash();
  let cursor: string | undefined;
  let collected = "";
  let count = 0;
  do {
    const params = { ...request, ...(cursor ? { cursor } : {}) };
    const chunk = read(branch, scope, params, "\u0001".repeat(512));
    assert.deepEqual(chunk, read(branch, scope, params, "\u0001".repeat(512)));
    assert.ok(
      Buffer.byteLength(JSON.stringify({ type: "res", id: "\u0001".repeat(512), ok: true, result: chunk })) <=
        64 * 1024,
    );
    assert.equal(chunk.entryId, "entry");
    assert.equal(chunk.sessionId, "s");
    assert.equal(chunk.runtimeId, "r");
    assert.ok(chunk.text.length > 0);
    assert.ok(!chunk.text.includes("\ufffd"));
    assert.notEqual(chunk.nextCursor, cursor);
    collected += chunk.text;
    cursor = chunk.nextCursor ?? undefined;
    assert.ok(++count < 200);
  } while (cursor);
  assert.ok(count > 1);
  assert.equal(collected, text);
  assert.equal(hash(), before);
});

test("detail cursors reject cross-session/runtime/branch, mutations, bad offsets and non-branch entries", () => {
  const branch = [{ id: "entry", type: "message", message: { role: "user", content: "x".repeat(100_000) } }];
  const cursor = read(branch, scope, request, "1").nextCursor;
  assert.ok(cursor);
  for (const params of [
    { ...request, sessionId: "other" },
    { ...request, runtimeId: "other" },
    { ...request, entryId: "outside" },
    { ...request, cursor: "-1" },
    { ...request, cursor: "x".repeat(2000) },
    { ...request, cursor: `${cursor}x` },
  ])
    assert.throws(() => read(branch, scope, params, "1"));
  assert.throws(() => read(branch, { ...scope, leafId: "changed" }, { ...request, cursor }, "1"));
  assert.throws(() => read(branch, { ...scope, runtimeId: "new" }, { ...request, runtimeId: "new", cursor }, "1"));
  branch[0].message.content += "changed";
  assert.throws(() => read(branch, scope, { ...request, cursor }, "1"));
});

test("details render readable text, thinking and tool arguments but never image/binary bodies", () => {
  const branch = [
    {
      id: "entry",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "Reasoning" },
          {
            type: "toolCall",
            id: "call",
            name: "write",
            arguments: { path: "file.md", content: "Readable tool body" },
          },
          { type: "image", data: "BASE64_SECRET", mimeType: "image/png" },
        ],
      },
    },
  ];
  const result = read(branch, scope, request, "1");
  for (const text of ["Hello", "Reasoning", "write", "file.md", "Readable tool body"])
    assert.ok(result.text.includes(text));
  assert.ok(!result.text.includes("BASE64_SECRET"));
  assert.ok(!result.text.includes('"type":'));
  assert.equal(result.nextCursor, null);
  assert.ok(!Object.hasOwn(result, "format"));
});

test("markdown presentation stops before the next Markdown block when it would exceed the wire budget", () => {
  const first = `${"a".repeat(56 * 1024)}\n\n`;
  const second = `${"b".repeat(20 * 1024)}\n`;
  const branch = [{ id: "entry", type: "message", message: { role: "assistant", content: first + second } }];

  const firstPage = read(branch, scope, { ...request, presentation: "markdown" }, "1");

  assert.equal(firstPage.format, "markdown");
  assert.equal(firstPage.text, first);
  assert.ok(firstPage.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify({ type: "res", id: "1", ok: true, result: firstPage })) <= 64 * 1024);

  const secondPage = read(branch, scope, { ...request, presentation: "markdown", cursor: firstPage.nextCursor }, "1");
  assert.equal(secondPage.format, "markdown");
  assert.equal(secondPage.text, second);
  assert.equal(secondPage.nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify({ type: "res", id: "1", ok: true, result: secondPage })) <= 64 * 1024);
});

test("markdown wire budgeting reserves the longer format label with escaped and multibyte text", () => {
  const requestId = "\u0001".repeat(512);
  const maxCursorLength =
    Buffer.from(JSON.stringify({ fence: "0".repeat(64), offset: Number.MAX_SAFE_INTEGER })).toString("base64url")
      .length + 44;
  const textBudget =
    64 * 1024 -
    Buffer.byteLength(
      JSON.stringify({
        type: "res",
        id: requestId,
        ok: true,
        result: {
          sessionId: "s",
          runtimeId: "r",
          entryId: "entry",
          text: "",
          nextCursor: "x".repeat(maxCursorLength),
          format: "text",
        },
      }),
    );
  const textBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;
  const suffix = "\n\n";
  const token = '\u0001"\\秘密😀';
  let content = "";
  while (textBytes(content + token + suffix) <= textBudget) content += token;
  while (textBytes(`${content}a${suffix}`) <= textBudget) content += "a";
  content += suffix;
  assert.equal(textBytes(content), textBudget);

  const branch = [{ id: "entry", type: "message", message: { role: "assistant", content } }];
  let cursor: string | undefined;
  let collected = "";
  let pages = 0;
  do {
    const result = read(
      branch,
      scope,
      { ...request, presentation: "markdown", ...(cursor ? { cursor } : {}) },
      requestId,
    );
    assert.ok(Buffer.byteLength(JSON.stringify({ type: "res", id: requestId, ok: true, result })) <= 64 * 1024);
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({
          type: "res",
          id: requestId,
          ok: true,
          result: { ...result, nextCursor: "x".repeat(maxCursorLength) },
        }),
      ) <=
        64 * 1024,
    );
    assert.ok(!result.text.includes("\ufffd"));
    collected += result.text;
    cursor = result.nextCursor ?? undefined;
    assert.ok(++pages < 4);
  } while (cursor);
  assert.equal(collected, content);
});

test("markdown paging labels every chunk of an oversized fenced block as text before resuming Markdown", () => {
  const before = "Before\n\n";
  const fenced = `\`\`\`ts\n${"x".repeat(140 * 1024)}\n\`\`\`\n`;
  const after = "\n# After\n\nDone\n";
  const source = before + fenced + after;
  const branch = [{ id: "entry", type: "message", message: { role: "assistant", content: source } }];
  const pages: Array<{ start: number; end: number; format: "markdown" | "text"; text: string }> = [];
  let cursor: string | undefined;
  let collected = "";

  do {
    const result = read(branch, scope, { ...request, presentation: "markdown", ...(cursor ? { cursor } : {}) }, "1");
    assert.ok(result.format === "markdown" || result.format === "text");
    assert.ok(Buffer.byteLength(JSON.stringify({ type: "res", id: "1", ok: true, result })) <= 64 * 1024);
    pages.push({
      start: collected.length,
      end: collected.length + result.text.length,
      format: result.format,
      text: result.text,
    });
    collected += result.text;
    cursor = result.nextCursor ?? undefined;
    assert.ok(pages.length < 10);
  } while (cursor);

  assert.equal(collected, source);
  const fencedStart = before.length;
  const fencedEnd = before.length + fenced.length;
  const fencedPages = pages.filter((page) => page.start < fencedEnd && page.end > fencedStart);
  assert.ok(fencedPages.length > 1);
  for (const page of fencedPages) assert.equal(page.format, "text");
  assert.ok(pages.some((page) => page.start >= fencedEnd && page.format === "markdown"));
});

test("markdown paging keeps native bracket display math intact across internal blank lines", () => {
  const before = "Before\n\n";
  const math = `\\[\n${"m".repeat(35 * 1024)}\n\n${"n".repeat(35 * 1024)}\n\\]\n`;
  const after = "\nAfter\n";
  const source = before + math + after;
  const branch = [{ id: "entry", type: "message", message: { role: "assistant", content: source } }];
  const pages: Array<{ start: number; end: number; format: "markdown" | "text" }> = [];
  let cursor: string | undefined;
  let collected = "";

  do {
    const result = read(branch, scope, { ...request, presentation: "markdown", ...(cursor ? { cursor } : {}) }, "1");
    pages.push({
      start: collected.length,
      end: collected.length + result.text.length,
      format: result.format ?? "text",
    });
    collected += result.text;
    cursor = result.nextCursor ?? undefined;
    assert.ok(pages.length < 8);
  } while (cursor);

  assert.equal(collected, source);
  const mathStart = before.length;
  const mathEnd = before.length + math.length;
  const mathPages = pages.filter((page) => page.start < mathEnd && page.end > mathStart);
  assert.ok(mathPages.length > 1);
  for (const page of mathPages) assert.equal(page.format, "text");
  assert.ok(pages.some((page) => page.start >= mathEnd && page.format === "markdown"));
});

test("markdown paging falls back to text for oversized display math and tables", () => {
  const cases = [
    ["math", "user", `$$\n${"m".repeat(70 * 1024)}\n$$\n`],
    ["table", "toolResult", `${`| ${"t".repeat(1024)} | value |\n`.repeat(70)}`],
  ] as const;

  for (const [kind, role, block] of cases) {
    const before = "Before\n\n";
    const after = "\nAfter\n";
    const source = before + block + after;
    const branch = [{ id: "entry", type: "message", message: { role, content: source } }];
    const pages: Array<{ start: number; end: number; format: "markdown" | "text" }> = [];
    let cursor: string | undefined;
    let collected = "";

    do {
      const result = read(branch, scope, { ...request, presentation: "markdown", ...(cursor ? { cursor } : {}) }, "1");
      assert.ok(
        result.format === "markdown" || result.format === "text",
        `${kind} should return a presentation format`,
      );
      pages.push({ start: collected.length, end: collected.length + result.text.length, format: result.format });
      collected += result.text;
      cursor = result.nextCursor ?? undefined;
      assert.ok(pages.length < 10);
    } while (cursor);

    assert.equal(collected, source);
    const blockStart = before.length;
    const blockEnd = before.length + block.length;
    for (const page of pages.filter((page) => page.start < blockEnd && page.end > blockStart))
      assert.equal(page.format, "text", `${kind} chunks should not claim Markdown integrity`);
    assert.ok(
      pages.some((page) => page.start >= blockEnd && page.format === "markdown"),
      `${kind} should resume Markdown`,
    );
  }
});
