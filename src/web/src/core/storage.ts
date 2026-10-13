/** Preferences are optional: sandboxed/private browsers can deny storage entirely. */
export function readPreference(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    // Keep the in-memory preference even when persistence is unavailable.
  }
}
