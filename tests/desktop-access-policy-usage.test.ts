import { describe, expect, it } from "vitest";

import { buildAccessPolicyUsageSnapshot } from "../apps/desktop/src/access-policy-usage.js";

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
