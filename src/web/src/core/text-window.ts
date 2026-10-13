/** Bounded work: scan only the visible prefix, never split the entire output. */
export function textWindow(text: string, start = 0, maxLines = 12, maxChars = 4096) {
  let end = Math.min(text.length, start + Math.max(1, maxChars));
  let lines = 0;
  for (let index = start; index < end; index++) {
    if (text.charCodeAt(index) === 10 && ++lines >= maxLines) {
      end = index + 1;
      break;
    }
  }
  // Do not cut a UTF-16 surrogate pair between adjacent pages.
  const last = text.charCodeAt(end - 1);
  if (end < text.length && end > start + 1 && last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(start, end), start, end, hasMore: end < text.length };
}

export const HIGHLIGHT_MAX_CHARS = 24_000;
export const HIGHLIGHT_MAX_LINES = 400;
export const HIGHLIGHT_MAX_TOKENS = 6_000;
export const PLAIN_PAGE_CHARS = 16_000;
export const PLAIN_PAGE_LINES = 200;

export function canHighlight(code: string): boolean {
  return code.length <= HIGHLIGHT_MAX_CHARS && !textWindow(code, 0, HIGHLIGHT_MAX_LINES, HIGHLIGHT_MAX_CHARS).hasMore;
}

/** Exact, unambiguous key. Only size-eligible snippets should enter the cache. */
export function highlightKey(code: string, language: string): string {
  return JSON.stringify([language, code]);
}
