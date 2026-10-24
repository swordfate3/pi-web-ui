import { randomBytes } from "node:crypto";
import type { InteractionEventBus } from "./client.ts";
import {
  canonicalJson,
  contentDigest,
  exactKeys,
  INTERACTION_LIMITS,
  INTERACTION_PROTOCOL,
  type Json,
  opaqueId,
  plainRecord,
  safeLabel,
  validateAdapter,
} from "./protocol.ts";

export type PanelSnapshot = {
  revision: string;
  items: Record<string, Json>[];
  cursor?: string | null;
  config?: Record<string, Json>;
};
export type PanelManifest = { id: string; version: string; packageName: string; commands: string[]; methods: string[] };
export type PanelRegistration = {
  manifest: PanelManifest;
  isCurrent: () => boolean;
  snapshot: (cursor?: string) => Promise<PanelSnapshot>;
  invoke: (
    method: string,
    params: Record<string, Json>,
    context: { actionId: string; revision: string; signal: AbortSignal },
  ) => Promise<Json>;
};
type ActionDraft = { registrationId: string; revision: string; method: string; params: Record<string, Json> };
type Action = ActionDraft & { actionId: string };
type Receipt = {
  actionId: string;
  panelId: string;
  registrationId: string;
  digest: string;
  expiresAt: number;
  state: "prepared" | "pending" | "succeeded" | "failed" | "cancelled" | "delivery_unknown";
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  outcome?: Json;
};
function invalid(): never {
  throw new Error("Extension panel unavailable or changed");
}

/** Transports source-owned projections/actions only; knows no extension managers. */
export class InteractionPanels {
  private readonly sources = new Map<string, PanelRegistration & { registrationId: string }>();
  private readonly actions = new Map<string, Receipt>();
  private readonly now: () => number;
  private readonly onChange?: () => void;
  private closed = false;
  constructor(now: () => number = Date.now, onChange?: () => void) {
    this.now = now;
    this.onChange = onChange;
  }
  private changed() {
    try {
      this.onChange?.();
    } catch {
      /* A UI observer cannot change source state. */
    }
  }

  register(source: PanelRegistration) {
    canonicalJson(source.manifest);
    const { commands, methods, ...identity } = source.manifest;
    validateAdapter(identity);
    if (this.closed || this.sources.has(identity.id) || this.sources.size >= 32) invalid();
    for (const values of [commands, methods])
      if (
        !Array.isArray(values) ||
        values.length > 32 ||
        new Set(values).size !== values.length ||
        values.some((v) => !/^[a-z][a-z0-9-_.]{0,63}$/.test(v))
      )
        invalid();
    const owned = {
      ...source,
      manifest: structuredClone(source.manifest),
      registrationId: randomBytes(16).toString("hex"),
    };
    this.sources.set(identity.id, owned);
    this.changed();
    return {
      active: () => !this.closed && this.sources.get(identity.id) === owned,
      dispose: () => {
        if (this.sources.get(identity.id) !== owned) return;
        this.sources.delete(identity.id);
        for (const receipt of this.actions.values())
          if (receipt.panelId === identity.id && ["pending", "prepared"].includes(receipt.state))
            this.finish(receipt, "cancelled");
        this.changed();
      },
    };
  }

  private current(id: string) {
    const source = this.sources.get(id);
    try {
      if (!source?.isCurrent() || this.closed) return invalid();
    } catch {
      return invalid();
    }
    return source;
  }

  list() {
    return [...this.sources.keys()].flatMap((id) => {
      try {
        return [structuredClone(this.current(id).manifest)];
      } catch {
        return [];
      }
    });
  }

  hasActiveActions() {
    return [...this.actions.values()].some((receipt) => receipt.state === "pending");
  }

  async snapshot(id: string, cursor?: string): Promise<PanelSnapshot & { registrationId: string }> {
    if (cursor !== undefined && !safeLabel(cursor, 512)) invalid();
    const source = this.current(id);
    const snapshot = await source.snapshot(cursor);
    if (this.current(id) !== source) invalid();
    canonicalJson(snapshot);
    if (!plainRecord(snapshot)) invalid();
    exactKeys(snapshot, ["revision", "items"], ["cursor", "config"]);
    if (
      !safeLabel(snapshot.revision) ||
      !Array.isArray(snapshot.items) ||
      snapshot.items.length > INTERACTION_LIMITS.panelItems ||
      snapshot.items.some((item) => !plainRecord(item)) ||
      (snapshot.cursor !== undefined && snapshot.cursor !== null && !safeLabel(snapshot.cursor, 512)) ||
      (snapshot.config !== undefined && !plainRecord(snapshot.config))
    )
      invalid();
    const result = { ...snapshot, registrationId: source.registrationId };
    canonicalJson(result);
    return structuredClone(result);
  }

  prepare(id: string, draft: ActionDraft): Action {
    this.prune();
    canonicalJson(draft);
    if (!plainRecord(draft)) invalid();
    exactKeys(draft, ["registrationId", "revision", "method", "params"]);
    const source = this.current(id);
    if (
      draft.registrationId !== source.registrationId ||
      !safeLabel(draft.revision) ||
      !plainRecord(draft.params) ||
      !source.manifest.methods.includes(draft.method)
    )
      invalid();
    if ([...this.actions.values()].filter((item) => ["pending", "prepared"].includes(item.state)).length >= 8)
      invalid();
    const action = { ...structuredClone(draft), actionId: randomBytes(16).toString("hex") };
    // Only a source-issued admission can be started. Eviction/expiry loses the
    // result but never turns a caller-supplied old ID into a new operation.
    this.actions.set(action.actionId, {
      actionId: action.actionId,
      panelId: id,
      registrationId: source.registrationId,
      digest: contentDigest({ panelId: id, ...action }),
      expiresAt: this.now() + 10_000,
      state: "prepared",
    });
    return action;
  }

  start(id: string, action: Action) {
    this.prune();
    canonicalJson(action);
    if (!plainRecord(action)) invalid();
    exactKeys(action, ["actionId", "registrationId", "revision", "method", "params"]);
    if (!opaqueId(action.actionId) || !safeLabel(action.revision) || !plainRecord(action.params)) invalid();
    const source = this.current(id);
    if (action.registrationId !== source.registrationId || !source.manifest.methods.includes(action.method)) invalid();
    const digest = contentDigest({ panelId: id, ...action });
    const existing = this.actions.get(action.actionId);
    if (
      !existing ||
      existing.registrationId !== source.registrationId ||
      existing.panelId !== id ||
      existing.digest !== digest
    )
      invalid();
    if (existing.state !== "prepared") return this.actionStatus(id, action.actionId);
    const copy = structuredClone(action);
    const receipt = existing;
    receipt.state = "pending";
    receipt.expiresAt = this.now() + 120_000;
    receipt.controller = new AbortController();
    receipt.timer = setTimeout(() => this.finish(receipt, "delivery_unknown"), 120_000);
    receipt.timer.unref();
    this.actions.set(copy.actionId, receipt);
    void (async () => {
      try {
        const snapshot = await this.snapshot(id);
        if (snapshot.revision !== copy.revision || this.current(id) !== source || receipt.state !== "pending")
          invalid();
        const controller = receipt.controller;
        if (!controller) invalid();
        const outcome = await source.invoke(copy.method, copy.params, {
          actionId: copy.actionId,
          revision: copy.revision,
          signal: controller.signal,
        });
        canonicalJson(outcome);
        if (this.current(id) !== source) invalid();
        this.finish(receipt, "succeeded", outcome);
      } catch {
        this.finish(receipt, "failed");
      }
    })();
    return this.actionStatus(id, action.actionId);
  }

  actionStatus(id: string, actionId: string) {
    this.prune();
    const receipt = this.actions.get(actionId);
    if (!receipt || receipt.panelId !== id) return invalid();
    return {
      actionId,
      state: receipt.state,
      ...(receipt.outcome === undefined ? {} : { outcome: structuredClone(receipt.outcome) }),
    };
  }

  private finish(receipt: Receipt, state: Receipt["state"], outcome?: Json) {
    if (!["pending", "prepared"].includes(receipt.state)) return;
    receipt.state = state;
    receipt.expiresAt = this.now() + INTERACTION_LIMITS.completedMs;
    if (outcome !== undefined) receipt.outcome = structuredClone(outcome);
    clearTimeout(receipt.timer);
    receipt.timer = undefined;
    receipt.controller?.abort();
    receipt.controller = undefined;
    this.prune();
  }

  private prune() {
    for (const [id, receipt] of this.actions)
      if (receipt.state !== "pending" && receipt.expiresAt <= this.now()) this.actions.delete(id);
    const done = () => [...this.actions.values()].filter((receipt) => !["pending", "prepared"].includes(receipt.state));
    // Whole retained result objects are charged; source task inputs are never retained.
    while (done().length > 128 || Buffer.byteLength(JSON.stringify(done())) > 256 * 1024) {
      const first = done()[0];
      if (!first) break;
      this.actions.delete(first.actionId);
    }
  }

  invalidate() {
    for (const receipt of this.actions.values()) if (receipt.state === "pending") this.finish(receipt, "cancelled");
    this.actions.clear();
    this.sources.clear();
    this.changed();
  }
  close() {
    this.closed = true;
    this.invalidate();
  }
}

const DISCOVER = "pi-web-panels:discover";
const READY = "pi-web-panels:ready";
/** Notify cooperative sources only after the native lifecycle has supplied fresh context. */
export function announceInteractionPanels(events: InteractionEventBus) {
  events.emit(READY, { protocol: INTERACTION_PROTOCOL });
}
export function installInteractionPanels(events: InteractionEventBus, panels: InteractionPanels) {
  const off = events.on(DISCOVER, (data) => {
    const query = data as { protocol?: unknown; accept?: unknown } | null;
    if (query?.protocol === INTERACTION_PROTOCOL && typeof query.accept === "function")
      query.accept({
        protocol: INTERACTION_PROTOCOL,
        register: (source: PanelRegistration) => panels.register(source),
      });
  });
  announceInteractionPanels(events);
  return off;
}

/** Explicit opt-in source registration; absent Web host leaves original TUI intact. */
export function registerInteractionPanel(events: InteractionEventBus, source: PanelRegistration) {
  let owned: { active: () => boolean; dispose: () => void } | undefined;
  let disposed = false;
  const attach = () => {
    if (disposed || owned?.active()) return;
    owned = undefined;
    const offers: {
      protocol?: unknown;
      register?: (source: PanelRegistration) => { active: () => boolean; dispose: () => void };
    }[] = [];
    events.emit(DISCOVER, {
      protocol: INTERACTION_PROTOCOL,
      accept: (offer: (typeof offers)[number]) => offers.push(offer),
    });
    if (offers.length === 1 && offers[0].protocol === INTERACTION_PROTOCOL && typeof offers[0].register === "function")
      owned = offers[0].register(source);
  };
  const off = events.on(READY, attach);
  attach();
  return {
    dispose: () => {
      disposed = true;
      off();
      owned?.dispose();
      owned = undefined;
    },
  };
}
