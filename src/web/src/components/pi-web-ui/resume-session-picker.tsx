import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { recentHistoryRange } from "../../core/history-dates";
import { getLanguage, t, useLanguage } from "../../core/i18n";
import type { HistoryRange, SavedSession, SavedSessionsResult } from "../../core/types";
import { DateRangeControls } from "./history-controls";
import { Modal } from "./modal";

export function ResumeSessionPicker({
  listing,
  onCancel,
  onSelect,
  onRangeChange,
  loading,
}: {
  listing: SavedSessionsResult;
  onCancel: () => void;
  onSelect: (session: SavedSession) => void;
  onRangeChange: (range: HistoryRange) => void;
  loading?: boolean;
}) {
  useLanguage();
  const [query, setQuery] = useState("");
  const sessions = useMemo(() => {
    const search = query.trim().toLowerCase();
    return listing.sessions.filter((session) =>
      [session.name, session.firstMessage, session.sessionId].some((value) => value?.toLowerCase().includes(search)),
    );
  }, [listing, query]);

  return (
    <Modal onClose={onCancel} title={t("Resume a saved session")}>
      <div className="max-h-[65vh] space-y-3 overflow-y-auto">
        <p className="break-all text-muted-foreground text-sm">
          {t("Saved sessions for the current project: {cwd}", { cwd: listing.cwd })}
        </p>
        <DateRangeControls
          saved
          range={
            listing.from !== undefined && listing.to !== undefined
              ? { from: listing.from, to: listing.to }
              : recentHistoryRange()
          }
          loading={loading}
          onChange={onRangeChange}
        />
        {loading && (
          <p role="status" className="text-muted-foreground text-sm">
            {t("Loading saved sessions...")}
          </p>
        )}
        {listing.truncated && (
          <p className="text-muted-foreground text-sm">
            {t("Saved session results are capped. Narrow the date range to find more.")}
          </p>
        )}
        <Input
          autoFocus
          aria-label={t("Search saved sessions")}
          placeholder={t("Search saved sessions...")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="space-y-2" role="list">
          {sessions.length === 0 && (
            <p className="py-6 text-center text-muted-foreground text-sm">{t("No matching saved sessions.")}</p>
          )}
          {sessions.map((session) => (
            <Button
              className="h-auto min-h-12 w-full justify-start whitespace-normal px-3 py-2 text-left"
              disabled={loading || session.isCurrent || session.sessionId === listing.sessionId}
              key={session.id}
              onClick={() => onSelect(session)}
              type="button"
              variant="outline"
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words font-medium">
                  {session.name || t("Untitled session")}
                  {session.isCurrent || session.sessionId === listing.sessionId ? t(" · Current") : ""}
                </span>
                <span className="mt-1 line-clamp-2 block break-words text-muted-foreground">
                  {session.firstMessage || t("(no message preview)")}
                </span>
                <span className="mt-1 block break-all text-muted-foreground text-xs">{session.sessionId}</span>
                <span className="mt-1 block text-muted-foreground text-xs">
                  {t("{count} messages · Modified {date}", {
                    count: session.messageCount,
                    date: new Date(session.modified).toLocaleString(getLanguage()),
                  })}
                </span>
              </span>
            </Button>
          ))}
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={onCancel} type="button" variant="outline">
          {t("Cancel")}
        </Button>
      </div>
    </Modal>
  );
}
