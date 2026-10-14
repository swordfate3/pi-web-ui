import type { StateCreator } from "zustand";
import type { PiClient } from "../pi-client";
import type {
  BrowserCommandInfo,
  ChatItem,
  ChatSubmitStatus,
  ConnectionState,
  ExtensionDialog,
  FileContentResult,
  GitDiffResult,
  GitStatusResult,
  ModelInfo,
  PromptCommand,
  RightPanelTab,
  RpcEvent,
  SessionTreeNode,
  StateSyncPayload,
  SystemTone,
  ThemeMode,
  Usage,
  WebConnectionInfo,
  WorkspaceArtifact,
} from "../types";
import type { UiText } from "../ui-text";

export type ConnectionSlice = {
  client: PiClient | null;
  connection: ConnectionState;
  error: UiText | null;
  advancedFeatures: boolean;
  archAvailable: boolean;
  setClient: (client: PiClient | null) => void;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  getWebConnection: () => Promise<WebConnectionInfo>;
  setConnection: (connection: ConnectionState) => void;
  setError: (error: UiText | null) => void;
  applyWebUiState: (payload: Record<string, unknown>) => void;
};

export type SessionSlice = {
  items: ChatItem[];
  chatStatus: ChatSubmitStatus;
  tree: SessionTreeNode[];
  leafId: string | null;
  sessionId: string | null;
  runtimeId: string | null;
  sessionActionPending: boolean;
  sessionActionError: UiText | null;
  sessionActionNotice: UiText | null;
  forkSession: (action: "fork" | "clone", entryId?: string) => Promise<void>;
  resumeSession: (id: string, targetSessionId: string) => Promise<void>;
  reloadRuntime: () => Promise<void>;
  setSessionActionError: (message: UiText) => void;
  selectedTreeEntryId: string | null;
  loadingTreeEntryId: string | null;
  conversationSyncing: boolean;
  conversationSyncError: UiText | null;
  lastUsage: Usage | null;
  contextWindowSize: number;
  addSystemMessage: (text: UiText, tone?: SystemTone) => void;
  applyStateSync: (sync: StateSyncPayload) => void;
  requestConversationSync: (options?: { debounce?: boolean }) => Promise<void> | void;
  clearConversationTimers: () => void;
  setChatStatus: (status: ChatSubmitStatus) => void;
  setSelectedTreeEntryId: (entryId: string | null) => void;
  setLoadingTreeEntryId: (entryId: string | null) => void;
  setLastUsage: (usage: Usage | null) => void;
  setContextWindowSize: (size: number) => void;
  sendPrompt: (command: PromptCommand) => Promise<void>;
  abort: () => Promise<void>;
  toggleAllTools: (open: boolean) => void;
  toggleTool: (id: string, open: boolean) => void;
  applyAgentStart: () => void;
  applyAgentEnd: () => void;
  applyMessageStart: (event: RpcEvent) => void;
  applyMessageUpdate: (event: RpcEvent) => void;
  applyMessageEnd: (event: RpcEvent) => void;
  applyToolExecutionStart: (event: RpcEvent) => void;
  applyToolExecutionUpdate: (event: RpcEvent) => void;
  applyToolExecutionEnd: (event: RpcEvent) => void;
  markPromptReady: () => void;
};

export type SettingsSlice = {
  availableModels: ModelInfo[];
  currentModel: ModelInfo | null;
  modelLabel: string;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  commands: BrowserCommandInfo[];
  sessionName: string;
  autoCompaction: boolean;
  authConfigured: boolean;
  authEnabled: boolean;
  archModeEnabled: boolean;
  themeMode: ThemeMode;
  showThinking: boolean;
  refreshSettingsState: () => Promise<void>;
  refreshAuthState: () => Promise<void>;
  setAvailableModels: (models: ModelInfo[]) => void;
  setCurrentModel: (model: ModelInfo | null) => void;
  setThinkingLevel: (level: string) => void;
  setAvailableThinkingLevels: (levels: string[]) => void;
  setCommands: (commands: BrowserCommandInfo[]) => void;
  setSessionName: (name: string) => void;
  setAutoCompaction: (enabled: boolean) => void;
  setAuthEnabled: (enabled: boolean) => void;
  setArchModeEnabled: (enabled: boolean) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setShowThinking: (show: boolean) => void;
  cycleThinking: () => Promise<void>;
  selectModel: (model: ModelInfo) => Promise<void>;
  setAutoCompactionRemote: (enabled: boolean) => Promise<void>;
  toggleAuth: () => Promise<void>;
  toggleArchMode: () => void;
  renameActiveSession: (name: string) => Promise<void>;
};

export type WorkspaceSlice = {
  gitStatus: GitStatusResult | null;
  gitLoading: boolean;
  artifacts: WorkspaceArtifact[];
  setArtifacts: (artifacts: WorkspaceArtifact[]) => void;
  mergeArtifactsFromToolEvent: (event: RpcEvent) => void;
  refreshGitStatus: () => Promise<void>;
  requestGitStatusRefresh: (options?: { debounce?: boolean }) => void;
  clearWorkspaceTimers: () => void;
};

export type RightPanelSlice = {
  rightPanelTabs: RightPanelTab[];
  activeRightPanelTabId: string | null;
  rightPanelVisible: boolean;
  rightPanelHasOpened: boolean;
  upsertRightPanelTab: (tab: RightPanelTab) => void;
  openGitDiff: () => Promise<void>;
  openArtifact: (artifact: WorkspaceArtifact) => Promise<void>;
  refreshRightPanelTab: (tab: RightPanelTab) => void;
  closeRightPanelTab: (id: string) => void;
  setActiveRightPanelTabId: (id: string | null) => void;
  toggleRightPanelVisible: () => void;
};

export type DialogSlice = {
  dialog: ExtensionDialog | null;
  setDialog: (dialog: ExtensionDialog | null) => void;
  respondDialog: (response: Record<string, unknown>) => void;
};

export type PiWebUiStore = ConnectionSlice &
  SessionSlice &
  SettingsSlice &
  WorkspaceSlice &
  RightPanelSlice &
  DialogSlice;

export type StoreSlice<T> = StateCreator<PiWebUiStore, [], [], T>;

export type SettingsStateResult = {
  model?: ModelInfo;
  thinkingLevel?: string;
  availableThinkingLevels?: string[];
  sessionName?: string;
  autoCompactionEnabled?: boolean;
};

export type AuthStateResult = {
  configured?: boolean;
  enabled?: boolean;
};

export type { SessionStatsResult } from "../types";

export type { FileContentResult, GitDiffResult };
