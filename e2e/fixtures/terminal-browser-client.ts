import { TerminalScreenView } from "./terminal-screen-view.ts";

/**
 * Synthetic browser client for the isolated terminal fixture only.
 *
 * Safety invariants (all enforced locally, not by the server):
 * - Nothing is stored: no cookie access, no storage, no URL/query credentials, no logging of codes.
 * - Input exists only for write scope AND after an explicit "取得控制权" click whose ACK arrived.
 * - Exactly one action in flight; key presses are never queued and never replayed.
 * - A 3 s action timeout or an unexpected close with pending input latches "unknown" for this page.
 * - No automatic reconnect, retry, lease renewal or lease acquisition.
 * - Screen updates are full framebuffer snapshots restored serially; raw deltas are never mixed in.
 * - Only textContent is written, never innerHTML from server-provided content.
 */

const UNKNOWN_NOTICE = "输入交付未知，请检查终端；不要自动重试";
const INPUT_BYTE_LIMIT = 8192;
const ACTION_TIMEOUT_MS = 3000;
const LEASE_EARLY_STOP_MS = 2000;
const FRAME_BYTE_LIMIT = 1_048_576;
const SOCKET_OPEN = 1;
const KEY_SEQUENCES = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  esc: "\x1b",
  ctrlC: "\x03",
  backspace: "\x7f",
} as const;

type Access = "read" | "write";
type ActionType = "control" | "input" | "resize";
type PendingAction = { type: ActionType; sequence?: number; columns?: number; rows?: number };
type ScreenFrame = { sequence: number; columns: number; rows: number; data: string };
type FixtureStatus = {
  authorized: boolean;
  csrf: string;
  expiresAt: number | null;
  access: Access | null;
  label: string;
  available: boolean;
};
// Structural type so the fixture never depends on Node's or the DOM's WebSocket global identity.
type FixtureSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

const encoder = new TextEncoder();

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing fixture element: ${id}`);
  return node as T;
}

function setText(target: HTMLElement, value: string) {
  if (target.textContent !== value) target.textContent = value;
}

function setDisabled(target: HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement, value: boolean) {
  if (target.disabled !== value) target.disabled = value;
}

function fixtureText(value: unknown, limit = 200): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) return null;
  if (/[\p{Cc}\p{Cs}]/u.test(value)) return null;
  return value;
}

function parseStatus(value: unknown): FixtureStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.authorized !== "boolean" || typeof raw.available !== "boolean") return null;
  if (typeof raw.csrf !== "string" || !/^[a-f0-9]{64}$/.test(raw.csrf)) return null;
  let access: Access | null = null;
  let expiresAt: number | null = null;
  if (raw.authorized) {
    const scope = raw.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
    const candidate = (scope as Record<string, unknown>).access;
    if (candidate !== "read" && candidate !== "write") return null;
    access = candidate;
    if (!Number.isSafeInteger(raw.expiresAt) || Number(raw.expiresAt) <= 0) return null;
    expiresAt = Number(raw.expiresAt);
    const target = raw.target;
    if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  }
  return {
    authorized: raw.authorized,
    csrf: raw.csrf,
    expiresAt,
    access,
    label: fixtureText(raw.label, 120) ?? "",
    available: raw.available,
  };
}

function validInputText(value: string): boolean {
  // Reject lone surrogates and oversized payloads; the server enforces the same limits.
  if (value.length === 0 || /\p{Cs}/u.test(value)) return false;
  return encoder.encode(value).length <= INPUT_BYTE_LIMIT;
}

function clock(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function start() {
  const pairingCode = element<HTMLInputElement>("pairing-code");
  const unlockButton = element<HTMLButtonElement>("unlock-button");
  const logoutButton = element<HTMLButtonElement>("logout-button");
  const connectButton = element<HTMLButtonElement>("connect-button");
  const controlButton = element<HTMLButtonElement>("control-button");
  const releaseButton = element<HTMLButtonElement>("release-button");
  const disconnectButton = element<HTMLButtonElement>("disconnect-button");
  const pairingStatus = element<HTMLElement>("pairing-status");
  const connectionStatus = element<HTMLElement>("connection-status");
  const leaseCountdown = element<HTMLElement>("lease-countdown");
  const noticeStatus = element<HTMLElement>("terminal-notice");
  const ioStatus = element<HTMLElement>("io-status");
  const terminalState = element<HTMLElement>("terminal-state");
  const screenContainer = element<HTMLElement>("terminal-screen");
  const draft = element<HTMLTextAreaElement>("terminal-text");
  const sendButton = element<HTMLButtonElement>("send-text-button");
  const inputSurface = element<HTMLFieldSetElement>("input-surface");
  const resizeColumns = element<HTMLInputElement>("resize-columns");
  const resizeRows = element<HTMLInputElement>("resize-rows");
  const resizeButton = element<HTMLButtonElement>("resize-button");
  const keyButtons: Array<[HTMLButtonElement, string]> = [
    [element<HTMLButtonElement>("key-up"), KEY_SEQUENCES.up],
    [element<HTMLButtonElement>("key-down"), KEY_SEQUENCES.down],
    [element<HTMLButtonElement>("key-left"), KEY_SEQUENCES.left],
    [element<HTMLButtonElement>("key-right"), KEY_SEQUENCES.right],
    [element<HTMLButtonElement>("key-enter"), KEY_SEQUENCES.enter],
    [element<HTMLButtonElement>("key-esc"), KEY_SEQUENCES.esc],
    [element<HTMLButtonElement>("key-ctrl-c"), KEY_SEQUENCES.ctrlC],
    [element<HTMLButtonElement>("key-backspace"), KEY_SEQUENCES.backspace],
  ];

  // Font metrics must be stable before the first terminal restore; failures are non-fatal.
  const fontsReady: Promise<void> = (async () => {
    try {
      await document.fonts.load("16px FixtureMono");
      await document.fonts.ready;
    } catch {}
  })();

  let status: FixtureStatus | null = null;
  let statusError = "";
  let statusRequest = 0;
  let pairingBusy = false;

  let socket: FixtureSocket | null = null;
  let generation = 0;
  let connecting = false;
  let attached = false;
  let screenAvailable = false;
  let terminalEpoch = "";
  let writeScope = false;

  let controlHeld = false;
  let controlExpiring = false;
  let leaseExpiresAt = 0;
  let nextSequence = 0;

  let pending: PendingAction | null = null;
  let pendingTimer = 0;
  let connectTimer = 0;
  let expiryTimer = 0;
  let leaseCloseTimer = 0;
  let countdownTimer = 0;

  let unknown = false;
  let composing = false;
  let disconnectReason = "";

  let view: TerminalScreenView | null = null;
  let restoring = false;
  let queuedFrame: ScreenFrame | null = null;
  let renderedSequence = -1;
  let lastFrame: { sequence: number; columns: number; rows: number } | null = null;

  function setNotice(value: string) {
    // The unknown latch is one-way for this page: no later notice may replace it.
    if (unknown && value !== UNKNOWN_NOTICE) return;
    setText(noticeStatus, value);
  }

  function setIo(value: string) {
    setText(ioStatus, value);
  }

  function remainingSeconds(): number {
    return Math.max(0, Math.ceil((leaseExpiresAt - performance.now()) / 1000));
  }

  function inputAllowed(): boolean {
    return attached && socket !== null && controlHeld && writeScope && !controlExpiring && !unknown && pending === null;
  }

  function clearPending() {
    pending = null;
    if (pendingTimer) {
      window.clearTimeout(pendingTimer);
      pendingTimer = 0;
    }
  }

  function clearLease() {
    controlHeld = false;
    controlExpiring = false;
    leaseExpiresAt = 0;
    nextSequence = 0;
    if (expiryTimer) {
      window.clearTimeout(expiryTimer);
      expiryTimer = 0;
    }
    if (leaseCloseTimer) {
      window.clearTimeout(leaseCloseTimer);
      leaseCloseTimer = 0;
    }
    if (countdownTimer) {
      window.clearInterval(countdownTimer);
      countdownTimer = 0;
    }
  }

  function teardown(reason: string, _deliberate: boolean) {
    // A deliberate close, release or page hide cannot undo an already sent input.
    const uncertainInput = pending !== null && pending.type === "input";
    generation += 1;
    window.clearTimeout(connectTimer);
    connectTimer = 0;
    composing = false;
    clearPending();
    clearLease();
    const active = socket;
    socket = null;
    if (active) {
      active.onopen = null;
      active.onmessage = null;
      active.onerror = null;
      active.onclose = null;
      try {
        active.close();
      } catch {}
    }
    attached = false;
    connecting = false;
    screenAvailable = false;
    terminalEpoch = "";
    writeScope = false;
    renderedSequence = -1;
    queuedFrame = null;
    lastFrame = null;
    const staleView = view;
    view = null;
    staleView?.dispose();
    screenContainer.textContent = "";
    draft.value = "";
    disconnectReason = reason;
    if (uncertainInput) {
      unknown = true;
      setNotice(UNKNOWN_NOTICE);
    }
    render();
  }

  function failConnection(reason: string) {
    teardown(reason, false);
    setNotice(`连接已中断：${reason}`);
  }

  function pairingText(): string {
    if (statusError) return statusError;
    if (!status) return "正在读取授权状态…";
    if (!status.authorized) return "未配对：当前没有终端授权（配对码只提交给同源服务端，凭据保存在 HttpOnly Cookie）";
    const access = status.access === "write" ? "写权限" : "只读权限";
    const label = status.label ? ` · ${status.label}` : "";
    const expiry = status.expiresAt ? ` · 授权到期 ${clock(status.expiresAt)}` : "";
    return `已配对 · ${access}${label}${expiry}`;
  }

  function connectionText(): string {
    if (unknown) return "输入交付未知：连接已关闭，需要人工核对终端后重新加载页面";
    if (connecting) return "正在连接终端…";
    if (!socket) return disconnectReason ? `已断开：${disconnectReason}` : "未连接";
    if (!attached) return "已连接，等待握手…";
    if (controlHeld) return "已连接 · 已取得控制权";
    return writeScope ? "已连接 · 等待取得控制权" : "已连接 · 只读画面";
  }

  function terminalText(): string {
    if (unknown) return "输入交付未知：连接已关闭，画面已清除，不得当作当前终端";
    if (!attached)
      return disconnectReason ? `已断开：${disconnectReason}；画面不可视为当前终端` : "未连接终端；画面区域为空";
    if (!screenAvailable) return "终端画面不可用";
    if (lastFrame)
      return `画面快照：第 ${lastFrame.sequence} 帧 · ${lastFrame.columns}×${lastFrame.rows}（完整快照，非增量）`;
    return "已连接，等待终端画面快照…";
  }

  function render() {
    const authorized = status?.authorized === true;
    const available = status?.available === true;
    const connected = attached && socket !== null;
    const canAct = inputAllowed();
    // Pairing is the only flow available while unauthorized; everything else needs a session.
    const canPair = !authorized && status !== null && status.csrf.length > 0 && !pairingBusy;
    setDisabled(pairingCode, !canPair);
    setDisabled(unlockButton, !canPair);
    setDisabled(logoutButton, !authorized || pairingBusy);
    setDisabled(connectButton, !authorized || !available || socket !== null || connecting || unknown);
    setDisabled(disconnectButton, socket === null && !connecting);
    setDisabled(
      controlButton,
      !connected || !screenAvailable || lastFrame === null || !writeScope || controlHeld || pending !== null || unknown,
    );
    setDisabled(releaseButton, !connected || !controlHeld);
    inputSurface.disabled = !canAct;
    // While an IME composition is active nothing may be submitted, including fixed keys.
    setDisabled(sendButton, composing);
    setDisabled(resizeButton, composing);
    for (const [button] of keyButtons) setDisabled(button, composing);
    setText(pairingStatus, pairingText());
    setText(connectionStatus, connectionText());
    setText(leaseCountdown, controlHeld ? `控制权剩余约 ${remainingSeconds()} 秒（到期本地断开，不会续租）` : "");
    setText(terminalState, terminalText());
  }

  async function refreshStatus(): Promise<FixtureStatus | null> {
    const request = ++statusRequest;
    let next: FixtureStatus | null = null;
    try {
      const response = await fetch("/api/status", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("status");
      next = parseStatus(await response.json());
      if (!next) throw new Error("status");
    } catch {
      next = null;
    }
    // A newer status request (or a newer page state) always wins over this one.
    if (request !== statusRequest) return status;
    status = next;
    statusError = next ? "" : "授权状态不可用：无法读取 /api/status";
    render();
    return status;
  }

  function closeForPageLifecycle() {
    if (socket === null && !connecting) return;
    teardown("页面已隐藏或离开", true);
    setIo("");
    setNotice("");
  }

  function connect() {
    if (!status?.authorized || !status.available || socket !== null || connecting || unknown) return;
    const csrf = status.csrf;
    const myGeneration = ++generation;
    connecting = true;
    disconnectReason = "";
    setNotice("");
    setIo("");
    render();
    let ws: FixtureSocket;
    try {
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new window.WebSocket(`${scheme}//${location.host}/ws`);
    } catch {
      connecting = false;
      setNotice("无法建立终端连接");
      render();
      return;
    }
    socket = ws;
    connectTimer = window.setTimeout(() => {
      if (myGeneration === generation && socket === ws) failConnection("连接握手超时");
    }, ACTION_TIMEOUT_MS);
    ws.onopen = () => {
      if (myGeneration !== generation || socket !== ws) return;
      try {
        // Attach carries the CSRF token from the latest status response only.
        ws.send(JSON.stringify({ type: "attach", csrf }));
      } catch {
        failConnection("握手发送失败");
      }
    };
    ws.onmessage = (event: MessageEvent) => {
      if (myGeneration !== generation || socket !== ws) return;
      const data: unknown = event.data;
      if (typeof data !== "string") {
        failConnection("收到非文本消息");
        return;
      }
      handleMessage(data);
    };
    ws.onerror = () => {
      if (myGeneration !== generation || socket !== ws) return;
      failConnection(connecting ? "连接失败" : "连接错误");
    };
    ws.onclose = () => {
      if (myGeneration !== generation || socket !== ws) return;
      failConnection(connecting ? "连接被拒绝" : "连接已关闭");
    };
  }

  function send(value: Record<string, unknown>) {
    const active = socket;
    if (!active || active.readyState !== SOCKET_OPEN) throw new Error("socket");
    active.send(JSON.stringify(value));
  }

  function startAction(action: PendingAction) {
    pending = action;
    pendingTimer = window.setTimeout(() => {
      if (!pending) return;
      if (pending.type === "input") {
        // Delivery uncertainty is page-latched; never retried from a button.
        teardown("输入交付未知", false);
      } else {
        teardown("操作超时，连接已关闭", true);
        setNotice("操作超时，连接已关闭；结果未知，本页不会自动重试");
      }
      render();
    }, ACTION_TIMEOUT_MS);
  }

  function requestControl() {
    if (
      !attached ||
      !screenAvailable ||
      lastFrame === null ||
      !writeScope ||
      controlHeld ||
      pending !== null ||
      unknown ||
      socket === null
    )
      return;
    try {
      send({ type: "control" });
    } catch {
      failConnection("控制权请求发送失败");
      return;
    }
    startAction({ type: "control" });
    setNotice("");
    setIo("正在请求控制权…");
    render();
  }

  function requestInput(data: string): boolean {
    if (composing || !inputAllowed()) return false;
    if (!validInputText(data)) {
      setNotice("未发送：文本为空、超过 8192 字节或包含孤立代理字符");
      return false;
    }
    if (nextSequence < 1) {
      failConnection("输入序号状态异常");
      return false;
    }
    const sequence = nextSequence;
    // Latch before send: a thrown send does not prove that no bytes escaped.
    startAction({ type: "input", sequence });
    try {
      send({ type: "input", sequence, data });
    } catch {
      failConnection("输入发送失败");
      return false;
    }
    nextSequence = sequence + 1;
    setNotice("");
    setIo("");
    render();
    return true;
  }

  function sendDraft() {
    if (composing || !inputAllowed()) return;
    const data = draft.value;
    if (data.length === 0) {
      setNotice("请先输入要发送的文本");
      return;
    }
    if (requestInput(data)) {
      draft.value = "";
      render();
    }
  }

  function requestResize() {
    if (!inputAllowed()) {
      setNotice("取得控制权后才能调整尺寸");
      return;
    }
    const columns = Number(resizeColumns.value);
    const rows = Number(resizeRows.value);
    if (
      !Number.isInteger(columns) ||
      columns < 20 ||
      columns > 240 ||
      !Number.isInteger(rows) ||
      rows < 5 ||
      rows > 120
    ) {
      setNotice("尺寸无效：列数需 20–240，行数需 5–120");
      return;
    }
    try {
      send({ type: "resize", columns, rows });
    } catch {
      failConnection("尺寸调整发送失败");
      return;
    }
    startAction({ type: "resize", columns, rows });
    setNotice("");
    setIo(`正在请求调整尺寸：${columns}×${rows}`);
    render();
  }

  function parseFrame(message: Record<string, unknown>): ScreenFrame | null {
    const { sequence, columns, rows, data } = message;
    if (!Number.isSafeInteger(sequence) || Number(sequence) < 0) return null;
    if (!Number.isInteger(columns) || Number(columns) < 20 || Number(columns) > 240) return null;
    if (!Number.isInteger(rows) || Number(rows) < 5 || Number(rows) > 120) return null;
    if (typeof data !== "string" || encoder.encode(data).length > FRAME_BYTE_LIMIT) return null;
    return { sequence: Number(sequence), columns: Number(columns), rows: Number(rows), data };
  }

  function onScreenFrame(message: Record<string, unknown>) {
    if (message.terminalEpoch !== terminalEpoch) {
      failConnection("终端代次已变化，画面作废");
      return;
    }
    const frame = parseFrame(message);
    if (!frame) {
      failConnection("终端画面帧无效");
      return;
    }
    // A stale or duplicated frame is dropped, never merged into a newer screen.
    if (frame.sequence <= (queuedFrame ? queuedFrame.sequence : renderedSequence)) return;
    queuedFrame = frame; // coalesce: only the newest pending snapshot is kept
    void pumpFrames();
  }

  async function pumpFrames() {
    if (restoring) return;
    const myGeneration = generation;
    restoring = true;
    try {
      // Full snapshots only: each frame restores into a fresh terminal, then the next one follows.
      await fontsReady;
      while (myGeneration === generation && queuedFrame) {
        const frame = queuedFrame;
        queuedFrame = null;
        if (frame.sequence <= renderedSequence) continue;
        if (!view) view = new TerminalScreenView(screenContainer);
        const activeView = view;
        try {
          await activeView.restore(frame);
        } catch {
          if (myGeneration !== generation) return;
          activeView.dispose();
          if (view === activeView) view = null;
          screenContainer.textContent = "";
          failConnection("终端画面恢复失败");
          return;
        }
        if (myGeneration !== generation) return;
        renderedSequence = frame.sequence;
        lastFrame = { sequence: frame.sequence, columns: frame.columns, rows: frame.rows };
        render();
      }
    } finally {
      restoring = false;
      // A new connection can enqueue while a stale generation is still unwinding.
      // Only its new frame/view will be restored; the old callback cannot own it.
      if (queuedFrame && attached) void pumpFrames();
    }
  }

  function onAttached(message: Record<string, unknown>) {
    const target = message.target;
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      failConnection("终端目标无效");
      return;
    }
    const epoch = (target as Record<string, unknown>).terminalEpoch;
    if (typeof epoch !== "string" || !/^[a-f0-9]{32}$/.test(epoch)) {
      failConnection("终端目标无效");
      return;
    }
    if (typeof message.write !== "boolean" || typeof message.screenAvailable !== "boolean") {
      failConnection("连接握手无效");
      return;
    }
    window.clearTimeout(connectTimer);
    connectTimer = 0;
    attached = true;
    connecting = false;
    terminalEpoch = epoch;
    writeScope = message.write;
    screenAvailable = message.screenAvailable;
    controlHeld = false;
    nextSequence = 0;
    renderedSequence = -1;
    lastFrame = null;
    setNotice("");
    setIo(message.screenAvailable ? "" : "终端画面不可用：服务端未开启只读画面");
    render();
  }

  function resolveControl(message: Record<string, unknown>) {
    if (pending?.type !== "control") {
      failConnection("控制权响应与请求不匹配");
      return;
    }
    const expiresInMs = message.expiresInMs;
    if (expiresInMs !== 30_000) {
      failConnection("控制权有效期无效");
      return;
    }
    clearPending();
    controlHeld = true;
    controlExpiring = false;
    nextSequence = 1;
    leaseExpiresAt = performance.now() + Number(expiresInMs);
    // Close input early, then close the connection at the fixed expiry. Never renew.
    expiryTimer = window.setTimeout(onLeaseWarning, Math.max(0, Number(expiresInMs) - LEASE_EARLY_STOP_MS));
    leaseCloseTimer = window.setTimeout(onLeaseExpired, Number(expiresInMs));
    countdownTimer = window.setInterval(render, 500);
    setIo("已取得控制权：发送按键或文本，同一时刻只允许一条在途操作");
    render();
  }

  function onLeaseWarning() {
    if (!controlHeld) return;
    controlExpiring = true;
    setIo("控制权即将到期：已提前关闭输入，本页不会续租");
    render();
  }

  function onLeaseExpired() {
    if (!controlHeld) return;
    teardown("控制权已到期，连接已关闭", true);
    setNotice("控制权已到期，已断开连接；本页不会自动续租或重连");
  }

  function resolveWritten(message: Record<string, unknown>) {
    if (pending?.type !== "input") {
      failConnection("交付确认与请求不匹配");
      return;
    }
    if (message.sequence !== pending.sequence) {
      failConnection("交付确认序号不匹配");
      return;
    }
    const bytes = message.bytesWritten;
    if (!Number.isSafeInteger(bytes) || Number(bytes) < 0) {
      failConnection("交付确认无效");
      return;
    }
    clearPending();
    setIo(`已交付 PTY（${Number(bytes)} 字节）；交付不等于命令执行完成`);
    render();
  }

  function resolveResized(message: Record<string, unknown>) {
    if (pending?.type !== "resize") {
      failConnection("尺寸确认与请求不匹配");
      return;
    }
    // The isolated transport ACKs with `{type:"resized"}` only; optional echo is validated when present.
    const columns = message.columns ?? pending.columns;
    const rows = message.rows ?? pending.rows;
    if (!Number.isInteger(columns) || !Number.isInteger(rows)) {
      failConnection("尺寸确认无效");
      return;
    }
    clearPending();
    setIo(`尺寸已通知 PTY：${Number(columns)}×${Number(rows)}；画面随后刷新`);
    render();
  }

  function resolveDenied() {
    if (pending?.type !== "control") {
      failConnection("拒绝响应与请求不匹配");
      return;
    }
    clearPending();
    setNotice("控制权请求被拒绝：终端可能正被本机或其他连接占用");
    setIo("");
    render();
  }

  function onControlReleased() {
    if (pending !== null) {
      // The lease disappeared while an action was in flight: its outcome is unknown.
      failConnection("控制权已释放，操作结果未知");
      return;
    }
    clearLease();
    setIo("");
    setNotice("控制权已由终端侧释放；如需继续输入请重新取得控制权");
    render();
  }

  function handleMessage(raw: string) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      failConnection("收到无法解析的消息");
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      failConnection("收到无法识别的消息");
      return;
    }
    const message = value as Record<string, unknown>;
    const type = message.type;
    if (!attached) {
      if (type !== "attached") {
        failConnection("连接未完成握手");
        return;
      }
      onAttached(message);
      return;
    }
    if (type === "screen") {
      onScreenFrame(message);
    } else if (type === "control") {
      resolveControl(message);
    } else if (type === "written") {
      resolveWritten(message);
    } else if (type === "resized") {
      resolveResized(message);
    } else if (type === "denied") {
      resolveDenied();
    } else if (type === "control-released") {
      onControlReleased();
    } else {
      failConnection("收到未知或未预期的消息类型");
    }
  }

  async function postJson(path: string, body: string) {
    const csrf = status?.csrf;
    if (!csrf) throw new Error("csrf");
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json", "x-pi-hub-terminal-csrf": csrf },
      body,
    });
  }

  async function unlock() {
    if (pairingBusy || !status || status.authorized) return;
    const code = pairingCode.value.trim();
    if (!/^[a-f0-9]{32}$/.test(code)) {
      setNotice("配对码需为 32 位十六进制字符");
      return;
    }
    pairingBusy = true;
    render();
    let paired = false;
    try {
      const response = await postJson("/api/unlock", JSON.stringify({ code }));
      paired = response.ok;
      if (!paired) setNotice("配对失败：配对码无效、已过期或已被使用");
    } catch {
      setNotice("配对请求失败：请检查连接后重试");
    } finally {
      // The code is never retained, stored or re-sent after this point.
      pairingCode.value = "";
      pairingBusy = false;
      render();
    }
    if (!paired) return;
    setNotice("");
    setIo("配对成功：正在刷新授权状态与 CSRF");
    const refreshed = await refreshStatus();
    if (refreshed?.authorized === true && socket === null) setIo("配对成功：可以连接终端");
  }

  async function logout() {
    if (pairingBusy || status?.authorized !== true) return;
    // Close the socket first so releasing control is deliberate, not an uncertain close.
    teardown("已退出授权", true);
    pairingBusy = true;
    render();
    let ok = false;
    try {
      const response = await postJson("/api/logout", "{}");
      ok = response.ok;
      if (!ok) setNotice("退出授权失败");
    } catch {
      setNotice("退出授权请求失败");
    } finally {
      pairingBusy = false;
      render();
    }
    setIo("");
    await refreshStatus();
    if (ok) setNotice("");
  }

  unlockButton.addEventListener("click", () => {
    void unlock();
  });
  logoutButton.addEventListener("click", () => {
    void logout();
  });
  connectButton.addEventListener("click", connect);
  disconnectButton.addEventListener("click", () => {
    teardown("用户断开连接", true);
    setNotice("");
    setIo("已断开连接；本页不会自动重连");
  });
  releaseButton.addEventListener("click", () => {
    // The only release gesture this fixture has: close the socket, which fences input immediately.
    teardown("已释放控制权并断开连接", true);
    setNotice("");
    setIo("已关闭连接以立即释放控制权；本页不会自动重连");
  });
  controlButton.addEventListener("click", requestControl);
  sendButton.addEventListener("click", sendDraft);
  resizeButton.addEventListener("click", requestResize);
  draft.addEventListener("compositionstart", () => {
    composing = true;
    render();
  });
  draft.addEventListener("compositionend", () => {
    composing = false;
    render();
  });
  // Deliberately no keydown/onData forwarding: every keystroke reaches the PTY only through a button.
  for (const [button, data] of keyButtons) {
    button.addEventListener("click", () => {
      requestInput(data);
    });
  }
  window.addEventListener("pagehide", closeForPageLifecycle);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") closeForPageLifecycle();
  });

  render();
  void refreshStatus();
}

start();
