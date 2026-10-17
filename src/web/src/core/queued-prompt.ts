import type { PromptCommand } from "./types";

export type PromptScopeIdentity = {
  sessionId: string | null;
  runtimeId: string | null;
};

export type ActivePromptScope = {
  sessionId: string;
  runtimeId: string;
};

export type QueuedPrompt = PromptCommand & {
  /** Scope captured when enqueued. Never rebound automatically to a new session. */
  sourceScope: ActivePromptScope;
};

export type NavigationDraftSnapshot = {
  text: string;
  version: number;
};

export function navigationResultIsCurrent(
  sourceScope: PromptScopeIdentity,
  currentScope: PromptScopeIdentity,
  sourceDraft: NavigationDraftSnapshot,
  currentDraft: NavigationDraftSnapshot,
): boolean {
  return (
    sourceScope.sessionId !== null &&
    sourceScope.runtimeId !== null &&
    sourceScope.sessionId === currentScope.sessionId &&
    sourceScope.runtimeId === currentScope.runtimeId &&
    sourceDraft.version === currentDraft.version &&
    sourceDraft.text === currentDraft.text
  );
}

export type QueuedPromptDispatchState = PromptScopeIdentity & {
  connection: string;
  chatStatus: string;
  sessionActionPending: boolean;
};

export function createQueuedPrompt(
  command: Pick<PromptCommand, "id" | "message">,
  identity: PromptScopeIdentity,
  connected: boolean,
): QueuedPrompt | null {
  if (!connected || !identity.sessionId || !identity.runtimeId) return null;
  const sourceScope = { sessionId: identity.sessionId, runtimeId: identity.runtimeId };
  return { ...command, sourceScope, scope: sourceScope };
}

export function queuedPromptMatchesScope(prompt: QueuedPrompt, identity: PromptScopeIdentity): boolean {
  return prompt.sourceScope.sessionId === identity.sessionId && prompt.sourceScope.runtimeId === identity.runtimeId;
}

export function canDispatchQueuedPrompt(prompt: QueuedPrompt, state: QueuedPromptDispatchState): boolean {
  return (
    state.connection === "connected" &&
    state.chatStatus === "ready" &&
    !state.sessionActionPending &&
    queuedPromptMatchesScope(prompt, state)
  );
}
