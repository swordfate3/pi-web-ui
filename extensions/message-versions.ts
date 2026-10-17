/** Version metadata from the complete saved entry graph, never a bounded UI tree. */
export type VersionEntry = {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role?: string };
};
export type MessageVersionGroup = {
  entryIds: string[];
  userEntryId: string;
  index: number;
  total: number;
  versions: { userEntryId: string; targetEntryId: string | null }[];
};

function isUser(entry: VersionEntry) {
  return entry.type === "message" && entry.message?.role === "user";
}

export function resolveMessageVersions(
  entries: readonly VersionEntry[],
  entryIds: unknown,
  sourceLeafId: string | null,
): { groups: MessageVersionGroup[]; limited: boolean } {
  if (
    !Array.isArray(entryIds) ||
    entryIds.length > 100 ||
    entryIds.some((id) => typeof id !== "string" || !id) ||
    new Set(entryIds).size !== entryIds.length
  )
    throw new Error("entryIds must be unique saved message IDs (at most 100)");

  const byId = new Map<string, VersionEntry>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id || byId.has(entry.id)) throw new Error("Invalid saved entry graph");
    byId.set(entry.id, entry);
  }
  // Iterative, memoized ancestry validation: malformed components cannot supply
  // a sibling or navigation target, even when the nearest user itself exists.
  const valid = new Map<string, boolean>();
  const nearest = new Map<string, string | null>();
  // Inclusive stable context anchor: only system messages are transparent.
  // Populate with ancestry validation so shared/long patch chains stay linear.
  // Invalid components never receive an anchor (in particular, not a root key).
  const contextAnchor = new Map<string, string | null>();
  for (const start of entries) {
    const path: VersionEntry[] = [];
    const seen = new Set<string>();
    let cursor: VersionEntry | undefined = start;
    while (cursor && !valid.has(cursor.id) && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      path.push(cursor);
      cursor = typeof cursor.parentId === "string" && cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    const sound = cursor ? valid.get(cursor.id) === true : path.at(-1)?.parentId === null;
    let user = cursor ? (nearest.get(cursor.id) ?? null) : null;
    let anchor = cursor ? contextAnchor.get(cursor.id) : null;
    for (let i = path.length - 1; i >= 0; i--) {
      const entry = path[i];
      valid.set(entry.id, sound);
      if (isUser(entry)) user = entry.id;
      nearest.set(entry.id, sound ? user : null);
      if (sound) {
        if (entry.type !== "message" || entry.message?.role !== "system") anchor = entry.id;
        if (anchor !== undefined) contextAnchor.set(entry.id, anchor);
      }
    }
  }
  const siblings = new Map<string | null, VersionEntry[]>();
  const parents = new Set(entries.map((entry) => entry.parentId));
  for (const entry of entries) {
    if (!valid.get(entry.id) || !isUser(entry)) continue;
    const position = entry.parentId === null ? null : contextAnchor.get(entry.parentId);
    if (position === undefined) continue;
    const group = siblings.get(position) ?? [];
    group.push(entry); // Original append order, deliberately not timestamp order.
    siblings.set(position, group);
  }
  // Visit real leaves newest first. Each ancestor is traversed at most once;
  // the first leaf reaching it is its most recently saved continuation.
  const latestLeaf = new Map<string, string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    let entry: VersionEntry | undefined = entries[i];
    if (!valid.get(entry.id) || parents.has(entry.id)) continue;
    const leafId = entry.id;
    while (entry && !latestLeaf.has(entry.id)) {
      latestLeaf.set(entry.id, leafId);
      entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
    }
  }
  function safeTarget(userId: string, targetId: string | null): string | null {
    if (!targetId || !valid.get(targetId)) return null;
    let entry = byId.get(targetId);
    if (!entry || isUser(entry) || entry.type === "custom_message") return null;
    // Walking backwards resets at each subsequent user. At the candidate we
    // therefore know whether its own first response segment has an assistant.
    let answered = false;
    while (entry && entry.id !== userId) {
      if (isUser(entry)) answered = false;
      else if (entry.type === "message" && entry.message?.role === "assistant") answered = true;
      entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
    }
    return entry && answered ? targetId : null;
  }

  const requested = new Map<string, string[]>();
  for (const id of entryIds as string[]) {
    const entry = byId.get(id);
    if (!entry || entry.type !== "message" || !["user", "assistant"].includes(entry.message?.role ?? ""))
      throw new Error("Select saved user or assistant messages");
    const userId = nearest.get(id);
    if (!userId) throw new Error("Invalid message parent chain");
    const ids = requested.get(userId) ?? [];
    ids.push(id);
    requested.set(userId, ids);
  }
  const groups: MessageVersionGroup[] = [];
  let refs = 0;
  let limited = false;
  for (const [userId, ids] of requested) {
    const user = byId.get(userId);
    if (!user) continue;
    const position = user.parentId === null ? null : contextAnchor.get(user.parentId);
    if (position === undefined) continue;
    const variants = siblings.get(position) ?? [];
    if (variants.length < 2) continue;
    if (groups.length >= 100 || refs + variants.length > 256) {
      limited = true;
      continue; // Omit whole groups, never invent a partial total/index.
    }
    refs += variants.length;
    groups.push({
      entryIds: ids,
      userEntryId: userId,
      index: variants.findIndex((entry) => entry.id === userId) + 1,
      total: variants.length,
      versions: variants.map((entry) => ({
        userEntryId: entry.id,
        targetEntryId: safeTarget(entry.id, sourceLeafId) ?? safeTarget(entry.id, latestLeaf.get(entry.id) ?? null),
      })),
    });
  }
  return { groups, limited };
}
