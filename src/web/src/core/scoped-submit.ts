export type SubmitAttempt = { scope: string; token: symbol };

/** Allows a new session scope to submit without an older scope's pending promise owning the lock. */
export function createScopedSubmitLock() {
  let activeAttempt: SubmitAttempt | null = null;

  return {
    acquire(scope: string): SubmitAttempt {
      if (activeAttempt?.scope === scope) throw new Error("A prompt submission is already in progress");
      const attempt = { scope, token: Symbol(scope) };
      activeAttempt = attempt;
      return attempt;
    },
    release(attempt: SubmitAttempt) {
      if (activeAttempt?.token === attempt.token) activeAttempt = null;
    },
  };
}

/** Keeps attachment context mutations inert while a prompt is handing attachments off. */
export function runIfAttachmentsEnabled(disabled: boolean, mutate: () => void) {
  if (!disabled) mutate();
}
