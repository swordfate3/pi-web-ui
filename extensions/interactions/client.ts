/** Public, versioned cooperative API. No Pi runner/private extension imports. */
import type {
  AdapterManifest,
  InteractionBroker,
  InteractionResult,
  SourceAdapter,
  SourceRequestHandle,
  SourceRequestOptions,
} from "./broker.ts";
import { INTERACTION_LIMITS, INTERACTION_PROTOCOL, type InteractionSpec, validateAnswer } from "./protocol.ts";

export type { AdapterManifest, InteractionResult, SourceRequestHandle, SourceRequestOptions } from "./broker.ts";
export type { PanelManifest, PanelRegistration, PanelSnapshot } from "./panels.ts";
export { registerInteractionPanel } from "./panels.ts";
export type { InteractionAnswer, InteractionRequest, InteractionSpec, Json, ResponseSchema } from "./protocol.ts";
export { contentDigest, INTERACTION_PROTOCOL } from "./protocol.ts";
export type InteractionEventBus = {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: (data: unknown) => void) => () => void;
};
export type InteractionClient = {
  status: () => "absent" | "unsupported" | "available";
  interact: (spec: InteractionSpec, options: SourceRequestOptions) => Promise<InteractionResult>;
  request: (spec: InteractionSpec, options: SourceRequestOptions) => SourceRequestHandle | undefined;
  dispose: () => void;
};
type Offer = { protocol: string; register: (manifest: AdapterManifest) => SourceAdapter };
const DISCOVERY = "pi-web-interactions:discover";

export function createInteractionClient(events: InteractionEventBus, manifest: AdapterManifest): InteractionClient {
  let adapter: SourceAdapter | undefined;
  let disposed = false;
  const fallbacks = new Map<AbortController, () => void>();
  const discover = () => {
    if (disposed) throw new Error("Interaction client disposed");
    if (adapter?.active()) return "available";
    adapter = undefined;
    const offers: unknown[] = [];
    events.emit(DISCOVERY, { protocol: INTERACTION_PROTOCOL, accept: (offer: unknown) => offers.push(offer) });
    if (offers.length === 0) return "absent";
    if (offers.length !== 1) return "unsupported";
    const offer = offers[0] as Partial<Offer> | null;
    if (!offer || offer.protocol !== INTERACTION_PROTOCOL || typeof offer.register !== "function") return "unsupported";
    adapter = offer.register(manifest);
    return "available";
  };
  return {
    status: discover,
    request: (spec, options) => (discover() === "available" ? adapter?.request(spec, options) : undefined),
    interact: async (spec, options) => {
      if (discover() === "available" && adapter) return adapter.request(spec, options).result;
      // Missing/unsupported optional Web integration keeps the original terminal
      // choice. A present but broken broker throws; it never auto-approves or
      // silently retries an operation through a different decision path.
      if (!Number.isSafeInteger(spec.deadline)) throw new Error("Invalid interaction deadline");
      if (spec.deadline <= Date.now()) return { state: "expired" };
      if (options.signal?.aborted) return { state: "cancelled" };
      if (!options.isCurrent()) return { state: "stale" };
      if (!options.local) return { state: "cancelled" };
      return new Promise<InteractionResult>((resolve) => {
        const controller = new AbortController();
        let settled = false;
        const finish = (result: InteractionResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fallbacks.delete(controller);
          options.signal?.removeEventListener("abort", cancel);
          controller.abort();
          resolve(result);
        };
        const cancel = () => finish({ state: "cancelled" });
        const effectiveDeadline = Math.min(
          spec.deadline,
          Date.now() + (spec.purpose === "oauth" ? INTERACTION_LIMITS.oauthMs : INTERACTION_LIMITS.confirmationMs),
        );
        const remaining = effectiveDeadline - Date.now();
        const timer = setTimeout(() => finish({ state: "expired" }), Math.max(1, remaining));
        fallbacks.set(controller, cancel);
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (options.signal?.aborted || disposed) {
          cancel();
          return;
        }
        void Promise.resolve()
          .then(() => {
            if (settled || disposed || controller.signal.aborted) return undefined;
            if (!options.isCurrent()) {
              finish({ state: "stale" });
              return undefined;
            }
            if (Date.now() >= effectiveDeadline) {
              finish({ state: "expired" });
              return undefined;
            }
            return options.local?.(controller.signal);
          })
          .then((answer) => {
            if (settled) return;
            if (options.signal?.aborted || disposed) {
              cancel();
              return;
            }
            if (!options.isCurrent()) {
              finish({ state: "stale" });
              return;
            }
            if (Date.now() >= effectiveDeadline) {
              finish({ state: "expired" });
              return;
            }
            if (answer === undefined) {
              cancel();
              return;
            }
            const value = validateAnswer(spec.schema, answer);
            finish({ state: value === false ? "rejected" : "allowed", answer: value, winner: "local" });
          })
          .catch(cancel);
      });
    },
    dispose: () => {
      disposed = true;
      for (const cancel of [...fallbacks.values()]) cancel();
      adapter?.dispose();
      adapter = undefined;
    },
  };
}

/** Host integration only; not permission to resolve unadapted SDK dialogs. */
export function installInteractionBroker(events: InteractionEventBus, broker: InteractionBroker) {
  return events.on(DISCOVERY, (value) => {
    const query = value as { protocol?: unknown; accept?: unknown } | null;
    if (query?.protocol !== INTERACTION_PROTOCOL || typeof query.accept !== "function") return;
    query.accept({
      protocol: INTERACTION_PROTOCOL,
      register: (manifest: AdapterManifest) => broker.registerAdapter(manifest),
    } satisfies Offer);
  });
}
