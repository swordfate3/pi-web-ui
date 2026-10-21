import { TextDecoder } from "node:util";
import { parseTerminalTarget, terminalId, validTerminalBinding } from "../../hub/terminal-contract.ts";

export const FRAME_BYTES = 65_536;
export const PEER_BYTES = 262_144;
export const OUTPUT_BYTES = 32_768;
export const INPUT_BYTES = 8_192;
export type Frame = Record<string, unknown>;

export function exact(value: Frame, keys: string): void {
  if (Object.keys(value).sort().join(",") !== keys) throw new Error("invalid_frame");
}

/** Incremental byte framing, fatal UTF-8, bounded before decoding or JSON parsing. */
export class JsonLines {
  private buffer = Buffer.alloc(0);
  private failed = false;
  private readonly accept: (value: Frame) => void;
  constructor(accept: (value: Frame) => void) {
    this.accept = accept;
  }
  push(chunk: Buffer): void {
    if (this.failed) throw new Error("invalid_frame");
    try {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        if (this.buffer.length + end - start > FRAME_BYTES) throw new Error();
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(start, end)]);
        if (newline < 0) break;
        if (this.buffer.length + 1 > FRAME_BYTES) throw new Error();
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.buffer));
        this.buffer = Buffer.alloc(0);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        this.accept(value);
        start = newline + 1;
      }
    } catch {
      this.failed = true;
      this.buffer = Buffer.alloc(0);
      throw new Error("invalid_frame");
    }
  }
}

export function encode(value: object): Buffer {
  const result = Buffer.from(`${JSON.stringify(value)}\n`);
  if (result.length > FRAME_BYTES) throw new Error("frame_limit");
  return result;
}

export function bytes(value: unknown, maximum: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("invalid_bytes");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > maximum || decoded.toString("base64") !== value) throw new Error("invalid_bytes");
  return decoded;
}

export function firstFrame(value: Frame) {
  if (value.v !== 1) throw new Error("invalid_frame");
  if (value.op === "status") {
    exact(value, "op,runId,v");
    if (!terminalId(value.runId)) throw new Error("invalid_frame");
    return { v: 1 as const, op: "status" as const, runId: value.runId };
  }
  exact(value, "binding,op,scope,target,v");
  if (
    value.op !== "connect" ||
    !["read", "write"].includes(String(value.scope)) ||
    !validTerminalBinding(value.binding)
  )
    throw new Error("invalid_frame");
  return {
    v: 1 as const,
    op: "connect" as const,
    target: parseTerminalTarget(value.target),
    scope: value.scope as "read" | "write",
    binding: value.binding,
  };
}

export function size(columns: unknown, rows: unknown): boolean {
  return (
    Number.isInteger(columns) &&
    Number(columns) >= 20 &&
    Number(columns) <= 240 &&
    Number.isInteger(rows) &&
    Number(rows) >= 5 &&
    Number(rows) <= 120
  );
}
