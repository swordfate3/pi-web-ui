export type UsageStatistics = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number | null;
  unpricedRequests: number;
  requests: number;
};

export type UsageModelStatistics = UsageStatistics & {
  provider: string;
  model: string;
};

export type SessionUsageStatistics = {
  sessionId: string;
  runtimeId: string;
  statisticsScope: "all_entries";
  currency: "USD";
  totals: UsageStatistics;
  models: UsageModelStatistics[];
  lastResponse: UsageModelStatistics | null;
  truncated: boolean;
};

type MutableUsageStatistics = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costSubtotal: number;
  knownCostRequests: number;
  unpricedRequests: number;
  requests: number;
};

type ModelGroup = MutableUsageStatistics & {
  provider: string;
  model: string;
  bucket: "model" | "summary";
};

type UsageRecord = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"> & {
  cost: number | null;
};

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const MAX_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_MODEL_ROWS = 32;
const MAX_MODEL_IDENTITY_LENGTH = 256;
const OTHER_PROVIDER = "other";
const OTHER_MODEL = "other";
const TOOLS_PROVIDER = "tools";
const SUMMARIES_MODEL = "summaries";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyUsage(): MutableUsageStatistics {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costSubtotal: 0,
    knownCostRequests: 0,
    unpricedRequests: 0,
    requests: 0,
  };
}

function addCount(current: number, value: number, markTruncated: () => void): number {
  if (value > MAX_TOKEN_COUNT - current) {
    markTruncated();
    return MAX_TOKEN_COUNT;
  }
  return current + value;
}

function addCost(current: number, value: number, markTruncated: () => void): number {
  if (value > Number.MAX_VALUE - current) {
    markTruncated();
    return Number.MAX_VALUE;
  }
  const next = current + value;
  if (!Number.isFinite(next)) {
    markTruncated();
    return Number.MAX_VALUE;
  }
  return next;
}

function readUsageRecord(value: unknown, markTruncated: () => void): UsageRecord {
  const usage = isRecord(value) ? value : null;
  if (!usage) markTruncated();

  const counts = {} as Pick<UsageRecord, (typeof TOKEN_FIELDS)[number]>;
  for (const field of TOKEN_FIELDS) {
    const count = usage?.[field];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      counts[field] = 0;
      markTruncated();
    } else {
      counts[field] = count;
    }
  }

  const costValue = usage?.cost;
  let cost: number | null = null;
  if (isRecord(costValue)) {
    let valid = true;
    for (const field of COST_FIELDS) {
      const component = costValue[field];
      if (typeof component !== "number" || !Number.isFinite(component) || component < 0) valid = false;
    }
    if (valid) {
      const total = costValue.total as number;
      const hasTokens = TOKEN_FIELDS.some((field) => counts[field] > 0);
      // A zero quote with token usage is indistinguishable from missing pricing;
      // there is no historical model price available to prove that it was free.
      if (total > 0 || !hasTokens) cost = total;
    } else {
      markTruncated();
    }
  } else if (costValue !== undefined && costValue !== null) {
    markTruncated();
  }

  return {
    ...counts,
    cost,
  };
}

function addRecord(target: MutableUsageStatistics, record: UsageRecord, markTruncated: () => void): void {
  for (const field of TOKEN_FIELDS) {
    target[field] = addCount(target[field], record[field], markTruncated);
  }
  target.requests = addCount(target.requests, 1, markTruncated);
  if (record.cost === null) {
    target.unpricedRequests = addCount(target.unpricedRequests, 1, markTruncated);
  } else {
    target.costSubtotal = addCost(target.costSubtotal, record.cost, markTruncated);
    target.knownCostRequests = addCount(target.knownCostRequests, 1, markTruncated);
  }
}

function visibleStatistics(value: MutableUsageStatistics): UsageStatistics {
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    totalTokens: value.totalTokens,
    cost: value.knownCostRequests > 0 ? value.costSubtotal : null,
    unpricedRequests: value.unpricedRequests,
    requests: value.requests,
  };
}

function modelIdentity(provider: string, model: string, bucket: ModelGroup["bucket"]): string {
  return JSON.stringify([bucket, provider, model]);
}

function safeModelIdentity(
  provider: string,
  model: string,
  markTruncated: () => void,
): { provider: string; model: string; valid: boolean } {
  const valid =
    provider.length > 0 &&
    model.length > 0 &&
    provider.length <= MAX_MODEL_IDENTITY_LENGTH &&
    model.length <= MAX_MODEL_IDENTITY_LENGTH;
  if (valid) return { provider, model, valid: true };
  markTruncated();
  return { provider: OTHER_PROVIDER, model: OTHER_MODEL, valid: false };
}

function compareGroups(left: ModelGroup, right: ModelGroup): number {
  if (left.totalTokens !== right.totalTokens) return right.totalTokens - left.totalTokens;
  if (left.requests !== right.requests) return right.requests - left.requests;
  if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
  if (left.model !== right.model) return left.model < right.model ? -1 : 1;
  return left.bucket < right.bucket ? -1 : left.bucket > right.bucket ? 1 : 0;
}

/**
 * Aggregate persisted session usage only. This intentionally does not inspect
 * message content, paths, the current model's pricing, or nested retained tails.
 * `truncated` may mean model rows were bucketed; totals still include every entry.
 */
export function getSessionUsageStatistics(
  entries: readonly unknown[],
  sessionId: string,
  runtimeId: string,
): SessionUsageStatistics {
  let truncated = false;
  const markTruncated = () => {
    truncated = true;
  };
  const totals = emptyUsage();
  const groups = new Map<string, ModelGroup>();
  const overflow = { ...emptyUsage(), provider: OTHER_PROVIDER, model: OTHER_MODEL, bucket: "model" as const };
  const seenEntryIds = new Set<string>();
  let lastResponse: UsageModelStatistics | null = null;

  function collect(
    usage: unknown,
    provider: string,
    model: string,
    bucket: ModelGroup["bucket"] = "model",
    isAssistantResponse = false,
  ): void {
    const record = readUsageRecord(usage, markTruncated);
    addRecord(totals, record, markTruncated);
    const safeIdentity = safeModelIdentity(provider, model, markTruncated);
    const rowProvider = safeIdentity.provider;
    const rowModel = safeIdentity.model;
    const identity = modelIdentity(rowProvider, rowModel, bucket);
    if (!safeIdentity.valid || (bucket === "model" && rowProvider === OTHER_PROVIDER && rowModel === OTHER_MODEL)) {
      addRecord(overflow, record, markTruncated);
    } else {
      let group = groups.get(identity);
      if (!group && groups.size < MAX_MODEL_ROWS - 1) {
        group = { ...emptyUsage(), provider: rowProvider, model: rowModel, bucket };
        groups.set(identity, group);
      }
      if (group) {
        addRecord(group, record, markTruncated);
      } else {
        addRecord(overflow, record, markTruncated);
        markTruncated();
      }
    }
    if (isAssistantResponse) {
      const responseUsage = emptyUsage();
      addRecord(responseUsage, record, markTruncated);
      lastResponse = { provider: rowProvider, model: rowModel, ...visibleStatistics(responseUsage) };
    }
  }

  for (const value of entries) {
    if (!isRecord(value)) continue;
    const entryId = value.id;
    if (typeof entryId === "string") {
      if (seenEntryIds.has(entryId)) {
        markTruncated();
        continue;
      }
      seenEntryIds.add(entryId);
    }

    if (value.type === "message" && isRecord(value.message)) {
      const message = value.message;
      if (message.role === "assistant") {
        const provider = typeof message.provider === "string" ? message.provider : "unknown";
        // Match Pi's response model semantics exactly; do not consult current model pricing.
        const responseModel = message.responseModel ?? message.model;
        const model = typeof responseModel === "string" ? responseModel : "unknown";
        if (message.usage !== undefined && message.usage !== null) {
          collect(message.usage, provider, model, "model", true);
        }
      } else if (message.role === "toolResult" && message.usage !== undefined) {
        collect(message.usage, TOOLS_PROVIDER, SUMMARIES_MODEL, "summary");
      }
      continue;
    }

    if (value.type === "usage") {
      const hasModelAttribution =
        typeof value.provider === "string" &&
        value.provider.length > 0 &&
        typeof value.model === "string" &&
        value.model.length > 0;
      const provider = hasModelAttribution ? (value.provider as string) : TOOLS_PROVIDER;
      const model = hasModelAttribution ? (value.model as string) : SUMMARIES_MODEL;
      collect(value.usage, provider, model, hasModelAttribution ? "model" : "summary");
      continue;
    }

    if ((value.type === "compaction" || value.type === "branch_summary") && value.usage !== undefined) {
      collect(value.usage, TOOLS_PROVIDER, SUMMARIES_MODEL, "summary");
    }
  }

  const visibleGroups = [...groups.values()];
  if (overflow.requests > 0) visibleGroups.push(overflow);
  visibleGroups.sort(compareGroups);

  // Summary usage has a distinct grouping key, but its public labels could match
  // a real model identity. Keep response row keys unique without exposing a path
  // or changing any counters.
  const visibleKeys = new Set<string>();
  const models = visibleGroups.map((group) => {
    let { provider, model } = group;
    let key = JSON.stringify([provider, model]);
    if (visibleKeys.has(key)) {
      truncated = true;
      const base = model.slice(0, MAX_MODEL_IDENTITY_LENGTH - 16);
      let suffix = group.bucket === "summary" ? " [summary]" : " [model]";
      let index = 2;
      do {
        model = `${base}${suffix}`;
        key = JSON.stringify([provider, model]);
        suffix = group.bucket === "summary" ? ` [summary ${index}]` : ` [model ${index}]`;
        index += 1;
      } while (visibleKeys.has(key));
    }
    visibleKeys.add(key);
    return { provider, model, ...visibleStatistics(group) };
  });

  return {
    sessionId,
    runtimeId,
    statisticsScope: "all_entries",
    currency: "USD",
    totals: visibleStatistics(totals),
    models,
    lastResponse,
    truncated,
  };
}
