import { parseTerminalPrompt } from "../terminal-prompt";
import type { DialogSlice, StoreSlice } from "./types";

export const createDialogSlice: StoreSlice<DialogSlice> = (set, get) => ({
  dialog: null,
  terminalPrompt: null,
  applyTerminalPrompt: (payload, started) => {
    if (
      get().connection !== "connected" ||
      !get().sessionId ||
      !get().runtimeId ||
      payload.sessionId !== get().sessionId ||
      payload.runtimeId !== get().runtimeId
    )
      return;
    const prompt = parseTerminalPrompt(payload);
    if (!prompt) return;
    set({ terminalPrompt: started ? prompt : null });
  },

  setDialog: (dialog) => set({ dialog }),

  respondDialog: (response) => {
    const dialog = get().dialog;
    if (!dialog) return;
    get()
      .send("extension_ui_response", { id: dialog.id, ...response })
      .catch((error: unknown) => {
        get().setError(error instanceof Error ? error.message : "Respond in the Pi terminal.");
      });
    set({ dialog: null });
  },
});
