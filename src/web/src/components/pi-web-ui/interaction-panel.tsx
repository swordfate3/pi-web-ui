import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePiWebUiStore } from "../../core/store";
import type { InteractionNotice, InteractionPanelView, InteractionView } from "../../core/store/interaction-slice";
import { Modal } from "./modal";

const fieldClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "—");
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];

function PendingReview({ notice, view }: { notice: InteractionNotice; view: InteractionView }) {
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const respond = usePiWebUiStore((state) => state.respondInteraction);
  const attempted = usePiWebUiStore((state) => state.interactionChoiceAttempts.includes(notice.requestId));
  const expired = notice.deadline <= Date.now();
  const path =
    view.managementOrigin &&
    view.generation &&
    view.authorityAvailable &&
    view.managementOrigin !== window.location.origin
      ? `${view.managementOrigin}/interactions/${view.generation}/${notice.requestId}/`
      : null;
  const submit = async (value: string | boolean) => {
    if (!notice.request || sending || attempted || expired) return;
    setSending(true);
    try {
      await respond(notice.request, value);
    } finally {
      setSending(false);
    }
  };
  return (
    <section
      className="min-w-0 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
      data-testid="interaction-notice"
    >
      <div className="text-sm font-medium break-words">
        {notice.adapterId} · {notice.action}
      </div>
      {expired ? (
        <p className="text-sm text-muted-foreground">此请求已过期，请回到原操作检查。</p>
      ) : notice.classification === "sensitive" ? (
        <>
          <p className="text-sm text-muted-foreground">
            需要安全确认。具体内容只会显示在独立管理页；聊天页无法代替你授权。
          </p>
          {path ? (
            <div className="flex flex-wrap gap-3 text-sm">
              <a className="underline underline-offset-4" href={path} rel="noopener noreferrer" target="_blank">
                前往管理页查看并决定 ↗
              </a>
              <a className="underline underline-offset-4 text-muted-foreground" href={path} rel="noreferrer">
                未打开？在当前页查看
              </a>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">此会话未接入独立管理页，请在 Pi 终端完成原确认。</p>
          )}
        </>
      ) : attempted ? (
        <p className="text-sm text-muted-foreground">已提交此选择。若送达结果不明，请检查原操作；不会再次提交。</p>
      ) : notice.request ? (
        <>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(notice.request.content, null, 2)}
          </pre>
          {notice.request.schema.kind === "confirm" ? (
            <div className="flex gap-2">
              <Button disabled={sending} onClick={() => void submit(false)} size="sm" variant="outline">
                拒绝
              </Button>
              <Button disabled={sending} onClick={() => void submit(true)} size="sm">
                确认
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {notice.request.schema.kind === "select" ? (
                <select
                  aria-label="选择项目"
                  className={fieldClass}
                  disabled={sending}
                  onChange={(event) => setAnswer(event.target.value)}
                  value={answer}
                >
                  <option value="">请选择</option>
                  {notice.request.schema.options?.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <textarea
                  aria-label="输入内容"
                  className={fieldClass}
                  disabled={sending}
                  onChange={(event) => setAnswer(event.target.value)}
                  value={answer}
                />
              )}
              <Button disabled={sending || !answer} onClick={() => void submit(answer)} size="sm">
                提交选择
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">请在 Pi 终端继续原操作。</p>
      )}
    </section>
  );
}

function McpPanel({
  panel,
  disabled,
  submit,
}: {
  panel: InteractionPanelView;
  disabled: boolean;
  submit: (method: string, params: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        启停、重连与 OAuth 仍由 MCP Adapter 执行，需要授权时会出现安全确认入口。配置修改后可能需要重新加载。
      </p>
      {panel.items.length === 0 && <p className="py-5 text-sm text-muted-foreground">当前没有 MCP 服务。</p>}
      {panel.items.map((item) => (
        <section className="space-y-2 rounded-md border p-3" key={text(item.name)}>
          <div className="font-medium break-all">{text(item.name)}</div>
          <p className="text-xs text-muted-foreground">
            {text(item.status)} · {item.disabled ? "已禁用" : "已启用"} · {text(item.toolCount)} tools
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled}
              onClick={() => submit("reconnect", { name: item.name })}
              size="sm"
              variant="outline"
            >
              重连
            </Button>
            <Button
              disabled={disabled || panel.config?.programmaticConfig === true}
              onClick={() => submit(item.disabled ? "enable" : "disable", { name: item.name })}
              size="sm"
              variant="outline"
            >
              {item.disabled ? "启用" : "禁用"}
            </Button>
            <Button
              disabled={disabled}
              onClick={() => submit("oauth", { name: item.name })}
              size="sm"
              variant="outline"
            >
              OAuth 登录
            </Button>
          </div>
        </section>
      ))}
    </div>
  );
}

function AgentsPanel({
  panel,
  disabled,
  submit,
}: {
  panel: InteractionPanelView;
  disabled: boolean;
  submit: (method: string, params: Record<string, unknown>) => void;
}) {
  const config = panel.config ?? {};
  const models = objects(config.models);
  const types = objects(config.agentTypes);
  const [model, setModel] = useState("");
  const [agentType, setAgentType] = useState("");
  const [thinking, setThinking] = useState("");
  const [task, setTask] = useState("");
  const [concurrency, setConcurrency] = useState(() => {
    const limits = config.concurrency;
    const value = limits && typeof limits === "object" && "default" in limits ? limits.default : undefined;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? String(value) : "";
  });
  const [target, setTarget] = useState("project");
  const selectedModel =
    model || text(types.find((item) => item.name === agentType)?.effectiveModel || config.defaultModel);
  const levels = models.find((item) => item.key === selectedModel)?.thinkingLevels;
  const thinkingLevels = Array.isArray(levels)
    ? levels.filter((level): level is string => typeof level === "string")
    : [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        这里只展示运行中和排队的任务。默认配置不重启正在执行的任务；提交后仍需安全确认。
      </p>
      <p className="text-xs text-muted-foreground break-all">
        当前默认模型：{text(config.defaultModel)} · 默认思考：{text(config.defaultThinking)}
      </p>
      {panel.items.length ? (
        panel.items.map((item) => (
          <section className="rounded-md border p-3 text-sm" key={text(item.id)}>
            <div className="font-medium break-words">
              {text(item.type)} · {text(item.status)}
            </div>
            <p className="break-words text-muted-foreground">{text(item.description)}</p>
            <p className="mt-1 text-xs break-all">
              {text(item.model)} · {text(item.thinking)}
            </p>
          </section>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">没有运行或排队的子代理。</p>
      )}
      <fieldset className="space-y-3 rounded-md border p-3" disabled={disabled}>
        <legend className="px-1 text-sm font-medium">模型与并发配置</legend>
        <label className="block text-sm">
          作用范围
          <select className={fieldClass} onChange={(e) => setTarget(e.target.value)} value={target}>
            <option value="project">当前项目</option>
            <option value="global">全局</option>
            <option value="session">当前会话（模型／并发）</option>
          </select>
        </label>
        <label className="block text-sm">
          模型
          <select
            className={fieldClass}
            onChange={(e) => {
              setModel(e.target.value);
              setThinking("");
            }}
            value={model}
          >
            <option value="">继承默认</option>
            {models.map((item) => (
              <option key={text(item.key)} value={text(item.key)}>
                {text(item.key)}
              </option>
            ))}
          </select>
        </label>
        <Button
          onClick={() => submit("set-default-model", { model: model || null, target })}
          size="sm"
          variant="outline"
        >
          保存未来任务的默认模型
        </Button>
        <label className="block text-sm">
          思考等级
          <select className={fieldClass} onChange={(e) => setThinking(e.target.value)} value={thinking}>
            <option value="">继承默认</option>
            {thinkingLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={target === "session"}
          onClick={() => submit("set-default-thinking", { thinking: thinking || null, target })}
          size="sm"
          variant="outline"
        >
          保存默认思考等级
        </Button>
        <label className="block text-sm">
          最大并发数
          <input
            className={fieldClass}
            min={1}
            onChange={(e) => setConcurrency(e.target.value)}
            step={1}
            type="number"
            value={concurrency}
          />
        </label>
        <Button
          disabled={!Number.isSafeInteger(Number(concurrency)) || Number(concurrency) < 1}
          onClick={() => submit("set-concurrency", { scope: "default", value: Number(concurrency), target })}
          size="sm"
          variant="outline"
        >
          保存并发限制
        </Button>
      </fieldset>
      <fieldset className="space-y-3 rounded-md border p-3" disabled={disabled}>
        <legend className="px-1 text-sm font-medium">启动子代理</legend>
        <label className="block text-sm">
          代理类型
          <select
            className={fieldClass}
            onChange={(e) => {
              setAgentType(e.target.value);
              setThinking("");
            }}
            value={agentType}
          >
            <option value="">请选择</option>
            {types.map((item) => (
              <option key={text(item.name)} value={text(item.name)}>
                {text(item.name)}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={!agentType}
          onClick={() => submit("set-agent-model", { type: agentType, model: model || null, target })}
          size="sm"
          variant="outline"
        >
          为此类型保存模型
        </Button>
        <label className="block text-sm">
          本次任务
          <textarea
            className={fieldClass}
            onChange={(e) => setTask(e.target.value)}
            placeholder="明确说明希望它完成的任务"
            rows={4}
            value={task}
          />
        </label>
        <p className="text-xs text-muted-foreground">本次使用上方模型和思考选项；不选择则沿用来源配置。</p>
        <Button
          disabled={!agentType || !task.trim() || new TextEncoder().encode(task).length > 32768}
          onClick={() =>
            submit("spawn", {
              type: agentType,
              task,
              ...(model ? { model } : {}),
              ...(thinking ? { thinking } : {}),
              background: true,
            })
          }
          size="sm"
        >
          提交任务并确认
        </Button>
      </fieldset>
    </div>
  );
}

export function InteractionCenter() {
  const view = usePiWebUiStore((state) => state.interactions);
  const panel = usePiWebUiStore((state) => state.interactionPanel);
  const action = usePiWebUiStore((state) => state.interactionAction);
  const loading = usePiWebUiStore((state) => state.interactionPanelLoading);
  const error = usePiWebUiStore((state) => state.interactionPanelError);
  const close = usePiWebUiStore((state) => state.closeInteractionPanel);
  const open = usePiWebUiStore((state) => state.openInteractionPanel);
  const submit = usePiWebUiStore((state) => state.submitInteractionAction);
  const refreshAction = usePiWebUiStore((state) => state.refreshInteractionAction);
  const focus = useRef<HTMLDivElement>(null);
  const busy = loading || (!!action && ["preparing", "pending", "delivery_unknown"].includes(action.state));
  const panelId = panel?.id;
  const activeSession = view?.sessionId;
  const actionState = action?.state;
  useEffect(() => {
    if (!panelId || !activeSession) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (actionState && ["pending", "delivery_unknown"].includes(actionState)) void refreshAction();
      else void open(panelId);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [panelId, activeSession, actionState, open, refreshAction]);
  useEffect(() => {
    if (panelId) focus.current?.focus({ preventScroll: true });
  }, [panelId]);
  if (!view) return null;
  const notices = view.pending.map((notice) => <PendingReview key={notice.requestId} notice={notice} view={view} />);
  const content = (
    <div
      className="space-y-3"
      role="group"
      aria-label="扩展交互操作"
      ref={focus}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
        if (event.key !== "Tab") return;
        const modal = event.currentTarget.closest('[role="dialog"]');
        const buttons = modal?.querySelectorAll<HTMLElement>(
          "button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])",
        );
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      {notices}
      {error && (
        <p className="break-words text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {action && (
        <div className="space-y-2 rounded-md border p-3 text-xs" role="status">
          <p className="break-all">任务编号：{action.actionId || "正在申请"}</p>
          <p>
            {action.state === "succeeded"
              ? "操作流程已结束，请刷新查看实际状态。"
              : action.state === "pending"
                ? "等待原扩展完成；如需授权，请使用上方安全确认入口。"
                : action.state === "delivery_unknown"
                  ? "送达结果不明；仅查询原任务，不要重复提交。"
                  : action.state}
          </p>
          {action.actionId && (
            <Button onClick={() => void refreshAction()} size="sm" variant="outline">
              查询原任务
            </Button>
          )}
        </div>
      )}
      {panel?.id === "pi-mcp-adapter" && (
        <McpPanel disabled={busy} panel={panel} submit={(method, params) => void submit(method, params)} />
      )}
      {panel?.id === "pi-subagents-lite" && (
        <AgentsPanel disabled={busy} panel={panel} submit={(method, params) => void submit(method, params)} />
      )}
      {panel && !["pi-mcp-adapter", "pi-subagents-lite"].includes(panel.id) && (
        <p className="text-sm text-muted-foreground">此面板暂未提供网页操作，请使用原终端。</p>
      )}
      {panel && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={loading || busy} onClick={() => void open(panel.id)} size="sm" variant="outline">
            刷新列表
          </Button>
          {panel.cursor && (
            <Button
              disabled={busy}
              onClick={() => void open(panel.id, panel.cursor ?? undefined)}
              size="sm"
              variant="outline"
            >
              下一页
            </Button>
          )}
          <Button onClick={close} size="sm" variant="outline">
            关闭面板
          </Button>
        </div>
      )}
    </div>
  );
  return panel ? (
    <Modal onClose={close} title={panel.id === "pi-mcp-adapter" ? "MCP 服务管理" : "子代理管理"}>
      {content}
    </Modal>
  ) : notices.length || error ? (
    <aside
      aria-label="扩展待处理操作"
      className="fixed bottom-24 right-3 z-40 max-h-[60dvh] w-[calc(100%-1.5rem)] max-w-lg space-y-2 overflow-y-auto rounded-lg border bg-popover p-3 shadow-lg"
    >
      {content}
    </aside>
  ) : null;
}
