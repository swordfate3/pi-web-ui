import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatTokens } from "../../core/format";
import { t, useLanguage } from "../../core/i18n";
import type { Usage } from "../../core/types";

export function ContextPopover({
  contextWindowSize,
  lastUsage,
  onClose,
}: {
  contextWindowSize: number;
  lastUsage: Usage | null;
  onClose: () => void;
}) {
  useLanguage();
  const input = lastUsage?.input || 0;
  const cacheRead = lastUsage?.cacheRead || 0;
  const totalUsed = input + cacheRead;
  const available = Math.max(0, contextWindowSize - totalUsed);
  const segments = [
    { label: t("Cached"), value: cacheRead, className: "bg-sky-500" },
    { label: t("Input"), value: input, className: "bg-amber-500" },
    { label: t("Available"), value: available, className: "bg-muted" },
  ];
  const percent = contextWindowSize ? Math.round((totalUsed / contextWindowSize) * 100) : 0;

  return (
    <div className="absolute right-4 top-4 z-20 w-80 rounded-lg border bg-popover p-4 shadow-lg">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-medium text-sm">{t("Context Window")}</div>
        <Button aria-label={t("Close")} onClick={onClose} size="icon-sm" type="button" variant="ghost">
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="mb-3 flex h-2 overflow-hidden rounded-full bg-muted">
        {segments.map((segment) => (
          <div
            className={segment.className}
            key={segment.label}
            style={{
              width: `${Math.max(0, (segment.value / contextWindowSize) * 100)}%`,
            }}
          />
        ))}
      </div>
      <div className="space-y-1 text-sm">
        {segments.map((segment) => (
          <div className="flex justify-between" key={segment.label}>
            <span className="text-muted-foreground">{segment.label}</span>
            <span>{formatTokens(segment.value)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-between border-t pt-3 text-muted-foreground text-xs">
        <span>{t("{percent}% used", { percent })}</span>
        <span>
          {formatTokens(totalUsed)} / {formatTokens(contextWindowSize)}
        </span>
      </div>
    </div>
  );
}
