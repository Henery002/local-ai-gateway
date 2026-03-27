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

function createTestRuntime(options?: { serverHost?: string; serverPort?: number }) {
  const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-test-"));
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
    const { rootDir, runtime, database } = createTestRuntime();
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

  it("returns non-stream chat completions and forwards context/options", async () => {
    const { rootDir, runtime, database, adapter } = createTestRuntime();
    cleanupDirs.push(rootDir);
    runtime.setActiveSessionId("main:fake:default");
    const app = createGatewayApp(runtime);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
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
      });
      expect(typeof sessions.json().data[0]?.activity?.lastRequestAt).toBe("number");
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
