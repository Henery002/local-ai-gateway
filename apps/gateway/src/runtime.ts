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
  DEFAULT_PORT,
  GatewayHealth,
  GatewayPaths,
  DefaultModelSelectionSummary,
  GatewayRoutingPreviewInput,
  GatewayRoutingPreviewResult,
  GatewayRoutingRule,
  GatewayRoutingSettings,
  ProviderConfigurationSummary,
  ProviderSummary,
  SessionActivitySnapshot,
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
  private readonly sessionActivity = new Map<string, SessionActivitySnapshot>();

  constructor(
    readonly paths: GatewayPaths,
    readonly configStore: ConfigStore,
    readonly database: GatewayDatabase,
    readonly logger: AppLogger,
    readonly modelRegistry: ModelRegistry,
    sessionSource?: SessionSource,
    providerRegistry?: ProviderRegistry,
    readonly serverHost = DEFAULT_HOST,
    readonly serverPort = DEFAULT_PORT,
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
    return this.sessionSource.listSessions().map((session) => ({
      ...session,
      activity: this.sessionActivity.get(session.id),
    }));
  }

  recordInferenceResult(input: {
    sessionId: string;
    ok: boolean;
    stream: boolean;
    errorMessage?: string;
    happenedAt?: number;
  }): void {
    const happenedAt = input.happenedAt ?? Date.now();
    const current = this.sessionActivity.get(input.sessionId) ?? {
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      streamCount: 0,
      nonStreamCount: 0,
    };

    const next: SessionActivitySnapshot = {
      ...current,
      requestCount: current.requestCount + 1,
      successCount: input.ok ? current.successCount + 1 : current.successCount,
      failureCount: input.ok ? current.failureCount : current.failureCount + 1,
      streamCount: input.stream ? current.streamCount + 1 : current.streamCount,
      nonStreamCount: input.stream
        ? current.nonStreamCount
        : current.nonStreamCount + 1,
      lastRequestAt: happenedAt,
      lastSuccessAt: input.ok ? happenedAt : current.lastSuccessAt,
      lastFailureAt: input.ok ? current.lastFailureAt : happenedAt,
      lastError: input.ok ? current.lastError : input.errorMessage,
    };

    this.sessionActivity.set(input.sessionId, next);
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
      host: this.serverHost,
      port: this.serverPort,
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
      baseUrl: `http://${this.serverHost}:${this.serverPort}/v1`,
      model: this.modelRegistry.getDefault().alias,
    };
  }

  getRoutingSettings(): GatewayRoutingSettings {
    return this.configStore.getRoutingSettings();
  }

  previewRouting(input: GatewayRoutingPreviewInput = {}): GatewayRoutingPreviewResult {
    const baseModelAlias = input.currentModelAlias ?? this.modelRegistry.getDefault().alias;
    const baseSessionId = input.currentSessionId ?? this.getActiveSessionId();
    const settings = this.configStore.getRoutingSettings();
    const warnings: string[] = [];

    if (!settings.enabled) {
      return {
        enabled: false,
        resolvedModelAlias: baseModelAlias,
        resolvedSessionId: baseSessionId,
        reason: "routing_disabled",
        warnings,
      };
    }

    const rules = [...(settings.rules ?? [])]
      .filter((rule) => rule && rule.enabled !== false)
      .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000));
    const matched = rules.find((rule) => this.matchRoutingRule(rule, input));

    if (!matched) {
      return {
        enabled: true,
        resolvedModelAlias: baseModelAlias,
        resolvedSessionId: baseSessionId,
        reason: "no_rule_matched",
        warnings,
      };
    }

    const resolvedModelAlias = matched.target?.modelAlias ?? baseModelAlias;
    const resolvedSessionId = matched.target?.sessionId ?? baseSessionId;

    if (!this.modelRegistry.resolve(resolvedModelAlias)) {
      warnings.push(`模型别名 ${resolvedModelAlias} 未在当前模型注册表中找到。`);
    }

    if (resolvedSessionId) {
      const hasSession = this.listSessions().some((session) => session.id === resolvedSessionId);
      if (!hasSession) {
        warnings.push(`会话 ${resolvedSessionId} 未在当前本地会话列表中找到。`);
      }
    }

    return {
      enabled: true,
      matchedRuleId: matched.id,
      matchedRuleName: matched.name,
      resolvedModelAlias,
      resolvedSessionId,
      reason: "rule_matched",
      warnings,
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

  private matchRoutingRule(
    rule: GatewayRoutingRule,
    input: GatewayRoutingPreviewInput,
  ): boolean {
    const condition = rule.when ?? {};

    if (condition.clientTag) {
      const expected = condition.clientTag.trim().toLowerCase();
      const actual = (input.clientTag ?? "").trim().toLowerCase();
      if (!actual || actual !== expected) {
        return false;
      }
    }

    if (condition.requestedModelAlias) {
      const expected = condition.requestedModelAlias.trim();
      const actual = input.requestedModelAlias?.trim();
      if (!actual || actual !== expected) {
        return false;
      }
    }

    return true;
  }
}
