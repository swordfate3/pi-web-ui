import { useLanguage } from "../../core/i18n";
import { usePiWebUiStore } from "../../core/store";

/** Informational only: this origin cannot authorize a trusted memory mutation. */
export function TerminalPromptBanner() {
  const language = useLanguage();
  const prompt = usePiWebUiStore((state) => state.terminalPrompt);
  if (!prompt) return null;
  const chinese = language === "zh-CN";
  return (
    <div role="status" data-testid="terminal-prompt-banner" className="shrink-0 border-b bg-muted/40 px-4 py-3 text-sm">
      <p className="font-medium">
        {chinese ? "正在等待终端交互" : "Waiting for terminal interaction"} · {prompt.kind}
      </p>
      {prompt.title !== undefined && <p className="whitespace-pre-wrap break-words">{prompt.title}</p>}
      <p className="text-muted-foreground">
        {chinese
          ? "请到 Pi 终端（或原有可信 RPC 客户端）查看完整内容并回应。网页无法确认或拒绝；此处不含确认正文。"
          : "Review the full prompt and respond in the Pi terminal (or its owning trusted RPC client). This page cannot approve or reject it; the prompt body is not available here."}
      </p>
    </div>
  );
}
