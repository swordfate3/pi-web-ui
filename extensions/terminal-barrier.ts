/** Child-owned browser mutation accounting, separate from native agent work. */
export class TerminalBarrier {
  #closed = false;
  #active = 0;
  #unknown = false;
  #pending = false;
  #changed: (() => void) | undefined;

  get blocked() {
    return this.#closed || this.#pending;
  }
  get latched() {
    return this.#closed && this.#active === 0 && !this.#unknown;
  }

  assertWritable() {
    if (this.blocked) throw new Error("terminal_untracked");
  }

  enter() {
    this.assertWritable();
    this.#active++;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#active--;
      this.#changed?.();
    };
  }

  // The SDK's void dispatch API exposes no reliable completion/error receipt.
  // No event, timeout, idle observation or extension reload clears this bit.
  markUnknown() {
    this.#unknown = true;
    this.#changed?.();
  }

  prepare() {
    if (this.#active || this.#unknown || this.#pending) return false;
    this.#closed = true;
    return this.latched;
  }

  prepareWhenDrained(signal: AbortSignal, isCurrent: () => boolean): Promise<boolean> {
    if (signal.aborted || this.#unknown || this.#pending || !isCurrent()) return Promise.resolve(false);
    if (this.#closed) return Promise.resolve(this.latched);
    this.#pending = true;
    const deadline = performance.now() + 250;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (commit: boolean) => {
        if (settled) return;
        settled = true;
        let success = false;
        try {
          success =
            commit &&
            performance.now() < deadline &&
            !signal.aborted &&
            !this.#unknown &&
            this.#active === 0 &&
            isCurrent();
        } catch {
          // Replacement/disposal can invalidate the context used by the identity check.
        }
        if (success) this.#closed = true;
        this.#pending = false;
        this.#changed = undefined;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        resolve(success);
      };
      const cancel = () => finish(false);
      // The broker allows 500 ms for the entire adapter call. Leave transport
      // headroom and never infer completion when this shorter drain expires.
      const timer = setTimeout(cancel, 250);
      signal.addEventListener("abort", cancel, { once: true });
      this.#changed = () => {
        if (this.#unknown) cancel();
        else if (this.#active === 0) finish(true);
      };
      this.#changed();
    });
  }
}

export function childTerminalBarrier(): TerminalBarrier {
  const key = Symbol.for("pi.web.terminal-barrier.v1");
  const existing = Object.getOwnPropertyDescriptor(globalThis, key);
  if (existing) {
    if (existing.configurable || existing.writable || !Object.isFrozen(existing.value))
      throw new Error("Invalid child terminal barrier");
    return existing.value as TerminalBarrier;
  }
  const barrier = new TerminalBarrier();
  Object.freeze(barrier);
  Object.defineProperty(globalThis, key, { value: barrier, writable: false, configurable: false });
  return barrier;
}

const reads = new Set([
  "get_commands",
  "get_state",
  "get_messages",
  "get_available_models",
  "get_session_stats",
  "get_usage_stats",
  "get_saved_sessions",
  "get_fork_messages",
  "get_entry_detail",
  "get_history",
  "get_tree",
  "sync_request",
  "health",
  "get_files",
  "get_git_status",
  "get_git_diff",
  "get_file_content",
  "get_web_connection",
  "get_auth",
  "get_message_versions",
  "get_message_revision",
]);

export function terminalReadOnly(method: string): boolean {
  return reads.has(method);
}
