import { CheckIcon, CopyIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { Message, MessageAction, MessageActions, MessageContent } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import { t, useLanguage } from "../../core/i18n";
import type { MessageVersionGroup } from "../../core/message-versions";
import { formatToolSummary, isToolExpandable, isToolHistoryPreview } from "../../core/tool-summary";
import type { ChatItem } from "../../core/types";
import { renderUiText } from "../../core/ui-text";
import { FileMessageResponse } from "./file-message-response";
import { MessageVersionPager } from "./message-version-pager";

export function ChatItemView({
  item,
  onCopy,
  onRegenerate,
  onToggleTool,
  showThinking,
  versionGroup,
  onSwitchVersion,
}: {
  item: ChatItem;
  onCopy: (text: string) => Promise<void> | void;
  onRegenerate?: (entryId: string) => void;
  onToggleTool: (id: string, open: boolean) => void;
  showThinking: boolean;
  versionGroup?: MessageVersionGroup;
  onSwitchVersion?: (entryId: string, version: { userEntryId: string; targetEntryId: string | null }) => void;
}) {
  useLanguage();
  const [copied, setCopied] = useState(false);

  if (item.kind === "system") {
    return (
      <div
        className={cn(
          "mx-auto max-w-xl whitespace-pre-wrap rounded-md px-3 py-2 text-center text-sm",
          item.tone === "error" && "bg-destructive/10 text-destructive",
          item.tone === "success" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          (!item.tone || item.tone === "info") && "text-muted-foreground",
        )}
      >
        {renderUiText(item.text)}
      </div>
    );
  }

  if (item.kind === "tool") {
    const expandable = isToolExpandable(item);
    const open = expandable ? (item.open ?? false) : false;

    return (
      <div className="w-full max-w-[95%]">
        <Tool
          className="mb-0 rounded-lg border-border/60 shadow-none"
          onOpenChange={(nextOpen) => expandable && onToggleTool(item.id, nextOpen)}
          open={open}
        >
          <ToolHeader
            collapsible={expandable}
            state={item.state}
            summary={formatToolSummary(item)}
            title={item.name}
            type={`tool-${item.name}` as `tool-${string}`}
          />
          {isToolHistoryPreview(item) && !item.historyPreview && (
            <p className="px-3 pb-2 text-muted-foreground text-xs">
              {t("History preview. Full data remains in the original session.")}
            </p>
          )}
          {expandable && (
            <ToolContent>
              <ToolInput input={item.input as never} />
              <ToolOutput errorText={item.errorText} output={item.output as never} />
            </ToolContent>
          )}
        </Tool>
      </div>
    );
  }

  // item.kind === "message" and role is "assistant" (user messages handled by UserMessageView)
  const canCopy = !item.historyPreview && item.text.trim().length > 0 && item.copyable !== false && !item.streaming;
  const isActivity = item.presentation === "activity";
  const canRegenerate = Boolean(
    !item.historyPreview &&
      item.role === "assistant" &&
      item.text.trim() &&
      item.entryId &&
      !item.streaming &&
      !isActivity,
  );

  const copyMessage = async () => {
    if (!canCopy) return;
    await onCopy(item.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Message className={cn(isActivity && "gap-1")} from={item.role}>
      <MessageContent
        className={cn(
          "w-full",
          isActivity && "gap-1 text-muted-foreground",
          item.streaming && 'after:ml-1 after:animate-pulse after:content-["▋"]',
        )}
      >
        {showThinking && item.reasoning && (
          <Reasoning className={cn(isActivity && "mb-1")} defaultOpen={false} isStreaming={Boolean(item.streaming)}>
            <ReasoningTrigger className={cn(isActivity && "text-xs")} />
            <ReasoningContent className={cn(isActivity && "mt-1 text-xs")}>{item.reasoning}</ReasoningContent>
          </Reasoning>
        )}
        <FileMessageResponse
          className={cn(isActivity && "text-muted-foreground [&_ol]:my-1 [&_p]:my-0 [&_pre]:my-1 [&_ul]:my-1")}
        >
          {item.text}
        </FileMessageResponse>
      </MessageContent>
      {(canCopy || canRegenerate || (versionGroup && versionGroup.total > 1)) && (
        <MessageActions className="self-start flex-wrap opacity-100 transition-opacity">
          <MessageVersionPager entryId={item.entryId} group={versionGroup} onSwitchVersion={onSwitchVersion} />
          {canCopy && (
            <MessageAction label={t("Copy message")} onClick={copyMessage} tooltip={t("Copy")}>
              {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
            </MessageAction>
          )}
          {canRegenerate && (
            <MessageAction
              aria-label={t("Regenerate answer")}
              disabled={!onRegenerate}
              label={t("Regenerate answer")}
              onClick={() => item.entryId && onRegenerate?.(item.entryId)}
              size="sm"
              title={
                onRegenerate
                  ? t("Regenerate answer")
                  : t("Wait for Pi to be ready and run /webui to enable message revisions.")
              }
              tooltip={
                onRegenerate
                  ? t("Regenerate answer")
                  : t("Wait for Pi to be ready and run /webui to enable message revisions.")
              }
            >
              <RotateCcwIcon className="size-4" />
              <span>{t("Regenerate answer")}</span>
            </MessageAction>
          )}
        </MessageActions>
      )}
    </Message>
  );
}
