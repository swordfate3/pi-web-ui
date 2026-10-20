import type { HubRoute, WsError, WsEvent, WsRequest, WsResponse } from "./types";
import { UiError, type UiText, uiText } from "./ui-text";
import { wsUrl } from "./ws";

type PiClientOptions = {
  onConnectionChange: (state: "connecting" | "connected" | "disconnected") => void;
  onError: (message: UiText | null) => void;
  onEvent: (event: WsEvent) => void;
  onOpen: () => void;
  onPromptResponse: (result: unknown) => void;
};

type PendingRequest = {
  method: string;
  request: WsRequest;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export class PiClient {
  private ws: WebSocket | null = null;
  private intentionallyClosed = false;
  private reconnectTimer: number | null = null;
  private hubRoute: HubRoute | null = null;
  private hubRoutePath: string | null = null;
  private handoffDeadline = 0;
  private managedRestart: { id: string; timeoutMs: number; deadline?: number } | null = null;
  private handoffController: AbortController | null = null;
  private requestCounter = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly sentRequestIds = new Set<string>();
  private readonly queuedRequests: WsRequest[] = [];
  private readonly options: PiClientOptions;

  constructor(options: PiClientOptions) {
    this.options = options;
  }

  connect() {
    this.intentionallyClosed = false;
    this.options.onConnectionChange("connecting");
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.options.onError(null);
      this.options.onConnectionChange("connected");
      this.flushQueuedRequests();
      this.options.onOpen();
    };

    ws.onmessage = (messageEvent) => {
      if (this.ws !== ws) return;
      try {
        const data = JSON.parse(messageEvent.data) as WsResponse | WsEvent | WsError;
        if (data.type === "res") {
          const pending = this.pendingRequests.get(data.id);
          if (!pending) return;
          this.pendingRequests.delete(data.id);
          this.sentRequestIds.delete(data.id);
          if (data.ok) {
            pending.resolve(data.result);
            if (pending.method === "prompt") this.options.onPromptResponse(data.result);
          } else {
            pending.reject(data.error ? new Error(data.error) : new UiError(uiText("Request failed")));
          }
        } else if (data.type === "event") {
          if (data.event === "hub_route") {
            const route = data.payload as Partial<HubRoute> | undefined;
            if (
              route &&
              isHubGeneration(route.generation) &&
              typeof route.token === "string" &&
              /^[a-f0-9]{48}$/.test(route.token) &&
              location.pathname === `/s/${route.generation}/`
            ) {
              const restart = route.restart;
              if (
                restart &&
                typeof restart.id === "string" &&
                /^[a-f0-9]{32}$/.test(restart.id) &&
                restart.timeoutMs === 120_000
              ) {
                // Repeated control for the same operation must not extend its lease.
                if (this.managedRestart?.id !== restart.id)
                  this.managedRestart = { id: restart.id, timeoutMs: 120_000 };
              } else this.managedRestart = null;
              this.hubRoute = { generation: route.generation, token: route.token };
              this.hubRoutePath = location.pathname;
              this.handoffDeadline = 0;
            }
          } else this.options.onEvent(data);
        } else if (data.type === "error") {
          this.options.onError(data.message || uiText("Server error"));
        }
      } catch (error) {
        console.error("[pi-web-ui] Failed to parse WebSocket message", error);
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      if (!this.hubRoute) this.options.onError(uiText("WebSocket error"));
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.managedRestart) this.managedRestart.deadline ??= Date.now() + this.managedRestart.timeoutMs;
      for (const id of this.sentRequestIds) {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          pending.reject(new UiError(uiText("WebSocket disconnected before the request completed")));
          this.pendingRequests.delete(id);
        }
      }
      this.sentRequestIds.clear();
      // Never replay user intent into a different session after reconnect. In
      // particular, another tab may have queued prompts while a replacement
      // or reload tore down the previous runtime.
      for (const request of this.queuedRequests) {
        const pending = this.pendingRequests.get(request.id);
        if (pending) {
          pending.reject(new UiError(uiText("WebSocket disconnected before the request could be sent")));
          this.pendingRequests.delete(request.id);
        }
      }
      this.queuedRequests.length = 0;
      this.options.onConnectionChange("disconnected");
      if (!this.intentionallyClosed) {
        const route = this.hubRoute;
        if (route) void this.recoverHubRoute(route);
        else this.scheduleReconnect();
      }
    };
  }

  send(method: string, params?: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => {
      if (this.handoffController) {
        reject(new UiError(uiText("Wait for the session to finish syncing.")));
        return;
      }
      // Never queue a session replacement for a later connection/session.
      if (["fork_session", "switch_session", "reload"].includes(method) && this.ws?.readyState !== WebSocket.OPEN) {
        reject(new UiError(uiText("Reconnect before starting a session action")));
        return;
      }
      this.requestCounter += 1;
      const request: WsRequest = {
        type: "req",
        id: `req-${Date.now()}-${this.requestCounter}`,
        method,
        ...(params && { params }),
      };
      this.pendingRequests.set(request.id, { method, request, resolve, reject });
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sentRequestIds.add(request.id);
        this.ws.send(JSON.stringify(request));
      } else {
        this.queuedRequests.push(request);
      }
    });
  }

  ensureConnected() {
    if (this.ws?.readyState === WebSocket.OPEN || this.reconnectTimer || this.handoffController) return;
    if (this.ws) {
      this.ws.close();
      return;
    }
    this.connect();
  }

  disconnect() {
    this.intentionallyClosed = true;
    this.handoffController?.abort();
    this.handoffController = null;
    this.hubRoute = null;
    this.hubRoutePath = null;
    this.handoffDeadline = 0;
    this.managedRestart = null;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new UiError(uiText("Client disconnected")));
    }
    this.pendingRequests.clear();
    this.sentRequestIds.clear();
    this.queuedRequests.length = 0;
  }

  private scheduleReconnect() {
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1200);
  }

  private async recoverHubRoute(route: HubRoute) {
    const sourcePath = this.hubRoutePath ?? `/s/${route.generation}/`;
    if (location.pathname !== sourcePath) return;
    const controller = new AbortController();
    this.handoffController = controller;
    this.handoffDeadline ||= this.managedRestart?.deadline ?? Date.now() + 15_000;
    const timeout = window.setTimeout(() => controller.abort(), Math.max(0, this.handoffDeadline - Date.now()));
    this.options.onConnectionChange("connecting");
    try {
      while (!controller.signal.aborted && !this.intentionallyClosed && Date.now() < this.handoffDeadline) {
        try {
          const response = await fetch("/api/session-handoff", {
            method: "POST",
            headers: { "X-Pi-Web-Handoff": route.token },
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          });
          if (response.status === 200) {
            const result = await response.json();
            if (!isHubSessionPath(result.path)) break;
            if (
              controller.signal.aborted ||
              this.handoffController !== controller ||
              this.intentionallyClosed ||
              location.pathname !== sourcePath
            )
              return;
            // Keep the mounted app, its session-action waiter and unsent draft.
            // Only replace the address; never replay a lifecycle request.
            window.history.replaceState(window.history.state, "", result.path);
            // replaceState does not emit popstate. Notify route-scoped UI before
            // opening the successor socket, rather than waiting on a polling tick.
            window.dispatchEvent(new Event("pi-web-route-changed"));
            // Retain the existing capability until the new socket receives its
            // own Hub control frame. A failed handshake must still be able to
            // resolve the first successor, not retry a retired path forever.
            this.hubRoutePath = result.path;
            this.handoffController = null;
            this.connect();
            return;
          }
          if (response.status !== 202) break;
        } catch {
          if (controller.signal.aborted) break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
      if (this.handoffController === controller && !this.intentionallyClosed) {
        this.hubRoute = null;
        this.hubRoutePath = null;
        this.handoffDeadline = 0;
        this.options.onConnectionChange("disconnected");
        this.options.onError(uiText("Session link expired. Reopen this Pi from the Hub."));
      }
    } finally {
      window.clearTimeout(timeout);
      if (this.handoffController === controller) this.handoffController = null;
    }
  }

  private flushQueuedRequests() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const queued = this.queuedRequests.splice(0);
    for (const request of queued) {
      this.sentRequestIds.add(request.id);
      this.ws.send(JSON.stringify(request));
    }
  }
}

import { isHubGeneration, isHubSessionPath } from "../../../../extensions/hub-generation";
