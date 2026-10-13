import { formatTime } from "./format";
import { t } from "./i18n";
import type { MessageKey } from "./messages";

/** Store a descriptor, not a translated snapshot, for frontend-owned notices/errors.
 * Raw strings from Pi are never looked up or guessed, even if they equal a dictionary key.
 */
export type UiText = string | { key: MessageKey; values?: Record<string, UiTextValue> };
type UiTextValue = UiText | number | UiRelativeTime;
interface UiRelativeTime {
  kind: "relative-time";
  timestamp?: string;
  fallback: UiText;
}
/** Keep timestamps as explicit interpolation descriptors, never guess from raw strings. */
export function uiRelativeTime(timestamp?: string, fallback: UiText = ""): UiRelativeTime {
  return { kind: "relative-time", timestamp, fallback };
}
export function uiText(key: MessageKey, values?: Record<string, UiTextValue>): Exclude<UiText, string> {
  return { key, values };
}
export function renderUiText(value: UiText): string {
  if (typeof value === "string") return value;
  return t(
    value.key,
    value.values &&
      Object.fromEntries(Object.entries(value.values).map(([key, part]) => [key, renderUiTextValue(part)])),
  );
}
function renderUiTextValue(value: UiTextValue): string | number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" && "kind" in value) {
    return formatTime(value.timestamp) || renderUiText(value.fallback);
  }
  return renderUiText(value);
}
export class UiError extends Error {
  readonly uiText: UiText;
  constructor(value: UiText) {
    // Preserve an English diagnostic for logs and existing transport error checks.
    super(typeof value === "string" ? value : value.key);
    this.name = "UiError";
    this.uiText = value;
  }
}
export function errorUiText(error: unknown, fallback: UiText): UiText {
  return error instanceof UiError ? error.uiText : error instanceof Error ? error.message : fallback;
}
