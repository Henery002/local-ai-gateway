import { describe, expect, it } from "vitest";

import type { CodexAccountGroup } from "../apps/desktop/src/account-groups.js";
import {
  buildAccountActivitySummary,
  formatQuotaWindowLabel,
  getAvatarToneIndex,
  getQuotaPercentage,
  getQuotaToneClass,
  getSessionTitle,
  matchesAccountSearch,
  sortAccountGroups,
  type AccountSessionViewLike,
} from "../apps/desktop/src/account-view-model.js";

function createGroup(
  overrides: Partial<AccountSessionViewLike> & Pick<AccountSessionViewLike, "id" | "profileId">,
): CodexAccountGroup<AccountSessionViewLike> {
  const representative: AccountSessionViewLike = {
    status: "available",
    sourceKind: "local-import",
    ...overrides,
  };

  return {
    key: representative.id,
    sourceKind: representative.sourceKind ?? "local-import",
    sourceLabel:
      representative.sourceKind === "openclaw"
        ? "OpenClaw 可复用授权"
        : "桌面端 Codex 账号",
    displayName:
      representative.email ??
      representative.displayName ??
      representative.accountId ??
      representative.profileId,
    sessions: [representative],
    representative,
    isActive: false,
  };
}

describe("desktop account view model", () => {
  it("formats titles, quota labels and tone classes for account cards", () => {
    const session: AccountSessionViewLike = {
      id: "session_alpha",
      profileId: "profile_alpha",
      email: "alpha@example.com",
      status: "available",
      quota: {
        percentage: 18,
        windowMinutes: 60 * 24 * 7,
      },
    };

    expect(getSessionTitle(session)).toBe("alpha@example.com");
    expect(getQuotaPercentage(session)).toBe(18);
    expect(formatQuotaWindowLabel(session)).toBe("剩余额度（7天）");
    expect(getQuotaToneClass(18)).toBe("quota-low");
    expect(getQuotaToneClass(42)).toBe("quota-medium");
    expect(getQuotaToneClass(88)).toBe("quota-high");
    expect(getQuotaToneClass(undefined)).toBe("quota-unknown");
  });

  it("matches account search against representative and nested session identifiers", () => {
    const group: CodexAccountGroup<AccountSessionViewLike> = {
      key: "acct_alpha",
      sourceKind: "openclaw",
      sourceLabel: "OpenClaw 可复用授权",
      displayName: "acct_alpha",
      representative: {
        id: "builder:openai-codex:default",
        profileId: "openai-codex:default",
        accountId: "acct_alpha",
        email: "alpha@example.com",
        status: "available",
        sourceKind: "openclaw",
      },
      sessions: [
        {
          id: "builder:openai-codex:default",
          profileId: "openai-codex:default",
          accountId: "acct_alpha",
          email: "alpha@example.com",
          status: "available",
          sourceKind: "openclaw",
        },
        {
          id: "ops:openai-codex:default",
          profileId: "openai-codex:default",
          accountId: "acct_alpha",
          email: "ops@example.com",
          status: "available",
          sourceKind: "openclaw",
        },
      ],
      isActive: false,
    };

    expect(matchesAccountSearch(group, "alpha@example.com")).toBe(true);
    expect(matchesAccountSearch(group, "ops@example.com")).toBe(true);
    expect(matchesAccountSearch(group, "acct_alpha")).toBe(true);
    expect(matchesAccountSearch(group, "missing")).toBe(false);
  });

  it("sorts accounts by quota and reset time while pushing undefined values to the end", () => {
    const groups = [
      createGroup({
        id: "acct-high",
        profileId: "acct-high",
        email: "high@example.com",
        quota: { percentage: 90, resetAt: 300 },
      }),
      createGroup({
        id: "acct-mid",
        profileId: "acct-mid",
        email: "mid@example.com",
        quota: { percentage: 55, resetAt: 100 },
      }),
      createGroup({
        id: "acct-none",
        profileId: "acct-none",
        email: "none@example.com",
      }),
    ];

    expect(
      sortAccountGroups(groups, {
        search: "",
        sortKey: "quota",
        sortDirection: "desc",
      }).map((group) => group.representative.id),
    ).toEqual(["acct-high", "acct-mid", "acct-none"]);

    expect(
      sortAccountGroups(groups, {
        search: "",
        sortKey: "resetAt",
        sortDirection: "asc",
      }).map((group) => group.representative.id),
    ).toEqual(["acct-mid", "acct-high", "acct-none"]);
  });

  it("keeps pinned account group fixed at the front regardless of sorting", () => {
    const groups = [
      createGroup({
        id: "acct-high",
        profileId: "acct-high",
        email: "high@example.com",
        quota: { percentage: 90, resetAt: 300 },
      }),
      createGroup({
        id: "acct-mid",
        profileId: "acct-mid",
        email: "mid@example.com",
        quota: { percentage: 55, resetAt: 100 },
      }),
      createGroup({
        id: "acct-low",
        profileId: "acct-low",
        email: "low@example.com",
        quota: { percentage: 10, resetAt: 50 },
      }),
    ];

    expect(
      sortAccountGroups(groups, {
        search: "",
        sortKey: "quota",
        sortDirection: "desc",
        pinnedSessionId: "acct-low",
      }).map((group) => group.representative.id),
    ).toEqual(["acct-low", "acct-high", "acct-mid"]);
  });

  it("keeps avatar tone indices stable and bounded", () => {
    const first = getAvatarToneIndex("session_alpha");
    const second = getAvatarToneIndex("session_alpha");
    const other = getAvatarToneIndex("session_beta");

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(12);
    expect(other).toBeGreaterThanOrEqual(0);
    expect(other).toBeLessThan(12);
  });

  it("aggregates account activity summaries from grouped sessions", () => {
    const groups: CodexAccountGroup<AccountSessionViewLike>[] = [
      {
        key: "acct_alpha",
        sourceKind: "local-import",
        sourceLabel: "桌面端 Codex 账号",
        displayName: "alpha@example.com",
        representative: {
          id: "acct_alpha_primary",
          profileId: "acct_alpha_primary",
          accountId: "acct_alpha",
          email: "alpha@example.com",
          status: "available",
          sourceKind: "local-import",
          activity: {
            requestCount: 18,
            recentRequestCount1h: 9,
            recentRequestCount24h: 26,
            recentByClientTag5m: [
              { clientTag: "openclaw", requestCount: 3 },
              { clientTag: "localraghub", requestCount: 1 },
            ],
          },
        },
        sessions: [
          {
            id: "acct_alpha_primary",
            profileId: "acct_alpha_primary",
            accountId: "acct_alpha",
            email: "alpha@example.com",
            status: "available",
            sourceKind: "local-import",
            activity: {
              requestCount: 18,
              recentRequestCount1h: 9,
              recentRequestCount24h: 26,
              recentByClientTag5m: [
                { clientTag: "openclaw", requestCount: 3 },
                { clientTag: "localraghub", requestCount: 1 },
              ],
            },
          },
          {
            id: "acct_alpha_secondary",
            profileId: "acct_alpha_secondary",
            accountId: "acct_alpha",
            email: "alpha+2@example.com",
            status: "available",
            sourceKind: "local-import",
            activity: {
              requestCount: 4,
              recentRequestCount1h: 2,
              recentRequestCount24h: 5,
              recentByClientTag5m: [{ clientTag: "openclaw", requestCount: 2 }],
            },
          },
        ],
        isActive: true,
      },
      createGroup({
        id: "acct_beta",
        profileId: "acct_beta",
        email: "beta@example.com",
        activity: {
          requestCount: 5,
          recentRequestCount1h: 4,
          recentRequestCount24h: 8,
          recentByClientTag5m: [{ clientTag: "unknown", requestCount: 2 }],
        },
      }),
      createGroup({
        id: "acct_gamma",
        profileId: "acct_gamma",
        email: "gamma@example.com",
        activity: {
          requestCount: 1,
          recentRequestCount1h: 0,
          recentRequestCount24h: 1,
          recentByClientTag5m: [],
        },
      }),
    ];

    expect(buildAccountActivitySummary(groups)).toEqual({
      totalRequestCount1h: 15,
      totalRequestCount24h: 40,
      activeAccountCount1h: 2,
      activeAccountCount24h: 3,
      topClientTag5m: {
        clientTag: "openclaw",
        requestCount: 5,
      },
      topAccount1h: {
        sessionId: "acct_alpha_primary",
        title: "alpha@example.com",
        requestCount: 11,
      },
    });
  });
});
