import { describe, expect, it } from "vitest";

import type { CodexAccountGroup } from "../apps/desktop/src/account-groups.js";
import {
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
});
