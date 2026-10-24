import { ArchiveIcon, BarChart3Icon, DownloadIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, XIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import {
  AppHeader,
  ChatInput,
  CommandPalette,
  ContextPopover,
  ConversationSidebar,
  ExtensionDialogView,
  type ForkableMessage,
  ForkMessagePicker,
  ModelPicker,
  RightPanel,
  SettingsPanel,
  WorkspaceStatusFloat,
} from "./components/pi-web-ui";
import { ChatList } from "./components/pi-web-ui/chat-list";
import { HistoryControls } from "./components/pi-web-ui/history-controls";
import { InteractionCenter } from "./components/pi-web-ui/interaction-panel";
import { MessageRevisionDialog } from "./components/pi-web-ui/message-revision-dialog";
import { RemoteAccessPanel } from "./components/pi-web-ui/remote-access-panel";
import { ResumeSessionPicker } from "./components/pi-web-ui/resume-session-picker";
import { SessionDetails, sessionStatsSummary } from "./components/pi-web-ui/session-details";
import { TerminalPromptBanner } from "./components/pi-web-ui/terminal-prompt-banner";
import { WhalePet } from "./components/pi-web-ui/whale-pet";
import { type WhaleMode, WhaleSettings } from "./components/pi-web-ui/whale-settings";
import { extractText } from "./core/chat-conversion";
import { downloadExport } from "./core/export-download";
import { copyText, isEditableTarget } from "./core/format";
import { recentHistoryRange } from "./core/history-dates";
import { t, useLanguage, workspaceUploadText } from "./core/i18n";
import { parseMessageVersionSwitch, versionSwitchDeadline } from "./core/message-versions";
import { loadMessageVersionHistory } from "./core/message-versions-scope";
import { PiClient } from "./core/pi-client";
import {
  canDispatchQueuedPrompt,
  createQueuedPrompt,
  navigationResultIsCurrent,
  type QueuedPrompt,
  queuedPromptMatchesScope,
} from "./core/queued-prompt";
import { cancelSavedSessionPicker } from "./core/saved-session-picker";
import { createScopedSubmitLock } from "./core/scoped-submit";
import { readPreference, writePreference } from "./core/storage";
import { usePiWebUiStore } from "./core/store";
import { dispatchPiEvent } from "./core/store/event-dispatch";
import type {
  ChatItem,
  ExportHtmlResult,
  HistoryRange,
  MessageRevisionMode,
  MessageRevisionPreview,
  PromptCommand,
  SavedSession,
  SavedSessionsResult,
  SessionStatsResult,
} from "./core/types";
import { errorUiText, renderUiText, UiError, uiRelativeTime, uiText } from "./core/ui-text";
import { useMessageVersions } from "./core/use-message-versions";
import { useWhaleAssets } from "./core/whale-assets";
import {
  MAX_WORKSPACE_UPLOAD_BYTES,
  MAX_WORKSPACE_UPLOAD_FILES,
  uploadWorkspaceFiles,
  type WorkspaceUploadProgress,
  type WorkspaceUploadReceipt,
} from "./core/workspace-uploads";

const DEFAULT_LEFT_SIDEBAR_WIDTH = 320;
const MIN_LEFT_SIDEBAR_WIDTH = 240;
const MAX_LEFT_SIDEBAR_WIDTH = 560;
const MIN_MAIN_CONTENT_WIDTH = 560;
const LEFT_SIDEBAR_WIDTH_STORAGE_KEY = "pi-web-ui-left-sidebar-width";

export function App() {
  useLanguage();
  const items = usePiWebUiStore((state) => state.items);
  const connection = usePiWebUiStore((state) => state.connection);
  const chatStatus = usePiWebUiStore((state) => state.chatStatus);
  const modelLabel = usePiWebUiStore((state) => state.modelLabel);
  const currentModel = usePiWebUiStore((state) => state.currentModel);
  const thinkingLevel = usePiWebUiStore((state) => state.thinkingLevel);
  const availableThinkingLevels = usePiWebUiStore((state) => state.availableThinkingLevels);
  const commands = usePiWebUiStore((state) => state.commands);
  const sessionName = usePiWebUiStore((state) => state.sessionName);
  const error = usePiWebUiStore((state) => state.error);
  const advancedFeatures = usePiWebUiStore((state) => state.advancedFeatures);
  const archModeEnabled = usePiWebUiStore((state) => state.archModeEnabled);
  const archAvailable = usePiWebUiStore((state) => state.archAvailable);
  const tree = usePiWebUiStore((state) => state.tree);
  const leafId = usePiWebUiStore((state) => state.leafId);
  const sessionId = usePiWebUiStore((state) => state.sessionId);
  const runtimeId = usePiWebUiStore((state) => state.runtimeId);
  const sessionActionPending = usePiWebUiStore((state) => state.sessionActionPending);
  const sessionActionError = usePiWebUiStore((state) => state.sessionActionError);
  const resumeSession = usePiWebUiStore((state) => state.resumeSession);
  const reloadRuntime = usePiWebUiStore((state) => state.reloadRuntime);
  const forkSession = usePiWebUiStore((state) => state.forkSession);
  const selectedTreeEntryId = usePiWebUiStore((state) => state.selectedTreeEntryId);
  const loadingTreeEntryId = usePiWebUiStore((state) => state.loadingTreeEntryId);
  const conversationSyncing = usePiWebUiStore((state) => state.conversationSyncing);
  const conversationSyncError = usePiWebUiStore((state) => state.conversationSyncError);
  const transportNotice = usePiWebUiStore((state) => state.transportNotice);
  const dismissTransportNotice = usePiWebUiStore((state) => state.dismissTransportNotice);
  const availableModels = usePiWebUiStore((state) => state.availableModels);
  const showThinking = usePiWebUiStore((state) => state.showThinking);
  const autoCompaction = usePiWebUiStore((state) => state.autoCompaction);
  const authConfigured = usePiWebUiStore((state) => state.authConfigured);
  const authEnabled = usePiWebUiStore((state) => state.authEnabled);
  const dialog = usePiWebUiStore((state) => state.dialog);
  const gitStatus = usePiWebUiStore((state) => state.gitStatus);
  const gitLoading = usePiWebUiStore((state) => state.gitLoading);
  const artifacts = usePiWebUiStore((state) => state.artifacts);
  const rightPanelTabs = usePiWebUiStore((state) => state.rightPanelTabs);
  const activeRightPanelTabId = usePiWebUiStore((state) => state.activeRightPanelTabId);
  const rightPanelVisible = usePiWebUiStore((state) => state.rightPanelVisible);
  const rightPanelHasOpened = usePiWebUiStore((state) => state.rightPanelHasOpened);
  const lastUsage = usePiWebUiStore((state) => state.lastUsage);
  const contextWindowSize = usePiWebUiStore((state) => state.contextWindowSize);
  const themeMode = usePiWebUiStore((state) => state.themeMode);
  const abort = usePiWebUiStore((state) => state.abort);
  const addSystemMessage = usePiWebUiStore((state) => state.addSystemMessage);
  const clearConversationTimers = usePiWebUiStore((state) => state.clearConversationTimers);
  const clearWorkspaceTimers = usePiWebUiStore((state) => state.clearWorkspaceTimers);
  const compactSend = usePiWebUiStore((state) => state.send);
  const cycleThinking = usePiWebUiStore((state) => state.cycleThinking);
  const openArtifact = usePiWebUiStore((state) => state.openArtifact);
  const openGitDiff = usePiWebUiStore((state) => state.openGitDiff);
  const refreshAuthState = usePiWebUiStore((state) => state.refreshAuthState);
  const refreshRightPanelTab = usePiWebUiStore((state) => state.refreshRightPanelTab);
  const refreshSettingsState = usePiWebUiStore((state) => state.refreshSettingsState);
  const requestConversationSync = usePiWebUiStore((state) => state.requestConversationSync);
  const renameActiveSession = usePiWebUiStore((state) => state.renameActiveSession);
  const respondDialog = usePiWebUiStore((state) => state.respondDialog);
  const selectModel = usePiWebUiStore((state) => state.selectModel);
  const sendPrompt = usePiWebUiStore((state) => state.sendPrompt);
  const setActiveRightPanelTabId = usePiWebUiStore((state) => state.setActiveRightPanelTabId);
  const setClient = usePiWebUiStore((state) => state.setClient);
  const setConnection = usePiWebUiStore((state) => state.setConnection);
  const setError = usePiWebUiStore((state) => state.setError);
  const setLoadingTreeEntryId = usePiWebUiStore((state) => state.setLoadingTreeEntryId);
  const setSelectedTreeEntryId = usePiWebUiStore((state) => state.setSelectedTreeEntryId);
  const setShowThinking = usePiWebUiStore((state) => state.setShowThinking);
  const setThemeMode = usePiWebUiStore((state) => state.setThemeMode);
  const setThinkingLevel = usePiWebUiStore((state) => state.setThinkingLevel);
  const setAutoCompactionRemote = usePiWebUiStore((state) => state.setAutoCompactionRemote);
  const closeRightPanelTab = usePiWebUiStore((state) => state.closeRightPanelTab);
  const toggleAllTools = usePiWebUiStore((state) => state.toggleAllTools);
  const toggleArchMode = usePiWebUiStore((state) => state.toggleArchMode);
  const toggleAuth = usePiWebUiStore((state) => state.toggleAuth);
  const toggleRightPanelVisible = usePiWebUiStore((state) => state.toggleRightPanelVisible);
  const toggleTool = usePiWebUiStore((state) => state.toggleTool);

  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  const openConversationSidebar = useCallback(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarMobileOpen(true);
    else setSidebarOpen(true);
  }, []);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() => {
    const storedWidth = Number(readPreference(LEFT_SIDEBAR_WIDTH_STORAGE_KEY));
    const requestedWidth = Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : DEFAULT_LEFT_SIDEBAR_WIDTH;
    const maxWidth = Math.max(
      MIN_LEFT_SIDEBAR_WIDTH,
      Math.min(MAX_LEFT_SIDEBAR_WIDTH, window.innerWidth - MIN_MAIN_CONTENT_WIDTH),
    );
    return Math.min(maxWidth, Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.round(requestedWidth)));
  });
  const [highlightedEntryId, setHighlightedEntryId] = useState<string | null>(null);
  const [draftText, setDraftTextState] = useState("");
  const draftTextRef = useRef(draftText);
  const draftVersionRef = useRef(0);
  const updateDraftText = useCallback((text: string) => {
    draftVersionRef.current++;
    draftTextRef.current = text;
    setDraftTextState(text);
  }, []);
  const [hasSelectedFiles, setHasSelectedFiles] = useState(false);
  const [messageRevision, setMessageRevision] = useState<{
    mode: MessageRevisionMode;
    text: string;
    preview: MessageRevisionPreview | null;
    loading: boolean;
    submitting: boolean;
    error: string | null;
  } | null>(null);
  const revisionRequestRef = useRef(0);
  const [uploadProgress, setUploadProgress] = useState<WorkspaceUploadProgress[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [attachmentHandoff, setAttachmentHandoff] = useState(false);
  const uploadControllerRef = useRef<AbortController | null>(null);
  const uploadReceiptsRef = useRef(new Map<string, WorkspaceUploadReceipt>());
  const [routePath, setRoutePath] = useState(() => window.location.pathname);
  const uploadScopeKey = `${sessionId ?? ""}\0${runtimeId ?? ""}\0${routePath}`;

  const [queuedMessages, setQueuedMessages] = useState<QueuedPrompt[]>([]);
  const [pausedQueuedPromptIds, setPausedQueuedPromptIds] = useState<string[]>([]);
  const queueDispatchingRef = useRef<string | null>(null);
  const treeNavigationRef = useRef<{
    token: symbol;
    entryId: string;
    sessionId: string | null;
    runtimeId: string | null;
    draftText: string;
    draftVersion: number;
  } | null>(null);
  const treeNavigationScopeRef = useRef(`${sessionId ?? ""}\0${runtimeId ?? ""}`);
  const [versionsRefreshKey, setVersionsRefreshKey] = useState(0);
  const messageVersions = useMessageVersions(items, versionsRefreshKey);

  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [whalePositionResetKey, setWhalePositionResetKey] = useState(0);
  const [whaleMode, setWhaleMode] = useState<WhaleMode>(() => {
    const mode = readPreference("pi-web-ui-whale-mode");
    return mode === "hidden" || mode === "compact" ? mode : "full";
  });
  const [whaleReduceMotion, setWhaleReduceMotion] = useState(
    () => readPreference("pi-web-ui-whale-reduce-motion") === "true",
  );
  const whaleAssets = useWhaleAssets(whaleReduceMotion);
  const changeWhaleMode = (mode: WhaleMode) => {
    setWhaleMode(mode);
    writePreference("pi-web-ui-whale-mode", mode);
  };
  const changeWhaleMotion = (value: boolean) => {
    setWhaleReduceMotion(value);
    writePreference("pi-web-ui-whale-reduce-motion", String(value));
  };
  const [remoteAccess, setRemoteAccess] = useState<"access" | "login" | null>(() =>
    location.hash === "#remote-access" ? "access" : null,
  );
  const [remoteHint, setRemoteHint] = useState(() => !readPreference("pi-web-ui-remote-hint-seen"));
  const closeRemoteAccess = () => {
    setRemoteAccess(null);
    setRemoteHint(false);
    writePreference("pi-web-ui-remote-hint-seen", "1");
    if (location.hash === "#remote-access") history.replaceState(null, "", location.pathname + location.search);
  };
  const [commandOpen, setCommandOpen] = useState(false);
  const [statusOverlay, setStatusOverlay] = useState<"context" | "workspace" | null>(null);
  const contextOpen = statusOverlay === "context";
  const workspaceOpen = statusOverlay === "workspace";
  const [forkPickerMessages, setForkPickerMessages] = useState<ForkableMessage[] | null>(null);
  const [resumeListing, setResumeListing] = useState<SavedSessionsResult | null>(null);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [sessionDetails, setSessionDetails] = useState<SessionStatsResult | null>(null);
  const resumeSourceRuntimeRef = useRef<string | null>(null);
  const resumeRequestRef = useRef(0);
  const closeResumePicker = useCallback(() => {
    cancelSavedSessionPicker(resumeRequestRef, () => {
      setResumeLoading(false);
      setResumeListing(null);
    });
  }, []);
  const forkPickerSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (forkPickerSessionIdRef.current !== sessionId) setForkPickerMessages(null);
    setSessionDetails(null);
  }, [sessionId]);

  useLayoutEffect(() => {
    const scope = `${sessionId ?? ""}\0${runtimeId ?? ""}`;
    if (treeNavigationScopeRef.current === scope) return;
    treeNavigationScopeRef.current = scope;
    const operation = treeNavigationRef.current;
    if (operation && (operation.sessionId !== sessionId || operation.runtimeId !== runtimeId)) {
      treeNavigationRef.current = null;
      if (usePiWebUiStore.getState().loadingTreeEntryId === operation.entryId) setLoadingTreeEntryId(null);
    }
  }, [sessionId, runtimeId, setLoadingTreeEntryId]);

  useEffect(() => {
    const updatePath = () => setRoutePath(window.location.pathname);
    window.addEventListener("popstate", updatePath);
    window.addEventListener("pi-web-route-changed", updatePath);
    return () => {
      window.removeEventListener("popstate", updatePath);
      window.removeEventListener("pi-web-route-changed", updatePath);
    };
  }, []);

  const activeUploadScopeRef = useRef(uploadScopeKey);
  useLayoutEffect(() => {
    if (activeUploadScopeRef.current === uploadScopeKey) return;
    activeUploadScopeRef.current = uploadScopeKey;
    uploadControllerRef.current?.abort();
    uploadControllerRef.current = null;
    uploadReceiptsRef.current.clear();
    setUploadProgress([]);
    setUploadingAttachments(false);
    setAttachmentHandoff(false);
  }, [uploadScopeKey]);

  useEffect(() => () => uploadControllerRef.current?.abort(), []);

  useEffect(() => {
    if (!sessionActionPending) return;
    uploadControllerRef.current?.abort();
    uploadControllerRef.current = null;
    setUploadingAttachments(false);
  }, [sessionActionPending]);

  useEffect(() => {
    if (resumeListing && (resumeListing.sessionId !== sessionId || resumeSourceRuntimeRef.current !== runtimeId)) {
      closeResumePicker();
      setError(uiText("Session or runtime changed. Reopen the session picker."));
    }
  }, [resumeListing, sessionId, runtimeId, setError, closeResumePicker]);

  const itemElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const pendingFocusEntryIdRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const promptCounterRef = useRef(0);
  const runWebUiSlashCommandRef = useRef<(text: string) => Promise<boolean | "preserve">>(async () => false);

  const resolvedTheme = themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  const updateLeftSidebarWidth = useCallback((nextWidth: number) => {
    const maxWidth = Math.max(
      MIN_LEFT_SIDEBAR_WIDTH,
      Math.min(MAX_LEFT_SIDEBAR_WIDTH, window.innerWidth - MIN_MAIN_CONTENT_WIDTH),
    );
    setLeftSidebarWidth(Math.min(maxWidth, Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.round(nextWidth))));
  }, []);

  const nextPromptId = useCallback(() => {
    promptCounterRef.current += 1;
    return `prompt-${Date.now()}-${promptCounterRef.current}`;
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    writePreference("pi-web-ui-theme-mode", themeMode);
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme, themeMode]);

  useEffect(() => {
    writePreference("pi-web-ui-show-thinking", String(showThinking));
  }, [showThinking]);

  useEffect(() => {
    writePreference(LEFT_SIDEBAR_WIDTH_STORAGE_KEY, String(leftSidebarWidth));
  }, [leftSidebarWidth]);

  useEffect(() => {
    const handleResize = () => {
      setLeftSidebarWidth((current) => {
        const maxWidth = Math.max(
          MIN_LEFT_SIDEBAR_WIDTH,
          Math.min(MAX_LEFT_SIDEBAR_WIDTH, window.innerWidth - MIN_MAIN_CONTENT_WIDTH),
        );
        return Math.min(maxWidth, Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.round(current)));
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    // Generation-scoped gateway pages must not cache a former live session.
    if (
      "serviceWorker" in navigator &&
      import.meta.env.PROD &&
      (window.location.pathname === "/" || window.location.pathname === "/index.html")
    ) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  useEffect(() => {
    const client = new PiClient({
      onConnectionChange: setConnection,
      onError: setError,
      onEvent: (event) => dispatchPiEvent(usePiWebUiStore.getState(), event),
      onOpen: () => {
        setError(null);
        const store = usePiWebUiStore.getState();
        void store.refreshSettingsState();
        void store.requestConversationSync();
        // Coalesce with the initial state snapshot's Git refresh instead of
        // running blocking backend Git work twice while entering a session.
        void store.requestGitStatusRefresh({ debounce: true });
      },
      onPromptResponse: (result) => {
        const commandResult = result as
          | {
              command?: string;
              message?: string;
              thinkingLevel?: string;
              availableThinkingLevels?: string[];
            }
          | undefined;
        const store = usePiWebUiStore.getState();
        store.markPromptReady();
        if (commandResult?.command === "thinking") {
          if (commandResult.thinkingLevel) store.setThinkingLevel(commandResult.thinkingLevel);
          if (commandResult.availableThinkingLevels) {
            store.setAvailableThinkingLevels(commandResult.availableThinkingLevels);
          }
          store.addSystemMessage(
            commandResult.message ||
              uiText("Thinking level: {level}{available}", {
                level: commandResult.thinkingLevel || uiText("unknown"),
                available: commandResult.availableThinkingLevels?.length
                  ? uiText(" · Available: {levels}", { levels: commandResult.availableThinkingLevels.join(", ") })
                  : "",
              }),
          );
        } else if (typeof commandResult?.message === "string") {
          store.addSystemMessage(commandResult.message, "success");
        }
      },
    });
    setClient(client);
    client.connect();

    return () => {
      client.disconnect();
      setClient(null);
      clearConversationTimers();
      clearWorkspaceTimers();
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    };
  }, [clearConversationTimers, clearWorkspaceTimers, setClient, setConnection, setError]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") usePiWebUiStore.getState().client?.ensureConnected();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      const store = usePiWebUiStore.getState();
      store.client?.ensureConnected();
      if (store.connection === "connected") void store.requestConversationSync();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  useEffect(() => {
    setPausedQueuedPromptIds((current) => {
      const staleIds = queuedMessages
        .filter((queued) => !queuedPromptMatchesScope(queued, { sessionId, runtimeId }))
        .map((queued) => queued.id);
      const pausedIds = sessionActionError ? queuedMessages.map((queued) => queued.id) : [];
      if ([...staleIds, ...pausedIds].every((id) => current.includes(id))) return current;
      return [...new Set([...current, ...staleIds, ...pausedIds])];
    });
    if (
      connection !== "connected" ||
      chatStatus !== "ready" ||
      sessionActionPending ||
      sessionActionError ||
      loadingTreeEntryId ||
      resumeLoading ||
      resumeListing ||
      forkPickerMessages ||
      messageRevision ||
      queuedMessages.length === 0
    )
      return;
    const current = usePiWebUiStore.getState();
    const next = queuedMessages.find(
      (queued) => !pausedQueuedPromptIds.includes(queued.id) && canDispatchQueuedPrompt(queued, current),
    );
    if (!next) return;
    if (queueDispatchingRef.current === next.id || !canDispatchQueuedPrompt(next, usePiWebUiStore.getState())) return;
    queueDispatchingRef.current = next.id;
    setQueuedMessages((currentQueue) => currentQueue.filter((queued) => queued.id !== next.id));
    void sendPrompt(next)
      .catch(() => {
        // The ACK may be unknown; keep a paused copy for manual restore, never replay it automatically.
        setQueuedMessages((currentQueue) =>
          currentQueue.some((queued) => queued.id === next.id) ? currentQueue : [next, ...currentQueue],
        );
        setPausedQueuedPromptIds((currentIds) =>
          currentIds.includes(next.id) ? currentIds : [...currentIds, next.id],
        );
      })
      .finally(() => {
        if (queueDispatchingRef.current === next.id) queueDispatchingRef.current = null;
      });
  }, [
    chatStatus,
    connection,
    queuedMessages,
    sendPrompt,
    sessionId,
    runtimeId,
    sessionActionPending,
    sessionActionError,
    loadingTreeEntryId,
    resumeLoading,
    resumeListing,
    forkPickerMessages,
    messageRevision,
    pausedQueuedPromptIds,
  ]);

  const submitLockRef = useRef<ReturnType<typeof createScopedSubmitLock> | null>(null);
  if (!submitLockRef.current) submitLockRef.current = createScopedSubmitLock();
  const submitMessage = useCallback(
    async ({ text, files }: { text: string; files?: unknown[] }) => {
      const store = usePiWebUiStore.getState();
      if (store.sessionActionPending) throw new Error("A session change is in progress");
      const trimmed = text.trim();
      const attachments = (files ?? []).flatMap((item) => {
        if (item instanceof File) return [{ id: `file-${item.name}-${item.size}-${item.lastModified}`, file: item }];
        if (typeof item === "object" && item !== null && "file" in item && item.file instanceof File) {
          const candidate = item as { id?: unknown; file: File };
          return [
            {
              id:
                typeof candidate.id === "string"
                  ? candidate.id
                  : `file-${candidate.file.name}-${candidate.file.size}-${candidate.file.lastModified}`,
              file: candidate.file,
            },
          ];
        }
        return [];
      });
      if (attachments.length > MAX_WORKSPACE_UPLOAD_FILES) {
        setError(workspaceUploadText("filesLimit"));
        throw new Error("Attachment count limit exceeded");
      }
      if (attachments.some(({ file }) => file.size > MAX_WORKSPACE_UPLOAD_BYTES)) {
        setError(workspaceUploadText("sizeLimit"));
        throw new Error("Attachment size limit exceeded");
      }
      if (!trimmed && attachments.length === 0) return;
      if (attachments.length && (chatStatus === "streaming" || chatStatus === "submitted")) {
        setError(workspaceUploadText("waitForPi"));
        throw new Error("Cannot queue attachments while Pi is streaming");
      }

      const scopeSessionId = store.sessionId;
      const scopeRuntimeId = store.runtimeId;
      const scopePath = window.location.pathname;
      const scopeKey = `${scopeSessionId ?? ""}\0${scopeRuntimeId ?? ""}\0${scopePath}`;
      const isScopeCurrent = () => {
        const current = usePiWebUiStore.getState();
        return (
          activeUploadScopeRef.current === scopeKey &&
          window.location.pathname === scopePath &&
          current.sessionId === scopeSessionId &&
          current.runtimeId === scopeRuntimeId
        );
      };
      if (!isScopeCurrent()) {
        setError(workspaceUploadText("sessionChangedRetry"));
        throw new Error("Upload scope changed");
      }
      if (attachments.length && (!scopeSessionId || !scopeRuntimeId || store.connection !== "connected")) {
        setError(workspaceUploadText("connectFirst"));
        throw new Error("Upload requires an active session");
      }

      const isSlashCommand = attachments.length === 0 && /^\/[^\s]+(?:\s|$)/.test(trimmed);
      if (isSlashCommand) {
        setError(null);
        try {
          const handled = await runWebUiSlashCommandRef.current(trimmed);
          if (handled) {
            if (handled !== "preserve") updateDraftText("");
            return;
          }
          await compactSend("prompt", { message: trimmed });
          usePiWebUiStore.setState({ sessionActionError: null });
          updateDraftText("");
        } catch (submitError) {
          setError(errorUiText(submitError, uiText("Command failed")));
          throw submitError;
        }
        return;
      }
      if (attachments.length === 0 && (chatStatus === "streaming" || chatStatus === "submitted")) {
        const queued = createQueuedPrompt(
          { id: nextPromptId(), message: trimmed },
          { sessionId: scopeSessionId, runtimeId: scopeRuntimeId },
          store.connection === "connected",
        );
        if (!queued) {
          setError(t("Session changed. Reopen the session picker."));
          throw new Error("Cannot queue a prompt without a connected session and runtime");
        }
        setQueuedMessages((current) => [...current, queued]);
        updateDraftText("");
        return;
      }

      const attempt = submitLockRef.current?.acquire(scopeKey);
      if (!attempt) throw new Error("A prompt submission is already in progress");

      try {
        const pending = attachments.filter(({ id }) => !uploadReceiptsRef.current.has(id));
        if (pending.length) {
          const controller = new AbortController();
          uploadControllerRef.current?.abort();
          uploadControllerRef.current = controller;
          setUploadingAttachments(true);
          setError(null);
          setUploadProgress((current) => [
            ...current.filter((progress) => !pending.some(({ id }) => id === progress.id)),
            ...pending.map(({ id, file }) => ({ id, filename: file.name, status: "waiting" as const, percent: 0 })),
          ]);
          try {
            await uploadWorkspaceFiles(pending, {
              scope: {
                sessionId: scopeSessionId as string,
                runtimeId: scopeRuntimeId as string,
                generation: scopePath,
              },
              origin: window.location.origin,
              pathname: scopePath,
              signal: controller.signal,
              send: (method, params) => usePiWebUiStore.getState().send(method, params),
              isCurrent: () => isScopeCurrent() && !usePiWebUiStore.getState().sessionActionPending,
              onProgress: (progress) => {
                if (isScopeCurrent()) {
                  setUploadProgress((current) => [...current.filter((item) => item.id !== progress.id), progress]);
                }
              },
              onReceipt: (id, receipt) => {
                if (isScopeCurrent()) {
                  uploadReceiptsRef.current.set(id, receipt);
                }
              },
            });
          } catch (uploadError) {
            if (isScopeCurrent()) {
              if (uploadError instanceof Error && uploadError.name === "AbortError") {
                setUploadProgress((current) => current.map((item) => ({ ...item, status: "waiting", percent: 0 })));
                setError(workspaceUploadText("cancelledRetry"));
              } else {
                setError(errorUiText(uploadError, workspaceUploadText("uploadFailedRetry")));
              }
            }
            if (isScopeCurrent()) {
              setUploadProgress((current) =>
                current.map((item) => {
                  const receipt = uploadReceiptsRef.current.get(item.id);
                  return receipt
                    ? { ...item, status: "saved", percent: 100, relativePath: receipt.relativePath }
                    : { ...item, status: "waiting", percent: 0 };
                }),
              );
            }
            throw uploadError;
          } finally {
            if (uploadControllerRef.current === controller) uploadControllerRef.current = null;
            if (isScopeCurrent()) setUploadingAttachments(false);
          }
        }

        const current = usePiWebUiStore.getState();
        if (!isScopeCurrent() || current.sessionActionPending) {
          if (isScopeCurrent()) setError(workspaceUploadText("sessionChangedRetry"));
          throw new Error("Upload scope changed before prompt send");
        }
        const receiptIds = attachments.map(({ id }) => uploadReceiptsRef.current.get(id)?.uploadId ?? null);
        if (receiptIds.some((uploadId) => uploadId === null)) {
          setError(workspaceUploadText("uploadNotComplete"));
          throw new Error("Missing upload receipt");
        }
        const uploadIds = [...new Set(receiptIds as string[])];
        if (uploadIds.length === 0 && attachments.length > 0) {
          setError(workspaceUploadText("uploadNotComplete"));
          throw new Error("Missing upload receipt");
        }
        const command: PromptCommand = {
          id: nextPromptId(),
          message: trimmed,
          ...(uploadIds.length ? { uploads: uploadIds } : {}),
          ...(uploadIds.length
            ? { scope: { sessionId: scopeSessionId as string, runtimeId: scopeRuntimeId as string } }
            : {}),
        };
        if (uploadIds.length) setAttachmentHandoff(true);
        await sendPrompt(command);
        if (!isScopeCurrent()) return;
        usePiWebUiStore.setState({ sessionActionError: null, error: null });
        uploadReceiptsRef.current.clear();
        setUploadProgress([]);
        updateDraftText("");
      } catch (submitError) {
        if (isScopeCurrent()) {
          setError(errorUiText(submitError, workspaceUploadText("promptFailedRetry")));
        }
        throw submitError;
      } finally {
        if (isScopeCurrent()) setAttachmentHandoff(false);
        submitLockRef.current?.release(attempt);
      }
    },
    [chatStatus, compactSend, nextPromptId, sendPrompt, setError, updateDraftText],
  );

  const openModelPicker = useCallback(async () => {
    setModelOpen(true);
    await refreshSettingsState();
  }, [refreshSettingsState]);

  const selectModelAndClose = useCallback(
    async (model: Parameters<typeof selectModel>[0]) => {
      await selectModel(model);
      setModelOpen(false);
    },
    [selectModel],
  );

  const openSettings = useCallback(async () => {
    setSettingsOpen(true);
    await refreshAuthState();
  }, [refreshAuthState]);

  const compactContext = useCallback(async () => {
    try {
      await compactSend("compact");
      addSystemMessage(uiText("Compaction requested"));
    } catch (err) {
      setError(errorUiText(err, uiText("Compaction failed")));
    }
  }, [addSystemMessage, compactSend, setError]);

  const exportHtml = useCallback(async () => {
    if (
      !window.confirm(
        t(
          "Export the complete session tree, including other branches, old compaction history and potentially sensitive tool inputs and outputs? Keep the downloaded HTML private.",
        ),
      )
    )
      return;
    try {
      const result = (await compactSend("export_html")) as ExportHtmlResult;
      downloadExport(result);
      addSystemMessage(uiText("Download requested: {filename}", { filename: result.filename }), "success");
    } catch (err) {
      setError(errorUiText(err, uiText("Export failed")));
    }
  }, [addSystemMessage, compactSend, setError]);

  const showSessionStats = useCallback(async () => {
    try {
      const sourceSessionId = usePiWebUiStore.getState().sessionId;
      const stats = (await compactSend("get_session_stats")) as SessionStatsResult;
      if (
        usePiWebUiStore.getState().sessionId !== sourceSessionId ||
        (stats.sessionId && stats.sessionId !== sourceSessionId)
      ) {
        throw new UiError(uiText("Session changed. Request session details again."));
      }
      setSessionDetails(stats);
      addSystemMessage(sessionStatsSummary(stats));
    } catch (err) {
      setError(errorUiText(err, uiText("Stats failed")));
    }
  }, [addSystemMessage, compactSend, setError]);

  const forkToNewSession = useCallback(
    async (action: "fork" | "clone", entryId: string, text = "") => {
      if (chatStatus !== "ready" || sessionActionPending) {
        setError(uiText("Wait for the current Pi turn or session action to finish."));
        return;
      }
      const targetId = action === "clone" ? leafId : entryId;
      if (!targetId) {
        setError(action === "clone" ? uiText("Nothing to clone yet.") : uiText("Select a user message to fork from."));
        return;
      }
      if ((draftTextRef.current.trim() && !/^\/(fork|clone)\s*$/.test(draftTextRef.current)) || queuedMessages.length) {
        if (!window.confirm(t("Replace the current draft and discard queued messages in a new session?"))) return;
      }
      setForkPickerMessages(null);
      setLoadingTreeEntryId(targetId);
      try {
        await forkSession(action, targetId);
        updateDraftText(text);
        setQueuedMessages([]);
      } catch (err) {
        setError(errorUiText(err, uiText(action === "clone" ? "clone failed" : "fork failed")));
      } finally {
        setLoadingTreeEntryId(null);
      }
    },
    [
      chatStatus,
      forkSession,
      leafId,
      queuedMessages.length,
      sessionActionPending,
      setError,
      setLoadingTreeEntryId,
      updateDraftText,
    ],
  );

  const openForkPicker = useCallback(async () => {
    if (chatStatus !== "ready" || sessionActionPending) {
      setError(uiText("Wait for the current Pi turn or session action to finish."));
      return;
    }
    try {
      const result = (await compactSend("get_fork_messages")) as
        | { messages?: ForkableMessage[]; sessionId?: string }
        | undefined;
      if (!result?.sessionId || result.sessionId !== usePiWebUiStore.getState().sessionId) {
        setError(uiText("Session changed. Reopen the fork message picker."));
        return;
      }
      const messages = result?.messages || [];
      if (messages.length === 0) {
        setError(uiText("There are no user messages to fork from yet."));
        return;
      }
      forkPickerSessionIdRef.current = result.sessionId;
      setForkPickerMessages(messages);
    } catch (err) {
      setError(errorUiText(err, uiText("Could not load messages to fork from")));
    }
  }, [chatStatus, compactSend, sessionActionPending, setError]);

  const openResumePicker = useCallback(
    async (range: HistoryRange = recentHistoryRange()) => {
      const store = usePiWebUiStore.getState();
      if (
        store.chatStatus !== "ready" ||
        store.sessionActionPending ||
        !store.sessionId ||
        store.connection !== "connected"
      ) {
        setError(uiText("Connect and wait for the current Pi turn or session action to finish."));
        return;
      }
      const sourceSessionId = store.sessionId;
      const sourceRuntimeId = store.runtimeId;
      const request = ++resumeRequestRef.current;
      setResumeLoading(true);
      try {
        const listing = (await compactSend("get_saved_sessions", {
          ...range,
          sessionId: sourceSessionId,
          ...(sourceRuntimeId ? { runtimeId: sourceRuntimeId } : {}),
        })) as SavedSessionsResult;
        if (request !== resumeRequestRef.current) return;
        const current = usePiWebUiStore.getState();
        if (
          listing.sessionId !== sourceSessionId ||
          (listing.runtimeId && listing.runtimeId !== sourceRuntimeId) ||
          current.sessionId !== sourceSessionId ||
          current.runtimeId !== sourceRuntimeId ||
          current.sessionActionPending
        ) {
          throw new UiError(uiText("Session changed. Reopen the session picker."));
        }
        resumeSourceRuntimeRef.current = sourceRuntimeId;
        setResumeListing(listing);
      } catch (err) {
        if (request === resumeRequestRef.current) setError(errorUiText(err, uiText("Could not load saved sessions")));
      } finally {
        if (request === resumeRequestRef.current) setResumeLoading(false);
      }
    },
    [compactSend, setError],
  );

  const resumeSelectedSession = useCallback(
    async (selection: SavedSession) => {
      const store = usePiWebUiStore.getState();
      if (
        !resumeListing ||
        resumeListing.sessionId !== store.sessionId ||
        resumeSourceRuntimeRef.current !== store.runtimeId
      ) {
        setError(uiText("Session changed. Reopen the session picker."));
        closeResumePicker();
        return;
      }
      if (selection.isCurrent || selection.sessionId === store.sessionId || store.sessionActionPending) return;
      if (
        (draftTextRef.current.trim() || queuedMessages.length) &&
        !window.confirm(
          t(
            "Resume the selected session and discard the current draft and queued messages? They will only be cleared after success.",
          ),
        )
      )
        return;
      // The source binding is checked immediately before the store captures it.
      try {
        const completion = resumeSession(selection.id, selection.sessionId);
        closeResumePicker();
        await completion;
        updateDraftText("");
        setQueuedMessages([]);
      } catch (err) {
        setError(errorUiText(err, uiText("Resume failed")));
      }
    },
    [queuedMessages.length, resumeListing, resumeSession, setError, closeResumePicker, updateDraftText],
  );

  const reloadCurrentRuntime = useCallback(async () => {
    if (
      ((draftTextRef.current.trim() && !/^\/reload\s*$/.test(draftTextRef.current)) || queuedMessages.length) &&
      !window.confirm(
        t(
          "Reload Pi resources and discard the current draft and queued messages? They will only be cleared after success.",
        ),
      )
    )
      return;
    try {
      await reloadRuntime();
      updateDraftText("");
      setQueuedMessages([]);
    } catch (err) {
      setError(errorUiText(err, uiText("Reload failed")));
    }
  }, [queuedMessages.length, reloadRuntime, setError, updateDraftText]);

  const runWebUiSlashCommand = useCallback(
    async (text: string) => {
      const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
      const name = match?.[1]?.toLowerCase();
      const args = match?.[2]?.trim() ?? "";
      if (!name) return false;
      const panel = usePiWebUiStore.getState().panelForCommand(name);
      if (panel && !args) {
        await usePiWebUiStore.getState().openInteractionPanel(panel);
        return true;
      }
      if (commands.some((command) => command.name.toLowerCase() === name && command.source !== "builtin")) {
        await compactSend("prompt", { message: text, executePiCommand: true });
        return true;
      }

      switch (name) {
        case "settings":
          if (args) {
            setError(uiText("Usage: /settings"));
            return true;
          }
          await openSettings();
          return true;
        case "model": {
          await refreshSettingsState();
          if (!args) {
            setModelSearch("");
            setModelOpen(true);
            return true;
          }
          const query = args.toLowerCase();
          const models = usePiWebUiStore.getState().availableModels;
          const matches = models.filter((model) => {
            const qualifiedName = `${model.provider}/${model.id}`.toLowerCase();
            return qualifiedName === query || model.id.toLowerCase() === query;
          });
          if (matches.length === 1) {
            await selectModel(matches[0]);
            if (usePiWebUiStore.getState().currentModel?.id === matches[0].id) {
              addSystemMessage(
                uiText("Model selected: {model}", { model: `${matches[0].provider}/${matches[0].id}` }),
                "success",
              );
            }
          } else {
            setModelSearch(args.replace("/", " "));
            setModelOpen(true);
          }
          return true;
        }
        case "resume":
          if (args) setError(uiText("Usage: /resume"));
          else await openResumePicker();
          return true;
        case "reload":
          if (args) setError(uiText("Usage: /reload"));
          else await reloadCurrentRuntime();
          return true;
        case "fork":
          if (args) {
            setError(uiText("Usage: /fork"));
            return true;
          }
          await openForkPicker();
          return true;
        case "clone":
          if (args) {
            setError(uiText("Usage: /clone"));
            return true;
          }
          await forkToNewSession("clone", leafId || "");
          return true;
        case "session":
          if (args) {
            setError(uiText("Usage: /session"));
            return true;
          }
          await showSessionStats();
          return true;
        case "tree":
          if (args) {
            setError(uiText("Usage: /tree"));
            return true;
          }
          openConversationSidebar();
          return true;
        case "copy": {
          if (args) {
            setError(uiText("Usage: /copy"));
            return true;
          }
          const lastAssistant = [...items]
            .reverse()
            .find((item) => item.kind === "message" && item.role === "assistant");
          if (!lastAssistant || lastAssistant.kind !== "message" || !lastAssistant.text.trim()) {
            setError(uiText("There is no assistant message to copy yet."));
            return true;
          }
          try {
            await copyText(lastAssistant.text);
            addSystemMessage(uiText("Copied the last assistant message."), "success");
          } catch (error) {
            setError(errorUiText(error, uiText("Failed to copy the last assistant message")));
          }
          return true;
        }
        case "export":
          if (args) {
            setError(uiText("Usage: /export"));
            return true;
          }
          await exportHtml();
          return true;
        default:
          return false;
      }
    },
    [
      addSystemMessage,
      commands,
      compactSend,
      exportHtml,
      forkToNewSession,
      items,
      leafId,
      openConversationSidebar,
      openForkPicker,
      openResumePicker,
      reloadCurrentRuntime,
      openSettings,
      refreshSettingsState,
      selectModel,
      setError,
      showSessionStats,
    ],
  );

  runWebUiSlashCommandRef.current = runWebUiSlashCommand;

  useEffect(() => {
    if (!dialog?.timeout) return;
    const timeout = window.setTimeout(() => respondDialog({ cancelled: true }), dialog.timeout);
    return () => window.clearTimeout(timeout);
  }, [dialog, respondDialog]);

  const registerItemElement = useCallback((item: ChatItem, node: HTMLElement | null) => {
    const ids = [item.entryId, ...(item.relatedEntryIds ?? [])].filter((value): value is string => Boolean(value));
    for (const id of ids) {
      if (node) itemElementsRef.current.set(id, node);
      else itemElementsRef.current.delete(id);
    }
  }, []);

  const findVisibleEntryId = useCallback(
    (entryId: string) => {
      const byId = new Map<string, { parentId?: string | null }>();
      const stack = [...tree];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node?.entry.id) continue;
        byId.set(node.entry.id, { parentId: node.entry.parentId });
        stack.push(...node.children);
      }

      let cursor: string | null | undefined = entryId;
      while (cursor) {
        if (itemElementsRef.current.has(cursor)) return cursor;
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      return null;
    },
    [tree],
  );

  const focusEntry = useCallback(
    (entryId: string) => {
      const visibleEntryId = findVisibleEntryId(entryId);
      if (!visibleEntryId) return false;
      const element = itemElementsRef.current.get(visibleEntryId);
      if (!element) return false;
      let scrollContainer: HTMLElement | null = null;
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== document.body) {
        const style = window.getComputedStyle(ancestor);
        if (style.overflowY === "hidden" && ancestor.scrollTop !== 0) ancestor.scrollTop = 0;
        if (
          !scrollContainer &&
          ["auto", "scroll"].includes(style.overflowY) &&
          ancestor.scrollHeight > ancestor.clientHeight
        ) {
          scrollContainer = ancestor;
        }
        ancestor = ancestor.parentElement;
      }
      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const targetTop =
          scrollContainer.scrollTop +
          elementRect.top -
          containerRect.top -
          (containerRect.height - elementRect.height) / 2;
        scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
      }
      setHighlightedEntryId(visibleEntryId);
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(() => setHighlightedEntryId(null), 1200);
      return true;
    },
    [findVisibleEntryId],
  );

  useEffect(() => {
    const targetEntryId = pendingFocusEntryIdRef.current;
    if (!targetEntryId) return;
    if (focusEntry(targetEntryId)) pendingFocusEntryIdRef.current = null;
  }, [focusEntry]);

  const selectTreeEntry = useCallback(
    (entryId: string) => {
      setSelectedTreeEntryId(entryId);
      focusEntry(entryId);
    },
    [focusEntry, setSelectedTreeEntryId],
  );

  const closeMessageRevision = useCallback(() => {
    if (usePiWebUiStore.getState().sessionActionPending) return;
    revisionRequestRef.current++;
    setMessageRevision(null);
  }, []);

  useEffect(() => {
    revisionRequestRef.current++;
    setMessageRevision((current) =>
      current?.preview?.sessionId === sessionId && current.preview.runtimeId === runtimeId ? current : null,
    );
  }, [sessionId, runtimeId]);

  const openMessageRevision = useCallback(
    async (entryId: string, mode: MessageRevisionMode) => {
      if (
        draftTextRef.current.trim() ||
        queuedMessages.length ||
        hasSelectedFiles ||
        uploadingAttachments ||
        attachmentHandoff
      ) {
        window.alert(t("Send or clear your draft, queued messages and attachments before revising a message."));
        return;
      }
      const request = ++revisionRequestRef.current;
      setMessageRevision({ mode, text: "", preview: null, loading: true, submitting: false, error: null });
      try {
        const preview = await usePiWebUiStore.getState().getMessageRevision(entryId, mode);
        if (request !== revisionRequestRef.current) return;
        setMessageRevision({ mode, text: preview.text, preview, loading: false, submitting: false, error: null });
      } catch (error) {
        if (request !== revisionRequestRef.current) return;
        setMessageRevision({
          mode,
          text: "",
          preview: null,
          loading: false,
          submitting: false,
          error: renderUiText(errorUiText(error, uiText("Could not load the original question."))),
        });
      }
    },
    [queuedMessages.length, hasSelectedFiles, uploadingAttachments, attachmentHandoff],
  );
  const editMessage = useCallback(
    (entryId: string) => {
      void openMessageRevision(entryId, "edit");
    },
    [openMessageRevision],
  );
  const regenerateMessage = useCallback(
    (entryId: string) => {
      void openMessageRevision(entryId, "regenerate");
    },
    [openMessageRevision],
  );

  const submitMessageRevision = useCallback(async () => {
    const revision = messageRevision;
    if (!revision?.preview || revision.loading || revision.submitting) return;
    const request = revisionRequestRef.current;
    setMessageRevision({ ...revision, submitting: true });
    try {
      const dispatched = await usePiWebUiStore.getState().submitMessageRevision(revision.preview, revision.text);
      if (request !== revisionRequestRef.current) return;
      if (dispatched) {
        revisionRequestRef.current++;
        setMessageRevision(null);
      } else
        setMessageRevision({
          ...revision,
          preview: null,
          submitting: false,
          error: t("Revision cancelled. Close this dialog before starting again."),
        });
    } catch (error) {
      if (request !== revisionRequestRef.current) return;
      // A lost ACK is not permission to send again. Keep edited text copyable,
      // but require a fresh inspection of the actual branch before another action.
      setMessageRevision({
        ...revision,
        preview: null,
        submitting: false,
        error: renderUiText(
          errorUiText(
            error,
            uiText("Message revision was not confirmed. Check the active branch before trying again."),
          ),
        ),
      });
    }
  }, [messageRevision]);

  const acquireTreeNavigation = useCallback(
    (entryId: string) => {
      const current = usePiWebUiStore.getState();
      if (
        treeNavigationRef.current ||
        current.loadingTreeEntryId ||
        current.sessionActionPending ||
        current.connection !== "connected" ||
        !current.sessionId ||
        !current.runtimeId
      )
        return null;
      const operation = {
        token: Symbol(entryId),
        entryId,
        sessionId: current.sessionId,
        runtimeId: current.runtimeId,
        draftText: draftTextRef.current,
        draftVersion: draftVersionRef.current,
      };
      treeNavigationRef.current = operation;
      setSelectedTreeEntryId(entryId);
      setLoadingTreeEntryId(entryId);
      setError(null);
      return operation;
    },
    [setError, setLoadingTreeEntryId, setSelectedTreeEntryId],
  );
  const navigationIsCurrent = useCallback((operation: NonNullable<typeof treeNavigationRef.current>) => {
    const current = usePiWebUiStore.getState();
    return (
      treeNavigationRef.current?.token === operation.token &&
      current.connection === "connected" &&
      !current.sessionActionPending &&
      navigationResultIsCurrent(
        operation,
        current,
        { text: operation.draftText, version: operation.draftVersion },
        { text: draftTextRef.current, version: draftVersionRef.current },
      )
    );
  }, []);

  const restoreQueuedPrompt = useCallback(
    (queued: QueuedPrompt) => {
      const sameScope = queuedPromptMatchesScope(queued, usePiWebUiStore.getState());
      if (!window.confirm(t("Restore this queued message to the composer; it will not be sent automatically."))) return;
      if (!sameScope && !window.confirm(t("This queued message came from another session. Copy it into this draft?")))
        return;
      if (draftTextRef.current && !window.confirm(t("Replace the current draft with this queued message?"))) return;
      if (hasSelectedFiles && !window.confirm(t("Selected attachments will stay in the composer. Continue?"))) return;
      if (
        pausedQueuedPromptIds.includes(queued.id) &&
        sameScope &&
        !window.confirm(t("Check the conversation before restoring; this prompt may already have been accepted."))
      )
        return;
      updateDraftText(queued.message);
      setQueuedMessages((current) => current.filter((candidate) => candidate.id !== queued.id));
      setPausedQueuedPromptIds((current) => current.filter((id) => id !== queued.id));
    },
    [hasSelectedFiles, pausedQueuedPromptIds, updateDraftText],
  );

  const messageActionsEnabled =
    advancedFeatures &&
    connection === "connected" &&
    chatStatus === "ready" &&
    !sessionActionPending &&
    !loadingTreeEntryId &&
    !messageRevision &&
    !uploadingAttachments &&
    !attachmentHandoff &&
    queuedMessages.length === 0;

  const branchFromMessage = useCallback(
    async (entryId: string) => {
      const current = usePiWebUiStore.getState();
      if (treeNavigationRef.current || current.loadingTreeEntryId || current.sessionActionPending) return;
      if (hasSelectedFiles || queuedMessages.length || uploadingAttachments || attachmentHandoff) {
        window.alert(t("Send or clear your draft, queued messages and attachments before revising a message."));
        return;
      }
      if (draftTextRef.current.trim() && !window.confirm(t("Replace the current draft with this message?"))) return;
      let timestamp = "";
      let fallbackText = "";
      const stack = [...tree];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.entry.id === entryId) {
          timestamp = typeof node.entry.timestamp === "string" ? node.entry.timestamp : "";
          fallbackText = extractText(node.entry.message?.content);
          break;
        }
        stack.push(...node.children);
      }

      const operation = acquireTreeNavigation(entryId);
      if (!operation) return;
      pendingFocusEntryIdRef.current = entryId;
      try {
        const result = (await compactSend("navigate_tree", { entryId })) as
          | { editorText?: string; cancelled?: boolean }
          | undefined;
        if (result?.cancelled) {
          pendingFocusEntryIdRef.current = null;
          return;
        }
        if (!navigationIsCurrent(operation)) return;
        await requestConversationSync();
        if (!navigationIsCurrent(operation)) return;
        updateDraftText(result?.editorText ?? fallbackText);
        addSystemMessage(
          uiText("Branching from {time}. Previous branch is preserved in this session.", {
            time: uiRelativeTime(timestamp, uiText("selected message")),
          }),
        );
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
          input?.focus();
          input?.setSelectionRange(input.value.length, input.value.length);
        });
      } catch (err) {
        if (navigationIsCurrent(operation)) {
          pendingFocusEntryIdRef.current = null;
          setError(errorUiText(err, uiText("Branch failed")));
        }
      } finally {
        const activeOperation = treeNavigationRef.current as typeof operation | null;
        if (activeOperation?.token === operation.token) {
          treeNavigationRef.current = null;
          if (usePiWebUiStore.getState().loadingTreeEntryId === entryId) setLoadingTreeEntryId(null);
        }
      }
    },
    [
      addSystemMessage,
      compactSend,
      requestConversationSync,
      setError,
      setLoadingTreeEntryId,
      tree,
      hasSelectedFiles,
      queuedMessages.length,
      uploadingAttachments,
      attachmentHandoff,
      acquireTreeNavigation,
      navigationIsCurrent,
      updateDraftText,
    ],
  );

  const switchMessageVersion = useCallback(
    async (entryId: string, version: { userEntryId: string; targetEntryId: string | null }) => {
      const current = usePiWebUiStore.getState();
      const group = messageVersions.versions.get(entryId);
      if (
        !messageActionsEnabled ||
        !current.sessionId ||
        !current.runtimeId ||
        current.connection !== "connected" ||
        !current.advancedFeatures ||
        current.chatStatus !== "ready" ||
        current.conversationSyncing ||
        current.historyLoading ||
        current.leafId !== leafId ||
        current.sessionId !== sessionId ||
        current.runtimeId !== runtimeId ||
        !version.targetEntryId ||
        !group?.versions.some((v) => v.userEntryId === version.userEntryId && v.targetEntryId === version.targetEntryId)
      )
        return;
      if (hasSelectedFiles || queuedMessages.length || uploadingAttachments || attachmentHandoff) {
        window.alert(t("Send or clear your draft, queued messages and attachments before revising a message."));
        return;
      }
      if (
        draftTextRef.current.trim() &&
        !window.confirm(t("Switch branches and keep the current draft? Files are not rolled back."))
      )
        return;
      const operation = acquireTreeNavigation(entryId);
      if (!operation) return;
      const targetEntryId = version.targetEntryId;
      const scope = { sessionId: current.sessionId, runtimeId: current.runtimeId };
      const range = { ...current.historyRange };
      const before = current.historyBefore;
      const syncSelectedPage = async () => {
        // Keep dates but start the new branch at its newest page. loadHistory
        // increments historyGeneration, fencing all pre-switch cursor reads.
        await versionSwitchDeadline(
          loadMessageVersionHistory({ ...range, before }, usePiWebUiStore.getState(), () =>
            navigationIsCurrent(operation),
          ),
        );
      };
      try {
        const ack = parseMessageVersionSwitch(
          await versionSwitchDeadline(
            compactSend("switch_message_version", {
              ...scope,
              sourceLeafId: current.leafId,
              entryId,
              userEntryId: version.userEntryId,
              targetEntryId,
            }),
          ),
          { sessionId: current.sessionId, runtimeId: current.runtimeId, targetEntryId },
        );
        if ("cancelled" in ack || !navigationIsCurrent(operation)) return;
        // Wait for the selected date range's newest page, not an old branch cursor.
        pendingFocusEntryIdRef.current = version.userEntryId;
        await syncSelectedPage();
      } catch (err) {
        if (navigationIsCurrent(operation)) {
          setError(
            errorUiText(
              err,
              uiText("Message version switch was not confirmed. Check the active branch before trying again."),
            ),
          );
          // Read-only reconciliation only. A timeout is not permission to replay navigation.
          try {
            await syncSelectedPage();
          } catch {
            /* Keep the explicit unknown/failure notice. */
          }
        }
      } finally {
        if (treeNavigationRef.current?.token === operation.token) {
          treeNavigationRef.current = null;
          if (usePiWebUiStore.getState().loadingTreeEntryId === entryId) setLoadingTreeEntryId(null);
          setVersionsRefreshKey((key) => key + 1);
        }
      }
    },
    [
      messageVersions.versions,
      messageActionsEnabled,
      leafId,
      sessionId,
      runtimeId,
      hasSelectedFiles,
      queuedMessages.length,
      uploadingAttachments,
      attachmentHandoff,
      acquireTreeNavigation,
      navigationIsCurrent,
      compactSend,
      setError,
      setLoadingTreeEntryId,
    ],
  );

  const continueBranch = useCallback(
    async (entryId: string) => {
      const current = usePiWebUiStore.getState();
      if (treeNavigationRef.current || current.loadingTreeEntryId || current.sessionActionPending) return;
      if (hasSelectedFiles || queuedMessages.length || uploadingAttachments || attachmentHandoff) {
        window.alert(t("Send or clear your draft, queued messages and attachments before revising a message."));
        return;
      }
      if (
        draftTextRef.current.trim() &&
        !window.confirm(t("Switch branches and keep the current draft? Files are not rolled back."))
      )
        return;
      const operation = acquireTreeNavigation(entryId);
      if (!operation) return;
      try {
        const result = (await compactSend("navigate_tree", { entryId })) as { cancelled?: boolean } | undefined;
        if (result?.cancelled || !navigationIsCurrent(operation)) return;
        await requestConversationSync();
        if (!navigationIsCurrent(operation)) return;
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
          input?.focus();
          input?.setSelectionRange(input.value.length, input.value.length);
        });
      } catch (err) {
        if (navigationIsCurrent(operation)) setError(errorUiText(err, uiText("Continue branch failed")));
      } finally {
        const activeOperation = treeNavigationRef.current as typeof operation | null;
        if (activeOperation?.token === operation.token) {
          treeNavigationRef.current = null;
          if (usePiWebUiStore.getState().loadingTreeEntryId === entryId) setLoadingTreeEntryId(null);
        }
      }
    },
    [
      compactSend,
      requestConversationSync,
      setError,
      setLoadingTreeEntryId,
      hasSelectedFiles,
      queuedMessages.length,
      uploadingAttachments,
      attachmentHandoff,
      acquireTreeNavigation,
      navigationIsCurrent,
    ],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      } else if (event.key === "/") {
        event.preventDefault();
        document.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
      } else if (event.key === "Escape") {
        if (messageRevision) return;
        if (statusOverlay) setStatusOverlay(null);
        else if (sidebarMobileOpen) setSidebarMobileOpen(false);
        else if (commandOpen) setCommandOpen(false);
        else if (modelOpen) setModelOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (resumeListing) closeResumePicker();
        else if (forkPickerMessages) setForkPickerMessages(null);
        else if (sessionDetails) setSessionDetails(null);
        else if (chatStatus === "streaming") abort();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    abort,
    chatStatus,
    closeResumePicker,
    commandOpen,
    modelOpen,
    settingsOpen,
    resumeListing,
    messageRevision,
    forkPickerMessages,
    sessionDetails,
    statusOverlay,
    sidebarMobileOpen,
  ]);

  const totalCost = useMemo(
    () => items.reduce((sum, item) => sum + (item.kind === "message" ? item.cost || 0 : 0), 0),
    [items],
  );

  const usedContextTokens = (lastUsage?.input || 0) + (lastUsage?.cacheRead || 0);
  const contextPercent = contextWindowSize > 0 ? Math.round((usedContextTokens / contextWindowSize) * 100) : 0;
  const shouldSuggestCompaction = contextPercent >= 80;

  const commandActions = [
    {
      label: t("Compact"),
      desc: t("Compact context to save tokens"),
      icon: ArchiveIcon,
      action: compactContext,
    },
    {
      label: t("Export HTML"),
      desc: t("Export current session as HTML"),
      icon: DownloadIcon,
      action: exportHtml,
    },
    {
      label: t("Session Stats"),
      desc: t("Show message and tool call counts"),
      icon: BarChart3Icon,
      action: showSessionStats,
    },
    {
      label: t("Expand All Tools"),
      desc: t("Open every tool card"),
      icon: PanelLeftOpenIcon,
      action: () => toggleAllTools(true),
    },
    {
      label: t("Collapse All Tools"),
      desc: t("Close every tool card"),
      icon: PanelLeftCloseIcon,
      action: () => toggleAllTools(false),
    },
  ];

  return (
    <SidebarProvider
      className="h-full min-h-0 bg-background text-foreground"
      onOpenChange={setSidebarOpen}
      open={sidebarOpen}
      openMobile={sidebarMobileOpen}
      onOpenMobileChange={setSidebarMobileOpen}
      style={{ "--sidebar-width": `${leftSidebarWidth}px` } as CSSProperties}
    >
      <ConversationSidebar
        key={sessionId ?? "pending-session"}
        branchEnabled={messageActionsEnabled}
        connection={connection}
        leafId={leafId}
        loadingEntryId={loadingTreeEntryId}
        onBranchTree={branchFromMessage}
        onContinueTree={continueBranch}
        onOpenSettings={openSettings}
        onRefreshTree={() => void requestConversationSync()}
        onResizeSidebar={updateLeftSidebarWidth}
        onSelectTree={selectTreeEntry}
        selectedEntryId={selectedTreeEntryId}
        syncError={conversationSyncError ? renderUiText(conversationSyncError) : null}
        syncing={conversationSyncing}
        tree={tree}
      />

      <SidebarInset className="h-full min-h-0 min-w-0">
        <AppHeader
          connection={connection}
          canLeaveForHub={() =>
            !(
              draftText.trim() ||
              queuedMessages.length ||
              hasSelectedFiles ||
              uploadingAttachments ||
              attachmentHandoff
            ) ||
            window.confirm(
              t("Return to Hub? Unsent text, queued messages and selected attachments will not be kept on this page."),
            )
          }
          contextPercent={contextPercent}
          contextWindowSize={contextWindowSize}
          isViewingOtherSession={false}
          modelLabel={modelLabel}
          onCompactContext={compactContext}
          onCycleThinking={cycleThinking}
          onOpenCommandPalette={() => setCommandOpen(true)}
          onOpenModelPicker={openModelPicker}
          onReturnToLive={() => void requestConversationSync()}
          onToggleContext={() => setStatusOverlay((current) => (current === "context" ? null : "context"))}
          onToggleWorkspace={() => setStatusOverlay((current) => (current === "workspace" ? null : "workspace"))}
          onOpenSettings={openSettings}
          contextOpen={contextOpen}
          workspaceOpen={workspaceOpen}
          shouldSuggestCompaction={shouldSuggestCompaction}
          thinkingLevel={thinkingLevel}
          title={sessionName}
          totalCost={totalCost}
        />

        {remoteHint && !remoteAccess && !settingsOpen && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2">
            <button type="button" className="text-sm underline" onClick={() => setRemoteAccess("access")}>
              {t("Connect your phone to Pi")}
            </button>
            <button type="button" className="text-muted-foreground text-xs" onClick={closeRemoteAccess}>
              {t("Skip for now")}
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <HistoryControls />
            <TerminalPromptBanner />
            {transportNotice && (
              <div
                role="status"
                data-testid="transport-notice"
                className="flex shrink-0 items-start gap-2 border-b bg-muted/40 px-4 py-2 text-sm"
              >
                <p className="min-w-0 flex-1">{renderUiText(transportNotice)}</p>
                <button
                  type="button"
                  aria-label={t("Dismiss transport notice")}
                  onClick={dismissTransportNotice}
                  className="shrink-0 rounded px-2"
                >
                  ×
                </button>
              </div>
            )}
            <div className="relative min-h-0 flex-1">
              <Conversation className="h-full">
                <ConversationContent className="mx-auto w-full max-w-3xl gap-5 px-4 py-8 sm:px-6">
                  {(messageVersions.unavailable || messageVersions.limited) && (
                    <p role="status" className="text-center text-muted-foreground text-xs">
                      {t(
                        messageVersions.unavailable
                          ? "Message versions are unavailable. Refresh the conversation to try again."
                          : "Some message versions are not shown. Use Tree to explore other branches.",
                      )}
                    </p>
                  )}
                  <ChatList
                    versions={messageVersions.versions}
                    onSwitchVersion={messageActionsEnabled && !conversationSyncing ? switchMessageVersion : undefined}
                    items={items}
                    highlightedEntryId={highlightedEntryId}
                    onBranch={messageActionsEnabled ? branchFromMessage : undefined}
                    onEdit={messageActionsEnabled ? editMessage : undefined}
                    onRegenerate={messageActionsEnabled ? regenerateMessage : undefined}
                    onCopy={copyText}
                    onToggleTool={toggleTool}
                    registerItemElement={registerItemElement}
                    showThinking={showThinking}
                  />
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>

              {contextOpen && (
                <div className="context-surface">
                  <ContextPopover
                    contextWindowSize={contextWindowSize}
                    lastUsage={lastUsage}
                    onClose={() => setStatusOverlay(null)}
                  />
                </div>
              )}
              <WorkspaceStatusFloat
                open={workspaceOpen}
                onOpenChange={(open) => setStatusOverlay(open ? "workspace" : null)}
                artifacts={artifacts}
                gitLoading={gitLoading}
                gitStatus={gitStatus}
                onOpenArtifact={openArtifact}
                onOpenGitDiff={openGitDiff}
              />
            </div>

            {queuedMessages.length > 0 && (
              <div className="mx-auto w-full max-w-3xl px-4 pt-2">
                {queuedMessages.some((queued) => !queuedPromptMatchesScope(queued, { sessionId, runtimeId })) && (
                  <p className="mb-1 text-xs text-muted-foreground">
                    {t(
                      "Queued messages from another session are paused. They will not be rebound or sent automatically.",
                    )}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {queuedMessages.map((queued) => (
                    <div
                      className="flex items-center gap-2 rounded-md border bg-muted px-2 py-1 text-xs"
                      key={queued.id}
                    >
                      <span className="text-muted-foreground">{t("Queued")}</span>
                      <span className="max-w-72 truncate">{queued.message}</span>
                      <button
                        type="button"
                        className="rounded px-1 underline"
                        disabled={sessionActionPending || resumeLoading || Boolean(loadingTreeEntryId)}
                        onClick={() => restoreQueuedPrompt(queued)}
                      >
                        {t("Restore to composer")}
                      </button>
                      <button
                        aria-label={t("Remove queued message")}
                        disabled={sessionActionPending || resumeLoading || Boolean(loadingTreeEntryId)}
                        onClick={() => {
                          setQueuedMessages((current) => current.filter((candidate) => candidate.id !== queued.id));
                          setPausedQueuedPromptIds((current) => current.filter((id) => id !== queued.id));
                        }}
                        type="button"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="mx-auto w-full max-w-3xl px-4 py-2">
                <div
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm"
                >
                  {renderUiText(error)}
                </div>
              </div>
            )}

            {(sessionActionPending || resumeLoading) && (
              <p className="mx-auto w-full max-w-3xl px-4 py-2 text-muted-foreground text-sm" role="status">
                {resumeLoading
                  ? t("Loading saved sessions for this project…")
                  : t(
                      "Waiting for Pi to sync the requested session or runtime (up to 20 seconds). Draft and queued messages are preserved until success.",
                    )}
              </p>
            )}

            <ChatInput
              key={uploadScopeKey}
              archAvailable={archAvailable}
              availableThinkingLevels={availableThinkingLevels}
              commands={commands}
              archModeEnabled={archModeEnabled}
              chatStatus={chatStatus}
              connection={connection}
              disabled={
                sessionActionPending ||
                resumeLoading ||
                attachmentHandoff ||
                Boolean(loadingTreeEntryId) ||
                Boolean(messageRevision)
              }
              attachmentsDisabled={
                uploadingAttachments || attachmentHandoff || Boolean(loadingTreeEntryId) || Boolean(messageRevision)
              }
              uploadProgress={uploadProgress}
              onCancelUpload={uploadingAttachments ? () => uploadControllerRef.current?.abort() : undefined}
              onAbort={abort}
              onSubmit={submitMessage}
              onToggleArchMode={toggleArchMode}
              onValueChange={updateDraftText}
              onFilesChange={setHasSelectedFiles}
              value={draftText}
              viewingHistory={false}
            />
          </div>

          {(rightPanelTabs.length > 0 || rightPanelHasOpened) && (
            <RightPanel
              activeTabId={activeRightPanelTabId}
              onCloseTab={closeRightPanelTab}
              onRefreshTab={refreshRightPanelTab}
              onSelectTab={setActiveRightPanelTabId}
              onToggleVisible={toggleRightPanelVisible}
              tabs={rightPanelTabs}
              visible={rightPanelVisible}
            />
          )}
        </div>

        <WhalePet
          mode={whaleMode}
          onModeChange={changeWhaleMode}
          reduceMotion={whaleReduceMotion}
          images={whaleAssets.images}
          positionResetKey={whalePositionResetKey}
          suspended={Boolean(
            messageRevision ||
              modelOpen ||
              settingsOpen ||
              remoteAccess ||
              commandOpen ||
              statusOverlay ||
              forkPickerMessages ||
              resumeListing ||
              sessionDetails ||
              dialog ||
              sidebarMobileOpen ||
              rightPanelVisible,
          )}
        />
        {messageRevision && (
          <MessageRevisionDialog
            mode={messageRevision.mode}
            text={messageRevision.text}
            hasImages={messageRevision.preview?.hasImages ?? false}
            loading={messageRevision.loading}
            submitting={messageRevision.submitting}
            error={messageRevision.error}
            onClose={closeMessageRevision}
            onSubmit={() => {
              void submitMessageRevision();
            }}
            onTextChange={(text) => setMessageRevision((current) => current && { ...current, text })}
          />
        )}
        {modelOpen && (
          <ModelPicker
            currentModel={currentModel}
            models={availableModels}
            onClose={() => setModelOpen(false)}
            onSelect={selectModelAndClose}
            query={modelSearch}
            setQuery={setModelSearch}
          />
        )}
        {remoteAccess && <RemoteAccessPanel initialTab={remoteAccess} onClose={closeRemoteAccess} />}
        {settingsOpen && (
          <SettingsPanel
            whaleSettings={
              <WhaleSettings
                mode={whaleMode}
                onModeChange={changeWhaleMode}
                reduceMotion={whaleReduceMotion}
                onReduceMotionChange={changeWhaleMotion}
                onResetPosition={() => setWhalePositionResetKey((key) => key + 1)}
                assets={whaleAssets}
              />
            }
            authConfigured={authConfigured}
            authEnabled={authEnabled}
            autoCompaction={autoCompaction}
            onClose={() => setSettingsOpen(false)}
            onRemoteAccess={(tab) => {
              setSettingsOpen(false);
              setRemoteAccess(tab);
            }}
            onRenameSession={renameActiveSession}
            onSetAutoCompaction={setAutoCompactionRemote}
            onSetTheme={setThemeMode}
            onSetThinking={async (level) => {
              const result = (await compactSend("set_thinking_level", { level })) as
                | { level?: string; availableThinkingLevels?: string[] }
                | undefined;
              setThinkingLevel(result?.level || level);
              if (result?.availableThinkingLevels) {
                usePiWebUiStore.getState().setAvailableThinkingLevels(result.availableThinkingLevels);
              }
            }}
            onToggleAuth={toggleAuth}
            sessionName={sessionName}
            showThinking={showThinking}
            setShowThinking={setShowThinking}
            themeMode={themeMode}
            thinkingLevel={thinkingLevel}
            availableThinkingLevels={availableThinkingLevels}
          />
        )}
        {commandOpen && <CommandPalette commands={commandActions} onClose={() => setCommandOpen(false)} />}
        {forkPickerMessages && (
          <ForkMessagePicker
            messages={forkPickerMessages}
            onCancel={() => setForkPickerMessages(null)}
            onSelect={(message) => {
              if (forkPickerSessionIdRef.current !== usePiWebUiStore.getState().sessionId) {
                setError(uiText("Session changed. Reopen the fork message picker."));
                setForkPickerMessages(null);
                return;
              }
              void forkToNewSession("fork", message.entryId, message.text);
            }}
          />
        )}
        {resumeListing && (
          <ResumeSessionPicker
            listing={resumeListing}
            loading={resumeLoading}
            onRangeChange={(range) => void openResumePicker(range)}
            onCancel={closeResumePicker}
            onSelect={(selection) => void resumeSelectedSession(selection)}
          />
        )}
        {sessionDetails && <SessionDetails stats={sessionDetails} onClose={() => setSessionDetails(null)} />}
        <InteractionCenter />
        {dialog && (
          <ExtensionDialogView
            dialog={dialog}
            onCancel={() => respondDialog({ cancelled: true })}
            onRespond={respondDialog}
          />
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
