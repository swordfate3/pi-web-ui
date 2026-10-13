import { useSyncExternalStore } from "react";
import type { StreamdownTranslations } from "streamdown";
import { type MessageKey, messages } from "./messages";
import { readPreference, writePreference } from "./storage";

export type Language = "en" | "zh-CN";
export const LANGUAGE_STORAGE_KEY = "pi-web-ui-language";

export function resolveLanguage(stored: string | null, languages: readonly string[]): Language {
  if (stored === "en" || stored === "zh-CN") return stored;
  // Use the browser's highest-priority language, not any secondary language.
  return languages.find(Boolean)?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

let language = resolveLanguage(
  readPreference(LANGUAGE_STORAGE_KEY),
  typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language],
);
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getLanguage = (): Language => language;
const syncDocumentLanguage = () => {
  if (typeof document !== "undefined") document.documentElement.lang = language;
};
syncDocumentLanguage();

export function setLanguage(next: Language): void {
  if (next !== "en" && next !== "zh-CN") return;
  writePreference(LANGUAGE_STORAGE_KEY, next);
  if (language === next) return;
  language = next;
  syncDocumentLanguage();
  for (const listener of listeners) listener();
}

/** Subscribe only to display preferences, never the Pi/session store. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, () => "en");
}

/** Stable function identity: safe in long-lived handlers without reconnecting WebSocket effects. */
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  const template = language === "zh-CN" ? messages[key] : key;
  return values ? template.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match)) : template;
}

/** Explicit wire-to-display mappings only. Unknown extension values stay untouched. */
function wireLabel(value: string, known: readonly MessageKey[]): string {
  return known.includes(value as MessageKey) ? t(value as MessageKey) : value;
}
export function thinkingLabel(value: string): string {
  return wireLabel(value, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
}
export function connectionLabel(value: string): string {
  return wireLabel(value, ["connected", "connecting", "disconnected"]);
}
export function themeLabel(value: string): string {
  return wireLabel(value, ["system", "light", "dark"]);
}
export function dialogLabel(value: string): string {
  return wireLabel(value, ["select", "confirm", "input", "editor", "notify", "info", "warning", "error"]);
}

/** Streamdown 2.5's complete public translation surface; content and format names stay literal. */
export function streamdownTranslations(): StreamdownTranslations {
  return {
    close: t("Close"),
    copied: t("Copied"),
    copyCode: t("Copy Code"),
    copyLink: t("Copy link"),
    copyTable: t("Copy table"),
    copyTableAsCsv: t("Copy table as CSV"),
    copyTableAsMarkdown: t("Copy table as Markdown"),
    copyTableAsTsv: t("Copy table as TSV"),
    downloadDiagram: t("Download diagram"),
    downloadDiagramAsMmd: t("Download diagram as MMD"),
    downloadDiagramAsPng: t("Download diagram as PNG"),
    downloadDiagramAsSvg: t("Download diagram as SVG"),
    downloadFile: t("Download file"),
    downloadImage: t("Download image"),
    downloadTable: t("Download table"),
    downloadTableAsCsv: t("Download table as CSV"),
    downloadTableAsMarkdown: t("Download table as Markdown"),
    exitFullscreen: t("Exit fullscreen"),
    externalLinkWarning: t("You're about to visit an external website."),
    imageNotAvailable: t("Image not available"),
    mermaidFormatMmd: "MMD",
    mermaidFormatPng: "PNG",
    mermaidFormatSvg: "SVG",
    openExternalLink: t("Open external link?"),
    openLink: t("Open link"),
    tableFormatCsv: "CSV",
    tableFormatMarkdown: "Markdown",
    tableFormatTsv: "TSV",
    viewFullscreen: t("View fullscreen"),
  };
}
