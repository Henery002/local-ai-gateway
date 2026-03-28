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
  GatewayPoolFailureClass,
  GatewayPoolMemberObservability,
  GatewayPoolObservability,
  GatewayPoolRejectedCandidate,
  GatewayPoolSelectionEvent,
  GatewayRoutingHitEvent,
  GatewayRoutingObservability,
  GatewayRoutingDispatchMode,
  GatewayPaths,
  DefaultModelSelectionSummary,
  GatewayRoutingPreviewInput,
  GatewayRoutingPreviewResult,
  GatewayRoutingRule,
  GatewayRoutingSettings,
  GatewaySessionPoolDefinition,
  GatewaySessionPoolMember,
  GatewaySessionPoolSettings,
  ProviderConfigurationSummary,
  ProviderSummary,
  SessionActivitySnapshot,
  SessionSource,
  SessionSummary,
  SessionUsageRefreshSummary,
} from "@local-ai-gateway/shared";

import { bootstrapProvidersFromEnvironment } from "./provider-bootstrap.js";

type PoolMemberRuntimeState = {
  cooldownUntil?: number;
  lastFailureClass?: GatewayPoolFailureClass;
  consecutiveFailures: number;
  lastSelectedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
};

type PoolCandidate = {
  selector: string;
  label?: string;
  priority: number;
  session: SessionSummary;
  runtimeState: PoolMemberRuntimeState;
};

type PoolSelectionResult = {
  poolId: string;
  poolName: string;
  selectedSessionId?: string;
  selectedSelector?: string;
  selectionReason?: string;
  candidateCount: number;
  rejectedCandidates: GatewayPoolRejectedCandidate[];
  warnings: string[];
};

export class GatewayRuntime {
  readonly startedAt = new Date();
  readonly sessionSource: SessionSource;
  readonly providerRegistry: ProviderRegistry;
  readonly providerConfigurations: ProviderConfigurationSummary[];
  private readonly sessionActivity = new Map<string, SessionActivitySnapshot>();
  private readonly routingHits: GatewayRoutingHitEvent[] = [];
  private readonly poolSelectionEvents: GatewayPoolSelectionEvent[] = [];
  private readonly poolMemberState = new Map<string, PoolMemberRuntimeState>();
  private sessionActivityInsertCount = 0;
  private routingHitInsertCount = 0;
  private poolSelectionInsertCount = 0;

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
    const recentBySessionId5m = this.database.getRecentSessionClientActivity(
      sessions.map((session) => session.id),
      Date.now() - 5 * 60 * 1000,
    );
    const recentBySessionId1h = this.database.getRecentSessionClientActivity(
      sessions.map((session) => session.id),
      Date.now() - 60 * 60 * 1000,
    );
    const recentBySessionId24h = this.database.getRecentSessionClientActivity(
      sessions.map((session) => session.id),
      Date.now() - 24 * 60 * 60 * 1000,
    );

    return sessions.map((session) => {
      const activity = this.sessionActivity.get(session.id);
      const recent5m = recentBySessionId5m.get(session.id);
      const recent1h = recentBySessionId1h.get(session.id);
      const recent24h = recentBySessionId24h.get(session.id);
      if (!activity && !recent5m && !recent1h && !recent24h) {
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
          recentRequestCount5m: recent5m?.total ?? 0,
          recentByClientTag5m: recent5m?.byClientTag,
          recentRequestCount1h: recent1h?.total ?? 0,
          recentByClientTag1h: recent1h?.byClientTag,
          recentRequestCount24h: recent24h?.total ?? 0,
          recentByClientTag24h: recent24h?.byClientTag,
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
      poolObservability: this.getPoolObservability(),
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
    this.poolSelectionEvents.splice(0, this.poolSelectionEvents.length);
    this.sessionActivityInsertCount = 0;
    this.routingHitInsertCount = 0;
    this.poolSelectionInsertCount = 0;
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

  getPoolSettings(): GatewaySessionPoolSettings {
    return this.configStore.getPoolSettings();
  }

  resolveFallbackSessionId(input: {
    failedSessionId?: string;
    preferredSessionId?: string;
  }): { sessionId?: string; reason?: "preferred-session" | "best-available-session" } {
    const failedSessionId = input.failedSessionId?.trim();
    const preferredSessionId = input.preferredSessionId?.trim();
    const candidates = this.listSessions().filter(
      (session) =>
        session.id !== failedSessionId && session.status !== "invalid",
    );

    if (candidates.length === 0) {
      return {};
    }

    if (preferredSessionId) {
      const preferred = candidates.find(
        (session) => session.id === preferredSessionId,
      );
      if (preferred) {
        return {
          sessionId: preferred.id,
          reason: "preferred-session",
        };
      }
    }

    const chosen = this.pickPreferredRoutingSession(candidates);
    if (!chosen) {
      return {};
    }

    return {
      sessionId: chosen.id,
      reason: "best-available-session",
    };
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
    let resolvedSessionId = baseSessionId;
    let resolvedPoolId: string | undefined;
    let selectionReason: string | undefined;
    let candidateCount: number | undefined;
    let rejectedCandidates: GatewayPoolRejectedCandidate[] | undefined;
    const dispatchMode = this.getEffectiveDispatchMode(matched.target);

    if (dispatchMode === "dynamic-pool" && matched.target?.poolId?.trim()) {
      const selection = this.selectSessionFromPool({
        poolId: matched.target.poolId.trim(),
        currentSessionId: baseSessionId,
        preview: true,
      });
      resolvedPoolId = selection.poolId;
      resolvedSessionId = selection.selectedSessionId ?? baseSessionId;
      selectionReason = selection.selectionReason;
      candidateCount = selection.candidateCount;
      rejectedCandidates = selection.rejectedCandidates;
      warnings.push(...selection.warnings);
      if (!selection.selectedSessionId) {
        warnings.push(`号池 ${selection.poolName} 当前未解析到可用账号。`);
      }
    } else {
      const sessionResolution = this.resolveRoutingSessionSelector(
        matched.target?.sessionId,
        baseSessionId,
      );
      resolvedSessionId = sessionResolution.sessionId;

      if (sessionResolution.warning) {
        warnings.push(sessionResolution.warning);
      }
    }

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
      resolvedPoolId,
      reason: "rule_matched",
      warnings,
      selectionReason,
      candidateCount,
      rejectedCandidates,
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

  private getPoolObservability(): GatewayPoolObservability[] {
    const settings = this.getPoolSettings();
    const sessions = this.listSessions();
    const activeSessionId = this.getActiveSessionId();

    return (settings.pools ?? []).map((pool) => {
      const selection =
        settings.enabled && pool.enabled !== false
          ? this.selectSessionFromPool({
              poolId: pool.id,
              currentSessionId: activeSessionId,
              preview: true,
            })
          : {
              poolId: pool.id,
              poolName: pool.name,
              candidateCount: 0,
              rejectedCandidates: [],
              warnings:
                settings.enabled && pool.enabled === false
                  ? ["当前号池已被禁用。"]
                  : ["动态号池总开关当前未启用。"],
            };

      const members = (pool.members ?? []).map((member) =>
        this.buildPoolMemberObservability({
          pool,
          member,
          sessions,
          selectedSessionId: selection.selectedSessionId,
          selectedSelector: selection.selectedSelector,
        }),
      );

      return {
        poolId: pool.id,
        poolName: pool.name,
        enabled: settings.enabled !== false && pool.enabled !== false,
        selectionStrategy: pool.selectionStrategy,
        selectedSessionId: selection.selectedSessionId,
        selectedSelector: selection.selectedSelector,
        selectionReason: selection.selectionReason,
        memberCount: members.length,
        eligibleMemberCount: members.filter((member) => member.eligible).length,
        coolingMemberCount: members.filter((member) => member.status === "cooldown")
          .length,
        lastSelectedAt: members.reduce<number | undefined>(
          (latest, member) =>
            !member.lastSelectedAt || (latest && latest > member.lastSelectedAt)
              ? latest
              : member.lastSelectedAt,
          undefined,
        ),
        lastFailureAt: members.reduce<number | undefined>(
          (latest, member) =>
            !member.lastFailureAt || (latest && latest > member.lastFailureAt)
              ? latest
              : member.lastFailureAt,
          undefined,
        ),
        warnings: selection.warnings,
        recentEvents: this.poolSelectionEvents
          .filter((event) => event.poolId === pool.id)
          .slice(-6)
          .reverse(),
        members,
      } satisfies GatewayPoolObservability;
    });
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

    this.database.prunePoolSelectionEvents({
      maxRows: 10_000,
      retainDays: 30,
    });
    this.poolSelectionEvents.push(
      ...this.database.getRecentPoolSelectionEvents(500),
    );
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

  getEffectiveDispatchMode(
    target: GatewayRoutingRule["target"] | undefined,
  ): GatewayRoutingDispatchMode {
    const explicit = target?.dispatchMode;
    if (explicit === "active-session" || explicit === "fixed-session" || explicit === "dynamic-pool") {
      return explicit;
    }
    if (target?.poolId?.trim()) {
      return "dynamic-pool";
    }
    if (target?.sessionId?.trim()) {
      return "fixed-session";
    }
    return "active-session";
  }

  selectSessionFromPool(input: {
    poolId: string;
    currentSessionId?: string;
    attemptedSessionIds?: Set<string>;
    preview?: boolean;
  }): PoolSelectionResult {
    const poolId = input.poolId.trim();
    const settings = this.getPoolSettings();
    const pool = this.getPoolDefinition(poolId);
    const warnings: string[] = [];
    const rejectedCandidates: GatewayPoolRejectedCandidate[] = [];

    if (!settings.enabled) {
      return {
        poolId,
        poolName: pool?.name ?? poolId,
        candidateCount: 0,
        rejectedCandidates,
        warnings: ["动态号池当前未启用。"],
      };
    }

    if (!pool || pool.enabled === false) {
      return {
        poolId,
        poolName: pool?.name ?? poolId,
        candidateCount: 0,
        rejectedCandidates,
        warnings: [`未找到已启用的号池 ${poolId}。`],
      };
    }

    const sessions = this.listSessions();
    const attemptedSessionIds = input.attemptedSessionIds ?? new Set<string>();
    const now = Date.now();
    const minRemaining = this.normalizePercentage(pool.minRemainingPercentage);
    const allowUnknownQuota = pool.allowUnknownQuota !== false;
    const candidates: PoolCandidate[] = [];

    for (const member of pool.members ?? []) {
      if (!member?.selector?.trim() || member.enabled === false) {
        continue;
      }

      const selector = member.selector.trim();
      const sessionResolution = this.resolveRoutingSessionSelector(selector, undefined);
      const session = sessionResolution.sessionId
        ? sessions.find((item) => item.id === sessionResolution.sessionId)
        : undefined;
      if (!session) {
        rejectedCandidates.push({
          selector,
          label: member.label,
          sessionId: sessionResolution.sessionId,
          reason: sessionResolution.warning ?? "未在当前本地会话列表中找到可解析账号。",
        });
        continue;
      }

      if (session.sourceKind !== "local-import") {
        rejectedCandidates.push({
          selector,
          label: member.label,
          sessionId: session.id,
          reason: "当前第一版动态号池仅支持桌面端导入账号，不直接纳入原始本地授权来源。",
        });
        continue;
      }

      if (attemptedSessionIds.has(session.id)) {
        rejectedCandidates.push({
          selector,
          label: member.label,
          sessionId: session.id,
          reason: "本次请求已尝试过该账号。",
        });
        continue;
      }

      const runtimeState = this.getPoolMemberRuntimeState(pool.id, session.id);
      if (
        runtimeState.cooldownUntil &&
        runtimeState.cooldownUntil > now
      ) {
        rejectedCandidates.push({
          selector,
          label: member.label,
          sessionId: session.id,
          reason: `账号正在冷却中，预计 ${new Date(runtimeState.cooldownUntil).toLocaleString("zh-CN")} 后恢复。`,
        });
        continue;
      }

      if (session.status === "invalid") {
        rejectedCandidates.push({
          selector,
          label: member.label,
          sessionId: session.id,
          reason: "账号当前已失效。",
        });
        continue;
      }

      const percentage = session.quota?.percentage;
      if (typeof percentage === "number" && typeof minRemaining === "number" && percentage < minRemaining) {
        rejectedCandidates.push({
          selector,
          label: member.label,
          sessionId: session.id,
          reason: `剩余额度 ${percentage}% 低于阈值 ${minRemaining}% 。`,
        });
        continue;
      }

      if (typeof percentage !== "number" && !allowUnknownQuota) {
        rejectedCandidates.push({
          selector,
          label: member.label,
          sessionId: session.id,
          reason: "当前缺少额度快照，且该号池不允许未知额度账号参与调度。",
        });
        continue;
      }

      candidates.push({
        selector,
        label: member.label,
        priority: Number.isFinite(member.priority)
          ? Math.max(-10_000, Math.min(10_000, Math.round(member.priority ?? 100)))
          : 100,
        session,
        runtimeState,
      });
    }

    const sorted = candidates.sort((left, right) =>
      this.comparePoolCandidates(left, right, pool.selectionStrategy ?? "hybrid"),
    );
    const selected = sorted[0];
    if (!selected) {
      if (pool.fallbackToActiveSession && input.currentSessionId) {
        warnings.push(`号池 ${pool.name} 当前没有可用成员，已回退到当前活动账号。`);
        return {
          poolId: pool.id,
          poolName: pool.name,
          selectedSessionId: input.currentSessionId,
          selectionReason: "fallback-to-active-session",
          candidateCount: 0,
          rejectedCandidates,
          warnings,
        };
      }
      return {
        poolId: pool.id,
        poolName: pool.name,
        candidateCount: 0,
        rejectedCandidates,
        warnings,
      };
    }

    if (!input.preview) {
      this.markPoolSelection(pool.id, selected.session.id);
    }

    return {
      poolId: pool.id,
      poolName: pool.name,
      selectedSessionId: selected.session.id,
      selectedSelector: selected.selector,
      selectionReason: this.describePoolSelectionReason(pool.selectionStrategy ?? "hybrid"),
      candidateCount: sorted.length,
      rejectedCandidates,
      warnings,
    };
  }

  recordPoolSelectionSuccess(poolId: string, sessionId: string): void {
    const state = this.getPoolMemberRuntimeState(poolId, sessionId);
    state.lastSuccessAt = Date.now();
    state.lastFailureClass = undefined;
    state.consecutiveFailures = 0;
    state.cooldownUntil = undefined;
    this.poolMemberState.set(this.buildPoolMemberStateKey(poolId, sessionId), state);
  }

  recordPoolSelectionEvent(event: GatewayPoolSelectionEvent): void {
    this.poolSelectionEvents.push(event);
    if (this.poolSelectionEvents.length > 500) {
      this.poolSelectionEvents.splice(
        0,
        this.poolSelectionEvents.length - 500,
      );
    }
    this.database.insertPoolSelectionEvent(event);
    this.poolSelectionInsertCount += 1;
    if (this.poolSelectionInsertCount % 100 === 0) {
      this.database.prunePoolSelectionEvents({
        maxRows: 10_000,
        retainDays: 30,
      });
    }
  }

  recordPoolSelectionFailure(input: {
    poolId: string;
    sessionId: string;
    failureClass: GatewayPoolFailureClass;
    resetAt?: number;
  }): void {
    const pool = this.getPoolDefinition(input.poolId);
    const state = this.getPoolMemberRuntimeState(input.poolId, input.sessionId);
    const now = Date.now();
    const quotaCooldownMs = Math.max(
      30_000,
      (pool?.quotaExhaustedCooldownSeconds ?? 7_200) * 1_000,
    );
    const defaultCooldownMs = Math.max(
      10_000,
      (pool?.cooldownSeconds ?? 300) * 1_000,
    );
    let cooldownUntil = now + defaultCooldownMs;

    if (input.failureClass === "quota_exhausted") {
      cooldownUntil =
        typeof input.resetAt === "number" && input.resetAt > now
          ? input.resetAt
          : now + quotaCooldownMs;
    } else if (input.failureClass === "auth_invalid") {
      cooldownUntil = now + Math.max(defaultCooldownMs, 30 * 60 * 1_000);
    } else if (input.failureClass === "rate_limited") {
      cooldownUntil = now + Math.max(defaultCooldownMs, 5 * 60 * 1_000);
    } else if (input.failureClass === "network_retryable") {
      cooldownUntil = now + Math.max(30_000, defaultCooldownMs);
    }

    state.lastFailureAt = now;
    state.lastFailureClass = input.failureClass;
    state.consecutiveFailures += 1;
    state.cooldownUntil = cooldownUntil;
    this.poolMemberState.set(this.buildPoolMemberStateKey(input.poolId, input.sessionId), state);
  }

  private resolveRoutingSessionSelector(
    selector: string | undefined,
    fallbackSessionId: string | undefined,
  ): { sessionId?: string; warning?: string } {
    const normalizedSelector = selector?.trim();
    if (!normalizedSelector) {
      return { sessionId: fallbackSessionId };
    }

    const sessions = this.listSessions();
    const byId = sessions.find((session) => session.id === normalizedSelector);
    if (byId) {
      return { sessionId: byId.id };
    }

    const byProfile = sessions.filter(
      (session) => session.profileId === normalizedSelector,
    );
    if (byProfile.length === 1) {
      return { sessionId: byProfile[0]!.id };
    }
    if (byProfile.length > 1) {
      const chosen = this.pickPreferredRoutingSession(byProfile);
      return {
        sessionId: chosen?.id ?? fallbackSessionId,
        warning: `会话选择器 ${normalizedSelector} 命中了多个 profile，已优先使用 ${chosen?.id ?? "当前活动会话"}。`,
      };
    }

    const byAccount = sessions.filter(
      (session) => session.accountId === normalizedSelector,
    );
    if (byAccount.length === 1) {
      return { sessionId: byAccount[0]!.id };
    }
    if (byAccount.length > 1) {
      const chosen = this.pickPreferredRoutingSession(byAccount);
      return {
        sessionId: chosen?.id ?? fallbackSessionId,
        warning: `账号标识 ${normalizedSelector} 命中了多个本地会话，已优先使用 ${chosen?.id ?? "当前活动会话"}。`,
      };
    }

    return {
      sessionId: normalizedSelector,
      warning: `会话选择器 ${normalizedSelector} 未在当前本地会话列表中找到。`,
    };
  }

  private pickPreferredRoutingSession(
    sessions: SessionSummary[],
  ): SessionSummary | undefined {
    const activeSessionId = this.getActiveSessionId();
    return [...sessions].sort((left, right) => {
      const leftActive = left.id === activeSessionId ? 1 : 0;
      const rightActive = right.id === activeSessionId ? 1 : 0;
      if (leftActive !== rightActive) {
        return rightActive - leftActive;
      }

      const leftAvailable = left.status === "available" ? 1 : 0;
      const rightAvailable = right.status === "available" ? 1 : 0;
      if (leftAvailable !== rightAvailable) {
        return rightAvailable - leftAvailable;
      }

      return (right.expiresAt ?? 0) - (left.expiresAt ?? 0);
    })[0];
  }

  private getPoolDefinition(poolId: string): GatewaySessionPoolDefinition | undefined {
    return this.getPoolSettings().pools?.find(
      (pool) => pool.id === poolId,
    );
  }

  private buildPoolMemberObservability(input: {
    pool: GatewaySessionPoolDefinition;
    member: GatewaySessionPoolMember;
    sessions: SessionSummary[];
    selectedSessionId?: string;
    selectedSelector?: string;
  }): GatewayPoolMemberObservability {
    const selector = input.member?.selector?.trim() ?? "";
    const baseState: GatewayPoolMemberObservability = {
      selector,
      label: input.member?.label,
      eligible: false,
      selected: false,
      status: "missing",
      statusLabel: "未找到",
      note: "当前池成员未在本地会话列表中找到可解析账号。",
      consecutiveFailures: 0,
    };

    if (!selector || input.member?.enabled === false) {
      return {
        ...baseState,
        status: "disabled",
        statusLabel: "未启用",
        note: "该池成员当前已被禁用。",
      };
    }

    const pool = input.pool;
    const now = Date.now();
    const minRemaining = this.normalizePercentage(pool.minRemainingPercentage);
    const allowUnknownQuota = pool.allowUnknownQuota !== false;
    const sessionResolution = this.resolveRoutingSessionSelector(selector, undefined);
    const session = sessionResolution.sessionId
      ? input.sessions.find((item) => item.id === sessionResolution.sessionId)
      : undefined;

    if (!session) {
      return {
        ...baseState,
        sessionId: sessionResolution.sessionId,
        note: sessionResolution.warning ?? baseState.note,
      };
    }

    const runtimeState = this.getPoolMemberRuntimeState(pool.id, session.id);
    const selected = Boolean(
      (input.selectedSelector && input.selectedSelector === selector) ||
      (input.selectedSessionId && input.selectedSessionId === session.id),
    );
    const output: GatewayPoolMemberObservability = {
      ...baseState,
      selector,
      label: input.member.label,
      sessionId: session.id,
      sessionTitle:
        session.email || session.displayName || session.accountId || session.id,
      sessionSubtitle: session.accountId || session.profileId || session.id,
      quotaPercentage: session.quota?.percentage,
      resetAt: session.quota?.resetAt,
      eligible: true,
      selected,
      status: session.status === "expired" ? "expired" : "available",
      statusLabel: session.status === "expired" ? "待刷新" : "可选",
      note:
        session.status === "expired"
          ? "当前本地会话已标记为过期，请求时仍可能尝试刷新。"
          : undefined,
      cooldownUntil: runtimeState.cooldownUntil,
      lastSelectedAt: runtimeState.lastSelectedAt,
      lastSuccessAt: runtimeState.lastSuccessAt,
      lastFailureAt: runtimeState.lastFailureAt,
      lastFailureClass: runtimeState.lastFailureClass,
      consecutiveFailures: runtimeState.consecutiveFailures,
    };

    if (session.sourceKind !== "local-import") {
      return {
        ...output,
        eligible: false,
        status: "invalid",
        statusLabel: "来源不支持",
        note: "当前第一版动态号池仅支持桌面端导入账号，不直接纳入原始本地授权来源。",
      };
    }

    if (runtimeState.cooldownUntil && runtimeState.cooldownUntil > now) {
      return {
        ...output,
        eligible: false,
        status: "cooldown",
        statusLabel: "冷却中",
        note: `预计 ${new Date(runtimeState.cooldownUntil).toLocaleString("zh-CN")} 后恢复可选。`,
      };
    }

    if (session.status === "invalid") {
      return {
        ...output,
        eligible: false,
        status: "invalid",
        statusLabel: "已失效",
        note: "当前账号已失效，需重新授权或刷新账号。",
      };
    }

    const percentage = session.quota?.percentage;
    if (
      typeof percentage === "number" &&
      typeof minRemaining === "number" &&
      percentage < minRemaining
    ) {
      return {
        ...output,
        eligible: false,
        status: "quota-low",
        statusLabel: "低于阈值",
        note: `剩余额度 ${percentage}% 低于阈值 ${minRemaining}% ，不会参与新请求调度。`,
      };
    }

    if (typeof percentage !== "number" && !allowUnknownQuota) {
      return {
        ...output,
        eligible: false,
        status: "unknown-quota",
        statusLabel: "额度未知",
        note: "当前缺少额度快照，且该号池不允许未知额度账号参与调度。",
      };
    }

    return output;
  }

  private buildPoolMemberStateKey(poolId: string, sessionId: string): string {
    return `${poolId}:${sessionId}`;
  }

  private getPoolMemberRuntimeState(
    poolId: string,
    sessionId: string,
  ): PoolMemberRuntimeState {
    return (
      this.poolMemberState.get(this.buildPoolMemberStateKey(poolId, sessionId)) ?? {
        consecutiveFailures: 0,
      }
    );
  }

  private markPoolSelection(poolId: string, sessionId: string): void {
    const state = this.getPoolMemberRuntimeState(poolId, sessionId);
    state.lastSelectedAt = Date.now();
    this.poolMemberState.set(this.buildPoolMemberStateKey(poolId, sessionId), state);
  }

  private normalizePercentage(value?: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  private comparePoolCandidates(
    left: PoolCandidate,
    right: PoolCandidate,
    strategy: GatewaySessionPoolDefinition["selectionStrategy"],
  ): number {
    const leftAvailable = left.session.status === "available" ? 1 : 0;
    const rightAvailable = right.session.status === "available" ? 1 : 0;
    if (leftAvailable !== rightAvailable) {
      return rightAvailable - leftAvailable;
    }

    const leftQuota = left.session.quota?.percentage ?? -1;
    const rightQuota = right.session.quota?.percentage ?? -1;
    const leftLastSelected = left.runtimeState.lastSelectedAt ?? 0;
    const rightLastSelected = right.runtimeState.lastSelectedAt ?? 0;

    if (strategy === "priority") {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      if (rightQuota !== leftQuota) {
        return rightQuota - leftQuota;
      }
      return leftLastSelected - rightLastSelected;
    }

    if (strategy === "quota-desc") {
      if (rightQuota !== leftQuota) {
        return rightQuota - leftQuota;
      }
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return leftLastSelected - rightLastSelected;
    }

    if (strategy === "least-recently-used") {
      if (leftLastSelected !== rightLastSelected) {
        return leftLastSelected - rightLastSelected;
      }
      if (rightQuota !== leftQuota) {
        return rightQuota - leftQuota;
      }
      return left.priority - right.priority;
    }

    if (rightQuota !== leftQuota) {
      return rightQuota - leftQuota;
    }
    if (leftLastSelected !== rightLastSelected) {
      return leftLastSelected - rightLastSelected;
    }
    return left.priority - right.priority;
  }

  private describePoolSelectionReason(
    strategy: GatewaySessionPoolDefinition["selectionStrategy"],
  ): string {
    if (strategy === "priority") {
      return "按手工优先级选择";
    }
    if (strategy === "quota-desc") {
      return "按剩余额度优先选择";
    }
    if (strategy === "least-recently-used") {
      return "按最近最少使用选择";
    }
    return "按额度优先并结合最近使用情况综合选择";
  }
}
