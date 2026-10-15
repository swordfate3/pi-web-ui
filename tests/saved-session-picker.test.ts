import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelSavedSessionPicker } from "../src/web/src/core/saved-session-picker.ts";

test("closing a saved picker invalidates a same-session date request before its result arrives", async () => {
  const requests = { current: 1 };
  const pendingRequest = requests.current;
  let listing: string | null = "recent dates";
  let loading = true;
  let resolve!: (result: string) => void;
  const pending = new Promise<string>((done) => {
    resolve = done;
  }).then((result) => {
    if (pendingRequest === requests.current) listing = result;
  });

  cancelSavedSessionPicker(requests, () => {
    listing = null;
    loading = false;
  });
  assert.equal(listing, null);
  assert.equal(loading, false);
  resolve("old dates from the same session");
  await pending;
  assert.equal(listing, null, "a cancelled date response must not reopen the picker");
});

test("cancellation invalidates before closing and does not invalidate a later explicit reopen", async () => {
  const requests = { current: 7 };
  const cancelled = requests.current;
  let listing: string | null = "recent dates";
  cancelSavedSessionPicker(requests, () => {
    assert.notEqual(requests.current, cancelled, "invalidate first, before any close side effects");
    listing = null;
  });
  const reopened = ++requests.current;
  await Promise.resolve();
  if (reopened === requests.current) listing = "new selection";
  assert.equal(listing, "new selection");
  assert.notEqual(requests.current, cancelled);
});
