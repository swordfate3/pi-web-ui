// Pi 1.3 public UI lifecycle metadata only. No body, resolver or authorization.
export type TerminalPrompt = {
  kind: "confirm" | "select" | "input" | "editor" | "custom";
  title?: string;
};

export class TerminalPromptState {
  private current: TerminalPrompt | null = null;

  snapshot(): TerminalPrompt | null {
    return this.current ? { ...this.current } : null;
  }

  clear() {
    this.current = null;
  }

  observe(event: unknown, started: boolean): TerminalPrompt | null {
    if (!event || typeof event !== "object") return null;
    const value = event as Record<string, unknown>;
    if (!["confirm", "select", "input", "editor", "custom"].includes(String(value.kind))) return null;
    if (value.title !== undefined && typeof value.title !== "string") return null;
    const prompt: TerminalPrompt = {
      kind: value.kind as TerminalPrompt["kind"],
      ...(typeof value.title === "string" ? { title: value.title } : {}),
    };
    // Public events describe the outer blocking prompt, not individual nested dialogs.
    if (started) this.current = prompt;
    else this.clear();
    return prompt;
  }
}

export const TERMINAL_UI_REQUIRED =
  "Web extension UI responses are unsupported. Respond in the Pi terminal (or its owning trusted RPC client).";
