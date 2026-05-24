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
  GatewaySessionPoolSettings,
  GatewayUsageCounters,
  GatewayUsageClientFilter,
  GatewayRequestContentAuditSettings,
  getCodexAliasForUpstreamModel,
  SessionSummary,
} from "@local-ai-gateway/shared";

import { GatewayRuntime } from "./runtime.js";

const requestAuditSourceEventKeys = new WeakMap<FastifyRequest, string>();

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
  return {
    requestPath: request.url.split("?")[0],
    requestMethod: request.method,
    ...(typeof body?.model === "string" ? { modelAlias: body.model } : {}),
    ...(typeof body?.stream === "boolean" ? { stream: body.stream } : {}),
    ...(clientTag ? { clientTag } : {}),
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
      error.code.startsWith("session_safety_"))
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

function normalizePoolSettingsForSave(
  input: GatewaySessionPoolSettings,
): GatewaySessionPoolSettings {
  return {
    ...input,
    pools: (input.pools ?? []).map((pool) => ({
      ...pool,
      visibility: normalizePoolVisibility(pool.visibility),
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
        ...buildErrorLogDetails(normalized),
      });
    } else {
      runtime.logger.error("request_failed", buildErrorLogDetails(normalized));
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
      if (failedSessionId && selectedByPoolMember) {
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
        if (targetPoolId && selectedByPoolMember) {
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
