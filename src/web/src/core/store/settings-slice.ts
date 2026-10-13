import { shortModelName } from "../format";
import { readPreference } from "../storage";
import type { BrowserCommandInfo } from "../types";
import { errorUiText, uiText } from "../ui-text";
import type { AuthStateResult, SettingsSlice, SettingsStateResult, StoreSlice } from "./types";

const initialThemeMode = () =>
  (readPreference("pi-web-ui-theme-mode") as SettingsSlice["themeMode"] | null) || "system";
const initialShowThinking = () => readPreference("pi-web-ui-show-thinking") !== "false";

export const createSettingsSlice: StoreSlice<SettingsSlice> = (set, get) => ({
  availableModels: [],
  currentModel: null,
  modelLabel: "model",
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  commands: [],
  sessionName: "Pi Web UI",
  autoCompaction: true,
  authConfigured: false,
  authEnabled: false,
  archModeEnabled: false,
  themeMode: initialThemeMode(),
  showThinking: initialShowThinking(),

  refreshSettingsState: async () => {
    try {
      const [stateResult, modelsResult, commandsResult] = await Promise.allSettled([
        get().send("get_state"),
        get().send("get_available_models"),
        get().send("get_commands"),
      ]);

      if (modelsResult.status === "fulfilled") {
        const data = modelsResult.value as { models?: SettingsSlice["availableModels"] };
        set({ availableModels: data.models || [] });
      }
      if (commandsResult.status === "fulfilled") {
        const data = commandsResult.value as { commands?: BrowserCommandInfo[] };
        set({ commands: data.commands || [] });
      }

      if (stateResult.status === "fulfilled") {
        const data = (stateResult.value || {}) as SettingsStateResult;
        set({
          autoCompaction: Boolean(data.autoCompactionEnabled),
          currentModel: data.model || null,
          modelLabel: shortModelName(data.model?.id || "model"),
          sessionName: data.sessionName || "Pi Web UI",
          thinkingLevel: data.thinkingLevel || "off",
          availableThinkingLevels: data.availableThinkingLevels || ["off"],
          ...(data.model?.contextWindow && { contextWindowSize: data.model.contextWindow }),
        });
      }
    } catch (error) {
      console.error("[pi-web-ui] get_state failed", error);
    }
  },

  refreshAuthState: async () => {
    await get().refreshSettingsState();
    try {
      const result = (await get().send("get_auth")) as AuthStateResult | undefined;
      set({ authConfigured: Boolean(result?.configured), authEnabled: Boolean(result?.enabled) });
    } catch {
      set({ authConfigured: false });
    }
  },

  setAvailableModels: (availableModels) => set({ availableModels }),
  setCurrentModel: (currentModel) =>
    set({
      currentModel,
      modelLabel: shortModelName(currentModel?.id || "model"),
      ...(currentModel?.contextWindow && { contextWindowSize: currentModel.contextWindow }),
    }),
  setThinkingLevel: (thinkingLevel) => set({ thinkingLevel }),
  setAvailableThinkingLevels: (availableThinkingLevels) => set({ availableThinkingLevels }),
  setCommands: (commands: BrowserCommandInfo[]) => set({ commands }),
  setSessionName: (sessionName) => set({ sessionName }),
  setAutoCompaction: (autoCompaction) => set({ autoCompaction }),
  setAuthEnabled: (authEnabled) => set({ authEnabled }),
  setArchModeEnabled: (archModeEnabled) => set({ archModeEnabled }),
  setThemeMode: (themeMode) => set({ themeMode }),
  setShowThinking: (showThinking) => set({ showThinking }),

  cycleThinking: async () => {
    try {
      const result = (await get().send("cycle_thinking_level")) as
        | { level?: string; thinkingLevel?: string; availableThinkingLevels?: string[] }
        | undefined;
      set({
        thinkingLevel: result?.level || result?.thinkingLevel || "off",
        ...(result?.availableThinkingLevels && { availableThinkingLevels: result.availableThinkingLevels }),
      });
    } catch (error) {
      get().setError(errorUiText(error, uiText("Failed to change thinking level")));
    }
  },

  selectModel: async (model) => {
    try {
      const result = (await get().send("set_model", { provider: model.provider, modelId: model.id })) as
        | { model?: SettingsSlice["currentModel"]; thinkingLevel?: string; availableThinkingLevels?: string[] }
        | undefined;
      const selectedModel = result?.model || model;
      set({
        currentModel: selectedModel,
        modelLabel: shortModelName(selectedModel.id),
        ...(selectedModel.contextWindow && { contextWindowSize: selectedModel.contextWindow }),
        ...(result?.thinkingLevel && { thinkingLevel: result.thinkingLevel }),
        ...(result?.availableThinkingLevels && { availableThinkingLevels: result.availableThinkingLevels }),
      });
    } catch (error) {
      get().setError(errorUiText(error, uiText("Failed to switch model")));
    }
  },

  setAutoCompactionRemote: async (enabled) => {
    set({ autoCompaction: enabled });
    await get().send("set_auto_compaction", { enabled });
  },

  toggleAuth: async () => {
    try {
      const result = (await get().send("set_auth", { enabled: !get().authEnabled })) as
        | { enabled?: boolean }
        | undefined;
      set({ authEnabled: Boolean(result?.enabled) });
    } catch (error) {
      get().setError(errorUiText(error, uiText("Failed to update auth")));
    }
  },

  toggleArchMode: () => {
    get()
      .send(get().archModeEnabled ? "exit_arch_mode" : "enter_arch_mode")
      .catch((error) => get().setError(errorUiText(error, uiText("Arch mode toggle failed"))));
  },

  renameActiveSession: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await get().send("set_session_name", { name: trimmed });
      set({ sessionName: trimmed });
    } catch (error) {
      get().setError(errorUiText(error, uiText("Rename failed")));
    }
  },
});
