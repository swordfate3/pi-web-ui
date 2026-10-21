import assert from "node:assert/strict";
import test from "node:test";
import { childTerminalBarrier, TerminalBarrier, terminalReadOnly } from "../extensions/terminal-barrier.ts";

test("failed immediate preparation preserves chat while admitted work remains", () => {
  const barrier = new TerminalBarrier();
  const finish = barrier.enter();
  assert.equal(barrier.prepare(), false);
  const other = barrier.enter();
  other();
  assert.doesNotThrow(() => barrier.assertWritable());
  assert.equal(barrier.latched, false);
  finish();
  finish(); // Completion is idempotent; cannot underflow into a premature grant.
  assert.equal(barrier.prepare(), true);
  assert.equal(barrier.latched, true);
});

test("void dispatch uncertainty is permanent even when the ingress ticket completes", () => {
  const barrier = new TerminalBarrier();
  const finish = barrier.enter();
  barrier.markUnknown();
  finish();
  assert.equal(barrier.prepare(), false);
  assert.equal(barrier.latched, false);
  const stillWritable = barrier.enter();
  stillWritable();
  assert.equal(barrier.prepare(), false, "a rejected prepare cannot clear genuinely unknown work");
});

test("pending preparation blocks new admission and commits only after the actual ticket settles", async () => {
  const barrier = new TerminalBarrier();
  const finish = barrier.enter();
  const pending = barrier.prepareWhenDrained(new AbortController().signal, () => true);
  assert.throws(() => barrier.enter(), /terminal_untracked/);
  assert.equal(barrier.latched, false);
  assert.equal(await barrier.prepareWhenDrained(new AbortController().signal, () => true), false);
  finish();
  assert.equal(await pending, true);
  assert.equal(barrier.latched, true);
  assert.throws(() => barrier.enter(), /terminal_untracked/);
});

for (const reason of ["timeout", "disconnect", "identity", "unknown"] as const) {
  test(`failed pending preparation restores chat after ${reason} without forgetting work`, async () => {
    const barrier = new TerminalBarrier();
    const finish = barrier.enter();
    const abort = new AbortController();
    let current = true;
    const pending = barrier.prepareWhenDrained(abort.signal, () => current);
    assert.throws(() => barrier.enter(), /terminal_untracked/);
    if (reason === "disconnect") abort.abort();
    if (reason === "unknown") barrier.markUnknown();
    if (reason === "identity") {
      current = false;
      finish();
    }
    assert.equal(await pending, false);
    assert.equal(barrier.blocked, false);
    assert.equal(barrier.latched, false);
    const stillWritable = barrier.enter();
    stillWritable();
    if (reason !== "identity") assert.equal(barrier.prepare(), false, "outstanding work was not discarded");
    finish();
    assert.equal(barrier.prepare(), reason !== "unknown");
  });
}

test("an overdue drain cannot commit ahead of its delayed timer callback", async () => {
  const barrier = new TerminalBarrier();
  const finish = barrier.enter();
  const pending = barrier.prepareWhenDrained(new AbortController().signal, () => true);
  // Hold the event loop beyond the drain budget, then finish before timers run.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 275);
  finish();
  assert.equal(await pending, false);
  assert.equal(barrier.blocked, false);
  barrier.enter()();
});

test("child-global latch survives a fresh module instance without a writable reset slot", async () => {
  const barrier = childTerminalBarrier();
  assert.equal(barrier.browserBlocked, true, "startup browser policy precedes prepare");
  assert.equal(barrier.blocked, false, "internal accounting is distinct from browser policy");
  assert.equal(barrier.latched, false, "startup policy cannot fake a successful prepare");
  assert.throws(() => barrier.assertBrowserWritable(), /terminal_untracked/);
  assert.equal(barrier.prepare(), true);
  const freshModule = "../extensions/terminal-barrier.ts?reload";
  const reloaded = await import(freshModule);
  assert.equal(reloaded.childTerminalBarrier(), barrier);
  assert.equal(reloaded.browserTerminalBarrier("inherited-tui"), barrier, "reload cannot unfence the child policy");
  assert.throws(() => reloaded.childTerminalBarrier().enter(), /terminal_untracked/);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("pi.web.terminal-barrier.v1"));
  assert.equal(descriptor?.writable, false);
  assert.equal(descriptor?.configurable, false);
  assert.equal(Object.isFrozen(barrier), true);
});

test("terminal reads use a closed allowlist, not method-name prefixes", () => {
  for (const method of ["get_state", "get_messages", "get_history", "get_tree", "health", "sync_request"])
    assert.equal(terminalReadOnly(method), true, method);
  for (const method of [
    "get_future_write",
    "abort",
    "prompt",
    "steer",
    "follow_up",
    "set_auth",
    "open_file",
    "prepare_upload",
    "complete_upload",
    "extension_ui_response",
    "reload",
    "arbitrary_extension_command",
  ])
    assert.equal(terminalReadOnly(method), false, method);
});
