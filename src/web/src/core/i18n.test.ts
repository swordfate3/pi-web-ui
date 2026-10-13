import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTranslations } from "streamdown";
import { buildConversationTreeItems } from "../components/pi-web-ui/conversation-tree-model";
import {
  connectionLabel,
  getLanguage,
  resolveLanguage,
  setLanguage,
  streamdownTranslations,
  t,
  thinkingLabel,
} from "./i18n";
import { messages } from "./messages";
import { readPreference, writePreference } from "./storage";
import { errorUiText, renderUiText, UiError, uiRelativeTime, uiText } from "./ui-text";

// Run: node --import ./tests/register-ts.mjs --test src/web/src/core/i18n.test.ts
// Pure unit tests: no Pi process, user sessions, browser or network required.
test("preference validation and highest-priority browser language", () => {
  assert.equal(resolveLanguage("en", ["zh-CN"]), "en");
  assert.equal(resolveLanguage("zh-CN", ["en-US"]), "zh-CN");
  for (const stored of [null, "", "zh", "invalid"]) {
    assert.equal(resolveLanguage(stored, ["zh-TW", "en"]), "zh-CN");
    assert.equal(resolveLanguage(stored, ["en-US", "zh-CN"]), "en");
    assert.equal(resolveLanguage(stored, []), "en");
  }
  assert.equal(resolveLanguage(null, ["ZH-hans"]), "zh-CN");
});

test("switching translates owned descriptors, never raw errors or interpolation values", () => {
  const notice = uiText("Extension error: {error}", { error: "Server error" });
  const error = new UiError(uiText("Command failed"));
  try {
    setLanguage("zh-CN");
    assert.equal(t("Settings"), "设置");
    assert.equal(renderUiText(notice), "扩展错误：Server error");
    assert.equal(renderUiText(errorUiText(error, "fallback")), "命令失败");
    assert.equal(renderUiText(errorUiText(new Error("Command failed"), "fallback")), "Command failed");
    assert.equal(renderUiText("Settings"), "Settings");
    assert.equal(t("Model selected: {model}", { model: "provider/Settings" }), "已选择模型：provider/Settings");
    assert.equal(thinkingLabel("high"), "高");
    assert.equal(thinkingLabel("extension-level"), "extension-level");
    assert.equal(connectionLabel("connected"), "已连接");
    setLanguage("en");
    assert.equal(t("Settings"), "Settings");
    assert.equal(renderUiText(errorUiText(error, "fallback")), "Command failed");
    assert.equal(renderUiText(notice), "Extension error: Server error");
    assert.equal(thinkingLabel("high"), "high");
  } finally {
    setLanguage("en");
  }
});

test("storage denial is safe and document language still follows in-memory changes", () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const root = { lang: "en" };
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("denied");
      },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
    assert.equal(readPreference("pi-web-ui-language"), null);
    assert.doesNotThrow(() => writePreference("pi-web-ui-language", "zh-CN"));
    setLanguage("zh-CN");
    assert.equal(getLanguage(), "zh-CN");
    assert.equal(root.lang, "zh-CN");
    setLanguage("en");
    assert.equal(root.lang, "en");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    setLanguage("zh-CN");
    assert.equal(values.get("pi-web-ui-language"), "zh-CN");
    // Runtime callers cannot persist invalid preferences either.
    setLanguage("invalid" as never);
    assert.equal(values.get("pi-web-ui-language"), "zh-CN");
  } finally {
    setLanguage("en");
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("dictionary placeholders stay aligned in both languages", () => {
  for (const [key, value] of Object.entries(messages)) {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(value), placeholders(key), key);
    assert.ok(value.trim().length, key);
  }
});

test("tree labels translate while chat content, IDs and tool wire names remain intact", () => {
  try {
    const tree = [
      {
        entry: { id: "raw", type: "message", message: { role: "user", content: "Settings /path/file.md" } },
        children: [],
      },
      { entry: { id: "empty", type: "message", message: { role: "user", content: "" } }, children: [] },
    ];
    setLanguage("zh-CN");
    const result = buildConversationTreeItems({ tree, leafId: "empty", collapsedIds: new Set(), searchQuery: "" });
    assert.equal(result.items.find((item) => item.id === "raw")?.text, "Settings /path/file.md");
    assert.equal(result.items.find((item) => item.id === "empty")?.id, "empty");
    assert.equal(result.items.find((item) => item.id === "empty")?.text, "用户消息");
  } finally {
    setLanguage("en");
  }
});

test("Streamdown translations cover the installed API and switch all supported controls", () => {
  const formatKeys = new Set([
    "mermaidFormatMmd",
    "mermaidFormatPng",
    "mermaidFormatSvg",
    "tableFormatCsv",
    "tableFormatMarkdown",
    "tableFormatTsv",
  ]);
  try {
    setLanguage("en");
    assert.deepEqual(streamdownTranslations(), defaultTranslations);
    setLanguage("zh-CN");
    const translated = streamdownTranslations();
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(defaultTranslations).sort());
    for (const key of Object.keys(defaultTranslations) as (keyof typeof defaultTranslations)[]) {
      if (formatKeys.has(key)) assert.equal(translated[key], defaultTranslations[key], key);
      else assert.notEqual(translated[key], defaultTranslations[key], key);
    }
    assert.equal(translated.copyCode, "复制代码");
    assert.equal(translated.downloadFile, "下载文件");
    assert.equal(translated.exitFullscreen, "退出全屏");
    assert.equal(translated.openExternalLink, "打开外部链接？");
    assert.equal(translated.copyTableAsMarkdown, "将表格复制为 Markdown");
    assert.equal(translated.downloadDiagramAsSvg, "将图表下载为 SVG");
    setLanguage("en");
    assert.deepEqual(streamdownTranslations(), defaultTranslations);
  } finally {
    setLanguage("en");
  }
});

test("existing branch notices format relative times and dates only when displayed", (context) => {
  const now = Date.UTC(2026, 5, 15, 12);
  context.mock.method(Date, "now", () => now);
  const key = "Branching from {time}. Previous branch is preserved in this session.";
  const notice = (timestamp?: string) =>
    uiText(key, {
      time: uiRelativeTime(timestamp, uiText("selected message")),
    });
  try {
    // Create once in English. The same descriptors must translate in both directions.
    setLanguage("en");
    const dates = [3, 10].map((days) => new Date(now - days * 86400000));
    const cases = [
      { value: notice(new Date(now).toISOString()), en: "Just now", zh: "刚刚" },
      { value: notice(new Date(now - 5 * 60000).toISOString()), en: "5m ago", zh: "5 分钟前" },
      { value: notice(new Date(now - 2 * 3600000).toISOString()), en: "2h ago", zh: "2 小时前" },
      { value: notice(new Date(now - 86400000).toISOString()), en: "Yesterday", zh: "昨天" },
      ...dates.map((date, index) => {
        const options: Intl.DateTimeFormatOptions =
          index === 0 ? { weekday: "long" } : { month: "short", day: "numeric" };
        return {
          value: notice(date.toISOString()),
          en: date.toLocaleDateString("en", options),
          zh: date.toLocaleDateString("zh-CN", options),
        };
      }),
      ...[undefined, "", "invalid"].map((timestamp) => ({
        value: notice(timestamp),
        en: "selected message",
        zh: "所选消息",
      })),
    ];
    for (const language of ["en", "zh-CN", "en"] as const) {
      setLanguage(language);
      for (const { value, en, zh } of cases) {
        const time = language === "en" ? en : zh;
        assert.equal(renderUiText(value), t(key, { time }));
      }
    }
    // The descriptor also ages on subsequent renders; it is not a translated snapshot.
    context.mock.method(Date, "now", () => now + 5 * 60000);
    assert.equal(renderUiText(cases[0].value), t(key, { time: "5m ago" }));
    setLanguage("zh-CN");
    const raw = "Just now Settings https://example.com/Settings `const Settings = 1`";
    assert.equal(renderUiText(uiText(key, { time: raw })), t(key, { time: raw }));
  } finally {
    setLanguage("en");
  }
});
