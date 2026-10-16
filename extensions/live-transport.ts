// Transport projection only: never derive chat/UI models or mutate Pi events.
export function projectLiveEvent(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const envelope = data as Record<string, unknown>;
  if (envelope.type !== "event") return data;
  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return data;
  if (envelope.event === "agent_end") {
    const { messages: _messages, ...rest } = payload;
    return { ...envelope, payload: rest };
  }
  if (envelope.event === "turn_end") {
    const { message: _message, toolResults: _toolResults, ...rest } = payload;
    return { ...envelope, payload: rest };
  }
  if (envelope.event !== "message_update") return data;
  const update = payload?.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!update || !["text_delta", "thinking_delta", "toolcall_delta"].includes(String(update.type))) return data;
  // Pi includes the cumulative message and partial at every delta. The browser
  // consumes type/delta/index, not these ever-growing duplicate snapshots.
  const { message: _message, ...rest } = payload;
  const { partial: _partial, ...delta } = update;
  return { ...envelope, payload: { ...rest, assistantMessageEvent: delta } };
}

export const RECOVERABLE_LIVE_EVENTS = new Set([
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_end",
  "auto_compaction_end",
]);
