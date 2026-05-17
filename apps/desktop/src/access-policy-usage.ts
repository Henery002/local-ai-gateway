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

type AccessPolicyLike = {
  consumerId: string;
  quota?: {
    dailyTokenLimit?: number;
  };
  limits?: {
    requestsPerMinute?: number;
    maxConcurrentRequests?: number;
  };
};

type RuntimeConsumerLike = {
  consumerId: string;
  recentRequestCount1m?: number;
  inFlightCount?: number;
  requestsPerMinute?: number;
  maxConcurrentRequests?: number;
};

type RecentErrorLike = {
  level?: string;
  message?: string;
  createdAt?: string;
  details?: Record<string, unknown>;
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

export type AccessPolicyAlertRule = {
  id: "daily-quota" | "runtime-pressure" | "policy-errors";
  title: string;
  detail: string;
  status: string;
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

export function buildAccessPolicyAlertRules(input: {
  policies: AccessPolicyLike[];
  dailyUsageSummary?: DailyUsageSummaryLike;
  runtimeConsumers?: RuntimeConsumerLike[];
}): AccessPolicyAlertRule[] {
  const dailySnapshots = input.policies
    .map((policy) =>
      buildAccessPolicyUsageSnapshot({
        consumerId: policy.consumerId,
        dailyTokenLimit: policy.quota?.dailyTokenLimit,
        dailyUsageSummary: input.dailyUsageSummary,
      }),
    )
    .filter((snapshot) => snapshot.configured);
  const warningDailyCount = dailySnapshots.filter(
    (snapshot) => snapshot.tone === "warning",
  ).length;
  const exhaustedDailyCount = dailySnapshots.filter(
    (snapshot) => (snapshot.remainingTokens ?? 1) <= 0,
  ).length;

  const runtimeSnapshots = input.policies
    .map((policy) => {
      const runtime = input.runtimeConsumers?.find(
        (item) => item.consumerId === policy.consumerId,
      );
      return buildAccessPolicyRuntimeSnapshot({
        requestsPerMinute:
          runtime?.requestsPerMinute ?? policy.limits?.requestsPerMinute,
        maxConcurrentRequests:
          runtime?.maxConcurrentRequests ?? policy.limits?.maxConcurrentRequests,
        recentRequestCount1m: runtime?.recentRequestCount1m,
        inFlightRequests: runtime?.inFlightCount,
      });
    })
    .filter(
      (snapshot) =>
        snapshot.requestLimitConfigured ||
        snapshot.concurrencyLimitConfigured,
    );
  const warningRuntimeCount = runtimeSnapshots.filter(
    (snapshot) => snapshot.tone === "warning",
  ).length;

  const dailyRule: AccessPolicyAlertRule =
    dailySnapshots.length === 0
      ? {
          id: "daily-quota",
          title: "成员日限额余量低",
          detail: "尚未配置成员日限额；LAN 共享前建议先配置额度边界。",
          status: "待配置",
          tone: "warning",
        }
      : warningDailyCount > 0
        ? {
            id: "daily-quota",
            title: "成员日限额余量低",
            detail: `${warningDailyCount} 个成员日额度达到 90% 以上${
              exhaustedDailyCount > 0
                ? `，其中 ${exhaustedDailyCount} 个已用尽`
                : ""
            }。`,
            status: exhaustedDailyCount > 0 ? "已用尽" : "接近上限",
            tone: "warning",
          }
        : {
            id: "daily-quota",
            title: "成员日限额余量低",
            detail: `已配置 ${dailySnapshots.length} 个成员日限额，当前未发现低余量成员。`,
            status: "正常",
            tone: "active",
          };

  const runtimeRule: AccessPolicyAlertRule =
    runtimeSnapshots.length === 0
      ? {
          id: "runtime-pressure",
          title: "QPS / 并发接近上限",
          detail: "尚未配置 QPS 或最大并发限制；共享前建议为成员设置节流边界。",
          status: "未限制",
          tone: "neutral",
        }
      : warningRuntimeCount > 0
        ? {
            id: "runtime-pressure",
            title: "QPS / 并发接近上限",
            detail: `${warningRuntimeCount} 个成员近 60 秒请求或当前并发达到 90% 以上。`,
            status: "接近上限",
            tone: "warning",
          }
        : {
            id: "runtime-pressure",
            title: "QPS / 并发接近上限",
            detail: `已配置 ${runtimeSnapshots.length} 个成员限流策略，当前请求窗口和并发容量正常。`,
            status: "正常",
            tone: "active",
          };

  return [dailyRule, runtimeRule];
}

function getAccessPolicyErrorCode(error: RecentErrorLike): string | undefined {
  const value =
    error.details?.errorCode ??
    error.details?.code ??
    error.details?.type;
  if (typeof value !== "string") {
    return undefined;
  }
  const code = value.trim();
  return code.startsWith("access_policy_") ||
    code.startsWith("access_key_") ||
    code.startsWith("access_consumer_")
    ? code
    : undefined;
}

export function buildAccessPolicyErrorSummaryRule(
  recentErrors: RecentErrorLike[],
): AccessPolicyAlertRule {
  const counts = new Map<string, number>();
  for (const error of recentErrors) {
    const code = getAccessPolicyErrorCode(error);
    if (!code) {
      continue;
    }
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }

  const entries = Array.from(counts.entries()).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  if (entries.length === 0) {
    return {
      id: "policy-errors",
      title: "访问策略拒绝",
      detail: "最近错误中未发现访问策略拒绝。",
      status: "正常",
      tone: "active",
    };
  }

  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return {
    id: "policy-errors",
    title: "访问策略拒绝",
    detail: entries
      .slice(0, 3)
      .map(([code, count]) => `${code} ${count} 次`)
      .join("；"),
    status: `${total} 次`,
    tone: "warning",
  };
}
