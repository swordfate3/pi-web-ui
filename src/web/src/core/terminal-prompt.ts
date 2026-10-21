import type { TerminalPrompt } from "./types";

export function parseTerminalPrompt(value: unknown): TerminalPrompt | null {
  if (!value || typeof value !== "object") return null;
  const prompt = value as Record<string, unknown>;
  if (!["confirm", "select", "input", "editor", "custom"].includes(String(prompt.kind))) return null;
  if (prompt.title !== undefined && typeof prompt.title !== "string") return null;
  return {
    kind: prompt.kind as TerminalPrompt["kind"],
    ...(typeof prompt.title === "string" ? { title: prompt.title } : {}),
  };
}
