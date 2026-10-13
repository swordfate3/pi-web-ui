import type { WsError, WsEvent, WsRequest, WsResponse } from "./types";
import { UiError, type UiText, uiText } from "./ui-text";
import { wsUrl } from "./ws";

type PiClientOptions = {
  onConnectionChange: (state: "connecting" | "connected" | "disconnected") => void;
  onError: (message: UiText) => void;
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
          this.options.onEvent(data);
        } else if (data.type === "error") {
          this.options.onError(data.message || uiText("Server error"));
        }
      } catch (error) {
        console.error("[pi-web-ui] Failed to parse WebSocket message", error);
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.options.onError(uiText("WebSocket error"));
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
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
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, 1200);
      }
    };
  }

  send(method: string, params?: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => {
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
    if (this.ws?.readyState === WebSocket.OPEN || this.reconnectTimer) return;
    if (this.ws) {
      this.ws.close();
      return;
    }
    this.connect();
  }

  disconnect() {
    this.intentionallyClosed = true;
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

  private flushQueuedRequests() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const queued = this.queuedRequests.splice(0);
    for (const request of queued) {
      this.sentRequestIds.add(request.id);
      this.ws.send(JSON.stringify(request));
    }
  }
}
