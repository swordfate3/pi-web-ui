import type { MessageRevisionMode, MessageRevisionPreview } from "./types";

/** Full original text only. Never use bounded chat/tree previews for resubmission. */
export function parseMessageRevision(
  value: unknown,
  entryId: string,
  mode: MessageRevisionMode,
  sessionId: string,
  runtimeId: string,
): MessageRevisionPreview {
  if (!value || typeof value !== "object") throw new Error("Invalid message revision response");
  const v = value as Record<string, unknown>;
  if (
    typeof v.previewId !== "string" ||
    !v.previewId ||
    v.previewId.length > 128 ||
    v.entryId !== entryId ||
    v.sessionId !== sessionId ||
    v.runtimeId !== runtimeId ||
    typeof v.userEntryId !== "string" ||
    !v.userEntryId ||
    typeof v.text !== "string" ||
    typeof v.hasImages !== "boolean" ||
    (v.sourceLeafId !== null && typeof v.sourceLeafId !== "string")
  )
    throw new Error("Invalid message revision response");
  return {
    previewId: v.previewId,
    entryId,
    mode,
    sessionId,
    runtimeId,
    userEntryId: v.userEntryId,
    text: v.text,
    hasImages: v.hasImages,
    sourceLeafId: v.sourceLeafId as string | null,
  };
}

/** Deadline is not cancellation or permission to retry a possibly dispatched request. */
export async function revisionDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Message revision was not confirmed. Check the active branch before trying again.")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
