import { Button } from "@/components/ui/button";
import { t, useLanguage } from "../../core/i18n";
import type { MessageVersionGroup } from "../../core/message-versions";

const previousLabel = "Previous message version";
const nextLabel = "Next message version";
const pagerLabel = "Message versions";
const switchTitle =
  "Switching versions switches the entire branch. Files are not rolled back and no model is requested.";
const unavailableTitle = "Wait for Pi to be ready and run /webui to switch message versions.";

export function MessageVersionPager({
  entryId,
  group,
  onSwitchVersion,
}: {
  entryId?: string;
  group?: MessageVersionGroup;
  onSwitchVersion?: (entryId: string, version: { userEntryId: string; targetEntryId: string | null }) => void;
}) {
  useLanguage();
  if (!group || group.total <= 1) return null;

  const switchTo = (index: number) => {
    const version = group.versions[index];
    if (!entryId || !onSwitchVersion || !version?.targetEntryId) return;
    onSwitchVersion(entryId, version);
  };
  const previous = group.versions[group.index - 2];
  const next = group.versions[group.index];
  const previousDisabled = !entryId || !onSwitchVersion || !previous?.targetEntryId;
  const nextDisabled = !entryId || !onSwitchVersion || !next?.targetEntryId;

  return (
    <nav
      aria-label={t(pagerLabel)}
      className="flex max-w-full flex-wrap items-center gap-0.5"
      data-entry-id={entryId}
      data-testid="message-version-pager"
      data-current-user-id={group.userEntryId}
      title={t(switchTitle)}
    >
      <Button
        aria-label={t(previousLabel)}
        className="size-8 px-0 text-base"
        disabled={previousDisabled}
        onClick={() => switchTo(group.index - 2)}
        size="icon-sm"
        title={previousDisabled ? t(unavailableTitle) : t(switchTitle)}
        type="button"
        variant="ghost"
      >
        ‹
      </Button>
      <span
        aria-live="polite"
        className="min-w-12 text-center text-xs tabular-nums text-muted-foreground"
        role="status"
      >
        {group.index} / {group.total}
      </span>
      <Button
        aria-label={t(nextLabel)}
        className="size-8 px-0 text-base"
        disabled={nextDisabled}
        onClick={() => switchTo(group.index)}
        size="icon-sm"
        title={nextDisabled ? t(unavailableTitle) : t(switchTitle)}
        type="button"
        variant="ghost"
      >
        ›
      </Button>
    </nav>
  );
}
