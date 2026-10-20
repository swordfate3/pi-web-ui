import assert from "node:assert/strict";
import test from "node:test";
import { math } from "@streamdown/math";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import remarkParse from "remark-parse";
import { Streamdown } from "streamdown";
import { unified } from "unified";
import { remarkTexMath } from "../src/web/src/core/markdown-math.ts";

const parser = unified().use(remarkParse).use(remarkTexMath);
function nodes(source: string) {
  const found: Array<{
    type: string;
    value?: string;
    data?: { hName?: string; hProperties?: { className?: string[] } };
  }> = [];
  function visit(node: { type: string; children?: unknown[] }) {
    found.push(node);
    for (const child of node.children ?? []) visit(child as typeof node);
  }
  visit(parser.parse(source));
  return found;
}
function render(source: string, mode: "streaming" | "static" = "streaming") {
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode,
        plugins: { math: { ...math, remarkPlugin: remarkTexMath } },
      },
      source,
    ),
  );
}

test("native TeX syntax produces inline/display math without changing dollar policy", () => {
  const tree = nodes(String.raw`Inline \(a_1 + \alpha\), display \[\frac{1}{2}\], $$x^2$$; $5 USD and $x$.`);
  const formulas = tree.filter((n) => n.type === "inlineMath");
  assert.deepEqual(
    formulas.map((n) => n.value),
    [String.raw`a_1 + \alpha`, String.raw`\frac{1}{2}`, "x^2"],
  );
  assert.equal(formulas[1].data?.hName, "pre");
  assert.ok(tree.some((n) => n.type === "text" && n.value?.includes("$5 USD and $x$")));
});

test("code spans, list fences, indentation, escapes and existing dollar math are protected", () => {
  for (const source of [
    "`\\(x\\)\\`",
    "- ```tex\n  \\[x\\]\n  ```",
    "    \\(x\\)",
    String.raw`\\(escaped\\)`,
    String.raw`\\[escaped\\]`,
  ])
    assert.equal(nodes(source).filter((n) => n.type === "inlineMath").length, 0, source);
  const existing = nodes(String.raw`$$\text{\(literal\)}$$`).filter((n) => n.type === "inlineMath");
  assert.equal(existing.length, 1);
  assert.equal(existing[0].value, String.raw`\text{\(literal\)}`);
});

test("multiline display math keeps CommonMark quote/list containers and indented body", () => {
  for (const source of ["\\[\n    \\frac{1}{2}\n\\]", "\\[\n\t\\frac{1}{2}\n\\]"]) {
    const formula = nodes(source).find((n) => n.type === "inlineMath");
    assert.equal(formula?.value, String.raw`\frac{1}{2}`);
  }
  for (const [source, container] of [
    [String.raw`> \[x^2\]`, "blockquote"],
    ["> \\[\n> x^2\n> \\]", "blockquote"],
    [String.raw`- \[x^2\]`, "listItem"],
    ["- outer\n  - \\[x^2\\]", "listItem"],
  ]) {
    const tree = parser.parse(source);
    const json = JSON.stringify(tree);
    assert.ok(json.includes(`"type":"${container}"`));
    assert.equal(nodes(source).find((n) => n.type === "inlineMath")?.value, "x^2");
    const html = render(source, "static");
    assert.match(
      html,
      container === "blockquote" ? /<blockquote[^>]*>[\s\S]*katex-display/ : /<li[^>]*>[\s\S]*katex-display/,
    );
  }
});

test("real Streamdown renders complete TeX in streaming/static modes and not unfinished spans", () => {
  for (const mode of ["streaming", "static"] as const) {
    const html = render(String.raw`Inline \(x^2\). Display \[y^2\]. Existing $$z^2$$. $5 USD.`, mode);
    assert.equal((html.match(/class="katex"/g) ?? []).length, 3);
    assert.match(html, /katex-display/);
    assert.match(html, /\$5 USD/);
    for (const partial of [String.raw`\(unfinished`, String.raw`\[unfinished`]) {
      const output = render(partial, mode);
      assert.doesNotMatch(output, /class="katex"/);
      assert.match(output, /unfinished/);
    }
  }
});

test("native math remains inside KaTeX's default untrusted rendering boundary", () => {
  const output = render(String.raw`\(\href{javascript:alert(1)}{click}\)`);
  assert.doesNotMatch(output, /href="javascript:/);
});

test("failed suffix cache is local to one parse and bounds many unmatched delimiters", { timeout: 5000 }, () => {
  for (const count of [1000, 2000, 4000, 8000]) {
    const source = String.raw`\(a `.repeat(count);
    assert.equal(nodes(source).filter((n) => n.type === "inlineMath").length, 0);
  }
  assert.equal(nodes(String.raw`\(a\)`).find((n) => n.type === "inlineMath")?.value, "a");
  assert.equal(nodes(String.raw`\[a\]`).find((n) => n.type === "inlineMath")?.value, "a");
  assert.equal(nodes(String.raw`\(missing \[complete\]`).filter((n) => n.type === "inlineMath").length, 1);
});
