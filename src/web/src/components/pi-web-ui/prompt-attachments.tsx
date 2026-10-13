import { ImageIcon, XIcon } from "lucide-react";
import { PromptInputButton, PromptInputHeader, usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import { t, useLanguage } from "../../core/i18n";

export function PromptAttachmentButton({ disabled = false }: { disabled?: boolean }) {
  useLanguage();
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputButton
      aria-label={t("Attach images")}
      disabled={disabled}
      onClick={attachments.openFileDialog}
      tooltip={t("Attach images")}
      type="button"
    >
      <ImageIcon className="size-4" />
    </PromptInputButton>
  );
}

export function PromptAttachmentPreview() {
  useLanguage();
  const attachments = usePromptInputAttachments();

  if (!attachments.files.length) return null;

  return (
    <PromptInputHeader>
      <div className="flex flex-wrap gap-2">
        {attachments.files.map((file) => (
          <div className="relative size-16 overflow-hidden rounded-md border bg-background" key={file.id}>
            {file.mediaType?.startsWith("image/") ? (
              <img alt={file.filename || t("Attached image")} className="size-full object-cover" src={file.url} />
            ) : (
              <div className="flex size-full items-center justify-center px-1 text-center text-muted-foreground text-[10px]">
                {file.filename || t("file")}
              </div>
            )}
            <button
              aria-label={t("Remove attachment")}
              className="absolute right-1 top-1 rounded bg-background/85 p-0.5 shadow-sm"
              onClick={() => attachments.remove(file.id)}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </PromptInputHeader>
  );
}
