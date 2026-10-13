import type { RpcEvent, StateSyncPayload, WsEvent } from "../types";
import { uiText } from "../ui-text";
import type { PiWebUiStore } from "./types";

export function dispatchPiEvent(store: PiWebUiStore, data: WsEvent) {
  const payload = data.payload ?? {};
  if (data.event === "state_sync") {
    store.applyStateSync(payload as StateSyncPayload);
    return;
  }
  if (data.event === "webui_state") {
    store.applyWebUiState(payload);
    return;
  }

  const event = { type: data.event, ...payload } as RpcEvent;
  switch (event.type) {
    case "agent_start":
      store.applyAgentStart();
      break;
    case "agent_end":
      store.applyAgentEnd();
      break;
    case "turn_end":
    case "session_tree":
      void store.requestConversationSync({ debounce: true });
      store.requestGitStatusRefresh({ debounce: true });
      break;
    case "message_start":
      store.applyMessageStart(event);
      break;
    case "message_update":
      store.applyMessageUpdate(event);
      break;
    case "message_end":
      store.applyMessageEnd(event);
      break;
    case "tool_execution_start":
      store.applyToolExecutionStart(event);
      break;
    case "tool_execution_update":
      store.applyToolExecutionUpdate(event);
      break;
    case "tool_execution_end":
      store.applyToolExecutionEnd(event);
      break;
    case "auto_compaction_start":
      store.addSystemMessage(uiText("Compacting context..."));
      break;
    case "auto_compaction_end":
      store.addSystemMessage(
        uiText("Context compacted{summary}", { summary: event.summary ? `: ${event.summary}` : "" }),
        "success",
      );
      store.setLastUsage(null);
      break;
    case "extension_ui_request":
      if (event.id && event.method) {
        store.setDialog({
          id: event.id,
          method: event.method,
          title: event.title,
          message: event.message as string | undefined,
          options: event.options,
          timeout: event.timeout,
          placeholder: event.placeholder,
          prefill: event.prefill,
        });
      }
      break;
    case "extension_error":
      store.addSystemMessage(
        uiText("Extension error: {error}", { error: event.error || uiText("Unknown error") }),
        "error",
      );
      break;
    case "webui_command_error":
      store.setSessionActionError(typeof event.message === "string" ? event.message : uiText("Web UI command failed"));
      break;
    case "session_name":
    case "session_info_changed":
      if (event.name === undefined || typeof event.name === "string") store.setSessionName(event.name || "Pi Web UI");
      break;
    case "auth_changed":
      store.setAuthEnabled(Boolean(event.enabled));
      break;
    case "arch:state-changed":
      store.setArchModeEnabled(Boolean(event.enabled));
      break;
    case "model_select":
      if (event.model) {
        store.setCurrentModel(event.model);
        void store.refreshSettingsState();
      }
      break;
    case "thinking_level_select":
      if (typeof event.level === "string") store.setThinkingLevel(event.level);
      if (Array.isArray(event.availableThinkingLevels)) {
        store.setAvailableThinkingLevels(
          event.availableThinkingLevels.filter((level): level is string => typeof level === "string"),
        );
      }
      break;
    default:
      break;
  }
}
