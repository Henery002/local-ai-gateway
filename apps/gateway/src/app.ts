import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";

import {
  buildChatCompletionResponse,
  buildModelsResponse,
  parseChatCompletionsRequest,
  serializeSse,
  streamChatCompletionChunks,
  toGatewayConversationContext,
} from "@local-ai-gateway/openai-compat";
import {
  GatewayError,
  GatewayInferenceAuthSettings,
  GatewayProviderSettings,
  GatewayRoutingPreviewInput,
  GatewayRoutingSettings,
  SessionSummary,
} from "@local-ai-gateway/shared";

import { GatewayRuntime } from "./runtime.js";

function buildErrorBody(error: GatewayError | Error) {
  if (error instanceof GatewayError) {
    return {
      error: {
        type: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  return {
    error: {
      type: "internal_error",
      message: error.message,
    },
  };
}

function getStatusCode(error: GatewayError | Error): number {
  return error instanceof GatewayError ? error.statusCode : 500;
}

function requireAdminAuth(
  runtime: GatewayRuntime,
  request: FastifyRequest,
): void {
  const authHeader = request.headers.authorization;
  const expected = `Bearer ${runtime.configStore.getAdminToken()}`;

  if (authHeader !== expected) {
    throw new GatewayError(401, "unauthorized", "Admin token is missing or invalid.");
  }
}

function ensureSessionExists(sessions: SessionSummary[], sessionId: string): SessionSummary {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new GatewayError(400, "session_not_found", `Unknown session: ${sessionId}`);
  }
  return session;
}

function getFirstHeaderValue(
  request: FastifyRequest,
  key: string,
): string | undefined {
  const value = request.headers[key];
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim().length > 0);
    return typeof first === "string" ? first.trim() : undefined;
  }
  return undefined;
}

function resolveClientTag(request: FastifyRequest): string | undefined {
  const explicit =
    getFirstHeaderValue(request, "x-local-ai-client-tag") ??
    getFirstHeaderValue(request, "x-client-tag") ??
    getFirstHeaderValue(request, "x-source-app");
  if (explicit) {
    return explicit.trim().toLowerCase();
  }

  const userAgent = getFirstHeaderValue(request, "user-agent")?.toLowerCase();
  if (!userAgent) {
    return undefined;
  }
  if (userAgent.includes("localraghub") || userAgent.includes("raghub")) {
    return "localraghub";
  }
  if (userAgent.includes("openclaw")) {
    return "openclaw";
  }
  if (userAgent.includes("curl")) {
    return "curl";
  }
  return undefined;
}

function isRetryableFixedSessionError(error: unknown): boolean {
  if (error instanceof GatewayError && error.code === "gateway_auth_required") {
    return true;
  }

  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("usage_limit_reached") ||
    message.includes("usage limit has been reached") ||
    message.includes("rate limit")
  );
}

function isRetryableFinalMessageError(message: string | undefined): boolean {
  const normalized = (message ?? "").toLowerCase();
  return (
    normalized.includes("usage_limit_reached") ||
    normalized.includes("usage limit has been reached") ||
    normalized.includes("rate limit")
  );
}

function readClientApiKey(request: FastifyRequest): string | undefined {
  const auth = getFirstHeaderValue(request, "authorization");
  if (auth?.startsWith("Bearer ")) {
    const value = auth.slice("Bearer ".length).trim();
    if (value) {
      return value;
    }
  }
  return getFirstHeaderValue(request, "x-api-key");
}

function requireInferenceAuth(
  runtime: GatewayRuntime,
  request: FastifyRequest,
): void {
  const settings = runtime.configStore.getInferenceAuthSettings();
  const mode = settings.mode === "api-key" ? "api-key" : "none";
  if (mode !== "api-key") {
    return;
  }

  const expectedKey = settings.apiKey?.trim();
  if (!expectedKey) {
    throw new GatewayError(
      503,
      "gateway_api_key_not_configured",
      "Gateway API key auth is enabled but key is not configured.",
    );
  }

  const incomingKey = readClientApiKey(request);
  if (!incomingKey) {
    throw new GatewayError(
      401,
      "gateway_api_key_required",
      "Missing API key for gateway inference endpoint.",
    );
  }

  if (incomingKey !== expectedKey) {
    throw new GatewayError(
      403,
      "gateway_api_key_invalid",
      "Invalid API key for gateway inference endpoint.",
    );
  }
}

export function createGatewayApp(runtime: GatewayRuntime): FastifyInstance {
  const app = Fastify({
    logger: false,
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    runtime.logger.error("request_failed", { message: normalized.message });
    reply.status(getStatusCode(normalized)).send(buildErrorBody(normalized));
  });

  app.get("/healthz", async () => runtime.getHealth());

  app.get("/v1/models", async (request) => {
    requireInferenceAuth(runtime, request);
    return buildModelsResponse(runtime.modelRegistry.list());
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    requireInferenceAuth(runtime, request);
    const parsed = parseChatCompletionsRequest(request.body);
    const startedAt = Date.now();
    const currentSessionId = runtime.getActiveSessionId();
    const clientTag = resolveClientTag(request);
    const routingPreview = runtime.previewRouting({
      clientTag,
      requestedModelAlias: parsed.model,
      currentModelAlias: parsed.model,
      currentSessionId,
    });

    let resolvedModelAlias = parsed.model;
    let resolvedSessionId = currentSessionId;
    const routingWarnings = [...routingPreview.warnings];
    const matchedRule =
      routingPreview.enabled && routingPreview.reason === "rule_matched"
        ? runtime
            .getRoutingSettings()
            .rules?.find((rule) => rule.id === routingPreview.matchedRuleId)
        : undefined;
    const hasExplicitTargetSession = Boolean(
      matchedRule?.target?.sessionId?.trim(),
    );
    const attemptedSessionIds = new Set<string>();
    let routingHitRecorded = false;

    if (routingPreview.enabled && routingPreview.reason === "rule_matched") {
      const routedModel = runtime.getProviderAdapterForModel(routingPreview.resolvedModelAlias);
      if (routedModel) {
        resolvedModelAlias = routingPreview.resolvedModelAlias;
      } else {
        runtime.logger.error("routing_model_fallback", {
          requestedModel: parsed.model,
          routedModel: routingPreview.resolvedModelAlias,
          reason: "model_not_found",
          matchedRuleId: routingPreview.matchedRuleId,
        });
        routingWarnings.push(`目标模型 ${routingPreview.resolvedModelAlias} 未找到，已回退原模型。`);
      }

      if (routingPreview.resolvedSessionId) {
        const hasTargetSession = runtime
          .listSessions()
          .some((session) => session.id === routingPreview.resolvedSessionId);
        if (hasTargetSession) {
          resolvedSessionId = routingPreview.resolvedSessionId;
        } else {
          runtime.logger.error("routing_session_fallback", {
            requestedSession: routingPreview.resolvedSessionId,
            reason: "session_not_found",
            matchedRuleId: routingPreview.matchedRuleId,
          });
          routingWarnings.push(`目标会话 ${routingPreview.resolvedSessionId} 未找到，已回退当前活动会话。`);
        }
      }
    }

    let usedSessionId = resolvedSessionId;
    let hasRecordedResult = false;
    const resolved = runtime.getProviderAdapterForModel(resolvedModelAlias);
    if (!resolved) {
      throw new GatewayError(400, "model_not_found", "Requested model alias is not configured.");
    }

    const recordRoutingHitIfNeeded = (sessionId?: string) => {
      if (
        routingHitRecorded ||
        !routingPreview.enabled ||
        routingPreview.reason !== "rule_matched"
      ) {
        return;
      }

      const finalSessionId = sessionId ?? resolvedSessionId;
      const modelApplied = resolvedModelAlias !== parsed.model;
      const sessionApplied = Boolean(
        finalSessionId && finalSessionId !== currentSessionId,
      );
      runtime.recordRoutingHit({
        timestamp: Date.now(),
        clientTag,
        requestedModelAlias: parsed.model,
        resolvedModelAlias,
        resolvedSessionId: finalSessionId,
        matchedRuleId: routingPreview.matchedRuleId ?? "unknown-rule",
        matchedRuleName: routingPreview.matchedRuleName ?? "未命名规则",
        modelApplied,
        sessionApplied,
        warnings: routingWarnings.length ? routingWarnings : undefined,
      });
      runtime.logger.info("routing_applied", {
        matchedRuleId: routingPreview.matchedRuleId,
        matchedRuleName: routingPreview.matchedRuleName,
        clientTag,
        requestedModel: parsed.model,
        resolvedModelAlias,
        resolvedSessionId: finalSessionId,
        warnings: routingWarnings,
      });
      routingHitRecorded = true;
    };

    const selectFallbackSessionId = (failedSessionId?: string): string | undefined => {
      if (!hasExplicitTargetSession) {
        return undefined;
      }

      const fallback = runtime.resolveFallbackSessionId({
        failedSessionId,
        preferredSessionId: currentSessionId,
      });
      if (!fallback.sessionId || attemptedSessionIds.has(fallback.sessionId)) {
        return undefined;
      }

      const reasonLabel =
        fallback.reason === "preferred-session"
          ? "当前活动账号"
          : "下一个可用账号";
      routingWarnings.push(
        `固定账号 ${failedSessionId ?? "unknown"} 当前不可用，已回退到 ${fallback.sessionId}（${reasonLabel}）。`,
      );
      runtime.logger.info("routing_session_runtime_fallback", {
        matchedRuleId: routingPreview.matchedRuleId,
        failedSessionId,
        fallbackSessionId: fallback.sessionId,
        reason: fallback.reason,
      });
      return fallback.sessionId;
    };

    try {
      const controller = new AbortController();
      request.raw.on("aborted", () => controller.abort());
      const createAttempt = async (sessionId: string | undefined) => {
        if (sessionId) {
          attemptedSessionIds.add(sessionId);
        }
        return resolved.adapter.createStream(
          resolved.model,
          toGatewayConversationContext(parsed),
          {
            sessionId,
            temperature: parsed.temperature,
            maxTokens: parsed.max_tokens,
            topP: parsed.top_p,
            toolChoice: parsed.tool_choice,
            signal: controller.signal,
          },
        );
      };

      let result;
      try {
        result = await createAttempt(resolvedSessionId);
      } catch (error) {
        const fallbackSessionId =
          hasExplicitTargetSession && isRetryableFixedSessionError(error)
            ? selectFallbackSessionId(resolvedSessionId)
            : undefined;
        if (!fallbackSessionId) {
          throw error;
        }
        resolvedSessionId = fallbackSessionId;
        result = await createAttempt(resolvedSessionId);
      }
      usedSessionId = result.session.id;

      if (parsed.stream) {
        recordRoutingHitIfNeeded(usedSessionId);
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });

        for await (const chunk of streamChatCompletionChunks(result.stream, resolvedModelAlias)) {
          reply.raw.write(chunk);
        }

        reply.raw.end();
        if (usedSessionId) {
          runtime.recordInferenceResult({
            sessionId: usedSessionId,
            ok: true,
            stream: true,
            clientTag,
            happenedAt: Date.now(),
          });
          hasRecordedResult = true;
        }
        return reply;
      }

      let finalMessage = await result.stream.result();
      if (
        finalMessage.stopReason === "error" &&
        hasExplicitTargetSession &&
        isRetryableFinalMessageError(finalMessage.errorMessage)
      ) {
        const fallbackSessionId = selectFallbackSessionId(usedSessionId);
        if (fallbackSessionId) {
          resolvedSessionId = fallbackSessionId;
          const retryResult = await createAttempt(fallbackSessionId);
          usedSessionId = retryResult.session.id;
          finalMessage = await retryResult.stream.result();
        }
      }

      recordRoutingHitIfNeeded(usedSessionId);
      if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
        if (usedSessionId) {
          runtime.recordInferenceResult({
            sessionId: usedSessionId,
            ok: false,
            stream: false,
            clientTag,
            happenedAt: Date.now(),
            errorMessage: finalMessage.errorMessage ?? "upstream_error",
          });
          hasRecordedResult = true;
        }
        throw new GatewayError(
          502,
          "upstream_error",
          finalMessage.errorMessage ?? "Codex request failed.",
        );
      }

      if (usedSessionId) {
        runtime.recordInferenceResult({
          sessionId: usedSessionId,
          ok: true,
          stream: false,
          clientTag,
          happenedAt: Date.now(),
        });
        hasRecordedResult = true;
      }
      return buildChatCompletionResponse(finalMessage, resolvedModelAlias);
    } catch (error) {
      recordRoutingHitIfNeeded(usedSessionId);
      if (usedSessionId && !hasRecordedResult) {
        runtime.recordInferenceResult({
          sessionId: usedSessionId,
          ok: false,
          stream: Boolean(parsed.stream),
          clientTag,
          happenedAt: Date.now(),
          errorMessage:
            error instanceof Error
              ? error.message
              : `request_failed_after_${Date.now() - startedAt}ms`,
        });
      }
      throw error;
    }
  });

  app.get("/admin/health", async (request) => {
    requireAdminAuth(runtime, request);
    return {
      ...runtime.getHealth(),
      recentErrors: runtime.database.getRecentErrors(10),
      openclaw: runtime.getOpenClawSnippet(),
    };
  });

  app.get("/admin/providers", async (request) => {
    requireAdminAuth(runtime, request);
    return {
      data: runtime.getProviders(),
    };
  });

  app.get("/admin/config/providers", async (request) => {
    requireAdminAuth(runtime, request);
    return {
      data: runtime.configStore.getProviderSettings(),
    };
  });

  app.put("/admin/config/providers", async (request) => {
    requireAdminAuth(runtime, request);
    const body = (request.body ?? {}) as GatewayProviderSettings;
    const saved = runtime.configStore.setProviderSettings(body);
    runtime.logger.info("provider_settings_saved", {
      hasOpenAICompatible: Boolean(body.openAICompatible?.enabled),
      hasOllama: Boolean(body.ollama?.enabled),
      defaultModelAlias: body.defaultModelAlias,
    });
    return {
      ok: true,
      requiresRestart: true,
      data: saved.providerSettings ?? {},
    };
  });

  app.get("/admin/config/routing", async (request) => {
    requireAdminAuth(runtime, request);
    return {
      data: runtime.getRoutingSettings(),
    };
  });

  app.put("/admin/config/routing", async (request) => {
    requireAdminAuth(runtime, request);
    const body = (request.body ?? {}) as GatewayRoutingSettings;
    const saved = runtime.configStore.setRoutingSettings(body);
    runtime.logger.info("routing_settings_saved", {
      enabled: Boolean(body.enabled),
      ruleCount: body.rules?.length ?? 0,
    });
    return {
      ok: true,
      data: saved.routingSettings ?? {},
    };
  });

  app.post("/admin/config/routing/preview", async (request) => {
    requireAdminAuth(runtime, request);
    const body = (request.body ?? {}) as GatewayRoutingPreviewInput;
    return {
      ok: true,
      data: runtime.previewRouting(body),
    };
  });

  app.get("/admin/config/security", async (request) => {
    requireAdminAuth(runtime, request);
    return {
      ok: true,
      data: runtime.getInferenceAuthPublicSettings(),
    };
  });

  app.put("/admin/config/security", async (request) => {
    requireAdminAuth(runtime, request);
    const body = (request.body ?? {}) as GatewayInferenceAuthSettings;
    const mode = body.mode === "api-key" ? "api-key" : "none";
    const previous = runtime.configStore.getInferenceAuthSettings();
    const nextApiKey = body.apiKey?.trim() || previous.apiKey?.trim() || "";

    if (mode === "api-key" && !nextApiKey) {
      throw new GatewayError(
        400,
        "invalid_request",
        "启用 API Key 鉴权时必须提供至少一个有效密钥。",
      );
    }

    runtime.configStore.setInferenceAuthSettings({
      mode,
      apiKey: nextApiKey || undefined,
    });
    runtime.logger.info("inference_auth_settings_saved", {
      mode,
      hasApiKey: Boolean(nextApiKey),
    });
    return {
      ok: true,
      data: runtime.getInferenceAuthPublicSettings(),
    };
  });

  app.get("/admin/sessions", async (request) => {
    requireAdminAuth(runtime, request);
    return {
      activeSessionId: runtime.getActiveSessionId(),
      data: runtime.listSessions(),
    };
  });

  app.put("/admin/sessions/active", async (request) => {
    requireAdminAuth(runtime, request);
    const body = request.body as { sessionId?: string };
    if (!body?.sessionId) {
      throw new GatewayError(400, "invalid_request", "sessionId is required.");
    }

    const sessions = runtime.listSessions();
    const session = ensureSessionExists(sessions, body.sessionId);
    runtime.setActiveSessionId(session.id);
    runtime.logger.info("active_session_changed", { sessionId: session.id });
    return {
      ok: true,
      activeSessionId: session.id,
    };
  });

  app.post("/admin/sessions/refresh", async (request) => {
    requireAdminAuth(runtime, request);
    const body = (request.body ?? {}) as { sessionId?: string };
    return runtime.refreshSessionUsage(body.sessionId);
  });

  app.post("/admin/telemetry/reset", async (request) => {
    requireAdminAuth(runtime, request);
    runtime.resetTelemetry();
    runtime.logger.info("telemetry_reset");
    return {
      ok: true,
      reset: true,
    };
  });

  app.post("/admin/service/restart", async (request, reply) => {
    requireAdminAuth(runtime, request);
    reply.send({
      ok: true,
      restarting: true,
    });
    setTimeout(() => {
      process.exit(75);
    }, 75);
    return reply;
  });

  return app;
}
