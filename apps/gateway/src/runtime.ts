import {
  AppLogger,
  ConfigStore,
  ModelRegistry,
  ProviderRegistry,
  GatewayDatabase,
} from "@local-ai-gateway/core";
import { OpenClawSessionSource } from "@local-ai-gateway/openclaw-session";
import { CodexAdapter } from "@local-ai-gateway/provider-codex";
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_HOST,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_PORT,
  GatewayHealth,
  GatewayPaths,
  DefaultModelSelectionSummary,
  ProviderConfigurationSummary,
  ProviderSummary,
  SessionSource,
  SessionSummary,
  SessionUsageRefreshSummary,
} from "@local-ai-gateway/shared";

import { bootstrapProvidersFromEnvironment } from "./provider-bootstrap.js";

export class GatewayRuntime {
  readonly startedAt = new Date();
  readonly sessionSource: SessionSource;
  readonly providerRegistry: ProviderRegistry;
  readonly providerConfigurations: ProviderConfigurationSummary[];

  constructor(
    readonly paths: GatewayPaths,
    readonly configStore: ConfigStore,
    readonly database: GatewayDatabase,
    readonly logger: AppLogger,
    readonly modelRegistry: ModelRegistry,
    sessionSource?: SessionSource,
    providerRegistry?: ProviderRegistry,
  ) {
    const bootstrapped = bootstrapProvidersFromEnvironment(
      process.env,
      configStore.getProviderSettings(),
    );
    this.providerConfigurations = bootstrapped.configurations;
    this.sessionSource = sessionSource ?? new OpenClawSessionSource(undefined, paths.codexProfilesPath);
    this.providerRegistry =
      providerRegistry ??
      new ProviderRegistry([
        new CodexAdapter(this.sessionSource),
        ...bootstrapped.adapters,
      ]);
  }

  listSessions(): SessionSummary[] {
    const activeSessionId = this.getActiveSessionId();
    return this.sessionSource.listSessions().map((session) =>
      session.id === activeSessionId ? { ...session } : session,
    );
  }

  getActiveSessionId(): string | undefined {
    return this.configStore.load().activeSessionId;
  }

  setActiveSessionId(sessionId: string): void {
    this.configStore.setActiveSession(sessionId);
  }

  async refreshSessionUsage(sessionId?: string): Promise<SessionUsageRefreshSummary> {
    if (typeof this.sessionSource.refreshUsage !== "function") {
      return {
        ok: false,
        refreshed: 0,
        failed: 1,
        data: [],
        errors: [
          {
            sessionId: sessionId ?? "all",
            message: "当前会话源不支持实时额度刷新。",
          },
        ],
      };
    }

    return this.sessionSource.refreshUsage(sessionId);
  }

  getHealth(): GatewayHealth {
    const sessions = this.sessionSource.listSessions();
    const defaultModel = this.modelRegistry.getDefault();
    return {
      ok: true,
      service: APP_NAME,
      version: APP_VERSION,
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      provider: defaultModel.provider,
      defaultModel: defaultModel.alias,
      activeSessionId: this.getActiveSessionId(),
      sessionCount: sessions.length,
      pid: process.pid,
      uptimeMs: Date.now() - this.startedAt.getTime(),
      startedAt: this.startedAt.toISOString(),
      providerConfigurations: this.providerConfigurations,
      defaultSelection: this.getDefaultSelectionSummary(),
    };
  }

  getProviders(): ProviderSummary[] {
    const summaries = this.providerRegistry.buildProviderSummaries(
      this.modelRegistry.list(),
      this.getActiveSessionId(),
    );

    return summaries.map((summary) => ({
      ...summary,
      configuration: this.providerConfigurations.find((item) => item.id === summary.id),
    }));
  }

  getOpenClawSnippet(): Record<string, string> {
    return {
      provider: "openai",
      baseUrl: DEFAULT_OPENAI_BASE_URL,
      model: this.modelRegistry.getDefault().alias,
    };
  }

  getProviderAdapterForModel(alias: string) {
    const model = this.modelRegistry.resolve(alias);
    if (!model) {
      return undefined;
    }

    return {
      model,
      adapter: this.providerRegistry.getAdapterForModel(model),
    };
  }

  private getDefaultSelectionSummary(): DefaultModelSelectionSummary {
    const defaultModel = this.modelRegistry.getDefault();
    const configuredDefaultAlias = process.env.LOCAL_AI_GATEWAY_DEFAULT_MODEL_ALIAS?.trim();
    const savedDefaultAlias = this.configStore.getProviderSettings().defaultModelAlias?.trim();
    const effectiveDefaultAlias = configuredDefaultAlias || savedDefaultAlias;

    if (effectiveDefaultAlias && effectiveDefaultAlias === defaultModel.alias) {
      return {
        alias: defaultModel.alias,
        provider: defaultModel.provider,
        reason: configuredDefaultAlias
          ? "通过 LOCAL_AI_GATEWAY_DEFAULT_MODEL_ALIAS 指定为默认模型"
          : "通过桌面端保存的默认模型设置指定为默认模型",
        overridden: true,
      };
    }

    return {
      alias: defaultModel.alias,
      provider: defaultModel.provider,
      reason: "使用模型注册表首位模型作为默认值",
      overridden: false,
    };
  }
}
