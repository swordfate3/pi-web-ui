import { TerminalIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { ConversationEmptyState } from "@/components/ai-elements/conversation";
import { cn } from "@/lib/utils";
import { t, useLanguage } from "../../core/i18n";
import type { MessageVersionGroup } from "../../core/message-versions";
import type { ChatItem } from "../../core/types";
import { ChatItemView } from "./chat-item-view";
import { EntryDetailViewer, EntryPreviewControl } from "./entry-detail-view";
import { FileDownloadBoundary } from "./file-message-response";
import { UserMessageView } from "./user-message-view";

type ChatListProps = {
  readOnly?: boolean;
  items: ChatItem[];
  highlightedEntryId: string | null;
  onBranch?: (entryId: string) => Promise<void> | void;
  onEdit?: (entryId: string) => void;
  onRegenerate?: (entryId: string) => void;
  onCopy: (text: string) => Promise<void> | void;
  onToggleTool: (id: string, open: boolean) => void;
  registerItemElement: (item: ChatItem, node: HTMLElement | null) => void;
  showThinking: boolean;
  versions?: ReadonlyMap<string, MessageVersionGroup>;
  onSwitchVersion?: (entryId: string, version: { userEntryId: string; targetEntryId: string | null }) => void;
};

type ChatRowProps = Omit<ChatListProps, "items" | "highlightedEntryId" | "versions" | "readOnly"> & {
  versionGroup?: MessageVersionGroup;
  item: ChatItem;
  highlighted: boolean;
};

// Default shallow comparison deliberately includes *all* props. Store updates retain
// unchanged item references; errors, streaming content and callbacks must not be ignored.
const ChatRow = memo(function ChatRow({
  item,
  highlighted,
  onBranch,
  onEdit,
  onRegenerate,
  onCopy,
  onToggleTool,
  registerItemElement,
  showThinking,
  versionGroup,
  onSwitchVersion,
}: ChatRowProps) {
  const register = useCallback(
    (node: HTMLDivElement | null) => registerItemElement(item, node),
    [item, registerItemElement],
  );
  return (
    <div
      className={cn(
        "rounded-lg transition-[background-color,box-shadow] duration-300",
        highlighted && "bg-primary/10 ring-1 ring-primary/40",
      )}
      data-chat-item-id={item.id}
      data-chat-item-kind={item.kind}
      ref={register}
    >
      {item.kind === "message" && item.role === "user" ? (
        <UserMessageView
          actionsVisible={highlighted}
          item={item as ChatItem & { kind: "message"; role: "user" }}
          onBranch={item.entryId ? onBranch : undefined}
          onEdit={item.entryId ? onEdit : undefined}
          onCopy={onCopy}
          versionGroup={versionGroup}
          onSwitchVersion={onSwitchVersion}
        />
      ) : (
        <ChatItemView
          item={item}
          onCopy={onCopy}
          onRegenerate={item.entryId ? onRegenerate : undefined}
          onToggleTool={onToggleTool}
          showThinking={showThinking}
          versionGroup={versionGroup}
          onSwitchVersion={onSwitchVersion}
        />
      )}
      <EntryPreviewControl item={item} />
    </div>
  );
});

export const ChatList = memo(function ChatList({
  items,
  highlightedEntryId,
  versions,
  readOnly = false,
  ...props
}: ChatListProps) {
  // The empty state subscribes here; each message subscribes independently, so memo
  // boundaries never freeze translated UI or translated system/error messages.
  useLanguage();
  if (items.length === 0) {
    return (
      <ConversationEmptyState
        description={t(
          readOnly
            ? "Read-only chat: view history here; send input in the native terminal."
            : "Connect to the running Pi session and send a message.",
        )}
        icon={<TerminalIcon className="size-7" />}
        title="Pi Web UI"
      />
    );
  }
  return (
    <FileDownloadBoundary>
      {items.map((item) => (
        <ChatRow
          {...props}
          highlighted={Boolean(
            highlightedEntryId &&
              (item.entryId === highlightedEntryId || item.relatedEntryIds?.includes(highlightedEntryId)),
          )}
          item={item}
          key={item.id}
          onSwitchVersion={props.onSwitchVersion}
          versionGroup={item.entryId ? versions?.get(item.entryId) : undefined}
        />
      ))}
      <EntryDetailViewer />
    </FileDownloadBoundary>
  );
});
