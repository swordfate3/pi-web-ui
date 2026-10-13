import type { ReloadAck, ReloadRequest, SwitchSessionAck, SwitchSessionRequest } from "../types";
import { errorUiText, UiError, type UiText, uiText } from "../ui-text";
import type { SessionSlice, StoreSlice } from "./types";

type Action =
  | { method: "fork_session"; action: "fork" | "clone"; entryId?: string }
  | { method: "switch_session"; id: string; targetSessionId: string }
  | { method: "reload" };

/** ACKs only accept work. A snapshot with the expected identity completes it. */
export async function runSessionAction([set, get, api]: Parameters<StoreSlice<SessionSlice>>, action: Action) {
  const source = get();
  const sourceSessionId = source.sessionId;
  const sourceRuntimeId = source.runtimeId;
  if (source.sessionActionPending) throw new UiError(uiText("A session action is already in progress."));
  const fail = (message: UiText): never => {
    get().setSessionActionError(message);
    throw new UiError(message);
  };
  if (!sourceSessionId) return fail(uiText("Wait for the session to finish syncing."));
  if (source.connection !== "connected") return fail(uiText("Reconnect before starting a session action."));
  if (source.chatStatus !== "ready") return fail(uiText("Wait for the current Pi turn to finish."));
  if (action.method === "reload" && !sourceRuntimeId) return fail(uiText("Wait for the runtime to finish syncing."));
  if (
    action.method === "switch_session" &&
    (!action.id || !action.targetSessionId || action.targetSessionId === sourceSessionId)
  ) {
    return fail(uiText("Select a different saved session."));
  }

  set({ sessionActionPending: true, sessionActionError: null, sessionActionNotice: null, error: null });
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  try {
    await new Promise<void>((resolve, reject) => {
      unsubscribe = api.subscribe((state) => {
        if (state.sessionActionError) {
          reject(new UiError(state.sessionActionError));
          return;
        }
        if (!state.sessionId) return;
        if (action.method === "reload") {
          if (state.sessionId !== sourceSessionId)
            reject(new UiError(uiText("Session changed unexpectedly during reload. Check the active session.")));
          else if (state.runtimeId && state.runtimeId !== sourceRuntimeId) resolve();
        } else if (action.method === "switch_session") {
          if (state.sessionId === action.targetSessionId) resolve();
          else if (state.sessionId !== sourceSessionId)
            reject(new UiError(uiText("A different session became active instead of the selected session.")));
        } else if (state.sessionId !== sourceSessionId) resolve();
      });
      timer = setTimeout(
        () =>
          reject(
            new UiError(
              uiText(
                "Session action did not finish within 20 seconds. Reconnect and check the active session before trying again.",
              ),
            ),
          ),
        20_000,
      );
      const params =
        action.method === "fork_session"
          ? { action: action.action, entryId: action.entryId, sessionId: sourceSessionId }
          : action.method === "switch_session"
            ? ({ id: action.id, sessionId: sourceSessionId } satisfies SwitchSessionRequest)
            : ({ sessionId: sourceSessionId } satisfies ReloadRequest);
      void get()
        .send(action.method, params)
        .then((result) => {
          if (!active || action.method === "fork_session") return;
          const ack = result as SwitchSessionAck | ReloadAck | undefined;
          if (
            !ack?.accepted ||
            ack.sessionId !== sourceSessionId ||
            (action.method === "switch_session" &&
              (ack as SwitchSessionAck).targetSessionId !== action.targetSessionId) ||
            (action.method === "reload" && (ack as ReloadAck).runtimeId !== sourceRuntimeId)
          ) {
            reject(
              new UiError(
                uiText("Session action acknowledgement did not match the requested session. Check the active session."),
              ),
            );
          }
        })
        .catch((error: unknown) => {
          // Reload can close the socket before delivering its ACK. Keep waiting
          // for reconnect's snapshot, never resend the lifecycle request.
          if (active && !(error instanceof Error && error.message.includes("WebSocket disconnected"))) reject(error);
        });
    });
    const text = uiText("{result} Run /webui in Pi again to enable session controls.", {
      result:
        action.method === "reload"
          ? uiText("Runtime reloaded.")
          : action.method === "switch_session"
            ? uiText("Resumed the selected session.")
            : action.action === "clone"
              ? uiText("Cloned to a new session.")
              : uiText("Forked to a new session."),
    });
    set({ sessionActionNotice: text, advancedFeatures: false });
    get().addSystemMessage(text, "success");
  } catch (error) {
    get().setSessionActionError(errorUiText(error, uiText("Session action failed")));
    throw error;
  } finally {
    active = false;
    unsubscribe();
    if (timer) clearTimeout(timer);
    set({ sessionActionPending: false });
  }
}
