import {
  extractText,
  extractThinking,
  extractToolCalls,
  findLastUsage,
  formatToolOutput,
  syncToItems,
} from "../chat-conversion";
import { recentHistoryRange } from "../history-dates";
import { workspaceUploadText } from "../i18n";
import { decodeSessionTreeOrKeep } from "../session-tree-wire";
import { isToolExpandable } from "../tool-summary";
import type { ChatItem } from "../types";
import { errorUiText, uiText } from "../ui-text";
import { parseUsageStats } from "../usage-stats";
import { artifactsFromEntries } from "../workspace-artifacts";
import { runSessionAction } from "./session-action";
import type { SessionSlice, StoreSlice } from "./types";

let itemCounter = 0;

function nextId(prefix: string) {
  itemCounter += 1;
  return `${prefix}-${Date.now()}-${itemCounter}`;
}

export const createSessionSlice: StoreSlice<SessionSlice> = (set, get, api) => {
  let streamingId: string | null = null;
  let streamingHasToolCall = false;
  let historySelected = false;
  let historyGeneration = 0;
  let conversationSyncInFlight = false;
  let conversationSyncPending = false;
  let conversationSyncTimer: number | null = null;
  const identity = () => ({ sessionId: get().sessionId, runtimeId: get().runtimeId });
  const sameIdentity = (source: ReturnType<typeof identity>) =>
    source.sessionId === get().sessionId && source.runtimeId === get().runtimeId;
  return {
    getUsageStats: async () => {
      const source = identity();
      if (!source.sessionId || !source.runtimeId || get().connection !== "connected" || get().sessionActionPending)
        throw new Error("Usage statistics unavailable for this session.");
      const result = await get().send("get_usage_stats", { sessionId: source.sessionId, runtimeId: source.runtimeId });
      if (!sameIdentity(source) || get().sessionActionPending || get().connection !== "connected")
        throw new Error("Usage statistics unavailable for this session.");
      return parseUsageStats(result, source.sessionId, source.runtimeId);
    },
    historyRange: recentHistoryRange(),
    history: null,
    historyBefore: null,
    historyLoading: false,
    historyError: null,
    isHistoryLive: () =>
      !get().historyBefore &&
      !get().historyLoading &&
      Date.now() >= get().historyRange.from &&
      Date.now() < get().historyRange.to,
    loadHistory: async (range, before) => {
      const source = identity();
      if (!source.sessionId) return;
      const generation = ++historyGeneration;
      historySelected = true;
      streamingId = null;
      streamingHasToolCall = false;
      set({
        historyRange: range,
        historyBefore: before ?? null,
        historyLoading: true,
        historyError: null,
        conversationSyncError: null,
        conversationSyncing: false,
        items: [],
        tree: [],
        artifacts: [],
        history: null,
        selectedTreeEntryId: null,
      });
      try {
        const sync = (await get().send("get_history", {
          ...range,
          ...(before ? { before } : {}),
          sessionId: source.sessionId,
          ...(source.runtimeId ? { runtimeId: source.runtimeId } : {}),
        })) as Parameters<SessionSlice["applyStateSync"]>[0];
        if (generation !== historyGeneration || !sameIdentity(source)) return;
        if (sync.sessionId !== source.sessionId || (source.runtimeId && sync.runtimeId !== source.runtimeId)) return;
        get().applyStateSync(sync, { requested: true });
      } catch (error) {
        if (generation === historyGeneration && sameIdentity(source))
          set({ historyError: errorUiText(error, uiText("Could not load history")) });
      } finally {
        if (generation === historyGeneration && sameIdentity(source)) set({ historyLoading: false });
      }
    },
    items: [],
    chatStatus: "ready",
    tree: [],
    leafId: null,
    sessionId: null,
    runtimeId: null,
    sessionActionPending: false,
    sessionActionError: null,
    sessionActionNotice: null,
    selectedTreeEntryId: null,

    setSessionActionError: (message) => set({ sessionActionError: message, error: message }),

    forkSession: (action, entryId) => runSessionAction([set, get, api], { method: "fork_session", action, entryId }),
    resumeSession: (id, targetSessionId) =>
      runSessionAction([set, get, api], { method: "switch_session", id, targetSessionId }),
    reloadRuntime: () => runSessionAction([set, get, api], { method: "reload" }),
    loadingTreeEntryId: null,
    conversationSyncing: false,
    conversationSyncError: null,
    transportNotice: null,
    dismissTransportNotice: () => set({ transportNotice: null }),
    applyTransportOmitted: (payload) => {
      if (
        payload.sessionId !== get().sessionId ||
        payload.runtimeId !== get().runtimeId ||
        !Number.isSafeInteger(payload.bytes) ||
        (payload.bytes as number) <= 4 * 1024 * 1024 ||
        ![
          "message_start",
          "message_update",
          "message_end",
          "tool_execution_start",
          "tool_execution_update",
          "tool_execution_end",
          "turn_end",
          "auto_compaction_end",
        ].includes(String(payload.sourceEvent))
      )
        return;
      set({
        transportNotice: uiText(
          "Large live content was omitted from Web transport. Bounded previews sync when saved; full data remains in the original session.",
        ),
      });
      // Intermediate updates need no polling: turn_end/agent_end already sync.
      // Terminal omissions recover once from persisted history using normal scope/date fences.
      if (
        ["message_end", "tool_execution_end", "turn_end", "auto_compaction_end"].includes(String(payload.sourceEvent))
      )
        void get().requestConversationSync({ debounce: true });
    },
    lastUsage: null,
    contextWindowSize: 0,

    addSystemMessage: (text, tone = "info") => {
      set((state) => ({ items: [...state.items, { kind: "system", id: nextId("system"), text, tone }] }));
    },

    applyStateSync: (sync, options) => {
      const previousSessionId = get().sessionId;
      const sessionChanged = Boolean(sync.sessionId && previousSessionId && sync.sessionId !== previousSessionId);
      const runtimeChanged = Boolean(
        sync.sessionId && sync.runtimeId && get().runtimeId && sync.runtimeId !== get().runtimeId,
      );
      if (sessionChanged || runtimeChanged) {
        historyGeneration++;
        streamingId = null;
        streamingHasToolCall = false;
        if (sessionChanged) historySelected = false;
        set({
          historyLoading: false,
          historyError: null,
          conversationSyncing: false,
          transportNotice: null,
          ...(sessionChanged
            ? {
                historyRange: recentHistoryRange(),
                historyBefore: null,
                history: null,
                items: [],
                tree: [],
                artifacts: [],
                selectedTreeEntryId: null,
                leafId: null,
              }
            : {}),
        });
      }
      const range = get().historyRange;
      const keepPage =
        !options?.requested &&
        ((!sync.history && historySelected) ||
          (Boolean(sync.history) &&
            (sync.history?.from !== range.from ||
              sync.history?.to !== range.to ||
              get().historyBefore ||
              get().historyLoading)));
      const entries = sync.entries ?? [];
      const items = syncToItems(entries, nextId);
      if (!keepPage) {
        streamingId = null;
        streamingHasToolCall = false;
        // Pi persists assistant entries only after message_end. Snapshot entries
        // are completed history, never the currently streaming assistant.
      }
      const artifacts = artifactsFromEntries(entries);
      const decodedTree = decodeSessionTreeOrKeep(sync, get().tree);
      const tree = decodedTree.tree;
      const notice = sessionChanged ? null : get().sessionActionNotice;
      if (notice) items.push({ kind: "system", id: nextId("session-action"), text: notice, tone: "success" });
      const currentSelection = sessionChanged ? null : get().selectedTreeEntryId;
      let selectedTreeEntryId: string | null = sync.leafId ?? null;

      if (decodedTree.ok && currentSelection) {
        const stack = [...tree];
        while (stack.length > 0) {
          const node = stack.pop();
          if (node?.entry.id === currentSelection) {
            selectedTreeEntryId = currentSelection;
            break;
          }
          if (node) {
            for (const child of node.children) stack.push(child);
          }
        }
      }

      // Keep navigation state aligned with the retained tree on a rejected snapshot.
      if (!decodedTree.ok) selectedTreeEntryId = get().selectedTreeEntryId;

      set({
        artifacts,
        conversationSyncError: decodedTree.error,
        chatStatus: sync.isStreaming ? "streaming" : "ready",
        connection: "connected",
        contextWindowSize: sync.model?.contextWindow || get().contextWindowSize,
        currentModel: sync.model || null,
        error: sessionChanged ? null : get().error,
        items,
        lastUsage: findLastUsage(entries),
        leafId: decodedTree.ok ? (sync.leafId ?? null) : get().leafId,
        sessionId: sync.sessionId ?? previousSessionId,
        // A runtime identity only counts when this snapshot explicitly identifies
        // its session too (reload must not complete on a partial snapshot).
        runtimeId: sync.sessionId ? (sync.runtimeId ?? (sessionChanged ? null : get().runtimeId)) : get().runtimeId,
        sessionActionNotice: notice,
        modelLabel: sync.model?.id ? sync.model.id.split("/").pop() || sync.model.id : "model",
        selectedTreeEntryId,
        sessionName: sync.sessionName || "Pi Web UI",
        thinkingLevel: sync.thinkingLevel || "off",
        availableThinkingLevels: sync.availableThinkingLevels || ["off"],
        tree,
        history: sync.history ?? null,
        ...(keepPage
          ? {
              items: get().items,
              tree: get().tree,
              artifacts: get().artifacts,
              history: get().history,
              selectedTreeEntryId: get().selectedTreeEntryId,
              leafId: get().leafId,
            }
          : {}),
      });
      get().requestGitStatusRefresh({ debounce: true });
      if (keepPage && !get().historyLoading) void get().loadHistory(range, get().historyBefore ?? undefined);
    },

    requestConversationSync: async (options) => {
      if (options?.debounce) {
        if (conversationSyncTimer) window.clearTimeout(conversationSyncTimer);
        conversationSyncTimer = window.setTimeout(() => {
          conversationSyncTimer = null;
          void get().requestConversationSync();
        }, 250);
        return;
      }

      if (conversationSyncInFlight) {
        conversationSyncPending = true;
        return;
      }

      conversationSyncInFlight = true;
      const generation = historyGeneration;
      const source = identity();
      const range = get().historyRange;
      const before = get().historyBefore;
      set({ conversationSyncError: null, conversationSyncing: true });
      try {
        const sync = (await get().send("sync_request", {
          ...range,
          ...(before ? { before } : {}),
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
          ...(source.runtimeId ? { runtimeId: source.runtimeId } : {}),
        })) as Parameters<SessionSlice["applyStateSync"]>[0];
        if (
          generation === historyGeneration &&
          sameIdentity(source) &&
          (!sync.sessionId || sync.sessionId === source.sessionId) &&
          (!sync.runtimeId || sync.runtimeId === source.runtimeId)
        )
          get().applyStateSync(sync, { requested: true });
      } catch (error) {
        if (generation === historyGeneration && sameIdentity(source))
          set({ conversationSyncError: errorUiText(error, uiText("Sync failed")) });
      } finally {
        conversationSyncInFlight = false;
        set({ conversationSyncing: false });
        if (conversationSyncPending) {
          conversationSyncPending = false;
          window.setTimeout(() => void get().requestConversationSync(), 0);
        }
      }
    },

    clearConversationTimers: () => {
      historyGeneration++;
      if (conversationSyncTimer) window.clearTimeout(conversationSyncTimer);
      conversationSyncTimer = null;
    },

    setChatStatus: (chatStatus) => set({ chatStatus }),
    setSelectedTreeEntryId: (selectedTreeEntryId) => set({ selectedTreeEntryId }),
    setLoadingTreeEntryId: (loadingTreeEntryId) => set({ loadingTreeEntryId }),
    setLastUsage: (lastUsage) => set({ lastUsage }),
    setContextWindowSize: (contextWindowSize) => set({ contextWindowSize }),

    sendPrompt: async (command) => {
      const source = identity();
      if (
        command.scope &&
        (source.sessionId !== command.scope.sessionId || source.runtimeId !== command.scope.runtimeId)
      ) {
        throw new Error(workspaceUploadText("sessionChangedRetry"));
      }
      set({ chatStatus: "submitted", error: null });
      try {
        await get().send("prompt", {
          message: command.message,
          ...(command.images?.length && { images: command.images }),
          ...(command.uploads?.length && { uploads: command.uploads }),
          ...(command.scope ? { sessionId: command.scope.sessionId, runtimeId: command.scope.runtimeId } : {}),
        });
      } catch (error) {
        if (sameIdentity(source)) {
          set({ chatStatus: "error", error: errorUiText(error, uiText("Prompt failed")) });
        }
        throw error;
      }
    },

    abort: async () => {
      try {
        await get().send("abort");
        set({ chatStatus: "ready" });
        get().addSystemMessage(uiText("Aborted by user"), "error");
      } catch (error) {
        set({ error: errorUiText(error, uiText("Abort failed")) });
      }
    },

    toggleAllTools: (open) => {
      set((state) => ({
        items: state.items.map((item) => (item.kind === "tool" && isToolExpandable(item) ? { ...item, open } : item)),
      }));
    },

    toggleTool: (id, open) => {
      set((state) => ({
        items: state.items.map((item) => (item.kind === "tool" && item.id === id ? { ...item, open } : item)),
      }));
    },

    applyAgentStart: () => {
      set({ chatStatus: "streaming" });
    },

    applyAgentEnd: () => {
      const hadToolCall = streamingHasToolCall;
      set((state) => ({
        chatStatus: "ready",
        items: state.items.map((item) =>
          item.kind === "message" && item.streaming
            ? {
                ...item,
                copyable: !hadToolCall,
                presentation: hadToolCall ? "activity" : "normal",
                streaming: false,
              }
            : item,
        ),
      }));
      streamingId = null;
      streamingHasToolCall = false;
      void get().requestConversationSync({ debounce: true });
      get().requestGitStatusRefresh({ debounce: true });
    },

    applyMessageStart: (event) => {
      if (!get().isHistoryLive()) return;
      if (event.message?.role === "assistant") {
        const id = event.message.id || nextId("assistant");
        const hasInitialToolCall = extractToolCalls(event.message.content).length > 0;
        streamingId = id;
        streamingHasToolCall = hasInitialToolCall;
        set((state) => ({
          items: [
            ...state.items,
            {
              kind: "message",
              id,
              role: "assistant",
              text: extractText(event.message?.content),
              reasoning: extractThinking(event.message?.content),
              streaming: true,
              copyable: false,
              presentation: hasInitialToolCall ? "activity" : "normal",
            },
          ],
        }));
        return;
      }

      if (event.message?.role === "user") {
        const text = extractText(event.message.content);
        if (!text) return;
        set((state) => ({
          items: [...state.items, { kind: "message", id: event.message?.id || nextId("user"), role: "user", text }],
        }));
      }
    },

    applyMessageUpdate: (event) => {
      if (!get().isHistoryLive()) return;
      const messageEvent = event.assistantMessageEvent;
      const delta = messageEvent?.delta || "";
      if (
        !streamingId &&
        get().chatStatus === "streaming" &&
        (messageEvent?.type === "toolcall_delta" ||
          (delta && (messageEvent?.type === "text_delta" || messageEvent?.type === "thinking_delta")))
      ) {
        get().applyMessageStart({ type: "message_start", message: { role: "assistant", content: "" } });
      }
      const id = streamingId;
      if (!id) return;
      if (messageEvent?.type === "toolcall_delta") {
        streamingHasToolCall = true;
        set((state) => ({
          items: state.items.map((item) =>
            item.kind === "message" && item.id === id ? { ...item, copyable: false, presentation: "activity" } : item,
          ),
        }));
        return;
      }
      if (!delta || (messageEvent?.type !== "text_delta" && messageEvent?.type !== "thinking_delta")) return;

      set((state) => ({
        items: state.items.map((item) => {
          if (item.kind !== "message" || item.id !== id) return item;
          if (messageEvent.type === "thinking_delta") return { ...item, reasoning: `${item.reasoning || ""}${delta}` };
          return { ...item, text: `${item.text}${delta}` };
        }),
      }));
    },

    applyMessageEnd: (event) => {
      if (!get().isHistoryLive()) return;
      const id = streamingId;
      if (!id) return;
      const usage = event.message?.usage;
      const finalText = event.message ? extractText(event.message.content) : undefined;
      const finalReasoning = event.message ? extractThinking(event.message.content) : undefined;
      const finalToolCalls = event.message ? extractToolCalls(event.message.content) : undefined;
      const hasToolCalls = finalToolCalls?.length ? true : streamingHasToolCall;

      set((state) => ({
        items: state.items.map((item) =>
          item.kind === "message" && item.id === id
            ? {
                ...item,
                ...(finalReasoning !== undefined && { reasoning: finalReasoning }),
                ...(finalText !== undefined && { text: finalText }),
                copyable: !hasToolCalls,
                cost: usage?.cost?.total,
                presentation: hasToolCalls ? "activity" : "normal",
                streaming: false,
              }
            : item,
        ),
        lastUsage: usage || null,
      }));
      streamingId = null;
      streamingHasToolCall = false;
    },

    applyToolExecutionStart: (event) => {
      if (!get().isHistoryLive()) return;
      if (!event.toolCallId) return;
      streamingHasToolCall = true;
      set((state) => ({
        items: [
          ...state.items,
          {
            kind: "tool",
            id: event.toolCallId as string,
            name: event.toolName || "tool",
            input: event.args,
            state: "input-streaming",
            open: false,
          } satisfies ChatItem,
        ],
      }));
    },

    applyToolExecutionUpdate: (event) => {
      if (!get().isHistoryLive()) return;
      if (!event.toolCallId) return;
      set((state) => ({
        items: state.items.map((item) =>
          item.kind === "tool" && item.id === event.toolCallId
            ? { ...item, output: formatToolOutput(event.partialResult), state: "input-available" }
            : item,
        ),
      }));
    },

    applyToolExecutionEnd: (event) => {
      if (!get().isHistoryLive()) return;
      get().mergeArtifactsFromToolEvent(event);
      get().requestGitStatusRefresh({ debounce: true });
      if (!event.toolCallId) return;
      set((state) => ({
        items: state.items.map((item) =>
          item.kind === "tool" && item.id === event.toolCallId
            ? {
                ...item,
                errorText: event.isError ? String(formatToolOutput(event.result)) : undefined,
                output: event.isError ? undefined : formatToolOutput(event.result),
                state: event.isError ? "output-error" : "output-available",
              }
            : item,
        ),
      }));
    },

    markPromptReady: () => {
      set((state) => ({ chatStatus: state.chatStatus === "submitted" ? "ready" : state.chatStatus }));
    },
  };
};
