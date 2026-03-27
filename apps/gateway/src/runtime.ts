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
  GatewayInferenceAuthPublicSettings,
  GatewayRoutingHitEvent,
  GatewayRoutingObservability,
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
  private readonly routingHits: GatewayRoutingHitEvent[] = [];
  private sessionActivityInsertCount = 0;
  private routingHitInsertCount = 0;

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
    this.restoreTelemetryFromDatabase();
  }

  listSessions(): SessionSummary[] {
    const sessions = this.sessionSource.listSessions();
    const recentBySessionId = this.database.getRecentSessionClientActivity(
      sessions.map((session) => session.id),
      Date.now() - 5 * 60 * 1000,
    );

    return sessions.map((session) => {
      const activity = this.sessionActivity.get(session.id);
      const recent = recentBySessionId.get(session.id);
      if (!activity && !recent) {
        return session;
      }

      return {
        ...session,
        activity: {
          requestCount: activity?.requestCount ?? 0,
          successCount: activity?.successCount ?? 0,
          failureCount: activity?.failureCount ?? 0,
          streamCount: activity?.streamCount ?? 0,
          nonStreamCount: activity?.nonStreamCount ?? 0,
          byClientTag: activity?.byClientTag,
          recentRequestCount5m: recent?.total ?? 0,
          recentByClientTag5m: recent?.byClientTag,
          lastRequestAt: activity?.lastRequestAt,
          lastSuccessAt: activity?.lastSuccessAt,
          lastFailureAt: activity?.lastFailureAt,
          lastError: activity?.lastError,
        },
      };
    });
  }

  recordInferenceResult(input: {
    sessionId: string;
    ok: boolean;
    stream: boolean;
    clientTag?: string;
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
    const normalizedClientTag =
      input.clientTag?.trim().toLowerCase() || "unknown";
    const currentClientTagRows = current.byClientTag ?? [];
    const nextClientTagRows = [...currentClientTagRows];
    const clientTagIndex = nextClientTagRows.findIndex(
      (item) => item.clientTag === normalizedClientTag,
    );
    if (clientTagIndex >= 0) {
      const row = nextClientTagRows[clientTagIndex]!;
      nextClientTagRows[clientTagIndex] = {
        ...row,
        requestCount: row.requestCount + 1,
        successCount: input.ok ? row.successCount + 1 : row.successCount,
        failureCount: input.ok ? row.failureCount : row.failureCount + 1,
        lastRequestAt: happenedAt,
      };
    } else {
      nextClientTagRows.push({
        clientTag: normalizedClientTag,
        requestCount: 1,
        successCount: input.ok ? 1 : 0,
        failureCount: input.ok ? 0 : 1,
        lastRequestAt: happenedAt,
      });
    }
    nextClientTagRows.sort(
      (left, right) =>
        right.requestCount - left.requestCount ||
        (right.lastRequestAt ?? 0) - (left.lastRequestAt ?? 0),
    );

    const next: SessionActivitySnapshot = {
      ...current,
      requestCount: current.requestCount + 1,
      successCount: input.ok ? current.successCount + 1 : current.successCount,
      failureCount: input.ok ? current.failureCount : current.failureCount + 1,
      streamCount: input.stream ? current.streamCount + 1 : current.streamCount,
      nonStreamCount: input.stream
        ? current.nonStreamCount
        : current.nonStreamCount + 1,
      byClientTag: nextClientTagRows.slice(0, 8),
      lastRequestAt: happenedAt,
      lastSuccessAt: input.ok ? happenedAt : current.lastSuccessAt,
      lastFailureAt: input.ok ? current.lastFailureAt : happenedAt,
      lastError: input.ok ? current.lastError : input.errorMessage,
    };

    this.sessionActivity.set(input.sessionId, next);
    this.database.upsertSessionActivity(input.sessionId, next);
    this.database.insertSessionActivityEvent({
      sessionId: input.sessionId,
      timestamp: happenedAt,
      clientTag: normalizedClientTag,
      ok: input.ok,
      stream: input.stream,
    });
    this.sessionActivityInsertCount += 1;
    if (this.sessionActivityInsertCount % 100 === 0) {
      this.database.pruneSessionActivityEvents({
        maxRows: 50_000,
        retainDays: 30,
      });
    }
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
      routingObservability: this.getRoutingObservability(),
      inferenceAuth: this.getInferenceAuthPublicSettings(),
    };
  }

  getInferenceAuthPublicSettings(): GatewayInferenceAuthPublicSettings {
    const settings = this.configStore.getInferenceAuthSettings();
    const mode = settings.mode === "api-key" ? "api-key" : "none";
    const apiKey = settings.apiKey?.trim();
    return {
      mode,
      enabled: mode === "api-key",
      hasApiKey: Boolean(apiKey),
    };
  }

  recordRoutingHit(event: GatewayRoutingHitEvent): void {
    this.routingHits.push(event);
    if (this.routingHits.length > 500) {
      this.routingHits.splice(0, this.routingHits.length - 500);
    }
    this.database.insertRoutingHit(event);
    this.routingHitInsertCount += 1;
    if (this.routingHitInsertCount % 100 === 0) {
      this.database.pruneRoutingHits({
        maxRows: 20_000,
        retainDays: 30,
      });
    }
  }

  resetTelemetry(): void {
    this.sessionActivity.clear();
    this.routingHits.splice(0, this.routingHits.length);
    this.sessionActivityInsertCount = 0;
    this.routingHitInsertCount = 0;
    this.database.clearTelemetry();
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

  private getRoutingObservability(): GatewayRoutingObservability {
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const totalMatched = this.database.countRoutingHitsSince();
    const matchedLast5m = this.database.countRoutingHitsSince(fiveMinutesAgo);
    const matchedLast1h = this.database.countRoutingHitsSince(oneHourAgo);
    const matchedLast24h = this.database.countRoutingHitsSince(oneDayAgo);
    const lastMatchedAt = this.routingHits.at(-1)?.timestamp;

    const byRuleMap = new Map<
      string,
      {
        ruleId: string;
        ruleName: string;
        hits: number;
        lastMatchedAt?: number;
      }
    >();
    const byClientMap = new Map<
      string,
      {
        clientTag: string;
        hits: number;
        lastMatchedAt?: number;
      }
    >();

    for (const item of this.routingHits) {
      const ruleKey = `${item.matchedRuleId}:${item.matchedRuleName}`;
      const rule = byRuleMap.get(ruleKey) ?? {
        ruleId: item.matchedRuleId,
        ruleName: item.matchedRuleName,
        hits: 0,
        lastMatchedAt: undefined,
      };
      rule.hits += 1;
      if (!rule.lastMatchedAt || item.timestamp > rule.lastMatchedAt) {
        rule.lastMatchedAt = item.timestamp;
      }
      byRuleMap.set(ruleKey, rule);

      const clientTag = item.clientTag?.trim() || "未标记客户端";
      const client = byClientMap.get(clientTag) ?? {
        clientTag,
        hits: 0,
        lastMatchedAt: undefined,
      };
      client.hits += 1;
      if (!client.lastMatchedAt || item.timestamp > client.lastMatchedAt) {
        client.lastMatchedAt = item.timestamp;
      }
      byClientMap.set(clientTag, client);
    }

    const byRule = Array.from(byRuleMap.values()).sort(
      (left, right) =>
        right.hits - left.hits ||
        (right.lastMatchedAt ?? 0) - (left.lastMatchedAt ?? 0),
    );
    const byClientTag = Array.from(byClientMap.values()).sort(
      (left, right) =>
        right.hits - left.hits ||
        (right.lastMatchedAt ?? 0) - (left.lastMatchedAt ?? 0),
    );
    const recent = this.routingHits.slice(-12).reverse();

    return {
      totalMatched,
      matchedLast5m,
      matchedLast1h,
      matchedLast24h,
      lastMatchedAt,
      byRule,
      byClientTag,
      recent,
    };
  }

  private restoreTelemetryFromDatabase(): void {
    const validSessionIds = new Set(
      this.sessionSource.listSessions().map((session) => session.id),
    );
    const persistedActivities = this.database.getSessionActivities(2_000);
    for (const item of persistedActivities) {
      if (!validSessionIds.has(item.sessionId)) {
        continue;
      }
      this.sessionActivity.set(item.sessionId, item.snapshot);
    }
    this.database.deleteSessionActivitiesExcept(Array.from(validSessionIds));
    this.database.pruneSessionActivityEvents({
      maxRows: 50_000,
      retainDays: 30,
    });

    this.database.pruneRoutingHits({
      maxRows: 20_000,
      retainDays: 30,
    });
    this.routingHits.push(...this.database.getRecentRoutingHits(500));
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
