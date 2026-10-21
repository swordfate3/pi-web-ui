import assert from "node:assert/strict";
import test from "node:test";
import { childTerminalBarrier, TerminalBarrier, terminalReadOnly } from "../extensions/terminal-barrier.ts";

test("prepare closes admission immediately but cannot grant until admitted work drains", () => {
  const barrier = new TerminalBarrier();
  const finish = barrier.enter();
  assert.equal(barrier.prepare(), false);
  assert.throws(() => barrier.enter(), /terminal_untracked/);
  assert.throws(() => barrier.assertWritable(), /terminal_untracked/);
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
  assert.throws(() => barrier.enter(), /terminal_untracked/);
});

test("child-global latch survives a fresh module instance without a writable reset slot", async () => {
  const barrier = childTerminalBarrier();
  assert.equal(barrier.prepare(), true);
  const freshModule = "../extensions/terminal-barrier.ts?reload";
  const reloaded = await import(freshModule);
  assert.equal(reloaded.childTerminalBarrier(), barrier);
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
