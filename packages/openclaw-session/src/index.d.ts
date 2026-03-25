import { type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { ResolvedSession, SessionSummary } from "@local-ai-gateway/shared";
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
export declare class ImportedCodexAccountStore {
    private readonly profilesPath;
    constructor(profilesPath?: string);
    getProfilesPath(): string;
    listProfiles(): Record<string, RawProfile>;
    upsertOAuthCredentials(credentials: OAuthCredentials, options?: {
        label?: string;
        profileId?: string;
    }): {
        profileId: string;
        profile: RawProfile;
        filePath: string;
    };
    importFromObject(input: unknown): {
        imported: number;
        profileIds: string[];
        filePath: string;
    };
    private saveProfiles;
}
export declare class OpenClawSessionSource {
    private readonly openClawRoot;
    private readonly importedStore?;
    constructor(openClawRoot?: string, importedProfilesPath?: string);
    listSessions(): SessionSummary[];
    resolveSession(sessionId?: string): Promise<ResolvedSession>;
    private collectSessionRecords;
    private getRawProfileForSession;
    private findOpenClawAuthProfileFiles;
    private readProfilesFile;
    private extractAgentId;
    private resolveStatus;
}
export {};
//# sourceMappingURL=index.d.ts.map