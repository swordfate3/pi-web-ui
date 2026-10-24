import { isHubGeneration } from "../../../../../extensions/hub-generation";
import type { StoreSlice } from "./types";

type RecordValue = Record<string, unknown>;
export type InteractionPanelManifest = {
  id: string;
  version: string;
  packageName: string;
  commands: string[];
  methods: string[];
};
export type SessionChoice = {
  requestId: string;
  operationId: string;
  identity: { runId: string; generation: string; runtimeId: string; sessionId: string };
  adapter: { id: string; version: string };
  revision: string;
  digest: string;
  schema: { kind: "confirm" | "select" | "text"; options?: string[]; maxBytes?: number };
  content: RecordValue;
};
export type InteractionNotice = {
  requestId: string;
  adapterId: string;
  action: string;
  classification: "session" | "sensitive";
  deadline: number;
  request?: SessionChoice;
};
export type InteractionView = {
  sessionId: string;
  runtimeId: string;
  generation: string | null;
  managementOrigin: string | null;
  authorityAvailable: boolean;
  panels: InteractionPanelManifest[];
  pending: InteractionNotice[];
};
export type InteractionPanelView = {
  id: string;
  registrationId: string;
  revision: string;
  items: RecordValue[];
  cursor?: string | null;
  config?: RecordValue;
};
export type InteractionAction = { panelId: string; actionId: string; state: string; outcome?: unknown };
export type InteractionSlice = {
  interactionChoiceAttempts: string[];
  interactions: InteractionView | null;
  interactionPanel: InteractionPanelView | null;
  interactionPanelLoading: boolean;
  interactionPanelError: string | null;
  interactionAction: InteractionAction | null;
  applyInteractions: (payload: RecordValue) => void;
  clearInteractions: () => void;
  panelForCommand: (command: string) => string | null;
  openInteractionPanel: (id: string, cursor?: string) => Promise<void>;
  closeInteractionPanel: () => void;
  submitInteractionAction: (method: string, params: RecordValue) => Promise<void>;
  refreshInteractionAction: () => Promise<void>;
  respondInteraction: (request: SessionChoice, answer: boolean | string) => Promise<void>;
};
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const opaque = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 32 && value.every(label);

function parseInteractions(value: RecordValue): InteractionView | null {
  if (
    !label(value.sessionId) ||
    !label(value.runtimeId) ||
    !Array.isArray(value.pending) ||
    value.pending.length > 8 ||
    !Array.isArray(value.panels) ||
    value.panels.length > 32
  )
    return null;
  const panels: InteractionPanelManifest[] = [];
  for (const panel of value.panels) {
    if (
      !record(panel) ||
      !label(panel.id) ||
      !label(panel.version) ||
      !label(panel.packageName) ||
      !strings(panel.commands) ||
      !strings(panel.methods)
    )
      return null;
    panels.push({
      id: panel.id,
      version: panel.version,
      packageName: panel.packageName,
      commands: panel.commands,
      methods: panel.methods,
    });
  }
  const pending: InteractionNotice[] = [];
  for (const notice of value.pending) {
    if (
      !record(notice) ||
      !opaque(notice.requestId) ||
      !label(notice.adapterId) ||
      !label(notice.action) ||
      !["session", "sensitive"].includes(String(notice.classification)) ||
      !Number.isSafeInteger(notice.deadline)
    )
      return null;
    const safe: InteractionNotice = {
      requestId: notice.requestId,
      adapterId: notice.adapterId,
      action: notice.action,
      classification: notice.classification as InteractionNotice["classification"],
      deadline: notice.deadline as number,
    };
    // Never retain a sensitive body even if an incorrectly implemented source sends one.
    if (notice.classification === "session" && record(notice.request)) {
      const request = notice.request;
      if (
        request.classification !== "session" ||
        request.requestId !== notice.requestId ||
        !record(request.identity) ||
        request.identity.sessionId !== value.sessionId ||
        request.identity.runtimeId !== value.runtimeId ||
        !opaque(request.identity.runId) ||
        !record(request.adapter) ||
        request.adapter.id !== notice.adapterId ||
        !label(request.adapter.version) ||
        !label(request.revision) ||
        !opaque(request.operationId) ||
        typeof request.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.digest) ||
        !record(request.schema) ||
        !record(request.content) ||
        !["confirm", "select", "text"].includes(String(request.schema.kind))
      )
        return null;
      if (
        request.schema.kind === "select" &&
        (!Array.isArray(request.schema.options) ||
          request.schema.options.length > 100 ||
          !request.schema.options.every(label))
      )
        return null;
      safe.request = structuredClone(request) as unknown as SessionChoice;
    }
    pending.push(safe);
  }
  let managementOrigin: string | null = null;
  if (typeof value.managementOrigin === "string") {
    try {
      const url = new URL(value.managementOrigin);
      if (
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      )
        managementOrigin = url.origin;
    } catch {
      /* Unavailable is safer than a fabricated management destination. */
    }
  }
  return {
    sessionId: value.sessionId,
    runtimeId: value.runtimeId,
    generation: isHubGeneration(value.generation) ? value.generation : null,
    managementOrigin,
    authorityAvailable: value.authorityAvailable === true,
    pending,
    panels,
  };
}

export const createInteractionSlice: StoreSlice<InteractionSlice> = (set, get) => {
  let epoch = 0;
  let loading = 0;
  let submitting = false;
  const sameScope = (scope: { sessionId: string; runtimeId: string }, captured: number) =>
    captured === epoch &&
    get().connection === "connected" &&
    get().sessionId === scope.sessionId &&
    get().runtimeId === scope.runtimeId;
  return {
    interactionChoiceAttempts: [],
    interactions: null,
    interactionPanel: null,
    interactionPanelLoading: false,
    interactionPanelError: null,
    interactionAction: null,
    clearInteractions: () => {
      epoch++;
      loading++;
      submitting = false;
      set({
        interactionChoiceAttempts: [],
        interactions: null,
        interactionPanel: null,
        interactionPanelLoading: false,
        interactionPanelError: null,
        interactionAction: null,
      });
    },
    applyInteractions: (payload) => {
      if (
        get().connection !== "connected" ||
        payload.sessionId !== get().sessionId ||
        payload.runtimeId !== get().runtimeId
      )
        return;
      const parsed = parseInteractions(payload);
      if (!parsed) return;
      const previous = get().interactions;
      if (previous && parsed.generation !== previous.generation) get().clearInteractions();
      set({
        interactions: parsed,
        interactionChoiceAttempts: get().interactionChoiceAttempts.filter((id) =>
          parsed.pending.some((notice) => notice.requestId === id),
        ),
      });
      const panel = get().interactionPanel;
      if (panel && !parsed.panels.some((item) => item.id === panel.id)) get().closeInteractionPanel();
    },
    panelForCommand: (command) => {
      const panels = get().interactions?.panels.filter((panel) => panel.commands.includes(command)) ?? [];
      return panels.length === 1 ? panels[0].id : null;
    },
    openInteractionPanel: async (id, cursor) => {
      const scope = get().interactions;
      if (!scope?.panels.some((panel) => panel.id === id) || get().connection !== "connected") return;
      const captured = epoch;
      const operation = ++loading;
      set({ interactionPanelLoading: true, interactionPanelError: null });
      try {
        const data = await get().send("get_extension_panel", {
          sessionId: scope.sessionId,
          runtimeId: scope.runtimeId,
          panelId: id,
          ...(cursor ? { cursor } : {}),
        });
        if (!sameScope(scope, captured) || operation !== loading) return;
        if (
          !record(data) ||
          !opaque(data.registrationId) ||
          !label(data.revision) ||
          !Array.isArray(data.items) ||
          data.items.length > 100 ||
          !data.items.every(record) ||
          new TextEncoder().encode(JSON.stringify(data)).length > 65536
        )
          throw new Error("Invalid panel snapshot");
        set({
          interactionPanel: {
            id,
            registrationId: data.registrationId,
            revision: data.revision,
            items: data.items,
            ...(typeof data.cursor === "string" || data.cursor === null ? { cursor: data.cursor } : {}),
            ...(record(data.config) ? { config: data.config } : {}),
          },
          interactionPanelLoading: false,
        });
      } catch {
        if (sameScope(scope, captured) && operation === loading)
          set({
            interactionPanelLoading: false,
            interactionPanelError: "Panel unavailable or changed. Refresh before trying again.",
          });
      }
    },
    closeInteractionPanel: () => {
      loading++;
      set({ interactionPanel: null, interactionPanelLoading: false, interactionPanelError: null });
    },
    submitInteractionAction: async (method, params) => {
      const scope = get().interactions;
      const panel = get().interactionPanel;
      const previous = get().interactionAction;
      if (
        !scope ||
        !panel ||
        submitting ||
        (previous && ["pending", "delivery_unknown", "preparing"].includes(previous.state)) ||
        !scope.panels.some((source) => source.id === panel.id && source.methods.includes(method))
      )
        return;
      submitting = true;
      const captured = epoch;
      let admitted = false;
      set({ interactionPanelError: null, interactionAction: { panelId: panel.id, actionId: "", state: "preparing" } });
      try {
        const action = await get().send("prepare_extension_panel_action", {
          sessionId: scope.sessionId,
          runtimeId: scope.runtimeId,
          panelId: panel.id,
          action: { registrationId: panel.registrationId, revision: panel.revision, method, params },
        });
        if (!sameScope(scope, captured)) return;
        if (!record(action) || !opaque(action.actionId)) throw new Error("Admission unavailable");
        admitted = true;
        set({ interactionAction: { panelId: panel.id, actionId: action.actionId, state: "delivery_unknown" } });
        const result = await get().send("start_extension_panel_action", {
          sessionId: scope.sessionId,
          runtimeId: scope.runtimeId,
          panelId: panel.id,
          action,
        });
        if (!sameScope(scope, captured)) return;
        if (!record(result) || result.actionId !== action.actionId || typeof result.state !== "string")
          throw new Error("Unknown delivery");
        set({ interactionAction: { panelId: panel.id, actionId: action.actionId, state: result.state } });
      } catch {
        if (sameScope(scope, captured))
          set({
            interactionPanelError: admitted
              ? "Delivery unknown. Check the original action; do not submit it again."
              : "Action was not admitted. Refresh the panel.",
            ...(!admitted ? { interactionAction: null } : {}),
          });
      } finally {
        if (captured === epoch) submitting = false;
      }
    },
    refreshInteractionAction: async () => {
      const scope = get().interactions;
      const action = get().interactionAction;
      const captured = epoch;
      if (!scope || !action?.actionId) return;
      try {
        const result = await get().send("get_extension_panel_action", {
          sessionId: scope.sessionId,
          runtimeId: scope.runtimeId,
          panelId: action.panelId,
          actionId: action.actionId,
        });
        if (!sameScope(scope, captured) || get().interactionAction?.actionId !== action.actionId) return;
        if (!record(result) || result.actionId !== action.actionId || typeof result.state !== "string")
          throw new Error();
        set({
          interactionAction: { panelId: action.panelId, actionId: action.actionId, state: result.state },
          interactionPanelError: null,
        });
      } catch {
        if (sameScope(scope, captured))
          set({ interactionPanelError: "Original action status unavailable. Check Pi before retrying." });
      }
    },
    respondInteraction: async (request, answer) => {
      const scope = get().interactions;
      const captured = epoch;
      if (
        !scope ||
        submitting ||
        get().interactionChoiceAttempts.includes(request.requestId) ||
        !scope.pending.some(
          (notice) =>
            notice.classification === "session" &&
            notice.requestId === request.requestId &&
            notice.request?.digest === request.digest,
        )
      )
        return;
      const schema = request.schema;
      const valid =
        schema.kind === "confirm"
          ? typeof answer === "boolean"
          : schema.kind === "select"
            ? typeof answer === "string" && schema.options?.includes(answer) === true
            : typeof answer === "string" &&
              typeof schema.maxBytes === "number" &&
              Number.isSafeInteger(schema.maxBytes) &&
              schema.maxBytes > 0 &&
              new TextEncoder().encode(answer).length <= schema.maxBytes;
      if (!valid) {
        set({ interactionPanelError: "输入不符合此请求的选项或长度限制，请修改后提交。" });
        return;
      }
      submitting = true;
      set({
        interactionChoiceAttempts: [...get().interactionChoiceAttempts, request.requestId],
        interactionPanelError: null,
      });
      try {
        await get().send("respond_extension_interaction", {
          sessionId: scope.sessionId,
          runtimeId: scope.runtimeId,
          decision: {
            identity: request.identity,
            requestId: request.requestId,
            operationId: request.operationId,
            adapterId: request.adapter.id,
            adapterVersion: request.adapter.version,
            revision: request.revision,
            digest: request.digest,
            decisionId: crypto.randomUUID().replaceAll("-", ""),
            answer,
          },
        });
        const current = get().interactions;
        if (sameScope(scope, captured) && current)
          set({
            interactions: {
              ...current,
              pending: current.pending.filter((notice) => notice.requestId !== request.requestId),
            },
          });
      } catch {
        if (sameScope(scope, captured))
          set({ interactionPanelError: "Choice changed or delivery unknown. Check Pi before retrying." });
      } finally {
        if (captured === epoch) submitting = false;
      }
    },
  };
};
