import { textWindow } from "./text-window";

export type ToolText = { code: string; preview: string; isLong: boolean };

// Raw tool objects are immutable store values. Weak keys retain no historical
// sessions and let re-opening a collapsed tool reuse serialization and preview.
const serializedObjects = new WeakMap<object, ToolText>();

export function toolText(value: unknown): ToolText {
  if (value !== null && typeof value === "object") {
    const cached = serializedObjects.get(value);
    if (cached) return cached;
  }
  const code = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "undefined");
  const preview = textWindow(code);
  const result = { code, preview: preview.text, isLong: preview.hasMore };
  if (value !== null && typeof value === "object") serializedObjects.set(value, result);
  return result;
}
