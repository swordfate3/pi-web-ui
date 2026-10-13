import { CircleIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { connectionLabel, useLanguage } from "../../core/i18n";
import type { ConnectionState } from "../../core/types";

export function ConnectionDot({ state }: { state: ConnectionState }) {
  useLanguage();
  return (
    <CircleIcon
      role="img"
      aria-label={connectionLabel(state)}
      className={cn(
        "size-2 fill-current",
        state === "connected" && "text-emerald-500",
        state === "connecting" && "text-amber-500",
        state === "disconnected" && "text-destructive",
      )}
    />
  );
}
