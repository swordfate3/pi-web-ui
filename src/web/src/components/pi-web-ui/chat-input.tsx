import { useState } from "react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { t, useLanguage, workspaceUploadText } from "../../core/i18n";
import type { BrowserCommandInfo, ChatSubmitStatus, ConnectionState } from "../../core/types";
import { MAX_WORKSPACE_UPLOAD_BYTES, type WorkspaceUploadProgress } from "../../core/workspace-uploads";
import { ArchModeToggle } from "./arch-mode-toggle";
import { PromptAttachmentButton, PromptAttachmentPreview } from "./prompt-attachments";

type ChatInputProps = {
  viewingHistory: boolean;
  archAvailable: boolean;
  connection: ConnectionState;
  archModeEnabled: boolean;
  chatStatus: ChatSubmitStatus;
  value: string;
  commands: BrowserCommandInfo[];
  availableThinkingLevels: string[];
  disabled?: boolean;
  attachmentsDisabled?: boolean;
  uploadProgress?: WorkspaceUploadProgress[];
  onCancelUpload?: () => void;
  onSubmit: (opts: { text: string; files?: unknown[] }) => void | Promise<void>;
  onAbort: () => void;
  onToggleArchMode: () => void;
  onValueChange: (value: string) => void;
};

export function ChatInput({
  viewingHistory,
  archAvailable,
  connection,
  archModeEnabled,
  chatStatus,
  value,
  commands,
  availableThinkingLevels,
  disabled = false,
  attachmentsDisabled = false,
  uploadProgress = [],
  onCancelUpload,
  onSubmit,
  onAbort,
  onToggleArchMode,
  onValueChange,
}: ChatInputProps) {
  useLanguage();
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [attachmentError, setAttachmentError] = useState<"accept" | "max_file_size" | "max_files" | null>(null);
  const builtInCommands: BrowserCommandInfo[] = [
    {
      name: "thinking",
      description: t("Set thinking level ({levels})", { levels: availableThinkingLevels.join(", ") }),
      source: "builtin",
    },
    { name: "compact", description: t("Compact the current context"), source: "builtin" },
    { name: "name", description: t("Set the session name"), source: "builtin" },
    { name: "new", description: t("Start a new session"), source: "builtin" },
    { name: "fork", description: t("Create a new session from a user message"), source: "builtin" },
    { name: "clone", description: t("Duplicate the current session"), source: "builtin" },
    { name: "resume", description: t("Search saved sessions in the current project"), source: "builtin" },
    {
      name: "reload",
      description: t("Reload Pi resources; wait for a new runtime, then run /webui again"),
      source: "builtin",
    },
    { name: "settings", description: t("Open settings"), source: "builtin" },
    { name: "model", description: t("Select a model"), source: "builtin" },
    { name: "session", description: t("Show session details, statistics and live context"), source: "builtin" },
    { name: "tree", description: t("Open conversation tree"), source: "builtin" },
    { name: "copy", description: t("Copy the last assistant message"), source: "builtin" },
    {
      name: "export",
      description: t("Download the full session tree as HTML (may contain sensitive data)"),
      source: "builtin",
    },
  ];
  const slashMatch = value.match(/^\/([^\s]*)(?:\s+(.*))?$/s);
  const argumentMatch = slashMatch?.[1] === "thinking" && slashMatch[2] !== undefined;
  const suggestions = (() => {
    if (!slashMatch) return [];
    if (argumentMatch) {
      const query = slashMatch[2].trim().toLowerCase();
      return availableThinkingLevels
        .filter((level) => level.startsWith(query) && level !== query)
        .map((level) => ({ name: level, description: t("Thinking level"), source: "builtin" as const }));
    }
    if (slashMatch[2] !== undefined) return [];
    const query = slashMatch[1].toLowerCase();
    const allCommands = [...commands.filter((command) => command.source !== "builtin"), ...builtInCommands].filter(
      (command, index, all) => all.findIndex((candidate) => candidate.name === command.name) === index,
    );
    return allCommands
      .filter((command) => command.name.toLowerCase().startsWith(query) && command.name.toLowerCase() !== query)
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 12);
  })();

  const selectSuggestion = (name: string) => {
    const nextValue = argumentMatch ? `/thinking ${name}` : `/${name} `;
    onValueChange(nextValue);
    setSelectedSuggestion(0);
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
      input?.focus();
      input?.setSelectionRange(nextValue.length, nextValue.length);
    });
  };

  if (viewingHistory) {
    return (
      <footer className="shrink-0 bg-background px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
        <div className="mx-auto w-full max-w-3xl text-center text-muted-foreground text-sm py-4">
          {t("Viewing history")}
        </div>
      </footer>
    );
  }

  return (
    <footer className="shrink-0 bg-background px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
      <div className="relative mx-auto w-full max-w-3xl">
        {!disabled && suggestions.length > 0 && (
          <div className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-64 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-sm">
            {suggestions.map((suggestion, index) => (
              <button
                aria-current={selectedSuggestion === index ? "true" : undefined}
                className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm ${selectedSuggestion === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
                key={suggestion.name}
                onClick={() => selectSuggestion(suggestion.name)}
                onMouseEnter={() => setSelectedSuggestion(index)}
                type="button"
              >
                <span className="font-mono">/{argumentMatch ? `thinking ${suggestion.name}` : suggestion.name}</span>
                {suggestion.description && (
                  <span className="truncate text-muted-foreground text-xs">{suggestion.description}</span>
                )}
              </button>
            ))}
          </div>
        )}
        {attachmentError && (
          <p role="alert" className="mb-2 text-sm text-destructive">
            {attachmentError === "accept"
              ? t("No files match the accepted types.")
              : workspaceUploadText(attachmentError === "max_file_size" ? "sizeLimit" : "tooManyFiles")}
          </p>
        )}
        <PromptInput
          accept={undefined}
          attachmentsDisabled={attachmentsDisabled}
          className="chat-composer"
          globalDrop={!disabled && !attachmentsDisabled}
          maxFiles={5}
          maxFileSize={MAX_WORKSPACE_UPLOAD_BYTES}
          multiple
          onError={(error) => setAttachmentError(error.code)}
          onSubmit={(message) => {
            setAttachmentError(null);
            return onSubmit(message);
          }}
        >
          <PromptAttachmentPreview disabled={attachmentsDisabled} uploadProgress={uploadProgress} />
          {uploadProgress.length > 0 && (
            <div className="flex w-full min-w-0 flex-col items-start gap-2 px-3 pt-2" aria-live="polite">
              {uploadProgress.map((progress) => {
                const displayProgress =
                  progress.status === "saved"
                    ? workspaceUploadText("savedPath", { path: progress.relativePath || "" })
                    : progress.status === "waiting"
                      ? `${progress.percent ?? 0}%`
                      : `${workspaceUploadText(progress.status)} ${progress.percent ?? 0}%`;
                return (
                  <span
                    className="block w-full min-w-0 max-w-full truncate text-muted-foreground text-xs"
                    data-testid="upload-progress"
                    key={progress.id}
                    title={`${progress.filename} — ${displayProgress}`}
                  >
                    {workspaceUploadText("uploadProgress", {
                      filename: progress.filename,
                      progress: displayProgress,
                    })}
                  </span>
                );
              })}
              {onCancelUpload && (
                <button
                  className="shrink-0 text-xs underline"
                  data-testid="upload-cancel"
                  onClick={onCancelUpload}
                  type="button"
                >
                  {workspaceUploadText("cancelUpload")}
                </button>
              )}
            </div>
          )}
          <PromptInputBody>
            <PromptInputTextarea
              data-testid="message-input"
              aria-label={t("Message Pi...")}
              className="min-h-16 resize-none px-4 pt-4"
              onChange={(event) => {
                onValueChange(event.currentTarget.value);
                setSelectedSuggestion(0);
              }}
              onKeyDown={(event) => {
                if (suggestions.length === 0) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedSuggestion((current) => (current + 1) % suggestions.length);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedSuggestion((current) => (current - 1 + suggestions.length) % suggestions.length);
                } else if (event.key === "Tab") {
                  event.preventDefault();
                  selectSuggestion(suggestions[selectedSuggestion].name);
                } else if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  selectSuggestion(suggestions[selectedSuggestion].name);
                }
              }}
              disabled={disabled || attachmentsDisabled}
              placeholder={t("Message Pi...")}
              value={value}
            />
          </PromptInputBody>
          <PromptInputFooter className="px-3 pb-3">
            <PromptInputTools>
              {archAvailable && (
                <ArchModeToggle
                  disabled={disabled || connection !== "connected"}
                  enabled={archModeEnabled}
                  onToggle={onToggleArchMode}
                />
              )}
              <PromptAttachmentButton disabled={disabled || attachmentsDisabled} />
              <div className="hidden items-center gap-1 px-2 text-muted-foreground text-xs sm:flex">
                {t("Enter sends, Shift+Enter inserts a newline")}
              </div>
            </PromptInputTools>
            <PromptInputSubmit
              data-testid="submit-message"
              disabled={disabled || attachmentsDisabled}
              onStop={onAbort}
              status={chatStatus}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </footer>
  );
}
