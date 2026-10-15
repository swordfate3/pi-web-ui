import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { calendarRange, dateInputValue, recentHistoryRange } from "../../core/history-dates";
import { t, useLanguage } from "../../core/i18n";
import { usePiWebUiStore } from "../../core/store";
import type { HistoryRange } from "../../core/types";
import { renderUiText } from "../../core/ui-text";

export function DateRangeControls({
  range,
  loading,
  saved = false,
  onChange,
}: {
  range: HistoryRange;
  loading?: boolean;
  saved?: boolean;
  onChange: (range: HistoryRange) => void;
}) {
  useLanguage();
  const id = useId();
  const [start, setStart] = useState(() => dateInputValue(range.from));
  const [end, setEnd] = useState(() => dateInputValue(range.to - 1));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setStart(dateInputValue(range.from));
    setEnd(dateInputValue(range.to - 1));
    setInvalid(false);
  }, [range.from, range.to]);
  const change = (next: HistoryRange) => {
    setInvalid(false);
    onChange(next);
  };
  return (
    <form
      className="min-w-0 space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          change(calendarRange(start, end));
        } catch {
          setInvalid(true);
        }
      }}
    >
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <label htmlFor={`${id}-start`} className="min-w-0 text-muted-foreground text-xs">
          {t("Start date")}
          <Input
            id={`${id}-start`}
            className="mt-1 w-full min-w-0"
            type="date"
            aria-label={t(saved ? "Saved sessions start date" : "History start date")}
            value={start}
            onChange={(event) => setStart(event.target.value)}
            required
          />
        </label>
        <label htmlFor={`${id}-end`} className="min-w-0 text-muted-foreground text-xs">
          {t("End date")}
          <Input
            id={`${id}-end`}
            className="mt-1 w-full min-w-0"
            type="date"
            aria-label={t(saved ? "Saved sessions end date" : "History end date")}
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            required
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="outline" disabled={loading}>
          {t("Apply dates")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => change(recentHistoryRange())}>
          {t("Recent three days")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => change(recentHistoryRange(new Date(), 1))}
        >
          {t("Today")}
        </Button>
      </div>
      {invalid && (
        <p role="alert" className="text-destructive text-sm">
          {t("Invalid date range")}
        </p>
      )}
    </form>
  );
}

export function HistoryControls() {
  useLanguage();
  const range = usePiWebUiStore((s) => s.historyRange);
  const history = usePiWebUiStore((s) => s.history);
  const before = usePiWebUiStore((s) => s.historyBefore);
  const loading = usePiWebUiStore((s) => s.historyLoading);
  const error = usePiWebUiStore((s) => s.historyError);
  const loadHistory = usePiWebUiStore((s) => s.loadHistory);
  const sessionId = usePiWebUiStore((s) => s.sessionId);
  const connection = usePiWebUiStore((s) => s.connection);
  const count = usePiWebUiStore((s) => s.items.length);
  const disabled = loading || !sessionId || connection !== "connected";
  const historical = Boolean(before) || Date.now() < range.from || Date.now() >= range.to;
  return (
    <section aria-label={t("Conversation history")} className="shrink-0 border-b px-4 py-2 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-2">
        <DateRangeControls range={range} loading={disabled} onChange={(next) => void loadHistory(next)} />
        <div aria-live="polite" className="space-y-1 text-muted-foreground text-xs">
          {loading && <p role="status">{t("Loading history...")}</p>}
          {error && (
            <p role="alert" className="text-destructive">
              {renderUiText(error)}
            </p>
          )}
          {!loading && !error && history && (
            <p>{t("Showing {returned} of {total} entries", { returned: history.returned, total: history.total })}</p>
          )}
          {!loading && !error && history && count === 0 && <p>{t("No messages in this date range.")}</p>}
          {Boolean(history?.truncatedEntries) && (
            <p>{t("Large entries are bounded previews. Full data remains in the original session.")}</p>
          )}
          {history?.treeLimited && <p>{t("Partial navigation tree for selected dates (up to 1,000 nodes).")}</p>}
          {historical && <p>{t("Live messages are hidden while viewing past dates or an older page.")}</p>}
        </div>
        {(history?.nextBefore || before) && (
          <div className="flex flex-wrap gap-2">
            {history?.nextBefore && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => void loadHistory(range, history.nextBefore ?? undefined)}
              >
                {t("Older page")}
              </Button>
            )}
            {before && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => void loadHistory(range)}
              >
                {t("Newest page")}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
