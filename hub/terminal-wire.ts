import { parseTerminalTarget, sameTerminal, type TerminalTarget, terminalId } from "./terminal-contract.ts";

export const TERMINAL_FRAME_BYTES = 65_536;
export const TERMINAL_QUEUE_BYTES = 262_144;
export const TERMINAL_SNAPSHOT_BYTES = 1_048_576;
const utf8 = new TextEncoder();
export const textBytes = (value: string) => utf8.encode(value).length;
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).sort().join(",") !== keys) throw new Error("terminal_invalid_frame");
}
export function terminalSize(columns: unknown, rows: unknown) {
  return (
    Number.isInteger(columns) &&
    Number(columns) >= 20 &&
    Number(columns) <= 240 &&
    Number.isInteger(rows) &&
    Number(rows) >= 5 &&
    Number(rows) <= 120
  );
}

/** Bounded JSON with duplicate-key, depth, nonfinite and lone-surrogate rejection. */
export function parseTerminalJson(text: string): Record<string, unknown> {
  if (textBytes(text) + 1 > TERMINAL_FRAME_BYTES) throw new Error("terminal_invalid_frame");
  let at = 0;
  const space = () => {
    while (/[\t\r\n ]/.test(text[at] ?? "x")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      if (text[at] === "\\") {
        at += 2;
        continue;
      }
      if (text[at++] === '"') {
        const result = JSON.parse(text.slice(start, at));
        if (/\p{Cs}/u.test(result)) throw new Error();
        return result;
      }
    }
    throw new Error();
  };
  const value = (depth: number): unknown => {
    if (depth > 16) throw new Error();
    space();
    if (text[at] === '"') return string();
    if (text[at] === "{") {
      at++;
      space();
      const result: Record<string, unknown> = Object.create(null);
      if (text[at] === "}") {
        at++;
        return result;
      }
      for (;;) {
        space();
        if (text[at] !== '"') throw new Error();
        const key = string();
        space();
        if (text[at++] !== ":" || Object.hasOwn(result, key)) throw new Error();
        result[key] = value(depth + 1);
        space();
        const delimiter = text[at++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") throw new Error();
      }
    }
    if (text[at] === "[") {
      at++;
      space();
      const result: unknown[] = [];
      if (text[at] === "]") {
        at++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        space();
        const delimiter = text[at++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") throw new Error();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at))?.[0];
    if (!token) throw new Error();
    at += token.length;
    const result = JSON.parse(token);
    if (typeof result === "number" && !Number.isFinite(result)) throw new Error();
    return result;
  };
  try {
    const result = value(0);
    space();
    if (at !== text.length || !record(result)) throw new Error();
    return result;
  } catch {
    throw new Error("terminal_invalid_frame");
  }
}

export type TerminalSnapshot = { sequence: number; columns: number; rows: number; data: string };
/** One assembly only. A malformed/incomplete snapshot is never an ANSI tail. */
export class TerminalSnapshotAssembly {
  private current?: {
    sequence: number;
    columns: number;
    rows: number;
    bytes: Uint8Array;
    chunks: number;
    index: number;
    offset: number;
  };
  private sequence = -1;
  private readonly target: TerminalTarget;
  constructor(target: TerminalTarget) {
    this.target = target;
  }
  clear() {
    this.current = undefined;
  }
  accept(frame: Record<string, unknown>): TerminalSnapshot | undefined {
    if (frame.type === "screen-start") {
      exact(frame, "bytes,chunks,columns,rows,sequence,target,type");
      if (
        this.current ||
        !sameTerminal(parseTerminalTarget(frame.target), this.target) ||
        !Number.isSafeInteger(frame.sequence) ||
        Number(frame.sequence) <= this.sequence ||
        !terminalSize(frame.columns, frame.rows) ||
        !Number.isInteger(frame.bytes) ||
        Number(frame.bytes) < 0 ||
        Number(frame.bytes) > TERMINAL_SNAPSHOT_BYTES ||
        frame.chunks !== Math.ceil(Number(frame.bytes) / 20480)
      )
        throw new Error("terminal_invalid_snapshot");
      this.current = {
        sequence: Number(frame.sequence),
        columns: Number(frame.columns),
        rows: Number(frame.rows),
        bytes: new Uint8Array(Number(frame.bytes)),
        chunks: Number(frame.chunks),
        index: 0,
        offset: 0,
      };
      return;
    }
    const current = this.current;
    if (!current || frame.terminalEpoch !== this.target.terminalEpoch || frame.sequence !== current.sequence)
      throw new Error("terminal_invalid_snapshot");
    if (frame.type === "screen-chunk") {
      exact(frame, "data,index,sequence,terminalEpoch,type");
      if (
        frame.index !== current.index ||
        current.index >= current.chunks ||
        typeof frame.data !== "string" ||
        frame.data.length > 27308 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
      )
        throw new Error("terminal_invalid_snapshot");
      const binary = atob(frame.data);
      if (btoa(binary) !== frame.data || binary.length !== Math.min(20480, current.bytes.length - current.offset))
        throw new Error("terminal_invalid_snapshot");
      for (let i = 0; i < binary.length; i++) current.bytes[current.offset++] = binary.charCodeAt(i);
      current.index++;
      return;
    }
    exact(frame, "sequence,terminalEpoch,type");
    if (frame.type !== "screen-end" || current.index !== current.chunks || current.offset !== current.bytes.length)
      throw new Error("terminal_invalid_snapshot");
    const data = new TextDecoder("utf-8", { fatal: true }).decode(current.bytes);
    if (/\p{Cs}/u.test(data)) throw new Error("terminal_invalid_snapshot");
    this.sequence = current.sequence;
    this.current = undefined;
    return { sequence: current.sequence, columns: current.columns, rows: current.rows, data };
  }
}

export type TerminalRequest = Record<string, unknown> & { id: number; type: string };
export function parseTerminalRequest(frame: Record<string, unknown>): TerminalRequest {
  if (!Number.isSafeInteger(frame.id) || Number(frame.id) < 1) throw new Error("terminal_invalid_request");
  if (frame.type === "acquire" || frame.type === "release") exact(frame, "id,type");
  else if (frame.type === "resize") {
    exact(frame, "columns,id,leaseId,rows,type");
    if (!terminalId(frame.leaseId) || !terminalSize(frame.columns, frame.rows))
      throw new Error("terminal_invalid_request");
  } else {
    exact(frame, "data,id,leaseId,sequence,terminalEpoch,type,v");
    if (
      frame.v !== 1 ||
      frame.type !== "input" ||
      !terminalId(frame.terminalEpoch) ||
      !terminalId(frame.leaseId) ||
      !Number.isSafeInteger(frame.sequence) ||
      Number(frame.sequence) < 1 ||
      typeof frame.data !== "string" ||
      !frame.data ||
      /\p{Cs}/u.test(frame.data) ||
      textBytes(frame.data) > 8192
    )
      throw new Error("terminal_invalid_request");
  }
  return frame as TerminalRequest;
}
export function parseTerminalResult(action: string, result: unknown): Record<string, unknown> {
  if (!record(result)) throw new Error("terminal_invalid_result");
  if (action === "acquire") {
    if (result.ok === true) {
      exact(result, "expiresInMs,leaseId,ok");
      if (!terminalId(result.leaseId) || result.expiresInMs !== 30000) throw new Error();
    } else {
      exact(result, "error,ok");
      if (result.ok !== false || !["local_owns_input", "control_unavailable"].includes(String(result.error)))
        throw new Error();
    }
  } else if (action === "input") {
    if (result.ok === true) {
      exact(result, "delivery,ok");
      if (result.delivery !== "written") throw new Error();
    } else {
      exact(result, "delivery,error,ok");
      if (
        result.ok !== false ||
        (!(result.delivery === "unknown" && result.error === "input_delivery_unknown") &&
          !(result.delivery === "rejected" && result.error === "input_rejected"))
      )
        throw new Error();
    }
  } else if (action === "release") {
    exact(result, "ok");
    if (result.ok !== true) throw new Error();
  } else {
    if (result.error === undefined) {
      exact(result, "ok");
      if (typeof result.ok !== "boolean") throw new Error();
    } else {
      exact(result, "error,ok");
      if (result.ok !== false || !["resize_rejected", "resize_unknown"].includes(String(result.error)))
        throw new Error();
    }
  }
  return result;
}
