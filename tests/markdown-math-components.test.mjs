import "./register-tsx.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { MessageResponse } = await import("../src/web/components/ai-elements/message.tsx");
const { Reasoning, ReasoningContent } = await import("../src/web/components/ai-elements/reasoning.tsx");

const renderers = {
  message: (source) => renderToStaticMarkup(createElement(MessageResponse, null, source)),
  reasoning: (source) =>
    renderToStaticMarkup(createElement(Reasoning, { open: true }, createElement(ReasoningContent, null, source))),
};

for (const [name, render] of Object.entries(renderers)) {
  test(`${name} renders native inline and display TeX as well as existing dollar math`, () => {
    const html = render(String.raw`Inline \(a_1 + \alpha\). Display \[\frac{1}{2}\]. Existing $$x^2$$.`);
    assert.equal((html.match(/class="katex"/g) ?? []).length, 3);
    assert.match(html, /katex-display/);
  });

  test(`${name} preserves code, prices and incomplete TeX`, () => {
    const html = render("`\\(ignored\\)` and $5 USD. \\(unfinished");
    assert.doesNotMatch(html, /class="katex"/);
    assert.match(html, /\\\(ignored\\\)/);
    assert.match(html, /\$5 USD/);
    assert.match(html, /unfinished/);
  });

  test(`${name} does not trust unsafe links inside native TeX`, () => {
    const html = render(String.raw`\(\href{javascript:alert(1)}{click}\)`);
    assert.doesNotMatch(html, /href="javascript:/);
  });
}
