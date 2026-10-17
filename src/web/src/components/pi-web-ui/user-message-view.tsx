import { CheckIcon, CopyIcon, GitBranchPlusIcon, PencilLineIcon } from "lucide-react";
import { useState } from "react";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { t, useLanguage } from "../../core/i18n";
import type { ChatItem } from "../../core/types";
import { ImagePreviewStrip } from "./image-preview-strip";

export function UserMessageView({
  actionsVisible,
  item,
  onBranch,
  onCopy,
  onEdit,
}: {
  actionsVisible?: boolean;
  item: ChatItem & { kind: "message"; role: "user" };
  onBranch?: (entryId: string) => Promise<void> | void;
  onCopy: (text: string) => Promise<void> | void;
  onEdit?: (entryId: string) => void;
}) {
  useLanguage();
  const [copied, setCopied] = useState(false);
  const canCopy = item.text.trim().length > 0 && !item.streaming;
  const canBranch = Boolean(onBranch && item.entryId && !item.streaming);
  const canEdit = Boolean(item.entryId && !item.streaming);

  const copyMessage = async () => {
    if (!canCopy) return;
    await onCopy(item.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Message className="is-user ml-auto justify-end" from="user">
      <MessageContent className="is-user:dark ml-auto min-w-0 max-w-full rounded-lg bg-secondary px-4 py-3 text-sm text-foreground">
        {item.images && <ImagePreviewStrip images={item.images} readonly />}
        <MessageResponse>{item.text}</MessageResponse>
      </MessageContent>
      <MessageActions
        className={cn("self-end flex-wrap opacity-100 transition-opacity", actionsVisible && "opacity-100")}
      >
        {canCopy && (
          <MessageAction label={t("Copy message")} onClick={copyMessage} tooltip={t("Copy")}>
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          </MessageAction>
        )}
        <MessageAction
          disabled={!canBranch}
          label={t("Branch from message")}
          onClick={() => item.entryId && onBranch?.(item.entryId)}
          tooltip={canBranch ? t("Branch from message") : t("Run /webui in terminal to enable branching")}
        >
          <GitBranchPlusIcon className="size-4" />
        </MessageAction>
        <MessageAction
          aria-label={t("Edit and resend")}
          disabled={!onEdit || !canEdit}
          label={t("Edit and resend")}
          onClick={() => item.entryId && onEdit?.(item.entryId)}
          size="sm"
          title={
            onEdit ? t("Edit and resend") : t("Wait for Pi to be ready and run /webui to enable message revisions.")
          }
          tooltip={
            onEdit ? t("Edit and resend") : t("Wait for Pi to be ready and run /webui to enable message revisions.")
          }
        >
          <PencilLineIcon className="size-4" />
          <span>{t("Edit and resend")}</span>
        </MessageAction>
      </MessageActions>
    </Message>
  );
}
