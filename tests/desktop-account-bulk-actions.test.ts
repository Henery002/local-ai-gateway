import { describe, expect, it } from "vitest";

import {
  collectAccountDeletionTargets,
  normalizeAccountSelection,
  pruneDeletedAccountPoolMembers,
} from "../apps/desktop/src/account-bulk-actions.js";

describe("desktop account bulk actions", () => {
  it("collects all local session identifiers from selected account cards", () => {
    const accounts = [
      {
        key: "local-import:acct-a",
        sessions: [
          {
            id: "local-import:profile-a",
            profileId: "profile-a",
            accountId: "acct-a",
          },
        ],
      },
      {
        key: "local-import:acct-b",
        sessions: [
          {
            id: "local-import:profile-b-1",
            profileId: "profile-b-1",
            accountId: "acct-b",
          },
          {
            id: "local-import:profile-b-2",
            profileId: "profile-b-2",
            accountId: "acct-b",
          },
        ],
      },
    ];

    const selectedKeys = normalizeAccountSelection(accounts, [
      "local-import:acct-b",
      "stale-key",
    ]);
    const targets = collectAccountDeletionTargets(accounts, selectedKeys);

    expect([...selectedKeys]).toEqual(["local-import:acct-b"]);
    expect(targets).toEqual([
      {
        sessionId: "local-import:profile-b-1",
        profileId: "profile-b-1",
        accountId: "acct-b",
      },
      {
        sessionId: "local-import:profile-b-2",
        profileId: "profile-b-2",
        accountId: "acct-b",
      },
    ]);
  });

  it("removes deleted account references from existing pool members", () => {
    const settings = {
      enabled: true,
      pools: [
        {
          id: "pool-openclaw",
          name: "OpenClaw",
          members: [
            { selector: "acct-a", priority: 10 },
            { selector: "acct-b", priority: 20 },
            { selector: "profile-b", priority: 30 },
            { selector: "local-import:profile-c", priority: 40 },
          ],
        },
        {
          id: "pool-hermes",
          name: "Hermes",
          members: [
            { selector: "local-import:profile-b", priority: 10 },
            { selector: "acct-d", priority: 20 },
          ],
        },
      ],
    };

    const result = pruneDeletedAccountPoolMembers(settings, [
      {
        sessionId: "local-import:profile-b",
        profileId: "profile-b",
        accountId: "acct-b",
      },
    ]);

    expect(result.removedMemberCount).toBe(3);
    expect(result.affectedPoolIds).toEqual(["pool-openclaw", "pool-hermes"]);
    expect(result.settings.pools?.[0]?.members).toEqual([
      { selector: "acct-a", priority: 10 },
      { selector: "local-import:profile-c", priority: 40 },
    ]);
    expect(result.settings.pools?.[1]?.members).toEqual([
      { selector: "acct-d", priority: 20 },
    ]);
  });
});
