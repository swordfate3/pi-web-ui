import { FileIcon, ImageIcon, XIcon } from "lucide-react";
import { PromptInputButton, PromptInputHeader, usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import { getLanguage, t, useLanguage } from "../../core/i18n";
import type { WorkspaceUploadProgress } from "../../core/workspace-uploads";

function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

export function PromptAttachmentButton({ disabled = false }: { disabled?: boolean }) {
  useLanguage();
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputButton
      aria-label={t("Add photos or files")}
      data-testid="attachment-add"
      disabled={disabled}
      onClick={attachments.openFileDialog}
      tooltip={t("Add photos or files")}
      type="button"
    >
      <ImageIcon className="size-4" />
    </PromptInputButton>
  );
}

export function PromptAttachmentPreview({
  disabled = false,
  uploadProgress = [],
}: {
  disabled?: boolean;
  uploadProgress?: WorkspaceUploadProgress[];
}) {
  useLanguage();
  const attachments = usePromptInputAttachments();

  if (!attachments.files.length) return null;

  return (
    <PromptInputHeader data-testid="attachment-list">
      <div className="flex flex-wrap gap-2">
        {attachments.files.map((file) => (
          <div
            className="relative flex min-w-32 max-w-56 items-center gap-2 overflow-hidden rounded-md border bg-background p-2"
            data-testid="attachment-item"
            key={file.id}
          >
            {file.mediaType?.startsWith("image/") ? (
              <img
                alt={file.filename || t("Attached image")}
                className="size-10 shrink-0 rounded object-cover"
                src={file.url}
              />
            ) : (
              <FileIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs" title={file.filename || t("file")}>
                {file.filename || t("file")}
              </span>
              <span className="block text-muted-foreground text-[10px]">{formatAttachmentSize(file.file.size)}</span>
            </span>
            {uploadProgress.find((progress) => progress.id === file.id)?.status === "saved" && (
              <span
                className="max-w-24 truncate text-[10px] text-muted-foreground"
                title={uploadProgress.find((progress) => progress.id === file.id)?.relativePath}
              >
                {uploadProgress.find((progress) => progress.id === file.id)?.relativePath}
              </span>
            )}
            <button
              aria-label={t("Remove attachment")}
              className="rounded p-0.5"
              disabled={disabled}
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
