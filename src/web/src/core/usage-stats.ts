import type { UsageStatsResult } from "./types";

const counters = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "unpricedRequests", "requests"] as const;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function totals(value: unknown): boolean {
  return (
    record(value) &&
    counters.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) &&
    (value.cost === null || (typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0))
  );
}
function model(value: unknown): boolean {
  return (
    totals(value) &&
    record(value) &&
    typeof value.provider === "string" &&
    value.provider.length <= 256 &&
    typeof value.model === "string" &&
    value.model.length <= 256
  );
}

/** Fail closed on an old runtime, malformed result, or cross-session reply. */
export function parseUsageStats(value: unknown, sessionId: string, runtimeId: string): UsageStatsResult {
  if (
    !record(value) ||
    value.sessionId !== sessionId ||
    value.runtimeId !== runtimeId ||
    value.statisticsScope !== "all_entries" ||
    value.currency !== "USD" ||
    typeof value.truncated !== "boolean" ||
    !totals(value.totals) ||
    !Array.isArray(value.models) ||
    value.models.length > 32 ||
    !value.models.every(model) ||
    (value.lastResponse !== null && !model(value.lastResponse))
  ) {
    throw new Error("Usage statistics unavailable for this session.");
  }
  return value as UsageStatsResult;
}
