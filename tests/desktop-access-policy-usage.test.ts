import { describe, expect, it } from "vitest";

import {
  buildAccessPolicyAlertRules,
  buildAccessPolicyErrorSummaryRule,
  buildAccessPolicyRuntimeSnapshot,
  buildAccessPolicyUsageSnapshot,
} from "../apps/desktop/src/access-policy-usage.js";

describe("desktop access policy usage snapshot", () => {
  it("aggregates daily consumer token usage and computes remaining quota", () => {
    const snapshot = buildAccessPolicyUsageSnapshot({
      consumerId: "consumer-alice",
      dailyTokenLimit: 1_000,
      dailyUsageSummary: {
        since: 1_000,
        updatedAt: 2_000,
        consumers: [
          {
            consumerId: "consumer-alice",
            usage: {
              totalTokens: 250,
            },
          },
          {
            consumerId: "consumer-alice",
            accessKeyId: "key-2",
            usage: {
              totalTokens: 125,
            },
          },
          {
            consumerId: "consumer-bob",
            usage: {
              totalTokens: 999,
            },
          },
        ],
      },
    });

    expect(snapshot).toMatchObject({
      configured: true,
      usedTokens: 375,
      limitTokens: 1_000,
      remainingTokens: 625,
      usageRatio: 0.375,
      tone: "active",
      resetAt: 1_000 + 24 * 60 * 60 * 1000,
    });
  });

  it("marks daily quota as exceeded when usage is over limit", () => {
    const snapshot = buildAccessPolicyUsageSnapshot({
      consumerId: "consumer-alice",
      dailyTokenLimit: 100,
      dailyUsageSummary: {
        since: 1_000,
        updatedAt: 2_000,
        consumers: [
          {
            consumerId: "consumer-alice",
            usage: {
              totalTokens: 120,
            },
          },
        ],
      },
    });

    expect(snapshot).toMatchObject({
      configured: true,
      usedTokens: 120,
      limitTokens: 100,
      remainingTokens: 0,
      usageRatio: 1,
      tone: "warning",
    });
  });

  it("returns an unconfigured snapshot when no daily quota is set", () => {
    const snapshot = buildAccessPolicyUsageSnapshot({
      consumerId: "consumer-alice",
      dailyUsageSummary: {
        since: 1_000,
        updatedAt: 2_000,
        consumers: [],
      },
    });

    expect(snapshot).toMatchObject({
      configured: false,
      usedTokens: 0,
      tone: "neutral",
    });
  });
});

describe("desktop access policy runtime snapshot", () => {
  it("computes remaining request and concurrency capacity for configured policy limits", () => {
    const snapshot = buildAccessPolicyRuntimeSnapshot({
      requestsPerMinute: 10,
      maxConcurrentRequests: 3,
      recentRequestCount1m: 7,
      inFlightRequests: 1,
      updatedAt: 2_000,
    });

    expect(snapshot).toMatchObject({
      requestLimitConfigured: true,
      requestLimit: 10,
      recentRequestCount1m: 7,
      remainingRequests1m: 3,
      requestUsageRatio: 0.7,
      concurrencyLimitConfigured: true,
      concurrencyLimit: 3,
      inFlightRequests: 1,
      remainingConcurrency: 2,
      concurrencyUsageRatio: 1 / 3,
      tone: "active",
      updatedAt: 2_000,
    });
  });

  it("marks runtime limits as warning when either request or concurrency capacity is exhausted", () => {
    const snapshot = buildAccessPolicyRuntimeSnapshot({
      requestsPerMinute: 5,
      maxConcurrentRequests: 2,
      recentRequestCount1m: 5,
      inFlightRequests: 2,
    });

    expect(snapshot).toMatchObject({
      remainingRequests1m: 0,
      requestUsageRatio: 1,
      remainingConcurrency: 0,
      concurrencyUsageRatio: 1,
      tone: "warning",
    });
  });

  it("keeps runtime snapshot neutral when no request or concurrency limit is configured", () => {
    const snapshot = buildAccessPolicyRuntimeSnapshot({
      recentRequestCount1m: 4,
      inFlightRequests: 2,
    });

    expect(snapshot).toMatchObject({
      requestLimitConfigured: false,
      recentRequestCount1m: 4,
      concurrencyLimitConfigured: false,
      inFlightRequests: 2,
      tone: "neutral",
    });
  });
});

describe("desktop access policy alert rules", () => {
  it("warns when a daily quota is near exhausted and runtime limits are saturated", () => {
    const rules = buildAccessPolicyAlertRules({
      policies: [
        {
          consumerId: "consumer-alice",
          quota: { dailyTokenLimit: 100 },
          limits: {
            requestsPerMinute: 10,
            maxConcurrentRequests: 2,
          },
        },
      ],
      dailyUsageSummary: {
        consumers: [
          {
            consumerId: "consumer-alice",
            usage: { totalTokens: 95 },
          },
        ],
      },
      runtimeConsumers: [
        {
          consumerId: "consumer-alice",
          recentRequestCount1m: 10,
          inFlightCount: 2,
          requestsPerMinute: 10,
          maxConcurrentRequests: 2,
        },
      ],
    });

    expect(rules).toEqual([
      expect.objectContaining({
        id: "daily-quota",
        status: "接近上限",
        tone: "warning",
      }),
      expect.objectContaining({
        id: "runtime-pressure",
        status: "接近上限",
        tone: "warning",
      }),
    ]);
  });

  it("reports active alert rules when configured policies have remaining capacity", () => {
    const rules = buildAccessPolicyAlertRules({
      policies: [
        {
          consumerId: "consumer-alice",
          quota: { dailyTokenLimit: 1_000 },
          limits: {
            requestsPerMinute: 10,
            maxConcurrentRequests: 4,
          },
        },
      ],
      dailyUsageSummary: {
        consumers: [
          {
            consumerId: "consumer-alice",
            usage: { totalTokens: 100 },
          },
        ],
      },
      runtimeConsumers: [
        {
          consumerId: "consumer-alice",
          recentRequestCount1m: 2,
          inFlightCount: 1,
        },
      ],
    });

    expect(rules).toEqual([
      expect.objectContaining({
        id: "daily-quota",
        status: "正常",
        tone: "active",
      }),
      expect.objectContaining({
        id: "runtime-pressure",
        status: "正常",
        tone: "active",
      }),
    ]);
  });
});

describe("desktop access policy error summary", () => {
  it("summarizes recent access policy errors by error code", () => {
    const rule = buildAccessPolicyErrorSummaryRule([
      {
        level: "error",
        message: "request_failed",
        createdAt: "2026-05-17T04:00:00.000Z",
        details: {
          errorCode: "access_policy_daily_quota_exceeded",
          consumerId: "consumer-alice",
        },
      },
      {
        level: "error",
        message: "request_failed",
        createdAt: "2026-05-17T04:01:00.000Z",
        details: {
          errorCode: "access_policy_pool_denied",
          consumerId: "consumer-bob",
        },
      },
      {
        level: "error",
        message: "request_failed",
        createdAt: "2026-05-17T04:02:00.000Z",
        details: {
          errorCode: "upstream_error",
        },
      },
    ]);

    expect(rule).toMatchObject({
      id: "policy-errors",
      title: "访问策略拒绝",
      status: "2 次",
      tone: "warning",
    });
    expect(rule.detail).toContain("access_policy_daily_quota_exceeded 1 次");
    expect(rule.detail).toContain("access_policy_pool_denied 1 次");
  });

  it("reports a healthy policy error summary when no recent policy rejection exists", () => {
    const rule = buildAccessPolicyErrorSummaryRule([
      {
        level: "error",
        message: "request_failed",
        createdAt: "2026-05-17T04:00:00.000Z",
        details: {
          errorCode: "upstream_error",
        },
      },
    ]);

    expect(rule).toMatchObject({
      id: "policy-errors",
      status: "正常",
      tone: "active",
    });
  });
});
