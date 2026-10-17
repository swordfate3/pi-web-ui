import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMessageVersionSwitch,
  parseMessageVersions,
  versionSwitchDeadline,
} from "../src/web/src/core/message-versions.ts";

const expected = { sessionId: "session", runtimeId: "runtime", sourceLeafId: "leaf" } as const;
const requested = ["assistant-a", "assistant-b"];
const group = {
  entryIds: ["assistant-a", "assistant-b"],
  userEntryId: "user-b",
  index: 2,
  total: 2,
  versions: [
    { userEntryId: "user-a", targetEntryId: "assistant-a" },
    { userEntryId: "user-b", targetEntryId: "assistant-b" },
  ],
};
const response = {
  ...expected,
  groups: [group],
  limited: false,
};

test("message version parser accepts assistant-only requests without the user entry in the bounded page", () => {
  const parsed = parseMessageVersions(
    {
      ...response,
      groups: [
        {
          ...group,
          entryIds: ["assistant-a", "assistant-b"],
          versions: [
            { userEntryId: "user-a", targetEntryId: null },
            { userEntryId: "user-b", targetEntryId: "assistant-b" },
          ],
        },
      ],
    },
    expected,
    requested,
  );
  assert.equal(parsed.groups[0]?.index, 2);
  assert.equal(parsed.groups[0]?.userEntryId, "user-b");
  assert.equal(parsed.groups[0]?.versions[0]?.targetEntryId, null);
});

test("message version parser rejects malformed, stale, and inconsistent responses", () => {
  const invalidResponses = [
    null,
    {},
    { ...response, sessionId: "other" },
    { ...response, runtimeId: "other" },
    { ...response, sourceLeafId: "other" },
    { ...response, limited: 0 },
    { ...response, groups: [{ ...group, index: 0 }] },
    { ...response, groups: [{ ...group, total: 3 }] },
    { ...response, groups: [{ ...group, versions: [{ userEntryId: "user-a", targetEntryId: "assistant-a" }] }] },
    {
      ...response,
      groups: [{ ...group, versions: [{ userEntryId: "user-a", targetEntryId: "assistant-a" }, group.versions[0]] }],
    },
    {
      ...response,
      groups: [{ ...group, versions: [{ userEntryId: "user-a", targetEntryId: "" }, group.versions[1]] }],
    },
    {
      ...response,
      groups: [{ ...group, versions: [{ userEntryId: "", targetEntryId: "assistant-a" }, group.versions[1]] }],
    },
    { ...response, groups: [{ ...group, userEntryId: "user-a" }] },
    { ...response, groups: [{ ...group, entryIds: ["unrequested"] }] },
    { ...response, groups: [{ ...group, entryIds: ["assistant-a", "assistant-a"] }] },
    {
      ...response,
      groups: [group, { ...group, entryIds: ["assistant-a"], userEntryId: "user-a", index: 1 }],
    },
    {
      ...response,
      groups: [group, { ...group, entryIds: ["assistant-b"], userEntryId: "user-b" }],
    },
  ];
  for (const invalid of invalidResponses) {
    assert.throws(() => parseMessageVersions(invalid, expected, requested), /Invalid message versions response/);
  }
});

test("message version parser enforces request, group, ID, and reference budgets", () => {
  assert.throws(
    () =>
      parseMessageVersions(
        response,
        expected,
        Array.from({ length: 101 }, (_, i) => `id-${i}`),
      ),
    /Invalid message versions response/,
  );
  assert.throws(
    () => parseMessageVersions(response, expected, ["duplicate", "duplicate"]),
    /Invalid message versions response/,
  );
  assert.throws(() => parseMessageVersions(response, expected, ["x".repeat(513)]), /Invalid message versions response/);
  assert.throws(
    () => parseMessageVersions({ ...response, groups: Array.from({ length: 101 }, () => group) }, expected, requested),
    /Invalid message versions response/,
  );

  const hugeGroup = {
    ...group,
    userEntryId: "user-0",
    index: 1,
    total: 257,
    versions: Array.from({ length: 257 }, (_, i) => ({ userEntryId: `user-${i}`, targetEntryId: null })),
  };
  assert.throws(
    () => parseMessageVersions({ ...response, groups: [hugeGroup] }, expected, requested),
    /Invalid message versions response/,
  );
});

test("version switch parser requires an explicit matching ACK or cancellation", () => {
  const switchExpected = { sessionId: "session", runtimeId: "runtime", targetEntryId: "target" };
  assert.deepEqual(parseMessageVersionSwitch({ cancelled: true }, switchExpected), { cancelled: true });
  assert.deepEqual(
    parseMessageVersionSwitch(
      { switched: true, sessionId: "session", runtimeId: "runtime", leafId: "target" },
      switchExpected,
    ),
    { switched: true, sessionId: "session", runtimeId: "runtime", leafId: "target" },
  );
  for (const invalid of [
    undefined,
    {},
    { switched: true },
    { switched: true, sessionId: "other", runtimeId: "runtime", leafId: "leaf" },
    { switched: true, sessionId: "session", runtimeId: "other", leafId: "leaf" },
    { switched: true, sessionId: "session", runtimeId: "runtime", leafId: "wrong-target" },
    { switched: true, cancelled: true, sessionId: "session", runtimeId: "runtime", leafId: "leaf" },
    { cancelled: true, sessionId: "other", runtimeId: "runtime" },
  ]) {
    assert.throws(() => parseMessageVersionSwitch(invalid, switchExpected), /Invalid message version switch response/);
  }
});

test("version switch deadline reports an uncertain timeout without treating it as cancellation", async () => {
  const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: TimerHandler) => {
      assert.equal(typeof callback, "function");
      const timer = setTimeoutDescriptor?.value(() => undefined, 60_000) as ReturnType<typeof setTimeout>;
      clearTimeoutDescriptor?.value(timer);
      (callback as () => void)();
      return timer;
    },
  });
  try {
    await assert.rejects(
      versionSwitchDeadline(new Promise(() => undefined)),
      /Message version switch was not confirmed/,
    );
  } finally {
    if (setTimeoutDescriptor) Object.defineProperty(globalThis, "setTimeout", setTimeoutDescriptor);
    if (clearTimeoutDescriptor) Object.defineProperty(globalThis, "clearTimeout", clearTimeoutDescriptor);
  }
});
