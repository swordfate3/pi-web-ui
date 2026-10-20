import type { WebConnectionInfo } from "../types";
import { UiError, uiText } from "../ui-text";
import type { ConnectionSlice, StoreSlice } from "./types";

export const createConnectionSlice: StoreSlice<ConnectionSlice> = (set, get) => ({
  client: null,
  connection: "connecting",
  error: null,
  advancedFeatures: false,
  archAvailable: false,

  setClient: (client) => set({ client }),

  send: async (method, params) => {
    const client = get().client;
    if (!client) throw new UiError(uiText("Pi client is not connected"));
    return client.send(method, params);
  },

  setConnection: (connection) => {
    if (connection !== "connected") get().closeEntryDetail?.();
    set({ connection });
  },
  getWebConnection: async () => (await get().send("get_web_connection")) as WebConnectionInfo,
  setError: (error) => set({ error }),

  applyWebUiState: (payload) => {
    const next: Partial<ConnectionSlice> = {};
    if (typeof payload.advancedFeatures === "boolean") next.advancedFeatures = payload.advancedFeatures;
    if (typeof payload.archAvailable === "boolean") next.archAvailable = payload.archAvailable;
    if (Object.keys(next).length > 0) set(next);
  },
});
