import { t, useLanguage } from "../../core/i18n";
import type { SessionStatsResult } from "../../core/types";
import { renderUiText, uiText } from "../../core/ui-text";
import { Modal } from "./modal";

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return t("unknown");
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

export function sessionStatsSummary(stats: SessionStatsResult) {
  const count = (value: unknown) => (value == null ? uiText("unknown") : String(value));
  return uiText("{title}\n{messages}\n{tools}\n{context}", {
    title: uiText("Session stats"),
    messages: uiText("Messages: {total} ({user} user, {assistant} assistant)", {
      total: count(stats.totalMessages),
      user: count(stats.userMessages),
      assistant: count(stats.assistantMessages),
    }),
    tools: uiText("Tool calls: {count}", { count: count(stats.toolCalls) }),
    // Cumulative billing totals are never an estimate of live context.
    context: uiText("Context: {value}", {
      value:
        stats.contextUsage?.tokens == null
          ? uiText("unknown")
          : uiText("{count} tokens", { count: stats.contextUsage.tokens }),
    }),
  });
}

export function SessionDetails({ stats, onClose }: { stats: SessionStatsResult; onClose: () => void }) {
  useLanguage();
  const rows: [string, unknown][] = [
    [t("Session ID"), stats.sessionId],
    [t("Name"), stats.sessionName],
    [t("Session file"), stats.sessionFile],
    [t("Working directory"), stats.cwd],
    [t("Session directory"), stats.sessionDir],
    [t("Runtime ID"), stats.runtimeId],
    [t("Statistics scope"), stats.statisticsScope],
    [t("Entries (full tree)"), stats.entryCount],
    [t("Entries (active branch)"), stats.branchEntryCount],
    [t("Leaf ID"), stats.leafId],
    [t("Tool results"), stats.toolResults],
    [t("Cumulative tokens (not context)"), stats.tokens],
    [t("Cumulative cost"), stats.cost],
    [t("Cumulative costs by category"), stats.costs],
    [t("Context window"), stats.contextUsage?.contextWindow],
    [t("Context used (%)"), stats.contextUsage?.percent],
    [t("Model"), stats.model],
    [t("Thinking level"), stats.thinkingLevel],
    [t("Streaming"), stats.isStreaming],
    [t("Has pending messages"), stats.hasPendingMessages],
    [t("Auto compaction enabled"), stats.autoCompactionEnabled],
    [t("Session header"), stats.header],
  ];
  return (
    <Modal title={t("Session stats")} onClose={onClose}>
      <div className="max-h-[65vh] space-y-4 overflow-y-auto text-sm">
        <p className="whitespace-pre-wrap">
          {renderUiText(sessionStatsSummary(stats)).split("\n").slice(1).join("\n")}
        </p>
        <p className="text-muted-foreground">
          {t(
            "Cumulative statistics cover all entries, including other branches and preserved compaction history. Live context is reported separately; unavailable values are unknown.",
          )}
        </p>
        <dl className="space-y-3">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="font-medium">{label}</dt>
              <dd className="whitespace-pre-wrap break-all text-muted-foreground">{display(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
}
