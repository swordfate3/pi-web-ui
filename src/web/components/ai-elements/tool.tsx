"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleIcon,
  ClockIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, memo, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { t, useLanguage } from "../../src/core/i18n";
import type { MessageKey } from "../../src/core/messages";

import { toolText } from "../../src/core/tool-text";

import { CodeBlock, CodeBlockCopyButton } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => {
  return <Collapsible className={cn("group not-prose w-full", className)} {...props} />;
};

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  summary?: ReactNode;
  collapsible?: boolean;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], MessageKey> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-3.5 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-3.5 text-blue-600" />,
  "input-available": <ClockIcon className="size-3.5 animate-pulse text-muted-foreground" />,
  "input-streaming": <CircleIcon className="size-3.5 text-muted-foreground" />,
  "output-available": <CheckCircleIcon className="size-3.5 text-green-600" />,
  "output-denied": <XCircleIcon className="size-3.5 text-orange-600" />,
  "output-error": <XCircleIcon className="size-3.5 text-red-600" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <span
    aria-label={t(statusLabels[status])}
    className="inline-flex size-4 shrink-0 items-center justify-center"
    role="img"
    title={t(statusLabels[status])}
  >
    {statusIcons[status]}
  </span>
);

export const ToolHeader = ({
  className,
  collapsible = true,
  summary,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  useLanguage();
  const derivedName = type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      disabled={!collapsible}
      className={cn(
        "flex w-full min-w-0 items-center justify-between gap-2 rounded-sm py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        {getStatusBadge(state)}
        <span className="shrink-0 font-medium text-foreground/80 text-sm">{title ?? derivedName}</span>
        {summary && (
          <span
            className="min-w-0 truncate font-mono text-muted-foreground text-xs"
            title={typeof summary === "string" ? summary : undefined}
          >
            {summary}
          </span>
        )}
      </div>
      {collapsible && (
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      )}
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => {
  return (
    <CollapsibleContent
      className={cn(
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 mt-1 space-y-2 pb-1 pl-6 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className,
      )}
      {...props}
    />
  );
};

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = memo(function ToolInput({ className, input, ...props }: ToolInputProps) {
  useLanguage();
  const [isExpanded, setIsExpanded] = useState(false);
  const { code, preview, isLong } = useMemo(
    () => toolText(typeof input === "string" ? JSON.stringify(input) : input),
    [input],
  );
  const visibleCode = isLong && !isExpanded ? preview : code;
  const buttonLabel = isExpanded ? t("Collapse") : t("Show full");

  return (
    <div className={cn("space-y-1.5 overflow-hidden", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{t("Parameters")}</h4>
      <div className="overflow-hidden rounded-md bg-muted/35">
        <CodeBlock
          code={visibleCode}
          copyCode={code}
          className={cn(isLong && "rounded-b-none border-b-0")}
          language="json"
        >
          <div className="flex justify-end px-2 pt-1">
            <CodeBlockCopyButton aria-label={t("Copy full parameters")} />
          </div>
        </CodeBlock>
        {isLong && (
          <div className="flex justify-end border bg-background/80 px-2 py-1.5">
            <Button
              aria-expanded={isExpanded}
              aria-label={isExpanded ? t("Collapse parameters") : t("Show full parameters")}
              className="text-muted-foreground"
              onClick={() => setIsExpanded((expanded) => !expanded)}
              size="xs"
              type="button"
              variant="ghost"
            >
              {isExpanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
              {buttonLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = memo(function ToolOutput({ className, output, errorText, ...props }: ToolOutputProps) {
  useLanguage();
  const [isExpanded, setIsExpanded] = useState(false);

  const text = useMemo(() => {
    if (errorText) return toolText(errorText);
    if (isValidElement(output)) return null;
    if (typeof output === "string" || (output !== null && typeof output === "object")) return toolText(output);
    return null;
  }, [output, errorText]);

  if (!(output || errorText)) return null;
  const isLong = text?.isLong ?? false;
  const visibleCode = text && isLong && !isExpanded ? text.preview : text?.code;
  const buttonLabel = isExpanded ? t("Collapse") : t("Show full");

  const Output = visibleCode ? (
    <CodeBlock
      code={visibleCode}
      copyCode={text?.code}
      className={cn(isLong && "rounded-b-none border-b-0", errorText && "border-destructive/20 bg-destructive/10")}
      language="json"
    >
      <div className="flex justify-end px-2 pt-1">
        <CodeBlockCopyButton aria-label={t("Copy full tool result")} />
      </div>
    </CodeBlock>
  ) : (
    <div>{output as ReactNode}</div>
  );

  return (
    <div className={cn("space-y-1.5", className)} data-tool-output {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? t("Error") : t("Result")}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText ? "bg-destructive/10 text-destructive" : "bg-muted/35 text-foreground",
        )}
      >
        {Output}
        {isLong && (
          <div className="flex justify-end border bg-background/80 px-2 py-1.5">
            <Button
              aria-expanded={isExpanded}
              aria-label={isExpanded ? t("Collapse tool result") : t("Show full tool result")}
              className={cn("text-muted-foreground", errorText && "text-destructive hover:text-destructive")}
              onClick={() => setIsExpanded((expanded) => !expanded)}
              size="xs"
              type="button"
              variant="ghost"
            >
              {isExpanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
              {buttonLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});
