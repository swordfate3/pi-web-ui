import { UiError, uiText } from "./ui-text";

const MAX_REQUESTED_ENTRY_IDS = 100;
const MAX_GROUPS = 100;
const MAX_VERSION_REFS = 256;
const MAX_ENTRY_ID_LENGTH = 512;
export type MessageVersion = {
  userEntryId: string;
  targetEntryId: string | null;
};

export type MessageVersionGroup = {
  entryIds: string[];
  userEntryId: string;
  index: number;
  total: number;
  versions: MessageVersion[];
};

export type MessageVersionsResult = {
  sessionId: string;
  runtimeId: string;
  sourceLeafId: string | null;
  groups: MessageVersionGroup[];
  limited: boolean;
};

export type MessageVersionsExpected = {
  sessionId: string;
  runtimeId: string;
  sourceLeafId: string | null;
};

function invalidVersions(): UiError {
  return new UiError(uiText("Invalid message versions response"));
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ENTRY_ID_LENGTH;
}

function validExpected(expected: MessageVersionsExpected): boolean {
  return (
    validId(expected.sessionId) &&
    validId(expected.runtimeId) &&
    (expected.sourceLeafId === null || validId(expected.sourceLeafId))
  );
}

/** Validate the bounded, authoritative version-group payload; never infer variants from a partial tree. */
export function parseMessageVersions(
  value: unknown,
  expected: MessageVersionsExpected,
  requestedEntryIds: string[],
): MessageVersionsResult {
  if (
    !expected ||
    typeof expected !== "object" ||
    !validExpected(expected) ||
    !Array.isArray(requestedEntryIds) ||
    requestedEntryIds.length > MAX_REQUESTED_ENTRY_IDS ||
    requestedEntryIds.some((id) => !validId(id)) ||
    new Set(requestedEntryIds).size !== requestedEntryIds.length ||
    !value ||
    typeof value !== "object"
  ) {
    throw invalidVersions();
  }

  const response = value as Record<string, unknown>;
  if (
    response.sessionId !== expected.sessionId ||
    response.runtimeId !== expected.runtimeId ||
    response.sourceLeafId !== expected.sourceLeafId ||
    typeof response.limited !== "boolean" ||
    !Array.isArray(response.groups) ||
    response.groups.length > MAX_GROUPS
  ) {
    throw invalidVersions();
  }

  const requested = new Set(requestedEntryIds);
  const groupedEntries = new Set<string>();
  const groupUsers = new Set<string>();
  let versionRefs = 0;
  const groups: MessageVersionGroup[] = [];

  for (const rawGroup of response.groups) {
    if (!rawGroup || typeof rawGroup !== "object") throw invalidVersions();
    const group = rawGroup as Record<string, unknown>;
    if (
      !Array.isArray(group.entryIds) ||
      group.entryIds.length === 0 ||
      group.entryIds.some((id) => !validId(id) || !requested.has(id) || groupedEntries.has(id)) ||
      new Set(group.entryIds).size !== group.entryIds.length ||
      !validId(group.userEntryId) ||
      groupUsers.has(group.userEntryId) ||
      !Number.isSafeInteger(group.index) ||
      !Number.isSafeInteger(group.total) ||
      (group.index as number) < 1 ||
      (group.total as number) < 2 ||
      (group.index as number) > (group.total as number) ||
      !Array.isArray(group.versions) ||
      group.versions.length !== group.total
    ) {
      throw invalidVersions();
    }

    versionRefs += group.versions.length;
    if (versionRefs > MAX_VERSION_REFS) throw invalidVersions();

    const versionUsers = new Set<string>();
    const versions: MessageVersion[] = [];
    for (const rawVersion of group.versions) {
      if (!rawVersion || typeof rawVersion !== "object") throw invalidVersions();
      const version = rawVersion as Record<string, unknown>;
      if (
        !validId(version.userEntryId) ||
        versionUsers.has(version.userEntryId) ||
        (version.targetEntryId !== null && !validId(version.targetEntryId))
      ) {
        throw invalidVersions();
      }
      versionUsers.add(version.userEntryId);
      versions.push({
        userEntryId: version.userEntryId,
        targetEntryId: version.targetEntryId as string | null,
      });
    }

    if (versions[(group.index as number) - 1]?.userEntryId !== group.userEntryId) throw invalidVersions();

    for (const id of group.entryIds as string[]) groupedEntries.add(id);
    groupUsers.add(group.userEntryId);
    groups.push({
      entryIds: [...(group.entryIds as string[])],
      userEntryId: group.userEntryId,
      index: group.index as number,
      total: group.total as number,
      versions,
    });
  }

  return {
    sessionId: expected.sessionId,
    runtimeId: expected.runtimeId,
    sourceLeafId: expected.sourceLeafId,
    groups,
    limited: response.limited,
  };
}

export type MessageVersionSwitchExpected = {
  sessionId: string;
  runtimeId: string;
  targetEntryId: string;
};

export type MessageVersionSwitchResult =
  | { cancelled: true }
  | { switched: true; sessionId: string; runtimeId: string; leafId: string };

/** Accept only an explicit cancellation or a branch-switch acknowledgement for the requested session/runtime. */
export function parseMessageVersionSwitch(
  value: unknown,
  expected: MessageVersionSwitchExpected,
): MessageVersionSwitchResult {
  if (
    !expected ||
    typeof expected !== "object" ||
    !validId(expected.sessionId) ||
    !validId(expected.runtimeId) ||
    !validId(expected.targetEntryId) ||
    !value ||
    typeof value !== "object"
  ) {
    throw new UiError(uiText("Invalid message version switch response"));
  }
  const response = value as Record<string, unknown>;
  if (response.cancelled === true && Object.keys(response).length === 1) return { cancelled: true };
  if (
    response.switched === true &&
    response.cancelled === undefined &&
    response.sessionId === expected.sessionId &&
    response.runtimeId === expected.runtimeId &&
    response.leafId === expected.targetEntryId &&
    Object.keys(response).length === 4
  ) {
    return {
      switched: true,
      sessionId: expected.sessionId,
      runtimeId: expected.runtimeId,
      leafId: response.leafId,
    };
  }
  throw new UiError(uiText("Invalid message version switch response"));
}

/** A timeout reports an uncertain switch; it is not cancellation and does not imply it is safe to retry. */
export async function versionSwitchDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new UiError(
                uiText("Message version switch was not confirmed. Check the active branch before trying again."),
              ),
            ),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
