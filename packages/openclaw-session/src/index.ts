import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getOAuthApiKey, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";

import {
  DEFAULT_OPENCLAW_ROOT,
  GatewayError,
  ResolvedSession,
  SessionQuotaSnapshot,
  SessionUsageRefreshSummary,
  SessionSourceKind,
  SessionStatus,
  SessionSummary,
  resolveGatewayPaths,
} from "@local-ai-gateway/shared";

const SESSION_USAGE_REFRESH_CONCURRENCY = 4;

type CredentialRefreshMode = "managed" | "external-readonly";

interface RawProfile {
  type?: string;
  provider?: string;
  accountId?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  label?: string;
  displayName?: string;
  email?: string;
  planType?: string;
  quota?: SessionQuotaSnapshot;
  credentialRefreshMode?: CredentialRefreshMode;
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

interface CodexUsageWindow {
  used_percent?: unknown;
  reset_at?: unknown;
  limit_window_seconds?: unknown;
}

interface CodexUsagePayload {
  plan_type?: unknown;
  rate_limit?: {
    primary_window?: CodexUsageWindow;
    secondary_window?: CodexUsageWindow;
  };
}

class CodexUsageRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseText?: string,
  ) {
    super(message);
    this.name = "CodexUsageRequestError";
  }
}

interface DecodedAccessTokenClaims {
  email?: string;
  planType?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEpochMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value > 1_000_000_000_000 ? value : value * 1_000;
}

function pickQuotaSnapshot(value: Record<string, unknown>): SessionQuotaSnapshot | undefined {
  const quota = isRecord(value.quota) ? value.quota : undefined;
  if (!quota) {
    return undefined;
  }

  if (
    quota.hourly_window_present === true ||
    typeof quota.hourly_percentage === "number" ||
    typeof quota.hourly_reset_time === "number"
  ) {
    return {
      scope: "hourly",
      percentage: typeof quota.hourly_percentage === "number" ? quota.hourly_percentage : undefined,
      resetAt: normalizeEpochMs(quota.hourly_reset_time),
      windowMinutes:
        typeof quota.hourly_window_minutes === "number" ? quota.hourly_window_minutes : undefined,
      updatedAt: normalizeEpochMs(value.usage_updated_at),
    };
  }

  if (
    quota.weekly_window_present === true ||
    typeof quota.weekly_percentage === "number" ||
    typeof quota.weekly_reset_time === "number"
  ) {
    return {
      scope: "weekly",
      percentage: typeof quota.weekly_percentage === "number" ? quota.weekly_percentage : undefined,
      resetAt: normalizeEpochMs(quota.weekly_reset_time),
      updatedAt: normalizeEpochMs(value.usage_updated_at),
    };
  }

  return undefined;
}

function extractRawProfile(value: unknown): RawProfile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const tokens = isRecord(value.tokens) ? value.tokens : undefined;
  const access =
    typeof value.access === "string"
      ? value.access
      : typeof tokens?.access_token === "string"
        ? tokens.access_token
        : undefined;
  const refresh =
    typeof value.refresh === "string"
      ? value.refresh
      : typeof tokens?.refresh_token === "string"
        ? tokens.refresh_token
        : undefined;
  const provider =
    typeof value.provider === "string"
      ? value.provider
      : access && refresh
        ? "openai-codex"
        : undefined;

  if (provider !== "openai-codex" && !(access && refresh)) {
    return undefined;
  }

  return sanitizeProfile({
    type:
      typeof value.type === "string"
        ? value.type
        : typeof value.auth_mode === "string"
          ? value.auth_mode
          : "oauth",
    provider: "openai-codex",
    accountId:
      typeof value.accountId === "string"
        ? value.accountId
        : typeof value.account_id === "string"
          ? value.account_id
          : undefined,
    access,
    refresh,
    expires: typeof value.expires === "number" ? value.expires : undefined,
    label:
      typeof value.label === "string"
        ? value.label
        : typeof value.email === "string"
          ? value.email
          : typeof value.id === "string"
            ? value.id
            : undefined,
    displayName:
      typeof value.displayName === "string"
        ? value.displayName
        : typeof value.email === "string"
          ? value.email
          : undefined,
    email: typeof value.email === "string" ? value.email : undefined,
    planType:
      typeof value.planType === "string"
        ? value.planType
        : typeof value.plan_type === "string"
          ? value.plan_type
          : undefined,
    quota: pickQuotaSnapshot(value),
    credentialRefreshMode: normalizeCredentialRefreshMode(value.credentialRefreshMode),
    importedAt: typeof value.importedAt === "string" ? value.importedAt : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  });
}

function normalizeCredentialRefreshMode(value: unknown): CredentialRefreshMode | undefined {
  return value === "managed" || value === "external-readonly" ? value : undefined;
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
    displayName: typeof value.displayName === "string" ? value.displayName : undefined,
    email: typeof value.email === "string" ? value.email : undefined,
    planType: typeof value.planType === "string" ? value.planType : undefined,
    quota: value.quota,
    credentialRefreshMode: normalizeCredentialRefreshMode(value.credentialRefreshMode),
    importedAt: typeof value.importedAt === "string" ? value.importedAt : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

function decodeAccessTokenClaims(accessToken?: string): DecodedAccessTokenClaims {
  if (!accessToken) {
    return {};
  }

  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) {
      return {};
    }

    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const authClaim = isRecord(payload["https://api.openai.com/auth"])
      ? payload["https://api.openai.com/auth"]
      : undefined;
    const profileClaim = isRecord(payload["https://api.openai.com/profile"])
      ? payload["https://api.openai.com/profile"]
      : undefined;

    return {
      email:
        typeof profileClaim?.email === "string"
          ? profileClaim.email
          : typeof payload.email === "string"
            ? payload.email
            : undefined,
      planType:
        typeof authClaim?.chatgpt_plan_type === "string"
          ? authClaim.chatgpt_plan_type
          : undefined,
    };
  } catch {
    return {};
  }
}

function createNowIso(): string {
  return new Date().toISOString();
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function buildQuotaSnapshotFromWindow(window: CodexUsageWindow | undefined): SessionQuotaSnapshot | undefined {
  if (!window) {
    return undefined;
  }

  const usedPercent = toFiniteNumber(window.used_percent);
  const resetAt = normalizeEpochMs(window.reset_at);
  const limitWindowSeconds = toFiniteNumber(window.limit_window_seconds);

  if (usedPercent === undefined && resetAt === undefined && limitWindowSeconds === undefined) {
    return undefined;
  }

  return {
    scope: (limitWindowSeconds ?? 0) >= 604_800 ? "weekly" : "hourly",
    percentage: usedPercent === undefined ? undefined : clampPercentage(100 - usedPercent),
    resetAt,
    windowMinutes:
      limitWindowSeconds !== undefined ? Math.max(1, Math.round(limitWindowSeconds / 60)) : undefined,
    updatedAt: Date.now(),
  };
}

async function fetchCodexUsageSnapshot(
  accessToken: string,
  accountId?: string,
): Promise<{ planType?: string; quota?: SessionQuotaSnapshot }> {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  });

  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  }

  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new CodexUsageRequestError(
      `Codex 额度接口请求失败 (${response.status})${text ? `: ${text.slice(0, 160)}` : ""}`,
      response.status,
      text,
    );
  }

  const payload = (await response.json()) as CodexUsagePayload;
  const quota =
    buildQuotaSnapshotFromWindow(payload.rate_limit?.primary_window) ??
    buildQuotaSnapshotFromWindow(payload.rate_limit?.secondary_window);

  return {
    planType: typeof payload.plan_type === "string" ? payload.plan_type : undefined,
    quota,
  };
}

function shouldRetryUsageWithOAuthRefresh(
  profile: RawProfile,
  error: unknown,
): boolean {
  if (!canRefreshOAuthCredentials(profile)) {
    return false;
  }

  if (!profile.refresh) {
    return false;
  }

  if (!profile.access) {
    return true;
  }

  if (error instanceof CodexUsageRequestError) {
    if (error.status === 401) {
      return true;
    }

    if (error.status === 403) {
      const message = `${error.message}\n${error.responseText ?? ""}`.toLowerCase();
      return /(unauthori|expired|invalid|token|session)/.test(message);
    }

    return false;
  }

  return typeof profile.expires === "number" && profile.expires <= Date.now() + 30_000;
}

function canRefreshOAuthCredentials(profile: RawProfile): boolean {
  return profile.credentialRefreshMode === "managed";
}

function mapOAuthRefreshError(sessionId: string, error: unknown): GatewayError {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (
    message.includes("unsupported_country_region_territory") ||
    message.includes("request_forbidden") ||
    message.includes("forbidden")
  ) {
    return new GatewayError(
      503,
      "gateway_auth_required",
      `会话 ${sessionId} 的 OAuth 刷新被上游拒绝（地区或账号限制）。请切换账号或重新授权。`,
    );
  }
  if (message.includes("failed to refresh oauth token")) {
    return new GatewayError(
      503,
      "gateway_auth_required",
      `会话 ${sessionId} 的 OAuth 凭据刷新失败。请重新授权后再试。`,
    );
  }
  return new GatewayError(
    503,
    "gateway_auth_required",
    `会话 ${sessionId} 当前不可用：${error instanceof Error ? error.message : String(error)}`,
  );
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
  if (Array.isArray(input)) {
    const profiles: Record<string, RawProfile> = {};
    for (const item of input) {
      const profile = extractRawProfile(item);
      if (!profile) {
        continue;
      }
      profiles[buildUniqueProfileId(profile, profiles)] = profile;
    }
    return profiles;
  }

  if (!isRecord(input)) {
    return {};
  }

  if (isRecord(input.profiles)) {
    const profiles: Record<string, RawProfile> = {};
    for (const [profileId, value] of Object.entries(input.profiles)) {
      const profile = extractRawProfile(value);
      if (profile) {
        profiles[profileId] = profile;
      }
    }
    return profiles;
  }

  const directProfile = extractRawProfile(input);
  if (directProfile) {
    return {
      [createProfileId(directProfile)]: directProfile,
    };
  }

  const providerProfile = extractRawProfile(input["openai-codex"]);
  if (providerProfile) {
    return {
      [createProfileId(providerProfile)]: providerProfile,
    };
  }

  const profiles: Record<string, RawProfile> = {};
  for (const [key, value] of Object.entries(input)) {
    const profile = extractRawProfile(value);
    if (profile) {
      profiles[key] = profile;
    }
  }
  return profiles;
}

function extractCodexTransferPayload(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const platforms = isRecord(input.platforms) ? input.platforms : undefined;
  const codex = isRecord(platforms?.codex) ? platforms.codex : undefined;
  const exportedData = codex?.exported_data;

  if (Array.isArray(exportedData) || isRecord(exportedData)) {
    return exportedData;
  }

  return input;
}

function normalizeComparableEmail(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function findMatchingProfileId(
  current: Record<string, RawProfile>,
  profile: RawProfile,
): string | undefined {
  if (profile.accountId) {
    const matchedByAccountId = Object.entries(current).find(
      ([, existing]) => existing.accountId === profile.accountId,
    );
    if (matchedByAccountId) {
      return matchedByAccountId[0];
    }
  }

  const email = normalizeComparableEmail(profile.email);
  if (email) {
    const matchedByEmail = Object.entries(current).find(
      ([, existing]) => normalizeComparableEmail(existing.email) === email,
    );
    if (matchedByEmail) {
      return matchedByEmail[0];
    }
  }

  return undefined;
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
    options: {
      label?: string;
      profileId?: string;
      credentialRefreshMode?: CredentialRefreshMode;
    } = {},
  ): { profileId: string; profile: RawProfile; filePath: string } {
    const current = this.listProfiles();
    const now = createNowIso();
    const normalized = sanitizeProfile({
      ...profile,
      type: "oauth",
      provider: "openai-codex",
      label: options.label ?? profile.label,
      credentialRefreshMode:
        options.credentialRefreshMode ??
        profile.credentialRefreshMode ??
        "external-readonly",
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
    options: {
      label?: string;
      profileId?: string;
      credentialRefreshMode?: CredentialRefreshMode;
    } = {},
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
        credentialRefreshMode: options.credentialRefreshMode ?? "managed",
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
        credentialRefreshMode: "external-readonly",
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

  importAccountConfigObject(input: unknown): {
    imported: number;
    updated: number;
    skipped: number;
    profileIds: string[];
    filePath: string;
  } {
    const extracted = collectProfilesFromUnknown(extractCodexTransferPayload(input));
    const current = this.listProfiles();
    const now = createNowIso();
    const profileIds: string[] = [];
    let imported = 0;
    let updated = 0;

    for (const [, profile] of Object.entries(extracted)) {
      const normalized = sanitizeProfile(profile);
      const matchedProfileId = findMatchingProfileId(current, normalized);
      const profileId = matchedProfileId ?? buildUniqueProfileId(normalized, current);
      const existing = current[profileId];

      current[profileId] = {
        ...existing,
        ...normalized,
        credentialRefreshMode: "external-readonly",
        importedAt: existing?.importedAt ?? normalized.importedAt ?? now,
        updatedAt: now,
      };

      profileIds.push(profileId);
      if (existing) {
        updated += 1;
      } else {
        imported += 1;
      }
    }

    if (profileIds.length > 0) {
      this.saveProfiles(current);
    }

    return {
      imported,
      updated,
      skipped: 0,
      profileIds,
      filePath: this.profilesPath,
    };
  }

  updateProfileMetadata(
    profileId: string,
    patch: Pick<RawProfile, "displayName" | "email" | "planType" | "quota">,
  ): { profileId: string; profile: RawProfile; filePath: string } {
    const current = this.listProfiles();
    const existing = current[profileId];
    if (!existing) {
      throw new Error(`未找到桌面端 Codex 账号 ${profileId}。`);
    }

    const now = createNowIso();
    current[profileId] = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      email: patch.email ?? existing.email,
      planType: patch.planType ?? existing.planType,
      quota: patch.quota ?? existing.quota,
      updatedAt: now,
    };

    this.saveProfiles(current);
    return {
      profileId,
      profile: current[profileId] as RawProfile,
      filePath: this.profilesPath,
    };
  }

  deleteProfile(profileId: string): { removed: boolean; filePath: string } {
    const current = this.listProfiles();
    if (!current[profileId]) {
      return {
        removed: false,
        filePath: this.profilesPath,
      };
    }

    delete current[profileId];
    this.saveProfiles(current);
    return {
      removed: true,
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
  private readonly usageCache = new Map<string, Pick<RawProfile, "displayName" | "email" | "planType" | "quota">>();

  constructor(
    private readonly openClawRoot = DEFAULT_OPENCLAW_ROOT,
    importedProfilesPath?: string,
    private readonly oauthApiKeyResolver: typeof getOAuthApiKey = getOAuthApiKey,
  ) {
    this.importedStore = importedProfilesPath
      ? new ImportedCodexAccountStore(importedProfilesPath)
      : undefined;
  }

  listSessions(): SessionSummary[] {
    const records = this.collectSessionRecords();
    const validSessionIds = new Set(records.map((record) => `${record.agentId}:${record.profileId}`));
    for (const sessionId of this.usageCache.keys()) {
      if (!validSessionIds.has(sessionId)) {
        this.usageCache.delete(sessionId);
      }
    }

    return records
      .map((record) => {
        const sessionId = `${record.agentId}:${record.profileId}`;
        const cached = this.usageCache.get(sessionId);
        const decoded = decodeAccessTokenClaims(record.profile.access);
        const profile = {
          ...record.profile,
          displayName: record.profile.displayName ?? record.profile.email ?? decoded.email,
          email: record.profile.email ?? decoded.email,
          planType: record.profile.planType ?? decoded.planType,
          ...cached,
        };

        return {
          id: sessionId,
          agentId: record.agentId,
          profileId: record.profileId,
          provider: profile.provider ?? "unknown",
          type: profile.type ?? "unknown",
          accountId: profile.accountId,
          displayName: profile.displayName,
          email: profile.email,
          planType: profile.planType,
          quota: profile.quota,
          expiresAt: typeof profile.expires === "number" ? profile.expires : undefined,
          status: this.resolveStatus(profile),
          sourceKind: record.sourceKind,
          sourceLabel: record.sourceLabel,
          sourcePath: record.sourcePath,
        };
      })
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
    if (!rawProfile?.access || !rawProfile.provider) {
      throw new GatewayError(
        503,
        "gateway_auth_required",
        `Session ${target.id} is missing OAuth credentials.`,
      );
    }

    const now = Date.now();
    // Some imported profiles intentionally do not persist "expires". In that case we trust the
    // currently cached access token first and only refresh on explicit auth failures downstream.
    if (typeof rawProfile.expires !== "number" || rawProfile.expires > now + 30_000) {
      return {
        ...target,
        apiKey: rawProfile.access,
      };
    }

    if (!rawProfile.refresh) {
      throw new GatewayError(
        503,
        "gateway_auth_required",
        `Session ${target.id} is expired and cannot be refreshed.`,
      );
    }

    if (!canRefreshOAuthCredentials(rawProfile)) {
      throw new GatewayError(
        503,
        "gateway_auth_required",
        `Session ${target.id} is externally managed. Re-import or re-authorize this account after Cockpit refreshes it.`,
      );
    }

    let refreshed: Awaited<ReturnType<typeof getOAuthApiKey>>;
    try {
      refreshed = await this.oauthApiKeyResolver("openai-codex", {
        "openai-codex": {
          type: "oauth",
          provider: "openai-codex",
          access: rawProfile.access,
          refresh: rawProfile.refresh,
          expires: rawProfile.expires ?? now,
          accountId: rawProfile.accountId,
        } as never,
      });
    } catch (error) {
      throw mapOAuthRefreshError(target.id, error);
    }

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
      credentialRefreshMode: "external-readonly",
    });
  }

  deleteImportedSession(sessionId: string): { removed: boolean; profileId: string; filePath: string } {
    if (!this.importedStore) {
      throw new Error("当前未配置桌面端本地账号存储。");
    }

    const target = this.listSessions().find((session) => session.id === sessionId);
    if (!target) {
      throw new Error(`未找到会话 ${sessionId}。`);
    }

    if (target.sourceKind !== "local-import") {
      throw new Error("只有桌面端本地账号支持删除。");
    }

    const result = this.importedStore.deleteProfile(target.profileId);
    this.usageCache.delete(sessionId);
    return {
      removed: result.removed,
      profileId: target.profileId,
      filePath: result.filePath,
    };
  }

  async refreshUsage(sessionId?: string): Promise<SessionUsageRefreshSummary> {
    const sessions = this.listSessions().filter((session) => session.status !== "invalid");
    const targets = sessionId
      ? sessions.filter((session) => session.id === sessionId)
      : sessions;

    if (sessionId && targets.length === 0) {
      throw new Error(`未找到会话 ${sessionId}。`);
    }

    const groups = new Map<string, SessionSummary[]>();
    for (const session of targets) {
      const key = `${session.sourceKind ?? "openclaw"}:${session.accountId ?? session.id}`;
      const existing = groups.get(key);
      if (existing) {
        existing.push(session);
      } else {
        groups.set(key, [session]);
      }
    }

    const data: SessionUsageRefreshSummary["data"] = [];
    const errors: SessionUsageRefreshSummary["errors"] = [];
    let refreshed = 0;

    const groupedSessions = Array.from(groups.values());
    const workerCount = Math.min(SESSION_USAGE_REFRESH_CONCURRENCY, groupedSessions.length || 1);

    await Promise.all(
      Array.from({ length: workerCount }, async (_unused, workerIndex) => {
        for (let index = workerIndex; index < groupedSessions.length; index += workerCount) {
          const sessionsForAccount = groupedSessions[index];
          if (!sessionsForAccount) {
            continue;
          }

          const representative = sessionsForAccount[0];

          try {
            const rawProfile = this.getRawProfileForSession(representative);
            if (!rawProfile?.provider) {
              throw new Error(`会话 ${representative.id} 缺少有效的 Provider 配置。`);
            }

            let refreshedCredentials: OAuthCredentials | undefined;
            let snapshot: Awaited<ReturnType<typeof fetchCodexUsageSnapshot>> | undefined;
            let lastError: unknown;

            if (typeof rawProfile.access === "string" && rawProfile.access) {
              try {
                snapshot = await fetchCodexUsageSnapshot(
                  rawProfile.access,
                  rawProfile.accountId ?? representative.accountId,
                );
              } catch (error) {
                lastError = error;
              }
            }

            if (!snapshot && shouldRetryUsageWithOAuthRefresh(rawProfile, lastError)) {
              const refreshed = await this.oauthApiKeyResolver("openai-codex", {
                "openai-codex": {
                  type: "oauth",
                  provider: "openai-codex",
                  access: rawProfile.access,
                  refresh: rawProfile.refresh,
                  expires: rawProfile.expires ?? Date.now(),
                  accountId: rawProfile.accountId,
                } as never,
              });

              if (!refreshed?.apiKey) {
                throw new Error(
                  `会话 ${representative.id} 的 OAuth 凭据刷新失败。`,
                );
              }

              refreshedCredentials = refreshed.newCredentials;
              snapshot = await fetchCodexUsageSnapshot(
                refreshed.apiKey,
                rawProfile.accountId ?? representative.accountId,
              );
            }

            if (!snapshot) {
              throw (lastError instanceof Error
                ? lastError
                : new Error(`会话 ${representative.id} 的额度同步失败。`));
            }

            const patch = {
              displayName: representative.displayName ?? representative.email,
              email: representative.email,
              planType: snapshot.planType ?? representative.planType,
              quota: snapshot.quota ?? representative.quota,
            } satisfies Pick<RawProfile, "displayName" | "email" | "planType" | "quota">;

            for (const session of sessionsForAccount) {
              this.usageCache.set(session.id, patch);
              if (session.sourceKind === "local-import" && this.importedStore) {
                if (refreshedCredentials) {
                  this.importedStore.upsertOAuthCredentials(refreshedCredentials, {
                    profileId: session.profileId,
                    label: rawProfile.label,
                  });
                }
                this.importedStore.updateProfileMetadata(session.profileId, patch);
              }

              data.push({
                sessionId: session.id,
                accountId: session.accountId,
                sourceKind: session.sourceKind,
                planType: patch.planType,
                quota: patch.quota,
              });
              refreshed += 1;
            }
          } catch (error) {
            errors.push({
              sessionId: representative.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }),
    );

    return {
      ok: errors.length === 0,
      refreshed,
      failed: errors.length,
      data,
      errors,
    };
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
          sourceLabel: "OpenClaw 可复用授权",
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
          sourceLabel: "桌面端 Codex 账号",
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
