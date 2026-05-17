type UsageCounterLike = {
  totalTokens?: number;
};

type ConsumerUsageLike = {
  consumerId?: string;
  usage?: UsageCounterLike;
};

type DailyUsageSummaryLike = {
  since?: number;
  updatedAt?: number;
  consumers?: ConsumerUsageLike[];
};

export type AccessPolicyUsageSnapshot = {
  configured: boolean;
  usedTokens: number;
  limitTokens?: number;
  remainingTokens?: number;
  usageRatio?: number;
  resetAt?: number;
  updatedAt?: number;
  tone: "active" | "warning" | "neutral";
};

export type AccessPolicyRuntimeSnapshot = {
  requestLimitConfigured: boolean;
  requestLimit?: number;
  recentRequestCount1m: number;
  remainingRequests1m?: number;
  requestUsageRatio?: number;
  concurrencyLimitConfigured: boolean;
  concurrencyLimit?: number;
  inFlightRequests: number;
  remainingConcurrency?: number;
  concurrencyUsageRatio?: number;
  updatedAt?: number;
  tone: "active" | "warning" | "neutral";
};

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeUsageCounter(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

export function buildAccessPolicyUsageSnapshot(input: {
  consumerId: string;
  dailyTokenLimit?: number;
  dailyUsageSummary?: DailyUsageSummaryLike;
}): AccessPolicyUsageSnapshot {
  const usedTokens = (input.dailyUsageSummary?.consumers ?? [])
    .filter((item) => item.consumerId === input.consumerId)
    .reduce(
      (sum, item) => sum + normalizeUsageCounter(item.usage?.totalTokens),
      0,
    );
  const limitTokens = normalizePositiveInteger(input.dailyTokenLimit);
  if (typeof limitTokens !== "number") {
    return {
      configured: false,
      usedTokens,
      updatedAt: input.dailyUsageSummary?.updatedAt,
      tone: "neutral",
    };
  }

  const remainingTokens = Math.max(0, limitTokens - usedTokens);
  const usageRatio = Math.min(1, usedTokens / limitTokens);
  return {
    configured: true,
    usedTokens,
    limitTokens,
    remainingTokens,
    usageRatio,
    resetAt:
      typeof input.dailyUsageSummary?.since === "number"
        ? input.dailyUsageSummary.since + 24 * 60 * 60 * 1000
        : undefined,
    updatedAt: input.dailyUsageSummary?.updatedAt,
    tone: usageRatio >= 0.9 ? "warning" : "active",
  };
}

export function buildAccessPolicyRuntimeSnapshot(input: {
  requestsPerMinute?: number;
  maxConcurrentRequests?: number;
  recentRequestCount1m?: number;
  inFlightRequests?: number;
  updatedAt?: number;
}): AccessPolicyRuntimeSnapshot {
  const requestLimit = normalizePositiveInteger(input.requestsPerMinute);
  const concurrencyLimit = normalizePositiveInteger(input.maxConcurrentRequests);
  const recentRequestCount1m = normalizeUsageCounter(input.recentRequestCount1m);
  const inFlightRequests = normalizeUsageCounter(input.inFlightRequests);

  const requestUsageRatio =
    typeof requestLimit === "number"
      ? Math.min(1, recentRequestCount1m / requestLimit)
      : undefined;
  const concurrencyUsageRatio =
    typeof concurrencyLimit === "number"
      ? Math.min(1, inFlightRequests / concurrencyLimit)
      : undefined;
  const tone =
    requestUsageRatio === undefined && concurrencyUsageRatio === undefined
      ? "neutral"
      : (requestUsageRatio ?? 0) >= 0.9 || (concurrencyUsageRatio ?? 0) >= 0.9
        ? "warning"
        : "active";

  return {
    requestLimitConfigured: typeof requestLimit === "number",
    requestLimit,
    recentRequestCount1m,
    remainingRequests1m:
      typeof requestLimit === "number"
        ? Math.max(0, requestLimit - recentRequestCount1m)
        : undefined,
    requestUsageRatio,
    concurrencyLimitConfigured: typeof concurrencyLimit === "number",
    concurrencyLimit,
    inFlightRequests,
    remainingConcurrency:
      typeof concurrencyLimit === "number"
        ? Math.max(0, concurrencyLimit - inFlightRequests)
        : undefined,
    concurrencyUsageRatio,
    updatedAt: input.updatedAt,
    tone,
  };
}
