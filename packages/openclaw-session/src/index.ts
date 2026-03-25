import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getOAuthApiKey, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";

import {
  DEFAULT_OPENCLAW_ROOT,
  GatewayError,
  ResolvedSession,
  SessionSourceKind,
  SessionStatus,
  SessionSummary,
  resolveGatewayPaths,
} from "@local-ai-gateway/shared";

interface RawProfile {
  type?: string;
  provider?: string;
  accountId?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  label?: string;
  importedAt?: string;
  updatedAt?: string;
}

interface RawProfilesFile {
  profiles?: Record<string, RawProfile>;
  updatedAt?: string;
}

interface SessionRecord {
  sourceKind: SessionSourceKind;
  sourceLabel: string;
  sourcePath: string;
  agentId: string;
  profileId: string;
  profile: RawProfile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRawProfile(value: unknown): value is RawProfile {
  if (!isRecord(value)) {
    return false;
  }

  const provider = typeof value.provider === "string" ? value.provider : undefined;
  const hasOAuthTokens =
    typeof value.access === "string" &&
    value.access.length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.length > 0;

  return provider === "openai-codex" || hasOAuthTokens;
}

function sanitizeProfile(value: RawProfile): RawProfile {
  return {
    type: typeof value.type === "string" ? value.type : "oauth",
    provider: "openai-codex",
    accountId: typeof value.accountId === "string" ? value.accountId : undefined,
    access: typeof value.access === "string" ? value.access : undefined,
    refresh: typeof value.refresh === "string" ? value.refresh : undefined,
    expires: typeof value.expires === "number" ? value.expires : undefined,
    label: typeof value.label === "string" ? value.label : undefined,
    importedAt: typeof value.importedAt === "string" ? value.importedAt : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

function createNowIso(): string {
  return new Date().toISOString();
}

function slugSegment(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "account";
}

function createProfileId(profile: RawProfile): string {
  const candidate = profile.accountId || profile.label || randomUUID();
  return `openai-codex:${slugSegment(candidate)}`;
}

function buildUniqueProfileId(profile: RawProfile, existing: Record<string, RawProfile>): string {
  const baseId = createProfileId(profile);
  if (!existing[baseId]) {
    return baseId;
  }

  let suffix = 2;
  while (existing[`${baseId}-${suffix}`]) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

function collectProfilesFromUnknown(input: unknown): Record<string, RawProfile> {
  if (!isRecord(input)) {
    return {};
  }

  if (isRecord(input.profiles)) {
    const profiles: Record<string, RawProfile> = {};
    for (const [profileId, value] of Object.entries(input.profiles)) {
      if (isRawProfile(value)) {
        profiles[profileId] = sanitizeProfile(value);
      }
    }
    return profiles;
  }

  if (isRawProfile(input)) {
    const profile = sanitizeProfile(input);
    return {
      [createProfileId(profile)]: profile,
    };
  }

  if (isRawProfile(input["openai-codex"])) {
    const profile = sanitizeProfile(input["openai-codex"]);
    return {
      [createProfileId(profile)]: profile,
    };
  }

  const profiles: Record<string, RawProfile> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isRawProfile(value)) {
      profiles[key] = sanitizeProfile(value);
    }
  }
  return profiles;
}

export class ImportedCodexAccountStore {
  constructor(private readonly profilesPath = resolveGatewayPaths().codexProfilesPath) {}

  getProfilesPath(): string {
    return this.profilesPath;
  }

  listProfiles(): Record<string, RawProfile> {
    if (!existsSync(this.profilesPath)) {
      return {};
    }

    const parsed = JSON.parse(readFileSync(this.profilesPath, "utf8")) as RawProfilesFile;
    return Object.fromEntries(
      Object.entries(parsed.profiles ?? {}).map(([profileId, profile]) => [profileId, sanitizeProfile(profile)]),
    );
  }

  importOAuthProfile(
    profile: RawProfile,
    options: { label?: string; profileId?: string } = {},
  ): { profileId: string; profile: RawProfile; filePath: string } {
    const current = this.listProfiles();
    const now = createNowIso();
    const normalized = sanitizeProfile({
      ...profile,
      type: "oauth",
      provider: "openai-codex",
      label: options.label ?? profile.label,
      importedAt: profile.importedAt ?? now,
      updatedAt: now,
    });
    const profileId = options.profileId ?? buildUniqueProfileId(normalized, current);
    const existing = current[profileId];

    current[profileId] = {
      ...existing,
      ...normalized,
      importedAt: existing?.importedAt ?? normalized.importedAt ?? now,
      updatedAt: now,
    };

    this.saveProfiles(current);
    return {
      profileId,
      profile: current[profileId] as RawProfile,
      filePath: this.profilesPath,
    };
  }

  upsertOAuthCredentials(
    credentials: OAuthCredentials,
    options: { label?: string; profileId?: string } = {},
  ): { profileId: string; profile: RawProfile; filePath: string } {
    return this.importOAuthProfile(
      {
        type: "oauth",
        provider: "openai-codex",
        access: credentials.access,
        refresh: credentials.refresh,
        expires: credentials.expires,
        accountId: typeof credentials.accountId === "string" ? credentials.accountId : undefined,
        label: options.label,
      },
      options,
    );
  }

  importFromObject(input: unknown): { imported: number; profileIds: string[]; filePath: string } {
    const extracted = collectProfilesFromUnknown(input);
    const current = this.listProfiles();
    const now = createNowIso();
    const profileIds: string[] = [];

    for (const [, profile] of Object.entries(extracted)) {
      const normalized = sanitizeProfile(profile);
      const profileId = buildUniqueProfileId(normalized, current);
      current[profileId] = {
        ...normalized,
        importedAt: normalized.importedAt ?? now,
        updatedAt: now,
      };
      profileIds.push(profileId);
    }

    if (profileIds.length > 0) {
      this.saveProfiles(current);
    }

    return {
      imported: profileIds.length,
      profileIds,
      filePath: this.profilesPath,
    };
  }

  private saveProfiles(profiles: Record<string, RawProfile>): void {
    mkdirSync(dirname(this.profilesPath), { recursive: true });
    const payload: RawProfilesFile = {
      updatedAt: createNowIso(),
      profiles,
    };
    writeFileSync(this.profilesPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

export class OpenClawSessionSource {
  private readonly importedStore?: ImportedCodexAccountStore;

  constructor(
    private readonly openClawRoot = DEFAULT_OPENCLAW_ROOT,
    importedProfilesPath?: string,
  ) {
    this.importedStore = importedProfilesPath
      ? new ImportedCodexAccountStore(importedProfilesPath)
      : undefined;
  }

  listSessions(): SessionSummary[] {
    const records = this.collectSessionRecords();

    return records
      .map((record) => ({
        id: `${record.agentId}:${record.profileId}`,
        agentId: record.agentId,
        profileId: record.profileId,
        provider: record.profile.provider ?? "unknown",
        type: record.profile.type ?? "unknown",
        accountId: record.profile.accountId,
        expiresAt: typeof record.profile.expires === "number" ? record.profile.expires : undefined,
        status: this.resolveStatus(record.profile),
        sourceKind: record.sourceKind,
        sourceLabel: record.sourceLabel,
        sourcePath: record.sourcePath,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async resolveSession(sessionId?: string): Promise<ResolvedSession> {
    const sessions = this.listSessions();
    const target =
      (sessionId ? sessions.find((session) => session.id === sessionId) : undefined) ??
      sessions.find((session) => session.status !== "invalid");

    if (!target) {
      throw new GatewayError(
        503,
        "gateway_auth_required",
        "No usable OpenClaw Codex session was found.",
      );
    }

    const rawProfile = this.getRawProfileForSession(target);
    if (!rawProfile?.access || !rawProfile.refresh || !rawProfile.provider) {
      throw new GatewayError(
        503,
        "gateway_auth_required",
        `Session ${target.id} is missing OAuth credentials.`,
      );
    }

    const now = Date.now();
    if (typeof rawProfile.expires === "number" && rawProfile.expires > now + 30_000) {
      return {
        ...target,
        apiKey: rawProfile.access,
      };
    }

    const refreshed = await getOAuthApiKey("openai-codex", {
      "openai-codex": {
        type: "oauth",
        provider: "openai-codex",
        access: rawProfile.access,
        refresh: rawProfile.refresh,
        expires: rawProfile.expires ?? now,
        accountId: rawProfile.accountId,
      } as never,
    });

    if (!refreshed?.apiKey) {
      throw new GatewayError(
        503,
        "gateway_auth_required",
        `Session ${target.id} could not be refreshed.`,
      );
    }

    if (target.sourceKind === "local-import" && this.importedStore) {
      this.importedStore.upsertOAuthCredentials(refreshed.newCredentials, {
        profileId: target.profileId,
        label: rawProfile.label,
      });
    }

    return {
      ...target,
      expiresAt:
        typeof refreshed.newCredentials.expires === "number"
          ? refreshed.newCredentials.expires
          : target.expiresAt,
      accountId:
        typeof refreshed.newCredentials.accountId === "string"
          ? refreshed.newCredentials.accountId
          : target.accountId,
      status: "available",
      apiKey: refreshed.apiKey,
    };
  }

  copySessionToImportedStore(
    sessionId: string,
    options: { label?: string } = {},
  ): { profileId: string; profile: RawProfile; filePath: string } {
    if (!this.importedStore) {
      throw new Error("当前未配置桌面端本地账号存储。");
    }

    const target = this.listSessions().find((session) => session.id === sessionId);
    if (!target) {
      throw new Error(`未找到会话 ${sessionId}。`);
    }

    if (target.sourceKind === "local-import") {
      throw new Error("该会话已经是桌面端本地账号，无需重复导入。");
    }

    const rawProfile = this.getRawProfileForSession(target);
    if (!rawProfile?.access || !rawProfile.refresh) {
      throw new Error("目标 OpenClaw 会话缺少可复用的 OAuth 凭据。");
    }

    return this.importedStore.importOAuthProfile(rawProfile, {
      label: options.label ?? rawProfile.label ?? target.accountId ?? "从 OpenClaw 导入的 Codex 账号",
    });
  }

  private collectSessionRecords(): SessionRecord[] {
    const records: SessionRecord[] = [];

    for (const authFile of this.findOpenClawAuthProfileFiles()) {
      const agentId = this.extractAgentId(authFile);
      const parsed = this.readProfilesFile(authFile);
      const profiles = parsed.profiles ?? {};

      for (const [profileId, profile] of Object.entries(profiles)) {
        if (profile.provider !== "openai-codex") {
          continue;
        }

        records.push({
          sourceKind: "openclaw",
          sourceLabel: "OpenClaw 会话",
          sourcePath: authFile,
          agentId,
          profileId,
          profile,
        });
      }
    }

    if (this.importedStore) {
      const importedProfiles = this.importedStore.listProfiles();
      for (const [profileId, profile] of Object.entries(importedProfiles)) {
        if (profile.provider !== "openai-codex") {
          continue;
        }

        records.push({
          sourceKind: "local-import",
          sourceLabel: "本地导入账号",
          sourcePath: this.importedStore.getProfilesPath(),
          agentId: "local-import",
          profileId,
          profile,
        });
      }
    }

    return records;
  }

  private getRawProfileForSession(session: SessionSummary): RawProfile | undefined {
    if (session.sourceKind === "local-import") {
      return this.importedStore?.listProfiles()[session.profileId];
    }

    const rawProfiles = this.readProfilesFile(session.sourcePath).profiles ?? {};
    return rawProfiles[session.profileId];
  }

  private findOpenClawAuthProfileFiles(): string[] {
    const agentsRoot = join(this.openClawRoot, "agents");
    if (!existsSync(agentsRoot)) {
      return [];
    }

    const files: string[] = [];
    for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const authFile = join(agentsRoot, entry.name, "agent", "auth-profiles.json");
      if (existsSync(authFile)) {
        files.push(authFile);
      }
    }

    return files;
  }

  private readProfilesFile(path: string): RawProfilesFile {
    return JSON.parse(readFileSync(path, "utf8")) as RawProfilesFile;
  }

  private extractAgentId(path: string): string {
    const parts = path.split("/");
    const agentIndex = parts.lastIndexOf("agents");
    return agentIndex >= 0 ? (parts[agentIndex + 1] ?? "unknown") : "unknown";
  }

  private resolveStatus(profile: RawProfile): SessionStatus {
    if (!profile.access || !profile.refresh) {
      return "invalid";
    }

    if (typeof profile.expires === "number" && profile.expires <= Date.now()) {
      return "expired";
    }

    return "available";
  }
}
