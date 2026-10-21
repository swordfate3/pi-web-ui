/** Child-owned browser mutation accounting, separate from native agent work. */
export class TerminalBarrier {
  #closed = false;
  #active = 0;
  #unknown = false;

  get blocked() {
    return this.#closed;
  }
  get latched() {
    return this.#closed && this.#active === 0 && !this.#unknown;
  }

  assertWritable() {
    if (this.#closed) throw new Error("terminal_untracked");
  }

  enter() {
    this.assertWritable();
    this.#active++;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#active--;
    };
  }

  // The SDK's void dispatch API exposes no reliable completion/error receipt.
  // No event, timeout, idle observation or extension reload clears this bit.
  markUnknown() {
    this.#unknown = true;
  }

  prepare() {
    this.#closed = true;
    return this.latched;
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
