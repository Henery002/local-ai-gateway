import { createHash } from "node:crypto";
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
  GatewayAccessControlSettings,
  GatewayAccessConsumer,
  GatewayAccessKey,
  GatewayAccessPolicy,
  GatewayInferenceAuthSettings,
  GatewayPoolFailureClass,
  GatewayProviderSettings,
  GatewayPoolVisibility,
  GatewayRoutingPreviewInput,
  GatewayRoutingSettings,
  GatewaySessionPoolSettings,
  GatewayUsageClientFilter,
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
  if (settings.mode !== "api-key" || (!hasDefaultKey && !hasMappingKey)) {
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

type AccessCredentialContext = {
  consumerId: string;
  consumerName: string;
  accessKeyId: string;
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

  return {
    consumerId: consumer.id,
    consumerName: consumer.name,
    accessKeyId: accessKey.id,
    clientTag: consumer.clientTag,
    policy: accessControl?.policies?.find(
      (item) => item.consumerId === consumer.id,
    ),
  };
}

function assertAccessPolicyAllowsModel(
  accessContext: AccessCredentialContext | undefined,
  requestedModelAlias: string,
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
    );
  }
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

function assertAccessPolicyAllowsPool(
  accessContext: AccessCredentialContext | undefined,
  poolId: string | undefined,
): void {
  const normalizedPoolId = poolId?.trim();
  if (!normalizedPoolId) {
    return;
  }

  const allowedPoolIds = accessContext?.policy?.allowedPoolIds;
  if (!allowedPoolIds?.length) {
    return;
  }
  if (allowedPoolIds.includes(normalizedPoolId)) {
    return;
  }

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
    requireInferenceNetworkAccess(runtime, request);
    resolveAuthAndClientTag(runtime, request);
    return buildModelsResponse(runtime.modelRegistry.list());
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
    assertAccessPolicyAllowsModel(authContext.accessContext, parsed.model);
    assertAccessPolicyWithinDailyQuota(runtime, authContext.accessContext);
    assertAccessPolicyWithinRequestLimits(runtime, authContext.accessContext);
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
    assertAccessPolicyAllowsPool(authContext.accessContext, targetPoolId);
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
        providerId: resolved.adapter.id,
        modelAlias: resolvedModelAlias,
        upstreamModelId: resolved.model.providerModelId,
        success: input.ok,
        stream: input.stream,
        latencyMs: Date.now() - startedAt,
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

    runtime.configStore.setInferenceAuthSettings({
      mode,
      apiKey: nextApiKey || undefined,
      resolveClientTagByApiKey,
      clientMappings: normalizedMappings,
      lanAccess: {
        enabled: lanAccessEnabled,
      },
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
