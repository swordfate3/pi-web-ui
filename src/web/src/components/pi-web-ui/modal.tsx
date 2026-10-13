import { XIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { t, useLanguage } from "../../core/i18n";

export function Modal({ children, onClose, title }: { children: ReactNode; onClose: () => void; title: string }) {
  useLanguage();
  const titleId = useId();
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <button
        aria-label={t("Close dialog")}
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onMouseDown={onClose}
        type="button"
      />
      <div
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[80dvh] w-full max-w-lg overflow-y-auto rounded-lg border bg-popover p-4 shadow-lg"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="font-semibold text-base">
            {title}
          </h2>
          <Button aria-label={t("Close dialog")} onClick={onClose} size="icon-sm" type="button" variant="ghost">
            <XIcon className="size-4" />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
