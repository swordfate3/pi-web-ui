import type { PiClient } from "./pi-client";

/** Resume read-only state, never replay a user command on a lifecycle event. */
export function watchConnectionLifecycle(getClient: () => PiClient | null, onHealthy: () => void) {
  let active = true;
  let resuming: { sync: boolean } | null = null;
  const checkConnection = (sync: boolean) => {
    if (!active || document.visibilityState !== "visible") return;
    const client = getClient();
    if (!client) return;
    if (client.pauseStaleHealthCheck()) resuming = null;
    // A resume event joining a periodic probe must still request state sync.
    if (resuming) {
      resuming.sync ||= sync;
      return;
    }
    const operation = { sync };
    resuming = operation;
    void client
      .ensureConnected()
      .then((healthy) => {
        if (
          active &&
          resuming === operation &&
          document.visibilityState === "visible" &&
          healthy &&
          operation.sync &&
          getClient() === client
        )
          onHealthy();
      })
      .finally(() => {
        if (resuming === operation) resuming = null;
      });
  };
  const resume = () => checkConnection(true);
  const visibility = () => {
    if (document.visibilityState !== "visible") {
      resuming = null;
      getClient()?.pauseHealthCheck();
    } else resume();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) resume();
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);
  const healthTimer = window.setInterval(() => checkConnection(false), 20_000);
  return () => {
    active = false;
    window.clearInterval(healthTimer);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", resume);
    window.removeEventListener("focus", resume);
  };
}
