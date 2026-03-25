import { describe, expect, it } from "vitest";

import { buildCodexAccountGroups } from "../apps/desktop/src/account-groups.js";

describe("desktop account grouping", () => {
  it("aggregates OpenClaw sessions by logical account instead of agent count", () => {
    const grouped = buildCodexAccountGroups(
      [
        {
          id: "builder:openai-codex:default",
          profileId: "openai-codex:default",
          accountId: "acct_alpha",
          status: "available",
          expiresAt: 4_102_444_800_000,
          sourceKind: "openclaw",
        },
        {
          id: "ops:openai-codex:default",
          profileId: "openai-codex:default",
          accountId: "acct_alpha",
          status: "available",
          expiresAt: 4_102_444_700_000,
          sourceKind: "openclaw",
        },
        {
          id: "sentry:openai-codex:default",
          profileId: "openai-codex:default",
          accountId: "acct_alpha",
          status: "expired",
          expiresAt: 4_102_444_600_000,
          sourceKind: "openclaw",
        },
        {
          id: "main:openai-codex:default",
          profileId: "openai-codex:default",
          accountId: "acct_beta",
          status: "available",
          expiresAt: 4_102_444_500_000,
          sourceKind: "openclaw",
        },
      ],
      "builder:openai-codex:default",
    );

    expect(grouped.total).toBe(2);
    expect(grouped.openclaw).toBe(2);
    expect(grouped.localImport).toBe(0);
    expect(grouped.groups[0]).toMatchObject({
      displayName: "acct_alpha",
      isActive: true,
      sourceKind: "openclaw",
    });
    expect(grouped.groups[0]?.sessions).toHaveLength(3);
    expect(grouped.groups[1]).toMatchObject({
      displayName: "acct_beta",
      sourceKind: "openclaw",
    });
  });

  it("keeps imported accounts as a separate source even with the same accountId", () => {
    const grouped = buildCodexAccountGroups([
      {
        id: "main:openai-codex:default",
        profileId: "openai-codex:default",
        accountId: "acct_shared",
        status: "available",
        sourceKind: "openclaw",
      },
      {
        id: "local-import:openai-codex:acct_shared",
        profileId: "openai-codex:acct_shared",
        accountId: "acct_shared",
        status: "available",
        sourceKind: "local-import",
      },
    ]);

    expect(grouped.total).toBe(2);
    expect(grouped.openclaw).toBe(1);
    expect(grouped.localImport).toBe(1);
    expect(grouped.groups.map((group) => group.sourceKind).sort()).toEqual([
      "local-import",
      "openclaw",
    ]);
  });
});
