import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";
import { DEFAULT_OPENCLAW_ROOT, GatewayError, resolveGatewayPaths, } from "@local-ai-gateway/shared";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRawProfile(value) {
    if (!isRecord(value)) {
        return false;
    }
    const provider = typeof value.provider === "string" ? value.provider : undefined;
    const hasOAuthTokens = typeof value.access === "string" &&
        value.access.length > 0 &&
        typeof value.refresh === "string" &&
        value.refresh.length > 0;
    return provider === "openai-codex" || hasOAuthTokens;
}
function sanitizeProfile(value) {
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
function createNowIso() {
    return new Date().toISOString();
}
function slugSegment(input) {
    const normalized = input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || "account";
}
function createProfileId(profile) {
    const candidate = profile.accountId || profile.label || randomUUID();
    return `openai-codex:${slugSegment(candidate)}`;
}
function buildUniqueProfileId(profile, existing) {
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
function collectProfilesFromUnknown(input) {
    if (!isRecord(input)) {
        return {};
    }
    if (isRecord(input.profiles)) {
        const profiles = {};
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
    const profiles = {};
    for (const [key, value] of Object.entries(input)) {
        if (isRawProfile(value)) {
            profiles[key] = sanitizeProfile(value);
        }
    }
    return profiles;
}
export class ImportedCodexAccountStore {
    profilesPath;
    constructor(profilesPath = resolveGatewayPaths().codexProfilesPath) {
        this.profilesPath = profilesPath;
    }
    getProfilesPath() {
        return this.profilesPath;
    }
    listProfiles() {
        if (!existsSync(this.profilesPath)) {
            return {};
        }
        const parsed = JSON.parse(readFileSync(this.profilesPath, "utf8"));
        return Object.fromEntries(Object.entries(parsed.profiles ?? {}).map(([profileId, profile]) => [profileId, sanitizeProfile(profile)]));
    }
    upsertOAuthCredentials(credentials, options = {}) {
        const current = this.listProfiles();
        const now = createNowIso();
        const nextProfile = sanitizeProfile({
            type: "oauth",
            provider: "openai-codex",
            access: credentials.access,
            refresh: credentials.refresh,
            expires: credentials.expires,
            accountId: credentials.accountId,
            label: options.label,
            importedAt: now,
            updatedAt: now,
        });
        const profileId = options.profileId ?? buildUniqueProfileId(nextProfile, current);
        const existing = current[profileId];
        current[profileId] = {
            ...existing,
            ...nextProfile,
            importedAt: existing?.importedAt ?? now,
            updatedAt: now,
        };
        this.saveProfiles(current);
        return {
            profileId,
            profile: current[profileId],
            filePath: this.profilesPath,
        };
    }
    importFromObject(input) {
        const extracted = collectProfilesFromUnknown(input);
        const current = this.listProfiles();
        const now = createNowIso();
        const profileIds = [];
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
    saveProfiles(profiles) {
        mkdirSync(dirname(this.profilesPath), { recursive: true });
        const payload = {
            updatedAt: createNowIso(),
            profiles,
        };
        writeFileSync(this.profilesPath, `${JSON.stringify(payload, null, 2)}\n`);
    }
}
export class OpenClawSessionSource {
    openClawRoot;
    importedStore;
    constructor(openClawRoot = DEFAULT_OPENCLAW_ROOT, importedProfilesPath) {
        this.openClawRoot = openClawRoot;
        this.importedStore = importedProfilesPath
            ? new ImportedCodexAccountStore(importedProfilesPath)
            : undefined;
    }
    listSessions() {
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
    async resolveSession(sessionId) {
        const sessions = this.listSessions();
        const target = (sessionId ? sessions.find((session) => session.id === sessionId) : undefined) ??
            sessions.find((session) => session.status !== "invalid");
        if (!target) {
            throw new GatewayError(503, "gateway_auth_required", "No usable OpenClaw Codex session was found.");
        }
        const rawProfile = this.getRawProfileForSession(target);
        if (!rawProfile?.access || !rawProfile.refresh || !rawProfile.provider) {
            throw new GatewayError(503, "gateway_auth_required", `Session ${target.id} is missing OAuth credentials.`);
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
            },
        });
        if (!refreshed?.apiKey) {
            throw new GatewayError(503, "gateway_auth_required", `Session ${target.id} could not be refreshed.`);
        }
        if (target.sourceKind === "local-import" && this.importedStore) {
            this.importedStore.upsertOAuthCredentials(refreshed.newCredentials, {
                profileId: target.profileId,
                label: rawProfile.label,
            });
        }
        return {
            ...target,
            expiresAt: typeof refreshed.newCredentials.expires === "number"
                ? refreshed.newCredentials.expires
                : target.expiresAt,
            accountId: typeof refreshed.newCredentials.accountId === "string"
                ? refreshed.newCredentials.accountId
                : target.accountId,
            status: "available",
            apiKey: refreshed.apiKey,
        };
    }
    collectSessionRecords() {
        const records = [];
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
    getRawProfileForSession(session) {
        if (session.sourceKind === "local-import") {
            return this.importedStore?.listProfiles()[session.profileId];
        }
        const rawProfiles = this.readProfilesFile(session.sourcePath).profiles ?? {};
        return rawProfiles[session.profileId];
    }
    findOpenClawAuthProfileFiles() {
        const agentsRoot = join(this.openClawRoot, "agents");
        if (!existsSync(agentsRoot)) {
            return [];
        }
        const files = [];
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
    readProfilesFile(path) {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    extractAgentId(path) {
        const parts = path.split("/");
        const agentIndex = parts.lastIndexOf("agents");
        return agentIndex >= 0 ? (parts[agentIndex + 1] ?? "unknown") : "unknown";
    }
    resolveStatus(profile) {
        if (!profile.access || !profile.refresh) {
            return "invalid";
        }
        if (typeof profile.expires === "number" && profile.expires <= Date.now()) {
            return "expired";
        }
        return "available";
    }
}
//# sourceMappingURL=index.js.map