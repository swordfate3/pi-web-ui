import type { PiClient } from "./pi-client";

/** Resume read-only state, never replay a user command on a lifecycle event. */
export function watchConnectionLifecycle(getClient: () => PiClient | null, onHealthy: () => void) {
  let active = true;
  let resuming: Promise<void> | null = null;
  const resume = () => {
    if (document.visibilityState !== "visible" || resuming) return;
    const client = getClient();
    if (!client) return;
    resuming = client
      .ensureConnected()
      .then((healthy) => {
        if (active && healthy && getClient() === client) onHealthy();
      })
      .finally(() => {
        resuming = null;
      });
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) resume();
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);
  return () => {
    active = false;
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", resume);
    window.removeEventListener("focus", resume);
  };
}
