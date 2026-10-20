import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedAsyncCache } from "../src/web/src/core/bounded-async-cache.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import {
  canHighlight,
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINES,
  highlightKey,
  PLAIN_PAGE_CHARS,
  PLAIN_PAGE_LINES,
  textWindow,
} from "../src/web/src/core/text-window.ts";
import { toolText } from "../src/web/src/core/tool-text.ts";

test("tool preview bounds both giant single lines and multiline output without losing raw data", () => {
  const code = "x".repeat(1_000_000);
  const output = toolText(code);
  assert.equal(output.code, code);
  assert.equal(output.preview.length, 4096);
  assert.equal(output.isLong, true);
  const multiline = toolText(Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n"));
  assert.equal(multiline.preview, `${Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n")}\n`);
  assert.equal(multiline.isLong, true);
});

test("immutable tool objects reuse serialization across close/reopen; changed objects do not", () => {
  let conversions = 0;
  const source = {
    toJSON: () => {
      conversions++;
      return { message: "result" };
    },
  };
  const first = toolText(source);
  assert.equal(toolText(source), first);
  assert.equal(conversions, 1);
  assert.equal(first.code, JSON.stringify({ message: "result" }, null, 2));
  assert.notEqual(toolText({ message: "changed" }), first);
  assert.equal(toolText("error\n".repeat(20)).isLong, true);
});

test("plain pages reconstruct the entire original output, bounded by characters and lines", () => {
  for (const code of [
    "x".repeat(100_000),
    "line\n".repeat(50_000),
    `${"x".repeat(PLAIN_PAGE_CHARS - 1)}😀\n${"z".repeat(40_000)}`,
  ]) {
    const pages: string[] = [];
    let start = 0;
    while (start < code.length) {
      const page = textWindow(code, start, PLAIN_PAGE_LINES, PLAIN_PAGE_CHARS);
      assert.ok(page.end > start);
      assert.ok(page.text.length <= PLAIN_PAGE_CHARS);
      assert.ok((page.text.match(/\n/g) ?? []).length <= PLAIN_PAGE_LINES);
      assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));
      pages.push(page.text);
      start = page.end;
    }
    assert.equal(pages.join(""), code);
  }
});

test("highlighter rejects either large dimension; exact keys distinguish equal-sized middle changes", () => {
  assert.equal(canHighlight("const value = 1"), true);
  assert.equal(canHighlight("x".repeat(HIGHLIGHT_MAX_CHARS + 1)), false);
  assert.equal(canHighlight("x\n".repeat(HIGHLIGHT_MAX_LINES + 1)), false);
  const prefix = "x".repeat(100);
  const suffix = "y".repeat(100);
  assert.notEqual(highlightKey(`${prefix}a${suffix}`, "json"), highlightKey(`${prefix}b${suffix}`, "json"));
  assert.notEqual(highlightKey("same", "json"), highlightKey("same", "typescript"));
});

function cache(maxEntries = 2, maxWeight = 10, maxPending = 2) {
  return createBoundedAsyncCache<string>({ maxEntries, maxWeight, maxPending, weight: (value) => value.length });
}

test("highlight work deduplicates inflight, caches successful results, and retries failures", async () => {
  const subject = cache();
  let loads = 0;
  const loader = async () => {
    loads++;
    return "value";
  };
  const first = subject.load("key", loader);
  assert.equal(subject.load("key", loader), first);
  assert.equal(await first, "value");
  assert.equal(await subject.load("key", loader), "value");
  assert.equal(loads, 1);
  await assert.rejects(
    subject.load("failure", async () => {
      throw new Error("failed");
    }),
  );
  assert.equal(await subject.load("failure", async () => "retry"), "retry");
});

test("result LRU respects both entry and weight budgets, oversized results are not retained", async () => {
  const subject = cache();
  await subject.load("a", async () => "1111");
  await subject.load("b", async () => "2222");
  assert.equal(subject.get("a"), "1111"); // touch a; b is now oldest
  await subject.load("c", async () => "3333");
  assert.equal(subject.get("b"), undefined);
  assert.equal(subject.get("a"), "1111");
  await subject.load("d", async () => "44444444");
  assert.equal(subject.get("a"), undefined);
  assert.equal(subject.get("c"), undefined);
  assert.equal(await subject.load("huge", async () => "x".repeat(11)), "x".repeat(11));
  assert.equal(subject.get("huge"), undefined);
});

test("inflight budget degrades excess requests without invoking or retaining their loader", async () => {
  const subject = cache(2, 10, 1);
  let finish: (value: string) => void = () => {};
  const active = subject.load(
    "a",
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  let excessLoads = 0;
  assert.equal(
    await subject.load("b", async () => {
      excessLoads++;
      return "b";
    }),
    undefined,
  );
  assert.equal(excessLoads, 0);
  finish("a");
  await active;
  assert.equal(await subject.load("b", async () => "b"), "b");
});

test("a single tool toggle preserves every other chat item reference for shallow row memoization", () => {
  let state: ReturnType<typeof createSessionSlice>;
  const set = (patch: unknown) => {
    Object.assign(state, typeof patch === "function" ? patch(state) : patch);
  };
  state = createSessionSlice(set as never, (() => state) as never, {} as never);
  const items = Array.from({ length: 200 }, (_, index) => ({
    kind: "tool" as const,
    id: `tool-${index}`,
    name: "read",
    state: "output-available" as const,
    output: "result",
    input: { path: "file.txt" },
    open: false,
  }));
  state.items = items;
  state.toggleTool("tool-100", true);
  assert.notEqual(state.items, items);
  for (let i = 0; i < items.length; i++) {
    if (i === 100) {
      assert.notEqual(state.items[i], items[i]);
      assert.equal(state.items[i].kind === "tool" && state.items[i].open, true);
    } else assert.equal(state.items[i], items[i]);
  }
});
