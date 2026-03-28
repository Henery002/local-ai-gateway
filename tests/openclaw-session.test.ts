import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportedCodexAccountStore, OpenClawSessionSource } from "@local-ai-gateway/openclaw-session";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("openclaw session source", () => {
  it("derives email and plan type from access token claims", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-token-claims-"));
    const importedProfilesPath = join(rootDir, "codex-auth-profiles.json");
    const store = new ImportedCodexAccountStore(importedProfilesPath);
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/profile": {
          email: "token-user@example.com",
        },
        "https://api.openai.com/auth": {
          chatgpt_plan_type: "plus",
        },
      }),
    ).toString("base64url");
    const accessToken = `header.${payload}.signature`;

    const saved = store.upsertOAuthCredentials({
      access: accessToken,
      refresh: "local-refresh-token",
      expires: 4_102_444_800_000,
      accountId: "acct_token_claims",
    });

    const source = new OpenClawSessionSource(
      new URL("./fixtures/openclaw", import.meta.url).pathname,
      importedProfilesPath,
    );

    const derived = source.listSessions().find((session) => session.id === `local-import:${saved.profileId}`);

    expect(derived).toMatchObject({
      email: "token-user@example.com",
      displayName: "token-user@example.com",
      planType: "plus",
    });
  });

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
      sourceLabel: "桌面端 Codex 账号",
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

  it("imports cockpit-style codex exports with metadata snapshots", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-cockpit-"));
    const importedProfilesPath = join(rootDir, "codex-auth-profiles.json");
    const store = new ImportedCodexAccountStore(importedProfilesPath);

    const result = store.importFromObject([
      {
        id: "codex_demo",
        email: "demo@example.com",
        auth_mode: "oauth",
        plan_type: "free",
        account_id: "acct_cockpit",
        tokens: {
          access_token: "cockpit-access-token",
          refresh_token: "cockpit-refresh-token",
        },
        quota: {
          hourly_percentage: 72,
          hourly_reset_time: 1_775_053_648,
          hourly_window_minutes: 10_080,
          hourly_window_present: true,
        },
        usage_updated_at: 1_774_448_847,
      },
    ]);

    const profiles = Object.values(store.listProfiles());
    expect(result.imported).toBe(1);
    expect(profiles[0]).toMatchObject({
      accountId: "acct_cockpit",
      email: "demo@example.com",
      displayName: "demo@example.com",
      planType: "free",
      quota: {
        scope: "hourly",
        percentage: 72,
        resetAt: 1_775_053_648_000,
        windowMinutes: 10_080,
        updatedAt: 1_774_448_847_000,
      },
    });
  });

  it("upserts codex accounts from cockpit all-platform transfer exports", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-transfer-"));
    const importedProfilesPath = join(rootDir, "codex-auth-profiles.json");
    const store = new ImportedCodexAccountStore(importedProfilesPath);

    const firstImport = store.importAccountConfigObject({
      platforms: {
        codex: {
          exported_data: [
            {
              id: "codex_existing",
              email: "demo@example.com",
              auth_mode: "oauth",
              plan_type: "free",
              account_id: "acct_transfer",
              tokens: {
                access_token: "old-access-token",
                refresh_token: "old-refresh-token",
              },
            },
          ],
        },
      },
    });

    const result = store.importAccountConfigObject({
      platforms: {
        codex: {
          exported_data: [
            {
              id: "codex_existing",
              email: "demo@example.com",
              auth_mode: "oauth",
              plan_type: "plus",
              account_id: "acct_transfer",
              tokens: {
                access_token: "new-access-token",
                refresh_token: "new-refresh-token",
              },
              quota: {
                hourly_percentage: 91,
                hourly_reset_time: 1_775_053_648,
                hourly_window_minutes: 300,
                hourly_window_present: true,
              },
              usage_updated_at: 1_774_448_847,
            },
          ],
        },
        openai: {
          exported_data: [
            {
              api_key: "should-not-be-imported",
            },
          ],
        },
      },
    });

    const profiles = store.listProfiles();
    const imported = Object.values(profiles);

    expect(result).toMatchObject({
      imported: 0,
      updated: 1,
    });
    expect(result.profileIds[0]).toBe(firstImport.profileIds[0]);
    expect(Object.keys(profiles)).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      accountId: "acct_transfer",
      email: "demo@example.com",
      planType: "plus",
      access: "new-access-token",
      refresh: "new-refresh-token",
      quota: {
        scope: "hourly",
        percentage: 91,
        resetAt: 1_775_053_648_000,
        windowMinutes: 300,
        updatedAt: 1_774_448_847_000,
      },
    });
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
      sourceLabel: "桌面端 Codex 账号",
      accountId: "acct_fixture",
      status: "available",
    });
  });

  it("refreshes codex usage snapshots and persists imported account metadata", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-refresh-"));
    const importedProfilesPath = join(rootDir, "codex-auth-profiles.json");
    const store = new ImportedCodexAccountStore(importedProfilesPath);
    const saved = store.upsertOAuthCredentials({
      access: "local-access-token",
      refresh: "local-refresh-token",
      expires: 4_102_444_800_000,
      accountId: "acct_live_refresh",
    });

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 12,
              reset_at: 1_775_053_648,
              limit_window_seconds: 18_000,
            },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    ) as typeof fetch;

    const source = new OpenClawSessionSource(
      new URL("./fixtures/openclaw", import.meta.url).pathname,
      importedProfilesPath,
    );

    const summary = await source.refreshUsage(`local-import:${saved.profileId}`);
    const sessions = source.listSessions();
    const refreshed = sessions.find((session) => session.id === `local-import:${saved.profileId}`);
    const persisted = store.listProfiles()[saved.profileId];

    expect(summary).toMatchObject({
      ok: true,
      refreshed: 1,
      failed: 0,
      data: [
        {
          sessionId: `local-import:${saved.profileId}`,
          accountId: "acct_live_refresh",
          planType: "plus",
          quota: {
            scope: "hourly",
            percentage: 88,
            resetAt: 1_775_053_648_000,
            windowMinutes: 300,
          },
        },
      ],
    });
    expect(refreshed).toMatchObject({
      planType: "plus",
      quota: {
        scope: "hourly",
        percentage: 88,
        resetAt: 1_775_053_648_000,
        windowMinutes: 300,
      },
    });
    expect(persisted).toMatchObject({
      planType: "plus",
      quota: {
        scope: "hourly",
        percentage: 88,
        resetAt: 1_775_053_648_000,
        windowMinutes: 300,
      },
    });
  });

  it("deletes imported codex accounts from the local desktop store", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-delete-"));
    const importedProfilesPath = join(rootDir, "codex-auth-profiles.json");
    const store = new ImportedCodexAccountStore(importedProfilesPath);
    const saved = store.upsertOAuthCredentials({
      access: "local-access-token",
      refresh: "local-refresh-token",
      expires: 4_102_444_800_000,
      accountId: "acct_to_delete",
    });
    const source = new OpenClawSessionSource(
      new URL("./fixtures/openclaw", import.meta.url).pathname,
      importedProfilesPath,
    );

    const removed = source.deleteImportedSession(`local-import:${saved.profileId}`);
    const sessions = source.listSessions();

    expect(removed).toMatchObject({
      removed: true,
      profileId: saved.profileId,
    });
    expect(sessions.find((session) => session.id === `local-import:${saved.profileId}`)).toBeUndefined();
  });
});
