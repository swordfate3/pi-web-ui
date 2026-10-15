import type { ChatStatus } from "ai";
import type { ComponentType } from "react";
import type { UiText } from "./ui-text";

export type ConnectionState = "connecting" | "connected" | "disconnected";
/** Browser-only capability from Hub, never forwarded to the Pi/model. */
export type HubRoute = { generation: string; token: string };
/** Read-only listener facts. Configured registration is not a verified lease. */
export type WebConnectionInfo = {
  port: number;
  localUrl: string;
  advertisedUrl: string;
  registrationConfigured: boolean;
};
export type UsageStatsTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number | null;
  unpricedRequests: number;
  requests: number;
};
export type UsageStatsModel = UsageStatsTotals & { provider: string; model: string };
export type UsageStatsResult = {
  sessionId: string;
  runtimeId: string;
  statisticsScope: "all_entries";
  currency: "USD";
  totals: UsageStatsTotals;
  models: UsageStatsModel[];
  lastResponse: UsageStatsModel | null;
  truncated: boolean;
};

export type ThemeMode = "system" | "light" | "dark";
export type AppView = "chat" | "projects";
export type SystemTone = "info" | "success" | "error";
export type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error";

export type PromptImage = {
  data: string;
  mimeType: string;
};

export type PromptCommand = {
  id: string;
  message: string;
  images?: PromptImage[];
  /** Opaque server receipts for files already uploaded in this exact browser session scope. */
  uploads?: string[];
  scope?: { sessionId: string; runtimeId: string };
};

export type ChatItem =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      reasoning?: string;
      streaming?: boolean;
      copyable?: boolean;
      presentation?: "normal" | "activity";
      cost?: number;
      images?: PromptImage[];
      /** Session entry tree node ID, used for Branch actions via navigate_tree. */
      entryId?: string;
      relatedEntryIds?: string[];
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      /** Invocation is outside this bounded page; the result remains inspectable. */
      resultOnly?: boolean;
      output?: unknown;
      errorText?: string;
      state: ToolState;
      open?: boolean;
      entryId?: string;
      relatedEntryIds?: string[];
    }
  | {
      kind: "system";
      id: string;
      text: UiText;
      tone?: SystemTone;
      entryId?: string;
      relatedEntryIds?: string[];
    };

export type RpcEvent = {
  type: string;
  payload?: unknown;
  message?: PiMessage;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  name?: string;
  summary?: string;
  error?: string;
  method?: ExtensionDialog["method"];
  id?: string;
  title?: string;
  options?: string[];
  timeout?: number;
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  enabled?: boolean;
  model?: ModelInfo;
  level?: string;
  availableThinkingLevels?: string[];
};

export type PiMessage = {
  id?: string;
  role: "user" | "assistant" | "toolResult" | string;
  content?: string | PiContentBlock[];
  customType?: string;
  details?: unknown;
  usage?: Usage;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

export type PiContentBlock =
  | { type: "text"; text?: string }
  | { type: "thinking"; thinking?: string }
  | { type: "toolCall"; id?: string; name?: string; arguments?: unknown }
  | {
      type: "image";
      data?: string;
      mimeType?: string;
      source?: { data?: string; media_type?: string };
    }
  | Record<string, unknown>;

export type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

export type ModelInfo = {
  id: string;
  provider?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
};

export type BrowserCommandInfo = {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
};

export type WsRequest = {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type WsResponse = {
  type: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type WsEvent = {
  type: "event";
  event: string;
  payload?: Record<string, unknown>;
};

export type WsError = {
  type: "error";
  id?: string;
  code?: string;
  message: string;
};

export type HistoryRange = { from: number; to: number };
export type HistoryMetadata = HistoryRange & {
  nextBefore: string | null;
  total: number;
  returned: number;
  truncatedEntries: number;
  treeLimited: boolean;
};
export type StateSyncPayload = {
  history?: HistoryMetadata;
  entries?: SessionEntry[];
  /** Preferred flat DFS pre-order tree; structural parents are independent of entry.parentId. */
  treeNodes?: SessionTreeNodeWire[];
  /** Legacy nested tree. Both wire formats require runtime validation before use. */
  tree?: SessionTreeNode[];
  leafId?: string | null;
  model?: ModelInfo;
  thinkingLevel?: string;
  availableThinkingLevels?: string[];
  sessionName?: string;
  sessionFile?: string;
  sessionId?: string;
  runtimeId?: string;
  isStreaming?: boolean;
  contextUsage?: { tokens?: number };
};

export type SessionEntry = {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  message?: PiMessage;
  details?: unknown;
  data?: unknown;
  value?: unknown;
  payload?: unknown;
  summary?: string;
  label?: string;
  modelId?: string;
  provider?: string;
  thinkingLevel?: string;
  activeToolNames?: string[];
  [key: string]: unknown;
};

export type SessionTreeNodeWire = {
  entry: SessionEntry & { id: string };
  parentNodeId: string | null;
  label?: string;
  labelTimestamp?: string;
};

export type SessionTreeNode = {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
};

export type ConversationTreeItem = {
  id: string;
  parentId: string | null;
  entry: SessionEntry;
  entryType: string;
  isLeaf: boolean;
  isBranchable: boolean;
  isContinuable: boolean;
  continueTargetId?: string;
  label?: string;
  text: string;
  detail?: string;
  depth: number;
  connectorColumns: Array<{ key: string; state: "line" | "blank" }>;
  connectorKind: "none" | "middle" | "last" | "line" | "blank";
  isExpandable: boolean;
  isExpanded: boolean;
  hiddenChildCount: number;
  childCount: number;
  isSearchMatch: boolean;
  order: number;
};

export type GitStatusResult = {
  isRepo: boolean;
  branch: string | null;
  hasChanges: boolean;
  additions: number;
  deletions: number;
  untracked?: number;
};

export type GitDiffResult = {
  isRepo: boolean;
  branch: string | null;
  diff: string;
};

export type FileContentResult = {
  path: string;
  name: string;
  size: number;
  content: string;
};

export type WorkspaceArtifact = {
  id: string;
  path: string;
  name: string;
  directory: string;
  tool: "edit" | "write";
  updatedAt: number;
};

export type RightPanelTab =
  | {
      id: "git-diff";
      kind: "git-diff";
      title: string;
      branch: string | null;
      diff?: string;
      isRepo?: boolean;
      loading?: boolean;
      error?: UiText;
      updatedAt: number;
    }
  | {
      id: `artifact:${string}`;
      kind: "artifact-file";
      title: string;
      path: string;
      content?: string;
      size?: number;
      loading?: boolean;
      error?: UiText;
      updatedAt: number;
    };

export type ExtensionDialog = {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify";
  title?: string;
  message?: string;
  options?: string[];
  timeout?: number;
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
};

export type CommandAction = {
  label: string;
  desc: string;
  icon: ComponentType<{ className?: string }>;
  action: () => void;
};

export type ChatSubmitStatus = ChatStatus;

/** Opaque selection IDs are scoped to this listing's source session. */
export type SavedSession = {
  id: string;
  sessionId: string;
  name: string | null;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  isCurrent: boolean;
};

export type SavedSessionsResult = {
  sessionId: string;
  runtimeId?: string;
  from?: number;
  to?: number;
  total?: number;
  truncated?: boolean;
  cwd: string;
  sessions: SavedSession[];
};

export type SwitchSessionRequest = { id: string; sessionId: string };
export type SwitchSessionAck = { accepted: boolean; sessionId: string; targetSessionId: string };
export type ReloadRequest = { sessionId: string };
/** runtimeId is the OLD runtime, not proof of completion. */
export type ReloadAck = { accepted: boolean; sessionId: string; runtimeId: string };
export type ExportHtmlResult = { token: string; filename: string; downloadUrl: string };
export type FileDownloadResult = { token: string; filename: string; size: number; downloadUrl: string };

export type SessionStatisticsTotals = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type SessionStatsResult = {
  sessionFile?: string | null;
  sessionId?: string;
  sessionName?: string | null;
  cwd?: string;
  sessionDir?: string;
  header?: Record<string, unknown> | null;
  leafId?: string | null;
  entryCount?: number;
  branchEntryCount?: number;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: SessionStatisticsTotals;
  cost?: number;
  costs?: SessionStatisticsTotals;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
  model?: ModelInfo | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  hasPendingMessages?: boolean;
  autoCompactionEnabled?: boolean;
  runtimeId?: string;
  statisticsScope?: string;
};
