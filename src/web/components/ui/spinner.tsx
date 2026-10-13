import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { t, useLanguage } from "../../src/core/i18n";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  useLanguage();
  return (
    <Loader2Icon role="status" aria-label={t("Loading")} className={cn("size-4 animate-spin", className)} {...props} />
  );
}

export { Spinner };
