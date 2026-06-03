import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";

import {
  buildChatCompletionResponse,
  buildModelsResponse,
  buildResponsesApiResponseFromChatCompletion,
  chatCompletionSseToResponsesApiSse,
  type ChatCompletionsRequest,
  parseChatCompletionsRequest,
  parseResponsesApiRequest,
  serializeSse,
  streamChatCompletionChunks,
  toChatCompletionsRequestFromResponsesApi,
  toGatewayConversationContext,
} from "@local-ai-gateway/openai-compat";
import {
  GatewayError,
  GatewayAccessAlertEvent,
  GatewayAccessAlertSeverity,
  GatewayAccessControlSettings,
  GatewayAccessConsumer,
  GatewayAccessKey,
  GatewayAccessPolicy,
  GatewayInferenceAuthSettings,
  GatewayModelDefinition,
  GatewayPoolFailureClass,
  GatewayProviderSettings,
  GatewayPublicAccessProvider,
  GatewayPublicAccessSettings,
  GatewayPoolVisibility,
  GatewayRoutingAccessDecision,
  GatewayRoutingPreviewInput,
  GatewayRoutingPreviewResult,
  GatewayRoutingSettings,
  GatewaySessionPoolDefinition,
  GatewaySessionPoolSettings,
  GatewayUsageCounters,
  GatewayUsageClientFilter,
  GatewayRequestContentAuditSettings,
  getCodexAliasForUpstreamModel,
  SessionSummary,
} from "@local-ai-gateway/shared";

import {
  GatewayRuntime,
  type GatewayUsageAnalyticsGranularity,
  type GatewayUsageAnalyticsRange,
} from "./runtime.js";

const requestAuditSourceEventKeys = new WeakMap<FastifyRequest, string>();
const requestAccessContexts = new WeakMap<FastifyRequest, AccessCredentialContext>();
const SERVICE_RESTART_ACTIVE_RETRY_AFTER_SECONDS = 15;

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

function buildErrorLogDetails(error: GatewayError | Error): Record<string, unknown> {
  if (error instanceof GatewayError) {
    return {
      message: error.message,
      errorCode: error.code,
      statusCode: error.statusCode,
      ...(error.details ?? {}),
    };
  }
  return {
    message: error.message,
  };
}

function buildRequestAuditContext(request: FastifyRequest): Record<string, unknown> {
  const body = request.body as
    | {
        model?: unknown;
        stream?: unknown;
      }
    | undefined;
  const headerClientTag = request.headers["x-client-tag"];
  const clientTag =
    typeof headerClientTag === "string"
      ? headerClientTag
      : Array.isArray(headerClientTag)
        ? headerClientTag[0]
        : undefined;
  const contentLength = getFirstHeaderValue(request, "content-length");
  const userAgent = getFirstHeaderValue(request, "user-agent");
  const sourceApp = getFirstHeaderValue(request, "x-source-app");
  return {
    requestPath: request.url.split("?")[0],
    requestMethod: request.method,
    ...(typeof body?.model === "string" ? { modelAlias: body.model } : {}),
    ...(typeof body?.stream === "boolean" ? { stream: body.stream } : {}),
    ...(clientTag ? { clientTag } : {}),
    ...(contentLength ? { contentLength } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(sourceApp ? { sourceApp } : {}),
    ...(requestAuditSourceEventKeys.get(request)
      ? { requestAuditSourceEventKey: requestAuditSourceEventKeys.get(request) }
      : {}),
  };
}

function normalizeRequestContentAuditSettings(
  settings: GatewayRequestContentAuditSettings | undefined,
): Required<GatewayRequestContentAuditSettings> {
  return {
    enabled: Boolean(settings?.enabled),
    maxCharacters:
      typeof settings?.maxCharacters === "number" &&
      Number.isFinite(settings.maxCharacters)
        ? Math.max(1_000, Math.min(200_000, Math.floor(settings.maxCharacters)))
        : 32_000,
    maxEvents:
      typeof settings?.maxEvents === "number" && Number.isFinite(settings.maxEvents)
        ? Math.max(0, Math.min(10_000, Math.floor(settings.maxEvents)))
        : 500,
  };
}

function stringifyRequestMessageContent(content: unknown): unknown {
  if (typeof content === "string" || content === null || content === undefined) {
    return content ?? "";
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") {
        return part;
      }
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return { type: "text", text: record.text };
      }
      return { type: typeof record.type === "string" ? record.type : "unknown" };
    });
  }
  return String(content);
}

function stringifyPromptMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (!part || typeof part !== "object") {
          return "";
        }
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") {
          return record.text;
        }
        return typeof record.type === "string" ? `[${record.type}]` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function extractLatestUserPromptText(request: ChatCompletionsRequest): string | undefined {
  const latestUserMessage = [...request.messages]
    .reverse()
    .find((message) => message.role === "user") as
    | (Record<string, unknown> & { role: string })
    | undefined;
  const text = stringifyPromptMessageContent(latestUserMessage?.content).trim();
  return text || undefined;
}

function buildRequestContentSnapshot(request: ChatCompletionsRequest) {
  return {
    model: request.model,
    stream: Boolean(request.stream),
    messages: request.messages.map((message) => {
      const record = message as Record<string, unknown>;
      return {
        role: message.role,
        content: stringifyRequestMessageContent(record.content),
        ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
        ...(typeof record.tool_call_id === "string" && record.tool_call_id
          ? { toolCallId: record.tool_call_id }
          : {}),
      };
    }),
    tools: (request.tools ?? []).map((tool) => ({
      type: tool.type,
      name: tool.function.name,
      description: tool.function.description,
    })),
  };
}

function truncateJsonString(input: unknown, maxCharacters: number) {
  const serialized = JSON.stringify(input, null, 2);
  if (serialized.length <= maxCharacters) {
    return {
      contentJson: serialized,
      capturedCharacters: serialized.length,
      truncated: false,
    };
  }
  return {
    contentJson: serialized.slice(0, maxCharacters),
    capturedCharacters: maxCharacters,
    truncated: true,
  };
}

function maybeRecordRequestContentAudit(input: {
  runtime: GatewayRuntime;
  sourceEventKey: string;
  request: ChatCompletionsRequest;
  consumerId?: string;
  accessKeyId?: string;
}): void {
  const settings = normalizeRequestContentAuditSettings(
    input.runtime.configStore.getDesktopSettings().requestContentAudit,
  );
  if (!settings.enabled) {
    return;
  }
  const snapshot = buildRequestContentSnapshot(input.request);
  const content = truncateJsonString(snapshot, settings.maxCharacters);
  input.runtime.database.insertRequestContentAuditEvent({
    sourceEventKey: input.sourceEventKey,
    timestamp: Date.now(),
    modelAlias: input.request.model,
    consumerId: input.consumerId,
    accessKeyId: input.accessKeyId,
    promptText: extractLatestUserPromptText(input.request),
    ...content,
  });
  input.runtime.database.pruneRequestContentAuditEvents(settings.maxEvents);
}

function isAccessAlertError(error: GatewayError | Error): error is GatewayError {
  return (
    error instanceof GatewayError &&
    (error.code.startsWith("access_policy_") ||
      error.code.startsWith("access_key_") ||
      error.code.startsWith("access_consumer_") ||
      error.code.startsWith("request_") ||
      error.code.startsWith("session_safety_") ||
      error.code.startsWith("upstream_") ||
      error.code === "client_temporarily_blocked")
  );
}

function resolveAccessAlertSeverity(error: GatewayError): GatewayAccessAlertSeverity {
  return error.statusCode >= 500 ? "critical" : "warning";
}

function recordAccessAlertForError(
  runtime: GatewayRuntime,
  error: GatewayError | Error,
  request?: FastifyRequest,
): void {
  if (!isAccessAlertError(error)) {
    return;
  }
  const details = {
    ...(request ? buildRequestAuditContext(request) : {}),
    ...buildErrorLogDetails(error),
  };
  if (details.clientTag === "desktop-service-test") {
    return;
  }
  const accessContext = request ? requestAccessContexts.get(request) : undefined;
  if (accessContext) {
    details.consumerId = details.consumerId ?? accessContext.consumerId;
    details.accessKeyId = details.accessKeyId ?? accessContext.accessKeyId;
    details.clientTag = details.clientTag ?? accessContext.clientTag;
    details.consumerType = details.consumerType ?? accessContext.consumerType;
    details.consumerName = details.consumerName ?? accessContext.consumerName;
  }
  const consumer =
    typeof details.consumerId === "string"
      ? runtime
          .configStore.getInferenceAuthSettings()
          .accessControl?.consumers?.find(
            (item) => item.id === details.consumerId,
          )
      : undefined;
  if (consumer) {
    details.clientTag = consumer.clientTag;
    details.consumerType = consumer.type;
  }
  runtime.recordAccessAlertEvent({
    timestamp: Date.now(),
    severity: resolveAccessAlertSeverity(error),
    consumerId:
      typeof details.consumerId === "string" ? details.consumerId : undefined,
    consumerType:
      typeof details.consumerType === "string"
        ? normalizeAccessConsumerType(details.consumerType)
        : undefined,
    accessKeyId:
      typeof details.accessKeyId === "string" ? details.accessKeyId : undefined,
    type: error.code,
    message: error.message,
    details,
  });
}

function getLocalDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recordAccessMemberOnlineAlerts(
  runtime: GatewayRuntime,
  accessContext: AccessCredentialContext | undefined,
  now = Date.now(),
): void {
  if (!accessContext) {
    return;
  }
  const totals = runtime.database.getUsageTotalsForAccessConsumer({
    consumerId: accessContext.consumerId,
  });
  const dayStart = new Date(
    new Date(now).getFullYear(),
    new Date(now).getMonth(),
    new Date(now).getDate(),
  ).getTime();
  const dailyTotals = runtime.database.getUsageTotalsForAccessConsumer({
    consumerId: accessContext.consumerId,
    sinceTimestamp: dayStart,
  });
  const base: Omit<GatewayAccessAlertEvent, "type" | "message" | "dedupeKey"> = {
    timestamp: now,
    severity: "info",
    consumerId: accessContext.consumerId,
    consumerType: accessContext.consumerType,
    accessKeyId: accessContext.accessKeyId,
    details: {
      consumerName: accessContext.consumerName,
      clientTag: accessContext.clientTag,
      onlineAt: new Date(now).toISOString(),
    },
  };
  if (totals.requestCount <= 0) {
    runtime.recordAccessAlertEvent({
      ...base,
      type: "access_member_first_seen",
      message: "Access member sent the first inference request.",
      dedupeKey: `access_member_first_seen|${accessContext.consumerId}`,
    });
  }
  if (dailyTotals.requestCount <= 0) {
    const dateKey = getLocalDateKey(now);
    runtime.recordAccessAlertEvent({
      ...base,
      type: "access_member_daily_online",
      message: "Access member sent the first inference request today.",
      dedupeKey: `access_member_daily_online|${accessContext.consumerId}|${dateKey}`,
      details: {
        ...base.details,
        dateKey,
      },
    });
  }
}

function getConfiguredAccessAlertWarningRatio(
  runtime: GatewayRuntime,
): number {
  return normalizeAccessAlertThresholdRatio(
    runtime.configStore.getInferenceAuthSettings().accessControl?.alertThresholds
      ?.dailyQuotaWarningRatio,
  ) ?? 0.9;
}

function recordAccessLimitWarning(
  runtime: GatewayRuntime,
  input: {
    accessContext: AccessCredentialContext;
    type: string;
    message: string;
    limit: number;
    used?: number;
    resetAt?: number;
    ratio?: number;
  },
): void {
  runtime.recordAccessAlertEvent({
    timestamp: Date.now(),
    severity: "warning",
    consumerId: input.accessContext.consumerId,
    consumerType: input.accessContext.consumerType,
    accessKeyId: input.accessContext.accessKeyId,
    type: input.type,
    message: input.message,
    dedupeKey: `${input.type}|${input.accessContext.consumerId}|${input.accessContext.accessKeyId ?? "-"}`,
    details: {
      consumerName: input.accessContext.consumerName,
      clientTag: input.accessContext.clientTag,
      limit: input.limit,
      ...(typeof input.used === "number" ? { usedTokens: input.used } : {}),
      ...(typeof input.ratio === "number" ? { usageRatio: input.ratio } : {}),
      ...(typeof input.resetAt === "number"
        ? { resetAt: new Date(input.resetAt).toISOString() }
        : {}),
    },
  });
}

function recordAccessThresholdAlerts(
  runtime: GatewayRuntime,
  accessContext: AccessCredentialContext | undefined,
): void {
  if (!accessContext) {
    return;
  }
  const policy = accessContext.policy;
  const warningRatio = getConfiguredAccessAlertWarningRatio(runtime);
  const now = Date.now();
  const warnIfNearLimit = (input: {
    type: string;
    message: string;
    limit?: number;
    used: number;
    resetAt?: number;
  }) => {
    if (typeof input.limit !== "number" || input.limit <= 0) {
      return;
    }
    const ratio = input.used / input.limit;
    if (ratio < warningRatio || input.used >= input.limit) {
      return;
    }
    recordAccessLimitWarning(runtime, {
      accessContext,
      type: input.type,
      message: input.message,
      limit: input.limit,
      used: input.used,
      resetAt: input.resetAt,
      ratio,
    });
  };

  const dailyLimit = normalizePolicyLimit(policy?.quota?.dailyTokenLimit);
  if (typeof dailyLimit === "number") {
    const window = getAccessPolicyDailyQuotaWindow(
      now,
      policy?.quota?.resetTimezone,
    );
    const usage = runtime.database.getUsageTotalsForAccessConsumer({
      consumerId: accessContext.consumerId,
      sinceTimestamp: window.start,
    });
    warnIfNearLimit({
      type: "access_policy_daily_quota_warning",
      message: "Access consumer daily token quota is close to the configured threshold.",
      limit: dailyLimit,
      used: usage.totalTokens,
      resetAt: window.resetAt,
    });
  }

  const periodWindow = getAccessPolicyPeriodWindow(accessContext);
  const periodLimit = normalizePolicyLimit(policy?.quota?.periodTokenLimit);
  if (periodWindow && typeof periodLimit === "number") {
    const usage = runtime.database.getUsageTotalsForAccessConsumer({
      consumerId: accessContext.consumerId,
      sinceTimestamp: periodWindow.start,
    });
    warnIfNearLimit({
      type: "access_policy_period_quota_warning",
      message: "Access consumer token period quota is close to the configured threshold.",
      limit: periodLimit,
      used: usage.totalTokens,
      resetAt: periodWindow.end,
    });
  }

  const totalLimit = normalizePolicyLimit(policy?.quota?.totalTokenLimit);
  if (typeof totalLimit === "number") {
    const usage = runtime.database.getUsageTotalsForAccessConsumer({
      consumerId: accessContext.consumerId,
    });
    warnIfNearLimit({
      type: "access_policy_total_quota_warning",
      message: "Access consumer total token quota is close to the configured threshold.",
      limit: totalLimit,
      used: usage.totalTokens,
    });
  }

  const warnBeforeMs = 72 * 60 * 60 * 1000;
  const policyExpiresAt = parsePolicyTimestamp(policy?.expiresAt);
  if (
    typeof policyExpiresAt === "number" &&
    policyExpiresAt > now &&
    policyExpiresAt - now <= warnBeforeMs
  ) {
    recordAccessLimitWarning(runtime, {
      accessContext,
      type: "access_policy_expiry_warning",
      message: "Access consumer policy is close to expiration.",
      limit: warnBeforeMs,
      resetAt: policyExpiresAt,
    });
  }
  if (
    periodWindow &&
    periodWindow.end > now &&
    periodWindow.end - now <= warnBeforeMs
  ) {
    recordAccessLimitWarning(runtime, {
      accessContext,
      type: "access_policy_period_expiry_warning",
      message: "Access consumer token period is close to expiration.",
      limit: warnBeforeMs,
      resetAt: periodWindow.end,
    });
  }
}

function requireAdminAuth(
  runtime: GatewayRuntime,
  request: FastifyRequest,
): void {
  requireLoopbackRequest(request);

  const authHeader = request.headers.authorization;
  const expected = `Bearer ${runtime.configStore.getAdminToken()}`;

  if (authHeader !== expected) {
    throw new GatewayError(401, "unauthorized", "Admin token is missing or invalid.");
  }
}

function isLoopbackAddress(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackAddress(normalized.slice("::ffff:".length));
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function requireLoopbackRequest(request: FastifyRequest): void {
  if (isLoopbackAddress(request.ip)) {
    return;
  }
  throw new GatewayError(
    403,
    "admin_loopback_required",
    "Admin endpoints are only available from the local machine.",
  );
}

function requireInferenceNetworkAccess(
  runtime: GatewayRuntime,
  request: FastifyRequest,
): void {
  if (isLoopbackAddress(request.ip)) {
    return;
  }

  const settings = runtime.configStore.getInferenceAuthSettings();
  if (!settings.lanAccess?.enabled) {
    throw new GatewayError(
      403,
      "lan_access_disabled",
      "LAN inference access is disabled.",
    );
  }

  const hasDefaultKey = Boolean(settings.apiKey?.trim());
  const hasMappingKey = normalizeInferenceClientMappings(settings).some(
    (item) => item.enabled,
  );
  const hasAccessKey = (settings.accessControl?.keys ?? []).some(
    (item) => item.status === "enabled" && item.keyHash.trim().length > 0,
  );
  if (
    settings.mode !== "api-key" ||
    (!hasDefaultKey && !hasMappingKey && !hasAccessKey)
  ) {
    throw new GatewayError(
      503,
      "lan_api_key_required",
      "LAN inference access requires API key auth.",
    );
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

function resolveClientTagFromUserAgent(
  request: FastifyRequest,
): string | undefined {
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
  if (userAgent.includes("hermes")) {
    return "hermes";
  }
  if (userAgent.includes("curl")) {
    return "curl";
  }
  return undefined;
}

function resolveHeaderClientTag(request: FastifyRequest): string | undefined {
  const explicit =
    getFirstHeaderValue(request, "x-local-ai-client-tag") ??
    getFirstHeaderValue(request, "x-client-tag") ??
    getFirstHeaderValue(request, "x-source-app");
  if (!explicit) {
    return undefined;
  }
  const normalized = explicit.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

type NormalizedClientMapping = {
  name: string;
  apiKey: string;
  clientTag: string;
  enabled: boolean;
  allowHeaderOverride: boolean;
};

type AccessKeyInput = Partial<GatewayAccessKey> & {
  apiKey?: string;
};

type AccessControlInput = Partial<GatewayAccessControlSettings> & {
  keys?: AccessKeyInput[];
};

const PUBLIC_REQUEST_GUARD_LIMITS = {
  maxBodyBytes: 8 * 1_024 * 1_024,
  maxMessages: 1_000,
  maxTools: 128,
  maxToolSchemaBytes: 1_024 * 1_024,
  maxEstimatedInputTokens: 1_050_000,
  maxOutputTokens: 128_000,
  maxSingleTextChars: 4 * 1_024 * 1_024,
  maxToolResultChars: 4 * 1_024 * 1_024,
};

type AccessCredentialContext = {
  consumerId: string;
  consumerName: string;
  consumerType: GatewayAccessConsumer["type"];
  consumerCreatedAt?: string;
  accessKeyId?: string;
  clientTag: string;
  policy?: GatewayAccessPolicy;
};

function hashAccessApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function normalizeAccessId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function isPastIsoDate(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? "").trim())
    .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index);
}

function normalizeAccessConsumerType(
  value: unknown,
): GatewayAccessConsumer["type"] {
  if (
    value === "local-owner" ||
    value === "lan-member" ||
    value === "public-user" ||
    value === "system-client"
  ) {
    return value;
  }
  return "lan-member";
}

function normalizeAccessStatus(
  value: unknown,
): GatewayAccessConsumer["status"] {
  if (value === "paused" || value === "expired") {
    return value;
  }
  return "enabled";
}

function normalizeAccessKeyStatus(value: unknown): GatewayAccessKey["status"] {
  if (
    value === "paused" ||
    value === "expired" ||
    value === "rotated"
  ) {
    return value;
  }
  return "enabled";
}

function normalizeAccessAlertThresholdRatio(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(1, Math.max(0.01, value));
}

function normalizePoolVisibility(value: unknown): GatewayPoolVisibility {
  if (value === "shared-lan" || value === "public-ready") {
    return value;
  }
  return "private";
}

function normalizePoolSelectionStrategy(
  value: unknown,
): GatewaySessionPoolDefinition["selectionStrategy"] {
  if (
    value === "priority" ||
    value === "quota-desc" ||
    value === "single-drain" ||
    value === "expiry-asc" ||
    value === "least-recently-used" ||
    value === "hybrid"
  ) {
    return value;
  }
  return "hybrid";
}

function normalizePoolSettingsForSave(
  input: GatewaySessionPoolSettings,
): GatewaySessionPoolSettings {
  return {
    ...input,
    pools: (input.pools ?? []).map((pool) => ({
      ...pool,
      visibility: normalizePoolVisibility(pool.visibility),
      selectionStrategy: normalizePoolSelectionStrategy(pool.selectionStrategy),
    })),
  };
}

function normalizePublicAccessProvider(
  value: unknown,
): GatewayPublicAccessProvider {
  if (value === "tailscale-funnel" || value === "manual-reverse-proxy") {
    return value;
  }
  return "cloudflare-tunnel";
}

function normalizePublicBaseUrl(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return undefined;
  }
  return raw.replace(/\/+$/, "");
}

function normalizeOptionalTrimmedString(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function normalizePublicAccessSettingsForSave(
  input: GatewayPublicAccessSettings | undefined,
  previous: GatewayPublicAccessSettings | undefined,
): GatewayPublicAccessSettings {
  if (!input) {
    return {
      enabled: Boolean(previous?.enabled),
      provider: previous?.provider ?? "cloudflare-tunnel",
      publicBaseUrl: previous?.publicBaseUrl,
      tunnelName: previous?.tunnelName,
      hostname: previous?.hostname,
    };
  }

  return {
    enabled: Boolean(input.enabled),
    provider: normalizePublicAccessProvider(input.provider),
    publicBaseUrl: normalizePublicBaseUrl(input.publicBaseUrl),
    tunnelName: normalizeOptionalTrimmedString(input.tunnelName),
    hostname: normalizeOptionalTrimmedString(input.hostname),
  };
}

function normalizeAccessControlSettingsForSave(
  input: AccessControlInput | undefined,
  previous: GatewayAccessControlSettings | undefined,
): GatewayAccessControlSettings | undefined {
  if (!input) {
    return previous;
  }

  const now = new Date().toISOString();
  const previousConsumersById = new Map(
    (previous?.consumers ?? []).map((item) => [item.id, item]),
  );
  const previousKeysById = new Map(
    (previous?.keys ?? []).map((item) => [item.id, item]),
  );
  const consumers: GatewayAccessConsumer[] = [];
  for (const item of input.consumers ?? []) {
    const id = normalizeAccessId(item.id);
    const name = String(item.name ?? "").trim();
    const clientTag = normalizeAccessId(item.clientTag);
    if (!id || !name || !clientTag) {
      continue;
    }
    const previousConsumer = previousConsumersById.get(id);
    consumers.push({
      id,
      name,
      type: normalizeAccessConsumerType(item.type),
      status: normalizeAccessStatus(item.status),
      clientTag,
      note: item.note?.trim() || undefined,
      tags: normalizeTags(item.tags),
      createdAt: item.createdAt ?? previousConsumer?.createdAt ?? now,
      updatedAt: now,
    });
  }

  const consumerIds = new Set(consumers.map((item) => item.id));
  const keys: GatewayAccessKey[] = [];
  for (const item of input.keys ?? []) {
    const id = normalizeAccessId(item.id);
    const consumerId = normalizeAccessId(item.consumerId);
    const name = String(item.name ?? "").trim();
    if (!id || !consumerId || !name || !consumerIds.has(consumerId)) {
      continue;
    }
    const previousKey = previousKeysById.get(id);
    const apiKey = String(item.apiKey ?? "").trim();
    const keyHash = apiKey
      ? hashAccessApiKey(apiKey)
      : item.keyHash ?? previousKey?.keyHash ?? "";
    if (!keyHash) {
      continue;
    }
    keys.push({
      id,
      consumerId,
      name,
      keyHash,
      keyPrefix: apiKey
        ? apiKey.slice(0, 8)
        : item.keyPrefix ?? previousKey?.keyPrefix ?? "",
      keySuffix: apiKey
        ? apiKey.slice(-4)
        : item.keySuffix ?? previousKey?.keySuffix ?? "",
      status: normalizeAccessKeyStatus(item.status),
      expiresAt: item.expiresAt || undefined,
      lastUsedAt: item.lastUsedAt ?? previousKey?.lastUsedAt,
      lastUsedFromHash: item.lastUsedFromHash ?? previousKey?.lastUsedFromHash,
      createdAt: item.createdAt ?? previousKey?.createdAt ?? now,
      rotatedAt: item.rotatedAt ?? previousKey?.rotatedAt,
    });
  }

  const policies: GatewayAccessPolicy[] = [];
  for (const item of input.policies ?? []) {
    const consumerId = normalizeAccessId(item.consumerId);
    if (!consumerIds.has(consumerId)) {
      continue;
    }
    policies.push({
      consumerId,
      allowedModelAliases: Array.isArray(item.allowedModelAliases)
        ? item.allowedModelAliases
            .map((value) => String(value ?? "").trim())
            .filter((value) => value.length > 0)
        : undefined,
      allowedPoolIds: Array.isArray(item.allowedPoolIds)
        ? item.allowedPoolIds
            .map((value) => String(value ?? "").trim())
            .filter((value) => value.length > 0)
        : undefined,
      quota: item.quota,
      limits: item.limits,
      modelSwitching: item.modelSwitching,
      expiresAt: item.expiresAt || undefined,
    });
  }

  return {
    consumers,
    keys,
    policies,
    alertThresholds:
      input.alertThresholds === undefined
        ? previous?.alertThresholds
        : {
            dailyQuotaWarningRatio: normalizeAccessAlertThresholdRatio(
              input.alertThresholds?.dailyQuotaWarningRatio,
            ),
            runtimeWarningRatio: normalizeAccessAlertThresholdRatio(
              input.alertThresholds?.runtimeWarningRatio,
            ),
            failureRateWarningRatio: normalizeAccessAlertThresholdRatio(
              input.alertThresholds?.failureRateWarningRatio,
            ),
          },
  };
}

function resolveAccessCredential(
  settings: GatewayInferenceAuthSettings,
  incomingKey: string | undefined,
): AccessCredentialContext | undefined {
  if (!incomingKey) {
    return undefined;
  }

  const accessControl = settings.accessControl;
  const keyHash = hashAccessApiKey(incomingKey);
  const accessKey = accessControl?.keys?.find((item) => item.keyHash === keyHash);
  if (!accessKey) {
    return undefined;
  }

  if (accessKey.status === "paused" || accessKey.status === "rotated") {
    throw new GatewayError(403, "access_key_paused", "Access key is paused.");
  }
  if (accessKey.status === "expired" || isPastIsoDate(accessKey.expiresAt)) {
    throw new GatewayError(403, "access_key_expired", "Access key is expired.");
  }

  const consumer = accessControl?.consumers?.find(
    (item) => item.id === accessKey.consumerId,
  );
  if (!consumer) {
    throw new GatewayError(403, "access_consumer_not_found", "Access consumer is missing.");
  }
  if (consumer.status === "paused") {
    throw new GatewayError(403, "access_consumer_paused", "Access consumer is paused.");
  }
  if (consumer.status === "expired") {
    throw new GatewayError(403, "access_consumer_expired", "Access consumer is expired.");
  }
  assertPublicUserAllowedForPublicAccess(consumer, settings, accessKey.id);

  return {
    consumerId: consumer.id,
    consumerName: consumer.name,
    consumerType: consumer.type,
    consumerCreatedAt: consumer.createdAt,
    accessKeyId: accessKey.id,
    clientTag: consumer.clientTag,
    policy: accessControl?.policies?.find(
      (item) => item.consumerId === consumer.id,
    ),
  };
}

function assertPublicUserAllowedForPublicAccess(
  consumer:
    | Pick<GatewayAccessConsumer, "id" | "type">
    | AccessCredentialContext
    | undefined,
  settings: GatewayInferenceAuthSettings,
  accessKeyId?: string,
): void {
  if (!consumer) {
    return;
  }
  const consumerType =
    "consumerType" in consumer ? consumer.consumerType : consumer.type;
  if (consumerType !== "public-user") {
    return;
  }
  if (
    settings.publicAccess?.enabled &&
    settings.publicAccess.publicBaseUrl?.startsWith("https://")
  ) {
    return;
  }

  throw new GatewayError(
    403,
    "access_policy_public_user_disabled",
    "Public-user access consumers require explicitly enabled public sharing.",
    {
      consumerId: "consumerId" in consumer ? consumer.consumerId : consumer.id,
      ...(accessKeyId ? { accessKeyId } : {}),
      consumerType: "public-user",
      phase: "phase-three",
      publicAccessEnabled: Boolean(settings.publicAccess?.enabled),
    },
  );
}

function assertAccessPolicyAllowsModel(
  accessContext: AccessCredentialContext | undefined,
  requestedModelAlias: string,
  originalModelAlias = requestedModelAlias,
): void {
  const allowed = accessContext?.policy?.allowedModelAliases;
  if (!allowed?.length) {
    return;
  }
  if (!allowed.includes(requestedModelAlias)) {
    throw new GatewayError(
      403,
      "access_policy_model_denied",
      "Requested model is not allowed for this access consumer.",
      {
        consumerId: accessContext?.consumerId,
        accessKeyId: accessContext?.accessKeyId,
        requestedModelAlias: originalModelAlias,
        resolvedModelAlias: requestedModelAlias,
      },
    );
  }
}

function resolveCompatibleModelAlias(
  runtime: GatewayRuntime,
  requestedModelAlias: string,
): string {
  const trimmed = requestedModelAlias.trim();
  if (runtime.getProviderAdapterForModel(trimmed)) {
    return trimmed;
  }

  const caseMatchedAlias = runtime.modelRegistry
    .list()
    .find((model) => model.alias.toLowerCase() === trimmed.toLowerCase())?.alias;
  if (caseMatchedAlias && runtime.getProviderAdapterForModel(caseMatchedAlias)) {
    return caseMatchedAlias;
  }

  const codexAlias = getCodexAliasForUpstreamModel(trimmed);
  if (codexAlias && runtime.getProviderAdapterForModel(codexAlias)) {
    return codexAlias;
  }

  return trimmed;
}

function assertAccessPolicyNotExpired(
  accessContext: AccessCredentialContext | undefined,
): void {
  const expiresAt = accessContext?.policy?.expiresAt;
  if (!accessContext || !isPastIsoDate(expiresAt)) {
    return;
  }
  throw new GatewayError(
    403,
    "access_policy_expired",
    "Access policy is expired.",
    {
      consumerId: accessContext.consumerId,
      accessKeyId: accessContext.accessKeyId,
      expiresAt,
    },
  );
}

function normalizePolicyLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function getAccessPolicyDailyQuotaWindow(
  now: number,
  resetTimezone: string | undefined,
): { start: number; resetAt: number; timezone: string } {
  const normalizedTimezone = resetTimezone?.trim().toUpperCase();
  if (normalizedTimezone === "UTC") {
    const current = new Date(now);
    const start = Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate(),
    );
    return {
      start,
      resetAt: start + 24 * 60 * 60 * 1000,
      timezone: "UTC",
    };
  }

  const current = new Date(now);
  const start = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
  ).getTime();
  return {
    start,
    resetAt: new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate() + 1,
    ).getTime(),
    timezone: "local",
  };
}

function assertAccessPolicyWithinDailyQuota(
  runtime: GatewayRuntime,
  accessContext: AccessCredentialContext | undefined,
): void {
  const limit = normalizePolicyLimit(
    accessContext?.policy?.quota?.dailyTokenLimit,
  );
  if (typeof limit !== "number" || !accessContext) {
    return;
  }

  const now = Date.now();
  const window = getAccessPolicyDailyQuotaWindow(
    now,
    accessContext.policy?.quota?.resetTimezone,
  );
  const usage = runtime.database.getUsageTotalsForAccessConsumer({
    consumerId: accessContext.consumerId,
    sinceTimestamp: window.start,
  });
  if (usage.totalTokens < limit) {
    return;
  }

  throw new GatewayError(
    429,
    "access_policy_daily_quota_exceeded",
    "Access consumer daily token quota has been exceeded.",
    {
      consumerId: accessContext.consumerId,
      accessKeyId: accessContext.accessKeyId,
      limit,
      usedTokens: usage.totalTokens,
      remainingTokens: 0,
      resetAt: new Date(window.resetAt).toISOString(),
      resetTimezone: window.timezone,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    },
  );
}

function parsePolicyTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function getAccessPolicyPeriodWindow(
  accessContext: AccessCredentialContext,
): { start: number; end: number; days: number } | undefined {
  const periodDays = normalizePolicyLimit(
    accessContext.policy?.quota?.periodDays,
  );
  const limit = normalizePolicyLimit(
    accessContext.policy?.quota?.periodTokenLimit,
  );
  if (
    typeof periodDays !== "number" ||
    periodDays <= 0 ||
    typeof limit !== "number"
  ) {
    return undefined;
  }

  const start =
    parsePolicyTimestamp(accessContext.policy?.quota?.periodStartedAt) ??
    parsePolicyTimestamp(accessContext.consumerCreatedAt) ??
    Date.now();
  return {
    start,
    end: start + periodDays * 24 * 60 * 60 * 1000,
    days: periodDays,
  };
}

function getAccessPolicyMonthlyQuotaWindow(
  now: number,
  resetTimezone: string | undefined,
): { start: number; end: number; timezone: string } {
  const normalizedTimezone = resetTimezone?.trim().toUpperCase();
  if (normalizedTimezone === "UTC") {
    const current = new Date(now);
    const start = Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      1,
    );
    return {
      start,
      end: Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1),
      timezone: "UTC",
    };
  }

  const current = new Date(now);
  const start = new Date(
    current.getFullYear(),
    current.getMonth(),
    1,
  ).getTime();
  return {
    start,
    end: new Date(
      current.getFullYear(),
      current.getMonth() + 1,
      1,
    ).getTime(),
    timezone: "local",
  };
}

type UserBalanceQuotaMode =
  | "period"
  | "total"
  | "daily"
  | "monthly"
  | "unlimited";

function buildGatewayModelResponse(model: GatewayModelDefinition) {
  const response = buildModelsResponse([model]);
  return response.data[0];
}

function buildUnlimitedUserBalanceResponse(authContext: {
  clientTag?: string;
  accessContext?: AccessCredentialContext;
}) {
  return {
    is_active: true,
    unit: "tokens",
    balance: null,
    used: 0,
    total: null,
    quota_mode: "unlimited" satisfies UserBalanceQuotaMode,
    planName: authContext.accessContext
      ? `${authContext.accessContext.consumerName} · unlimited`
      : "Gateway API key · unlimited",
    consumer_id: authContext.accessContext?.consumerId,
    access_key_id: authContext.accessContext?.accessKeyId,
    client_tag: authContext.accessContext?.clientTag ?? authContext.clientTag,
    extra: {
      quota_mode: "unlimited",
      consumer_id: authContext.accessContext?.consumerId,
      access_key_id: authContext.accessContext?.accessKeyId,
      client_tag: authContext.accessContext?.clientTag ?? authContext.clientTag,
    },
  };
}

function buildLimitedUserBalanceResponse(input: {
  accessContext: AccessCredentialContext;
  mode: Exclude<UserBalanceQuotaMode, "unlimited">;
  limit: number;
  usage: GatewayUsageCounters;
  resetAt?: number;
  periodDays?: number;
  resetTimezone?: string;
}) {
  const used = Math.max(0, Math.floor(input.usage.totalTokens));
  const total = Math.max(0, Math.floor(input.limit));
  const balance = Math.max(0, total - used);
  return {
    is_active: true,
    unit: "tokens",
    balance,
    used,
    total,
    quota_mode: input.mode,
    ...(typeof input.resetAt === "number" ? { reset_at: input.resetAt } : {}),
    planName: `${input.accessContext.consumerName} · ${input.mode} token quota`,
    consumer_id: input.accessContext.consumerId,
    access_key_id: input.accessContext.accessKeyId,
    client_tag: input.accessContext.clientTag,
    extra: {
      consumer_id: input.accessContext.consumerId,
      access_key_id: input.accessContext.accessKeyId,
      client_tag: input.accessContext.clientTag,
      quota_mode: input.mode,
      ...(typeof input.periodDays === "number"
        ? { period_days: input.periodDays }
        : {}),
      ...(input.resetTimezone ? { reset_timezone: input.resetTimezone } : {}),
    },
  };
}

function buildUserBalanceResponse(
  runtime: GatewayRuntime,
  authContext: {
    clientTag?: string;
    accessContext?: AccessCredentialContext;
  },
) {
  const accessContext = authContext.accessContext;
  if (!accessContext) {
    return buildUnlimitedUserBalanceResponse(authContext);
  }
  assertAccessPolicyNotExpired(accessContext);

  const quota = accessContext.policy?.quota;
  const periodLimit = normalizePolicyLimit(quota?.periodTokenLimit);
  const periodWindow = getAccessPolicyPeriodWindow(accessContext);
  if (typeof periodLimit === "number" && periodWindow) {
    const usage = runtime.database.getUsageTotalsForAccessConsumer({
      consumerId: accessContext.consumerId,
      sinceTimestamp: periodWindow.start,
    });
    return buildLimitedUserBalanceResponse({
      accessContext,
      mode: "period",
      limit: periodLimit,
      usage,
      resetAt: periodWindow.end,
      periodDays: periodWindow.days,
    });
  }

  const totalLimit = normalizePolicyLimit(quota?.totalTokenLimit);
  if (typeof totalLimit === "number") {
    const usage = runtime.database.getUsageTotalsForAccessConsumer({
      consumerId: accessContext.consumerId,
    });
    return buildLimitedUserBalanceResponse({
      accessContext,
      mode: "total",
      limit: totalLimit,
      usage,
    });
  }

  const now = Date.now();
  const dailyLimit = normalizePolicyLimit(quota?.dailyTokenLimit);
  if (typeof dailyLimit === "number") {
    const window = getAccessPolicyDailyQuotaWindow(now, quota?.resetTimezone);
    const usage = runtime.database.getUsageTotalsForAccessConsumer({
      consumerId: accessContext.consumerId,
      sinceTimestamp: window.start,
    });
    return buildLimitedUserBalanceResponse({
      accessContext,
      mode: "daily",
      limit: dailyLimit,
      usage,
      resetAt: window.resetAt,
      resetTimezone: window.timezone,
    });
  }

  const monthlyLimit = normalizePolicyLimit(quota?.monthlyTokenLimit);
  if (typeof monthlyLimit === "number") {
    const window = getAccessPolicyMonthlyQuotaWindow(now, quota?.resetTimezone);
    const usage = runtime.database.getUsageTotalsForAccessConsumer({
      consumerId: accessContext.consumerId,
      sinceTimestamp: window.start,
    });
    return buildLimitedUserBalanceResponse({
      accessContext,
      mode: "monthly",
      limit: monthlyLimit,
      usage,
      resetAt: window.end,
      resetTimezone: window.timezone,
    });
  }

  return buildUnlimitedUserBalanceResponse(authContext);
}

type UserBalanceResponse = ReturnType<typeof buildUserBalanceResponse>;

function buildUserPortalBalanceSummary(balance: UserBalanceResponse) {
  const resetAt = toFiniteNumber((balance as { reset_at?: unknown }).reset_at);
  return {
    unit: balance.unit,
    quotaMode: balance.quota_mode,
    total: toFiniteNumber(balance.total),
    used: toFiniteNumber(balance.used) ?? 0,
    remaining: toFiniteNumber(balance.balance),
    ...(typeof resetAt === "number" ? { resetAt } : {}),
    planName: balance.planName,
  };
}

function requireUserSelfServiceAuth(
  runtime: GatewayRuntime,
  request: FastifyRequest,
): {
  clientTag?: string;
  accessContext: AccessCredentialContext;
} {
  requireInferenceNetworkAccess(runtime, request);
  const incomingKey = readClientApiKey(request);
  if (!incomingKey) {
    throw new GatewayError(
      401,
      "gateway_api_key_required",
      "Missing API key for gateway self-service endpoint.",
    );
  }
  const settings = runtime.configStore.getInferenceAuthSettings();
  const accessContext = resolveAccessCredential(settings, incomingKey);
  if (!accessContext) {
    throw new GatewayError(
      403,
      "gateway_api_key_invalid",
      "Invalid API key for gateway self-service endpoint.",
    );
  }
  assertAccessPolicyNotExpired(accessContext);
  return {
    clientTag: accessContext.clientTag,
    accessContext,
  };
}

function buildUserProfileResponse(
  runtime: GatewayRuntime,
  authContext: {
    clientTag?: string;
    accessContext: AccessCredentialContext;
  },
) {
  const accessControl =
    runtime.configStore.getInferenceAuthSettings().accessControl ?? {};
  const accessContext = authContext.accessContext;
  const consumer = accessControl.consumers?.find(
    (item) => item.id === accessContext.consumerId,
  );
  const accessKey = accessControl.keys?.find(
    (item) => item.id === accessContext.accessKeyId,
  );
  const policy =
    accessControl.policies?.find(
      (item) => item.consumerId === accessContext.consumerId,
    ) ?? accessContext.policy;
  const balance = buildUserBalanceResponse(runtime, authContext);

  return {
    ok: true,
    data: {
      consumer: {
        id: accessContext.consumerId,
        name: consumer?.name ?? accessContext.consumerName,
        type: consumer?.type ?? accessContext.consumerType,
        status: consumer?.status ?? "enabled",
        clientTag: consumer?.clientTag ?? accessContext.clientTag,
        tags: consumer?.tags ?? [],
        createdAt: consumer?.createdAt ?? accessContext.consumerCreatedAt,
        updatedAt: consumer?.updatedAt,
      },
      accessKey: accessKey
        ? {
            id: accessKey.id,
            name: accessKey.name,
            keyPrefix: accessKey.keyPrefix,
            keySuffix: accessKey.keySuffix,
            status: accessKey.status,
            expiresAt: accessKey.expiresAt,
            lastUsedAt: accessKey.lastUsedAt,
            createdAt: accessKey.createdAt,
            rotatedAt: accessKey.rotatedAt,
          }
        : undefined,
      policy: policy
        ? {
            allowedModelAliases: policy.allowedModelAliases ?? [],
            allowedPoolIds: policy.allowedPoolIds ?? [],
            quota: policy.quota,
            limits: policy.limits,
            modelSwitching: policy.modelSwitching,
            expiresAt: policy.expiresAt,
          }
        : undefined,
      balance: buildUserPortalBalanceSummary(balance),
    },
  };
}

function resolveUserUsageRange(value: unknown): GatewayUsageAnalyticsRange {
  if (value === "7d" || value === "30d" || value === "all") {
    return value;
  }
  return "24h";
}

function buildUserUsageSummaryResponse(
  runtime: GatewayRuntime,
  authContext: {
    accessContext: AccessCredentialContext;
  },
  query: unknown,
) {
  const range = resolveUserUsageRange(
    (query as { range?: string } | undefined)?.range,
  );
  const granularity: GatewayUsageAnalyticsGranularity =
    range === "24h" ? "hour" : "day";
  return {
    ok: true,
    data: runtime.getUsageAnalytics({
      range,
      granularity,
      filters: {
        consumerId: authContext.accessContext.consumerId,
        accessKeyId: authContext.accessContext.accessKeyId,
      },
    }),
  };
}

function buildPublicAccountPortalHtmlV2(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RelayGate Account Center</title>
  <style>
    :root {
      color-scheme: light;
      --color-neutral-50: #fafafa;
      --color-neutral-100: #f4f4f5;
      --color-neutral-200: #e4e4e7;
      --color-neutral-300: #d4d4d8;
      --color-neutral-400: #a1a1aa;
      --color-neutral-500: #71717a;
      --color-neutral-600: #52525b;
      --color-neutral-700: #3f3f46;
      --color-neutral-800: #27272a;
      --color-neutral-900: #18181b;
      --color-brand-50: #eff6ff;
      --color-brand-400: #60a5fa;
      --color-brand-500: #3b82f6;
      --color-brand-600: #2563eb;
      --color-brand-700: #1d4ed8;
      --color-success-50: #f0fdf4;
      --color-success-500: #22c55e;
      --color-success-600: #16a34a;
      --color-warning-50: #fffbeb;
      --color-warning-500: #f59e0b;
      --color-warning-600: #d97706;
      --color-error-50: #fef2f2;
      --color-error-500: #ef4444;
      --color-error-600: #dc2626;
      --color-bg-app: #f6f7fb;
      --color-bg-card: #ffffff;
      --color-bg-elevated: #f4f7fb;
      --color-bg-hover: #f1f5f9;
      --color-bg-active: #e8f1ff;
      --color-border-default: #d9e0ea;
      --color-border-subtle: #e8edf4;
      --color-border-strong: #c4ccd8;
      --card-surface: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
      --card-shadow: 0 1px 2px rgba(15, 23, 42, 0.05), 0 8px 20px rgba(15, 23, 42, 0.045);
      --card-shadow-hover: 0 1px 2px rgba(15, 23, 42, 0.06), 0 14px 30px rgba(15, 23, 42, 0.09);
      --text-primary: #111827;
      --text-secondary: #4b5563;
      --text-tertiary: #6b7280;
      --accent-color: var(--color-brand-600);
      --accent-soft: rgba(37, 99, 235, 0.1);
      --success: var(--color-success-500);
      --success-bg: var(--color-success-50);
      --success-border: rgba(22, 163, 74, 0.28);
      --warning: var(--color-warning-600);
      --warning-bg: var(--color-warning-50);
      --warning-border: rgba(217, 119, 6, 0.28);
      --danger: var(--color-error-600);
      --danger-bg: var(--color-error-50);
      --danger-border: rgba(220, 38, 38, 0.25);
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-xl: 16px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      min-height: 100vh;
      background:
        radial-gradient(circle at 22% -10%, rgba(37, 99, 235, 0.12), transparent 32rem),
        radial-gradient(circle at 86% 4%, rgba(34, 197, 94, 0.08), transparent 28rem),
        linear-gradient(180deg, #fbfdff 0%, var(--color-bg-app) 48%, #eef3fa 100%);
      color: var(--text-primary);
      font-size: 14px;
      line-height: 1.5715;
      -webkit-font-smoothing: antialiased;
    }
    button, input, select { font: inherit; outline: none; }
    button { cursor: pointer; }
    .rg-shell {
      display: grid;
      grid-template-columns: minmax(280px, 332px) minmax(0, 1fr);
      gap: 18px;
      width: min(1360px, calc(100% - 36px));
      min-height: 100vh;
      margin: 0 auto;
      padding: 18px 0 24px;
    }
    .rg-sidebar,
    .rg-main-card,
    .rg-card,
    .rg-panel {
      border: 1px solid var(--color-border-subtle);
      background: var(--card-surface);
      box-shadow: var(--card-shadow);
    }
    .rg-sidebar {
      position: sticky;
      top: 18px;
      align-self: start;
      display: grid;
      gap: 14px;
      max-height: calc(100vh - 36px);
      padding: 16px;
      overflow: auto;
      border-radius: var(--radius-xl);
    }
    .rg-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      border: 1px solid color-mix(in oklab, var(--accent-color) 16%, var(--color-border-subtle));
      border-radius: var(--radius-lg);
      background:
        linear-gradient(135deg, rgba(37, 99, 235, 0.1), rgba(34, 197, 94, 0.05)),
        var(--color-bg-card);
    }
    .rg-logo {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--color-brand-600), #0f766e);
      color: #fff;
      font-size: 20px;
      font-weight: 900;
      letter-spacing: -0.06em;
    }
    .rg-brand-title { display: grid; gap: 2px; min-width: 0; }
    .rg-brand-title strong { font-size: 15px; line-height: 1.2; }
    .rg-brand-title span { color: var(--text-tertiary); font-size: 12px; }
    .rg-form {
      display: grid;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-lg);
      background: color-mix(in oklab, var(--color-bg-elevated) 74%, white);
    }
    .rg-field { display: grid; gap: 7px; }
    .rg-field label {
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 800;
    }
    .rg-input-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .rg-input,
    .rg-select {
      width: 100%;
      min-height: 38px;
      padding: 8px 11px;
      border: 1px solid var(--color-border-default);
      border-radius: var(--radius-md);
      background: #fff;
      color: var(--text-primary);
      font-size: 13px;
      transition: border-color 0.16s ease, box-shadow 0.16s ease;
    }
    .rg-input:focus,
    .rg-select:focus {
      border-color: color-mix(in oklab, var(--accent-color) 56%, var(--color-border-default));
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }
    .rg-button {
      min-height: 38px;
      padding: 8px 13px;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      background: var(--color-brand-600);
      color: #fff;
      font-size: 13px;
      font-weight: 800;
      transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
    }
    .rg-button:hover { background: var(--color-brand-700); box-shadow: 0 10px 20px rgba(37, 99, 235, 0.16); transform: translateY(-1px); }
    .rg-button.secondary {
      border-color: var(--color-border-default);
      background: #fff;
      color: var(--text-secondary);
    }
    .rg-button.secondary:hover {
      border-color: color-mix(in oklab, var(--accent-color) 36%, var(--color-border-default));
      background: var(--color-bg-active);
      color: var(--color-brand-700);
    }
    .rg-button:disabled {
      cursor: not-allowed;
      opacity: 0.56;
      transform: none;
      box-shadow: none;
    }
    .rg-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .rg-status {
      min-height: 36px;
      padding: 9px 11px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      background: #fff;
      color: var(--text-tertiary);
      font-size: 12px;
    }
    .rg-status.ok {
      border-color: var(--success-border);
      background: var(--success-bg);
      color: color-mix(in oklab, var(--success) 72%, black);
    }
    .rg-status.error {
      border-color: var(--danger-border);
      background: var(--danger-bg);
      color: var(--danger);
    }
    .rg-side-section {
      display: grid;
      gap: 10px;
      padding: 14px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-lg);
      background: #fff;
    }
    .rg-side-section h2 {
      margin: 0;
      font-size: 13px;
    }
    .rg-side-section p {
      margin: 0;
      color: var(--text-secondary);
      font-size: 12px;
    }
    .rg-chip-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .rg-chip {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 4px 8px;
      border: 1px solid color-mix(in oklab, var(--accent-color) 18%, var(--color-border-subtle));
      border-radius: 999px;
      background: color-mix(in oklab, var(--accent-color) 7%, white);
      color: color-mix(in oklab, var(--accent-color) 70%, black);
      font-size: 11px;
      font-weight: 800;
    }
    .rg-main {
      display: grid;
      gap: 14px;
      min-width: 0;
    }
    .rg-main-card {
      display: grid;
      gap: 14px;
      padding: 18px;
      border-radius: var(--radius-xl);
    }
    .rg-topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 16px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-lg);
      background:
        linear-gradient(135deg, rgba(37, 99, 235, 0.07), rgba(255, 255, 255, 0.72)),
        #fff;
    }
    .rg-eyebrow {
      display: inline-flex;
      width: fit-content;
      min-height: 24px;
      align-items: center;
      padding: 4px 9px;
      border: 1px solid color-mix(in oklab, var(--accent-color) 24%, var(--color-border-subtle));
      border-radius: 999px;
      background: color-mix(in oklab, var(--accent-color) 9%, white);
      color: var(--color-brand-700);
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .rg-title-block { display: grid; gap: 8px; min-width: 0; }
    .rg-title-block h1 {
      margin: 0;
      color: var(--text-primary);
      font-size: clamp(24px, 4vw, 36px);
      line-height: 1.08;
      letter-spacing: -0.045em;
    }
    .rg-title-block p {
      max-width: 720px;
      margin: 0;
      color: var(--text-secondary);
      font-size: 13px;
    }
    .rg-live-card {
      display: grid;
      gap: 5px;
      min-width: 170px;
      padding: 12px;
      border: 1px solid var(--success-border);
      border-radius: var(--radius-md);
      background: var(--success-bg);
      color: color-mix(in oklab, var(--success) 68%, black);
    }
    .rg-live-card small { font-size: 11px; font-weight: 900; }
    .rg-live-card strong { font-size: 18px; }
    .rg-summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .rg-card {
      display: grid;
      gap: 8px;
      min-width: 0;
      min-height: 124px;
      padding: 14px;
      border-radius: var(--radius-lg);
      transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
    }
    .rg-card:hover {
      border-color: var(--color-border-strong);
      box-shadow: var(--card-shadow-hover);
      transform: translateY(-1px);
    }
    .rg-card small {
      color: var(--text-tertiary);
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .rg-card strong {
      overflow: hidden;
      color: var(--text-primary);
      font-size: clamp(24px, 4vw, 34px);
      line-height: 1;
      letter-spacing: -0.05em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rg-card span {
      overflow: hidden;
      color: var(--text-secondary);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rg-panel-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(300px, 0.75fr);
      gap: 14px;
      min-width: 0;
    }
    .rg-panel {
      display: grid;
      gap: 12px;
      min-width: 0;
      padding: 14px 16px;
      border-radius: var(--radius-lg);
    }
    .rg-panel.wide { grid-column: 1 / -1; }
    .rg-panel-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .rg-panel-head div { display: grid; gap: 4px; min-width: 0; }
    .rg-panel-head strong { color: var(--text-primary); font-size: 14px; }
    .rg-panel-head span {
      overflow: hidden;
      color: var(--text-secondary);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rg-quota-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 132px;
      gap: 14px;
      align-items: center;
    }
    .rg-quota-percent {
      display: grid;
      place-items: center;
      align-content: center;
      width: 132px;
      height: 132px;
      border: 1px solid color-mix(in oklab, var(--accent-color) 22%, var(--color-border-subtle));
      border-radius: 32px;
      background: color-mix(in oklab, var(--accent-color) 8%, white);
    }
    .rg-quota-percent strong {
      color: var(--color-brand-700);
      font-size: 30px;
      line-height: 1;
      letter-spacing: -0.05em;
    }
    .rg-quota-percent span {
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 800;
    }
    .rg-track {
      height: 10px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--color-bg-elevated);
    }
    .rg-bar {
      height: 100%;
      min-width: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--color-brand-600), var(--success));
      transition: width 0.24s ease;
    }
    .rg-meta-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .rg-meta {
      display: grid;
      gap: 3px;
      min-width: 0;
      padding: 10px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      background: color-mix(in oklab, var(--color-bg-elevated) 76%, white);
    }
    .rg-meta small,
    .rg-meta strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rg-meta small { color: var(--text-tertiary); font-size: 11px; font-weight: 800; }
    .rg-meta strong { color: var(--text-primary); font-size: 13px; }
    .rg-composition { display: grid; gap: 10px; }
    .rg-comp-row {
      display: grid;
      grid-template-columns: 64px minmax(0, 1fr) 86px;
      gap: 10px;
      align-items: center;
      color: var(--text-secondary);
      font-size: 12px;
    }
    .rg-comp-row strong {
      overflow: hidden;
      color: var(--text-primary);
      font-size: 12px;
      text-align: right;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rg-bars {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(18px, 1fr));
      gap: 7px;
      align-items: end;
      min-height: 248px;
      padding: 12px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      background:
        linear-gradient(to bottom, color-mix(in oklab, var(--color-border-subtle) 42%, transparent) 1px, transparent 1px) 0 0 / 100% 25%,
        color-mix(in oklab, var(--color-bg-elevated) 78%, white);
    }
    .rg-tick {
      display: grid;
      gap: 6px;
      align-items: end;
      min-width: 0;
    }
    .rg-tick i {
      display: block;
      min-height: 4px;
      border-radius: 999px 999px 5px 5px;
      background: linear-gradient(180deg, var(--color-brand-600), color-mix(in oklab, var(--color-brand-600) 46%, white));
      box-shadow: 0 8px 16px rgba(37, 99, 235, 0.12);
    }
    .rg-tick span {
      overflow: hidden;
      color: var(--text-tertiary);
      font-size: 10px;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rg-ranking { display: grid; gap: 11px; }
    .rg-rank-row {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
    }
    .rg-rank-index {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      background: var(--color-bg-elevated);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 800;
    }
    .rg-rank-main { display: grid; gap: 6px; min-width: 0; }
    .rg-rank-line {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
      color: var(--text-secondary);
      font-size: 12px;
    }
    .rg-rank-line strong,
    .rg-rank-line span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rg-rank-line strong { color: var(--text-primary); }
    .rg-empty {
      padding: 18px;
      border: 1px dashed var(--color-border-default);
      border-radius: var(--radius-md);
      background: color-mix(in oklab, var(--color-bg-elevated) 72%, white);
      color: var(--text-tertiary);
      font-size: 12px;
      text-align: center;
    }
    .rg-safe-note {
      padding: 12px 14px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-lg);
      background: #fff;
      color: var(--text-secondary);
      font-size: 12px;
    }
    [hidden] { display: none !important; }
    @media (max-width: 1080px) {
      .rg-shell { grid-template-columns: 1fr; }
      .rg-sidebar { position: static; max-height: none; }
      .rg-panel-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 760px) {
      .rg-shell { width: min(100% - 20px, 1360px); padding-top: 10px; }
      .rg-topbar { display: grid; }
      .rg-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .rg-quota-layout { grid-template-columns: 1fr; }
      .rg-quota-percent { width: 100%; height: auto; min-height: 104px; border-radius: var(--radius-lg); }
      .rg-meta-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      .rg-summary-grid { grid-template-columns: 1fr; }
      .rg-input-row,
      .rg-actions,
      .rg-comp-row { grid-template-columns: 1fr; }
      .rg-comp-row strong { text-align: left; }
    }
  </style>
</head>
<body>
  <main class="rg-shell">
    <aside class="rg-sidebar" aria-label="RelayGate Account Center">
      <div class="rg-brand">
        <div class="rg-logo">R</div>
        <div class="rg-brand-title">
          <strong>RelayGate Account Center</strong>
          <span>公网成员自助观测面板</span>
        </div>
      </div>
      <form class="rg-form" id="query-form">
        <div class="rg-field">
          <label for="api-key">成员 API Key</label>
          <div class="rg-input-row">
            <input class="rg-input" id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="lag_xxx..." />
            <button class="rg-button secondary" type="button" id="toggle-key">显示</button>
          </div>
        </div>
        <div class="rg-field">
          <label for="range">观测窗口</label>
          <select class="rg-select" id="range">
            <option value="24h">近 24 小时</option>
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
            <option value="all">全部历史</option>
          </select>
        </div>
        <div class="rg-actions">
          <button class="rg-button" type="submit">查询账户</button>
          <button class="rg-button secondary" type="button" id="refresh" disabled>刷新</button>
        </div>
        <div class="rg-status" id="status">Key 只用于本次浏览器会话请求，不写入 URL，不做本地持久保存。</div>
      </form>
      <section class="rg-side-section">
        <h2>安全边界</h2>
        <p>本页只访问自助只读接口，所有统计由服务端按当前成员 Key 自动隔离。</p>
        <div class="rg-chip-list">
          <span class="rg-chip">Self-only</span>
          <span class="rg-chip">No prompt body</span>
          <span class="rg-chip">No full key</span>
        </div>
      </section>
      <section class="rg-side-section">
        <h2>接口范围</h2>
        <p>/v1/user/profile 与 /v1/user/usage/summary；不会请求管理端路径。</p>
      </section>
    </aside>
    <section class="rg-main">
      <div class="rg-main-card">
        <header class="rg-topbar">
          <div class="rg-title-block">
            <span class="rg-eyebrow">Public User Console</span>
            <h1>成员用量与额度</h1>
            <p>面向公网成员的轻量观测台，复用 RelayGate 控制台的统计卡片、Token 构成和趋势观测语言。</p>
          </div>
          <div class="rg-live-card">
            <small>Public Surface</small>
            <strong>/v1/account</strong>
            <small>Admin surface is not exposed</small>
          </div>
        </header>
        <section id="dashboard" hidden>
          <div class="rg-summary-grid">
            <div class="rg-card"><small>剩余额度</small><strong id="remaining">-</strong><span id="quota-mode">-</span></div>
            <div class="rg-card"><small>已用 Token</small><strong id="used">-</strong><span id="total">-</span></div>
            <div class="rg-card"><small>请求数</small><strong id="requests">-</strong><span id="success">-</span></div>
            <div class="rg-card"><small>成功率</small><strong id="success-rate">-</strong><span id="latency">-</span></div>
          </div>
          <div class="rg-panel-grid">
            <section class="rg-panel">
              <div class="rg-panel-head">
                <div>
                  <strong id="member-name">成员</strong>
                  <span id="reset-at">等待查询后显示额度周期</span>
                </div>
              </div>
              <div class="rg-quota-layout">
                <div class="rg-meta-grid">
                  <div class="rg-meta"><small>额度模式</small><strong id="quota-mode-detail">-</strong></div>
                  <div class="rg-meta"><small>Key 状态</small><strong id="key-status">-</strong></div>
                  <div class="rg-meta"><small>允许模型</small><strong id="allowed-models">-</strong></div>
                  <div class="rg-meta"><small>输入 Token</small><strong id="input-total">-</strong></div>
                  <div class="rg-meta"><small>输出 Token</small><strong id="output-total">-</strong></div>
                  <div class="rg-meta"><small>思考 / 缓存</small><strong id="extra-total">-</strong></div>
                </div>
                <div class="rg-quota-percent"><strong id="quota-percent">-</strong><span>剩余比例</span></div>
              </div>
              <div class="rg-track"><div class="rg-bar" id="quota-bar"></div></div>
            </section>
            <section class="rg-panel">
              <div class="rg-panel-head">
                <div>
                  <strong>Token 构成</strong>
                  <span>输入 / 输出 / 缓存 / 思考</span>
                </div>
              </div>
              <div class="rg-composition" id="composition"></div>
            </section>
            <section class="rg-panel wide">
              <div class="rg-panel-head">
                <div>
                  <strong>用量趋势</strong>
                  <span id="trend-subtitle">按当前窗口聚合展示</span>
                </div>
              </div>
              <div class="rg-bars" id="trend"></div>
            </section>
            <section class="rg-panel wide">
              <div class="rg-panel-head">
                <div>
                  <strong>模型排行</strong>
                  <span>当前成员 Key 的模型消耗归因</span>
                </div>
              </div>
              <div class="rg-ranking" id="ranking"></div>
            </section>
          </div>
        </section>
        <section class="rg-safe-note">
          安全边界：本页只调用 /v1/user/profile 与 /v1/user/usage/summary；不会请求管理端路径，不展示完整 Key、上游账号或 prompt 正文。
        </section>
      </div>
    </section>
  </main>
  <script>
    const state = { apiKey: "", profile: null, usage: null };
    const $ = (id) => document.getElementById(id);
    const fmt = (value) => typeof value === "number" ? new Intl.NumberFormat("zh-CN", { notation: value >= 1000000 ? "compact" : "standard" }).format(value) : "-";
    const pct = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 + "%" : "-";
    const setStatus = (message, tone = "") => { $("status").textContent = message; $("status").className = "rg-status " + tone; };
    async function fetchJson(url) {
      const response = await fetch(url, { headers: { authorization: "Bearer " + state.apiKey } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || "查询失败");
      return body.data;
    }
    async function load() {
      state.apiKey = $("api-key").value.trim();
      if (!state.apiKey) { setStatus("请先输入成员 API Key。", "error"); return; }
      setStatus("正在读取账户用量...");
      const range = $("range").value;
      const [profile, usage] = await Promise.all([
        fetchJson("/v1/user/profile"),
        fetchJson("/v1/user/usage/summary?range=" + encodeURIComponent(range)),
      ]);
      state.profile = profile;
      state.usage = usage;
      render();
      $("dashboard").hidden = false;
      $("refresh").disabled = false;
      setStatus("账户用量已刷新。", "ok");
    }
    function render() {
      const balance = state.profile.balance || {};
      const totals = state.usage.summary?.totals || {};
      const total = balance.total;
      const used = balance.used || 0;
      const remaining = balance.remaining;
      const remainRatio = typeof total === "number" && total > 0 && typeof remaining === "number" ? remaining / total : undefined;
      const memberLabel = (state.profile.consumer?.name || "成员") + " · " + (state.profile.accessKey?.keyPrefix || "") + "..." + (state.profile.accessKey?.keySuffix || "");
      $("member-name").textContent = memberLabel;
      $("remaining").textContent = fmt(remaining);
      $("quota-mode").textContent = balance.quotaMode ? "额度模式：" + balance.quotaMode : "未设置固定额度";
      $("quota-mode-detail").textContent = balance.quotaMode || "unlimited";
      $("key-status").textContent = state.profile.accessKey?.status || "-";
      $("allowed-models").textContent = (state.profile.policy?.allowedModelAliases || []).slice(0, 3).join(", ") || "全部";
      $("used").textContent = fmt(used);
      $("total").textContent = typeof total === "number" ? "总额 " + fmt(total) : "不限额或未设置";
      $("requests").textContent = fmt(totals.requestCount || 0);
      $("success").textContent = "成功 " + fmt(totals.successCount || 0) + " / 失败 " + fmt(totals.failureCount || 0);
      const successRate = totals.requestCount ? (totals.successCount || 0) / totals.requestCount * 100 : undefined;
      $("success-rate").textContent = pct(successRate);
      $("latency").textContent = totals.requestCount ? "平均延迟 " + fmt(Math.round((totals.totalLatencyMs || 0) / totals.requestCount)) + "ms" : "暂无请求";
      $("quota-percent").textContent = typeof remainRatio === "number" ? pct(remainRatio * 100) : "不限额";
      $("quota-bar").style.width = typeof remainRatio === "number" ? Math.max(0, Math.min(100, remainRatio * 100)) + "%" : "100%";
      $("reset-at").textContent = balance.resetAt ? "重置：" + new Date(balance.resetAt).toLocaleString("zh-CN") : "无固定重置时间";
      $("input-total").textContent = fmt(totals.inputTokens || 0);
      $("output-total").textContent = fmt(totals.outputTokens || 0);
      $("extra-total").textContent = fmt((totals.cachedTokens || 0) + (totals.reasoningTokens || 0));
      $("trend-subtitle").textContent = "窗口：" + (state.usage.range || $("range").value) + " · 粒度：" + (state.usage.granularity || "-");
      renderComposition(totals);
      renderTrend(state.usage.summary?.modelTimeline || []);
      renderRanking(state.usage.summary?.models || []);
    }
    function renderComposition(totals) {
      const rows = [
        ["输入", totals.inputTokens || 0],
        ["输出", totals.outputTokens || 0],
        ["缓存", totals.cachedTokens || 0],
        ["思考", totals.reasoningTokens || 0],
      ];
      const max = Math.max(1, ...rows.map((row) => row[1]));
      $("composition").innerHTML = rows.map(([label, value]) => '<div class="rg-comp-row"><span>' + label + '</span><div class="rg-track"><div class="rg-bar" style="width:' + Math.max(2, Math.round(value / max * 100)) + '%"></div></div><strong>' + fmt(value) + '</strong></div>').join("");
    }
    function renderTrend(points) {
      if (!points.length) { $("trend").innerHTML = '<div class="rg-empty">当前窗口暂无趋势数据</div>'; return; }
      const max = Math.max(1, ...points.map((point) => point.usage?.totalTokens || 0));
      $("trend").innerHTML = points.slice(-36).map((point) => {
        const value = point.usage?.totalTokens || 0;
        const label = new Date(point.bucketStart).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
        return '<div class="rg-tick" title="' + fmt(value) + ' Token"><i style="height:' + Math.max(4, value / max * 218) + 'px"></i><span>' + label + '</span></div>';
      }).join("");
    }
    function renderRanking(models) {
      if (!models.length) { $("ranking").innerHTML = '<div class="rg-empty">当前窗口暂无模型消耗</div>'; return; }
      const max = Math.max(1, ...models.map((item) => item.usage?.totalTokens || 0));
      $("ranking").innerHTML = models.slice(0, 8).map((item, index) => {
        const value = item.usage?.totalTokens || 0;
        return '<div class="rg-rank-row"><span class="rg-rank-index">' + (index + 1) + '</span><div class="rg-rank-main"><div class="rg-rank-line"><strong>' + item.modelAlias + '</strong><span>' + fmt(value) + ' Token · ' + fmt(item.usage?.requestCount || 0) + ' 次</span></div><div class="rg-track"><div class="rg-bar" style="width:' + Math.max(3, Math.round(value / max * 100)) + '%"></div></div></div></div>';
      }).join("");
    }
    $("query-form").addEventListener("submit", (event) => { event.preventDefault(); load().catch((error) => setStatus(error.message, "error")); });
    $("refresh").addEventListener("click", () => load().catch((error) => setStatus(error.message, "error")));
    $("toggle-key").addEventListener("click", () => {
      const input = $("api-key");
      input.type = input.type === "password" ? "text" : "password";
      $("toggle-key").textContent = input.type === "password" ? "显示" : "隐藏";
    });
  </script>
</body>
</html>`;
}

function buildPublicAccountPortalHtmlV3(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RelayGate Account Center</title>
  <style>
    :root {
      color-scheme: light;
      --color-bg-app: #f6f7fb;
      --color-bg-card: #ffffff;
      --color-bg-elevated: #f4f7fb;
      --color-bg-active: #e8f1ff;
      --color-border-subtle: #e8edf4;
      --color-border-default: #d9e0ea;
      --color-border-strong: #c4ccd8;
      --text-primary: #111827;
      --text-secondary: #4b5563;
      --text-tertiary: #6b7280;
      --accent-color: #2563eb;
      --accent-soft: rgba(37, 99, 235, 0.1);
      --success: #16a34a;
      --success-soft: rgba(22, 163, 74, 0.1);
      --warning: #d97706;
      --warning-soft: rgba(217, 119, 6, 0.12);
      --danger: #dc2626;
      --danger-soft: rgba(220, 38, 38, 0.1);
      --chart-4: #7c3aed;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --radius-xl: 22px;
      --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.05), 0 10px 24px rgba(15, 23, 42, 0.055);
      --shadow-md: 0 1px 2px rgba(15, 23, 42, 0.06), 0 18px 42px rgba(15, 23, 42, 0.09);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body {
      min-height: 100vh;
      background:
        radial-gradient(circle at 18% -12%, rgba(37, 99, 235, 0.16), transparent 32rem),
        radial-gradient(circle at 82% 0%, rgba(22, 163, 74, 0.1), transparent 30rem),
        linear-gradient(180deg, #fbfdff 0%, var(--color-bg-app) 48%, #edf3fb 100%);
      color: var(--text-primary);
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    button, input, select { font: inherit; outline: none; }
    button { cursor: pointer; }
    [hidden] { display: none !important; }
    .rg-shell {
      display: grid;
      grid-template-columns: minmax(292px, 336px) minmax(0, 1fr);
      gap: 18px;
      width: min(1440px, calc(100% - 36px));
      min-height: 100vh;
      margin: 0 auto;
      padding: 18px 0 24px;
    }
    .rg-sidebar,
    .rg-main-card,
    .usage-echart-card,
    .usage-member-health-card,
    .usage-member-health-matrix,
    .usage-scope-matrix,
    .usage-filter-context,
    .usage-chart-data-hint {
      border: 1px solid var(--color-border-subtle);
      background: linear-gradient(180deg, #fff 0%, #f8fbff 100%);
      box-shadow: var(--shadow-sm);
    }
    .rg-sidebar {
      position: sticky;
      top: 18px;
      align-self: start;
      display: grid;
      gap: 14px;
      max-height: calc(100vh - 36px);
      padding: 16px;
      overflow: auto;
      border-radius: var(--radius-xl);
    }
    .rg-main { display: grid; min-width: 0; }
    .rg-main-card {
      display: grid;
      gap: 14px;
      min-width: 0;
      padding: 18px;
      border-radius: var(--radius-xl);
    }
    .rg-brand,
    .rg-form,
    .rg-side-section {
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-lg);
      background: #fff;
    }
    .rg-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.1), rgba(22, 163, 74, 0.05)), #fff;
    }
    .rg-logo {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--accent-color), #0f766e);
      color: #fff;
      font-size: 20px;
      font-weight: 900;
      letter-spacing: -0.06em;
    }
    .rg-brand-title { display: grid; gap: 2px; min-width: 0; }
    .rg-brand-title strong { font-size: 15px; line-height: 1.2; }
    .rg-brand-title span,
    .rg-side-section p,
    .rg-help-text { color: var(--text-tertiary); font-size: 12px; }
    .rg-form { display: grid; gap: 12px; padding: 14px; background: color-mix(in oklab, var(--color-bg-elevated) 72%, white); }
    .rg-field { display: grid; gap: 7px; }
    .rg-field label { color: var(--text-secondary); font-size: 12px; font-weight: 800; }
    .rg-input-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .rg-input,
    .rg-select {
      width: 100%;
      min-height: 40px;
      padding: 8px 11px;
      border: 1px solid var(--color-border-default);
      border-radius: var(--radius-sm);
      background: #fff;
      color: var(--text-primary);
      font-size: 13px;
      transition: border-color 0.16s ease, box-shadow 0.16s ease;
    }
    .rg-input:focus,
    .rg-select:focus { border-color: color-mix(in oklab, var(--accent-color) 56%, var(--color-border-default)); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1); }
    .rg-button {
      min-height: 40px;
      padding: 8px 14px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: var(--accent-color);
      color: #fff;
      font-size: 13px;
      font-weight: 800;
      transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
    }
    .rg-button:hover { background: #1d4ed8; box-shadow: 0 12px 22px rgba(37, 99, 235, 0.16); transform: translateY(-1px); }
    .rg-button.secondary { border-color: var(--color-border-default); background: #fff; color: var(--text-secondary); }
    .rg-button.secondary:hover { background: var(--color-bg-active); color: #1d4ed8; }
    .rg-button:disabled { cursor: not-allowed; opacity: 0.55; transform: none; box-shadow: none; }
    .rg-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .rg-status {
      min-height: 38px;
      padding: 9px 11px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: #fff;
      color: var(--text-tertiary);
      font-size: 12px;
    }
    .rg-status.ok { border-color: rgba(22, 163, 74, 0.28); background: var(--success-soft); color: color-mix(in oklab, var(--success) 72%, black); }
    .rg-status.error { border-color: rgba(220, 38, 38, 0.24); background: var(--danger-soft); color: var(--danger); }
    .rg-side-section { display: grid; gap: 10px; padding: 14px; }
    .rg-side-section h2 { margin: 0; font-size: 13px; }
    .rg-chip-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .badge,
    .rg-chip {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      min-height: 24px;
      padding: 4px 9px;
      border: 1px solid color-mix(in oklab, var(--accent-color) 18%, var(--color-border-subtle));
      border-radius: 999px;
      background: color-mix(in oklab, var(--accent-color) 7%, white);
      color: color-mix(in oklab, var(--accent-color) 70%, black);
      font-size: 11px;
      font-weight: 900;
    }
    .badge.neutral { border-color: var(--color-border-subtle); background: var(--color-bg-elevated); color: var(--text-secondary); }
    .badge.success { border-color: rgba(22, 163, 74, 0.28); background: var(--success-soft); color: var(--success); }
    .rg-topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 16px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-lg);
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.07), rgba(255,255,255,0.75)), #fff;
    }
    .rg-title-block { display: grid; gap: 8px; min-width: 0; }
    .rg-eyebrow { color: var(--accent-color); font-size: 11px; font-weight: 900; letter-spacing: 0.04em; text-transform: uppercase; }
    .rg-title-block h1 { margin: 0; font-size: clamp(25px, 4vw, 38px); line-height: 1.05; letter-spacing: -0.05em; }
    .rg-title-block p { max-width: 760px; margin: 0; color: var(--text-secondary); font-size: 13px; }
    .rg-live-card {
      display: grid;
      gap: 5px;
      min-width: 174px;
      padding: 12px;
      border: 1px solid rgba(22, 163, 74, 0.28);
      border-radius: var(--radius-md);
      background: var(--success-soft);
      color: color-mix(in oklab, var(--success) 68%, black);
    }
    .rg-live-card small { font-size: 11px; font-weight: 900; }
    .rg-live-card strong { font-size: 18px; }
    .usage-summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .usage-summary-card {
      display: grid;
      gap: 8px;
      min-width: 0;
      min-height: 126px;
      padding: 14px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-lg);
      background: linear-gradient(180deg, #fff 0%, #f8fbff 100%);
      box-shadow: var(--shadow-sm);
    }
    .usage-summary-card small { color: var(--text-tertiary); font-size: 11px; font-weight: 900; letter-spacing: 0.02em; text-transform: uppercase; }
    .usage-summary-card strong { overflow: hidden; font-size: clamp(24px, 4vw, 34px); line-height: 1; letter-spacing: -0.05em; text-overflow: ellipsis; white-space: nowrap; }
    .usage-summary-card span { overflow: hidden; color: var(--text-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .usage-operations-dashboard {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(312px, 0.8fr);
      gap: 14px;
      min-width: 0;
    }
    .usage-operations-wide { grid-column: 1 / -1; min-width: 0; }
    .usage-operations-main,
    .usage-operations-breakdown,
    .usage-operations-card { min-width: 0; }
    .usage-operations-breakdown { display: grid; gap: 14px; }
    .usage-filter-context,
    .usage-chart-data-hint,
    .usage-member-health-card,
    .usage-member-health-matrix,
    .usage-scope-matrix,
    .usage-echart-card {
      border-radius: var(--radius-lg);
      padding: 14px 16px;
      min-width: 0;
    }
    .usage-filter-context {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
      margin-bottom: 14px;
      color: var(--text-secondary);
      font-size: 12px;
    }
    .usage-chart-data-hint { margin-bottom: 14px; color: var(--text-secondary); font-size: 12px; }
    .usage-member-health-card { display: grid; grid-template-columns: minmax(0, 1fr) 112px; gap: 14px; align-items: center; }
    .usage-member-health-main { display: grid; gap: 8px; min-width: 0; }
    .usage-member-health-main strong { overflow: hidden; font-size: 18px; text-overflow: ellipsis; white-space: nowrap; }
    .usage-member-health-main p { margin: 0; color: var(--text-secondary); font-size: 12px; }
    .usage-member-health-metrics { display: flex; flex-wrap: wrap; gap: 8px; }
    .usage-member-health-metrics span { padding: 5px 8px; border-radius: 999px; background: var(--color-bg-elevated); color: var(--text-secondary); font-size: 11px; font-weight: 800; }
    .usage-member-health-score {
      display: grid;
      place-items: center;
      align-content: center;
      width: 112px;
      height: 92px;
      border-radius: 22px;
      background: var(--success-soft);
      color: var(--success);
    }
    .usage-member-health-score.warning { background: var(--warning-soft); color: var(--warning); }
    .usage-member-health-score.danger { background: var(--danger-soft); color: var(--danger); }
    .usage-member-health-score strong { font-size: 30px; line-height: 1; letter-spacing: -0.05em; }
    .usage-member-health-score span { font-size: 12px; font-weight: 900; }
    .usage-chart-section-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .usage-chart-section-header > div { display: grid; gap: 4px; min-width: 0; }
    .usage-chart-section-header strong { font-size: 14px; }
    .usage-chart-section-header span:not(.badge) { color: var(--text-secondary); font-size: 12px; }
    .usage-echart-card-large { min-height: 386px; }
    .usage-trend-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .usage-trend-stat,
    .usage-scope-cell {
      display: grid;
      gap: 4px;
      min-width: 0;
      padding: 11px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: var(--color-bg-elevated);
    }
    .usage-trend-stat small,
    .usage-scope-cell small { color: var(--text-tertiary); font-size: 11px; font-weight: 900; }
    .usage-trend-stat strong,
    .usage-scope-cell strong { overflow: hidden; font-size: 20px; text-overflow: ellipsis; white-space: nowrap; }
    .usage-trend-stat span,
    .usage-scope-cell span { overflow: hidden; color: var(--text-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .usage-chart-canvas {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10px, 1fr));
      align-items: end;
      gap: 6px;
      min-height: 214px;
      padding: 12px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      background:
        linear-gradient(to right, color-mix(in oklab, var(--color-border-subtle) 32%, transparent) 1px, transparent 1px) 0 0 / 12.5% 100%,
        linear-gradient(to bottom, color-mix(in oklab, var(--color-border-subtle) 42%, transparent) 1px, transparent 1px) 0 0 / 100% 25%,
        var(--color-bg-elevated);
    }
    .usage-chart-tick { display: grid; align-items: end; gap: 6px; min-width: 0; }
    .usage-chart-tick i {
      display: block;
      min-height: 4px;
      border-radius: 999px 999px 5px 5px;
      background: linear-gradient(180deg, var(--accent-color), color-mix(in oklab, var(--accent-color) 44%, white));
      box-shadow: 0 8px 16px rgba(37, 99, 235, 0.12);
    }
    .usage-chart-tick span { overflow: hidden; color: var(--text-tertiary); font-size: 10px; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
    .usage-ranking-list,
    .usage-donut-legend,
    .usage-mini-bar-list,
    .usage-member-health-table { display: grid; gap: 10px; }
    .usage-ranking-row {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
    }
    .usage-ranking-index {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      background: var(--color-bg-elevated);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 900;
    }
    .usage-ranking-main { display: grid; gap: 6px; min-width: 0; }
    .usage-ranking-meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--text-secondary);
      font-size: 12px;
    }
    .usage-ranking-meta strong,
    .usage-ranking-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .usage-ranking-meta strong { color: var(--text-primary); }
    .usage-ranking-track,
    .usage-mini-bar-track,
    .usage-outcome-track {
      height: 9px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--color-bg-elevated);
    }
    .usage-ranking-bar,
    .usage-mini-bar { height: 100%; min-width: 8px; border-radius: inherit; background: linear-gradient(90deg, var(--accent-color), var(--success)); }
    .usage-donut-body { display: grid; grid-template-columns: 146px minmax(0, 1fr); gap: 14px; align-items: center; }
    .usage-donut-visual {
      display: grid;
      place-items: center;
      align-content: center;
      width: 146px;
      height: 146px;
      border-radius: 50%;
      background:
        radial-gradient(circle at center, #fff 0 54%, transparent 55%),
        conic-gradient(var(--accent-color) 0 var(--input-end), var(--success) var(--input-end) var(--output-end), var(--warning) var(--output-end) var(--cached-end), var(--chart-4) var(--cached-end) 100%);
    }
    .usage-donut-visual strong { font-size: 20px; }
    .usage-donut-visual span { color: var(--text-secondary); font-size: 12px; }
    .usage-donut-legend-row {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      color: var(--text-secondary);
      font-size: 12px;
    }
    .usage-donut-legend-row strong { overflow: hidden; color: var(--text-primary); text-overflow: ellipsis; white-space: nowrap; }
    .usage-donut-dot { width: 8px; height: 8px; border-radius: 999px; }
    .usage-donut-dot.input { background: var(--accent-color); }
    .usage-donut-dot.output { background: var(--success); }
    .usage-donut-dot.cached { background: var(--warning); }
    .usage-donut-dot.reasoning { background: var(--chart-4); }
    .usage-outcome-track { display: flex; height: 10px; }
    .usage-outcome-segment.success { background: linear-gradient(90deg, color-mix(in oklab, var(--success) 72%, white), var(--success)); }
    .usage-outcome-segment.failure { background: linear-gradient(90deg, var(--danger), color-mix(in oklab, var(--danger) 62%, white)); }
    .usage-mini-bar-row {
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr) 58px;
      gap: 10px;
      align-items: center;
      color: var(--text-secondary);
      font-size: 12px;
    }
    .usage-mini-bar-row strong { color: var(--text-primary); text-align: right; }
    .usage-mini-bar.success { background: var(--success); }
    .usage-mini-bar.primary { background: var(--accent-color); }
    .usage-mini-bar.warning { background: var(--warning); }
    .usage-mini-bar.danger { background: var(--danger); }
    .usage-scope-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .usage-member-health-head,
    .usage-member-health-row {
      display: grid;
      grid-template-columns: minmax(150px, 1.2fr) 94px 120px 72px 72px 124px;
      gap: 10px;
      align-items: center;
    }
    .usage-member-health-head { color: var(--text-tertiary); font-size: 11px; font-weight: 900; }
    .usage-member-health-row {
      width: 100%;
      padding: 10px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: #fff;
      color: var(--text-secondary);
      text-align: left;
    }
    .usage-member-health-row strong,
    .usage-member-health-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .usage-member-health-row small { display: block; overflow: hidden; color: var(--text-tertiary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .usage-health-score-pill { padding: 4px 8px; border-radius: 999px; background: var(--success-soft); color: var(--success); font-size: 11px; font-weight: 900; }
    .usage-health-score-pill.warning { background: var(--warning-soft); color: var(--warning); }
    .usage-health-score-pill.danger { background: var(--danger-soft); color: var(--danger); }
    .empty-card {
      display: grid;
      align-content: center;
      justify-items: center;
      gap: 8px;
      min-height: 160px;
      padding: 22px;
      border: 1px dashed var(--color-border-default);
      border-radius: var(--radius-md);
      background: color-mix(in oklab, var(--color-bg-elevated) 72%, white);
      color: var(--text-secondary);
      text-align: center;
    }
    .rg-safe-note { padding: 12px 14px; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-lg); background: #fff; color: var(--text-secondary); font-size: 12px; }
    @media (max-width: 1120px) {
      .rg-shell { grid-template-columns: 1fr; }
      .rg-sidebar { position: static; max-height: none; }
      .usage-operations-dashboard { grid-template-columns: 1fr; }
      .usage-summary-grid,
      .usage-trend-stats,
      .usage-scope-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .usage-member-health-head,
      .usage-member-health-row { grid-template-columns: minmax(150px, 1fr) 92px 120px; }
      .usage-member-health-head span:nth-child(n+4),
      .usage-member-health-row span:nth-child(n+4) { display: none; }
    }
    @media (max-width: 640px) {
      .rg-shell { width: min(100% - 20px, 1440px); padding-top: 10px; }
      .rg-topbar,
      .usage-member-health-card,
      .usage-donut-body { display: grid; grid-template-columns: 1fr; }
      .usage-member-health-score { width: 100%; }
      .usage-summary-grid,
      .usage-trend-stats,
      .usage-scope-grid,
      .rg-input-row,
      .rg-actions { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="rg-shell">
    <aside class="rg-sidebar" aria-label="RelayGate Account Center">
      <div class="rg-brand">
        <div class="rg-logo">R</div>
        <div class="rg-brand-title">
          <strong>RelayGate Account Center</strong>
          <span>公网成员自助观测面板</span>
        </div>
      </div>
      <form class="rg-form" id="query-form">
        <div class="rg-field">
          <label for="api-key">成员 API Key</label>
          <div class="rg-input-row">
            <input class="rg-input" id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="lagw_xxx..." />
            <button class="rg-button secondary" type="button" id="toggle-key">显示</button>
          </div>
          <span class="rg-help-text">Key 只保存在当前浏览器内存中，不写入 URL。</span>
        </div>
        <div class="rg-field">
          <label for="range">统计周期</label>
          <select class="rg-select" id="range">
            <option value="24h">近 24h</option>
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
            <option value="all">总计</option>
          </select>
        </div>
        <div class="rg-actions">
          <button class="rg-button" type="submit" id="query">查询账户</button>
          <button class="rg-button secondary" type="button" id="refresh" disabled>刷新</button>
        </div>
        <div class="rg-status" id="status">输入成员 API Key 后查询单一用户用量、额度与稳定性。</div>
      </form>
      <section class="rg-side-section">
        <h2>安全边界</h2>
        <p>本页只访问自助只读接口，所有统计由服务端按当前成员 Key 自动隔离。</p>
        <div class="rg-chip-list">
          <span class="rg-chip">Self-only</span>
          <span class="rg-chip">No prompt body</span>
          <span class="rg-chip">No full key</span>
        </div>
      </section>
      <section class="rg-side-section" id="identity-card">
        <h2>当前成员</h2>
        <p id="identity-summary">等待查询后显示成员、Key 与策略。</p>
        <div class="rg-chip-list">
          <span class="rg-chip" id="identity-type">public-user</span>
          <span class="rg-chip" id="identity-status">unknown</span>
        </div>
      </section>
    </aside>

    <section class="rg-main">
      <div class="rg-main-card">
        <header class="rg-topbar">
          <div class="rg-title-block">
            <span class="rg-eyebrow">Public User Console</span>
            <h1>成员用量与额度</h1>
            <p>桌面端「用量与告警」的公网成员版。去掉用户筛选，只按当前 API Key 自动隔离单一成员，展示 Token、额度、结果、延迟与模型归因。</p>
          </div>
          <div class="rg-live-card">
            <small>Public Surface</small>
            <strong>/v1/account</strong>
            <small>Admin surface is not exposed</small>
          </div>
        </header>

        <section id="dashboard" hidden>
          <div class="usage-summary-grid">
            <div class="usage-summary-card"><small>剩余额度</small><strong id="remaining">-</strong><span id="quota-mode">-</span></div>
            <div class="usage-summary-card"><small>已用 Token</small><strong id="used">-</strong><span id="total">-</span></div>
            <div class="usage-summary-card"><small>请求数</small><strong id="requests">-</strong><span id="success">-</span></div>
            <div class="usage-summary-card"><small>成功率</small><strong id="success-rate">-</strong><span id="latency">-</span></div>
          </div>
          <div id="usage-operations-dashboard" class="usage-operations-dashboard">
            <div class="usage-operations-wide" id="filter-context"></div>
            <div class="usage-operations-wide" id="data-hint"></div>
            <div class="usage-operations-wide" id="member-health"></div>
            <div class="usage-operations-wide" id="health-matrix"></div>
            <div class="usage-operations-main">
              <div class="usage-echart-card usage-echart-card-large">
                <div class="usage-chart-section-header">
                  <div><strong>Token 用量趋势</strong><span id="trend-subtitle">按当前窗口聚合展示</span></div>
                  <span class="badge neutral">ECharts-like</span>
                </div>
                <div id="trend-stats" class="usage-trend-stats"></div>
                <div id="trend" class="usage-chart-canvas"></div>
              </div>
            </div>
            <div class="usage-operations-breakdown">
              <div class="usage-echart-card">
                <div class="usage-chart-section-header">
                  <div><strong>模型排行</strong><span>当前成员 Key 的模型消耗归因</span></div>
                  <span class="badge neutral">Bar</span>
                </div>
                <div id="ranking" class="usage-ranking-list"></div>
              </div>
              <div class="usage-echart-card">
                <div class="usage-chart-section-header">
                  <div><strong>Token 构成</strong><span>输入、输出、缓存和思考 Token 占比</span></div>
                  <span class="badge neutral">Donut</span>
                </div>
                <div id="composition"></div>
              </div>
            </div>
            <div class="usage-operations-card">
              <div class="usage-echart-card">
                <div class="usage-chart-section-header">
                  <div><strong>请求结果</strong><span>成功 / 失败请求占比，用于快速定位异常窗口</span></div>
                  <span class="badge neutral">Outcome</span>
                </div>
                <div id="outcome"></div>
              </div>
            </div>
            <div class="usage-operations-card">
              <div class="usage-echart-card">
                <div class="usage-chart-section-header">
                  <div><strong>延迟与稳定性</strong><span>平均延迟、请求量和失败压力组合观察</span></div>
                  <span class="badge neutral">Latency</span>
                </div>
                <div id="latency-panel"></div>
              </div>
            </div>
            <div class="usage-operations-wide" id="scope-matrix"></div>
          </div>
        </section>

        <section class="rg-safe-note">
          安全边界：本页只调用 /v1/user/profile 与 /v1/user/usage/summary；不会请求管理端路径，不展示完整 Key、上游账号或 prompt 正文。
        </section>
      </div>
    </section>
  </main>
  <script>
    const state = { apiKey: "", profile: null, usage: null };
    const $ = (id) => document.getElementById(id);
    const fmt = (value) => typeof value === "number" && Number.isFinite(value)
      ? new Intl.NumberFormat("zh-CN", { notation: Math.abs(value) >= 1000000 ? "compact" : "standard" }).format(value)
      : "-";
    const pct = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 + "%" : "-";
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const fmtDate = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "暂无";
    const setStatus = (message, tone = "") => { $("status").textContent = message; $("status").className = "rg-status " + tone; };
    const usage = () => state.usage?.summary || {};
    const totals = () => usage().totals || {};
    async function fetchJson(url) {
      const response = await fetch(url, { headers: { authorization: "Bearer " + state.apiKey } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || "查询失败");
      return body.data;
    }
    async function load() {
      state.apiKey = $("api-key").value.trim();
      if (!state.apiKey) { setStatus("请先输入成员 API Key。", "error"); return; }
      $("query").disabled = true;
      $("refresh").disabled = true;
      setStatus("正在读取账户用量...");
      try {
        const range = $("range").value;
        const result = await Promise.all([
          fetchJson("/v1/user/profile"),
          fetchJson("/v1/user/usage/summary?range=" + encodeURIComponent(range)),
        ]);
        state.profile = result[0];
        state.usage = result[1];
        render();
        $("dashboard").hidden = false;
        $("refresh").disabled = false;
        setStatus("账户用量已刷新。", "ok");
      } finally {
        $("query").disabled = false;
      }
    }
    function getSuccessRate(counters) {
      return counters.requestCount > 0 ? (counters.successCount || 0) / counters.requestCount * 100 : undefined;
    }
    function getLatency(counters) {
      return counters.successCount > 0 ? Math.round((counters.totalLatencyMs || 0) / counters.successCount) : 0;
    }
    function getHealthScore(counters) {
      const failureRate = counters.requestCount > 0 ? (counters.failureCount || 0) / counters.requestCount : 0;
      const latency = getLatency(counters);
      const latencyPenalty = latency > 5000 ? 16 : latency > 2000 ? 8 : 0;
      return clamp(Math.round(100 - failureRate * 45 - latencyPenalty), 0, 100);
    }
    function getHealthTone(score) {
      return score >= 85 ? "success" : score >= 70 ? "active" : score >= 50 ? "warning" : "danger";
    }
    function getHealthLabel(score) {
      return score >= 85 ? "健康" : score >= 70 ? "可关注" : score >= 50 ? "风险" : "严重";
    }
    function render() {
      const profile = state.profile || {};
      const balance = profile.balance || {};
      const summary = usage();
      const currentTotals = totals();
      const used = balance.used || 0;
      const total = balance.total;
      const remaining = balance.remaining;
      const remainingRatio = typeof total === "number" && total > 0 && typeof remaining === "number" ? remaining / total : undefined;
      const successRate = getSuccessRate(currentTotals);
      const latency = getLatency(currentTotals);
      const keyLabel = (profile.accessKey?.keyPrefix || "") + "..." + (profile.accessKey?.keySuffix || "");
      const memberLabel = (profile.consumer?.name || "成员") + (keyLabel !== "..." ? " · " + keyLabel : "");
      $("identity-summary").textContent = memberLabel;
      $("identity-type").textContent = profile.consumer?.type || "public-user";
      $("identity-status").textContent = profile.accessKey?.status || "unknown";
      $("remaining").textContent = fmt(remaining);
      $("quota-mode").textContent = balance.quotaMode ? "额度模式：" + balance.quotaMode : "未设置固定额度";
      $("used").textContent = fmt(used);
      $("total").textContent = typeof total === "number" ? "总额 " + fmt(total) : "不限额或未设置";
      $("requests").textContent = fmt(currentTotals.requestCount || 0);
      $("success").textContent = "成功 " + fmt(currentTotals.successCount || 0) + " / 失败 " + fmt(currentTotals.failureCount || 0);
      $("success-rate").textContent = pct(successRate);
      $("latency").textContent = currentTotals.requestCount ? "平均延迟 " + fmt(latency) + "ms" : "暂无请求";
      $("filter-context").innerHTML = renderFilterContext(profile, balance);
      $("data-hint").innerHTML = renderDataHint(summary);
      $("member-health").innerHTML = renderMemberHealth(memberLabel, currentTotals, summary, balance, remainingRatio);
      $("health-matrix").innerHTML = renderHealthMatrix(profile, currentTotals, summary, balance);
      $("trend-subtitle").textContent = "Token · 单成员 · " + getRangeLabel(state.usage.range || $("range").value);
      $("trend-stats").innerHTML = renderTrendStats(currentTotals, balance, remainingRatio);
      renderTrend(summary.modelTimeline || []);
      renderRanking(summary.models || []);
      renderComposition(currentTotals);
      renderOutcome(currentTotals);
      renderLatency(currentTotals);
      renderScopeMatrix(profile, summary);
    }
    function getRangeLabel(range) {
      return range === "7d" ? "近 7 天" : range === "30d" ? "近 30 天" : range === "all" ? "总计" : "近 24h";
    }
    function renderFilterContext(profile, balance) {
      const models = (profile.policy?.allowedModelAliases || []).slice(0, 3).join(", ") || "全部模型";
      return '<div class="usage-filter-context"><span class="badge success">真实统计</span><span>成员：' + esc(profile.consumer?.name || "当前 Key") + '</span><span>Key：' + esc((profile.accessKey?.keyPrefix || "") + "..." + (profile.accessKey?.keySuffix || "")) + '</span><span>周期：' + esc(getRangeLabel(state.usage.range)) + '</span><span>模型：' + esc(models) + '</span><span>额度：' + esc(balance.quotaMode || "unlimited") + '</span></div>';
    }
    function renderDataHint(summary) {
      const updatedAt = summary.updatedAt ? fmtDate(summary.updatedAt) : "暂无";
      return '<div class="usage-chart-data-hint">本页为单成员视角，已自动按当前 API Key 的 consumerId + accessKeyId 隔离。数据更新时间：' + esc(updatedAt) + '。</div>';
    }
    function renderMemberHealth(memberLabel, counters, summary, balance, remainingRatio) {
      const score = getHealthScore(counters);
      const tone = getHealthTone(score);
      const latest = Math.max(0, ...(summary.consumers || []).map((item) => item.updatedAt || 0), summary.updatedAt || 0);
      const reasons = [
        counters.requestCount > 0 ? "请求 " + fmt(counters.requestCount) + " 次" : "暂无请求",
        "成功率 " + pct(getSuccessRate(counters)),
        (counters.failureCount || 0) > 0 ? "失败 " + fmt(counters.failureCount) + " 次" : "无失败请求",
        typeof remainingRatio === "number" ? "剩余 " + pct(remainingRatio * 100) : "不限额",
      ];
      return '<div class="usage-member-health-card"><div class="usage-member-health-main"><span class="badge success">成员健康度</span><strong>' + esc(memberLabel) + '</strong><p>' + esc(reasons.join(" · ")) + '</p><div class="usage-member-health-metrics"><span>Token ' + esc(fmt(counters.totalTokens || 0)) + '</span><span>平均延迟 ' + esc(fmt(getLatency(counters))) + 'ms</span><span>最近活跃 ' + esc(fmtDate(latest)) + '</span><span>额度 ' + esc(balance.quotaMode || "unlimited") + '</span></div></div><div class="usage-member-health-score ' + esc(tone) + '"><strong>' + esc(score) + '</strong><span>' + esc(getHealthLabel(score)) + '</span></div></div>';
    }
    function renderHealthMatrix(profile, counters, summary, balance) {
      const score = getHealthScore(counters);
      const tone = getHealthTone(score);
      const latest = Math.max(0, ...(summary.consumers || []).map((item) => item.updatedAt || 0), summary.updatedAt || 0);
      const row = '<button class="usage-member-health-row" type="button"><span><strong>' + esc(profile.consumer?.name || "当前成员") + '</strong><small>' + esc(profile.consumer?.type || "public-user") + ' · ' + esc(profile.accessKey?.status || "unknown") + '</small></span><span class="usage-health-score-pill ' + esc(tone) + '">' + esc(score) + ' · ' + esc(getHealthLabel(score)) + '</span><span>' + esc(fmt(counters.totalTokens || 0)) + ' / ' + esc(fmt(counters.requestCount || 0)) + '</span><span>' + esc(fmt(counters.failureCount || 0)) + '</span><span>' + esc(balance.quotaMode || "unlimited") + '</span><span>' + esc(fmtDate(latest)) + '</span></button>';
      return '<div class="usage-member-health-matrix"><div class="usage-chart-section-header"><div><strong>成员健康矩阵</strong><span>单成员版保留桌面端矩阵结构，只展示当前 Key 对应成员。</span></div><span class="badge neutral">1 member</span></div><div class="usage-member-health-table"><div class="usage-member-health-head"><span>成员</span><span>健康分</span><span>Token / 请求</span><span>失败</span><span>额度</span><span>最近活跃</span></div>' + row + '</div></div>';
    }
    function renderTrendStats(counters, balance, remainingRatio) {
      const items = [
        ["Token", fmt(counters.totalTokens || 0), "当前窗口总消耗"],
        ["请求", fmt(counters.requestCount || 0), "成功 " + fmt(counters.successCount || 0)],
        ["剩余", typeof remainingRatio === "number" ? pct(remainingRatio * 100) : "不限额", balance.quotaMode || "unlimited"],
        ["延迟", counters.requestCount ? fmt(getLatency(counters)) + "ms" : "暂无", "平均成功请求"],
      ];
      return items.map((item) => '<div class="usage-trend-stat"><small>' + esc(item[0]) + '</small><strong>' + esc(item[1]) + '</strong><span>' + esc(item[2]) + '</span></div>').join("");
    }
    function renderTrend(points) {
      const node = $("trend");
      if (!points.length) { node.innerHTML = '<div class="empty-card">当前窗口暂无趋势数据</div>'; return; }
      const sliced = points.slice(-36);
      const max = Math.max(1, ...sliced.map((point) => point.usage?.totalTokens || 0));
      node.innerHTML = sliced.map((point) => {
        const value = point.usage?.totalTokens || 0;
        const label = new Date(point.bucketStart).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
        return '<div class="usage-chart-tick" title="' + esc(fmt(value) + " Token") + '"><i style="height:' + esc(String(Math.max(4, Math.round(value / max * 190)))) + 'px"></i><span>' + esc(label) + '</span></div>';
      }).join("");
    }
    function renderRanking(models) {
      const node = $("ranking");
      if (!models.length) { node.innerHTML = '<div class="empty-card">当前窗口暂无模型消耗</div>'; return; }
      const max = Math.max(1, ...models.map((item) => item.usage?.totalTokens || 0));
      node.innerHTML = models.slice(0, 8).map((item, index) => {
        const value = item.usage?.totalTokens || 0;
        return '<div class="usage-ranking-row"><span class="usage-ranking-index">' + esc(index + 1) + '</span><div class="usage-ranking-main"><div class="usage-ranking-meta"><strong>' + esc(item.modelAlias) + '</strong><span>' + esc(fmt(value)) + ' Token · ' + esc(fmt(item.usage?.requestCount || 0)) + ' 次</span></div><div class="usage-ranking-track"><div class="usage-ranking-bar" style="width:' + esc(String(Math.max(3, Math.round(value / max * 100)))) + '%"></div></div></div></div>';
      }).join("");
    }
    function renderComposition(counters) {
      const total = Math.max(1, (counters.inputTokens || 0) + (counters.outputTokens || 0) + (counters.cachedTokens || 0) + (counters.reasoningTokens || 0));
      const inputEnd = (counters.inputTokens || 0) / total * 100;
      const outputEnd = inputEnd + (counters.outputTokens || 0) / total * 100;
      const cachedEnd = outputEnd + (counters.cachedTokens || 0) / total * 100;
      const rows = [
        ["input", "输入", counters.inputTokens || 0],
        ["output", "输出", counters.outputTokens || 0],
        ["cached", "缓存", counters.cachedTokens || 0],
        ["reasoning", "思考", counters.reasoningTokens || 0],
      ];
      $("composition").innerHTML = '<div class="usage-donut-body"><div class="usage-donut-visual" style="--input-end:' + inputEnd + '%;--output-end:' + outputEnd + '%;--cached-end:' + cachedEnd + '%"><strong>' + esc(fmt(counters.totalTokens || 0)) + '</strong><span>Token</span></div><div class="usage-donut-legend">' + rows.map((row) => '<div class="usage-donut-legend-row"><i class="usage-donut-dot ' + esc(row[0]) + '"></i><span>' + esc(row[1]) + '</span><strong>' + esc(fmt(row[2])) + '</strong></div>').join("") + '</div></div>';
    }
    function renderOutcome(counters) {
      const total = Math.max(1, counters.requestCount || 0);
      const successWidth = clamp((counters.successCount || 0) / total * 100, 0, 100);
      const failureWidth = clamp((counters.failureCount || 0) / total * 100, 0, 100);
      $("outcome").innerHTML = '<div class="usage-mini-bar-list"><div class="usage-outcome-track"><div class="usage-outcome-segment success" style="width:' + successWidth + '%"></div><div class="usage-outcome-segment failure" style="width:' + failureWidth + '%"></div></div><div class="usage-mini-bar-row"><span>成功</span><div class="usage-mini-bar-track"><div class="usage-mini-bar success" style="width:' + successWidth + '%"></div></div><strong>' + esc(fmt(counters.successCount || 0)) + '</strong></div><div class="usage-mini-bar-row"><span>失败</span><div class="usage-mini-bar-track"><div class="usage-mini-bar danger" style="width:' + Math.max(3, failureWidth) + '%"></div></div><strong>' + esc(fmt(counters.failureCount || 0)) + '</strong></div></div>';
    }
    function renderLatency(counters) {
      const latency = getLatency(counters);
      const max = Math.max(1, latency, counters.requestCount || 0, counters.failureCount || 0);
      const rows = [
        ["平均", latency ? latency + "ms" : "暂无", latency, "primary"],
        ["请求", fmt(counters.requestCount || 0), counters.requestCount || 0, "success"],
        ["失败", fmt(counters.failureCount || 0), counters.failureCount || 0, "danger"],
      ];
      $("latency-panel").innerHTML = '<div class="usage-mini-bar-list">' + rows.map((row) => '<div class="usage-mini-bar-row"><span>' + esc(row[0]) + '</span><div class="usage-mini-bar-track"><div class="usage-mini-bar ' + esc(row[3]) + '" style="width:' + esc(String(Math.max(3, Math.round(row[2] / max * 100)))) + '%"></div></div><strong>' + esc(row[1]) + '</strong></div>').join("") + '</div>';
    }
    function renderScopeMatrix(profile, summary) {
      const items = [
        ["成员", 1, profile.consumer?.type || "consumer"],
        ["Access Key", 1, profile.accessKey?.status || "key"],
        ["号池", (summary.pools || []).length, "pool"],
        ["模型", (summary.models || []).length, "model"],
      ];
      $("scope-matrix").innerHTML = '<div class="usage-scope-matrix"><div class="usage-chart-section-header"><div><strong>归因覆盖</strong><span>当前成员窗口已有数据的业务维度覆盖情况</span></div><span class="badge neutral">矩阵</span></div><div class="usage-scope-grid">' + items.map((item) => '<div class="usage-scope-cell"><small>' + esc(item[0]) + '</small><strong>' + esc(fmt(item[1])) + '</strong><span>' + esc(item[2]) + '</span></div>').join("") + '</div></div>';
    }
    $("query-form").addEventListener("submit", (event) => { event.preventDefault(); load().catch((error) => setStatus(error.message, "error")); });
    $("refresh").addEventListener("click", () => load().catch((error) => setStatus(error.message, "error")));
    $("range").addEventListener("change", () => { if (state.apiKey) load().catch((error) => setStatus(error.message, "error")); });
    $("toggle-key").addEventListener("click", () => {
      const input = $("api-key");
      input.type = input.type === "password" ? "text" : "password";
      $("toggle-key").textContent = input.type === "password" ? "显示" : "隐藏";
    });
  </script>
</body>
</html>`;
}

function buildPublicAccountPortalHtmlV4(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RelayGate Account Center</title>
  <meta name="reference" content="animated-characters-login-page https://github.com/a97242689/animated-characters-login-page" />
  <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
  <style>
    :root {
      color-scheme: light;
      --color-neutral-50: #fafafa;
      --color-neutral-100: #f4f4f5;
      --color-neutral-200: #e4e4e7;
      --color-neutral-300: #d4d4d8;
      --color-neutral-400: #a1a1aa;
      --color-neutral-500: #71717a;
      --color-neutral-600: #52525b;
      --color-neutral-700: #3f3f46;
      --color-neutral-800: #27272a;
      --color-neutral-900: #18181b;
      --color-brand-50: #eff6ff;
      --color-brand-500: #3b82f6;
      --color-brand-600: #2563eb;
      --color-brand-700: #1d4ed8;
      --color-success-50: #f0fdf4;
      --color-success-500: #22c55e;
      --color-success-600: #16a34a;
      --color-warning-50: #fffbeb;
      --color-warning-500: #f59e0b;
      --color-warning-600: #d97706;
      --color-error-50: #fef2f2;
      --color-error-500: #ef4444;
      --color-error-600: #dc2626;
      --color-info-500: #3b82f6;
      --color-bg-app: #f6f7fb;
      --color-bg-sidebar: #ffffff;
      --color-bg-page: #f8fafc;
      --color-bg-card: #ffffff;
      --color-bg-elevated: #f4f7fb;
      --color-bg-hover: #f1f5f9;
      --color-bg-active: #e8f1ff;
      --color-border-default: #d9e0ea;
      --color-border-subtle: #e8edf4;
      --color-border-strong: #c4ccd8;
      --color-text-primary: #111827;
      --color-text-secondary: #4b5563;
      --color-text-tertiary: #6b7280;
      --bg-window: var(--color-bg-app);
      --bg-sidebar: var(--color-bg-sidebar);
      --text-primary: var(--color-text-primary);
      --text-secondary: var(--color-text-secondary);
      --text-tertiary: var(--color-text-tertiary);
      --border-light: var(--color-border-subtle);
      --accent-color: var(--color-brand-600);
      --success: var(--color-success-500);
      --warning: var(--color-warning-600);
      --danger: var(--color-error-600);
      --info: var(--color-info-500);
      --color-chart-4: #8b5cf6;
      --sidebar-width: 240px;
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-xl: 16px;
      --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04);
      --shadow-md: 0 8px 20px rgba(15, 23, 42, 0.08);
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      min-height: 100vh;
      background: var(--color-bg-app);
      color: var(--text-primary);
      font-size: 14px;
      line-height: 1.5715;
      -webkit-font-smoothing: antialiased;
    }
    button, input, select { font: inherit; outline: none; }
    button { cursor: pointer; }
    [hidden] { display: none !important; }

    .animated-login-page.login-page {
      display: grid;
      grid-template-columns: 1fr 1fr;
      min-height: 100vh;
      max-height: 100vh;
      overflow: hidden;
      background: #ffffff;
    }
    .left-section {
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      min-width: 0;
      padding: 3rem;
      overflow: hidden;
      color: #111827;
      background:
        radial-gradient(circle at 22% 18%, rgba(59, 130, 246, 0.08), transparent 32%),
        linear-gradient(135deg, #ffffff 0%, #f8fafc 52%, #f4f7fb 100%);
    }
    .logo-section,
    .characters-section {
      position: relative;
      z-index: 20;
    }
    .logo-link {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: inherit;
      font-size: 1.125rem;
      font-weight: 600;
      text-decoration: none;
    }
    .logo-image {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      flex-shrink: 0;
      background: transparent;
    }
    .app-logo-svg {
      display: block;
      width: 42px;
      height: 42px;
    }
    .characters-section {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      min-height: 0;
      padding-right: clamp(0px, 5vw, 86px);
      padding-bottom: clamp(36px, 7vh, 74px);
    }
    .grid-overlay {
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(15, 23, 42, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(15, 23, 42, 0.035) 1px, transparent 1px);
      background-size: 22px 22px;
      mask-image: linear-gradient(90deg, rgba(0, 0, 0, 0.7), transparent 78%);
    }
    .right-section {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      padding: 2rem;
      padding-left: clamp(2rem, 6vw, 96px);
      background: #fff;
    }
    .form-wrapper {
      width: 100%;
      max-width: 420px;
    }
    .form-header {
      margin-bottom: 2.5rem;
      text-align: center;
    }
    .form-title {
      margin: 0 0 0.5rem;
      color: #111827;
      font-size: 1.875rem;
      font-weight: 700;
      letter-spacing: -0.025em;
    }
    .form-subtitle {
      margin: 0;
      color: #6b7280;
      font-size: 0.875rem;
    }
    .login-form {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .form-label {
      color: #374151;
      font-size: 0.875rem;
      font-weight: 500;
    }
    .password-wrapper {
      position: relative;
    }
    .password-wrapper .form-input {
      padding-right: 2.5rem;
    }
    .input-field {
      width: 100%;
      min-height: 3rem;
      padding: 0 1rem;
      border: 1px solid var(--color-border-default);
      border-radius: 0.5rem;
      background: #fff;
      color: var(--text-primary);
      font-size: 1rem;
      transition: border-color 0.16s ease, box-shadow 0.16s ease;
    }
    .input-field:focus {
      border-color: #6366f1;
      box-shadow: none;
    }
    .input-field[readonly] {
      background: #f8fafc;
      color: var(--text-secondary);
      cursor: default;
    }
    .input-field::placeholder {
      color: #9ca3af;
      font-size: 0.9rem;
      font-weight: 400;
    }
    .password-toggle {
      position: absolute;
      right: 0.75rem;
      top: 50%;
      display: flex;
      align-items: center;
      padding: 0;
      border: 0;
      background: none;
      color: #9ca3af;
      transform: translateY(-50%);
    }
    .btn {
      min-height: 36px;
      padding: 7px 13px;
      border: 1px solid var(--accent-color);
      border-radius: var(--radius-sm);
      background: var(--accent-color);
      color: #fff;
      font-size: 13px;
      font-weight: 700;
      transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
    }
    .btn:hover { background: var(--color-brand-700); box-shadow: 0 12px 24px rgba(37, 99, 235, 0.16); transform: translateY(-1px); }
    .btn.secondary {
      border-color: var(--color-border-default);
      background: #fff;
      color: var(--text-secondary);
    }
    .btn.secondary:hover { color: var(--accent-color); background: var(--color-bg-active); box-shadow: none; }
    .btn:disabled { cursor: not-allowed; opacity: 0.56; transform: none; box-shadow: none; }
    .submit-button {
      position: relative;
      width: 100%;
      height: 3rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      overflow: hidden;
      border: 0;
      border-radius: 0.5rem;
      background: #111827;
      color: #fff;
      font-size: 1rem;
      font-weight: 500;
      transition: all 0.3s;
    }
    .submit-button:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
    }
    .submit-button .button-text,
    .submit-button .button-icon {
      transition: transform 0.3s;
    }
    .submit-button:hover:not(:disabled) .button-text {
      transform: translateX(-8px);
    }
    .submit-button:hover:not(:disabled) .button-icon {
      transform: translateX(8px);
    }
    .submit-button.is-loading {
      cursor: wait;
      opacity: 0.92;
    }
    .submit-button.is-loading .button-text {
      transform: translateX(0);
    }
    .submit-button.is-loading .button-icon {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.36);
      border-top-color: #fff;
      border-radius: 999px;
      animation: login-button-spin 0.8s linear infinite;
    }
    .submit-button.is-loading .button-icon path {
      display: none;
    }
    @keyframes login-button-spin {
      to { transform: rotate(360deg); }
    }
    .login-status {
      min-height: 36px;
      padding: 8px 10px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: var(--color-bg-elevated);
      color: var(--text-secondary);
      font-size: 12px;
    }
    .login-status.ok { border-color: rgba(22, 163, 74, 0.28); background: var(--color-success-50); color: var(--color-success-600); }
    .login-status.error { border-color: rgba(220, 38, 38, 0.25); background: var(--color-error-50); color: var(--color-error-600); }
    .animated-characters-container {
      position: relative;
      width: 550px;
      height: 400px;
      transform: translateX(clamp(48px, 7vw, 108px));
    }
    .character {
      position: absolute;
      bottom: 0;
      transform-origin: bottom center;
      transition: all 0.7s cubic-bezier(0.4, 0, 0.2, 1);
      will-change: transform;
    }
    .purple-character {
      left: 70px;
      z-index: 1;
      width: 180px;
      height: var(--purple-height, 400px);
      border-radius: 0;
      background: #6c3ff5;
      transform: var(--purple-transform, skewX(0deg));
      animation: purple-entrance 1.2s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    }
    .black-character {
      left: 240px;
      z-index: 2;
      width: 120px;
      height: 310px;
      border-radius: 0;
      background: #2d2d2d;
      transform: var(--black-transform, skewX(0deg));
      animation: black-entrance 1s cubic-bezier(0.34, 1.56, 0.64, 1) 0.2s backwards;
    }
    .orange-character {
      left: 0;
      z-index: 3;
      width: 240px;
      height: 150px;
      border-radius: 120px 120px 0 0;
      background: #ff9b6b;
      transform: var(--orange-transform, skewX(0deg));
      animation: orange-entrance 1.1s cubic-bezier(0.34, 1.56, 0.64, 1) 0.1s backwards;
    }
    .yellow-character {
      left: 310px;
      z-index: 4;
      width: 140px;
      height: 230px;
      border-radius: 70px 70px 0 0;
      background: #e8d754;
      transform: var(--yellow-transform, skewX(0deg));
      animation: yellow-entrance 1s cubic-bezier(0.34, 1.56, 0.64, 1) 0.3s backwards;
    }
    .character.entrance-complete {
      animation: none;
    }
    @keyframes purple-entrance {
      0% { transform: translateX(-150px) translateY(50px) rotate(-15deg) scale(0.3); opacity: 0; }
      60% { transform: translateX(10px) translateY(-10px) rotate(3deg) scale(1.05); }
      100% { transform: translateX(0) translateY(0) rotate(0deg) scale(1); opacity: 1; }
    }
    @keyframes black-entrance {
      0% { transform: translateY(-100px) scale(0.5); opacity: 0; }
      70% { transform: translateY(10px) scale(1.08); }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }
    @keyframes orange-entrance {
      0% { transform: translateX(-200px) translateY(80px) rotate(-25deg) scale(0.2); opacity: 0; }
      65% { transform: translateX(15px) translateY(-8px) rotate(5deg) scale(1.1); }
      100% { transform: translateX(0) translateY(0) rotate(0deg) scale(1); opacity: 1; }
    }
    @keyframes yellow-entrance {
      0% { transform: translateX(200px) translateY(60px) rotate(20deg) scale(0.3); opacity: 0; }
      65% { transform: translateX(-12px) translateY(-5px) rotate(-4deg) scale(1.06); }
      100% { transform: translateX(0) translateY(0) rotate(0deg) scale(1); opacity: 1; }
    }
    .eyes {
      position: absolute;
      display: flex;
      transition: all 0.7s cubic-bezier(0.4, 0, 0.2, 1);
      will-change: left, top;
    }
    .purple-character .eyes { gap: 32px; left: var(--purple-eyes-left, 75px); top: var(--purple-eyes-top, 25px); transition: all 0.5s cubic-bezier(0, 0, 0.2, 1); }
    .black-character .eyes { gap: 24px; left: var(--black-eyes-left, 26px); top: var(--black-eyes-top, 32px); }
    .orange-character .eyes { gap: 32px; left: var(--orange-eyes-left, 112px); top: var(--orange-eyes-top, 60px); transition: all 0.2s cubic-bezier(0, 0, 0.2, 1); }
    .yellow-character .eyes { gap: 24px; left: var(--yellow-eyes-left, 52px); top: var(--yellow-eyes-top, 40px); transition: all 0.2s cubic-bezier(0, 0, 0.2, 1); }
    .eyeball {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: var(--eye-size, 18px);
      height: var(--eye-height, var(--eye-size, 18px));
      overflow: hidden;
      border-radius: var(--eye-radius, 50%);
      background: #fff;
      transform: var(--eye-transform, rotate(0deg));
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      will-change: height, border-radius, transform;
    }
    .pupil {
      width: var(--pupil-size, 7px);
      height: var(--pupil-height, var(--pupil-size, 7px));
      border-radius: 50%;
      background: #2d2d2d;
      transform: translate(var(--pupil-x, 0px), var(--pupil-y, 0px));
      transition: transform 0.1s ease-out, height 0.15s ease-out;
      will-change: transform, height;
    }
    .pupil-only {
      --pupil-size: 12px;
      width: 12px;
      height: var(--pupil-height, 12px);
      border-radius: 50%;
      background: #2d2d2d;
      transform: translate(var(--pupil-x, 0px), var(--pupil-y, 0px));
      transition: transform 0.1s ease-out, height 0.15s ease-out;
    }
    .is-blinking { --eye-height: 2px; --pupil-height: 2px; }
    .purple-mouth-shape,
    .orange-mouth-shape {
      position: absolute;
      background: #2d2d2d;
      transition: left 0.5s cubic-bezier(0, 0, 0.2, 1), top 0.5s cubic-bezier(0, 0, 0.2, 1), width 0.5s cubic-bezier(0.4, 0, 0.2, 1), height 0.5s cubic-bezier(0.4, 0, 0.2, 1), border-radius 0.5s cubic-bezier(0.4, 0, 0.2, 1), transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .purple-mouth-shape {
      left: var(--purple-mouth-left, 97px);
      top: var(--purple-mouth-top, 57px);
      width: 24px;
      height: 8px;
      border-radius: 0 0 12px 12px;
    }
    .orange-mouth-shape {
      left: var(--orange-mouth-left, 126px);
      top: var(--orange-mouth-top, 92px);
      width: 26px;
      height: 13px;
      border-radius: 0 0 13px 13px;
    }
    .purple-mouth-shape--typing {
      width: 7px;
      height: 32px;
      border-radius: 0;
      transform: translateX(13.5px) translateY(-28px) var(--counter-skew, skewX(0deg));
    }
    .orange-mouth-shape--typing {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      transform: translateX(6px);
    }
    .purple-mouth-shape--sad,
    .orange-mouth-shape--sad {
      border-radius: 13px 13px 0 0;
    }
    .purple-mouth-shape--happy,
    .orange-mouth-shape--happy {
      width: 32px;
      height: 18px;
      border-radius: 0 0 16px 16px;
    }
    .yellow-mouth-wrapper {
      position: absolute;
      left: var(--yellow-mouth-left, 40px);
      top: var(--yellow-mouth-top, 88px);
      transition: all 0.2s cubic-bezier(0, 0, 0.2, 1);
    }
    .yellow-mouth-path {
      d: path("M0 10 Q10 10, 20 10 Q30 10, 40 10 Q50 10, 60 10 Q70 10, 80 10");
      transition: d 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .yellow-mouth-path--wavy {
      d: path("M0 10 Q10 2, 20 10 Q30 18, 40 10 Q50 2, 60 10 Q70 18, 80 10");
    }
    .yellow-mouth-path--happy {
      d: path("M0 2 Q10 10, 20 14 Q30 18, 40 18 Q50 18, 60 14 Q70 10, 80 2");
    }
    .confetti-container {
      position: fixed;
      inset: 0;
      z-index: 120;
      overflow: visible;
      pointer-events: none;
    }
    .confetti-piece {
      position: absolute;
      border-radius: 2px;
      animation: confetti-fall linear forwards;
    }
    @keyframes confetti-fall {
      0% { translate: 0 0; opacity: 1; }
      100% { translate: 30px 200vh; opacity: 1; rotate: 720deg; }
    }
    .animated-login-page.login-success-holding {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    .animated-login-page.login-success-transitioning {
      position: fixed;
      inset: 0;
      z-index: 40;
      pointer-events: none;
      animation: login-success-out 0.8s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    .account-dashboard-shell.dashboard-entering {
      position: fixed;
      inset: 0;
      z-index: 30;
      animation: dashboard-enter-in 0.8s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes login-success-out {
      0% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
      100% { opacity: 0; transform: translateY(-10px) scale(0.992); filter: blur(3px); }
    }
    @keyframes dashboard-enter-in {
      0% { opacity: 0; transform: translateY(12px) scale(0.992); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }

    .account-dashboard-shell.app-shell {
      display: flex;
      min-height: 100vh;
      background: var(--color-bg-app);
    }
    .sidebar {
      width: var(--sidebar-width);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      background: var(--color-bg-sidebar);
      border-right: 1px solid var(--color-border-subtle);
    }
    .brand-area {
      min-height: 82px;
      padding: 17px var(--space-4);
      display: flex;
      align-items: center;
      gap: 13px;
      border-bottom: 1px solid var(--color-border-subtle);
    }
    .brand-mark {
      width: 46px; height: 46px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      background: transparent;
    }
    .sidebar-logo-svg {
      display: block;
      width: 46px;
      height: 46px;
    }
    .brand-text { display: grid; gap: 2px; min-width: 0; }
    .brand-text strong { font-size: 15px; }
    .brand-text span { color: var(--text-tertiary); font-size: 12px; }
    .nav-section { padding: var(--space-4); display: grid; gap: 8px; }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 40px;
      padding: 9px 11px;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      background: transparent;
      color: var(--text-secondary);
      text-align: left;
      font-weight: 700;
    }
    .nav-item.active {
      border-color: color-mix(in oklab, var(--accent-color) 22%, var(--color-border-subtle));
      background: var(--color-bg-active);
      color: var(--accent-color);
    }
    .sidebar-footer {
      margin-top: auto;
      display: grid;
      gap: 10px;
      padding: var(--space-4);
      border-top: 1px solid var(--color-border-subtle);
      color: var(--text-secondary);
      font-size: 12px;
    }
    .main {
      flex: 1;
      min-width: 0;
      height: 100vh;
      overflow: auto;
      background: var(--color-bg-page);
    }
    .content-wrapper {
      display: grid;
      gap: var(--space-4);
      max-width: 1320px;
      margin: 0 auto;
      padding: var(--space-6);
    }
    .section-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-4);
    }
    .section-head h2 { margin: 0; font-size: 24px; letter-spacing: -0.03em; }
    .section-head p { margin: 6px 0 0; color: var(--text-secondary); }
    .section-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; }
    .badge {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      min-height: 24px;
      padding: 4px 9px;
      border: 1px solid color-mix(in oklab, var(--accent-color) 18%, var(--color-border-subtle));
      border-radius: 999px;
      background: color-mix(in oklab, var(--accent-color) 7%, white);
      color: color-mix(in oklab, var(--accent-color) 70%, black);
      font-size: 11px;
      font-weight: 800;
    }
    .badge.neutral { border-color: var(--color-border-subtle); background: var(--color-bg-elevated); color: var(--text-secondary); }
    .badge.active, .badge.success { border-color: rgba(22, 163, 74, 0.28); background: var(--color-success-50); color: var(--color-success-600); }
    .usage-alerts-workbench { display: grid; gap: var(--space-4); }
    .usage-chart-panel {
      padding: var(--space-4);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-md);
      background: var(--color-bg-card);
      box-shadow: var(--shadow-sm);
    }
    .card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .usage-chart-header { display: grid; grid-template-columns: 1fr; align-items: flex-start; gap: 14px; }
    .card-title { color: var(--text-primary); font-weight: 800; }
    .card-description { margin: 4px 0 0; color: var(--text-secondary); font-size: 13px; }
    .usage-chart-header-actions {
      display: grid;
      justify-items: stretch;
      gap: 10px;
      width: 100%;
      min-width: 0;
    }
    .usage-chart-mode-row {
      display: flex;
      justify-content: flex-end;
      min-width: 0;
    }
    .usage-observe-mode { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .usage-observe-mode > span,
    .usage-analysis-filter span { color: var(--text-secondary); font-size: 12px; }
    .usage-window-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px;
      border: 1px solid var(--border-light);
      border-radius: 999px;
      background: var(--color-bg-card);
    }
    .usage-window-chip {
      appearance: none;
      min-width: 42px;
      height: 30px;
      padding: 0 10px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 500;
      transition: background-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
    }
    .usage-window-chip[data-active="true"] {
      background: var(--color-bg-page);
      color: var(--accent-color);
      box-shadow: var(--shadow-sm);
    }
    .usage-analysis-filter { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .usage-analysis-filter.compact { min-width: 0; }
    .usage-analysis-filter .input-field { width: 100%; min-width: 0; min-height: 32px; padding-block: 5px; }
    .usage-observe-window-group .usage-window-chip { min-width: 72px; padding: 0 12px; }
    .usage-chart-frame {
      position: relative;
      display: grid;
      align-items: stretch;
      min-height: 360px;
      overflow: hidden;
      padding: 18px;
      border-radius: var(--radius-md);
      border: 1px solid var(--color-border-subtle);
      background: var(--color-bg-elevated);
    }
    .usage-period-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .usage-period-card {
      appearance: none;
      display: grid;
      gap: 6px;
      min-width: 0;
      padding: 13px 14px;
      border: 1px solid color-mix(in oklab, var(--accent-color) 16%, var(--color-border-subtle));
      border-radius: var(--radius-md);
      background: linear-gradient(180deg, rgba(37, 99, 235, 0.045), rgba(16, 185, 129, 0.025)), var(--color-bg-card);
      box-shadow: 0 10px 22px rgba(15, 23, 42, 0.05);
      color: inherit;
      text-align: left;
      cursor: pointer;
      transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
    }
    .usage-period-card[data-active="true"] {
      border-color: var(--color-brand-600);
      box-shadow: 0 14px 28px rgba(37, 99, 235, 0.12);
    }
    .usage-period-card:hover {
      border-color: var(--accent-color);
      transform: translateY(-1px);
    }
    .usage-period-card span {
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 800;
    }
    .usage-period-card strong {
      color: var(--text-primary);
      font-size: 19px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .usage-period-card small {
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.45;
    }
    .usage-data-hint { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; margin-bottom: 2px; }
    .usage-data-hint span {
      min-width: 0;
      padding: 7px 10px;
      border: 1px solid color-mix(in oklab, var(--info) 18%, var(--color-border-subtle));
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--info) 8%, white);
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.45;
    }
    .usage-operations-dashboard {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      min-width: 0;
    }
    .usage-operations-wide { grid-column: 1 / -1; min-width: 0; }
    .usage-operations-health { grid-column: 1 / -1; min-width: 0; }
    .usage-operations-main { grid-column: 1 / -1; min-width: 0; }
    .usage-operations-breakdown {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
      gap: 14px;
      align-items: stretch;
    }
    .usage-operations-card,
    .usage-echart-card-ranking,
    .usage-echart-card-mix { min-width: 0; }
    .usage-member-health-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 20px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(16, 185, 129, 0.05)), var(--color-bg-card);
      box-shadow: 0 18px 36px rgba(15, 23, 42, 0.07);
    }
    .usage-member-health-card.tone-success {
      border-color: color-mix(in oklab, var(--success) 32%, var(--color-border-subtle));
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(37, 99, 235, 0.04)), var(--color-bg-card);
    }
    .usage-member-health-card.tone-warning,
    .usage-member-health-card.tone-danger {
      border-color: color-mix(in oklab, var(--warning) 36%, var(--color-border-subtle));
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(239, 68, 68, 0.05)), var(--color-bg-card);
    }
    .usage-member-health-main { display: grid; gap: 8px; min-width: 0; }
    .usage-health-badge {
      display: inline-flex;
      justify-self: flex-start;
      width: fit-content;
      min-height: 24px;
      padding: 4px 9px;
      border: 1px solid var(--color-border-subtle);
      border-radius: 999px;
      background: color-mix(in oklab, var(--color-bg-elevated) 80%, white);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 800;
    }
    .usage-health-badge.tone-success {
      border-color: color-mix(in oklab, var(--success) 34%, var(--color-border-subtle));
      background: color-mix(in oklab, var(--success) 12%, white);
      color: color-mix(in oklab, var(--success) 72%, black);
    }
    .usage-health-badge.tone-active,
    .usage-health-badge.tone-neutral {
      border-color: color-mix(in oklab, var(--accent-color) 24%, var(--color-border-subtle));
      background: color-mix(in oklab, var(--accent-color) 9%, white);
      color: color-mix(in oklab, var(--accent-color) 68%, black);
    }
    .usage-health-badge.tone-warning,
    .usage-health-badge.tone-danger {
      border-color: color-mix(in oklab, var(--warning) 34%, var(--color-border-subtle));
      background: color-mix(in oklab, var(--warning) 14%, white);
      color: color-mix(in oklab, var(--danger) 70%, black);
    }
    .usage-member-health-main strong { color: var(--text-primary); font-size: 20px; }
    .usage-member-health-main p { margin: 0; color: var(--text-secondary); font-size: 13px; }
    .usage-member-health-metrics { display: flex; flex-wrap: wrap; gap: 8px; }
    .usage-member-health-metrics span {
      padding: 5px 8px;
      border: 1px solid var(--color-border-subtle);
      border-radius: 999px;
      background: color-mix(in oklab, var(--color-bg-elevated) 82%, white);
      color: var(--text-secondary);
      font-size: 12px;
    }
    .usage-member-health-score {
      display: grid;
      place-items: center;
      flex: 0 0 112px;
      width: 112px;
      height: 112px;
      border-radius: 24px;
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid color-mix(in oklab, var(--accent-color) 18%, var(--color-border-subtle));
    }
    .usage-member-health-score strong { color: var(--text-primary); font-size: 34px; line-height: 1; }
    .usage-member-health-score span { color: var(--text-secondary); font-size: 12px; font-weight: 700; }
    .usage-member-health-matrix {
      display: grid;
      gap: 12px;
      min-width: 0;
      padding: 14px 16px;
      border: 1px solid color-mix(in oklab, var(--accent-color) 16%, var(--color-border-subtle));
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.045), rgba(245, 158, 11, 0.04)), var(--color-bg-card);
      box-shadow: 0 16px 32px rgba(15, 23, 42, 0.055);
    }
    .usage-member-health-table { display: grid; gap: 8px; min-width: 0; }
    .usage-member-health-head,
    .usage-member-health-row {
      display: grid;
      grid-template-columns: minmax(160px, 1.4fr) 120px 120px 72px 72px minmax(120px, 0.9fr);
      gap: 10px;
      align-items: center;
    }
    .usage-member-health-head { padding: 0 10px; color: var(--text-tertiary); font-size: 11px; font-weight: 700; }
    .usage-member-health-row {
      width: 100%;
      padding: 10px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-bg-elevated) 76%, white);
      color: var(--text-secondary);
      font: inherit;
      text-align: left;
    }
    .usage-member-health-row strong,
    .usage-member-health-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .usage-member-health-row strong { color: var(--text-primary); font-size: 13px; }
    .usage-member-health-row small { color: var(--text-tertiary); font-size: 11px; }
    .usage-health-score-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 26px;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
    }
    .usage-health-score-pill.tone-success { background: color-mix(in oklab, var(--success) 14%, white); color: color-mix(in oklab, var(--success) 72%, black); }
    .usage-health-score-pill.tone-active { background: color-mix(in oklab, var(--accent-color) 14%, white); color: color-mix(in oklab, var(--accent-color) 72%, black); }
    .usage-health-score-pill.tone-warning,
    .usage-health-score-pill.tone-danger { background: color-mix(in oklab, var(--warning) 18%, white); color: color-mix(in oklab, var(--danger) 70%, black); }
    .usage-echart-card {
      display: grid;
      gap: 12px;
      min-width: 0;
      min-height: 100%;
      padding: 14px 16px;
      border: 1px solid color-mix(in oklab, var(--accent-color) 18%, var(--color-border-subtle));
      border-radius: var(--radius-md);
      background: linear-gradient(180deg, rgba(37, 99, 235, 0.045), rgba(16, 185, 129, 0.025)), var(--color-bg-card);
      box-shadow: 0 16px 32px rgba(15, 23, 42, 0.06);
    }
    .usage-echart-card-large { min-height: 360px; }
    .usage-trend-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; min-width: 0; }
    .usage-trend-stat {
      display: grid;
      gap: 3px;
      min-width: 0;
      padding: 10px 12px;
      border: 1px solid color-mix(in oklab, var(--accent-color) 16%, var(--color-border-subtle));
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--accent-color) 7%, white);
    }
    .usage-trend-stat small { color: var(--text-tertiary); font-size: 11px; font-weight: 800; }
    .usage-trend-stat strong { color: var(--text-primary); font-size: 18px; }
    .usage-trend-stat span { color: var(--text-secondary); font-size: 11px; }
    .usage-echart { position: relative; min-width: 0; width: 100%; min-height: 260px; }
    .usage-echart-trend { min-height: 310px; }
    .usage-echart-ranking { min-height: 300px; }
    .usage-echart-outcome,
    .usage-echart-latency { min-height: 240px; }
    .usage-line-chart,
    .usage-ranking-chart,
    .usage-donut-chart,
    .usage-outcome-chart,
    .usage-latency-chart,
    .usage-scope-matrix {
      display: grid;
      gap: 10px;
      min-width: 0;
      padding: 14px 16px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      background: var(--color-bg-card);
    }
    .usage-chart-section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .usage-chart-section-header > div { display: grid; gap: 4px; min-width: 0; }
    .usage-chart-section-header strong { color: var(--text-primary); font-size: 14px; }
    .usage-chart-section-header span:not(.badge) { color: var(--text-secondary); font-size: 12px; }
    .usage-line-chart svg {
      width: 100%;
      min-height: 220px;
      border-radius: var(--radius-sm);
      background:
        linear-gradient(to right, color-mix(in oklab, var(--color-border-subtle) 35%, transparent) 1px, transparent 1px) 0 0 / 12.5% 100%,
        linear-gradient(to bottom, color-mix(in oklab, var(--color-border-subtle) 45%, transparent) 1px, transparent 1px) 0 0 / 100% 25%,
        color-mix(in oklab, var(--color-bg-elevated) 88%, white);
    }
    .usage-line-grid { fill: none; stroke: var(--color-border-subtle); stroke-width: 1; }
    .usage-line-series { fill: none; stroke: var(--accent-color); stroke-linecap: round; stroke-linejoin: round; stroke-width: 3; }
    .usage-line-point { fill: var(--color-bg-card); stroke: var(--accent-color); stroke-width: 2; }
    .usage-ranking-list { display: grid; gap: 10px; }
    .usage-ranking-row { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; align-items: center; }
    .usage-ranking-index {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      background: var(--color-bg-elevated);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 700;
    }
    .usage-ranking-main { display: grid; gap: 5px; min-width: 0; }
    .usage-ranking-meta { display: flex; justify-content: space-between; gap: 12px; min-width: 0; }
    .usage-ranking-meta strong,
    .usage-ranking-meta span,
    .usage-ranking-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .usage-ranking-meta strong { color: var(--text-primary); font-size: 13px; }
    .usage-ranking-meta span,
    .usage-ranking-main small { color: var(--text-secondary); font-size: 12px; }
    .usage-ranking-track { height: 9px; overflow: hidden; border-radius: 999px; background: var(--color-bg-elevated); }
    .usage-ranking-bar { height: 100%; min-width: 8px; border-radius: inherit; background: linear-gradient(90deg, var(--accent-color), var(--success)); }
    .usage-donut-body { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 14px; align-items: center; }
    .usage-donut-visual {
      display: grid;
      place-items: center;
      align-content: center;
      width: 150px;
      height: 150px;
      border-radius: 50%;
      background:
        radial-gradient(circle at center, var(--color-bg-card) 0 54%, transparent 55%),
        conic-gradient(var(--accent-color) 0 var(--input-end), var(--success) var(--input-end) var(--output-end), var(--warning) var(--output-end) var(--cached-end), var(--color-chart-4) var(--cached-end) 100%);
    }
    .usage-donut-visual strong { color: var(--text-primary); font-size: 20px; }
    .usage-donut-visual span { color: var(--text-secondary); font-size: 12px; }
    .usage-donut-legend { display: grid; gap: 8px; min-width: 0; }
    .usage-donut-legend-row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 8px; align-items: center; color: var(--text-secondary); font-size: 12px; }
    .usage-donut-legend-row strong { overflow: hidden; color: var(--text-primary); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .usage-donut-dot { width: 8px; height: 8px; border-radius: 999px; }
    .usage-donut-dot.input { background: var(--accent-color); }
    .usage-donut-dot.output { background: var(--success); }
    .usage-donut-dot.cached { background: var(--warning); }
    .usage-donut-dot.reasoning { background: var(--color-chart-4); }
    .usage-outcome-track { display: flex; height: 8px; overflow: hidden; border-radius: 999px; border: none; background: var(--color-bg-elevated); }
    .usage-outcome-segment.success { background: linear-gradient(90deg, color-mix(in oklab, var(--success) 72%, white), var(--success)); }
    .usage-outcome-segment.failure { background: linear-gradient(90deg, var(--danger), color-mix(in oklab, var(--danger) 62%, white)); }
    .usage-mini-bar-list { display: grid; gap: 10px; }
    .usage-mini-bar-row { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 10px; align-items: center; color: var(--text-secondary); font-size: 12px; }
    .usage-mini-bar-track { height: 9px; overflow: hidden; border-radius: 999px; background: var(--color-bg-elevated); }
    .usage-mini-bar { height: 100%; min-width: 8px; border-radius: inherit; }
    .usage-mini-bar.success { background: var(--success); }
    .usage-mini-bar.primary { background: var(--accent-color); }
    .usage-mini-bar.warning { background: var(--warning); }
    .usage-mini-bar.danger { background: var(--danger); }
    .usage-scope-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .usage-scope-cell {
      display: grid;
      gap: 4px;
      padding: 12px;
      border-radius: var(--radius-sm);
      background: var(--color-bg-elevated);
      border: 1px solid var(--color-border-subtle);
    }
    .usage-scope-cell small,
    .usage-scope-cell span { color: var(--text-secondary); font-size: 12px; }
    .usage-scope-cell strong { color: var(--text-primary); font-size: 20px; }
    .usage-dimension-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .usage-insight-card {
      display: grid;
      gap: 8px;
      padding: 16px;
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      background: var(--color-bg-card);
      box-shadow: var(--shadow-sm);
    }
    .usage-insight-card small { color: var(--text-secondary); font-size: 13px; }
    .usage-insight-card strong {
      min-width: 0;
      color: var(--text-primary);
      font-size: 16px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .usage-insight-card span { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
    .usage-chart-legend { display: flex; flex-wrap: wrap; gap: 8px 12px; color: var(--text-secondary); font-size: 12px; }
    .empty-card {
      display: grid;
      align-content: center;
      justify-items: center;
      min-height: 160px;
      padding: 22px;
      border: 1px dashed var(--color-border-default);
      border-radius: var(--radius-md);
      background: color-mix(in oklab, var(--color-bg-elevated) 72%, white);
      color: var(--text-secondary);
      text-align: center;
    }
    .safe-note { color: var(--text-tertiary); font-size: 12px; }
    @media (max-height: 820px) and (min-width: 961px) {
      .left-section { padding: 2rem 3rem; }
      .characters-section { height: min(56vh, 420px); }
      .animated-characters-container {
        transform: scale(0.82);
        transform-origin: bottom center;
      }
    }
    @media (max-width: 960px) {
      .animated-login-page.login-page { grid-template-columns: 1fr; }
      .left-section { display: none; }
      .account-dashboard-shell.app-shell { display: grid; }
      .sidebar { width: 100%; border-right: 0; border-bottom: 1px solid var(--color-border-subtle); }
      .main { height: auto; min-height: 100vh; }
      .usage-operations-dashboard,
      .usage-operations-breakdown,
      .usage-trend-stat-grid,
      .usage-scope-grid { grid-template-columns: 1fr; }
      .usage-member-health-card { align-items: flex-start; flex-direction: column; }
      .usage-member-health-score { width: 100%; height: auto; min-height: 88px; }
      .usage-member-health-head { display: none; }
      .usage-member-health-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main id="login-page" class="animated-login-page login-page">
    <section class="left-section" aria-label="Animated characters login visual">
      <div class="logo-section">
        <a href="/v1/account" class="logo-link">
          <span class="logo-image" aria-hidden="true">
            <svg class="app-logo-svg" viewBox="64 64 896 896" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="portalIconBg" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#FFFFFF"></stop>
                  <stop offset="100%" stop-color="#F1F5F9"></stop>
                </linearGradient>
                <linearGradient id="portalIconBack" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#2DD4BF"></stop>
                  <stop offset="100%" stop-color="#0D9488"></stop>
                </linearGradient>
                <linearGradient id="portalIconMid" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#A78BFA"></stop>
                  <stop offset="100%" stop-color="#6D28D9"></stop>
                </linearGradient>
                <linearGradient id="portalIconFront" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#3B82F6"></stop>
                  <stop offset="100%" stop-color="#1D4ED8"></stop>
                </linearGradient>
                <linearGradient id="portalIconLoop" x1="100%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#F59E0B"></stop>
                  <stop offset="50%" stop-color="#EC4899"></stop>
                  <stop offset="100%" stop-color="#3B82F6" stop-opacity="0"></stop>
                </linearGradient>
              </defs>
              <rect x="64" y="64" width="896" height="896" rx="202" fill="url(#portalIconBg)" stroke="#E2E8F0" stroke-width="4"></rect>
              <rect x="432" y="150" width="385" height="385" rx="96" fill="url(#portalIconBack)" opacity="0.96"></rect>
              <rect x="318" y="264" width="385" height="385" rx="96" fill="url(#portalIconMid)" opacity="0.98"></rect>
              <path d="M760 260 C1000 350 950 650 680 650" fill="none" stroke="url(#portalIconLoop)" stroke-width="36" stroke-linecap="round"></path>
              <polygon points="690,600 640,650 690,700" fill="#EC4899"></polygon>
              <rect x="178" y="378" width="385" height="385" rx="96" fill="url(#portalIconFront)"></rect>
              <g transform="translate(225 472)">
                <path d="M90 220 L150 60 L210 220" fill="none" stroke="#ffffff" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"></path>
                <line x1="110" y1="160" x2="190" y2="160" stroke="#ffffff" stroke-width="40" stroke-linecap="round"></line>
                <line x1="270" y1="120" x2="270" y2="220" stroke="#ffffff" stroke-width="44" stroke-linecap="round"></line>
                <path d="M270 10 Q270 50 230 50 Q270 50 270 90 Q270 50 310 50 Q270 50 270 10 Z" fill="#ffffff"></path>
              </g>
            </svg>
          </span>
          <span>RelayGate</span>
        </a>
      </div>
      <div class="characters-section">
        <div class="animated-characters-container" id="animated-characters">
          <div class="character purple-character" data-character="purple">
            <div class="eyes">
              <div class="eyeball" data-eye="purple"><span class="pupil"></span></div>
              <div class="eyeball" data-eye="purple"><span class="pupil"></span></div>
            </div>
            <div class="purple-mouth-shape"></div>
          </div>
          <div class="character black-character" data-character="black">
            <div class="eyes">
              <div class="eyeball" data-eye="black" style="--eye-size:16px;--pupil-size:6px;"><span class="pupil"></span></div>
              <div class="eyeball" data-eye="black" style="--eye-size:16px;--pupil-size:6px;"><span class="pupil"></span></div>
            </div>
          </div>
          <div class="character orange-character" data-character="orange">
            <div class="eyes">
              <span class="pupil-only" data-eye="orange"></span>
              <span class="pupil-only" data-eye="orange"></span>
            </div>
            <div class="orange-mouth-shape"></div>
          </div>
          <div class="character yellow-character" data-character="yellow">
            <div class="eyes">
              <span class="pupil-only" data-eye="yellow"></span>
              <span class="pupil-only" data-eye="yellow"></span>
            </div>
            <div class="yellow-mouth-wrapper">
              <svg width="80" height="20" viewBox="0 0 80 20">
                <path class="yellow-mouth-path" stroke="#2D2D2D" stroke-width="3" fill="none" stroke-linecap="round"></path>
              </svg>
            </div>
          </div>
        </div>
      </div>
      <div class="grid-overlay"></div>
    </section>
    <section class="right-section">
      <div class="form-wrapper">
        <div class="form-header">
          <h1 class="form-title">登录 henery.gateway</h1>
          <p class="form-subtitle">输入 API Key，查询当前额度与用量。</p>
        </div>
        <form class="login-form" id="login-form">
          <div class="form-group">
            <label for="username" class="form-label">用户名</label>
            <input class="form-input input-field" id="username" type="text" autocomplete="off" spellcheck="false" placeholder="可不填，校验通过后自动识别成员名称" readonly />
          </div>
          <div class="form-group">
            <label for="api-key" class="form-label">API Key</label>
            <div class="password-wrapper">
              <input class="form-input input-field" id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="lagw_xxx..." />
              <button class="password-toggle" type="button" id="toggle-key" aria-label="Show API key">显示</button>
            </div>
          </div>
          <div class="login-status" id="login-status">输入成员 API Key 后进入自助用量与额度查询。</div>
          <button class="submit-button" type="submit" id="login-submit">
            <span class="button-text">进入查询</span>
            <svg class="button-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12h14"></path>
              <path d="m12 5 7 7-7 7"></path>
            </svg>
          </button>
        </form>
      </div>
    </section>
  </main>

  <main id="dashboard-page" class="account-dashboard-shell app-shell figma-shell" hidden>
    <aside class="sidebar" aria-label="成员自助导航">
      <div class="brand-area">
        <div class="brand-mark" aria-hidden="true">
          <svg class="sidebar-logo-svg" viewBox="150 120 860 700" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="sidebarIconBg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#FFFFFF"></stop>
                <stop offset="100%" stop-color="#F1F5F9"></stop>
              </linearGradient>
              <linearGradient id="sidebarIconBack" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#2DD4BF"></stop>
                <stop offset="100%" stop-color="#0D9488"></stop>
              </linearGradient>
              <linearGradient id="sidebarIconMid" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#A78BFA"></stop>
                <stop offset="100%" stop-color="#6D28D9"></stop>
              </linearGradient>
              <linearGradient id="sidebarIconFront" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#3B82F6"></stop>
                <stop offset="100%" stop-color="#1D4ED8"></stop>
              </linearGradient>
              <linearGradient id="sidebarIconLoop" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#F59E0B"></stop>
                <stop offset="50%" stop-color="#EC4899"></stop>
                <stop offset="100%" stop-color="#3B82F6" stop-opacity="0"></stop>
              </linearGradient>
            </defs>
            <rect x="432" y="150" width="385" height="385" rx="96" fill="url(#sidebarIconBack)" opacity="0.96"></rect>
            <rect x="318" y="264" width="385" height="385" rx="96" fill="url(#sidebarIconMid)" opacity="0.98"></rect>
            <path d="M760 260 C1000 350 950 650 680 650" fill="none" stroke="url(#sidebarIconLoop)" stroke-width="36" stroke-linecap="round"></path>
            <polygon points="690,600 640,650 690,700" fill="#EC4899"></polygon>
            <rect x="178" y="378" width="385" height="385" rx="96" fill="url(#sidebarIconFront)"></rect>
            <g transform="translate(225 472)">
              <path d="M90 220 L150 60 L210 220" fill="none" stroke="#ffffff" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"></path>
              <line x1="110" y1="160" x2="190" y2="160" stroke="#ffffff" stroke-width="40" stroke-linecap="round"></line>
              <line x1="270" y1="120" x2="270" y2="220" stroke="#ffffff" stroke-width="44" stroke-linecap="round"></line>
              <path d="M270 10 Q270 50 230 50 Q270 50 270 90 Q270 50 310 50 Q270 50 270 10 Z" fill="#ffffff"></path>
            </g>
          </svg>
        </div>
        <div class="brand-text">
          <strong>henery.gateway</strong>
          <span>自助查询</span>
        </div>
      </div>
      <nav class="nav-section">
        <button class="nav-item active" type="button">
          <span>用量与告警</span>
        </button>
      </nav>
      <div class="sidebar-footer">
        <span class="badge active">成员中心</span>
        <strong id="sidebar-member">等待查询</strong>
        <span id="sidebar-key">Key 已脱敏显示</span>
        <button class="btn secondary" type="button" id="logout">退出登录</button>
      </div>
    </aside>
    <section class="main">
      <div class="content-wrapper">
        <div class="view" data-view="usage">
          <section>
            <div class="section-head page-section-head">
              <div>
                <h2>用量与告警</h2>
                <p>集中观察 Token 消耗、成员归因、账号/模型/号池排行和告警事件。</p>
              </div>
              <div class="section-actions">
                <button class="btn secondary" id="dashboard-refresh" type="button">刷新用量</button>
              </div>
            </div>
            <div class="usage-alerts-workbench">
              <div class="usage-chart-panel">
                <div class="card-header usage-chart-header">
                  <div>
                    <span class="card-title">窗口用量结构</span>
                    <p class="card-description">基于当前 API Key 展示当前成员的 Token 消耗、模型排行、稳定性和周期趋势。</p>
                  </div>
                  <div class="usage-chart-header-actions">
                    <div class="usage-chart-mode-row">
                      <div class="usage-observe-mode">
                        <span>统计周期</span>
                        <div id="usage-observe-window" class="usage-window-group usage-observe-window-group" role="tablist" aria-label="Token 用量统计周期">
                          <button class="usage-window-chip" data-window="24h" data-active="true" type="button">近 24h</button>
                          <button class="usage-window-chip" data-window="7d" data-active="false" type="button">近 7 天</button>
                          <button class="usage-window-chip" data-window="30d" data-active="false" type="button">近 30 天</button>
                          <button class="usage-window-chip" data-window="all" data-active="false" type="button">总计</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div id="usage-trend-chart" class="usage-chart-frame" aria-label="用量趋势结构">
                  <div id="usage-operations-dashboard" class="usage-operations-dashboard">
                    <div class="empty-card">正在等待用量统计。</div>
                  </div>
                </div>
                <div id="usage-period-summary" class="usage-period-summary" aria-label="用量周期总览"></div>
              </div>
              <div id="usage-dimension-insights" class="usage-dimension-grid">
                <div class="empty-card">登录后展示当前成员维度洞察。</div>
              </div>
              <p class="safe-note">安全边界：本页只调用自助只读接口；不会请求管理端路径，不展示完整 Key、上游账号或 prompt 正文。</p>
            </div>
          </section>
        </div>
      </div>
    </section>
  </main>
  <div id="confetti-container" class="confetti-container" hidden></div>

  <script>
    const state = { apiKey: "", profile: null, usage: null, range: "24h" };
    const usageTrendZoomState = { start: 0, end: 100, range: "24h" };
    const sessionKey = "henery.gateway.account.apiKey";
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    function fmt(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return "0";
      }
      const abs = Math.abs(value);
      if (abs >= 1000000000) {
        return (value / 1000000000).toFixed(abs >= 10000000000 ? 0 : 1) + "B";
      }
      if (abs >= 1000000) {
        return (value / 1000000).toFixed(abs >= 10000000 ? 0 : 1) + "M";
      }
      if (abs >= 10000) {
        return (value / 1000).toFixed(abs >= 100000 ? 0 : 1) + "K";
      }
      return String(Math.round(value));
    }
    const pct = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 + "%" : "-";
    const rangeLabel = (range) => range === "7d" ? "近 7 天" : range === "30d" ? "近 30 天" : range === "all" ? "总计" : "近 24h";
    const formatDate = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "暂无";
    const getUsage = () => state.usage?.summary || {};
    const getTotals = () => getUsage().totals || {};
    function emptyUsageCounters() {
      return { requestCount: 0, successCount: 0, failureCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
    }
    function addUsageCounters(left, right = {}) {
      return {
        requestCount: (left.requestCount || 0) + (right.requestCount || 0),
        successCount: (left.successCount || 0) + (right.successCount || 0),
        failureCount: (left.failureCount || 0) + (right.failureCount || 0),
        totalLatencyMs: (left.totalLatencyMs || 0) + (right.totalLatencyMs || 0),
        inputTokens: (left.inputTokens || 0) + (right.inputTokens || 0),
        outputTokens: (left.outputTokens || 0) + (right.outputTokens || 0),
        totalTokens: (left.totalTokens || 0) + (right.totalTokens || 0),
        cachedTokens: (left.cachedTokens || 0) + (right.cachedTokens || 0),
        reasoningTokens: (left.reasoningTokens || 0) + (right.reasoningTokens || 0),
      };
    }
    function setLoginStatus(message, tone = "") {
      $("login-status").textContent = message;
      $("login-status").className = "login-status " + tone;
    }
    function setResolvedUsername(value = "") {
      const input = $("username");
      if (input) {
        input.value = value;
      }
    }
    function readStoredApiKey() {
      try {
        return window.sessionStorage?.getItem(sessionKey) || "";
      } catch {
        return "";
      }
    }
    function storeApiKey(value) {
      try {
        if (value) {
          window.sessionStorage?.setItem(sessionKey, value);
        }
      } catch {
      }
    }
    function clearStoredApiKey() {
      try {
        window.sessionStorage?.removeItem(sessionKey);
      } catch {
      }
    }
    function setLoginLoading(isLoading) {
      const button = $("login-submit");
      button.disabled = isLoading;
      button.classList.toggle("is-loading", isLoading);
      button.querySelector(".button-text").textContent = isLoading ? "正在查询" : "进入查询";
      button.setAttribute("aria-busy", isLoading ? "true" : "false");
    }
    async function fetchJson(url) {
      const response = await fetch(url, { headers: { authorization: "Bearer " + state.apiKey } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error?.message || "查询失败");
      }
      return body.data;
    }
    async function loadAccount(options = {}) {
      if (!state.apiKey) {
        setLoginStatus("请先输入成员 API Key。", "error");
        return;
      }
      const withLoginTransition = options.withLoginTransition === true;
      if (withLoginTransition) {
        setLoginLoading(true);
        setLoginStatus("正在读取账户用量...");
      }
      $("dashboard-refresh").disabled = true;
      try {
        const result = await Promise.all([
          fetchJson("/v1/user/profile"),
          fetchJson("/v1/user/usage/summary?range=" + encodeURIComponent(state.range)),
        ]);
        state.profile = result[0];
        state.usage = result[1];
        if (options.persistSession === true) {
          storeApiKey(state.apiKey);
        }
        setResolvedUsername(state.profile?.consumer?.name || "");
        const loginPage = $("login-page");
        const dashboardPage = $("dashboard-page");
        const shouldTransitionFromLogin = withLoginTransition && !loginPage.hidden;
        const finishDashboardTransition = () => {
          setLoginLoading(false);
          loginPage.hidden = true;
          loginPage.classList.remove("login-success-holding");
          loginPage.classList.remove("login-success-transitioning");
          dashboardPage.classList.remove("dashboard-entering");
        };
        const startDashboardTransition = () => {
          loginPage.classList.remove("login-success-holding");
          loginPage.classList.add("login-success-transitioning");
          dashboardPage.hidden = false;
          dashboardPage.classList.add("dashboard-entering");
          renderDashboard();
          $("dashboard-refresh").disabled = false;
          setTimeout(finishDashboardTransition, 800);
        };
        const showDashboard = () => {
          setLoginLoading(false);
          loginPage.hidden = true;
          loginPage.classList.remove("login-success-holding");
          loginPage.classList.remove("login-success-transitioning");
          dashboardPage.hidden = false;
          dashboardPage.classList.remove("dashboard-entering");
          renderDashboard();
          $("dashboard-refresh").disabled = false;
        };
        if (withLoginTransition) {
          setLoginStatus("账户用量已刷新。", "ok");
        }
        if (shouldTransitionFromLogin) {
          window.__relayGatePublicLoginSuccess?.();
          loginPage.classList.add("login-success-holding");
          setTimeout(startDashboardTransition, 1500);
        } else {
          showDashboard();
        }
      } catch (error) {
        if (options.clearSessionOnFailure === true) {
          clearStoredApiKey();
          state.apiKey = "";
          $("api-key").value = "";
        }
        setResolvedUsername("");
        setLoginStatus(error.message || "查询失败", "error");
        if (withLoginTransition) {
          window.__relayGatePublicLoginFailed?.();
          setLoginLoading(false);
        }
        $("dashboard-refresh").disabled = false;
      }
    }
    function getSuccessRate(counters) {
      return counters.requestCount > 0 ? (counters.successCount || 0) / counters.requestCount * 100 : undefined;
    }
    function getLatency(counters) {
      return counters.successCount > 0 ? Math.round((counters.totalLatencyMs || 0) / counters.successCount) : 0;
    }
    function getHealthScore(counters) {
      const failureRate = counters.requestCount > 0 ? (counters.failureCount || 0) / counters.requestCount : 0;
      const latencyPenalty = getLatency(counters) > 5000 ? 16 : getLatency(counters) > 2000 ? 8 : 0;
      return clamp(Math.round(100 - failureRate * 45 - latencyPenalty), 0, 100);
    }
    function getHealthTone(score) {
      return score >= 85 ? "success" : score >= 70 ? "active" : score >= 50 ? "warning" : "danger";
    }
    function getHealthLabel(score) {
      return score >= 85 ? "健康" : score >= 70 ? "可关注" : score >= 50 ? "风险" : "严重";
    }
    function renderDashboard() {
      const profile = state.profile || {};
      const keyLabel = (profile.accessKey?.keyPrefix || "") + "..." + (profile.accessKey?.keySuffix || "");
      const memberName = profile.consumer?.name || "当前成员";
      $("sidebar-member").textContent = memberName;
      $("sidebar-key").textContent = keyLabel;
      $("usage-trend-chart").innerHTML = renderUsageOperationsDashboard();
      $("usage-period-summary").innerHTML = renderUsagePeriodSummary();
      $("usage-dimension-insights").innerHTML = renderUsageDimensionInsights();
      requestAnimationFrame(() => renderUsageEChartsDashboard());
    }
    function renderUsageOperationsDashboard() {
      return '<div id="usage-operations-dashboard" class="usage-operations-dashboard">' +
        '<div class="usage-operations-wide">' + renderUsageChartDataHint() + '</div>' +
        '<div class="usage-operations-health">' + renderUsageMemberHealthCard() + '</div>' +
        '<div class="usage-operations-wide">' + renderUsageMemberHealthMatrix() + '</div>' +
        '<div class="usage-operations-main"><div class="usage-echart-card usage-echart-card-large"><div class="usage-chart-section-header"><div><strong>Token 用量趋势</strong><span>成员观测 · 当前成员 · ' + esc(rangeLabel(state.range)) + '</span></div><span class="badge neutral">ECharts · 可缩放</span></div>' + renderUsageTrendMetricStats() + '<div id="usage-echart-trend" class="usage-echart usage-echart-trend">' + renderUsageTokenTrendLine() + '</div></div></div>' +
        '<div class="usage-operations-breakdown"><div class="usage-echart-card usage-echart-card-ranking"><div class="usage-chart-section-header"><div><strong>模型排行</strong><span>按当前时间窗口统计，聚焦该成员相关 Key 与走势</span></div><span class="badge neutral">Bar</span></div><div id="usage-echart-ranking" class="usage-echart usage-echart-ranking">' + renderUsageRankingBars() + '</div></div><div class="usage-echart-card usage-echart-card-mix"><div class="usage-chart-section-header"><div><strong>Token 构成</strong><span>输入、输出、缓存和思考 Token 占比</span></div><span class="badge neutral">Donut</span></div><div id="usage-echart-mix" class="usage-echart usage-echart-mix">' + renderUsageTokenMixDonut() + '</div></div></div>' +
        '<div class="usage-operations-card"><div class="usage-echart-card"><div class="usage-chart-section-header"><div><strong>请求结果</strong><span>成功 / 失败请求占比，用于快速定位异常窗口</span></div><span class="badge neutral">Donut</span></div><div id="usage-echart-outcome" class="usage-echart usage-echart-outcome">' + renderUsageOutcomeBars() + '</div></div></div>' +
        '<div class="usage-operations-card"><div class="usage-echart-card"><div class="usage-chart-section-header"><div><strong>延迟与稳定性</strong><span>平均延迟、请求量和失败压力的组合观察</span></div><span class="badge neutral">Bar</span></div><div id="usage-echart-latency" class="usage-echart usage-echart-latency">' + renderUsageLatencySnapshot() + '</div></div></div>' +
        '<div class="usage-operations-wide">' + renderUsageScopeMatrix() + '</div></div>';
    }
    function renderUsageChartDataHint() {
      const summary = getUsage();
      const counters = getTotals();
      const message = counters.requestCount > 0 ? "当前看板基于 " + rangeLabel(state.range) + " 的本地持久化用量事件聚合。" : "当前筛选条件下暂无请求记录。";
      const updated = summary.updatedAt ? " 数据更新时间：" + formatDate(summary.updatedAt) + "。" : "";
      return '<div class="usage-data-hint"><span>' + esc(message + updated) + '</span></div>';
    }
    function renderUsageMemberHealthCard() {
      const profile = state.profile || {};
      const summary = getUsage();
      const counters = getTotals();
      const score = getHealthScore(counters);
      const tone = getHealthTone(score);
      const latestActiveAt = Math.max(0, ...(summary.consumers || []).map((item) => item.updatedAt || 0), summary.updatedAt || 0);
      const reasons = [
        counters.requestCount > 0 ? "请求 " + fmt(counters.requestCount) + " 次" : "暂无请求",
        "成功率 " + pct(getSuccessRate(counters)),
        (counters.failureCount || 0) > 0 ? "失败 " + fmt(counters.failureCount) + " 次" : "无失败请求",
        "近 7 天无成员告警",
      ];
      return '<div class="usage-member-health-card tone-' + esc(tone) + '"><div class="usage-member-health-main"><span class="usage-health-badge tone-' + esc(tone) + '">成员健康度</span><strong>' + esc(profile.consumer?.name || "当前成员") + '</strong><p>' + esc(reasons.join(" · ")) + '</p><div class="usage-member-health-metrics"><span>Token ' + esc(fmt(counters.totalTokens || 0)) + '</span><span>平均延迟 ' + esc(formatLatency(counters)) + '</span><span title="' + esc(formatDate(latestActiveAt)) + '">最近活跃 ' + esc(latestActiveAt ? formatDate(latestActiveAt) : "暂无") + '</span><span>告警 0</span></div></div><div class="usage-member-health-score tone-' + esc(tone) + '"><strong>' + esc(String(score)) + '</strong><span>' + esc(getHealthLabel(score)) + '</span></div></div>';
    }
    function renderUsageMemberHealthMatrix() {
      const profile = state.profile || {};
      const summary = getUsage();
      const counters = getTotals();
      const score = getHealthScore(counters);
      const tone = getHealthTone(score);
      const latestActiveAt = Math.max(0, ...(summary.consumers || []).map((item) => item.updatedAt || 0), summary.updatedAt || 0);
      return '<div class="usage-member-health-matrix"><div class="usage-chart-section-header"><div><strong>成员健康矩阵</strong><span>单成员版保留桌面端矩阵结构，只展示当前 Key 对应成员。</span></div><span class="badge neutral">Top 1</span></div><div class="usage-member-health-table"><div class="usage-member-health-head"><span>成员</span><span>健康分</span><span>Token / 请求</span><span>失败</span><span>告警</span><span>最近活跃</span></div><button class="usage-member-health-row" type="button"><span><strong>' + esc(profile.consumer?.name || "当前成员") + '</strong><small>近 7 天无告警</small></span><span class="usage-health-score-pill tone-' + esc(tone) + '">' + esc(String(score)) + ' · ' + esc(getHealthLabel(score)) + '</span><span>' + esc(fmt(counters.totalTokens || 0)) + ' / ' + esc(fmt(counters.requestCount || 0)) + '</span><span>' + esc(fmt(counters.failureCount || 0)) + '</span><span>0</span><span>' + esc(latestActiveAt ? formatDate(latestActiveAt) : "暂无") + '</span></button></div></div>';
    }
    function renderUsageTrendMetricStats() {
      const points = getTrendPoints();
      const values = points.map((point) => point.usage?.totalTokens || 0);
      const peak = Math.max(...values, 0);
      const total = values.reduce((sum, value) => sum + value, 0);
      const average = values.length ? Math.round(total / values.length) : 0;
      const latest = [...values].reverse().find((value) => value > 0) || 0;
      const latestPoint = [...points].reverse().find((point) => (point.usage?.totalTokens || 0) > 0);
      const items = [
        ["峰值", fmt(peak) + " Token", peak > 0 ? "当前窗口最高点" : "暂无峰值"],
        ["窗口合计", fmt(total) + " Token", rangeLabel(state.range)],
        ["桶均值", fmt(average) + " Token", fmt(values.length) + " 个时间桶"],
        ["最新非零", fmt(latest) + " Token", latestPoint ? formatAxisLabel(latestPoint.bucketStart) : "暂无非零点"],
      ];
      return '<div class="usage-trend-stat-grid">' + items.map((item) => '<div class="usage-trend-stat"><small>' + esc(item[0]) + '</small><strong>' + esc(item[1]) + '</strong><span>' + esc(item[2]) + '</span></div>').join("") + '</div>';
    }
    function getTrendPoints() {
      const summary = getUsage();
      const timelineWindow = state.range === "24h"
        ? { bucketMs: 60 * 60 * 1000, count: 24 }
        : state.range === "7d"
          ? { bucketMs: 24 * 60 * 60 * 1000, count: 7 }
          : state.range === "30d"
            ? { bucketMs: 24 * 60 * 60 * 1000, count: 30 }
            : undefined;
      if (!timelineWindow) {
        return [];
      }
      const merged = new Map();
      const pushTimeline = (timeline) => {
        (timeline || []).forEach((point) => {
          const bucketStart = Math.floor(Number(point.bucketStart || 0) / timelineWindow.bucketMs) * timelineWindow.bucketMs;
          const current = merged.get(bucketStart) || emptyUsageCounters();
          merged.set(bucketStart, addUsageCounters(current, point.usage));
        });
      };
      pushTimeline(summary.consumerTimeline);
      const currentBucket = Math.floor(Date.now() / timelineWindow.bucketMs) * timelineWindow.bucketMs;
      const firstBucketStart = currentBucket - (timelineWindow.count - 1) * timelineWindow.bucketMs;
      return Array.from({ length: timelineWindow.count }, (_, index) => {
        const bucketStart = firstBucketStart + index * timelineWindow.bucketMs;
        return { bucketStart, usage: merged.get(bucketStart) || emptyUsageCounters() };
      });
    }
    function renderUsageTokenTrendLine() {
      const points = getTrendPoints();
      if (!points.length || points.every((point) => (point.usage?.totalTokens || 0) <= 0)) {
        return '<div class="empty-card">当前视角暂无趋势曲线</div>';
      }
      const width = 720;
      const height = 220;
      const paddingX = 24;
      const paddingY = 18;
      const maxValue = Math.max(...points.map((point) => point.usage?.totalTokens || 0), 1);
      const coords = points.map((point, index) => {
        const x = paddingX + (index / Math.max(points.length - 1, 1)) * (width - paddingX * 2);
        const y = height - paddingY - ((point.usage?.totalTokens || 0) / maxValue) * (height - paddingY * 2);
        return { x, y, point };
      });
      const polyline = coords.map((item) => item.x.toFixed(1) + "," + item.y.toFixed(1)).join(" ");
      return '<div class="usage-line-chart"><div class="usage-chart-section-header"><div><strong>Token 消耗走势</strong><span>成员观测 · ' + esc(rangeLabel(state.range)) + '</span></div><span class="badge neutral">曲线图</span></div><svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Token 消耗走势曲线"><polyline class="usage-line-grid" points="' + paddingX + ',' + (height - paddingY) + ' ' + (width - paddingX) + ',' + (height - paddingY) + '"></polyline><polyline class="usage-line-series" points="' + esc(polyline) + '"></polyline>' + coords.filter((item) => (item.point.usage?.totalTokens || 0) > 0).map((item) => '<circle class="usage-line-point" cx="' + item.x.toFixed(1) + '" cy="' + item.y.toFixed(1) + '" r="3.5"><title>' + esc(fmt(item.point.usage?.totalTokens || 0) + " Token") + '</title></circle>').join("") + '</svg><div class="usage-chart-legend"><span>总量：' + esc(fmt(getTotals().totalTokens || 0)) + ' Token</span></div></div>';
    }
    function renderUsageRankingBars() {
      const rows = (getUsage().models || []).filter((row) => (row.usage?.totalTokens || 0) > 0 || (row.usage?.requestCount || 0) > 0).sort((left, right) => (right.usage?.totalTokens || 0) - (left.usage?.totalTokens || 0)).slice(0, 8);
      if (!rows.length) {
        return '<div class="empty-card">当前视角暂无排行数据</div>';
      }
      const max = Math.max(...rows.map((row) => row.usage?.totalTokens || 0), 1);
      return '<div class="usage-ranking-chart"><div class="usage-chart-section-header"><div><strong>模型排行</strong><span>按 Token 消耗排序，辅助判断主要成本来源</span></div><span class="badge neutral">柱状图</span></div><div class="usage-ranking-list">' + rows.map((row, index) => { const width = Math.max(4, Math.round(((row.usage?.totalTokens || 0) / max) * 100)); return '<div class="usage-ranking-row"><span class="usage-ranking-index">' + esc(String(index + 1)) + '</span><div class="usage-ranking-main"><div class="usage-ranking-meta"><strong>' + esc(row.modelAlias || "unknown") + '</strong><span>' + esc(fmt(row.usage?.totalTokens || 0)) + ' Token · ' + esc(fmt(row.usage?.requestCount || 0)) + ' 次</span></div><div class="usage-ranking-track"><div class="usage-ranking-bar" style="width: ' + width + '%"></div></div><small>' + esc(row.modelAlias || "unknown") + '</small></div></div>'; }).join("") + '</div></div>';
    }
    function renderUsageTokenMixDonut() {
      const counters = getTotals();
      const input = Math.max(0, counters.inputTokens || 0);
      const output = Math.max(0, counters.outputTokens || 0);
      const cached = Math.max(0, counters.cachedTokens || 0);
      const reasoning = Math.max(0, counters.reasoningTokens || 0);
      const total = Math.max(1, input + output + cached + reasoning);
      const inputEnd = input / total * 100;
      const outputEnd = inputEnd + output / total * 100;
      const cachedEnd = outputEnd + cached / total * 100;
      const rows = [["input", "输入", input], ["output", "输出", output], ["cached", "缓存", cached], ["reasoning", "思考", reasoning]];
      return '<div class="usage-donut-chart"><div class="usage-chart-section-header"><div><strong>Token 构成</strong><span>输入、输出、缓存和思考 Token 的窗口占比</span></div><span class="badge neutral">饼图</span></div><div class="usage-donut-body"><div class="usage-donut-visual" style="--input-end: ' + inputEnd.toFixed(2) + '%; --output-end: ' + outputEnd.toFixed(2) + '%; --cached-end: ' + cachedEnd.toFixed(2) + '%;"><strong>' + esc(fmt(counters.totalTokens || 0)) + '</strong><span>Total</span></div><div class="usage-donut-legend">' + rows.map((row) => '<div class="usage-donut-legend-row"><span class="usage-donut-dot ' + esc(row[0]) + '"></span><strong>' + esc(row[1]) + '</strong><span>' + esc(fmt(row[2])) + '</span></div>').join("") + '</div></div></div>';
    }
    function renderUsageOutcomeBars() {
      const counters = getTotals();
      const success = Math.max(0, counters.successCount || 0);
      const failure = Math.max(0, counters.failureCount || 0);
      const total = Math.max(1, success + failure);
      const successWidth = Math.round(success / total * 100);
      const failureWidth = Math.round(failure / total * 100);
      return '<div class="usage-outcome-chart"><div class="usage-chart-section-header"><div><strong>请求结果</strong><span>成功 / 失败请求占比，用于快速定位异常窗口</span></div><span class="badge neutral">堆叠条</span></div><div class="usage-outcome-track" role="img" aria-label="请求成功失败占比"><div class="usage-outcome-segment success" style="width: ' + successWidth + '%"></div><div class="usage-outcome-segment failure" style="width: ' + failureWidth + '%"></div></div><div class="usage-chart-legend"><span>成功：' + esc(fmt(success)) + ' · ' + esc(pct(getSuccessRate(counters))) + '</span><span>失败：' + esc(fmt(failure)) + '</span></div></div>';
    }
    function formatLatency(counters) {
      return counters.successCount > 0 ? fmt(Math.round((counters.totalLatencyMs || 0) / counters.successCount)) + "ms" : "0ms";
    }
    function renderUsageLatencySnapshot() {
      const counters = getTotals();
      const averageLatency = counters.successCount > 0 ? (counters.totalLatencyMs || 0) / counters.successCount : 0;
      const rows = [["< 1s", Math.max(0, 1000 - averageLatency), "success"], ["平均", averageLatency, "primary"], ["失败量", (counters.failureCount || 0) * 100, "warning"]];
      const max = Math.max(...rows.map((item) => item[1]), 1);
      return '<div class="usage-latency-chart"><div class="usage-chart-section-header"><div><strong>延迟与稳定性</strong><span>把平均延迟和失败压力放在同一观察区</span></div><span class="badge neutral">健康条</span></div><div class="usage-mini-bar-list">' + rows.map((item) => '<div class="usage-mini-bar-row"><span>' + esc(item[0]) + '</span><div class="usage-mini-bar-track"><div class="usage-mini-bar ' + esc(item[2]) + '" style="width: ' + Math.max(6, Math.round(item[1] / max * 100)) + '%"></div></div></div>').join("") + '</div><div class="usage-chart-legend"><span>平均延迟：' + esc(formatLatency(counters)) + '</span><span>请求：' + esc(fmt(counters.requestCount || 0)) + '</span></div></div>';
    }
    function renderUsageScopeMatrix() {
      const profile = state.profile || {};
      const summary = getUsage();
      const items = [["成员", 1, profile.consumer?.type || "consumer"], ["Access Key", 1, profile.accessKey?.status || "key"], ["号池", (summary.pools || []).length, "pool"], ["模型", (summary.models || []).length, "model"]];
      return '<div class="usage-scope-matrix"><div class="usage-chart-section-header"><div><strong>归因覆盖</strong><span>当前窗口已有数据的业务维度覆盖情况</span></div><span class="badge neutral">矩阵</span></div><div class="usage-scope-grid">' + items.map((item) => '<div class="usage-scope-cell"><small>' + esc(item[0]) + '</small><strong>' + esc(fmt(item[1])) + '</strong><span>' + esc(item[2]) + '</span></div>').join("") + '</div></div>';
    }
    function renderUsagePeriodSummary() {
      const counters = getTotals();
      const windows = [
        ["24h", "近 24h", "近期运行"],
        ["7d", "近 7 天", "短期运营"],
        ["30d", "近 30 天", "月度观察"],
        ["all", "总计", "长期沉淀"],
      ];
      return windows.map((item) => '<button class="usage-period-card" data-window="' + esc(item[0]) + '" data-active="' + (state.range === item[0] ? "true" : "false") + '" type="button"><span>' + esc(item[1]) + '</span><strong>' + esc(fmt(counters.totalTokens || 0)) + ' Token</strong><small>' + esc(item[2]) + ' · 请求 ' + esc(fmt(counters.requestCount || 0)) + ' · 失败 ' + esc(fmt(counters.failureCount || 0)) + '</small></button>').join("");
    }
    function renderUsageDimensionInsights() {
      const profile = state.profile || {};
      const summary = getUsage();
      const counters = getTotals();
      const topModel = (summary.models || [])[0];
      const topPool = (summary.pools || [])[0];
      const failureRate = counters.requestCount > 0 ? Math.round(((counters.failureCount || 0) / counters.requestCount) * 100) : 0;
      const cards = [
        ["成员用量", profile.consumer?.name || "当前成员", fmt(counters.totalTokens || 0) + " Token · " + fmt(counters.requestCount || 0) + " 次请求"],
        ["账号与号池", topPool?.poolId || "当前授权号池", topPool ? fmt(topPool.usage?.totalTokens || 0) + " Token · " + fmt(topPool.usage?.requestCount || 0) + " 次号池请求" : "当前 Key 只展示已授权号池维度。"],
        ["模型分布", topModel?.modelAlias || "暂无模型请求", topModel ? fmt(topModel.usage?.totalTokens || 0) + " Token · " + fmt(topModel.usage?.requestCount || 0) + " 次请求" : "模型别名统计会随请求自动积累。"],
        ["失败与限流", (counters.failureCount || 0) > 0 ? fmt(counters.failureCount || 0) + " 次失败" : "暂无失败", "成功率 " + pct(getSuccessRate(counters)) + " · 失败率 " + failureRate + "%"],
      ];
      return cards.map((card) => '<div class="usage-insight-card"><small>' + esc(card[0]) + '</small><strong>' + esc(card[1]) + '</strong><span>' + esc(card[2]) + '</span></div>').join("");
    }
    const usageChartInstances = new Map();
    function getUsageChartInstance(id) {
      const element = $(id);
      if (!element || !window.echarts) {
        return undefined;
      }
      const existing = usageChartInstances.get(id);
      if (existing?.getDom?.() === element) {
        usageChartInstances.set(id, existing);
        return existing;
      }
      if (existing?.dispose) {
        existing.dispose();
      }
      const domInstance = window.echarts.getInstanceByDom?.(element);
      if (domInstance) {
        usageChartInstances.set(id, domInstance);
        return domInstance;
      }
      element.innerHTML = "";
      const chart = window.echarts.init(element, null, { renderer: "canvas" });
      usageChartInstances.set(id, chart);
      return chart;
    }
    function getUsageChartPalette() {
      return ["#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4"];
    }
    function buildUsageChartEmptyGraphic(message) {
      return {
        type: "text",
        left: "center",
        top: "middle",
        style: { text: message, fill: "#64748b", fontSize: 13, fontWeight: 700, textAlign: "center" },
      };
    }
    function formatAxisLabel(timestamp) {
      const date = new Date(timestamp);
      return state.range === "24h" ? String(date.getHours()).padStart(2, "0") + ":00" : (date.getMonth() + 1) + "/" + date.getDate();
    }
    function buildUsageTrendChartOption() {
      const points = getTrendPoints();
      const hasData = points.some((point) => (point.usage?.totalTokens || 0) > 0);
      return {
        color: getUsageChartPalette(),
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "cross" },
          backgroundColor: "rgba(15, 23, 42, 0.92)",
          borderWidth: 0,
          textStyle: { color: "#f8fafc" },
        },
        legend: { top: 0, right: 8, itemWidth: 10, itemHeight: 10, textStyle: { color: "#64748b", fontSize: 11 } },
        grid: { left: 48, right: 24, top: 42, bottom: 52 },
        xAxis: { type: "category", boundaryGap: false, data: points.map((point) => formatAxisLabel(point.bucketStart)), axisLabel: { color: "#64748b" }, axisLine: { lineStyle: { color: "#cbd5e1" } } },
        yAxis: { type: "value", name: "Token", nameTextStyle: { color: "#64748b" }, axisLabel: { color: "#64748b" }, splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } } },
        dataZoom: [
          { type: "inside", xAxisIndex: [0], filterMode: "filter", zoomOnMouseWheel: true, moveOnMouseMove: true, start: usageTrendZoomState.start, end: usageTrendZoomState.end },
          { type: "slider", xAxisIndex: [0], filterMode: "filter", height: 20, bottom: 16, borderColor: "transparent", fillerColor: "rgba(37, 99, 235, 0.16)", handleStyle: { color: "#2563eb" }, start: usageTrendZoomState.start, end: usageTrendZoomState.end },
        ],
        series: [
          { name: "总 Token", type: "line", smooth: true, symbol: "circle", symbolSize: 6, areaStyle: { opacity: 0.12 }, lineStyle: { width: 3 }, data: points.map((point) => point.usage?.totalTokens || 0), tooltip: { valueFormatter: (value) => fmt(Number(value)) + " Token" } },
          { name: "输入", type: "line", smooth: true, symbol: "none", lineStyle: { width: 1.8 }, data: points.map((point) => point.usage?.inputTokens || 0), tooltip: { valueFormatter: (value) => fmt(Number(value)) + " Token" } },
          { name: "输出", type: "line", smooth: true, symbol: "none", lineStyle: { width: 1.8 }, data: points.map((point) => point.usage?.outputTokens || 0), tooltip: { valueFormatter: (value) => fmt(Number(value)) + " Token" } },
          { name: "请求数", type: "bar", yAxisIndex: 0, barMaxWidth: 12, itemStyle: { opacity: 0.22 }, data: points.map((point) => point.usage?.requestCount || 0), tooltip: { valueFormatter: (value) => fmt(Number(value)) + " 次" } },
        ],
        graphic: hasData ? undefined : buildUsageChartEmptyGraphic("当前视角暂无趋势曲线"),
      };
    }
    function buildUsageRankingChartOption() {
      const rows = (getUsage().models || []).filter((row) => (row.usage?.totalTokens || 0) > 0 || (row.usage?.requestCount || 0) > 0).sort((left, right) => (right.usage?.totalTokens || 0) - (left.usage?.totalTokens || 0)).slice(0, 10).reverse();
      return {
        color: ["#2563eb"],
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: "rgba(15, 23, 42, 0.92)", borderWidth: 0, textStyle: { color: "#f8fafc" } },
        grid: { left: 112, right: 28, top: 18, bottom: 28 },
        xAxis: { type: "value", name: "Token", nameTextStyle: { color: "#64748b" }, axisLabel: { color: "#64748b" }, splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } } },
        yAxis: { type: "category", data: rows.map((row) => row.modelAlias || "unknown"), axisLabel: { color: "#334155", width: 104, overflow: "truncate" }, axisTick: { show: false }, axisLine: { show: false } },
        series: [{ name: "Token", type: "bar", barMaxWidth: 18, itemStyle: { borderRadius: [0, 8, 8, 0], color: { type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: "#60a5fa" }, { offset: 1, color: "#2563eb" }] } }, data: rows.map((row) => row.usage?.totalTokens || 0) }],
        graphic: rows.length ? undefined : buildUsageChartEmptyGraphic("当前视角暂无排行数据"),
      };
    }
    function buildUsageTokenMixChartOption() {
      const counters = getTotals();
      const data = [
        { name: "输入", value: counters.inputTokens || 0 },
        { name: "输出", value: counters.outputTokens || 0 },
        { name: "缓存", value: counters.cachedTokens || 0 },
        { name: "思考", value: counters.reasoningTokens || 0 },
      ];
      const hasData = data.some((item) => item.value > 0);
      return {
        color: getUsageChartPalette(),
        tooltip: { trigger: "item", formatter: "{b}<br/>{c} Token ({d}%)", backgroundColor: "rgba(15, 23, 42, 0.92)", borderWidth: 0, textStyle: { color: "#f8fafc" } },
        legend: { bottom: 0, left: "center", textStyle: { color: "#64748b", fontSize: 11 } },
        series: [{ name: "Token 构成", type: "pie", radius: ["52%", "76%"], center: ["50%", "42%"], avoidLabelOverlap: true, label: { formatter: "{b}\\n{d}%", color: "#334155" }, data: hasData ? data.filter((item) => item.value > 0) : [] }],
        graphic: hasData ? { type: "text", left: "center", top: "39%", style: { text: fmt(counters.totalTokens || 0), fill: "#0f172a", fontSize: 20, fontWeight: 700, textAlign: "center" } } : buildUsageChartEmptyGraphic("当前视角暂无 Token 构成"),
      };
    }
    function buildUsageOutcomeChartOption() {
      const counters = getTotals();
      const success = Math.max(0, counters.successCount || 0);
      const failure = Math.max(0, counters.failureCount || 0);
      const total = success + failure;
      const successRate = total > 0 ? Math.round((success / total) * 100) : 0;
      const data = [{ name: "成功", value: success, itemStyle: { color: "#10b981" } }, { name: "失败", value: failure, itemStyle: { color: "#ef4444" } }].filter((item) => item.value > 0);
      return {
        tooltip: { trigger: "item", formatter: "{b}<br/>{c} 次 ({d}%)", backgroundColor: "rgba(15, 23, 42, 0.92)", borderWidth: 0, textStyle: { color: "#f8fafc" } },
        legend: { bottom: 0, left: "center", textStyle: { color: "#64748b", fontSize: 11 } },
        series: [{ name: "请求结果", type: "pie", radius: ["58%", "78%"], center: ["50%", "43%"], avoidLabelOverlap: true, label: { formatter: "{b}\\n{d}%", color: "#334155" }, data }],
        graphic: total > 0 ? { type: "text", left: "center", top: "40%", style: { text: successRate + "%", fill: successRate >= 95 ? "#047857" : successRate >= 80 ? "#b45309" : "#b91c1c", fontSize: 24, fontWeight: 800, textAlign: "center" } } : buildUsageChartEmptyGraphic("当前视角暂无请求结果"),
      };
    }
    function buildUsageLatencyChartOption() {
      const counters = getTotals();
      const averageLatency = counters.successCount > 0 ? Math.round((counters.totalLatencyMs || 0) / counters.successCount) : 0;
      const failureRate = counters.requestCount > 0 ? Math.round(((counters.failureCount || 0) / counters.requestCount) * 100) : 0;
      const hasData = counters.requestCount > 0;
      return {
        color: ["#2563eb", "#f59e0b", "#ef4444"],
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: "rgba(15, 23, 42, 0.92)", borderWidth: 0, textStyle: { color: "#f8fafc" } },
        grid: { left: 80, right: 22, top: 18, bottom: 28 },
        xAxis: { type: "value", axisLabel: { color: "#64748b" }, splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } } },
        yAxis: { type: "category", data: ["请求数", "平均延迟", "失败率"], axisLabel: { color: "#334155" }, axisTick: { show: false }, axisLine: { show: false } },
        series: [{ name: "稳定性", type: "bar", barMaxWidth: 18, label: { show: true, position: "right", color: "#334155", formatter: (params) => { const value = Number(params.value || 0); if (params.dataIndex === 1) return fmt(value) + " ms"; if (params.dataIndex === 2) return value + "%"; return fmt(value) + " 次"; } }, itemStyle: { borderRadius: [0, 8, 8, 0], color: (params) => params.dataIndex === 1 ? "#f59e0b" : params.dataIndex === 2 ? (failureRate >= 10 ? "#ef4444" : "#10b981") : "#2563eb" }, data: [counters.requestCount || 0, averageLatency, failureRate] }],
        graphic: hasData ? undefined : buildUsageChartEmptyGraphic("当前视角暂无延迟与稳定性数据"),
      };
    }
    function renderUsageEChartsDashboard() {
      if (!window.echarts) {
        return;
      }
      getUsageChartInstance("usage-echart-trend")?.setOption(buildUsageTrendChartOption(), true);
      bindUsageTrendWheelZoom();
      getUsageChartInstance("usage-echart-ranking")?.setOption(buildUsageRankingChartOption(), true);
      getUsageChartInstance("usage-echart-mix")?.setOption(buildUsageTokenMixChartOption(), true);
      getUsageChartInstance("usage-echart-outcome")?.setOption(buildUsageOutcomeChartOption(), true);
      getUsageChartInstance("usage-echart-latency")?.setOption(buildUsageLatencyChartOption(), true);
      setTimeout(() => usageChartInstances.forEach((chart) => chart.resize()), 0);
    }
    function bindUsageTrendWheelZoom() {
      const element = $("usage-echart-trend");
      const chart = usageChartInstances.get("usage-echart-trend");
      if (!element || !chart || element.dataset.wheelZoomBound === "true") {
        return;
      }
      element.dataset.wheelZoomBound = "true";
      element.addEventListener("wheel", (event) => {
        if (!getTrendPoints().length) {
          return;
        }
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
        const currentRange = usageTrendZoomState.end - usageTrendZoomState.start;
        const nextRange = clamp(currentRange * (event.deltaY < 0 ? 0.82 : 1.18), 8, 100);
        if (nextRange >= 99.5) {
          usageTrendZoomState.start = 0;
          usageTrendZoomState.end = 100;
        } else {
          const center = usageTrendZoomState.start + currentRange * ratio;
          usageTrendZoomState.start = clamp(center - nextRange * ratio, 0, 100 - nextRange);
          usageTrendZoomState.end = usageTrendZoomState.start + nextRange;
        }
        chart.dispatchAction({ type: "dataZoom", dataZoomIndex: 0, start: usageTrendZoomState.start, end: usageTrendZoomState.end });
        chart.dispatchAction({ type: "dataZoom", dataZoomIndex: 1, start: usageTrendZoomState.start, end: usageTrendZoomState.end });
      }, { passive: false });
    }
    function updateWindowChips(nextRange) {
      state.range = nextRange;
      usageTrendZoomState.start = 0;
      usageTrendZoomState.end = 100;
      usageTrendZoomState.range = nextRange;
      document.querySelectorAll("[data-window]").forEach((button) => {
        button.dataset.active = button.dataset.window === nextRange ? "true" : "false";
      });
    }
    function bindAnimatedLogin() {
      const input = $("api-key");
      const usernameInput = $("username");
      const formInputs = [input, usernameInput].filter(Boolean);
      const container = $("animated-characters");
      const characters = {
        purple: document.querySelector(".purple-character"),
        black: document.querySelector(".black-character"),
        orange: document.querySelector(".orange-character"),
        yellow: document.querySelector(".yellow-character"),
      };
      const centers = { purple: { x: 0, y: 0 }, black: { x: 0, y: 0 }, orange: { x: 0, y: 0 }, yellow: { x: 0, y: 0 } };
      const positions = { purple: {}, black: {}, orange: {}, yellow: {} };
      let hasEntered = false;
      let pendingMouseX = 0;
      let pendingMouseY = 0;
      let needsUpdate = false;
      let showPassword = false;
      let isTyping = false;
      let loginFailed = false;
      let loginSuccess = false;
      let purplePeeking = false;
      let rafId;
      function updateCenters() {
        Object.entries(characters).forEach(([key, node]) => {
          if (!node) return;
          const rect = node.getBoundingClientRect();
          centers[key] = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 3 };
        });
      }
      function calculatePosition(centerX, centerY, mx, my, rangeX = 15, rangeY = 10, minX = null, maxX = null, minY = null, maxY = null) {
        const rMinX = minX !== null ? minX : -rangeX;
        const rMaxX = maxX !== null ? maxX : rangeX;
        const rMinY = minY !== null ? minY : -rangeY;
        const rMaxY = maxY !== null ? maxY : rangeY;
        const deltaX = mx - centerX;
        const deltaY = my - centerY;
        const scaleX = Math.max(Math.abs(rMinX), Math.abs(rMaxX));
        const scaleY = Math.max(Math.abs(rMinY), Math.abs(rMaxY));
        return {
          faceX: clamp(deltaX / (300 / scaleX), rMinX, rMaxX),
          faceY: clamp(deltaY / (300 / scaleY), rMinY, rMaxY),
          bodySkew: clamp(-deltaX / 120, -6, 6),
        };
      }
      function setEyeLook(selector, x, y) {
        document.querySelectorAll(selector).forEach((node) => {
          node.style.setProperty("--pupil-x", x + "px");
          node.style.setProperty("--pupil-y", y + "px");
        });
      }
      function lookAtMouse(node, mx, my, maxDistance) {
        const rect = node.getBoundingClientRect();
        const dx = mx - (rect.left + rect.width / 2);
        const dy = my - (rect.top + rect.height / 2);
        const distance = Math.min(Math.sqrt(dx ** 2 + dy ** 2), maxDistance);
        const angle = Math.atan2(dy, dx);
        node.style.setProperty("--pupil-x", (Math.cos(angle) * distance).toFixed(2) + "px");
        node.style.setProperty("--pupil-y", (Math.sin(angle) * distance).toFixed(2) + "px");
      }
      function applyCharacterState() {
        const passwordLength = input.value.length;
        const hidingPassword = passwordLength > 0 && !showPassword;
        const lookingAtEachOther = isTyping && passwordLength > 0 && !showPassword;
        const p = positions.purple;
        const b = positions.black;
        const o = positions.orange;
        const y = positions.yellow;
        characters.purple.style.setProperty("--purple-height", (isTyping || hidingPassword) ? "440px" : "400px");
        characters.purple.style.setProperty("--purple-transform", showPassword && passwordLength > 0 ? "skewX(0deg)" : (isTyping || hidingPassword) ? "skewX(" + ((p.bodySkew || 0) - 12) + "deg) translateX(40px)" : "skewX(" + (p.bodySkew || 0) + "deg)");
        characters.black.style.setProperty("--black-transform", showPassword && passwordLength > 0 ? "skewX(0deg)" : lookingAtEachOther ? "skewX(" + ((b.bodySkew || 0) * 1.5 + 10) + "deg) translateX(20px)" : (isTyping || hidingPassword) ? "skewX(" + ((b.bodySkew || 0) * 1.5) + "deg)" : "skewX(" + (b.bodySkew || 0) + "deg)");
        characters.orange.style.setProperty("--orange-transform", showPassword && passwordLength > 0 ? "skewX(0deg)" : "skewX(" + (o.bodySkew || 0) + "deg)");
        characters.yellow.style.setProperty("--yellow-transform", showPassword && passwordLength > 0 ? "skewX(0deg)" : "skewX(" + (y.bodySkew || 0) + "deg)");
        const purpleEyes = loginSuccess ? [74, 18] : showPassword && passwordLength > 0 ? [50, 20] : lookingAtEachOther ? [85, 50] : [75 + (p.faceX || 0), 25 + (p.faceY || 0)];
        const blackEyes = loginFailed ? [26, 66] : loginSuccess ? [26, 20] : showPassword && passwordLength > 0 ? [10, 28] : lookingAtEachOther ? [32, 12] : [26 + (b.faceX || 0), 32 + (b.faceY || 0)];
        const orangeEyes = showPassword && passwordLength > 0 ? [80, 55] : [112 + (o.faceX || 0), 60 + (o.faceY || 0)];
        const yellowEyes = showPassword && passwordLength > 0 ? [20, 35] : [52 + (y.faceX || 0), 40 + (y.faceY || 0)];
        characters.purple.style.setProperty("--purple-eyes-left", purpleEyes[0] + "px");
        characters.purple.style.setProperty("--purple-eyes-top", purpleEyes[1] + "px");
        characters.black.style.setProperty("--black-eyes-left", blackEyes[0] + "px");
        characters.black.style.setProperty("--black-eyes-top", blackEyes[1] + "px");
        characters.orange.style.setProperty("--orange-eyes-left", orangeEyes[0] + "px");
        characters.orange.style.setProperty("--orange-eyes-top", orangeEyes[1] + "px");
        characters.yellow.style.setProperty("--yellow-eyes-left", yellowEyes[0] + "px");
        characters.yellow.style.setProperty("--yellow-eyes-top", yellowEyes[1] + "px");
        characters.purple.style.setProperty("--purple-mouth-left", (showPassword && passwordLength > 0 ? 72 : lookingAtEachOther ? 106 : 97 + (p.faceX || 0)) + "px");
        characters.purple.style.setProperty("--purple-mouth-top", (showPassword && passwordLength > 0 ? 57 : lookingAtEachOther ? 82 : 57 + (p.faceY || 0)) + "px");
        characters.orange.style.setProperty("--orange-mouth-left", (showPassword && passwordLength > 0 ? 94 : 126 + (o.faceX || 0)) + "px");
        characters.orange.style.setProperty("--orange-mouth-top", (showPassword && passwordLength > 0 ? 87 : 92 + (o.faceY || 0)) + "px");
        characters.yellow.style.setProperty("--yellow-mouth-left", (showPassword && passwordLength > 0 ? 10 : 40 + (y.faceX || 0)) + "px");
        characters.yellow.style.setProperty("--yellow-mouth-top", (showPassword && passwordLength > 0 ? 88 : 88 + (y.faceY || 0)) + "px");
        document.querySelector(".purple-mouth-shape").classList.toggle("purple-mouth-shape--typing", (isTyping || hidingPassword) && !loginFailed && !loginSuccess);
        document.querySelector(".orange-mouth-shape").classList.toggle("orange-mouth-shape--typing", (isTyping || hidingPassword) && !loginFailed && !loginSuccess);
        document.querySelector(".purple-mouth-shape").classList.toggle("purple-mouth-shape--sad", loginFailed);
        document.querySelector(".orange-mouth-shape").classList.toggle("orange-mouth-shape--sad", loginFailed);
        document.querySelector(".purple-mouth-shape").classList.toggle("purple-mouth-shape--happy", loginSuccess);
        document.querySelector(".orange-mouth-shape").classList.toggle("orange-mouth-shape--happy", loginSuccess);
        document.querySelector(".yellow-mouth-path").classList.toggle("yellow-mouth-path--happy", loginSuccess);
        if (loginFailed) {
          setEyeLook('[data-eye="black"] .pupil', 0, 5);
          setEyeLook('[data-eye="purple"] .pupil', -2, 3);
          setEyeLook('[data-eye="orange"]', 1, 4);
          setEyeLook('[data-eye="yellow"]', 0, 4);
        } else if (loginSuccess) {
          setEyeLook('[data-eye="purple"] .pupil', 0, -5);
          setEyeLook('[data-eye="black"] .pupil', 0, -4);
          setEyeLook('[data-eye="orange"]', 0, -5);
          setEyeLook('[data-eye="yellow"]', 0, -5);
        } else if (showPassword && passwordLength > 0) {
          setEyeLook('[data-eye="purple"] .pupil', purplePeeking ? 4 : -4, purplePeeking ? 5 : -4);
          setEyeLook('[data-eye="black"] .pupil', -4, -4);
          setEyeLook('[data-eye="orange"]', -5, -4);
          setEyeLook('[data-eye="yellow"]', -5, -4);
        } else if (lookingAtEachOther) {
          setEyeLook('[data-eye="purple"] .pupil', 3, 4);
          setEyeLook('[data-eye="black"] .pupil', 0, -4);
        }
      }
      function updatePositions() {
        if (needsUpdate && hasEntered) {
          needsUpdate = false;
          positions.purple = calculatePosition(centers.purple.x, centers.purple.y, pendingMouseX, pendingMouseY, 30, 20);
          positions.black = calculatePosition(centers.black.x, centers.black.y, pendingMouseX, pendingMouseY);
          positions.orange = calculatePosition(centers.orange.x, centers.orange.y, pendingMouseX, pendingMouseY, 0, 0, -46, 20, -18, 20);
          positions.yellow = calculatePosition(centers.yellow.x, centers.yellow.y, pendingMouseX, pendingMouseY);
          document.querySelectorAll(".eyeball").forEach((node) => lookAtMouse(node, pendingMouseX, pendingMouseY, node.dataset.eye === "black" ? 4 : 5));
          document.querySelectorAll(".pupil-only").forEach((node) => lookAtMouse(node, pendingMouseX, pendingMouseY, 5));
          applyCharacterState();
        }
        rafId = requestAnimationFrame(updatePositions);
      }
      function scheduleBlink(selector) {
        const node = document.querySelector(selector);
        const run = () => {
          const timeout = Math.random() * 4000 + 3000;
          setTimeout(() => {
            node.querySelectorAll(".eyeball,.pupil-only").forEach((eye) => eye.classList.add("is-blinking"));
            setTimeout(() => {
              node.querySelectorAll(".eyeball,.pupil-only").forEach((eye) => eye.classList.remove("is-blinking"));
              run();
            }, 150);
          }, timeout);
        };
        run();
      }
      function generateConfetti() {
        const containerNode = $("confetti-container");
        const colors = ["#FF6B6B", "#4ECDC4", "#FFE66D", "#A78BFA", "#FF9B6B", "#6BCB77", "#4D96FF"];
        containerNode.innerHTML = Array.from({ length: 120 }, (_, index) => {
          const style = "left:" + Math.random() * 100 + "%;top:-" + (10 + Math.random() * 30) + "%;background:" + colors[index % colors.length] + ";width:" + (4 + Math.random() * 6) + "px;height:" + (8 + Math.random() * 12) + "px;animation-delay:" + Math.random() * 2 + "s;animation-duration:" + (4.5 + Math.random() * 2) + "s;transform:rotate(" + Math.random() * 360 + "deg)";
          return '<span class="confetti-piece" style="' + style + '"></span>';
        }).join("");
        containerNode.hidden = false;
        setTimeout(() => { containerNode.hidden = true; containerNode.innerHTML = ""; }, 8000);
      }
      window.addEventListener("mousemove", (event) => {
        pendingMouseX = event.clientX;
        pendingMouseY = event.clientY;
        needsUpdate = true;
      }, { passive: true });
      window.addEventListener("resize", updateCenters, { passive: true });
      formInputs.forEach((node) => {
        node.addEventListener("focus", () => { isTyping = true; applyCharacterState(); });
        node.addEventListener("blur", () => {
          setTimeout(() => {
            isTyping = formInputs.includes(document.activeElement);
            applyCharacterState();
          }, 0);
        });
        node.addEventListener("input", applyCharacterState);
      });
      window.__relayGatePublicLoginSuccess = () => { loginSuccess = true; generateConfetti(); applyCharacterState(); setTimeout(() => { loginSuccess = false; applyCharacterState(); }, 6000); };
      window.__relayGatePublicLoginFailed = () => { loginFailed = true; document.querySelector(".yellow-mouth-path").classList.add("yellow-mouth-path--wavy"); applyCharacterState(); setTimeout(() => { loginFailed = false; document.querySelector(".yellow-mouth-path").classList.remove("yellow-mouth-path--wavy"); applyCharacterState(); }, 3000); };
      window.__relayGateSetPasswordVisible = (value) => { showPassword = value; applyCharacterState(); };
      setTimeout(() => {
        hasEntered = true;
        Object.values(characters).forEach((node) => node.classList.add("entrance-complete"));
        updateCenters();
        rafId = requestAnimationFrame(updatePositions);
      }, 1400);
      scheduleBlink(".purple-character");
      scheduleBlink(".black-character");
      scheduleBlink(".orange-character");
      scheduleBlink(".yellow-character");
    }
    $("login-form").addEventListener("submit", (event) => {
      event.preventDefault();
      state.apiKey = $("api-key").value.trim();
      if (!state.apiKey) {
        setResolvedUsername("");
        clearStoredApiKey();
      }
      loadAccount({ withLoginTransition: true, persistSession: true, clearSessionOnFailure: true });
    });
    $("dashboard-refresh").addEventListener("click", () => loadAccount({ withLoginTransition: false }));
    $("logout").addEventListener("click", () => {
      state.apiKey = "";
      state.profile = null;
      state.usage = null;
      clearStoredApiKey();
      $("api-key").value = "";
      setResolvedUsername("");
      $("dashboard-page").hidden = true;
      $("dashboard-page").classList.remove("dashboard-entering");
      $("login-page").hidden = false;
      $("login-page").classList.remove("login-success-holding");
      $("login-page").classList.remove("login-success-transitioning");
      setLoginStatus("已退出。请输入 API Key 重新查询。");
    });
    $("toggle-key").addEventListener("click", () => {
      const input = $("api-key");
      input.type = input.type === "password" ? "text" : "password";
      $("toggle-key").textContent = input.type === "password" ? "显示" : "隐藏";
      window.__relayGateSetPasswordVisible?.(input.type === "text");
    });
    $("api-key").addEventListener("input", () => {
      if (!$("api-key").value.trim()) {
        clearStoredApiKey();
        setResolvedUsername("");
      } else if (state.profile) {
        state.profile = null;
        clearStoredApiKey();
        setResolvedUsername("");
      }
    });
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-window]");
      if (!button || button.disabled) {
        return;
      }
      updateWindowChips(button.dataset.window || "24h");
      if (state.apiKey) {
        loadAccount({ withLoginTransition: false });
      }
    });
    const restoredApiKey = readStoredApiKey();
    if (restoredApiKey) {
      state.apiKey = restoredApiKey;
      $("api-key").value = restoredApiKey;
      setLoginStatus("正在恢复登录状态...");
      loadAccount({ withLoginTransition: false, persistSession: true, clearSessionOnFailure: true });
    }
    bindAnimatedLogin();
  </script>
</body>
</html>`;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildCodexWhamUsageResponse(balance: UserBalanceResponse) {
  const total = toFiniteNumber(balance.total);
  const used = toFiniteNumber(balance.used) ?? 0;
  const remaining = toFiniteNumber(balance.balance);
  const resetAt = toFiniteNumber((balance as { reset_at?: unknown }).reset_at);
  const limitWindowSeconds =
    typeof resetAt === "number"
      ? Math.max(0, Math.ceil((resetAt - Date.now()) / 1_000))
      : null;
  const usedPercent =
    typeof total === "number" && total > 0
      ? Math.min(100, Math.max(0, Math.round((used / total) * 100)))
      : 0;
  const limitReached =
    typeof remaining === "number" && typeof total === "number" && remaining <= 0;

  return {
    account_id: balance.consumer_id ?? "gateway-api-key",
    email: balance.access_key_id ? balance.planName.split(" · ")[0] : balance.planName,
    plan_type: "gateway",
    rate_limit: {
      allowed: !limitReached,
      limit_reached: limitReached,
      primary_window:
        typeof total === "number"
          ? {
              limit_window_seconds: limitWindowSeconds,
              reset_after_seconds: limitWindowSeconds,
              reset_at: resetAt ?? null,
              used_percent: usedPercent,
            }
          : null,
      secondary_window: null,
    },
    rate_limit_reached_type: limitReached
      ? { type: "rate_limit_reached", details: balance.quota_mode }
      : null,
    rate_limit_reset_credits: {
      available_count: typeof remaining === "number" ? remaining : 0,
    },
    credits: {
      approx_cloud_messages: null,
      approx_local_messages: null,
      balance: remaining ?? null,
      has_credits: typeof total === "number",
      overage_limit_reached: limitReached,
      unlimited: typeof total !== "number",
    },
    spend_control: {
      individual_limit: total ?? null,
      reached: limitReached,
    },
    user_id: balance.consumer_id ?? null,
    quota_mode: balance.quota_mode,
    unit: balance.unit,
    total,
    used,
    balance: remaining ?? null,
  };
}

function buildCreditGrantsResponse(balance: UserBalanceResponse) {
  const total = toFiniteNumber(balance.total);
  const used = toFiniteNumber(balance.used) ?? 0;
  const remaining = toFiniteNumber(balance.balance);

  return {
    object: "credit_summary",
    unit: balance.unit,
    total_granted: total ?? null,
    total_used: used,
    total_available: remaining ?? null,
    grants: {
      object: "list",
      data: [],
    },
    quota_mode: balance.quota_mode,
    planName: balance.planName,
  };
}

function assertAccessPolicyWithinTotalQuota(
  runtime: GatewayRuntime,
  accessContext: AccessCredentialContext | undefined,
): void {
  const limit = normalizePolicyLimit(
    accessContext?.policy?.quota?.totalTokenLimit,
  );
  if (typeof limit !== "number" || !accessContext) {
    return;
  }

  const usage = runtime.database.getUsageTotalsForAccessConsumer({
    consumerId: accessContext.consumerId,
  });
  if (usage.totalTokens < limit) {
    return;
  }

  throw new GatewayError(
    429,
    "access_policy_total_quota_exceeded",
    "Access consumer total token quota has been exceeded.",
    {
      consumerId: accessContext.consumerId,
      accessKeyId: accessContext.accessKeyId,
      limit,
      usedTokens: usage.totalTokens,
      remainingTokens: 0,
    },
  );
}

function assertAccessPolicyWithinPeriodQuota(
  runtime: GatewayRuntime,
  accessContext: AccessCredentialContext | undefined,
): void {
  if (!accessContext) {
    return;
  }
  const limit = normalizePolicyLimit(
    accessContext.policy?.quota?.periodTokenLimit,
  );
  const window = getAccessPolicyPeriodWindow(accessContext);
  if (typeof limit !== "number" || !window) {
    return;
  }

  const now = Date.now();
  if (now >= window.end) {
    throw new GatewayError(
      403,
      "access_policy_period_expired",
      "Access consumer token period is expired.",
      {
        consumerId: accessContext.consumerId,
        accessKeyId: accessContext.accessKeyId,
        periodDays: window.days,
        periodStartedAt: new Date(window.start).toISOString(),
        periodEndedAt: new Date(window.end).toISOString(),
      },
    );
  }

  const usage = runtime.database.getUsageTotalsForAccessConsumer({
    consumerId: accessContext.consumerId,
    sinceTimestamp: window.start,
  });
  if (usage.totalTokens < limit) {
    return;
  }

  throw new GatewayError(
    429,
    "access_policy_period_quota_exceeded",
    "Access consumer token period quota has been exceeded.",
    {
      consumerId: accessContext.consumerId,
      accessKeyId: accessContext.accessKeyId,
      limit,
      usedTokens: usage.totalTokens,
      remainingTokens: 0,
      periodDays: window.days,
      periodStartedAt: new Date(window.start).toISOString(),
      resetAt: new Date(window.end).toISOString(),
      retryAfterSeconds: Math.max(1, Math.ceil((window.end - now) / 1000)),
    },
  );
}

function assertAccessPolicyWithinRequestLimits(
  runtime: GatewayRuntime,
  accessContext: AccessCredentialContext | undefined,
): void {
  if (!accessContext) {
    return;
  }

  const now = Date.now();
  const requestsPerMinute = normalizePolicyLimit(
    accessContext.policy?.limits?.requestsPerMinute,
  );
  if (typeof requestsPerMinute === "number") {
    const usage = runtime.database.getUsageTotalsForAccessConsumer({
      consumerId: accessContext.consumerId,
      sinceTimestamp: now - 60_000,
    });
    if (usage.requestCount >= requestsPerMinute) {
      throw new GatewayError(
        429,
        "access_policy_rate_limit_exceeded",
        "Access consumer request rate limit has been exceeded.",
        {
          consumerId: accessContext.consumerId,
          accessKeyId: accessContext.accessKeyId,
          limit: requestsPerMinute,
          usedRequests: usage.requestCount,
          windowSeconds: 60,
          retryAfterSeconds: 60,
        },
      );
    }
  }

  const maxConcurrentRequests = normalizePolicyLimit(
    accessContext.policy?.limits?.maxConcurrentRequests,
  );
  if (typeof maxConcurrentRequests === "number") {
    const inFlightRequests = runtime.countInFlightRequestsForAccessConsumer(
      accessContext.consumerId,
    );
    if (inFlightRequests >= maxConcurrentRequests) {
      throw new GatewayError(
        429,
        "access_policy_concurrency_exceeded",
        "Access consumer concurrent request limit has been exceeded.",
        {
          consumerId: accessContext.consumerId,
          accessKeyId: accessContext.accessKeyId,
          limit: maxConcurrentRequests,
          inFlightRequests,
        },
      );
    }
  }
}

function getSerializedByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function flattenRequestTextLength(
  content: string | null | Array<{ type: "text"; text: string }>,
): number {
  if (content === null) {
    return 0;
  }
  if (typeof content === "string") {
    return content.length;
  }
  return content.reduce((sum, item) => sum + item.text.length, 0);
}

function getRequestTextStats(request: ChatCompletionsRequest): {
  totalTextChars: number;
  maxSingleTextChars: number;
  maxToolResultChars: number;
} {
  let totalTextChars = 0;
  let maxSingleTextChars = 0;
  let maxToolResultChars = 0;
  for (const message of request.messages) {
    const length = flattenRequestTextLength(message.content ?? "");
    totalTextChars += length;
    maxSingleTextChars = Math.max(maxSingleTextChars, length);
    if (message.role === "tool") {
      maxToolResultChars = Math.max(maxToolResultChars, length);
    }
  }
  return {
    totalTextChars,
    maxSingleTextChars,
    maxToolResultChars,
  };
}

function estimateRequestInputTokens(request: ChatCompletionsRequest): number {
  const textStats = getRequestTextStats(request);
  const toolSchemaBytes = getSerializedByteLength(request.tools ?? []);
  return Math.ceil((textStats.totalTextChars + toolSchemaBytes) / 4);
}

function assertPublicRequestPayloadWithinLimits(
  accessContext: AccessCredentialContext | undefined,
  request: ChatCompletionsRequest,
  rawBody: unknown,
): void {
  if (accessContext?.consumerType !== "public-user") {
    return;
  }

  const bodyBytes = getSerializedByteLength(rawBody);
  if (bodyBytes > PUBLIC_REQUEST_GUARD_LIMITS.maxBodyBytes) {
    throw new GatewayError(
      413,
      "request_body_limit_exceeded",
      "Public-user request body is too large.",
      {
        consumerId: accessContext.consumerId,
        accessKeyId: accessContext.accessKeyId,
        limitBytes: PUBLIC_REQUEST_GUARD_LIMITS.maxBodyBytes,
        requestBytes: bodyBytes,
      },
    );
  }

  if (request.messages.length > PUBLIC_REQUEST_GUARD_LIMITS.maxMessages) {
    throw new GatewayError(
      413,
      "request_messages_limit_exceeded",
      "Public-user request contains too many messages.",
      {
        consumerId: accessContext.consumerId,
        accessKeyId: accessContext.accessKeyId,
        limit: PUBLIC_REQUEST_GUARD_LIMITS.maxMessages,
        messageCount: request.messages.length,
      },
    );
  }

  const toolCount = request.tools?.length ?? 0;
  if (toolCount > PUBLIC_REQUEST_GUARD_LIMITS.maxTools) {
    throw new GatewayError(
      413,
      "request_tools_limit_exceeded",
      "Public-user request contains too many tool definitions.",
      {
        consumerId: accessContext.consumerId,
        accessKeyId: accessContext.accessKeyId,
        limit: PUBLIC_REQUEST_GUARD_LIMITS.maxTools,
        toolCount,
      },
    );
  }

  const toolSchemaBytes = getSerializedByteLength(request.tools ?? []);
  if (toolSchemaBytes > PUBLIC_REQUEST_GUARD_LIMITS.maxToolSchemaBytes) {
    throw new GatewayError(
      413,
      "request_tool_schema_limit_exceeded",
      "Public-user request tool schema is too large.",
      {
        consumerId: accessContext.consumerId,
        accessKeyId: accessContext.accessKeyId,
        limitBytes: PUBLIC_REQUEST_GUARD_LIMITS.maxToolSchemaBytes,
        toolSchemaBytes,
      },
    );
  }

  const textStats = getRequestTextStats(request);
  if (textStats.maxSingleTextChars > PUBLIC_REQUEST_GUARD_LIMITS.maxSingleTextChars) {
    throw new GatewayError(
      413,
      "request_message_text_limit_exceeded",
      "Public-user request contains an oversized message.",
      {
        consumerId: accessContext.consumerId,
        accessKeyId: accessContext.accessKeyId,
        limitChars: PUBLIC_REQUEST_GUARD_LIMITS.maxSingleTextChars,
        maxTextChars: textStats.maxSingleTextChars,
      },
    );
  }
  if (textStats.maxToolResultChars > PUBLIC_REQUEST_GUARD_LIMITS.maxToolResultChars) {
    throw new GatewayError(
      413,
      "request_tool_result_limit_exceeded",
      "Public-user request contains an oversized tool result.",
      {
        consumerId: accessContext.consumerId,
        accessKeyId: accessContext.accessKeyId,
        limitChars: PUBLIC_REQUEST_GUARD_LIMITS.maxToolResultChars,
        maxToolResultChars: textStats.maxToolResultChars,
      },
    );
  }
}

function assertAccessPolicyTokenLimits(
  accessContext: AccessCredentialContext | undefined,
  request: ChatCompletionsRequest,
): void {
  if (!accessContext) {
    return;
  }

  const maxOutputTokens = resolveEffectiveMaxOutputTokens(accessContext);
  if (
    typeof maxOutputTokens === "number" &&
    typeof request.max_tokens === "number" &&
    request.max_tokens > maxOutputTokens
  ) {
    throw new GatewayError(
      403,
      "access_policy_output_token_limit_exceeded",
      "Requested max_tokens exceeds this access consumer output token limit.",
      {
        consumerId: accessContext.consumerId,
        accessKeyId: accessContext.accessKeyId,
        limit: maxOutputTokens,
        requestedOutputTokens: request.max_tokens,
      },
    );
  }
  if (
    typeof maxOutputTokens === "number" &&
    typeof request.max_tokens !== "number"
  ) {
    request.max_tokens = maxOutputTokens;
  }

  const maxInputTokens = resolveEffectiveMaxInputTokens(accessContext);
  if (typeof maxInputTokens === "number") {
    const estimatedInputTokens = estimateRequestInputTokens(request);
    if (estimatedInputTokens > maxInputTokens) {
      throw new GatewayError(
        403,
        "access_policy_input_token_limit_exceeded",
        "Estimated input tokens exceed this access consumer input token limit.",
        {
          consumerId: accessContext.consumerId,
          accessKeyId: accessContext.accessKeyId,
          limit: maxInputTokens,
          estimatedInputTokens,
        },
      );
    }
  }
}

function resolveEffectiveMaxOutputTokens(
  accessContext: AccessCredentialContext,
): number | undefined {
  const configured = normalizePolicyLimit(
    accessContext.policy?.limits?.maxOutputTokens,
  );
  if (typeof configured === "number" && configured > 0) {
    return configured;
  }
  if (accessContext.consumerType === "public-user") {
    return PUBLIC_REQUEST_GUARD_LIMITS.maxOutputTokens;
  }
  return undefined;
}

function resolveEffectiveMaxInputTokens(
  accessContext: AccessCredentialContext,
): number | undefined {
  const configured = normalizePolicyLimit(
    accessContext.policy?.limits?.maxInputTokens,
  );
  if (typeof configured === "number" && configured > 0) {
    return configured;
  }
  if (accessContext.consumerType === "public-user") {
    return PUBLIC_REQUEST_GUARD_LIMITS.maxEstimatedInputTokens;
  }
  return undefined;
}

function assertAccessPolicyAllowsPool(
  accessContext: AccessCredentialContext | undefined,
  poolId: string | undefined,
  poolSettings: GatewaySessionPoolSettings,
): void {
  const normalizedPoolId = poolId?.trim();
  if (!normalizedPoolId) {
    return;
  }

  const allowedPoolIds = accessContext?.policy?.allowedPoolIds;
  if (allowedPoolIds?.length && !allowedPoolIds.includes(normalizedPoolId)) {
    throw new GatewayError(
      403,
      "access_policy_pool_denied",
      "Requested pool is not allowed for this access consumer.",
      {
        consumerId: accessContext?.consumerId,
        accessKeyId: accessContext?.accessKeyId,
        poolId: normalizedPoolId,
      },
    );
  }

  const poolVisibility = normalizePoolVisibility(
    poolSettings.pools?.find((pool) => pool.id === normalizedPoolId)
      ?.visibility,
  );
  if (
    accessContext?.consumerType === "lan-member" &&
    poolVisibility !== "shared-lan"
  ) {
    throw new GatewayError(
      403,
      "access_policy_pool_visibility_denied",
      "Requested pool visibility is not available for this access consumer.",
      {
        consumerId: accessContext.consumerId,
        accessKeyId: accessContext.accessKeyId,
        poolId: normalizedPoolId,
        visibility: poolVisibility,
        requiredVisibility: "shared-lan",
        phase: "phase-two",
      },
    );
  }
  if (
    accessContext?.consumerType === "public-user" &&
    poolVisibility !== "public-ready"
  ) {
    throw new GatewayError(
      403,
      "access_policy_pool_visibility_denied",
      "Requested pool visibility is not available for this access consumer.",
      {
        consumerId: accessContext.consumerId,
        accessKeyId: accessContext.accessKeyId,
        poolId: normalizedPoolId,
        visibility: poolVisibility,
        requiredVisibility: "public-ready",
        phase: "phase-three",
      },
    );
  }
  if (
    poolVisibility === "public-ready" &&
    accessContext?.consumerType !== "public-user"
  ) {
    throw new GatewayError(
      403,
      "access_policy_public_pool_requires_member_key",
      "Public-ready pools require a public-user member access key.",
      {
        consumerId: accessContext?.consumerId,
        accessKeyId: accessContext?.accessKeyId,
        consumerType: accessContext?.consumerType,
        poolId: normalizedPoolId,
        visibility: poolVisibility,
        requiredConsumerType: "public-user",
        phase: "phase-three",
      },
    );
  }
}

function resolvePolicyDefaultPoolId(
  accessContext: AccessCredentialContext | undefined,
): string | undefined {
  const allowedPoolIds = accessContext?.policy?.allowedPoolIds
    ?.map((item) => item.trim())
    .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index);
  return allowedPoolIds?.length === 1 ? allowedPoolIds[0] : undefined;
}

function getPoolVisibility(
  poolSettings: GatewaySessionPoolSettings,
  poolId: string | undefined,
): GatewayPoolVisibility | undefined {
  const normalizedPoolId = poolId?.trim();
  if (!normalizedPoolId) {
    return undefined;
  }
  return normalizePoolVisibility(
    poolSettings.pools?.find((pool) => pool.id === normalizedPoolId)
      ?.visibility,
  );
}

function buildRoutingAccessDecision(
  runtime: GatewayRuntime,
  input: GatewayRoutingPreviewInput,
  preview: GatewayRoutingPreviewResult,
): GatewayRoutingAccessDecision | undefined {
  const consumerId = normalizeAccessId(input.accessConsumerId);
  if (!consumerId) {
    return undefined;
  }

  const settings = runtime.configStore.getInferenceAuthSettings();
  const accessControl = settings.accessControl;
  const consumer = accessControl?.consumers?.find((item) => item.id === consumerId);
  if (!consumer) {
    return {
      status: "denied",
      reason: "access_consumer_not_found",
      consumerId,
      message: "Access consumer is missing.",
    };
  }

  const baseDecision = {
    consumerId: consumer.id,
    consumerName: consumer.name,
    consumerType: consumer.type,
    clientTag: consumer.clientTag,
    modelAlias: input.requestedModelAlias?.trim() || preview.resolvedModelAlias,
    poolId: preview.resolvedPoolId,
    poolVisibility: getPoolVisibility(runtime.getPoolSettings(), preview.resolvedPoolId),
  };

  if (consumer.status === "paused") {
    return {
      ...baseDecision,
      status: "denied",
      reason: "access_consumer_paused",
      errorType: "access_consumer_paused",
      message: "Access consumer is paused.",
    };
  }
  if (consumer.status === "expired") {
    return {
      ...baseDecision,
      status: "denied",
      reason: "access_consumer_expired",
      errorType: "access_consumer_expired",
      message: "Access consumer is expired.",
    };
  }

  const accessContext: AccessCredentialContext = {
    consumerId: consumer.id,
    consumerName: consumer.name,
    consumerType: consumer.type,
    consumerCreatedAt: consumer.createdAt,
    clientTag: consumer.clientTag,
    policy: accessControl?.policies?.find(
      (item) => item.consumerId === consumer.id,
    ),
  };

  try {
    assertPublicUserAllowedForPublicAccess(accessContext, settings);
  } catch (error) {
    if (error instanceof GatewayError) {
      return {
        ...baseDecision,
        status: "denied",
        reason: error.code,
        errorType: error.code,
        message: error.message,
        details: error.details,
      };
    }
    throw error;
  }

  try {
    assertAccessPolicyAllowsModel(accessContext, baseDecision.modelAlias);
    assertAccessPolicyAllowsPool(
      accessContext,
      preview.resolvedPoolId,
      runtime.getPoolSettings(),
    );
  } catch (error) {
    if (error instanceof GatewayError) {
      return {
        ...baseDecision,
        status: "denied",
        reason: error.code,
        errorType: error.code,
        message: error.message,
        details: error.details,
        poolId:
          typeof error.details?.poolId === "string"
            ? error.details.poolId
            : baseDecision.poolId,
        poolVisibility:
          typeof error.details?.visibility === "string"
            ? normalizePoolVisibility(error.details.visibility)
            : baseDecision.poolVisibility,
      };
    }
    throw error;
  }

  return {
    ...baseDecision,
    status: "allowed",
    reason: "access_policy_allowed",
  };
}

function normalizeInferenceClientMappings(
  settings: GatewayInferenceAuthSettings,
): NormalizedClientMapping[] {
  const mappings = Array.isArray(settings.clientMappings)
    ? settings.clientMappings
    : [];
  const deduped = new Map<string, NormalizedClientMapping>();
  for (const item of mappings) {
    const name = String(item?.name ?? "").trim();
    const apiKey = String(item?.apiKey ?? "").trim();
    const clientTag = String(item?.clientTag ?? "").trim().toLowerCase();
    if (!name || !apiKey || !clientTag) {
      continue;
    }
    if (deduped.has(apiKey)) {
      continue;
    }
    deduped.set(apiKey, {
      name,
      apiKey,
      clientTag,
      enabled: item?.enabled !== false,
      allowHeaderOverride: Boolean(item?.allowHeaderOverride),
    });
  }
  return [...deduped.values()];
}

function resolveAuthAndClientTag(
  runtime: GatewayRuntime,
  request: FastifyRequest,
): {
  clientTag?: string;
  authMatchedByMapping: boolean;
  matchedMappingName?: string;
  accessContext?: AccessCredentialContext;
} {
  const settings = runtime.configStore.getInferenceAuthSettings();
  const mode = settings.mode === "api-key" ? "api-key" : "none";
  const incomingKey = readClientApiKey(request);
  const accessContext = resolveAccessCredential(settings, incomingKey);
  const mappings = normalizeInferenceClientMappings(settings);
  const matchedMapping =
    incomingKey && incomingKey.length > 0
      ? mappings.find((item) => item.enabled && item.apiKey === incomingKey)
      : undefined;

  if (mode === "api-key") {
    const expectedKey = settings.apiKey?.trim();
    const hasAccessKey = Boolean(accessContext);
    const hasMappedKey = Boolean(matchedMapping);
    const hasDefaultKey = Boolean(expectedKey);
    if (!hasAccessKey && !hasMappedKey && !hasDefaultKey) {
      throw new GatewayError(
        503,
        "gateway_api_key_not_configured",
        "Gateway API key auth is enabled but key is not configured.",
      );
    }
    if (!incomingKey) {
      throw new GatewayError(
        401,
        "gateway_api_key_required",
        "Missing API key for gateway inference endpoint.",
      );
    }
    if (!hasAccessKey && !hasMappedKey && incomingKey !== expectedKey) {
      throw new GatewayError(
        403,
        "gateway_api_key_invalid",
        "Invalid API key for gateway inference endpoint.",
      );
    }
  }

  const headerClientTag = resolveHeaderClientTag(request);
  if (accessContext) {
    return {
      clientTag: accessContext.clientTag,
      authMatchedByMapping: false,
      matchedMappingName: accessContext.consumerName,
      accessContext,
    };
  }
  const resolveByApiKey = Boolean(settings.resolveClientTagByApiKey);
  if (resolveByApiKey && matchedMapping) {
    if (matchedMapping.allowHeaderOverride && headerClientTag) {
      return {
        clientTag: headerClientTag,
        authMatchedByMapping: true,
        matchedMappingName: matchedMapping.name,
      };
    }
    return {
      clientTag: matchedMapping.clientTag,
      authMatchedByMapping: true,
      matchedMappingName: matchedMapping.name,
    };
  }

  return {
    clientTag: headerClientTag ?? resolveClientTagFromUserAgent(request),
    authMatchedByMapping: Boolean(matchedMapping),
    matchedMappingName: matchedMapping?.name,
  };
}

function resolveUsageClientFilter(value: unknown): GatewayUsageClientFilter {
  if (value === "openclaw" || value === "hermes" || value === "other") {
    return value;
  }
  return "all";
}

function extractUsageCounters(
  usage: {
    input?: number;
    output?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | undefined,
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  cachedTokensPresent: boolean;
  reasoningTokensPresent: boolean;
} {
  const raw = usage as
    | ({
        input?: number;
        output?: number;
        totalTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
      } & Record<string, unknown>)
    | undefined;

  const normalize = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

  return {
    inputTokens: normalize(raw?.input),
    outputTokens: normalize(raw?.output),
    totalTokens: normalize(raw?.totalTokens),
    cachedTokens:
      normalize(raw?.cacheRead) +
      normalize(raw?.cacheWrite) +
      normalize(raw?.cachedTokens) +
      normalize(raw?.cachedInputTokens),
    reasoningTokens:
      normalize(raw?.reasoningTokens) +
      normalize(raw?.reasoningOutputTokens),
    cachedTokensPresent:
      raw !== undefined &&
      ("cacheRead" in raw ||
        "cacheWrite" in raw ||
        "cachedTokens" in raw ||
        "cachedInputTokens" in raw),
    reasoningTokensPresent:
      raw !== undefined &&
      ("reasoningTokens" in raw || "reasoningOutputTokens" in raw),
  };
}

function classifyPoolFailure(error: unknown): GatewayPoolFailureClass {
  if (error instanceof GatewayError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return "auth_invalid";
    }
    if (error.statusCode === 429) {
      return "rate_limited";
    }
  }

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
  const taggedStatus = message.match(/\[status:(\d{3})\]/);
  if (taggedStatus?.[1]) {
    const statusCode = Number.parseInt(taggedStatus[1], 10);
    if (statusCode === 401 || statusCode === 403) {
      return "auth_invalid";
    }
    if (statusCode === 429) {
      return "rate_limited";
    }
    if (statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
      return "upstream_retryable";
    }
  }
  if (
    message.includes("failed to refresh oauth token") ||
    message.includes("oauth refresh failed") ||
    message.includes("oauth 凭据刷新失败") ||
    message.includes("oauth 刷新被上游拒绝")
  ) {
    return "auth_invalid";
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

function parseRetryAfterHintSeconds(error: unknown): number | undefined {
  if (error instanceof GatewayError) {
    const value = error.details?.retryAfterSeconds;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.max(1, Math.ceil(value));
    }
  }
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  const tagged = message.match(/\[retry-after:(\d+)\]/);
  if (tagged?.[1]) {
    return Math.max(1, Number.parseInt(tagged[1], 10));
  }
  const inline = message.match(/retry[- ]?after[:=]?\s*(\d+)\s*s?/);
  if (inline?.[1]) {
    return Math.max(1, Number.parseInt(inline[1], 10));
  }
  return undefined;
}

function parseQuotaResetAtHint(error: unknown): number | undefined {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  const unixSeconds = message.match(/\breset(?:[_\s-]*at)?[:=]?\s*(\d{10})\b/);
  if (unixSeconds?.[1]) {
    return Number.parseInt(unixSeconds[1], 10) * 1000;
  }
  const unixMs = message.match(/\breset(?:[_\s-]*at)?[:=]?\s*(\d{13})\b/);
  if (unixMs?.[1]) {
    return Number.parseInt(unixMs[1], 10);
  }
  return undefined;
}

function isRetryablePoolFailureClass(failureClass: GatewayPoolFailureClass): boolean {
  return failureClass !== "non_retryable";
}

function shouldPersistPoolFailureCooldown(
  pool: GatewaySessionPoolDefinition | undefined,
  failureClass: GatewayPoolFailureClass,
): boolean {
  if (pool?.selectionStrategy !== "single-drain") {
    return true;
  }
  // single-drain is a sticky drain strategy: retryable failures and quota
  // exhaustion should move the drain anchor forward, not freeze healthy pools.
  return failureClass === "auth_invalid";
}

function findSessionPoolDefinition(
  runtime: GatewayRuntime,
  poolId: string | undefined,
): GatewaySessionPoolDefinition | undefined {
  const normalizedPoolId = poolId?.trim();
  if (!normalizedPoolId) {
    return undefined;
  }
  return runtime.configStore
    .getPoolSettings()
    .pools?.find((pool) => pool.id === normalizedPoolId);
}

function isRetryableFixedSessionError(error: unknown): boolean {
  return isRetryablePoolFailureClass(classifyPoolFailure(error));
}

function isRetryableFinalMessageError(message: string | undefined): boolean {
  return isRetryablePoolFailureClass(classifyPoolFailure(message));
}

function buildUpstreamGatewayError(
  message: string | undefined,
  retryAfterSeconds?: number,
): GatewayError {
  const normalizedMessage = message ?? "Codex request failed.";
  const failureClass = classifyPoolFailure(normalizedMessage);
  if (failureClass === "quota_exhausted") {
    return new GatewayError(
      429,
      "upstream_quota_exhausted",
      normalizedMessage,
      retryAfterSeconds ? { retryAfterSeconds } : undefined,
    );
  }
  if (failureClass === "rate_limited") {
    return new GatewayError(
      429,
      "upstream_rate_limited",
      normalizedMessage,
      retryAfterSeconds ? { retryAfterSeconds } : undefined,
    );
  }
  return new GatewayError(
    502,
    "upstream_error",
    normalizedMessage,
    retryAfterSeconds ? { retryAfterSeconds } : undefined,
  );
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

function buildForwardedInferenceHeaders(
  request: FastifyRequest,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  for (const key of [
    "authorization",
    "x-api-key",
    "user-agent",
    "x-local-ai-client-tag",
    "x-client-tag",
    "x-source-app",
  ]) {
    const value = getFirstHeaderValue(request, key);
    if (value) {
      headers[key] = value;
    }
  }
  return headers;
}

function parseInjectedJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new GatewayError(
      502,
      "invalid_gateway_response",
      "Gateway compatibility adapter returned invalid JSON.",
    );
  }
}

function extractServiceTestResultText(payload: unknown): string {
  const choice = (payload as {
    choices?: Array<{ message?: { content?: unknown } }>;
  })?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        typeof item?.text === "string" ? item.text : "",
      )
      .join("")
      .trim();
  }
  return "";
}

function selectServiceTestModel(models: GatewayModelDefinition[]): GatewayModelDefinition {
  const defaultModel = models[0];
  return (
    models.find((model) => model.alias === "codex-5.5") ??
    models.find((model) => model.providerModelId === "gpt-5.5") ??
    defaultModel
  );
}

async function runGatewayServiceTest(
  app: FastifyInstance,
  runtime: GatewayRuntime,
) {
  const startedAt = Date.now();
  const model = selectServiceTestModel(runtime.modelRegistry.list());
  const authSettings = runtime.configStore.getInferenceAuthSettings();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-client-tag": "desktop-service-test",
    "user-agent": "RelayGate-Service-Test/1.0",
  };
  if (authSettings.mode === "api-key" && authSettings.apiKey?.trim()) {
    headers.authorization = `Bearer ${authSettings.apiKey.trim()}`;
  }

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
    payload: {
      model: model.alias,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 16,
      stream: false,
    },
  });
  const latencyMs = Date.now() - startedAt;
  const body = response.body ? parseInjectedJsonBody(response.body) : {};

  if (response.statusCode >= 400) {
    const error = (body as {
      error?: { type?: string; message?: string; details?: unknown };
    }).error;
    return {
      ok: true,
      data: {
        success: false,
        stage:
          error?.type === "gateway_api_key_required" ||
          error?.type === "gateway_api_key_invalid" ||
          error?.type === "gateway_api_key_not_configured"
            ? "auth"
            : "upstream",
        resultText: "",
        modelAlias: model.alias,
        providerId: model.provider,
        statusCode: response.statusCode,
        latencyMs,
        serviceReachable: true,
        upstreamReachable: false,
        errorType: error?.type ?? "service_test_failed",
        message: error?.message ?? `Service test failed with ${response.statusCode}.`,
        details: error?.details,
      },
    };
  }

  return {
    ok: true,
    data: {
      success: true,
      stage: "upstream",
      resultText: extractServiceTestResultText(body),
      modelAlias: model.alias,
      providerId: model.provider,
      statusCode: response.statusCode,
      latencyMs,
      serviceReachable: true,
      upstreamReachable: true,
    },
  };
}

function forwardInjectedError(
  reply: FastifyReply,
  statusCode: number,
  body: string,
) {
  reply.status(statusCode);
  try {
    const parsed = JSON.parse(body);
    const retryAfterSeconds = parsed?.error?.details?.retryAfterSeconds;
    if (
      typeof retryAfterSeconds === "number" &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds > 0
    ) {
      reply.header("Retry-After", String(Math.ceil(retryAfterSeconds)));
    }
    return parsed;
  } catch {
    return {
      error: {
        type: "gateway_compat_error",
        message: body || `Gateway compatibility request failed with ${statusCode}.`,
      },
    };
  }
}

export function createGatewayApp(runtime: GatewayRuntime): FastifyInstance {
  const app = Fastify({
    logger: false,
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    recordAccessAlertForError(runtime, normalized, request);
    if (
      normalized instanceof GatewayError &&
      normalized.code === "client_temporarily_blocked"
    ) {
      runtime.logger.warn("request_client_circuit_blocked", {
        ...buildRequestAuditContext(request),
        ...buildErrorLogDetails(normalized),
      });
    } else if (
      normalized instanceof GatewayError &&
      normalized.code === "service_restart_inference_active"
    ) {
      runtime.logger.warn("service_restart_deferred", {
        ...buildRequestAuditContext(request),
        ...buildErrorLogDetails(normalized),
      });
    } else {
      runtime.logger.error("request_failed", {
        ...buildRequestAuditContext(request),
        ...buildErrorLogDetails(normalized),
      });
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

  app.get("/__relaygate/livez", async () => ({ ok: true }));

  app.get("/healthz", async () => runtime.getHealth());

  app.get("/v1/models", async (request) => {
    requireInferenceNetworkAccess(runtime, request);
    const authContext = resolveAuthAndClientTag(runtime, request);
    assertAccessPolicyNotExpired(authContext.accessContext);
    return buildModelsResponse(runtime.modelRegistry.list());
  });

  app.get("/v1/models/:model", async (request) => {
    requireInferenceNetworkAccess(runtime, request);
    const authContext = resolveAuthAndClientTag(runtime, request);
    assertAccessPolicyNotExpired(authContext.accessContext);
    const requestedModel =
      (request.params as { model?: string } | undefined)?.model ?? "";
    const resolvedModelAlias = resolveCompatibleModelAlias(runtime, requestedModel);
    assertAccessPolicyAllowsModel(
      authContext.accessContext,
      resolvedModelAlias,
      requestedModel,
    );
    const model = runtime.modelRegistry
      .list()
      .find((item) => item.alias === resolvedModelAlias);
    if (!model) {
      throw new GatewayError(
        404,
        "model_not_found",
        `Unknown model: ${requestedModel}`,
      );
    }
    return buildGatewayModelResponse(model);
  });

  const getUserBalance = async (request: FastifyRequest) => {
    requireInferenceNetworkAccess(runtime, request);
    const authContext = resolveAuthAndClientTag(runtime, request);
    return buildUserBalanceResponse(runtime, authContext);
  };
  app.get("/user/balance", getUserBalance);
  app.get("/v1/user/balance", getUserBalance);

  app.get("/v1/account", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return buildPublicAccountPortalHtmlV4();
  });

  app.get("/v1/user/profile", async (request) => {
    const authContext = requireUserSelfServiceAuth(runtime, request);
    return buildUserProfileResponse(runtime, authContext);
  });

  app.get("/v1/user/usage/summary", async (request) => {
    const authContext = requireUserSelfServiceAuth(runtime, request);
    return buildUserUsageSummaryResponse(runtime, authContext, request.query);
  });

  const getCodexWhamUsage = async (request: FastifyRequest) => {
    requireInferenceNetworkAccess(runtime, request);
    const authContext = resolveAuthAndClientTag(runtime, request);
    return buildCodexWhamUsageResponse(
      buildUserBalanceResponse(runtime, authContext),
    );
  };
  app.get("/backend-api/wham/usage", getCodexWhamUsage);
  app.get("/v1/backend-api/wham/usage", getCodexWhamUsage);

  const getCreditGrants = async (request: FastifyRequest) => {
    requireInferenceNetworkAccess(runtime, request);
    const authContext = resolveAuthAndClientTag(runtime, request);
    return buildCreditGrantsResponse(buildUserBalanceResponse(runtime, authContext));
  };
  app.get("/dashboard/billing/credit_grants", getCreditGrants);
  app.get("/v1/dashboard/billing/credit_grants", getCreditGrants);

  app.post("/v1/responses", async (request, reply) => {
    requireInferenceNetworkAccess(runtime, request);
    const authContext = resolveAuthAndClientTag(runtime, request);
    const parsed = parseResponsesApiRequest(request.body);
    const chatPayload = toChatCompletionsRequestFromResponsesApi(parsed);
    assertPublicRequestPayloadWithinLimits(
      authContext.accessContext,
      chatPayload,
      request.body,
    );

    const injected = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: buildForwardedInferenceHeaders(request),
      payload: chatPayload,
    });

    if (injected.statusCode >= 400) {
      return forwardInjectedError(reply, injected.statusCode, injected.body);
    }

    if (parsed.stream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      reply.raw.end(
        chatCompletionSseToResponsesApiSse(injected.body, chatPayload.model),
      );
      return reply;
    }

    return buildResponsesApiResponseFromChatCompletion(
      parseInjectedJsonBody(injected.body),
    );
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    requireInferenceNetworkAccess(runtime, request);
    const authContext = resolveAuthAndClientTag(runtime, request);
    if (authContext.accessContext) {
      requestAccessContexts.set(request, authContext.accessContext);
    }
    const startedAt = Date.now();
    const currentSessionId = runtime.getActiveSessionId();
    const clientTag = authContext.clientTag;
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
    const requestedModelAlias = parsed.model;
    const normalizedModelAlias = resolveCompatibleModelAlias(
      runtime,
      requestedModelAlias,
    );
    const requestAuditSourceEventKey = `live-request:${randomUUID()}`;
    requestAuditSourceEventKeys.set(request, requestAuditSourceEventKey);
    recordAccessMemberOnlineAlerts(runtime, authContext.accessContext, startedAt);
    maybeRecordRequestContentAudit({
      runtime,
      sourceEventKey: requestAuditSourceEventKey,
      request: parsed,
      consumerId: authContext.accessContext?.consumerId,
      accessKeyId: authContext.accessContext?.accessKeyId,
    });
    assertPublicRequestPayloadWithinLimits(
      authContext.accessContext,
      parsed,
      request.body,
    );
    assertAccessPolicyNotExpired(authContext.accessContext);
    assertAccessPolicyAllowsModel(
      authContext.accessContext,
      normalizedModelAlias,
      requestedModelAlias,
    );
    assertAccessPolicyTokenLimits(authContext.accessContext, parsed);
    assertAccessPolicyWithinDailyQuota(runtime, authContext.accessContext);
    assertAccessPolicyWithinPeriodQuota(runtime, authContext.accessContext);
    assertAccessPolicyWithinTotalQuota(runtime, authContext.accessContext);
    assertAccessPolicyWithinRequestLimits(runtime, authContext.accessContext);
    const routingPreview = runtime.previewRouting({
      clientTag,
      accessConsumerId: authContext.accessContext?.consumerId,
      requestedModelAlias: normalizedModelAlias,
      currentModelAlias: normalizedModelAlias,
      currentSessionId,
    });

    let resolvedModelAlias = normalizedModelAlias;
    let resolvedSessionId = currentSessionId;
    const routingWarnings = [...routingPreview.warnings];
    const matchedRule =
      routingPreview.enabled && routingPreview.reason === "rule_matched"
        ? runtime
            .getRoutingSettings()
            .rules?.find((rule) => rule.id === routingPreview.matchedRuleId)
        : undefined;
    const policyDefaultPoolId =
      routingPreview.reason === "rule_matched"
        ? undefined
        : resolvePolicyDefaultPoolId(authContext.accessContext);
    const dispatchMode = policyDefaultPoolId
      ? "dynamic-pool"
      : runtime.getEffectiveDispatchMode(matchedRule?.target);
    const targetPoolId = matchedRule?.target?.poolId?.trim() ?? policyDefaultPoolId;
    assertAccessPolicyAllowsPool(
      authContext.accessContext,
      targetPoolId,
      runtime.getPoolSettings(),
    );
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
        ((routingPreview.reason === "rule_matched" &&
          routingPreview.resolvedPoolId === targetPoolId &&
          routingPreview.selectionReason &&
          routingPreview.selectionReason !== "fallback-to-active-session") ||
          Boolean(policyDefaultPoolId)),
    );

    if (routingPreview.enabled && routingPreview.reason === "rule_matched") {
      const routedModel = runtime.getProviderAdapterForModel(routingPreview.resolvedModelAlias);
      if (routedModel) {
        resolvedModelAlias = routingPreview.resolvedModelAlias;
      } else {
        runtime.logger.error("routing_model_fallback", {
          requestedModel: requestedModelAlias,
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

    if (policyDefaultPoolId) {
      const selection = runtime.selectSessionFromPool({
        poolId: policyDefaultPoolId,
        currentSessionId,
        consumerType: authContext.accessContext?.consumerType,
      });
      routingWarnings.push(...selection.warnings);
      routingWarnings.push(...selection.rejectedCandidates.map((item) => item.reason));
      if (!selection.selectedSessionId) {
        throw new GatewayError(
          503,
          "pool_no_available_session",
          `号池 ${selection.poolName} 当前没有可用账号。`,
          {
            poolId: policyDefaultPoolId,
            candidateCount: selection.candidateCount,
            rejectedCandidates: selection.rejectedCandidates,
          },
        );
      }
      resolvedSessionId = selection.selectedSessionId;
      selectedByPoolMember =
        selection.selectionReason !== "fallback-to-active-session";
      routingWarnings.push(
        `已按成员策略自动路由到号池 ${selection.poolName}。`,
      );
    }

    let usedSessionId = resolvedSessionId;
    let hasRecordedResult = false;
    const resolved = runtime.getProviderAdapterForModel(resolvedModelAlias);
    if (!resolved) {
      throw new GatewayError(400, "model_not_found", "Requested model alias is not configured.");
    }
    runtime.assertSessionSafetyAllowsRequest({
      sessionId: resolvedSessionId,
      consumerType: authContext.accessContext?.consumerType,
      consumerId: authContext.accessContext?.consumerId,
      accessKeyId: authContext.accessContext?.accessKeyId,
    });
    const inferenceRequestId = runtime.beginInferenceActivity({
      clientTag,
      consumerId: authContext.accessContext?.consumerId,
      accessKeyId: authContext.accessContext?.accessKeyId,
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
      const modelApplied = resolvedModelAlias !== normalizedModelAlias;
      const sessionApplied = Boolean(
        finalSessionId && finalSessionId !== currentSessionId,
      );
      runtime.recordRoutingHit({
        timestamp: Date.now(),
        clientTag,
        requestedModelAlias,
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
        requestedModel: requestedModelAlias,
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
      failureSource?: unknown,
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
      const pool = findSessionPoolDefinition(runtime, targetPoolId);
      if (
        failedSessionId &&
        selectedByPoolMember &&
        shouldPersistPoolFailureCooldown(pool, failureClass)
      ) {
        const retryAfterSeconds = parseRetryAfterHintSeconds(failureSource);
        runtime.recordPoolSelectionFailure({
          poolId: targetPoolId,
          sessionId: failedSessionId,
          failureClass,
          resetAt:
            parseQuotaResetAtHint(failureSource) ?? failedSession?.quota?.resetAt,
          retryAfterSeconds,
        });
      }

      const nextSelection = runtime.selectSessionFromPool({
        poolId: targetPoolId,
        currentSessionId,
        attemptedSessionIds,
        consumerType: authContext.accessContext?.consumerType,
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
          requestedModelAlias,
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
        requestedModelAlias,
        selectedSessionId: sessionId,
        reason: routingPreview.selectionReason,
      });
      poolSelectionEventRecorded = true;
    };

    const recordUsageTelemetry = (input: {
      ok: boolean;
      stream: boolean;
      sessionId?: string;
      accountId?: string;
      email?: string;
      usage?: {
        input?: number;
        output?: number;
        totalTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
      happenedAt?: number;
    }) => {
      runtime.recordUsageEvent({
        timestamp: input.happenedAt ?? Date.now(),
        sessionId: input.sessionId,
        accountId: input.accountId,
        email: input.email,
        clientTag,
        consumerId: authContext.accessContext?.consumerId,
        accessKeyId: authContext.accessContext?.accessKeyId,
        poolId: targetPoolId && selectedByPoolMember ? targetPoolId : undefined,
        providerId: resolved.adapter.id,
        modelAlias: resolvedModelAlias,
        upstreamModelId: resolved.model.providerModelId,
        success: input.ok,
        stream: input.stream,
        latencyMs: Date.now() - startedAt,
        sourceKind: "live-request",
        sourceEventKey: requestAuditSourceEventKey,
        ...extractUsageCounters(input.usage),
      });
      recordAccessThresholdAlerts(runtime, authContext.accessContext);
    };

    let usedResolvedSession:
      | {
          accountId?: string;
          email?: string;
        }
      | undefined;

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
          error,
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
        runtime.assertSessionSafetyAllowsRequest({
          sessionId: resolvedSessionId,
          consumerType: authContext.accessContext?.consumerType,
          consumerId: authContext.accessContext?.consumerId,
          accessKeyId: authContext.accessContext?.accessKeyId,
        });
        runtime.updateInferenceActivity(inferenceRequestId, {
          sessionId: resolvedSessionId,
          poolId: targetPoolId,
        });
        result = await createAttempt(resolvedSessionId);
      }
      usedSessionId = result.session.id;
      usedResolvedSession = result.session;
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
              error,
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
            runtime.assertSessionSafetyAllowsRequest({
              sessionId: resolvedSessionId,
              consumerType: authContext.accessContext?.consumerType,
              consumerId: authContext.accessContext?.consumerId,
              accessKeyId: authContext.accessContext?.accessKeyId,
            });
            runtime.updateInferenceActivity(inferenceRequestId, {
              sessionId: resolvedSessionId,
              poolId: targetPoolId,
            });
            streamingResult = await createAttempt(fallbackSessionId);
            streamingSessionId = streamingResult.session.id;
            usedSessionId = streamingSessionId;
            usedResolvedSession = streamingResult.session;
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
          const finalStreamingMessage = await streamingResult.stream.result();
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
            recordUsageTelemetry({
              ok: true,
              stream: true,
              sessionId: streamingSessionId,
              accountId: usedResolvedSession?.accountId,
              email: usedResolvedSession?.email,
              usage: finalStreamingMessage.usage,
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
          finalMessage.errorMessage,
        );
        const fallbackSessionId =
          poolFallbackSessionId ??
          selectFallbackSessionId(usedSessionId);
        if (fallbackSessionId) {
          resolvedSessionId = fallbackSessionId;
          runtime.assertSessionSafetyAllowsRequest({
            sessionId: resolvedSessionId,
            consumerType: authContext.accessContext?.consumerType,
            consumerId: authContext.accessContext?.consumerId,
            accessKeyId: authContext.accessContext?.accessKeyId,
          });
          runtime.updateInferenceActivity(inferenceRequestId, {
            sessionId: resolvedSessionId,
            poolId: targetPoolId,
          });
          const retryResult = await createAttempt(fallbackSessionId);
          usedSessionId = retryResult.session.id;
          usedResolvedSession = retryResult.session;
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
          recordUsageTelemetry({
            ok: false,
            stream: false,
            sessionId: usedSessionId,
            accountId: usedResolvedSession?.accountId,
            email: usedResolvedSession?.email,
            usage: finalMessage.usage,
          });
          hasRecordedResult = true;
        }
        throw buildUpstreamGatewayError(finalMessage.errorMessage);
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
        recordUsageTelemetry({
          ok: true,
          stream: false,
          sessionId: usedSessionId,
          accountId: usedResolvedSession?.accountId,
          email: usedResolvedSession?.email,
          usage: finalMessage.usage,
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
        const pool = findSessionPoolDefinition(runtime, targetPoolId);
        if (
          targetPoolId &&
          selectedByPoolMember &&
          shouldPersistPoolFailureCooldown(pool, failureClass)
        ) {
          const failedSession = runtime
            .listSessions()
            .find((session) => session.id === usedSessionId);
          runtime.recordPoolSelectionFailure({
            poolId: targetPoolId,
            sessionId: usedSessionId,
            failureClass,
            resetAt: parseQuotaResetAtHint(error) ?? failedSession?.quota?.resetAt,
            retryAfterSeconds: parseRetryAfterHintSeconds(error),
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
        recordUsageTelemetry({
          ok: false,
          stream: Boolean(parsed.stream),
          sessionId: usedSessionId,
          accountId: usedResolvedSession?.accountId,
          email: usedResolvedSession?.email,
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
        throw buildUpstreamGatewayError(String(error), retryAfterSeconds);
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

  app.post("/admin/service/test", async (request) => {
    requireAdminAuth(runtime, request);
    return runGatewayServiceTest(app, runtime);
  });

  app.get("/admin/usage/summary", async (request) => {
    requireAdminAuth(runtime, request);
    const clientFilter = resolveUsageClientFilter(
      (request.query as { clientFilter?: string } | undefined)?.clientFilter,
    );
    return {
      ok: true,
      data: runtime.getUsageObservability(clientFilter),
    };
  });

  app.get("/admin/usage/analytics", async (request) => {
    requireAdminAuth(runtime, request);
    const query = request.query as
      | {
          range?: string;
          granularity?: string;
          clientFilter?: string;
          consumerId?: string;
          accessKeyId?: string;
          modelAlias?: string;
          poolId?: string;
          outcome?: string;
        }
      | undefined;
    const range =
      query?.range === "7d" || query?.range === "30d" || query?.range === "all"
        ? query.range
        : "24h";
    const granularity = query?.granularity === "day" ? "day" : "hour";
    const outcome =
      query?.outcome === "success" || query?.outcome === "failure"
        ? query.outcome
        : undefined;
    return {
      ok: true,
      data: runtime.getUsageAnalytics({
        range,
        granularity,
        filters: {
          clientFilter: resolveUsageClientFilter(query?.clientFilter),
          consumerId: query?.consumerId,
          accessKeyId: query?.accessKeyId,
          modelAlias: query?.modelAlias,
          poolId: query?.poolId,
          outcome,
        },
      }),
    };
  });

  app.get("/admin/routing/account-health", async (request) => {
    requireAdminAuth(runtime, request);
    return {
      ok: true,
      data: runtime.getAccountHealthObservability(),
    };
  });

  app.get("/admin/requests/audit", async (request) => {
    requireAdminAuth(runtime, request);
    const query = request.query as
      | {
          limit?: string;
          status?: string;
          clientTag?: string;
          consumerId?: string;
          accessKeyId?: string;
          poolId?: string;
          accountId?: string;
          modelAlias?: string;
          providerId?: string;
          since?: string;
          until?: string;
        }
      | undefined;
    const parsedLimit =
      typeof query?.limit === "string" ? Number.parseInt(query.limit, 10) : undefined;
    const parseTimestamp = (value: string | undefined) => {
      if (!value) {
        return undefined;
      }
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const status =
      query?.status === "success" || query?.status === "failure"
        ? query.status
        : "all";
    return {
      ok: true,
      data: runtime.database.queryRequestAuditEvents({
        limit: parsedLimit,
        status,
        clientTag: normalizeOptionalTrimmedString(query?.clientTag),
        consumerId: normalizeOptionalTrimmedString(query?.consumerId),
        accessKeyId: normalizeOptionalTrimmedString(query?.accessKeyId),
        poolId: normalizeOptionalTrimmedString(query?.poolId),
        accountId: normalizeOptionalTrimmedString(query?.accountId),
        modelAlias: normalizeOptionalTrimmedString(query?.modelAlias),
        providerId: normalizeOptionalTrimmedString(query?.providerId),
        since: parseTimestamp(query?.since),
        until: parseTimestamp(query?.until),
      }),
    };
  });

  app.get("/admin/requests/audit/content", async (request) => {
    requireAdminAuth(runtime, request);
    const sourceEventKey = normalizeOptionalTrimmedString(
      (request.query as { sourceEventKey?: string } | undefined)?.sourceEventKey,
    );
    if (!sourceEventKey) {
      throw new GatewayError(
        400,
        "request_audit_content_key_required",
        "sourceEventKey is required.",
      );
    }
    const content = runtime.database.getRequestContentAuditEvent(sourceEventKey);
    if (!content) {
      throw new GatewayError(
        404,
        "request_audit_content_not_found",
        "Request content audit entry was not found.",
      );
    }
    return {
      ok: true,
      data: content,
    };
  });

  app.get("/admin/access/alerts", async (request) => {
    requireAdminAuth(runtime, request);
    const rawLimit = (request.query as { limit?: string } | undefined)?.limit;
    const parsedLimit =
      typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : undefined;
    const limit =
      typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
        ? parsedLimit
        : 50;
    return {
      ok: true,
      data: {
        events: runtime.database.getRecentAccessAlertEvents(limit),
      },
    };
  });

  app.post("/admin/access/alerts/acknowledge-all", async (request) => {
    requireAdminAuth(runtime, request);
    const body = request.body as { acknowledgedBy?: unknown } | undefined;
    const acknowledgedBy =
      typeof body?.acknowledgedBy === "string"
        ? body.acknowledgedBy.trim()
        : undefined;
    return {
      ok: true,
      data: runtime.database.acknowledgeAllAccessAlertEvents({
        acknowledgedBy: acknowledgedBy || "admin",
      }),
    };
  });

  app.post("/admin/access/alerts/clear-acknowledged", async (request) => {
    requireAdminAuth(runtime, request);
    return {
      ok: true,
      data: runtime.database.deleteAcknowledgedAccessAlertEvents(),
    };
  });

  app.post("/admin/access/alerts/:id/acknowledge", async (request) => {
    requireAdminAuth(runtime, request);
    const rawId = (request.params as { id?: string } | undefined)?.id;
    const id = typeof rawId === "string" ? Number.parseInt(rawId, 10) : NaN;
    if (!Number.isInteger(id) || id <= 0) {
      throw new GatewayError(
        400,
        "access_alert_invalid_id",
        "Access alert id is invalid.",
      );
    }

    const body = request.body as { acknowledgedBy?: unknown } | undefined;
    const acknowledgedBy =
      typeof body?.acknowledgedBy === "string"
        ? body.acknowledgedBy.trim()
        : undefined;
    const event = runtime.database.acknowledgeAccessAlertEvent(id, {
      acknowledgedBy: acknowledgedBy || "admin",
    });
    if (!event) {
      throw new GatewayError(
        404,
        "access_alert_not_found",
        "Access alert event was not found.",
      );
    }

    return {
      ok: true,
      data: event,
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
    const preview = runtime.previewRouting(body);
    return {
      ok: true,
      data: {
        ...preview,
        accessDecision: buildRoutingAccessDecision(runtime, body, preview),
      },
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
    const normalized = normalizePoolSettingsForSave(body);
    const saved = runtime.configStore.setPoolSettings(normalized);
    runtime.logger.info("pool_settings_saved", {
      enabled: Boolean(normalized.enabled),
      poolCount: normalized.pools?.length ?? 0,
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
    const resolveClientTagByApiKey = Boolean(body.resolveClientTagByApiKey);
    const lanAccessEnabled =
      body.lanAccess?.enabled ?? previous.lanAccess?.enabled ?? false;
    const normalizedPublicAccess = normalizePublicAccessSettingsForSave(
      body.publicAccess,
      previous.publicAccess,
    );
    const publicAccessEnabled = Boolean(normalizedPublicAccess.enabled);

    const previousMappings = normalizeInferenceClientMappings(previous);
    const previousApiKeyByIdentity = new Map<string, string>();
    for (const item of previousMappings) {
      previousApiKeyByIdentity.set(`${item.name}::${item.clientTag}`, item.apiKey);
    }
    const bodyMappings = Array.isArray(body.clientMappings)
      ? body.clientMappings
      : [];
    const mergedMappings = bodyMappings.map((item) => {
      const name = String(item?.name ?? "").trim();
      const clientTag = String(item?.clientTag ?? "").trim().toLowerCase();
      const providedKey = String(item?.apiKey ?? "").trim();
      const fallbackKey = previousApiKeyByIdentity.get(`${name}::${clientTag}`) ?? "";
      return {
        ...item,
        name,
        clientTag,
        apiKey: providedKey || fallbackKey,
      };
    });
    const duplicatedMappingKey = (() => {
      const seen = new Set<string>();
      for (const item of mergedMappings) {
        const apiKey = String(item?.apiKey ?? "").trim();
        if (!apiKey) {
          continue;
        }
        if (seen.has(apiKey)) {
          return apiKey;
        }
        seen.add(apiKey);
      }
      return undefined;
    })();
    if (duplicatedMappingKey) {
      throw new GatewayError(
        400,
        "invalid_request",
        "客户端密钥映射中存在重复 API Key。请确保每个客户端使用独立密钥。",
      );
    }
    const normalizedMappings = normalizeInferenceClientMappings({
      clientMappings: mergedMappings,
    });
    const normalizedAccessControl = normalizeAccessControlSettingsForSave(
      (body as GatewayInferenceAuthSettings & { accessControl?: AccessControlInput })
        .accessControl,
      previous.accessControl,
    );
    const hasAccessKey =
      normalizedAccessControl?.keys?.some((item) => item.status === "enabled") ??
      false;

    if (
      mode === "api-key" &&
      !nextApiKey &&
      normalizedMappings.length === 0 &&
      !hasAccessKey
    ) {
      throw new GatewayError(
        400,
        "invalid_request",
        "启用 API Key 鉴权时必须提供默认 API Key，或至少配置一个客户端密钥映射 / 访问者密钥。",
      );
    }
    if (
      lanAccessEnabled &&
      (mode !== "api-key" ||
        (!nextApiKey && normalizedMappings.length === 0 && !hasAccessKey))
    ) {
      throw new GatewayError(
        400,
        "lan_api_key_required",
        "启用局域网共享前必须启用 API Key 鉴权，并配置默认 API Key、客户端密钥映射或访问者密钥。",
      );
    }
    if (
      publicAccessEnabled &&
      (mode !== "api-key" ||
        (!nextApiKey && normalizedMappings.length === 0 && !hasAccessKey))
    ) {
      throw new GatewayError(
        400,
        "public_api_key_required",
        "启用公网共享前必须启用 API Key 鉴权，并配置默认 API Key、客户端密钥映射或访问者密钥。",
      );
    }
    if (
      publicAccessEnabled &&
      !normalizedPublicAccess.publicBaseUrl?.startsWith("https://")
    ) {
      throw new GatewayError(
        400,
        "public_https_required",
        "启用公网共享前必须配置 HTTPS Public Base URL。",
      );
    }

    runtime.configStore.setInferenceAuthSettings({
      mode,
      apiKey: nextApiKey || undefined,
      resolveClientTagByApiKey,
      clientMappings: normalizedMappings,
      lanAccess: {
        enabled: lanAccessEnabled,
      },
      publicAccess: normalizedPublicAccess,
      accessControl: normalizedAccessControl,
    });
    runtime.logger.info("inference_auth_settings_saved", {
      mode,
      hasApiKey: Boolean(nextApiKey),
      resolveClientTagByApiKey,
      clientMappingCount: normalizedMappings.length,
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
    const body = (request.body ?? {}) as { force?: unknown };
    const query = (request.query ?? {}) as { force?: unknown };
    const force =
      body.force === true ||
      body.force === "true" ||
      query.force === true ||
      query.force === "true";
    const inference = runtime.getHealth().inferenceObservability;
    const inFlightCount = inference?.inFlightCount ?? 0;
    if (!force && inFlightCount > 0) {
      throw new GatewayError(
        409,
        "service_restart_inference_active",
        "Gateway restart was deferred because inference requests are still active.",
        {
          inFlightCount,
          currentClientTag: inference?.currentClientTag,
          currentModelAlias: inference?.currentModelAlias,
          currentSessionId: inference?.currentSessionId,
          currentPoolId: inference?.currentPoolId,
          lastStartedAt: inference?.lastStartedAt,
          retryAfterSeconds: SERVICE_RESTART_ACTIVE_RETRY_AFTER_SECONDS,
        },
      );
    }
    reply.send({
      ok: true,
      restarting: true,
      forced: force || undefined,
    });
    setTimeout(() => {
      process.exit(75);
    }, 75);
    return reply;
  });

  return app;
}
