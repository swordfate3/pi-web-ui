import type { PiClient } from "./pi-client";

/** Resume read-only state, never replay a user command on a lifecycle event. */
export function watchConnectionLifecycle(getClient: () => PiClient | null, onHealthy: () => void) {
  let active = true;
  let resuming: Promise<void> | null = null;
  let syncRequested = false;
  const checkConnection = (sync: boolean) => {
    if (!active || document.visibilityState !== "visible") return;
    const client = getClient();
    if (!client) return;
    // A resume event joining a periodic probe must still request state sync.
    syncRequested ||= sync;
    if (resuming) return;
    resuming = client
      .ensureConnected()
      .then((healthy) => {
        if (active && healthy && syncRequested && getClient() === client) onHealthy();
      })
      .finally(() => {
        syncRequested = false;
        resuming = null;
      });
  };
  const resume = () => checkConnection(true);
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) resume();
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);
  const healthTimer = window.setInterval(() => checkConnection(false), 20_000);
  return () => {
    active = false;
    window.clearInterval(healthTimer);
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", resume);
    window.removeEventListener("focus", resume);
  };
}
