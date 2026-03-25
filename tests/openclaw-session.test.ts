import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ImportedCodexAccountStore, OpenClawSessionSource } from "@local-ai-gateway/openclaw-session";

describe("openclaw session source", () => {
  it("discovers codex sessions from auth profile files", async () => {
    const source = new OpenClawSessionSource(
      new URL("./fixtures/openclaw", import.meta.url).pathname,
    );

    const sessions = source.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "main:openai-codex:default",
      provider: "openai-codex",
      status: "available",
    });

    const resolved = await source.resolveSession("main:openai-codex:default");
    expect(resolved.apiKey).toBe("fixture-access-token");
  });

  it("merges locally imported codex accounts into the session list", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-session-"));
    const importedProfilesPath = join(rootDir, "codex-auth-profiles.json");
    const store = new ImportedCodexAccountStore(importedProfilesPath);
    const saved = store.upsertOAuthCredentials({
      access: "local-access-token",
      refresh: "local-refresh-token",
      expires: 4_102_444_800_000,
      accountId: "acct_local_imported",
    });

    const source = new OpenClawSessionSource(
      new URL("./fixtures/openclaw", import.meta.url).pathname,
      importedProfilesPath,
    );

    const sessions = source.listSessions();
    expect(sessions).toHaveLength(2);

    const localSession = sessions.find((session) => session.profileId === saved.profileId);
    expect(localSession).toMatchObject({
      id: `local-import:${saved.profileId}`,
      sourceKind: "local-import",
      sourceLabel: "本地导入账号",
      accountId: "acct_local_imported",
      status: "available",
    });

    const resolved = await source.resolveSession(`local-import:${saved.profileId}`);
    expect(resolved.apiKey).toBe("local-access-token");
  });

  it("imports codex credentials from common json shapes", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-import-"));
    const importedProfilesPath = join(rootDir, "codex-auth-profiles.json");
    const store = new ImportedCodexAccountStore(importedProfilesPath);

    const result = store.importFromObject({
      profiles: {
        "openai-codex:manual": {
          type: "oauth",
          provider: "openai-codex",
          access: "json-access-token",
          refresh: "json-refresh-token",
          expires: 4_102_444_800_000,
          accountId: "acct_from_json",
        },
      },
    });

    expect(result.imported).toBe(1);
    expect(Object.keys(store.listProfiles())).toHaveLength(1);
  });

  it("can import an OpenClaw session into the desktop local account store", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-copy-"));
    const importedProfilesPath = join(rootDir, "codex-auth-profiles.json");
    const source = new OpenClawSessionSource(
      new URL("./fixtures/openclaw", import.meta.url).pathname,
      importedProfilesPath,
    );

    const copied = source.copySessionToImportedStore("main:openai-codex:default");
    const sessions = source.listSessions();
    const localImported = sessions.find((session) => session.id === `local-import:${copied.profileId}`);

    expect(copied.profile.accountId).toBe("acct_fixture");
    expect(localImported).toMatchObject({
      sourceKind: "local-import",
      accountId: "acct_fixture",
      status: "available",
    });
  });
});
