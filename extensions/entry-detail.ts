import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { jsonTextPrefix } from "./bounded-json.ts";
import type { HistoryEntry } from "./session-history.ts";

type Scope = { sessionId: string; runtimeId: string; leafId: string | null };
const secret = randomBytes(32);
const fail = (): never => {
  throw new Error("Entry detail is unavailable or its cursor is stale. Reopen the preview.");
};
const identity = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

// Hash the persisted value incrementally, including omitted metadata/binary. No
// full serialization, whole-entry copy or retained revision/body cache.
function revision(entry: HistoryEntry): string {
  const hash = createHash("sha256");
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 64) fail();
    if (typeof value === "string") {
      hash.update(`s${value.length}:`);
      // UTF-16 code units keep even unpaired surrogate changes revision-visible.
      for (let i = 0; i < value.length; i += 4096) hash.update(Buffer.from(value.slice(i, i + 4096), "utf16le"));
    } else if (value && typeof value === "object") {
      if (seen.has(value)) fail();
      seen.add(value);
      hash.update(Array.isArray(value) ? "[" : "{");
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) return fail();
        visit(key, depth + 1);
        visit(descriptor.value, depth + 1);
      }
      hash.update(Array.isArray(value) ? "]" : "}");
      seen.delete(value);
    } else hash.update(`${typeof value}:${String(value)};`);
  };
  visit(entry, 0);
  return hash.digest("hex");
}

function* readableValue(value: unknown, depth = 0): Generator<string> {
  if (depth > 32) {
    yield "[Nested content omitted]";
    return;
  }
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    yield String(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (["image", "audio", "file", "binary"].includes(String(record.type))) {
    yield "[Binary content omitted]";
    return;
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    // Binary carriers are not useful readable details, even in custom records.
    if (["data", "base64", "bytes"].includes(key)) {
      yield "[Binary data omitted]\n";
      continue;
    }
    if (!Array.isArray(value)) {
      yield key;
      yield ": ";
    }
    yield* readableValue(record[key], depth + 1);
    yield "\n";
  }
}

function* readableEntry(entry: HistoryEntry): Generator<string> {
  const content = entry.message?.content;
  if (typeof content === "string") {
    yield content;
    return;
  }
  if (Array.isArray(content)) {
    let first = true;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (!first) yield "\n\n";
      first = false;
      if (block.type === "text") yield typeof block.text === "string" ? block.text : "";
      else if (block.type === "thinking") {
        yield "Thinking:\n";
        yield typeof block.thinking === "string" ? block.thinking : "";
      } else if (block.type === "toolCall") {
        yield "Tool: ";
        yield typeof block.name === "string" ? block.name : "tool";
        yield "\n";
        yield* readableValue(block.arguments);
      } else yield* readableValue(block);
    }
    return;
  }
  yield* readableValue(entry.summary ?? entry.label ?? "[No readable content in this entry]");
}

type MarkdownBlock = { start: number; end: number; safe: boolean };

// This is deliberately a small, line-oriented boundary finder rather than a
// Markdown parser. Blank lines and closed fenced blocks are reliable page
// boundaries for the common chat/result shapes; unknown syntax stays in its
// surrounding block and therefore falls back to text if it is too large.
function* markdownBlocks(entry: HistoryEntry): Generator<MarkdownBlock> {
  let blockStart = 0;
  let position = 0;
  let line = "";
  let lineLength = 0;
  let nonWhitespace = false;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let math: "$$" | "\\[" | null = null;
  const resetLine = () => {
    line = "";
    lineLength = 0;
    nonWhitespace = false;
  };
  const completeLine = () => lineLength <= 1024;
  const fenceStart = () => (completeLine() ? /^(?: {0,3})(`{3,}|~{3,})/.exec(line) : null);
  const fenceEnd = () => {
    if (!fence || !completeLine()) return false;
    const rest = line.slice(0, 3).match(/^ {0,3}/)?.[0].length ?? 0;
    let index = rest;
    while (line[index] === fence.marker) index++;
    return index - rest >= fence.length && /^[ \t\r]*$/.test(line.slice(index));
  };
  const mathStart = () => {
    if (!completeLine()) return null;
    const marker = line.trim();
    return marker === "$$" || marker === "\\[" ? marker : null;
  };
  const mathEnd = () => completeLine() && line.trim() === (math === "$$" ? "$$" : "\\]");
  const finishLine = () => {
    if (fence) {
      if (!fenceEnd()) return false;
      fence = null;
      return true;
    }
    if (math) {
      if (!mathEnd()) return false;
      math = null;
      return true;
    }
    const start = fenceStart();
    if (start) fence = { marker: start[1][0] as "`" | "~", length: start[1].length };
    else {
      const marker = mathStart();
      if (marker) math = marker;
      else if (!nonWhitespace) return true;
    }
    return false;
  };

  for (const segment of readableEntry(entry)) {
    for (let index = 0; index < segment.length; index++) {
      const char = segment[index];
      position++;
      lineLength++;
      if (char !== "\n" && line.length < 1024) line += char;
      if (char !== " " && char !== "\t" && char !== "\r" && char !== "\n") nonWhitespace = true;
      if (char !== "\n") continue;

      if (finishLine()) {
        yield { start: blockStart, end: position, safe: true };
        blockStart = position;
      }
      resetLine();
    }
  }
  // EOF terminates a line too. Process its opening/closing markers without
  // inserting a newline or changing the cursor's original source offsets.
  if (lineLength) finishLine();
  if (blockStart < position) yield { start: blockStart, end: position, safe: !fence && !math };
}

// Copy only a bounded prefix of a selected source range. The returned end is
// always a UTF-16 boundary that jsonTextPrefix has verified is JSON-safe.
function rangePrefix(entry: HistoryEntry, offset: number, end: number, budget: number) {
  let position = 0;
  const pieces: string[] = [];
  for (const segment of readableEntry(entry)) {
    const segmentEnd = position + segment.length;
    if (segmentEnd <= offset) {
      position = segmentEnd;
      continue;
    }
    if (position >= end) break;
    const start = Math.max(0, offset - position);
    const available = Math.min(segment.length, end - position) - start;
    const candidate = segment.slice(start, start + Math.min(available, budget + 2));
    const prefix = jsonTextPrefix(candidate, budget);
    if (prefix) {
      pieces.push(prefix);
      budget -= Buffer.byteLength(JSON.stringify(prefix)) - 2;
    }
    const copiedEnd = position + start + prefix.length;
    if (prefix.length < available) return { text: pieces.join(""), end: copiedEnd, complete: false };
    position = segmentEnd;
  }
  return { text: pieces.join(""), end, complete: true };
}

function markdownTextEntry(entry: HistoryEntry): boolean {
  const message = entry.message;
  if (!message || !["user", "assistant", "toolResult"].includes(message.role ?? "")) return false;
  if (typeof message.content === "string") return true;
  return (
    Array.isArray(message.content) &&
    message.content.every(
      (block) =>
        !!block &&
        typeof block === "object" &&
        (((block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") ||
          ((block as { type?: unknown }).type === "thinking" &&
            typeof (block as { thinking?: unknown }).thinking === "string")),
    )
  );
}

export function readEntryDetail(
  branch: readonly HistoryEntry[],
  scope: Scope,
  params: Record<string, unknown>,
  requestId: string,
): {
  sessionId: string;
  runtimeId: string;
  entryId: string;
  text: string;
  nextCursor: string | null;
  format?: "markdown" | "text";
} {
  if (
    !identity(scope.sessionId, 256) ||
    !identity(scope.runtimeId, 256) ||
    params.sessionId !== scope.sessionId ||
    params.runtimeId !== scope.runtimeId ||
    !identity(params.entryId) ||
    !identity(requestId) ||
    (scope.leafId !== null && !identity(scope.leafId))
  )
    fail();
  if (params.presentation !== undefined && params.presentation !== "markdown") fail();
  const markdownRequested = params.presentation === "markdown";
  const entryId = params.entryId as string;
  const entry = branch.find((item) => item.id === entryId);
  if (!entry) return fail();
  const fence = createHash("sha256")
    .update(JSON.stringify([scope.sessionId, scope.runtimeId, scope.leafId, entryId, revision(entry)]))
    .digest("hex");
  const sign = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");
  const cursorAt = (offset: number) => {
    const body = Buffer.from(JSON.stringify({ fence, offset })).toString("base64url");
    return `${body}.${sign(body)}`;
  };
  let offset = 0;
  if (params.cursor !== undefined) {
    if (!identity(params.cursor, 1024)) fail();
    const [body, signature, extra] = (params.cursor as string).split(".");
    if (!body || !signature || extra || signature.length !== 43) fail();
    const expected = sign(body);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail();
    let decoded: { fence?: unknown; offset?: unknown };
    try {
      decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return fail();
    }
    if (decoded.fence !== fence || !Number.isSafeInteger(decoded.offset) || (decoded.offset as number) <= 0) fail();
    offset = decoded.offset as number;
  }
  const result = {
    sessionId: scope.sessionId,
    runtimeId: scope.runtimeId,
    entryId,
    text: "",
    nextCursor: null as string | null,
    ...(markdownRequested ? { format: "text" as "markdown" | "text" } : {}),
  };
  // Reserve a worst-case safe-integer cursor and actual envelope/request ID.
  const overhead = Buffer.byteLength(
    JSON.stringify({
      type: "res",
      id: requestId,
      ok: true,
      result: {
        ...result,
        ...(markdownRequested ? { format: "markdown" as const } : {}),
        nextCursor: cursorAt(Number.MAX_SAFE_INTEGER),
      },
    }),
  );
  let budget = 64 * 1024 - overhead;
  if (budget < 16) return fail();

  if (markdownRequested && markdownTextEntry(entry)) {
    let pageEnd = offset;
    let selected = "";
    let selectedBytes = 0;
    let found = false;
    let length: number | undefined;
    const readableLength = () => {
      if (length !== undefined) return length;
      length = 0;
      for (const segment of readableEntry(entry)) length += segment.length;
      return length;
    };
    for (const block of markdownBlocks(entry)) {
      if (block.end <= pageEnd) continue;
      found = true;
      const prefix = rangePrefix(entry, pageEnd, block.end, budget - selectedBytes);
      // A cursor inside a block belongs to an earlier oversized fallback. Its
      // final suffix must remain text even when that suffix itself now fits.
      if (!prefix.complete || !block.safe || block.start < pageEnd) {
        if (selected) break;
        result.text = prefix.text;
        result.format = "text";
        result.nextCursor = prefix.end < readableLength() ? cursorAt(prefix.end) : null;
        if (result.nextCursor && prefix.end <= offset) fail();
        return result;
      }
      selected += prefix.text;
      selectedBytes += Buffer.byteLength(JSON.stringify(prefix.text)) - 2;
      pageEnd = block.end;
    }
    if (selected) {
      result.text = selected;
      result.format = "markdown";
      result.nextCursor = pageEnd < readableLength() ? cursorAt(pageEnd) : null;
      return result;
    }
    if (offset && !found) fail();
    result.format = "markdown";
    return result;
  }

  let position = 0;
  let truncated = false;
  const pieces: string[] = [];
  for (const segment of readableEntry(entry)) {
    if (position + segment.length <= offset) {
      position += segment.length;
      continue;
    }
    const start = Math.max(0, offset - position);
    // Slice only a bounded candidate, not the entire remainder of a huge value.
    const candidate = segment.slice(start, start + budget + 2);
    const prefix = jsonTextPrefix(candidate, budget);
    if (prefix) {
      pieces.push(prefix);
      budget -= Buffer.byteLength(JSON.stringify(prefix)) - 2;
    }
    position += start + prefix.length;
    if (start + prefix.length < segment.length) {
      truncated = true;
      break;
    }
  }
  if (offset && position <= offset) return fail();
  result.text = pieces.join("");
  result.nextCursor = truncated ? cursorAt(position) : null;
  return result;
}
