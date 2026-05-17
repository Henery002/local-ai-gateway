import { describe, expect, it } from "vitest";

import {
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
