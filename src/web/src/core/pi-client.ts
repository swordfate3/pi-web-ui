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
  private managedRestart: { id: string; timeoutMs: number; deadline?: number } | null = null;
  private handoffController: AbortController | null = null;
  private handoffStartedAt = 0;
  private reconnectAttempts = 0;
  private recoveryBlocked = false;
  private socketTimer: number | null = null;
  private openedSocket: WebSocket | null = null;
  private healthCheck: { ws: WebSocket; promise: Promise<boolean> } | null = null;
  private requestCounter = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly sentRequestIds = new Set<string>();
  private readonly queuedRequests: WsRequest[] = [];
  private readonly options: PiClientOptions;

  constructor(options: PiClientOptions) {
    this.options = options;
  }

  connect() {
    if (this.ws || this.handoffController || this.recoveryBlocked) return;
    this.intentionallyClosed = false;
    this.options.onConnectionChange("connecting");
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    this.socketTimer = window.setTimeout(() => this.retireSocket(ws), 8000);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearSocketTimer();
      this.openedSocket = ws;
      this.reconnectAttempts = 0;
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

    ws.onclose = () => this.handleSocketClose(ws);
  }

  private clearSocketTimer() {
    if (this.socketTimer !== null) window.clearTimeout(this.socketTimer);
    this.socketTimer = null;
  }

  private retireSocket(ws: WebSocket) {
    if (this.ws !== ws) return;
    // A suspended network can leave close() waiting indefinitely. Retire the
    // local transport first; late frames/close events cannot affect its successor.
    this.handleSocketClose(ws);
    ws.close();
  }

  private handleSocketClose(ws: WebSocket) {
    if (this.ws !== ws) return;
    const wasOpen = this.openedSocket === ws;
    this.openedSocket = null;
    this.clearSocketTimer();
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
      if (route && wasOpen) void this.recoverHubRoute(route);
      else this.scheduleReconnect();
    }
  }

  send(method: string, params?: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => {
      if (this.intentionallyClosed || this.recoveryBlocked) {
        reject(new UiError(uiText("Pi client is not connected")));
        return;
      }
      if (this.handoffController) {
        reject(new UiError(uiText("Wait for the session to finish syncing.")));
        return;
      }
      // Only read-only requests may wait for a connection. A prompt, approval,
      // or any other mutation submitted during retry backoff must not cross
      // into a successor session when the socket eventually opens.
      const readOnly = method.startsWith("get_") || method === "health" || method === "sync_request";
      if (!readOnly && this.ws?.readyState !== WebSocket.OPEN) {
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

  async ensureConnected(): Promise<boolean> {
    if (this.intentionallyClosed || this.recoveryBlocked) return false;
    if (this.ws?.readyState === WebSocket.OPEN) return this.checkHealth(this.ws);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.handoffController) {
      if (Date.now() - this.handoffStartedAt < 8000) return false;
      this.handoffController.abort();
      this.handoffController = null;
    }
    if (this.ws) {
      // A CONNECTING socket has its own bounded handshake timer.
      if (this.ws.readyState !== WebSocket.CONNECTING) this.retireSocket(this.ws);
      return false;
    }
    if (this.hubRoute) await this.recoverHubRoute(this.hubRoute);
    else this.connect();
    return false;
  }

  private checkHealth(ws: WebSocket): Promise<boolean> {
    if (this.healthCheck?.ws === ws) return this.healthCheck.promise;
    const timeout = window.setTimeout(() => this.retireSocket(ws), 4000);
    const promise = this.send("health")
      .then((result) => {
        if (this.ws !== ws || this.intentionallyClosed) return false;
        if ((result as { status?: string } | null)?.status === "ok") return true;
        this.retireSocket(ws);
        return false;
      })
      .catch(() => {
        this.retireSocket(ws);
        return false;
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (this.healthCheck?.ws === ws) this.healthCheck = null;
      });
    this.healthCheck = { ws, promise };
    return promise;
  }

  disconnect() {
    this.intentionallyClosed = true;
    this.handoffController?.abort();
    this.handoffController = null;
    this.hubRoute = null;
    this.hubRoutePath = null;
    this.managedRestart = null;
    this.clearSocketTimer();
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
    if (this.intentionallyClosed || this.recoveryBlocked || this.reconnectTimer !== null) return;
    const delay = Math.min(1200 * 2 ** Math.min(this.reconnectAttempts++, 4), 15000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.hubRoute) void this.recoverHubRoute(this.hubRoute);
      else this.connect();
    }, delay);
  }

  private async recoverHubRoute(route: HubRoute) {
    const sourcePath = this.hubRoutePath ?? `/s/${route.generation}/`;
    if (location.pathname !== sourcePath) return;
    const controller = new AbortController();
    this.handoffController = controller;
    this.handoffStartedAt = Date.now();
    const deadline = this.managedRestart?.deadline;
    const timeout = window.setTimeout(
      () => controller.abort(),
      Math.max(0, Math.min(8000, (deadline ?? Infinity) - Date.now())),
    );
    let retry = true;
    const isCurrent = () =>
      this.handoffController === controller && !this.intentionallyClosed && location.pathname === sourcePath;
    const stopRecovery = (authentication = false) => {
      retry = false;
      this.recoveryBlocked = true;
      this.options.onConnectionChange("disconnected");
      this.options.onError(
        uiText(
          authentication
            ? "Sign in again to reconnect to this session."
            : "Session link expired. Reopen this Pi from the Hub.",
        ),
      );
    };
    this.options.onConnectionChange("connecting");
    try {
      if (deadline !== undefined && Date.now() >= deadline) {
        stopRecovery();
        return;
      }
      const options = {
        credentials: "same-origin" as const,
        cache: "no-store" as const,
        redirect: "manual" as const,
        signal: controller.signal,
      };
      // A mobile tab may sleep longer than the Hub's disconnected handoff
      // capability lease. Reopen only its exact still-authorized generation;
      // never select a different session from the Hub's directory.
      const current = await fetch(sourcePath, { ...options, method: "HEAD" });
      if (!isCurrent() || controller.signal.aborted) return;
      if (deadline !== undefined && Date.now() >= deadline) {
        stopRecovery();
        return;
      }
      if (current.status === 200) {
        retry = false;
        this.handoffController = null;
        this.connect();
        return;
      }
      if (isAuthenticationFailure(current)) {
        stopRecovery(true);
        return;
      }
      if (![404, 410].includes(current.status)) return;
      const response = await fetch("/api/session-handoff", {
        ...options,
        method: "POST",
        headers: { "X-Pi-Web-Handoff": route.token },
      });
      if (!isCurrent() || controller.signal.aborted) return;
      if (response.status === 200) {
        const result = await response.json();
        if (
          controller.signal.aborted ||
          this.handoffController !== controller ||
          this.intentionallyClosed ||
          location.pathname !== sourcePath
        )
          return;
        if (!isHubSessionPath(result.path) || (deadline !== undefined && Date.now() >= deadline)) {
          stopRecovery();
          return;
        }
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
        retry = false;
        this.handoffController = null;
        this.connect();
        return;
      }
      if (isAuthenticationFailure(response)) stopRecovery(true);
      else if (response.status !== 202 && response.status !== 408 && response.status !== 429 && response.status < 500)
        stopRecovery();
    } catch {
      // Network errors and request timeouts are retryable, not proof that a
      // session expired. Explicit auth/revocation responses above fail closed.
    } finally {
      window.clearTimeout(timeout);
      if (isCurrent()) {
        this.handoffController = null;
        if (retry) this.scheduleReconnect();
      }
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

function isAuthenticationFailure(response: Response) {
  return (
    response.type === "opaqueredirect" ||
    response.status === 401 ||
    response.status === 403 ||
    (response.status >= 300 && response.status < 400)
  );
}
