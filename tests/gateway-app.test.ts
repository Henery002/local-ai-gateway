import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import {
  AppLogger,
  ConfigStore,
  ensureAppPaths,
  GatewayDatabase,
  ModelRegistry,
  ProviderRegistry,
} from "@local-ai-gateway/core";
import {
  GatewayChatOptions,
  GatewayConversationContext,
  GatewayError,
  GatewayModelDefinition,
  ProviderAdapter,
  ProviderStream,
  ProviderStreamResult,
  ResolvedSession,
  SessionSource,
  SessionSummary,
  SessionUsageRefreshSummary,
} from "@local-ai-gateway/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createGatewayApp } from "../apps/gateway/src/app.js";
import { GatewayRuntime } from "../apps/gateway/src/runtime.js";

class FakeProviderStream implements ProviderStream {
  constructor(
    private readonly events: AssistantMessageEvent[],
    private readonly finalMessage: AssistantMessage,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  async result(): Promise<AssistantMessage> {
    return this.finalMessage;
  }
}

class FakeSessionSource implements SessionSource {
  readonly session: ResolvedSession = {
    id: "main:fake:default",
    agentId: "main",
    profileId: "fake:default",
    provider: "fake-provider",
    type: "oauth",
    status: "available",
    sourcePath: "/tmp/fake-auth.json",
    accountId: "acct_fake",
    expiresAt: 4_102_444_800_000,
    apiKey: "fake-api-key",
  };

  listSessions(): SessionSummary[] {
    return [this.session];
  }

  async resolveSession(): Promise<ResolvedSession> {
    return this.session;
  }

  async refreshUsage(sessionId?: string): Promise<SessionUsageRefreshSummary> {
    return {
      ok: true,
      refreshed: 1,
      failed: 0,
      data: [
        {
          sessionId: sessionId ?? this.session.id,
          accountId: this.session.accountId,
          sourceKind: "local-import",
          planType: "plus",
          quota: {
            scope: "hourly",
            percentage: 88,
            resetAt: 4_102_444_800_000,
            updatedAt: 4_102_111_111_000,
          },
        },
      ],
      errors: [],
    };
  }
}

class FakeProviderAdapter implements ProviderAdapter {
  readonly id = "fake-provider";
  readonly label = "Fake Provider";
  lastContext?: GatewayConversationContext;
  lastOptions?: GatewayChatOptions;

  supportsModel(model: GatewayModelDefinition): boolean {
    return model.provider === this.id;
  }

  async createStream(
    model: GatewayModelDefinition,
    context: GatewayConversationContext,
    options: GatewayChatOptions = {},
  ): Promise<ProviderStreamResult> {
    this.lastContext = context;
    this.lastOptions = options;

    const finalMessage: AssistantMessage = {
      role: "assistant",
      api: "openai-codex-responses",
      provider: this.id,
      model: model.providerModelId,
      timestamp: Date.now(),
      stopReason: context.tools?.length ? "toolUse" : "stop",
      usage: {
        input: 7,
        output: 5,
        cacheRead: 3,
        cacheWrite: 0,
        totalTokens: 12,
        reasoningOutputTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      content: context.tools?.length
        ? [
            {
              type: "toolCall",
              id: "call_fake",
              name: context.tools[0]?.name ?? "fake_tool",
              arguments: { city: "Shanghai" },
            },
          ]
        : [{ type: "text", text: "OK" }],
    };

    const events: AssistantMessageEvent[] = context.tools?.length
      ? [
          { type: "start", partial: finalMessage },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: {
              type: "toolCall",
              id: "call_fake",
              name: context.tools[0]?.name ?? "fake_tool",
              arguments: { city: "Shanghai" },
            },
            partial: finalMessage,
          },
          { type: "done", reason: "toolUse", message: finalMessage },
        ]
      : [
          { type: "start", partial: finalMessage },
          { type: "text_delta", contentIndex: 0, delta: "OK", partial: finalMessage },
          { type: "done", reason: "stop", message: finalMessage },
        ];

    return {
      providerId: this.id,
      providerLabel: this.label,
      model,
      session: {
        id: "main:fake:default",
        agentId: "main",
        profileId: "fake:default",
        provider: this.id,
        type: "oauth",
        status: "available",
        sourcePath: "/tmp/fake-auth.json",
        accountId: "acct_fake",
        expiresAt: 4_102_444_800_000,
        apiKey: "fake-api-key",
      },
      stream: new FakeProviderStream(events, finalMessage),
    };
  }
}

class FixedTargetFailureSessionSource implements SessionSource {
  readonly fixedSession: ResolvedSession = {
    id: "main:fake:fixed",
    agentId: "main",
    profileId: "fake:fixed",
    provider: "fake-provider",
    type: "oauth",
    status: "expired",
    sourcePath: "/tmp/fake-fixed-auth.json",
    accountId: "acct_fixed",
    expiresAt: 4_102_444_800_000,
    apiKey: "fixed-api-key",
  };

  readonly backupSession: ResolvedSession = {
    id: "main:fake:backup",
    agentId: "main",
    profileId: "fake:backup",
    provider: "fake-provider",
    type: "oauth",
    status: "available",
    sourcePath: "/tmp/fake-backup-auth.json",
    accountId: "acct_backup",
    expiresAt: 4_102_555_800_000,
    apiKey: "backup-api-key",
  };

  listSessions(): SessionSummary[] {
    return [this.fixedSession, this.backupSession];
  }

  async resolveSession(sessionId?: string): Promise<ResolvedSession> {
    if (sessionId === this.fixedSession.id) {
      throw new GatewayError(
        503,
        "gateway_auth_required",
        `Session ${this.fixedSession.id} could not be refreshed.`,
      );
    }

    if (!sessionId || sessionId === this.backupSession.id) {
      return this.backupSession;
    }

    throw new GatewayError(400, "session_not_found", `Unknown session: ${sessionId}`);
  }
}

class SessionBackedProviderAdapter extends FakeProviderAdapter {
  attemptedSessionIds: string[] = [];

  constructor(private readonly sessionSource: SessionSource) {
    super();
  }

  override async createStream(
    model: GatewayModelDefinition,
    context: GatewayConversationContext,
    options: GatewayChatOptions = {},
  ): Promise<ProviderStreamResult> {
    this.lastContext = context;
    this.lastOptions = options;
    if (options.sessionId) {
      this.attemptedSessionIds.push(options.sessionId);
    }

    const session = await this.sessionSource.resolveSession(options.sessionId);
    const finalMessage: AssistantMessage = {
      role: "assistant",
      api: "openai-codex-responses",
      provider: this.id,
      model: model.providerModelId,
      timestamp: Date.now(),
      stopReason: "stop",
      usage: {
        input: 7,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      content: [{ type: "text", text: "OK" }],
    };

    return {
      providerId: this.id,
      providerLabel: this.label,
      model,
      session,
      stream: new FakeProviderStream(
        [
          { type: "start", partial: finalMessage },
          { type: "text_delta", contentIndex: 0, delta: "OK", partial: finalMessage },
          { type: "done", reason: "stop", message: finalMessage },
        ],
        finalMessage,
      ),
    };
  }
}

class PoolSessionSource implements SessionSource {
  constructor(readonly sessions: ResolvedSession[]) {}

  listSessions(): SessionSummary[] {
    return this.sessions;
  }

  async resolveSession(sessionId?: string): Promise<ResolvedSession> {
    if (sessionId) {
      const resolved = this.sessions.find((item) => item.id === sessionId);
      if (resolved) {
        return resolved;
      }
      throw new GatewayError(400, "session_not_found", `Unknown session: ${sessionId}`);
    }

    const fallback = this.sessions.find((item) => item.status === "available");
    if (fallback) {
      return fallback;
    }

    throw new GatewayError(503, "gateway_auth_required", "No usable session available.");
  }

  async refreshUsage(sessionId?: string): Promise<SessionUsageRefreshSummary> {
    const scoped = sessionId
      ? this.sessions.filter((item) => item.id === sessionId)
      : this.sessions;
    return {
      ok: true,
      refreshed: scoped.length,
      failed: 0,
      data: scoped.map((item) => ({
        sessionId: item.id,
        accountId: item.accountId,
        sourceKind: item.sourceKind,
        planType: item.planType,
        quota: item.quota,
      })),
      errors: [],
    };
  }
}

class FailableSessionBackedProviderAdapter extends SessionBackedProviderAdapter {
  constructor(
    sessionSource: SessionSource,
    private readonly failures: Record<string, Array<Error | string>>,
  ) {
    super(sessionSource);
  }

  override async createStream(
    model: GatewayModelDefinition,
    context: GatewayConversationContext,
    options: GatewayChatOptions = {},
  ): Promise<ProviderStreamResult> {
    const sessionId = options.sessionId;
    if (sessionId) {
      const queue = this.failures[sessionId];
      if (queue?.length) {
        this.lastContext = context;
        this.lastOptions = options;
        this.attemptedSessionIds.push(sessionId);
        const next = queue.shift();
        throw next instanceof Error ? next : new Error(next);
      }
    }

    return super.createStream(model, context, options);
  }
}

class ThrowBeforeFirstChunkStream implements ProviderStream {
  constructor(
    private readonly upstream: ProviderStream,
    private readonly error: Error,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    throw this.error;
  }

  async result(): Promise<AssistantMessage> {
    return this.upstream.result();
  }
}

class StreamFailableSessionBackedProviderAdapter extends SessionBackedProviderAdapter {
  constructor(
    sessionSource: SessionSource,
    private readonly failures: Record<string, Array<Error | string>>,
  ) {
    super(sessionSource);
  }

  override async createStream(
    model: GatewayModelDefinition,
    context: GatewayConversationContext,
    options: GatewayChatOptions = {},
  ): Promise<ProviderStreamResult> {
    const result = await super.createStream(model, context, options);
    const sessionId = result.session.id;
    const queue = this.failures[sessionId];
    if (!queue?.length) {
      return result;
    }
    const next = queue.shift();
    const error = next instanceof Error ? next : new Error(next);
    return {
      ...result,
      stream: new ThrowBeforeFirstChunkStream(result.stream, error),
    };
  }
}

function createResolvedSession(input: {
  id: string;
  profileId: string;
  accountId: string;
  status?: "available" | "expired" | "invalid";
  sourceKind?: "local-import" | "openclaw";
  quotaPercentage?: number;
  resetAt?: number;
}): ResolvedSession {
  return {
    id: input.id,
    agentId: "main",
    profileId: input.profileId,
    provider: "fake-provider",
    type: "oauth",
    status: input.status ?? "available",
    sourceKind: input.sourceKind ?? "local-import",
    sourceLabel: input.sourceKind === "openclaw" ? "OpenClaw 可复用授权" : "桌面端 Codex 账号",
    sourcePath: `/tmp/${input.profileId}.json`,
    accountId: input.accountId,
    displayName: input.accountId,
    planType: "plus",
    quota:
      typeof input.quotaPercentage === "number"
        ? {
            scope: "hourly",
            percentage: input.quotaPercentage,
            resetAt: input.resetAt ?? 4_102_444_800_000,
            updatedAt: 4_102_111_111_000,
          }
        : undefined,
    expiresAt: 4_102_555_800_000,
    apiKey: `${input.accountId}-api-key`,
  };
}

function createTestRuntime(options?: {
  serverHost?: string;
  serverPort?: number;
  rootDir?: string;
}) {
  const rootDir =
    options?.rootDir ?? mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
  const paths = ensureAppPaths(rootDir);
  const database = new GatewayDatabase(paths);
  const logger = new AppLogger(paths, database);
  const configStore = new ConfigStore(paths);
  const sessionSource = new FakeSessionSource();
  const adapter = new FakeProviderAdapter();
  const modelRegistry = new ModelRegistry([
    {
      alias: "fake-default",
      displayName: "Fake Default",
      provider: "fake-provider",
      providerModelId: "fake-model-1",
      contextWindow: 100_000,
      maxTokens: 8_192,
      input: ["text"],
      reasoning: true,
    },
    {
      alias: "fake-routed",
      displayName: "Fake Routed",
      provider: "fake-provider",
      providerModelId: "fake-model-2",
      contextWindow: 100_000,
      maxTokens: 8_192,
      input: ["text"],
      reasoning: true,
    },
  ]);
  const providerRegistry = new ProviderRegistry([adapter]);
  const runtime = new GatewayRuntime(
    paths,
    configStore,
    database,
    logger,
    modelRegistry,
    sessionSource,
    providerRegistry,
    options?.serverHost,
    options?.serverPort,
  );

  return {
    rootDir,
    runtime,
    database,
    adapter,
  };
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("gateway app", () => {
  it("serves health, models, providers, and admin session switching", async () => {
    const { rootDir, runtime, database, adapter } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);

    try {
      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        ok: true,
        host: "127.0.0.1",
        port: 8787,
        provider: "fake-provider",
        defaultModel: "fake-default",
        defaultSelection: {
          alias: "fake-default",
          provider: "fake-provider",
          overridden: false,
        },
      });

      const models = await app.inject({ method: "GET", url: "/v1/models" });
      expect(models.statusCode).toBe(200);
      expect(models.json().data[0]?.id).toBe("fake-default");

      const adminToken = runtime.configStore.getAdminToken();
      const providers = await app.inject({
        method: "GET",
        url: "/admin/providers",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().data[0]).toMatchObject({
        id: "fake-provider",
        label: "Fake Provider",
        usesSessions: false,
      });

      const routingSettings = await app.inject({
        method: "GET",
        url: "/admin/config/routing",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(routingSettings.statusCode).toBe(200);
      expect(routingSettings.json()).toMatchObject({
        data: {},
      });

      const savedRouting = await app.inject({
        method: "PUT",
        url: "/admin/config/routing",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          enabled: true,
          rules: [
            {
              id: "rule-1",
              name: "localraghub-route",
              enabled: true,
              priority: 10,
              when: {
                clientTag: "localraghub",
              },
              target: {
                modelAlias: "fake-default",
                sessionId: "main:fake:default",
              },
            },
          ],
        },
      });
      expect(savedRouting.statusCode).toBe(200);
      expect(savedRouting.json().data.rules).toHaveLength(1);

      const previewRouting = await app.inject({
        method: "POST",
        url: "/admin/config/routing/preview",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          clientTag: "localraghub",
          requestedModelAlias: "codex-default",
        },
      });
      expect(previewRouting.statusCode).toBe(200);
      expect(previewRouting.json()).toMatchObject({
        ok: true,
        data: {
          enabled: true,
          matchedRuleId: "rule-1",
          resolvedModelAlias: "fake-default",
          resolvedSessionId: "main:fake:default",
          reason: "rule_matched",
        },
      });

      const securitySettings = await app.inject({
        method: "GET",
        url: "/admin/config/security",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(securitySettings.statusCode).toBe(200);
      expect(securitySettings.json()).toMatchObject({
        ok: true,
        data: {
          mode: "none",
          enabled: false,
          hasApiKey: false,
        },
      });

      const savedSecurity = await app.inject({
        method: "PUT",
        url: "/admin/config/security",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          mode: "api-key",
          apiKey: "gateway-test-key",
        },
      });
      expect(savedSecurity.statusCode).toBe(200);
      expect(savedSecurity.json()).toMatchObject({
        ok: true,
        data: {
          mode: "api-key",
          enabled: true,
          hasApiKey: true,
        },
      });

      const setActive = await app.inject({
        method: "PUT",
        url: "/admin/sessions/active",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          sessionId: "main:fake:default",
        },
      });
      expect(setActive.statusCode).toBe(200);

      const sessions = await app.inject({
        method: "GET",
        url: "/admin/sessions",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json()).toMatchObject({
        activeSessionId: "main:fake:default",
      });

      const refreshed = await app.inject({
        method: "POST",
        url: "/admin/sessions/refresh",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          sessionId: "main:fake:default",
        },
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toMatchObject({
        ok: true,
        refreshed: 1,
        failed: 0,
        data: [
          {
            sessionId: "main:fake:default",
            accountId: "acct_fake",
            planType: "plus",
          },
        ],
      });

      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().openclaw).toMatchObject({
        baseUrl: "http://127.0.0.1:8787/v1",
      });
      expect(adminHealth.json().inferenceAuth).toMatchObject({
        mode: "api-key",
        enabled: true,
        hasApiKey: true,
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it("reflects custom host and port in health and openclaw snippet", async () => {
    const { rootDir, runtime, database } = createTestRuntime({
      serverHost: "127.0.0.1",
      serverPort: 18999,
    });
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);

    try {
      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        host: "127.0.0.1",
        port: 18999,
      });

      const adminToken = runtime.configStore.getAdminToken();
      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().openclaw).toMatchObject({
        baseUrl: "http://127.0.0.1:18999/v1",
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it("normalizes pool visibility when saving pool settings", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);
    const adminToken = runtime.configStore.getAdminToken();

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/config/pools",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          enabled: true,
          pools: [
            {
              id: "pool-shared",
              name: "Shared LAN",
              enabled: true,
              visibility: "shared-lan",
              members: [{ selector: "acct_fake", priority: 10 }],
            },
            {
              id: "pool-legacy",
              name: "Legacy",
              enabled: true,
              visibility: "invalid",
              members: [{ selector: "acct_fake", priority: 20 }],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.pools).toEqual([
        expect.objectContaining({
          id: "pool-shared",
          visibility: "shared-lan",
        }),
        expect.objectContaining({
          id: "pool-legacy",
          visibility: "private",
        }),
      ]);
      expect(runtime.configStore.getPoolSettings().pools?.[1]?.visibility).toBe(
        "private",
      );
    } finally {
      await app.close();
      database.close();
    }
  });

  it("returns non-stream chat completions and forwards context/options", async () => {
    const { rootDir, runtime, database, adapter } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.setActiveSessionId("main:fake:default");
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-live-route",
          name: "localraghub-live-route",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "localraghub",
            requestedModelAlias: "fake-default",
          },
          target: {
            modelAlias: "fake-routed",
            sessionId: "main:fake:default",
          },
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "user-agent": "localRagHub/1.0",
        },
        payload: {
          model: "fake-default",
          temperature: 0.1,
          max_tokens: 128,
          messages: [
            { role: "system", content: "You are a test." },
            { role: "user", content: "Reply with exactly OK." },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().model).toBe("fake-routed");
      expect(response.json().choices[0]?.message?.content).toBe("OK");
      expect(adapter.lastContext?.systemPrompt).toBe("You are a test.");
      expect(adapter.lastOptions).toMatchObject({
        sessionId: "main:fake:default",
        temperature: 0.1,
        maxTokens: 128,
      });

      const adminToken = runtime.configStore.getAdminToken();
      const sessions = await app.inject({
        method: "GET",
        url: "/admin/sessions",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json().data[0]?.activity).toMatchObject({
        requestCount: 1,
        successCount: 1,
        failureCount: 0,
        nonStreamCount: 1,
        recentRequestCount5m: 1,
        recentRequestCount1h: 1,
        recentRequestCount24h: 1,
        byClientTag: [
          {
            clientTag: "localraghub",
            requestCount: 1,
          },
        ],
        recentByClientTag5m: [
          {
            clientTag: "localraghub",
            requestCount: 1,
          },
        ],
        recentByClientTag1h: [
          {
            clientTag: "localraghub",
            requestCount: 1,
          },
        ],
        recentByClientTag24h: [
          {
            clientTag: "localraghub",
            requestCount: 1,
          },
        ],
      });
      expect(typeof sessions.json().data[0]?.activity?.lastRequestAt).toBe("number");

      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().routingObservability).toMatchObject({
        totalMatched: 1,
        matchedLast5m: 1,
        matchedLast1h: 1,
        matchedLast24h: 1,
      });
      expect(adminHealth.json().routingObservability.byRule[0]).toMatchObject({
        ruleId: "rule-live-route",
        ruleName: "localraghub-live-route",
        hits: 1,
      });
      expect(adminHealth.json().routingObservability.byClientTag[0]).toMatchObject({
        clientTag: "localraghub",
        hits: 1,
      });
      expect(adminHealth.json().usageObservability?.daily?.totals).toMatchObject({
        requestCount: 1,
        successCount: 1,
        failureCount: 0,
        inputTokens: 7,
        outputTokens: 5,
        totalTokens: 12,
        cachedTokens: 3,
        reasoningTokens: 2,
      });

      const usageSummary = await app.inject({
        method: "GET",
        url: "/admin/usage/summary?clientFilter=other",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(usageSummary.statusCode).toBe(200);
      expect(usageSummary.json().data.clientFilter).toBe("other");
      expect(usageSummary.json().data.daily.cachedSignalCount).toBe(1);
      expect(usageSummary.json().data.daily.reasoningSignalCount).toBe(1);
      expect(usageSummary.json().data.daily.totals).toMatchObject({
        requestCount: 1,
        successCount: 1,
        failureCount: 0,
        inputTokens: 7,
        outputTokens: 5,
        totalTokens: 12,
        cachedTokens: 3,
        reasoningTokens: 2,
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it("detects Hermes requests as a primary client tag in usage summary", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.setActiveSessionId("main:fake:default");
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "user-agent": "Hermes/0.7.0",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "Reply with exactly OK." }],
        },
      });

      expect(response.statusCode).toBe(200);

      const adminToken = runtime.configStore.getAdminToken();
      const usageSummary = await app.inject({
        method: "GET",
        url: "/admin/usage/summary?clientFilter=hermes",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(usageSummary.statusCode).toBe(200);
      expect(usageSummary.json().data.clientFilter).toBe("hermes");
      expect(usageSummary.json().data.daily.totals).toMatchObject({
        requestCount: 1,
        successCount: 1,
        failureCount: 0,
        totalTokens: 12,
        cachedTokens: 3,
        reasoningTokens: 2,
      });
      expect(usageSummary.json().data.daily.clients[0]).toMatchObject({
        clientTag: "hermes",
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it("resolves routing target session from account identifier during preview and live routing", async () => {
    const { rootDir, runtime, database, adapter } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.setActiveSessionId("main:fake:default");
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-openclaw-account",
          name: "openclaw-account-route",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "openclaw",
            requestedModelAlias: "fake-default",
          },
          target: {
            modelAlias: "fake-default",
            sessionId: "acct_fake",
          },
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const adminToken = runtime.configStore.getAdminToken();
      const preview = await app.inject({
        method: "POST",
        url: "/admin/config/routing/preview",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          clientTag: "openclaw",
          requestedModelAlias: "fake-default",
          currentModelAlias: "fake-default",
        },
      });

      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        ok: true,
        data: {
          reason: "rule_matched",
          resolvedSessionId: "main:fake:default",
        },
      });
      expect(preview.json().data.warnings ?? []).toHaveLength(0);

      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "ping" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(adapter.lastOptions?.sessionId).toBe("main:fake:default");

      const sessions = await app.inject({
        method: "GET",
        url: "/admin/sessions",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json().data[0]?.activity).toMatchObject({
        recentRequestCount5m: 1,
        recentRequestCount1h: 1,
        recentRequestCount24h: 1,
      });

      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().routingObservability.byClientTag[0]).toMatchObject({
        clientTag: "openclaw",
        hits: 1,
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it("falls back to a usable session when a fixed routing target cannot be refreshed", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const database = new GatewayDatabase(paths);
    const logger = new AppLogger(paths, database);
    const configStore = new ConfigStore(paths);
    const sessionSource = new FixedTargetFailureSessionSource();
    const adapter = new SessionBackedProviderAdapter(sessionSource);
    const modelRegistry = new ModelRegistry([
      {
        alias: "fake-default",
        displayName: "Fake Default",
        provider: "fake-provider",
        providerModelId: "fake-model-1",
        contextWindow: 100_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
      },
    ]);
    const providerRegistry = new ProviderRegistry([adapter]);
    const runtime = new GatewayRuntime(
      paths,
      configStore,
      database,
      logger,
      modelRegistry,
      sessionSource,
      providerRegistry,
    );
    runtime.setActiveSessionId(sessionSource.backupSession.id);
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-openclaw-fixed-fallback",
          name: "openclaw-fixed-fallback",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "openclaw",
            requestedModelAlias: "fake-default",
          },
          target: {
            modelAlias: "fake-default",
            sessionId: sessionSource.fixedSession.accountId,
          },
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const adminToken = runtime.configStore.getAdminToken();
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "ping" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(adapter.attemptedSessionIds).toEqual([
        sessionSource.fixedSession.id,
        sessionSource.backupSession.id,
      ]);
      expect(adapter.lastOptions?.sessionId).toBe(sessionSource.backupSession.id);

      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().routingObservability.recent[0]).toMatchObject({
        resolvedSessionId: sessionSource.backupSession.id,
      });
      expect(adminHealth.json().routingObservability.recent[0]?.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("已回退到 main:fake:backup"),
        ]),
      );
    } finally {
      await app.close();
      database.close();
    }
  });

  it("degrades fixed-session routing to configured pool members when fixed account fails", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const database = new GatewayDatabase(paths);
    const logger = new AppLogger(paths, database);
    const configStore = new ConfigStore(paths);
    const fixedSession = createResolvedSession({
      id: "main:fake:fixed-pool",
      profileId: "fake:fixed-pool",
      accountId: "acct_fixed_pool",
      quotaPercentage: 80,
    });
    const poolBackupSession = createResolvedSession({
      id: "main:fake:pool-backup",
      profileId: "fake:pool-backup",
      accountId: "acct_pool_backup",
      quotaPercentage: 76,
    });
    const activeOtherSession = createResolvedSession({
      id: "main:fake:active-other",
      profileId: "fake:active-other",
      accountId: "acct_active_other",
      quotaPercentage: 92,
    });
    const sessionSource = new PoolSessionSource([
      fixedSession,
      poolBackupSession,
      activeOtherSession,
    ]);
    const adapter = new FailableSessionBackedProviderAdapter(sessionSource, {
      [fixedSession.id]: [new Error("usage_limit_reached")],
    });
    const modelRegistry = new ModelRegistry([
      {
        alias: "fake-default",
        displayName: "Fake Default",
        provider: "fake-provider",
        providerModelId: "fake-model-1",
        contextWindow: 100_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
      },
    ]);
    const providerRegistry = new ProviderRegistry([adapter]);
    const runtime = new GatewayRuntime(
      paths,
      configStore,
      database,
      logger,
      modelRegistry,
      sessionSource,
      providerRegistry,
    );
    runtime.setActiveSessionId(activeOtherSession.id);
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-fixed-fallback",
          name: "固定账号失败回退池",
          enabled: true,
          selectionStrategy: "priority",
          maxRetryCandidates: 2,
          members: [
            { selector: fixedSession.accountId!, priority: 10 },
            { selector: poolBackupSession.accountId!, priority: 20 },
          ],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-openclaw-fixed-with-pool",
          name: "openclaw-fixed-with-pool",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "openclaw",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "fixed-session",
            modelAlias: "fake-default",
            sessionId: fixedSession.accountId,
            poolId: "pool-fixed-fallback",
          },
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "ping" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(adapter.attemptedSessionIds).toEqual([
        fixedSession.id,
        poolBackupSession.id,
      ]);
      expect(adapter.lastOptions?.sessionId).toBe(poolBackupSession.id);
    } finally {
      await app.close();
      database.close();
    }
  });

  it("resolves dynamic pool members by quota threshold during preview and live routing", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const database = new GatewayDatabase(paths);
    const logger = new AppLogger(paths, database);
    const configStore = new ConfigStore(paths);
    const sessionLow = createResolvedSession({
      id: "main:fake:pool-low",
      profileId: "fake:pool-low",
      accountId: "acct_pool_low",
      quotaPercentage: 12,
    });
    const sessionHigh = createResolvedSession({
      id: "main:fake:pool-high",
      profileId: "fake:pool-high",
      accountId: "acct_pool_high",
      quotaPercentage: 82,
    });
    const sessionSource = new PoolSessionSource([sessionLow, sessionHigh]);
    const adapter = new SessionBackedProviderAdapter(sessionSource);
    const modelRegistry = new ModelRegistry([
      {
        alias: "fake-default",
        displayName: "Fake Default",
        provider: "fake-provider",
        providerModelId: "fake-model-1",
        contextWindow: 100_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
      },
    ]);
    const providerRegistry = new ProviderRegistry([adapter]);
    const runtime = new GatewayRuntime(
      paths,
      configStore,
      database,
      logger,
      modelRegistry,
      sessionSource,
      providerRegistry,
    );
    runtime.setActiveSessionId(sessionLow.id);
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-openclaw",
          name: "OpenClaw 池",
          enabled: true,
          selectionStrategy: "quota-desc",
          minRemainingPercentage: 15,
          members: [
            { selector: sessionLow.accountId!, priority: 10 },
            { selector: sessionHigh.accountId!, priority: 20 },
          ],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-openclaw-pool",
          name: "openclaw-pool-route",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "openclaw",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "dynamic-pool",
            modelAlias: "fake-default",
            poolId: "pool-openclaw",
          },
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const adminToken = runtime.configStore.getAdminToken();
      const poolSettings = await app.inject({
        method: "GET",
        url: "/admin/config/pools",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(poolSettings.statusCode).toBe(200);
      expect(poolSettings.json()).toMatchObject({
        ok: true,
        data: {
          enabled: true,
          pools: [{ id: "pool-openclaw" }],
        },
      });

      const preview = await app.inject({
        method: "POST",
        url: "/admin/config/routing/preview",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          clientTag: "openclaw",
          requestedModelAlias: "fake-default",
          currentModelAlias: "fake-default",
          currentSessionId: sessionLow.id,
        },
      });

      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        ok: true,
        data: {
          reason: "rule_matched",
          resolvedPoolId: "pool-openclaw",
          resolvedSessionId: sessionHigh.id,
          candidateCount: 1,
          selectionReason: "按剩余额度优先选择",
        },
      });
      expect(preview.json().data.rejectedCandidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            selector: sessionLow.accountId,
            sessionId: sessionLow.id,
            reason: expect.stringContaining("低于阈值"),
          }),
        ]),
      );

      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "ping" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(adapter.lastOptions?.sessionId).toBe(sessionHigh.id);

      const usageSummary = await app.inject({
        method: "GET",
        url: "/admin/usage/summary?clientFilter=openclaw",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(usageSummary.statusCode).toBe(200);
      expect(usageSummary.json().data.daily.pools[0]).toMatchObject({
        poolId: "pool-openclaw",
        usage: {
          requestCount: 1,
          totalTokens: 12,
        },
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it("retries the next dynamic pool member when the first selected account is quota exhausted", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const database = new GatewayDatabase(paths);
    const logger = new AppLogger(paths, database);
    const configStore = new ConfigStore(paths);
    const sessionA = createResolvedSession({
      id: "main:fake:pool-a",
      profileId: "fake:pool-a",
      accountId: "acct_pool_a",
      quotaPercentage: 90,
    });
    const sessionB = createResolvedSession({
      id: "main:fake:pool-b",
      profileId: "fake:pool-b",
      accountId: "acct_pool_b",
      quotaPercentage: 76,
    });
    const sessionSource = new PoolSessionSource([sessionA, sessionB]);
    const adapter = new FailableSessionBackedProviderAdapter(sessionSource, {
      [sessionA.id]: [new Error("usage_limit_reached")],
    });
    const modelRegistry = new ModelRegistry([
      {
        alias: "fake-default",
        displayName: "Fake Default",
        provider: "fake-provider",
        providerModelId: "fake-model-1",
        contextWindow: 100_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
      },
    ]);
    const providerRegistry = new ProviderRegistry([adapter]);
    const runtime = new GatewayRuntime(
      paths,
      configStore,
      database,
      logger,
      modelRegistry,
      sessionSource,
      providerRegistry,
    );
    runtime.setActiveSessionId(sessionB.id);
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-rotate",
          name: "自动切号池",
          enabled: true,
          selectionStrategy: "priority",
          minRemainingPercentage: 10,
          maxRetryCandidates: 2,
          members: [
            { selector: sessionA.accountId!, priority: 10 },
            { selector: sessionB.accountId!, priority: 20 },
          ],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-localraghub-pool",
          name: "localraghub-pool-route",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "localraghub",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "dynamic-pool",
            modelAlias: "fake-default",
            poolId: "pool-rotate",
          },
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const adminToken = runtime.configStore.getAdminToken();
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "localraghub",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "ping" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(adapter.attemptedSessionIds).toEqual([sessionA.id, sessionB.id]);
      expect(adapter.lastOptions?.sessionId).toBe(sessionB.id);

      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().routingObservability.recent[0]).toMatchObject({
        resolvedSessionId: sessionB.id,
      });
      expect(adminHealth.json().routingObservability.recent[0]?.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("已将请求从"),
        ]),
      );
      expect(adminHealth.json().poolObservability).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            poolId: "pool-rotate",
            eligibleMemberCount: 1,
            coolingMemberCount: 1,
            selectedSessionId: sessionB.id,
            recentEvents: expect.arrayContaining([
              expect.objectContaining({
                eventType: "failover",
                fromSessionId: sessionA.id,
                toSessionId: sessionB.id,
                failureClass: "quota_exhausted",
                clientTag: "localraghub",
                requestedModelAlias: "fake-default",
              }),
            ]),
            members: expect.arrayContaining([
              expect.objectContaining({
                selector: sessionA.accountId,
                sessionId: sessionA.id,
                status: "cooldown",
                lastFailureClass: "quota_exhausted",
              }),
              expect.objectContaining({
                selector: sessionB.accountId,
                sessionId: sessionB.id,
                selected: true,
                eligible: true,
              }),
            ]),
          }),
        ]),
      );
    } finally {
      await app.close();
      database.close();
    }
  });

  it("honors upstream retry-after hint when putting pool members into cooldown", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const database = new GatewayDatabase(paths);
    const logger = new AppLogger(paths, database);
    const configStore = new ConfigStore(paths);
    const sessionA = createResolvedSession({
      id: "main:fake:retry-after-a",
      profileId: "fake:retry-after-a",
      accountId: "acct_retry_after_a",
      quotaPercentage: 94,
    });
    const sessionB = createResolvedSession({
      id: "main:fake:retry-after-b",
      profileId: "fake:retry-after-b",
      accountId: "acct_retry_after_b",
      quotaPercentage: 88,
    });
    const sessionSource = new PoolSessionSource([sessionA, sessionB]);
    const adapter = new FailableSessionBackedProviderAdapter(sessionSource, {
      [sessionA.id]: [new Error("[status:429][retry-after:180] rate limited")],
    });
    const modelRegistry = new ModelRegistry([
      {
        alias: "fake-default",
        displayName: "Fake Default",
        provider: "fake-provider",
        providerModelId: "fake-model-1",
        contextWindow: 100_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
      },
    ]);
    const providerRegistry = new ProviderRegistry([adapter]);
    const runtime = new GatewayRuntime(
      paths,
      configStore,
      database,
      logger,
      modelRegistry,
      sessionSource,
      providerRegistry,
    );
    runtime.setActiveSessionId(sessionB.id);
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-retry-after",
          name: "Retry-After 池",
          enabled: true,
          selectionStrategy: "priority",
          members: [
            { selector: sessionA.accountId!, priority: 10 },
            { selector: sessionB.accountId!, priority: 20 },
          ],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-openclaw-pool-retry-after",
          name: "openclaw-pool-retry-after",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "openclaw",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "dynamic-pool",
            modelAlias: "fake-default",
            poolId: "pool-retry-after",
          },
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const startedAt = Date.now();
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "ping" }],
        },
      });
      expect(response.statusCode).toBe(200);

      const adminToken = runtime.configStore.getAdminToken();
      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      const memberA = adminHealth
        .json()
        .poolObservability.find((pool: { poolId: string }) => pool.poolId === "pool-retry-after")
        ?.members.find((member: { sessionId?: string }) => member.sessionId === sessionA.id);
      expect(memberA?.status).toBe("cooldown");
      expect(memberA?.lastFailureClass).toBe("rate_limited");
      expect(typeof memberA?.cooldownUntil).toBe("number");
      expect((memberA?.cooldownUntil as number) - startedAt).toBeGreaterThanOrEqual(170_000);
    } finally {
      await app.close();
      database.close();
    }
  });

  it("classifies tagged upstream 403 as auth_invalid and marks failed member accordingly", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const database = new GatewayDatabase(paths);
    const logger = new AppLogger(paths, database);
    const configStore = new ConfigStore(paths);
    const sessionA = createResolvedSession({
      id: "main:fake:auth403-a",
      profileId: "fake:auth403-a",
      accountId: "acct_auth403_a",
      quotaPercentage: 90,
    });
    const sessionB = createResolvedSession({
      id: "main:fake:auth403-b",
      profileId: "fake:auth403-b",
      accountId: "acct_auth403_b",
      quotaPercentage: 83,
    });
    const sessionSource = new PoolSessionSource([sessionA, sessionB]);
    const adapter = new FailableSessionBackedProviderAdapter(sessionSource, {
      [sessionA.id]: [new Error("[status:403] oauth rejected by upstream")],
    });
    const modelRegistry = new ModelRegistry([
      {
        alias: "fake-default",
        displayName: "Fake Default",
        provider: "fake-provider",
        providerModelId: "fake-model-1",
        contextWindow: 100_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
      },
    ]);
    const providerRegistry = new ProviderRegistry([adapter]);
    const runtime = new GatewayRuntime(
      paths,
      configStore,
      database,
      logger,
      modelRegistry,
      sessionSource,
      providerRegistry,
    );
    runtime.setActiveSessionId(sessionB.id);
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-auth403",
          name: "Auth403 池",
          enabled: true,
          selectionStrategy: "priority",
          members: [
            { selector: sessionA.accountId!, priority: 10 },
            { selector: sessionB.accountId!, priority: 20 },
          ],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-hermes-auth403",
          name: "hermes-auth403",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "hermes",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "dynamic-pool",
            modelAlias: "fake-default",
            poolId: "pool-auth403",
          },
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "hermes",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "ping" }],
        },
      });
      expect(response.statusCode).toBe(200);

      const adminToken = runtime.configStore.getAdminToken();
      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      const memberA = adminHealth
        .json()
        .poolObservability.find((pool: { poolId: string }) => pool.poolId === "pool-auth403")
        ?.members.find((member: { sessionId?: string }) => member.sessionId === sessionA.id);
      expect(memberA?.status).toBe("cooldown");
      expect(memberA?.lastFailureClass).toBe("auth_invalid");
    } finally {
      await app.close();
      database.close();
    }
  });

  it("updates dynamic pool runtime timestamps for streaming requests", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const database = new GatewayDatabase(paths);
    const logger = new AppLogger(paths, database);
    const configStore = new ConfigStore(paths);
    const sessionA = createResolvedSession({
      id: "main:fake:stream-a",
      profileId: "fake:stream-a",
      accountId: "acct_stream_a",
      quotaPercentage: 86,
    });
    const sessionSource = new PoolSessionSource([sessionA]);
    const adapter = new SessionBackedProviderAdapter(sessionSource);
    const modelRegistry = new ModelRegistry([
      {
        alias: "fake-default",
        displayName: "Fake Default",
        provider: "fake-provider",
        providerModelId: "fake-model-1",
        contextWindow: 100_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
      },
    ]);
    const providerRegistry = new ProviderRegistry([adapter]);
    const runtime = new GatewayRuntime(
      paths,
      configStore,
      database,
      logger,
      modelRegistry,
      sessionSource,
      providerRegistry,
    );
    runtime.setActiveSessionId(sessionA.id);
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-stream",
          name: "流式测试池",
          enabled: true,
          selectionStrategy: "priority",
          members: [{ selector: sessionA.accountId!, priority: 10 }],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-stream-pool",
          name: "stream-pool-route",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "openclaw",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "dynamic-pool",
            modelAlias: "fake-default",
            poolId: "pool-stream",
          },
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const adminToken = runtime.configStore.getAdminToken();
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          stream: true,
          messages: [{ role: "user", content: "ping" }],
        },
      });

      expect(response.statusCode).toBe(200);

      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().poolObservability).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            poolId: "pool-stream",
            members: expect.arrayContaining([
              expect.objectContaining({
                selector: sessionA.accountId,
                sessionId: sessionA.id,
                selected: true,
                lastSelectedAt: expect.any(Number),
                lastSuccessAt: expect.any(Number),
              }),
            ]),
          }),
        ]),
      );
    } finally {
      await app.close();
      database.close();
    }
  });

  it("retries another pool member when streaming fails before first chunk", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const database = new GatewayDatabase(paths);
    const logger = new AppLogger(paths, database);
    const configStore = new ConfigStore(paths);
    const sessionA = createResolvedSession({
      id: "main:fake:stream-pre-a",
      profileId: "fake:stream-pre-a",
      accountId: "acct_stream_pre_a",
      quotaPercentage: 88,
    });
    const sessionB = createResolvedSession({
      id: "main:fake:stream-pre-b",
      profileId: "fake:stream-pre-b",
      accountId: "acct_stream_pre_b",
      quotaPercentage: 74,
    });
    const sessionSource = new PoolSessionSource([sessionA, sessionB]);
    const adapter = new StreamFailableSessionBackedProviderAdapter(sessionSource, {
      [sessionA.id]: [new Error("network reconnecting")],
    });
    const modelRegistry = new ModelRegistry([
      {
        alias: "fake-default",
        displayName: "Fake Default",
        provider: "fake-provider",
        providerModelId: "fake-model-1",
        contextWindow: 100_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
      },
    ]);
    const providerRegistry = new ProviderRegistry([adapter]);
    const runtime = new GatewayRuntime(
      paths,
      configStore,
      database,
      logger,
      modelRegistry,
      sessionSource,
      providerRegistry,
    );
    runtime.setActiveSessionId(sessionA.id);
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-stream-pre-first-chunk",
          name: "流式首字节切号池",
          enabled: true,
          selectionStrategy: "priority",
          maxRetryCandidates: 2,
          members: [
            { selector: sessionA.accountId!, priority: 10 },
            { selector: sessionB.accountId!, priority: 20 },
          ],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-stream-pre-first-chunk",
          name: "stream-pre-first-chunk",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "openclaw",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "dynamic-pool",
            modelAlias: "fake-default",
            poolId: "pool-stream-pre-first-chunk",
          },
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          stream: true,
          messages: [{ role: "user", content: "ping" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("data: [DONE]");
      expect(adapter.attemptedSessionIds).toEqual([sessionA.id, sessionB.id]);
    } finally {
      await app.close();
      database.close();
    }
  });

  it("restores dynamic pool runtime snapshots across runtime restarts", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const sessionA = createResolvedSession({
      id: "main:fake:restore-a",
      profileId: "fake:restore-a",
      accountId: "acct_restore_a",
      quotaPercentage: 81,
    });

    const firstDatabase = new GatewayDatabase(paths);
    const firstLogger = new AppLogger(paths, firstDatabase);
    const firstConfigStore = new ConfigStore(paths);
    const firstSessionSource = new PoolSessionSource([sessionA]);
    const firstAdapter = new SessionBackedProviderAdapter(firstSessionSource);
    const modelRegistry = new ModelRegistry([
      {
        alias: "fake-default",
        displayName: "Fake Default",
        provider: "fake-provider",
        providerModelId: "fake-model-1",
        contextWindow: 100_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
      },
    ]);
    const firstProviderRegistry = new ProviderRegistry([firstAdapter]);
    const firstRuntime = new GatewayRuntime(
      paths,
      firstConfigStore,
      firstDatabase,
      firstLogger,
      modelRegistry,
      firstSessionSource,
      firstProviderRegistry,
    );
    firstRuntime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-restore",
          name: "恢复测试池",
          enabled: true,
          selectionStrategy: "priority",
          members: [{ selector: sessionA.accountId!, priority: 10 }],
        },
      ],
    });

    firstRuntime.selectSessionFromPool({ poolId: "pool-restore" });
    firstRuntime.recordPoolSelectionSuccess("pool-restore", sessionA.id);
    firstDatabase.close();

    const secondDatabase = new GatewayDatabase(paths);
    const secondLogger = new AppLogger(paths, secondDatabase);
    const secondConfigStore = new ConfigStore(paths);
    const secondSessionSource = new PoolSessionSource([sessionA]);
    const secondProviderRegistry = new ProviderRegistry([
      new SessionBackedProviderAdapter(secondSessionSource),
    ]);
    const secondRuntime = new GatewayRuntime(
      paths,
      secondConfigStore,
      secondDatabase,
      secondLogger,
      modelRegistry,
      secondSessionSource,
      secondProviderRegistry,
    );
    const secondApp = createGatewayApp(secondRuntime);

    try {
      const adminToken = secondRuntime.configStore.getAdminToken();
      const adminHealth = await secondApp.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().poolObservability).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            poolId: "pool-restore",
            members: expect.arrayContaining([
              expect.objectContaining({
                selector: sessionA.accountId,
                sessionId: sessionA.id,
                lastSelectedAt: expect.any(Number),
                lastSuccessAt: expect.any(Number),
              }),
            ]),
          }),
        ]),
      );
    } finally {
      await secondApp.close();
      secondDatabase.close();
    }
  });

  it("persists routing and session activity telemetry across runtime restarts", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);

    const first = createTestRuntime({ rootDir });
    const firstApp = createGatewayApp(first.runtime);
    try {
      first.runtime.recordInferenceResult({
        sessionId: "main:fake:default",
        ok: true,
        stream: false,
        clientTag: "localraghub",
        happenedAt: Date.now(),
      });
      first.runtime.recordRoutingHit({
        timestamp: Date.now(),
        clientTag: "localraghub",
        requestedModelAlias: "fake-default",
        resolvedModelAlias: "fake-routed",
        resolvedSessionId: "main:fake:default",
        matchedRuleId: "rule-persist",
        matchedRuleName: "persist-rule",
        modelApplied: true,
        sessionApplied: false,
      });
    } finally {
      await firstApp.close();
      first.database.close();
    }

    const second = createTestRuntime({ rootDir });
    const secondApp = createGatewayApp(second.runtime);
    try {
      const adminToken = second.runtime.configStore.getAdminToken();
      const sessions = await secondApp.inject({
        method: "GET",
        url: "/admin/sessions",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json().data[0]?.activity).toMatchObject({
        requestCount: 1,
        successCount: 1,
        recentRequestCount5m: 1,
        recentRequestCount1h: 1,
        recentRequestCount24h: 1,
        byClientTag: [
          {
            clientTag: "localraghub",
            requestCount: 1,
          },
        ],
        recentByClientTag5m: [
          {
            clientTag: "localraghub",
            requestCount: 1,
          },
        ],
        recentByClientTag1h: [
          {
            clientTag: "localraghub",
            requestCount: 1,
          },
        ],
        recentByClientTag24h: [
          {
            clientTag: "localraghub",
            requestCount: 1,
          },
        ],
      });

      const adminHealth = await secondApp.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().routingObservability).toMatchObject({
        totalMatched: 1,
      });
      expect(adminHealth.json().routingObservability.byClientTag[0]).toMatchObject({
        clientTag: "localraghub",
        hits: 1,
      });
    } finally {
      await secondApp.close();
      second.database.close();
    }
  });

  it("clears telemetry by admin endpoint without affecting sessions", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);

    try {
      runtime.recordInferenceResult({
        sessionId: "main:fake:default",
        ok: true,
        stream: false,
        clientTag: "localraghub",
      });
      runtime.recordRoutingHit({
        timestamp: Date.now(),
        clientTag: "localraghub",
        requestedModelAlias: "fake-default",
        resolvedModelAlias: "fake-routed",
        resolvedSessionId: "main:fake:default",
        matchedRuleId: "rule-reset",
        matchedRuleName: "reset-rule",
        modelApplied: true,
        sessionApplied: false,
      });

      const adminToken = runtime.configStore.getAdminToken();
      const reset = await app.inject({
        method: "POST",
        url: "/admin/telemetry/reset",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toMatchObject({ ok: true, reset: true });

      const sessions = await app.inject({
        method: "GET",
        url: "/admin/sessions",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json().data[0]?.id).toBe("main:fake:default");
      expect(sessions.json().data[0]?.activity).toBeUndefined();

      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().routingObservability).toMatchObject({
        totalMatched: 0,
        matchedLast5m: 0,
        matchedLast1h: 0,
        matchedLast24h: 0,
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it("prunes persisted access alert events by row count", async () => {
    const { rootDir, database } = createTestRuntime();
    cleanupDirs.push(rootDir);

    try {
      database.insertAccessAlertEvent({
        timestamp: Date.now() - 3_000,
        severity: "warning",
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        type: "access_policy_daily_quota_exceeded",
        message: "oldest",
      });
      database.insertAccessAlertEvent({
        timestamp: Date.now() - 2_000,
        severity: "warning",
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        type: "access_policy_rate_limit_exceeded",
        message: "middle",
      });
      database.insertAccessAlertEvent({
        timestamp: Date.now() - 1_000,
        severity: "warning",
        consumerId: "consumer-bob",
        accessKeyId: "key-bob",
        type: "access_policy_pool_denied",
        message: "latest",
      });

      database.pruneAccessAlertEvents({ maxRows: 2 });

      expect(database.getRecentAccessAlertEvents(10).map((event) => event.message))
        .toEqual(["latest", "middle"]);
    } finally {
      database.close();
    }
  });

  it("acknowledges persisted access alert events by admin endpoint", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);

    try {
      database.insertAccessAlertEvent({
        timestamp: Date.now() - 1_000,
        severity: "warning",
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        type: "access_policy_daily_quota_exceeded",
        message: "quota exceeded",
      });
      const eventId = database.getRecentAccessAlertEvents(1)[0]?.id;
      expect(eventId).toEqual(expect.any(Number));

      const adminToken = runtime.configStore.getAdminToken();
      const response = await app.inject({
        method: "POST",
        url: `/admin/access/alerts/${eventId}/acknowledge`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        body: {
          acknowledgedBy: "desktop-admin",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        data: {
          id: eventId,
          acknowledgedBy: "desktop-admin",
        },
      });
      expect(response.json().data.acknowledgedAt).toEqual(expect.any(Number));

      const alerts = await app.inject({
        method: "GET",
        url: "/admin/access/alerts?limit=5",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(alerts.statusCode).toBe(200);
      expect(alerts.json().data.events[0]).toMatchObject({
        id: eventId,
        acknowledgedAt: response.json().data.acknowledgedAt,
        acknowledgedBy: "desktop-admin",
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it("returns streaming SSE and tool calls", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);

    try {
      const streamResponse = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
        },
        payload: {
          model: "fake-default",
          stream: true,
          messages: [
            { role: "user", content: "Use a tool." },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get weather",
                parameters: {
                  type: "object",
                  properties: {
                    city: { type: "string" },
                  },
                },
              },
            },
          ],
        },
      });

      expect(streamResponse.statusCode).toBe(200);
      expect(streamResponse.headers["content-type"]).toContain("text/event-stream");
      expect(streamResponse.body).toContain("\"role\":\"assistant\"");
      expect(streamResponse.body).toContain("\"get_weather\"");
      expect(streamResponse.body).toContain("data: [DONE]");
    } finally {
      await app.close();
      database.close();
    }
  });

  it("enforces optional gateway inference api key auth", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      apiKey: "gateway-secret",
    });
    const app = createGatewayApp(runtime);

    try {
      const missingKey = await app.inject({
        method: "GET",
        url: "/v1/models",
      });
      expect(missingKey.statusCode).toBe(401);
      expect(missingKey.json().error.type).toBe("gateway_api_key_required");

      const invalidKey = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: {
          authorization: "Bearer invalid",
        },
      });
      expect(invalidKey.statusCode).toBe(403);
      expect(invalidKey.json().error.type).toBe("gateway_api_key_invalid");

      const validKey = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: {
          authorization: "Bearer gateway-secret",
        },
      });
      expect(validKey.statusCode).toBe(200);
      expect(validKey.json().data[0]?.id).toBe("fake-default");
    } finally {
      await app.close();
      database.close();
    }
  });

  it("keeps admin endpoints loopback-only even with a valid token", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);
    const adminToken = runtime.configStore.getAdminToken();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/health",
        remoteAddress: "192.168.1.42",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.type).toBe("admin_loopback_required");
    } finally {
      await app.close();
      database.close();
    }
  });

  it("blocks non-loopback inference requests unless LAN access is enabled", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
        remoteAddress: "192.168.1.42",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.type).toBe("lan_access_disabled");
    } finally {
      await app.close();
      database.close();
    }
  });

  it("requires api key auth before enabling LAN access", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);
    const adminToken = runtime.configStore.getAdminToken();

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/config/security",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        body: {
          mode: "none",
          lanAccess: {
            enabled: true,
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.type).toBe("lan_api_key_required");
    } finally {
      await app.close();
      database.close();
    }
  });

  it("allows non-loopback inference requests when LAN access and api key auth are enabled", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      apiKey: "gateway-secret",
      lanAccess: {
        enabled: true,
      },
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
        remoteAddress: "192.168.1.42",
        headers: {
          authorization: "Bearer gateway-secret",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data[0]?.id).toBe("fake-default");
    } finally {
      await app.close();
      database.close();
    }
  });

  it("stores access keys as hashes and exposes only redacted key metadata", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);
    const adminToken = runtime.configStore.getAdminToken();

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/config/security",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        body: {
          mode: "api-key",
          resolveClientTagByApiKey: true,
          accessControl: {
            consumers: [
              {
                id: "consumer-alice",
                name: "Alice",
                type: "lan-member",
                status: "enabled",
                clientTag: "alice",
                tags: ["team"],
              },
            ],
            keys: [
              {
                id: "key-alice",
                consumerId: "consumer-alice",
                name: "Alice MacBook",
                apiKey: "lag_alice_secret_123456",
                status: "enabled",
              },
            ],
            policies: [
              {
                consumerId: "consumer-alice",
                allowedModelAliases: ["fake-default"],
              },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.stringify(response.json())).not.toContain("lag_alice_secret_123456");
      expect(response.json().data.accessControl.keys[0]).toMatchObject({
        id: "key-alice",
        consumerId: "consumer-alice",
        keyPrefix: "lag_alic",
        keySuffix: "3456",
        hasKey: true,
      });

      const stored = runtime.configStore.getInferenceAuthSettings();
      expect(JSON.stringify(stored)).not.toContain("lag_alice_secret_123456");
      expect(stored.accessControl?.keys?.[0]?.keyHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await app.close();
      database.close();
    }
  });

  it("authenticates access keys by hash and resolves consumer client tag", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      resolveClientTagByApiKey: true,
      accessControl: {
        consumers: [
          {
            id: "consumer-alice",
            name: "Alice",
            type: "lan-member",
            status: "enabled",
            clientTag: "alice",
            tags: [],
            createdAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        keys: [
          {
            id: "key-alice",
            consumerId: "consumer-alice",
            name: "Alice MacBook",
            keyHash: "19096294cec548d83b1658b7cc0c5d897a3d69f5cc1bf9d8455625346f3d52d4",
            keyPrefix: "lag_alic",
            keySuffix: "3456",
            status: "enabled",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        policies: [
          {
            consumerId: "consumer-alice",
            allowedModelAliases: ["fake-default"],
          },
        ],
      },
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer lag_alice_secret_123456",
        },
        body: {
          model: "fake-default",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(runtime.getUsageObservability().history.totals.requestCount).toBe(1);
      expect(
        runtime.getUsageObservability().history.clients.find(
          (item) => item.clientTag === "alice",
        )?.usage.requestCount,
      ).toBe(1);
      const usage = runtime.getUsageObservability().history as unknown as {
        consumers?: Array<{
          consumerId: string;
          accessKeyId?: string;
          usage: { requestCount: number };
        }>;
        accessKeys?: Array<{
          accessKeyId: string;
          consumerId?: string;
          usage: { requestCount: number };
        }>;
      };
      expect(
        usage.consumers?.find((item) => item.consumerId === "consumer-alice")
          ?.usage.requestCount,
      ).toBe(1);
      expect(
        usage.accessKeys?.find((item) => item.accessKeyId === "key-alice")
          ?.usage.requestCount,
      ).toBe(1);
    } finally {
      await app.close();
      database.close();
    }
  });

  it("returns hourly consumer timeline for daily usage summary", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);
    const hourMs = 60 * 60 * 1000;
    const currentHour = Math.floor(Date.now() / hourMs) * hourMs;

    try {
      runtime.recordUsageEvent({
        timestamp: currentHour - hourMs + 1_000,
        sessionId: "main:fake:default",
        accountId: "acct_fake",
        email: "alice@example.test",
        clientTag: "alice",
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        providerId: "fake-provider",
        modelAlias: "fake-default",
        upstreamModelId: "fake-model-1",
        success: true,
        stream: false,
        latencyMs: 100,
        inputTokens: 4,
        outputTokens: 3,
        totalTokens: 7,
        cachedTokens: 0,
        reasoningTokens: 0,
      });
      runtime.recordUsageEvent({
        timestamp: currentHour + 1_000,
        sessionId: "main:fake:default",
        accountId: "acct_fake",
        email: "alice@example.test",
        clientTag: "alice",
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        providerId: "fake-provider",
        modelAlias: "fake-default",
        upstreamModelId: "fake-model-1",
        success: true,
        stream: false,
        latencyMs: 120,
        inputTokens: 6,
        outputTokens: 5,
        totalTokens: 11,
        cachedTokens: 0,
        reasoningTokens: 0,
      });
      runtime.recordUsageEvent({
        timestamp: currentHour + 2_000,
        sessionId: "main:fake:default",
        accountId: "acct_fake",
        email: "bob@example.test",
        clientTag: "bob",
        consumerId: "consumer-bob",
        accessKeyId: "key-bob",
        providerId: "fake-provider",
        modelAlias: "fake-default",
        upstreamModelId: "fake-model-1",
        success: false,
        stream: false,
        latencyMs: 200,
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        cachedTokens: 0,
        reasoningTokens: 0,
      });

      const response = await app.inject({
        method: "GET",
        url: "/admin/usage/summary",
        headers: {
          authorization: `Bearer ${runtime.configStore.getAdminToken()}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.daily.consumerTimeline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bucketStart: currentHour - hourMs,
            bucketEnd: currentHour,
            consumerId: "consumer-alice",
            clientTag: "alice",
            usage: expect.objectContaining({
              requestCount: 1,
              totalTokens: 7,
            }),
          }),
          expect.objectContaining({
            bucketStart: currentHour,
            bucketEnd: currentHour + hourMs,
            consumerId: "consumer-alice",
            clientTag: "alice",
            usage: expect.objectContaining({
              requestCount: 1,
              totalTokens: 11,
            }),
          }),
          expect.objectContaining({
            bucketStart: currentHour,
            bucketEnd: currentHour + hourMs,
            consumerId: "consumer-bob",
            clientTag: "bob",
            usage: expect.objectContaining({
              requestCount: 1,
              failureCount: 1,
              totalTokens: 5,
            }),
          }),
        ]),
      );
    } finally {
      await app.close();
      database.close();
    }
  });

  it("rejects access consumers that already reached their daily token quota", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      accessControl: {
        consumers: [
          {
            id: "consumer-alice",
            name: "Alice",
            type: "lan-member",
            status: "enabled",
            clientTag: "alice",
            tags: [],
            createdAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        keys: [
          {
            id: "key-alice",
            consumerId: "consumer-alice",
            name: "Alice MacBook",
            keyHash: "19096294cec548d83b1658b7cc0c5d897a3d69f5cc1bf9d8455625346f3d52d4",
            keyPrefix: "lag_alic",
            keySuffix: "3456",
            status: "enabled",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        policies: [
          {
            consumerId: "consumer-alice",
            allowedModelAliases: ["fake-default"],
            quota: {
              dailyTokenLimit: 10,
            },
          },
        ],
      },
    });
    runtime.recordUsageEvent({
      timestamp: Date.now() - 1_000,
      sessionId: "main:fake:default",
      accountId: "acct_fake",
      email: "alice@example.test",
      clientTag: "alice",
      consumerId: "consumer-alice",
      accessKeyId: "key-alice",
      providerId: "fake-provider",
      modelAlias: "fake-default",
      upstreamModelId: "fake-model-1",
      success: true,
      stream: false,
      latencyMs: 100,
      inputTokens: 6,
      outputTokens: 6,
      totalTokens: 12,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer lag_alice_secret_123456",
        },
        body: {
          model: "fake-default",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(429);
      expect(response.json().error.type).toBe("access_policy_daily_quota_exceeded");
      expect(response.json().error.details).toMatchObject({
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        limit: 10,
        usedTokens: 12,
        remainingTokens: 0,
      });
      expect(response.json().error.details.resetAt).toEqual(expect.any(String));
      expect(response.headers["retry-after"]).toEqual(expect.any(String));
      expect(database.getRecentErrors(1)[0]).toMatchObject({
        message: "request_failed",
        details: {
          errorCode: "access_policy_daily_quota_exceeded",
          statusCode: 429,
          consumerId: "consumer-alice",
          accessKeyId: "key-alice",
        },
      });

      const alerts = await app.inject({
        method: "GET",
        url: "/admin/access/alerts?limit=5",
        headers: {
          authorization: `Bearer ${runtime.configStore.getAdminToken()}`,
        },
      });
      expect(alerts.statusCode).toBe(200);
      expect(alerts.json().data.events[0]).toMatchObject({
        severity: "warning",
        type: "access_policy_daily_quota_exceeded",
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        message: "Access consumer daily token quota has been exceeded.",
        details: {
          errorCode: "access_policy_daily_quota_exceeded",
          statusCode: 429,
          limit: 10,
          usedTokens: 12,
        },
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it("rejects access consumers that exceeded their requests-per-minute limit", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      accessControl: {
        consumers: [
          {
            id: "consumer-alice",
            name: "Alice",
            type: "lan-member",
            status: "enabled",
            clientTag: "alice",
            tags: [],
            createdAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        keys: [
          {
            id: "key-alice",
            consumerId: "consumer-alice",
            name: "Alice MacBook",
            keyHash: "19096294cec548d83b1658b7cc0c5d897a3d69f5cc1bf9d8455625346f3d52d4",
            keyPrefix: "lag_alic",
            keySuffix: "3456",
            status: "enabled",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        policies: [
          {
            consumerId: "consumer-alice",
            allowedModelAliases: ["fake-default"],
            limits: {
              requestsPerMinute: 1,
            },
          },
        ],
      },
    });
    runtime.recordUsageEvent({
      timestamp: Date.now() - 1_000,
      sessionId: "main:fake:default",
      accountId: "acct_fake",
      email: "alice@example.test",
      clientTag: "alice",
      consumerId: "consumer-alice",
      accessKeyId: "key-alice",
      providerId: "fake-provider",
      modelAlias: "fake-default",
      upstreamModelId: "fake-model-1",
      success: true,
      stream: false,
      latencyMs: 100,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer lag_alice_secret_123456",
        },
        body: {
          model: "fake-default",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(429);
      expect(response.json().error.type).toBe("access_policy_rate_limit_exceeded");
      expect(response.json().error.details).toMatchObject({
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        limit: 1,
        usedRequests: 1,
      });
      expect(response.headers["retry-after"]).toBe("60");
    } finally {
      await app.close();
      database.close();
    }
  });

  it("rejects access consumers that reached their concurrent request limit", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      accessControl: {
        consumers: [
          {
            id: "consumer-alice",
            name: "Alice",
            type: "lan-member",
            status: "enabled",
            clientTag: "alice",
            tags: [],
            createdAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        keys: [
          {
            id: "key-alice",
            consumerId: "consumer-alice",
            name: "Alice MacBook",
            keyHash: "19096294cec548d83b1658b7cc0c5d897a3d69f5cc1bf9d8455625346f3d52d4",
            keyPrefix: "lag_alic",
            keySuffix: "3456",
            status: "enabled",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        policies: [
          {
            consumerId: "consumer-alice",
            allowedModelAliases: ["fake-default"],
            limits: {
              maxConcurrentRequests: 1,
            },
          },
        ],
      },
    });
    const inFlightId = runtime.beginInferenceActivity({
      clientTag: "alice",
      requestedModelAlias: "fake-default",
      sessionId: "main:fake:default",
      consumerId: "consumer-alice",
      accessKeyId: "key-alice",
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer lag_alice_secret_123456",
        },
        body: {
          model: "fake-default",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(429);
      expect(response.json().error.type).toBe("access_policy_concurrency_exceeded");
      expect(response.json().error.details).toMatchObject({
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        limit: 1,
        inFlightRequests: 1,
      });
    } finally {
      runtime.finishInferenceActivity(inFlightId);
      await app.close();
      database.close();
    }
  });

  it("reports access policy runtime usage for admin observability", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      accessControl: {
        consumers: [
          {
            id: "consumer-alice",
            name: "Alice",
            type: "lan-member",
            status: "enabled",
            clientTag: "alice",
            tags: [],
            createdAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        keys: [],
        policies: [
          {
            consumerId: "consumer-alice",
            limits: {
              requestsPerMinute: 3,
              maxConcurrentRequests: 2,
            },
          },
        ],
      },
    });
    runtime.recordUsageEvent({
      timestamp: Date.now() - 1_000,
      sessionId: "main:fake:default",
      accountId: "acct_fake",
      clientTag: "alice",
      consumerId: "consumer-alice",
      accessKeyId: "key-alice",
      providerId: "fake-provider",
      modelAlias: "fake-default",
      success: true,
      stream: false,
      latencyMs: 12,
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
    const inFlightId = runtime.beginInferenceActivity({
      clientTag: "alice",
      consumerId: "consumer-alice",
      accessKeyId: "key-alice",
      requestedModelAlias: "fake-default",
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${runtime.configStore.getAdminToken()}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().inferenceObservability.accessConsumers).toEqual([
        {
          consumerId: "consumer-alice",
          recentRequestCount1m: 1,
          inFlightCount: 1,
          requestsPerMinute: 3,
          maxConcurrentRequests: 2,
        },
      ]);
    } finally {
      runtime.finishInferenceActivity(inFlightId);
      await app.close();
      database.close();
    }
  });

  it("rejects access consumers routed to an unauthorized dynamic pool", async () => {
    const { rootDir, runtime, database, adapter } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.setActiveSessionId("main:fake:default");
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-private",
          name: "Private Pool",
          enabled: true,
          selectionStrategy: "priority",
          members: [{ selector: "acct_fake", priority: 10 }],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-alice-private-pool",
          name: "Alice private pool",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "alice",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "dynamic-pool",
            modelAlias: "fake-default",
            poolId: "pool-private",
          },
        },
      ],
    });
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      accessControl: {
        consumers: [
          {
            id: "consumer-alice",
            name: "Alice",
            type: "lan-member",
            status: "enabled",
            clientTag: "alice",
            tags: [],
            createdAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        keys: [
          {
            id: "key-alice",
            consumerId: "consumer-alice",
            name: "Alice MacBook",
            keyHash: "19096294cec548d83b1658b7cc0c5d897a3d69f5cc1bf9d8455625346f3d52d4",
            keyPrefix: "lag_alic",
            keySuffix: "3456",
            status: "enabled",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        policies: [
          {
            consumerId: "consumer-alice",
            allowedModelAliases: ["fake-default"],
            allowedPoolIds: ["pool-allowed"],
          },
        ],
      },
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer lag_alice_secret_123456",
        },
        body: {
          model: "fake-default",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.type).toBe("access_policy_pool_denied");
      expect(response.json().error.details).toMatchObject({
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        poolId: "pool-private",
      });
      expect(adapter.lastOptions).toBeUndefined();
    } finally {
      await app.close();
      database.close();
    }
  });

  it("rejects LAN access consumers routed to a private dynamic pool", async () => {
    const { rootDir, runtime, database, adapter } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.setActiveSessionId("main:fake:default");
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-private",
          name: "Private Pool",
          enabled: true,
          visibility: "private",
          selectionStrategy: "priority",
          members: [{ selector: "acct_fake", priority: 10 }],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-alice-private-pool",
          name: "Alice private pool",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "alice",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "dynamic-pool",
            modelAlias: "fake-default",
            poolId: "pool-private",
          },
        },
      ],
    });
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      accessControl: {
        consumers: [
          {
            id: "consumer-alice",
            name: "Alice",
            type: "lan-member",
            status: "enabled",
            clientTag: "alice",
            tags: [],
            createdAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        keys: [
          {
            id: "key-alice",
            consumerId: "consumer-alice",
            name: "Alice MacBook",
            keyHash: "19096294cec548d83b1658b7cc0c5d897a3d69f5cc1bf9d8455625346f3d52d4",
            keyPrefix: "lag_alic",
            keySuffix: "3456",
            status: "enabled",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        policies: [
          {
            consumerId: "consumer-alice",
            allowedModelAliases: ["fake-default"],
            allowedPoolIds: ["pool-private"],
          },
        ],
      },
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer lag_alice_secret_123456",
        },
        body: {
          model: "fake-default",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.type).toBe(
        "access_policy_pool_visibility_denied",
      );
      expect(response.json().error.details).toMatchObject({
        consumerId: "consumer-alice",
        accessKeyId: "key-alice",
        poolId: "pool-private",
        visibility: "private",
      });
      expect(adapter.lastOptions).toBeUndefined();
    } finally {
      await app.close();
      database.close();
    }
  });

  it("previews access consumer pool visibility denial before live routing", async () => {
    const { rootDir, runtime, database, adapter } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.setActiveSessionId("main:fake:default");
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-private",
          name: "Private Pool",
          enabled: true,
          visibility: "private",
          selectionStrategy: "priority",
          members: [{ selector: "acct_fake", priority: 10 }],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-alice-private-pool",
          name: "Alice private pool",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "alice",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "dynamic-pool",
            modelAlias: "fake-default",
            poolId: "pool-private",
          },
        },
      ],
    });
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      accessControl: {
        consumers: [
          {
            id: "consumer-alice",
            name: "Alice",
            type: "lan-member",
            status: "enabled",
            clientTag: "alice",
            tags: [],
            createdAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        keys: [
          {
            id: "key-alice",
            consumerId: "consumer-alice",
            name: "Alice MacBook",
            keyHash: "19096294cec548d83b1658b7cc0c5d897a3d69f5cc1bf9d8455625346f3d52d4",
            keyPrefix: "lag_alic",
            keySuffix: "3456",
            status: "enabled",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        policies: [
          {
            consumerId: "consumer-alice",
            allowedModelAliases: ["fake-default"],
            allowedPoolIds: ["pool-private"],
          },
        ],
      },
    });
    const app = createGatewayApp(runtime);

    try {
      const preview = await app.inject({
        method: "POST",
        url: "/admin/config/routing/preview",
        headers: {
          authorization: `Bearer ${runtime.configStore.getAdminToken()}`,
        },
        body: {
          accessConsumerId: "consumer-alice",
          clientTag: "alice",
          requestedModelAlias: "fake-default",
          currentModelAlias: "fake-default",
          currentSessionId: "main:fake:default",
        },
      });

      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        ok: true,
        data: {
          reason: "rule_matched",
          resolvedPoolId: "pool-private",
          accessDecision: {
            status: "denied",
            consumerId: "consumer-alice",
            consumerName: "Alice",
            consumerType: "lan-member",
            clientTag: "alice",
            errorType: "access_policy_pool_visibility_denied",
            poolId: "pool-private",
            poolVisibility: "private",
          },
        },
      });
      expect(adapter.lastOptions).toBeUndefined();
    } finally {
      await app.close();
      database.close();
    }
  });

  it("allows LAN access consumers routed to an authorized shared-lan dynamic pool", async () => {
    const { rootDir, runtime, database, adapter } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.setActiveSessionId("main:fake:default");
    runtime.configStore.setPoolSettings({
      enabled: true,
      pools: [
        {
          id: "pool-shared",
          name: "Shared Pool",
          enabled: true,
          visibility: "shared-lan",
          selectionStrategy: "priority",
          members: [{ selector: "acct_fake", priority: 10 }],
        },
      ],
    });
    runtime.configStore.setRoutingSettings({
      enabled: true,
      rules: [
        {
          id: "rule-alice-shared-pool",
          name: "Alice shared pool",
          enabled: true,
          priority: 1,
          when: {
            clientTag: "alice",
            requestedModelAlias: "fake-default",
          },
          target: {
            dispatchMode: "dynamic-pool",
            modelAlias: "fake-default",
            poolId: "pool-shared",
          },
        },
      ],
    });
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      accessControl: {
        consumers: [
          {
            id: "consumer-alice",
            name: "Alice",
            type: "lan-member",
            status: "enabled",
            clientTag: "alice",
            tags: [],
            createdAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        keys: [
          {
            id: "key-alice",
            consumerId: "consumer-alice",
            name: "Alice MacBook",
            keyHash: "19096294cec548d83b1658b7cc0c5d897a3d69f5cc1bf9d8455625346f3d52d4",
            keyPrefix: "lag_alic",
            keySuffix: "3456",
            status: "enabled",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        policies: [
          {
            consumerId: "consumer-alice",
            allowedModelAliases: ["fake-default"],
            allowedPoolIds: ["pool-shared"],
          },
        ],
      },
    });
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer lag_alice_secret_123456",
        },
        body: {
          model: "fake-default",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(adapter.lastOptions?.sessionId).toBe("main:fake:default");
    } finally {
      await app.close();
      database.close();
    }
  });

  it("rejects paused, expired, and policy-disallowed access keys", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      accessControl: {
        consumers: [
          {
            id: "consumer-alice",
            name: "Alice",
            type: "lan-member",
            status: "enabled",
            clientTag: "alice",
            tags: [],
            createdAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        keys: [
          {
            id: "key-paused",
            consumerId: "consumer-alice",
            name: "Paused",
            keyHash: "5fd2b4bd4c823941012eabcfabc1d22bdcce5a4009cc3248511da960695341ed",
            keyPrefix: "lag_paus",
            keySuffix: "0000",
            status: "paused",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
          {
            id: "key-expired",
            consumerId: "consumer-alice",
            name: "Expired",
            keyHash: "463ba3c71bcb5c6c4c17ff3dde5618911e8fbdafd7a9648bb7d3cff27de5b5e3",
            keyPrefix: "lag_expi",
            keySuffix: "0000",
            status: "enabled",
            expiresAt: "2020-01-01T00:00:00.000Z",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
          {
            id: "key-model",
            consumerId: "consumer-alice",
            name: "Model Limited",
            keyHash: "9e599ef3b9c96e680f56c2d74ce64f1084043432c0a61a57c9f41c2a69e2ff5b",
            keyPrefix: "lag_mode",
            keySuffix: "0000",
            status: "enabled",
            createdAt: "2026-05-16T00:00:00.000Z",
          },
        ],
        policies: [
          {
            consumerId: "consumer-alice",
            allowedModelAliases: ["fake-routed"],
          },
        ],
      },
    });
    const app = createGatewayApp(runtime);

    try {
      const paused = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: {
          authorization: "Bearer lag_paused_secret_0000",
        },
      });
      expect(paused.statusCode).toBe(403);
      expect(paused.json().error.type).toBe("access_key_paused");

      const expired = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: {
          authorization: "Bearer lag_expired_secret_0000",
        },
      });
      expect(expired.statusCode).toBe(403);
      expect(expired.json().error.type).toBe("access_key_expired");

      const disallowed = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer lag_model_secret_0000",
        },
        body: {
          model: "fake-default",
          messages: [{ role: "user", content: "Hello" }],
        },
      });
      expect(disallowed.statusCode).toBe(403);
      expect(disallowed.json().error.type).toBe("access_policy_model_denied");
    } finally {
      await app.close();
      database.close();
    }
  });

  it("accepts mapped client api keys and resolves client tag from mapping", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      resolveClientTagByApiKey: true,
      clientMappings: [
        {
          name: "Hermes",
          apiKey: "hermes-client-key",
          clientTag: "hermes",
          enabled: true,
          allowHeaderOverride: false,
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const modelsResponse = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: {
          authorization: "Bearer hermes-client-key",
        },
      });
      expect(modelsResponse.statusCode).toBe(200);

      const chatResponse = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer hermes-client-key",
          "content-type": "application/json",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "Reply with exactly OK." }],
        },
      });
      expect(chatResponse.statusCode).toBe(200);

      const adminToken = runtime.configStore.getAdminToken();
      const usageSummary = await app.inject({
        method: "GET",
        url: "/admin/usage/summary?clientFilter=hermes",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(usageSummary.statusCode).toBe(200);
      expect(usageSummary.json().data.daily.clients[0]).toMatchObject({
        clientTag: "hermes",
      });
      expect(usageSummary.json().data.daily.totals.requestCount).toBe(1);
    } finally {
      await app.close();
      database.close();
    }
  });

  it("respects allowHeaderOverride for mapped client keys", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.configStore.setInferenceAuthSettings({
      mode: "api-key",
      resolveClientTagByApiKey: true,
      clientMappings: [
        {
          name: "Hermes",
          apiKey: "hermes-client-key",
          clientTag: "hermes",
          enabled: true,
          allowHeaderOverride: false,
        },
      ],
    });
    const app = createGatewayApp(runtime);

    try {
      const first = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer hermes-client-key",
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "Reply with exactly OK." }],
        },
      });
      expect(first.statusCode).toBe(200);

      runtime.configStore.setInferenceAuthSettings({
        mode: "api-key",
        resolveClientTagByApiKey: true,
        clientMappings: [
          {
            name: "Hermes",
            apiKey: "hermes-client-key",
            clientTag: "hermes",
            enabled: true,
            allowHeaderOverride: true,
          },
        ],
      });

      const second = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer hermes-client-key",
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "Reply with exactly OK." }],
        },
      });
      expect(second.statusCode).toBe(200);

      const adminToken = runtime.configStore.getAdminToken();
      const usageSummary = await app.inject({
        method: "GET",
        url: "/admin/usage/summary",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(usageSummary.statusCode).toBe(200);
      const clients = usageSummary.json().data.daily.clients as Array<{
        clientTag: string;
        usage: { requestCount: number };
      }>;
      const hermesUsage = clients.find((item) => item.clientTag === "hermes");
      const openclawUsage = clients.find((item) => item.clientTag === "openclaw");
      expect(hermesUsage?.usage.requestCount).toBe(1);
      expect(openclawUsage?.usage.requestCount).toBe(1);
    } finally {
      await app.close();
      database.close();
    }
  });

  it("opens client circuit and returns 429 with retry-after after repeated retryable failures", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const database = new GatewayDatabase(paths);
    const logger = new AppLogger(paths, database);
    const configStore = new ConfigStore(paths);
    const sessionSource = new FakeSessionSource();
    const adapter = new FailableSessionBackedProviderAdapter(sessionSource, {
      [sessionSource.session.id]: [
        new Error("network timeout"),
        new Error("network timeout"),
        new Error("network timeout"),
        new Error("network timeout"),
        new Error("network timeout"),
      ],
    });
    const modelRegistry = new ModelRegistry([
      {
        alias: "fake-default",
        displayName: "Fake Default",
        provider: "fake-provider",
        providerModelId: "fake-model-1",
        contextWindow: 100_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
      },
    ]);
    const providerRegistry = new ProviderRegistry([adapter]);
    const runtime = new GatewayRuntime(
      paths,
      configStore,
      database,
      logger,
      modelRegistry,
      sessionSource,
      providerRegistry,
    );
    runtime.setActiveSessionId(sessionSource.session.id);
    const app = createGatewayApp(runtime);

    try {
      for (let index = 0; index < 4; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: {
            "content-type": "application/json",
            "x-client-tag": "openclaw",
          },
          payload: {
            model: "fake-default",
            messages: [{ role: "user", content: "ping" }],
          },
        });
        expect(response.statusCode).toBe(502);
      }

      const blocked = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "ping" }],
        },
      });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.type).toBe("client_temporarily_blocked");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(adapter.attemptedSessionIds).toHaveLength(4);

      const adminToken = runtime.configStore.getAdminToken();
      const adminHealth = await app.inject({
        method: "GET",
        url: "/admin/health",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(adminHealth.statusCode).toBe(200);
      expect(adminHealth.json().inferenceObservability?.blockedClients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            clientTag: "openclaw",
            lastFailureClass: "network_retryable",
          }),
        ]),
      );

      const resetCircuit = await app.inject({
        method: "POST",
        url: "/admin/telemetry/circuit/reset",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          clientTag: "openclaw",
        },
      });
      expect(resetCircuit.statusCode).toBe(200);
      expect(resetCircuit.json()).toMatchObject({
        ok: true,
        cleared: 1,
      });

      const afterReset = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "x-client-tag": "openclaw",
        },
        payload: {
          model: "fake-default",
          messages: [{ role: "user", content: "ping" }],
        },
      });
      expect(afterReset.statusCode).toBe(502);
      expect(adapter.attemptedSessionIds).toHaveLength(5);
    } finally {
      await app.close();
      database.close();
    }
  });

  it("rejects unauthorized admin requests and unknown models", async () => {
    const { rootDir, runtime, database } = createTestRuntime();
    cleanupDirs.push(rootDir);
    const app = createGatewayApp(runtime);

    try {
      const unauthorized = await app.inject({
        method: "GET",
        url: "/admin/health",
      });
      expect(unauthorized.statusCode).toBe(401);

      const unknownModel = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
        },
        payload: {
          model: "missing-model",
          messages: [{ role: "user", content: "hello" }],
        },
      });
      expect(unknownModel.statusCode).toBe(400);
      expect(unknownModel.json().error.type).toBe("model_not_found");
    } finally {
      await app.close();
      database.close();
    }
  });
});
