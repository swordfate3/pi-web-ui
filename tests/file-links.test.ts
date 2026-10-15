import assert from "node:assert/strict";
import test from "node:test";
import { fileDownloadUrl, fileLinkPath, type MarkdownNode, remarkFileLinks } from "../src/web/src/core/file-links.ts";

const resume = "documents/求职/计算机硕士秋招简历-优化版.pdf";

test("Chinese paths in bold text and inline code become local file links without changing labels", () => {
  const tree: MarkdownNode = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "text", value: "已生成：" },
          { type: "strong", children: [{ type: "text", value: resume }] },
          { type: "text", value: "，还可以下载 output/code.zip。" },
          { type: "inlineCode", value: "/workspace/output/chart.png" },
        ],
      },
    ],
  };
  remarkFileLinks()(tree);
  const children = tree.children?.[0].children ?? [];
  const bold = children[1].children?.[0];
  assert.ok(bold);
  assert.equal(bold.type, "link");
  assert.equal(fileLinkPath(bold.url), resume);
  assert.equal(bold.children?.[0].value, resume);
  assert.equal(fileLinkPath(children[3].url), "output/code.zip");
  assert.equal(fileLinkPath(children[5].url), "/workspace/output/chart.png");
});

test("explicit relative and encoded file links are converted but external links, images and code blocks stay intact", () => {
  const external = { type: "link", url: "https://example.org/report.pdf", children: [{ type: "text", value: "web" }] };
  const image = { type: "image", url: "output/photo.png", alt: "photo" };
  const code = { type: "code", value: resume };
  const tree: MarkdownNode = {
    type: "root",
    children: [
      { type: "link", url: `./${encodeURI(resume)}`, children: [{ type: "text", value: "下载简历" }] },
      external,
      image,
      code,
    ],
  };
  remarkFileLinks()(tree);
  assert.equal(fileLinkPath(tree.children?.[0].url), resume);
  assert.deepEqual(tree.children?.[1], external);
  assert.deepEqual(tree.children?.[2], image);
  assert.deepEqual(tree.children?.[3], code);
});

test("reference link labels stay text while local definitions become download links", () => {
  const reference: MarkdownNode = { type: "linkReference", children: [{ type: "text", value: resume }] };
  const tree: MarkdownNode = { type: "root", children: [reference, { type: "definition", url: resume }] };
  remarkFileLinks()(tree);
  assert.equal(reference.children?.[0].type, "text");
  assert.equal(fileLinkPath(tree.children?.[1].url), resume);
});

test("paths cannot manufacture network, script, traversal or control-character download links", () => {
  for (const input of [
    "https://example.org/a.pdf",
    "//example.org/a.pdf",
    "javascript:alert(1)",
    "../secret.pdf",
    "a/../../x.pdf",
    "#section",
    "a\u0000.pdf",
  ]) {
    const tree = {
      type: "root",
      children: [{ type: "link", url: input, children: [{ type: "text", value: "file" }] }],
    };
    remarkFileLinks()(tree);
    assert.equal(fileLinkPath(tree.children[0].url), null, input);
  }
});

test("attachment URLs stay under the current Hub session and reject forged server responses", () => {
  const response = {
    token: "36e968c6-d72a-431a-aa56-61f1d62d9b68",
    filename: "计算机硕士秋招简历-优化版.pdf",
    size: 123,
    downloadUrl: "/api/downloads/36e968c6-d72a-431a-aa56-61f1d62d9b68",
  };
  assert.equal(
    fileDownloadUrl(response, "https://pi.example.org", "/s/abc/"),
    "https://pi.example.org/s/abc/api/downloads/36e968c6-d72a-431a-aa56-61f1d62d9b68",
  );
  assert.throws(() =>
    fileDownloadUrl({ ...response, downloadUrl: "https://evil.example/file" }, "https://pi.example.org", "/s/abc/"),
  );
  assert.throws(() => fileDownloadUrl({ ...response, filename: "../bad.pdf" }, "https://pi.example.org"));
});
