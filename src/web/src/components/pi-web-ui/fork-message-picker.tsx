import { GitBranchPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatTime } from "../../core/format";
import { t, useLanguage } from "../../core/i18n";
import { Modal } from "./modal";

export type ForkableMessage = {
  entryId: string;
  text: string;
  timestamp?: string;
};

export function ForkMessagePicker({
  messages,
  onCancel,
  onSelect,
}: {
  messages: ForkableMessage[];
  onCancel: () => void;
  onSelect: (message: ForkableMessage) => void;
}) {
  useLanguage();
  const [query, setQuery] = useState("");
  const filteredMessages = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return messages;
    return messages.filter((message) => message.text.toLowerCase().includes(normalizedQuery));
  }, [messages, query]);

  return (
    <Modal onClose={onCancel} title={t("Fork from a user message")}>
      <p className="mb-3 text-muted-foreground text-sm">
        {t("Choose a message to create a separate session from. The original session remains unchanged.")}
      </p>
      <Input
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("Search user messages...")}
        value={query}
      />
      <div className="mt-3 max-h-[55vh] space-y-2 overflow-y-auto" role="list">
        {filteredMessages.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground text-sm">{t("No matching user messages.")}</p>
        ) : (
          filteredMessages.map((message) => (
            <Button
              className="h-auto min-h-12 w-full justify-start gap-3 whitespace-normal px-3 py-2 text-left"
              key={message.entryId}
              onClick={() => onSelect(message)}
              title={message.text}
              type="button"
              variant="outline"
            >
              <GitBranchPlusIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-3 block break-words">
                  {message.text || t("(message with attachments)")}
                </span>
                {message.timestamp && (
                  <span className="mt-1 block text-muted-foreground text-xs">{formatTime(message.timestamp)}</span>
                )}
              </span>
            </Button>
          ))
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={onCancel} type="button" variant="outline">
          {t("Cancel")}
        </Button>
      </div>
    </Modal>
  );
}
