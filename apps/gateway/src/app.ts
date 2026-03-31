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
  GatewayPoolFailureClass,
  GatewayProviderSettings,
  GatewayRoutingPreviewInput,
  GatewayRoutingSettings,
  GatewaySessionPoolSettings,
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

function classifyPoolFailure(error: unknown): GatewayPoolFailureClass {
  if (error instanceof GatewayError && error.code === "gateway_auth_required") {
    return "auth_invalid";
  }

  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (
    message.includes("usage_limit_reached") ||
    message.includes("usage limit has been reached") ||
    message.includes("quota exhausted") ||
    message.includes("quota_exhausted") ||
    message.includes("reset later")
  ) {
    return "quota_exhausted";
  }
  if (message.includes("rate limit") || message.includes("429")) {
    return "rate_limited";
  }
  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("reconnecting") ||
    message.includes("econn") ||
    message.includes("socket")
  ) {
    return "network_retryable";
  }
  if (
    message.includes("upstream_error") ||
    message.includes("service unavailable") ||
    message.includes("bad gateway") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  ) {
    return "upstream_retryable";
  }
  return "non_retryable";
}

function isRetryablePoolFailureClass(failureClass: GatewayPoolFailureClass): boolean {
  return failureClass !== "non_retryable";
}

function isRetryableFixedSessionError(error: unknown): boolean {
  return isRetryablePoolFailureClass(classifyPoolFailure(error));
}

function isRetryableFinalMessageError(message: string | undefined): boolean {
  return isRetryablePoolFailureClass(classifyPoolFailure(message));
}

function resolvePoolAttemptLimit(
  poolSettings: GatewaySessionPoolSettings,
  poolId: string | undefined,
): number {
  const pool = poolSettings.pools?.find((item) => item.id === poolId);
  const value = pool?.maxRetryCandidates;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 2;
  }
  return Math.max(1, Math.min(5, Math.round(value)));
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
    if (
      normalized instanceof GatewayError &&
      normalized.code === "client_temporarily_blocked"
    ) {
      runtime.logger.warn("request_client_circuit_blocked", {
        message: normalized.message,
      });
    } else {
      runtime.logger.error("request_failed", { message: normalized.message });
    }
    if (
      normalized instanceof GatewayError &&
      typeof normalized.details?.retryAfterSeconds === "number"
    ) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(normalized.details.retryAfterSeconds),
      );
      reply.header("Retry-After", String(retryAfterSeconds));
    }
    reply.status(getStatusCode(normalized)).send(buildErrorBody(normalized));
  });

  app.get("/healthz", async () => runtime.getHealth());

  app.get("/v1/models", async (request) => {
    requireInferenceAuth(runtime, request);
    return buildModelsResponse(runtime.modelRegistry.list());
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    requireInferenceAuth(runtime, request);
    const startedAt = Date.now();
    const currentSessionId = runtime.getActiveSessionId();
    const clientTag = resolveClientTag(request);
    const clientCircuit = runtime.checkClientCircuit(clientTag);
    if (clientCircuit.blocked) {
      throw new GatewayError(
        429,
        "client_temporarily_blocked",
        `客户端 ${clientCircuit.clientTag} 在短时间内失败过多，已进入冷却期，请稍后重试。`,
        {
          retryAfterSeconds: clientCircuit.retryAfterSeconds,
          clientTag: clientCircuit.clientTag,
        },
      );
    }
    const parsed = parseChatCompletionsRequest(request.body);
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
    const dispatchMode = runtime.getEffectiveDispatchMode(matchedRule?.target);
    const targetPoolId = matchedRule?.target?.poolId?.trim();
    const poolAttemptLimit = resolvePoolAttemptLimit(
      runtime.getPoolSettings(),
      targetPoolId,
    );
    const targetPoolName =
      targetPoolId
        ? runtime.getPoolSettings().pools?.find((pool) => pool.id === targetPoolId)
            ?.name ?? targetPoolId
        : undefined;
    const hasExplicitTargetSession = Boolean(
      dispatchMode === "fixed-session" && matchedRule?.target?.sessionId?.trim(),
    );
    const attemptedSessionIds = new Set<string>();
    let routingHitRecorded = false;
    let poolSelectionEventRecorded = false;
    let selectedByPoolMember = Boolean(
      dispatchMode === "dynamic-pool" &&
        targetPoolId &&
        routingPreview.reason === "rule_matched" &&
        routingPreview.resolvedPoolId === targetPoolId &&
        routingPreview.selectionReason &&
        routingPreview.selectionReason !== "fallback-to-active-session",
    );

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

      if (
        dispatchMode === "dynamic-pool" &&
        targetPoolId &&
        !routingPreview.resolvedSessionId &&
        !currentSessionId
      ) {
        throw new GatewayError(
          503,
          "pool_no_available_session",
          `号池 ${targetPoolId} 当前没有可用账号，且系统不存在可回退的活动账号。`,
        );
      }
    }

    let usedSessionId = resolvedSessionId;
    let hasRecordedResult = false;
    const resolved = runtime.getProviderAdapterForModel(resolvedModelAlias);
    if (!resolved) {
      throw new GatewayError(400, "model_not_found", "Requested model alias is not configured.");
    }
    const inferenceRequestId = runtime.beginInferenceActivity({
      clientTag,
      requestedModelAlias: resolvedModelAlias,
      sessionId: resolvedSessionId,
      poolId: targetPoolId,
    });

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

    if (targetPoolId && selectedByPoolMember && resolvedSessionId) {
      runtime.recordPoolSelectionStarted(targetPoolId, resolvedSessionId);
    }

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

    const selectNextPoolSessionId = (
      failedSessionId: string | undefined,
      failureClass: GatewayPoolFailureClass,
    ): string | undefined => {
      if (!targetPoolId || !isRetryablePoolFailureClass(failureClass)) {
        return undefined;
      }

      if (attemptedSessionIds.size >= poolAttemptLimit) {
        return undefined;
      }

      const failedSession = failedSessionId
        ? runtime.listSessions().find((session) => session.id === failedSessionId)
        : undefined;
      if (failedSessionId && selectedByPoolMember) {
        runtime.recordPoolSelectionFailure({
          poolId: targetPoolId,
          sessionId: failedSessionId,
          failureClass,
          resetAt: failedSession?.quota?.resetAt,
        });
      }

      const nextSelection = runtime.selectSessionFromPool({
        poolId: targetPoolId,
        currentSessionId,
        attemptedSessionIds,
      });
      routingWarnings.push(...nextSelection.warnings);
      if (
        nextSelection.selectedSessionId &&
        nextSelection.selectedSessionId !== failedSessionId
      ) {
        selectedByPoolMember = Boolean(nextSelection.selectedSelector);
        routingWarnings.push(
          `号池 ${nextSelection.poolName} 已将请求从 ${failedSessionId ?? "unknown"} 切换到 ${nextSelection.selectedSessionId}。`,
        );
        runtime.logger.info("routing_pool_runtime_fallback", {
          matchedRuleId: routingPreview.matchedRuleId,
          poolId: targetPoolId,
          failedSessionId,
          fallbackSessionId: nextSelection.selectedSessionId,
          failureClass,
          candidateCount: nextSelection.candidateCount,
        });
        runtime.recordPoolSelectionEvent({
          timestamp: Date.now(),
          poolId: nextSelection.poolId,
          poolName: nextSelection.poolName,
          eventType: "failover",
          clientTag,
          requestedModelAlias: parsed.model,
          fromSessionId: failedSessionId,
          toSessionId: nextSelection.selectedSessionId,
          selectedSessionId: nextSelection.selectedSessionId,
          failureClass,
          reason: nextSelection.selectionReason,
        });
        return nextSelection.selectedSessionId;
      }

      return undefined;
    };

    const recordPoolSelectionSelectedIfNeeded = (sessionId: string | undefined) => {
      if (
        !targetPoolId ||
        !selectedByPoolMember ||
        !sessionId ||
        poolSelectionEventRecorded
      ) {
        return;
      }
      runtime.recordPoolSelectionEvent({
        timestamp: Date.now(),
        poolId: targetPoolId,
        poolName: targetPoolName ?? targetPoolId,
        eventType: "selected",
        clientTag,
        requestedModelAlias: parsed.model,
        selectedSessionId: sessionId,
        reason: routingPreview.selectionReason,
      });
      poolSelectionEventRecorded = true;
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
        const poolFallbackSessionId = selectNextPoolSessionId(
          resolvedSessionId,
          classifyPoolFailure(error),
        );
        const fallbackSessionId =
          poolFallbackSessionId ??
          (hasExplicitTargetSession && isRetryableFixedSessionError(error)
            ? selectFallbackSessionId(resolvedSessionId)
            : undefined);
        if (!fallbackSessionId) {
          throw error;
        }
        resolvedSessionId = fallbackSessionId;
        runtime.updateInferenceActivity(inferenceRequestId, {
          sessionId: resolvedSessionId,
          poolId: targetPoolId,
        });
        result = await createAttempt(resolvedSessionId);
      }
      usedSessionId = result.session.id;
      runtime.updateInferenceActivity(inferenceRequestId, {
        sessionId: usedSessionId,
        poolId: targetPoolId,
      });
      recordPoolSelectionSelectedIfNeeded(usedSessionId);

      if (parsed.stream) {
        let streamingResult = result;
        let streamingSessionId = usedSessionId;

        while (true) {
          let hasWrittenFirstChunk = false;
          try {
            for await (const chunk of streamChatCompletionChunks(
              streamingResult.stream,
              resolvedModelAlias,
            )) {
              if (!hasWrittenFirstChunk) {
                recordRoutingHitIfNeeded(streamingSessionId);
                reply.raw.writeHead(200, {
                  "Content-Type": "text/event-stream; charset=utf-8",
                  "Cache-Control": "no-cache, no-transform",
                  Connection: "keep-alive",
                });
                hasWrittenFirstChunk = true;
              }
              reply.raw.write(chunk);
            }
          } catch (error) {
            if (hasWrittenFirstChunk) {
              throw error;
            }

            const poolFallbackSessionId = selectNextPoolSessionId(
              streamingSessionId,
              classifyPoolFailure(error),
            );
            const fallbackSessionId =
              poolFallbackSessionId ??
              (hasExplicitTargetSession && isRetryableFixedSessionError(error)
                ? selectFallbackSessionId(streamingSessionId)
                : undefined);
            if (!fallbackSessionId) {
              throw error;
            }
            resolvedSessionId = fallbackSessionId;
            runtime.updateInferenceActivity(inferenceRequestId, {
              sessionId: resolvedSessionId,
              poolId: targetPoolId,
            });
            streamingResult = await createAttempt(fallbackSessionId);
            streamingSessionId = streamingResult.session.id;
            usedSessionId = streamingSessionId;
            runtime.updateInferenceActivity(inferenceRequestId, {
              sessionId: streamingSessionId,
              poolId: targetPoolId,
            });
            recordPoolSelectionSelectedIfNeeded(streamingSessionId);
            continue;
          }

          if (!hasWrittenFirstChunk) {
            recordRoutingHitIfNeeded(streamingSessionId);
            reply.raw.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
            });
          }
          reply.raw.end();
          if (streamingSessionId) {
            if (targetPoolId && selectedByPoolMember) {
              runtime.recordPoolSelectionSuccess(targetPoolId, streamingSessionId);
            }
            runtime.recordInferenceResult({
              sessionId: streamingSessionId,
              ok: true,
              stream: true,
              clientTag,
              happenedAt: Date.now(),
            });
            hasRecordedResult = true;
          }
          runtime.recordClientCircuitSuccess(clientTag);
          return reply;
        }
      }

      let finalMessage = await result.stream.result();
      if (
        finalMessage.stopReason === "error" &&
        (hasExplicitTargetSession || Boolean(targetPoolId)) &&
        isRetryableFinalMessageError(finalMessage.errorMessage)
      ) {
        const poolFallbackSessionId = selectNextPoolSessionId(
          usedSessionId,
          classifyPoolFailure(finalMessage.errorMessage),
        );
        const fallbackSessionId =
          poolFallbackSessionId ??
          selectFallbackSessionId(usedSessionId);
        if (fallbackSessionId) {
          resolvedSessionId = fallbackSessionId;
          runtime.updateInferenceActivity(inferenceRequestId, {
            sessionId: resolvedSessionId,
            poolId: targetPoolId,
          });
          const retryResult = await createAttempt(fallbackSessionId);
          usedSessionId = retryResult.session.id;
          runtime.updateInferenceActivity(inferenceRequestId, {
            sessionId: usedSessionId,
            poolId: targetPoolId,
          });
          selectedByPoolMember = Boolean(targetPoolId && poolFallbackSessionId);
          recordPoolSelectionSelectedIfNeeded(usedSessionId);
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
        if (targetPoolId && selectedByPoolMember) {
          runtime.recordPoolSelectionSuccess(targetPoolId, usedSessionId);
        }
        runtime.recordInferenceResult({
          sessionId: usedSessionId,
          ok: true,
          stream: false,
          clientTag,
          happenedAt: Date.now(),
        });
        hasRecordedResult = true;
      }
      runtime.recordClientCircuitSuccess(clientTag);
      return buildChatCompletionResponse(finalMessage, resolvedModelAlias);
    } catch (error) {
      recordRoutingHitIfNeeded(usedSessionId);
      const failureClass = classifyPoolFailure(error);
      runtime.recordClientCircuitFailure({
        clientTag,
        failureClass,
      });
      if (usedSessionId && !hasRecordedResult) {
        if (targetPoolId && selectedByPoolMember) {
          const failedSession = runtime
            .listSessions()
            .find((session) => session.id === usedSessionId);
          runtime.recordPoolSelectionFailure({
            poolId: targetPoolId,
            sessionId: usedSessionId,
            failureClass,
            resetAt: failedSession?.quota?.resetAt,
          });
        }
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
      const retryAfterSeconds = runtime.suggestRetryAfterSeconds({
        clientTag,
        failureClass,
      });
      if (
        retryAfterSeconds &&
        error instanceof GatewayError &&
        !error.details?.retryAfterSeconds
      ) {
        throw new GatewayError(error.statusCode, error.code, error.message, {
          ...(error.details ?? {}),
          retryAfterSeconds,
        });
      }
      if (
        retryAfterSeconds &&
        !(error instanceof GatewayError)
      ) {
        throw new GatewayError(502, "upstream_error", String(error), {
          retryAfterSeconds,
        });
      }
      throw error;
    } finally {
      runtime.finishInferenceActivity(inferenceRequestId);
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

  app.get("/admin/config/pools", async (request) => {
    requireAdminAuth(runtime, request);
    return {
      ok: true,
      data: runtime.getPoolSettings(),
    };
  });

  app.put("/admin/config/pools", async (request) => {
    requireAdminAuth(runtime, request);
    const body = (request.body ?? {}) as GatewaySessionPoolSettings;
    const saved = runtime.configStore.setPoolSettings(body);
    runtime.logger.info("pool_settings_saved", {
      enabled: Boolean(body.enabled),
      poolCount: body.pools?.length ?? 0,
    });
    return {
      ok: true,
      data: saved.poolSettings ?? {},
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

  app.post("/admin/telemetry/circuit/reset", async (request) => {
    requireAdminAuth(runtime, request);
    const body = (request.body ?? {}) as { clientTag?: string };
    const result = runtime.resetClientCircuit(body.clientTag);
    runtime.logger.info("client_circuit_reset", {
      clientTag: body.clientTag?.trim().toLowerCase() || "all",
      cleared: result.cleared,
    });
    return {
      ok: true,
      ...result,
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
