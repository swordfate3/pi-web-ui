import { Terminal } from "@xterm/xterm";
import { parseTerminalTarget, sameTerminal, type TerminalTarget } from "../../../hub/terminal-contract";
import {
  exact,
  parseTerminalJson,
  parseTerminalResult,
  record,
  TERMINAL_FRAME_BYTES,
  TERMINAL_QUEUE_BYTES,
  type TerminalSnapshot,
  TerminalSnapshotAssembly,
  textBytes,
} from "../../../hub/terminal-wire";
import "./style.css";

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const draft = element<HTMLTextAreaElement>("draft");
const keys: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
  Up: "\x1b[A",
  Down: "\x1b[B",
  CtrlC: "\x03",
  CtrlD: "\x04",
};
let csrf = "",
  authorized = false,
  available = false,
  access: "read" | "write" = "read";
let target: TerminalTarget | undefined,
  socket: WebSocket | undefined,
  connected = false,
  screenReady = false,
  composing = false,
  transition = false;
let lease: string | undefined,
  sequence = 0,
  id = 0,
  generation = 0,
  leaseDeadline = 0;
let assembly: TerminalSnapshotAssembly | undefined,
  terminal: Terminal | undefined,
  rendering = false,
  drainingScreens = false,
  queuedScreenBytes = 0,
  draftRevision = 0;
const screenQueue: string[] = [];
let leaseTimer: ReturnType<typeof setTimeout> | undefined, connectTimer: ReturnType<typeof setTimeout> | undefined;
let screenTimer: ReturnType<typeof setTimeout> | undefined;
let cancelRender: (() => void) | undefined, operation: AbortController | undefined;
const pending = new Map<
  number,
  { type: string; timer: ReturnType<typeof setTimeout>; startedAt: number; draftRevision?: number }
>();
const notice = (text: string) => {
  element("delivery-state").textContent = text;
};
const controls = () => {
  if (connected)
    element("connection-state").textContent = !screenReady
      ? "传输已连接 · 等待完整画面，输入已锁定"
      : lease
        ? "已连接 · 控制申请已确认（非实时）"
        : access === "read"
          ? "已连接 · 只读查看"
          : "已连接 · 输入仍需取得控制权";
  const granted = !!lease && performance.now() < leaseDeadline;
  if (lease)
    element("lease-state").textContent =
      `申请已确认（非实时归属） · 保守剩余 ${Math.max(0, Math.floor((leaseDeadline - performance.now()) / 1000))} 秒 · 不自动续租`;
  const writable = connected && screenReady && granted && !composing && pending.size === 0;
  button("unlock").disabled = transition || connected;
  button("logout").disabled = !authorized || transition;
  button("connect").disabled = !authorized || !available || !!socket || transition;
  button("disconnect").disabled = !socket && !transition;
  button("acquire").disabled = !connected || !screenReady || access !== "write" || !!lease || pending.size !== 0;
  button("send").disabled = !writable;
  button("resize").disabled = !writable;
  draft.disabled = !connected || !screenReady || !granted;
  element<HTMLSelectElement>("access").disabled = !!socket || transition;
  for (const key of document.querySelectorAll<HTMLButtonElement>("[data-key]")) key.disabled = !writable;
};
function disconnect(message = "连接已关闭；未收到确认的输入结果未知，不会自动重连或重发。") {
  // Fence local input before close/abort/cleanup or any promise continuation.
  generation++;
  connected = false;
  screenReady = false;
  lease = undefined;
  leaseDeadline = 0;
  sequence = 0;
  transition = false;
  for (const call of pending.values()) clearTimeout(call.timer);
  pending.clear();
  clearTimeout(leaseTimer);
  clearTimeout(connectTimer);
  clearTimeout(screenTimer);
  screenTimer = undefined;
  const old = socket;
  socket = undefined;
  operation?.abort();
  operation = undefined;
  assembly?.clear();
  assembly = undefined;
  screenQueue.length = 0;
  queuedScreenBytes = 0;
  drainingScreens = false;
  cancelRender?.();
  cancelRender = undefined;
  rendering = false;
  terminal?.dispose();
  terminal = undefined;
  element("terminal-screen").replaceChildren();
  element("lease-state").textContent = "未取得控制权";
  element("connection-state").textContent = "已断开 · 需显式连接";
  element("screen-state").textContent = "画面已清除";
  controls();
  old?.close();
  notice(message);
}
function fenceScreen() {
  screenReady = false;
  if (screenTimer === undefined) {
    const own = generation;
    screenTimer = setTimeout(() => {
      if (own === generation) disconnect("完整画面未在期限内就绪；已断开，不会自动恢复。");
    }, 2000);
  }
  controls();
}
function tickLease(own: number) {
  if (own !== generation || !lease) return;
  const remaining = leaseDeadline - performance.now();
  if (remaining <= 0) {
    disconnect("本地保守控制租期已结束；请核对画面后显式重新连接。");
    return;
  }
  controls();
  leaseTimer = setTimeout(() => tickLease(own), Math.min(1000, remaining));
}
async function api(route: string, value?: object, signal?: AbortSignal) {
  const response = await fetch(`/api/terminal/${route}`, {
    method: value === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-Pi-Hub-Terminal-Csrf": csrf } : {}) },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  if (!response.ok) throw new Error("terminal_unavailable");
  const text = await response.text();
  return parseTerminalJson(text);
}
function identity() {
  const container = element("identity");
  container.replaceChildren();
  const inputStates = { local: "本地", none: "无人", remote: "远程", fenced: "已锁定" };
  element("ownership-state").textContent = target
    ? `上次核对输入归属：${inputStates[target.inputState]}（非实时，可能已改变；本地收回不会主动通知本页）。`
    : "输入归属尚未核对；本页不提供实时归属通知。";
  if (!target) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = "目标";
    dd.textContent = "尚未配对或目标不可用";
    container.append(dt, dd);
    return;
  }
  for (const [label, value] of [
    ["运行", target.runId],
    ["进程", target.runtimeId],
    ["会话", target.sessionId],
    ["终端世代", target.terminalEpoch],
  ]) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    container.append(dt, dd);
  }
}
async function refresh() {
  if (socket || transition) return;
  const own = generation;
  try {
    const status = await api("status");
    if (own !== generation) return;
    if (status.authorized !== true) {
      authorized = false;
      csrf = "";
      available = false;
      target = undefined;
      element("connection-state").textContent = "未配对 · 不会自动连接";
    } else {
      if (typeof status.csrf !== "string" || !/^[a-f0-9]{64}$/.test(status.csrf) || !record(status.scope))
        throw new Error();
      authorized = true;
      csrf = status.csrf;
      const writeOption = element("access").querySelector<HTMLOptionElement>('option[value="write"]');
      if (!writeOption) throw new Error();
      writeOption.disabled = status.scope.access !== "write";
      available = status.available === true;
      if (available) {
        const found = parseTerminalTarget(status.target);
        if (target && !sameTerminal(target, found)) throw new Error();
        target = found;
      }
      element("connection-state").textContent = available ? "目标已核对 · 尚未连接" : "终端不可用 · 不会重试";
    }
  } catch {
    available = false;
    element("connection-state").textContent = "终端不可用 · 请稍后手动检查";
  }
  identity();
  controls();
}
async function restore(snapshot: TerminalSnapshot) {
  if (rendering || !connected) throw new Error();
  const own = generation;
  rendering = true;
  fenceScreen();
  terminal?.dispose();
  element("terminal-screen").replaceChildren();
  const view = new Terminal({
    cols: snapshot.columns,
    rows: snapshot.rows,
    scrollback: 1000,
    disableStdin: true,
    allowProposedApi: true,
    cursorBlink: false,
    logLevel: "off",
    fontSize: 15,
    windowOptions: {},
    linkHandler: { activate() {}, hover() {}, leave() {} },
    theme: { background: "#101713", foreground: "#dfebe1" },
  });
  for (const osc of [0, 1, 2, 4, 8, 9, 10, 11, 12, 22, 46, 50, 51, 52, 104, 110, 111, 112, 133, 777, 1337])
    view.parser.registerOscHandler(osc, () => true);
  terminal = view;
  let renderDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    view.open(element("terminal-screen"));
    await new Promise<void>((resolve, reject) => {
      renderDeadline = setTimeout(() => reject(new Error("terminal_render_timeout")), 2000);
      cancelRender = () => {
        reject(new Error());
      };
      view.write(snapshot.data, () => {
        resolve();
      });
    });
    if (own !== generation || !connected) return;
    element("screen-state").textContent = `完整画面快照 #${snapshot.sequence} · ${snapshot.columns} × ${snapshot.rows}`;
    if (screenQueue.length === 0) {
      screenReady = true;
      clearTimeout(screenTimer);
      screenTimer = undefined;
      controls();
    }
  } finally {
    clearTimeout(renderDeadline);
    if (own === generation) {
      rendering = false;
      cancelRender = undefined;
    }
  }
}
async function drainScreens() {
  if (drainingScreens) return;
  drainingScreens = true;
  const own = generation;
  try {
    while (own === generation && connected && screenQueue.length) {
      const text = screenQueue.shift();
      if (text === undefined || !assembly) throw new Error();
      queuedScreenBytes -= textBytes(text);
      const snapshot = assembly.accept(parseTerminalJson(text));
      // Do not begin another assembly/parser until xterm completes this one.
      if (snapshot) await restore(snapshot);
    }
  } catch {
    if (own === generation) disconnect("画面不可用；已断开，不使用旧 ANSI 尾部恢复。");
  } finally {
    if (own === generation) drainingScreens = false;
  }
}
function send(type: string, extra: Record<string, unknown> = {}, submittedRevision?: number) {
  if (lease && performance.now() >= leaseDeadline) {
    disconnect("本地保守控制租期已结束；请核对画面后显式重新连接。");
    return;
  }
  if (
    !socket ||
    !connected ||
    !screenReady ||
    !target ||
    composing ||
    pending.size ||
    (type === "acquire" && access !== "write") ||
    (type !== "acquire" && !lease) ||
    document.hidden
  )
    return;
  const requestId = ++id;
  const text = JSON.stringify({ id: requestId, type, ...extra, csrf, target });
  if (textBytes(text) > TERMINAL_FRAME_BYTES || socket.bufferedAmount + textBytes(text) > TERMINAL_QUEUE_BYTES) {
    disconnect();
    return;
  }
  pending.set(requestId, {
    type,
    startedAt: performance.now(),
    draftRevision: submittedRevision,
    timer: setTimeout(() => disconnect("未收到确认：输入结果未知，已断开，不会重发。"), 2000),
  });
  if (type === "input") sequence++;
  socket.send(text);
  controls();
}
function sendInput(data: string, submittedRevision?: number) {
  if (!data || /\p{Cs}/u.test(data) || textBytes(data) > 8192 || !lease || !target) {
    notice("文本必须是有效 UTF-8，且每次最多 8 KiB；未发送。 ");
    return;
  }
  if (/[\r\n]/.test(data) && data !== "\r" && !window.confirm("这段文本包含多行，可能立即执行多个命令。确认逐字发送？"))
    return;
  send(
    "input",
    { v: 1, terminalEpoch: target.terminalEpoch, leaseId: lease, sequence: sequence + 1, data },
    submittedRevision,
  );
}
element("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (transition || socket) return;
  transition = true;
  const own = generation;
  controls();
  const code = element<HTMLInputElement>("pair-code").value;
  element<HTMLInputElement>("pair-code").value = "";
  void api("unlock", { code })
    .then(async (value) => {
      if (own !== generation || typeof value.csrf !== "string") return;
      csrf = value.csrf;
      target = undefined;
      transition = false;
      await refresh();
    })
    .catch(() => notice("配对未成功；请检查手动粘贴的终端专用配对码。"))
    .finally(() => {
      if (own === generation) {
        transition = false;
        controls();
      }
    });
});
button("connect").addEventListener("click", () => {
  if (!target || !authorized || !available || socket || transition) return;
  transition = true;
  controls();
  const own = generation,
    selected = target;
  access = element<HTMLSelectElement>("access").value as "read" | "write";
  const abort = new AbortController();
  operation = abort;
  void api("attach", { target: selected, access }, abort.signal)
    .then((value) => {
      if (own !== generation || document.hidden) return;
      if (typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce)) throw new Error();
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal/ws`);
      socket = ws;
      connectTimer = setTimeout(() => disconnect(), 2000);
      ws.onopen = () => {
        if (own !== generation) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: "attach", nonce: value.nonce, csrf, target: selected, access }));
      };
      ws.onclose = () => {
        if (own === generation) disconnect();
      };
      ws.onerror = () => {
        if (own === generation) disconnect();
      };
      ws.onmessage = (event) => {
        if (own !== generation) return;
        try {
          if (typeof event.data !== "string") throw new Error();
          const frame = parseTerminalJson(event.data);
          if (!connected) {
            exact(frame, "target,type");
            if (frame.type !== "ready" || !sameTerminal(parseTerminalTarget(frame.target), selected)) throw new Error();
            connected = true;
            transition = false;
            clearTimeout(connectTimer);
            assembly = new TerminalSnapshotAssembly(selected);
            fenceScreen();
            return;
          }
          if (frame.type === "response") {
            exact(frame, "id,result,type");
            if (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id) || frame.id < 1) throw new Error();
            const call = pending.get(frame.id);
            if (!call) throw new Error();
            const result = parseTerminalResult(call.type, frame.result);
            clearTimeout(call.timer);
            pending.delete(frame.id);
            if (call.type === "acquire") {
              if (result.ok === true) {
                lease = result.leaseId as string;
                // The grant can begin before its ACK arrives. Start locally at
                // request dispatch, never extend it by network/render delay.
                leaseDeadline = call.startedAt + 30000;
                sequence = 0;
                tickLease(own);
              } else
                notice(
                  result.error === "local_owns_input"
                    ? "本地终端仍拥有输入；请在本地显式让出后再手动申请。"
                    : "控制权不可用；没有重试。",
                );
            } else if (call.type === "input") {
              if (result.delivery === "written") {
                notice("已写入终端；这不是命令执行或对话接受的确认。");
                if (call.draftRevision !== undefined && call.draftRevision === draftRevision) {
                  draft.value = "";
                  draftRevision++;
                }
              } else {
                disconnect(
                  result.delivery === "unknown" ? "输入结果未知，已断开；不会重发。" : "输入被拒绝，已断开；不会重发。",
                );
                return;
              }
            } else notice(result.ok ? "终端尺寸已确认。" : "终端尺寸结果未知或被拒绝；未自动重试。");
            controls();
            return;
          }
          if (frame.type === "screen-unavailable") throw new Error();
          if (frame.type === "screen-start") fenceScreen();
          const bytes = textBytes(event.data);
          if (queuedScreenBytes + bytes > TERMINAL_QUEUE_BYTES) throw new Error();
          // Retain only byte-counted raw envelopes, not assemblies or a growing
          // promise chain. Responses remain immediate so control can be fenced.
          queuedScreenBytes += bytes;
          screenQueue.push(event.data);
          void drainScreens();
        } catch {
          disconnect("连接或画面校验失败；未确认的输入结果未知，不会自动恢复。");
        }
      };
    })
    .catch(() => {
      if (own === generation) disconnect("终端不可用或授权已变化；请手动检查，不会重试。");
    });
});
button("refresh").addEventListener("click", () => {
  void refresh();
});
button("disconnect").addEventListener("click", () => disconnect());
button("logout").addEventListener("click", () => {
  disconnect();
  authorized = false;
  available = false;
  target = undefined;
  identity();
  controls();
  void api("logout", {})
    .then(() => {
      csrf = "";
      notice("终端已锁定。");
    })
    .catch(() => notice("本页已断开；注销结果未知，请在可信 CLI 撤销配对授权。"));
});
button("acquire").addEventListener("click", () => send("acquire"));
draft.addEventListener("input", () => draftRevision++);
draft.addEventListener("compositionstart", () => {
  draftRevision++;
  composing = true;
  controls();
});
draft.addEventListener("compositionend", () => {
  composing = false;
  controls();
});
button("send").addEventListener("click", () => sendInput(draft.value, draftRevision));
for (const key of document.querySelectorAll<HTMLButtonElement>("[data-key]"))
  key.addEventListener("click", () => {
    const data = keys[key.dataset.key ?? ""];
    if (data) sendInput(data);
  });
element("resize-form").addEventListener("submit", (event) => {
  event.preventDefault();
  send("resize", {
    leaseId: lease,
    columns: Number(element<HTMLInputElement>("columns").value),
    rows: Number(element<HTMLInputElement>("rows").value),
  });
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) disconnect("页面隐藏：控制已失效；未确认的输入结果未知，不会自动重连。");
});
window.addEventListener("pagehide", () => disconnect());
controls();
void refresh();
