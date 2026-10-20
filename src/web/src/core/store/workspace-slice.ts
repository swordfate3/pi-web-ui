import { retainWindowArtifacts } from "../conversation-window";
import type { FileDownloadResult, GitStatusResult } from "../types";
import { UiError, uiText } from "../ui-text";
import { artifactsFromToolEvent, mergeArtifacts } from "../workspace-artifacts";
import type { StoreSlice, WorkspaceSlice } from "./types";

let gitRefreshTimer: number | null = null;

export const createWorkspaceSlice: StoreSlice<WorkspaceSlice> = (set, get) => ({
  gitStatus: null,
  gitLoading: false,
  artifacts: [],

  prepareFileDownload: async (path) => {
    const { sessionId, runtimeId, connection } = get();
    if (!sessionId || !runtimeId || connection !== "connected")
      throw new UiError(uiText("Reconnect and click the file again."));
    const result = await get().send("prepare_file_download", { path, sessionId, runtimeId });
    if (get().sessionId !== sessionId || get().runtimeId !== runtimeId || get().connection !== "connected")
      throw new UiError(uiText("Reconnect and click the file again."));
    return result as FileDownloadResult;
  },

  setArtifacts: (artifacts) => set({ artifacts: retainWindowArtifacts(artifacts, get().items) }),

  mergeArtifactsFromToolEvent: (event) => {
    const incoming = artifactsFromToolEvent(event);
    if (incoming.length === 0) return;
    set((state) => ({ artifacts: retainWindowArtifacts(mergeArtifacts(state.artifacts, incoming), state.items) }));
  },

  refreshGitStatus: async () => {
    set({ gitLoading: true });
    try {
      set({ gitStatus: (await get().send("get_git_status")) as GitStatusResult });
    } catch (error) {
      console.error("[pi-web-ui] get_git_status failed", error);
      set({ gitStatus: null });
    } finally {
      set({ gitLoading: false });
    }
  },

  requestGitStatusRefresh: (options) => {
    if (options?.debounce) {
      if (gitRefreshTimer) window.clearTimeout(gitRefreshTimer);
      gitRefreshTimer = window.setTimeout(() => {
        gitRefreshTimer = null;
        void get().refreshGitStatus();
      }, 350);
      return;
    }
    void get().refreshGitStatus();
  },

  clearWorkspaceTimers: () => {
    if (gitRefreshTimer) window.clearTimeout(gitRefreshTimer);
    gitRefreshTimer = null;
  },
});
